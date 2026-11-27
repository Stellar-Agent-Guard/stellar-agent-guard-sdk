/**
 * Shared cross-framework conformance matrix (issue #317).
 *
 * Every adapter is driven through the same fixture table — admissible, blocked,
 * undetermined, mapping failures and failing observers — so a divergence in the
 * invariants that are supposed to hold everywhere shows up as one failing row
 * rather than as four unrelated test files drifting apart.
 *
 * The shared invariants are deliberately framework-agnostic:
 *
 *   - only an admissible verdict lets the handler run;
 *   - a non-admissible verdict (including a fail-closed `undetermined` one)
 *     never enters the handler;
 *   - a mapper failure halts too (issue #316);
 *   - an observer that throws or rejects changes nothing (issue #313);
 *   - `signal`/`timeoutMs` reach the pre-flight check (issue #315).
 *
 * Result-shape assertions stay in their own block at the bottom: the host
 * contracts genuinely differ (a `ToolMessage`, a boolean, an `isError` result,
 * a thrown error), and collapsing those into the matrix would hide the very
 * difference the docs spell out.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createLangChainGuardMiddleware,
  type LangChainToolCallRequest,
} from "../../src/adapters/langchain.ts";
import { DEFAULT_ADAPTER_TIMEOUT_MS, mapContractCalls } from "../../src/adapters/shared.ts";
import { DEFAULT_RPC_TIMEOUT_MS } from "../../src/invoke.ts";
import { createGuardValidator } from "../../src/adapters/elizaos.ts";
import { guardMcpToolHandler } from "../../src/adapters/mcp.ts";
import { wrapToolWithGuard } from "../../src/adapters/vercelai.ts";
import { AdapterMappingError, GuardUndeterminedError } from "../../src/errors.ts";
import { GuardBlockedError, explainReason } from "../../src/reasons.ts";
import { PreFlightUndeterminedError } from "../../src/preflight.ts";
import { unsafeContractAddress } from "../../src/policy.ts";
import type {
  PreFlightCheckOptions,
  PreFlightDecision,
  PreFlightInterceptor,
} from "../../src/preflight.ts";
import type { ContractCall } from "../../src/tx.ts";
import type {
  BlockedHookLogger,
  GuardAdapterName,
  GuardBatchDecisionInfo,
  GuardBlockedInfo,
  GuardHookContext,
  GuardMappingErrorInfo,
} from "../../src/adapters/shared.ts";

const GUARD = unsafeContractAddress("CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44");

const CALL: ContractCall = { contract: GUARD, fn: "transfer", args: [] };

const ADMISSIBLE: PreFlightDecision = {
  allowed: true,
  kind: "admissible",
  estimatedResourceFee: 100n,
  footprintKeys: 2,
};

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

/** The fixtures every adapter must agree on. */
interface Scenario {
  name: string;
  /** Verdict the stub interceptor returns; never consulted for mapper failures. */
  decision: PreFlightDecision;
  /** Optional error the stub interceptor throws instead of returning a decision. */
  throwsError?: Error;
  /** `maps` = one valid call, `null` = not fund-moving, failures halt. */
  mapping: "maps" | "null" | "throws" | "malformed";
  /** Whether the handler must be kept from running. */
  halts: boolean;
  /** Expected `onDecision` calls. */
  decisions: number;
  /** Expected `onBlocked` calls (adapters that expose the hook). */
  blockedHooks: number;
}

const SCENARIOS: Scenario[] = [
  {
    name: "admissible",
    decision: ADMISSIBLE,
    mapping: "maps",
    halts: false,
    decisions: 1,
    blockedHooks: 0,
  },
  {
    name: "blocked",
    decision: BLOCKED,
    mapping: "maps",
    halts: true,
    decisions: 1,
    blockedHooks: 1,
  },
  {
    name: "undetermined",
    decision: UNDETERMINED,
    mapping: "maps",
    halts: true,
    decisions: 1,
    blockedHooks: 1,
  },
  {
    name: "mapping throws",
    decision: ADMISSIBLE,
    mapping: "throws",
    halts: true,
    decisions: 0,
    blockedHooks: 1,
  },
  {
    name: "mapping malformed",
    decision: ADMISSIBLE,
    mapping: "malformed",
    halts: true,
    decisions: 0,
    blockedHooks: 1,
  },
  {
    name: "mapping null (not fund-moving)",
    decision: ADMISSIBLE,
    mapping: "null",
    halts: false,
    decisions: 0,
    blockedHooks: 0,
  },
  {
    name: "interceptor throws GuardBlockedError",
    decision: BLOCKED,
    throwsError: new GuardBlockedError({
      stage: "preflight",
      reason: "per_tx_cap_exceeded",
      detail: "enforced simulation refused the transfer",
      diagnosticEvents: [],
      rawEvent: null,
      call: CALL,
    } as unknown as import("../../src/reasons.ts").GuardBlockedErrorParams),
    mapping: "maps",
    halts: true,
    decisions: 1,
    blockedHooks: 1,
  },
  {
    name: "interceptor throws GuardUndeterminedError",
    decision: UNDETERMINED,
    throwsError: new GuardUndeterminedError("simulation failed: rpc unreachable", {
      stage: "preflight",
      cause: new Error("rpc unreachable"),
    }),
    mapping: "maps",
    halts: true,
    decisions: 1,
    blockedHooks: 1,
  },
];

function mapperFor(scenario: Scenario): () => ContractCall | null {
  switch (scenario.mapping) {
    case "null":
      return () => null;
    case "throws":
      return () => {
        throw new Error("mapper exploded");
      };
    case "malformed":
      // Structurally not a contract call: empty contract, no usable args.
      return () => ({ contract: "", fn: "transfer", args: [] }) as unknown as ContractCall;
    default:
      return () => CALL;
  }
}

function stub(decision: PreFlightDecision, throwsError?: Error): PreFlightInterceptor {
  return {
    check: async () => {
      if (throwsError) throw throwsError;
      return decision;
    },
    checkBatch: async (calls: readonly ContractCall[]) => {
      if (throwsError) throw throwsError;
      return {
        admissible: decision.allowed,
        overallAdmissible: decision.allowed,
        verdicts: calls.map(() => decision),
        calls: calls.map(() => decision),
        totalEstimatedResourceFee: 0n,
      };
    },
  } as unknown as PreFlightInterceptor;
}

interface Observer {
  onBlocked?: ((info: GuardBlockedInfo) => unknown) | undefined;
  onDecision?: ((...args: unknown[]) => unknown) | undefined;
  onMappingError?: ((info: GuardMappingErrorInfo) => unknown) | undefined;
  includeMappingErrorRequest?: boolean | undefined;
  logger?: BlockedHookLogger | undefined;
}

