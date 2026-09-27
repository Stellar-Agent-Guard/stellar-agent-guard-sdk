# Guard event schema — verified against the live chain

Phase 2.2 exists because the contract's event schema had only ever been read from
documentation. This document records what the chain actually emits, captured from
the live Phase 2 instance, and reconciles it with the contracts repo's source.

## How it was captured

`scripts/capture-event.ts` drives two real calls on the live Phase 2 instance
(`CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44`) and decodes every
event attributed to the guard:

1. an allowed `heartbeat()` — its events are committed ledger events, retrieved
   from `getTransaction(hash)`, which is the same stream a telemetry listener
   tails;
2. a per-tx-cap violation (`transfer` of 1100 against a 1000 cap) — a refused
   call never becomes a transaction, so its decision only exists as a
   *diagnostic* event on the failed enforced simulation.

Run: `node scripts/capture-event.ts`

## The capture

Real output, 2026-09-14, heartbeat tx
`74751b83d9ffdba3d9aea6b0c24cae866b536a802724085bb88bbeaa72f8d970`, ledger
`4673929`:

```json
[
  {
    "source": "ledger",
    "contract": "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
    "topics": ["event_auth_checked", "allowed", ""],
    "data": {}
  },
  {
    "source": "ledger",
    "contract": "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
    "topics": ["event_heartbeat"],
    "data": { "at": "1789393232" }
  },
  {
    "source": "diagnostic",
    "contract": "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
    "topics": ["event_auth_checked", "blocked", "per_tx_cap_exceeded"],
    "data": {}
  }
]
```

## What this changed

The capture caught a real drift between the documentation and the chain, and a
real bug it had already caused in the SDK.

### 1. The decision topic is `event_auth_checked`, not `auth_checked`

`SPEC.md` §9 and `tests/fixtures/README.md` line 86 of the contracts repo describe
the decision event as `auth_checked`. The chain emits **`event_auth_checked`**,
because Soroban's `#[contractevent]` macro prepends `event_` to the struct name.
The contracts repo already records the real name elsewhere — its own fixture log
at `tests/fixtures/README.md` line 105 reads
`[Contract Event] topics: [event_auth_checked, blocked, per_tx_cap_exceeded]` —
so the two spellings coexist in that repo's own docs.

This was not cosmetic. `src/invoke.ts` matched `topics[0] === "auth_checked"`, so
it failed to recognise a genuine refusal and reported a real policy block as
`{ kind: "error" }` instead of `{ kind: "blocked", reason: "per_tx_cap_exceeded" }`.
The classifier was fixed to match the confirmed symbol; the vocabulary now lives
in one place, `src/events.ts`.

### 2. An allowed decision carries an empty reason symbol

On `allowed`, topic 2 is present and is the **empty symbol** `""` — not omitted.
`decodeAuthDecision` normalises it to `null` so an operator never sees `""` as a
reason.

### 3. A heartbeat's timestamp is event data, not a topic

`event_heartbeat` has exactly one topic (its name). The unix-second timestamp
arrives as event data: `data = { at: u64 }`, matching
`struct EventHeartbeat { at: u64 }` in `src/lib.rs`. Only the `EventAuthChecked`
struct marks its fields `#[topic]`.

### 4. Ledger events are grouped, and their contract id is raw

`tx.events.contractEventsXdr` is an array of **groups**, one per invoked contract,
and each group is itself an array of events. Reading it as a flat event list
yields one element that is an array and decodes to nothing — which is how the
first capture run silently lost the heartbeat. Each ledger event's `contractId` is
a bare `ContractId` (an opaque 32-byte hash whose `toString()` is not a strkey),
so it must be converted with `StrKey.encodeContract`.

## Confirmed against source

`stellar-agent-guard-contracts/src/lib.rs` defines the events with
`#[contractevent]`, which is why every emitted name carries the `event_` prefix:

