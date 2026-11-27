# Production Readiness Checklist

A single list for an operator to work through **before an agent is allowed to
move real funds**. Every piece below already exists in the SDK or the guard
contract and is documented elsewhere; this page assembles them so a missed
heartbeat alert or an unbounded fee does not slip through the gaps between
pages.

> **⚠️ Unaudited tooling.** `stellar-agent-guard-sdk` is unaudited security
> tooling that gates real fund access. Completing this checklist does **not**
> make a deployment audited. **Mainnet use requires an independent security
> audit** of the contracts, this SDK and your integration. See
> [`SECURITY.md`](../SECURITY.md#unaudited-tooling-disclaimer) and the
> [threat model](threat-model.md).

## How to use this page

- **MUST** items are release blockers. Each has a **Verify** line describing an
  observable check that passes or fails; record the evidence (command output,
  screenshot, log line, transaction hash) as described in
  [audit evidence](#9-audit-evidence).
- **RECOMMENDED** items reduce risk or response time. Skipping one is a
  decision to write down, not an oversight.
- Run the whole list against a **testnet** deployment that mirrors production
  first, then re-run the MUST items against production before enabling the
  agent.
- Repeat the list after any policy change, SDK upgrade (see the
  [0.1.x → 0.2 upgrade checklist](../MIGRATION.md#01x--02-upgrade-checklist)),
  key rotation, or RPC provider change.

## 1. Policy review

**MUST**

- [ ] **The deployed policy is the reviewed policy.** Read it back from the
      chain with `fetchGuardPolicyAndWindow()` and compare it with the reviewed
      file with `policyDiff()`; render it for reviewers with `describePolicy(policy, { detail: true })`.
      *Verify:* `policyDiff(reviewed, deployed)` returns `[]`.
      Docs: [policy JSON](api/policy-json.md), [API reference](api-reference.md#describing-a-policy-issue-343).
- [ ] **The policy passes validation with the guard address supplied.**
      `validateGuardPolicy(policy, { guardAddress })` (or
      [`validateGuardPolicyAgainstSchema()`](api/policy-schema.md)) reports no
      failures, including the `self_as_*` rules that only run when
      `guardAddress` is given.
      *Verify:* the validator returns `[]`; `empty_vector_noop` advisories are
      either fixed or explicitly signed off.
- [ ] **Caps are finite and sized for the agent's job.** `per_tx_cap` and
      `window_cap` are the smallest values the agent's task needs, and
      `window_secs > 0` whenever `window_cap > 0`.
      *Verify:* a transfer of `per_tx_cap + 1` is `blocked` with
      `per_tx_cap_exceeded` (see [section 10](#10-fail-closed-verification)).
- [ ] **The policy has an expiry or a review date.** Either `active_until` is
      set, or the review cadence is recorded with the evidence.
      *Verify:* `describePolicy()` output shows the active window, or the
      review date is in the evidence record.

**RECOMMENDED**

- [ ] Start from `DEFAULT_GUARD_POLICY` (deny-all) and widen, rather than
      starting from an allow-any policy and narrowing. See the README's
      [policy validation section](../README.md#policy-validation-before-broadcast-validateguardpolicy).
- [ ] Keep the policy in version control as `policyToJson()` output so every
      change is a reviewed diff ([canonical ordering](api/policy-json.md#canonical-ordering)).
- [ ] Use per-protocol `paused` and `protocol_calls_per_window` to limit
      non-SAC calls, which are not amount-checked — read
      [enforcement scope](enforcement-scope.md) first.

## 2. Dead-man switch: grace and interval

**MUST**

- [ ] **`dms_grace_secs` is non-zero.** `0` disables the dead-man switch.
      *Verify:* the deployed policy's `dms_grace_secs > 0`, and `dmsUrgency(status, policy)`
      does not return `"unknown"` once the agent has heartbeated.
- [ ] **The heartbeat interval is at most one third of the grace window.**
      `startHeartbeat()` refuses anything slower with `HeartbeatIntervalError`.
      *Verify:* `startHeartbeat()` starts without throwing, with `intervalMs`
      recorded in the evidence. Docs: [keep the dead-man switch alive](agent-runtime.md#1-keep-the-dead-man-switch-alive).
- [ ] **The grace window is longer than your worst-case recovery time.** A
      grace shorter than the time it takes an on-call human to fix a broken
      heartbeat freezes the account during every incident.
      *Verify:* the grace window and the on-call response target are both
      written in the evidence record, and grace > response target.

**RECOMMENDED**

- [ ] Opt in to bounded heartbeat retry (`retry: { maxAttempts: 3, … }`) so a
      brief RPC outage near the boundary does not freeze the account. Only
      transport failures are retried (`isRetryableHeartbeatFailure()`).
- [ ] Use an interval of grace / 6 or tighter, leaving room for two missed beats.

## 3. Heartbeat monitoring

**MUST**

- [ ] **Every failed beat pages someone.** `onError` on `startHeartbeat()` is
      wired to alerting, not only to a log. A refused beat arrives there as
      `HeartbeatBlockedError`; a dry-run as `HeartbeatDryRunError`.
      *Verify:* stop the RPC (or point `server` at a closed port) on testnet
      and confirm the alert fires within one interval.
- [ ] **The DMS countdown is monitored independently of the heartbeat
      process.** Poll `readGuardStatus()` + `dmsUrgency()` from a separate
      process or monitor, so a crashed agent cannot also silence its own alarm.
      *Verify:* kill the agent process on testnet; the external monitor
      reports `"warn"` at 80% of grace. Docs: [monitor the DMS countdown](agent-runtime.md#4-monitor-the-dms-countdown).
- [ ] **Shutdown stops the heartbeat cleanly.** `await handle.stop()` runs on
      process exit, bounded with `stop({ timeoutMs })`.
      *Verify:* a `SIGTERM` exits within the bound and logs the stop reason.

**RECOMMENDED**

- [ ] Alert on `onBeat`'s `lateMs` and on `missedBeats` growth, not only on
      failure.
- [ ] Document the [unfreeze procedure](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-contracts/blob/main/docs/functions/freeze-unfreeze.md)
      (`submitUnfreeze()`) in the runbook and rehearse it on testnet.

## 4. Telemetry cursor durability

**MUST**

- [ ] **Cursors survive a restart.** `GuardTelemetryListener` is given a
      durable `cursorStore` (and a separate `failedTxCursorStore` when
      failed-transaction scanning is on). The default `InMemoryCursorStore`
      loses position on restart.
      *Verify:* restart the listener on testnet; the first page resumes from
      the persisted cursor and no event is replayed or skipped.
      Docs: [telemetry listener](api/telemetry-listener.md), [safe checkpointing](event-schema.md#safe-telemetry-checkpointing-issue-274).
- [ ] **A shared store is keyed by scope.** If one backing store (file, Redis,
      database) serves more than one listener, guard or stream, its
      `save`/`load` key records by the `CursorStoreScope` `{ network, guard, stream }`.
      *Verify:* two listeners on different guards persist two distinct records.
- [ ] **Gaps and stream failures alert.** `onGap` and `onStreamError` are wired
      to alerting; `health().state === "failed"` is monitored.
      *Verify:* point the listener at an unreachable RPC on testnet; after
      the bounded retries, `onStreamError` fires and `health().state` is
      `"failed"`. Docs: [mid-watch failures](api/telemetry-listener.md#mid-watch-failures-onstreamerror).

**RECOMMENDED**

- [ ] Persist events with `serializeEventRecord()` (versioned envelope), not
      bare `serializeEvent()`. See [versioned event records](event-schema.md#versioned-event-records--serializeeventrecord-issue-323).
- [ ] Track `onMalformed` / `onUnknownTopics` counts; a non-zero rate after
      a contract upgrade means the SDK needs updating.

## 5. Fee ceilings

**MUST**

- [ ] **Every broadcast path has a fee cap.** `invoke()` is called with
      `maxFeeCap` (a `bigint` in stroops), so a resource-fee spike or a
      fee-bump retry cannot spend without limit; a breach is a
      `FeeCapExceededError` **before** broadcast.
      *Verify:* on testnet, `invoke({ …, maxFeeCap: 1n })` returns
      `kind: "error"` carrying `FeeCapExceededError`, and no transaction hash.
- [ ] **Fee-bump retries are bounded explicitly.** `feeBump.maxAttempts` and
      `maxRetries` are set in configuration rather than left at defaults, and
      the worst case (`maxFeeCap × attempts`) fits the budget.
      *Verify:* the configured values and the computed worst case are in the
      evidence record. Docs: [fee-bump configuration](api/invoke-pipeline.md#fee-bump-configuration-feebump).
- [ ] **Pre-flight cost checks use a ceiling.** `CostPreChecker` is
      constructed with `maxFeeStroops` (a non-negative `bigint` or base-10 integer string), and
      `over_budget` is treated as a refusal.
      *Verify:* a check with `maxFeeStroops: 0n` returns `kind: "over_budget"`.
      Docs: [cost pre-checking](api/cost-checker.md).

**RECOMMENDED**

- [ ] Bound every RPC with `timeoutMs` (default 30s) and every `invoke()` with
      `deadlineMs`, so a stalled RPC fails closed promptly. See
      [overall deadline](api/invoke-pipeline.md#overall-deadline).
- [ ] Alert on fee spend per window from telemetry, independent of the caps.

## 6. Allowlists

**MUST**

- [ ] **`allow_any_recipient` is `false`.** Recipients are an explicit
      allowlist.
      *Verify:* the deployed policy shows `allow_any_recipient: false`, and a
      transfer to an address off the list is `blocked` with
      `recipient_not_allowed`.
- [ ] **`assets` lists only the SAC tokens the agent needs.**
      *Verify:* a transfer of an unlisted asset is `blocked`.
- [ ] **`protocols` lists only the contracts (and functions) the agent must
      call**, with `fns` narrowed from `null` (any function) wherever possible.
      Remember that per-call amounts and recipients are **not** enforced for
      non-SAC calls ([enforcement scope](enforcement-scope.md)).
      *Verify:* a call to an unlisted contract or function is `blocked`.
- [ ] **No allowlist contains the guard itself.** Covered by validation with
      `guardAddress` (section 1).

**RECOMMENDED**

- [ ] Use `blocked_recipients` for known-bad addresses and
      `recipient_window_caps` for per-recipient budgets.
- [ ] Review allowlists on a fixed cadence; remove entries the agent no
      longer needs.

## 7. Key rotation

**MUST**

- [ ] **The agent key is not the admin key**, and the admin key is not on the
      agent host.
      *Verify:* the agent host's configured signer public key differs from
      the guard admin, and the admin secret is absent from the agent's
      environment and secret store.
- [ ] **The signer is configured with a public key, never a secret seed.**
      `validateAgentPublicKey()` rejects `S…` values with a `SigningError`.
      *Verify:* `isValidAgentPublicKey(signer.publicKey)` is `true`.
      Docs: [validating the signer identity](concepts/custom-account-signing.md#validating-the-signer-identity).
- [ ] **A rotation has been rehearsed end to end on testnet** using
      `submitRotateAgentKey()`, including the post-rotation check that the old
      key is refused.
      *Verify:* evidence of a testnet rotation (transaction hash) and of a
      `blocked` call signed with the old key. Docs: [key rotation runbook](concepts/custom-account-signing.md#operator-runbook-agent-key-rotation-and-recovery).

**RECOMMENDED**

- [ ] Rotate on a schedule and immediately on any suspected compromise.
- [ ] Keep the agent key in a KMS/HSM-backed signer through the
      [signer seam](concepts/custom-account-signing.md#the-signer-seam).

## 8. Alerting

**MUST**

- [ ] **Every refusal is visible.** `blocked` and `undetermined` verdicts from
      `check()` (and adapter halts via `onBlocked`) raise an alert carrying the
      reason (`explainReason(reason)`) and the error class.
      *Verify:* the fail-closed test in [section 10](#10-fail-closed-verification) produces an alert.
- [ ] **Admin events alert.** `watchAll()` consumers alert on freeze/unfreeze,
      `policy_set` / `policy_revoked`, and blocked `auth_checked` decisions.
      *Verify:* a testnet `submitFreeze()` produces an alert within one poll
      interval. Docs: [tail telemetry](agent-runtime.md#3-tail-telemetry-for-operator-alerts).
- [ ] **Alerts route by class, not by message text.** Rules match on
      `error.name` / `instanceof` (for example `GuardUndeterminedError`,
      `RpcTimeoutError`, `FeeCapExceededError`), because messages may change.
      *Verify:* each alert rule names a class from
      [troubleshooting: error classes](troubleshooting.md#error-classes).
- [ ] **A `pending` invoke outcome alerts and is never rebroadcast.**
      *Verify:* the code path for `kind: "pending"` reconciles with
      `getTransaction(transactionHash)` and contains no resubmission. Docs:
      [the pending outcome](api/invoke-pipeline.md#the-pending-outcome-accepted-not-confirmed).

**RECOMMENDED**

- [ ] Ship SDK logs through the opt-in `logger`; the SDK is silent by default.
- [ ] Alert on a sustained `undetermined` rate (usually RPC trouble or rate
      limiting — see `RateLimitedError`).

## 9. Audit evidence

**MUST**

- [ ] **An evidence record exists for this deployment** containing: the guard
      address and network, the verified WASM hash, the deployed policy
      (`policyToJson()` output) and its review sign-off, the SDK version from
      `npm ls stellar-agent-guard-sdk`, the heartbeat interval and grace, the
      fee caps, and the outputs of every **Verify** line on this page.
      *Verify:* the record exists, is dated, and is stored where the audit
      team can read it.
- [ ] **The guard WASM is the expected build.** `verifyGuardWasm()` against
      `GUARD_WASM_HASH` (or your own pinned hash) passes.
      *Verify:* the check's output is in the record. Docs:
      [testnet verification](verification.md).
- [ ] **The fail-closed verification in [section 10](#10-fail-closed-verification)
      passed on the deployment being enabled**, with transaction hashes or
      verdict outputs attached.

**RECOMMENDED**

- [ ] Attach the [threat model](threat-model.md) and
      [attack-surface inventory](attack-surface.md) with your integration's
      deviations noted.
- [ ] Keep the record under version control alongside the policy file.

## 10. Fail-closed verification

Prove that a blocked transfer **stays blocked** — through pre-flight, through
an RPC failure, and at the contract — before the agent touches real funds.
All of these are **MUST** items. Run them on testnet first, then on the
production deployment with a dust-sized amount.

- [ ] **Pre-flight refuses.** Build a transfer the policy forbids (recipient
      off the allowlist, or `per_tx_cap + 1`).
      *Verify:* `interceptor.check(call)` returns `kind: "blocked"` with the
      expected reason, and `assertAllowed(call)` throws `GuardBlockedError`.
- [ ] **Doubt refuses.** Repeat the same check with the RPC unreachable (a
      closed port) or `timeoutMs: 1`.
      *Verify:* the verdict is `kind: "undetermined"` (carrying
      `RpcTimeoutError` or `SimulationError`) — never `admissible`.
- [ ] **The contract refuses even if pre-flight is skipped.** Submit the same
      forbidden transfer with `invoke()` directly.
      *Verify:* the outcome is `kind: "blocked"` with the same reason; no
      funds move (balances unchanged before and after).
- [ ] **The agent loop does not retry a refusal into success.** Trigger the
      forbidden action through the real agent (framework adapter included).
      *Verify:* the wrapped tool never executes, an alert fires, and repeating
      the action yields the same refusal.
- [ ] **A paused account refuses everything.** On testnet, `submitFreeze()`
      (or set `paused: true`), then attempt an otherwise-allowed transfer.
      *Verify:* `blocked`; unfreeze and confirm the allowed transfer succeeds
      again.

Record the outputs in the [audit evidence](#9-audit-evidence). If any step
returns `admissible` for a forbidden action, **stop**: do not enable the agent,
and report it privately per [`SECURITY.md`](../SECURITY.md#disclosure-channels).

## See also

- [Running an agent 24/7](agent-runtime.md)
- [Threat model](threat-model.md) and [attack-surface inventory](attack-surface.md)
- [Enforcement scope](enforcement-scope.md)
- [Troubleshooting](troubleshooting.md)
- [`SECURITY.md`](../SECURITY.md)
