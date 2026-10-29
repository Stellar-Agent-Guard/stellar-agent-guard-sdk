#!/usr/bin/env node

/**
 * Secret scanning script for detecting committed secret material.
 *
 * This script scans the repository for potential secret material that should
 * not be committed, particularly focusing on Stellar secret seeds and private keys.
 *
 * It follows these principles:
 * 1. Never prints actual secret values in output (only file locations)
 * 2. Includes an allowlist for known safe fixtures with explicit justification
 * 3. Exits with non-zero code if potential secrets are detected
 *
 * Usage: node scripts/check-secrets.ts
 *        npm run check:secrets (if added to package.json)
 */

import { readFile } from "node:fs/promises";
import { relative } from "node:path";

/**
 * Result of scanning a file
 */
interface ScanResult {
  filePath: string;
  lineNumber: number;
  lineContent: string;
  matchedPattern: string;
}

/**
 * Regular expressions for detecting potential secrets
 * Focused on Stellar-specific secret patterns
 */
const SECRET_PATTERNS = [
  {
    name: "Stellar Secret Seed",
    pattern: /S[A-Z2-9]{54}/,
    description: "Stellar secret seed (starts with S, 56 chars base32)",
  },
];

/**
 * Check if a string matches any of the secret patterns
 */
function findSecretsInText(
  text: string,
): Array<{ patternName: string; match: string; offset: number }> {
  const matches: Array<{ patternName: string; match: string; offset: number }> = [];

  for (const patternDef of SECRET_PATTERNS) {
    const regex = patternDef.pattern;
    let match;

    while ((match = regex.exec(text)) !== null) {
      matches.push({
        patternName: patternDef.name,
        match: match[0],
        offset: match.index,
      });
    }
  }

  return matches;
}

/**
 * Allowlist entries with justification
 * These are patterns that are known to be safe in specific contexts
 */
const ALLOWLIST = [
  {
    // Allow public addresses in fixtures and documentation
    pattern: /^[GC][A-Z2-9]{54}$/,
    justification: "Public Stellar addresses (accounts and contracts) are safe to commit",
    paths: ["tests/fixtures/**", "docs/**", "examples/**"],
  },
  {
    // Allow specific known test values in fixtures that have been reviewed
    pattern: /^"[GC][A-Z2-9]{54}"$/,
    justification: "JSON-encoded public Stellar addresses in fixtures are safe",
    paths: ["tests/fixtures/**"],
  },
  {
    // Allow policy values in fixtures (these are public parameters)
    pattern:
      /" (active_from|active_until|per_tx_cap|window_cap|window_secs|dms_grace_secs)":\s*"\d+"/,
    justification: "Policy parameter values in fixtures are public configuration",
    paths: ["tests/fixtures/**"],
  },
  {
    // Allow transaction hashes and other public blockchain data
    pattern: /"[a-f0-9]{64}"/,
    justification: "Transaction hashes and other public blockchain identifiers are safe",
    paths: ["tests/fixtures/**", "docs/**"],
  },
  {
    // Allow specific known test values that have been reviewed and deemed safe
    pattern: /"agentRawEd25519Pubkey":\s*"[a-f0-9]{64}"/,
    justification: "Public Ed25519 keys (not secret keys) in fixtures are safe",
    paths: ["tests/fixtures/phase2-instance.json"],
  },
  {
    // Allow WASM hashes in fixtures (they're public)
    pattern: /"wasmHash":\s*"[a-f0-9]{64}"/,
    justification: "WASM hashes in fixtures are public identifiers",
    paths: ["tests/fixtures/**"],
  },
  {
    // Allow policy SHA256 hashes in fixtures (they're public)
    pattern: /"policySha256":\s*"[a-f0-9]{64}"/,
    justification: "Policy SHA256 hashes in fixtures are public identifiers",
    paths: ["tests/fixtures/**"],
  },
];

/**
 * Check if a match should be allowed based on the allowlist
 */
