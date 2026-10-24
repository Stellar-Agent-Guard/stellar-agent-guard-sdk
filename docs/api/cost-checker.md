# CostPreChecker API

`CostPreChecker` evaluates expected transaction fees against an optional ceiling before broadcast, and optionally exposes additive policy-relative context (`policyContext`).

## Constructor

```ts
constructor(options: CostPreCheckConfig)
```

### Options

- `interceptor: Pick<PreFlightInterceptor, "check">` — Configured interceptor instance whose simulation prices execution
- `maxFeeStroops?: bigint` — Maximum allowable total fee in stroops (omitted means price it, never object). Must be a non-negative `bigint`; a negative value or any non-`bigint` throws `InvalidFeeCeilingError` at construction. `0n` is a real ceiling, not the same as omission.
- `policySource?: string | PolicyConfig | null` — Opt-in policy source (contract address or `GuardPolicy`/`PolicyConfig`) enabling additive `policyContext`
- `policy?: string | PolicyConfig | null` — Alias for `policySource`
- `windowSnapshot?: WindowSpendSnapshot | null` — Opt-in ledger-tied window-spend snapshot used to compute `policyContext.windowRemainingEstimate` (issue #311). Purely informational: it never changes the cost decision. Invalid snapshots (fractional/negative ledger, or a cap/spent that is not a non-negative `bigint`) throw `TypeError` at construction.
- `windowSnapshotMaxAgeLedgers?: number` — How many ledgers a snapshot may predate the priced check's own ledger and still be used. Default `0`: only a snapshot observed at the same ledger is trusted. Must be a non-negative safe integer.

Malformed ceilings are rejected before the interceptor runs, so a bad budget policy cannot spend an RPC call or be hidden behind a guard verdict. `InvalidFeeCeilingError` extends `InvalidInputError` (itself a `TypeError`) and exposes `field`, `rule: "non_negative_bigint"` and the rejected `value`.

## Methods

### `check(call: ContractCall, options?: { policySource?: string | PolicyConfig | null; maxFeeStroops?: bigint; windowSnapshot?: WindowSpendSnapshot | null }): Promise<CostPreCheckResult>`

Returns `CostPreCheckResult` (`CostDecision`), a discriminated union:
- `{ kind: "within_budget", allowed: true, totalFeeStroops, resourceFeeStroops, inclusionFeeStroops, footprintKeys, feeCeilingStroops, policyContext, provenance }`
- `{ kind: "over_budget", allowed: false, totalFeeStroops, resourceFeeStroops, inclusionFeeStroops, footprintKeys, feeCeilingStroops, policyContext, provenance }`
- `{ kind: "blocked", allowed: false, reason, explanation, detail, totalFeeStroops: 0n, resourceFeeStroops: 0n, inclusionFeeStroops: 0n, policyContext, provenance: null }`
- `{ kind: "undetermined", allowed: false, detail, totalFeeStroops: 0n, resourceFeeStroops: 0n, inclusionFeeStroops: 0n, policyContext, provenance: null }`

### Ledger Provenance (`provenance`)

Priced decisions carry the ledger marker of the simulation that produced the quote:

```ts
provenance: { ledger: number } | null
```

- `ledger` is `latestLedger` read from the **same** enforced simulation, not from a second `getLatestLedger()` call that could race ahead of the state actually priced.
- `null` means the simulation did not establish a usable ledger (absent, non-numeric, fractional, negative or unsafe integer). The SDK never fabricates a ledger number.
- This is **informational only**: it identifies the snapshot a quote describes. It is not a promise that a transaction will land in that ledger, and a quote may be stale by submission time.
- `blocked` and `undetermined` decisions are not simulation-priced, so their `provenance` is always `null`.

### Policy Context (`policyContext`)

When an opt-in policy source is configured, `policyContext` exposes additive policy context derived from the live `check()` call:

```ts
policyContext: {
  perTxCapOk: boolean | null;
  windowRemainingEstimate: number | null;
  reason: string | null;
} | null
```

- `perTxCapOk`: Whether the transaction fits the policy's per-transaction limit (`true` if within cap, `false` if per-tx cap exceeded, or `null` if not determinable).
- `windowRemainingEstimate`: Estimated remaining headroom in the current rolling window **after this call's transfer amount**, computed from an explicit ledger-tied window-spend snapshot (issue #311, see below). `null` unless the snapshot, the check's ledger, and the transfer amount are all known. Note that `null` means "not available / cannot be determined from the current contract state", **not** a zero remaining budget: the SDK never fabricates a zero budget, and a `0` here is always a computed result (the window is exactly spent or overspent).
- `reason`: The contract's policy block reason if blocked (e.g. `"window_cap_exceeded"` or `"per_tx_cap_exceeded"`), or `null` when allowed.
- When no policy source is configured, `policyContext` is `null`.

### Window-spend snapshot (`windowSnapshot`, issue #311)

`windowRemainingEstimate` is computed only from facts that are all known at
once. A caller (or operator tooling) that already has the guard's window
accounting hands it in explicitly, declared against the ledger where it was
observed:

```ts
interface WindowSpendSnapshot {
  /** Ledger sequence at which `windowSpentStroops` was observed. */
  ledger: number;
  /** The policy's rolling-window cap, in stroops. */
  windowCapStroops: bigint;
  /** Spend already recorded in that window at `ledger`, in stroops. */
  windowSpentStroops: bigint;
}
```

The SDK never fetches this state on the caller's behalf — that would be a
second RPC outside the one simulation that prices the call. The SDK's own
ledger-read helper shows one way to obtain it:

```ts
import { fetchGuardPolicyAndWindow, type WindowSpendSnapshot } from "stellar-agent-guard-sdk";

const { policy, windowSpent } = await fetchGuardPolicyAndWindow(server, GUARD_CONTRACT_ID);
const snapshot: WindowSpendSnapshot = {
  ledger: latestLedger, // the ledger the read observed
  windowCapStroops: policy!.window_cap,
  windowSpentStroops: windowSpent,
};
const decision = await checker.check(call, { windowSnapshot: snapshot });
```

The estimate is produced only when **all** of the following hold; otherwise it
stays `null`:

- the verdict is `admissible` — the only outcome that carries the ledger the
  policy check actually ran at (`provenance.ledger`);
- the snapshot's `ledger` is at or before that ledger and within
  `windowSnapshotMaxAgeLedgers` (default `0`) of it — a stale or future-dated
  snapshot describes different state and is treated as missing rather than
  adjusted for;
- the call's transfer amount is known (`transfer`'s third argument or
  `transfer_from`'s fourth).

The arithmetic is `cap − spent − amount`, clamped at zero, and reported as
`null` (not rounded) above `Number.MAX_SAFE_INTEGER`.

**The estimate is never an authorization input.** It does not change `kind`,
`allowed`, the fee ceiling outcome, or the pre-flight verdict — a snapshot is
present, absent, or stale, and the decision is identical either way. Blocked
and undetermined outcomes always report `null`: they carry no priced ledger to
tie a snapshot to.
