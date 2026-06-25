/* =====================================================================
   M18 — Test headless per js/reputation.js
   Esegui con:  node test-m18-reputation.js
   Verifica:
     1. La façade espone l'API attesa.
     2. record() pusha nello storico con cap 20 (FIFO).
     3. applyAndRecord() applica clamp 0..100, registra delta effettivo.
     4. Attraversamento di soglia ICG/Rep emette evento di cronaca UNA SOLA volta.
     5. Determinismo: stessa sequenza → stesso esito (replay-safe).
     6. ensure() su save vecchio (senza repHistory) è idempotente.
   ===================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

/* Carica reputation.js in un namespace finto (no DOM, no altri moduli). */
const root = { console: console };
const src = fs.readFileSync(path.join(__dirname, 'js/reputation.js'), 'utf8');
/* L'IIFE di reputation.js si chiude su (typeof window !== 'undefined' ? window : globalThis).
   Eseguendolo qui, globalThis è il process — usiamo `root` come bersaglio
   wrappando il file in un eval che gli assegna `globalThis = root`. */
const wrap = '(function(globalThis, window){' + src + '\nreturn globalThis.ORION;})';
const exposeOrion = eval(wrap);
const ORION = exposeOrion(root, root);

function assert(cond, msg) {
  if (!cond) { console.error('  ✗ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  console.log('  ✓', msg);
}

function fakeGame(overrides) {
  return Object.assign({
    timeImpulsi: 0,
    reputation: 50,
    icg: 20,
    chronicle: [],
    victoryTracks: {},
    civs: []
  }, overrides || {});
}

console.log('— Test 1: API esposta');
assert(typeof ORION.reputation === 'object', 'ORION.reputation esiste');
['get','getRep','getICG','record','applyAndRecord','breakdown','ensure','bandIndex'].forEach(function (fn) {
  /* `get` non esiste come alias, ma getRep/getICG sì. */
  if (fn === 'get') return;
  assert(typeof ORION.reputation[fn] === 'function', '.' + fn + '() è funzione');
});
assert(ORION.reputation.HISTORY_CAP === 20, 'HISTORY_CAP = 20');
assert(Array.isArray(ORION.reputation.ICG_THRESHOLDS), 'ICG_THRESHOLDS array');
assert(Array.isArray(ORION.reputation.REP_THRESHOLDS), 'REP_THRESHOLDS array');

console.log('\n— Test 2: record() FIFO cap 20');
{
  const g = fakeGame();
  ORION.reputation.ensure(g);
  for (let i = 0; i < 30; i++) {
    g.reputation = 50 + (i % 5); /* fa percepire delta */
    ORION.reputation.record(g, 'rep', 1, 'test', 'evento ' + i);
  }
  assert(g.repHistory.length === 20, 'storico capped a 20 (era 30 push)');
  /* L'ultimo evento (i=29) deve essere in cima (unshift). */
  assert(g.repHistory[0].label === 'evento 29', 'evento più recente in testa');
  assert(g.repHistory[19].label === 'evento 10', 'evento più vecchio sopravvissuto (10), 0-9 droppati');
}

console.log('\n— Test 3: applyAndRecord clampa 0..100');
{
  const g = fakeGame({ reputation: 98 });
  ORION.reputation.applyAndRecord(g, 'rep', +10, 'test', 'overflow');
  assert(g.reputation === 100, 'reputation clampata a 100 (era 98 + 10)');
  assert(g.repHistory[0].delta === 2, 'delta registrato è quello EFFETTIVO (+2, non +10)');

  const g2 = fakeGame({ icg: 5 });
  ORION.reputation.applyAndRecord(g2, 'icg', -20, 'test', 'underflow');
  assert(g2.icg === 0, 'icg clampato a 0 (era 5 - 20)');
  assert(g2.repHistory[0].delta === -5, 'delta ICG registrato è -5');
}

console.log('\n— Test 4: attraversamento soglia emette UNA voce di cronaca');
{
  const g = fakeGame({ icg: 35 }); /* fascia 0 (Stabile, <40) */
  ORION.reputation.ensure(g);
  ORION.reputation.applyAndRecord(g, 'icg', +10, 'test', 'verso Tensione');  /* → 45, fascia 1 */
  const thresholdEvents = g.chronicle.filter(function (e) { return e.kind === 'icg-threshold'; });
  assert(thresholdEvents.length === 1, 'una sola voce icg-threshold emessa');
  assert(thresholdEvents[0].direction === 'up', 'direzione = up');
  assert(thresholdEvents[0].toBand === 'Tensione', 'fascia destinazione = Tensione');

  ORION.reputation.applyAndRecord(g, 'icg', +2, 'test', 'dentro fascia');  /* → 47, ancora fascia 1 */
  const after = g.chronicle.filter(function (e) { return e.kind === 'icg-threshold'; });
  assert(after.length === 1, 'nessuna nuova voce se resto dentro la stessa fascia');

  ORION.reputation.applyAndRecord(g, 'icg', +15, 'test', 'verso Crisi');  /* → 62, fascia 2 */
  const after2 = g.chronicle.filter(function (e) { return e.kind === 'icg-threshold'; });
  assert(after2.length === 2, 'nuova voce emessa al secondo crossing (Crisi)');
}

console.log('\n— Test 5: determinismo (replay)');
{
  function play(steps) {
    const g = fakeGame();
    ORION.reputation.ensure(g);
    steps.forEach(function (s) {
      g.timeImpulsi = s.ds;
      ORION.reputation.applyAndRecord(g, s.kind, s.delta, s.src, s.lbl);
    });
    return { rep: g.reputation, icg: g.icg, hist: g.repHistory.slice() };
  }
  const seq = [
    { ds: 10, kind: 'rep', delta: +5,  src: 'd1', lbl: 'pace A' },
    { ds: 20, kind: 'icg', delta: -3,  src: 'd2', lbl: 'crisi gestita' },
    { ds: 30, kind: 'rep', delta: -10, src: 'd3', lbl: 'guerra A' },
    { ds: 40, kind: 'icg', delta: +25, src: 'd4', lbl: 'evil expand' }
  ];
  const a = play(seq);
  const b = play(seq);
  assert(a.rep === b.rep && a.icg === b.icg, 'rep/icg identici tra due run');
  assert(JSON.stringify(a.hist) === JSON.stringify(b.hist), 'storico identico (sequenza deterministica)');
}

console.log('\n— Test 6: ensure() su save vecchio senza repHistory');
{
  const g = fakeGame();
  delete g.repHistory;
  ORION.reputation.ensure(g);
  assert(Array.isArray(g.repHistory), 'repHistory inizializzato a array vuoto');
  assert(g.repHistory.length === 0, 'lunghezza 0');
  /* idempotenza */
  ORION.reputation.ensure(g);
  ORION.reputation.ensure(g);
  assert(g.repHistory.length === 0, 'ensure() idempotente');
}

console.log('\n— Test 7: breakdown() restituisce struttura attesa');
{
  const g = fakeGame({
    civs: [
      { alive: true, alignment: 'evil' },
      { alive: true, alignment: 'evil' },
      { alive: true, alignment: 'good', constant: 'pellegrini' },
      { alive: true, alignment: 'evil', relation: 'war' }
    ],
    victoryTracks: { reputationLight: 0.3, reputationDark: 0.5 },
    crises: [{ status: 'pending' }]
  });
  const b = ORION.reputation.breakdown(g);
  assert(typeof b.rep === 'object' && typeof b.icg === 'object', 'breakdown ha rep + icg');
  assert(Array.isArray(b.rep.factors) && b.rep.factors.length > 0, 'rep.factors popolato');
  assert(Array.isArray(b.icg.factors) && b.icg.factors.length > 0, 'icg.factors popolato');
  assert(typeof b.rep.bandLabel === 'string' && b.rep.bandLabel.length > 0, 'rep.bandLabel definito');
  assert(b.icg.factors.some(function (f) { return /Pellegrini/.test(f.label); }), 'rilevato bonus Pellegrini per ICG');
  assert(b.icg.factors.some(function (f) { return /Crisi/.test(f.label); }), 'rilevata crisi pendente');
  assert(b.rep.factors.some(function (f) { return /Guerre/.test(f.label); }), 'rilevate guerre attive');
}

console.log('\n— Test 8: bandIndex monotono');
{
  const bi = ORION.reputation.bandIndex;
  const T = ORION.reputation.ICG_THRESHOLDS; /* [40,60,80] */
  assert(bi(0,  T) === 0, '0 → fascia 0');
  assert(bi(39, T) === 0, '39 → fascia 0');
  assert(bi(40, T) === 1, '40 → fascia 1 (soglia esclusa dall\'inferiore)');
  assert(bi(59, T) === 1, '59 → fascia 1');
  assert(bi(60, T) === 2, '60 → fascia 2');
  assert(bi(79, T) === 2, '79 → fascia 2');
  assert(bi(80, T) === 3, '80 → fascia 3');
  assert(bi(100, T) === 3, '100 → fascia 3');
}

if (!process.exitCode) console.log('\n✓ Tutti i test M18 passati.');
else                   console.log('\n✗ Almeno un test M18 è fallito.');
