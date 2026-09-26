/**
 * The full invocation pipeline for a guarded account, in the order the Stellar
 * host actually requires:
 *
 *  1. simulate with no authorization  → RPC reports which authorizations the
 *     call needs (and the footprint that call touches);
 *  2. sign each reported authorization — a classic keypair for admin calls, or
 *     an agent-signed `SorobanAuthorizationEntry` for the guard contract;
 *  3. simulate again with the signed entries → this second simulation runs the
 *     *real* `__check_auth` against live ledger state, so a policy violation is
 *     reported here, **before** anything is broadcast;
 *  4. only if step 3 succeeds, assemble the real resources, sign the envelope
 *     and broadcast.
 *
 * Steps 1–3 never mutate the ledger. A blocked action therefore costs nothing,
 * which is the property the pre-flight interceptor is built to expose.
 */
import { Account, Address, Keypair, Operation, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { GUARD_AUTH_RESULTS, decodeAuthDecision } from "./events.ts";
import type { TraceStepName, TraceStepStatus } from "./trace.ts";
import {
  SIG_EXPIRATION_LEDGERS,
  assembleFromSimulation,
  buildGuardAuthEntry,
  buildInitialEnvelope,
  describeSimulationResources,
  describeSubmissionFailure,
  isStaleLedgerResourceFailure,
  signAccountAuthEntry,
  summarizeDiagnosticEvents,
  submitAndPoll,
  type ContractCall,
  type SubmissionResult,
} from "./tx.ts";

/** How the guard's authorization is produced for a call that needs it. */
export interface GuardAuthorization {
  guard: string;
  agent: Keypair;
}

export type InvokeOutcome =
  | { kind: "allowed"; submission: SubmissionResult }
  | {
      kind: "blocked";
      /** Reason symbol from the contract's own event/topic vocabulary. */
      reason: string | null;
      detail: string;
      /** Diagnostic events emitted by the contract during enforced simulation. */
      diagnosticEvents: unknown[];
    }
  | {
      kind: "error";
      detail: string;
      /**
       * Set when the failure is a stale-ledger resource declaration that a
       * re-simulation can fix. See `isStaleLedgerResourceFailure` in `tx.ts`.
       */
      retryable?: "stale_ledger_resource_limit";
    };

export interface InvokeParams {
  server: rpc.Server;
  /** Classic account that pays the fee and supplies the sequence number. */
  source: Keypair;
  call: ContractCall;
  networkPassphrase: string;
  /** Present when the call requires the smart account's own authorization. */
  guardAuth?: GuardAuthorization | null;
  /** Extra classic-account authorizers available to sign (e.g. an admin). */
  accountSigners?: Keypair[];
  /** Skip broadcast even if the enforced simulation passes (dry run). */
  dryRun?: boolean;
  /**
   * Optional, logger-agnostic observability hook: one `InvokeStepEvent` per
   * pipeline-stage attempt, covering probe → sign → simulate → broadcast,
   * including every attempt of the built-in stale-ledger retry. Omitting it
   * leaves `invoke()` exactly as it was before this hook existed — the SDK
   * itself never logs and takes no logger dependency; what a consumer does
   * with the events is entirely the consumer's business.
   */
  onStep?: (step: InvokeStepEvent) => void;
}

/**
 * One pipeline-stage attempt, as reported to `onStep`.
 *
 * `name` comes from the shared trace vocabulary (`TraceStepName`), the same
 * names a dry-run trace uses, so the two can never drift apart. `attempt` is
 * the retry index, 0-based, and is always present: `0` for the first (and
 * usually only) pass over the pipeline, `1` for the built-in stale-ledger
 * re-run — so a consumer never has to special-case its absence.
 */
export interface InvokeStepEvent {
  name: TraceStepName;
  status: TraceStepStatus;
  /**
   * Elapsed wall-clock time of *this* stage attempt, in milliseconds. On
   * `start` it is always `0` — nothing has been timed yet.
   */
  durationMs: number;
  /** 0-based retry index: `0` normally, `1` on the stale-ledger re-run. */
  attempt: number;
}

/**
 * Emit one step event to the caller's `onStep` callback.
 *
 * The callback is the caller's, and this SDK stays logger-agnostic — there is
 * deliberately no logger dependency to fall back on — so a throwing callback
 * is swallowed and the pipeline carries on: observability must never decide
 * whether a transaction runs. Two cases matter. A callback throw on the happy
 * path must not turn a successful stage into a failed one. And when the stage
 * itself failed, the original error must survive untouched: swallowing here
 * means the callback's error simply vanishes, and `invoke()` rethrows the real
 * pipeline error — never a callback error wearing its clothes.
 */
function emitStep(
  hook: ((step: InvokeStepEvent) => void) | undefined,
  event: InvokeStepEvent,
): void {
  if (!hook) return;
  try {
    hook(event);
  } catch {
    /* logger-agnostic policy: a broken consumer must not break the pipeline */
  }
}

/**
 * Time one stage attempt, emitting `start` before it runs and `ok` or `fail`
 * with the attempt's own elapsed time after it settles. `ok` means the stage
 * passed; `fail` covers both a thrown error and — via the optional `failed`
 * classifier — a response the pipeline treats as that stage failing (a
 * simulation-error response, a submission that never made it into a ledger).
 * Returns the stage's value and rethrows its error untouched; the `fail`
 * callback throwing only loses the callback's error, never the stage's. With
 * no hook, the stage runs directly — no timers, no events, no work added to
 * the default path.
 */
async function withStepTiming<T>(
  hook: ((step: InvokeStepEvent) => void) | undefined,
  params: { name: TraceStepName; attempt: number },
  run: () => Promise<T>,
  failed?: (value: T) => boolean,
): Promise<T> {
  if (!hook) return run();
  emitStep(hook, { name: params.name, status: "start", durationMs: 0, attempt: params.attempt });
  const startedAt = performance.now();
  try {
    const value = await run();
    emitStep(hook, {
      name: params.name,
      status: failed?.(value) ? "fail" : "ok",
      durationMs: performance.now() - startedAt,
      attempt: params.attempt,
    });
    return value;
  } catch (error) {
    emitStep(hook, {
      name: params.name,
      status: "fail",
      durationMs: performance.now() - startedAt,
      attempt: params.attempt,
    });
    throw error;
  }
}

/**
 * Internal signal that the signing stage refused an authorization shape.
 * Carries the exact detail text the pipeline has always reported; `enforceCall`
 * converts it back to an `error` outcome so a shape refusal stays a result,
 * while still giving the `sign` stage a real `fail` event on the way through.
 */
class SigningStageError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.name = "SigningStageError";
    this.detail = detail;
  }
}

