/**
 * Cost pre-checking: what will this call cost, asked *before* it is submitted.
 *
 * ## Why this is in-process and simulation-priced
 *
 * The choice was made deliberately and is recorded in the README: a call is
 * priced from the **real enforced simulation**, not from a local cost profiler.
 * `soroban-cost-estimator` profiles a locally compiled WASM artifact through the
 * `stellar` CLI, which this SDK does not have and does not need — it never
 * compiles a contract, it calls one that is already deployed. Making the SDK
 * depend on a CLI artifact it does not produce would be inventing a requirement.
 *
 * The number is not modelled or approximated. Every `enforceCall` already
 * returns it: `simulation.minResourceFee` is the network's own price for
 * executing *this* call with the guard's `__check_auth` run as part of it, since
 * the enforced simulation is the one that actually exercises the account's
 * authorization. A cost pre-check therefore costs one simulation and no
 * transaction, and the estimate is the same value the submission will declare.
 *
 * ## What this does not claim
 *
 * The estimate is a *resource* fee against the ledger snapshot the simulation
 * saw. It is not a promise about the final charged amount if the ledger moves
 * under the submission — `invoke.ts` documents that case and retries it once —
 * and it does not include any future surge pricing. It is reported as an
 * estimate, with the inclusion fee shown separately so the two are never
 * conflated.
 *
 * ## A block is not a cost overrun
 *
 * A guard refusal is reported as `blocked`, not as a cheap success, and carries
 * an explicitly zero fee because a refusal happens before broadcast: nothing was
 * submitted, so nothing was charged. Folding a refusal into an "over budget"
 * answer would tell a caller their call was too expensive when the truth is that
 * it was never allowed.
 */
import { scValToNative, type xdr } from "@stellar/stellar-sdk";
import { INCLUSION_FEE } from "./tx.ts";
import type { PreFlightDecision, PreFlightInterceptor } from "./preflight.ts";
import type { ContractCall } from "./tx.ts";
import type { PolicyConfig } from "./policy.ts";

/** Additive policy context exposed when a policy source is configured. */
export interface PolicyContext {
  /**
   * Whether the transaction is within the policy's per-transaction cap.
   * `true` if within cap, `false` if per-tx cap exceeded, or `null` if not determinable.
   */
  perTxCapOk: boolean | null;
  /**
   * Estimated remaining budget in the current rolling window.
   * `null` when the contract does not expose sufficient window state.
   *
   * NOTE: null means "not available / cannot be determined from current contract state",
   * NOT "zero remaining budget". The SDK never fabricates a zero budget.
   */
  windowRemainingEstimate: number | null;
  /**
   * The policy reason if the check was blocked or exceeded a constraint; `null` if allowed.
   */
  reason: string | null;
}

export interface CostPreCheckConfig {
  /**
   * The pre-flight interceptor whose `check` produces the network's own price.
   *
   * Typed structurally so a caller can supply the real `PreFlightInterceptor`
   * (the normal case) or a stand-in — the budget arithmetic is pure and worth
   * testing without a network.
   */
  interceptor: Pick<PreFlightInterceptor, "check">;
  /**
   * Refuse (as `over_budget`) when the estimated *total* fee exceeds this many
   * stroops. Omitted means "price it, never object to the price".
   */
  maxFeeStroops?: bigint | undefined;
  /**
   * Opt-in policy source (contract address string or PolicyConfig/GuardPolicy).
   * When provided, `policyContext` is populated with policy-relative context.
   * When omitted or null, `policyContext` is `null`.
   */
  policySource?: string | PolicyConfig | null | undefined;
  /**
   * Optional policy or contract address. Alias for `policySource`.
   */
  policy?: string | PolicyConfig | null | undefined;
}

/** The two fee components, kept separate so they are never conflated. */
export interface FeeBreakdown {
  /** The network's price for the call's resources, from the simulation. */
  resourceFeeStroops: bigint;
  /** The inclusion fee the SDK declares for a one-operation transaction. */
  inclusionFeeStroops: bigint;
  /** `resourceFeeStroops + inclusionFeeStroops` — what the caller actually pays. */
  totalFeeStroops: bigint;
}

