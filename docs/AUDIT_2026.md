# Audit Revisione 2026 — Fase 0

> 2026-11-20 · branch `ccr-ebe5f6a7-lkggtd` · HEAD = main dopo PR #357 (schema 32).
> Sola lettura: nessun file di gioco modificato. Quattro passate parallele (architettura,
> duplicazioni, rendering/prestazioni, CSS/UI) + screenshot Playwright (1920×1080, 1440×900, 1024×768).
> Certezza: **[C]** certo (misurato/verificato nel codice) · **[P]** probabile · **[I]** ipotesi.
> Decisioni di riferimento: sezione "Revisione 2026" di `CLAUDE.md`.

---

## 0. Sintesi in 8 punti

1. **La simulazione è già quasi pura.** Tutti i moduli tranne `main.js` si caricano in Node senza DOM e `time.advance` gira [C]. Il debito vero è in `main.js` (19.7k righe) e nel CSS.
2. **La UI costa ~99% di ogni Impulso.** Sim 0.13–0.17 ms/tick; `runAdvance` 45–77 ms in jsdom (proporzione, non assoluto). Plancia dx e sx vengono ridisegnate **2 volte per Impulso** [C].
3. **Bug reali emersi** (sez. 5): presidi persi al reload (B1, verificato), flotte IA che usano l'Iperguida del giocatore (B3, verificato), probabilità d'incidente mostrata ≠ usata (B4).
4. **Niente livello comandi:** 95 `persistGame()` = 95 punti in cui la UI muta `ORION.game` direttamente, con regole di gioco inline (costo coloni, tributo d'assedio, rinomina flotte) [C]. Blocca il golden replay.
5. **Stato duplicato a mano in 4 posti** (default in newGame · serialize · migrate · restore campo-per-campo) — causa diretta di B1 [C].
6. **Rimovibile subito o col reset save:** ~1.500 righe di migrazioni/legacy + ~470 righe layout telefono + ~550 righe CSS morto [C/P].
7. **Sistema visivo frammentato:** 2 palette che convivono (token ≠ UI_GUIDE), 72 font-size distinti, ~1.400 colori hardcoded, 20 famiglie di chip, 14 overlay con scrim diversi, variabili CSS usate ma mai definite (`--c-text-dim` ×25 → colore silenziosamente ereditato) [C].
8. **Grafica:** il Canvas 2D è al suo limite espressivo (glow = `shadowBlur`, nebulose piatte, sfera pianeta statica bakeata in **271 ms** sul main thread). Il guadagno di PixiJS è **qualità a parità di costo**, non FPS (galassia di soli 80–120 sistemi) [C/P].

---

## 1. Architettura

### 1.1 `main.js` — cosa contiene (estratto)

| Righe | Contenuto | Natura |
|---|---|---|
| 671-1150 | `newGame` + **idratazione save campo-per-campo** (846-1010) | logica fuori posto |
| 2224-4370 | Vista Pianeta (7 tab) + **colonizzazione** (3441-3960, costi inline) | UI + logica |
| 8061-8968 | Guerra/assedi: `siegeTributeCost`, `handleSiegeTribute` muta `truceUntil` | UI + logica |
| 10355-10750 | Helper flotta + `maybeAutoRenameFleet` (muta `fleet.name`) | UI + logica |
| 10751-12432 | Dettaglio flotta (~1.680 righe in un pannello) | UI |
| 13028-13857 | Loop di gioco, autopausa, `runAdvance` | app loop |
| 13858-14731 | `chronicleEvent`: evento → HTML (~870 righe) | presentazione |
| 18557-19083 | Save/cloud modal, `migrateLegacyCrewIds`, `enterGame` | I/O + migrazione |
| 19549-19732 | Navigazione mobile (eliminabile) + boot | UI |

~55 proprietà volatili di stato UI appese a `ORION` (`openPlanetKey`, `dxTab`, `_currentView`…) e preferenze su 4 chiavi `localStorage` diverse [C].

**Scomposizione proposta** (dettaglio nel report architetturale, sintesi):
`sim/newgame` · `sim/hydrate` · `sim/commands/{colonize,siege,fleetNaming,…}` · `app/loop` · `app/invalidate` · `ui/store` · `ui/prefs` · `ui/chronicle/{classify,format,store}` · `ui/views/*` · `ui/panels/*` · `ui/popups/*` · `ui/{journal,save-modal,main-menu}`.

### 1.2 Dipendenze
- Nessun modulo usa un altro al load: l'ordine degli `<script>` è già violato (fleet usa time/ai/combat caricati dopo) e funziona solo per binding pigro [C]. → In ES modules usare `import * as X`, non destructuring.
- Cicli: nucleo fortemente connesso `ai ↔ fleet ↔ diplomacy ↔ combat ↔ time`; anche `save ↔ cloud`, `diplomacy ↔ reputation` [C].
- Strati invertiti: `time.currentDSHtml` restituisce markup; `fleet.CLASS_ICON` colori hex; `tutorial.js` mescola stato e DOM; `crew-roster.js` è UI caricata tra la logica [C].
- Global invece di parametro: `time.advance()` non prende `game` (2562), `fleet.js:482`, `trade.js:201` [C].

### 1.3 Moduli di simulazione sovradimensionati
- `time.js`: orchestratore di ~30 sottosistemi **e** proprietario di economia colonie (~800 righe) e guerra/assedi (~1.000 righe) [C]. → `colony-econ`, `warfare`, `tick-pipeline` con fasi esplicite.
- `fleet.js` (3.6k): pathing + logistica + manutenzione + ordini + colonizzazione + dati visuali [C].
- `ai.js`: generazione civ + intel + guerra + stima forze [C].

### 1.4 Bloccanti per il golden replay
1. Creare una partita richiede `main.js` [C].
2. I comandi del giocatore non hanno API [C].
3. `runAdvance` muta lo stato dopo il tick (`dispatch.recordMemoria`, main.js:13802) → headless ≠ UI [C].
4. `game.chronicle` salva **stringhe HTML** [C].
5. La selezione UI (`state.selectedId`) finisce nel save [C].

---

## 2. Logiche duplicate e stato parallelo

| Concetto | Varianti | Note |
|---|---|---|
| Durata viaggio | **5** (fleet reale, stima wizard, aifleet, stima UI con 1.1 hardcoded, expedition legacy) | la stima del wizard ignora Navigatore/FSP → diverge dal reale [C] |
| BFS sul grafo | 7+ (fleet ×3, station, anomaly ×2, main) | → `graph.bfs` unico [C] |
| Assedio colonia vs stazione | copia-incolla ~80 righe con **2 divergenze** (chi conta, esito al cap 12 round) | divergenze probabilmente non volute [P] |
| Potenza `hp + fp×8` | 3 (+1 senza veteranità) | [C] |
| canPay/pay stock | 6 (una clampa a 0, le altre no); 33 scritture dirette `stock[k]=` | [C] |
| Reputazione | 3 canali di scrittura; colony-figure salta storico e soglie | default 50 hardcoded 10+ volte [C] |
| ICG / disposizione / relazione | 7 / 4+22 / ~17 punti di scrittura senza setter | [C] |
| Helper "presenza giocatore nel sistema" | 6 con semantiche leggermente diverse | [C] |

**Stato parallelo** [C]: S1 lista campi in 4 posti · S2 `civ.planets`/`civ.systems` · S3 `ships[kind]` vs `shipReserve` · S4 colonizzazione in 4 strutture · S5 identità home in 5 campi · S6 sistema in `systemId` + prefisso chiave (parsing ripetuto 36 volte) · S7 `commander` legacy + `officers[]`.

**Utility non consolidate** [C]: `civById` ×5 (+~65 find inline), `sysName` ×10, clamp inline ×81 (vs 7 usi di `util.clamp`), `pickWeighted` ×4, **4 hash di stringa diversi** (unificarli cambia gli esiti → decisione di gameplay, non refactor).

---

## 3. Rendering e prestazioni

### 3.1 Canvas (contatori su contesto finto, 1280×760) [C]
| Vista | JS/frame | Note |
|---|---|---|
| Galassia | 1.5–2.0 ms | 14 gradienti radiali + 32 lineari, 346 fillRect, `shadowBlur` per nodo, testo stroke+fill per etichetta |
| Sistema | 1.1 ms | pianeti vettoriali ridipinti ogni frame, RNG ricreato ogni frame |
| Pianeta | 0.5 ms dopo bake | **bake sfera 271 ms**, `openPlanet` 370–550 ms sul main thread |

- Costi GPU/raster nascosti: `shadowBlur`, gradienti grandi in `lighter` a DPR 2 [P]; **33 `backdrop-filter`** sopra un canvas che si ridisegna → probabile collo su tablet [I].
- La mappa si ridisegna a **ogni Impulso** via `persistGame` anche se nulla di visibile è cambiato [C].

### 3.2 PixiJS — dove rende
| Vista | Riusabile | Da riscrivere | Guadagno |
|---|---|---|---|
| **planet-view** | interazione minima | noise → shader GLSL (~400 righe) | **massimo**: sfera rotante, nuvole animate, atmosfera, zero blocco 271 ms, risoluzione libera |
| galaxy-map | proiezione/camera/input/picking ~1.100 righe | `_draw*` ~1.650 righe | bloom, nebulose a rumore, rotte animate, BitmapText |
| system-view | ~500 righe | ~1.000 righe | pianeti/corone in shader |

→ **Pilota consigliato: planet-view** (isolato, rischio minimo, salto visivo più evidente), poi galaxy-map. (Correzione rispetto alla proposta iniziale "pilota = galassia".)

### 3.3 UI DOM [C]
- Pattern: stringa HTML → `innerHTML` → riaggancio listener (356 `addEventListener`, 168 `querySelectorAll().forEach` in main.js).
- Per Impulso con pianeta aperto: 2× `renderDxPanel`, 2× `renderLeftPanel` (40/41 in 20 tick).
- La plancia dx si ricostruisce a ogni Impulso **senza preservare scroll/focus/select aperti** → interazione disturbata col tempo che scorre [P].
- `renderDxPanel` modifica temporaneamente i global `openPlanetKey/currentPlanet/planetTab` per riusare un altro renderer [C].

### 3.4 Simulazione [C]
- 5000 tick: media 0.13–0.17 ms, p99 < 0.81 ms. Top: `ai.tick`, `aifleet.tick`, `system.generate` (rigenerato dal seed ogni tick per ogni colonia, senza memo), `cohesion.tick`.
- Autosave a **ogni Impulso** (+ push cloud schedulato).
- Manca un benchmark di fine partita con giocatore attivo [C].

---

## 4. CSS e sistema visivo

- `style.css` 10.041 righe / 2.378 regole, ordinato per **cronologia dei moduli**, non per livello [C].
- **Token:** 39 definiti, 6 morti. Valori letterali: 756 rgba + 669 hex (vs 108 `rgb(var())`); `--c-accent` riscritto a mano 144 volte [C].
- **Scale assenti:** 72 font-size distinti (UI_GUIDE ne prevede 7), 51 sotto il floor 0.70rem; 183 valori di spaziatura; 27 radius; 62 ombre; 23 z-index [C].
- **Variabili mai definite:** `--c-text-dim` (25 usi senza fallback), `--c-amber`, `--c-muted`, `--font-mono`… → dichiarazioni invalide [C].
- **Due palette:** UI_GUIDE dice ambra `#f0a868`, verde `#6fe0b8`…; i token dicono `#ff9d3c`, `#4fe08a`… ed entrambe sono usate [C].
- **Classi morte:** 82 (~550 righe), incluso tutto `fleet-wizard__*` e il "canonico" `.lp-section__head` di UI_GUIDE §6 [P].
- **Varianti dello stesso componente** [C]: chip 20 famiglie · badge 14 · header di sezione 42 · card/item 28 · overlay 14 (scrim e blur tutti diversi) · bottoni 13 modificatori + 39 classi parallele · stati `is-ok`/`--ok`/`--good`/`--bad`/`--danger` mescolati.
- **Icone:** catalogo SVG sano (79 icone), ma 460 glyph Unicode ancora nel markup, di cui 33 emoji vietati da §3; `uiIcon()` implementato 3 volte [C]. Il subset font non copre il greco (Ω Φ Κ Ι) [P].
- `!important` solo 6, specificità sana: il problema è la **dispersione**, non la cascata [C].

### 4.1 Osservazioni dagli screenshot
- **1920×1080** (`audit-2026/desktop-galassia.png`): layout regge, mappa ~60% larghezza. Galassia piatta (wireframe + etichette), usa metà dell'area utile.
- **1440×900** (`1440-pianeta.png`, `1440-dashboard-overlap.png`): testi sovrapposti (titolo pianeta/briciole, "POPOLAZ."/"MORALE" in dashboard, etichette regioni), popup contestuale sopra il pannello popolazione.
- **1024×768 tablet** (`tablet-sistema.png`): sidebar ≈ 2/3 dello schermo, mappa ~260px, risorse sparite dall'header → **layout tablet da ripensare** (sidebar collassabili / a overlay).
- Rumore visivo: riquadri dentro riquadri, Orbitron usato anche su testo corrente, emoji mescolati a SVG.

---

## 5. Bug emersi (da correggere prima o durante la Fase 1)

| # | Bug | Stato | Effetto |
|---|---|---|---|
| B1 | `game.garrisons` non serializzato né ripristinato | **[C] verificato** | presidi persi a ogni reload |
| B2 | `game.occupations` cancellato da `garrison.ensure` ma ancora serializzato/letto dalla UI | [C] | stato zombie |
| B3 | `fleet.tempoLeg` legge `hyperMul(ORION.game)` → usato anche da `aifleet.legEta` | **[C] verificato** | flotte IA accelerate dall'Iperguida del giocatore |
| B4 | Esplorazione mostra `expedition.accidentChance` (modello M07), il tiro usa `fleet._accidentChanceForTravel` | [C] | probabilità mostrata ≠ reale |
| B5 | `research.payerColonyKey` usa `homePlanetKey`, il commento e `dispatch` usano la capitale | [C] | pagatori diversi se la capitale si sposta |
| B6 | `--c-text-dim`, `--c-amber` mai definite | [C] | ~30 dichiarazioni colore invalide (focus outline invisibile a `style.css:9980`) |

B3 e la risoluzione delle divergenze d'assedio **cambiano il gameplay** → decisione esplicita dell'utente, fuori dal "gameplay congelato".

**Stato (Fase 1, 2026-11-20):** B1–B6 corretti con test (`tests/sim.test.mjs`). Emerso durante il lavoro:
B7 — le 4 fazioni "Costanti" nascevano dopo la normalizzazione delle civiltà e ricevevano i default
(`knowledge`, `interactions`, `phaseSince`) solo al primo load → stato diverso prima/dopo un reload. Corretto;
il test di round-trip save (3 seed × 2000 Impulsi) ora lo impedisce. Nota B4: lo scarto era grande
(pericolo 24: mostrato 5%, reale 45%) → la calibrazione del rischio reale è materia di bilanciamento (M20).

---

## 6. Sicurezza / esterni

- `js/cloud.js` contiene URL + chiave anon Supabase in chiaro, senza auth; **il repository è pubblico** [C]. Chiunque può leggere (e, a seconda delle policy RLS non verificate, scrivere) la tabella `saves` [P]. Rischio basso (solo save di gioco) ma da decidere: tenerlo, proteggerlo, o toglierlo col reset.
- Il cloud è anche l'unica chiamata esterna a runtime, in contrasto con il vecchio principio "no chiamate esterne" [C].

---

## 7. Piano proposto (ordine aggiornato dall'audit)

**Fase 1 — Fondamenta (nessun cambio visibile)**
1. Vite + struttura `src/`, deploy GitHub Action (Settings → Pages → "GitHub Actions": click manuale dell'utente).
2. `time.advance(game, n)` con parametro esplicito; `recordMemoria` dentro la pipeline del tick.
3. `sim/newgame` estratto da `main.js`; harness Vitest headless; **golden replay** (seed + comandi → hash stato).
4. Fix B1, B2, B4, B5, B6 (non cambiano il gameplay inteso). B3 in attesa di decisione.

**Fase 2 — Schema pulito e potatura**
5. Nuovo schema save: un unico descrittore campi→default usato da newGame/serialize/load (elimina S1). Cronaca salvata come `{kind,data}`, niente HTML né selezione UI nel save.
6. Rimozione catena `migrate` + rami legacy (~1.500 righe), layout telefono (~470), CSS morto (~550).
7. Livello comandi `sim/commands/*`; consolidamento utility (`graph.bfs`, `legDuration`, `canPay/pay`, façade rep/ICG/disposizione/relazione).

**Fase 3 — Sistema visivo**
8. Decisione palette unica + token di scala (`--fs-*`, `--sp-*`, `--radius-*`, `--z-*`, `--scrim`, `--shadow-*`) esportati anche verso JS/Pixi. Aggiornamento `UI_GUIDE.md`.
9. Split CSS per livello (tokens/base/layout/components/views).
10. Layout tablet ripensato (sidebar collassabili).

**Fase 4 — Grafica WebGL**
11. Pilota PixiJS su **planet-view** (shader), poi galaxy-map, poi system-view.

**Fase 5 — UI a componenti**
12. Preact: prima i componenti più duplicati (Chip/Badge, Overlay, SectionHead, ItemCard, Button), poi plancia dx (render incrementale, stato preservato), sx, viste.

---

## 7b. Stato Fase 2 (2026-11-20)

Fatto: layout telefono rimosso · schema save 100 con `STATE_FIELDS` unico (save.js 1045→432 righe), migrazioni
e rami legacy rimossi (sistemi V1, spedizioni M07, migrazioni comandanti/diario/vittoria/anomalie/governatore,
colonizzazione senza flotta) · motore d'assedio unico (cap 12 round uniformato, scenari in `tests/siege.test.mjs`)
· `js/commands.js` (colonizzazione, tributo) + `js/fleet-naming.js` · `galaxy.bfsPath`, `util.civById`.
Netto: circa −2.600 righe JS/CSS/HTML.

Rimandato (motivo): cronaca come `{kind,data}` (tocca ~870 righe di formattazione UI, meglio con Preact) ·
`legDuration` unico (cambia le probabilità d'incidente reali: decisione di gameplay) · `canPay/pay` unico (6 varianti
con semantiche diverse di clamp) · façade unica reputazione/ICG/disposizione · scomposizione `main.js`/`time.js`.

## 7c. Viaggi e incidenti (2026-11-21)

Simulazione su 1130 destinazioni (20 partite) + 160 viaggi reali: un incidente è quasi sempre lieve
(ritardo 50%, usura 30%, critico 15% → perdita scafo solo se pericolo > 50, scoperta bonus 5%). Perdita scafo per
viaggio: 0% a 1-2 salti, 0,4% a 3, 1,6% a 4, 5,6% a 6.
- **A ✅** scheda Esplorazione: "Rischio incidente" + "Perdita scafo" separati, dettaglio esiti nel tooltip.
- **B ✅** `fleet.legDuration` = unica durata (classe + Iperguida + Navigatore + deriva + FSP) per viaggio reale e
  tutte le stime (`routeImpulsi` → wizard, viveri, rischio). Il Navigatore ora riduce anche il rischio.
- **C → M20** ritaratura: tetto 55% raggiunto a 3-4 salti (oltre la distanza non conta), esperienza equipaggio
  quasi ininfluente (max −20%).

## 8. Decisioni utente (2026-11-20)

1. **B3 (Iperguida IA):** ✅ correggere — `tempoLeg` riceve il moltiplicatore come parametro; le IA non beneficiano più della tech del giocatore. Cambio di gameplay accettato.
2. **Assedio colonia vs stazione:** ✅ unificare in un unico motore parametrico (al cap dei 12 round confronto hp anche per le stazioni; da riconfermare in fase di implementazione).
3. **Cloud Supabase:** ✅ tenere così com'è.
4. **Palette:** ✅ **E · Plancia** (scelta utente). Grafite neutra quasi monocroma, colore solo per stati/concetti, nessun glow.
   Valori di partenza (Fase 3): fondo `#0b0e13` · fondo 2 `#10141a` · pannello `#151a21` · pannello 2 `#1d242d` ·
   bordo `rgba(170,190,210,.26)` / morbido `.12` · testo `#e8edf2` / 2° `#aab4bf` / tenue `#808b97` ·
   accento/galassia `#5cc8d6` · sistema/colonia `#e3a35f` · gruppo/ricerca `#a493f0` · pianeta/info `#74aee0` ·
   buono `#63c98f` · allerta `#dcbc5b` · critico `#e2697a` · raggio 5px.
   Ritocco utente (2026-11-27): pannelli grigio scuro `#24282f`, centro vista blu-ardesia `44 58 84 → 26 34 50`, testo tenue `#8f99a5`.
