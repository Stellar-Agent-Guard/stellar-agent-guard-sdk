/**
 * Markdown link checker (issue #140): extraction, anchors, and resolution rules.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  anchorsOf,
  checkRelative,
  extractLinks,
  isExternal,
  markdownFiles,
  slugify,
  stripComments,
} from "../../scripts/check-doc-links.ts";

describe("extractLinks", () => {
  const targets = (md: string) => extractLinks("x.md", md).map((l) => l.target);

  it("finds inline links, images, reference definitions and <a href>", () => {
    const md = [
      "See [a](docs/a.md) and ![img](img/x.png \"title\").",
      "[ref]: ./b.md#part",
      '<a href="c.md">c</a>',
    ].join("\n");
    assert.deepEqual(targets(md), ["docs/a.md", "img/x.png", "./b.md#part", "c.md"]);
  });

  it("reports 1-based line numbers", () => {
    assert.deepEqual(extractLinks("x.md", "\n\n[a](a.md)").map((l) => l.line), [3]);
  });

  it("ignores fenced code, inline code and HTML comments", () => {
    const md = [
      "```md",
      "[fenced](nope.md)",
      "```",
      "`[inline](nope.md)`",
      "<!-- [commented](nope.md) -->",
      "<!--",
      "[multi-line comment](nope.md)",
      "-->",
      "[real](yes.md)",
    ].join("\n");
    assert.deepEqual(extractLinks("x.md", md).map((l) => [l.target, l.line]), [["yes.md", 9]]);
  });

  it("keeps line numbers stable across stripped comments", () => {
    assert.equal(stripComments("a\n<!--\nb\n-->\nc").split("\n").length, 5);
  });
});

describe("anchors", () => {
  it("slugifies like GitHub", () => {
    assert.equal(slugify("Pre-flight gates (any contributor can run these)"), "pre-flight-gates-any-contributor-can-run-these");
    assert.equal(slugify("`dmsUrgency()` — tri-state"), "dmsurgency--tri-state");
    assert.equal(slugify("0.x breaking-change communication"), "0x-breaking-change-communication");
  });

  it("dedupes repeated headings with -N and includes explicit anchors", () => {
    const anchors = anchorsOf("# Setup\n## Setup\n<a id=\"custom\"></a>\n```\n# not a heading\n```");
    assert.deepEqual([...anchors].sort(), ["custom", "setup", "setup-1"]);
  });
});

describe("checkRelative", () => {
  const dir = mkdtempSync(join(tmpdir(), "doc-links-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "README.md"), "# Title\n## Usage\n");
  writeFileSync(join(dir, "docs", "guide.md"), "# Guide\n");
  const from = join(dir, "README.md");
  const check = (target: string) => checkRelative({ file: from, line: 1, target });

  it("accepts existing files, directories and anchors", () => {
    assert.equal(check("docs/guide.md"), null);
    assert.equal(check("docs"), null);
    assert.equal(check("docs/guide.md#guide"), null);
    assert.equal(check("#usage"), null);
  });

  it("rejects missing files and missing anchors", () => {
    assert.match(check("docs/missing.md") ?? "", /does not exist/);
    assert.match(check("docs/guide.md#nope") ?? "", /no heading or anchor #nope/);
    assert.match(check("#nope") ?? "", /in this file/);
  });

  it("does not check anchors on non-Markdown targets", () => {
    writeFileSync(join(dir, "code.ts"), "");
    assert.equal(check("code.ts#L10"), null);
  });
});

describe("scope", () => {
  it("classifies external URLs", () => {
    assert.equal(isExternal("https://example.com"), true);
    assert.equal(isExternal("docs/a.md"), false);
    assert.equal(isExternal("mailto:a@b.c"), false);
  });

  it("checks root Markdown and docs/, skipping fixtures", () => {
    const files = markdownFiles(process.cwd()).map((f) => f.slice(process.cwd().length + 1));
    assert.ok(files.includes("README.md"));
    assert.ok(files.some((f) => f.startsWith("docs/")));
    assert.ok(!files.some((f) => f.includes("fixtures")));
  });
});

describe("repository docs", () => {
  it("have no broken relative links or anchors (the PR gate, run in-suite)", async () => {
    const { spawnSync } = await import("node:child_process");
    const run = spawnSync(process.execPath, ["scripts/check-doc-links.ts"], { encoding: "utf-8" });
    assert.equal(run.status, 0, run.stdout + run.stderr);
  });
});
