/**
 * Telemetry for the guard contract's events.
 *
 * The listener consumes **two** streams (plus an opt-in third, added in #58),
 * and this is the part that is easy to get wrong: a blocked decision never
 * reaches the ledger. The guard returns `Err`, which rolls the event back, so
 * a listener that only tails committed ledger events sees a contract that
 * appears to approve everything. The streams are:
 *
 *   1. **ledger events** — `server.getEvents`, filtered to the guard contract.
 *      Carries allowed decisions, heartbeats, and the admin lifecycle events.
 *   2. **simulation diagnostics** — attached to a failed *enforced simulation*.
 *      Carries blocked decisions, which by construction have no transaction.
 *   3. **failed-transaction diagnostics** (opt-in, `failedTx` option) —
 *      attached to a transaction that *was* broadcast, included in a ledger,
 *      and then failed on-chain. Its events roll back exactly like a blocked
 *      simulation's, but the RPC preserves them on the `getTransaction` /
 *      `getTransactions` response (`diagnosticEventsXdr`, public and typed in
 *      the pinned stellar-sdk 17.0.1 — see docs/event-schema.md for the spike
 *      evidence).
 *
 * The topic vocabulary is the one verified against the live chain in
 * `docs/event-schema.md`, not the one the contracts documentation describes.
 */
import { rpc, scValToNative, xdr, StrKey } from "@stellar/stellar-sdk";
import { GUARD_AUTH_RESULTS, GUARD_EVENT_TOPICS, decodeAuthDecision, type GuardAuthDecision } from "./events.ts";
import { topicSymbols } from "./invoke.ts";

/** The event name topics this SDK knows how to interpret. */
const KNOWN_TOPICS = new Set<string>(Object.values(GUARD_EVENT_TOPICS));

export type GuardEventKind =
  | "auth_checked"
  | "heartbeat"
  | "initialized"
  | "frozen"
  | "unfrozen"
  | "policy_set"
  | "policy_revoked"
  | "unknown";

const KIND_BY_TOPIC: Record<string, GuardEventKind> = {
  [GUARD_EVENT_TOPICS.authChecked]: "auth_checked",
  [GUARD_EVENT_TOPICS.heartbeat]: "heartbeat",
  [GUARD_EVENT_TOPICS.initialized]: "initialized",
  [GUARD_EVENT_TOPICS.frozen]: "frozen",
  [GUARD_EVENT_TOPICS.unfrozen]: "unfrozen",
  [GUARD_EVENT_TOPICS.policySet]: "policy_set",
  [GUARD_EVENT_TOPICS.policyRevoked]: "policy_revoked",
};

/** Where an event was observed. A blocked decision can only be `diagnostic`. */
export type GuardEventSource = "ledger" | "diagnostic";

/**
 * Which telemetry stream surfaced an event.
 *
 *   - `committed` — a ledger event returned by `server.getEvents`.
 *   - `simulation` — a diagnostic attached to a failed *enforced simulation*;
 *     a blocked decision that never became a transaction.
 *   - `failed_tx` — a diagnostic attached to a transaction that was broadcast,
 *     included in a ledger, and then failed on-chain (additive in #58).
 *
 * `failed_tx` is purely additive: the pre-existing `source` values are
 * unchanged, and failed-transaction events keep `source: "diagnostic"`
 * because they are diagnostics, not committed contract events.
 */
export type GuardEventStream = "committed" | "simulation" | "failed_tx";

export interface GuardEvent {
  kind: GuardEventKind;
  /** The event's name topic, e.g. `event_auth_checked`. */
  topic: string;
  source: GuardEventSource;
  /** Which telemetry stream surfaced this event (see `GuardEventStream`). */
  stream: GuardEventStream;
  /** The contract that emitted it, when the stream identifies one. */
  contractId: string | null;
  /** Ledger sequence, when the event was committed. */
  ledger: number | null;
  ledgerClosedAt: string | null;
  transactionHash: string | null;
  /** Present only for `auth_checked`. */
  decision: GuardAuthDecision | null;
  /** Decoded event data: `{ at }` for a heartbeat, `{ by }` for admin events. */
  data: unknown;
}

