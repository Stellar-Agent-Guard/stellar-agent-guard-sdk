/**
 * Docs TypeScript checker (issue #497): extraction, opt-out markers, and the
 * isolation that makes a failing block attributable.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkedSnippets,
  compileSnippets,
  extractSnippets,
} from "../../scripts/check-doc-snippets.ts";

describe("extractSnippets", () => {
  it("finds fenced ts/typescript blocks with the 1-based line of the first code line", () => {
    const md = [
      "# Doc",
      "",
      "```ts",
      "const a = 1;",
      "```",
      "",
      "```typescript",
      "const b = 2;",
      "```",
    ].join("\n");
    assert.deepEqual(
      extractSnippets("x.md", md).map((snippet) => ({
        lang: snippet.lang,
        line: snippet.line,
        code: snippet.code,
      })),
      [
        { lang: "ts", line: 4, code: "const a = 1;" },
        { lang: "typescript", line: 8, code: "const b = 2;" },
      ],
    );
  });

  it("ignores non-TypeScript fences and records their language", () => {
    const md = ["```bash", "npm test", "```", "```json", "{}", "```"].join("\n");
    const snippets = extractSnippets("x.md", md);
    assert.deepEqual(
      snippets.map((snippet) => snippet.lang),
      ["bash", "json"],
    );
    assert.deepEqual(checkedSnippets(snippets), []);
  });

  it("makes opt-out visible in the fence, the pseudocode language, and a comment", () => {
    const md = [
      "```ts no-check: depends on the page above",
      "const a = external;",
      "```",
      "",
      "```pseudocode",
      "const b = external;",
      "```",
      "",
      "<!-- doc-snippet: skip — signature illustration -->",
      "```ts",
      "constructor(options);",
      "```",
      "",
      "```ts",
      "const c = 1;",
      "```",
    ].join("\n");
    const snippets = extractSnippets("x.md", md);

    assert.deepEqual(
      snippets.map((snippet) => snippet.skipReason),
      ["depends on the page above", "pseudocode fence", "signature illustration", null],
    );
    assert.deepEqual(
      checkedSnippets(snippets).map((snippet) => snippet.line),
      [15],
    );
  });
});

describe("compileSnippets", () => {
  it("compiles against the public surface and reports file, line and diagnostic", () => {
    const root = process.cwd();
    const failures = compileSnippets(
      [
        {
          file: "docs/ok.md",
          line: 10,
          lang: "ts",
          code: [
            'import { PreFlightInterceptor } from "stellar-agent-guard-sdk";',
            "const interceptor: typeof PreFlightInterceptor = PreFlightInterceptor;",
          ].join("\n"),
          skipReason: null,
        },
        {
          file: "docs/drift.md",
          line: 20,
          lang: "ts",
          code: [
            'import { NotAnExport } from "stellar-agent-guard-sdk";',
            "const value = NotAnExport;",
          ].join("\n"),
          skipReason: null,
        },
      ],
      root,
    );

    assert.equal(failures.length, 1, "the valid block does not fail");
    const [failure] = failures;
    assert.equal(failure!.file, "docs/drift.md");
    // Line 20 is the first code line; the diagnostic is on its line.
    assert.equal(failure!.line, 20);
    assert.match(failure!.message, /NotAnExport/);
  });

  it("keeps blocks isolated: a name declared in one block is not visible in another", () => {
    const failures = compileSnippets(
      [
        { file: "docs/a.md", line: 1, lang: "ts", code: "const shared = 1;", skipReason: null },
        { file: "docs/b.md", line: 1, lang: "ts", code: "const copy = shared;", skipReason: null },
      ],
      process.cwd(),
    );
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.file, "docs/b.md");
    assert.match(failures[0]!.message, /Cannot find name 'shared'/);
  });
});
