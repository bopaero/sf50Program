// Founder's Circle shared terms (assets/founders.js) against both live costings in the repos.
//   REPO=... SR_REPO=... node founders.test.mjs
import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire(import.meta.url);
const REPO = process.env.REPO, SR = process.env.SR_REPO;
const SF50Costing = require(REPO + '/assets/costing.js');
const SR22TCosting = require(SR + '/assets/costing.js');
const FC = require(REPO + '/assets/founders.js');
let pass = 0, fail = 0;
function check(name, ok, info) { if (ok) { pass++; console.log('PASS ' + name); } else { fail++; console.log('FAIL ' + name + (info ? ' — ' + info : '')); } }

const sf = SF50Costing.derive(JSON.parse(fs.readFileSync(REPO + '/data/costing.json')));
const sr = SR22TCosting.derive(JSON.parse(fs.readFileSync(SR + '/data/costing.json')));
const list = FC.programs(sf, sr);
const offering = sf.programs.concat(sr.programs).filter(p => p.founders);
check('every program with Founder positions is listed, none other', list.length === offering.length && list.length > 0, list.map(x => x.label).join(', '));
check('SF50 is listed first', list[0].aircraft === 'SF50');
check('figures are the costing’s own (no recalculation)', list.every(x => x.p.founderActivation === x.p.capPerShare * x.rates.activationRate &&
  x.p.founderAnnualFee === x.p.annualFee + x.p.founderPremium && x.positions === x.p.founders.positions));
check('pre-owned SF50 programs are not offered', !list.some(x => ['G1', 'G2', 'G2+'].includes(x.key) && x.aircraft === 'SF50'));
const avail = FC.availability(list);
check('availability names every count from the costing', list.every(x => avail.includes('(' + x.positions + ') on each ' + x.label)), avail);
check('availability joins two programs with "and"', FC.availability(list.slice(0, 2)).split(' and ').length === 2);
check('Insert liquidity text has no figures', !/\$\s*\d|\d\s*%/.test(FC.liquidityText()), FC.liquidityText());
check('liquidity text uses the repurchase terms', FC.liquidityText().includes(FC.REPURCHASE.minMonths + ' months') && FC.liquidityText().includes(FC.REPURCHASE.noticeDays + ' days'));
const t = FC.REPURCHASE.tenure.map(x => x.minCash);
check('minimum cash rises with tenure', t.every((v, i) => i === 0 || v > t[i - 1]) && t[0] > 0 && t[t.length - 1] <= 1, t.join(','));
check('no "insurance" or "guarantee" promise in customer wording', !/insurance|guaranteed/i.test([FC.liquidityText(), FC.REPURCHASE.payment, FC.REPURCHASE.atClosing].concat(FC.BENEFITS.map(b => b.name + ' ' + b.text)).join(' ')));
for (const f of ['founders-insert.html', 'founders-detail.html']) {
  const h = fs.readFileSync(REPO + '/' + f, 'utf8');
  check(f + ' loads the shared terms and both costings', h.includes('assets/founders.js') && h.includes('sr22tprogram.bopaero.com/assets/costing.js'));
}
check('Insert never formats money', !/money\(/.test(fs.readFileSync(REPO + '/founders-insert.html', 'utf8')));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
