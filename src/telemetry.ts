/**
 * Telemetry for the guard contract's events.
 *
 * The listener consumes **two** streams, and this is the part that is easy to
 * get wrong: a blocked decision never reaches the ledger. The guard returns
 * `Err`, which rolls the event back, so a listener that only tails committed
 * ledger events sees a contract that appears to approve everything. The two
 * streams are:
 *
 *   1. **ledger events** — `server.getEvents`, filtered to the guard contract.
 *      Carries allowed decisions, heartbeats, and the admin lifecycle events.
 *   2. **simulation diagnostics** — attached to a failed *enforced simulation*.
 *      Carries blocked decisions, which by construction have no transaction.
 *
 * The topic vocabulary is the one verified against the live chain in
 * `docs/event-schema.md`, not the one the contracts documentation describes.
 *
 * ## Stable ids (issue #33)
 *
 * Every decoded `GuardEvent` carries a non-null, stable `id`, because the two
 * streams fail identity in opposite ways: a committed event is anchored on a
 * transaction hash, while a blocked one has no ledger anchor at all (it was
 * rolled back before broadcast) and needs a synthetic id derived from its own
 * content. The format and the collision notes are documented in
 * `docs/event-schema.md` and implemented by `guardEventId` below.
 *
 * ## Injectable transport (issue #71)
 *
 * The listener talks to an RPC endpoint through a `{ server | url }` config.
 * Enterprise / agent deployments route RC through proxies (auth headers,
 * mTLS, latency shielding), so the caller may pass a pre-built
 * `SorobanRpc.Server` instance (configured before construction) and the
 * SDK will use it verbatim. The config is mutually exclusive: passing both
 * `server` and `url`, or neither, is a typed error.
 */
import { createHash } from "node:crypto";
import { rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { GUARD_AUTH_RESULTS, GUARD_EVENT_TOPICS, decodeAuthDecision, normalizeEventData, type GuardAuthDecision } from "./events.ts";
import { topicSymbols } from "./invoke.ts";

/** The event name topics this SDK knows how to interpret. */
const KNOWN_TOPICS = new Set<string>(Object.values(GUARD_EVENT_TOPICS));

/**
 * Shared RPC configuration for every surface that talks to a Soroban RPC
 * endpoint (issue #71).
 *
 * Exactly one of `server` or `url` must be provided:
 *
 * - `server` — a pre-built `SorobanRpc.Server` instance. Used verbatim,
 *   which is how enterprise / agent deployments route RPC through proxies
 *   (auth headers, mTLS, latency shielding): the proxy configuration happens
 *   *before* constructing the `Server`, which is then passed in.
 * - `url` — an RPC URL the SDK constructs a `SorobanRpc.Server` from.
 *
 * The config is mutually exclusive; `resolveServerConfig` validates it and
 * throws a `GuardServerConfigError` otherwise.
 */
export interface GuardServerConfig {
  /** A pre-built `SorobanRpc.Server` instance. Wins over `url`. */
  server?: rpc.Server;
  /** An RPC URL the SDK constructs a `SorobanRpc.Server` from. */
  url?: string;
}

/** Thrown when a `GuardServerConfig` is neither complete nor exclusive. */
export class GuardServerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardServerConfigError";
  }
}

/**
 * Validate a `{ server | url }` config and return the `SorobanRpc.Server`
 * to use.
 *
 * - `server` is returned verbatim — no fresh instance is built from `url`.
 * - `url` builds a new `SorobanRpc.Server`.
 * - both or neither throws `GuardServerConfigError`.
 */
