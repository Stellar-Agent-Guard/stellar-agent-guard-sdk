#!/usr/bin/env node
/**
 * Contract-fixture drift check (issue #490).
 *
 * `tests/fixtures/vendor/*.json` are hash-pinned to a contracts commit and only
 * change when someone runs `npm run vendor:refresh`. This script answers "has
 * upstream moved on since we pinned?" for every registered feed in
 * `scripts/vendor-fixtures.ts` (`VENDORED_ARTIFACTS`: reasons, policy schema,
 * policy vectors, auth vocabulary):
 *
 *   1. resolve the contracts repo's default-branch HEAD;
 *   2. fetch each artifact at that commit and apply the feed's own transform
 *      and canonicalisation — the exact pipeline `vendor:refresh` uses;
 *   3. compare the digest with the vendored file's `_provenance.digest`.
 *
 * It is run by `.github/workflows/fixture-drift.yml` on a schedule, never by
 * `ci`: pull requests must not depend on the network or on upstream's state.
 * The check itself never fails on drift (exit 0); it reports through
 * `--report <file>` (a markdown issue body) and `$GITHUB_OUTPUT` (`drift=`).
 * It exits non-zero only when it could not check (network/API failure).
 *
 * Remediation is one command, printed in the report:
 *
 *   npm run vendor:drift -- --fix
 *
 * which bumps each drifted feed's `repoCommit` in `scripts/vendor-fixtures.ts`
 * to the upstream HEAD and re-vendors it (`refreshArtifact`), leaving a diff to
 * review and commit.
 *
 * No secret is needed: the GitHub API and raw.githubusercontent.com are read
 * anonymously. If `GH_TOKEN`/`GITHUB_TOKEN` is set it is sent only to
 * api.github.com, to lift the anonymous rate limit.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  VENDORED_ARTIFACTS,
  canonicalSchemaContent,
  contentDigest,
  fetchUpstream,
  refreshArtifact,
  type VendoredArtifact,
} from "./vendor-fixtures.ts";

export type DriftStatus =
  /** Upstream HEAD content matches the vendored digest. */
  | "in-sync"
  /** Upstream HEAD content differs: the vendored copy is stale. */
  | "drifted"
  /** Vendored ahead of upstream and the file still does not exist upstream. */
  | "not-landed"
  /** Vendored ahead of upstream and the file now exists upstream: refresh it. */
  | "landed";

export interface DriftResult {
  artifact: VendoredArtifact;
  status: DriftStatus;
  /** `sha256:<hex>` recorded in the vendored file. */
  vendoredDigest: string;
  /** `sha256:<hex>` of upstream HEAD, when the file exists there. */
  upstreamDigest?: string;
}

export interface DriftReport {
  upstreamCommit: string;
  results: DriftResult[];
  drift: boolean;
}

/** Fetches an artifact's raw source at a commit; `null` means 404 (not there). */
export type ArtifactFetcher = (artifact: VendoredArtifact) => Promise<string | null>;

export const REMEDIATION_COMMAND = "npm run vendor:drift -- --fix";

/** Digest a raw upstream file exactly as `vendor:refresh` would vendor it. */
export function upstreamDigest(artifact: VendoredArtifact, raw: string): string {
  const content = artifact.transform ? artifact.transform(raw) : raw;
  return `sha256:${contentDigest(canonicalSchemaContent(content))}`;
}

/** Read the `_provenance.digest` of a vendored file. */
export function vendoredDigest(artifact: VendoredArtifact, root = process.cwd()): string {
  const doc = JSON.parse(readFileSync(resolve(root, artifact.outputPath), "utf8")) as {
    _provenance?: { digest?: string };
  };
  const digest = doc._provenance?.digest;
  if (!digest) throw new Error(`${artifact.outputPath} has no _provenance.digest`);
  return digest;
}

/** Compare every registered feed's upstream HEAD with its vendored digest. */
export async function checkDrift(options: {
  upstreamCommit: string;
  fetch: ArtifactFetcher;
  artifacts?: readonly VendoredArtifact[];
  readVendoredDigest?: (artifact: VendoredArtifact) => string;
}): Promise<DriftReport> {
  const artifacts = options.artifacts ?? VENDORED_ARTIFACTS;
  const readDigest = options.readVendoredDigest ?? ((a) => vendoredDigest(a));
  const results: DriftResult[] = [];

  for (const artifact of artifacts) {
    const pinned = readDigest(artifact);
    const raw = await options.fetch({ ...artifact, repoCommit: options.upstreamCommit });
    if (raw === null) {
      if (artifact.upstreamLanded) {
        throw new Error(
          `${artifact.sourcePath} is missing upstream at ${options.upstreamCommit}, but the feed is marked as landed`,
        );
      }
      results.push({ artifact, status: "not-landed", vendoredDigest: pinned });
      continue;
    }
    const digest = upstreamDigest(artifact, raw);
    const status: DriftStatus = !artifact.upstreamLanded
      ? "landed"
      : digest === pinned
        ? "in-sync"
        : "drifted";
    results.push({ artifact, status, vendoredDigest: pinned, upstreamDigest: digest });
  }

  return {
    upstreamCommit: options.upstreamCommit,
    results,
    drift: results.some((r) => r.status === "drifted" || r.status === "landed"),
  };
}

