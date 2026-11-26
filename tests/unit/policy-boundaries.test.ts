/**
 * Integer boundary coverage for policy encoding (issue #442).
 *
 * Policy caps, windows and grace periods are contract-bounded integers. A
 * JavaScript `number` that is silently rounded, or an `i128` that is narrowed
 * on its way into XDR, would change the policy the contract enforces — so the
 * encoder validates the wire range *before* it builds any `ScVal`.
 *
 * Every numeric field is exercised at 0, 1, max-1, max and max+1, plus the
 * negative edge for signed fields and `Number.MAX_SAFE_INTEGER` for the
 * number-input path. Each rejection must name the field and its valid range.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PolicyEncodeError } from "../../src/errors.ts";
import {
  policyToScVal,
  unsafeAccountAddress,
  unsafeContractAddress,
  validatePolicyForEncoding,
  type PolicyConfig,
} from "../../src/policy.ts";

const TOKEN = unsafeContractAddress("CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB");
const RECIPIENT = unsafeAccountAddress("GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH");

const I128_MIN = -(2n ** 127n);
const I128_MAX = 2n ** 127n - 1n;
const U64_MAX = 2n ** 64n - 1n;

function basePolicy(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return {
    per_tx_cap: 1000n,
    window_secs: 60n,
    window_cap: 1500n,
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

interface IntegerFieldCase {
  readonly field: string;
  readonly wireType: "i128" | "u64";
  readonly max: bigint;
  readonly min: bigint;
  readonly apply: (policy: PolicyConfig, value: bigint) => PolicyConfig;
  /** Failure path reported by `validatePolicyForEncoding`. */
  readonly path: string;
}

const INTEGER_FIELDS: readonly IntegerFieldCase[] = [
  {
    field: "per_tx_cap",
    wireType: "i128",
    min: I128_MIN,
    max: I128_MAX,
    apply: (policy, value) => ({ ...policy, per_tx_cap: value }),
    path: "per_tx_cap",
  },
  {
    field: "window_secs",
    wireType: "u64",
    min: 0n,
    max: U64_MAX,
    apply: (policy, value) => ({ ...policy, window_secs: value }),
    path: "window_secs",
  },
  {
    field: "window_cap",
    wireType: "i128",
    min: I128_MIN,
    max: I128_MAX,
    apply: (policy, value) => ({ ...policy, window_cap: value }),
    path: "window_cap",
  },
  {
    field: "active_from",
    wireType: "u64",
    min: 0n,
    max: U64_MAX,
    apply: (policy, value) => ({ ...policy, active_from: value }),
    path: "active_from",
  },
  {
    field: "active_until",
    wireType: "u64",
    min: 0n,
    max: U64_MAX,
    apply: (policy, value) => ({ ...policy, active_until: value }),
    path: "active_until",
  },
  {
    field: "dms_grace_secs",
    wireType: "u64",
    min: 0n,
    max: U64_MAX,
    apply: (policy, value) => ({ ...policy, dms_grace_secs: value }),
    path: "dms_grace_secs",
  },
  {
    field: "recipient_window_caps[0].cap",
    wireType: "i128",
    min: I128_MIN,
    max: I128_MAX,
    apply: (policy, value) => ({
      ...policy,
      recipient_window_caps: [{ recipient: RECIPIENT, cap: value }],
    }),
    path: "recipient_window_caps[0].cap",
  },
];

/** Format a bigint value inside an error message as the production code does. */
function rangeLabel(field: IntegerFieldCase): string {
  return `[${field.min}, ${field.max}]`;
}

