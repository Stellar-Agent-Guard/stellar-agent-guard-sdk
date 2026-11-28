import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Address, scValToNative, StrKey, xdr } from "@stellar/stellar-sdk";
import { mulberry32, randomUint } from "./seeded-random.ts";
import { PolicyDecodeError } from "../../src/errors.ts";
import {
  decodePolicy,
  policyToScVal,
  readPersistentEntry,
  unsafeAccountAddress,
  unsafeContractAddress,
} from "../../src/policy.ts";
import type { PolicyConfig } from "../../src/policy.ts";

const FUZZ_SEED = 0x475f5eed;
const ITERATIONS = 200;
const MAX_ELEMENTS = 4096;
const BUDGET_BASE = 256;
const BUDGET_PER_NODE = 16;
const I128_MIN = -(2n ** 127n);
const I128_MAX = 2n ** 127n - 1n;
const U64_MAX = 2n ** 64n - 1n;
const U32_MAX = 4_294_967_295;

const CONTRACT = unsafeContractAddress(StrKey.encodeContract(Buffer.alloc(32, 7)));
const ACCOUNT = unsafeAccountAddress(StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 9)));
const BASE_XDR = policyToScVal({
  per_tx_cap: 1n,
  window_secs: 60n,
  window_cap: 2n,
  assets: [CONTRACT],
  protocols: [{ contract: CONTRACT, fns: ["transfer", "approve"] }],
  recipients: [ACCOUNT],
  allow_any_recipient: false,
  active_from: 0n,
  active_until: 0n,
  paused: false,
  dms_grace_secs: 0n,
}).toXDR("base64");

const POLICY_FIELDS = [
  "active_from",
  "active_until",
  "allow_any_recipient",
  "asset_caps",
  "assets",
  "blocked_recipients",
  "dms_grace_secs",
  "paused",
  "per_tx_cap",
  "protocol_calls_per_window",
  "protocols",
  "recipient_window_caps",
  "recipients",
  "window_cap",
  "window_secs",
] as const;
const OPTIONAL_FIELDS = [
  "asset_caps",
  "blocked_recipients",
  "protocol_calls_per_window",
  "recipient_window_caps",
] as const;
const REQUIRED_FIELDS = POLICY_FIELDS.filter(
  (field) => !(OPTIONAL_FIELDS as readonly string[]).includes(field),
);

type Category =
  | "wrong-root"
  | "malformed-option"
  | "wrong-field-type"
  | "huge-arrays"
  | "duplicate-fields"
  | "truncated-maps"
  | "huge-maps"
  | "nested-maps"
  | "numeric-edges"
  | "masquerading-objects";
type ReplayCategory = Category | "missing-entry";
type AssertionContext = (detail: string) => string;
type Expectation =
  | { kind: "decode"; verify: (decoded: PolicyConfig, context: AssertionContext) => void }
  | { kind: "error"; path: string; message: RegExp };
type CaseGenerator = (rand: () => number, iteration: number) => HostileCase;

interface HostileCase {
  value: xdr.ScVal;
  expectation: Expectation;
}

interface BudgetStats {
  reads: number;
  writes: number;
}

function literal(text: string): RegExp {
  return new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

function decodeMessage(path: string, detail: string): string {
  return `cannot decode policy field ${path}: ${detail}`;
}

function missingMessage(fields: readonly string[]): string {
  return `missing field(s): ${fields.join(", ")}`;
}

function replayContext(
  iteration: number,
  category: ReplayCategory,
  base64: string | undefined,
  detail: string,
): string {
  return [
    detail,
    `seed 0x${FUZZ_SEED.toString(16)} iteration ${iteration} category ${category}`,
    ...(base64 === undefined ? [] : [`base64 ${base64}`]),
  ].join("\n");
}

function describeThrown(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function decodeFailure(path: string, message: RegExp): Expectation {
  return { kind: "error", path, message };
}

function decodeSuccess(
  verify: (decoded: PolicyConfig, context: AssertionContext) => void,
): Expectation {
  return { kind: "decode", verify };
}

function cloneBase(): xdr.ScVal {
  return xdr.ScVal.fromXDR(BASE_XDR, "base64");
}

function mapEntries(value: xdr.ScVal): xdr.ScMapEntry[] {
  return [...((value as unknown as { map?: xdr.ScMapEntry[] }).map ?? [])];
}

function vecValues(value: xdr.ScVal): xdr.ScVal[] {
  return [...((value as unknown as { vec?: xdr.ScVal[] }).vec ?? [])];
}

function symbolEntry(name: string, value: xdr.ScVal): xdr.ScMapEntry {
  return new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(name), val: value });
}

