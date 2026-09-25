/**
 * Structured SDK failures.
 *
 * Callers should branch on an error class (or on the class attached to a result-
 * oriented `invoke` error outcome), not by matching human-readable messages that
 * may change as the Stellar SDK evolves. Every SDK-owned error extends
 * `GuardError`, so a single `instanceof GuardError` check remains sufficient for
 * integrations that do not need a finer category.
 */

function causeOptions(cause: unknown): ErrorOptions | undefined {
  return cause === undefined ? undefined : { cause };
}

/** Base class for every error deliberately produced by this SDK. */
export class GuardError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** A simulation could not run, or ran without producing a contract verdict. */
export class SimulationError extends GuardError {
  readonly stage: "probe" | "simulate" | "preflight";
  readonly diagnosticEvents: unknown[];

  constructor(
    message: string,
    options: {
      stage: SimulationError["stage"];
      cause?: unknown;
      diagnosticEvents?: readonly unknown[];
    },
  ) {
    super(message, causeOptions(options.cause));
    this.stage = options.stage;
    this.diagnosticEvents = [...(options.diagnosticEvents ?? [])];
  }
}

/** A transaction could not be signed for submission. */
export class SigningError extends GuardError {
  /** Account/contract whose authorization could not be produced, when known. */
  readonly address: string | null;

  constructor(message: string, options: { address?: string | null; cause?: unknown } = {}) {
    super(message, causeOptions(options.cause));
    this.address = options.address ?? null;
  }
}

/** Submission failed after assembly, or the RPC rejected the send request. */
export class BroadcastError extends GuardError {
  /** Present once the RPC has assigned a hash; absent for pre-send failures. */
  readonly transactionHash: string | null;

  constructor(
    message: string,
    options: { transactionHash?: string | null; cause?: unknown } = {},
  ) {
    super(message, causeOptions(options.cause));
    this.transactionHash = options.transactionHash ?? null;
  }
}

/** A contract response did not match the API shape the SDK understands. */
export class ContractResponseError extends GuardError {
  readonly field: string;

  constructor(message: string, options: { field: string; cause?: unknown }) {
    super(message, causeOptions(options.cause));
    this.field = options.field;
  }
}

/** A policy ScVal did not match the deployed `PolicyConfig` wire shape. */
export class PolicyDecodeError extends GuardError {
  /** Dotted field path at which decoding failed. */
  readonly path: string;

  constructor(message: string, options: { path: string; cause?: unknown }) {
    super(message, causeOptions(options.cause));
    this.path = options.path;
  }
}
