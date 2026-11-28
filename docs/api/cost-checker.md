# CostPreChecker API

`CostPreChecker` evaluates expected transaction fees against an optional ceiling before broadcast, and optionally exposes additive policy-relative context (`policyContext`).

## Constructor

```ts
constructor(options: CostPreCheckConfig)
```

### Options

#### `CostPreCheckConfig` (`new CostPreChecker(config)`)

The SDK has no separate `CostPreCheckerOptions` type: the constructor takes `CostPreCheckConfig`. Every value is validated at construction.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `interceptor` | `Pick<PreFlightInterceptor, "check">` | required | Its `check()` supplies both the verdict and the price, from one enforced simulation. ⚠️ If that interceptor has `cache` enabled, the price can come from a cached verdict (up to one ledger / 5 s old). |
| `maxFeeStroops` | `bigint` | none — no ceiling; the price is reported, never objected to | Ceiling on the estimated **total** fee (resource + inclusion). Must be a non-negative `bigint`, otherwise `InvalidFeeCeilingError` at construction. `0n` is a real ceiling (every quote is then `over_budget`). ⚠️ Omitting it disables the fee check entirely. |
| `feeSource` | `"fixed" \| "rpc"` | `"fixed"` | Where the inclusion fee comes from. `"fixed"` is the SDK's declared one-operation fee, offline and deterministic. `"rpc"` reads `getFeeStats` once per priced check and quotes `percentile`. ⚠️ Fee stats are a prediction of the next ledger's fee market, not a guarantee; a failed read falls back to the fixed fee with a visible `provenance.fallbackReason`. Invalid values throw `InvalidInputError` at construction. |
| `percentile` | `"p50" \| "p90" \| "p99"` | `"p50"` | Soroban inclusion-fee percentile used in `"rpc"` mode. Validated at construction even in `"fixed"` mode. Invalid values throw `InvalidInputError`. |
| `server` | `rpc.Server` | none | RPC server used to read fee stats in `"rpc"` mode. Required in that mode unless `feeStats` is supplied. |
| `feeStats` | `() => Promise<FeeStatsResponse>` | none | Injectable fee-stats provider, winning over `server`. This is the offline test seam for fake stats; it never changes the fixed-fee default. |
| `warnAtRatio` | `number` in `(0, 1]` | off — no warning | Opt-in headroom warning: when `total / ceiling >= warnAtRatio`, a priced decision carries a structured `headroomWarning`. The boundary is inclusive. ⚠️ A warning never changes `kind` and never turns `within_budget` into `over_budget`. Invalid ratios throw `InvalidInputError` at construction. |
| `policySource` | `string \| PolicyConfig \| null` | none — `policyContext` is `null` | Contract address or policy enabling the additive `policyContext`. Informational only: it never changes the cost decision. |
| `policy` | `string \| PolicyConfig \| null` | none | Alias for `policySource`. Per-call values win over constructor values; `policySource` wins over `policy` at each level. |
| `logger` | `GuardLoggerInput` | none — silent | Log sink for the priced verdict and ceiling breaches. Never changes the decision. |
| `windowSnapshot` | `WindowSpendSnapshot \| null` | none — `policyContext.windowRemainingEstimate` is `null` | Ledger-tied window-spend snapshot for the remaining-window estimate. Informational only. An invalid snapshot throws `TypeError` at construction. ⚠️ A `null` estimate means unknown, never "zero budget left". |
| `windowSnapshotMaxAgeLedgers` | `number` | `0` | How many ledgers the snapshot may predate the priced check and still be used. Non-negative safe integer, otherwise `TypeError`. ⚠️ Raising it lets an older snapshot feed the estimate. |

