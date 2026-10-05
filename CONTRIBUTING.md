# Contributing

## Commit convention

Commits use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <imperative summary>
```

Types in use in this repo: `feat`, `fix`, `docs`, `chore`, `ci`, `test`. The existing
history is the reference — match its shape rather than inventing a new one.

## Changelog

User-facing changes need an **Unreleased** row in [`CHANGELOG.md`](CHANGELOG.md),
added in the same PR as the change; changes no user can observe (CI, tests, internal
docs) need none.

## One commit per logical unit, **per file** — the hard rule

Every commit **and every push** must touch **exactly one file**. Not "on average" —
exactly one, every time.

- Never bundle a source change with its test, and never bundle a doc update with the
  code it describes, even when they are logically one unit of work.
- If a logical change genuinely requires edits to several files, that is several
  sequential commits — **one file each** — pushed in order. Do not squash them
  together afterwards.
- This is stricter than the earlier "one commit per logical unit" rule. It is now
  one commit per logical unit **per file**.
- It applies to every repository in this org: `stellar-agent-guard-sdk`,
  `stellar-agent-guard-contracts`, and `stellar-agent-guard-dashboard`.

Why: each commit stays independently reviewable and revertable, and a code change can
never hide inside a `docs:` commit or vice versa.

Check before you commit — either of these must print exactly one path:

```bash
git diff --cached --name-only
git show --stat HEAD
```

## Branch protection and CI

`main` is protected by the `main-protection` ruleset:

- the required status check is named exactly **`ci`**;
- **one approving review** is required, stale reviews are dismissed on push, and
  GitHub does not permit self-approval;
- allowed merge methods are `merge`, `squash` and `rebase`.

**Solo-maintainer bypass policy.** As a solo-maintained repository, PRs require a green `ci` check but no second-party review; the maintainer's named-actor bypass on `main-protection` is used deliberately for merges, and that is documented here as standard procedure — not an emergency exception. Ordinary PRs still go through the full `ci` required-check gate; the bypass only removes the structurally-unsatisfiable second-reviewer requirement. If a second maintainer joins in future, they should be added as a required reviewer and this section revisited.

Do not modify the ruleset to work around a required check that is legitimately blocked.

CI reports **one required check**, plus a scheduled workflow that is deliberately not
part of it:

- **`ci`** — required, and the only check that gates a merge. Runs typecheck, lint, the
  unit tests, and the **enforcement-path evidence gate**. It touches no secret, so
  nothing in it can silently mask a skip: every step either really runs or the job
  fails.
- **`live-suite`** (`.github/workflows/live-suite.yml`) — **never run on a pull
  request**. Runs the live testnet suite weekly (`schedule`) and on demand
  (`workflow_dispatch`) to catch host/testnet drift. `PHASE2_ENV_FILE` is referenced
  only in that workflow, and it has no `pull_request` / `pull_request_target` trigger,
  so a pull request — including a forked one — can never reach the secret.

### The live testnet suite is not run on every PR

It is:

1. **required locally before any PR that touches the enforcement path** — `src/tx.ts`,
   `src/invoke.ts`, `src/policy.ts`, `src/preflight.ts`. Run `npm run test:integration`,
   then commit the fresh output to `tests/fixtures/integration-evidence.md` **in the same
   PR**. The required `ci` job checks that the evidence file was touched; it cannot
   verify the numbers (that needs the network), only that fresh evidence was supplied.
   A PR that changes the path without it **fails `ci`**.
2. **run automatically on a schedule**, so a protocol or RPC change is caught even when
   nobody is editing the code.

A green `ci` therefore means "the required checks ran", not "the live suite ran on this
change". The committed evidence file is the record for the change itself.

## Branch lifecycle

- All work happens on a feature branch and lands through a pull request. **Never push to
  `main` directly** — not before this rule, and not after it.
- After a PR merges, and **only** then:
  1. confirm the merge actually landed — `git log main` shows the merge/squash/rebase
     commit and the PR reports a populated `mergedAt`;
  2. delete the remote branch (`git push origin --delete <branch>`, or the "Delete branch"
     button GitHub shows on a merged PR);
  3. delete the local branch with `-d`, **not** `-D`. If `-d` refuses, that is a signal the
     merge did not land the way you think — stop and check rather than forcing it.
- Sweep for stray branches (`git branch -a`, `gh api repos/{owner}/{repo}/branches`) and
  delete the ones already merged into `main`. **Never delete an unmerged branch** to hit a
  `main`-only target — that silently discards unmerged work.
- Verify with `git branch -a`: it should show `main` and nothing else.
- The same rule applies to `stellar-agent-guard-contracts` and
  `stellar-agent-guard-dashboard`.

## Issues and labels

The tracked backlog uses one label taxonomy, applied identically in every repo in this org.
It is defined and applied by `scripts/create-issue-backlog.sh`, which is idempotent — safe to
re-run, and reports a repo it cannot write to rather than aborting the run:

| Label | Meaning |
| --- | --- |
| `tier:blocker` | blocks a phase exit; not fixable by an agent alone |
| `tier:maintainer-decision` | a human call is required; do not guess |
| `tier:enhancement` | non-blocking; revisit when its trigger is met |
| `scope:sdk` / `scope:contracts` / `scope:dashboard` | which repo's code/config the issue concerns, so the backlog can be filtered across repos in one query |

An issue carries at least one `tier:` label and exactly one `scope:` label.

Wave complexity (**Trivial / Medium / High**) is deliberately **not** a label here: the Drips
Wave docs assign it when an issue is added to a Wave Program in the dashboard, and the Wave
bot applies its own program label. Keeping the tier taxonomy orthogonal to it means neither
scheme has to be renamed later.

Anything still open when a phase closes gets an issue, not just a note in a pull request or a
chat log.

## Releasing

Version bumps, tags, npm publish, and the 0.x breaking-change policy are
documented in [`docs/releasing.md`](docs/releasing.md) — publishing itself is
maintainer-only (npm 2FA/automation token, outside this repo).

## Local gates before pushing

```bash
npm run typecheck
npm run lint
npm test
npm run build && npm run test:exports   # packs the tarball and resolves every export
npm run build && npm run test:pack      # asserts the tarball ships dist + metadata only (issue #49)
npm run test:integration   # live testnet; needs .env.phase2 (template: .env.phase2.example)
node scripts/check-doc-links.ts   # docs PRs: relative links + anchors (the `links` workflow, #140)
```

## TypeScript strictness ratchet

`tsconfig.json` enables `strict`, `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`, and they stay on. `noUncheckedIndexedAccess` makes
an indexed read yield `T | undefined` — the TypeScript-side mirror of the
contract's `parse_call` bounds checks — and `exactOptionalPropertyTypes` stops an
omitted optional property and an explicitly-`undefined` one from being
interchangeable, which is where options-object footguns hide.

Turning a flag off makes `npm run typecheck` *easier* to pass, so typecheck alone
cannot stop a regression. `npm run check:strict-ratchet` (`scripts/check-strict-ratchet.mjs`)
is the ratchet: it resolves `tsconfig.json` and `tsconfig.build.json` through
`extends` and exits non-zero, naming the file and flag, if any of the three is not
exactly `true`. It runs as a step of the required `ci` check, so a config edit
that disables one is caught before merge. Fix the call site; do not turn the flag
back off.

## Cross-editor standardization

Contributors use diverse operating systems and editors. To prevent cross-platform formatting churn:

- `.editorconfig` establishes baseline editor formatting: 2-space indentation, UTF-8 character encoding, LF line endings, and trimmed trailing whitespace. Note the hierarchy: the project formatter/linter is authoritative; `.editorconfig` assists editors only.
- `.gitattributes` normalizes text line endings to LF on checkout and commit (`* text=auto eol=lf`), preventing Windows CRLF churn.

## Test tiers and fixtures

- **Unit** (`npm test`) — no network, no secrets, deterministic.
- **Live** (`npm run test:integration`) — real testnet; needs `.env.phase2`
  (template: `.env.phase2.example`). Not run on pull requests; see
  "The live testnet suite is not run on every PR" above.

Both tiers run through one runner configuration, `tests/test.config.ts`, read by
`scripts/run-tests.ts`. Projects are named and explicit:

| Script | Project(s) | Notes |
| --- | --- | --- |
| `npm test` / `npm run test:unit` | `unit` (`tests/unit`) | Offline; Node test-runner default concurrency. |
| `npm run test:watch` | `unit` (`tests/unit`) | Development loop: Node's test-runner watch mode, re-running the unit suite on every change to a watched file, so you can edit → read the failure → fix → repeat without re-issuing `npm test`. Same project, same `tsx` transform, same files as `npm test`. |
| `npm run test:integration` | `integration` (`tests/integration`) | Live; concurrency pinned to `1`, because the files share on-chain state. Validates `.env.phase2` up front on entry, failing fast with a single actionable message before launching test files if missing or incomplete. |
| `npm run test:all` | every project, one run | Both suites in a single invocation. |
| `npm run test:coverage` | every project, one run, coverage | Node's `--experimental-test-coverage`; needs `.env.phase2`, because the integration project is included. |

Both projects share the `tsx` transform, so the same `src/` modules load
identically in either tier. A project's invariants — its directory has matching
files, the live project stays serialised — are asserted by
`tests/unit/test-runner.test.ts` rather than left to convention.

When `.env.phase2` is absent or incomplete, the test runner fails immediately at entry with a single actionable message pointing to `.env.phase2.example` and the provision command (`npm run deploy:phase2`) without cascading test cancellations:

```
.env.phase2 was not found in the working directory.

