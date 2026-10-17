#!/usr/bin/env node
/**
 * Decode-path micro-benchmarks (issue #89, perf follow-up).
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
 * Each target is measured twice: once through the public entry point and once
 * through a `*Baseline` shim that reproduces the pre-optimization code path
 * (regex recompilation, repeated xdr field access, object-spread normalization).
 * The delta between the two rows is the number the perf PR cites; if it is not
 * material the row is dropped and the finding is recorded in docs/benchmarks.md.
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
  decodeCheckResultBaseline,
  decodePolicyBaseline,
} from "./baselines.ts";
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

const bench = new Bench({ time: 1000, name: "stellar-agent-guard-sdk decode path" });

bench.add(`policyToScVal (${LARGE_POLICY_ENTRIES}-entry allowlist)`, () => {
  policyToScVal(policy);
});

bench.add(`decodePolicy (${LARGE_POLICY_ENTRIES}-entry allowlist)`, () => {
  decodePolicy(encodedPolicy);
});

bench.add(`decodePolicy baseline (${LARGE_POLICY_ENTRIES}-entry allowlist)`, () => {
  decodePolicyBaseline(encodedPolicy);
});

bench.add(`decodeCheckResult (${payloads.length} fixture outcomes)`, () => {
  for (const payload of payloads) decodeCheckResult(payload.raw);
});

bench.add(`decodeCheckResult baseline (${payloads.length} fixture outcomes)`, () => {
  for (const payload of payloads) decodeCheckResultBaseline(payload.raw);
});

bench.add(`guardEventsFromDiagnostics (${events.length} diagnostic events)`, () => {
  guardEventsFromDiagnostics(events, FIXTURE_GUARD);
});

bench.add(`guardEventsFromDiagnostics baseline (${events.length} diagnostic events)`, () => {
  guardEventsFromDiagnosticsBaseline(events, FIXTURE_GUARD);
});

await bench.run();

console.log("stellar-agent-guard-sdk decode-path benchmarks");
console.log(
  "informational only: no wall-time gate (shared-runner noise makes a timing threshold meaningless)",
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

const byTask = new Map(summary.map((row) => [row.task, row]));
const deltas: Array<{ task: string; speedup: string; deltaMs: string }> = [];
for (const row of summary) {
  const baseline = byTask.get(`${row.task} baseline`);
  if (!baseline) continue;
  const speedup = row.opsPerSecond / baseline.opsPerSecond;
  deltas.push({
    task: row.task,
    speedup: `${speedup.toFixed(2)}x`,
    deltaMs: (baseline.medianMs - row.medianMs).toFixed(4),
  });
}

console.table(
  summary.map((row) => ({
    task: row.task,
    "ops/sec (mean)": row.opsPerSecond,
    "median ms/op": row.medianMs,
  })),
);

if (deltas.length > 0) {
  console.log("");
  console.log("optimized vs baseline (cite these in the PR / docs/benchmarks.md)");
  console.table(deltas);
}
