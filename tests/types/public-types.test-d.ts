/**
 * Type-level regression suite for exported public types (issue #80).
 *
 * Asserts compile-time type invariants across the public API surface:
 *  1. PreFlightDecision discriminant narrowing (kind === "admissible" | "blocked" | "undetermined")
 *  2. Error inheritance and instanceof hierarchy (GuardError, SimulationError, InvalidInputError, etc.)
 *  3. Documented option interfaces accept expected keys and reject invalid types
 *  4. Branded type safety (ContractAddress, AccountAddress, StrKeyAddress)
 *  5. Readonly immutability guarantees (ReadonlyPolicyConfig)
 *  6. Negative compile cases with @ts-expect-error
 */
import { expectTypeOf } from "expect-type";
import type { rpc } from "@stellar/stellar-sdk";
import {
  AdapterConfigError,
  AdapterMappingError,
  BroadcastError,
  ContractResponseError,
  GuardBlockedError,
  GuardError,
  GuardUndeterminedError,
  HeartbeatBlockedError,
  HeartbeatDryRunError,
  HeartbeatIntervalError,
  InvalidFeeCeilingError,
  InvalidInputError,
  InvokeRetryError,
  PolicyDecodeError,
  PolicyEncodeError,
  PolicyFileReadError,
  PolicyValidationError,
  PreFlightUndeterminedError,
  RpcTimeoutError,
  SigningError,
  SimulationError,
  type AccountAddress,
  type AgentSigner,
  type CheckBatchOptions,
  type Clock,
  type ContractAddress,
  type ContractCall,
  type DeepReadonly,
  type DescribePolicyOptions,
  type ElizaGuardOptions,
  type InvokeDryRunVerdict,
  type InvokeOptions,
  type InvokeOutcome,
  type LangChainGuardOptions,
  type McpGuardOptions,
  type PolicyConfig,
  type PreFlightBatchDecision,
  type PreFlightCheckOptions,
  type PreFlightDecision,
  type PreFlightInterceptor,
  type PreFlightInterceptorOptions,
  type PublicKeyHex,
  type ReadonlyPolicyConfig,
  type StrKeyAddress,
  type SubmissionResult,
  type ValidatePolicyOptions,
  type VercelAIGuardOptions,
  type VercelAIToolCallInput,
} from "../../src/index.ts";

// ---------------------------------------------------------------------------
// 1. PreFlightDecision Discriminant Narrowing (verdict narrowing ×3)
// ---------------------------------------------------------------------------
declare const decision: PreFlightDecision;

// 1a. Narrowing on kind === "admissible"
if (decision.kind === "admissible") {
  expectTypeOf(decision.allowed).toEqualTypeOf<true>();
  expectTypeOf(decision.estimatedResourceFee).toEqualTypeOf<bigint>();
  expectTypeOf(decision.footprintKeys).toEqualTypeOf<number>();

  // Negative case: admissible verdict lacks "reason" and "explanation"
  // @ts-expect-error admissible variant lacks reason property
  void decision.reason;
  // @ts-expect-error admissible variant lacks explanation property
  void decision.explanation;
}

// 1b. Narrowing on kind === "blocked"
if (decision.kind === "blocked") {
  expectTypeOf(decision.allowed).toEqualTypeOf<false>();
  expectTypeOf(decision.reason).toEqualTypeOf<string>();
  expectTypeOf(decision.explanation).toEqualTypeOf<string>();
  expectTypeOf(decision.detail).toEqualTypeOf<string>();
  expectTypeOf(decision.diagnosticEvents).toEqualTypeOf<unknown[]>();

  // Negative case: blocked variant lacks fee quotes
  // @ts-expect-error blocked variant lacks estimatedResourceFee property
  void decision.estimatedResourceFee;
  // @ts-expect-error blocked variant lacks footprintKeys property
  void decision.footprintKeys;
}

// 1c. Narrowing on kind === "undetermined"
if (decision.kind === "undetermined") {
  expectTypeOf(decision.allowed).toEqualTypeOf<false>();
  expectTypeOf(decision.detail).toEqualTypeOf<string>();
  expectTypeOf(decision.error).toEqualTypeOf<GuardError | undefined>();

  // Negative case: undetermined variant lacks "reason" and "estimatedResourceFee"
  // @ts-expect-error undetermined variant lacks reason property
  void decision.reason;
  // @ts-expect-error undetermined variant lacks estimatedResourceFee property
  void decision.estimatedResourceFee;
}

// 1d. Narrowing on boolean discriminant allowed === true
if (decision.allowed) {
  expectTypeOf(decision.kind).toEqualTypeOf<"admissible">();
  expectTypeOf(decision.estimatedResourceFee).toEqualTypeOf<bigint>();
} else {
  expectTypeOf(decision.kind).toEqualTypeOf<"blocked" | "undetermined">();
}

