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
async function getMasterTarget(repoDir, targetBranch) {
  const targets = targetBranch ? [targetBranch, `origin/${targetBranch}`] : [];
  targets.push('origin/master', 'origin/main', 'master', 'main', 'HEAD');
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
    return u.toString();
  } else if (env.BITBUCKET_USERNAME && env.BITBUCKET_APP_PASSWORD) {
    u.username = env.BITBUCKET_USERNAME;
    u.password = env.BITBUCKET_APP_PASSWORD;
    return u.toString();
  } else if (env.BITBUCKET_EMAIL && env.BITBUCKET_API_TOKEN) {
    u.username = env.BITBUCKET_EMAIL;
    u.password = env.BITBUCKET_API_TOKEN;
    return u.toString();
  }
  // Fall back to original URL if no credentials are provided (e.g. public GitHub or public Bitbucket)
  return repoUrl;
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
export async function listSourceFiles(repoDir, targetBranch) {
  const target = targetBranch || await getMasterTarget(repoDir);
  const raw = await git(repoDir, ['ls-tree', '-r', '--name-only', target]);
  const out = raw.split('\n').filter(Boolean);
  return out.filter((f) => {
    if (!SOURCE_EXTENSIONS.includes(path.extname(f))) return false;
    return !EXCLUDE_PATTERNS.some((re) => re.test(f));
  });
}

