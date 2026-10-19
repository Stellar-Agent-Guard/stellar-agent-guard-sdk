/**
 * Construction-time options validation shared by the framework adapters.
 *
 * Every adapter here is wiring, not policy: a missing `toContractCall` or an
 * object masquerading as an interceptor is a programmer error, not a refusal.
 * So the validators below collect *all* the problems in one pass and the
 * adapter throws a single `AdapterConfigError` naming each offending field,
 * before the first agent action ever reaches the guard.
 *
 * Keeping the checks here -- rather than inline in `langchain.ts` and
 * `elizaos.ts` -- means the two adapters fail with the same wording and the
 * same error type, and a new adapter gets the checks for free.
 */
import { AdapterConfigError } from "../errors.ts";

/**
 * One option that was missing or had the wrong type.
 *
 * `field` is the option key to fix, `expected` describes the shape it should
 * have, and `message` is the ready-to-read line used when the issues are
 * reported.
 */
export interface AdapterConfigIssue {
  /** Option key that was missing or had the wrong type. */
  field: string;
  /** Human-readable description of the expected shape. */
  expected: string;
  /** Full sentence describing this issue, used in the thrown error. */
  message: string;
}

/** Describe a value's type for an error message, without ever echoing its contents. */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

/** A required option that must be a function. */
export function validateRequiredFunction(
  field: string,
  value: unknown,
): AdapterConfigIssue | undefined {
  if (typeof value === "function") return undefined;
  return {
    field,
    expected: "a function",
    message: `\`${field}\` is required and must be a function (got ${describeValue(value)}).`,
  };
}

/** An optional option that, when present, must be a function. */
export function validateOptionalFunction(
  field: string,
  value: unknown,
): AdapterConfigIssue | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "function") return undefined;
  return {
    field,
    expected: "a function when provided",
    message: `\`${field}\` must be a function when provided (got ${describeValue(value)}).`,
  };
}

/** An interceptor, duck-typed on the `check(...)` method the adapters call. */
export function validateInterceptor(value: unknown): AdapterConfigIssue | undefined {
  const candidate = value as { check?: unknown } | null | undefined;
  if (candidate != null && typeof candidate.check === "function") return undefined;
  return {
    field: "interceptor",
    expected: "an object exposing a `check(...)` method",
    message:
      "`interceptor` is required and must be a PreFlightInterceptor " +
      "(an object exposing a `check(...)` method).",
  };
}

/**
 * Throw a single `AdapterConfigError` when `issues` is non-empty; otherwise do
 * nothing, so it can be called unconditionally at the end of a validation pass.
 */
export function throwAdapterConfigError(
  adapter: string,
  issues: readonly AdapterConfigIssue[],
): void {
  const first = issues[0];
  if (first === undefined) return;

  const fields = issues.map((issue) => `\`${issue.field}\``).join(", ");
  const message =
    `${adapter} adapter options are invalid: ${issues.length} problem(s) found (${fields}).\n` +
    issues.map((issue) => `  - ${issue.message}`).join("\n");

  throw new AdapterConfigError(message, {
    field: first.field,
    expected: first.expected,
    adapter,
  });
}
