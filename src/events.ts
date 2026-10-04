/**
 * The guard contract's event vocabulary, as confirmed against the chain.
 *
 * This table is not copied from documentation. Phase 2.2 captured real events
 * from the live testnet instance and the topic names disagree with the docs:
 * `stellar-agent-guard-contracts` describes the decision event as
 * `auth_checked` (SPEC §9, `tests/fixtures/README.md` line 86), but Soroban's
 * `#[contractevent]` macro prepends `event_`, and the contract's own fixture log
 * already shows the real name. The live capture proves which one the chain
 * emits:
 *
 *   [Contract Event] topics: [event_auth_checked, blocked, per_tx_cap_exceeded]
 *
 * So every topic here carries the `event_` prefix, matching
 * `stellar-agent-guard-contracts/src/lib.rs`:
 *
 *   #[contractevent] struct EventAuthChecked    => topic[0] = event_auth_checked
 *   #[contractevent] struct EventHeartbeat      => topic[0] = event_heartbeat
 *   #[contractevent] struct EventInitialized    => topic[0] = event_initialized
 *   #[contractevent] struct EventFrozen         => topic[0] = event_frozen
 *   #[contractevent] struct EventUnfrozen       => topic[0] = event_unfrozen
 *   #[contractevent] struct EventPolicySet      => topic[0] = event_policy_set
 *   #[contractevent] struct EventPolicyRevoked  => topic[0] = event_policy_revoked
 *
 * Topic layout for the decision event (the `#[topic]` fields follow the macro's
 * own name): `[event_auth_checked, <allowed|blocked>, <reason symbol>]`. The
 * event carries no data payload (`data: {}`) — the reason lives in the topics,
 * which is why a listener can filter on one vocabulary without decoding bodies.
 *
 * Two details a listener must get right, both observed in the live capture and
 * neither obvious from the docs:
 *
 *   1. On an *allowed* decision the third topic is present but is the **empty
 *      symbol** `""` — not omitted, not null. `decodeAuthDecision` normalises it
 *      to a null reason so callers do not have to know that.
 *   2. A heartbeat is a *separate* event (`event_heartbeat`) whose only topic is
 *      its name; the unix-second timestamp arrives as event **data**, not as a
 *      topic: `data = { at: u64 }`.
 */
import { scValToNative, xdr } from "@stellar/stellar-sdk";
import type { GuardReason } from "./reasons.ts";

export const GUARD_EVENT_TOPICS = {
  /** Every policy decision, in-path and pre-flight. */
  authChecked: "event_auth_checked",
  /** Agent liveness signal; data is the unix-second `at`. */
  heartbeat: "event_heartbeat",
  /** Admin lifecycle events; data is the acting admin `by`. */
  initialized: "event_initialized",
  frozen: "event_frozen",
  unfrozen: "event_unfrozen",
  policySet: "event_policy_set",
  policyRevoked: "event_policy_revoked",
} as const;

/** Index 1 of an `event_auth_checked` topic list: the decision. */
export const GUARD_AUTH_RESULTS = {
  allowed: "allowed",
  blocked: "blocked",
} as const;

export type GuardAuthResult =
  (typeof GUARD_AUTH_RESULTS)[keyof typeof GUARD_AUTH_RESULTS];

/**
 * A guard decision decoded from one contract event, in the shape a telemetry
 * consumer wants. `reason` is only meaningful when `result` is `blocked`, but a
 * rejected transaction rolls back the event, so a blocked decision usually
 * arrives from an enforced simulation's diagnostic events rather than from a
 * ledger.
 */
export interface GuardAuthDecision {
  result: GuardAuthResult;
  reason: GuardReason | null;
  /** Where the event was observed: a committed ledger event, or a pre-broadcast diagnostic. */
  source: "ledger" | "diagnostic";
}

/**
 * Interpret one decoded topic list as a guard decision.
 *
 * Returns null for anything that is not an `event_auth_checked` event, so a
 * caller (and the policy classifier in `invoke.ts`) can distinguish the guard
 * refusing a call from a contract trap that merely looks like a failure.
 *
 * The topic name is matched on the confirmed `event_auth_checked` symbol. The
 * documentation's un-prefixed `auth_checked` is intentionally *not* accepted:
 * tolerating both would hide exactly the drift this module exists to catch.
 */
