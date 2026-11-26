/**
 * Cross-field interaction matrix (issue #443).
 *
 * The guard's verdict is not a set of independent field checks: SPEC §4 fixes a
 * gate order (`paused` before the dead-man freeze before the active window
 * before the spend caps), so `paused` must not be confused with a DMS freeze,
 * and a scheduled window must not be read as an expired one. Individual field
 * tests cannot prove the combined verdict.
 *
 * This matrix walks `paused` × DMS state × active-window state × per-tx cap and
 * asserts, for every combination:
 *
 *  - the local signals the SDK does expose (`dmsUrgency`, `deadManRemaining`,
 *    `describePolicy`) agree with that combination;
 *  - the contract reason and the decoded verdict match the SPEC gate order;
 *  - a combination whose contract payload the SDK cannot read fails closed.
 *
 * The verdict itself is the contract's: the SDK never evaluates paused/DMS/
 * window locally, because doing so from a stale snapshot would be a weaker
 * check than the chain's. `decodeCheckResult` is the only local path from a
 * contract verdict to a decision, and it is total.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dmsUrgency } from "../../src/dms.ts";
import {
  deadManRemaining,
  decodeCheckResult,
  describePolicy,
  unsafeAccountAddress,
  unsafeContractAddress,
  type GuardStatus,
  type PolicyConfig,
} from "../../src/policy.ts";
import type { GuardReason } from "../../src/reasons.ts";

const TOKEN = unsafeContractAddress("CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB");
const RECIPIENT = unsafeAccountAddress("GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH");

type DmsState = "disabled" | "never" | "ok" | "warn" | "expired";
type WindowState = "unbounded" | "scheduled" | "active" | "expired";
type CapState = "within" | "over";

const DMS_STATES: readonly DmsState[] = ["disabled", "never", "ok", "warn", "expired"];
const WINDOW_STATES: readonly WindowState[] = ["unbounded", "scheduled", "active", "expired"];
const CAP_STATES: readonly CapState[] = ["within", "over"];

const GRACE = 100n;
const HEARTBEAT = 1000n;
const WINDOW_FROM = 1_000_000n;
const WINDOW_UNTIL = 1_002_000n;
const PER_TX_CAP = 500n;

/**
 * The contract's gate order, transcribed from SPEC §4:
 *
 * 1. `paused` blocks every authorization first.
 * 2. An expired dead-man switch freezes the account (`heartbeat_expired`);
 *    an admin freeze is a separate state and is not part of this matrix.
 * 3. A policy outside its active window is blocked (`outside_active_window`),
 *    whether the window has not opened yet or has already closed.
 * 4. The per-transaction cap is the first spend gate (`per_tx_cap_exceeded`).
 *
 * Rows that pass every gate are `Allowed`.
 */
function contractReason(
  paused: boolean,
  dms: DmsState,
  window: WindowState,
  cap: CapState,
): GuardReason | null {
  if (paused) return "paused";
  if (dms === "expired") return "heartbeat_expired";
  if (window === "scheduled" || window === "expired") return "outside_active_window";
  if (cap === "over") return "per_tx_cap_exceeded";
  return null;
}

function policyFor(paused: boolean, dms: DmsState, window: WindowState): PolicyConfig {
  return {
    per_tx_cap: PER_TX_CAP,
    window_secs: 3_600n,
    window_cap: 5_000n,
    assets: [TOKEN],
    protocols: [],
    recipients: [RECIPIENT],
    allow_any_recipient: false,
    ...(window === "unbounded"
      ? { active_from: 0n, active_until: 0n }
      : { active_from: WINDOW_FROM, active_until: WINDOW_UNTIL }),
    paused,
    dms_grace_secs: dms === "disabled" ? 0n : GRACE,
  };
}

function statusFor(dms: DmsState): { status: GuardStatus; now: bigint } {
  const now =
    dms === "ok"
      ? HEARTBEAT + 10n
      : dms === "warn"
        ? HEARTBEAT + 90n
        : dms === "expired"
          ? HEARTBEAT + GRACE
          : HEARTBEAT;
  return {
    status: {
      has_policy: true,
      admin_frozen: false,
      heartbeat_expired: dms === "expired",
      last_heartbeat: dms === "never" || dms === "disabled" ? 0n : HEARTBEAT,
      now,
    },
    now,
  };
}

