/**
 * Troubleshooting coverage for exported error classes (issue #486).
 *
 * An integrator who only has a class name from a log must find an entry for it
 * in docs/troubleshooting.md. This suite pins that:
 *
 * - every class exported from `src/errors.ts` (scanned from the source text, so
 *   a new `export class …` fails here even before it is re-exported), and every
 *   error class exported from the package root, has a `### \`ClassName\``
 *   heading under "## Error classes";
 * - the heading is the class name alone — messages live in the body so they can
 *   change without breaking links;
 * - each entry's **Retry** advice agrees with `isRetryableHeartbeatFailure()`,
 *   the SDK's own transient-failure predicate.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import * as sdk from "../../src/index.ts";
import { isRetryableHeartbeatFailure } from "../../src/heartbeat.ts";

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

const page = read("docs/troubleshooting.md");
const catalogStart = page.indexOf("\n## Error classes\n");
assert.notEqual(catalogStart, -1, 'docs/troubleshooting.md has no "## Error classes" section');
const catalog = page.slice(catalogStart);

/** `### ...` headings in the catalog, mapped to their section body. */
const sections = new Map<string, string>();
{
  const parts = catalog.split(/\n### /).slice(1);
  for (const part of parts) {
    const newline = part.indexOf("\n");
    const heading = part.slice(0, newline).trim();
    const body = part.slice(newline + 1).split(/\n## /)[0]!;
    sections.set(heading, body);
  }
}

/** Class names declared with `export class` in src/errors.ts. */
const errorsTsClasses = [...read("src/errors.ts").matchAll(/^export class (\w+)/gm)].map(
  (match) => match[1]!,
);

/** Every root export that is an Error constructor (aliases included). */
const rootErrorExports = Object.entries(sdk)
  .filter(
    ([, value]) =>
      typeof value === "function" && (value as { prototype?: unknown }).prototype instanceof Error,
  )
  .map(([name]) => name)
  .sort();

describe("docs/troubleshooting.md error-class entries", () => {
  it("scans a non-trivial set of classes (guards against a broken scan)", () => {
    assert.ok(errorsTsClasses.length >= 10, `only found ${errorsTsClasses.length} classes`);
    assert.ok(errorsTsClasses.includes("GuardError"));
    assert.ok(rootErrorExports.includes("GuardBlockedError"));
  });

  for (const name of new Set([...errorsTsClasses, ...rootErrorExports])) {
    it(`has an entry headed exactly \`${name}\``, () => {
      assert.ok(
        sections.has(`\`${name}\``),
        `add a "### \`${name}\`" entry under "## Error classes" in docs/troubleshooting.md`,
      );
    });
  }

  it("every catalog heading is a bare class name, never message text", () => {
    for (const heading of sections.keys()) {
      assert.match(heading, /^`[A-Z]\w*Error`$/, `heading ${heading} must be the class name only`);
    }
  });

  it("every entry documents extends, messages, stage, retry and a first diagnostic", () => {
    for (const [heading, body] of sections) {
      for (const field of [
        "**Extends:**",
        "**Typical messages:**",
        "**Stage:**",
        "**Retry:**",
        "**First diagnostic:**",
      ]) {
        assert.ok(body.includes(field), `${heading} is missing ${field}`);
      }
    }
  });

  it("Retry advice matches isRetryableHeartbeatFailure()", () => {
    const exports = sdk as unknown as Record<string, unknown>;
    for (const [heading, body] of sections) {
      const name = heading.slice(1, -1);
      const ctor = exports[name] as { prototype: object } | undefined;
      assert.ok(ctor, `${heading} documents a class that is not exported from the package root`);
      const advice = /\*\*Retry:\*\* (Yes|No)\b/.exec(body)?.[1];
      assert.ok(advice, `${heading}: Retry must start with "Yes" or "No"`);
      // instanceof only consults the prototype chain, so a bare instance is enough.
      const retryable = isRetryableHeartbeatFailure(Object.create(ctor.prototype));
      assert.equal(
        advice === "Yes",
        retryable,
        `${heading}: docs say Retry ${advice}, predicate says ${retryable}`,
      );
    }
  });
});
