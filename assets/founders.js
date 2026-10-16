/*
 * bop Aero Founder's Circle — the ONE source of the program's terms and wording.
 *
 * Figures (share price, Annual Program Fee, activation and premium rates, positions)
 * come from the two costings (SF50Costing / SR22TCosting derive() output) and are
 * never typed here. What lives here is the wording that is not a costing figure:
 * the core benefits, the repurchase terms and the minimum-cash-by-tenure schedule,
 * carried over from Founders_Circle_Economic_and_Marketing_Summary.docx (2026-10).
 * Shared by (2026-10-16):
 *   - the Founder's Circle Insert (founders-insert.html, no financial details)
 *   - the Founder's Circle Detail Sheet (founders-detail.html, the figures)
 *   - the internal Founder's Circle Summary (admin/founders.html, behind Access)
 * Change a term here and every one of them follows on the next publish.
 *
 * Plain ES5, no dependencies. Exposes FoundersCircle as a global and as a
 * CommonJS export.
 */
(function (root) {
  'use strict';

  var BENEFITS = [
    { name: 'Tier-1 Scheduling Priority',
      text: 'Founders sit ahead of standard ownership access for key booking windows and conflict resolution.' },
    { name: 'Fixed Annual Fee for Program Duration* (Fee Freeze Protection)',
      text: 'The Founder’s total annual program fee is fixed for the program duration.' },
    { name: 'Fleet Exchange Privileges',
      text: 'Request use of other Founder’s Circle aircraft when capacity permits.' },
    { name: 'Structured Exit Support',
      text: 'A defined path to exit through the Founder Repurchase Program.' },
    { name: 'Governance Voice & Advisory Influence',
      text: 'A formal advisory channel with management briefings and early previews.' },
    { name: 'Early Access to Future Programs',
      text: 'Priority visibility into, and first access to, new bop Aero aircraft programs.' },
    { name: 'Community & Private Networking',
      text: 'A peer community of owners with a shared ownership mindset.' }
  ];

  // Program duration footnote (Insert r7 wording), referenced by the * on the fee-freeze benefit
  var DURATION_NOTE = 'Program duration for each aircraft is tied to the aircraft serial number';
  // The one sentence every sheet uses for the fixed-fee promise
  var FIXED_FEE = 'Founder’s Circle fees are fixed for the program duration, which is tied to the aircraft serial number.';

  var REPURCHASE = {
    minMonths: 12,          // before a Founder may initiate a repurchase request
    noticeDays: 180,        // written notice
    // Minimum cash payment at repurchase closing, by time in the Founder's Circle
    tenure: [
      { period: '12–24 months', minCash: 0.10 },
      { period: '24–36 months', minCash: 0.125 },
      { period: '36–48 months', minCash: 0.15 },
      { period: '48–60 months', minCash: 0.175 },
      { period: '60 months / end of aircraft cycle', minCash: 0.20 }
    ],
    duringNotice: 'The Founder remains an owner, and bop Aero may market the ownership position to a replacement buyer.',
    atClosing: 'bop Aero repurchases the share at the defined Net Repurchase Value, based on then-current value under the final agreement.',
    payment: 'If liquidity allows, bop Aero may pay 100% at closing. Otherwise, the minimum cash payment applies and the balance is paid upon resale, subject to a defined outside repayment deadline.'
  };

  // Customer-facing description of the repurchase benefit, with no percentages (summary §5).
  // Describe it as an enhanced liquidity / repurchase benefit, never "insurance" or a guaranteed buyback.
  function liquidityText() {
    return 'After a minimum ownership period of ' + REPURCHASE.minMonths + ' months and ' + REPURCHASE.noticeDays +
      ' days’ written notice, bop Aero will repurchase a Founder’s ownership interest under the Founder Repurchase Program. ' +
      'The minimum cash payment at closing increases with tenure, and bop Aero may pay more, up to the full repurchase value, when liquidity permits.';
  }

  var AGREEMENT_NOTE = 'Founder’s Circle benefits and repurchase terms are governed by the executed Founder’s Circle agreement and are subject to final legal review. ' +
    'The repurchase value is based on then-current value and does not guarantee the original purchase price.';

  // Every program in either costing that offers the add-on, SF50 first (the flagship), then SR22T.
  // Each entry carries the costing's own figures; nothing is recalculated here.
  function programs(sf50, sr22t) {
    var out = [];
    [['SF50', sf50, 'Cirrus SF50'], ['SR22T', sr22t, 'Cirrus SR22T']].forEach(function (a) {
      if (!a[1]) return;
      a[1].programs.forEach(function (p) {
        if (p.founderAnnualFee === undefined) return;
        out.push({ aircraft: a[0], key: p.key, label: a[2] + ' ' + p.key, version: a[1].version,
                   positions: p.founders.positions, shares: p.shares, rates: a[1].common.founders, p: p });
      });
    });
    return out;
  }

  // "two (2) on each Cirrus SF50 G3 and three (3) on each Cirrus SR22T G7+"
  var WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  function count(n) { return (WORDS[n] || String(n)) + ' (' + n + ')'; }
  function availability(list) {
    var parts = list.map(function (x) { return count(x.positions) + ' on each ' + x.label; });
    return parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1] : (parts[0] || '');
  }

  var api = { BENEFITS: BENEFITS, DURATION_NOTE: DURATION_NOTE, FIXED_FEE: FIXED_FEE, REPURCHASE: REPURCHASE,
              AGREEMENT_NOTE: AGREEMENT_NOTE, liquidityText: liquidityText, programs: programs,
              availability: availability, count: count };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FoundersCircle = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
