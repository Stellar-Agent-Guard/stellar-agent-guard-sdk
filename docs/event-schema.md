# Guard event schema — verified against the live chain

Phase 2.2 exists because the contract's event schema had only ever been read from
documentation. This document records what the chain actually emits, captured from
the live Phase 2 instance, and reconciles it with the contracts repo's source.

## Compatibility contract: what a consumer may rely on

This document is the SDK's de-facto API contract for anything that parses guard
events outside this package — the dashboard's telemetry feed, an indexer, an
alerting rule. Every field in the reference table below carries one of four
stability tiers, and the tier is a promise about **_minor releases of
`stellar-agent-guard-sdk`**. It is not a promise about the deployed contract,
which only moves when it is redeployed, and it is not a promise about the RPC,
which the SGK does not control.

| Tier | May change in a minor release | May not change |
| --- | --- | --- |
| **Stable** | Nothing without a documented breaking change and a migration note | The field's name, presence, type, and meaning |
| **Append-only** | New symbols or variants may appear | An existing symbol being re-spelled, re-meaning, or reused for a different case |
| **Best-effort** | Anything — the value is supplied by the host or the RPC, not by the SDK | (nothing: always keep a fallback) |
| **Internal** | Anything, without a release note | (nothing: not part of the surface; may be renamed or removed) |

Three rules follow from the tiers, and all three are already how this SGK
behaves:

1. **Tolerate unknown values of every append-only field.** Switch on them with a
   default. The listener applies the same rule one level down: an event whose
   name topic it does not recognise is dropped rather than guessed at
   (`interpret()` in `src/telemetry.ts` returns `null` for an unknown topic), so
   a new contract event does not surface to consumers until this SDK learns it.
2. **`null` is a real value on stream-dependent fields.** `ledger`,
   `ledgerClosedAt` and `transactionHash` are always `null` on the diagnostic
   stream, because a refusal never becomes a transaction — that is the
   pre-broadcast guarantee, not a missing value.
3. **Decode through the SGK, not by hand.** Raw topic lists arrive as XDR or as
   host-shaped objects and are Best-effort; the decoded `GuardEvent` is what the
   tiers below describe.

### Field reference

