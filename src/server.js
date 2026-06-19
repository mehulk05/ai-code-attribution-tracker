import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloneRepo, analyze } from './scanner.js';
import { buildHtml, buildJsonData } from './report.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || 4000;

// tiny .env loader (so a hosted instance can carry a default token)
(function loadEnv() {
  const p = path.join(ROOT, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 5e6) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function handleScan(req, res) {
  const raw = await readBody(req);
  let opts;
  try { opts = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'invalid JSON' }); }

  const { repo, branch, name, localPath, auth = {} } = opts;
  if (!repo && !localPath) return send(res, 400, { error: 'Provide a repo URL or a localPath.' });

  // Credentials from the request override the server's env (request is transient, never stored).
  const env = { ...process.env };
  if (auth.token) env.BITBUCKET_TOKEN = auth.token;
  if (auth.username) env.BITBUCKET_USERNAME = auth.username;
  if (auth.appPassword) env.BITBUCKET_APP_PASSWORD = auth.appPassword;
  if (auth.email) env.BITBUCKET_EMAIL = auth.email;
  if (auth.apiToken) env.BITBUCKET_API_TOKEN = auth.apiToken;

  // Set up chunked streaming headers
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Transfer-Encoding': 'chunked',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive'
  });

  const sendProgress = (payload) => {
    res.write(JSON.stringify({ type: 'progress', ...payload }) + '\n');
  };

  let repoDir, repoName;
  try {
    if (localPath) {
      if (!existsSync(localPath)) {
        res.write(JSON.stringify({ type: 'error', error: 'localPath does not exist on the server.' }) + '\n');
        res.end();
        return;
      }
      repoDir = path.resolve(localPath);
      repoName = name || path.basename(repoDir);
      sendProgress({ step: 'init', message: `Scanning local path: ${repoDir}` });
    } else {
      repoName = name || (repo.split('/').pop() || 'repo').replace(/\.git$/, '');
      sendProgress({ step: 'cloning', message: `Cloning Bitbucket repository: ${repoName}...` });
      repoDir = await cloneRepo(repo, env, path.join(ROOT, 'work'), branch);
    }

    sendProgress({ step: 'listing', message: 'Analyzing file tree on master...' });
    
    const a = await analyze(repoDir, {
      onProgress: (file, idx, total) => {
        sendProgress({ step: 'blaming', file: path.basename(file), current: idx, total });
      }
    });

    sendProgress({ step: 'commits', message: 'Processing historical commits for AI heuristic checks...' });

    const finalData = buildJsonData(repoName, a);
    
    res.write(JSON.stringify({
      type: 'complete',
      ok: true,
      repo: repoName,
      summary: finalData.summary,
      perDeveloper: finalData.perDeveloper,
      html: buildHtml(repoName, a)
    }) + '\n');
    res.end();
  } catch (e) {
    res.write(JSON.stringify({ type: 'error', error: e.message }) + '\n');
    res.end();
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      return send(res, 200, readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8'), 'text/html');
    }
    if (req.method === 'POST' && req.url === '/api/scan') return await handleScan(req, res);
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`ai-code-scanner UI → http://localhost:${PORT}`);
});
