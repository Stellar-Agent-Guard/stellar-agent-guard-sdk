# docs: JSDoc for every exported symbol + CI completeness check

Closes #128

## What changed

- **JSDoc on all 184 exports** reachable from `src/index.ts` (baseline was 137/184). Every export now has a non-empty prose summary; types document their fields where that adds signal beyond the field's type.
- **`@example` on the five entry points** required by the issue — `PreFlightInterceptor`, `CostPreChecker`, `invoke`, `createLangChainGuardMiddleware`, `createGuardValidator` — plus **7 `@example` blocks total** (the two required `clock.ts` examples were rewritten: they referenced a non-existent `createGuardInterceptor` and didn't run).
- **`scripts/check-jsdoc.ts`** — a zero-new-dependency completeness check over the export graph (see mechanism below), wired as `npm run test:jsdoc` in `package.json` and as a gating `jsdoc completeness check` CI step after `lint` in `.github/workflows/ci.yml`.
- One file per commit per CONTRIBUTING (16 commits, no squashing).

## Mechanism (stated honestly)

The check is a small TypeScript-AST script (`ts.getJSDocCommentsAndTags` via the already-installed `typescript` package) — **not** `eslint-plugin-jsdoc`, because:

- `eslint-plugin-jsdoc` lints style file-by-file; this AC is about **barrel-export completeness**: resolve every symbol exported from `src/index.ts` through its re-exports back to its declaration site and assert a JSDoc comment with non-empty prose exists there. That's a graph walk, not a per-file lint rule.
- Zero new dependencies (hard constraint in the issue): no new lint plugin, no new runtime dep — only the `typescript` package the repo already builds with.

The script enforces: (1) JSDoc with non-empty prose on **all 184** exports (an `@deprecated`-only block doesn't count — that rule caught `GuardReasonName` during development); (2) an `@example` containing a ` ```ts ` fence on exactly the five required entry points; exits 1 with a named list on failure.

## Evidence

### Count: 184/184

```
jsdoc check OK: 184/184 exports documented, 5/5 entry-point examples present
```

After merging `main` (which added `src/policy-schema.ts`), the same check reports **194/194** — the two new exports (`SchemaKeyword`, `SchemaValidationOptions`) were documented in a follow-up commit rather than left to fail the new gate:

```
jsdoc check OK: 194/194 exports documented, 5/5 entry-point examples present
```

This PR also appends an addendum to `tests/fixtures/integration-evidence.md`, because it touches enforcement-path files and CI's `enforcement-path evidence gate` requires that file in the diff. The addendum states plainly that no fresh live run was made (`.env.phase2` is absent from this checkout) and proves the enforcement-path diff is comment-only: zero non-comment changed lines in `src/`, and emitted `.js`/`.d.ts` byte-identical to `main` under `tsc --removeComments`.

### Dry-run failures (script exits 1)

Missing doc (temporarily stripped `explainReason`'s block, then restored):

```
jsdoc check FAILED: 1 of 184 exports lack a JSDoc comment:
  - explainReason (src/reasons.ts)
exit code: 1
```

Missing `@example` (temporarily stripped `createGuardValidator`'s block, then restored):

```
jsdoc check FAILED: entry points missing @example: createGuardValidator — these are the APIs an integrator reaches for first
exit code: 1
```

### Example executions

Each example was extracted **verbatim** from the committed JSDoc (import rewritten `stellar-agent-guard-sdk` → `../src/index.ts`, repo's own pattern) and run with `node --import tsx`:

| Example | Source | Result |
|---|---|---|
| `PreFlightInterceptor` | `src/preflight.ts` | `rejected fn by rule symbol_shape` (exit 0) |
| `CostPreChecker` | `src/cost.ts` | `within budget: 1334 stroops (1234 resource + 100 inclusion), ceiling 10000` / `0.0001334 XLM` (exit 0) |
| `invoke` | `src/invoke.ts` | typecheck-only, see note below |
| `createLangChainGuardMiddleware` | `src/adapters/langchain.ts` | `{ content: '42' }` (exit 0) |
| `createGuardValidator` | `src/adapters/elizaos.ts` | `true` (exit 0, guard-less action → no network) |
| clock module example | `src/clock.ts` | `5000` (exit 0) |
| `FakeClock` example | `src/clock.ts` | `false` / `6000` (exit 0) |

**`invoke` example — typecheck-only, deliberately.** Executing it would need a funded testnet account + `.env.phase2` (which does not exist in this repo). Instead the snippet was typechecked with repo-strict flags (`tsc --noEmit --strict --exactOptionalPropertyTypes --noUncheckedIndexedAccess --noImplicitOverride --target es2023 --module nodenext --allowImportingTsExtensions --types node`) → exit 0, and `invoke` behavior itself is covered by the test suite below.

### Comment-only diff

- `git diff main...HEAD -- src | grep -E '^[+-]' | grep -v '^(\+\+\+|---)' | grep -vE '^[+-]\s*(\*|/\*|\*/)'` → **zero lines** (every added/removed line in `src/` is a comment line; 613 insertions / 30 deletions).
- Emitted output equivalence: `tsc -p tsconfig.build.json --removeComments` run on `main` and on this branch, `diff -r -x '*.map'` → **identical** (all `.js` and `.d.ts` byte-for-byte). Source maps excluded because they encode source line numbers, which inserting comments legitimately shifts.

### Gates

| Gate | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `npm test` | 436 pass / 0 fail / 1 skipped (includes `tests/unit/invoke.test.ts`, `tests/unit/invoke-dry-run.test.ts`) |
| `npm run build` | pass |
| `npm run test:exports` | `export-map check OK` (104 exports resolve, undeclared paths refused) |
| `npm run test:jsdoc` | `jsdoc check OK: 184/184 exports documented, 5/5 entry-point examples present` |

## Scope notes

- `clock.ts`'s two stale examples were fixed as part of this issue (they cited an API that doesn't exist); no other example was modified.
- Fixes discovered en route and included: `GuardReasonName` had an `@deprecated`-only comment (no prose), and `buildGuardAuthEntry`'s doc block had drifted away from its function in `src/tx.ts`.
