/**
 * Capture the guard contract's REAL emitted events, so the telemetry listener is
 * built against the schema the chain actually produces rather than the one the
 * documentation describes.
 *
 * Two captures, because the SDK's telemetry has two distinct sources:
 *
 *   1. a successful `heartbeat` — its contract events come back from
 *      `getTransaction` as ledger events, the same stream a listener tails;
 *   2. a blocked transfer — a policy refusal never becomes a transaction, so its
 *      `auth_checked` decision arrives as a diagnostic event on the failed
 *      enforced simulation, and that is the only place a listener can see it.
 *
 * Usage:
 *   node scripts/capture-event.ts [--guard C...] [--agent-secret S...] [--token C...]
 */
import { readFile } from "node:fs/promises";
import {
  Address,
  Keypair,
  StrKey,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { invoke } from "../src/invoke.ts";
import { unsafeContractAddress } from "../src/policy.ts";
import { GUARD_EVENT_TOPICS } from "../src/events.ts";
import { json, parseArgs } from "./inspect-deployment.ts";
import { summarizeDiagnosticEvents } from "../src/tx.ts";

/** Topic names the guard contract owns; everything else is host/framework noise. */
const GUARD_TOPICS = new Set<string>(Object.values(GUARD_EVENT_TOPICS));

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const TESTNET_RPC = "https://soroban-testnet.stellar.org";

interface CapturedEvent {
  source: "ledger" | "diagnostic";
  contract: string | null;
  topics: string[];
  data: unknown;
}

/** Decode one contract event into the vocabulary a listener would consume. */
function decodeContractEvent(event: unknown, source: CapturedEvent["source"]): CapturedEvent | null {
  // Two shapes reach here: a ledger event from `getTransaction` wraps the body
  // in a `DiagnosticEvent` (`.event.body`), while a simulation diagnostic is a
  // bare event (`.body`). Reading only one silently drops the other — which is
  // exactly what happened on the first capture run.
  const candidate = event as {
    contractId?: unknown;
    body?: { v0?: { topics?: xdr.ScVal[]; data?: xdr.ScVal } };
    event?: { contractId?: unknown; body?: { v0?: { topics?: xdr.ScVal[]; data?: xdr.ScVal } } };
  };
  const inner = candidate.event ?? candidate;
  const body = inner.body?.v0;
  if (!body) return null;
  const contractId = inner.contractId;

  const decode = (value: unknown): unknown => {
    if (value === undefined) return null;
    try {
      return scValToNative(value as xdr.ScVal) as unknown;
    } catch {
      return String(value);
    }
  };

  // Three shapes reach here for the same field: an `ScAddress` on a simulation
  // diagnostic, a bare `ContractId` on a ledger event (whose `toString()` is the
  // raw 32-byte hash, not a strkey), or a pre-decoded strkey string. Normalise
  // all of them, because silently printing `null` here would misattribute which
  // contract emitted an event.
  let contract: string | null = null;
  try {
    if (typeof contractId === "string") {
      contract = contractId;
    } else if (contractId instanceof xdr.ScAddress) {
      contract = Address.fromScAddress(contractId as xdr.ScAddress).toString();
    } else {
      // A bare `ContractId` is an opaque 32-byte hash; `StrKey.encodeContract`
      // is the only strkey-preserving conversion for it.
      const raw = (contractId as { value?: Uint8Array })?.value;
      if (raw) contract = StrKey.encodeContract(Buffer.from(raw));
    }
  } catch {
    contract = null;
  }

  return {
    source,
    contract,
    topics: (body.topics ?? []).map((topic) => String(decode(topic))),
    data: decode(body.data),
  };
}

async function readEnvFile(): Promise<Record<string, string>> {
  try {
    const raw = await readFile(".env.phase2", "utf8");
    const out: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index > 0) out[trimmed.slice(0, index)] = trimmed.slice(index + 1);
    }
    return out;
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2));
  const env = await readEnvFile();
  const rpcUrl = (flags.get("rpc") as string) ?? env["PHASE2_RPC_URL"] ?? TESTNET_RPC;
  const guard = (flags.get("guard") as string) ?? env["PHASE2_GUARD"];
  const token = (flags.get("token") as string) ?? env["PHASE2_TOKEN"];
  const agentSecret = (flags.get("agent-secret") as string) ?? env["PHASE2_AGENT_SECRET"];

  if (!guard || !token || !agentSecret) {
    throw new Error(
      "need --guard/--token/--agent-secret or a populated .env.phase2 (run scripts/deploy-phase2-instance.ts)",
    );
  }
  const agent = Keypair.fromSecret(agentSecret);
  const server = new rpc.Server(rpcUrl);
  const captured: CapturedEvent[] = [];

  // ── Capture 1: a real ledger event from an allowed call ────────────────
  console.log("[1] invoking heartbeat() — a real, allowed agent call");
  const heartbeat = await invoke({
    server,
    source: agent,
    call: { contract: unsafeContractAddress(guard), fn: "heartbeat", args: [] },
    networkPassphrase: TESTNET_PASSPHRASE,
    guardAuth: { guard: unsafeContractAddress(guard), agent },
  });
  if (heartbeat instanceof Error || heartbeat.kind !== "allowed") {
    throw new Error(`heartbeat was not allowed: ${heartbeat instanceof Error ? heartbeat.message : json(heartbeat)}`);
  }
  console.log(`    tx ${heartbeat.submission.hash} (ledger ${heartbeat.submission.ledger})`);

  const tx = await server.getTransaction(heartbeat.submission.hash);
  // `contractEventsXdr` is an array of *groups*, one group per operation-invoked
  // contract, and each group is itself an array of events. Reading it as a flat
  // event list yields one element that is an array and decodes to nothing —
  // which is how the first capture run lost this event entirely.
  const groups = (tx as unknown as { events?: { contractEventsXdr?: unknown[] } }).events
    ?.contractEventsXdr ?? [];
  const ledgerEvents = groups.flatMap((group) => (Array.isArray(group) ? group : [group]));
  console.log(`    ledger contract events returned: ${ledgerEvents.length} (in ${groups.length} group(s))`);
  for (const event of ledgerEvents) {
    const decoded = decodeContractEvent(event, "ledger");
    if (decoded && GUARD_TOPICS.has(decoded.topics[0] ?? "")) captured.push(decoded);
  }

  // ── Capture 2: a blocked call — its decision only exists pre-broadcast ─
  // The recipient must be an allowlisted address that holds a trustline. If it
  // is not, the *token* contract traps on the missing trustline and the failure
  // is a contract error, not a guard decision — which is a different thing and
  // is deliberately not reported as a block.
  const recipientSecret = env["PHASE2_RECIPIENT_SECRET"];
  if (!recipientSecret) {
    throw new Error("PHASE2_RECIPIENT_SECRET missing from .env.phase2 (needed as the transfer destination)");
  }
  const recipient = Keypair.fromSecret(recipientSecret).publicKey();
  console.log(`[2] attempting a per-tx-cap violation (1100 > per_tx_cap 1000) to ${recipient}`);
  const blocked = await invoke({
    server,
    source: agent,
    call: {
      contract: unsafeContractAddress(token),
      fn: "transfer",
      args: [
        new Address(guard).toScVal(),
        new Address(recipient).toScVal(),
        nativeToScVal(1_100n, { type: "i128" }),
      ],
    },
    networkPassphrase: TESTNET_PASSPHRASE,
    guardAuth: { guard: unsafeContractAddress(guard), agent },
  });
  if (blocked instanceof Error || blocked.kind !== "blocked") {
    throw new Error(`expected a pre-broadcast block, got: ${blocked instanceof Error ? blocked.message : json(blocked)}`);
  }
  console.log(`    reason reported by invoke(): ${blocked.reason}`);
  for (const summary of summarizeDiagnosticEvents(blocked.diagnosticEvents)) {
    console.log(`    diagnostic: ${summary}`);
  }
  for (const event of blocked.diagnosticEvents) {
    const bare = (event as { event?: unknown }).event ?? event;
    const decoded = decodeContractEvent(bare, "diagnostic");
    if (decoded && GUARD_TOPICS.has(decoded.topics[0] ?? "")) captured.push(decoded);
  }

  console.log("\n=== CAPTURED EVENT SCHEMA ===");
  console.log(json(captured));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
