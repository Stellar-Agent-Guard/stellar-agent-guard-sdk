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
  definePolicy,
  describePolicy,
  isDeadManFrozen,
  POLICY_RULE_IDS,
  policyFromScVal,
  policyToScVal,
  validateGuardPolicy,
  freezePolicy,
  unsafeContractAddress,
  unsafeAccountAddress,
  type AccountAddress,
  type ContractAddress,
  type GuardStatus,
  type PolicyConfig,
  type ProtocolRule,
} from "../../src/policy.ts";

const TOKEN = unsafeContractAddress("CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB");
const GUARD = unsafeContractAddress("CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44");
const RECIPIENT = unsafeAccountAddress("GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH");

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
    assert.throws(() => policyToScVal(samplePolicy({ recipients: [unsafeAccountAddress("not-an-address")] })));
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
    assert.equal(fixture.guard, unsafeContractAddress("CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7"));
    assert.match(fixture.policyInstallTransaction, /^[0-9a-f]{64}$/);

    const expected: PolicyConfig = {
      per_tx_cap: BigInt(fixture.expected.per_tx_cap),
      window_secs: BigInt(fixture.expected.window_secs),
      window_cap: BigInt(fixture.expected.window_cap),
      assets: (fixture.expected.assets as string[]).map(unsafeContractAddress),
      protocols: fixture.expected.protocols,
      recipients: (fixture.expected.recipients as string[]).map(unsafeAccountAddress),
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
    const duplicate = new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("active_from"), val: xdr.ScVal.scvU64(1n)});
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

describe("definePolicy", () => {
  it("fills in defaults for a partial override", () => {
    const policy = definePolicy({ per_tx_cap: 100n });
    assert.equal(policy.per_tx_cap, 100n,
    );
    assert.equal(policy.window_secs, 60n);
    assert.equal(policy.window_cap, 150n);
    assert.deepEqual(policy.assets, [TOKEN]);
    assert.deepEqual(policy.recipients, [RECIPIENT]);
    assert.equal(policy.allow_any_recipient, false);
    assert.equal(policy.paused, false);
  });

  it("deep-merges nested lists by replacing the override entirely", () => {
    const policy = definePolicy({
      recipients: [RECIPIENT, GUARD],
      protocols: [{ contract: TOKEN, fns: ["transfer"] }],
    });
    // Override wins entirely; no array concatenation with defaults.
    assert.deepEqual(policy.recipients, [RECIPIENT, GUARD]);
    assert.deepEqual(policy.protocols, [{ contract: TOKEN, fns: ["transfer"] }]);
  });

  it("freezes the returned policy and its nested collections", () => {
    const policy = definePolicy({ recipients: [RECIPIENT] });
    assert.ok(Object.isFrozen(policy));
    assert.ok(Object.isFrozen(policy.recipients));
    assert.ok(Object.isFrozen(policy.assets));
    assert.throws(() => {
      (policy as { per_tx_cap: bigint }).per_tx_cap = 1n;
    });
  });

  it("runs cross-field validation before returning", () => {
    assert.throws(
      () => definePolicy({ active_from: 10n, active_until: 5n }),
      /active_until/,
    );
  });

  it("rejects unknown keys at runtime", () => {
    // @js-ignore -- deliberately passing an unknown key to exercise the runtime check.
    const bad = { window_cap2: 1n } as unknown as Parameters<typeof definePolicy>[0];
    assert.throws(() => definePolicy(bad), /window_cap2/);
  });

  it("rejects unknown keys at the type level", () => {
    // @ts-expect-error -- excess-property check rejects typo'd keys.
    definePolicy({ window_cap2: 1n });
  });
});

describe("decodeCheckResult", () => {
  it("decodes a passing check result", () => {
    const result = decodeCheckResult(true);
    assert.equal(result.allowed, true);
  });

  it("decodes a failing check result with a rule id", () => {
    const result = decodeCheckResult({
      allowed: false,
      rule_id: POLICY_RULE_IDS.PER_TX_CAP,
      reason: "cap exceeded",
    });
    assert.equal(result.allowed, false);
    assert.equal(result.rule_id, POLICY_RULE_IDS.PER_TX_CAP);
    assert.equal(result.reason, "cap exceeded");
  });
});

describe("policy description and dead-man state", () => {
  it("describes a policy in human terms", () => {
    const text = describePolicy(samplePolicy());
    assert.match(text, /per-tx cap/i);
  });

  it("computes dead-man remaining time", () => {
    const status: GuardStatus = {
      last_heartbeat_ledger: 100n,
      current_ledger: 150n,
      dms_grace_secs: 60n,
      paused: false,
    };
    assert.equal(isDeadManFrozen(status), false);
    assert.ok(deadManRemaining(status) >= 0n);
  });
});

