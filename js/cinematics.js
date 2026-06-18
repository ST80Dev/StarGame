/* =====================================================================
   ORION EMPIRES — cinematics.js
   "Regista" degli accadimenti scenografici (Fase 1).

   Ascolta gli stessi eventi di cronaca che alimentano l'auto-pausa
   (decisione #31) e, per i kind "scenografici", riproduce un breve beat
   visivo NON invasivo, disegnato dentro i canvas esistenti (system-view).

   Vincoli rispettati:
   - Determinismo (#5): le cinematiche sono PURO vestito visivo, non
     toccano lo stato di gioco → replay-safe per costruzione.
   - Accessibilità (UI_GUIDE §8): `prefers-reduced-motion: reduce` forza
     la modalità "off" a prescindere dalla preferenza utente.
   - Preferenza utente `ORION.prefs.cinematics` ∈ { piene | ridotte | off }
     (in localStorage['orion.prefs'], MAI nel save di partita).

   Livelli:
     piene   → tutti i beat (reveal sistema + partenza flotta)
     ridotte → solo micro-FX in-canvas leggeri (partenza flotta)
     off     → nessuna animazione (comportamento storico invariato)
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  const VALID = { 'piene': true, 'ridotte': true, 'off': true };

  function reducedMotion() {
    try {
      return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (_) { return false; }
  }

  const Cinematics = {
    _nav: null,

    /* main.js inietta i ganci di navigazione (openSystem) al boot, così il
       regista resta disaccoppiato dal modulo principale. */
    bind(nav) { this._nav = nav || null; },

    /* Modalità EFFETTIVA: reduced-motion ha la precedenza (→ off). */
    mode() {
      if (reducedMotion()) return 'off';
      const m = ORION.prefs && ORION.prefs.cinematics;
      return VALID[m] ? m : 'piene';
    },

    /* Punto d'aggancio unico: chiamato dopo ogni runAdvance con la lista
       eventi dell'Impulso (sia dal play-loop sia dall'avanzamento manuale). */
    onEvents(events) {
      if (!events || !events.length) return;
      const mode = this.mode();
      if (mode === 'off') return;

      let revealed = false; // un solo reveal per batch (evita "yank" multipli)
      for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        if (!ev) continue;
        if (ev.kind === 'fleet-launched') {
          /* Partenza flotta in iperspazio — micro-FX livello A (piene+ridotte). */
          this._departure(ev);
        } else if (mode === 'piene' && !revealed && ev.kind === 'fleet-discovery') {
          /* Arrivo in sistema inesplorato — reveal livello C (solo "piene"). */
          if (this._reveal(ev)) revealed = true;
        }
      }
    },

    /* --- Partenza flotta: solo se stai GIÀ guardando il sistema d'origine
       (nessun cambio di vista forzato → non invasivo). --- */
    _departure(ev) {
      const sv = ORION.systemView;
      if (!sv || ev.systemId == null) return;
      if (ORION.openSystemId !== ev.systemId) return;
      if (typeof sv.playFleetDeparture === 'function') sv.playFleetDeparture(ev.fleetId);
    },

    /* --- Reveal sistema: porta alla vista del sistema appena esplorato e
       avvia la dissolvenza nebbia→rivelazione (richiesta utente). --- */
    _reveal(ev) {
      if (ev.systemId == null) return false;
      if (this._blocked()) return false;   // non dirottare da pianeta/modale

      if (ORION.openSystemId !== ev.systemId) {
        if (this._nav && typeof this._nav.openSystem === 'function') {
          this._nav.openSystem(ev.systemId);
        } else {
          return false;
        }
      }
      const sv = ORION.systemView;
      if (sv && typeof sv.playReveal === 'function') { sv.playReveal(); return true; }
      return false;
    },

    /* Non dirottare la vista se l'utente è dentro un pianeta o se è aperta
       una modale a pieno schermo (save/preferenze/battaglia/reliquia). */
    _blocked() {
      if (ORION.openPlanetKey) return true;
      try {
        const sel = '.save-modal:not([hidden]), .prefs-modal:not([hidden]), ' +
                    '.battle-modal:not([hidden]), [data-anomaly-recap]';
        if (document.querySelector(sel)) return true;
      } catch (_) { /* no DOM */ }
      return false;
    }
  };

  ORION.cinematics = Cinematics;
})(typeof window !== 'undefined' ? window : this);
