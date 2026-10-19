# Dual-Stream Telemetry

A critical challenge in smart account telemetry is observing blocked transactions.

## The Ledger Rollback Problem

When a Soroban contract call is blocked by `__check_auth`, the host rolls back the transaction. Events emitted by the contract during failed transactions **never reach the ledger**.

A listener monitoring only committed ledger events will observe a guard that appears to approve 100% of transactions.

## The Solution

`GuardTelemetryListener` combines two distinct sources:
1. **Committed Ledger Stream**: Polls `getEvents` from Soroban RPC for committed transactions.
2. **Diagnostic Event Stream**: Extracts uncommitted `event_auth_checked` diagnostic events from pre-flight simulation responses via `guardEventsFromDiagnostics()`.

## Resume After Restart (`cursorStore`)

A monitor built on `watch()` is a long-lived process, and long-lived processes
restart — redeploy, crash, redeploy. By default the cursor lives in process
memory, so a restarted listener re-reads from the default position: it either
re-emits history or silently skips the gap between the old process's last poll
and the restart.

Pass a `cursorStore` and the cursor outlives the process. The store is two
methods — `load()` (consulted once when `watch()` starts) and `save()` (called
once per poll, before the page is delivered) — wired to whatever durable
storage the runtime already has (a file, Redis, a database row):

```ts
const listener = new GuardTelemetryListener({
  server,
  guard: GUARD_CONTRACT_ID,
  cursorStore: fileCursorStore, // or redisCursorStore, dbCursorStore, …
});
```

Delivery is then **at-least-once**: events committed between the last `save()`
and the crash are re-fetched and re-emitted after the restart. Deduplicate by
the stable event identity every decoded `GuardEvent` carries — its non-null
`id`, derived the same way on both streams. Full details, including a file
store example: [GuardTelemetryListener API](../api/telemetry-listener.md).
