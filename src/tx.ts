/*
 * Transaction construction for a guarded smart account.
 *
 * ## Why this module exists

 * The `stellar` CLI cannot sign a Soroban authorization entry whose address is
 * a *contract* (the guard): it only signs for the transaction source account
 * and fails with "Missing signing key for account C…". The only way to exercise a
 * custom account's `__check_auth` is to build the `SorobanAuthorizationEntry`
 * for the guard address yourself and sign its payload with the registered
 * agent key — which is what this module does, in TypeScript.
 *
 * ## What is signed
 *
 * The host hands `__check_auth` the SHA-256 digest of
 * `HashIdPreimage::SorobanAuthorization { network_id, nonce,
 * signature_expiration_ledger, invocation }`, and the guard verifies it with
 * `env.crypto().ed25519_verify(registered_agent_pubkey, digest, signature)`.
 * So the signature here is a raw 64-byte Ed25519 signature over that digest,
 * carried as `ScVal::Bytes` inside `SorobanAddressCredentials` — not the
 * `Vec[Map{public_key, signature}]` shape the SDK's `authorizeEntry` helper
 * produces for classic-account credentials.
 *
 * The nonce must never repeat for the guard address: the host records every
 * consumed nonce in ledger state and rejects replays. Strictly-increasing
 * transaction sequence numbers are unique per transaction and never reused, so
 * the sequence doubles as the nonce (same choice as the Phase 1 `agent-tx`
 * tool, which proved this path on-chain).
 *
 * ## Why there is an `AgentSigner` seam
 *
 * v1 registers exactly one Ed25519 agent key, so this module used to take a
 * bare `Keypair` and call `keypair.sign(digest)`. Contracts v2 will change the
 * guard's own `Signature` type to something multi-key (a threshold scheme),
 * and the SDK should absorb that without another breaking change to every
 * caller's config object. `AgentSigner` is the seam that allows it: the SDK
 * depends on "something that signs the authorization digest", not on
 * "something that is a `Keypair`". The single-key `Keypair` remains a valid
 * input everywhere, wrapped by `keypairAgentSigner` / `toAgentSigner` — the
 * current behaviour is unchanged, and multi-key support lands behind the same
 * interface when the contracts decision does. Research, options and the revisit
 * trigger: `docs/concepts/multi-key-agent-signing.md`.
 */
import { createHash } from "node:crypto";
import {
  Account,
  Address,
  Keypair,
  SorobanDataBuilder,
  StrKey,
  Transaction,
  TransactionBuilder,
  rpc,
  scValToNative,
  verify as verifyEd25519,
  xdr,
} from "@stellar/stellar-sdk";
import {
  BroadcastError,
  ContractResponseError,
  SigningError,
  SimulationError,
} from "./errors.ts";
import { NetworkMismatchError } from "./preflight.ts";
import { systemClock, type Clock } from "./clock.ts";
import type { ContractAddress } from "./policy.ts";

/**
 * A stellar network passphrase, e.g. `Networks.TESTNET` or `Networks.PUBLIC`.
 *
 * The interlock compares this against the passphrase the RPC reports for the
 * ledger it serves. It is a guardrail, not a sandbox: an RPC that lies about
 * its passphrase is not defended against.
 */
export type NetworkPassphrase = string;

/**
 * Shared network-interlock configuration for the entry surfaces
 * (`interceptor`, `invoke`, and the `tx` helpers).
 *
 * `expectedNetwork` is the passphrase the caller believes the RPC serves. When
 * set, the SD fetches the server's passphrase (at construction or first use)
 * and throws `NetworkMismatchError` unless it matches. When unset, behaviour is
 * exactly the legacy unchecked path — explicitly NOT recommended.
 */
export interface NetworkInterlockOptions {
  expectedNetwork?: NetworkPassphrase | undefined;
}

/** Extra ledger validity granted to a guard auth entry when it is signed. */
const SIG_EXPIRATION_LEGGERS = 10_000;
/** Inclusion fee floor, in stroops, for a single-operation transaction. */
const INCLUSION_FEE = "100";
const MAX_RESOURCE_FEE = 2n ** 64n - 1n ;

