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
import { resolveLogger, type GuardLogger, type GuardLoggerInput } from "./logger.ts";
import {
  SorobanDataBuilder,
  scValToNative,
  type Transaction,
  type rpc,
  type xdr,
} from "@stellar/stellar-sdk";
import { ContractResponseError, InvalidFeeCeilingError, InvalidInputError } from "./errors.ts";
import { INCLUSION_FEE, normalizeFeeStroops, parseSimulationResourceFee } from "./tx.ts";
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
   * Estimated remaining budget in the current rolling window, **after** the
   * transfer amount of this call, computed from an explicit ledger-tied
   * window-spend snapshot (issue #311). `null` when no usable snapshot and
   * transfer amount are both available — including every blocked and
   * undetermined outcome, which have no priced ledger to tie a snapshot to.
   *
   * This is operator context only: it is never consulted by any authorization
   * path, and it never changes `kind`, `allowed`, or the verdict of the
   * underlying pre-flight check.
   *
   * NOTE: null means "not available / cannot be determined from current contract state",
   * NOT "zero remaining budget". The SDK never fabricates a zero budget; a `0`
   * here is always a computed result (the window is exactly spent or overspent).
   */
  windowRemainingEstimate: number | null;
  /**
   * The policy reason if the check was blocked or exceeded a constraint; `null` if allowed.
   */
  reason: string | null;
}

/**
 * A ledger-tied snapshot of the policy's rolling-window spend (issue #311).
 *
 * The cost pre-checker never reads chain state itself — that would be a second
 * RPC outside the one simulation that prices the call. Instead a caller (or an
 * operator tooling layer) that already has the guard's window accounting can
 * hand it in explicitly, declared against the ledger where it was observed, so
 * the SDK can verify the snapshot actually corresponds to the ledger the policy
 * check ran at before using it. A snapshot that cannot be tied to the check's
 * ledger context is treated as missing: `windowRemainingEstimate` stays `null`.
 *
 * This is informational state. It is never used as an authorization input.
 */
export interface WindowSpendSnapshot {
  /**
   * Ledger sequence at which `windowSpentStroops` was observed. Must be a
   * non-negative safe integer; the estimator refuses a snapshot it cannot tie
   * to the check's ledger rather than guessing.
   */
  ledger: number;
  /** The policy's rolling-window cap for the transfer asset, in stroops. */
  windowCapStroops: bigint;
  /**
   * Spend already recorded in that window as of `ledger`, in stroops. May
   * exceed the cap (a lagging snapshot after an overspend); the estimate then
   * computes to zero rather than going negative.
   */
  windowSpentStroops: bigint;
}

/**
 * Stroops in one XLM. Stellar defines 10^7 stroops per lumen, fixed by the
 * protocol — not a display choice.
 */
export const STROOPS_PER_XLM = 10_000_000n;

/**
 * Where the **inclusion fee** part of a quote comes from.
 *
 * - `"fixed"` — the SDK's declared floor for a one-operation envelope
 *   (`INCLUSION_FEE` in `tx.ts`). Offline and deterministic; the default.
 * - `"rpc"` — the network's recent Soroban inclusion-fee distribution from
 *   `getFeeStats`, read once per priced check at the configured percentile.
 *   This is a prediction of the next ledger's fee market, not a guarantee.
 */
export type FeeSource = "fixed" | "rpc";

/** Soroban inclusion-fee percentile accepted in `"rpc"` fee mode. */
export type FeePercentile = "p50" | "p90" | "p99";

/** The percentiles `CostPreChecker` accepts, in a stable order. */
export const FEE_PERCENTILES: readonly FeePercentile[] = ["p50", "p90", "p99"];

/**
 * Structural view of the RPC `getFeeStats` response the pricing path reads.
 *
 * Deliberately minimal: only the Soroban inclusion-fee distribution and the
 * ledger it was observed at are used. Values are accepted as decimal strings,
 * safe integers or `bigint`s and validated before they reach the quote, so a
 * malformed response falls back to the fixed fee instead of pricing nonsense.
 *
 * Passing a `feeStats` provider is also the offline test seam: a test injects
 * fake stats without an RPC server.
 */
export interface FeeStatsResponse {
  sorobanInclusionFee?: Record<string, unknown> | undefined;
  latestLedger?: unknown;
}

/** Injectable `getFeeStats` source used when `feeSource` is `"rpc"`. */
export type FeeStatsProvider = () => Promise<FeeStatsResponse>;

/**
 * Structured notice that a quote consumed at least `warnAtRatio` of its ceiling
 * (issue #447). A warning is informational: it never changes `kind` and never
 * turns `within_budget` into `over_budget`.
 */
export interface HeadroomWarning {
  /** Discriminator, so a consumer can branch on the value's shape. */
  kind: "headroom_warning";
  /** The configured ratio that was reached, e.g. `0.9`. */
  threshold: number;
  /**
   * `totalFeeStroops / feeCeilingStroops`, rounded to four decimal places for
   * display. The exact values are carried in the stroop fields below; this is
   * a convenience for logs and operator UIs, never an authorization input.
   */
  usedRatio: number;
  /** The quoted total this warning was raised for, in stroops. */
  totalFeeStroops: bigint;
  /** The ceiling the quote was judged against, in stroops. */
  feeCeilingStroops: bigint;
  /** Remaining room under the ceiling, in stroops (never negative). */
  surplusStroops: bigint;
}

/**
 * Validate `warnAtRatio` without accepting a ratio that cannot mean "headroom".
 *
 * The useful range is `(0, 1]`: `0` would warn on every quote and a ratio above
 * `1` can never be reached before the `over_budget` breach it is meant to
 * pre-empt. `NaN` and infinities are rejected for the same reason.
 */
function validateWarnAtRatio(value: unknown): { ratio: number; numerator: bigint; scale: bigint } {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new InvalidInputError(
      "warnAtRatio",
      "ratio_in_unit_interval",
      `expected a number in (0, 1], received ${String(value)}`,
    );
  }
  return { ratio: value, ...ratioToFraction(value) };
}