#### `CostPreCheckOptions` (`check(call, options)` / `checkWithCost(call, options)`)

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `policySource` | `string \| PolicyConfig \| null` | the constructor's `policySource` / `policy` | Per-call policy source for `policyContext`. |
| `policy` | `string \| PolicyConfig \| null` | as above | Alias for `policySource`. |
| `maxFeeStroops` | `bigint \| string` | the constructor's `maxFeeStroops` | Per-call ceiling, validated before simulation. `0n` / `"0"` is kept, not treated as omission. |
| `windowSnapshot` | `WindowSpendSnapshot \| null` | the constructor's `windowSnapshot` | Per-call snapshot; an explicit `null` clears the configured one for this check. |
| `signal` | `AbortSignal` | none | ⚠️ Forwarded to the interceptor: a fired signal yields an `undetermined` verdict and therefore an `undetermined` cost decision carrying `RpcTimeoutError`. |
| `timeoutMs` | `number` | `DEFAULT_RPC_TIMEOUT_MS` (30 000 ms) per RPC call | ⚠️ A fired timeout is reported exactly like an abort, never as `within_budget`. `0` disables it. |

Malformed ceilings are rejected before the interceptor runs, so a bad budget policy cannot spend an RPC call or be hidden behind a guard verdict. `InvalidFeeCeilingError` remains the error for legacy wrong-type and negative-bigint inputs. Malformed strings and values above u64 throw `InvalidInputError`; both expose the offending field and an actionable validation detail.

## Methods

### `check(call: ContractCall, options?: { policySource?: string | PolicyConfig | null; maxFeeStroops?: bigint | string; windowSnapshot?: WindowSpendSnapshot | null }): Promise<CostPreCheckResult>`

Returns `CostPreCheckResult` (`CostDecision`), a discriminated union:
- `{ kind: "within_budget", allowed: true, totalFeeStroops, resourceFeeStroops, inclusionFeeStroops, footprintKeys, feeCeilingStroops, surplusStroops, headroomWarning, policyContext, provenance }`
- `{ kind: "over_budget", allowed: false, totalFeeStroops, resourceFeeStroops, inclusionFeeStroops, footprintKeys, feeCeilingStroops, surplusStroops: 0n, headroomWarning: null, policyContext, provenance }`
- `{ kind: "blocked", allowed: false, reason, explanation, detail, totalFeeStroops: 0n, resourceFeeStroops: 0n, inclusionFeeStroops: 0n, surplusStroops: null, headroomWarning: null, policyContext, provenance: null }`
- `{ kind: "undetermined", allowed: false, detail, totalFeeStroops: 0n, resourceFeeStroops: 0n, inclusionFeeStroops: 0n, surplusStroops: null, headroomWarning: null, policyContext, provenance: null }`

### Surplus (`surplusStroops`, issue #446)

Every cost decision reports how much room is left under the ceiling, in stroops, so a caller deciding whether to retry at a higher fee never has to subtract two bigints itself:

```ts
surplusStroops: bigint | null
```

- `ceiling - totalFeeStroops` when a ceiling exists, **clamped at zero**: an `over_budget` decision reports `0n` and its breach through `kind`, never a negative surplus.
- `null` — not `0n` — when no ceiling was configured. An absent ceiling means "no objection", not "no room left".
- `null` for `blocked` and `undetermined`: neither is a price judged against a ceiling.

The value is exact integer arithmetic over the same `totalFeeStroops` the decision carries, and `describeCostDecision()` includes it.

### Headroom warning (`headroomWarning`, issue #447)

A binary ceiling only says pass or fail. Set `warnAtRatio` to get an early, structured warning when a quote is close to the ceiling:

```ts
interface HeadroomWarning {
  kind: "headroom_warning";
  threshold: number;          // the configured warnAtRatio, e.g. 0.9
  usedRatio: number;          // total / ceiling, 4 decimal places (display only)
  totalFeeStroops: bigint;    // exact quoted total
  feeCeilingStroops: bigint;  // exact ceiling
  surplusStroops: bigint;     // exact remaining room
}
```

- Reached when `total * scale >= ceiling * numerator` in `bigint`, so the boundary at exactly the ratio is inclusive and floating-point rounding cannot move it.
- **A warning is not a refusal.** It leaves `kind`, `allowed` and `feeCeilingStroops` unchanged, and only `over_budget` (a real breach) is `allowed: false`.
- Off by default. `warnAtRatio` must be in `(0, 1]`; `0`, values above `1`, `NaN` and infinities throw `InvalidInputError` at construction.
- `within_budget` always carries the field (`null` when off or not reached). A breach carries `headroomWarning: null`, because the breach is the decision itself.