describe("freezePolicy", () => {
  it("returns the same object reference (no copy)", () => {
    const policy = samplePolicy();
    const frozen = freezePolicy(policy);
    assert.equal(frozen, policy as unknown);
  });

  it("freezes the top-level object — mutation throws in strict mode (ESM = strict)", () => {
    const frozen = freezePolicy(samplePolicy());
    assert.throws(() => {
      (frozen as { per_tx_cap: bigint }).per_tx_cap = 9999n;
    }, TypeError);
  });

  it("freezes the assets array — push throws", () => {
    const frozen = freezePolicy(samplePolicy());
    assert.throws(() => {
      (frozen.assets as ContractAddress[]).push(TOKEN);
    }, TypeError);
  });

  it("freezes protocol rule objects and their fns arrays", () => {
    const policy = samplePolicy({
      protocols: [{ contract: TOKEN, fns: ["transfer"] }],
    });
    const frozen = freezePolicy(policy);
    assert.throws(() => {
      (frozen.protocols[0]!.fns as string[]).push("swap");
    }, TypeError);
    assert.throws(() => {
      (frozen.protocols[0] as { contract: string }).contract = TOKEN;
    }, TypeError);
  });

  it("still encodes correctly after freeze", () => {
    const frozen = freezePolicy(samplePolicy());
    assert.doesNotThrow(() => policyToScVal(frozen));
  });

  // Compile-time regression guard: if per_tx_cap ever becomes mutable again
  // the @ts-expect-error below will be "unused" and tsc will fail the build.
  it("ReadonlyPolicyConfig rejects mutation at the type level", () => {
    const frozen = freezePolicy(samplePolicy());
    assert.throws(() => {
      // @ts-expect-error — per_tx_cap must be readonly
      frozen.per_tx_cap = 1n;
    }, TypeError);
  });
});

/**
 * Seeded property tests for `policyToScVal` against arbitrary valid policies
 * (issue #48).
 *
 * 1000 generated policies run through each assertion below, driven by a
 * deterministic `mulberry32` PRNG (seed `0x5eedc0de`) so a red CI run replays
 * identically locally. Every failure message prints the seed and the offending
 * policy as bigint-safe JSON, so the counterexample can be dropped straight
 * back into `policyToScVal` without a bisect.
 *
 * The generators only ever emit values the contract's types accept — u64/i128
 * bigints inside their bounds, StrKey-encoded contract/account addresses derived
 * from deterministic 32-byte payloads, distinct protocol contracts, and
 * function-name sets de-duplicated within a rule — so a failure here is encoder
 * drift, not a bad input.
 */
const PROPERTY_SEED = 0x5eedc0de;
const PROPERTY_ITERATIONS = 1000;
const I128_MAX = 2n ** 127n - 1n;
const U64_MAX = 2n ** 64n - 1n;

/**
 * The committed `PolicyConfig` field list, spelled out deliberately rather than
 * derived: this is the assertion that catches a field added to the type but
 * omitted from the encoder.
 */
const POLICY_FIELD_LIST = [
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
] as const;

const PROTOCOL_FN_POOL = [
  "transfer",
  "transfer_from",
  "approve",
  "swap",
  "mint",
  "burn",
  "deposit",
  "withdraw",
] as const;

/** Deterministic PRNG — same stream on every CI run and every local replay. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBytes(rand: () => number, length: number): Buffer {
  const bytes = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = Math.floor(rand() * 256);
  }
  return bytes;
}

/** A `bits`-wide unsigned bigint drawn from `rand`, exactly in `[0, 2**bits - 1]`. */
function randomUint(rand: () => number, bits: number): bigint {
  let value = 0n;
  for (let remaining = bits; remaining > 0; remaining -= 32) {
    value = (value << 32n) | BigInt(Math.floor(rand() * 0x1_0000_0000));
  }
  const excess = (32 - (bits % 32)) % 32;
  return excess === 0 ? value : value >> BigInt(excess);
}

/** An i128 amount in `[0, 2**127 - 1]`, occasionally pinned to its boundary. */
function randomAmount(rand: () => number): bigint {
  const roll = rand();
  if (roll < 0.1) return 0n;
  if (roll < 0.2) return I128_MAX;
  return randomUint(rand, 127);
}

/** A u64 value, occasionally pinned to 0 (disabled) or `U64_MAX`. */
function randomSeconds(rand: () => number): big
