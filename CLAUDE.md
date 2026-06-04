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
| M02 | Galassia (gen. procedurale, mappa Canvas) | ✅ | Confermato (PR #4 mergiata in main). |
| M03 | Sistema stellare               | ✅ | Confermato (PR #5 mergiata in main). |
| M04 | Pianeta base                   | ⏸️ | Implementato — in attesa di conferma utente. Vista pianeta su Canvas (`planet-view.js`) come **sfera procedurale bakata** (FBM 3D + shading sferico, diversa per ogni corpo); scheda M04 nel pannello destro a 4 tab (Colonia/Risorse/Strutture/Popolazione); catalogo 14 strutture (`structures.js`); data model colonia come delta+schemaVersion (`planet.js`); risorse avanzate parzialmente nascoste (osservatorio = scan). Tassi-per-Impulso e durate-in-Impulsi definiti; l'avanzamento effettivo nel tempo è M05. |
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
  - **Struttura immutabile** (`generate(seed)`): 80–120 sistemi (§5.1), layout con **clustering** (4–7 cluster, dispersione gaussiana, distanza minima anti-overlap), grafo rotte stellari (**MST di Prim** per connettività garantita + rotte extra corte per anelli locali), tipo stella (uso minimale: colore nodo; contenuto pieno è M03), **pericolo §5.3** crescente con la distanza dal pianeta base, sistema di partenza centrale e ben connesso. Coordinate in spazio normalizzato `[0,1]²`. NON va salvata: basta il seed.
  - **Stato mutevole / delta** (`createState`): livello di scoperta per sistema (nebbia di guerra §5.1: home `EXPLORED`, adiacenti `DETECTED`, resto `UNKNOWN`), selezione corrente. È ciò che andrà salvato in M06. Include `schemaVersion`.
- **`js/galaxy-map.js` — mappa su Canvas.** Classe `GalaxyMap`:
  - **Canvas responsivo** (decisione #6): `ResizeObserver` sul contenitore + `devicePixelRatio` (cap 2.5) per nitidezza HiDPI; render **on-demand** via `requestAnimationFrame` (non loop continuo).
  - **Input unificato mouse/touch** (decisione #6): tutto via **Pointer Events** — pan (trascinamento), zoom (rotella + pinch a 2 dita), tap/click per selezionare/entrare, hover per evidenziare, doppio click per inquadrare/risalire. `touch-action:none`. Nessuna funzione legata al solo hover.
  - **Resa "realistica"** (decisione #8): niente alone uniforme su ogni nodo. Lo sfondo (colore/atmosfera) viene da **nebulose procedurali** + **polvere stellare** deterministiche dal seed (con poche stelle "eroe" a bloom + spicchi di diffrazione); i sistemi-gioco sono **marker netti** con **anello sottile** per il pericolo (verde→rosso), home a doppio anello, selezione a reticolo.
  - **Navigazione gerarchica a zoom** (decisione #9, GDD §5.5): livelli **Galassia → Gruppo → (Sistema → Pianeta: M03/M04)**. Al livello Galassia si vedono le **regioni** (inviluppo convesso morbido + nome); avvicinandosi (zoom o click su regione) compaiono le **stelle** del gruppo — *reveal continuo* guidato dallo zoom, oltre alla camera **animata** su click. Notifica il contesto alla UI via `onContext({level, groupId, systemId})`; `onActivateSystem` (doppio click) inquadra il sistema. API pubbliche `focusGalaxy/focusGroup/focusSystem/selectSystem` usate anche dalla breadcrumb.
- **`js/main.js`** — integra M02: genera la prima galassia al boot (seed casuale), monta la mappa nella vista *Galassia*, gestisce la **breadcrumb** e la **sidebar contestuale** (pannello Galassia / Gruppo / Sistema coerente con la scala selezionata), popola la **Data Stellare** iniziale (epoca DS 800–3000 derivata dal seed, deterministica) e la Cronaca. Overlay con **seed**, n° sistemi/gruppi e comandi *Galassia* / *Nuova*.

**Note di scope:** l'esplorazione vera (rivelare sistemi muovendo flotte) è **M07**; qui la nebbia di guerra è solo inizializzata (e rispettata anche a livello di gruppo: i tipi-stella dei sistemi ignoti non sono rivelati). La **vista interna** di Sistema/Pianeta (corpi celesti, anomalie §6, stelle binarie) è **M03/M04**: in M02 i due livelli inferiori esistono come scala di navigazione ma rimandano ai moduli dedicati. ICG/Reputazione restano segnaposto fino ai moduli dedicati.

---

## M03 — Sistema stellare · cosa è stato fatto

**Obiettivo (GDD §6):** vista interna del sistema, agganciata al livello *Sistema* della navigazione gerarchica di M02 (§5.5).

- **`js/system.js` — generazione dell'interno.** `generate(galaxy, systemId)` produce la **struttura immutabile** dell'interno, **derivata dal seed** (`<seed>:sys:<id>`): non va salvata, si rigenera identica (seed+delta, decisione #5 — verificato deterministico su 510 sistemi). Contiene:
  - **stella/e** ricavate dal tipo già scelto in M02 (coerenza col colore del nodo); le **binarie** (§6.1) sono due componenti attorno al baricentro, pianeti circumbinari;
  - **4–7 corpi celesti** (§6.1) in orbite spaziate, con tipo influenzato dalla fascia orbitale (interno caldo → vulcanico/desertico, fascia abitabile → terrestre/oceanico/forestale, esterno freddo → ghiacciato/gassoso; **cinture asteroidali** nei vuoti); **lune** come corpi-figli (sempre sui gassosi, talvolta sui rocciosi grandi);
  - tabella **tipi-corpo §6.3** con vantaggi/svantaggi e palette di resa; **anomalie §6.1** opzionali (0–2: campo di detriti / nebulosa locale / reliquie antiche);
  - il **sistema d'origine** garantisce un mondo ospitale (`homeWorld`).
- **`js/system-view.js` — vista su Canvas.** Classe `SystemView` (stessa impostazione di `GalaxyMap`): **Canvas responsivo** (ResizeObserver + `devicePixelRatio`, render **on-demand**) e **input unificato** via **Pointer Events** (pan, zoom rotella/pinch, tap per selezionare, hover, doppio click per inquadrare un corpo o uscire). Resa **NASA/Visions** (decisione #8): stella/e con core+corona+spicchi di diffrazione, **orbite sottili**, pianeti come **dischi procedurali** (bande dei gassosi, mottling roccioso, calotte di ghiaccio, crepe di lava, crateri lunari) con **bordo atmosfera** sul limbo illuminato e **terminatore** (emisfero notturno) — niente alone uniforme. Cinture come anello di detriti, anomalie come campi (nebulosa/detriti) + glifo.
- **`js/main.js` — integrazione.** Il Sistema è un **layer** sopra la mappa galassia (che resta viva sotto, preservando lo zoom): `openSystem/closeSystem`. **Breadcrumb** estesa `Galassia › Gruppo › Sistema › Pianeta` e **sidebar contestuale**: pannello *Sistema* (stella/e, n° corpi, pericolo, elenco corpi + anomalie) e, al click su un corpo, pannello *Corpo* con i dati base §6.3. Ingressi: doppio click sul nodo della mappa, pulsante **Apri sistema** nel pannello M02, voce di navigazione *Sistema*. **Cronaca:** all'ingresso in un sistema viene aggiunta una voce in Cronaca Galattica, coerente con la nebbia di guerra (ingresso / avvicinamento / sistema ignoto), con **log limitato** agli ultimi N (decisione #5) e niente doppioni consecutivi — piccola anticipazione di M05/M17 (il game loop temporale e gli eventi veri restano a quei moduli; la Data Stellare usata è quella d'inizio finché non c'è il loop).

**Note di scope:** la **scheda pianeta allargata** (risorse, popolazione, edifici, colonizzazione) è **M04** — qui ci si ferma alla **selezione del corpo e ai dati base** §6.3, con rimando esplicito a M04. La **nebbia di guerra** §5.1 è rispettata (scelta utente, vedi decisione #11): solo i sistemi **ESPLORATI** mostrano i corpi con dettagli; i **RILEVATI** mostrano stella+orbite e corpi come sagome "da scansionare"; gli **UNKNOWN** sono bloccati (rimando a M07). La scoperta vera (muovere flotte) resta **M07**.

---

## M04 — Pianeta base · cosa è stato fatto

**Obiettivo (GDD §6.2 · §7 · §8 · §9 · §10):** livello *Pianeta* della navigazione gerarchica (§5.5) — vista pianeta allargata, colonizzazione del primo corpo, potenziali risorse §7.1 (e candidate avanzate §7.2 parzialmente nascoste, §7.3), strutture §10 con slot, popolazione e classi funzionali §9 in background. Tassi-per-Impulso e durate-in-Impulsi definiti; l'avanzamento è M05.

- **`js/structures.js` — catalogo strutture (decisione #15).** 14 strutture su 6 categorie (estrattive/produttive/ricerca/militari/civili/avanzate), 2-3 per categoria: dà scelte significative senza anticipare M13. Ogni voce: `cost`, `time` (Impulsi, §4.4), `upkeep`, `rates`, `slots`, `requires` con ganci (`tech:*` per M13, `struct:<id>:<lvl>` per prerequisiti locali, `scan` per l'osservatorio), `hooks` per i moduli futuri (`fleet`, `research`, `trade`, ecc.). Le **produttive** (fonderia/raffineria) sono modificatori (`modifiers: { 'miniera.rates.met': 0.25 }`), letti dal calcolo dei tassi.
- **`js/planet.js` — data model (decisione #5, seed+delta).** Separa nettamente:
  - **STRUTTURA IMMUTABILE** `generate(galaxy, system, bodyKey)` derivata dal seed del corpo (`<body.seed>:planet`): **potenziali risorse base** §7.1 (0-100, varianza ±15), **slot di costruzione** §10.2 (±1 dalla base per tipo), **popolazione massima** §9 (0 se non abitabile), **candidate risorse avanzate** §7.2 (0-3, pesi per tipo: vulcanico→esotici/cristalli, gassoso→gasNobili/cristalli, forestale→biomassa/dati, ecc.), **ostilità locale**, **costo colonizzazione** (90-150 I + risorse, §4.4/§6.2). Le lune ereditano i potenziali dal padre scalati ×0.55. Determinismo verificato sui 7 corpi del sistema natale.
  - **STATO MUTEVOLE (delta colonia)** `createColony(planet)` con `schemaVersion`: `colonized`, `isHomeBase` (§8.1: bonus +20%), `structures: { [id]: { level, hp } }`, `queue`, `pop` (totale, capacità, 5 classi §9.2), `stock` (4 risorse base), `scanned` (rivelazione identità delle avanzate). Pronto per la serializzazione in M06.
  - **Calcoli:** `structureOutput(colony, planet)` aggrega i tassi per Impulso modulati dal **potenziale del corpo** (es. miniera = 4 × pot.met/60), applica il **bonus pianeta base +20%** (§8.1) e i moltiplicatori delle produttive; `theoreticalOutput(planet)` indica cosa offre il pianeta a regime per la scheda di valutazione (colonizzazione). `canBuild`/`startBuild`/`cancelBuild` gestiscono prerequisiti, slot e costo; `applyScan` svela le identità avanzate quando l'osservatorio è in funzione.
- **`js/planet-view.js` — vista Canvas (decisioni #6, #14, #17).** Classe `PlanetView` analoga a `SystemView`: si monta come **layer** sopra il system-holder, **canvas responsivo** (ResizeObserver + DPR) + **Pointer Events** (pan, zoom rotella/pinch, hover/click sulle lune, doppio click per uscire). La resa è il punto chiave:
  - **Bake offscreen** della sfera planetaria (360px, una volta sola all'apertura): per ogni pixel dentro il disco si calcola la normale 3D `(dx, dy, √(1-d²))`, da cui **(lat, lon)** sferiche per campionare un **FBM 3D** hash-based (3 ottave); il colore di base è scelto per tipo (terrestre, desertico, oceanico, ghiacciato, vulcanico, forestale, gassoso, luna, cintura) con palette/dettagli specifici (bande+tempeste sui gassosi, crateri irregolari sulle lune, calotte polari sui ghiacciati, crepe di lava luminescenti sui vulcanici, atolli e profondità sull'oceanico).
  - **Shading sferico**: Lambert (N·L) + specular sul lato sub-stellare per mari/ghiacci + **limb darkening** + **terminatore** morbido. La direzione della luce viene dalla **posizione del corpo nel sistema** (`-x/|p|, -y/|p|, lz≈0.55`), così l'illuminazione è sempre coerente con dove sta la stella.
  - **Effetti extra:** nuvole stratificate (terrestri/oceanici/forestali), **luci notturne** (rete urbana) sui pianeti **colonizzati** (si attivano via `refresh(colony)` quando colonizzi), **anelli** procedurali sui gassosi (deterministici dal variant), **lune in orbita statica** intorno al pianeta principale (anche queste bakate, cliccabili → aprono la luna come pianeta).
  - **Performance:** il bake è ~360² pixel × 3-4 ottave di noise = ~150-300 ms una sola volta; il render runtime è un singolo `drawImage` + overlay leggero (atmosfera/glow). Render **on-demand** (no loop), zero costo a riposo.
- **`js/main.js` — integrazione.** Stato colonie in `ORION.game.colonies` (chiave `<sysId>:<bodyKey>`, delta serializzabile per M06). Al bootstrap il **mondo natale è auto-colonizzato** (`colonizeHomePlanet` riusa `homeWorld` di M03, popolazione iniziale +20% pop cap, stock di partenza per le prime costruzioni). `openPlanet/closePlanet`, **breadcrumb a 4 livelli** `Galassia › Gruppo › Sistema › Pianeta`, voce di navigazione *Pianeta* ora funzionante (apre il pianeta natale di default), pannello destro con **scheda M04 a 4 tab**: *Colonia* (stato/colonizzazione/valutazione), *Risorse* (potenziali, scorte, produzione/I, avanzate con identità mascherate finché manca lo scan, decisione #16), *Strutture* (slot, costruite, in coda, costruibili per categoria con costo+durata+prerequisiti), *Popolazione* (totale/cap + barre delle 5 classi §9.2). La **barra risorse HUD** è popolata sommando lo stock delle colonie attive (la produzione per Impulso arriva con M05).
- **`css/style.css`** — sezione M04: layer `.planet-holder`/`.planet-canvas` (z-index 2 sopra il sistema), tab della scheda, barre dei potenziali per risorsa con palette dedicata, struct-list per categoria con `<details>` apribili, classi funzionali colorate, bordo `--c-violet` per gli avvisi sulle avanzate.

**Note di scope:**
- **Confine con M05:** in M04 le strutture vengono **completate istantaneamente** al click (la riga viene aggiunta in coda da `startBuild` e poi subito promossa a "costruita" in `tryBuild` per ragioni di UI); allo stesso modo la colonizzazione di un secondo corpo è istantanea. Il **vero timer** (decremento Impulso per Impulso, processo della coda, produzione/consumo, crescita pop, scoperta avanzate dopo X Impulsi) arriva con M05. Quando M05 sarà attivo, basta togliere il `colony.queue.pop()` da `tryBuild` e lasciare il loop a maturare l'entry: tutta l'infrastruttura (`queue`, `duration`, `startedAt`) è già pronta.
- **Confine con M06:** lo stato della colonia è già un **delta serializzabile** con `schemaVersion: 1`. Niente da rifare.
- **Confine con M07:** la nebbia di guerra dei sistemi rimane invariata. La vista pianeta si apre solo per corpi del proprio sistema d'origine o di sistemi esplorati (l'hook esiste nel pannello *Corpo*: senza esplorazione il pannello stesso non mostra il pulsante).
- **Confine con M13:** i prerequisiti tech delle strutture esistono solo come marker `requires: ['tech:<id>']`, attualmente bloccano la costruzione (l'unica struttura realmente "tech-gated" in M04 è l'impianto esotico, gancio §7.2). Quando M13 attiverà i tech veri, l'impianto si sbloccherà di conseguenza.
- **Confine con M08/M14/M15/M16:** cantiere navale e accademia militare sono **ganci** — le funzioni vere arrivano con i rispettivi moduli; in M04 si costruiscono e occupano slot (e contano nelle classi), ma non producono navi/figure.

**Limiti per M04 (semplificazioni note):**
- Per le **cinture asteroidali** non si apre la vista pianeta (le si rappresenta nel sistema; il loro contributo arriverà come "stazione di estrazione orbitale" più avanti).
- Per i **gassosi** la vista si apre ma la colonizzazione è disabilitata (non abitabile §6.3); l'estrazione orbitale piena è un'estensione futura.
- Gli **upgrade di livello** delle strutture sono solo letti dal calcolo dei tassi (×1.6 per lvl) — il flusso di upgrade in coda è M05.

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
10. **Orbite statiche, render on-demand (M03).** Scelta dell'utente: nella vista interna i corpi restano in **posizioni fisse deterministiche dal seed** e il rendering è **on-demand** (nessun loop continuo) — coerente con l'impostazione di M02. L'eventuale rotazione orbitale animata è rimandata (candidato polish/M05 quando ci sarà il game loop). Vantaggio: zero costo CPU a riposo e nessun rischio di stato non deterministico.
11. **Nebbia di guerra dell'interno fedele a §5.1 (M03).** Scelta dell'utente: l'interno si rivela in base al livello di scoperta — **ESPLORATO** = corpi con dettagli completi (tipi §6.3, lune, anomalie); **RILEVATO** = stella + orbite con i corpi come sagome "da scansionare" (dettagli rimandati a **M07**); **UNKNOWN** = schermo bloccato. All'avvio il sistema d'origine è completo e i vicini mostrano il layout. La scoperta vera (muovere flotte) resta M07.
12. **Stella dell'interno coerente con M02 + designazione dei corpi (M03).** Il tipo di stella della vista interna **deriva** da quello già scelto in M02 (`galaxy.systems[id].star`), così il colore del nodo e l'interno coincidono. I corpi celesti ricevono una **designazione romana** sul nome del sistema (`Vega I`, `Vega II`…) e le lune un suffisso di lettera (`Vega II a`), convenzione 4X analoga a quella dei nomi-catalogo di M02 (decisione #7). Tutto deterministico (nessun costo di salvataggio).
13. **Valute regionali leggere (decisione per M12, integra GDD §15).** Il commercio del GDD §15 resta **baratto** come spina dorsale (risorsa↔risorsa, accordi diplomatici); in più si introduce una **moneta per regione** (riusa i gruppi stellari di M02, decisione #9), non una valuta galattica unica. Regole:
   - **1 valuta per regione**, con **nome a tema** della regione stessa (es. *Stilla di Vega*, *Lama Keth*, *Voto Serenthal*), generata dal seed.
   - **Si ottiene solo**: vendendo risorse *in* quella regione, completando missioni *per* civiltà di quella regione, o tramite **cambio** presso hub commerciali — il Sindacato Mekhari (§13.2) come banca naturale, con **spread legato a Reputazione §14**.
   - **Si spende solo**: per beni/tech/figure speciali **esclusivi** di quella regione (motivo unico per averla, non "soldi colorati").
   - **Le risorse fisiche §7 restano la spina dorsale**: la valuta integra il baratto §15 dove il baratto non funziona bene (servizi, accessi, contratti mercenari, mercato nero).
   - **Tassi di cambio dinamici** come vettore d'eventi §17 (guerra in regione → valuta crolla → opportunità).
   - **UI**: niente nuove voci nell'HUD fisso (resta a 4 risorse base + indici). Le valute vivono nel **pannello commercio** dedicato a M12, con possibile **overlay "mappa monetaria"** sulle regioni della mappa M02.
   - **Save (M06)**: bilancio per regione + tassi correnti come delta — gestibile con seed+delta (decisione #5).
   - Il GDD §15 andrà esteso prima dell'implementazione di M12 con questa versione *leggera* (non EVE-style).
14. **Vista Pianeta come layer Canvas full-stage (M04).** Scelta dell'utente: la vista pianeta si monta come **layer M03-style** dentro `.galaxy-root` (sopra il sistema, che resta vivo sotto). La scheda dati (risorse/strutture/popolazione/colonizzazione) **vive nel pannello destro** come per system/body. Vantaggi: gerarchia (#9) preservata, niente split del viewport, riuso dello stesso pattern di mount/destroy e degli stessi controlli (Pointer Events, ResizeObserver, breadcrumb).
15. **Catalogo strutture "medio" per M04 (~14 strutture).** Scelta dell'utente: 2-3 strutture per categoria §10.1 (4 estrattive base + 2 produttive + 2 ricerca + 2 militari + 3 civili + 1 avanzata). I prerequisiti tech sono **solo marker** (`requires: ['tech:<id>']`), bloccano la costruzione finché M13 non li attiverà. I cantieri/accademia/mercato sono **ganci** per i rispettivi moduli (M08/M14/M12). Vantaggio: M04 ha scelte di costruzione significative senza anticipare M13, e il catalogo può crescere senza rifare le scaffolding.
16. **Risorse avanzate §7.2 — numero rivelato, identità nascosta (M04).** Scelta dell'utente, coerente con §7.3 ("si scoprono costruendo strutture esplorative"): alla colonizzazione la scheda *Risorse* mostra "⚛ N risorse avanzate presenti — identità da scansionare". Costruire un **osservatorio** (struttura ricerca) attiva `colony.scanned.active = true` e svela le identità (`advancedKnown`). Le 6 famiglie §7.2 (cristalli, esotici, biomassa, gas nobili, dati, reliquie) hanno pesi per tipo di corpo (vulcanico→esotici/cristalli, gassoso→gasNobili/cristalli, ecc.). Ogni candidata ha un `potential` 30-100 (deterministico dal seed).
17. **Resa "tridimensionale" del pianeta — bake offscreen + shading sferico (M04).** Scelta dell'utente (più ricco del disco di M03, "diverso da pianeta a pianeta/luna"): la vista pianeta usa una **texture procedurale bakata** (offscreen canvas 360px) con **FBM 3D hash-based** campionato in coordinate sferiche, **shading sferico** (normale calcolata dal disco, Lambert + specular su mari/ghiacci + limb darkening + terminatore morbido), dettagli per tipo (nuvole, tempeste, crateri, calotte, lava, anelli), **luci notturne** dopo la colonizzazione. Il bake si fa **una sola volta** all'apertura (~150-300 ms), il render runtime è un `drawImage` + overlay leggero. Determinismo dal seed `<body.seed>:planet` (nessun costo di salvataggio). Niente WebGL, niente loop continuo — coerente con tutte le decisioni precedenti.

---

## Problemi aperti / da decidere più avanti

- Includere o meno il font Orbitron come asset locale (`/fonts`) in un modulo di polish (M20).
- Definire lo schema dello stato di gioco (game state) e il `schemaVersion` del save prima di M04/M05 (M02 ha già introdotto `schemaVersion: 1` per galassia/stato).
- Avviso "schermo troppo piccolo" sotto ~768px (decisione #6) ancora da implementare (candidato M20/polish).
- Estendere **GDD §15 Commercio** con la versione *leggera* delle valute regionali (decisione #13) prima dell'implementazione di **M12**: nome generato dal seed, regole di acquisizione/spesa esclusive per regione, hub di cambio (Mekhari), tassi dinamici come vettore eventi §17. Nessun impatto su M04–M11.

---

## Struttura file attuale

```
stargame/
├── index.html          ✅ shell UI + caricamento moduli M02/M03/M04
├── css/
│   └── style.css        ✅ tema scuro spaziale + mappa/galassia (M02) + vista sistema (M03) + scheda pianeta (M04)
├── js/
│   ├── rng.js           ✅ PRNG deterministico (M02 — seed+delta)
│   ├── names.js         ✅ nomi sistemi §5.2 (M02)
│   ├── galaxy.js        ✅ generazione galassia + stato/delta (M02)
│   ├── galaxy-map.js    ✅ mappa a nodi su Canvas (M02)
│   ├── system.js        ✅ generazione interno del sistema §6 (M03 — derivato dal seed)
│   ├── system-view.js   ✅ vista interna del sistema su Canvas (M03)
│   ├── structures.js    ✅ catalogo strutture §10 (M04, 14 voci, 6 categorie)
│   ├── planet.js        ✅ data model pianeta §6.2/§7/§8/§9 + delta colonia (M04)
│   ├── planet-view.js   ✅ vista pianeta su Canvas — sfera bakata, FBM 3D + shading sferico (M04)
│   └── main.js          ✅ bootstrap + integrazione M02/M03/M04
├── CLAUDE.md            ✅ questo file
├── README.md            ✅
└── ORION_EMPIRES_GDD.md ✅ documento di design (fonte di verità)
```

Gli altri file/cartelle previsti dal GDD §2 (`js/fleet.js`, `data/`, ecc.)
verranno aggiunti nei moduli corrispondenti.

---

_Ultimo aggiornamento: 2026-06-04 — M04 Pianeta base: vista pianeta su Canvas (`planet-view.js`) come **sfera procedurale bakata** (FBM 3D hash-based campionato in coordinate sferiche, shading Lambert + specular + limb darkening + terminatore morbido, dettagli per tipo, luci notturne dopo colonizzazione), scheda M04 a 4 tab nel pannello destro (Colonia/Risorse/Strutture/Popolazione), catalogo 14 strutture su 6 categorie (`structures.js`), data model pianeta con seed+delta (`planet.js`): struttura immutabile (potenziali §7.1, slot §10.2, popCap §9, candidate avanzate §7.2 nascoste fino a osservatorio §7.3, costo colonizzazione §6.2), stato colonia con `schemaVersion: 1` pronto per M06. Mondo natale auto-colonizzato al boot con bonus pianeta base §8.1 (+20%). Breadcrumb a 4 livelli `Galassia › Gruppo › Sistema › Pianeta` e voce di navigazione *Pianeta* attiva. Scelte utente: layer Canvas full-stage (decisione #14), catalogo medio ~14 strutture (decisione #15), numero rivelato/identità nascosta per avanzate (decisione #16), resa "tridimensionale" via bake offscreen + shading sferico (decisione #17). Tassi-per-Impulso e durate-in-Impulsi definiti; l'avanzamento effettivo nel tempo è M05. Resta ⏸️ in attesa di conferma utente._
