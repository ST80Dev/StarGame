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

  /* ==================================================================
     M20 — CALIBRAZIONE DELLE SOGLIE (decisione #23 / GDD §19)
     ==================================================================
     Le piste non sono più placeholder: i target qui sotto sono tarati
     per essere SFIDANTI ma RAGGIUNGIBILI in una partita dedicata, usando
     i dati reali ora disponibili (M07 esplorazione, M12 tesoreria, M13
     ricerca, M09/M11/M19 atti morali, M17 ondate del Sopravvissuto).
     Valori delegati a Claude (l'utente ha delegato i numeri); ritoccabili
     col playtest senza toccare schema né logica. Zero RNG → replay-safe. */
  const CFG = {
    exploreFrac:    0.90,   // Esploratore: frazione della galassia esplorata
    colonizeFrac:   0.22,   // Colonizzatore: colonie / sistemi totali
    colonizeMin:    12,     // pavimento assoluto di colonie (galassie piccole)
    econTarget:     50000,  // Egemone: tesoreria (valute §15) + stock met+en aggregato
    techFrac:       0.85,   // Ascensione: frazione dell'albero tech di partita sbloccata
    techAccumTarget: 10000, // fallback se il modulo research non è caricato (test headless)
    alignmentTarget: 40,    // Pacifista/Tiranno: atti morali accumulati
    survWaves:      6        // Sopravvissuto: ondate superate (fallback se dispatch assente)
  };

  /* M09 Fase B (decisione #49): accumulatore delle azioni morali del
     giocatore. I verbi di M09 (liberare/aggredire un sistema) lo alimentano;
     M11/M19 aggiungeranno i propri. `check()` lo mappa sulle piste
     reputationLight/reputationDark. Soglia tarata in CFG.alignmentTarget. */
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
     RAW METRICS — unica fonte di verità (corrente/soglia) per pista.
     ==================================================================
     check() (loop) e progress() (UI) leggono entrambi da qui, così non
     possono divergere. Tutto deterministico (#5): nessun RNG, solo letture
     dallo stato di gioco. Resiliente ai moduli assenti (test headless). */
  function rawMetrics(game) {
    const O = root.ORION || {};

    /* sistemi totali + esplorati (M07) */
    let total = 1, explored = 0;
    if (game.galaxy) {
      total = Math.max(1, game.galaxy.count ||
        (game.galaxy.systems && game.galaxy.systems.length) || 1);
    }
    if (game.state && game.state.discovery) {
      const DISCOVERY = O.galaxy && O.galaxy.DISCOVERY;
      const EXPLORED = DISCOVERY ? DISCOVERY.EXPLORED : 2;
      for (let i = 0; i < game.state.discovery.length; i++) {
        if (game.state.discovery[i] >= EXPLORED) explored++;
      }
    }

    /* colonie + stock aggregato + ricerca lifetime (fallback) */
    let colonized = 0, stockSum = 0, researchSum = 0;
    if (game.colonies) {
      Object.keys(game.colonies).forEach(function (k) {
        const c = game.colonies[k]; if (!c) return;
        if (c.colonized) colonized++;
        if (c.stock) stockSum += (c.stock.met || 0) + (c.stock.en || 0);
        researchSum += c.researchAccum || 0;
      });
    }

    /* tesoreria — valute regionali §15 (M12): somma di tutte le balances */
    let treasurySum = 0;
    const bal = game.treasury && game.treasury.balances;
    if (bal) Object.keys(bal).forEach(function (k) { treasurySum += bal[k] || 0; });
    const econPower = stockSum + treasurySum;

    /* tech — frazione dell'albero di partita sbloccato (M13). Se il modulo
       research non è caricato (test headless) → fallback su researchAccum. */
    let techCur, techGoal;
    const RS = O.research;
    const techCatalog = (RS && RS.catalogFor) ? RS.catalogFor(game).length : 0;
    if (techCatalog > 0) {
      techCur  = (game.research && Array.isArray(game.research.unlocked)) ? game.research.unlocked.length : 0;
      techGoal = Math.max(1, Math.ceil(techCatalog * CFG.techFrac));
    } else {
      techCur  = Math.round(researchSum);
      techGoal = CFG.techAccumTarget;
    }

    /* atti morali (M09/M11/M19) */
    const deeds = game.alignmentDeeds || { light: 0, dark: 0 };

    /* Sopravvissuto — ondate §17 effettivamente affrontate (M17). Una pista
       a 1.0 = hai retto tutte le ondate programmate ed sei ancora in gioco. */
    const DP = O.dispatch;
    const survWaves = (DP && DP.CFG && DP.CFG.SURV_WAVES) || CFG.survWaves;
    let survFired = 0;
    if (Array.isArray(game.eventSchedule)) {
      game.eventSchedule.forEach(function (e) {
        if (e && e.kind === 'survivor' && e.fired) survFired++;
      });
    }

    const colGoal = Math.max(CFG.colonizeMin, Math.ceil(total * CFG.colonizeFrac));
    const expGoal = Math.max(1, Math.ceil(total * CFG.exploreFrac));

    return {
      exploration:     { cur: explored,             goal: expGoal },
      colonization:    { cur: colonized,            goal: colGoal },
      economy:         { cur: Math.round(econPower), goal: CFG.econTarget },
      tech:            { cur: techCur,               goal: techGoal },
      reputationLight: { cur: deeds.light || 0,      goal: CFG.alignmentTarget },
      reputationDark:  { cur: deeds.dark || 0,       goal: CFG.alignmentTarget },
      survival:        { cur: survFired,             goal: survWaves }
    };
  }

  /* ==================================================================
     CHECK — chiamato dal game loop ogni N Impulsi (M20: condizioni reali)
     ==================================================================
     Ritorna [{ track, score, won }] per tutte le piste e aggiorna
     game.victoryTracks. Le soglie sono reali e calibrate (CFG): `won`
     scatta davvero quando una pista raggiunge il suo target. */
  function check(game) {
    if (!game) return [];
    if (!game.victoryTracks) game.victoryTracks = defaultTracks();
    const m = rawMetrics(game);
    const out = [];
    TRACKS.forEach(function (track) {
      const r = m[track] || { cur: 0, goal: 1 };
      const s = Math.min(1, r.cur / Math.max(1, r.goal));
      game.victoryTracks[track] = s;
      out.push({ track: track, score: s, won: s >= 1 });
    });
    return out;
  }

  /* ==================================================================
     PROGRESS — descrittori ricchi per la dashboard "Destino" (UI).
     ==================================================================
     check() vive nel loop e scrive solo gli score; progress() è chiamato
     dalla UI a ogni render e ritorna, per ciascuna pista, i numeri
     leggibili (corrente / soglia) + una nota su "cosa conta".

     SOGLIE PROVVISORIE: gli stessi placeholder di check() (M20 / GDD §16
     le calibreranno con dati reali). Qui sono centralizzate così UI e loop
     non divergono. */
  const TARGET = {
    economy: CFG.econTarget,
    tech: CFG.techAccumTarget,
    alignment: CFG.alignmentTarget,
    colonizationFrac: CFG.colonizeFrac
  };

  const TRACK_META = {
    exploration:     { icon: 'galaxy',     metric: 'Sistemi esplorati',  hint: 'Invia flotte esploratrici verso i sistemi rilevati per diradare la nebbia di guerra.' },
    colonization:    { icon: 'planet',     metric: 'Mondi colonizzati',  hint: 'Vara navi coloniali e fonda nuove colonie sui mondi liberi.' },
    economy:         { icon: 'market',     metric: 'Ricchezza+tesoreria', hint: 'Specializza i mondi-fabbrica, apri rotte commerciali e accumula valute: somma scorte e tesoreria regionale.' },
    tech:            { icon: 'research',   metric: 'Albero tech sbloccato', hint: 'Costruisci laboratori e osservatori e completa quasi tutto l’albero tecnologico di questa partita.' },
    reputationLight: { icon: 'diplomacy',  metric: 'Atti di luce',       hint: 'Libera sistemi dai tiranni, onora i trattati, aiuta gli alleati.' },
    reputationDark:  { icon: 'fleet',      metric: 'Atti d’ombra',  hint: 'Aggredisci, saccheggia, sottometti: la galassia ti temerà.' },
    survival:        { icon: 'settings',   metric: 'Ondate superate',     hint: 'Resisti a tutte le ondate della grande crisi: la pista cresce a ogni ondata che sopravvivi.' }
  };

  /* Calcola i valori grezzi (corrente/soglia) di ogni pista per la UI.
     Riusa rawMetrics() — stessa fonte del loop, niente divergenza. */
  function progress(game) {
    if (!game) return [];
    check(game); // aggiorna game.victoryTracks (cheap; nessun RNG)
    const t = game.victoryTracks || defaultTracks();
    const cur = rawMetrics(game);

    return TRACKS.map(function (track) {
      const m = TRACK_META[track] || {};
      const c = cur[track] || { cur: 0, goal: 1 };
      const score = Math.min(1, t[track] || 0);
      return {
        track: track,
        label: TRACK_LABELS[track],
        metric: m.metric || '',
        icon: m.icon || 'settings',
        hint: m.hint || '',
        cur: c.cur,
        goal: c.goal,
        score: score,
        won: score >= 1
      };
    });
  }

  /* Focus narrativo opzionale e mutabile (decisione #23 esteso): NON locka
     nessuna pista e NON ha effetti meccanici — solo enfasi UI/cronaca. Vive
     come stringa lazy in game.victoryFocus (null = sandbox puro). */
  function getFocus(game) {
    return (game && typeof game.victoryFocus === 'string') ? game.victoryFocus : null;
  }
  function setFocus(game, track) {
    if (!game) return null;
    if (track == null) { game.victoryFocus = null; return null; }
    if (TRACKS.indexOf(track) < 0) return getFocus(game);
    game.victoryFocus = track;
    return track;
  }

  /* M20 — "Claim" di una pista vinta. La filosofia recovery-friendly/§19
     è sandbox infinito: chiudere una pista mostra la schermata di vittoria
     ma non blocca la partita. Per non ri-aprire il modale ogni 5 Impulsi
     (lo score resta ≥1), il loop marca la pista come "rivendicata".
     Vive lazy in game.victoryClaimed; additivo, nessun bump di schema. */
  function isClaimed(game, track) {
    return !!(game && game.victoryClaimed && game.victoryClaimed[track]);
  }
  function claim(game, track) {
    if (!game || !track) return;
    if (!game.victoryClaimed) game.victoryClaimed = {};
    game.victoryClaimed[track] = true;
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
    CFG: CFG,
    ALIGNMENT_IMPACT: ALIGNMENT_IMPACT,
    defaultMode: defaultMode,
    defaultTracks: defaultTracks,
    registerAction: registerAction,
    applyAlignment: applyAlignment,
    ensureEventSchedule: ensureEventSchedule,
    rawMetrics: rawMetrics,
    check: check,
    progress: progress,
    isClaimed: isClaimed,
    claim: claim,
    getFocus: getFocus,
    setFocus: setFocus,
    TRACK_META: TRACK_META,
    migrate: migrate
  };
})(typeof window !== 'undefined' ? window : this);