function entryName(entry: xdr.ScMapEntry): string {
  return String(scValToNative(entry.key));
}

function withField(value: xdr.ScVal, name: string, replacement: xdr.ScVal): xdr.ScVal {
  return xdr.ScVal.scvMap(
    mapEntries(value).map((entry) =>
      entryName(entry) === name ? symbolEntry(name, replacement) : entry,
    ),
  );
}

function withoutFields(value: xdr.ScVal, names: readonly string[]): xdr.ScVal {
  const removed = new Set(names);
  return xdr.ScVal.scvMap(mapEntries(value).filter((entry) => !removed.has(entryName(entry))));
}

function defaultProtocolRule(): xdr.ScVal {
  const protocols = mapEntries(cloneBase()).find((entry) => entryName(entry) === "protocols")!;
  return vecValues(protocols.val)[0]!;
}

function withProtocolRule(rule: xdr.ScVal): xdr.ScVal {
  return withField(cloneBase(), "protocols", xdr.ScVal.scvVec([rule]));
}

function defaultCapEntries(): xdr.ScMapEntry[] {
  return [
    symbolEntry("cap", xdr.ScVal.scvString("7")),
    symbolEntry("recipient", new Address(ACCOUNT).toScVal()),
  ];
}

function withRecipientCap(entries: xdr.ScMapEntry[]): xdr.ScVal {
  return withField(
    cloneBase(),
    "recipient_window_caps",
    xdr.ScVal.scvVec([xdr.ScVal.scvMap(entries)]),
  );
}

function randomBytes(rand: () => number, length: number): Buffer {
  const bytes = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = Math.floor(rand() * 256);
  }
  return bytes;
}

function randomRange(rand: () => number, min: number, max: number): number {
  return min + Number(randomUint(rand, 32) % BigInt(max - min + 1));
}

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Number(randomUint(rand, 32) % BigInt(index + 1));
    const current = result[index]!;
    result[index] = result[swap]!;
    result[swap] = current;
  }
  return result;
}

function contractAt(rand: () => number, index: number): xdr.ScVal {
  const bytes = randomBytes(rand, 32);
  bytes.writeUInt32BE(index, 0);
  return new Address(StrKey.encodeContract(bytes)).toScVal();
}

function accountAt(rand: () => number, index: number): xdr.ScVal {
  const bytes = randomBytes(rand, 32);
  bytes.writeUInt32BE(index, 0);
  return new Address(StrKey.encodeEd25519PublicKey(bytes)).toScVal();
}

function randomDigits(rand: () => number, length: number): string {
  let result = "";
  for (let index = 0; index < length; index += 1) {
    result += Math.floor(rand() * 10).toString();
  }
  return result;
}

function fakeScVal(fields: Record<string, unknown>): xdr.ScVal {
  return {
    ...fields,
    toXDR: (_format?: string) => BASE_XDR,
  } as unknown as xdr.ScVal;
}

function measureSize(value: unknown): number {
  const seen = new WeakSet<object>();
  const visit = (item: unknown): number => {
    if (item === null || typeof item !== "object" || ArrayBuffer.isView(item) || seen.has(item)) {
      return 0;
    }
    seen.add(item);
    let total = 1;
    if (Array.isArray(item)) {
      for (const child of item) total += visit(child);
    } else {
      for (const key of Object.keys(item)) total += visit(Reflect.get(item, key, item));
    }
    return total;
  };
  return visit(value);
}

