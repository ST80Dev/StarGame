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
    RESUPPLY_HOLD: 50,    // Ι di presenza richiesti (rifornimento)
    /* M17 Fase B (#83) — covi-boss + contractor Mekhari. */
    BOSS_CAP: 2,          // max covi-boss nominati per partita
    BOSS_DANGER_MIN: 0.55,// solo nei sistemi profondi/pericolosi
    BOSS_REWARD_MUL: 2.4, // ricompensa taglia-boss (premium, solo risorse/crediti)
    HUNT_BASE_CREDITS: 90,// costo base contractor (× livello, × boss)
    HUNT_DURATION: 130,   // Ι prima che i cacciatori sgominino il covo
    /* M17 Fase C (#83) — crisi galattiche + Sopravvissuto. */
    CRISIS_ICG_TIERS: [40, 60, 80], // soglie ICG che innescano crisi galattiche
    CRISIS_TTL: 60,       // Ι per decidere prima della conseguenza di default
    CRISIS_THREAT_ETA: 35,// preavviso della minaccia spawnata (recovery #22)
    SURV_FIRST: 3000,     // primo evento Sopravvissuto (calmo/tardivo)
    SURV_GAP: 2500,       // distanza tra le ondate
    SURV_WAVES: 6,        // ondate programmate (poi M20/§19)
    /* Courtship mode (feedback utente 2026-06-15, decisione "early-game pacing"):
       se il giocatore non ha MAI visto un'offerta entro COURTSHIP_TRIGGER_I,
       il dispatcher entra in modalità "corteggiamento" — soglie più morbide
       per garantire che almeno una offerta arrivi, così l'utente *scopre*
       che il sistema esiste. Decade automaticamente al primo offered o al
       primo accepted (whichever first). Non modifica il design "calma"
       (decisione #52): è un correttivo per chi è in stallo, non un boost
       permanente. */
    COURTSHIP_TRIGGER_I: 1500, // se 0 offerte mai a questo Ι → on
    COURTSHIP_CHANCE_MUL: 2.0, // moltiplicatore CHANCE (clamp 0.8)
    COURTSHIP_COOLDOWN_MUL: 0.5 // moltiplicatore COOLDOWN
  };

  const BOSS_TITLES = ['Sciacallo', 'Falce', 'Artiglio', 'Vipera', 'Corsaro', 'Spettro', 'Lama', 'Avvoltoio'];
  const BOSS_EPITHETS = ['Cremisi', 'del Vuoto', 'Nero', 'di Ferro', 'Spezzaossa', 'Scarlatto', 'dell\'Abisso'];

  /* ------------------------------------------------------------------
     LIFECYCLE / ENSURE
     ------------------------------------------------------------------ */
  function ensure(game) {
    if (!game) return;
    if (!Array.isArray(game.missions)) game.missions = [];
    if (!Array.isArray(game.memoria)) game.memoria = [];
    if (!game.dispatchMeta || typeof game.dispatchMeta !== 'object') {
      game.dispatchMeta = { lastOfferAt: -1, offers: 0, completed: 0, accepted: 0 };
    } else if (typeof game.dispatchMeta.accepted !== 'number') {
      /* Save di pre-feedback-2026-06-15: campo accepted assente. Lazy-init,
         additivo, niente migrazione di schema. */
      game.dispatchMeta.accepted = 0;
    }
    /* M17 Fase B (#83): contractor Mekhari attivi (auto-risolutivi). */
    if (!Array.isArray(game.contracts)) game.contracts = [];
    /* M17 Fase C (#83): crisi pendenti + meta soglie ICG. */
    if (!Array.isArray(game.crises)) game.crises = [];
    if (!game.crisisMeta || typeof game.crisisMeta !== 'object') game.crisisMeta = { icgTier: 0 };
    ensureSurvivorSchedule(game);
    rebuildMemoriaSeen(game);
  }

  /* Popola eventSchedule (gancio #23) con le ondate del Sopravvissuto §17,
     se assenti. Sparse e tardive (calmo). Idempotente. */
  function ensureSurvivorSchedule(game) {
    if (!Array.isArray(game.eventSchedule)) game.eventSchedule = [];
    if (game.eventSchedule.some(function (e) { return e && e.kind === 'survivor'; })) return;
    for (let n = 1; n <= CFG.SURV_WAVES; n++) {
      game.eventSchedule.push({
        id: 'surv-' + n, kind: 'survivor',
        at: CFG.SURV_FIRST + (n - 1) * CFG.SURV_GAP, sev: n, fired: false
      });
    }
  }

  /* M17 Fase B (#83): promozione deterministica di alcuni covi a BOSS
     nominati (più duri in combattimento via combat.forceFromPirateNest).
     Vivono nei sistemi profondi/pericolosi; cap BOSS_CAP. I flag
     (boss/name/bossTier) vivono in game.piracy.nests (auto-serializzati).
     Idempotente: non ri-promuove i già nominati. */
  function ensureBosses(game) {
    const nests = (game.piracy && game.piracy.nests) || [];
    if (!nests.length) return;
    let bossCount = nests.filter(function (n) { return n.boss; }).length;
    if (bossCount >= CFG.BOSS_CAP) return;
    /* Candidati ordinati per pericolo decrescente (deterministico per sysId). */
    const cand = nests.filter(function (n) {
      if (n.boss) return false;
      const s = game.galaxy.systems[n.sysId];
      return s && (s.danger || 0) >= CFG.BOSS_DANGER_MIN;
    }).sort(function (a, b) {
      const da = game.galaxy.systems[a.sysId].danger || 0;
      const db = game.galaxy.systems[b.sysId].danger || 0;
      if (db !== da) return db - da;
      return a.sysId - b.sysId;
    });
    for (let i = 0; i < cand.length && bossCount < CFG.BOSS_CAP; i++) {
      const n = cand[i];
      const rng = ORION.rng.makeRng(game.seed + ':boss:' + n.sysId);
      if (!rng.chance(0.5)) continue;
      n.boss = true;
      n.bossTier = 1 + rng.int(0, 1);
      n.name = rng.pick(BOSS_TITLES) + ' ' + rng.pick(BOSS_EPITHETS);
      bossCount++;
    }
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

  function addReputation(game, delta, source, label) {
    if (!delta) return;
    /* M18: passiamo dalla façade reputation.applyAndRecord che applica
       il clamp 0..100 e registra nello storico se label/source danno
       contesto. Manteniamo fallback diplomacy/inline per compat. */
    if (ORION.reputation && ORION.reputation.applyAndRecord && (label || source)) {
      ORION.reputation.applyAndRecord(game, 'rep', delta, source || 'dispatch', label || '');
      return;
    }
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
      /* Preferisci un covo-BOSS noto (taglia maggiore, ricompensa premium). */
      const realOf = function (sid) { return ((game.piracy && game.piracy.nests) || []).filter(function (n) { return n.sysId === sid; })[0]; };
      const bossKnown = nests.filter(function (k) { const r = realOf(k.sysId); return r && r.boss; });
      const nest = bossKnown.length ? rng.pick(bossKnown) : rng.pick(nests);
      const real = realOf(nest.sysId);
      const isBoss = !!(real && real.boss);
      base.targetSysId = nest.sysId;
      base.boss = isBoss;
      const lvl = nest.level || 1;
      const broker = mekhariBroker(game);
      if (broker) { base.sourceKind = 'mekhari'; base.sourceCivId = broker.id; base.sourceName = broker.name; }
      const mul = isBoss ? CFG.BOSS_REWARD_MUL : 1;
      if (isBoss) {
        base.title = 'Taglia maggiore: ' + (real.name || 'covo pirata') + ' su ' + sys(nest.sysId);
        base.desc = 'Il temuto covo-boss ' + (real.name || '—') + ' (livello ' + lvl + ', scortato) infesta ' +
          sys(nest.sysId) + (nest.regionLabel ? ' · ' + nest.regionLabel : '') +
          '. Servirà una flotta robusta — o dei cacciatori prezzolati. Ricompensa premium.';
      } else {
        base.title = 'Taglia: covo pirata su ' + sys(nest.sysId);
        base.desc = 'Un covo pirata (livello ' + lvl + ') infesta ' + sys(nest.sysId) + (nest.regionLabel ? ' · ' + nest.regionLabel : '') +
          '. Invia una flotta armata e sgominalo.';
      }
      base.reward = {
        res: { met: Math.round((60 + 40 * lvl) * mul), en: Math.round((30 + 20 * lvl) * mul) },
        reputation: isBoss ? 5 : 3, credits: maybeCredits(game, Math.round(40 * lvl * mul))
      };
      base.penalty = { reputation: isBoss ? 3 : 2, disposition: 6 };
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

  /* Courtship: il giocatore non ha mai visto un'offerta dopo
     COURTSHIP_TRIGGER_I → il dispatcher diventa più "premuroso" finché
     non ne arriva almeno una (poi torna al ritmo standard). Decisione
     "early-game pacing" 2026-06-15. */
  function isCourtship(game) {
    const meta = game.dispatchMeta;
    if (!meta) return false;
    const now = game.timeImpulsi || 0;
    return now >= CFG.COURTSHIP_TRIGGER_I &&
           (meta.offers || 0) === 0 &&
           (meta.accepted || 0) === 0;
  }

  function attemptGenerate(game, events) {
    const meta = game.dispatchMeta;
    const now = game.timeImpulsi || 0;
    const courtship = isCourtship(game);
    /* In courtship saltiamo il vincolo di WARMUP (siamo molto oltre).
       Mantieniamo il rate di tentativo per non rompere il determinismo
       sul tick allineato. */
    if (!courtship && now < CFG.WARMUP_I) return;
    if (now % CFG.GEN_EVERY !== 0) return;
    const cooldown = courtship ? Math.max(50, Math.round(CFG.GEN_COOLDOWN * CFG.COURTSHIP_COOLDOWN_MUL)) : CFG.GEN_COOLDOWN;
    if (meta.lastOfferAt >= 0 && (now - meta.lastOfferAt) < cooldown) return;
    const open = game.missions.filter(function (m) { return m.status === 'offered' || m.status === 'active'; }).length;
    if (open >= CFG.MAX_OPEN) return;
    const elig = eligibleTypes(game);
    if (!elig.length) return;
    const rng = ORION.rng.makeRng(game.seed + ':dispatch:' + now);
    const chance = courtship ? Math.min(0.8, CFG.GEN_CHANCE * CFG.COURTSHIP_CHANCE_MUL) : CFG.GEN_CHANCE;
    if (!rng.chance(chance)) return;
    const type = rng.pick(elig);
    const m = buildMission(game, type, rng, now);
    if (!m) return;
    game.missions.push(m);
    meta.lastOfferAt = now;
    meta.offers = (meta.offers || 0) + 1;
    /* Annotazione courtship per la cronaca: il primo offered ne è esce. */
    if (courtship) m.fromCourtship = true;
    events.push({ kind: 'dispatch-offered', missionId: m.id, title: m.title, sourceName: m.sourceName, mtype: m.type, impulso: now, courtship: !!courtship });
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
    if (typeof r.reputation === 'number') addReputation(game, r.reputation, 'dispatch', 'Missione completata: ' + (m.title || m.type || '—'));
    if (typeof r.disposition === 'number' && m.sourceCivId) clampDisp(civById(game, m.sourceCivId), r.disposition);
  }

  function applyPenalty(game, m) {
    const p = m.penalty || {};
    if (typeof p.reputation === 'number') addReputation(game, -p.reputation, 'dispatch', 'Missione fallita: ' + (m.title || m.type || '—'));
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
    ensureBosses(game);
    processContracts(game, events);
    /* M17 Fase C: crisi (timeout default → poi nuovi inneschi). */
    processCrisisTimeout(game, events);
    maybeFireGalacticCrisis(game, events);
    maybeFireSurvivorCrisis(game, events);
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
    /* Contractor Mekhari in corso (Fase B): fermati alla risoluzione. */
    (game.contracts || []).forEach(function (c) {
      if (c.status === 'active' && c.resolveAt) {
        const d = c.resolveAt - now;
        if (d > 0 && d < best) best = d;
      }
    });
    /* M17 Fase C: crisi pendente (scadenza) + prossima ondata Sopravvissuto. */
    (game.crises || []).forEach(function (c) {
      if (c.status === 'pending' && c.expiresAt) {
        const d = c.expiresAt - now;
        if (d > 0 && d < best) best = d;
      }
    });
    (game.eventSchedule || []).forEach(function (e) {
      if (e && e.kind === 'survivor' && !e.fired && e.at) {
        const d = e.at - now;
        if (d > 0 && d < best) best = d;
      }
    });
    return isFinite(best) ? best : 0;
  }

  /* ------------------------------------------------------------------
     CONTRACTOR MEKHARI (freelance, decisione #83 Fase B) — auto-risolutivo
     Paghi crediti (Tesoreria) → dopo HUNT_DURATION Ι i cacciatori sgominano
     il covo (nessuna flotta da gestire). Sinergia: se sul covo c'è una taglia
     attiva, si completa da sola al "covo sparito" (tracking esistente).
     ------------------------------------------------------------------ */
  function nestAt(game, sysId) {
    return ((game.piracy && game.piracy.nests) || []).filter(function (n) { return n.sysId === sysId; })[0] || null;
  }

  /* Preventivo: costo in crediti per assoldare i cacciatori su un covo. */
  function huntQuote(game, sysId) {
    if (!(ORION.mekhari && ORION.mekhari.isAvailable && ORION.mekhari.isAvailable(game))) {
      return { ok: false, reason: 'Cacciatori non disponibili (contatta i Mekhari)' };
    }
    const nest = nestAt(game, sysId);
    if (!nest) return { ok: false, reason: 'Nessun covo noto in quel sistema' };
    if ((game.contracts || []).some(function (c) { return c.targetSysId === sysId && c.status === 'active'; })) {
      return { ok: false, reason: 'Cacciatori già ingaggiati su quel covo' };
    }
    const lvl = nest.level || 1;
    const sc = (ORION.mekhari.surcharge ? ORION.mekhari.surcharge(game) : 0.35);
    const credits = Math.round(CFG.HUNT_BASE_CREDITS * lvl * (nest.boss ? 2 : 1) * (1 + sc));
    return { ok: true, credits: credits, level: lvl, boss: !!nest.boss, name: nest.name || null };
  }

  function hireHunter(game, sysId) {
    const q = huntQuote(game, sysId);
    if (!q.ok) return q;
    const T = ORION.treasury;
    if (!T || !T.spendCredits) return { ok: false, reason: 'Tesoreria non disponibile' };
    const pay = T.spendCredits(game, q.credits);
    if (!pay.ok) return { ok: false, reason: pay.reason || 'Crediti insufficienti' };
    const now = game.timeImpulsi || 0;
    if (!Array.isArray(game.contracts)) game.contracts = [];
    const id = (ORION.time && ORION.time.nextSeqId) ? ORION.time.nextSeqId(game, 'contract') : ('contract-' + now);
    const nest = nestAt(game, sysId);
    game.contracts.push({
      id: id, kind: 'hunt', targetSysId: sysId,
      name: (nest && nest.name) || null, boss: !!(nest && nest.boss),
      resolveAt: now + CFG.HUNT_DURATION, cost: q.credits, status: 'active'
    });
    return { ok: true, credits: q.credits, eta: CFG.HUNT_DURATION };
  }

  function processContracts(game, events) {
    if (!Array.isArray(game.contracts) || !game.contracts.length) return;
    const now = game.timeImpulsi || 0;
    let changed = false;
    for (let i = 0; i < game.contracts.length; i++) {
      const c = game.contracts[i];
      if (c.status !== 'active' || now < c.resolveAt) continue;
      /* I cacciatori sgominano il covo (se ancora c'è). */
      const nests = (game.piracy && game.piracy.nests) || [];
      const idx = nests.findIndex(function (n) { return n.sysId === c.targetSysId; });
      if (idx >= 0) { nests.splice(idx, 1); }
      c.status = 'done';
      changed = true;
      events.push({ kind: 'mekhari-contract-done', sysId: c.targetSysId, name: c.name, boss: c.boss, impulso: now });
    }
    if (changed) game.contracts = game.contracts.filter(function (c) { return c.status === 'active'; });
  }

  /* ==================================================================
     CRISI GALATTICHE + SOPRAVVISSUTO (decisione #83 Fase C)
     Modale a scelte (l'altra metà dell'ibrido): un evento-crisi ferma il
     tempo (auto-pausa) e presenta 2-3 scelte. Conseguenze = MINACCE REALI
     (spawn di incursioni pirata via il motore M09) + effetti soft, sempre
     recovery-friendly (#22: annunciate, graduali, mai a freddo).
     ================================================================== */

  /* Sistema di una colonia del giocatore su cui dirigere una minaccia
     (capitale del gruppo natale, altrimenti la prima operativa). */
  function threatTargetSys(game) {
    const k = payColonyKey(game);
    if (k && game.colonies[k]) return game.colonies[k].systemId;
    return -1;
  }

  /* Spawna una minaccia pirata reale verso una colonia (riusa la pipeline
     incursione→assedio di time.js/processIncursions). Recovery-friendly:
     preavviso CRISIS_THREAT_ETA, una sola incursione per sistema. */
  function spawnThreat(game, level, events) {
    const sysId = threatTargetSys(game);
    if (sysId < 0) return false;
    if (!Array.isArray(game.incursions)) game.incursions = [];
    if (game.incursions.some(function (x) { return x.targetSysId === sysId; })) return false;
    const now = game.timeImpulsi || 0;
    const id = (ORION.time && ORION.time.nextSeqId) ? ORION.time.nextSeqId(game, 'inc') : ('inc-crisis-' + now);
    game.incursions.push({
      id: id, kind: 'pirate', fromSysId: sysId, targetSysId: sysId,
      targetColonyKey: null, targetStationId: null,
      level: Math.max(1, level), eta: CFG.CRISIS_THREAT_ETA, launchedAt: now
    });
    events.push({
      kind: 'incursion-inbound', incursionId: id, targetSysId: sysId,
      eta: CFG.CRISIS_THREAT_ETA, impulso: now
    });
    return true;
  }

  /* Catalogo crisi — galattiche (per tier ICG) e Sopravvissuto (per ondata).
     Ogni scelta è un descrittore di effetti applicato da applyCrisisChoice.
     `def` = scelta di default applicata allo scadere (inazione). */
  function galacticCrisis(sev) {
    if (sev <= 1) {
      return { title: 'Disordini di frontiera',
        body: 'Bande e tumulti montano ai confini noti: la corruzione galattica cresce. Come rispondi?',
        choices: [
          { id: 'fortify', label: 'Rafforza le difese', desc: 'Spendi risorse, eviti la minaccia.', res: { met: -120, en: -60 }, reputation: 1 },
          { id: 'ignore', label: 'Lascia correre', desc: 'Nessun costo ora, ma i predoni colpiranno.', threat: 1, icg: 3 }
        ], defaultId: 'ignore' };
    }
    if (sev === 2) {
      return { title: 'Coalizione di predoni',
        body: 'Una coalizione di predoni si arma e punta i tuoi mondi. Le opzioni sul tavolo:',
        choices: [
          { id: 'tribute', label: 'Paga tributo', desc: 'Crediti e reputazione, ma li tieni a bada.', res: { met: -220 }, reputation: -3 },
          { id: 'fight', label: 'Affrontali', desc: 'Niente costi: arriva un\'incursione, ma puoi vincerla.', threat: 2 },
          { id: 'ignore', label: 'Ignora', desc: 'Rischio peggiore: incursione + corruzione su.', threat: 2, icg: 5 }
        ], defaultId: 'ignore' };
    }
    return { title: 'Collasso incipiente',
      body: 'La corruzione galattica è altissima: ondate ostili premono da ogni lato. Mobiliti l\'impero?',
      choices: [
        { id: 'mobilize', label: 'Mobilita l\'impero', desc: 'Spesa pesante, ma allenti la pressione.', res: { met: -280, en: -160 }, pressure: -0.25, reputation: 2 },
        { id: 'endure', label: 'Resisti all\'urto', desc: 'Affronti un\'incursione grossa a mani nude.', threat: 3 }
      ], defaultId: 'endure' };
  }

  function survivorCrisis(sev) {
    return { title: 'Ondata di sopravvivenza ' + sev,
      body: 'Un\'orda esterna converge sui tuoi mondi (ondata ' + sev + '). Più a lungo sopravvivi, più dura.',
      choices: [
        { id: 'entrench', label: 'Trincerati', desc: 'Spendi risorse per assorbire l\'urto.', res: { met: -100 * sev, en: -50 * sev }, pressure: 0 },
        { id: 'face', label: 'Affronta l\'ondata', desc: 'Arriva un\'incursione (forza ' + sev + ').', threat: sev }
      ], defaultId: 'face' };
  }

  function makeCrisis(game, scope, sev) {
    const tpl = (scope === 'survivor') ? survivorCrisis(sev) : galacticCrisis(sev);
    const now = game.timeImpulsi || 0;
    const id = (ORION.time && ORION.time.nextSeqId) ? ORION.time.nextSeqId(game, 'crisis') : ('crisis-' + now);
    return {
      id: id, scope: scope, sev: sev, title: tpl.title, body: tpl.body,
      choices: tpl.choices, defaultId: tpl.defaultId,
      raisedAt: now, expiresAt: now + CFG.CRISIS_TTL, status: 'pending'
    };
  }

  function hasPendingCrisis(game) {
    return (game.crises || []).some(function (c) { return c.status === 'pending'; });
  }

  function applyCrisisChoice(game, crisis, choice, events) {
    if (!choice) return;
    if (choice.res) {
      const k = payColonyKey(game);
      const col = k && game.colonies[k];
      if (col && col.stock) Object.keys(choice.res).forEach(function (r) {
        col.stock[r] = Math.max(0, (col.stock[r] || 0) + choice.res[r]);
      });
    }
    const crisisLabel = 'Crisi: ' + (crisis && crisis.title ? crisis.title : '—') + ' → ' + (choice.label || choice.id || '');
    if (typeof choice.reputation === 'number') addReputation(game, choice.reputation, 'crisis', crisisLabel);
    if (typeof choice.icg === 'number') {
      if (ORION.reputation && ORION.reputation.applyAndRecord) {
        ORION.reputation.applyAndRecord(game, 'icg', choice.icg, 'crisis', crisisLabel);
      } else if (typeof game.icg === 'number') {
        game.icg = Math.max(0, Math.min(100, game.icg + choice.icg));
      }
    }
    if (typeof choice.pressure === 'number' && game.warState) {
      game.warState.pressure = Math.max(0, Math.min(1, (game.warState.pressure || 0) + choice.pressure));
    }
    if (typeof choice.threat === 'number' && choice.threat > 0) {
      spawnThreat(game, choice.threat, events);
    }
  }

  /* Innesco crisi galattiche a soglie ICG crescenti (escalation §19). */
  function maybeFireGalacticCrisis(game, events) {
    if (typeof game.icg !== 'number') return;
    if (hasPendingCrisis(game)) return;
    const tiers = CFG.CRISIS_ICG_TIERS;
    const doneTier = game.crisisMeta.icgTier || 0;
    for (let i = 0; i < tiers.length; i++) {
      if (game.icg >= tiers[i] && doneTier < tiers[i]) {
        game.crisisMeta.icgTier = tiers[i];
        const c = makeCrisis(game, 'galactic', i + 1);
        game.crises.push(c);
        events.push({ kind: 'crisis-raised', crisisId: c.id, scope: 'galactic', title: c.title, impulso: game.timeImpulsi });
        return;
      }
    }
  }

  /* Innesco ondate del Sopravvissuto da eventSchedule. */
  function maybeFireSurvivorCrisis(game, events) {
    if (hasPendingCrisis(game)) return;
    const now = game.timeImpulsi || 0;
    const sched = game.eventSchedule || [];
    for (let i = 0; i < sched.length; i++) {
      const e = sched[i];
      if (e && e.kind === 'survivor' && !e.fired && now >= e.at) {
        e.fired = true;
        const c = makeCrisis(game, 'survivor', e.sev || 1);
        game.crises.push(c);
        events.push({ kind: 'crisis-raised', crisisId: c.id, scope: 'survivor', title: c.title, impulso: now });
        return;
      }
    }
  }

  /* Scadenza: applica la scelta di default (inazione) se il giocatore non
     ha deciso entro CRISIS_TTL. Mai bloccante. */
  function processCrisisTimeout(game, events) {
    const now = game.timeImpulsi || 0;
    let changed = false;
    (game.crises || []).forEach(function (c) {
      if (c.status !== 'pending' || now <= c.expiresAt) return;
      const choice = c.choices.filter(function (x) { return x.id === c.defaultId; })[0] || c.choices[c.choices.length - 1];
      applyCrisisChoice(game, c, choice, events);
      c.status = 'lapsed';
      changed = true;
      events.push({ kind: 'crisis-lapsed', crisisId: c.id, title: c.title, choiceLabel: choice.label, impulso: now });
    });
    if (changed) game.crises = game.crises.filter(function (c) { return c.status === 'pending'; });
  }

  /* Azione del giocatore: risolve una crisi con la scelta scelta. */
  function resolveCrisis(game, crisisId, choiceId) {
    const c = (game.crises || []).filter(function (x) { return x.id === crisisId && x.status === 'pending'; })[0];
    if (!c) return { ok: false, reason: 'Crisi non disponibile' };
    const choice = c.choices.filter(function (x) { return x.id === choiceId; })[0];
    if (!choice) return { ok: false, reason: 'Scelta non valida' };
    const evs = [];
    applyCrisisChoice(game, c, choice, evs);
    c.status = 'resolved';
    game.crises = game.crises.filter(function (x) { return x.status === 'pending'; });
    return { ok: true, label: choice.label, events: evs };
  }

  function activeCrises(game) {
    return (game.crises || []).filter(function (c) { return c.status === 'pending'; });
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
    /* Courtship tracking: il primo accept conferma che l'utente sa giocare
       il sistema → niente più "modalità premurosa" anche se in futuro
       restasse senza offerte in finestra. */
    if (game.dispatchMeta) game.dispatchMeta.accepted = (game.dispatchMeta.accepted || 0) + 1;
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
    'anomaly-relic-found': { first: true, mod: 'ok',     text: function () { return 'Prima reliquia antica esplorata: tracce di una civiltà perduta.'; } },
    'crisis-raised':     { first: true,  mod: 'crit',   text: function (ev) { return 'Prima crisi galattica: ' + (ev.title || '—') + '.'; } },
    /* FSP §17.7 — meraviglia del vuoto (unico, event-tier). Ogni occorrenza
       è storia (0-2 per galassia, rari). */
    'fsp-unique':        { first: false, mod: 'ok',     text: function (ev) { return 'Meraviglia del vuoto rivelata: ' + (ev.name || 'un fenomeno antico') + (ev.sysName ? ' presso ' + ev.sysName : '') + '.'; } },
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
  function activeContracts(game) {
    return (game.contracts || []).filter(function (c) { return c.status === 'active'; });
  }
  /* Covi noti con flag boss/name (per la UI cacciatori). */
  function knownNestsDetailed(game) {
    const AI = ORION.ai;
    const base = (AI && AI.knownNests) ? AI.knownNests(game) : [];
    return base.map(function (k) {
      const real = nestAt(game, k.sysId);
      return { sysId: k.sysId, level: k.level, regionLabel: k.regionLabel,
        sysName: k.name, boss: !!(real && real.boss), bossName: real ? real.name : null };
    });
  }

  ORION.dispatch = {
    CFG: CFG,
    ensure: ensure,
    ensureBosses: ensureBosses,
    tick: tick,
    nextEventDelta: nextEventDelta,
    recordMemoria: recordMemoria,
    accept: accept,
    decline: decline,
    abandon: abandon,
    find: find,
    pendingOffers: pendingOffers,
    activeMissions: activeMissions,
    activeContracts: activeContracts,
    knownNestsDetailed: knownNestsDetailed,
    huntQuote: huntQuote,
    hireHunter: hireHunter,
    activeCrises: activeCrises,
    resolveCrisis: resolveCrisis,
    payColonyKey: payColonyKey,
    playerFleetAt: playerFleetAt,
    isCourtship: isCourtship
  };
})(typeof window !== 'undefined' ? window : this);
