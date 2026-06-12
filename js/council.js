/* =====================================================================
   council.js — Consiglio della Civiltà (GDD §9.4, M14 Fase B2, decisione #78)

   Tre figure NON operative, esperti di settore, a livello IMPERO:
     - Consigliere Militare    — minacce, tregue/pace, difesa
     - Consigliere Economico   — risorse, scarsità, rotte interne
     - Consigliere Scientifico — priorità di ricerca

   DELEGA per-consigliere (specchio del Governatore #40/#59, scelta utente):
     - consultivo (default): solo SUGGERIMENTI testuali, non agisce.
     - propositivo: tratta nel suo dominio e porta una DECISIONE FINALE
       sì/no al giocatore (es. "Tregua pronta con X — firmi?").
     - autonomo: AGISCE da solo, entro guardrail recovery-friendly, per
       quando il giocatore si concentra su altro.

   Guardrail (autonomo, per costruzione): solo mosse costruttive/difensive
   — propone pace (mai guerra/rottura), apre rotte interne (nessuna nuova
   spesa: usa un mercantile già pronto), avvia ricerca non game-changer
   (nessun costo d'attivazione). Sempre un log "Decisioni del Consiglio".

   Determinismo (#5): identità da `seed:council:<role>`, zero RNG nel tick.
   Recovery-friendly (#22): tutto reversibile, niente fail-state.
   Schema save 26.
   ===================================================================== */
