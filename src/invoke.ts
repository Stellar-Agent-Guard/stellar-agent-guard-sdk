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
import {
  SIG_EXPIRATION_LEDGERS,
  assembleFromSimulation,
  buildGuardAuthEntry,
  buildInitialEnvelope,
  describeSimulationResources,
  describeSubmissionFailure,
  isSequenceNumberFailure,
  isStaleLedgerResourceFailure,
  signAccountAuthEntry,
  summarizeDiagnosticEvents,
  submitAndPoll,
  type AgentSigner,
  type ContractCall,
  type SubmissionResult,
} from "./tx.ts";

/** How the guard's authorization is produced for a call that needs it. */
export interface GuardAuthorization {
  guard: string;
  /**
   * The account's registered agent signer: an `AgentSigner` for any signing
   * setup, or a plain Ed25519 `Keypair` for the single-key default. The
   * multi-key shape (contracts v2) arrives behind the same interface — see
   * `docs/concepts/multi-key-agent-signing.md`.
   */
  agent: AgentSigner | Keypair;
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
       * Set when a fresh simulation and submission can fix the failure. Both
       * values use the same one-retry policy in `invoke`.
       */
      retryable?: "stale_ledger_resource_limit" | "sequence_number_collision";
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
 * One bounded retry is built in for submission failures that a fresh account
 * snapshot can fix: stale-ledger resource declarations and sequence-number
 * collisions. Both are classified in `tx.ts` and share the retry policy below;
 * every other failure — including a guard block — is returned untouched.
 */
type RetryableInvokeFailure =
  | "stale_ledger_resource_limit"
  | "sequence_number_collision";

type AccountState = {
  queue: Promise<void>;
  lastReservedSequence?: bigint;
};

const accountStates = new WeakMap<object, Map<string, AccountState>>();

function accountStateFor(server: rpc.Server, publicKey: string): AccountState {
  let states = accountStates.get(server);
  if (!states) {
    states = new Map<string, AccountState>();
    accountStates.set(server, states);
  }
  let state = states.get(publicKey);
  if (!state) {
    state = { queue: Promise.resolve() };
    states.set(publicKey, state);
  }
  return state;
}

/**
 * Serialize invoke() for one source account, including its submission.
 *
 * The queue is scoped to the RPC server object as well as the account key: the
 * same account can have an unrelated sequence on a different network/server.
 * A rejected task releases the queue in `finally`, so one failed transaction
 * cannot strand all later calls.
 */
async function withAccountQueue<T>(
  server: rpc.Server,
  publicKey: string,
  task: () => Promise<T>,
): Promise<T> {
  const state = accountStateFor(server, publicKey);
  const previous = state.queue;
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.queue = current;
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (state.queue === current) state.queue = Promise.resolve();
  }
}

/**
 * Reserve a sequence number for an account.
 *
 * The RPC snapshot can remain one transaction behind immediately after a
 * successful broadcast (and test doubles commonly do). Remember the last
 * reservation and advance past it when the next fetch is not newer. This also
 * makes the reservation safe when `enforceCall` is used directly, while the
 * invoke queue still guarantees fetch → build → submit ordering.
 */
function reserveNextSequence(
  server: rpc.Server,
  publicKey: string,
  fetchedSequence: string,
): string {
  const state = accountStateFor(server, publicKey);
  const fetched = BigInt(fetchedSequence);
  const next =
    state.lastReservedSequence !== undefined && state.lastReservedSequence >= fetched
      ? state.lastReservedSequence + 1n
      : fetched;
  state.lastReservedSequence = next;
  return next.toString();
}

/** The shared bounded retry policy for submission-time failures. */
const MAX_SUBMISSION_RETRIES = 1;

function retryDescription(retryable: RetryableInvokeFailure): string {
  return retryable === "stale_ledger_resource_limit"
    ? "a stale-ledger resource rejection"
    : "a sequence-number collision";
}

export async function invoke(params: InvokeParams): Promise<InvokeOutcome> {
  return withAccountQueue(params.server, params.source.publicKey(), async () => {
    let outcome = await invokePipeline(params);
    if (outcome.kind !== "error" || params.dryRun) return outcome;
    const firstRetryable: RetryableInvokeFailure | undefined = outcome.retryable;
    if (firstRetryable === undefined) return outcome;

    for (let attempt = 0; attempt < MAX_SUBMISSION_RETRIES; attempt++) {
      const previousRetryable = firstRetryable;
      outcome = await invokePipeline(params);
      if (outcome.kind !== "error") return outcome;
      outcome = {
        ...outcome,
        detail: `retried after ${retryDescription(previousRetryable)}; still failed\n${outcome.detail}`,
      };
    }
    return outcome;
  });
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
async function invokePipeline(params: InvokeParams): Promise<InvokeOutcome> {
  const { server } = params;
  const enforced = await enforceCall(params);
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

  const submission = await submitAndPoll(server, assembled.transaction, [params.source]);
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
        : isSequenceNumberFailure(submission.failure)
          ? { retryable: "sequence_number_collision" as const }
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
export async function enforceCall(params: InvokeParams): Promise<EnforcementOutcome> {
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
  // base sequence. The per-account reservation also advances past an RPC
  // snapshot that has not yet observed the preceding submission.
  const nextSeq = reserveNextSequence(server, source.publicKey(), sourceAccount.sequenceNumber());
  const freshAccount = () => new Account(source.publicKey(), nextSeq);

  // ── Step 1: discover required authorizations ──────────────────────────
  const probe = buildInitialEnvelope({
    source: freshAccount(),
    operation,
    networkPassphrase,
    guard: params.guardAuth?.guard ?? null,
  });
  const first = await server.simulateTransaction(probe);
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
      return {
        kind: "error",
        detail: `unsupported credential type in required authorization: ${creds.type}`,
      };
    }
    const addressCredentials = addressCredentialsOf(creds);
    if (!addressCredentials) {
      return {
        kind: "error",
        detail: `credential kind has no address payload: ${creds.type}`,
      };
    }
    // Works for both account (G…) and contract (C…) authorizers; the guard's
    // address is a contract, which is exactly why the agent key — not the
    // transaction source — has to produce this signature.
    const address = Address.fromScAddress(addressCredentials.address).toString();

    if (params.guardAuth && address === params.guardAuth.guard) {
      // The smart account authorizes: sign with the registered agent key over
      // the guard's own preimage (fresh nonce per transaction).
      signedAuth.push(
        await buildGuardAuthEntry({
          guard: params.guardAuth.guard,
          call,
          signer: params.guardAuth.agent,
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
      return {
        kind: "error",
        detail:
          `call requires authorization from ${address}, but no matching key was provided ` +
          `(supplied: ${(params.accountSigners ?? []).map((kp) => kp.publicKey()).join(", ") || "none"})`,
      };
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
  const enforced = await server.simulateTransaction(enforcingTx);
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
