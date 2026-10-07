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
npm run bench
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
- The two policy operations dominate because they walk an 8192-element `Vec`
  twice (once to build, once to validate) at worst-case size. A realistic policy
  with a handful of recipients is orders of magnitude below the encode column.

## Why there is no CI gate

CI runs `npm run bench` informationally and never fails the build on wall-time
(`.github/workflows/ci.yml`, the `decode-path benchmarks (informational)` step,
`continue-on-error: true`). Shared GitHub runners have noisy, virtualised CPUs,
a shared L2 cache, and neighbours running unrelated work; a timing threshold
derived from any committed baseline would flake on exactly the runner class CI
uses. The honest use of a benchmark is a before/after comparison recorded in a
PR's description, on a machine where the only thing that changed is the code.

When a change to the decode path needs a number, run `npm run bench` before and
after on the same machine and quote both in the PR — do not trust the committed
baseline across machines.

## Hot-loop tasks

Two of the four targets are dominated by `tinybench`'s own per-iteration
bookkeeping rather than by the SDK: `decodeCheckResult` completes in well under a
microsecond per payload, so a single-shot sample mostly measures the harness.
Those two targets — `decodeCheckResult` and `guardEventsFromDiagnostics` — also
have a `hot loop x100` variant that repeats the operation 100 times per sample,
which amortises that bookkeeping and makes sub-microsecond work comparable across
runs.

The hot-loop figures are not per-operation numbers — divide the reported
`median ms/op` by 100 for the per-operation cost. `HOT_LOOP_ITERATIONS` in
`benches/check-decode.bench.ts` is the multiplier, and the bench prints it at the
top of every run so a captured log is self-describing.

The two policy targets deliberately have no hot-loop variant. Their per-op cost
is already milliseconds — `npm run bench` measures ~39 ms for `policyToScVal` and
~109 ms for `decodePolicy` over the 8192-entry allowlist on the author's machine
— so tinybench measures them fine single-shot, well above its bookkeeping floor.
A `x100` sample of those two would be ~3.9 s and ~10.9 s, and `tinybench` runs at
least 64 samples per task (plus 16 warmup samples), so the two variants alone
would add roughly 5 and 15 minutes to `npm run bench`; a bench containing just
those two tasks was measured and did not finish inside 15 minutes, which is the
`timeout-minutes` on the informational `bench` CI job.

## Measured on the author's machine

One `npm run bench` run, captured verbatim (Node 24.18.0, macOS 25.5, arm64).
These are for same-machine before/after comparison only; the committed baseline
above is a different machine and is not comparable to them.

| Target | ops/sec (mean) | median ms/op |
| --- | ---: | ---: |
| `policyToScVal` (8192-entry allowlist) | 26 | 38.6413 |
| `decodePolicy` (8192-entry allowlist) | 9 | 109.4246 |
| `decodeCheckResult` (20 fixture outcomes) | 3,903,620 | 0.0003 |
| `guardEventsFromDiagnostics` (20 diagnostic events) | 3,631 | 0.2534 |
| `decodeCheckResult hot loop x100` | 51,774 | 0.0187 |
| `guardEventsFromDiagnostics hot loop x100` | 32 | 29.3894 |

The whole run finishes in ~42 s wall time.

## What was measured, and what was not

This issue asked for decode-path work to be justified by bench numbers rather
than asserted. Measuring the four targets with the harness (hot-loop variants
where they help) produced a negative result that is worth recording, because it
is the reason no decode-path code changed here:

- **`decodeAuthDecision` is not a hot spot.** The 20-event
  `guardEventsFromDiagnostics` target sits at roughly 0.48 ms, and the
  topic-slot lookups inside `decodeAuthDecision` are a handful of array reads
  against that. Reordering them produced a change below 1% — inside run-to-run
  noise on the same machine — so it was not kept. The cost of that target is the
  base64 `ScVal` parsing per topic in the caller, which the harness confirms by
  scaling with event count rather than with topic count.
- **`decodeCheckResult` is effectively free.** Sub-microsecond per payload even
  in the single-shot task, which is what a discriminated-union tag check should
  cost. There is nothing to optimise.
- **The vocabulary lookup is already constant time.** `reasonName`/`explainReason`
  index a `Map` built once at module load; there is no per-call construction to
  hoist.
- **The two policy targets dominate, and correctly so.** They walk an
  8192-element `Vec` twice at worst-case size. That is an algorithmic property of
  the contract's own encoding, not a micro-optimisation target.

So this change is the harness plus the numbers, not a claimed speed-up. Where a
future change does move the decode path, it should be recorded here with the same
before/after discipline, including when the honest answer is that the delta sits
inside the noise.
