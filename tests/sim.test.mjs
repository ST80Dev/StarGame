/* Test mirati della simulazione (headless, contesto vm isolato per test). */
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const { load } = require('./harness.cjs');

function fresh(seed) {
  const ctx = load();
  const O = ctx.ORION;
  const game = O.newgame.create(seed || 'sim-test', {});
  return { O, game };
}

/* Round-trip save: serialize → JSON → create(payload). */
function reload(O, game) {
  const payload = JSON.parse(JSON.stringify(O.save.serialize(game)));
  const back = O.newgame.create(payload.seed, { payload });
  /* create() imposta ORION.game: ripristina l'originale, che alcuni moduli
     leggono ancora dal global (debito noto). */
  O.game = game;
  return back;
}

describe('save round-trip', () => {
  it('B1: i presidi sopravvivono al salvataggio', () => {
    const { O, game } = fresh();
    game.garrisons = { 7: { sysId: 7, fleetId: 'f-1', status: 'active', compromisedSince: null, sinceI: 0 } };
    const back = reload(O, game);
    expect(back.garrisons).toEqual(game.garrisons);
  });

  it('B2: lo stato zombie occupations non è più nel save', () => {
    const { O, game } = fresh();
    expect(O.save.serialize(game)).not.toHaveProperty('occupations');
  });

  /* Salvare e ricaricare non deve cambiare lo stato: se qualcosa viene
     "normalizzato" solo al load, la partita si comporta in modo diverso
     prima e dopo un reload. */
  for (const seed of ['rt-alpha', 'rt-beta', 'rt-gamma']) {
    it('il round-trip preserva lo stato serializzato · ' + seed, () => {
      const { O, game } = fresh(seed);
      for (const t of [50, 500, 2000]) {
        O.time.advance(game, t - game.timeImpulsi);
        const a = O.save.serialize(game);
        const b = O.save.serialize(reload(O, game));
        const diff = Object.keys(a).filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
        expect(diff, 'Impulso ' + t).toEqual([]);
      }
    });
  }
});

describe('viaggi', () => {
  it("B3: l'Iperguida del giocatore non accelera le flotte IA", () => {
    const { O, game } = fresh('b3-seed');
    const g = game.galaxy;
    const [a, b] = [0, g.systems[0].links ? g.systems[0].links[0] : 1];
    const aiBefore = O.aifleet.legEta(game, a, b, 1);
    const playerBefore = O.fleet.tempoLeg(g, a, b, 1);
    game.research.unlocked.push('iperguida');
    expect(O.research.hyperMul(game)).toBeLessThan(1);
    expect(O.fleet.tempoLeg(g, a, b, 1)).toBeLessThan(playerBefore);   // il giocatore accelera
    expect(O.aifleet.legEta(game, a, b, 1)).toBe(aiBefore);            // l'IA no
  });
});

describe('pagatori', () => {
  it('B5: la ricerca addebita la capitale del gruppo natale', () => {
    const { O, game } = fresh('b5-seed');
    const cap = O.capital.getOf(game, game.galaxy.homeGroupId);
    expect(O.research.payerColonyKey(game)).toBe(cap);
    /* Se la capitale non coincide con la home, vince la capitale. */
    const fake = '999:b1';
    game.colonies[fake] = Object.assign({}, game.colonies[game.homePlanetKey]);
    game.capitals[game.galaxy.homeGroupId] = fake;
    expect(O.capital.getOf(game, game.galaxy.homeGroupId)).toBe(fake);
    expect(O.research.payerColonyKey(game)).toBe(fake);
  });
});

describe('schema save (Revisione 2026)', () => {
  it('rifiuta i save pre-reset con un messaggio chiaro', () => {
    const { O } = fresh();
    const old = { schema: 32, seed: 'x', colonies: {} };
    expect(O.save.isCompatible(old)).toBe(false);
    expect(O.save.incompatibilityReason(old)).toMatch(/Revisione 2026/);
    expect(O.save.parseImport(JSON.stringify(old)).ok).toBe(false);
  });

  it('serialize contiene esattamente i campi dichiarati in STATE_FIELDS', () => {
    const { O, game } = fresh();
    const keys = Object.keys(O.save.serialize(game)).sort();
    const want = ['schema', 'seed', 'discovery', ...O.save.STATE_FIELDS.map(f => f[0])].sort();
    expect(keys).toEqual(want);
  });
});

