/* =====================================================================
   Test headless — Redesign logistica stazione (2026).
   node test-station-logistics.js
   Verifica:
     1. Magazzino tipizzato: cap per-risorsa, migrazione lazy dai vecchi
        campi supply/metReserve.
     2. Gradiente L: 1.0 entro COMFORT, 0.50 a MAX_RANGE, 0 oltre.
     3. Supplier esplicito + fallback + fellBack; assegnazione/raggio.
     4. tick: rifornimento per-risorsa × L, upkeep, riparazione × L.
     5. Refuel tipizzato: consuma le 4 risorse in proporzione, limitato dalla
        più scarsa (recovery-friendly).
   ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const root = { console: console };
function load(rel) {
  const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
  return eval('(function(globalThis, window){' + src + '\nreturn globalThis.ORION;})')(root, root);
}
load('js/rng.js');
load('js/utils.js');
load('js/structures.js');
const ORION = load('js/station.js');
const ST = ORION.station;

function assert(c, m) { if (!c) { console.error('  ✗ FAIL:', m); process.exitCode = 1; throw new Error(m); } console.log('  ✓', m); }
function approx(a, b, e) { return Math.abs(a - b) <= (e == null ? 1e-6 : e); }

/* Grafo lineare 0-1-2-…-8; colonia ricca al sistema 0. */
function lineGame(stationSys, supplierKey) {
  const systems = {};
  for (let i = 0; i <= 8; i++) {
    const links = [];
    if (i > 0) links.push(i - 1);
    if (i < 8) links.push(i + 1);
    systems[i] = { id: i, name: 'S' + i, links: links };
  }
  return {
    timeImpulsi: 0,
    galaxy: { systems: systems },
    colonies: { 'A': { systemId: 0, colonized: true, phase: 'operational', stock: { food: 1000, water: 1000, met: 1000, en: 1000 } } },
    stations: [{
      id: 'st1', name: 'Test', systemId: stationSys, bodyKey: null,
      ownerColonyKey: 'A', supplierColonyKey: supplierKey || 'A',
      level: 2, phase: 'operational', owner: null, supplyState: 'ok',
      hp: 100, store: { food: 0, water: 0, met: 0, en: 0 }, buildQueue: []
    }]
  };
}

console.log('— Test 1: magazzino — cap per-risorsa + migrazione lazy');
{
  const cap = ST.storeCap(2);
  assert(cap.en === 1200 && cap.met === 500 && cap.food === 400, 'storeCap(2) per-risorsa (en 1200 dominante)');
  /* Stazione vecchia con supply astratto + metReserve → store. */
  const old = { level: 2, supply: 400, metReserve: 100 };
  const s = ST.ensureStore(old);
  assert(old.supply === undefined && old.metReserve === undefined, 'campi legacy rimossi dopo migrazione');
  assert(s.met > 100 && s.en > 0 && s.food > 0, 'store popolato dai legacy (met include metReserve)');
  assert(ST.ensureStore(old) === s, 'migrazione idempotente');
}

console.log('— Test 2: gradiente L');
{
  assert(ST.logisticsLForHops(0) === 1 && ST.logisticsLForHops(4) === 1, 'L=1.0 entro COMFORT (≤4)');
  assert(approx(ST.logisticsLForHops(8), 0.50), 'L=0.50 a MAX_RANGE (8)');
  assert(approx(ST.logisticsLForHops(6), 0.75), 'L=0.75 a 6 hop (lineare)');
  assert(ST.logisticsLForHops(9) === 0, 'L=0 oltre MAX_RANGE');
}

