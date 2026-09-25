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
  describeCostDecision,
  exceedsCeiling,
  feeBreakdown,
  precheckCost,
  type PolicyContext,
} from "../../src/cost.ts";
import { INCLUSION_FEE } from "../../src/tx.ts";
import type { PreFlightDecision } from "../../src/preflight.ts";
import type { ContractCall } from "../../src/tx.ts";
import type { PolicyConfig } from "../../src/policy.ts";

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

describe("CostPreChecker policyContext integration", () => {
  const GUARD_ADDR = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";

  it("Scenario A — within caps: live check runs and sets perTxCapOk=true, windowRemainingEstimate=null, reason=null", async () => {
    let liveCheckCalled = false;
    const interceptor = {
      check: async (call: ContractCall): Promise<PreFlightDecision> => {
        liveCheckCalled = true;
        assert.equal(call.fn, "transfer");
        return admissible(1_200n, 5);
      },
    };

    const checker = new CostPreChecker({
      interceptor,
      policySource: GUARD_ADDR,
    });

    const decision = await checker.check(CALL);
    assert.equal(liveCheckCalled, true, "live check() must be performed");
    assert.equal(decision.kind, "within_budget");
    assert.equal(decision.allowed, true);
    assert.ok(decision.policyContext !== null);
    assert.equal(decision.policyContext.perTxCapOk, true);
    // CRITICAL: windowRemainingEstimate must be null, never 0 or fake estimate
    assert.equal(decision.policyContext.windowRemainingEstimate, null);
    assert.equal(decision.policyContext.reason, null);
  });

  it("Scenario B1 — over window_cap: surfaces window_cap_exceeded reason, perTxCapOk=true, and windowRemainingEstimate=null", async () => {
    let liveCheckCalled = false;
    const interceptor = {
      check: async (_call: ContractCall): Promise<PreFlightDecision> => {
        liveCheckCalled = true;
        return {
          allowed: false,
          kind: "blocked",
          reason: "window_cap_exceeded",
          explanation: "The transfer would push cumulative spend over the rolling-window cap.",
          detail: "simulation refused by guard",
          diagnosticEvents: [],
        };
      },
    };

    const checker = new CostPreChecker({
      interceptor,
      policySource: GUARD_ADDR,
    });

    const decision = await checker.check(CALL);
    assert.equal(liveCheckCalled, true, "live check() must be performed");
    assert.equal(decision.kind, "blocked");
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, "window_cap_exceeded");
    assert.ok(decision.policyContext !== null);
    assert.equal(decision.policyContext.perTxCapOk, true, "per-tx cap was not exceeded");
    assert.equal(decision.policyContext.windowRemainingEstimate, null, "never report 0 for unavailable window state");
    assert.equal(decision.policyContext.reason, "window_cap_exceeded");
    assert.equal(decision.totalFeeStroops, 0n);
  });

  it("Scenario B2 — over per_tx_cap: surfaces per_tx_cap_exceeded reason and perTxCapOk=false", async () => {
    let liveCheckCalled = false;
    const interceptor = {
      check: async (_call: ContractCall): Promise<PreFlightDecision> => {
        liveCheckCalled = true;
        return {
          allowed: false,
          kind: "blocked",
          reason: "per_tx_cap_exceeded",
          explanation: "The transfer amount exceeds the policy's per-transaction cap.",
          detail: "simulation refused by guard",
          diagnosticEvents: [],
        };
      },
    };

    const checker = new CostPreChecker({
      interceptor,
      policySource: GUARD_ADDR,
    });

    const decision = await checker.check(CALL);
    assert.equal(liveCheckCalled, true);
    assert.equal(decision.kind, "blocked");
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, "per_tx_cap_exceeded");
    assert.ok(decision.policyContext !== null);
    assert.equal(decision.policyContext.perTxCapOk, false);
    assert.equal(decision.policyContext.windowRemainingEstimate, null);
    assert.equal(decision.policyContext.reason, "per_tx_cap_exceeded");
  });

  it("Scenario C — no policy source: preserves existing cost pre-check behavior and yields policyContext=null", async () => {
    const checker = new CostPreChecker({
      interceptor: fakeInterceptor(admissible(2_500n, 6)),
      // no policySource / policy configured
    });

    const decision = await checker.check(CALL);
    assert.equal(decision.kind, "within_budget");
    assert.equal(decision.allowed, true);
    assert.equal(decision.resourceFeeStroops, 2_500n);
    // Acceptance criterion: no-policy-source → field null.
    assert.equal(decision.policyContext, null);
    const context = decision.policyContext as PolicyContext | null;
    assert.equal(context?.windowRemainingEstimate ?? null, null);
  });

  it("reports over_budget when exceeding fee ceiling, while policyContext confirms within policy cap", async () => {
    const checker = new CostPreChecker({
      interceptor: fakeInterceptor(admissible(10_000n, 4)),
      maxFeeStroops: 2_000n,
      policySource: GUARD_ADDR,
    });

    const decision = await checker.check(CALL);
    assert.equal(decision.kind, "over_budget");
    assert.equal(decision.allowed, false);
    assert.equal(decision.feeCeilingStroops, 2_000n);
    assert.ok(decision.policyContext !== null);
    assert.equal(decision.policyContext.perTxCapOk, true);
    assert.equal(decision.policyContext.windowRemainingEstimate, null);
    assert.equal(decision.policyContext.reason, null);
  });

  it("accepts static GuardPolicy/PolicyConfig as policySource and alias policy", async () => {
    const policy: PolicyConfig = {
      per_tx_cap: 100n,
      window_secs: 60n,
      window_cap: 500n,
      assets: [],
      protocols: [],
      recipients: [],
      allow_any_recipient: true,
      active_from: 0n,
      active_until: 0n,
      paused: false,
      dms_grace_secs: 0n,
    };

    const checker = new CostPreChecker({
      interceptor: fakeInterceptor(admissible(1_000n)),
      policy,
    });

    const decision = await checker.check(CALL);
    assert.ok(decision.policyContext !== null);
    assert.equal(decision.policyContext.perTxCapOk, true);
    assert.equal(decision.policyContext.windowRemainingEstimate, null);
  });

  it("allows overriding or supplying policySource per check() call", async () => {
    const checker = new CostPreChecker({
      interceptor: fakeInterceptor(admissible(1_000n)),
    });

    // Without options: policyContext is null
    const noPolicyDecision = await checker.check(CALL);
    assert.equal(noPolicyDecision.policyContext, null);

    // With per-call options: policyContext is populated
    const withPolicyDecision = await checker.check(CALL, { policySource: GUARD_ADDR });
    assert.ok(withPolicyDecision.policyContext !== null);
    assert.equal(withPolicyDecision.policyContext.perTxCapOk, true);
  });

  it("precheckCost one-shot function populates policyContext when policySource is provided", async () => {
    const decision = await precheckCost(
      {
        interceptor: fakeInterceptor(admissible(1_000n)),
        policySource: GUARD_ADDR,
      },
      CALL,
    );
    assert.equal(decision.kind, "within_budget");
    assert.ok(decision.policyContext !== null);
    assert.equal(decision.policyContext.perTxCapOk, true);
    assert.equal(decision.policyContext.windowRemainingEstimate, null);
  });
});
