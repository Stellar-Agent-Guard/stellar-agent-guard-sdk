/**
 * Browser dashboard example gate (issue #482).
 *
 * 1. Bundles `examples/browser/main.ts` exactly as the README tells a reader to
 *    (esbuild, ESM, `platform: "browser"`, no externals) and asserts no
 *    `node:*` built-in and no Node-only `src/fs.ts` is reachable.
 * 2. Reports the bundle's raw and gzip size (test diagnostic) and keeps it
 *    within the committed browser budget in `scripts/bundle-size.budget.json`.
 * 3. Asserts the example's sources never construct or accept key material.
 * 4. Runs `loadGuardDashboard` against an injected fake RPC server.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { nativeToScVal, type rpc } from "@stellar/stellar-sdk";
import { loadGuardDashboard, renderDashboardText } from "../../examples/browser/dashboard.ts";

const GUARD = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
const SOURCE = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";

function fakeServer(status: Record<string, unknown>): rpc.Server {
  return {
    getAccount: async (id: string) => ({
      accountId: () => id,
      sequenceNumber: () => "100",
      incrementSequenceNumber: () => undefined,
    }),
    simulateTransaction: async () => ({
      id: "1",
      latestLedger: 1000,
      minResourceFee: "0",
      events: [],
      _parsed: true,
      result: { auth: [], retval: nativeToScVal(status) },
    }),
    getLedgerEntries: async () => ({ entries: [], latestLedger: 1000 }),
  } as unknown as rpc.Server;
}

describe("browser dashboard example (issue #482)", () => {
  it("bundles for the browser with no node:* or ./fs import, within the size budget", async (t) => {
    const result = await build({
      entryPoints: [resolve("examples/browser/main.ts")],
      bundle: true,
      minify: true,
      format: "esm",
      platform: "browser",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    const inputs = Object.keys(result.metafile.inputs);
    assert.deepEqual(
      inputs.filter((p) => p.startsWith("node:")),
      [],
      "node:* built-ins are reachable from the browser example",
    );
    assert.equal(
      inputs.some((p) => p.endsWith("src/fs.ts")),
      false,
      "the Node-only ./fs subpath is reachable from the browser example",
    );

    const raw = result.outputFiles[0]!.contents;
    const gzip = gzipSync(raw);
    t.diagnostic(`browser example bundle: ${raw.length} B raw, ${gzip.length} B gzip`);
    const { budget } = JSON.parse(readFileSync("scripts/bundle-size.budget.json", "utf8")) as {
      budget: { rawBytes: number; gzipBytes: number };
    };
    assert.ok(raw.length <= budget.rawBytes, `raw ${raw.length} B over ${budget.rawBytes} B`);
    assert.ok(gzip.length <= budget.gzipBytes, `gzip ${gzip.length} B over ${budget.gzipBytes} B`);
  });

  it("never constructs or accepts key material", () => {
    for (const file of ["examples/browser/dashboard.ts", "examples/browser/main.ts"]) {
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      assert.doesNotMatch(
        code,
        /Keypair|fromSecret|secret|signer|stellar-agent-guard-sdk\/fs|src\/fs/i,
        file,
      );
    }
  });

  it("loads status and policy through an injected RPC server", async () => {
    const view = await loadGuardDashboard({
      server: fakeServer({
        has_policy: false,
        admin_frozen: false,
        heartbeat_expired: false,
        last_heartbeat: 1_700_000_000n,
        now: 1_700_000_100n,
      }),
      guard: GUARD,
      source: SOURCE,
    });
    assert.equal(view.health, "no-policy");
    assert.match(view.policySummary, /no policy installed/);
    assert.equal(view.windowSpent, "0");
    assert.match(renderDashboardText(view), /last heartbeat: 1700000000/);
  });

  it("reports a frozen guard ahead of every other state", async () => {
    const view = await loadGuardDashboard({
      server: fakeServer({
        has_policy: true,
        admin_frozen: true,
        heartbeat_expired: true,
        last_heartbeat: 0n,
        now: 1n,
      }),
      guard: GUARD,
      source: SOURCE,
    });
    assert.equal(view.health, "frozen");
  });
});