| Field | Produced by | Stability | Notes |
| --- | --- | --- | --- |
| `topic` (= topics[0]) | contract | **Stable** | Pinned to the chain-confirmed symbol (`event_auth_checked`, …), not to the SPEC's spelling — see the cross-check below. |
| topics[1] — decision result | contract | **Stable** | Closed set `allowed` \ | `blocked`. |
| topics[2] — reason symbol | contract | **Append-only** | Empty symbol on an allowed decision; `decodeAuthDecision` normalises it to `null`. New reasons may be added; existing symbols keep their meaning. |
| `kind` | SDK | **Append-only** | New event kinds may appear. Unknown name topics never reach a consumer (rule 1). |
| `decision.result` | SDK (from topics[1]) | **Stable** | |
| `decision.reason` | SDK (from topics[2]) | **Append-only** | `string \ | null`. Never re-spelled for the same condition. |
| `decision.source` | SDK | **Stable** | Closed set `ledger` \ | `diagnostic`. |
| `source` | SDK | **Stable** | Same closed set as `decision.source`. |
| `stream` | SDK | **Stable** | `committed` \ | `diagnostic`. Derived from `source`; present on every event. Additive (issue #67). |
| `contractId` | stream | **Best-effort** | May be `null`; the diagnostic stream only carries the contract the SDK was pointed at. |
| `ledger` | stream | **Best-effort** | `null` on the diagnostic stream; present only for committed events. |
| `ledgerClosedAt` | stream | **Best-effort** | Host-formatted timestamp; `null` on the diagnostic stream. |
| `observedAt` | SDK (unified stream) | **Best-effort** | ISO-8601 time `watchAll()` observed a diagnostic batch; `null` on the committed stream. Additive (issue #67). |
| `transactionHash` | stream | **Best-effort** | Always `null` on the diagnostic stream — a refusal has no transaction. |
| `data.at` (heartbeat) | contract payload | **Stable** | Unix seconds. Delivered as a string in JSON, normalised to `bigint` by the SGK to prevent >2>53 precision loss. |
| `data.by` (admin events) | contract payload | **Stable** | The acting admin address, for `event_initialized` / `event_frozen` / `event_unfrozen` / `event_policy_set` / `event_policy_revoked`. |
| `data` — any other key | contract / host | **Best-effort** | Not under SDK control. Normalised: strings of pure digits become `bigint`; other strings (e.g. ISO dates) are preserved. |
| `raw` | SDK (opt-in) | **Best-effort** | The undecoded source event, attached only when the decode was asked for it (`includeRaw: true`, issue #94). Committed → the `rpc.Api.EventResponse` object from `getEvents`; diagnostic → the host-shaped object the RPC returned. **Absent** (undefined) otherwise, so the default path retains nothing. Its exact shape is host-supplied and may change in any release; decode the event, use `raw` only as bug-report evidence. |
| Raw topic list (undecoded XDR / `ScVal` objects) | RPC | **Best-effort** | Host-shaped. Decode with `topicSymbols()` / `decodeAuthDecision()`. |
| `contractEventsXdr` grouping | RPC | **Best-effort** | An array of *groups*, one per contract — reading it as a flat list silently loses events (see "The capture"). |
| `GUARD_EVENT_TOPIGS` values | contract | **Stable** | The name-topic vocabulary. |
| `GUARD_REASON_CODES` numbers | contract | **Append-only** | Numeric codes are never renumbered and never reused; removed variants keep their number. |
| `describeGuardEvent()` text | SGK | **Internal** | A log line, not a format. Parse `GuardEvent`, not this string. |
| `poll()` `cursor` / `latestLedger` | RPC | **Best-effort** | Pagination is host-defined; treat as opaque. |
| `serializeEvent()` output | SDK | **Stable** | Canonical JSON line. Fixed key order and normalization policy — see below. |

### Canonical JSON serialization — `serializeEvent()`

`serializeEvent(event: GuardEvent): string` renders one event as a single-line
canonical JSON string, for shipping to a log sink as JSON-lines:

```ts
logger.info(serializeEvent(event)); // one line per event
```

The rendering is deterministic: the same event always serializes byte-for-byte
the same, so a stored line can be diffed and a golden-string test can pin it
(`tests/unit/serialize-event.test.ts`). The projection is **explicit**, not an
object spread, so adding a field to `GuardEvent` cannot silently change the
serialized shape.

**Key order** — identity, then stream facts, then the decoded decision and data,
matching the field reference above:

```
id → kind → topic → source → stream → contractId → ledger → ledgerClosedAt
   → observedAt → transactionHash → decision → data
```

and, nested inside `decision` (which is `null` when the event carries no
decision):

```
inside decision: result → reason → source
```

**Empty/absent fields — the drop-`undefined` policy:**
- A field whose value is `undefined` **omitted** from the output. Absence is
  expressed by the key not being present.
- `null` is **kept**. It is a real value on the stream-dependent fields
  (`ledger`, `ledgerClosedAt`, `transactionHash`, `observedAt`, `decision`), not
  a missing value, so a consumer can still distinguish "no transaction" from "not
  serialized".
- Inside an **array**, an `undefined` element is rendered as `null`, so indices
  stay stable.

**Non-JSON-safe values** are normalized per this repo's policy (the same rules
`.normalizeEventData` + `stableStringify` use for event identity):
- **`bigint` → decimal string.** `JSON.stringify` throws on a bigint, and the
  decoded `data.at` u64 arrives as one. Decimal (not the hashing form `…n`) is
  used so `JSON.parse` reads back an ordinary string.
-**`Uint8Array`/`Buffer` → `bytes:<hex>`**, the rendering `stableStringify`
  already uses.

**Round-trip:** `JSON.parse(serializeEvent(event))` is shape-equal to the input
modulo those normalizations — `bigint` becomes a decimal string, bytes become
`bytes:<hex>`, and `undefined` keys are absent.

`serializeEvent()` is a format; `describeGuardEvent()` remains **Internal** (a
log line, not a format), and the two are independent.

## How it was captured

`scripts/capture-event.ts` drives two real calls on the live Phase 2 instance
(`CAPGDEKK457RHKN4RYVUMDJTFHHDSG7R5HREQONKLYK7MFKC5WFENPP44`) and decodes every
event attributed to the guard:

1. an allowed `heartbeat()` — its events are committed ledger events, retrieved
   from `getTransaction(txHash)`, which is the same stream a telemetry listener
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

## Worked example — decoding real events end-to-end

This is the on-ramp the field reference above assumes you have already crossed: a
raw `getEvents` / simulation payload in, a decoded `GuardEvent` out, the reason
turned into an operator sentence. Two examples, because the guard emits into two
streams and only one of them is the ledger — see
[Consequence for the telemetry listener](#consequence-for-the-telemetry-listener).

### Example 1 — an allowed decision, committed to the ledger

**Raw payload.** A `getEvents` response for the guard, sliced to the two events a
single `heartbeat()` transaction emitted. Topic and value fields are the RPC's
base64 `ScVal`-XDR form, not decoded JSON.

- **Provenance:** transaction
  `74751b83d9ffdba3d9aea6b0c24cae866b536a802724085bb88bbeaa72f8d970`, ledger
  `4673929`, captured 2026-09-14 (the live capture recorded above). The topic XDR
  is the committed golden vocabulary for those symbols in
  [`tests/fixtures/contract-fixtures.json`](../tests/fixtures/contract-fixtures.json)
  (`allowed` → `AAAADwAAAAdhbGxvd2VkAA==`).

```json
{
  "events": [
    {
      "type": "contract",
      "ledger": 4673929,
      "ledgerClosedAt": "2026-09-14T18:20:32Z",
      "contractId": "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
      "txHash": "74751b83d9ffdba3d9aea6b0c24cae866b536a802724085bb88bbeaa72f8d970",
      "topic": [
        "AAAADwAAABJldmVudF9hdXRoX2NoZWNrZWQAAA==",
        "AAAADwAAAAdhbGxvd2VkAA==",
        "AAAADwAAAAA="
      ],
      "value": "AAAAEQAAAAEAAAAA"
    },
    {
      "type": "contract",
      "ledger": 4673929,
      "ledgerClosedAt": "2026-09-14T18:20:32Z",
      "contractId": "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
      "txHash": "74751b83d9ffdba3d9aea6b0c24cae866b536a802724085bb88bbeaa72f8d970",
      "topic": ["AAAADwAAAA9ldmVudF9oZWFydGJlYXQA"],
      "value": "AAAAEQAAAAEAAAABAAAADwAAAAJhdAAAAAAABQAAAABqp/lQ"
    }
  ],
  "cursor": "...",
  "latestLedger": 4673930,
  "oldestLedger": 4590000
}
```

**The call.** One page of the listener's loop decodes both events; you never
hand-parse the topics.

```ts
import { GuardTelemetryListener } from "stellar-agent-guard-sdk";

const listener = new GuardTelemetryListener({ server, guard: GUARD });
const page = await listener.poll({ startLedger: 4_673_929 });
const [decision, heartbeat] = page.events; // GuardEvent[]
```

**The decoded `GuardEvent`s.** Comments mark the fields that carry the stream's
meaning; the full field list with stability tiers is the reference table above.

```ts
decision;
// {
//   id: "ledger:74751b83…:event_auth_checked",   // stable id — see “Event identity”
//   kind: "auth_checked",
//   topic: "event_auth_checked",
//   source: "ledger",                  // stream discriminator: this event committed
//   contractId: "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
//   ledger: 4673929,
//   ledgerClosedAt: "2026-09-14T18:20:32Z",
//   transactionHash: "74751b83d9ff…",
//   decision: { result: "allowed", reason: null, source: "ledger" },
//   data: {}
// }

heartbeat;
// {
//   id: "ledger:74751b83…:event_heartbeat",
//   kind: "heartbeat",
//   topic: "event_heartbeat",
//   source: "ledger",
//   ledger: 4673929,
//   decision: null,                     // only auth_checked carries a decision
//   data: { at: 1789393232n }           // unix seconds, from event data — not a topic
// }
```

The reason on that decision is `null`, not `""`: the chain sends the empty symbol
as topics[2] and the SDK normalises it (see "An allowed decision carries an empty
reason symbol" below). There is no explanation to look up for an allowed event —
`reason` is only meaningful on a block.

**Operator interpretation.** "The agent's heartbeat was authorised at ledger
4673929; the guard permitted it, so nothing was blocked and nothing was spent."

### Example 2 — a blocked decision, on the diagnostic stream

A refusal is never committed: the guard returns `Err`, the host rolls the event
back, so it is observable only as a diagnostic event on the failed enforced
simulation. That is why both streams matter.

**Raw payload.** A diagnostic event as the RPC attaches it to a failed
simulation — `event.body.v0.topics` is an array of `ScVal`s, and `event.body.v0.data`
is the (empty) data map.

- **Provenance:** the per-tx-cap violation (a `transfer` of 1100 against a 1000
  cap) from the live capture recorded above; the same topic XDR is committed in
  [`tests/fixtures/contract-fixtures.json`](../tests/fixtures/contract-fixtures.json)
  (`blocked_per_tx_cap_exceeded`).

```json
{
  "event": {
    "contractId": "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
    "type": "contract",
    "body": {
      "v0": {
        "topics": [
          "AAAADwAAABJldmVudF9hdXRoX2NoZWNrZWQAAA==",
          "AAAADwAAAAdibG9ja2VkAA==",
          "AAAADwAAABNwZXJfdHhfY2FwX2V4Y2VlZGVkAA=="
        ],
        "data": "AAAAEQAAAAEAAAAA"
      }
    }
  }
}
```

**The call.** `guardEventsFromDiagnostics` is the canonical entry point; it is
also what `telemetryFromDecision()` calls for you when you already hold a blocked
`PreFlightDecision`. Pass the guard address so the diagnostic `id` is scoped to
the right contract.

```ts
import { guardEventsFromDiagnostics, explainReason } from "stellar-agent-guard-sdk";

const [blocked] = guardEventsFromDiagnostics([diagnosticEvent], GUARD);
```

**The decoded `GuardEvent`.**

```ts
blocked;
// {
//   id: "diag:1f0c…",                // sha256 of the content — a block has no tx to anchor on
//   kind: "auth_checked",
//   topic: "event_auth_checked",
//   source: "diagnostic",            // stream discriminator: pre-broadcast, never committed
//   contractId: "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
//   ledger: null,                    // a refusal has no ledger — this is a fact, not a gap
//   ledgerClosedAt: null,
//   transactionHash: null,
//   decision: { result: "blocked", reason: "per_tx_cap_exceeded", source: "diagnostic" },
//   data: {}
// }
```

**Explanation lookup and operator interpretation.**

```ts
explainReason(blocked.decision!.reason ?? "");
// "The transfer amount exceeds the policy's per-transaction cap."
```

"This means the transfer was blocked on the pre-tx cap at the moment of the
enforced simulation: a 1100-unit transfer against a 1000-unit cap. Nothing was
broadcast, so there is no ledger or transaction hash to point at (the `null`s
above), and the attempt is identified by its content hash, not a tx hash."

### Reading the stream discriminator

Both `event.source` and `event.decision.source` are the same closed set —
`"ledger" | "diagnostic"` (tier: **Stable**) — and they are the field to branch
on. Do not infer the stream from `ledger === null`: a committed event whose RPC
response omitted the retention fields is still `source: "ledger"`. This SDK has
not merged the two streams into one shape with a distinct `stream` field; the
discriminator today is `source` (the unified-stream follow-up is tracked in
[Event identity](#event-identity--guardeventid)'s scope note). The `id` prefix
agrees with it: `ledger:` for committed events, `diag:` for pre-broadcast ones.

## What this changed

This is the on-ramp the field reference above assumes you have already crossed: a
raw `getEvents` / simulation payload in, a decoded `GuardEvent` out, the reason
turned into an operator sentence. Two examples, because the guard emits into two
streams and only one of them is the ledger — see
[Consequence for the telemetry listener](#consequence-for-the-telemetry-listener).

### Example 1 — an allowed decision, committed to the ledger

**Raw payload.** A `getEvents` response for the guard, sliced to the two events a
single `heartbeat()` transaction emitted. Topic and value fields are the RPC's
base64 `ScVal`-XDR form, not decoded JSON.

- **Provenance:** transaction
  `74751b83d9ffdba3d9aea6b0c24cae866b536a802724085bb88bbeaa72f8d970`, ledger
  `4673929`, captured 2026-09-14 (the live capture recorded above). The topic XDR
  is the committed golden vocabulary for those symbols in
  [`../tests/fixtures/contract-fixtures.json`](../tests/fixtures/contract-fixtures.json)
  (`allowed` → `AAAADwAAAAdhbGxvd2VkAA==`).

```json
{
  "events": [
    {
      "type": "contract",
      "ledger": 4673929,
      "ledgerClosedAt": "2026-09-14T18:20:32Z",
      "contractId": "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
      "txHash": "74751b83d9ffdba3d9aea6b0c24cae866b536a802724085bb88bbeaa72f8d970",
      "topic": [
        "AAAADwAAABJEVVVNVFRfSGVjbWFpY2hlZAA==",
        "AAAADwAAAAdhbGxvd2VkAA==",
        "AAAADwAAAAA="
      ],
      "value": "AAAAEQAAAAEAAAAAA"
    },
    {
      "type": "contract",
      "ledger": 4673929,
      "ledgerClosedAt": "2026-09-14T18:20:32Z",
      "contractId": "CAPADGEK457RHKN4RYVUSDJTGFHDSG7R5HREQOQKLYK7MFKC5WFEN"PP44",
      "txHash": "74751b83d9ffdba3d9aea6b0c24cae866b536a802724085bb88bbeaa72f8d970",
      "topic": ["AAAADwAAAA9lVVVNVFRfSGVjbWFpY2hlZAA="],
      "value": "AAAAEQAAAAEAAAABAAAADwAAAAJhdAAAAAAABQAAAABqp/lQ"
    }
  ],
  "cursor": "...",
  "latestLedger": 4673930,
  "oldestLedger": 4590000
}
```

**The call.** One page of the listener's loop decodes both events; you never
hand-parse the topics.

```ts
import { GuardTelemetryListener } from "stellar-agent-guard-sdk";

const listener = new GuardTelemetryListener({ server, guard: GUARD });
const page = await listener.poll();
for (const event of page.events) {
  console.log(event.kind, event.decision ?? "no decision");
}
```

### Example 2 — a blocked decision, only on the diagnostic stream

A refused call never becomes a transaction, so its decision is not in the
ledger. The committed stream will never carry it; the diagnostic stream does.
This is the reason `watchAll()` exists — see
[Consequence for the telemetry listener](#consequence-for-the-telemetry-listener).

## Start position — `startFrom`

By default the listener starts where the RPC's `getEvents` cursor defaults to,
which is "recent pages only" — history before that is not replayed. That
implicit default is useful for a clean watch, but it is unsuitable when a
consumer needs to backfill after a cursor-store gap, or wants to beexplicit about not replaying history. The optional `startFrom` option makes
the start position explicit:

```ts
type StartFrom = { ledge: number } | "latest" | "oldest-available";
```

| `starFrom` | Meaning | `getEvents` parameter sent |
| --- | --- | --- |
| `{ ledge: N }` | Backfill from ledger `N` inclusive. Use this after a cursor-store gap. | `startingLedger: N` (no `cursor`) |
| `'latest'` | Tail from now. The listener fetches the current cursor and discards anything below it, so the first delivered event is the first *new* one. | `cursor`: the current cursor from a probe page with `limit: 1`, no backlog emitted |
| `'oldest-available'` | Start at the oldest ledger the RPC retains. Use this for a full replay of retained history. | `startingLedger: the `response.oldestLedger` returned by the RPC |

**No history replay from `'latest'.** `'latest'` is the common case for a clean
watch: it deliberately skips everything already in the ledger. A consumer that
wants history must pass `{ ledge: N }` or omit `startFrom` and rely on the
RPC default. This is documented behaviour, not an accident.

**Interaction with a cursor store.** If the listener is constructed with a
persisted cursor (see the `cursorStore` option in the README) and `startFrom` is
also set, **`startFrom` wins**: the stored cursor is ignored for this run and a
log line is emitted noting the override. This is intentional — an explicit
`startFrom` is a operator action (a backfill or a clean watch) and should not be
silently defeated by a stale cursor. The store is still written to as events are
delivered, so the next run without `startFrom` resumes from the new position.

Example — tail from now, the common case:

```ts
import { GuardTelemetryListener } from "stellar-agent-guard-sdk";

const listener = new GuardTelemetryListener({
  server,
  guard: GUARD,
  startFrom: "latest", // no backlog; first event is the first new one
});

for await (const event of listener.watchAll()) {
  console.log(event.kind, event.decision ?? "no decision");
}
```

Example — backfill after a cursor-store gap:

```ts
const listener = new GuardTelemetryListener({
  server,
  guard: GUARD,
  startFrom: { ledge: 4670000 }, // replay from this ledger inclusive
});
```

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