/**
 * Topic symbols of a contract event, tolerating the several shapes RPC and the
 * SDK use for the same event: decoded `xdr.DiagnosticEvent` instances, bare
 * event objects, or base64 XDR strings in a JSON error payload.
 *
 * Exported because a telemetry consumer needs the same tolerance to read a
 * guard decision out of either stream, and duplicating the shape-handling would
 * mean two places to get it wrong.
 */
export function topicSymbols(raw: unknown): string[] {
  const candidate = raw as {
    event?: { body?: unknown };
    body?: unknown;
  };
  const body = (candidate.event?.body ?? candidate.body) as
    | { v0?: { topics?: unknown[] }; value?: { v0?: { topics?: unknown[] } } }
    | undefined;
  const topics = body?.v0?.topics ?? body?.value?.v0?.topics;
  if (!Array.isArray(topics)) return [];
  return topics.flatMap((topic) => {
    try {
      if (typeof topic === "string") {
        return [String(scValToNative(xdr.ScVal.fromXDR(topic, "base64")))];
      }
      return [String(scValToNative(topic as xdr.ScVal))];
    } catch {
      return [];
    }
  });
}

/**
 * Extract the contract's own block reason from a simulation failure.
 *
 * The RPC error string is not the contract's reason vocabulary, but the
 * diagnostic events bundled with the failure are: the guard publishes
 * `topics = [event_auth_checked, blocked, <reason>]` on every decision,
 * including decisions taken inside an enforced simulation. Note the `event_`
 * prefix — see `events.ts` for why the live topic differs from the docs' name.
 *
 * A *blocked* decision is only ever observed here, as a diagnostic: the guard
 * returns `Err`, which rolls the event back, so it never reaches a ledger.
 */
export function reasonFromDiagnosticEvents(events: unknown[]): string | null {
  for (const event of events) {
    const decision = decodeAuthDecision(topicSymbols(event), "diagnostic");
    if (decision?.result === GUARD_AUTH_RESULTS.blocked && decision.reason) {
      return decision.reason;
    }
  }
  return null;
}

