# Mutation testing

Line coverage proves a branch ran; mutation testing asks whether the tests would
notice if that branch changed. The required `ci` check keeps the coverage floor
in [`.c8rc.json`](../.c8rc.json). This page describes a separate, non-gating
spike for the three verdict-critical modules: `src/preflight.ts`,
`src/policy.ts` and `src/invoke.ts`.

## Scope and semantics

The harness enumerates three small mutator families:

- **conditional-boundary** — `<` ⇄ `<=`, `>` ⇄ `>=`
- **boolean-literal** — `true` ⇄ `false` outside type positions
- **negation** — removes a leading `!`

A deterministic seeded sample of 60 mutants is run per report. Each mutant is
applied to a temporary copy of `src/`; tracked sources are never edited. An
import hook redirects the three target modules to that copy, and the relevant
offline unit tests run in a child process. A mutant is **killed** when those
tests fail, **survived** when they pass, and **timed out** when it exceeded the
per-mutant budget (a timeout counts as killed for scoring and is reported
separately in `mutation.json`).

The score is therefore a **sampled mutation score**, not a full mutation score:

```text
(killed + timedOut) / (killed + timedOut + survived)
```

The two slow preflight timer tests are skipped to keep the run bounded; see the
`skippedTests` field in the JSON report. Their behaviour is still covered by the
required `ci` check.

## Baseline

The first measured baseline on 2026-11-20 was **63.3%** (seed 489, 60 mutants,
Node 24). It is recording a current fact, not a merge threshold: there is no
break score and the workflow never reddens CI. Re-measure and update
[`scripts/mutation.baseline.json`](../scripts/mutation.baseline.json) when the
targets, mutators, sample seed/size, selected tests or Node major version
change. Never lower the recorded score to hide a regression.

## Run locally

```bash
npm run test:mutation:list
npm run test:mutation
npm run test:mutation -- --limit=20 --seed=489
npm run test:mutation -- --file=policy --family=conditional-boundary
npm run test:mutation -- --timeout=60000
```

Reports are written to `coverage/mutation/`:

- `summary.md` — score, baseline delta and the non-gating reminder
- `survivors.md` — capped, grouped, actionable survivor list with triage hints
- `mutation.json` — full machine-readable sample, including timeout details

## Triage a survivor

1. Read the file and line in `survivors.md` and confirm the named change is not
   an equivalent mutant (for example, a bound that cannot be reached in this
   module's valid input domain).
2. Apply the change locally and reproduce it with the targeted test file(s).
3. Add the narrowest missing assertion, not a broad smoke test: use
   just-below/equal/just-above values for conditional boundaries, assert both
   states for boolean literals, and assert the negated branch explicitly for
   `!` removal.
4. Re-run `npm run test:mutation -- --file=<module> --family=<family>` and
   confirm the mutant is killed, then run the ordinary local gates
   (`npm run typecheck`, `npm run lint`, `npm test`).

The scheduled workflow runs weekly and on `workflow_dispatch`, uploads the
reports as `mutation-survivors`, and mirrors `summary.md` to the GitHub job
summary. It has no pull-request trigger and is not part of the required `ci`
check.