function windowNow(window: WindowState): bigint {
  switch (window) {
    case "unbounded":
    case "active":
      return WINDOW_FROM + 1_000n;
    case "scheduled":
      return WINDOW_FROM - 1n;
    case "expired":
      return WINDOW_UNTIL;
  }
}

/** The urgency the local helper must report for each DMS state. */
function expectedUrgency(dms: DmsState): "ok" | "warn" | "expired" | "unknown" {
  return dms === "disabled" || dms === "never" ? "unknown" : dms;
}

describe("paused × DMS × active window × per-tx cap matrix (issue #443)", () => {
  for (const paused of [false, true]) {
    for (const dms of DMS_STATES) {
      for (const window of WINDOW_STATES) {
        for (const cap of CAP_STATES) {
          const id = `paused=${paused} dms=${dms} window=${window} cap=${cap}`;
          it(`${id} → ${contractReason(paused, dms, window, cap) ?? "allowed"}`, () => {
            const policy = policyFor(paused, dms, window);
            const { status } = statusFor(dms);
            const now = windowNow(window);
            const reason = contractReason(paused, dms, window, cap);

            // ── Local signals the SDK exposes ───────────────────────────────
            assert.equal(dmsUrgency(status, policy), expectedUrgency(dms));

            const remaining = deadManRemaining(status, policy);
            if (expectedUrgency(dms) === "unknown") {
              assert.equal(remaining, null, "no countdown for disabled/never-heartbeated");
            } else if (dms === "expired") {
              assert.ok(remaining !== null && remaining <= 0n, "the grace has elapsed");
            } else {
              assert.ok(remaining !== null && remaining > 0n, "still inside the grace period");
            }

            const summary = describePolicy(policy, { nowSecs: now });
            assert.equal(
              summary.includes("PAUSED"),
              paused,
              "the summary must distinguish an admin pause",
            );
            if (window === "unbounded") {
              assert.match(summary, /no active window/);
            } else {
              assert.match(summary, new RegExp(`\\(${window}\\)`));
            }

            // ── The contract's verdict, as the SDK decodes it ───────────────
            if (reason === null) {
              assert.deepEqual(decodeCheckResult(["Allowed"]), { kind: "allowed" });
            } else {
              assert.deepEqual(decodeCheckResult(["Blocked", reason]), {
                kind: "blocked",
                reason,
              });
            }
          });
        }
      }
    }
  }

  it("distinguishes an admin pause from a dead-man freeze in the same state", () => {
    const expiredStatus = statusFor("expired").status;
    const pausedPolicy = policyFor(true, "expired", "active");
    const unpausedPolicy = policyFor(false, "expired", "active");
    assert.equal(contractReason(true, "expired", "active", "within"), "paused");
    assert.equal(contractReason(false, "expired", "active", "within"), "heartbeat_expired");
    assert.equal(dmsUrgency(expiredStatus, pausedPolicy), "expired");
    assert.equal(dmsUrgency(expiredStatus, unpausedPolicy), "expired");
    assert.match(describePolicy(pausedPolicy, { nowSecs: WINDOW_FROM + 1_000n }), /PAUSED/);
    assert.doesNotMatch(
      describePolicy(unpausedPolicy, { nowSecs: WINDOW_FROM + 1_000n }),
      /PAUSED/,
    );
  });

  it("distinguishes a scheduled window from an expired one", () => {
    const scheduled = policyFor(false, "disabled", "scheduled");
    const expired = policyFor(false, "disabled", "expired");
    assert.match(describePolicy(scheduled, { nowSecs: windowNow("scheduled") }), /\(scheduled\)/);
    assert.match(describePolicy(expired, { nowSecs: windowNow("expired") }), /\(expired\)/);
    assert.notEqual(
      describePolicy(scheduled, { nowSecs: windowNow("scheduled") }),
      describePolicy(expired, { nowSecs: windowNow("expired") }),
    );
  });

  it("fails closed for contract payloads the SDK cannot interpret locally", () => {
    // No simulation result, a future/unknown reason, a malformed enum, and a
    // non-ScVal value: none may be reported as allowed or blocked.
    for (const payload of [
      undefined,
      null,
      "Blocked",
      ["Blocked"],
      ["Blocked", 13],
      ["Blocked", "future_reason"],
      ["UnknownVariant"],
      { Blocked: "future_reason" },
    ]) {
      assert.deepEqual(
        decodeCheckResult(payload),
        { kind: "undetermined" },
        `payload ${JSON.stringify(payload)} must fail closed`,
      );
    }
  });
});
