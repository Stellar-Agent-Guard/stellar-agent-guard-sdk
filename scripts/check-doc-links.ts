#!/usr/bin/env node
/**
 * Markdown link checker (issues #78 and #140). Zero dependencies: Node built-ins only.
 *
 *   node scripts/check-doc-links.ts               # relative links + anchors (PR gate)
 *   node scripts/check-doc-links.ts --external    # also probe http(s) URLs (scheduled sweep)
 *
 * What is checked, in every tracked-style Markdown file (root `*.md` and
 * `docs/**\/*.md`; `node_modules`, `dist`, `coverage` and test fixtures are skipped):
 *
 * - **Relative links** (`[x](docs/a.md)`, `[x](../src/policy.ts)`, `[x]: ./a.md`):
 *   the target file or directory must exist. A `#fragment` on a Markdown target
 *   must match a heading (GitHub's slug rules) or an explicit `<a id|name>`.
 * - **Same-file anchors** (`[x](#section)`): same heading/anchor rule.
 * - **External URLs** (`http://`, `https://`), only with `--external`: a HEAD
 *   request (falling back to GET) must answer with a status below 400.
 *
 * Links inside fenced code blocks, inline code spans and HTML comments
 * (`<!-- ... -->`, i.e. deliberately disabled Markdown) are ignored. Excludes
 * live in `scripts/doc-links.config.json`, each with its reason.
 *
 * Exit status: `1` when any relative link or anchor is broken. External
 * failures are reported (stdout, `::warning` annotations, and the job summary
 * when `GITHUB_STEP_SUMMARY` is set) but do not fail the run unless
 * `--strict-external` is passed — see the policy note in
 * `.github/workflows/links.yml`.
 */
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface DocLink {
  file: string;
  line: number;
  target: string;
}

export interface LinkFailure extends DocLink {
  reason: string;
}

interface Config {
  ignore: Array<{ pattern: string; reason: string }>;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".git", "fixtures"]);

/** Markdown files to check: root `*.md` plus everything under `docs/`. */
export function markdownFiles(root: string): string[] {
  const files = readdirSync(root)
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(root, name));
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".md")) files.push(path);
    }
  };
  const docs = join(root, "docs");
  if (existsSync(docs)) walk(docs);
  return files.sort();
}

/** Blank out HTML comments, keeping newlines so line numbers stay correct. */
export function stripComments(markdown: string): string {
  return markdown.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " "));
}

/** Every link target in `markdown`, with 1-based line numbers. */
export function extractLinks(file: string, markdown: string): DocLink[] {
  const links: DocLink[] = [];
  let fenced = false;
  stripComments(markdown).split("\n").forEach((rawLine, index) => {
    if (/^\s*(```|~~~)/.test(rawLine)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const line = rawLine.replace(/`[^`]*`/g, "");
    const push = (target: string | undefined): void => {
      if (target === undefined) return;
      const cleaned = target.trim().replace(/^<|>$/g, "");
      if (cleaned !== "") links.push({ file, line: index + 1, target: cleaned });
    };
    // Inline links and images: [text](target "title") — target up to space or ')'.
    for (const match of line.matchAll(/!?\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g)) {
      push(match[1]);
    }
    // Reference definitions: [label]: target
    const reference = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/.exec(line);
    if (reference) push(reference[1]);
    // Raw HTML anchors accept either quote style: <a href="..."> or <a href='...'>.
    for (const match of line.matchAll(/<a\s[^>]*href=(?:"([^"]+)"|'([^']+)')/gi)) {
      push(match[1] ?? match[2]);
    }
  });
  return links;
}

/** GitHub's heading-anchor slug: lowercase, drop punctuation, spaces to `-`. */
export function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

/** All anchors a Markdown document exposes (headings, with GitHub's `-N` dedupe, and `<a id|name>`). */
export function anchorsOf(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  let fenced = false;
  for (const line of stripComments(markdown).split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading?.[1] !== undefined) {
      const base = slugify(heading[1]);
      const count = seen.get(base) ?? 0;
      anchors.add(count === 0 ? base : `${base}-${count}`);
      seen.set(base, count + 1);
    }
    for (const match of line.matchAll(/<a\s[^>]*(?:id|name)="([^"]+)"/g)) {
      if (match[1] !== undefined) anchors.add(match[1]);
    }
  }
  return anchors;
}

export function isExternal(target: string): boolean {
  return /^https?:\/\//i.test(target);
}