/**
 * Fetch the network passphrase the RPC serves and assert it matches
 * `expectedNetwork`.
 *
 * Returns the actual passphrase so callers can reuse it (e.g. to build
 * transactions) without a second round-trip. When `expectedNetwork` is
 * `undefined` the fetch is skipped entirely and `undefined` is returned, which
 * preserves the legacy unchecked behaviour byte-for-byte.
 */
export async function assertExpectedNetwork(
  server: rpc.Server,
  expectedNetwork: NetworkPassphrase | undefined,
): Promise<NetworkPassphrase | undefined> {
  if (expectedNetwork === undefined) return undefined;
  let actual: NetworkPassphrase;
  try {
    const info = await server.getNetwork();
    actual = info.passphrase;
  } catch (error) {
    throw new NetworkMismatchError(
      `could not fetch the server network passphrase to verify it matches the expected network`,
      { expected: expectedNetwork, actual: null, cause: error },
    );
  }
  if (actual !== expectedNetwork) {
    throw new NetworkMismatchError(
      `server network passphrase does not match the expected network: expected ${JSON.stringify(
        expectedNetwork,
      )}, got ${JSON.stringify(actual)}`,
      { expected: expectedNetwork, actual },
    );
  }
  return actual;
}

/**
 * Resolve the passphrase to use for signing/building, enforcing the interlock
 * when `expectedNetwork` is set.
 *
 * Callers that already know the passphrase (e.g. `networkPassphrase` on a
 * build helper) still get the interlock check when `expectedNetwork` is
 * supplied: the two must agree, and the server's reported passphrase must
 * agree with both.
 */
export async function resolveNetworkPassphrase(params: {
  server: rpc.Server;
  networkPassphrase: NetworkPassphrase;
  expectedNetwork?: NetworkPassphrase | undefined;
}): Promise<NetworkPassphrase> {
  const { server, networkPassphrase, expectedNetwork } = params;
  if (expectedNetwork !== undefined && expectedNetwork !== networkPassphrase) {
    throw new NetworkMismatchError(
      `configured networkPassphrase does not match the expected network: expected ${JSON.stringify(
        expectedNetwork,
      )}, got ${JSON.stringify(networkPassphrase)}`,
      { expected: expectedNetwork, actual: networkPassphrase },
    );
  }
  await assertExpectedNetwork(server, expectedNetwork);
  return networkPassphrase;
}

export interface ContractCall {
  /** Contract address (C…) to invoke. */
  contract: ContractAddress;
  /** Function name as it appears in the contract spec. */
  fn: string;
  args: xdr.ScVal[];
}

/**
 * Parse the RPC's simulation resource fee without allowing a missing or
 * malformed value to masquerade as a free transaction.
 *
 * Stellar SDK versions have surfaced this field as a decimal string, number,
 * or bigint. All three are accepted only when they are an exact non-negative
 * u64. A missing field is invalid, not zero: callers must report the simulation
 * as undetermined rather than make a budget decision from fabricated pricing.
 */
export function parseSimulationResourceFee(raw: unknown): bigint {
  let value: bigint;
  if (typeof raw === "bigint") {
    value = raw;
  } else if (typeof raw === "number" && Number.isSafeInteger(raw)) {
    value = BigInt(raw);
  } else if (typeof raw === "string" && /^\d+$/.test(raw)) {
    value = BigInt(raw);
  } else {
    throw new ContractResponseError(
      `simulation returned an invalid resource fee: ${JSON.stringify(raw)}`,
      { field: "minResourceFee" },
    );
  }

  if (value < 0n || value > MAX_RESOURCE_FEE) {
    throw new ContractResponseError(
      `simulation resource fee ${value} is outside the u64 range`,
      { field: "minResourceFee" },
    );
  }
  return value;
}

/** The guard's own persistent storage keys, as they exist in ledger state. */
export const GUARD_STORAGE_KEYS = [
  "Policy",
  "Window",
  "LastHeartbeat",
  "AdminFrozen",
] as const;

/** Stable identity for a ledger key, for de-duplicating footprint entries. */
function ledgerKeyId(key: xdr.LedgerKey): string {
  return Buffer.from(key.toXDR()).toString("base64");
}

export function addressToScVal(strkey: string): xdr.ScVal {
  return new Address(strkey).toScVal();
}

