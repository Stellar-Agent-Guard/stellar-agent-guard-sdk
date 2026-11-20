#!/usr/bin/env node
/**
 * Coverage-ratchet summary reporter (issue #493).
 *
 * Parses the c8 output from the verdict-critical coverage floor check,
 * compares per-file line/branch/function metrics against the configured
 * floor in `.c8rc.json`, computes deltas against `main` (when available),
 * and writes a Markdown summary table to $GITHUB_STEP_SUMMARY.
 *
 * Guarantees:
 * - Non-gating: reporting never fails the CI run on its own; the floor check
 *   step remains the gate.
 * - Missing metrics are explicitly reported as missing, never silently omitted.
 * - Decreases above the floor are reported with deltas without failing.
 * - No new runtime dependencies.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface MetricCoverage {
  lines: number | null;
  branches: number | null;
  functions: number | null;
  statements?: number | null;
}

export interface CoverageFloorConfig {
  lines: number;
  branches: number;
  functions: number;
  perFile: boolean;
}

export interface FileReport {
  file: string;
  lines: number | null;
  branches: number | null;
  functions: number | null;
  linesFloor: number | null;
  branchesFloor: number | null;
  functionsFloor: number | null;
  linesDelta: number | null;
  branchesDelta: number | null;
  functionsDelta: number | null;
  status: "pass" | "fail" | "missing";
}

export interface CoverageSummaryReport {
  files: FileReport[];
  floor: CoverageFloorConfig;
  hasDeltas: boolean;
  markdown: string;
}

export const VERDICT_CRITICAL_FILES = [
  "invoke.ts",
  "policy.ts",
  "preflight.ts",
  "All files",
] as const;

/** Strip ANSI terminal escape sequences from raw c8 log output. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Loads the configured coverage floor from .c8rc.json.
 */
export function loadFloorConfig(path = ".c8rc.json"): CoverageFloorConfig {
  try {
    const raw = readFileSync(path, "utf8");
    const json = JSON.parse(raw);
    return {
      lines: typeof json.lines === "number" ? json.lines : 90,
      branches: typeof json.branches === "number" ? json.branches : 71,
      functions: typeof json.functions === "number" ? json.functions : 92,
      perFile: json["per-file"] === true,
    };
  } catch {
    return { lines: 90, branches: 71, functions: 92, perFile: true };
  }
}

/**
 * Parses the c8 text table from console / log output.
 */
export function parseC8Table(text: string): Map<string, MetricCoverage> {
  const result = new Map<string, MetricCoverage>();
  const clean = stripAnsi(text);
  const lines = clean.split("\n");

  for (const line of lines) {
    if (!line.includes("|") || line.trim().startsWith("-") || line.includes("% Stmts")) {
      continue;
    }

    const parts = line.split("|").map((p) => p.trim());
    if (parts.length >= 5) {
      const filename = parts[0]!;
      const stmts = parseFloat(parts[1]!);
      const branches = parseFloat(parts[2]!);
      const functions = parseFloat(parts[3]!);
      const linesPct = parseFloat(parts[4]!);

      if (filename) {
        result.set(filename, {
          statements: isNaN(stmts) ? null : stmts,
          branches: isNaN(branches) ? null : branches,
          functions: isNaN(functions) ? null : functions,
          lines: isNaN(linesPct) ? null : linesPct,
        });
      }
    }
  }

  return result;
}

/**
 * Loads baseline metrics for main if available from a baseline file or .c8rc.json note.
 */
