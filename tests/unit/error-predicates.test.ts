import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BroadcastError,
  GuardUndeterminedError,
  SigningError,
  SimulationError,
} from "../../src/errors.ts";
import {
  ERROR_CLASSIFIERS,
  classifyKnownError,
  errorDisposition,
  isFailClosed,
  isRetryable,
  type KnownErrorClass,
} from "../../src/error-predicates.ts";
import { HeartbeatBlockedError } from "../../src/heartbeat.ts";
import * as sdk from "../../src/index.ts";
import { InvokeRetryError, RpcTimeoutError } from "../../src/invoke.ts";
import { GuardBlockedError } from "../../src/reasons.ts";
import { ConcurrentTelemetryStreamError } from "../../src/telemetry.ts";

type ErrorCtor = { prototype: object };

const ERROR_CONSTRUCTORS: Record<KnownErrorClass, ErrorCtor> = {
  AdapterConfigError: sdk.AdapterConfigError,
  AdapterMappingError: sdk.AdapterMappingError,
  BroadcastError: sdk.BroadcastError,
  ConcurrentTelemetryStreamError,
  ContractResponseError: sdk.ContractResponseError,
  FeeCapExceededError: sdk.FeeCapExceededError,
  GuardBlockedError: sdk.GuardBlockedError,
  GuardError: sdk.GuardError,
  GuardUndeterminedError: sdk.GuardUndeterminedError,
  HeartbeatBlockedError: sdk.HeartbeatBlockedError,
  HeartbeatDryRunError: sdk.HeartbeatDryRunError,
  HeartbeatIntervalError: sdk.HeartbeatIntervalError,
  InvokeRetryError: sdk.InvokeRetryError,
  InvalidFeeCeilingError: sdk.InvalidFeeCeilingError,
  InvalidInputError: sdk.InvalidInputError,
  PolicyDecodeError: sdk.PolicyDecodeError,
  PolicyEncodeError: sdk.PolicyEncodeError,
  PolicyFileReadError: sdk.PolicyFileReadError,
  PolicyValidationError: sdk.PolicyValidationError,
  RateLimitedError: sdk.RateLimitedError,
  RpcTimeoutError: sdk.RpcTimeoutError,
  SigningError: sdk.SigningError,
  SimulationError: sdk.SimulationError,
};

const EXPECTED: Record<KnownErrorClass, { failClosed: boolean; retryable: boolean }> = {
  AdapterConfigError: { failClosed: false, retryable: false },
  AdapterMappingError: { failClosed: false, retryable: false },
  BroadcastError: { failClosed: false, retryable: false },
  ConcurrentTelemetryStreamError: { failClosed: false, retryable: false },
  ContractResponseError: { failClosed: false, retryable: false },
  FeeCapExceededError: { failClosed: false, retryable: false },
  GuardBlockedError: { failClosed: false, retryable: false },
  GuardError: { failClosed: false, retryable: false },
  GuardUndeterminedError: { failClosed: true, retryable: false },
  HeartbeatBlockedError: { failClosed: false, retryable: false },
  HeartbeatDryRunError: { failClosed: false, retryable: false },
  HeartbeatIntervalError: { failClosed: false, retryable: false },
  InvokeRetryError: { failClosed: false, retryable: false },
  InvalidFeeCeilingError: { failClosed: false, retryable: false },
  InvalidInputError: { failClosed: false, retryable: false },
  PolicyDecodeError: { failClosed: false, retryable: false },
  PolicyEncodeError: { failClosed: false, retryable: false },
  PolicyFileReadError: { failClosed: false, retryable: false },
  PolicyValidationError: { failClosed: false, retryable: false },
  RateLimitedError: { failClosed: false, retryable: true },
  RpcTimeoutError: { failClosed: false, retryable: false },
  SigningError: { failClosed: false, retryable: false },
  SimulationError: { failClosed: false, retryable: false },
};

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

const srcDir = fileURLToPath(new URL("../../src", import.meta.url));
const declaredErrorClasses = sourceFiles(srcDir)
  .flatMap((path) => [...readFileSync(path, "utf8").matchAll(/^export class (\w+Error)\b/gm)])
  .map((match) => match[1]!);

describe("error classification registry", () => {
  it("classifies every exported error class declared in src", () => {
    assert.ok(declaredErrorClasses.length > 15);
    const classified = Object.keys(ERROR_CLASSIFIERS).sort();
    assert.deepEqual(
      [...new Set(declaredErrorClasses)].sort(),
      classified,
      "add the new class to ERROR_CLASSIFIERS and the exhaustive switches in error-predicates.ts",
    );
  });

  it("classifies every error constructor exported from the package root", () => {
    const exports = sdk as unknown as Record<string, unknown>;
    const rootErrors = Object.entries(exports).filter(
      ([, value]) =>
        typeof value === "function" &&
        (value as { prototype?: unknown }).prototype instanceof Error,
    );
    assert.ok(rootErrors.length > 15);
    for (const [name, value] of rootErrors) {
      const instance = Object.create((value as ErrorCtor).prototype);
      assert.notEqual(
        classifyKnownError(instance),
        undefined,
        `${name} is exported but has no classifier`,
      );
    }
  });

  it("gives every registered class an explicit disposition", () => {
    for (const name of Object.keys(ERROR_CLASSIFIERS) as KnownErrorClass[]) {
      assert.doesNotThrow(() => errorDisposition(name));
      const instance = Object.create(ERROR_CONSTRUCTORS[name].prototype);
      assert.equal(classifyKnownError(instance), name);
      assert.equal(ERROR_CLASSIFIERS[name](instance), true);
    }
  });

  it("classifies the most specific subclass first", () => {
    assert.equal(
      classifyKnownError(Object.create(sdk.RateLimitedError.prototype)),
      "RateLimitedError",
    );
    assert.equal(
      classifyKnownError(Object.create(sdk.PolicyEncodeError.prototype)),
      "PolicyEncodeError",
    );
    assert.equal(
      classifyKnownError(Object.create(sdk.GuardUndeterminedError.prototype)),
      "GuardUndeterminedError",
    );
  });
});

