/**
 * README snippet audit (issue #92): which fences the audit sees, where it says
 * they are, and which of them it actually compiles.
 *
 * The script's own job is bookkeeping — pull the fenced `ts` and `bash` blocks
 * out of README.md, keep their line numbers, honour `no-check` and its reason,
 * and leave every other fence language alone — so that is what is pinned here.
 * The compile pass is exercised end to end by the required `ci` job
 * (`npm run check:readme-snippets`); without these cases, the part of the audit
 * that decides *what* gets compiled would be the one thing no test touches.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { extractSnippets } from "../../scripts/check-readme-snippets.ts";

/** One fenced block, from its info string to its closing fence. */
function fence(info: string, ...lines: string[]): string {
  return ["```" + info, ...lines, "```"].join("\n");
}

describe("extractSnippets", () => {
  it("captures a ts block with the 1-based line of its first code line", () => {
    const [snippet] = extractSnippets(["# Title", "", "```ts", "const a = 1;", "```"].join("\n"));

    assert.equal(snippet?.lang, "ts");
    assert.equal(snippet?.line, 4);
    assert.equal(snippet?.code, "const a = 1;");
    assert.equal(snippet?.skipped, false);
  });

  it("treats typescript as ts and keeps bash blocks instead of dropping them", () => {
    const snippets = extractSnippets(
      [fence("typescript", "const a = 1;"), "", fence("bash", "npm ci")].join("\n"),
    );

    assert.deepEqual(
      snippets.map((s) => s.lang),
      ["ts", "bash"],
    );
    // A bash block is never compiled, so it is never `no-check`-skipped either:
    // it is reported as manual by language, which is what the log counts.
    assert.deepEqual(
      snippets.map((s) => s.skipped),
      [false, false],
    );
  });

  it("ignores fences that are neither ts nor bash", () => {
    const markdown = [
      fence("json", "{}"),
      fence("", "plain text"),
      fence("sh", "npm ci"),
      fence("ts", "const a = 1;"),
    ].join("\n");

    assert.deepEqual(
      extractSnippets(markdown).map((s) => s.code),
      ["const a = 1;"],
    );
  });

  it("records a no-check reason, and a bare no-check without inventing one", () => {
    const [justified] = extractSnippets(fence("ts no-check: the error a caller sees", "await check();"));
    assert.equal(justified?.skipped, true);
    assert.equal(justified?.justification, "the error a caller sees");

    const [bare] = extractSnippets(fence("ts no-check", "await check();"));
    assert.equal(bare?.skipped, true);
    assert.equal(bare?.justification, undefined);
  });

  it("numbers blocks in document order and keeps the info string out of the body", () => {
    const snippets = extractSnippets(
      [fence("ts", "const a = 1;"), "", fence("bash", "npm ci"), "", fence("ts", "const b = 2;")].join("\n"),
    );

    assert.deepEqual(
      snippets.map((s) => s.index),
      [0, 1, 2],
    );
    assert.deepEqual(
      snippets.map((s) => s.code),
      ["const a = 1;", "npm ci", "const b = 2;"],
    );
  });
});

describe("the committed README", () => {
  const snippets = extractSnippets(readFileSync("README.md", "utf-8"));

  it("has ts blocks for the audit to compile", () => {
    assert.ok(
      snippets.filter((s) => s.lang === "ts").length > 0,
      "the audit must have at least one snippet to typecheck",
    );
  });

  it("has bash blocks, so the manual count is a real number and not always zero", () => {
    assert.ok(
      snippets.filter((s) => s.lang === "bash").length > 0,
      "README examples include shell commands; they must be reported, not ignored",
    );
  });
});
