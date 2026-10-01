# Changelog

All notable changes to `stellar-agent-guard-sdk` are documented in this file.

The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) with
the 0.x interpretation documented in [`docs/releasing.md`](docs/releasing.md): during
0.x the **minor** version is the compatibility boundary, and within any `0.1.x` series
the SDK is additive-only.

User-facing changes need an **Unreleased** row here, added in the same pull request
as the change — see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## [Unreleased]

### Added

None.

### Changed

None.

### Deprecated

None.

### Removed

None.

### Fixed

None.

### Security

None.

## [0.1.0] - 2026-09-16

> **Pre-0.1.1 history is reconstructed.** This file did not exist when `0.1.0`
> shipped, so the entry below is the *publish record* — assembled from
> [`docs/publishing-history.md`](docs/publishing-history.md) and
> `npm view stellar-agent-guard-sdk` — not a per-change log. Per-change history
> starts with entries added under [Unreleased].

### Added

- Initial publication of `stellar-agent-guard-sdk` to the npm registry: pre-flight
  policy interception and guardrails for AI agents on Stellar Soroban smart accounts
  (registry package description).

### Changed

None.

### Deprecated

None.

### Removed

None.

### Fixed

None.

### Security

None.

> **Two facts about `0.1.0`, recorded rather than smoothed over:**
>
> 1. It was published **manually by the maintainer, outside the tag-triggered
>    `publish.yml` workflow** — no release tag or `publish` workflow run exists for
>    `0.1.0`. Known one-time deviation; see
>    [`docs/publishing-history.md`](docs/publishing-history.md).
> 2. `package.json` declares `0.1.1`, but when this entry was written the registry
>    reported `0.1.0` as the only published version (`latest` dist-tag), verified with
>    `npm view stellar-agent-guard-sdk versions time`. This changelog records what is
>    **actually on the registry**: `0.1.0`, on the date above. No `0.1.1` entry is
>    written until `0.1.1` is published.

[unreleased]: https://github.com/stellar-agent-guard/stellar-agent-guard-sdk/commits/main
[0.1.0]: https://www.npmjs.com/package/stellar-agent-guard-sdk/v/0.1.0
