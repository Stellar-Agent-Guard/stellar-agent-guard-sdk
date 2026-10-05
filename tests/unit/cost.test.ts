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
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { SorobanDataBuilder } from "@stellar/stellar-sdk";
import {
  CostPreChecker,
  STROOPS_PER_XLM,
  describeCostDecision,
  exceedsCeiling,
  feeBreakdown,
  formatFee,
  precheckCostWithDecision,
  resourceBreakdownFromSimulation,
  type ResourceBreakdown,
} from "../../src/cost.ts";
import { INCLUSION_FEE } from "../../src/tx.ts";
import { unsafeContractAddress } from "../../src/policy.ts";
import type { PreFlightDecision } from "../../src/preflight.ts";
import type { ContractCall } from "../../src/tx.ts";

const CALL: ContractCall = { contract: unsafeContractAddress("C".padEnd(56, "A")), fn: "transfer", args: [] };
const RECORDED_RESOURCE_PAYLOAD = JSON.parse(
  readFileSync(new URL("../fixtures/simulation-resource-payload.json", import.meta.url), "utf8"),
) as unknown;

/** A stand-in interceptor returning a fixed decision, for pure branch coverage. */
function fakeInterceptor(decision: PreFlightDecision) {
  return { check: async (_call: ContractCall): Promise<PreFlightDecision> => decision };
}

function admissible(
  resourceFee: bigint,
  footprintKeys = 3,
  resourceBreakdown?: ResourceBreakdown,
): PreFlightDecision {
  return {
    allowed: true,
    kind: "admissible",
    estimatedResourceFee: resourceFee,
    footprintKeys,
    ...(resourceBreakdown ? { resourceBreakdown } : {}),
  };
}

