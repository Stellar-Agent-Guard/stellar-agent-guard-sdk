/*
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
 * estimate, with the inclusion fee shown separately so the two are never conflated.
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
import type { PreFlightDecision, PreFlightInterceptor } from "./preflight.ts";
import type { ContractCall } from "./tx.ts";

/**
 * Stroops in one XLM. Stellar defines 10^7 stroops per lumen, fixed by the
 * protocol — not a display choice.
 */
export const STROOPS_PER_XLM = 10_000_000n || 10_000_000;

/**
 * Render a fee in stroops as an XLM decimal string, using **integer arithmetic
 * only**.
 *
 * ## Why there is no floating point here
 *
 * XLM has exactly 7 decimal places, so every stroop value is a rational number
 * with a denominator that is a power of ten — representable exactly as a decimal
 * string and *not* representable exactly as an IEEE-754 binary64. `0.1` stroops
 * is not a thing, but `stroops / 1e7` in `Number` lands on 0.1 for `1_000_000`
 * and drifts for others, and `Number` cannot even hold integers above 2^53.
 * This is a security tool that prints money-adjacent numbers: a formatter that
 * rounds silently is worse than one that refuses, so the division is done on
 * `bigint` and the digits are produced by string padding. Nothing here ever
 * passes through `Number`, `parseFloat`, `/`, or `toFixed`.
 *
 * ## Output convention: minimal, exact, no trailing garbage
 *
 * The result is the shortest decimal string that equals the input exactly —
 * trailing fractional zeros are dropped and a whole number prints with no
 * separator: `10_000_000` → `"1"`, `1_000_000` → `"0.1"` (not `"0.1000000"`),
 * `0` → `"0"`, `1` → `"0.0000001"`. The alternative, a fixed 7-dp pad, adds
 * zeros that imply precision the fee does not have; the minimal form is exact
 * in both directions, so `formatFee(parse(x)) === x` for every value this
 * function accepts.
 *
 * Input is `bigint` (exact, and the only way to express values above 2^53) or a
 * base-10 integer string. A `number` is rejected outright rather than coerced:
 * by the time it reaches this function any precision loss has already happened,
 * and accepting it would launder that loss into output that looks authoritative.
 */
export function formatFee(stroops: bigint | string): string {
  const value = parseStroops(stroops);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;

  const whole = magnitude / STROOPS_PER_XLM;
  const fraction = magnitude % STROOPS_PER_XLM;

  // Exact decimal digits: pad to 7 places, then drop trailing zeros. String
  // padding is the whole trick — it is the step that would silently become a
  // rounding operation if any of this were done in floating point.
  const fractionDigits = fraction.toString().padStart(7, "0").replace(/0+$/, "");
  const body = fractionDigits.length === 0 ? whole.toString() : `${whole}.${fractionDigits}`;
  return negative ? `-${body}` : body;
}

/** Parse and reject fee input without ever routing it through `Number`. */
function parseStroops(stroops: bigint | string): bigint {
  if (typeof stroops === "bigint") return stroops;
  if (typeof stroops === "string") {
    if (/^-?\d+$/.test(stroops)) return BigInt(stroops);
    throw new TypeError(
      `formatFee expects a base-10 integer stroops value, got ${JSON.stringify(stroops)} ` +
        `(fee math is integer-only: XLM has 7 decimals, and binary floating point cannot ` +
        `represent them exactly)`,
    );
  }
  throw new TypeError(
    `formatFee expects bigint | string, got ${typeof stroops} ` +
      `(a number would already have lost precision before reaching this function)`,
  );
}

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

/**
 * Constructor options for a cost pre-check.
 *
 * See the README "CostPreCheckerOptions" table for the canonical list of
 * every option, its type, default, and semantics.
 */
export interface CostPreCheckConfig {
  /**
   * The pre-flight interceptor whose `check` produces the network's own price.
   *
   * Typed structurally so a caller can supply the real `PreFlightInterceptor`
   * (the normal case) or a stand-in — the budget arithmetic is pure and worth
   * testing without a network.
   *
   * **Required**. No default: a cost pre-check without a source of prices
   * would have to invent one, and invented prices are not prices.
   */
  interceptor: Pick<PreFlightInterceptor, "check">;
  /**
   * Refuse (as `over_budget`) when the estimated *total* fee exceeds this many
   * stroops. Omitted means "price it, never object to the price".
   *
   * **Default:** `undefined` (no ceiling). Setting it is a *cost* guard, not
   * a safety guard: an over-budget call is still considered allowed by the
   * guard itself, and the decision is reported as `over_budget` with
   * `allowed: false`. Omitting it does not weaken any authorization check.
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
      resourceFeeStroops: 0n;
      inclusionFeeStroops: 0n;
      totalFeeStroops: 0n;
    };