export function loadBaseline(explicitPath?: string): Map<string, MetricCoverage> | null {
  // 1. Explicit path or env var
  const target =
    explicitPath || process.env["COVERAGE_BASELINE"] || process.env["COVERAGE_MAIN_LOG"];
  if (target && existsSync(target)) {
    try {
      const content = readFileSync(target, "utf8");
      if (content.trim().startsWith("{")) {
        const json = JSON.parse(content);
        const map = new Map<string, MetricCoverage>();
        for (const [k, v] of Object.entries(json)) {
          map.set(k, v as MetricCoverage);
        }
        return map;
      }
      const parsed = parseC8Table(content);
      if (parsed.size > 0) return parsed;
    } catch {
      // ignore
    }
  }

  // 2. scripts/coverage-baseline.json
  const defaultBaseline = resolve(process.cwd(), "scripts/coverage-baseline.json");
  if (existsSync(defaultBaseline)) {
    try {
      const json = JSON.parse(readFileSync(defaultBaseline, "utf8"));
      const map = new Map<string, MetricCoverage>();
      for (const [k, v] of Object.entries(json)) {
        map.set(k, v as MetricCoverage);
      }
      return map;
    } catch {
      // ignore
    }
  }

  // 3. Fallback: Parse recorded baseline numbers from .c8rc.json note if present
  try {
    const c8rc = JSON.parse(readFileSync(".c8rc.json", "utf8"));
    const note = c8rc._note || "";
    // Note format: "preflight 96.36/85.06/92, policy 90.64/71.92/100, invoke 92.91/84.02/100 (lines/branches/functions)"
    const match =
      /preflight ([\d.]+)\/([\d.]+)\/([\d.]+).*?policy ([\d.]+)\/([\d.]+)\/([\d.]+).*?invoke ([\d.]+)\/([\d.]+)\/([\d.]+)/s.exec(
        note,
      );
    if (match) {
      const map = new Map<string, MetricCoverage>();
      map.set("preflight.ts", {
        lines: parseFloat(match[1]!),
        branches: parseFloat(match[2]!),
        functions: parseFloat(match[3]!),
      });
      map.set("policy.ts", {
        lines: parseFloat(match[4]!),
        branches: parseFloat(match[5]!),
        functions: parseFloat(match[6]!),
      });
      map.set("invoke.ts", {
        lines: parseFloat(match[7]!),
        branches: parseFloat(match[8]!),
        functions: parseFloat(match[9]!),
      });
      return map;
    }
  } catch {
    // ignore
  }

  return null;
}

/**
 * Normalizes filenames for matching (e.g. "src/invoke.ts" -> "invoke.ts").
 */
function findFileMetrics(
  map: Map<string, MetricCoverage>,
  filename: string,
): MetricCoverage | null {
  if (map.has(filename)) return map.get(filename)!;
  for (const [key, val] of map.entries()) {
    if (key.endsWith(filename) || filename.endsWith(key)) return val;
  }
  return null;
}

/**
 * Builds the complete coverage report and Markdown summary.
 */
