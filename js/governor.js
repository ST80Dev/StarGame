/* =====================================================================
   ORION EMPIRES — governor.js
   Modulo M07.1: Governatore coloniale — Tier 1 "Vigile" (decisione #40).

   Sopra ad una certa soglia di sviluppo (≥ 3 colonie operative) ogni
   colonia può attivare un Governatore che NON agisce, ma alza segnalazioni
   contestuali quando intercetta situazioni che meritano attenzione
   (coda vuota, slot inattivi, popolazione vicina al tetto, stock di
   cibo/acqua in calo, veterani inattivi). Pensato per quando l'utente
   ha molte colonie e vuole concentrarsi sulle dinamiche tra civiltà
   senza dover sorvegliare ogni pianeta. Tier 2 (Operativo: gestisce la
   coda) e Tier 3 (Autonomo: gestisce anche asset) restano agganci aperti
   per M13 (tech "Burocrazia coloniale") e M14 (figura "Governatore").

   Filosofia (decisione #22):
     - Mai agisce, mai blocca: solo segnala. Recovery-friendly al 100%.
     - Determinismo (decisione #5): nessun RNG, soglie+cooldown su
       contatori interni che vivono nel delta colonia. Replay identico.
     - Opt-in per colonia: l'utente decide quali pianeti vuole "vigilati".

   Eventi emessi (vanno in cronaca + auto-pause configurabile):
     - gov-queue-empty       coda vuota da N Impulsi consecutivi
     - gov-slots-idle        ≥3 slot liberi e coda vuota
     - gov-pop-near-cap      pop ≥ 90% del tetto unitario
     - gov-supply-falling    stock cibo o acqua in calo per N Ι consec.
     - gov-veterans-idle     veterani disponibili e nessuna spedizione

   Lazy-init: `colony.governor` viene creato al primo tick. Save vecchi
   restano compatibili senza migrazione (campo opzionale, schema 5).
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  /* Soglie di disponibilità e attivazione. Tarate "conservative":
     - ≥ 3 colonie operative perché il governatore abbia senso (con 1-2
       colonie l'overhead cognitivo è basso e l'aiuto sarebbe paternalistico);
     - cooldown lunghi così le segnalazioni non si trasformano in spam. */
  const TH = {
    UNLOCK_COLONIES:        3,   // colonie operative per sbloccare il Tier 1
    QUEUE_EMPTY_I:         30,   // Ι consecutivi di coda vuota prima di segnalare
    SLOTS_IDLE_FREE:        3,   // slot liberi minimi per scattare
    POP_NEAR_CAP_RATIO:  0.90,   // pop/cap ≥ 90% (sul cap unitario)
    SUPPLY_FALLING_I:       5,   // Ι consecutivi di stock in calo prima di segnalare
    SUPPLY_LOW_FLOOR:      20,   // sotto questa soglia interviene già `scarcity`
    COOLDOWN_QUEUE:        80,
    COOLDOWN_SLOTS:        80,
    COOLDOWN_POP:         100,
    COOLDOWN_SUPPLY:       50,
    COOLDOWN_VETERANS:    120
  };

  /* ------------------------------------------------------------------
     STATO PER-COLONIA — lazy-init, schema invariato.
     ------------------------------------------------------------------ */
  function ensureState(colony) {
    if (!colony.governor) {
      colony.governor = {
        enabled: false,
        tier: 1,
        lastFire: {},                                       // {alertKey: impulsoUltimoFire}
        queueEmptySince: null,
        fallingStreak: { food: 0, water: 0 },
        lastStock:      { food: null, water: null },
        recent: []                                          // ultimi N alert per UI {kind, sub, impulso}
      };
    }
    return colony.governor;
  }

  function isAvailable(game) {
    if (!game || !game.colonies) return false;
    let n = 0;
    const keys = Object.keys(game.colonies);
    for (let i = 0; i < keys.length; i++) {
      const c = game.colonies[keys[i]];
      if (c && c.colonized && c.phase !== 'settling') n++;
      if (n >= TH.UNLOCK_COLONIES) return true;
    }
    return false;
  }

  /* Toggle / setEnabled. L'UI è in main.js, qui solo il flag. */
  function setEnabled(colony, value) {
    const g = ensureState(colony);
    g.enabled = !!value;
    /* Resetta i contatori in modo che, dopo l'attivazione, non scatti
       subito un allarme su uno stato preesistente che il giocatore non
       ha "appena" provocato. Il governatore parte fresco. */
    g.queueEmptySince = null;
    g.fallingStreak = { food: 0, water: 0 };
    g.lastStock = { food: colony.stock.food, water: colony.stock.water };
  }
  function toggle(colony) {
    const g = ensureState(colony);
    setEnabled(colony, !g.enabled);
    return g.enabled;
  }

  /* ------------------------------------------------------------------
     HELPERS
     ------------------------------------------------------------------ */
  function freeSlots(colony, planet) {
    const Sm = root.ORION.structures;
    if (!Sm || !planet) return 0;
    let used = 0;
    Object.keys(colony.structures || {}).forEach(function (id) {
      const def = Sm.get(id);
      if (!def) return;
      used += Sm.slotFootprint(def, colony.structures[id].level || 1);
    });
    return Math.max(0, (planet.slots || 0) - used);
  }

  function coolOk(gov, key, T, cooldown) {
    const last = gov.lastFire[key];
    if (last == null) return true;
    return (T - last) >= cooldown;
  }

  function fire(events, gov, colony, planet, kind, T, extra) {
    const ev = { kind: kind, colony: colony, planet: planet, impulso: T };
    if (extra) Object.keys(extra).forEach(function (k) { ev[k] = extra[k]; });
    events.push(ev);
    gov.recent.unshift({ kind: kind, sub: (extra && extra.res) || null, impulso: T });
    if (gov.recent.length > 8) gov.recent.length = 8;
  }

  function planetForColony(game, colKey) {
    const parts = colKey.split(':');
    const sysId = Number(parts[0]);
    const bodyKey = parts[1];
    if (!root.ORION.system || !root.ORION.planet) return null;
    const system = root.ORION.system.generate(game.galaxy, sysId);
    if (!system) return null;
    return root.ORION.planet.generate(game.galaxy, system, bodyKey);
  }

  /* ------------------------------------------------------------------
     TICK — chiamato da time.js una volta per Impulso, DOPO il processing
     di tutte le colonie (così legge stock/queue già aggiornati al tick
     corrente). Aggiunge eventi all'array passato; la chronicleEvent +
     auto-pause li gestiscono come tutti gli altri.
     ------------------------------------------------------------------ */
  function tick(game, events) {
    if (!game || !game.colonies) return;
    const T = game.timeImpulsi || 0;
    const available = isAvailable(game);
    const colKeys = Object.keys(game.colonies);
    for (let i = 0; i < colKeys.length; i++) {
      const colKey = colKeys[i];
      const colony = game.colonies[colKey];
      if (!colony || !colony.colonized || colony.phase === 'settling') continue;
      const gov = ensureState(colony);
      /* Aggiorna sempre lastStock così l'attivazione futura non legge
         valori obsoleti — ma se non disponibile/non abilitato, niente fire. */
      if (!available || !gov.enabled) {
        gov.lastStock = { food: colony.stock.food, water: colony.stock.water };
        gov.queueEmptySince = null;
        gov.fallingStreak = { food: 0, water: 0 };
        continue;
      }
      const planet = planetForColony(game, colKey);
      if (!planet) continue;

      /* 1) Coda vuota da troppo tempo. */
      const queueLen = (colony.queue && colony.queue.length) || 0;
      if (queueLen === 0) {
        if (gov.queueEmptySince == null) gov.queueEmptySince = T;
        if ((T - gov.queueEmptySince) >= TH.QUEUE_EMPTY_I &&
            coolOk(gov, 'gov-queue-empty', T, TH.COOLDOWN_QUEUE)) {
          fire(events, gov, colony, planet, 'gov-queue-empty', T);
          gov.lastFire['gov-queue-empty'] = T;
        }
      } else {
        gov.queueEmptySince = null;
      }

      /* 2) Slot liberi e coda ferma. */
      if (queueLen === 0) {
        const free = freeSlots(colony, planet);
        if (free >= TH.SLOTS_IDLE_FREE &&
            coolOk(gov, 'gov-slots-idle', T, TH.COOLDOWN_SLOTS)) {
          fire(events, gov, colony, planet, 'gov-slots-idle', T, { free: free });
          gov.lastFire['gov-slots-idle'] = T;
        }
      }

      /* 3) Popolazione vicina al cap (cap unitario, non in persone).
         Usiamo unit/cap come proxy: quando l'unità superiore costa molto
         tempo (decisione #37), la pop si avvicina al cap molto prima di
         saturare in persone. È la soglia "guarda dove investire l'habitat". */
      const cap = (colony.pop && colony.pop.cap) || 0;
      const tot = (colony.pop && colony.pop.total) || 0;
      if (cap > 0 && tot / cap >= TH.POP_NEAR_CAP_RATIO &&
          coolOk(gov, 'gov-pop-near-cap', T, TH.COOLDOWN_POP)) {
        fire(events, gov, colony, planet, 'gov-pop-near-cap', T,
             { ratio: Math.round((tot / cap) * 100) });
        gov.lastFire['gov-pop-near-cap'] = T;
      }

      /* 4) Stock cibo/acqua in calo per N Ι consecutivi, MA non ancora
         in stato low/crit (sotto SCARCITY_LOW_STOCK interviene già
         `scarcity`). Preventivo: dà tempo di reagire prima della crisi. */
      ['food', 'water'].forEach(function (res) {
        const cur = colony.stock[res] || 0;
        const last = gov.lastStock[res];
        const isFalling = (last != null) && (cur < last) && (cur > TH.SUPPLY_LOW_FLOOR);
        if (isFalling) {
          gov.fallingStreak[res] = (gov.fallingStreak[res] || 0) + 1;
          if (gov.fallingStreak[res] >= TH.SUPPLY_FALLING_I &&
              coolOk(gov, 'gov-supply-falling:' + res, T, TH.COOLDOWN_SUPPLY)) {
            fire(events, gov, colony, planet, 'gov-supply-falling', T, { res: res });
            gov.lastFire['gov-supply-falling:' + res] = T;
            gov.fallingStreak[res] = 0;
          }
        } else {
          gov.fallingStreak[res] = 0;
        }
      });
      gov.lastStock = { food: colony.stock.food, water: colony.stock.water };

      /* 5) Veterani inattivi: ≥1 equipaggio con xp≥1 e nessuna spedizione
         attiva originata da questa colonia. Strategico: il giocatore
         dimentica facilmente che ha forza esperta ferma all'Accademia. */
      const crews = (colony.crews && colony.crews.explorer) || [];
      let veterans = 0;
      for (let c = 0; c < crews.length; c++) if ((crews[c].xp || 0) >= 1) veterans++;
      if (veterans > 0) {
        const exps = game.expeditions || [];
        let hasActive = false;
        for (let e = 0; e < exps.length; e++) {
          if (exps[e] && exps[e].originColonyKey === colKey && exps[e].status !== 'done') {
            hasActive = true; break;
          }
        }
        if (!hasActive && coolOk(gov, 'gov-veterans-idle', T, TH.COOLDOWN_VETERANS)) {
          fire(events, gov, colony, planet, 'gov-veterans-idle', T, { count: veterans });
          gov.lastFire['gov-veterans-idle'] = T;
        }
      }
    }
  }

  /* ------------------------------------------------------------------
     EXPORT
     ------------------------------------------------------------------ */
  ORION.governor = {
    TH: TH,
    ensureState: ensureState,
    isAvailable: isAvailable,
    setEnabled: setEnabled,
    toggle: toggle,
    tick: tick,
    /* Aiuti UI */
    freeSlots: freeSlots
  };
})(typeof window !== 'undefined' ? window : this);