export function resolveServerConfig(config: GuardServerConfig): rpc.Server {
  if (config.server && config.url) {
    throw new GuardServerConfigError(
      "Provide either `server` or `url`, but not both.",
    );
  }
  if (config.server) return config.server;
  if (config.url) return new rpc.Server(config.url);
  throw new GuardServerConfigError(
    "Provide either `server` or `url`.",
  );
}

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
 * The stream discriminator on a `GuardEvent` (issue #67).
 *
 * `source` records the observation channel (`ledger` vs `diagnostic`); this
 * field states the same fact in the vocabulary a consumer of the **unified**
 * stream reads, so one `for await (const event of listener.watchAll()) loop can
 * tell a committed event from a pre-broadcast one without knowing the SDK's
 * two-channel model.
 */
export type GuardEventStream = "committed" | "diagnostic";

export interface GuardEvent {
  /**
   * Stable identity for this event, non-null on both streams.
   *
   * `ledger:<txHash>:<topic>` for a committed event; `diag:<sha256>` for a
   * diagnostic one, which has no transaction to anchor on. Derived by
   * `guardEventId`; see `docs/event-schema.md` for the format and collisions.
   */
  id: string;
  kind: GuardEventKind;
  /** The event's name topic, e.g. `event_auth_checked`. */
  topic: string;
  source: GuardEventSource;
  /**
   * Which of the listener's two streams produced this event, derived from
   * `source`: `ledger` → `committed`, `diagnostic` → `diagnostic`. Present on
   * every `GuardEvent` the SDK emits, including from `watch()`. Additive
   * (issue #67).
   */
  stream: GuardEventStream;
  /** The contract that emitted it, when the stream identifies one. */
  contractId: string | null;
  /** Ledger sequence, when the event was committed. */
  ledger: number | null;
  ledgerClosedAt: string | null;
  /**
   * When a diagnostic event was observed, ISO-8601. `null` on the committed
   * stream (which carries `ledgerClosedAt` instead) and on diagnostics read
   * straight off `diagnosticsToEvents`; `watchAll()` stamps it at the moment
   * the batch is merged in. Additive (issue #67).
   */
  observedAt: string | null;
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

/** The stream facts an event's `id` is derived from. */
export interface GuardEventIdentityInput {
  source: GuardEventSource;
  /** Name topics in order, as decoded from the event. */
  topics: readonly string[];
  /** Decoded event data, exactly as it lands in `GuardEvent.data`. */
  data: unknown;
  /** The emitting guard, when the stream identifies one. */
  contractId: string | null;
  /** Ledger sequence, when committed; null on the diagnostic stream. */
  ledger: number | null;
  transactionHash: string | null;
  /**
   * Position of this event within the diagnostic batch it arrived in, or null
   * on the ledger stream. This is the component that keeps two *distinct* bocks within one simulation from colliding.
   */
  simulationIndex: number | null;
}

/**
 * Stable identity for a guard event, usable as a delivery / de-duplication key.
 *
 * One format per stream, because the two fail identity in opposite ways:
 *
 * - `ledger:<txHash>:<topic>` — a committed event is anchored on the
 *   transaction that emitted it, plus its name topic. The topic is part of the
 *   id because a single transaction emits several guard events: a `heartbeat`
 *   call commits both `event_auth_checked` and `event_heartbeat` (see the live
 *   capture in `docs/event-schema.md`), so `ledger:<txHash>` alone is not
 *   unique. If an RPC response ever omits the hash, the ledger sequence
 *   anchors instead — an id is always produced.
 *
 * - `diag:<sha256>` — a blocked decision never reaches a ledger (the guard
 *   returns `Err`, the host rolls the event back), so there is nothing to
 *   anchor on and the id is derived from the event's own content: a SHA-256
 *   over the stream name, the guard address, the event's position within its
 *   diagnostic batch, the decoded topics and the decoded data. Re-parsing the
 *   same simulation therefore yields the same id, while two different blocks in
 *   one simulation get different ids because their positions differ.
 *
 * Collision notes: two *separate* simulations that produce an identical
 * diagnostic event for the same guard share an id. That is deliberate — the
 * content is the same decision — so a consumer needing per-attempt identity
 * should combine `id` with its own attempt counter instead of expecting
 * a unique key per refusal. Within one batch, SHA-256 plus the position makes
 * accidental collisions impossible in practice.
 */
export function guardEventId(event: GuardEventIdentityInput): string {
  if (event.source === "ledger") {
    const anchor =
      event.transactionHash ?? (event.ledger !== null ? String(event.ledger) : "unknown");
    return `ledger:${anchor}:${event.topics[0] ?? ""}`;
  }
  return `diag:${createHash("sha256").update(diagnosticIdMaterial(event)).digest("hex")}`;
}

/**
 * The exact string hashed into a diagnostic id, in a fixed order: stream, guard
 * address, position in batch, topics, data.
 *
 * Parts are length-prefixed rather than merely separated: a topic or a decoded
 * value that itself contains the separator must not be able to shift the field
 * boundaries and alias two different events onto one id. With framing, the
 * rendering is unambiguous for any input.
 */
function diagnosticIdMaterial(event: GuardEventIdentityInput): string {
  const parts = [
    "diagnostic",
    event.contractId ?? "",
    String(event.simulationIndex ?? -1),
    ...event.topics,
    stableStringify(event.data),
  ];
  return parts
    .map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`)
    .join("");
}

