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
    GLOBAL_CAP: 11,         // max flottiglie ambientali simultanee (alzato per
                            // dare spazio al traffico Mekhari, 2026-06-30)
    PER_CIV_CAP: 2,
    PER_CIV_CAP_MEKHARI: 3, // i Mekhari (corrieri del mercato grigio) viaggiano
                            // più di chiunque → più carovane simultanee
    SPAWN_PER_TICK: 2,      // max spawn per decisione (anti-burst)
    SPAWN_CHANCE: 0.18,     // per civ idonea per decisione
    SPAWN_RAMP_I: 1500,     // sotto: chance scalata (decollo dolce, non rigido)
    MAX_HOPS: 6,            // lunghezza massima di una rotta ambientale
    LINGER_MIN: 16,
    LINGER_MAX: 48,
    /* Flyby verso il giocatore (richiesta utente 2026-06-19): una parte
       delle flotte AI viene deliberatamente a "ispezionare" le vicinanze
       delle tue colonie → contatti garantiti anche se la civiltà è a qualche
       hop, non solo movimento nel loro territorio. */
    SCOUT_CHANCE: 0.40,     // prob. che una missione punti verso il giocatore
    SCOUT_MAX_HOPS: 11,     // budget rotta più ampio per raggiungerti

    /* Sensori. Portata (in hop) differenziata per fonte (richiesta utente
       2026-06-26): la CAPITALE ha la rete più estesa, una colonia normale è
       più corta, una colonia ancora in insediamento copre solo il proprio
       sistema, e una stazione operativa fa da avamposto-radar leggero. Così
       per avere visuale lontana non si è più costretti a "una colonia ogni 2
       hop". */
    COLONY_SENSOR: 0.62,    // potenza rilevamento passiva di una colonia
    COLONY_RANGE_FALLOFF: 0.55, // copertura sui sistemi adiacenti (1° anello)
    COLONY_RANGE2_FALLOFF: 0.30, // copertura sul 2° anello (2 hop, più debole)
    CAPITAL_RANGE: 2,       // hop coperti dalla CAPITALE (rete estesa)
    COLONY_RANGE: 1,        // hop coperti da una colonia normale operativa
    /* Stazione come AVAMPOSTO-RADAR a livelli (richiesta utente 2026-06-26):
       portata e potenza crescono col livello → investi su un avamposto lontano
       per la visuale, invece di colonizzare ogni 2 hop. Indice = livello (1..4).
       L1-2 = 1 hop · L3-4 = 2 hop · potenza che sale fino alla pari di una
       colonia. */
    STATION_SENSOR_BY_LEVEL: [
      null,                       // 0: non operativa
      { power: 0.50, range: 1 },  // L1
      { power: 0.52, range: 1 },  // L2
      { power: 0.56, range: 2 },  // L3
      { power: 0.62, range: 2 }   // L4
    ],
    /* Sensori di FLOTTA (mobili): raggio < colonia e tarato sul tipo di navi
       (richiesta utente 2026-06-19). Una flotta vede SEMPRE il proprio
       sistema (incrocio/co-locazione); solo gli scafi da ricognizione
       (explorer/intercettore, fleet.fleetSensor.range>=1) estendono di 1 hop
       al sistema adiacente — MAI a 2 hop come una colonia. */
    FLEET_RING_FALLOFF: 0.45,
    CONTACT_PERSIST_I: 32,  // un contatto resta "ultimo avvistamento" dopo l'uscita dai sensori
    DETECT_BASE: 0.22,      // offset prob. rilevamento
    /* Crescita intel/Impulso in copertura. Tarato lento di proposito
       (richiesta utente 2026-06-26): il radar dà presenza/numero, ma la
       COMPOSIZIONE piena (classi) deve costare permanenza vera. Scala
       linearmente con la copertura `best` (vedi detect()), così i passaggi
       al bordo rampano lentissimi e alcune flotte sfuggono senza essere
       inquadrate (2 hop e via). Pedinamento/ispezione restano rapidi. */
    INTEL_GAIN: 0.04,       // era 0.16
    INTEL_PARTIAL: 0.45,    // soglia: stima composizione
    INTEL_FULL: 0.85,       // soglia: identità della civ svelata

    /* Ostilità proporzionata. */
    SKIRMISH_CHANCE: 0.35,
    SKIRMISH_WARMUP_SOFT: 500, // sotto: chance scalata (early più mansueto)
    SKIRMISH_DMG_CAP: 0.22,    // frazione max di hp tolta a uno scafo/scaramuccia
    HOSTILE_DISPOSITION: -30,  // predoni sotto questa disposizione = malevoli

    /* Inseguimento (richiesta utente 2026-06-18): tre ordini distinti su
       una flotta AI RILEVATA — Segui (osserva), Intercetta (ingaggia se
       ostile), Scorta (accompagna una flotta non ostile). */
    CROSS_INTEL_BUMP: 0.08,    // info raccolte incrociando SENZA fermarsi
    FOLLOW_INTEL_GAIN: 0.26,   // intel/Impulso mentre pedini co-locato (rapido)
    DISPO_EVERY_I: 24,         // throttle degli effetti di disposizione
    SHADOW_DISPO_PEN: 2.5,     // disposizione persa pedinando nel loro territorio
    ESCORT_DISPO_GAIN: 1.6,    // goodwill scortando una flotta non ostile
    STRIKE_RETURN_CAP: 0.20,   // danno di ritorno max alla flotta che intercetta
    STRIKE_WIN_RATIO: 0.6      // intercetti vinti se fp player ≥ fp AI × questo
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
    let t = (ORION.fleet && ORION.fleet.tempoLeg)
      ? ORION.fleet.tempoLeg(game.galaxy, fromId, toId, minSpeed) : 50;
    /* Campo di prossimità FSP (richiesta utente 2026-06-29, §17.7.4): il
       rallentamento/accelerazione vale anche per le flottiglie ambientali AI
       ("legge fisica" simmetrica). Usura/viveri non sono modellati per queste
       flotte leggere → applichiamo solo il canale di viaggio (drag). */
    if (ORION.phenomena && ORION.phenomena.legField) {
      const fld = ORION.phenomena.legField(game.galaxy, fromId, toId);
      if (fld && fld.dragMul && fld.dragMul !== 1) t = Math.max(1, Math.round(t * fld.dragMul));
    }
    return t;
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

  /* Meta "verso il giocatore" (flyby): un sistema-colonia del player o un suo
     adiacente, raggiungibile entro SCOUT_MAX_HOPS dal territorio della civ.
     Sceglie il più vicino → la flottiglia viene davvero a scrutarti. */
  function playerwardGoal(game, civ) {
    const colSys = playerColonySystems(game);
    if (!colSys.size) return null;
    const cand = new Set();
    colSys.forEach(function (s) {
      cand.add(s);
      neighborsOf(game, s).forEach(function (n) { cand.add(n); });
    });
    (civ.systems || []).forEach(function (s) { cand.delete(s); });
    if (!cand.size) return null;
    const origin = civ.systems[0];
    let best = null, bestHops = Infinity;
    cand.forEach(function (t) {
      const p = path(game, origin, t);
      if (!p) return;
      const h = p.length - 1;
      if (h <= CFG.SCOUT_MAX_HOPS && h < bestHops) { bestHops = h; best = t; }
    });
    return best;
  }

  function spawnOne(game, civ, crng, events) {
    const mission = chooseMission(game, civ, crng);
    let goal = null, scout = false;
    /* Flyby: una parte delle missioni (non gli estrattori) punta verso di te. */
    if (mission !== 'extractor' && crng.chance(CFG.SCOUT_CHANCE)) {
      goal = playerwardGoal(game, civ);
      if (goal != null) scout = true;
    }
    if (goal == null) {
      if (mission === 'extractor') goal = anomalyGoal(game, civ, crng, false);
      else if (mission === 'transport') {
        const sys = (civ.systems || []).filter(function (s) { return s !== civ.systems[0]; });
        goal = sys.length ? crng.pick(sys) : null;
      } else goal = exploreGoal(game, civ, crng);
    }
    if (goal == null) return false;

    const origin = civ.systems[0];
    const route = path(game, origin, goal);
    const maxHops = scout ? CFG.SCOUT_MAX_HOPS : CFG.MAX_HOPS;
    if (!route || route.length < 2 || route.length - 1 > maxHops) return false;

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
      /* I Mekhari (fixer mercantile) tengono più carovane in viaggio degli
         altri → cap per-civ più alto, così li incroci più spesso (richiesta
         utente 2026-06-30). */
      const perCivCap = civ.faction === 'mekhari' ? CFG.PER_CIV_CAP_MEKHARI : CFG.PER_CIV_CAP;
      if (countCivFleets(game, civ.id) >= perCivCap) continue;
      const crng = rng(game, 'spawn:' + civ.id + ':' + I);
      let chance = CFG.SPAWN_CHANCE * ramp;
      /* Le pacifiste/isolazioniste muovono meno; predoni/espansionisti di più. */
      if (civ.faction === 'mekhari') chance *= 1.6;            // corrieri ovunque
      else if (civ.vocation === 'isolazionisti' || civ.faction) chance *= 0.5;
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
    /* Transito-attraverso: una flotta in volo NON è "a" un nodo (è in
       iperspazio sulla corsia). Solo nell'Impulso in cui TRANSITA un nodo
       intermedio della rotta la consideriamo momentaneamente lì, per gli
       incroci a nodo. Resettato a ogni avanzamento. */
    af._passThrough = null;
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
    /* Arrivo a un nodo INTERMEDIO: la flotta lo transita in questo Impulso
       (poi riparte sulla leg successiva). Marca il pass-through così un
       incrocio a nodo è possibile solo nell'istante del transito reale, non
       per tutta la durata della leg. */
    af._passThrough = af.route[af.routeIdx];
    startLeg(game, af);
    return true;
  }

  /* ------------------------------------------------------------------
     SENSORI / RILEVAMENTO
     ------------------------------------------------------------------ */
  /* Diffonde la copertura di UNA fonte (colonia/stazione) dal suo sistema
     fino a `range` hop, con attenuazione per anello (1°/2°). range 0 = solo
     il proprio sistema. */
  function spreadCoverage(game, bump, sysId, power, range) {
    bump(sysId, power);
    if (range < 1) return;
    const nb1 = neighborsOf(game, sysId);
    for (let i = 0; i < nb1.length; i++) {
      bump(nb1[i], power * CFG.COLONY_RANGE_FALLOFF);
      if (range < 2) continue;
      const nb2 = neighborsOf(game, nb1[i]);
      for (let j = 0; j < nb2.length; j++) bump(nb2[j], power * CFG.COLONY_RANGE2_FALLOFF);
    }
  }
  function isCapitalKey(game, colonyKey) {
    return !!(ORION.capital && ORION.capital.isCapital && ORION.capital.isCapital(game, colonyKey));
  }
  function stationSensorOf(level) {
    const tbl = CFG.STATION_SENSOR_BY_LEVEL;
    const lvl = Math.max(1, Math.min(tbl.length - 1, level || 1));
    return tbl[lvl] || tbl[1];
  }
  /* Bonus globali dalla ricerca (richiesta utente 2026-06-26): potenza +X% e
     +N hop a TUTTE le fonti infrastrutturali. Il +hop estende solo le fonti
     che già rilevano (range ≥ 1): una colonia in insediamento resta sul
     proprio sistema. */
  function researchSensorBonus(game) {
    const m = (ORION.research && ORION.research.mods) ? ORION.research.mods(game) : null;
    return {
      powerMul: m ? (m.sensorPowerMul || 1) : 1,
      rangeBonus: m ? (m.sensorRangeBonus || 0) : 0
    };
  }
  function extendRange(baseRange, rangeBonus) {
    return baseRange > 0 ? baseRange + rangeBonus : 0;
  }
  /* Mappa di copertura sensori del giocatore: sysId → potenza [0..1.2]. */
  function buildCoverage(game) {
    const cov = {};
    function bump(sysId, p) { if (sysId != null && (cov[sysId] == null || cov[sysId] < p)) cov[sysId] = p; }
    const rb = researchSensorBonus(game);
    /* Colonie: portata differenziata (richiesta utente 2026-06-26).
       Capitale → 2 hop; colonia operativa → 1 hop; colonia ancora in
       insediamento (colonizing o phase 'settling') → solo il proprio sistema. */
    const cols = game.colonies || {};
    Object.keys(cols).forEach(function (k) {
      const c = cols[k];
      if (!c || c.systemId == null) return;
      if (!(c.colonized || c.colonizing)) return;
      const operational = c.colonized && c.phase !== 'settling';
      let range;
      if (!operational) range = 0;
      else if (isCapitalKey(game, k)) range = CFG.CAPITAL_RANGE;
      else range = CFG.COLONY_RANGE;
      spreadCoverage(game, bump, c.systemId, CFG.COLONY_SENSOR * rb.powerMul, extendRange(range, rb.rangeBonus));
    });
    /* Stazioni operative del giocatore: avamposto-radar a livelli (portata e
       potenza crescono col livello). Le catturate (owner != null) e quelle in
       costruzione non contano. */
    const stations = game.stations || [];
    for (let i = 0; i < stations.length; i++) {
      const st = stations[i];
      if (!st || st.systemId == null) continue;
      if (st.owner != null) continue;
      if (st.phase === 'building' || (st.level || 0) < 1) continue;
      const ss = stationSensorOf(st.level);
      spreadCoverage(game, bump, st.systemId, ss.power * rb.powerMul, extendRange(ss.range, rb.rangeBonus));
    }
    /* Flotte del giocatore: copertura nel/i nodo/i correnti (entrambi gli
       estremi della leg se in volo interstellare) + 1° anello; gli scafi da
       ricognizione estendono al 2° anello. Le tue flotte in giro fanno da
       sensori mobili → più incroci. */
    const fleets = game.fleets || [];
    const fs = ORION.fleet && ORION.fleet.fleetSensor;
    for (let i = 0; i < fleets.length; i++) {
      const f = fleets[i];
      if (!f || !f.location) continue;
      const s = fs ? fs(f) : { power: 0.5, range: 0 };
      const inTransit = (f.location.status === 'in-transit' && !f.location.intra &&
                         Array.isArray(f.route) && f.routeIdx + 1 < f.route.length);
      const nodesF = inTransit
        ? [f.route[f.routeIdx], f.route[f.routeIdx + 1]]
        : [f.location.systemId];
      for (let k = 0; k < nodesF.length; k++) {
        const here = nodesF[k];
        if (here == null) continue;
        /* Proprio sistema (e, in volo, i DUE estremi del tratto): sempre. */
        bump(here, s.power);
        /* Sweep recon +1 hop SOLO da FERMA (richiesta utente 2026-06-19):
           in volo, sommare l'anello attorno A ENTRAMBI gli estremi del tratto
           faceva arrivare la copertura a 2 hop (estremo di arrivo + anello =
           sistema oltre la destinazione). Una flotta che attraversa l'iperspazio
           copre solo la sua corsia; lo sweep degli adiacenti avviene quando è
           in orbita/attracco. La colonia resta a 2 hop (infrastruttura). */
        if (s.range >= 1 && !inTransit) {
          const nb = neighborsOf(game, here);
          for (let j = 0; j < nb.length; j++) bump(nb[j], s.power * CFG.FLEET_RING_FALLOFF);
        }
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

  /* Tratto (edge) interstellare corrente di una flotta, o null se ferma/intra. */
  function fleetLeg(f) {
    if (f && f.location && f.location.status === 'in-transit' && !f.location.intra &&
        Array.isArray(f.route) && f.routeIdx + 1 < f.route.length) {
      return [f.route[f.routeIdx], f.route[f.routeIdx + 1]];
    }
    return null;
  }
  function sameEdge(a1, a2, b1, b2) {
    return (a1 === b1 && a2 === b2) || (a1 === b2 && a2 === b1);
  }
  /* Sistema in cui una flotta AI è GENUINAMENTE presente per l'incrocio a
     nodo (≠ copertura sensori, che invece raggiunge entrambi gli estremi
     della corsia). Una flotta in volo è in iperspazio, NON a un nodo: vale
     solo il sistema dove è ferma (orbita), oppure il nodo intermedio
     transitato nell'Impulso corrente (pass-through). Così una tua flotta
     ferma a 1 hop, mentre l'AI è ancora a metà corsia, NON conta come
     incrocio (richiesta utente 2026-06-26: essere su sistemi diversi senza
     aver mai incrociato rotta non deve far scattare il meccanismo). */
  function aiNodeOccupied(af) {
    if (af.status !== 'in-transit') return af.systemId;
    if (af._passThrough != null) return af._passThrough;
    return null;
  }
  /* Flotte del giocatore che INCROCIANO una flotta AI:
     - a un NODO: entrambe nello STESSO sistema in cui l'AI è realmente
       presente (ferma o nel transito istantaneo di un nodo);
     - in VOLO interstellare: sullo STESSO tratto (stessa coppia di sistemi),
       così "incrociarli nei tratti interstellari" è possibile (richiesta
       utente 2026-06-19), non solo a sistema fermo. */
  function encounteringPlayerFleets(game, af) {
    const node = aiNodeOccupied(af);
    const afLeg = (af.status === 'in-transit' && Array.isArray(af.route) && af.routeIdx + 1 < af.route.length)
      ? [af.route[af.routeIdx], af.route[af.routeIdx + 1]] : null;
    const fleets = game.fleets || [];
    const out = [];
    for (let i = 0; i < fleets.length; i++) {
      const f = fleets[i];
      if (!f || !f.location) continue;
      if (f.location.status === 'in-transit') {
        const fl = fleetLeg(f);
        if (afLeg && fl && sameEdge(fl[0], fl[1], afLeg[0], afLeg[1])) out.push(f);
      } else if (node != null && f.location.systemId === node) {
        out.push(f);
      }
    }
    return out;
  }
  function coLocatedPlayerFleet(game, af) {
    return encounteringPlayerFleets(game, af)[0] || null;
  }

  function detect(game, af, cov, colSys, events) {
    const nodes = presenceNodes(af);
    /* Copertura PESATA sulla posizione (richiesta utente 2026-06-26): per una
       flotta in volo non si prende più il MIGLIORE dei due estremi del tratto
       (che faceva "vedere" fino a 2+1 hop), ma si interpola la copertura tra
       partenza e arrivo in base a quanto è avanzata. Così una flotta oltre
       metà tratto verso un sistema scoperto non viene più rilevata. */
    let best, bestNode;
    if (af.status === 'in-transit' && Array.isArray(af.route) && af.routeIdx + 1 < af.route.length) {
      const from = af.route[af.routeIdx], to = af.route[af.routeIdx + 1];
      const cFrom = cov[from] || 0, cTo = cov[to] || 0;
      const t = Math.max(0, Math.min(1, 1 - (af.etaImpulsi || 0) / Math.max(1, af.legTotal || 1)));
      best = cFrom + (cTo - cFrom) * t;
      bestNode = t < 0.5 ? from : to;
    } else {
      best = cov[af.systemId] || 0;
      bestNode = af.systemId;
    }
    if (best <= 0) { af.detected = false; return; }

    const I = game.timeImpulsi || 0;
    const drng = rng(game, 'det:' + af.id + ':' + I);
    const p = Math.max(0.03, Math.min(0.97, best - af.signature * 0.45 + CFG.DETECT_BASE));
    if (!drng.chance(p)) { af.detected = false; return; }

    af.detected = true;
    af.lastSeenI = I;          // quando l'hai vista l'ultima volta
    af.lastSeenSysId = bestNode; // DOVE l'hai vista (posizione congelata per la nebbia di guerra)
    /* Scala LINEARE con la copertura (prima `0.5 + 0.5*best`, che dava un
       pavimento generoso anche al bordo): ora il bordo rampa lentissimo e
       solo la copertura forte (colonie / pedinamento) porta a FULL in fretta. */
    af.intel = Math.min(1, af.intel + CFG.INTEL_GAIN * best);
    markCivFlagSeen(game, af, events);

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
    const pf = coLocatedPlayerFleet(game, af);
    if (!pf || !Array.isArray(pf.ships) || !pf.ships.length) return false;
    /* Niente ingaggio automatico dalla parte del giocatore (richiesta utente
       2026-06-19): all'incrocio scatta lo scontro SOLO se la TUA flotta è in
       formazione AGGRESSIVA (posizione "spara a vista"). Altrimenti nessun
       danno forzato: l'incrocio/rilevamento ti AVVISA (processCrossings +
       eventi detect/approach) e decidi tu (Intercetta/Segui/ritirata). La
       pressione AI organizzata resta nel sistema incursioni (con preavviso). */
    if (pf.formation !== 'aggressive') return false;

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
     INCROCI & INSEGUIMENTO (richiesta utente 2026-06-18).
     ------------------------------------------------------------------ */
  function findAi(game, id) {
    const arr = game.aiFleets || [];
    for (let i = 0; i < arr.length; i++) if (arr[i] && arr[i].id === id) return arr[i];
    return null;
  }
  function civById(game, id) {
    const arr = game.civs || [];
    for (let i = 0; i < arr.length; i++) if (arr[i] && arr[i].id === id) return arr[i];
    return null;
  }
  /* Identificazione "bandiera": quando l'intel su una flotta raggiunge FULL
     (sai a CHI appartiene), registra un marker leggero sulla civ di appartenenza.
     `flagSeen` è uno stato di consapevolezza SOTTO "Avvistata" (§13.10): conosci
     l'esistenza/identità della civ per aver inquadrato una loro flotta, ma NON
     sai ancora dove vive né nulla del dossier. È il prerequisito che sblocca il
     dossier mirato dei Mekhari (mekhari.js): pedinare/identificare una flotta
     ORA serve a qualcosa sul piano della civiltà (chiude il silo flotta↔civ).
     Idempotente, additivo, persiste wholesale dentro game.civs (nessun bump). */
  function markCivFlagSeen(game, af, events) {
    if (!af || (af.intel || 0) < CFG.INTEL_FULL) return;
    const civ = civById(game, af.civId);
    if (!civ) return;
    /* Mekhari = fixer galattico (richiesta utente 2026-06-30): identificare una
       loro flotta apre SUBITO un canale → promozione a "contattato" (sblocca
       diplomazia + mercato grigio + intel). Idempotente in markContact. */
    if (civ.faction === 'mekhari' && ORION.ai && ORION.ai.markContact) {
      const KN = ORION.ai.KNOWLEDGE || { contacted: 2 };
      const rank = ORION.ai.knowledgeRank ? ORION.ai.knowledgeRank(civ) : 0;
      if (rank < KN.contacted) ORION.ai.markContact(game, civ, events || null, 'mekhari-network');
    }
    if (civ.flagSeen) return;
    civ.flagSeen = true;
    civ.flagSeenI = game.timeImpulsi || 0;
    civ.flagSeenSysId = af.lastSeenSysId != null ? af.lastSeenSysId : af.systemId;
  }
  function nudgeDisposition(civ, delta) {
    if (!civ) return;
    civ.disposition = Math.max(-100, Math.min(100, (civ.disposition || 0) + delta));
  }
  function inCivTerritory(civ, sysId) {
    return !!(civ && Array.isArray(civ.systems) && civ.systems.indexOf(sysId) >= 0);
  }
  /* Flotta player co-locata con una flotta AI (stesso nodo, non in transito). */
  /* "Quando incrocio raccolgo qualche info" — anche senza fermarsi, e anche
     nei tratti interstellari (richiesta utente 2026-06-19). Alla PRIMA
     co-locazione/incrocio di una tua flotta con una flotta AI, una nota di
     cronaca con quel che sai + un piccolo bump d'intel. */
  function processCrossings(game, fleetsAi, events) {
    const I = game.timeImpulsi || 0;
    for (let i = 0; i < fleetsAi.length; i++) {
      const af = fleetsAi[i];
      if (!af || af._dead) continue;
      const here = encounteringPlayerFleets(game, af);
      if (!here.length) continue;
      const hostile = civHostileToPlayer(civById(game, af.civId));
      if (!Array.isArray(af.crossedBy)) af.crossedBy = [];
      for (let j = 0; j < here.length; j++) {
        const pf = here[j];
        if (af.crossedBy.indexOf(pf.id) >= 0) continue;
        af.crossedBy.push(pf.id);
        af.detected = true;
        af.lastSeenI = I;
        af.lastSeenSysId = pf.location.systemId; // visto incrociando: ultima posizione nota
        af.intel = Math.min(1, (af.intel || 0) + CFG.CROSS_INTEL_BUMP);
        markCivFlagSeen(game, af, events);
        /* Incrocio con una flotta OSTILE che NON è stata ingaggiata (la tua
           non è aggressiva): è il "momento per decidere" — evento con
           auto-pausa, niente danno (richiesta utente 2026-06-19). Le altre
           sono note atmosferiche. */
        const decisionMoment = hostile && pf.formation !== 'aggressive';
        events.push({
          kind: decisionMoment ? 'aifleet-hostile-encounter' : 'aifleet-crossed',
          aifleetId: af.id, fleetId: pf.id, fleetName: pf.name,
          sysId: pf.location.systemId, regionLabel: regionLabel(game, pf.location.systemId),
          missionLabel: MISSIONS[af.mission].label,
          civName: af.intel >= CFG.INTEL_PARTIAL ? af.civName : null,
          compKnown: af.intel >= CFG.INTEL_PARTIAL,
          impulso: I
        });
      }
    }
  }

  /* Intercettazione vinta dal giocatore (ordine 'intercept' su civ ostile,
     una volta raggiunta). Proporzionata: la flottiglia AI è leggera → di
     norma il giocatore prevale; danno di ritorno limitato e floor 1 (#22). */
  function playerStrike(game, pf, af, events) {
    const C = classesRef();
    const afFp = af.fp || 0;
    const pfFp = fleetFp(pf.ships) || 1;
    const ratio = afFp / (afFp + pfFp);
    for (let i = 0; i < pf.ships.length; i++) {
      const sh = pf.ships[i];
      const cls = C[sh.kind];
      const maxHp = (cls && cls.hp) || sh.hp || 20;
      const dmg = Math.min(CFG.STRIKE_RETURN_CAP, 0.05 + 0.2 * ratio) * maxHp;
      sh.hp = Math.max(1, (sh.hp != null ? sh.hp : maxHp) - dmg);
      sh.wear = Math.min(1, (sh.wear || 0) + 0.05);
    }
    const won = afFp === 0 || pfFp >= afFp * CFG.STRIKE_WIN_RATIO;
    af._dead = true;
    events.push({
      kind: won ? 'aifleet-destroyed' : 'aifleet-skirmish',
      aifleetId: af.id, fleetId: pf.id, fleetName: pf.name,
      sysId: pf.location.systemId, regionLabel: regionLabel(game, pf.location.systemId),
      civName: af.intel >= CFG.INTEL_PARTIAL ? af.civName : null,
      outcome: won ? 'win' : 'draw',
      impulso: game.timeImpulsi || 0
    });
    pf.follow = null; // intercettazione: ordine one-shot, concluso
  }

  /* Instrada la flotta player verso `targetNode` inseguendo un bersaglio
     mobile (richiesta utente 2026-06-20: "Segui" usa internamente il comando
     «Inverti rotta» quando il bersaglio è dietro).
       - da ferma → ordine `move` normale;
       - in volo e bersaglio DIETRO (rientrare costa meno che proseguire) →
         riusa ORION.fleet.reverseLeg (inversione fisica a metà tratto, eta =
         Ι già percorsi), poi estende la rotta oltre A fino al bersaglio;
       - in volo e bersaglio AVANTI → prosegue fino a B, poi insegue.
     Ritorna true se ha potuto instradare. */
  function steerFollow(game, pf, targetNode) {
    const F = ORION.fleet;
    if (!F || !F.computePath || targetNode == null) return false;
    if (pf.location.status !== 'in-transit') {
      if (targetNode === pf.location.systemId) return true; // già al nodo: attende
      const r = F.setOrder(game, pf, { type: 'move', toSysId: targetNode }, { fromFollow: true });
      return !!(r && r.ok);
    }
    if (!Array.isArray(pf.route) || pf.routeIdx + 1 >= pf.route.length) return false;
    const A = pf.route[pf.routeIdx];        // partenza leg corrente
    const B = pf.route[pf.routeIdx + 1];    // arrivo leg corrente
    if (targetNode === B) { pf.route = [A, B]; pf.orders = { type: 'move', toSysId: B }; return true; }
    const pathA = F.computePath(game.galaxy, A, targetNode); // [A,…,target]
    const pathB = F.computePath(game.galaxy, B, targetNode); // [B,…,target]
    const dA = pathA ? pathA.length - 1 : Infinity;
    const dB = pathB ? pathB.length - 1 : Infinity;
    if (dA === Infinity && dB === Infinity) return false;
    if (dA < dB && F.reverseLeg) {
      /* Bersaglio DIETRO → comando «Inverti rotta» esistente. reverseLeg
         azzera fleet.follow (lo tratta come ordine manuale): lo preserviamo.
         Poi estendiamo la rotta oltre A (niente sosta) fino al bersaglio. */
      const keep = pf.follow;
      const r = F.reverseLeg(game, pf);
      pf.follow = keep;
      if (!(r && r.ok)) return false;
      if (pathA && pathA.length > 1) {
        pf.route = pf.route.concat(pathA.slice(1));  // [B, A, …, target]
        pf.orders = { type: 'move', toSysId: targetNode };
      }
      return true;
    }
    /* Bersaglio AVANTI: prosegui fino a B, poi inseguI. */
    if (!pathB || pathB.length < 2) return false;
    pf.route = [A].concat(pathB);           // [A, B, …, target]
    pf.routeIdx = 0;
    pf.orders = { type: 'move', toSysId: targetNode };
    return true;
  }

  /* Controller degli ordini di inseguimento. Gira a OGNI Impulso: instrada la
     flotta player verso la posizione corrente della flotta AI bersaglio. */
  function processFollowing(game, fleetsAi, events) {
    const I = game.timeImpulsi || 0;
    const fleets = game.fleets || [];
    for (let k = 0; k < fleets.length; k++) {
      const pf = fleets[k];
      if (!pf || !pf.follow) continue;
      const af = findAi(game, pf.follow.aiFleetId);
      if (!af || af._dead) {
        events.push({ kind: 'follow-lost', fleetId: pf.id, fleetName: pf.name, reason: 'gone', impulso: I });
        pf.follow = null;
        continue;
      }
      const civ = civById(game, af.civId);
      const playerSys = pf.location && pf.location.systemId;
      /* Co-locazione REALE (stesso nodo dove l'AI è davvero presente), non la
         semplice copertura sensori sull'altro estremo della corsia: così un
         ordine di inseguimento (Segui/Intercetta/Scorta) si risolve solo
         all'incontro effettivo, non con l'AI ancora a metà tratto a 1 hop. */
      const aiNode = aiNodeOccupied(af);
      const coLoc = playerSys != null && pf.location.status !== 'in-transit'
                 && aiNode != null && playerSys === aiNode;

      if (!coLoc) {
        /* CONVERGENZA TESTA-A-TESTA (richiesta utente 2026-06-20): se la tua
           flotta e quella AI percorrono lo STESSO tratto in direzioni opposte,
           si stanno avvicinando. Non invertire subito (fuggiresti davanti):
           lasciale convergere al PUNTO D'INCONTRO intermedio e LÌ inverti la
           tua per accodarti. */
        const pLeg = fleetLeg(pf);
        const aLeg = (af.status === 'in-transit' && Array.isArray(af.route) && af.routeIdx + 1 < af.route.length)
          ? [af.route[af.routeIdx], af.route[af.routeIdx + 1]] : null;
        if (pLeg && aLeg && pLeg[0] === aLeg[1] && pLeg[1] === aLeg[0]) {
          const ppFromA = 1 - (pf.etaImpulsi || 0) / Math.max(1, pf.legTotal || 1); // tua frazione da A
          const aiFromA = (af.etaImpulsi || 0) / Math.max(1, af.legTotal || 1);      // AI frazione da A
          if (ppFromA < aiFromA) {
            /* non ancora incrociate: prosegui dritto, vi avvicinate. */
            pf.follow.dest = pLeg[1];
            continue;
          }
          /* incrociate al punto intermedio → inverti ora per accodarti. */
          const keep = pf.follow;
          const r = ORION.fleet.reverseLeg(game, pf);
          pf.follow = keep;
          if (r && r.ok) { pf.follow.dest = aLeg[1]; }
          else {
            events.push({ kind: 'follow-lost', fleetId: pf.id, fleetName: pf.name, reason: 'noroute', impulso: I });
            pf.follow = null;
          }
          continue;
        }
        /* Caso generale: insegui il nodo verso cui l'AI è diretta. Se è dietro,
           steerFollow inverte subito a metà tratto (comando «Inverti rotta»). */
        const dest = aLeg ? aLeg[1] : af.systemId;
        const atNode = pf.location.status !== 'in-transit';
        if (dest != null && (atNode || pf.follow.dest !== dest)) {
          if (steerFollow(game, pf, dest)) { pf.follow.dest = dest; }
          else {
            events.push({ kind: 'follow-lost', fleetId: pf.id, fleetName: pf.name, reason: 'noroute', impulso: I });
            pf.follow = null;
          }
        }
        continue;
      }

      /* Co-locato: osserva (intel rapido) e applica il comportamento per modo. */
      af.detected = true;
      af.lastSeenI = I;
      af.lastSeenSysId = playerSys; // pedinata da co-locato: ultima posizione nota
      af.intel = Math.min(1, (af.intel || 0) + CFG.FOLLOW_INTEL_GAIN);
      markCivFlagSeen(game, af, events);
      af.shadowedBy = pf.id;
      /* Sosta col bersaglio: ferma la flotta (non vagare). */
      if (pf.orders && pf.orders.type !== 'idle' && pf.location.status === 'orbiting') {
        ORION.fleet.setOrder(game, pf, { type: 'idle' }, { fromFollow: true });
      }

      const hostile = civHostileToPlayer(civ);
      const mode = pf.follow.mode;
      const throttled = (I - (pf.follow.lastDispoI || -9999)) >= CFG.DISPO_EVERY_I;

      if (mode === 'intercept') {
        if (hostile) { playerStrike(game, pf, af, events); }
        else { af.intel = 1; /* non ostile: ispezione → dossier pieno, niente scontro */ }
      } else if (mode === 'escort') {
        if (!hostile) {
          af.escortedBy = pf.id; // predisposizione difesa da terzi (latente)
          if (throttled) { nudgeDisposition(civ, CFG.ESCORT_DISPO_GAIN); pf.follow.lastDispoI = I; }
        }
      } else { /* shadow */
        if (inCivTerritory(civ, playerSys) && throttled) {
          nudgeDisposition(civ, -CFG.SHADOW_DISPO_PEN);
          pf.follow.lastDispoI = I;
        }
      }
    }
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

    if (!game.aiFleets.length) {
      /* Nessuna flotta AI: eventuali ordini di inseguimento perdono il
         contatto (gestito da processFollowing su lista vuota). */
      processFollowing(game, [], events);
      return;
    }

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
    /* 3) Incroci (info passiva) + inseguimenti (Segui/Intercetta/Scorta). */
    processCrossings(game, survivors, events);
    processFollowing(game, survivors, events);
    game.aiFleets = survivors.filter(function (af) { return !af._dead; });
  }

  /* ------------------------------------------------------------------
     QUERY per la UI (Fase 2 / render).
     ------------------------------------------------------------------ */
  function detectedFleets(game) {
    if (!game || !Array.isArray(game.aiFleets)) return [];
    return game.aiFleets.filter(function (af) { return af && af.detected; });
  }
  function byId(game, aiFleetId) { return findAi(game, aiFleetId); }
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
  /* Etichetta sintetica del contatto per la UI (rispetta l'intel). */
  function label(game, af) {
    if (!af) return 'Contatto perduto';
    return nameLabel(game, af) + ' · ' + MISSIONS[af.mission].label;
  }
  /* Solo l'identificazione (nome civ o "non identificata"), senza missione/ETA:
     usata sulla mappa per non affollare la vista (richiesta utente 2026-06-20).
     Il dettaglio (missione, ETA, composizione) sta nel popup al click. */
  function nameLabel(game, af) {
    if (!af) return 'Contatto perduto';
    return (af.intel >= CFG.INTEL_FULL && af.civName) ? af.civName : 'Flotta non identificata';
  }

  /* ------------------------------------------------------------------
     API ORDINI (chiamata dalla UI: mappa / pannello flotta).
     mode ∈ 'shadow' (Segui) · 'intercept' (Intercetta) · 'escort' (Scorta).
     ------------------------------------------------------------------ */
  const MODES = { shadow: 'Segui', intercept: 'Intercetta', escort: 'Scorta' };
  function setFollow(game, fleetId, aiFleetId, mode) {
    ensure(game);
    const pf = (game.fleets || []).filter(function (f) { return f && f.id === fleetId; })[0];
    if (!pf) return { ok: false, reason: 'Flotta inesistente' };
    const af = findAi(game, aiFleetId);
    if (!af) return { ok: false, reason: 'Contatto non più disponibile' };
    if (!af.detected) return { ok: false, reason: 'Flotta non rilevata' };
    if (!MODES[mode]) mode = 'shadow';
    if (mode === 'intercept' && fleetFp(pf.ships) <= 0) {
      return { ok: false, reason: 'Flotta disarmata: non può intercettare' };
    }
    pf.follow = { mode: mode, aiFleetId: aiFleetId, dest: null, lastDispoI: -99999 };
    return { ok: true, mode: mode, modeLabel: MODES[mode], af: af };
  }
  function clearFollow(game, fleetId) {
    const pf = (game.fleets || []).filter(function (f) { return f && f.id === fleetId; })[0];
    if (pf) pf.follow = null;
    return { ok: true };
  }

  ORION.aifleet = {
    tick: tick,
    ensure: ensure,
    detectedFleets: detectedFleets,
    byId: byId,
    composition: composition,
    label: label,
    nameLabel: nameLabel,
    setFollow: setFollow,
    clearFollow: clearFollow,
    MODES: MODES,
    MISSIONS: MISSIONS,
    CFG: CFG
  };
})(typeof window !== 'undefined' ? window : this);
