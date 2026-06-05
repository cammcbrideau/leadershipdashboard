/**
 * DTS Leadership Dashboard — Cloudflare Worker
 *
 * Routes:
 *   GET /          → static HTML shell (loads instantly, fetches data client-side)
 *   GET /api/data  → live JSON from Asana (cached 5 min)
 *
 * Secrets:  wrangler secret put ASANA_TOKEN
 */

const PROJECT_GID  = '1111174651444074';
const ASANA_API    = 'https://app.asana.com/api/1.0';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes in ms

// ─── In-memory cache (persists across requests in the same Worker isolate) ────
// caches.default does NOT work on workers.dev — this module-level variable does.
let memCache     = null;   // stringified JSON
let memCacheTime = 0;      // epoch ms when cache was last written
let memCacheFetching = false; // prevent stampede on concurrent cold requests

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── Auth gate (skip if DASHBOARD_PASSWORD secret not set) ────────────────
    if (env.DASHBOARD_PASSWORD) {
      // Handle login form POST
      if (request.method === 'POST' && url.pathname === '/login') {
        return handleLogin(request, env);
      }
      // All other routes require a valid auth cookie
      if (!isAuthed(request, env)) {
        return showLoginPage(url.pathname);
      }
    }

    if (url.pathname === '/api/data') return handleApiData(request, env, ctx);
    return handleDashboard(request, env);
  },
};

// ─── Auth ─────────────────────────────────────────────────────────────────────

const AUTH_COOKIE = 'dts-dash-auth';

function isAuthed(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const match  = cookie.match(/dts-dash-auth=([^;]+)/);
  return match?.[1] === env.DASHBOARD_PASSWORD;
}

async function handleLogin(request, env) {
  const body     = await request.formData().catch(() => null);
  const password = body?.get('password') ?? '';

  if (password !== env.DASHBOARD_PASSWORD) {
    return showLoginPage('/', true); // wrong password
  }

  // Correct — set cookie and redirect to dashboard
  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/',
      'Set-Cookie': `${AUTH_COOKIE}=${env.DASHBOARD_PASSWORD}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`,
    },
  });
}