/**
 * A canonical rendering of decoded event data for hashing: object keys sorted
 * so key order cannot change an id, `bigint` and byte arrays rendered
 * explicitly (`scValToNative` yields `bigint` for u64, which `JSON.stringify`
 * throws on), and a depth cap so a pathological payload cannot build an
 * unbounded string.
 */
function stableStringify(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (value instanceof Uint8Array) return `bytes:${Buffer.from(value).toString("hex")}`;
  if (depth >= 8) return "depth";
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item, depth + 1)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item, depth + 1)}`)
    .join(",")}}`;
}

/**
 * The stream facts known at decode time, before the event's `id` is derived
 * from them.
 */
export type GuardEventContext = Omit<
  GuardEvent,
  "kind" | "topic" | "id" | "decision" | "data" | "stream" | "observedAt"
> & {
  /** Position within the diagnostic batch; null on the ledger stream. */
  simulationIndex: number | null;
  /**
   * Observation time for a diagnostic event; omitted (→ `null`) on the
   * committed stream, which anchors on `ledgerClosedAt` instead.
   */
  observedAt?: string | null;
};

/** Interpret an already-decoded topic list plus data as a `GuardEvent`. */
function interpret(
  topics: string[],
  data: unknown,
  context: GuardEventContext,
): GuardEvent | null {
  const topic = topics[0];
  if (!topic || !KNOWN_TOPICS.has(topic)) return null;
  const { simulationIndex, observedAt, ...streamFacts } = context;
  return {
    kind: KIND_BY_TOPIC[topic] ?? "unknown",
    topic,
    id: guardEventId({
      source: streamFacts.source,
      contractId: streamFacts.contractId,
      ledger: streamFacts.ledger,
      transactionHash: streamFacts.transactionHash,
      topics,
      data,
      simulationIndex,
    }),
    ...streamFacts,
    stream: streamFacts.source === "ledger" ? "committed" : "diagnostic",
    observedAt: observedAt ?? null,
    decision: decodeAuthDecision(topics, context.source),
    data: normalizeEventData(data),
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
  for (const [index, raw] of diagnosticEvents.entries()) {
    const bare = (raw as { event?: unknown }).event ?? raw;
    const topics = topicSymbols(bare);
    if (topics.length === 0) continue;
    const decoded = interpret(topics, decodeData(dataOf(bare)), {
      source: "diagnostic",
      contractId: guard ?? null,
      ledger: null,
      ledgerClosedAt: null,
      transactionHash: null,
      // The position within this batch is what keeps two blocked decisions from
      // one simulation apart once both are rolled back and neither has a hash.
      simulationIndex: index,
    });
    if (decoded) out.push(decoded);
  }
  return out;
}

/**
 * Normalise the contract events attached to a failed enforced simulation.
 *
 * This accepts raw diagnostic events (e.g. from an RPC simulation failure) and
 * converts them to GuardEvents via the canonical `diagnosticsToEvents` engine.
 */
export function guardEventsFromDiagnostics(
  diagnosticEvents: readonly unknown[],
  guard?: string,
): GuardEvent[] {
  return diagnosticsToEvents(diagnosticEvents, guard);
}

/** Extract the data payload from a raw event or event-like object. */
function dataOf(bare: unknown): unknown {
  const candidate = bare as {
    data?: unknown;
    body?: { value?: unknown };
    value?: unknown;
  };
  if (candidate.data !== undefined) return candidate.data;
  if (candidate.body?.value !== undefined) return candidate.body.value;
  return candidate.value;
}

/**
 * Opt-in retention of the most recent events, so a consumer can answer "what
 * did the guard decide just now?" without standing up its own store (issue #68).
 *
 * Off by default: an embedded agent runtime should not pay for a buffer it never
 * reads. Non-durable by construction — the buffer lives in process memory, so a
 * restart empties it. Persistence, if needed, is a cursor store (its own issue),
 * not something this buffer pretends to provide.
 */
export interface GuardEventBufferOptions {
  /** How many of the most recent events to keep. Must be a positive integer. */
  max: number;
}

/**
 * The filter surface of `recent()`, deliberately small.
 *
 * `stream` and `reason` are the useful selectors ("show me blocked decisions",
 * "show me refusals for this reason"); `fromLedger`/`toLedger` narrow to a
 * ledger range. Kept to these four so the accessor stays a snapshot, not a
 * query engine: a consumer that needs more should keep its own store with the
 * full event stream.
 */
export interface RecentEventFilter {
  /** Only events observed on this stream. */
  stream?: GuardEventStream;
  /** Only events whose decoded decision reason equals this code. */
  reason?: string;
  /** Only events at or after this ledger (committed events only). */
  fromLedger?: number;
  /** Only events at or before this ledger (committed events only). */
  toLedger?: number;
}

/** True when an event satisfies every field set in `filter`. */
function matchesRecentFilter(event: GuardEvent, filter: RecentEventFilter): boolean {
  if (filter.stream !== undefined && event.stream !== filter.stream) return false;
  if (filter.reason !== undefined && event.decision?.reason !== filter.reason) return false;
  // A diagnostic event has no ledger; a ledger bound therefore excludes it,
  // rather than silently treating `null` as "inside the range".
  if (filter.fromLedger !== undefined && (event.ledger === null || event.ledger < filter.fromLedger)) {
    return false;
  }
  if (filter.toLedger !== undefined && (event.ledger === null || event.ledger > filter.toLedger)) {
    return false;
  }
  return true;
}

/**
 * A fixed-capacity FIFO ring of the most recent `GuardEvent`s (issue #68).
 *
 * O(1) push with no allocation after construction: the backing array is
 * allocated once at `max` and reused, so a long-running agent does not grow the
 * heap with telemetry it already decided to keep only a window of. Once full,
 * each push overwrites the oldest slot; `recent()` always returns events in
 * observation order (oldest first).
 */
export class GuardEventRingBuffer {
  readonly max: number;
  private readonly slots: GuardEvent[];
  /** Index of the oldest retained event. */
  private start = 0;
  /** Number of live slots, `0..max`. */
  private count = 0;

  constructor(max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new RangeError(`buffer.max must be a positive integer, received ${max}`);
    }
    this.max = max;
    this.slots = new Array<GuardEvent>(max);
  }

  /** Append an event, evicting the oldest once `max` is reached. */
  push(event: GuardEvent): void {
    const index = (this.start + this.count) % this.max;
    this.slots[index] = event;
    if (this.count < this.max) {
      this.count += 1;
    } else {
      // Full: the write above landed on the oldest slot, so advance past it.
      this.start = (this.start + 1) % this.max;
    }
  }

  /** True when no events are retained (e.g. nothing observed yet). */
  get size(): number {
    return this.count;
  }

  /**
   * The retained events in observation order, optionally narrowed by `filter`.
   *
   * Returns a copy, so a caller cannot mutate the ring by holding the result.
   */
  recent(filter?: RecentEventFilter): GuardEvent[] {
    const out: GuardEvent[] = [];
    for (let i = 0; i < this.count; i += 1) {
      const event = this.slots[(this.start + i) % this.max]!;
      if (!filter || matchesRecentFilter(event, filter)) out.push(event);
    }
    return out;
  }
}

