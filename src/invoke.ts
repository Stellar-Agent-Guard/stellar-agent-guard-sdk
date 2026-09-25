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
import { feeBreakdown, type FeeBreakdown } from "./cost.ts";
import {
  BroadcastError,
  ContractResponseError,
  GuardError,
  SigningError,
  SimulationError,
} from "./errors.ts";
import { GUARD_AUTH_RESULTS, decodeAuthDecision } from "./events.ts";
import {
  SIG_EXPIRATION_LEDGERS,
  assembleFromSimulation,
  buildGuardAuthEntry,
  buildInitialEnvelope,
  describeSimulationResources,
  describeSubmissionFailure,
  isStaleLedgerResourceFailure,
  parseSimulationResourceFee,
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

export type InvokeDryRunVerdict = "admissible" | "blocked" | "undetermined";

/** One completed stage in a dry run. `ok` describes the stage, not policy approval. */
export interface InvokePipelineStep {
  name: "probe" | "sign" | "simulate" | "verdict" | "fees";
  durationMs: number;
  ok: boolean;
}

/**
 * Full pre-broadcast result from `invoke({ dryRun: true })`.
 *
 * There is intentionally no submission/hash field: dry-run execution cannot
 * enter assembly or `sendTransaction`, so exposing a transaction hash would be
 * false evidence. `fees` is the network estimate when admissible and an
 * explicit zero breakdown when no admissible execution was priced.
 */
export interface InvokeDryRunResult {
  kind: "dry_run";
  admissible: boolean;
  verdict: InvokeDryRunVerdict;
  reason: string | null;
  detail: string | null;
  /** Typed failure for an undetermined verdict; null for admissible/blocked. */
  error: GuardError | null;
  fees: FeeBreakdown;
  diagnostics: unknown[];
  steps: InvokePipelineStep[];
}

export type InvokeOutcome =
  | InvokeDryRunResult
  | { kind: "allowed"; submission: SubmissionResult }
  | {
      kind: "blocked";
      /** Reason symbol from the contract's own event/topic vocabulary. */
      reason: string | null;
      detail: string;
      /** Diagnostic events emitted by the contract during enforced simulation. */
      diagnosticEvents: unknown[];
      /** Present only when policy/account state changed and blocked after inclusion. */
      transactionHash?: string;
      /** True only for a post-broadcast refusal; absent for free preflight blocks. */
      charged?: boolean;
    }
  | {
      kind: "error";
      detail: string;
      /** Machine-readable failure; branch on this with `instanceof`. */
      error: GuardError;
      diagnosticEvents: unknown[];
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
  /**
   * Run probe → sign → enforced simulation → verdict → fee pricing, then stop.
   * No transaction is assembled or sent, even when the call is admissible.
   */
  dryRun?: boolean;
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

function requiredAuthorizationEntries(
  response: unknown,
): xdr.SorobanAuthorizationEntry[] {
  const result = (response as { result?: unknown }).result;
  if (result !== undefined && (result === null || typeof result !== "object")) {
    throw new ContractResponseError("simulation result is not an object", {
      field: "result",
    });
  }
  const auth = (result as { auth?: unknown } | undefined)?.auth;
  if (auth === undefined) return [];
  if (!Array.isArray(auth)) {
    throw new ContractResponseError("simulation result.auth is not an array", {
      field: "result.auth",
    });
  }
  return auth.map((entry, index) => {
    const credentials = (entry as { credentials?: unknown } | null)?.credentials;
    if (
      entry === null ||
      typeof entry !== "object" ||
      credentials === null ||
      typeof credentials !== "object" ||
      typeof (credentials as { type?: unknown }).type !== "string"
    ) {
      throw new ContractResponseError(
        `simulation result.auth[${index}] has no credential payload`,
        { field: `result.auth[${index}].credentials` },
      );
    }
    return entry as xdr.SorobanAuthorizationEntry;
  });
}

type InvokeStepObserver = (step: InvokePipelineStep) => void;

function recordStep(
  observer: InvokeStepObserver | undefined,
  name: InvokePipelineStep["name"],
  startedAt: number,
  ok: boolean,
): void {
  observer?.({
    name,
    durationMs: Math.max(0, Date.now() - startedAt),
    ok,
  });
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
 * returned untouched, and a retryable failure is marked with `retryable` so it
 * is never silent.
 */
export function invoke(params: InvokeParams & { dryRun: true }): Promise<InvokeDryRunResult>;
export function invoke(
  params: InvokeParams & { dryRun?: false },
): Promise<Exclude<InvokeOutcome, InvokeDryRunResult>>;
export function invoke(params: InvokeParams): Promise<InvokeOutcome>;
export async function invoke(params: InvokeParams): Promise<InvokeOutcome> {
  if (params.dryRun) return invokeDryRun(params);

  const first = await invokePipeline(params);
  if (first.kind !== "error" || first.retryable !== "stale_ledger_resource_limit") {
    return first;
  }

  const second = await invokePipeline(params);
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

async function invokeDryRun(params: InvokeParams): Promise<InvokeDryRunResult> {
  const steps: InvokePipelineStep[] = [];
  const enforced = await enforceCallWithTrace(params, (step) => steps.push(step));
  const verdictStartedAt = Date.now();

  let verdict: InvokeDryRunVerdict =
    enforced.kind === "admissible" ? "admissible" : enforced.kind === "blocked" ? "blocked" : "undetermined";
  const reason: string | null = enforced.kind === "blocked" ? enforced.reason : null;
  let detail: string | null =
    enforced.kind === "error" || enforced.kind === "blocked" ? enforced.detail : null;
  let error: GuardError | null = enforced.kind === "error" ? enforced.error : null;
  const diagnostics: unknown[] =
    enforced.kind === "blocked" || enforced.kind === "error"
      ? enforced.diagnosticEvents
      : diagnosticEventsOf(enforced.simulation);
  let resourceFee = 0n;
  let feesOk = true;

  if (enforced.kind === "admissible") {
    try {
      resourceFee = parseSimulationResourceFee(enforced.simulation.minResourceFee);
    } catch (cause) {
      verdict = "undetermined";
      detail = `enforced simulation succeeded but returned an invalid resource fee: ${
        cause instanceof Error ? cause.message : String(cause)
      }`;
      error =
        cause instanceof GuardError
          ? cause
          : new SimulationError("enforced simulation returned an invalid resource fee", {
              stage: "simulate",
              cause,
            });
      feesOk = false;
    }
  }
  const verdictDurationMs = Math.max(0, Date.now() - verdictStartedAt);

  const feesStartedAt = Date.now();
  const fees: FeeBreakdown =
    verdict === "admissible"
      ? feeBreakdown(resourceFee)
      : {
          resourceFeeStroops: 0n,
          inclusionFeeStroops: 0n,
          totalFeeStroops: 0n,
        };
  const feesDurationMs = Math.max(0, Date.now() - feesStartedAt);
  // Observer is intentionally installed only for enforceCall; append the local
  // verdict/fee stages here so all five stages are in one ordered trace.
  steps.push(
    { name: "verdict", durationMs: verdictDurationMs, ok: enforced.kind !== "error" },
    { name: "fees", durationMs: feesDurationMs, ok: feesOk },
  );

  return {
    kind: "dry_run",
    admissible: verdict === "admissible",
    verdict,
    reason,
    detail,
    error,
    fees,
    diagnostics,
    steps,
  };
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
  | {
      kind: "error";
      detail: string;
      error: GuardError;
      diagnosticEvents: unknown[];
    };

/** One attempt: simulate → sign → enforce → submit. No retry logic lives here. */
async function invokePipeline(params: InvokeParams): Promise<InvokeOutcome> {
  const { server } = params;
  const enforced = await enforceCall(params);
  if (enforced.kind !== "admissible") return enforced;

  // ── Step 4: assemble real resources, sign the envelope, broadcast ─────
  let assembled: ReturnType<typeof assembleFromSimulation>;
  try {
    assembled = assembleFromSimulation({
      simulation: enforced.simulation,
      // A fresh `Account` per build: `TransactionBuilder` advances the sequence of
      // the instance it is handed, so sharing one across builds silently produces
      // `tx_bad_seq`.
      source: new Account(params.source.publicKey(), enforced.nextSeq),
      operation: enforced.operation,
      networkPassphrase: params.networkPassphrase,
      guard: params.guardAuth?.guard ?? null,
    });
  } catch (cause) {
    const detail = `transaction assembly failed: ${cause instanceof Error ? cause.message : String(cause)}`;
    return {
      kind: "error",
      detail,
      error: new SimulationError("could not assemble transaction from enforced simulation", {
        stage: "simulate",
        cause,
      }),
      diagnosticEvents: [],
    };
  }

  let submission: SubmissionResult;
  try {
    submission = await submitAndPoll(server, assembled.transaction, [params.source]);
  } catch (error) {
    const typed =
      error instanceof GuardError ? error : new BroadcastError(String(error), { cause: error });
    return {
      kind: "error",
      detail: typed.message,
      error: typed,
      diagnosticEvents: [],
    };
  }
  if (submission.failure) {
    // A post-broadcast rejection is a hard error, not a policy block: the
    // enforced simulation already passed, so anything here is a defect in
    // construction (sequence, fee, footprint) or a contract trap — never a
    // guardrail doing its job.
    const detail = `tx ${submission.hash} ${describeSubmissionFailure(submission.failure)}`;
    const reason = reasonFromDiagnosticEvents(submission.failure.diagnosticEvents);
    if (reason !== null) {
      return {
        kind: "blocked",
        reason,
        detail,
        diagnosticEvents: submission.failure.diagnosticEvents,
        transactionHash: submission.hash,
        charged: true,
      };
    }
    return {
      kind: "error",
      detail,
      error: new BroadcastError(detail, { transactionHash: submission.hash }),
      diagnosticEvents: submission.failure.diagnosticEvents,
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
export function enforceCall(params: InvokeParams): Promise<EnforcementOutcome> {
  return enforceCallWithTrace(params);
}

async function enforceCallWithTrace(
  params: InvokeParams,
  onStep?: InvokeStepObserver,
): Promise<EnforcementOutcome> {
  const { server, source, call, networkPassphrase } = params;
  const probeStartedAt = Date.now();
  let operation: xdr.Operation;
  let expiration: number;
  let nextSeq: string;
  let freshAccount: () => Account;
  let first: rpc.Api.SimulateTransactionResponse;

  try {
    operation = Operation.invokeContractFunction({
      contract: call.contract,
      function: call.fn,
      args: call.args,
    });
    const sourceAccount = await server.getAccount(source.publicKey());
    const latest = await server.getLatestLedger();
    expiration = latest.sequence + SIG_EXPIRATION_LEDGERS;
    // `TransactionBuilder` advances the sequence of the `Account` it is handed,
    // so every build in this function gets its own instance built from the same
    // base sequence. Sharing one would silently build the second transaction on
    // sequence N+2 and the network would reject it with `tx_bad_seq`.
    nextSeq = sourceAccount.sequenceNumber();
    freshAccount = () => new Account(source.publicKey(), nextSeq);

    // ── Step 1: discover required authorizations ──────────────────────────
    const probe = buildInitialEnvelope({
      source: freshAccount(),
      operation,
      networkPassphrase,
      guard: params.guardAuth?.guard ?? null,
    });
    first = await server.simulateTransaction(probe);
  } catch (error) {
    recordStep(onStep, "probe", probeStartedAt, false);
    return {
      kind: "error",
      detail: `probe failed: ${error instanceof Error ? error.message : String(error)}`,
      error: new SimulationError("authorization probe failed", {
        stage: "probe",
        cause: error,
      }),
      diagnosticEvents: [],
    };
  }

  if (rpc.Api.isSimulationError(first)) {
    // The discovery simulation runs in recording mode, so it can fail for
    // reasons that have nothing to do with policy (a contract trap, a missing
    // trustline). Report it as an error with the host's own diagnostics rather
    // than pretending the guard made a decision.
    const error = first as rpc.Api.SimulateTransactionErrorResponse;
    const events = diagnosticEventsOf(error);
    const detail = [
      typeof error.error === "string" ? error.error : JSON.stringify(error.error),
      ...summarizeDiagnosticEvents(events),
    ].join("\n  ");
    recordStep(onStep, "probe", probeStartedAt, false);
    return {
      kind: "error",
      detail,
      error: new SimulationError("authorization probe simulation failed", {
        stage: "probe",
        diagnosticEvents: events,
      }),
      diagnosticEvents: events,
    };
  }
  recordStep(onStep, "probe", probeStartedAt, true);
  const success = first as rpc.Api.SimulateTransactionSuccessResponse;

  // ── Step 2: sign every authorization the call requires ────────────────
  const signStartedAt = Date.now();
  let requiredAuth: xdr.SorobanAuthorizationEntry[];
  try {
    requiredAuth = requiredAuthorizationEntries(success);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    recordStep(onStep, "sign", signStartedAt, false);
    return {
      kind: "error",
      detail,
      error:
        cause instanceof ContractResponseError
          ? cause
          : new SimulationError("could not read required authorization entries", {
              stage: "probe",
              cause,
            }),
      diagnosticEvents: [],
    };
  }
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
      const detail = `unsupported credential type in required authorization: ${creds.type}`;
      recordStep(onStep, "sign", signStartedAt, false);
      return {
        kind: "error",
        detail,
        error: new SigningError(detail),
        diagnosticEvents: [],
      };
    }
    const addressCredentials = addressCredentialsOf(creds);
    if (!addressCredentials) {
      const detail = `credential kind has no address payload: ${creds.type}`;
      recordStep(onStep, "sign", signStartedAt, false);
      return {
        kind: "error",
        detail,
        error: new SigningError(detail),
        diagnosticEvents: [],
      };
    }
    // Works for both account (G…) and contract (C…) authorizers; the guard's
    // address is a contract, which is exactly why the agent key — not the
    // transaction source — has to produce this signature.
    let address: string;
    try {
      address = Address.fromScAddress(addressCredentials.address).toString();
    } catch (cause) {
      const detail = `required authorization has an invalid address payload: ${
        cause instanceof Error ? cause.message : String(cause)
      }`;
      recordStep(onStep, "sign", signStartedAt, false);
      return {
        kind: "error",
        detail,
        error: new SigningError(detail, { cause }),
        diagnosticEvents: [],
      };
    }

    if (params.guardAuth && address === params.guardAuth.guard) {
      // The smart account authorizes: sign with the registered agent key over
      // the guard's own preimage (fresh nonce per transaction).
      try {
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
      } catch (error) {
        const detail = `could not sign guard authorization for ${address}: ${
          error instanceof Error ? error.message : String(error)
        }`;
        recordStep(onStep, "sign", signStartedAt, false);
        return {
          kind: "error",
          detail,
          error: new SigningError(detail, { address, cause: error }),
          diagnosticEvents: [],
        };
      }
      continue;
    }

    const signer = (params.accountSigners ?? []).find((kp) => kp.publicKey() === address);
    if (!signer) {
      const detail =
        `call requires authorization from ${address}, but no matching key was provided ` +
        `(supplied: ${(params.accountSigners ?? []).map((kp) => kp.publicKey()).join(", ") || "none"})`;
      recordStep(onStep, "sign", signStartedAt, false);
      return {
        kind: "error",
        detail,
        error: new SigningError(detail, { address }),
        diagnosticEvents: [],
      };
    }
    try {
      signedAuth.push(
        await signAccountAuthEntry({
          entry,
          signer,
          signatureExpirationLedger: expiration,
          networkPassphrase,
        }),
      );
    } catch (error) {
      const detail = `could not sign authorization for ${address}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      recordStep(onStep, "sign", signStartedAt, false);
      return {
        kind: "error",
        detail,
        error: new SigningError(detail, { address, cause: error }),
        diagnosticEvents: [],
      };
    }
  }
  recordStep(onStep, "sign", signStartedAt, true);

  // ── Step 3: enforced simulation — this is where policy is applied ─────
  const simulateStartedAt = Date.now();
  let signedOperation: xdr.Operation;
  let enforcingTx: ReturnType<typeof buildInitialEnvelope>;
  try {
    signedOperation = Operation.invokeContractFunction({
      contract: call.contract,
      function: call.fn,
      args: call.args,
      auth: signedAuth,
    });
    enforcingTx = buildInitialEnvelope({
      source: freshAccount(),
      operation: signedOperation,
      networkPassphrase,
      guard: params.guardAuth?.guard ?? null,
    });
  } catch (cause) {
    recordStep(onStep, "simulate", simulateStartedAt, false);
    return {
      kind: "error",
      detail: `could not build enforced simulation: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      error: new SimulationError("could not build enforced simulation", {
        stage: "simulate",
        cause,
      }),
      diagnosticEvents: [],
    };
  }
  let enforced: rpc.Api.SimulateTransactionResponse;
  try {
    enforced = await server.simulateTransaction(enforcingTx);
  } catch (error) {
    recordStep(onStep, "simulate", simulateStartedAt, false);
    return {
      kind: "error",
      detail: `enforced simulation request failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error: new SimulationError("enforced simulation request failed", {
        stage: "simulate",
        cause: error,
      }),
      diagnosticEvents: [],
    };
  }
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
      const detail = [
        typeof error.error === "string" ? error.error : JSON.stringify(error.error),
        ...summarizeDiagnosticEvents(events),
      ].join("\n  ");
      recordStep(onStep, "simulate", simulateStartedAt, false);
      return {
        kind: "error",
        detail,
        error: new SimulationError("enforced simulation failed without a guard verdict", {
          stage: "simulate",
          diagnosticEvents: events,
        }),
        diagnosticEvents: events,
      };
    }
    recordStep(onStep, "simulate", simulateStartedAt, true);
    return {
      kind: "blocked",
      reason,
      detail: typeof error.error === "string" ? error.error : JSON.stringify(error.error),
      diagnosticEvents: events,
    };
  }

  recordStep(onStep, "simulate", simulateStartedAt, true);
  return {
    kind: "admissible",
    simulation: enforced as rpc.Api.SimulateTransactionSuccessResponse,
    operation: signedOperation,
    nextSeq,
  };
}
