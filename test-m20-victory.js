/* =====================================================================
   M20 — Test headless per js/victory.js (condizioni di vittoria reali)
   Esegui con:  node test-m20-victory.js
   Verifica:
     1. API esposta (CFG, rawMetrics, check, progress, claim, isClaimed).
     2. defaultTracks tutti a 0; rawMetrics calibra le soglie dai dati.
     3. check() segna `won` quando una pista raggiunge il suo target reale.
     4. Sopravvissuto: cresce con le ondate fired, vince a tutte superate.
     5. Economia: stock colonie + tesoreria regionale aggregati.
     6. Tech: fallback su researchAccum se il modulo research è assente.
     7. claim/isClaimed marcano una pista rivendicata (sandbox infinito §19).
     8. progress() e check() non divergono (stessa fonte rawMetrics).
     9. Determinismo: stessa partita → stessi score (replay-safe).
    10. migrate v1→v2 resta funzionante.
   ===================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

/* Carica victory.js in un namespace finto. L'IIFE si chiude su
   (typeof window !== 'undefined' ? window : this) → gli passiamo `root`. */
const root = { console: console };
const src = fs.readFileSync(path.join(__dirname, 'js/victory.js'), 'utf8');
const wrap = '(function(window){' + src + '\nreturn this.ORION;})';
const ORION = eval(wrap).call(root, undefined);
const V = ORION.victory;

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('  ✗ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  console.log('  ✓', msg); passed++;
}

/* Galassia finta: count sistemi + discovery (≥2 = esplorato, fallback EXPLORED=2). */
function fakeGame(overrides) {
  const total = (overrides && overrides._total) || 100;
  const explored = (overrides && overrides._explored) || 0;
  const disc = [];
  for (let i = 0; i < total; i++) disc.push(i < explored ? 2 : 0);
  const g = Object.assign({
    timeImpulsi: 0,
    galaxy: { count: total, systems: new Array(total) },
    state: { discovery: disc },
    colonies: {},
    treasury: { balances: {} },
    alignmentDeeds: { light: 0, dark: 0 },
    eventSchedule: [],
    victoryTracks: V.defaultTracks()
  }, overrides || {});
  delete g._total; delete g._explored;
  return g;
}

console.log('— Test 1: API esposta');
assert(typeof V === 'object', 'ORION.victory esiste');
['CFG','rawMetrics','check','progress','claim','isClaimed','defaultTracks','TRACKS','TRACK_LABELS'].forEach(function (k) {
  assert(V[k] != null, '.' + k + ' presente');
});
assert(V.TRACKS.length === 7, '7 piste');

console.log('\n— Test 2: defaultTracks a 0 + calibrazione soglie');
{
  const t = V.defaultTracks();
  V.TRACKS.forEach(function (k) { assert(t[k] === 0, k + ' parte a 0'); });
  const g = fakeGame();
  const m = V.rawMetrics(g);
  assert(m.exploration.goal === Math.ceil(100 * V.CFG.exploreFrac), 'goal esplorazione = ceil(total×exploreFrac)');
  assert(m.colonization.goal === Math.max(V.CFG.colonizeMin, Math.ceil(100 * V.CFG.colonizeFrac)), 'goal colonizzazione calibrato');
  assert(m.economy.goal === V.CFG.econTarget, 'goal economia = econTarget');
  assert(m.reputationLight.goal === V.CFG.alignmentTarget, 'goal pacifista = alignmentTarget');
  assert(m.survival.goal === V.CFG.survWaves, 'goal sopravvissuto = survWaves (fallback)');
}

console.log('\n— Test 3: exploration vince a soglia');
{
  const goal = Math.ceil(100 * V.CFG.exploreFrac);
  const g = fakeGame({ _total: 100, _explored: goal });
  const res = V.check(g);
  const exp = res.filter(function (r) { return r.track === 'exploration'; })[0];
  assert(exp.score >= 1 && exp.won, 'esplorando ' + goal + '/100 → esplorazione vinta');
  /* Sotto soglia non vince. */
  const g2 = fakeGame({ _total: 100, _explored: goal - 1 });
  const exp2 = V.check(g2).filter(function (r) { return r.track === 'exploration'; })[0];
  assert(!exp2.won && exp2.score < 1, 'un sistema sotto soglia → non vinta');
}

