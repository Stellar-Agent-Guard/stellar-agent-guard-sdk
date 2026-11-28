# Admin Incident Runbook: Freeze, Rotate, Unfreeze

Use this procedure when an agent key may be compromised, lost or behaving
unexpectedly. The order is deliberate: **preview → freeze → rotate → verify →
unfreeze → resume heartbeats**. Rotating before the freeze leaves a race in
which the old key can still submit a transaction; unfreezing before verification
can hand a live account back to the wrong key.

Every command below is implemented in the compiled
[`examples/admin-incident-runbook.ts`](../examples/admin-incident-runbook.ts)
and checked by `npm run typecheck`. The underlying SDK calls are
`fetchGuardPolicyAndWindow()`, `readGuardStatus()`, `submitFreeze()`,
`submitRotateAgentKey()`, `submitUnfreeze()` and `startHeartbeat()`; see
[API reference](api-reference.md) and the
[agent key rotation runbook](concepts/custom-account-signing.md#operator-runbook-agent-key-rotation-and-recovery).

## Irreversibility and the two-person rule

A Soroban ledger never forgets a committed transaction: there is no "undo"
button. Some state changes are reversible by a later admin call; a key exposure
is not. Treat every submission as final evidence and require a second operator
to confirm the ones below.

| Step | State reversible? | Second operator required? | Why |
|---|---|---|---|
| Preview | n/a (read only) | No | No ledger write. |
| Freeze | Yes — `submitUnfreeze()` | **Yes** | Immediate halt of a live account; a mistake costs availability. |
| Rotate | Only by rotating again | **Yes, mandatory** | Once included, the old key is no longer authoritative; any exposure of the new key cannot be erased. |
| Verify | n/a (read only) | No | Evidence must be independent of the submitter. |
| Unfreeze | Yes — `submitFreeze()` | **Yes** | Re-enables spending and re-arms the dead-man clock. |
| Resume heartbeats | Yes — `handle.stop()` | No | Operational follow-up, not a policy change. |

Record the guard address, network passphrase and every transaction hash in the
incident ticket. The `admin` key authorizes these calls; `source` pays fees. An
injected `server` is used verbatim, and an SDK-built `url` must be HTTPS (or an
explicitly approved local/http exception).

## Preconditions

- Both operators have independent access to the admin signer and can read the
  same RPC endpoint and network passphrase.
- The replacement agent public key is generated and recorded; its secret is
  held by the new agent process, **never** by the SDK.
- The previous agent public key is recorded for a rollback rotation (do not
  reuse it if compromise is suspected).
- A telemetry listener is subscribed before the incident if event evidence is
  required; see [dual-stream telemetry](concepts/dual-stream-telemetry.md).
- The RPC endpoint is reachable. An `undetermined` outcome is a refusal, not a
  green light.

## Step 0 — Preview the policy and DMS state (read only)

```ts
const { policy, windowSpent, status, urgency } = await previewPolicy(config);
```

- **Preconditions:** the guard address and network passphrase are from the same
  deployment.
- **Expected outcome:** `policy` is the current on-chain configuration,
  `windowSpent` is the committed rolling spend, and `status` reports
  `admin_frozen`, `heartbeat_expired`, `last_heartbeat` and `now`.
- **Verify before continuing:** confirm the window and policy are what the
  operator expects and note `urgency`; `"expired"` means the dead-man grace has
  already run out. A `null` policy is a separate incident — admin freeze still
  binds a policyless account, but investigate why the policy is missing.
- **Rollback:** none; this step only simulates ledger reads.

## Step 1 — Freeze first (LEDGER-FINAL · SECOND OPERATOR)

```ts
const freezeHash = await freezeForIncident(config); // confirmSecondOperator() runs first
```

- **Preconditions:** Step 0 confirmed the target guard and network; the second
  operator approved the freeze.
- **Expected outcome:** the outcome's `kind` is `"allowed"` and `freezeHash` is
  the transaction hash to record.
- **Verify on-chain before continuing:**

  ```ts
  const frozen = await verifyFrozen(config); // readGuardStatus(): admin_frozen === true
  ```

  A missing or false `admin_frozen` means the freeze did not land: stop, do not
  rotate, and investigate the transaction by hash.

- **Rollback:** `submitUnfreeze(config)` from
  `unfreezeAfterVerification(config)`, with the second operator's approval.
  During a key-compromise incident, roll back only after the key situation is
  resolved.

## Step 2 — Rotate the agent key (IRREVERSIBLE KEY CHANGE · SECOND OPERATOR)

```ts
const rotateHash = await rotateAgentKey(config); // submitRotateAgentKey({ newAgent })
```

- **Preconditions:** the freeze is verified in Step 1; both operators have
  confirmed the exact replacement public key.
- **Expected outcome:** `kind: "allowed"` and `rotateHash`; the contract re-binds
  its `AgentPubkey` storage and emits `agent_rotated` with old/new key
  fingerprints (`sha256(pubkey)[0..8]`, rendered as 16 hex characters).
- **Verify before continuing:** the transaction hash exists, then perform
  Step 3. Do not unfreeze on a hash alone.
- **Rollback:** submit another `submitRotateAgentKey()` with the recorded
  previous key, have the second operator confirm it, and re-run Step 3. This
  restores authority but cannot un-disclose a key; if the old key is compromised,
  keep the new key and escalate instead.

## Step 3 — Verify the rotation on-chain (read only)

```ts
const storedAgentHex = await verifyAgentKey(config); // reads AgentPubkey from instance storage
```

- **Preconditions:** the rotation transaction is included.
- **Expected outcome:** `storedAgentHex` equals the hex encoding of the new
  agent's 32-byte Ed25519 public key. Optionally cross-check the committed
  `agent_rotated` event's `new_fingerprint` against
  `sha256(newAgent.rawPublicKey())[0..8]`.
- **Verify before continuing:** a mismatch or missing entry is a hard stop —
  keep the account frozen and repeat Step 2 only after diagnosing the key and
  transaction.
- **Rollback:** none; this step only reads ledger state. If it fails, use the
  Step 2 rollback.

## Step 4 — Unfreeze (LEDGER-FINAL · SECOND OPERATOR)

```ts
const unfreezeHash = await unfreezeAfterVerification(config); // confirmSecondOperator() runs first
```

- **Preconditions:** Steps 1 and 3 verified the freeze and the new key.
- **Expected outcome:** `kind: "allowed"` and `unfreezeHash`. The contract clears
  `AdminFrozen` **and** stamps `LastHeartbeat = now`, re-arming the dead-man
  clock; it does not change the policy.
- **Verify on-chain before continuing:**

  ```ts
  const unfrozen = await verifyUnfrozen(config, frozen);
  ```

  This fails if `admin_frozen` is still true, `heartbeat_expired` is still true,
  or `last_heartbeat` did not advance past the pre-freeze value. A still-expired
  deadline or an outside-active-window policy needs its own fix; unfreezing is
  not a policy edit.

- **Rollback:** `submitFreeze()` immediately, with the second operator's
  approval, then return to Step 0.

## Step 5 — Resume heartbeats and watch telemetry

```ts
const handle = await resumeHeartbeats(config, policy!.dms_grace_secs);
// on shutdown: await handle.stop();
```

- **Preconditions:** Step 4 verified an unfrozen, non-expired account with the
  new key registered.
- **Expected outcome:** `HeartbeatResult.verified === true` on the first beat;
  `last_heartbeat` advances and `dmsUrgency()` returns `"ok"` then `"warn"` at
  80% of grace, never silently `"expired"`.
- **Verify:** alert on `onError`, tail `event_frozen` / `event_unfrozen` /
  `event_auth_checked` events, and keep monitoring the countdown with
  `dmsUrgency(status, policy)` as described in
  [Running an agent 24/7](agent-runtime.md#4-monitor-the-dms-countdown).
- **Rollback:** `await handle.stop()`; it does not change policy or freeze state.

## How the dead-man switch interacts with a freeze

A freeze is **not** a substitute for heartbeats. While `admin_frozen` is true,
the contract blocks agent calls including `heartbeat()` (admin freeze is the
first gate), so the heartbeat loop should be stopped or expected to report
`admin_frozen` blocks — those blocks are decisions, not transport failures, and
must not be retried. The grace clock keeps running against the last recorded
heartbeat; time alone cannot clear a dead-man expiry.

`unfreeze()` re-arms the clock by setting `LastHeartbeat = now`, which clears a
dead-man expiry at that instant, but the agent must resume heartbeats at an
interval no greater than one third of the grace period immediately afterwards.
`dmsUrgency()` is a display helper only: it never freezes, unfreezes, approves a
call or keeps the switch alive. See [troubleshooting](troubleshooting.md) for
the blocked-heartbeat symptoms.
