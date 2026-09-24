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
