#!/usr/bin/env node
/**
 * Clean-consumer check for the packed SDK (issue #329).
 *
 * The consumer is created outside the repository, has no workspace links and
 * installs the tarball with production dependencies only. It then checks the
 * root ESM surface, a framework adapter export, and a TypeScript invocation
 * path against the declarations shipped in that tarball.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = process.cwd();

class PackedInstallFailure extends Error {}

function fail(message: string): never {
  throw new PackedInstallFailure(message);
}

function npm(args: string[], cwd: string): string {
  return execFileSync("npm", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }) as string;
}

function run(): void {
  const workDir = mkdtempSync(join(tmpdir(), "stellar-agent-guard-packed-install-"));
  try {
    const packDir = join(workDir, "pack");
    const consumerDir = join(workDir, "consumer");
    mkdirSync(packDir);
    mkdirSync(consumerDir);

    const packed = JSON.parse(
      npm(["pack", "--ignore-scripts", "--json", "--pack-destination", packDir], ROOT),
    ) as Array<{ filename?: string }> | Record<string, { filename?: string }>;
    const result = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
    const filename = result?.filename;
    if (!filename) fail("npm pack produced no tarball");
    const tarball = join(packDir, filename);

    writeFileSync(
      join(consumerDir, "package.json"),
      JSON.stringify(
        { name: "stellar-agent-guard-clean-consumer", private: true, type: "module" },
        null,
        2,
      ),
    );
    npm(
      [
        "install",
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--prefer-offline",
        tarball,
      ],
      consumerDir,
    );

    const runtimeCheck = [
      `import { writeFileSync, readFileSync } from "node:fs";`,
      `const sdk = await import(${JSON.stringify("stellar-agent-guard-sdk")});`,
      'for (const name of ["invoke", "createLangChainGuardMiddleware", "policyToJson", "decodePolicyJson"]) {',
      '  if (typeof sdk[name] !== "function") throw new Error("missing packed export: " + name);',
      "}",
      'console.log("packed root ESM and adapter exports resolved");',
      "",
      `// ./fs subpath smoke test (issue #496)`,
      `const fsSdk = await import(${JSON.stringify("stellar-agent-guard-sdk/fs")});`,
      'if (typeof fsSdk.loadPolicyFromFile !== "function") {',
      '  throw new Error("missing packed ./fs export: loadPolicyFromFile");',
      "}",
      "const samplePolicy = {",
      "  version: 1,",
      '  per_tx_cap: "1000",',
      '  window_secs: "60",',
      '  window_cap: "150",',
      '  assets: ["CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB"],',
      "  protocols: [],",
      '  recipients: ["GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH"],',
      "  allow_any_recipient: false,",
      '  active_from: "0",',
      '  active_until: "0",',
      "  paused: false,",
      '  dms_grace_secs: "0",',
      "};",
      'writeFileSync("valid-policy.json", JSON.stringify(samplePolicy), "utf8");',
      'const loaded = await fsSdk.loadPolicyFromFile("valid-policy.json");',
      "if (!loaded || loaded.per_tx_cap !== 1000n) {",
      '  throw new Error("loadPolicyFromFile failed to validate and return GuardPolicy from packed tarball");',
      "}",
      'console.log("packed ./fs export resolved and loadPolicyFromFile executed successfully");',
      "",
      `// Assert the root entry still has no node:* import (issue #496)`,
      'const rootCode = readFileSync("node_modules/stellar-agent-guard-sdk/dist/index.js", "utf8");',
      "const nodeImports = rootCode.match(/\\bfrom\\s+[\"']node:[^\"']+[\"']|\\bimport\\s*\\(\\s*[\"']node:[^\"']+[\"']/g) || [];",
      "if (nodeImports.length > 0) {",
      '  throw new Error("root entry dist/index.js leaked node:* imports: " + nodeImports.join(", "));',
      "}",
      'console.log("packed root entry verified free of node:* imports");',
      "",
      `// Assert a non-exported path is refused (issue #496)`,
      "const unexportedPaths = [",
      '  "stellar-agent-guard-sdk/dist/fs.js",',
      '  "stellar-agent-guard-sdk/dist/index.js",',
      '  "stellar-agent-guard-sdk/does-not-exist",',
      "];",
      "for (const unexported of unexportedPaths) {",
      "  try {",
      "    await import(unexported);",
      '    throw new Error("unexported path resolved unexpectedly: " + unexported);',
      "  } catch (err) {",
      '    if (!err || err.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") {',
      '      throw new Error("unexpected error for unexported path " + unexported + ": " + (err && err.message));',
      "    }",
      "  }",
      "}",
      'console.log("non-exported paths correctly refused with ERR_PACKAGE_PATH_NOT_EXPORTED");',
    ].join("\n");
    writeFileSync(join(consumerDir, "runtime-check.mjs"), runtimeCheck);
    execFileSync(process.execPath, ["runtime-check.mjs"], { cwd: consumerDir, stdio: "inherit" });

    writeFileSync(
      join(consumerDir, "typed-invocation.ts"),
      [
        'import { invoke, unsafeContractAddress } from "stellar-agent-guard-sdk";',
        'import type { ContractCall, InvokeParams } from "stellar-agent-guard-sdk";',
        'import { loadPolicyFromFile, type LoadPolicyFromFileOptions } from "stellar-agent-guard-sdk/fs";',
        'import type { GuardPolicy } from "stellar-agent-guard-sdk";',
        "const call: ContractCall = {",
        '  contract: unsafeContractAddress("CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44"),',
        '  fn: "transfer",',
        "  args: [],",
        "};",
        'const typed: Pick<InvokeParams, "call" | "networkPassphrase"> = { call, networkPassphrase: "test" };',
        "const typedInvoke: typeof invoke = invoke;",
        "const fsOptions: LoadPolicyFromFileOptions = { maxRecipientEntries: 10 };",
        'const loadedPolicyPromise: Promise<GuardPolicy> = loadPolicyFromFile("valid-policy.json", fsOptions);',
        "void typed;",
        "void typedInvoke;",
        "void loadedPolicyPromise;",
      ].join("\n") + "\n",
    );
    const tsc = resolve(ROOT, "node_modules/typescript/bin/tsc");
    if (!existsSync(tsc)) fail(`TypeScript compiler not found at ${tsc}; run npm ci first`);
    execFileSync(
      process.execPath,
      [
        tsc,
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--target",
        "ES2023",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "typed-invocation.ts",
      ],
      { cwd: consumerDir, stdio: "inherit" },
    );
    console.log(
      "packed install check OK: production-only consumer imported and typechecked the SDK tarball",
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

try {
  run();
} catch (error) {
  if (error instanceof PackedInstallFailure) {
    console.error(`packed install check FAILED: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