Copy the documented template and fill it in:  cp .env.phase2.example .env.phase2
Or provision a fresh instance (writes the file, including PHASE2_ISSUER_SECRET):  npm run deploy:phase2
```

An existing-but-incomplete file lists all missing required keys in one place:

```
.env.phase2 is incomplete: 6 required key(s) are missing:
  - PHASE2_GUARD
  - PHASE2_TOKEN
  - PHASE2_ADMIN_SECRET
  - PHASE2_AGENT_SECRET
  - PHASE2_RECIPIENT_SECRET
  - PHASE2_OUTSIDER_SECRET

Copy the documented template and fill it in:  cp .env.phase2.example .env.phase2
Or provision a fresh instance (writes the file, including PHASE2_ISSUER_SECRET):  npm run deploy:phase2
```

Fixtures that encode real network shapes are committed and refreshed when the
code or the SDK beneath them changes:

- `tests/fixtures/contract-fixtures.json` — the guard's event vocabulary. Refresh
  with `npm run sync:fixtures` when the contracts repo's schema moves.
- `tests/fixtures/rpc/*.json` — real RPC payloads decoded by
  `tests/unit/rpc-fixtures.test.ts`. Refresh with `npm run capture:rpc-fixtures`
  after touching `src/telemetry.ts` or `src/invoke.ts`, or after upgrading
  `@stellar/stellar-sdk`. Provenance and capture details:
  `tests/fixtures/rpc/README.md`.

## Secrets

`PHASE2_ENV_FILE` (live testnet signing keys) and `NPM_TOKEN` (publish) are
maintainer-managed repository secrets. `.env.phase2` is gitignored — never commit it,
and never embed keys in a workflow or work around a missing secret with an alternate
name.

`PHASE2_ENV_FILE` must stay referenced in **exactly one workflow** —
`.github/workflows/live-suite.yml` — which is triggered only by `schedule` and
`workflow_dispatch`. Never add it to a workflow with a `pull_request` or
`pull_request_target` trigger: that would expose it to a forked pull request.
## Deterministic time control in tests

Time-dependent modules in the SDK (cache TTLs, transaction polling) support dependency injection of a `Clock` abstraction to make tests deterministic and fast.

**For production code**, no action is needed: modules default to the system clock and behave normally.

**For tests that need to control time**, inject a `FakeClock`:

```ts
import { FakeClock } from "stellar-agent-guard-sdk";

const clock = new FakeClock(0); // Start at t=0ms
const interceptor = new PreFlightInterceptor({
  // ... other config ...
  clock, // Pass the fake clock
});

// Time does not advance automatically; you control it
await someAsyncWork();

// Advance the clock deterministically, without real delays
clock.advance(5000); // Skip to t=5000ms

// Pending sleeps/delays complete instantly
// No setTimeout waits; tests run fast and are reproducible
```

**Why it matters**: Multiple modules (cache expiration, transaction polling, telemetry intervals) each used to invent their own time sources (`Date.now()`, `setTimeout`). Without Clock injection, unit tests either:

1. Used real sleeps (slow, flaky, wall-time dependent)
2. Ad-hoc mocked each module separately (non-composable, tests fragile to module changes)

The `Clock` interface allows tests to:
- Simulate time passage synchronously
- Eliminate real `setTimeout` waits
- Test time-dependent boundary conditions deterministically
- Verify cache expiration, retry backoff, and polling behavior without network latency

**Key methods:**

- `clock.now()` — returns current time (in milliseconds, like `Date.now()`)
- `clock.sleep(ms)` — returns a promise that resolves after ms milliseconds
- `clock.advance(ms)` — move the clock forward deterministically; resolves all pending sleeps
- `clock.setTime(ms)` — set clock to an absolute time

**Example: Cache TTL test**

```ts
import { FakeClock } from "stellar-agent-guard-sdk";

test("cache entry expires after TTL", async () => {
  const clock = new FakeClock(1000);
  const interceptor = new PreFlightInterceptor({
    server: mockServer,
    cache: { ttlMs: 5000 },
    clock,
  });

  // First check caches the result
  const decision1 = await interceptor.check(call);

  // Advance to just before expiry (t=5999ms)
  clock.advance(4999);
  const decision2 = await interceptor.check(call);
  // Cache hit — same decision, no RPC call

  // Advance past expiry (t=6000ms)
  clock.advance(1);
  const decision3 = await interceptor.check(call);
  // Cache miss — fresh RPC call needed
});
```

Always use `FakeClock` in unit tests and when testing cache/polling logic. Use real time only when testing live network interaction (integration tests with `.env.phase2`).