describe("resourceBreakdownFromSimulation", () => {
  it("parses the recorded stellar-sdk resource payload without inventing fields", () => {
    assert.deepEqual(resourceBreakdownFromSimulation(RECORDED_RESOURCE_PAYLOAD), {
      instructions: 184_320,
      diskReadBytes: 12_288,
      writeBytes: 2_048,
      readOnlyEntries: 2,
      readWriteEntries: 1,
      storageEntries: 3,
    });
  });

  it("reads the parsed SorobanDataBuilder shape used by the RPC client", () => {
    const builder = new SorobanDataBuilder().setResources(1_234, 5_678, 9_012);
    assert.deepEqual(resourceBreakdownFromSimulation({ transactionData: builder }), {
      instructions: 1_234,
      diskReadBytes: 5_678,
      writeBytes: 9_012,
      readOnlyEntries: 0,
      readWriteEntries: 0,
      storageEntries: 0,
    });
  });

  it("also accepts the raw base64 transactionData form returned by RPC", () => {
    const base64 = new SorobanDataBuilder().setResources(7, 8, 9).build().toXDR("base64");
    assert.deepEqual(resourceBreakdownFromSimulation({ transactionData: base64 }), {
      instructions: 7,
      diskReadBytes: 8,
      writeBytes: 9,
      readOnlyEntries: 0,
      readWriteEntries: 0,
      storageEntries: 0,
    });
  });

  it("returns undefined for an incomplete or absent simulation payload", () => {
    assert.equal(resourceBreakdownFromSimulation({ error: "HostError: trap" }), undefined);
    assert.equal(resourceBreakdownFromSimulation({ transactionData: "" }), undefined);
    assert.equal(
      resourceBreakdownFromSimulation({
        transactionData: {
          resources: {
            instructions: 1,
            diskReadBytes: 2,
            writeBytes: 3,
            footprint: { readOnly: [] },
          },
        },
      }),
      undefined,
    );
    assert.equal(
      resourceBreakdownFromSimulation({
        transactionData: {
          resources: {
            instructions: "",
            diskReadBytes: 2,
            writeBytes: 3,
            footprint: { readOnly: [], readWrite: [] },
          },
        },
      }),
      undefined,
    );
  });
});

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

  it("surfaces the simulation resource breakdown on a priced decision", async () => {
    const breakdown: ResourceBreakdown = {
      instructions: 10,
      diskReadBytes: 20,
      writeBytes: 30,
      readOnlyEntries: 2,
      readWriteEntries: 1,
      storageEntries: 3,
    };
    const checker = new CostPreChecker({ interceptor: fakeInterceptor(admissible(2_000n, 3, breakdown)) });
    const decision = await checker.check(CALL);

    assert.equal(decision.kind, "within_budget");
    assert.deepEqual(decision.breakdown, breakdown);
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
    assert.equal(decision.breakdown, undefined, "a block has no simulation resource block");
  });

  it("reports an unpriced call as undetermined, with nothing charged", async () => {
    const checker = new CostPreChecker({
      interceptor: fakeInterceptor({ allowed: false, kind: "undetermined", detail: "trap" }),
    });
    const decision = await checker.check(CALL);
    assert.equal(decision.kind, "undetermined");
    assert.equal(decision.allowed, false);
    assert.equal(decision.totalFeeStroops, 0n);
    assert.equal(decision.breakdown, undefined, "an undetermined call has no resource block");
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

/**
 * `checkWithCost` (issue #87): one simulation, both answers.
 *
 * The property worth pinning is the *count* of simulations, because that is the
 * whole point of the API: `interceptor.check()` followed by
 * `costChecker.check()` simulates the same call twice against two ledger
 * snapshots, and the reported fee can then disagree with the enforced verdict.
 */
describe("CostPreChecker.checkWithCost", () => {
  it("runs exactly one simulation for the combined verdict and cost", async () => {
    let simulations = 0;
    const interceptor = {
      check: async (_call: ContractCall): Promise<PreFlightDecision> => {
        simulations += 1;
        return admissible(2_000n, 4);
      },
    };
    const checker = new CostPreChecker({ interceptor });
    const { decision, cost } = await checker.checkWithCost(CALL);

    assert.equal(simulations, 1, "one enforced simulation, not two");
    assert.equal(decision.kind, "admissible");
    assert.equal(cost.kind, "within_budget");
    assert.equal(cost.resourceFeeStroops, 2_000n);
    assert.equal(cost.totalFeeStroops, 2_000n + BigInt(INCLUSION_FEE));
    assert.equal(cost.footprintKeys, 4);
  });

  it("returns the interceptor's verdict itself, not a re-derived copy", async () => {
    const verdict = admissible(1n, 1);
    const checker = new CostPreChecker({ interceptor: { check: async () => verdict } });
    const { decision } = await checker.checkWithCost(CALL);
    assert.equal(decision, verdict);
  });

  it("keeps a refusal uncosted while still returning the verdict", async () => {
    const checker = new CostPreChecker({
      interceptor: fakeInterceptor({
        allowed: false,
        kind: "blocked",
        reason: "paused",
        explanation: "account paused",
        detail: "simulation failed",
        diagnosticEvents: [],
      }),
      maxFeeStroops: 1n, // a ceiling that would reject any price
    });
    const { decision, cost } = await checker.checkWithCost(CALL);
    assert.equal(decision.kind, "blocked");
    assert.equal(cost.kind, "blocked");
    assert.equal(cost.totalFeeStroops, 0n);
  });

  it("implements check() on top of the one-simulation path", async () => {
    let simulations = 0;
    const interceptor = {
      check: async (): Promise<PreFlightDecision> => {
        simulations += 1;
        return admissible(5_000n, 2);
      },
    };
    const checker = new CostPreChecker({ interceptor, maxFeeStroops: 10_000n });
    const combined = await checker.checkWithCost(CALL);
    const plain = await checker.check(CALL);
    assert.equal(simulations, 2, "one simulation per call, never two for one call");
    assert.deepEqual(plain, combined.cost);
  });
});

describe("precheckCostWithDecision", () => {
  it("decides and prices from one simulation in the one-shot form", async () => {
    let simulations = 0;
    const interceptor = {
      check: async (): Promise<PreFlightDecision> => {
        simulations += 1;
        return admissible(2_000n);
      },
    };
    const { decision, cost } = await precheckCostWithDecision({ interceptor }, CALL);
    assert.equal(simulations, 1);
    assert.equal(decision.kind, "admissible");
    assert.equal(cost.kind, "within_budget");
  });
});
