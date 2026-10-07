# Security Posture

This document is the decision record for the SDK's supply-chain gate. It is the
canonical description of *where* dependency risk is checked and *what happens*
when a check fails, so a contributor does not have to infer the policy from
workflow YAML alone.

## Decision: advisory-based review at PR time, audit for drift

Two mechanisms, with deliberately different jobs:

| Mechanism | When | Enforcement | What it sees |
| --- | --- | --- | --- |
| [`dependency-review-action`](../.github/workflows/dependency-review.yml) | Every pull request | **Blocking** at `high`/`critical`; otherwise reported | Dependencies **newly introduced** by the PR (diffed against the base ref) |
| [`npm audit --omit=dev`](../.github/workflows/ci.yml) (`audit` job) | Weekly schedule (Mondays 06:00 UTC) | Informational, never gating | Production dependency tree as pinned in `package-lock.json`, including advisories published after the pin |

The gate chosen was the advisory-based GitHub action rather than a runtime
`npm audit` on pull requests because:

- **Advisory source is managed upstream.** `dependency-review-action` reads the
  [GitHub Advisory Database](https://github.com/advisories), so coverage and
  update cadence are GitHub's, not a snapshot this repository has to refresh.
- **The diff is the right scope for a PR gate.** A PR should be blocked for the
  risk it introduces, not for an advisory that was already present on `main`.
  Blocking on pre-existing findings makes the gate unactionable for the
  contributor who happens to touch the lockfile.
- **Pre-existing drift still needs an owner.** That is what the scheduled
  `npm audit --omit=dev` job is for: a package whose version is pinned has no PR
  to notice when it is later disclosed as vulnerable.

### Severity policy (block / warn tiers)

| Tier | Severities | Behaviour |
| --- | --- | --- |
| Block | `critical`, `high` | The `dependency-review` job fails; the PR cannot merge without addressing the finding |
| Warn | `moderate`, `low` | Reported in the job summary; the job passes |

`npm audit --omit=dev` is scoped to production dependencies on purpose: it is
the published package's supply chain that ships to operators, not the
contributor toolchain. It uses `continue-on-error`, because a weekly advisory is
drift reporting, not a merge decision — severity policy belongs to the PR-time
gate.

## Related

- [Summary / documentation index](SUMMARY.md)
- [Releasing](releasing.md) — post-publish verification of the artifact itself
- [Enforcement scope](enforcement-scope.md) — the on-chain boundary this tooling
  sits outside of
