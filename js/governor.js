/* =====================================================================
   ORION EMPIRES — governor.js
   Modulo M07.1: Governatore coloniale.
     · Tier 1 "Vigile"          (decisione #40, originale)
     · Tier 2 "Operativo cauto" (decisione #59, questa PR)
     · Tier 2 "Operativo attivo" (decisione #59, questa PR)
     · Tier 3 "Autonomo"        (gancio M13/M14, non ancora attivo)

   Tier 1 ("vigile"): solo segnalazioni `gov-*`, mai agisce.
   Tier 2 ("operativo-cauto"): tutto del Tier 1 + accoda UNA struttura
       nuova (build a livello 1) seguendo la vocazione della colonia,
       quando: coda vuota + scarsità OK su tutto + risorse sufficienti.
       Mai cancella, mai espande, mai demolisce.
   Tier 2 ("operativo-attivo"): tutto del cauto + se la coda è vuota e
       non c'è un nuovo build sensato, ESPANDE un modulo esistente del
       tipo richiesto dalla vocazione, se surplus su 4 risorse base ok.

   Filosofia (decisione #22, recovery-friendly):
     - Mai cancella né demolisce: solo aggiunge in coda quando ha senso.
     - Auto-pausa in `low`/`crit` su qualunque risorsa → lascia decidere
       all'utente nei momenti delicati.
     - Determinismo (decisione #5): scelta del prossimo build deterministica
       (priority order della vocazione + tie-break per colonyKey).
     - Opt-in per colonia, livello scelto dal giocatore via dropdown.

   Vocazioni (5):
     · estrattiva, agricola, militare, ricerca, equilibrata (rotazione).

   Eventi emessi (Tier 1 + Tier 2):
     · gov-queue-empty / gov-slots-idle / gov-pop-near-cap /
       gov-supply-falling / gov-veterans-idle    [Tier 1]
     · gov-build-started   (Tier 2, accoda nuovo build)
     · gov-expand-started  (Tier 2 attivo, espande modulo esistente)

   Log "Decisioni del Governatore": ultime 5 azioni in
     `colony.governor.decisions[]` (lazy). Sempre visibile in UI.

   Lazy-init: `colony.governor` viene creato/esteso al primo tick. Save
   vecchi (con `enabled` ma senza `level`/`vocation`/`decisions`) caricano
   compatibili — `enabled:true` → level `'vigile'`, vocazione `'equilibrata'`.
   NESSUN bump di schema.
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  /* Soglie di disponibilità e attivazione. */
  const TH = {
    UNLOCK_COLONIES:        3,
    QUEUE_EMPTY_I:         30,
    SLOTS_IDLE_FREE:        3,
    POP_NEAR_CAP_RATIO:  0.90,
    SUPPLY_FALLING_I:       5,
    SUPPLY_LOW_FLOOR:      20,
    COOLDOWN_QUEUE:        80,
    COOLDOWN_SLOTS:        80,
    COOLDOWN_POP:         100,
    COOLDOWN_SUPPLY:       50,
    COOLDOWN_VETERANS:    120,
    /* Tier 2 (decisione #59) */
    COOLDOWN_BUILD:        50,
    SURPLUS_MIN_NET:        0
  };

  const LEVELS = ['off', 'vigile', 'operativo-cauto', 'operativo-attivo'];
  const VOCATIONS = ['estrattiva', 'agricola', 'militare', 'ricerca', 'equilibrata'];

  const VOCATION_LABEL = {
    'estrattiva':  'Estrattiva',
    'agricola':    'Agricola',
    'militare':    'Militare',
    'ricerca':     'Ricerca',
    'equilibrata': 'Equilibrata'
  };
  const LEVEL_LABEL = {
    'off':                'Off',
    'vigile':             'Vigile',
    'operativo-cauto':    'Operativo (cauto)',
    'operativo-attivo':   'Operativo (attivo)'
  };

  /* Priority list per vocazione (ordine di preferenza nella scelta del
     prossimo build / espansione). Deterministico, mai pesato da RNG. */
  const PRIORITY = {
    estrattiva: [
      'miniera', 'centrale-solare', 'impianto-idrico', 'fattoria',
      'fonderia', 'raffineria', 'centro-abitativo'
    ],
    agricola: [
      'fattoria', 'impianto-idrico', 'ospedale', 'centro-abitativo',
      'centrale-solare', 'impianto-riciclo'
    ],
    militare: [
      'cantiere-navale', 'accademia-militare', 'batteria-difesa',
      'centrale-solare', 'miniera', 'centro-abitativo'
    ],
    ricerca: [
      'laboratorio', 'osservatorio', 'centro-abitativo', 'fattoria',
      'impianto-idrico', 'centrale-solare'
    ],
    equilibrata: [
      'miniera', 'centrale-solare', 'fattoria', 'impianto-idrico',
      'laboratorio', 'centro-abitativo', 'ospedale', 'fonderia',
      'raffineria', 'osservatorio'
    ]
  };

  /* ------------------------------------------------------------------
     STATO PER-COLONIA — lazy-init, schema invariato.
     ------------------------------------------------------------------ */
  function ensureState(colony) {
    if (!colony.governor) {
      colony.governor = {
        enabled: false,
        level: 'off',
        vocation: 'equilibrata',
        tier: 1,
        lastFire: {},
        queueEmptySince: null,
        fallingStreak: { food: 0, water: 0 },
        lastStock:      { food: null, water: null },
        recent: [],
        decisions: [],
        lastDecisionI: null
      };
    }
    const g = colony.governor;
    /* Migrazione lazy per save legacy (decisione #40 → #59). */
    if (g.level == null) g.level = g.enabled ? 'vigile' : 'off';
    if (g.vocation == null) g.vocation = 'equilibrata';
    if (!Array.isArray(g.decisions)) g.decisions = [];
    if (g.lastDecisionI === undefined) g.lastDecisionI = null;
    return g;
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

  /* Toggle / setEnabled legacy: "enabled=true" → level 'vigile' se off. */
  function setEnabled(colony, value) {
    const g = ensureState(colony);
    g.enabled = !!value;
    g.level = value ? (g.level && g.level !== 'off' ? g.level : 'vigile') : 'off';
    g.queueEmptySince = null;
    g.fallingStreak = { food: 0, water: 0 };
    g.lastStock = { food: colony.stock.food, water: colony.stock.water };
  }
  function toggle(colony) {
    const g = ensureState(colony);
    setEnabled(colony, !g.enabled);
    return g.enabled;
  }
  function setLevel(colony, level) {
    if (LEVELS.indexOf(level) < 0) return false;
    const g = ensureState(colony);
    g.level = level;
    g.enabled = (level !== 'off');
    g.queueEmptySince = null;
    g.fallingStreak = { food: 0, water: 0 };
    g.lastStock = { food: colony.stock.food, water: colony.stock.water };
    return true;
  }
  function setVocation(colony, vocation) {
    if (VOCATIONS.indexOf(vocation) < 0) return false;
    const g = ensureState(colony);
    g.vocation = vocation;
    return true;
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

  function pushDecision(gov, kind, structId, level, T) {
    gov.decisions.unshift({ kind: kind, structId: structId, level: level, impulso: T });
    if (gov.decisions.length > 5) gov.decisions.length = 5;
    gov.lastDecisionI = T;
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

  /* Scarsità OK → nessuna risorsa in low/crit. Auto-pausa di ogni azione
     Tier 2 nei momenti delicati (decisione #22). */
  function scarcityOk(colony) {
    const sc = colony._scar;
    if (!sc) return true;
    const KS = ['met', 'en', 'food', 'water'];
    for (let i = 0; i < KS.length; i++) {
      const st = sc[KS[i]] && sc[KS[i]].state;
      if (st === 'low' || st === 'crit') return false;
    }
    return true;
  }

  /* Surplus su tutte le risorse base (per espansioni Tier 2 attivo).
     Usa `colony._prod.net` se disponibile. Fallback: scarcityOk. */
  function hasSurplusForExpand(colony) {
    const prod = colony._prod;
    if (prod && prod.net) {
      const KS = ['met', 'en', 'food', 'water'];
      for (let i = 0; i < KS.length; i++) {
        if ((prod.net[KS[i]] || 0) < TH.SURPLUS_MIN_NET) return false;
      }
      return true;
    }
    return scarcityOk(colony);
  }

  function canAfford(colony, cost) {
    const keys = Object.keys(cost || {});
    for (let i = 0; i < keys.length; i++) {
      if ((colony.stock[keys[i]] || 0) < cost[keys[i]]) return false;
    }
    return true;
  }

  /* ------------------------------------------------------------------
     TIER 2 — DECISION ENGINE
     ------------------------------------------------------------------ */

  /* Lista priorità per la colonia, con rotazione deterministica per
     'equilibrata' (round-robin su T + hash colKey). */
  function priorityFor(vocation, T, colKey) {
    if (vocation !== 'equilibrata') {
      return PRIORITY[vocation] || PRIORITY.equilibrata;
    }
    const rota = ['estrattiva', 'agricola', 'militare', 'ricerca'];
    let hash = 0;
    for (let i = 0; i < (colKey || '').length; i++) {
      hash = ((hash * 31) + colKey.charCodeAt(i)) | 0;
    }
    const slot = Math.floor((T + Math.abs(hash)) / 100) % rota.length;
    const primary = PRIORITY[rota[slot]] || [];
    const fallback = PRIORITY.equilibrata;
    const seen = {};
    const out = [];
    primary.concat(fallback).forEach(function (id) {
      if (!seen[id]) { seen[id] = true; out.push(id); }
    });
    return out;
  }

  /* Decide prossimo BUILD nuovo (struttura assente). */
  function decideNextBuild(game, colony, planet, colKey) {
    const gov = colony.governor;
    if (!root.ORION.planet || !root.ORION.structures) return { ok: false };
    const list = priorityFor(gov.vocation, game.timeImpulsi || 0, colKey);
    for (let i = 0; i < list.length; i++) {
      const id = list[i];
      if (colony.structures && colony.structures[id]) continue;
      const check = root.ORION.planet.canBuild(colony, planet, id, game);
      if (check && check.ok && !check.isUpgrade) return { ok: true, structId: id };
    }
    return { ok: false };
  }

  /* Decide prossima ESPANSIONE (upgrade esistente). Tier 2 attivo. */
  function decideExpansion(game, colony, planet, colKey) {
    const gov = colony.governor;
    if (!root.ORION.planet || !root.ORION.structures) return { ok: false };
    const list = priorityFor(gov.vocation, game.timeImpulsi || 0, colKey);
    for (let i = 0; i < list.length; i++) {
      const id = list[i];
      if (!colony.structures || !colony.structures[id]) continue;
      const check = root.ORION.planet.canBuild(colony, planet, id, game);
      if (check && check.ok && check.isUpgrade) {
        return { ok: true, structId: id, nextLevel: check.nextLevel };
      }
    }
    return { ok: false };
  }

  /* Esegue una decisione Tier 2 se i pre-requisiti tengono. */
  function maybeActTier2(game, colony, planet, colKey, T, events) {
    const gov = colony.governor;
    if (gov.level !== 'operativo-cauto' && gov.level !== 'operativo-attivo') return null;
    if ((colony.queue || []).length > 0) return null;
    if (!scarcityOk(colony)) return null;
    if (gov.lastDecisionI != null && (T - gov.lastDecisionI) < TH.COOLDOWN_BUILD) return null;

    /* 1) Prova un BUILD nuovo (entrambi i livelli). */
    const newBuild = decideNextBuild(game, colony, planet, colKey);
    if (newBuild.ok) {
      const startedDS = T;
      const res = root.ORION.planet.startBuild(colony, planet, newBuild.structId, startedDS, game);
      if (res && res.ok) {
        pushDecision(gov, 'build', newBuild.structId, 1, T);
        fire(events, gov, colony, planet, 'gov-build-started', T,
             { structId: newBuild.structId, level: 1, vocation: gov.vocation });
        return { kind: 'build', structId: newBuild.structId };
      }
    }
    /* 2) Solo "attivo": prova ESPANSIONE, se surplus ok. */
    if (gov.level === 'operativo-attivo' && hasSurplusForExpand(colony)) {
      const exp = decideExpansion(game, colony, planet, colKey);
      if (exp.ok) {
        const startedDS = T;
        const res = root.ORION.planet.startBuild(colony, planet, exp.structId, startedDS, game);
        if (res && res.ok) {
          pushDecision(gov, 'expand', exp.structId, exp.nextLevel, T);
          fire(events, gov, colony, planet, 'gov-expand-started', T,
               { structId: exp.structId, level: exp.nextLevel, vocation: gov.vocation });
          return { kind: 'expand', structId: exp.structId, level: exp.nextLevel };
        }
      }
    }
    return null;
  }

  /* ------------------------------------------------------------------
     TICK — Tier 1 (segnalazioni) + Tier 2 (azioni cauto/attivo).
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

      if (!available || gov.level === 'off' || !gov.enabled) {
        gov.lastStock = { food: colony.stock.food, water: colony.stock.water };
        gov.queueEmptySince = null;
        gov.fallingStreak = { food: 0, water: 0 };
        continue;
      }

      const planet = planetForColony(game, colKey);
      if (!planet) continue;

      /* === Tier 1 — Segnalazioni (attive a tutti i livelli > off) === */

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

      if (queueLen === 0) {
        const free = freeSlots(colony, planet);
        if (free >= TH.SLOTS_IDLE_FREE &&
            coolOk(gov, 'gov-slots-idle', T, TH.COOLDOWN_SLOTS)) {
          fire(events, gov, colony, planet, 'gov-slots-idle', T, { free: free });
          gov.lastFire['gov-slots-idle'] = T;
        }
      }

      const cap = (colony.pop && colony.pop.cap) || 0;
      const tot = (colony.pop && colony.pop.total) || 0;
      if (cap > 0 && tot / cap >= TH.POP_NEAR_CAP_RATIO &&
          coolOk(gov, 'gov-pop-near-cap', T, TH.COOLDOWN_POP)) {
        fire(events, gov, colony, planet, 'gov-pop-near-cap', T,
             { ratio: Math.round((tot / cap) * 100) });
        gov.lastFire['gov-pop-near-cap'] = T;
      }

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

      /* === Tier 2 — Azioni (operativo-cauto / operativo-attivo) === */
      maybeActTier2(game, colony, planet, colKey, T, events);
    }
  }

  /* ------------------------------------------------------------------
     EXPORT
     ------------------------------------------------------------------ */
  ORION.governor = {
    TH: TH,
    LEVELS: LEVELS,
    VOCATIONS: VOCATIONS,
    LEVEL_LABEL: LEVEL_LABEL,
    VOCATION_LABEL: VOCATION_LABEL,
    PRIORITY: PRIORITY,
    ensureState: ensureState,
    isAvailable: isAvailable,
    setEnabled: setEnabled,
    toggle: toggle,
    setLevel: setLevel,
    setVocation: setVocation,
    tick: tick,
    /* Aiuti UI / test */
    freeSlots: freeSlots,
    decideNextBuild: decideNextBuild,
    decideExpansion: decideExpansion,
    scarcityOk: scarcityOk,
    hasSurplusForExpand: hasSurplusForExpand,
    canAfford: canAfford,
    priorityFor: priorityFor
  };
})(typeof window !== 'undefined' ? window : this);
