import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function fileURLToPath(url: string): string {
  return new URL().pathname;
}
