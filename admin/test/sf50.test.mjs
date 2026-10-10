import worker from './worker.mjs';
import fs from 'node:fs';
const repo = process.env.REPO;
const costing = fs.readFileSync(repo + '/data/costing.json', 'utf8');
const enc = s => Buffer.from(s).toString('base64url');
const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]), hash: 'SHA-256' }, true, ['sign','verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1', alg: 'RS256' };
const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]), hash: 'SHA-256' }, true, ['sign']);
async function jwt(claims, key = kp.privateKey) {
  const h = enc(JSON.stringify({ alg: 'RS256', kid: 'k1' })), p = enc(JSON.stringify(claims));
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(h + '.' + p)));
  return h + '.' + p + '.' + Buffer.from(sig).toString('base64url');
}
const now = Math.floor(Date.now()/1000);
const good = { iss: 'https://team.cloudflareaccess.com', aud: ['aud1'], email: 'raymond@bopaero.com', exp: now + 600 };
let lastPut = null, sha = 'abc123';
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.endsWith('/cdn-cgi/access/certs')) return Response.json({ keys: [jwk] });
  if (url.includes('/contents/data/costing.json') && (!init.method || init.method === 'GET'))
    return Response.json({ sha, content: Buffer.from(costing).toString('base64') });
  if (url.includes('/contents/data/costing.json') && init.method === 'PUT') { lastPut = JSON.parse(init.body); return Response.json({ commit: { sha: 'f'.repeat(40) } }); }
  if (url.includes('/contents/data/market.json')) return Response.json({ content: Buffer.from(fs.readFileSync(repo + '/data/market.json')).toString('base64') });
  if (url.includes('/actions/workflows/market-check.yml/runs')) return Response.json({ workflow_runs: [{ run_started_at: '2026-10-02T11:15:00Z', status: 'completed', conclusion: 'success', html_url: 'x' }] });
  if (url.includes('/actions/runs')) return Response.json({ workflow_runs: [{ name: 'Publish', status: 'completed', conclusion: 'success', html_url: 'x' }] });
  throw new Error('unexpected fetch ' + url);
};
const env = { ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'aud1', ALLOWED_EMAILS: 'raymond@bopaero.com', GITHUB_TOKEN: 't', GITHUB_REPO: 'bopaero/sf50Program' };
const ORIGIN = 'https://sf50-costing.compilotrc.workers.dev';
async function call(path, { token, method = 'GET', body, origin = ORIGIN, e = env } = {}) {
  const headers = {}; if (token) headers['Cf-Access-Jwt-Assertion'] = token; if (method === 'POST') { headers['Origin'] = origin; headers['Content-Type'] = 'application/json'; }
  const r = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), e);
  const t = await r.text(); return { status: r.status, t, h: r.headers };
}
let pass = 0, fail = 0;
function check(name, cond, extra = '') { cond ? pass++ : fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + extra)); }
const T = await jwt(good);
let r;
r = await call('/', { token: T, e: { ...env, ACCESS_AUD: '' } }); check('fails closed until Access is configured (503)', r.status === 503, r.status);
r = await call('/');                                  check('no token → 401', r.status === 401, r.status);
r = await call('/', { token: await jwt(good, other.privateKey) }); check('forged signature → 401', r.status === 401, r.status);
r = await call('/', { token: await jwt({ ...good, aud: ['someone-else'] }) }); check('wrong audience → 401', r.status === 401, r.status);
r = await call('/', { token: await jwt({ ...good, iss: 'https://evil.cloudflareaccess.com' }) }); check('wrong issuer → 401', r.status === 401, r.status);
r = await call('/', { token: await jwt({ ...good, exp: now - 5 }) }); check('expired → 401', r.status === 401, r.status);
r = await call('/', { token: await jwt({ ...good, email: 'someone@gmail.com' }) }); check('email not on allowlist → 403', r.status === 403, r.status);
r = await call('/', { token: T }); check('signed in → editor page', r.status === 200 && r.t.includes('Signed in as raymond@bopaero.com'), r.status);
check('page sends CSP + no-frame headers', /frame-ancestors 'none'/.test(r.h.get('content-security-policy') || '') && r.h.get('x-frame-options') === 'DENY');
r = await call('/api/costing', { token: T }); check('reads published costing', r.status === 200 && JSON.parse(r.t).costing.version === JSON.parse(costing).version);
const base = JSON.parse(costing);
const edited = structuredClone(base); edited.programs[1].acquisition = 2500000;
r = await call('/api/publish', { token: T, method: 'POST', body: { costing: edited, sha, note: 'x' }, origin: 'https://evil.example' }); check('cross-origin publish → 403', r.status === 403, r.status);
r = await call('/api/publish', { token: T, method: 'POST', body: { costing: base, sha, note: 'x' } }); check('no change → 400', r.status === 400 && /Nothing changed/.test(r.t), r.t);
r = await call('/api/publish', { token: T, method: 'POST', body: { costing: edited, sha, note: '' } }); check('missing note → 400', r.status === 400, r.t);
r = await call('/api/publish', { token: T, method: 'POST', body: { costing: edited, sha: 'stale', note: 'x' } }); check('stale base (someone else published) → 409', r.status === 409, r.t);
const added = structuredClone(base); added.programs.push({ ...base.programs[0], key: 'G4' });
r = await call('/api/publish', { token: T, method: 'POST', body: { costing: added, sha, note: 'x' } }); check('adding a program → 400', r.status === 400, r.t);
const bad = structuredClone(base); bad.programs[0].shares = 0;
r = await call('/api/publish', { token: T, method: 'POST', body: { costing: bad, sha, note: 'x' } }); check('invalid figure (0 shares) → 400', r.status === 400 && /shares/.test(r.t), r.t);
const sneaky = structuredClone(edited); sneaky.version = 'v1999-01-01.1'; sneaky.programs[1].injected = '<script>';
r = await call('/api/publish', { token: T, method: 'POST', body: { costing: sneaky, sha, note: 'G2 price update' } });
const out = JSON.parse(r.t);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
check('valid change publishes', r.status === 200, r.t);
const committed = JSON.parse(Buffer.from(lastPut.content, 'base64').toString());
const pv = /^v(\d{4}-\d{2}-\d{2})\.(\d+)$/.exec(JSON.parse(costing).version);
const expectV = 'v' + today + '.' + (pv[1] === today ? Number(pv[2]) + 1 : 1);
check('server assigns the version (ignores client version)', committed.version === expectV && out.version === committed.version, committed.version + ' expected ' + expectV);
check('unknown fields are dropped', !('injected' in committed.programs[1]));
check('only G2 acquisition changed in the committed file', committed.programs[1].acquisition === 2500000 && JSON.stringify({...committed.programs[1], acquisition: 2600000}) === JSON.stringify(base.programs[1]));
check('commit message lists the change', /G2 Aircraft acquisition value: \$2,600,000 → \$2,500,000/.test(lastPut.message) && /G2 price update/.test(lastPut.message), lastPut.message);
check('commit based on the sha it read (no overwrite)', lastPut.sha === sha);
r = await call('/api/status?commit=' + 'f'.repeat(40), { token: T }); check('status reports live', JSON.parse(r.t).state === 'live', r.t);

