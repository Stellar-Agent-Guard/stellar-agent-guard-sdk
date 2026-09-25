/**
 * The pre-flight interceptor: ask the guard whether an action is permitted
 * *before* anything is signed for broadcast.
 *
 * This is the surface an agent framework integrates with. It answers one
 * question — "may this call proceed?" — and it answers it the same way the chain
 * would, because it runs the same enforcement: the guarded account's real
 * `__check_auth` against live ledger state, in a simulation that cannot mutate
 * anything. A refusal therefore costs nothing and cannot be bypassed by an agent
 * that ignores the answer, since the on-chain check still stands behind it.
 *
 * Three distinct answers, kept distinct on purpose:
 *
 *  - `admissible` — the guard approved. `estimatedResourceFee` is the network's
 *    own price for the call, taken from the same simulation.
 *  - `blocked` — the guard refused, with the contract's own reason. This is the
 *    guardrail working, and the reason is safe to show an operator.
 *  - `undetermined` — the enforcement run failed for a reason that is not a
 *    policy decision (a contract trap, a missing trustline, an unsupported
 *    credential type). **Treated as not-allowed**, because a guardrail must fail
 *    closed, but reported separately so an adapter never claims the guard
 *    refused something it never ruled on.
 *
 * A refused call never has a transaction hash. That is not a gap in the
 * evidence: the block happens before broadcast, which is what makes it free.
 */
import { Keypair, rpc } from "@stellar/stellar-sdk";
import { enforceCall } from "./invoke.ts";
import {
  extractTransferAmount,
  fetchGuardPolicyAndWindow,
  type PolicyConfig,
} from "./policy.ts";
import { GuardBlockedError, explainReason } from "./reasons.ts";
import type { ContractCall } from "./tx.ts";

/**
 * Thrown when enforcement could not reach a decision.
 *
 * Deliberately not a `GuardBlockedError`: reporting "the guard refused this"
 * when the guard never ruled would be a false claim about the security
 * boundary, which is the one thing an operator must be able to trust.
 */
export class PreFlightUndeterminedError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`stellar-agent-guard could not determine this action's status\n${detail}`);
    this.name = "PreFlightUndeterminedError";
    this.detail = detail;
  }
}

export type PreFlightDecision =
  | {
      allowed: true;
      kind: "admissible";
      /** The network's own resource fee estimate for this call, in stroops. */
      estimatedResourceFee: bigint;
      /** Number of ledger keys the call is priced to touch. */
      footprintKeys: number;
    }
  | {
      allowed: false;
      kind: "blocked";
      /** The contract's reason symbol, e.g. `per_tx_cap_exceeded`. */
      reason: string;
      /** One-line operator-facing meaning of `reason`. */
      explanation: string;
      detail: string;
      diagnosticEvents: unknown[];
    }
  | {
      allowed: false;
      kind: "undetermined";
      detail: string;
    };

export interface CheckBatchOptions {
  /**
   * Policy configuration to enforce against during batch staging.
   * If omitted, the interceptor attempts to fetch it from the guard's ledger storage.
   */
  policy?: PolicyConfig | null;

  /**
   * Initial committed amount already spent in the current rolling window.
   * If omitted, attempts to fetch it from the guard's `Window` ledger entry (defaults to 0n).
   */
  initialWindowSpent?: bigint;
}

export interface PreFlightBatchDecision {
  /**
   * Overall batch verdict: true only if every call in the batch is admissible.
   * Mirrors the contract's all-or-nothing auth batch semantics.
   */
  admissible: boolean;

  /**
   * Alias for `admissible`.
   */
  overallAdmissible: boolean;

  /**
   * Per-call decisions in the exact order of the input batch.
   */
  verdicts: PreFlightDecision[];

  /**
   * Alias for `verdicts`.
   */
  calls: PreFlightDecision[];

  /**
   * Total estimated resource fee in stroops across all calls in the batch
   * that were admissible.
   */
  totalEstimatedResourceFee: bigint;
}