interface Controls {
  interceptor?: PreFlightInterceptor;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  /** A signal the host hook itself supplies (LangChain request / MCP extra). */
  hostSignal?: AbortSignal | undefined;
  /** A `RunnableConfig.signal` the LangChain middleware is invoked with. */
  configSignal?: AbortSignal | undefined;
  /** Static or request-mapped correlation id (issue #459). */
  correlationId?: string | ((...args: unknown[]) => string | undefined) | undefined;
}

interface Outcome {
  /** How many times the framework handler/execute body ran. */
  entered: number;
  halted: boolean;
  /** Refusal text for the adapters that return one; empty for a plain boolean. */
  refusal: string;
}

interface AdapterHarness {
  name: GuardAdapterName;
  /** Whether this adapter's options expose `onBlocked`. */
  hasBlockedHook: boolean;
  run(scenario: Scenario, observer: Observer, controls?: Controls): Promise<Outcome>;
}

function interceptorFor(scenario: Scenario, controls?: Controls): PreFlightInterceptor {
  return controls?.interceptor ?? stub(scenario.decision, scenario.throwsError);
}

/** Options every adapter shares; `onBlocked` is added only where the API has it. */
function baseOptions(scenario: Scenario, observer: Observer, controls: Controls) {
  return {
    interceptor: interceptorFor(scenario, controls),
    ...(observer.logger ? { blockedHookLogger: observer.logger } : {}),
    ...(observer.onMappingError
      ? { onMappingError: observer.onMappingError as (info: GuardMappingErrorInfo) => void }
      : {}),
    ...(observer.includeMappingErrorRequest !== undefined
      ? { includeMappingErrorRequest: observer.includeMappingErrorRequest }
      : {}),
    ...(controls.signal ? { signal: controls.signal } : {}),
    ...(controls.timeoutMs !== undefined ? { timeoutMs: controls.timeoutMs } : {}),
    ...(controls.correlationId !== undefined ? { correlationId: controls.correlationId } : {}),
  };
}

const HARNESSES: AdapterHarness[] = [
  {
    name: "langchain",
    hasBlockedHook: true,
    async run(scenario, observer, controls = {}) {
      let entered = 0;
      const middleware = createLangChainGuardMiddleware({
        ...baseOptions(scenario, observer, controls),
        toContractCall: mapperFor(scenario),
        ...(observer.onBlocked
          ? { onBlocked: observer.onBlocked as (info: GuardBlockedInfo) => void }
          : {}),
        ...(observer.onDecision
          ? {
              onDecision: observer.onDecision as (
                request: unknown,
                decision: PreFlightDecision,
              ) => void,
            }
          : {}),
      });
      const request = {
        toolCall: { name: "send_payment", id: "lc_1", args: {} },
        ...(controls.hostSignal ? { signal: controls.hostSignal } : {}),
      };
      const result = await middleware.wrapToolCall(
        request,
        async () => {
          entered += 1;
          return { content: "sent" };
        },
        controls.configSignal ? { signal: controls.configSignal } : undefined,
      );
      return {
        entered,
        halted: entered === 0,
        refusal: "content" in result ? String(result.content) : "",
      };
    },
  },
  {
    name: "elizaos",
    hasBlockedHook: true,
    async run(scenario, observer, controls = {}) {
      let entered = 0;
      const validate = createGuardValidator({
        ...baseOptions(scenario, observer, controls),
        name: "send_payment",
        toContractCall: () => mapperFor(scenario)(),
        ...(observer.onBlocked
          ? { onBlocked: observer.onBlocked as (info: GuardBlockedInfo) => void }
          : {}),
        ...(observer.onDecision
          ? { onDecision: observer.onDecision as (decision: PreFlightDecision) => void }
          : {}),
      });
      const allowed = await validate({}, {}, {});
      if (allowed) entered += 1;
      return { entered, halted: !allowed, refusal: "" };
    },
  },
  {
    name: "mcp",
    hasBlockedHook: true,
    async run(scenario, observer, controls = {}) {
      let entered = 0;
      const handler = guardMcpToolHandler(
        "send_payment",
        async () => {
          entered += 1;
          return { content: [{ type: "text", text: "sent" }] };
        },
        {
          ...baseOptions(scenario, observer, controls),
          toContractCall: () => mapperFor(scenario)(),
          ...(observer.onBlocked
            ? { onBlocked: observer.onBlocked as (info: GuardBlockedInfo) => void }
            : {}),
          ...(observer.onDecision
            ? {
                onDecision: observer.onDecision as (
                  request: unknown,
                  decision: PreFlightDecision,
                ) => void,
              }
            : {}),
        },
      );
      const result = await handler(
        {},
        controls.hostSignal ? { signal: controls.hostSignal } : undefined,
      );
      return {
        entered,
        halted: entered === 0,
        refusal: result.content.map((block) => block.text ?? "").join(" "),
      };
    },
  },
  {
    name: "vercelai",
    // The AI SDK adapter signals refusals by throwing; it has no onBlocked.
    hasBlockedHook: false,
    async run(scenario, observer, controls = {}) {
      let entered = 0;
      const tool = wrapToolWithGuard(
        {
          async execute() {
            entered += 1;
            return "sent";
          },
        },
        {
          ...baseOptions(scenario, observer, controls),
          toContractCall: () => mapperFor(scenario)(),
          ...(observer.onDecision
            ? {
                onDecision: observer.onDecision as (
                  call: unknown,
                  decision: PreFlightDecision,
                ) => void,
              }
            : {}),
        },
        { toolName: "send_payment", input: {} },
      );
      let refusal = "";
      try {
        await tool.execute!();
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }
      return { entered, halted: entered === 0, refusal };
    },
  },
];

/** Count observer calls so the matrix can assert the callback invariants too. */
function observing(): {
  observer: Observer;
  blocked: GuardBlockedInfo[];
  decisionCount: () => number;
} {
  const blocked: GuardBlockedInfo[] = [];
  let decisions = 0;
  return {
    observer: {
      onBlocked: (info) => {
        blocked.push(info);
      },
      onDecision: () => {
        decisions += 1;
      },
    },
    blocked,
    decisionCount: () => decisions,
  };
}

