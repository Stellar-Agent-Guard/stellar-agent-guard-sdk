/**
 * Read-only inspection of a stellar-agent-guard deployment on Stellar testnet:
 * contract WASM hash (artifact identity), the on-chain ABI, policy, status, and
 * token balances.
 *
 * This is the SDK/RPC equivalent of `stellar contract fetch` /
 * `stellar contract info` — the standalone `stellar` CLI is not installed in
 * this environment, so the same data is read straight off the ledger through
 * the SDK's ledger/RPC helpers.
 *
 * Usage:
 *   node scripts/inspect-deployment.ts [--guard C...] [--token C...] [--json]
 */
import { createHash } from "node:crypto";
import {
  Account,
  Address,
  Contract,
  Networks,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { unsafeContractAddress, unsafeAccountAddress } from "../src/policy.ts";

/** Phase 1 guard instance — historical dead-man-switch evidence, untouched. */
const PHASE1_GUARD = unsafeContractAddress("CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7");
const PHASE1_TOKEN = unsafeContractAddress("CBLQLJAG72M4XQRJMQHSKYIFVHQD7LNTNOQH2GRMCMBWMSLBSLTGTJC7");
const PHASE1_ADMIN = unsafeAccountAddress("GD5S5O2MZ6FSMFH6QILG37KSQNRVR3RPSWBTTV4JOUJ7J6TWLLL5LAVS");
const TESTNET_RPC = "https://soroban-testnet.stellar.org";

/**
 * Simulated contract returns carry u64/i128 as BigInt, which JSON.stringify
 * refuses. Render them as decimal strings — exact, and stable across runs.
 */
export function json(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );
}

/** Single-line render for terminal output. */
function compact(value: unknown): string {
  return json(value).replace(/\s+/g, " ");
}

export function parseArgs(argv: string[]) {
  const flags = new Map<string, string | true>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) {
      rest.push(token);
      continue;
    }
    const value = argv[i + 1];
    if (value !== undefined && !value.startsWith("--")) {
      flags.set(token.slice(2), value);
      i++;
    } else {
      flags.set(token.slice(2), true);
    }
  }
  return { flags, rest };
}

/**
 * Normalise the several shapes an xdr.Hash can arrive in across SDK helper
 * return values into lowercase hex, or null when absent/not a 32-byte hash.
 */
export function hashToHex(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.replace(/^0x/, "").toLowerCase();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  const asXdr = value as { toXdrObject?: () => unknown; toJSON?: () => unknown };
  if (typeof asXdr.toXdrObject === "function") {
    return hashToHex(asXdr.toXdrObject());
  }
  if (typeof asXdr.toJSON === "function") {
    const rendered = asXdr.toJSON();
    if (typeof rendered === "string") return hashToHex(rendered);
    if (rendered && typeof rendered === "object") {
      const record = rendered as Record<string, unknown>;
      return hashToHex(record["wasm"] ?? record["wasmHash"]);
    }
  }
  return null;
}

/**
 * Verify that a deployed contract's bytecode hashes to the WASM hash the
 * ledger reports for its instance. The ledger stores `ContractCode` keyed by
 * the SHA-256 of the uploaded bytes, so recomputing it here is an independent
 * check that the artifact on chain is the one we think it is.
 */
export async function verifyWasmIdentity(
  server: rpc.Server,
  contractId: string,
): Promise<{ reportedWasmHash: string | null; fetchedSha256: string; bytes: number }> {
  // `getContractInstance` returns a decoded instance whose `executable` is the
  // ContractExecutable union; for WASM contracts it carries an `xdr.Hash`, not
  // a bare Uint8Array, so the bytes come from its wire form.
  const instance = (await server.getContractInstance(contractId)) as unknown as {
    executable?: { wasmHash?: unknown };
  };
  const reportedWasmHash = hashToHex(instance.executable?.wasmHash);
  const wasm = await server.getContractWasmByContractId(contractId);
  const bytes = Buffer.from(wasm as unknown as ArrayLike<number>);
  return {
    reportedWasmHash,
    fetchedSha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}

/**
 * Read one of a contract's persistent storage entries.
 *
 * The guard's rolling-window ledger (`Window`) is not exposed by any read
 * function — it is internal spend accounting — but it is the only way to see
 * how much of the rolling cap is currently consumed, which matters before
 * writing tests that depend on window headroom. `DataKey::Window` serialises as
 * `[Symbol("Window")]` under persistent durability.
 */
export async function readPersistentEntry(
  server: rpc.Server,
  contractId: string,
  dataKeyName: string,
): Promise<{ value: unknown; lastModifiedLedgerSeq: number | null } | null> {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(dataKeyName)]),
      durability: xdr.ContractDataDurability.persistent,
    }),
  );
  const response = await server.getLedgerEntries(key);
  const entry = response.entries[0] as unknown as {
    val?: { contractData?: { val?: xdr.ScVal } };
    lastModifiedLedgerSeq?: number;
  };
  const scval = entry?.val?.contractData?.val;
  if (!scval) return null;
  return {
    value: scValToNative(scval) as unknown,
    lastModifiedLedgerSeq: entry.lastModifiedLedgerSeq ?? null,
  };
}

