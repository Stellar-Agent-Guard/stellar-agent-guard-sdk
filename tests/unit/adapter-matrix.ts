/**
 * The shared adapter parity expectations (issues #317 and #458).
 *
 * This module is the single source of truth for the cross-framework conformance
 * matrix *and* for the Markdown table in `docs/api/framework-adapters.md`. The
 * test file turns each row into real adapter invocations; the doc-drift test
 * renders the same rows and requires the exact text to appear in the docs. A
 * row added here therefore exercises all four adapters and changes the docs in
 * the same commit — neither can be updated alone.
 *
 * It is a helper, not a `*.test.ts` file, so the unit-runner glob never executes
 * it directly.
 */
import type { GuardAdapterName } from "../../src/adapters/shared.ts";

export type MatrixVerdict = "admissible" | "blocked" | "undetermined";
export type MatrixMapping = "maps" | "null" | "throws" | "malformed";
export type MatrixMode = "single" | "batch";

/**
 * Adding a new adapter to `GuardAdapterName` breaks this map at compile time,
 * which in turn breaks every table below until the new column is described.
 */
export const ADAPTER_NAMES: Record<GuardAdapterName, true> = {
  langchain: true,
  elizaos: true,
  mcp: true,
  vercelai: true,
};

/** The labels used in the generated docs table, in matrix order. */
export const ADAPTER_LABELS: Record<GuardAdapterName, string> = {
  langchain: "LangChain",
  elizaos: "ElizaOS",
  mcp: "MCP",
  vercelai: "Vercel AI SDK",
};

export const ADAPTER_LIST = Object.keys(ADAPTER_NAMES) as GuardAdapterName[];

export interface AdapterMatrixRow {
  /** Test name and docs row label. */
  name: string;
  /** Which mapper the adapters are configured with. */
  mode: MatrixMode;
  mapping: MatrixMapping;
  /** Interceptor verdicts, one per mapped call when `mapping` is `maps`. */
  verdicts: readonly MatrixVerdict[];
  /** Interceptor throws this typed error instead of returning verdicts. */
  throws?: "blocked" | "undetermined";
  /** Whether the framework handler must never be entered. */
  halts: boolean;
  /** Expected `onDecision` calls. */
  decisions: number;
  /** Expected `onBlocked` calls on adapters that expose the hook. */
  blockedHooks: number;
}

export const ADAPTER_MATRIX: readonly AdapterMatrixRow[] = [
  {
    name: "admissible",
    mode: "single",
    mapping: "maps",
    verdicts: ["admissible"],
    halts: false,
    decisions: 1,
    blockedHooks: 0,
  },
  {
    name: "blocked",
    mode: "single",
    mapping: "maps",
    verdicts: ["blocked"],
    halts: true,
    decisions: 1,
    blockedHooks: 1,
  },
  {
    name: "undetermined",
    mode: "single",
    mapping: "maps",
    verdicts: ["undetermined"],
    halts: true,
    decisions: 1,
    blockedHooks: 1,
  },
  {
    name: "mapping throws",
    mode: "single",
    mapping: "throws",
    verdicts: ["admissible"],
    halts: true,
    decisions: 0,
    blockedHooks: 1,
  },
  {
    name: "mapping malformed",
    mode: "single",
    mapping: "malformed",
    verdicts: ["admissible"],
    halts: true,
    decisions: 0,
    blockedHooks: 1,
  },
  {
    name: "mapping null (not fund-moving)",
    mode: "single",
    mapping: "null",
    verdicts: [],
    halts: false,
    decisions: 0,
    blockedHooks: 0,
  },
  {
    name: "interceptor throws GuardBlockedError",
    mode: "single",
    mapping: "maps",
    verdicts: ["blocked"],
    throws: "blocked",
    halts: true,
    decisions: 1,
    blockedHooks: 1,
  },
  {
    name: "interceptor throws GuardUndeterminedError",
    mode: "single",
    mapping: "maps",
    verdicts: ["undetermined"],
    throws: "undetermined",
    halts: true,
    decisions: 1,
    blockedHooks: 1,
  },
  {
    name: "batch: all admissible",
    mode: "batch",
    mapping: "maps",
    verdicts: ["admissible", "admissible"],
    halts: false,
    decisions: 2,
    blockedHooks: 0,
  },
  {
    name: "batch: one blocked call",
    mode: "batch",
    mapping: "maps",
    verdicts: ["admissible", "blocked"],
    halts: true,
    decisions: 2,
    blockedHooks: 1,
  },
  {
    name: "batch: one undetermined call",
    mode: "batch",
    mapping: "maps",
    verdicts: ["admissible", "undetermined"],
    halts: true,
    decisions: 2,
    blockedHooks: 1,
  },
  {
    name: "batch: empty (not fund-moving)",
    mode: "batch",
    mapping: "maps",
    verdicts: [],
    halts: false,
    decisions: 0,
    blockedHooks: 0,
  },
  {
    name: "batch: mapper throws",
    mode: "batch",
    mapping: "throws",
    verdicts: ["admissible", "admissible"],
    halts: true,
    decisions: 0,
    blockedHooks: 1,
  },
  {
    name: "batch: mapper malformed",
    mode: "batch",
    mapping: "malformed",
    verdicts: ["admissible", "admissible"],
    halts: true,
    decisions: 0,
    blockedHooks: 1,
  },
];

