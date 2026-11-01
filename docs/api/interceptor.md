# PreFlightInterceptor API

`PreFlightInterceptor` evaluates whether a planned contract call will be accepted by the guard contract.

## Constructor

```ts
constructor(options: PreFlightInterceptorOptions)
```

### Options

#### `PreFlightInterceptorOptions` (alias of `PreFlightConfig`)

`new PreFlightInterceptor(options)`. Validated at construction: a `cache` without `ttlMs`/`ttlLedgers`, or with a non-positive value, throws a `TypeError`.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `server` | `rpc.Server` | required | Soroban RPC used for every ledger read and simulation. |
| `networkPassphrase` | `string` | required | Network the probe and enforced envelopes are built and signed for. Part of the cache and coalescing key. |
| `guard` | `ContractAddress` (`C…`) | required | The guarded smart account whose policy is enforced. |
| `agent` | `AgentSigner \| Keypair` | required | The key registered as the account's agent; signs the guard auth entry. A plain `Keypair` is the single-key default. |
| `source` | `Keypair` | required | Classic account that pays fees and supplies the sequence number. |
| `accountSigners` | `Keypair[]` | none | Authorizers for non-guard auth requirements (e.g. an admin on a policy call). |
| `policy` | `ReadonlyPolicyConfig \| null` | none — `checkBatch()` reads the `Policy` ledger entry | Used **only** for `checkBatch()` staging; `check()` always enforces through simulation. ⚠️ A supplied policy is trusted as-is: a stale snapshot makes batch window staging use outdated caps. An explicit `null` means "no policy to stage against", not a failed read. |
| `cache` | `PreFlightCacheOptions` | none — no cache; every `check()` simulates fresh | ⚠️ Opt-in. A cached verdict can be staler than one admitted transfer, so a hit can report `admissible` for a call the next simulation would block. See the cache table below. |
| `coalesceInFlight` | `boolean` | `true` | Concurrent identical `check()` calls share one in-flight run; the shared run keeps `DEFAULT_RPC_TIMEOUT_MS` (30 000 ms) and each waiter still applies its own `signal`/`timeoutMs`. The entry is dropped as soon as the run settles (it is not a cache). Checks that pass `onStep` are never coalesced. `false`: every call runs its own simulation (more RPC load, same verdicts). |
| `logger` | `GuardLoggerInput` | none — silent (`SILENT_LOGGER`) | Log sink for verdicts and cache hits/stores/invalidations. A logger never changes a verdict. |
| `clock` | `Clock` | `systemClock` | Time source for cache TTL expiry. ⚠️ A fake or skewed clock outside tests changes when cached verdicts expire. |

#### `PreFlightCacheOptions` (`options.cache`)

Present only when you opt in. Entries are also discarded whenever the observed ledger advances, so a hit never crosses a ledger boundary. Call `invalidate(call?)` after a policy or account-state change.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `ttlMs` | `number` | none — one of `ttlMs` / `ttlLedgers` is required | Maximum cache age in ms; positive and finite. Capped at 5 000 ms (one approximate ledger close). Takes precedence over `ttlLedgers` when both are set. ⚠️ Any TTL means a verdict may be up to that old. |
| `ttlLedgers` | `number` | none | Ledger spelling of `ttlMs` (× 5 000 ms), same 5 000 ms cap; positive and finite. |
| `policyRevision` | `PolicyRevision \| () => PolicyRevision \| Promise<PolicyRevision>` | none — the revision is not part of the key | Value or getter mixed into the cache key, so a policy change invalidates entries before the TTL elapses. ⚠️ Without it, a policy change inside the TTL is not seen until expiry, the next ledger, or `invalidate()`. A getter that throws or returns `undefined` bypasses the cache for that check (fresh simulation), never a reused verdict. |
| `maxEntries` | `number` (positive integer) | none — unbounded | Least-recently-used eviction once full. Eviction only removes entries, so it can never return an expired or cross-ledger verdict. Unbounded means memory grows with the number of distinct calls. |

#### `PreFlightCheckOptions` (`check(call, options)`)

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `onStep` | `(step: InvokeStepEvent) => void` | none | One event per enforcement-stage attempt (probe → sign → simulate). Supplying it opts this check out of coalescing. |
| `signal` | `AbortSignal` | none | ⚠️ Caller cancellation. An already-aborted signal returns before any RPC; a fired signal returns the fail-closed `undetermined` verdict carrying `RpcTimeoutError`, never a throw and never `admissible`. |
| `timeoutMs` | `number` | `DEFAULT_RPC_TIMEOUT_MS` (30 000 ms) per RPC call | ⚠️ A fired timeout returns the same fail-closed `undetermined` verdict as an abort. `0` disables the per-call timeout: with no `signal`, a stalled RPC can then hold the check open. |