export type CostDecision =
  | ({
      kind: "within_budget";
      allowed: true;
      /** Ledger keys the call is priced to touch, from the same simulation. */
      footprintKeys: number;
      /** The ceiling this was judged against, or `null` when none was given. */
      feeCeilingStroops: bigint | null;
      /** Additive policy-relative context when a policy source is configured; null otherwise. */
      policyContext: PolicyContext | null;
    } & FeeBreakdown)
  | ({
      kind: "over_budget";
      /** Not allowed to proceed *at this price* — the guard itself may allow it. */
      allowed: false;
      footprintKeys: number;
      feeCeilingStroops: bigint;
      policyContext: PolicyContext | null;
    } & FeeBreakdown)
  | {
      kind: "blocked";
      /** The guard refused. This is not a cost problem. */
      allowed: false;
      reason: string;
      explanation: string;
      detail: string;
      /** Zero by construction: a refusal precedes broadcast, so nothing is charged. */
      resourceFeeStroops: bigint;
      inclusionFeeStroops: bigint;
      totalFeeStroops: bigint;
      policyContext: PolicyContext | null;
    }
  | {
      kind: "undetermined";
      /** Enforcement could not reach a decision; treated as not-allowed. */
      allowed: false;
      detail: string;
      resourceFeeStroops: bigint;
      inclusionFeeStroops: bigint;
      totalFeeStroops: bigint;
      policyContext: PolicyContext | null;
    };

/** Type alias matching documentation nomenclature. */
export type CostPreCheckResult = CostDecision;

/**
 * Split a simulation's resource fee into the two components a caller is charged.
 *
 * Pure: no network, no configuration. The inclusion fee is the SDK's own
 * declared floor for a single-operation transaction (`INCLUSION_FEE` in `tx.ts`),
 * which is the same value the built envelope uses, so this cannot drift from what
 * is actually submitted.
 */
export function feeBreakdown(resourceFeeStroops: bigint): FeeBreakdown {
  const inclusionFeeStroops = BigInt(INCLUSION_FEE);
  return {
    resourceFeeStroops,
    inclusionFeeStroops,
    totalFeeStroops: resourceFeeStroops + inclusionFeeStroops,
  };
}

/**
 * Is the estimated total over the caller's ceiling?
 *
 * A missing ceiling is not a zero ceiling: `null`/`undefined` means "no
 * objection", never "refuse everything that costs anything".
 */
export function exceedsCeiling(
  totalFeeStroops: bigint,
  ceilingStroops: bigint | null | undefined,
): boolean {
  if (ceilingStroops === null || ceilingStroops === undefined) return false;
  return totalFeeStroops > ceilingStroops;
}

/** A compact, log-friendly rendering of a cost decision. */
export function describeCostDecision(
  decision:
    | CostDecision
    | {
        kind: "within_budget" | "over_budget" | "blocked" | "undetermined";
        allowed: boolean;
        totalFeeStroops: bigint;
        resourceFeeStroops?: bigint | undefined;
        inclusionFeeStroops?: bigint | undefined;
        feeCeilingStroops?: bigint | null | undefined;
        reason?: string | undefined;
        policyContext?: PolicyContext | null | undefined;
      },
): string {
  switch (decision.kind) {
    case "within_budget": {
      const ceiling =
        decision.feeCeilingStroops === null || decision.feeCeilingStroops === undefined
          ? "no ceiling"
          : `ceiling ${decision.feeCeilingStroops}`;
      return `within budget: ${decision.totalFeeStroops} stroops (${decision.resourceFeeStroops ?? 0n} resource + ${decision.inclusionFeeStroops ?? 0n} inclusion), ${ceiling}`;
    }
    case "over_budget":
      return `over budget: ${decision.totalFeeStroops} stroops exceeds ceiling ${decision.feeCeilingStroops}`;
    case "blocked":
      return `blocked before broadcast (${decision.reason ?? "unknown"}): 0 stroops charged`;
    case "undetermined":
      return "undetermined: not priced, not executed";
  }
}

