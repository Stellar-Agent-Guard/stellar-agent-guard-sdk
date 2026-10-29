/**
 * 60-second quickstart (issue #127): see the guard say no.
 *
 * Mirrored verbatim in README.md (except the package import specifier, which the
 * unit test rewrites to this file's relative import). `npm run typecheck`
 * typechecks this file, so the README block cannot drift from code that
 * compiles.
 *
 * Pre-flight is read-only: this runs the guard's `__check_auth` in simulation,
 * prints the verdict and never broadcasts. The enforced simulation does sign the
 * agent auth entry and reads a funded source account, so two testnet secrets are
 * required — the verdict itself costs no fee and no funds move.
 */
import { Keypair, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { PreFlightInterceptor, isContractAddress } from "../src/index.ts";

const RPC_URL = "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

// Phase-2 testnet fixture (tests/fixtures/phase2-instance.json). Override these
// three with your own instance's addresses if you deployed one.
const GUARD =
  process.env.STELLAR_GUARD ?? "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
const TOKEN =
  process.env.STELLAR_TOKEN ?? "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB";
const RECIPIENT =
  process.env.STELLAR_RECIPIENT ?? "GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH";

async function runQuickstart(): Promise<void> {
  // The fixture's agent secret and a funded testnet source account. The
  // fixture's secrets are deliberately not committed; see README "Live testnet
  // suite" for provisioning your own instance.
  const agentSecret = process.env.PHASE2_AGENT_SECRET;
  const sourceSecret = process.env.PHASE2_ADMIN_SECRET;
  if (!agentSecret || !sourceSecret) {
    throw new Error("set PHASE2_AGENT_SECRET and PHASE2_ADMIN_SECRET (see .env.phase2.example)");
  }
  if (!isContractAddress(GUARD) || !isContractAddress(TOKEN)) {
    throw new Error("STELLAR_GUARD and STELLAR_TOKEN must be contract (C...) addresses");
  }

  const interceptor = new PreFlightInterceptor({
    server: new rpc.Server(RPC_URL),
    networkPassphrase: NETWORK_PASSPHRASE,
    guard: GUARD,
    agent: Keypair.fromSecret(agentSecret),
    source: Keypair.fromSecret(sourceSecret),
  });

  // 1001 is above the fixture policy's per_tx_cap of 1000, so this transfer is
  // refused before anything is signed for broadcast (the same refusal is
  // recorded in tests/fixtures/integration-evidence.md).
  const decision = await interceptor.check({
    contract: TOKEN,
    fn: "transfer",
    args: [
      nativeToScVal(GUARD, { type: "address" }),
      nativeToScVal(RECIPIENT, { type: "address" }),
      nativeToScVal(1_001n, { type: "i128" }),
    ],
  });

  console.log(decision.kind === "blocked" ? `blocked: ${decision.reason}` : decision.kind);
}

await runQuickstart();
