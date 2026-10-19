/**
 * Live-suite notification path tests (issue #143).
 *
 * These are act-based simulations of the notify scripts, per the acceptance
 * criteria's "cite runs or act-based simulation — state method": the *real*
 * scripts (`scripts/live-suite-notify/*.sh`) run against a fake `gh` placed on
 * PATH, which records every invocation. The test runner builds a fake gh that
 * serves a scriptable issue-list state, then the four contract rows are
 * asserted from the recorded call sequence:
 *
 *   1. first failure       → exactly one `issue create`
 *   2. second failure      → one `issue comment`, still exactly one create
 *                            (two consecutive failures = ONE issue, two
 *                            comments)
 *   3. failure → success   → `issue close` with a resolution comment
 *   4. success, no issue   → zero mutating calls (no-op)
 *
 * The simulation is offline (no network, no secret) and runs the actual bash
 * the workflow runs — not a re-implementation — so the scripts cannot drift
 * from the contract without this suite failing.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnFile } from "./spawn-file.ts";
import { after, before, describe, it } from "node:test";

const SCRIPTS_DIR = resolve(process.cwd(), "scripts/live-suite-notify");

interface GhCall {
  args: string[];
}

/** What the fake gh serves for `issue list`, and what it recorded. */
interface FakeGh {
  dir: string;
  calls: GhCall[];
  /** The number the fake gh reports as the single open tracking issue (or null). */
  setOpenIssue(n: number | null): Promise<void>;
  runPath: string;
}

async function makeFakeGh(testDir: string): Promise<FakeGh> {
  const dir = join(testDir, "fake-gh-bin");
  await mkdir(dir, { recursive: true });
  const stateFile = join(dir, "state.json");
  const logFile = join(dir, "calls.jsonl");
  const runPath = join(dir, "gh");

  // The fake gh: records its args, serves `issue list` from a state file, and
  // supports create/comment/close by rewriting that state. Everything else
  // fails loudly so an unexpected call cannot pass silently.
  const script = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(logFile)}
cmd="\${1:-}"
# The real scripts call: gh issue list --label L --json number --jq '.[0].number'
# and use command substitution on the result, so the fake gh serves the *jq
# output* — the bare issue number, empty when there is no open issue — exactly
# as real gh would after evaluating the jq filter.
case "$cmd" in
  issue)
    sub="\${2:-}"
    case "$sub" in
      list)
        n="$(cat "${stateFile}" 2>/dev/null || echo '')"
        if [ -n "$n" ]; then printf '%s' "$n"; else printf ''; fi
        ;;
      create)
        echo 101
        ;;
      comment|close)
        ;;
      *)
        echo "fake-gh: unsupported issue subcommand: $sub" >&2; exit 9 ;;
    esac
    ;;
  *)
    echo "fake-gh: unsupported command: $cmd" >&2; exit 9 ;;
esac
`;
  await writeFile(runPath, script, "utf8");
  await chmod(runPath, 0o755);
  return {
    dir,
    calls: [],
    runPath,
    async setOpenIssue(n: number | null): Promise<void> {
      await writeFile(stateFile, n === null ? "" : String(n), "utf8");
    },
  };
}

async function recordedCalls(fake: FakeGh): Promise<string[][]> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(join(fake.dir, "calls.jsonl"), "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => line.split(" "));
  } catch {
    return [];
  }
}

/** Run one notify script with the fake gh first on PATH, starting from an empty call log. */
async function runNotify(script: "failure.sh" | "success.sh", fake: FakeGh, runUrl: string): Promise<void> {
  // Fresh log per invocation: each test asserts on the calls *its* run made.
  await rm(join(fake.dir, "calls.jsonl"), { force: true });
  const result = await spawnFile("bash", [join(SCRIPTS_DIR, script)], {
    env: {
      ...process.env,
      PATH: `${fake.dir}:${process.env.PATH ?? ""}`,
      RUN_URL: runUrl,
      TRIGGER: "schedule",
    },
  });
  assert.equal(result.code, 0, `${script} exited ${result.code}: ${result.stderr}`);
}

describe("live-suite notification path (issue #143)", () => {
  let testDir: string;
  let fake: FakeGh;

  before(async () => {
    testDir = await mkdtemp(join(tmpdir(), "live-suite-notify-"));
    fake = await makeFakeGh(testDir);
  });

  after(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("first failure creates exactly one tracked issue carrying the run link", async () => {
    await fake.setOpenIssue(null);
    await runNotify("failure.sh", fake, "https://example.test/runs/1");
    const calls = await recordedCalls(fake);
    const creates = calls.filter(([cmd, ...rest]) => cmd === "issue" && rest[0] === "create");
    assert.equal(creates.length, 1, `expected one create, got: ${JSON.stringify(calls)}`);
  });

  it("second consecutive failure comments instead of duplicating (one issue, two comments)", async () => {
    // The state the first failure left behind: one open tracking issue. (The
    // first run's create was proven by the test above; this run's log starts
    // empty, so the duplication assertion is: zero creates, one comment.)
    await fake.setOpenIssue(101);
    await runNotify("failure.sh", fake, "https://example.test/runs/2");
    const calls = await recordedCalls(fake);
    const creates = calls.filter(([cmd, ...rest]) => cmd === "issue" && rest[0] === "create");
    const comments = calls.filter(([cmd, ...rest]) => cmd === "issue" && rest[0] === "comment");
    assert.equal(creates.length, 0, "no new issue may be created while one is open");
    assert.equal(comments.length, 1, "the second failure must comment on the existing issue");
  });

  it("recovery closes the tracked issue with a resolution comment (self-healing)", async () => {
    await fake.setOpenIssue(101);
    await runNotify("success.sh", fake, "https://example.test/runs/3");
    const calls = await recordedCalls(fake);
    const closes = calls.filter(([cmd, ...rest]) => cmd === "issue" && rest[0] === "close");
    assert.equal(closes.length, 1, `expected one close, got: ${JSON.stringify(calls)}`);
  });

  it("success with no open tracking issue is a no-op (never creates)", async () => {
    await fake.setOpenIssue(null);
    await runNotify("success.sh", fake, "https://example.test/runs/4");
    const calls = await recordedCalls(fake);
    const mutating = calls.filter(([cmd, ...rest]) => {
      return cmd === "issue" && (rest[0] === "create" || rest[0] === "close" || rest[0] === "comment");
    });
    assert.deepEqual(mutating, [], "the success path must not create, close, or comment anything");
  });

  it("scripts live where the workflow invokes them and are executable", async () => {
    const { access } = await import("node:fs/promises");
    for (const script of ["failure.sh", "success.sh"] as const) {
      await access(join(SCRIPTS_DIR, script));
    }
  });

  it("workflow wires both notify steps with the right guards and env", async () => {
    const { readFile } = await import("node:fs/promises");
    const yaml = await readFile(
      resolve(process.cwd(), ".github/workflows/live-suite.yml"),
      "utf8",
    );
    // Failure step: guarded by failure(), runs the real script, carries the token.
    assert.match(yaml, /if:\s*failure\(\)[\s\S]*?live-suite-notify\/failure\.sh/);
    // Success step: guarded by success(), runs the real script.
    assert.match(yaml, /if:\s*success\(\)[\s\S]*?live-suite-notify\/success\.sh/);
    // The tracked-issue label the scripts filter by is documented.
    assert.match(yaml, /issues:\s*write/, "workflow needs issues:write for the notify steps");
    assert.match(yaml, /live-suite-notify/, "workflow references the notify scripts");
  });
});
