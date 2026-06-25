/* =====================================================================
   ORION EMPIRES — espionage.js
   Modulo M19 (Fase A + 1 azione attiva): Spionaggio §6/§11/§13.

   Modello "Operazione coperta": il VETTORE è la flotta stessa. Una tua
   flotta da combattimento presente in un sistema posseduto da una civiltà
   contattata abilita un'operazione coperta deliberata. L'operazione si
   ARMA sul posto e si RISOLVE restando in presenza per CFG.DURATION_I Ι
   (riusa lo stesso modello di permanenza di ai.processPresence). Se la
   flotta si ritira prima → l'operazione si annulla SENZA penalità
   (recovery-friendly #22).

   Differenza dall'intel passivo (ai.processPresence): quello accumula in
   automatico info OSSERVABILI, gratis e silenzioso. Lo spionaggio è
   un'azione ATTIVA a rischio che raggiunge info NASCOSTE (Infiltrazione)
   o DANNEGGIA il bersaglio (Sabotaggio), con costo M18 al fallimento.

   Operazioni:
     · infiltrate (intel)   → dossier a 'completo' + civ.deepIntel (segreti)
     · sabotage   (attiva)  → colpo una-tantum alla potenza del bersaglio

   Esito SEMPRE deterministico dal seed (#5): zero Math.random.
   Aggancio M18: successo = atto d'ombra lieve + ICG ↑; fallimento (scoperto)
   = reputazione ↓ + ICG ↑↑ + disposizione del bersaglio ↓. Alimenta la
   pista Tiranno via ORION.victory.applyAlignment('dark').

   NB taratura: soglie/percentuali sono placeholder, M20 calibrerà.
   Costo economico upfront NON ancora cablato (gancio CFG.COST per M20):
   il costo attuale è la flotta esposta + la penalità al fallimento.
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  /* --- tarature (placeholder, M20) ------------------------------------ */
  const CFG = {
    /* Ι di permanenza continua per risolvere un'operazione armata. */
    DURATION_I: 6,
    /* Modulatori comuni della probabilità di successo. */
    INTEL_BONUS: 0.10,      // per ogni grado di dossier oltre "frammentario"
    FLEET_BONUS_MAX: 0.20,  // bonus pieno con flotta "grossa"
    FLEET_SCORE_FULL: 8,    // score flotta che dà il bonus pieno
    MIN: 0.15, MAX: 0.90,   // clamp probabilità
    /* Infiltrazione — facile osservare, basso danno se scoperti. */
    INFILTRATE: {
      base: 0.55,
      icgWin: 1, alignWin: 1,
      repFail: 3, icgFail: 2, dispFail: 8, alignFail: 1
    },
    /* Sabotaggio — più difficile, più costoso se scoperti. */
    SABOTAGE: {
      base: 0.40, hit: 0.15,  // colpo % alla potenza percepita del bersaglio
      icgWin: 2, alignWin: 2,
      repFail: 5, icgFail: 4, dispFail: 15, alignFail: 2
    }
    /* COST: { credits: N } — gancio economia M20 (non applicato per ora). */
  };

  const OP_LABEL = { infiltrate: 'Infiltrazione', sabotage: 'Sabotaggio' };

  /* --- utility -------------------------------------------------------- */
  function clampN(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

  function ensure(game) {
    if (!game) return;
    if (!game.espionage || typeof game.espionage !== 'object') {
      game.espionage = { ops: [], seq: 0 };
    }
    if (!Array.isArray(game.espionage.ops)) game.espionage.ops = [];
    if (typeof game.espionage.seq !== 'number') game.espionage.seq = 0;
    /* Registra gli atti d'ombra nel registry vittoria (idempotente). */
    if (ORION.victory && ORION.victory.registerAction) {
      ORION.victory.registerAction('espionage-infiltrate', 'dark');
      ORION.victory.registerAction('espionage-sabotage', 'dark');
    }
  }

  function civById(game, civId) {
    const civs = game && game.civs;
    if (!Array.isArray(civs)) return null;
    for (let i = 0; i < civs.length; i++) if (civs[i] && civs[i].id === civId) return civs[i];
    return null;
  }

  /* Score della flotta: riusa la metrica di ai.js (classi grosse pesano di
     più); fallback per i test headless senza ai.js. */
  function fleetScore(fleet) {
    if (ORION.ai && ORION.ai.fleetIntelScore) return ORION.ai.fleetIntelScore(fleet);
    if (!fleet || !Array.isArray(fleet.ships)) return 0;
    return fleet.ships.length;
  }

  function civSystems(civ) {
    if (Array.isArray(civ.systems)) return civ.systems;
    return (ORION.ai && ORION.ai.derivedSystems) ? ORION.ai.derivedSystems(civ) : [];
  }

  /* Migliore presenza di una flotta player IN un sistema del bersaglio
     (orbita/attracco). Ritorna { sysId, score, fleetId } o null. */
  function presenceAt(game, civ) {
    const owned = civSystems(civ);
    if (!owned || !owned.length) return null;
    let best = null;
    const fleets = game.fleets || [];
    for (let i = 0; i < fleets.length; i++) {
      const f = fleets[i];
      if (!f || !f.location) continue;
      const st = f.location.status;
      if (st !== 'orbiting' && st !== 'docked') continue;
      const sid = f.location.systemId;
      if (sid == null || owned.indexOf(sid) < 0) continue;
      const sc = fleetScore(f);
      if (!best || sc > best.score) best = { sysId: sid, score: sc, fleetId: f.id };
    }
    return best;
  }

  function knowledgeRank(civ) {
    if (ORION.ai && ORION.ai.knowledgeRank) return ORION.ai.knowledgeRank(civ);
    return civ && civ.contacted ? 2 : 0;
  }

  function hasOp(game, civId) {
    return game.espionage.ops.some(function (o) { return o.civId === civId; });
  }
  function opFor(game, civId) {
    return game.espionage.ops.filter(function (o) { return o.civId === civId; })[0] || null;
  }

  /* --- abilitazione --------------------------------------------------- */
  /* Precondizione UNICA: flotta da combattimento in un loro sistema +
     contatto formale + nessuna operazione già in corso sulla stessa civ. */
  function canOperate(game, civ) {
    ensure(game);
    if (!civ || !civ.alive) return { ok: false, reason: 'Civiltà non disponibile.' };
    if (knowledgeRank(civ) < 2) return { ok: false, reason: 'Serve un contatto formale con questa civiltà.' };
    if (hasOp(game, civ.id)) return { ok: false, reason: 'Operazione già in corso su questa civiltà.' };
    const pres = presenceAt(game, civ);
    if (!pres || pres.score <= 0) {
      return { ok: false, reason: 'Porta una flotta da combattimento in un loro sistema.' };
    }
    return { ok: true, sysId: pres.sysId, score: pres.score, fleetId: pres.fleetId };
  }

  function successChance(game, civ, type, score) {
    const c = (type === 'sabotage') ? CFG.SABOTAGE : CFG.INFILTRATE;
    let p = c.base;
    const rank = (ORION.ai && ORION.ai.intelLevelRank)
      ? ORION.ai.intelLevelRank(civ.intelLevel || 'fragmentary') : 1;
    p += CFG.INTEL_BONUS * Math.max(0, rank - 1);
    p += CFG.FLEET_BONUS_MAX * Math.min(1, (score || 0) / CFG.FLEET_SCORE_FULL);
    return clampN(p, CFG.MIN, CFG.MAX);
  }

  /* --- arma / annulla ------------------------------------------------- */
  function arm(game, civ, type) {
    const chk = canOperate(game, civ);
    if (!chk.ok) return chk;
    if (type !== 'infiltrate' && type !== 'sabotage') type = 'infiltrate';
    const op = {
      id: ++game.espionage.seq,
      civId: civ.id, sysId: chk.sysId, type: type,
      armI: game.timeImpulsi || 0, fleetId: chk.fleetId
    };
    game.espionage.ops.push(op);
    return { ok: true, op: op };
  }

  function abort(game, civId) {
    ensure(game);
    const ops = game.espionage.ops;
    for (let i = ops.length - 1; i >= 0; i--) {
      if (ops[i].civId === civId) { ops.splice(i, 1); return true; }
    }
    return false;
  }

  /* --- effetti M18 ---------------------------------------------------- */
  function addReputation(game, delta, label) {
    /* M18: la façade reputation.applyAndRecord applica + registra nello storico
       e alimenta HUD/soglie. Fallback per i contesti senza il modulo (test). */
    if (ORION.reputation && ORION.reputation.applyAndRecord) {
      ORION.reputation.applyAndRecord(game, 'rep', delta, 'espionage', label || 'Spionaggio');
    } else if (ORION.diplomacy && ORION.diplomacy.adjustReputation) {
      ORION.diplomacy.adjustReputation(game, delta);
    } else if (typeof game.reputation === 'number') {
      game.reputation = clampN(game.reputation + delta, 0, 100);
    }
  }
  function addIcg(game, delta, label) {
    if (ORION.reputation && ORION.reputation.applyAndRecord) {
      ORION.reputation.applyAndRecord(game, 'icg', delta, 'espionage', label || 'Spionaggio');
    } else if (typeof game.icg === 'number') {
      /* Fallback senza façade (test/save pre-M18): guardia come dispatch.js. */
      game.icg = clampN(game.icg + delta, 0, 100);
    }
  }
  function addDisposition(game, civ, delta) {
    if (ORION.diplomacy && ORION.diplomacy.adjustDisposition) ORION.diplomacy.adjustDisposition(game, civ, delta);
    else civ.disposition = clampN((civ.disposition || 0) + delta, -100, 100);
  }
  function addDark(game, n) {
    if (ORION.victory && ORION.victory.applyAlignment) ORION.victory.applyAlignment(game, 'dark', n);
  }

  /* Segreti svelati dall'Infiltrazione: ciò che l'osservazione non vede. */
  function buildDeepIntel(game, civ, I) {
    return {
      sinceI: I,
      power: civ.power || 0,
      relation: civ.relation || 'peace',
      betrayalRisk: civ.alignment === 'dark'
    };
  }

  /* --- risoluzione ---------------------------------------------------- */
  function resolve(game, op, civ, pres, events) {
    const I = game.timeImpulsi || 0;
    const isSab = op.type === 'sabotage';
    const conf = isSab ? CFG.SABOTAGE : CFG.INFILTRATE;
    const p = successChance(game, civ, op.type, pres.score);
    /* Seed per-operazione: stesso seed + stesso armI → stesso esito (replay). */
    const rng = ORION.rng.makeRng(game.seed + ':espionage:' + civ.id + ':' + op.armI);
    const success = rng.chance(p);

    /* L'atto coperto è di per sé un'ombra (alimenta la pista Tiranno). */
    addDark(game, success ? conf.alignWin : conf.alignFail);

    const opLbl = (OP_LABEL[op.type] || 'Operazione coperta') + ' · ' + (civ.name || '—');
    let reveal = null;
    if (success) {
      if (isSab) {
        civ.power = Math.max(0, Math.round((civ.power || 0) * (1 - CFG.SABOTAGE.hit)));
      } else {
        civ.intelLevel = 'complete';
        if ((civ.intelProgress || 0) < 6) civ.intelProgress = 6;
        if (ORION.ai && ORION.ai.bumpKnowledge) ORION.ai.bumpKnowledge(civ, 'known');
        civ.deepIntel = buildDeepIntel(game, civ, I);
        reveal = civ.deepIntel;
      }
      addIcg(game, conf.icgWin, opLbl);
    } else {
      /* Scoperto: paghi reputazione, alzi l'ICG, il bersaglio si insospettisce. */
      addReputation(game, -conf.repFail, opLbl + ' (scoperta)');
      addIcg(game, conf.icgFail, opLbl + ' (scoperta)');
      addDisposition(game, civ, -conf.dispFail);
    }

    if (events) events.push({
      kind: 'espionage-result', op: op.type, ok: success, chance: p,
      civId: civ.id, civName: civ.name, civColor: civ.color,
      reveal: reveal, impulso: I
    });
  }

  /* --- tick ----------------------------------------------------------- */
  /* Gira ogni Ι (dopo ai.processPresence, così la presenza è fresca). */
  function process(game, events) {
    ensure(game);
    const ops = game.espionage.ops;
    if (!ops.length) return;
    const I = game.timeImpulsi || 0;
    for (let i = ops.length - 1; i >= 0; i--) {
      const op = ops[i];
      const civ = civById(game, op.civId);
      if (!civ || !civ.alive) { ops.splice(i, 1); continue; }
      const pres = presenceAt(game, civ);
      /* Flotta ritirata (o spostata di sistema) → annulla, nessuna penalità. */
      if (!pres || pres.sysId !== op.sysId || pres.score <= 0) { ops.splice(i, 1); continue; }
      if ((I - op.armI) >= CFG.DURATION_I) {
        resolve(game, op, civ, pres, events);
        ops.splice(i, 1);
      }
    }
  }

  /* Quanti Ι all'esito della prossima operazione (per "Prossimo evento"). */
  function minDuration(game) {
    if (!game || !game.espionage || !game.espionage.ops.length) return Infinity;
    const I = game.timeImpulsi || 0;
    let best = Infinity;
    game.espionage.ops.forEach(function (op) {
      best = Math.min(best, Math.max(0, (op.armI + CFG.DURATION_I) - I));
    });
    return best;
  }

  ORION.espionage = {
    CFG: CFG,
    OP_LABEL: OP_LABEL,
    ensure: ensure,
    canOperate: canOperate,
    successChance: successChance,
    arm: arm,
    abort: abort,
    opFor: opFor,
    process: process,
    minDuration: minDuration,
    /* interni esposti SOLO per i test headless */
    _presenceAt: presenceAt,
    _resolve: resolve,
    _buildDeepIntel: buildDeepIntel
  };
})(typeof window !== 'undefined' ? window : this);
