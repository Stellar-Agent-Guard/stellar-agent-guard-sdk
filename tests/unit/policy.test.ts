/**
 * Unit tests for the policy model.
 *
 * The encoding tests matter more than they look: an unsorted `ScMap` is rejected
 * by the host at struct-conversion time, so a policy that encodes "successfully"
 * here but is not sorted would fail on-chain with an opaque object error. That is
 * a real bug this suite has already caused once.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { Address, nativeToScVal, scValToNative, StrKey, xdr } from "@stellar/stellar-sdk";
import { PolicyDecodeError } from "../../src/errors.ts";
import {
  decodeCheckResult,
  decodePolicy,
  deadManRemaining,
  describePolicy,
  isDeadManFrozen,
  policyFromScVal,
  policyToScVal,
  type GuardStatus,
  type PolicyConfig,
  type ProtocolRule,
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

function mapEntries(val: xdr.ScVal): xdr.ScMapEntry[] {
  return [...((val as unknown as { map?: xdr.ScMapEntry[] }).map ?? [])];
}

function replaceMapValues(
  val: xdr.ScVal,
  replacements: Readonly<Record<string, xdr.ScVal>>,
): xdr.ScVal {
  return xdr.ScVal.scvMap(
    mapEntries(val).map((entry) => {
      const name = String(scValToNative(entry.key));
      return replacements[name]
        ? new xdr.ScMapEntry({ key: entry.key, val: replacements[name] })
        : entry;
    }),
  );
}

function stringEncodedNumbers(policy: PolicyConfig): xdr.ScVal {
  const numeric = new Set([
    "per_tx_cap",
    "window_secs",
    "window_cap",
    "active_from",
    "active_until",
    "dms_grace_secs",
  ]);
  const values: Record<string, bigint> = {
    per_tx_cap: policy.per_tx_cap,
    window_secs: policy.window_secs,
    window_cap: policy.window_cap,
    active_from: policy.active_from,
    active_until: policy.active_until,
    dms_grace_secs: policy.dms_grace_secs,
  };
  return replaceMapValues(
    policyToScVal(policy),
    Object.fromEntries(
      [...numeric].map((name) => [name, xdr.ScVal.scvString(values[name]!.toString())]),
    ),
  );
}

interface Phase1PolicyFixture {
  guard: string;
  policyInstallTransaction: string;
  scvalType: string;
  scvalBase64: string;
  scvalByteLength: number;
  scvalSha256: string;
  expected: {
    per_tx_cap: string;
    window_secs: string;
    window_cap: string;
    assets: string[];
    protocols: PolicyConfig["protocols"];
    recipients: string[];
    allow_any_recipient: boolean;
    active_from: string;
    active_until: string;
    paused: boolean;
    dms_grace_secs: string;
  };
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

describe("decodePolicy", () => {
  const roundTripFixtures: Array<[string, PolicyConfig]> = [
    ["the default-shaped policy", samplePolicy()],
    [
      "populated vectors plus None, empty, and populated Option function lists",
      samplePolicy({
        per_tx_cap: 9_007_199_254_740_993n,
        window_secs: 18_446_744_073_709_551_615n,
        window_cap: 12_345_678_901_234_567_890n,
        assets: [TOKEN, GUARD],
        protocols: [
          { contract: TOKEN, fns: null },
          { contract: GUARD, fns: [] },
          { contract: TOKEN, fns: ["transfer", "approve"] },
        ],
        recipients: [RECIPIENT],
        allow_any_recipient: true,
        active_from: 1n,
        active_until: 18_446_744_073_709_551_615n,
        paused: true,
        dms_grace_secs: 3600n,
      }),
    ],
    [
      "signed i128 and unsigned u64 boundary values",
      samplePolicy({
        per_tx_cap: 2n ** 127n - 1n,
        window_cap: -(2n ** 127n),
        window_secs: 2n ** 64n - 1n,
        active_from: 0n,
        active_until: 2n ** 64n - 1n,
        dms_grace_secs: 2n ** 64n - 1n,
      }),
    ],
  ];

  for (const [name, policy] of roundTripFixtures) {
    it(`round-trips ${name} without losing precision`, () => {
      const encoded = policyToScVal(policy);
      const decoded = decodePolicy(encoded);
      assert.deepEqual(decoded, policy);
      assert.equal(policyToScVal(decoded).toXDR("base64"), encoded.toXDR("base64"));
      assert.deepEqual(policyFromScVal(encoded), policy);
    });
  }

  it("accepts an Option(Some(policy)) wrapper used by some RPC surfaces", () => {
    const encoded = policyToScVal(samplePolicy());
    assert.deepEqual(decodePolicy(xdr.ScVal.scvVec([encoded])), samplePolicy());
  });

  it("normalises stringly encoded numeric values to bounded bigint", () => {
    const policy = samplePolicy({
      per_tx_cap: 9_007_199_254_740_993n,
      window_secs: 18_446_744_073_709_551_615n,
      window_cap: -(2n ** 127n),
      active_from: 1n,
      active_until: 2n,
      dms_grace_secs: 3n,
    });
    assert.deepEqual(decodePolicy(stringEncodedNumbers(policy)), policy);
  });

  it("decodes the raw ScVal captured from the deployed Phase-1 policy() read", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL("../fixtures/phase1-policy-scval.json", import.meta.url),
        "utf8",
      ),
    ) as Phase1PolicyFixture;
    const bytes = Buffer.from(fixture.scvalBase64, "base64");
    assert.equal(bytes.length, fixture.scvalByteLength);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), fixture.scvalSha256);

    const scval = xdr.ScVal.fromXDR(fixture.scvalBase64, "base64");
    assert.equal(scval.type, fixture.scvalType);
    assert.equal(fixture.guard, "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7");
    assert.match(fixture.policyInstallTransaction, /^[0-9a-f]{64}$/);

    const expected: PolicyConfig = {
      per_tx_cap: BigInt(fixture.expected.per_tx_cap),
      window_secs: BigInt(fixture.expected.window_secs),
      window_cap: BigInt(fixture.expected.window_cap),
      assets: fixture.expected.assets,
      protocols: fixture.expected.protocols,
      recipients: fixture.expected.recipients,
      allow_any_recipient: fixture.expected.allow_any_recipient,
      active_from: BigInt(fixture.expected.active_from),
      active_until: BigInt(fixture.expected.active_until),
      paused: fixture.expected.paused,
      dms_grace_secs: BigInt(fixture.expected.dms_grace_secs),
    };
    assert.deepEqual(decodePolicy(scval), expected);
  });

  it("rejects a missing policy as a typed, path-bearing failure", () => {
    assert.throws(
      () => decodePolicy(xdr.ScVal.scvVoid()),
      (error: unknown) => {
        assert.ok(error instanceof PolicyDecodeError);
        assert.equal(error.path, "policy");
        assert.match(error.message, /no policy is installed/);
        return true;
      },
    );
  });

  it("rejects a missing field rather than defaulting it", () => {
    const encoded = policyToScVal(samplePolicy());
    const withoutPaused = mapEntries(encoded).filter(
      (entry) => String(scValToNative(entry.key)) !== "paused",
    );
    assert.throws(
      () => decodePolicy(xdr.ScVal.scvMap(withoutPaused)),
      /missing field\(s\): paused/,
    );
  });

  it("rejects duplicate, unknown, and unsorted fields", () => {
    const entries = mapEntries(policyToScVal(samplePolicy()));
    const duplicate = new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("active_from"), val: xdr.ScVal.scvU64(1n) });
    assert.throws(
      () => decodePolicy(xdr.ScVal.scvMap([entries[0]!, duplicate])),
      /duplicate field "active_from"/,
    );

    const unknown = new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("zzzz"), val: xdr.ScVal.scvBool(true) });
    assert.throws(
      () => decodePolicy(xdr.ScVal.scvMap([...entries, unknown])),
      /unknown field "zzzz"/,
    );
    assert.throws(
      () => decodePolicy(xdr.ScVal.scvMap([...entries].reverse())),
      /symbol keys are not sorted/,
    );
  });

  it("rejects i128/u64 wire-type confusion", () => {
    const encoded = policyToScVal(samplePolicy());
    const i128AsU64 = replaceMapValues(encoded, {
      per_tx_cap: nativeToScVal(1n, { type: "u64" }),
    });
    assert.throws(() => decodePolicy(i128AsU64), /per_tx_cap: expected i128/);

    const u64AsI128 = replaceMapValues(encoded, {
      window_secs: nativeToScVal(1n, { type: "i128" }),
    });
    assert.throws(() => decodePolicy(u64AsI128), /window_secs: expected u64/);
  });

  it("rejects an address represented by a string instead of ScVal::Address", () => {
    const encoded = replaceMapValues(policyToScVal(samplePolicy()), {
      assets: xdr.ScVal.scvVec([xdr.ScVal.scvString(TOKEN)]),
    });
    assert.throws(
      () => decodePolicy(encoded),
      (error: unknown) => {
        assert.ok(error instanceof PolicyDecodeError);
        assert.equal(error.path, "assets[0]");
        return true;
      },
    );
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

/**
 * Property tests for `policyToScVal` (issue #48).
 *
 * Unit cases pin individual encodings; these tests pin the encoder's *shape*
 * against arbitrary valid policies: every generated policy must encode to an
 * `ScVal::Map` whose key set is exactly the committed field list (so "field
 * added to the type but not to the encoder" fails here, independently of the
 * decoder), keys sorted as the host requires, no `undefined` values hiding in
 * any nested map, and — once `decodePolicy` landed — exact round-trip identity
 * for every generated policy.
 *
 * The generator is seeded and reproducible: a failure prints the policy JSON
 * and the seed, so any red run can be replayed locally. 1000 iterations run in
 * well under CI's time budget (the encode/decode pair is a few microseconds).
 */