function decodeData(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  try {
    return scValToNative(value as xdr.ScVal) as unknown;
  } catch {
    return String(value);
  }
}

/** Interpret an already-decoded topic list plus data as a `GuardEvent`. */
function interpret(
  topics: string[],
  data: unknown,
  context: Omit<GuardEvent, "kind" | "topic" | "decision" | "data">,
): GuardEvent | null {
  const topic = topics[0];
  if (!topic || !KNOWN_TOPICS.has(topic)) return null;
  return {
    kind: KIND_BY_TOPIC[topic] ?? "unknown",
    topic,
    ...context,
    decision: decodeAuthDecision(topics, context.source),
    data,
  };
}

/**
 * Canonical converter from raw simulation diagnostic events to GuardEvents.
 *
 * Both `guardEventsFromDiagnostics` and `telemetryFromDecision` delegate to this
 * canonical decode engine to ensure unified field extraction and prevent divergence.
 */
export function diagnosticsToEvents(
  diagnosticEvents: readonly unknown[],
  guard?: string,
): GuardEvent[] {
  const out: GuardEvent[] = [];
  for (const raw of diagnosticEvents) {
    const bare = (raw as { event?: unknown }).event ?? raw;
    const topics = topicSymbols(bare);
    if (topics.length === 0) continue;
    const decoded = interpret(topics, decodeData(dataOf(bare)), {
      source: "diagnostic",
      stream: "simulation",
      contractId: guard ?? null,
      ledger: null,
      ledgerClosedAt: null,
      transactionHash: null,
    });
    if (decoded) out.push(decoded);
  }
  return out;
}

/**
 * Normalise the contract events attached to a failed enforced simulation.
 *
 * This accepts raw diagnostic events (e.g. from an RPC simulation failure) and
 * converts them to GuardEvents via canonical `diagnosticsToEvents`.
 *
 * This is the only place a *blocked* decision is observable, and it is reached
 * by passing a `PreFlightDecision`'s or an `invoke()` block's diagnostic events
 * through: no ledger query can return them.
 */
export function guardEventsFromDiagnostics(
  diagnosticEvents: readonly unknown[],
  guard?: string,
): GuardEvent[] {
  return diagnosticsToEvents(diagnosticEvents, guard);
}

/**
 * Decode the guard events carried by a failed on-chain transaction.
 *
 * A transaction can pass enforced pre-flight and still fail after inclusion
 * (stale resource pricing, a race the simulation could not see). Its Soroban
 * auth events roll back exactly like a blocked simulation's — but unlike the
 * simulation path, the RPC preserves the diagnostics: `getTransaction` and
 * `getTransactions` attach `diagnosticEventsXdr` to a FAILED response. That is
 * a public, typed field of the pinned stellar-sdk 17.0.1
 * (`Api.GetFailedTransactionResponse` — spike evidence in
 * `docs/event-schema.md`); nothing here reaches into SDK internals.
 *
 * The `auth_checked` decoding is deliberately the *same* one the simulation
 * path uses (this delegates to the canonical `interpret` engine): the contract
 * emits the identical event schema in both contexts. Only the markers differ —
 * the event keeps `source: "diagnostic"` (it rolled back; it is not a
 * committed contract event) and gains `stream: "failed_tx"` plus the failed
 * transaction's hash and ledger. `ledgerClosedAt` stays null: the RPC returns
 * `createdAt` as unix seconds here, not the ISO close time this field carries
 * elsewhere, and re-formatting it is this module's business only once there is
 * a consumer that needs it.
 *
 * Accepts the structural subset of either response type (`GetFailedTransactionResponse`
 * from `getTransaction`, `TransactionInfo` from `getTransactions`), so the
 * listener and direct callers share one decoder.
 */