/**
 * Verify an Ed25519 agent-auth signature without accepting or deriving a
 * private key.
 *
 * `publicKey` accepts the registered account strkey (`G… ) or the raw 32-byte
 * public key stored by the contract. The Stellar SDK's low-level Ed25519
 * verifier is the same primitive used by `Keypair.verify` and the Stellar auth
 * path, so callers do not need a second cryptographic implementation.
 *
 * `payload` is verified exactly as supplied and is never re-hashed. The guard
 * verifies the host-provided 32-byte `HashIdPreimage` digest, so an integration
 * checking an auth entry must pass that same digest. Malformed keys, payloads that
 * are not 32 bytes, non-64-byte signatures, and verification failures all return
 * `false`; this diagnostic
 * helper does not throw for attacker-controlled input.
 */
export function verifyAgentSignature(
  publicKey: string | Uint8Array,
  payload: Uint8Array,
  signature: Uint8Array,
): boolean {
  try {
    const rawPublicKey =
      typeof publicKey === "string" ? StrKey.decodeEd25519PublicKey(publicKey) : publicKey;
    if (rawPublicKey.length !== 32 || payload.length !== 32 || signature.length !== 64) return false;
    return verifyEd25519(payload, signature, rawPublicKey);
  } catch {
    return false;
  }
}

export function invocationArgs(call: ContractCall): xdr.InvokeContractArgs {
  return new xdr.InvokeContractArgs({
    contractAddress: new Address(call.contract).toScAddress(),
    functionName: call.fn,
    args: call.args,
  });
}

/**
 * Ledger keys for the guard's own storage. A `contracttype` enum in Rust is a
 * vector of symbols on the wire (`DataKey::Policy` → `[Symbol("Policy")]`), so
 * the keys are built to match real ledger state rather than as bare symbols.
 */
export function guardStorageLedgerKeys(guard: string): xdr.LedgerKey[] {
  const contract = new Address(guard).toScAddress();
  const keys = GUARD_STORAGE_KEYS.map((name) =>
    xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract,
        key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name)]),
        durability: xdr.ContractDataDurability.persistent,
      }),
    ),
  );
  keys.push(
    xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract,
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent,
      }),
    ),
  );
  return keys;
}

export interface AdminSigner {
  /** Return public key (G...) of the admin */
  publicKey(): string | Promise<string>;
  /**
   * Sign a transaction envelope.
   * Accepts a Transaction and returns a signed Transaction or base64 XDR string.
   */
  signTransaction?(
    transaction: Transaction,
    options?: { networkPassphrase?: string },
  ): Promise<Transaction | string> | Transaction | string;
  /** Direct authorization entry signing hook */
  signAuthEntry?(
    entry: xdr.SorobanAuthorizationEntry,
    options: { signatureExpirationLedger: number; networkPassphrase: string },
  ): Promise<xdr.SorobanAuthorizationEntry>;
}

/**
 * The signing capability the guard's authorization needs — the seam that lets
 * N-key (or otherwise non-`Kheypair`) agent signing land without a second
 * breaking change (see the module header and
 * `docs/concepts/multi-key-agent-signing.md`).
 *
 * It is deliberately the *digest* that crosses this boundary, not the XDR
 * entry: the host hashes the authorization preimage and hands `__check_auth`
 * the 32-byte digest, so a signer never has to understand Soroban XDR to be
 * usable here. `signDigest` may return synchronously (a local key) or as a
 * promise (a remote/HSM-backed signer); `buildGuardAuthEntry` awaits it.
 */
