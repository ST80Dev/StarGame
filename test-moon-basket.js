/* =====================================================================
   Test headless — Redesign lune 2026 (richiesta utente): luna non
   colonizzabile + GIACIMENTO A PANIERE + scan Osservatorio + stazione
   ancorata. Esegui con:  node test-moon-basket.js
   Verifica:
     1. Luna non abitabile (BODY_TYPES + planet.generate) → non colonizzabile,
        ma giacimento (fleet-target.describe).
     2. bodyGiacimento(luna) = paniere; cintura/gassoso restano mono-risorsa.
     3. ensureSites crea il sito-luna (appiattendo body.moons) con mix dai
        potenziali. Determinismo: stesso seed → stesso mix.
     4. Estrazione a paniere via flotta: deposita TUTTE le basi in proporzione;
        lo strato avanzato (exoticAccum) entra SOLO dopo advRevealed.
     5. Scan Osservatorio entro raggio → advRevealed permanente.
     6. Stazione ancorata: estrae di default (rate ∝ livello), precedenza
        sull'estrattore (mutua esclusione), nessuna usura nave.
   ===================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const root = { console: console };
function load(rel) {
  const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
  const wrap = '(function(globalThis, window){' + src + '\nreturn globalThis.ORION;})';
  return eval(wrap)(root, root);
}
load('js/rng.js');
load('js/utils.js');
load('js/system.js');
load('js/planet.js');
load('js/station.js');
const ORION = load('js/anomaly.js');
load('js/fleet-target.js');

function assert(cond, msg) {
  if (!cond) { console.error('  ✗ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  console.log('  ✓', msg);
}
function approx(a, b, eps) { return Math.abs(a - b) <= (eps == null ? 1e-6 : eps); }

/* --- Sistema finto con una luna figlia di un gigante gassoso --- */
function makeSystem() {
  const moon = {
    key: 'b0m0', index: 0, type: 'luna', name: 'Test L-A', designation: 'I L-A',
    parentKey: 'b0', moonOrbit: 0.02, angle: 0.5, radius: 0.012,
    seed: 'TST:sys:7:b0:m0', moons: []
  };
  const gas = {
    key: 'b0', index: 0, type: 'gassoso', name: 'Test', designation: 'I',
    orbit: 0.3, angle: 1, radius: 0.05, seed: 'TST:sys:7:b0', moons: [moon]
  };
  return { id: 7, name: 'TST-SYS', stars: { label: 'G' }, bodies: [gas], anomalies: [], links: [8] };
}
const SYS = makeSystem();
/* Override generate: ritorna il nostro sistema per id 7 (evita di costruire
   una galassia reale). findBody resta quello vero (gestisce le lune annidate). */
ORION.system.generate = function (galaxy, id) { return (id === 7) ? SYS : null; };
ORION.galaxy = { DISCOVERY: { EXPLORED: 2 } };

function makeGame(withObservatory) {
  const colony = {
    systemId: 8, colonized: true, isHomeBase: false,
    stock: { met: 0, en: 0, food: 0, water: 0 }, exoticAccum: 0,
    structures: withObservatory ? { 'osservatorio': { level: 1, hp: 100 } } : {}
  };
  return {
    seed: 'TST', timeImpulsi: 0,
    galaxy: { seed: 'TST', systems: { 7: { id: 7, name: 'A', links: [8] }, 8: { id: 8, name: 'B', links: [7] } } },
    colonies: { '8:b0': colony },
    fleets: [], stations: [], anomalies: {}, state: { discovery: [] }
  };
}
function extractorFleet() {
  return {
    id: 'f1', ownerColonyKey: '8:b0', ships: [{ kind: 'estrattore', wear: 0 }],
    location: { systemId: 7, status: 'orbiting', bodyKey: 'b0m0' },
    orders: { type: 'survey', anomalyKind: 'luna', bodyKey: 'b0m0' }
  };
}

