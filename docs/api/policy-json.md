# Policy JSON API

`policyToJson()` and `policyFromJson()` convert a `PolicyConfig` to and from a
**lossless, JSON-safe** representation. The format exists for ops tooling —
policy files in a repo, CLI input, a dashboard's draft form, a diff in a pull
request — where a `bigint` cannot travel through `JSON.stringify` and a
JavaScript `number` would silently lose precision above 2^53.

Source: [`src/policy-json.ts`](../../src/policy-json.ts). The module performs no
filesystem I/O and no network calls; it is not contract encoding (that is
`policyToScVal()` / `policyFromScVal()`) and not policy validation (that is
`validateGuardPolicy()` or [`validateGuardPolicyAgainstSchema()`](policy-schema.md)).

## Exports

| Export | Kind | Description |
| --- | --- | --- |
| `policyToJson(policy)` | function | `ReadonlyPolicyConfig` → `PolicyJson`. Never throws for a well-typed policy. |
| `policyFromJson(input)` | function | `unknown` (an object, or a JSON **string**) → `PolicyConfig`. Throws `PolicyDecodeError` on the first problem. |
| `encodePolicyJson` | alias | The same function as `policyToJson`, for callers who prefer encode/decode naming. |
| `decodePolicyJson` | alias | The same function as `policyFromJson`. |
| `POLICY_JSON_VERSION` | constant | `1`. The only version `policyFromJson` accepts. |
| `PolicyJson` | type | The JSON shape (below). |
| `PolicyJsonProtocolRule` | type | `{ contract: string; fns: string[] \| null; paused?: boolean }` |
| `PolicyJsonRecipientWindowCap` | type | `{ recipient: string; cap: string }` |

All of these are exported from the package root:

```ts
import {
  POLICY_JSON_VERSION,
  policyFromJson,
  policyToJson,
  type PolicyJson,
} from "stellar-agent-guard-sdk";
```

## The format

Every integer field is a **base-10 decimal string**; addresses are StrKey
strings; booleans and `null` are native JSON.

| Field | JSON type | Wire type / range | Required |
| --- | --- | --- | --- |
| `version` | number | must equal `POLICY_JSON_VERSION` (`1`) | yes |
| `per_tx_cap` | decimal string | `i128` | yes |
| `window_secs` | decimal string | `u64` | yes |
| `window_cap` | decimal string | `i128` | yes |
| `assets` | string[] | contract addresses (`C…`) | yes |
| `protocols` | `PolicyJsonProtocolRule[]` | `contract`: `C…`; `fns`: string[] or `null` (any function); `paused`: boolean, optional | yes |
| `recipients` | string[] | account addresses (`G…`) | yes |
| `allow_any_recipient` | boolean | — | yes |
| `active_from` | decimal string | `u64` | yes |
| `active_until` | decimal string | `u64` | yes |
| `paused` | boolean | — | yes |
| `dms_grace_secs` | decimal string | `u64` | yes |
| `recipient_window_caps` | `PolicyJsonRecipientWindowCap[]` | `recipient`: `G…`; `cap`: `i128` decimal string | no |
| `blocked_recipients` | string[] | account addresses (`G…`) | no |
| `protocol_calls_per_window` | decimal string | `u32` | no |

