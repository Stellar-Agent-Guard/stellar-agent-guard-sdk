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
appears to never block anything.

## Event identity — `GuardEvent.id`

Every `GuardEvent` the SDK decodes, on **both** streams, carries a non-null,
stable `id`. The two streams need different schemes, because they fail identity
in opposite ways: a committed event has a transaction to point at, while a
blocked one was rolled back before broadcast and has nothing on-chain to point
at.

| Source | Format | Anchor |
|---|---|---|
| `ledger` | `ledger:<txHash>:<topic>` | the transaction that emitted it, plus its name topic |
| `diagnostic` | `diag:<sha256-hex>` | the event's own content (see below) |

**Committed events keep a txHash-based id.** A heartbeat transaction emits
*two* guard events — `event_auth_checked` and `event_heartbeat`, as the live
capture above shows — so `ledger:<txHash>` alone is not unique and the name
topic disambiguates. The id deliberately does **not** include the event's
position within a `getEvents` page: a page boundary (a different `limit`, a
resume from a cursor) would otherwise renumber an event that has not changed.
If an RPC response ever omits the hash, the ledger sequence anchors instead, so
an id is always produced.

**Diagnostic events are hashed**, from exactly this input, in this order:

```
"diagnostic" | <contractId> | <simulationIndex> | <topic>… | <stable-data>
```

- `contractId` — the guard, so two guards cannot share an id for the same event;
- `simulationIndex` — the event's position within its diagnostic batch, which is
  what keeps **two distinct blocks in one simulation distinct** after both have
  been rolled back and neither has a transaction;
- the decoded topic symbols, separator-escaped, so two different topic lists can
  never flatten to the same string;
- the decoded data, rendered canonically (object keys sorted, `bigint` and byte
  arrays rendered explicitly) so re-encoding the same value always hashes the
  same.

### Collision notes

- **Same event, re-parsed → same id.** The hash is a pure function of the inputs
  above, so re-decoding the same diagnostic payload (a retried pre-flight, a
  replayed simulation) produces the identical id. This is what lets a consumer
  de-duplicate a refusal that was re-observed.
- **Two separate simulations, identical event → same id.** If the same guard is
  blocked for the same reason by two different attempts of the same call, both
  events hash identically. That is intentional: the content is the same
  decision. A consumer that needs per-attempt identity should combine `id` with
  its own attempt counter rather than expecting a unique key per refusal.
- **Within one batch, collisions are not a practical concern.** SHA-256 plus the
  distinct batch positions make two events sharing an id a cryptographic accident
  rather than a structural one.
- **Cross-stream ids never collide**: the prefixes differ, and a diagnostic id is
  hashed from the `diagnostic` stream name regardless of how the event was
  observed.

Part of #7 (stable ids + unified stream). This slice delivers the id field only;
the unified stream and any persistence for the dashboard remain out of scope
there.

## Follow-up for the contracts repo (maintainer)

The contracts repo's own documentation is internally inconsistent on this topic
name (`auth_checked` in `SPEC.md` §9 and `tests/fixtures/README.md` line 86,
`event_auth_checked` in its fixture logs and `docs/verification.md`). It is out of
scope for this repo to edit, but it should be reconciled there — the SPEC is the
document a third-party integrator reads first.
