/* =====================================================================
   ORION EMPIRES — victory.js
   Modulo M05 (infrastruttura) / M20 (implementazione vera): modalità di
   gioco multi-pista e condizioni di vittoria.

   Decisione #23: tutte le piste sono attive in parallelo in ogni partita;
   la modalità scelta all'avvio (M20) è solo enfasi narrativa, non lock.
   Vince chi chiude per primo una pista qualunque.

   In M05 esponiamo SOLO l'infrastruttura — niente UI di scelta, niente
   formule vere di scoring (arrivano in M20 dopo M07/M10/M11/M13/M14/M18).
   L'hook `check(game)` esiste già nel loop così non rifattoriamo dopo.

   Schema 2: estende lo schema M04/M05 (v1) con
     - mode: { startedAs, preset, modifiers }
     - victoryTracks: { exploration, colonization, economy, tech,
                        reputationLight, reputationDark, survival }
   Migrazione da v1: vedi `migrate(saved)`.
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  const SCHEMA_VERSION = 2;

  /* Le 7 piste di vittoria (decisione #23). Score ∈ [0,1]; vince chi
     raggiunge 1.0 per primo. M05 mantiene i tracker; M20 popola formule. */
  const TRACKS = [
    'exploration',
    'colonization',
    'economy',
    'tech',
    'reputationLight',
    'reputationDark',
    'survival'
  ];

  const TRACK_LABELS = {
    exploration:     'Esploratore',
    colonization:    'Colonizzatore',
    economy:         'Egemone economico',
    tech:            'Ascensione tech',
    reputationLight: 'Pacifista',
    reputationDark:  'Tiranno',
    survival:        'Sopravvissuto'
  };

  /* Le 8 modalità di gioco. L'avvio determina solo l'enfasi narrativa
     (tutorial/eventi/AI in M20), non locka nessuna pista. */
  const MODES = [
    'sandbox',
    'exploration',
    'colonization',
    'economy',
    'tech',
    'pacifist',
    'tyrant',
    'survival'
  ];

  /* Preset curati (decisione #23). M20 esporrà la UI di scelta;
     l'utente potrà anche sbloccare i 4 modificatori liberi (con avviso
     "alcune combinazioni possono risultare squilibrate").
       - galaxySize: moltiplicatore sul numero di sistemi (M02/M07)
       - hostility:  moltiplicatore sul pericolo §5.3
       - tsgSpeed:   ×1/×2/×4 — divisore sul tick principale (vedi
                     time.js — in M05 esposto, applicazione completa M20)
       - ironman:    blocca i load multipli (M06) */
  /* M06.5 (decisione #27): tarature per la fase Insediamento (GDD §6.2.bis).
       - settlingDuration: Impulsi della fase `settling` (durante la quale
                           produzione 50%, +50% velocità prima struttura
                           in coda, crescita pop bloccata)
       - startStockMul:    moltiplicatore dello stock iniziale di colonia
       - startPopBase:     popolazione totale iniziale (unità intere) */
  /* M09 Fase B (decisione #49): `gameOver` abilita la fine partita "hard"
     (§19: 0 colonie → fine). OFF di default (partita infinita / esilio),
     ON solo per Incubo (chi vuole la posta in gioco). M20 esporrà il toggle. */
  const PRESETS = {
    classic:    { galaxySize: 1.0,  hostility: 1.0, tsgSpeed: 1, ironman: false, gameOver: false, settlingDuration: 60,  startStockMul: 1.0, startPopBase: 1 },
    speedrun:   { galaxySize: 0.65, hostility: 1.0, tsgSpeed: 4, ironman: false, gameOver: false, settlingDuration: 30,  startStockMul: 1.5, startPopBase: 1 },
    nightmare:  { galaxySize: 1.0,  hostility: 2.0, tsgSpeed: 1, ironman: true,  gameOver: true,  settlingDuration: 90,  startStockMul: 0.5, startPopBase: 1 },
    longBreath: { galaxySize: 1.5,  hostility: 0.7, tsgSpeed: 1, ironman: false, gameOver: false, settlingDuration: 120, startStockMul: 1.2, startPopBase: 1 }
  };

  function defaultMode() {
    return {
      startedAs: 'sandbox',
      preset: 'classic',
      modifiers: Object.assign({}, PRESETS.classic)
    };
  }

  function defaultTracks() {
    const t = {};
    TRACKS.forEach(function (k) { t[k] = 0; });
    return t;
  }

  /* Registry di alignmentImpact per le azioni del giocatore (decisione #23).
     Alimenta reputationLight/reputationDark senza che le azioni "morali"
     siano già implementate: i verbi extra Tiranno/Pacifista arriveranno
     con M09 (combattimento) / M11 (diplomazia) / M19 (spionaggio).
     L'M05 fornisce solo il punto di registrazione. */
  const ALIGNMENT_IMPACT = {
    /* Esempi predisposti (commentati: i verbi non esistono ancora):
       'attack-civilian':  'dark',
       'sack-system':      'dark',
       'broken-treaty':    'dark',
       'liberate-system':  'light',
       'humanitarian-aid': 'light',
       'honored-treaty':   'light',
    */
  };

  /* Helper per i moduli futuri: registra l'impatto di un'azione del
     giocatore così le piste reputation si aggiornano in automatico.
     In M05 niente azioni morali → niente chiamate; il gancio esiste. */
  function registerAction(actionId, impact) {
    if (impact === 'light' || impact === 'dark') {
      ALIGNMENT_IMPACT[actionId] = impact;
    }
  }

  /* M09 Fase B (decisione #49): accumulatore delle azioni morali del
     giocatore. I verbi di M09 (liberare/aggredire un sistema) lo alimentano;
     M11/M19 aggiungeranno i propri. `check()` lo mappa sulle piste
     reputationLight/reputationDark. Soglia placeholder (M20 calibrerà). */
  const ALIGNMENT_TRACK_THRESHOLD = 50;
  function applyAlignment(game, impact, amount) {
    if (!game) return;
    if (!game.alignmentDeeds) game.alignmentDeeds = { light: 0, dark: 0 };
    if (impact === 'light') game.alignmentDeeds.light += (amount || 1);
    else if (impact === 'dark') game.alignmentDeeds.dark += (amount || 1);
  }

  /* Schedule eventi ancorati a DS specifiche (decisione #23 — Sopravvissuto):
     M17 implementerà lo scheduler vero; in M05 l'array è esposto per le
     iniezioni "alla data di inizio partita" (crisi del Sopravvissuto)
     senza toccare la generazione galassia. */
  function ensureEventSchedule(game) {
    if (!game.eventSchedule) game.eventSchedule = [];
    return game.eventSchedule;
  }

  /* ==================================================================
     CHECK — chiamato dal game loop ogni N Impulsi (M05 stub, M20 reale)
     ==================================================================
     Ritorna [{ track, score, won }] per tutte le piste; aggiorna
     game.victoryTracks. In M05 le formule sono placeholder (score
     calcolato in modo molto blando dai dati già disponibili in M04/M05),
     ma "won" non scatta mai (soglia 1.0 irraggiungibile finché M20 non
     definisce condizioni vere). Così il loop ha già la spina dorsale. */
  function check(game) {
    if (!game) return [];
    if (!game.victoryTracks) game.victoryTracks = defaultTracks();
    const out = [];

    /* --- exploration: % sistemi esplorati (M07 popolerà davvero) --- */
    let explored = 0, total = 1;
    if (game.galaxy && game.state && game.state.discovery) {
      total = Math.max(1, game.galaxy.count || game.galaxy.systems.length);
      const DISCOVERY = root.ORION.galaxy && root.ORION.galaxy.DISCOVERY;
      const EXPLORED = DISCOVERY ? DISCOVERY.EXPLORED : 2;
      for (let i = 0; i < game.state.discovery.length; i++) {
        if (game.state.discovery[i] >= EXPLORED) explored++;
      }
    }
    game.victoryTracks.exploration = Math.min(1, explored / total);

    /* --- colonization: % corpi colonizzati / popolazione totale --- */
    let colonized = 0, popTotal = 0;
    if (game.colonies) {
      Object.keys(game.colonies).forEach(function (k) {
        const c = game.colonies[k];
        if (c && c.colonized) { colonized++; popTotal += (c.pop && c.pop.total) || 0; }
      });
    }
    // Soglia placeholder: 60% delle colonie possibili (alta, irraggiungibile
    // in M05). M20 calibrerà con i dati di galassia esplorata.
    game.victoryTracks.colonization = Math.min(1, colonized / Math.max(1, total * 0.6));

    /* --- economy: stock di metalli/energia aggregato (gancio M12) --- */
    let stockSum = 0;
    if (game.colonies) {
      Object.keys(game.colonies).forEach(function (k) {
        const c = game.colonies[k]; if (!c || !c.stock) return;
        stockSum += (c.stock.met || 0) + (c.stock.en || 0);
      });
    }
    // Placeholder: 100000 (irraggiungibile in M05). M20: usare valute regionali §15.
    game.victoryTracks.economy = Math.min(1, stockSum / 100000);

    /* --- tech: researchAccum sommato (gancio M13) --- */
    let researchSum = 0;
    if (game.colonies) {
      Object.keys(game.colonies).forEach(function (k) {
        const c = game.colonies[k]; if (!c) return;
        researchSum += c.researchAccum || 0;
      });
    }
    game.victoryTracks.tech = Math.min(1, researchSum / 10000);

    /* --- reputation light/dark: alimentate dalle azioni morali (M09 Fase B:
       liberare/aggredire sistemi; M11/M19 aggiungeranno altri verbi). --- */
    const deeds = game.alignmentDeeds || { light: 0, dark: 0 };
    game.victoryTracks.reputationLight = Math.min(1, (deeds.light || 0) / ALIGNMENT_TRACK_THRESHOLD);
    game.victoryTracks.reputationDark  = Math.min(1, (deeds.dark || 0) / ALIGNMENT_TRACK_THRESHOLD);

    /* --- survival: pop+stock alla soglia critica → cresce solo se in crisi.
       In M05 placeholder: zero finché M17 non inietta la crisi alla DS 0. */
    if (game.victoryTracks.survival == null) game.victoryTracks.survival = 0;

    TRACKS.forEach(function (track) {
      const s = game.victoryTracks[track] || 0;
      out.push({ track: track, score: s, won: s >= 1 });
    });
    return out;
  }

  /* Migra un payload salvato v1 → v2 aggiungendo i campi mancanti. */
  function migrate(saved) {
    if (!saved) return saved;
    const v = saved.schema || 1;
    if (v >= SCHEMA_VERSION) return saved;
    // v1 → v2: aggiungi mode + victoryTracks coi default
    if (!saved.mode) saved.mode = defaultMode();
    if (!saved.victoryTracks) saved.victoryTracks = defaultTracks();
    saved.schema = SCHEMA_VERSION;
    return saved;
  }

  ORION.victory = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    TRACKS: TRACKS,
    TRACK_LABELS: TRACK_LABELS,
    MODES: MODES,
    PRESETS: PRESETS,
    ALIGNMENT_IMPACT: ALIGNMENT_IMPACT,
    defaultMode: defaultMode,
    defaultTracks: defaultTracks,
    registerAction: registerAction,
    applyAlignment: applyAlignment,
    ensureEventSchedule: ensureEventSchedule,
    check: check,
    migrate: migrate
  };
})(typeof window !== 'undefined' ? window : this);