/** Read a contract's public function names and signatures from its on-chain spec. */
export async function readOnChainAbi(
  server: rpc.Server,
  contractId: string,
): Promise<Array<{ name: string; inputs: string[] }>> {
  const methods = (await server.getContractMethods(contractId)) as unknown;
  const entries = Array.isArray(methods)
    ? methods
    : Object.values(methods as Record<string, unknown>);
  const asArray = entries as Array<Record<string, unknown>>;
  return asArray
    .filter((entry) => typeof entry === "object" && entry !== null)
    .map((entry) => {
      const inputs = Array.isArray(entry["inputs"]) ? (entry["inputs"] as unknown[]) : [];
      return {
        name: typeof entry["name"] === "string" ? entry["name"] : "(unnamed)",
        inputs: inputs.map((input) => {
          if (input && typeof input === "object" && "type" in (input as object)) {
            return String((input as { type: unknown }).type);
          }
          return json(input).replace(/\s+/g, " ");
        }),
      };
    });
}

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2));
  const guardId = (flags.get("guard") as string) ?? PHASE1_GUARD;
  const tokenId = (flags.get("token") as string) ?? PHASE1_TOKEN;
  const sourceAddress = (flags.get("source") as string) ?? PHASE1_ADMIN;
  const rpcUrl = (flags.get("rpc") as string) ?? TESTNET_RPC;
  const asJson = flags.get("json") === true;

  const server = new rpc.Server(rpcUrl);
  const report: Record<string, unknown> = {};

  const latest = await server.getLatestLedger();
  report.rpcUrl = rpcUrl;
  report.latestLedger = latest.sequence;

  // ── Artifact identity ──────────────────────────────────────────────────
  const identity = await verifyWasmIdentity(server, guardId);
  report.wasm = {
    ...identity,
    matches: identity.reportedWasmHash === identity.fetchedSha256,
  };

  // ── On-chain ABI ───────────────────────────────────────────────────────
  report.abi = await readOnChainAbi(server, guardId);

  // ── Guard read surface (no auth required) ──────────────────────────────
  const source = new Account(sourceAddress, "0");
  async function simulateRead(contractId: string, fn: string, args: xdr.ScVal[] = []) {
    const tx = new TransactionBuilder(source, {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(new Contract(contractId).call(fn, ...args))
      .setTimeout(30)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) return { error: sim.error };
    const retval = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (retval === undefined) return { error: "simulation returned no value" };
    return { value: scValToNative(retval) as unknown };
  }

  report.guard = guardId;
  report.guardStatus = await simulateRead(guardId, "status");
  report.guardPolicy = await simulateRead(guardId, "policy");
  // Rolling-window spend state, which no read function exposes.
  report.guardWindow = await readPersistentEntry(server, guardId, "Window");
  report.guardFrozenFlag = await readPersistentEntry(server, guardId, "AdminFrozen");
  report.guardPolicySha256 = createHash("sha256").update(json(report.guardPolicy)).digest("hex");
  report.token = tokenId;
  report.tokenDecimals = await simulateRead(tokenId, "decimals");
  report.tokenBalanceOfGuard = await simulateRead(tokenId, "balance", [
    new Address(guardId).toScVal(),
  ]);

  if (asJson) {
    console.log(json(report));
    return;
  }

  console.log(`RPC                 ${rpcUrl}`);
  console.log(`latest ledger       ${latest.sequence}`);
  console.log(`guard contract      ${guardId}`);
  console.log(`WASM hash (ledger)  ${identity.reportedWasmHash}`);
  console.log(`WASM sha256 (bytes) ${identity.fetchedSha256} (${identity.bytes} bytes)`);
  console.log(`WASM identity match ${identity.reportedWasmHash === identity.fetchedSha256}`);
  console.log(`on-chain ABI        ${report.abi ? compact(report.abi) : "(none)"}`);
  console.log(`guard.status        ${compact(report.guardStatus)}`);
  console.log(`guard.policy        ${compact(report.guardPolicy)}`);
  console.log(`policy sha256       ${report.guardPolicySha256}`);
  console.log(`guard.window        ${compact(report.guardWindow)}`);
  console.log(`guard.adminFrozen   ${compact(report.guardFrozenFlag)}`);
  console.log(`token               ${tokenId}`);
  console.log(`  decimals          ${compact(report.tokenDecimals)}`);
  console.log(`  balance(guard)    ${compact(report.tokenBalanceOfGuard)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