function instrumentAndFreeze<T extends object>(target: T, stats: BudgetStats): T {
  const seen = new WeakMap<object, object>();
  const wrap = (value: unknown): unknown => {
    if (value === null || typeof value !== "object" || ArrayBuffer.isView(value)) return value;
    const existing = seen.get(value);
    if (existing !== undefined) return existing;

    const proxy = new Proxy(value, {
      get(entryTarget, property) {
        stats.reads += 1;
        if (property === Symbol.iterator && Array.isArray(entryTarget)) {
          const source = entryTarget;
          return function* (): Generator<unknown, void, undefined> {
            const length = Reflect.get(source, "length", source) as number;
            stats.reads += 1;
            for (let index = 0; index < length; index += 1) {
              stats.reads += 1;
              yield Reflect.get(source, index, source);
            }
          };
        }
        if (Object.prototype.hasOwnProperty.call(entryTarget, property)) {
          return Reflect.get(entryTarget, property, entryTarget);
        }
        const read: unknown = Reflect.get(entryTarget, property, entryTarget);
        return typeof read === "function"
          ? (read as (...args: unknown[]) => unknown).bind(entryTarget)
          : read;
      },
      set(entryTarget, property, valueToSet) {
        stats.writes += 1;
        return Reflect.set(entryTarget, property, valueToSet);
      },
      defineProperty(entryTarget, property, attributes) {
        stats.writes += 1;
        return Reflect.defineProperty(entryTarget, property, attributes);
      },
      deleteProperty(entryTarget, property) {
        stats.writes += 1;
        return Reflect.deleteProperty(entryTarget, property);
      },
    });
    seen.set(value, proxy);
    seen.set(proxy, proxy);

    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        value[index] = wrap(value[index]);
      }
    } else {
      for (const key of Object.keys(value)) {
        const child: unknown = Reflect.get(value, key, value);
        const wrapped = wrap(child);
        if (wrapped !== child) {
          Reflect.defineProperty(value, key, {
            value: wrapped,
            writable: true,
            enumerable: true,
            configurable: true,
          });
        }
      }
    }
    Object.freeze(value);
    return proxy;
  };
  return wrap(target) as T;
}

const wrongRoot: CaseGenerator = (rand) => {
  const choices: xdr.ScVal[] = [
    xdr.ScVal.scvVoid(),
    xdr.ScVal.scvBool(true),
    xdr.ScVal.scvString("policy"),
    xdr.ScVal.scvBytes(Buffer.from("root")),
    xdr.ScVal.scvU32(Number(randomUint(rand, 32) % 1000n)),
  ];
  const value = choices[Number(randomUint(rand, 16)) % choices.length]!;
  const detail =
    value.type === "scvVoid"
      ? "no policy is installed (Void is None, not a config)"
      : `expected a map, got ${value.type}`;
  return {
    value,
    expectation: decodeFailure("policy", literal(decodeMessage("policy", detail))),
  };
};

const malformedOption: CaseGenerator = (rand) => {
  const choices: Array<[xdr.ScVal, number]> = [
    [xdr.ScVal.scvVec([]), 0],
    [xdr.ScVal.scvVec([cloneBase(), cloneBase()]), 2],
    [xdr.ScVal.scvVec([xdr.ScVal.scvU32(1)]), 1],
    [xdr.ScVal.scvVec([xdr.ScVal.scvVoid()]), 1],
    [xdr.ScVal.scvVec([xdr.ScVal.scvVec([cloneBase()])]), 1],
  ];
  const [value, count] = choices[Number(randomUint(rand, 16)) % choices.length]!;
  const detail = `expected a policy map or a one-element Some(policy) vector, got ${count} vector item(s)`;
  return {
    value: value!,
    expectation: decodeFailure("policy", literal(decodeMessage("policy", detail))),
  };
};

