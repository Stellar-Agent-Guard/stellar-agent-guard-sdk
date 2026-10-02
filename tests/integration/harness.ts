/**
 * Shared harness for the live-tesnet integration suite.
 *
 * These tests run against the real Phase 2 instance, not a mock: every
 * assertion is about a transaction the network either accepted or refused. The
 * harness exists so each test can get a *deterministic* starting point without
 * pretending state is clean when it is not.
 *
 * Two facts about the contract shape the design:
 *
 *  - `set_policy` resets the rolling window to empty and re-arms the heartbeat
 *    (`src/lib.rs`: `save_ledger(&env, &Ledger::empty(&env))`). Re-installing the
 *    same policy is therefore the documented way to obtain a clean window, which
 *    is what makes a rolling-window test repeatable instead of dependent on how
 *    recently the previous run spent.
 *  - The live policy is read, not assumed, and the tests skip with an explicit
 *    reason if the deployed instance does not match the shape they need.
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  Address,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { invoke, type InvokeOutcome } from "../../src/invoke.ts";
import { policyToScVal, unsafeContractAddress, unsafeAccountAddress, type PolicyConfig } from "../../src/policy.ts";
import { readPersistentEntry } from "../../scripts/inspect-deployment.ts";

export const TESTNET_PASSTHRASE = "Test SDF Network ; September 2015";

export interface Phase2Keys {
  admin: Keypair;
  agent: Keypair;
  recipient: Keypair;
  outsider: Keypair;
}

export interface Phase2Config {
  rpcUrl: string;
  guard: string;
  token: string;
  keys: Phase2Keys;
  /** The policy the instance is expected to run for these tests. */
  policy: PolicyConfig;
}

/**
 * Parses simple KEY=VALUE lines from an env file string, ignoring comments and whitespace.
 */
export function parseEnvContent(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index > 0) out[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  }
  return out;
}

/**
 * Synchronous reader for the env file, used for up-front entry checks before test runners launch.
 */
export function readEnvFileSync(path = ENV_FILE): Record<string, string> | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return parseEnvContent(raw);
}

async function readEnvFile(path = ENV_FILE): Promise<Record<string, string> | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    // A missing file is the ordinary first-run case, not an unexpected I/O
    // failure. Return null so the caller fails with the same actionable pointer
    // an incomplete file gets, instead of a bare ENOENT with no next step.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return parseEnvContent(raw);
}

/**
 * Every key the live suite reads from `.env.phase2`.
 *
 * Kept in one list so the failure path can name *all* missing keys in a single
 * message. Failing one key per run — fix, re-run, discover the next — turns a
 * five-minute setup into five round trips, and the fix is one array.
 */
export const REQUIRED_PHASE2_KEYS = [
  "PHASE2_GUARD",
  "PHASE2_TOKEN",
  "PHASE2_ADMIN_SECRET",
  "PHASE2_AGENT_SECRET",
  "PHASE2_RECIPIENT_SECRET",
  "PHASE2_OUTSIDER_SECRET",
] as const;

/** The gitignored env file the live suite reads. Template: `ENV_EXAMPLE_FILE`. */
export const ENV_FILE = ".env.phase2";

/** Safe-to-commit template listing every key, with no values. */
export const ENV_EXAMPLE_FILE = ".env.phase2.example";

/** What produces a populated `.env.phase2`, including the keys the suite does not read. */
export const DEPLOY_COMMAND = "npm run deploy:phase2";

/**
 * The fail-fast message for an incomplete `.env.phase2`: every missing key at
 * once, plus the two ways to produce a complete file. Exported so it can be
 * asserted verbatim rather than pattern-matched loosely.
 */
export function missingPhase2KeysMessage(missing: readonly string[]): string {
  return [
    `.env.phase2 is incomplete: ${missing.length} required key(s) are missing:`,
    ...missing.map((key) => `  - ${key}`),
    "",
    `Copy the documented template and fill it in:  cp ${ENV_EXAMPLE_FILE} .env.phase2`,
    `Or provision a fresh instance (writes the file, including PHASE2_ISSUER_SECRET):  ${DEPLOY_COMMAND}`,
  ].join("\n");
}

/**
 * The fail-fast message for a missing `.env.phase2`: the same two ways to
 * produce it that `missingPhase2KeysMessage` points at, stated as a not-found
 * rather than a not-incomplete file, so a first run is not misreported.
 *
 * Before this, a missing file surfaced as a raw `ENOENT` from `readFile` — the
 * exact case the README's quick start hits first — with no `cp`/deploy pointer;
 * only a file that existed *and* was incomplete got the actionable message.
 */
