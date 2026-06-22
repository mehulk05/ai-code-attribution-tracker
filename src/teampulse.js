// Team Pulse — last-30-days per-developer git analytics (git-only).
// Reuses cloneRepo from scanner.js; identity/scope rules from config.js.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { canonicalIdentity, SOURCE_EXTENSIONS, EXCLUDE_PATTERNS } from './config.js';
import { resolveWindow } from './blame-shared.js';

const execFilePromise = promisify(execFile);
const RS = '\x1e', FS = '\x1f'; // record / field separators for safe git parsing

async function git(cwd, args) {
  const { stdout } = await execFilePromise('git', args, { cwd, maxBuffer: 512 * 1024 * 1024 });
  return stdout;
}

async function getMasterTarget(repoDir, targetBranch) {
  const candidates = targetBranch ? [targetBranch, `origin/${targetBranch}`] : [];
  candidates.push('origin/master', 'origin/main', 'master', 'main', 'HEAD');
  for (const t of candidates) {
    try { await execFilePromise('git', ['rev-parse', '--verify', t], { cwd: repoDir }); return t; } catch {}
  }
  return 'HEAD';
}

// Convert the origin remote into a clickable commit base URL (Bitbucket/GitHub/GitLab).
async function getCommitBaseUrl(repoDir, repoName) {
  let url = '';
  try { url = (await git(repoDir, ['remote', 'get-url', 'origin'])).trim(); } catch {}
  
  // If we have an explicit repoName from the server, this is exactly what the user entered
  // e.g. "g99-ui-admin". So we can cleanly construct the Growth99 Bitbucket URL perfectly.
  const nameToUse = repoName || repoDir.split(/[\\/]/).pop().replace(/\.git$/, '');
  const fallbackG99 = `https://bitbucket.org/growth99_plus/${nameToUse}/commits`;

  if (!url) return fallbackG99;
  
  let host = '', repoPath = '', m;
  if ((m = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/))) { host = m[1]; repoPath = m[2]; }
  else if ((m = url.match(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?$/))) { host = m[1]; repoPath = m[2]; }
  else if ((m = url.match(/^https?:\/\/(?:[^@]+@)?([^/]+)\/(.+?)(?:\.git)?$/))) { host = m[1]; repoPath = m[2]; }
  else return fallbackG99;
  
  repoPath = repoPath.replace(/\.git$/, '').replace(/\/+$/, ''); // strip trailing .git and slashes
  const seg = host.includes('bitbucket') ? 'commits' : 'commit'; // bitbucket: /commits/<sha>, github/gitlab: /commit/<sha>
  return `https://${host}/${repoPath}/${seg}`;
}

const isSource = (f) =>
  SOURCE_EXTENSIONS.includes(path.extname(f)) && !EXCLUDE_PATTERNS.some((re) => re.test(f));

const TEST_RE = /\.(test|spec)\.[jt]sx?$|(^|\/)(test|tests|__tests__|spec)\//i;
const dayKey = (iso) => iso.slice(0, 10);

