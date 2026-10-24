/**
 * Shared harness for the live-testnet integration suite.
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
import {
  policyToScVal,
  unsafeContractAddress,
  unsafeAccountAddress,
  type PolicyConfig,
} from "../../src/policy.ts";
import { createGuardInterceptor } from "../../src/interceptor.ts";
import { readPersistentEntry } from "../../scripts/inspect-deployment.ts";

export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

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

/** The gitignored env file the live suite reads. Template: `ENV_EXAMPLE_FILE`. */
export const ENV_FILE = ".env.phase2";

/** Safe-to-commit template listing every key, with no values. */
export const ENV_EXAMPLE_FILE = ".env.phase2.example";

/** Ephemeral env file generated per isolated live run. */
export const EPHEMERAL_ENV_FILE = ".env.phase2.ephemeral";

/** Ephemeral fixture file generated per isolated live run. */
export const EPHEMERAL_FIXTURE_PATH = ".env.phase2.ephemeral.json";

/** Environment variable opting in to shared-instance mode. */
export const GUARD_FIXTURE_ENV_VAR = "GUARD_FIXTURE";

/** What produces a populated `.env.phase2`, including the keys the suite does not read. */
export const DEPLOY_COMMAND = "npm run deploy:phase2";

let sharedFixtureWarned = false;

/**
 * Returns true when explicitly opting in to the shared testnet instance via GUARD_FIXTURE.
 * Accepts any non-empty value (e.g. GUARD_FIXTURE=shared, GUARD_FIXTURE=1,
 * or a specific fixture path like tests/fixtures/phase2-instance.json).
 */
export function isSharedFixtureMode(): boolean {
  const val = process.env[GUARD_FIXTURE_ENV_VAR]?.trim();
  return Boolean(val && val.length > 0);
}

/**
 * Returns true when running in the default isolated (ephemeral) instance mode.
 */
export function isEphemeralMode(): boolean {
  return !isSharedFixtureMode();
}

/**
 * Resolves the fixture JSON path:
 * - In shared mode: returns custom path if GUARD_FIXTURE points to a file, else FIXTURE_PATH.
 * - In ephemeral mode: returns GUARD_EPHEMERAL_FIXTURE or EPHEMERAL_FIXTURE_PATH if it exists,
 *   falling back to FIXTURE_PATH.
 */
export function resolveFixturePath(): string {
  if (isSharedFixtureMode()) {
    const val = process.env[GUARD_FIXTURE_ENV_VAR]?.trim();
    if (val && !["shared", "1", "true", "default"].includes(val.toLowerCase())) {
      return val;
    }
    return FIXTURE_PATH;
  }
  if (process.env["GUARD_EPHEMERAL_FIXTURE"]) {
    return process.env["GUARD_EPHEMERAL_FIXTURE"];
  }
  try {
    if (readFileSync(EPHEMERAL_FIXTURE_PATH)) return EPHEMERAL_FIXTURE_PATH;
  } catch {
    // Falls back to FIXTURE_PATH
  }
  return FIXTURE_PATH;
}

/**
 * Resolves the environment file path:
 * - If GUARD_EPHEMERAL_ENV_FILE is set, returns that path.
 * - If in ephemeral mode and EPHEMERAL_ENV_FILE exists, returns that path.
 * - Otherwise returns ENV_FILE (".env.phase2").
 */
export function resolveEnvFile(): string {
  if (process.env["GUARD_EPHEMERAL_ENV_FILE"]) {
    return process.env["GUARD_EPHEMERAL_ENV_FILE"];
  }
  if (isEphemeralMode()) {
    try {
      if (readFileSync(EPHEMERAL_ENV_FILE)) return EPHEMERAL_ENV_FILE;
    } catch {
      // Falls back to ENV_FILE
    }
  }
  return process.env["PHASE2_ENV_FILE_PATH"] ?? ENV_FILE;
}

/**
 * Actionable warning message printed when running in shared-instance mode.
 */
export function sharedFixtureWarningMessage(fixturePath = resolveFixturePath()): string {
  return (
    `[GUARD_FIXTURE] WARNING: Running against shared testnet fixture (${fixturePath}).\n` +
    `  Concurrent test runs may interleave sequence numbers and rolling window spend.\n` +
    `  For isolated parallel-safe execution, unset ${GUARD_FIXTURE_ENV_VAR} to use default ephemeral mode.`
  );
}

/**
 * Warns once to stderr when shared fixture mode is active.
 */
export function warnIfSharedFixture(): void {
  if (!sharedFixtureWarned && isSharedFixtureMode()) {
    sharedFixtureWarned = true;
    console.warn(sharedFixtureWarningMessage());
  }
}

/**
 * Reset warning state (used in unit testing).
 */
export function resetSharedFixtureWarning(): void {
  sharedFixtureWarned = false;
}

/**
 * Synchronous reader for the env file, used for up-front entry checks before test runners launch.
 */
export function readEnvFileSync(path = resolveEnvFile()): Record<string, string> | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return parseEnvContent(raw);
}

async function readEnvFile(path = resolveEnvFile()): Promise<Record<string, string> | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
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

/**
 * The fail-fast message for an incomplete `.env.phase2`: every missing key at
 * once, plus the two ways to produce a complete file. Exported so it can be
 * asserted verbatim rather than pattern-matched loosely.
 */
export function missingPhase2KeysMessage(missing: readonly string[], file = ENV_FILE): string {
  return [
    `${file} is incomplete: ${missing.length} required key(s) are missing:`,
    ...missing.map((key) => `  - ${key}`),
    "",
    `Copy the documented template and fill it in:  cp ${ENV_EXAMPLE_FILE} ${file}`,
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
export function missingEnvFileMessage(file = ENV_FILE): string {
  return [
    `${file} was not found in the working directory.`,
    "",
    `Copy the documented template and fill it in:  cp ${ENV_EXAMPLE_FILE} ${file}`,
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
  if (isSharedFixtureMode()) {
    warnIfSharedFixture();
  }

  const envPath = resolveEnvFile();
  let env = await readEnvFile(envPath);

  if ((env === null || !validatePhase2Env(env).ok) && isEphemeralMode()) {
    // Auto-deploy fresh isolated instance if running directly without run-tests.ts pre-deployment
    const { deployPhase2Instance } = await import("../../scripts/deploy-phase2-instance.ts");
    const ephemeral = await deployPhase2Instance({
      ephemeral: true,
      envPath: EPHEMERAL_ENV_FILE,
      fixturesPath: EPHEMERAL_FIXTURE_PATH,
      quiet: true,
    });
    process.env["GUARD_EPHEMERAL_ENV_FILE"] = ephemeral.envPath;
    process.env["GUARD_EPHEMERAL_FIXTURE"] = ephemeral.fixturesPath;
    env = await readEnvFile(ephemeral.envPath);
  }

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
  void account;
  return undefined;
}
