---
name: orion-new-module
description: Creare un nuovo modulo JS in Orion Empires con lo scaffolding canonico (IIFE su namespace ORION, ensure() lazy, registrazione in index.html, hook di boot e di tick, RNG deterministico per-seed). Usa quando aggiungi un sottosistema/feature nuovo (es. M18-M20), un file js/<modulo>.js, o devi ottenere un RNG deterministico con la convenzione seed:<scope>:<id>:<I>.
---

# Scaffolding di un nuovo modulo

Stack: Vanilla JS, **no** bundler/framework/CDN. Tutto vive sul namespace globale `ORION`,
i file sono caricati in ordine via `<script>` in `index.html`. Modello di riferimento per un
modulo piccolo e completo: `js/mekhari.js` (e `js/treasury.js`, `js/agreements.js`).

## 1. Boilerplate del file `js/<modulo>.js`
```js
/* =====================================================================
   ORION EMPIRES — <modulo>.js
   Modulo M<NN> (Fase <X>): <scope + decisioni #NN>.
   Determinismo (#5): zero Math.random. Recovery-friendly (#22).
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  /* Costanti/tarature in testa (niente magic number sparsi). */
  const FOO = 0.35;

  /* Lazy-init dello stato persistito (vedi skill orion-persist-field). */
  function ensure(game) {
    if (!game) return;
    if (!game.<modulo> || typeof game.<modulo> !== 'object') game.<modulo> = { /* default */ };
  }

  /* Helper privati (logica pura). */
  function helper(x) { return x; }

  /* API pubblica. */
  function publicFn(game, args) { ensure(game); /* ... */ }

  ORION.<modulo> = {
    FOO: FOO,
    ensure: ensure,
    publicFn: publicFn,
    _helper: helper   // interni esposti SOLO per i test headless
  };
})(typeof window !== 'undefined' ? window : this);
```
Note:
- `(typeof window !== 'undefined' ? window : this)` permette il `require()` da Node nei test.
- Niente `export`/`import` (vanilla). Niente accesso al DOM in moduli di pura logica
  (così girano headless in Node — vedi skill `orion-headless-test`).
- Convenzione: esporre gli helper interni con prefisso `_` con commento "interni per test".

## 2. Registrazione in `index.html`
Aggiungi `<script src="js/<modulo>.js"></script>` nel blocco script (`index.html:210-252`),
**rispettando le dipendenze**: `icons.js → rng.js → utils.js → core → sottosistemi → time.js →
save.js → tutorial.js → main.js`. I sottosistemi che usano altri moduli vanno **dopo** di essi
(es. `mekhari.js` dopo `treasury.js`/`diplomacy.js`). `main.js` è SEMPRE ultimo.

## 3. Hook di boot
Se il modulo ha stato persistito, chiama `ensure()` in `enterGame()` (`js/main.js:766-802`),
nell'ordine corretto (dopo le colonie home, dopo i moduli da cui dipende):
```js
if (ORION.<modulo> && ORION.<modulo>.ensure) ORION.<modulo>.ensure(ORION.game);
```

## 4. Hook di tick (se il modulo evolve nel tempo)
Nel game loop in `js/time.js`, chiama una funzione mutativa `process(game, events)` che fa
avanzare lo stato e accoda eventi cronaca (vedi skill `orion-chronicle-event`):
```js
if (root.ORION.<modulo> && root.ORION.<modulo>.process) {
  root.ORION.<modulo>.process(game, events);
}
```
Opzionale `minDuration(game)` per fermarsi alle deadline (prossimo evento critico).

## 5. RNG deterministico (convenzione seed)
**Zero `Math.random`** nella logica (solo `ORION.rng.newSeed()` usa il clock, una volta).
Crea un RNG per-contesto con `ORION.rng.makeRng(<stringa-seed>)`. Convenzione del seed:
`<base>:<scope>:<id>:<I>` dove:
- `<base>` = `game.seed` (locale) o `galaxy.seed` (galassia-wide) o `body.seed` (pianeta);
- `<scope>` = nome univoco e leggibile (es. `'currency'`, `'expedition'`, `'council'`);
- `<id>` = proprietà stabile dell'entità (`gp.id`, `exp.id`, `civ.id`) — **mai** un indice di array;
- `<I>` = aggiungi `timeImpulsi` SOLO per dati temporali (mood AI tick-by-tick), non per immutabili.

Esempi reali:
```js
const rng = ORION.rng.makeRng(game.seed + ':currency:' + gp.id);     // treasury.js:84
const rng = ORION.rng.makeRng(game.seed + ':expedition:' + exp.id);  // expedition.js
const grng = ORION.rng.makeRng(galaxy.seed + ':ai:' + I);            // ai.js (temporale)
```
API RNG (`js/rng.js`): `.float()` `.range(min,max)` `.int(min,max)` `.chance(p)` `.pick(arr)`
`.shuffle(arr)` `.gauss()`. Cachea i risultati costosi marcandoli col seed (`x._seed === game.seed`)
per invalidare al load (modello `currencies()` in `js/treasury.js`).

## 6. Persistenza
Se il modulo salva stato → segui la skill **`orion-persist-field`** (bump schema + serialize +
migrate + ensure + boot hook).

## Checklist
- [ ] file con IIFE + `ORION.<modulo>` + `ensure()` + helper `_` per test
- [ ] niente DOM/`Math.random` nella logica pura
- [ ] `<script>` in `index.html` nell'ordine di dipendenza corretto
- [ ] hook `ensure()` al boot (se ha stato)
- [ ] hook `process(game,events)` nel tick (se evolve)
- [ ] RNG con seed `base:scope:id[:I]`
- [ ] persistenza via skill orion-persist-field (se serve)
- [ ] aggiorna lo stato moduli in CLAUDE.md / docs se è un milestone (M18+)
