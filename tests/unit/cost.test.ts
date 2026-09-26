/**
 * Unit tests for the cost pre-checker.
 *
 * No network: the budget arithmetic is pure, and the interceptor is injected, so
 * every branch of the decision — within budget, over budget, blocked, and
 * undetermined — is exercised without touching a ledger. The two properties
 * worth pinning are that a refusal is never reported as a cost problem, and that
 * a missing ceiling never behaves like a zero ceiling.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CostPreChecker,
  STROOPS_PER_XLM,
  describeCostDecision,
  exceedsCeiling,
  feeBreakdown,
  formatFee,
} from "../../src/cost.ts";
import { INCLUSION_FEE } from "../../src/tx.ts";
import type { PreFlightDecision } from "../../src/preflight.ts";
import type { ContractCall } from "../../src/tx.ts";

const CALL: ContractCall = { contract: "C".padEnd(56, "A"), fn: "transfer", args: [] };

/** A stand-in interceptor returning a fixed decision, for pure branch coverage. */
function fakeInterceptor(decision: PreFlightDecision) {
  return { check: async (_call: ContractCall): Promise<PreFlightDecision> => decision };
}

function admissible(resourceFee: bigint, footprintKeys = 3): PreFlightDecision {
  return { allowed: true, kind: "admissible", estimatedResourceFee: resourceFee, footprintKeys };
}

describe("feeBreakdown", () => {
  it("adds the SDK's own inclusion fee to the network's resource fee", () => {
    const fees = feeBreakdown(1_000n);
    assert.equal(fees.resourceFeeStroops, 1_000n);
    assert.equal(fees.inclusionFeeStroops, BigInt(INCLUSION_FEE));
    assert.equal(fees.totalFeeStroops, 1_000n + BigInt(INCLUSION_FEE));
  });

  it("keeps full precision on a fee beyond Number.MAX_SAFE_INTEGER", () => {
    const huge = 9_007_199_254_740_993n;
    assert.equal(feeBreakdown(huge).totalFeeStroops, huge + BigInt(INCLUSION_FEE));
  });

  it("prices a zero-resource call as exactly the inclusion fee", () => {
    assert.equal(feeBreakdown(0n).totalFeeStroops, BigInt(INCLUSION_FEE));
  });
});

describe("exceedsCeiling", () => {
  it("treats a missing ceiling as no objection, not a zero ceiling", () => {
    assert.equal(exceedsCeiling(1_000_000n, null), false);
    assert.equal(exceedsCeiling(1_000_000n, undefined), false);
  });

  it("does not flag a total exactly on the ceiling", () => {
    assert.equal(exceedsCeiling(1_100n, 1_100n), false);
  });

  it("flags a total strictly over the ceiling", () => {
    assert.equal(exceedsCeiling(1_101n, 1_100n), true);
  });
});

describe("CostPreChecker", () => {
  it("reports a priced call as within budget when no ceiling is set", async () => {
    const checker = new CostPreChecker({ interceptor: fakeInterceptor(admissible(2_000n, 7)) });
    const decision = await checker.check(CALL);
    assert.equal(decision.kind, "within_budget");
    assert.equal(decision.allowed, true);
    assert.equal(decision.resourceFeeStroops, 2_000n);
    assert.equal(decision.totalFeeStroops, 2_000n + BigInt(INCLUSION_FEE));
    assert.equal(decision.footprintKeys, 7);
    assert.equal(decision.feeCeilingStroops, null);
  });

  it("reports a call above the ceiling as over budget, keeping the price", async () => {
    const checker = new CostPreChecker({
      interceptor: fakeInterceptor(admissible(5_000n)),
      maxFeeStroops: 1_000n,
    });
    const decision = await checker.check(CALL);
    assert.equal(decision.kind, "over_budget");
    assert.equal(decision.allowed, false);
    assert.equal(decision.feeCeilingStroops, 1_000n);
    assert.equal(decision.totalFeeStroops, 5_000n + BigInt(INCLUSION_FEE));
  });

  it("does not confuse a guard refusal with a cost problem", async () => {
    const checker = new CostPreChecker({
      interceptor: fakeInterceptor({
        allowed: false,
        kind: "blocked",
        reason: "per_tx_cap_exceeded",
        explanation: "over the cap",
        detail: "simulation failed",
        diagnosticEvents: [],
      }),
      maxFeeStroops: 1n, // even with a ceiling that would reject any price
    });
    const decision = await checker.check(CALL);
    assert.equal(decision.kind, "blocked");
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, "per_tx_cap_exceeded");
    assert.equal(decision.totalFeeStroops, 0n, "a pre-broadcast refusal is never charged");
  });

  it("reports an unpriced call as undetermined, with nothing charged", async () => {
    const checker = new CostPreChecker({
      interceptor: fakeInterceptor({ allowed: false, kind: "undetermined", detail: "trap" }),
    });
    const decision = await checker.check(CALL);
    assert.equal(decision.kind, "undetermined");
    assert.equal(decision.allowed, false);
    assert.equal(decision.totalFeeStroops, 0n);
  });
});

