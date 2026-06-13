/* =====================================================================
   station.js — Stazioni spaziali (GDD §12.7, M16 Fase A, decisione #81)

   Avamposto logistico-militare costruibile in QUALUNQUE sistema esplorato,
   anche senza una colonia lì (vera "base avanzata" in territorio profondo).

   Scelte utente (sessione apertura M16):
     1. Scope Fase A = avamposto logistico-militare: RIFORNIMENTO flotte
        (viveri/riparazione #69), DIFESA (forza al sistema, M09) + piccolo
        DEPOSITO. Cantiere orbitale capitali (M15) + hub commerciale (M12)
        → Fase B.
     2. Costruzione REMOTA da una tua colonia entro N hop (niente nuova
        classe nave): paghi dalla colonia, la stazione "cresce" a distanza.
     3. Rifornimento periodico §12.7 = UPKEEP MORBIDO: una linea di
        rifornimento dalla colonia fondatrice riempie il serbatoio; se
        isolata/non rifornita le funzioni DEGRADANO gradualmente (mai
        distruzione automatica — recovery-friendly #22).
     4. Stazione UNICA a LIVELLI (moduli #38): ogni livello aggiunge
        capacità (corazza, fuoco difensivo, serbatoio, riparazione).

   Modello dati (game.stations[]):
     { id, name, systemId, ownerColonyKey, level, phase, buildLeft,
       buildTotal, hp, supply, supplyState }
   `supply` è il serbatoio unico: serve da DEPOSITO, da carburante per
   RIFORNIRE le flotte (#69) e da costo di esercizio (UPKEEP che drena).

   Determinismo (#5): zero RNG (ID da game.idSeq via ORION.time.nextSeqId).
   Recovery-friendly (#22): nessun fail-state — l'isolamento degrada, non
   distrugge; la perdita in battaglia lascia ricostruire.
   Schema save 28.
   ===================================================================== */