export interface GuardTelemetryConfig {
  server: rpc.Server;
  /** The guard contract to follow. */
  guard: string;
  /** RPC URL, only used for error messages. */
  rpcUrl?: string;
  /**
   * Opt-in: retain the most recent events for `recent()` snapshots (issue #68).
   * Omitted → no buffer is allocated and `recent()` always returns `[]`.
   */
  buffer?: GuardEventBufferOptions;
}

export interface PollResult {
  events: GuardEvent[];
  /** Cursor to resume from, as returned by the RPC. */
  cursor: string;
  latestLedger: number;
  /**
   * Oldest ledger the RPC still retains, from the same response
   * (`Api.RetentionState.oldestLedger`).
   *
   * `null` when the host did not report it. Gap detection is skipped in that
   * case rather than guessed at: a proof needs the boundary.
   */
  oldestLedger: number | null;
}

/**
 * Why event coverage is known to have broken.
 *
 * Only one reason is produced today, and it is deliberately the *provable* one:
 * the RPC's own retention window moved past the listener, so the missing ledgers
 * can no longer be retrieved from it. See `docs/event-schema.md` for the rule.
 */
export type GuardTelemetryGapReason = "history_pruned";

/**
 * A provable gap in event coverage: a ledger range whose events are gone.
 *
 * `fromLedger..toLedger` (inclusive) is unrecoverable from the RPC that reported
 * it. The listener never fabricates events for the range — it announces the hole
 * and keeps streaming real events, because a silent gap in a security monitor is
 * worse than an announced one.
 */