export async function analyze(repoDir, { windowDays = 30, since, until, branch, blameCache = null, onProgress, repoName } = {}) {
  const target = await getMasterTarget(repoDir, branch);
  const commitBaseUrl = await getCommitBaseUrl(repoDir, repoName);
  const W = resolveWindow({ windowDays, since, until });
  const { sinceStr, untilStr, sinceEpoch, untilEpoch, spanDays, days } = W;

  // ── 1. Window commit log with numstat ──────────────────────────────────────
  if (onProgress) onProgress('Reading commit history…');
  const logRaw = await git(repoDir, [
    'log', target, '--no-merges', `--since=${sinceStr}`, `--until=${untilStr}`, '--date=iso-strict',
    `--format=${RS}%H${FS}%an${FS}%ae${FS}%aI${FS}%s`, '--numstat',
  ]);

  // Last-active date per author across ALL history (for the inactive table).
  const lastActive = {};
  try {
    const laRaw = await git(repoDir, ['log', target, '--no-merges', `--format=%ae${FS}%aI`]);
    for (const ln of laRaw.split('\n')) {
      const [ae, aI] = ln.split(FS);
      if (!ae || !aI) continue;
      const id = canonicalIdentity(ae);
      if (id.isBot) continue;
      if (!lastActive[id.name] || aI > lastActive[id.name]) lastActive[id.name] = aI;
    }
  } catch {}

  // new-file map: which (hash,path) are file creations → for refactor-vs-feature
  const newRaw = await git(repoDir, [
    'log', target, '--no-merges', `--since=${sinceStr}`, `--until=${untilStr}`, '--diff-filter=A',
    `--format=${RS}%H`, '--name-only',
  ]);
  const newFiles = new Set();
  for (const chunk of newRaw.split(RS).slice(1)) {
    const lines = chunk.split('\n');
    const hash = lines[0].trim();
    for (const ln of lines.slice(1)) if (ln.trim()) newFiles.add(hash + '::' + ln.trim());
  }

  const hotspotsMap = {};
  const dev = {};   // canonicalName -> stats
  const mk = (name, isBot) => (dev[name] ??= {
    name, isBot, commits: 0, linesAdded: 0, linesDeleted: 0, filesTouched: new Set(),
    activeDays: new Set(), commitSizes: [], hugeCommits: 0, night: 0, weekend: 0,
    newFileLines: 0, editLines: 0, testsTouched: 0,
    timesReverted: 0, revertsAuthored: 0,
    linesOwned: 0, survivingWindow: 0, soleOwnedFiles: 0,
    commitList: [], heat: {}, folders: {},
  });

  const commitMeta = {}; // hash -> {dev, email}
  for (const chunk of logRaw.split(RS).slice(1)) {
    const lines = chunk.split('\n');
    const [hash, , email, aI, subject] = lines[0].split(FS);
    const id = canonicalIdentity(email);
    commitMeta[hash] = { dev: id.name, email };
    if (id.isBot) continue;
    const d = mk(id.name, id.isBot);
    d.commits++;
    const date = dayKey(aI);
    d.activeDays.add(date);
    d.heat[date] = (d.heat[date] || 0) + 1;
    const hour = parseInt(aI.slice(11, 13), 10);
    const wd = new Date(aI).getDay();
    if (hour < 9 || hour >= 19) d.night++;
    if (wd === 0 || wd === 6) d.weekend++;

    let cAdd = 0, cDel = 0;
    for (const ln of lines.slice(1)) {
      const p = ln.split('\t');
      if (p.length < 3 || p[0] === '-') continue;
      const file = p[2];
      if (!isSource(file)) continue;
      const add = parseInt(p[0], 10) || 0, del = parseInt(p[1], 10) || 0;
      cAdd += add; cDel += del;
      d.filesTouched.add(file);

      const folder = file.includes('/') ? file.split('/').slice(0, -1).join('/') : '/';
      d.folders[folder] = (d.folders[folder] || 0) + add + del;
      
      if (!hotspotsMap[file]) hotspotsMap[file] = { file, commits: 0, add: 0, del: 0, devs: new Set() };
      hotspotsMap[file].commits++;
      hotspotsMap[file].add += add;
      hotspotsMap[file].del += del;
      hotspotsMap[file].devs.add(id.name);

      if (TEST_RE.test(file)) d.testsTouched++;
      if (newFiles.has(hash + '::' + file)) d.newFileLines += add; else d.editLines += add;
    }
    d.linesAdded += cAdd; d.linesDeleted += cDel;
    d.commitSizes.push(cAdd);
    if (cAdd > 400) d.hugeCommits++;
    if (subject && /^Revert\b/i.test(subject)) d.revertsAuthored++;
    d.commitList.push({
      hash, short: hash.slice(0, 8), date, subject: subject || '', add: cAdd, del: cDel,
      url: commitBaseUrl ? `${commitBaseUrl}/${hash}` : null, reverted: false,
    });
  }

  // ── 2. Reverts: who got reverted (explicit) ────────────────────────────────
  if (onProgress) onProgress('Detecting reverts…');
  const revRaw = await git(repoDir, ['log', target, `--since=${sinceStr}`, `--until=${untilStr}`, '--grep=This reverts commit', `--format=${RS}%ae${FS}%B`]);
  const revertedShas = [];
  for (const chunk of revRaw.split(RS).slice(1)) {
    const m = chunk.match(/This reverts commit ([0-9a-f]{7,40})/);
    if (m) revertedShas.push(m[1]);
  }
  if (revertedShas.length) {
    try {
      const who = await git(repoDir, ['log', '--no-walk', `--format=%H${FS}%ae`, ...revertedShas]);
      for (const ln of who.split('\n')) {
        const [h, ae] = ln.split(FS);
        if (!ae) continue;
        const id = canonicalIdentity(ae);
        if (!id.isBot && dev[id.name]) dev[id.name].timesReverted++;
        const cl = Object.values(dev).flatMap((d) => d.commitList).find((c) => h && c.hash.startsWith(h.slice(0, 8)));
        if (cl) cl.reverted = true;
      }
    } catch {}
  }

  // ── 3. Ownership (current) → owned lines, survival, bus factor ──────────────
  // Uses the shared blame cache when provided (single pass for AI scan + Team
  // Pulse); otherwise blames here so the module still works standalone.
  let totalActiveLOC = 0, soleOwnedTotal = 0;
  const teamHeat = {};
  for (const d of Object.values(dev)) for (const [k, v] of Object.entries(d.heat)) teamHeat[k] = (teamHeat[k] || 0) + v;

  const applyFile = (ownerCounts, windowCounts) => {
    const fileOwn = {};
    for (const [email, n] of Object.entries(ownerCounts)) {
      const id = canonicalIdentity(email);
      if (id.isBot) continue;
      const d = mk(id.name, id.isBot);
      d.linesOwned += n; totalActiveLOC += n;
      fileOwn[id.name] = (fileOwn[id.name] || 0) + n;
    }
    for (const [email, n] of Object.entries(windowCounts || {})) {
      const id = canonicalIdentity(email);
      if (id.isBot) continue;
      mk(id.name, id.isBot).survivingWindow += n;
    }
    const fileLines = Object.values(fileOwn).reduce((a, b) => a + b, 0);
    if (fileLines > 0) {
      const [topName, topN] = Object.entries(fileOwn).sort((a, b) => b[1] - a[1])[0];
      if (topN / fileLines >= 0.8) { if (dev[topName]) dev[topName].soleOwnedFiles++; soleOwnedTotal++; }
    }
  };

  let srcFiles;
  if (blameCache) {
    if (onProgress) onProgress('Computing ownership from shared blame…');
    srcFiles = [...blameCache.keys()];
    for (const e of blameCache.values()) applyFile(e.ownerCounts, e.ownerWindowCounts);
  } else {
    if (onProgress) onProgress('Computing current ownership (blame)…');
    const filesRaw = await git(repoDir, ['ls-tree', '-r', '--name-only', target]);
    srcFiles = filesRaw.split('\n').filter((f) => f && isSource(f));
    for (let i = 0; i < srcFiles.length; i++) {
      if (onProgress && i % 25 === 0) onProgress(`Blaming ${i}/${srcFiles.length}…`);
      let out;
      try { out = await git(repoDir, ['blame', '--line-porcelain', target, '--', srcFiles[i]]); } catch { continue; }
      const ownerCounts = {}, windowCounts = {};
      let email = null, t = 0;
      for (const ln of out.split('\n')) {
        if (ln.startsWith('author-mail ')) email = ln.slice(12).replace(/[<>]/g, '').trim();
        else if (ln.startsWith('author-time ')) t = parseInt(ln.slice(12), 10) || 0;
        else if (ln[0] === '\t' && email) {
          ownerCounts[email] = (ownerCounts[email] || 0) + 1;
          if (t >= sinceEpoch && t <= untilEpoch) windowCounts[email] = (windowCounts[email] || 0) + 1;
        }
      }
      applyFile(ownerCounts, windowCounts);
    }
  }

  // ── 4. Derive metrics + grade — split ACTIVE (committed in window) vs INACTIVE.
  const expectedActive = Math.max(1, Math.round((spanDays * 5) / 7)); // ~weekdays in range
  // Volume is normalised against the most-owning ACTIVE dev, so a dormant
  // historical owner can't anchor the scale.
  const activeDevs = Object.values(dev).filter((d) => !d.isBot && d.commits > 0);
  const maxOwned = Math.max(1, ...activeDevs.map((d) => d.linesOwned));

  const active = activeDevs.map((d) => {
    const commits = d.commits;
    const avgCommitSize = commits ? Math.round(d.linesAdded / commits) : 0;
    const overwritePct = d.linesAdded > 0 ? Math.max(0, Math.min(1, 1 - d.survivingWindow / d.linesAdded)) : 0;
    const revertRate = commits ? d.timesReverted / commits : 0;
    const featureRatio = (d.newFileLines + d.editLines) > 0 ? d.newFileLines / (d.newFileLines + d.editLines) : 0;
    const nightPct = commits ? d.night / commits : 0;
    const weekendPct = commits ? d.weekend / commits : 0;
    const hugeRatio = commits ? d.hugeCommits / commits : 0;
    const testsRatio = d.filesTouched.size ? d.testsTouched / d.filesTouched.size : 0;

    const survival = 1 - overwritePct;
    const reliability = 1 - Math.min(1, revertRate * 4);
    const consistency = Math.min(1, d.activeDays.size / expectedActive);
    const hygiene = Math.max(0, Math.min(1, 1 - hugeRatio * 0.7 + testsRatio * 0.3));
    const volume = Math.min(1, d.linesOwned / maxOwned);
    const score = Math.round(100 * (0.30 * survival + 0.20 * reliability + 0.20 * consistency + 0.15 * hygiene + 0.10 * volume + 0.05));
    const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : score >= 40 ? 'D' : 'F';

    return {
      name: d.name,
      grade, score: Math.min(100, score),
      subScores: {
        survival: Math.round(survival * 100), reliability: Math.round(reliability * 100),
        consistency: Math.round(consistency * 100), hygiene: Math.round(hygiene * 100),
        volume: Math.round(volume * 100),
      },
      commits, linesAdded: d.linesAdded, linesDeleted: d.linesDeleted, net: d.linesAdded - d.linesDeleted,
      filesTouched: d.filesTouched.size, activeDays: d.activeDays.size, activeRatio: +(d.activeDays.size / spanDays).toFixed(2),
      avgCommitSize, hugeCommits: d.hugeCommits,
      linesOwned: d.linesOwned, ownedSharePct: totalActiveLOC ? +(100 * d.linesOwned / totalActiveLOC).toFixed(1) : 0,
      overwritePct: +(overwritePct * 100).toFixed(1),
      featurePct: +(featureRatio * 100).toFixed(0), refactorPct: +((1 - featureRatio) * 100).toFixed(0),
      nightPct: +(nightPct * 100).toFixed(0), weekendPct: +(weekendPct * 100).toFixed(0),
      timesReverted: d.timesReverted, revertsAuthored: d.revertsAuthored,
      soleOwnedFiles: d.soleOwnedFiles, testsRatio: +(testsRatio * 100).toFixed(0),
      lastActive: lastActive[d.name] ? lastActive[d.name].slice(0, 10) : null,
      heat: d.heat,
      folders: Object.entries(d.folders).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([folder, lines]) => ({ folder, lines })),
      commitList: d.commitList.sort((a, b) => (a.date < b.date ? 1 : -1)),
    };
    // sort by RECENT IMPACT, not all-time ownership
  }).sort((a, b) => b.linesAdded - a.linesAdded || b.commits - a.commits);

  // Inactive: own live code here but no commits in the window (dormant / left / cross-repo).
  const inactive = Object.values(dev)
    .filter((d) => !d.isBot && d.commits === 0 && d.linesOwned > 0)
    .map((d) => ({
      name: d.name,
      linesOwned: d.linesOwned,
      ownedSharePct: totalActiveLOC ? +(100 * d.linesOwned / totalActiveLOC).toFixed(1) : 0,
      soleOwnedFiles: d.soleOwnedFiles,
      lastActive: lastActive[d.name] ? lastActive[d.name].slice(0, 10) : null,
    }))
    .sort((a, b) => b.linesOwned - a.linesOwned);

  const hotspots = Object.values(hotspotsMap)
    .sort((a, b) => b.commits - a.commits || (b.add + b.del) - (a.add + a.del))
    .slice(0, 10)
    .map(h => ({ file: h.file, commits: h.commits, add: h.add, del: h.del, devs: h.devs.size }));

  const totalCommits = active.reduce((s, d) => s + d.commits, 0);
  return {
    windowDays: spanDays, since: sinceStr, until: untilStr, range: `${sinceStr} → ${untilStr}`,
    generatedAt: new Date().toISOString().slice(0, 10),
    branch: target, commitBaseUrl,
    totalActiveLOC, totalCommits, contributors: active.length, inactiveCount: inactive.length,
    soleOwnedTotal, srcFileCount: srcFiles.length,
    days, teamHeat, hotspots,
    perDeveloper: active, // active devs, sorted by recent impact (back-compat key)
    inactive,
  };
}
