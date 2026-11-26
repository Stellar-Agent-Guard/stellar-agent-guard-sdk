/**
 * `dmsUrgency` (issue #132): tri-state dead-man-switch urgency.
 *
 * The 79% / 80% / 100% / 101% points and the `"unknown"` edge cases mirror the
 * `deadManRemaining` grace-boundary suite in `policy.test.ts`, whose semantics
 * this helper inherits (never-heartbeated and disabled switch → no countdown;
 * frozen "the moment the grace elapses", SPEC §5).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DMS_WARN_RATIO_DEFAULT, dmsUrgency, formatDmsCountdown } from "../../src/dms.ts";
import {
  deadManRemaining,
  unsafeAccountAddress,
  unsafeContractAddress,
  type GuardStatus,
  type PolicyConfig,
} from "../../src/policy.ts";
import * as sdk from "../../src/index.ts";

const TOKEN = unsafeContractAddress("CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB");
const RECIPIENT = unsafeAccountAddress("GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH");

function policy(dms_grace_secs: bigint): PolicyConfig {
  return {
    per_tx_cap: 1000n,
    window_secs: 60n,
    window_cap: 150n,
    assets: [TOKEN],
    protocols: [],
    recipients: [RECIPIENT],
    allow_any_recipient: false,
    active_from: 0n,
    active_until: 0n,
    paused: false,
    dms_grace_secs,
  };
}

const status = (overrides: Partial<GuardStatus> = {}): GuardStatus => ({
  has_policy: true,
  admin_frozen: false,
  heartbeat_expired: false,
  last_heartbeat: 1000n,
  now: 1000n,
  ...overrides,
});

const grace = 100n;
const at = (percentElapsed: bigint): GuardStatus =>
  status({ now: 1000n + (grace * percentElapsed) / 100n });

describe("dmsUrgency", () => {
  it("exports one shared default warn ratio", () => {
    assert.equal(DMS_WARN_RATIO_DEFAULT, 0.8);
    assert.equal(sdk.DMS_WARN_RATIO_DEFAULT, DMS_WARN_RATIO_DEFAULT);
    assert.equal(sdk.dmsUrgency, dmsUrgency);
  });

  describe("default warn ratio (0.8)", () => {
    const p = policy(grace);
    it("is ok at 0% and 79% elapsed", () => {
      assert.equal(dmsUrgency(at(0n), p), "ok");
      assert.equal(dmsUrgency(at(79n), p), "ok");
    });
    it("is warn at exactly 80% and at 99% elapsed", () => {
      assert.equal(dmsUrgency(at(80n), p), "warn");
      assert.equal(dmsUrgency(at(99n), p), "warn");
    });
    it("is expired at exactly 100% (frozen the moment grace elapses) and at 101%", () => {
      assert.equal(deadManRemaining(at(100n), p), 0n);
      assert.equal(dmsUrgency(at(100n), p), "expired");
      assert.equal(dmsUrgency(at(101n), p), "expired");
    });
  });

  describe("custom warn ratio", () => {
    const p = policy(grace);
    it("moves the warn threshold", () => {
      assert.equal(dmsUrgency(at(49n), p, undefined, 0.5), "ok");
      assert.equal(dmsUrgency(at(50n), p, undefined, 0.5), "warn");
      assert.equal(dmsUrgency(at(80n), p, undefined, 0.9), "ok");
    });
    it("with ratio 1 never warns before expiry", () => {
      assert.equal(dmsUrgency(at(99n), p, undefined, 1), "ok");
      assert.equal(dmsUrgency(at(100n), p, undefined, 1), "expired");
    });
    it("rejects ratios outside (0, 1]", () => {
      for (const bad of [0, -0.1, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.throws(() => dmsUrgency(at(10n), p, undefined, bad), RangeError, String(bad));
      }
    });
  });

  describe("unknown: inherits deadManRemaining's null cases", () => {
    it("never-heartbeated account is unknown, never expired (SPEC §5 rule #2)", () => {
      const fresh = status({ last_heartbeat: 0n, now: 9_999_999n, heartbeat_expired: true });
      assert.equal(deadManRemaining(fresh, policy(grace)), null);
      assert.equal(dmsUrgency(fresh, policy(grace)), "unknown");
    });
    it("disabled switch (grace 0) is unknown", () => {
      assert.equal(deadManRemaining(at(500n), policy(0n)), null);
      assert.equal(dmsUrgency(at(500n), policy(0n)), "unknown");
    });
    it("no policy is unknown", () => {
      assert.equal(dmsUrgency(at(10n), null), "unknown");
    });
  });

  it("nowSecs overrides status.now", () => {
    const p = policy(grace);
    assert.equal(dmsUrgency(at(10n), p, 1085n), "warn");
    assert.equal(dmsUrgency(at(10n), p, 1100n), "expired");
  });

  it("a clock earlier than the last heartbeat reads ok", () => {
    assert.equal(dmsUrgency(status({ now: 900n }), policy(grace)), "ok");
  });

  it("trusts a contract-reported dead-man freeze", () => {
    assert.equal(dmsUrgency(at(10n), policy(grace)), "ok");
    assert.equal(
      dmsUrgency(status({ now: 1010n, heartbeat_expired: true }), policy(grace)),
      "expired",
    );
  });

  it("an admin freeze is not a dead-man expiry", () => {
    const s = status({ now: 1010n, heartbeat_expired: true, admin_frozen: true });
    assert.equal(dmsUrgency(s, policy(grace)), "ok");
  });
});

describe("formatDmsCountdown (issue #467)", () => {
  it("is exported from the package root", () => {
    assert.equal(sdk.formatDmsCountdown, formatDmsCountdown);
  });

  it("gives each countdown state its own operator-facing wording", () => {
    const rendered = [
      formatDmsCountdown(status({ now: 1000n }), null),
      formatDmsCountdown(status({ now: 1000n }), policy(0n)),
      formatDmsCountdown(
        status({ now: 1000n, last_heartbeat: 0n, heartbeat_expired: true }),
        policy(grace),
      ),
      formatDmsCountdown(at(0n), policy(grace)),
      formatDmsCountdown(at(80n), policy(grace)),
      formatDmsCountdown(at(100n), policy(grace)),
    ];

    assert.deepEqual(
      rendered.map((entry) => entry.state),
      ["no_policy", "disabled", "never", "ok", "warn", "expired"],
    );
    assert.deepEqual(
      rendered.map((entry) => entry.urgency),
      ["unknown", "unknown", "unknown", "ok", "warn", "expired"],
    );
    assert.equal(new Set(rendered.map((entry) => entry.short)).size, rendered.length);
    assert.equal(new Set(rendered.map((entry) => entry.long)).size, rendered.length);

    for (const entry of rendered.slice(0, 3)) {
      assert.equal(entry.remainingSecs, null);
      assert.ok(!entry.long.includes("0 seconds"), entry.long);
      assert.ok(!entry.long.includes("expired"), entry.long);
    }
  });

  it("uses deadManRemaining for displayed seconds, including boundary seconds", () => {
    const p = policy(grace);
    for (const elapsed of [0n, 1n, 79n, 80n, 99n, 100n]) {
      const s = at(elapsed);
      const countdown = formatDmsCountdown(s, p);
      assert.equal(countdown.remainingSecs, deadManRemaining(s, p));
      assert.equal(countdown.urgency, dmsUrgency(s, p));
    }

    const ok = formatDmsCountdown(at(0n), p);
    assert.equal(ok.short, "ok · 1m 40s left");
    assert.match(ok.long, /1m 40s remaining/);

    const warn = formatDmsCountdown(at(80n), p);
    assert.equal(warn.short, "warn · 20s left");
    assert.match(warn.long, /20s remaining/);
  });

  it("honours nowSecs and warnRatio overrides without locale dependencies", () => {
    const p = policy(grace);
    const countdown = formatDmsCountdown(at(10n), p, { nowSecs: 1085n, warnRatio: 0.9 });
    assert.equal(countdown.state, "ok");
    assert.equal(countdown.remainingSecs, 15n);
    assert.equal(countdown.short, "ok · 15s left");

    assert.throws(() => formatDmsCountdown(at(10n), p, { nowSecs: 1085 as never }), TypeError);
  });
});
