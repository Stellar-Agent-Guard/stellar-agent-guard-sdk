/**
 * Offline tests for `scripts/check-fixture-drift.ts` (issue #490).
 *
 * The scheduled workflow is the only caller that touches the network; here the
 * fetcher and the vendored digests are injected, so drift classification, the
 * issue body and the pin bump are verified without fetching anything.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  REMEDIATION_COMMAND,
  bumpPins,
  checkDrift,
  renderIssueBody,
  upstreamDigest,
  vendoredDigest,
} from "../../scripts/check-fixture-drift.ts";
import { VENDORED_ARTIFACTS, type VendoredArtifact } from "../../scripts/vendor-fixtures.ts";

const HEAD = "a".repeat(40);
const RAW = '{"b": 2, "a": 1}';

function artifact(overrides: Partial<VendoredArtifact>): VendoredArtifact {
  return {
    sourceRepo: "Stellar-Agent-Guard/stellar-agent-guard-contracts",
    repoCommit: "1".repeat(40),
    sourcePath: "x.json",
    outputPath: "tests/fixtures/vendor/x.json",
    upstreamLanded: true,
    ...overrides,
  };
}

describe("fixture drift check (issue #490)", () => {
  it("every registered feed has a vendored digest the check can read", () => {
    assert.ok(VENDORED_ARTIFACTS.length >= 4);
    for (const a of VENDORED_ARTIFACTS) assert.match(vendoredDigest(a), /^sha256:[0-9a-f]{64}$/);
  });

  it("classifies in-sync, drifted, not-landed and landed feeds", async () => {
    const same = artifact({ outputPath: "same.json", sourcePath: "same.json" });
    const changed = artifact({ outputPath: "changed.json", sourcePath: "changed.json" });
    const ahead = artifact({
      outputPath: "ahead.json",
      sourcePath: "ahead.json",
      upstreamLanded: false,
    });
    const nowLanded = artifact({
      outputPath: "landed.json",
      sourcePath: "landed.json",
      upstreamLanded: false,
    });
    const pinned = upstreamDigest(same, RAW);

    const fetched: string[] = [];
    const report = await checkDrift({
      upstreamCommit: HEAD,
      artifacts: [same, changed, ahead, nowLanded],
      readVendoredDigest: () => pinned,
      fetch: async (a) => {
        fetched.push(`${a.sourcePath}@${a.repoCommit}`);
        if (a.sourcePath === "same.json") return RAW;
        if (a.sourcePath === "changed.json") return '{"a": 1, "b": 3}';
        if (a.sourcePath === "landed.json") return RAW;
        return null;
      },
    });

    assert.deepEqual(
      report.results.map((r) => r.status),
      ["in-sync", "drifted", "not-landed", "landed"],
    );
    assert.equal(report.drift, true);
    assert.ok(
      fetched.every((f) => f.endsWith(`@${HEAD}`)),
      "fetches at upstream HEAD, not the pin",
    );
  });

  it("canonicalises before hashing, so formatting-only upstream changes are not drift", async () => {
    const a = artifact({});
    const report = await checkDrift({
      upstreamCommit: HEAD,
      artifacts: [a],
      readVendoredDigest: () => upstreamDigest(a, RAW),
      fetch: async () => '{\n    "b": 2,\n    "a": 1\n}',
    });
    assert.equal(report.results[0]!.status, "in-sync");
    assert.equal(report.drift, false);
  });

  it("fails loudly when a landed feed disappears upstream", async () => {
    await assert.rejects(
      checkDrift({
        upstreamCommit: HEAD,
        artifacts: [artifact({})],
        readVendoredDigest: () => "sha256:0",
        fetch: async () => null,
      }),
      /missing upstream/,
    );
  });

  it("renders a deduplicable issue body with a copy-pasteable remediation", async () => {
    const report = await checkDrift({
      upstreamCommit: HEAD,
      artifacts: [artifact({})],
      readVendoredDigest: () => "sha256:0",
      fetch: async () => RAW,
    });
    const body = renderIssueBody(report, "https://example.invalid/run/1");
    assert.match(
      body,
      new RegExp("```sh\\n" + REMEDIATION_COMMAND.replace(/[-]/g, "\\-") + "\\n```"),
    );
    assert.match(body, /\*\*drifted\*\*/);
    assert.match(body, /https:\/\/example\.invalid\/run\/1/);
    assert.match(body, /aaaaaaa/);
  });

  it("bumps exactly the drifted feeds' pins in vendor-fixtures.ts", async () => {
    const source = readFileSync("scripts/vendor-fixtures.ts", "utf8");
    const target = VENDORED_ARTIFACTS.find((a) => a.upstreamLanded)!;
    const report = await checkDrift({
      upstreamCommit: HEAD,
      artifacts: [target],
      readVendoredDigest: () => "sha256:0",
      fetch: async () => RAW,
    });
    const bumped = bumpPins(source, report);
    assert.ok(bumped.includes(`repoCommit: "${HEAD}"`));
    assert.ok(!bumped.includes(`repoCommit: "${target.repoCommit}"`));
    // Every other pin is untouched.
    for (const other of VENDORED_ARTIFACTS.filter((a) => a.repoCommit !== target.repoCommit)) {
      assert.ok(bumped.includes(`repoCommit: "${other.repoCommit}"`));
    }
  });
});