const wrongFieldCases: ReadonlyArray<(rand: () => number) => HostileCase> = [
  (rand) => ({
    value: withField(cloneBase(), "per_tx_cap", xdr.ScVal.scvBool(rand() < 0.5)),
    expectation: decodeFailure(
      "per_tx_cap",
      /expected i128 \(scvI128\), or a decimal string, got scvBool/,
    ),
  }),
  () => ({
    value: withField(cloneBase(), "window_secs", xdr.ScVal.scvU32(1)),
    expectation: decodeFailure(
      "window_secs",
      /expected u64 \(scvU64\), or a decimal string, got scvU32/,
    ),
  }),
  () => ({
    value: withField(cloneBase(), "assets", xdr.ScVal.scvString("not-a-vec")),
    expectation: decodeFailure(
      "assets",
      literal(decodeMessage("assets", "expected Vec, got scvString")),
    ),
  }),
  (rand) => ({
    value: withField(
      cloneBase(),
      "assets",
      xdr.ScVal.scvVec(
        Array.from({ length: 1000 }, (_, index) =>
          index === 999 ? xdr.ScVal.scvString("not-an-address") : contractAt(rand, index),
        ),
      ),
    ),
    expectation: decodeFailure("assets[999]", /expected Address, got scvString/),
  }),
  () => ({
    value: withField(cloneBase(), "paused", xdr.ScVal.scvU32(1)),
    expectation: decodeFailure(
      "paused",
      literal(decodeMessage("paused", "expected bool, got scvU32")),
    ),
  }),
  () => ({
    value: withField(
      cloneBase(),
      "protocols",
      xdr.ScVal.scvVec([
        xdr.ScVal.scvMap([
          symbolEntry("contract", new Address(CONTRACT).toScVal()),
          symbolEntry(
            "fns",
            xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("transfer"), xdr.ScVal.scvU32(7)]),
          ),
        ]),
      ]),
    ),
    expectation: decodeFailure("protocols[0].fns[1]", /expected Symbol, got scvU32/),
  }),
  () => ({
    value: withField(
      cloneBase(),
      "recipients",
      xdr.ScVal.scvVec([xdr.ScVal.scvString("not-an-address")]),
    ),
    expectation: decodeFailure("recipients[0]", /expected Address, got scvString/),
  }),
  () => ({
    value: withField(
      cloneBase(),
      "asset_caps",
      xdr.ScVal.scvVec([new Address(CONTRACT).toScVal()]),
    ),
    expectation: decodeFailure(
      "asset_caps",
      literal(
        decodeMessage("asset_caps", "non-empty asset_caps are not supported by this SDK version"),
      ),
    ),
  }),
];

const wrongFieldType: CaseGenerator = (rand) => {
  const factory = wrongFieldCases[Number(randomUint(rand, 16)) % wrongFieldCases.length]!;
  return factory(rand);
};

const hugeArrays: CaseGenerator = (rand, iteration) => {
  const variant = iteration % 5;
  if (variant === 0) {
    const count = iteration === 0 ? MAX_ELEMENTS : randomRange(rand, 512, 2048);
    const addresses = Array.from({ length: count }, (_, index) => contractAt(rand, index));
    const expectedLast = scValToNative(addresses[count - 1]!) as string;
    return {
      value: withField(cloneBase(), "assets", xdr.ScVal.scvVec(addresses)),
      expectation: decodeSuccess((decoded, context) => {
        assert.equal(decoded.assets.length, count, context("huge assets vector was truncated"));
        assert.equal(decoded.assets[count - 1], expectedLast, context("last asset was altered"));
      }),
    };
  }
  if (variant === 1) {
    const count = randomRange(rand, 1024, 3072);
    const fns = Array.from({ length: count }, (_, index) =>
      xdr.ScVal.scvSymbol(`fn_${index.toString().padStart(5, "0")}`),
    );
    return {
      value: withProtocolRule(
        xdr.ScVal.scvMap([
          symbolEntry("contract", new Address(CONTRACT).toScVal()),
          symbolEntry("fns", xdr.ScVal.scvVec(fns)),
        ]),
      ),
      expectation: decodeSuccess((decoded, context) => {
        assert.equal(
          decoded.protocols[0]!.fns?.length,
          count,
          context("huge fns vector was truncated"),
        );
        assert.equal(
          decoded.protocols[0]!.fns?.[count - 1],
          `fn_${(count - 1).toString().padStart(5, "0")}`,
          context("last function name was altered"),
        );
      }),
    };
  }
  if (variant === 2) {
    const count = randomRange(rand, 512, 2048);
    const addresses = Array.from({ length: count }, (_, index) => accountAt(rand, index));
    const expectedLast = scValToNative(addresses[count - 1]!) as string;
    return {
      value: withField(cloneBase(), "recipients", xdr.ScVal.scvVec(addresses)),
      expectation: decodeSuccess((decoded, context) => {
        assert.equal(
          decoded.recipients.length,
          count,
          context("huge recipients vector was truncated"),
        );
        assert.equal(
          decoded.recipients[count - 1],
          expectedLast,
          context("last recipient was altered"),
        );
      }),
    };
  }
  if (variant === 3) {
    return {
      value: withField(
        cloneBase(),
        "assets",
        xdr.ScVal.scvVec(
          Array.from({ length: 1000 }, (_, index) =>
            index === 999 ? xdr.ScVal.scvString("not-an-address") : contractAt(rand, index),
          ),
        ),
      ),
      expectation: decodeFailure("assets[999]", /expected Address, got scvString/),
    };
  }
  const count = 2048;
  const fns = Array.from({ length: count }, (_, index) =>
    index === count - 1
      ? xdr.ScVal.scvU32(9)
      : xdr.ScVal.scvSymbol(`fn_${index.toString().padStart(5, "0")}`),
  );
  return {
    value: withProtocolRule(
      xdr.ScVal.scvMap([
        symbolEntry("contract", new Address(CONTRACT).toScVal()),
        symbolEntry("fns", xdr.ScVal.scvVec(fns)),
      ]),
    ),
    expectation: decodeFailure("protocols[0].fns[2047]", /expected Symbol, got scvU32/),
  };
};

