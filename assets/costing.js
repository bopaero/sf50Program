/*
 * bop Aero SF50 program costing — the ONE implementation of the program math.
 *
 * Inputs live in data/costing.json (edited only through the private costing
 * editor). This file turns them into every derived figure. It is shared by:
 *   - the SF50 Ownership Program Options document (index.html)
 *   - the costing editor's validation, in the browser and in the Worker
 *   - later, the public SF50 calculator on bopaero.com
 * so the arithmetic exists in exactly one place.
 *
 * Plain ES5, no dependencies. Exposes SF50Costing as a global and as a
 * CommonJS export.
 */
(function (root) {
  'use strict';

  var LIMITS = {
    shares:           { min: 1,    max: 20,     integer: true },
    acquisition:      { min: 1e5,  max: 2e7 },
    connectivityCost: { min: 0,    max: 1e6 },
    management:       { min: 0,    max: 2e6 },
    reserve:          { min: 0,    max: 5e6 },
    fixedCost:        { min: 0,    max: 5e6 },
    jetstream:        { min: 0,    max: 2e6 },
    closing:          { min: 0,    max: 1e6 },
    taxRate:          { min: 0,    max: 0.2 }
  };

  function checkNumber(errors, where, field, value) {
    var lim = LIMITS[field];
    if (typeof value !== 'number' || !isFinite(value)) {
      errors.push(where + ' ' + field + ' must be a number');
      return;
    }
    if (lim.integer && Math.floor(value) !== value) errors.push(where + ' ' + field + ' must be a whole number');
    if (value < lim.min || value > lim.max) errors.push(where + ' ' + field + ' must be between ' + lim.min + ' and ' + lim.max);
  }

  // Returns a list of problems; empty means the costing can be published.
  function validate(c) {
    var errors = [];
    if (!c || typeof c !== 'object') return ['costing is missing'];
    if (!/^v\d{4}-\d{2}-\d{2}\.\d+$/.test(c.version || '')) errors.push('version must look like v2026-09-30.1');
    var common = c.common || {};
    ['fixedCost', 'jetstream', 'closing', 'taxRate'].forEach(function (f) { checkNumber(errors, 'common', f, common[f]); });
    if (!Array.isArray(c.programs) || !c.programs.length) { errors.push('programs are missing'); return errors; }
    var keys = {};
    c.programs.forEach(function (p) {
      var where = 'program ' + (p && p.key);
      if (!p || typeof p.key !== 'string' || !p.key) { errors.push('a program is missing its key'); return; }
      if (keys[p.key]) errors.push('duplicate program ' + p.key);
      keys[p.key] = true;
      if (typeof p.approx !== 'boolean') errors.push(where + ' approx must be true or false');
      ['shares', 'acquisition', 'connectivityCost', 'management', 'reserve'].forEach(function (f) { checkNumber(errors, where, f, p[f]); });
    });
    if (!keys[c.baseline]) errors.push('baseline must name one of the programs');
    if (!Array.isArray(c.sensitivitySteps) || !c.sensitivitySteps.every(function (n) { return typeof n === 'number' && n > 0; }))
      errors.push('sensitivitySteps must be positive numbers');
    return errors;
  }

  // Inputs → every derived figure. Does not modify its argument.
  function derive(c) {
    var common = c.common;
    var programs = c.programs.map(function (src) {
      var p = {};
      for (var k in src) p[k] = src[k];
      p.interests      = p.shares + 1;                 // one interest retained by bop Aero
      p.equity         = 1 / p.interests;
      p.allocation     = 1 / p.shares;
      p.tax            = Math.round(p.acquisition * common.taxRate);
      p.capitalization = p.acquisition + p.connectivityCost + common.jetstream + p.tax + common.closing;
      p.capPerShare    = p.capitalization / p.shares;
      p.annualTotal    = common.fixedCost + p.management + p.reserve;
      p.annualFee      = p.annualTotal / p.shares;
      p.reserve5       = p.reserve * 5;
      return p;
    });
    var byKey = {};
    programs.forEach(function (p) { byKey[p.key] = p; });
    var baseline = byKey[c.baseline];
    programs.forEach(function (p) { p.concentration = baseline.shares / p.shares; p.isBaseline = p === baseline; });
    return {
      version: c.version, publishedAt: c.publishedAt, common: common,
      programs: programs, byKey: byKey, baseline: baseline,
      sensitivitySteps: c.sensitivitySteps.slice()
    };
  }

  var api = { validate: validate, derive: derive, LIMITS: LIMITS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SF50Costing = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
