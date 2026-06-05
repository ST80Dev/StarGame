/* =====================================================================
   ORION EMPIRES — capital.js
   Modulo M07.x: "Capitale di Gruppo" (decisione #45).

   Ogni gruppo stellare (cluster, M02 decisione #9) può avere AL PIÙ una
   colonia capitale per volta. La capitale gode di un bonus produzione
   (+15%) e di una riserva extra di slot (+10). Il bonus pianeta base
   originario (decisione #8: +20% su isHomeBase) è EMENDATO: la home
   iniziale viene auto-promossa a capitale del proprio gruppo natale e
   riceve il bonus uniforme +15% via questo sistema (al posto del +20%
   legacy basato su isHomeBase). isHomeBase resta nel delta colonia come
   marker storico/UI ma non guida più il bonus produzione.

   La dichiarazione/transizione/decommissionamento:
     - Cambio capitale: la nuova entra in `pre-capital` con timer 80 Ι,
       la precedente (se esiste) entra in `decommissioning` con timer 80 Ι.
       Durante la transizione: nuova = 0 bonus, vecchia = malus −10%.
     - A fine timer la nuova diventa `capital` (+15% pieno, +10 slot);
       la vecchia torna a regime normale (nessun bonus, niente slot extra).
     - Recovery-friendly (decisione #22): mai fail-state.

   Determinismo (decisione #5): zero RNG, tutto deriva dallo stato.
   Lazy-init: `game.capitals` viene creato al primo uso (initFromHome).

   Eventi emessi (vanno in chronicle + auto-pause):
     - capital-declared          dichiarazione di una nuova capitale
     - capital-transition-end    fine transizione (pre-capital → capital)
     - capital-decommissioned    fine decommissioning (vecchia capitale)
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  const TRANSITION_DURATION = 80;     // Ι di transizione (entrambe le colonie)
  const CAPITAL_PROD_BONUS = 0.15;    // +15% produzione (sostituisce +20% home, #8)
  const CAPITAL_SLOTS_BONUS = 10;     // +10 slot quando capitale piena
  const DECOMMISSIONING_MALUS = -0.10;// −10% produzione durante decommissioning

  /* ------------------------------------------------------------------
     STATO — game.capitals e colony.capitalState (lazy-init)
     ------------------------------------------------------------------ */
  function ensureCapitals(game) {
    if (!game) return null;
    if (!game.capitals) game.capitals = {};
    return game.capitals;
  }

  /* Restituisce il groupId di una colonia.
     Le colonie vivono nei sistemi (colony.systemId); ogni sistema appartiene
     a un cluster — il campo nei sistemi generati è `cluster` (galaxy.js).
     Accetta entrambi i nomi (`cluster` / `clusterId`) per robustezza. */
  function groupOfColony(game, colonyKey) {
    if (!game || !game.galaxy || !colonyKey) return null;
    const colony = game.colonies && game.colonies[colonyKey];
    if (!colony) return null;
    const sysId = colony.systemId;
    const sys = (sysId != null) ? game.galaxy.systems[sysId] : null;
    if (!sys) return null;
    if (sys.cluster != null) return sys.cluster;
    if (sys.clusterId != null) return sys.clusterId;
    return null;
  }

  function getOf(game, groupId) {
    const caps = ensureCapitals(game);
    if (!caps) return null;
    return caps[groupId] || null;
  }

  function isCapital(game, colonyKey) {
    if (!colonyKey) return false;
    const gid = groupOfColony(game, colonyKey);
    if (gid == null) return false;
    return getOf(game, gid) === colonyKey;
  }
  const isCapitalKey = isCapital;

  /* Bonus produzione (decisione #45):
       - capitale piena (`capital`): +15%
       - pre-capitale o decommissioning o nessuna capitale: 0 / malus negativo
     Restituisce un valore additivo (0.15 = +15%, -0.10 = -10%). */
  function bonusOf(game, colonyKey) {
    const colony = game && game.colonies && game.colonies[colonyKey];
    if (!colony) return 0;
    const st = colony.capitalState;
    if (!st || !st.phase) {
      /* Senza capitalState: capitale piena se compare in game.capitals,
         altrimenti nessun bonus. */
      return isCapital(game, colonyKey) ? CAPITAL_PROD_BONUS : 0;
    }
    if (st.phase === 'capital') return CAPITAL_PROD_BONUS;
    if (st.phase === 'pre-capital') return 0;
    if (st.phase === 'decommissioning') return DECOMMISSIONING_MALUS;
    return 0;
  }

  /* Bonus slot: +10 solo se capitale piena (transizione = 0, decommissioning = 0). */
  function slotsBonus(game, colonyKey) {
    const colony = game && game.colonies && game.colonies[colonyKey];
    if (!colony) return 0;
    const st = colony.capitalState;
    if (!st || !st.phase) {
      return isCapital(game, colonyKey) ? CAPITAL_SLOTS_BONUS : 0;
    }
    if (st.phase === 'capital') return CAPITAL_SLOTS_BONUS;
    return 0;
  }

  /* Verifica se una colonia può essere dichiarata capitale del proprio gruppo. */
  function canDeclare(game, colonyKey) {
    if (!game || !game.colonies || !colonyKey) {
      return { ok: false, reason: 'Stato non valido' };
    }
    const colony = game.colonies[colonyKey];
    if (!colony) return { ok: false, reason: 'Colonia inesistente' };
    if (!colony.colonized) return { ok: false, reason: 'Colonia non operativa' };
    if (colony.phase === 'settling') return { ok: false, reason: 'Insediamento in corso' };
    const gid = groupOfColony(game, colonyKey);
    if (gid == null) return { ok: false, reason: 'Gruppo non determinabile' };
    /* Se la colonia è già capitale piena del gruppo → niente da fare. */
    if (isCapital(game, colonyKey)) {
      const st = colony.capitalState;
      if (!st || st.phase === 'capital') return { ok: false, reason: 'Già capitale di questo gruppo' };
    }
    /* Se la colonia è in transizione (pre-capital o decommissioning),
       blocca la (re)dichiarazione finché non si stabilizza. */
    const st = colony.capitalState;
    if (st && (st.phase === 'pre-capital' || st.phase === 'decommissioning')) {
      return { ok: false, reason: 'Transizione in corso' };
    }
    const currentCapital = getOf(game, gid);
    return {
      ok: true,
      groupId: gid,
      previousCapital: (currentCapital && currentCapital !== colonyKey) ? currentCapital : null
    };
  }

  /* Dichiara una colonia come capitale del proprio gruppo. Se ne esisteva
     già una, parte la transizione 80 Ι (entrambe). */
  function declare(game, colonyKey, startImpulsi) {
    const check = canDeclare(game, colonyKey);
    if (!check.ok) return check;
    const T = startImpulsi || (game.timeImpulsi || 0);
    const caps = ensureCapitals(game);
    const colony = game.colonies[colonyKey];
    const prev = check.previousCapital;
    /* Aggiorna il mapping centrale — la nuova diventa "la capitale" del
       gruppo già adesso, ma il bonus pieno arriva a fine transizione. */
    caps[check.groupId] = colonyKey;
    if (prev) {
      const prevCol = game.colonies[prev];
      if (prevCol) {
        prevCol.capitalState = {
          phase: 'decommissioning',
          transitionStart: T,
          transitionEnd: T + TRANSITION_DURATION,
          transitionDuration: TRANSITION_DURATION
        };
      }
    }
    colony.capitalState = {
      phase: 'pre-capital',
      transitionStart: T,
      transitionEnd: T + TRANSITION_DURATION,
      transitionDuration: TRANSITION_DURATION
    };
    return { ok: true, groupId: check.groupId, previousCapital: prev };
  }

  /* Inizializzazione lazy: alla creazione del game (o al caricamento di
     un save schema 6) promuovi la home colony a capitale del suo gruppo
     se nessuna è ancora dichiarata. */
  function initFromHome(game) {
    if (!game || !game.colonies) return;
    const caps = ensureCapitals(game);
    let homeKey = null, homeCol = null;
    const keys = Object.keys(game.colonies);
    for (let i = 0; i < keys.length; i++) {
      const c = game.colonies[keys[i]];
      if (c && c.isHomeBase) { homeKey = keys[i]; homeCol = c; break; }
    }
    if (!homeKey || !homeCol) return;
    const gid = groupOfColony(game, homeKey);
    if (gid == null) return;
    if (!caps[gid]) {
      caps[gid] = homeKey;
      /* La home parte già come capitale piena, senza transizione (è il
         contesto naturale d'avvio: nessuna capitale preesistente). */
      homeCol.capitalState = {
        phase: 'capital',
        transitionStart: null,
        transitionEnd: null,
        transitionDuration: TRANSITION_DURATION
      };
    }
  }

  /* Tick: chiamato da time.js una volta per Impulso. Avanza i timer di
     transizione e completa le fasi. Emette eventi quando una transizione
     si chiude. */
  function tick(game, events) {
    if (!game || !game.colonies) return;
    const T = game.timeImpulsi || 0;
    const keys = Object.keys(game.colonies);
    for (let i = 0; i < keys.length; i++) {
      const colKey = keys[i];
      const colony = game.colonies[colKey];
      if (!colony) continue;
      const st = colony.capitalState;
      if (!st || !st.phase) continue;
      if (st.phase === 'capital') continue;        // stabile, niente timer
      if (st.transitionEnd == null) continue;
      if (T < st.transitionEnd) continue;
      /* Transizione conclusa */
      const planet = planetForColony(game, colKey);
      if (st.phase === 'pre-capital') {
        colony.capitalState = {
          phase: 'capital',
          transitionStart: null,
          transitionEnd: null,
          transitionDuration: TRANSITION_DURATION
        };
        events.push({
          kind: 'capital-transition-end',
          colony: colony, planet: planet,
          colonyKey: colKey, impulso: T
        });
      } else if (st.phase === 'decommissioning') {
        /* Vecchia capitale: torna a regime normale (nessuno stato). */
        colony.capitalState = null;
        events.push({
          kind: 'capital-decommissioned',
          colony: colony, planet: planet,
          colonyKey: colKey, impulso: T
        });
      }
    }
  }

  function planetForColony(game, colKey) {
    if (!colKey || !game) return null;
    const parts = colKey.split(':');
    const sysId = Number(parts[0]);
    const bodyKey = parts[1];
    if (!root.ORION.system || !root.ORION.planet) return null;
    const system = root.ORION.system.generate(game.galaxy, sysId);
    if (!system) return null;
    return root.ORION.planet.generate(game.galaxy, system, bodyKey);
  }

  /* Helper UI: ritorna il prossimo Impulso "interessante" tra le
     transizioni in corso (consumato da time.nextEventImpulsi). */
  function nextTransitionDelta(game) {
    if (!game || !game.colonies) return Infinity;
    const T = game.timeImpulsi || 0;
    let best = Infinity;
    const keys = Object.keys(game.colonies);
    for (let i = 0; i < keys.length; i++) {
      const c = game.colonies[keys[i]];
      if (!c || !c.capitalState) continue;
      if (c.capitalState.transitionEnd == null) continue;
      const rem = c.capitalState.transitionEnd - T;
      if (rem > 0 && rem < best) best = rem;
    }
    return best;
  }

  ORION.capital = {
    TRANSITION_DURATION: TRANSITION_DURATION,
    CAPITAL_PROD_BONUS: CAPITAL_PROD_BONUS,
    CAPITAL_SLOTS_BONUS: CAPITAL_SLOTS_BONUS,
    DECOMMISSIONING_MALUS: DECOMMISSIONING_MALUS,
    ensureCapitals: ensureCapitals,
    groupOfColony: groupOfColony,
    getOf: getOf,
    isCapital: isCapital,
    isCapitalKey: isCapitalKey,
    bonusOf: bonusOf,
    slotsBonus: slotsBonus,
    canDeclare: canDeclare,
    declare: declare,
    initFromHome: initFromHome,
    tick: tick,
    nextTransitionDelta: nextTransitionDelta
  };
})(typeof window !== 'undefined' ? window : this);
