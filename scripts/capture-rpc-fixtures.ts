/**
 * Capture REAL Soroban RPC payloads from the live testnet, and commit them as
 * fixtures the unit suite decodes through the SDK's production parsers.
 *
 * ## Why this exists
 *
 * Unit tests that hand-write RPC responses keep passing when the SDK renames a
 * field, re-shapes a nested object, or changes how it reads `events` — the test
 * asserts against the test's own invention, not against what the network sends.
 * That is a drift the suite cannot see. This script records what the RPC
 * actually returned, so a rename is caught in CI instead of in production.
 *
 * ## What it captures (no secrets required)
 *
 *   1. `getEvents`  — a real page for the guard contract, including the RPC's
 *      retention window (`oldestLedger` / `latestLedger`) and its opaque cursor.
 *   2. `simulateTransaction` (success) — a real read-only simulation of
 *      `guard.status()`, carrying the transaction footprint and resource fee.
 *   3. `simulateTransaction` (failure) — a real enforced simulation of a guard
 *      token transfer whose authorization is signed by a throwaway key. The
 *      on-chain `__check_auth` runs and rejects the credential, producing a
 *      genuine host-failure diagnostic payload. (A real
 *      `event_auth_checked / blocked` payload needs the registered agent secret;
 *      the committed golden vocabulary in `tests/fixtures/contract-fixtures.json`
 *      covers that decode path.)
 *
 * Raw responses are stored exactly as the RPC returned them (base64 XDR), so
 * the unit tests load them with the SDK's own decoders (`parseRawEvents`,
 * `parseRawSimulation`) — the same parse path the production clients use, never
 * a test-only parser.
 *
 * ## Usage
 *
 *   node scripts/capture-rpc-fixtures.ts
 *   npm run capture:rpc-fixtures
 *
 * Env overrides: `PHASE2_RPC_URL`, `PHASE2_GUARD`, `PHASE2_TOKEN`.
 * Refresh cadence and the test tier this feeds are documented in
 * `tests/fixtures/rpc/README.md` and `CONTRIBUTING.md`.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
} from "@stellar/stellar-sdk";
import { parseRawSimulation } from "@stellar/stellar-sdk/rpc";
import {
  SIG_EXPIRATION_LEDGERS,
  buildGuardAuthEntry,
  buildInitialEnvelope,
  type GuardCredentialType,
} from "../src/tx.ts";

const RPC_URL = process.env["PHASE2_RPC_URL"] ?? "https://soroban-testnet.stellar.org";
const GUARD =
  process.env["PHASE2_GUARD"] ?? "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
const TOKEN =
  process.env["PHASE2_TOKEN"] ?? "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB";
/** The allowlisted recipient recorded in `tests/fixtures/phase2-instance.json`. */
const RECIPIENT = "GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH";
const NETWORK_PASSPHRASE = Networks.TESTNET;
const OUT_DIR = resolve(process.cwd(), "tests/fixtures/rpc");

/** Read the SDK version the fixtures were captured with, for the provenance header. */
async function sdkVersion(): Promise<string> {
  const pkg = JSON.parse(
    await readFile(resolve(process.cwd(), "node_modules/@stellar/stellar-sdk/package.json"), "utf8"),
  ) as { version: string };
  return pkg.version;
}

interface Provenance {
  source: string;
  method: string;
  contractId: string | null;
  network: "testnet";
  rpcUrl: string;
  capturedAt: string;
  stellarSdkVersion: string;
  note: string;
}

function withProvenance<T extends object>(provenance: Provenance, payload: T): Provenance & T {
  return { ...provenance, ...payload };
}

