// bop Aero costing editor — private Cloudflare Worker, one per account, serving
// every aircraft program behind the same Cloudflare Access login:
//
//   /          SF50 program  (bopaero/sf50Program)
//   /sr22t     SR22T program (bopaero/sr22tProgram, added 2026-10-04)
//
// For each aircraft, under its prefix:
//   GET  <prefix>/              the editor page
//   GET  <prefix>/api/costing   current published costing + its git blob sha
//   POST <prefix>/api/publish   validate, assign the next version, commit data/costing.json
//   GET  <prefix>/api/market    latest market check
//   GET  <prefix>/api/status    publish workflow status for a commit
//
// Access control, in two layers:
//   1. Cloudflare Access sits in front of this workers.dev hostname (one-time
//      code e-mailed to an allowed address).
//   2. This Worker independently verifies the Access JWT on every request —
//      signature, audience, issuer, expiry, and the e-mail allowlist — and fails
//      CLOSED until ACCESS_TEAM_DOMAIN and ACCESS_AUD are configured.
//
// Secrets: GITHUB_TOKEN — fine-grained, Contents read/write + Actions read on
// bopaero/sf50Program (and bopaero/sr22tProgram, unless GITHUB_TOKEN_SR22T is
// set for that repo). Never in these repos (they are public).

import SF50Costing from '../assets/costing.js';
import EDITOR_HTML from './editor.html';
import SR22TCosting from '../../sr22tProgram/assets/costing.js';
import SR22T_EDITOR_HTML from '../../sr22tProgram/admin/editor.html';

const COSTING_PATH = 'data/costing.json';

// Field lists rebuild every published object field by field, so nothing but
// known figures reaches a commit.
const AIRCRAFT = {
  sf50: {
    prefix: '', name: 'SF50', repo: env => env.GITHUB_REPO, token: env => env.GITHUB_TOKEN,
    lib: SF50Costing, html: EDITOR_HTML, site: 'https://sf50program.bopaero.com',
    common: ['fixedCost', 'jetstream', 'closing', 'taxRate', 'commissionRate', 'aircraftHours', 'aircraftDays'],
    program: ['key', 'approx', 'shares', 'sharesRemaining', 'acquisition', 'basePrice', 'options', 'connectivityCost', 'management', 'reserve'],
    programMarket: ['generation', 'yearFrom', 'yearTo']
  },
  sr22t: {
    prefix: '/sr22t', name: 'SR22T', repo: () => 'bopaero/sr22tProgram', token: env => env.GITHUB_TOKEN_SR22T || env.GITHUB_TOKEN,
    lib: SR22TCosting, html: SR22T_EDITOR_HTML,
    // Until sr22tprogram.bopaero.com has its DNS record the site is on github.io
    site: 'https://bopaero.github.io', sitePath: '/sr22tProgram',
    common: ['fixedCost', 'closing', 'taxRate', 'commissionRate'],
    program: ['key', 'approx', 'shares', 'sharesRemaining', 'maxHours', 'acquisition', 'basePrice', 'options', 'connectivityCost', 'management', 'reserve'],
    programMarket: null,
    // Bridge aircraft: figures editable; model, comparables model/generation/variation
    // and its features are structural and carry over from the published costing.
    bridge: ['value', 'monthlyLoan', 'monthlyInsurance', 'leaseRate', 'leaseMinRate', 'leaseHoursPerMonth'],
    bridgeMarket: ['yearFrom', 'yearTo']
  }
};
function aircraftFor(pathname) {
  if (pathname === '/sr22t' || pathname.startsWith('/sr22t/')) return AIRCRAFT.sr22t;
  return AIRCRAFT.sf50;
}

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
      const cfg = aircraftFor(url.pathname);
      const path = url.pathname.slice(cfg.prefix.length) || '/';
      if (cfg.prefix && url.pathname === cfg.prefix) return Response.redirect(url.origin + cfg.prefix + '/', 302);
      if (request.method === 'GET' && path === '/') {
        return new Response(cfg.html.replace('{{USER}}', escapeHtml(user)), { headers: pageHeaders(cfg) });
      }
      if (request.method === 'GET' && path === '/api/costing') {
        const { costing, sha } = await readCosting(env, cfg);
        return json(200, { costing, sha, user });
      }
      if (request.method === 'POST' && path === '/api/publish') {
        if (request.headers.get('Origin') !== url.origin) return json(403, { error: 'cross-origin request refused' });
        return json(...(await publish(await request.json(), env, user, cfg)));
      }
      if (request.method === 'GET' && path === '/api/market') {
        return json(200, await market(env, cfg));
      }
      if (request.method === 'GET' && path === '/api/status') {
        return json(200, await status(url.searchParams.get('commit'), env, cfg));
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
async function gh(env, cfg, path, init = {}) {
  const token = cfg.token(env);
  if (!token) throw new Error('GITHUB_TOKEN secret is not set on the Worker.');
  const r = await fetch('https://api.github.com/repos/' + cfg.repo(env) + path, {
    ...init,
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'bopaero-costing-editor',
      ...(init.body ? { 'Content-Type': 'application/json' } : {})
    }
  });
  return r;
}

