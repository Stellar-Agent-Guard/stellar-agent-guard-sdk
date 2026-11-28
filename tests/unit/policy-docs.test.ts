/**
 * Doc-example drift guard for docs/api/policy-json.md and docs/api/policy-schema.md
 * (issue #483).
 *
 * Each page marks its examples with `<!-- doc-example: <id> -->` immediately
 * before a fenced block. This suite extracts those blocks and runs them through
 * the real functions, so an example that no longer matches the current output
 * fails here instead of quietly misleading an ops-tooling author.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { PolicyDecodeError } from "../../src/errors.ts";
import { policyFromJson, policyToJson } from "../../src/policy-json.ts";
import type { PolicyRuleId } from "../../src/policy.ts";
import { POLICY_SCHEMA_PATH, validateGuardPolicyAgainstSchema } from "../../src/policy-schema.ts";
import { policyRuleRemediation } from "../../src/reasons.ts";

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

/** The fenced block that follows `<!-- doc-example: id -->`. */
function example(markdown: string, id: string): string {
  const marker = `<!-- doc-example: ${id} -->`;
  const start = markdown.indexOf(marker);
  assert.notEqual(start, -1, `missing doc-example marker ${id}`);
  const match = /```[a-z]*\n([\s\S]*?)\n```/.exec(markdown.slice(start + marker.length));
  assert.ok(match, `doc-example ${id} has no fenced block`);
  return match[1]!;
}

const schema = (JSON.parse(read(POLICY_SCHEMA_PATH)) as { schema: unknown }).schema;

describe("docs/api/policy-json.md examples", () => {
  const page = read("docs/api/policy-json.md");

  it("the valid example is exactly what policyToJson() emits for it", () => {
    const text = example(page, "policy-json-valid");
    const decoded = policyFromJson(text);
    assert.equal(JSON.stringify(policyToJson(decoded), null, 2), text);
  });

  it("the invalid example throws the documented PolicyDecodeError", () => {
    const expected = example(page, "policy-json-invalid-error");
    const [messageLine, pathLine] = expected.split("\n");
    assert.throws(
      () => policyFromJson(example(page, "policy-json-invalid")),
      (error: unknown) => {
        assert.ok(error instanceof PolicyDecodeError);
        assert.equal(`${error.name}: ${error.message}`, messageLine);
        assert.equal(`  path: ${error.path}`, pathLine);
        return true;
      },
    );
  });
});

describe("docs/api/policy-schema.md examples", () => {
  const page = read("docs/api/policy-schema.md");

  it("the valid example produces no failures", () => {
    const policy = JSON.parse(example(page, "policy-schema-valid")) as unknown;
    assert.deepEqual(validateGuardPolicyAgainstSchema(policy, schema), []);
  });

  it("the invalid example produces exactly the documented failures", () => {
    const policy = JSON.parse(example(page, "policy-schema-invalid")) as unknown;
    const expected = JSON.parse(example(page, "policy-schema-invalid-failures")) as Array<{
      path: string;
      rule: PolicyRuleId;
      keyword: string;
      schemaPath: string;
      message: string;
    }>;
    assert.deepEqual(
      validateGuardPolicyAgainstSchema(policy, schema),
      expected.map((failure) => ({
        ...failure,
        remediation: policyRuleRemediation(failure.rule, failure.path),
      })),
    );
  });
});