export function guardEventsFromFailedTransaction(
  tx: Pick<
    rpc.Api.GetFailedTransactionResponse,
    "txHash" | "ledger" | "createdAt" | "diagnosticEventsXdr"
  >,
  guard?: string,
): GuardEvent[] {
  const out: GuardEvent[] = [];
  for (const raw of tx.diagnosticEventsXdr ?? []) {
    const bare = (raw as { event?: unknown }).event ?? raw;
    const topics = topicSymbols(bare);
    if (topics.length === 0) continue;
    const decoded = interpret(topics, decodeData(dataOf(bare)), {
      source: "diagnostic",
      stream: "failed_tx",
      contractId: guard ?? null,
      ledger: tx.ledger,
      ledgerClosedAt: null,
      transactionHash: tx.txHash,
    });
    if (decoded) out.push(decoded);
  }
  return out;
}

function dataOf(raw: unknown): unknown {
  const candidate = raw as {
    body?: unknown;
    event?: { body?: unknown };
  };
  const body = (candidate.event?.body ?? candidate.body) as
    | { v0?: { data?: unknown }; value?: { v0?: { data?: unknown } } }
    | undefined;
  return body?.v0?.data ?? body?.value?.v0?.data;
}

export interface GuardTelemetryConfig {
  server: rpc.Server;
  /** The guard contract to follow. */
  guard: string;
  /** RPC URL, only used for error messages. */
  rpcUrl?: string;
  /**
   * Opt-in: also surface diagnostics from transactions that were broadcast,
   * included in a ledger, and then failed on-chain (`stream: "failed_tx"`).
   *
   * Default off, so existing `committed`/`simulation` telemetry — polling
   * cadence, cursor behavior, yields — is untouched. The failed-transaction
   * scan is an independent `getTransactions` pass with its own cursor; it can
   * never advance or skip the committed `getEvents` cursor (see
   * `pollFailedTransactions`).
   */
  failedTx?: boolean;
}

export interface PollResult {
  events: GuardEvent[];
  /** Cursor to resume from, as returned by the RPC. */
  cursor: string;
  latestLedger: number;
}

/** Result of one failed-transaction diagnostics page. */
export interface FailedTxPollResult {
  events: GuardEvent[];
  /**
   * `getTransactions` cursor to resume from. Independent of the committed
   * `getEvents` cursor — the two must never be exchanged.
   */
  cursor: string;
}

/** Failed-transaction hashes tracked for dedup before the map is trimmed. */
const MAX_TRACKED_FAILED_TX = 1_000;

/**
 * Was this diagnostic event emitted by the guard contract?
 *
 * A parsed diagnostic carries the emitter as a `ContractId` XDR value in the
 * event's `contractId` field, whose toString is a raw hex hash — the same
 * quirk `scripts/capture-event.ts` documents. A wire-shaped event carries the
 * strkey directly. Check both against the guard's strkey; when neither is
 * present (host diagnostics carry no contract id) this returns false and the
 * event is not attributed to the guard on topic shape alone.
 */
function diagnosticEmitter(raw: unknown): string | null {
  const holder = raw as { event?: { contractId?: unknown }; contractId?: unknown };
  const value = holder.event?.contractId ?? holder.contractId;
  if (value instanceof xdr.ContractId) return contractIdFromBytes(value.value);
  if (value instanceof Uint8Array) return contractIdFromBytes(value);
  if (typeof value === "string" && value.startsWith("C")) return value;
  return null;
}

/** A parsed diagnostic's contract id is a raw 32-byte hash, not a strkey. */
function contractIdFromBytes(bytes: Uint8Array): string {
  return StrKey.encodeContract(Buffer.from(bytes));
}

function emittedByGuard(raw: unknown, guard: string): boolean {
  return diagnosticEmitter(raw) === guard;
}

/**
 * Does this transaction envelope invoke the guard contract?
 *
 * Purely typed public-XDR traversal: envelope variant → transaction →
 * operations → invoke-host-function body → `InvokeContractArgs`. Any
 * unexpected shape simply yields `false` — it can never throw, so a
 * fabricated or future-shaped envelope in the page cannot break the scan.
 */