console.log('\n— Test 4: reputation light/dark a soglia');
{
  const g = fakeGame({ alignmentDeeds: { light: V.CFG.alignmentTarget, dark: 0 } });
  const res = V.check(g);
  const lit = res.filter(function (r) { return r.track === 'reputationLight'; })[0];
  const drk = res.filter(function (r) { return r.track === 'reputationDark'; })[0];
  assert(lit.won, 'alignmentTarget atti di luce → Pacifista vinto');
  assert(!drk.won, 'nessun atto d\'ombra → Tiranno non vinto');
}

console.log('\n— Test 5: Sopravvissuto cresce con le ondate fired');
{
  const sched = [];
  for (let n = 1; n <= 6; n++) sched.push({ id: 'surv-' + n, kind: 'survivor', at: n * 1000, fired: false });
  const g = fakeGame({ eventSchedule: sched });
  let m = V.rawMetrics(g);
  assert(m.survival.cur === 0, '0 ondate fired → cur 0');
  sched[0].fired = true; sched[1].fired = true; sched[2].fired = true;
  m = V.rawMetrics(g);
  assert(m.survival.cur === 3, '3 ondate fired → cur 3');
  sched.forEach(function (e) { e.fired = true; });
  const surv = V.check(g).filter(function (r) { return r.track === 'survival'; })[0];
  assert(surv.won, 'tutte le 6 ondate superate → Sopravvissuto vinto');
}

console.log('\n— Test 6: Economia somma stock + tesoreria');
{
  const g = fakeGame({
    colonies: { a: { colonized: true, stock: { met: 10000, en: 5000 } } },
    treasury: { balances: { home: 20000, edge: 16000 } }
  });
  const m = V.rawMetrics(g);
  assert(m.economy.cur === 10000 + 5000 + 20000 + 16000, 'econPower = stock(met+en) + Σ balances');
  /* 51000 ≥ 50000 → vinta */
  const eco = V.check(g).filter(function (r) { return r.track === 'economy'; })[0];
  assert(eco.won, '51000 ≥ econTarget(50000) → Egemone vinto');
}

console.log('\n— Test 7: Tech fallback su researchAccum (no modulo research)');
{
  const g = fakeGame({ colonies: { a: { colonized: true, researchAccum: V.CFG.techAccumTarget } } });
  const m = V.rawMetrics(g);
  assert(m.tech.goal === V.CFG.techAccumTarget, 'senza research → goal = techAccumTarget');
  assert(m.tech.cur === V.CFG.techAccumTarget, 'cur = Σ researchAccum');
  const tech = V.check(g).filter(function (r) { return r.track === 'tech'; })[0];
  assert(tech.won, 'researchAccum a soglia → Ascensione vinta (fallback)');
}

console.log('\n— Test 8: claim / isClaimed');
{
  const g = fakeGame();
  assert(!V.isClaimed(g, 'economy'), 'pista non rivendicata di default');
  V.claim(g, 'economy');
  assert(V.isClaimed(g, 'economy'), 'dopo claim → rivendicata');
  assert(!V.isClaimed(g, 'tech'), 'altre piste restano non rivendicate');
  assert(g.victoryClaimed && g.victoryClaimed.economy === true, 'persistito in game.victoryClaimed');
}

console.log('\n— Test 9: progress() coerente con check()');
{
  const g = fakeGame({ _total: 100, _explored: 45, alignmentDeeds: { light: 10, dark: 4 } });
  const rows = V.progress(g);
  const m = V.rawMetrics(g);
  rows.forEach(function (r) {
    assert(r.cur === m[r.track].cur && r.goal === m[r.track].goal,
      r.track + ': progress cur/goal = rawMetrics (nessuna divergenza)');
  });
  const exp = rows.filter(function (r) { return r.track === 'exploration'; })[0];
  assert(exp.cur === 45 && exp.label === 'Esploratore', 'progress espone cur + label');
}

console.log('\n— Test 10: Determinismo (replay-safe)');
{
  const mk = function () { return fakeGame({ _total: 100, _explored: 30, colonies: { a: { colonized: true, stock: { met: 100, en: 50 }, researchAccum: 500 } }, alignmentDeeds: { light: 7, dark: 3 } }); };
  const a = V.check(mk());
  const b = V.check(mk());
  assert(JSON.stringify(a) === JSON.stringify(b), 'stessa partita → stessi score');
}

console.log('\n— Test 11: migrate v1→v2');
{
  const saved = { schema: 1 };
  const out = V.migrate(saved);
  assert(out.schema === V.SCHEMA_VERSION, 'schema bumpato a 2');
  assert(out.mode && out.victoryTracks, 'mode + victoryTracks aggiunti');
}

console.log('\n✅ Tutti i ' + passed + ' assert passati.');
