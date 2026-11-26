# Policy Cookbook

The API reference documents fields. This page documents **combinations**: five
complete, reviewed policies for questions integrators actually ask — how do I
allow one token and one recipient, how do I cap a trading agent per hour, how do
I stage a rollout with an active window?

Every recipe is a complete `ReadonlyPolicyConfig` in
[`examples/policy-cookbook.ts`](../examples/policy-cookbook.ts), typechecked with
the repository and validated by
[`tests/unit/policy-cookbook-example.test.ts`](../tests/unit/policy-cookbook-example.test.ts).
The `describePolicy()` output shown under each recipe is pinned by that test, so
these examples cannot drift from the code that ships.

## Before you copy a recipe

- **Replace every address.** The values are Phase 2 testnet fixtures
  (`CAPADGE…`, `CDCYDG…`, `GAOBCR…`, `GBRPYH…`, `CAJJZT…`), not your guard,
  asset, recipients or protocols.
- **Treat the numbers as starting points, not recommendations.** Raise caps
  deliberately, after deciding what a loss of the full window cap would mean.
- **Start from the safe baseline.** `DEFAULT_GUARD_POLICY` is deny-all; every
  recipe here is a deliberate widening of it, not a default.
- **Enforcement scope.** Full recipient/amount enforcement is native to SAC
  `transfer`/`transfer_from`. Arbitrary protocol calls are gated by allowlist,
  window and pause state only. See
  [`enforcement-scope.md`](enforcement-scope.md).
- **Install and verify.** Build the policy, install it with `submitSetPolicy()`,
  and confirm the on-chain value with `fetchGuardPolicyAndWindow()` before
  letting an agent sign anything.

```ts
import { submitSetPolicy, type SetPolicyParams } from "stellar-agent-guard-sdk";
import { singleRecipientPayer } from "./examples/policy-cookbook.ts";

// `params` carries the server, signer and guard address; the policy is the
// recipe from the cookbook.
const result = await submitSetPolicy({ ...params, policy: singleRecipientPayer });
```

## 1. Single-recipient payer

A payer agent that may send one asset, to one allowlisted recipient, at most
250 stroops per transaction and 1 000 stroops per rolling day. No protocol calls
are allowed, and no other asset or recipient is named.

```ts
const singleRecipientPayer: ReadonlyPolicyConfig = freezePolicy({
  per_tx_cap: 250n,
  window_secs: 86_400n,
  window_cap: 1_000n,
  assets: [ASSET_ADDRESS],
  protocols: [],
  recipients: [VENDOR_ADDRESS],
  allow_any_recipient: false,
  active_from: 0n,
  active_until: 0n,
  paused: false,
  dms_grace_secs: 604_800n,
});
```

`describePolicy(singleRecipientPayer)`:

```text
per-tx cap 250, rolling window 1000 / 86400s, 1 asset(s), 1 allowlisted recipient(s), 0 allowlisted protocol(s), active, dead-man grace 604800s, no active window
```

**Deliberately does not protect against:** a compromised agent draining the full
daily cap to the one allowlisted recipient; a wrong-but-allowlisted recipient;
the recipient's own key compromise; or price movement between quote and
settlement. The dead-man switch pauses the guard if heartbeats stop for seven
days, but it is not a fraud detector.

## 2. Hourly-capped trading agent

An agent that may call `swap` on one DEX contract and transfer the asset, capped
at 5 000 stroops per transaction, 12 000 per rolling hour, and 60 protocol calls
per window. The treasury recipient entry is a sweep path for realised proceeds.

```ts
const hourlyCappedTradingAgent: ReadonlyPolicyConfig = freezePolicy({
  per_tx_cap: 5_000n,
  window_secs: 3_600n,
  window_cap: 12_000n,
  assets: [ASSET_ADDRESS],
  protocols: [{ contract: DEX_ADDRESS, fns: ["swap"] }],
  recipients: [TREASURY_ADDRESS],
  allow_any_recipient: false,
  active_from: 0n,
  active_until: 0n,
  paused: false,
  dms_grace_secs: 604_800n,
  protocol_calls_per_window: 60,
});
```

`describePolicy(hourlyCappedTradingAgent)`:

```text
per-tx cap 5000, rolling window 12000 / 3600s, 1 asset(s), 1 allowlisted recipient(s), 1 allowlisted protocol(s), active, dead-man grace 604800s, no active window
```

**Deliberately does not protect against:** losses *inside* an allowlisted DEX
call. The guard authorizes the call and rate-limits it; it does not inspect
swap routes, slippage, oracle state or the value the call returns. A malicious
or upgraded allowlisted contract is still allowlisted. Keep the DEX address
under the same review as your own code, and monitor realised losses out of band.