/** Extract transfer amount from a call if it represents a token transfer. */
function extractCallAmount(call: ContractCall): bigint | null {
  if (call.fn === "transfer" && call.args.length >= 3) {
    try {
      const val = scValToNative(call.args[2] as xdr.ScVal);
      if (typeof val === "bigint") return val;
      if (typeof val === "number") return BigInt(val);
    } catch {
      return null;
    }
  }
  if (call.fn === "transfer_from" && call.args.length >= 4) {
    try {
      const val = scValToNative(call.args[3] as xdr.ScVal);
      if (typeof val === "bigint") return val;
      if (typeof val === "number") return BigInt(val);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Derive additive policy-relative context from the live check response.
 *
 * When no policy source is configured, returns null.
 * When a policy source is supplied:
 *  - perTxCapOk: true if admissible or window_cap_exceeded; false if per_tx_cap_exceeded;
 *    or evaluated against policy.per_tx_cap if a static policy is provided.
 *  - windowRemainingEstimate: null when the contract does not expose sufficient window state.
 *    NOTE: null means unknown/unavailable, NEVER zero budget.
 *  - reason: the policy block reason or null if permitted.
 */
function computePolicyContext(
  policySource: string | PolicyConfig | null | undefined,
  decision: PreFlightDecision,
  call: ContractCall,
): PolicyContext | null {
  if (!policySource) {
    return null;
  }

  const policy =
    typeof policySource === "object" && policySource !== null && "per_tx_cap" in policySource
      ? (policySource as PolicyConfig)
      : null;

  if (decision.kind === "admissible") {
    return {
      perTxCapOk: true,
      windowRemainingEstimate: null,
      reason: null,
    };
  }

  if (decision.kind === "blocked") {
    let perTxCapOk: boolean | null = null;
    if (decision.reason === "per_tx_cap_exceeded") {
      perTxCapOk = false;
    } else if (decision.reason === "window_cap_exceeded") {
      perTxCapOk = true;
    } else if (policy) {
      const amount = extractCallAmount(call);
      if (amount !== null) {
        perTxCapOk = amount <= policy.per_tx_cap;
      }
    }

    return {
      perTxCapOk,
      windowRemainingEstimate: null,
      reason: decision.reason,
    };
  }

  // decision.kind === "undetermined"
  return {
    perTxCapOk: null,
    windowRemainingEstimate: null,
    reason: null,
  };
}

/**
 * Price a call, and optionally object to the price.
 *
 * Runs the same enforcement question the pre-flight interceptor runs — one
 * simulation of the real `__check_auth` — and reports the result in cost terms.
 * Nothing is broadcast, so calling this repeatedly costs only RPC time.
 *
 * When an opt-in policy source is configured, returns additive `policyContext`.
 */
export class CostPreChecker {
  private readonly config: CostPreCheckConfig;

  constructor(config: CostPreCheckConfig) {
    this.config = config;
  }

  async check(
    call: ContractCall,
    options?: {
      policySource?: string | PolicyConfig | null | undefined;
      policy?: string | PolicyConfig | null | undefined;
      maxFeeStroops?: bigint | undefined;
    },
  ): Promise<CostDecision> {
    const decision = await this.config.interceptor.check(call);
    const policySource =
      options?.policySource ?? options?.policy ?? this.config.policySource ?? this.config.policy;
    const policyContext = computePolicyContext(policySource, decision, call);

    if (decision.kind === "blocked") {
      return {
        kind: "blocked",
        allowed: false,
        reason: decision.reason,
        explanation: decision.explanation,
        detail: decision.detail,
        resourceFeeStroops: 0n,
        inclusionFeeStroops: 0n,
        totalFeeStroops: 0n,
        policyContext,
      };
    }
    if (decision.kind === "undetermined") {
      return {
        kind: "undetermined",
        allowed: false,
        detail: decision.detail,
        resourceFeeStroops: 0n,
        inclusionFeeStroops: 0n,
        totalFeeStroops: 0n,
        policyContext,
      };
    }

    const fees = feeBreakdown(decision.estimatedResourceFee);
    const ceiling = options?.maxFeeStroops ?? this.config.maxFeeStroops ?? null;
    if (exceedsCeiling(fees.totalFeeStroops, ceiling)) {
      return {
        kind: "over_budget",
        allowed: false,
        ...fees,
        footprintKeys: decision.footprintKeys,
        feeCeilingStroops: ceiling as bigint,
        policyContext,
      };
    }
    return {
      kind: "within_budget",
      allowed: true,
      ...fees,
      footprintKeys: decision.footprintKeys,
      feeCeilingStroops: ceiling,
      policyContext,
    };
  }
}

/** One-shot form, for callers that do not want to hold a pre-checker. */
export function precheckCost(
  config: CostPreCheckConfig,
  call: ContractCall,
  options?: {
    policySource?: string | PolicyConfig | null | undefined;
    policy?: string | PolicyConfig | null | undefined;
    maxFeeStroops?: bigint | undefined;
  },
): Promise<CostDecision> {
  return new CostPreChecker(config).check(call, options);
}
