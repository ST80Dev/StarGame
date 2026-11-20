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
