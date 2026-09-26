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
 */
import { createHash } from "node:crypto";
import { rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
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
   * on the ledger stream. This is the component that keeps two *distinct*
   * blocks within one simulation from colliding.
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
 * should combine `id` with its own attempt counter instead of expecting a
 * unique key per refusal. Within one batch, SHA-256 plus the position makes
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
export type GuardEventContext = Omit<GuardEvent, "kind" | "topic" | "id" | "decision" | "data"> & {
  /** Position within the diagnostic batch; null on the ledger stream. */
  simulationIndex: number | null;
};

/** Interpret an already-decoded topic list plus data as a `GuardEvent`. */
function interpret(
  topics: string[],
  data: unknown,
  context: GuardEventContext,
): GuardEvent | null {
  const topic = topics[0];
  if (!topic || !KNOWN_TOPICS.has(topic)) return null;
  const { simulationIndex, ...streamFacts } = context;
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

/**
 * Durable storage for a `watch()` cursor, so a restarted listener resumes where
 * the previous one stopped instead of silently re-reading history or skipping a
 * gap.
 *
 * The interface is intentionally two methods wide: `load()` for the cursor the
 * previous process persisted, `save()` for the cursor each poll produces. A
 * caller wires it to anything that outlives the process — a file, Redis,
 * SQLite, a database row — by implementing these two calls over that store:
 *
 * ```ts
 * import { readFile, writeFile } from "node:fs/promises";
 *
 * const fileCursorStore: CursorStore = {
 *   async load() {
 *     try {
 *       return await readFile("guard-cursor.txt", "utf8");
 *     } catch {
 *       return null; // first run: nothing persisted yet
 *     }
 *   },
 *   async save(cursor) {
 *     await writeFile("guard-cursor.txt", cursor, "utf8");
 *   },
 * };
 * ```
 *
 * Delivery is **at-least-once**: events committed between the last `save()` and
 * the crash are re-fetched and re-emitted on resume (and `save()` runs before
 * the page is yielded, so a consumer that dies *after* processing but *before*
 * the next save can also see a page twice within one process). Deduplicate by a
 * stable event identity — for ledger events the `(ledger, transactionHash)`
 * pair is the available fallback until a dedicated stable id ships — and never
 * assume a cursor in the store has already been fully drained.
 */
export interface CursorStore {
  /**
   * Return the cursor to resume from, or `null` when nothing has been
   * persisted yet (first run). Consulted once, when `watch()` starts.
   */
  load(): Promise<string | null>;
  /** Persist the cursor advanced by one poll. Called once per poll. */
  save(cursor: string): Promise<void>;
}

/**
 * The default `CursorStore`: process memory.
 *
 * It keeps `watch()`'s existing behaviour when no `cursorStore` is configured —
 * the cursor lives exactly as long as the listener instance, so a restart starts
 * from the default position again. It is *not* durable; passing nothing and
 * expecting resume-after-restart is the bug this interface exists to prevent.
 */
export class InMemoryCursorStore implements CursorStore {
  private cursor: string | null = null;

  async load(): Promise<string | null> {
    return this.cursor;
  }

  async save(cursor: string): Promise<void> {
    this.cursor = cursor;
  }
}

export interface GuardTelemetryConfig {
  server: rpc.Server;
  /** The guard contract to follow. */
  guard: string;
  /** RPC URL, only used for error messages. */
  rpcUrl?: string;
  /**
   * Where `watch()` persists its cursor. Default: `InMemoryCursorStore`, i.e.
   * no resume across process restarts. Pass a store backed by something that
   * outlives the process (file, Redis, …) for durable resume.
   */
  cursorStore?: CursorStore;
}

export interface PollResult {
  events: GuardEvent[];
  /** Cursor to resume from, as returned by the RPC. */
  cursor: string;
  latestLedger: number;
}

export class GuardTelemetryListener {
  private readonly config: GuardTelemetryConfig;
  /** Never null: the constructor substitutes the in-memory default. */
  private readonly cursorStore: CursorStore;

  constructor(config: GuardTelemetryConfig) {
    this.config = config;
    this.cursorStore = config.cursorStore ?? new InMemoryCursorStore();
  }

  /** The store this listener persists its cursor to. Exposed for inspection. */
  get activeCursorStore(): CursorStore {
    return this.cursorStore;
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
    return { events, cursor: response.cursor, latestLedger: response.latestLedger };
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

    // An explicit `startLedger` is the caller pinning a position; only when it
    // is absent does the persisted cursor get a say. A stored cursor then wins
    // over the default head position, because resume-after-restart is exactly
    // the case where "the default" re-reads history or skips a gap.
    if (startLedger === undefined) {
      const stored = await this.cursorStore.load();
      if (stored !== null) {
        cursor = stored;
      } else {
        const latest = await this.config.server.getLatestLedger();
        startLedger = Math.max(1, latest.sequence - 1);
        cursor = undefined;
      }
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
      // Persist before yielding: a consumer that stops after this page (crash,
      // abort, throw) resumes from this page's cursor and at worst re-processes
      // it — at-least-once — rather than losing everything after it.
      await this.cursorStore.save(page.cursor);
      if (page.events.length > 0) yield page.events;
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
  const where = event.source === "ledger" ? `ledger ${event.ledger ?? "?"}` : "pre-broadcast";
  const what =
    event.kind === "auth_checked"
      ? `${event.decision?.result ?? "?"}${event.decision?.reason ? ` (${event.decision.reason})` : ""}`
      : event.kind;
  return `${where}: ${event.topic} → ${what}`;
}