console.log('— Test 1: luna non abitabile, ma giacimento');
{
  assert(ORION.system.BODY_TYPES.luna.habitable === false, 'BODY_TYPES.luna.habitable = false');
  const planet = ORION.planet.generate(SYS, SYS, 'b0m0');
  assert(planet && planet.habitable === false, 'planet.generate(luna).habitable = false');
  assert(planet.potentials && typeof planet.potentials.en === 'number', 'la luna ha i 4 potenziali base');
  assert(Array.isArray(planet.advanced), 'la luna ha la lista risorse avanzate');
  const g = makeGame(false);
  g.state.discovery[7] = 2;
  const d = ORION.fleetTarget.describe(g, 7, 'b0m0');
  assert(d.colonizable === false, 'describe(luna).colonizable = false');
  assert(d.giacimento === true, 'describe(luna).giacimento = true');
}

console.log('— Test 2: bodyGiacimento — luna=paniere, cintura/gassoso mono');
{
  const moon = ORION.system.findBody(SYS, 'b0m0');
  const gi = ORION.anomaly.bodyGiacimento(moon);
  assert(gi && gi.kind === 'luna' && gi.basket === true && gi.res === null, 'bodyGiacimento(luna) = paniere (res null)');
  /* Redesign estrazione 2026: anche gassoso/cintura ora sono a paniere. */
  const gGas = ORION.anomaly.bodyGiacimento({ type: 'gassoso' });
  assert(gGas && gGas.basket === true, 'gassoso ora a paniere');
  const gBelt = ORION.anomaly.bodyGiacimento({ type: 'cintura' });
  assert(gBelt && gBelt.basket === true, 'cintura ora a paniere');
}

console.log('— Test 3: ensureSites crea il sito-luna con mix + determinismo');
let baselineMix = null;
{
  const g = makeGame(false);
  ORION.anomaly.ensureSites(g, 7);
  const site = g.anomalies['7:luna:b0m0'];
  assert(!!site, 'sito-luna creato (lune annidate appiattite)');
  assert(site.basket === true && site.mix && site.mix.en > 0, 'sito basket con mix (en > 0, eredita dal gigante)');
  assert(site.cap === 1200 && site.reserve === 1200, 'cap luna 1200 (riserva piena)');
  baselineMix = JSON.stringify(site.mix) + '|' + site.exoticW;
  /* Determinismo: un secondo gioco fresco → stesso mix/exoticW. */
  const g2 = makeGame(false);
  ORION.anomaly.ensureSites(g2, 7);
  const site2 = g2.anomalies['7:luna:b0m0'];
  assert(JSON.stringify(site2.mix) + '|' + site2.exoticW === baselineMix, 'stesso seed → stesso mix/exoticW (determinismo #5)');
}

console.log('— Test 4: estrazione a paniere via flotta (base sì, avanzato no)');
{
  const g = makeGame(false);            // niente osservatorio → nessun reveal
  ORION.anomaly.ensureSites(g, 7);
  const site = g.anomalies['7:luna:b0m0'];
  /* Fisso mix/exoticW noti per matematica deterministica del deposito. */
  site.mix = { met: 10, en: 30, food: 0, water: 10 };
  site.exoticW = 20; site.advIds = ['cristalli']; site.advRevealed = false;
  g.fleets = [extractorFleet()];
  const col = g.colonies['8:b0'];
  const rate = ORION.anomaly.CFG.EXTRACTOR_RATE_BASE;   // estrattore L1 (no Hangar)
  ORION.anomaly.tick(g, []);            // riserva al cap → niente regen, take = rate
  assert(approx(col.stock.met, rate * 10 / 50), 'met depositato in proporzione (base, no exotic)');
  assert(approx(col.stock.en, rate * 30 / 50), 'en depositato in proporzione');
  assert(approx(col.stock.water, rate * 10 / 50), 'water depositato in proporzione');
  assert(col.exoticAccum === 0, 'exoticAccum invariato finché non rivelato');
  assert(approx(site.reserve, 1200 - rate), 'riserva scalata del take totale (rate)');
  assert(g.fleets[0].ships[0].wear > 0, 'la nave in survey subisce usura');
}

