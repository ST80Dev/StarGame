/* =====================================================================
   Test headless — Estrazione orbitale da TUTTI i corpi (redesign 2026).
   node test-orbital-extraction.js
   Verifica:
     1. bodyGiacimento: ogni pianeta roccioso → paniere (kind 'pianeta').
     2. ensureSites crea il sito-pianeta col mix; salta i corpi colonizzati.
     3. fleet-target: pianeta libero offre Colonizza E Estrai; AI/mia colonia no.
     4. Regen DOPPIA: idle (alta) senza estrattore, active (bassa) con estrattore.
     5. Backfill lazy: vecchio sito cintura mono → paniere al tick.
     6. Mutua esclusione: colonizzare un corpo rimuove il suo sito al tick.
   ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const root = { console: console };
function load(rel) {
  const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
  return eval('(function(globalThis, window){' + src + '\nreturn globalThis.ORION;})')(root, root);
}
load('js/rng.js'); load('js/utils.js'); load('js/system.js'); load('js/planet.js'); load('js/station.js');
const ORION = load('js/anomaly.js'); load('js/fleet-target.js');
const A = ORION.anomaly;

function assert(c, m) { if (!c) { console.error('  ✗ FAIL:', m); process.exitCode = 1; throw new Error(m); } console.log('  ✓', m); }
function approx(a, b, e) { return Math.abs(a - b) <= (e == null ? 1e-6 : e); }

/* Sistema 7: un desertico (b0) + una cintura (b1). */
const SYS = {
  id: 7, name: 'TST', stars: { label: 'G' }, anomalies: [], links: [8],
  bodies: [
    { key: 'b0', index: 0, type: 'desertico', name: 'Aridus', designation: 'I', orbit: 0.3, angle: 1, radius: 0.03, seed: 'TST:sys:7:b0', moons: [] },
    { key: 'b1', index: 1, type: 'cintura', name: 'Belt', designation: 'II', orbit: 0.5, angle: 2, beltWidth: 0.04, radius: 0, seed: 'TST:sys:7:b1', moons: [] }
  ]
};
ORION.system.generate = function (g, id) { return id === 7 ? SYS : null; };
ORION.galaxy = { DISCOVERY: { EXPLORED: 2 } };

function makeGame() {
  return {
    seed: 'TST', timeImpulsi: 0,
    galaxy: { seed: 'TST', systems: { 7: { id: 7, name: 'A', links: [8] }, 8: { id: 8, name: 'B', links: [7] } } },
    colonies: { '8:b0': { systemId: 8, colonized: true, phase: 'operational', stock: { met: 0, en: 0, food: 0, water: 0 }, structures: {} } },
    fleets: [], stations: [], anomalies: {}, state: { discovery: [] }
  };
}
function extractorFleet(bodyKey, kind) {
  return {
    id: 'f1', ownerColonyKey: '8:b0', ships: [{ kind: 'estrattore', wear: 0 }],
    location: { systemId: 7, status: 'orbiting', bodyKey: bodyKey },
    orders: { type: 'survey', anomalyKind: kind, bodyKey: bodyKey }
  };
}

console.log('— Test 1: bodyGiacimento — ogni pianeta roccioso è paniere');
{
  ['terrestre', 'desertico', 'oceanico', 'ghiacciato', 'vulcanico', 'forestale'].forEach(function (t) {
    const gi = A.bodyGiacimento({ type: t });
    assert(gi && gi.kind === 'pianeta' && gi.basket === true, t + ' → paniere (kind pianeta)');
  });
}

console.log('— Test 2: ensureSites crea il sito-pianeta col mix (met-dominante per desertico)');
{
  const g = makeGame();
  A.ensureSites(g, 7);
  const site = g.anomalies['7:pianeta:b0'];
  assert(!!site && site.basket && site.cap === 1500, 'sito-pianeta creato (cap 1500)');
  assert(site.mix && site.mix.met > site.mix.food && site.mix.met > site.mix.water, 'mix met-dominante (desertico)');
  /* Corpo colonizzato → niente sito. */
  const g2 = makeGame();
  g2.colonies['7:b0'] = { systemId: 7, colonized: true, phase: 'operational', stock: {}, structures: {} };
  A.ensureSites(g2, 7);
  assert(!g2.anomalies['7:pianeta:b0'], 'corpo colonizzato → nessun sito d\'estrazione');
}

console.log('— Test 3: fleet-target — pianeta libero offre Colonizza E Estrai');
{
  const g = makeGame(); g.state.discovery[7] = 2;
  const d = ORION.fleetTarget.describe(g, 7, 'b0');
  assert(d.colonizable === true, 'desertico libero → colonizzabile');
  assert(d.giacimento === true, 'desertico libero → estraibile (giacimento)');
  /* Mia colonia → nessuna delle due. */
  const gc = makeGame(); gc.state.discovery[7] = 2;
  gc.colonies['7:b0'] = { systemId: 7, colonized: true, phase: 'operational', stock: {}, structures: {} };
  const dc = ORION.fleetTarget.describe(gc, 7, 'b0');
  assert(dc.giacimento === false && dc.colonizable === false, 'mia colonia → né Estrai né Colonizza');
}

console.log('— Test 4: regen DOPPIA (idle alta / active bassa)');
{
  /* Idle: nessun estrattore → regenIdle 3.0. */
  const g = makeGame(); A.ensureSites(g, 7);
  const site = g.anomalies['7:pianeta:b0']; site.reserve = 1000;
  A.tick(g, []);
  assert(approx(site.reserve, 1003.0), 'idle → riserva +regenIdle (3.0)');
  /* Active: estrattore presente → regenActive 1.0, poi prelievo rate 3.0. */
  const g2 = makeGame(); A.ensureSites(g2, 7);
  const s2 = g2.anomalies['7:pianeta:b0']; s2.reserve = 1000;
  g2.fleets = [extractorFleet('b0', 'pianeta')];
  A.tick(g2, []);
  // regen active +1.0 = 1001, poi take = min(3.0, 1001) = 3.0 → 998
  assert(approx(s2.reserve, 998.0), 'active → +regenActive(1.0) poi −rate(3.0) = −2 netto');
  const col = g2.colonies['8:b0'];
  assert((col.stock.met + col.stock.en + col.stock.food + col.stock.water) > 0, 'paniere depositato alla colonia');
}

console.log('— Test 5: backfill lazy — vecchia cintura mono → paniere');
{
  const g = makeGame();
  /* Simula un sito cintura "vecchio stile": mono, senza basket/mix. */
  g.anomalies['7:cintura:b1'] = { sysId: 7, kind: 'cintura', bodyKey: 'b1', res: 'met', cap: 600, reserve: 600, lowFlag: false, harvested: 0 };
  A.tick(g, []);
  const s = g.anomalies['7:cintura:b1'];
  assert(s.basket === true && s.mix && s.mix.met > 0, 'cintura backfillata a paniere (mix met-dominante)');
}

console.log('— Test 6: mutua esclusione — colonizzare rimuove il sito al tick');
{
  const g = makeGame(); A.ensureSites(g, 7);
  assert(!!g.anomalies['7:pianeta:b0'], 'sito presente prima della colonizzazione');
  g.colonies['7:b0'] = { systemId: 7, colonized: true, phase: 'operational', stock: {}, structures: {} };
  A.tick(g, []);
  assert(!g.anomalies['7:pianeta:b0'], 'sito rimosso dopo la colonizzazione del corpo');
}

console.log('\nTutti i test dell\'estrazione orbitale superati.');
