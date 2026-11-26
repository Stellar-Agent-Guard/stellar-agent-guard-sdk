# Browser / dashboard example

A minimal, read-only page that shows a guard's status and policy using only the
SDK's **browser-safe root entry**. It is the pattern an operator dashboard
should follow.

| File | What it is |
| --- | --- |
| [`dashboard.ts`](dashboard.ts) | `loadGuardDashboard({ server, guard, source })`: reads `status()`, the installed policy and the current window spend through an **injected** RPC server; `renderDashboardText()` formats them. |
| [`main.ts`](main.ts) | Page entry: wires the form in `index.html` to `loadGuardDashboard` with `new rpc.Server(url)`. |
| [`index.html`](index.html) | The page. Loads the bundled `dist/main.js`. |
| [`../../tests/unit/browser-example.test.ts`](../../tests/unit/browser-example.test.ts) | The gate: bundles `main.ts` for the browser, asserts no `node:*` and no `./fs` import, checks the size budget, and runs the loader against a fake RPC server. |

## Run it

```sh
npx esbuild examples/browser/main.ts --bundle --format=esm \
  --platform=browser --outfile=examples/browser/dist/main.js
npx http-server examples/browser   # or any static file server
```

Enter a guard contract address (`C…`) and any funded account's public address
(`G…`, used only as the simulation source). Both are public values.

## What is safe to import in a browser

- **Root entry (`stellar-agent-guard-sdk`) — yes.** It is checked on every CI run
  to bundle for `platform: "browser"` with no `node:*` built-in reachable
  (`npm run test:browser`, [`scripts/check-browser-entry.mjs`](../../scripts/check-browser-entry.mjs)).
- **`stellar-agent-guard-sdk/fs` — never.** It reads policy files from disk and
  imports `node:fs`. A browser bundle that reaches it fails to build (or, if a
  bundler stubs `node:fs`, fails at runtime). This example never imports it, and
  the test above fails if anything in its graph does.

## Keep secrets out of the browser

Everything shipped to a browser is readable by whoever loads the page. So the
example is **read-only by construction**:

- it accepts only public inputs: an RPC URL, a contract address, an account address;
- it never constructs a `Keypair`, never reads a secret seed, and never takes a
  signer or admin key. The test fails if those identifiers appear in its source;
- reading `status()` and the policy needs a simulation, not a signature, so no
  key is required.

Anything that signs (`invoke()`, `heartbeat()`, admin operations) belongs on a
server you control, with the key in that server's secret store. The browser
calls that server; it never holds the key. This is a limitation of the browser
as a platform, not something the SDK can enforce for you. If you put a secret in
front-end code or a `VITE_*` / `NEXT_PUBLIC_*` variable, it is public.

## Bundle size

The committed budget for a browser consumer is in
[`scripts/bundle-size.budget.json`](../../scripts/bundle-size.budget.json)
(esbuild, minified, ESM, browser platform; raw and gzip limits). Check it with:

```sh
npm run check:bundle-size              # dashboard-shaped canary, fails over budget
npm run check:bundle-size -- --report  # print the numbers without failing
```

The example's own bundle is measured by its test, which prints the raw and
gzip size as a test diagnostic (`npm test`) and fails if it exceeds the same
budget. Most of the weight is `@stellar/stellar-sdk` itself, not this SDK.

## Bundlers: what is and is not tested

- **Tested:** esbuild (`platform: "browser"`, ESM), in CI and in this example's test.
- **Not tested:** Vite, webpack, Rollup, Parcel, Next.js and Turbopack. They
  honour the package `exports` map, so they are expected to work, but nothing in
  CI executes them. Treat them as a shape claim, per
  [`docs/runtime-support.md`](../../docs/runtime-support.md). Some of them need a
  `Buffer` polyfill for `@stellar/stellar-sdk`; that is the Stellar SDK's
  requirement, not this package's.