### Fee-source provenance and RPC pricing (issue #445)

`feeSource: "rpc"` quotes the **Soroban inclusion fee** from `getFeeStats` at
`percentile`, once per priced check, while the resource fee still comes from the
same enforced simulation as the verdict:

```ts
const checker = new CostPreChecker({
  interceptor,
  server,                 // or feeStats: () => myRpc.getFeeStats()
  feeSource: "rpc",
  percentile: "p90",
  maxFeeStroops: 50_000_000n,
});
```

- The quote and the verdict stay tied to the **same** simulation; fee stats add
  the inclusion component only. A refused or unpriced verdict makes no fee-stats
  RPC, because there is no quote to price.
- `provenance` records the source and ledger: `feeSource`, `percentile`,
  `feeStatsLedger`, and `ledgerSource: "fee_stats"` when the simulation exposed
  no ledger of its own.
- A failed or malformed response **falls back to the fixed fee** and sets
  `provenance.fallbackReason`. Fallback is never silent and never throws from the
  pricing path.
- Fee stats are a **prediction**, not a guarantee: the next ledger's fee market
  can move before submission, so a quote can still underpay. The fixed-fee
  default remains the offline, deterministic choice.

### `checkTransaction(transaction, options?): Promise<CostDecision>`

Prices an already-built Stellar SDK `Transaction` without rebuilding or
modifying its envelope. Set `networkPassphrase` in `CostPreCheckConfig`; a
mismatch is rejected with `InvalidInputError` before simulation. Pass
`options.simulation` when the exact transaction has already been simulated;
otherwise configure `server` and the checker simulates that envelope directly.
An unsuccessful or unpriceable simulation returns a fail-closed
`undetermined` decision. The total is the envelope's actual fee, with the
simulated resource fee separated from the remainder as inclusion fee.
Transaction quotes carry
`provenance: { ledger: number | null, source: "transaction" }` (the ledger is
null if the RPC response did not establish a usable sequence). Ordinary
`check()` quotes retain the interceptor's call path and mark known-ledger
provenance with `source: "call"`.

```ts
const decision = await checker.checkTransaction(transaction, {
  simulation: alreadySimulatedResponse,
  maxFeeStroops: "50000",
});
```

### Ledger Provenance (`provenance`)

Priced decisions carry the ledger marker and input path of the simulation that
produced the quote:

```ts
provenance: { ledger: number | null } | null
```

- `ledger` is `latestLedger` read from the **same** enforced simulation, not from a second `getLatestLedger()` call that could race ahead of the state actually priced. In `"rpc"` fee mode it may come from the fee-stats response instead (`ledgerSource: "fee_stats"`), and is `null` only when neither source established a usable ledger.
- `null` means no usable ledger was established (absent, non-numeric, fractional, negative or unsafe integer). The SDK never fabricates a ledger number.
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

## Worked fee breakdown (real testnet numbers)

This example uses the committed Phase 2 capture
[`tests/fixtures/rpc/simulate-success-status.json`](../../tests/fixtures/rpc/simulate-success-status.json),
recorded on **2026-09-27T14:30:52Z** against Stellar testnet and the Phase 2
guard `CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44`, at
`latestLedger` `4899176`. The same run's scenario evidence is in
[`tests/fixtures/integration-evidence.md`](../../tests/fixtures/integration-evidence.md)
(`npm run test:integration`).

The capture is a read-only `guard.status()` simulation, so its footprint is
smaller than a fund-moving `transfer`; the decomposition below is identical for
any call because it is driven entirely by the simulation's `minResourceFee`.

### 1. Raw simulation values

From the captured `simulateTransaction` response:

| Field | Value |
| --- | --- |
| `transactionData.resources.instructions` | `6,786,445` |
| `transactionData.resources.diskReadBytes` | `40,068` |
| `transactionData.resources.writeBytes` | `40,068` |
| `transactionData.resources.footprint.readOnly` | 3 keys |
| `transactionData.resources.footprint.readWrite` | 2 keys |
| `transactionData.resourceFee` / `minResourceFee` | `115,480,421` stroops |
| `latestLedger` | `4899176` |

