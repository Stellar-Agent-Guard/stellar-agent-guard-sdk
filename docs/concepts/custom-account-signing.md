# Custom Account Signing

Soroban Custom Accounts implement the `CustomAccountInterface`. The contract itself is the address authorizing transactions.

Standard wallets sign transaction envelopes for public key accounts (`G...`). For a custom account (`C...`), the transaction requires a `SorobanAuthorizationEntry` with `AddressCredentials` containing a signature valid for the contract's registered agent key.

The SDK's `invoke()` pipeline manages:
1. Probe simulation to detect necessary authorization entries.
2. Building `SorobanAuthorizationEntry` credentials.
3. Signing auth entries with the agent's signer.
4. Second simulation with attached credentials.
5. Final envelope signing with fee-source keypair and submission.

## The signer seam

Step 3 signs the 32-byte digest the host hands `__check_auth`, and the SDK
depends on that boundary rather than on a concrete key type:

```ts
interface AgentSigner {
  readonly publicKey: string;
  signDigest(digest: Uint8Array): Uint8Array | Promise<Uint8Array>;
}
```

A plain `Keypair` is accepted anywhere an `AgentSigner` is (`PreFlightConfig.agent`,
`GuardAuthorization.agent`, `buildGuardAuthEntry({ signer })`) and is wrapped
automatically — `keypairAgentSigner` / `toAgentSigner` — so single-key callers
are unchanged. This is the seam multi-key agent signing will use when the
contracts repo's v2 decision lands; see
[Multi-Key Agent Signing](multi-key-agent-signing.md).

## Validating the signer identity

The SDK validates `AgentSigner.publicKey` before it is ever used. Two verify-only
forms are supported:

- the registered account StrKey, `G…`, including its version byte and checksum;
- the raw 32-byte Ed25519 public key encoded as 64 hexadecimal characters (the
  form the guard contract stores). A hex key is normalised to its equivalent
  `G…` StrKey for diagnostics.

Validation runs when a signer is adapted (`keypairAgentSigner` / `toAgentSigner`)
and again at the signing boundary (`buildGuardAuthEntry`, and before any RPC in
`enforceCall`). A bad configuration therefore fails with a `SigningError` naming
`signer.publicKey`, before the signer is invoked or a simulation is made, rather
than surfacing later as an opaque `__check_auth` failure.

Secret seeds (`S…`) are explicitly rejected and are never used to derive a
public key. Supply the public identity only; a local `Keypair` still works by
being wrapped, and the `AgentSigner` it produces exposes just the public key
and a `signDigest` function.

```ts
import { Keypair, keypairAgentSigner, validateAgentPublicKey } from "stellar-agent-guard-sdk";

const local = keypairAgentSigner(Keypair.random()); // validated at construction
validateAgentPublicKey(local.publicKey);             // returns the G… form
validateAgentPublicKey(local.publicKey.slice(0, -1) + "A"); // throws SigningError
```