describe("cross-framework conformance matrix (issue #317)", () => {
  for (const adapter of HARNESSES) {
    describe(adapter.name, () => {
      for (const scenario of SCENARIOS) {
        it(`${scenario.name}: handler entered ${scenario.halts ? 0 : 1} time(s)`, async () => {
          const { observer, blocked, decisionCount } = observing();
          const outcome = await adapter.run(scenario, observer);

          assert.equal(
            outcome.entered,
            scenario.halts ? 0 : 1,
            `${scenario.name}: the handler entry count differed from the shared invariant`,
          );
          assert.equal(outcome.halted, scenario.halts, `${scenario.name}: halt state`);
          assert.equal(decisionCount(), scenario.decisions, `${scenario.name}: onDecision calls`);
          if (adapter.hasBlockedHook) {
            assert.equal(
              blocked.length,
              scenario.blockedHooks,
              `${scenario.name}: onBlocked calls`,
            );
          }
        });
      }
    });
  }
});

describe("call-mapping failures fail closed (issue #316)", () => {
  for (const adapter of HARNESSES.filter((candidate) => candidate.hasBlockedHook)) {
    it(`${adapter.name}: reports a mapper failure as an undetermined halt with no call`, async () => {
      const { observer, blocked } = observing();
      const outcome = await adapter.run(
        SCENARIOS.find((scenario) => scenario.name === "mapping throws")!,
        observer,
      );

      assert.equal(outcome.entered, 0);
      assert.equal(blocked.length, 1);
      assert.equal(blocked[0]!.adapter, adapter.name);
      assert.equal(blocked[0]!.kind, "undetermined");
      assert.equal(blocked[0]!.reason, null);
      assert.equal(blocked[0]!.call, undefined, "a mapping failure has no mapped call to report");
      assert.match(blocked[0]!.explanation, /call mapping failed/);
      assert.match(blocked[0]!.explanation, /mapper exploded/);
    });
  }

  it("Vercel AI: a mapper failure throws PreFlightUndeterminedError with the mapping cause", async () => {
    const harness = HARNESSES.find((candidate) => candidate.name === "vercelai")!;
    const outcome = await harness.run(
      SCENARIOS.find((scenario) => scenario.name === "mapping throws")!,
      {},
    );
    assert.equal(outcome.entered, 0);
    assert.match(outcome.refusal, /could not determine/);
    assert.match(outcome.refusal, /call mapping failed/);
  });

  const isMappingError = (error: unknown): boolean => {
    if (error instanceof AdapterMappingError) return true;
    assert.fail(`expected an AdapterMappingError, got ${String(error)}`);
  };

  it("flags a malformed single-call return as a typed AdapterMappingError", () => {
    assert.throws(
      () =>
        mapContractCalls(
          {},
          {
            toContractCall: () =>
              ({ contract: "", fn: "transfer", args: [] }) as unknown as ContractCall,
          },
        ),
      isMappingError,
    );
  });

  it("flags a malformed batch entry and names its index", () => {
    assert.throws(
      () =>
        mapContractCalls(
          {},
          {
            toContractCalls: () => [{ contract: GUARD, fn: "", args: [] }] as ContractCall[],
          },
        ),
      (error: unknown) => {
        assert.ok(error instanceof AdapterMappingError);
        assert.equal(error.field, "toContractCalls");
        assert.match(error.message, /index 0/);
        return true;
      },
    );
  });

  it("runs unmapped calls through nothing at all (null stays a pass-through)", () => {
    assert.deepEqual(mapContractCalls({}, { toContractCall: () => null }), []);
    assert.deepEqual(mapContractCalls({}, { toContractCalls: () => null }), []);
  });
});

describe("onMappingError parity (issue #453)", () => {
  function mappingObserver(): {
    observer: Observer;
    seen: GuardMappingErrorInfo[];
    blocked: GuardBlockedInfo[];
  } {
    const seen: GuardMappingErrorInfo[] = [];
    const blocked: GuardBlockedInfo[] = [];
    return {
      seen,
      blocked,
      observer: {
        onMappingError: (info) => {
          seen.push(info);
        },
        onBlocked: (info) => {
          blocked.push(info);
        },
      },
    };
  }

  for (const adapter of HARNESSES) {
    it(`${adapter.name}: fires exactly once on a mapper failure, with no raw request`, async () => {
      const { observer, seen, blocked } = mappingObserver();
      const outcome = await adapter.run(
        SCENARIOS.find((scenario) => scenario.name === "mapping throws")!,
        observer,
      );

      assert.equal(outcome.entered, 0, "a mapping failure resumed the action");
      assert.equal(outcome.halted, true);
      assert.equal(seen.length, 1, "onMappingError must fire exactly once");
      assert.equal(seen[0]!.adapter, adapter.name);
      assert.equal(seen[0]!.tool, "send_payment");
      assert.equal(seen[0]!.errorClass, "AdapterMappingError");
      assert.ok(seen[0]!.error instanceof AdapterMappingError);
      assert.match(seen[0]!.error.message, /mapper exploded/);
      assert.equal("request" in seen[0]!, false, "raw tool arguments must be omitted by default");
      if (adapter.hasBlockedHook) {
        assert.equal(blocked.length, 1, "onBlocked must keep firing for compatibility");
        assert.equal(blocked[0]!.kind, "undetermined");
      }
    });

    it(`${adapter.name}: a guard refusal does not fire onMappingError`, async () => {
      const { observer, seen } = mappingObserver();
      const outcome = await adapter.run(
        SCENARIOS.find((scenario) => scenario.name === "blocked")!,
        observer,
      );
      assert.equal(outcome.halted, true);
      assert.equal(seen.length, 0, "a policy refusal was reported as a mapping failure");
    });

    it(`${adapter.name}: a throwing mapping hook cannot resume the action`, async () => {
      const logged: unknown[][] = [];
      const { observer } = mappingObserver();
      const outcome = await adapter.run(
        SCENARIOS.find((scenario) => scenario.name === "mapping throws")!,
        {
          ...observer,
          onMappingError: () => {
            throw new Error("mapping sink failure");
          },
          logger: {
            error: (...args) => {
              logged.push(args);
            },
          },
        },
      );
      assert.equal(outcome.entered, 0);
      assert.equal(outcome.halted, true);
      assert.match(String(logged[0]?.[0] ?? ""), /onMappingError/);
    });

    it(`${adapter.name}: includeMappingErrorRequest opts in to the raw request`, async () => {
      const { observer, seen } = mappingObserver();
      await adapter.run(SCENARIOS.find((scenario) => scenario.name === "mapping throws")!, {
        ...observer,
        includeMappingErrorRequest: true,
      });
      assert.equal(seen.length, 1);
      assert.equal("request" in seen[0]!, true);
      assert.ok(seen[0]!.request !== undefined);
    });
  }
});