describe("describeCostDecision", () => {
  it("renders both fee components rather than a single opaque total", () => {
    const text = describeCostDecision({
      kind: "within_budget",
      allowed: true,
      resourceFeeStroops: 2_000n,
      inclusionFeeStroops: 100n,
      totalFeeStroops: 2_100n,
      footprintKeys: 3,
      feeCeilingStroops: null,
    });
    assert.match(text, /2100 stroops/);
    assert.match(text, /2000 resource/);
    assert.match(text, /100 inclusion/);
    assert.match(text, /no ceiling/);
  });

  it("states that a blocked call was not charged", () => {
    const text = describeCostDecision({
      kind: "blocked",
      allowed: false,
      reason: "recipient_not_allowed",
      explanation: "not allowlisted",
      detail: "simulation failed",
      resourceFeeStroops: 0n,
      inclusionFeeStroops: 0n,
      totalFeeStroops: 0n,
    });
    assert.match(text, /recipient_not_allowed/);
    assert.match(text, /0 stroops charged/);
  });
});

describe("formatFee", () => {
  it("pins XLM's 7-decimal definition as an exact integer", () => {
    assert.equal(STROOPS_PER_XLM, 10_000_000n);
  });

  it("renders the exact edge values the money rule is about", () => {
    // 0, 1 stroop, and 10^7-1: the three inputs where any off-by-one in the
    // divisor or the padding shows up immediately.
    assert.equal(formatFee(0n), "0");
    assert.equal(formatFee(1n), "0.0000001");
    assert.equal(formatFee(9_999_999n), "0.9999999");
    assert.equal(formatFee(10_000_000n), "1");
    assert.equal(formatFee(10_000_001n), "1.0000001");
  });

  it("drops trailing fractional zeros (minimal, exact convention)", () => {
    // Documented convention: "0.1", never "0.1000000".
    assert.equal(formatFee(1_000_000n), "0.1");
    assert.equal(formatFee(1_500_000n), "0.15");
    assert.equal(formatFee(1_234_560n), "0.123456");
    assert.equal(formatFee(1_234_567n), "0.1234567");
  });

  it("keeps full precision above Number.MAX_SAFE_INTEGER via the bigint path", async () => {
    const { INCLUSION_FEE } = await import("../../src/tx.ts");
    // 2^53 + 1: a value a `number` cannot even hold. Anything routed through
    // Number here would silently round to 2^53.
    const beyondSafe = 9_007_199_254_740_993n;
    assert.equal(formatFee(beyondSafe), "900719925.4740993");

    // A real large total: the inclusion fee added to a very large resource fee.
    const hugeTotal = feeBreakdown(beyondSafe).totalFeeStroops;
    assert.equal(hugeTotal, beyondSafe + BigInt(INCLUSION_FEE));
    assert.equal(formatFee(hugeTotal), "900719925.4741093");
  });

  it("accepts a base-10 string without going through Number", () => {
    assert.equal(formatFee("1"), "0.0000001");
    assert.equal(formatFee("100"), "0.00001");
    assert.equal(formatFee("1000000000000000000000"), "100000000000000");
    assert.equal(formatFee("-1"), "-0.0000001");
  });

  it("refuses inputs that would have to be coerced", () => {
    for (const bad of ["", "abc", "1.5", "1e7", " 1", null, undefined]) {
      assert.throws(
        () => formatFee(bad as unknown as string),
        (err: unknown) => {
          assert(err instanceof TypeError);
          assert.match(err.message, /integer-only|already have lost precision/);
          return true;
        },
        `expected ${JSON.stringify(bad)} to be refused`,
      );
    }
    // A number is a distinct, deliberate refusal: precision is already gone.
    assert.throws(() => formatFee(1 as unknown as bigint), (err: unknown) => {
      assert(err instanceof TypeError);
      assert.match(err.message, /lost precision/);
      return true;
    });
    assert.throws(() => formatFee(1.5 as unknown as bigint), TypeError);
  });

  it("round-trips: every accepted value renders back to the same integer", () => {
    for (const stroops of [
      0n,
      1n,
      7n,
      999_999n,
      1_000_000n,
      9_999_999n,
      10_000_000n,
      123_456_789_012_345_678n,
      -42n,
    ]) {
      const rendered = formatFee(stroops);
      const [whole = "", fraction = ""] = rendered.replace("-", "").split(".");
      const back =
        BigInt(whole) * STROOPS_PER_XLM +
        (fraction === "" ? 0n : BigInt(fraction.padEnd(7, "0")));
      assert.equal(rendered.startsWith("-") ? -back : back, stroops, `round-trip of ${stroops}`);
    }
  });
});