(function (root) {
  'use strict';

  var WARMUP_I = 60;
  var COOLDOWN = { militare: 200, economico: 200, scientifico: 260 };
  var LEVELS = ['consultivo', 'propositivo', 'autonomo'];
  var LEVEL_LABEL = { consultivo: 'Consultivo', propositivo: 'Propositivo', autonomo: 'Autonomo' };

  var ROLES = {
    militare:    { id: 'militare',    label: 'Consigliere Militare',    glyph: '⚔' },
    economico:   { id: 'economico',   label: 'Consigliere Economico',   glyph: '❖' },
    scientifico: { id: 'scientifico', label: 'Consigliere Scientifico', glyph: '✦' }
  };
  var ROLE_ORDER = ['militare', 'economico', 'scientifico'];

  var NAME_POOL = [
    'Alcaron', 'Brenna', 'Cyriel', 'Damaris', 'Eowyn', 'Faelan',
    'Gideon', 'Hespera', 'Ilarion', 'Junia', 'Kestral', 'Lucasta',
    'Morwen', 'Nerith', 'Orestes', 'Phaedra', 'Quirin', 'Rosalind',
    'Severin', 'Thessaly', 'Ulysse', 'Valeria', 'Wystan', 'Xanthe'
  ];
  var TRAIT_POOL = ['Cauto', 'Schietto', 'Ambizioso', 'Ponderato', 'Inflessibile', 'Lungimirante', 'Pragmatico', 'Idealista'];
  var RACE_POOL = ['Umani', 'Kelhari', 'Vorn', 'Syndari', 'Mekhari'];

  function pick(rng, pool) {
    var i = Math.floor(rng.float() * pool.length);
    if (i >= pool.length) i = pool.length - 1;
    return pool[i];
  }

  function makeAdvisor(game, role) {
    var rng = ORION.rng.makeRng(((game && game.seed) || '') + ':council:' + role);
    return {
      role: role,
      label: ROLES[role].label,
      name: pick(rng, NAME_POOL),
      trait: pick(rng, TRAIT_POOL),
      race: pick(rng, RACE_POOL),
      level: 'consultivo',
      lastSpokeI: -99999,
      lastAdvice: null,    // { topic, ref, res, impulso }
      pending: null,       // azione in attesa di approvazione (propositivo)
      decisions: []        // log autonomo/approvato, ultime 5
    };
  }

  function ensure(game) {
    if (!game) return;
    if (!game.council || typeof game.council !== 'object') game.council = { advisors: {} };
    if (!game.council.advisors) game.council.advisors = {};
    for (var i = 0; i < ROLE_ORDER.length; i++) {
      var r = ROLE_ORDER[i];
      if (!game.council.advisors[r]) game.council.advisors[r] = makeAdvisor(game, r);
      else {
        /* lazy-init dei campi delega per save che avevano solo la base. */
        var a = game.council.advisors[r];
        if (!a.level) a.level = 'consultivo';
        if (a.pending === undefined) a.pending = null;
        if (!Array.isArray(a.decisions)) a.decisions = [];
      }
    }
    return game.council;
  }

  function list(game) { ensure(game); return ROLE_ORDER.map(function (r) { return game.council.advisors[r]; }); }
  function advisorByRole(game, role) { ensure(game); return game.council.advisors[role] || null; }

  function setLevel(game, role, level) {
    if (LEVELS.indexOf(level) < 0) return false;
    var a = advisorByRole(game, role);
    if (!a) return false;
    a.level = level;
    if (level === 'consultivo') a.pending = null;   // abbassare la delega ritira la proposta pendente
    return true;
  }

  /* ---------------------------------------------------------------
     Condizioni (consultivo) — ritorna {topic, ref, res} o null.
     --------------------------------------------------------------- */
  function operationalColonyKeys(game) {
    var out = [];
    var cols = (game && game.colonies) || {};
    Object.keys(cols).forEach(function (k) {
      var c = cols[k];
      if (c && c.colonized && c.phase !== 'settling') out.push(k);
    });
    return out;
  }

  function evalMilitare(game) {
    var inc = (game && game.incursions) || [];
    for (var i = 0; i < inc.length; i++) {
      if (inc[i] && inc[i].status !== 'done') return { topic: 'incursion-inbound', ref: inc[i].targetColonyKey || null };
    }
    var ws = (game && game.warState) || {};
    if ((ws.pressure || 0) >= 0.5) return { topic: 'pressure-high', ref: null };
    if ((ws.pressure || 0) > 0.2) {
      var keys = operationalColonyKeys(game);
      for (var j = 0; j < keys.length; j++) {
        var st = (game.colonies[keys[j]].structures) || {};
        if (!st['batteria-difesa'] && !st['scudo-planetario']) return { topic: 'colony-undefended', ref: keys[j] };
      }
    }
    return null;
  }
  function evalEconomico(game) {
    var keys = operationalColonyKeys(game), lowHit = null, RES = ['met', 'en', 'food', 'water'];
    for (var j = 0; j < keys.length; j++) {
      var scar = game.colonies[keys[j]]._scar;
      if (!scar) continue;
      for (var r = 0; r < RES.length; r++) {
        var s = scar[RES[r]] && scar[RES[r]].state;
        if (s === 'crit') return { topic: 'scarcity-crit', ref: keys[j], res: RES[r] };
        if (s === 'low' && !lowHit) lowHit = { topic: 'scarcity-low', ref: keys[j], res: RES[r] };
      }
    }
    return lowHit;
  }
  function evalScientifico(game) {
    var R = root.ORION && root.ORION.research;
    if (!R || !game.research) return null;
    var rate = (R.empireResearchRate ? R.empireResearchRate(game) : 0);
    if (!game.research.activeProject && rate > 0) return { topic: 'research-idle', ref: null };
    return null;
  }
  function evaluate(game, role) {
    if (role === 'militare') return evalMilitare(game);
    if (role === 'economico') return evalEconomico(game);
    if (role === 'scientifico') return evalScientifico(game);
    return null;
  }

  /* ---------------------------------------------------------------
     Proposte concrete (propositivo/autonomo) — ritorna un'azione
     {type, ...} applicabile, o null se nulla è fattibile ora.
     --------------------------------------------------------------- */
  function proposeMilitare(game) {
    var D = root.ORION && root.ORION.diplomacy;
    if (!D || !D.apply) return null;
    var civs = (game.civs || []).filter(function (c) { return c && c.contacted; });
    var best = null;
    for (var i = 0; i < civs.length; i++) {
      var c = civs[i];
      var rel = D.effectiveRelation ? D.effectiveRelation(game, c) : c.relation;
      if (rel !== 'war') continue;
      var v = D.evaluate(game, c, 'propose-peace');
      if (v && v.accept) {
        if (!best || (c.disposition || 0) > (best.disposition || 0)) best = c;
      }
    }
    if (best) return { type: 'diplo', civId: best.id, civName: best.name, actionId: 'propose-peace' };
    return null;
  }
  function proposeEconomico(game) {
    var T = root.ORION && root.ORION.trade;
    if (!T || !T.createRoute || !T.idleMercantili || !T.canCreateRoute) return null;
    var keys = operationalColonyKeys(game), RES = ['food', 'water', 'met', 'en'];
    for (var d = 0; d < keys.length; d++) {
      var dst = keys[d], scar = game.colonies[dst]._scar;
      if (!scar) continue;
      for (var r = 0; r < RES.length; r++) {
        var res = RES[r], st = scar[res] && scar[res].state;
        if (st !== 'low' && st !== 'crit') continue;
        for (var s = 0; s < keys.length; s++) {
          var src = keys[s]; if (src === dst) continue;
          var col = game.colonies[src];
          if (((col.stock && col.stock[res]) || 0) < 80) continue;
          var ss = col._scar;
          if (ss && ss[res] && ss[res].state !== 'ok') continue;
          var idle = T.idleMercantili(col);
          if (!idle.length) continue;
          var chk = T.canCreateRoute(game, src, dst, res, idle[0].id);
          if (chk && chk.ok) return { type: 'trade-route', src: src, dst: dst, resource: res, mercId: idle[0].id, rate: 4 };
        }
      }
    }
    return null;
  }
  function proposeScientifico(game) {
    var R = root.ORION && root.ORION.research;
    if (!R || !R.setProject || !game.research) return null;
    if (game.research.activeProject) return null;
    if ((R.empireResearchRate ? R.empireResearchRate(game) : 0) <= 0) return null;
    var cat = R.catalogFor ? R.catalogFor(game) : [];
    for (var i = 0; i < cat.length; i++) {
      /* guardrail: niente game-changer in autonomo (paga risorse). */
      if (cat[i].status === 'available' && !cat[i].gameChanger) {
        return { type: 'research', techId: cat[i].id, techName: cat[i].name };
      }
    }
    return null;
  }
  function proposeAction(game, role) {
    if (role === 'militare') return proposeMilitare(game);
    if (role === 'economico') return proposeEconomico(game);
    if (role === 'scientifico') return proposeScientifico(game);
    return null;
  }

  /* Applica un'azione preparata (su accettazione propositivo, o subito in
     autonomo). Ritorna {ok, reason}. */
  function applyAction(game, action, events) {
    if (!action) return { ok: false, reason: 'Nessuna azione' };
    if (action.type === 'diplo') {
      var D = root.ORION.diplomacy;
      var civ = (game.civs || []).filter(function (c) { return c && c.id === action.civId; })[0];
      if (!D || !civ) return { ok: false, reason: 'Civiltà non disponibile' };
      var r = D.apply(game, civ, action.actionId, events);
      return { ok: !!(r && r.ok), reason: r && r.reason };
    }
    if (action.type === 'trade-route') {
      var T = root.ORION.trade;
      var rr = T.createRoute(game, action.src, action.dst, action.resource, action.rate || 4, action.mercId);
      return { ok: !!(rr && rr.ok), reason: rr && rr.reason };
    }
    if (action.type === 'research') {
      var R = root.ORION.research;
      var rs = R.setProject(game, action.techId);
      return { ok: !!(rs && rs.ok), reason: rs && rs.reason };
    }
    return { ok: false, reason: 'Tipo azione sconosciuto' };
  }

  function pushDecision(adv, action, T) {
    adv.decisions.unshift({ type: action.type, label: actionShortLabel(action), impulso: T });
    if (adv.decisions.length > 5) adv.decisions.length = 5;
  }
  function actionShortLabel(a) {
    if (!a) return '';
    if (a.type === 'diplo') return 'pace con ' + (a.civName || '—');
    if (a.type === 'trade-route') return 'rotta ' + a.resource;
    if (a.type === 'research') return 'ricerca ' + (a.techName || '');
    return a.type;
  }

  /* Accetta/rifiuta una proposta pendente (propositivo). */
  function acceptProposal(game, role, events) {
    var a = advisorByRole(game, role);
    if (!a || !a.pending) return { ok: false, reason: 'Nessuna proposta' };
    var action = a.pending;
    var res = applyAction(game, action, events || []);
    a.pending = null;
    if (res.ok) { pushDecision(a, action, game.timeImpulsi || 0); }
    return res;
  }
  function rejectProposal(game, role) {
    var a = advisorByRole(game, role);
    if (a) a.pending = null;
    return { ok: true };
  }

  /* Tick: per ogni consigliere, secondo il suo livello di delega. */
  function tick(game, events) {
    if (!game) return;
    ensure(game);
    var T = game.timeImpulsi || 0;
    if (T < WARMUP_I) return;
    for (var i = 0; i < ROLE_ORDER.length; i++) {
      var role = ROLE_ORDER[i];
      var adv = game.council.advisors[role];
      if (!adv) continue;
      if (adv.pending) continue;   // in attesa di una decisione del giocatore
      if ((T - (adv.lastSpokeI || -99999)) < (COOLDOWN[role] || 200)) continue;
      var level = adv.level || 'consultivo';

      if (level === 'consultivo') {
        var v = evaluate(game, role);
        if (!v) continue;
        adv.lastSpokeI = T;
        adv.lastAdvice = { topic: v.topic, ref: v.ref || null, res: v.res || null, impulso: T };
        if (events) events.push({ kind: 'council-advice', role: role, topic: v.topic, ref: v.ref || null, res: v.res || null, impulso: T });
        continue;
      }

      /* propositivo / autonomo: prova un'azione concreta; se nulla è
         fattibile, ripiega sul suggerimento (l'esperto avvisa comunque). */
      var action = proposeAction(game, role);
      if (!action) {
        var adv2 = evaluate(game, role);
        if (adv2) {
          adv.lastSpokeI = T;
          adv.lastAdvice = { topic: adv2.topic, ref: adv2.ref || null, res: adv2.res || null, impulso: T };
          if (events) events.push({ kind: 'council-advice', role: role, topic: adv2.topic, ref: adv2.ref || null, res: adv2.res || null, impulso: T });
        }
        continue;
      }

      if (level === 'propositivo') {
        adv.pending = action;
        adv.lastSpokeI = T;
        if (events) events.push({ kind: 'council-proposal', role: role, action: action, impulso: T });
      } else { /* autonomo */
        var res = applyAction(game, action, events);
        if (res.ok) {
          adv.lastSpokeI = T;
          pushDecision(adv, action, T);
          if (events) events.push({ kind: 'council-acted', role: role, action: action, impulso: T });
        }
      }
    }
  }

  root.ORION = root.ORION || {};
  root.ORION.council = {
    ROLES: ROLES, ROLE_ORDER: ROLE_ORDER, COOLDOWN: COOLDOWN,
    LEVELS: LEVELS, LEVEL_LABEL: LEVEL_LABEL,
    ensure: ensure, list: list, advisorByRole: advisorByRole,
    setLevel: setLevel, evaluate: evaluate, proposeAction: proposeAction,
    applyAction: applyAction, acceptProposal: acceptProposal, rejectProposal: rejectProposal,
    actionShortLabel: actionShortLabel, tick: tick
  };
}(typeof window !== 'undefined' ? window : this));