describe("observer isolation (issue #313)", () => {
  for (const adapter of HARNESSES) {
    it(`${adapter.name}: sync throws and rejected async hooks cannot change the halt`, async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      try {
        const failures: Observer[] = [
          {
            onBlocked: () => {
              throw new Error("sync sink failure");
            },
          },
          { onBlocked: () => Promise.reject(new Error("async sink failure")) },
          {
            onDecision: () => {
              throw new Error("sync decision failure");
            },
          },
          { onDecision: () => Promise.reject(new Error("async decision failure")) },
        ];

        const applicable = failures.filter(
          (observer) => adapter.hasBlockedHook || observer.onDecision !== undefined,
        );

        for (const observer of applicable) {
          const logged: unknown[][] = [];
          const logger: BlockedHookLogger = {
            error: (...args) => {
              logged.push(args);
            },
          };
          const outcome = await adapter.run(SCENARIOS[1]!, { ...observer, logger });

          assert.equal(outcome.entered, 0, "an observer failure resumed a blocked action");
          assert.equal(outcome.halted, true);
          assert.match(
            String(logged[0]?.[0] ?? ""),
            /onBlocked|onDecision/,
            "a swallowed observer failure must name the hook when a logger is supplied",
          );
          // Let every isolated rejection settle before the unhandled check.
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
      assert.deepEqual(unhandled, [], "an observer rejection escaped as unhandled");
    });

    it(`${adapter.name}: does not await a pending async observer`, async () => {
      const pending = adapter.run(SCENARIOS[1]!, {
        onBlocked: () => new Promise<void>(() => {}),
        onDecision: () => new Promise<void>(() => {}),
      });
      const result = await Promise.race([
        pending,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
      ]);
      assert.notEqual(result, "timeout", "the adapter awaited an observer hook");
      assert.equal((result as Outcome).entered, 0);
    });

    it(`${adapter.name}: a failing onDecision cannot stop an admissible handler`, async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      try {
        const failures: Observer[] = [
          {
            onDecision: () => {
              throw new Error("sync decision failure");
            },
          },
          { onDecision: () => Promise.reject(new Error("async decision failure")) },
        ];

        for (const observer of failures) {
          const logged: unknown[][] = [];
          const logger: BlockedHookLogger = {
            error: (...args) => {
              logged.push(args);
            },
          };
          const outcome = await adapter.run(SCENARIOS[0]!, { ...observer, logger });

          assert.equal(outcome.entered, 1, "an observer failure suppressed an allowed action");
          assert.equal(outcome.halted, false);
          assert.doesNotMatch(outcome.refusal, /blocked|could not determine|refus/i);
          assert.match(
            String(logged[0]?.[0] ?? ""),
            /onDecision/,
            "a swallowed observer failure must name the hook when a logger is supplied",
          );
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
      assert.deepEqual(unhandled, [], "an observer rejection escaped as unhandled");
    });
  }
});

describe("cancellation and timeout forwarding (issue #315)", () => {
  function capturing(decision: PreFlightDecision): {
    seen: PreFlightCheckOptions[];
    interceptor: PreFlightInterceptor;
  } {
    const seen: PreFlightCheckOptions[] = [];
    return {
      seen,
      interceptor: {
        check: async (_call: ContractCall, options?: PreFlightCheckOptions) => {
          seen.push(options ?? {});
          return decision;
        },
        checkBatch: async (calls: readonly ContractCall[], options?: PreFlightCheckOptions) => {
          seen.push(options ?? {});
          return {
            admissible: decision.allowed,
            overallAdmissible: decision.allowed,
            verdicts: calls.map(() => decision),
            calls: calls.map(() => decision),
            totalEstimatedResourceFee: 0n,
          };
        },
      } as unknown as PreFlightInterceptor,
    };
  }

  for (const adapter of HARNESSES) {
    it(`${adapter.name}: forwards signal and timeoutMs to the pre-flight check`, async () => {
      const controller = new AbortController();
      const { seen, interceptor } = capturing(ADMISSIBLE);
      const outcome = await adapter.run(
        SCENARIOS[0]!,
        {},
        {
          interceptor,
          signal: controller.signal,
          timeoutMs: 250,
        },
      );

      assert.equal(seen.length, 1);
      assert.equal(seen[0]!.signal, controller.signal);
      assert.equal(seen[0]!.timeoutMs, 250);
      assert.equal(outcome.entered, 1);
    });

    it(`${adapter.name}: a pre-aborted signal still halts instead of running the action`, async () => {
      const controller = new AbortController();
      controller.abort();
      const signalAware = {
        check: async (_call: ContractCall, options?: PreFlightCheckOptions) =>
          options?.signal?.aborted ? UNDETERMINED : ADMISSIBLE,
      } as unknown as PreFlightInterceptor;

      const outcome = await adapter.run(
        SCENARIOS[0]!,
        {},
        {
          interceptor: signalAware,
          signal: controller.signal,
        },
      );
      assert.equal(outcome.entered, 0, "an aborted pre-flight check still executed the handler");
      assert.equal(outcome.halted, true);
    });
  }

  it("MCP: the host invocation signal from `extra` takes precedence", async () => {
    const host = new AbortController();
    const configured = new AbortController();
    const { seen, interceptor } = capturing(ADMISSIBLE);
    const mcp = HARNESSES.find((candidate) => candidate.name === "mcp")!;
    await mcp.run(
      SCENARIOS[0]!,
      {},
      {
        interceptor,
        signal: configured.signal,
        hostSignal: host.signal,
      },
    );
    assert.equal(seen[0]!.signal, host.signal);
  });

  it("every adapter resolves the shared default timeout", async () => {
    for (const adapter of HARNESSES) {
      const { seen, interceptor } = capturing(ADMISSIBLE);
      await adapter.run(SCENARIOS[0]!, {}, { interceptor });
      assert.equal(seen.length, 1);
      assert.equal(
        seen[0]!.timeoutMs,
        DEFAULT_ADAPTER_TIMEOUT_MS,
        `${adapter.name} did not resolve the shared default timeout`,
      );
    }
    assert.equal(DEFAULT_ADAPTER_TIMEOUT_MS, DEFAULT_RPC_TIMEOUT_MS);
    assert.equal(DEFAULT_ADAPTER_TIMEOUT_MS, 30_000);
  });

  it("every adapter forwards timeoutMs: 0 as an opt-out, not as omission", async () => {
    for (const adapter of HARNESSES) {
      const { seen, interceptor } = capturing(ADMISSIBLE);
      await adapter.run(SCENARIOS[0]!, {}, { interceptor, timeoutMs: 0 });
      assert.equal(seen[0]!.timeoutMs, 0, `${adapter.name} dropped the opt-out`);
    }
  });

  it("LangChain: a request signal and a RunnableConfig signal are merged", async () => {
    const langchain = HARNESSES.find((candidate) => candidate.name === "langchain")!;

    for (const which of ["request", "config", "adapter"] as const) {
      const host = new AbortController();
      const config = new AbortController();
      const configured = new AbortController();
      const { seen, interceptor } = capturing(ADMISSIBLE);
      await langchain.run(
        SCENARIOS[0]!,
        {},
        {
          interceptor,
          signal: configured.signal,
          hostSignal: host.signal,
          configSignal: config.signal,
        },
      );
      const merged = seen[0]!.signal;
      assert.ok(merged, "the adapter dropped every signal");
      assert.equal(merged!.aborted, false);

      // Either input alone must abort the merged bound.
      if (which === "request") host.abort();
      else if (which === "config") config.abort();
      else configured.abort();
      assert.equal(merged!.aborted, true, `the ${which} signal was not propagated`);
    }
  });

  it("LangChain: an already-aborted RunnableConfig signal halts without an RPC", async () => {
    const config = new AbortController();
    config.abort();
    const signalAware = {
      check: async (_call: ContractCall, options?: PreFlightCheckOptions) =>
        options?.signal?.aborted ? UNDETERMINED : ADMISSIBLE,
    } as unknown as PreFlightInterceptor;
    const langchain = HARNESSES.find((candidate) => candidate.name === "langchain")!;
    const outcome = await langchain.run(
      SCENARIOS[0]!,
      {},
      { interceptor: signalAware, configSignal: config.signal },
    );
    assert.equal(outcome.entered, 0);
    assert.equal(outcome.halted, true);
  });

  it("LangChain: cancelling the chain stops an in-flight check", async () => {
    const config = new AbortController();
    let started = 0;
    const interceptor = {
      check: (_call: ContractCall, options?: PreFlightCheckOptions) => {
        started += 1;
        const signal = options?.signal;
        if (!signal) return Promise.resolve(ADMISSIBLE);
        if (signal.aborted) return Promise.resolve(UNDETERMINED);
        return new Promise<PreFlightDecision>((resolve) => {
          signal.addEventListener("abort", () => resolve(UNDETERMINED), { once: true });
        });
      },
    } as unknown as PreFlightInterceptor;
    const langchain = HARNESSES.find((candidate) => candidate.name === "langchain")!;
    const pending = langchain.run(SCENARIOS[0]!, {}, { interceptor, configSignal: config.signal });
    setTimeout(() => config.abort(), 1);
    const outcome = await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("cancelling the chain did not stop the check")), 200),
      ),
    ]);
    assert.equal(started, 1);
    assert.equal(outcome.entered, 0);
    assert.equal(outcome.halted, true);
  });

  it("rejects a malformed signal or timeout at construction time", async () => {
    const { createLangChainGuardMiddleware: create } = await import(
      "../../src/adapters/langchain.ts"
    );
    assert.throws(
      () =>
        create({
          interceptor: stub(ADMISSIBLE),
          toContractCall: () => null,
          signal: { aborted: "no" } as unknown as AbortSignal,
        }),
      /signal/,
    );
    assert.throws(
      () =>
        create({
          interceptor: stub(ADMISSIBLE),
          toContractCall: () => null,
          timeoutMs: -1,
        }),
      /timeoutMs/,
    );
  });
});

