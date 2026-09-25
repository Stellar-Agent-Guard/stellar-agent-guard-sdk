/**
 * Framework adapters, driven against the real guard.
 *
 * The interceptor here is a real `PreFlightInterceptor` against the live Phase 2
 * instance — not a stub — so what is being demonstrated is the whole chain: a
 * framework's pre-execution hook, asking the deployed contract, and a blocked
 * action whose handler is **never entered**. The assertion that matters is the
 * one on the handler counter: if a refusal still let the tool body run, the
 * adapter would be decorative.
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { Address, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { PreFlightInterceptor } from "../../src/preflight.ts";
import { createLangChainGuardMiddleware } from "../../src/adapters/langchain.ts";
import { createGuardValidator, guardAction } from "../../src/adapters/elizaos.ts";
import { loadPhase2Config, installPolicy, type Phase2Config } from "./harness.ts";

let config: Phase2Config;
let server: rpc.Server;
let interceptor: PreFlightInterceptor;

before(async () => {
  config = await loadPhase2Config();
  server = new rpc.Server(config.rpcUrl);
  interceptor = new PreFlightInterceptor({
    server,
    networkPassphrase: "Test SDF Network ; September 2015",
    guard: config.guard,
    agent: config.keys.agent,
    source: config.keys.agent,
  });
});

/** A tool/action that sends SAC tokens out of the guarded account. */
function toContractCall(args: { to?: unknown; amount?: unknown }) {
  if (typeof args.to !== "string" || args.amount === undefined) return null;
  return {
    contract: config.token,
    fn: "transfer",
    args: [
      new Address(config.guard).toScVal(),
      new Address(args.to).toScVal(),
      nativeToScVal(BigInt(args.amount as string), { type: "i128" }),
    ],
  };
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
    assert.match(String((result as { content: string }).content), /Remediation \(operator\): recipient not in policy allowlist/);
    assert.match(String((result as { content: string }).content), /do not retry [—-] escalate to operator/);
    console.log(`[langchain] refused without entering the tool: ${(result as { content: string }).content.split("\n")[0]}`);
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

  it("passes a non-fund-moving tool straight through", async () => {
    const middleware = createLangChainGuardMiddleware({
      interceptor,
      toContractCall: () => null,
    });
    const result = await middleware.wrapToolCall(
      { toolCall: { name: "get_weather", id: "call_3", args: {} } },
      async () => ({ content: "sunny" }),
    );
    assert.deepEqual(result, { content: "sunny" });
  });
});

describe("ElizaOS Action.validate adapter against the live guard", () => {
  it("returns false for a refused action and reports why", async () => {
    await installPolicy(server, config);
    const blocked: string[] = [];
    const validate = createGuardValidator({
      interceptor,
      toContractCall: (_message, state) => toContractCall((state ?? {}) as { to?: unknown; amount?: unknown }),
      onBlocked: (decision) => blocked.push(decision.kind === "blocked" ? decision.reason : decision.kind),
    });

    const verdict = await validate({}, {}, {
      to: config.keys.outsider.publicKey(),
      amount: "5",
    });

    assert.equal(verdict, false);
    assert.deepEqual(blocked, ["recipient_not_allowed"]);
    console.log(`[elizaos] validate() returned false: ${blocked[0]}`);
  });

  it("returns true for an admissible action", async () => {
    await installPolicy(server, config);
    const validate = createGuardValidator({
      interceptor,
      toContractCall: (_message, state) => toContractCall((state ?? {}) as { to?: unknown; amount?: unknown }),
    });
    const verdict = await validate({}, {}, {
      to: config.keys.recipient.publicKey(),
      amount: "5",
    });
    assert.equal(verdict, true);
  });

  it("composes in front of the action's own validate rather than replacing it", async () => {
    let baseCalls = 0;
    const action = guardAction(
      {
        name: "send_payment",
        validate: async () => {
          baseCalls += 1;
          return false; // the action is not applicable
        },
      },
      {
        interceptor,
        toContractCall: () => ({
          contract: config.token,
          fn: "transfer",
          args: [
            new Address(config.guard).toScVal(),
            new Address(config.keys.outsider.publicKey()).toScVal(),
            nativeToScVal(5n, { type: "i128" }),
          ],
        }),
      },
    );

    const verdict = await action.validate({}, {});
    assert.equal(verdict, false);
    assert.equal(baseCalls, 1, "the action's own validate must still be consulted");
  });
});
