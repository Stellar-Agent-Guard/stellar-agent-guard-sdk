/**
 * Unit tests for the framework adapters' pre-execution refusal path.
 *
 * These drive the adapters against a stub interceptor so the matrix the issue
 * calls for is exhaustive and offline: for each adapter, a guard refusal with an
 * okay hook, with a throwing hook, and with no hook at all. The property that
 * matters is that the halt is decided *before* the hook runs and is never
 * altered by it — an alerting sink that is down must not turn a refusal into an
 * executed action, or into a thrown error.
 *
 * The MCP adapter (issue #45) is covered here too, including the client-side
 * `callTool` boundary.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLangChainGuardMiddleware } from "../../src/adapters/langchain.ts";
import { createGuardValidator, guardAction } from "../../src/adapters/elizaos.ts";
import { guardMcpCallTool, guardMcpToolHandler } from "../../src/adapters/mcp.ts";
import { runBlockedHook, type GuardBlockedInfo } from "../../src/adapters/shared.ts";
import { unsafeContractAddress } from "../../src/policy.ts";
import { explainReason } from "../../src/reasons.ts";
import type { PreFlightDecision, PreFlightInterceptor } from "../../src/preflight.ts";
import type { ContractCall } from "../../src/tx.ts";

const GUARD = unsafeContractAddress("CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44");

/** A structurally valid SAC transfer call; the stub interceptor never reads it. */
function transferCall(): ContractCall {
  return { contract: GUARD, fn: "transfer", args: [] };
}

const BLOCKED: PreFlightDecision = {
  allowed: false,
  kind: "blocked",
  reason: "per_tx_cap_exceeded",
  explanation: explainReason("per_tx_cap_exceeded"),
  detail: "enforced simulation refused the transfer",
  diagnosticEvents: [],
};

const UNDETERMINED: PreFlightDecision = {
  allowed: false,
  kind: "undetermined",
  detail: "rpc unreachable",
};

const ADMISSIBLE: PreFlightDecision = {
  allowed: true,
  kind: "admissible",
  estimatedResourceFee: 100n,
  footprintKeys: 2,
};

/** An interceptor that returns a fixed verdict without touching the network. */
function stub(decision: PreFlightDecision): PreFlightInterceptor {
  return { check: async () => decision } as unknown as PreFlightInterceptor;
}

/** Capture `console.error` so the swallowed-hook log line can be asserted. */
function captureConsoleError(): { calls: unknown[][]; restore: () => void } {
  const calls: unknown[][] = [];
  const original = console.error;
  console.error = ((...args: unknown[]) => {
    calls.push(args);
  }) as typeof console.error;
  return {
    calls,
    restore: () => {
      console.error = original;
    },
  };
}

