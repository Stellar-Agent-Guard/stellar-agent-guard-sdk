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
import { diffPolicyFiles, formatPolicyDiff, loadPolicyFromFile } from "../../src/fs.ts";

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

describe("diffPolicyFiles (issue #499)", () => {
  it("returns structured diff and formatted summary for two distinct valid policy files", async () => {
    const fileA = writeTemp(
      "diff-left.json",
      JSON.stringify(policyToJson(samplePolicy({ per_tx_cap: 1000n }))),
    );
    const fileB = writeTemp(
      "diff-right.json",
      JSON.stringify(policyToJson(samplePolicy({ per_tx_cap: 2000n }))),
    );

    const result = await diffPolicyFiles(fileA, fileB);

    assert.equal(result.diff.length, 1);
    assert.equal(result.changes.length, 1);
    assert.equal(result.diff[0]!.field, "per_tx_cap");
    assert.equal(result.diff[0]!.kind, "changed");
    assert.equal(result.diff[0]!.before, 1000n);
    assert.equal(result.diff[0]!.after, 2000n);
    assert.match(result.summary, /~ per_tx_cap: 1000 -> 2000/);
  });

  it("returns empty diff and empty summary for identical policy files", async () => {
    const fileA = writeTemp("diff-identical-1.json", JSON.stringify(policyToJson(samplePolicy())));
    const fileB = writeTemp("diff-identical-2.json", JSON.stringify(policyToJson(samplePolicy())));

    const result = await diffPolicyFiles(fileA, fileB);

    assert.deepEqual(result.diff, []);
    assert.deepEqual(result.changes, []);
    assert.equal(result.summary, "");
  });

  it("rejects when left file is missing with PolicyFileReadError naming left", async () => {
    const missing = join(scratch, "missing-left.json");
    const valid = writeTemp("diff-valid-right.json", JSON.stringify(policyToJson(samplePolicy())));

    await assert.rejects(diffPolicyFiles(missing, valid), (error: unknown) => {
      assert(error instanceof PolicyFileReadError);
      assert.equal(error.path, missing);
      assert.match(error.message, /^left policy file/);
      return true;
    });
  });

  it("rejects when right file is missing with PolicyFileReadError naming right", async () => {
    const valid = writeTemp("diff-valid-left.json", JSON.stringify(policyToJson(samplePolicy())));
    const missing = join(scratch, "missing-right.json");

    await assert.rejects(diffPolicyFiles(valid, missing), (error: unknown) => {
      assert(error instanceof PolicyFileReadError);
      assert.equal(error.path, missing);
      assert.match(error.message, /^right policy file/);
      return true;
    });
  });

  it("rejects when left file has invalid JSON with PolicyDecodeError naming left", async () => {
    const invalid = writeTemp("diff-invalid-left.json", "{ broken");
    const valid = writeTemp(
      "diff-valid-right-2.json",
      JSON.stringify(policyToJson(samplePolicy())),
    );

    await assert.rejects(diffPolicyFiles(invalid, valid), (error: unknown) => {
      assert(error instanceof PolicyDecodeError);
      assert.match(error.message, /^left policy file/);
      return true;
    });
  });

  it("rejects when right file has invalid JSON with PolicyDecodeError naming right", async () => {
    const valid = writeTemp("diff-valid-left-2.json", JSON.stringify(policyToJson(samplePolicy())));
    const invalid = writeTemp("diff-invalid-right.json", "{ broken");

    await assert.rejects(diffPolicyFiles(valid, invalid), (error: unknown) => {
      assert(error instanceof PolicyDecodeError);
      assert.match(error.message, /^right policy file/);
      return true;
    });
  });

  it("rejects when left file fails validation with PolicyValidationError naming left", async () => {
    const invalidPolicy = writeTemp(
      "diff-invalid-policy-left.json",
      JSON.stringify(
        policyToJson(
          samplePolicy({
            recipients: [RECIPIENT, RECIPIENT],
          }),
        ),
      ),
    );
    const valid = writeTemp(
      "diff-valid-right-3.json",
      JSON.stringify(policyToJson(samplePolicy())),
    );

    await assert.rejects(diffPolicyFiles(invalidPolicy, valid), (error: unknown) => {
      assert(error instanceof PolicyValidationError);
      assert.match(error.message, /^left policy file/);
      return true;
    });
  });

  it("rejects when right file fails validation with PolicyValidationError naming right", async () => {
    const valid = writeTemp("diff-valid-left-3.json", JSON.stringify(policyToJson(samplePolicy())));
    const invalidPolicy = writeTemp(
      "diff-invalid-policy-right.json",
      JSON.stringify(
        policyToJson(
          samplePolicy({
            recipients: [RECIPIENT, RECIPIENT],
          }),
        ),
      ),
    );

    await assert.rejects(diffPolicyFiles(valid, invalidPolicy), (error: unknown) => {
      assert(error instanceof PolicyValidationError);
      assert.match(error.message, /^right policy file/);
      return true;
    });
  });

  it("validates guardAddress self-reference rules on both sides before diffing", async () => {
    const guard = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
    const selfAsset = writeTemp(
      "diff-self-asset.json",
      JSON.stringify(policyToJson(samplePolicy({ assets: [unsafeContractAddress(guard)] }))),
    );
    const valid = writeTemp("diff-valid-both.json", JSON.stringify(policyToJson(samplePolicy())));

    await assert.rejects(
      diffPolicyFiles(selfAsset, valid, { guardAddress: guard }),
      (error: unknown) => {
        assert(error instanceof PolicyValidationError);
        assert.match(error.message, /^left policy file/);
        return true;
      },
    );

    await assert.rejects(
      diffPolicyFiles(valid, selfAsset, { guardAddress: guard }),
      (error: unknown) => {
        assert(error instanceof PolicyValidationError);
        assert.match(error.message, /^right policy file/);
        return true;
      },
    );
  });

  it("formatPolicyDiff renders additions, removals, and changes accurately", () => {
    const formatted = formatPolicyDiff([
      { field: "per_tx_cap", path: "per_tx_cap", kind: "changed", before: 100n, after: 200n },
      { field: "recipients", path: "recipients[0]", kind: "added", after: "GAOBC" },
      { field: "recipients", path: "recipients[1]", kind: "removed", before: "GBRPY" },
    ]);

    assert.equal(
      formatted,
      "~ per_tx_cap: 100 -> 200\n+ recipients[0]: GAOBC\n- recipients[1]: GBRPY",
    );
    assert.equal(formatPolicyDiff([]), "");
  });
});
