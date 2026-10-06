#!/usr/bin/env node
/**
 * End-to-end self-test for the enforcement-path evidence gate (issue #51).
 *
 * The unit suite pins the gate's *pure* decision functions. This script pins
 * the *wired* behaviour a pull request actually experiences: the real script,
 * run as CI runs it, against a real base/head pair in a real (throwaway) git
 * repository — `act`-style, minus the container. It is documented in
 * CONTRIBUTING.md and run by the `ci` workflow's `gate self-test` step.
 *
 * Covered, in order:
 *
 *   1. the diff touches neither the enforcement path nor the evidence -> exit 0
 *   2. the enforcement path is touched without the evidence           -> exit 1,
 *      and the output names the changed file and the regeneration command
 *   3. the evidence is updated in the same history                    -> exit 0
 *   4. the failing case again, with the `skip-live-evidence` escape hatch
 *      present and its actor/timestamp set                            -> exit 0,
 *      with a `::warning` recording who applied the skip and when
 *   5. `--check-structure` against the real evidence file             -> exit 0
 *
 * The temporary repository is deleted again; the only side effects are the
 * process exit code and its log.
 *
 * Usage:
 *   node --import tsx scripts/self-test-enforcement-gate.ts
 *   npm run test:gate-self-test
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATE_SCRIPT = join(REPO_ROOT, "scripts", "check-enforcement-evidence.ts");
const EVIDENCE_FILE = "tests/fixtures/integration-evidence.md";
const ENFORCEMENT_FILE = "src/tx.ts";
const SKIP_LIVE_EVIDENCE_LABEL = "skip-live-evidence";
const SKIP_LABELS_ENV = "SKIP_LABELS";
const SKIP_ACTOR_ENV = "SKIP_LABEL_ACTOR";
const SKIP_TIME_ENV = "SKIP_LABEL_TIME";

/** Every failure here is the self-test failing, not the gate under test. */
class SelfTestError extends Error {}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run the gate exactly as CI does: via node + the tsx loader. */
function runGate(args: string[], env: Record<string, string>, cwd = REPO_ROOT): RunResult {
  const result = spawnSync(
    process.execPath,
    ["--import", tsxLoader(), GATE_SCRIPT, ...args],
    { cwd, encoding: "utf8", env: { ...process.env, ...env } },
  );
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * Absolute path of the `tsx` ESM loader, resolved from this repo's own
 * node_modules. The self-test runs node from a temporary directory, where a
 * bare `--import tsx` would not resolve; the loader is resolved here, where it
 * does, and handed to the child as a path.
 */
function tsxLoader(): string {
  try {
    return fileURLToPath(import.meta.resolve("tsx"));
  } catch {
    throw new SelfTestError("could not resolve the tsx loader; is the devDependency installed?");
  }
}

function expect(condition: unknown, description: string): void {
  if (!condition) throw new SelfTestError(`self-test failed: ${description}`);
}

/**
 * Build the throwaway subject repository and return the refs CI would diff.
 *
 * The commit graph is shaped so every gate outcome has a real ref pair:
 *
 *   base          -- initial (empty) commit
 *   afterContents -- repo contents (enforcement file + evidence file)
 *   beforeTouch   -- tip of an unrelated docs change (README only)
 *   head          -- tip; touches the enforcement path, evidence NOT updated
 *
 * A pull request is the diff between two of these refs, exactly as CI diffs
 * `origin/<base>...HEAD`, so each case below picks the pair its name needs.
 */
function makeSubjectRepo(): {
  root: string;
  base: string;
  afterContents: string;
  beforeTouch: string;
  head: string;
} {
  const root = mkdtempSync(join(tmpdir(), "evidence-gate-selftest-"));
  git(root, "init", "--initial-branch=main", "--quiet");
  git(root, "config", "user.name", "gate self-test");
  git(root, "config", "user.email", "self-test@invalid");

  const commit = (message: string, files: Record<string, string>): void => {
    for (const [file, content] of Object.entries(files)) {
      const path = join(root, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "--allow-empty", "-m", message);
  };

  // The gate's structure check reads the evidence file from the working tree
  // (cwd) before the file-list verdict, so the subject repository needs the
  // real, structurally valid evidence file — exactly what a PR checkout has.
  const realEvidence = readFileSync(join(REPO_ROOT, EVIDENCE_FILE), "utf8");

  git(root, "commit", "--quiet", "--allow-empty", "-m", "initial");
  const base = git(root, "rev-parse", "HEAD");
  expect(base.length > 0, "the subject repository has a base commit");

  commit("repo contents", {
    [ENFORCEMENT_FILE]: "export const baseline = true;\n",
    [EVIDENCE_FILE]: realEvidence,
  });
  commit("docs: readme", { "README.md": "unrelated change\n" });
  const beforeTouch = git(root, "rev-parse", "HEAD");
  const afterContents = git(root, "rev-parse", "HEAD~1");

  commit("touches the enforcement path", { [ENFORCEMENT_FILE]: "export const baseline = false;\n" });
  const head = git(root, "rev-parse", "HEAD");

  return { root, base, afterContents, beforeTouch, head };
}

interface Case {
  name: string;
  run: () => void;
}

const cases: Case[] = [];

cases.push({
  name: "diff touches neither the enforcement path nor the evidence -> ok",
  run: () => {
    const { root, afterContents, beforeTouch } = makeSubjectRepo();
    try {
      // The PR pair whose only commit is the unrelated docs change.
      const result = runGate([afterContents, beforeTouch], {}, root);
      expect(result.status === 0, `expected exit 0, got ${result.status}: ${result.stdout} ${result.stderr}`);
      expect(result.stdout.includes("enforcement-path evidence gate: ok"), "the ok message explains the outcome");
      expect(result.stdout.includes("enforcement path: none"), "no enforcement file is claimed as changed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
});

cases.push({
  name: "enforcement path touched without evidence -> fails, naming file, fix, and escape hatch",
  run: () => {
    const { root, beforeTouch, head } = makeSubjectRepo();
    try {
      const result = runGate([beforeTouch, head], {}, root);
      expect(result.status === 1, `expected exit 1, got ${result.status}`);
      const out = `${result.stdout}\n${result.stderr}`;
      expect(out.includes(ENFORCEMENT_FILE), "the failure names the enforcement file that changed");
      expect(out.includes("npm run test:integration"), "the failure names the regeneration command");
      expect(out.includes(EVIDENCE_FILE), "the failure names the evidence file");
      expect(out.includes("skip-live-evidence"), "the failure names the documented escape hatch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
});

cases.push({
  name: "evidence updated in the same history -> ok",
  run: () => {
    const { root, base } = makeSubjectRepo();
    try {
      // Rebase-free simulation of "same PR": append an evidence commit on top
      // of the enforcement change, then diff the whole history like CI does.
      // The appended section keeps every existing heading, so the structure
      // check still passes; the file-list verdict is what is under test.
      const current = readFileSync(join(root, EVIDENCE_FILE), "utf8");
      writeFileSync(join(root, EVIDENCE_FILE), `${current}\n\n## fresh run\n\nnew evidence\n`);
      git(root, "add", "-A");
      git(root, "commit", "--quiet", "-m", "fresh evidence");
      const result = runGate([base, "HEAD"], {}, root);
      expect(result.status === 0, `expected exit 0, got ${result.status}: ${result.stdout} ${result.stderr}`);
      expect(result.stdout.includes("evidence file: updated"), "the ok message records that evidence moved");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
});

cases.push({
  name: "skip-live-evidence label -> passes with an honest, attributed warning",
  run: () => {
    const { root, beforeTouch, head } = makeSubjectRepo();
    try {
      // No label, no env: the gate must still fail.
      const unlabelled = runGate([beforeTouch, head], {}, root);
      expect(unlabelled.status === 1, "without the label the gate still fails");

      // Label present with provenance: CI exports the PR's label list plus the
      // `labeled` timeline event's actor and time (see the workflow step).
      const labelled = runGate(
        [beforeTouch, head],
        {
          [SKIP_LABELS_ENV]: SKIP_LIVE_EVIDENCE_LABEL,
          [SKIP_ACTOR_ENV]: "maintainer",
          [SKIP_TIME_ENV]: "2026-09-29T12:00:00Z",
        },
        root,
      );
      expect(labelled.status === 0, `expected the label to pass the gate, got ${labelled.status}`);
      const out = `${labelled.stdout}\n${labelled.stderr}`;
      expect(out.includes("::warning"), "the override is a logged ::warning, not silence");
      expect(out.includes("maintainer"), "the warning records who applied the label");
      expect(out.includes("2026-09-29T12:00:00Z"), "the warning records when the label was applied");
      expect(/not supplied/i.test(out), "the warning says plainly that evidence is missing");
      expect(out.includes(SKIP_LIVE_EVIDENCE_LABEL), "the warning names the label");

      // A label without its provenance must not pass: the override engages
      // only when CI supplied both the label list and the who/when.
      const unattributed = runGate([beforeTouch, head], { [SKIP_LABELS_ENV]: SKIP_LIVE_EVIDENCE_LABEL }, root);
      expect(unattributed.status === 1, "an override without provenance does not pass");
      expect(
        `${unattributed.stdout}\n${unattributed.stderr}`.includes("::notice"),
        "the refusal to pass is explained in the run log",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
});

cases.push({
  name: "--check-structure accepts the committed evidence file",
  run: () => {
    const result = runGate(["--check-structure"], {});
    expect(result.status === 0, `expected exit 0, got ${result.status}: ${result.stdout} ${result.stderr}`);
    expect(result.stdout.includes("evidence structure check: ok"), "the structure check reports ok");
  },
});

function main(): void {
  const results: string[] = [];
  for (const testCase of cases) {
    try {
      testCase.run();
      results.push(`ok    ${testCase.name}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      results.push(`FAIL  ${testCase.name}\n      ${detail}`);
    }
  }

  console.log(results.join("\n"));
  if (results.some((line) => line.startsWith("FAIL"))) {
    console.error("\nevidence-gate self-test FAILED");
    process.exit(1);
  }
  console.log("\nevidence-gate self-test: all cases passed");
}

// Guard against accidental import (mirrors the gate script's own entry guard).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
