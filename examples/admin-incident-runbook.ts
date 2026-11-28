import { Address, Keypair, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  dmsUrgency,
  fetchGuardPolicyAndWindow,
  readGuardStatus,
  startHeartbeat,
  submitFreeze,
  submitRotateAgentKey,
  submitUnfreeze,
  type ContractAddress,
  type GuardStatus,
  type PolicyConfig,
} from "../src/index.ts";

type AdminOutcome = Awaited<ReturnType<typeof submitFreeze>>;

export interface AdminRunbookConfig {
  server: rpc.Server;
  networkPassphrase: string;
  guard: ContractAddress;
  admin: Keypair;
  source: Keypair;
  previousAgent: Keypair;
  newAgent: Keypair;
  alert: (message: string) => void;
  confirmSecondOperator: (summary: string) => Promise<void>;
}

export interface PolicyPreview {
  policy: PolicyConfig | null;
  windowSpent: bigint;
  status: GuardStatus;
  urgency: ReturnType<typeof dmsUrgency>;
}

interface EntryDataLike {
  contractData?: (() => { val?: xdr.ScVal }) | { val?: xdr.ScVal };
}

function adminParams(config: AdminRunbookConfig) {
  return {
    server: config.server,
    guard: config.guard,
    admin: config.admin,
    source: config.source,
    networkPassphrase: config.networkPassphrase,
  };
}

function statusParams(config: AdminRunbookConfig) {
  return {
    server: config.server,
    guard: config.guard,
    source: config.admin.publicKey(),
    networkPassphrase: config.networkPassphrase,
  };
}

function requireAllowed(outcome: AdminOutcome, operation: string): string {
  if (outcome.kind === "allowed") return outcome.submission.hash;
  const detail = "detail" in outcome && typeof outcome.detail === "string" ? outcome.detail : "";
  throw new Error(
    `${operation} did not reach the ledger (${outcome.kind})${detail ? `: ${detail}` : ""}`,
  );
}

function rawAgentHex(agent: Keypair): string {
  return Buffer.from(agent.rawPublicKey()).toString("hex");
}

export async function readStoredAgentPubkey(
  server: rpc.Server,
  guard: ContractAddress,
): Promise<string | null> {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(guard).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent,
    }),
  );
  const response = await server.getLedgerEntries(key);
  const entry = response.entries?.[0] as unknown as { val?: EntryDataLike } | undefined;
  const arm = entry?.val?.contractData;
  const contractData = typeof arm === "function" ? arm() : arm;
  if (!contractData?.val) return null;
  const instance = scValToNative(contractData.val) as Record<string, unknown>;
  const pubkey = instance["AgentPubkey"];
  return pubkey instanceof Uint8Array ? Buffer.from(pubkey).toString("hex") : null;
}

export async function previewPolicy(config: AdminRunbookConfig): Promise<PolicyPreview> {
  const [{ policy, windowSpent }, status] = await Promise.all([
    fetchGuardPolicyAndWindow(config.server, config.guard),
    readGuardStatus(statusParams(config)),
  ]);
  return { policy, windowSpent, status, urgency: dmsUrgency(status, policy) };
}

export async function freezeForIncident(config: AdminRunbookConfig): Promise<string> {
  await config.confirmSecondOperator(`freeze guard ${config.guard}`);
  return requireAllowed(await submitFreeze(adminParams(config)), "freeze");
}

export async function verifyFrozen(config: AdminRunbookConfig): Promise<GuardStatus> {
  const status = await readGuardStatus(statusParams(config));
  if (!status.admin_frozen) throw new Error("freeze is not visible on-chain");
  return status;
}

export async function rotateAgentKey(config: AdminRunbookConfig): Promise<string> {
  await config.confirmSecondOperator(
    `rotate agent key on guard ${config.guard} to ${config.newAgent.publicKey()}`,
  );
  return requireAllowed(
    await submitRotateAgentKey({ ...adminParams(config), newAgent: config.newAgent }),
    "rotate_agent_key",
  );
}

export async function verifyAgentKey(config: AdminRunbookConfig): Promise<string> {
  const expected = rawAgentHex(config.newAgent);
  const stored = await readStoredAgentPubkey(config.server, config.guard);
  if (stored !== expected) {
    throw new Error(`AgentPubkey is ${stored ?? "missing"}, expected ${expected}`);
  }
  return stored;
}

export async function unfreezeAfterVerification(config: AdminRunbookConfig): Promise<string> {
  await config.confirmSecondOperator(`unfreeze guard ${config.guard} with the verified new key`);
  return requireAllowed(await submitUnfreeze(adminParams(config)), "unfreeze");
}

export async function verifyUnfrozen(
  config: AdminRunbookConfig,
  before: GuardStatus,
): Promise<GuardStatus> {
  const status = await readGuardStatus(statusParams(config));
  if (status.admin_frozen || status.heartbeat_expired) {
    throw new Error("unfreeze did not clear the on-chain freeze");
  }
  if (status.last_heartbeat <= before.last_heartbeat) {
    throw new Error("unfreeze did not re-arm the dead-man clock");
  }
  return status;
}

export async function resumeHeartbeats(config: AdminRunbookConfig, graceSecs: bigint) {
  return startHeartbeat({
    server: config.server,
    guard: config.guard,
    signer: config.newAgent,
    source: config.source,
    networkPassphrase: config.networkPassphrase,
    intervalMs: Number(graceSecs / 6n) * 1000,
    graceSecs,
  });
}
