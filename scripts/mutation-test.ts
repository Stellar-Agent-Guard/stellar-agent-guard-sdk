import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as ts from "typescript";

type Family = "conditional-boundary" | "boolean-literal" | "negation";
type Status = "killed" | "survived" | "timedOut";

interface Candidate {
  id: string;
  digest: string;
  file: string;
  family: Family;
  line: number;
  column: number;
  original: string;
  replacement: string;
  start: number;
  end: number;
}

interface MutantResult extends Candidate {
  status: Status;
  killedBy: string[];
  durationMs: number;
}

interface Options {
  list: boolean;
  limit: number;
  seed: number;
  timeoutMs: number;
  file?: string | undefined;
  family?: string | undefined;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_DIR = join(ROOT, "coverage", "mutation");
const LOADER_URL = pathToFileURL(join(ROOT, "scripts", "mutation-loader.mjs")).href;

const TARGETS = ["src/preflight.ts", "src/policy.ts", "src/invoke.ts"] as const;
const FAMILIES: Family[] = ["conditional-boundary", "boolean-literal", "negation"];
const TEST_FILES: Record<string, string[]> = {
  "src/preflight.ts": ["tests/unit/preflight.test.ts"],
  "src/policy.ts": [
    "tests/unit/policy.test.ts",
    "tests/unit/policy-vectors.test.ts",
    "tests/unit/default-policy.test.ts",
  ],
  "src/invoke.ts": ["tests/unit/invoke.test.ts", "tests/unit/invoke-dry-run.test.ts"],
};
const SLOW_PREFLIGHT_TESTS =
  "mid-flight abort returns an undetermined verdict promptly|timeoutMs fires a typed RpcTimeoutError";

const TRIAGE: Record<Family, string> = {
  "conditional-boundary": "Add just-below, equal and just-above assertions around this bound.",
  "boolean-literal": "Assert both states of this flag, including the default path.",
  negation: "Assert the negated branch explicitly; a broad happy-path test can mask it.",
};

function parseOptions(argv: string[]): Options {
  const option = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  };
  const numeric = (name: string, fallback: number): number => {
    const value = option(name);
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`--${name} must be positive`);
    return parsed;
  };
  return {
    list: argv.includes("--list"),
    limit: numeric("limit", 60),
    seed: numeric("seed", 489),
    timeoutMs: numeric("timeout", 45_000),
    file: option("file"),
    family: option("family"),
  };
}

function isInTypePosition(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isTypeNode(parent)) return true;
  }
  return false;
}

function candidatesFor(file: string, source: string): Candidate[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const candidates: Candidate[] = [];

  const add = (
    node: ts.Node,
    family: Family,
    original: string,
    replacement: string,
    start: number,
    end: number,
  ): void => {
    const position = sourceFile.getLineAndCharacterOfPosition(start);
    const id = `${file}:${position.line + 1}:${position.character + 1}:${family}:${replacement}`;
    candidates.push({
      id,
      digest: `sha256:${createHash("sha256").update(id).digest("hex")}`,
      file,
      family,
      line: position.line + 1,
      column: position.character + 1,
      original,
      replacement,
      start,
      end,
    });
  };

  const visit = (node: ts.Node): void => {
    const boundaries: Partial<Record<ts.SyntaxKind, string>> = {
      [ts.SyntaxKind.LessThanToken]: "<=",
      [ts.SyntaxKind.LessThanEqualsToken]: "<",
      [ts.SyntaxKind.GreaterThanToken]: ">=",
      [ts.SyntaxKind.GreaterThanEqualsToken]: ">",
    };
    if (ts.isBinaryExpression(node)) {
      const replacement = boundaries[node.operatorToken.kind];
      if (replacement) {
        add(
          node.operatorToken,
          "conditional-boundary",
          node.operatorToken.getText(sourceFile),
          replacement,
          node.operatorToken.getStart(sourceFile),
          node.operatorToken.getEnd(),
        );
      }
    }
    if (
      (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) &&
      !isInTypePosition(node)
    ) {
      add(
        node,
        "boolean-literal",
        node.getText(sourceFile),
        node.kind === ts.SyntaxKind.TrueKeyword ? "false" : "true",
        node.getStart(sourceFile),
        node.getEnd(),
      );
    }
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
      add(node, "negation", "!", "", node.getStart(sourceFile), node.operand.getStart(sourceFile));
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return candidates;
}

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other]!, copy[index]!];
  }
  return copy;
}

