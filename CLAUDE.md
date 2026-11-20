# CLAUDE.md — Orion Empires

> **Fonte di verità design:** `ORION_EMPIRES_GDD.md`
> **Standard grafici UI:** `UI_GUIDE.md` (consultazione obbligatoria prima di toccare CSS/HTML/widget)
> **Storico decisioni + stato moduli M01→M17 in dettaglio:** `docs/CLAUDE_FULL_ARCHIVE.md` (consulta solo se serve dettaglio storico — non caricarlo di default)

---

## Identità

- **Titolo:** Orion Empires — 4X spaziale strategico testuale, a pannelli (non action, non libro-game).
- **Stack (attuale):** Vanilla JS + HTML + CSS su namespace globale `ORION`, bundlato con **Vite** (Fase 1 Revisione 2026 ✅). Test con **Vitest**. In transizione verso PixiJS/Preact (vedi sotto).
- **Piattaforma:** browser / GitHub Pages, **desktop + tablet** (decisione Revisione 2026: il telefono non è più un target).
- **Salvataggio:** `localStorage` (`orion.saves.v4`: 5 slot + autosave) + Export/Import `.json` + sync cloud. Schema **100** (azzerato nella Revisione 2026: i save ≤ 32 sono rifiutati con messaggio).
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
- Fasi (ordine aggiornato dall'audit, `docs/AUDIT_2026.md` §7): 0 audit ✅ → 1 fondamenta ✅ (Vite + Vitest + golden replay + `js/newgame.js` + fix B1-B6) → 2 ✅ parziale (telefono rimosso, schema 100 con `STATE_FIELDS`, legacy potato, motore d'assedio unico, `js/commands.js` + `js/fleet-naming.js`, `galaxy.bfsPath`/`util.civById`; restano: cronaca come dati, scomposizione `main.js`/`time.js`, altri comandi) → 3 sistema visivo (palette in scelta) → 4 PixiJS (pilota **planet-view**, poi galassia) → 5 Preact pannelli.

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

- **Namespace globale `ORION`**: i moduli `js/*.js` sono IIFE importati come side-effect, **in ordine**, da `src/entry.js` (unico `<script type="module">` di `index.html`). Un modulo nuovo = una riga `import '../js/<modulo>.js';` nella posizione giusta (l'harness dei test legge lo stesso elenco).
- **Simulazione headless:** creare partite con `ORION.newgame.create(seed, opts)` (niente DOM); avanzare con `ORION.time.advance(game, n)`. Lo stato di gioco non si muta dalla UI dopo il tick.
- **Render Canvas on-demand** (no rAF loop continuo): `ResizeObserver` + `devicePixelRatio` (cap 2.5).
- **Input unificato Pointer Events** (mouse + touch). Niente funzioni `hover`-only.
- **Persistenza preferenze UI** in `localStorage['orion.uiprefs']`/`orion.prefs` — **mai nel save di partita** (UI_GUIDE §9).
- **Schema save:** un campo di stato persistito si aggiunge **solo** a `STATE_FIELDS` in `js/save.js` (usato sia da `serialize` sia dal ripristino `applyPayload`). Nessuna migrazione: lo schema è 100 e non si bumpa finché non c'è un'esigenza reale. Il test round-trip in `tests/sim.test.mjs` verifica che salvare e ricaricare non cambi lo stato.
- **Azioni del giocatore che cambiano lo stato** vanno in `js/commands.js` (`ORION.commands.*`, ritornano `{ ok, reason, … }`), non negli handler di `main.js`. La UI chiama il comando e poi aggiorna cronaca/viste.
- **Eventi cronaca:** kind con etichetta in `KIND_LABELS` + scelta auto-pausa in `DEFAULT_AUTOPAUSE` (decisione #31).
- **Tutorial (#29):** aggiungere voci a `ORION.tutorial.LESSONS` + `fire(id)`/`openLesson(id)` ai punti rilevanti. Niente walkthrough — concetti, non istruzioni cliccabili.
- **Utility condivise:** `ORION.util` (clamp/lerp/smoothstep/escapeHtml) + `ORION.format` in `js/utils.js`. Non duplicare.

---

## Comandi utili

- `npm install` una volta. `npm run dev` (server locale con reload), `npm run build` (→ `dist/`), `npm test` (Vitest).
- **Golden replay** (`tests/golden.test.mjs`): 3 seed × 3000 Impulsi, hash per sezione del save vs `tests/golden/baseline.json`. Un refactor NON deve cambiarlo. Se una modifica cambia il gameplay di proposito: `npm run golden:write` + spiegare nel commit quali sezioni cambiano e perché.
- Assedi: `tests/siege.test.mjs` (36 scenari deterministici colonia/stazione vs `tests/golden/siege-baseline.json`).
- Test mirati: `tests/sim.test.mjs` (harness `tests/harness.cjs`: contesto vm isolato, `load()` → `ctx.ORION`). Test storici in `tests/legacy/` (girano sotto Vitest).
- **Smoke end-to-end:** `node scripts/smoke.cjs dist` (o `.` per i sorgenti) — Playwright, flusso nuova partita → viste → eventi → reload; `--shots <dir>` per gli screenshot.
- Deploy: GitHub Action `.github/workflows/deploy.yml` (test + build + Pages). Richiede Settings → Pages → Source = "GitHub Actions".

---

## Stato moduli (sintesi)

✅ M01-M17 mergiati in main (schema 32). 🔶 M18 Reputazione/ICG (in conclusione, consegna a fette: reputazione + ICG + bridge figure già in main) · 🔶 M19 Spionaggio (Fase A+B: modulo `js/espionage.js` — "Operazione coperta" legata alla presenza flotta, Infiltrazione + Sabotaggio + Furto, esito deterministico, effetti via façade M18 `reputation.applyAndRecord`, bottino furto nel cluster via treasury · Intel grigia Mekhari §6e in `js/mekhari.js`: canale remoto a pagamento, dossier cap "parziale" · Infiltrazione svela il preavviso reale di tradimento via `diplomacy.betrayalOutlook` §11 + lezione tutorial `espionage`. Manca: controspionaggio/bidirezionalità) · ⬜ M20 Polish/bilanciamento/UI vittoria/calibrazione soglie. Per dettagli, fasi, decisioni numerate (#1..#91) e parametri: `docs/CLAUDE_FULL_ARCHIVE.md`.

---

## Riferimenti

- Decisioni numerate + stati moduli dettagliati: `docs/CLAUDE_FULL_ARCHIVE.md`
- Design del gioco: `ORION_EMPIRES_GDD.md`
- UI: `UI_GUIDE.md`
- Modalità di gioco e vittoria: `MODALITA_GIOCO.md`
