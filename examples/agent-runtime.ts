/**
 * Agent runtime example — the loop a 24/7 agent runs (docs/agent-runtime.md).
 *
 * Four responsibilities, each a function below:
 *  1. keep the dead-man switch alive      -> `startAgentHeartbeat`
 *  2. pre-flight every transfer            -> `guardedTransfer`
 *  3. tail telemetry for operator alerts   -> `tailTelemetry`
 *  4. watch the DMS countdown              -> `checkDmsHealth`
 *
 * Everything fails closed: the only verdict that lets a transfer run is an
 * `admissible` one (`actionFor`). `npm run typecheck` compiles this file, so the
 * calls shown in the guide cannot drift from the SDK.
 */
import { Keypair, rpc } from "@stellar/stellar-sdk";
import {
  GuardTelemetryListener,
  PreFlightInterceptor,
  dmsUrgency,
  fetchGuardPolicyAndWindow,
  readGuardStatus,
  startHeartbeat,
  type ContractAddress,
  type ContractCall,
  type DmsUrgency,
  type GuardEvent,
  type HeartbeatHandle,
  type PreFlightDecision,
} from "../src/index.ts";

export interface AgentRuntimeConfig {
  server: rpc.Server;
  networkPassphrase: string;
  guard: ContractAddress;
  /** The key registered as the guard's agent; also pays fees in this example. */
  agent: Keypair;
  /** Operator alert sink (pager, chat, log). */
  alert: (message: string) => void;
}

/** What the agent does with a verdict. There is no "proceed on doubt" arm. */
export type VerdictAction = "execute" | "refuse";

/**
 * Map a verdict to an action. `undetermined` (RPC down, rate limited, timeout,
 * unpriceable simulation) refuses exactly like `blocked`: a guard that could not
 * decide has not approved anything.
 */
export function actionFor(decision: PreFlightDecision): VerdictAction {
  return decision.kind === "admissible" ? "execute" : "refuse";
}

/** 1. Keep the dead-man switch alive. Interval must be <= grace/3 (validated). */
export async function startAgentHeartbeat(
  config: AgentRuntimeConfig,
  graceSecs: bigint,
): Promise<HeartbeatHandle> {
  return startHeartbeat({
    server: config.server,
    guard: config.guard,
    signer: config.agent,
    networkPassphrase: config.networkPassphrase,
    // Beat well inside grace/3 so one missed beat never freezes the account.
    intervalMs: Number(graceSecs / 6n) * 1000,
    graceSecs,
    retry: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 10_000 },
    onBeat: ({ lateMs }) => {
      if (lateMs > 2_000) config.alert(`heartbeat ${lateMs}ms late`);
    },
    onError: (error) => config.alert(`heartbeat failed: ${String(error)}`),
    onWarning: (message) => config.alert(`heartbeat warning: ${message}`),
  });
}

/** 2. Pre-flight a transfer; the caller only runs it when this returns `execute`. */
export async function guardedTransfer(
  interceptor: PreFlightInterceptor,
  call: ContractCall,
  alert: (message: string) => void,
): Promise<VerdictAction> {
  const decision = await interceptor.check(call, { timeoutMs: 10_000 });
  const action = actionFor(decision);
  if (decision.kind === "blocked") alert(`blocked: ${decision.reason} — ${decision.explanation}`);
  if (decision.kind === "undetermined") alert(`undetermined (refused): ${decision.detail}`);
  return action;
}

/** 3. Tail committed + diagnostic events and alert on the ones an operator needs. */
export async function tailTelemetry(
  config: AgentRuntimeConfig,
  signal: AbortSignal,
): Promise<void> {
  const listener = new GuardTelemetryListener({
    server: config.server,
    guard: config.guard,
    rpcUrl: "https://soroban-testnet.stellar.org",
  });
  for await (const event of listener.watchAll({ signal })) {
    const message = alertFor(event);
    if (message) config.alert(message);
  }
}

/** The events worth waking an operator for. */
export function alertFor(event: GuardEvent): string | null {
  if (event.kind === "frozen") return "guard frozen";
  if (event.kind === "unfrozen") return "guard unfrozen";
  if (event.kind === "policy_set" || event.kind === "policy_revoked") {
    return `policy changed (${event.kind})`;
  }
  if (event.kind === "auth_checked" && event.decision?.result === "blocked") {
    return `guard blocked a call: ${event.decision.reason ?? "unknown reason"}`;
  }
  return null;
}

/**
 * 4. DMS countdown. `dmsUrgency` warns once `elapsed >= warnRatio * grace`
 * (default `DMS_WARN_RATIO_DEFAULT` = 0.8), where `elapsed = now - last_heartbeat`.
 * A contract-side `dms_health` read does not exist yet; this is derived from the
 * same `status()` and policy the contract uses, with the same edge semantics.
 */
export async function checkDmsHealth(config: AgentRuntimeConfig): Promise<DmsUrgency> {
  const [{ policy }, status] = await Promise.all([
    fetchGuardPolicyAndWindow(config.server, config.guard),
    readGuardStatus({
      server: config.server,
      guard: config.guard,
      source: config.agent.publicKey(),
      networkPassphrase: config.networkPassphrase,
    }),
  ]);
  const urgency = dmsUrgency(status, policy);
  if (urgency === "warn") config.alert("dead-man switch past 80% of grace: heartbeats are late");
  if (urgency === "expired") config.alert("dead-man switch EXPIRED: account is frozen");
  return urgency;
}
