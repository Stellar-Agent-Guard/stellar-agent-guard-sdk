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
import { mkdir, open, readFile, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { PolicyDecodeError, PolicyFileReadError, PolicyValidationError } from "./errors.ts";
import { formatPolicyDiff, policyDiff, type PolicyChange } from "./policy-diff.ts";
import { policyFromJson } from "./policy-json.ts";
import { validateGuardPolicy, type GuardPolicy, type PolicyFailure } from "./policy.ts";
import {
  serializeEventRecord,
  type CursorStore,
  type CursorStoreScope,
  type GuardEvent,
} from "./telemetry.ts";

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

/** Options for {@link JsonFileCursorStore}. */
export interface JsonFileCursorStoreOptions {
  /**
   * Path of the JSON file that backs the store. Parent directories are created
   * on the first write; the file itself is created lazily too, so constructing
   * a store does not touch the filesystem.
   */
  path: string;
  /**
   * Treat an unreadable or corrupt store file as empty instead of failing.
   *
   * Off by default: losing a durable cursor silently would replay or skip
   * events, so corruption is an error unless the caller explicitly chooses to
   * start over. When enabled, the first successful save replaces the corrupt
   * file atomically.
   */
  recoverCorrupt?: boolean;
}

/** Key that unscoped `save()`/`load()` calls share, matching `InMemoryCursorStore`. */
const UNSCOPED_CURSOR_KEY = "\u0000unscoped\u0000";

/** Stable JSON key for one cursor scope; the `\u0000` delimiter cannot collide. */
function cursorStoreKey(scope?: CursorStoreScope): string {
  return scope === undefined
    ? UNSCOPED_CURSOR_KEY
    : `${scope.network}\u0000${scope.guard}\u0000${scope.stream}`;
}

/** True for a plain object, the only shape a cursor store file may have. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * A durable {@link CursorStore} kept in one JSON object on disk (issue #426).
 *
 * `GuardTelemetryListener` persists its committed-stream and failed-transaction
 * cursors through a `CursorStore`; without a durable implementation a process
 * restart resumes from the caller's start ledger or loses the cursor entirely.
 * This store is the small file-backed implementation every production operator
 * was otherwise writing themselves:
 *
 * - **One JSON object, keyed by cursor scope.** The same file can serve several
 *   listeners, guards, networks and both streams without their cursors
 *   colliding (the scope is `network` + `guard` + `stream`).
 * - **Lazy.** The file is read on the first `load()`/`save()` and written only
 *   when a cursor actually changes, so polling in a loop does not rewrite an
 *   unchanged cursor.
 * - **Atomic.** A write goes to a uniquely named temporary file in the same
 *   directory and is then renamed over the target. A killed process can leave a
 *   stray `.tmp` file, never a half-written JSON object at `path`.
 * - **Missing means empty.** A store file that does not exist yet reads as no
 *   cursors, which is the state a listener resumes from on a first run.
 * - **Corrupt is an error by default.** Invalid JSON (or a non-string value)
 *   throws {@link PolicyFileReadError} naming the path, rather than silently
 *   starting over. Pass `recoverCorrupt: true` to opt into that reset.
 *
 * Node-only, like the rest of this module: import it from
 * `stellar-agent-guard-sdk/fs`, never from the browser-safe root entry.
 */
export class JsonFileCursorStore implements CursorStore {
  /** The JSON file that backs this store. */
  readonly path: string;
  private readonly recoverCorrupt: boolean;
  /** Lazily loaded cursor map; a rejected load stays rejected for every caller. */
  private state: Promise<Record<string, string>> | undefined;
  /** Serializes every operation, so read-modify-write cycles cannot race. */
  private queue: Promise<unknown> = Promise.resolve();
  private tempCounter = 0;

  constructor(options: JsonFileCursorStoreOptions) {
    if (options === null || typeof options !== "object" || typeof options.path !== "string") {
      throw new TypeError("JsonFileCursorStore requires a { path: string } options object");
    }
    this.path = options.path;
    this.recoverCorrupt = options.recoverCorrupt ?? false;
  }

  async save(cursor: string, scope?: CursorStoreScope): Promise<void> {
    const key = cursorStoreKey(scope);
    await this.enqueue(async () => {
      const state = await this.readState();
      // A poll that resolves to the same cursor must not rewrite the file.
      if (state[key] === cursor) return;
      const next = { ...state, [key]: cursor };
      await this.writeAtomic(next);
      this.state = Promise.resolve(next);
    });
  }

  async load(scope?: CursorStoreScope): Promise<string | null> {
    return await this.enqueue(async () => {
      const state = await this.readState();
      return state[cursorStoreKey(scope)] ?? null;
    });
  }

  /** Run one operation after every previously queued operation. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private readState(): Promise<Record<string, string>> {
    this.state ??= this.readStateFromDisk();
    return this.state;
  }

  private async readStateFromDisk(): Promise<Record<string, string>> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      const code = errnoCode(error);
      // A missing file is the first-run state, not a failure.
      if (code === "ENOENT" || this.recoverCorrupt) return {};
      throw new PolicyFileReadError(
        `cannot read cursor store '${this.path}'${code === null ? "" : ` (${code})`}`,
        { path: this.path, code, cause: error },
      );
    }

    try {
      const parsed: unknown = JSON.parse(text);
      if (!isPlainObject(parsed)) {
        throw new TypeError("cursor store must contain a JSON object");
      }
      const cursors: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value !== "string") {
          throw new TypeError(`cursor store value for '${key}' is not a string`);
        }
        cursors[key] = value;
      }
      return cursors;
    } catch (cause) {
      if (this.recoverCorrupt) return {};
      throw new PolicyFileReadError(
        `cursor store '${this.path}' is not a valid cursor JSON object; delete it or pass ` +
          `recoverCorrupt: true to start over`,
        { path: this.path, code: "EJSONPARSE", cause },
      );
    }
  }

  private async writeAtomic(state: Record<string, string>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.${process.pid}.${++this.tempCounter}.tmp`;
    try {
      await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      await rename(tempPath, this.path);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

/** Options for {@link createJsonLinesWriter}. */
export interface JsonLinesWriterOptions {
  /** Path of the current (unrotated) JSON Lines file. */
  path: string;
  /**
   * Rotate before a write that would push the current file past this many
   * bytes. Omit (the default) for a single, unbounded file.
   */
  maxBytes?: number;
  /**
   * How many rotated files to retain (`path.1` is the newest). Default: 3.
   * `0` keeps no history: a rotation truncates the current file instead.
   */
  maxFiles?: number;
  /** Call `fsync` after every record. Default: `false` (the OS flush is enough). */
  fsync?: boolean;
}

/**
 * An append-only JSON Lines sink for guard events (issue #427).
 *
 * One {@link serializeEventRecord} record is written per line, in the same
 * versioned envelope a `recentJsonLines()` export uses, so an auditor can parse
 * the file with `parseEventRecord()` without the SDK. Writes are serialized, so
 * concurrent callers cannot interleave lines, and a failed write is rolled back
 * to the previous length so a later record never appends to a torn line.
 *
 * The file contains **decoded event data** — guard address, decision, reason,
 * ledger, timestamps, and the normalized payload — not secrets and not raw XDR.
 * `serializeEventRecord()` never emits the opt-in `raw` payload.
 */
export interface JsonLinesWriter {
  /** The current (unrotated) file this writer appends to. */
  readonly path: string;
  /** Number of records successfully written since this writer was created. */
  readonly count: number;
  /** Append one event as a complete line. */
  write(event: GuardEvent): Promise<void>;
  /** Wait for queued writes; with `fsync`, flush them to disk. */
  flush(): Promise<void>;
  /** Wait for queued writes, flush when configured, and close the file. */
  close(): Promise<void>;
}

class JsonLinesFileWriter implements JsonLinesWriter {
  readonly path: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly fsync: boolean;
  private handle: FileHandle | null = null;
  private size = 0;
  private written = 0;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: JsonLinesWriterOptions) {
    if (options === null || typeof options !== "object" || typeof options.path !== "string") {
      throw new TypeError("createJsonLinesWriter requires a { path: string } options object");
    }
    const maxBytes = options.maxBytes;
    if (
      maxBytes !== undefined &&
      (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    ) {
      throw new RangeError(`maxBytes must be a positive integer (received ${String(maxBytes)})`);
    }
    const maxFiles = options.maxFiles ?? 3;
    if (typeof maxFiles !== "number" || !Number.isSafeInteger(maxFiles) || maxFiles < 0) {
      throw new RangeError(`maxFiles must be an integer >= 0 (received ${String(maxFiles)})`);
    }
    this.path = options.path;
    this.maxBytes = maxBytes ?? Number.POSITIVE_INFINITY;
    this.maxFiles = maxFiles;
    this.fsync = options.fsync ?? false;
  }

  get count(): number {
    return this.written;
  }

  async write(event: GuardEvent): Promise<void> {
    const line = Buffer.from(`${serializeEventRecord(event)}\n`, "utf8");
    await this.enqueue(async () => {
      if (this.closed) throw new Error("cannot write to a closed JSON Lines writer");
      await this.ensureOpen();
      // Rotate before writing, never mid-line. `size > 0` keeps a single record
      // larger than the limit from rotating forever without making progress.
      if (this.size > 0 && this.size + line.length > this.maxBytes) {
        await this.rotate();
      }
      const handle = this.handle;
      if (handle === null) throw new Error("JSON Lines writer has no open file");
      const start = this.size;
      try {
        await writeAll(handle, line);
        this.size += line.length;
        this.written += 1;
        if (this.fsync) await handle.sync();
      } catch (error) {
        // The failed record is surfaced exactly once. Removing whatever bytes it
        // managed to append keeps the next line parseable.
        try {
          await handle.truncate(start);
          this.size = start;
        } catch {
          // The handle is unusable (on Windows, opening a directory succeeds and
          // the failure surfaces at write time, where truncate then fails too).
          // Drop it so the next write reopens the path instead of reusing a
          // stale handle; the on-disk size is re-read on reopen.
          this.handle = null;
          await handle.close().catch(() => undefined);
        }
        throw error;
      }
    });
  }

  async flush(): Promise<void> {
    await this.enqueue(async () => {
      if (this.handle !== null && this.fsync) await this.handle.sync();
    });
  }

  async close(): Promise<void> {
    await this.enqueue(async () => {
      this.closed = true;
      await this.closeHandle();
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async ensureOpen(): Promise<void> {
    if (this.handle !== null) return;
    await mkdir(dirname(this.path), { recursive: true });
    const handle = await open(this.path, "a");
    this.handle = handle;
    this.size = (await handle.stat()).size;
  }

  private async closeHandle(): Promise<void> {
    if (this.handle === null) return;
    const handle = this.handle;
    this.handle = null;
    if (this.fsync) await handle.sync();
    await handle.close();
  }

  /**
   * Move the current file aside as `path.1`, shifting older files up, and start
   * a fresh current file. The newest rotated file is always `path.1`.
   */
  private async rotate(): Promise<void> {
    await this.closeHandle();
    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      await renameOptional(`${this.path}.${index}`, `${this.path}.${index + 1}`);
    }
    if (this.maxFiles >= 1) {
      await renameOptional(this.path, `${this.path}.1`);
    } else {
      await rm(this.path, { force: true });
    }
    const handle = await open(this.path, "a");
    this.handle = handle;
    this.size = (await handle.stat()).size;
  }
}

/** Write every byte of `buffer`; a short write is retried, a zero write fails. */
async function writeAll(handle: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null);
    if (bytesWritten === 0) throw new Error("JSON Lines write made no progress");
    offset += bytesWritten;
  }
}

/** Rename when the source exists; a missing rotated file is not an error. */
async function renameOptional(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
  }
}

/**
 * Create an append-only JSON Lines writer for guard events (issue #427).
 *
 * ```ts
 * import { createJsonLinesWriter } from "stellar-agent-guard-sdk/fs";
 *
 * const writer = createJsonLinesWriter({ path: "guard-events.jsonl", maxBytes: 5_000_000 });
 * await writer.write(event);
 * await writer.flush();
 * await writer.close();
 * ```
 *
 * Each record is one `serializeEventRecord()` line, so the file parses with
 * `parseEventRecord()` line by line. Rotation is size-based: before a write that
 * would cross `maxBytes`, the current file becomes `path.1`, older files shift
 * up, and at most `maxFiles` rotated files are retained. Writes are serialized,
 * so concurrent producers cannot interleave lines, and a failed write rejects
 * once and truncates back to the previous length rather than corrupting the
 * next record.
 */
export function createJsonLinesWriter(options: JsonLinesWriterOptions): JsonLinesWriter {
  return new JsonLinesFileWriter(options);
}
