// Renders the Team Pulse dashboard: home metrics + click-through developer detail.
// The browser logic lives in teampulse-client.js and is injected inline at build
// time (avoids nested-template-literal clashes).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let CLIENT_JS = '';
function clientJs() {
  if (!CLIENT_JS) CLIENT_JS = readFileSync(path.join(__dirname, 'teampulse-client.js'), 'utf8');
  return CLIENT_JS;
}

export function buildTeamPulseHtml(repoName, data) {
  const bootstrap = JSON.stringify({ data, repo: repoName }).replace(/</g, '\\u003c');
  const STYLE = `
:host, .wrap {
  --bg: transparent;
  --panel: #000;
  --panel2: #0a0a0a;
  --line: rgba(255, 255, 255, 0.1);
  --ink: #ededed;
  --muted: #a1a1aa;
  --faint: #71717a;
  --accent: #fff;
  --good: #10b981;
  --warn: #f59e0b;
  --bad: #ef4444;
  --A: #10b981; --B: #84cc16; --C: #f59e0b; --D: #f97316; --F: #ef4444;
  --font-main: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; background: #000; color: var(--ink); font-family: var(--font-main); line-height: 1.5; font-size: 14px; overflow-x: hidden; }
.wrap { max-width: 1400px; margin: 0 auto; padding: 48px 20px 80px; }
a { color: var(--accent); text-decoration: none; transition: all 0.2s; }
a:hover { text-decoration: underline; }
.head { display: flex; justify-content: space-between; align-items: flex-end; flex-wrap: wrap; gap: 10px; border-bottom: 1px solid var(--line); padding-bottom: 24px; margin-bottom: 40px; }
h1 { font-size: 24px; margin: 0; font-weight: 600; letter-spacing: -0.5px; display:flex; align-items:center; gap:8px;}
.sub { color: var(--muted); font-size: 14px; }
.repo { font-family: ui-monospace, monospace; font-size: 13px; background: #111; padding: 4px 10px; border-radius: 6px; color: #fff; border: 1px solid var(--line); }

/* Layouts & Panels */
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; }
.grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin: 32px 0 48px; }
.kpi { background: #000; border: 1px solid var(--line); border-radius: 8px; padding: 24px; transition: border-color 0.2s; }
.kpi:hover { border-color: rgba(255, 255, 255, 0.2); }
.kpi .k { font-size: 13px; color: var(--muted); font-weight: 500; display:flex; align-items:center; gap:8px; margin-bottom: 8px;}
.kpi .v { font-size: 32px; font-weight: 600; letter-spacing: -0.5px; }

.panel { background: #000; border: 1px solid var(--line); border-radius: 8px; padding: 32px; margin: 40px 0; }
h2 { font-size: 16px; margin: 0 0 24px; font-weight: 600; letter-spacing: -0.2px; color: #fff; display: flex; align-items: center; gap: 8px; }

/* Table */
table { width: 100%; border-collapse: collapse; font-size: 14px; }
.scroll { overflow-x: auto; margin-top: 16px; }
th, td { text-align: left; padding: 14px 16px; white-space: nowrap; border-bottom: 1px solid var(--line); }
th { color: var(--faint); font-size: 12px; font-weight: 500; }
td { background: transparent; }
td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
tr.dev-row { cursor: pointer; transition: background 0.1s; }
tr.dev-row:hover td { background: #111; }

/* Badges & Avatars */
.grade { display: inline-flex; width: 28px; height: 28px; align-items: center; justify-content: center; border-radius: 6px; font-weight: 600; font-size: 14px; color: #000; }
.gA { background: var(--A); } .gB { background: var(--B); } .gC { background: var(--C); } .gD { background: var(--D); } .gF { background: var(--F); }

.avatar { display: inline-flex; width: 28px; height: 28px; border-radius: 50%; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; margin-right: 12px; vertical-align: middle; border: 1px solid var(--line); }
.namecell { font-weight: 500; color: #fff; }
.persona { margin-left: 8px; vertical-align: middle; color: var(--muted); }

/* Progress Bars */
.bar-wrap { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.bar { height: 6px; border-radius: 3px; background: #222; overflow: hidden; width: 70px; display: inline-block; }
.bar i { display: block; height: 100%; border-radius: 3px; }

/* Visualizations */
.heat { display: grid; grid-auto-flow: column; grid-template-rows: repeat(7, 12px); gap: 4px; }
.heat .cell { width: 12px; height: 12px; border-radius: 3px; background: #111; border: 1px solid #222; }
.heat .l1 { background: rgba(255, 255, 255, 0.2); border-color: transparent; }
.heat .l2 { background: rgba(255, 255, 255, 0.4); border-color: transparent; }
.heat .l3 { background: rgba(255, 255, 255, 0.7); border-color: transparent; }
.heat .l4 { background: #fff; border-color: transparent; }
.legend { font-size: 12px; color: var(--faint); display: flex; gap: 6px; align-items: center; margin-top: 12px; font-weight: 500; }

.dial-container { position: relative; width: 140px; height: 140px; margin: 0 auto; }
.dial-svg { display: block; width: 140px; height: 140px; transform: rotate(-90deg); }
.dial-bg { fill: none; stroke: #222; stroke-width: 8; }
.dial-fg { fill: none; stroke-width: 8; stroke-linecap: round; transition: stroke-dasharray 1s ease-out; }
.dial-val { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.dial-val .v { font-size: 36px; font-weight: 600; line-height: 1; letter-spacing: -1px; color: #fff; }
.dial-val .l { font-size: 13px; color: var(--muted); margin-top: 4px; font-weight: 500; }
.mgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; margin: 24px 0; }
.mc { background: var(--panel2); border: 1px solid var(--line); border-radius: 8px; padding: 16px; position: relative; overflow: hidden; }
.mc .k { font-size: 11px; color: var(--muted); font-weight: 500; }
.mc .v { font-size: 22px; font-weight: 800; margin-top: 4px; color: #fff; }

.rings { display: flex; flex-wrap: wrap; gap: 30px; margin: 24px 0; justify-content: center; }
.ring-box { display: flex; flex-direction: column; align-items: center; gap: 8px; }
.ring-container { position: relative; width: 70px; height: 70px; }
.ring-svg { display: block; width: 70px; height: 70px; transform: rotate(-90deg); }
.ring-bg { fill: none; stroke: rgba(255,255,255,0.05); stroke-width: 6; }
.ring-fg { fill: none; stroke-width: 6; stroke-linecap: round; }
.ring-val { position: absolute; top: 0; left: 0; width: 70px; height: 70px; display: flex; align-items: center; justify-content: center; font-size: 15px; font-weight: 800; color: #fff; }
.ring-lbl { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; text-align: center; }

.clist td { font-size: 13px; font-family: ui-monospace, monospace; }
.rev { color: var(--bad); font-weight: 700; background: rgba(255, 51, 102, 0.1); padding: 2px 6px; border-radius: 4px; font-size: 11px; margin-left: 8px; }
.hidden { display: none; }
.foot { margin-top: 40px; color: var(--faint); font-size: 12px; text-align: center; border-top: 1px solid var(--line); padding-top: 20px; }
`;

  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + esc(repoName) + ' — Team Pulse (' + data.windowDays + 'd)</title>' +
    '<link rel="preconnect" href="https://fonts.googleapis.com">' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">' +
    '<script src="https://unpkg.com/lucide@latest"></script>' +
    '<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>' +
    '<style>' + STYLE + '</style></head><body><div class="wrap">' +
    '<div class="head"><div><h1>Team Pulse <span style="color:var(--muted);font-weight:400">· last ' + data.windowDays + ' days</span></h1>' +
    '<div class="sub" style="margin-top:6px"><span class="repo">' + esc(repoName) + '</span> &nbsp; branch <code>' + esc(data.branch) + '</code> · since ' + esc(data.since) + ' · generated ' + esc(data.generatedAt) + '</div></div>' +
    '<div class="sub" style="text-align:right">' + data.contributors + ' contributors<br>' + data.totalCommits.toLocaleString() + ' commits · ' + data.totalActiveLOC.toLocaleString() + ' LOC</div></div>' +
    '<div id="home"></div><div id="detail" class="hidden"></div><div class="foot" id="foot"></div>' +
    '</div>' +
    '<script>window.__TP__=' + bootstrap + ';</script>' +
    '<script>' + clientJs() + '</script>' +
    '</body></html>';
}
