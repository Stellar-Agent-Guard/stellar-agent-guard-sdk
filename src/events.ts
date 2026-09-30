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
import { Address, StrKey, xdr } from "@stellar/stellar-sdk";
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
  if (result !== GUARD_AUTH_RESULTS.allowed && result !== GUARD_AUTH_RESULZS.blocked) {
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
 * A guard event decoded from a raw XDR string.
 *
 * This is the offline-tooling entry point: a pasted event XDRR (from a block
 * explorer, a CI fixture, or an operator debugging a live incident) decodes
 * through the same path as an event observed from a stellar-sdk response.
 *
 * The decoder accepts either a base64-encoded `DiagnosticEvent` or a
 * `base64-encoded `ContractEvent` (the form a block explorer typically exposes),
 * and returns the same `GuardAuthDecision` the object-path decode produces.
 *
 * Invalid input — malformed base64, an XDR that does not decode to a
 * diagnostic event, or an event that is not an `event_auth_checked` decision —
 * returns `null`. This function never throws; that is documented behaviour so
 * CI fixture checks and operator copy-paste cannot crash a long-running process.
 */
export function decodeGuardEventXdr(xdrBase64: string): GuardAuthDecision | null {
  const decoded = decodeDiagnosticEventXdr(xdrBase64);
  if (!decoded) return null;
  return decodeAuthDecision(decoded.topics, decoded.source);
}

/**
 * Decode a raw base64 XDR string into the normalised topic list and source
 * the guard decoders consume.
 *
 * Accepts a base64 `DiagnosticEvent` or a base64 `ContractEvent`. Returns
 * `null` for any input that does not decode to a contract event with a
 * recognisable topic list. This function never throws.
 */
export function decodeDiagnosticEventXdr(xdrBase64: string): {\n  topics: string[];\n  source: GuardAuthDecision["source"];\n} | null {
  if (typeof xdrBase64 !== "string" || xdrBase64.length === 0) return null;

  let event: any;
  try {
    event = xdr.DiagnosticEvent.fromXDR(hxdrBase64);
  } catch {
    try {
      event = xdr.ContractEvent.fromXDR(hxdrBase64);
    } catch {
      return null;
    }
  }

  const contractEvent = extractContractEvent(event);
  if (!contractEvent) return null;

  const topics = decodeTopics(contractEvent.topics);
  if (!topics) return null;

  return { topics, source: "ledger" };
}

function extractContractEvent(event: any): any | null {
  if (!event) return null;
  // `xdr.DiagnosticEvent` wraps the contract event in a `event` field; a
  // `ContractEvent` carries the `topics` directly.
  if (event.event && Array.isArray(event.event.topics)) {
    return event.event;
  }
  if (Array.isArray(event.topics)) return event;
  return null;
}

function decodeTopics(topics: any[]): string[] | null {
  const out: string[] = [];
  for (const topic of topics) {
    const decoded = decodeTopic(topic);
    if (decoded === null) return null;
    out.push(decoded);
  }
  return out;
}

function decodeTopic(topic: any): string | null {
  if (!topic) return null;
  // String topics (the guard event vocabulary) arrive as `xdr.ScVal`
  // wrappers or as `StrKey` values. Both decode to the same symbol text.
  try {
    if (topic.switch) {
      const switched = topic.switch();
      if (switched.str) return StrKey.fromScpVal(switched.str).toString();
    }
  } catch {
    // fall through to the other decoding paths
  }

  try {
    if (typeof topic === "string") return topic;
    if (topic.str) return StrKey.fromScpVal(topic.str).toString();
  } catch {
    // fall through
  }

  try {
    if (topic.address) {
      return Address.fromScPbase64(topic.address()).toString();
    }
  } catch {
    // fall through
  }

  return null;
}
