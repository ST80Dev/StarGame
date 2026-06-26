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

   Segno morale (decisione 2026-06-26 — "atti di luce e ombra"): NON è una
   costante fissa del verbo, ma il prodotto di natura dell'atto × allineamento
   del bersaglio, come già fanno combat.js/diplomacy.js. Tre regole:
     · Infiltrazione = atto NEUTRO (raccogliere informazioni non è dominio):
       ombra SOLO se spii un amico/benevolo (tradimento della fiducia);
       contro un rivale ostile/maligno è autodifesa → niente karma.
     · Sabotaggio/Furto = atti LESIVI e coperti: ombra SEMPRE (il metodo è
       tirannico), con magnitudo crescente verso bersagli innocenti/benevoli
       e un PAVIMENTO minimo anche contro un maligno/aggressore — così la via
       al Tiranno non si chiude mai. Alimenta via victory.applyAlignment('dark').
     · Solo gli atti RIUSCITI toccano il karma. Farsi scoprire colpisce la
       reputazione pubblica (rep ↓ + ICG ↑↑ + disposizione ↓), non
       l'inclinazione morale: essere beccati non rende l'atto più malvagio.

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
    /* `alignBase` = ombra base (bersaglio NEUTRALE) dell'atto riuscito; il
       segno reale lo decide moralImpact() in base alla classe del bersaglio.
       Per l'infiltrazione è l'ombra "lieve" applicata SOLO spiando un amico. */
    /* Infiltrazione — facile osservare, basso danno se scoperti. */
    INFILTRATE: {
      base: 0.55,
      icgWin: 1, alignBase: 1,
      repFail: 3, icgFail: 2, dispFail: 8
    },
    /* Sabotaggio — più difficile, più costoso se scoperti. */
    SABOTAGE: {
      base: 0.40, hit: 0.15,  // colpo % alla potenza percepita del bersaglio
      icgWin: 2, alignBase: 2,
      repFail: 5, icgFail: 4, dispFail: 15
    },
    /* Furto — sottrai crediti al bersaglio (accreditati a te nel cluster del
       loro sistema). Arricchisce TE, non ne intacca la potenza (≠ sabotaggio). */
    STEAL: {
      base: 0.45, rate: 0.40, minLoot: 15, maxLoot: 120,
      icgWin: 2, alignBase: 2,
      repFail: 4, icgFail: 3, dispFail: 12
    }
    /* COST: { credits: N } — gancio economia M20 (non applicato per ora). */
  };

  const OP_LABEL = { infiltrate: 'Infiltrazione', sabotage: 'Sabotaggio', steal: 'Furto' };
  const OP_TYPES = ['infiltrate', 'sabotage', 'steal'];

  /* --- utility -------------------------------------------------------- */
  function clampN(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

  function ensure(game) {
    if (!game) return;
    if (!game.espionage || typeof game.espionage !== 'object') {
      game.espionage = { ops: [], seq: 0 };
    }
    if (!Array.isArray(game.espionage.ops)) game.espionage.ops = [];
    if (typeof game.espionage.seq !== 'number') game.espionage.seq = 0;
    /* Registry vittoria (idempotente): SOLO gli atti lesivi sono d'ombra a
       prescindere. L'infiltrazione è neutra (ombra contestuale, vedi
       moralImpact) → non va registrata come 'dark' fissa. */
    if (ORION.victory && ORION.victory.registerAction) {
      ORION.victory.registerAction('espionage-sabotage', 'dark');
      ORION.victory.registerAction('espionage-steal', 'dark');
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

  function confFor(type) {
    if (type === 'sabotage') return CFG.SABOTAGE;
    if (type === 'steal') return CFG.STEAL;
    return CFG.INFILTRATE;
  }

  function successChance(game, civ, type, score) {
    const c = confFor(type);
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
    if (OP_TYPES.indexOf(type) < 0) type = 'infiltrate';
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

  /* --- segno morale (decisione 2026-06-26) --------------------------- */
  /* Classifica il bersaglio per il peso morale dell'atto:
       · 'benign'  → fazione benevola O tua alleata: colpirla/spiarla tradisce
                     la fiducia (l'alleanza vale anche se la civ è maligna).
       · 'evil'    → fazione maligna OPPURE aggressore (in guerra con te o
                     prossima al tradimento): l'autodifesa attenua il peso.
       · 'neutral' → tutto il resto.
     Usa solo dati già esistenti (civ.alignment + civ.relation + betrayalOutlook):
     nessun nuovo stato nel save. */
  function targetMoralClass(game, civ) {
    if (!civ) return 'neutral';
    if (civ.alignment === 'bene' || civ.relation === 'alliance') return 'benign';
    let betraying = false;
    if (ORION.diplomacy && ORION.diplomacy.betrayalOutlook) {
      const lvl = (ORION.diplomacy.betrayalOutlook(game, civ) || {}).level;
      betraying = (lvl === 'high' || lvl === 'imminent');
    }
    if (civ.alignment === 'male' || civ.relation === 'war' || betraying) return 'evil';
    return 'neutral';
  }

  /* Ombra dell'atto RIUSCITO secondo natura×bersaglio. Ritorna l'ammontare di
     karma d'ombra (0 = atto moralmente neutro). Il fallimento non passa di qui. */
  function darkAmountFor(game, civ, type) {
    const conf = confFor(type);
    const cls = targetMoralClass(game, civ);
    if (type === 'infiltrate') {
      /* Atto neutro: ombra SOLO spiando un amico/benevolo. */
      return cls === 'benign' ? conf.alignBase : 0;
    }
    /* Atti lesivi (sabotaggio, furto): ombra ≥ pavimento, mai zero. */
    const base = conf.alignBase;
    if (cls === 'benign') return base + 1;            // crudeltà gratuita: piena
    if (cls === 'evil') return Math.max(1, base - 1); // autodifesa: attenuata, pavimento 1
    return base;                                       // neutrale: base
  }

  /* Furto: bottino in crediti, accreditato nel cluster del sistema bersaglio
     (come dispatch). Importo deterministico (RNG dell'operazione) scalato sulla
     potenza del bersaglio. Restituisce { loot, cluster } per l'evento cronaca. */
  function applySteal(game, op, civ, rng) {
    const c = CFG.STEAL;
    let loot = Math.round((civ.power || 0) * c.rate * rng.range(0.8, 1.2));
    loot = clampN(loot, c.minLoot, c.maxLoot);
    let cluster = null;
    if (ORION.treasury && ORION.treasury.addBalance && ORION.treasury.clusterOfSystem) {
      cluster = ORION.treasury.clusterOfSystem(game, op.sysId);
      if (cluster != null) ORION.treasury.addBalance(game, cluster, loot);
    }
    return { loot: loot, cluster: cluster };
  }

  /* Segreti svelati dall'Infiltrazione: ciò che l'osservazione non vede.
     Il rischio tradimento (GDD §11) è il vero "preavviso indiretto": deriva
     dalle condizioni reali via diplomacy.betrayalOutlook, non dall'allineamento
     nominale. Fallback prudente se la diplomazia non è disponibile (test). */
  function buildDeepIntel(game, civ, I) {
    const bo = (ORION.diplomacy && ORION.diplomacy.betrayalOutlook)
      ? ORION.diplomacy.betrayalOutlook(game, civ)
      : { level: (civ.alignment === 'male') ? 'building' : 'low', label: (civ.alignment === 'male') ? 'in aumento' : 'basso' };
    return {
      sinceI: I,
      power: civ.power || 0,
      relation: civ.relation || 'peace',
      betrayal: bo,                                                  // { level, label, reason }
      betrayalRisk: (bo.level === 'high' || bo.level === 'imminent') // bool per UI/cronaca retrocompat
    };
  }

  /* --- risoluzione ---------------------------------------------------- */
  function resolve(game, op, civ, pres, events) {
    const I = game.timeImpulsi || 0;
    const conf = confFor(op.type);
    const p = successChance(game, civ, op.type, pres.score);
    /* Seed per-operazione: stesso seed + stesso armI → stesso esito (replay). */
    const rng = ORION.rng.makeRng(game.seed + ':espionage:' + civ.id + ':' + op.armI);
    const success = rng.chance(p);

    const opLbl = (OP_LABEL[op.type] || 'Operazione coperta') + ' · ' + (civ.name || '—');
    let reveal = null, loot = null;
    if (success) {
      /* Karma SOLO sugli atti riusciti, con segno contestuale al bersaglio
         (decisione 2026-06-26). darkAmountFor() ritorna 0 per gli atti neutri
         (es. infiltrare un rivale ostile): in quel caso niente ombra. */
      const dark = darkAmountFor(game, civ, op.type);
      if (dark > 0) addDark(game, dark);
      if (op.type === 'sabotage') {
        civ.power = Math.max(0, Math.round((civ.power || 0) * (1 - CFG.SABOTAGE.hit)));
      } else if (op.type === 'steal') {
        loot = applySteal(game, op, civ, rng);
      } else {
        /* Infiltrazione (decisione 2026-06-26): porta direttamente al livello
           "Approfondito" (rank 4), non solo "Completo". Il colpo aggiuntivo
           sta nei dati riservati (civ.deepIntel: potenza esatta, preavviso
           tradimento) — campo separato che fa staleness UI per Ι. */
        civ.intelLevel = 'deep';
        if ((civ.intelProgress || 0) < 10) civ.intelProgress = 10;
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
      reveal: reveal, loot: loot ? loot.loot : null, impulso: I
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
    _buildDeepIntel: buildDeepIntel,
    _darkAmountFor: darkAmountFor,
    _targetMoralClass: targetMoralClass
  };
})(typeof window !== 'undefined' ? window : this);
