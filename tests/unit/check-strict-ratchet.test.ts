/**
 * Strictness ratchet guard tests (issue #137).
 *
 * The flags themselves (`strict`, `noUncheckedIndexedAccess`,
 * `exactOptionalPropertyTypes`) are already on in `tsconfig.json`; the missing
 * piece is the ratchet that keeps them on. Two things are pinned here:
 *
 *  1. the guard passes on the committed configs — and, because
 *     `tsconfig.build.json` inherits through `extends`, the check follows the
 *     chain rather than reading one file in isolation; and
 *  2. the guard is *non-vacuous*: a required flag set to `false`, or dropped
 *     entirely, or overridden to `false` in a child config, makes it exit 1 and
 *     name the file and flag. A guard that cannot fail is decoration.
 *
 * The script is `.mjs` and dependency-free, so it is exercised through its real
 * CLI entry point (spawned with plain `node`), the same way CI runs it.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { spawnFile } from "./spawn-file.ts";

const SCRIPT = resolve("scripts/check-strict-ratchet.mjs");
const REQUIRED_FLAGS = ["strict", "noUncheckedIndexedAccess", "exactOptionalPropertyTypes"];

/** Run the guard against an explicit config path (or the defaults with none). */
function runGuard(configPath?: string): ReturnType<typeof spawnFile> {
  return spawnFile("node", configPath ? [SCRIPT, configPath] : [SCRIPT]);
}

/** Write fixtures into a throwaway directory, run the guard, then clean up. */
async function withTempDir<T>(
  write: (dir: string) => Promise<void>,
  run: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "strict-ratchet-"));
  try {
    await write(dir);
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("strict ratchet guard (issue #137)", () => {
  it("passes on the committed configs and names every required flag", async () => {
    const result = await runGuard();
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /strict ratchet check: ok/);
    for (const flag of REQUIRED_FLAGS) {
      assert.match(result.stdout, new RegExp(flag), `output must mention ${flag}`);
    }
    assert.match(result.stdout, /tsconfig\.json/);
    // tsconfig.build.json inherits the flags through `extends`; the guard must
    // follow that chain, not just read the file's own compilerOptions.
    assert.match(result.stdout, /tsconfig\.build\.json/);
  });

  it("fails, naming the flag, when a required flag is explicitly false", async () => {
    const result = await withTempDir(
      (dir) =>
        writeFile(
          join(dir, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: {
              strict: true,
              noUncheckedIndexedAccess: true,
              exactOptionalPropertyTypes: false,
            },
          }),
          "utf8",
        ),
      (dir) => runGuard(join(dir, "tsconfig.json")),
    );

    assert.equal(result.code, 1, "a disabled flag must fail the ratchet");
    assert.match(result.stderr, /exactOptionalPropertyTypes/);
    assert.match(result.stderr, /must be true/);
    assert.match(result.stderr, /got false/);
  });

  it("fails when a required flag is absent rather than false", async () => {
    const result = await withTempDir(
      (dir) =>
        writeFile(
          join(dir, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: { strict: true, exactOptionalPropertyTypes: true },
          }),
          "utf8",
        ),
      (dir) => runGuard(join(dir, "tsconfig.json")),
    );

    assert.equal(result.code, 1);
    assert.match(result.stderr, /noUncheckedIndexedAccess/);
    assert.match(result.stderr, /got undefined/);
  });

  it("accepts an inherited flag and rejects a child override to false", async () => {
    const result = await withTempDir(
      async (dir) => {
        await writeFile(
          join(dir, "base.json"),
          JSON.stringify({
            compilerOptions: {
              strict: true,
              noUncheckedIndexedAccess: true,
              exactOptionalPropertyTypes: true,
            },
          }),
          "utf8",
        );
        await writeFile(
          join(dir, "tsconfig.json"),
          JSON.stringify({
            extends: "./base.json",
            compilerOptions: { exactOptionalPropertyTypes: false },
          }),
          "utf8",
        );
      },
      (dir) => runGuard(join(dir, "tsconfig.json")),
    );

    assert.equal(result.code, 1, "a child override must not slip past the ratchet");
    assert.match(result.stderr, /exactOptionalPropertyTypes/);
    assert.match(result.stderr, /got false/);
  });

  it("parses JSONC configs (comments and trailing commas) without going vacuous", async () => {
    const jsonc = [
      "{",
      "  // the strictness ratchet",
      '  "compilerOptions": {',
      '    "strict": true,',
      '    "noUncheckedIndexedAccess": true,',
      "    /* optional must not be undefined-assignable */",
      '    "exactOptionalPropertyTypes": true,',
      '    "note": "https://example.com//not-a-comment",',
      "  },",
      "}",
    ].join("\n");

    const result = await withTempDir(
      (dir) => writeFile(join(dir, "tsconfig.json"), jsonc, "utf8"),
      (dir) => runGuard(join(dir, "tsconfig.json")),
    );

    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /strict ratchet check: ok/);
  });

  it("is wired into package.json and the gating ci workflow", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    assert.equal(
      pkg.scripts["check:strict-ratchet"],
      "node scripts/check-strict-ratchet.mjs",
      "the ratchet must be runnable through a package script",
    );

    const yaml = await readFile(".github/workflows/ci.yml", "utf8");
    assert.match(yaml, /strictness ratchet/);
    assert.match(yaml, /check:strict-ratchet/);
  });
});
