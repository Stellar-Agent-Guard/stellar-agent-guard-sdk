/**
 * Benchmark comparison tests (issue #495).
 *
 * Validates baseline parsing, tolerance-based evaluation, and re-baselining rules.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  evaluateComparison,
  parseCommittedBaseline,
  rebaselineDocs,
  DEFAULT_TOLERANCE_PERCENT,
} from "../../scripts/compare-benchmarks.ts";

describe("benchmark comparison harness (issue #495)", () => {
  it("parses the committed baseline from docs/benchmarks.md", async () => {
    const doc = await readFile("docs/benchmarks.md", "utf8");
    const baseline = parseCommittedBaseline(doc);

    assert.ok(baseline.has("policyToScVal"), "must contain policyToScVal baseline");
    assert.ok(baseline.has("decodePolicy"), "must contain decodePolicy baseline");
    assert.ok(baseline.has("decodeCheckResult"), "must contain decodeCheckResult baseline");
    assert.ok(
      baseline.has("guardEventsFromDiagnostics"),
      "must contain guardEventsFromDiagnostics baseline",
    );

    const policyBaseline = baseline.get("policyToScVal")!;
    assert.ok(policyBaseline.opsPerSecond > 0);
    assert.ok(policyBaseline.medianMs > 0);
  });

  it("evaluates comparisons against the 50% tolerance correctly", () => {
    assert.equal(DEFAULT_TOLERANCE_PERCENT, 50, "Default tolerance must be 50%");

    // 1. Within tolerance (+20% increase)
    const within = evaluateComparison(12, 10, 50);
    assert.equal(within.status, "within-tolerance");
    assert.equal(within.deltaPercent, 20);

    // 2. Faster (-25% decrease)
    const faster = evaluateComparison(7.5, 10, 50);
    assert.equal(faster.status, "faster");
    assert.equal(faster.deltaPercent, -25);

    // 3. Regression (> 50% increase)
    const regression = evaluateComparison(16, 10, 50);
    assert.equal(regression.status, "regression");
    assert.equal(regression.deltaPercent, 60);
  });

  it("rebaselineDocs requires an explicit non-empty reason", () => {
    const dummyDocs = "## Baseline\nMeasured 2026-09-28\n| `policyToScVal` | 29 | 33.98 |";
    const newResults = [
      { key: "policyToScVal", name: "policyToScVal", opsPerSecond: 35, medianMs: 25.5 },
    ];

    assert.throws(
      () => rebaselineDocs(dummyDocs, newResults, ""),
      /Re-baselining requires an explicit --reason argument/,
    );
    assert.throws(
      () => rebaselineDocs(dummyDocs, newResults, "   "),
      /Re-baselining requires an explicit --reason argument/,
    );

    const updated = rebaselineDocs(dummyDocs, newResults, "Tested optimization");
    assert.match(updated, /Tested optimization/);
    assert.match(updated, /25\.5/);
  });

  it("package.json wires bench:compare and bench:rebaseline", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };

    assert.ok(pkg.scripts?.["bench:compare"], "bench:compare must be defined");
    assert.ok(pkg.scripts?.["bench:rebaseline"], "bench:rebaseline must be defined");
  });
});