export interface AgentSigner {
  /** The signer's public identity, for diagnostics and key matching. */
  readonly publicKey: string;
  /** Sign the 32-byte authorization digest. */
  signDigest(digest: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

/** Wrap a single `Keypair` as an `AgentSigner`. */
export function keypairAgentSigner(keypair: Keypair): AgentSigner {
  return {
    publicKey: keypair.publicKey(),
    signDigest: (digest) => keypair.sign(Buffer.from(digest)),
  };
}

/** Normalize a `Keypair` or `AgentSigner` into an `AgentSigner`. */
export function toAgentSigner(signer: Keypair | AgentSigner): AgentSigner {
  if (signer instanceof Keypair) return keypairAgentSigner(signer);
  return signer;
}

export interface BuildGuardAuthEntryParams {
  /** The guard contract address (C…). */
  guard: string;
  /** The invocation the authorization applies to. */
  call: ContractCall;
  /** The signer for the guard's agent key. */
  signer: Keypair | AgentSigner;
  /** Network passphrase the auth digest is bound to. */
  networkPassphrase: NetworkPassphrase;
  /** Nonce for the auth entry (typically the tx sequence). */
  nonce: bigint | string;
  /** Ledger at which the signature expires. */
  signatureExpirationLedger: number;
}

/**
 * Build and sign a `SorobanAuthorizationEntry` for the guard contract
 * address, using the agent signer's raw Ed25519 signature over the auth
 * digest.
 */
export async function buildGuardAuthEntry(
  params: BuildGuardAuthEntryParams,
): Promise<xdr.SorobanAuthorizationEntry> {
  const { guard, call, signer, networkPassphrase, nonce, signatureExpirationLedger } = params;
  const agent = toAgentSigner(signer);
  const invocation = xdr.SorobanAuthorizationInvocation.invokeContract(invocationArgs(call));
  const nonceBigInt = typeof nonce === "bigint" ? nonce : BigInt(nonce);
  const networkId = createHash("sha256").update(networkPassphrase).update(Buffer.from([0])).digest();
  const preimage = xdr.HashIdPreimage.sorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId,
      nonce: xdr.Uint64.fromString(nonceBigInt.toString()),
      signatureExpirationLedger: xdr.Uint32.fromString(String(signatureExpirationLedger)),
      invocation,
    }),
  );
  const digest = createHash("sha256").update(preimage.toXDR()).digest();
  const signature = new Uint8Array(await agent.signDigest(new Uint8Array(digest)));
  const credentials = new xdr.SorobanAddressCredentials({
    address: new Address(guard).toScAddress(),
    signatureExpirationLedger: xdr.Uint32.fromString(String(signatureExpirationLedger)),
    signature: xdr.ScVal.scvBytes(Buffer.from(signature)),
  });
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanAuthorizationCredentials.sorobanAddressCredentials(credentials),
    rootInvocation: invocation,
  });
}

export interface BuildInvokeTxParams {
  /** RPC server to simulate and submit against. */
  server: rpc.Server;
  /** Source account for the transaction (G…). */
  source: string;
  /** The guard contract address (C… . */
  guard: string;
  /** The contract call to invoke. */
  call: ContractCall;
  /** Signer for the guard's agent key. */
  signer: Keypair | AgentSigner;
  /** Network passphrase to build and sign for. */
  networkPassphrase: NetworkPassphrase;
  /** Optional expected-network interlock. */
  expectedNetwork?: NetworkPassphrase | undefined;
  /** Clock for deterministic testing. */
  clock?: Clock;
}

/**
 * Build a guarded invoke transaction, attaching the guard's signed auth
 * entry. The network interlock is enforced when `expectedNetwork` is set.
 */
export async function buildInvokeTx(params: BuildInvokeTxParams): Promise<Transaction> {
  const { server, source, guard, call, signer, networkPassphrase, expectedNetwork } = params;
  await resolveNetworkPassphrase({ server, networkPassphrase, expectedNetwork });

  const account = await server.getAccount(source);
  const sequence = BigInt(account.sequenceNumber());
  const tx = new TransactionBuilder(new Account(source, account.sequenceNumber()), {
    fee: INCLUSION_FEE,
    networkPassphrase,
  })
    .addOperation(
      new Address(call.contract).toScAddress() && buildInvokeOp(call),
    )
    .setTimeout(TransactionBuilder.TimeoutInfinite);

  const authEntry = await buildGuardAuthEntry({
    guard,
    call,
    signer,
    networkPassphrase,
    nonce: sequence,
    signatureExpirationLedger: 0,
  });
  tx.addSorobanAuth(authEntry);
  return tx.build();
}

function buildInvokeOp(call: ContractCall): xdr.Operation {
  return xdr.Operation.invokeContract(
    new xdr.InvokeContractOp({
      contractAddress: new Address(call.contract).toScAddress(),
      functionName: call.fn,
      args: call.args,
    }),
  );
}
