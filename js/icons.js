/* =====================================================================
   ORION EMPIRES — icons.js
   Catalogo icone SVG inline (UI_GUIDE.md §3, strategia B).

   Stile: stroke-based, viewBox 24×24, stroke-width 2, linecap/linejoin
   round. Tutti i path usano `currentColor` come stroke → il colore viene
   dal CSS della classe contenitore (.ui-icon--<concetto>). Il glow è
   un `filter: drop-shadow(0 0 4px currentColor)` applicato all'`<svg>`.

   Set: Lucide-style (ISC license, ispirazione diretta) — paths
   semplificati e adattati al nostro mood. Niente dipendenza esterna,
   solo stringhe SVG inline.

   Uso:
     <span class="ui-icon ui-icon--roster" aria-hidden="true">
       <!-- ORION.icon('roster') -->
     </span>

   API:
     ORION.icon(name)                  ritorna la stringa SVG
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  /* SVG wrapper: tutte le icone sono 24×24, stroke currentColor 2px. */
  function svg(inner) {
    return '<svg class="ui-icon-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ' +
      'width="1em" height="1em" ' +
      'fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
  }

  const ICONS = {
    /* Roster — palazzo/colonia (più piani, finestre). */
    roster: svg(
      '<rect x="4" y="3" width="16" height="18" rx="1.5"/>' +
      '<line x1="9" y1="7" x2="9" y2="7.01"/>' +
      '<line x1="15" y1="7" x2="15" y2="7.01"/>' +
      '<line x1="9" y1="11" x2="9" y2="11.01"/>' +
      '<line x1="15" y1="11" x2="15" y2="11.01"/>' +
      '<line x1="9" y1="15" x2="9" y2="15.01"/>' +
      '<line x1="15" y1="15" x2="15" y2="15.01"/>' +
      '<path d="M10 21v-3h4v3"/>'
    ),

    /* Galassia — orbite ellittiche incrociate (concetto: disco galattico). */
    galaxy: svg(
      '<ellipse cx="12" cy="12" rx="10" ry="4"/>' +
      '<ellipse cx="12" cy="12" rx="4" ry="10"/>' +
      '<circle cx="12" cy="12" r="1.5" fill="currentColor"/>'
    ),

    /* Gruppo stellare — esagoni/cluster di stelle. */
    group: svg(
      '<circle cx="7" cy="8" r="1.5" fill="currentColor"/>' +
      '<circle cx="17" cy="8" r="1.5" fill="currentColor"/>' +
      '<circle cx="12" cy="14" r="1.5" fill="currentColor"/>' +
      '<circle cx="7" cy="18" r="1.5" fill="currentColor"/>' +
      '<circle cx="17" cy="18" r="1.5" fill="currentColor"/>' +
      '<path d="M7 8L12 14L17 8" opacity="0.5"/>' +
      '<path d="M7 18L12 14L17 18" opacity="0.5"/>'
    ),

    /* Sistema stellare — sole con corona di raggi. */
    system: svg(
      '<circle cx="12" cy="12" r="4"/>' +
      '<line x1="12" y1="2" x2="12" y2="4"/>' +
      '<line x1="12" y1="20" x2="12" y2="22"/>' +
      '<line x1="2" y1="12" x2="4" y2="12"/>' +
      '<line x1="20" y1="12" x2="22" y2="12"/>' +
      '<line x1="4.93" y1="4.93" x2="6.34" y2="6.34"/>' +
      '<line x1="17.66" y1="17.66" x2="19.07" y2="19.07"/>' +
      '<line x1="4.93" y1="19.07" x2="6.34" y2="17.66"/>' +
      '<line x1="17.66" y1="6.34" x2="19.07" y2="4.93"/>'
    ),

    /* Pianeta — globo con meridiani. */
    planet: svg(
      '<circle cx="12" cy="12" r="9"/>' +
      '<path d="M3 12h18"/>' +
      '<path d="M12 3a14 14 0 0 1 0 18"/>' +
      '<path d="M12 3a14 14 0 0 0 0 18"/>'
    ),

    /* Flotta — nave/freccia direzionale. */
    fleet: svg(
      '<path d="M3 11l18-8-8 18-2-8-8-2z"/>'
    ),

    /* Diplomazia — bandiera. */
    diplomacy: svg(
      '<line x1="5" y1="22" x2="5" y2="4"/>' +
      '<path d="M5 4h12l-2 4 2 4H5"/>'
    ),

    /* Civiltà — gruppo persone. */
    civ: svg(
      '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>' +
      '<circle cx="9" cy="7" r="3"/>' +
      '<path d="M22 21v-2a4 4 0 0 0-3-3.87"/>' +
      '<path d="M16 3.13a4 4 0 0 1 0 7.75"/>'
    ),

    /* Ricerca — atomo (nucleo + orbitali). */
    research: svg(
      '<circle cx="12" cy="12" r="1.5" fill="currentColor"/>' +
      '<ellipse cx="12" cy="12" rx="10" ry="4"/>' +
      '<ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)"/>' +
      '<ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(-60 12 12)"/>'
    ),

    /* Mercato — bilancia/scambio. */
    market: svg(
      '<path d="M7 7h11"/>' +
      '<polyline points="14,3 18,7 14,11"/>' +
      '<path d="M17 17H6"/>' +
      '<polyline points="10,13 6,17 10,21"/>'
    ),

    /* Cronaca — pergamena con righe di testo. */
    chronicle: svg(
      '<path d="M4 4h12a3 3 0 0 1 3 3v10a3 3 0 0 0 3 3H7a3 3 0 0 1-3-3z"/>' +
      '<line x1="8" y1="9" x2="14" y2="9"/>' +
      '<line x1="8" y1="13" x2="14" y2="13"/>' +
      '<line x1="8" y1="17" x2="11" y2="17"/>'
    ),

    /* Build — martello/chiave. */
    build: svg(
      '<path d="M14.7 6.3a4 4 0 0 0-5.66 5.66l-7 7 2.83 2.83 7-7a4 4 0 0 0 5.66-5.66l-2.12 2.12-1.42-1.41 2.12-2.12z"/>'
    ),

    /* Pin — puntina. */
    pin: svg(
      '<line x1="12" y1="17" x2="12" y2="22"/>' +
      '<path d="M5 17h14l-2-5V5a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7l-2 5z"/>'
    ),

    /* Info — cerchio con i. */
    info: svg(
      '<circle cx="12" cy="12" r="10"/>' +
      '<line x1="12" y1="16" x2="12" y2="12"/>' +
      '<line x1="12" y1="8" x2="12.01" y2="8"/>'
    ),

    /* Menu — tre puntini (overflow "altro", barra mobile). */
    menu: svg(
      '<circle cx="5" cy="12" r="1.6"/>' +
      '<circle cx="12" cy="12" r="1.6"/>' +
      '<circle cx="19" cy="12" r="1.6"/>'
    ),

    /* Settings — ingranaggio. */
    settings: svg(
      '<circle cx="12" cy="12" r="3"/>' +
      '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'
    ),

    /* Save — disco. */
    save: svg(
      '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>' +
      '<polyline points="17,21 17,13 7,13 7,21"/>' +
      '<polyline points="7,3 7,8 15,8"/>'
    ),

    /* Resources — barili/canisters impilati (estrattive/economia). */
    resources: svg(
      '<ellipse cx="12" cy="5" rx="9" ry="3"/>' +
      '<path d="M3 5v6c0 1.7 4 3 9 3s9-1.3 9-3V5"/>' +
      '<path d="M3 11v6c0 1.7 4 3 9 3s9-1.3 9-3v-6"/>'
    ),

    /* Forces — scudo militare (Forze e reclutamento). */
    forces: svg(
      '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'
    ),

    /* Home — casa (alternativa a roster per "colonia in focus"). */
    home: svg(
      '<path d="M3 12l9-9 9 9"/>' +
      '<path d="M5 10v10a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V10"/>'
    ),

    /* Warning — triangolo allerta. */
    warning: svg(
      '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>' +
      '<line x1="12" y1="9" x2="12" y2="13"/>' +
      '<line x1="12" y1="17" x2="12.01" y2="17"/>'
    ),

    /* Spionaggio — occhio. */
    spy: svg(
      '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>' +
      '<circle cx="12" cy="12" r="3"/>'
    ),

    /* Close — X per chiudere modali/overlay. */
    close: svg(
      '<line x1="6" y1="6" x2="18" y2="18"/>' +
      '<line x1="18" y1="6" x2="6" y2="18"/>'
    ),

    /* Play — triangolo destro per riprendere/lanciare. */
    play: svg(
      '<polygon points="6,4 20,12 6,20" fill="currentColor" stroke="none"/>'
    ),

    /* ChevronRight — freccia compatta per "Avanza/Apri ▸". */
    chevronRight: svg(
      '<polyline points="9,6 15,12 9,18"/>'
    ),

    /* Send — aeroplano/paper-plane per "Invia spedizione". */
    send: svg(
      '<path d="M22 2L11 13"/>' +
      '<polygon points="22,2 15,22 11,13 2,9 22,2"/>'
    ),

    /* Sword — gladio per battaglia/attacco. */
    sword: svg(
      '<polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5"/>' +
      '<line x1="13" y1="19" x2="19" y2="13"/>' +
      '<line x1="16" y1="16" x2="20" y2="20"/>' +
      '<line x1="19" y1="21" x2="21" y2="19"/>'
    ),

    /* Trophy — coppa per vittoria. */
    trophy: svg(
      '<line x1="6" y1="9" x2="6" y2="6"/>' +
      '<line x1="18" y1="9" x2="18" y2="6"/>' +
      '<path d="M6 9a6 6 0 0 0 12 0"/>' +
      '<path d="M10 21h4"/>' +
      '<path d="M12 17v4"/>' +
      '<path d="M2 6h4"/>' +
      '<path d="M18 6h4"/>'
    ),

    /* Star — stella riempita per "home/capitale/preferito". */
    star: svg(
      '<polygon points="12,2 15,8.5 22,9.3 17,14 18.5,21 12,17.5 5.5,21 7,14 2,9.3 9,8.5" fill="currentColor" stroke="none"/>'
    ),

    /* Dot-circle — cerchio con punto interno (colonia attiva, status). */
    dotCircle: svg(
      '<circle cx="12" cy="12" r="9"/>' +
      '<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>'
    ),

    /* Transition — cerchio puntinato per "in transizione". */
    transition: svg(
      '<circle cx="12" cy="12" r="9" stroke-dasharray="3 3"/>'
    ),

    /* Pause — due barre verticali (HUD time controls). */
    pause: svg(
      '<rect x="6" y="4" width="4" height="16" fill="currentColor" stroke="none"/>' +
      '<rect x="14" y="4" width="4" height="16" fill="currentColor" stroke="none"/>'
    ),

    /* Step — triangolo + barra verticale (singolo Impulso, ⏵Ι). */
    step: svg(
      '<polygon points="5,4 16,12 5,20" fill="currentColor" stroke="none"/>' +
      '<line x1="19" y1="5" x2="19" y2="19"/>'
    ),

    /* SkipNext — due triangoli + barra ("Prossimo evento", ⏭). */
    skipNext: svg(
      '<polygon points="5,4 13,12 5,20" fill="currentColor" stroke="none"/>' +
      '<polygon points="13,4 19,12 13,20" fill="currentColor" stroke="none"/>'
    ),

    /* Folder — cartella aperta (Carica partita da slot). */
    folder: svg(
      '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'
    ),

    /* Plus — segno + per "nuovo" (nuova partita, espandi modulo). */
    plus: svg(
      '<line x1="12" y1="5" x2="12" y2="19"/>' +
      '<line x1="5" y1="12" x2="19" y2="12"/>'
    ),

    /* Trash — cestino per smantellamento. */
    trash: svg(
      '<polyline points="3,6 5,6 21,6"/>' +
      '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>' +
      '<path d="M10 11v6"/>' +
      '<path d="M14 11v6"/>' +
      '<path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>'
    ),

    /* Refresh — freccia circolare per "richiama/aggiorna". */
    refresh: svg(
      '<polyline points="23 4 23 10 17 10"/>' +
      '<polyline points="1 20 1 14 7 14"/>' +
      '<path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/>' +
      '<path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"/>'
    ),

    /* Crown — corona per Comandante/leader (alternativa a star). */
    crown: svg(
      '<polygon points="2 18 5 7 12 12 19 7 22 18 2 18" fill="currentColor" fill-opacity="0.15"/>' +
      '<polygon points="2 18 5 7 12 12 19 7 22 18 2 18"/>'
    ),

    /* Tag — etichetta/tag (slot save, metadata). */
    tag: svg(
      '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>' +
      '<line x1="7" y1="7" x2="7.01" y2="7"/>'
    ),

    /* Clock — orologio per timestamp save. */
    clock: svg(
      '<circle cx="12" cy="12" r="10"/>' +
      '<polyline points="12 6 12 12 16 14"/>'
    ),

    /* Check — segno di spunta (tutorial "vista", azione completata). */
    check: svg(
      '<polyline points="20 6 9 17 4 12"/>'
    ),

    /* Grid — quattro celle (Dashboard Impero, vista d'insieme colonie). */
    grid: svg(
      '<rect x="3" y="3" width="7" height="7" rx="1"/>' +
      '<rect x="14" y="3" width="7" height="7" rx="1"/>' +
      '<rect x="3" y="14" width="7" height="7" rx="1"/>' +
      '<rect x="14" y="14" width="7" height="7" rx="1"/>'
    ),

    /* Station — stazione spaziale (M16): anello orbitale + nucleo + bracci. */
    station: svg(
      '<circle cx="12" cy="12" r="3.2"/>' +
      '<ellipse cx="12" cy="12" rx="9" ry="4.2"/>' +
      '<path d="M12 8.8V5M12 19v-3.8"/>'
    ),

    /* Dispatch — dispaccio/missione (M17): busta con onda di segnale. */
    dispatch: svg(
      '<rect x="3" y="5" width="18" height="13" rx="2"/>' +
      '<path d="M3.5 6.5L12 12l8.5-5.5"/>' +
      '<path d="M16 20.5a4 4 0 0 0 4-4" opacity="0.6"/>'
    ),

    /* Book — libro (tutorial, indice schede). */
    book: svg(
      '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>' +
      '<path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>'
    ),

    /* ---- Classi navi (riserva Hangar, M08 #42) — silhouette dedicate per
       riconoscere a colpo d'occhio la classe, tutte top-view "verso l'alto".
       La complessità della sagoma cresce con la stazza. ---- */

    /* Scafo esploratore — sonda snella con sensore in punta. */
    shipExplorer: svg(
      '<path d="M12 3l2.2 6.5v4.5l-2.2 2.5-2.2-2.5V9.5z"/>' +
      '<line x1="12" y1="3" x2="12" y2="1.5"/>' +
      '<path d="M9.8 14l-2.5 3M14.2 14l2.5 3"/>'
    ),

    /* Estrattore — scafo industriale: imbuto-collettore in punta, apertura
       di estrazione centrale e bracci d'aspirazione laterali. */
    shipEstrattore: svg(
      '<path d="M9 6h6l1.6 7-1.6 5H9l-1.6-5z"/>' +
      '<path d="M9.6 6L12 2.6 14.4 6"/>' +
      '<circle cx="12" cy="12" r="2.4"/>' +
      '<path d="M8.6 10L4 12M15.4 10l4.6 2"/>' +
      '<path d="M8.8 15.5L5.5 17.5M15.2 15.5l3.3 2"/>'
    ),

    /* Caccia stellare — fusoliera + ali a freccia (star-fighter). */
    shipCaccia: svg(
      '<path d="M12 2v17"/>' +
      '<path d="M12 8L5 6 4 12M12 8l7-2 1 6"/>' +
      '<path d="M9.5 19h5"/>'
    ),

    /* Intercettore — dardo affusolato con doppio propulsore. */
    shipIntercettore: svg(
      '<path d="M12 2l3 11-1 5h-4l-1-5z"/>' +
      '<path d="M9 10L5 14M15 10l4 4"/>' +
      '<path d="M10.5 18l-1 3M13.5 18l1 3"/>'
    ),

    /* Corvetta — scafo medio con pod laterali. */
    shipCorvetta: svg(
      '<path d="M12 2.5c2.2 2.4 3.3 6.2 3.3 10.3L14.5 19h-5l-.8-6.2c0-4.1 1.1-7.9 3.3-10.3z"/>' +
      '<path d="M9.5 11L5.5 13M14.5 11l4 2"/>'
    ),

    /* Fregata — scafo massiccio, doppie ali + plancia. */
    shipFregata: svg(
      '<path d="M12 2c2.8 3 4 8 4 13l-1 5H9l-1-5c0-5 1.2-10 4-13z"/>' +
      '<path d="M8.2 10L3 12M15.8 10L21 12"/>' +
      '<path d="M8.5 15L4.5 18M15.5 15l4 3"/>' +
      '<circle cx="12" cy="9" r="1" fill="currentColor" stroke="none"/>'
    ),

    /* Pioniere coloniale — modulo tozzo con cupola e pannelli. */
    shipColoniale: svg(
      '<rect x="7.5" y="6" width="9" height="12" rx="3.5"/>' +
      '<path d="M12 6V2.8"/>' +
      '<path d="M7.5 10H3.5M16.5 10h4"/>' +
      '<circle cx="12" cy="11.5" r="2.3"/>'
    ),

    /* ---- Grandi navi (M15) — sagome capitali, più imponenti. ---- */

    /* Incrociatore — scafo allungato a freccia con doppia cresta. */
    shipIncrociatore: svg(
      '<path d="M12 2l3.5 14-1 5h-5l-1-5z"/>' +
      '<path d="M8.7 12L3 14M15.3 12L21 14"/>' +
      '<path d="M10 7h4"/>' +
      '<path d="M9.6 18.5h4.8"/>'
    ),

    /* Dreadnought — corazzata massiccia, esagonale, torrette laterali. */
    shipDreadnought: svg(
      '<path d="M12 2l4 5v9l-2 6h-4l-2-6V7z"/>' +
      '<path d="M8 9L3.5 11M16 9l4.5 2"/>' +
      '<path d="M8 14L4 16.5M16 14l4 2.5"/>' +
      '<line x1="12" y1="7" x2="12" y2="16"/>'
    ),

    /* Nave Ammiraglia — capitale a stella, ali ampie + nucleo di comando. */
    shipAmmiraglia: svg(
      '<path d="M12 1.5l3 6 0 9-3 6-3-6 0-9z"/>' +
      '<path d="M9 8L2 11M15 8l7 3"/>' +
      '<path d="M9 13L3 17M15 13l6 4"/>' +
      '<circle cx="12" cy="10.5" r="1.6" fill="currentColor" stroke="none"/>'
    ),

    /* PR-H: 4 sigle del Calendario del Faro (decisione #30). Ognuna
       ha un glifo dedicato per sostituire la lettera greca nel testo,
       più colore tematico per scansione rapida. */

    /* Iota (Ι) — Impulso atomico (battito). PR-J: linea ECG/onda
       di impulso → orizzontale, niente più tratti verticali confondibili
       con la lettera "I" o un divisorio. */
    iota: svg(
      '<polyline points="2,12 7,12 9,7 11,17 13,7 15,17 17,12 22,12"/>'
    ),

    /* Kappa (Κ) — Ciclo (50 Ι). Cerchio chiuso = oscillazione breve. */
    kappa: svg(
      '<circle cx="12" cy="12" r="6"/>'
    ),

    /* Phi (Φ) — Fase (20 Κ = 1000 Ι). Orbita con baricentro
       = precessione, periodo medio. */
    phi: svg(
      '<ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(-25 12 12)"/>' +
      '<circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/>'
    ),

    /* Omega (Ω) — Eone (100 Φ = 100 000 Ι). Forma greca Ω
       = grande risonanza, scala rara. */
    omega: svg(
      '<path d="M5 19c-1-2-1-5 0-8 1-3 4-5 7-5s6 2 7 5c1 3 1 6 0 8"/>' +
      '<line x1="3" y1="19" x2="7" y2="19"/>' +
      '<line x1="17" y1="19" x2="21" y2="19"/>'
    ),

    /* ---- FSP §17.7 — Fenomeni di Spazio Profondo. Un glifo per classe
       (un concetto = una tinta, colore impostato dal contenitore). Le
       sagome rispecchiano i marker disegnati sulla mappa galattica. ---- */

    /* Generico / Contatto non classificato — diamante (segnale ignoto). */
    fsp: svg('<polygon points="12,3 21,12 12,21 3,12"/>'),
    /* Gravitazionale — lente: anello + nucleo. */
    fspGrav: svg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none"/>'),
    /* Reliquia / Artificiale — esagono. */
    fspRelic: svg('<polygon points="12,3 19.8,7.5 19.8,16.5 12,21 4.2,16.5 4.2,7.5"/>'),
    /* Emissione / Stellare — stella a 4 punte. */
    fspEmis: svg('<path d="M12 2 L14 10 L22 12 L14 14 L12 22 L10 14 L2 12 L10 10 Z"/>'),
    /* Biologica / Esotica — cellula (cerchi concentrici). */
    fspBio: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5"/>'),
    /* Temporale / Vuoto — frattura (triangolo). */
    fspTemp: svg('<polygon points="12,4 20,19 4,19"/>')
  };

  ORION.icons = ICONS;
  ORION.icon = function (name) {
    return ICONS[name] || '';
  };

  /* =====================================================================
     Raster cache (canvas) — rasterizza un'icona SVG tintata in un <img>
     da disegnare via drawImage su mappa/sistema (stesso pattern blit di
     planet-view). Async: la prima richiesta avvia il caricamento e ritorna
     null; quando l'immagine è pronta chiama onReady() (il chiamante fa un
     requestRender). Cache per chiave name|hex|px → non si rigenera ad ogni
     frame. Niente CDN: data URI inline dalla stringa SVG del catalogo.
     ===================================================================== */
  const _rasterCache = {};
  ORION.rasterIcon = function (name, hex, px, onReady) {
    const svgStr = ICONS[name];
    if (!svgStr) return null;
    const size = px || 64;
    const color = hex || '#cfe6ff';
    const key = name + '|' + color + '|' + size;
    const cached = _rasterCache[key];
    if (cached) return (cached.complete && cached.naturalWidth) ? cached : null;
    const tinted = svgStr
      .replace(/currentColor/g, color)
      .replace('width="1em" height="1em"', 'width="' + size + '" height="' + size + '"');
    const img = new Image();
    _rasterCache[key] = img;
    img.onload = function () { if (typeof onReady === 'function') onReady(); };
    img.src = 'data:image/svg+xml,' + encodeURIComponent(tinted);
    return (img.complete && img.naturalWidth) ? img : null;
  };
})(typeof window !== 'undefined' ? window : this);
