# Decode-path benchmarks

`check()` is RPC-bound end to end, but the work that surrounds the round trip —
encoding the policy to ScVal, decoding the verdict, decoding guard events out of
the simulation diagnostics — is pure CPU and runs on every call. For a fleet of
agents on an embedded runtime (a browser agent UI, an edge worker) that per-call
cost is what decides whether the guard fits the budget, so it is measured rather
than assumed.

These numbers are **informational**. They are a reference point to compare a
 change against on the same class of machine, not a pass/fail gate.

## How to run

```bash
nam run bench
```

The script is `benches/check-decode.bench.ts`, built on
[`tinybench`](https://github.com/tinylibs/tinybench) (`time: 1000` ms per task,
warmup enabled). The fixture builders live in `benches/fixtures.ts` and are
deterministic: addresses are derived from a hash, and the verdict and event
payloads are read from the committed
[`tests/fixtures/contract-fixtures.json`](../tests/fixtures/contract-fixtures.json)
so the benchmark cannot drift from the vocabulary the SDK actually supports.

## Targets

| Target | Function | Input |
| --- | --- | --- |
| Encode | `policyToScVal` | An 8192-entry allowlist (`LARGE_POLICY_ENTRIES`) — the contract-side worst case |
| Policy decode | `decodePolicy` | The ScVal produced by the encode target |
| Verdict decode | `decodeCheckResult` | Every committed outcome in `contract-fixtures.json` (20 payloads) |
| Event decode | `guardEventsFromDiagnostics` | 20 raw diagnostic events built from the fixture's base64 `ScVal` topics |

The three targets the issue names are encode, verdict decode, and event decode.
`decodePolicy` is the read-side counterpart of the encode target and costs
nothing to measure alongside it, so it is included.

## Baseline

Measured 2026-09-28 on:

- Node `v22.23.1` (the package targets Node >= 24; the numbers move with the runtime)
- Linux 6.17, x86_64
- Intel Core i7 (i5-6300U) @ 2.40 GHz

| Target | ops/sec (mean) | median ms/op |
| --- | ---: | ---: |
| `policyToScVal` (8192-entry allowlist) | 29 | 33.98 |
| `decodePolicy` (8192-entry allowlist) | 8 | 135.83 |
| `decodeCheckResult` (20 outcomes) | 2,061,496 | 0.0005 |
| `guardEventsFromDiagnostics` (20 diagnostic events) | 1,990 | 0.4849 |

Reading the numbers:

- The verdict decode is effectively free (sub-microsecond per payload), which is
  what should be true of a discriminated-union tag check.
- The event decode is roughly half a millisecond for a twenty-event batch — the
  cost is the base64 `ScVal` parsing per topic, not the batch size.
- The two policy operations dominate because they walk an 8192-element `Vec` twice (once to build, once to validate) at worst-case size. A realistic policy
  with a handful of recipients is orders of magnitude below the encode column.

## Why there is no CI gate

CI runs `npm run bench` informationally and never fails the build on wall-time
(`.github/workflows/ci.yml`, the `decode-path benchmarks (informational)` step,
`continue-on-error: true`). Shared GitHub runners have noisy, virtualised CPUs,
a shared L2 cache, and neighbours running unrelated work; a timing threshold
derived from any committed baseline would flake on exactly the runner class
CI uses. The honest use of a benchmark is a before/after comparison recorded in
a PR's description, on a machine where the only thing that changed is the code.

When a change to the decode path needs a number, run `npm run bench` before and
after on the same machine and quote both in the PR — do not trust the committed
baseline across machines.

## Micro-optimization journal

This section records targeted decode-path micro-optimisations and their before/
after numbers, as required by the perf-justified-by-bench-numbers issue. Each entry is a
single function and a single change; no algorithmic rewrites are in scope.

### Entry 1 — `decodeAuthDecision` (`src/events.ts`)

**Change:** consolidate the topic-slot reads into a single pass and order the
guards so an empty / non-auth topic list bails out before touching the result/r
reason slots. No behaviour change: the same `topics[0]`/`topics[1]`/`topics[2]`
checks run in the same order, and the empty-symbol normalisation is unchanged.

**Bench:** `guardEventsFromDiagnostics` (20 diagnostic events), before and
after on the same machine as the baseline above. The function is not on its own
bench task, so the before/after is recorded against the event-decode target that
exercises it.

| Run | ops/sec (mean) | median ms/op |
| --- | ---: | ---: |
| before | 1,990 | 0.4849 |
| after | 1,994 | 0.4839 |

**Reading:** the win is within run-to-run noise (below 1%), and the change is
primarily a clarity/ordering cleanup. The honest finding is that this hot path is
already dominated by the base64 `ScVal` parsing in the caller, not by the
topic-slot lookups in `decodeAuthDecision`. The change is kept because it is
behaviour-preserving and makes the hot path explicit, but it is not claimed as a
meaningful performance win.

### Entry 2 — `reasonNameFromCode` (`src/reasons.ts`)

**Change:** none. The `BY_CODE\ `Map` is already built once at module load and the
lookup is a constant-time `Map.get`. There is nothing material to hoist or
localise here.

**Bench:** the vocabulary lookup is not on its own task; it is exercised by
`decodeCheckResult`, which is already sub-microsecond per payload in the
baseline. No action needed.

### Entry 3 — `GuardBlockedError.toJSON` (`src/reasons.ts`)

**Change:** none. The object spread churn is on the error-construction path, not
the decode path, and the constructor is called at most once per blocked call.

**Bench:** the bench harness does not exercise `GuardBlockedError`, and adding a
task for it would be out of scope for this issue. No action needed.

### Entry 4 — canonical-JSON key ordering

**Change:** none. The canonical-JSON serializer has not landed in this repo, so
there is no order table to precompute. This is a follow-up for the serializerissue, not this one.

**Bench:** not applicable. No action needed.
