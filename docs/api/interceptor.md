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

## CheckResult decoding and fallback behavior

The interceptor reads the guard contract's `CheckResult` value from the
simulation response. The contract returns an enum with the following shapes:

- `Allowed` — a unit variant with no payload.
- `Blocked(reason)` — a variant carrying a symbol reason (e.g. `recipient_not_allowed`,
  `per_tx_cap_exceeded`, `paused`).

`decodeCheckResult` accepts either the raw `xdr.ScVal` the contract returns
(for example `simulation.returnValue`) or the native value `scValToNative`
produces from it, and validates a `Blocked` reason against the contract's own
reason vocabulary.

Decoding is fail-closed. If the returned ScVal is not a recognized
`CheckResult` shape — an unknown enum tag, a `Blocked` reason the contract does
not define, an empty or over-long `ScVec`, a blocked variant whose reason is not
a symbol, or a non-`ScVec` input — the decoder does not throw. Instead it
returns the typed fallback for the call-site contract:

| Call site | Fallback verdict | Notes |
| --- | --- | --- |
| `PreFlightInterceptor.check` | `undetermined` with `null` reason | The caller sees a typed decision, not an exception. |
| `assertAllowed` | `GuardBlockedError` with an `undetermined` verdict | The error is thrown by the caller-facing assertion, not by the decoder. |

In other words, a malformed or future `CheckResult` never escapes to the agent
loop as a raw throw. The interceptor treats any decode failure as
`undetermined`, which is the fail-closed result.
