/**
 * Schema-driven GuardPolicy validation tests (issue #133).
 *
 * The construction here is anti-drift on purpose: expectations for the vendored
 * schema are derived **from the vendored file**, never from a parallel
 * hand-written copy of its rules. The dialect walk pins the interpreter's
 * known-keyword set against what the schema actually uses; the round-trip test
 * validates the contracts repo's own preset JSONs (vendored from
 * `docs/policy-templates.md`, which contracts CI installs through the contract's
 * real `validate_config` path); the integrity test recomputes the vendored
 * file's digest so a hand-edit without a digest bump fails here, in CI.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  POLICY_SCHEMA_PATH,
  SCHEMA_DIALECT,
  SCHEMA_RULE_ID_ANNOTATION,
  SCHEMA_VS_CODE_RULES,
  ruleForKeyword,
  validateGuardPolicyAgainstSchema,
} from "../../src/policy-schema.ts";
import { POLICY_RULE_IDS } from "../../src/policy.ts";

interface VendoredSchemaDoc {
  _provenance: {
    sourceRepo: string;
    sourceCommit: string;
    sourcePath: string;
    digest: string;
    refreshCommand: string;
    upstreamLanded: boolean;
    upstreamIssue: string;
  };
  schema: Record<string, unknown>;
}

async function loadVendoredSchema(): Promise<VendoredSchemaDoc> {
  const path = new URL("../../" + POLICY_SCHEMA_PATH, import.meta.url);
  return JSON.parse(await readFile(path, "utf-8")) as VendoredSchemaDoc;
}

/** Same helper semantics as tests/unit/policy.test.ts, redefined (not imported) so both suites stay independent. */
const TOKEN = "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB";
const GUARD = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
const RECIPIENT = "GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH";

function samplePolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    per_tx_cap: 1000n,
    window_secs: 60n,
    window_cap: 150n,
    assets: [TOKEN],
    protocols: [],
    recipients: [RECIPIENT],
    allow_any_recipient: false,
    active_from: 0n,
    active_until: 0n,
    paused: false,
    dms_grace_secs: 0n,
    ...overrides,
  };
}