/** Schemes that are neither files nor web pages (left alone). */
function isOtherScheme(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) && !isExternal(target);
}

/** Check one relative link or same-file anchor; `null` when it resolves. */
export function checkRelative(link: DocLink, readText: (path: string) => string = (p) => readFileSync(p, "utf-8")): string | null {
  const [rawPath = "", fragment] = link.target.split("#", 2);
  const path = decodeURIComponent(rawPath.split("?")[0] ?? "");
  const resolved = path === "" ? link.file : resolve(dirname(link.file), path);

  if (path !== "" && !existsSync(resolved)) return `target does not exist: ${path}`;
  if (fragment === undefined || fragment === "") return null;
  if (!resolved.endsWith(".md") || statSync(resolved).isDirectory()) return null;

  const anchors = anchorsOf(readText(resolved));
  const wanted = decodeURIComponent(fragment).toLowerCase();
  return anchors.has(wanted) ? null : `no heading or anchor #${fragment} in ${path === "" ? "this file" : path}`;
}

async function checkExternal(url: string, timeoutMs = 15_000): Promise<string | null> {
  for (const method of ["HEAD", "GET"] as const) {
    try {
      const response = await fetch(url, {
        method,
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "user-agent": "stellar-agent-guard-sdk link checker" },
      });
      if (response.status < 400) return null;
      // Some servers reject HEAD (405/403) but serve GET; only GET's verdict is final.
      if (method === "GET") return `HTTP ${response.status}`;
    } catch (error) {
      if (method === "GET") return error instanceof Error ? error.message : String(error);
    }
  }
  return "unreachable";
}

function loadConfig(): Config {
  const path = join(ROOT, "scripts", "doc-links.config.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as Config) : { ignore: [] };
}

function summarize(title: string, failures: LinkFailure[]): string {
  if (failures.length === 0) return `### ${title}\n\nNo broken links.\n`;
  const rows = failures.map(
    (f) => `| \`${relative(ROOT, f.file)}:${f.line}\` | \`${f.target}\` | ${f.reason} |`,
  );
  return [`### ${title} — ${failures.length} broken`, "", "| Location | Link | Problem |", "|---|---|---|", ...rows, ""].join("\n");
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const external = args.has("--external") || args.has("--strict-external");
  const strictExternal = args.has("--strict-external");
  const ignore = loadConfig().ignore.map((entry) => new RegExp(entry.pattern));

  const files = markdownFiles(ROOT);
  const links = files.flatMap((file) => extractLinks(file, readFileSync(file, "utf-8")));
  const kept = links.filter((link) => !ignore.some((pattern) => pattern.test(link.target)));

  const relativeFailures: LinkFailure[] = [];
  const externalLinks: DocLink[] = [];
  for (const link of kept) {
    if (isExternal(link.target)) externalLinks.push(link);
    else if (!isOtherScheme(link.target)) {
      const reason = checkRelative(link);
      if (reason !== null) relativeFailures.push({ ...link, reason });
    }
  }

  const externalFailures: LinkFailure[] = [];
  if (external) {
    const unique = [...new Set(externalLinks.map((link) => link.target))];
    const verdicts = new Map<string, string | null>();
    for (let i = 0; i < unique.length; i += 8) {
      const batch = unique.slice(i, i + 8);
      const results = await Promise.all(batch.map((url) => checkExternal(url)));
      batch.forEach((url, j) => verdicts.set(url, results[j] ?? null));
    }
    for (const link of externalLinks) {
      const reason = verdicts.get(link.target);
      if (reason) externalFailures.push({ ...link, reason });
    }
  }

  for (const f of relativeFailures) {
    console.log(`::error file=${relative(ROOT, f.file)},line=${f.line}::broken link ${f.target}: ${f.reason}`);
  }
  for (const f of externalFailures) {
    console.log(`::warning file=${relative(ROOT, f.file)},line=${f.line}::unreachable link ${f.target}: ${f.reason}`);
  }
  const summary = [
    `## Docs link check`,
    "",
    `${files.length} Markdown files, ${kept.length} links (${links.length - kept.length} excluded by config).`,
    "",
    summarize("Relative links and anchors", relativeFailures),
    external ? summarize(`External URLs (${new Set(externalLinks.map((l) => l.target)).size} unique)`, externalFailures) : "External URLs not checked (pass --external).\n",
  ].join("\n");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);

  if (relativeFailures.length > 0 || (strictExternal && externalFailures.length > 0)) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
