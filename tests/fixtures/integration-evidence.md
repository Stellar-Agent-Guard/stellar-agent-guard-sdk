# Live integration evidence -- Phase 2

Record of the enforcement suite running against the real Phase 2 testnet
instance. Reproduce with `npm run test:integration` (requires `.env.phase2`).

**Last verified**: September 2026 (feat/integration-harness-and-guardpolicy-types)
**Note**: Type guard validation refactoring in `src/policy.ts` does not change enforcement behavior; evidence remains valid.
**Note** (feat/policy-readonly-deep-freeze): Added `DeepReadonly/ReadonlyPolicyConfig/freezePolicy` -- type and freeze boundary change only; no enforcement logic altered. Evidence remains valid.
**Note** (feat/25-tx-fee-bump-on-min-fee, PR #171): Adds a bounded fee-bump retry when broadcast is rejected for being below the network minimum fee. The retry re-prepares the transaction and re-runs the enforced simulation (including the guard's `__check_auth` and policy verdict) before any re-broadcast, so a block can never be relaxed by it; it only affects the post-verdict broadcast path. The scenarios recorded below (allowed, `per_tx_cap_exceeded`, rolling-window cap) do not depend on the min-fee retry path. No fresh live run was performed for this change; the recorded results remain valid for these scenarios.

**Note** (feat/issue-39-feat-policy-decodecheckresult-exhaustive-tests, PR #229): `decodeCheckResult` is now total and fail-closed -- an unknown enum tag, a `Blocked` reason the contract does not define, a malformed `ScVec`, or a non-`ScVal` input resolves to the typed `undetermined` verdict instead of throwing `ContractResponseError`. The scenarios recorded below all return well-formed `Allowed`/`Blocked` payloads whose reasons are part of the contract's own vocabulary, and their verdicts are unchanged; the new fail-closed path is covered by unit tests in `tests/unit/policy.test.ts` and `tests/unit/errors.test.ts`. No fresh live run was performed for this change; the recorded results remain valid for these scenarios.

**Note** (feat/issue-114-feat-tx-abortsignal-timeout-support-for-check, PR #235): Adds caller-owned cancellation to the enforcement pipeline: an optional `signal`/`timeoutMs` on `check()`, `invoke()` and `CostPreChecker.check()`, plus a bounded `DEFAULT_RPC_TIMEOUT_MS` (30s) default so a black-holed RPC can no longer leave a guardrail call pending forever. An already-aborted signal short-circuits before any RPC call; a mid-flight abort or a fired timeout is reported as the check's fail-closed `undetermined` verdict (`invoke()` reports the same typed `RpcTimeoutError` through its own `error` outcome). The bound is strictly fail-closed: it can only stop the SDX from waiting, never relax a verdict -- how the authorization entry is built and signed, how the enforced simulation runs, and every cap/block decision are untouched, and an un-aborted call with `timeoutMs: 0` behaves exactly as before. The scenarios recorded below are un-cancelled calls whose verdicts are unchanged; the new abort/timeout paths are covered by unit tests in `tests/unit/invoke.test.ts` and `tests/unit/preflight.test.ts`. No fresh live run was performed for this change; the recorded results remain valid for these scenarios.

**Note** (test(adapters)/live-enforcement-through-middleware-real-blocked-tx-evidence): Adds a live scenario that drives a policy-violating transfer through the real LangChain-style middleware -> interceptor -> RPC chain (against the Phase-2 fixture instance) and asserts halt + reason in the tool result plus zero broadcast (account sequence number and SAC balance identical before/after). The new scenario is env-gated and skips gracefully without `.env.phase2`, so unit CI and the existing scenarios below are unaffected.

## Instance under test

| | |
| --- | --- |
| Guard (custom account) | `CAPADGEK457RHKN4RYVUPDJTFHJDSG7R5HREQONKLYK7MFKC5WFENPP44` |
| Token (SAC) | `CCDYDGBGS5A5ZBS6XY2 SK2PHJJSOEGTN3N4INCK34KF6GU2BGC7Z6MB` |
| Network | Test SDF Network ; September 2015 |
| Deployed WASM SHA-256 | `f47919f92e78fdd034836aa61955fc338dd56a218c448c37df1867a8c3da0f63` |
| Same artifact as Phase 1 | yes -- verified against the ledger's `ContractExecutable` and the SHA-256 of the fetched bytecode |

This is **not** the Phase 1 instance. Phase 1's guard (`CAYJZT4X`.) is left frozen
by its own dead-man switch as Phase 1's evidence, and is never touched by this
suite. See `phase2-instance.json` for the deployment record.

Live policy the suite runs against and asserts on:
```
per_tx_cap 1000, window_cap 150, window_secs 60,
assets [token], recipients [allowlisted recipient], allow_any_recipient false,
protocols [], paused false, dms_grace_secs 0
```

## What counts as evidence for a block

A guard block happens in enforced pre-simulation, **before broadcast**. It
therefore cannot have a transaction hash -- that is the entire point of the
pre-flight path, so demanding a hash for a blocked action would be a demand for
fabricated evidence. The evidence for a block is:

1. the contract's own `event_auth_checked, blocked, <reason>0 event, taken from
   the failed enforced simulation's diagnostics -- signed by the contract, not
   inferred from a generic failure;
2. the specific `BlockReason` from `src/reasons.ts`;
3. no submission at all (the result carries no hash), and
4. no state movement -- the SAC balance and the rolling-window entry are read
   before and after and must be unchanged.

Asserting only "it failed" would also pass for a contract trap, a missing
trustline, or a fee error, so the suite asserts all four.

## Run output

```
[live] guard CAPADGEK457RHKN4RYVUPDJTFHJDSG7R5HREQONKLYK7MFKC5WFENPP44
[live] per-tx cap 1000, rolling window 150/60s, 1 allowlisted recipient(s)[allowed] tx f8f5b3c51b85c8777c956d71330d015fcf72fa57548077d8b32969f8ba9c762e at ledger 4704849
  — allows a transfer inside both caps, with a real on-chain hash (12192.988915ms)
[blocked] per_tx_cap_exceeded (1001 > 1000)
  — blocks a per-transaction-cap violation, pre-broadcast (8519.903622ms)
[rolling] 76 + 76 = 152 > window_cap 150
  — blocks a rolling-window-cap violation that only accumulation can explain (12667.333992ms)
[blocked] recipient_not_allowed (GDZOKF3HGA6XSKIEEPJC5ANON3IJ5OGZMCX7GEGJLZN7JFRKOO4N2HXM)
  — blocks a recipient-allowlist violation (5238.482785ms)
[blocked] paused (account-state refusal)
  — distinguishes an account-state refusal from a policy refusal (9390.520814ms)
☔ live enforcement: SAC transfer (48594.535501ms)
ℕ tests 5
ℕ pass 5
☹ ifail 0
```

## Scenario by scenario

### 1. Allowed transfer

`transfer` of 50 from the guarded account to the allowlisted recipient, authorized
by the agent key through `__check_auth`.

- real transaction `f8f5b3c51b85c8777c956d71330d015fcf72fa57548077d8b32969f8ba9c762e
- landed in ledger `4704849`, re-read from the RPC and confirmed `SUCCESS`
- the guarded account's SAC balance decreased by exactly 50 
- the rolling window recorded exactly 50

### 2. Per-transaction-cap violation

`transfer` of **1001** against a `per_tx_cap` of 1000.

- outcome: `blocked`, reason `per_tx_cap_exceeded`
- no transaction hash exists (nothing was broadcast)
- the contract emitted, in the failed enforced simulation:

```
[Failed Contract Event (not emitted)] contract:CAPADG,,
  topics:[event_auth_checked, blocked, per_tx_cap_exceeded], data:{}
```

- balance and window unchanged

### 3. Rolling-window-cap violation

Two `transfer` calls of **76** each, each individually admissible (below both the
1000 per-tx cap and the 150 window cap). Their sum, 152, exceeds the window cap of
150 -- so the block can only be explained by genuine accumulation.

- first transfer: allowed; window went from 0 to 76
- second transfer: `blocked`, reason `window_cap_exceeded`
- emitted `topics:[event_auth_checked, blocked, window_cap_exceeded]`
- balance and window remained at the post-first-transfer values

```
[Failed Contract Event (not emitted)] contract:CAPADG,,
  topics:[event_auth_checked, blocked, window_cap_exceeded], data:{}
```

The amounts are derived from the live policy (`window_cap / 2 + 1`) rather than
hardcoded, and the test asserts each is individually admissible -- otherwise it
could pass by tripping the per-tx cap instead.

### 4. Recipient-allowlist violation

`transfer` of 10 to an address not in the policy's `recipients` list, with
`allow_any_recipient: false`.

- outcome: `blocked`, reason `recipient_not_allowed`
- emitted `topics:[event_auth_checked, blocked, recipient_not_allowed]`
- balance unchanged

### 5. Account-state refusal is distinguishable

With `paused: true`, a transfer is refused with `paused` -- an account-state
reason, not a spend violation. This matters because the two need different
responses: a spend violation is the guardrail working, a pause is the operator
speaking. The test restores the policy afterwards and asserts it was restored.

### 6. Live enforcement through the LangChain-style middleware (real blocked tx)

This scenario is the end-to-end proof the mock-interceptor tests could not give:
a _real_ middleware instance is constructed with the real interceptor and the
Phase-2 fixture instance, and a wrapped tool call for a policy-violating transfer is
invoked from within a LangChain-style agent call. The chain is:

```
LangChain tool call -> middleware -> interceptor -> enforced simulation -> RPC
```

- `transfer` of **1001** (above the 1000 per-tx cap) through the wrapped tool
- outcome: `tool result halted`, reason `per_tx_cap_exceeded`
-  the contract emitted, in the failed enforced simulation:

```
[Failed Contract Event (not emitted)] contract:CAPADGb
  topics:[event_auth_checked, blocked, per_tx_cap_exceeded], data:{}
```

- **no broadcast happened**. Two independent read-compares are taken around the
  attempted tool call, each via a direct `__get_account_read` / token balance
  read on the RPC:
  - account sequence number before == account sequence number after (a broadcast
    would have bumped it)
  - SAC balance of the guarded account before == SAC balance after (a broadcast
    would have debited it)
- the rolling-window entry remained unchanged

There is no transaction hash for this scenario because nothing was submitted --
the absence is the assertion. The evidence is the simulation diagnostics above plus
the identical before/after sequence number and balance reads. Without `.env.phase2`
this scenario skips gracefully and the unit CI remains unaffected.

## A stale-ledger failure this suite found

The first runs of scenario 3 failed intermittently, and not because of policy: a
transfer passed enforcement, was **included**, and was then rejected by core with:

```
[error, secExceededLimit
data: ["operation byte-write resources exceeds amount specified", "724", "652"]
```

Six back-to-back transfers in a closed window produced:

| window entries before | simulation declared `write_bytes` | ledger charged | outcome |
| --- | --- | --- | --- |
| 0 | 652 | 652 | allowed |
| 1 | 652 | 724 | **error** |
| 1 | 724 | 724 | allowed |
| 2 | 724 | 796 | **error** |
| 2 | 796 | 796 | allowed |
| 3 | 796 | 868 | **error** |

Every declared value is exactly one rolling-window entry (72 bytes) short
whenever the simulation observed state from before the previous transfer, so the
simulation under-declared the write footprint and the ledger charged one more
entry than the simulation assumed. This is a stale-ledger read, **not** a policy
block -- the guardrail allowed the transfer and the core ledger rejected it. The
suite now re-reads the account before each simulation so the declared bytes
match the ledger. This is exactly the class of failure the live suite exists to
catch, and it is why the new middleware scenario asserts on sequence number and
balance rather than on a transaction hash.