async function writeFixture(name: string, value: unknown): Promise<void> {
  const path = resolve(OUT_DIR, name);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  console.log(`  wrote ${name}`);
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const server = new rpc.Server(RPC_URL);
  const version = await sdkVersion();
  const capturedAt = new Date().toISOString();
  const base: Omit<Provenance, "method" | "note"> = {
    source: "live Soroban RPC",
    contractId: GUARD,
    network: "testnet",
    rpcUrl: RPC_URL,
    capturedAt,
    stellarSdkVersion: version,
  };

  // ── 1. getEvents: a real page, with the RPC's real retention window ──────
  console.log("[1] getEvents (guard contract page)");
  const latest = await server.getLatestLedger();
  const rawEvents = await server._getEvents({
    filters: [{ type: "contract", contractIds: [GUARD] }],
    startLedger: Math.max(1, latest.sequence - 100),
    limit: 100,
  });
  await writeFixture(
    "get-events-guard-page.json",
    withProvenance(
      {
        ...base,
        method: "getEvents",
        note:
          "Raw getEvents response exactly as the RPC returned it (base64 XDR). " +
          "The guard has no events in the retained window on a quiet network, so " +
          "`events` may be empty; the retention fields and cursor are real.",
      },
      { response: rawEvents },
    ),
  );

  // ── 2. simulateTransaction success: a real read-only simulation ─────────
  console.log("[2] simulateTransaction (guard.status, success)");
  const source = Keypair.random();
  await server.fundAddress(source.publicKey());
  const sourceAccount = await server.getAccount(source.publicKey());
  const readTx = new TransactionBuilder(sourceAccount, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.invokeContractFunction({ contract: GUARD, function: "status", args: [] }))
    .setTimeout(30)
    .build();
  const rawSuccess = await server._simulateTransaction(readTx);
  await writeFixture(
    "simulate-success-status.json",
    withProvenance(
      {
        ...base,
        method: "simulateTransaction",
        note:
          "Raw simulateTransaction success response for guard.status() (base64 XDR), " +
          "with the real transaction footprint and resource fee.",
      },
      { response: rawSuccess },
    ),
  );

  // ── 3. A real failed enforced simulation ────────────────────────────────
  // Sign the guard's auth entry with a deliberately wrong agent key and run the
  // real `__check_auth` against live ledger state. The guard's `unauthorized`
  // path verifies the agent signature *before* it can publish its own block
  // event, so this yields a host trap (`Error(Crypto, InvalidInput)`) rather
  // than a policy refusal — which is exactly what makes it a useful fixture:
  // a real `simulateTransaction` error payload whose diagnostics are host noise,
  // so the suite can prove the decoder does NOT invent a guard event from them.
  // (A genuine `event_auth_checked / blocked` payload cannot be produced without
  // the registered agent secret; the committed golden vocabulary in
  // `tests/fixtures/contract-fixtures.json` covers that decode path instead.)
  console.log("[3] failed enforced simulation (wrong agent key)");
  const sequence = (await server.getAccount(source.publicKey())).sequenceNumber();
  const latestLedger = await server.getLatestLedger();
  const expiration = latestLedger.sequence + SIG_EXPIRATION_LEDGERS;
  const transferCall = {
    contract: TOKEN,
    fn: "transfer",
    args: [
      new Address(GUARD).toScVal(),
      new Address(RECIPIENT).toScVal(),
      nativeToScVal(100n, { type: "i128" }),
    ],
  };
  const operation = Operation.invokeContractFunction({
    contract: transferCall.contract,
    function: transferCall.fn,
    args: transferCall.args,
  });
  const probe = buildInitialEnvelope({
    source: new Account(source.publicKey(), sequence),
    operation,
    networkPassphrase: NETWORK_PASSPHRASE,
    guard: GUARD,
  });
  const parsedProbe = parseRawSimulation(await server._simulateTransaction(probe));
  if (rpc.Api.isSimulationError(parsedProbe)) {
    throw new Error(`probe simulation failed: ${JSON.stringify(parsedProbe).slice(0, 300)}`);
  }
  const credential = parsedProbe.result?.auth?.[0];
  if (!credential) throw new Error("probe discovered no authorization to sign");
  const credentialType = credential.credentials.type as GuardCredentialType;
  const signed = await buildGuardAuthEntry({
    guard: GUARD,
    call: transferCall,
    signer: Keypair.random(),
    nonce: BigInt(sequence),
    signatureExpirationLedger: expiration,
    networkPassphrase: NETWORK_PASSPHRASE,
    credentialType,
  });
  const enforced = buildInitialEnvelope({
    source: new Account(source.publicKey(), sequence),
    operation: Operation.invokeContractFunction({
      contract: transferCall.contract,
      function: transferCall.fn,
      args: transferCall.args,
      auth: [signed],
    }),
    networkPassphrase: NETWORK_PASSPHRASE,
    guard: GUARD,
  });
  const rawFailed = await server._simulateTransaction(enforced);
  await writeFixture(
    "simulate-error-wrong-agent.json",
    withProvenance(
      {
        ...base,
        method: "simulateTransaction (enforced, failed)",
        note:
          "Real enforced-simulation failure. The guard's auth entry is signed by a " +
          "throwaway key, so the on-chain __check_auth rejects the credential before " +
          "the contract can publish a block event: diagnostics are host noise. Used " +
          "to prove the decoder never fabricates a guard event from host failures.",
      },
      { response: rawFailed },
    ),
  );

  console.log(`\nCaptured 3 fixtures into tests/fixtures/rpc/ (sdk ${version})`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
