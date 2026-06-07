# UI_GUIDE — Orion Empires (standard grafici)

> **Quando consultare questo documento:** prima di **qualunque** modifica a CSS, HTML strutturale, o creazione di sezioni/widget nuovi. Vincolante come la R1 di CLAUDE.md (gestione branch). Le decisioni qui sotto sostituiscono quelle in CLAUDE.md quando confliggono su temi UI.
>
> **Filosofia in una riga:** *un concetto = una tinta = un'icona*, riusabili nel gioco intero. Niente accenti random, niente glyph "piatti", niente etichette lunghe se l'utente le ha già capite.

---

## 0. Pre-flight checklist (PRIMA di scrivere CSS)

1. ☐ Il concetto ha già un colore in palette (§1)? → riusalo
2. ☐ C'è una classe esistente per questo pattern (§6)? → riusala, non duplicare
3. ☐ Le icone usano la tinta tematica + glow (§3)? Niente `color: var(--c-text)` su un glyph
4. ☐ La label è appropriata per il pubblico (§4)? Sigla per badge stato, parola piena per titoli
5. ☐ Font ≥ 0.7rem, weight ≥ 400 (§2)?
6. ☐ Border-radius coerente (4-6 piccoli / 8 pannelli / 999 pill) (§5)?
7. ☐ Stato semantico riusa `is-ok/warn/crit/active/busy` (§7)?
8. ☐ Niente CDN, niente framework, niente WebGL (vincolo §2 progetto)
9. ☐ Tutorial: ogni concetto/sigla nuova ha una voce in `ORION.tutorial.LESSONS` (decisione #29)

---

## 1. Palette (token CSS canonici)

| Ruolo | Token | Hex indicativo | Uso |
|---|---|---|---|
| **Accento primario** | `--c-accent` | `#2fe6e0` ciano | navigazione, flotte, primary action, focus, mercato (no — vedi sotto) |
| **Accento caldo** | `--c-accent-warm` | `#f0a868` ambra | roster colonie, capitale, sistema, pianeta base, scarsità low |
| **Viola** | `--c-violet` | `#b89cff` viola | ricerca, gruppo stellare, tutorial, moduli/sale |
| **Buono / verde** | `--c-good` | `#6fe0b8` verde | mercato, ok, surplus, stato operativo, cibo |
| **Allerta / oro** | n/a | `#f0d670` oro | warn, scarsità in arrivo, energia |
| **Critico / rosa** | `--c-bad` | `#f08296` rosa-rosso | crit, allerta militare, civ ostile, errori |
| **Info / azzurro** | n/a | `#80c8e6` azzurro | acqua, pianeta, intel/spionaggio, info passive |
| **Risorse fisse** | `.res-icon--{met,en,food,water}` | (palette dedicata) | Met=acciaio · En=oro · Cib=verde · Acq=azzurro — **MAI cambiare** |

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
- **Sempre con glow morbido** (`text-shadow` o `filter: drop-shadow`) coerente con `.res-icon` (decisione #8 NASA/Visions). **Specifica canonica**: blur `3-4px`, alpha `0.35-0.45`. Niente alone marcato (`5px` blur / `0.7` alpha stanca l'occhio nelle sessioni lunghe).
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

- **Vanilla JS / no framework / no CDN / no WebGL** (GDD §2)
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
- **2026-06-07** — Luminosità sfondi (feedback utente: ambiente troppo tetro, nero/blu-scurissimo). Token di fondo alzati **dal nero verso un navy scuro** (senza virare al blu pieno): `--c-void` `#04060f→#0a0e1e`, `--c-space` `#070b1c→#0e1430`, `--c-deep` `#0c1230→#151d42`, `--c-panel` `rgba(14,20,44,.86)→rgba(26,34,64,.90)`, `--c-panel-solid` `#101630→#1a2342`. Testo tenue `--c-text-faint` `#7d88b3→#98a3c8` per contrasto. **Mobile ≤760px**: `html { font-size: 18px }` per far salire tutti i testi minuti in `rem` (0.58–0.78rem) a misura leggibile (la geometria è in px → il layout non si deforma) + interlinea 1.45 nelle sheet + etichette bottom-nav 0.66rem.
