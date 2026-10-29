/**
 * README quickstart snippet check (issue #127).
 *
 * The snippet-check tooling named in the issue does not exist in this repo yet.
 * The practical equivalent is this test: the README block must equal
 * `examples/quickstart.ts`, which `npm run typecheck` compiles as part of the
 * project. The one allowed difference is the import specifier — the example
 * imports the source tree so CI can typecheck before `dist/` exists, while the
 * README teaches the published package name.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const README = resolve(process.cwd(), "README.md");
const EXAMPLE = resolve(process.cwd(), "examples/quickstart.ts");

/** The fenced TypeScript block under the quickstart heading. */
function quickstartBlock(markdown: string): string {
  const heading = markdown.indexOf("### 60-second quickstart");
  assert.notEqual(heading, -1, "README is missing the 60-second quickstart heading");
  const fence = markdown.indexOf("```ts\n", heading);
  assert.notEqual(fence, -1, "README quickstart section has no ```ts block");
  const start = fence + "```ts\n".length;
  const end = markdown.indexOf("\n```", start);
  assert.notEqual(end, -1, "README quickstart TypeScript block is not closed");
  return markdown.slice(start, end);
}

describe("README quickstart matches the typechecked example (issue #127)", () => {
  it("keeps the published snippet and examples/quickstart.ts in sync", () => {
    const documented = quickstartBlock(readFileSync(README, "utf8"))
      // The example imports the source entry so typecheck works before build.
      .replace('from "stellar-agent-guard-sdk"', 'from "../src/index.ts"')
      .trim();
    const example = readFileSync(EXAMPLE, "utf8").trim();

    assert.equal(documented, example);
  });
});
