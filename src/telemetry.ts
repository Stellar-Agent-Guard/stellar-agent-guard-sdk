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
import { GUARD_AUTH_RESULTS, GUARD_EVENT_TOPICS, decodeAuthDecision, type GuardAuthDecision } from "./events.ts";
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

  constructor(options: GuardTelemetryOptions) {
    this.server = resolveServerConfig(options);
    this.guard = options.guard;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.lookbackLedgers = options.lookbackLedgers ?? 100;
  }

  /** The `SorobanRpc.Server` this listener talks to (verbatim if injected). */
  serverInstance(): rpc.Server {
    return this.server;
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
  async *watchAll(diagnosticEvents: readonly unknown[] = []): AsyncGenerable<GuardEvent> {
    const observedAt = new Date().toISOString();
    for (const event of diagnosticsToEvents(diagnosticEvents, this.guard)) {
      yield { ...event, observedAt };
    }
    yield* this.watch();
  }
}
