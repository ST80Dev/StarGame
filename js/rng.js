/* =====================================================================
   ORION EMPIRES — rng.js
   Modulo M02: generatore pseudo-casuale DETERMINISTICO.

   È il fondamento della strategia di salvataggio "seed + delta"
   (CLAUDE.md, decisione #5): dato lo stesso seed, la galassia si
   rigenera identica. Nessuna dipendenza da Math.random() nella
   generazione della struttura immutabile.

   Algoritmo: mulberry32 (PRNG a 32 bit, veloce e ben distribuito) con
   hashing del seed via una variante di xmur3. Entrambi sono di pubblico
   dominio e adatti a un gioco (non crittografici).
   ===================================================================== */
'use strict';

(function (root) {
  /* xmur3: stringa -> funzione che produce hash a 32 bit.
     Usata per trasformare un seed testuale in un intero stabile. */
  function xmur3(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      h ^= h >>> 16;
      return h >>> 0;
    };
  }

  /* mulberry32: dato un intero a 32 bit, produce float in [0, 1). */
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Normalizza un seed (numero o stringa) in intero a 32 bit. */
  function hashSeed(seed) {
    const str = String(seed);
    return xmur3(str)();
  }

  /* Crea un RNG ricco di helper a partire da un seed (qualsiasi tipo). */
  function makeRng(seed) {
    const seedInt = hashSeed(seed);
    const next = mulberry32(seedInt);

    const api = {
      seed: seed,
      seedInt: seedInt,

      /* float in [0, 1) */
      float: next,

      /* float in [min, max) */
      range(min, max) {
        return min + next() * (max - min);
      },

      /* intero in [min, max] inclusi */
      int(min, max) {
        return Math.floor(min + next() * (max - min + 1));
      },

      /* true con probabilità p (default 0.5) */
      chance(p) {
        return next() < (p == null ? 0.5 : p);
      },

      /* elemento casuale di un array */
      pick(arr) {
        return arr[Math.floor(next() * arr.length)];
      },

      /* shuffle Fisher–Yates in place (deterministico) */
      shuffle(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
          const j = Math.floor(next() * (i + 1));
          const t = arr[i];
          arr[i] = arr[j];
          arr[j] = t;
        }
        return arr;
      },

      /* gaussiana standard (media 0, dev 1) via Box–Muller */
      gauss() {
        let u = 0;
        let v = 0;
        while (u === 0) u = next();
        while (v === 0) v = next();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      }
    };

    return api;
  }

  /* Genera un seed nuovo e leggibile (NON deterministico: usa l'orologio
     + Math.random SOLO qui, per creare un seed; tutto il resto è
     deterministico a partire da quel seed). Formato breve maiuscolo. */
  function newSeed() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // niente caratteri ambigui
    let s = '';
    for (let i = 0; i < 8; i++) {
      s += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return s;
  }

  root.ORION = root.ORION || {};
  root.ORION.rng = { makeRng, hashSeed, newSeed };
})(typeof window !== 'undefined' ? window : this);