const duplicateFields: CaseGenerator = (rand) => {
  const variant = Number(randomUint(rand, 16)) % 3;
  if (variant === 0) {
    const names = ["paused", "per_tx_cap", "assets", "window_secs"] as const;
    const name = names[Number(randomUint(rand, 16)) % names.length]!;
    const entries = mapEntries(cloneBase());
    const original = entries.find((entry) => entryName(entry) === name)!;
    entries.splice(entries.indexOf(original) + 1, 0, symbolEntry(name, original.val));
    return {
      value: xdr.ScVal.scvMap(entries),
      expectation: decodeFailure(
        "policy",
        literal(decodeMessage("policy", `duplicate field "${name}"`)),
      ),
    };
  }
  if (variant === 1) {
    const names = ["contract", "fns"] as const;
    const name = names[Number(randomUint(rand, 16)) % names.length]!;
    const entries = mapEntries(defaultProtocolRule());
    const original = entries.find((entry) => entryName(entry) === name)!;
    entries.splice(entries.indexOf(original) + 1, 0, symbolEntry(name, original.val));
    return {
      value: withProtocolRule(xdr.ScVal.scvMap(entries)),
      expectation: decodeFailure(
        "protocols[0]",
        literal(decodeMessage("protocols[0]", `duplicate field "${name}"`)),
      ),
    };
  }
  const names = ["cap", "recipient"] as const;
  const name = names[Number(randomUint(rand, 16)) % names.length]!;
  const entries = defaultCapEntries();
  const original = entries.find((entry) => entryName(entry) === name)!;
  entries.splice(entries.indexOf(original) + 1, 0, symbolEntry(name, original.val));
  return {
    value: withRecipientCap(entries),
    expectation: decodeFailure(
      "recipient_window_caps[0]",
      literal(decodeMessage("recipient_window_caps[0]", `duplicate field "${name}"`)),
    ),
  };
};

const truncatedMaps: CaseGenerator = (rand) => {
  const variant = Number(randomUint(rand, 16)) % 3;
  if (variant === 0) {
    const removed = shuffled(REQUIRED_FIELDS, rand).slice(0, 1 + Number(randomUint(rand, 16) % 3n));
    const missing = POLICY_FIELDS.filter((field) => removed.includes(field));
    return {
      value: withoutFields(cloneBase(), removed),
      expectation: decodeFailure(
        "policy",
        literal(decodeMessage("policy", missingMessage(missing))),
      ),
    };
  }
  if (variant === 1) {
    const missing = shuffled(["contract", "fns"], rand).slice(
      0,
      1 + Number(randomUint(rand, 16) % 2n),
    );
    const fieldOrder = ["contract", "fns", "paused"].filter((field) => missing.includes(field));
    return {
      value: withProtocolRule(withoutFields(defaultProtocolRule(), missing)),
      expectation: decodeFailure(
        "protocols[0]",
        literal(decodeMessage("protocols[0]", missingMessage(fieldOrder))),
      ),
    };
  }
  const missing = shuffled(["cap", "recipient"], rand).slice(
    0,
    1 + Number(randomUint(rand, 16) % 2n),
  );
  const fieldOrder = ["recipient", "cap"].filter((field) => missing.includes(field));
  return {
    value: withRecipientCap(
      mapEntries(withoutFields(xdr.ScVal.scvMap(defaultCapEntries()), missing)),
    ),
    expectation: decodeFailure(
      "recipient_window_caps[0]",
      literal(decodeMessage("recipient_window_caps[0]", missingMessage(fieldOrder))),
    ),
  };
};

