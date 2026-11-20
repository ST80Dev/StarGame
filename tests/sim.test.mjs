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
