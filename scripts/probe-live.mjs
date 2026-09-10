// Probe the live Phase 1 canonical deployment on testnet (read-only).
import { rpc, StrKey, xdr, scValToNative, Keypair, TransactionBuilder, BASE_FEE, Memo, Operation, Networks } from "@stellar/stellar-sdk";

const RPC_URL = "https://soroban-testnet.stellar.org";
const NETWORK = Networks.TESTNET; // 'Test SDF Network ; September 2015'
const GUARD = "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";
const AGENT = "GAOLI6NMXG5X3GZ2ASTIMX24IQQW7CSGHVSOU7HOWFCH73RBZXGAKSPP";

const server = new rpc.Server(RPC_URL, { allowHttp: false });

// 1. Agent account state (seq + balance)
const agentPk = StrKey.decodeEd25519PublicKey(AGENT);
const acctKey = xdr.LedgerKey.account(new xdr.LedgerKeyAccount(xdr.AccountId.publicKeyTypeEd25519(agentPk)));
const acct = await server.getLedgerEntries([acctKey]);
const entry = acct.entries?.[0];
if (entry) {
  const data = entry.val.switch().name; // LedgerEntryData
  const acc = entry.val.account();
  console.log("agent account:", AGENT);
  console.log("  seq:", acc.seqNum().toString());
  console.log("  balance:", acc.balance().toString(), "stroops =", (Number(acc.balance()) / 1e7).toFixed(2), "XLM");
} else {
  console.log("agent account entry NOT FOUND:", entry);
}

// 2. Guard read: status()
const guardAddr = new xdr.ScAddress(xdr.ScAddressType.scAddressTypeContract(), xdr.ContractId.contractIdFromEd25519(StrKey.decodeContract(StrKey.decodeAddress(GUARD).toBuffer())));
// ^ simpler: use the SDK's Address type
const guardScAddr = new (await import("@stellar/stellar-sdk")).Address(GUARD).toScAddress();

const source = new (await import("@stellar/stellar-sdk")).Account(AGENT, "0");
const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: NETWORK })
  .addOperation(
    Operation.invokeContractFunction({
      contract: GUARD,
      function: "status",
      args: [],
    })
  )
  .setTimeout(0)
  .build();

const sim = await server.simulateTransaction(tx);
if (sim.error) {
  console.log("status() simulation error:", sim.error);
} else if (sim.result) {
  console.log("guard status():", JSON.stringify(scValToNative(sim.result.returnValue), null, 2));
}