// Latest market check (data/market.json, written by the Market check workflow)
// and when that workflow last ran — it only commits when the market changed.
async function market(env, cfg) {
  const out = { market: null, lastRun: null };
  const r = await gh(env, cfg, '/contents/data/market.json?ref=main');
  if (r.ok) out.market = JSON.parse(decodeBase64Utf8((await r.json()).content));
  const runs = await gh(env, cfg, '/actions/workflows/market-check.yml/runs?per_page=1');
  if (runs.ok) {
    const run = (await runs.json()).workflow_runs[0];
    if (run) out.lastRun = { at: run.run_started_at || run.created_at, status: run.status, conclusion: run.conclusion, url: run.html_url };
  }
  return out;
}

async function readCosting(env, cfg) {
  const r = await gh(env, cfg, '/contents/' + COSTING_PATH + '?ref=main');
  if (r.status === 404 || r.status === 403) throw new Error('GitHub read failed: HTTP ' + r.status + ' — the editor\'s GitHub token may not have access to ' + cfg.repo(env) + ' yet.');
  if (!r.ok) throw new Error('GitHub read failed: HTTP ' + r.status);
  const file = await r.json();
  const costing = JSON.parse(decodeBase64Utf8(file.content));
  return { costing, sha: file.sha };
}

async function publish(body, env, user, cfg) {
  const draft = body && body.costing, baseSha = body && body.sha;
  const note = String((body && body.note) || '').trim().slice(0, 300);
  if (!draft || !baseSha) return [400, { error: 'costing and sha are required' }];
  if (!note) return [400, { error: 'Describe the change — it becomes the published change note.' }];

  const { costing: current, sha } = await readCosting(env, cfg);
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
    common: cleanCommon(draft.common, cfg),
    programs: draft.programs.map((p, i) => keepStandard(cleanProgram(p, cfg), current.programs[i])),
    ...(cfg.bridge && current.bridge ? { bridge: cleanBridge(draft.bridge, current.bridge, cfg) } : {}),
    sensitivitySteps: current.sensitivitySteps,
    // Feature names are structural (the document and calculator lay them out); only
    // each program's status and detail are edited, so the labels carry over unchanged.
    // So does any feature marked standard (factory equipment): it is not editable.
    ...(current.featureLabels ? { featureLabels: current.featureLabels } : {})
  };
  const problems = cfg.lib.validate(next);
  if (problems.length) return [400, { error: 'Not published: ' + problems.join('; ') }];

  const changes = diff(current, next, cfg);
  if (!changes.length) return [400, { error: 'Nothing changed — no new version published.' }];

  const message = 'Costing ' + next.version + ': ' + note + '\n\n' + changes.map(c => '- ' + c).join('\n') +
    '\n\nPublished from the costing editor by ' + user;
  const content = btoaUtf8(JSON.stringify(next, null, 2) + '\n');
  const r = await gh(env, cfg, '/contents/' + COSTING_PATH, {
    method: 'PUT',
    body: JSON.stringify({ message, content, sha, branch: 'main', committer: { name: cfg.name + ' Costing Editor', email: user } })
  });
  if (r.status === 409) return [409, { error: 'Costing changed while publishing. Reload and try again.' }];
  if (!r.ok) return [502, { error: 'GitHub commit failed: HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200) }];
  const out = await r.json();
  return [200, { version: next.version, commit: out.commit.sha, changes, site: cfg.site + (cfg.sitePath || '') }];
}

async function status(commit, env, cfg) {
  if (!/^[0-9a-f]{40}$/.test(commit || '')) return { state: 'unknown' };
  const r = await gh(env, cfg, '/actions/runs?head_sha=' + commit + '&per_page=5');
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
  taxRate: 'Tax rate', commissionRate: 'Sales commission rate', approx: 'Approximate (pre-owned planning values)', shares: 'Shares available',
  acquisition: 'Aircraft acquisition value', connectivityCost: 'Connectivity installation cost',
  management: 'bop Aero management', reserve: 'Refresh / Future Value Reserve',
  basePrice: 'Cirrus base price', options: 'Options & equipment',
  sharesRemaining: 'Shares remaining (unsold)', aircraftHours: 'Aircraft scheduling hours (yearly)', aircraftDays: 'Aircraft scheduling days (yearly)',
  market: 'Comparables', features: 'Features', roundTo: 'Market price rounding', maxListingAgeDays: 'Listing age limit (days)',
  maxHours: 'Flying hours per share (yearly)',
  value: 'Bridge aircraft value', monthlyLoan: 'Bridge aircraft loan (monthly)', monthlyInsurance: 'Bridge aircraft insurance (monthly)',
  leaseRate: 'Bridge dry-lease rate (per hour)', leaseMinRate: 'Bridge minimum dry-lease rate (per hour)', leaseHoursPerMonth: 'Bridge dry-lease hours (monthly average)',
  yearFrom: 'Bridge comparables: model year from', yearTo: 'Bridge comparables: model year to'
};
function fmt(field, v) {
  if (v === undefined) return '—';
  if (field === 'market') return v.generation ? v.generation + ' ' + v.yearFrom + '–' + v.yearTo : JSON.stringify(v);
  if (field === 'features') return Object.keys(v).map(k => k + ' ' + SF50Costing.featureText(v[k])).join('; ');
  if (['maxHours', 'leaseHoursPerMonth', 'yearFrom', 'yearTo'].includes(field)) return String(v);
  if (field === 'maxListingAgeDays') return String(v);
  if (field === 'taxRate' || field === 'commissionRate') return (v * 100).toFixed(2) + '%';
  if (['shares', 'sharesRemaining', 'aircraftHours', 'aircraftDays'].includes(field) || typeof v === 'boolean') return String(v);
  return '$' + Math.round(v).toLocaleString('en-US');
}
function same(x, y) { return JSON.stringify(x) === JSON.stringify(y); }
function diff(a, b, cfg) {
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
    for (const f of fields) {
      if (f === 'key' || same(o[f], p[f])) continue;
      if (f === 'features') {
        const names = b.featureLabels || {};
        for (const k of new Set([...Object.keys(o.features || {}), ...Object.keys(p.features || {})])) {
          const x = (o.features || {})[k], y = (p.features || {})[k];
          if (same(x, y)) continue;
          const show = v => v ? '"' + cfg.lib.featureText(v) + '"' : '—';
          out.push(p.key + ' ' + (names[k] || k) + ': ' + show(x) + ' → ' + show(y));
        }
        continue;
      }
      out.push(p.key + ' ' + LABELS[f] + ': ' + fmt(f, o[f]) + ' → ' + fmt(f, p[f]));
    }
  });
  if (cfg.bridge && a.bridge && b.bridge) {
    for (const f of cfg.bridge) if (!same(a.bridge[f], b.bridge[f])) out.push(LABELS[f] + ': ' + fmt(f, a.bridge[f]) + ' → ' + fmt(f, b.bridge[f]));
    for (const f of cfg.bridgeMarket) if (!same((a.bridge.market || {})[f], (b.bridge.market || {})[f]))
      out.push(LABELS[f] + ': ' + fmt(f, (a.bridge.market || {})[f]) + ' → ' + fmt(f, (b.bridge.market || {})[f]));
  }
  return out;
}
function pick(o, fields) { const r = {}; for (const f of fields) if (o && o[f] !== undefined) r[f] = o[f]; return r; }
// Rebuild each object field by field so nothing but known figures reaches the commit
function cleanCommon(c, cfg) {
  const out = pick(c, cfg.common);
  if (c && c.market) out.market = pick(c.market, ['roundTo', 'maxListingAgeDays']);
  return out;
}
// A standard feature is factory equipment: whatever the client sends, keep it as published
function keepStandard(next, cur) {
  const std = Object.keys((cur && cur.features) || {}).filter(k => cur.features[k].standard);
  if (std.length) { next.features = next.features || {}; for (const k of std) next.features[k] = { ...cur.features[k] }; }
  return next;
}
function cleanBridge(b, cur, cfg) {
  const out = { model: cur.model, ...pick(b, cfg.bridge) };
  if (cur.market) out.market = { ...cur.market, ...pick((b && b.market) || {}, cfg.bridgeMarket) };
  if (cur.features) out.features = JSON.parse(JSON.stringify(cur.features));
  return out;
}
function cleanProgram(p, cfg) {
  const out = pick(p, cfg.program);
  if (p && p.market && cfg.programMarket) out.market = pick(p.market, cfg.programMarket);
  if (p && p.features) {
    out.features = {};
    for (const k of Object.keys(p.features)) {
      const f = pick(p.features[k], ['status', 'detail']);
      if (typeof f.detail === 'string') f.detail = f.detail.trim();
      if (f.detail === '') delete f.detail;          // blank detail = status wording alone
      out.features[k] = f;
    }
  }
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
function pageHeaders(cfg) {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
    'Content-Security-Policy': [
      "default-src 'none'",
      "script-src 'unsafe-inline' " + cfg.site,
      "style-src 'unsafe-inline'",
      "connect-src 'self'",
      "frame-src " + cfg.site,
      "img-src 'self' data:",
      "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"
    ].join('; ')
  };
}