console.log('— Test 5: scan Osservatorio in raggio → advRevealed → exotic nel paniere');
{
  const g = makeGame(true);             // colonia 8:b0 con osservatorio, 1 hop da sys 7
  ORION.anomaly.ensureSites(g, 7);
  const site = g.anomalies['7:luna:b0m0'];
  site.mix = { met: 10, en: 30, food: 0, water: 10 };
  site.exoticW = 20; site.advIds = ['cristalli']; site.advRevealed = false;
  g.fleets = [extractorFleet()];
  const col = g.colonies['8:b0'];
  const rate = ORION.anomaly.CFG.EXTRACTOR_RATE_BASE;
  ORION.anomaly.tick(g, []);
  assert(site.advRevealed === true, 'Osservatorio entro OBS_SCAN_RANGE → advRevealed = true');
  assert(approx(col.exoticAccum, rate * 20 / 70), 'exoticAccum accresciuto (strato avanzato nel paniere, totale 70)');
  assert(approx(col.stock.en, rate * 30 / 70), 'base ri-normalizzato sul totale con exotic');
}

console.log('— Test 6: stazione ancorata — precedenza estrattore + AUTO-FEED magazzino');
{
  const g = makeGame(false);
  ORION.anomaly.ensureSites(g, 7);
  const site = g.anomalies['7:luna:b0m0'];
  site.mix = { met: 10, en: 30, food: 0, water: 10 }; site.exoticW = 0; site.advRevealed = false;
  /* Stazione lvl 2 ancorata + estrattore presente: la stazione vince (rate 1.6),
     la nave NON si usura. L'estratto AUTO-ALIMENTA il magazzino (store vuoto →
     pieno di room → niente va alla colonia). */
  const st = {
    id: 'st1', systemId: 7, bodyKey: 'b0m0', ownerColonyKey: '8:b0', supplierColonyKey: '8:b0',
    level: 2, phase: 'operational', owner: null, supplyState: 'ok', hp: 300,
    store: { food: 0, water: 0, met: 0, en: 0 }
  };
  g.stations = [st];
  const fleet = extractorFleet();
  g.fleets = [fleet];
  const col = g.colonies['8:b0'];
  const enBefore = col.stock.en;
  const C = ORION.anomaly.CFG;
  const expRate = C.STATION_EXTRACT_BASE + C.STATION_EXTRACT_PER_LVL * (2 - 1);  // lvl2
  ORION.anomaly.tick(g, []);
  assert(approx(site.reserve, 1200 - expRate), 'riserva scalata dal rate stazione, non dall\'estrattore');
  assert(approx(st.store.en, expRate * 30 / 50), 'energia estratta → magazzino stazione (auto-feed)');
  assert(approx(st.store.met, expRate * 10 / 50), 'metallo estratto → magazzino stazione');
  assert(col.stock.en === enBefore, 'colonia NON riceve nulla finché il magazzino ha spazio');
  assert(fleet.ships[0].wear === 0, 'nave NON usurata (estrazione dalla stazione)');
}

