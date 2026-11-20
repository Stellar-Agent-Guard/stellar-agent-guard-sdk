/**
 * Tests for npm provenance attestations and publish workflow security (issue #492).
 *
 * Verifies that:
 * - `.github/workflows/publish.yml` carries `id-token: write` under least privilege.
 * - No other workflow file in `.github/workflows/` gains `id-token: write`.
 * - The publish step specifies `--provenance` with fallback to token-based publishing.
 * - A post-publish attestation verification step is defined.
 * - Dry-run execution is supported without requiring an auth token.
 * - Consumer provenance verification commands are documented in docs/releasing.md and docs/security-posture.md.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const ROOT = process.cwd();
const WORKFLOWS_DIR = resolve(ROOT, ".github/workflows");
const PUBLISH_YML = resolve(WORKFLOWS_DIR, "publish.yml");
const RELEASING_DOC = resolve(ROOT, "docs/releasing.md");
const SECURITY_POSTURE_DOC = resolve(ROOT, "docs/security-posture.md");

describe("publish workflow and npm provenance attestations (issue #492)", () => {
  it("grants id-token: write strictly to the publish job in publish.yml", () => {
    const content = readFileSync(PUBLISH_YML, "utf8");

    // Top-level permissions must be read-only
    assert.match(
      content,
      /permissions:\s*\n\s+contents:\s*read/,
      "publish.yml top-level permissions must remain contents: read",
    );

    // Job-level permissions must include id-token: write and contents: read
    assert.match(
      content,
      /publish:\s*\n[\s\S]*?permissions:\s*\n\s+contents:\s*read\s*\n\s+id-token:\s*write/,
      "publish job must have least-privilege permissions: contents: read and id-token: write",
    );
  });

  it("ensures no other workflow gains id-token: write", () => {
    const workflowFiles = readdirSync(WORKFLOWS_DIR).filter(
      (f) => f.endsWith(".yml") || f.endsWith(".yaml"),
    );
    assert.ok(workflowFiles.length > 1, "expected multiple workflow files in .github/workflows");

    for (const file of workflowFiles) {
      if (file === "publish.yml") continue;
      const content = readFileSync(resolve(WORKFLOWS_DIR, file), "utf8");
      assert.doesNotMatch(
        content,
        /id-token:\s*write/,
        `Workflow ${file} must not have id-token: write permission`,
      );
    }
  });

  it("includes --provenance in the publish step and provides fallback to token-based publish", () => {
    const content = readFileSync(PUBLISH_YML, "utf8");

    // Must include --provenance
    assert.match(
      content,
      /npm publish .*?--provenance/,
      "publish command must specify --provenance",
    );

    // Must include fallback to token-based publish without --provenance
    assert.match(
      content,
      /\|\|\s*\{[\s\S]*?npm publish "\$RELEASE_TARBALL" --access public[\s\S]*?\}/,
      "publish step must fall back to standard token-based publish if provenance is unavailable",
    );
  });

  it("includes post-publish attestation verification using registry API", () => {
    const content = readFileSync(PUBLISH_YML, "utf8");

    assert.match(
      content,
      /name:\s*verify attestation/,
      "workflow must include an attestation verification step",
    );
    assert.match(
      content,
      /https:\/\/registry\.npmjs\.org\/-\/npm\/v1\/attestations/,
      "verification step must query the npm registry attestations endpoint",
    );
  });

  it("supports dry-run without requiring an auth token", () => {
    const content = readFileSync(PUBLISH_YML, "utf8");

    assert.match(
      content,
      /inputs:\s*\n\s+dry_run:/,
      "publish.yml must define dry_run workflow input",
    );
    assert.match(
      content,
      /npm publish "\$RELEASE_TARBALL" --access public --dry-run/,
      "publish step must support dry-run invocation",
    );
  });

  it("documents consumer provenance verification commands in docs/releasing.md", () => {
    const content = readFileSync(RELEASING_DOC, "utf8");

    assert.match(
      content,
      /npm audit signatures/,
      "docs/releasing.md must document npm audit signatures",
    );
    assert.match(
      content,
      /npm audit signatures --json --include-attestations/,
      "docs/releasing.md must document full attestation inspection command",
    );
    assert.match(
      content,
      /https:\/\/registry\.npmjs\.org\/-\/npm\/v1\/attestations/,
      "docs/releasing.md must document registry attestations API check",
    );
    assert.match(
      content,
      /npm publish --dry-run/,
      "docs/releasing.md must document dry run publish",
    );
  });

  it("documents consumer provenance verification and security guarantees in docs/security-posture.md", () => {
    const content = readFileSync(SECURITY_POSTURE_DOC, "utf8");

    assert.match(
      content,
      /## Publish provenance and supply-chain attestations/,
      "docs/security-posture.md must have a section on publish provenance",
    );
    assert.match(
      content,
      /npm audit signatures/,
      "docs/security-posture.md must document npm audit signatures",
    );
    assert.match(
      content,
      /https:\/\/registry\.npmjs\.org\/-\/npm\/v1\/attestations/,
      "docs/security-posture.md must document registry attestations API",
    );
    assert.match(
      content,
      /id-token:\s*write/,
      "docs/security-posture.md must document least-privilege id-token: write restriction",
    );
  });
});
