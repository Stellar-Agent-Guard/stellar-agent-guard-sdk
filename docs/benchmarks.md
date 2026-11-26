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

CI runs `npm run bench:compare` informationally and never fails the build on wall-time
(`.github/workflows/ci.yml`, the `decode-path benchmarks (informational)` step,
`continue-on-error: true`). Shared GitHub runners have noisy, virtualised CPUs,
a shared L2 cache, and neighbours running unrelated work; a timing threshold
derived from any committed baseline would flake on exactly the runner class CI
uses. The honest use of a benchmark is a before/after comparison recorded in a
PR's description, on a machine where the only thing that changed is the code.

## Automated comparison & tolerance model (issue #495)

To catch regressions without manually inspecting raw console outputs:

```bash
npm run bench:compare
```

1. **Automated Delta Calculation:** Compares current median times against the committed baseline above and surfaces a table of Current vs Baseline vs Delta % in the CI job summary (`$GITHUB_STEP_SUMMARY`).
2. **Tolerance Rationale:** A generous tolerance of **50%** is used. Virtualized runner CPUs exhibit standard deviation spikes up to ~30-40% under noisy neighbour conditions. The 50% margin prevents noise from flagging false alarms while immediately highlighting genuine regressions (>50% slowdown).
3. **Advisory, Never Gating:** The step is strictly informational (`continue-on-error: true`). Timing noise will never redden a PR build or block merges.
4. **Explicit Re-baselining:** To update the committed baseline numbers when code optimizations land:
   ```bash
   npm run bench:rebaseline -- --reason="Optimized ScVal Vec traversal in decodePolicy"
   ```
   An explicit `--reason` argument is required, ensuring any baseline change is accompanied by a documented, reviewed justification.
