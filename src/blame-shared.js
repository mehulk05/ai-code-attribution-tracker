// One git-blame pass over the repo, reused by BOTH the AI scan and Team Pulse.
// For each source file it records raw owner line-counts and, separately, the
// counts whose author-time falls within the window (for survival/overwrite).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { listSourceFiles } from './scanner.js';

const ex = promisify(execFile);
const git = async (cwd, args) => (await ex('git', args, { cwd, maxBuffer: 512 * 1024 * 1024 })).stdout;

async function getMasterTarget(repoDir, targetBranch) {
  const candidates = targetBranch ? [targetBranch, `origin/${targetBranch}`] : [];
  candidates.push('origin/master', 'origin/main', 'master', 'main', 'HEAD');
  for (const t of candidates) {
    try { await ex('git', ['rev-parse', '--verify', t], { cwd: repoDir }); return t; } catch {}
  }
  return 'HEAD';
}

// Single source of truth for the analysis window — shared by the blame cache and
// Team Pulse so survival counts line up exactly. `since`/`until` are YYYY-MM-DD.
export function resolveWindow({ windowDays = 30, since, until } = {}) {
  const untilDate = until ? new Date(until + 'T23:59:59') : new Date();
  const sinceDate = since ? new Date(since + 'T00:00:00') : new Date(untilDate.getTime() - windowDays * 86400000);
  const sinceStr = since || sinceDate.toISOString().slice(0, 10);
  const untilStr = until || untilDate.toISOString().slice(0, 10);
  const sinceEpoch = Math.floor(sinceDate.getTime() / 1000);
  const untilEpoch = Math.floor(untilDate.getTime() / 1000);
  const spanDays = Math.max(1, Math.round((untilDate - sinceDate) / 86400000));
  const days = [];
  for (const dd = new Date(sinceDate); dd <= untilDate && days.length < 370; dd.setDate(dd.getDate() + 1)) {
    days.push(dd.toISOString().slice(0, 10));
  }
  return { sinceDate, untilDate, sinceStr, untilStr, sinceEpoch, untilEpoch, spanDays, days };
}

export async function buildBlameCache(repoDir, { windowDays = 30, since, until, branch, onProgress } = {}) {
  const target = await getMasterTarget(repoDir, branch);
  const files = await listSourceFiles(repoDir, target);
  const { sinceEpoch, untilEpoch } = resolveWindow({ windowDays, since, until });
  const cache = new Map(); // file -> { ownerCounts:{email:n}, ownerWindowCounts:{email:n} }

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (onProgress && i % 25 === 0) onProgress(file, i, files.length);
    let out;
    try { out = await git(repoDir, ['blame', '--line-porcelain', target, '--', file]); }
    catch { cache.set(file, { ownerCounts: {}, ownerWindowCounts: {} }); continue; }
    const ownerCounts = {}, ownerWindowCounts = {};
    let email = null, t = 0;
    for (const ln of out.split('\n')) {
      if (ln.startsWith('author-mail ')) email = ln.slice(12).replace(/[<>]/g, '').trim();
      else if (ln.startsWith('author-time ')) t = parseInt(ln.slice(12), 10) || 0;
      else if (ln[0] === '\t' && email) {
        ownerCounts[email] = (ownerCounts[email] || 0) + 1;
        if (t >= sinceEpoch && t <= untilEpoch) ownerWindowCounts[email] = (ownerWindowCounts[email] || 0) + 1;
      }
    }
    cache.set(file, { ownerCounts, ownerWindowCounts });
  }
  return { cache, target, sinceEpoch, files };
}
