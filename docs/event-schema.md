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