#### `CheckBatchOptions` (`checkBatch()` / `assertBatchAllowed()`)

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `policy` | `ReadonlyPolicyConfig \| null` | the constructor's `policy`; if that is absent too, a live read of the `Policy` ledger entry | Policy the batch is staged against. ⚠️ A failed or malformed read is never treated as "no cap": any positive SAC transfer in the batch becomes `undetermined`. |
| `initialWindowSpent` | `bigint` | a live read of the `Window` ledger entry; `0n` only when that entry does not exist | Committed spend already in the window. An explicit value (including `0n`) is a trusted caller snapshot. ⚠️ A failed read is not treated as zero: transfers that need it become `undetermined`. |
| `onStep` | `(step: InvokeStepEvent) => void` | none | Forwarded to each call's `check()`. |
| `signal` | `AbortSignal` | none | ⚠️ Forwarded to each call's `check()`: once it fires, every remaining call returns a fail-closed `undetermined` verdict without issuing an RPC. It does **not** bound the initial `Policy`/`Window` ledger reads; supply `policy` and `initialWindowSpent` to avoid them. |
| `timeoutMs` | `number` | `DEFAULT_RPC_TIMEOUT_MS` (30 000 ms), per call | Forwarded to each `check()`; a fired timeout makes that call `undetermined` and the batch continues. |
| `deadlineMs` | `number` | none | Validated (must be positive and finite, otherwise `RangeError`). ⚠️ **Not currently enforced** in `checkBatch()`: the value is checked but no overall budget is applied. Bound a batch with `signal` (e.g. `AbortSignal.timeout(ms)`) and `timeoutMs` until it is. |

### Optional cache

Set either `cache.ttlMs` or `cache.ttlLedgers` to opt in. The effective TTL is
capped at one approximate five-second ledger-close interval, and a cached entry
is discarded when the observed ledger advances. `policyRevision` may be a value
or an async getter; changing it invalidates the matching entry. Call
`invalidate(call?)` after policy or account-state changes. A cached verdict can
be staler than one admitted transfer, so callers must accept that tradeoff
explicitly. Every verdict the cache hands out is an **independent snapshot**:
editing a returned decision — the `allowed`/`kind` discriminant, a scalar such
as `estimatedResourceFee`, or a nested `diagnosticEvents` entry — cannot change
what a later cache hit receives. Snapshots, not frozen objects: a caller that
edits what it was handed still gets no error, it simply edits its own copy.

`maxEntries` bounds how many verdicts the cache retains. When the cache is full,
storing a new call fingerprint evicts the least-recently-used entry; a hit counts
as use, so the eviction order is deterministic. Eviction only removes entries —
lookups still require a current-ledger, unexpired entry — so a bounded cache
never returns an expired or cross-ledger verdict. Omit `maxEntries` for an
unbounded cache.

## Methods

### `check(call: ContractCall): Promise<PreFlightDecision>`

Evaluates a contract call against the guard without throwing or broadcasting.

### `invalidate(call?: ContractCall): void`

Clears all cached decisions, or only the entries for the supplied call.

### `assertAllowed(call: ContractCall): Promise<PreFlightDecision & { allowed: true }>`

Evaluates a call and returns the decision if admissible, or throws `GuardBlockedError` if blocked and `GuardUndeterminedError` if undetermined or on transport failure. Raw transport errors never escape.

### `checkBatch(calls: ContractCall[], options?: CheckBatchOptions): Promise<PreFlightBatchDecision>`

Evaluates a sequence of calls with the guard's all-or-nothing semantics. Every
call is simulated independently, and positive SAC transfer amounts are staged
against the rolling `window_cap`. A call that passes alone but would push the
cumulative staged spend over the cap is reported as `blocked` with reason
`window_cap_exceeded`; a refusal or undetermined result from any member makes
the batch inadmissible.

Staging state is fail-closed:

- `options.initialWindowSpent` (including an explicit `0n`) is a trusted caller
  snapshot and avoids the ledger read.
- An absent `Window` ledger entry means zero committed spend, not a failed read.
- A failed policy or window RPC read leaves the state unknown. When a positive
  transfer needs that state, the affected verdicts are `undetermined` and the
  batch `kind` is `undetermined`; the SDK never stages against an assumed zero.
- The returned `staging` field records the snapshot: `source` is
  `provided | ledger | absent | unavailable`, `windowSpent` is `null` when
  required state could not be read, and `unavailable` says whether staging was
  blocked. It is omitted for an empty batch or when no snapshot was resolved.

Non-transfer calls and policies with a zero cap do not require the window
snapshot and are unaffected by an unavailable read.

### `assertBatchAllowed(calls: ContractCall[], options?: CheckBatchOptions): Promise<PreFlightBatchDecision & { admissible: true }>`

The throw-on-refusal form: returns the batch decision if all calls are admissible, or throws `GuardBlockedError` for the first blocked
member, or `GuardUndeterminedError` for an undetermined member, an
unavailable staging state, or transport failure.

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
| `assertAllowed` | `GuardUndeterminedError` | When `CheckResult` cannot be decoded, `assertAllowed` throws `GuardUndeterminedError` with cause preserved. |

In other words, a malformed or future `CheckResult` never escapes to the agent
loop as a raw throw. The interceptor treats any decode failure as
`undetermined`, which is the fail-closed result.