(function (root) {
  'use strict';

  root.ORION = root.ORION || {};
  var ORION = root.ORION;

  /* ------------------------------------------------------------------ */
  var CFG = {
    MAX_LEVEL: 4,
    BUILD_RANGE: 4,          // hop massimi dalla colonia fondatrice
    SUPPLY_RANGE: 4,         // hop massimi entro cui una colonia rifornisce

    /* Costo/tempo di FONDAZIONE (livello 1). Gli upgrade scalano ×livello
       (stepCost/stepTime, come le strutture #38). */
    FOUND_COST: { met: 200, en: 100, food: 30 },
    FOUND_TIME: 120,         // Ι (GDD §4.4: stazione 120-150)
    STEP_TIME_GROWTH: 0.35,  // +35% tempo per modulo successivo

    /* Capacità per livello (× moduleSum: rendimento crescente, #38). */
    HP_BASE: 180,            // corazza per modulo
    DEF_FP_BASE: 10,         // fuoco difensivo per modulo
    SUPPLY_CAP_BASE: 300,    // serbatoio per modulo

    /* Linea di rifornimento (upkeep morbido). */
    REFILL_RATE: 2.0,        // unità di serbatoio/Ι riempite × livello
    REFILL_COST: { met: 0.4, food: 0.3, water: 0.3 }, // risorse/unità riempita
    UPKEEP: 0.4,             // serbatoio drenato/Ι × livello (esercizio)

    REPAIR_RATE: 1.2,        // hp/Ι × livello (passiva, se supply ok e non sotto attacco)

    /* Rifornimento flotte: serbatoio consumato per equipaggio per Ι di
       autonomia restituita (#69). */
    REFUEL_COST: 0.08,

    /* Soglie di stato del serbatoio (frazione del cap). */
    LOW_FRAC: 0.25
  };

  /* ------------------------------------------------------------------ */
  function msum(level) {
    var S = ORION.structures;
    return (S && S.moduleSum) ? S.moduleSum(level) : level;
  }
  function maxHp(level) { return Math.round(CFG.HP_BASE * msum(level)); }
  function defenseFp(level) { return Math.round(CFG.DEF_FP_BASE * msum(level)); }
  function supplyCap(level) { return Math.round(CFG.SUPPLY_CAP_BASE * level); }

  /* Costo/tempo del PROSSIMO modulo (fondazione = livello 1). */
  function stepCost(toLevel) {
    var base = CFG.FOUND_COST, out = {};
    for (var k in base) out[k] = Math.round(base[k] * toLevel);
    return out;
  }
  function stepTime(toLevel) {
    return Math.round(CFG.FOUND_TIME * (1 + CFG.STEP_TIME_GROWTH * (toLevel - 1)));
  }

  /* ------------------------------------------------------------------
     Distanza in hop fra due sistemi (BFS sul grafo galassia). Riusa
     ORION.fleet.computePath se disponibile; altrimenti BFS locale.
     ------------------------------------------------------------------ */
  function hopsBetween(galaxy, from, to) {
    if (from === to) return 0;
    if (ORION.fleet && ORION.fleet.computePath) {
      var path = ORION.fleet.computePath(galaxy, from, to);
      return path ? path.length - 1 : Infinity;
    }
    // BFS fallback
    var sys = galaxy && galaxy.systems;
    if (!sys) return Infinity;
    var seen = {}, q = [[from, 0]];
    seen[from] = true;
    while (q.length) {
      var cur = q.shift(), id = cur[0], d = cur[1];
      var links = (sys[id] && sys[id].links) || [];
      for (var i = 0; i < links.length; i++) {
        var n = links[i];
        if (seen[n]) continue;
        if (n === to) return d + 1;
        seen[n] = true;
        q.push([n, d + 1]);
      }
    }
    return Infinity;
  }

  /* Discovery: solo sistemi esplorati possono ospitare una stazione. La
     nebbia di guerra usa livelli numerici (ORION.galaxy.DISCOVERY.EXPLORED=2);
     accettiamo anche la forma stringa 'EXPLORED' per i test headless. */
  function isExplored(game, sysId) {
    var disc = game.state && game.state.discovery;
    if (!Array.isArray(disc)) return true; // headless senza fog → permissivo
    var v = disc[sysId];
    var EXP = (ORION.galaxy && ORION.galaxy.DISCOVERY) ? ORION.galaxy.DISCOVERY.EXPLORED : 2;
    if (typeof v === 'number') return v >= EXP;
    return v === 'EXPLORED';
  }

  function stationAt(game, sysId) {
    var list = game.stations || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].systemId === sysId) return list[i];
    }
    return null;
  }
  function stationById(game, id) {
    var list = game.stations || [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }
  function listOf(game) { return Array.isArray(game.stations) ? game.stations : []; }

  /* ------------------------------------------------------------------
     Costruzione remota da una colonia (decisione: scelta utente #2).
     ------------------------------------------------------------------ */
  function colonyCanPay(colony, cost) {
    if (!colony || !colony.stock) return false;
    for (var k in cost) if ((colony.stock[k] || 0) < cost[k]) return false;
    return true;
  }
  function colonyPay(colony, cost) {
    for (var k in cost) colony.stock[k] = Math.max(0, (colony.stock[k] || 0) - cost[k]);
  }

  /* Può la colonia `colonyKey` fondare una stazione nel sistema target? */
  function canBuild(game, colonyKey, targetSysId) {
    var colony = game.colonies && game.colonies[colonyKey];
    if (!colony || !colony.colonized) return { ok: false, reason: 'Colonia non valida' };
    if (colony.phase === 'settling') return { ok: false, reason: 'Colonia in insediamento' };
    if (!isExplored(game, targetSysId)) return { ok: false, reason: 'Sistema non esplorato' };
    if (stationAt(game, targetSysId)) return { ok: false, reason: 'Stazione già presente nel sistema' };
    var hops = hopsBetween(game.galaxy, colony.systemId, targetSysId);
    if (hops > CFG.BUILD_RANGE) return { ok: false, reason: 'Fuori raggio (' + hops + ' salti, max ' + CFG.BUILD_RANGE + ')' };
    var cost = stepCost(1);
    if (!colonyCanPay(colony, cost)) return { ok: false, reason: 'Risorse insufficienti' };
    return { ok: true, cost: cost, time: stepTime(1), hops: hops };
  }

  function nextId(game) {
    if (ORION.time && ORION.time.nextSeqId) return 'station-' + ORION.time.nextSeqId(game, 'station');
    if (!game.idSeq) game.idSeq = {};
    game.idSeq.station = (game.idSeq.station | 0) + 1;
    return 'station-' + game.idSeq.station;
  }

  /* Fonda una stazione: paga dalla colonia, entra in fase 'building'. */
  function build(game, colonyKey, targetSysId, name) {
    var chk = canBuild(game, colonyKey, targetSysId);
    if (!chk.ok) return chk;
    var colony = game.colonies[colonyKey];
    colonyPay(colony, chk.cost);
    if (!Array.isArray(game.stations)) game.stations = [];
    var st = {
      id: nextId(game),
      name: name || ('Stazione ' + (game.stations.length + 1)),
      systemId: targetSysId,
      ownerColonyKey: colonyKey,
      level: 0,                 // diventa 1 a fine costruzione
      phase: 'building',
      buildLeft: chk.time,
      buildTotal: chk.time,
      hp: 0,
      supply: 0,
      supplyState: 'ok'
    };
    game.stations.push(st);
    return { ok: true, station: st };
  }

  /* Avvia l'upgrade (+1 modulo) di una stazione operativa. La fase torna
     'building' ma le funzioni del livello corrente restano attive. */
  function canUpgrade(game, station) {
    if (!station || station.phase === 'building') return { ok: false, reason: 'Costruzione in corso' };
    if (station.level >= CFG.MAX_LEVEL) return { ok: false, reason: 'Livello massimo' };
    var colony = game.colonies && game.colonies[station.ownerColonyKey];
    if (!colony || !colony.colonized) return { ok: false, reason: 'Colonia fondatrice persa' };
    var cost = stepCost(station.level + 1);
    if (!colonyCanPay(colony, cost)) return { ok: false, reason: 'Risorse insufficienti' };
    return { ok: true, cost: cost, time: stepTime(station.level + 1) };
  }
  function upgrade(game, station) {
    var chk = canUpgrade(game, station);
    if (!chk.ok) return chk;
    colonyPay(game.colonies[station.ownerColonyKey], chk.cost);
    station.phase = 'building';
    station.buildLeft = chk.time;
    station.buildTotal = chk.time;
    station._upgrading = true;
    return { ok: true };
  }

  /* Smantella la stazione: rimborso 50% del costo del livello corrente alla
     colonia fondatrice (recovery-friendly, come cancelBuild). */
  function demolish(game, stationId) {
    var st = stationById(game, stationId);
    if (!st) return { ok: false };
    var lvl = Math.max(1, st.level);
    var colony = game.colonies && game.colonies[st.ownerColonyKey];
    if (colony && colony.stock) {
      var refund = stepCost(lvl);
      for (var k in refund) colony.stock[k] = (colony.stock[k] || 0) + Math.floor(refund[k] * 0.5);
    }
    game.stations = listOf(game).filter(function (s) { return s.id !== stationId; });
    return { ok: true };
  }

  /* Annulla la costruzione/upgrade in corso (rimborso 50%). */
  function cancelBuild(game, stationId) {
    var st = stationById(game, stationId);
    if (!st || st.phase !== 'building') return { ok: false };
    var lvl = st.level + 1;     // livello che si stava costruendo
    var colony = game.colonies && game.colonies[st.ownerColonyKey];
    if (colony && colony.stock) {
      var refund = stepCost(lvl);
      for (var k in refund) colony.stock[k] = (colony.stock[k] || 0) + Math.floor(refund[k] * 0.5);
    }
    if (st._upgrading) {
      // l'upgrade è annullato: la stazione resta al livello precedente
      st.phase = 'operational';
      st._upgrading = false;
      st.buildLeft = 0; st.buildTotal = 0;
      return { ok: true, removed: false };
    }
    // era la fondazione: rimuovi la stazione del tutto
    game.stations = listOf(game).filter(function (s) { return s.id !== stationId; });
    return { ok: true, removed: true };
  }

  /* ------------------------------------------------------------------
     RIFORNIMENTO flotte (#69): una stazione operativa con serbatoio è un
     "porto amico". Restituisce quanta autonomia (Ι) può dare per `crew`
     equipaggi e DEBITA il serbatoio. Recovery-friendly: parziale se a corto.
     ------------------------------------------------------------------ */
  function isOperationalPort(station) {
    return station && station.phase !== 'building' && station.level >= 1 &&
           station.supplyState !== 'isolated' && (station.supply || 0) > 0;
  }
  /* Quanti Ι di autonomia può fornire per `crew` equipaggi, dato `wantI`. */
  function refuelCapacity(station, crew, wantI) {
    if (!isOperationalPort(station)) return 0;
    var per = Math.max(1, crew) * CFG.REFUEL_COST;
    if (per <= 0) return wantI;
    var affordable = Math.floor((station.supply || 0) / per);
    return Math.min(wantI, affordable);
  }
  /* Esegue il rifornimento: debita il serbatoio, ritorna gli Ι forniti. */
  function drawRefuel(game, station, crew, wantI) {
    var giveI = refuelCapacity(station, crew, wantI);
    if (giveI <= 0) return 0;
    station.supply = Math.max(0, (station.supply || 0) - Math.max(1, crew) * CFG.REFUEL_COST * giveI);
    return giveI;
  }

  /* ------------------------------------------------------------------
     Forza difensiva al sistema (combat M09). Delegata a combat.forceFrom
     Station per i combattenti; qui esponiamo i numeri grezzi.
     ------------------------------------------------------------------ */
  function defenseStats(station) {
    if (!station || station.phase === 'building' && station.level < 1) return { hp: 0, fp: 0 };
    var lvl = Math.max(1, station.level);
    var fpFull = defenseFp(lvl);
    // isolata: difesa dimezzata (sistemi a corto di rifornimento)
    if (station.supplyState === 'isolated') fpFull = Math.round(fpFull * 0.5);
    return { hp: Math.max(1, Math.round(station.hp || 0)), maxHp: maxHp(lvl), fp: fpFull };
  }

  /* ------------------------------------------------------------------
     TICK: avanza costruzione, rifornisce dal colono, drena upkeep, ripara.
     Chiamato da time.js dopo i moduli di colonia. Recovery-friendly.
     ------------------------------------------------------------------ */
  function tick(game, events) {
    var list = listOf(game);
    if (!list.length) return;
    for (var i = 0; i < list.length; i++) {
      var st = list[i];
      if (!st) continue;

      // 1) Costruzione/upgrade in corso
      if (st.phase === 'building') {
        st.buildLeft = (st.buildLeft || 0) - 1;
        if (st.buildLeft <= 0) {
          var was = st.level;
          st.level = st.level + 1;
          st.phase = 'operational';
          st.buildLeft = 0;
          var hpNow = maxHp(st.level);
          // alla fondazione parte con hp pieno; agli upgrade aumenta il tetto
          if (was === 0) { st.hp = hpNow; st.supply = Math.round(supplyCap(st.level) * 0.5); }
          else { st.hp = Math.min(hpNow, (st.hp || 0) + (hpNow - maxHp(was))); }
          st._upgrading = false;
          if (events) events.push({
            kind: was === 0 ? 'station-built' : 'station-upgraded',
            stationId: st.id, name: st.name, systemId: st.systemId,
            level: st.level, impulso: game.timeImpulsi
          });
        }
        continue; // niente upkeep/refill mentre costruisce il primo modulo
      }
      if (st.level < 1) continue;

      // 2) Linea di rifornimento: la colonia fondatrice (o la più vicina
      //    propria entro raggio) riempie il serbatoio pagando risorse.
      var cap = supplyCap(st.level);
      var supplier = supplyColonyFor(game, st);
      var refilled = 0;
      if (supplier && (st.supply || 0) < cap) {
        var want = Math.min(CFG.REFILL_RATE * st.level, cap - (st.supply || 0));
        refilled = refillFrom(supplier, st, want);
      }

      // 3) Upkeep: esercizio drena il serbatoio
      var drain = CFG.UPKEEP * st.level;
      st.supply = Math.max(0, (st.supply || 0) - drain);

      // 4) Stato del serbatoio (per UI + degrado funzioni)
      var prev = st.supplyState;
      if (!supplier && (st.supply || 0) <= 0) st.supplyState = 'isolated';
      else if ((st.supply || 0) < cap * CFG.LOW_FRAC) st.supplyState = 'low';
      else st.supplyState = 'ok';
      if (events && prev !== st.supplyState && (st.supplyState === 'isolated' || (prev === 'isolated'))) {
        events.push({
          kind: st.supplyState === 'isolated' ? 'station-isolated' : 'station-resupplied',
          stationId: st.id, name: st.name, systemId: st.systemId, impulso: game.timeImpulsi
        });
      }

      // 5) Riparazione passiva (se rifornita e non sotto attacco)
      var hpCap = maxHp(st.level);
      if (st.supplyState !== 'isolated' && !st._underAttack && (st.hp || 0) < hpCap) {
        st.hp = Math.min(hpCap, (st.hp || 0) + CFG.REPAIR_RATE * st.level);
      }
      st._underAttack = false; // reset per il prossimo tick (settato da combat)
    }
  }

  /* Colonia che rifornisce: la fondatrice se viva ed entro raggio,
     altrimenti la propria più vicina entro SUPPLY_RANGE. */
  function supplyColonyFor(game, st) {
    var cols = game.colonies || {};
    var owner = cols[st.ownerColonyKey];
    if (owner && owner.colonized && owner.phase !== 'settling') {
      if (hopsBetween(game.galaxy, owner.systemId, st.systemId) <= CFG.SUPPLY_RANGE) return owner;
    }
    var best = null, bestH = Infinity;
    for (var k in cols) {
      var c = cols[k];
      if (!c || !c.colonized || c.phase === 'settling') continue;
      var h = hopsBetween(game.galaxy, c.systemId, st.systemId);
      if (h <= CFG.SUPPLY_RANGE && h < bestH) { bestH = h; best = c; }
    }
    return best;
  }

  /* Riempie il serbatoio di `want` unità pagando dallo stock del colono.
     Limitato dalla risorsa più scarsa (parziale, recovery-friendly). */
  function refillFrom(colony, st, want) {
    if (!colony.stock || want <= 0) return 0;
    var rate = CFG.REFILL_COST, frac = 1;
    for (var k in rate) {
      var need = rate[k] * want, have = colony.stock[k] || 0;
      if (need > have && rate[k] > 0) frac = Math.min(frac, have / need);
    }
    var fill = want * frac;
    if (fill <= 0) return 0;
    for (var k2 in rate) colony.stock[k2] = Math.max(0, (colony.stock[k2] || 0) - rate[k2] * fill);
    st.supply = Math.min(supplyCap(st.level), (st.supply || 0) + fill);
    return fill;
  }

  /* Tempo al prossimo evento-stazione (costruzione in corso) per
     nextEventImpulsi. */
  function minBuildLeft(game) {
    var list = listOf(game), m = Infinity;
    for (var i = 0; i < list.length; i++) {
      var st = list[i];
      if (st && st.phase === 'building' && st.buildLeft > 0) m = Math.min(m, st.buildLeft);
    }
    return m;
  }

  /* ------------------------------------------------------------------ */
  ORION.station = {
    CFG: CFG,
    msum: msum, maxHp: maxHp, defenseFp: defenseFp, supplyCap: supplyCap,
    stepCost: stepCost, stepTime: stepTime, hopsBetween: hopsBetween,
    stationAt: stationAt, stationById: stationById, listOf: listOf,
    canBuild: canBuild, build: build, canUpgrade: canUpgrade, upgrade: upgrade,
    demolish: demolish, cancelBuild: cancelBuild,
    isOperationalPort: isOperationalPort, refuelCapacity: refuelCapacity, drawRefuel: drawRefuel,
    defenseStats: defenseStats, supplyColonyFor: supplyColonyFor,
    tick: tick, minBuildLeft: minBuildLeft
  };
}(typeof window !== 'undefined' ? window : this));
