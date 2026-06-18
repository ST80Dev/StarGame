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
    LOW_FRAC: 0.25,

    /* ----------------------------------------------------------------
       CANTIERE LEGGERO/MEDIO (decisione utente 2026-06-18). La Stazione
       NON è una colonia: non produce risorse, ma può ASSEMBLARE navi
       leggere/medie (fino alla Fregata) da una RISERVA DI METALLI dedicata,
       riempita dalla stessa linea di rifornimento del serbatoio. Le navi
       grandi (Incrociatore/Dread/Ammiraglia) restano esclusiva delle
       colonie (Hangar+Bacino). Recovery-friendly (#22): se la riserva si
       svuota la costruzione si METTE IN PAUSA, non fallisce.
       ---------------------------------------------------------------- */
    /* Classi assemblabili alla stazione (≤ Fregata, niente capitali né
       coloniale: la colonizzazione resta legata alle colonie). */
    SHIPYARD_CLASSES: ['explorer', 'estrattore', 'caccia', 'intercettore', 'corvetta', 'fregata'],
    /* Slip (cantieri paralleli) per livello stazione. idx = level (1..4). */
    BUILD_SLOTS_BY_LEVEL: [0, 1, 1, 2, 2],
    MET_RESERVE_CAP_BASE: 250,   // tetto riserva metalli per modulo (× livello)
    MET_REFILL_RATE: 8           // metallo/Ι versato dalla linea (× livello, 1:1 dallo stock colono)
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
      supplyState: 'ok',
      owner: null,               // null = giocatore; <civId> = catturata (#81 Fase B)
      /* Cantiere leggero/medio (2026-06-18): riserva metalli + coda build +
         flotta-cantiere dove confluiscono gli scafi assemblati. Additivi/lazy. */
      metReserve: 0,
      buildQueue: [],
      yardFleetId: null
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
  /* Ownership (#81 Fase B): una stazione catturata (owner != null) non è più
     un porto/difesa del giocatore — diventa un presidio AI riconquistabile. */
  function isPlayerStation(station) { return station && station.owner == null; }
  function playerStationAt(game, sysId) {
    var st = stationAt(game, sysId);
    return (st && isPlayerStation(st)) ? st : null;
  }
  function capturedStationAt(game, sysId) {
    var st = stationAt(game, sysId);
    return (st && !isPlayerStation(st)) ? st : null;
  }
  function isOperationalPort(station) {
    return station && isPlayerStation(station) && station.phase !== 'building' && station.level >= 1 &&
           station.supplyState !== 'isolated' && (station.supply || 0) > 0;
  }
  /* Cattura/riconquista. La cattura abbassa il serbatoio (saccheggiato) e
     marca l'owner; la riconquista azzera owner e riporta hp a una frazione
     (danneggiata ma recuperata). Recovery-friendly: mai persa per sempre. */
  function captureStation(station, civId) {
    station.owner = civId;
    station.supply = Math.round((station.supply || 0) * 0.25);
    station.supplyState = 'isolated';
    station._sieged = false;
  }
  function retakeStation(station) {
    station.owner = null;
    station.hp = Math.max(1, Math.round(maxHp(Math.max(1, station.level)) * 0.4));
    station._sieged = false;
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

  /* ==================================================================
     CANTIERE LEGGERO/MEDIO (decisione utente 2026-06-18). Sostituisce il
     vecchio "cantiere orbitale per capitali" (orbitalShipyardFor, rimosso):
     le navi grandi ora si costruiscono SOLO su colonia (Hangar + Bacino di
     costruzione). La Stazione assembla scafi ≤ Fregata da una RISERVA DI
     METALLI, riempita dalla linea di rifornimento; il costo è in solo
     metallo (l'energia è astratta nei reattori della stazione). NON è una
     colonia: non produce risorse, solo assembla. Determinismo (#5): no RNG.
     Recovery-friendly (#22): se la riserva è a secco la build si PAUSA.
     ================================================================== */
  function buildSlotsFor(station) {
    if (!station) return 0;
    var lvl = Math.max(0, Math.min(station.level | 0, CFG.BUILD_SLOTS_BY_LEVEL.length - 1));
    return CFG.BUILD_SLOTS_BY_LEVEL[lvl] || 0;
  }
  function metReserveCap(level) { return Math.round(CFG.MET_RESERVE_CAP_BASE * Math.max(1, level)); }
  function canBuildClass(kind) { return CFG.SHIPYARD_CLASSES.indexOf(kind) >= 0; }
  function shipMetCost(kind) {
    var F = ORION.fleet, cls = F && F.getClass && F.getClass(kind);
    return (cls && cls.cost && cls.cost.met) ? cls.cost.met : 0;
  }
  function shipBuildTime(kind) {
    var F = ORION.fleet, cls = F && F.getClass && F.getClass(kind);
    return (cls && cls.time) ? cls.time : 10;
  }
  function activeShipyardBuilds(station) {
    return (station && Array.isArray(station.buildQueue)) ? station.buildQueue.length : 0;
  }
  /* Si può accodare uno scafo? Gate su classe (≤ Fregata) e slip liberi. La
     riserva metalli NON blocca l'accodamento (la build attende il metallo). */
  function canBuildShipAt(game, station, kind) {
    if (!station || !isPlayerStation(station)) return { ok: false, reason: 'Stazione non disponibile' };
    if (station.phase === 'building' || station.level < 1) return { ok: false, reason: 'Stazione non operativa' };
    if (!canBuildClass(kind)) return { ok: false, reason: 'La stazione assembla solo navi leggere/medie (≤ Fregata)' };
    var slots = buildSlotsFor(station);
    if (slots <= 0) return { ok: false, reason: 'Nessun cantiere a questo livello' };
    var active = activeShipyardBuilds(station);
    if (active >= slots) {
      return { ok: false, reason: 'Cantieri saturi (' + active + '/' + slots + '). Potenzia la stazione.' };
    }
    return { ok: true, metCost: shipMetCost(kind), time: shipBuildTime(kind) };
  }
  function startShipBuild(game, station, kind) {
    var chk = canBuildShipAt(game, station, kind);
    if (!chk.ok) return chk;
    if (!Array.isArray(station.buildQueue)) station.buildQueue = [];
    station.buildQueue.push({ kind: kind, left: chk.time, total: chk.time, metCost: chk.metCost });
    return { ok: true };
  }
  function cancelShipBuild(game, station, idx) {
    if (!station || !Array.isArray(station.buildQueue)) return { ok: false };
    if (idx < 0 || idx >= station.buildQueue.length) return { ok: false };
    station.buildQueue.splice(idx, 1);
    return { ok: true };
  }

  /* Colonia "proprietaria" della flotta di cantiere: la fondatrice se viva,
     altrimenti una qualsiasi colonia operativa (per dare un owner ai libri). */
  function resolveOwnerColonyKey(game, station) {
    var cols = game.colonies || {};
    var own = cols[station.ownerColonyKey];
    if (own && own.colonized && own.phase !== 'settling') return station.ownerColonyKey;
    for (var k in cols) {
      var c = cols[k];
      if (c && c.colonized && c.phase !== 'settling') return k;
    }
    return null;
  }
  /* Flotta-cantiere: le navi assemblate si accumulano in una flotta ormeggiata
     alla stazione (berth 'station'). Riusata se esiste ancora, altrimenti
     creata. Ritorna null se non c'è alcuna colonia che faccia da owner. */
  function yardFleetFor(game, station) {
    var F = ORION.fleet;
    if (!F || !F.createFleet) return null;
    var fleets = game.fleets || [];
    if (station.yardFleetId) {
      for (var i = 0; i < fleets.length; i++) {
        var f = fleets[i];
        if (f && f.id === station.yardFleetId && f.location &&
            f.location.systemId === station.systemId && f.location.status === 'docked') return f;
      }
    }
    var ownerKey = resolveOwnerColonyKey(game, station);
    if (!ownerKey) return null;
    var cr = F.createFleet(game, ownerKey, 'Cantiere ' + (station.name || 'stazione'));
    if (!cr.ok || !cr.fleet) return null;
    var fl = cr.fleet;
    fl.location = { systemId: station.systemId, status: 'docked', berth: 'station', bodyKey: null };
    station.yardFleetId = fl.id;
    return fl;
  }
  function nextCrewIdFor(game) {
    var T = ORION.time;
    if (T && T.nextCrewId) return T.nextCrewId(game);
    if (!game.idSeq) game.idSeq = {};
    game.idSeq.crew = (game.idSeq.crew | 0) + 1;
    return 'crew-' + game.idSeq.crew;
  }
  /* Avanza le build attive (una per slip): consumo metallo "a goccia"
     (metCost/total per Ι); se la riserva è a secco la build si pausa. A
     completamento, la nave entra nella flotta-cantiere con equipaggio
     reclute (la stazione la arma). Emette 'station-ship-built' (silenzioso). */
  function tickShipyard(game, station, events) {
    if (!Array.isArray(station.buildQueue) || !station.buildQueue.length) return;
    var slots = buildSlotsFor(station);
    var built = [];
    for (var i = 0; i < station.buildQueue.length && i < slots; i++) {
      var job = station.buildQueue[i];
      var total = Math.max(1, job.total || 1);
      var perI = (job.metCost || 0) / total;
      if ((station.metReserve || 0) < perI) continue;          // a secco → pausa
      station.metReserve = Math.max(0, (station.metReserve || 0) - perI);
      job.left = (job.left || 0) - 1;
      if (job.left <= 0) built.push(job);
    }
    for (var b = 0; b < built.length; b++) {
      var done = built[b];
      var idx = station.buildQueue.indexOf(done);
      if (idx >= 0) station.buildQueue.splice(idx, 1);
      var fl = yardFleetFor(game, station);
      if (fl && ORION.fleet.addNewShip) {
        ORION.fleet.addNewShip(game, fl, done.kind);
        if (!Array.isArray(fl.crew)) fl.crew = [];
        fl.crew.push({ id: nextCrewIdFor(game), xp: 0 });
        if (events) events.push({
          kind: 'station-ship-built', stationId: station.id, name: station.name,
          systemId: station.systemId, shipKind: done.kind, impulso: game.timeImpulsi
        });
      }
    }
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

      // Stazione CATTURATA (#81 Fase B): non è più tua → niente rifornimento
      // né riparazione del giocatore. Resta come husk difensivo riconquistabile.
      if (!isPlayerStation(st)) continue;

      // 2) Linea di rifornimento: la colonia fondatrice (o la più vicina
      //    propria entro raggio) riempie il serbatoio pagando risorse.
      var cap = supplyCap(st.level);
      var supplier = supplyColonyFor(game, st);
      var refilled = 0;
      if (supplier && (st.supply || 0) < cap) {
        var want = Math.min(CFG.REFILL_RATE * st.level, cap - (st.supply || 0));
        refilled = refillFrom(supplier, st, want);
      }

      // 2b) Riserva metalli del cantiere (decisione 2026-06-18): la stessa
      //     colonia rifornitrice versa metallo (1:1) fino al tetto del livello.
      var metCap = metReserveCap(st.level);
      if (supplier && supplier.stock && (st.metReserve || 0) < metCap) {
        var wantMet = Math.min(CFG.MET_REFILL_RATE * st.level, metCap - (st.metReserve || 0), supplier.stock.met || 0);
        if (wantMet > 0) {
          supplier.stock.met = Math.max(0, (supplier.stock.met || 0) - wantMet);
          st.metReserve = (st.metReserve || 0) + wantMet;
        }
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

      /* 6) Refit navi al porto orbitale (richiesta utente 2026-06-16).
         Stazione operativa lvl ≥ 2 e rifornita: ripara il wear delle navi
         delle flotte ferme nel sistema. Niente costo per il giocatore — la
         stazione paga con il proprio supply (già drenato dall'upkeep sopra).
         Skip se supply isolated (la stazione non ha materiali per il refit). */
      if (st.supplyState !== 'isolated' && root.ORION && root.ORION.fleet &&
          root.ORION.fleet.tickStationRepair) {
        root.ORION.fleet.tickStationRepair(game, st);
      }

      // 7) Cantiere leggero/medio: avanza le build attive (consumo riserva
      //    metalli; pausa se a secco). Anche se isolata, finché c'è metallo
      //    residuo la build può progredire (recovery-friendly).
      tickShipyard(game, st, events);
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
      if (!st) continue;
      if (st.phase === 'building' && st.buildLeft > 0) m = Math.min(m, st.buildLeft);
      // Cantiere leggero/medio: includi gli scafi negli slip attivi (lower
      // bound; se in pausa per metallo a secco il risveglio anticipato è innocuo).
      var slots = buildSlotsFor(st);
      var q = st.buildQueue || [];
      for (var j = 0; j < q.length && j < slots; j++) {
        if (q[j] && q[j].left > 0) m = Math.min(m, q[j].left);
      }
    }
    return m;
  }

  /* ------------------------------------------------------------------ */
  ORION.station = {
    CFG: CFG,
    msum: msum, maxHp: maxHp, defenseFp: defenseFp, supplyCap: supplyCap,
    stepCost: stepCost, stepTime: stepTime, hopsBetween: hopsBetween,
    stationAt: stationAt, stationById: stationById, listOf: listOf,
    isPlayerStation: isPlayerStation, playerStationAt: playerStationAt, capturedStationAt: capturedStationAt,
    captureStation: captureStation, retakeStation: retakeStation,
    canBuild: canBuild, build: build, canUpgrade: canUpgrade, upgrade: upgrade,
    demolish: demolish, cancelBuild: cancelBuild,
    isOperationalPort: isOperationalPort, refuelCapacity: refuelCapacity, drawRefuel: drawRefuel,
    defenseStats: defenseStats, supplyColonyFor: supplyColonyFor,
    /* Cantiere leggero/medio (M16, 2026-06-18). */
    buildSlotsFor: buildSlotsFor, metReserveCap: metReserveCap,
    canBuildClass: canBuildClass, shipMetCost: shipMetCost, shipBuildTime: shipBuildTime,
    activeShipyardBuilds: activeShipyardBuilds, canBuildShipAt: canBuildShipAt,
    startShipBuild: startShipBuild, cancelShipBuild: cancelShipBuild,
    tick: tick, minBuildLeft: minBuildLeft
  };
}(typeof window !== 'undefined' ? window : this));
