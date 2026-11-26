/**
 * Node-only policy file loading (issue #105).
 *
 * Script integrators (ops shell scripts, cron agents) keep policy as JSON files,
 * the same shape the contracts repo's fixtures use. This module is the one-call
 * path from a path on disk to a validated `GuardPolicy`: read, parse, validate,
 * return — with a distinct typed error for each of the three failure modes.
 *
 * **Node-only, deliberately behind the `./fs` subpath export.** The root entry
 * stays browser-safe (`npm run test:browser` bundles it with no `node:*`
 * inputs); importing `stellar-agent-guard-sdk/fs` is the explicit opt-in to
 * filesystem I/O. This is the exception path in `docs/design-principles.md`
 * §5, not a pattern for core modules.
 */
import { createHash } from "node:crypto";
import { readFile, watch } from "node:fs/promises";
import { PolicyDecodeError, PolicyFileReadError, PolicyValidationError } from "./errors.ts";
import { formatPolicyDiff, policyDiff, type PolicyChange } from "./policy-diff.ts";
import { policyFromJson } from "./policy-json.ts";
import { validateGuardPolicy, type GuardPolicy, type PolicyFailure } from "./policy.ts";

export { formatPolicyDiff } from "./policy-diff.ts";

/** Options for {@link loadPolicyFromFile}; the same knobs as `validateGuardPolicy`. */
export interface LoadPolicyFromFileOptions {
  /** Guard contract address, enabling the SPEC §8 self-reference rules. */
  guardAddress?: string;
  /** Maximum allowed recipient entries (default: 256 per SPEC §8). */
  maxRecipientEntries?: number;
}

/** Options for {@link diffPolicyFiles}. */
export type DiffPolicyFilesOptions = LoadPolicyFromFileOptions;

/** Result of comparing two policy files with {@link diffPolicyFiles}. */
export interface PolicyFilesDiffResult {
  /** The structured list of differences between the two policies. */
  diff: PolicyChange[];
  /** Alias for `diff`. */
  changes: PolicyChange[];
  /** Rendered human-readable summary of the differences via {@link formatPolicyDiff}. */
  summary: string;
}

/**
 * Read, parse, validate and diff two GuardPolicy JSON files.
 *
 * Both files are validated using {@link loadPolicyFromFile} before diffing.
 * Throws the same typed errors as {@link loadPolicyFromFile} ({@link PolicyFileReadError},
 * {@link PolicyDecodeError}, {@link PolicyValidationError}), naming whether the "left"
 * or "right" policy file failed.
 *
 * Performs no network calls. Returns the structured differences and a rendered summary.
 */
export async function diffPolicyFiles(
  leftPath: string,
  rightPath: string,
  options: DiffPolicyFilesOptions = {},
): Promise<PolicyFilesDiffResult> {
  const left = await loadSidePolicy("left", leftPath, options);
  const right = await loadSidePolicy("right", rightPath, options);

  const diff = policyDiff(left, right);
  const summary = formatPolicyDiff(diff);

  return {
    diff,
    changes: diff,
    summary,
  };
}

async function loadSidePolicy(
  side: "left" | "right",
  filePath: string,
  options: DiffPolicyFilesOptions,
): Promise<GuardPolicy> {
  try {
    return await loadPolicyFromFile(filePath, options);
  } catch (error) {
    if (error instanceof PolicyFileReadError) {
      throw new PolicyFileReadError(`${side} policy file '${filePath}': ${error.message}`, {
        path: error.path,
        code: error.code,
        cause: error.cause ?? error,
      });
    }
    if (error instanceof PolicyDecodeError) {
      throw new PolicyDecodeError(`${side} policy file '${filePath}': ${error.message}`, {
        path: error.path,
        cause: error.cause ?? error,
      });
    }
    if (error instanceof PolicyValidationError) {
      throw new PolicyValidationError(`${side} policy file '${filePath}': ${error.message}`, {
        path: error.path,
        failures: error.failures,
        cause: error.cause ?? error,
      });
    }
    throw error;
  }
}

/**
 * Read, parse and validate a GuardPolicy JSON file.
 *
 * The three rejection paths are intentionally distinguishable by class:
 *
 * - {@link PolicyFileReadError} — the file is missing or unreadable; `code`
 *   carries the errno (`ENOENT`, `EACCES`, ...).
 * - {@link PolicyDecodeError} — the file does not parse as JSON, or does not
 *   match the JSON policy shape (wrong field types, missing fields, bad
 *   addresses, out-of-range integers).
 * - {@link PolicyValidationError} — the file is structurally valid JSON but
 *   violates a SPEC §8 policy rule; every failure is carried in `failures`.
 *
 * Validation runs against the parsed policy, not the raw bytes, so a `path`
 * in a failure is the policy field to fix. Pass `guardAddress` to enforce the
 * self-reference rules a deployed guard would enforce.
 */
