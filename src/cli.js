#!/usr/bin/env node
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloneRepo, analyze } from './scanner.js';
import { writeJson, writeHtml } from './report.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── tiny .env loader (no dependency) ─────────────────────────────────────────
function loadEnv() {
  const p = path.join(ROOT, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') o.repo = argv[++i];
    else if (a === '--path') o.path = argv[++i];
    else if (a === '--branch') o.branch = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--name') o.name = argv[++i];
    else if (a === '-h' || a === '--help') o.help = true;
  }
  return o;
}

const HELP = `
ai-scan — forensic AI-generated-code estimate for a git repo

USAGE
  ai-scan --repo https://bitbucket.org/<ws>/<repo>.git [--branch main] [--out ./out]
  ai-scan --path /local/clone [--out ./out]            # analyse an existing clone

AUTH (for --repo on private Bitbucket) — set in .env (see .env.example):
  BITBUCKET_TOKEN=...                       (Repository Access Token, recommended)
  BITBUCKET_USERNAME=... BITBUCKET_APP_PASSWORD=...
  BITBUCKET_EMAIL=... BITBUCKET_API_TOKEN=...

OUTPUT
  <out>/report.html   visual dashboard (self-contained)
  <out>/report.json   machine-readable results
`;

(async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.repo && !args.path)) {
    console.log(HELP);
    process.exit(args.help ? 0 : 1);
  }

  const outDir = path.resolve(args.out || path.join(ROOT, 'out'));
  mkdirSync(outDir, { recursive: true });

  let repoDir, repoName;
  if (args.path) {
    repoDir = path.resolve(args.path);
    repoName = args.name || path.basename(repoDir);
    console.log(`Analysing local clone: ${repoDir}`);
  } else {
    repoName = args.name || (args.repo.split('/').pop() || 'repo').replace(/\.git$/, '');
    console.log(`Cloning ${repoName} …`);
    repoDir = cloneRepo(args.repo, process.env, path.join(ROOT, 'work'), args.branch);
    console.log(`Cloned to ${repoDir}`);
  }

  console.log('Scanning files (git blame + fingerprints)…');
  const a = analyze(repoDir, {
    onProgress: (i, n) => process.stdout.write(`\r  ${i}/${n} files`),
  });
  process.stdout.write('\r');

  const jsonPath = writeJson(outDir, repoName, a);
  const htmlPath = writeHtml(outDir, repoName, a);

  console.log(`\n── ${repoName} (Branch: ${a.branch}) ─────────────────────────────`);
  console.log(`  Active Source LOC on Master: ${a.totalActiveLOC.toLocaleString()} across ${a.fileCount} files`);
  console.log(`  Historical Lines Added:      ${a.totalLinesAdded.toLocaleString()}`);
  console.log(`  Estimated AI Lines Added:   ${a.totalAiLinesAdded.toLocaleString()}`);
  console.log(`  AI-assisted Code Ratio:     ${a.repoAiPct.toFixed(1)}%  (Threshold: >120 lines, <5% deletes)`);
  console.log(`  Reports:                    ${path.relative(process.cwd(), htmlPath)}`);
  console.log(`                              ${path.relative(process.cwd(), jsonPath)}`);
})().catch((e) => {
  console.error('\nError:', e.message);
  process.exit(1);
});