function sample(candidates: Candidate[], options: Options): Candidate[] {
  let pool = candidates;
  if (options.file)
    pool = pool.filter((candidate) => candidate.file.endsWith(`${options.file}.ts`));
  if (options.family) pool = pool.filter((candidate) => candidate.family === options.family);
  const random = seeded(options.seed);
  const buckets = TARGETS.flatMap((file) => FAMILIES.map((family) => ({ file, family }))).map(
    ({ file, family }) =>
      shuffle(
        pool.filter((c) => c.file === file && c.family === family),
        random,
      ),
  );
  const chosen: Candidate[] = [];
  while (chosen.length < options.limit && buckets.some((bucket) => bucket.length > 0)) {
    for (const bucket of buckets) {
      const next = bucket.shift();
      if (next) chosen.push(next);
      if (chosen.length >= options.limit) break;
    }
  }
  return chosen;
}

function apply(candidate: Candidate, source: string): string {
  return source.slice(0, candidate.start) + candidate.replacement + source.slice(candidate.end);
}

function runTests(
  env: Record<string, string>,
  testFiles: string[],
  timeoutMs: number,
  skipPreflightTimers: boolean,
): { ok: boolean; timedOut: boolean; killedBy: string[] } {
  const args = ["--import", "tsx", "--import", LOADER_URL, "--test-reporter=tap"];
  if (skipPreflightTimers) args.push("--test-skip-pattern", SLOW_PREFLIGHT_TESTS);
  args.push(...testFiles);
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const spawnError = result.error as NodeJS.ErrnoException | undefined;
  const timedOut = spawnError?.code === "ETIMEDOUT" || result.status === null;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const killedBy = output
    .split("\n")
    .filter((line) => line.startsWith("not ok "))
    .map((line) => line.replace(/^not ok \d+\s*-?\s*/, "").trim())
    .slice(0, 3);
  if (process.env.MUTATION_DEBUG && result.status !== 0) {
    console.error(output);
  }
  return { ok: result.status === 0, timedOut, killedBy };
}

function lineLink(candidate: Candidate): string {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_SHA } = process.env;
  if (GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_SHA) {
    return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/blob/${GITHUB_SHA}/${candidate.file}#L${candidate.line}`;
  }
  return `${candidate.file}#L${candidate.line}`;
}

function collectFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? collectFiles(path) : [path];
  });
}