### 2. Formula

`CostPreChecker` uses the simulation's price directly and adds the SDK's
declared inclusion fee for a one-operation envelope (`INCLUSION_FEE` in
`src/tx.ts`):

```text
resourceFeeStroops     = 115_480_421n   // BigInt(simulation.minResourceFee)
inclusionFeeStroops    = 100n           // INCLUSION_FEE (one operation)
totalFeeStroops        = 115_480_521n   // resourceFeeStroops + inclusionFeeStroops

formatFee(totalFeeStroops) = "11.5480521" XLM
```

The quote is exact integer stroops; there is no floating-point step. This is the
fee the envelope will declare, not a locally modelled estimate.

### 3. The same call under a loose and a tight ceiling

Loose ceiling (`maxFeeStroops: 200_000_000n`) — priced and allowed:

```ts
{
  kind: "within_budget",
  allowed: true,
  resourceFeeStroops: 115_480_421n,
  inclusionFeeStroops: 100n,
  totalFeeStroops: 115_480_521n,
  footprintKeys: 5,
  feeCeilingStroops: 200_000_000n,
  surplusStroops: 84_519_479n,
  headroomWarning: null,
  policyContext: null,
  provenance: { ledger: 4899176 },
  breakdown: {
    instructions: 6_786_445,
    diskReadBytes: 40_068,
    writeBytes: 40_068,
    readOnlyEntries: 3,
    readWriteEntries: 2,
    storageEntries: 5,
  },
}
```

Tight ceiling (`maxFeeStroops: 5_000_000n`) — same quote, refused on price:

```ts
{
  kind: "over_budget",
  allowed: false,
  resourceFeeStroops: 115_480_421n,
  inclusionFeeStroops: 100n,
  totalFeeStroops: 115_480_521n,
  footprintKeys: 5,
  feeCeilingStroops: 5_000_000n,
  surplusStroops: 0n,
  headroomWarning: null,
  policyContext: null,
  provenance: { ledger: 4899176 },
  breakdown: { /* same breakdown as above */ },
}
```

`over_budget` is not a guard refusal: the guard may still allow the call. It
means only that the quoted **total** exceeds the caller's ceiling, and nothing
was submitted. A guard `blocked` and an `undetermined` enforcement run both
report `resourceFeeStroops: 0n`, `inclusionFeeStroops: 0n`,
`totalFeeStroops: 0n` and `provenance: null` — a pre-flight refusal happens
before broadcast, so nothing is charged and there is no priced ledger.

### 4. What is refundable

| Component | Refundable? | Why |
| --- | --- | --- |
| `inclusionFeeStroops` (100) | **No** | The inclusion fee buys ledger space and is charged even when the transaction fails. |
| Resource fee — instructions | **No** | CPU metering is non-refundable. |
| Resource fee — ledger I/O and entries | **No** | Read/write bytes and entry accesses are non-refundable. |
| Resource fee — transaction size | **No** | Bandwidth/history size is non-refundable. |
| Resource fee — events and return value | **Yes** | Charged up front from the declared size, refunded for what was not produced. |
| Resource fee — ledger rent / TTL bumps | **Yes** | Charged from the declared rent, refunded to actual consumption. |

The SDK reports the resource fee as one aggregate (`resourceFeeStroops`); it does
not split the refundable and non-refundable parts inside it, and this quote is
the maximum the transaction may be charged. Any refund is settled by the network
after execution. The pre-flight check itself is free: it is a simulation, never
a broadcast, so a `blocked` or `over_budget` outcome spends no fee at all.

### 5. This is a snapshot

These numbers are a record, not a constant. Stellar's fee rates, the ledger's
storage state and the transaction's resource declaration all move, so a re-run
of the same call later will quote a different `minResourceFee` (and the
refundable portion may settle to a different charged amount). Treat the example
as an illustration of the decomposition; measure your own ceiling from a fresh
`check()`/`checkWithCost()` and refresh the capture with
`npm run capture:rpc-fixtures` rather than copying these figures into policy.