| Struct                 | Emitted topic[0]       | Data            |
| ---------------------- | ---------------------- | --------------- |
| `EventAuthChecked`     | `event_auth_checked`   | none (`{}`)     |
| `EventHeartbeat`       | `event_heartbeat`      | `{ at: u64 }`   |
| `EventInitialized`     | `event_initialized`    | `{ by: Address }` |
| `EventFrozen`          | `event_frozen`         | `{ by: Address }` |
| `EventUnfrozen`        | `event_unfrozen`       | `{ by: Address }` |
| `EventPolicySet`       | `event_policy_set`     | `{ by: Address }` |
| `EventPolicyRevoked`   | `event_policy_revoked` | `{ by: Address }` |

The decision event's layout is `[event_auth_checked, <allowed|blocked>, <reason>]`
(`result` and `reason` are the struct's `#[topic]` fields). The reason vocabulary
is the same set of symbols `src/reasons.ts` mirrors from the contract's `Error`
enum.

## Consequence for the telemetry listener

The listener (Phase 2.4) filters on `event_auth_checked` and reads the decision
from topics, requiring no payload decoding. It must consume **both** streams:
committed ledger events for allowed decisions and administrative actions, and
enforced-simulation diagnostic events for blocked ones — because a refusal is
never committed, and a listener that only tails the ledger would see a guard that
appears to never block anything. (The opt-in third stream for post-inclusion
failures is described below.)

## Follow-up for the contracts repo (maintainer)

The contracts repo's own documentation is internally inconsistent on this topic
name (`auth_checked` in `SPEC.md` §9 and `tests/fixtures/README.md` line 86,
`event_auth_checked` in its fixture logs and `docs/verification.md`). It is out of
scope for this repo to edit, but it should be reconciled there — the SPEC is the
document a third-party integrator reads first.

## Failed-transaction diagnostics (`stream: "failed_tx"`, issue #58)

### Spike result: the capability exists in the pinned SDK

A transaction can pass enforced pre-flight and still fail after inclusion — a
stale-ledger resource pricing race did exactly that (see
`tests/fixtures/integration-evidence.md`). Its Soroban auth events roll back
like a blocked simulation's, so `getEvents` never returns them, but unlike the
simulation path the RPC preserves them on the transaction itself. The spike
(inspected 2026-09-27) confirms the pinned SDK exposes this publicly, so issue
#58 was implemented as **Path A**, with no casts, no private internals, and no
new network client:

- **Pinned version:** `@stellar/stellar-sdk` **17.0.1**
  (`package.json`: `"^17.0.1"`; `package-lock.json` resolves exactly
  `17.0.1`, and the installed `node_modules` copy is `17.0.1`).
- **Public response type:** `Api.GetFailedTransactionResponse` declares
  `diagnosticEventsXdr?: DiagnosticEvent[]` —
  `node_modules/@stellar/stellar-sdk/lib/esm/rpc/api.d.ts:61`. The same field
  appears on `Api.TransactionInfo` (api.d.ts:154), which
  `Api.GetTransactionsResponse.transactions` carries. The element type is the
  public `xdr.DiagnosticEvent`
  (`lib/esm/xdr/generated/diagnostic-event.d.ts`), whose `event` is a
  `ContractEvent` with `body.v0.{topics,data}` as `ScVal`s.
- **Populated at runtime, not just declared:** `parseTransactionInfo` maps each
  base64 entry with `DiagnosticEvent.fromXdr(e, "base64")` for every
  `getTransaction`/`getTransactions` response that carries the field
  (`lib/esm/rpc/parsers.js:74`). `Api.RawGetTransactionResponse`
  (api.d.ts:106) documents the same field in its raw form.
- **The issue's spelling was wrong:** the field is `diagnosticEventsXdr`, not
  `diagnosicEvents` or `diagnosticEvents` — worth pinning here because a
  future reader will look for the issue's spelling first.
- **Discovery mechanism:** `rpc.Server.getTransactions` is public in 17.0.1
  (`lib/esm/rpc/server.d.ts:553`), with its own `cursor` returned in
  `Api.GetTransactionsResponse` (api.d.ts:147) and requested via
  `pagination: { cursor }` (`Api.GetTransactionsRequest`, api.d.ts:167).

### Semantics

A `failed_tx` GuardEvent is a diagnostic that **was** attached to a transaction:

- `stream: "failed_tx"`, `source: "diagnostic"` — it rolled back, so it is not
  a committed contract event. Existing `source` values and the events emitted
  by the pre-existing streams are unchanged; `stream` is purely additive.
- `transactionHash` and `ledger` are filled from the failed transaction (this
  is the only diagnostic stream that knows both); `ledgerClosedAt` stays null
  because the RPC returns `createdAt` as unix seconds here, not the ISO close
  time the field carries elsewhere.
- Decoding reuses the canonical engine (`interpret` + the `event_auth_checked`
  topic rules of `src/events.ts`); no separate decoder exists.

### How failed transactions are discovered, and cursor interaction

`GuardTelemetryListener` gains an **opt-in** `failedTx: boolean` (default
off — existing polling cadence, yields, and cursor behavior are untouched).
When enabled, each `watch` cycle runs a second, independent scan alongside the
committed `getEvents` poll:

- **Discovery:** `server.getTransactions` pages through *all* transactions by
  ledger, using its own cursor.
- **When `getTransaction`-class diagnostics are read:** for every page entry
  with `status: FAILED`, the listener reads `diagnosticEventsXdr`, keeps only
  diagnostics whose emitter contract equals the guard (XDR `ContractId` bytes
  → `StrKey.encodeContract`, the conversion `scripts/capture-event.ts`
  documents), and drops every other topic via the same `KNOWN_TOPICS` filter
  the other streams use — host `fn_call`/`core_metrics` noise is not surfaced.
- **Cursor interaction:** the two cursors are never exchanged. The committed
  `getEvents` cursor advances only from `getEvents` responses, exactly as
  before; the `getTransactions` cursor advances only from `getTransactions`
  responses. A failed_tx diagnostic therefore **cannot** be skipped because
  the events cursor moved: the tx stream is a different RPC method with a
  longer retention window, so a listener that was down or slow resumes from
  its own tx cursor and still retrieves the diagnostics. The committed cursor
  is never advanced by failed_tx processing.
- **Deduplication:** the transaction hash is the checkpoint identifier. A
  process-local set (trimmed oldest-first past 1,000 entries) suppresses
  re-emission when a page is re-read after an error mid-page, or when the
  scan resumes before the cursor moves. Across a listener restart the set is
  empty and the tx scan resumes from its cursor — an at-least-once delivery
  semantic, the same one the committed stream has when no cursor was
  persisted. There is deliberately no cross-restart cursor persistence: the
  listener's existing contract leaves cursor ownership to the caller.
- **Error handling:** a malformed diagnostic is skipped, not propagated; a
  failed `getTransactions` call leaves the tx cursor untouched so the page is
  retried, and never corrupts the committed stream (the scan runs inside its
  own try/catch in `watch`, matching `poll`'s skip-not-throw convention).

### Limitations

- **At-least-once, process-local dedup.** After a restart, a failed
  transaction still inside the tx stream's retention window may be re-surfaced
  once. True exactly-once needs a caller-persisted tx cursor (see above).
- **No Soroban ↔ in-ledger retention guarantee.** Soroban RPC prunes
  `getTransactions` history on its own schedule; a listener that is offline
  longer than that window will not see older failures.
- **Emission requires the emitter attribution.** A guard event whose emitter
  bytes cannot be attributed to the guard is not surfaced from the tx stream
  (the committed and simulation streams, which the RPC already scopes, are
  unaffected).
- **Test fixtures are typed reconstructions**, not live captures: built with
  the public `xdr.DiagnosticEvent`/`ContractEvent` constructors of 17.0.1 in
  the documented response shape, carrying the live-verified topic vocabulary.
  No real failed-auth transaction hash was available as evidence at
  implementation time (the live suite's blocks are all pre-broadcast, so they
  have no hash), and none is claimed.
