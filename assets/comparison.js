/*
 * bop Aero aircraft comparison — the ONE implementation of the comparison math.
 *
 * Inputs live in data/comparison.json (edited only through the private costing
 * editor at /comparison). The bop Aero side always comes from the two live
 * costings (SF50Costing / SR22TCosting derive() output), never from this file, so
 * a costing publish moves every comparison figure with it. Shared by:
 *   - the customer sheet (comparison.html → bop-Aero-Aircraft-Ownership-Comparison.pdf)
 *   - the internal planning guide (admin/planning.html, behind Cloudflare Access)
 *   - the comparison editor's validation, in the browser and in the Worker
 *
 * Basis (Raymond 2026-10-16): one owner buying the pre-owned aircraft outright vs
 * one bop Aero share, fuel and pilot excluded on both sides. Each class is costed
 * at the hours its matching share provides (pistons: SR22T maxHours; turbines:
 * SF50 G3 schedulingHours). An aircraft is compared only if it has FIKI and air
 * conditioning and carries at least the matching bop aircraft's payload on the
 * class's typical trip (plus reserve).
 *
 * Plain ES5, no dependencies. Exposes AircraftComparison as a global and as a
 * CommonJS export.
 */
(function (root) {
  'use strict';

  var LIMITS = {
    depreciationRate: { min: 0,    max: 0.2 },
    calendarYears:    { min: 1,    max: 30,  integer: true },
    reserveMinutes:   { min: 0,    max: 120, integer: true },
    tripNm:           { min: 50,   max: 3000, integer: true },
    price:            { min: 5e4,  max: 2e7 },
    insurance:        { min: 0,    max: 5e5 },
    hangar:           { min: 0,    max: 5e5 },
    inspection:       { min: 0,    max: 5e5 },
    subscriptions:    { min: 0,    max: 1e5 },
    unscheduledPerHour: { min: 0,  max: 5000 },
    enginePerHour:    { min: 0,    max: 5000 },    // engine program rate (all engines), when enrolled
    engineCost:       { min: 0,    max: 5e6 },     // overhaul / replacement, per engine
    engineCount:      { min: 1,    max: 4,   integer: true },
    tbo:              { min: 100,  max: 10000, integer: true },
    eventCost:        { min: 0,    max: 1e7 },
    usefulLoad:       { min: 100,  max: 20000 },
    usableFuelGal:    { min: 10,   max: 2000 },
    ktas:             { min: 50,   max: 600 },
    gph:              { min: 1,    max: 500 },
    lbPerGal:         { min: 5,    max: 7.5 },
    seats:            { min: 1,    max: 20,  integer: true },
    partners:         { min: 1,    max: 30,  integer: true },
    costsBeforeMgmt:  { min: 0,    max: 1e7 },
    base:             { min: 0,    max: 2e6 },
    perPartner:       { min: 0,    max: 1e6 },
    cap:              { min: 0,    max: 5e6 }
  };
  var CLASSES = ['piston', 'turbine'];
  var EQUIP = { standard: 'Standard', option: 'Factory option', retrofit: 'Aftermarket retrofit', none: 'Not available' };
  var EQUIP_STATUS = Object.keys(EQUIP);
  var TEXT_MAX = 160;

  function checkNumber(errors, where, field, value, limField) {
    var lim = LIMITS[limField || field];
    if (typeof value !== 'number' || !isFinite(value)) { errors.push(where + ' ' + field + ' must be a number'); return; }
    if (lim.integer && Math.floor(value) !== value) errors.push(where + ' ' + field + ' must be a whole number');
    if (value < lim.min || value > lim.max) errors.push(where + ' ' + field + ' must be between ' + lim.min + ' and ' + lim.max);
  }
  function checkText(errors, where, field, value, optional) {
    if (optional && value === undefined) return;
    if (typeof value !== 'string' || !value.trim() || value.length > TEXT_MAX) errors.push(where + ' ' + field + ' must be 1-' + TEXT_MAX + ' characters');
  }
  function checkPayload(errors, where, p) {
    if (!p || typeof p !== 'object') { errors.push(where + ' payload figures are missing'); return; }
    ['usefulLoad', 'usableFuelGal', 'ktas', 'gph', 'lbPerGal'].forEach(function (f) { checkNumber(errors, where + ' payload', f, p[f]); });
  }

  // Returns a list of problems; empty means the comparison can be published.
  function validate(c) {
    var errors = [];
    if (!c || typeof c !== 'object') return ['comparison is missing'];
    if (!/^v\d{4}-\d{2}-\d{2}\.\d+$/.test(c.version || '')) errors.push('version must look like v2026-10-16.1');
    var a = c.assumptions || {};
    checkNumber(errors, 'assumptions', 'depreciationRate', a.depreciationRate);
    checkNumber(errors, 'assumptions', 'calendarYears', a.calendarYears);
    checkNumber(errors, 'assumptions', 'reserveMinutes', a.reserveMinutes);
    var cls = c.classes || {};
    CLASSES.forEach(function (k) {
      var x = cls[k], where = 'class ' + k;
      if (!x) { errors.push(where + ' is missing'); return; }
      if (['SF50', 'SR22T'].indexOf(x.aircraft) < 0) errors.push(where + ' aircraft must be SF50 or SR22T');
      checkText(errors, where, 'program', x.program);
      checkText(errors, where, 'label', x.label);
      checkNumber(errors, where, 'tripNm', x.tripNm);
      checkPayload(errors, where + ' benchmark', x.benchmark);
    });
    if (!Array.isArray(c.aircraft) || !c.aircraft.length) { errors.push('aircraft are missing'); return errors; }
    var keys = {};
    c.aircraft.forEach(function (p) {
      var where = 'aircraft ' + (p && p.key);
      if (!p || typeof p.key !== 'string' || !/^[a-z0-9-]{2,40}$/.test(p.key)) { errors.push('an aircraft key must be 2-40 lowercase letters, digits or dashes'); return; }
      if (keys[p.key]) errors.push('duplicate aircraft ' + p.key);
      keys[p.key] = true;
      checkText(errors, where, 'name', p.name);
      checkText(errors, where, 'vintage', p.vintage);
      if (CLASSES.indexOf(p['class']) < 0) errors.push(where + ' class must be piston or turbine');
      checkNumber(errors, where, 'seats', p.seats);
      ['price', 'insurance', 'hangar', 'inspection', 'subscriptions', 'unscheduledPerHour'].forEach(function (f) { checkNumber(errors, where, f, p[f]); });
      var e = p.engine || {};
      if (e.programPerHour !== undefined) checkNumber(errors, where + ' engine', 'programPerHour', e.programPerHour, 'enginePerHour');
      checkNumber(errors, where + ' engine', 'cost', e.cost, 'engineCost');
      checkNumber(errors, where + ' engine', 'count', e.count, 'engineCount');
      checkNumber(errors, where + ' engine', 'tbo', e.tbo, 'tbo');
      checkText(errors, where + ' engine', 'label', e.label);
      if (e.calendar !== undefined && typeof e.calendar !== 'boolean') errors.push(where + ' engine calendar must be true or false');
      var ev = p.event || {};
      checkText(errors, where + ' event', 'label', ev.label);
      checkNumber(errors, where + ' event', 'cost', ev.cost, 'eventCost');
      if (EQUIP_STATUS.indexOf(p.fiki) < 0) errors.push(where + ' fiki must be ' + EQUIP_STATUS.join(', '));
      if (EQUIP_STATUS.indexOf(p.ac) < 0) errors.push(where + ' ac must be ' + EQUIP_STATUS.join(', '));
      checkText(errors, where, 'support', p.support);
      checkPayload(errors, where, p.payload);
      if (!Array.isArray(p.sources) || !p.sources.length) errors.push(where + ' needs at least one source');
      else p.sources.forEach(function (s) { if (typeof s !== 'string' || !/^https:\/\/\S{4,400}$/.test(s)) errors.push(where + ' source must be an https URL'); });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(p.asOf || '')) errors.push(where + ' asOf must be a date like 2026-10-16');
    });
    var pl = c.planning;
    if (pl !== undefined) {
      var r = (pl || {}).managementRule || {};
      checkNumber(errors, 'planning management', 'base', r.base);
      checkNumber(errors, 'planning management', 'perPartner', r.perPartner);
      checkNumber(errors, 'planning management', 'cap', r.cap);
      if (!Array.isArray(pl.partnerCounts) || !pl.partnerCounts.length) errors.push('planning partnerCounts are missing');
      else pl.partnerCounts.forEach(function (n) { checkNumber(errors, 'planning', 'partnerCounts', n, 'partners'); });
      checkNumber(errors, 'planning', 'programPartners', pl.programPartners, 'partners');
      var ck = {};
      (pl.candidates || []).forEach(function (x) {
        var where = 'candidate ' + (x && x.key);
        if (!x || typeof x.key !== 'string' || !/^[a-z0-9-]{2,40}$/.test(x.key)) { errors.push('a candidate key must be 2-40 lowercase letters, digits or dashes'); return; }
        if (ck[x.key]) errors.push('duplicate candidate ' + x.key);
        ck[x.key] = true;
        checkText(errors, where, 'name', x.name);
        checkNumber(errors, where, 'seats', x.seats);
        checkNumber(errors, where, 'price', x.price);
        checkText(errors, where, 'priceNote', x.priceNote, true);
        ['cruise', 'fuel'].forEach(function (f) { checkText(errors, where, f, x[f]); });
        ['ac', 'fiki', 'internet'].forEach(function (f) { if (typeof x[f] !== 'boolean') errors.push(where + ' ' + f + ' must be true or false'); });
        checkNumber(errors, where, 'costsBeforeMgmt', x.costsBeforeMgmt);
        checkText(errors, where, 'eliminated', x.eliminated, true);
        checkText(errors, where, 'note', x.note, true);
      });
      (pl.notes || []).forEach(function (n, i) { if (typeof n !== 'string' || !n.trim() || n.length > 400) errors.push('planning note ' + (i + 1) + ' must be 1-400 characters'); });
    }
    return errors;
  }

  // Payload on the class's typical trip: useful load minus the fuel for the trip
  // plus reserve (never more than full tanks). null when the trip needs more than
  // full tanks — the aircraft cannot fly it.
  function tripPayload(p, nm, reserveMinutes) {
    var fuelLb = (nm / p.ktas + reserveMinutes / 60) * p.gph * p.lbPerGal;
    var fullLb = p.usableFuelGal * p.lbPerGal;
    if (fuelLb > fullLb) return null;
    return p.usefulLoad - fuelLb;
  }

  // share(aircraft, program) → the matching bop Aero share from the live costings
  function bopShare(x, costings) {
    var d = costings[x.aircraft];
    if (!d) throw new Error('The ' + x.aircraft + ' costing is not loaded.');
    var p = d.byKey[x.program];
    if (!p) throw new Error('The ' + x.aircraft + ' costing has no ' + x.program + ' program.');
    var hours = x.aircraft === 'SR22T' ? p.maxHours : p.schedulingHours;
    return { aircraft: x.aircraft, program: x.program, version: d.version, capital: p.capPerShare, annual: p.annualFee,
             hours: hours, perHour: p.annualFee / hours, shares: p.shares, acquisition: p.acquisition,
             annualTotal: p.annualTotal, management: p.management, costsBeforeMgmt: p.annualTotal - p.management };
  }

  // Inputs (+ the two derived costings) → every comparison figure. Does not modify its arguments.
  //   costings = { SF50: SF50Costing.derive(...), SR22T: SR22TCosting.derive(...) }
  function derive(c, costings) {
    var a = c.assumptions, out = { version: c.version, publishedAt: c.publishedAt, assumptions: a, classes: {}, aircraft: [] };
    CLASSES.forEach(function (k) {
      var x = c.classes[k], share = bopShare(x, costings);
      out.classes[k] = { key: k, label: x.label, tripNm: x.tripNm, hours: share.hours, share: share,
                         benchmarkPayload: tripPayload(x.benchmark, x.tripNm, a.reserveMinutes), rows: [], excluded: [] };
    });
    c.aircraft.forEach(function (src) {
      var cl = out.classes[src['class']], h = cl.hours, r = {};
      for (var key in src) r[key] = src[key];
      var e = src.engine;
      // Engine: an enrolled program rate when there is one; otherwise a reserve over the
      // overhaul interval — for pistons the calendar limit (12 years by default) can come
      // first at low utilization, which is what makes a low-use engine expensive per hour.
      r.engineInterval = e.calendar ? Math.min(e.tbo, a.calendarYears * h) : e.tbo;
      r.calendarLimited = !!e.calendar && a.calendarYears * h < e.tbo;
      r.enginePerHour = e.programPerHour !== undefined ? e.programPerHour : e.cost * e.count / r.engineInterval;
      r.enginePerHourSource = e.programPerHour !== undefined ? 'program' : 'reserve';
      r.hours = h;
      r.fixed = src.insurance + src.hangar + src.inspection + src.subscriptions;
      r.variable = (src.unscheduledPerHour + r.enginePerHour) * h;
      r.depreciation = a.depreciationRate * src.price;
      r.annual = r.fixed + r.variable + r.depreciation;
      r.perHour = r.annual / h;
      r.capital = src.price;
      r.tripPayload = tripPayload(src.payload, cl.tripNm, a.reserveMinutes);
      r.reasons = [];
      if (src.fiki === 'none') r.reasons.push('no FIKI');
      if (src.ac === 'none') r.reasons.push('no air conditioning');
      if (r.tripPayload === null) r.reasons.push('cannot fly the ' + cl.tripNm + ' nm trip');
      else if (r.tripPayload < cl.benchmarkPayload) r.reasons.push('payload ' + Math.round(r.tripPayload) + ' lb on the ' + cl.tripNm + ' nm trip, below the ' + cl.share.aircraft + '’s ' + Math.round(cl.benchmarkPayload) + ' lb');
      r.qualifies = !r.reasons.length;
      out.aircraft.push(r);
      (r.qualifies ? cl.rows : cl.excluded).push(r);
    });
    CLASSES.forEach(function (k) { out.classes[k].rows.sort(function (x, y) { return x.capital - y.capital; }); });
    if (c.planning) out.planning = derivePlanning(c.planning, costings, out);
    return out;
  }

  function managementFee(rule, n) { return Math.min(rule.cap, rule.base + rule.perPartner * n); }

  // Internal planning guide: management schedule, candidate programs, custom partnerships.
  function derivePlanning(pl, costings, cmp) {
    var rule = pl.managementRule;
    // Every partner count from the smallest planned to the program size (2…8 → the old sheet's table)
    var counts = pl.partnerCounts.concat([pl.programPartners]), lo = Math.min.apply(null, counts), hi = Math.max.apply(null, counts), all = [];
    for (var n = lo; n <= hi; n++) all.push(n);
    var schedule = all
      .map(function (n) { var fee = managementFee(rule, n); return { partners: n, fee: fee, perPartner: fee / n, capped: rule.base + rule.perPartner * n >= rule.cap }; });
    // Does the costing's management figure follow the rule? (it is entered per program)
    var checks = [];
    ['SF50', 'SR22T'].forEach(function (ac) {
      (costings[ac].programs || []).forEach(function (p) {
        var expect = managementFee(rule, p.shares);
        checks.push({ aircraft: ac, program: p.key, shares: p.shares, management: p.management, expected: expect, matches: Math.abs(p.management - expect) < 0.5 });
      });
    });
    function partnership(costsBeforeMgmt) {
      return pl.partnerCounts.map(function (n) { return { partners: n, each: (costsBeforeMgmt + managementFee(rule, n)) / n }; });
    }
    var sr = cmp.classes.piston.share.aircraft === 'SR22T' ? cmp.classes.piston.share : bopShare({ aircraft: 'SR22T', program: 'G7+' }, costings);
    var sf = cmp.classes.turbine.share;
    var bop = [
      { key: 'bop-sr22t', name: 'Cirrus SR22T ' + sr.program + ' (bop Aero program)', bop: true, share: sr, costsBeforeMgmt: sr.costsBeforeMgmt,
        workingFee: sr.annual, workingShares: sr.shares, price: sr.acquisition },
      { key: 'bop-sf50', name: 'Cirrus SF50 ' + sf.program + ' (bop Aero program)', bop: true, share: sf, costsBeforeMgmt: sf.costsBeforeMgmt,
        workingFee: sf.annual, workingShares: sf.shares, price: sf.acquisition }
    ];
    var candidates = (pl.candidates || []).map(function (x) {
      var r = {}; for (var k in x) r[k] = x[k];
      r.workingShares = pl.programPartners;
      r.workingFee = x.eliminated ? null : (x.costsBeforeMgmt + managementFee(rule, pl.programPartners)) / pl.programPartners;
      return r;
    });
    var custom = bop.concat(candidates.filter(function (x) { return !x.eliminated; }))
      .map(function (x) { return { key: x.key, name: x.name, costsBeforeMgmt: x.costsBeforeMgmt, partnerships: partnership(x.costsBeforeMgmt) }; });
    return { rule: rule, schedule: schedule, checks: checks, bop: bop, candidates: candidates, custom: custom,
             partnerCounts: pl.partnerCounts.slice(), programPartners: pl.programPartners, notes: (pl.notes || []).slice() };
  }

  var api = { validate: validate, derive: derive, tripPayload: tripPayload, managementFee: managementFee,
              LIMITS: LIMITS, CLASSES: CLASSES, EQUIP: EQUIP, EQUIP_STATUS: EQUIP_STATUS, TEXT_MAX: TEXT_MAX };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AircraftComparison = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
