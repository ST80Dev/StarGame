---
name: orion-headless-test
description: Scrivere ed eseguire test headless in Node per un modulo di Orion Empires (codice browser vanilla JS), verificando logica, retrocompat del save e determinismo seed. Usa quando devi validare un modulo nuovo o modificato, controllare una migrazione di schema, o confermare che "stesso seed + stessa sequenza → stesso esito" (decisione #5) senza aprire il browser.
---

# Test headless di un modulo

Non c'è framework (no Jest/Mocha): il pattern del progetto è uno **script `node` ad-hoc** che
carica i moduli vanilla JS, costruisce un game state fittizio e fa asserzioni con `console.assert`.
Funziona perché i moduli di **pura logica** (treasury, agreements, factions, mekhari, combat,
research, save…) **non toccano il DOM**. I moduli con canvas/DOM (galaxy-map, *-view, main) NON
sono testabili così senza jsdom — testane solo la logica estraibile.

## Schema di una harness
Crea un file temporaneo (es. `/tmp/test-<modulo>.js`, **non versionato**):
```js
'use strict';
// 1) Emula il browser: i moduli fanno root = (window || this) e si attaccano a ORION
global.window = global;

// 2) Carica nell'ordine di dipendenza (come in index.html)
require('/home/user/StarGame/js/rng.js');
require('/home/user/StarGame/js/utils.js');
require('/home/user/StarGame/js/treasury.js');   // + i moduli da cui dipende
const ORION = global.ORION;

// 3) Costruisci un game state minimo (solo i campi che il modulo usa)
function makeGame(seed) {
  const game = {
    seed: seed || 'TEST-SEED',
    galaxy: { seed: seed || 'TEST-SEED', groups: [{ id: 'g1', name: 'Velo di Vega' }] },
    colonies: {},
  };
  ORION.treasury.ensure(game);
  return game;
}

// 4) Asserzioni
let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('FAIL:', msg); } }

const g = makeGame();
ok(typeof ORION.treasury.totalCredits(g) === 'number', 'totalCredits è numero');

// 5) Determinismo: stesso seed → stesso risultato
const a = ORION.treasury.currencies(makeGame('SEED-X'));
const b = ORION.treasury.currencies(makeGame('SEED-X'));
ok(JSON.stringify(a) === JSON.stringify(b), 'currencies deterministico per seed');

// 6) Report
console.log('Test headless: ' + pass + '/' + (pass + fail) + (fail ? ' (FALLITI: ' + fail + ')' : ''));
process.exit(fail ? 1 : 0);
```
Esegui con `node /tmp/test-<modulo>.js`.

## Test di retrocompat del save (schema migration)
Per ogni bump di schema (skill `orion-persist-field`), verifica che un payload vecchio migri:
```js
require('/home/user/StarGame/js/save.js');
const old = { schema: 31, seed: 'S', colonies: {} };       // payload pre-bump
const migrated = ORION.save.migrate
  ? ORION.save.migrate(old)
  : /* se migrate è interno, testalo via serialize/load roundtrip */ old;
ok(migrated.schema === ORION.save.SCHEMA_VERSION, 'migrate porta allo schema corrente');
ok(Array.isArray(migrated.myField), 'campo nuovo inizializzato di default');
```
Verifica anche il **roundtrip**: `serialize(game)` → `migrate(payload)` → ricostruzione, senza throw.

## Cosa testare sempre
- **Determinismo**: stessa operazione, stesso seed → output identico (anche dopo serialize/load).
- **Idempotenza di `ensure()`**: chiamarlo 2 volte non perde stato.
- **Retrocompat**: save a schema N-1, N-2 caricano con default sensati (mai fail-state, #22).
- **Guardie**: input invalidi (quantità ≤ 0, saldo insufficiente, entità mancante) ritornano
  `{ ok:false, reason }` invece di lanciare.
- **Confini numerici**: clamp ai min/max delle tarature.

## Convenzioni
- Esponi gli helper interni necessari ai test come `_nome` nell'oggetto `ORION.<modulo>`
  (con commento "interni esposti per test headless").
- Riporta sempre il conteggio `N/N` nel messaggio finale (come nello storico: `treasury 19/19`,
  `agreements 22/22`).
- Lo script è usa-e-getta: non committarlo, a meno che il team decida di versionare una suite.