const hugeMaps: CaseGenerator = (rand) => {
  const variant = Number(randomUint(rand, 16)) % 3;
  const unknown = "zzzz00000";
  if (variant === 0) {
    const entries = mapEntries(cloneBase());
    const extras = randomRange(rand, 512, MAX_ELEMENTS - POLICY_FIELDS.length);
    for (let index = 0; index < extras; index += 1) {
      entries.push(
        symbolEntry(`zzzz${index.toString().padStart(5, "0")}`, xdr.ScVal.scvBool(true)),
      );
    }
    return {
      value: xdr.ScVal.scvMap(entries),
      expectation: decodeFailure(
        "policy",
        literal(decodeMessage("policy", `unknown field "${unknown}"`)),
      ),
    };
  }
  if (variant === 1) {
    const entries = mapEntries(cloneBase());
    const paused = entries.find((entry) => entryName(entry) === "paused")!;
    entries.splice(entries.indexOf(paused) + 1, 0, symbolEntry("paused", paused.val));
    const extras = randomRange(rand, 512, MAX_ELEMENTS - POLICY_FIELDS.length - 1);
    for (let index = 0; index < extras; index += 1) {
      entries.push(
        symbolEntry(`zzzz${index.toString().padStart(5, "0")}`, xdr.ScVal.scvBool(true)),
      );
    }
    return {
      value: xdr.ScVal.scvMap(entries),
      expectation: decodeFailure(
        "policy",
        literal(decodeMessage("policy", 'duplicate field "paused"')),
      ),
    };
  }
  const entries = mapEntries(defaultProtocolRule());
  const extras = randomRange(rand, 512, 2048);
  for (let index = 0; index < extras; index += 1) {
    entries.push(symbolEntry(`zzzz${index.toString().padStart(5, "0")}`, xdr.ScVal.scvBool(true)));
  }
  return {
    value: withProtocolRule(xdr.ScVal.scvMap(entries)),
    expectation: decodeFailure(
      "protocols[0]",
      literal(decodeMessage("protocols[0]", `unknown field "${unknown}"`)),
    ),
  };
};

const nestedMaps: CaseGenerator = (rand) => {
  const variant = Number(randomUint(rand, 16)) % 5;
  if (variant === 0) {
    const rules = mapEntries(defaultProtocolRule());
    rules.push(symbolEntry("zzzz", xdr.ScVal.scvBool(true)));
    return {
      value: withProtocolRule(xdr.ScVal.scvMap(rules)),
      expectation: decodeFailure(
        "protocols[0]",
        literal(decodeMessage("protocols[0]", 'unknown field "zzzz"')),
      ),
    };
  }
  if (variant === 1) {
    return {
      value: withProtocolRule(xdr.ScVal.scvMap(mapEntries(defaultProtocolRule()).reverse())),
      expectation: decodeFailure(
        "protocols[0]",
        /symbol keys are not sorted \(paused precedes fns\)/,
      ),
    };
  }
  if (variant === 2) {
    const caps = defaultCapEntries();
    caps.push(symbolEntry("zzzz", xdr.ScVal.scvBool(true)));
    return {
      value: withRecipientCap(caps),
      expectation: decodeFailure(
        "recipient_window_caps[0]",
        literal(decodeMessage("recipient_window_caps[0]", 'unknown field "zzzz"')),
      ),
    };
  }
  if (variant === 3) {
    return {
      value: withRecipientCap(defaultCapEntries().reverse()),
      expectation: decodeFailure(
        "recipient_window_caps[0]",
        /symbol keys are not sorted \(recipient precedes cap\)/,
      ),
    };
  }
  return {
    value: withProtocolRule(
      withField(defaultProtocolRule(), "paused", xdr.ScVal.scvU32(rand() < 0.5 ? 0 : 1)),
    ),
    expectation: decodeFailure("protocols[0].paused", /expected bool, got scvU32/),
  };
};

