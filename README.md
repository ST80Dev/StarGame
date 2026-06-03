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

Nessuna build. Apri `index.html` in un browser, oppure servi la cartella:

```bash
python3 -m http.server 8000
# poi apri http://localhost:8000
```

## Struttura

```
index.html            shell UI + caricamento moduli
css/style.css         tema scuro spaziale (custom properties)
js/rng.js             PRNG deterministico (seed → galassia riproducibile)
js/names.js           nomi dei sistemi (40% reali / 60% inventati)
js/galaxy.js          generazione procedurale galassia + stato (seed+delta)
js/galaxy-map.js      mappa a nodi su Canvas 2D (responsivo, Pointer Events)
js/main.js            bootstrap + integrazione moduli
CLAUDE.md             stato di sviluppo
ORION_EMPIRES_GDD.md  game design document
```
