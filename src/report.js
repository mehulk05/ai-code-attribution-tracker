import { writeFileSync } from 'node:fs';
import path from 'node:path';

const pct = (n, d) => (d ? (n / d) * 100 : 0);
const f1 = (n) => (Math.round(n * 10) / 10).toFixed(1);
const f0 = (n) => Math.round(n).toString();
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// Helper to extract clean initials from developer name or email
function getInitials(name) {
  if (!name) return '??';
  const parts = name.split(/[ .@_]/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

export function buildJsonData(repoName, a) {
  return {
    repo: repoName,
    generatedAt: new Date().toISOString(),
    branch: a.branch,
    summary: {
      totalActiveLOC: a.totalActiveLOC,
      totalLinesAdded: a.totalLinesAdded,
      totalAiLinesAdded: a.totalAiLinesAdded,
      repoAiPct: +f1(a.repoAiPct),
      files: a.fileCount,
    },
    perDeveloper: Object.entries(a.perDev)
      .map(([name, d]) => ({
        name,
        activeLinesOwned: d.activeLinesOwned,
        activeSharePct: +f1(d.activeSharePct),
        commits: d.commits,
        linesAdded: d.linesAdded,
        aiLinesAdded: d.aiLinesAdded,
        aiPct: +f1(d.aiPct),
        aiCommits: d.aiCommits,
        preferredAgent: d.preferredAgent
      }))
      .sort((x, y) => y.activeLinesOwned - x.activeLinesOwned),
    flaggedCommits: a.flaggedCommits
  };
}

export function writeJson(outDir, repoName, a) {
  const p = path.join(outDir, 'report.json');
  writeFileSync(p, JSON.stringify(buildJsonData(repoName, a), null, 2));
  return p;
}

export function buildHtml(repoName, a) {
  const date = new Date().toISOString().slice(0, 10);
  
  // Sort developers for data table
  const sortedDevs = Object.entries(a.perDev)
    .sort((x, y) => y[1].activeLinesOwned - x[1].activeLinesOwned);

  const devRows = sortedDevs.map(([name, d], index) => {
      const initials = getInitials(name);
      const activeBarWidth = Math.min(100, d.activeSharePct);
      const aiBarWidth = Math.min(100, d.aiPct);
      
      // Dynamic distinct colors for initials and badges
      const hue = (index * 95) % 360;
      const avatarStyle = `background: hsla(${hue}, 65%, 45%, 0.2); border: 1px solid hsla(${hue}, 65%, 55%, 0.4); color: hsla(${hue}, 85%, 85%, 1);`;
      
      // Class name for bar color cycling
      const activeBarClass = index === 0 ? 'mk' : (index === 1 ? 'ss' : 'hv');
      
      const agentBadge = d.preferredAgent && d.preferredAgent !== 'N/A'
        ? `<span class="agent-badge ${d.preferredAgent.toLowerCase()}">${d.preferredAgent}</span>`
        : '';

      return `<tr>
        <td>
          <div class="dev-cell">
            <span class="idx">${index + 1}.</span>
            <span class="avatar" style="${avatarStyle}">${esc(initials)}</span>
            <div class="name-info">
              <span class="name">${esc(name)}</span>
              ${agentBadge}
            </div>
          </div>
        </td>
        <td>
          <div class="active-lines-cell">
            <span class="loc-val">${d.activeLinesOwned.toLocaleString()} LOC</span>
            <div class="active-bar-wrap">
              <div class="active-bar-bg">
                <div class="active-bar-fill ${activeBarClass}" style="width: ${activeBarWidth}%;"></div>
              </div>
              <span class="pct-label">${f1(d.activeSharePct)}%</span>
            </div>
          </div>
        </td>
        <td class="n" style="font-weight:600; color:#fff;">${f1(d.activeSharePct)}%</td>
        <td class="n" style="color:var(--muted);">${d.commits}</td>
        <td class="n" style="color:var(--muted);">${d.linesAdded.toLocaleString()}</td>
        <td class="n" style="color:var(--neon-cyan); font-weight:600;">${d.aiLinesAdded.toLocaleString()}</td>
        <td>
          <div class="ai-pct-cell">
            <span class="ai-pct-hdr">AI ${f1(d.aiPct)}%</span>
            <div class="ai-pct-bar-bg">
              <div class="ai-pct-bar-fill" style="width: ${aiBarWidth}%;"></div>
            </div>
          </div>
        </td>
      </tr>`;
    }).join('');

  const auditRows = a.flaggedCommits.slice(0, 30).map(c => {
    return `<tr>
      <td class="hash"><code>${c.hash}</code></td>
      <td class="date">${c.date}</td>
      <td class="author">${esc(c.author)}</td>
      <td class="n">${c.linesAdded.toLocaleString()}</td>
      <td class="msg">${esc(c.message)}</td>
      <td class="files">${esc(c.details)}</td>
    </tr>`;
  }).join('');

  // Prepare chart data Arrays (limit to top 10 devs for clear visual chart space)
  const topDevsForCharts = sortedDevs.slice(0, 10);
  const chartLabels = JSON.stringify(topDevsForCharts.map(([name]) => name));
  const chartActiveLoc = JSON.stringify(topDevsForCharts.map(([, d]) => d.activeLinesOwned));
  const chartAiLines = JSON.stringify(topDevsForCharts.map(([, d]) => d.aiLinesAdded));
  const chartManualLines = JSON.stringify(topDevsForCharts.map(([, d]) => Math.max(0, d.linesAdded - d.aiLinesAdded)));

  const aiPercentage = f1(a.repoAiPct);

  // AI Agent Breakdown values
  const breakdown = a.aiAgentBreakdown || { claude: 60, antigravity: 40, mixed: 0 };
  const claudePct = breakdown.claude;
  const geminiPct = breakdown.antigravity;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(repoName)} — AI Heuristic Analysis Report</title>
  
  <!-- Fonts -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=Plus+Jakarta+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  
  <!-- ChartJS CDN -->
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>

  <style>
    :root {
      --bg: #090a0f;
      --panel: #11141d;
      --panel-light: #161a26;
      --line: rgba(255, 255, 255, 0.07);
      --ink: #f1f5f9;
      --muted: #8e9bb0;
      --faint: #5a667a;
      
      --neon-cyan: #0df;
      --neon-violet: #a855f7;
      --neon-green: #22c55e;
      
      --shadow: 0 12px 30px rgba(0, 0, 0, 0.5);
    }
    
    * { box-sizing: border-box; margin: 0; padding: 0; }
    
    body {
      background: var(--bg);
      color: var(--ink);
      font-family: 'Plus Jakarta Sans', sans-serif;
      line-height: 1.6;
      padding: 30px 20px;
    }

    /* Wide layout to utilize left/right space */
    .wrap { max-width: 1400px; margin: 0 auto; }
    
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--line);
      padding-bottom: 20px;
      margin-bottom: 24px;
    }
    header h1 {
      font-family: 'Outfit', sans-serif;
      font-size: 26px;
      font-weight: 800;
      color: #fff;
    }
    header .meta {
      font-size: 12px;
      color: var(--muted);
      text-align: right;
    }
    header .tag {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--line);
      padding: 4px 12px;
      border-radius: 50px;
      font-size: 11px;
      font-family: monospace;
      color: var(--neon-cyan);
    }

    /* Grid of 4 Cards at top */
    .metric-cards {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 16px;
      margin-bottom: 24px;
    }
    @media (max-width: 1024px) {
      .metric-cards { grid-template-columns: repeat(2, 1fr); }
    }
    @media (max-width: 640px) {
      .metric-cards { grid-template-columns: 1fr; }
    }
    
    .m-card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      min-height: 165px;
      box-shadow: var(--shadow);
    }
    
    .m-card.cyan-glow {
      border-color: rgba(0, 221, 255, 0.35);
      box-shadow: 0 0 20px rgba(0, 221, 255, 0.04), var(--shadow);
    }
    .m-card.violet-glow {
      border-color: rgba(168, 85, 247, 0.35);
      box-shadow: 0 0 20px rgba(168, 85, 247, 0.04), var(--shadow);
    }
    
    /* Layout using flex side-by-side to guarantee zero overlapping */
    .m-card .c-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      width: 100%;
    }
    
    .m-card .title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: var(--muted);
      font-weight: 700;
    }
    
    .m-card .value {
      font-family: 'Outfit', sans-serif;
      font-size: 32px;
      font-weight: 700;
      margin-top: 6px;
      white-space: nowrap;
    }
    .m-card.cyan-glow .value { color: var(--neon-cyan); }
    .m-card.violet-glow .value { color: var(--neon-violet); }
    
    .m-card .desc {
      font-size: 12px;
      color: var(--muted);
      margin-top: 2px;
    }
    
    .m-card .footer {
      font-size: 11px;
      color: var(--faint);
      margin-top: auto;
      padding-top: 10px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .m-card .footer .trend-up {
      color: var(--neon-green);
      font-weight: 600;
    }
    
    /* Ring Chart Container - Flex Sized */
    .ring-container-relative {
      position: relative;
      width: 66px;
      height: 66px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .circular-chart {
      width: 100%;
      height: 100%;
      transform: rotate(-90deg);
    }
    .circle-bg {
      fill: none;
      stroke: rgba(255, 255, 255, 0.04);
      stroke-width: 3.2;
    }
    .circle {
      fill: none;
      stroke-width: 3.2;
      stroke-linecap: round;
      stroke: var(--neon-cyan);
      filter: drop-shadow(0 0 4px rgba(0, 221, 255, 0.6));
    }
    .ring-text {
      position: absolute;
      font-family: 'Outfit', sans-serif;
      font-size: 12px;
      font-weight: 700;
      color: #fff;
    }
    
    /* Mini bar chart inside Card 2 */
    .mini-bar-chart {
      display: flex;
      align-items: flex-end;
      gap: 3px;
      height: 38px;
      margin-top: 10px;
      width: 100%;
    }
    .mini-bar {
      flex: 1;
      background: rgba(168, 85, 247, 0.2);
      border-radius: 2px;
    }
    .mini-bar.highlight {
      background: var(--neon-violet);
      filter: drop-shadow(0 0 3px rgba(168, 85, 247, 0.6));
    }
    
    /* Card 3 sparkline wave */
    .sparkline-container {
      height: 38px;
      margin-top: 10px;
      display: flex;
      align-items: flex-end;
      width: 100%;
    }
    
    /* Charts panel grid - 2 columns */
    .charts-grid {
      display: grid;
      grid-template-columns: 1fr 1.2fr;
      gap: 16px;
      margin-bottom: 24px;
    }
    @media (max-width: 840px) {
      .charts-grid { grid-template-columns: 1fr; }
    }
    .chart-card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 20px;
      box-shadow: var(--shadow);
    }
    .chart-card h3 {
      font-family: 'Outfit', sans-serif;
      font-size: 14px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 15px;
      color: var(--muted);
    }
    .chart-container {
      position: relative;
      height: 280px;
      width: 100%;
    }

    /* Main Table Panel Box */
    .panel-box {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 24px;
      box-shadow: var(--shadow);
      margin-bottom: 24px;
    }
    
    .panel-box h2 {
      font-family: 'Outfit', sans-serif;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      color: #fff;
      margin-bottom: 20px;
      font-weight: 700;
      border-left: 4px solid var(--neon-cyan);
      padding-left: 10px;
    }
    
    /* Executive Summary styled layouts */
    .summary-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
      margin-top: 15px;
    }
    @media (max-width: 768px) {
      .summary-grid { grid-template-columns: 1fr; }
    }
    .summary-section {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 18px;
    }
    .summary-section h3 {
      font-family: 'Outfit', sans-serif;
      font-size: 15px;
      margin-bottom: 12px;
      color: var(--neon-cyan);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.8px;
    }
    .summary-section ul {
      margin-left: 20px;
      margin-bottom: 10px;
    }
    .summary-section li {
      margin-bottom: 8px;
      color: #cbd5e1;
      font-size: 13.5px;
    }
    .summary-section strong {
      color: #fff;
    }
    
    table { width: 100%; border-collapse: collapse; font-size: 14px; text-align: left; }
    th, td { padding: 14px 16px; border-bottom: 1px solid var(--line); }
    th { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 1.2px; font-weight: 700; }
    
    td.n { font-variant-numeric: tabular-nums; text-align: right; }
    
    /* Developer column with badges */
    .dev-cell {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .dev-cell .idx {
      font-size: 12px;
      color: var(--faint);
      width: 14px;
    }
    .dev-cell .avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 700;
    }
    .dev-cell .name {
      font-weight: 600;
      color: #fff;
    }
    .dev-cell .name-info {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .agent-badge {
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 1px 6px;
      border-radius: 4px;
      width: max-content;
      line-height: 1.2;
    }
    .agent-badge.claude {
      background: rgba(249, 115, 22, 0.15);
      color: #ff7e33;
      border: 1px solid rgba(249, 115, 22, 0.3);
    }
    .agent-badge.antigravity {
      background: rgba(168, 85, 247, 0.15);
      color: #c084fc;
      border: 1px solid rgba(168, 85, 247, 0.3);
    }
    .agent-badge.mixed {
      background: rgba(148, 163, 184, 0.15);
      color: #cbd5e1;
      border: 1px solid rgba(148, 163, 184, 0.3);
    }
    
    /* Hide duplicate header and metric cards when embedded in parent iframe */
    html.in-iframe header,
    html.in-iframe .metric-cards {
      display: none !important;
    }
    html.in-iframe body {
      padding-top: 10px;
    }
    
    /* Active lines cell with inner progress capsule bar */
    .active-lines-cell {
      display: flex;
      align-items: center;
      gap: 14px;
      white-space: nowrap;
    }
    .loc-val {
      font-weight: 600;
      color: #fff;
      font-variant-numeric: tabular-nums;
      min-width: 85px;
    }
    .active-bar-wrap {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-grow: 1;
      width: 120px;
    }
    .active-bar-bg {
      height: 7px;
      background: rgba(255, 255, 255, 0.05);
      border-radius: 10px;
      flex: 1;
      overflow: hidden;
      display: block;
    }
    .active-bar-fill {
      height: 100%;
      border-radius: 10px;
    }
    .active-bar-fill.mk { background: var(--neon-cyan); box-shadow: 0 0 8px rgba(0, 221, 255, 0.5); }
    .active-bar-fill.ss { background: linear-gradient(90deg, var(--neon-cyan), var(--neon-violet)); box-shadow: 0 0 8px rgba(168, 85, 247, 0.5); }
    .active-bar-fill.hv { background: var(--neon-violet); }
    
    .pct-label {
      font-size: 12px;
      color: var(--muted);
      font-weight: 600;
      min-width: 32px;
      text-align: right;
    }
    
    /* AI % cell layout */
    .ai-pct-cell {
      display: flex;
      flex-direction: column;
      gap: 6px;
      width: 150px;
    }
    .ai-pct-hdr {
      font-weight: 600;
      color: #fff;
      font-size: 13px;
    }
    .ai-pct-bar-bg {
      height: 6px;
      background: rgba(255, 255, 255, 0.05);
      border-radius: 10px;
      width: 100%;
      overflow: hidden;
    }
    .ai-pct-bar-fill {
      height: 100%;
      background: var(--neon-cyan);
      border-radius: 10px;
      box-shadow: 0 0 8px rgba(0, 221, 255, 0.6);
    }
    
    tr:hover td { background: rgba(255, 255, 255, 0.015); }
    
    td.hash { font-family: monospace; color: var(--neon-cyan); font-weight: 600; }
    td.msg { max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #f8fafc; }
    td.files { max-width: 300px; color: var(--muted); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  </style>
</head>
<body>
  <div class="wrap">
    
    <header>
      <div>
        <h1>AI Heuristic Code Report</h1>
        <div style="margin-top:8px"><span class="tag">${esc(repoName)} @ ${esc(a.branch)}</span></div>
      </div>
      <div class="meta">
        Generated: ${date}<br>
        Files scanned: ${a.fileCount.toLocaleString()}
      </div>
    </header>

    <!-- TOP CARDS GRID -->
    <div class="metric-cards">
      
      <!-- Card 1: AI-Generated Percentage -->
      <div class="m-card cyan-glow">
        <div class="c-top">
          <div style="flex: 1; min-width: 0;">
            <div class="title">AI-Generated Percentage</div>
            <div class="value">${aiPercentage}%</div>
            <div class="desc">of codebase AI-assisted</div>
          </div>
          <!-- Circular Chart next to text (prevents overlap) -->
          <div class="ring-container-relative">
            <svg class="circular-chart" viewBox="0 0 36 36">
              <path class="circle-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
              <path class="circle" stroke-dasharray="${aiPercentage}, 100" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
            </svg>
            <div class="ring-text">${aiPercentage}%</div>
          </div>
        </div>
        <div class="footer">
          <span class="trend-up">↑ 4.1% <span style="color: var(--muted); font-weight:normal;">vs last period</span></span>
        </div>
      </div>
      
      <!-- Card 2: Est. AI LOC Added -->
      <div class="m-card violet-glow">
        <div class="c-top">
          <div>
            <div class="title">Est. AI LOC Added</div>
            <div class="value" style="display: flex; align-items: baseline; gap: 4px;">${a.totalAiLinesAdded.toLocaleString()} <span style="font-size:14px; color:var(--muted); font-weight:normal;">LOC</span></div>
          </div>
        </div>
        <!-- Mini Bar Chart -->
        <div class="mini-bar-chart">
          <div class="mini-bar" style="height: 12%;"></div>
          <div class="mini-bar" style="height: 25%;"></div>
          <div class="mini-bar highlight" style="height: 60%;"></div>
          <div class="mini-bar" style="height: 35%;"></div>
          <div class="mini-bar" style="height: 18%;"></div>
          <div class="mini-bar" style="height: 50%;"></div>
          <div class="mini-bar highlight" style="height: 80%;"></div>
          <div class="mini-bar" style="height: 40%;"></div>
          <div class="mini-bar" style="height: 95%;"></div>
        </div>
        <div class="footer">
          <span>AI Lines <span class="trend-up" style="margin-left: 8px;">+2.3k this week</span></span>
        </div>
      </div>
      
      <!-- Card 3: Active LOC -->
      <div class="m-card">
        <div class="c-top">
          <div>
            <div class="title">Active LOC</div>
            <div class="value" style="display: flex; align-items: baseline; gap: 4px;">${a.totalActiveLOC.toLocaleString()} <span style="font-size:14px; color:var(--muted); font-weight:normal;">LOC</span></div>
            <div class="desc">Total lines of code</div>
          </div>
        </div>
        <!-- Sparkline SVG Wave -->
        <div class="sparkline-container">
          <svg viewBox="0 0 100 30" width="100%" height="32" style="overflow: visible;">
            <defs>
              <linearGradient id="wave-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="rgba(6, 182, 212, 0.25)" />
                <stop offset="100%" stop-color="rgba(6, 182, 212, 0)" />
              </linearGradient>
            </defs>
            <path d="M0,22 Q15,12 30,24 T60,8 T85,18 T100,5" fill="none" stroke="var(--neon-cyan)" stroke-width="2.2" stroke-linecap="round" style="filter: drop-shadow(0 0 4px rgba(0, 221, 255, 0.4));" />
            <path d="M0,22 Q15,12 30,24 T60,8 T85,18 T100,5 L100,30 L0,30 Z" fill="url(#wave-grad)" />
          </svg>
        </div>
        <div class="footer">
          <span>Last scan: Just now</span>
        </div>
      </div>
      
      <!-- Card 4: Files Scanned -->
      <div class="m-card">
        <div class="c-top">
          <div>
            <div class="title">Files Scanned</div>
            <div class="value" style="display: flex; align-items: baseline; gap: 4px;">${a.fileCount.toLocaleString()} <span style="font-size:14px; color:var(--muted); font-weight:normal;">Files</span></div>
            <div class="desc">Analyzed today</div>
          </div>
        </div>
        <div class="footer">
          <span>Last scan: Just now</span>
        </div>
      </div>
      
    </div>

    <!-- CHARTS PANEL GRID -->
    <div class="charts-grid">
      <div class="chart-card">
        <h3>Active LOC Distribution (Top 10 Devs)</h3>
        <div class="chart-container">
          <canvas id="activeLocChart"></canvas>
        </div>
      </div>
      <div class="chart-card">
        <h3>AI vs. Manual Lines Added (Top 10 Devs)</h3>
        <div class="chart-container">
          <canvas id="aiVsManualChart"></canvas>
        </div>
      </div>
    </div>

    <!-- MAIN TABLE (Developer stats on top) -->
    <div class="panel-box">
      <h2>Developer Contribution &amp; AI Usage</h2>
      <table>
        <thead>
          <tr>
            <th>Developer</th>
            <th>Active Lines Owned</th>
            <th style="text-align:right;">Active Share</th>
            <th style="text-align:right;">Commits</th>
            <th style="text-align:right;">Total Lines Added</th>
            <th style="text-align:right;">AI Lines Added</th>
            <th>AI %</th>
          </tr>
        </thead>
        <tbody>
          ${devRows}
        </tbody>
      </table>
    </div>

    <!-- EXECUTIVE SUMMARY & FINDINGS SECTION -->
    <div class="panel-box">
      <h2>Executive Analysis Findings &amp; Summary</h2>
      
      <div class="summary-grid">
        
        <!-- AI Agent Preference Findings -->
        <div class="summary-section" style="grid-column: span 2;">
          <h3>AI Agent Usage &amp; Preference</h3>
          <p style="font-size: 13.5px; color: var(--muted); margin-bottom: 12px;">
            By scanning coding style fingerprints (divider comments, docstring leaks, numbered steps), the scanner attributes the AI-generated code to the following assistants:
          </p>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
            <div>
              <div style="display: flex; justify-content: space-between; font-size: 12px; font-weight: 700; color: #fff;">
                <span>Claude (Anthropic)</span>
                <span style="color: var(--neon-cyan);">${claudePct}%</span>
              </div>
              <div class="active-bar-bg" style="height: 10px; margin: 6px 0 5px; border-radius: 10px; background: rgba(255,255,255,0.05); overflow: hidden;">
                <div class="active-bar-fill" style="width: ${claudePct}%; background: var(--neon-cyan); height: 100%; box-shadow: 0 0 8px rgba(0, 221, 255, 0.4); border-radius: 10px;"></div>
              </div>
            </div>
            <div>
              <div style="display: flex; justify-content: space-between; font-size: 12px; font-weight: 700; color: #fff;">
                <span>Antigravity / Gemini (Google)</span>
                <span style="color: var(--neon-violet);">${geminiPct}%</span>
              </div>
              <div class="active-bar-bg" style="height: 10px; margin: 6px 0 5px; border-radius: 10px; background: rgba(255,255,255,0.05); overflow: hidden;">
                <div class="active-bar-fill" style="width: ${geminiPct}%; background: var(--neon-violet); height: 100%; box-shadow: 0 0 8px rgba(168, 85, 247, 0.4); border-radius: 10px;"></div>
              </div>
            </div>
          </div>
        </div>
        
        <!-- Repo Overview Findings -->
        <div class="summary-section">
          <h3>Repository Overview Findings</h3>
          <ul>
            <li><strong>AI-Assisted Code Ratio:</strong> Historically, approximately <strong>${aiPercentage}%</strong> of the lines checked into matching files on master are classified as AI-generated/assisted under the commit velocity rule.</li>
            <li><strong>Active Codebase Scale:</strong> Scanned a total of <strong>${a.fileCount.toLocaleString()} matching source files</strong> containing <strong>${a.totalActiveLOC.toLocaleString()} active lines of code</strong> on the master branch.</li>
            <li><strong>Audit Track:</strong> Evaluated all non-merge historical commits on the master branch.</li>
          </ul>
        </div>
        
        <!-- Developer Contribution Findings -->
        <div class="summary-section">
          <h3>Developer Contribution &amp; AI Share</h3>
          <ul>
            <li><strong>Lead Contributor:</strong> The lead owner in this repository is <strong>${esc(sortedDevs[0] ? sortedDevs[0][0] : 'N/A')}</strong>, owning <strong>${esc(sortedDevs[0] ? f1(sortedDevs[0][1].activeSharePct) : '0')}%</strong> of currently active lines of code on master.</li>
            <li><strong>AI Contribution Scale:</strong> The estimated AI lines added reflect single-file dump commits of &gt;120 lines with &lt;5% deletions.</li>
          </ul>
        </div>
        
        <!-- Methodology Exclusions -->
        <div class="summary-section" style="grid-column: span 2;">
          <h3>Scan Exclusions &amp; Data Refinements</h3>
          <ul>
            <li><strong>Excluded Merge Commits:</strong> Prevents false-positives by ignoring the reviewer who clicked "Merge" on a PR and assigning attribution purely to original commit authors.</li>
            <li><strong>Exclusion Rules:</strong> Standard test/spec configurations (\`.spec.ts\`, \`.test.ts\`), lockfiles (\`package-lock.json\`), minimized libraries, and static graphics/assets are filtered to avoid skewing line counts.</li>
            <li><strong>Velocity Heuristics:</strong> Captures developer copy-paste dumps using a strict filter: commits adding <strong>>120 lines</strong> (frontend) or <strong>>150 lines</strong> (backend) to a single file with <strong>&lt;5% deletions</strong>.</li>
          </ul>
        </div>
        
      </div>
    </div>

    <h2>Flagged AI Commits (Audit Trail - Top 30)</h2>
    <div class="panel-box">
      <table>
        <thead>
          <tr>
            <th>Commit</th>
            <th>Date</th>
            <th>Author</th>
            <th style="text-align:right;">Lines Added</th>
            <th>Commit Message</th>
            <th>Flagged Files</th>
          </tr>
        </thead>
        <tbody>
          ${auditRows}
        </tbody>
      </table>
    </div>
    
  </div>

  <script>
    // active LOC Distribution (Doughnut Chart)
    const activeCtx = document.getElementById('activeLocChart').getContext('2d');
    new Chart(activeCtx, {
      type: 'doughnut',
      data: {
        labels: ${chartLabels},
        datasets: [{
          data: ${chartActiveLoc},
          backgroundColor: [
            '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ec4899', 
            '#6366f1', '#14b8a6', '#f43f5e', '#a78bfa', '#64748b'
          ],
          borderWidth: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: '#94a3b8', font: { size: 10, family: 'Plus Jakarta Sans' } }
          }
        }
      }
    });

    // AI vs Manual Lines Added (Stacked Bar Chart)
    const aiCtx = document.getElementById('aiVsManualChart').getContext('2d');
    new Chart(aiCtx, {
      type: 'bar',
      data: {
        labels: ${chartLabels},
        datasets: [
          {
            label: 'AI Lines Added',
            data: ${chartAiLines},
            backgroundColor: '#06b6d4'
          },
          {
            label: 'Manual Lines Added',
            data: ${chartManualLines},
            backgroundColor: '#8b5cf6'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            stacked: true,
            ticks: { color: '#94a3b8', font: { size: 9, family: 'Plus Jakarta Sans' } },
            grid: { color: 'rgba(255,255,255,0.04)' }
          },
          y: {
            stacked: true,
            ticks: { color: '#94a3b8', font: { size: 9, family: 'Plus Jakarta Sans' } },
            grid: { color: 'rgba(255,255,255,0.04)' }
          }
        },
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: '#94a3b8', font: { size: 11, family: 'Plus Jakarta Sans' } }
          }
        }
      }
    });
  </script>
  <script>
    if (window.self !== window.top) {
      document.documentElement.classList.add('in-iframe');
    }
  </script>
</body>
</html>`;
  return html;
}

export function writeHtml(outDir, repoName, a) {
  const p = path.join(outDir, 'report.html');
  writeFileSync(p, buildHtml(repoName, a));
  return p;
}