const STATUS_LABEL: Record<DriftStatus, string> = {
  "in-sync": "in sync",
  drifted: "**drifted**",
  "not-landed": "not landed upstream (vendored ahead)",
  landed: "**landed upstream — refresh**",
};

/** Markdown body for the single tracking issue. */
export function renderIssueBody(report: DriftReport, runUrl?: string): string {
  const repo = report.results[0]?.artifact.sourceRepo ?? "upstream";
  const rows = report.results.map(
    (r) =>
      `| \`${r.artifact.outputPath}\` | \`${r.artifact.sourcePath}\` | \`${r.artifact.repoCommit.slice(0, 7)}\` | ${STATUS_LABEL[r.status]} |`,
  );
  return [
    `The vendored contract fixtures no longer match \`${repo}\` at [\`${report.upstreamCommit.slice(0, 7)}\`](https://github.com/${repo}/commit/${report.upstreamCommit}).`,
    "",
    "| Vendored file | Upstream path | Pinned commit | Status |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    "**Remediation** — from a clean checkout of `main`:",
    "",
    "```sh",
    REMEDIATION_COMMAND,
    "```",
    "",
    "This bumps each drifted feed's `repoCommit` in `scripts/vendor-fixtures.ts` to the upstream commit above and re-vendors it with a new digest. Review the diff (a changed reason, policy rule or schema may need SDK changes before the tests pass), then commit each file separately per `CONTRIBUTING.md`.",
    "",
    ...(report.results.some((r) => r.status === "landed")
      ? [
          "A feed marked **landed upstream** was vendored ahead of upstream: after the command, also set that feed's `upstreamLanded: true` in `scripts/vendor-fixtures.ts` (the refresh protocol in its docblock).",
          "",
        ]
      : []),
    ...(runUrl ? [`Detected by: ${runUrl}`, ""] : []),
    "_Maintained by the `fixture-drift` workflow: one open issue, updated on each drifting run and closed automatically when the fixtures match upstream again._",
  ].join("\n");
}

/** Rewrite drifted/landed feeds' `repoCommit` pins in vendor-fixtures.ts source. */
export function bumpPins(source: string, report: DriftReport): string {
  let next = source;
  for (const r of report.results) {
    if (r.status !== "drifted" && r.status !== "landed") continue;
    const old = `repoCommit: "${r.artifact.repoCommit}"`;
    const count = next.split(old).length - 1;
    if (count !== 1) {
      throw new Error(`expected exactly one ${old} in scripts/vendor-fixtures.ts, found ${count}`);
    }
    next = next.replace(old, `repoCommit: "${report.upstreamCommit}"`);
  }
  return next;
}

/* ── network side: used only when run as a script ─────────────────────────── */

async function resolveHeadCommit(repo: string): Promise<string> {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const response = await fetch(`https://api.github.com/repos/${repo}/commits/HEAD`, {
    headers: {
      accept: "application/vnd.github.sha",
      "user-agent": "stellar-agent-guard-sdk-fixture-drift",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} resolving ${repo} HEAD`);
  const sha = (await response.text()).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`unexpected HEAD sha for ${repo}: ${sha}`);
  return sha;
}

const networkFetcher: ArtifactFetcher = async (artifact) => {
  try {
    return await fetchUpstream(artifact);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("HTTP 404")) return null;
    throw error;
  }
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const reportPath = args.includes("--report") ? args[args.indexOf("--report") + 1] : undefined;
  const fix = args.includes("--fix");

  const repos = [...new Set(VENDORED_ARTIFACTS.map((a) => a.sourceRepo))];
  if (repos.length !== 1) throw new Error(`expected one upstream repo, got ${repos.join(", ")}`);
  const upstreamCommit = await resolveHeadCommit(repos[0]!);

  const report = await checkDrift({ upstreamCommit, fetch: networkFetcher });
  for (const r of report.results) {
    console.log(`[drift] ${r.status.padEnd(10)} ${r.artifact.outputPath}`);
  }
  console.log(
    `[drift] upstream ${repos[0]}@${upstreamCommit}: ${report.drift ? "DRIFT" : "no drift"}`,
  );

  if (reportPath) writeFileSync(reportPath, `${renderIssueBody(report, process.env.RUN_URL)}\n`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `drift=${report.drift}\nupstream=${upstreamCommit}\n`,
    );
  }

  if (fix && report.drift) {
    const scriptPath = resolve("scripts/vendor-fixtures.ts");
    writeFileSync(scriptPath, bumpPins(readFileSync(scriptPath, "utf8"), report));
    for (const r of report.results) {
      if (r.status !== "drifted" && r.status !== "landed") continue;
      const bumped = { ...r.artifact, repoCommit: upstreamCommit, upstreamLanded: true };
      const raw = await fetchUpstream(bumped);
      refreshArtifact(bumped, bumped.transform ? bumped.transform(raw) : raw);
      console.log(`[drift] re-vendored ${r.artifact.outputPath} at ${upstreamCommit.slice(0, 7)}`);
    }
    console.log(
      "[drift] review `git diff`, then commit scripts/vendor-fixtures.ts and each fixture separately.",
    );
  }
}

if (process.argv[1]?.endsWith("check-fixture-drift.ts")) {
  main().catch((error: unknown) => {
    console.error(
      `[drift] check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
