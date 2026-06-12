/* =====================================================================
   council.js — Consiglio della Civiltà (GDD §9.4, M14 Fase B2/B3, decisioni #78/#79)

   Tre figure NON operative, esperti di settore, a livello IMPERO:
     - Consigliere Militare    — minacce, tregue/pace, difesa
     - Consigliere Economico   — risorse, scarsità, rotte interne
     - Consigliere Scientifico — priorità di ricerca

   DELEGA per-consigliere (decisione #78, specchio del Governatore #59):
     - consultivo (default): solo SUGGERIMENTI testuali.
     - propositivo: tratta nel suo dominio → DECISIONE FINALE sì/no.
     - autonomo: AGISCE da solo entro guardrail (solo se il seggio ha una
       figura elevata — vedi sotto).

   COSTITUZIONE A SOGLIA (decisione #79): il Consiglio non esiste al turno 1;
   si costituisce quando la civiltà raggiunge COUNCIL_UNLOCK_COLONIES colonie
   operative (come il Governatore). I seggi partono ISTITUZIONALI (identità
   dal seme); puoi ELEVARE una figura del dominio per potenziarli:
     - Militare    ← Comandante veterano (commander.js #75)
     - Economico   ← Mercantile leggendario (trade.js #56)
     - Scientifico ← Luminare (figura che emerge dall'output di ricerca)
   Elevare = ritirare la figura dal servizio operativo (GDD §9.4 "figure non
   più operative"): sblocca il livello AUTONOMO + dimezza il cooldown.

   RICAMBIO AUTOMATICO (decisione #79, "ricambio ovunque"): tutto ambiente,
   solo notifica, mai un'azione forzata. I figura-titolari del Consiglio
   servono un mandato lungo poi si ritirano da soli (il seggio torna
   istituzionale); i consiglieri istituzionali avvicendano l'identità a fine
   mandato. Le figure operative (commander.js / colony-figure.js) hanno il
   loro ricambio nei rispettivi moduli (`retireOld`).

   Determinismo (#5): identità da `seed:council:<role>:<termN>` /
   `seed:luminary:<n>`, zero RNG nel tick. Recovery-friendly (#22): seggio
   mai vuoto (fallback istituzionale). Schema save 28.
   ===================================================================== */