/**
 * Diagnostic events attached to a failed simulation, if the RPC supplied any.
 * Both the top-level `events` field and the nested error payload are checked:
 * which one carries them varies by failure kind.
 */
/**
 * Payload of an address-bound credential, for either arm.
 *
 * The two arms name their payload differently (`address` for legacy, `addressV2`
 * for CAP-71's address-bound form), which mirrors the SDK's own internal
 * `getAddressCredentials` switch.
 */
function addressCredentialsOf(
  credentials: xdr.SorobanCredentials,
): xdr.SorobanAddressCredentials | null {
  if (credentials.type === "sorobanCredentialsAddress") {
    return credentials.address;
  }
  if (credentials.type === "sorobanCredentialsAddressV2") {
    return credentials.addressV2;
  }
  return null;
}

function diagnosticEventsOf(response: unknown): unknown[] {
  const candidate = response as {
    events?: unknown;
    error?: { data?: { events?: unknown } };
  };
  for (const value of [candidate.events, candidate.error?.data?.events]) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

/**
 * Run one contract call through simulate → sign → enforce, submitting only on a
 * pass. Returns a discriminated result rather than throwing, so callers can
 * decide whether a block is an expected outcome (agents hitting a guardrail) or
 * a failure worth surfacing.
 *
 * One bounded retry is built in, for a failure mode that is real and measurable
 * rather than theoretical: if the enforced simulation prices the transaction
 * against a ledger snapshot that predates the write this SDK just made, the
 * declared byte-write budget can be short and core rejects the transaction
 * *after* inclusion with `scecExceededLimit`. See `isStaleLedgerResourceFailure`
 * for why retrying is safe. Every other failure — including a guard block — is
 * returned untouched, and the retry is reported in `retried` so it is never
 * silent.
 */
export async function invoke(params: InvokeParams): Promise<InvokeOutcome> {
  const first = await invokePipeline(params, 0);
  if (first.kind !== "error" || first.retryable !== "stale_ledger_resource_limit") {
    return first;
  }
  if (params.dryRun) return first;

  const second = await invokePipeline(params, 1);
  // If the retry also fails, report the retry's outcome: it is the more recent
  // and more informative of the two.
  if (second.kind === "error") {
    return {
      ...second,
      detail: `retried after a stale-ledger resource rejection; still failed\n${second.detail}`,
    };
  }
  return second;
}

/**
 * The outcome of steps 1–3: the guard has been asked, and answered.
 *
 * `admissible` means the enforced simulation ran the real `__check_auth` against
 * live ledger state and it passed. It is separated from submission so the
 * pre-flight interceptor can ask the same question without broadcasting
 * anything — one implementation of the enforcement question, two callers.
 */
export type EnforcementOutcome =
  | {
      kind: "admissible";
      /** The successful enforced simulation, carrying real resource pricing. */
      simulation: rpc.Api.SimulateTransactionSuccessResponse;
      /** The operation with signed authorizations attached, ready to assemble. */
      operation: xdr.Operation;
      /** Base sequence number for building the submitting envelope. */
      nextSeq: string;
    }
  | {
      kind: "blocked";
      reason: string;
      detail: string;
      diagnosticEvents: unknown[];
    }
  | { kind: "error"; detail: string };

/** One attempt: simulate → sign → enforce → submit. No retry logic lives here. */
async function invokePipeline(params: InvokeParams, attempt: number): Promise<InvokeOutcome> {
  const { server } = params;
  const enforced = await enforceCall(params, attempt);
  if (enforced.kind !== "admissible") return enforced;

  if (params.dryRun) {
    return {
      kind: "error",
      detail: "dry run: enforced simulation passed; submission skipped as requested",
    };
  }

  // ── Step 4: assemble real resources, sign the envelope, broadcast ─────
  const assembled = assembleFromSimulation({
    simulation: enforced.simulation,
    // A fresh `Account` per build: `TransactionBuilder` advances the sequence of
    // the instance it is handed, so sharing one across builds silently produces
    // `tx_bad_seq`.
    source: new Account(params.source.publicKey(), enforced.nextSeq),
    operation: enforced.operation,
    networkPassphrase: params.networkPassphrase,
    guard: params.guardAuth?.guard ?? null,
  });

  const submission = await withStepTiming(
    params.onStep,
    { name: "broadcast", attempt },
    () => submitAndPoll(server, assembled.transaction, [params.source]),
    (result) => result.failure !== null,
  );
  if (submission.failure) {
    // A post-broadcast rejection is a hard error, not a policy block: the
    // enforced simulation already passed, so anything here is a defect in
    // construction (sequence, fee, footprint) or a contract trap — never a
    // guardrail doing its job.
    return {
      kind: "error",
      detail: `tx ${submission.hash} ${describeSubmissionFailure(submission.failure)}`,
      ...(isStaleLedgerResourceFailure(submission.failure)
        ? { retryable: "stale_ledger_resource_limit" as const }
        : {}),
    };
  }
  return { kind: "allowed", submission };
}

/**
 * Steps 1–3 of the pipeline, with no submission: discover what the call needs,
 * sign it, then run the *enforced* simulation that actually exercises the
 * guard's `__check_auth` against live ledger state.
 *
 * Nothing here mutates the ledger, which is what makes a refusal free.
 */
export async function enforceCall(
  params: InvokeParams,
  attempt: number = 0,
): Promise<EnforcementOutcome> {
  const { server, source, call, networkPassphrase } = params;
  const operation = Operation.invokeContractFunction({
    contract: call.contract,
    function: call.fn,
    args: call.args,
  });

  const sourceAccount = await server.getAccount(source.publicKey());
  const latest = await server.getLatestLedger();
  const expiration = latest.sequence + SIG_EXPIRATION_LEDGERS;
  // `TransactionBuilder` advances the sequence of the `Account` it is handed,
  // so every build in this function gets its own instance built from the same
  // base sequence. Sharing one would silently build the second transaction on
  // sequence N+2 and the network would reject it with `tx_bad_seq`.
  const nextSeq = sourceAccount.sequenceNumber();
  const freshAccount = () => new Account(source.publicKey(), nextSeq);

  // ── Step 1: discover required authorizations ──────────────────────────
  const probe = buildInitialEnvelope({
    source: freshAccount(),
    operation,
    networkPassphrase,
    guard: params.guardAuth?.guard ?? null,
  });
  const first = await withStepTiming(
    params.onStep,
    { name: "probe", attempt },
    () => server.simulateTransaction(probe),
    (response) => rpc.Api.isSimulationError(response),
  );
  if (rpc.Api.isSimulationError(first)) {
    // The discovery simulation runs in recording mode, so it can fail for
    // reasons that have nothing to do with policy (a contract trap, a missing
    // trustline). Report it as an error with the host's own diagnostics rather
    // than pretending the guard made a decision.
    const error = first as rpc.Api.SimulateTransactionErrorResponse;
    const events = diagnosticEventsOf(error);
    return {
      kind: "error",
      detail: [
        typeof error.error === "string" ? error.error : JSON.stringify(error.error),
        ...summarizeDiagnosticEvents(events),
      ].join("\n  "),
    };
  }
  const success = first as rpc.Api.SimulateTransactionSuccessResponse;
  const requiredAuth: xdr.SorobanAuthorizationEntry[] = success.result?.auth ?? [];

  // ── Step 2: sign every authorization the call requires ────────────────
  // One `sign` stage per attempt, spanning every entry the discovery probe
  // reported: a caller tracing the pipeline cares that signing happened and
  // how long it took, not how the loop over entries is shaped inside. A shape
  // this SDK cannot sign raises the internal `SigningStageError` so the stage
  // reports a real `fail`; `enforceCall` converts it straight back into the
  // error outcome the pipeline has always returned, detail text unchanged.
  const signRequiredAuth = async (): Promise<xdr.SorobanAuthorizationEntry[]> => {
    const signedAuth: xdr.SorobanAuthorizationEntry[] = [];
    for (const entry of requiredAuth) {
      const creds = entry.credentials;
      if (creds.type === "sorobanCredentialsSourceAccount") {
        // Nothing to sign: the transaction source's authorization is carried by
        // the envelope signature. The entry itself is NOT droppable, though — an
        // operation whose auth list is empty is treated as a recording-mode
        // request by the RPC (so `__check_auth` never runs and policy is never
        // enforced), and core then rejects the submitted transaction because no
        // authorization was actually provided.
        signedAuth.push(entry);
        continue;
      }
      if (
        creds.type !== "sorobanCredentialsAddress" &&
        creds.type !== "sorobanCredentialsAddressV2"
      ) {
        // ADDRESS_WITH_DELEGATES (CAP-71 delegation) is out of v1 scope; the
        // contract's SPEC records the same boundary.
        throw new SigningStageError(
          `unsupported credential type in required authorization: ${creds.type}`,
        );
      }
      const addressCredentials = addressCredentialsOf(creds);
      if (!addressCredentials) {
        throw new SigningStageError(`credential kind has no address payload: ${creds.type}`);
      }
      // Works for both account (G…) and contract (C…) authorizers; the guard's
      // address is a contract, which is exactly why the agent key — not the
      // transaction source — has to produce this signature.
      const address = Address.fromScAddress(addressCredentials.address).toString();

      if (params.guardAuth && address === params.guardAuth.guard) {
        // The smart account authorizes: sign with the registered agent key over
        // the guard's own preimage (fresh nonce per transaction).
        signedAuth.push(
          buildGuardAuthEntry({
            guard: params.guardAuth.guard,
            call,
            agent: params.guardAuth.agent,
            // The transaction's own sequence number doubles as the nonce: unique
            // per transaction and never reused, so the host can never see a
            // replay for this guard address.
            nonce: BigInt(nextSeq),
            signatureExpirationLedger: expiration,
            networkPassphrase,
            // Answer in the same credential kind the host asked for: the signed
            // preimage differs between legacy ADDRESS and ADDRESS_V2, so using
            // the wrong one produces a signature the account cannot verify.
            credentialType: creds.type,
          }),
        );
        continue;
      }

      const signer = (params.accountSigners ?? []).find((kp) => kp.publicKey() === address);
      if (!signer) {
        throw new SigningStageError(
          `call requires authorization from ${address}, but no matching key was provided ` +
            `(supplied: ${(params.accountSigners ?? []).map((kp) => kp.publicKey()).join(", ") || "none"})`,
        );
      }
      signedAuth.push(
        await signAccountAuthEntry({
          entry,
          signer,
          signatureExpirationLedger: expiration,
          networkPassphrase,
        }),
      );
    }
    return signedAuth;
  };

  let signedAuth: xdr.SorobanAuthorizationEntry[];
  try {
    signedAuth = await withStepTiming(params.onStep, { name: "sign", attempt }, signRequiredAuth);
  } catch (error) {
    // A signing-stage shape refusal is a result, not an exception: keep
    // reporting it exactly as the pipeline always has, word for word.
    if (error instanceof SigningStageError) return { kind: "error", detail: error.detail };
    throw error;
  }

  // ── Step 3: enforced simulation — this is where policy is applied ─────
  const signedOperation = Operation.invokeContractFunction({
    contract: call.contract,
    function: call.fn,
    args: call.args,
    auth: signedAuth,
  });
  const enforcingTx = buildInitialEnvelope({
    source: freshAccount(),
    operation: signedOperation,
    networkPassphrase,
    guard: params.guardAuth?.guard ?? null,
  });
  const enforced = await withStepTiming(
    params.onStep,
    { name: "simulate", attempt },
    () => server.simulateTransaction(enforcingTx),
    (response) => rpc.Api.isSimulationError(response),
  );
  if (process.env["SAG_DEBUG_RESOURCES"] === "1") {
    console.log(`[debug] enforced simulation:\n${describeSimulationResources(enforced, params.guardAuth?.guard ?? null)}`);
  }
  if (rpc.Api.isSimulationError(enforced)) {
    // NOTE: a simulation failure here is not automatically a block — see the
    // discriminator below. Returning `error` rather than `blocked` in that case
    // is deliberate: an adapter must be able to tell "the guard refused this"
    // from "we could not determine".
    const error = enforced as rpc.Api.SimulateTransactionErrorResponse;
    const events = diagnosticEventsOf(error);
    const reason = reasonFromDiagnosticEvents(events);
    // A guard decision is identifiable: the contract publishes its own
    // `event_auth_checked/blocked/<reason>` event. Any other simulation failure
    // — a contract trap, an absent trustline, a host misuse — is an error, not
    // a block, and must not be reported as the guard refusing anything.
    if (reason === null) {
      return {
        kind: "error",
        detail: [
          typeof error.error === "string" ? error.error : JSON.stringify(error.error),
          ...summarizeDiagnosticEvents(events),
        ].join("\n  "),
      };
    }
    return {
      kind: "blocked",
      reason,
      detail: typeof error.error === "string" ? error.error : JSON.stringify(error.error),
      diagnosticEvents: events,
    };
  }

  return {
    kind: "admissible",
    simulation: enforced as rpc.Api.SimulateTransactionSuccessResponse,
    operation: signedOperation,
    nextSeq,
  };
}