// ── New fields (2026-10-02): G3 base + options, comparables, sanitizing, market endpoint
const g3 = structuredClone(base); g3.programs[3].basePrice = 2950000;
r = await call('/api/publish', { token: T, method: 'POST', body: { costing: g3, sha, note: 'Cirrus base price increase' } });
let c2 = JSON.parse(Buffer.from(lastPut.content, 'base64').toString());
check('G3 base price change publishes', r.status === 200, r.t);
check('G3 keeps options, no stray acquisition', c2.programs[3].basePrice === 2950000 && c2.programs[3].options === 835000 && !('acquisition' in c2.programs[3]));
check('commit message names the base price change', /G3 Cirrus base price: \$2,850,000 → \$2,950,000/.test(lastPut.message), lastPut.message);
const yrs = structuredClone(base); yrs.programs[2].market.yearTo = 2024; yrs.programs[2].market.hack = 'x'; yrs.common.market.evil = 1;
r = await call('/api/publish', { token: T, method: 'POST', body: { costing: yrs, sha, note: 'widen G2+' } });
c2 = JSON.parse(Buffer.from(lastPut.content, 'base64').toString());
check('comparables change publishes and is listed', r.status === 200 && /G2\+ Comparables: G2\+ 2021–2023 → G2\+ 2021–2024/.test(lastPut.message), lastPut.message);
check('unknown nested fields are dropped', !('hack' in c2.programs[2].market) && !('evil' in c2.common.market));
const both = structuredClone(base); both.programs[3].acquisition = 3685000;
r = await call('/api/publish', { token: T, method: 'POST', body: { costing: both, sha, note: 'x' } });
check('acquisition AND base+options on one program → 400', r.status === 400, r.t);
r = await call('/api/market', { token: T });
const mk = JSON.parse(r.t);
check('market endpoint returns the snapshot and last run', r.status === 200 && mk.market && mk.market.programs.G1 && mk.lastRun.conclusion === 'success', r.t.slice(0, 200));
r = await call('/api/market');
check('market endpoint requires sign-in', r.status === 401, r.status);