export interface PreFlightConfig {
  server: rpc.Server;
  networkPassphrase: string;
  /** The guarded smart account whose policy is being enforced. */
  guard: string;
  /** The key registered as the account's agent, used to sign the auth entry. */
  agent: Keypair;
  /** Classic account that pays fees and supplies the sequence number. */
  source: Keypair;
  /** Authorizers for non-guard requirements (e.g. an admin on a policy call). */
  accountSigners?: Keypair[];
  /** Optional policy to use for batch staging (otherwise fetched from ledger). */
  policy?: PolicyConfig | null;
}

export class PreFlightInterceptor {
  private readonly config: PreFlightConfig;

  constructor(config: PreFlightConfig) {
    this.config = config;
  }

  /**
   * Decide whether `call` may proceed. Never broadcasts, never mutates, never
   * throws for a refusal — a block is a normal, expected result.
   */
  async check(call: ContractCall): Promise<PreFlightDecision> {
    const outcome = await enforceCall({
      server: this.config.server,
      source: this.config.source,
      call,
      networkPassphrase: this.config.networkPassphrase,
      guardAuth: { guard: this.config.guard, agent: this.config.agent },
      ...(this.config.accountSigners ? { accountSigners: this.config.accountSigners } : {}),
    });

    if (outcome.kind === "error") {
      return { allowed: false, kind: "undetermined", detail: outcome.detail };
    }
    if (outcome.kind === "blocked") {
      return {
        allowed: false,
        kind: "blocked",
        reason: outcome.reason,
        explanation: explainReason(outcome.reason),
        detail: outcome.detail,
        diagnosticEvents: outcome.diagnosticEvents,
      };
    }

    const data = outcome.simulation.transactionData as unknown as
      | { getReadOnly?: () => unknown[]; getReadWrite?: () => unknown[] }
      | undefined;
    const footprintKeys =
      (data?.getReadOnly?.().length ?? 0) + (data?.getReadWrite?.().length ?? 0);

    return {
      allowed: true,
      kind: "admissible",
      estimatedResourceFee: BigInt(outcome.simulation.minResourceFee ?? 0),
      footprintKeys,
    };
  }

  /**
   * Decide whether an entire batch of calls may proceed with all-or-nothing semantics.
   *
   * Mirrors the contract's staged window evaluation:
   * 1. Evaluates each call in sequence.
   * 2. For SAC transfers, tracks the cumulative admitted amounts in memory ("simulated staging").
   * 3. If an individual call passes simulation in isolation but would push the cumulative
   *    staged window spend past `window_cap`, it is marked as `blocked` with reason
   *    `window_cap_exceeded`.
   * 4. If any call is blocked or undetermined, the overall batch `admissible` is false.
   *
   * Documented approximation vs true batch simulation:
   * This sequential simulation with staged window accounting is an off-chain approximation
   * of the contract's atomic auth batch evaluation:
   * - State mutations between calls (other than guard window spend) are not observed during
   *   independent simulations.
   * - Window entries are staged against the initial window snapshot without modelling intra-batch
   *   time expiration.
   * - Total estimated resource fee is the sum of per-call estimates rather than a single
   *   transaction envelope's resource fee.
   *
   * Note cross-dependency:
   * When contract-side `check_batch` lands in `stellar-agent-guard-contracts`, `checkBatch`
   * will route to that entrypoint for atomic on-chain simulation, and this sequential
   * staging implementation will serve as the fallback for contracts on earlier ABI versions.
   */
  async checkBatch(
    calls: ContractCall[],
    options?: CheckBatchOptions,
  ): Promise<PreFlightBatchDecision> {
    if (calls.length === 0) {
      return {
        admissible: true,
        overallAdmissible: true,
        verdicts: [],
        calls: [],
        totalEstimatedResourceFee: 0n,
      };
    }

    // Resolve policy and initial window spend for staging
    let policy: PolicyConfig | null = options?.policy ?? this.config.policy ?? null;
    let initialWindowSpent: bigint = options?.initialWindowSpent ?? 0n;

    if (policy === null || options?.initialWindowSpent === undefined) {
      try {
        const fetched = await fetchGuardPolicyAndWindow(this.config.server, this.config.guard);
        if (policy === null) {
          policy = fetched.policy;
        }
        if (options?.initialWindowSpent === undefined) {
          initialWindowSpent = fetched.windowSpent;
        }
      } catch {
        // Fall back gracefully if ledger entry fetch is not possible (e.g. mock server in unit tests)
      }
    }

    let stagedWindowSpent = 0n;
    let allAdmissible = true;
    let totalEstimatedResourceFee = 0n;
    const verdicts: PreFlightDecision[] = [];

    for (const call of calls) {
      const decision = await this.check(call);

      if (decision.kind === "admissible") {
        const amount = extractTransferAmount(call);
        const windowCap = policy?.window_cap ?? 0n;

        // If this is a transfer with a positive amount and a window cap is defined:
        if (amount !== null && amount > 0n && windowCap > 0n) {
          const projectedSpend = initialWindowSpent + stagedWindowSpent + amount;
          if (projectedSpend > windowCap) {
            const blockedDecision: PreFlightDecision = {
              allowed: false,
              kind: "blocked",
              reason: "window_cap_exceeded",
              explanation: explainReason("window_cap_exceeded"),
              detail: `staged window cap exceeded: cumulative spend ${projectedSpend} > window_cap ${windowCap}`,
              diagnosticEvents: [],
            };
            verdicts.push(blockedDecision);
            allAdmissible = false;
            continue;
          }
          stagedWindowSpent += amount;
        }

        verdicts.push(decision);
        totalEstimatedResourceFee += decision.estimatedResourceFee;
      } else {
        verdicts.push(decision);
        allAdmissible = false;
      }
    }

    return {
      admissible: allAdmissible,
      overallAdmissible: allAdmissible,
      verdicts,
      calls: verdicts,
      totalEstimatedResourceFee,
    };
  }