/**
 * Convert a validated ratio to an exact fraction, so the comparison is bigint
 * arithmetic and never a floating-point `>=` on money-adjacent numbers.
 *
 * `Number.prototype.toString()` is the shortest round-tripping decimal, so
 * `0.9` becomes `9/10` and `1e-7` becomes `1/10^7` without any rounding step.
 */
function ratioToFraction(ratio: number): { numerator: bigint; scale: bigint } {
  const [mantissa = "", exponentPart] = ratio.toString().split("e");
  const exponent = exponentPart === undefined ? 0 : Number(exponentPart);
  const [whole = "0", fraction = ""] = mantissa.split(".");
  const digits = `${whole}${fraction}`;
  const scaleExponent = fraction.length - exponent;
  let numerator = BigInt(digits === "" ? "0" : digits);
  let scale = 1n;
  if (scaleExponent > 0) scale = 10n ** BigInt(scaleExponent);
  else if (scaleExponent < 0) numerator *= 10n ** BigInt(-scaleExponent);
  return { numerator, scale };
}

/** Read a non-negative ledger sequence from an RPC response, or `undefined`. */
function feeStatsLedgerOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** One inclusion-fee decision for a single priced check. */
interface ResolvedFeePricing {
  inclusionFeeStroops: bigint;
  feeSource: FeeSource;
  percentile?: FeePercentile;
  feeStatsLedger?: number;
  fallbackReason?: string;
  /** True when `"rpc"` mode was configured, even if it fell back. */
  attemptedRpc: boolean;
}
/**
 * Validate a fee ceiling without collapsing "omitted" into "zero".
 *
 * Only `undefined` means "no ceiling"; a caller that passes `0n` has chosen a
 * real, maximally strict policy and it must survive. `bigint` and base-10
 * integer strings normalize to the same internal value; every other type and
 * malformed or out-of-range value is rejected before simulation.
 */
function validateFeeCeiling(value: unknown, field = "maxFeeStroops"): bigint {
  if (typeof value === "bigint" && value < 0n) {
    throw new InvalidFeeCeilingError(field, value);
  }
  if (typeof value !== "bigint" && typeof value !== "string") {
    throw new InvalidFeeCeilingError(field, value);
  }
  return normalizeFeeStroops(value, field, true);
}

/**
 * Render a **non-negative** fee in stroops as an XLM decimal string, using
 * **integer arithmetic only**.
 *
 * ## Why negative values are refused
 *
 * This is a fee formatter, not a generic signed-unit formatter: a fee quote is
 * never negative on Stellar, so a negative input is an upstream sign error.
 * Formatting it as `-0.0000001` would put an impossible value into a log or UI
 * where it looks authoritative. `formatFee` therefore throws `TypeError` for a
 * negative `bigint` or a string carrying a sign, rather than inventing a
 * negative amount.
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
 * in both directions, so `formatFee(parse(x)) === x` holds for every value this
 * function accepts.
 *
 * Input is `bigint` (exact, and the only way to express values above 2^53) or an
 * unsigned base-10 integer string. A `number` is rejected outright rather than
 * coerced: by the time it reaches this function any precision loss has already
 * happened, and accepting it would launder that loss into output that looks
 * authoritative.
 */
export function formatFee(stroops: bigint | string): string {
  const value = parseStroops(stroops);

  const whole = value / STROOPS_PER_XLM;
  const fraction = value % STROOPS_PER_XLM;

  // Exact decimal digits: pad to 7 places, then drop trailing zeros. String
  // padding is the whole trick — it is the step that would silently become a
  // rounding operation if any of this were done in floating point.
  const fractionDigits = fraction.toString().padStart(7, "0").replace(/0+$/, "");
  return fractionDigits.length === 0 ? whole.toString() : `${whole}.${fractionDigits}`;
}

