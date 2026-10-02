// SF50 costing editor — private Cloudflare Worker.
//
//   GET  /              the editor page
//   GET  /api/costing   current published costing + its git blob sha
//   POST /api/publish   validate, assign the next version, commit data/costing.json
//   GET  /api/status    publish workflow status for a commit
//
// Access control, in two layers:
//   1. Cloudflare Access sits in front of this workers.dev hostname (one-time
//      code e-mailed to an allowed address).
//   2. This Worker independently verifies the Access JWT on every request —
//      signature, audience, issuer, expiry, and the e-mail allowlist — and fails
//      CLOSED until ACCESS_TEAM_DOMAIN and ACCESS_AUD are configured.
//
// Secret: GITHUB_TOKEN — fine-grained, bopaero/sf50Program only, Contents
// read/write + Actions read. Never in this repo (it is public).

import SF50Costing from '../assets/costing.js';
import EDITOR_HTML from './editor.html';

const COSTING_PATH = 'data/costing.json';
const SITE = 'https://sf50program.bopaero.com';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let user;
    try {
      user = await authenticate(request, env);
    } catch (e) {
      return text(e.status || 401, e.message);
    }

    try {
      if (request.method === 'GET' && url.pathname === '/') {
        return new Response(EDITOR_HTML.replace('{{USER}}', escapeHtml(user)), { headers: pageHeaders() });
      }
      if (request.method === 'GET' && url.pathname === '/api/costing') {
        const { costing, sha } = await readCosting(env);
        return json(200, { costing, sha, user });
      }
      if (request.method === 'POST' && url.pathname === '/api/publish') {
        if (request.headers.get('Origin') !== url.origin) return json(403, { error: 'cross-origin request refused' });
        return json(...(await publish(await request.json(), env, user)));
      }
      if (request.method === 'GET' && url.pathname === '/api/market') {
        return json(200, await market(env));
      }
      if (request.method === 'GET' && url.pathname === '/api/status') {
        return json(200, await status(url.searchParams.get('commit'), env));
      }
      return text(404, 'not found');
    } catch (e) {
      console.error(e);
      return json(500, { error: String(e.message || e) });
    }
  }
};

// ── Access JWT verification ───────────────────────────────────────────────────
let certCache = { at: 0, keys: null };

async function authenticate(request, env) {
  const team = env.ACCESS_TEAM_DOMAIN, aud = env.ACCESS_AUD;
  if (!team || !aud) throw httpError(503, 'Editor is not connected to Cloudflare Access yet.');
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw httpError(401, 'Sign in through Cloudflare Access.');

  const [h64, p64, s64] = token.split('.');
  const header = JSON.parse(b64urlText(h64));
  const claims = JSON.parse(b64urlText(p64));
  if (header.alg !== 'RS256') throw httpError(401, 'Unexpected token algorithm.');

  const issuer = 'https://' + team;
  if (claims.iss !== issuer) throw httpError(401, 'Token issuer mismatch.');
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(aud)) throw httpError(401, 'Token audience mismatch.');
  const now = Math.floor(Date.now() / 1000);
  if (!(claims.exp > now) || (claims.nbf && claims.nbf > now + 60)) throw httpError(401, 'Sign-in expired — reload to sign in again.');

  const jwk = await accessKey(issuer, header.kid);
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(s64), new TextEncoder().encode(h64 + '.' + p64));
  if (!ok) throw httpError(401, 'Token signature invalid.');

  const email = String(claims.email || '').toLowerCase();
  const allowed = String(env.ALLOWED_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  if (!allowed.includes(email)) throw httpError(403, 'This account is not allowed to edit costing.');
  return email;
}

async function accessKey(issuer, kid) {
  if (!certCache.keys || Date.now() - certCache.at > 3600e3 || !certCache.keys.find(k => k.kid === kid)) {
    const r = await fetch(issuer + '/cdn-cgi/access/certs');
    if (!r.ok) throw httpError(503, 'Could not load Access signing keys.');
    certCache = { at: Date.now(), keys: (await r.json()).keys };
  }
  const k = certCache.keys.find(x => x.kid === kid);
  if (!k) throw httpError(401, 'Unknown token key.');
  return k;
}