export type AdapterBehavior = Record<GuardAdapterName, string>;

const PASS_BEHAVIOR: AdapterBehavior = {
  langchain: "handler runs; result returned",
  elizaos: "`true`; action stays eligible",
  mcp: "original result returned",
  vercelai: "`execute` runs",
};

const BLOCKED_BEHAVIOR: AdapterBehavior = {
  langchain: "error `ToolMessage`; handler never entered",
  elizaos: "`false`; action filtered out",
  mcp: "`isError: true`; body never entered",
  vercelai: "throws `GuardBlockedError` before `execute`",
};

const UNDETERMINED_BEHAVIOR: AdapterBehavior = {
  langchain: "error `ToolMessage`; handler never entered",
  elizaos: "`false` (fail-closed)",
  mcp: "`isError: true`; body never entered",
  vercelai: "throws `PreFlightUndeterminedError` before `execute`",
};

const MAPPING_FAILURE_BEHAVIOR: AdapterBehavior = {
  langchain: "error `ToolMessage` naming the mapping failure",
  elizaos: "`false`; action filtered out",
  mcp: "`isError: true` naming the mapping failure",
  vercelai: "throws `PreFlightUndeterminedError` with the mapping cause",
};

/** The documented behavior for one row, shared by the docs and the assertions. */
export function behaviorFor(row: AdapterMatrixRow): AdapterBehavior {
  if (row.mapping === "null") return PASS_BEHAVIOR;
  if (row.mapping !== "maps") return MAPPING_FAILURE_BEHAVIOR;
  if (!row.halts) return PASS_BEHAVIOR;
  return row.verdicts.includes("blocked") ? BLOCKED_BEHAVIOR : UNDETERMINED_BEHAVIOR;
}

/** How many contract calls the row's mapper produces (0 = pass-through/halt). */
export function mappedCallCount(row: AdapterMatrixRow): number {
  if (row.mapping !== "maps") return 0;
  return row.mode === "batch" ? row.verdicts.length : 1;
}

/** Whether the row expects `calls`/`verdicts` on an `onBlocked` batch halt. */
export function expectsBatchBlockedPayload(row: AdapterMatrixRow): boolean {
  return row.mode === "batch" && row.halts && row.mapping === "maps";
}

/** Render the authoritative docs table from the same rows the tests execute. */
export function renderAdapterMatrix(): string {
  const columns = [
    "Case",
    "Mapper",
    ...ADAPTER_LIST.map((name) => ADAPTER_LABELS[name]),
    "Handler ran",
  ];
  const lines = [`| ${columns.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`];
  for (const row of ADAPTER_MATRIX) {
    const behavior = behaviorFor(row);
    const mapper =
      row.mode === "single"
        ? "single"
        : `batch (${mappedCallCount(row)} call${mappedCallCount(row) === 1 ? "" : "s"})`;
    lines.push(
      `| \`${row.name}\` | ${mapper} | ${ADAPTER_LIST.map((name) => behavior[name]).join(" | ")} | ${row.halts ? "No" : "Yes"} |`,
    );
  }
  return lines.join("\n");
}
