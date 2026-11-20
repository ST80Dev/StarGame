# CLAUDE.md — Orion Empires

> **Fonte di verità design:** `ORION_EMPIRES_GDD.md`
> **Standard grafici UI:** `UI_GUIDE.md` (consultazione obbligatoria prima di toccare CSS/HTML/widget)
> **Storico decisioni + stato moduli M01→M17 in dettaglio:** `docs/CLAUDE_FULL_ARCHIVE.md` (consulta solo se serve dettaglio storico — non caricarlo di default)

---

## Identità

- **Titolo:** Orion Empires — 4X spaziale strategico testuale, a pannelli (non action, non libro-game).
- **Stack (attuale):** Vanilla JS + HTML + CSS, namespace globale `ORION`, nessun build step. **In transizione** verso lo stack della Revisione 2026 (vedi sotto).
- **Piattaforma:** browser / GitHub Pages, **desktop + tablet** (decisione Revisione 2026: il telefono non è più un target).
- **Salvataggio:** `localStorage` (5 slot + autosave) + Export/Import `.json`. Schema corrente: **32** (verrà azzerato dalla Revisione 2026).
- **Utenza:** un solo giocatore (il proprietario). Niente obblighi di "sempre giocabile" verso terzi.

---

## Principi non negoziabili

1. **Determinismo (#5):** zero `Math.random`. Tutti gli RNG derivano dal seed (`seed:<scope>:<id>:<I>`). Stesso seed + stessa sequenza di comandi → stesso esito. Replay-safe.
2. **Recovery-friendly (#22):** mai fail-state a freddo. Le scelte temporanee non devono essere perennemente punitive. Sempre una via d'uscita (evacua, richiama, tribute, refund 50%).
3. **Seed + delta (#5):** la struttura immutabile (galassia, sistemi, pianeti) si rigenera dal seed; nel save vivono solo i delta + `schemaVersion`.
3b. **Simulazione pura:** la logica di gioco non dipende da librerie di presentazione (render/UI). Le librerie leggono lo stato e lo mostrano, mai lo modificano.
4. **Lessico SW-flavor (#34):** classi navi/iperguida/regioni/archetipi fazione/ranghi — sì. Marchi specifici (Jedi/Sith/Tatooine/Force) — no. Nomi propri sempre procedurali.
5. **Sviluppo modulo per modulo:** confermare prima di passare al successivo. M01-M17 ✅ mergiati in main. M18-M20 ⬜.

---

## Revisione 2026 (decisioni utente, 2026-11-20)

Rifacimento incrementale (non riscrittura da zero) dell'intero gioco, focus anche su grafica/prestazioni.

- **Pacchetti esterni ammessi** se portano un salto di qualità (grafica, prestazioni, manutenibilità), **bundlati** nel build: nessuna chiamata esterna a runtime, nessun CDN. Candidati: Vite (build), TypeScript graduale, Vitest, PixiJS v8 (mappe WebGL), Preact (UI pannelli).
- **Build step ammesso:** sviluppo con `npm run dev`, deploy su Pages via GitHub Action (`dist/`). Il gioco si usa solo da Pages.
- **Save:** si riparte da zero con uno schema pulito. La catena di migrazioni legacy (≤32) e la regola "mai distruttivo" verso save vecchi decadono al momento del reset.
- **Telefono escluso:** il layout ≤760px (bottom nav, sheet mobile, decisione #63) è rimovibile. Target: desktop + tablet.
- **Gameplay congelato durante il refactor:** nessun cambio di regole; ogni fetta verificata con test golden replay (stesso seed + comandi → stesso esito).
- Fasi: 0 audit (`docs/AUDIT_2026.md`) → 1 fondamenta (Vite + Vitest + golden replay) → 2 scomposizione `main.js` → 3 pilota PixiJS mappa galattica → 4 migrazione pannelli.

Dove questa sezione contraddice regole più sotto o in `UI_GUIDE.md`, vince questa sezione.

---

## Regole di lavoro

### R1 — Branch & PR

Prima di scrivere codice, **verifica sempre** lo stato del branch corrente e della sua PR:

- **PR aperta non mergiata** → continua a committare sullo stesso branch (i push aggiornano la PR esistente). Anche fix/polish restano lì. Niente moltiplicazione di branch durante la review.
- **PR mergiata** → apri un branch nuovo da `main` aggiornato (`claude/<slug>` come da istruzioni di sessione).

Eccezione: scope completamente diverso richiesto dall'utente → branch separato, dichiarando che sarà PR distinta.

Verifica pratica:
```
git branch --show-current
git fetch origin main && git log origin/main..HEAD --oneline   # vuoto = già in main
# + stato PR via mcp__github__list_pull_requests / pull_request_read
```

### R2 — UI

Prima di qualunque modifica a CSS, HTML strutturale o nuovi widget: leggi `UI_GUIDE.md`. Stessa autorevolezza di R1. In caso di conflitto tra UI_GUIDE e CLAUDE su temi UI, **vince UI_GUIDE**.

---

## Convenzioni codice

- **Namespace globale `ORION`**, moduli caricati in ordine via `<script>` in `index.html`. Niente bundler.
- **Render Canvas on-demand** (no rAF loop continuo): `ResizeObserver` + `devicePixelRatio` (cap 2.5).
- **Input unificato Pointer Events** (mouse + touch). Niente funzioni `hover`-only.
- **Persistenza preferenze UI** in `localStorage['orion.uiprefs']`/`orion.prefs` — **mai nel save di partita** (UI_GUIDE §9).
- **Schema save:** ogni bump aggiunge una sub-migrazione lazy in `js/save.js → migrate()`, **mai distruttiva**. Campi nuovi sempre additivi/lazy-init dove possibile (no bump).
- **Eventi cronaca:** kind con etichetta in `KIND_LABELS` + scelta auto-pausa in `DEFAULT_AUTOPAUSE` (decisione #31).
- **Tutorial (#29):** aggiungere voci a `ORION.tutorial.LESSONS` + `fire(id)`/`openLesson(id)` ai punti rilevanti. Niente walkthrough — concetti, non istruzioni cliccabili.
- **Utility condivise:** `ORION.util` (clamp/lerp/smoothstep/escapeHtml) + `ORION.format` in `js/utils.js`. Non duplicare.

---

## Comandi utili

- Nessun build step (Vanilla JS puro). Apri `index.html` per testare.
- Test headless: script `node` ad-hoc per modulo. Pattern già esistenti nei moduli (vedi archivio per esempi).
- Lint/format: nessun tool obbligatorio.

---

## Stato moduli (sintesi)

✅ M01-M17 mergiati in main (schema 32). 🔶 M18 Reputazione/ICG (in conclusione, consegna a fette: reputazione + ICG + bridge figure già in main) · 🔶 M19 Spionaggio (Fase A+B: modulo `js/espionage.js` — "Operazione coperta" legata alla presenza flotta, Infiltrazione + Sabotaggio + Furto, esito deterministico, effetti via façade M18 `reputation.applyAndRecord`, bottino furto nel cluster via treasury · Intel grigia Mekhari §6e in `js/mekhari.js`: canale remoto a pagamento, dossier cap "parziale" · Infiltrazione svela il preavviso reale di tradimento via `diplomacy.betrayalOutlook` §11 + lezione tutorial `espionage`. Manca: controspionaggio/bidirezionalità) · ⬜ M20 Polish/bilanciamento/UI vittoria/calibrazione soglie. Per dettagli, fasi, decisioni numerate (#1..#91) e parametri: `docs/CLAUDE_FULL_ARCHIVE.md`.

---

## Riferimenti

- Decisioni numerate + stati moduli dettagliati: `docs/CLAUDE_FULL_ARCHIVE.md`
- Design del gioco: `ORION_EMPIRES_GDD.md`
- UI: `UI_GUIDE.md`
- Modalità di gioco e vittoria: `MODALITA_GIOCO.md`
