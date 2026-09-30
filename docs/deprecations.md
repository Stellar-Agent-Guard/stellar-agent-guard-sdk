# 0.x API Deprecation Policy

This document defines the API stability guarantees, deprecation lifecycle, and breaking-change policies for `stellar-agent-guard-sdk` during its `0.x` release series.

---

## Maintainer Decision: `additive-only-within-minor`

> **Maintainer decision comment (Issue #165):**
>
> "During `0.x`, this project adopts the stricter `additive-only-within-minor` policy: existing public exports, function signatures, types, and behavioral contracts keep working without breaking changes across patch releases within a minor series (e.g. `0.1.x`). Breaking changes, deprecation removals, and incompatible signature updates are permitted only at minor version boundaries (`0.2.0`, `0.3.0`, etc.). Patch releases (`0.x.Z`) are reserved for bug fixes and non-breaking additions only. Until `1.0.0`, the minor version is the compatibility boundary. Security overrides (urgent verdict-correctness or safety fixes) take precedence and may introduce breaking changes out of cycle if strictly necessary, accompanied by immediate, prominent disclosure in release notes and history records."

---

## What the Contract Promises (and What It Doesn't)

### What IS Guaranteed

1. **Additive-only within minor releases (`0.1.x`)**: All public exports exposed in the package entry point (`src/index.ts` / root export map) remain functional and backward-compatible across patch versions. If your code compiles and passes against `0.1.0`, it will continue to compile and run against `0.1.1`, `0.1.2`, and subsequent `0.1.x` releases.
2. **Stable types and option shapes**: TypeScript interfaces and options objects (`PreFlightInterceptorOptions`, `InvokeOptions`, `CostPreCheckerOptions`, etc.) will only gain optional properties or widened return types within a minor series. Existing required fields are never added, removed, or made incompatible.
3. **No mid-minor removals**: An API marked as deprecated will **never** be removed in a patch release (`0.x.Z`). It remains available and callable for at least the remainder of that minor release cycle.
4. **Alignment with design principles**: This contract formalizes the "additive-only 0.x surface discipline" principle defined in the SDK design principles (see [`docs/design-principles.md#additive-only`](design-principles.md#additive-only) <!-- pending #162: docs/design-principles.md#additive-only -->).

### What is NOT Guaranteed

1. **Minor boundaries (`0.2.0`, `0.3.0`) may break**: In accordance with npm 0.x conventions, a minor version increment (`0.1.x` &rarr; `0.2.0`) is the designated boundary for breaking changes, refactoring, and removals of previously deprecated exports. Consumers pinning ranges like `"^0.1.0"` are isolated from `0.2.0` by npm's default semver resolver; consumers intending to stick to compatible updates should pin `"~0.1.0"`. Full semantic versioning stability (where breaking changes require major bumps) takes effect starting at `1.0.0`.
2. **Internal implementation modules are non-public**: Only symbols explicitly exported from the root package entry point (`src/index.ts`) are covered by this contract. Files in `scripts/`, internal helper functions, test fixtures, or subpath modules not published in `package.json`'s `exports` map are internal and may change or move at any time.

---

## Deprecation Mechanics

Retiring an API in `stellar-agent-guard-sdk` follows a three-phase procedure designed to maximize visibility during development while preventing operational disruptions in production agent pipelines:

```
[Phase 1: Announcement]
  JSDoc @deprecated tag added in patch/minor
  ├── TypeScript compiler (tsc) diagnostics
  └── IDE strikethrough & hover warnings
         │
         ▼
[Phase 2: Warning Period]
  Remains functional for ≥ 1 minor version
  ├── Zero runtime noise by default (no console nag)
  └── Emits via optional logger.warn if configured (#121/#195)
         │
         ▼
[Phase 3: Removal]
  Removed only at next minor boundary (e.g. 0.2.0)
  ├── Documented in release notes (#154)
  └── Recorded in deprecation tracking table
```

### 1. Announcement via JSDoc `@deprecated`

The deprecated symbol (function, class, type, or property) is tagged with `@deprecated` in its JSDoc header comment. The comment must include:
- A clear explanation of why the API is deprecated.
- The recommended replacement symbol or migration path.
- The planned version boundary for removal (e.g., `@deprecated Use createGuardValidator() instead. Scheduled for removal in 0.2.0.`).

**Why this is the primary channel:** `@deprecated` is native to TypeScript. `tsc` and editor language servers (VS Code, Cursor, WebStorm) immediately surface deprecated symbols with strikethrough styling and hover tooltips at authoring and build time. Integrators see the deprecation during active development without incurring runtime side effects.

### 2. Runtime Warning Channel: Zero-Surprise Default

The SDK adheres to a strict **zero-surprise default** for runtime warnings:

- **No default runtime nag**: The SDK does **not** write deprecation warnings to `console.warn` or `console.error` by default.
- **Rationale**: Stellar Agent Guard runs inside automated AI agent execution loops, LangChain chains, and headless daemon processes. Unilateral library logging to standard output or error pollutes agent tool-call streams, corrupts structured JSON logging pipelines, and causes spurious test failures in consuming harnesses (see issue [#121](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-sdk/issues/121) / [#195](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-sdk/issues/195) on optional logger injection and library-side console suppression).
- **Opt-in logger warning**: When a consumer injects an optional logger (`logger?: { warn: (msg: string, ...args: unknown[]) => void }`), the SDK routes deprecation warnings through the `logger.warn` channel so observability platforms can track deprecated calls in staging environments.

### 3. Removal Boundary

- Deprecated exports remain functional for a minimum of **one minor release cycle** (for example, an API deprecated in `0.1.2` will remain available through all subsequent `0.1.x` releases).
- Removal occurs **exclusively at a minor version boundary** (`0.2.0`, `0.3.0`, etc.) per the `additive-only-within-minor` policy.
- Deprecation removals are highlighted in the release notes under a prominent **Breaking changes** section (see [`docs/releasing.md`](releasing.md)).

---

## Urgent Security & Verdict-Correctness Override (The Escape Hatch)

In security and fund-safety middleware, correctness of authorization verdicts strictly supersedes interface stability:

> **Security & Correctness Override Principle:**
> If a defect allows an unauthorized transaction to pass, creates an unsound policy decision, or compromises the fail-closed invariant, a correcting fix that is technically breaking may be released immediately in a patch release (`0.x.Z`).

When this override is invoked, it is handled with complete transparency:
1. **Never silent**: Breaking security fixes are never disguised as ordinary bug fixes.
2. **Release notes callout**: The release notes must carry an explicit `[SECURITY OVERRIDE]` banner at the very top (referencing the release notes template in issue [#154](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-sdk/issues/154)).
3. **Changelog & history entry**: The change is recorded in the project's historical record (see issue [#6](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-sdk/issues/6) and [`docs/publishing-history.md`](publishing-history.md)), detailing:
   - The nature of the vulnerability or verdict-correctness failure.
   - The prior (flawed) behavior vs. the new (safe) behavior.
   - Exact migration instructions for affected callers.
4. **Security disclosure**: Where appropriate, the fix is cross-referenced with a GitHub Security Advisory pursuant to the project's security policy (see issue [#123](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-sdk/issues/123)).

---

## Deprecation Tracking Table

This table records all public API deprecations, their announced version, replacement, and eventual removal release.

| Removed in | Export | Replaced by | Announced |
| :--- | :--- | :--- | :--- |
| *(none yet)* | — | — | — |

*Note: No exports have been deprecated or removed in `stellar-agent-guard-sdk` to date. Deprecations will be appended here as they occur.*
