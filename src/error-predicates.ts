import {
  AdapterConfigError,
  AdapterMappingError,
  AuthRefreshError,
  BroadcastError,
  ContractResponseError,
  FeeCapExceededError,
  GuardError,
  GuardUndeterminedError,
  InvalidFeeCeilingError,
  InvalidInputError,
  PolicyDecodeError,
  PolicyEncodeError,
  PolicyFileReadError,
  PolicyValidationError,
  RateLimitedError,
  SignerTimeoutError,
  SigningError,
  SimulationError,
} from "./errors.ts";
import {
  HeartbeatBlockedError,
  HeartbeatDryRunError,
  HeartbeatIntervalError,
} from "./heartbeat.ts";
import { InvokeRetryError, RpcTimeoutError } from "./invoke.ts";
import { GuardBlockedError } from "./reasons.ts";
import type { RetryableInvokeFailure } from "./retry.ts";
import { ConcurrentTelemetryStreamError } from "./telemetry.ts";

export const ERROR_CLASSIFIERS = {
  AdapterConfigError: (error: unknown): boolean => error instanceof AdapterConfigError,
  AdapterMappingError: (error: unknown): boolean => error instanceof AdapterMappingError,
  AuthRefreshError: (error: unknown): boolean => error instanceof AuthRefreshError,
  BroadcastError: (error: unknown): boolean => error instanceof BroadcastError,
  ConcurrentTelemetryStreamError: (error: unknown): boolean =>
    error instanceof ConcurrentTelemetryStreamError,
  ContractResponseError: (error: unknown): boolean => error instanceof ContractResponseError,
  FeeCapExceededError: (error: unknown): boolean => error instanceof FeeCapExceededError,
  GuardBlockedError: (error: unknown): boolean => error instanceof GuardBlockedError,
  GuardError: (error: unknown): boolean => error instanceof GuardError,
  GuardUndeterminedError: (error: unknown): boolean => error instanceof GuardUndeterminedError,
  HeartbeatBlockedError: (error: unknown): boolean => error instanceof HeartbeatBlockedError,
  HeartbeatDryRunError: (error: unknown): boolean => error instanceof HeartbeatDryRunError,
  HeartbeatIntervalError: (error: unknown): boolean => error instanceof HeartbeatIntervalError,
  InvokeRetryError: (error: unknown): boolean => error instanceof InvokeRetryError,
  InvalidFeeCeilingError: (error: unknown): boolean => error instanceof InvalidFeeCeilingError,
  InvalidInputError: (error: unknown): boolean => error instanceof InvalidInputError,
  PolicyDecodeError: (error: unknown): boolean => error instanceof PolicyDecodeError,
  PolicyEncodeError: (error: unknown): boolean => error instanceof PolicyEncodeError,
  PolicyFileReadError: (error: unknown): boolean => error instanceof PolicyFileReadError,
  PolicyValidationError: (error: unknown): boolean => error instanceof PolicyValidationError,
  RateLimitedError: (error: unknown): boolean => error instanceof RateLimitedError,
  RpcTimeoutError: (error: unknown): boolean => error instanceof RpcTimeoutError,
  SignerTimeoutError: (error: unknown): boolean => error instanceof SignerTimeoutError,
  SigningError: (error: unknown): boolean => error instanceof SigningError,
  SimulationError: (error: unknown): boolean => error instanceof SimulationError,
} as const;

export type KnownErrorClass = keyof typeof ERROR_CLASSIFIERS;

export type ErrorDisposition =
  | "blocked"
  | "fail_closed"
  | "other"
  | "retryable_invoke"
  | "retryable_rate_limit"
  | "transport";

export function classifyKnownError(error: unknown): KnownErrorClass | undefined {
  if (error instanceof RateLimitedError) return "RateLimitedError";
  if (error instanceof AuthRefreshError) return "AuthRefreshError";
  if (error instanceof SignerTimeoutError) return "SignerTimeoutError";
  if (error instanceof InvalidFeeCeilingError) return "InvalidFeeCeilingError";
  if (error instanceof PolicyEncodeError) return "PolicyEncodeError";
  if (error instanceof GuardUndeterminedError) return "GuardUndeterminedError";
  if (error instanceof GuardBlockedError) return "GuardBlockedError";
  if (error instanceof HeartbeatBlockedError) return "HeartbeatBlockedError";
  if (error instanceof HeartbeatDryRunError) return "HeartbeatDryRunError";
  if (error instanceof InvokeRetryError) return "InvokeRetryError";
  if (error instanceof RpcTimeoutError) return "RpcTimeoutError";
  if (error instanceof BroadcastError) return "BroadcastError";
  if (error instanceof SimulationError) return "SimulationError";
  if (error instanceof ConcurrentTelemetryStreamError) return "ConcurrentTelemetryStreamError";
  if (error instanceof InvalidInputError) return "InvalidInputError";
  if (error instanceof SigningError) return "SigningError";
  if (error instanceof FeeCapExceededError) return "FeeCapExceededError";
  if (error instanceof ContractResponseError) return "ContractResponseError";
  if (error instanceof PolicyDecodeError) return "PolicyDecodeError";
  if (error instanceof PolicyFileReadError) return "PolicyFileReadError";
  if (error instanceof PolicyValidationError) return "PolicyValidationError";
  if (error instanceof AdapterMappingError) return "AdapterMappingError";
  if (error instanceof AdapterConfigError) return "AdapterConfigError";
  if (error instanceof HeartbeatIntervalError) return "HeartbeatIntervalError";
  if (error instanceof GuardError) return "GuardError";
  return undefined;
}

