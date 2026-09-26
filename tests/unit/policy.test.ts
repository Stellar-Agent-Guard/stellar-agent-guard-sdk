/**
 * Unit tests for the policy model.
 *
 * The encoding tests matter more than they look: an unsorted `ScMap` is rejected
 * by the host at struct-conversion time, so a policy that encodes "successfully"
 * here but is not sorted would fail on-chain with an opaque object error. That is
 * a real bug this suite has already caused once.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  decodeCheckResult,
  deadManRemaining,
  describePolicy,
  isDeadManFrozen,
  policyToScVal,
  type GuardStatus,
  type PolicyConfig,
} from "../../src/policy.ts";

const TOKEN = "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB";
const GUARD = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
const RECIPIENT = "GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH";

function samplePolicy(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
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
    dms_grace_secs: 0n,
    ...overrides,
  };
}

/**
 * Keys of an `ScVal::Map`, decoded to strings, in encoded order.
 *
 * In this SDK's XDR layer the union payloads are plain properties (`map`, `key`,
 * `val`), not the `map()`/`key()` accessors older stellar-base releases used —
 * reading them as methods throws rather than failing an assertion.
 */
function encodedKeys(val: xdr.ScVal): string[] {
  const entries = (val as unknown as { map?: Array<{ key: xdr.ScVal }> }).map ?? [];
  return entries.map((entry) => String(scValToNative(entry.key)));
}

describe("policyToScVal", () => {
  it("emits a map with sorted keys, as the host requires for struct conversion", () => {
    const keys = encodedKeys(policyToScVal(samplePolicy()));
    assert.deepEqual(keys, [...keys].sort());
    assert.deepEqual(keys, [
      "active_from",
      "active_until",
      "allow_any_recipient",
      "assets",
      "dms_grace_secs",
      "paused",
      "per_tx_cap",
      "protocols",
      "recipients",
      "window_cap",
      "window_secs",
    ]);
  });

  it("sorts the nested protocol rule maps too", () => {
    const val = policyToScVal(
      samplePolicy({ protocols: [{ contract: TOKEN, fns: ["transfer", "approve"] }] }),
    ) as unknown as { map: Array<{ key: xdr.ScVal; val: xdr.ScVal }> };
    const protocols = val.map.find((entry) => String(scValToNative(entry.key)) === "protocols")!;
    const ruleVec = (protocols.val as unknown as { vec: xdr.ScVal[] }).vec;
    assert.deepEqual(encodedKeys(ruleVec[0]!), ["contract", "fns"]);
  });

  it("round-trips through scValToNative without losing cap precision", () => {
    const policy = samplePolicy({
      per_tx_cap: 9_007_199_254_740_993n, // beyond Number.MAX_SAFE_INTEGER
      window_cap: 12_345_678_901_234_567_890n,
    });
    const decoded = scValToNative(policyToScVal(policy)) as Record<string, unknown>;
    assert.equal(decoded["per_tx_cap"], 9_007_199_254_740_993n);
    assert.equal(decoded["window_cap"], 12_345_678_901_234_567_890n);
  });

  it("round-trips addresses as strkeys, not raw bytes", () => {
    const decoded = scValToNative(policyToScVal(samplePolicy())) as Record<string, unknown>;
    assert.deepEqual(decoded["assets"], [TOKEN]);
    assert.deepEqual(decoded["recipients"], [RECIPIENT]);
  });

  it("round-trips a null function list as void (any function allowed)", () => {
    const decoded = scValToNative(
      policyToScVal(samplePolicy({ protocols: [{ contract: TOKEN, fns: null }] })),
    ) as { protocols: Array<{ fns: unknown }> };
    assert.equal(decoded.protocols[0]!.fns, null);
  });

  it("rejects a malformed address rather than emitting a broken policy", () => {
    assert.throws(() => policyToScVal(samplePolicy({ recipients: ["not-an-address"] })));
  });
});

