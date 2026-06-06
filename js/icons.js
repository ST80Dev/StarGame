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
     ORION.icons.NAMES                 array dei nomi disponibili
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
    )
  };

  ICONS.NAMES = Object.keys(ICONS).filter(function (k) { return k !== 'NAMES'; });

  ORION.icons = ICONS;
  ORION.icon = function (name) {
    return ICONS[name] || '';
  };
})(typeof window !== 'undefined' ? window : this);
