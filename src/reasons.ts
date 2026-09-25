/**
 * The guard contract's block reasons.
 *
 * These mirror `Error`/`BlockReason` in
 * `stellar-agent-guard-contracts/src/types.rs` exactly — both the numeric
 * enum value (as returned in a `CheckResult::Blocked(Symbol)` payload from
 * `check`) and the stable snake_case symbol the contract publishes as an event
 * topic (`auth_checked` → `blocked, <reason>`). Off-chain code and on-chain
 * code therefore share one vocabulary, which is why this table is duplicated
 * rather than inferred.
 */
import { GuardError } from "./errors.ts";

export const GUARD_REASON_CODES = {
  unauthorized: 1,
  already_initialized: 2,
  not_initialized: 3,
  invalid_config: 4,
  invalid_amount: 5,
  admin_frozen: 10,
  heartbeat_expired: 11,
  no_policy: 12,
  paused: 13,
  outside_active_window: 14,
  asset_not_allowed: 20,
  recipient_not_allowed: 21,
  per_tx_cap_exceeded: 22,
  window_cap_exceeded: 23,
  protocol_not_allowed: 24,
  function_not_allowed: 25,
  unknown_contract: 26,
  self_function_not_allowed: 27,
  create_contract_not_allowed: 28,
} as const;

export type GuardReasonName = keyof typeof GUARD_REASON_CODES;

const BY_CODE = new Map<number, GuardReasonName>(
  Object.entries(GUARD_REASON_CODES).map(([name, code]) => [code, name as GuardReasonName]),
);

/** Human-readable, one-line meaning per reason, for surfacing to operators. */
const EXPLANATIONS: Record<GuardReasonName, string> = {
  unauthorized: "The presented signature did not verify against the account's registered agent key.",
  already_initialized: "The guard account has already been initialized.",
  not_initialized: "The guard account has no registered agent key yet.",
  invalid_config: "The policy configuration was rejected by validation and was not applied.",
  invalid_amount: "The transfer amount was zero or negative.",
  admin_frozen: "An admin froze the account (freeze), or the dead-man switch grace window lapsed.",
  heartbeat_expired: "The dead-man switch fired: no heartbeat within the policy's grace window, so the account is frozen until an admin unfreezes it.",
  no_policy: "No policy is installed (never set, or revoked) — the account is default-deny.",
  paused: "The policy's admin kill switch is engaged.",
  outside_active_window: "The current ledger time is outside the policy's active_from/active_until window.",
  asset_not_allowed: "The SAC token being called is not in the policy's assets list.",
  recipient_not_allowed: "The transfer recipient is not in the policy's recipients allowlist.",
  per_tx_cap_exceeded: "The transfer amount exceeds the policy's per-transaction cap.",
  window_cap_exceeded: "The transfer would push cumulative spend over the rolling-window cap.",
  protocol_not_allowed: "The contract being called is not in the policy's protocols allowlist.",
  function_not_allowed: "The function being called on an allowlisted contract is not in its function allowlist.",
  unknown_contract: "The contract being called is neither the account itself, an allowlisted asset, nor an allowlisted protocol (default deny).",
  self_function_not_allowed: "The call targets a guard function that the agent key may not invoke.",
  create_contract_not_allowed: "The account may not authorize contract creation.",
};

export function reasonNameFromCode(code: number): GuardReasonName | undefined {
  return BY_CODE.get(code);
}

/** Accepts either the numeric enum value or its snake_case name. */
export function reasonName(reason: number | string): GuardReasonName | string {
  if (typeof reason === "number") return BY_CODE.get(reason) ?? `unknown_reason_${reason}`;
  return reason;
}

export function explainReason(reason: number | string): string {
  const name = reasonName(reason);
  return EXPLANATIONS[name as GuardReasonName] ?? `Unrecognised guard reason: ${String(reason)}`;
}

/**
 * Thrown by the SDK whenever the guard blocks an action. `charged` is false for
 * pre-broadcast interceptions — the whole point of the pre-flight path is that
 * a blocked action costs nothing, because no transaction was submitted.
 */
export class GuardBlockedError extends GuardError {
  readonly reason: string;
  readonly code: number | undefined;
  readonly explanation: string;
  readonly stage: "preflight" | "submission";
  readonly charged: boolean;

  constructor(params: {
    reason: number | string;
    stage: "preflight" | "submission";
    detail?: string;
    charged?: boolean;
  }) {
    const name = reasonName(params.reason);
    const explanation = explainReason(params.reason);
    super(
      `stellar-agent-guard blocked this action (${name}): ${explanation}` +
        (params.detail ? `\n${params.detail}` : ""),
    );
    this.name = "GuardBlockedError";
    this.reason = name;
    this.code = typeof params.reason === "number" ? params.reason : GUARD_REASON_CODES[name as GuardReasonName];
    this.explanation = explanation;
    this.stage = params.stage;
    this.charged = params.charged ?? false;
  }
}

/** Reasons that mean "the guard itself is not ready", as opposed to "this call violated policy". */
export const ACCOUNT_STATE_REASONS: readonly string[] = [
  "admin_frozen",
  "heartbeat_expired",
  "no_policy",
  "paused",
  "outside_active_window",
  "not_initialized",
];