export function missingEnvFileMessage(): string {
  return [
    `${ENV_FILE} was not found in the working directory.`,
    "",
    `Copy the documented template and fill it in:  cp ${ENV_EXAMPLE_FILE} ${ENV_FILE}`,
    `Or provision a fresh instance (writes the file, including PHASE2_ISSUER_SECRET):  ${DEPLOY_COMMAND}`,
  ].join("\n");
}

export interface Phase2EnvValidationResult {
  readonly ok: boolean;
  readonly message?: string;
  readonly missingKeys?: readonly string[];
}

/**
 * Validates the Phase 2 live testnet environment up front before executing test runners.
 * Returns { ok: true } when all required keys are present, or { ok: false, message }
 * with the single actionable failure message listing all missing keys and the template copy pointer.
 */
export function validatePhase2Env(
  env: Record<string, string> | null = readEnvFileSync(),
): Phase2EnvValidationResult {
  if (env === null) {
    return { ok: false, message: missingEnvFileMessage() };
  }
  const missing = REQUIRED_PHASE2_KEYS.filter((key) => !env[key]);
  if (missing.length > 0) {
    return {
      ok: false,
      missingKeys: [...missing],
      message: missingPhase2KeysMessage(missing),
    };
  }
  return { ok: true };
}

export async function loadPhase2Config(): Promise<Phase2Config> {
  const env = await readEnvFile();
  const validation = validatePhase2Env(env);
  if (!validation.ok || env === null) {
    throw new Error(validation.message);
  }
  const need = (key: (typeof REQUIRED_PHASE2_KEYS)[number]): string => env[key]!;

  const guard = need("PHASE2_GUARD");
  const token = need("PHASE2_TOKEN");
  const keys: Phase2Keys = {
    admin: Keypair.fromSecret(need("PHASE2_ADMIN_SECRET")),
    agent: Keypair.fromSecret(need("PHASE2_AGENT_SECRET")),
    recipient: Keypair.fromSecret(need("PHASE2_RECIPIENT_SECRET")),
    outsider: Keypair.fromSecret(need("PHASE2_OUTSIDER_SECRET")),
  };

  // Bounds the suite depends on. Chosen so the rolling-window scenario can be
  // proven with two individually-admissible transfers (each below `window_cap`)
  // whose sum exceeds it — a single oversized transfer would only prove a cap,
  // not the accumulation.
  const policy: PolicyConfig = {
    per_tx_cap: 1000n,
    window_secs: 60n,
    window_cap: 150n,
    assets: [unsafeContractAddress(token)],
    protocols: [],
    recipients: [unsafeAccountAddress(keys.recipient.publicKey())],
    allow_any_recipient: false,
    active_from: 0n,
    active_until: 0n,
    paused: false,
    dms_grace_secs: 0n,
  };

  return {
    rpcUrl: env["PHASE2_RPC_URL"] ?? "https://soroban-testnet.stellar.org",
    guard,
    token,
    keys,
    policy,
  };
}

/** Read a contract view function, mutating nothing. */
export async function readContract(
  server: rpc.Server,
  contract: string,
  fn: string,
  args: xdr.ScVal[],
  sourceAddress: string,
): Promise<unknown> {
  const account = await server.getAccount(sourceAddress);
  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: TESTNET_PASSPHRASE,
  })
    .addOperation(Operation.invokeContractFunction({ contract, function: fn, args }))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`read ${fn} failed: ${sim.error}`);
  }
  const retval = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  return retval === undefined ? null : (scValToNative(retval) as unknown);
}

/**
 * Install the suite's policy via the admin, which also clears the rolling window
 * and re-arms the dead-man switch. Every window-sensitive test starts here so its
 * result does not depend on how much a previous run spent.
 */
export async function installPolicy(
  server: rpc.Server,
  config: Phase2Config,
  policy: PolicyConfig = config.policy,
): Promise<void> {
  const outcome = await invoke({
    server,
    source: config.keys.admin,
    call: {
      contract: unsafeContractAddress(config.guard),
      fn: "set_policy",
      args: [policyToScVal(policy)],
    },
    networkPassphrase: TESTNET_PASSPHRASE,
    accountSigners: [config.keys.admin],
  });
  if (outcome.kind !== "allowed") {
    throw new Error(`set_policy did not succeed: ${JSON.stringify(outcome)}`);
  }
}

