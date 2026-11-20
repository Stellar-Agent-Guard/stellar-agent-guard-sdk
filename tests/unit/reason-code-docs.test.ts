import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  ACCOUNT_STATE_REASONS,
  GUARD_REASON_CODES,
  explainReason,
  reasonMessagesEn,
  type GuardReason,
} from "../../src/reasons.ts";

interface ReasonCodeRow {
  code: number;
  name: string;
  meaning: string;
  trigger: string;
  action: string;
  className: string;
  references: string;
}

function documentedRows(): ReasonCodeRow[] {
  const markdown = readFileSync(resolve(process.cwd(), "docs/reason-codes.md"), "utf8");
  return markdown
    .split("\n")
    .filter((line) => /^\| \d+ \| `[a-z_]+` \|/.test(line))
    .map((line) => {
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
      return {
        code: Number(cells[0]),
        name: (cells[1] ?? "").replace(/^`|`$/g, ""),
        meaning: cells[2] ?? "",
        trigger: cells[3] ?? "",
        action: cells[4] ?? "",
        className: cells[5] ?? "",
        references: cells[6] ?? "",
      };
    });
}

describe("reason-code documentation", () => {
  const rows = documentedRows();

  it("documents every GUARD_REASON_CODES entry exactly once", () => {
    const actual: Record<string, number> = {};
    for (const row of rows) {
      assert.equal(actual[row.name], undefined, `duplicate reason row: ${row.name}`);
      actual[row.name] = row.code;
    }
    assert.deepEqual(actual, { ...GUARD_REASON_CODES });
  });

  it("derives the expected table from source so a new code fails until documented", () => {
    const documented = new Set(rows.map((row) => row.name));
    for (const name of Object.keys(GUARD_REASON_CODES)) {
      assert.ok(documented.has(name), `undocumented reason code: ${name}`);
    }
    assert.equal(rows.length, Object.keys(GUARD_REASON_CODES).length);
  });

  it("keeps meanings and next actions aligned with explainReason()", () => {
    for (const row of rows) {
      const reason = row.name as GuardReason;
      assert.equal(row.code, GUARD_REASON_CODES[reason]);
      assert.equal(row.meaning, explainReason(reason));
      assert.equal(row.action, reasonMessagesEn[reason].remediation);
      assert.ok(row.trigger.length > 20, `trigger too short: ${row.name}`);
      assert.notEqual(row.trigger, row.meaning, `trigger restates meaning: ${row.name}`);
      assert.ok(
        row.references.includes("explainReason()"),
        `missing explainReason link: ${row.name}`,
      );
      assert.ok(
        row.references.includes("reasons.fixture.json#L"),
        `missing contract fixture link: ${row.name}`,
      );
    }
  });

  it("distinguishes account-state refusals from policy refusals", () => {
    for (const row of rows) {
      const isAccountState = (ACCOUNT_STATE_REASONS as readonly string[]).includes(row.name);
      assert.equal(
        row.className,
        isAccountState ? "Account state" : "Policy refusal",
        `wrong class for ${row.name}`,
      );
    }
  });
});
