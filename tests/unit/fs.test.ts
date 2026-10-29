/**
 * Policy file loader tests (issue #105).
 *
 * The three failure modes are asserted by class (and, for the filesystem case,
 * by errno code) rather than by message text, because a script integrator is
 * expected to branch on the class.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import {
  PolicyDecodeError,
  PolicyFileReadError,
  PolicyValidationError,
  policyToJson,
  unsafeAccountAddress,
  unsafeContractAddress,
  type PolicyConfig,
} from "../../src/index.ts";
import { loadPolicyFromFile } from "../../src/fs.ts";

const TOKEN = unsafeContractAddress("CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB");
const RECIPIENT = unsafeAccountAddress("GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH");

const scratch = mkdtempSync(join(tmpdir(), "stellar-agent-guard-fs-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function samplePolicy(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return {
    per_tx_cap: 1000n,
    window_secs: 60n,
    window_cap: 150n,
    assets: [TOKEN],
    protocols: [],
    recipients: [RECIPIENT],
    allow_any_recipient: false,
    active_from: 0n,
    active_until: 0n,
    paused: false,
    dms_grace_secs: 0n,
    ...overrides,
  };
}

function writeTemp(name: string, contents: string): string {
  const file = join(scratch, name);
  writeFileSync(file, contents, "utf8");
  return file;
}

describe("loadPolicyFromFile (issue #105)", () => {
  it("returns a validated policy from a JSON file", async () => {
    const expected = samplePolicy();
    const file = writeTemp("valid.json", JSON.stringify(policyToJson(expected)));

    const loaded = await loadPolicyFromFile(file);

    assert.deepEqual(loaded, expected);
  });

  it("accepts the guard address and applies its self-reference rule", async () => {
    const guard = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
    const file = writeTemp(
      "self-asset.json",
      JSON.stringify(policyToJson(samplePolicy({ assets: [unsafeContractAddress(guard)] }))),
    );

    await assert.rejects(loadPolicyFromFile(file, { guardAddress: guard }), (error: unknown) => {
      assert(error instanceof PolicyValidationError);
      assert.ok(error.failures.some((failure) => failure.rule === "self_as_asset"));
      return true;
    });
  });

  it("rejects a missing file with PolicyFileReadError and errno ENOENT", async () => {
    const missing = join(scratch, "does-not-exist.json");

    await assert.rejects(loadPolicyFromFile(missing), (error: unknown) => {
      assert(error instanceof PolicyFileReadError);
      assert.equal(error.path, missing);
      assert.equal(error.code, "ENOENT");
      return true;
    });
  });

  it("rejects invalid JSON with PolicyDecodeError", async () => {
    const file = writeTemp("invalid.json", "{ not json");

    await assert.rejects(loadPolicyFromFile(file), (error: unknown) => {
      assert(error instanceof PolicyDecodeError);
      assert.equal(error.path, "policy");
      assert.match(error.message, /not valid JSON/);
      return true;
    });
  });

  it("rejects a structurally valid policy that violates SPEC §8 with every failure", async () => {
    // Duplicate recipients and an inverted active window: both parse as JSON
    // policy, both fail validation, and both must be reported together.
    const file = writeTemp(
      "invalid-policy.json",
      JSON.stringify(
        policyToJson(
          samplePolicy({
            recipients: [RECIPIENT, RECIPIENT],
            active_from: 100n,
            active_until: 50n,
          }),
        ),
      ),
    );

    await assert.rejects(loadPolicyFromFile(file), (error: unknown) => {
      assert(error instanceof PolicyValidationError);
      assert.equal(error.path, file);
      const rules = error.failures.map((failure) => failure.rule);
      assert.ok(rules.includes("duplicate_recipient"));
      assert.ok(rules.includes("active_window_inverted"));
      assert.match(error.message, /2 failure\(s\)/);
      return true;
    });
  });

  it("keeps node:fs out of the root entry's import graph", () => {
    const rootEntry = readFileSync(resolve(process.cwd(), "src/index.ts"), "utf8");

    assert.ok(!rootEntry.includes("node:fs"), "root entry must not import node:fs");
    assert.ok(!rootEntry.includes('"./fs.ts"'), "root entry must not re-export the ./fs subpath");
  });
});
