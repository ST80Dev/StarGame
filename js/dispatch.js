/* =====================================================================
   ORION EMPIRES — dispatch.js  (M17 — Eventi e narrazione, Fase A)

   Motore eventi (deterministico) + Dispacci & Missioni + Memoria Storica.
   Decisione #83. Apre M17. Scope Fase A (scelte utente):
     - "Dispacci & Missioni" come primo strato di contenuto sul motore.
     - Obiettivi CONCRETI: si adempiono coi verbi esistenti (manda una
       flotta, sgomina un covo, raggiungi/presidia un sistema). Nessun
       nuovo verbo: la missione OSSERVA lo stato (poll deterministico).
     - Tre fonti: civiltà AI contattate / Sindacato Mekhari broker /
       segnali anonimi di frontiera.
     - Presentazione IBRIDA: le offerte sono opportunità non bloccanti
       (auto-pausa OFF) nel pannello Dispacci; gli ESITI (done/failed)
       sono notevoli (auto-pausa ON). Il modale-crisi è Fase C.
     - Ritmo RARI e CALMI: warmup + cooldown lungo + chance bassa + cap.
     - Memoria Storica §17.2: log milestone PERMANENTE (uncapped),
       separato dalla Cronaca (cap 40). Registrata in runAdvance,
       idempotente (seen-set ricostruito in ensure).

   Determinismo (#5): RNG solo da `seed:dispatch:<Impulso>`; lo stato
   osservato (covi, civiltà, flotte) è già deterministico. Zero Math.random.
   Recovery-friendly (#22): nessun fail-state; accettare è impegno a basso
   rischio, la ricompensa è l'incentivo; rinunciare/scadere costano poco.

   Persistenza (schema 30): game.missions[] + game.memoria[] +
   game.dispatchMeta. Il seen-set (game._memoriaSeen) è transitorio,
   ricostruito da ensure() al load (NON serializzato).

   Crisi galattiche / Sopravvissuto §17 (eventSchedule) + anomalie §17.3
   esplorabili → Fasi successive (gancio formale).
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  const DETECTED = 1; // ORION.galaxy.DISCOVERY.DETECTED (stabile)

  const CFG = {
    WARMUP_I: 300,        // niente offerte prima (early-game senza fonti)
    GEN_EVERY: 25,        // cadenza di tentativo (deterministica)
    GEN_COOLDOWN: 260,    // Ι minimi tra un'offerta e la successiva
    GEN_CHANCE: 0.40,     // probabilità per tentativo idoneo
    MAX_OPEN: 4,          // tetto offered + active
    OFFER_TTL: 220,       // finestra dell'offerta (poi scade in silenzio)
    DEADLINE: 650,        // tempo per completare dopo l'accettazione
    ESCORT_HOLD: 60,      // Ι di presenza richiesti (scorta)
    RESUPPLY_HOLD: 50     // Ι di presenza richiesti (rifornimento)
  };

  /* ------------------------------------------------------------------
     LIFECYCLE / ENSURE
     ------------------------------------------------------------------ */
  function ensure(game) {
    if (!game) return;
    if (!Array.isArray(game.missions)) game.missions = [];
    if (!Array.isArray(game.memoria)) game.memoria = [];
    if (!game.dispatchMeta || typeof game.dispatchMeta !== 'object') {
      game.dispatchMeta = { lastOfferAt: -1, offers: 0, completed: 0 };
    }
    rebuildMemoriaSeen(game);
  }

  function rebuildMemoriaSeen(game) {
    const seen = {};
    (game.memoria || []).forEach(function (m) { if (m && m.first && m.key) seen[m.key] = true; });
    game._memoriaSeen = seen;
  }

  /* ------------------------------------------------------------------
     HELPERS
     ------------------------------------------------------------------ */
  function civById(game, id) {
    const civs = game.civs || [];
    for (let i = 0; i < civs.length; i++) if (civs[i] && civs[i].id === id) return civs[i];
    return null;
  }

  /* Colonia su cui versare le ricompense: la capitale del gruppo natale,
     altrimenti la prima colonia operativa. */
  function payColonyKey(game) {
    if (ORION.capital && ORION.capital.getOf && game.galaxy) {
      const cap = ORION.capital.getOf(game, game.galaxy.homeGroupId);
      if (cap && game.colonies[cap] && game.colonies[cap].colonized) return cap;
    }
    const keys = Object.keys(game.colonies || {});
    for (let i = 0; i < keys.length; i++) {
      const c = game.colonies[keys[i]];
      if (c && c.colonized && c.phase !== 'settling') return keys[i];
    }
    for (let i = 0; i < keys.length; i++) {
      const c = game.colonies[keys[i]];
      if (c && c.colonized) return keys[i];
    }
    return null;
  }

  /* Flotta del giocatore presente in un sistema (arrivata, non in transito). */
  function playerFleetAt(game, sysId) {
    const fl = game.fleets || [];
    for (let i = 0; i < fl.length; i++) {
      const f = fl[i];
      if (f && f.location && f.location.systemId === sysId &&
          (f.location.status === 'orbiting' || f.location.status === 'docked')) return f;
    }
    return null;
  }

  function frontierSystems(game) {
    const disc = (game.state && game.state.discovery) || [];
    const out = [];
    for (let i = 0; i < disc.length; i++) if (disc[i] === DETECTED) out.push(i);
    return out;
  }

  function clampDisp(civ, delta) {
    if (!civ) return;
    civ.disposition = Math.max(-100, Math.min(100, (civ.disposition || 0) + delta));
  }

  function addReputation(game, delta) {
    if (ORION.diplomacy && ORION.diplomacy.adjustReputation) ORION.diplomacy.adjustReputation(game, delta);
    else if (typeof game.reputation === 'number') game.reputation = Math.max(0, Math.min(100, game.reputation + delta));
  }

  /* ------------------------------------------------------------------
     GENERAZIONE (rara/calma, deterministica)
     ------------------------------------------------------------------ */
  function eligibleTypes(game) {
    const out = [];
    const AI = ORION.ai, DIP = ORION.diplomacy;
    const nests = (AI && AI.knownNests) ? AI.knownNests(game) : [];
    if (nests.length) out.push('bounty');
    if (frontierSystems(game).length) out.push('reach');
    const contacted = (AI && AI.contactedCivs) ? AI.contactedCivs(game) : [];
    if (contacted.length) out.push('escort');
    const allies = (DIP && DIP.alliesOf) ? DIP.alliesOf(game) : [];
    if (allies.length) out.push('resupply');
    return out;
  }

  function mekhariBroker(game) {
    if (ORION.mekhari && ORION.mekhari.isAvailable && ORION.mekhari.isAvailable(game)) {
      return ORION.mekhari.mekhariCiv ? ORION.mekhari.mekhariCiv(game) : null;
    }
    return null;
  }

  function homeCluster(game) {
    if (ORION.treasury && ORION.treasury.clusterOfSystem && game.galaxy) {
      return ORION.treasury.clusterOfSystem(game, game.galaxy.homeId);
    }
    return null;
  }

  function maybeCredits(game, amount) {
    const cl = homeCluster(game);
    if (cl == null || !(ORION.treasury && ORION.treasury.addBalance)) return null;
    return { cluster: cl, amount: Math.round(amount) };
  }

  function buildMission(game, type, rng, now) {
    const id = (ORION.time && ORION.time.nextSeqId) ? ORION.time.nextSeqId(game, 'mission') : ('mission-' + now);
    const base = {
      id: id, type: type, status: 'offered',
      offeredAt: now, expiresAt: now + CFG.OFFER_TTL,
      sourceKind: 'anon', sourceCivId: null, sourceName: 'Segnalazione di frontiera',
      targetSysId: -1, holdI: 0, reward: {}, progress: {}
    };
    const sys = function (sid) { const s = game.galaxy.systems[sid]; return s ? s.name : '—'; };

    if (type === 'bounty') {
      const nests = ORION.ai.knownNests(game);
      const nest = rng.pick(nests);
      base.targetSysId = nest.sysId;
      const lvl = nest.level || 1;
      const broker = mekhariBroker(game);
      if (broker) { base.sourceKind = 'mekhari'; base.sourceCivId = broker.id; base.sourceName = broker.name; }
      base.title = 'Taglia: covo pirata su ' + sys(nest.sysId);
      base.desc = 'Un covo pirata (livello ' + lvl + ') infesta ' + sys(nest.sysId) + (nest.regionLabel ? ' · ' + nest.regionLabel : '') +
        '. Invia una flotta armata e sgominalo.';
      base.reward = { res: { met: 60 + 40 * lvl, en: 30 + 20 * lvl }, reputation: 3, credits: maybeCredits(game, 40 * lvl) };
      base.penalty = { reputation: 2, disposition: 6 };
      return base;
    }

    if (type === 'reach') {
      const fr = frontierSystems(game);
      const sid = rng.pick(fr);
      base.targetSysId = sid;
      base.sourceKind = 'anon';
      base.sourceName = 'Segnale di soccorso';
      base.title = 'Soccorso: segnale da ' + sys(sid);
      base.desc = 'Una trasmissione di soccorso proviene da ' + sys(sid) +
        ', ai margini del noto. Raggiungi il sistema con una flotta.';
      base.reward = { res: { met: 50, en: 30, food: 20 }, reputation: 2, credits: maybeCredits(game, 30) };
      base.penalty = { reputation: 1, disposition: 0 };
      return base;
    }

    if (type === 'escort') {
      const contacted = ORION.ai.contactedCivs(game);
      const civ = rng.pick(contacted);
      /* Target: un sistema noto (DETECTED+) del committente, altrimenti un
         sistema di frontiera. */
      const sysList = (civ.systems || (ORION.ai.derivedSystems ? ORION.ai.derivedSystems(civ) : [])) || [];
      const known = sysList.filter(function (s) {
        const d = (game.state && game.state.discovery) || [];
        return d[s] != null && d[s] >= DETECTED;
      });
      const sid = known.length ? rng.pick(known) : (frontierSystems(game)[0]);
      if (sid == null || sid < 0) return null;
      base.targetSysId = sid;
      base.holdI = CFG.ESCORT_HOLD;
      base.sourceKind = 'civ'; base.sourceCivId = civ.id; base.sourceName = civ.name;
      base.title = 'Scorta per ' + civ.name + ' su ' + sys(sid);
      base.desc = civ.name + ' chiede di presidiare ' + sys(sid) + ' contro i predoni per ' +
        CFG.ESCORT_HOLD + ' Ι. Tieni lì una tua flotta.';
      base.reward = { res: { en: 50, food: 30 }, reputation: 3, credits: maybeCredits(game, 50), disposition: 6 };
      base.penalty = { reputation: 3, disposition: 8 };
      return base;
    }

    if (type === 'resupply') {
      const allies = ORION.diplomacy.alliesOf(game);
      const civ = rng.pick(allies);
      const sysList = (civ.systems || (ORION.ai.derivedSystems ? ORION.ai.derivedSystems(civ) : [])) || [];
      const known = sysList.filter(function (s) {
        const d = (game.state && game.state.discovery) || [];
        return d[s] != null && d[s] >= DETECTED;
      });
      const sid = known.length ? rng.pick(known) : (sysList.length ? sysList[0] : -1);
      if (sid == null || sid < 0) return null;
      base.targetSysId = sid;
      base.holdI = CFG.RESUPPLY_HOLD;
      base.sourceKind = 'civ'; base.sourceCivId = civ.id; base.sourceName = civ.name;
      base.title = 'Rifornimento all\'alleato ' + civ.name;
      base.desc = 'L\'alleato ' + civ.name + ' chiede sostegno a ' + sys(sid) + ': mantieni lì una flotta per ' +
        CFG.RESUPPLY_HOLD + ' Ι.';
      base.reward = { res: { met: 30, en: 20 }, reputation: 4, credits: maybeCredits(game, 40), disposition: 10 };
      base.penalty = { reputation: 3, disposition: 10 };
      return base;
    }
    return null;
  }

  function attemptGenerate(game, events) {
    const meta = game.dispatchMeta;
    const now = game.timeImpulsi || 0;
    if (now < CFG.WARMUP_I) return;
    if (now % CFG.GEN_EVERY !== 0) return;
    if (meta.lastOfferAt >= 0 && (now - meta.lastOfferAt) < CFG.GEN_COOLDOWN) return;
    const open = game.missions.filter(function (m) { return m.status === 'offered' || m.status === 'active'; }).length;
    if (open >= CFG.MAX_OPEN) return;
    const elig = eligibleTypes(game);
    if (!elig.length) return;
    const rng = ORION.rng.makeRng(game.seed + ':dispatch:' + now);
    if (!rng.chance(CFG.GEN_CHANCE)) return;
    const type = rng.pick(elig);
    const m = buildMission(game, type, rng, now);
    if (!m) return;
    game.missions.push(m);
    meta.lastOfferAt = now;
    meta.offers = (meta.offers || 0) + 1;
    events.push({ kind: 'dispatch-offered', missionId: m.id, title: m.title, sourceName: m.sourceName, mtype: m.type, impulso: now });
  }

  /* ------------------------------------------------------------------
     ESITO: ricompensa / penalità
     ------------------------------------------------------------------ */
  function grantReward(game, m) {
    const r = m.reward || {};
    if (r.res) {
      const k = payColonyKey(game);
      const col = k && game.colonies[k];
      if (col && col.stock) {
        Object.keys(r.res).forEach(function (res) {
          col.stock[res] = (col.stock[res] || 0) + r.res[res];
        });
      }
    }
    if (r.credits && ORION.treasury && ORION.treasury.addBalance) {
      ORION.treasury.addBalance(game, r.credits.cluster, r.credits.amount);
    }
    if (typeof r.reputation === 'number') addReputation(game, r.reputation);
    if (typeof r.disposition === 'number' && m.sourceCivId) clampDisp(civById(game, m.sourceCivId), r.disposition);
  }

  function applyPenalty(game, m) {
    const p = m.penalty || {};
    if (typeof p.reputation === 'number') addReputation(game, -p.reputation);
    if (typeof p.disposition === 'number' && m.sourceCivId) clampDisp(civById(game, m.sourceCivId), -p.disposition);
  }

  function completeMission(game, m, events) {
    m.status = 'done';
    grantReward(game, m);
    game.dispatchMeta.completed = (game.dispatchMeta.completed || 0) + 1;
    events.push({ kind: 'dispatch-done', missionId: m.id, title: m.title, mtype: m.type, sourceName: m.sourceName, impulso: game.timeImpulsi });
  }
  function failMission(game, m, events) {
    m.status = 'failed';
    applyPenalty(game, m);
    events.push({ kind: 'dispatch-failed', missionId: m.id, title: m.title, mtype: m.type, sourceName: m.sourceName, impulso: game.timeImpulsi });
  }
  function voidMission(game, m, events, reason) {
    m.status = 'void';
    events.push({ kind: 'dispatch-void', missionId: m.id, title: m.title, reason: reason || '', impulso: game.timeImpulsi });
  }

  /* ------------------------------------------------------------------
     TRACKING (poll deterministico degli obiettivi)
     ------------------------------------------------------------------ */
  function trackActive(game, m, events) {
    const now = game.timeImpulsi || 0;
    /* Voiding per fonti civ scomparse / alleanza infranta (no penalità:
       non è colpa del giocatore). */
    if (m.sourceCivId && (m.type === 'escort' || m.type === 'resupply')) {
      const civ = civById(game, m.sourceCivId);
      if (!civ || !civ.alive) { voidMission(game, m, events, 'committente perduto'); return; }
      if (m.type === 'resupply' && ORION.diplomacy &&
          ORION.diplomacy.effectiveRelation(game, civ) === 'war') {
        voidMission(game, m, events, 'alleanza infranta'); return;
      }
    }

    let done = false;
    if (m.type === 'bounty') {
      const nests = (game.piracy && game.piracy.nests) || [];
      const exists = nests.some(function (n) { return n.sysId === m.targetSysId; });
      if (!exists) done = true;
    } else if (m.type === 'reach') {
      if (playerFleetAt(game, m.targetSysId)) done = true;
    } else { /* escort / resupply: presenza cumulata */
      if (playerFleetAt(game, m.targetSysId)) {
        m.progress.holdLeft = Math.max(0, (m.progress.holdLeft == null ? m.holdI : m.progress.holdLeft) - 1);
        if (m.progress.holdLeft <= 0) done = true;
      }
    }

    if (done) { completeMission(game, m, events); return; }
    if (now > m.deadline) { failMission(game, m, events); }
  }

  /* ------------------------------------------------------------------
     TICK (chiamato da time.js)
     ------------------------------------------------------------------ */
  function tick(game, events) {
    if (!game) return;
    ensure(game);
    const now = game.timeImpulsi || 0;
    /* Scadenza offerte non accettate (silenziosa). */
    for (let i = 0; i < game.missions.length; i++) {
      const m = game.missions[i];
      if (m.status === 'offered' && now > m.expiresAt) {
        m.status = 'expired';
        events.push({ kind: 'dispatch-expired', missionId: m.id, title: m.title, impulso: now });
      }
    }
    /* Tracking obiettivi attivi. */
    for (let i = 0; i < game.missions.length; i++) {
      if (game.missions[i].status === 'active') trackActive(game, game.missions[i], events);
    }
    /* Prune dei risolti (offered+active restano). */
    game.missions = game.missions.filter(function (m) {
      return m.status === 'offered' || m.status === 'active';
    });
    /* Generazione (rara/calma). */
    attemptGenerate(game, events);
  }

  /* Per nextEventImpulsi: fermati alla scadenza più vicina di una missione
     attiva, così un fallimento non viene "saltato" in fast-forward. */
  function nextEventDelta(game) {
    if (!game || !Array.isArray(game.missions)) return 0;
    const now = game.timeImpulsi || 0;
    let best = Infinity;
    for (let i = 0; i < game.missions.length; i++) {
      const m = game.missions[i];
      if (m.status === 'active' && m.deadline) {
        const d = m.deadline - now;
        if (d > 0 && d < best) best = d;
      }
      if (m.status === 'offered' && m.expiresAt) {
        const d = m.expiresAt - now;
        if (d > 0 && d < best) best = d;
      }
    }
    return isFinite(best) ? best : 0;
  }

  /* ------------------------------------------------------------------
     AZIONI DEL GIOCATORE
     ------------------------------------------------------------------ */
  function find(game, id) {
    return (game.missions || []).filter(function (m) { return m.id === id; })[0] || null;
  }

  function accept(game, id) {
    const m = find(game, id);
    if (!m || m.status !== 'offered') return { ok: false, reason: 'Incarico non disponibile' };
    const now = game.timeImpulsi || 0;
    m.status = 'active';
    m.acceptedAt = now;
    m.deadline = now + CFG.DEADLINE;
    m.progress = { holdLeft: m.holdI || 0 };
    return { ok: true };
  }

  function decline(game, id) {
    const m = find(game, id);
    if (!m || m.status !== 'offered') return { ok: false, reason: 'Incarico non disponibile' };
    /* Rifiutare una richiesta di una civiltà la indispone un poco
       (§17.4: accettare/rifiutare ha conseguenze). Le anonime no. */
    if (m.sourceCivId) clampDisp(civById(game, m.sourceCivId), -2);
    game.missions = game.missions.filter(function (x) { return x.id !== id; });
    return { ok: true };
  }

  function abandon(game, id) {
    const m = find(game, id);
    if (!m || m.status !== 'active') return { ok: false, reason: 'Incarico non attivo' };
    /* Rinuncia dopo l'impegno: penalità lieve (recovery-friendly #22). */
    if (m.sourceCivId) clampDisp(civById(game, m.sourceCivId), -4);
    addReputation(game, -1);
    game.missions = game.missions.filter(function (x) { return x.id !== id; });
    return { ok: true };
  }

  /* ------------------------------------------------------------------
     MEMORIA STORICA §17.2 — log milestone permanente
     Registrata in runAdvance (main.js) per OGNI evento. Idempotente:
     i "firsts" sono gated dal seen-set ricostruito in ensure().
     ------------------------------------------------------------------ */
  const MEMORIA = {
    'colony-done':       { first: true,  mod: 'planet', text: function (ev) { return 'Prima colonia fondata oltre la capitale' + (ev.planet && ev.planet.name ? ': ' + ev.planet.name : '') + '.'; } },
    'civ-contact':       { first: true,  mod: 'civ',    text: function (ev) { return 'Primo contatto con un\'altra civiltà' + (ev.civName ? ': ' + ev.civName : '') + '.'; } },
    'diplo-alliance':    { first: true,  mod: 'civ',    text: function (ev) { return 'Prima alleanza siglata' + (ev.civName ? ' con ' + ev.civName : '') + '.'; } },
    'research-complete': { first: true,  mod: 'planet', text: function (ev) { return 'Prima tecnologia sbloccata' + (ev.techLabel || ev.label ? ': ' + (ev.techLabel || ev.label) : '') + '.'; } },
    'capital-built':     { first: true,  mod: 'planet', text: function () { return 'Prima grande nave capitale varata.'; } },
    'capital-declared':  { first: true,  mod: 'planet', text: function () { return 'Prima capitale di gruppo proclamata.'; } },
    'commander-promoted':{ first: true,  mod: 'figure', text: function () { return 'Prima figura nominata emerge dalle file dell\'Impero.'; } },
    'station-built':     { first: true,  mod: 'planet', text: function () { return 'Prima stazione spaziale eretta.'; } },
    'dispatch-done':     { first: true,  mod: 'civ',    text: function () { return 'Primo incarico portato a termine.'; } },
    /* Svolte maggiori — non "firsts" (ogni occorrenza è storia). */
    'colony-conquered':  { first: false, mod: 'crit',   text: function (ev) { return 'Una colonia è stata conquistata dal nemico.'; } },
    'colony-razed':      { first: false, mod: 'crit',   text: function (ev) { return 'Una colonia è stata rasa al suolo.'; } },
    'empire-fallen':     { first: false, mod: 'crit',   text: function () { return 'L\'Impero è caduto: esilio tra le stelle.'; } },
    'victory':           { first: false, mod: 'ok',     text: function (ev) { return 'Vittoria' + (ev.trackLabel ? ' — ' + ev.trackLabel : '') + '.'; } }
  };

  function recordMemoria(game, ev) {
    if (!game || !ev) return;
    if (!game._memoriaSeen) rebuildMemoriaSeen(game);
    const def = MEMORIA[ev.kind];
    if (!def) return;
    if (def.first && game._memoriaSeen[ev.kind]) return;
    if (!Array.isArray(game.memoria)) game.memoria = [];
    const key = def.first ? ev.kind : (ev.kind + ':' + (ev.impulso || 0));
    game.memoria.unshift({ impulso: ev.impulso || (game.timeImpulsi || 0), text: def.text(ev), mod: def.mod, key: key, first: !!def.first });
    if (def.first) game._memoriaSeen[ev.kind] = true;
  }

  /* ------------------------------------------------------------------ */
  function pendingOffers(game) {
    return (game.missions || []).filter(function (m) { return m.status === 'offered'; });
  }
  function activeMissions(game) {
    return (game.missions || []).filter(function (m) { return m.status === 'active'; });
  }

  ORION.dispatch = {
    CFG: CFG,
    ensure: ensure,
    tick: tick,
    nextEventDelta: nextEventDelta,
    recordMemoria: recordMemoria,
    accept: accept,
    decline: decline,
    abandon: abandon,
    find: find,
    pendingOffers: pendingOffers,
    activeMissions: activeMissions,
    payColonyKey: payColonyKey,
    playerFleetAt: playerFleetAt
  };
})(typeof window !== 'undefined' ? window : this);
