<!--
Pull request template — issue #81.

One commit per file: see CONTRIBUTING.md "One commit per logical unit, per file".
Every checkbox below is either checked with evidence or left unchecked with the
reason stated in the Summary — no silent skips.
-->

## Summary

<!-- One or two lines: what changed and why. Close the issue with "Closes #<n>". -->

Closes #

## Checklist

- [ ] **Changelog** — this PR is user-facing: an **Unreleased** row was added to
      [`CHANGELOG.md`](https://github.com/stellar-agent-guard/stellar-agent-guard-sdk/blob/main/CHANGELOG.md)
      (rule: [`CONTRIBUTING.md`](https://github.com/stellar-agent-guard/stellar-agent-guard-sdk/blob/main/CONTRIBUTING.md);
      decision: [#6](https://github.com/stellar-agent-guard/stellar-agent-guard-sdk/issues/6)) —
      **or** this change is not user-facing (CI, tests, or internal docs only).
- [ ] **Evidence is fresh** — this PR touches the enforcement path (`src/tx.ts`,
      `src/invoke.ts`, `src/policy.ts`, `src/preflight.ts`): `npm run test:integration`
      was re-run and
      [`tests/fixtures/integration-evidence.md`](https://github.com/stellar-agent-guard/stellar-agent-guard-sdk/blob/main/tests/fixtures/integration-evidence.md)
      updated **in this PR** (CI's `enforcement-path evidence gate` fails otherwise).
      Tracked in [#81](https://github.com/stellar-agent-guard/stellar-agent-guard-sdk/issues/81).
      **Or** this PR does not touch the enforcement path.
- [ ] **Local gates green on this commit** — `npm run typecheck`, `npm run lint`,
      `npm test` (see
      [`CONTRIBUTING.md`](https://github.com/stellar-agent-guard/stellar-agent-guard-sdk/blob/main/CONTRIBUTING.md)
      § "Local gates before pushing").