function showLoginPage(next = '/', failed = false) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DTS Leadership Dashboard — Sign in</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
       background:#0f1117;color:#e2e8f0;min-height:100vh;
       display:flex;align-items:center;justify-content:center}
  .card{background:#1a1f35;border:1px solid #2d3748;border-radius:16px;
        padding:40px 48px;width:100%;max-width:380px;text-align:center}
  h1{font-size:20px;font-weight:700;margin-bottom:6px}
  .sub{font-size:13px;color:#718096;margin-bottom:28px}
  input[type=password]{width:100%;background:#0f1117;border:1px solid #2d3748;
        border-radius:8px;color:#e2e8f0;padding:10px 14px;font-size:14px;
        outline:none;margin-bottom:14px}
  input[type=password]:focus{border-color:#4299e1}
  button{width:100%;background:#4299e1;color:#fff;border:none;border-radius:8px;
         padding:11px;font-size:14px;font-weight:600;cursor:pointer}
  button:hover{background:#3182ce}
  .error{color:#fc8181;font-size:13px;margin-bottom:12px}
  .badge{display:inline-block;background:#e879f9;color:#fff;
         font-size:11px;font-weight:600;padding:3px 10px;border-radius:12px;margin-bottom:16px}
</style>
</head>
<body>
<div class="card">
  <div class="badge">LIVE</div>
  <h1>DTS Leadership Dashboard</h1>
  <div class="sub">Western Health Digital &amp; Technology Services</div>
  ${failed ? '<div class="error">Incorrect password — try again</div>' : ''}
  <form method="POST" action="/login">
    <input type="password" name="password" placeholder="Enter password" autofocus autocomplete="current-password">
    <button type="submit">Sign in</button>
  </form>
</div>
</body>
</html>`;
  return new Response(html, {
    status: failed ? 401 : 200,
    headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store' },
  });
}

// ─── GET / ────────────────────────────────────────────────────────────────────

function handleDashboard(_request, env) {
  if (!env.ASANA_TOKEN) {
    return new Response(
      '<h1>Config error</h1><p>Run: <code>wrangler secret put ASANA_TOKEN</code></p>',
      { status: 500, headers: { 'Content-Type': 'text/html' } }
    );
  }
  return new Response(HTML_SHELL, {
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'Cache-Control': 'no-store',
    },
  });
}

// ─── GET /api/data ────────────────────────────────────────────────────────────

async function handleApiData(request, env, ctx) {
  if (!env.ASANA_TOKEN) return jsonErr('ASANA_TOKEN secret is not configured.', 500);

  const now    = Date.now();
  const fresh  = memCache && (now - memCacheTime) < CACHE_TTL_MS;

  if (fresh) {
    // Serve from in-memory cache instantly
    return new Response(memCache, {
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'X-Cache': 'HIT',
        'X-Cache-Age': String(Math.round((now - memCacheTime) / 1000)) + 's',
      },
    });
  }

  // Cache miss or expired — fetch from Asana
  // If another request is already fetching, wait briefly then serve stale if available
  if (memCacheFetching && memCache) {
    return new Response(memCache, {
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Access-Control-Allow-Origin': '*',
        'X-Cache': 'STALE',
      },
    });
  }

  memCacheFetching = true;
  try {
    const data = await fetchAndProcess(env.ASANA_TOKEN);
    memCache      = JSON.stringify(data);
    memCacheTime  = Date.now();
    return new Response(memCache, {
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'X-Cache': 'MISS',
      },
    });
  } catch (err) {
    // On error, serve stale cache if we have it rather than failing
    if (memCache) {
      return new Response(memCache, {
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          'Access-Control-Allow-Origin': '*',
          'X-Cache': 'STALE-ERROR',
        },
      });
    }
    return jsonErr(String(err), 502);
  } finally {
    memCacheFetching = false;
  }
}

// ─── Asana fetch ──────────────────────────────────────────────────────────────

const OPEN_FIELDS = [
  'gid','name','assignee.name',
  'completed','created_at','modified_at','due_on',
  'memberships.section.name',
  'custom_fields.name','custom_fields.display_value', // for priority/risk charts
].join(',');

// Minimal fields for completed tasks — just enough for trend chart + donut Done count
const DONE_DATE_FIELDS = 'gid,created_at,completed_at';

const EXCLUDED_SECTION_NAMES = new Set([
  'High Impact (Week 1,3)',
  'Post Incident Review (Week 2,4)',
]);

// Fetch all sections then pull open tasks + completed dates IN PARALLEL.
async function fetchAndProcess(token) {
  // 1. Get section list (1 API call)
  const secResp = await fetch(
    `${ASANA_API}/projects/${PROJECT_GID}/sections?opt_fields=gid,name&limit=100`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!secResp.ok) throw new Error(`Asana sections ${secResp.status}`);
  const sections = (await secResp.json()).data
    .filter(s => !EXCLUDED_SECTION_NAMES.has(s.name));

  // 2. Parallel: open tasks per section + completed dates per section + recent completed widget
  const [openResults, doneResults, recentCompleted] = await Promise.all([
    Promise.all(sections.map(s => fetchSectionTasks(token, s.gid, s.name, false))),
    Promise.all(sections.map(s => fetchSectionTasks(token, s.gid, s.name, true))),
    fetchRecentCompleted(token),
  ]);

  return processData(openResults.flat(), doneResults.flat(), recentCompleted);
}

async function fetchSectionTasks(token, sectionGid, sectionName, completed) {
  const fields = completed ? DONE_DATE_FIELDS : OPEN_FIELDS;
  const tasks  = [];
  let   offset = null;
  do {
    const params = new URLSearchParams({
      section:    sectionGid,
      opt_fields: fields,
      completed:  String(completed),
      limit:      '100',
    });
    if (offset) params.set('offset', offset);
    const resp = await fetch(`${ASANA_API}/tasks?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return tasks;
    const json = await resp.json();
    if (!completed) {
      json.data.forEach(t => {
        if (!t.memberships?.length) t._sectionName = sectionName;
      });
    }
    tasks.push(...json.data);
    offset = json.next_page?.offset ?? null;
  } while (offset);
  return tasks;
}

async function fetchRecentCompleted(token) {
  const params = new URLSearchParams({
    project:    PROJECT_GID,
    opt_fields: 'gid,name,assignee.name,completed,completed_at,created_at,memberships.section.name',
    completed:  'true',
    limit:      '100',
  });
  const resp = await fetch(`${ASANA_API}/tasks?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return [];
  return (await resp.json()).data;
}

function processData(openRaw, doneDatesRaw, recentCompletedRaw) {
  const today = new Date(); today.setUTCHours(0,0,0,0);
  const in14  = new Date(today); in14.setUTCDate(in14.getUTCDate() + 14);

  const mapTask = t => {
    const section  = t.memberships?.[0]?.section?.name ?? t._sectionName ?? 'Unknown';
    const assignee = t.assignee?.name ?? 'Unassigned';
    const due      = t.due_on ?? '';
    const dueDate  = due ? new Date(due + 'T00:00:00Z') : null;
    const overdue  = !!dueDate && dueDate < today;
    const dueSoon  = !overdue && !!dueDate && dueDate <= in14;

    let priority = null, consequence = null, reversibility = null;
    for (const cf of t.custom_fields ?? []) {
      if (!cf.display_value) continue;
      if      (cf.name === 'Priority')      priority      = cf.display_value;
      else if (cf.name === 'Consequence')   consequence   = cf.display_value;
      else if (cf.name === 'Reversibility') reversibility = cf.display_value;
    }
    return {
      gid: t.gid, name: t.name, assignee, section, due,
      created:  (t.created_at  ?? '').slice(0,10),
      modified: (t.modified_at ?? '').slice(0,10),
      completed: false, completedAt: '', overdue, dueSoon,
      priority, consequence, reversibility,
    };
  };

  const tasks   = openRaw.map(mapTask);
  const open    = tasks;
  const overdue = open.filter(t => t.overdue);
  const dueSoon = open.filter(t => t.dueSoon);

  // doneDatesRaw has only gid, created_at, completed_at (minimal fields)
  const doneCount = doneDatesRaw.length;
  const total     = tasks.length + doneCount;
  const members   = new Set(tasks.filter(t => t.assignee !== 'Unassigned').map(t => t.assignee)).size;

  const kpis = {
    total, completed: doneCount, open: tasks.length,
    overdue: overdue.length, dueSoon: dueSoon.length, members,
    completionRate: total ? ((doneCount / total) * 100).toFixed(1) : '0',
    openRate:       total ? ((tasks.length / total) * 100).toFixed(1) : '0',
  };

  // Trend chart — combine open created_at + done created_at & completed_at
  const mCr = {}, mCo = {};
  for (const t of tasks)      if (t.created) { const m=t.created.slice(0,7); mCr[m]=(mCr[m]??0)+1; }
  for (const t of doneDatesRaw) {
    if (t.created_at)   { const m=t.created_at.slice(0,7);   mCr[m]=(mCr[m]??0)+1; }
    if (t.completed_at) { const m=t.completed_at.slice(0,7); mCo[m]=(mCo[m]??0)+1; }
  }
  const months    = [...new Set([...Object.keys(mCr),...Object.keys(mCo)])].sort().slice(-24);
  const created_m = months.map(m => mCr[m]??0);
  const compl_m   = months.map(m => mCo[m]??0);

  // Priority / risk counts (open tasks only — custom_fields now re-enabled)
  const pc = {
    high:          open.filter(t=>t.priority==='High').length,
    medium:        open.filter(t=>t.priority==='Medium').length,
    low:           open.filter(t=>t.priority==='Low').length,
    highConseq:    open.filter(t=>t.consequence?.includes('High')).length,
    lowConseq:     open.filter(t=>t.consequence?.includes('Low')).length,
    reversible:    open.filter(t=>t.reversibility==='Reversible').length,
    notReversible: open.filter(t=>t.reversibility==='Not reversible').length,
  };

  const recentlyAdded = tasks
    .slice().sort((a,b) => b.created.localeCompare(a.created)).slice(0,20)
    .map(({gid,name,assignee,created,completed}) => ({gid,name,assignee,created,completed}));

  const recentlyCommented = tasks
    .slice().sort((a,b) => b.modified.localeCompare(a.modified)).slice(0,20)
    .map(({gid,name,assignee,modified,completed}) => ({gid,name,assignee,modified,completed}));

  const aMap = {};
  for (const t of tasks) {
    if (t.assignee === 'Unassigned') continue;
    if (!aMap[t.assignee]) aMap[t.assignee] = {name:t.assignee,total:0,done:0,overdue:0};
    aMap[t.assignee].total++;
    if (t.overdue) aMap[t.assignee].overdue++;
  }
  const assignees = Object.values(aMap).sort((a,b) => b.total - a.total);

  const dowCreated = [0,0,0,0,0,0,0];
  for (const t of tasks) {
    if (t.created) dowCreated[(new Date(t.created+'T00:00:00Z').getUTCDay()+6)%7]++;
  }

  const sMap = {};
  for (const t of tasks) {
    if (!sMap[t.section]) sMap[t.section]={total:0};
    sMap[t.section].total++;
  }
  const topSections = Object.entries(sMap)
    .sort((a,b)=>b[1].total-a[1].total).slice(0,8)
    .map(([name,s])=>({name,total:s.total}));

  const wordCloud = buildWordCloud(open);

  const ACTION = new Set(['Action 5 days','Action 10 days','Action 30+ days','Action 90+ days','New Business']);
  const nowMs  = Date.now();
  const oldestTasks = open
    .filter(t=>ACTION.has(t.section))
    .map(t=>({name:t.name,gid:t.gid,created:t.created,
      age:Math.floor((nowMs-new Date(t.created+'T00:00:00Z').getTime())/86400000),
      assignee:t.assignee,section:t.section}))
    .sort((a,b)=>b.age-a.age);

  // Recent completed widget uses the full recentCompletedRaw (with names/assignees)
  const recentCompleted = recentCompletedRaw
    .filter(t=>t.completed_at&&t.assignee?.name&&t.assignee.name!=='Unassigned')
    .slice(0,20)
    .map(t=>({
      gid:t.gid, name:t.name,
      assignee:  t.assignee?.name ?? 'Unassigned',
      completedAt:(t.completed_at??'').slice(0,10),
      section:   t.memberships?.[0]?.section?.name ?? '',
    }));

  const sectionHtml = buildSectionHtml(open);

  return {
    kpis, recentlyAdded, recentlyCommented, assignees,
    kpiData: tasks, months, created: created_m, completed: compl_m,
    dowCreated, topSections, priorityCounts: pc,
    wordCloud, oldestTasks, recentCompleted, sectionHtml,
    generatedAt: new Date().toISOString(),
  };
}

// ─── Word cloud ───────────────────────────────────────────────────────────────

const STOP = new Set(['the','a','an','and','or','of','in','to','for','is','on','with',
  'that','at','by','from','it','as','are','was','be','this','have','has','had','will',
  'but','not','can','been','we','they','if','up','out','about','when','its','our','new',
  'all','there','would','their','into','also','after','being','some','then','need','use']);

function buildWordCloud(tasks) {
  const c = {};
  for (const t of tasks)
    for (const w of t.name.toLowerCase().replace(/[^a-z0-9\s]/g,'').split(/\s+/))
      if (w.length>=3 && !STOP.has(w)) c[w]=(c[w]??0)+1;
  return Object.entries(c).filter(([,n])=>n>=2).sort((a,b)=>b[1]-a[1]).slice(0,60);
}

// ─── Section HTML ─────────────────────────────────────────────────────────────

const CARD_COLORS   = ['#fc8181','#48bb78','#4299e1','#ecc94b','#9f7aea','#e879f9','#f6ad55','#68d391','#63b3ed','#f687b3','#38b2ac','#667eea'];
const PRIO_ORDER    = {High:0,Medium:1,Low:2};
const SECTION_ABBR  = {'New Business':'NB','Action 5 days':'A5','Action 10 days':'A10','Action 30+ days':'A30','Action 90+ days':'A90'};
const PRIO_STYLE    = {High:{bg:'#fc818122',fg:'#fc8181',bd:'#fc8181'},Medium:{bg:'#f6ad5522',fg:'#f6ad55',bd:'#f6ad55'},Low:{bg:'#68d39122',fg:'#68d391',bd:'#68d391'}};

function buildSectionHtml(open) {
  const byA = {};
  for (const t of open) {
    if (t.assignee==='Unassigned') continue;
    (byA[t.assignee]??=[]).push(t);
  }
  return Object.entries(byA)
    .sort(([,a],[,b])=>b.length-a.length)
    .map(([name,tasks],i) => {
      const color    = CARD_COLORS[i%CARD_COLORS.length];
      const initials = name.split(/[\s.@]+/).filter(Boolean).slice(0,2).map(p=>p[0].toUpperCase()).join('');
      const ov       = tasks.filter(t=>t.overdue);
      const pri      = tasks.filter(t=>!t.overdue).sort((a,b)=>(PRIO_ORDER[a.priority]??9)-(PRIO_ORDER[b.priority]??9)).slice(0,5);
      const ovRows   = ov.length  ? ov.map(taskRowHtml).join('') : `<tr><td style="padding:6px 10px;color:var(--text-faint);font-size:12px">None</td></tr>`;
      const priRows  = pri.length ? pri.map(taskRowHtml).join(''): `<tr><td style="padding:6px 10px;color:var(--text-faint);font-size:12px">None</td></tr>`;
      return `<div class="card" style="margin-bottom:0"><div style="display:flex;align-items:center;gap:12px;margin-bottom:16px"><div style="width:36px;height:36px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#fff;flex-shrink:0">${initials}</div><div><div style="font-weight:700;color:var(--text);font-size:14px">${esc(name)}</div><div style="font-size:11px;color:var(--text-faint)">${tasks.length} tasks &nbsp;·&nbsp; <span style="color:#fc8181">${ov.length} overdue</span></div></div></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:16px"><div><div style="font-size:11px;font-weight:700;color:var(--text-faint);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px">⚠ Overdue</div><table style="width:100%;border-collapse:collapse;font-size:12px">${ovRows}</table></div><div><div style="font-size:11px;font-weight:700;color:var(--text-faint);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px">🔺 Highest Priority</div><table style="width:100%;border-collapse:collapse;font-size:12px">${priRows}</table></div></div></div>`;
    }).join('\n');
}

function taskRowHtml(t) {
  const abbr = SECTION_ABBR[t.section];
  const badge = abbr ? `<span style="font-size:10px;padding:1px 6px;border-radius:99px;background:var(--border);color:var(--text-faint);margin-right:4px">${abbr}</span>` : '';
  const ps    = t.priority ? PRIO_STYLE[t.priority] : null;
  const pill  = ps ? `<span style="font-size:10px;padding:1px 6px;border-radius:99px;background:${ps.bg};color:${ps.fg};border:1px solid ${ps.bd};margin-left:4px">${t.priority}</span>` : '';
  const warn  = t.overdue&&t.due ? `<span style="font-size:10px;color:#fc8181;margin-left:6px">⚠ ${t.due}</span>` : '';
  return `<tr><td style="padding:6px 10px;border-bottom:1px solid var(--border);vertical-align:top"><div style="display:flex;flex-wrap:wrap;align-items:baseline;gap:2px">${badge}<a href="https://app.asana.com/0/${PROJECT_GID}/${t.gid}/f" target="_blank" rel="noopener" class="task-link-wrap">${esc(t.name)}</a>${pill}${warn}</div></td></tr>`;
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function jsonErr(msg, status) {
  return new Response(JSON.stringify({error:msg}), {status, headers:{'Content-Type':'application/json'}});
}

// ─── Static HTML shell ────────────────────────────────────────────────────────
// No inline data — the page fetches /api/data after load and renders client-side.

const HTML_SHELL = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DTS Leadership Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/wordcloud@1.2.2/src/wordcloud2.js"><\/script>
<style>
  :root {
    --bg:#0f1117; --bg-card:#1a1f35; --bg-header:linear-gradient(135deg,#1a1f35 0%,#252d45 100%);
    --border:#2d3748; --border-row:#1e2538; --text:#e2e8f0; --text-muted:#a0aec0;
    --text-faint:#718096; --text-faintest:#4a5568; --bar-track:#2d3748;
    --hover-row:#1e2538; --kpi-sub:#4a5568; --toggle-bg:#2d3748; --toggle-fg:#a0aec0;
    --pill-green-bg:#1c4532; --pill-green-fg:#68d391; --pill-yellow-bg:#3d2d00; --pill-yellow-fg:#f6e05e;
    --pill-red-bg:#3d1010;   --pill-red-fg:#fc8181;   --pill-blue-bg:#1a2f4a;  --pill-blue-fg:#63b3ed;
    --pill-gray-bg:#2d3748;  --pill-gray-fg:#a0aec0;
  }
  body.light {
    --bg:#f0f4f8; --bg-card:#ffffff; --bg-header:linear-gradient(135deg,#e8edf5 0%,#dde4ef 100%);
    --border:#d1d9e6; --border-row:#edf2f7; --text:#1a202c; --text-muted:#4a5568;
    --text-faint:#718096; --text-faintest:#a0aec0; --bar-track:#e2e8f0;
    --hover-row:#f7fafc; --kpi-sub:#a0aec0; --toggle-bg:#e2e8f0; --toggle-fg:#4a5568;
    --pill-green-bg:#c6f6d5; --pill-green-fg:#276749; --pill-yellow-bg:#fefcbf; --pill-yellow-fg:#744210;
    --pill-red-bg:#fed7d7;   --pill-red-fg:#9b2c2c;   --pill-blue-bg:#bee3f8;  --pill-blue-fg:#2b6cb0;
    --pill-gray-bg:#e2e8f0;  --pill-gray-fg:#4a5568;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;transition:background .25s,color .25s}
  .header{background:var(--bg-header);border-bottom:1px solid var(--border);padding:24px 32px;display:flex;align-items:center;justify-content:space-between}
  .header h1{font-size:24px;font-weight:700}
  .header .sub{font-size:13px;color:var(--text-faint);margin-top:4px}
  .badge{background:#e879f9;color:#fff;font-size:11px;font-weight:600;padding:4px 10px;border-radius:12px}
  .last-updated{font-size:12px;color:var(--text-faintest)}
  .theme-toggle{display:flex;align-items:center;gap:6px;background:var(--toggle-bg);color:var(--toggle-fg);border:1px solid var(--border);border-radius:20px;padding:6px 14px;font-size:13px;font-weight:600;cursor:pointer;transition:all .2s;user-select:none}
  .theme-toggle:hover{opacity:.8}
  .container{max-width:1400px;margin:0 auto;padding:28px 32px}
  .kpi-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:16px;margin-bottom:28px}
  .kpi{background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:20px;text-align:center;position:relative;overflow:hidden;transition:background .25s,border-color .25s;cursor:pointer}
  .kpi::before{content:'';position:absolute;top:0;left:0;right:0;height:3px}
  .kpi.blue::before{background:#4299e1}.kpi.green::before{background:#48bb78}
  .kpi.yellow::before{background:#ecc94b}.kpi.red::before{background:#fc8181}
  .kpi.purple::before{background:#9f7aea}.kpi.pink::before{background:#e879f9}
  .kpi .val{font-size:clamp(16px,3.2vw,36px);font-weight:800;line-height:1;margin-bottom:6px}
  .kpi.blue .val{color:#4299e1}.kpi.green .val{color:#48bb78}.kpi.yellow .val{color:#ecc94b}
  .kpi.red .val{color:#fc8181}.kpi.purple .val{color:#9f7aea}.kpi.pink .val{color:#e879f9}
  .kpi .label{font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px}
  .kpi .sub-val{font-size:11px;color:var(--kpi-sub)}
  .kpi:hover{opacity:.9}
  .card{background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:20px;transition:background .25s,border-color .25s}
  .card h2{font-size:13px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.07em;margin-bottom:14px;display:flex;align-items:center;gap:8px}
  .dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex-shrink:0}
  .charts-row{display:grid;gap:20px}
  .row-1{grid-template-columns:1fr}.row-2{grid-template-columns:1fr 1fr}
  .row-3{grid-template-columns:1fr 1fr 1fr}.row-4{grid-template-columns:1fr 1fr 1fr 1fr}
  .overdue-table{width:100%;border-collapse:collapse;font-size:13px}
  .overdue-table th{text-align:left;padding:6px 10px;font-size:11px;font-weight:700;color:var(--text-faint);text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid var(--border)}
  .overdue-table td{padding:8px 10px;border-bottom:1px solid var(--border-row);vertical-align:middle}
  .overdue-table tr:last-child td{border-bottom:none}
  .overdue-table tr:hover td{background:var(--hover-row)}
  .task-link-wrap{color:var(--text);text-decoration:none}
  .task-link-wrap:hover{color:#63b3ed;text-decoration:underline}
  .rc-card{transition:background .15s}
  .rc-card:hover{background:var(--hover-row)!important}
  .rc-card:hover .rc-link{color:#63b3ed!important}
  .pill{font-size:11px;padding:2px 8px;border-radius:99px;font-weight:600;white-space:nowrap}
  .pill-green{background:var(--pill-green-bg);color:var(--pill-green-fg)}
  .pill-yellow{background:var(--pill-yellow-bg);color:var(--pill-yellow-fg)}
  .pill-red{background:var(--pill-red-bg);color:var(--pill-red-fg)}
  .pill-blue{background:var(--pill-blue-bg);color:var(--pill-blue-fg)}
  .pill-gray{background:var(--pill-gray-bg);color:var(--pill-gray-fg)}
  .days-badge{font-size:11px;padding:2px 7px;border-radius:8px;font-weight:700;white-space:nowrap}
  .assignee-row{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border-row)}
  .assignee-row:last-child{border-bottom:none}
  .assignee-name{width:140px;font-size:12px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0}
  .assignee-bar-wrap{flex:1;height:8px;background:var(--bar-track);border-radius:4px;overflow:hidden;display:flex}
  .assignee-bar-done{height:100%;background:#48bb78;opacity:.4}
  .assignee-bar-open{height:100%;background:#4299e1}
  .assignee-bar-ov{height:100%;background:#fc8181}
  .assignee-count{width:28px;text-align:right;font-size:12px;font-weight:700;color:var(--text-muted);flex-shrink:0}
  .hide-completed .assignee-bar-done{display:none}
  .series-chip,.oldest-btn{background:none;border:1px solid var(--border);border-radius:99px;color:var(--text-faint);font-size:11px;padding:3px 10px;cursor:pointer;transition:all .15s}
  .series-chip:hover,.series-chip.active,.oldest-btn:hover,.oldest-btn.active{background:#4299e122;border-color:#4299e1;color:#4299e1}
  .toggle-hide-btn{display:flex;align-items:center;gap:6px;background:var(--toggle-bg);color:var(--toggle-fg);border:1px solid var(--border);border-radius:20px;padding:6px 14px;font-size:13px;font-weight:600;cursor:pointer;transition:all .2s;user-select:none}
  .toggle-hide-btn:hover{opacity:.8}
  .toggle-hide-btn.active{background:#4299e122;border-color:#4299e1;color:#4299e1}
  .modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9999;align-items:center;justify-content:center;padding:20px}
  .modal-overlay.open{display:flex}
  .modal-box{background:var(--bg-card);border:1px solid var(--border);border-radius:16px;width:100%;max-width:860px;max-height:85vh;display:flex;flex-direction:column;overflow:hidden}
  .modal-header{padding:18px 20px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;flex-shrink:0}
  .modal-title{font-size:16px;font-weight:700;flex:1}
  .modal-count{font-size:12px;color:var(--text-faint)}
  .modal-close{background:none;border:none;color:var(--text-faint);font-size:20px;cursor:pointer;line-height:1;padding:2px 6px;border-radius:4px}
  .modal-close:hover{background:var(--hover-row);color:var(--text)}
  .modal-search-wrap{padding:10px 20px;border-bottom:1px solid var(--border);flex-shrink:0}
  .modal-search{width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:8px 12px;font-size:13px;outline:none}
  .modal-search:focus{border-color:#4299e1}
  .modal-body{overflow-y:auto;flex:1}
  .modal-empty{text-align:center;padding:40px 20px;color:var(--text-faint);font-size:14px}
  /* Loading skeleton */
  .skeleton{border-radius:6px;background:linear-gradient(90deg,var(--border) 25%,var(--bg-card) 50%,var(--border) 75%);background-size:200% 100%;animation:shimmer 1.4s infinite}
  @keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
  #loadingMsg{text-align:center;padding:40px 20px}
  #loadingMsg .load-title{font-size:18px;font-weight:600;color:var(--text);margin-bottom:8px}
  #loadingMsg .load-sub{font-size:13px;color:var(--text-faint);margin-bottom:20px}
  #loadingMsg .load-bar-wrap{width:320px;height:6px;background:var(--border);border-radius:99px;margin:0 auto 12px;overflow:hidden}
  #loadingMsg .load-bar-fill{height:100%;background:linear-gradient(90deg,#4299e1,#9f7aea);border-radius:99px;transition:width .8s ease;width:3%}
  #loadingMsg .load-secs{font-size:28px;font-weight:800;color:#4299e1;line-height:1}
  #loadingMsg .load-secs-label{font-size:11px;color:var(--text-faintest);margin-top:4px}
  @keyframes spin{to{transform:rotate(360deg)}}
  .spinner{display:inline-block;width:16px;height:16px;border:2px solid var(--border);border-top-color:#4299e1;border-radius:50%;animation:spin .8s linear infinite;vertical-align:middle;margin-right:6px}
  @media(max-width:900px){.kpi-grid{grid-template-columns:repeat(3,1fr)}.row-4,.row-3{grid-template-columns:1fr 1fr}.row-2{grid-template-columns:1fr}.header{padding:16px;flex-wrap:wrap;gap:10px}.container{padding:16px}}
  @media(max-width:600px){.kpi-grid{grid-template-columns:repeat(2,1fr)}.row-4,.row-3,.row-2{grid-template-columns:1fr}}
</style>
</head>
<body class="hide-completed">

<!-- Top loading bar -->
<div id="loadingBar" style="position:fixed;top:0;left:0;height:3px;width:0;background:linear-gradient(90deg,#4299e1,#9f7aea,#e879f9);z-index:99999;transition:width .6s ease,opacity .4s"></div>

<div class="header">
  <div>
    <h1>DTS Leadership Dashboard <span style="font-size:11px;font-weight:400;color:#4a5568;margin-left:8px">v18 · loading…</span></h1>
    <div class="sub">Western Health Digital &amp; Technology Services</div>
  </div>
  <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
    <button class="toggle-hide-btn active" id="hideCompletedBtn" onclick="toggleHideCompleted()">Hide Completed</button>
    <button class="theme-toggle" onclick="toggleTheme()" id="themeBtn">☀️ Light Mode</button>
    <span class="badge">LIVE</span>
    <span class="last-updated" id="lastUpdated">Loading…</span>
    <button class="theme-toggle" onclick="try{localStorage.removeItem('dts-dash-v18')}catch(e){}location.reload()" style="font-size:12px;padding:4px 10px" title="Force-refresh from Asana (clears cache)">↻ Refresh</button>
  </div>
</div>

<div class="container">

  <!-- KPI Row -->
  <div class="kpi-grid" id="kpiGrid">
    <div class="kpi blue"><div class="val skeleton" style="height:36px;width:80px;margin:0 auto 6px"></div><div class="label">Total Tasks</div><div class="sub-val skeleton" style="height:12px;width:60px;margin:0 auto"></div></div>
    <div class="kpi green"><div class="val skeleton" style="height:36px;width:80px;margin:0 auto 6px"></div><div class="label">Completed</div><div class="sub-val skeleton" style="height:12px;width:60px;margin:0 auto"></div></div>
    <div class="kpi yellow"><div class="val skeleton" style="height:36px;width:80px;margin:0 auto 6px"></div><div class="label">Open</div><div class="sub-val skeleton" style="height:12px;width:60px;margin:0 auto"></div></div>
    <div class="kpi red"><div class="val skeleton" style="height:36px;width:80px;margin:0 auto 6px"></div><div class="label">Overdue</div><div class="sub-val skeleton" style="height:12px;width:60px;margin:0 auto"></div></div>
    <div class="kpi purple"><div class="val skeleton" style="height:36px;width:80px;margin:0 auto 6px"></div><div class="label">Due This Week</div><div class="sub-val skeleton" style="height:12px;width:60px;margin:0 auto"></div></div>
    <div class="kpi pink" style="cursor:default"><div class="val skeleton" style="height:36px;width:80px;margin:0 auto 6px"></div><div class="label">Members</div><div class="sub-val skeleton" style="height:12px;width:60px;margin:0 auto"></div></div>
  </div>

  <div id="loadingMsg">
    <div class="load-title"><span class="spinner"></span>Loading live data from Asana</div>
    <div class="load-sub">Fetching open tasks — takes ~15s on first load, instant when cached</div>
    <div class="load-bar-wrap"><div class="load-bar-fill" id="loadBarFill"></div></div>
    <div class="load-secs" id="loadSecs">0</div>
    <div class="load-secs-label">seconds</div>
  </div>
  <div id="dashContent" style="display:none">

  <!-- Recently Added + Active -->
  <div class="charts-row row-2" style="margin-bottom:20px">
    <div class="card">
      <h2><span class="dot" style="background:#63b3ed"></span>Recently Added Tasks</h2>
      <table class="overdue-table" style="table-layout:fixed">
        <colgroup><col style="width:55%"><col style="width:28%"><col style="width:17%"></colgroup>
        <thead><tr><th>Task</th><th>Assignee</th><th>Added</th></tr></thead>
        <tbody id="recentlyAddedBody"></tbody>
      </table>
    </div>
    <div class="card">
      <h2><span class="dot" style="background:#f6ad55"></span>Recently Active Tasks</h2>
      <table class="overdue-table" style="table-layout:fixed">
        <colgroup><col style="width:55%"><col style="width:28%"><col style="width:17%"></colgroup>
        <thead><tr><th>Task</th><th>Assignee</th><th>Updated</th></tr></thead>
        <tbody id="recentlyCommentedBody"></tbody>
      </table>
    </div>
  </div>

  <!-- Charts row 1: Task Completion + Custom Field Breakdown + Risk Profile -->
  <div class="charts-row row-3" style="margin-bottom:20px">
    <div class="card">
      <h2><span class="dot" style="background:#48bb78"></span>Task Completion</h2>
      <div style="position:relative;height:200px"><canvas id="donutChart"></canvas></div>
      <div style="display:flex;justify-content:center;gap:16px;margin-top:10px;flex-wrap:wrap;font-size:11px">
        <span style="color:#48bb78">● Done</span><span style="color:#4299e1">● Open</span><span style="font-size:11px;color:#fc8181">● Overdue</span>
      </div>
    </div>
    <div class="card"><h2><span class="dot" style="background:#e879f9"></span>Custom Field Breakdown</h2><div style="position:relative;height:220px"><canvas id="priorityChart"></canvas></div></div>
    <div class="card"><h2><span class="dot" style="background:#9f7aea"></span>Risk Profile</h2><div style="position:relative;height:220px"><canvas id="riskChart"></canvas></div></div>
  </div>

  <!-- Task Activity trend -->
  <div class="charts-row row-1" style="margin-bottom:20px">
    <div class="card"><h2><span class="dot" style="background:#63b3ed"></span>Task Activity — Last 24 Months</h2><div style="position:relative;height:220px"><canvas id="trendChart"></canvas></div></div>
  </div>

  <!-- Section + Overdue -->
  <div class="charts-row row-2" style="margin-bottom:20px">
    <div class="card"><h2><span class="dot" style="background:#f6ad55"></span>Tasks by Section</h2><div style="position:relative;height:220px"><canvas id="sectionChart"></canvas></div></div>
    <div class="card"><h2><span class="dot" style="background:#fc8181"></span>Overdue Tasks</h2><table class="overdue-table"><thead><tr><th>Task</th><th>Assignee</th><th>Due</th><th>Section</th></tr></thead><tbody id="overdueTableBody"></tbody></table></div>
  </div>

  <!-- Oldest open tasks -->
  <div class="charts-row row-1" style="margin-bottom:20px">
    <div class="card">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap">
        <h2 style="margin-bottom:0"><span class="dot" style="background:#f6ad55"></span>Oldest Open Tasks</h2>
        <div style="display:flex;gap:6px;margin-left:auto">
          <button class="oldest-btn active" data-n="10" onclick="updateOldestChart(10)">Top 10</button>
          <button class="oldest-btn" data-n="30" onclick="updateOldestChart(30)">Top 30</button>
          <button class="oldest-btn" data-n="50" onclick="updateOldestChart(50)">Top 50</button>
          <button class="oldest-btn" data-n="100" onclick="updateOldestChart(100)">Top 100</button>
        </div>
      </div>
      <table class="overdue-table" style="table-layout:fixed">
        <colgroup><col style="width:42%"><col style="width:8%"><col style="width:18%"><col style="width:14%"><col style="width:18%"></colgroup>
        <thead><tr><th>Task</th><th>Section</th><th>Assignee</th><th>Age</th><th>Created</th></tr></thead>
        <tbody id="oldestTableBody"></tbody>
      </table>
    </div>
  </div>

  <!-- Recently completed -->
  <div class="charts-row row-1" style="margin-bottom:20px">
    <div class="card">
      <h2><span class="dot" style="background:#48bb78"></span>Recently Completed Tasks <span style="font-size:11px;font-weight:400;text-transform:none;letter-spacing:0;color:var(--text-faint);margin-left:8px">last 20</span></h2>
      <div id="recentCompletedList" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:8px;max-height:420px;overflow-y:auto;padding-right:4px"></div>
    </div>
  </div>

  <!-- Assignee breakdown -->
  <div style="padding:0 0 20px">
    <div class="card" style="margin-bottom:16px">
      <h2><span class="dot" style="background:#4299e1"></span>Assignee Task Breakdown <span style="font-size:11px;font-weight:400;text-transform:none;letter-spacing:0;color:var(--text-faint);margin-left:8px">open tasks only</span></h2>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(560px,1fr));gap:16px" id="assigneeBreakdownGrid"></div>
    </div>
  </div>

  <!-- Most active + liked + DOW -->
  <div class="charts-row row-2" style="margin-bottom:20px">
    <!-- Most Liked Tasks on hold (num_likes not fetched) -->
    <div class="card"><h2><span class="dot" style="background:#f6ad55"></span>Task Volume: Day of Week (Created)</h2><div style="position:relative;height:200px"><canvas id="dowHeatChart"></canvas></div></div>
  </div>

  <!-- Word cloud -->
  <div class="charts-row row-1" style="margin-bottom:20px">
    <div class="card"><h2><span class="dot" style="background:#9f7aea"></span>Word Cloud — Open Task Names</h2><canvas id="wordCloudCanvas" width="1200" height="320" style="width:100%;max-height:320px"></canvas></div>
  </div>

  <!-- Assignee distribution -->
  <div class="charts-row row-2" style="margin-bottom:20px">
    <div class="card"><h2><span class="dot" style="background:#4299e1"></span>Assignee Distribution</h2><div id="assigneeList"></div></div>
    <div class="card"><h2><span class="dot" style="background:#63b3ed"></span>Assignee Chart</h2><div style="position:relative;height:280px"><canvas id="assigneeChartFull"></canvas></div></div>
  </div>

  </div><!-- /dashContent -->
</div><!-- /container -->

<!-- Modal -->
<div class="modal-overlay" id="modalOverlay">
  <div class="modal-box">
    <div class="modal-header"><span class="modal-title" id="modalTitle">Tasks</span><span class="modal-count" id="modalCount"></span><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="modal-search-wrap"><input class="modal-search" id="modalSearch" type="text" placeholder="Search tasks…" oninput="filterModal(this.value)"></div>
    <div class="modal-body"><table class="overdue-table" style="width:100%"><thead><tr><th>Task</th><th>Assignee</th><th>Section</th><th>Due</th><th>Status</th></tr></thead><tbody id="modalBody"></tbody></table><div class="modal-empty" id="modalEmpty" style="display:none">No tasks found</div></div>
  </div>
</div>

<script>
// ── Global error traps (remove once dashboard is stable) ─────────────────────
window.addEventListener('error', function(e) {
  const el = document.getElementById('loadingMsg');
  if (el) el.innerHTML = '<div style="background:#3d1010;border:1px solid #fc8181;border-radius:8px;padding:16px;color:#fc8181;font-size:13px;text-align:left;max-width:600px;margin:0 auto">'
    + '<strong>JS Error:</strong> ' + e.message
    + '<br><small style="opacity:.7">' + (e.filename||'') + ':' + e.lineno + '</small></div>';
});
window.addEventListener('unhandledrejection', function(e) {
  const el = document.getElementById('loadingMsg');
  if (el) el.innerHTML = '<div style="background:#3d1010;border:1px solid #fc8181;border-radius:8px;padding:16px;color:#fc8181;font-size:13px;text-align:left;max-width:600px;margin:0 auto">'
    + '<strong>Promise Error:</strong> ' + (e.reason||e) + '</div>';
});
// Immediate proof-of-life: if JS runs at all this changes the counter text
document.getElementById('loadSecs').textContent = 'JS';

const ASANA_BASE  = 'https://app.asana.com/0/${PROJECT_GID}';
const SECTION_ABBR = {'New Business':'NB','Action 5 days':'A5','Action 10 days':'A10','Action 30+ days':'A30','Action 90+ days':'A90'};

let kpiData = [], assignees = [], allOldestTasks = [], oldestLimit = 10;
let modalCurrentData = [];

// ── Loading bar ───────────────────────────────────────────────────────────────
function setBar(pct) {
  const bar = document.getElementById('loadingBar');
  if (!bar) return;
  bar.style.width = pct + '%';
  if (pct >= 100) setTimeout(() => { bar.style.opacity='0'; setTimeout(()=>bar.remove(),400); }, 300);
}
setBar(5);

// ── Bootstrap ─────────────────────────────────────────────────────────────────
// Fetches /api/data (cached 5 min at edge) and drives a calibrated progress bar.
// Each Asana page takes ~1s; ~23 pages total → ~23s cold, instant when cached.
// localStorage cache key — bump version when data structure changes
const LS_KEY     = 'dts-dash-v18';
const LS_TTL_MS  = 5 * 60 * 1000; // 5 min

function lsGet() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj; // { data, ts }
  } catch(e) { return null; }
}
function lsPut(data) {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ data, ts: Date.now() })); } catch(e) {}
}

function init() {
  const secsEl = document.getElementById('loadSecs');
  const fillEl = document.getElementById('loadBarFill');
  let   secs   = 0;
  let   ticker;

  function startTicker() {
    ticker = setInterval(() => {
      secs++;
      if (secsEl) secsEl.textContent = secs;
      const pct = Math.round(94 - 89 * Math.exp(-secs / 18));
      setBar(pct);
      if (fillEl) fillEl.style.width = pct + '%';
      if (secs === 35) {
        const msg = document.getElementById('loadingMsg');
        if (msg) msg.insertAdjacentHTML('beforeend',
          '<p style="margin-top:16px;color:#fc8181;font-size:13px">Taking longer than expected — '
          + '<button class="theme-toggle" onclick="location.reload()" style="font-size:12px;padding:3px 10px">↻ Refresh</button></p>');
      }
    }, 1000);
  }

  // ── Check localStorage first ──────────────────────────────────────────────
  const cached = lsGet();
  if (cached) {
    const age    = Date.now() - cached.ts;
    const isFresh = age < LS_TTL_MS;
    // Render immediately from cache
    setBar(100);
    try { populate(cached.data); } catch(e) { /* fall through to fresh fetch */ }
    const label = isFresh ? '⚡ cached' : '⚡ stale — refreshing';
    document.querySelector('h1 span').textContent = 'v18 · ' + label;

    if (isFresh) return; // done — cache is fresh, no need to refetch

    // Stale: refresh quietly in the background
    fetch('/api/data')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return;
        lsPut(data);
        document.querySelector('h1 span').textContent = 'v18 · refreshed';
      })
      .catch(() => {});
    return;
  }

  // ── No cache — full fetch with progress indicator ─────────────────────────
  startTicker();

  fetch('/api/data')
    .then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' from /api/data');
      return r.json();
    })
    .then(data => {
      clearInterval(ticker);
      setBar(100);
      lsPut(data); // save to localStorage so next load is instant
      const loadDiv = document.getElementById('loadingMsg');
      if (loadDiv) loadDiv.innerHTML = '<div class="load-title"><span class="spinner"></span>Rendering…</div>';
      try {
        populate(data);
        document.querySelector('h1 span').textContent = 'v18 · loaded in ' + secs + 's';
      } catch(renderErr) {
        const ld = document.getElementById('loadingMsg');
        if (ld) ld.innerHTML = '<div class="load-title" style="color:#fc8181">⚠ Render error</div>'
          + '<div class="load-sub">' + renderErr.message + '</div>'
          + '<pre style="font-size:10px;color:var(--text-faint);text-align:left;overflow:auto;max-width:600px;margin:12px auto">'
          + (renderErr.stack||'').slice(0,400) + '</pre>'
          + '<button class="theme-toggle" onclick="init()">↻ Retry</button>';
      }
    })
    .catch(err => {
      clearInterval(ticker);
      setBar(0);
      const loadDiv = document.getElementById('loadingMsg');
      if (loadDiv) loadDiv.innerHTML =
        '<div class="load-title" style="color:#fc8181">⚠ Failed to load data</div>'
        + '<div class="load-sub">' + err.message + '</div>'
        + '<br><button class="theme-toggle" onclick="init()">↻ Retry</button>';
    });
}

// ── Populate everything ───────────────────────────────────────────────────────
function populate(data) {
  kpiData        = data.kpiData;
  assignees      = data.assignees;
  allOldestTasks = data.oldestTasks;

  // KPIs
  const k = data.kpis;
  document.getElementById('kpiGrid').innerHTML =
    kpiCard('blue',  k.total,     'Total Tasks',   'All time',                 "openModal('all')")    +
    kpiCard('green', k.completed, 'Completed',     k.completionRate + '% rate',"openModal('completed')") +
    kpiCard('yellow',k.open,      'Open',          k.openRate + '% of total',  "openModal('open')")   +
    kpiCard('red',   k.overdue,   'Overdue',       'Need attention',            "openModal('overdue')")+
    kpiCard('purple',k.dueSoon,   'Due This Week', 'Next 14 days',             "openModal('due_soon')")+
    kpiCard('pink',  k.members,   'Members',       'Project team',             null);

  // Update time
  const d = new Date(data.generatedAt);
  document.getElementById('lastUpdated').textContent = 'Updated ' + d.toLocaleString('en-AU',{timeZone:'Australia/Melbourne',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});

  // Show content
  document.getElementById('loadingMsg').style.display = 'none';
  document.getElementById('dashContent').style.display = '';

  // Render all sections
  renderRecentTables(data.recentlyAdded, data.recentlyCommented);
  initCharts(data);
  renderOverdue();
  renderOldestTable();
  renderRecentCompleted(data.recentCompleted);
  document.getElementById('assigneeBreakdownGrid').innerHTML = data.sectionHtml;
  // renderLikes on hold
  renderWordCloud(data.wordCloud);
  renderAssigneeList();
}

function kpiCard(cls, val, label, sub, onclick) {
  const oc = onclick ? 'onclick="' + onclick + '" title="View tasks"' : 'style="cursor:default"';
  return '<div class="kpi ' + cls + '" ' + oc + '><div class="val">' + val + '</div><div class="label">' + label + '</div><div class="sub-val">' + sub + '</div></div>';
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function fmtRelDate(ds) {
  if (!ds) return '—';
  const diff = Math.round((Date.now() - new Date(ds + 'T00:00:00Z')) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7)  return diff + 'd ago';
  if (diff < 30) return Math.floor(diff/7) + 'w ago';
  if (diff < 365)return Math.floor(diff/30) + 'mo ago';
  return Math.floor(diff/365) + 'yr ago';
}
function taskLink(name, gid) {
  return '<a class="task-link-wrap" href="' + ASANA_BASE + '/' + gid + '/f" target="_blank" rel="noopener">' + name.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</a>';
}
function toggleTheme() {
  document.body.classList.toggle('light');
  document.getElementById('themeBtn').textContent = document.body.classList.contains('light') ? '🌙 Dark Mode' : '☀️ Light Mode';
}
function toggleHideCompleted() {
  const btn = document.getElementById('hideCompletedBtn');
  document.body.classList.toggle('hide-completed');
  const hiding = document.body.classList.contains('hide-completed');
  btn.classList.toggle('active', hiding);
  btn.textContent = hiding ? 'Hide Completed' : 'Show All';
  if (kpiData.length) {
    renderRecentTables(
      kpiData.slice().sort((a,b)=>b.created.localeCompare(a.created)).slice(0,20).map(({gid,name,assignee,created,completed})=>({gid,name,assignee,created,completed})),
      kpiData.slice().sort((a,b)=>b.modified.localeCompare(a.modified)).slice(0,20).map(({gid,name,assignee,modified,completed})=>({gid,name,assignee,modified,completed}))
    );
    renderAssigneeList();
    renderOldestTable();
  }
}

// ── Tables ────────────────────────────────────────────────────────────────────
function renderRecentTables(added, commented) {
  const hiding = document.body.classList.contains('hide-completed');
  const tdOvf  = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  const rowFn  = (t, dateKey) =>
    '<tr><td style="vertical-align:top;padding-top:10px">' + taskLink(t.name.trim(), t.gid) + '</td>' +
    '<td style="' + tdOvf + ';color:var(--text-muted)">' + (t.assignee||'—') + '</td>' +
    '<td style="white-space:nowrap">' + fmtRelDate(t[dateKey]) + '</td></tr>';
  const addedSrc    = hiding ? added.filter(t=>!t.completed)    : added;
  const commentSrc  = hiding ? commented.filter(t=>!t.completed): commented;
  document.getElementById('recentlyAddedBody').innerHTML     = addedSrc.slice(0,10).map(t=>rowFn(t,'created')).join('');
  document.getElementById('recentlyCommentedBody').innerHTML = commentSrc.slice(0,10).map(t=>rowFn(t,'modified')).join('');
}

function renderOverdue() {
  const ov    = kpiData.filter(t=>t.overdue).sort((a,b)=>(a.due||'').localeCompare(b.due||''));
  const tbody = document.getElementById('overdueTableBody');
  if (!ov.length) { tbody.innerHTML='<tr><td colspan="4" style="padding:16px;text-align:center;color:var(--text-faint)">No overdue tasks 🎉</td></tr>'; return; }
  tbody.innerHTML = ov.map(t => {
    const age = t.due ? Math.floor((Date.now()-new Date(t.due+'T00:00:00Z').getTime())/86400000) : 0;
    const col = age>90?'var(--pill-red-fg)':age>30?'#f6ad55':'var(--text-muted)';
    return '<tr><td>' + taskLink(t.name,t.gid) + '</td><td style="color:var(--text-muted)">' + (t.assignee||'—') + '</td><td style="white-space:nowrap;color:' + col + '">' + (t.due||'—') + '</td><td><span class="pill pill-gray">' + t.section + '</span></td></tr>';
  }).join('');
}

function renderOldestTable() {
  const hiding = document.body.classList.contains('hide-completed');
  document.querySelectorAll('.oldest-btn').forEach(b=>b.classList.toggle('active',parseInt(b.dataset.n)===oldestLimit));
  const slice  = allOldestTasks.slice(0,oldestLimit);
  const maxAge = slice.length ? Math.max(...slice.map(t=>t.age)) : 1;
  document.getElementById('oldestTableBody').innerHTML = slice.map(t => {
    const pct  = Math.round((t.age/maxAge)*100);
    const col  = t.age>2500?'#fc8181':t.age>2000?'#f6ad55':t.age>1500?'#ecc94b':'#63b3ed';
    const abbr = SECTION_ABBR[t.section]||t.section;
    const safe = t.name.replace(/&/g,'&amp;').replace(/</g,'&lt;');
    return '<tr><td style="vertical-align:middle"><a href="'+ASANA_BASE+'/'+t.gid+'/f" target="_blank" rel="noopener" class="task-link-wrap" title="'+safe+'">'+safe+'</a></td><td style="text-align:center"><span style="font-size:10px;padding:1px 6px;border-radius:99px;background:var(--border);color:var(--text-faint)">'+abbr+'</span></td><td style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-muted);font-size:12px">'+t.assignee+'</td><td style="white-space:nowrap"><span style="color:'+col+';font-weight:600;font-size:12px">'+((t.age/365).toFixed(1))+'yr</span><div style="height:4px;background:var(--border);border-radius:2px;margin-top:3px"><div style="height:4px;width:'+pct+'%;background:'+col+';border-radius:2px"></div></div></td><td style="white-space:nowrap;color:var(--text-faint);font-size:12px">'+t.created+'</td></tr>';
  }).join('');
}
function updateOldestChart(n) { oldestLimit=n; renderOldestTable(); }

function renderRecentCompleted(list) {
  const pal = ['#4299e1','#48bb78','#e879f9','#ecc94b','#fc8181','#9f7aea','#f6ad55','#63b3ed'];
  function color(name) { let h=0; for(let c of (name||'')) h=(h*31+c.charCodeAt(0))&0x7fffffff; return pal[h%pal.length]; }
  function initials(name) { if(!name||name==='Unassigned') return '?'; if(name.includes('@')) return name[0].toUpperCase(); const p=name.trim().split(/\s+/); return (p[0][0]+(p[1]?p[1][0]:'')).toUpperCase(); }
  function short(name) { if(!name||name==='Unassigned') return 'Unassigned'; if(name.includes('@')) return name.split('.')[0]; const p=name.trim().split(/\s+/); return p[0]+(p[1]?' '+p[1][0]+'.':''); }
  document.getElementById('recentCompletedList').innerHTML = list.map((t,i) => {
    const c=color(t.assignee), ini=initials(t.assignee), nm=short(t.assignee);
    const safe=t.name.replace(/&/g,'&amp;').replace(/</g,'&lt;');
    const sec=t.section?'<span style="font-size:10px;color:var(--text-faintest);margin-left:6px;background:var(--bar-track);padding:1px 6px;border-radius:10px">'+t.section+'</span>':'';
    return '<div class="rc-card" style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;background:var(--bg-card);border:1px solid var(--border)"><div style="width:20px;text-align:right;font-size:11px;font-weight:600;color:var(--text-faintest);flex-shrink:0">'+(i+1)+'</div><div style="width:34px;height:34px;border-radius:50%;background:'+c+';display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0">'+ini+'</div><div style="min-width:0;flex:1"><a class="rc-link" href="'+ASANA_BASE+'/'+t.gid+'/f" target="_blank" rel="noopener" style="color:var(--text);text-decoration:none;font-size:13px;font-weight:500;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><span style="color:#48bb78;margin-right:5px">✓</span>'+safe+'</a><div style="font-size:11px;color:var(--text-muted);margin-top:2px;display:flex;align-items:center;gap:6px"><span>'+nm+'</span>'+(t.completedAt?'<span style="color:var(--text-faintest)">· Completed '+t.completedAt+'</span>':'')+sec+'</div></div></div>';
  }).join('');
}

function renderLikes(likesData) {
  document.getElementById('likesTableBody').innerHTML = likesData.map(t =>
    '<tr><td><div style="max-width:260px">'+taskLink(t.name,t.gid)+'</div></td><td><span class="pill pill-gray">'+t.section+'</span></td><td style="text-align:center;color:#f0abfc;font-size:14px">'+'♥'.repeat(t.likes)+'</td></tr>'
  ).join('');
}

function renderAssigneeList() {
  const hiding = document.body.classList.contains('hide-completed');
  const el   = document.getElementById('assigneeList');
  if (!el) return;
  const vis  = hiding ? assignees.filter(a=>(a.total-a.done)>0) : assignees;
  const maxV = Math.max(...vis.map(a=>hiding?(a.total-a.done):a.total),1);
  el.innerHTML = vis.map(a => {
    const cnt    = hiding?(a.total-a.done):a.total;
    const pctD   = hiding?0:Math.round((a.done/maxV)*100);
    const pctO   = Math.round(((a.total-a.done-a.overdue)/maxV)*100);
    const pctOv  = Math.round((a.overdue/maxV)*100);
    const doneB  = hiding?'':'<div class="assignee-bar-done" style="width:'+pctD+'%"></div>';
    return '<div class="assignee-row"><div class="assignee-name" title="'+a.name+'">'+a.name+'</div><div class="assignee-bar-wrap">'+doneB+'<div class="assignee-bar-open" style="width:'+pctO+'%"></div><div class="assignee-bar-ov" style="width:'+pctOv+'%"></div></div><div class="assignee-count">'+cnt+'</div></div>';
  }).join('');
}

function renderWordCloud(wordCloudData) {
  const canvas = document.getElementById('wordCloudCanvas');
  if (typeof WordCloud === 'undefined' || !wordCloudData.length) return;
  WordCloud(canvas, {
    list: wordCloudData,
    gridSize: 8,
    weightFactor: n => Math.max(12, n * 2.5),
    fontFamily: 'sans-serif',
    color: (word) => { const pal=['#4299e1','#48bb78','#9f7aea','#ecc94b','#fc8181','#e879f9','#f6ad55','#63b3ed']; let h=0; for(let c of word) h=(h*31+c.charCodeAt(0))&0x7fffffff; return pal[h%pal.length]; },
    rotateRatio: 0.3, rotationSteps: 2, backgroundColor: 'transparent',
  });
}

// ── Charts ────────────────────────────────────────────────────────────────────
const chartPointer = (e, els) => { e.native.target.style.cursor = els.length ? 'pointer' : 'default'; };

function initCharts(data) {
  const k  = data.kpis;
  const pc = data.priorityCounts;

  // 1. Donut — Done / Open / Overdue with centre label
  const donutChart = new Chart(document.getElementById('donutChart'), {
    type: 'doughnut',
    data: { labels:['Done '+k.completed,'Open '+(k.open-k.overdue),'Overdue '+k.overdue],
            datasets:[{data:[k.completed, k.open-k.overdue, k.overdue],
              backgroundColor:['#48bb78','#4299e1','#fc8181'],
              borderColor:'transparent',borderWidth:0,spacing:3,hoverOffset:14,borderRadius:4}] },
    options: { cutout:'72%',
      plugins:{
        legend:{display:true,position:'bottom',labels:{color:'#a0aec0',usePointStyle:true,pointStyleWidth:8,padding:14,font:{size:11}}},
        tooltip:{callbacks:{label:ctx=>{const tot=ctx.dataset.data.reduce((a,b)=>a+b,0);return ' '+ctx.raw+' ('+((ctx.raw/tot)*100).toFixed(1)+'%)'}},
          backgroundColor:'rgba(15,17,23,.9)',titleColor:'#e2e8f0',bodyColor:'#a0aec0',borderColor:'#2d3748',borderWidth:1,padding:10,cornerRadius:8},
      },
      animation:{animateRotate:true,animateScale:true,duration:700,easing:'easeOutQuart'},
      responsive:true, maintainAspectRatio:false,
      onClick:(e,els,chart)=>{ if(!els.length)return; const i=els[0].index; const labels=['Done','Open','Overdue']; const fns=[t=>t.completed,t=>!t.completed&&!t.overdue,t=>t.overdue]; openModalWith(labels[i]+' Tasks',kpiData.filter(fns[i])); },
      onHover:chartPointer }
  });
  // Draw centre label
  Chart.register({id:'donutCentre',beforeDraw(chart){
    if(chart.canvas.id!=='donutChart') return;
    const {ctx,chartArea:{top,bottom,left,right}}=chart;
    const cx=(left+right)/2, cy=(top+bottom)/2;
    ctx.save();
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillStyle='#48bb78'; ctx.font='bold 22px sans-serif';
    ctx.fillText(k.completionRate+'%', cx, cy-8);
    ctx.fillStyle='#a0aec0'; ctx.font='11px sans-serif';
    ctx.fillText('COMPLETE', cx, cy+12);
    ctx.restore();
  }});

  // 2. Custom Field Breakdown (Priority + Consequence)
  new Chart(document.getElementById('priorityChart'), {
    type:'bar',
    data:{ labels:['High Priority','Medium Priority','Low Priority','High Consequence','Low Consequence'],
           datasets:[{label:'Tasks',data:[pc.high,pc.medium,pc.low,pc.highConseq,pc.lowConseq],
             backgroundColor:['#fc8181','#ecc94b','#68d391','#f6ad55','#4299e1'],borderRadius:6,borderSkipped:false}] },
    options:{ indexAxis:'y', plugins:{legend:{display:false}},
      scales:{x:{grid:{color:'#2d3748'},ticks:{color:'#718096'}},y:{grid:{display:false},ticks:{color:'#a0aec0'}}},
      responsive:true, maintainAspectRatio:false }
  });

  // 3. Risk Profile (Reversibility)
  new Chart(document.getElementById('riskChart'), {
    type:'bar',
    data:{ labels:['Reversible','Not Reversible'],
           datasets:[{label:'Tasks',data:[pc.reversible,pc.notReversible],backgroundColor:['#48bb78','#fc8181'],borderRadius:6,borderSkipped:false}] },
    options:{ indexAxis:'y', plugins:{legend:{display:false}},
      scales:{x:{grid:{color:'#2d3748'},ticks:{color:'#718096'}},y:{grid:{display:false},ticks:{color:'#a0aec0'}}},
      responsive:true, maintainAspectRatio:false }
  });

  // 4. Task Activity trend
  new Chart(document.getElementById('trendChart'), {
    type:'line',
    data:{ labels:data.months,
      datasets:[
        {label:'Created',  data:data.created,   borderColor:'#4299e1',backgroundColor:'rgba(66,153,225,.1)', fill:true,tension:.4,pointRadius:3,pointBackgroundColor:'#4299e1'},
        {label:'Completed',data:data.completed, borderColor:'#48bb78',backgroundColor:'rgba(72,187,120,.1)', fill:true,tension:.4,pointRadius:3,pointBackgroundColor:'#48bb78'},
      ]},
    options:{ plugins:{legend:{position:'top',labels:{color:'#a0aec0',usePointStyle:true,pointStyleWidth:8}}},
      scales:{x:{grid:{color:'#1e2538'},ticks:{color:'#4a5568',maxRotation:45}},y:{grid:{color:'#2d3748'},ticks:{color:'#718096'},beginAtZero:true}},
      responsive:true, maintainAspectRatio:false }
  });

  // 5. Top assignees mini (open tasks only)
  const topA = data.assignees.slice(0,12);
  new Chart(document.getElementById('assigneeChart'), {
    type:'bar',
    data:{ labels:topA.map(a=>a.name.split(' ')[0]), datasets:[{label:'Open',data:topA.map(a=>a.total-a.overdue),backgroundColor:'#4299e1',borderRadius:4,stack:'s'},{label:'Overdue',data:topA.map(a=>a.overdue),backgroundColor:'#fc8181',borderRadius:4,stack:'s'}] },
    options:{ plugins:{legend:{display:false}}, scales:{x:{grid:{display:false},ticks:{color:'#718096',maxRotation:45}},y:{grid:{color:'#2d3748'},ticks:{color:'#718096'}}}, responsive:true, maintainAspectRatio:false }
  });

  // Sections (open only)
  const secLabels = data.topSections.map(s=>s.name.replace('Post Incident Review (Week 2,4)','PIR').replace('High Impact (Week 1,3)','High Impact').replace('Action 5 days','A5d').replace('Action 10 days','A10d').replace('Action 30+ days','A30d+').replace('Action 90+ days','A90d+').replace('Propose to close','Propose Close').replace('Standing Items','Standing'));
  const secOpen = data.topSections.map(s=>kpiData.filter(t=>t.section===s.name).length);
  new Chart(document.getElementById('sectionChart'), {
    type:'bar',
    data:{ labels:secLabels, datasets:[{label:'Open',data:secOpen,backgroundColor:'#4299e1',borderRadius:4}] },
    options:{ plugins:{legend:{display:false}}, scales:{x:{grid:{display:false},ticks:{color:'#a0aec0'}},y:{grid:{color:'#2d3748'},ticks:{color:'#718096'},beginAtZero:true}}, responsive:true, maintainAspectRatio:false }
  });

  // DOW
  new Chart(document.getElementById('dowHeatChart'), {
    type:'bar',
    data:{ labels:['Mon','Tue','Wed','Thu','Fri','Sat','Sun'], datasets:[{label:'Tasks Created',data:data.dowCreated,backgroundColor:'#4299e1',borderRadius:4}] },
    options:{ plugins:{legend:{display:false}}, scales:{x:{grid:{display:false},ticks:{color:'#a0aec0'}},y:{grid:{color:'#2d3748'},ticks:{color:'#718096'},beginAtZero:true}}, responsive:true, maintainAspectRatio:false }
  });

  // Full assignee chart
  const fullA = data.assignees.slice(0,20);
  new Chart(document.getElementById('assigneeChartFull'), {
    type:'bar',
    data:{ labels:fullA.map(a=>a.name.includes('@')?a.name.split('.')[0]:a.name.split(' ')[0]), datasets:[{label:'Open',data:fullA.map(a=>a.total-a.overdue),backgroundColor:'#4299e1',borderRadius:3,stack:'s'},{label:'Overdue',data:fullA.map(a=>a.overdue),backgroundColor:'#fc8181',borderRadius:3,stack:'s'}] },
    options:{ plugins:{legend:{position:'top',labels:{color:'#a0aec0',usePointStyle:true}}}, scales:{x:{grid:{display:false},ticks:{color:'#718096',maxRotation:60}},y:{grid:{color:'#2d3748'},ticks:{color:'#718096'},beginAtZero:true}}, responsive:true, maintainAspectRatio:false }
  });
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function openModal(filter) {
  const titles={all:'All Tasks',open:'Open Tasks',completed:'Completed Tasks',overdue:'Overdue Tasks',due_soon:'Due in Next 14 Days'};
  const filters={all:()=>true,completed:t=>t.completed,open:t=>!t.completed,overdue:t=>t.overdue,due_soon:t=>t.dueSoon};
  openModalWith(titles[filter]||filter, kpiData.filter(filters[filter]||(()=>true)));
}
function openModalWith(title, tasks) {
  modalCurrentData=tasks;
  document.getElementById('modalTitle').textContent=title;
  document.getElementById('modalSearch').value='';
  renderModalRows(tasks);
  document.getElementById('modalOverlay').classList.add('open');
  setTimeout(()=>document.getElementById('modalSearch').focus(),50);
}
function closeModal() { document.getElementById('modalOverlay').classList.remove('open'); }
document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeModal(); });
function filterModal(q) {
  const ql=q.toLowerCase();
  renderModalRows(ql?modalCurrentData.filter(t=>t.name.toLowerCase().includes(ql)||t.assignee.toLowerCase().includes(ql)||t.section.toLowerCase().includes(ql)):modalCurrentData);
}
function renderModalRows(data) {
  const tbody=document.getElementById('modalBody');
  const empty=document.getElementById('modalEmpty');
  document.getElementById('modalCount').textContent=' '+data.length+' task'+(data.length!==1?'s':'');
  if(!data.length){tbody.innerHTML='';empty.style.display='block';return;}
  empty.style.display='none';
  tbody.innerHTML=data.map(t=>{
    const st=t.completed?'<span class="pill pill-green">Done</span>':t.overdue?'<span class="pill pill-red">Overdue</span>':t.dueSoon?'<span class="pill pill-yellow">Due Soon</span>':'<span class="pill pill-blue">Open</span>';
    const pr=t.priority?'<span style="font-size:10px;color:var(--text-faint);margin-left:4px">'+t.priority+'</span>':'';
    return '<tr><td style="padding:8px 10px;border-bottom:1px solid var(--border-row)">'+taskLink(t.name,t.gid)+pr+'</td><td style="padding:8px 10px;border-bottom:1px solid var(--border-row);color:var(--text-muted);white-space:nowrap;font-size:12px">'+t.assignee+'</td><td style="padding:8px 10px;border-bottom:1px solid var(--border-row);white-space:nowrap;font-size:12px">'+t.section+'</td><td style="padding:8px 10px;border-bottom:1px solid var(--border-row);white-space:nowrap;font-size:12px;color:var(--text-faint)">'+(t.due||'—')+'</td><td style="padding:8px 10px;border-bottom:1px solid var(--border-row)">'+st+'</td></tr>';
  }).join('');
}

// ── Start ─────────────────────────────────────────────────────────────────────
init();
</script>
</body>
</html>`;
