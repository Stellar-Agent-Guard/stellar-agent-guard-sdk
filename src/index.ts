/**
 * stellar-agent-guard-sdk — the public surface.
 *
 * An integration bridge between AI agent frameworks and `stellar-agent-guard`
 * smart accounts: pre-flight policy interception, agent-auth transaction
 * signing, and on-chain event telemetry.
 *
 * **Enforcement scope, stated where the capability is claimed:** full
 * recipient/amount enforcement — spend caps, allowlists, per-transaction limits
 * — is native and automatic for SAC token transfers (`transfer`/`transfer_from`),
 * since these are the calls whose arguments the Soroban auth context exposes for
 * inspection. For other Soroban contract calls made by the guarded account
 * (arbitrary DEX/lending/protocol calls), the policy engine still enforces window
 * and pause state, but per-call amount/recipient limits are not yet enforced —
 * extending fine-grained enforcement to arbitrary calls is tracked as a v2 item,
 * not implied as already covered.
 *
 * This sentence is copied verbatim from the contracts repo's
 * `docs/enforcement-scope.md` ("The confirmed scope"), not paraphrased: the
 * boundary is a property of the platform, and stating it in one shared wording
 * is what keeps the two repos from drifting apart on it.
 */
export {
  BroadcastError,
  ContractResponseError,
  GuardError,
  PolicyDecodeError,
  SigningError,
  SimulationError,
} from "./errors.ts";

export {
  GuardBlockedError,
  ACCOUNT_STATE_REASONS,
  GUARD_REASON_CODES,
  GUARD_REASONS,
  explainReason,
  isGuardReason,
  reasonName,
  reasonNameFromCode,
  type GuardBlockedErrorParams,
  type GuardReason,
  type GuardReasonName,
} from "./reasons.ts";

export {
  decodeCheckResult,
  decodePolicy,
  deadManRemaining,
  describePolicy,
  extractTransferAmount,
  fetchGuardPolicyAndWindow,
  isDeadManFrozen,
  POLICY_RULE_IDS,
  policyFromScVal,
  policyToScVal,
  readPersistentEntry,
  validateGuardPolicy,
  type CheckResult,
  type GuardStatus,
  type PolicyConfig,
  type PolicyFailure,
  type PolicyRuleId,
  type ProtocolRule,
  type RecipientWindowCap,
  type ValidatePolicyOptions,
} from "./policy.ts";

export {
  decodeAuthDecision,
  GUARD_AUTH_RESULTS,
  GUARD_EVENT_TOPICS,
  type GuardAuthDecision,
  type GuardAuthResult,
} from "./events.ts";

export {
  DEFAULT_INVOKE_RETRY_OPTIONS,
  enforceCall,
  INVOKE_ERROR_CAUSES,
  InvokeRetryError,
  invoke,
  topicSymbols,
  type EnforcementOutcome,
  type GuardAuthorization,
  type InvokeDryRunResult,
  type InvokeDryRunStepName,
  type InvokeDryRunVerdict,
  type InvokeErrorCause,
  type InvokeErrorOutcome,
  type InvokeOptions,
  type InvokeOutcome,
  type InvokePipelineStep,
  type InvokeParams,
  type InvokeStepEvent,
  type RetryableInvokeFailure,
} from "./invoke.ts";

export {
  TRACE_STEP_NAMES,
  type TraceStepName,
  type TraceStepStatus,
} from "./trace.ts";

export {
  InvalidInputError,
  PreFlightInterceptor,
  PreFlightUndeterminedError,
  preflight,
  preflightBatch,
  validateContractCall,
  type CheckBatchOptions,
  type PolicyRevision,
  type PreFlightBatchDecision,
  type PreFlightCacheOptions,
  type PreFlightCheckOptions,
  type PreFlightConfig,
  type PreFlightDecision,
  type PreFlightInterceptorOptions,
} from "./preflight.ts";

export {
  CostPreChecker,
  STROOPS_PER_XLM,
  describeCostDecision,
  exceedsCeiling,
  feeBreakdown,
  formatFee,
  precheckCost,
  precheckCostWithDecision,
  resourceBreakdownFromSimulation,
  type CostDecision,
  type CostPreCheckConfig,
  type CostWithDecision,
  type FeeBreakdown,
  type ResourceBreakdown,
} from "./cost.ts";

export {
  DEFAULT_JITTER_FRACTION,
  GuardEventRingBuffer,
  GuardTelemetryListener,
  computePollDelay,
  describeGuardEvent,
  diagnosticsToEvents,
  guardEventId,
  guardEventsFromDiagnostics,
  isAllowedDecision,
  mergeGuardEventStreams,
  telemetryFromDecision,
  type GuardDiagnosticBatch,
  type GuardEvent,
  type GuardEventBufferOptions,
  type GuardEventContext,
  type GuardEventIdentityInput,
  type GuardEventKind,
  type GuardEventStream,
  type GuardTelemetryConfig,
  type GuardTelemetryGap,
  type GuardTelemetryGapReason,
  type GuardTelemetryUnifiedParams,
  type GuardTelemetryWatchParams,
  type PollResult,
  type PollSleep,
  type RecentEventFilter,
  type TelemetryJitter,
} from "./telemetry.ts";

export {
  GUARD_STORAGE_KEYS,
  INCLUSION_FEE,
  SIG_EXPIRATION_LEDGERS,
  assembleFromSimulation,
  buildGuardAuthEntry,
  buildInitialEnvelope,
  describeSimulationResources,
  describeSubmissionFailure,
  describeTransactionResult,
  isSequenceNumberFailure,
  isStaleLedgerResourceFailure,
  keypairAgentSigner,
  toAgentSigner,
  verifyAgentSignature,
  type AdminSigner,
  type AgentSigner,
  type ContractCall,
  type GuardCredentialType,
  type SimulationOutcome,
  type SubmissionResult,
} from "./tx.ts";

export {
  DEFAULT_NETWORK_PASSPHRASE,
  agentPubkeyToScVal,
  buildFreezeCall,
  buildRotateAgentKeyCall,
  buildSetPolicyCall,
  buildUnfreezeCall,
  submitFreeze,
  submitRotateAgentKey,
  submitSetPolicy,
  submitUnfreeze,
  type AdminOpParams,
  type RotateAgentKeyParams,
  type SetPolicyParams,
} from "./admin.ts";

export {
  GUARD_WASM_HASH,
  sha256Hex,
  toHex,
  verifyGuardWasm,
  type GuardWasmVerification,
} from "./wasm.ts";

// Framework adapters. Both are written structurally against their host's hook,
// so neither framework is a dependency of this package.
export {
  createLangChainGuardMiddleware,
  type LangChainGuardOptions,
  type LangChainToolCallRequest,
  type LangChainToolMessage,
} from "./adapters/langchain.ts";

export {
  createGuardValidator,
  guardAction,
  type ElizaActionLike,
  type ElizaGuardOptions,
  type ElizaValidator,
} from "./adapters/elizaos.ts";