export function decodeAuthDecision(
  topics: readonly string[],
  source: GuardAuthDecision["source"],
): GuardAuthDecision | null {
  if (topics[0] !== GUARD_EVENT_TOPICS.authChecked) return null;
  const result = topics[1];
  if (result !== GUARD_AUTH_RESULTS.allowed && result !== GUARD_AUTH_RESULTS.blocked) {
    return null;
  }
  // An allowed decision carries the empty symbol as its reason; treat that as
  // "no reason" rather than surfacing `""` to operators.
  const rawReason = topics[2];
  // The contract's reason vocabulary is a closed set (`GuardReason`, derived
  // from `src/reasons.ts`, and pinned to the vendored fixture by
  // `tests/unit/reasons.test.ts`). A symbol outside it is drift the fixture test
  // catches in CI, so the decoded value is surfaced as-is rather than silently
  // dropped here.
  const reason = rawReason && rawReason.length > 0 ? (rawReason as GuardReason) : null;
  return { result, reason, source };
}


/**
 * Normalise a numeric value delivered as a string in an event payload.
 *
 * u64 values arrive as strings in JSON payloads. This centralizes the decision
 * to parse them as BigInt (which never loses precision for >2^53) if they consist
 * entirely of digits, while leaving other strings (like ISO timestamps) intact.
 */
export function normalizeU64(value: string): bigint | string {
  if (/^\d+$/.test(value)) {
    return BigInt(value);
  }
  return value;
}

/** Recursively normalise u64 strings in event data. */
export function normalizeEventData(data: unknown): unknown {
  if (typeof data === "string") {
    return normalizeU64(data);
  }
  if (Array.isArray(data)) {
    return data.map(normalizeEventData);
  }
  if (data !== null && typeof data === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = normalizeEventData(value);
    }
    return result;
  }
  return data;
}

/**
 * Decode one topic of a contract event into its symbol text.
 *
 * Topics reach this module in two shapes depending on the caller: as a
 * base64-encoded `xdr.ScVal` string (what a block explorer, a CI fixture, or
 * `getEvents` over JSON hands over) or as an already-decoded `xdr.ScVal`. Both
 * go through `scValToNative` so the text is identical either way.
 *
 * Returns `null` for anything that does not decode, rather than throwing, so a
 * single unrecognised topic rejects the event instead of killing the caller.
 */
function topicToSymbol(topic: unknown): string | null {
  try {
    if (typeof topic === "string") {
      return String(scValToNative(xdr.ScVal.fromXDR(topic, "base64")));
    }
    return String(scValToNative(topic as xdr.ScVal));
  } catch {
    return null;
  }
}

/**
 * Pull the topic list out of a decoded `xdr.ContractEvent` or
 * `xdr.DiagnosticEvent`.
 *
 * A `DiagnosticEvent` wraps the contract event in its `event` field; a
 * `ContractEvent` carries `body.v0.topics` directly.
 */
function topicsFromEvent(event: unknown): string[] | null {
  const wrapper = event as {
    event?: { body?: unknown };
    body?: { v0?: { topics?: unknown[] }; value?: { v0?: { topics?: unknown[] } } };
  } | null;
  const body = (wrapper?.event?.body ?? wrapper?.body) as
    | { v0?: { topics?: unknown[] }; value?: { v0?: { topics?: unknown[] } } }
    | undefined;
  const topics = body?.v0?.topics ?? body?.value?.v0?.topics;
  if (!Array.isArray(topics)) return null;

  const out: string[] = [];
  for (const topic of topics) {
    const symbol = topicToSymbol(topic);
    if (symbol === null) return null;
    out.push(symbol);
  }
  return out;
}

/**
 * Decode a guard decision from a raw base64 XDR string.
 *
 * This is the offline-tooling entry point: an event XDR pasted from a block
 * explorer, committed as a CI fixture, or dumped while debugging a live
 * incident goes through the same decision decoder as an event observed from a
 * stellar-sdk response, so the two can never drift apart.
 *
 * Accepts either a base64 `DiagnosticEvent` (what `server.getEvents()` and a
 * simulation error carry) or a base64 `ContractEvent` (what a block explorer
 * exposes). The returned `source` therefore defaults to `diagnostic`, since
 * that is the shape the enforced-simulation path produces; pass `"ledger"` when
 * the payload was read from a committed ledger.
 *
 * Returns `null` — never throws — for a malformed base64 string, an XDR that is
 * not a contract event, or an event that is not an `event_auth_checked`
 * decision. That is documented behaviour: fixture checks and operator
 * copy-paste must not be able to crash a long-running process.
 */
export function decodeGuardEventXdr(
  xdrBase64: string,
  source: GuardAuthDecision["source"] = "diagnostic",
): GuardAuthDecision | null {
  if (typeof xdrBase64 !== "string" || xdrBase64.length === 0) return null;

  let event: unknown;
  try {
    event = xdr.DiagnosticEvent.fromXDR(xdrBase64, "base64");
  } catch {
    try {
      event = xdr.ContractEvent.fromXDR(xdrBase64, "base64");
    } catch {
      return null;
    }
  }

  const topics = topicsFromEvent(event);
  if (!topics) return null;
  return decodeAuthDecision(topics, source);
}
