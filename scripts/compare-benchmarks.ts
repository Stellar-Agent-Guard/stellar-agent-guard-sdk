#!/usr/bin/env node
/**
 * Benchmark comparison harness against committed baseline (issue #495).
 *
 * Runs decode-path micro-benchmarks and compares current median times against
 * the documented baseline in `docs/benchmarks.md`.
 *
 * Tolerance & Advisory Model:
 *   - The tolerance is generous (default 50%) to account for shared-runner CPU
 *     noise and virtualization variances.
 *   - Comparisons are strictly ADVISORY and never gate the build (exit code is always 0),
 *     ensuring runner noise does not break CI.
 *   - Formats a Current vs Baseline vs Delta comparison table in stdout and
 *     appends to $GITHUB_STEP_SUMMARY when running in GitHub Actions.
 *
 * Re-baselining:
 *   - Run with `--rebaseline --reason="<explanation>"` to update `docs/benchmarks.md`.
 *   - Enforces that re-baselining is an explicit, reviewed change with a documented reason.
 *
 * Usage:
 *   npm run bench:compare
 *   npm run bench:rebaseline -- --reason="Optimized Vec decoding in soroban engine"
 */
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { Bench } from "tinybench";
import { decodeCheckResult, decodePolicy, policyToScVal } from "../src/policy.ts";
import { guardEventsFromDiagnostics } from "../src/telemetry.ts";
import {
  FIXTURE_GUARD,
  LARGE_POLICY_ENTRIES,
  diagnosticEvents,
  largePolicy,
  verdictPayloads,
} from "../benches/fixtures.ts";

export const DEFAULT_TOLERANCE_PERCENT = 50;
const ROOT = resolve(process.cwd());
const DOCS_PATH = resolve(ROOT, "docs/benchmarks.md");

export interface BenchmarkBaseline {
  target: string;
  opsPerSecond: number;
  medianMs: number;
}

export interface BenchmarkComparison {
  target: string;
  currentMedianMs: number;
  baselineMedianMs: number;
  deltaPercent: number;
  status: "faster" | "within-tolerance" | "regression";
  message: string;
}

export function parseCommittedBaseline(docContent: string): Map<string, BenchmarkBaseline> {
  const map = new Map<string, BenchmarkBaseline>();
  const tableRegex = /\|\s*([^|\n]+?)\s*\|\s*([\d,]+)\s*\|\s*([\d.]+)\s*\|/g;

  let match: RegExpExecArray | null;
  while ((match = tableRegex.exec(docContent)) !== null) {
    const rawTarget = (match[1]?.trim() ?? "").replaceAll("`", "");
    const ops = Number(match[2]?.replaceAll(",", "").trim());
    const median = Number(match[3]?.trim());

    if (rawTarget && !Number.isNaN(ops) && !Number.isNaN(median) && ops > 0) {
      let key = rawTarget;
      if (rawTarget.startsWith("policyToScVal")) key = "policyToScVal";
      else if (rawTarget.startsWith("decodePolicy")) key = "decodePolicy";
      else if (rawTarget.startsWith("decodeCheckResult")) key = "decodeCheckResult";
      else if (rawTarget.startsWith("guardEventsFromDiagnostics"))
        key = "guardEventsFromDiagnostics";

      map.set(key, { target: rawTarget, opsPerSecond: ops, medianMs: median });
    }
  }
  return map;
}

export function evaluateComparison(
  currentMedianMs: number,
  baselineMedianMs: number,
  tolerancePercent = DEFAULT_TOLERANCE_PERCENT,
): { deltaPercent: number; status: "faster" | "within-tolerance" | "regression"; message: string } {
  if (baselineMedianMs <= 0) {
    return { deltaPercent: 0, status: "within-tolerance", message: "no baseline" };
  }
  const deltaPercent = Number(
    (((currentMedianMs - baselineMedianMs) / baselineMedianMs) * 100).toFixed(2),
  );

  if (deltaPercent > tolerancePercent) {
    return {
      deltaPercent,
      status: "regression",
      message: `⚠️ regression (+${deltaPercent}% > ${tolerancePercent}% tolerance)`,
    };
  }
  if (deltaPercent < -10) {
    return {
      deltaPercent,
      status: "faster",
      message: `🚀 faster (${deltaPercent}%)`,
    };
  }
  return {
    deltaPercent,
    status: "within-tolerance",
    message: `✅ within tolerance (${deltaPercent > 0 ? `+${deltaPercent}` : deltaPercent}%)`,
  };
}

