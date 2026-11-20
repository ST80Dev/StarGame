/* Golden replay: stesso seed + stessa sequenza → stesso stato (decisione #5).
   Oggi la sequenza è "nuova partita + N Impulsi" (simulazione IA, economia,
   eventi). I comandi del giocatore entreranno quando esisterà il livello
   comandi (Revisione 2026, Fase 2). */
'use strict';
const { load, sectionHashes } = require('../harness.cjs');

const SEEDS = ['golden-alpha', 'golden-beta', 'golden-gamma'];
const TICKS = 3000;
const EVERY = 500;

function newGame(ctx, seed) {
  const O = ctx.ORION;
  if (O.newgame && O.newgame.create) return O.newgame.create(seed, {});
  return ctx.newGame(seed, {});           // pre-estrazione: main.js
}

function advance(O, game, n) {
  if (O.time.advance.length >= 2) return O.time.advance(game, n);
  return O.time.advance(n);
}

function runSeed(seed) {
  const ctx = load({ main: !globalHasNewgame() });
  const O = ctx.ORION;
  const game = newGame(ctx, seed);
  const checkpoints = [];
  for (let t = EVERY; t <= TICKS; t += EVERY) {
    for (let i = 0; i < EVERY; i++) advance(O, game, 1);
    const payload = O.save.serialize(game);
    /* La cronaca oggi è HTML composto dalla UI (main.js), non stato di
       simulazione: esclusa finché non diventa {kind,data} (Fase 2). */
    delete payload.chronicle;
    checkpoints.push({ t: game.timeImpulsi, h: sectionHashes(payload) });
  }
  return checkpoints;
}

/* Se il modulo js/newgame.js esiste, la simulazione si crea senza main.js. */
function globalHasNewgame() {
  return require('fs').existsSync(require('path').join(__dirname, '../../js/newgame.js'));
}

function run(seeds) {
  const out = {};
  for (const s of (seeds || SEEDS)) out[s] = runSeed(s);
  return out;
}

module.exports = { run, runSeed, SEEDS, TICKS, EVERY };