/**
 * Correlation ids (issue #459).
 *
 * One caller-supplied id must reach every hook for one action on every adapter,
 * stay absent when none was supplied, and never be invented from request
 * content.
 */
describe("adapter correlation ids (issue #459)", () => {
  const CORRELATION_ID = "run-42";

  function capture(): {
    observer: Observer;
    blocked: GuardBlockedInfo[];
    mappingErrors: GuardMappingErrorInfo[];
    contexts: GuardHookContext[];
  } {
    const blocked: GuardBlockedInfo[] = [];
    const mappingErrors: GuardMappingErrorInfo[] = [];
    const contexts: GuardHookContext[] = [];
    return {
      observer: {
        onBlocked: (info) => {
          blocked.push(info);
        },
        onMappingError: (info) => {
          mappingErrors.push(info);
        },
        onDecision: (...args) => {
          contexts.push(args.at(-1) as GuardHookContext);
        },
      },
      blocked,
      mappingErrors,
      contexts,
    };
  }

  for (const adapter of HARNESSES) {
    it(`${adapter.name}: carries the same id to every hook for one action`, async () => {
      const { observer, blocked, contexts } = capture();
      const outcome = await adapter.run(SCENARIOS[1]!, observer, {
        correlationId: CORRELATION_ID,
      });

      assert.equal(outcome.entered, 0);
      assert.equal(contexts.length, 1);
      assert.equal(contexts[0]!.correlationId, CORRELATION_ID);
      if (adapter.hasBlockedHook) {
        assert.equal(blocked.length, 1);
        assert.equal(blocked[0]!.correlationId, CORRELATION_ID);
      }
    });

    it(`${adapter.name}: leaves the id absent when none is supplied`, async () => {
      const { observer, blocked, contexts } = capture();
      await adapter.run(SCENARIOS[1]!, observer);

      assert.equal(contexts.length, 1);
      assert.equal(contexts[0]!.correlationId, undefined);
      assert.equal("correlationId" in contexts[0]!, false, "an absent id must be omitted");
      if (adapter.hasBlockedHook) {
        assert.equal(blocked[0]!.correlationId, undefined);
        assert.equal("correlationId" in blocked[0]!, false, "an absent id must be omitted");
      }
    });

    it(`${adapter.name}: treats a blank id as absent`, async () => {
      const { observer, contexts } = capture();
      await adapter.run(SCENARIOS[1]!, observer, { correlationId: "   " });

      assert.equal(contexts[0]!.correlationId, undefined);
      assert.equal("correlationId" in contexts[0]!, false);
    });

    if (adapter.hasBlockedHook) {
      it(`${adapter.name}: a mapping failure carries the same id`, async () => {
        const { observer, blocked, mappingErrors } = capture();
        await adapter.run(
          SCENARIOS.find((scenario) => scenario.name === "mapping throws")!,
          observer,
          { correlationId: CORRELATION_ID },
        );

        assert.equal(mappingErrors.length, 1);
        assert.equal(mappingErrors[0]!.correlationId, CORRELATION_ID);
        assert.equal(blocked.length, 1);
        assert.equal(blocked[0]!.kind, "undetermined");
        assert.equal(blocked[0]!.correlationId, CORRELATION_ID);
      });
    }
  }

  it("maps the id from the request only when the host asks", async () => {
    const blocked: GuardBlockedInfo[] = [];
    const middleware = createLangChainGuardMiddleware({
      interceptor: stub(BLOCKED),
      toContractCall: () => CALL,
      correlationId: (request: LangChainToolCallRequest) => request.toolCall.id,
      onBlocked: (info) => blocked.push(info),
    });

    await middleware.wrapToolCall(
      { toolCall: { name: "send_payment", id: "call-9", args: {} } },
      async () => ({ content: "sent" }),
    );

    assert.equal(blocked[0]!.correlationId, "call-9");
  });

  it("never invents an id from request ids, addresses or tool arguments", async () => {
    const blocked: GuardBlockedInfo[] = [];
    const middleware = createLangChainGuardMiddleware({
      interceptor: stub(BLOCKED),
      toContractCall: () => CALL,
      onBlocked: (info) => blocked.push(info),
    });

    await middleware.wrapToolCall(
      {
        toolCall: {
          name: "send_payment",
          id: "call-9",
          args: { to: GUARD, amount: 5 },
        },
      },
      async () => ({ content: "sent" }),
    );

    assert.equal("correlationId" in blocked[0]!, false);
  });
});

