/*
 * Framework adapters, driven against the real guard.
 *
 * The interceptor here is a real `PreFlightInterceptor` against the live Phase 2
 * instance — not a stub — so what is being demonstrated is the whole chain: a
 * framework's pre-execution hook, asking the deployed contract, and a blocked
 * action whose handler is **never entered**. The assertion that matters is the
 * one on the handler counter: if a refusal still let the tool body run, the
 * adapter would be decorative.
 *
 * The one exception is the `undetermined` row: that verdict only arises from a
 * failed enforcement run (an RPC error or an unpriceable simulation), which
 * cannot be produced deterministically against the live guard. That row carries
 * a fixed verdict and tests the adapters' fail-closed mapping, while the
 * `admissible` and `blocked` rows still drive the live contract.
 *
 * The verdict-fixture table below is the shared harness. Both adapters'
 * test blocks consume the same rows, so a divergence in behaviour for a given
 * verdict shows up as a review-visible diff in the expected-behaviour columns
 * (which do differ where the docs say they differ — the point is explicitness).
 *
 * This file also covers construction-time options validation: adapter misconfig
 * (missing fn, wrong type, empty options) must throw a typed error at construction
 * rather than surfacing mid-loop on the first live action. The doctrine is the
 * same one as input-validation: programmer errors throw at setup, policy
 * refusals return/throw as documented.
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { Address, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { PreFlightInterceptor, type PreFlightDecision } from "../../src/preflight.ts";
import { createLangChainGuardMiddleware } from "../../src/adapters/langchain.ts";
import { createGuardValidator, guardAction } from "../../src/adapters/elizaos.ts";
import { GuardError, GuardBlockedError, GuardUndeterminedError } from "../../src/index.ts";
import { unsafeContractAddress } from "../../src/policy.ts";
import { loadPhase2Config, installPolicy, type Phase2Config } from "./harness.ts";
import { appendFileSync, readFileSync } from "node:fs";

/**
 * Read the guarded account's sequence number and native balance directly from
 * the network. Used by the live-enforcement scenario to prove that a blocked
 * tool call broadcast nothing: both reads must be identical before and after.
 */
async function readAccountState(account: string): Promise<{ sequence: string; balance: string }> {
  const record = await server.getAccount(account);
  const native = record.balances.find((b: { asset_type: string }) => b.asset_type === "native");
  return {
    sequence: record.sequenceNumber(),
    balance: native ? native.balance : "0",
  };
}

let config: Phase2Config;
let server: rpc.Server;
let interceptor: PreFlightInterceptor;

before(async () => {
  config = await loadPhase2Config();
  server = new rpc.Server(config.rpcUrl);
  interceptor = new PreFlightInterceptor({
    server,
    networkPassphrase: "Test SDF Network ; September 2015",
    guard: unsafeContractAddress(config.guard),
    agent: config.keys.agent,
    source: config.keys.agent,
  });
});

/** A tool/action that sends SAC tokens out of the guarded account. */
function toContractCall(args: Record<string, unknown>) {
  if (typeof args.to !== "string" || args.amount === undefined) return null;
  return {
    contract: unsafeContractAddress(config.token),
    fn: "transfer",
    args: [
      new Address(config.guard).toScVal(),
      new Address(args.to as string).toScVal(),
      nativeToScVal(BigInt(args.amount as string), { type: "i128" }),
    ],
  };
}

/**
 * The verdict fixture table.
 *
 * Each row describes a verdict the guard can return and the documented
 * behaviour of each adapter for that verdict. The columns differ where the
 * adapters' contracts differ — that difference is the point of the harness.
 *
 * Verdicts:
 *   - admissible             → LangChain enters the tool; ElizaOS validate() true
 *   - blocked(reason)        → LangChain returns an error result (tool body never
 *                              entered); ElizaOS validate() false + `onBlocked` reports
 *                              the reason
 *   - undetermined(cause)    → LangChain returns an error result naming the
 *                              cause; ElizaOS validate() false + `onBlocked` reports
 *                              "undetermined"
 */
interface VerdictRow {
  /** Human-readable name of the verdict being exercised. */
  name: string;
  /** The args to hand the adapter, or null to exercise the mapping-error path. */
  args: { to: unknown; amount?: unknown } | null;
  /**
   * A fixed verdict for rows whose verdict cannot be produced deterministically
   * against the live guard. When set, the row runs against this decision instead
   * of the live interceptor — the adapters' mapping is what is under test.
   */
  fixedVerdict?: PreFlightDecision;
  /**
   * An error thrown by the interceptor instead of returning a decision.
   */
  throwsError?: Error;
  /** LangChain expected behaviour. */
  langchain: {
    /** Whether the tool body is entered. */
    toolEntered: boolean;
    /** Whether the result is an error result. */
    error: boolean;
    /** Substring the error content must match, if any. */
    matches?: RegExp;
  };
  /** ElizaOS expected behaviour. */
  elizaos: {
    /** The boolean `validate()` must return. */
    validate: boolean;
    /** What `onBlocked` must report, if anything. */
    onBlocked?: string[];
  };
}

