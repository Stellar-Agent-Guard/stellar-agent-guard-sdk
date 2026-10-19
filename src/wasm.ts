/**
 * Pinned identity of the guard contract's on-chain artifact, in one place.
 *
 * The dashboard hard-codes this SHA-256 for artifact verification, and the SDK
 * README already cites it in the testnet verification section. Exporting it here
 * makes the SDK the shared home for the constant, so a deploy script (or the
 * dashboard, through its SDK dependency) verifies a downloaded WASM against one
 * source instead of a copy that can silently rot. A contract release changes the
 * hash; that update lands in an SDK release and consumers bump the dependency.
 *
 * See the README's "Verified against live testnet" section and
 * `docs/verification.md`.
 */
export const GUARD_WASM_HASH =
  "f47919f92e78fdd034836aa61955fc338dd56a218c448c37df1867a8c3da0f63";

/** The outcome of verifying WASM bytes against a pinned hash. */
export interface GuardWasmVerification {
  /** True when `actual` equals `expected`. */
  ok: boolean;
  /** The hash compared against, lower-case hex. */
  expected: string;
  /** The SHA-256 of the supplied bytes, lower-case hex. */
  actual: string;
}

/** Lower-case hex rendering of a byte array. */
export function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * SHA-256 of `bytes`, lower-case hex.
 *
 * Uses the runtime's WebCrypto (`globalThis.crypto.subtle`), which both Node
 * (>= 20) and browsers provide natively. That keeps this runtime-agnostic and
 * adds no dependency and no `node:crypto` import, so the same code runs in a
 * deploy CLI and in the browser dashboard. `subtle.digest` is asynchronous, so
 * this is too — hence `verifyGuardWasm`'s Promise return.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "WebCrypto SubtleCrypto is unavailable in this runtime; verifyGuardWasm requires globalThis.crypto.subtle (Node >= 20, or a browser/worker).",
    );
  }
  // `slice()` returns a view backed by a plain ArrayBuffer, which is what
  // `SubtleCrypto.digest` accepts; a caller's Uint8Array may be backed by a
  // SharedArrayBuffer (e.g. a Node Buffer pooling that), which it refuses.
  const digest = await subtle.digest("SHA-256", bytes.slice());
  return toHex(new Uint8Array(digest));
}

/**
 * Verify downloaded guard-contract WASM against the pinned hash.
 *
 * Returns both hashes rather than a bare boolean, so a deployer can log exactly
 * what mismatched. `expected` defaults to `GUARD_WASM_HASH` and is compared
 * case-insensitively after trimming, so a caller holding the hash upper-case
 * still verifies. Async, because `crypto.subtle.digest` is.
 *
 * ```ts
 * import { readFileSync } from "node:fs";
 * import { verifyGuardWasm } from "stellar-agent-guard-sdk";
 *
 * const result = await verifyGuardWasm(readFileSync("guard.wasm"));
 * if (!result.ok) throw new Error(`WASM mismatch: ${result.actual} != ${result.expected}`);
 * ```
 */
export async function verifyGuardWasm(
  bytes: Uint8Array,
  expected: string = GUARD_WASM_HASH,
): Promise<GuardWasmVerification> {
  const normalized = expected.trim().toLowerCase();
  const actual = await sha256Hex(bytes);
  return { ok: actual === normalized, expected: normalized, actual };
}
