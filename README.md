# Orion Empires

**4X spaziale strategico** a pannelli (eXplore · eXpand · eXploit · eXterminate), giocabile nel browser.
Interfaccia testuale/HUD in stile *Master of Orion* — niente action, niente libro-game.

- **Stack:** Vanilla JS, HTML, CSS — nessun framework, nessun CDN, nessuna chiamata a server esterni
- **Piattaforma:** browser / GitHub Pages
- **Salvataggio:** `localStorage` (slot multipli)

## Stato

In sviluppo **modulo per modulo**. Lo stato corrente è tracciato in [`CLAUDE.md`](./CLAUDE.md).
Il design completo è in [`ORION_EMPIRES_GDD.md`](./ORION_EMPIRES_GDD.md) (fonte di verità).

Modulo corrente: **M02 — Galassia** (generazione procedurale deterministica dal seed, nomi dei sistemi, mappa a nodi su Canvas 2D responsivo). M01 (shell, tema, layout) completato.

## Eseguire in locale

```bash
npm install
npm run dev      # server locale con reload
npm test         # Vitest: golden replay + test di simulazione
npm run build    # bundle in dist/ (deploy automatico su Pages via GitHub Action)
```

## Struttura

```
index.html            shell UI (un solo entry module)
src/entry.js          importa i moduli js/* in ordine
js/newgame.js         creazione partita headless (seed → stato)
tests/                Vitest: golden replay, simulazione, test storici
css/style.css         tema scuro spaziale (custom properties)
js/rng.js             PRNG deterministico (seed → galassia riproducibile)
js/names.js           nomi dei sistemi (40% reali / 60% inventati)
js/galaxy.js          generazione procedurale galassia + stato (seed+delta)
js/galaxy-map.js      mappa a nodi su Canvas 2D (responsivo, Pointer Events)
js/main.js            bootstrap + integrazione moduli
CLAUDE.md             stato di sviluppo
ORION_EMPIRES_GDD.md  game design document
```
