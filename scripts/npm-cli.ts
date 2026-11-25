import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Runs npm without relying on `npm.cmd`/shell resolution on Windows.
 *
 * npm sets `npm_execpath` to its JavaScript CLI for every `npm run` script, so
 * launching that path with the current Node executable works identically on
 * POSIX and Windows, including arguments that contain path separators or
 * spaces. Direct invocation falls back to the platform executable.
 */
export function runNpm(args: string[], options: ExecFileSyncOptions & { cwd: string }): string {
  const npmCli = process.env.npm_execpath;
  if (npmCli && npmCli.endsWith(".js") && existsSync(npmCli)) {
    return execFileSync(process.execPath, [npmCli, ...args], options) as string;
  }
  return execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    ...options,
    shell: process.platform === "win32",
  }) as string;
}