export async function loadPolicyFromFile(
  filePath: string,
  options: LoadPolicyFromFileOptions = {},
): Promise<GuardPolicy> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    const code = errnoCode(error);
    throw new PolicyFileReadError(
      `cannot read policy file '${filePath}'${code === null ? "" : ` (${code})`}`,
      { path: filePath, code, cause: error },
    );
  }

  // `policyFromJson` parses and shape-checks without any filesystem I/O. It
  // throws `PolicyDecodeError` with a dotted `path`, including for JSON syntax
  // errors, so the parse failure stays distinct from a filesystem failure.
  const policy = policyFromJson(text);

  const failures = validateGuardPolicy(policy, options);
  if (failures.length > 0) {
    throw new PolicyValidationError(
      `policy file '${filePath}' failed validation with ${failures.length} failure(s): ${summarize(failures)}`,
      { path: filePath, failures },
    );
  }

  return policy;
}

/**
 * Options for {@link watchPolicyFile}.
 */
export interface WatchPolicyFileOptions {
  /**
   * Milliseconds to wait after a change event before reloading the policy
   * file (default: 200). Merges rapid successive write events — such as an
   * editor's atomic save — into one reload.
   */
  debounceMs?: number;
  /**
   * Called with the loaded, validated policy on each write that changes the
   * file's content. Not called for writes that leave the content unchanged
   * (detected via SHA-256 hash).
   *
   * A throwing callback is swallowed: the watcher cannot stop because an
   * observer failed.
   */
  onPolicy: (policy: GuardPolicy) => void;
  /**
   * Called when a reload attempt fails with a {@link PolicyFileReadError},
   * {@link PolicyDecodeError} or {@link PolicyValidationError}. Omitting it
   * silently swallows load errors.
   *
   * A throwing callback is swallowed.
   */
  onError?: (error: unknown) => void;
  /**
   * Abort to stop watching and resolve the returned promise. If already
   * aborted when `watchPolicyFile` is called, the initial load is still
   * attempted and the returned promise resolves immediately after.
   */
  signal?: AbortSignal;
}

/**
 * Watch a policy JSON file for changes and reload it on each write (issue #428).
 *
 * Performs an initial load before entering the watch loop, so the caller
 * always receives the current policy even when the file has not changed since
 * the last time the process ran.
 *
 * Uses SHA-256 content hashing to skip redundant reloads when the file is
 * written without its content changing. The debounce window (default 200 ms)
 * merges rapid successive change events — such as an editor's atomic save —
 * into one reload, so the policy is never reloaded more often than once per
 * window.
 *
 * The returned promise resolves when the signal aborts or when the underlying
 * watcher ends naturally (e.g. the watched file is removed on some platforms).
 * It **never rejects**: watch errors, read errors and validation failures are
 * all routed to `onError` (when supplied) and swallowed otherwise.
 *
 * ```ts
 * const ac = new AbortController();
 * watchPolicyFile("/etc/agent/policy.json", {
 *   onPolicy: (policy) => agent.setPolicy(policy),
 *   onError: (err) => logger.warn("policy reload failed", err),
 *   signal: ac.signal,
 * });
 * ```
 */
export async function watchPolicyFile(
  filePath: string,
  options: WatchPolicyFileOptions,
): Promise<void> {
  const { debounceMs = 200, onPolicy, onError, signal } = options;

  let lastHash: string | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Call a callback, swallowing any throw so the watcher is not interrupted. */
  const invoke = (cb: () => void): void => {
    try {
      cb();
    } catch {
      // observer isolation
    }
  };

  /**
   * Read the file, check the content hash to skip unchanged writes, then
   * parse and validate the policy in-memory from the already-read bytes.
   */
  const tryLoad = async (): Promise<void> => {
    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch (error) {
      const code = errnoCode(error);
      if (onError) {
        invoke(() =>
          onError!(
            new PolicyFileReadError(
              `cannot read policy file '${filePath}'${code === null ? "" : ` (${code})`}`,
              { path: filePath, code, cause: error },
            ),
          ),
        );
      }
      return;
    }

    const hash = createHash("sha256").update(text).digest("hex");
    if (hash === lastHash) return; // content unchanged — skip
    lastHash = hash;

    let policy: GuardPolicy;
    try {
      policy = policyFromJson(text);
    } catch (error) {
      if (onError) invoke(() => onError!(error));
      return;
    }

    const failures = validateGuardPolicy(policy, {});
    if (failures.length > 0) {
      if (onError) {
        invoke(() =>
          onError!(
            new PolicyValidationError(
              `policy file '${filePath}' failed validation with ${failures.length} failure(s): ${failures.map((f) => `${f.rule} at ${f.path}`).join("; ")}`,
              { path: filePath, failures },
            ),
          ),
        );
      }
      return;
    }

    invoke(() => onPolicy(policy));
  };

  const scheduleLoad = (): void => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void tryLoad();
    }, debounceMs);
  };

  // Initial load: always attempt before entering the watch loop so the caller
  // receives the current policy even when the file has not changed.
  await tryLoad();

  if (signal?.aborted) {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    return;
  }

  try {
    for await (const _event of watch(filePath, { signal })) {
      scheduleLoad();
    }
  } catch (error) {
    // AbortError thrown when the signal fires inside the watch loop — normal.
    if (signal?.aborted) return;
    if (onError) invoke(() => onError!(error));
  } finally {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }
}

/** The errno code Node attached to a filesystem error, or `null`. */
function errnoCode(error: unknown): string | null {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

/** One line naming every failed rule so the thrown message is actionable. */
function summarize(failures: readonly PolicyFailure[]): string {
  return failures.map((failure) => `${failure.rule} at ${failure.path}`).join("; ");
}
