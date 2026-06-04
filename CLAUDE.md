# CLAUDE.md — Stato di sviluppo di Orion Empires

> File di stato aggiornato a ogni sessione, come richiesto dal GDD (§0, §21).
> La **fonte di verità** del design è `ORION_EMPIRES_GDD.md`.
> Sviluppo **modulo per modulo**: ogni modulo va confermato prima di passare al successivo.

---

## Identità del progetto

- **Titolo:** Orion Empires
- **Tipo:** 4X spaziale strategico a pannelli (testuale, non action, non libro-game)
- **Stack:** Vanilla JS puro, HTML, CSS — nessun framework, nessun CDN, nessuna chiamata esterna
- **Piattaforma:** Browser / GitHub Pages
- **Salvataggio:** localStorage (slot multipli) — da implementare in M06

---

## Stato moduli

Legenda: ✅ completato · 🚧 in corso · ⬜ non iniziato · ⏸️ in attesa di conferma

| #   | Modulo                         | Stato | Note |
|-----|--------------------------------|:----:|------|
| M01 | Struttura base (shell, tema, layout) | ✅ | Confermato. Shell, tema, layout, TSG. |
| M02 | Galassia (gen. procedurale, mappa Canvas) | ⏸️ | Implementato — in attesa di conferma utente. Gen. procedurale (seed+delta), nomi §5.2, mappa a nodi su Canvas responsivo + Pointer Events. |
| M03 | Sistema stellare               | ⬜ | |
| M04 | Pianeta base                   | ⬜ | |
| M05 | Tempo e avanzamento (TSG, game loop) | ⬜ | |
| M06 | Salvataggio (localStorage + export/import .json) | ⬜ | seed+delta, schemaVersion, log limitato |
| M07 | Esplorazione                   | ⬜ | |
| M08 | Flotta base                    | ⬜ | |
| M09 | Combattimento                  | ⬜ | |
| M10 | Civiltà AI                     | ⬜ | |
| M11 | Diplomazia                     | ⬜ | |
| M12 | Commercio                      | ⬜ | |
| M13 | Tecnologia                     | ⬜ | |
| M14 | Figure speciali                | ⬜ | |
| M15 | Grandi navi                    | ⬜ | |
| M16 | Stazioni spaziali              | ⬜ | |
| M17 | Eventi e narrazione            | ⬜ | |
| M18 | Reputazione e ICG              | ⬜ | |
| M19 | Spionaggio                     | ⬜ | |
| M20 | Polish e bilanciamento         | ⬜ | |

---

## M01 — Struttura base · cosa è stato fatto

**Obiettivo (GDD §20):** HTML shell, CSS tema, layout pannelli, font.

