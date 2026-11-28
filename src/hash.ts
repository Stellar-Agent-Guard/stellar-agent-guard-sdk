/**
 * Browser-safe SHA-256 helpers.
 *
 * The root entry must not import Node built-ins (design principle 5), so the
 * hashing used by pre-flight cache fingerprints, auth-entry signing and
 * telemetry ids goes through the Stellar SDK's own SHA-256 implementation. That
 * implementation is synchronously usable and browser-compatible, which keeps
 * this module free of `node:crypto` and of an async WebCrypto boundary.
 */
import { hash as sha256Digest } from "@stellar/stellar-sdk";

const encoder = new TextEncoder();

/** UTF-8 bytes for a string, without relying on Node's `Buffer`. */
export function utf8Bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

/** UTF-8 byte length of a string, without relying on Node's `Buffer`. */
export function utf8Length(value: string): number {
  return encoder.encode(value).length;
}

/** Lower-case hex rendering of a byte array. */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Parse a hex string into bytes; throws on malformed input. */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("invalid hex string");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** SHA-256 digest of a string (UTF-8) or byte array. */
export function sha256(data: string | Uint8Array): Uint8Array {
  return sha256Digest(typeof data === "string" ? encoder.encode(data) : data);
}

/** SHA-256 of a string (UTF-8) or byte array, lower-case hex. */
export function sha256Hex(data: string | Uint8Array): string {
  return bytesToHex(sha256(data));
}

/** Concatenate byte arrays into one contiguous array. */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export interface Sha256Hasher {
  update(chunk: Uint8Array): void;
  digest(): Uint8Array;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const SHA256_INITIAL_STATE = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const rotr = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits));

function compressSha256(
  state: Uint32Array,
  schedule: Uint32Array,
  bytes: Uint8Array,
  offset: number,
): void {
  for (let i = 0; i < 16; i += 1) {
    const j = offset + i * 4;
    schedule[i] =
      ((bytes[j]! << 24) | (bytes[j + 1]! << 16) | (bytes[j + 2]! << 8) | bytes[j + 3]!) >>> 0;
  }
  for (let i = 16; i < 64; i += 1) {
    const x = schedule[i - 15]!;
    const y = schedule[i - 2]!;
    const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
    const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
    schedule[i] = (schedule[i - 16]! + s0 + schedule[i - 7]! + s1) >>> 0;
  }
  let a = state[0]!;
  let b = state[1]!;
  let c = state[2]!;
  let d = state[3]!;
  let e = state[4]!;
  let f = state[5]!;
  let g = state[6]!;
  let h = state[7]!;
  for (let i = 0; i < 64; i += 1) {
    const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const ch = (e & f) ^ (~e & g);
    const t1 = (h + s1 + ch + SHA256_K[i]! + schedule[i]!) >>> 0;
    const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (s0 + maj) >>> 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) >>> 0;
  }
  state[0] = (state[0]! + a) >>> 0;
  state[1] = (state[1]! + b) >>> 0;
  state[2] = (state[2]! + c) >>> 0;
  state[3] = (state[3]! + d) >>> 0;
  state[4] = (state[4]! + e) >>> 0;
  state[5] = (state[5]! + f) >>> 0;
  state[6] = (state[6]! + g) >>> 0;
  state[7] = (state[7]! + h) >>> 0;
}

export function createSha256Hasher(): Sha256Hasher {
  const state = SHA256_INITIAL_STATE.slice();
  const block = new Uint8Array(64);
  const schedule = new Uint32Array(64);
  let blockLength = 0;
  let byteLength = 0n;

  return {
    update(chunk: Uint8Array): void {
      byteLength += BigInt(chunk.length);
      let offset = 0;
      if (blockLength > 0) {
        const taken = Math.min(64 - blockLength, chunk.length);
        block.set(chunk.subarray(0, taken), blockLength);
        blockLength += taken;
        offset = taken;
        if (blockLength === 64) {
          compressSha256(state, schedule, block, 0);
          blockLength = 0;
        }
      }
      while (offset + 64 <= chunk.length) {
        compressSha256(state, schedule, chunk, offset);
        offset += 64;
      }
      if (offset < chunk.length) {
        block.set(chunk.subarray(offset), 0);
        blockLength = chunk.length - offset;
      }
    },
    digest(): Uint8Array {
      const digestState = state.slice();
      const padded = new Uint8Array(128);
      padded.set(block.subarray(0, blockLength), 0);
      padded[blockLength] = 0x80;
      const end = blockLength < 56 ? 64 : 128;
      const lengthOffset = end - 8;
      const bitLength = byteLength * 8n;
      const high = Number((bitLength >> 32n) & 0xffffffffn) >>> 0;
      const low = Number(bitLength & 0xffffffffn) >>> 0;
      padded[lengthOffset] = (high >>> 24) & 0xff;
      padded[lengthOffset + 1] = (high >>> 16) & 0xff;
      padded[lengthOffset + 2] = (high >>> 8) & 0xff;
      padded[lengthOffset + 3] = high & 0xff;
      padded[lengthOffset + 4] = (low >>> 24) & 0xff;
      padded[lengthOffset + 5] = (low >>> 16) & 0xff;
      padded[lengthOffset + 6] = (low >>> 8) & 0xff;
      padded[lengthOffset + 7] = low & 0xff;
      for (let offset = 0; offset < end; offset += 64) {
        compressSha256(digestState, schedule, padded, offset);
      }
      const out = new Uint8Array(32);
      for (let i = 0; i < 8; i += 1) {
        const word = digestState[i]!;
        out[i * 4] = (word >>> 24) & 0xff;
        out[i * 4 + 1] = (word >>> 16) & 0xff;
        out[i * 4 + 2] = (word >>> 8) & 0xff;
        out[i * 4 + 3] = word & 0xff;
      }
      return out;
    },
  };
}
