# Security Policy

The `@stellar-agent-guard/sdk` package is maintained by the same team as the
[`stellar-agent-guard-contracts`](https://github.com/stellar-agent-guard/stellar-agent-guard-contracts)
repository. This document describes the vulnerability reporting scope, trust boundaries,
disclosure channels, and security handling for this SDK.

## Trust Boundaries & Architectural Delineation

Enforcement in Stellar Agent Guard operates across two distinct architectural layers:

1. **SDK Layer (`stellar-agent-guard-sdk`) — Pre-Flight Advisory Interception**:
   - The SDK provides client-side pre-flight simulation, zero-broadcast fee estimation,
     framework adapter interception (LangChain, ElizaOS, MCP, Vercel AI SDK), and dual-stream
     diagnostic telemetry parsing.
   - Pre-flight verdicts (`admissible`, `blocked`, `undetermined`) are **advisory predictions**
     of on-chain behavior evaluated via RPC simulation before any transaction is broadcast.
     They protect agents against accidental policy violations, runaway loops, and wasted
     network fees.
   - For an architectural map of data boundaries and entry points, see the
     [`attack-surface inventory`](docs/attack-surface.md). For asset-level threats and residual
     risks, see the [`threat model`](docs/threat-model.md).

2. **Contracts Layer (`stellar-agent-guard-contracts`) — On-Chain Backstop**:
   - The Soroban smart contract is the **authoritative on-chain backstop**.
   - Custom account abstraction ensures that every authorized transaction must satisfy
     `__check_auth` inside the contract upon broadcast. Even if pre-flight simulation is
     bypassed, disabled, or manipulated, funds cannot move without on-chain policy approval.

---

## Vulnerability Reporting Scope

| Area / Component | In Scope Here? | Authoritative Target / Reporting Channel |
| --- | --- | --- |
| **SDK Vulnerabilities** (verdict inversion, cache staleness, adapter bypass, telemetry loss, digest verification) | **Yes** | This repository (GitHub Private Vulnerability Reporting or email fallback) |
| **Malicious RPC Detection & Handling** (SDK diagnostics decoding, simulation validation, advisory warnings) | **Yes (Docs/Detection)** | This repository (SDK handling); on-chain backstop belongs to contracts |
| **Contract & Protocol Issues** (on-chain policy logic, `__check_auth` enforcement, Soroban contract bugs) | **No** | [contracts SECURITY.md](https://github.com/stellar-agent-guard/stellar-agent-guard-contracts/blob/main/SECURITY.md) |
| **Compromised Host Runtime** (agent host completely bypassing SDK middleware) | **No** | Contract layer backstop (`__check_auth` blocks on-chain) |
| **Deployed Network / Node Infrastructure** (operational outages, RPC node availability) | **No** | Network operators / infrastructure providers |
| **Unaudited Tooling & Examples** (`examples/*`, standalone test scripts) | **No (Disclaimer)** | General issue tracker |

---

## SDK Vulnerability Classes (In-Scope)

The following vulnerability classes are explicitly in scope for this repository:

### 1. Verdict Inversion & Fail-Open Regressions
- Flaws in `PreFlightInterceptor.check()` or `invoke()` where an invalid, failed, or blocked simulation yields an `admissible` verdict instead of `blocked` or `undetermined`.
- Regressions where simulation parsing, fee estimation, or error handling fails open rather than failing closed.

### 2. Cache Staleness & Cache Key Poisoning
- Flaws in the pre-flight simulation cache where cached `admissible` verdicts outlive ledger sequence advances, TTL boundaries, or policy revisions.
- Cache collisions or improper cache key hashing allowing one transaction to inherit authorization from another.

### 3. Framework Adapter Bypasses
- Logic defects in framework middleware (`createLangChainGuardMiddleware`, `createGuardValidator`, `guardMcpToolHandler`, `guardMcpCallTool`, `createVercelAIGuard`) where an un-admitted tool action executes despite a `blocked` or `undetermined` verdict.
- Improper error handling where thrown refusal errors (`GuardBlockedError`, `GuardUndeterminedError`) are caught or swallowed in a manner that allows host execution to resume.

### 4. Telemetry Loss & Diagnostic Suppression
- Failures in `GuardTelemetryListener` or simulation diagnostic event parsing that fail to extract, decode, or surface `event_auth_checked` reason codes.
- Flaws where advisory observer callbacks (`onDecision`, `onBlocked`) alter guard verdict control flow or mask security-relevant audit logs.

### 5. Signature Verification & Auth Digest Handling
- Flaws in `verifyAgentSignature()` or auth digest derivation in `src/tx.ts` that fail to properly validate Ed25519 signatures or reject forged `SorobanAuthorizationEntry` payloads locally.

### 6. Malicious RPC Simulation Handling
- When a malicious or compromised RPC server fabricates an `admissible` simulation response, the SDK's local validations, diagnostic event checks, and documentation warnings are in scope for improvement. Actual fund protection remains backstopped by the contracts repository.

---

## Disclosure Channels

1. **Primary: GitHub Private Vulnerability Reporting** on this repository.
   - Use the **Report a vulnerability** button under the repository's **Security** tab.
   - Maintainer checklist item: Enable private vulnerability reporting in repository settings.
2. **Email Fallback**:
   - Send details following the contracts repo pattern to the security contact listed in the
     contracts repo's [`SECURITY.md`](https://github.com/stellar-agent-guard/stellar-agent-guard-contracts/blob/main/SECURITY.md).
3. **Telegram (SDK Mirror)**:
   - Join the security channel referenced in the contracts repo's `SECURITY.md` and ping a maintainer.
   - **Do not post vulnerability or exploit details publicly.**

Please include in your report:
- A clear description of the vulnerability and its potential impact.
- Step-by-step reproduction instructions or a minimal test case.
- Affected versions, commit SHAs, or environments.
- Any known remediation or patch suggestions.

---

## Response Expectation & Security Advisories

- **Acknowledgment**: We aim to acknowledge reports within 48 hours of receipt.
- **Assessment**: An initial technical assessment will be provided within 5 business days.
- **Coordination**: We will coordinate with the reporter privately to establish remediation timelines.
- **Advisories Process**: Upon releasing a fix, we publish a GitHub Security Advisory (GHSA), credit the reporter (unless anonymity is requested), request a CVE identifier when appropriate, and document the change in public release notes.

---

## Safe Harbour Statement

We consider good-faith security research conducted in accordance with this policy to be authorized. We commit to:
- Not pursuing legal action against researchers for accidental or good-faith security disclosures.
- Not requesting law enforcement investigation for research that complies with these guidelines.
- Working cooperatively with researchers to understand and resolve issues promptly.

To qualify for safe harbour:
- Test only against mock environments, local harnesses, or dedicated testnet fixtures — never against live third-party accounts or mainnet deployments.
- Avoid privacy violations, destruction of data, or disruption of shared test services.
- Give maintainers reasonable time to remediate before public disclosure.

---

## Unaudited Tooling Disclaimer

Tooling and examples in this repository (`examples/`, test scripts, bench harnesses) are provided as-is and are **not** covered by the contracts audit. The independent security audit applies to the contracts repository (`stellar-agent-guard-contracts`), not to this client SDK or its documentation examples.

---

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

---

## Policy Source

This policy aligns with the authoritative security policies of the Stellar Agent Guard project. For on-chain contract security rules, refer to the [contracts SECURITY.md](https://github.com/stellar-agent-guard/stellar-agent-guard-contracts/blob/main/SECURITY.md).