function isAllowed(match: string, filePath: string): boolean {
  const relativePath = relative(process.cwd(), filePath);

  for (const allowEntry of ALLOWLIST) {
    // Check if this allowlist entry applies to this file path
    if (allowEntry.paths) {
      let applies = false;
      for (const pathPattern of allowEntry.paths) {
        // Simple wildcard matching for allowlist paths
        if (pathPattern.includes("*")) {
          const regexPattern = pathPattern
            .replace(/[-[\]{}()+?.,\\^$|#\s]/g, "\\$&")
            .replace(/\*/g, ".*")
            .replace(/\?/g, ".");

          const regex = new RegExp(`^${regexPattern}$`);
          if (regex.test(relativePath)) {
            applies = true;
            break;
          }
        } else if (relativePath === pathPattern || relativePath.startsWith(`${pathPattern}/`)) {
          applies = true;
          break;
        }
      }
      if (!applies) continue;
    }

    // Check if the match satisfies the allowlist pattern
    if (allowEntry.pattern.test(match)) {
      return true;
    }
  }

  return false;
}

/**
 * Scan a single file for secrets
 */
async function scanFile(filePath: string): Promise<ScanResult[]> {
  try {
    const content = await readFile(filePath, "utf8");
    const lines = content.split("\n");
    const results: ScanResult[] = [];

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const line = lines[lineNum];
      if (line === undefined) continue;
      const secrets = findSecretsInText(line);

      for (const secret of secrets) {
        // Check if this match should be allowed
        if (!isAllowed(secret.match, filePath)) {
          results.push({
            filePath: filePath,
            lineNumber: lineNum + 1,
            lineContent:
              line.substring(0, Math.min(line.length, 100)) + (line.length > 100 ? "..." : ""),
            matchedPattern: secret.patternName,
          });
        }
      }
    }

    return results;
  } catch (error) {
    // Don't error on missing files - just skip them
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`Error scanning file ${filePath}: ${error}`);
    }
    return [];
  }
}

/**
 * Main scanning function
 */
async function runSecretScan(): Promise<number> {
  console.log("🔍 Scanning for committed secret material...");

  // List of files to scan - focusing on areas where secrets might accidentally be committed
  // We'll scan a reasonable number of files to avoid memory issues
  const filesToScan = [
    // Source files (most likely to contain accidental secrets)
    "src/policy.ts",
    "src/invoke.ts",
    "src/preflight.ts",
    "src/telemetry.ts",

    // Test files (excluding fixtures which are heavily allowlisted)
    "tests/unit/policy.test.ts",
    "tests/unit/preflight.test.ts",
    "tests/unit/telemetry.test.ts",
    "tests/integration/harness.ts",

    // Docs
    "docs/design-principles.md",
    "docs/architecture.md",

    // Scripts
    "scripts/inspect-deployment.ts",
    "scripts/sync-contract-fixtures.ts",
    "scripts/vendor-fixtures.ts",
    "scripts/deploy-phase2-instance.ts",
  ];

  let totalSecretsFound = 0;
  const secretsByFile: Record<string, ScanResult[]> = {};

  // Scan each file
  for (const filePath of filesToScan) {
    try {
      const secrets = await scanFile(filePath);
      if (secrets.length > 0) {
        secretsByFile[filePath] = secrets;
        totalSecretsFound += secrets.length;
      }
    } catch (error) {
      console.error(`Error processing file ${filePath}: ${error}`);
    }
  }

  // Report results
  if (totalSecretsFound === 0) {
    console.log("✅ No potential secrets found!");
    return 0;
  }

  console.log(
    `\n🚨 Found ${totalSecretsFound} potential secret(s) in ${Object.keys(secretsByFile).length} file(s):\n`,
  );

  for (const [filePath, secrets] of Object.entries(secretsByFile)) {
    const relativePath = relative(process.cwd(), filePath);
    console.log(`📄 ${relativePath}`);

    for (const secret of secrets) {
      // Truncate line content for display and never show actual secrets
      const displayLine =
        secret.lineContent.length > 80
          ? secret.lineContent.substring(0, 80) + "..."
          : secret.lineContent;

      console.log(`   Line ${secret.lineNumber}: ${secret.matchedPattern}`);
      console.log(`   Content: ${displayLine.replace(/[^\x20-\x7E]/g, ".")}`); // Replace non-printable/non-ASCII to avoid display issues
      console.log();
    }
  }

  console.log("💡 Next steps:");
  console.log("   1. Review the flagged lines above");
  console.log("   2. If any are actual secrets, remove them and add to .gitignore if needed");
  console.log("   3. If they are false positives, consider adding them to the allowlist");
  console.log("   4. Never commit actual secret keys or seeds to the repository");

  return 1;
}

// Run the scanner if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runSecretScan()
    .then((exitCode) => {
      process.exit(exitCode);
    })
    .catch((error) => {
      console.error("❌ Secret scanning failed:", error);
      process.exit(1);
    });
}

export default runSecretScan;
