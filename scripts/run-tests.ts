#!/usr/bin/env node
/**
 * Unified test runner (issue #104).
 *
 * Reads `tests/test.config.ts` and drives Node's built-in test runner for the
 * requested project(s). Splitting the suites stayed, but the way they are
 * invoked does not: the transform, the file selection, and the concurrency rule
 * all come from one config, so unit and integration cannot drift apart again.
 *
 * Usage:
 *   npm test                      # unit project (default)
 *   npm run test:unit             # unit project, explicit
 *   npm run test:watch            # unit project, re-running on change
 *   npm run test:integration      # live testnet project (needs .env.phase2)
 *   npm run test:all              # every project in one run
 *   npm run test:coverage         # every project in one run, with coverage
 *
 * `all` runs a single Node invocation so coverage (when the `--coverage` flag is
 * passed) is reported across both projects in one report. It pins concurrency to
 * 1 for that run because the integration files share live on-chain state.
 */
import { spawn, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALL_PROJECTS,
  DEFAULT_PROJECT,
  SHARED_IMPORTS,
  TEST_PROJECTS,
  type TestProject,
} from "../tests/test.config.ts";
import { validatePhase2Env } from "../tests/integration/harness.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface RunPlan {
  label: string;
  files: string[];
  concurrency: number | null;
  needsEnvFile: boolean;
}

/** Files in a project's directory that match its pattern, in a stable order. */
function projectFiles(project: TestProject): string[] {
  return readdirSync(join(ROOT, project.dir))
    .filter((entry) => project.match.test(entry))
    .sort()
    .map((entry) => join(project.dir, entry));
}

function planFor(name: string): RunPlan {
  if (name === ALL_PROJECTS) {
    const projects = Object.values(TEST_PROJECTS);
    return {
      label: `${name} (${Object.keys(TEST_PROJECTS).join(", ")})`,
      files: projects.flatMap((project) => projectFiles(project)),
      // Shared on-chain state across the live files: never run them in parallel.
      concurrency: 1,
      needsEnvFile: projects.some((project) => project.needsEnvFile),
    };
  }
  const project = TEST_PROJECTS[name];
  if (!project) {
    const known = [...Object.keys(TEST_PROJECTS), ALL_PROJECTS].join(", ");
    console.error(`unknown test project "${name}". Known projects: ${known}`);
    process.exit(2);
  }
  return {
    label: `${name} — ${project.description}`,
    files: projectFiles(project),
    concurrency: project.concurrency,
    needsEnvFile: project.needsEnvFile,
  };
}

function nodeArgs(plan: RunPlan, coverage: boolean, watch: boolean): string[] {
  const args: string[] = [];
  for (const loader of SHARED_IMPORTS) args.push("--import", loader);
  args.push("--test");
  if (watch) args.push("--watch");
  if (plan.concurrency !== null) args.push(`--test-concurrency=${plan.concurrency}`);
  if (coverage) args.push("--experimental-test-coverage");
  args.push(...plan.files);
  return args;
}

function main(): void {
  const argv = process.argv.slice(2);
  const coverage = argv.includes("--coverage");
  const watch = argv.includes("--watch");
  const name = argv.find((arg) => !arg.startsWith("--")) ?? DEFAULT_PROJECT;

  const plan = planFor(name);

  if (plan.files.length === 0) {
    console.error(`no test files matched for project "${name}"`);
    process.exit(1);
  }

  if (plan.needsEnvFile) {
    const envValidation = validatePhase2Env();
    if (!envValidation.ok) {
      console.error(envValidation.message);
      process.exit(1);
    }
  }

  console.log(`running ${plan.label} (${plan.files.length} file(s), node ${process.version})`);
  if (plan.needsEnvFile && coverage) {
    console.log("coverage includes the live project: .env.phase2 must be present or that part fails");
  }

  // Watch mode resolves the project's files once, at startup, exactly as a
  // one-shot run does, and then hands the terminal to the runner. A file added
  // to the project after startup is therefore not watched until the run is
  // restarted; edits to files already in the plan re-run in place.
  if (watch) {
    console.log("watching for changes — press Ctrl+C to stop");
    const child = spawn(process.execPath, nodeArgs(plan, coverage, watch), {
      cwd: ROOT,
      stdio: "inherit",
    });
    child.on("error", (error: Error) => {
      console.error(`failed to start the test runner: ${error.message}`);
      process.exit(1);
    });
    child.on("exit", (code, signal) => {
      // A signal-terminated runner is the normal Ctrl+C path, not a failure.
      process.exit(signal ? 0 : (code ?? 1));
    });
    return;
  }

  const result = spawnSync(process.execPath, nodeArgs(plan, coverage, watch), {
    cwd: ROOT,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(`failed to start the test runner: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

main();
