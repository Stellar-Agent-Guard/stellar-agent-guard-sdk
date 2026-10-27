# Security Policy

The `@stellar-agent-guard/sdk` package is maintained by the same team as the
[`stellar-agent-guard-contracts`](https://github.com/stellar-agent-guard/stellar-agent-guard-contracts)
repository. This document describes where to report security issues and what is in scope for this SDK.

## Scope

| Area | In scope here? | Where to report |
| --- | --- | --- |
| Vulnerabilities in this SDK (e.g. verdict inversion, fail-open regression, signature verification bypass, input handling in the SDK) | Yes | This repository (GitHub private vulnerability reporting, or email fallback) |
| Contract or protocol issues (policy logic, on-chain enforcement, audit findings) | No | [contracts SECURITY.md](https://github.com/stellar-agent-guard/stellar-agent-guard-contracts/blob/main/SECURITY.md) |
| Issues in a deployed instance (configuration, deployment, operational incidents) | No | Contracts security channel (see contracts SECURITY.md) |
| Tooling and examples in this repo that are marked unaudited | No (see disclaimer below) | General issue tracker |

## Disclosure channels

1. **Primary: GitHub private vulnerability reporting** on this repository.
   Use the **Report a vulnerability** button under the Security tab.
   **Maintainer checklist item:** enable private vulnerability reporting in
   Settings → Security → Private vulnerability reporting. This is an
   outside-repo step and is not assumed complete by merging this file.
2. **Email fallback** following the contracts repo pattern: send a description
   to the security contact listed in the contracts repo's SECURITY.md.
3. **Telegram** (SDK-specific mirror of the contracts channel list): join the
   channel referenced in the contracts SECURITY.md and ping a maintainer. Do not
   post exploit details publicly.

Please include a minimal reproduction, the affected version or commit,
and whether the issue is publicly known.

## Response expectation

We aim to acknowledge reports within 48 hours and provide an initial assessment
following the contracts repo's policy. Timelines for a fix depend on severity and
will be communicated in the private thread.

## Unaudited tooling disclaimer

Tooling and examples in this repository are provided as-is and are **not** covered by the contracts audit. This matches the README disclaimer: the audit
applies to the contracts, not to this SDK or its examples.

## Policy source

This policy mirrors the contracts repo SECURITY.md as of the date of this
file's last modification. If the contracts policy changes, refer to the
contracts repo as the authoritative source.

## CI workflow permissions

Every workflow declares an explicit least-privilege `GITHUB_TOKEN` scope (#106). Write scopes are granted only at job level, to the one job that needs them. All actions are pinned to full commit SHAs with a `# vX.Y.Z` comment; Dependabot (`.github/dependabot.yml`) keeps the pins and the version comments current.

| Workflow | Job | Permissions | Why |
|---|---|---|---|
| `ci.yml` | (workflow default) | `contents: read` | Checks out code and runs typecheck/lint/tests/build; never writes to the repo |
| `ci.yml` | `ci` | `contents: read` | Required merge gate; read-only checkout + evidence-gate diff |
| `ci.yml` | `bench` | `contents: read` | Informational benchmarks; read-only |
| `links.yml` | (workflow default) | `contents: read` | Doc link checks only |
| `links.yml` | `relative` | `contents: read` | Reads docs to check relative links/anchors |
| `links.yml` | `external` | `contents: read` | Report-only external link check; no writes |
| `live-suite.yml` | (workflow default) | `contents: read` | Weekly testnet suite |
| `live-suite.yml` | `live` | `contents: read`, `issues: write` | Opens/comments/closes the single tracked drift issue on failure/recovery (#143); write scoped to this job only |
| `publish.yml` | (workflow default) | `contents: read` | Tag-triggered npm release |
| `publish.yml` | `publish` | `contents: read` | Publishes with `NPM_TOKEN`, not `GITHUB_TOKEN`; creates no GitHub release, tag or commit, so no `contents: write` is needed |

### Action SHA pins

| Action | Pinned to |
|---|---|
| `actions/checkout` (6 uses) | `@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1` |
| `actions/setup-node` (6 uses) | `@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0` |
| `actions/upload-artifact` (1 use) | `@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2` |
