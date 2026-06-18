---
name: orion-persist-field
description: Aggiungere/persistere un nuovo campo di stato nel save di Orion Empires senza rompere la retrocompatibilità. Usa quando devi salvare nuovo stato di gioco, introdurre un modulo con stato persistito, fare un bump di schemaVersion, o scrivere una migrazione lazy in js/save.js. Copre i 5 passi obbligatori (SCHEMA_VERSION, serialize, migrate, ensure, boot hook) e le regole "mai distruttivo / additivo / idempotente".
---

# Persistere un campo nel save (bump schema)

Il save è **seed + delta** (decisione #5): la struttura immutabile (galassia, sistemi, pianeti)
si rigenera dal seed; nel save vivono solo i **delta** + `schemaVersion`. Ogni campo nuovo che
deve sopravvivere a un F5 segue la stessa procedura. **Mai distruttivo, sempre additivo e lazy.**

File centrale: `js/save.js`. Schema corrente: vedi `const SCHEMA_VERSION` (`js/save.js:58`).

## I 5 passi (in ordine)

### 1. Bump `SCHEMA_VERSION`
`js/save.js:58` — incrementa di 1:
```js
const SCHEMA_VERSION = 32; // era 31
```

### 2. Aggiungi il campo a `serialize()`
`js/save.js` `serialize(game)` (≈ righe 95-251). Sempre con type-guard e default lazy:
```js
// dentro l'oggetto restituito da serialize()
myField: Array.isArray(game.myField) ? game.myField : [],
// oppure per un oggetto:
myField: (game.myField && typeof game.myField === 'object') ? game.myField : { /* default */ },
```
Regola: **non** serializzare cache derivate dal seed (es. `game._currencies`, `research._poolSet`):
si ricalcolano al load.

### 3. Aggiungi la sub-migrazione in `migrate()`
`js/save.js` `migrate(payload)` (≈ righe 264-714). **In coda**, dopo l'ultimo blocco, copia il
pattern stereotipato (vedi l'ultimo blocco reale v30→v31 a `js/save.js:709`):
```js
/* v31 → v32 (#NN <modulo/fase>): <cosa aggiunge>. Save vecchi → default
   (nessun dato retroattivo). */
if ((payload.schema || 31) < 32) {
  if (!Array.isArray(payload.myField)) payload.myField = [];
  payload.schema = 32;
}
```
Se il campo vive **dentro** un'entità figlia (colonia/flotta/civ), itera lazy:
```js
if (payload.colonies && typeof payload.colonies === 'object') {
  Object.keys(payload.colonies).forEach(function (k) {
    const c = payload.colonies[k];
    if (!c) return;
    if (c.newField === undefined) c.newField = defaultValue;
  });
}
```

### 4. `ensure(game)` idempotente nel modulo
Ogni modulo con stato persistito espone un `ensure(game)` che fa lazy-init field-by-field
(idempotente: se lo stato esiste già è no-op). Modello reale: `js/treasury.js:61`.
```js
function ensure(game) {
  if (!game) return;
  if (!game.myField || typeof game.myField !== 'object') game.myField = { /* default */ };
  if (!Array.isArray(game.myField.items)) game.myField.items = []; // lazy per campi nuovi
}
// ...esporlo: ORION.<modulo> = { ..., ensure: ensure };
```

### 5. Chiama `ensure()` al boot
`js/main.js` (≈ righe 766-802), dentro `enterGame()`, dopo che `ORION.game` è popolato e
nell'ordine giusto (colonie home → AI → reputazione → ricerca → dispatch → …). Pattern:
```js
if (ORION.<modulo> && ORION.<modulo>.ensure) {
  ORION.<modulo>.ensure(ORION.game);
}
```

## Regole inderogabili
- **Mai distruttivo**: non cancellare/ritipizzare un campo senza migrazione di conversione esplicita
  (esempio storico complesso: expeditions[]→fleets[], `js/save.js` v18→v19).
- **Additivo + lazy**: i save vecchi devono caricare con un default sensato, mai un fail-state (#22).
- **Idempotente**: `ensure()` può essere chiamato N volte senza perdere stato.
- **Determinismo (#5)**: se `ensure()` genera dati, ancora l'RNG al seed (vedi skill `orion-new-module`),
  mai `Math.random`.
- Un solo numero per bump: `payload.schema = <nuovo>` chiude SEMPRE il blocco.

## Checklist finale
- [ ] `SCHEMA_VERSION` +1
- [ ] riga in `serialize()` con type-guard
- [ ] blocco `if ((payload.schema || N) < N+1) { … payload.schema = N+1; }`
- [ ] `ensure()` idempotente nel modulo + esposto
- [ ] chiamata `ensure()` al boot in `enterGame()`
- [ ] commento con #decisione/modulo accanto al blocco di migrazione
- [ ] test: carica un save vecchio (schema < nuovo) e verifica che migri senza errori

## Verifica rapida
`js/save.js:721` rifiuta payload con schema più recente del supportato. Un test headless
(skill `orion-headless-test`) che fa `serialize → migrate → load` con un payload a schema N-1
conferma la retrocompat.