describe("runBlockedHook isolation (issue #102)", () => {
  it("is a no-op when no hook is configured", () => {
    const log = captureConsoleError();
    try {
      runBlockedHook(undefined, {
        adapter: "langchain",
        kind: "blocked",
        reason: "paused",
        call: transferCall(),
        explanation: "paused",
      });
      assert.equal(log.calls.length, 0);
    } finally {
      log.restore();
    }
  });

  it("logs and swallows a throwing hook instead of propagating it", () => {
    const log = captureConsoleError();
    try {
      assert.doesNotThrow(() =>
        runBlockedHook(
          () => {
            throw new Error("alerting sink is down");
          },
          {
            adapter: "elizaos",
            kind: "blocked",
            reason: "paused",
            call: transferCall(),
            explanation: "paused",
          },
        ),
      );
      assert.equal(log.calls.length, 1);
      assert.match(String(log.calls[0]![0]), /elizaos adapter's onBlocked callback threw/);
    } finally {
      log.restore();
    }
  });
});

describe("LangChain adapter onBlocked (issue #102)", () => {
  function wrap(
    decision: PreFlightDecision,
    onBlocked?: (info: GuardBlockedInfo) => void,
  ) {
    let toolEntered = false;
    const middleware = createLangChainGuardMiddleware({
      interceptor: stub(decision),
      toContractCall: () => transferCall(),
      ...(onBlocked ? { onBlocked } : {}),
    });
    const settle = () =>
      middleware.wrapToolCall(
        { toolCall: { name: "send_payment", id: "call_1", args: {} } },
        async () => {
          toolEntered = true;
          return { content: "sent" };
        },
      );
    return { settle, wasToolEntered: () => toolEntered };
  }

  it("fires once with the structured payload on a refusal, without entering the tool", async () => {
    const infos: GuardBlockedInfo[] = [];
    const { settle, wasToolEntered } = wrap(BLOCKED, (info) => infos.push(info));

    const result = await settle();

    assert.equal(wasToolEntered(), false, "the tool body ran despite a refusal");
    assert.ok("status" in result && result.status === "error");
    assert.equal(infos.length, 1);
    assert.equal(infos[0]!.adapter, "langchain");
    assert.equal(infos[0]!.kind, "blocked");
    assert.equal(infos[0]!.reason, "per_tx_cap_exceeded");
    assert.equal(infos[0]!.call.fn, "transfer");
    assert.match(infos[0]!.explanation, /per-transaction cap/);
  });

  it("reports an undetermined halt as a null-reason payload carrying the detail", async () => {
    const infos: GuardBlockedInfo[] = [];
    const { settle } = wrap(UNDETERMINED, (info) => infos.push(info));

    await settle();

    assert.equal(infos.length, 1);
    assert.equal(infos[0]!.kind, "undetermined");
    assert.equal(infos[0]!.reason, null);
    assert.equal(infos[0]!.explanation, "rpc unreachable");
  });

  it("swallows a throwing hook: the refusal is returned unchanged and logged", async () => {
    const log = captureConsoleError();
    try {
      const { settle } = wrap(BLOCKED, () => {
        throw new Error("webhook down");
      });
      const result = await settle();
      assert.ok("status" in result && result.status === "error");
      assert.match(String((result as { content: string }).content), /per_tx_cap_exceeded/);
      assert.equal(log.calls.length, 1);
      assert.match(String(log.calls[0]![0]), /langchain adapter's onBlocked callback threw/);
    } finally {
      log.restore();
    }
  });

  it("behaves exactly as before when no hook is configured", async () => {
    const { settle, wasToolEntered } = wrap(BLOCKED);
    const result = await settle();
    assert.equal(wasToolEntered(), false);
    assert.ok("status" in result && result.status === "error");
  });

  it("never fires on an admissible decision", async () => {
    let fired = 0;
    const { settle, wasToolEntered } = wrap(ADMISSIBLE, () => {
      fired += 1;
    });
    const result = await settle();
    assert.equal(wasToolEntered(), true);
    assert.deepEqual(result, { content: "sent" });
    assert.equal(fired, 0);
  });
});

describe("ElizaOS adapter onBlocked (issue #102)", () => {
  it("fires with adapter elizaos on a refusal and still returns false", async () => {
    const infos: GuardBlockedInfo[] = [];
    const validate = createGuardValidator({
      interceptor: stub(BLOCKED),
      toContractCall: () => transferCall(),
      onBlocked: (info) => infos.push(info),
    });

    const verdict = await validate({}, {}, {});

    assert.equal(verdict, false);
    assert.equal(infos.length, 1);
    assert.equal(infos[0]!.adapter, "elizaos");
    assert.equal(infos[0]!.kind, "blocked");
    assert.equal(infos[0]!.reason, "per_tx_cap_exceeded");
    assert.equal(infos[0]!.call.fn, "transfer");
  });

  it("does not let a throwing hook change the false verdict", async () => {
    const log = captureConsoleError();
    try {
      const validate = createGuardValidator({
        interceptor: stub(BLOCKED),
        toContractCall: () => transferCall(),
        onBlocked: () => {
          throw new Error("sink down");
        },
      });
      assert.equal(await validate({}, {}, {}), false);
      assert.equal(log.calls.length, 1);
      assert.match(String(log.calls[0]![0]), /elizaos adapter's onBlocked callback threw/);
    } finally {
      log.restore();
    }
  });

  it("keeps the pre-existing behavior with no hook configured", async () => {
    const validate = createGuardValidator({
      interceptor: stub(BLOCKED),
      toContractCall: () => transferCall(),
    });
    assert.equal(await validate({}, {}, {}), false);
  });

  it("does not fire on an admissible action", async () => {
    let fired = 0;
    const validate = createGuardValidator({
      interceptor: stub(ADMISSIBLE),
      toContractCall: () => transferCall(),
      onBlocked: () => {
        fired += 1;
      },
    });
    assert.equal(await validate({}, {}, {}), true);
    assert.equal(fired, 0);
  });

  it("composes the hook through guardAction as well as createGuardValidator", async () => {
    const infos: GuardBlockedInfo[] = [];
    const action = guardAction(
      { name: "send_payment", validate: async () => true },
      {
        interceptor: stub(BLOCKED),
        toContractCall: () => transferCall(),
        onBlocked: (info) => infos.push(info),
      },
    );
    assert.equal(await action.validate({}, {}), false);
    assert.equal(infos.length, 1);
    assert.equal(infos[0]!.adapter, "elizaos");
  });
});

describe("MCP adapter (issue #45)", () => {
  it("guardMcpToolHandler refuses without invoking the tool body and fires the hook", async () => {
    const infos: GuardBlockedInfo[] = [];
    let handlerRan = false;
    const guarded = guardMcpToolHandler(
      "transfer_tokens",
      async () => {
        handlerRan = true;
        return { content: [{ type: "text", text: "sent" }] };
      },
      {
        interceptor: stub(BLOCKED),
        toContractCall: () => transferCall(),
        onBlocked: (info) => infos.push(info),
      },
    );

    const result = await guarded({ to: "G...", amount: "5" });

    assert.equal(handlerRan, false, "the tool body ran despite a refusal");
    assert.ok("isError" in result && result.isError === true);
    assert.equal(infos.length, 1);
    assert.equal(infos[0]!.adapter, "mcp");
    assert.equal(infos[0]!.kind, "blocked");
    assert.equal(infos[0]!.reason, "per_tx_cap_exceeded");
  });

  it("passes a non-fund-moving tool straight through to the handler", async () => {
    let handlerRan = false;
    const guarded = guardMcpToolHandler(
      "get_weather",
      async () => {
        handlerRan = true;
        return { content: [{ type: "text", text: "sunny" }] };
      },
      { interceptor: stub(BLOCKED), toContractCall: () => null },
    );

    const result = await guarded({});

    assert.equal(handlerRan, true);
    assert.equal(result.content[0]!.text, "sunny");
  });

  it("guardMcpCallTool blocks at the client boundary before the request is sent", async () => {
    const infos: GuardBlockedInfo[] = [];
    let sent = false;
    const callTool = guardMcpCallTool(
      async () => {
        sent = true;
        return { content: [{ type: "text", text: "sent" }] };
      },
      {
        interceptor: stub(BLOCKED),
        toContractCall: () => transferCall(),
        onBlocked: (info) => infos.push(info),
      },
    );

    const result = await callTool({ name: "transfer_tokens", arguments: {} });

    assert.equal(sent, false);
    assert.ok("isError" in result && result.isError === true);
    assert.equal(infos.length, 1);
  });

  it("guardMcpCallTool forwards an admissible call untouched", async () => {
    const callTool = guardMcpCallTool(
      async () => ({ content: [{ type: "text", text: "sent" }] }),
      { interceptor: stub(ADMISSIBLE), toContractCall: () => transferCall() },
    );

    const result = await callTool({ name: "transfer_tokens", arguments: {} });

    assert.equal(result.content[0]!.text, "sent");
    assert.ok(!("isError" in result) || result.isError !== true);
  });

  it("swallows a throwing MCP hook and still returns the refusal result", async () => {
    const log = captureConsoleError();
    try {
      const guarded = guardMcpToolHandler(
        "transfer_tokens",
        async () => ({ content: [{ type: "text", text: "sent" }] }),
        {
          interceptor: stub(BLOCKED),
          toContractCall: () => transferCall(),
          onBlocked: () => {
            throw new Error("boom");
          },
        },
      );
      const result = await guarded({});
      assert.ok("isError" in result && result.isError === true);
      assert.equal(log.calls.length, 1);
      assert.match(String(log.calls[0]![0]), /mcp adapter's onBlocked callback threw/);
    } finally {
      log.restore();
    }
  });
});
