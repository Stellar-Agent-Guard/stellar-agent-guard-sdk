/**
 * Unit tests for the LangChain middleware adapter and block message assembly.
 *
 * Threat Model & Security Posture (Anti-Prompt-Injection & No-Evasion Guidance):
 * When an autonomous agent (LLM) encounters a tool block, surfacing an ambiguous
 * message can induce prompt-injection vulnerabilities or model hallucinations
 * where the agent attempts to circumvent policy constraints (e.g. testing different
 * recipient addresses, splitting funds into smaller transactions, or probing allowlists).
 *
 * The tests below pin:
 * 1. Structured message assembly containing reason symbol, human explanation,
 *    operator dashboard remediation, and strict halting model guidance.
 * 2. Coverage across each reason class: caps, allowlist, and frozen.
 * 3. Pragmatic negative substring checks proving messages NEVER invite policy evasion
 *    or suggest trying alternate parameters.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AGENT_HALT_GUIDANCE,
  createLangChainGuardMiddleware,
  formatBlockedToolMessage,
  getOperatorRemediation,
  getReasonClass,
} from "../../src/adapters/langchain.ts";
import { GUARD_REASON_CODES, explainReason } from "../../src/reasons.ts";
import type { PreFlightDecision, PreFlightInterceptor } from "../../src/preflight.ts";

describe("LangChain block reason classification", () => {
  it("classifies caps reasons correctly", () => {
    assert.equal(getReasonClass("per_tx_cap_exceeded"), "caps");
    assert.equal(getReasonClass("window_cap_exceeded"), "caps");
    assert.equal(getReasonClass("invalid_amount"), "caps");
  });

  it("classifies allowlist reasons correctly", () => {
    assert.equal(getReasonClass("recipient_not_allowed"), "allowlist");
    assert.equal(getReasonClass("asset_not_allowed"), "allowlist");
    assert.equal(getReasonClass("protocol_not_allowed"), "allowlist");
    assert.equal(getReasonClass("function_not_allowed"), "allowlist");
    assert.equal(getReasonClass("unknown_contract"), "allowlist");
    assert.equal(getReasonClass("self_function_not_allowed"), "allowlist");
    assert.equal(getReasonClass("create_contract_not_allowed"), "allowlist");
  });

  it("classifies frozen and account-state reasons correctly", () => {
    assert.equal(getReasonClass("admin_frozen"), "frozen");
    assert.equal(getReasonClass("heartbeat_expired"), "frozen");
    assert.equal(getReasonClass("paused"), "frozen");
    assert.equal(getReasonClass("outside_active_window"), "frozen");
    assert.equal(getReasonClass("no_policy"), "frozen");
    assert.equal(getReasonClass("not_initialized"), "frozen");
  });

  it("falls back to other for unlisted or operational reasons", () => {
    assert.equal(getReasonClass("unauthorized"), "other");
    assert.equal(getReasonClass("invalid_config"), "other");
    assert.equal(getReasonClass("already_initialized"), "other");
    assert.equal(getReasonClass("unknown_reason_999"), "other");
  });
});

describe("LangChain message assembly per reason class", () => {
  it("assembles structured message for caps class (per_tx_cap_exceeded)", () => {
    const reason = "per_tx_cap_exceeded";
    const msg = formatBlockedToolMessage({
      toolName: "send_payment",
      reason,
      explanation: explainReason(reason),
    });

    assert.equal(getReasonClass(reason), "caps");
    assert.match(msg, /stellar-agent-guard blocked 'send_payment': per_tx_cap_exceeded/);
    assert.match(msg, /The transfer amount exceeds the policy's per-transaction cap/);
    assert.match(msg, /Remediation \(operator\): transfer amount exceeds per-transaction cap — operator must raise limit via dashboard/);
    assert.match(msg, /Guidance: halted by spending policy; do not retry — escalate to operator\./);
    assert.match(msg, /No transaction was submitted, so nothing was spent and no fee was paid\./);
  });

  it("assembles structured message for caps class (window_cap_exceeded)", () => {
    const reason = "window_cap_exceeded";
    const msg = formatBlockedToolMessage({
      toolName: "send_payment",
      reason,
      explanation: explainReason(reason),
    });

    assert.equal(getReasonClass(reason), "caps");
    assert.match(msg, /window_cap_exceeded/);
    assert.match(msg, /rolling-window spend cap exceeded/);
    assert.match(msg, new RegExp(AGENT_HALT_GUIDANCE));
  });

  it("assembles structured message for allowlist class (recipient_not_allowed)", () => {
    const reason = "recipient_not_allowed";
    const msg = formatBlockedToolMessage({
      toolName: "transfer_tokens",
      reason,
      explanation: explainReason(reason),
    });

    assert.equal(getReasonClass(reason), "allowlist");
    assert.match(msg, /stellar-agent-guard blocked 'transfer_tokens': recipient_not_allowed/);
    assert.match(msg, /The transfer recipient is not in the policy's recipients allowlist/);
    assert.match(msg, /Remediation \(operator\): recipient not in policy allowlist — operator must add it via dashboard/);
    assert.match(msg, /do not retry [—-] escalate to operator/);
  });

  it("assembles structured message for allowlist class (asset_not_allowed)", () => {
    const reason = "asset_not_allowed";
    const msg = formatBlockedToolMessage({
      toolName: "swap_asset",
      reason,
      explanation: explainReason(reason),
    });

    assert.equal(getReasonClass(reason), "allowlist");
    assert.match(msg, /asset_not_allowed/);
    assert.match(msg, /asset not in policy allowlist — operator must add it via dashboard/);
  });

  it("assembles structured message for frozen class (admin_frozen)", () => {
    const reason = "admin_frozen";
    const msg = formatBlockedToolMessage({
      toolName: "send_payment",
      reason,
      explanation: explainReason(reason),
    });

    assert.equal(getReasonClass(reason), "frozen");
    assert.match(msg, /admin_frozen/);
    assert.match(msg, /account is frozen by admin or grace window lapsed — operator must unfreeze via dashboard/);
    assert.match(msg, /Guidance: halted by spending policy; do not retry — escalate to operator\./);
  });

  it("assembles structured message for frozen class (paused)", () => {
    const reason = "paused";
    const msg = formatBlockedToolMessage({
      toolName: "send_payment",
      reason,
      explanation: explainReason(reason),
    });

    assert.equal(getReasonClass(reason), "frozen");
    assert.match(msg, /paused/);
    assert.match(msg, /policy admin kill switch is engaged — operator must unpause via dashboard/);
  });
});

describe("Anti-evasion guidance & threat-model security rules", () => {
  /**
   * RATIONALE:
   * Guidance provided to the agent must never invite prompt injection attacks
   * or policy circumvention. If an error message were to suggest:
   * "try sending to another recipient" or "try a smaller amount",
   * an autonomous model might loop through recipients or split transactions
   * to bypass limits without human operator authorization.
   */
  it("never contains evasion guidance across all known reason codes", () => {
    const allReasons = Object.keys(GUARD_REASON_CODES);

    for (const reason of allReasons) {
      const msg = formatBlockedToolMessage({
        toolName: "test_tool",
        reason,
        explanation: explainReason(reason),
      });

      // Assert message does NOT contain 'try' (e.g. "try another...", "try again")
      assert.doesNotMatch(
        msg,
        /\btry\b/i,
        `Message for reason '${reason}' contains 'try', which could invite evasion`,
      );

      // Assert message does NOT suggest recipient variations
      assert.doesNotMatch(
        msg,
        /\b(different|another|alternate|alternative)\s+recipient\b/i,
        `Message for reason '${reason}' suggests recipient variation`,
      );

      // Assert message does NOT suggest amount reductions or splitting
      assert.doesNotMatch(
        msg,
        /\b(smaller|lower|different|reduced)\s+amount\b/i,
        `Message for reason '${reason}' suggests amount variation to evade caps`,
      );

      // Assert message does NOT suggest bypass or circumvention
      assert.doesNotMatch(
        msg,
        /\b(bypass|circumvent|workaround)\b/i,
        `Message for reason '${reason}' contains bypass terminology`,
      );

      // Assert the only allowed mention of retry is the negative directive "do not retry"
      const retryMatches = msg.match(/\bretry\b/gi) ?? [];
      for (const _match of retryMatches) {
        assert.match(
          msg,
          /do not retry/i,
          `Message for reason '${reason}' mentions retry outside 'do not retry'`,
        );
      }

      // Assert message explicitly instructs escalation to operator
      assert.match(
        msg,
        /do not retry — escalate to operator/i,
        `Message for reason '${reason}' is missing halting operator escalation guidance`,
      );
    }
  });

  it("explicitly designates remediation as operator-only", () => {
    const remediation = getOperatorRemediation("recipient_not_allowed");
    assert.match(remediation, /operator must/i);
    assert.doesNotMatch(remediation, /\byou must\b/i);
    assert.doesNotMatch(remediation, /\bagent must\b/i);
  });
});