describe("decodeCheckResult", () => {
  it("decodes the Allowed unit variant", () => {
    assert.deepEqual(decodeCheckResult("Allowed"), { kind: "allowed" });
  });

  it("decodes a Blocked variant to its reason symbol", () => {
    assert.deepEqual(decodeCheckResult({ Blocked: "recipient_not_allowed" }), {
      kind: "blocked",
      reason: "recipient_not_allowed",
    });
  });

  it("throws on an unexpected payload instead of guessing", () => {
    assert.throws(() => decodeCheckResult({ SomethingElse: 1 }), /unexpected CheckResult/);
  });
});

describe("dead-man switch helpers", () => {
  const status = (overrides: Partial<GuardStatus> = {}): GuardStatus => ({
    has_policy: true,
    admin_frozen: false,
    heartbeat_expired: false,
    last_heartbeat: 1000n,
    now: 1010n,
    ...overrides,
  });

  it("counts a silent freeze as the dead-man switch firing", () => {
    assert.equal(isDeadManFrozen(status({ heartbeat_expired: true })), true);
  });

  it("does not count an admin freeze as the dead-man switch", () => {
    assert.equal(isDeadManFrozen(status({ heartbeat_expired: true, admin_frozen: true })), false);
  });

  it("reports negative remaining time once the switch has fired", () => {
    assert.equal(deadManRemaining(status(), samplePolicy({ dms_grace_secs: 5n })), -5n);
  });

  it("reports positive remaining time while still inside grace", () => {
    assert.equal(deadManRemaining(status({ now: 1002n }), samplePolicy({ dms_grace_secs: 5n })), 3n);
  });

  it("reports null when the switch is disabled", () => {
    assert.equal(deadManRemaining(status(), samplePolicy({ dms_grace_secs: 0n })), null);
  });

  it("reports null when there is no policy to read a grace window from", () => {
    assert.equal(deadManRemaining(status(), null), null);
  });

  // Issue #46: `LastHeartbeat = 0` is the storage key's documented "0 = never"
  // default (SPEC §3), and SPEC §5 rule #2 requires `LastHeartbeat != 0` before
  // the dead-man derivation applies. A never-heartbeated account is therefore
  // NOT frozen by silence — it is spendable if otherwise allowed. Treating 0 as
  // epoch-0 would report a healthy fresh account as frozen since 1970.
  describe("last_heartbeat = 0 (never heartbeated)", () => {
    const neverHeartbeated = (overrides: Partial<GuardStatus> = {}): GuardStatus =>
      status({ last_heartbeat: 0n, ...overrides });

    it("reports a never-heartbeated account as not dead-man-frozen, even with grace set", () => {
      assert.equal(isDeadManFrozen(neverHeartbeated()), false);
      assert.equal(
        isDeadManFrozen(neverHeartbeated({ heartbeat_expired: false })),
        false,
        "a fresh account with an armed grace window is not frozen by silence",
      );
    });

    it("resolves a contradictory heartbeat_expired flag toward contract truth", () => {
      // No contract obeying rule #2 can set this state; if one ever does (or a
      // hand-built status carries it), the helper reports what the contract
      // could truthfully enforce rather than a freeze it could not have applied.
      assert.equal(isDeadManFrozen(neverHeartbeated({ heartbeat_expired: true })), false);
    });

    it("still reports an admin freeze as an admin freeze", () => {
      // The dead-man derivation is out of the picture; the admin freeze is a
      // separate condition (SPEC §5, "Manual freeze") and is not masked by the
      // never-guard, which only gates the dead-man classification.
      const adminFrozen = neverHeartbeated({ admin_frozen: true, heartbeat_expired: true });
      assert.equal(isDeadManFrozen(adminFrozen), false, "admin_frozen is a separate condition");
    });

    it("reports null remaining time — never is not expired", () => {
      assert.equal(deadManRemaining(neverHeartbeated(), samplePolicy({ dms_grace_secs: 100n })), null);
    });

    it("reports null remaining time even when the switch is armed and unexpired flags disagree", () => {
      assert.equal(
        deadManRemaining(
          neverHeartbeated({ heartbeat_expired: true }),
          samplePolicy({ dms_grace_secs: 100n }),
        ),
        null,
        "there is no countdown in force for an account that has never heartbeated",
      );
    });
  });

  // Boundary parity with the contract's freeze derivation (SPEC §5): frozen the
  // moment the grace has fully elapsed, i.e. `now >= last_heartbeat + grace`,
  // counted in whole unix seconds. Pinned at 79%/80%/101% of the grace elapsed:
  // strictly inside grace reads positive; at the boundary and beyond it does not
  // read positive. (A future contract-side `dms_health` percentage would reuse
  // this same boundary; if it lands, these are the tests that must stay in step.)
  describe("grace boundary (79% / 80% / 101% elapsed)", () => {
    const grace = 100n;
    const policy = samplePolicy({ dms_grace_secs: grace });
    const at = (percentElapsed: bigint): GuardStatus =>
      status({ last_heartbeat: 1000n, now: 1000n + (grace * percentElapsed) / 100n });

    it("reads positive remaining at 79% elapsed", () => {
      const remaining = deadManRemaining(at(79n), policy);
      assert.equal(remaining, 21n);
      assert.ok(remaining! > 0n);
    });

    it("reads positive remaining at 80% elapsed", () => {
      assert.equal(deadManRemaining(at(80n), policy), 20n);
    });

    it("reads negative remaining at 101% elapsed", () => {
      const remaining = deadManRemaining(at(101n), policy);
      assert.equal(remaining, -1n);
      assert.ok(remaining! <= 0n, "the grace has fully elapsed by 101%");
    });

    it("marks exactly 100% elapsed as the freeze boundary, not inside grace", () => {
      // "frozen the moment the grace elapses" (SPEC §5): remaining 0 is the
      // boundary itself and is not positive.
      assert.equal(deadManRemaining(at(100n), policy), 0n);
      assert.ok((deadManRemaining(at(100n), policy) ?? 0n) <= 0n);
    });

    it("keeps the boundary independent of the heartbeat_expired flag", () => {
      // The remaining-time arithmetic is derived from last_heartbeat + grace -
      // now; the flag describes what the contract has decided, and the two stay
      // consistent here because the same derivation produced both.
      assert.equal(
        deadManRemaining(status({ last_heartbeat: 1000n, now: 1101n }), policy),
        deadManRemaining(status({ last_heartbeat: 1000n, now: 1101n, heartbeat_expired: true }), policy),
      );
    });
  });
});

describe("describePolicy", () => {
  it("states default-deny when no policy is installed", () => {
    assert.match(describePolicy(null), /default-deny/);
  });

  it("summarises the caps, recipients and pause state", () => {
    const text = describePolicy(samplePolicy());
    assert.match(text, /per-tx cap 1000/);
    assert.match(text, /rolling window 150 \/ 60s/);
    assert.match(text, /1 allowlisted recipient/);
    assert.match(text, /active/);
  });

  it("does not claim a recipient allowlist when any recipient is allowed", () => {
    const text = describePolicy(samplePolicy({ allow_any_recipient: true }));
    assert.match(text, /any recipient/);
  });

  it("flags a paused policy", () => {
    assert.match(describePolicy(samplePolicy({ paused: true })), /PAUSED/);
  });

  it("keeps the guard address out of the policy it describes", () => {
    // A guard address in `assets` is rejected on-chain (validate_config); this
    // documents that the summary reflects the real policy, not a placeholder.
    assert.ok(!describePolicy(samplePolicy()).includes(GUARD));
  });
});

describe("address decoding", () => {
  it("round-trips a contract address through Address", () => {
    assert.equal(new Address(TOKEN).toString(), TOKEN);
  });
});