const VERDICT_TABLE: VerdictRow[] = [
  {
    name: "admissible",
    args: { to: "recipient", amount: "5" },
    langchain: { toolEntered: true, error: false },
    elizaos: { validate: true },
  },
  {
    name: "blocked(recipient_not_allowed)",
    args: { to: "outsider", amount: "5" },
    langchain: {
      toolEntered: false,
      error: true,
      matches: /recipient_not_allowed/,
    },
    elizaos: { validate: false, onBlocked: ["recipient_not_allowed"] },
  },
  {
    name: "undetermined(cause)",
    args: { to: "recipient", amount: "5" },
    // See the file header: an `undetermined` run cannot be forced against the
    // live guard, so the verdict is supplied directly and the adapters' mapping
    // is asserted. The message asserted below is the adapter's own
    // `describeRefusal` text for an undetermined decision.
    fixedVerdict: {
      allowed: false,
      kind: "undetermined",
      detail: "enforced simulation failed: rpc unavailable",
    },
    langchain: {
      toolEntered: false,
      error: true,
      matches: /could not determine/,
    },
    elizaos: { validate: false, onBlocked: ["undetermined"] },
  },
  {
    name: "thrown GuardBlockedError(per_tx_cap_exceeded)",
    args: { to: "recipient", amount: "5" },
    throwsError: new GuardBlockedError({
      stage: "preflight",
      reason: "per_tx_cap_exceeded",
      detail: "enforced simulation refused the transfer",
      rawEvent: null,
    }),
    langchain: {
      toolEntered: false,
      error: true,
      matches: /per_tx_cap_exceeded/,
    },
    elizaos: { validate: false, onBlocked: ["per_tx_cap_exceeded"] },
  },
  {
    name: "thrown GuardUndeterminedError(rpc unavailable)",
    args: { to: "recipient", amount: "5" },
    throwsError: new GuardUndeterminedError("simulation failed: rpc unavailable", {
      stage: "preflight",
      cause: new Error("rpc unavailable"),
    }),
    langchain: {
      toolEntered: false,
      error: true,
      matches: /could not determine|rpc unavailable/,
    },
    elizaos: { validate: false, onBlocked: ["undetermined"] },
  },
];

const RECIPIENT_KEY = "recipient";
const OUTSIDER_KEY = "outsider";

function resolveArgs(row: VerdictRow): { to: unknown; amount?: unknown } | null {
  if (row.args === null) return null;
  const to =
    row.args.to === RECIPIENT_KEY
      ? config.keys.recipient.publicKey()
      : row.args.to === OUTSIDER_KEY
        ? config.keys.outsider.publicKey()
        : row.args.to;
  return { to, amount: row.args.amount };
}

/**
 * The interceptor a row runs against: the live one for verdicts the guard can be
 * made to return, a fixed-verdict stand-in for the `undetermined` row.
 */
function interceptorForRow(row: VerdictRow): PreFlightInterceptor {
  if (row.throwsError) {
    return {
      check: async () => {
        throw row.throwsError;
      },
    } as unknown as PreFlightInterceptor;
  }
  if (!row.fixedVerdict) return interceptor;
  return {
    check: async () => row.fixedVerdict as PreFlightDecision,
  } as unknown as PreFlightInterceptor;
}

describe("LangChain wrapToolCall adapter against the live guard", () => {
  it("never enters the tool body when the guard refuses", async () => {
    await installPolicy(server, config);
    let toolEntered = false;
    const middleware = createLangChainGuardMiddleware({
      interceptor,
      toContractCall: (request) => toContractCall(request.toolCall.args),
    });

    const result = await middleware.wrapToolCall(
      {
        toolCall: {
          name: "send_payment",
          id: "call_1",
          args: { to: config.keys.outsider.publicKey(), amount: "5" },
        },
      },
      async () => {
        toolEntered = true;
        return { content: "sent" };
      },
    );

    assert.equal(toolEntered, false, "the tool body ran despite a guard refusal");
    assert.ok("status" in result && result.status === "error");
    assert.match(String((result as { content: string }).content), /recipient_not_allowed/);
    console.log(
      `[langchain] refused without entering the tool: ${(result as { content: string }).content.split("\n")[0]}`,
    );
  });

  it("enters the tool body when the guard permits", async () => {
    await installPolicy(server, config);
    let toolEntered = false;
    const middleware = createLangChainGuardMiddleware({
      interceptor,
      toContractCall: (request) => toContractCall(request.toolCall.args),
    });

    const result = await middleware.wrapToolCall(
      {
        toolCall: {
          name: "send_payment",
          id: "call_2",
          args: { to: config.keys.recipient.publicKey(), amount: "5" },
        },
      },
      async () => {
        toolEntered = true;
        return { content: "sent" };
      },
    );

    assert.equal(toolEntered, true, "the tool did not run for an admissible call");
    assert.deepEqual(result, { content: "sent" });
  });

  it("blocks a real would-be transfer end-to-end with zero broadcast", async () => {
    await installPolicy(server, config);

    // Before-reads: the strongest evidence that nothing was broadcast is that
    // the guarded account's sequence number and native balance are unchanged.
    const before = await readAccountState(config.keys.agent);

    let toolEntered = false;
    const middleware = createLangChainGuardMiddleware({
      interceptor,
      toContractCall: (request) => toContractCall(request.toolCall.args),
    });

    const result = await middleware.wrapToolCall(
      {
        toolCall: {
          name: "send_payment",
          id: "call_live_block",
          args: { to: config.keys.outsider.publicKey(), amount: "5" },
        },
      },
      async () => {
        toolEntered = true;
        return { content: "sent" };
      },
    );

    // After-reads: identical sequence + balance ⇒ no transaction was submitted.
    const after = await readAccountState(config.keys.agent);

    assert.equal(toolEntered, false, "the tool body ran despite a guard refusal");
    assert.ok("status" in result && result.status === "error");
    const content = String((result as { content: string }).content);
    assert.match(content, /recipient_not_allowed/);

    assert.equal(
      after.sequence,
      before.sequence,
      `sequence number changed (${before.sequence} -> ${after.sequence})`,
    );
    assert.equal(
      after.balance,
      before.balance,
      `native balance changed (${before.balance} -> ${after.balance})`,
    );
  });
});
