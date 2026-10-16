// Aircraft comparison: the shared lib (assets/comparison.js) and the editor Worker's
// /comparison and /planning routes. Run by admin/test/run.sh.
import worker from './worker.mjs';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const repo = process.env.REPO, srRepo = process.env.SR_REPO;
const C = require(repo + '/assets/comparison.js');
const SF = require(repo + '/assets/costing.js');
const SR = require(srRepo + '/assets/costing.js');
const cmpText = fs.readFileSync(repo + '/data/comparison.json', 'utf8');
const cmp = JSON.parse(cmpText);
const sfC = JSON.parse(fs.readFileSync(repo + '/data/costing.json', 'utf8'));
const srC = JSON.parse(fs.readFileSync(srRepo + '/data/costing.json', 'utf8'));
let pass = 0, fail = 0;
function check(name, cond, extra = '') { cond ? pass++ : fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + extra)); }
const costings = { SF50: SF.derive(sfC), SR22T: SR.derive(srC) };

// ── lib ──
check('published comparison data is valid', C.validate(cmp).length === 0, C.validate(cmp).join('; '));
const d = C.derive(cmp, costings);
const keys = rows => rows.map(r => r.key).sort().join(',');
check('pistons are costed at the SR22T share hours', d.classes.piston.hours === costings.SR22T.byKey['G7+'].maxHours, d.classes.piston.hours);
check('turbines are costed at the SF50 G3 share hours', d.classes.turbine.hours === costings.SF50.byKey.G3.schedulingHours, d.classes.turbine.hours);
check('bop Aero shares come from the costings', Math.round(d.classes.turbine.share.capital) === Math.round(costings.SF50.byKey.G3.capPerShare) && Math.round(d.classes.piston.share.annual) === Math.round(costings.SR22T.byKey['G7+'].annualFee));
check('customer pistons = Mirage, Baron G58, DA62', keys(d.classes.piston.rows) === 'baron-g58,da62,malibu-mirage', keys(d.classes.piston.rows));
check('customer turbines = Kodiak, TBM 850, PC-12/47, Mustang, Phenom 100, SF50 G1', keys(d.classes.turbine.rows) === 'citation-mustang,kodiak-100,pc-12-47,phenom-100,sf50-g1,tbm-850', keys(d.classes.turbine.rows));
const why = k => d.aircraft.find(r => r.key === k).reasons.join('; ');
check('G36 excluded on trip payload', /payload 734 lb/.test(why('bonanza-g36')), why('bonanza-g36'));
check('T206H excluded for no FIKI', why('t206h') === 'no FIKI', why('t206h'));
check('Seneca V excluded on trip payload', /payload/.test(why('seneca-v')), why('seneca-v'));
check('Eclipse 500 excluded on trip payload', /payload/.test(why('eclipse-500')), why('eclipse-500'));
check('Meridian cannot fly the 900 nm trip', /cannot fly the 900 nm trip/.test(why('meridian')), why('meridian'));
const mirage = d.aircraft.find(r => r.key === 'malibu-mirage');
check('piston engine reserve uses the 12-year calendar at low use', mirage.calendarLimited && mirage.engineInterval === 12 * d.classes.piston.hours, mirage.engineInterval);
check('annual = fixed + hourly + 3% depreciation', Math.abs(mirage.annual - (mirage.fixed + mirage.variable + 0.03 * mirage.price)) < 1e-6);
const kodiak = d.aircraft.find(r => r.key === 'kodiak-100');
check('turbine on an engine program uses the program rate', kodiak.enginePerHourSource === 'program' && kodiak.enginePerHour === 191);
check('benchmark payloads ≈ 747 lb (SR22T) / 1,018 lb (SF50 G3)', Math.round(d.classes.piston.benchmarkPayload) === 747 && Math.round(d.classes.turbine.benchmarkPayload) === 1018,
  Math.round(d.classes.piston.benchmarkPayload) + ' ' + Math.round(d.classes.turbine.benchmarkPayload));