- `index.html` — shell completa con:
  - Sfondo stellare parallax (3 layer, CSS puro)
  - **HUD superiore:** brand, barra risorse base (Metalli/Energia/Cibo/Acqua), indici globali (ICG, Reputazione, **Data Stellare**) — valori segnaposto `—`
  - **Corpo a 3 colonne:** pannello navigazione (sinistra), viewport centrale (futura mappa Canvas), pannello Consiglio/dettagli (destra)
  - **HUD inferiore:** Cronaca Galattica + **controllo del tempo** (salti +1/+2/+5/+10 Impulsi + "Prossimo evento", disabilitati finché non c'è un game loop)
- `css/style.css` — tema scuro spaziale completo:
  - Tutto il theming via **CSS custom properties** (`:root`)
  - Palette: nero profondo + blu/viola + accenti ciano/arancio (come da §3)
  - Layout a griglia, pannelli semitrasparenti con blur, scrollbar a tema
  - Animazioni parallax e pulse con rispetto di `prefers-reduced-motion`
  - Responsive (collassa pannelli su schermi stretti)
- `js/main.js` — bootstrap minimo: switch della vista attiva nella navigazione. **Nessuna logica di gioco** (per non anticipare moduli futuri).
- Gli attributi `data-bind="..."` sui valori HUD sono predisposti per il binding dati dei moduli futuri.

### Aggancio per i moduli futuri
- I valori HUD usano `data-bind` (es. `data-bind="metalli"`, `data-bind="icg"`, `data-bind="data-stellare"`).
- Il viewport centrale ha `[data-view-stage]`: lì verrà montato il Canvas 2D (M02/M03).
- I controlli del tempo: `data-action="advance"` con `data-impulsi="1|2|5|10"`, e `data-action="advance-to-event"`. Il game loop temporale arriva in M05.

---

## M02 — Galassia · cosa è stato fatto

**Obiettivo (GDD §5):** generazione procedurale (seed salvabile), nomi §5.2, grafo a nodi su Canvas 2D nel viewport.

Architettura a moduli vanilla (namespace globale `ORION`, niente bundler), caricati in ordine di dipendenza in `index.html`:

- **`js/rng.js` — PRNG deterministico.** Fondamento del **seed+delta** (decisione #5). `mulberry32` + hashing seed `xmur3`; helper `int/range/pick/shuffle/gauss/chance`. `newSeed()` genera un seed breve e leggibile (8 caratteri, niente ambigui). Dato lo stesso seed, la galassia si rigenera **identica** (verificato su 300 seed).
- **`js/names.js` — nomi §5.2.** Pool 20 nomi reali + generatore procedurale a 3 stili (latino/classico, aspro/alieno, poetico/misterioso) con banchi di sillabe che includono gli esempi del GDD. Ratio **40% reali / 60% inventati**, unici, distribuiti casualmente. Quando la quota reali supera il pool di 20, i nomi reali eccedenti ricevono una **designazione di catalogo romana** (`Rigel II`, `Vega III`) — convenzione 4X (vedi decisione #7).
- **`js/galaxy.js` — generazione + stato.** Separa nettamente:
  - **Struttura immutabile** (`generate(seed)`): 80–120 sistemi (§5.1), layout con **clustering** (4–7 cluster) a **forma variabile**: inviluppo galattico a disco per-seed (bias verso il quasi-sferico), centri-cluster con **distanza minima** reciproca, forma per gruppo con aspetto a bias sferico + 1–3 sotto-ammassi (contorni non regolari), **appartenenza di Voronoi** così i territori dei gruppi non si sovrappongono; grafo rotte stellari (**MST di Prim** per connettività garantita + rotte extra corte per anelli locali), tipo stella (uso minimale: colore nodo; contenuto pieno è M03), **pericolo §5.3** crescente con la distanza dal pianeta base, sistema di partenza centrale e ben connesso. Coordinate in spazio normalizzato `[0,1]²`. NON va salvata: basta il seed.
  - **Stato mutevole / delta** (`createState`): livello di scoperta per sistema (nebbia di guerra §5.1: home `EXPLORED`, adiacenti `DETECTED`, resto `UNKNOWN`), selezione corrente. È ciò che andrà salvato in M06. Include `schemaVersion`.
- **`js/galaxy-map.js` — mappa su Canvas.** Classe `GalaxyMap`:
  - **Canvas responsivo** (decisione #6): `ResizeObserver` sul contenitore + `devicePixelRatio` (cap 2.5) per nitidezza HiDPI; render **on-demand** via `requestAnimationFrame` (non loop continuo).
  - **Input unificato mouse/touch** (decisione #6): tutto via **Pointer Events** — pan (trascinamento), zoom (rotella + pinch a 2 dita), tap/click per selezionare/entrare, hover per evidenziare, doppio click per inquadrare/risalire. `touch-action:none`. Nessuna funzione legata al solo hover.
  - **Resa "realistica"** (decisione #8): niente alone uniforme su ogni nodo. Lo sfondo (colore/atmosfera) viene da **nebulose procedurali** + **polvere stellare** deterministiche dal seed (con poche stelle "eroe" a bloom + spicchi di diffrazione); i sistemi-gioco sono **marker netti** con **anello sottile** per il pericolo (verde→rosso), home a doppio anello, selezione a reticolo.
  - **Navigazione gerarchica a zoom** (decisione #9, GDD §5.5): livelli **Galassia → Gruppo → (Sistema → Pianeta: M03/M04)**. Al livello Galassia si vedono le **regioni** (inviluppo convesso morbido + nome); avvicinandosi (zoom o click su regione) compaiono le **stelle** del gruppo — *reveal continuo* guidato dallo zoom, oltre alla camera **animata** su click. Notifica il contesto alla UI via `onContext({level, groupId, systemId})`; `onActivateSystem` (doppio click) inquadra il sistema. API pubbliche `focusGalaxy/focusGroup/focusSystem/selectSystem` usate anche dalla breadcrumb.
- **`js/main.js`** — integra M02: genera la prima galassia al boot (seed casuale), monta la mappa nella vista *Galassia*, gestisce la **breadcrumb** e la **sidebar contestuale** (pannello Galassia / Gruppo / Sistema coerente con la scala selezionata), popola la **Data Stellare** iniziale (epoca DS 800–3000 derivata dal seed, deterministica) e la Cronaca. Overlay con **seed**, n° sistemi/gruppi e comandi *Galassia* / *Nuova*.

**Note di scope:** l'esplorazione vera (rivelare sistemi muovendo flotte) è **M07**; qui la nebbia di guerra è solo inizializzata (e rispettata anche a livello di gruppo: i tipi-stella dei sistemi ignoti non sono rivelati). La **vista interna** di Sistema/Pianeta (corpi celesti, anomalie §6, stelle binarie) è **M03/M04**: in M02 i due livelli inferiori esistono come scala di navigazione ma rimandano ai moduli dedicati. ICG/Reputazione restano segnaposto fino ai moduli dedicati.

---

## Decisioni prese

1. **Font senza CDN.** Il GDD suggerisce *Orbitron* da Google Fonts (§3), ma vieta anche dipendenze/CDN esterni (§2). Per rispettare il vincolo più stringente si usa uno **stack di font** (`--font-display`) che impiega Orbitron se installato localmente, con fallback di sistema. In futuro si potrà includere il font come file locale (`/fonts`) senza chiamate esterne.
2. **Branch `main`.** Il repository era vuoto: l'impalcatura iniziale fa da base. Lo sviluppo avviene sul branch dedicato indicato per la sessione.
3. **JS minimale in M01.** Nessuna struttura di gioco anticipata: i file `js/galaxy.js`, `js/planet.js`, ecc. previsti dal GDD §2 verranno creati nei rispettivi moduli.
4. **Tempo al posto dei turni (GDD §4 riscritto).** Su richiesta utente l'avanzamento non è più "a turni" ma a **tempo**, cardine del gioco. Introdotto il **Tempo Standard Galattico (TSG)**, slegato da giorno/anno terrestri e ancorato a un riferimento galattico (Faro di Orion, una pulsar):
   - Unità (decimali): **Impulso** (atomica, I) · **Arco** = 10 I · **Orbita** = 100 I · **Èra** = 1000 I
   - HUD mostra la **Data Stellare** `DS <orbita>.<impulsi>` (es. `DS 1873.13`)
   - Avanzamento: salti **+1/+2/+5/+10 Impulsi** + **"Avanza fino al prossimo evento"**
   - **Epoca d'inizio randomizzata** a ogni partita nell'intervallo **DS 800.00–3000.00** (galassia sempre preesistente); la randomizzazione effettiva arriva con la generazione partita (M02/M05)
   - Durate del GDD §4 ricalibrate in Impulsi (passi 1-10 sensati); termine "turno" sostituito da "Impulso" in tutto il GDD
   - Nomenclatura concordata con l'utente (Impulso/Arco scelti al posto di Ciclo/Fase/Battito).
5. **Salvataggio: Export/Import `.json` (decisione per M06).** Confermato il modello GDD (`localStorage`, slot multipli) con in più **export/import di file `.json`** per giocare su più dispositivi — trasferimento **manuale** (Drive/USB/email), **nessun backend**, §2 intatto. Strategia anti-crescita:
   - galassia salvata come **seed + delta** (la struttura immutabile si rigenera dal seed; si salva solo lo stato mutevole)
   - **`schemaVersion`** nel payload per migrazioni future tra moduli
   - **cronaca/eventi con log limitato** (ultimi N) — unica fonte di crescita illimitata
   - dimensione attesa: ~20-50 KB (early) → ~200-500 KB (late; con seed+delta anche meno), ben sotto il limite localStorage (~5 MB). Un solo `.json` basta.
   - porta aperta a un **cloud-sync opzionale futuro** (stesso payload → Supabase, già collegato a questo ambiente).
6. **Target dispositivi: desktop + tablet (no telefono).** Ottimizzazione per **browser PC e tablet**; smartphone non supportati (visuale troppo ridotta). Larghezza minima **~768px**; sotto, avviso "schermo troppo piccolo". Implicazioni: responsive a due fasce (desktop/tablet-landscape a 3 colonne · tablet-portrait con pannello destro collassabile); **Canvas responsivo** (resize + `devicePixelRatio`) e **input unificato mouse/touch** (Pointer Events) fin da M02/M03; niente funzioni affidate solo all'`hover`.
7. **Nomi reali oltre il pool: designazione di catalogo (M02).** Il GDD §5.2 chiede **40% nomi reali**, ma il pool fisso è di soli **20** nomi: con galassie fino a 120 sistemi la quota del 40% (fino a 48) supera il pool. I nomi reali eccedenti ricevono quindi una **designazione romana** (`Rigel II`, `Vega III`, …), convenzione comune nei 4X (MoO, Stellaris). Così la regola 40/60 è rispettata senza inventare false stelle reali. Gli inventati restano interamente procedurali (3 stili §5.2), quindi illimitati.
8. **Direzione artistica: "NASA retro / Visions" + resa mappa realistica (M02).** Scelta dell'utente fra tre mood retrò (paperback 70s · NASA/Visions · cassette/CRT) tramite mockup renderizzati. Vince **NASA/Visions** (blu notte, accenti ambra/ciano/magenta/viola, sans pulito) — già vicino al tema esistente. Sulla mappa **si abbandona l'alone uniforme** attorno a ogni nodo (effetto "a bolle"): il colore viene da **nebulose + polvere stellare** procedurali, con **bloom/spicchi di diffrazione** solo su poche stelle brillanti; i sistemi-gioco sono **marker netti** con anello sottile per il pericolo. Visual pass su M02; il pianeta procedurale (sfera con bande/atmosfera/terminatore) e la scheda pianeta allargata arrivano con M03/M04.
9. **Navigazione gerarchica a zoom con gruppi stellari (M02, GDD §5.5).** Mappa **scalabile** a livelli **Galassia → Gruppo → Sistema → Pianeta**, con la **sidebar contestuale** ai livelli (in M02: Galassia e Gruppo completi; Sistema/Pianeta come scala di navigazione che rimanda a M03/M04) e **breadcrumb** per risalire. I "gruppi stellari" riusano i **cluster** già generati; nomi-regione in schema **misto** (descrittore evocativo + riferimento reale se nel gruppo c'è una stella reale famosa, es. "Velo di Vega"; altrimenti nome evocativo). Il passaggio di livello è guidato sia dal **click** (camera animata) sia dallo **zoom** (reveal continuo regioni↔stelle). Nessun costo di salvataggio: gruppi e nomi sono deterministici dal seed.

---

## Problemi aperti / da decidere più avanti

- Includere o meno il font Orbitron come asset locale (`/fonts`) in un modulo di polish (M20).
- Definire lo schema dello stato di gioco (game state) e il `schemaVersion` del save prima di M04/M05 (M02 ha già introdotto `schemaVersion: 1` per galassia/stato).
- Avviso "schermo troppo piccolo" sotto ~768px (decisione #6) ancora da implementare (candidato M20/polish).

---

## Struttura file attuale

```
stargame/
├── index.html          ✅ shell UI + caricamento moduli M02
├── css/
│   └── style.css        ✅ tema scuro spaziale + mappa/galassia (M02)
├── js/
│   ├── rng.js           ✅ PRNG deterministico (M02 — seed+delta)
│   ├── names.js         ✅ nomi sistemi §5.2 (M02)
│   ├── galaxy.js        ✅ generazione galassia + stato/delta (M02)
│   ├── galaxy-map.js    ✅ mappa a nodi su Canvas (M02)
│   └── main.js          ✅ bootstrap + integrazione M02
├── CLAUDE.md            ✅ questo file
├── README.md            ✅
└── ORION_EMPIRES_GDD.md ✅ documento di design (fonte di verità)
```

Gli altri file/cartelle previsti dal GDD §2 (`js/planet.js`, `data/`, ecc.)
verranno aggiunti nei moduli corrispondenti.

---

_Ultimo aggiornamento: 2026-06-04 — M02 visual pass + navigazione gerarchica: direzione "NASA/Visions" con mappa realistica (nebulose + polvere + spicchi di diffrazione, niente alone uniforme), **gruppi stellari** navigabili (Galassia → Gruppo → Sistema/Pianeta) con breadcrumb e sidebar contestuale, reveal continuo guidato dallo zoom + camera animata. GDD §5.5 aggiunto. Decisioni #8 e #9 aggiunte. Resta ⏸️ in attesa di conferma utente._