describe("policy schema consumption (issue #133)", () => {
  describe("vendored artifact integrity", () => {
    it("carries complete provenance: source repo, pinned commit, path, digest, refresh command", async () => {
      const doc = await loadVendoredSchema();
      const p = doc._provenance;
      assert.equal(p.sourceRepo, "Stellar-Agent-Guard/stellar-agent-guard-contracts");
      assert.match(p.sourceCommit, /^[0-9a-f]{40}$/, "source commit must be a pinned SHA");
      assert.equal(p.sourcePath, "policy.schema.json");
      assert.match(p.digest, /^sha256:[0-9a-f]{64}$/);
      assert.equal(p.refreshCommand, "npm run vendor:refresh");
      assert.equal(p.upstreamIssue, "Stellar-Agent-Guard/stellar-agent-guard-contracts#61");
      // The honest state: vendored ahead of the upstream file's own issue.
      assert.equal(p.upstreamLanded, false);
    });

    it("digest matches the vendored schema bytes (recomputed from the file alone)", async () => {
      const doc = await loadVendoredSchema();
      const canonical = JSON.stringify(doc.schema, null, 2) + "\n";
      const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
      assert.equal(
        doc._provenance.digest,
        `sha256:${digest}`,
        "vendored schema was modified without refreshing its digest — run npm run vendor:refresh (or policy-schema:bootstrap) and commit both together",
      );
    });

    it("schema dialect stays inside the interpreter's known keyword set", async () => {
      const doc = await loadVendoredSchema();
      const known = new Set<string>(SCHEMA_DIALECT);
      const seen = new Set<string>();
      // Keys under `properties` are *field names* of PolicyConfig, not schema
      // keywords — descend into the values without collecting those keys.
      const walk = (node: unknown, insideProperties = false): void => {
        if (Array.isArray(node)) {
          node.forEach((item) => walk(item, insideProperties));
          return;
        }
        if (typeof node !== "object" || node === null) return;
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
          if (!insideProperties) seen.add(key);
          walk(value, key === "properties");
        }
      };
      walk(doc.schema);
      const unknown = [...seen].filter((keyword) => !known.has(keyword));
      assert.deepEqual(
        unknown,
        [],
        `schema uses keywords the zero-dep interpreter does not implement (${unknown.join(", ")}) — extend SCHEMA_DIALECT + evaluateSchema, or adopt ajv with justification (issue #133's dependency decision)`,
      );
    });

    it("every x-policy-rule-id annotation names a rule in the shared vocabulary", async () => {
      const doc = await loadVendoredSchema();
      const ids: string[] = [];
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) {
          node.forEach(walk);
          return;
        }
        if (typeof node !== "object" || node === null) return;
        const annotation = (node as Record<string, unknown>)[SCHEMA_RULE_ID_ANNOTATION];
        if (typeof annotation === "string") ids.push(annotation);
        for (const value of Object.values(node as Record<string, unknown>)) walk(value);
      };
      walk(doc.schema);
      assert.ok(ids.length >= 2, "the §8 bullet 2 and bullet 3 if/then rules must be annotated");
      for (const id of ids) {
        assert.ok(
          (POLICY_RULE_IDS as readonly string[]).includes(id),
          `annotation "${String(id)}" is not in POLICY_RULE_IDS — the two layers must share one rule vocabulary`,
        );
      }
    });

    it("split-table rule ids all exist in the shared vocabulary", () => {
      const concrete = (rule: string): string => rule.replace(/\*$/, "");
      for (const entry of SCHEMA_VS_CODE_RULES.schemaEnforced) {
        assert.ok(
          (POLICY_RULE_IDS as readonly string[]).includes(concrete(entry.rule)),
          `schemaEnforced rule "${entry.rule}" missing from POLICY_RULE_IDS`,
        );
      }
      for (const entry of SCHEMA_VS_CODE_RULES.codeEnforced) {
        const id = concrete(entry.rule);
        // Wildcard rows (duplicate_*, self_as_*) expand to concrete ids.
        const matches = id.endsWith("_")
          ? (POLICY_RULE_IDS as readonly string[]).some((candidate) => candidate.startsWith(id))
          : (POLICY_RULE_IDS as readonly string[]).includes(id);
        assert.ok(matches, `codeEnforced rule "${entry.rule}" has no concrete member in POLICY_RULE_IDS`);
      }
    });
  });

  describe("schema-driven validation", () => {
    it("accepts a valid policy with zero failures", async () => {
      const { schema } = await loadVendoredSchema();
      const failures = validateGuardPolicyAgainstSchema(samplePolicy(), schema);
      assert.deepEqual(failures, []);
    });

    it("rejects non-object policy input via the schema type keyword", async () => {
      const { schema } = await loadVendoredSchema();
      for (const bad of [null, "nope", 42, true, []]) {
        const failures = validateGuardPolicyAgainstSchema(bad, schema);
        assert.ok(failures.length > 0, `expected failures for ${JSON.stringify(bad)}`);
        assert.ok(failures.every((f) => f.path === "policy" || f.path.length > 0));
        assert.ok(failures.some((f) => f.keyword === "type" && f.rule === "invalid_type"));
      }
    });

    it("missing required fields are reported per-field with the required keyword", async () => {
      const { schema } = await loadVendoredSchema();
      const failures = validateGuardPolicyAgainstSchema({}, schema);
      const required = failures.filter((f) => f.keyword === "required");
      assert.ok(required.length >= 11, `expected the 11 PolicyConfig fields, got ${required.length}`);
      for (const field of ["per_tx_cap", "window_secs", "window_cap", "paused", "dms_grace_secs"]) {
        assert.ok(required.some((f) => f.path === field), `missing required report for ${field}`);
        assert.equal(required.find((f) => f.path === field)?.rule, "missing_field");
      }
    });

    it("§8 bullet 1: negative amounts fail with negative_amount via minimum", async () => {
      const { schema } = await loadVendoredSchema();
      const failures = validateGuardPolicyAgainstSchema(samplePolicy({ per_tx_cap: -1n }), schema);
      const hit = failures.find((f) => f.path === "per_tx_cap" && f.rule === "negative_amount");
      assert.ok(hit, JSON.stringify(failures));
      assert.equal(hit.keyword, "minimum");
      assert.match(hit.schemaPath, /\/properties\/per_tx_cap$/);
    });

    it("§8 bullet 2: window_cap > 0 with window_secs = 0 fails via if/then (window_requires_secs)", async () => {
      const { schema } = await loadVendoredSchema();
      const failures = validateGuardPolicyAgainstSchema(
        samplePolicy({ window_cap: 500n, window_secs: 0n }),
        schema,
      );
      const hit = failures.find((f) => f.rule === "window_requires_secs");
      assert.ok(hit, JSON.stringify(failures));
      assert.equal(hit.path, "window_secs");
      assert.equal(hit.keyword, "minimum");
      assert.match(hit.schemaPath, /allOf\/0\/then\/properties\/window_secs$/);
    });

    it("§8 bullet 3: any per-recipient cap > 0 with window_secs = 0 fails (recipient_cap_requires_window)", async () => {
      const { schema } = await loadVendoredSchema();
      const failures = validateGuardPolicyAgainstSchema(
        samplePolicy({
          window_cap: 0n,
          window_secs: 0n,
          recipient_window_caps: [{ recipient: RECIPIENT, cap: 100n }],
        }),
        schema,
      );
      const hit = failures.find((f) => f.rule === "recipient_cap_requires_window");
      assert.ok(hit, JSON.stringify(failures));
      assert.equal(hit.path, "window_secs");
      assert.match(hit.schemaPath, /allOf\/1\/then\/properties\/window_secs$/);
    });

    it("per-recipient caps with window_secs > 0 pass the bullet 3 branch (no false positive)", async () => {
      const { schema } = await loadVendoredSchema();
      const failures = validateGuardPolicyAgainstSchema(
        samplePolicy({
          recipient_window_caps: [{ recipient: RECIPIENT, cap: 100n }],
        }),
        schema,
      );
      assert.deepEqual(failures, []);
    });

    it("window_cap = 0 with window_secs = 0 passes bullet 2 (disabled window is legal)", async () => {
      const { schema } = await loadVendoredSchema();
      const failures = validateGuardPolicyAgainstSchema(
        samplePolicy({ window_cap: 0n, window_secs: 0n }),
        schema,
      );
      assert.deepEqual(failures, []);
    });

    it("wrong primitive types fail with invalid_type", async () => {
      const { schema } = await loadVendoredSchema();
      const failures = validateGuardPolicyAgainstSchema(
        samplePolicy({ paused: "yes", allow_any_recipient: 1, protocols: "not-an-array" }),
        schema,
      );
      for (const field of ["paused", "allow_any_recipient", "protocols"]) {
        assert.ok(
          failures.some((f) => f.path === field && f.rule === "invalid_type"),
          `expected invalid_type for ${field}: ${JSON.stringify(failures)}`,
        );
      }
    });

    it("unknown top-level fields are rejected (additionalProperties: false, matching decodePolicy's strictness)", async () => {
      const { schema } = await loadVendoredSchema();
      const failures = validateGuardPolicyAgainstSchema(
        samplePolicy({ sneaky_extra: true }),
        schema,
      );
      assert.ok(
        failures.some((f) => f.keyword === "additionalProperties" && f.path === "sneaky_extra"),
        JSON.stringify(failures),
      );
    });

    it("protocol fns accept null (any function) and non-empty string arrays; reject empty arrays", async () => {
      const { schema } = await loadVendoredSchema();
      const ok = validateGuardPolicyAgainstSchema(
        samplePolicy({ protocols: [{ contract: TOKEN, fns: null }] }),
        schema,
      );
      assert.deepEqual(ok, []);

      const empty = validateGuardPolicyAgainstSchema(
        samplePolicy({ protocols: [{ contract: TOKEN, fns: [] }] }),
        schema,
      );
      // [] is schema-valid (type check passes); the contract-rejection is the
      // code-enforced empty_protocol_functions advisory.
      assert.ok(
        empty.some((f) => f.rule === "empty_protocol_functions" && f.path === "protocols[0].fns"),
        JSON.stringify(empty),
      );
      // And the schema layer itself did not reject it.
      assert.ok(!empty.some((f) => f.path === "protocols[0].fns" && f.keyword === "type"));
    });

    it("accepts JSON-number and base-10-string integer forms identically (isIntegerLike parity)", async () => {
      const { schema } = await loadVendoredSchema();
      for (const cap of [1000, 1000n, "1000"]) {
        const failures = validateGuardPolicyAgainstSchema(samplePolicy({ per_tx_cap: cap }), schema);
        assert.deepEqual(failures, [], `cap form ${String(cap)} should pass`);
      }
    });
  });

  describe("code-enforced §8 rules (the honest half of the split)", () => {
    it("invalid Stellar addresses fail with invalid_address", async () => {
      const { schema } = await loadVendoredSchema();
      const failures = validateGuardPolicyAgainstSchema(
        samplePolicy({ assets: ["not-a-stellar-address"], recipients: ["also-bad"] }),
        schema,
      );
      assert.ok(failures.some((f) => f.path === "assets[0]" && f.rule === "invalid_address"));
      assert.ok(failures.some((f) => f.path === "recipients[0]" && f.rule === "invalid_address"));
    });

    it("§8 bullet 4: active_until <= active_from (nonzero) fails with active_window_inverted", async () => {
      const { schema } = await loadVendoredSchema();
      const failures = validateGuardPolicyAgainstSchema(
        samplePolicy({ active_from: 100n, active_until: 100n }),
        schema,
      );
      assert.ok(failures.some((f) => f.path === "active_until" && f.rule === "active_window_inverted"));
      const equal = validateGuardPolicyAgainstSchema(
        samplePolicy({ active_from: 100n, active_until: 50n }),
        schema,
      );
      assert.ok(equal.some((f) => f.rule === "active_window_inverted"));
      const zeroOk = validateGuardPolicyAgainstSchema(
        samplePolicy({ active_from: 100n, active_until: 0n }),
        schema,
      );
      assert.deepEqual(zeroOk, []);
    });

    it("§8 bullet 6: duplicates are detected per-list with distinct rule ids", async () => {
      const { schema } = await loadVendoredSchema();
      const failures = validateGuardPolicyAgainstSchema(
        samplePolicy({
          assets: [TOKEN, TOKEN],
          recipients: [RECIPIENT, RECIPIENT],
          blocked_recipients: [GUARD, GUARD],
          protocols: [{ contract: TOKEN, fns: ["swap", "swap"] }],
        }),
        schema,
      );
      assert.ok(failures.some((f) => f.rule === "duplicate_asset" && f.path === "assets[1]"));
      assert.ok(failures.some((f) => f.rule === "duplicate_recipient" && f.path === "recipients[1]"));
      assert.ok(failures.some((f) => f.rule === "duplicate_blocked_recipient" && f.path === "blocked_recipients[1]"));
      assert.ok(failures.some((f) => f.rule === "duplicate_protocol_function" && f.path === "protocols[0].fns[1]"));
    });

    it("§8 bullet 8: recipient-list entry caps enforced with the configured max", async () => {
      const { schema } = await loadVendoredSchema();
      const oversized = Array.from({ length: 5 }, () => RECIPIENT);
      const failures = validateGuardPolicyAgainstSchema(samplePolicy({ recipients: oversized }), schema, {
        maxRecipientEntries: 4,
      });
      assert.ok(
        failures.some((f) => f.rule === "max_recipient_entries_exceeded" && f.path === "recipients"),
        JSON.stringify(failures),
      );
    });

    it("§8 bullet 9: recipient/blocklist intersection fails with recipient_conflict", async () => {
      const { schema } = await loadVendoredSchema();
      const failures = validateGuardPolicyAgainstSchema(
        samplePolicy({ blocked_recipients: [RECIPIENT] }),
        schema,
      );
      assert.ok(failures.some((f) => f.rule === "recipient_conflict"));
    });

    it("§8 bullet 10: guard self-references fail with self_as_* when guardAddress is given", async () => {
      const { schema } = await loadVendoredSchema();
      const failures = validateGuardPolicyAgainstSchema(
        samplePolicy({
          assets: [GUARD],
          recipients: [GUARD],
          protocols: [{ contract: GUARD, fns: null }],
          recipient_window_caps: [{ recipient: GUARD, cap: 1n }],
        }),
        schema,
        { guardAddress: GUARD },
      );
      assert.ok(failures.some((f) => f.rule === "self_as_asset" && f.path === "assets[0]"));
      assert.ok(failures.some((f) => f.rule === "self_as_recipient" && f.path === "recipients[0]"));
      assert.ok(failures.some((f) => f.rule === "self_as_protocol" && f.path === "protocols[0].contract"));
      assert.ok(
        failures.some((f) => f.rule === "self_as_recipient_cap" && f.path === "recipient_window_caps[0].recipient"),
      );
    });

    it("§8 bullet 5: empty vectors produce the shape-valid no-op advisories", async () => {
      const { schema } = await loadVendoredSchema();
      const failures = validateGuardPolicyAgainstSchema(samplePolicy({ assets: [] }), schema);
      assert.ok(failures.some((f) => f.rule === "empty_vector_noop" && f.path === "assets"));
      const recipients = validateGuardPolicyAgainstSchema(
        samplePolicy({ recipients: [], allow_any_recipient: false }),
        schema,
      );
      assert.ok(recipients.some((f) => f.rule === "empty_vector_noop" && f.path === "recipients"));
      // With allow_any_recipient the empty recipients list is fine.
      const allowed = validateGuardPolicyAgainstSchema(
        samplePolicy({ recipients: [], allow_any_recipient: true }),
        schema,
      );
      assert.deepEqual(allowed, []);
    });

    it("accumulates every failure at once (form-UX parity with validateGuardPolicy)", async () => {
      const { schema } = await loadVendoredSchema();
      const invalidPolicy = {
        per_tx_cap: -10n,
        window_secs: 0n,
        window_cap: 100n,
        assets: [],
        protocols: [{ contract: GUARD, fns: [] }],
        recipients: [GUARD],
        allow_any_recipient: false,
        active_from: 500n,
        active_until: 100n,
        paused: false,
        dms_grace_secs: -1n,
      };
      const failures = validateGuardPolicyAgainstSchema(invalidPolicy, schema, { guardAddress: GUARD });
      assert.ok(failures.length >= 7, `expected >= 7 failures, got ${failures.length}`);
      const ruleIds = new Set<string>(failures.map((f) => f.rule));
      for (const rule of [
        "negative_amount",
        "window_requires_secs",
        "empty_vector_noop",
        "self_as_protocol",
        "empty_protocol_functions",
        "self_as_recipient",
        "active_window_inverted",
      ]) {
        assert.ok(ruleIds.has(rule), `expected ${rule} in accumulated failures`);
      }
    });
  });

  describe("round-trip: contracts-repo presets validate against the vendored schema", () => {
    /**
     * Advisory rules are shape-valid policies the contract accepts but an
     * operator should think twice about (§8 bullet 5). They are part of the
     * failure array — form UX shows them — but they are not validity: the
     * contract *installs* these policies (contracts CI proves it). The
     * round-trip asserts the presets produce no failures beyond the advisories
     * their design intentionally carries.
     */
    const ADVISORY_RULES = new Set(["empty_vector_noop"]);

    it("every vendored contract preset is valid — no failures beyond its designed advisories", async () => {
      const { schema } = await loadVendoredSchema();
      const presetsDoc = JSON.parse(
        await readFile(new URL("../fixtures/vendor/policy-presets.json", import.meta.url), "utf-8"),
      ) as {
        _provenance: { sourceRepo: string; sourcePath: string };
        presets: Array<{ name: string; policy: Record<string, unknown> }>;
      };
      assert.equal(presetsDoc._provenance.sourceRepo, "Stellar-Agent-Guard/stellar-agent-guard-contracts");
      assert.equal(presetsDoc._provenance.sourcePath, "docs/policy-templates.md");
      assert.ok(presetsDoc.presets.length >= 4, "all four README presets must be present");

      /** Advisories each preset is *documented* to carry, by name and path. */
      const expectedAdvisories: Record<string, Array<{ path: string; rule: string }>> = {
        "day-trader": [],
        "payments-bot": [],
        // Watch-only + paused: empty assets and recipients are the design
        // (contracts policy-templates.md: "Caps are disabled and the allowlists
        // are empty, so even an unpause without further edits cannot move funds").
        "watch-only": [
          { path: "assets", rule: "empty_vector_noop" },
          { path: "recipients", rule: "empty_vector_noop" },
        ],
        "max-security": [],
      };

      for (const preset of presetsDoc.presets) {
        const failures = validateGuardPolicyAgainstSchema(preset.policy, schema);
        const validity = failures.filter((f) => !ADVISORY_RULES.has(f.rule));
        assert.deepEqual(
          validity,
          [],
          `contract preset "${preset.name}" must be valid per the vendored schema (contracts CI installs this exact JSON through validate_config)`,
        );
        const advisories = failures
          .filter((f) => ADVISORY_RULES.has(f.rule))
          .map((f) => ({ path: f.path, rule: f.rule }));
        assert.deepEqual(
          advisories,
          expectedAdvisories[preset.name] ?? [],
          `preset "${preset.name}" advisories drifted from its documented design`,
        );
      }
    });

    it("a corrupted preset (negative cap) fails, proving the round-trip is not vacuous", async () => {
      const { schema } = await loadVendoredSchema();
      const presetsDoc = JSON.parse(
        await readFile(new URL("../fixtures/vendor/policy-presets.json", import.meta.url), "utf-8"),
      ) as { presets: Array<{ name: string; policy: Record<string, unknown> }> };
      const dayTrader = presetsDoc.presets.find((p) => p.name === "day-trader");
      assert.ok(dayTrader, "day-trader preset must be present");
      const corrupted = { ...dayTrader.policy, per_tx_cap: "-50000" };
      const failures = validateGuardPolicyAgainstSchema(corrupted, schema);
      assert.ok(failures.some((f) => f.path === "per_tx_cap" && f.rule === "negative_amount"));
    });
  });

  describe("rule vocabulary mapping", () => {
    it("maps schema keywords onto the shared rule vocabulary", () => {
      assert.equal(ruleForKeyword("required"), "missing_field");
      assert.equal(ruleForKeyword("minimum"), "negative_amount");
      assert.equal(ruleForKeyword("type"), "invalid_type");
      assert.equal(ruleForKeyword("additionalProperties"), "invalid_type");
    });
  });
});