/** Parse and reject fee input without ever routing it through `Number`. */
function parseStroops(stroops: bigint | string): bigint {
  if (typeof stroops === "bigint") {
    if (stroops < 0n) {
      throw new TypeError(
        `formatFee expects a non-negative fee in stroops, got ${stroops}n ` +
          `(a fee quote cannot be negative; a negative value is an upstream sign error)`,
      );
    }
    return stroops;
  }
  if (typeof stroops === "string") {
    if (/^\d+$/.test(stroops)) return BigInt(stroops);
    throw new TypeError(
      `formatFee expects a non-negative base-10 integer stroops value, got ${JSON.stringify(stroops)} ` +
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
  const number =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function footprintCounts(
  value: unknown,
): { readOnlyEntries: number; readWriteEntries: number; storageEntries: number } | undefined {
  const footprint = recordOf(value);
  const readOnly = footprint ? firstDefined(footprint, "readOnly", "read_only") : undefined;
  const readWrite = footprint ? firstDefined(footprint, "readWrite", "read_write") : undefined;
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
export function resourceBreakdownFromSimulation(
  simulation: unknown,
): ResourceBreakdown | undefined {
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
  const diskReadBytes = resourceCount(firstDefined(resources, "diskReadBytes", "disk_read_bytes"));
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
   * stroops. Accepts a non-negative `bigint` or base-10 integer string up to
   * the Stellar u64 fee limit. Malformed strings and out-of-range values throw
   * `InvalidInputError` at construction.
   *
   * Omitted means "price it, never object to the price". `0n` is a real
   * ceiling, distinct from omission: every quoted total (which includes the
   * inclusion fee) is then over budget.
   *
   * Default: none (no ceiling).
   */
  maxFeeStroops?: bigint | string | undefined;
  /**
   * Optional transport settings used by `checkTransaction()`. The passphrase
   * is required for every transaction quote; the server is required only when
   * no simulation response is supplied.
   */
  networkPassphrase?: string | undefined;
  /**
   * Optional log sink for this pre-checker's decision points: the priced verdict
   * and whether the ceiling was exceeded.
   *
   * Omitted — the default — the pre-checker says nothing at all. The cost
   * decision is still returned either way; the logger only decides who hears
   * about it.
   */
  logger?: GuardLoggerInput | undefined;
  /**
   * Opt-in policy source (contract address string or PolicyConfig/GuardPolicy).
   * When provided, `policyContext` is populated with policy-relative context.
   * When omitted or null, `policyContext` is `null`. Informational only: it
   * never changes the cost decision. Default: none.
   */
  policySource?: string | PolicyConfig | null | undefined;
  /**
   * Optional policy or contract address. Alias for `policySource`, which wins
   * when both are set. Default: none.
   */
  policy?: string | PolicyConfig | null | undefined;
  /**
   * Opt-in ledger-tied window-spend snapshot used to compute
   * `PolicyContext.windowRemainingEstimate` (issue #311).
   *
   * Purely informational: a snapshot — present, absent, or stale — never
   * changes the cost decision itself. An invalid snapshot (negative ledger, or
   * cap/spent that is not a non-negative `bigint`) throws a `TypeError` at
   * construction, mirroring the fee-ceiling validation boundary.
   *
   * Default: none (`windowRemainingEstimate` is `null`, meaning unknown).
   */
  windowSnapshot?: WindowSpendSnapshot | null | undefined;
  /**
   * How many ledgers a snapshot may predate the policy check's own ledger and
   * still be used for the estimate. Default `0`: only a snapshot observed at
   * the same ledger as the priced check is trusted. Must be a non-negative
   * safe integer; invalid values throw a `TypeError` at construction.
   */
  windowSnapshotMaxAgeLedgers?: number | undefined;
  /**
   * Where the inclusion fee comes from. `"fixed"` (the default) uses the SDK's
   * declared one-operation fee and needs no network call. `"rpc"` reads
   * `getFeeStats` once per **priced** check and quotes the selected percentile
   * (see `percentile`). A guard refusal or an unpriced run makes no fee-stats
   * call, because there is no quote to price.
   *
   * In `"rpc"` mode a failed or malformed fee-stats response falls back to the
   * fixed fee; the fallback is reported through `provenance.fallbackReason`, so
   * it is visible rather than silent.
   *
   * Default: `"fixed"`.
   */
  feeSource?: FeeSource | undefined;
  /**
   * Soroban inclusion-fee percentile quoted in `"rpc"` mode: `"p50"`,
   * `"p90"` or `"p99"`. Validated at construction even when `feeSource` is
   * `"fixed"`, so a typo fails immediately. Default: `"p50"`.
   */
  percentile?: FeePercentile | undefined;
  /**
   * RPC server used to simulate transactions in `checkTransaction()` and to
   * read fee stats in `"rpc"` mode. Supply this or `feeStats` for `"rpc"`
   * pricing; transaction checks can instead receive a simulation response.
   */
  server?: rpc.Server | undefined;
  /**
   * Injectable fee-stats provider for `"rpc"` mode. Wins over `server` when
   * both are supplied, and is the offline test seam for injecting fake stats.
   */
  feeStats?: FeeStatsProvider | undefined;
  /**
   * Opt-in headroom warning (issue #447). When the quoted total reaches this
   * fraction of the ceiling — `total / ceiling >= warnAtRatio` — the decision
   * carries a structured `headroomWarning`. Must be in `(0, 1]`; invalid values
   * throw `InvalidInputError` at construction.
   *
   * A warning never changes the decision `kind` and never turns an admissible
   * price into `over_budget`: the ceiling still decides. The boundary is
   * inclusive — a quote at exactly the ratio warns.
   *
   * Default: off (no warning).
   */
  warnAtRatio?: number | undefined;
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

/**
 * Ledger marker for the snapshot a simulation-based quote describes.
 *
 * **Informational, not an execution guarantee.** Two quotes with the same
 * provenance were priced against the same ledger state; a quote whose ledger is
 * older than the current chain may no longer reflect what submission will
 * charge. The SDK does not promise that a transaction will land in this ledger.
 */
export interface CostProvenance {
  /**
   * Ledger sequence the quote describes.
   *
   * Normally taken from the pricing simulation's own `latestLedger`, never from
   * a second RPC read that could race ahead of the state that was actually
   * priced. In `"rpc"` fee mode it falls back to the `getFeeStats` ledger when
   * the simulation did not expose one (`ledgerSource: "fee_stats"`), and is
   * `null` when neither source established a usable sequence.
   */
  ledger: number | null;
  /** Input path that produced this quote; absent on legacy provenance. */
  source?: "call" | "transaction" | undefined;
  /** Which observation supplied `ledger`; `"simulation"` when omitted. */
  ledgerSource?: "simulation" | "fee_stats" | undefined;
  /**
   * Present in `"rpc"` fee mode: whether the inclusion fee was quoted from fee
   * stats or fell back to the fixed fee.
   */
  feeSource?: FeeSource | undefined;
  /** The percentile requested in `"rpc"` mode. */
  percentile?: FeePercentile | undefined;
  /** Ledger the fee-stats response was observed at, when it reported one. */
  feeStatsLedger?: number | undefined;
  /**
   * Why the configured `"rpc"` fee source fell back to the fixed fee. An
   * explicit, non-empty reason means the quote is the fixed floor, not a fee
   * market observation.
   */
  fallbackReason?: string | undefined;
}

/** Transaction provenance records its input path even when no ledger was returned. */
export interface TransactionCostProvenance extends CostProvenance {
  source: "transaction";
}

export type CostDecisionProvenance = CostProvenance | TransactionCostProvenance;

export type CostDecision =
  | ({
      kind: "within_budget";
      allowed: true;
      /** Ledger keys the call is priced to touch, from the same simulation. */
      footprintKeys: number;
      /** The ceiling this was judged against, or `null` when none was given. */
      feeCeilingStroops: bigint | null;
      /**
       * Room left under the ceiling in stroops: `ceiling - total`, never
       * negative. `null` when no ceiling was configured — an absent ceiling is
       * not a zero surplus, just as it is not a zero ceiling (issue #446).
       */
      surplusStroops: bigint | null;
      /**
       * Opt-in structured warning that this quote reached `warnAtRatio` of the
       * ceiling (issue #447); `null` when warnings are off or the ratio was not
       * reached. A non-null warning is still `within_budget`.
       */
      headroomWarning: HeadroomWarning | null;
      /** Additive policy-relative context when a policy source is configured; null otherwise. */
      policyContext: PolicyContext | null;
      /** Ledger snapshot this quote describes, or `null` when it was unavailable. */
      provenance: CostDecisionProvenance | null;
    } & FeeBreakdown &
      CostResultBreakdown)
  | ({
      kind: "over_budget";
      /** Not allowed to proceed *at this price* — the guard itself may allow it. */
      allowed: false;
      footprintKeys: number;
      feeCeilingStroops: bigint;
      /**
       * Always `0n` here: the ceiling was exceeded, and a surplus is clamped at
       * zero rather than reported as a negative number. The breach itself is
       * reported by `kind: "over_budget"` (issue #446).
       */
      surplusStroops: 0n;
      /** A breach is not a warning: the failure is already the decision's kind. */
      headroomWarning: null;
      policyContext: PolicyContext | null;
      /** Ledger snapshot this quote describes, or `null` when it was unavailable. */
      provenance: CostDecisionProvenance | null;
    } & FeeBreakdown &
      CostResultBreakdown)
  | ({
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
      /** A refusal is not priced against a ceiling, so there is no surplus. */
      surplusStroops: null;
      /** Refusals are never headroom warnings. */
      headroomWarning: null;
      policyContext: PolicyContext | null;
      /** A refusal is not simulation-priced, so there is no ledger provenance. */
      provenance: CostDecisionProvenance | null;
    } & CostResultBreakdown)
  | ({
      kind: "undetermined";
      /** Enforcement could not reach a decision; treated as not-allowed. */
      allowed: false;
      detail: string;
      resourceFeeStroops: bigint;
      inclusionFeeStroops: bigint;
      totalFeeStroops: bigint;
      /** An unpriced run has no ceiling judgement and therefore no surplus. */
      surplusStroops: null;
      /** An unpriced run is never a headroom warning. */
      headroomWarning: null;
      policyContext: PolicyContext | null;
      /** No usable simulation means no ledger provenance. */
      provenance: CostDecisionProvenance | null;
    } & CostResultBreakdown);

/** Type alias matching documentation nomenclature. */
export type CostPreCheckResult = CostDecision;

/**
 * Per-call options for cost checking, including fee ceilings and opt-in policy context.
 */
export interface CostPreCheckOptions {
  /**
   * Opt-in policy source (contract address or PolicyConfig/GuardPolicy).
   * Default: the configured `CostPreCheckConfig.policySource` / `policy`.
   */
  policySource?: string | PolicyConfig | null | undefined;
  /**
   * Optional policy or contract address. Alias for `policySource`, which wins
   * when both are set. Default: as `policySource`.
   */
  policy?: string | PolicyConfig | null | undefined;
  /**
   * Override the fee ceiling in stroops for this check. Must be a non-negative
   * `bigint` or a base-10 integer string; invalid values throw
   * `InvalidInputError` before the interceptor is called. `0n` / `"0"` is a
   * real ceiling, distinct from omission.
   * Default: the configured `CostPreCheckConfig.maxFeeStroops`.
   */
  maxFeeStroops?: bigint | string | undefined;
  /**
   * Per-call override of the configured window-spend snapshot (issue #311).
   * An explicit `null` clears a configured snapshot for this check; omitting
   * the option falls back to `CostPreCheckConfig.windowSnapshot`. Invalid
   * values throw a `TypeError` before the interceptor is called.
   */
  windowSnapshot?: WindowSpendSnapshot | null | undefined;
  /**
   * Caller-owned cancellation for the underlying enforced simulation. An
   * already-aborted signal returns before any RPC call; a mid-flight abort or a
   * fired timeout yields a fail-closed `undetermined` verdict (and therefore an
   * `undetermined` cost decision) carrying the typed `RpcTimeoutError`.
   * Default: none.
   */
  signal?: AbortSignal | undefined;
  /**
   * Bound on the underlying RPC call, in milliseconds; `0` disables it. A fired
   * timeout is reported exactly like an abort — never as an admissible verdict.
   * Default: `DEFAULT_RPC_TIMEOUT_MS` (30 000 ms), applied by the interceptor.
   */
  timeoutMs?: number | undefined;
}

/** Per-transaction controls for `checkTransaction()`. */
export interface CostTransactionCheckOptions {
  /** A simulation response already produced for this exact transaction. */
  simulation?: rpc.Api.SimulateTransactionResponse | undefined;
  /** Override the configured ceiling for this quote. */
  maxFeeStroops?: bigint | string | undefined;
}

/**
 * One interceptor verdict and the cost of the exact simulation that produced it.
 *
 * `cost` is derived from `decision`, never from a second simulation, so the two
 * always describe the same ledger snapshot. See `checkWithCost`.
 */
export interface CostWithDecision {
  /** The verdict, exactly as `PreFlightInterceptor.check` returns it. */
  decision: PreFlightDecision;
  /** The cost view of that same verdict. */
  cost: CostDecision;
}

/**
 * Split a simulation's resource fee into the two components a caller is charged.
 *
 * Pure: no network, no configuration. By default the inclusion fee is the SDK's
 * own declared floor for a single-operation transaction (`INCLUSION_FEE` in
 * `tx.ts`), which is the same value the built envelope uses, so this cannot
 * drift from what is actually submitted. An explicit second argument overrides
 * it for `feeSource: "rpc"` quotes, where the caller asked for a fee-market
 * percentile instead of the floor.
 */
export function feeBreakdown(
  resourceFeeStroops: bigint,
  inclusionFeeStroops: bigint = BigInt(INCLUSION_FEE),
): FeeBreakdown {
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
  return totalFeeStroops > validateFeeCeiling(ceilingStroops);
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
        surplusStroops?: bigint | null | undefined;
        headroomWarning?: HeadroomWarning | null | undefined;
        reason?: string | undefined;
        cause?: string | undefined;
        policyContext?: PolicyContext | null | undefined;
      },
): string {
  const surplusText =
    decision.surplusStroops === null || decision.surplusStroops === undefined
      ? "surplus unknown"
      : `surplus ${decision.surplusStroops} stroops`;
  switch (decision.kind) {
    case "within_budget": {
      const ceiling =
        decision.feeCeilingStroops === null || decision.feeCeilingStroops === undefined
          ? "no ceiling"
          : `ceiling ${decision.feeCeilingStroops}`;
      const warning = decision.headroomWarning
        ? `, HEADROOM WARNING at ${decision.headroomWarning.usedRatio} of ceiling (threshold ${decision.headroomWarning.threshold})`
        : "";
      return `within budget: ${decision.totalFeeStroops} stroops (${decision.resourceFeeStroops ?? 0n} resource + ${decision.inclusionFeeStroops ?? 0n} inclusion), ${ceiling}, ${surplusText}${warning}`;
    }
    case "over_budget":
      return `over budget: ${decision.totalFeeStroops} stroops exceeds ceiling ${decision.feeCeilingStroops}, ${surplusText}`;
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
 * Validate a window-spend snapshot without ever accepting a guessable value.
 *
 * Every field is checked structurally: `ledger` must be a non-negative safe
 * integer, and the cap/spent pair must be non-negative `bigint`s. A `number`,
 * numeric string or `null` where a `bigint` belongs is rejected outright — by
 * the time a value reaches here any precision loss has already happened, and
 * coercing it would launder that loss into an operator-facing estimate.
 */
function validateWindowSnapshot(snapshot: WindowSpendSnapshot): WindowSpendSnapshot {
  if (typeof snapshot !== "object" || snapshot === null) {
    throw new TypeError(
      `windowSnapshot must be an object, received ${snapshot === null ? "null" : typeof snapshot}`,
    );
  }
  if (
    typeof snapshot.ledger !== "number" ||
    !Number.isSafeInteger(snapshot.ledger) ||
    snapshot.ledger < 0
  ) {
    throw new TypeError(
      `windowSnapshot.ledger must be a non-negative safe integer, received ${String(snapshot.ledger)}`,
    );
  }
  for (const key of ["windowCapStroops", "windowSpentStroops"] as const) {
    const value = snapshot[key];
    if (typeof value !== "bigint" || value < 0n) {
      throw new TypeError(
        `windowSnapshot.${key} must be a non-negative bigint, received ${String(value)}`,
      );
    }
  }
  return snapshot;
}

/** Validate the snapshot-age tolerance without allowing an unusable value. */
function validateSnapshotMaxAge(value: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(
      `windowSnapshotMaxAgeLedgers must be a non-negative safe integer, received ${String(value)}`,
    );
  }
  return value;
}

/**
 * Compute the remaining window budget from a ledger-tied snapshot, or `null`
 * when it cannot be computed (issue #311).
 *
 * The estimate is derived only from facts that are all known at once:
 *
 * 1. a priced (admissible) verdict — the only outcome that carries the ledger
 *    the policy check actually ran at;
 * 2. a snapshot observed at that same ledger (or within an explicitly
 *    configured tolerance) — a stale or future-dated snapshot describes
 *    different state and is treated as missing rather than adjusted for;
 * 3. this call's transfer amount — without it, "remaining after this call"
 *    is not defined.
 *
 * The result is `cap − spent − amount`, clamped at zero: a computed zero means
 * the window is exactly spent or overspent, which is different from `null`
 * ("unknown"). A result above `Number.MAX_SAFE_INTEGER` is reported as `null`
 * rather than rounded — an estimate that silently loses precision is worse than
 * an absent one.
 */
function estimateWindowRemaining(
  decision: PreFlightDecision,
  call: ContractCall,
  snapshot: WindowSpendSnapshot | null,
  maxAgeLedgers: number,
): number | null {
  if (snapshot === null) return null;
  if (decision.kind !== "admissible") return null;
  const checkLedger = decision.provenance?.ledger;
  if (checkLedger === undefined || checkLedger === null) return null;
  // The tie: the snapshot must describe the ledger context of this policy
  // check. A snapshot from the future is an upstream bookkeeping error; one
  // that is too old may predate spend this check accounted for.
  if (snapshot.ledger > checkLedger) return null;
  if (checkLedger - snapshot.ledger > maxAgeLedgers) return null;

  const amount = extractCallAmount(call);
  if (amount === null || amount < 0n) return null;

  const remaining = snapshot.windowCapStroops - snapshot.windowSpentStroops - amount;
  if (remaining <= 0n) return 0;
  if (remaining > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(remaining);
}

/**
 * Derive additive policy-relative context from the live check response.
 *
 * When no policy source is configured, returns null.
 * When a policy source is supplied:
 *  - perTxCapOk: true if admissible or window_cap_exceeded; false if per_tx_cap_exceeded;
 *    or evaluated against policy.per_tx_cap if a static policy is provided.
 *  - windowRemainingEstimate: computed from a ledger-tied window-spend
 *    snapshot when the snapshot, the check's ledger, and the transfer amount
 *    are all known (issue #311); null otherwise — including every blocked and
 *    undetermined outcome, which have no priced ledger to tie a snapshot to.
 *    NOTE: null means unknown/unavailable, NEVER zero budget, and the estimate
 *    is never consulted by any authorization decision.
 *  - reason: the policy block reason or null if permitted.
 */
function computePolicyContext(
  policySource: string | PolicyConfig | null | undefined,
  decision: PreFlightDecision,
  call: ContractCall,
  windowSnapshot: WindowSpendSnapshot | null,
  snapshotMaxAgeLedgers: number,
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
      windowRemainingEstimate: estimateWindowRemaining(
        decision,
        call,
        windowSnapshot,
        snapshotMaxAgeLedgers,
      ),
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
  private readonly logger: GuardLogger;
  private readonly maxFeeStroops: bigint | undefined;
  /** Validated configuration snapshot, or `null` when none was configured. */
  private readonly windowSnapshot: WindowSpendSnapshot | null;
  /** How far a snapshot may predate the check's ledger and still be used. */
  private readonly snapshotMaxAgeLedgers: number;
  private readonly feeSource: FeeSource;
  private readonly percentile: FeePercentile;
  private readonly feeStatsProvider: FeeStatsProvider | undefined;
  /** `null` when headroom warnings are off. */
  private readonly warnAtRatio: { ratio: number; numerator: bigint; scale: bigint } | null;

  constructor(config: CostPreCheckConfig) {
    this.config = config;
    // Validate at the configuration boundary: a typo must fail here, not turn
    // every later quote into a fabricated over-budget answer.
    this.maxFeeStroops =
      config.maxFeeStroops === undefined ? undefined : validateFeeCeiling(config.maxFeeStroops);
    this.windowSnapshot =
      config.windowSnapshot === undefined || config.windowSnapshot === null
        ? null
        : validateWindowSnapshot(config.windowSnapshot);
    this.snapshotMaxAgeLedgers =
      config.windowSnapshotMaxAgeLedgers === undefined
        ? 0
        : validateSnapshotMaxAge(config.windowSnapshotMaxAgeLedgers);

    // Fee pricing is validated at construction too: an unusable percentile or a
    // missing fee-stats source must fail here, not after a live simulation has
    // already been spent on a quote that could never be honest.
    this.feeSource = config.feeSource ?? "fixed";
    if (this.feeSource !== "fixed" && this.feeSource !== "rpc") {
      throw new InvalidInputError(
        "feeSource",
        "fixed_or_rpc",
        `expected "fixed" or "rpc", received ${String(this.feeSource)}`,
      );
    }
    this.percentile = config.percentile ?? "p50";
    if (!FEE_PERCENTILES.includes(this.percentile)) {
      throw new InvalidInputError(
        "percentile",
        "supported_percentile",
        `expected one of ${FEE_PERCENTILES.join(", ")}, received ${String(this.percentile)}`,
      );
    }
    const server = config.server;
    this.feeStatsProvider =
      config.feeStats ??
      (server === undefined
        ? undefined
        : () => server.getFeeStats() as unknown as Promise<FeeStatsResponse>);
    if (this.feeSource === "rpc" && this.feeStatsProvider === undefined) {
      throw new InvalidInputError(
        "feeSource",
        "rpc_requires_fee_stats_source",
        'feeSource "rpc" requires `server` or `feeStats` so fee stats can be read',
      );
    }
    this.warnAtRatio =
      config.warnAtRatio === undefined ? null : validateWarnAtRatio(config.warnAtRatio);
    this.logger = resolveLogger(config.logger);
  }

  /** Price a call. Equivalent to `(await this.checkWithCost(call, options)).cost`. */
  async check(call: ContractCall, options?: CostPreCheckOptions): Promise<CostDecision> {
    return (await this.checkWithCost(call, options)).cost;
  }

  /**
   * Price a call **and** return the interceptor's verdict, from one enforced
   * simulation.
   *
   * ## Why this exists — and why not to call `check()` twice
   *
   * The obvious consumer flow is `interceptor.check(call)` for the policy
   * verdict, then `costChecker.check(call)` for the price. Those are two
   * simulations of the same call, and the problem is not only the extra RPC: the
   * two simulations see two ledger snapshots, so the fee the caller is *told* can
   * differ from the fee implied by the verdict that was actually enforced. A
   * price that no longer corresponds to the approved decision is a correctness
   * bug in a security tool, not a performance one — so this method asks the
   * interceptor once and derives both results from that one verdict.
   *
   * Additive: `check()`, `precheckCost()` and `PreFlightInterceptor.check()` are
   * unchanged.
   */
  async checkWithCost(
    call: ContractCall,
    options?: CostPreCheckOptions,
  ): Promise<CostWithDecision> {
    // Resolve and validate the ceiling *before* the simulation: a bad budget
    // policy must never spend an RPC or be masked by a guard verdict. Only an
    // absent per-call ceiling falls back to configuration; 0n is preserved.
    const ceiling =
      options?.maxFeeStroops !== undefined
        ? validateFeeCeiling(options.maxFeeStroops)
        : (this.maxFeeStroops ?? null);
    // Same boundary for the window snapshot: an unusable snapshot is a
    // configuration error, checked before any RPC, and `null` explicitly
    // clears a configured snapshot for this one check.
    const windowSnapshot =
      options?.windowSnapshot !== undefined
        ? options.windowSnapshot === null
          ? null
          : validateWindowSnapshot(options.windowSnapshot)
        : this.windowSnapshot;

    const decision = await this.config.interceptor.check(call, {
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    });
    const policySource =
      options?.policySource ?? options?.policy ?? this.config.policySource ?? this.config.policy;
    const policyContext = computePolicyContext(
      policySource,
      decision,
      call,
      windowSnapshot,
      this.snapshotMaxAgeLedgers,
    );
    // An unpriced verdict has no quote to price, so it makes no fee-stats RPC.
    const pricing =
      decision.kind === "admissible"
        ? await this.resolveFeePricing()
        : {
            inclusionFeeStroops: BigInt(INCLUSION_FEE),
            feeSource: "fixed" as const,
            attemptedRpc: false,
          };
    const cost = this.costOf(decision, policyContext, ceiling, pricing);
    // The one place a cost decision is produced, so the one place it is logged:
    // `check()` and both one-shot helpers funnel through here, and a second log
    // site would mean a caller could see the same decision twice.
    if (cost.kind === "over_budget") {
      this.logger.warn(`call exceeds the fee ceiling: ${describeCostDecision(cost)}`, {
        totalFeeStroops: cost.totalFeeStroops.toString(),
        feeCeilingStroops: cost.feeCeilingStroops.toString(),
      });
    } else if (cost.kind === "within_budget" && cost.headroomWarning !== null) {
      this.logger.warn(`call is close to the fee ceiling: ${describeCostDecision(cost)}`, {
        totalFeeStroops: cost.totalFeeStroops.toString(),
        feeCeilingStroops: cost.feeCeilingStroops?.toString() ?? "none",
        surplusStroops: cost.surplusStroops?.toString() ?? "unknown",
      });
    } else if (cost.kind === "undetermined") {
      this.logger.warn(`call could not be priced: ${cost.detail}`);
    } else {
      this.logger.debug(describeCostDecision(cost));
    }
    return { decision, cost };
  }

  /**
   * Price the exact fee on a Stellar SDK transaction against its simulated
   * minimum resource fee. This does not run the guard interceptor or broadcast.
   */
  async checkTransaction(
    transaction: Transaction,
    options?: CostTransactionCheckOptions,
  ): Promise<CostDecision> {
    const ceiling =
      options?.maxFeeStroops !== undefined
        ? validateFeeCeiling(options.maxFeeStroops)
        : (this.maxFeeStroops ?? null);
    if (
      typeof transaction !== "object" ||
      transaction === null ||
      typeof transaction.networkPassphrase !== "string" ||
      typeof transaction.toXDR !== "function"
    ) {
      throw new InvalidInputError(
        "transaction",
        "stellar_transaction",
        "expected a Stellar SDK Transaction instance",
      );
    }
    const networkPassphrase = this.config.networkPassphrase;
    if (networkPassphrase === undefined) {
      throw new InvalidInputError(
        "networkPassphrase",
        "required",
        "set the transaction checker's network passphrase",
      );
    }
    if (transaction.networkPassphrase !== networkPassphrase) {
      throw new InvalidInputError(
        "transaction.networkPassphrase",
        "matches_checker_network",
        `transaction was built for ${JSON.stringify(transaction.networkPassphrase)}, not the checker's configured network`,
      );
    }
    const transactionFee = normalizeFeeStroops(transaction.fee, "transaction.fee", true);
    let simulation = options?.simulation;
    if (simulation === undefined) {
      if (this.config.server === undefined) {
        throw new InvalidInputError(
          "server",
          "required",
          "configure an RPC server or supply the transaction's simulation response",
        );
      }
      simulation = await this.config.server.simulateTransaction(transaction);
    }
    if (typeof simulation !== "object" || simulation === null) {
      throw new InvalidInputError(
        "simulation",
        "simulation_response",
        "expected a Stellar RPC simulation response",
      );
    }

    if ("error" in simulation) {
      return this.logTransactionCost(
        this.costOf(
          { allowed: false, kind: "undetermined", detail: "transaction simulation failed" },
          null,
          ceiling,
          { inclusionFeeStroops: 0n, feeSource: "fixed", attemptedRpc: false },
          "transaction",
        ),
      );
    }

    let resourceFee: bigint;
    try {
      resourceFee = parseSimulationResourceFee(simulation.minResourceFee, { stage: "cost" });
    } catch (error) {
      if (!(error instanceof ContractResponseError)) throw error;
      return this.logTransactionCost(
        this.costOf(
          {
            allowed: false,
            kind: "undetermined",
            detail: "transaction simulation returned an invalid resource fee",
          },
          null,
          ceiling,
          { inclusionFeeStroops: 0n, feeSource: "fixed", attemptedRpc: false },
          "transaction",
        ),
      );
    }

    const rawLedger: unknown = simulation.latestLedger;
    const ledger =
      typeof rawLedger === "number" && Number.isSafeInteger(rawLedger) && rawLedger >= 0
        ? rawLedger
        : null;
    const breakdown = resourceBreakdownFromSimulation(simulation);
    if (transactionFee < resourceFee) {
      return this.logTransactionCost(
        this.costOf(
          {
            allowed: false,
            kind: "undetermined",
            detail: "transaction fee is below the simulated minimum resource fee",
          },
          null,
          ceiling,
          { inclusionFeeStroops: 0n, feeSource: "fixed", attemptedRpc: false },
          "transaction",
        ),
      );
    }

    const decision: PreFlightDecision = {
      allowed: true,
      kind: "admissible",
      estimatedResourceFee: resourceFee,
      footprintKeys: breakdown?.storageEntries ?? 0,
      ...(breakdown ? { resourceBreakdown: breakdown } : {}),
    };
    const fees: FeeBreakdown = {
      resourceFeeStroops: resourceFee,
      inclusionFeeStroops: transactionFee - resourceFee,
      totalFeeStroops: transactionFee,
    };
    const cost = this.costOf(
      decision,
      null,
      ceiling,
      { inclusionFeeStroops: fees.inclusionFeeStroops, feeSource: "fixed", attemptedRpc: false },
      "transaction",
      ledger,
      fees,
    );
    return this.logTransactionCost(cost);
  }

  private logTransactionCost(cost: CostDecision): CostDecision {
    if (cost.kind === "over_budget") {
      this.logger.warn(`transaction exceeds the fee ceiling: ${describeCostDecision(cost)}`, {
        totalFeeStroops: cost.totalFeeStroops.toString(),
        feeCeilingStroops: cost.feeCeilingStroops.toString(),
      });
    } else if (cost.kind === "within_budget" && cost.headroomWarning !== null) {
      this.logger.warn(`transaction is close to the fee ceiling: ${describeCostDecision(cost)}`, {
        totalFeeStroops: cost.totalFeeStroops.toString(),
        feeCeilingStroops: cost.feeCeilingStroops?.toString() ?? "none",
        surplusStroops: cost.surplusStroops?.toString() ?? "unknown",
      });
    } else if (cost.kind === "undetermined") {
      this.logger.warn(`transaction could not be priced: ${cost.detail}`);
    } else {
      this.logger.debug(describeCostDecision(cost));
    }
    return cost;
  }

  /**
   * Resolve the inclusion fee for one priced check (issue #445).
   *
   * `"fixed"` is pure and offline. `"rpc"` reads fee stats exactly once and
   * quotes the configured Soroban percentile; any failure — transport, malformed
   * distribution, unusable value — falls back to the fixed fee with an explicit
   * `fallbackReason`, never a silent substitution and never an exception that
   * would turn a priced call into a crash.
   */
  private async resolveFeePricing(): Promise<ResolvedFeePricing> {
    const provider = this.feeStatsProvider;
    if (this.feeSource !== "rpc" || provider === undefined) {
      return {
        inclusionFeeStroops: BigInt(INCLUSION_FEE),
        feeSource: "fixed",
        attemptedRpc: false,
      };
    }
    const percentile = this.percentile;
    try {
      const stats = await provider();
      const raw = stats?.sorobanInclusionFee?.[percentile];
      let inclusionFeeStroops: bigint;
      if (typeof raw === "bigint" && raw >= 0n) inclusionFeeStroops = raw;
      else if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0)
        inclusionFeeStroops = BigInt(raw);
      else if (typeof raw === "string" && /^\d+$/.test(raw)) inclusionFeeStroops = BigInt(raw);
      else
        throw new Error(
          `sorobanInclusionFee.${percentile} is not a non-negative integer (${JSON.stringify(raw)})`,
        );

      const feeStatsLedger = feeStatsLedgerOf(stats.latestLedger);
      return {
        inclusionFeeStroops,
        feeSource: "rpc",
        percentile,
        attemptedRpc: true,
        ...(feeStatsLedger !== undefined ? { feeStatsLedger } : {}),
      };
    } catch (error) {
      return {
        inclusionFeeStroops: BigInt(INCLUSION_FEE),
        feeSource: "fixed",
        percentile,
        attemptedRpc: true,
        fallbackReason: `fee stats unavailable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Decide whether the quote reached `warnAtRatio` of its ceiling.
   *
   * The comparison is `total * scale >= ceiling * numerator` in `bigint`, so the
   * boundary at exactly the ratio is inclusive and never depends on binary
   * floating-point rounding. A zero ceiling cannot express a ratio and is always
   * `over_budget` for a non-zero quote anyway.
   */
  private headroomWarningFor(
    totalFeeStroops: bigint,
    ceilingStroops: bigint,
    surplusStroops: bigint,
  ): HeadroomWarning | null {
    const warnAtRatio = this.warnAtRatio;
    if (warnAtRatio === null || ceilingStroops <= 0n) return null;
    if (totalFeeStroops * warnAtRatio.scale < ceilingStroops * warnAtRatio.numerator) return null;
    return {
      kind: "headroom_warning",
      threshold: warnAtRatio.ratio,
      usedRatio: Number((totalFeeStroops * 10_000n) / ceilingStroops) / 10_000,
      totalFeeStroops,
      feeCeilingStroops: ceilingStroops,
      surplusStroops,
    };
  }

  /**
   * Assemble the decision's provenance from the verdict and the fee source.
   *
   * In `"rpc"` fee mode the source and the fee-stats ledger are recorded even
   * when the source fell back, so a fallback is never silent. Without `"rpc"`
   * mode the provenance is exactly the simulation's, unchanged from before this
   * option existed.
   */
  private provenanceFor(
    decision: PreFlightDecision,
    pricing: ResolvedFeePricing,
  ): CostProvenance | null {
    const simulated = decision.kind === "admissible" ? decision.provenance : undefined;
    if (!pricing.attemptedRpc) return simulated ?? null;
    const feeStatsLedger = pricing.feeStatsLedger;
    const ledger = simulated?.ledger ?? feeStatsLedger ?? null;
    return {
      ledger,
      feeSource: pricing.feeSource,
      ...(simulated === undefined && feeStatsLedger !== undefined
        ? { ledgerSource: "fee_stats" as const }
        : {}),
      ...(pricing.percentile !== undefined ? { percentile: pricing.percentile } : {}),
      ...(feeStatsLedger !== undefined ? { feeStatsLedger } : {}),
      ...(pricing.fallbackReason !== undefined ? { fallbackReason: pricing.fallbackReason } : {}),
    };
  }

  /** The pure cost view of an already-obtained verdict. No network, no state. */
  private costOf(
    decision: PreFlightDecision,
    policyContext: PolicyContext | null,
    ceiling: bigint | null,
    pricing: ResolvedFeePricing,
    source: "call" | "transaction" = "call",
    ledgerOverride?: number | null,
    feesOverride?: FeeBreakdown,
  ): CostDecision {
    // Provenance travels with the verdict from the same simulation, plus the fee
    // source in `"rpc"` mode. A block or an undetermined run has no priced
    // snapshot, so it is explicitly null rather than an invented ledger marker.
    const provenance =
      decision.kind === "admissible"
        ? source === "transaction"
          ? {
              ledger:
                ledgerOverride === undefined
                  ? (decision.provenance?.ledger ?? null)
                  : ledgerOverride,
              source,
            }
          : (() => {
              const callProvenance = this.provenanceFor(decision, pricing);
              return callProvenance ? { ...callProvenance, source } : null;
            })()
        : source === "transaction"
          ? { ledger: null, source }
          : null;
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
        surplusStroops: null,
        headroomWarning: null,
        policyContext,
        provenance,
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
        surplusStroops: null,
        headroomWarning: null,
        policyContext,
        provenance,
      };
    }

    const fees =
      feesOverride ?? feeBreakdown(decision.estimatedResourceFee, pricing.inclusionFeeStroops);
    if (exceedsCeiling(fees.totalFeeStroops, ceiling)) {
      return {
        kind: "over_budget",
        allowed: false,
        ...fees,
        footprintKeys: decision.footprintKeys,
        feeCeilingStroops: ceiling as bigint,
        surplusStroops: 0n,
        headroomWarning: null,
        policyContext,
        provenance,
        ...(decision.resourceBreakdown ? { breakdown: decision.resourceBreakdown } : {}),
      };
    }
    const surplusStroops = ceiling === null ? null : ceiling - fees.totalFeeStroops;
    return {
      kind: "within_budget",
      allowed: true,
      ...fees,
      footprintKeys: decision.footprintKeys,
      feeCeilingStroops: ceiling,
      surplusStroops,
      headroomWarning:
        surplusStroops === null
          ? null
          : this.headroomWarningFor(fees.totalFeeStroops, ceiling as bigint, surplusStroops),
      policyContext,
      provenance,
      ...(decision.resourceBreakdown ? { breakdown: decision.resourceBreakdown } : {}),
    };
  }
}

/** One-shot form, for callers that do not want to hold a pre-checker. */
export function precheckCost(
  config: CostPreCheckConfig,
  call: ContractCall,
  options?: CostPreCheckOptions,
): Promise<CostDecision> {
  return new CostPreChecker(config).check(call, options);
}

/**
 * One-shot form of `checkWithCost`: one simulation, both the verdict and the
 * price. Prefer this over a `preflight()` + `precheckCost()` pair.
 */
export function precheckCostWithDecision(
  config: CostPreCheckConfig,
  call: ContractCall,
  options?: CostPreCheckOptions,
): Promise<CostWithDecision> {
  return new CostPreChecker(config).checkWithCost(call, options);
}