// ── GitHub ────────────────────────────────────────────────────────────────────
async function gh(env, path, init = {}) {
  if (!env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN secret is not set on the Worker.');
  const r = await fetch('https://api.github.com/repos/' + env.GITHUB_REPO + path, {
    ...init,
    headers: {
      'Authorization': 'Bearer ' + env.GITHUB_TOKEN,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'sf50-costing-editor',
      ...(init.body ? { 'Content-Type': 'application/json' } : {})
    }
  });
  return r;
}

// Latest market check (data/market.json, written by the Market check workflow)
// and when that workflow last ran — it only commits when the market changed.
async function market(env) {
  const out = { market: null, lastRun: null };
  const r = await gh(env, '/contents/data/market.json?ref=main');
  if (r.ok) out.market = JSON.parse(decodeBase64Utf8((await r.json()).content));
  const runs = await gh(env, '/actions/workflows/market-check.yml/runs?per_page=1');
  if (runs.ok) {
    const run = (await runs.json()).workflow_runs[0];
    if (run) out.lastRun = { at: run.run_started_at || run.created_at, status: run.status, conclusion: run.conclusion, url: run.html_url };
  }
  return out;
}

async function readCosting(env) {
  const r = await gh(env, '/contents/' + COSTING_PATH + '?ref=main');
  if (!r.ok) throw new Error('GitHub read failed: HTTP ' + r.status);
  const file = await r.json();
  const costing = JSON.parse(decodeBase64Utf8(file.content));
  return { costing, sha: file.sha };
}

async function publish(body, env, user) {
  const draft = body && body.costing, baseSha = body && body.sha;
  const note = String((body && body.note) || '').trim().slice(0, 300);
  if (!draft || !baseSha) return [400, { error: 'costing and sha are required' }];
  if (!note) return [400, { error: 'Describe the change — it becomes the published change note.' }];

  const { costing: current, sha } = await readCosting(env);
  if (sha !== baseSha) return [409, { error: 'Costing was published from somewhere else since you opened the editor. Reload to start from the latest version.' }];

  // Only figures may change here. Programs are matched to the document's wording
  // by key, so adding, removing or renaming one needs a document change first.
  const keys = p => p.map(x => x.key).join('|');
  if (keys(draft.programs || []) !== keys(current.programs)) return [400, { error: 'Programs cannot be added, removed or renamed from the editor.' }];

  const next = {
    version: nextVersion(current.version),
    publishedAt: new Date().toISOString(),
    note,
    baseline: current.baseline,
    common: cleanCommon(draft.common),
    programs: draft.programs.map(cleanProgram),
    sensitivitySteps: current.sensitivitySteps
  };
  const problems = SF50Costing.validate(next);
  if (problems.length) return [400, { error: 'Not published: ' + problems.join('; ') }];

  const changes = diff(current, next);
  if (!changes.length) return [400, { error: 'Nothing changed — no new version published.' }];

  const message = 'Costing ' + next.version + ': ' + note + '\n\n' + changes.map(c => '- ' + c).join('\n') +
    '\n\nPublished from the costing editor by ' + user;
  const content = btoaUtf8(JSON.stringify(next, null, 2) + '\n');
  const r = await gh(env, '/contents/' + COSTING_PATH, {
    method: 'PUT',
    body: JSON.stringify({ message, content, sha, branch: 'main', committer: { name: 'SF50 Costing Editor', email: user } })
  });
  if (r.status === 409) return [409, { error: 'Costing changed while publishing. Reload and try again.' }];
  if (!r.ok) return [502, { error: 'GitHub commit failed: HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200) }];
  const out = await r.json();
  return [200, { version: next.version, commit: out.commit.sha, changes, site: SITE }];
}

async function status(commit, env) {
  if (!/^[0-9a-f]{40}$/.test(commit || '')) return { state: 'unknown' };
  const r = await gh(env, '/actions/runs?head_sha=' + commit + '&per_page=5');
  if (!r.ok) return { state: 'unknown', error: 'HTTP ' + r.status };
  const run = (await r.json()).workflow_runs.find(w => w.name === 'Publish');
  if (!run) return { state: 'queued' };
  if (run.status !== 'completed') return { state: 'building', url: run.html_url };
  return { state: run.conclusion === 'success' ? 'live' : 'failed', url: run.html_url };
}

// ── Versions and diffs ──────────────────────────────────────────────────────────
function easternDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function nextVersion(prev) {
  const today = easternDate();
  const m = /^v(\d{4}-\d{2}-\d{2})\.(\d+)$/.exec(prev || '');
  return 'v' + today + '.' + (m && m[1] === today ? Number(m[2]) + 1 : 1);
}
const LABELS = {
  fixedCost: 'Aircraft fixed-cost reference', jetstream: 'JetStream at acquisition', closing: 'Acquisition / closing',
  taxRate: 'Tax rate', approx: 'Approximate (pre-owned planning values)', shares: 'Shares available',
  acquisition: 'Aircraft acquisition value', connectivityCost: 'Connectivity installation cost',
  management: 'bop Aero management', reserve: 'Refresh / Future Value Reserve',
  basePrice: 'Cirrus base price', options: 'Options & equipment',
  market: 'Comparables', roundTo: 'Market price rounding', maxListingAgeDays: 'Listing age limit (days)'
};
function fmt(field, v) {
  if (v === undefined) return '—';
  if (field === 'market') return v.generation ? v.generation + ' ' + v.yearFrom + '–' + v.yearTo : JSON.stringify(v);
  if (field === 'maxListingAgeDays') return String(v);
  if (field === 'taxRate') return (v * 100).toFixed(2) + '%';
  if (field === 'shares' || typeof v === 'boolean') return String(v);
  return '$' + Math.round(v).toLocaleString('en-US');
}
function same(x, y) { return JSON.stringify(x) === JSON.stringify(y); }
function diff(a, b) {
  const out = [];
  const cm = Object.assign({}, a.common.market, b.common.market);
  for (const f of Object.keys(b.common)) {
    if (f === 'market') {
      for (const g of Object.keys(cm)) if (!same((a.common.market || {})[g], (b.common.market || {})[g]))
        out.push(LABELS[g] + ': ' + fmt(g, (a.common.market || {})[g]) + ' → ' + fmt(g, (b.common.market || {})[g]));
    } else if (!same(a.common[f], b.common[f])) out.push(LABELS[f] + ': ' + fmt(f, a.common[f]) + ' → ' + fmt(f, b.common[f]));
  }
  b.programs.forEach((p, i) => {
    const o = a.programs[i];
    const fields = new Set([...Object.keys(o), ...Object.keys(p)]);
    for (const f of fields) if (f !== 'key' && !same(o[f], p[f])) out.push(p.key + ' ' + LABELS[f] + ': ' + fmt(f, o[f]) + ' → ' + fmt(f, p[f]));
  });
  return out;
}
function pick(o, fields) { const r = {}; for (const f of fields) if (o && o[f] !== undefined) r[f] = o[f]; return r; }
// Rebuild each object field by field so nothing but known figures reaches the commit
function cleanCommon(c) {
  const out = pick(c, ['fixedCost', 'jetstream', 'closing', 'taxRate']);
  if (c && c.market) out.market = pick(c.market, ['roundTo', 'maxListingAgeDays']);
  return out;
}
function cleanProgram(p) {
  const out = pick(p, ['key', 'approx', 'shares', 'acquisition', 'basePrice', 'options', 'connectivityCost', 'management', 'reserve']);
  if (p && p.market) out.market = pick(p.market, ['generation', 'yearFrom', 'yearTo']);
  return out;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function b64urlBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
function b64urlText(s) { return new TextDecoder().decode(b64urlBytes(s)); }
function decodeBase64Utf8(b64) { return new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), c => c.charCodeAt(0))); }
function btoaUtf8(str) { let bin = ''; for (const b of new TextEncoder().encode(str)) bin += String.fromCharCode(b); return btoa(bin); }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
function text(status, body) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}
function pageHeaders() {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
    'Content-Security-Policy': [
      "default-src 'none'",
      "script-src 'unsafe-inline' " + SITE,
      "style-src 'unsafe-inline'",
      "connect-src 'self'",
      "frame-src " + SITE,
      "img-src 'self' data:",
      "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"
    ].join('; ')
  };
}