describe('comandi (livello comandi, Revisione 2026)', () => {
  function withColonialFleet(seed) {
    const { O, game } = fresh(seed);
    O.time.advance(game, 80);
    const key = game.homePlanetKey, home = game.colonies[key];
    Object.assign(home.stock, { met: 5000, en: 5000, food: 5000, water: 5000 });
    home.ships.coloniale = 1;
    const fleet = O.fleet.createFleet(game, key, null).fleet;
    expect(O.fleet.assignShips(game, fleet, key, 'coloniale', 1).ok).toBe(true);
    for (let i = 0; i < 4; i++) home.crews.explorer.push({ id: O.time.nextCrewId(game), xp: 1 });
    expect(O.fleet.assignCrew(game, fleet, key, 4).ok).toBe(true);
    /* Bersaglio: un altro corpo del sistema natale. */
    const sys = O.system.generate(game.galaxy, game.galaxy.homeId);
    const body = sys.bodies.find(b => game.galaxy.homeId + ':' + b.key !== key && b.type !== 'cintura' && b.type !== 'gassoso');
    const planet = O.planet.generate(game.galaxy, sys, body.key);
    game.colonies[planet.systemId + ':' + planet.bodyKey] = O.planet.createColony(planet);
    return { O, game, home, fleet, planet };
  }

  it('colonize: paga il costo, imposta l\'ordine e ribattezza la flotta', () => {
    const { O, game, home, fleet, planet } = withColonialFleet('cmd-col');
    const before = Object.assign({}, home.stock);
    const cost = O.commands.colonizeCost(game, planet, fleet, 0).totalCost;
    const r = O.commands.colonize(game, planet, fleet, 0);
    expect(r.ok).toBe(true);
    expect(fleet.orders.type).toBe('colonize');
    expect(fleet.name).toMatch(/^Pioniere \d+$/);
    for (const k of ['met', 'en', 'food', 'water']) expect(home.stock[k]).toBe(before[k] - cost[k]);
    /* La colonia nasce davvero avanzando il tempo. */
    O.time.advance(game, 200);
    expect(game.colonies[planet.systemId + ':' + planet.bodyKey].colonized).toBe(true);
  });

  it('colonize: risorse insufficienti → nessun effetto', () => {
    const { O, game, home, fleet, planet } = withColonialFleet('cmd-col2');
    Object.assign(home.stock, { met: 0, en: 0, food: 0, water: 0 });
    const r = O.commands.colonize(game, planet, fleet, 0);
    expect(r).toEqual({ ok: false, reason: 'Risorse insufficienti' });
    expect(fleet.orders == null || fleet.orders.type !== 'colonize').toBe(true);
  });

  it('payTribute: revoca l\'assedio, scala le risorse, tregua con la civiltà AI', () => {
    const { O, game } = fresh('cmd-trib');
    O.time.advance(game, 80);
    const key = game.homePlanetKey, home = game.colonies[key];
    Object.assign(home.stock, { met: 1000, en: 1000 });
    const civ = game.civs.find(c => c.alive);
    game.battles.push({ id: 'b1', attackerKind: 'ai', attackerCiv: civ.id, colonyKey: key, systemId: game.galaxy.homeId,
      attacker: { combatants: [{ hp: 100 }, { hp: 50 }] }, status: 'active', round: 1, nextRoundAt: 999, log: [] });
    const r = O.commands.payTribute(game, 'b1');
    expect(r.ok).toBe(true);
    expect(r.cost).toEqual({ met: 90, en: 45 });
    expect(home.stock.met).toBe(910);
    expect(game.battles.length).toBe(0);
    expect(civ.truceUntil).toBe(game.timeImpulsi + 200);
  });
});

