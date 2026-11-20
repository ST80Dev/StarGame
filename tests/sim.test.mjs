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