// ---------------------------------------------------------------------------
// 2. InvokeOutcome Discriminant Narrowing
// ---------------------------------------------------------------------------
declare const outcome: InvokeOutcome;

if (outcome.kind === "allowed") {
  expectTypeOf(outcome.submission).toEqualTypeOf<SubmissionResult>();
} else if (outcome.kind === "blocked") {
  expectTypeOf(outcome.reason).toEqualTypeOf<string | null>();
  expectTypeOf(outcome.detail).toEqualTypeOf<string>();
} else if (outcome.kind === "dry_run") {
  expectTypeOf(outcome.verdict).toEqualTypeOf<InvokeDryRunVerdict>();
} else if (outcome.kind === "error") {
  expectTypeOf(outcome.error).toExtend<GuardError>();
}

// ---------------------------------------------------------------------------
// 3. Error Inheritance and Hierarchy
// ---------------------------------------------------------------------------
// GuardUndeterminedError (and PreFlightUndeterminedError alias) extends GuardError extends Error
expectTypeOf<GuardUndeterminedError>().toExtend<GuardError>();
expectTypeOf<GuardUndeterminedError>().toExtend<Error>();
expectTypeOf<PreFlightUndeterminedError>().toExtend<GuardError>();
expectTypeOf<PreFlightUndeterminedError>().toExtend<Error>();

// GuardBlockedError extends GuardError
expectTypeOf<GuardBlockedError>().toExtend<GuardError>();
expectTypeOf<GuardBlockedError>().toExtend<Error>();

// SimulationError extends GuardError
expectTypeOf<SimulationError>().toExtend<GuardError>();

// Transport, protocol, and policy errors extend GuardError
expectTypeOf<SigningError>().toExtend<GuardError>();
expectTypeOf<BroadcastError>().toExtend<GuardError>();
expectTypeOf<ContractResponseError>().toExtend<GuardError>();
expectTypeOf<PolicyValidationError>().toExtend<GuardError>();
expectTypeOf<PolicyDecodeError>().toExtend<GuardError>();
expectTypeOf<PolicyEncodeError>().toExtend<GuardError>();
expectTypeOf<PolicyFileReadError>().toExtend<GuardError>();
expectTypeOf<AdapterConfigError>().toExtend<GuardError>();
expectTypeOf<AdapterMappingError>().toExtend<GuardError>();
expectTypeOf<RpcTimeoutError>().toExtend<GuardError>();
expectTypeOf<InvokeRetryError>().toExtend<GuardError>();
expectTypeOf<HeartbeatBlockedError>().toExtend<GuardError>();
expectTypeOf<HeartbeatDryRunError>().toExtend<GuardError>();
expectTypeOf<HeartbeatIntervalError>().toExtend<GuardError>();

// InvalidInputError hierarchy: extends TypeError, but GuardError does not have input validation fields
expectTypeOf<InvalidInputError>().toExtend<TypeError>();
expectTypeOf<InvalidInputError>().toExtend<Error>();
expectTypeOf<GuardError>().not.toExtend<InvalidInputError>();

// InvalidFeeCeilingError extends InvalidInputError
expectTypeOf<InvalidFeeCeilingError>().toExtend<InvalidInputError>();
expectTypeOf<InvalidFeeCeilingError>().toExtend<TypeError>();

// ---------------------------------------------------------------------------
// 4. Options Interfaces Accept Documented Keys
// ---------------------------------------------------------------------------
declare const interceptor: PreFlightInterceptor;
declare const call: ContractCall;
declare const rpcServer: rpc.Server;
declare const agentSigner: AgentSigner;
declare const contractAddr: ContractAddress;
declare const testClock: Clock;

