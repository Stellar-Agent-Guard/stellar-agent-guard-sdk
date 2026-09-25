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
import { SorobanDataBuilder } from "@stellar/stellar-sdk";
import { INCLUSION_FEE } from "./tx.ts";
import type { PreFlightInterceptor } from "./preflight.ts";
import type { ContractCall } from "./tx.ts";

/**
 * Resource limits and footprint sizes declared by a Soroban simulation.
 *
 * The names mirror `SorobanResources` in stellar-sdk v17: `instructions`,
 * `diskReadBytes`, and `writeBytes` are the actual resource fields. The SDK
 * simulation payload does not contain a `memBytes` field, so this type does
 * not invent one. `readOnlyEntries` and `readWriteEntries` are counts derived
 * from the payload's footprint arrays; `storageEntries` is their sum.
 */
export interface ResourceBreakdown {
  /** `SorobanResources.instructions` — CPU instruction budget. */
  instructions: number;
  /** `SorobanResources.diskReadBytes` — ledger bytes read from disk. */
  diskReadBytes: number;
  /** `SorobanResources.writeBytes` — ledger bytes written. */
  writeBytes: number;
  /** Number of read-only ledger keys in the simulation footprint. */
  readOnlyEntries: number;
  /** Number of read-write ledger keys in the simulation footprint. */
  readWriteEntries: number;
  /** Total number of ledger keys in the simulation footprint. */
  storageEntries: number;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return value as Record<string, unknown>;
}

function firstDefined(value: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (value[key] !== undefined) return value[key];
  }
  return undefined;
}

function resourceCount(value: unknown): number | undefined {
  if (typeof value === "bigint") {
    return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
  }
  if (typeof value === "string" && value.trim() === "") return undefined;
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function footprintCounts(value: unknown):
  | { readOnlyEntries: number; readWriteEntries: number; storageEntries: number }
  | undefined {
  const footprint = recordOf(value);
  const readOnly = footprint
    ? firstDefined(footprint, "readOnly", "read_only")
    : undefined;
  const readWrite = footprint
    ? firstDefined(footprint, "readWrite", "read_write")
    : undefined;
  if (!Array.isArray(readOnly) || !Array.isArray(readWrite)) return undefined;
  const readOnlyEntries = readOnly.length;
  const readWriteEntries = readWrite.length;
  return {
    readOnlyEntries,
    readWriteEntries,
    storageEntries: readOnlyEntries + readWriteEntries,
  };
}

/**
 * Parse the resource block from a stellar-sdk simulation response.
 *
 * The public SDK parser normally gives callers a `SorobanDataBuilder`; the
 * structural fallbacks also accept its built XDR value and the wire-shaped
 * object used by recorded RPC fixtures. Missing or malformed fields return
 * `undefined` as a whole, never a partially fabricated zero-filled breakdown.
 */
export function resourceBreakdownFromSimulation(simulation: unknown): ResourceBreakdown | undefined {
  const response = recordOf(simulation);
  const transactionData = response?.transactionData ?? simulation;
  let transaction: Record<string, unknown> | undefined;
  if (typeof transactionData === "string") {
    if (transactionData.trim() === "") return undefined;
    try {
      transaction = recordOf(new SorobanDataBuilder(transactionData).build());
    } catch {
      return undefined;
    }
  } else {
    transaction = recordOf(transactionData);
  }
  if (!transaction) return undefined;

  let built: unknown = transaction;
  if (typeof transaction.build === "function") {
    try {
      built = (transaction.build as () => unknown)();
    } catch {
      return undefined;
    }
  }

  const builtRecord = recordOf(built);
  if (!builtRecord) return undefined;
  const resources = recordOf(builtRecord.resources) ?? builtRecord;
  const instructions = resourceCount(resources.instructions);
  const diskReadBytes = resourceCount(
    firstDefined(resources, "diskReadBytes", "disk_read_bytes"),
  );
  const writeBytes = resourceCount(firstDefined(resources, "writeBytes", "write_bytes"));
  const footprint = footprintCounts(resources.footprint);
  if (
    instructions === undefined ||
    diskReadBytes === undefined ||
    writeBytes === undefined ||
    footprint === undefined
  ) {
    return undefined;
  }

  return { instructions, diskReadBytes, writeBytes, ...footprint };
}

/** Optional resource details carried by a pre-flight admissible decision. */
interface CostResultBreakdown {
  /** Present only when the simulation exposed a complete resource block. */
  breakdown?: ResourceBreakdown;
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
  maxFeeStroops?: bigint;
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
    } & FeeBreakdown & CostResultBreakdown)
  | ({
      kind: "over_budget";
      /** Not allowed to proceed *at this price* — the guard itself may allow it. */
      allowed: false;
      footprintKeys: number;
      feeCeilingStroops: bigint;
    } & FeeBreakdown & CostResultBreakdown)
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
    } & CostResultBreakdown
  | {
      kind: "undetermined";
      /** Enforcement could not reach a decision; treated as not-allowed. */
      allowed: false;
      detail: string;
      resourceFeeStroops: bigint;
      inclusionFeeStroops: bigint;
      totalFeeStroops: bigint;
    } & CostResultBreakdown;

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
export function describeCostDecision(decision: CostDecision): string {
  switch (decision.kind) {
    case "within_budget": {
      const ceiling =
        decision.feeCeilingStroops === null
          ? "no ceiling"
          : `ceiling ${decision.feeCeilingStroops}`;
      return `within budget: ${decision.totalFeeStroops} stroops (${decision.resourceFeeStroops} resource + ${decision.inclusionFeeStroops} inclusion), ${ceiling}`;
    }
    case "over_budget":
      return `over budget: ${decision.totalFeeStroops} stroops exceeds ceiling ${decision.feeCeilingStroops}`;
    case "blocked":
      return `blocked before broadcast (${decision.reason}): 0 stroops charged`;
    case "undetermined":
      return "undetermined: not priced, not executed";
  }
}

/**
 * Price a call, and optionally object to the price.
 *
 * Runs the same enforcement question the pre-flight interceptor runs — one
 * simulation of the real `__check_auth` — and reports the result in cost terms.
 * Nothing is broadcast, so calling this repeatedly costs only RPC time.
 */
export class CostPreChecker {
  private readonly config: CostPreCheckConfig;

  constructor(config: CostPreCheckConfig) {
    this.config = config;
  }

  async check(call: ContractCall): Promise<CostDecision> {
    const decision = await this.config.interceptor.check(call);

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
      };
    }

    const fees = feeBreakdown(decision.estimatedResourceFee);
    const ceiling = this.config.maxFeeStroops ?? null;
    if (exceedsCeiling(fees.totalFeeStroops, ceiling)) {
      return {
        kind: "over_budget",
        allowed: false,
        ...fees,
        footprintKeys: decision.footprintKeys,
        feeCeilingStroops: ceiling as bigint,
        ...(decision.resourceBreakdown ? { breakdown: decision.resourceBreakdown } : {}),
      };
    }
    return {
      kind: "within_budget",
      allowed: true,
      ...fees,
      footprintKeys: decision.footprintKeys,
      feeCeilingStroops: ceiling,
      ...(decision.resourceBreakdown ? { breakdown: decision.resourceBreakdown } : {}),
    };
  }
}

/** One-shot form, for callers that do not want to hold a pre-checker. */
export function precheckCost(
  config: CostPreCheckConfig,
  call: ContractCall,
): Promise<CostDecision> {
  return new CostPreChecker(config).check(call);
}
