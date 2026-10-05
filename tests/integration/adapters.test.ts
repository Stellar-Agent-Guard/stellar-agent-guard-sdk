/**
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
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { Address, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { PreFlightInterceptor, type PreFlightDecision } from "../../src/preflight.ts";
import { createLangChainGuardMiddleware } from "../../src/adapters/langchain.ts";
import { createGuardValidator, guardAction } from "../../src/adapters/elizaos.ts";
import { unsafeContractAddress } from "../../src/policy.ts";
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
    guard: unsafeContractAddress(config.guard),
    agent: config.keys.agent,
    source: config.keys.agent,
  });
});

/** A tool/action that sends SAC tokens out of the guarded account. */
function toContractCall(args: { to?: unknown; amount?: unknown }) {
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
 *   - blocked(reason)         → LangChain returns an error result (tool body never
 *                               entered); ElizaOS validate() false + `onBlocked` reports
 *                               the reason
 *   - undetermined(cause)      → LangChain returns an error result naming the
 *                               cause; ElizaOS validate() false + `onBlocked` reports
 *                               "undetermined"
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
];

const RECIPIENT_KEY = "recipient";
const OUTSIDER_KEY = "outsider";

function resolveArgs(row: VerdictRow):
  | { to: unknown; amount?: unknown }
  | null {
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
  if (!row.fixedVerdict) return interceptor;
  return {
    check: async () => row.fixedVerdict as PreFlightDecision,
  } as unknown as PreFlightInterceptor;
}

describe("LangChain wrapToolCall adapter against the live guard", () => {
  for (const row of VERDICT_TABLE) {
    it(`${row.name}: toolEntered=${row.langchain.toolEntered}, error=${row.langchain.error}`, async () => {
      if (!row.fixedVerdict) await installPolicy(server, config);
      let toolEntered = false;
      const middleware = createLangChainGuardMiddleware({
        interceptor: interceptorForRow(row),
        toContractCall: () => {
          const args = resolveArgs(row);
          if (args === null) return null;
          return toContractCall(args);
        },
      });

      const result = await middleware.wrapToolCall(
        {
          toolCall: {
            name: "send_payment",
            id: "lc_" + row.name,
            args: resolveArgs(row) ?? {},
          },
        },
        async () => {
          toolEntered = true;
          return { content: "sent" };
        },
      );

      assert.equal(
        toolEntered,
        row.langchain.toolEntered,
        `${row.name}: tool body entry differed from the documented behaviour`,
      );
      if (row.langchain.error) {
        assert.ok("status" in result && result.status === "error");
        if (row.langchain.matches) {
          assert.match(String((result as { content: string }).content), row.langchain.matches);
        }
      } else {
        assert.deepEqual(result, { content: "sent" });
      }
    });
  }

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
  for (const row of VERDICT_TABLE) {
    it(`${row.name}: validate=${row.elizaos.validate}, onBlocked=${JSON.stringify(row.elizaos.onBlocked ?? [])}`, async () => {
      if (!row.fixedVerdict) await installPolicy(server, config);
      const blocked: string[] = [];
      const validate = createGuardValidator({
        interceptor: interceptorForRow(row),
        // The state the runtime hands `validate` is the only place the args live,
        // so the mapper reads it (and returns `null` when there is no state).
        toContractCall: (_message, state) =>
          state === null || state === undefined
            ? null
            : toContractCall(state as { to: unknown; amount?: unknown }),
        onBlocked: (decision) =>
          blocked.push(decision.kind === "blocked" ? decision.reason : decision.kind),
      });

      const verdict = await validate({}, {}, resolveArgs(row));

      assert.equal(verdict, row.elizaos.validate);
      assert.deepEqual(blocked, row.elizaos.onBlocked ?? []);
    });
  }

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
          contract: unsafeContractAddress(config.token),
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

describe("mapping errors (toContractCall returns null)", () => {
  /**
   * A `null` call means "this action moves no funds" — the documented behaviour
   * is to pass it through untouched rather than invent a verdict, and the same
   * rule applies to both adapters. The live-refusal paths are covered by the
   * verdict table above.
   */
  it("LangChain passes the tool straight through", async () => {
    const middleware = createLangChainGuardMiddleware({
      interceptor,
      toContractCall: () => null,
    });
    const result = await middleware.wrapToolCall(
      { toolCall: { name: "send_payment", id: "lc_mapping_error", args: { to: 42 } } },
      async () => ({ content: "sent" }),
    );
    assert.deepEqual(result, { content: "sent" });
  });

  it("ElizaOS returns true and reports nothing", async () => {
    const blocked: string[] = [];
    const validate = createGuardValidator({
      interceptor,
      toContractCall: () => null,
      onBlocked: (decision) => blocked.push(decision.kind),
    });
    assert.equal(await validate({}, {}, { to: 42 }), true);
    assert.deepEqual(blocked, []);
  });
});