check('rows sorted by capital', d.classes.turbine.rows.every((r, i, a) => !i || a[i - 1].capital <= r.capital));
// planning
const pl = d.planning;
check('management schedule 2…8 = 150K…240K cap', pl.schedule.map(s => s.fee).join() === '150000,165000,180000,195000,210000,225000,240000', pl.schedule.map(s => s.fee).join());
check('every costing program follows the management rule', pl.checks.every(x => x.matches), JSON.stringify(pl.checks.filter(x => !x.matches)));
const srCustom = pl.custom.find(x => x.key === 'bop-sr22t');
check('SR22T custom partnerships match the old sheet ($210K/$145K/$112.4K/$92.9K/$63.7K)', srCustom.partnerships.map(q => Math.round(q.each / 100) / 10).join() === '209.8,144.9,112.4,92.9,63.7', srCustom.partnerships.map(q => Math.round(q.each)).join());
check('DA62 working fee = (468.5K + 240K) / 8', Math.round(pl.candidates.find(x => x.key === 'da62').workingFee) === 88563);
check('eliminated candidates have no working fee', pl.candidates.filter(x => x.eliminated).every(x => x.workingFee === null));
// validation
const v = (mut) => { const x = structuredClone(cmp); mut(x); return C.validate(x).join('; '); };
check('rejects an unknown FIKI status', /fiki must be/.test(v(x => { x.aircraft[0].fiki = 'maybe'; })));
check('rejects a missing source', /needs at least one source/.test(v(x => { x.aircraft[0].sources = []; })));
check('rejects a non-https source', /https URL/.test(v(x => { x.aircraft[0].sources = ['http://example.com/x']; })));
check('rejects a negative price', /price must be between/.test(v(x => { x.aircraft[0].price = -1; })));
check('rejects duplicate aircraft', /duplicate aircraft/.test(v(x => { x.aircraft.push(structuredClone(x.aircraft[0])); })));
check('rejects a class pointing at an unknown program on derive', (() => { const x = structuredClone(cmp); x.classes.turbine.program = 'G9'; try { C.derive(x, costings); return false; } catch (e) { return /no G9 program/.test(e.message); } })());

// ── Worker ──
const enc = s => Buffer.from(s).toString('base64url');
const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]), hash: 'SHA-256' }, true, ['sign','verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1', alg: 'RS256' };
async function jwt(claims) {
  const h = enc(JSON.stringify({ alg: 'RS256', kid: 'k1' })), p = enc(JSON.stringify(claims));
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, new TextEncoder().encode(h + '.' + p)));
  return h + '.' + p + '.' + Buffer.from(sig).toString('base64url');
}
const now = Math.floor(Date.now() / 1000);
let lastPut = null; const sha = 'cmp123';
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.endsWith('/cdn-cgi/access/certs')) return Response.json({ keys: [jwk] });
  if (url.includes('/contents/data/comparison.json') && (!init.method || init.method === 'GET')) return Response.json({ sha, content: Buffer.from(cmpText).toString('base64') });
  if (url.includes('/contents/data/comparison.json') && init.method === 'PUT') { lastPut = JSON.parse(init.body); return Response.json({ commit: { sha: 'e'.repeat(40) } }); }
  if (url.includes('/actions/runs')) return Response.json({ workflow_runs: [{ name: 'Publish', status: 'in_progress', html_url: 'x' }] });
  throw new Error('unexpected fetch ' + url);
};
const env = { ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'aud1', ALLOWED_EMAILS: 'raymond@bopaero.com', GITHUB_TOKEN: 't', GITHUB_REPO: 'bopaero/sf50Program' };
const ORIGIN = 'https://sf50-costing.compilotrc.workers.dev';
async function call(path, { token, method = 'GET', body, origin = ORIGIN } = {}) {
  const headers = {}; if (token) headers['Cf-Access-Jwt-Assertion'] = token; if (method === 'POST') { headers['Origin'] = origin; headers['Content-Type'] = 'application/json'; }
  const r = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), env);
  return { status: r.status, t: await r.text(), h: r.headers };
}
const T = await jwt({ iss: 'https://team.cloudflareaccess.com', aud: ['aud1'], email: 'raymond@bopaero.com', exp: now + 600 });
let r;
r = await call('/planning'); check('planning guide needs Access (401)', r.status === 401, r.status);
r = await call('/comparison/'); check('comparison editor needs Access (401)', r.status === 401, r.status);
r = await call('/comparison/api/data'); check('comparison data needs Access (401)', r.status === 401, r.status);
r = await call('/planning', { token: T });
check('planning guide served behind Access with both costing sites allowed', r.status === 200 && /Aircraft Cost Comparison/.test(r.t) && /raymond@bopaero\.com/.test(r.t) &&
  /script-src[^;]*sr22tprogram\.bopaero\.com/.test(r.h.get('content-security-policy')) && r.h.get('x-robots-tag') === 'noindex, nofollow', r.status);