describe("framework-specific refusal shapes stay distinct (issue #317)", () => {
  it("LangChain returns a ToolMessage with status error", async () => {
    const langchain = HARNESSES.find((candidate) => candidate.name === "langchain")!;
    const outcome = await langchain.run(SCENARIOS[1]!, {});
    assert.match(outcome.refusal, /per_tx_cap_exceeded/);
    assert.match(outcome.refusal, /No transaction was submitted/);
  });

  it("ElizaOS returns false and reports the reason through onBlocked", async () => {
    const elizaos = HARNESSES.find((candidate) => candidate.name === "elizaos")!;
    const { observer, blocked } = observing();
    const outcome = await elizaos.run(SCENARIOS[1]!, observer);
    assert.equal(outcome.halted, true);
    assert.equal(blocked[0]!.reason, "per_tx_cap_exceeded");
  });

  it("MCP returns an isError result naming the reason", async () => {
    const result = (await guardMcpToolHandler("send_payment", async () => ({ content: [] }), {
      interceptor: stub(BLOCKED),
      toContractCall: () => CALL,
    })({}, undefined)) as { isError?: boolean; content: Array<{ text?: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text!, /per_tx_cap_exceeded/);
  });

  it("Vercel AI throws the typed guard error for a blocked verdict", async () => {
    const vercelai = HARNESSES.find((candidate) => candidate.name === "vercelai")!;
    const outcome = await vercelai.run(SCENARIOS[1]!, {});
    assert.match(outcome.refusal, /stellar-agent-guard blocked/);
    await assert.rejects(
      async () => {
        const tool = wrapToolWithGuard(
          { execute: async () => "sent" },
          { interceptor: stub(BLOCKED), toContractCall: () => CALL },
          { toolName: "send_payment", input: {} },
        );
        await tool.execute!();
      },
      (error: unknown) => error instanceof GuardBlockedError,
    );
    await assert.rejects(
      async () => {
        const tool = wrapToolWithGuard(
          { execute: async () => "sent" },
          { interceptor: stub(UNDETERMINED), toContractCall: () => CALL },
          { toolName: "send_payment", input: {} },
        );
        await tool.execute!();
      },
      (error: unknown) =>
        error instanceof GuardUndeterminedError && error instanceof PreFlightUndeterminedError,
    );
  });
});

describe("simultaneous guarded tool calls concurrency (issue #502)", () => {
  interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
  }

  function defer<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("handles ten simultaneous distinct calls through one adapter without cross-talk or cancellation leakage", async () => {
    // 10 distinct calls:
    // 0..3: admissible
    // 4..6: blocked (distinct reasons)
    // 7..8: undetermined (distinct details)
    // 9: cancelled via AbortSignal
    const totalCalls = 10;
    const deferreds: Deferred<PreFlightDecision>[] = Array.from({ length: totalCalls }, () =>
      defer<PreFlightDecision>(),
    );

    const callsSeenInCheck: ContractCall[] = [];
    const fakeInterceptor: PreFlightInterceptor = {
      check: async (call: ContractCall, options?: PreFlightCheckOptions) => {
        callsSeenInCheck.push(call);
        const index = Number(call.fn.replace("call_", ""));
        const d = deferreds[index]!;

        if (options?.signal?.aborted) {
          return { allowed: false, kind: "undetermined", detail: "aborted before check" };
        }

        if (options?.signal) {
          options.signal.addEventListener("abort", () => {
            d.resolve({ allowed: false, kind: "undetermined", detail: "cancelled in-flight" });
          });
        }

        return d.promise;
      },
    } as unknown as PreFlightInterceptor;

    const decisionsRecorded: Array<{ request: unknown; decision: PreFlightDecision }> = [];
    const blockedRecorded: GuardBlockedInfo[] = [];
    const handlersEntered: number[] = new Array(totalCalls).fill(0);

    const middleware = createLangChainGuardMiddleware({
      interceptor: fakeInterceptor,
      toContractCall: (req) => ({
        contract: GUARD,
        fn: req.toolCall.name,
        args: [],
      }),
      onDecision: (request, decision) => {
        decisionsRecorded.push({ request, decision });
      },
      onBlocked: (info) => {
        blockedRecorded.push(info);
      },
    });

    const controller9 = new AbortController();

    // Launch all 10 calls simultaneously
    const callPromises = Array.from({ length: totalCalls }, (_, i) => {
      const request = {
        toolCall: { name: `call_${i}`, id: `id_${i}`, args: { index: i } },
        ...(i === 9 ? { signal: controller9.signal } : {}),
      };
      return middleware.wrapToolCall(request, async () => {
        handlersEntered[i] = (handlersEntered[i] ?? 0) + 1;
        return { content: `executed_${i}` };
      });
    });

    // Verify all 10 reached the fake interceptor
    assert.equal(callsSeenInCheck.length, 10);
    // None has completed yet
    assert.deepEqual(handlersEntered, new Array(10).fill(0));

    // Cancel call 9 while in flight
    controller9.abort();

    // Controllable resolution with distinct verdicts in arbitrary order (reverse order)
    // 7, 8: undetermined
    deferreds[8]!.resolve({ allowed: false, kind: "undetermined", detail: "rpc error 8" });
    deferreds[7]!.resolve({ allowed: false, kind: "undetermined", detail: "rpc error 7" });

    // 4, 5, 6: blocked
    deferreds[6]!.resolve({
      allowed: false,
      kind: "blocked",
      reason: "paused",
      explanation: explainReason("paused"),
      detail: "guard paused",
      diagnosticEvents: [],
    });
    deferreds[5]!.resolve({
      allowed: false,
      kind: "blocked",
      reason: "blocked_recipient",
      explanation: explainReason("blocked_recipient"),
      detail: "recipient blocked",
      diagnosticEvents: [],
    });
    deferreds[4]!.resolve({
      allowed: false,
      kind: "blocked",
      reason: "per_tx_cap_exceeded",
      explanation: explainReason("per_tx_cap_exceeded"),
      detail: "cap exceeded",
      diagnosticEvents: [],
    });

    // 0..3: admissible
    deferreds[3]!.resolve(ADMISSIBLE);
    deferreds[2]!.resolve(ADMISSIBLE);
    deferreds[1]!.resolve(ADMISSIBLE);
    deferreds[0]!.resolve(ADMISSIBLE);

    // Wait for all 10 calls to finish
    const results = await Promise.all(callPromises);

    // 1. Assert each handler ran or halted correctly
    // Only 0..3 were admissible -> entered === 1; all others -> entered === 0
    assert.deepEqual(handlersEntered, [1, 1, 1, 1, 0, 0, 0, 0, 0, 0]);

    // 2. Results match their own calls
    for (let i = 0; i < 4; i++) {
      const res = results[i] as { content: string };
      assert.equal(res.content, `executed_${i}`);
    }
    for (let i = 4; i < 10; i++) {
      const res = results[i] as { status: string; content: string };
      assert.equal(res.status, "error");
    }

    // 3. Hook counts match the calls
    // onDecision fires for every call (10 calls)
    assert.equal(decisionsRecorded.length, 10);
    // onBlocked fires only for non-admissible calls (calls 4, 5, 6, 7, 8, 9 = 6 calls)
    assert.equal(blockedRecorded.length, 6);

    // 4. Assert NO cross-talk in onDecision
    for (const rec of decisionsRecorded) {
      const req = rec.request as { toolCall: { name: string; args: { index: number } } };
      const idx = req.toolCall.args.index;
      if (idx < 4) {
        assert.equal(rec.decision.kind, "admissible");
      } else if (idx === 4) {
        assert.equal(rec.decision.kind, "blocked");
        assert.equal((rec.decision as { reason?: string }).reason, "per_tx_cap_exceeded");
      } else if (idx === 5) {
        assert.equal(rec.decision.kind, "blocked");
        assert.equal((rec.decision as { reason?: string }).reason, "blocked_recipient");
      } else if (idx === 6) {
        assert.equal(rec.decision.kind, "blocked");
        assert.equal((rec.decision as { reason?: string }).reason, "paused");
      } else if (idx === 7) {
        assert.equal(rec.decision.kind, "undetermined");
        assert.equal(rec.decision.detail, "rpc error 7");
      } else if (idx === 8) {
        assert.equal(rec.decision.kind, "undetermined");
        assert.equal(rec.decision.detail, "rpc error 8");
      } else if (idx === 9) {
        assert.equal(rec.decision.kind, "undetermined");
        assert.match(rec.decision.detail, /cancelled/);
      }
    }

    // 5. Assert NO cross-talk in onBlocked
    const blockedMap = new Map(blockedRecorded.map((info) => [info.call?.fn, info]));
    assert.equal(blockedMap.size, 6);

    const info4 = blockedMap.get("call_4")!;
    assert.equal(info4.kind, "blocked");
    assert.equal(info4.reason, "per_tx_cap_exceeded");
    assert.equal(info4.call?.fn, "call_4");

    const info5 = blockedMap.get("call_5")!;
    assert.equal(info5.kind, "blocked");
    assert.equal(info5.reason, "blocked_recipient");

    const info6 = blockedMap.get("call_6")!;
    assert.equal(info6.kind, "blocked");
    assert.equal(info6.reason, "paused");

    const info7 = blockedMap.get("call_7")!;
    assert.equal(info7.kind, "undetermined");
    assert.equal(info7.reason, null);
    assert.match(info7.explanation, /rpc error 7/);

    const info8 = blockedMap.get("call_8")!;
    assert.equal(info8.kind, "undetermined");
    assert.equal(info8.reason, null);
    assert.match(info8.explanation, /rpc error 8/);

    const info9 = blockedMap.get("call_9")!;
    assert.equal(info9.kind, "undetermined");
    assert.equal(info9.reason, null);
    assert.match(info9.explanation, /cancelled/);

    // 6. Cancellation isolation: call 9 was cancelled without cancelling calls 0..8
    assert.equal(handlersEntered[9], 0);
    assert.deepEqual(handlersEntered.slice(0, 4), [1, 1, 1, 1]);
  });
});