describe("isRetryable", () => {
  it("returns the explicit disposition for every exported class", () => {
    for (const name of Object.keys(ERROR_CLASSIFIERS) as KnownErrorClass[]) {
      const error = Object.create(ERROR_CONSTRUCTORS[name].prototype);
      assert.equal(isRetryable(error), EXPECTED[name].retryable, name);
    }
  });

  it("recognises the documented retryable invoke classes from metadata", () => {
    const stale = new InvokeRetryError({
      attempts: 2,
      lastOutcome: {
        kind: "error",
        detail: "stale",
        error: new SimulationError("stale", { stage: "simulate" }),
        diagnosticEvents: [],
        retryable: "stale_ledger_resource_limit",
      },
    });
    assert.equal(isRetryable(stale), true);

    const minFee = new BroadcastError({
      attempts: 1,
      lastFee: 100n,
      failure: {
        resultXdr: null,
        resultCode: "txInsufficientFee",
        message: "fee",
        diagnosticEvents: [],
      },
      retry: {
        attempts: 1,
        maxAttempts: 1,
        retried: false,
        exhausted: true,
        totalDelayMs: 0,
        retries: [],
        terminalFailure: "min_fee",
        terminalCause: "undetermined",
        outcome: "error",
      },
    });
    assert.equal(isRetryable(minFee), true);
    assert.equal(isRetryable({ retryable: "sequence_number_collision" }), true);
    assert.equal(isRetryable({ retry: { terminalFailure: "stale_ledger_resource_limit" } }), true);
    assert.equal(isRetryable({ retryable: "not_a_retryable_class" }), false);
    assert.equal(isRetryable(Object.create(sdk.BroadcastError.prototype)), false);
  });

  it("never throws for hostile inputs", () => {
    const throwing = Object.defineProperty({}, "retryable", {
      get(): never {
        throw new Error("getter");
      },
    });
    const inputs: unknown[] = [
      null,
      undefined,
      1,
      "error",
      Symbol("error"),
      () => undefined,
      {},
      throwing,
      new Proxy(
        {},
        {
          get(): never {
            throw new Error("proxy");
          },
        },
      ),
    ];
    for (const input of inputs) {
      assert.doesNotThrow(() => isRetryable(input));
      assert.equal(isRetryable(input), false);
    }
  });
});

describe("isFailClosed", () => {
  it("returns the explicit disposition for every exported class", () => {
    for (const name of Object.keys(ERROR_CLASSIFIERS) as KnownErrorClass[]) {
      const error = Object.create(ERROR_CONSTRUCTORS[name].prototype);
      assert.equal(isFailClosed(error), EXPECTED[name].failClosed, name);
    }
  });

  it("is true for undetermined errors and wrapped transport failures", () => {
    const timeout = new RpcTimeoutError({ stage: "pre-flight", aborted: false, timeoutMs: 30 });
    assert.equal(isFailClosed(new GuardUndeterminedError("down", { cause: timeout })), true);
    assert.equal(isFailClosed(new SigningError("sign", { cause: timeout })), true);
    assert.equal(
      isFailClosed({ cause: { cause: new SimulationError("sim", { stage: "probe" }) } }),
      true,
    );
  });

  it("is false for policy blocks even when they wrap a transport failure", () => {
    const timeout = new RpcTimeoutError({ stage: "pre-flight", aborted: false, timeoutMs: 30 });
    assert.equal(
      isFailClosed(new GuardBlockedError({ reason: "paused", stage: "preflight" })),
      false,
    );
    assert.equal(isFailClosed(new HeartbeatBlockedError({ reason: "paused" })), false);
    const blockedWithCause = new GuardBlockedError({ reason: "paused", stage: "preflight" });
    Object.defineProperty(blockedWithCause, "cause", { value: timeout });
    assert.equal(isFailClosed(blockedWithCause), false);
  });

  it("never throws for hostile or cyclic inputs", () => {
    const first: Record<string, unknown> = {};
    const second: Record<string, unknown> = { cause: first };
    first["cause"] = second;
    const throwing = Object.defineProperty({}, "cause", {
      get(): never {
        throw new Error("getter");
      },
    });
    const inputs: unknown[] = [
      null,
      undefined,
      1,
      "error",
      Symbol("error"),
      () => undefined,
      first,
      throwing,
      new Proxy(
        {},
        {
          get(): never {
            throw new Error("proxy");
          },
        },
      ),
    ];
    for (const input of inputs) {
      assert.doesNotThrow(() => isFailClosed(input));
      assert.equal(isFailClosed(input), false);
    }
  });
});

describe("advisory predicates", () => {
  it("agree with errorDisposition without replacing outcome kind", () => {
    assert.equal(errorDisposition("RateLimitedError"), "retryable_rate_limit");
    assert.equal(errorDisposition("GuardUndeterminedError"), "fail_closed");
    assert.equal(errorDisposition("GuardBlockedError"), "blocked");
    assert.equal(errorDisposition("SimulationError"), "transport");
  });
});
