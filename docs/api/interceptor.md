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
| `guard` | `ContractAddress` (`C...`) | required | The guarded smart account whose policy is enforced. |
| `agent` | `AgentSigner \| Keypair` | required | Key registered as the account's agent; signs the auth entry. |
| `source` | `Keypair` | required | Classic account that pays fees and supplies the sequence number. |
| `accountSigners` | `Keypair[]` | `undefined` (none) | Authorizers for non-guard requirements (e.g. an admin on a policy call). |
| `policy` | `ReadonlyPolicyConfig \| null` | `undefined` (fetched from the ledger) | Policy to use for batch staging. |
| `cache` | `PreFlightCacheOptions` | `undefined` (disabled) | Opt-in short-lived verdict cache. ⚠ Enabling the cache means a verdict may be stale relative to the current ledger/policy state. |
| `logger` | `GuardLoggerInput` | `undefined` (silent) | Log sink for each verdict and every cache hit/store/invalidation. |
| `clock` | `Clock` | system clock | Injectable clock for cache TTL; use a `FakeClock` in tests. |

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