describe("LangChain wrapToolCall middleware behavior", () => {
  it("returns structured error ToolMessage when tool call is blocked without entering handler", async () => {
    let handlerExecuted = false;

    const mockInterceptor = {
      check: async () => ({
        allowed: false as const,
        kind: "blocked" as const,
        reason: "recipient_not_allowed",
        explanation: explainReason("recipient_not_allowed"),
        detail: "recipient not in allowlist",
        diagnosticEvents: [],
      }),
    } as unknown as PreFlightInterceptor;

    const middleware = createLangChainGuardMiddleware({
      interceptor: mockInterceptor,
      toContractCall: (_req) => ({
        contract: "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB",
        fn: "transfer",
        args: [],
      }),
    });

    const result = await middleware.wrapToolCall(
      {
        toolCall: {
          name: "send_payment",
          id: "call_abc123",
          args: { to: "G123...", amount: "100" },
        },
      },
      async () => {
        handlerExecuted = true;
        return { result: "ok" };
      },
    );

    assert.equal(handlerExecuted, false, "handler was executed despite guard refusal");
    assert.ok("status" in result && result.status === "error");
    assert.equal(result.name, "stellar-agent-guard");
    assert.equal(result.tool_call_id, "call_abc123");

    const content = result.content;
    assert.match(content, /stellar-agent-guard blocked 'send_payment': recipient_not_allowed/);
    assert.match(content, /The transfer recipient is not in the policy's recipients allowlist/);
    assert.match(content, /Remediation \(operator\): recipient not in policy allowlist — operator must add it via dashboard/);
    assert.match(content, /Guidance: halted by spending policy; do not retry — escalate to operator\./);
  });

  it("passes through to handler when tool does not move funds", async () => {
    let handlerExecuted = false;

    const mockInterceptor = {
      check: async () => {
        throw new Error("interceptor should not be called for non-fund-moving tool");
      },
    } as unknown as PreFlightInterceptor;

    const middleware = createLangChainGuardMiddleware({
      interceptor: mockInterceptor,
      toContractCall: () => null,
    });

    const result = await middleware.wrapToolCall(
      {
        toolCall: {
          name: "get_market_price",
          args: { pair: "XLM/USDC" },
        },
      },
      async () => {
        handlerExecuted = true;
        return { price: "0.12" };
      },
    );

    assert.equal(handlerExecuted, true);
    assert.deepEqual(result, { price: "0.12" });
  });

  it("passes through to handler when interceptor allows call", async () => {
    let handlerExecuted = false;

    const mockInterceptor = {
      check: async () => ({
        allowed: true as const,
        kind: "admissible" as const,
        estimatedResourceFee: 1000n,
        footprintKeys: 4,
      } as PreFlightDecision),
    } as unknown as PreFlightInterceptor;

    const middleware = createLangChainGuardMiddleware({
      interceptor: mockInterceptor,
      toContractCall: () => ({ contract: "C123", fn: "transfer", args: [] }),
    });

    const result = await middleware.wrapToolCall(
      {
        toolCall: {
          name: "send_payment",
          args: { amount: "10" },
        },
      },
      async () => {
        handlerExecuted = true;
        return { txHash: "0x123" };
      },
    );

    assert.equal(handlerExecuted, true);
    assert.deepEqual(result, { txHash: "0x123" });
  });

  it("returns error message when decision is undetermined", async () => {
    const mockInterceptor = {
      check: async () => ({
        allowed: false as const,
        kind: "undetermined" as const,
        detail: "contract simulation trapped",
      } as PreFlightDecision),
    } as unknown as PreFlightInterceptor;

    const middleware = createLangChainGuardMiddleware({
      interceptor: mockInterceptor,
      toContractCall: () => ({ contract: "C123", fn: "transfer", args: [] }),
    });

    const result = await middleware.wrapToolCall(
      {
        toolCall: {
          name: "send_payment",
          id: "call_undetermined",
          args: {},
        },
      },
      async () => ({ done: true }),
    );

    assert.ok("status" in result && result.status === "error");
    assert.match(result.content, /could not determine whether 'send_payment' is permitted/);
    assert.match(result.content, /contract simulation trapped/);
  });
});
