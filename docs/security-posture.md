# Security Posture

This document records the supply-chain and dependency
security posture of the `@stellar-agent-guard/sdk` package, including the
PR-time dependency gate and its advisory policy.

## PR-time dependency gate

Decision consumption: the security-posture issue inventory recorded the
 gate choice between GitHub Dependency Review and `npm audit
 --audit-level`. This repository implements that choice as GitHub
 Dependency Review (`.github/workflows/dependency-review.yml`), which is
the deferred recommendation from that issue. The issue and this document
 are bididirectionally linked: the issue records the decision, and this
 document records its implementation.

### What it does

On every `pull_request` (opened, synchronized, reopened) the
Dependency Review workflow compares the dependency graph of the base
 branch against the head branch and blocks the PR if it introduces newly
 vulnerable dependencies into the lockfile. This is an advisory-based,
 PR-time gate with zero config drift relative to `npm audit` runtime
 checks.

### Severity policy (block vs warn)

| Severity | Behavior for newly-introduced dependencies |
| --- | --- |
| CRITICAL | Block the PR (fail) |
| HIGH | Block the PR (fail) |
| MODERATE | Warn (comment on the PR, do not fail) |
| LOW | Ignore |

Only newly-introduced vulnerabilities are evaluated by this gate.
 Pre-existing vulnerabilities in the current lockfile are out of scope
 for the PR-gate and are surfaced by the scheduled audit run below.

### Advisory source and update cadence

The gate relies on the GitHub Advisory Database (GHSA). The advisory
 source and its update cadence are managed by GitHub and are not
 controlled by this repository.

## Scheduled audit (transitive drift)

In addition to the PR-time gate, a scheduled `npm audit --omit=dev run
 is informational and surfaces transitive drift between PRs. It does
 not block merges; it exists to make runtime dependency drift visible.