export function errorDisposition(name: KnownErrorClass): ErrorDisposition {
  switch (name) {
    case "AdapterConfigError":
    case "AdapterMappingError":
    case "AuthRefreshError":
    case "ConcurrentTelemetryStreamError":
    case "ContractResponseError":
    case "FeeCapExceededError":
    case "GuardError":
    case "HeartbeatDryRunError":
    case "HeartbeatIntervalError":
    case "InvalidFeeCeilingError":
    case "InvalidInputError":
    case "PolicyDecodeError":
    case "PolicyEncodeError":
    case "PolicyFileReadError":
    case "PolicyValidationError":
    case "SignerTimeoutError":
    case "SigningError":
      return "other";
    case "GuardBlockedError":
    case "HeartbeatBlockedError":
      return "blocked";
    case "GuardUndeterminedError":
      return "fail_closed";
    case "BroadcastError":
    case "InvokeRetryError":
      return "retryable_invoke";
    case "RateLimitedError":
      return "retryable_rate_limit";
    case "RpcTimeoutError":
    case "SimulationError":
      return "transport";
    default: {
      const exhaustive: never = name;
      return exhaustive;
    }
  }
}

const RETRYABLE_INVOKE_FAILURES = new Set<RetryableInvokeFailure>([
  "stale_ledger_resource_limit",
  "sequence_number_collision",
  "min_fee",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRetryableInvokeFailure(value: unknown): value is RetryableInvokeFailure {
  return (
    typeof value === "string" && RETRYABLE_INVOKE_FAILURES.has(value as RetryableInvokeFailure)
  );
}

function retryableFromMetadata(error: Record<string, unknown>): boolean {
  try {
    if (isRetryableInvokeFailure(error["retryable"])) return true;
    const retry = error["retry"];
    if (!isRecord(retry)) return false;
    return isRetryableInvokeFailure(retry["terminalFailure"]);
  } catch {
    return false;
  }
}

export function isRetryable(error: unknown): boolean {
  try {
    if (!isRecord(error)) return false;
    const name = classifyKnownError(error);
    if (name === undefined) return retryableFromMetadata(error);
    const disposition = errorDisposition(name);
    switch (disposition) {
      case "retryable_rate_limit":
        return true;
      case "retryable_invoke":
        return retryableFromMetadata(error);
      case "blocked":
      case "fail_closed":
      case "other":
      case "transport":
        return false;
      default: {
        const exhaustive: never = disposition;
        return exhaustive;
      }
    }
  } catch {
    return false;
  }
}

function isTransportFailure(error: unknown): boolean {
  return (
    error instanceof BroadcastError ||
    error instanceof RpcTimeoutError ||
    error instanceof SimulationError ||
    error instanceof RateLimitedError
  );
}

function wrapsTransportFailure(error: Record<string, unknown>): boolean {
  const seen = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 16; depth += 1) {
    if (!isRecord(current)) return false;
    if (seen.has(current)) return false;
    seen.add(current);
    let next: unknown;
    try {
      next = current["cause"];
      if (next === undefined) next = current["error"];
    } catch {
      return false;
    }
    if (next === current || (isRecord(next) && seen.has(next))) return false;
    if (isTransportFailure(next)) return true;
    if (!isRecord(next)) return false;
    current = next;
  }
  return false;
}

export function isFailClosed(error: unknown): boolean {
  try {
    if (!isRecord(error)) return false;
    const name = classifyKnownError(error);
    if (name !== undefined) {
      const disposition = errorDisposition(name);
      switch (disposition) {
        case "blocked":
          return false;
        case "fail_closed":
          return true;
        case "other":
        case "retryable_invoke":
        case "retryable_rate_limit":
        case "transport":
          break;
        default: {
          const exhaustive: never = disposition;
          return exhaustive;
        }
      }
    }
    return wrapsTransportFailure(error);
  } catch {
    return false;
  }
}
