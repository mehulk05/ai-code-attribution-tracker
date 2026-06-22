// Browser-side rendering for the Team Pulse report.
(function () {
  const DATA = window.__TP__.data;
  const REPO = window.__TP__.repo;
  const rootNode = document.getElementById('frame')?.shadowRoot || document;
  const $ = (s, el = rootNode) => el.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const gradeClass = (g) => 'g' + g;
  const hue = (i) => (i * 97) % 360;
  
  let sortCol = 'linesAdded';
  let sortDesc = true;
  let filterText = '';

  const avatar = (name, i) => {
    const p = String(name).split(/[ .@_]/).filter(Boolean);
    const ini = ((p[0] || name)[0] + ((p[1] || '')[0] || '')).toUpperCase();
    return '<span class="avatar" style="background:hsla(' + hue(i) + ',60%,25%,.8);border-color:hsla(' + hue(i) + ',80%,60%,1);color:#fff;box-shadow:0 0 10px hsla(' + hue(i) + ',80%,60%,0.4)">' + esc(ini) + '</span>';
  };

  function getPersonas(d) {
    let p = '';
    if (d.nightPct > 25) p += '<span class="persona" title="The Night Owl (high off-hours commits)"><i data-lucide="moon" style="width:16px;height:16px;stroke-width:2"></i></span>';
    if (d.featurePct > 75) p += '<span class="persona" title="The Architect (mostly writes new features)"><i data-lucide="blocks" style="width:16px;height:16px;stroke-width:2"></i></span>';
    if (d.refactorPct > 75) p += '<span class="persona" title="The Janitor (mostly refactors existing code)"><i data-lucide="paintbrush" style="width:16px;height:16px;stroke-width:2"></i></span>';
    if (d.soleOwnedFiles > 10) p += '<span class="persona" title="The Lone Wolf (high single-owner files)"><i data-lucide="user" style="width:16px;height:16px;stroke-width:2"></i></span>';
    if (d.hugeCommits > 2) p += '<span class="persona" title="The Volcano (massive PRs)"><i data-lucide="flame" style="width:16px;height:16px;stroke-width:2"></i></span>';
    return p;
  }

  function heatmap(map) {
    const max = Math.max(1, ...Object.values(map));
    const lvl = (c) => (!c ? '' : c >= max * 0.75 ? 'l4' : c >= max * 0.5 ? 'l3' : c >= max * 0.25 ? 'l2' : 'l1');
    const first = new Date(DATA.days[0]);
    const pad = first.getDay();
    let cells = '';
    for (let i = 0; i < pad; i++) cells += '<div class="cell" style="visibility:hidden"></div>';
    for (const d of DATA.days) {
      const c = map[d] || 0;
      cells += '<div class="cell ' + lvl(c) + '" title="' + d + ': ' + c + ' commits"></div>';
    }
    return '<div class="heat">' + cells + '</div>';
  }

  const heatLegend =
    '<div class="legend">Less <span class="cell" style="display:inline-block"></span>' +
    '<span class="cell l1" style="display:inline-block"></span>' +
    '<span class="cell l2" style="display:inline-block"></span>' +
    '<span class="cell l3" style="display:inline-block"></span>' +
    '<span class="cell l4" style="display:inline-block"></span> More</div>';

  const kpi = (k, v, sub, icon) => '<div class="kpi"><div class="k">' + (icon ? `<i data-lucide="${icon}" style="width:16px;height:16px;"></i> ` : '') + k + '</div><div class="v">' + v + '</div>' + (sub ? '<div class="k" style="margin-top:4px;color:var(--faint);">' + sub + '</div>' : '') + '</div>';
  
  function svgDial(score, label) {
    const r = 45;
    const circ = 2 * Math.PI * r;
    const dash = (score / 100) * circ;
    const color = score >= 85 ? 'var(--A)' : score >= 70 ? 'var(--B)' : score >= 55 ? 'var(--C)' : score >= 40 ? 'var(--D)' : 'var(--F)';
    return `
      <div class="dial-container">
        <svg class="dial-svg" viewBox="0 0 100 100">
          <circle class="dial-bg" cx="50" cy="50" r="${r}"></circle>
          <circle class="dial-fg" cx="50" cy="50" r="${r}" style="stroke:${color}; stroke-dasharray:${dash} ${circ}"></circle>
        </svg>
        <div class="dial-val">
          <div class="v">${score}</div>
          <div class="l">${label}</div>
        </div>
      </div>`;
  }

  function svgRing(val, label) {
    const r = 26;
    const circ = 2 * Math.PI * r;
    const dash = (val / 100) * circ;
    const color = val >= 80 ? 'var(--A)' : val >= 60 ? 'var(--B)' : val >= 40 ? 'var(--C)' : 'var(--bad)';
    return `
      <div class="ring-box">
        <div class="ring-container">
          <svg class="ring-svg" viewBox="0 0 60 60">
            <circle class="ring-bg" cx="30" cy="30" r="${r}"></circle>
            <circle class="ring-fg" cx="30" cy="30" r="${r}" style="stroke:${color}; stroke-dasharray:${dash} ${circ}"></circle>
          </svg>
          <div class="ring-val">${val}</div>
        </div>
        <div class="ring-lbl">${label}</div>
      </div>`;
  }

  function exportCsv() {
    const rows = [['Developer', 'Grade', 'Score', 'Lines Added', 'Owned %', 'Overwrite %', 'Active Days', 'Commits', 'Reverted']];
    DATA.perDeveloper.forEach(d => {
      rows.push([d.name, d.grade, d.score, d.linesAdded, d.ownedSharePct, d.overwritePct, d.activeDays, d.commits, d.timesReverted]);
    });
    const csv = rows.map(e => e.join(",")).join("\n");
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `teampulse-${REPO}.csv`;
    a.click();
  }

  function drawCharts() {
    if (!window.Chart) return;
    const devs = DATA.perDeveloper.slice(0, 8); // Top 8 for pie chart
    
    // Contribution Pie
    new Chart($('#pieChart'), {
      type: 'doughnut',
      data: {
        labels: devs.map(d => d.name),
        datasets: [{
          data: devs.map(d => d.linesAdded),
          backgroundColor: [
            '#ffffff', '#e4e4e7', '#a1a1aa', '#71717a', '#52525b', 
            '#3f3f46', '#27272a', '#18181b', '#111111', '#000000'
          ].slice(0, devs.length),
          borderWidth: 0
        }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { color: '#ededed' } } } }
    });

    // Timeline Area Chart
    const days = DATA.days;
    const counts = days.map(d => DATA.teamHeat[d] || 0);
    new Chart($('#timelineChart'), {
      type: 'line',
      data: {
        labels: days.map(d => d.slice(5)), // MM-DD
        datasets: [{
          label: 'Team Commits', data: counts,
          borderColor: '#ffffff', backgroundColor: 'rgba(255, 255, 255, 0.1)',
          fill: true, tension: 0.4
        }]
      },
      options: { 
        responsive: true, 
        maintainAspectRatio: false, 
        plugins: { legend: { display: false } }, 
        scales: { 
          x: { ticks: { color: '#a1a1aa' }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { beginAtZero: true, ticks: { color: '#a1a1aa' }, grid: { color: 'rgba(255,255,255,0.05)' } } 
        } 
      }
    });

    const ctxHot = $('#hotspotChart');
    if (ctxHot && DATA.hotspots && DATA.hotspots.length) {
      const topH = DATA.hotspots.slice(0, 5);
      new Chart(ctxHot, {
        type: 'bar',
        data: {
          labels: topH.map(h => h.file.split('/').pop().substring(0, 15)),
          datasets: [{
            label: 'Lines Added',
            data: topH.map(h => h.add),
            backgroundColor: '#ffffff',
            maxBarThickness: 40
          }, {
            label: 'Lines Deleted',
            data: topH.map(h => h.del),
            backgroundColor: '#52525b',
            maxBarThickness: 40
          }]
        },
        options: { 
          responsive: true, 
          maintainAspectRatio: false, 
          plugins: {
            legend: { labels: { color: '#ededed' } }
          },
          scales: { 
            x: { stacked: true, ticks: { color: '#a1a1aa' }, grid: { display: false } }, 
            y: { stacked: true, ticks: { color: '#a1a1aa' }, grid: { color: 'rgba(255,255,255,0.05)' } } 
          } 
        }
      });
    }

    if (window.lucide) window.lucide.createIcons({ root: rootNode });
  }

  function renderHome() {
    let devs = [...DATA.perDeveloper];
    if (filterText) devs = devs.filter(d => d.name.toLowerCase().includes(filterText));
    
    devs.sort((a, b) => {
      let va = a[sortCol], vb = b[sortCol];
      if (typeof va === 'string') return sortDesc ? vb.localeCompare(va) : va.localeCompare(vb);
      return sortDesc ? vb - va : va - vb;
    });

    const avgScore = devs.length ? Math.round(devs.reduce((s, d) => s + d.score, 0) / devs.length) : 0;
    const busFiles = DATA.soleOwnedTotal;

    const topDial = `
      <div class="panel" style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:20px;">
        <div style="flex:1; min-width:250px;">
          <h2>Project Health</h2>
          <p style="color:var(--muted); font-size:14px; margin:0 0 10px; max-width:400px;">
            The overall health score is calculated across the entire team based on code survival, commit frequency, and hygienic practices.
          </p>
          <div style="display:flex; gap:10px; margin-top:20px;">
            <button id="exportBtn" style="background:var(--panel2); color:#fff; border:1px solid var(--line); padding:6px 12px; border-radius:6px; cursor:pointer;"><i data-lucide="download" style="width:14px;height:14px"></i> Export CSV</button>
          </div>
        </div>
        <div>${svgDial(avgScore, 'Team Score')}</div>
      </div>`;

    const kpis = '<div class="kpis">' +
      kpi('Contributors', DATA.contributors, null, 'users') +
      kpi('Commits (' + DATA.windowDays + 'd)', DATA.totalCommits.toLocaleString(), null, 'git-commit') +
      kpi('Active codebase', DATA.totalActiveLOC.toLocaleString() + ' LOC', null, 'file-code') +
      kpi('Single-owner files', busFiles.toLocaleString(), 'Key Person Risk', 'alert-triangle') + '</div>';

    const chartsHtml = `
      <div class="grid-2" style="margin-bottom: 24px;">
        <div class="panel" style="margin:0; padding:24px;">
          <h2 style="font-size:15px;"><i data-lucide="pie-chart"></i> Contribution Share</h2>
          <div style="position:relative; height:260px; width:100%;">
            <canvas id="pieChart"></canvas>
          </div>
        </div>
        <div class="panel" style="margin:0; padding:24px;">
          <h2 style="font-size:15px;"><i data-lucide="bar-chart-2"></i> Commit Timeline</h2>
          <div style="position:relative; height:260px; width:100%;">
            <canvas id="timelineChart"></canvas>
          </div>
        </div>
      </div>
      ${(DATA.hotspots && DATA.hotspots.length) ? `
      <div style="margin-bottom: 40px;">
        <div class="panel" style="margin:0; padding:24px;">
          <h2 style="font-size:15px;"><i data-lucide="flame"></i> Top Hotspots</h2>
          <div style="position:relative; height:260px; width:100%;">
            <canvas id="hotspotChart"></canvas>
          </div>
        </div>
      </div>` : ''}
    `;

    const hotspotsHtml = DATA.hotspots && DATA.hotspots.length ? `
      <div class="panel scroll" style="margin-top:20px;">
        <h2><i data-lucide="flame" style="width:18px;height:18px"></i> Codebase Hotspots (Top Churned Files)</h2>
        <p style="color:var(--muted);font-size:13px;margin:-6px 0 12px">Files with the highest number of edits and authors in the window. High churn here usually indicates architectural bottlenecks or complex merge-conflict zones.</p>
        <table>
          <thead><tr><th>File Path</th><th class="n">Commits</th><th class="n">Unique Devs</th><th class="n">+ Lines</th><th class="n">- Lines</th></tr></thead>
          <tbody>
            ${DATA.hotspots.map(h => `<tr><td style="font-family:ui-monospace,monospace;font-size:12px;color:var(--accent)">${esc(h.file)}</td><td class="n">${h.commits}</td><td class="n">${h.devs}</td><td class="n" style="color:var(--good)">+${h.add}</td><td class="n" style="color:var(--bad)">-${h.del}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>` : '';

    const th = (col, label, isNum = true) => `<th data-col="${col}" style="cursor:pointer; user-select:none" class="${isNum?'n':''}">${label} ${sortCol === col ? (sortDesc ? '▼' : '▲') : ''}</th>`;

    const rows = devs.map((d) => {
      const pColor = d.overwritePct > 20 ? 'var(--bad)' : d.overwritePct > 5 ? 'var(--warn)' : 'var(--good)';
      const oBar = `<span class="bar"><i style="width:${Math.min(100, 100 - d.overwritePct)}%; background:${pColor}"></i></span>`;
      const i = DATA.perDeveloper.findIndex(x => x.name === d.name);
      return '<tr class="dev-row" data-i="' + i + '">' +
        '<td class="namecell">' + avatar(d.name, i) + esc(d.name) + getPersonas(d) + '</td>' +
        '<td><span class="grade ' + gradeClass(d.grade) + '">' + d.grade + '</span></td>' +
        '<td class="n">+' + d.linesAdded.toLocaleString() + '</td>' +
        '<td class="n">' + d.ownedSharePct + '%</td>' +
        '<td class="n"><div class="bar-wrap">' + oBar + (100 - d.overwritePct).toFixed(0) + '%</div></td>' +
        '<td class="n">' + d.activeDays + '</td>' +
        '<td class="n">' + d.commits + '</td>' +
        '<td class="n">' + (d.timesReverted > 0 ? `<span style="color:var(--bad);font-weight:bold">${d.timesReverted}</span>` : '0') + '</td>' +
        '<td class="n">' + d.avgCommitSize + '</td>' +
        '<td><i data-lucide="chevron-right"></i></td></tr>';
    }).join('');

    const table = `
      <div class="panel scroll">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
          <h2 style="margin:0">Active Team Directory</h2>
          <input type="text" id="devFilterBox" placeholder="Search developer..." style="background:var(--bg); border:1px solid var(--line); color:#fff; padding:6px 12px; border-radius:6px; outline:none;" value="${filterText}">
        </div>
        <table><thead><tr>
          ${th('name', 'Developer', false)}
          ${th('score', 'Grade', false)}
          ${th('linesAdded', 'Lines Added')}
          ${th('ownedSharePct', 'Live Code %')}
          ${th('overwritePct', 'Code Survival %')}
          ${th('activeDays', 'Active Days')}
          ${th('commits', 'Commits')}
          ${th('timesReverted', 'Reverted')}
          ${th('avgCommitSize', 'Avg size')}
          <th></th>
        </tr></thead><tbody>${rows}</tbody></table>
      </div>`;

    const inactive = DATA.inactive || [];
    const inactiveTable = inactive.length ? ('<div class="panel scroll"><h2>Knowledge Risk: Inactive Core Contributors (' + inactive.length + ')</h2>' +
      '<p style="color:var(--faint);font-size:12px;margin:-6px 0 12px">These developers own significant portions of the codebase but have not committed recently. High single-owner files indicate a bus-factor risk.</p>' +
      '<table><thead><tr><th>Developer</th><th class="n">Owns (live LOC)</th><th class="n">Owns %</th><th class="n" style="color:var(--warn)">Single-owner files</th><th>Last active</th></tr></thead><tbody>' +
      inactive.map((d, i) =>
        '<tr><td class="namecell">' + avatar(d.name, i + 99) + esc(d.name) + '</td>' +
        '<td class="n">' + d.linesOwned.toLocaleString() + '</td>' +
        '<td class="n">' + d.ownedSharePct + '%</td>' +
        '<td class="n" style="color:var(--warn);font-weight:bold">' + d.soleOwnedFiles + '</td>' +
        '<td>' + (d.lastActive ? esc(d.lastActive) : '—') + '</td></tr>').join('') + '</tbody></table></div>')
      : '';

    $('#home').innerHTML = topDial + kpis + table + inactiveTable + chartsHtml + hotspotsHtml;
    
    // Attach Listeners
    $('#home').querySelectorAll('.dev-row').forEach((r) => r.addEventListener('click', () => renderDetail(+r.dataset.i)));
    $('#home').querySelectorAll('th[data-col]').forEach(th => {
      th.addEventListener('click', () => {
        if (sortCol === th.dataset.col) sortDesc = !sortDesc;
        else { sortCol = th.dataset.col; sortDesc = true; }
        renderHome();
      });
    });
    $('#devFilterBox').addEventListener('keyup', (e) => { filterText = e.target.value.toLowerCase(); renderHome(); $('#devFilterBox').focus(); });
    $('#exportBtn').addEventListener('click', exportCsv);
    
    $('#detail').classList.add('hidden');
    $('#home').classList.remove('hidden');
    
    if (window.lucide) window.lucide.createIcons({ root: rootNode });
    setTimeout(drawCharts, 50); // wait for DOM
  }

  function renderDetail(i) {
    const d = DATA.perDeveloper[i];
    const ss = d.subScores;
    const commitRows = d.commitList.map((c) =>
      '<tr><td>' + (c.url ? '<a href="' + esc(c.url) + '" target="_blank" rel="noopener">' + esc(c.short) + '</a>' : esc(c.short)) + '</td>' +
      '<td>' + esc(c.date) + '</td>' +
      '<td>' + esc(c.subject) + (c.reverted ? ' <span class="rev">⟲ reverted</span>' : '') + '</td>' +
      '<td class="n" style="color:var(--good)">+' + c.add + '</td>' +
      '<td class="n" style="color:var(--bad)">-' + c.del + '</td></tr>').join('') ||
      '<tr><td colspan="5" style="color:var(--faint)">No commits in window.</td></tr>';

    const m = (k, v) => '<div class="mc"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>';
    const host = DATA.commitBaseUrl ? DATA.commitBaseUrl.replace(/^https?:\/\//, '').split('/')[0] : null;

    $('#detail').innerHTML =
      '<span class="back" id="back">← Back to team dashboard</span>' +
      '<div class="panel"><div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">' +
      avatar(d.name, i) + '<h1 style="margin:0">' + esc(d.name) + '</h1>' + getPersonas(d) +
      '<span class="grade ' + gradeClass(d.grade) + '" style="width:40px;height:40px;font-size:20px;margin-left:auto">' + d.grade + '</span>' +
      '</div>' +
      '<div class="rings">' +
        svgRing(ss.survival, 'Survival') +
        svgRing(ss.reliability, 'Reliable') +
        svgRing(ss.consistency, 'Consistent') +
        svgRing(ss.hygiene, 'Hygiene') +
        svgRing(ss.volume, 'Volume') +
      '</div>' +
      '<div class="mgrid">' +
      m('Lines owned (live)', d.linesOwned.toLocaleString() + ' · ' + d.ownedSharePct + '%') +
      m('Lines added / deleted', '+' + d.linesAdded.toLocaleString() + ' / -' + d.linesDeleted.toLocaleString()) +
      m('Code Survival %', (100 - d.overwritePct).toFixed(1) + '%') +
      m('Commits', d.commits) +
      m('Active days', d.activeDays + ' / ' + DATA.windowDays + ' (' + Math.round(d.activeRatio * 100) + '%)') +
      m('Avg commit size', d.avgCommitSize + ' lines') +
      m('Huge commits (>400)', d.hugeCommits) +
      m('Commits reverted', d.timesReverted) +
      m('Reverts authored', d.revertsAuthored) +
      m('Feature vs refactor', d.featurePct + '% new / ' + d.refactorPct + '% edits') +
      m('Single-owner files', d.soleOwnedFiles) +
      m('Tests-touched ratio', d.testsRatio + '%') +
      m('Night / weekend', d.nightPct + '% / ' + d.weekendPct + '%') +
      m('Files touched', d.filesTouched) + '</div></div>' +
      
      (function() {
        const folderRows = (d.folders || []).map(f => `<tr><td style="font-family:ui-monospace,monospace;font-size:12px;color:var(--accent)">${esc(f.folder)}</td><td class="n">${f.lines.toLocaleString()}</td></tr>`).join('');
        const folderTable = folderRows ? `
        <div class="panel scroll">
          <h2>📂 Domain Expertise (Top Folders)</h2>
          <p style="color:var(--muted);font-size:13px;margin:-6px 0 12px">The directories where this developer edited the most code recently.</p>
          <table><thead><tr><th>Directory Path</th><th class="n">Lines Touched</th></tr></thead><tbody>${folderRows}</tbody></table>
        </div>` : '';
        return `
        <div class="grid-2">
          <div class="panel"><h2>${esc(d.name)} — activity heatmap (${DATA.windowDays}d)</h2>${heatmap(d.heat)}${heatLegend}</div>
          ${folderTable}
        </div>`;
      })() +

      '<div class="panel scroll"><h2>Commit history — last ' + DATA.windowDays + ' days (' + d.commitList.length + ')</h2>' +
      '<table class="clist"><thead><tr><th>Commit</th><th>Date</th><th>Message</th><th class="n">+</th><th class="n">−</th></tr></thead><tbody>' +
      commitRows + '</tbody></table>' +
      (host ? '<div class="legend">Commit hashes link to ' + esc(host) + '</div>' : '<div class="legend">No remote URL detected.</div>') +
      '</div>';

    $('#back').addEventListener('click', renderHome);
    $('#home').classList.add('hidden');
    $('#detail').classList.remove('hidden');
    window.scrollTo(0, 0);
  }

  $('#foot').innerHTML =
    '<b>Method:</b> git-only, last ' + DATA.windowDays + ' days on <code>' + esc(DATA.branch) + '</code>. Ownership/overwrite from <code>git blame</code>; reverts are explicit <code>git revert</code> only; night/weekend from author timestamps. ' +
    '⚠️ This view represents contribution &amp; hygiene — not AI authorship (see the AI Scan view). Grades are a coaching signal, not a performance ranking.';

  renderHome();
})();