/** Move SAC tokens out of the guarded account, authorized by the agent key. */
export async function transfer(
  server: rpc.Server,
  config: Phase2Config,
  amount: bigint,
  to: string,
): Promise<InvokeOutcome> {
  return invoke({
    server,
    source: config.keys.agent,
    call: {
      contract: unsafeContractAddress(config.token),
      fn: "transfer",
      args: [
        new Address(config.guard).toScVal(),
        new Address(to).toScVal(),
        nativeToScVal(amount, { type: "i128" }),
      ],
    },
    networkPassphrase: TESTNET_PASSPHRASE,
    guardAuth: { guard: config.guard, agent: config.keys.agent },
  });
}

/**
 * The committed rolling-window total.
 *
 * The window is internal spend accounting with no read function, so it is read
 * from persistent storage at `DataKey::Window` — the same entry the contract mutates
 * when it commits a transfer. That makes it the only honest check that
 * a "blocked" transfer really did move nothing.
 */
export async function readWindowTotal(
  server: rpc.Server,
  config: Phase2Config,
): Promise<{ total: bigint; entries: unknown[] }> {
  const entry = await readPersistentEntry(server, config.guard, "Window");
  const value = entry?.value as { total?: bigint | number; entries?: unknown[] } | null | undefined;
  return {
    total: BigInt(value?.total ?? 0n),
    entries: value?.entries ?? [],
  };
}

/** The guarded account's SAC balance, as recorded on the token contract. */
export async function guardTokenBalance(
  server: rpc.Server,
  config: Phase2Config,
): Promise<bigint> {
  const raw = await readContract(
    server,
    config.token,
    "balance",
    [new Address(config.guard).toScVal()],
    config.keys.admin.publicKey(),
  );
  return BigInt((raw as bigint | number | null) ?? 0);
}

/** Read the live policy exactly as the contract stores it. */
export async function readPolicy(
  server: rpc.Server,
  config: Phase2Config,
): Promise<PolicyConfig | null> {
  const raw = await readContract(
    server,
    config.guard,
    "policy",
    [],
    config.keys.admin.publicKey(),
  );
  return raw === null ? null : (raw as PolicyConfig);
}

/** Read live status (has_policy / admin_frozen / heartbeat_expired). */
export async function readStatus(
  server: rpc.Server,
  config: Phase2Config,
): Promise<{ has_policy: oolean; admin_frozen: boolean; heartbeat_expired: boolean }> {
  const raw = await readContract(
    server,
    config.guard,
    "status",
    [],
    config.keys.admin.publicKey(),
  );
  return raw as { has_policy: boolean; admin_frozen: boolean; heartbeat_expired: boolean };
}

/**
 * The guarded account's current sequence number, as read from the network.
 *
 * This is the strongest available signal that a blocked attempt never broadcast:
 * a submitted transaction bumps the source account's sequence even when the
 * contract returns an error, so an unchanged sequence across the attempted call
 * is direct evidence that no transaction was ever submitted.
 */
export async function accountSequence(
  server: rpc.Server,
  address: string,
): Promise<bigint> {
  const account = await server.getAccount(address);
  return BigInt(account.sequenceNumber());
}

/**
 * Snapshot of the chain state that a blocked attempt must leave untouched.
 *
 * Both reads are taken from the network (not from a mock), so equality of two
 * snapshots surrounding a tool call is the "no broadcast happened" assertion.
 */
export interface ChainSnapshot {
  readonly sequence: bigint;
  readonly balance: bigint;
}

/** Capture the guarded account's sequence + SAC balance in one read pair. */
export async function captureChainSnapshot(
  server: rpc.Server,
  config: Phase2Config,
): Promise<ChainSnapshot> {
  const [sequence, balance] = await Promise.all([
    accountSequence(server, config.keys.agent.publicKey()),
    guardTokenBalance(server, config),
  ]);
  return { sequence, balance };
}

export const FIXTURE_POLICY: PolicyConfig = {
  per_tx_cap: 1000n,
  window_secs: 60n,
  window_cap: 150n,
  assets: [],
  protocols: [],
  recipients: [],
  allow_any_recipient: false,
  active_from: 0n,
  active_until: 0n,
  paused: false,
  dms_grace_secs: 0n,
};