export async function runBenchmarkSuite(
  iterations = 1000,
): Promise<Array<{ key: string; name: string; opsPerSecond: number; medianMs: number }>> {
  const policy = largePolicy();
  const encodedPolicy = policyToScVal(policy);
  const payloads = verdictPayloads();
  const events = diagnosticEvents();

  const bench = new Bench({ time: iterations, name: "decode-path comparison" });

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

  await bench.run();

  const results: Array<{ key: string; name: string; opsPerSecond: number; medianMs: number }> = [];
  const keys = ["policyToScVal", "decodePolicy", "decodeCheckResult", "guardEventsFromDiagnostics"];

  for (let i = 0; i < bench.tasks.length; i++) {
    const task = bench.tasks[i]!;
    const res = task.result;
    const key = keys[i] ?? task.name;
    results.push({
      key,
      name: task.name,
      opsPerSecond: res?.state === "completed" ? Math.round(res.throughput.mean) : 0,
      medianMs: res?.state === "completed" ? Number(res.latency.p50.toFixed(4)) : 0,
    });
  }

  return results;
}

export function rebaselineDocs(
  docContent: string,
  newResults: Array<{ key: string; name: string; opsPerSecond: number; medianMs: number }>,
  reason: string,
): string {
  if (!reason || reason.trim().length === 0) {
    throw new Error(
      "Re-baselining requires an explicit --reason argument justifying the updated baseline in docs/benchmarks.md.",
    );
  }

  const dateStr = new Date().toISOString().split("T")[0];
  let updated = docContent;

  for (const r of newResults) {
    const pattern =
      "(\\|\\s*`?" + r.key + "[^`|\\n]*`?\\s*\\|)\\s*[\\d,]+\\s*\\|\\s*[\\d.]+\\s*\\|";
    const regex = new RegExp(pattern);
    const formattedOps = r.opsPerSecond.toLocaleString("en-US");
    updated = updated.replace(regex, `$1 ${formattedOps} | ${r.medianMs} |`);
  }

  // Update or append rebaseline note
  const reasonNote = `\n<!-- rebaseline: ${dateStr} - ${reason} -->\n`;
  if (!updated.includes(reasonNote)) {
    updated = updated.replace(
      /(## Baseline[\s\S]*?Measured )[\d-]+/,
      `$1${dateStr} (Re-baselined: ${reason})`,
    );
  }

  return updated;
}

async function main() {
  const isRebaseline = process.argv.includes("--rebaseline");
  const reasonArg = process.argv.find((a) => a.startsWith("--reason="))?.split("=")[1];

  console.log("Running decode-path benchmark comparison harness...");
  const docContent = readFileSync(DOCS_PATH, "utf8");
  const baselineMap = parseCommittedBaseline(docContent);

  const currentResults = await runBenchmarkSuite(1000);

  if (isRebaseline) {
    if (!reasonArg || reasonArg.trim().length === 0) {
      console.error('Error: Re-baselining requires an explicit --reason="<explanation>" argument.');
      process.exit(1);
    }
    const updated = rebaselineDocs(docContent, currentResults, reasonArg);
    writeFileSync(DOCS_PATH, updated, "utf8");
    console.log(`Successfully re-baselined docs/benchmarks.md with reason: "${reasonArg}"`);
    return;
  }

  const comparisons: BenchmarkComparison[] = [];
  for (const r of currentResults) {
    const baseline = baselineMap.get(r.key);
    const baselineMedian = baseline ? baseline.medianMs : 0;
    const comp = evaluateComparison(r.medianMs, baselineMedian, DEFAULT_TOLERANCE_PERCENT);
    comparisons.push({
      target: r.name,
      currentMedianMs: r.medianMs,
      baselineMedianMs: baselineMedian,
      deltaPercent: comp.deltaPercent,
      status: comp.status,
      message: comp.message,
    });
  }

  console.log("\nBenchmark comparison against committed baseline (Advisory, tolerance = 50%):");
  console.table(
    comparisons.map((c) => ({
      Target: c.target,
      "Current (ms)": c.currentMedianMs,
      "Baseline (ms)": c.baselineMedianMs,
      "Delta (%)": `${c.deltaPercent > 0 ? `+${c.deltaPercent}` : c.deltaPercent}%`,
      Evaluation: c.message,
    })),
  );

  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      const summaryMd = [
        "### ⚡ Decode-path Micro-benchmark Comparison (Issue #495)",
        "",
        "> **Note:** Micro-benchmarks are informational and advisory. A generous 50% tolerance is used to account for shared virtualized runner noise.",
        "",
        "| Target | Current Median (ms) | Baseline Median (ms) | Delta | Status |",
        "| :--- | ---: | ---: | ---: | :--- |",
        ...comparisons.map(
          (c) =>
            `| \`${c.target}\` | ${c.currentMedianMs} | ${c.baselineMedianMs} | ${c.deltaPercent > 0 ? `+${c.deltaPercent}` : c.deltaPercent}% | ${c.message} |`,
        ),
        "",
      ].join("\n");
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summaryMd}\n`, "utf8");
    } catch {
      // Ignore summary write errors
    }
  }

  // Always exit 0: noise on shared runners never breaks the build
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Benchmark comparison failed:", err);
    process.exit(0); // Advisory: keep informational
  });
}
