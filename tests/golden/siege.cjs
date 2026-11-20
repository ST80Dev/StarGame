/* Scenari d'assedio deterministici (colonia e stazione): incursione pirata
   di livello L sul sistema natale, si avanza finché l'assedio si chiude.
   Registra la sequenza di eventi siege-* e l'hash dello stato toccato.
   Usato da tests/siege.test.mjs per verificare l'unificazione dei motori. */
'use strict';
const { load, sectionHashes } = require('../harness.cjs');

function scenario(target, level, stationLevel, ships, capRound) {
  const ctx = load();
  const O = ctx.ORION;
  const game = O.newgame.create('siege-' + target + '-' + level + '-' + (stationLevel || 0), {});
  O.time.advance(game, 80);                       // fine insediamento
  const sys = game.galaxy.homeId;
  /* Difensori: una flotta militare in porto alla colonia natale. */
  if (ships) {
    const key = game.homePlanetKey, col = game.colonies[key];
    const cf = O.fleet.createFleet(game, key, 'Difesa');
    for (const kind of Object.keys(ships)) {
      col.ships[kind] = (col.ships[kind] || 0) + ships[kind];
      const r = O.fleet.assignShips(game, cf.fleet, key, kind, ships[kind]);
      if (!r.ok) throw new Error('assignShips: ' + r.reason);
    }
  }
  const inc = { id: 'inc-test', kind: 'pirate', level: level, targetSysId: sys, eta: 1 };
  if (target === 'station') {
    const lvl = stationLevel || 1;
    const st = {
      id: 'st-test', name: 'Stazione Test', systemId: sys, bodyKey: null,
      ownerColonyKey: game.homePlanetKey, level: lvl, phase: 'active',
      buildLeft: 0, buildTotal: 0, hp: O.station.maxHp ? O.station.maxHp(lvl) : 300,
      store: { food: 50, water: 50, met: 50, en: 50 }, supplyState: 'ok',
      supplierColonyKey: game.homePlanetKey, owner: null, buildQueue: [], yardFleetId: null
    };
    game.stations.push(st);
    inc.targetStationId = st.id;
  }
  game.incursions.push(inc);
  const log = [];
  for (let i = 0; i < 400 && log.every(e => e.kind !== 'siege-end'); i++) {
    const r = O.time.advance(game, 1);
    /* Variante "cap": porta l'assedio al round 11 → il prossimo è l'ultimo. */
    if (capRound && game.battles.length && game.battles[0].round === 0) game.battles[0].round = 11;
    for (const e of r.events) {
      if (String(e.kind).indexOf('siege') === 0) {
        log.push({ kind: e.kind, outcome: e.outcome || null, round: e.round || null,
          atk: e.atk != null ? Math.round(e.atk) : null, def: e.def != null ? Math.round(e.def) : null });
      }
    }
  }
  const p = O.save.serialize(game);
  const h = sectionHashes({ colonies: p.colonies, stations: p.stations, battles: p.battles, warState: p.warState, fleets: p.fleets });
  return { log, h };
}

const SCENARIOS = [];
const FLEETS = { none: null, light: { corvetta: 2 }, heavy: { fregata: 2, corvetta: 3 } };
for (const L of [1, 3, 6, 10]) for (const f of ['none', 'light', 'heavy']) SCENARIOS.push(['colony', L, 0, f]);
for (const L of [1, 3, 6, 10]) for (const S of [1, 3]) for (const f of ['none', 'light']) SCENARIOS.push(['station', L, S, f]);

/* Al limite dei 12 round (decisione utente 2026-11-20: stessa regola per
   colonia e stazione → confronto hp). */
for (const L of [3, 6, 10]) SCENARIOS.push(['colony', L, 0, 'heavy', true]);
for (const L of [3, 6, 10]) SCENARIOS.push(['station', L, 1, 'light', true], ['station', L, 3, 'none', true]);

function runAll() {
  const out = {};
  for (const [t, L, S, f, cap] of SCENARIOS) {
    out[t + ':L' + L + ':S' + S + ':' + f + (cap ? ':cap' : '')] = scenario(t, L, S, FLEETS[f], cap);
  }
  return out;
}

module.exports = { scenario, runAll, SCENARIOS };