  /**
   * Convenience for adapters that want a throw-on-refusal shape.
   *
   * Throws `GuardBlockedError` for both `blocked` and `undetermined` — an
   * interceptor that returned happily on `undetermined` would hand an agent a
   * green light the chain never gave.
   */
  async assertAllowed(call: ContractCall): Promise<PreFlightDecision & { allowed: true }> {
    const decision = await this.check(call);
    if (decision.allowed) return decision;
    if (decision.kind === "blocked") {
      throw new GuardBlockedError({
        reason: decision.reason,
        stage: "preflight",
        detail: decision.detail,
      });
    }
    throw new PreFlightUndeterminedError(decision.detail);
  }

  /**
   * Convenience for adapters that want a throw-on-refusal shape for batches.
   *
   * Throws `GuardBlockedError` if any call in the batch is blocked, or
   * `PreFlightUndeterminedError` if any call is undetermined.
   */
  async assertBatchAllowed(
    calls: ContractCall[],
    options?: CheckBatchOptions,
  ): Promise<PreFlightBatchDecision & { admissible: true }> {
    const decision = await this.checkBatch(calls, options);
    if (decision.admissible) return decision as PreFlightBatchDecision & { admissible: true };
    for (const verdict of decision.verdicts) {
      if (verdict.kind === "blocked") {
        throw new GuardBlockedError({
          reason: verdict.reason,
          stage: "preflight",
          detail: verdict.detail,
        });
      }
      if (verdict.kind === "undetermined") {
        throw new PreFlightUndeterminedError(verdict.detail);
      }
    }
    throw new PreFlightUndeterminedError("batch refused by guardrails");
  }
}

/** One-shot form, for callers that do not want to hold an interceptor. */
export function preflight(config: PreFlightConfig, call: ContractCall): Promise<PreFlightDecision> {
  return new PreFlightInterceptor(config).check(call);
}

/** One-shot form for batch pre-flight checks. */
export function preflightBatch(
  config: PreFlightConfig,
  calls: ContractCall[],
  options?: CheckBatchOptions,
): Promise<PreFlightBatchDecision> {
  return new PreFlightInterceptor(config).checkBatch(calls, options);
}

