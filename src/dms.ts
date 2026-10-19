/**
 * Client-side dead-man-switch urgency (issue #132).
 *
 * Dashboards need a countdown colour now, ahead of a contract-side
 * `dms_health`. This module derives it from the same inputs and the same edge
 * semantics as {@link deadManRemaining}, so the two helpers can never disagree
 * about whether a countdown exists. It is a display helper only: nothing on the
 * authorization path reads it.
 */
import { deadManRemaining, isDeadManFrozen } from "./policy.ts";
import type { GuardStatus, ReadonlyPolicyConfig } from "./policy.ts";

/**
 * Default fraction of the grace period after which a countdown is `"warn"`.
 *
 * Exported as the single shared number: a future contract-side `dms_health`
 * or the dashboard should reference this constant rather than re-typing 0.8,
 * so a parity test can compare one value across repos.
 */
export const DMS_WARN_RATIO_DEFAULT = 0.8;

/**
 * - `"ok"`: inside the grace period, below the warn threshold.
 * - `"warn"`: at or past `warnRatio` of the grace period, not yet expired.
 * - `"expired"`: the grace period has run out (the dead-man switch has fired).
 * - `"unknown"`: there is no countdown to judge — see {@link dmsUrgency}.
 */
export type DmsUrgency = "ok" | "warn" | "expired" | "unknown";

/** Basis-point scale for the ratio comparison, so it stays in exact bigint math. */
const RATIO_SCALE = 10_000n;

/**
 * Tri-state (plus `"unknown"`) urgency of the dead-man-switch countdown.
 *
 * **Inherited semantics.** `"unknown"` is returned exactly when
 * {@link deadManRemaining} returns `null`, and for the same documented reasons
 * (SPEC §3 / §5 rule #2, as recorded on `deadManRemaining`):
 *
 * - no policy installed;
 * - the switch is disabled (`dms_grace_secs == 0`) — there is no countdown, so
 *   it is neither healthy nor overdue;
 * - the agent has never heartbeated (`last_heartbeat == 0`, "0 = never") —
 *   "never ≠ expired", so this must never render as overdue.
 *
 * Otherwise, with `elapsed = now - last_heartbeat`:
 *
 * - `"expired"` once the remaining grace is `<= 0` — the account is frozen
 *   "the moment the grace elapses" (SPEC §5), so exactly 100% elapsed is
 *   already expired, matching the boundary pinned for `deadManRemaining` — or
 *   when the contract already reports it dead-man-frozen ({@link isDeadManFrozen});
 * - `"warn"` when `elapsed >= warnRatio * dms_grace_secs`;
 * - `"ok"` otherwise, including a `now` earlier than the last heartbeat.
 *
 * @param nowSecs Overrides `status.now` (e.g. a ticking UI clock between polls).
 * @param warnRatio Fraction of the grace period that starts `"warn"`; must be in
 *   `(0, 1]`. Compared at basis-point precision.
 * @throws RangeError if `warnRatio` is not a finite number in `(0, 1]`.
 */
export function dmsUrgency(
  status: GuardStatus,
  policy: ReadonlyPolicyConfig | null,
  nowSecs?: bigint,
  warnRatio: number = DMS_WARN_RATIO_DEFAULT,
): DmsUrgency {
  if (!Number.isFinite(warnRatio) || warnRatio <= 0 || warnRatio > 1) {
    throw new RangeError(`warnRatio must be in (0, 1], got ${warnRatio}`);
  }

  const now = nowSecs ?? status.now;
  const remaining = deadManRemaining({ ...status, now }, policy);
  if (remaining === null || policy === null) return "unknown";

  if (remaining <= 0n || isDeadManFrozen(status)) return "expired";

  const elapsed = now - status.last_heartbeat;
  const ratioBps = BigInt(Math.round(warnRatio * Number(RATIO_SCALE)));
  if (elapsed * RATIO_SCALE >= ratioBps * policy.dms_grace_secs) return "warn";
  return "ok";
}