## 3. Staged rollout

A policy installed ahead of time that cannot authorize until `active_from` and
stops authorizing on its own at `active_until`. The values below are illustrative
future timestamps (`1_800_000_000n` is 2027-01-15T08:00:00Z).

```ts
const stagedRollout: ReadonlyPolicyConfig = freezePolicy({
  per_tx_cap: 100n,
  window_secs: 3_600n,
  window_cap: 500n,
  assets: [ASSET_ADDRESS],
  protocols: [],
  recipients: [VENDOR_ADDRESS],
  allow_any_recipient: false,
  active_from: 1_800_000_000n,
  active_until: 1_802_592_000n,
  paused: false,
  dms_grace_secs: 86_400n,
});
```

`describePolicy(stagedRollout, { nowSecs: 1_700_000_000n })`:

```text
per-tx cap 100, rolling window 500 / 3600s, 1 asset(s), 1 allowlisted recipient(s), 0 allowlisted protocol(s), active, dead-man grace 86400s, active window 2027-01-15T08:00:00.000Z -> 2027-02-14T08:00:00.000Z (scheduled)
```

**Deliberately does not protect against:** an operator who never extends or
replaces the policy — after `active_until` the guard refuses everything, which
is fail-closed but is an outage, not a safety feature. The window is observed
against ledger time; do not use it as a precise wall-clock scheduler. Install
and verify the policy before `active_from`, and rehearse the extension path.

## 4. Treasury with pause

A fully configured treasury policy kept deliberately paused. The policy,
allowlists and window accounting remain installed, so resuming is a pause-state
change rather than a policy reinstall and re-review.

```ts
const treasuryWithPause: ReadonlyPolicyConfig = freezePolicy({
  per_tx_cap: 10_000n,
  window_secs: 86_400n,
  window_cap: 50_000n,
  assets: [ASSET_ADDRESS],
  protocols: [],
  recipients: [TREASURY_ADDRESS],
  allow_any_recipient: false,
  active_from: 0n,
  active_until: 0n,
  paused: true,
  dms_grace_secs: 604_800n,
});
```

`describePolicy(treasuryWithPause)`:

```text
per-tx cap 10000, rolling window 50000 / 86400s, 1 asset(s), 1 allowlisted recipient(s), 0 allowlisted protocol(s), PAUSED, dead-man grace 604800s, no active window
```

**Deliberately does not protect against:** an admin key that can unpause. The
pause is an operator brake, not a trust boundary: whoever holds administrative
authority can clear it. Split admin authority from agent authority, keep the
admin key in a separate signer, and monitor `policy_set` / `unfrozen` telemetry
for changes you did not make.

## 5. Deny-all observer

An inert policy for a watch-only account. Both caps are zero and only the
treasury is allowlisted, so the account can be monitored — events, heartbeats,
telemetry — while authorizing at most a zero-value transfer to the treasury.
`dms_grace_secs: 0n` disables the dead-man switch, because there is no spend to
pause.

```ts
const denyAllObserver: ReadonlyPolicyConfig = freezePolicy({
  per_tx_cap: 0n,
  window_secs: 3_600n,
  window_cap: 0n,
  assets: [ASSET_ADDRESS],
  protocols: [],
  recipients: [TREASURY_ADDRESS],
  allow_any_recipient: false,
  active_from: 0n,
  active_until: 0n,
  paused: false,
  dms_grace_secs: 0n,
});
```

`describePolicy(denyAllObserver)`:

```text
per-tx cap 0, rolling window 0 / 3600s, 1 asset(s), 1 allowlisted recipient(s), 0 allowlisted protocol(s), active, dead-man switch off, no active window
```

**Deliberately does not protect against:** a zero-amount transfer still being a
valid authorization. The asset and recipient entries exist so the policy
validates clean rather than tripping `empty_vector_noop`; they do not widen the
zero caps. If you want a hard deny with no valid call at all, use
`DEFAULT_GUARD_POLICY` and accept its two documented `empty_vector_noop`
failures, or set `paused: true`.

## Using a recipe safely

1. Copy the recipe into your own configuration module; do not import this
   repository's example path from production code.
2. Replace the addresses, then run `validateGuardPolicy()` in your test suite.
3. Install with `submitSetPolicy()` and read the policy back with
   `fetchGuardPolicyAndWindow()`.
4. Run `describePolicy()` against the read-back policy and compare it with what
   you intended — a summary is easier to review than a struct.
5. Start with fees and caps below production values, watch the guard's telemetry,
   and widen deliberately.
