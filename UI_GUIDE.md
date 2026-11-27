# UI_GUIDE — Orion Empires (standard grafici)

> **Quando consultare questo documento:** prima di **qualunque** modifica a CSS, HTML strutturale, o creazione di sezioni/widget nuovi. Vincolante come la R1 di CLAUDE.md (gestione branch). Le decisioni qui sotto sostituiscono quelle in CLAUDE.md quando confliggono su temi UI.
>
> **Filosofia in una riga:** *un concetto = una tinta = un'icona*, riusabili nel gioco intero. Niente accenti random, niente glyph "piatti", niente etichette lunghe se l'utente le ha già capite.

---

## 0. Pre-flight checklist (PRIMA di scrivere CSS)

1. ☐ Il concetto ha già un colore in palette (§1)? → riusalo
2. ☐ C'è una classe esistente per questo pattern (§6)? → riusala, non duplicare
3. ☐ Le icone usano la tinta tematica (§3)? Niente `color: var(--c-text)` su un glyph. **Niente glow** (palette Plancia)
4. ☐ La label è appropriata per il pubblico (§4)? Sigla per badge stato, parola piena per titoli
5. ☐ Font ≥ 0.7rem, weight ≥ 400 (§2)?
6. ☐ Border-radius coerente (`--radius-sm` 3 / `--radius` 5 / 999 pill) (§5)?
7. ☐ Stato semantico riusa `is-ok/warn/crit/active/busy` (§7)?
8. ☐ Niente CDN a runtime; librerie solo bundlate (Revisione 2026, CLAUDE.md)
9. ☐ Tutorial: ogni concetto/sigla nuova ha una voce in `ORION.tutorial.LESSONS` (decisione #29)

---

## 1. Palette (token CSS canonici) — **Plancia**

Revisione 2026 (scelta utente 2026-11-20): **grafite neutra quasi monocroma**. L'interfaccia è grigia; il colore
compare **solo** per stati e concetti. **Nessun glow.** Token in `css/parts/tokens-base.css`. Ogni tinta ha la forma
`-rgb` per le trasparenze: `rgb(var(--c-accent-rgb) / .2)`. Mai hex o rgba scritti a mano nel CSS.

| Ruolo | Token | Hex | Uso |
|---|---|---|---|
| **Accento / galassia** | `--c-accent` | `#5cc8d6` | navigazione, flotte, azione primaria, focus |
| **Sistema / colonia** | `--c-accent-warm` | `#e3a35f` | roster colonie, capitale, sistema |
| **Gruppo / ricerca** | `--c-violet` | `#a493f0` | ricerca, gruppo stellare, tutorial |
| **Pianeta / info** | `--c-info` | `#74aee0` | pianeta, acqua, intel, stazioni |
| **Buono** | `--c-good` | `#63c98f` | ok, surplus, mercato, cibo |
| **Allerta** | `--c-warn` | `#dcbc5b` | warn, energia |
| **Critico** | `--c-bad` | `#e2697a` | crit, militare, civiltà ostile |
| **Testo** | `--c-text` / `--c-text-soft` / `--c-text-faint` | `#e8edf2` / `#aab4bf` / `#8f99a5` | primario / secondario / tenue |
| **Linee** | `--c-line-rgb` → `--c-border` / `-soft` / `-strong` | `170 190 210` a .26 / .12 / .40 | bordi e separatori |

Varianti scure/chiare di una tinta: `color-mix(in srgb, var(--c-accent) 55%, #000)` / `… 70%, #fff)`.
Contrasto: testo tenue `#8f99a5` ≥ 4.5:1 sul pannello grigio.

### Sfondi / superfici

| Ruolo | Token | Valore | Uso |
|---|---|---|---|
| **Fondo pagina** | `--c-void` / `--c-space` | `#121519` / `#171b21` | body, starfield (più scuro dei pannelli) |
| **Pannello** | `--c-surface-rgb` | `36 40 47` (`#24282f`) | barre laterali, card, sheet — grigio scuro neutro, `rgb(var(--c-surface-rgb) / α)` |
| **Card nel pannello** | `--c-surface2` | `#2c3139` | blocchi annidati |
| **Superficie viola** | `--c-surface-violet-rgb` | `40 38 52` | blocchi a tinta viola |
| **Centro della scena** | `--c-view-rgb` | `44 58 84` | centro del riquadro mappa/sistema/pianeta (blu-ardesia) |
| **Fondo vista** | `--c-bg-deep-rgb` | `26 34 50` | bordi del riquadro centrale, dashboard, riquadri di vista |

> Le **Preferenze** (luminosità) offrono 4 livelli di grafite (`SURFACE_LEVELS` in `main.js`) che sovrascrivono
> i tre knob RGB a runtime. Preferenza di dispositivo, **mai nel save**.

### Mapping concetto → colore (canone)

| Concetto | Colore | Note |
|---|---|---|
| Galassia / livello macro | ciano | livello più alto della nav |
| Gruppo stellare | viola | livello intermedio |
| Sistema stellare | ambra | livello intermedio |
| Pianeta / corpo | azzurro | livello terminale (anche acqua per coerenza) |
| Colonia mia | ambra | "mio territorio" |
| Flotta | ciano | "movimento, esplorazione" |
| Civiltà AI | rosa | "altri attori, tensione" |
| Ricerca / Tech | viola | "conoscenza" |
| Mercato | verde | "scambio" |
| Diplomazia | rosa (o viola in casi specifici) | da definire quando arriva M11 |
| Spionaggio | viola scuro | gancio M19 |
| Capitale di gruppo | oro | premium status |
| Difese / militare | rosa-rosso | |
| Cronaca / log | bianco neutro | trasversale |

**Regola d'oro:** un concetto = una tinta. Se "ricerca" è viola in sx, deve essere viola anche nei badge tech, tooltip, cronache. Niente eccezioni "estetiche".

---

## 2. Tipografia

### Font (locali, no CDN — vincolo §2)

- **`var(--font-display)`** (Orbitron): SOLO titoli, header sezione, etichette UPPERCASE, brand, sigle del Faro (`.ds-unit`).
- **`var(--font-data)`** (JetBrains Mono): SOLO numeri, durate, counter, rate `/Ι`, sigle Ω·Φ·Κ·Ι, valori esatti.
- **Default sistema**: testo prosa (cronaca, descrizioni, tutorial).

### Scala (base 16px → rem)

| Livello | Size | Weight | Uso |
|---|---|---|---|
| Titolo hero | `1.4rem` | 600 | brand, modale principale |
| Header sezione | `0.82rem` | 600 UPPER | `.lp-section__head`, `.panel__title` |
| Body principale | `0.88rem` | 400-600 | item roster, launcher, scheda |
| Body compatto | `0.82rem` | 400 | label HUD risorse |
| Sub / meta | `0.76-0.78rem` | 400 | mini-info, counter, descrizioni |
| Badge / chip | `0.74rem` | 600 | pill stato, contatori |
| Mini | `0.70rem` | 600 UPPER | etichette laterali (rare) |

**Floor a 0.70rem.** Sotto è illeggibile su laptop. Mai sotto.

---

## 3. Icone — sempre tematiche colorate (regola dell'utente)

### Principi

- **Mai glyph "piatto" color-text.** Ogni icona porta la sua tinta tematica.
- **Niente glow** (palette Plancia, Revisione 2026): la tinta basta. Le vecchie regole sul glow morbido sono decadute; `--glow-accent` resta come token vuoto per compatibilità.
- **3 livelli di prominenza**:
  - Hero `1.05rem` (HUD risorse, header modali)
  - Standard `0.95-1.0rem` (sezioni, item card)
  - Inline `0.85-0.9rem` (badge, costi, chip)

### Strategia di rendering — **due approcci**

#### ✅ A — Glyph Unicode + font forzato (fallback temporaneo)

Per icone semplici che esistono già nel codice, applica:

```css
.foo__glyph {
  font-family: 'JetBrains Mono', 'Segoe UI Symbol', 'Noto Sans Symbols2', monospace;
  font-variant-emoji: text;          /* forza style "text" anche su emoji */
  color: var(--c-accent);            /* tinta tematica */
  text-shadow: 0 0 3px currentColor; /* glow morbido (alpha effettivo modulato dal colore) */
}
```

**Glyph "safe" testati** (renderizzano consistentemente cross-OS):
`✦ ◈ ◉ ◇ ◌ ★ ⊕ ⚑ ⛭ ⚡ ❖ ≈ ▸ ▾ ▴ ⌬ ⇄ ⬢ ⬡ ⊙ ⊗ ⊘`

**Glyph da EVITARE** (rendering inconsistente, alcuni OS li trattano come emoji a colori):
`🏛 📜 ⚓ 🚀 🛰 ⚔️ 🏴 🛡️ 📡 🔬 ⚙️` (tutti gli emoji codepoints U+1F300+)

#### 🎯 B — Inline SVG (canone per il nuovo)

Catalogo centralizzato in `js/icons.js` (da creare con la prima sezione che ne ha bisogno):

```js
ORION.icons = {
  roster:   '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">...</svg>',
  nav:      '<svg ...>...</svg>',
  // ...
};
```

Uso:
```html
<span class="ui-icon ui-icon--roster" aria-hidden="true">__SVG__</span>
```
```css
.ui-icon {
  display: inline-block;
  width: 1em; height: 1em;
  line-height: 1;
  filter: drop-shadow(0 0 3px currentColor); /* glow morbido, blur 3-4px */
}
.ui-icon--roster { color: var(--c-accent-warm); }
```

**Vantaggi B:** pixel-perfect ovunque, scaling vettoriale, controllo totale. **Costo:** ~150-300 byte per icona inline.

### Linea-guida di migrazione

- **Sezioni nuove → SVG canonico (B).**
- **Sezioni esistenti → restano in A finché si tocca quel codice**, poi migrazione opportunistica a SVG.
- **Mai mescolare A e B nello stesso pannello visivo** (estetica incoerente).

---

## 4. Etichette, sigle, abbreviazioni

### Regola dell'utente

Preferire sempre **icona + sigla** dove l'utente esperto basta; **parola piena** dove serve onboarding.

### Cosa va in **sigla 3 lettere**

| Dove | Sigle attuali / proposte |
|---|---|
| Classi popolazione (chip) | OPE · SCI · MIL · MER · TEC |
| Stato risorsa (badge) | OK · LOW · CRIT |
| Badge stato item | OK · WRN · CRT · INF |
| Costi inline (icona+numero) | (solo icona, no sigla) |

**Tooltip al hover** sempre presente con la parola piena (`title=""` minimo, custom tooltip in futuro).

### Cosa va in **parola piena o quasi-piena**

| Dove | Esempio |
|---|---|
| Titoli sezione sx | Roster · Navigazione · Moduli · Cronaca |
| Titoli tab scheda dx | Colonia · Risorse · Strutture · Popolazione |
| Voci di navigazione | Galassia · Gruppo · Sistema · Pianeta |
| Bottoni di azione | Colonizza · Costruisci · Espandi · Annulla |
| Voci di cronaca | testo discorsivo, prosa |
| Tutorial | parola piena obbligatoria |

### Cosa va in **parola abbreviata** (NO sigle)

| Dove | Esempio |
|---|---|
| Vittorie / piste (M20) | Esplor. · Coloniz. · Egem. · Ascens. · Pace · Tirann. · Soprav. |
| Indicatori HUD compatti | DATA · ICG · REP (eccezione: sigle di concetti acronimi reali) |
| Sigle Calendario Faro | Ω · Φ · Κ · Ι (sigle ufficiali, decisione #30) |

### Anti-pattern da evitare

- ❌ `RST` per Roster, `CRN` per Cronaca, `NAV` per Navigazione — parole già brevi, sigla non vale lo sforzo cognitivo
- ❌ Sigle a 2 lettere ambigue (`MR` per Mercato/Mercanti/Militari)
- ❌ Sigla senza tooltip / parola piena recuperabile
- ❌ Mescolare sigle e parole piene nella stessa lista

---

## 5. Spacing, densità, geometria

### Gap

- **Interno sezioni**: `4-6px` (compatto), `8-10px` (respiro)
- **Tra card adiacenti**: `5-8px`
- **Tra sezioni padre**: `10-14px`

### Padding card

- **Item compatto**: `6-7px / 8-10px` (vert/oriz)
- **Item standard**: `7-9px / 10-12px`
- **Card pannello**: `8-12px / 10-14px`
- **Mai più di 14px / 16px** se non sei dentro un modale

### Border-radius

- **Card piccole** (item, badge interno): `4-6px` (`var(--radius-sm)`)
- **Pannelli grandi** (modali, sezioni): `8px` (`var(--radius)`)
- **Chip / pill / counter**: `999px` (pill totale)
- **Bottoni**: `4-6px` (radius-sm)

### Bordi

- **Default**: `1px solid var(--c-border-soft)` (sottile, basso contrasto)
- **Separatore marcato**: `1px solid var(--c-border)` (header sezione, divider modali)
- **Border-left colorato 3px** per categorizzazione (es. categorie strutture decisione #44)

---

## 6. Pattern ricorrenti (classi canoniche)

Quando crei una sezione nuova, **prima cerca** se uno di questi pattern fa al caso tuo. Solo se la risposta è no, motiva nel commit perché.

| Pattern | Classe riferimento | Componenti tipici |
|---|---|---|
| **Section head** | `.lp-section__head` | caret · glyph colorato · titolo · counter pill |
| **Item card cliccabile** | `.lp-item` · `.lp-launcher__btn` | glyph + nome + sub + badges |
| **Badge stato** | `.lp-item__badge--{ok,warn,crit,info}` | pill colorato per stato |
| **Chip info read-only** | `.deck-chip` · `.crumb-chip` | etichette neutre |
| **Bottone azione** | `.btn` · `.btn--primary` · `.btn--mini` | gerarchia rispettata |
| **Modale full-screen** | `.save-modal` · `.expedition-pick-overlay` | overlay z=200+ con backdrop blur |
| **Action bar contestuale** | `.viewport__actionbar` | bottoni sopra la scena per oggetto navigato |
| **Helper titolo sezione** | `secTitle(glyphCls, glyph, text)` in `main.js` | sempre questo helper per nuove sezioni sx |
| **Toast feedback** | `.save-toast` | 1.8s bottom-center per feedback discreto |
| **Tag inline** | `.name-tag` (decisione #28) | sigla regione + nome sistema |
| **Navigazione mobile** | `.mobile-nav` · `.mobile-scrim` (decisione #63) | bottom tab bar (≤760px) + plance come sheet a tutto schermo |

---

## 7. Stati semantici (riusabili in tutto il gioco)

Ogni elemento "salute / stato" parla la stessa lingua. **Mai inventare** nuove tinte di stato in singoli moduli.

| Stato | Classe | Tinta | Quando |
|---|---|---|---|
| **OK** | `.is-ok` | `var(--c-good)` | tutto regolare |
| **Allerta** | `.is-low` · `.is-warn` | `#f0d670` | situazione in degrado, ancora gestibile |
| **Critico** | `.is-crit` | `var(--c-bad)` | richiede azione, fail incombente |
| **Attivo / focus** | `.is-active` · `.is-focus` | bordo `var(--c-accent)` + `box-shadow: inset 2px 0 0 var(--c-accent)` | item selezionato |
| **Occupato** | `.is-busy` | `opacity: 0.92` | in costruzione, in coda |
| **Disabilitato** | `[disabled]` · `.is-locked` | `opacity: 0.5-0.6`, cursor `not-allowed` | non disponibile |

---

## 8. Animazioni e feedback

- **`var(--transition)`** = 200-250ms ease per hover/state change
- **Pulse HUD** = 380ms per snap a fine batch (decisione M05)
- **`prefers-reduced-motion`** sempre rispettato (decisione M01)
- **Niente bounce, niente parallax aggressivo** dentro l'UI (solo sul background stellare)
- **Feedback discreto** (toast `.save-toast` 1.8s) per azioni non bloccanti

---

## 9. Persistenza preferenze UI

- **Mai nel save di partita** (decisione #5: il save = stato di gioco, non UI)
- Sempre in `localStorage`:
  - `orion.uiprefs` per layout/collassi (oggetto JSON, JSON.stringify)
  - `orion.dxPin.<seed>` per pin seed-aware (decisione #50)
  - `orion.playSpeed` per velocità auto-advance (decisione #31)
  - `orion.autopause` per trigger auto-pausa per-tipo (decisione #31)
- Naming convention: `orion.<feature>` (kebab-case)

---

## 10. Accessibilità minima

- Tutti i bottoni hanno `type="button"` (default ≠ submit)
- `aria-label` su pannelli e regioni
- `aria-hidden="true"` su glyph decorativi (non leggibili screen-reader)
- `title=""` come tooltip + ripiego semantico
- Focus visibile (`outline` o `border-color: var(--c-accent)`)
- Niente flash > 3/sec (sicurezza fotosensibilità)

---

## 11. Vincoli inderogabili del progetto

- **Nessuna chiamata esterna a runtime**; librerie (Vite, PixiJS, Preact) solo **bundlate** (Revisione 2026, CLAUDE.md)
- **Target desktop + tablet** (il telefono ≤760px non è più supportato: le voci mobile dello storico sono decadute)
- **Determinismo seed+delta** (decisione #5): le preferenze UI NON entrano nel save
- **Recovery-friendly** (decisione #22): nessun pattern UI deve incentivare "scelte permanentemente punitive"
- **Tutorial sempre aggiornato** (decisione #29): ogni nuova sigla/icona/concetto ha una voce in `ORION.tutorial.LESSONS`

---

## Cambi futuri a questa guida

Modifiche a UI_GUIDE.md vanno discusse con l'utente PRIMA di applicarle (come per le decisioni di CLAUDE.md). Aggiungere in coda al file una sezione "Storico modifiche" con data + razionale per ogni cambio sostanziale.

---

### Storico modifiche

- **2026-06-06** — Prima stesura. Codifica gli standard emersi durante il refactor sidebar (PR #74 / decisione #50). Inputs dell'utente: icone colorate sempre, sigle solo dove l'utente esperto basta + tooltip, parola piena nei titoli sezione, glyph fallback inconsistente → migrazione canonica a inline SVG.
- **2026-06-06** — Glow morbido: specifica canonica abbassata da `0 0 5px` alpha `0.7` a `0 0 3px` alpha `0.35-0.45` (feedback utente: l'alone fluo marcato stancava l'occhio nelle sessioni lunghe). `.res-icon` esistente a `4px / 0.45` resta valido. La preview `icons-preview.svg` è stata aggiornata di conseguenza.
- **2026-06-07** — Layout mobile (PR mobile, decisione #63, emenda #6). Aggiunto il breakpoint telefono ≤760px: shell a **colonna unica** (mappa a tutto schermo) + **bottom tab bar** (`.mobile-nav`: Mappa·Colonia·Flotte·Civiltà·Altro, icone SVG tematiche §3, voci attive in `--c-accent`) + le due plance (sx/dx) come **sheet a tutto schermo** (`transform: translateY` con scrim `.mobile-scrim`). Riscritte da zero le media query ≤900/≤560 **obsolete** (referenziavano l'area grid `chron`/`.chronicle` rimossa dal refactor #50). Nuovo tier tablet ≤1000px (pannelli più stretti). Target-touch ≥44px (§10). Stato UI volatile su `ORION._mobileSheet`, mai nel save (§9). Nuova lezione tutorial `mobile-nav` (§0.9).
- **2026-06-07** — Polish mobile (feedback utente). **(a) Overflow orizzontale**: su varie schermate i testi sforavano leggermente a destra → guard ≤760px `overflow-x:hidden` su sheet/stage + `overflow-wrap:break-word` e `min-width:0` sui flex-child di `.panel__content`/`.fleet-view`/`.civ-view`/`.market-view` (min-width:auto è la causa classica dello spill nei flex). **(b) Header più compatta**: ridotto il padding interno del pulsante velocità (`.btn--play`) e di "prossimo evento" (`.btn--next-event`, label "Evento" nascosta, delta più piccolo) + mini-bottoni; la riga controlli tempo può andare a capo (`flex-wrap`). **(c) Scroll verticale**: quasi tutte le sezioni non raggiungevano il fondo → `.viewport__stage` reso scrollabile (`overflow-y:auto` + `place-items:start stretch`, prima centrava e clippava), viste flotta/civiltà/mercato a `height:auto`+`overflow:visible`, sheet sx/dx scrollano come unico contenitore (`.panel__content` `overflow:visible`); padding-bottom = altezza bottom-nav per non finirci sotto.
- **2026-06-07** — HUD sempre visibile con una sheet aperta (feedback utente: aprendo le schede Colonia su tablet portrait spariva l'header con risorse/controlli tempo). Le sheet a tutto schermo (`.panel--left/right`) e lo scrim partono ora da **`top: var(--hud-h)`** invece di `top:0`: l'altezza reale dell'HUD (variabile per il wrap) è misurata in JS (`updateHudHeightVar` → setta `--hud-h`, su resize + apertura sheet) e l'`.hud-top` ha `z-index:160` (sopra le sheet) come sicurezza. Risultato: risorse, indici e controlli tempo restano visibili e cliccabili anche con una scheda aperta.
- **2026-06-07** — Polish tablet/mobile (feedback utente, foto). **(a) Card Dashboard Impero**: le 3 metriche (Popolaz./Morale/Scorte) si sovrapponevano su schermo stretto (valori `nowrap` sforavano le colonne `3×1fr`). Fix ≤760px: head metrica impilata (etichetta sopra valore) + ellissi → niente overlap. **(b) Plancia d'Impero — accordion**: le sezioni (Roster/Navigazione/Sale e moduli/Cronaca) ora si aprono **una alla volta** (aprirne una collassa le altre), default Roster; risolve l'accavallamento con tutte aperte e riduce l'altezza del pannello. Pattern: per pannelli con molte sezioni collassabili in colonna stretta, preferire l'accordion al multi-open.
- **2026-06-07** — Polish post-token (feedback utente, foto vista Civiltà): navy alzato di un grado (`--c-surface-rgb` 34,46,86→**41,55,98**; `--c-bg-deep-rgb` 22,30,64→**28,37,76**) per leggibilità in alta luminosità ambientale. **Bordo dx card tagliato / testo da bordo a bordo**: causa = `.viewport__stage` (grid) con colonna implicita **dimensionata sul contenuto** → la vista si allargava oltre il viewport e veniva clippata a destra. Fix: `grid-template-columns: minmax(0, 1fr)` sullo stage (colonna cappata alla larghezza → tutto va a capo). In più: `.civ-view` padding `4px 2px`→`8px 12px`; `.civ-card__head`/`.civ-indices`/`.fleet-view__head` resi `flex-wrap:wrap`; `.civ-list` a colonna singola su mobile. Regola generale: i contenitori delle viste full-screen non devono auto-dimensionarsi sul contenuto (usare `minmax(0,1fr)` o block) e le righe di chip vanno in `flex-wrap`.
- **2026-06-07** — Tokenizzazione superfici + navy più percepibile (feedback utente: «non vedo ancora alcuno sfondo navy» + «portali a token»). Introdotti i token-canale **`--c-surface-rgb` (34 46 86)**, `--c-surface-violet-rgb` (46 34 78), `--c-bg-deep-rgb` (22 30 64): ~47 background di superficie prima hardcoded sono ora `rgb(var(--c-surface-rgb) / α)` (alpha preservato per-uso) → **una sola variabile** regola la luminosità di tutte le schede. `--c-panel`/`--c-panel-solid` derivati dal token. Fondi pagina alzati (`--c-void #101a3a`, `--c-space #16224c`, `--c-deep #1e2a5a`); viewport + Dashboard Impero su `--c-bg-deep-rgb` con glow navy più chiaro. Navy reso volutamente più visibile di prima (26,36,66 → 34,46,86) restando lontano dal blu pieno. Vedi §1 "Sfondi / superfici".
- **2026-06-07** — Luminosità sfondi · giro 3 + scroll (feedback utente: «schede ancora nere; molte non scrollano»). **Causa radice degli sfondi neri**: ~40 background **hardcoded quasi-neri** (`rgba(8,12,30,…)`, `rgba(8,11,26,…)`, `rgba(14,20,44,…)`, `rgba(20,24,38,…)`, …) usati da card/schede colonia/blocchi interni — **non passavano dai token**, quindi il lift dei token non li raggiungeva. Sweep mirata delle terne RGB delle *superfici* → navy (`26,36,66` / `28,38,70` / `24,33,62`; una violacea a `32,26,62`), preservando l'alpha; **scrim/dimmer dei modali e i `rgba(0,0,0,…)` di profondità lasciati scuri** (servono al contrasto). **Scroll**: `.colony-deck` reso scrollabile su mobile (era `overflow:hidden`+`pointer-events:none`) con `.deck-grid{height:auto}`. **Header**: controlli tempo su **una riga** (`flex-wrap:nowrap`) — prima "prossimo evento" andava a capo da solo.
- **2026-06-07** — Luminosità sfondi · giro 2 (feedback utente: «vedo ancora tutto nero»). Scoperto che le aree dominanti **non** dipendevano dai token ma da **gradienti hardcoded quasi-neri**: il fondo del `.viewport` (il canvas mappa fa `clearRect` → trasparente, il nero veniva dal CSS) `rgba(6,9,22,.85)→rgba(14,20,48,.92)` e l'overlay `.empire-deck` `rgba(6,9,22,.9/.82)→rgba(14,20,48,.9/.82)`. Token di fondo alzati ancora un filo: `--c-void` `#0a0e1e→#0c1228`, `--c-space` `#0e1430→#121a3c`, `--c-deep` `#151d42→#19224c`. Sempre navy scuro, lontano dal blu pieno.
- **2026-06-07** — Luminosità sfondi (feedback utente: ambiente troppo tetro, nero/blu-scurissimo). Token di fondo alzati **dal nero verso un navy scuro** (senza virare al blu pieno): `--c-void` `#04060f→#0a0e1e`, `--c-space` `#070b1c→#0e1430`, `--c-deep` `#0c1230→#151d42`, `--c-panel` `rgba(14,20,44,.86)→rgba(26,34,64,.90)`, `--c-panel-solid` `#101630→#1a2342`. Testo tenue `--c-text-faint` `#7d88b3→#98a3c8` per contrasto. **Mobile ≤760px**: `html { font-size: 18px }` per far salire tutti i testi minuti in `rem` (0.58–0.78rem) a misura leggibile (la geometria è in px → il layout non si deforma) + interlinea 1.45 nelle sheet + etichette bottom-nav 0.66rem.
- **2026-06-07** — Identità del popolo (decisione #65). Nuovo banner `.lp-empire` (accento ambra) in testa alla Plancia d'Impero → editor in-game (overlay riusa `.save-modal`). Step menu "Dai un nome al tuo popolo" + classi form `.main-menu__select`/`.main-menu__seedrow`/`.main-menu__empire-preview`. Prefisso = pool archetipi AI (#34), nome proprio default dalla colonia natale. Le card di salvataggio mostrano "Popolo: <nome>" come reminder principale.
- **2026-06-07** — Plancia di Colonia su telefono (decisione #65 follow-up): il deck sopra la sfera diventa **solo colpo d'occhio** (le azioni si fanno nella schermata Colonia). ≤760px: risorse e chip-classi popolazione in **griglia fluida** (`repeat(auto-fit, minmax(72/76px,1fr))`) che si stringe fino a misure minime; strutture **read-only** (nascosti "→ Vai a costruzione" e i "+Espandi"); **cronaca collassabile** (header cliccabile con icona, `data-deck-action="toggle-cron"`, default chiusa su mobile, stato volatile `ORION.deckCronOpen`).
- **2026-06-07** — Luminosità superfici regolabile (decisione #67). Su richiesta utente, default riportato verso lo **scuro** (livello *medio-scuro*: `--c-surface-rgb` 41,55,98 → **33,44,82**; bg-deep 28,37,76 → **21,28,60**) e, grazie al knob unico, **esposta nelle Preferenze** (ingranaggio in HUD, già presente): 4 livelli *Scuro · Medio-scuro · Medio · Chiaro* applicati a runtime (`applySurfaceLevel`/`SURFACE_LEVELS` in `main.js`), live + persistiti in `localStorage['orion.prefs']` (mai nel save). Stili `.prefs-row--levels`/`.prefs-levels`/`.prefs-level`.
- **2026-06-12** — Navigazione a zoom Galassia↔Sistema↔Pianeta (decisione #80). Nuovo pattern di transizione: `.is-zoom-entering` + `@keyframes zoom-fade-in` (200ms ease-out, **rispetta `prefers-reduced-motion`**) — mini-dissolvenza dell'holder che compare cambiando livello, applicata via `zoomFadeIn(holder)` in `main.js` su tutte le transizioni (scroll, bottoni, doppio-click). Durata coerente con `--transition` (§7). Nessun nuovo token, nessuna modifica agli standard esistenti. La navigazione sx (nav launcher) resta la via touch su mobile/tablet: lo scroll-in/out è **additivo**, non sostituisce i controlli esistenti.
- **2026-11-27** — **Revisione 2026, Fase 3 — palette Plancia** (scelta utente tra 5 proposte). Grafite neutra, colore solo per stati/concetti, **nessun glow**, radius 5/3. ~1.260 colori scritti a mano nel CSS sostituiti dai token (con trasparenza e varianti scure/chiare via `color-mix`); token `-rgb` per ogni tinta; `--c-info` nuovo; alias storici (`--c-text-dim`, `--c-amber`, `--c-muted`, `--font-mono`, `--radius-md`…) definiti. Floor 0.70rem applicato (45 dichiarazioni). Marcatori d'angolo e titoli pannello neutri. `style.css` diviso in `css/parts/*.css` contigui (ordine e cascata invariati). Card Dashboard Impero: etichetta sopra il valore (niente più sovrapposizioni). Layout telefono rimosso (Fase 2).
- **2026-11-27** — Ritocco Plancia (feedback utente): barre laterali **grigio scuro** (`#24282f`, non quasi-nero) per leggibilità; centro delle viste **blu-ardesia più chiaro** (`--c-view-rgb` 44 58 84 → bordo `--c-bg-deep-rgb` 26 34 50) al posto dello "scuro cosmico"; testo tenue alzato a `#8f99a5`; 4 livelli di luminosità ricalibrati di conseguenza.
