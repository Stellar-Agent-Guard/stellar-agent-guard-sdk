# PreFlightInterceptor API

`PreFlightInterceptor` evaluates whether a planned contract call will be accepted by the guard contract.

## Constructor

```ts
constructor(options: PreFlightInterceptorOptions)
```

### Options

| Option | Type | Default | Semantics |
| --- | --- | --- | --- |
| `server` | `rpc.Server` | required | Soroban RPC server instance used for simulation. |
| `networkPassphrase` | `string` | required | Stellar network passphrase (testnet: `"Test SDF Network ; September 2015"`). |
| `guard` | `string` | required | Custom account contract address (`C...`). |
| `agent` | `Keypair` | required | Keypair registered as the agent in the guard. |
| `source` | `Keypair` | required | Keypair paying for transaction fees. |
| `cache` | `PreFlightCacheOptions` | undefined (disabled) | Optional short-lived verdict cache. ⚠ Enabling the cache means a verdict may be stale relative to the current ledger/policy state. |

### Optional cache

Set either `cache.ttlMs` or `cache.ttlLedgers` to opt in. The effective TTL is
capped at one approximate five-second ledger-close interval, and a cached entry
is discarded when the observed ledger advances. `policyRevision` may be a value
or an async getter; changing it invalidates the matching entry. Call
`invalidate(call?)` after policy or account-state changes. A cached verdict can
be staler than one admitted transfer, so callers must accept that tradeoff
explicitly.

## Methods

### `check(call: ContractCall): Promise<PreFlightDecision>`

Evaluates a contract call against the guard without throwing or broadcasting.

### `invalidate(call?: ContractCall): void`

Clears all cached decisions, or only the entries for the supplied call.

### `assertAllowed(call: ContractCall): Promise<AdmissibleDecision>`

Evaluates a call and throws `GuardBlockedError` if blocked or undetermined.