describe("policyToScVal: property tests (seeded, arbitrary valid policies)", () => {
  /**
    * A deterministic xorshift PRNG. `Math.random()` would make failures
    * unreproducible; this way the same seed always produces the same sequence
    * of policies, in CI and locally.
    */
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const rand = mulberry32(0x5eedc0de);
  const int = (max: number) => Math.floor(rand() * (max + 1));
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
  const bool = () => rand() < 0.5;

  /** Bounded valid u64/i128 bigints (caps stay far below the i128 maximum). */
  const cap = () => BigInt(int(10_000_000));
  const secs = () => BigInt(int(60 * 60 * 24 * 365));

  /** Deterministic 32-byte payloads encoded as valid strkeys. */
  let addressCounter = 0;
  function contractAddress(): string {
    const bytes = Buffer.alloc(32);
    bytes.writeUInt32BE(++addressCounter, 28);
    return StrKey.encodeContract(bytes);
  }
  function accountAddress(): string {
    const bytes = Buffer.alloc(32);
    bytes.writeUInt32BE(++addressCounter, 28);
    return StrKey.encodeEd25519PublicKey(bytes);
  }

  const FN_NAMES = ["transfer", "approve", "mint", "swap", "set_fee"] as const;

  function arbitraryProtocolRule(): ProtocolRule {
    return {
      contract: contractAddress(),
      fns:
        rand() < 0.5
          ? null
          : Array.from({ length: int(4) }, () => pick(FN_NAMES)).filter(
              (fn, index, all) => all.indexOf(fn) === index,
            ),
    };
  }

  function arbitraryPolicy(): PolicyConfig {
    return {
      per_tx_cap: cap(),
      window_secs: secs(),
      window_cap: cap(),
      assets: Array.from({ length: int(3) }, contractAddress),
      protocols: Array.from({ length: int(3) }, arbitraryProtocolRule),
      recipients: Array.from({ length: int(3) }, accountAddress),
      allow_any_recipient: bool(),
      active_from: secs(),
      active_until: secs(),
      paused: bool(),
      dms_grace_secs: secs(),
    };
  }

  const SEED = 0x5eedc0de;
  const ITERATIONS = 1000;

  /** The committed field list — the encoder must emit exactly these keys. */
  const EXPECTED_POLICY_KEYS = [
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
  ];
  const EXPECTED_RULE_KEYS = ["contract", "fns"];

  function entryKey(entry: xdr.ScMapEntry): string {
    return String(scValToNative(entry.key));
  }

  /** The XDR union's discriminator, read off the plain-property shape. */
  function kindOf(val: xdr.ScVal): string {
    return val.type;
  }

  /** The union payloads are plain properties here, not dust accessors — see the file top. */
  function mapEntriesOf(val: xdr.ScVal): xdr.ScMapEntry[] {
    return ((val as unknown as { map?: xdr.ScMapEntry[] }).map ?? []) as xdr.ScMapEntry[];
  }
  function vecEntriesOf(val: xdr.ScVal): xdr.ScVal[] {
    return ((val as unknown as { vec?: xdr.ScVal[] }).vec ?? []) as xdr.ScVal[];
  }

  function assertNoUndefinedInMaps(val: xdr.ScVal, path: string): void {
    const kind = kindOf(val);
    if (kind === "scvMap") {
      for (const entry of mapEntriesOf(val)) {
        // The one legal Void in a policy map is `protocols[].fns: null` ("any
        // function"); every other field must be present and typed.
        const isProtocolRuleMap = /\.protocols\[\d+\]$/.test(path);
        const isOptionalFns = isProtocolRuleMap && entryKey(entry) === "fns";
        assert.ok(
          isOptionalFns || kindOf(entry.val) !== "scvVoid",
          `${path}.${entryKey(entry)}: undefined field encoded as Void — the classic silent on-chain failure`,
        );
        assertNoUndefinedInMaps(entry.val, `${path}.${entryKey(entry)}`);
      }
      return;
    }
    if (kind === "scvVec") {
      vecEntriesOf(val).forEach((item, index) => assertNoUndefinedInMaps(item, `${path}[${index}]`));
    }
  }

  it(`structural: key set, ordering and no-undefined hold for ${ITERATIONS} generated policies`, () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const policy = arbitraryPolicy();
      const val = policyToScVal(policy);

      assert.equal(kindOf(val), "scvMap", `iteration ${i}: not an ScVal::Map`);
      const entries = mapEntriesOf(val);
      const keys = entries.map(entryKey);
      assert.deepEqual(
        keys,
        EXPECTED_POLICY_KEYS,
        `iteration ${i}: encoder drifted from the committed field list\npolicy: ${JSON.stringify(
          policy,
          (_key, value) => (typeof value === "bigint" ? value.toString() : value),
        )}`,
      );
      assert.deepEqual(keys, [...keys].sort(), `iteration ${i}: keys not sorted`);

      for (const entry of entries) {
        if (entryKey(entry) === "protocols") {
          for (const rule of vecEntriesOf(entry.val)) {
            const ruleEntries = mapEntriesOf(rule);
            const ruleKeys = ruleEntries.map(entryKey);
            assert.deepEqual(ruleKeys, EXPECTED_RULE_KEYS, `iteration ${i}: protocol rule key drift`);
            assert.deepEqual(ruleKeys, [...ruleKeys].sort());
            // The one legal Void is `fns: null`; `contract` must be an address.
            const fns = ruleEntries.find((e: xdr.ScMapEntry) => entryKey(e) === "fns")!;
            if (kindOf(fns.val) === "scvVoid") continue;
            assert.equal(kindOf(fns.val), "scvVec");
            for (const fn of vecEntriesOf(fns.val)) {
              assert.equal(kindOf(fn), "scvSymbol");
            }
          }
        }
      }

      assertNoUndefinedInMaps(val, "policy");
    }
  });

  it(`round-trip: decodePolicy(policyToScVal(p)) is exactly p for ${ITERATIONS} generated policies`, () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const policy = arbitraryPolicy();
      const decoded = decodePolicy(policyToScVal(policy));
      assert.deepEqual(
        decoded,
        policy,
        `iteration ${i}: round-trip drift\nseed ${SEED}\npolicy: ${JSON.stringify(
          policy,
          (_key, value) => (typeof value === "bigint" ? value.toString() : value),
        )}`,
      );
    }
  });

  it(`round-trip is stable under re-encode for ${ITERATIONS} generated policies`, () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const policy = arbitraryPolicy();
      const once = policyToScVal(policy);
      const twice = policyToScVal(decodePolicy(once));
      assert.equal(
        once.toXDR("base64"),
        twice.toXDR("base64"),
        `iteration ${i}: re-encoding the decoded policy produced different XDR`,
      );
    }
  });
});
