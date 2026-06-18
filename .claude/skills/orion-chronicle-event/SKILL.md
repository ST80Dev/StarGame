---
name: orion-chronicle-event
description: Aggiungere un nuovo tipo di evento Cronaca (log) in Orion Empires, mantenendo sincronizzati i 4 punti coinvolti (emissione events.push, KIND_LABELS, DEFAULT_AUTOPAUSE, branch in chronicleEvent) e la categoria Galassia/Colonie. Usa quando un modulo deve segnalare al giocatore un evento, scegliere se auto-pausare il tempo, o quando vedi un 'kind' senza etichetta/branch.
---

# Aggiungere un evento Cronaca

La cronaca è il log a 2 sezioni (**Galassia** / **Colonie**) nella sidebar. Un evento è un
oggetto con un `kind` stabile. Ogni nuovo `kind` tocca **4 punti** che devono restare allineati:
emissione → etichetta → auto-pausa → rendering. Dimenticarne uno è il bug tipico.

## 1. Emetti l'evento
Nel modulo (tipicamente nel tick di `js/time.js`, o in un handler) accoda all'array `events`:
```js
events.push({
  kind: 'war-declared',          // id stabile, kebab-case, prefisso per categoria (vedi §5)
  attacker: civName,
  defender: civName2,
  colony: colony,                // opzionale: per tag/posizione
  planet: planet,                // opzionale
  impulso: game.timeImpulsi      // timestamp
});
```

## 2. Etichetta UI → `KIND_LABELS`
`js/main.js` `KIND_LABELS` (≈ riga 10857). Aggiungi la voce leggibile (usata in cronaca e
nell'overlay di auto-pausa):
```js
'war-declared': 'Guerra dichiarata',
```

## 3. Scelta auto-pausa → `DEFAULT_AUTOPAUSE`
`js/main.js` `DEFAULT_AUTOPAUSE` (≈ riga 10421). `true` = evento notevole che ferma il tempo,
`false` = atmosferico/informativo (decisione #31). Decidi col criterio: *richiede un'azione o
una decisione del giocatore?* → `true`; *è cronaca di colore?* → `false`.
```js
'war-declared': true,
```

## 4. Rendering → branch in `chronicleEvent(ev)`
`js/main.js` `chronicleEvent(ev)` (≈ riga 11089). È una catena `if/else if` su `ev.kind`: ogni
branch formatta l'HTML e chiama `pushChronicle(html, modifier, category)`:
```js
} else if (ev.kind === 'war-declared') {
  pushChronicle(ds + ' — Guerra: <strong>' + escapeHtml(ev.attacker) + '</strong> dichiara guerra a <strong>' +
    escapeHtml(ev.defender) + '</strong>.', 'galaxy', 'galaxy');
```
dove `ds = ORION.time.format(ev.impulso)`. Per i nomi pianeta usa `ev.planet.name` + il tag
regione `bodyTagHtml(sysId)` come negli altri branch.

## 5. Categoria Galassia vs Colonie
La categoria è derivata dal **prefisso del `kind`** in `chronicleCategoryFromKind()` (`js/main.js:153`):
- → **Galassia**: prefissi `civ-`, `diplo-`, `pirate-`, `fleet-`, `station-`, `siege-`,
  `expedition-`, `trade-`, `agreement-`, `raider-`, `cohesion-`, `dispatch-` (+ alcuni id espliciti).
- → **Colonie** (default): tutto il resto (carestie, waste, pop, milestone capitali, ricerca…).

**Scegli il prefisso del `kind` coerente con la categoria desiderata.** Se serve un prefisso
nuovo da mappare su Galassia, aggiungilo all'elenco in `chronicleCategoryFromKind()`. Il terzo
argomento di `pushChronicle(html, modifier, category)` può forzare la categoria esplicitamente
(`'galaxy'`/`'colony'`); se omesso viene derivato dal `modifier`.

## 6. Filtro rumore (opzionale)
Gli eventi di routine vengono scartati dalla cronaca via `isChronicleNoise(ev)` /
`CHRONICLE_NOISE_KINDS` (`js/main.js:144`). Se il tuo evento è ad alta frequenza e NON deve
comparire in sidebar (vive solo nei pannelli dedicati), aggiungi il suo `kind` a quel set.

## 7. Trigger tutorial (opzionale)
Dentro il branch di `chronicleEvent`, alla prima occorrenza di un concetto nuovo:
```js
if (ORION.tutorial) ORION.tutorial.fire('war-concept');
```
(vedi skill `orion-tutorial-lesson`).

## Checklist
- [ ] `events.push({ kind, …, impulso })` nel punto di codice corretto
- [ ] voce in `KIND_LABELS`
- [ ] voce in `DEFAULT_AUTOPAUSE` (true/false motivata)
- [ ] branch in `chronicleEvent()` con `pushChronicle(...)`
- [ ] prefisso `kind` coerente con la categoria (Galassia/Colonie)
- [ ] eventuale rumore in `CHRONICLE_NOISE_KINDS`
- [ ] eventuale `ORION.tutorial.fire(...)`
- [ ] persistenza: la cronaca è già nel save (`game.chronicle[]`), non serve bump schema per i `kind`
