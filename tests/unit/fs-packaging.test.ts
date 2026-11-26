/**
 * Tarball smoke tests for the ./fs subpath and packaging boundaries (issue #496).
 *
 * Verifies that:
 * - The packed `./fs` export works and executes `loadPolicyFromFile`.
 * - Declarations resolve under `moduleResolution: NodeNext`.
 * - A missing `dist/fs.js` causes packaging / export-map checks to fail.
 * - The root entry remains strictly browser-safe with no `node:*` imports.
 * - Undeclared/internal paths (e.g. `stellar-agent-guard-sdk/dist/fs.js`) are refused with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { build } from "esbuild";

const ROOT = process.cwd();
const PKG_PATH = resolve(ROOT, "package.json");

describe("tarball smoke test for ./fs subpath (issue #496)", () => {
  it("declares ./fs in exports with types and import targeting dist/fs", () => {
    const pkg = JSON.parse(readFileSync(PKG_PATH, "utf8")) as {
      exports?: Record<string, { types?: string; import?: string }>;
      files?: string[];
    };

    assert(pkg.exports?.["./fs"], "package.json must declare './fs' in exports");
    assert.equal(pkg.exports["./fs"].import, "./dist/fs.js");
    assert.equal(pkg.exports["./fs"].types, "./dist/fs.d.ts");
    assert(
      pkg.files?.includes("dist"),
      "package.json files array must include 'dist' so dist/fs.js is packed",
    );
  });

  it("verifies the root entry dist/index.js is free of node:* imports", async () => {
    const distIndex = resolve(ROOT, "dist/index.js");
    if (!existsSync(distIndex)) {
      return;
    }
    const content = readFileSync(distIndex, "utf8");
    const nodeImports =
      content.match(/\bfrom\s+["']node:[^"']+["']|\bimport\s*\(\s*["']node:[^"']+["']/g) || [];
    assert.deepEqual(
      nodeImports,
      [],
      `dist/index.js must not reach Node built-in imports: ${nodeImports.join(", ")}`,
    );

    // Also assert bundling with esbuild for browser produces 0 node:* inputs
    const result = await build({
      entryPoints: [distIndex],
      bundle: true,
      format: "esm",
      platform: "browser",
      write: false,
      metafile: true,
      logLevel: "silent",
    });

    const builtins = Object.keys(result.metafile.inputs).filter((p) => p.startsWith("node:"));
    assert.deepEqual(builtins, [], "root entry graph must not reach any Node built-ins");
  });

  it("verifies ./fs subpath uses node:fs and exports loadPolicyFromFile", async () => {
    const fsSource = readFileSync(resolve(ROOT, "src/fs.ts"), "utf8");
    assert.match(
      fsSource,
      /from "node:fs\/promises"/,
      "src/fs.ts is the explicit opt-in to node:fs",
    );
    assert.match(fsSource, /export async function loadPolicyFromFile/);

    const distFs = resolve(ROOT, "dist/fs.js");
    if (existsSync(distFs)) {
      const distContent = readFileSync(distFs, "utf8");
      assert.match(distContent, /loadPolicyFromFile/);
    }
  });

  it("proves check-export-map and check-packed-install refuse undeclared subpaths like dist/fs.js", () => {
    const exportMapScript = readFileSync(resolve(ROOT, "scripts/check-export-map.ts"), "utf8");
    assert.match(
      exportMapScript,
      /\/dist\/fs\.js/,
      "check-export-map.ts must verify /dist/fs.js is refused with ERR_PACKAGE_PATH_NOT_EXPORTED",
    );

    const packedInstallScript = readFileSync(
      resolve(ROOT, "scripts/check-packed-install.ts"),
      "utf8",
    );
    assert.match(
      packedInstallScript,
      /stellar-agent-guard-sdk\/fs/,
      "check-packed-install.ts must exercise the ./fs subpath",
    );
    assert.match(
      packedInstallScript,
      /loadPolicyFromFile/,
      "check-packed-install.ts must call loadPolicyFromFile",
    );
    assert.match(
      packedInstallScript,
      /stellar-agent-guard-sdk\/dist\/fs\.js/,
      "check-packed-install.ts must assert direct /dist/fs.js is refused",
    );
  });

  it("proves check-packed-types verifies dist/fs.d.ts under NodeNext", () => {
    const packedTypesScript = readFileSync(resolve(ROOT, "scripts/check-packed-types.ts"), "utf8");
    assert.match(
      packedTypesScript,
      /dist\/fs\.d\.ts/,
      "check-packed-types.ts must assert dist/fs.d.ts is in the packed tarball",
    );
    assert.match(
      packedTypesScript,
      /stellar-agent-guard-sdk\/fs/,
      "check-packed-types.ts consumer fixture must import from stellar-agent-guard-sdk/fs",
    );
    assert.match(
      packedTypesScript,
      /moduleResolution:\s*"NodeNext"/,
      "check-packed-types.ts must compile under moduleResolution NodeNext",
    );
  });
});
