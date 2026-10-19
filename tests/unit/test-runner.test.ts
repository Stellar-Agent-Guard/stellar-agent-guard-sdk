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
import {
  DEPLOY_COMMAND,
  ENV_EXAMPLE_FILE,
  ENV_FILE,
  REQUIRED_PHASE2_KEYS,
  missingEnvFileMessage,
  missingPhase2KeysMessage,
  parseEnvContent,
  validatePhase2Env,
} from "../integration/harness.ts";
import { unsafeContractAddress } from "../../src/policy.ts";

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

describe("integration harness env-missing entry check parity", () => {
  it("fails with single actionable not-found message when env file is absent", () => {
    const result = validatePhase2Env(null);
    assert.equal(result.ok, false);
    assert.equal(result.message, missingEnvFileMessage());
    assert.ok(result.message?.includes(`${ENV_FILE} was not found`));
    assert.ok(result.message?.includes(`cp ${ENV_EXAMPLE_FILE} ${ENV_FILE}`));
    assert.ok(result.message?.includes(DEPLOY_COMMAND));
  });

  it("fails with single actionable incomplete message listing all missing keys when env is empty", () => {
    const result = validatePhase2Env({});
    assert.equal(result.ok, false);
    assert.deepEqual(result.missingKeys, [...REQUIRED_PHASE2_KEYS]);
    assert.equal(result.message, missingPhase2KeysMessage(REQUIRED_PHASE2_KEYS));
    assert.ok(
      result.message?.includes(
        `.env.phase2 is incomplete: ${REQUIRED_PHASE2_KEYS.length} required key(s) are missing:`,
      ),
    );
    for (const key of REQUIRED_PHASE2_KEYS) {
      assert.ok(result.message?.includes(`- ${key}`));
    }
    assert.ok(result.message?.includes(`cp ${ENV_EXAMPLE_FILE} .env.phase2`));
    assert.ok(result.message?.includes(DEPLOY_COMMAND));
  });

  it("lists only the specific missing keys when env is partially populated", () => {
    const partial = {
      PHASE2_GUARD: unsafeContractAddress("CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44"),
      PHASE2_TOKEN: unsafeContractAddress("CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB"),
    };
    const result = validatePhase2Env(partial);
    assert.equal(result.ok, false);
    assert.equal(result.missingKeys?.length, 4);
    assert.ok(!result.missingKeys?.includes("PHASE2_GUARD"));
    assert.ok(!result.missingKeys?.includes("PHASE2_TOKEN"));
    assert.ok(result.missingKeys?.includes("PHASE2_ADMIN_SECRET"));
    assert.ok(result.missingKeys?.includes("PHASE2_AGENT_SECRET"));
    assert.ok(result.missingKeys?.includes("PHASE2_RECIPIENT_SECRET"));
    assert.ok(result.missingKeys?.includes("PHASE2_OUTSIDER_SECRET"));
  });

  it("passes validation when all required Phase 2 keys are populated", () => {
    const complete: Record<string, string> = {};
    for (const key of REQUIRED_PHASE2_KEYS) {
      complete[key] = "test-value";
    }
    const result = validatePhase2Env(complete);
    assert.equal(result.ok, true);
    assert.equal(result.message, undefined);
    assert.equal(result.missingKeys, undefined);
  });

  it("parses env file content ignoring comments, blank lines, and whitespace", () => {
    const raw = `
# This is a comment
PHASE2_GUARD=CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44

  # Another comment
PHASE2_TOKEN=CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB
PHASE2_EXTRA=some=complex=value
`;
    const parsed = parseEnvContent(raw);
    assert.equal(parsed["PHASE2_GUARD"], "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44");
    assert.equal(parsed["PHASE2_TOKEN"], "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB");
    assert.equal(parsed["PHASE2_EXTRA"], "some=complex=value");
    assert.equal(parsed["# This is a comment"], undefined);
  });
});
