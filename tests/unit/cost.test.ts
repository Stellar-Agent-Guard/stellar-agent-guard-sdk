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
  describeCostDecision,
  exceedsCeiling,
  feeBreakdown,
  resourceBreakdownFromSimulation,
  type ResourceBreakdown,
} from "../../src/cost.ts";
import { INCLUSION_FEE } from "../../src/tx.ts";
import type { PreFlightDecision } from "../../src/preflight.ts";
import type { ContractCall } from "../../src/tx.ts";

const CALL: ContractCall = { contract: "C".padEnd(56, "A"), fn: "transfer", args: [] };
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
