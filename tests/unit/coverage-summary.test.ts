/**
 * Tests for the coverage-ratchet summary reporter (issue #493).
 *
 * Verifies that:
 * - c8 output table is parsed accurately and matches floor check numbers.
 * - Missing metrics/files are explicitly reported, never silently omitted.
 * - Each metric is accurately classified as above or below floor.
 * - Deltas against main are computed when baseline is available.
 * - Decreases above the floor do not cause failure.
 * - The summary table is formatted correctly in Markdown.
 * - The summary step is wired non-gating in `.github/workflows/ci.yml`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  buildCoverageSummary,
  loadFloorConfig,
  parseC8Table,
  stripAnsi,
  type MetricCoverage,
} from "../../scripts/coverage-summary.ts";

const SAMPLE_C8_OUTPUT = `
--------------|---------|----------|---------|---------|------------------------
File          | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s      
--------------|---------|----------|---------|---------|------------------------
All files     |   95.54 |    88.58 |   98.48 |   95.54 |                        
 invoke.ts    |   96.05 |    88.54 |   95.83 |   96.05 | ...2234-2238,2296-2308 
 policy.ts    |   94.51 |    89.14 |     100 |   94.51 | ...1621-1627,1631-1635 
 preflight.ts |   96.22 |    87.71 |     100 |   96.22 | ...1475-1476,1503-1505 
--------------|---------|----------|---------|---------|------------------------
`;

const SAMPLE_WITH_ANSI = `
\x1b[32m--------------|---------|----------|---------|---------|------------------------\x1b[0m
\x1b[32mFile          | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s      \x1b[0m
\x1b[32m--------------|---------|----------|---------|---------|------------------------\x1b[0m
All files     |   95.54 |    88.58 |   98.48 |   95.54 |                        
 invoke.ts    |   96.05 |    88.54 |   95.83 |   96.05 | ...2234-2238,2296-2308 
 policy.ts    |   94.51 |    89.14 |     100 |   94.51 | ...1621-1627,1631-1635 
 preflight.ts |   96.22 |    87.71 |     100 |   96.22 | ...1475-1476,1503-1505 
--------------|---------|----------|---------|---------|------------------------
`;

describe("coverage-ratchet summary reporter (issue #493)", () => {
  it("strips ANSI escape sequences cleanly", () => {
    const stripped = stripAnsi(SAMPLE_WITH_ANSI);
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(stripped, /\x1b\[[0-9;]*m/);
    assert.match(stripped, /invoke\.ts/);
  });

  it("parses c8 output table numbers accurately matching the floor check", () => {
    const table = parseC8Table(SAMPLE_C8_OUTPUT);

    assert.equal(table.size, 4);

    const invoke = table.get("invoke.ts");
    assert.ok(invoke);
    assert.equal(invoke.lines, 96.05);
    assert.equal(invoke.branches, 88.54);
    assert.equal(invoke.functions, 95.83);
    assert.equal(invoke.statements, 96.05);

    const policy = table.get("policy.ts");
    assert.ok(policy);
    assert.equal(policy.lines, 94.51);
    assert.equal(policy.branches, 89.14);
    assert.equal(policy.functions, 100);

    const preflight = table.get("preflight.ts");
    assert.ok(preflight);
    assert.equal(preflight.lines, 96.22);
    assert.equal(preflight.branches, 87.71);
    assert.equal(preflight.functions, 100);
  });

  it("loads floor thresholds from .c8rc.json", () => {
    const floor = loadFloorConfig();
    assert.equal(floor.lines, 90);
    assert.equal(floor.branches, 71);
    assert.equal(floor.functions, 92);
    assert.equal(floor.perFile, true);
  });

  it("marks metrics above floor as pass and includes checkmarks", () => {
    const floor = { lines: 90, branches: 71, functions: 92, perFile: true };
    const summary = buildCoverageSummary(SAMPLE_C8_OUTPUT, floor);

    for (const file of summary.files) {
      if (file.file === "All files") continue;
      assert.equal(file.status, "pass", `${file.file} should be marked as pass`);
      assert.ok(file.lines! >= floor.lines);
      assert.ok(file.branches! >= floor.branches);
      assert.ok(file.functions! >= floor.functions);
    }

    assert.match(summary.markdown, /invoke\.ts.*?✅ Above floor/);
    assert.match(summary.markdown, /policy\.ts.*?✅ Above floor/);
    assert.match(summary.markdown, /preflight\.ts.*?✅ Above floor/);
  });

  it("marks metrics below floor as fail with cross mark", () => {
    const belowOutput = `
--------------|---------|----------|---------|---------|------------------------
File          | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s      
--------------|---------|----------|---------|---------|------------------------
All files     |   90.00 |    80.00 |   90.00 |   90.00 |                        
 invoke.ts    |   85.00 |    65.00 |   80.00 |   85.00 | ... 
 policy.ts    |   94.51 |    89.14 |     100 |   94.51 | ... 
 preflight.ts |   96.22 |    87.71 |     100 |   96.22 | ... 
--------------|---------|----------|---------|---------|------------------------
`;
    const floor = { lines: 90, branches: 71, functions: 92, perFile: true };
    const summary = buildCoverageSummary(belowOutput, floor);

    const invoke = summary.files.find((f) => f.file === "invoke.ts")!;
    assert.equal(invoke.status, "fail");
    assert.match(summary.markdown, /85\.00% ❌/);
    assert.match(summary.markdown, /65\.00% ❌/);
    assert.match(summary.markdown, /80\.00% ❌/);
    assert.match(summary.markdown, /invoke\.ts.*?❌ Below floor/);
  });

  it("reports missing metrics explicitly rather than silently omitting them", () => {
    const missingOutput = `
--------------|---------|----------|---------|---------|------------------------
File          | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s      
--------------|---------|----------|---------|---------|------------------------
All files     |   95.54 |    88.58 |   98.48 |   95.54 |                        
 policy.ts    |   94.51 |    89.14 |     100 |   94.51 | ... 
 preflight.ts |   96.22 |    87.71 |     100 |   96.22 | ... 
--------------|---------|----------|---------|---------|------------------------
`;
    const floor = { lines: 90, branches: 71, functions: 92, perFile: true };
    const summary = buildCoverageSummary(missingOutput, floor);

    const invoke = summary.files.find((f) => f.file === "invoke.ts")!;
    assert.equal(invoke.status, "missing");
    assert.equal(invoke.lines, null);
    assert.equal(invoke.branches, null);
    assert.equal(invoke.functions, null);

    assert.match(summary.markdown, /invoke\.ts.*?⚠️ missing/);
    assert.match(summary.markdown, /invoke\.ts.*?⚠️ Missing metric/);
  });

  it("calculates deltas against baseline when available without failing on decreases above floor", () => {
    const floor = { lines: 90, branches: 71, functions: 92, perFile: true };
    const baseline = new Map<string, MetricCoverage>([
      ["invoke.ts", { lines: 95.0, branches: 85.0, functions: 98.0, statements: 95.0 }],
      ["policy.ts", { lines: 94.51, branches: 89.14, functions: 100.0, statements: 94.51 }],
      ["preflight.ts", { lines: 97.0, branches: 85.0, functions: 95.0, statements: 97.0 }],
    ]);

    const summary = buildCoverageSummary(SAMPLE_C8_OUTPUT, floor, baseline);

    assert.equal(summary.hasDeltas, true);

    const invoke = summary.files.find((f) => f.file === "invoke.ts")!;
    assert.equal(invoke.linesDelta, 1.05); // 96.05 - 95.00
    assert.equal(invoke.branchesDelta, 3.54); // 88.54 - 85.00
    assert.equal(invoke.functionsDelta, -2.17); // 95.83 - 98.00 (decrease)
    // Decrease above floor is still pass:
    assert.equal(invoke.status, "pass");

    const preflight = summary.files.find((f) => f.file === "preflight.ts")!;
    assert.equal(preflight.linesDelta, -0.78); // 96.22 - 97.00 (decrease above 90% floor)
    assert.equal(preflight.status, "pass");

    assert.match(summary.markdown, /\(\+1\.05%\)/);
    assert.match(summary.markdown, /\(-2\.17%\)/);
    assert.match(summary.markdown, /\(-0\.78%\)/);
  });

  it("is wired non-gating into .github/workflows/ci.yml", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");

    assert.match(
      ci,
      /name:\s*coverage-ratchet summary/,
      "ci.yml must define coverage-ratchet summary step",
    );
    assert.match(
      ci,
      /scripts\/coverage-summary\.ts/,
      "ci.yml must invoke scripts/coverage-summary.ts",
    );
    assert.match(
      ci,
      /continue-on-error:\s*true/,
      "coverage-ratchet summary step must be non-gating (continue-on-error: true)",
    );
  });
});
