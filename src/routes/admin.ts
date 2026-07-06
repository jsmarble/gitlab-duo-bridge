/**
 * Admin dashboard routes.
 *
 * /admin          — HTML dashboard page
 * /admin/api/*    — JSON API endpoints for the dashboard
 *
 * No auth on these routes — relies on network isolation.
 * Never echoes PAT, direct-access token, or PROXY_API_KEY values.
 */

import { getState, setGitlabPat, clearGitlabPat } from "../store.ts";
import { listModels } from "../models.ts";
import { getActivity } from "../activity-log.ts";
import { config } from "../config.ts";
import {
  getDirectAccessToken,
} from "../gitlab-direct-access.ts";

// ---- HTML Dashboard ----

function maskPat(pat: string): string {
  if (pat.length <= 8) return "****";
  return pat.slice(0, 8) + "****" + pat.slice(-4);
}

function dashboardHtml(): string {
  const state = getState();
  const patStatus = state.gitlabPat
    ? `Configured (${maskPat(state.gitlabPat)})`
    : "Not configured";
  const proxyKeyStatus = config.proxyApiKey
    ? "Set via environment"
    : "NOT SET — proxy will reject all requests";

  const models = listModels();
  const modelRows = models
    .map(
      (m) =>
        `<tr>
          <td>${escHtml(m.id)}</td>
          <td>${escHtml(m.backend)}</td>
          <td>${escHtml(m.upstreamModel)}</td>
          <td>${escHtml(m.aliases.join(", "))}</td>
        </tr>`
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GitLab Duo Bridge — Admin</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; margin: 0; padding: 0; background: #f5f5f5; color: #333; }
    header { background: #1a1a2e; color: white; padding: 1rem 2rem; }
    header h1 { margin: 0; font-size: 1.4rem; }
    main { max-width: 960px; margin: 2rem auto; padding: 0 1rem; }
    .card { background: white; border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .card h2 { margin-top: 0; font-size: 1.1rem; color: #1a1a2e; border-bottom: 1px solid #eee; padding-bottom: 0.5rem; }
    .status-ok { color: #22863a; font-weight: 600; }
    .status-warn { color: #b08800; font-weight: 600; }
    .status-err { color: #cb2431; font-weight: 600; }
    label { display: block; margin-bottom: 0.25rem; font-size: 0.9rem; font-weight: 500; }
    input[type=password], input[type=text] { width: 100%; padding: 0.5rem; border: 1px solid #ccc; border-radius: 4px; font-size: 0.95rem; }
    .btn { padding: 0.5rem 1rem; border: none; border-radius: 4px; cursor: pointer; font-size: 0.9rem; }
    .btn-primary { background: #1a1a2e; color: white; }
    .btn-secondary { background: #eee; color: #333; }
    .btn-danger { background: #cb2431; color: white; }
    .btn + .btn { margin-left: 0.5rem; }
    .form-row { display: flex; gap: 0.5rem; align-items: flex-end; margin-top: 0.75rem; }
    .form-row input { flex: 1; }
    table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    th { text-align: left; padding: 0.5rem; background: #f0f0f0; }
    td { padding: 0.5rem; border-bottom: 1px solid #eee; }
    #activity-table td { font-family: monospace; font-size: 0.82rem; }
    #test-result, #save-result { margin-top: 0.5rem; font-size: 0.9rem; min-height: 1.2em; }
    .hint { font-size: 0.82rem; color: #666; margin-top: 0.25rem; }
    .meta-row { display: flex; gap: 2rem; margin-bottom: 1rem; }
    .meta-item label { color: #666; font-size: 0.8rem; margin-bottom: 0.1rem; }
    .meta-item .value { font-weight: 600; }
  </style>
</head>
<body>
  <header>
    <h1>🔗 GitLab Duo Bridge — Admin Dashboard</h1>
  </header>
  <main>

    <div class="card">
      <h2>GitLab PAT Configuration</h2>
      <div class="meta-row">
        <div class="meta-item">
          <label>Current Status</label>
          <div class="value" id="pat-status">${escHtml(patStatus)}</div>
        </div>
        <div class="meta-item">
          <label>Set At</label>
          <div class="value">${escHtml(state.gitlabPatSetAt ?? "—")}</div>
        </div>
      </div>
      <label for="pat-input">New PAT (starts with <code>glpat-</code>)</label>
      <div class="form-row">
        <input type="password" id="pat-input" placeholder="glpat-xxxxxxxxxxxxxxxxxxxx" autocomplete="off">
        <button class="btn btn-primary" onclick="savePat()">Save PAT</button>
        <button class="btn btn-secondary" onclick="testPat()">Test Connection</button>
        <button class="btn btn-danger" onclick="clearPat()">Clear PAT</button>
      </div>
      <div class="hint" id="pat-hint"></div>
      <div id="save-result"></div>
      <div id="test-result"></div>
    </div>

    <div class="card">
      <h2>Proxy API Key</h2>
      <p class="${config.proxyApiKey ? "status-ok" : "status-err"}">${escHtml(proxyKeyStatus)}</p>
    </div>

    <div class="card">
      <h2>Registered Models</h2>
      <table>
        <thead><tr><th>Model ID</th><th>Backend</th><th>Upstream Model</th><th>Aliases</th></tr></thead>
        <tbody>${modelRows}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>Recent Activity <small style="font-weight:normal;color:#888">(last 20, auto-refreshes)</small></h2>
      <table id="activity-table">
        <thead><tr><th>Time</th><th>Method</th><th>Path</th><th>Model</th><th>Status</th><th>Duration</th></tr></thead>
        <tbody id="activity-body"><tr><td colspan="6" style="color:#888">Loading…</td></tr></tbody>
      </table>
    </div>

  </main>

  <script>
    function setResult(id, msg, ok) {
      const el = document.getElementById(id);
      el.textContent = msg;
      el.style.color = ok === true ? '#22863a' : ok === false ? '#cb2431' : '#666';
    }

    function validatePatInput(val) {
      const hint = document.getElementById('pat-hint');
      if (!val) { hint.textContent = ''; return; }
      if (!val.startsWith('glpat-')) {
        hint.textContent = 'Hint: GitLab PATs typically start with glpat-. Other prefixes may work in some configurations.';
        hint.style.color = '#b08800';
      } else {
        hint.textContent = '';
      }
    }

    document.getElementById('pat-input').addEventListener('input', (e) => {
      validatePatInput(e.target.value);
    });

    async function savePat() {
      const val = document.getElementById('pat-input').value.trim();
      if (!val) { setResult('save-result', 'PAT cannot be empty.', false); return; }
      setResult('save-result', 'Saving…', null);
      try {
        const r = await fetch('/admin/api/pat', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({pat: val})
        });
        const j = await r.json();
        if (r.ok) {
          setResult('save-result', 'PAT saved successfully.', true);
          document.getElementById('pat-status').textContent = j.maskedPat || 'Configured';
          document.getElementById('pat-input').value = '';
        } else {
          setResult('save-result', 'Error: ' + (j.error || r.status), false);
        }
      } catch(e) { setResult('save-result', 'Network error: ' + e.message, false); }
    }

    async function testPat() {
      setResult('test-result', 'Testing connection…', null);
      try {
        const r = await fetch('/admin/api/pat/test', {method: 'POST'});
        const j = await r.json();
        if (r.ok && j.success) {
          setResult('test-result', 'Connection OK. Token expires at: ' + (j.expiresAt || 'unknown'), true);
        } else {
          setResult('test-result', 'Failed: ' + (j.error || 'Unknown error'), false);
        }
      } catch(e) { setResult('test-result', 'Network error: ' + e.message, false); }
    }

    async function clearPat() {
      if (!confirm('Clear the stored GitLab PAT? The proxy will stop working until a new PAT is configured.')) return;
      try {
        const r = await fetch('/admin/api/pat', {method: 'DELETE'});
        if (r.ok) {
          setResult('save-result', 'PAT cleared.', true);
          document.getElementById('pat-status').textContent = 'Not configured';
        } else {
          const j = await r.json();
          setResult('save-result', 'Error: ' + (j.error || r.status), false);
        }
      } catch(e) { setResult('save-result', 'Network error: ' + e.message, false); }
    }

    async function refreshActivity() {
      try {
        const r = await fetch('/admin/api/activity');
        if (!r.ok) return;
        const entries = await r.json();
        const tbody = document.getElementById('activity-body');
        if (!entries.length) {
          tbody.innerHTML = '<tr><td colspan="6" style="color:#888">No activity yet.</td></tr>';
          return;
        }
        tbody.innerHTML = entries.map(e =>
          '<tr>' +
          '<td>' + new Date(e.timestamp).toLocaleTimeString() + '</td>' +
          '<td>' + e.method + '</td>' +
          '<td>' + e.path + '</td>' +
          '<td>' + (e.model || '—') + '</td>' +
          '<td style="color:' + (e.statusCode < 400 ? '#22863a' : '#cb2431') + '">' + e.statusCode + '</td>' +
          '<td>' + e.durationMs + 'ms</td>' +
          '</tr>'
        ).join('');
      } catch {}
    }

    refreshActivity();
    setInterval(refreshActivity, 5000);
  </script>
</body>
</html>`;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---- Admin API handlers ----

export async function handleAdmin(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // Dashboard page
  if (path === "/admin" || path === "/admin/") {
    return new Response(dashboardHtml(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // API routes
  if (path === "/admin/api/status" && req.method === "GET") {
    return handleApiStatus();
  }
  if (path === "/admin/api/pat" && req.method === "POST") {
    return handleApiPatSet(req);
  }
  if (path === "/admin/api/pat/test" && req.method === "POST") {
    return handleApiPatTest();
  }
  if (path === "/admin/api/pat" && req.method === "DELETE") {
    return handleApiPatClear();
  }
  if (path === "/admin/api/models" && req.method === "GET") {
    return handleApiModels();
  }
  if (path === "/admin/api/activity" && req.method === "GET") {
    return handleApiActivity();
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}

function handleApiStatus(): Response {
  const state = getState();
  return Response.json({
    gitlabPatConfigured: state.gitlabPat !== null,
    gitlabPatSetAt: state.gitlabPatSetAt,
    proxyApiKeyConfigured: config.proxyApiKey !== "",
  });
}

async function handleApiPatSet(req: Request): Promise<Response> {
  let body: { pat?: string };
  try {
    body = (await req.json()) as { pat?: string };
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const pat = body.pat?.trim();
  if (!pat) {
    return Response.json(
      { error: "PAT cannot be empty" },
      { status: 400 }
    );
  }

  await setGitlabPat(pat);
  // Invalidate cached direct-access token so next request re-fetches
  const { invalidateDirectAccessToken } = await import(
    "../gitlab-direct-access.ts"
  );
  invalidateDirectAccessToken();

  return Response.json({
    success: true,
    maskedPat: maskPat(pat),
  });
}

async function handleApiPatTest(): Promise<Response> {
  const state = getState();
  if (!state.gitlabPat) {
    return Response.json(
      { success: false, error: "No PAT configured" },
      { status: 400 }
    );
  }

  try {
    // Force a fresh token fetch by invalidating first
    const { invalidateDirectAccessToken } = await import(
      "../gitlab-direct-access.ts"
    );
    invalidateDirectAccessToken();

    const token = await getDirectAccessToken();
    return Response.json({
      success: true,
      expiresAt: new Date(token.expiresAt * 1000).toISOString(),
    });
  } catch (err) {
    return Response.json(
      {
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
      },
      { status: 502 }
    );
  }
}

async function handleApiPatClear(): Promise<Response> {
  await clearGitlabPat();
  const { invalidateDirectAccessToken } = await import(
    "../gitlab-direct-access.ts"
  );
  invalidateDirectAccessToken();
  return Response.json({ success: true });
}

function handleApiModels(): Response {
  return Response.json(listModels());
}

function handleApiActivity(): Response {
  return Response.json(getActivity());
}
