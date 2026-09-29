/**
 * The one test-runner configuration (issue #104).
 *
 * Unit and integration suites used to be two hand-written `node --test`
 * invocations in `package.json`, and the two drifted: the unit glob went through
 * the `tsx` transform, the integration glob did not. Whether that difference was
 * intentional was not recorded anywhere, so nothing stopped the next edit from
 * making it worse. This file is the single source of truth: one runner (Node's
 * built-in test runner), explicit named projects, and one shared transform.
 *
 * `scripts/run-tests.ts` reads it; `tests/unit/test-runner.test.ts` asserts its
 * invariants, so a project that points at an empty directory or a project that
 * silently drops the shared loader fails the unit suite instead of drifting.
 *
 * What stays per-project, and why:
 *
 *  - `concurrency` — the integration suite drives real testnet state, so its
 *    files must not race each other; it is pinned to 1. The unit suite is
 *    network-free and runs at the runner default.
 *  - `dir` / `match` — the two suites keep their own directories so a live test
 *    can never be swept into the offline `ci` job by a broad glob.
 *
 * The `env-file` project flag records which project needs `.env.phase2`; the
 * failure mode when it is missing is the harness's, documented in
 * `tests/integration/harness.ts` and quoted in the PR.
 */
export interface TestProject {
  /** Directory, relative to the repo root, that holds the project's test files. */
  readonly dir: string;
  /** Filename pattern selecting test files inside `dir`. */
  readonly match: RegExp;
  /**
   * Value for Node's `--test-concurrency`, or `null` to leave the runner
   * default in place.
   */
  readonly concurrency: number | null;
  /** Whether this project reads `.env.phase2` and therefore needs it to run. */
  readonly needsEnvFile: boolean;
  /** One-line description used in output and error messages. */
  readonly description: string;
}

/**
 * Flags shared by every project. The TS transform is the important one: unit and
 * integration decode the same `src/` modules, so they must be loaded the same
 * way or a bug can pass in one and fail in the other.
 */
export const SHARED_IMPORTS: readonly string[] = ["tsx"];

export const TEST_PROJECTS: Record<string, TestProject> = {
  unit: {
    dir: "tests/unit",
    match: /\.test\.ts$/u,
    concurrency: null,
    needsEnvFile: false,
    description: "offline unit suite (no network, no secrets)",
  },
  integration: {
    dir: "tests/integration",
    match: /\.test\.ts$/u,
    concurrency: 1,
    needsEnvFile: true,
    description: "live testnet suite (requires .env.phase2)",
  },
};

/** The project `npm test` runs. */
export const DEFAULT_PROJECT = "unit";

/** Selector that runs every project in one invocation (used by `test:coverage`). */
export const ALL_PROJECTS = "all";
