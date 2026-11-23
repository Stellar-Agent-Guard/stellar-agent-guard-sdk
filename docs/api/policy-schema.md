# Policy Schema Validation API

`validateGuardPolicyAgainstSchema()` validates a candidate policy against the
**vendored, hash-pinned JSON Schema** for the contract's `PolicyConfig`, plus
the SPEC §8 rules that schema cannot express. It is the schema-driven twin of
the hand-maintained `validateGuardPolicy()`: both speak the same
`PolicyRuleId` vocabulary, and both return every failure at once.

Source: [`src/policy-schema.ts`](../../src/policy-schema.ts). Tests:
[`tests/unit/policy-schema.test.ts`](../../tests/unit/policy-schema.test.ts).

## Exports

| Export | Kind | Description |
| --- | --- | --- |
| `validateGuardPolicyAgainstSchema(policy, schema, options?)` | function | Returns `SchemaPolicyFailure[]`; `[]` means valid. Never throws on bad input. |
| `POLICY_SCHEMA_PATH` | constant | `"tests/fixtures/vendor/policy.schema.json"` — the repo-relative path of the vendored schema. |
| `SCHEMA_DIALECT` | constant | Every JSON Schema keyword the interpreter implements (see [Schema dialect](#schema-dialect)). |
| `SCHEMA_RULE_ID_ANNOTATION` | constant | `"x-policy-rule-id"` — the vendor annotation (see [Rule annotations](#rule-annotations)). |
| `SCHEMA_VS_CODE_RULES` | constant | Data table of which rules the schema enforces and which stay in code, with the reason. |
| `ruleForKeyword(keyword)` | function | Maps a schema keyword to its default `PolicyRuleId`. |
| `ruleFromAnnotation(annotation)` | function | Resolves an `x-policy-rule-id` value; an unknown id falls back to `invalid_type`. |
| `SchemaValidationOptions` | type | `{ guardAddress?: string; maxRecipientEntries?: number }` |
| `SchemaPolicyFailure` | type | `PolicyFailure` plus `keyword` and `schemaPath`. |
| `SchemaKeyword` | type | Union of the `SCHEMA_DIALECT` entries. |

> **`POLICY_SCHEMA_PATH` is a repository path, not a packaged file.** The npm
> tarball ships `dist/` only, so the schema is not readable from
> `node_modules`. The schema is a **parameter** on purpose: the caller decides
> which pinned copy is authoritative (a copy vendored into your own repo, or
> the contracts repo's published file once
> [contracts #61](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-contracts/issues/61)
> lands). Inside this repository the tests read the vendored file's `schema`
> value.

## Usage

Illustrative — `schemaDocument` is the parsed vendored file, and `policy` is a
`PolicyConfig` (for example from [`policyFromJson()`](policy-json.md)):

```ts no-check: illustrative fragment
import { validateGuardPolicyAgainstSchema } from "stellar-agent-guard-sdk";

const failures = validateGuardPolicyAgainstSchema(policy, schemaDocument.schema, {
  guardAddress: GUARD, // enables the self-reference rules
});
for (const f of failures) {
  console.log(`${f.path}: ${f.rule} (${f.keyword} at ${f.schemaPath}) — ${f.message}`);
}
```

Pass the **`schema` value**, not the whole vendored file: the file is a
`{ _provenance, schema }` wrapper, and the wrapper itself is not a schema.

## Validation options

`SchemaValidationOptions` (third argument):

| Option | Default | Effect |
| --- | --- | --- |
| `guardAddress` | none | Guard contract address. When set, the SPEC §8 bullet 10 self-reference rules run: `self_as_asset`, `self_as_recipient`, `self_as_recipient_cap`, `self_as_protocol`. When omitted, those rules are **skipped**, exactly as in `validateGuardPolicy`. Compared by `policyAddressComparisonKey()`, so encoding differences do not hide a match. |
| `maxRecipientEntries` | `256` (SPEC §8 bullet 8) | Maximum entries in each of `recipients`, `blocked_recipients` and `recipient_window_caps`; exceeding it reports `max_recipient_entries_exceeded`. |

For backwards compatibility the third argument may also be a bare string,
which is treated as `{ guardAddress: <string> }`.

## Input values

Integer fields accept the same values as `validateGuardPolicy`: a `bigint`, a
safe-integer `number`, or a base-10 decimal string. A decoded `PolicyConfig`
(bigints) and a hand-written object with string integers validate the same
way.

Two practical consequences of the schema's `additionalProperties: false`:

- **Strip `version` before validating a `PolicyJson` document.** The schema
  describes `PolicyConfig`, which has no `version` field, so passing
  `policyToJson()` output straight in reports `unknown field "version"`.
  Validate the result of `policyFromJson()` instead.
- **Omit absent optional fields; do not set them to `undefined`.** A key that
  is present with the value `undefined` is still an unknown key to the
  `additionalProperties` check.

> **Known schema lag.** The vendored schema predates the per-rule
> `protocols[].paused` flag and `protocol_calls_per_window` (issue #260). A
> policy that sets either is reported as `invalid_type` /
> `additionalProperties` by this validator, while `validateGuardPolicy()` and
> the contract accept it. Use `validateGuardPolicy()` for such policies until
> the schema is refreshed with `npm run vendor:refresh`.

## Schema dialect

The interpreter implements a pinned subset of JSON Schema draft 2020-12 — the
`SCHEMA_DIALECT` constant:

| Keyword | Meaning here |
| --- | --- |
| `$schema`, `title`, `description` | Annotations; ignored. |
| `type` | `object`, `array`, `string`, `boolean`, `null`, `integer` (bigint / safe number / decimal string), or a union array such as `["array", "null"]`. A type failure stops deeper checks on that value. |
| `properties`, `required`, `additionalProperties` | Object structure. `additionalProperties` is only honoured as `false`. `required` treats a key whose value is `undefined` as missing. |
| `items`, `contains` | Array element schema; `contains` holds when at least one element matches. |
| `enum` | Strict-equality membership. |
| `minimum` | Inclusive lower bound, compared after integer coercion. |
| `minLength` | String length lower bound. |
| `allOf`, `if` / `then` / `else` | Composition and conditionals; this is how the §8 cross-field rules are expressed. |
| `x-policy-rule-id` | Vendor annotation (below). |

The dialect is enforced in CI: `tests/unit/policy-schema.test.ts` walks the
vendored schema and fails if it uses any keyword outside `SCHEMA_DIALECT`, so a
refreshed upstream schema that grows a keyword (for example `maximum` or
`pattern`) fails loudly instead of being validated loosely. Ajv was considered
and rejected to keep the SDK at one runtime dependency; the reasoning is in the
module docblock.

## Rule annotations

Every failure carries a `rule` from the shared `PolicyRuleId` vocabulary
(`POLICY_RULE_IDS`). It is chosen in this order:

1. If the schema node that rejected the value carries
   `"x-policy-rule-id": "<id>"`, that id is used (`ruleFromAnnotation`). An id
   that is not in `POLICY_RULE_IDS` falls back to `invalid_type`.
2. Otherwise the keyword's default (`ruleForKeyword`):

| Keyword | Default rule |
| --- | --- |
| `required` | `missing_field` |
| `minimum` | `negative_amount` |
| `type`, `enum`, `minLength`, `pattern`, `additionalProperties`, `contains`, anything else | `invalid_type` |

The vendored schema uses the annotation for the two §8 conditionals, so a
`window_secs` that is too small reports `window_requires_secs` (bullet 2) or
`recipient_cap_requires_window` (bullet 3) instead of the generic
`negative_amount`. Standard JSON Schema validators ignore `x-` keywords, so the
annotation is safe to keep in a file other tools also read.

## Schema-enforced vs code-enforced rules

`SCHEMA_VS_CODE_RULES` is the honest split, expressed as data:

| Enforced by | Rules |
| --- | --- |
| Schema (`keyword` is a schema keyword) | `invalid_type`, `missing_field`, `negative_amount`, `window_requires_secs`, `recipient_cap_requires_window` |
| Code (`keyword` is `"code"` or `"invalid_address"`, `schemaPath` starts with `/code/`) | `invalid_address`, `active_window_inverted`, `empty_vector_noop`, `duplicate_*`, `integer_out_of_range`, `empty_protocol_functions`, `max_recipient_entries_exceeded`, `recipient_conflict`, `self_as_*` |

`empty_vector_noop` is an **advisory**: the policy is shape-valid, but the
contract would never allow a transfer under it (for example an empty `assets`
list). Treat it as a warning in a UI if you need to, but it is reported in the
same list.

## Failure shape

```ts no-check: illustrative fragment
interface SchemaPolicyFailure {
  path: string;       // dotted path, e.g. "recipients[1]"; the root is "policy"
  rule: PolicyRuleId; // shared vocabulary
  message: string;    // human-readable; may change — do not branch on it
  keyword: string;    // schema keyword that fired, or "code" / "invalid_address"
  schemaPath: string; // JSON-pointer-style locator, e.g. "/allOf/0/then/properties/window_secs"
}
```

Paths here are relative to the policy object (`per_tx_cap`), while
[`policyFromJson()`](policy-json.md#error-paths) prefixes them with `policy.`
(`policy.per_tx_cap`).

## Examples

Both examples below are checked against the current output by
`tests/unit/policy-docs.test.ts`.

### Valid example

<!-- doc-example: policy-schema-valid -->
```json
{
  "per_tx_cap": "100",
  "window_secs": "3600",
  "window_cap": "500",
  "assets": ["CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB"],
  "protocols": [],
  "recipients": ["GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH"],
  "allow_any_recipient": false,
  "active_from": "0",
  "active_until": "0",
  "paused": false,
  "dms_grace_secs": "604800"
}
```

`validateGuardPolicyAgainstSchema(policy, schema)` returns `[]`.

### Invalid example

A negative per-transaction cap, a window cap with no window, a duplicated
recipient and an inverted active window:

<!-- doc-example: policy-schema-invalid -->
```json
{
  "per_tx_cap": "-1",
  "window_secs": "0",
  "window_cap": "500",
  "assets": ["CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB"],
  "protocols": [],
  "recipients": [
    "GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH",
    "GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH"
  ],
  "allow_any_recipient": false,
  "active_from": "10",
  "active_until": "5",
  "paused": false,
  "dms_grace_secs": "604800"
}
```

Every failure is reported in one call, schema failures first:

<!-- doc-example: policy-schema-invalid-failures -->
```json
[
  {
    "path": "per_tx_cap",
    "rule": "negative_amount",
    "keyword": "minimum",
    "schemaPath": "/properties/per_tx_cap",
    "message": "per_tx_cap must be >= 0"
  },
  {
    "path": "window_secs",
    "rule": "window_requires_secs",
    "keyword": "minimum",
    "schemaPath": "/allOf/0/then/properties/window_secs",
    "message": "window_secs must be >= 1"
  },
  {
    "path": "recipients[1]",
    "rule": "duplicate_recipient",
    "keyword": "code",
    "schemaPath": "/code/recipients",
    "message": "duplicate address \"GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH\""
  },
  {
    "path": "active_until",
    "rule": "active_window_inverted",
    "keyword": "code",
    "schemaPath": "/code/active_until",
    "message": "active_until must be 0 (no expiration) or strictly greater than active_from"
  }
]
```

## Refreshing the schema

The vendored file's `_provenance` header records the source repo, commit,
SHA-256 digest and refresh protocol. `npm run vendor:refresh` re-fetches it;
the integrity test recomputes the digest, so a hand edit without a digest bump
fails CI.

## See also

- [Policy JSON](policy-json.md)
- [API reference](../api-reference.md)
- [Troubleshooting: `PolicyValidationError`](../troubleshooting.md#policyvalidationerror)