export function buildCoverageSummary(
  c8Output: string,
  floor = loadFloorConfig(),
  baseline: Map<string, MetricCoverage> | null = null,
): CoverageSummaryReport {
  const current = parseC8Table(c8Output);
  const reports: FileReport[] = [];
  let hasDeltas = false;

  for (const file of VERDICT_CRITICAL_FILES) {
    const cur = findFileMetrics(current, file);
    const base = baseline ? findFileMetrics(baseline, file) : null;

    const isTotal = file === "All files";
    const linesFloor = isTotal ? null : floor.lines;
    const branchesFloor = isTotal ? null : floor.branches;
    const functionsFloor = isTotal ? null : floor.functions;

    const lines = cur?.lines ?? null;
    const branches = cur?.branches ?? null;
    const functions = cur?.functions ?? null;

    const linesDelta =
      lines !== null && base?.lines != null ? Number((lines - base.lines).toFixed(2)) : null;
    const branchesDelta =
      branches !== null && base?.branches != null
        ? Number((branches - base.branches).toFixed(2))
        : null;
    const functionsDelta =
      functions !== null && base?.functions != null
        ? Number((functions - base.functions).toFixed(2))
        : null;

    if (linesDelta !== null || branchesDelta !== null || functionsDelta !== null) {
      hasDeltas = true;
    }

    let status: "pass" | "fail" | "missing" = "pass";

    if (isTotal) {
      if (lines === null || branches === null || functions === null) {
        status = "missing";
      }
    } else {
      if (lines === null || branches === null || functions === null) {
        status = "missing";
      } else if (lines < floor.lines || branches < floor.branches || functions < floor.functions) {
        status = "fail";
      }
    }

    reports.push({
      file,
      lines,
      branches,
      functions,
      linesFloor,
      branchesFloor,
      functionsFloor,
      linesDelta,
      branchesDelta,
      functionsDelta,
      status,
    });
  }

  // Build Markdown table
  const mdLines: string[] = [];
  mdLines.push("### 🛡️ Coverage-Ratchet Summary (Verdict-Critical Path)");
  mdLines.push("");
  mdLines.push(
    `> **Configured Floor (\`.c8rc.json\`):** Lines: ≥ **${floor.lines}%** | Branches: ≥ **${floor.branches}%** | Functions: ≥ **${floor.functions}%**`,
  );
  mdLines.push("");

  const deltaNote = hasDeltas ? " *(deltas vs main)*" : "";
  mdLines.push(
    `| File | Lines (floor: ≥${floor.lines}%)${deltaNote} | Branches (floor: ≥${floor.branches}%)${deltaNote} | Functions (floor: ≥${floor.functions}%)${deltaNote} | Status |`,
  );
  mdLines.push("| :--- | :---: | :---: | :---: | :---: |");

  for (const r of reports) {
    const isTotal = r.file === "All files";
    const name = isTotal ? `**${r.file}**` : `\`${r.file}\``;

    const formatCell = (val: number | null, floorVal: number | null, delta: number | null) => {
      if (val === null) return "⚠️ missing";
      const pass = floorVal === null ? true : val >= floorVal;
      const mark = floorVal === null ? "" : pass ? "✅" : "❌";
      const deltaStr =
        delta !== null
          ? delta > 0
            ? ` (+${delta.toFixed(2)}%)`
            : delta < 0
              ? ` (${delta.toFixed(2)}%)`
              : ` (0.00%)`
          : "";
      return `${val.toFixed(2)}%${deltaStr} ${mark}`.trim();
    };

    const linesCell = formatCell(r.lines, r.linesFloor, r.linesDelta);
    const branchesCell = formatCell(r.branches, r.branchesFloor, r.branchesDelta);
    const functionsCell = formatCell(r.functions, r.functionsFloor, r.functionsDelta);

    let statusCell = "✅ Above floor";
    if (r.status === "missing") {
      statusCell = "⚠️ Missing metric";
    } else if (r.status === "fail") {
      statusCell = "❌ Below floor";
    } else if (isTotal) {
      statusCell = "✅ Pass";
    }

    mdLines.push(`| ${name} | ${linesCell} | ${branchesCell} | ${functionsCell} | ${statusCell} |`);
  }

  mdLines.push("");
  mdLines.push(
    "*Note: Coverage floor is enforced per-file on the verdict-critical path (`src/preflight.ts`, `src/policy.ts`, `src/invoke.ts`).*",
  );
  mdLines.push("");

  return {
    files: reports,
    floor,
    hasDeltas,
    markdown: mdLines.join("\n"),
  };
}

export function main(): void {
  const argv = process.argv.slice(2);
  let logPath = "ci-diagnostics/coverage-floor.log";
  let baselinePath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--log" && argv[i + 1]) {
      logPath = argv[i + 1]!;
      i++;
    } else if (argv[i] === "--baseline" && argv[i + 1]) {
      baselinePath = argv[i + 1]!;
      i++;
    }
  }

  if (!existsSync(logPath)) {
    console.warn(`[coverage-summary] log file not found at ${logPath}. Skipping summary.`);
    return;
  }

  const logContent = readFileSync(logPath, "utf8");
  const floorConfig = loadFloorConfig();
  const baseline = loadBaseline(baselinePath);

  const summary = buildCoverageSummary(logContent, floorConfig, baseline);

  // Write to ci-diagnostics/coverage-summary.md
  try {
    const outDir = dirname(logPath);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, "coverage-summary.md"), summary.markdown);
  } catch {
    // non-fatal
  }

  // Write to $GITHUB_STEP_SUMMARY if available
  const stepSummary = process.env["GITHUB_STEP_SUMMARY"];
  if (stepSummary) {
    try {
      writeFileSync(stepSummary, summary.markdown + "\n", { flag: "a" });
      console.log("[coverage-summary] Appended coverage-ratchet summary to $GITHUB_STEP_SUMMARY");
    } catch (err) {
      console.warn(`[coverage-summary] Failed to write to GITHUB_STEP_SUMMARY: ${err}`);
    }
  }

  // Print to console for step log visibility
  console.log(summary.markdown);
}

if (process.argv[1] && process.argv[1].endsWith("coverage-summary.ts")) {
  main();
}