function envelopeInvokesGuard(envelope: xdr.TransactionEnvelope, guard: string): boolean {
  try {
    const ops =
      envelope.type === "envelopeTypeTx"
        ? envelope.v1.tx.operations
        : envelope.type === "envelopeTypeTxV0"
          ? envelope.v0.tx.operations
          : envelope.type === "envelopeTypeTxFeeBump"
            ? envelope.feeBump.tx.innerTx.v1.tx.operations
            : [];
    for (const op of ops) {
      if (op.body.type !== "invokeHostFunction") continue;
      const hostFunction = op.body.invokeHostFunctionOp.hostFunction;
      if (hostFunction.type !== "hostFunctionTypeInvokeContract") continue;
      const address = hostFunction.invokeContract.contractAddress;
      if (address.type !== "scAddressTypeContract") continue;
      if (contractIdFromBytes(address.contractId.value) === guard) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export class GuardTelemetryListener {
  private readonly config: GuardTelemetryConfig;

  /**
   * Failed-transaction hashes already surfaced, so a re-encountered page (the
   * `getTransactions` cursor is not advanced on a mid-page error) or a retry
   * never emits the same failed_tx event twice.
   *
   * This is process-local checkpoint state, not a substitute for the cursors:
   * across a listener restart the streams resume from their cursors and this
   * set starts empty, so a failed transaction still inside the retention
   * window may be re-surfaced once — the same at-least-once behavior the
   * committed stream has when no cursor was persisted.
   */
  private readonly processedFailedTx = new Set<string>();

  constructor(config: GuardTelemetryConfig) {
    this.config = config;
  }

  /** Record a hash as processed, trimming the oldest entry past the cap. */
  private rememberFailedTx(hash: string): void {
    this.processedFailedTx.add(hash);
    if (this.processedFailedTx.size > MAX_TRACKED_FAILED_TX) {
      const oldest = this.processedFailedTx.values().next().value;
      if (oldest !== undefined) this.processedFailedTx.delete(oldest);
    }
  }

  /**
   * Decode one failed transaction's diagnostics into GuardEvents.
   *
   * Diagnostics attributed to the guard contract go through the canonical
   * `interpret` engine — the same topic filter and decision decoder every
   * other stream uses — so an unknown topic (host noise, another contract's
   * event) is dropped, never guessed at, and a malformed event that throws
   * while decoding is skipped rather than crashing the poll.
   */
  private decodeFailedTransaction(tx: rpc.Api.TransactionInfo): GuardEvent[] {
    const out: GuardEvent[] = [];
    for (const raw of tx.diagnosticEventsXdr ?? []) {
      try {
        const bare = (raw as { event?: unknown }).event ?? raw;
        const topics = topicSymbols(bare);
        if (topics.length === 0) continue;
        if (!emittedByGuard(raw, this.config.guard)) continue;
        const decoded = interpret(topics, decodeData(dataOf(bare)), {
          source: "diagnostic",
          stream: "failed_tx",
          contractId: this.config.guard,
          ledger: tx.ledger,
          ledgerClosedAt: null,
          transactionHash: tx.txHash,
        });
        if (decoded) out.push(decoded);
      } catch {
        // A single malformed diagnostic must not take down the poll; the
        // transaction's other events, and the page, continue.
      }
    }
    return out;
  }

  /**
   * One page of committed guard events at or after `startLedger`.
   *
   * Filters server-side by contract id, so the listener only ever sees this
   * guard's own events — the topic vocabulary then narrows further, and an
   * unrecognised topic is dropped rather than guessed at.
   */
  async poll(params: { startLedger?: number; cursor?: string; limit?: number } = {}): Promise<PollResult> {
    const request = (
      params.cursor
        ? { filters: [{ type: "contract" as const, contractIds: [this.config.guard] }], cursor: params.cursor, limit: params.limit }
        : {
            filters: [{ type: "contract" as const, contractIds: [this.config.guard] }],
            startLedger: params.startLedger,
            limit: params.limit,
          }
    ) as rpc.Api.GetEventsRequest;

    if (!params.cursor && params.startLedger === undefined) {
      // Default to the current head: replaying a year of history by accident is
      // a mean surprise, and callers that want history pass `startLedger`.
      const latest = await this.config.server.getLatestLedger();
      (request as { startLedger: number }).startLedger = latest.sequence;
    }

    const response = await this.config.server.getEvents(request);
    const events: GuardEvent[] = [];
    for (const event of response.events) {
      const contractId = event.contractId ? String(event.contractId) : null;
      const decoded = interpret(
        event.topic.map((topic) => String(scValToNative(topic))),
        decodeData(event.value),
        {
          source: "ledger",
          stream: "committed",
          contractId,
          ledger: event.ledger,
          ledgerClosedAt: event.ledgerClosedAt ?? null,
          transactionHash: event.txHash ?? null,
        },
      );
      if (decoded) events.push(decoded);
    }
    return { events, cursor: response.cursor, latestLedger: response.latestLedger };
  }

  /**
   * One page of failed-transaction diagnostics via `getTransactions`.
   *
   * **Why `getTransactions`, not `getEvents`:** the events stream's retention
   * window is short, and a rolled-back auth event can age out before a listener
   * that was down or slow resumes. The transaction stream is a separate RPC
   * method with its own, independent cursor, so a failed transaction's
   * diagnostics can be retrieved long after the events stream has moved past
   * its ledger — exactly the "no skip because the getEvents cursor advanced"
   * guarantee #58 asks for. The two cursors are never exchanged.
   *
   * **Scope:** only transactions with `status: FAILED` that actually involve
   * the guard are inspected — either because the RPC attributes one of the
   * diagnostic events to the guard contract, or because the transaction's
   * envelope invoked the guard. Unrelated diagnostics in a guard transaction
   * (host `fn_call`/`core_metrics` noise) are dropped by the same topic filter
   * the other streams use. A transaction that never touched the guard produces
   * no events, so third-party failures are not swept in.
   *
   * **Errors:** a malformed diagnostic event or a failed lookup is skipped, not
   * propagated — same convention as `poll`, and one bad event cannot corrupt
   * either stream's cursor. On error the cursor is *not* advanced, so the page
   * is re-read next poll and per-transaction dedup (`processedFailedTx`) keeps
   * that from becoming a duplicate emission.
   *
   * When `cursor` is omitted the scan starts at the current head, so an
   * operator enabling `failedTx` is never replayed a year of history by
   * accident — the same default `poll` uses for `startLedger`.
   */
  async pollFailedTransactions(
    params: { cursor?: string; limit?: number } = {},
  ): Promise<FailedTxPollResult> {
    if (!params.cursor) {
      const latest = await this.config.server.getLatestLedger();
      return { events: [], cursor: String(latest.sequence) };
    }
    let page: rpc.Api.GetTransactionsResponse;
    try {
      page = await this.config.server.getTransactions({
        pagination: {
          cursor: params.cursor,
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        },
      });
    } catch {
      // Leave the caller's cursor alone; the page is retried next poll.
      return { events: [], cursor: params.cursor };
    }
    const events: GuardEvent[] = [];
    for (const tx of page.transactions) {
      if (tx.status !== rpc.Api.GetTransactionStatus.FAILED) continue;
      const fresh = !this.processedFailedTx.has(tx.txHash);
      const decoded = fresh ? this.decodeFailedTransaction(tx) : [];
      if (decoded.length > 0) {
        this.rememberFailedTx(tx.txHash);
        events.push(...decoded);
      } else if (
        envelopeInvokesGuard(tx.envelopeXdr, this.config.guard) ||
        (tx.diagnosticEventsXdr ?? []).some((raw) => emittedByGuard(raw, this.config.guard))
      ) {
        // No guard event decoded (all noise, or rolled back before emitting),
        // but the transaction did involve the guard: remember it so a re-read
        // of this page never rescans it.
        this.rememberFailedTx(tx.txHash);
      }
    }
    return { events, cursor: page.cursor };
  }

  /**
   * Follow the guard from `startLedger` (default: one page back) until aborted.
   * Yields batches so a caller controls backpressure; the cursor is advanced
   * internally so no event is delivered twice.
   */
  async *watch(
    params: { startLedger?: number; pollIntervalMs?: number; limit?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<GuardEvent[], void, undefined> {
    const interval = params.pollIntervalMs ?? 5_000;
    let cursor: string | undefined;
    let startLedger = params.startLedger;
    // The failed-transaction scan's own cursor, started at the current head
    // (the empty initial cursor is a sentinel `pollFailedTransactions` maps to
    // "start at head, deliver nothing now"). Kept entirely separate from the
    // committed stream's cursor above.
    let failedTxCursor: string | undefined;

    if (startLedger === undefined) {
      const latest = await this.config.server.getLatestLedger();
      startLedger = Math.max(1, latest.sequence - 1);
      cursor = undefined;
    }

    while (!params.signal?.aborted) {
      const page = await this.poll({
        ...(startLedger !== undefined ? { startLedger } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      });
      cursor = page.cursor;
      // Once a cursor is held, the ledger range must not be sent again — the RPC
      // rejects a request that mixes the two modes.
      startLedger = undefined;
      let batch = page.events;
      if (this.config.failedTx === true) {
        // An independent scan on the `getTransactions` cursor. It cannot
        // advance, skip, or corrupt the committed stream's cursor above, and a
        // failure here must not take the committed stream down with it, so it
        // gets the same skip-not-throw treatment `pollFailedTransactions`
        // applies to its own page errors.
        try {
          const failed = await this.pollFailedTransactions({
            ...(failedTxCursor !== undefined ? { cursor: failedTxCursor } : {}),
            ...(params.limit !== undefined ? { limit: params.limit } : {}),
          });
          failedTxCursor = failed.cursor;
          batch = [...failed.events, ...batch];
        } catch {
          // Keep the committed batch moving; the failed-tx scan retries next
          // poll from its own unchanged cursor.
        }
      }
      if (batch.length > 0) yield batch;
      if (params.signal?.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
}

/**
 * Convenience: interpret one `PreFlightDecision`'s diagnostics into events.
 *
 * Accepts a preflight or simulation decision object, and extracts GuardEvents
 * from its `diagnosticEvents` array if the decision outcome was `blocked`.
 * Distinct from `guardEventsFromDiagnostics` which operates on raw diagnostic
 * event arrays directly; both delegate to canonical `diagnosticsToEvents`.
 */
export function telemetryFromDecision(
  decision: { kind: string; diagnosticEvents?: unknown[]; reason?: string },
  guard: string,
): GuardEvent[] {
  if (decision.kind !== "blocked" || !decision.diagnosticEvents) return [];
  return diagnosticsToEvents(decision.diagnosticEvents, guard);
}

/** True when a decoded decision means the guard permitted the action. */
export function isAllowedDecision(decision: GuardAuthDecision | null): boolean {
  return decision?.result === GUARD_AUTH_RESULTS.allowed;
}

/** A compact one-line rendering of a guard event, for logs. */
export function describeGuardEvent(event: GuardEvent): string {
  const where =
    event.stream === "committed"
      ? `ledger ${event.ledger ?? "?"}`
      : event.stream === "failed_tx"
        ? `failed tx ${event.transactionHash?.slice(0, 8) ?? "?"}`
        : "pre-broadcast";
  const what =
    event.kind === "auth_checked"
      ? `${event.decision?.result ?? "?"}${event.decision?.reason ? ` (${event.decision.reason})` : ""}`
      : event.kind;
  return `${where}: ${event.topic} → ${what}`;
}
