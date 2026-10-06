#!/usr/bin/env node
/**
 * Decode-path micro-benchmarks (issue #89).
 *
 * `check()` is RPC-bound end to end, but the work *around* the round trip — the
 * ScVal encode, the verdict decode, the event decode — is pure CPU that runs on
 * every call. For a fleet of agents on an embedded runtime (browser UI, edge
 * worker) that per-call cost is what decides whether the guard fits the budget,
 * so it is measured here rather than guessed at.
 *
 * Three targets, matching the issue:
 *
 *   1. encode          — `policyToScVal` over an 8192-entry allowlist
 *                        (`LARGE_POLICY_ENTRIES`), the contract-side worst case;
 *   2. verdict decode  — `decodeCheckResult` over every committed outcome in
 *                        `tests/fixtures/contract-fixtures.json`;
 *   3. event decode    — `guardEventsFromDiagnostics` over the fixture's raw
 *                        base64 `ScVal` diagnostic topics.
 *
 * A fourth target, `decodePolicy`, is included because it is the read-side
 * counterpart of target 1 and costs nothing to measure alongside it.
 *
 * The two targets whose per-op cost is below tinybench's own per-iteration
 * bookkeeping — `decodeCheckResult` (sub-microsecond per payload) and
 * `guardEventsFromDiagnostics` (sub-millisecond per batch) — also get a "hot
 * loop" variant that repeats the operation `HOT_LOOP_ITERATIONS` times per
 * sample, which amortises that bookkeeping and makes the sub-microsecond work
 * comparable across runs. The hot-loop numbers are what the optimization PRs in
 * this issue cite; the single-shot numbers are kept for continuity with the
 * baseline in `docs/benchmarks.md`.
 *
 * The two policy targets deliberately have no hot-loop variant. Their per-op
 * cost is already milliseconds (`npm run bench` measures ~39 ms for
 * `policyToScVal` and ~109 ms for `decodePolicy` over an 8192-entry allowlist),
 * so tinybench measures them fine as-is, well above its own bookkeeping floor. A
 * `x100` sample of a 109 ms operation is ~11 s, and tinybench runs at least 64
 * samples per task (`iterations`) plus 16 warmup samples, so those two variants
 * alone would add ~15 minutes to `npm run bench` — past the 15-minute
 * `timeout-minutes` on the informational `bench` CI job.
 *
 * This is a benchmark, not a test: it never asserts a wall-time threshold. CI
 * runs it informationally (see `.github/workflows/ci.yml`) and shared runners
 * are too noisy for a timing gate to mean anything. Compare numbers against the
 * committed baseline in `docs/benchmarks.md` on the same class of machine.
 */
import { Bench } from "tinybench";
import { decodeCheckResult, decodePolicy, policyToScVal } from "../src/policy.ts";
import { guardEventsFromDiagnostics } from "../src/telemetry.ts";
import {
  FIXTURE_GUARD,
  LARGE_POLICY_ENTRIES,
  diagnosticEvents,
  largePolicy,
  verdictPayloads,
} from "./fixtures.ts";

const policy = largePolicy();
const encodedPolicy = policyToScVal(policy);
const payloads = verdictPayloads();
const events = diagnosticEvents();

const HOT_LOOP_ITERATIONS = 100;

const bench = new Bench({ time: 1000, name: "stellar-agent-guard-sdk decode path" });

bench.add(`policyToScVal (${LARGE_POLICY_ENTRIES}-entry allowlist)`, () => {
  policyToScVal(policy);
});

bench.add(`decodePolicy (${LARGE_POLICY_ENTRIES}-entry allowlist)`, () => {
  decodePolicy(encodedPolicy);
});

bench.add(`decodeCheckResult (${payloads.length} fixture outcomes)`, () => {
  for (const payload of payloads) decodeCheckResult(payload.raw);
});

bench.add(`guardEventsFromDiagnostics (${events.length} diagnostic events)`, () => {
  guardEventsFromDiagnostics(events, FIXTURE_GUARD);
});

bench.add(`decodeCheckResult hot loop x${HOT_LOOP_ITERATIONS}`, () => {
  for (let i = 0; i < HOT_LOOP_ITERATIONS; i++) {
    for (const payload of payloads) decodeCheckResult(payload.raw);
  }
});

bench.add(`guardEventsFromDiagnostics hot loop x${HOT_LOOP_ITERATIONS}`, () => {
  for (let i = 0; i < HOT_LOOP_ITERATIONS; i++) guardEventsFromDiagnostics(events, FIXTURE_GUARD);
});

await bench.run();

console.log("stellar-agent-guard-sdk decode-path benchmarks");
console.log(
  "informational only: no wall-time gate (shared-runner noise makes a timing threshold meaningless)",
);
console.log("");
console.log(
  `hot-loop tasks repeat the operation ${HOT_LOOP_ITERATIONS}x per sample; divide median ms/op by ${HOT_LOOP_ITERATIONS} for per-op cost`,
);
console.log("");

const summary: Array<{ task: string; opsPerSecond: number; medianMs: number }> = [];
for (const task of bench.tasks) {
  const result = task.result;
  if (result.state !== "completed") {
    console.error(`benchmark task "${task.name}" did not complete: ${result.state}`);
    process.exitCode = 1;
    continue;
  }
  summary.push({
    task: task.name,
    opsPerSecond: Math.round(result.throughput.mean),
    medianMs: Number(result.latency.p50.toFixed(4)),
  });
}

console.table(
  summary.map((row) => ({
    task: row.task,
    "ops/sec (mean)": row.opsPerSecond,
    "median ms/op": row.medianMs,
  })),
);
