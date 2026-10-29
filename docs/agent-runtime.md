# Running an agent 24/7

The pieces of this SDK — pre-flight, heartbeat, telemetry, DMS monitoring — are documented one by one. This page shows the **complete loop** a long-running agent needs, and what that loop does when something goes wrong.

Every call below exists in the SDK and is compiled by `npm run typecheck` in [`examples/agent-runtime.ts`](../examples/agent-runtime.ts); the failure-mode table is pinned by `tests/unit/agent-runtime-example.test.ts`.

> **Fail-closed everywhere.** The only verdict that lets a transfer run is `admissible`. `blocked`, `undetermined`, a timeout, an RPC outage and a rate limit all refuse. There is no "proceed on doubt" branch.

## The four responsibilities

```text
            ┌────────────────────────────── agent process ──────────────────────────────┐
 tool call ─▶ 2. PreFlightInterceptor.check ── admissible ─▶ invoke() / your executor
            │            │ blocked / undetermined ─▶ refuse + alert
            │ 1. startHeartbeat  (every ≤ grace/3)  ───────────────▶ DMS stays alive
            │ 3. GuardTelemetryListener.watchAll ───▶ operator alerts (freeze, policy change, blocks)
            │ 4. dmsUrgency(status, policy)  (every minute) ──────▶ warn at 80% of grace
            └─────────────────────────────────────────────────────────────────────────────┘
```

### 1. Keep the dead-man switch alive

An agent that stops heartbeating freezes. Use the SDK's own submission — it signs through the same custom-account path as `invoke()`:

```ts
const hb = await startHeartbeat({
  server, guard, signer: agent, networkPassphrase,
  intervalMs: Number(graceSecs / 6n) * 1000, // must be <= grace/3 (validated before the first beat)
  graceSecs,
  retry: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 10_000 },
  onBeat: ({ lateMs }) => { if (lateMs > 2_000) alert(`heartbeat ${lateMs}ms late`); },
  onError: (error) => alert(`heartbeat failed: ${String(error)}`),
});
// on shutdown: await hb.stop();
```

For a single beat use [`heartbeat()`](../README.md#send-one-heartbeat-heartbeat), which also re-reads `status()`. The contracts repo's `agent-tx` binary remains a CLI alternative. See [Keep the dead-man switch alive](../README.md#keep-the-dead-man-switch-alive-startheartbeat) for lateness, `stop()` and retry semantics.

### 2. Pre-flight every transfer

```ts
const decision = await interceptor.check(call, { timeoutMs: 10_000 });
if (decision.kind !== "admissible") {
  // blocked (policy said no) or undetermined (could not decide): refuse either way.
}
```

Pre-flight is advisory and read-only; the contract still enforces on broadcast ([Fidelity & limits](../README.md#fidelity--limits)). An agent firing many calls at once is throttled by `maxConcurrentSimulations` (default 4) so a burst does not become an `undetermined` storm — see [Troubleshooting](../README.md#agent-halted-with-an-undetermined-storm-rate-limited-rpc).

### 3. Tail telemetry for operator alerts

```ts
const listener = new GuardTelemetryListener({ server, guard, rpcUrl });
for await (const event of listener.watchAll({ signal })) {
  // freeze/unfreeze, policy_set/policy_revoked, and blocked auth_checked decisions
}
```

`watchAll()` merges the committed stream with the diagnostic stream; a *blocked* decision exists only on the diagnostic feed (a refusal rolls its event back). See [Dual-stream telemetry](concepts/dual-stream-telemetry.md).

### 4. Monitor the DMS countdown

```ts
const [{ policy }, status] = await Promise.all([
  fetchGuardPolicyAndWindow(server, guard),
  readGuardStatus({ server, guard, source: agent.publicKey(), networkPassphrase }),
]);
const urgency = dmsUrgency(status, policy); // "ok" | "warn" | "expired" | "unknown"
```

**Warn threshold.** `dmsUrgency` returns `"warn"` once

```text
elapsed >= warnRatio × dms_grace_secs      where elapsed = now − last_heartbeat, warnRatio = 0.8 by default
```

and `"expired"` once `deadManRemaining(status, policy) <= 0` (`remaining = last_heartbeat + grace − now`). `"unknown"` means no countdown is running (no policy, switch disabled with `dms_grace_secs = 0`, or never heartbeated — *never* is not *expired*).

**Current state, stated honestly.** The contract exposes `status()` (`last_heartbeat`, `now`, `heartbeat_expired`) but no `dms_health` percentage yet. The SDK computes the same figure client-side with the contract's edge semantics (`dms.ts` notes that a future contract-side `dms_health` would reuse the same constant). If `dms_health` lands, prefer it and keep `dmsUrgency` as the offline fallback; both give the same answer.

## Reference loop

```ts
const heartbeat = await startAgentHeartbeat(config, graceSecs);        // 1
const telemetry = tailTelemetry(config, abort.signal);                 // 3
const dms = setInterval(() => void checkDmsHealth(config), 60_000);    // 4

async function onToolCall(call: ContractCall) {                        // 2
  if ((await guardedTransfer(interceptor, call, config.alert)) !== "execute") return;
  await invoke({ /* … */ });
}
```

The full, compiled version is [`examples/agent-runtime.ts`](../examples/agent-runtime.ts).

## Failure modes

| Situation | What the loop does | Fail-closed? |
| --- | --- | --- |
| Verdict `blocked` | Refuses the call, alerts with the reason and its explanation. Never retried. | Yes |
| Verdict `undetermined` (simulation failed, unpriceable, malformed) | Refuses the call, alerts. A later identical call may succeed. | Yes |
| RPC down or stalled during `check()` | `timeoutMs` bounds it; verdict is `undetermined` carrying `RpcTimeoutError`. Refuses. | Yes |
| RPC rate limiting (HTTP 429) | One bounded backoff and retry inside the interceptor, then `undetermined` with `cause: "rate_limited"`. Refuses. | Yes |
| RPC down during a heartbeat | Retried with bounded jittered backoff; each failure goes to `onError`. A *blocked* heartbeat is never retried. | The account freezes at grace; it never over-spends |
| Heartbeat late | `onBeat` reports `lateMs`; `missedBeats` increments. | n/a |
| DMS in the warn band | `checkDmsHealth` alerts at 80% of grace. | n/a |
| DMS expired (`heartbeat_expired`) | Alert; every transfer and heartbeat is blocked until an admin unfreezes. | Yes |
| Telemetry stream drops | `watchAll` retries within its envelope; the committed stream resumes from its cursor. Alerts may be delayed, enforcement is unaffected. | n/a |

Telemetry and DMS monitoring are *observability*: if they fail, nothing is approved that policy would refuse. Pre-flight and the contract's `__check_auth` are the enforcement.