describe("onBatchDecision summary callback parity (issue #498)", () => {
  const CALL_A: ContractCall = { contract: GUARD, fn: "transfer_a", args: [] };
  const CALL_B: ContractCall = { contract: GUARD, fn: "transfer_b", args: [] };
  const BATCH_CALLS = [CALL_A, CALL_B];

  function makeBatchInterceptor(verdicts: PreFlightDecision[]): PreFlightInterceptor {
    const admissible = verdicts.every((v) => v.allowed);
    return {
      check: async () => verdicts[0]!,
      checkBatch: async () => ({
        admissible,
        overallAdmissible: admissible,
        verdicts,
        calls: verdicts,
        totalEstimatedResourceFee: 100n,
      }),
    } as unknown as PreFlightInterceptor;
  }

  const ADAPTERS_WITH_BATCH: Array<{
    name: GuardAdapterName;
    runBatch: (
      interceptor: PreFlightInterceptor,
      onBatchDecision?: (info: GuardBatchDecisionInfo) => unknown,
      onDecision?: () => void,
    ) => Promise<boolean>;
    runSingle: (
      interceptor: PreFlightInterceptor,
      onBatchDecision?: (info: GuardBatchDecisionInfo) => unknown,
    ) => Promise<boolean>;
  }> = [
    {
      name: "langchain",
      runBatch: async (interceptor, onBatchDecision, onDecision) => {
        let entered = false;
        const middleware = createLangChainGuardMiddleware({
          interceptor,
          toContractCalls: () => BATCH_CALLS,
          ...(onBatchDecision
            ? { onBatchDecision: onBatchDecision as (info: GuardBatchDecisionInfo) => void }
            : {}),
          ...(onDecision ? { onDecision: onDecision as () => void } : {}),
        });
        const res = await middleware.wrapToolCall(
          { toolCall: { name: "batch_tool", id: "batch_id", args: {} } },
          async () => {
            entered = true;
            return { content: "ok" };
          },
        );
        return entered && !("status" in res && res.status === "error");
      },
      runSingle: async (interceptor, onBatchDecision) => {
        let entered = false;
        const middleware = createLangChainGuardMiddleware({
          interceptor,
          toContractCall: () => CALL_A,
          ...(onBatchDecision
            ? { onBatchDecision: onBatchDecision as (info: GuardBatchDecisionInfo) => void }
            : {}),
        });
        const res = await middleware.wrapToolCall(
          { toolCall: { name: "single_tool", id: "single_id", args: {} } },
          async () => {
            entered = true;
            return { content: "ok" };
          },
        );
        return entered && !("status" in res && res.status === "error");
      },
    },
    {
      name: "mcp",
      runBatch: async (interceptor, onBatchDecision, onDecision) => {
        let entered = false;
        const handler = guardMcpToolHandler(
          "batch_tool",
          async () => {
            entered = true;
            return { content: [{ type: "text", text: "ok" }] };
          },
          {
            interceptor,
            toContractCalls: () => BATCH_CALLS,
            ...(onBatchDecision
              ? { onBatchDecision: onBatchDecision as (info: GuardBatchDecisionInfo) => void }
              : {}),
            ...(onDecision ? { onDecision: onDecision as () => void } : {}),
          },
        );
        const res = await handler({});
        return entered && !((res as { isError?: boolean }).isError === true);
      },
      runSingle: async (interceptor, onBatchDecision) => {
        let entered = false;
        const handler = guardMcpToolHandler(
          "single_tool",
          async () => {
            entered = true;
            return { content: [{ type: "text", text: "ok" }] };
          },
          {
            interceptor,
            toContractCall: () => CALL_A,
            ...(onBatchDecision
              ? { onBatchDecision: onBatchDecision as (info: GuardBatchDecisionInfo) => void }
              : {}),
          },
        );
        const res = await handler({});
        return entered && !((res as { isError?: boolean }).isError === true);
      },
    },
    {
      name: "vercelai",
      runBatch: async (interceptor, onBatchDecision, onDecision) => {
        let entered = false;
        const tool = wrapToolWithGuard(
          {
            execute: async () => {
              entered = true;
              return "ok";
            },
          },
          {
            interceptor,
            toContractCalls: () => BATCH_CALLS,
            ...(onBatchDecision
              ? { onBatchDecision: onBatchDecision as (info: GuardBatchDecisionInfo) => void }
              : {}),
            ...(onDecision ? { onDecision: onDecision as () => void } : {}),
          },
          { toolName: "batch_tool", input: {} },
        );
        try {
          await tool.execute!();
          return entered;
        } catch {
          return false;
        }
      },
      runSingle: async (interceptor, onBatchDecision) => {
        let entered = false;
        const tool = wrapToolWithGuard(
          {
            execute: async () => {
              entered = true;
              return "ok";
            },
          },
          {
            interceptor,
            toContractCall: () => CALL_A,
            ...(onBatchDecision
              ? { onBatchDecision: onBatchDecision as (info: GuardBatchDecisionInfo) => void }
              : {}),
          },
          { toolName: "single_tool", input: {} },
        );
        try {
          await tool.execute!();
          return entered;
        } catch {
          return false;
        }
      },
    },
    {
      name: "elizaos",
      runBatch: async (interceptor, onBatchDecision, onDecision) => {
        const validate = createGuardValidator({
          interceptor,
          toContractCalls: () => BATCH_CALLS,
          ...(onBatchDecision
            ? { onBatchDecision: onBatchDecision as (info: GuardBatchDecisionInfo) => void }
            : {}),
          ...(onDecision ? { onDecision: onDecision as () => void } : {}),
        });
        return validate({}, {}, {});
      },
      runSingle: async (interceptor, onBatchDecision) => {
        const validate = createGuardValidator({
          interceptor,
          toContractCall: () => CALL_A,
          ...(onBatchDecision
            ? { onBatchDecision: onBatchDecision as (info: GuardBatchDecisionInfo) => void }
            : {}),
        });
        return validate({}, {}, {});
      },
    },
  ];

  for (const adapter of ADAPTERS_WITH_BATCH) {
    describe(adapter.name, () => {
      it("fires onBatchDecision exactly once for an admissible batch", async () => {
        const summaries: GuardBatchDecisionInfo[] = [];
        let decisions = 0;
        const interceptor = makeBatchInterceptor([ADMISSIBLE, ADMISSIBLE]);

        const allowed = await adapter.runBatch(
          interceptor,
          (info) => summaries.push(info),
          () => {
            decisions += 1;
          },
        );

        assert.equal(allowed, true);
        assert.equal(summaries.length, 1, "exactly one summary per batch");
        assert.equal(decisions, 2, "onDecision still fires per call");
        assert.equal(summaries[0]!.adapter, adapter.name);
        assert.equal(summaries[0]!.kind, "admissible");
        assert.equal(summaries[0]!.calls.length, 2);
        assert.equal(summaries[0]!.verdicts.length, 2);
        if (adapter.name === "langchain") {
          assert.equal(summaries[0]!.correlationId, "batch_id");
        }
      });

      it("fires onBatchDecision with kind blocked when any call in the batch is blocked", async () => {
        const summaries: GuardBatchDecisionInfo[] = [];
        const interceptor = makeBatchInterceptor([ADMISSIBLE, BLOCKED]);

        const allowed = await adapter.runBatch(interceptor, (info) => summaries.push(info));

        assert.equal(allowed, false);
        assert.equal(summaries.length, 1);
        assert.equal(summaries[0]!.kind, "blocked");
      });

      it("fires onBatchDecision with kind undetermined when batch check is undetermined", async () => {
        const summaries: GuardBatchDecisionInfo[] = [];
        const interceptor = makeBatchInterceptor([ADMISSIBLE, UNDETERMINED]);

        const allowed = await adapter.runBatch(interceptor, (info) => summaries.push(info));

        assert.equal(allowed, false);
        assert.equal(summaries.length, 1);
        assert.equal(summaries[0]!.kind, "undetermined");
      });

      it("a single-call mapping does not fire onBatchDecision", async () => {
        const summaries: GuardBatchDecisionInfo[] = [];
        const interceptor = makeBatchInterceptor([ADMISSIBLE]);

        await adapter.runSingle(interceptor, (info) => summaries.push(info));

        assert.equal(summaries.length, 0, "single-call must not fire onBatchDecision");
      });

      it("a throwing onBatchDecision callback cannot change the verdict", async () => {
        const interceptor = makeBatchInterceptor([ADMISSIBLE, ADMISSIBLE]);

        const allowed = await adapter.runBatch(interceptor, () => {
          throw new Error("hook exploded");
        });

        assert.equal(allowed, true, "handler still ran despite throwing callback");
      });

      it("a rejecting async onBatchDecision callback cannot change the verdict", async () => {
        const interceptor = makeBatchInterceptor([ADMISSIBLE, ADMISSIBLE]);

        const allowed = await adapter.runBatch(interceptor, async () => {
          throw new Error("async hook rejected");
        });

        assert.equal(allowed, true, "handler still ran despite rejecting callback");
      });
    });
  }
});
