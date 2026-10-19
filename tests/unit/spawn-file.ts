/**
 * Minimal child-process helper for tests that must execute real scripts.
 *
 * Returns the exit code and captured stdio without throwing on a nonzero exit,
 * so a test can assert on the failure itself (the built-in `execFile` promisified
 * API rejects and buries the captured output behind the error object).
 */
import { spawn } from "node:child_process";

export interface SpawnFileResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function spawnFile(
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<SpawnFileResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}