console.log('— Test 6b: stazione ancorata — overflow alla colonia × L (magazzino pieno)');
{
  const g = makeGame(true);                 // colonia con osservatorio (per exotic)
  ORION.anomaly.ensureSites(g, 7);
  const site = g.anomalies['7:luna:b0m0'];
  site.mix = { met: 10, en: 30, food: 0, water: 10 }; site.exoticW = 20; site.advRevealed = true;
  /* Magazzino già PIENO ai cap → tutto l'estratto fa overflow alla colonia × L.
     Stazione a 1 hop dalla colonia (sys7→sys8) → L = 1.0. */
  const cap = ORION.station.storeCap(2);
  const st = {
    id: 'st1', systemId: 7, bodyKey: 'b0m0', ownerColonyKey: '8:b0', supplierColonyKey: '8:b0',
    level: 2, phase: 'operational', owner: null, supplyState: 'ok', hp: 300,
    store: { food: cap.food, water: cap.water, met: cap.met, en: cap.en }
  };
  g.stations = [st];
  const col = g.colonies['8:b0'];
  const enBefore = col.stock.en, exBefore = col.exoticAccum;
  const C = ORION.anomaly.CFG;
  const rate = C.STATION_EXTRACT_BASE + C.STATION_EXTRACT_PER_LVL * (2 - 1), totalW = 70;  // base+exotic
  ORION.anomaly.tick(g, []);
  assert(approx(col.stock.en, enBefore + rate * 30 / totalW), 'overflow energia → colonia × L (L=1 a 1 hop)');
  assert(approx(col.exoticAccum, exBefore + rate * 20 / totalW), 'esotici → colonia exoticAccum × L');
}

console.log('— Test 7: build stazione con ancoraggio + mutua esclusione (fetta 2)');
{
  const ST = ORION.station;
  assert(ST.isAnchorableBody({ galaxy: {} }, 7, 'b0m0') === true, 'isAnchorableBody(luna) = true');
  /* Redesign estrazione 2026: ogni corpo a paniere è ancorabile (anche il gigante). */
  assert(ST.isAnchorableBody({ galaxy: {} }, 7, 'b0') === true, 'isAnchorableBody(gigante) = true (tutti i corpi a paniere)');
  assert(ST.isAnchorableBody({ galaxy: {} }, 7, 'zzz') === false, 'isAnchorableBody(corpo inesistente) = false');
  const g = makeGame(false);
  g.state.discovery[7] = 2; g.state.discovery[8] = 2;
  const col = g.colonies['8:b0'];
  col.stock = { met: 500, en: 300, food: 100, water: 100 };
  /* Build con ancoraggio alla luna b0m0. */
  const r = ST.build(g, '8:b0', 7, null, 'b0m0');
  assert(r.ok && r.station && r.station.bodyKey === 'b0m0', 'build ancora la stazione alla luna (station.bodyKey)');
  const st = r.station;
  assert(ST.stationAnchoredAt(g, 7, 'b0m0') === null, 'stazione in costruzione → non ancora ancorata (operativa)');
  /* Rendi operativa: l\'ancoraggio diventa effettivo. */
  st.phase = 'operational'; st.level = 2; st.supplyState = 'ok';
  assert(ST.stationAnchoredAt(g, 7, 'b0m0') === st, 'stazione operativa → ancorata');
  /* Mutua esclusione: con la stazione ancorata, l\'estrattore non ha più Estrai. */
  const d = ORION.fleetTarget.describe(g, 7, 'b0m0');
  assert(d.giacimento === false && d.stationAnchored === true, 'describe: giacimento OFF (stazione ancorata) → niente estrattore');
  /* Build con ancoraggio a un corpo INESISTENTE è rifiutato. */
  const g2 = makeGame(false); g2.state.discovery[7] = 2; g2.state.discovery[8] = 2;
  g2.colonies['8:b0'].stock = { met: 500, en: 300, food: 100, water: 100 };
  const r2 = ST.build(g2, '8:b0', 7, null, 'zzz');
  assert(!r2.ok, 'build con ancoraggio su corpo inesistente rifiutato');
}

console.log('— Test 8: comparsa anticipata — ensureExplored registra le lune senza flotta');
{
  const g = makeGame(false);
  g.state.discovery[7] = 2;                  // sistema 7 esplorato (nessuna flotta lì)
  assert(!g.anomalies['7:luna:b0m0'], 'sito-luna non ancora registrato');
  ORION.anomaly.ensureExplored(g);
  assert(!!g.anomalies['7:luna:b0m0'], 'ensureExplored crea il sito-luna del sistema esplorato');
}

console.log('\nTutti i test superati.');
