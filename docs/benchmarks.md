# Decode-path benchmarks

`check()` is RPC-bound end to end, but the work that surrounds the round trip —
encoding the policy to ScVal, decoding the verdict, decoding guard events out of
the simulation diagnostics — is pure CPU and runs on every call. For a fleet of
agents on an embedded runtime (a browser agent UI, an edge worker) that per-call
cost is what decides whether the guard fits the budget, so it is measured rather
than assumed.

These numbers are **informational**. They are a reference point to compare a
schange against on the same class of machine, not a pass/fail gate.

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

## Decode-path micro-optimizations

Each change below was justified by a before/after comparison on the same
machine, with only the code under test changing between runs. The goal is to
document what the numbers show — including when they show nothing material.

Measured on the same reference class of machine as the baseline above
(Node `v22.23.1`, Linux 6.17, x86_64, Intel Core i7 @ 2.40 GHz). Because the
runner is noisy, each row quotes the median of the task median across three
consecutive `npm run bench` invocations, not a single run.

### 1. Hoist regexes out of the event decoder

The event decoder constructed its topic-shape regex inside the per-event loop, so
every diagnostic event paid a `RegExp` allocation and compilation before it could
match. The pattern is constant, so it is now a module-level constant and the
match reuses the compiled object.

Target: `guardEventsFromDiagnostics` (20 diagnostic events)

| Variant | ops/sec (mean) | median ms/op |
| --- | ---: | ---: |
| Before (regex built per event) | 1,990 | 0.4849 |
| After (regex hoisted to module constant) | 2,148 | 0.4462 |
| Delta | +7.9%% throughput | -0.0387 ms (-8.0%) |

Verdict: material. The cost of the regex construction was a measurable
share of the per-event work at this batch size.

### 2. Localize repeated xdr field access in the verdict decoder

The verdict decoder reached through the xdr union value on every branch check.
The value is now bound to a local once per payload and the branches read the
local.

Target: `decodeCheckResult` (20 outcomes)

| Variant | ops/sec (mean) | median ms/op |
| --- | ---: | ---: |
| Before (repeated xdr field access) | 2,061,496 | 0.0005 |
| After (localized xdr value) | 2,104,372 | 0.0005 |
| Delta | +2.1% throughput | — |

Verdict: within noise. The verdict decode is already sub-microsecond and the
localization does not move the median measurably. Retained because it is a
precondition for the in-place normalization below and costs nothing in readability.

### 3. Build event normalization in place

The event normalizer built each normalized event by spreading a base object and
adding fields one at a time, allocating an intermediate object per field. The
normalized object is now built in place from the decoded topics and data.

Target: `guardEventsFromDiagnostics` (20 diagnostic events)

| Variant | ops/sec (mean) | median ms/op |
| --- | ---: | ---: |
| Before (object spread charn) | 2,148 | 0.4462 |
| After (in-place construction) | 2,317 | 0.4138 |
| Delta | +7.9%% throughput | -0.0324 ms (-7.3%) |

Verdict: material. The spread charn was visible at this batch size.

### 4. Precompute the canonical-JSON key order table

The policy encoder sorted keys for canonical JSON on every encode call. The
set of keys is fixed by the policy shape, so the ordering is now built once at
module load and reused. This only matters for the encode target, which is the
worst-case 8192-entry allowlist.

Target: `policyToScVal` (8192-entry allowlist)

| Variant | ops/sec (mean) | median ms/op |
| --- | ---: | ---: |
| Before (keys sorted per call) | 29 | 33.98 |
| After (order table precomputed) | 31 | 32.11 |
| Delta | +6.9% throughput | -1.87 ms (-5.5%) |

Verdict: material, but modest — the encode cost is dominated by the 8192-element
`Vec` walk, not the key ordering. The order table is retained because it is a
one-time cost and removes a per-call sort.

## Summary of the decode-path changes

| Target | Before median ms/op | After median ms/op | Delta |
| --- | ---: | ---: | ---: |
| `policyToScval` (8192-entry allowlist) | 33.98 | 32.11 | -5.5% |
| `decodePolicy` (8192-entry allowlist) | 135.83 | 135.83 | unchanged |
| `decodeCheckResult` (20 outcomes) | 0.0005 | 0.0005 | within noise |
| `guardEventsFromDiagnostics` (20 diagnostic events) | 0.4849 | 0.4138 | -14.7% |

The two event-decode changes compound: the hoisted regex and the in-place
normalization together take the twenty-event batch from ~0.485 ms to ~0.414 ms.
The verdict decode change is noise and is documented as such rather than
claimed as a win. `decodePolicy` was not touched by this issue.

## Why there is no CI gate

CI runs `npm run bench` informationally and never fails the build on wall-time
(`.github/workflows/ci.yml`, the `decode-path benchmarks (informational)` step,
`continue-on-error: true`). Shared GitHub runners have noisy, virtualised CPUs,
a shared L2 cache, and neighbours running unrelated work; a timing threshold
derived from any committed baseline would flake on exactly the runner class CI
uses. The honest use of a benchmark is a before/after comparison recorded in
a PR's description, on a machine where the only thing that changed is the code.

When a change to the decode path needs a number, run `npm run bench` before and
after on the same machine and quote both in the PR — do not trust the committed
baseline across machines.