const numericEdgeCases: ReadonlyArray<(rand: () => number) => HostileCase> = [
  () => ({
    value: withField(cloneBase(), "per_tx_cap", xdr.ScVal.scvString(I128_MAX.toString())),
    expectation: decodeSuccess((decoded, context) => {
      assert.equal(decoded.per_tx_cap, I128_MAX, context("i128 max was not preserved"));
    }),
  }),
  () => ({
    value: withField(cloneBase(), "per_tx_cap", xdr.ScVal.scvString(I128_MIN.toString())),
    expectation: decodeSuccess((decoded, context) => {
      assert.equal(decoded.per_tx_cap, I128_MIN, context("i128 min was not preserved"));
    }),
  }),
  () => ({
    value: withField(cloneBase(), "window_secs", xdr.ScVal.scvString(U64_MAX.toString())),
    expectation: decodeSuccess((decoded, context) => {
      assert.equal(decoded.window_secs, U64_MAX, context("u64 max was not preserved"));
    }),
  }),
  (rand) => {
    const amount = randomUint(rand, 127);
    return {
      value: withField(cloneBase(), "window_cap", xdr.ScVal.scvString(amount.toString())),
      expectation: decodeSuccess((decoded, context) => {
        assert.equal(decoded.window_cap, amount, context("seeded i128 string was altered"));
      }),
    };
  },
  (rand) => ({
    value: withField(
      cloneBase(),
      "per_tx_cap",
      xdr.ScVal.scvString(randomDigits(rand, randomRange(rand, 1024, 2048))),
    ),
    expectation: decodeFailure(
      "per_tx_cap",
      /is outside the supported \[-170141183460469231731687303715884105728/,
    ),
  }),
  (rand) => ({
    value: withField(
      cloneBase(),
      "window_secs",
      xdr.ScVal.scvString(randomDigits(rand, randomRange(rand, 1024, 2048))),
    ),
    expectation: decodeFailure(
      "window_secs",
      /is outside the supported \[0, 18446744073709551615\]/,
    ),
  }),
  () => ({
    value: withField(cloneBase(), "per_tx_cap", xdr.ScVal.scvString("1e999")),
    expectation: decodeFailure(
      "per_tx_cap",
      literal(decodeMessage("per_tx_cap", "value is not a base-10 integer")),
    ),
  }),
  (rand) => ({
    value: withField(
      cloneBase(),
      "dms_grace_secs",
      xdr.ScVal.scvString(`-${(randomUint(rand, 64) + 1n).toString()}`),
    ),
    expectation: decodeFailure(
      "dms_grace_secs",
      /is outside the supported \[0, 18446744073709551615\]/,
    ),
  }),
  () => ({
    value: withField(
      cloneBase(),
      "protocol_calls_per_window",
      xdr.ScVal.scvString((BigInt(U32_MAX) + 1n).toString()),
    ),
    expectation: decodeFailure(
      "protocol_calls_per_window",
      /is outside the supported \[0, 4294967295\]/,
    ),
  }),
  () => ({
    value: withField(cloneBase(), "window_secs", xdr.ScVal.scvU32(1)),
    expectation: decodeFailure(
      "window_secs",
      /expected u64 \(scvU64\), or a decimal string, got scvU32/,
    ),
  }),
];

const numericEdges: CaseGenerator = (rand) => {
  const factory = numericEdgeCases[Number(randomUint(rand, 16)) % numericEdgeCases.length]!;
  return factory(rand);
};

const masqueradingObjectCases: ReadonlyArray<(rand: () => number) => HostileCase> = [
  () => ({
    value: fakeScVal({ type: "scvVec", vec: [] }),
    expectation: decodeFailure(
      "policy",
      literal(
        decodeMessage(
          "policy",
          "expected a policy map or a one-element Some(policy) vector, got 0 vector item(s)",
        ),
      ),
    ),
  }),
  () => ({
    value: fakeScVal({ type: "scvVec", vec: [cloneBase(), cloneBase()] }),
    expectation: decodeFailure(
      "policy",
      literal(
        decodeMessage(
          "policy",
          "expected a policy map or a one-element Some(policy) vector, got 2 vector item(s)",
        ),
      ),
    ),
  }),
  () => ({
    value: fakeScVal({
      type: "scvMap",
      map: [symbolEntry("paused", xdr.ScVal.scvBool(true))],
    }),
    expectation: decodeFailure(
      "policy",
      literal(
        decodeMessage(
          "policy",
          missingMessage(REQUIRED_FIELDS.filter((field) => field !== "paused")),
        ),
      ),
    ),
  }),
  () => ({
    value: fakeScVal({
      type: "scvMap",
      map: [new xdr.ScMapEntry({ key: xdr.ScVal.scvU32(1), val: xdr.ScVal.scvBool(true) })],
    }),
    expectation: decodeFailure(
      "policy.<key>",
      literal(decodeMessage("policy.<key>", "expected a symbol key, got scvU32")),
    ),
  }),
  () => ({
    value: fakeScVal({ type: "scvVec", vec: [{ type: "scvMap" }] }),
    expectation: decodeFailure(
      "policy",
      literal(decodeMessage("policy", missingMessage(REQUIRED_FIELDS))),
    ),
  }),
];

const masqueradingObjects: CaseGenerator = (rand) => {
  const factory =
    masqueradingObjectCases[Number(randomUint(rand, 16)) % masqueradingObjectCases.length]!;
  return factory(rand);
};

const GENERATORS: ReadonlyArray<readonly [Category, CaseGenerator]> = [
  ["wrong-root", wrongRoot],
  ["malformed-option", malformedOption],
  ["wrong-field-type", wrongFieldType],
  ["huge-arrays", hugeArrays],
  ["duplicate-fields", duplicateFields],
  ["truncated-maps", truncatedMaps],
  ["huge-maps", hugeMaps],
  ["nested-maps", nestedMaps],
  ["numeric-edges", numericEdges],
  ["masquerading-objects", masqueradingObjects],
];

describe("decodePolicy hostile ScVal fuzz (seeded, issue #475)", () => {
  it("always fails typed, preserves its input, and stays within a linear read budget", () => {
    const rand = mulberry32(FUZZ_SEED);
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const [category, generate] = GENERATORS[iteration % GENERATORS.length]!;
      const hostile = generate(rand, iteration);
      const before = hostile.value.toXDR("base64");
      const size = measureSize(hostile.value);
      const stats: BudgetStats = { reads: 0, writes: 0 };
      const guarded = instrumentAndFreeze(hostile.value, stats);
      let decoded: PolicyConfig | undefined;
      let thrown: unknown;
      try {
        decoded = decodePolicy(guarded);
      } catch (error) {
        thrown = error;
      }
      const reads = stats.reads;
      const writes = stats.writes;
      const context = (detail: string) => replayContext(iteration, category, before, detail);

      if (hostile.expectation.kind === "error") {
        assert.ok(
          thrown instanceof PolicyDecodeError,
          context(`expected PolicyDecodeError, got ${describeThrown(thrown)}`),
        );
        assert.equal(typeof thrown.path, "string", context("error path was not a string"));
        assert.ok(thrown.path.length > 0, context("error path was empty"));
        assert.equal(
          thrown.path,
          hostile.expectation.path,
          context(
            `expected path ${hostile.expectation.path}, got ${thrown.path}: ${thrown.message}`,
          ),
        );
        assert.match(
          thrown.message,
          hostile.expectation.message,
          context(`expected message ${hostile.expectation.message}, got ${thrown.message}`),
        );
      } else {
        assert.equal(
          thrown,
          undefined,
          context(`expected a successful decode, got ${describeThrown(thrown)}`),
        );
        assert.ok(decoded !== undefined, context("decodePolicy returned undefined"));
        hostile.expectation.verify(decoded, context);
      }

      assert.equal(writes, 0, context(`decodePolicy attempted ${writes} write(s)`));
      const after = guarded.toXDR("base64");
      assert.equal(after, before, context("decodePolicy mutated its input ScVal"));
      const budget = BUDGET_BASE + BUDGET_PER_NODE * size;
      assert.ok(
        reads <= budget,
        context(`decodePolicy used ${reads} property reads, budget ${budget} for ${size} nodes`),
      );
    }
  });
});

describe("readPersistentEntry missing ledger entries (seeded, issue #475)", () => {
  type LedgerServer = Parameters<typeof readPersistentEntry>[0];

  function ledgerServer(response: unknown): LedgerServer {
    return {
      getLedgerEntries: () => Promise.resolve(response),
    } as unknown as LedgerServer;
  }

  const responses: ReadonlyArray<readonly [string, unknown]> = [
    ["response.entries is absent", {}],
    ["response.entries is empty", { entries: [] }],
    ["the first entry is absent", { entries: [undefined] }],
    ["the entry has no val", { entries: [{}] }],
    ["the entry has no contractData", { entries: [{ val: {} }] }],
    ["contractData has no val", { entries: [{ val: { contractData: {} } }] }],
  ];

  for (const [index, [name, response]] of responses.entries()) {
    it(`returns null when ${name}`, async () => {
      await assert.doesNotReject(async () => {
        const result = await readPersistentEntry(ledgerServer(response), CONTRACT, "Policy");
        assert.equal(
          result,
          null,
          replayContext(index, "missing-entry", undefined, `expected null for ${name}`),
        );
      });
    });
  }
});
