# PreFlightInterceptor API

PreFlightInterceptor evaluates whether a planned contract call will be accepted by the guard contract.

## Constructor

```ts
constructor(options: PreFlightInterceptorOptions)
```

### Options

- `server: rpc.Server` — Soroban RPC server instance
- `networkPassphrase: string` — Stellar network passphrase
- `expectedNetwork?: NetworkPassphrase | 'testnet' | 'mainnet' | 'futurenet'` — Optional network interlock. When set, the interceptor fetches the server's network passphrase at construction (first use) and fails with a typed `NetworkMismatchError` unless it matches. Default: `undefined` = unchecked. **NOT recommended** — leaving this unset means a misconfigured RPC URL (testnet key + testnet RPC, or the reverse) will not be caught by the interlock. The README Quick Start passes `expectedNetwork`.
- `guard: string` — Custom account contract address (`C...`)
- `agent: Keypair` — Keypair registered as the agent in the guard
- `source: Keypair` — Keypair paying for transaction fees
- `cache?: PreFlightCacheOptions` — Optional short-lived verdict cache; disabled by default

### Optional cache

Set either `cache.ttlMs` or `cache.ttlLedgers` to opt in. The effective TTL is
capped at one approximate five-second ledger-close interval, and a cached entry
is discarded when the observed ledger advances. `policyRevision` may be a value
or an async getter; changing it invalidates the matching entry. Call
`invalidate(call?)` after policy or account-state changes. A cached verdict can be
staler than one admitted transfer, so callers must accept that tradeoff
explicitly.

### Network interlock

When `expectedNetwork` is set, the interceptor fetches the server's network
passphrase at construction (or first use) and fails with a typed `NetworkMismatchError`
unless it matches. The error names both the expected and actual passphrases. The
option accepts either a full `NetworkPassphrase` string or the short aliases
`'testnet'`, `'mainnet'`, or `'futurenet'`. The same option is shared across
the interceptor, `invoke`, and transaction builder entry surfaces.

Leaving `expectedNetwork` unset preserves legacy behavior exactly: no network
check is performed. This is explicitly not recommended.

> Limitation: the network interlock is a guardrail, not a sandbox — an RPC
> lying about its passphrase isn't defended.

## Methods

### `check(call: ContractCall): Promise<PreFlightDecision>`

Evaluates a contract call against the guard without throwing or broadcasting.

### `invalidate(call?: ContractCall): void`

Clears all cached decisions, or only the entries for the supplied call.

### `assertAllowed(call: ContractCall): Promise<AdmissibleDecision>`

Evaluates a call and throws `GuardBlockedError` if blocked or undetermined.
