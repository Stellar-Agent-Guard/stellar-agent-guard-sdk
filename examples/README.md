?> Examples policy — runnable, typechecked, never stale

> **Policy doc-comment header.** This folder is governed by four standing rules.
Every file in `examples/` is executed by the required `ci` check, carries an
expected-output header, is linked from the docs rather than duplicated, and
cannot be added without the CI hookup. The rules exist so examples cannot rot
silently when the adapters they demonstrate change.

## Why this folder has a policy

README *snippet* checking covers fenced code blocks in docs. This folder
is different: it holds **runnable TypeScript files** that import the adapters
shipped by this package. Without a standing rule, they rot silently — the
adapter api changes, the example stops compiling, and nothing in CI notices.
The four rules below make that impossible.

## The four rules

1. **Every file in `examples/` is imported-by or compiled-in CI.** The required
` ci` check runs `npm test`, which executes `tests/unit/examples.test.ts`. That
test imports every example and asserts on its returned transcript — an example
that no longer compiles or that changes its output fails the build. This is the
same mechanism the README-snippet checker uses (execute the code, assert on
the result), applied to real files instead of fenced blocks.

2. **Each example has an expected-output comment header.** The top of every
example file states the block/run transcript it is expected to produce, so a
reader can confirm the behaviour without running it and the test has a written
expectation to compare against. This matches the standard the example issues
use.

3. **README **links** into this folder rather than duplicating the code.** The
consolidation rule: the canonical example lives here and is executed by CI; a
doc that needs to show it links to the file. Duplicating the body into a
fenced block creates a second copy that can drift from the one CI actually
checks.

4. **Adding an example requires the CI hookup.** A new file lands together
with its entry in `tests/unit/examples.test.ts` (or an equivalent CI check).
This is the rule that keeps rule 1 true — the CONTRIBUTING bullet repeats it at
the point of contribution.

## Honest inventory

Every example file present at merge time, and the exact check that covers it.
There are no orphans and no silent skips.

| File | Covered by | Notes |
| --- | --- | --- |
| [`examples/langchain.ts`](langchain.ts) | `tests/unit/examples.test.ts` — "executes LangChain middleware example with allowed and blocked runs" | Executed by `npm test` in the required `ci` check. |
| [`examples/elizaos.ts`](elizaos.ts) | `tests/unit/examples.test.ts` — "executes ElizaOS validator example with allowed and blocked runs" | Executed by `npm test` in the required `ci` check. |
| [`examples/mcp.ts`](mcp.ts) | `tests/unit/examples.test.ts` — "executes the MCP adapter example at both boundaries" | Executed by `npm test` in the required `ci` check. |

Every file in this folder is covered. No exclusions are currently needed. If a
future file cannot be checked, add a row here marked **excluded-with-reason**
with the justification inline — never a silent skip.

## Adding an example

1. Add the file with an expected-output comment header (rule 2).
2. Export a `runExample()` function that returns the transcript the header
describes.
3. Add an it() block in `tests/unit/examples.test.ts` that imports and
runs it, asserting on the transcript (rule 1 and rule 4).
4. Add a row to the inventory above.
5. Link it from the relevant docs page rather than pasting its body (rule 3).
