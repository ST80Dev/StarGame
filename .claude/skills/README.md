# Skill di sviluppo — Orion Empires

Procedure riutilizzabili per i task ricorrenti del progetto. Ogni skill è una `SKILL.md`
documentale (zero modifiche al codice di gioco): checklist + snippet reali + ancore `file:line`.
Invocabili come `/<nome>` o consultabili a mano. Tutte rispettano i principi non negoziabili di
`CLAUDE.md` (determinismo seed+delta #5, recovery-friendly #22, no framework/CDN/WebGL) e, per la
UI, `UI_GUIDE.md` (R2).

## Motore / stato
- **`orion-new-module`** — scaffolding di un modulo nuovo (IIFE `ORION`, `ensure()`, registrazione
  in `index.html`, hook boot/tick, RNG deterministico `seed:<scope>:<id>:<I>`).
- **`orion-persist-field`** — persistere un campo nel save: bump `SCHEMA_VERSION`, `serialize()`,
  sub-migrazione lazy in `migrate()`, `ensure()` idempotente, hook al boot. Mai distruttivo.
- **`orion-headless-test`** — test `node` ad-hoc per moduli vanilla JS: logica, retrocompat schema,
  determinismo.

## Eventi / feedback al giocatore
- **`orion-chronicle-event`** — nuovo tipo di evento Cronaca: `events.push`, `KIND_LABELS`,
  `DEFAULT_AUTOPAUSE`, branch in `chronicleEvent()`, categoria Galassia/Colonie.
- **`orion-tutorial-lesson`** — nuova lezione tutorial (#29): voce in `ORION.tutorial.LESSONS` +
  aggancio `fire(id)`.

## Grafica / UI (leggere prima UI_GUIDE.md)
- **`orion-ui-overlay`** — modale/overlay full-screen canonico (host `data-bind`, scrim+blur,
  chiusura scrim/X/Esc, stato volatile fuori dal save).
- **`orion-canvas-renderer`** — renderer Canvas 2D on-demand (ResizeObserver, DPR cap 2.5, Pointer
  Events unificati, pinch, hit-testing, backdrop deterministico).
- **`orion-ui-icon`** — icona SVG nel catalogo `js/icons.js` (`ORION.icon`/`uiIcon`), tinta tematica
  + glow (UI_GUIDE §3).
- **`orion-ui-section`** — widget ricorrenti: header sezione, item card, badge di stato, chip, viste
  del viewport (riuso classi canoniche, UI_GUIDE §6/§7).

## Convenzioni
- I numeri di riga negli ancoraggi sono indicativi (il codice evolve): affianca sempre al numero il
  **nome del simbolo** per ritrovarlo (es. `chronicleEvent()` in `js/main.js`).
- Le skill documentano i pattern **esistenti**. Refactor più invasivi (es. base-class condivisa per
  i renderer, factory unica per gli overlay) sono proposte separate, da concordare prima.