// ── Blame: lines per author for one file on master ───────────────────────────
export async function blameByAuthor(repoDir, file, targetBranch) {
  const target = targetBranch || await getMasterTarget(repoDir);
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
export async function analyze(repoDir, { windowDays = 30, since, until, branch, onProgress, llmMode = 'skip', claudeKey = '', geminiKey = '', onLlmProgress, blameCache = null } = {}) {
  const target = await getMasterTarget(repoDir, branch);
  const files = await listSourceFiles(repoDir, target);

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
    const owners = blameCache ? (blameCache.get(file)?.ownerWindowCounts || {}) : await blameByAuthor(repoDir, file, target);
    
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
  const logArgs = ['log', '--no-merges', '--format=%H|%an|%ae|%ad|%s', '--date=short'];
  if (since) logArgs.push(`--since=${since}`);
  else if (windowDays) logArgs.push(`--since=${windowDays}.days.ago`);
  if (until) logArgs.push(`--until=${until}`);
  logArgs.push(target);
  
  const commitsRaw = await git(repoDir, logArgs);
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

        // Count CHURN for any source file (incl. .yaml/.yml/.json specs) so
        // contribution is measured correctly. Apply the AI copy-paste flag ONLY
        // to code we can fingerprint (DETECTION_EXTENSIONS) — never to templated
        // specs/markup, where a big paste isn't meaningfully "AI".
        const ext = '.' + (file.split('.').pop() || '').toLowerCase();
        const isSource = SOURCE_EXTENSIONS.includes(ext);
        const isDetectable = DETECTION_EXTENSIONS.includes(ext);
        if (file && isSource && !EXCLUDE_PATTERNS.some((re) => re.test(file))) {
          if (!isNaN(added)) {
            commitLinesAdded += added;
            // Strict Heuristic: >120 lines in a single file with <5% deletions suggests AI copy-pasting
            if (isDetectable && added > 120 && (deleted === 0 || (deleted / added) < 0.05)) {
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

  // 3. Live LLM Scanning (Optional) — INDEPENDENT of the heuristic.
  // The models receive ONLY raw source code: no heuristic %, no per-dev metrics,
  // no "expected" answer. This makes each model a genuine second opinion instead
  // of an echo of our own number. Per-developer attribution stays on the
  // deterministic blame side (an LLM can't attribute by author from code alone).
  let llmAnalysis = null;
  if (llmMode !== 'skip') {
    if (onLlmProgress) onLlmProgress('Sampling source files for the AI reviewers...');

    // Spread the sample across the repo so it's representative, not just the first few files.
    const detectFiles = files.filter((f) => DETECTION_EXTENSIONS.includes(path.extname(f)));
    const MAX_FILES = 24, PER_FILE_LINES = 140, CHAR_BUDGET = 55000;
    const step = Math.max(1, Math.floor(detectFiles.length / MAX_FILES));
    const samples = [];
    let budget = CHAR_BUDGET;
    for (let i = 0; i < detectFiles.length && samples.length < MAX_FILES && budget > 200; i += step) {
      const f = detectFiles[i];
      try {
        let c = readFileSync(path.join(repoDir, f), 'utf8').split('\n').slice(0, PER_FILE_LINES).join('\n');
        if (c.length > budget) c = c.slice(0, budget);
        budget -= c.length;
        samples.push({ filename: f, content: c });
      } catch {}
    }

    const prompt = `You are a senior code-forensics analyst. Judge ONLY from the source code shown below. You have NOT been given any prior estimate and there is no "correct" number to match — form your own independent assessment from the evidence.

Estimate how much of this codebase was likely written with AI assistance (Claude, Gemini/Antigravity, Copilot, etc.). Weigh stylistic evidence: uniformity of structure, comment patterns and dividers, boilerplate vs bespoke logic, naming consistency, scaffolding/generator artifacts — and weigh counter-evidence of human authorship: misspelled identifiers or filenames, inconsistent formatting/indentation, idiosyncratic hacks, debug leftovers, and copy-paste version drift.

Repository: ${files.length} source files total; ${samples.length} sampled below (a representative spread).

${samples.map((s) => `--- FILE: ${s.filename} ---\n${s.content}`).join('\n\n')}

Return ONLY a valid JSON object (no markdown fences, no preamble, no postamble):
{
  "aiProbability": <number 0-100: your independent estimate of % AI-assisted code>,
  "confidence": "low" | "medium" | "high",
  "codeQualityScore": <number 0-100>,
  "stylisticTells": ["specific AI evidence you actually saw", "..."],
  "humanTells": ["specific human-authorship evidence you actually saw", "..."],
  "summary": "2-3 sentence independent assessment in your own words",
  "recommendation": "one concrete recommendation"
}`;

    llmAnalysis = {};

    if (llmMode === 'claude' || llmMode === 'both') {
      try {
        if (onLlmProgress) onLlmProgress('Contacting Claude for an independent code audit...');
        llmAnalysis.claude = await callClaude(prompt, claudeKey);
        if (onLlmProgress) onLlmProgress('Claude review completed successfully!');
      } catch (err) {
        console.error(err);
        llmAnalysis.claude = { error: err.message };
        if (onLlmProgress) onLlmProgress(`Claude scan failed: ${err.message}`);
      }
    }

    if (llmMode === 'gemini' || llmMode === 'both') {
      try {
        if (onLlmProgress) onLlmProgress('Contacting Gemini for an independent code audit...');
        llmAnalysis.gemini = await callGemini(prompt, geminiKey);
        if (onLlmProgress) onLlmProgress('Gemini review completed successfully!');
      } catch (err) {
        console.error(err);
        llmAnalysis.gemini = { error: err.message };
        if (onLlmProgress) onLlmProgress(`Gemini scan failed: ${err.message}`);
      }
    }
  }

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
    },
    llmAnalysis
  };
}

async function callClaude(prompt, apiKey) {
  const model = process.env.CLAUDE_MODEL || 'claude-opus-4-8';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API call failed: ${res.status} ${errText || res.statusText}`);
  }
  const data = await res.json();
  const text = data.content[0].text;
  const match = text.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : text);
}

async function callGemini(prompt, apiKey) {
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json' }
    })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API call failed: ${res.status} ${errText || res.statusText}`);
  }
  const data = await res.json();
  const text = data.candidates[0].content.parts[0].text;
  const match = text.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : text);
}
