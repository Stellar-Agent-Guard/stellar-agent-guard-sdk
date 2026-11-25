# Security posture: dependencies

This document records the SDK's runtime supply-chain surface, what is actually
used from it, how the dependency range is governed, and where the automated
dependency gate lives. It is the answer to issue #84.

## The single runtime dependency

`package.json` declares exactly one runtime dependency:

```json
"dependencies": {
  "@stellar/stellar-sdk": "^17.0.1"
}
```

Everything else in the manifest is a `devDependency` (TypeScript, ESLint, `tsx`,
`tinybench`, `@types/node`). The transitive production tree — the SDK's entire
supply-chain surface — is `@stellar/stellar-sdk` plus its dependencies. As of
`package-lock.json` in this repo the resolved version is `@stellar/stellar-sdk@17.0.1`,
pulling in 41 transitive packages across 12 direct dependencies of the SDK
(`axios`, `@noble/ed25519`, `@noble/hashes`, `@exodus/bytes`, `@stellar/js-xdr`,
`bignumber.js`, `commander`, `eventsource`, `feaxios`, `smol-toml`,
`uint8array-extras`, `@types/json-schema`).

## What is imported (`src/`)

The table below is the complete set of `@stellar/stellar-sdk` imports in the
shipped source (`src/`). Tests, benchmarks and scripts are not listed: they are
not part of the published artifact.

| Source | Symbols imported |
|---|---|
| `src/policy.ts` | `Address`, `nativeToScVal`, `rpc`, `scValToNative`, `xdr` |
| `src/tx.ts` | `Account`, `Address`, `Keypair`, `SorobanDataBuilder`, `StrKey`, `Transaction`, `TransactionBuilder`, `rpc`, `scValToNative`, `verify` (aliased `verifyEd25519`), `xdr`; plus a lazy dynamic import of `authorizeEntry` |
| `src/telemetry.ts` | `rpc`, `scValToNative`, `xdr` |
| `src/preflight.ts` | `Keypair`, `StrKey`, `rpc`, `xdr` |
| `src/cost.ts` | `SorobanDataBuilder` |
| `src/admin.ts` | `Keypair`, `StrKey`, `rpc`, `xdr` |
| `src/invoke.ts` | `Account`, `Address`, `Keypair`, `Operation`, `rpc`, `scValToNative`, `xdr` |

Unique symbols across the whole surface:

- **Key/crypto**: `Keypair`, `StrKey`, `verify` (Ed25519).
- **Transactions**: `Account`, `Transaction`, `TransactionBuilder`, `Operation`,
  `SorobanDataBuilder`.
- **Contract data / conversion**: `Address`, `nativeToScVal`, `scValToNative`,
  `xdr` (the `ScVal`, `LedgerKey`, `SorobanAuthorizationEntry`,
  `HashIdPreimage`… types), and `authorizeEntry`.
- **RPC**: the `rpc` namespace — used as `rpc.Server` (13 call sites) and
  `rpc.Api` (19 type references).

Notably, large parts of the dependency are **not** used: the Horizon client,
`federation`, `webauth`, `stellartoml`, `friendbot`, `contract` client
generation, and the `axios`-based HTTP client entry points are never imported
from `src/`.

## Tree-shaking reality (ESM vs CJS)

Our package is **pure ESM**: `"type": "module"` and an `exports` map that
publishes only the `import` condition (`./dist/index.js`). There is no CJS build,
so a CommonJS consumer cannot `require()` this SDK — it must `await import()` it.
An ESM consumer or bundler can tree-shake the SDK's own modules, but that does
not extend to the dependency:

- `@stellar/stellar-sdk@17` is a **dual build** — its `exports` map exposes both
  `import` (ESM, `lib/esm/…`) and `require` (CJS, `lib/cjs/…`), and it declares
  `"sideEffects": ["./lib/**/base/scval.js"]`. When a bundler resolves the ESM
  build it can tree-shake in principle; when a CJS consumer resolves the `require`
  condition it gets the CJS build, which is **not tree-shakable at all**.
- Every import above targets the package **root barrel** (`"@stellar/stellar-sdk"`),
  not the narrower subpaths the package exposes (`@stellar/stellar-sdk/rpc`,
  `/xdr`, `/base`, `/contract`). The root barrel re-exports all namespaces
  (`horizon`, `rpc`, `contract`, `xdr`, `webauth`, `federation`, …), so a bundler
  has to walk that whole export graph even though the runtime reachable set is
  small.

Consequence: **unused import weight is real.** The dependency is ~62 MB unpacked
on disk, and a consumer pays for whatever their resolver pulls in — potentially
more than this SDK uses — because the root barrel is the entry point. The
practical mitigations, if weight ever becomes a concern, are to import from the
subpaths (`/rpc`, `/xdr`) and to keep the SDK ESM-only so bundlers can do their
job; neither changes today's correctness.

## Audit result

`npm audit --omit=dev` (production tree only), run against the committed
lockfile, returns verbatim:

```
found 0 vulnerabilities
```

Exit status `0`. The production tree currently has no known advisories. This is
a point-in-time fact, not a guarantee: the gate below re-checks on every pull
request.

## Dependency range: keep the caret (`^17.0.1`)

**Decision: keep the floating `^17.0.1` range; do not pin an exact version.**

Rationale:

- **Consumers control resolution.** This is a library. The consumer's lockfile
  decides the exact version installed, so a caret here does not force an
  unreviewed upgrade on anyone — it only permits a consumer to dedupe to a
  newer 17.x when they choose to.
- **Exact pinning harms consumers.** Pinning `17.0.1` in a library encourages
  duplicate copies of `@stellar/stellar-sdk` in consumers' trees (breaking
  identity-sensitive code such as `instanceof` checks across the XDR types) and
  forces a release of this SDK for every upstream patch, which blocks timely
  security uptake.
- **Semver + reproducibility are handled elsewhere.** `^17` allows only
  backwards-compatible 17.x updates. Reproducibility comes from the committed
  `package-lock.json` — verified by `npm ci` leaving `git status` clean — and
  range risk is surfaced by the dependency gate below.

Do not "panic-pin". If an upstream 17.x release ever regresses, the correct
response is to constrain the range deliberately with a recorded reason, not to
default to an exact pin.

## Where the gate lives

The dependency gate is [`.github/workflows/dependency-review.yml`](../.github/workflows/dependency-review.yml).

- **Tool**: the GitHub `dependency-review-action` (advisory-based), chosen over
  `npm audit --audit-level=high`. `npm audit` reports the whole lockfile, cannot
  cleanly distinguish packages a PR adds, and has no first-class allowlist — the
  usual workaround is `|| true`, which this repo forbids. The action diffs the
  PR's dependency changes against the GitHub Advisory Database instead.
- **Threshold**: fails on `high` and `critical` severity. Moderate and low are
  reported but do not fail.
- **Allowlist**: reviewed advisories are accepted by adding their GHSA id to
  `allow-ghsas`. This is the only sanctioned suppression; there is no `|| true`
  and no `continue-on-error`.
- **Trigger and prerequisite**: `pull_request` only, and it requires the
  repository's GitHub Dependency graph (enabled by default on public repos).
- **Gating**: the check fails the job on its own. To make it a required merge
  check, add `dependency-review` to the branch-protection ruleset — it is kept
  out of `ci.yml` so that the `ci` job stays the single, secret-free required
  check it is documented to be.
