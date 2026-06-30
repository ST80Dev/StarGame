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
    /* Redesign logistica 2026: niente più muro netto a 4 hop. Costruzione e
       rifornitura sono ammesse fino a MAX_RANGE hop; entro COMFORT_RANGE
       l'efficienza logistica è piena, poi cala col gradiente L fino a L_FLOOR
       a MAX_RANGE. BUILD_RANGE/SUPPLY_RANGE restano (= MAX_RANGE) per i
       chiamanti esistenti. */
    COMFORT_RANGE: 4,        // hop entro cui L = 1.0 (pieno regime)
    MAX_RANGE: 8,            // hop massimi (costruzione + rifornitura); oltre → isolated
    L_FLOOR: 0.50,           // efficienza logistica minima a MAX_RANGE
    BUILD_RANGE: 8,          // alias storico = MAX_RANGE
    SUPPLY_RANGE: 8,         // alias storico = MAX_RANGE

    /* Costo/tempo di FONDAZIONE (livello 1). Gli upgrade scalano ×livello
       (stepCost/stepTime, come le strutture #38). */
    FOUND_COST: { met: 200, en: 100, food: 30 },
    FOUND_TIME: 120,         // Ι (GDD §4.4: stazione 120-150)
    STEP_TIME_GROWTH: 0.35,  // +35% tempo per modulo successivo

    /* Capacità per livello (× moduleSum: rendimento crescente, #38). */
    HP_BASE: 180,            // corazza per modulo
    DEF_FP_BASE: 10,         // fuoco difensivo per modulo

    /* MAGAZZINO TIPIZZATO UNICO (redesign 2026): sostituisce il serbatoio
       astratto + la riserva metalli. Tiene le 4 risorse base, quasi come lo
       stock di una colonia; da qui escono rifornimento flotte (4 risorse, come
       a colonia), metallo del cantiere, upkeep e gating riparazione. Cap
       per-risorsa × livello. Energia capiente: è la voce dominante del
       rifornimento (propulsione su stazza). */
    STORE_CAP_BASE: { food: 200, water: 200, met: 250, en: 600 },

    /* Rifornimento dalla colonia: trasferimento 1:1 PER-RISORSA dallo stock,
       cap di ritmo per Ι × livello (poi × L per distanza). */
    REFILL_RATE: { food: 3, water: 3, met: 5, en: 9 },

    /* Upkeep: sostentamento del personale di stazione (food/water) × livello. */
    UPKEEP: { food: 0.2, water: 0.2 },

    REPAIR_RATE: 1.2,        // hp/Ι × livello × L (se non isolata e non sotto attacco)

    /* Soglia "magazzino scarso" (frazione del cap totale). */
    LOW_FRAC: 0.25,

    /* ----------------------------------------------------------------
       CANTIERE LEGGERO/MEDIO (decisione utente 2026-06-18). Assembla navi
       leggere/medie (≤ Fregata) consumando METALLO dal magazzino unico
       (niente più riserva dedicata). Recovery-friendly (#22): se il metallo
       si esaurisce la costruzione si METTE IN PAUSA, non fallisce.
       ---------------------------------------------------------------- */
    SHIPYARD_CLASSES: ['explorer', 'estrattore', 'caccia', 'intercettore', 'corvetta', 'fregata'],
    /* Slip (cantieri paralleli) per livello stazione. idx = level (1..4). */
    BUILD_SLOTS_BY_LEVEL: [0, 1, 1, 2, 2]
  };
  var STORE_RES = ['food', 'water', 'met', 'en'];

  /* ------------------------------------------------------------------ */
  function msum(level) {
    var S = ORION.structures;
    return (S && S.moduleSum) ? S.moduleSum(level) : level;
  }
  function maxHp(level) { return Math.round(CFG.HP_BASE * msum(level)); }
  function defenseFp(level) { return Math.round(CFG.DEF_FP_BASE * msum(level)); }

  /* ------------------------------------------------------------------
     MAGAZZINO TIPIZZATO (redesign 2026). Cap per-risorsa × livello, helper
     di totale (per le soglie/UI), e migrazione lazy dai vecchi campi
     `supply` (astratto) + `metReserve` → `store` tipizzato.
     ------------------------------------------------------------------ */
  function storeCap(level) {
    var lvl = Math.max(1, level || 1), out = {};
    for (var i = 0; i < STORE_RES.length; i++) out[STORE_RES[i]] = Math.round(CFG.STORE_CAP_BASE[STORE_RES[i]] * lvl);
    return out;
  }
  function storeCapTotal(level) {
    var c = storeCap(level), t = 0;
    for (var i = 0; i < STORE_RES.length; i++) t += c[STORE_RES[i]];
    return t;
  }
  function storeTotal(st) {
    var s = st && st.store, t = 0;
    if (!s) return 0;
    for (var i = 0; i < STORE_RES.length; i++) t += (s[STORE_RES[i]] || 0);
    return t;
  }
  /* Lazy: assicura st.store, migrando dai vecchi campi se presenti (save < redesign).
     `supply` astratto → ripartito sui 4 (proporzioni del costo di rifornimento
     storico met/food/water + energia stimata); `metReserve` → store.met.
     Idempotente: una volta creato lo store, non rifa la migrazione. */
  function ensureStore(st) {
    if (!st) return null;
    if (st.store && typeof st.store === 'object') return st.store;
    var store = { food: 0, water: 0, met: 0, en: 0 };
    var legacy = st.supply;
    if (typeof legacy === 'number' && legacy > 0) {
      /* Vecchio serbatoio astratto: ripartizione plausibile (food/water/met/en). */
      store.food = legacy * 0.25; store.water = legacy * 0.25;
      store.met = legacy * 0.20;  store.en = legacy * 0.30;
    }
    if (typeof st.metReserve === 'number' && st.metReserve > 0) store.met += st.metReserve;
    /* Cap allo store del livello corrente (non sforare dopo la migrazione). */
    var cap = storeCap(Math.max(1, st.level || 1));
    for (var i = 0; i < STORE_RES.length; i++) {
      var k = STORE_RES[i];
      if (store[k] > cap[k]) store[k] = cap[k];
    }
    st.store = store;
    delete st.supply; delete st.metReserve;
    return store;
  }

  /* Efficienza logistica L ∈ [L_FLOOR, 1] in funzione della distanza-hop dalla
     colonia rifornitrice: piena entro COMFORT_RANGE, poi lineare fino a L_FLOOR
     a MAX_RANGE. Scala SOLO i ritmi (rifornimento, riparazione, consegna
     estratto), mai la potenza ferma (fuoco/corazza). h Infinity → 0. */
  function logisticsLForHops(hops) {
    if (!isFinite(hops)) return 0;
    if (hops <= CFG.COMFORT_RANGE) return 1;
    if (hops > CFG.MAX_RANGE) return 0;
    var span = Math.max(1, CFG.MAX_RANGE - CFG.COMFORT_RANGE);
    var over = hops - CFG.COMFORT_RANGE;
    return Math.max(CFG.L_FLOOR, 1 - (1 - CFG.L_FLOOR) * (over / span));
  }

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

  /* Una luna è ancorabile? (redesign lune): solo i corpi a giacimento PANIERE
     (lune) ospitano l'ancoraggio della stazione → estrazione di default. */
  function isAnchorableBody(game, sysId, bodyKey) {
    if (bodyKey == null) return false;
    if (!(ORION.system && ORION.system.generate && ORION.system.findBody &&
          ORION.anomaly && ORION.anomaly.bodyGiacimento)) return false;
    try {
      var sys = ORION.system.generate(game.galaxy, sysId);
      var b = ORION.system.findBody(sys, bodyKey);
      var gi = b && ORION.anomaly.bodyGiacimento(b);
      return !!(gi && gi.basket);
    } catch (e) { return false; }
  }

  /* Stazione del giocatore ANCORATA a (sysId, bodyKey) e operativa? Usata per la
     mutua esclusione con l'estrattore (fleet-target). */
  function stationAnchoredAt(game, sysId, bodyKey) {
    if (bodyKey == null) return null;
    var st = stationAt(game, sysId);
    if (!st || !isPlayerStation(st)) return null;
    if (st.bodyKey == null || String(st.bodyKey) !== String(bodyKey)) return null;
    if (st.phase === 'building' || (st.level || 0) < 1) return null;
    return st;
  }

  /* Può la colonia `colonyKey` fondare una stazione nel sistema target?
     `bodyKey` (opzionale) = luna a cui ancorare la stazione (estrazione a
     paniere di default). Va validato come corpo a paniere del sistema target. */
  function canBuild(game, colonyKey, targetSysId, bodyKey) {
    var colony = game.colonies && game.colonies[colonyKey];
    if (!colony || !colony.colonized) return { ok: false, reason: 'Colonia non valida' };
    if (colony.phase === 'settling') return { ok: false, reason: 'Colonia in insediamento' };
    if (!isExplored(game, targetSysId)) return { ok: false, reason: 'Sistema non esplorato' };
    if (stationAt(game, targetSysId)) return { ok: false, reason: 'Stazione già presente nel sistema' };
    var hops = hopsBetween(game.galaxy, colony.systemId, targetSysId);
    if (hops > CFG.BUILD_RANGE) return { ok: false, reason: 'Fuori raggio (' + hops + ' salti, max ' + CFG.BUILD_RANGE + ')' };
    if (bodyKey != null && !isAnchorableBody(game, targetSysId, bodyKey)) {
      return { ok: false, reason: 'Ancoraggio valido solo su una luna del sistema' };
    }
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

  /* Fonda una stazione: paga dalla colonia, entra in fase 'building'.
     `bodyKey` (opzionale) ancora la stazione a una luna del sistema → estrazione
     a paniere di default a costruzione finita (vedi anomaly.tick). */
  function build(game, colonyKey, targetSysId, name, bodyKey) {
    var chk = canBuild(game, colonyKey, targetSysId, bodyKey);
    if (!chk.ok) return chk;
    var colony = game.colonies[colonyKey];
    colonyPay(colony, chk.cost);
    if (!Array.isArray(game.stations)) game.stations = [];
    var st = {
      id: nextId(game),
      name: name || ('Stazione ' + (game.stations.length + 1)),
      systemId: targetSysId,
      bodyKey: (bodyKey != null) ? bodyKey : null,   // luna ancorata (o null = orbita il sistema)
      ownerColonyKey: colonyKey,
      level: 0,                 // diventa 1 a fine costruzione
      phase: 'building',
      buildLeft: chk.time,
      buildTotal: chk.time,
      hp: 0,
      /* Magazzino tipizzato unico (redesign 2026). */
      store: { food: 0, water: 0, met: 0, en: 0 },
      supplyState: 'ok',
      /* Colonia rifornitrice esplicita (riassegnabile). Default = fondatrice. */
      supplierColonyKey: colonyKey,
      owner: null,               // null = giocatore; <civId> = catturata (#81 Fase B)
      /* Cantiere leggero/medio: coda build + flotta-cantiere. Il metallo esce
         dal magazzino unico (store.met), niente più riserva dedicata. */
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
    if (!station || !isPlayerStation(station) || station.phase === 'building' || station.level < 1) return false;
    ensureStore(station);   // tollerante ai save vecchi caricati prima del primo tick
    return station.supplyState !== 'isolated' && storeTotal(station) > 0;
  }
  /* Cattura/riconquista. La cattura saccheggia il magazzino e marca l'owner;
     la riconquista azzera owner e riporta hp a una frazione (danneggiata ma
     recuperata). Recovery-friendly: mai persa per sempre. */
  function captureStation(station, civId) {
    station.owner = civId;
    var s = ensureStore(station);
    for (var i = 0; i < STORE_RES.length; i++) s[STORE_RES[i]] = Math.round((s[STORE_RES[i]] || 0) * 0.25);
    station.supplyState = 'isolated';
    station._sieged = false;
  }
  function retakeStation(station) {
    station.owner = null;
    station.hp = Math.max(1, Math.round(maxHp(Math.max(1, station.level)) * 0.4));
    station._sieged = false;
  }
  /* Rifornimento flotte (#69) dal MAGAZZINO TIPIZZATO. Coerente col meccanismo
     a colonia: il chiamante (fleet.js, unica sorgente dei tassi viveri) passa
     il costo PER Ι nelle 4 risorse (`costPerI`); qui calcoliamo quanti Ι sono
     coperti (limitati dalla risorsa più scarsa) e debitiamo lo store. */
  function refuelAffordableI(station, costPerI, wantI) {
    if (!isOperationalPort(station) || !costPerI) return 0;
    var s = ensureStore(station), frac = 1;
    for (var i = 0; i < STORE_RES.length; i++) {
      var k = STORE_RES[i], per = costPerI[k] || 0;
      if (per > 0) frac = Math.min(frac, (s[k] || 0) / (per * Math.max(1, wantI)));
    }
    var giveI = Math.floor(wantI * Math.min(1, frac));
    return Math.max(0, giveI);
  }
  function drawRefuelTyped(game, station, costPerI, wantI) {
    var giveI = refuelAffordableI(station, costPerI, wantI);
    if (giveI <= 0) return 0;
    var s = ensureStore(station);
    for (var i = 0; i < STORE_RES.length; i++) {
      var k = STORE_RES[i];
      s[k] = Math.max(0, (s[k] || 0) - (costPerI[k] || 0) * giveI);
    }
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
    var store = ensureStore(station);
    var built = [];
    for (var i = 0; i < station.buildQueue.length && i < slots; i++) {
      var job = station.buildQueue[i];
      var total = Math.max(1, job.total || 1);
      var perI = (job.metCost || 0) / total;
      if ((store.met || 0) < perI) continue;          // metallo a secco → pausa
      store.met = Math.max(0, (store.met || 0) - perI);
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
      ensureStore(st);   // migrazione lazy magazzino (save < redesign 2026)

      // 1) Costruzione/upgrade in corso
      if (st.phase === 'building') {
        st.buildLeft = (st.buildLeft || 0) - 1;
        if (st.buildLeft <= 0) {
          var was = st.level;
          st.level = st.level + 1;
          st.phase = 'operational';
          st.buildLeft = 0;
          var hpNow = maxHp(st.level);
          // alla fondazione parte con hp pieno + magazzino a metà cap; agli
          // upgrade aumenta il tetto corazza.
          if (was === 0) {
            st.hp = hpNow;
            var seed = storeCap(st.level), sst = ensureStore(st);
            for (var sk = 0; sk < STORE_RES.length; sk++) sst[STORE_RES[sk]] = Math.round(seed[STORE_RES[sk]] * 0.5);
          } else { st.hp = Math.min(hpNow, (st.hp || 0) + (hpNow - maxHp(was))); }
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

      // 2) Rifornimento dal MAGAZZINO TIPIZZATO: la colonia rifornitrice
      //    (esplicita, riassegnabile) versa per-risorsa 1:1, a ritmo × L
      //    (gradiente di distanza). Se la rifornitrice scelta è persa/fuori
      //    raggio, auto-fallback alla valida più vicina ≤ MAX_RANGE.
      var store = ensureStore(st);
      var cap = storeCap(st.level);
      var sup = supplierColonyFor(game, st);
      if (sup && sup.fellBack) st.supplierColonyKey = sup.key;   // auto-riassegnazione
      var L = sup ? sup.L : 0;
      if (sup && sup.colony && sup.colony.stock) {
        for (var ri = 0; ri < STORE_RES.length; ri++) {
          var rk = STORE_RES[ri];
          var room = cap[rk] - (store[rk] || 0);
          if (room <= 0) continue;
          var rate = CFG.REFILL_RATE[rk] * st.level * L;
          var take = Math.min(rate, room, sup.colony.stock[rk] || 0);
          if (take > 0) { sup.colony.stock[rk] = Math.max(0, (sup.colony.stock[rk] || 0) - take); store[rk] = (store[rk] || 0) + take; }
        }
      }

      // 3) Upkeep: sostentamento del personale (food/water) × livello.
      store.food = Math.max(0, (store.food || 0) - CFG.UPKEEP.food * st.level);
      store.water = Math.max(0, (store.water || 0) - CFG.UPKEEP.water * st.level);

      // 4) Stato logistico (per UI + degrado funzioni): basato sul riempimento
      //    totale del magazzino + raggiungibilità di una rifornitrice.
      var total = storeTotal(st), capTot = storeCapTotal(st.level);
      var prev = st.supplyState;
      if (!sup && total <= 0) st.supplyState = 'isolated';
      else if (total < capTot * CFG.LOW_FRAC) st.supplyState = 'low';
      else st.supplyState = 'ok';
      st._logL = L;   // efficienza logistica corrente (UI: distanza/tier)
      if (events && prev !== st.supplyState && (st.supplyState === 'isolated' || (prev === 'isolated'))) {
        events.push({
          kind: st.supplyState === 'isolated' ? 'station-isolated' : 'station-resupplied',
          stationId: st.id, name: st.name, systemId: st.systemId, impulso: game.timeImpulsi
        });
      }

      // 5) Riparazione passiva × L (recupero scala con la distanza: una base
      //    lontana ripara più lenta perché i rifornimenti arrivano meno/piano —
      //    la potenza ferma resta piena). Niente se isolata o sotto attacco.
      var hpCap = maxHp(st.level);
      if (st.supplyState !== 'isolated' && L > 0 && !st._underAttack && (st.hp || 0) < hpCap) {
        st.hp = Math.min(hpCap, (st.hp || 0) + CFG.REPAIR_RATE * st.level * L);
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

  /* Colonia rifornitrice (redesign 2026): ESPLICITA e riassegnabile. Si usa
     `st.supplierColonyKey` (default = fondatrice) se valida (colonizzata,
     operativa) ed entro MAX_RANGE; altrimenti FALLBACK alla valida più vicina
     ≤ MAX_RANGE (e si segnala `fellBack` → il tick riassegna). Ritorna
     { key, colony, hops, L, fellBack } o null se nessuna ≤ MAX_RANGE (isolata).
     `L` = efficienza logistica dalla distanza (gradiente). */
  function supplierColonyFor(game, st) {
    var cols = game.colonies || {};
    function valid(key) { var c = cols[key]; return (c && c.colonized && c.phase !== 'settling') ? c : null; }
    var exKey = st.supplierColonyKey || st.ownerColonyKey;
    var ex = valid(exKey);
    if (ex) {
      var h = hopsBetween(game.galaxy, ex.systemId, st.systemId);
      if (h <= CFG.MAX_RANGE) return { key: exKey, colony: ex, hops: h, L: logisticsLForHops(h), fellBack: false };
    }
    var bestK = null, best = null, bestH = Infinity;
    for (var k in cols) {
      var c = valid(k); if (!c) continue;
      var hh = hopsBetween(game.galaxy, c.systemId, st.systemId);
      if (hh <= CFG.MAX_RANGE && hh < bestH) { bestH = hh; bestK = k; best = c; }
    }
    if (best) return { key: bestK, colony: best, hops: bestH, L: logisticsLForHops(bestH), fellBack: (bestK !== exKey) };
    return null;
  }
  /* Compat: vecchi chiamanti che volevano solo la colonia. */
  function supplyColonyFor(game, st) { var r = supplierColonyFor(game, st); return r ? r.colony : null; }

  /* Riassegna manualmente la rifornitrice (azione del giocatore). Vincolo:
     colonia propria operativa entro MAX_RANGE. Libera e istantanea. */
  function canAssignSupplier(game, st, colonyKey) {
    var c = game.colonies && game.colonies[colonyKey];
    if (!c || !c.colonized || c.phase === 'settling') return { ok: false, reason: 'Colonia non valida' };
    var h = hopsBetween(game.galaxy, c.systemId, st.systemId);
    if (h > CFG.MAX_RANGE) return { ok: false, reason: 'Fuori raggio (' + h + ' salti, max ' + CFG.MAX_RANGE + ')' };
    return { ok: true, hops: h, L: logisticsLForHops(h) };
  }
  function assignSupplier(game, st, colonyKey) {
    var chk = canAssignSupplier(game, st, colonyKey);
    if (!chk.ok) return chk;
    st.supplierColonyKey = colonyKey;
    return { ok: true, hops: chk.hops, L: chk.L };
  }
  /* Colonie eleggibili come rifornitrici per una stazione (proprie, operative,
     ≤ MAX_RANGE), con distanza/L — per la UI di riassegnazione. */
  function eligibleSuppliers(game, st) {
    var cols = game.colonies || {}, out = [];
    for (var k in cols) {
      var c = cols[k];
      if (!c || !c.colonized || c.phase === 'settling') continue;
      var h = hopsBetween(game.galaxy, c.systemId, st.systemId);
      if (h <= CFG.MAX_RANGE) out.push({ key: k, hops: h, L: logisticsLForHops(h) });
    }
    out.sort(function (a, b) { return a.hops - b.hops; });
    return out;
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
    msum: msum, maxHp: maxHp, defenseFp: defenseFp,
    /* Magazzino tipizzato (redesign 2026). */
    storeCap: storeCap, storeCapTotal: storeCapTotal, storeTotal: storeTotal, ensureStore: ensureStore,
    STORE_RES: STORE_RES, logisticsLForHops: logisticsLForHops,
    stepCost: stepCost, stepTime: stepTime, hopsBetween: hopsBetween,
    stationAt: stationAt, stationById: stationById, listOf: listOf,
    isPlayerStation: isPlayerStation, playerStationAt: playerStationAt, capturedStationAt: capturedStationAt,
    captureStation: captureStation, retakeStation: retakeStation,
    isAnchorableBody: isAnchorableBody, stationAnchoredAt: stationAnchoredAt,
    canBuild: canBuild, build: build, canUpgrade: canUpgrade, upgrade: upgrade,
    demolish: demolish, cancelBuild: cancelBuild,
    isOperationalPort: isOperationalPort,
    refuelAffordableI: refuelAffordableI, drawRefuelTyped: drawRefuelTyped,
    defenseStats: defenseStats,
    supplyColonyFor: supplyColonyFor, supplierColonyFor: supplierColonyFor,
    canAssignSupplier: canAssignSupplier, assignSupplier: assignSupplier, eligibleSuppliers: eligibleSuppliers,
    /* Cantiere leggero/medio (M16, 2026-06-18). */
    buildSlotsFor: buildSlotsFor,
    canBuildClass: canBuildClass, shipMetCost: shipMetCost, shipBuildTime: shipBuildTime,
    activeShipyardBuilds: activeShipyardBuilds, canBuildShipAt: canBuildShipAt,
    startShipBuild: startShipBuild, cancelShipBuild: cancelShipBuild,
    tick: tick, minBuildLeft: minBuildLeft
  };
}(typeof window !== 'undefined' ? window : this));