export interface GuardTelemetryGap {
  /** First ledger that can no longer be retrieved (inclusive). */
  fromLedger: number;
  /** Last ledger that can no longer be retrieved (inclusive). */
  toLedger: number;
  reason: GuardTelemetryGapReason;
  /** `oldestLedger` of the response that detected the gap. */
  retainedFromLedger: number;
  /** `latestLedger` of that same response. */
  retainedToLedger: number;
}

/** The decision carried by a diagnostic auth event, as a telemetry record. */
export interface GuardTelemetryRecord {
  id: string;
  kind: GuardEventKind;
  topic: string;
  source: GuardEventSource;
  stream: GuardEventStream;
  contractId: string | null;
  ledger: number | null;
  ledgerClosedAt: string | null;
  observedAt: string | null;
  transactionHash: string | null;
  decision: GuardAuthDecision | null;
  data: unknown;
}

/**
 * Project a blocked decision into a telemetry record.
 *
 * This is the convenience wrapper for the diagnostic stream: the caller has
 * just seen a simulation fail and wants the guard's events from it as
 * telemetry records. Delegates to the canonical decode engine.
 */
export function telemetryFromDecision(
  diagnosticEvents: readonly unknown[],
  guard?: string,
): GuardTelemetryRecord[] {
  return diagnosticsToEvents(diagnosticEvents, guard).map((event) => ({
    id: event.id,
    kind: event.kind,
    topic: event.topic,
    source: event.source,
    stream: event.stream,
    contractId: event.contractId,
    ledger: event.ledger,
    ledgerClosedAt: event.ledgerClosedAt,
    observedAt: event.observedAt,
    transactionHash: event.transactionHash,
    decision: event.decision,
    data: event.data,
  }));
}

/**
 * The options a `GuardTelemetryListener` accepts.
 *
 * The RPC config is the shared `GuardServerConfig` from above, so the
 * listener, the preflight check, and `invoke` all consume the same shape.
 */
export interface GuardTelemetryOptions extends GuardServerConfig {
  /** The guard contract address to tail. */
  guard?: string;
  /** Poll interval in milliseconds for the ledger stream. */
  pollIntervalMs?: number;
  /** How many ledgers to look back on the first poll. */
  lookbackLedgers?: number;
  /**
   * Opt-in: retain the most recent events for `recent()` snapshots (issue #68).
   * Omitted → no buffer is allocated and `recent()` always returns `[]`.
   */
  buffer?: GuardEventBufferOptions;
}

/**
 * The telemetry listener.
 *
 * Construct with either a pre-built `SorobanRpc.Server` or an RPC URL; the
 * injected instance is used verbatim, which is the hook enterprise deployments
 * need to route RPC through a proxy.
 */
export class GuardTelemetryListener {
  private readonly server: rpc.Server;
  private readonly guard: string | undefined;
  private readonly pollIntervalMs: number;
  private readonly lookbackLedgers: number;
  /**
   * Null unless `options.buffer` is set: with no buffer requested, there is no
   * structure to allocate and every `recent()` call short-circuits (issue #68).
   */
  private readonly buffer: GuardEventRingBuffer | null;

  constructor(options: GuardTelemetryOptions) {
    this.server = resolveServerConfig(options);
    this.guard = options.guard;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.lookbackLedgers = options.lookbackLedgers ?? 100;
    this.buffer = options.buffer ? new GuardEventRingBuffer(options.buffer.max) : null;
  }