(function (root) {
  'use strict';

  var WARMUP_I = 60;
  var COOLDOWN = { militare: 200, economico: 200, scientifico: 260 };
  var LEVELS = ['consultivo', 'propositivo', 'autonomo'];
  var LEVEL_LABEL = { consultivo: 'Consultivo', propositivo: 'Propositivo', autonomo: 'Autonomo' };

  var COUNCIL_UNLOCK_COLONIES = 3;     // soglia di costituzione (come il Governatore)
  var FIGURE_COOLDOWN_MUL = 0.6;       // un seggio con figura agisce più spesso
  var LUMINARY_PER_TECH = 2;           // 1 Luminare ogni N tech sbloccate
  /* Mandati (Ι) — lunghi, con spread deterministico per non avvicendare
     tutto in blocco. Tarature aperte (M20). */
  var SEAT_TENURE_BASE = 12000, SEAT_TENURE_SPREAD = 4000;     // figura elevata
  var INTERIM_TERM_BASE = 10000, INTERIM_TERM_SPREAD = 3000;   // consigliere istituzionale
  var LUMINARY_TENURE_BASE = 9000, LUMINARY_TENURE_SPREAD = 4000; // luminare idle nel pool

  var ROLES = {
    militare:    { id: 'militare',    label: 'Consigliere Militare',    glyph: '⚔', source: 'Comandante veterano' },
    economico:   { id: 'economico',   label: 'Consigliere Economico',   glyph: '❖', source: 'Mercantile leggendario' },
    scientifico: { id: 'scientifico', label: 'Consigliere Scientifico', glyph: '✦', source: 'Luminare' }
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
  /* hash deterministico per lo spread dei mandati (no RNG di stato). */
  function hashStr(s) {
    var h = 2166136261; s = '' + s;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
    return h >>> 0;
  }
  function tenure(id, base, spread) { return base + (hashStr(id) % (spread + 1)); }

  /* Identità istituzionale (rigenerata a ogni mandato → ricambio). */
  function rollIdentity(game, role, termN) {
    var rng = ORION.rng.makeRng(((game && game.seed) || '') + ':council:' + role + ':' + (termN | 0));
    return { name: pick(rng, NAME_POOL), trait: pick(rng, TRAIT_POOL), race: pick(rng, RACE_POOL) };
  }
  function makeAdvisor(game, role) {
    var id = rollIdentity(game, role, 0);
    return {
      role: role, label: ROLES[role].label,
      name: id.name, trait: id.trait, race: id.race,
      level: 'consultivo',
      lastSpokeI: -99999, lastAdvice: null, pending: null, decisions: [],
      figure: null,           // null = istituzionale; oggetto = figura elevata
      termN: 0, termStart: 0   // mandato del titolare istituzionale corrente
    };
  }

  function ensure(game) {
    if (!game) return;
    if (!game.council || typeof game.council !== 'object') game.council = { advisors: {} };
    if (!game.council.advisors) game.council.advisors = {};
    if (typeof game.council.constituted !== 'boolean') game.council.constituted = false;
    if (typeof game.council.luminariBorn !== 'number') game.council.luminariBorn = 0;
    if (!Array.isArray(game.luminari)) game.luminari = [];
    for (var i = 0; i < ROLE_ORDER.length; i++) {
      var r = ROLE_ORDER[i];
      if (!game.council.advisors[r]) game.council.advisors[r] = makeAdvisor(game, r);
      else {
        var a = game.council.advisors[r];   // lazy-init dei campi nuovi (save vecchi #78)
        if (!a.level) a.level = 'consultivo';
        if (a.pending === undefined) a.pending = null;
        if (!Array.isArray(a.decisions)) a.decisions = [];
        if (a.figure === undefined) a.figure = null;
        if (typeof a.termN !== 'number') a.termN = 0;
        if (typeof a.termStart !== 'number') a.termStart = 0;
      }
    }
    return game.council;
  }

  /* Costituzione: il Consiglio è attivo solo da COUNCIL_UNLOCK_COLONIES colonie. */
  function operationalColonyCount(game) {
    var n = 0, cols = (game && game.colonies) || {};
    var keys = Object.keys(cols);
    for (var i = 0; i < keys.length; i++) {
      var c = cols[keys[i]];
      if (c && c.colonized && c.phase !== 'settling') n++;
    }
    return n;
  }
  function isConstituted(game) {
    ensure(game);
    return game.council.constituted || operationalColonyCount(game) >= COUNCIL_UNLOCK_COLONIES;
  }

  function list(game) { ensure(game); return ROLE_ORDER.map(function (r) { return game.council.advisors[r]; }); }
  function advisorByRole(game, role) { ensure(game); return game.council.advisors[role] || null; }
  function seatName(adv) { return (adv && adv.figure) ? adv.figure.name : (adv ? adv.name : '—'); }
  function seatSource(adv) { return (adv && adv.figure) ? adv.figure.originLabel : 'istituzionale'; }
  function hasFigure(adv) { return !!(adv && adv.figure); }
  function allowedLevels(adv) { return hasFigure(adv) ? LEVELS.slice() : ['consultivo', 'propositivo']; }

  function setLevel(game, role, level) {
    if (LEVELS.indexOf(level) < 0) return false;
    var a = advisorByRole(game, role);
    if (!a) return false;
    if (level === 'autonomo' && !hasFigure(a)) return false;   // autonomo solo con figura
    a.level = level;
    if (level === 'consultivo') a.pending = null;
    return true;
  }

  /* ---------------------------------------------------------------
     Elevazione: ritira una figura del dominio nel seggio.
     --------------------------------------------------------------- */
  function eligibleFor(game, role) {
    var out = [];
    if (role === 'militare') {
      var C = root.ORION && root.ORION.commander;
      if (C && C.list) C.list(game).forEach(function (cmd) {
        if (cmd.role === 'comandante' && (cmd.xp | 0) >= 18) {   // Capitano+
          out.push({ kind: 'commander', id: cmd.id, name: (cmd.rank || '') + ' ' + cmd.name, descr: 'Comandante · xp ' + (cmd.xp | 0) });
        }
      });
    } else if (role === 'economico') {
      var cols = (game && game.colonies) || {};
      Object.keys(cols).forEach(function (k) {
        var ms = cols[k] && cols[k].mercantili;
        if (!Array.isArray(ms)) return;
        ms.forEach(function (m) {
          if (m.status !== 'on-route' && (m.xp | 0) >= 8) {       // veterana+
            out.push({ kind: 'mercantile', id: m.id, colonyKey: k, name: 'Capitano mercantile', descr: 'Mercantile · xp ' + (m.xp | 0) });
          }
        });
      });
    } else if (role === 'scientifico') {
      ((game && game.luminari) || []).forEach(function (l) {
        if (l.status !== 'retired') out.push({ kind: 'luminary', id: l.id, name: l.name, descr: 'Luminare · ' + (l.traitLabel || l.trait || '') });
      });
    }
    return out;
  }

  function elevate(game, role, kind, refId, refColonyKey) {
    var adv = advisorByRole(game, role);
    if (!adv) return { ok: false, reason: 'Seggio inesistente' };
    var now = (game.timeImpulsi || 0);
    var fig = null;
    if (kind === 'commander') {
      var C = root.ORION.commander, pool = C.list(game), idx = -1;
      for (var i = 0; i < pool.length; i++) if (pool[i].id === refId) { idx = i; break; }
      if (idx < 0) return { ok: false, reason: 'Comandante non disponibile' };
      var cmd = pool[idx]; pool.splice(idx, 1);
      fig = { name: (cmd.rank || '') + ' ' + cmd.name, originLabel: 'Comandante', bornAt: now };
    } else if (kind === 'mercantile') {
      var col = game.colonies && game.colonies[refColonyKey];
      var ms = col && col.mercantili; if (!Array.isArray(ms)) return { ok: false, reason: 'Mercantile non disponibile' };
      var j = -1; for (var m = 0; m < ms.length; m++) if (ms[m].id === refId) { j = m; break; }
      if (j < 0) return { ok: false, reason: 'Mercantile non disponibile' };
      ms.splice(j, 1);
      var rng = ORION.rng.makeRng((game.seed || '') + ':council-cap:' + refId);
      fig = { name: pick(rng, NAME_POOL), originLabel: 'Mercantile leggendario', bornAt: now };
    } else if (kind === 'luminary') {
      var lum = (game.luminari || []), k2 = -1;
      for (var l = 0; l < lum.length; l++) if (lum[l].id === refId) { k2 = l; break; }
      if (k2 < 0) return { ok: false, reason: 'Luminare non disponibile' };
      var L = lum[k2]; lum.splice(k2, 1);
      fig = { name: L.name, originLabel: 'Luminare', bornAt: now };
    } else return { ok: false, reason: 'Tipo non valido' };
    adv.figure = fig;   // l'eventuale figura precedente è congedata (persa)
    return { ok: true, figure: fig };
  }

  /* ---------------------------------------------------------------
     Luminari — emergono dall'output di ricerca (decisione #79).
     --------------------------------------------------------------- */
  function makeLuminary(game, n) {
    var rng = ORION.rng.makeRng((game.seed || '') + ':luminary:' + n);
    return {
      id: 'lum-' + n, name: pick(rng, NAME_POOL),
      trait: pick(rng, TRAIT_POOL), traitLabel: pick(rng, TRAIT_POOL),
      race: pick(rng, RACE_POOL), status: 'idle', bornAt: game.timeImpulsi || 0
    };
  }
  function maybeEmergeLuminary(game, events) {
    if (!game) return;
    ensure(game);
    /* Basta il DATO game.research.unlocked (non serve il modulo research). */
    var unlocked = (game.research && Array.isArray(game.research.unlocked)) ? game.research.unlocked.length : 0;
    var target = Math.floor(unlocked / LUMINARY_PER_TECH);
    while (game.council.luminariBorn < target) {
      var n = game.council.luminariBorn;
      var lum = makeLuminary(game, n);
      game.luminari.push(lum);
      game.council.luminariBorn = n + 1;
      if (events) events.push({ kind: 'luminary-emerged', figure: lum, impulso: game.timeImpulsi });
    }
  }

  /* ---------------------------------------------------------------
     Condizioni (consultivo) — invariate (#78).
     --------------------------------------------------------------- */
  function operationalColonyKeys(game) {
    var out = [], cols = (game && game.colonies) || {};
    Object.keys(cols).forEach(function (k) {
      var c = cols[k]; if (c && c.colonized && c.phase !== 'settling') out.push(k);
    });
    return out;
  }
  function evalMilitare(game) {
    var inc = (game && game.incursions) || [];
    for (var i = 0; i < inc.length; i++) if (inc[i] && inc[i].status !== 'done') return { topic: 'incursion-inbound', ref: inc[i].targetColonyKey || null };
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
      var scar = game.colonies[keys[j]]._scar; if (!scar) continue;
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
     Proposte concrete (propositivo/autonomo) — invariate (#78).
     --------------------------------------------------------------- */
  function proposeMilitare(game) {
    var D = root.ORION && root.ORION.diplomacy;
    if (!D || !D.apply) return null;
    var civs = (game.civs || []).filter(function (c) { return c && c.contacted; }), best = null;
    for (var i = 0; i < civs.length; i++) {
      var c = civs[i], rel = D.effectiveRelation ? D.effectiveRelation(game, c) : c.relation;
      if (rel !== 'war') continue;
      var v = D.evaluate(game, c, 'propose-peace');
      if (v && v.accept) { if (!best || (c.disposition || 0) > (best.disposition || 0)) best = c; }
    }
    if (best) return { type: 'diplo', civId: best.id, civName: best.name, actionId: 'propose-peace' };
    return null;
  }
  function proposeEconomico(game) {
    var T = root.ORION && root.ORION.trade;
    if (!T || !T.createRoute || !T.idleMercantili || !T.canCreateRoute) return null;
    var keys = operationalColonyKeys(game), RES = ['food', 'water', 'met', 'en'];
    for (var d = 0; d < keys.length; d++) {
      var dst = keys[d], scar = game.colonies[dst]._scar; if (!scar) continue;
      for (var r = 0; r < RES.length; r++) {
        var res = RES[r], st = scar[res] && scar[res].state;
        if (st !== 'low' && st !== 'crit') continue;
        for (var s = 0; s < keys.length; s++) {
          var src = keys[s]; if (src === dst) continue;
          var col = game.colonies[src];
          if (((col.stock && col.stock[res]) || 0) < 80) continue;
          var ss = col._scar; if (ss && ss[res] && ss[res].state !== 'ok') continue;
          var idle = T.idleMercantili(col); if (!idle.length) continue;
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
      if (cat[i].status === 'available' && !cat[i].gameChanger) return { type: 'research', techId: cat[i].id, techName: cat[i].name };
    }
    return null;
  }
  function proposeAction(game, role) {
    if (role === 'militare') return proposeMilitare(game);
    if (role === 'economico') return proposeEconomico(game);
    if (role === 'scientifico') return proposeScientifico(game);
    return null;
  }
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
      var rr = root.ORION.trade.createRoute(game, action.src, action.dst, action.resource, action.rate || 4, action.mercId);
      return { ok: !!(rr && rr.ok), reason: rr && rr.reason };
    }
    if (action.type === 'research') {
      var rs = root.ORION.research.setProject(game, action.techId);
      return { ok: !!(rs && rs.ok), reason: rs && rs.reason };
    }
    return { ok: false, reason: 'Tipo azione sconosciuto' };
  }
  function actionShortLabel(a) {
    if (!a) return '';
    if (a.type === 'diplo') return 'pace con ' + (a.civName || '—');
    if (a.type === 'trade-route') return 'rotta ' + a.resource;
    if (a.type === 'research') return 'ricerca ' + (a.techName || '');
    return a.type;
  }
  function pushDecision(adv, action, T) {
    adv.decisions.unshift({ type: action.type, label: actionShortLabel(action), impulso: T });
    if (adv.decisions.length > 5) adv.decisions.length = 5;
  }
  function acceptProposal(game, role, events) {
    var a = advisorByRole(game, role);
    if (!a || !a.pending) return { ok: false, reason: 'Nessuna proposta' };
    var action = a.pending, res = applyAction(game, action, events || []);
    a.pending = null;
    if (res.ok) pushDecision(a, action, game.timeImpulsi || 0);
    return res;
  }
  function rejectProposal(game, role) {
    var a = advisorByRole(game, role); if (a) a.pending = null; return { ok: true };
  }

  /* ---------------------------------------------------------------
     Ricambio automatico dei seggi (decisione #79). Notifica, nessuna
     azione forzata: il figura-titolare si ritira (seggio → istituzionale),
     il titolare istituzionale avvicenda l'identità a fine mandato.
     --------------------------------------------------------------- */
  function processSeatLifecycle(game, events, T) {
    for (var i = 0; i < ROLE_ORDER.length; i++) {
      var role = ROLE_ORDER[i], a = game.council.advisors[role];
      if (!a) continue;
      if (a.figure) {
        if ((T - (a.figure.bornAt || 0)) >= tenure(role + ':fig', SEAT_TENURE_BASE, SEAT_TENURE_SPREAD)) {
          var oldName = a.figure.name;
          a.figure = null; a.termStart = T; a.termN = (a.termN || 0) + 1;
          var id = rollIdentity(game, role, a.termN);
          a.name = id.name; a.trait = id.trait; a.race = id.race;
          if (a.level === 'autonomo') a.level = 'propositivo';   // l'autonomo richiede una figura
          if (events) events.push({ kind: 'council-succession', role: role, fromFigure: oldName, toName: a.name, impulso: T });
        }
      } else {
        if ((T - (a.termStart || 0)) >= tenure(role + ':' + a.termN, INTERIM_TERM_BASE, INTERIM_TERM_SPREAD)) {
          var prev = a.name;
          a.termStart = T; a.termN = (a.termN || 0) + 1;
          var id2 = rollIdentity(game, role, a.termN);
          a.name = id2.name; a.trait = id2.trait; a.race = id2.race;
          if (events) events.push({ kind: 'council-succession', role: role, fromFigure: prev, toName: a.name, impulso: T });
        }
      }
    }
    /* Luminari idle troppo a lungo nel pool → si ritirano (cleanup silenzioso). */
    var lum = game.luminari || [];
    for (var l = lum.length - 1; l >= 0; l--) {
      if ((T - (lum[l].bornAt || 0)) >= tenure(lum[l].id, LUMINARY_TENURE_BASE, LUMINARY_TENURE_SPREAD)) lum.splice(l, 1);
    }
  }

  /* Tick: costituzione + ciclo seggi + delega per-consigliere. */
  function tick(game, events) {
    if (!game) return;
    ensure(game);
    var T = game.timeImpulsi || 0;
    /* Costituzione (una volta sola). */
    if (!game.council.constituted && operationalColonyCount(game) >= COUNCIL_UNLOCK_COLONIES) {
      game.council.constituted = true;
      for (var c = 0; c < ROLE_ORDER.length; c++) { game.council.advisors[ROLE_ORDER[c]].termStart = T; }
      if (events) events.push({ kind: 'council-constituted', impulso: T });
    }
    if (!game.council.constituted) return;
    processSeatLifecycle(game, events, T);
    if (T < WARMUP_I) return;

    for (var i = 0; i < ROLE_ORDER.length; i++) {
      var role = ROLE_ORDER[i], adv = game.council.advisors[role];
      if (!adv || adv.pending) continue;
      var cd = (COOLDOWN[role] || 200) * (hasFigure(adv) ? FIGURE_COOLDOWN_MUL : 1);
      if ((T - (adv.lastSpokeI || -99999)) < cd) continue;
      var level = adv.level || 'consultivo';

      if (level === 'consultivo') {
        var v = evaluate(game, role); if (!v) continue;
        adv.lastSpokeI = T; adv.lastAdvice = { topic: v.topic, ref: v.ref || null, res: v.res || null, impulso: T };
        if (events) events.push({ kind: 'council-advice', role: role, topic: v.topic, ref: v.ref || null, res: v.res || null, impulso: T });
        continue;
      }
      var action = proposeAction(game, role);
      if (!action) {
        var adv2 = evaluate(game, role);
        if (adv2) {
          adv.lastSpokeI = T; adv.lastAdvice = { topic: adv2.topic, ref: adv2.ref || null, res: adv2.res || null, impulso: T };
          if (events) events.push({ kind: 'council-advice', role: role, topic: adv2.topic, ref: adv2.ref || null, res: adv2.res || null, impulso: T });
        }
        continue;
      }
      if (level === 'propositivo') {
        adv.pending = action; adv.lastSpokeI = T;
        if (events) events.push({ kind: 'council-proposal', role: role, action: action, impulso: T });
      } else { /* autonomo (solo con figura) */
        var res = applyAction(game, action, events);
        if (res.ok) { adv.lastSpokeI = T; pushDecision(adv, action, T); if (events) events.push({ kind: 'council-acted', role: role, action: action, impulso: T }); }
      }
    }
  }

  root.ORION = root.ORION || {};
  root.ORION.council = {
    ROLES: ROLES, ROLE_ORDER: ROLE_ORDER, COOLDOWN: COOLDOWN,
    LEVELS: LEVELS, LEVEL_LABEL: LEVEL_LABEL,
    COUNCIL_UNLOCK_COLONIES: COUNCIL_UNLOCK_COLONIES,
    ensure: ensure, list: list, advisorByRole: advisorByRole,
    isConstituted: isConstituted, operationalColonyCount: operationalColonyCount,
    seatName: seatName, seatSource: seatSource, hasFigure: hasFigure, allowedLevels: allowedLevels,
    setLevel: setLevel, eligibleFor: eligibleFor, elevate: elevate,
    maybeEmergeLuminary: maybeEmergeLuminary,
    evaluate: evaluate, proposeAction: proposeAction, applyAction: applyAction,
    acceptProposal: acceptProposal, rejectProposal: rejectProposal,
    actionShortLabel: actionShortLabel, tick: tick
  };
}(typeof window !== 'undefined' ? window : this));