r = await call('/comparison', { token: T }); check('/comparison redirects to /comparison/', r.status === 302, r.status);
r = await call('/comparison/', { token: T }); check('comparison editor page served', r.status === 200 && /Aircraft Comparison Editor/.test(r.t), r.status);
r = await call('/comparison/api/data', { token: T }); check('reads published comparison data', r.status === 200 && JSON.parse(r.t).comparison.version === cmp.version && JSON.parse(r.t).sha === sha, r.t.slice(0, 120));
const edited = structuredClone(cmp); edited.aircraft.find(a => a.key === 'tbm-850').price = 2250000;
r = await call('/comparison/api/publish', { token: T, method: 'POST', body: { comparison: edited, sha, note: 'x' }, origin: 'https://evil.example' }); check('cross-origin publish → 403', r.status === 403, r.status);
r = await call('/comparison/api/publish', { token: T, method: 'POST', body: { comparison: cmp, sha, note: 'x' } }); check('no change → 400', r.status === 400 && /Nothing changed/.test(r.t), r.t);
r = await call('/comparison/api/publish', { token: T, method: 'POST', body: { comparison: edited, sha, note: ' ' } }); check('missing note → 400', r.status === 400, r.t);
r = await call('/comparison/api/publish', { token: T, method: 'POST', body: { comparison: edited, sha: 'old', note: 'x' } }); check('stale base → 409', r.status === 409, r.t);
const bad = structuredClone(edited); bad.aircraft[0].fiki = 'maybe';
r = await call('/comparison/api/publish', { token: T, method: 'POST', body: { comparison: bad, sha, note: 'x' } }); check('invalid data → 400', r.status === 400 && /fiki must be/.test(r.t), r.t);
const sneaky = structuredClone(edited); sneaky.version = 'v1999-01-01.1'; sneaky.aircraft[0].injected = '<script>'; sneaky.extra = 1; sneaky.aircraft[0].engine.evil = 2;
r = await call('/comparison/api/publish', { token: T, method: 'POST', body: { comparison: sneaky, sha, note: 'TBM 850 market update' } });
const put = lastPut && JSON.parse(Buffer.from(lastPut.content, 'base64').toString());
check('valid change publishes', r.status === 200 && JSON.parse(r.t).changes.some(c => /tbm-850\.price: 2350000 → 2250000/.test(c)), r.t);
check('version assigned by the server, not the client', put && /^v\d{4}-\d{2}-\d{2}\.\d+$/.test(put.version) && put.version !== 'v1999-01-01.1', put && put.version);
check('unknown fields are dropped', put && !('extra' in put) && !('injected' in put.aircraft[0]) && !('evil' in put.aircraft[0].engine));
check('committed data validates and keeps the note', put && C.validate(put).length === 0 && put.note === 'TBM 850 market update', put && C.validate(put).join('; '));
check('commit message names the change', /Comparison v.*TBM 850 market update[\s\S]*tbm-850\.price/.test(lastPut.message), lastPut.message);
const added = structuredClone(cmp); added.aircraft.push({ ...structuredClone(cmp.aircraft[0]), key: 'm600', name: 'Piper M600' });
r = await call('/comparison/api/publish', { token: T, method: 'POST', body: { comparison: added, sha, note: 'add M600' } });
check('adding an aircraft is allowed and listed', r.status === 200 && JSON.parse(r.t).changes.some(c => /added m600/.test(c)), r.t);
r = await call('/comparison/api/status?commit=' + 'e'.repeat(40), { token: T }); check('publish status reported', r.status === 200 && JSON.parse(r.t).state === 'building', r.t);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