// ── Features: status sets the wording, optional detail (2026-10-02)
const ft = structuredClone(base); ft.programs[1].features.safeReturn = { status: 'included', detail: '  on every G2  ', sneaky: 'x' };
r = await call('/api/publish', { token: T, method: 'POST', body: { costing: ft, sha, note: 'G2 Safe Return now required' } });
let c3 = JSON.parse(Buffer.from(lastPut.content, 'base64').toString());
check('feature change publishes', r.status === 200, r.t);
check('feature detail trimmed, unknown feature fields dropped', c3.programs[1].features.safeReturn.detail === 'on every G2' && !('sneaky' in c3.programs[1].features.safeReturn), JSON.stringify(c3.programs[1].features));
check('feature labels carried over unchanged', JSON.stringify(c3.featureLabels) === JSON.stringify(base.featureLabels));
check('commit lists the feature change in the shown wording', /G2 Garmin Safe Return emergency autoland: "Depends on aircraft · standard from 2020" → "Included · on every G2"/.test(lastPut.message), lastPut.message);
const blank = structuredClone(base); blank.programs[1].features.safeReturn.detail = '   ';
r = await call('/api/publish', { token: T, method: 'POST', body: { costing: blank, sha, note: 'drop detail' } });
c3 = JSON.parse(Buffer.from(lastPut.content, 'base64').toString());
check('blank detail is removed, status wording alone', r.status === 200 && !('detail' in c3.programs[1].features.safeReturn), r.t);
const old = structuredClone(base); old.programs[0].features.connectivity.note = 'stale note';
r = await call('/api/publish', { token: T, method: 'POST', body: { costing: old, sha, note: 'x' } });
c3 = JSON.parse(Buffer.from(lastPut.content, 'base64').toString());
check('a legacy note field never reaches the commit', r.status === 400 || !('note' in c3.programs[0].features.connectivity), r.t);
const rep = structuredClone(base); rep.programs[1].features.connectivity.detail = 'Included';
r = await call('/api/publish', { token: T, method: 'POST', body: { costing: rep, sha, note: 'x' } });
check('detail that only repeats a status → 400', r.status === 400 && /repeats a status/.test(r.t), r.t);
const long = structuredClone(base); long.programs[1].features.connectivity.detail = 'x'.repeat(81);
r = await call('/api/publish', { token: T, method: 'POST', body: { costing: long, sha, note: 'x' } });
check('over-long detail → 400', r.status === 400 && /detail must be/.test(r.t), r.t);
const badf = structuredClone(base); badf.programs[0].features.connectivity.status = 'maybe';
r = await call('/api/publish', { token: T, method: 'POST', body: { costing: badf, sha, note: 'x' } });
check('invalid feature status → 400', r.status === 400 && /status must be/.test(r.t), r.t);
const lab = structuredClone(base); lab.featureLabels = { connectivity: 'Hacked label' }; lab.programs[0].shares = 3;
r = await call('/api/publish', { token: T, method: 'POST', body: { costing: lab, sha, note: 'x' } });
c3 = JSON.parse(Buffer.from(lastPut.content, 'base64').toString());
check('client cannot rename features', r.status === 200 && c3.featureLabels.connectivity === 'In-flight connectivity', JSON.stringify(c3.featureLabels));
// ── Standard (factory) features are not editable (2026-10-02)
const st = structuredClone(base); st.programs[3].features.safeReturn = { status: 'excluded', detail: 'removed' }; delete st.programs[2].features.connectivity.standard; st.programs[0].shares = 3;
r = await call('/api/publish', { token: T, method: 'POST', body: { costing: st, sha, note: 'try to edit standard' } });
c3 = JSON.parse(Buffer.from(lastPut.content, 'base64').toString());
check('standard features kept as published whatever the client sends', r.status === 200 && JSON.stringify(c3.programs[3].features.safeReturn) === '{"status":"included","standard":true}' && c3.programs[2].features.connectivity.standard === true, JSON.stringify(c3.programs.map(p => p.features)));
check('standard-feature edit not listed as a change', !/G3 Garmin|G2\+ In-flight/.test(lastPut.message), lastPut.message);
const sd = structuredClone(base); sd.programs[0].features.connectivity.standard = true;
r = await call('/api/publish', { token: T, method: 'POST', body: { costing: sd, sha, note: 'x' } });
c3 = JSON.parse(Buffer.from(lastPut.content, 'base64').toString());
check('client cannot mark a feature standard', r.status === 400 || !c3.programs[0].features.connectivity.standard, r.t);
// ── Scheduling + shares remaining live in the costing (2026-10-04)
const sold = structuredClone(base); sold.programs[3].sharesRemaining = 7; sold.common.aircraftHours = 1500;
r = await call('/api/publish', { token: T, method: 'POST', body: { costing: sold, sha, note: 'G3 share sold; 1,500 hours' } });
c3 = JSON.parse(Buffer.from(lastPut.content, 'base64').toString());
check('shares remaining + scheduling publish', r.status === 200 && c3.programs[3].sharesRemaining === 7 && c3.common.aircraftHours === 1500 && c3.common.aircraftDays === 280, r.t);
check('commit lists both changes', /G3 Shares remaining \(unsold\): 8 → 7/.test(lastPut.message) && /Aircraft scheduling hours \(yearly\): 1400 → 1500/.test(lastPut.message), lastPut.message);
const over = structuredClone(base); over.programs[0].sharesRemaining = 3;
r = await call('/api/publish', { token: T, method: 'POST', body: { costing: over, sha, note: 'x' } });
check('more remaining than available → 400', r.status === 400 && /more shares remaining/.test(r.t), r.t);
const gone = structuredClone(base); delete gone.common.aircraftDays; gone.programs[0].management = 151000;
r = await call('/api/publish', { token: T, method: 'POST', body: { costing: gone, sha, note: 'x' } });
check('missing scheduling days → 400', r.status === 400 && /aircraftDays/.test(r.t), r.t);
// ── Sales commission rate (2026-10-04)
const com = structuredClone(base); com.common.commissionRate = 0.03;
r = await call('/api/publish', { token: T, method: 'POST', body: { costing: com, sha, note: 'commission agreed' } });
c3 = JSON.parse(Buffer.from(lastPut.content, 'base64').toString());
check('commission rate publishes', r.status === 200 && c3.common.commissionRate === 0.03, r.t);
check('commit lists the commission rate', /Sales commission rate: 0\.00% → 3\.00%/.test(lastPut.message), lastPut.message);
const comBad = structuredClone(base); comBad.common.commissionRate = 0.5;
r = await call('/api/publish', { token: T, method: 'POST', body: { costing: comBad, sha, note: 'x' } });
check('commission rate over 10% → 400', r.status === 400 && /commissionRate/.test(r.t), r.t);
// ── Founder's Circle settings + summary (2026-10-10)
r = await call('/founders', { token: T });
check('Founder summary page served behind Access', r.status === 200 && /Founder.s Circle Economic/.test(r.t) && /script-src[^;]*sr22tprogram\.bopaero\.com/.test(r.h.get('content-security-policy')), r.status + ' ' + r.h.get('content-security-policy'));
r = await call('/founders');
check('Founder summary refused without sign-in', r.status === 401, r.status);
const fo = structuredClone(base); fo.common.founders.premiumRate = 0.3; fo.programs[3].founders.positions = 3; fo.common.founders.sneaky = 1;
r = await call('/api/publish', { token: T, method: 'POST', body: { costing: fo, sha, note: 'Founder premium 30%' } });
c3 = JSON.parse(Buffer.from(lastPut.content, 'base64').toString());
check('Founder settings publish (unknown keys dropped)', r.status === 200 && c3.common.founders.premiumRate === 0.3 && c3.programs[3].founders.positions === 3 && !('sneaky' in c3.common.founders), r.t);
check('commit lists Founder changes', /Founder annual premium: 25\.00% → 30\.00%/.test(lastPut.message) && /G3 Founder's Circle positions: 2 → 3/.test(lastPut.message), lastPut.message);
const fbad = structuredClone(base); fbad.programs[3].founders.positions = 9;
r = await call('/api/publish', { token: T, method: 'POST', body: { costing: fbad, sha, note: 'x' } });
check('more Founder positions than shares → 400', r.status === 400 && /more Founder positions than shares/.test(r.t), r.t);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
