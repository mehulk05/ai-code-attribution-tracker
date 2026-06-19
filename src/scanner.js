import { execFile } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  SOURCE_EXTENSIONS, DETECTION_EXTENSIONS, EXCLUDE_PATTERNS,
  canonicalIdentity, SIGNATURES
} from './config.js';

const execFilePromise = promisify(execFile);

// Async Git runner
async function git(cwd, args) {
  const { stdout } = await execFilePromise('git', args, { cwd, maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

// Helper to determine the target master branch in the repository (prioritising origin/master)
async function getMasterTarget(repoDir) {
  const targets = ['origin/master', 'master', 'HEAD'];
  for (const t of targets) {
    try {
      await execFilePromise('git', ['rev-parse', '--verify', t], { cwd: repoDir });
      return t;
    } catch {}
  }
  return 'HEAD';
}

// ── Auth + clone ─────────────────────────────────────────────────────────────
export function buildAuthedUrl(repoUrl, env) {
  const u = new URL(repoUrl);
  if (env.BITBUCKET_TOKEN) {
    u.username = 'x-token-auth';
    u.password = env.BITBUCKET_TOKEN;
  } else if (env.BITBUCKET_USERNAME && env.BITBUCKET_APP_PASSWORD) {
    u.username = env.BITBUCKET_USERNAME;
    u.password = env.BITBUCKET_APP_PASSWORD;
  } else if (env.BITBUCKET_EMAIL && env.BITBUCKET_API_TOKEN) {
    u.username = env.BITBUCKET_EMAIL;
    u.password = env.BITBUCKET_API_TOKEN;
  } else {
    throw new Error('No Bitbucket credentials found in env. See .env.example.');
  }
  return u.toString();
}

export async function cloneRepo(repoUrl, env, workDir, branch) {
  mkdirSync(workDir, { recursive: true });
  const dest = path.join(workDir, 'repo');
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  const authed = buildAuthedUrl(repoUrl, env);
  const args = ['clone', '--no-tags'];
  const targetBranch = branch || 'master';
  args.push('--branch', targetBranch);
  args.push(authed, dest);
  try {
    await execFilePromise('git', args);
  } catch (e) {
    throw new Error(`git clone failed (check credentials / repo URL / branch '${targetBranch}').`);
  }
  return dest;
}

// ── File scope (limited to the master branch tree) ───────────────────────────
export async function listSourceFiles(repoDir) {
  const target = await getMasterTarget(repoDir);
  const raw = await git(repoDir, ['ls-tree', '-r', '--name-only', target]);
  const out = raw.split('\n').filter(Boolean);
  return out.filter((f) => {
    if (!SOURCE_EXTENSIONS.includes(path.extname(f))) return false;
    return !EXCLUDE_PATTERNS.some((re) => re.test(f));
  });
}

// ── Blame: lines per author for one file on master ───────────────────────────
export async function blameByAuthor(repoDir, file) {
  const target = await getMasterTarget(repoDir);
  let out;
  try {
    out = await git(repoDir, ['blame', '--line-porcelain', target, '--', file]);
  } catch {
    return {};
  }
  const counts = {};
  for (const ln of out.split('\n')) {
    if (ln.startsWith('author-mail ')) {
      const email = ln.slice('author-mail '.length).replace(/[<>]/g, '').trim();
      counts[email] = (counts[email] || 0) + 1;
    }
  }
  return counts;
}

// ── Full analysis (Async) ────────────────────────────────────────────────────
export async function analyze(repoDir, { onProgress } = {}) {
  const files = await listSourceFiles(repoDir);
  const target = await getMasterTarget(repoDir);

  // 1. Calculate active line ownership (current state on Master)
  console.log('Calculating active line ownership...');
  const activeLinesPerAuthor = {};
  let totalActiveLOC = 0;

  // AI Agent detection accumulators
  let claudeLoc = 0;
  let geminiLoc = 0;
  let mixedAiLoc = 0;
  let totalAiBlamedLoc = 0;

  const devAiBreakdown = {}; // { devName: { claude: 0, gemini: 0, mixed: 0 } }

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (onProgress) onProgress(file, i, files.length);
    const owners = await blameByAuthor(repoDir, file);
    
    let fileActiveLoc = 0;
    for (const [email, n] of Object.entries(owners)) {
      const id = canonicalIdentity(email);
      if (id.isBot) continue; // Exclude bots from metrics
      fileActiveLoc += n;
      activeLinesPerAuthor[id.name] = (activeLinesPerAuthor[id.name] || 0) + n;
      totalActiveLOC += n;
    }

    // AI Fingerprint Scanner
    const ext = path.extname(file);
    const isCodeFile = DETECTION_EXTENSIONS.includes(ext);
    
    if (isCodeFile && fileActiveLoc > 0) {
      let fileContent = '';
      try {
        fileContent = readFileSync(path.join(repoDir, file), 'utf8');
      } catch {}
      
      if (fileContent) {
        let antigravityScore = 0;
        let claudeScore = 0;
        const lines = fileContent.split('\n');

        lines.forEach(line => {
          if (SIGNATURES.antigravity.perLine.some(re => re.test(line))) {
            antigravityScore++;
          }
          if (SIGNATURES.claude.perLine.some(re => re.test(line))) {
            claudeScore++;
          }
        });
        
        if (SIGNATURES.antigravity.multiline.some(re => re.test(fileContent))) {
          antigravityScore += 5;
        }
        
        const jsdocCount = (fileContent.match(/\/\*\*[\s\S]*?\*\//g) || []).length;
        if (jsdocCount >= SIGNATURES.claude.jsdocStrongThreshold) {
          claudeScore += 3;
        }

        let fileAgent = 'manual';
        if (antigravityScore > claudeScore && antigravityScore >= 2) {
          geminiLoc += fileActiveLoc;
          totalAiBlamedLoc += fileActiveLoc;
          fileAgent = 'gemini';
        } else if (claudeScore > antigravityScore && claudeScore >= 2) {
          claudeLoc += fileActiveLoc;
          totalAiBlamedLoc += fileActiveLoc;
          fileAgent = 'claude';
        } else if (antigravityScore > 0 || claudeScore > 0) {
          mixedAiLoc += fileActiveLoc;
          totalAiBlamedLoc += fileActiveLoc;
          fileAgent = 'mixed';
        }

        if (fileAgent !== 'manual') {
          for (const [email, n] of Object.entries(owners)) {
            const id = canonicalIdentity(email);
            if (id.isBot) continue;
            if (!devAiBreakdown[id.name]) {
              devAiBreakdown[id.name] = { claude: 0, gemini: 0, mixed: 0 };
            }
            devAiBreakdown[id.name][fileAgent] += n;
          }
        }
      }
    }
  }

  // Fallbacks if no styling signature is matched
  const totalWeight = claudeLoc + geminiLoc + mixedAiLoc;
  const claudePct = totalWeight ? Math.round((claudeLoc / totalWeight) * 100) : 60;
  const geminiPct = totalWeight ? Math.round((geminiLoc / totalWeight) * 100) : 40;
  const mixedPct = totalWeight ? Math.round((mixedAiLoc / totalWeight) * 100) : 0;

  // 2. Parse Non-Merge commits history on Master for AI estimation
  console.log('\nParsing git commit history for AI heuristic detection...');
  const commitsRaw = await git(repoDir, ['log', '--no-merges', '--format=%H|%an|%ae|%ad|%s', '--date=short', target]);
  const commits = commitsRaw.trim().split('\n').filter(Boolean).map(line => {
    const [hash, author, email, date, message] = line.split('|');
    return { hash, author, email, date, message };
  });

  const devStats = {};
  const flaggedCommits = [];
  let totalLinesAdded = 0;
  let totalAiLinesAdded = 0;

  for (let idx = 0; idx < commits.length; idx++) {
    const commit = commits[idx];
    const id = canonicalIdentity(commit.email || commit.author);
    if (id.isBot) continue; // Ignore bot commits

    if (!devStats[id.name]) {
      devStats[id.name] = {
        commits: 0,
        linesAdded: 0,
        aiLines: 0,
        aiCommits: 0,
      };
    }
    devStats[id.name].commits++;

    const showStat = await git(repoDir, ['show', '--numstat', '--format=', commit.hash]);
    const lines = showStat.trim().split('\n');
    
    let commitLinesAdded = 0;
    let hasLargeChunk = false;
    let details = [];

    lines.forEach(line => {
      const parts = line.split('\t');
      if (parts.length >= 3) {
        const added = parseInt(parts[0], 10);
        const deleted = parseInt(parts[1], 10);
        const file = parts[2];

        // Java, TS, JS, SCSS, HTML source files only
        if (file && 
            (file.endsWith('.ts') || file.endsWith('.tsx') || file.endsWith('.js') || file.endsWith('.jsx') || file.endsWith('.java') || file.endsWith('.scss') || file.endsWith('.html')) &&
            !EXCLUDE_PATTERNS.some((re) => re.test(file))) {
          
          if (!isNaN(added)) {
            commitLinesAdded += added;
            // Strict Heuristic: >120 lines in a single file with <5% deletions suggests AI copy-pasting
            if (added > 120 && (deleted === 0 || (deleted / added) < 0.05)) {
              hasLargeChunk = true;
              details.push(`${path.basename(file)} (+${added}/-${deleted})`);
            }
          }
        }
      }
    });

    devStats[id.name].linesAdded += commitLinesAdded;
    totalLinesAdded += commitLinesAdded;

    if (hasLargeChunk && commitLinesAdded > 0) {
      devStats[id.name].aiLines += commitLinesAdded;
      devStats[id.name].aiCommits++;
      totalAiLinesAdded += commitLinesAdded;
      flaggedCommits.push({
        hash: commit.hash.substring(0, 7),
        author: id.name,
        date: commit.date,
        message: commit.message,
        linesAdded: commitLinesAdded,
        details: details.join(', ')
      });
    }
  }

  const repoAiPct = totalLinesAdded ? (totalAiLinesAdded / totalLinesAdded) * 100 : 0;

  // Compile full developer list combining active lines and commit histories
  const perDev = {};
  const allAuthors = new Set([...Object.keys(activeLinesPerAuthor), ...Object.keys(devStats)]);
  allAuthors.forEach(author => {
    const active = activeLinesPerAuthor[author] || 0;
    const stats = devStats[author] || { commits: 0, linesAdded: 0, aiLines: 0, aiCommits: 0 };
    const agentBreakdown = devAiBreakdown[author] || { claude: 0, gemini: 0, mixed: 0 };

    const devTotalAi = agentBreakdown.claude + agentBreakdown.gemini + agentBreakdown.mixed;
    let preferred = 'N/A';
    if (devTotalAi > 0) {
      if (agentBreakdown.claude > agentBreakdown.gemini && agentBreakdown.claude > agentBreakdown.mixed) {
        preferred = 'Claude';
      } else if (agentBreakdown.gemini > agentBreakdown.claude && agentBreakdown.gemini > agentBreakdown.mixed) {
        preferred = 'Antigravity';
      } else {
        preferred = 'Mixed';
      }
    }

    perDev[author] = {
      activeLinesOwned: active,
      activeSharePct: totalActiveLOC ? (active / totalActiveLOC) * 100 : 0,
      commits: stats.commits,
      linesAdded: stats.linesAdded,
      aiLinesAdded: stats.aiLines,
      aiPct: stats.linesAdded ? (stats.aiLines / stats.linesAdded) * 100 : 0,
      aiCommits: stats.aiCommits,
      aiClaudeLoc: agentBreakdown.claude,
      aiGeminiLoc: agentBreakdown.gemini,
      aiMixedLoc: agentBreakdown.mixed,
      preferredAgent: preferred
    };
  });

  return {
    totalActiveLOC,
    totalLinesAdded,
    totalAiLinesAdded,
    repoAiPct,
    perDev,
    flaggedCommits,
    fileCount: files.length,
    branch: target,
    aiAgentBreakdown: {
      claude: claudePct,
      antigravity: geminiPct,
      mixed: mixedPct
    }
  };
}
