/**
 * Invariants of the unified test-runner configuration (issue #104).
 *
 * `tests/test.config.ts` is the single source of truth for how the suites run.
 * These assertions are what keep it honest: a project that points at a directory
 * with no matching files, or a config edit that drops the shared transform, or a
 * live project that stops being serialised, fails here instead of surfacing as a
 * silently-skipped suite or a flaky integration run.
 */
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  ALL_PROJECTS,
  DEFAULT_PROJECT,
  SHARED_IMPORTS,
  TEST_PROJECTS,
} from "../test.config.ts";

describe("unified test-runner configuration", () => {
  it("routes every project through the same TypeScript transform", () => {
    assert.ok(SHARED_IMPORTS.length > 0, "at least one shared loader must be configured");
    assert.ok(
      SHARED_IMPORTS.includes("tsx"),
      "the unit and integration projects decode the same src/ modules and must share the tsx loader",
    );
  });

  it("keeps `npm test` on the offline unit project", () => {
    assert.equal(DEFAULT_PROJECT, "unit");
    assert.ok(TEST_PROJECTS[DEFAULT_PROJECT], "the default project must exist in the config");
    assert.equal(TEST_PROJECTS[DEFAULT_PROJECT]?.needsEnvFile, false);
  });

  for (const [name, project] of Object.entries(TEST_PROJECTS)) {
    it(`project "${name}" matches at least one file in ${project.dir}`, () => {
      const entries = readdirSync(resolve(process.cwd(), project.dir));
      const matched = entries.filter((entry) => project.match.test(entry));
      assert.ok(
        matched.length > 0,
        `project "${name}" is configured for ${project.dir} but no file there matches ${String(
          project.match,
        )}`,
      );
    });
  }

  it("serialises the live testnet project so its files cannot race on shared on-chain state", () => {
    assert.equal(TEST_PROJECTS.integration?.concurrency, 1);
  });

  it("marks only the live testnet project as requiring an env file", () => {
    assert.equal(TEST_PROJECTS.integration?.needsEnvFile, true);
    assert.equal(TEST_PROJECTS.unit?.needsEnvFile, false);
  });

  it("uses `all` as the selector that runs every configured project", () => {
    assert.equal(ALL_PROJECTS, "all");
    assert.equal(ALL_PROJECTS in TEST_PROJECTS, false, "`all` is a selector, not a project");
  });
});