// PreFlightInterceptorOptions
const _validInterceptorOpts: PreFlightInterceptorOptions = {
  server: rpcServer,
  networkPassphrase: "Test SDF Network ; September 2015",
  guard: contractAddr,
  agent: agentSigner,
  source: {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
  cache: { ttlMs: 5000, maxEntries: 50 },
  coalesceInFlight: true,
  clock: testClock,
};
expectTypeOf(_validInterceptorOpts).toMatchTypeOf<PreFlightInterceptorOptions>();

// PreFlightCheckOptions
const _validCheckOpts: PreFlightCheckOptions = {
  signal: new AbortController().signal,
  timeoutMs: 3000,
  onStep: (_step) => {},
};
expectTypeOf(_validCheckOpts).toMatchTypeOf<PreFlightCheckOptions>();

// CheckBatchOptions
const _validBatchOpts: CheckBatchOptions = {
  initialWindowSpent: 0n,
  signal: new AbortController().signal,
  onStep: (_step) => {},
};
expectTypeOf(_validBatchOpts).toMatchTypeOf<CheckBatchOptions>();

// InvokeOptions
const _validInvokeOpts: InvokeOptions = {
  server: rpcServer,
  networkPassphrase: "Test SDF Network ; September 2015",
  call,
  source: {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
  dryRun: false,
  signal: new AbortController().signal,
  timeoutMs: 5000,
  fee: 100n,
  maxRetries: 3,
};
expectTypeOf(_validInvokeOpts).toMatchTypeOf<InvokeOptions>();

// Adapter options: LangChainGuardOptions
const _validLangChainOpts: LangChainGuardOptions = {
  interceptor,
  toContractCalls: (_req) => [call],
  onBlocked: (_info) => {},
  timeoutMs: 3000,
};
expectTypeOf(_validLangChainOpts).toMatchTypeOf<LangChainGuardOptions>();

// Adapter options: ElizaGuardOptions
const _validElizaOpts: ElizaGuardOptions = {
  interceptor,
  toContractCall: (_action) => call,
  onBlocked: (_info) => {},
  timeoutMs: 3000,
};
expectTypeOf(_validElizaOpts).toMatchTypeOf<ElizaGuardOptions>();

// Adapter options: McpGuardOptions
const _validMcpOpts: McpGuardOptions = {
  interceptor,
  toContractCalls: (_req) => [call],
  onBlocked: (_info) => {},
  timeoutMs: 3000,
};
expectTypeOf(_validMcpOpts).toMatchTypeOf<McpGuardOptions>();

// Adapter options: VercelAIGuardOptions
const _validVercelOpts: VercelAIGuardOptions = {
  interceptor,
  toContractCalls: (_input: VercelAIToolCallInput) => [call],
  onDecision: (_call, _dec) => {},
  timeoutMs: 3000,
};
expectTypeOf(_validVercelOpts).toMatchTypeOf<VercelAIGuardOptions>();

// Policy inspection options
const _validValidatePolicyOpts: ValidatePolicyOptions = {
  guardAddress: contractAddr,
  maxRecipientEntries: 100,
};
expectTypeOf(_validValidatePolicyOpts).toMatchTypeOf<ValidatePolicyOptions>();

const _validDescribePolicyOpts: DescribePolicyOptions = {
  detail: true,
  nowSecs: 1700000000n,
};
expectTypeOf(_validDescribePolicyOpts).toMatchTypeOf<DescribePolicyOptions>();

// ---------------------------------------------------------------------------
// 5. Branded Types & Policy Immutability
// ---------------------------------------------------------------------------
expectTypeOf<ContractAddress>().toExtend<string>();
expectTypeOf<AccountAddress>().toExtend<string>();
expectTypeOf<StrKeyAddress>().toExtend<string>();
expectTypeOf<PublicKeyHex>().toExtend<string>();

// Plain strings must NOT be assignable to branded types without a cast/type guard
expectTypeOf<string>().not.toExtend<ContractAddress>();
expectTypeOf<string>().not.toExtend<AccountAddress>();
expectTypeOf<string>().not.toExtend<StrKeyAddress>();
expectTypeOf<string>().not.toExtend<PublicKeyHex>();

// ReadonlyPolicyConfig is deeply immutable
expectTypeOf<ReadonlyPolicyConfig>().toExtend<DeepReadonly<PolicyConfig>>();

// ---------------------------------------------------------------------------
// 6. Negative Compile Tests (@ts-expect-error)
// ---------------------------------------------------------------------------

// 6a. Negative case: PreFlightBatchDecision has no single "reason" property
declare const batchDecision: PreFlightBatchDecision;
// @ts-expect-error PreFlightBatchDecision does not have a top-level reason property
void batchDecision.reason;

// 6b. Negative case: plain string assigned to branded ContractAddress
// @ts-expect-error plain string cannot be assigned to branded ContractAddress
const _invalidContract: ContractAddress =
  "CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
void _invalidContract;

// 6c. Negative case: plain string assigned to branded AccountAddress
// @ts-expect-error plain string cannot be assigned to branded AccountAddress
const _invalidAccount: AccountAddress = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
void _invalidAccount;

// 6d. Negative case: mutating ReadonlyPolicyConfig properties
declare const readonlyPolicy: ReadonlyPolicyConfig;
// @ts-expect-error ReadonlyPolicyConfig is frozen and its paused property cannot be mutated
readonlyPolicy.paused = true;
// @ts-expect-error ReadonlyPolicyConfig is frozen and its protocols array cannot be mutated
readonlyPolicy.protocols.push({ contract: "" as ContractAddress, fns: null });

// 6e. Negative case: invalid option field types (timeoutMs must be number, not string)
const _invalidTimeout: PreFlightCheckOptions = {
  // @ts-expect-error timeoutMs must be number, not string
  timeoutMs: "3000",
};
void _invalidTimeout;

// 6f. Negative case: unknown options keys rejected
const _invalidOptionKey: PreFlightCheckOptions = {
  // @ts-expect-error unrecognized option key must be rejected
  unknownProperty: true,
};
void _invalidOptionKey;