describe("policy integer boundaries (issue #442)", () => {
  describe("valid edge values encode", () => {
    for (const field of INTEGER_FIELDS) {
      it(`${field.field} (${field.wireType}) accepts 0, 1, max-1 and max`, () => {
        const values = [0n, 1n, field.max - 1n, field.max];
        for (const value of values) {
          const policy = field.apply(basePolicy(), value);
          assert.deepEqual(
            validatePolicyForEncoding(policy),
            [],
            `${field.field} = ${value} must be encodable (${field.wireType})`,
          );
          // The actual encoder must agree with the pre-flight validator.
          assert.doesNotThrow(() => policyToScVal(policy));
        }
      });
    }

    it("accepts `Number.MAX_SAFE_INTEGER` on the number-input path", () => {
      for (const field of INTEGER_FIELDS) {
        const policy = field.apply(basePolicy(), BigInt(Number.MAX_SAFE_INTEGER));
        assert.deepEqual(validatePolicyForEncoding(policy), [], field.field);
        assert.doesNotThrow(() => policyToScVal(policy));
      }
    });

    it("accepts 2**64 - 1 exactly on both u64 and i128 fields", () => {
      for (const field of INTEGER_FIELDS) {
        const policy = field.apply(basePolicy(), U64_MAX);
        assert.deepEqual(validatePolicyForEncoding(policy), [], field.field);
        assert.doesNotThrow(() => policyToScVal(policy));
      }
    });
  });

  describe("out-of-range values never encode", () => {
    for (const field of INTEGER_FIELDS) {
      it(`${field.field} rejects max+1 with the field and range in the failure`, () => {
        const tooLarge = field.max + 1n;
        const policy = field.apply(basePolicy(), tooLarge);

        const failures = validatePolicyForEncoding(policy);
        assert.equal(failures.length, 1);
        assert.equal(failures[0]!.path, field.path);
        assert.equal(failures[0]!.rule, "integer_out_of_range");
        assert.ok(
          failures[0]!.message.includes(rangeLabel(field)),
          `message must name the valid range: ${failures[0]!.message}`,
        );

        assert.throws(
          () => policyToScVal(policy),
          (error: unknown) => {
            assert.ok(error instanceof PolicyEncodeError);
            assert.equal(error.path, field.path);
            assert.equal(error.failures[0]!.rule, "integer_out_of_range");
            assert.match(error.message, new RegExp(escapeRegExp(String(tooLarge))));
            assert.match(error.message, new RegExp(escapeRegExp(rangeLabel(field))));
            return true;
          },
          `${field.field} = ${tooLarge} must be rejected before encoding`,
        );
      });

      it(`${field.field} rejects ${field.wireType === "u64" ? "-1 (below zero)" : "min-1"}`, () => {
        const tooSmall = field.wireType === "u64" ? -1n : field.min - 1n;
        const policy = field.apply(basePolicy(), tooSmall);

        const failures = validatePolicyForEncoding(policy);
        assert.equal(failures.length, 1);
        assert.equal(failures[0]!.path, field.path);
        assert.equal(failures[0]!.rule, "integer_out_of_range");
        assert.match(failures[0]!.message, new RegExp(escapeRegExp(rangeLabel(field))));
        assert.throws(() => policyToScVal(policy), PolicyEncodeError);
      });
    }

    it("rejects 2**64 on every u64 field and accepts it on i128 fields", () => {
      const beyondU64 = U64_MAX + 1n;
      for (const field of INTEGER_FIELDS) {
        const policy = field.apply(basePolicy(), beyondU64);
        if (field.wireType === "u64") {
          const failures = validatePolicyForEncoding(policy);
          assert.equal(failures[0]!.path, field.path);
          assert.equal(failures[0]!.rule, "integer_out_of_range");
          assert.throws(() => policyToScVal(policy), PolicyEncodeError);
        } else {
          assert.deepEqual(validatePolicyForEncoding(policy), [], field.field);
        }
      }
    });

    it("rejects a JSON-style number string instead of coercing it", () => {
      // The encoding surface accepts bigint/number, not strings; a string that
      // slipped through a JSON parse must not become a number silently.
      const policy = { ...basePolicy(), per_tx_cap: "1000" } as unknown as PolicyConfig;
      const failures = validatePolicyForEncoding(policy);
      assert.equal(failures[0]!.path, "per_tx_cap");
      assert.equal(failures[0]!.rule, "invalid_type");
    });

    it("rejects an unsafe number rather than rounding it", () => {
      const policy = {
        ...basePolicy(),
        window_cap: Number.MAX_SAFE_INTEGER + 1,
      } as unknown as PolicyConfig;
      const failures = validatePolicyForEncoding(policy);
      assert.equal(failures[0]!.path, "window_cap");
      assert.equal(failures[0]!.rule, "invalid_type");
      assert.match(failures[0]!.message, /not a safe integer/);
      assert.throws(() => policyToScVal(policy), PolicyEncodeError);
    });
  });

  describe("recipient-window-cap combinations", () => {
    it("reports every out-of-range cap at once, with each path", () => {
      const policy = basePolicy({
        recipient_window_caps: [
          { recipient: RECIPIENT, cap: I128_MAX },
          { recipient: RECIPIENT, cap: I128_MAX + 1n },
          { recipient: RECIPIENT, cap: I128_MIN - 1n },
        ],
      });
      const failures = validatePolicyForEncoding(policy);
      assert.deepEqual(
        failures.map((failure) => [failure.path, failure.rule]),
        [
          ["recipient_window_caps[1].cap", "integer_out_of_range"],
          ["recipient_window_caps[2].cap", "integer_out_of_range"],
        ],
      );
      assert.throws(
        () => policyToScVal(policy),
        (error: unknown) => error instanceof PolicyEncodeError && error.failures.length === 2,
      );
    });

    it("accepts the i128 extremes as cap values", () => {
      const policy = basePolicy({
        recipient_window_caps: [
          { recipient: RECIPIENT, cap: I128_MIN },
          { recipient: RECIPIENT, cap: I128_MAX },
        ],
      });
      assert.deepEqual(validatePolicyForEncoding(policy), []);
      assert.doesNotThrow(() => policyToScVal(policy));
    });
  });

  describe("protocol_calls_per_window (u32)", () => {
    const U32_MAX = 4_294_967_295;

    it("accepts 0, 1, max-1 and max", () => {
      for (const value of [0, 1, U32_MAX - 1, U32_MAX]) {
        assert.doesNotThrow(() => policyToScVal(basePolicy({ protocol_calls_per_window: value })));
      }
    });

    it("rejects max+1, negative, fractional and unsafe values before encoding", () => {
      for (const value of [U32_MAX + 1, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
        assert.throws(
          () => policyToScVal(basePolicy({ protocol_calls_per_window: value })),
          (error: unknown) => {
            assert.ok(error instanceof TypeError);
            assert.match(error.message, /protocol_calls_per_window/);
            assert.match(error.message, /\[0, 4294967295\]/);
            return true;
          },
          `protocol_calls_per_window = ${value} must be rejected`,
        );
      }
    });
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