console.log('— Test 3: supplier esplicito, fallback, assegnazione');
{
  const g = lineGame(4, 'A');                 // colonia a 4 hop
  const r = ST.supplierColonyFor(g, g.stations[0]);
  assert(r && r.key === 'A' && r.hops === 4 && r.L === 1 && !r.fellBack, 'supplier esplicito valido entro raggio (h=4, L=1)');
  /* Rifornitrice persa → fallback. Aggiungo seconda colonia a sys 6. */
  g.colonies['B'] = { systemId: 6, colonized: true, phase: 'operational', stock: { food: 10, water: 10, met: 10, en: 10 } };
  delete g.colonies['A'];                      // la scelta 'A' non è più valida
  const r2 = ST.supplierColonyFor(g, g.stations[0]);
  assert(r2 && r2.key === 'B' && r2.fellBack === true, 'fallback alla valida più vicina con fellBack=true');
  /* Assegnazione manuale: 'B' è a 2 hop dalla stazione (sys4→sys6) → ok. */
  const a = ST.assignSupplier(g, g.stations[0], 'B');
  assert(a.ok && g.stations[0].supplierColonyKey === 'B', 'assignSupplier entro raggio ok');
  /* Stazione lontanissima: nessuna colonia entro MAX_RANGE → null. */
  const gFar = lineGame(8, 'A'); gFar.colonies = { 'A': { systemId: 0, colonized: true, phase: 'operational', stock: {} } };
  // sys8 da sys0 = 8 hop = MAX_RANGE → ancora valido; spostiamo la colonia "oltre" impossibile in lin(0..8), quindi verifichiamo h=8 = limite
  const rFar = ST.supplierColonyFor(gFar, gFar.stations[0]);
  assert(rFar && rFar.hops === 8 && approx(rFar.L, 0.5), 'a 8 hop ancora rifornita ma L=0.5');
}

console.log('— Test 4: tick — rifornimento × L, upkeep, riparazione × L');
{
  /* Vicino (h=4, L=1). */
  const g = lineGame(4, 'A'); g.stations[0].hp = 100;
  ST.tick(g, []);
  const s = g.stations[0].store;
  assert(approx(s.en, 9 * 2 * 1), 'refill energia = REFILL_RATE.en × lvl × L (9·2·1=18)');
  assert(approx(s.food, 3 * 2 * 1 - 0.2 * 2), 'refill food meno upkeep (6 − 0.4 = 5.6)');
  assert(approx(s.met, 5 * 2 * 1), 'refill metallo (5·2·1=10)');
  /* Lontano (h=8, L=0.5): ritmi dimezzati. */
  const gf = lineGame(8, 'A');
  ST.tick(gf, []);
  assert(approx(gf.stations[0].store.en, 9 * 2 * 0.5), 'refill energia × L a 8 hop (9·2·0.5=9)');
  /* Riparazione × L. */
  const gr = lineGame(4, 'A'); gr.stations[0].hp = 100;
  ST.tick(gr, []);
  const hpGain4 = gr.stations[0].hp - 100;
  const gr8 = lineGame(8, 'A'); gr8.stations[0].hp = 100;
  ST.tick(gr8, []);
  const hpGain8 = gr8.stations[0].hp - 100;
  assert(approx(hpGain4, 1.2 * 2 * 1), 'riparazione vicino = REPAIR × lvl × 1.0 (2.4)');
  assert(approx(hpGain8, 1.2 * 2 * 0.5), 'riparazione lontano dimezzata (1.2)');
}

console.log('— Test 5: refuel tipizzato (4 risorse in proporzione, limite scarsità)');
{
  const g = lineGame(4, 'A');
  const st = g.stations[0];
  st.store = { food: 100, water: 100, met: 100, en: 30 };   // energia scarsa → collo di bottiglia
  const costPerI = { food: 1, water: 1, met: 1, en: 5 };
  const giveI = ST.drawRefuelTyped(g, st, costPerI, 10);     // vuole 10 Ι
  assert(giveI === 6, 'Ι forniti limitati dall\'energia (30/(5·10)=0.6 → 6 Ι)');
  assert(approx(st.store.en, 0), 'energia esaurita (30 − 5·6)');
  assert(approx(st.store.food, 100 - 6), 'food consumato in proporzione (1·6)');
  assert(approx(st.store.met, 100 - 6), 'metallo consumato in proporzione');
}

console.log('\nTutti i test della logistica stazione superati.');
