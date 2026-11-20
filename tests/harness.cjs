/* Orion Empires — harness headless (Node vm).
   Carica i moduli js/* come script classici in un contesto isolato con
   stub minimi di DOM/window, nello stesso ordine del gioco. Ogni chiamata
   a load() crea un contesto NUOVO: nessuno stato condiviso tra test. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

/* Ordine dei moduli: src/entry.js (import in ordine) se esiste,
   altrimenti i <script src> di index.html (layout pre-Vite). */
function moduleList() {
  const entry = path.join(ROOT, 'src/entry.js');
  if (fs.existsSync(entry)) {
    const src = fs.readFileSync(entry, 'utf8');
    return [...src.matchAll(/^import\s+'\.\.\/(js\/[^']+)';/gm)].map(m => m[1]);
  }
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  return [...html.matchAll(/src="(js\/[^"]+)"/g)].map(m => m[1]);
}

/* Elemento DOM "assorbente": qualunque accesso/chiamata restituisce un
   altro elemento finto; le query restituiscono null/[]. */
function fakeEl() {
  const f = function () { return fakeEl(); };
  return new Proxy(f, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return () => '';
      if (k === 'length') return 0;
      if (k === 'then') return undefined;
      if (k === 'querySelectorAll' || k === 'getElementsByClassName' || k === 'getElementsByTagName') return () => [];
      if (k === 'querySelector' || k === 'getElementById' || k === 'closest') return () => null;
      if (k === 'getBoundingClientRect') return () => ({ width: 800, height: 600, left: 0, top: 0, right: 800, bottom: 600 });
      return fakeEl();
    },
    set() { return true; },
    apply() { return fakeEl(); },
    construct() { return fakeEl(); },
  });
}

function makeContext() {
  const store = {};
  const ls = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
    key: () => null, length: 0, clear() {},
  };
  const ctx = {
    console, performance,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    localStorage: ls, sessionStorage: ls,
    navigator: { userAgent: 'node', onLine: false },
    location: { search: '', hash: '', href: '', protocol: 'file:' },
    devicePixelRatio: 1, innerWidth: 1920, innerHeight: 1080,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} }),
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    getComputedStyle: () => fakeEl(),
    fetch: () => Promise.reject(new Error('offline (harness)')),
    Blob: function () {}, URL: { createObjectURL: () => '', revokeObjectURL() {} },
    ResizeObserver: function () { return { observe() {}, unobserve() {}, disconnect() {} }; },
    Image: function () { return fakeEl(); },
  };
  ctx.document = fakeEl();
  ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  return ctx;
}

/* opts.main = true → carica anche main.js (UI). */
function load(opts) {
  opts = opts || {};
  const ctx = makeContext();
  /* Determinismo (#5): Math.random vietato nella simulazione. Lo lasciamo
     disponibile solo a rng.newSeed, che il test non usa (seed espliciti). */
  for (const f of moduleList()) {
    if (f === 'js/main.js' && !opts.main) continue;
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    vm.runInContext(src, ctx, { filename: f });
  }
  return ctx;
}

/* Hash per sezione del payload serializzato: un diff dice SUBITO quale
   parte dello stato è cambiata. */
function sectionHashes(payload) {
  const out = {};
  for (const k of Object.keys(payload).sort()) {
    out[k] = crypto.createHash('sha1').update(JSON.stringify(payload[k]) || 'undefined').digest('hex').slice(0, 12);
  }
  return out;
}

module.exports = { load, moduleList, sectionHashes, ROOT };
