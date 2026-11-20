/* Golden replay: lo stato dopo N Impulsi deve coincidere con la baseline.
   Se una modifica cambia il gameplay DI PROPOSITO, rigenerare la baseline con
   `npm run golden:write` e spiegare nel commit quali sezioni cambiano e perché. */
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const { runSeed, SEEDS } = require('./golden/replay.cjs');
const baseline = require('./golden/baseline.json');

describe('golden replay', () => {
  for (const seed of SEEDS) {
    it(seed, () => {
      const got = runSeed(seed);
      for (let i = 0; i < baseline[seed].length; i++) {
        const exp = baseline[seed][i];
        const diff = Object.keys({ ...exp.h, ...got[i].h }).filter(k => exp.h[k] !== got[i].h[k]);
        expect({ t: got[i].t, diff }, 'checkpoint ' + exp.t).toEqual({ t: exp.t, diff: [] });
      }
    });
  }
});
