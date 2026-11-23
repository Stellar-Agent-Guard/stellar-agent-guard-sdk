# Migration Guide: 0.1.x → 0.2.0

This guide is for a contributor or integrator upgrading a **production**
integration from `0.1.x` (the published `0.1.0` / tagged `v0.1.1`) to `0.2.0`.
The [0.1.x → 0.2 upgrade checklist](#01x--02-upgrade-checklist) below is the
ordered procedure; the sections after it are the detailed reference for the
largest single change, [branded address types](#branded-address-types), and
for [telemetry records](#telemetry-records-explicit-versioning-issues-322-323).

Per the [0.x deprecation policy](docs/deprecations.md), a minor boundary
(`0.1.x` → `0.2.0`) is where breaking changes are allowed; see also
[versioning policy](docs/releasing.md#versioning-policy). The full change list
is the `[Unreleased]` section of [`CHANGELOG.md`](CHANGELOG.md).

## 0.1.x → 0.2 upgrade checklist

Work top to bottom: each step is safe to land on its own, and the order is
chosen so that compile errors surface before behaviour changes, and behaviour
changes are verified before you widen any bound.

**Legend.** **Breaking** — code that compiled and behaved one way on `0.1.x`
either fails to compile or behaves differently on `0.2.0`. **Additive** — new
surface; nothing changes unless you opt in. **Min version** is the first
release that contains the change; every item here is new in `0.2.0`, so an
integration that needs any of them must pin at least `~0.2.0`.

The search commands are codemod-style starting points: run them from your
repository root (they need `grep -E` and skip `node_modules`/`dist`), review each
hit, and change it by hand. `FILES` is the file pattern each step names.

```bash
# helper used by the search commands below
sag_grep() { grep -rnE --include='*.ts' --include='*.tsx' --include='*.js' \
  --include='*.mjs' --include='*.cjs' --exclude-dir=node_modules --exclude-dir=dist "$@" . ; }
```

### Removed and renamed symbols

No root export was removed between `v0.1.1` and `0.2.0` (checked by diffing the
export lists of `src/index.ts` at the tag and on `main`). One symbol was
renamed, with the old name kept as an alias:

| 0.1.x symbol | 0.2.0 symbol | Status | Breaking? |
| --- | --- | --- | --- |
| `PreFlightUndeterminedError` (class extending `Error`) | `GuardUndeterminedError` (class extending `GuardError`) | Renamed; `PreFlightUndeterminedError` remains exported as an alias of the same class | **Breaking** only for code that compares `error.name === "PreFlightUndeterminedError"` or matches that string in logs: `name` is now `"GuardUndeterminedError"`. `instanceof PreFlightUndeterminedError` keeps working. |

Nothing has been deprecated yet: the
[deprecation tracking table](docs/deprecations.md#deprecation-tracking-table)
is empty, so there is no `@deprecated` removal to handle in this upgrade.

### Step 1 — Install and pin

- [ ] **Breaking (range).** `^0.1.0` does **not** resolve to `0.2.0` (npm's 0.x
      caret stops at the minor). Change the dependency to `~0.2.0`.
      `FILES`: `package.json`, your lockfile.

      ```bash
      npm install stellar-agent-guard-sdk@~0.2.0
      npm ls stellar-agent-guard-sdk        # exactly one copy, 0.2.x
      ```

- [ ] Confirm the runtime: Node `>=24` (`engines.node`), ESM only. Unchanged
      from 0.1.x, but re-check CI images. See
      [runtime support](docs/runtime-support.md).

### Step 2 — Branded address types (compile-time)

- [ ] **Breaking (types)**, min version `0.2.0`. Guard, asset, protocol and
      recipient fields are now `ContractAddress` / `AccountAddress` instead of
      `string`. Validate external input with `isContractAddress()` /
      `isAccountAddress()`; reserve `unsafeContractAddress()` /
      `unsafeAccountAddress()` (or `as ContractAddress`) for vetted constants.
      Full detail: [branded address types](#branded-address-types).
      `FILES`: every file that builds a `PreFlightConfig`, `ContractCall`,
      `PolicyConfig`, or calls `build*Call()`.

      ```bash
      sag_grep 'guard:|contract:|recipients:|assets:|blocked_recipients:|build(SetPolicy|Freeze|Unfreeze|RotateAgentKey)Call'
      npx tsc --noEmit                     # every remaining site is now a type error
      ```

### Step 3 — Renamed export and typed errors

- [ ] **Breaking (string match only)**, min version `0.2.0`. Replace
      `PreFlightUndeterminedError` with `GuardUndeterminedError` and replace any
      `error.name` / log-text match with an `instanceof` check.
      `FILES`: `**/*.{ts,tsx,js,mjs,cjs}`, plus log-alert rules and dashboards
      that match the string.

      ```bash
      sag_grep 'PreFlightUndeterminedError'
      sag_grep "\.name ?===? ?['\"](PreFlightUndeterminedError|GuardBlockedError)['\"]"
      ```

- [ ] **Additive**, min version `0.2.0`. Every operational error now extends
      `GuardError` (`GuardBlockedError` included), and invalid input is an
      `InvalidInputError` (a `TypeError`). Where you used `catch (e) { … }` with
      message matching, branch on the class instead. Each class has an entry in
      [troubleshooting: error classes](docs/troubleshooting.md#error-classes).
      `FILES`: `**/*.{ts,tsx,js,mjs,cjs}`.

      ```bash
      sag_grep "\.message\.(includes|startsWith|match)\("
      ```

### Step 4 — `invoke()` outcomes and dry-run

- [ ] **Breaking (behaviour)**, min version `0.2.0`. `invoke({ dryRun: true })`
      no longer returns the success sentinel `kind: "error"` with a
      `"dry run: …"` detail; it returns `kind: "dry_run"` with the full
      pre-broadcast result. Code that treated that `error` as success must
      switch on `"dry_run"`. `FILES`: callers of `invoke()` / `submit*()` that
      pass `dryRun`.

      ```bash
      sag_grep 'dryRun|dry run:'
      ```

- [ ] **Breaking (types)**, min version `0.2.0`. `InvokeOutcome` gained the
      `pending` arm (accepted by the network, not confirmed within the polling
      budget) and `dry_run`. An exhaustive `switch (outcome.kind)` with a
      `never` check stops compiling until both are handled. **Never rebroadcast
      a `pending` outcome** — reconcile with `getTransaction(transactionHash)`.
      See [the pending outcome](docs/api/invoke-pipeline.md#the-pending-outcome-accepted-not-confirmed).
      `FILES`: every `switch`/`if` over `outcome.kind`.

      ```bash
      sag_grep 'outcome\.kind|\.kind ?===? ?["'"'"'](allowed|blocked|error)'
      ```

- [ ] **Additive**, min version `0.2.0`. The `error` arm now carries a typed
      `error: GuardError`, `retry` metadata and, after a broadcast,
      `transactionHash`. Start logging them.

### Step 5 — Fee-bump and fee-ceiling bounds

- [ ] **Breaking (behaviour)**, min version `0.2.0`. `invoke()` now retries a
      `min_fee` rejection with a fee bump by default
      (`feeBump: { maxAttempts: 3, feeMultiplier: 2 }`), and retries
      stale-ledger and sequence-collision failures inside one budget;
      `maxRetries` bounds the total attempts for **every** retryable class. Set
      `feeBump` and `maxRetries` explicitly so the spend envelope is a decision,
      not a default. See [fee-bump configuration](docs/api/invoke-pipeline.md#fee-bump-configuration-feebump).
      `FILES`: callers of `invoke()` and the admin `submit*()` helpers.

      ```bash
      sag_grep 'invoke\(|submit(SetPolicy|Freeze|Unfreeze|RotateAgentKey)\('
      ```

- [ ] **Additive (new options, validated eagerly)**, min version `0.2.0`.
      `retry`, `maxRetries`, `feeBump`, `pollAttempts`/`pollIntervalMs`,
      `timeoutMs` and `deadlineMs` are new on `invoke()` and are validated
      before any RPC: a bad or contradictory value throws a field-specific
      `RangeError` at the first call rather than being clamped. See
      [option validation](docs/api/invoke-pipeline.md#option-validation).

- [ ] **Breaking (validation)**, min version `0.2.0`. `CostPreChecker`'s
      `maxFeeStroops` (configured and per-call) must be a non-negative
      `bigint`; a `number`, string or negative value that 0.1.x accepted now
      throws `InvalidFeeCeilingError` before any simulation. `0n` is a real
      zero ceiling; omit the option for none.

- [ ] **Additive**, min version `0.2.0`. Add a hard spend ceiling to
      `invoke()` with `maxFeeCap` (raises `FeeCapExceededError` before
      broadcast). `FILES`: `new CostPreChecker(` and `invoke(` call sites.

      ```bash
      sag_grep 'maxFeeStroops|maxFeeCap|new CostPreChecker\('
      ```

### Step 6 — RPC timeouts and concurrency

- [ ] **Breaking (behaviour)**, min version `0.2.0`. RPC calls are bounded by
      default: `timeoutMs` defaults to `DEFAULT_RPC_TIMEOUT_MS` (30s) instead
      of waiting forever, and a fired bound is a fail-closed `undetermined`
      verdict / `error` outcome carrying `RpcTimeoutError`. Pass `timeoutMs: 0`
      only if you deliberately want the old unbounded behaviour.
      `FILES`: `PreFlightInterceptor`, `CostPreChecker`, `invoke()` call sites.

- [ ] **Breaking (behaviour)**, min version `0.2.0`. `PreFlightInterceptor`
      queues simulations behind `maxConcurrentSimulations` (default 4) and
      handles one HTTP 429 with a bounded backoff; a persistent 429 is
      `undetermined` with `cause: "rate_limited"` (`RateLimitedError`). Raise
      the limit only if your RPC allows it. `FILES`: `new PreFlightInterceptor(`.

      ```bash
      sag_grep 'new PreFlightInterceptor\(|timeoutMs|maxConcurrentSimulations'
      ```

### Step 7 — Framework adapter payloads

- [ ] **Breaking (behaviour)** for the LangChain and ElizaOS adapters that
      shipped in 0.1.x, min version `0.2.0`. Adapter options are
      validated at construction and a bad option throws `AdapterConfigError`
      before the first tool call. A `toContractCall` that throws or returns a
      malformed call is now a fail-closed `undetermined` halt with
      `AdapterMappingError` as the cause (LangChain: error `ToolMessage`;
      ElizaOS: `validate` returns `false`; Vercel AI: throws
      `GuardUndeterminedError`). Returning `null` still means "not
      fund-moving". `FILES`: files calling `createLangChainGuardMiddleware`,
      `createGuardValidator`, `guardAction`, `guardMcpToolHandler`,
      `createVercelAIGuard`.

      ```bash
      sag_grep 'createLangChainGuardMiddleware|createGuardValidator|guardAction|guardMcpToolHandler|createVercelAIGuard'
      ```

- [ ] **Additive**, min version `0.2.0`. The MCP (`guardMcpToolHandler`,
      `guardMcpCallTool`) and Vercel AI (`createVercelAIGuard`) adapters are
      new, and `toContractCalls` (batch), `onBlocked`, `blockedHookLogger`,
      `signal` and `timeoutMs` are new options on every adapter. Observer hooks (`onDecision`, `onBlocked`) are isolated: a
      throwing hook can no longer resume or block an action. See
      [framework adapters](docs/api/framework-adapters.md).

### Step 8 — Telemetry cursor stores and listener behaviour

- [ ] **Additive**, min version `0.2.0`. `GuardTelemetryListener` accepts a
      `cursorStore` (and `failedTxCursorStore`) to persist progress across
      restarts. `CursorStore.save(cursor, scope?)` / `load(scope?)` receive a
      `CursorStoreScope` of `{ network, guard, stream }`. A store shared by
      several listeners **must key records by that scope**; a two-method store
      that ignores it keeps a single slot, which is only safe for one
      listener, one guard, one stream. `FILES`: your `CursorStore`
      implementation(s).

      ```bash
      sag_grep 'implements CursorStore|cursorStore:|failedTxCursorStore:'
      ```

- [ ] **Breaking (behaviour)**, min version `0.2.0`. `poll()` re-checks the
      emitting `contractId` and drops (and counts) events from another or an
      unidentified contract, and a second concurrent `watch()` on one
      listener throws `ConcurrentTelemetryStreamError`. (`watchAll()`,
      `recent()` and the listener's counters and health snapshot are new in
      0.2.0.) See
      [`poll()` contract identity](#poll-now-validates-emitting-contract-identity)
      and [telemetry listener](docs/api/telemetry-listener.md).
      `FILES`: files constructing `GuardTelemetryListener`.

      ```bash
      sag_grep 'new GuardTelemetryListener\(|\.watch(All)?\(|\.recent\('
      ```

- [ ] **Additive**, min version `0.2.0`. Persisted event lines can opt in to
      the versioned envelope (`serializeEventRecord()` /
      `parseEventRecord()`); bare `serializeEvent()` lines still parse. See
      [telemetry records](#telemetry-records-explicit-versioning-issues-322-323).

### Step 9 — Heartbeat

- [ ] **Additive**, min version `0.2.0`. 0.1.x had no heartbeat API; agents
      kept the dead-man switch alive with the contracts repo's `agent-tx`
      binary, which still works. `heartbeat()` and `startHeartbeat()` sign and
      submit natively. If you adopt them: an interval above `grace / 3` throws
      `HeartbeatIntervalError` before the first beat, a **refused** beat is
      reported as `HeartbeatBlockedError` through `onError` (never counted),
      and `onError` must alert. See
      [running an agent 24/7](docs/agent-runtime.md#1-keep-the-dead-man-switch-alive).
      `FILES`: your heartbeat scheduler (cron, systemd timer, or process loop).

      ```bash
      sag_grep 'startHeartbeat\(|heartbeat\(|onError'
      ```

### Verify after upgrade

Run these gates in the integration repository after every step above has
landed (they are the same gates the SDK itself uses in
[releasing](docs/releasing.md#pre-flight-gates-any-contributor-can-run-these)):

```bash
npm ci
npx tsc --noEmit                 # your project's type-check: no address/outcome type errors
npm run lint                     # or your linter
npm test                         # your unit suite
```

Then prove the guard still fails closed against a **testnet** deployment
before touching production:

- [ ] A call your policy refuses (for example a recipient off the allowlist)
      returns `kind: "blocked"` from `check()` and is never executed.
- [ ] With the RPC unreachable (point `server` at a closed port), `check()`
      returns `kind: "undetermined"` carrying `RpcTimeoutError` or a
      `SimulationError` — never `admissible`.
- [ ] `invoke({ dryRun: true })` returns `kind: "dry_run"`.
- [ ] A heartbeat succeeds and `readGuardStatus()` shows the new
      `last_heartbeat`.
- [ ] Your alerting fires on a `GuardUndeterminedError` (not only on the old
      `PreFlightUndeterminedError` string).

The complete operator gate list is the
[production readiness checklist](docs/production-readiness.md).

Contributors changing **this** SDK verify with the repository's own gates:

```bash
npm run typecheck
npm run lint
npm test
node scripts/check-doc-links.ts
```

## Branded address types

Version 0.2.0 introduces **branded types** for Stellar addresses to catch type mismatches at compile time. These prevent accidentally passing account addresses (G...) where contract addresses (C...) are required, and vice versa.

### Breaking changes

The following function signatures now use branded types:

- `PreFlightConfig.guard`: changed from `string` to `ContractAddress`
- `ContractCall.contract`: changed from `string` to `ContractAddress`
- `buildSetPolicyCall(guard, policy)`: `guard` parameter is now `ContractAddress`
- `buildFreezeCall(guard)`: `guard` parameter is now `ContractAddress`
- `buildUnfreezeCall(guard)`: `guard` parameter is now `ContractAddress`
- `buildRotateAgentKeyCall(guard, newAgent)`: `guard` parameter is now `ContractAddress`
- `PolicyConfig.assets`: changed from `string[]` to `ContractAddress[]`
- `PolicyConfig.recipients`: changed from `string[]` to `AccountAddress[]`
- `PolicyConfig.blocked_recipients`: changed from `string[]` to `AccountAddress[]`
- `ProtocolRule.contract`: changed from `string` to `ContractAddress`
- `RecipientWindowCap.recipient`: changed from `string` to `AccountAddress`

## How to Migrate

### Option 1: Use Type Guards for Runtime Validation (Recommended)

If your addresses come from user input, API responses, or environment variables, validate them with the new type guards:

```typescript no-check: illustrative fragment
import {
  isContractAddress,
  isAccountAddress,
  PreFlightInterceptor,
} from "stellar-agent-guard-sdk";

// Validate a contract address from environment or API
const guardAddress = process.env.GUARD_ADDRESS;
if (!isContractAddress(guardAddress)) {
  throw new Error(`Invalid guard contract address: ${guardAddress}`);
}

const recipientAddress = await fetchRecipientFromAPI();
if (!isAccountAddress(recipientAddress)) {
  throw new Error(`Invalid recipient account address: ${recipientAddress}`);
}

// Now TypeScript knows these are the correct types
const interceptor = new PreFlightInterceptor({
  guard: guardAddress, // Type-safe: ContractAddress
  // ...
});

const policy: PolicyConfig = {
  assets: [guardAddress], // Error! guardAddress is ContractAddress, not allowed here
  recipients: [recipientAddress], // OK: AccountAddress
  // ...
};
```

### Option 2: Type Assertion for Hardcoded Known Values

If you have hardcoded, verified addresses (e.g., from your deployment notes), you can use type assertions:

```typescript no-check: illustrative fragment
import type { ContractAddress, AccountAddress } from "stellar-agent-guard-sdk";

const GUARD = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44" as ContractAddress;
const RECIPIENT = "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFN4L7MRJE47JREUMB5QFO6YL2" as AccountAddress;

// No runtime validation, but you've vouched for correctness
const policy: PolicyConfig = {
  recipients: [RECIPIENT],
  // ...
};
```

### Option 3: Bulk Casting for Migration

To quickly migrate an existing codebase before adding proper validation:

```typescript
import type { ContractAddress, AccountAddress } from "stellar-agent-guard-sdk";

// Convert arrays of strings to typed addresses
const guardAddresses: ContractAddress[] = (
  process.env.GUARD_ADDRESSES?.split(",") ?? []
) as ContractAddress[];

const recipients: AccountAddress[] = (
  process.env.RECIPIENTS?.split(",") ?? []
) as AccountAddress[];
```

**⚠️ WARNING**: This bypasses type safety. Use only as a temporary stepping stone; add proper validation (Option 1) as soon as possible.

## New Type Guards

The SDK now exports four type guard functions:

### `isContractAddress(value): value is ContractAddress`

Validates that a value is a valid Stellar contract address (C...).

```typescript no-check: illustrative fragment
import { isContractAddress } from "stellar-agent-guard-sdk";

if (isContractAddress(guardId)) {
  // guardId is now typed as ContractAddress
} else {
  console.error("Invalid contract address");
}
```

Checks:
- Prefix: must start with `C`
- Length: exactly 56 characters
- Format: valid base32 encoding + StrKey checksum

### `isAccountAddress(value): value is AccountAddress`

Validates that a value is a valid Stellar account address (G...).

```typescript no-check: illustrative fragment
import { isAccountAddress } from "stellar-agent-guard-sdk";

if (isAccountAddress(recipient)) {
  // recipient is now typed as AccountAddress
} else {
  console.error("Invalid account address");
}
```

Checks:
- Prefix: must start with `G`
- Length: exactly 56 characters
- Format: valid base32 encoding + StrKey checksum

### `isStrKeyAddress(value): value is StrKeyAddress`

Validates that a value is any valid Stellar StrKey address (either G... or C...).

```typescript no-check: illustrative fragment
import { isStrKeyAddress } from "stellar-agent-guard-sdk";

if (isStrKeyAddress(maybeAddress)) {
  // Could be either ContractAddress or AccountAddress
  // Use isContractAddress() or isAccountAddress() to narrow further
}
```

### `isPublicKeyHex(value): value is PublicKeyHex`

Validates that a value is a valid raw public key in hex format (64 hex characters).

```typescript no-check: illustrative fragment
import { isPublicKeyHex } from "stellar-agent-guard-sdk";

if (isPublicKeyHex(agentKey)) {
  // agentKey is a valid 64-character hex string
  // suitable for agent key rotation
}
```

## Error Prevention Examples

### Before (Compiles, Fails at Runtime)

```typescript no-check: illustrative fragment
const policy: PolicyConfig = {
  assets: [
    "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFN4L7MRJE47JREUMB5QFO6YL2", // ❌ Wrong! Account address in assets
  ],
  recipients: [
    "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44", // ❌ Wrong! Contract address in recipients
  ],
};

// The policy validates successfully, but fails on-chain
// when you try to call set_policy
```

### After (Fails at Compile Time)

```typescript no-check: illustrative fragment
import { isContractAddress, isAccountAddress, type ContractAddress, type AccountAddress } from "stellar-agent-guard-sdk";

// Proper validation at runtime
let assetAddr: string = "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFN4L7MRJE47JREUMB5QFO6YL2";
if (!isContractAddress(assetAddr)) {
  throw new Error("Asset must be a contract address");
}

let recipientAddr: string = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
if (!isAccountAddress(recipientAddr)) {
  throw new Error("Recipient must be an account address");
}

const policy: PolicyConfig = {
  assets: [assetAddr], // ✅ Now typed as ContractAddress, safe
  recipients: [recipientAddr], // ✅ Now typed as AccountAddress, safe
};
```

## Testing Impact

Existing tests continue to work with minimal changes. If your tests hardcode addresses, use type assertions:

```typescript no-check: illustrative fragment
import type { ContractAddress, AccountAddress } from "stellar-agent-guard-sdk";

const GUARD = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44" as ContractAddress;
const RECIPIENT = "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFN4L7MRJE47JREUMB5QFO6YL2" as AccountAddress;

describe("policy", () => {
  it("should validate policy with typed addresses", () => {
    const policy = {
      recipients: [RECIPIENT],
      assets: [GUARD],
    };
    // ...
  });
});
```

## FAQ

**Q: Do branded types have runtime overhead?**  
A: No. Branded types are a TypeScript compile-time feature only. At runtime, they are plain strings. The type guards are simple prefix/length checks plus StrKey validation — same checks you should have been doing before.

**Q: Can I still use `as` to bypass the types?**  
A: Yes, but don't. Type assertions (`as ContractAddress`) silence the compiler without validation. Use type guards instead to keep both type safety and runtime correctness.

**Q: What if my address comes from an untrusted source?**  
A: Always use type guards (`isContractAddress`, `isAccountAddress`). Never use assertions for untrusted data.

**Q: Do I need to update my existing policy JSON files?**  
A: No. Policy structure hasn't changed. Only the TypeScript types have been updated. Your data can be loaded as before and validated with type guards before passing to SDK functions.

## Rollback

If you need to temporarily revert to untyped strings while updating your code, the old string-based signatures are available if you cast to `any`:

```typescript no-check: illustrative fragment
const interceptor = new PreFlightInterceptor({
  guard: "CAPADGEK..." as any, // Circumvent types, not recommended
});
```

However, this negates the safety benefit. We recommend fixing your code to use type guards properly instead.

## Telemetry records: explicit versioning (issues #322, #323)

### `serializeEventRecord()` and `parseEventRecord()`

`serializeEvent()` is unchanged: it remains the Stable, unversioned (v0) JSON
format it has always been, so no existing log consumer breaks. Persisted
telemetry can opt in to an envelope instead:

```ts no-check: illustrative fragment
// Before — bare v0 line, still supported
const legacyLine = serializeEvent(event);

// After — explicit envelope, recommended for stored records
const line = serializeEventRecord(event);
// {"v":1,"event":{"id":"ledger:…","kind":"auth_checked",…}}
```

Reading both generations is one call:

```ts no-check: illustrative fragment
const { version, event } = parseEventRecord(line);
// version: 0 for legacy bare lines, 1 for the current envelope
```

No rewrite of stored data is required: legacy lines are identified by the
absence of `v` and still parse. A line with a `v` greater than
`TELEMETRY_EVENT_RECORD_VERSION` is reported as-is so the reader can detect a
record written by a newer SDK. See [`docs/event-schema.md`](./docs/event-schema.md)
for the full policy and the golden fixture.

### `poll()` now validates emitting contract identity

`GuardTelemetryListener.poll()` re-checks the emitting `contractId` before
decoding, rather than trusting the RPC's contract filter. Events from another
contract, and events whose identity is missing or malformed, are dropped and
counted in the new `PollResult.dropped` object. If a custom RPC omits
`contractId` for committed events, those events will now be dropped (fail
closed); use an RPC that reports it, or consume the diagnostic streams that
already attribute events to the configured guard.
