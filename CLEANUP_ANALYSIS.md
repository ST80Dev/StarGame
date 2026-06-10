# Analisi pulizia codice — ridondanze e codice obsoleto

> Sessione 2026-06-10, branch `claude/code-cleanup-redundancy-pmo40g`.
> Analisi su HEAD = merge PR #135/#153 (schema save 21, ~31.700 righe JS + 6.783 CSS).
> Metodo: 4 passate parallele (export moduli · main.js · CSS/HTML · duplicazioni cross-file),
> poi **ri-verifica manuale di ogni finding** con grep word-boundary (molti claim della prima
> passata erano falsi positivi dovuti agli alias locali tipo `const T = ORION.treasury`).
> Cross-check sistematico con i ganci futuri documentati in CLAUDE.md (M13–M20): lo
> scaffolding intenzionale NON è proposto in rimozione.

---

> **STATO: Fase 1 ESEGUITA** (commit su questo branch). Scostamenti rispetto al piano:
> - `planet.startSettling` **TENUTO**: in fase di rimozione è emerso il commento esplicito
>   "Lasciato come API pubblica per coerenza con future estensioni" (Insediamento sul secondo
>   corpo colonizzato) → è scaffolding intenzionale, rientra nella regola "ciò che è costruito
>   per sviluppi futuri resta".
> - `governor.setEnabled` rimosso **in cascata**: i suoi unici call-site erano i due blocchi
>   `gov-toggle` morti; senza di essi era a sua volta irraggiungibile (il percorso vivo è
>   `setLevel`, decisione #59).
> - Rimosso anche il blocco CSS `.gov-toggle` (classe mai generata, emersa nello scan finale).
> Verifica: `node --check` su tutti i file toccati + smoke headless (35 moduli caricati in
> ordine index.html, partita generata, build maturata, advance 200 Ι con 9 eventi,
> `governor.setLevel` OK, serialize schema 21 + migrate OK, determinismo galassia PASS).

## A. Codice morto VERIFICATO — rimozione sicura (confidenza alta)

Ogni voce: 0 usi esterni + 0 usi interni oltre a definizione/export. Verificato a mano.

### JavaScript (~60 righe)

| # | File | Simbolo | Riga | Note |
|---|------|---------|------|------|
| 1 | `js/main.js` | `popLevelLabel()` | 921 | Sostituito da `popRangeLevel` (refactor "livelli" #66) |
| 2 | `js/main.js` | `kU()`, `phU()`, `omU()` | 2990-2992 | Helper sigle calendario mai usati (solo `iU()` è vivo) |
| 3 | `js/main.js` | 2 blocchi handler `[data-action="gov-toggle"]` | ~2177-2186, ~8545-8556 | Il checkbox non viene **mai più renderizzato** (commento esplicito "il vecchio checkbox toggle non c'è più") → entrambi i listener sono no-op permanenti |
| 4 | `js/governor.js` | `toggle()` + export | 158, 462 | Sostituito da `setLevel`/`setEnabled` (decisione #59 Tier 2) |
| 5 | `js/ai.js` | `ownerMap()` + export | 336, 1535 | Superseded da `civForSystem`/`civForPlanet` |
| 6 | `js/ai.js` | `relationStatus()` + export | 1475, 1559 | Superseded da `ORION.diplomacy.effectiveRelation`/`relationLabel` (M11 #51). Coerente con CSS orfano `.civ-rel--*` (vedi sotto) |
| 7 | `js/structures.js` | `byCategory()` + export | 307, 357 | Mai usato (main.js itera CATEGORIES direttamente) |
| 8 | `js/structures.js` | `levelScale()` + export | 329, 359 | Alias 1-riga di `moduleSum`, mai chiamato |
| 9 | `js/planet.js` | `theoreticalOutput()` + export | 549, 861 | Scheda di valutazione M04 superata dalle card candidati M06.5 (`habitableSlot` scoring in galaxy.js) |
| 10 | `js/planet.js` | `startSettling()` + export | 417, 859 | Il settling parte da `colonizeHome(colony, planet, startDS, opts)`; questa API non è chiamata da nessuno |
| 11 | `js/time.js` | `currentDSFull()` + export | 254, 2124 | Variante "estesa" del formatter mai consumata (UI usa `currentDS` compatta) |
| 12 | `js/icons.js` | `ICONS.NAMES` | 372 | Array dei nomi calcolato all'avvio, mai letto |
| 13 | `js/factions.js` | `isFaction()` + export | 93, 202 | Mai usato (i consumer testano `civ.faction` direttamente) |

### CSS (~58 righe, confidenza alta — zero occorrenze del nome base in js/ e index.html)

| # | Selettore | Righe | Origine |
|---|-----------|-------|---------|
| 1 | `.seed-chip` + `__label`/`__value` | 419-449 | Badge seed rimosso dalla decisione #44-polish (commento CSS lo documenta) |
| 2 | `.nav-list` | 323 | Contenitore legacy mai istanziato (`.nav-item` è vivo) |
| 3 | `.council`, `__member`, `__role`, `__status` | 354-365 | Pannello "Consiglio" M01 mai implementato, superato dal refactor #50 |
| 4 | `.panel__header--inline` | 297 | Variante mai generata (`--dx` è quella viva) |
| 5 | `.time-control__title`, `.time-steps`, `.time-control__unit` | 1465-1479 | Layout controlli tempo pre-#31 (i 4 step rapidi rimossi) |
| 6 | `.civ-rel` + 6 modificatori `--war/--hostile/…` | 6329-6338 | Chip relazione M10 Fase C, superate dal chip diplomazia `.dip-relchip` (M11). Da rimuovere insieme a `ai.relationStatus` (voce A.6) |

**Totale Fase 1: ~120 righe rimosse, zero impatto funzionale, zero impatto sui save.**

### Falsi positivi notevoli (verificati e NON morti — non toccare)

`trade.js`/`treasury.js`/`agreements.js`/`mekhari.js`/`combat.js`/`diplomacy.js`/`federations.js`
risultavano "morti" alla prima passata ma sono **pienamente cablati** via alias locali in
`time.js`/`main.js`. Idem `moduleSum`, `slotFootprint`, `peopleAt`, `formatPeople`, `bonusOf`,
`canBuildShip`, `dossier`, `isCohesive`, ecc. Tutte le costanti `I_PER_*`, `CLASS_BIAS`,
`REAL`/`THEMES`/`GALAXY_NAMES` sono usate internamente ai rispettivi moduli.

---

## B. Gap funzionale scoperto (NON rimuovere — decidere se cablare)

**`cohesion.applyAttackPenalty(game, sysId, attackedCivId)`** (`js/cohesion.js:286`) è
documentata nella decisione #54 come effetto attivo della coesione («Attacco: −15 alle ALTRE
coese del sistema, solidarietà locale») ma **non è mai chiamata da nessun consumer** — a
differenza delle sorelle `applyTravelPenalty` e `applyColonizePenalty`, regolarmente cablate
in main.js. È un *wiring mancante*, non codice morto. Due opzioni:

1. **Cablarla** in `time.js → processSkirmishes` quando il giocatore vince/ingaggia in un
   sistema coeso (fedele alla decisione #54) — ~5 righe.
2. Declassarla esplicitamente a gancio futuro con commento, aggiornando CLAUDE.md #54.

---

## C. Legacy "da decidere" (rimozione consigliata, serve conferma)

**`_legacyFleetOrdersOverlay`** (`js/main.js:5987-6224`, **~238 righe**): il vecchio overlay
ordini flotta "muro di 7 sezioni", tenuto come fallback attivabile da console con
`ORION._useLegacyOrdersOverlay = true`. Il Fleet Wizard che lo sostituisce è consolidato da
più PR (wizard + picker da mappa #61 + popup info). Proposta: **rimuoverlo** insieme alle
regole CSS usate solo da lui (le classi `.fleet-order-block*`, `.fleet-route-*` vanno
verificate una a una: alcune sono condivise col wizard). Recupero netto stimato ~250 righe.
Se si preferisce prudenza, tenerlo un altro ciclo e rimuoverlo in M13.

---

## D. Scaffolding intenzionale confermato — DA TENERE (censimento)

Verificato che esiste, che non è usato oggi, e che è documentato come gancio:

- `requires: ['tech:*']` in structures.js + `tech:iperguida` in trade.js → **M13**
- `fleetUpkeep` stub in fleet.js → **M13** logistica
- `ALIGNMENT_IMPACT` + `registerAction` + `ensureEventSchedule` in victory.js → **M17/M19/M20**
- `eventSchedule[]` nel payload save → **M17**
- campo `thumb` opzionale nel formato slot save → **M20**
- `embarkPop`/`disembarkPop` (fleet.js) → API pronte, UI completata in #66-P0; restano API pubbliche
- `materialize`/`demobilize` (ai.js) → consumate da M09/M10-D
- Tier 3 Governatore, Logista cargo, Bacino orbitale, ecc. → ganci documentati senza codice
- Export di helper interni (es. `splitFaro`, `nextSeqId`, `ensureScarcity`, `parsePlanetKey`,
  `computeVisiblePath`, `buildChainedRoute`, `canLaunch`, …): usati internamente e/o esposti
  per i test headless di sessione → **tenere** (vedi proposta E.5)

---

## E. Standardizzazione proposta (senza perdita di efficienza/funzionalità)

### E.1 Utility condivise → nuovo `js/utils.js` (`ORION.util`), caricato dopo `rng.js`
- `clamp` definita **5 volte identica** (expedition, galaxy-map, planet-view, system-view, planet)
- `lerp` definita 3 volte; `smoothstep` (galaxy-map) ≡ `smooth` (planet-view) stesso algoritmo
- `escapeHtml` definita **3 volte identica** (main, colony-deck, empire-deck)

Consolidamento meccanico: definizione unica + alias locale `const clamp = ORION.util.clamp;`
nei moduli (zero cambio di logica, zero rischio determinismo).

### E.2 Formattatori numerici → `ORION.format`
Oggi convivono 4 varianti divergenti: `formatPeople` (planet.js, separatori italiani),
`fmtNum` (colony-deck), `fmtStock` e `fmtNet`/`fmtAbs` (main.js). Proposta: namespace unico
`ORION.format` con `population(n)` / `stock(v)` / `rate(v)` — un solo posto dove cambiare
localizzazione/precisione. I call-site si aggiornano meccanicamente.

### E.3 `hashStr` ×2 divergenti — solo rinomina
`galaxy-map.js` (hash→intero per offset marker) e `planet-overlay.js` (hash→generatore float,
volutamente indipendente da rng.js). Sono **legittimamente diverse**: rinominare la seconda
(es. `hashRng`) per evitare confusioni future. Nessun consolidamento forzato.

### E.4 Naming colonia in main.js
`colonyName_` (solo nome sistema), `colonyName` (copia in closure di `openFleetCreateOverlay`),
`colonyNameFromKey` (nome pianeta + HTML). Consolidare su 2 API chiare
(`systemNameFromKey` + `colonyNameFromKey`) eliminando la copia in closure.

### E.5 Convenzione export "per test"
Molti moduli esportano helper interni consumati solo dai test headless di sessione (non
committati nel repo). Proposta a costo zero: nel blocco export di ogni modulo, separare con
un commento `/* — interni esposti per test headless — */` l'API consumata dal gioco dagli
helper di test. Evita che future analisi (o future sessioni) li scambino per codice morto.

### E.6 Cosa NON fare (anti-goal espliciti)
- Nessun bundler/build step (vincolo §2 GDD), nessuna conversione a ES module.
- Nessuna rimozione degli export usati internamente: il pattern attuale è sano.
- Nessun refactor dei moduli grandi (time.js/main.js) "per estetica": il rischio di regressione
  sul determinismo (#5) supera il beneficio. La pulizia si limita a morto verificato + utility.

### Già sano (nessuna azione)
BFS centralizzato in `fleet.computePath` (trade/ai lo consumano, zero duplicati) ·
`REF_PRICE` singola fonte in treasury.js · RNG centrale in rng.js (la copia in planet-overlay
è indipendenza voluta e commentata) · `enrichmentForXp` vs `rankForXp` separate per dominio ·
tutti i 23 `data-bind` di index.html vivi · tutti gli script tag validi · nessun handler
`data-action` orfano.

---

## Piano d'azione proposto (3 fasi, 1 PR a commit separati o 3 PR piccole)

| Fase | Contenuto | Righe | Rischio |
|------|-----------|-------|---------|
| **1** | Rimozione codice morto verificato (sezione A: 13 voci JS + 6 blocchi CSS) | ~−120 | Zero (verificato simbolo per simbolo) |
| **2** | `js/utils.js` + `ORION.format` + rinomina `hashRng` + naming colonia (sezione E.1-E.4) | ~−40 nette | Basso (sostituzioni meccaniche, smoke test) |
| **3** | Decisioni: rimozione `_legacyFleetOrdersOverlay` (~−250) + wiring o declassamento di `applyAttackPenalty` (sezione B/C) | ~−250 | Basso, ma richiede conferma esplicita |

Verifica per ogni fase: avvio gioco da zero (nuova partita) + load di un autosave esistente +
replay smoke (advance ~200 Ι, build, colonize, flotta, rotta commerciale) — nessun bump di
schema in nessuna fase.
