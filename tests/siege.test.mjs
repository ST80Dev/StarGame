/* Motore d'assedio unico (colonia + stazione): gli scenari in
   tests/golden/siege.cjs devono riprodurre la baseline. Baseline rigenerata
   all'unificazione: rispetto ai due motori separati cambiavano SOLO gli
   assedi-stazione arrivati al 12° round con difensore in vantaggio (prima
   cadevano comunque, ora vengono respinti come le colonie). */
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const { runAll } = require('./golden/siege.cjs');
const baseline = require('./golden/siege-baseline.json');

describe('assedi', () => {
  const got = runAll();
  for (const k of Object.keys(baseline)) {
    it(k, () => { expect(got[k]).toEqual(baseline[k]); });
  }

  it('al 12° round la stazione in vantaggio respinge l\'assedio', () => {
    const r = got['station:L3:S3:none:cap'];
    const end = r.log.find(e => e.kind === 'siege-end');
    const last = r.log.filter(e => e.kind === 'siege-round').pop();
    expect(last.def).toBeGreaterThan(last.atk);
    expect(end.outcome).toBe('repelled');
  });
});
