---
name: orion-tutorial-lesson
description: Aggiungere una lezione al tutorial di Orion Empires (decisione #29) e agganciarla al punto rilevante con fire(id). Usa quando introduci una sigla, un'icona, un concetto o un meccanismo nuovi che il giocatore deve capire — il tutorial spiega concetti, non walkthrough cliccabili. Ogni nuova sigla/concetto UI deve avere la sua voce in ORION.tutorial.LESSONS.
---

# Aggiungere una lezione tutorial

Il tutorial (decisione #29, UI_GUIDE §0.9) spiega **concetti**, non istruzioni passo-passo.
Le lezioni vivono in `ORION.tutorial.LESSONS` (`js/tutorial.js:37`) e si attivano **una sola
volta** alla prima occorrenza del concetto, via `fire(id)`. Una lezione già vista non riappare
in quella partita; resta riapribile manualmente dalla "?" in HUD.

## 1. Aggiungi la voce in `LESSONS`
`js/tutorial.js:37` (array `LESSONS`). Formato di una voce (vedi `welcome`, `mobile-nav` come modelli):
```js
{
  id: 'war-concept',                 // id univoco e stabile (lo usa fire())
  tag: 'Diplomazia',                 // categoria breve (sezione/modulo). Coerente con UI_GUIDE
  title: 'Dichiarare guerra',        // titolo in 1 riga
  body:
    '<p>Cosa è il concetto in 1-2 frasi, con i termini <strong>chiave</strong> in grassetto.</p>' +
    '<p>Come funziona / cosa cambia per il giocatore (3-5 righe totali, prosa).</p>' +
    '<p class="tut-hint">Hint pratico opzionale: dove guardare, quale bottone.</p>'
},
```
Linee guida sul contenuto:
- **Prosa**, parola piena (no sigle senza spiegazione). HTML ammesso: `<p>`, `<strong>`, `<em>`,
  `<span class="ds-unit">` per le sigle del Faro (Ω·Φ·Κ·Ι), `<kbd>` per tasti, `class="tut-hint"`.
- Breve: 4-6 righe. Spiega il *perché/cosa*, non una sequenza di click.
- `id` univoco (collisione = la seconda voce è ignorata). `tag` allineato alla tinta/sezione UI.

## 2. Aggancia il trigger con `fire(id)`
`fire(id)` (`js/tutorial.js:1268`): mostra la lezione se il tutorial è abilitato, non è già vista,
e non c'è un altro popup aperto (altrimenti resta non-vista e riscatta più tardi). Chiamalo nel
punto dove il concetto diventa **rilevante per la prima volta**:

- **Evento cronaca** → dentro il branch in `chronicleEvent()` (`js/main.js`), come gli esistenti:
  ```js
  if (ORION.tutorial) ORION.tutorial.fire('war-concept');
  ```
  (esempi reali: `fire('scarcity')`, `fire('waste')` nei rispettivi branch).
- **Azione utente** → nell'handler del bottone/overlay (es. apertura di una vista nuova).
- **Primo uso di una struttura/figura** → nel branch `build-done`/specifico, condizionato all'id.

Regola: `fire()` SOLO in risposta a un evento/azione notevole, mai in loop di rendering.

## 3. Cosa NON serve fare
La persistenza ("vista"), l'indice delle lezioni, il pulsante "?" e la riapertura manuale
(`openLesson(id)`, `js/tutorial.js:1448`) sono gestiti dal framework. Lo stato `game.tutorial =
{ enabled, seenLessons[] }` è già nel save (schema ≥ 4): **nessun bump schema** per una lezione nuova.

## Checklist
- [ ] voce `{ id, tag, title, body }` in `LESSONS` (id univoco, body breve in prosa)
- [ ] `ORION.tutorial.fire('<id>')` al punto di prima rilevanza (evento/azione)
- [ ] `tag`/tinta coerenti con UI_GUIDE per il concetto
- [ ] niente bump schema (gestito dal framework)
- [ ] se il concetto è una sigla/icona UI nuova → la lezione è **obbligatoria** (UI_GUIDE §0.9)