function writeReports(
  results: MutantResult[],
  options: Options,
  score: number,
  baseline: number | null,
): void {
  mkdirSync(REPORT_DIR, { recursive: true });
  const killed = results.filter((result) => result.status === "killed").length;
  const timedOut = results.filter((result) => result.status === "timedOut").length;
  const survivors = results.filter((result) => result.status === "survived");
  const meta = {
    scoreKind: "deterministic sample",
    seed: options.seed,
    sampleSize: results.length,
    timeoutMs: options.timeoutMs,
    targets: TARGETS,
    families: FAMILIES,
    testFiles: TEST_FILES,
    skippedTests: [SLOW_PREFLIGHT_TESTS],
  };
  const summary = {
    killed,
    timedOut,
    survived: survivors.length,
    score: Number(score.toFixed(4)),
    baseline,
    delta: baseline === null ? null : Number((score - baseline).toFixed(4)),
    informational: true,
    break: null,
  };
  writeFileSync(
    join(REPORT_DIR, "mutation.json"),
    JSON.stringify({ meta, summary, mutants: results }, null, 2) + "\n",
  );

  const shown = survivors.slice(0, 25);
  const survivorLines = [
    "# Surviving mutants",
    "",
    `${survivors.length} of ${results.length} sampled mutants survived. The table is capped at 25 rows; \`mutation.json\` has the full machine-readable list.`,
    "",
    "| Location | Family | Change | Triage hint |",
    "| --- | --- | --- | --- |",
    ...shown.map(
      (result) =>
        `| [${result.file}:${result.line}](${lineLink(result)}) | ${result.family} | \`${result.original}\` → \`${result.replacement}\` | ${TRIAGE[result.family]} |`,
    ),
    "",
    "## Caveats",
    "",
    `- Sample seed ${options.seed}, ${results.length} mutants, ${options.timeoutMs}ms per mutant.`,
    `- These test files were run: ${Object.values(TEST_FILES)
      .flat()
      .map((file) => `\`${file}\``)
      .join(", ")}.`,
    `- The two slow preflight timer tests are skipped to keep the run bounded; survivors may be killed by them locally.`,
    "- Equivalent mutants are possible; confirm a survivor by applying the named change before adding an assertion.",
    "",
  ];
  writeFileSync(join(REPORT_DIR, "survivors.md"), survivorLines.join("\n"));

  const summaryLines = [
    "# Mutation testing (informational)",
    "",
    `Sampled mutation score: **${(score * 100).toFixed(1)}%** (${killed + timedOut}/${results.length} killed, ${survivors.length} survived).`,
    baseline === null
      ? "No baseline recorded yet."
      : `Recorded baseline: ${(baseline * 100).toFixed(1)}% (delta ${((score - baseline) * 100).toFixed(1)} points).`,
    "",
    "This job neither fails CI nor gates a merge. See `survivors.md` for the capped actionable list and `mutation.json` for all samples.",
    "",
  ];
  const text = summaryLines.join("\n");
  writeFileSync(join(REPORT_DIR, "summary.md"), text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  }
  console.log(text);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const sources = new Map<string, string>(
    TARGETS.map((file) => [file, readFileSync(join(ROOT, file), "utf8")]),
  );
  const candidates = TARGETS.flatMap((file) => candidatesFor(file, sources.get(file)!));
  const chosen = sample(candidates, options);
  if (options.list) {
    console.log(`${candidates.length} candidate mutants; ${chosen.length} selected`);
    for (const candidate of chosen) {
      console.log(`${candidate.id} (${candidate.original} → ${candidate.replacement})`);
    }
    return;
  }

  const baselinePath = join(ROOT, "scripts", "mutation.baseline.json");
  const baselineJson = JSON.parse(readFileSync(baselinePath, "utf8")) as { score: number | null };
  mkdirSync(REPORT_DIR, { recursive: true });
  const tempDir = mkdtempSync(join(REPORT_DIR, "tmp-"));
  const tempSrc = join(tempDir, "src");
  cpSync(join(ROOT, "src"), tempSrc, { recursive: true });
  const mutantFiles = new Map<string, string>();
  const mutationMap: Record<string, string> = {};
  for (const file of collectFiles(join(ROOT, "src"))) {
    const relativePath = relative(ROOT, file);
    mutationMap[file] = join(tempDir, relativePath);
  }
  for (const file of TARGETS) {
    const target = join(tempSrc, relative("src", file));
    mutantFiles.set(file, target);
    writeFileSync(target, sources.get(file)!);
  }
  const env = { ...process.env, MUTATION_MAP: JSON.stringify(mutationMap) } as Record<
    string,
    string
  >;

  try {
    const sanityFile = mutantFiles.get("src/policy.ts")!;
    writeFileSync(
      sanityFile,
      `${sources.get("src/policy.ts")!}\nthrow new Error("mutation harness sanity check");\n`,
    );
    const sanity = runTests(env, TEST_FILES["src/policy.ts"]!, options.timeoutMs, false);
    if (sanity.ok)
      throw new Error("mutation harness sanity mutant survived; loader is not redirecting imports");
    writeFileSync(sanityFile, sources.get("src/policy.ts")!);

    const results: MutantResult[] = [];
    for (const candidate of chosen) {
      const source = sources.get(candidate.file)!;
      const target = mutantFiles.get(candidate.file)!;
      writeFileSync(target, apply(candidate, source));
      const started = Date.now();
      let run = runTests(
        env,
        TEST_FILES[candidate.file]!,
        options.timeoutMs,
        candidate.file === "src/preflight.ts",
      );
      if (run.timedOut) {
        run = runTests(
          env,
          TEST_FILES[candidate.file]!,
          options.timeoutMs * 2,
          candidate.file === "src/preflight.ts",
        );
      }
      writeFileSync(target, source);
      const status: Status = run.timedOut ? "timedOut" : run.ok ? "survived" : "killed";
      results.push({
        ...candidate,
        status,
        killedBy: run.killedBy,
        durationMs: Date.now() - started,
      });
    }
    const killed = results.filter((result) => result.status !== "survived").length;
    const score = results.length === 0 ? 0 : killed / results.length;
    await writeReports(results, options, score, baselineJson.score);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(
    `mutation harness FAILED: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
