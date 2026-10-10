import worker from './worker.mjs';
import fs from 'node:fs';
const repo = process.env.REPO, srRepo = process.env.SR_REPO;
const costing = fs.readFileSync(repo + '/data/costing.json', 'utf8');
const srCosting = fs.readFileSync(srRepo + '/data/costing.json', 'utf8');
let lastRepo = null;
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
  const sr = url.includes('/repos/bopaero/sr22tProgram/');
  if (url.includes('/contents/data/costing.json') && (!init.method || init.method === 'GET'))
    return Response.json({ sha, content: Buffer.from(sr ? srCosting : costing).toString('base64') });
  if (url.includes('/contents/data/costing.json') && init.method === 'PUT') { lastPut = JSON.parse(init.body); lastRepo = sr ? 'sr22t' : 'sf50'; return Response.json({ commit: { sha: 'f'.repeat(40) } }); }
  if (url.includes('/contents/data/market.json')) return Response.json({ content: Buffer.from(fs.readFileSync((sr ? srRepo : repo) + '/data/market.json')).toString('base64') });
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
let r, c;
const parse = () => JSON.parse(Buffer.from(lastPut.content, 'base64').toString());
r = await call('/sr22t');                               check('no token → 401 on /sr22t too', r.status === 401, r.status);
r = await call('/sr22t', { token: T });                 check('/sr22t redirects to /sr22t/', r.status === 302 && /\/sr22t\/$/.test(r.h.get('location')), r.status);
r = await call('/sr22t/', { token: T });                check('SR22T editor page served', r.status === 200 && /SR22T Costing Editor/.test(r.t) && r.t.includes('raymond@bopaero.com'), r.status);
check('SR22T page CSP allows its document site', /frame-src https:\/\/sr22tprogram\.bopaero\.com/.test(r.h.get('content-security-policy')), r.h.get('content-security-policy'));
r = await call('/', { token: T });                      check('SF50 editor still at /', r.status === 200 && /SF50 Costing Editor/.test(r.t), r.status);
r = await call('/sr22t/api/costing', { token: T });     const base = JSON.parse(r.t).costing;
check('SR22T costing read from bopaero/sr22tProgram', r.status === 200 && base.programs[0].key === 'G7+', r.t.slice(0, 120));
r = await call('/sr22t/api/market', { token: T });      check('SR22T market check read', r.status === 200 && JSON.parse(r.t).market !== undefined, r.t.slice(0, 120));
// Program figure + bridge figure publish to the SR22T repo, with a readable change list
const ed = structuredClone(base); ed.programs[0].basePrice = 1329900; ed.bridge.leaseExtraHourRate = 390; ed.bridge.market.yearFrom = 2020;
r = await call('/sr22t/api/publish', { token: T, method: 'POST', body: { costing: ed, sha, note: 'Cirrus price + market' } }); c = parse();
check('SR22T publish commits to the SR22T repo', r.status === 200 && lastRepo === 'sr22t', r.t);
check('committer named SR22T Costing Editor', lastPut.committer.name === 'SR22T Costing Editor', JSON.stringify(lastPut.committer));
check('figures saved', c.programs[0].basePrice === 1329900 && c.bridge.leaseExtraHourRate === 390 && c.bridge.market.yearFrom === 2020, JSON.stringify(c.bridge));
check('commit lists program and bridge changes', /G7\+ Cirrus base price: \$1,304,900 → \$1,329,900/.test(lastPut.message) && /Leasing Program additional hour: \$372 → \$390/.test(lastPut.message) && /Bridge comparables: model year from: 2021 → 2020/.test(lastPut.message), lastPut.message);
check('reply points at the SR22T site', JSON.parse(r.t).site === 'https://sr22tprogram.bopaero.com', r.t);
// Structural parts can't be changed from the client
const sneaky = structuredClone(base); sneaky.bridge.model = 'Hacked'; sneaky.bridge.market.model = 'SR20'; sneaky.bridge.features.safeReturn = { status: 'included' };
sneaky.bridge.extra = 1; sneaky.programs[0].features.safeReturn = { status: 'excluded' }; sneaky.programs[0].management = 250000; sneaky.common.jetstream = 5;
r = await call('/sr22t/api/publish', { token: T, method: 'POST', body: { costing: sneaky, sha, note: 'x' } }); c = parse();
check('bridge model / comparables model / features kept as published', r.status === 200 && c.bridge.model === base.bridge.model && c.bridge.market.model === 'SR22T' && c.bridge.features.safeReturn.status === 'excluded' && !('extra' in c.bridge), JSON.stringify(c.bridge));
check('standard Safe Return on the G7+ kept', c.programs[0].features.safeReturn.standard === true, JSON.stringify(c.programs[0].features));
check('no SF50-only field sneaks into SR22T common', !('jetstream' in c.common), JSON.stringify(c.common));
const over = structuredClone(base); over.programs[0].sharesRemaining = 16;
r = await call('/sr22t/api/publish', { token: T, method: 'POST', body: { costing: over, sha, note: 'x' } });
check('more remaining than available → 400', r.status === 400 && /more shares remaining/.test(r.t), r.t);
const hrs = structuredClone(base); hrs.programs[0].maxHours = 100;
r = await call('/sr22t/api/publish', { token: T, method: 'POST', body: { costing: hrs, sha, note: 'hours' } });
check('flying hours per share publish + listed', r.status === 200 && /Flying hours per share \(yearly\): 96 → 100/.test(lastPut.message), lastPut.message);
const badLease = structuredClone(base); badLease.bridge.leaseIncludedHours = 14.5;
r = await call('/sr22t/api/publish', { token: T, method: 'POST', body: { costing: badLease, sha, note: 'x' } });
check('fractional included lease hours → 400', r.status === 400 && /leaseIncludedHours must be a whole number/.test(r.t), r.t);
const paid = structuredClone(base); paid.bridge.purchasePrice = 900000;
r = await call('/sr22t/api/publish', { token: T, method: 'POST', body: { costing: paid, sha, note: 'correct purchase price' } });
check('purchase price change publishes + listed', r.status === 200 && /Bridge aircraft purchase price: \$880,000 → \$900,000/.test(lastPut.message), lastPut.message);
r = await call('/sr22t/api/publish', { token: T, method: 'POST', body: { costing: ed, sha, note: 'x' }, origin: 'https://evil.example' });
check('cross-origin SR22T publish → 403', r.status === 403, r.status);
const sfo = structuredClone(base); sfo.common.founders.activationRate = 0.06;
r = await call('/sr22t/api/publish', { token: T, method: 'POST', body: { costing: sfo, sha, note: 'activation 6%' } });
check('SR22T Founder setting publishes + listed', r.status === 200 && /Founder activation fee: 5\.00% → 6\.00%/.test(lastPut.message), lastPut.message);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