Decimal strings match `^[+-]?\d+$`. A JSON number (`100`), a float string
(`"1.5"`), hex (`"0x10"`), or surrounding whitespace is rejected. The range
check is the **wire** range only (`i128` is `[-2^127, 2^127 - 1]`, `u64` is
`[0, 2^64 - 1]`, `u32` is `[0, 4294967295]`): a negative `per_tx_cap` decodes
successfully, because rejecting it is a SPEC §8 validation rule, not a
representability rule. Run a validator after decoding (see
[Validating after decode](#validating-after-decode)).

Address fields are checked with the same StrKey checksum decoder as
`isContractAddress()` / `isAccountAddress()`. Function names in `fns` are only
checked to be strings here; empty lists and Soroban symbol syntax are policy
validation concerns.

### Valid example

The JSON `policyToJson()` produces for a minimal one-asset, one-recipient policy
(this block is checked against the current output by
`tests/unit/policy-docs.test.ts`):

<!-- doc-example: policy-json-valid -->
```json
{
  "version": 1,
  "per_tx_cap": "100",
  "window_secs": "3600",
  "window_cap": "500",
  "assets": [
    "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB"
  ],
  "protocols": [],
  "recipients": [
    "GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH"
  ],
  "allow_any_recipient": false,
  "active_from": "0",
  "active_until": "0",
  "paused": false,
  "dms_grace_secs": "604800"
}
```

Round trip (illustrative — `policy` is any `PolicyConfig`):

```ts no-check: illustrative fragment
const json: PolicyJson = policyToJson(policy);
const text = JSON.stringify(json, null, 2); // safe: no bigint left in `json`
const decoded = policyFromJson(text);       // bigint fields restored exactly
```

### Invalid example

`per_tx_cap` given as a JSON number instead of a decimal string:

<!-- doc-example: policy-json-invalid -->
```json
{
  "version": 1,
  "per_tx_cap": 100,
  "window_secs": "3600",
  "window_cap": "500",
  "assets": [
    "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB"
  ],
  "protocols": [],
  "recipients": [
    "GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH"
  ],
  "allow_any_recipient": false,
  "active_from": "0",
  "active_until": "0",
  "paused": false,
  "dms_grace_secs": "604800"
}
```

`policyFromJson()` throws:

<!-- doc-example: policy-json-invalid-error -->
```text
PolicyDecodeError: cannot decode policy JSON field policy.per_tx_cap: expected a base-10 decimal string for i128
  path: policy.per_tx_cap
```

## Versioning

- `policyToJson()` always writes `"version": 1` (`POLICY_JSON_VERSION`).
- `policyFromJson()` accepts **only** `version === 1` (the number, not the
  string `"1"`). Any other value — absent, `2`, `"1"` — throws a
  `PolicyDecodeError` at `policy.version`. There is no best-effort reading of a
  newer document: a reader that does not know a version cannot know which
  fields it would be silently dropping.
- The three optional fields (`recipient_window_caps`, `blocked_recipients`,
  `protocol_calls_per_window`) and the per-rule `paused` flag were added without
  a version bump because they are **additive**: a document that omits them
  decodes exactly as before. A change that alters the meaning of an existing
  field, or makes an optional field required, will bump `POLICY_JSON_VERSION`
  and is a breaking change under the
  [0.x deprecation policy](../deprecations.md).

## Canonical ordering

`policyToJson()` output is deterministic for a given policy, so
`JSON.stringify(policyToJson(policy))` is stable enough to diff or hash:

- **Key order is fixed**: `version`, then the required fields in the order of
  the table above, then `recipient_window_caps`, `blocked_recipients`,
  `protocol_calls_per_window`. Inside a protocol rule: `contract`, `fns`,
  `paused`. Inside a recipient cap: `recipient`, `cap`.
- **Array order is preserved**, not sorted. `assets`, `recipients`,
  `protocols[].fns` and the rest come out in the order the policy stores them.
  Two policies that hold the same set in a different order therefore produce
  different JSON; compare them with `policyDiff()`, which is set-aware, rather
  than with a string compare.
- **Absent optional fields are omitted**, not written as `null` or `[]`. A
  protocol rule's `paused` is written only when it is `true`; `paused: false`
  and an absent `paused` both encode to no key.
- Integers are written with `bigint.toString()`: no leading `+`, no leading
  zeros, `-` only for negatives.

`policyFromJson()` does not require canonical input: key order and a leading
`+` or leading zeros in a decimal string are accepted.

## Error paths

Every decoding failure is a `PolicyDecodeError` (a `GuardError`) whose `path`
is the dotted JSON path of the offending field and whose message has the shape
`cannot decode policy JSON field <path>: <detail>`. Decoding stops at the
**first** failure; for a complete list of policy problems, decode and then run
a validator.

| Input problem | `path` | Message detail |
| --- | --- | --- |
| String input that is not JSON | `policy` | `is not valid JSON` (the `SyntaxError` is the `cause`) |
| Root or nested entry is not an object (array, `null`, scalar) | e.g. `policy`, `policy.protocols[0]` | `expected an object` |
| Unknown key | e.g. `policy.extra`, `policy.protocols[0].fn` | `unknown field` |
| Missing required key | e.g. `policy.per_tx_cap` | `missing field` |
| `version` is not `1` | `policy.version` | `expected version 1` |
| List field is not an array | e.g. `policy.assets` | `expected an array` |
| Boolean field is not a boolean | e.g. `policy.paused` | `expected a boolean` |
| Address fails the StrKey/prefix check | e.g. `policy.recipients[0]` | `expected a valid Stellar account address` / `… contract address` |
| `fns` entry is not a string | e.g. `policy.protocols[0].fns[1]` | `expected a string` |
| Integer is not a decimal string | e.g. `policy.window_secs` | `expected a base-10 decimal string for u64` |
| Integer outside the wire range | e.g. `policy.window_secs` | `<value> is outside the supported [<min>, <max>] range` |

Unknown keys are checked before missing keys, so a misspelt field
(`per_tx_capp`) is reported as `policy.per_tx_capp: unknown field`.

Branch on the class and `path`, not on the message text:

```ts no-check: illustrative fragment
import { PolicyDecodeError, policyFromJson } from "stellar-agent-guard-sdk";

try {
  const policy = policyFromJson(untrustedText);
} catch (error) {
  if (error instanceof PolicyDecodeError) {
    highlightField(error.path); // illustrative UI helper
  } else {
    throw error;
  }
}
```

## Validating after decode

`policyFromJson()` answers "can this be represented as a `PolicyConfig`?".
Whether the policy is *sensible* is a separate question with two answers:

- `validateGuardPolicy(policy, options?)` — the hand-maintained SPEC §8 mirror.
- [`validateGuardPolicyAgainstSchema(policy, schema, options?)`](policy-schema.md)
  — the same rules, driven by the vendored JSON Schema.

Both return **every** failure at once. For a policy file on disk,
`loadPolicyFromFile()` from the Node-only `stellar-agent-guard-sdk/fs` subpath
reads, decodes and validates in one call, with distinct `PolicyFileReadError`,
`PolicyDecodeError` and `PolicyValidationError` failures — see the
[troubleshooting entries](../troubleshooting.md#policyfilereaderror).

## See also

- [Policy schema validation](policy-schema.md)
- [API reference](../api-reference.md)
- [Troubleshooting: `PolicyDecodeError`](../troubleshooting.md#policydecodeerror)
