# Examples Policy

> **Policy doc-comment header.** This folder is governed by four standing rules. They exist so examples cannot rot silently: every file here is executed by CI, every file declares its expected output, the README links here instead of duplicating code, and adding a file without the CI hookup is not allowed.

## The four rules

1. *+Every file in `examples/` is imported-by or compiled-in CI.**
   The mechanism is the same one used for README-snippet checking: a check that fails when a file is not covered. Here the covering check is `tests/unit/examples.test.ts`, which imports each example module and executes its `run*Example()` export. @tscheck and the unit test run in the required `ci` job, so an example that does not compile or does not run fails the PR.

2. **Each example has an expected-output comment header.**
   The header records the block/run transcript expectation -- the same standard the example issues use -- so a reader can see what the example is supposed to print without running it, and a reviewer can spot a silent behaviour change.

3. **README examples link into this folder rather than duplicating.**
   When a docs page needs a runnable example, it links to the file here. The code lives in one place, so there is one copy to keep compiling and one copy to review.

4. **Adding an example requires the CI hookup.**
   The rule that keeps rule 1 true: a new file in this folder must be added to the examples test in the same PR. The CONTRIBUTING bullet states this explicitly.

## Inventory at merge time

Every file present in this folder at merge time is listed below with the exact check that covers it. No orphans. If a file cannot be checked, the reason is stated inline and the row is marked excluded-with-reason -- an honest inventory, not a silent skip.

| File | Covering check | Status |
| --- | --- | --- |
| `examples/langchain.ts` | `tests/unit/examples.test.ts` imports `runLangChainExample` and asserts the allowed/blocked transcript; `tscheck` compiles it via the unit project in `tests/test.config.ts` | checked |
| `examples/elizaos.ts` | `tests/unit/examples.test.ts` imports `runElizaOSExample` and asserts the allowed/blocked verdicts; `tscheck` compiles it via the unit project in `tests/test.config.ts` | checked |

The check runs in the required `ci` job (`npm run typecheck`, `npm run lint`, `npm test`), so a file that compiles but does not run, or runs but does not match its expected-output header, fails the PR.

## Expected-output header format

Each example file opens with a block comment of the form:

```ts
/**
 * Expected output (block/run transcript):
 *
 *   run 1 (allowed):     <what the example prints / returns>
 *   run 2 (blocked):     <what the example prints / returns>
 */
```

The test asserts the transcript above, so the header and the test are two views of the same expectation.
