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
import { readFile } from "node:fs/promises";
import { PolicyFileReadError, PolicyValidationError } from "./errors.ts";
import { policyFromJson } from "./policy-json.ts";
import { validateGuardPolicy, type GuardPolicy, type PolicyFailure } from "./policy.ts";

/** Options for {@link loadPolicyFromFile}; the same knobs as `validateGuardPolicy`. */
export interface LoadPolicyFromFileOptions {
  /** Guard contract address, enabling the SPEC §8 self-reference rules. */
  guardAddress?: string;
  /** Maximum allowed recipient entries (default: 256 per SPEC §8). */
  maxRecipientEntries?: number;
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