  /**
   * The most recent events the listener has observed, oldest first, optionally
   * narrowed by `filter` (issue #68). Empty when no `buffer` was configured.
   *
   * Only events this listener decoded are retained: committed events from
   * `poll()`/`watch()`, and diagnostic events merged in by `watchAll()`. A
   * consumer that never calls `watchAll()` sees no diagnostic half — the same
   * two-stream distinction the rest of the telemetry API makes.
   *
   * The buffer is in-process and non-durable; a restart empties it.
   */
  recent(filter?: RecentEventFilter): GuardEvent[] {
    return this.buffer ? this.buffer.recent(filter) : [];
  }

  /** Record decoded events into the opt-in buffer, if one is configured. */
  private record(events: readonly GuardEvent[]): void {
    if (!this.buffer) return;
    for (const event of events) this.buffer.push(event);
  }

  /** The `SorobanRpc.Server` this listener talks to (verbatim if injected). */
  serverInstance(): rpc.Server {
    return this.server;
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
        ? { filters: [{ type: "contract" as const, contractIds: [this.guard] }], cursor: params.cursor, limit: params.limit }
        : {
            filters: [{ type: "contract" as const, contractIds: [this.guard] }],
            startLedger: params.startLedger,
            limit: params.limit,
          }
    ) as rpc.Api.GetEventsRequest;

    if (!params.cursor && params.startLedger === undefined) {
      // Default to the current head: replaying a year of history by accident is
      // a mean surprise, and callers that want history pass `startLedger`.
      const latest = await this.server.getLatestLedger();
      (request as { startLedger: number }).startLedger = latest.sequence;
    }

    const response = await this.server.getEvents(request);
    const events: GuardEvent[] = [];
    for (const event of response.events) {
      const contractId = event.contractId ? String(event.contractId) : null;
      const decoded = interpret(
        event.topic.map((topic) => String(scValToNative(topic))),
        decodeData(event.value),
        {
          source: "ledger",
          contractId,
          ledger: event.ledger,
          ledgerClosedAt: event.ledgerClosedAt ?? null,
          transactionHash: event.txHash ?? null,
          // Committed events anchor on the transaction hash, not on a position
          // within a page: a page boundary would otherwise change an event's id.
          simulationIndex: null,
        },
      );
      if (decoded) events.push(decoded);
    }
    this.record(events);
    return {
      events,
      cursor: response.cursor,
      latestLedger: response.latestLedger,
      // Best-effort: a host that omits the retention boundary gets no gap
      // detection, rather than a boundary invented from `latestLedger`.
      oldestLedger: typeof response.oldestLedger === "number" ? response.oldestLedger : null,
    };
  }

  /**
   * Watch the committed ledger stream for guard events.
   *
   * This is the committed half of the two-stream model: a blocked decision
   * never appears here. Use `telemetryFromDecision` for the diagnostic half.
   */
  async *watch(): AsyncGenerabile<GuardEvent> {
    const response = await this.server.getEvents({});
    for (const raw of response.events ?? []) {
      const topics = topicSymbols(raw);
      if (topics.length === 0) continue;
      const decoded = interpret(topics, decodData(dataOf(raw)), {
        source: "ledger",
        contractId: raw.contractId ?? this.guard ?? null,
        ledger: raw.ledger ?? null,
        ledgerClosedAt: raw.ledgerClosedAt ?? null,
        transactionHash: raw.txHash ?? null,
        simulationIndex: null,
      });
      if (decoded) yield decoded;
    }
  }

  /**
   * Watch both streams and yield them as one unified iterator.
   *
   * The committed stream is tailed from the listener's server; the diagnostic
   * stream is fed by the caller via `telemetryFromDecision` when a simulation
   * fails. This method only exposes the committed half unless the caller passes
   * extra diagnostic events in.
   */
  async *watchAll(
    params: GuardTelemetryUnifiedParams = {},
  ): AsyncGenerator<GuardEvent, void, undefined> {
    if (params.signal?.aborted) return;
    for await (const event of mergeGuardEventStreams(
      this.watch(params),
      params.diagnostics,
      params.signal,
    )) {
      // Committed events were already recorded when their page was decoded in
      // `poll()`, so only the diagnostic half is recorded here — recording the
      // merged stream wholesale would double every committed event.
      if (event.stream === "diagnostic") this.record([event]);
      yield event;
    }
  }
}