describe('viaggi: durata unica e rischio (Revisione 2026, A+B)', () => {
  function farTarget(O, game, hops) {
    const g = game.galaxy;
    for (let t = 0; t < g.systems.length; t++) {
      const p = O.galaxy.bfsPath(g, g.homeId, t);
      if (p && p.length - 1 === hops) return { t, p };
    }
    throw new Error('nessun bersaglio a ' + hops + ' hop');
  }

  it("l'ingegnere (Navigatore) accorcia la stima E il rischio d'incidente", () => {
    const { O, game } = fresh('trav-nav');
    const { t, p } = farTarget(O, game, 2);
    const base = { ships: [{ kind: 'explorer' }], crew: [{ xp: 0 }], route: p, orders: { toSysId: t }, location: { systemId: game.galaxy.homeId } };
    const nav = Object.assign({}, base, { officers: [{ id: 'o1', role: 'ingegnere', xp: 0 }] });
    expect(O.fleet.routeImpulsi(game.galaxy, nav, p)).toBeLessThan(O.fleet.routeImpulsi(game.galaxy, base, p));
  });

  it('la stima coincide con la durata reale assegnata al viaggio', () => {
    const { O, game } = fresh('trav-real');
    O.time.advance(game, 70);
    const key = game.homePlanetKey, home = game.colonies[key];
    const { t, p } = farTarget(O, game, 1);
    home.ships.explorer = (home.ships.explorer || 0) + 1;
    const fleet = O.fleet.createFleet(game, key, null).fleet;
    O.fleet.assignShips(game, fleet, key, 'explorer', 1);
    O.fleet.assignCrew(game, fleet, key, 1);
    const est = O.fleet.routeImpulsi(game.galaxy, fleet, p);
    expect(O.fleet.setOrder(game, fleet, { type: 'move', toSysId: t }).ok).toBe(true);
    O.time.advance(game, 1);
    expect(fleet.legTotal).toBe(est);
  });

  it('gli esiti stimati sommano alla probabilità di incidente', () => {
    const { O, game } = fresh('trav-out');
    for (const hops of [1, 3, 5]) {
      const { t } = farTarget(O, game, hops);
      const r = O.fleet.estimateTravelOutcome(game, game.galaxy.homeId, t, { crewXp: 0 });
      expect(r.delay + r.wear + r.shipLoss + r.bonus).toBeCloseTo(r.chance, 10);
      expect(r.shipLoss).toBeLessThanOrEqual(r.chance * 0.15 + 1e-12);
    }
  });
});

describe('reputazione e ICG: unico punto di scrittura (Revisione 2026)', () => {
  it('una deriva senza motivo non va nello storico ma fa scattare la soglia', () => {
    const { O, game } = fresh('rep-drift');
    game.reputation = 71; O.reputation.ensure(game);
    const hist = game.repHistory.length;
    O.reputation.change(game, 'rep', -2);                 // 71 → 69: attraversa 70
    expect(game.repHistory.length).toBe(hist);
    expect(game.chronicle.some(e => e && e.kind === 'rep-threshold')).toBe(true);
  });

  it('una variazione con motivo va nello storico', () => {
    const { O, game } = fresh('rep-label');
    O.diplomacy.adjustReputation(game, -4, 'mekhari', 'Servizio Mekhari');
    expect(game.repHistory[0]).toMatchObject({ kind: 'rep', source: 'mekhari', label: 'Servizio Mekhari' });
  });

  it('la soglia superata da una deriva non si perde con un ricaricamento', () => {
    const { O, game } = fresh('rep-reload');
    game.icg = 59; O.reputation.ensure(game);
    O.reputation.change(game, 'icg', 2);                  // 59 → 61: attraversa 60
    const payload = JSON.parse(JSON.stringify(O.save.serialize(game)));
    expect(payload.chronicle.some(e => e && e.kind === 'icg-threshold')).toBe(true);
  });
});

describe('forza militare IA: stima = battaglia (docs/AI_FORZA_MILITARE.md, opzione A)', () => {
  it('la stima "se attacchi" coincide con la forza schierata in battaglia', () => {
    const { O, game } = fresh('ai-force');
    O.time.advance(game, 600);
    let checked = 0;
    for (const c of game.civs) {
      if (!c.alive || !c.planets || !c.planets.length) continue;
      const pk = c.planets[0];
      const sid = Number(pk.split(':')[0]);
      const est = O.ai.aiCombatPowerAt(game, c, 'colony', pk);
      const force = O.combat.forceFromMaterialized(O.ai.materialize(game, c, sid), 'B');
      const p = force.combatants.reduce((x, k) => x + k.hp + k.fp * 8, 0);
      expect(est.total).toBe(p);
      expect(est.total).toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBeGreaterThan(3);
  });
});
