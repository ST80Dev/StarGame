/* =====================================================================
   ORION EMPIRES — aifleet.js
   Modulo M18.x · FLOTTE AMBIENTALI AI + SENSORI (richiesta utente
   2026-06-18).

   PROBLEMA: l'AI di M10 (ai.js) è AGGREGATA/territoriale e dorme fino
   all'Impulso 500 (AI_WARMUP_I). Risultato: early game "spento" — nessuna
   flotta altrui si muove fra i sistemi, nulla da rilevare/incrociare.

   QUESTO MODULO aggiunge uno strato LEGGERO e SEPARATO di flotte AI
   *fisiche* che viaggiano sulla mappa fin da subito (esploratori,
   estrattori diretti alle anomalie, trasporti), indipendenti dal warm-up
   delle incursioni ostili (che restano in ai.js). Sono "vita ambientale":
   movimento pari a quello del giocatore.

   RILEVAMENTO (radar per-flotta): le colonie e le tue flotte hanno una
   copertura sensori (fleet.fleetSensor). Una flotta AI che entra in
   copertura viene rilevata con probabilità ∝ qualità sensore − firma
   della flotta AI; l'intel sulla composizione cresce nel tempo.

   OSTILITÀ PROPORZIONATA (decisione utente): se una flotta AI di una civ
   ostile (in guerra / predona malevola) incrocia una tua flotta, può
   scattare una scaramuccia LEGGERA e proporzionata all'early game (le
   flotte ambientali sono fatte di scafi leggeri → fp basso; danno
   limitato e mai letale all'intera flotta — recovery-friendly #22).

   DETERMINISMO (#5): zero Math.random. Tutti gli RNG derivano dal seed
   (`<seed>:aif:...`). Stesso seed + stessa sequenza → stesso esito.

   PERSISTENZA: game.aiFleets[] (schema 32, additivo/lazy).
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  const CFG = {
    /* Cadenza DECISIONI (spawn). Il MOVIMENTO avanza a ogni Impulso. */
    EVERY_I: 8,
    /* Movimento ambientale attivo molto presto (NON gated dal warm-up 500
       delle incursioni): basta che la galassia/civiltà esistano. */
    START_I: 24,
    GLOBAL_CAP: 7,          // max flottiglie ambientali simultanee
    PER_CIV_CAP: 2,
    SPAWN_PER_TICK: 2,      // max spawn per decisione (anti-burst)
    SPAWN_CHANCE: 0.16,     // per civ idonea per decisione
    SPAWN_RAMP_I: 1500,     // sotto: chance scalata (decollo dolce, non rigido)
    MAX_HOPS: 6,            // lunghezza massima di una rotta ambientale
    LINGER_MIN: 16,
    LINGER_MAX: 48,

    /* Sensori. */
    COLONY_SENSOR: 0.62,    // potenza rilevamento passiva di una colonia
    COLONY_RANGE_FALLOFF: 0.55, // copertura sui sistemi adiacenti (×)
    DETECT_BASE: 0.22,      // offset prob. rilevamento
    INTEL_GAIN: 0.16,       // crescita intel/Impulso in copertura
    INTEL_PARTIAL: 0.45,    // soglia: stima composizione
    INTEL_FULL: 0.85,       // soglia: identità della civ svelata

    /* Ostilità proporzionata. */
    SKIRMISH_CHANCE: 0.35,
    SKIRMISH_WARMUP_SOFT: 500, // sotto: chance scalata (early più mansueto)
    SKIRMISH_DMG_CAP: 0.22,    // frazione max di hp tolta a uno scafo/scaramuccia
    HOSTILE_DISPOSITION: -30   // predoni sotto questa disposizione = malevoli
  };

  /* Archetipi di MISSIONE ambientale. Le flotte sono per natura LEGGERE
     (mai navi di linea pesanti) → fp basso = ostilità proporzionata
     automatica. `signature` = quanto sono rilevabili (più alta = più
     facile da scovare); gli esploratori sono discreti. */
  const MISSIONS = {
    explorer:  { label: 'esplorazione', glyph: '✦', ships: ['explorer'],            signature: 0.34 },
    extractor: { label: 'estrazione',   glyph: '⊟', ships: ['estrattore'],          signature: 0.52 },
    transport: { label: 'trasporto',    glyph: '◅', ships: ['corvetta'],            signature: 0.58 }
  };

  /* ------------------------------------------------------------------
     Utility
     ------------------------------------------------------------------ */
  function ensure(game) {
    if (!game) return;
    if (!Array.isArray(game.aiFleets)) game.aiFleets = [];
  }
  function rng(game, tag) {
    const seed = (game.galaxy && game.galaxy.seed) || game.seed || 'x';
    return ORION.rng.makeRng(seed + ':aif:' + tag);
  }
  function classesRef() {
    return (ORION.fleet && ORION.fleet.CLASSES) || {};
  }
  function sysName(game, sysId) {
    const s = game.galaxy && game.galaxy.systems[sysId];
    return (s && s.name) || ('Sistema ' + sysId);
  }
  function regionLabel(game, sysId) {
    const g = game.galaxy;
    const s = g && g.systems[sysId];
    if (!s) return 'spazio non cartografato';
    const groups = g.groups || [];
    for (let i = 0; i < groups.length; i++) if (groups[i].id === s.cluster) return groups[i].name;
    return 'spazio non cartografato';
  }
  function aliveCivs(game) {
    return (game.civs || []).filter(function (c) { return c && c.alive; });
  }
  /* Sistemi con una tua colonia operativa. */
  function playerColonySystems(game) {
    const set = new Set();
    const cols = game.colonies || {};
    Object.keys(cols).forEach(function (k) {
      const c = cols[k];
      if (c && (c.colonized || c.colonizing) && c.systemId != null) set.add(c.systemId);
    });
    return set;
  }
  function neighborsOf(game, sysId) {
    const s = game.galaxy && game.galaxy.systems[sysId];
    return (s && s.links) || [];
  }
  function minSpeedOf(ships) {
    const C = classesRef();
    let sp = Infinity;
    for (let i = 0; i < ships.length; i++) {
      const cls = C[ships[i].kind];
      const v = (cls && cls.speed) || 1;
      if (v < sp) sp = v;
    }
    return sp === Infinity ? 1 : sp;
  }
  function fleetFp(ships) {
    const C = classesRef();
    let fp = 0;
    for (let i = 0; i < ships.length; i++) {
      const cls = C[ships[i].kind];
      fp += (cls && cls.fp) || 0;
    }
    return fp;
  }
  function legEta(game, fromId, toId, minSpeed) {
    if (ORION.fleet && ORION.fleet.tempoLeg) return ORION.fleet.tempoLeg(game.galaxy, fromId, toId, minSpeed);
    return 50;
  }
  function path(game, fromId, toId) {
    if (ORION.fleet && ORION.fleet.computePath) return ORION.fleet.computePath(game.galaxy, fromId, toId);
    return null;
  }
  function countCivFleets(game, civId) {
    let n = 0;
    for (let i = 0; i < game.aiFleets.length; i++) if (game.aiFleets[i].civId === civId) n++;
    return n;
  }
  function civHostileToPlayer(civ) {
    if (!civ) return false;
    if (civ.relation === 'war') return true;
    if (civ.vocation === 'predoni' && (civ.disposition || 0) <= CFG.HOSTILE_DISPOSITION) return true;
    return false;
  }

  /* ------------------------------------------------------------------
     SPAWN — genera flottiglie ambientali sulle civ vive.
     ------------------------------------------------------------------ */
  function chooseMission(game, civ, crng) {
    const sys = civ.systems || [];
    const hasAnomalyNear = anomalyGoal(game, civ, crng, true) != null;
    const bag = [];
    /* Esploratori sempre disponibili (motore del "movimento pari al mio"). */
    bag.push('explorer', 'explorer');
    if (hasAnomalyNear) bag.push('extractor', 'extractor');
    if (sys.length >= 2) bag.push('transport');
    /* Le vocazioni espansioniste/mercantili muovono di più. */
    if (civ.vocation === 'espansionisti' || civ.vocation === 'imperialisti') bag.push('explorer');
    if (civ.vocation === 'mercantili') bag.push('transport', 'extractor');
    return crng.pick(bag);
  }

  /* Anomalia raggiungibile entro MAX_HOPS da un sistema della civ. Con
     piccola probabilità mira a un'anomalia in un TUO sistema (es. estrattore
     che arriva nell'anomalia del tuo sistema capitale — scenario utente).
     `probe`=true → ritorna solo se esiste un candidato (per chooseMission). */
  function anomalyGoal(game, civ, crng, probe) {
    const anomalies = game.anomalies || {};
    const keys = Object.keys(anomalies);
    if (!keys.length) return null;
    const origins = civ.systems || [];
    if (!origins.length) return null;
    const cands = [];
    for (let i = 0; i < keys.length; i++) {
      const a = anomalies[keys[i]];
      if (!a || a.sysId == null) continue;
      if (origins.indexOf(a.sysId) >= 0) continue; // non "estrai" a casa tua
      const p = path(game, origins[0], a.sysId);
      if (!p) continue;
      if (p.length - 1 > CFG.MAX_HOPS) continue;
      cands.push(a.sysId);
    }
    if (!cands.length) return null;
    if (probe) return cands[0];
    return crng.pick(cands);
  }

  /* Sistema-meta per un esploratore: frontiera 2-3 hop dal territorio civ. */
  function exploreGoal(game, civ, crng) {
    const origin = (civ.systems && civ.systems[0]);
    if (origin == null) return null;
    const owned = new Set(civ.systems || []);
    const seen = new Set([origin]);
    let frontier = [origin];
    const reach = [];
    for (let depth = 0; depth < 3; depth++) {
      const next = [];
      for (let i = 0; i < frontier.length; i++) {
        const nb = neighborsOf(game, frontier[i]);
        for (let j = 0; j < nb.length; j++) {
          const n = nb[j];
          if (seen.has(n)) continue;
          seen.add(n);
          next.push(n);
          if (!owned.has(n)) reach.push(n);
        }
      }
      frontier = next;
    }
    if (!reach.length) return null;
    return crng.pick(reach);
  }

  function buildComposition(game, civ, mission, crng) {
    const tmpl = MISSIONS[mission];
    const ships = tmpl.ships.map(function (k) { return { kind: k }; });
    /* Scorta proporzionata: presente solo per missioni non-esploratore e
       solo se la civ ha un minimo di potere; SEMPRE scafi leggeri (caccia)
       — niente navi di linea in una flottiglia ambientale. */
    if (mission !== 'explorer' && (civ.power || 0) > 40 && crng.chance(0.5)) {
      ships.push({ kind: 'caccia' });
      if ((civ.power || 0) > 120 && crng.chance(0.4)) ships.push({ kind: 'caccia' });
    }
    return ships;
  }

  function spawnOne(game, civ, crng, events) {
    const mission = chooseMission(game, civ, crng);
    let goal = null;
    if (mission === 'extractor') goal = anomalyGoal(game, civ, crng, false);
    else if (mission === 'transport') {
      const sys = (civ.systems || []).filter(function (s) { return s !== civ.systems[0]; });
      goal = sys.length ? crng.pick(sys) : null;
    } else goal = exploreGoal(game, civ, crng);
    if (goal == null) return false;

    const origin = civ.systems[0];
    const route = path(game, origin, goal);
    if (!route || route.length < 2 || route.length - 1 > CFG.MAX_HOPS) return false;

    const ships = buildComposition(game, civ, mission, crng);
    const minSpeed = minSpeedOf(ships);
    const af = {
      id: 'aif-' + (game.timeImpulsi || 0) + '-' + Math.floor(crng.float() * 100000),
      civId: civ.id,
      civName: civ.name,
      civColor: civ.color,
      mission: mission,
      ships: ships,
      fp: fleetFp(ships),
      signature: Math.min(0.95, MISSIONS[mission].signature + 0.05 * Math.max(0, ships.length - 1)),
      homeSysId: origin,
      goalSysId: goal,
      route: route,
      routeIdx: 0,
      systemId: route[0],
      status: 'in-transit',
      etaImpulsi: legEta(game, route[0], route[1], minSpeed),
      legTotal: legEta(game, route[0], route[1], minSpeed),
      minSpeed: minSpeed,
      lingerLeft: 0,
      returning: false,
      detected: false,
      everDetected: false,
      warnedApproach: false,
      engaged: false,
      intel: 0,
      spawnI: game.timeImpulsi || 0
    };
    game.aiFleets.push(af);
    return true;
  }

  function maybeSpawn(game, events) {
    const I = game.timeImpulsi || 0;
    if (game.aiFleets.length >= CFG.GLOBAL_CAP) return;
    const civs = aliveCivs(game);
    if (!civs.length) return;
    const ramp = I < CFG.SPAWN_RAMP_I ? (0.4 + 0.6 * (I / CFG.SPAWN_RAMP_I)) : 1.0;
    let spawned = 0;
    /* Ordine deterministico (per id) — niente dipendenza dall'iterazione. */
    const order = civs.slice().sort(function (a, b) { return a.id < b.id ? -1 : 1; });
    for (let i = 0; i < order.length; i++) {
      if (spawned >= CFG.SPAWN_PER_TICK) break;
      if (game.aiFleets.length >= CFG.GLOBAL_CAP) break;
      const civ = order[i];
      if (!civ.systems || !civ.systems.length) continue;
      if (countCivFleets(game, civ.id) >= CFG.PER_CIV_CAP) continue;
      const crng = rng(game, 'spawn:' + civ.id + ':' + I);
      let chance = CFG.SPAWN_CHANCE * ramp;
      /* Le pacifiste/isolazioniste muovono meno; predoni/espansionisti di più. */
      if (civ.vocation === 'isolazionisti' || civ.faction) chance *= 0.5;
      if (civ.vocation === 'espansionisti' || civ.vocation === 'predoni' || civ.vocation === 'imperialisti') chance *= 1.4;
      if (!crng.chance(chance)) continue;
      if (spawnOne(game, civ, crng, events)) spawned++;
    }
  }

  /* ------------------------------------------------------------------
     MOVIMENTO — avanza ogni flotta di 1 Impulso lungo la rotta.
     ------------------------------------------------------------------ */
  function startLeg(game, af) {
    const fromId = af.route[af.routeIdx];
    const toId = af.route[af.routeIdx + 1];
    af.systemId = fromId;
    af.status = 'in-transit';
    af.etaImpulsi = legEta(game, fromId, toId, af.minSpeed);
    af.legTotal = af.etaImpulsi;
  }

  function advanceFleet(game, af, events) {
    if (af.status === 'orbiting') {
      af.lingerLeft -= 1;
      if (af.lingerLeft > 0) return true;
      /* Sosta finita: torna verso casa, oppure si dissolve (missione conclusa). */
      if (!af.returning) {
        const home = af.homeSysId;
        const back = path(game, af.systemId, home);
        if (back && back.length >= 2) {
          af.route = back;
          af.routeIdx = 0;
          af.returning = true;
          startLeg(game, af);
          return true;
        }
      }
      return false; // dissolvi
    }
    /* in-transit */
    af.etaImpulsi -= 1;
    if (af.etaImpulsi > 0) return true;
    af.routeIdx += 1;
    if (af.routeIdx >= af.route.length - 1) {
      af.routeIdx = af.route.length - 1;
      af.systemId = af.route[af.routeIdx];
      if (af.returning) return false; // rientrata → dissolvi
      af.status = 'orbiting';
      const lr = rng(game, 'linger:' + af.id);
      af.lingerLeft = lr.int(CFG.LINGER_MIN, CFG.LINGER_MAX);
      return true;
    }
    startLeg(game, af);
    return true;
  }

  /* ------------------------------------------------------------------
     SENSORI / RILEVAMENTO
     ------------------------------------------------------------------ */
  /* Mappa di copertura sensori del giocatore: sysId → potenza [0..1.2]. */
  function buildCoverage(game) {
    const cov = {};
    function bump(sysId, p) { if (cov[sysId] == null || cov[sysId] < p) cov[sysId] = p; }
    /* Colonie: copertura passiva sul proprio sistema + adiacenti (attenuata). */
    const colSys = playerColonySystems(game);
    colSys.forEach(function (s) {
      bump(s, CFG.COLONY_SENSOR);
      const nb = neighborsOf(game, s);
      for (let i = 0; i < nb.length; i++) bump(nb[i], CFG.COLONY_SENSOR * CFG.COLONY_RANGE_FALLOFF);
    });
    /* Flotte del giocatore: copertura attiva nel sistema (e adiacenti se
       hanno scafi da ricognizione). */
    const fleets = game.fleets || [];
    const fs = ORION.fleet && ORION.fleet.fleetSensor;
    for (let i = 0; i < fleets.length; i++) {
      const f = fleets[i];
      if (!f || !f.location) continue;
      const here = f.location.systemId;
      if (here == null) continue;
      const s = fs ? fs(f) : { power: 0.5, range: 0 };
      bump(here, s.power);
      if (s.range >= 1) {
        const nb = neighborsOf(game, here);
        for (let j = 0; j < nb.length; j++) bump(nb[j], s.power * CFG.COLONY_RANGE_FALLOFF);
      }
    }
    return cov;
  }

  /* Sistemi "presenza" di una flotta AI (dove può essere captata). */
  function presenceNodes(af) {
    if (af.status === 'in-transit' && Array.isArray(af.route) && af.routeIdx + 1 < af.route.length) {
      return [af.route[af.routeIdx], af.route[af.routeIdx + 1]];
    }
    return [af.systemId];
  }

  /* Una tua flotta è co-locata con la flotta AI (stesso sistema nodo)? */
  function coLocatedPlayerFleet(game, nodes) {
    const fleets = game.fleets || [];
    for (let i = 0; i < fleets.length; i++) {
      const f = fleets[i];
      if (!f || !f.location) continue;
      if (nodes.indexOf(f.location.systemId) >= 0) return f;
    }
    return null;
  }

  function detect(game, af, cov, colSys, events) {
    const nodes = presenceNodes(af);
    let best = 0, bestNode = nodes[0];
    for (let i = 0; i < nodes.length; i++) {
      const c = cov[nodes[i]] || 0;
      if (c > best) { best = c; bestNode = nodes[i]; }
    }
    if (best <= 0) { af.detected = false; return; }

    const I = game.timeImpulsi || 0;
    const drng = rng(game, 'det:' + af.id + ':' + I);
    const p = Math.max(0.03, Math.min(0.97, best - af.signature * 0.45 + CFG.DETECT_BASE));
    if (!drng.chance(p)) { af.detected = false; return; }

    af.detected = true;
    af.intel = Math.min(1, af.intel + CFG.INTEL_GAIN * (0.5 + 0.5 * best));

    /* Vicino a una colonia? (nodo presenza è un tuo sistema colonia o adiacente). */
    let nearColony = false;
    for (let i = 0; i < nodes.length && !nearColony; i++) {
      if (colSys.has(nodes[i])) nearColony = true;
      else {
        const nb = neighborsOf(game, nodes[i]);
        for (let j = 0; j < nb.length; j++) if (colSys.has(nb[j])) { nearColony = true; break; }
      }
    }

    if (!af.everDetected) {
      af.everDetected = true;
      events.push({
        kind: 'aifleet-detected',
        aifleetId: af.id,
        sysId: bestNode,
        regionLabel: regionLabel(game, bestNode),
        missionLabel: MISSIONS[af.mission].label,
        civName: af.intel >= CFG.INTEL_FULL ? af.civName : null,
        compKnown: af.intel >= CFG.INTEL_PARTIAL,
        nearColony: nearColony,
        impulso: I
      });
    }
    /* Raggiunge le vicinanze di una tua colonia → avviso forte (una volta). */
    if (nearColony && !af.warnedApproach) {
      af.warnedApproach = true;
      events.push({
        kind: 'aifleet-approach',
        aifleetId: af.id,
        sysId: bestNode,
        regionLabel: regionLabel(game, bestNode),
        missionLabel: MISSIONS[af.mission].label,
        civName: af.intel >= CFG.INTEL_PARTIAL ? af.civName : null,
        impulso: I
      });
    }
  }

  /* ------------------------------------------------------------------
     OSTILITÀ PROPORZIONATA — scaramuccia leggera, mai letale (#22).
     ------------------------------------------------------------------ */
  function maybeSkirmish(game, af, events) {
    if (af.engaged || af.fp <= 0) return false;
    const civ = (game.civs || []).filter(function (c) { return c.id === af.civId; })[0];
    if (!civHostileToPlayer(civ)) return false;
    const nodes = presenceNodes(af);
    const pf = coLocatedPlayerFleet(game, nodes);
    if (!pf || !Array.isArray(pf.ships) || !pf.ships.length) return false;

    const I = game.timeImpulsi || 0;
    /* Chance scalata sotto il warm-up soft: early più mansueto, ma NON un
       gate rigido (la possibilità esiste comunque). */
    const soft = I < CFG.SKIRMISH_WARMUP_SOFT ? (0.25 + 0.75 * (I / CFG.SKIRMISH_WARMUP_SOFT)) : 1.0;
    const srng = rng(game, 'skirm:' + af.id + ':' + I);
    if (!srng.chance(CFG.SKIRMISH_CHANCE * soft)) return false;

    /* Danno proporzionato: ∝ fp della flotta AI vs robustezza della flotta
       player. Cap per scafo per non distruggere mai l'intera flotta. */
    const C = classesRef();
    const pfFp = fleetFp(pf.ships) || 1;
    const ratio = af.fp / (af.fp + pfFp); // 0..1, peso relativo dell'AI
    let hit = 0;
    for (let i = 0; i < pf.ships.length; i++) {
      const sh = pf.ships[i];
      const cls = C[sh.kind];
      const maxHp = (cls && cls.hp) || sh.hp || 20;
      const dmg = Math.min(CFG.SKIRMISH_DMG_CAP, 0.10 + 0.25 * ratio) * maxHp;
      const newHp = Math.max(1, (sh.hp != null ? sh.hp : maxHp) - dmg); // floor 1: mai distrutta
      if (newHp < (sh.hp != null ? sh.hp : maxHp)) hit++;
      sh.hp = newHp;
      sh.wear = Math.min(1, (sh.wear || 0) + 0.04);
    }
    /* La flotta AI subisce a sua volta (e si sgancia): si dissolve. */
    af.engaged = true;

    events.push({
      kind: 'aifleet-skirmish',
      aifleetId: af.id,
      fleetId: pf.id,
      fleetName: pf.name,
      sysId: pf.location.systemId,
      regionLabel: regionLabel(game, pf.location.systemId),
      civName: af.intel >= CFG.INTEL_PARTIAL ? af.civName : null,
      shipsHit: hit,
      impulso: I
    });
    /* Recovery-friendly (#22): NON mutiamo gli ordini del giocatore (sarebbe
       intrusivo). Applichiamo solo danno leggero + sgancio della flotta AI;
       l'utente decide se ritirarsi (hint in cronaca). */
    return true; // segnala: dissolvi la flotta AI dopo lo sgancio
  }

  /* ------------------------------------------------------------------
     TICK — chiamato a OGNI Impulso da time.js. Cadenza interna per le
     decisioni (spawn); movimento + rilevamento ogni Impulso.
     ------------------------------------------------------------------ */
  function tick(game, events) {
    if (!game || !game.galaxy) return;
    ensure(game);
    const I = game.timeImpulsi || 0;
    if (I < CFG.START_I) return;
    events = events || [];

    /* 1) Spawn (solo sulla cadenza decisioni). */
    if ((I % CFG.EVERY_I) === 0) maybeSpawn(game, events);

    if (!game.aiFleets.length) return;

    /* 2) Movimento + rilevamento + ostilità. */
    const cov = buildCoverage(game);
    const colSys = playerColonySystems(game);
    const survivors = [];
    for (let i = 0; i < game.aiFleets.length; i++) {
      const af = game.aiFleets[i];
      if (!af) continue;
      const alive = advanceFleet(game, af, events);
      if (!alive) continue; // missione conclusa / rientrata → fuori
      detect(game, af, cov, colSys, events);
      const dissolve = maybeSkirmish(game, af, events);
      if (dissolve) continue;
      survivors.push(af);
    }
    game.aiFleets = survivors;
  }

  /* ------------------------------------------------------------------
     QUERY per la UI (Fase 2 / render).
     ------------------------------------------------------------------ */
  function detectedFleets(game) {
    if (!game || !Array.isArray(game.aiFleets)) return [];
    return game.aiFleets.filter(function (af) { return af && af.detected; });
  }
  /* Descrizione composizione graduata dall'intel (per scrutinio Fase 2). */
  function composition(af) {
    if (!af) return { level: 'none', text: '—' };
    if (af.intel >= CFG.INTEL_FULL) {
      return { level: 'full', text: af.ships.map(function (s) { return s.kind; }).join(', ') };
    }
    if (af.intel >= CFG.INTEL_PARTIAL) {
      return { level: 'partial', text: af.ships.length + ' scafi (' + MISSIONS[af.mission].label + ')' };
    }
    return { level: 'fragmentary', text: 'contatto non identificato' };
  }

  ORION.aifleet = {
    tick: tick,
    ensure: ensure,
    detectedFleets: detectedFleets,
    composition: composition,
    MISSIONS: MISSIONS,
    CFG: CFG
  };
})(typeof window !== 'undefined' ? window : this);
