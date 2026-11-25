#!/usr/bin/env node
/**
 * Are the Types Wrong? check for the packed package (issue #501).
 *
 * Validates that the published package tarball provides correct declaration
 * resolutions for both exported subpaths ("." and "./fs") under TypeScript
 * resolution algorithms (Node16 / NodeNext ESM and Bundler).
 *
 * Package resolution model:
 *   - Pure ESM package ("type": "module") with Node >= 24 engine.
 *   - Subpath ".": exports dist/index.d.ts for ESM and bundler consumers.
 *   - Subpath "./fs": exports dist/fs.d.ts for Node ESM and bundler consumers.
 *   - Legacy CommonJS `require()` of ESM packages resolves to ESM (dynamic import only),
 *     and Node 10 lacks package.json `exports` support; these are ignored via
 *     the `--profile esm-only` flag.
 *
 * Usage:
 *   npm run build && npm run check:attw
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = process.cwd();
const ATTW = resolve(ROOT, "node_modules/.bin/attw");

function runNpm(args: string[], cwd: string): string {
  const command = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "npm";
  const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npm", ...args] : args;
  return execFileSync(command, commandArgs, { cwd, encoding: "utf8" });
}

interface PackResult {
  filename: string;
}

export function runAttwCheck(options: { tarballPath?: string; throwOnError?: boolean } = {}): {
  success: boolean;
  output: string;
} {
  let tempDir: string | undefined;
  let tgzPath = options.tarballPath;

  try {
    if (!tgzPath) {
      if (!existsSync(resolve(ROOT, "dist/index.d.ts"))) {
        runNpm(["run", "build"], ROOT);
      }
      tempDir = mkdtempSync(join(tmpdir(), "guard-attw-pack-"));
      const packJson = runNpm(["pack", "--json", "--pack-destination", tempDir], ROOT);
      const parsed = JSON.parse(packJson) as PackResult[] | Record<string, PackResult>;
      const packed = Array.isArray(parsed) ? parsed : Object.values(parsed);
      const first = packed[0];
      if (!first?.filename) {
        throw new Error("npm pack produced no tarball");
      }
      tgzPath = join(tempDir, first.filename);
    }

    const command = process.platform === "win32" ? `${ATTW}.cmd` : ATTW;
    const args = [tgzPath, "--profile", "esm-only", "--entrypoints", ".", "./fs"];

    const output = execFileSync(command, args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    console.log(output);
    return { success: true, output };
  } catch (error: unknown) {
    const execError = error as {
      stdout?: string;
      stderr?: string;
      status?: number;
      message: string;
    };
    const output = (execError.stdout ?? "") + (execError.stderr ?? "");
    console.error(output || execError.message);

    if (options.throwOnError ?? true) {
      process.exit(execError.status ?? 1);
    }
    return { success: false, output };
  } finally {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

// Execute directly if script is run as CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  runAttwCheck();
}
