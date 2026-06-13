/* =====================================================================
   ORION EMPIRES — trade.js
   Modulo M12 (Fase A1): Commercio — mercato interno (rotte colonia↔colonia)
   + classe Mercantile come entità con xp. Design: decisione #53, GDD §15.2/§15.6.

   SCOPE FASE A1 (questo file):
     - Catalogo MERCANTILE_TIERS (3 livelli costruttivi, §15.6): cargo come
       stat propria (non fp), range in hop crescente, xp individuale.
     - Mercantili come ENTITÀ con xp (parallelo agli equipaggi M07
       `colony.crews.explorer`, decisione #37): vivono in `colony.mercantili`,
       costruiti dall'Hangar via `colony.assets.mercantileQueue`.
       NB: non sono nel counter fungibile `colony.ships.<kind>` (quello è per
       le navi da flotta M08) perché tier+xp richiedono identità individuale.
     - Rotte interne (§15.2): flusso passivo per Impulso (no microgestione)
       che sposta una risorsa base (met/en/food/water) da una colonia all'altra.
       Capacità (N rotte + throughput/Ι) sommata dai Mercati §10 del giocatore;
       distanza (hop) limitata dal livello del Mercantile assegnato (§15.6).
       Uso primario early: spostare cibo/acqua dai mondi-giardino ai mondi-
       fabbrica → sblocca la saturazione del cap popolazione (emenda #45/#37).

   FASE A2 (task separato): Tesoreria + valute regionali (§15.4), accordi
   commerciali con AI (§15.3). FASE B: funzioni Mekhari (§15.5), eventi
   perturbativi avanzati (§15.7).

   Determinismo (decisione #5/#22): ZERO Math.random. Il flusso e la
   maturazione xp sono funzioni pure dello stato + del tempo; gli id dei
   mercantili/rotte derivano dal timer in-process. Replay identico.
   Recovery-friendly: nessun fail-state. Una rotta che si interrompe (sorgente
   esaurita, transito ostile) resta in lista e riparte da sola.

   Lessico SW-flavor (decisione #34): "rotta iperspaziale", "convoglio",
   "consorzio mercantile".
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  /* Risorse base trasportabili (Fase A1). Le avanzate §7.2 in lotti
     arriveranno con prerequisiti tech (Fase A2/M13). */
  const TRADE_RESOURCES = ['met', 'en', 'food', 'water'];

  /* Catalogo mercantili (§15.6). `cargo` = throughput sostenibile per rotta
     (unità/Ι) — reinterpretiamo il "cargo per viaggio" come tetto di flusso
     continuo per restare coerenti col modello "rotta = flusso passivo, niente
     microgestione" (§15.2). `hops` = raggio base (numero di salti) modulato
     dall'xp. `hangarLvl` = livello minimo dell'Hangar che lo vara.
     Il tier 3 richiede l'iperguida (M13, decisione #32): in Fase A1 resta
     bloccato dal marker `requires: ['tech:iperguida']`. */
  const MERCANTILE_TIERS = [
    {
      tier: 1, name: 'Cargo leggero', glyph: '◈',
      cost: { met: 30, en: 15 }, time: 14,
      cargo: 6, hops: 1, hangarLvl: 1, requires: []
    },
    {
      tier: 2, name: 'Cargo pesante', glyph: '◆',
      cost: { met: 60, en: 30, food: 5 }, time: 24,
      cargo: 12, hops: 3, hangarLvl: 2, requires: []
    },
    {
      tier: 3, name: 'Convoglio iperspaziale', glyph: '⬡',
      cost: { met: 120, en: 60 }, time: 40,
      cargo: 24, hops: 99, hangarLvl: 3, requires: ['tech:iperguida']
    }
  ];

  /* Ranghi per xp (analogia M07 equipaggi + M09 veteranità navi, decisione
     #39). Bonus §15.6: +10% cargo a esperta, +1 hop a veterana, +2 a
     leggendaria, −% rischio pirati con xp (riduzione hop-risk → gancio
     eventi perturbativi Fase B). */
  const MERC_RANKS = [
    { id: 'novizia',     label: 'novizia',     minXp: 0,  cargoMul: 1.0, hopBonus: 0, pirateMul: 1.0 },
    { id: 'esperta',     label: 'esperta',     minXp: 3,  cargoMul: 1.1, hopBonus: 0, pirateMul: 0.9 },
    { id: 'veterana',    label: 'veterana',    minXp: 6,  cargoMul: 1.1, hopBonus: 1, pirateMul: 0.8 },
    { id: 'leggendaria', label: 'leggendaria', minXp: 12, cargoMul: 1.2, hopBonus: 2, pirateMul: 0.7 }
  ];

  /* Throughput/rotte per livello di Mercato §10 (§15.2). Sommati sulle
     colonie del giocatore. Letti anche da structures.js (campi
     tradeRoutes/tradeThroughput) se presenti, con questi come fallback. */
  const MARKET_ROUTES = [2, 3, 4, 5, 7];
  const MARKET_THROUGHPUT = [8, 12, 18, 26, 36];
  /* M16 Fase B (#81): hub commerciale — bonus per stazione operativa. */
  const STATION_HUB_ROUTES = 1;
  const STATION_HUB_THROUGHPUT = 6;   // × livello stazione (lvl 4 → +24/Ι)

  /* Impulsi per "viaggio completo" usati per maturare 1 xp. Più la rotta è
     lunga (più hop), più lentamente matura — coerente con "tenere viva la
     stessa nave conta" (decisione #39). */
  const TRIP_PER_HOP = 60;

  /* ------------------------------------------------------------------
     Eventi perturbativi §15.7 (Fase B). Razzie pirata sulle rotte
     deterministiche (RNG da seed+rotta+Impulso), mitigate dall'xp del
     mercantile; usura accumulata che a 100 ritira il mercantile.
     ------------------------------------------------------------------ */
  const RAID_BASE = 0.05;            // prob. base/Ι a minaccia piena (× threat × resistenza xp)
  const RAID_WEAR_MIN = 12;          // usura inflitta da una razzia
  const RAID_WEAR_MAX = 26;
  const WEAR_MAX = 100;              // a 100 il mercantile è ritirato dal servizio
  const WEAR_CARGO_PENALTY = 0.25;   // cargo −25% a usura piena (penalità graduale)
  const COHESION_THREAT = 0.15;      // bump rischio attraversando un sistema coeso non-alleato

  function getTier(tier) {
    for (let i = 0; i < MERCANTILE_TIERS.length; i++) {
      if (MERCANTILE_TIERS[i].tier === tier) return MERCANTILE_TIERS[i];
    }
    return null;
  }

  function rankForXp(xp) {
    xp = xp || 0;
    let r = MERC_RANKS[0];
    for (let i = 0; i < MERC_RANKS.length; i++) {
      if (xp >= MERC_RANKS[i].minXp) r = MERC_RANKS[i];
    }
    return r;
  }

  /* ------------------------------------------------------------------
     Lazy-init dello stato di colonia. `colony.mercantili` (entità con xp)
     e `colony.assets.mercantileQueue` (coda di costruzione). Pattern
     identico a crews/ships (M07) → nessun bump di schema necessario per i
     campi di colonia (sono auto-serializzati dentro game.colonies).
     ------------------------------------------------------------------ */
  function ensureColonyTrade(colony) {
    if (!colony) return;
    if (!Array.isArray(colony.mercantili)) colony.mercantili = [];
    if (!colony.assets) colony.assets = {};
    if (!Array.isArray(colony.assets.mercantileQueue)) colony.assets.mercantileQueue = [];
  }

  /* Livello dell'Hangar di costruzione di una colonia (0 se assente). */
  function hangarLevelOf(colony) {
    const h = colony && colony.structures && colony.structures['cantiere-navale'];
    return h ? (h.level || 1) : 0;
  }

  /* Livello del Mercato di una colonia (0 se assente). */
  function marketLevelOf(colony) {
    const m = colony && colony.structures && colony.structures['mercato'];
    return m ? (m.level || 1) : 0;
  }

  /* Tier costruibile massimo data la colonia: limitato dal livello Hangar e
     dai prerequisiti tech (tier 3 bloccato finché M13 non sblocca
     `tech:iperguida`). */
  function buildableTier(colony, game) {
    const lvl = hangarLevelOf(colony);
    let best = 0;
    for (let i = 0; i < MERCANTILE_TIERS.length; i++) {
      const t = MERCANTILE_TIERS[i];
      if (t.hangarLvl > lvl) continue;
      if (!requiresSatisfied(t, colony, game)) continue;
      if (t.tier > best) best = t.tier;
    }
    return best;
  }

  /* I prerequisiti tech/scan delle navi mercantili. In Fase A1 non esiste
     alcuna tech (M13): `tech:*` è sempre falso → tier 3 bloccato. Lasciamo
     l'aggancio pronto come per le strutture (#15). */
  function requiresSatisfied(tierDef, colony, game) {
    const req = tierDef.requires || [];
    for (let i = 0; i < req.length; i++) {
      const r = req[i];
      if (r.indexOf('tech:') === 0) {
        /* M13 (decisione #57): sbloccata se la tech è nel pool d'impero. */
        if (!root.ORION.research || !root.ORION.research.isUnlocked(game, r.slice(5))) return false;
      }
    }
    return true;
  }

  /* Cargo effettivo (throughput/Ι) di un mercantile = cargo tier × cargoMul
     del rango. La penalità d'usura (§15.7) riduce gradualmente il cargo. */
  function mercantileWear(merc) { return Math.max(0, Math.min(WEAR_MAX, merc.wear || 0)); }
  /* M13 Fase B (decisione #57): tech trasferimento = +X% cargo e +N raggio
     (modificatori passivi). Letti dal game globale (le rotte operano sempre
     sulla partita corrente); guardati per i test headless. */
  function tradeMods() {
    const RM = root.ORION.research;
    return (RM && RM.mods && root.ORION.game) ? RM.mods(root.ORION.game) : null;
  }

  function mercantileCargo(merc) {
    const t = getTier(merc.tier);
    if (!t) return 0;
    const wearMul = 1 - WEAR_CARGO_PENALTY * (mercantileWear(merc) / WEAR_MAX);
    const m = tradeMods();
    const techMul = m ? m.cargoMul : 1;
    return Math.round(t.cargo * rankForXp(merc.xp).cargoMul * wearMul * techMul * 10) / 10;
  }

  /* Raggio massimo (hop) di un mercantile = hop del tier + bonus rango + tech. */
  function mercantileMaxHops(merc) {
    const t = getTier(merc.tier);
    if (!t) return 0;
    const m = tradeMods();
    return t.hops + rankForXp(merc.xp).hopBonus + (m ? m.hopBonus : 0);
  }

  /* ------------------------------------------------------------------
     Capacità di mercato del giocatore (§15.2): N rotte massime + throughput
     totale/Ι, sommati sui Mercati di tutte le colonie operative.
     ------------------------------------------------------------------ */
  function marketCapacity(game) {
    let routes = 0, throughput = 0;
    const cols = (game && game.colonies) || {};
    const def = marketDef();
    Object.keys(cols).forEach(function (k) {
      const c = cols[k];
      if (!c || !c.colonized) return;
      const lvl = marketLevelOf(c);
      if (lvl <= 0) return;
      const idx = Math.min(lvl, MARKET_ROUTES.length) - 1;
      const rArr = (def && Array.isArray(def.tradeRoutes)) ? def.tradeRoutes : MARKET_ROUTES;
      const tArr = (def && Array.isArray(def.tradeThroughput)) ? def.tradeThroughput : MARKET_THROUGHPUT;
      routes += rArr[Math.min(idx, rArr.length - 1)] || 0;
      throughput += tArr[Math.min(idx, tArr.length - 1)] || 0;
    });
    /* M16 Fase B (#81): le STAZIONI operative fanno da hub commerciale —
       throughput di larga scala oltre i Mercati planetari. Ogni stazione
       tua +1 rotta e +STATION_HUB_THROUGHPUT × livello unità/Ι. */
    const ST = root.ORION.station;
    if (ST && Array.isArray(game.stations)) {
      for (let i = 0; i < game.stations.length; i++) {
        const st = game.stations[i];
        if (!st || st.phase === 'building' || st.level < 1) continue;
        if (!ST.isPlayerStation(st) || st.supplyState === 'isolated') continue;
        routes += STATION_HUB_ROUTES;
        throughput += STATION_HUB_THROUGHPUT * st.level;
      }
    }
    return { routes: routes, throughput: throughput };
  }

  function marketDef() {
    const S = root.ORION.structures;
    if (S && S.get) return S.get('mercato');
    return null;
  }

  /* Rotte attive del giocatore. */
  function activeRoutes(game) {
    return Array.isArray(game && game.tradeRoutes) ? game.tradeRoutes : [];
  }
  function routesUsed(game) {
    return activeRoutes(game).length;
  }

  /* ------------------------------------------------------------------
     ID generators in-process (deterministici per sequenza di comandi).
     ------------------------------------------------------------------ */
  let _mercCounter = 0;
  let _routeCounter = 0;
  function nextMercId(game) {
    _mercCounter++;
    return 'mrc-' + ((game && game.timeImpulsi) || 0) + '-' + _mercCounter;
  }
  function nextRouteId(game) {
    _routeCounter++;
    return 'rt-' + ((game && game.timeImpulsi) || 0) + '-' + _routeCounter;
  }

  /* ------------------------------------------------------------------
     COSTRUZIONE MERCANTILI — accodata nella coda dedicata dell'Hangar.
     Riusa i cantieri/attracchi dell'Hangar (decisione #41) tramite il
     check `canBuildShip` di expedition.js: i mercantili occupano un
     cantiere e un attracco come gli scafi.
     ------------------------------------------------------------------ */
  function canBuildMercantile(game, colony, colonyKey, tier) {
    ensureColonyTrade(colony);
    const t = getTier(tier);
    if (!t) return { ok: false, reason: 'Livello mercantile sconosciuto' };
    if (hangarLevelOf(colony) < t.hangarLvl) {
      return { ok: false, reason: 'Hangar di costruzione lvl ' + t.hangarLvl + ' richiesto per ' + t.name };
    }
    if (!requiresSatisfied(t, colony, game)) {
      return { ok: false, reason: t.name + ' richiede l\'iperguida (M13)' };
    }
    /* Build paralleli limitati ai cantieri dell'Hangar (decisione #41).
       I mercantili NON sono nel counter scafi (colony.ships) né occupano
       attracchi: condividono però i cantieri di costruzione con gli scafi.
       Conta la coda scafi + coda mercantili rispetto agli slot cantiere. */
    const E = root.ORION.expedition;
    const slots = (E && E.hangarBuildSlots) ? E.hangarBuildSlots(colony) : 1;
    const shipQ = (colony.assets && colony.assets.shipQueue) ? colony.assets.shipQueue.length : 0;
    const mercQ = colony.assets.mercantileQueue.length;
    if (shipQ + mercQ >= slots) {
      return { ok: false, reason: 'Cantieri occupati (' + (shipQ + mercQ) + '/' + slots + ') — espandi l\'Hangar' };
    }
    /* Pagamento. */
    const ks = Object.keys(t.cost);
    for (let i = 0; i < ks.length; i++) {
      if ((colony.stock[ks[i]] || 0) < t.cost[ks[i]]) {
        return { ok: false, reason: 'Risorse insufficienti' };
      }
    }
    return { ok: true };
  }

  function startMercantileBuild(colony, planet, game, colonyKey, tier) {
    const chk = canBuildMercantile(game, colony, colonyKey, tier);
    if (!chk.ok) return chk;
    const t = getTier(tier);
    /* Scala il tempo coi bonus tecnici dell'Hangar (decisione #41). */
    const E = root.ORION.expedition;
    let time = t.time;
    if (E && E.applyTechSpeed) time = E.applyTechSpeed(t.time, colony);
    /* Paga. */
    Object.keys(t.cost).forEach(function (k) {
      colony.stock[k] = (colony.stock[k] || 0) - t.cost[k];
    });
    ensureColonyTrade(colony);
    colony.assets.mercantileQueue.push({ tier: tier, duration: time, totalTime: time });
    return { ok: true };
  }

  function cancelMercantileBuild(colony, idx) {
    ensureColonyTrade(colony);
    const q = colony.assets.mercantileQueue;
    if (idx < 0 || idx >= q.length) return { ok: false, reason: 'Voce di coda inesistente' };
    const entry = q.splice(idx, 1)[0];
    /* Rimborso 50% (recovery-friendly, come scafi/equipaggi M07). */
    const t = getTier(entry.tier);
    if (t) {
      Object.keys(t.cost).forEach(function (k) {
        colony.stock[k] = (colony.stock[k] || 0) + Math.floor(t.cost[k] * 0.5);
      });
    }
    return { ok: true };
  }

  /* Matura la coda di costruzione mercantili di una colonia (chiamata nel
     loop colonie del tick). Emette `mercantile-built`. */
  function processColonyAssets(game, colony, planet, events) {
    ensureColonyTrade(colony);
    const q = colony.assets.mercantileQueue;
    if (!Array.isArray(q) || !q.length) return;
    const still = [];
    for (let i = 0; i < q.length; i++) {
      const e = q[i];
      e.duration = (e.duration || 0) - 1;
      if (e.duration <= 0) {
        const merc = {
          id: nextMercId(game),
          tier: e.tier,
          xp: 0,
          wear: 0,
          status: 'idle',
          routeId: null
        };
        colony.mercantili.push(merc);
        events.push({
          kind: 'mercantile-built',
          colony: colony, planet: planet,
          tier: e.tier,
          impulso: game.timeImpulsi
        });
      } else {
        still.push(e);
      }
    }
    colony.assets.mercantileQueue = still;
  }

  /* Mercantili a riposo di una colonia (assegnabili a una nuova rotta). */
  function idleMercantili(colony) {
    ensureColonyTrade(colony);
    return colony.mercantili.filter(function (m) { return m.status !== 'on-route'; });
  }
  function findMercantile(colony, mercId) {
    ensureColonyTrade(colony);
    for (let i = 0; i < colony.mercantili.length; i++) {
      if (colony.mercantili[i].id === mercId) return colony.mercantili[i];
    }
    return null;
  }

  /* ------------------------------------------------------------------
     ROTTE INTERNE (§15.2). Una rotta lega una colonia SORGENTE a una
     DESTINAZIONE, trasporta UNA risorsa base a un `rate` (unità/Ι) scelto
     dall'utente, servita da UN mercantile della sorgente.
     ------------------------------------------------------------------ */
  function routeHopCount(game, srcKey, dstKey) {
    const F = root.ORION.fleet;
    const cols = game.colonies || {};
    const src = cols[srcKey], dst = cols[dstKey];
    if (!src || !dst) return -1;
    if (!F || !F.computePath) return -1;
    const path = F.computePath(game.galaxy, src.systemId, dst.systemId);
    if (!path) return -1;
    return path.length - 1;   // numero di salti
  }

  function canCreateRoute(game, srcKey, dstKey, resource, mercId) {
    const cols = game.colonies || {};
    const src = cols[srcKey], dst = cols[dstKey];
    if (!src || !src.colonized) return { ok: false, reason: 'Sorgente non operativa' };
    if (!dst || !dst.colonized) return { ok: false, reason: 'Destinazione non operativa' };
    if (srcKey === dstKey) return { ok: false, reason: 'Sorgente e destinazione coincidono' };
    if (TRADE_RESOURCES.indexOf(resource) < 0) return { ok: false, reason: 'Risorsa non trasportabile' };
    /* Cap rotte dal Mercato. */
    const cap = marketCapacity(game);
    if (cap.routes <= 0) return { ok: false, reason: 'Nessun Mercato costruito (serve §10 Mercato)' };
    if (routesUsed(game) >= cap.routes) {
      return { ok: false, reason: 'Limite rotte raggiunto (' + routesUsed(game) + '/' + cap.routes + ') — espandi un Mercato' };
    }
    /* Mercantile assegnato: idle, della colonia sorgente, raggio sufficiente. */
    const merc = findMercantile(src, mercId);
    if (!merc) return { ok: false, reason: 'Mercantile inesistente sulla sorgente' };
    if (merc.status === 'on-route') return { ok: false, reason: 'Mercantile già su un\'altra rotta' };
    const hops = routeHopCount(game, srcKey, dstKey);
    if (hops < 0) return { ok: false, reason: 'Nessuna rotta iperspaziale tra le colonie' };
    const maxHops = mercantileMaxHops(merc);
    if (hops > maxHops) {
      return { ok: false, reason: 'Troppo lontano: ' + hops + ' salti, il mercantile ne copre ' + maxHops + ' (serve un livello superiore)' };
    }
    return { ok: true, merc: merc, hops: hops };
  }

  function createRoute(game, srcKey, dstKey, resource, rate, mercId) {
    const chk = canCreateRoute(game, srcKey, dstKey, resource, mercId);
    if (!chk.ok) return chk;
    const merc = chk.merc;
    const maxRate = mercantileCargo(merc);
    rate = Math.max(1, Math.min(Math.round((rate || maxRate) * 10) / 10, maxRate));
    if (!Array.isArray(game.tradeRoutes)) game.tradeRoutes = [];
    const route = {
      id: nextRouteId(game),
      src: srcKey, dst: dstKey,
      resource: resource,
      rate: rate,
      mercId: mercId,
      hops: chk.hops,
      status: 'active',           // active | interrupted-source | interrupted-route
      tripProgress: 0,            // accumulatore xp (Ι di servizio)
      delivered: 0                // totale consegnato (telemetria)
    };
    merc.status = 'on-route';
    merc.routeId = route.id;
    game.tradeRoutes.push(route);
    return { ok: true, route: route };
  }

  function findRoute(game, routeId) {
    const arr = activeRoutes(game);
    for (let i = 0; i < arr.length; i++) if (arr[i].id === routeId) return arr[i];
    return null;
  }

  /* Libera il mercantile legato a una rotta (lo riporta idle sulla sorgente). */
  function releaseRouteMercantile(game, route) {
    const src = game.colonies && game.colonies[route.src];
    if (!src) return;
    const merc = findMercantile(src, route.mercId);
    if (merc) { merc.status = 'idle'; merc.routeId = null; }
  }

  function cancelRoute(game, routeId) {
    const arr = activeRoutes(game);
    const idx = arr.indexOf(findRoute(game, routeId));
    if (idx < 0) return { ok: false, reason: 'Rotta inesistente' };
    releaseRouteMercantile(game, arr[idx]);
    arr.splice(idx, 1);
    return { ok: true };
  }

  /* Aggiorna il rate target di una rotta (cap al cargo del mercantile). */
  function setRouteRate(game, routeId, rate) {
    const route = findRoute(game, routeId);
    if (!route) return { ok: false, reason: 'Rotta inesistente' };
    const src = game.colonies && game.colonies[route.src];
    const merc = src && findMercantile(src, route.mercId);
    const maxRate = merc ? mercantileCargo(merc) : route.rate;
    route.rate = Math.max(1, Math.min(Math.round((rate || 1) * 10) / 10, maxRate));
    return { ok: true };
  }

  /* ------------------------------------------------------------------
     processRoutes — 1 Impulso. Sposta le risorse lungo le rotte attive
     entro il budget di throughput del Mercato; matura l'xp dei mercantili;
     gestisce le interruzioni recovery-friendly. Chiamata UNA volta per tick
     dopo il loop delle colonie (lo stock di produzione è già aggiornato).
     ------------------------------------------------------------------ */
  function processRoutes(game, events) {
    const arr = activeRoutes(game);
    if (!arr.length) return;
    const cols = game.colonies || {};
    const cap = marketCapacity(game);
    let budget = cap.throughput;
    const CO = root.ORION.combat;

    /* Ordine deterministico per id-rotta (stabile fra replay). */
    const ordered = arr.slice().sort(function (a, b) {
      return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    });

    for (let i = 0; i < ordered.length; i++) {
      const route = ordered[i];
      const src = cols[route.src];
      const dst = cols[route.dst];

      /* Pulizia: se una colonia non esiste più o ha perso il mercantile,
         la rotta decade (recovery-friendly: nessun crash). */
      if (!src || !src.colonized || !dst || !dst.colonized) {
        dropRoute(game, route, events, 'colony-gone');
        continue;
      }
      const merc = findMercantile(src, route.mercId);
      if (!merc) {
        dropRoute(game, route, events, 'mercantile-gone');
        continue;
      }

      /* Percorso calcolato UNA volta per Impulso (riusato per transito
         ostile + minaccia razzia). I sistemi intermedi sono path[1..n-1]. */
      const path = routePath(game, route);

      /* Interruzione per transito ostile (§15.7, riusa M09). Se un sistema
         lungo il percorso ha presenza ostile (covo o AI in guerra), la rotta
         è sospesa finché la minaccia resta. Recovery-friendly: riparte da sola. */
      if (CO && CO.hostilePresenceAt && path && hasHostileTransit(game, path, CO)) {
        markInterrupt(route, 'interrupted-route', events, game, src, dst);
        continue;
      }

      /* Sorgente esaurita: niente da spostare. */
      const avail = src.stock ? (src.stock[route.resource] || 0) : 0;
      if (avail <= 0) {
        markInterrupt(route, 'interrupted-source', events, game, src, dst);
        continue;
      }

      /* Se prima era interrotta e ora c'è di nuovo flusso possibile,
         segnala la ripresa. */
      if (route.status !== 'active') {
        route.status = 'active';
        events.push({
          kind: 'trade-route-resumed',
          routeId: route.id, src: route.src, dst: route.dst,
          resource: route.resource, impulso: game.timeImpulsi
        });
      }

      /* Flusso effettivo = min(rate target, cargo mercantile, budget, stock). */
      const cargoCap = mercantileCargo(merc);
      let flow = Math.min(route.rate, cargoCap, budget, avail);
      if (flow <= 0) continue;
      flow = Math.round(flow * 10) / 10;

      /* §15.7 — Razzia pirata sulla rotta (deterministica). Lungo un percorso
         minacciato il convoglio può essere assalito: cargo perso (la sorgente
         lo ha già spedito), usura al mercantile (mitigata dall'xp). A usura
         100 il mercantile è ritirato e la rotta chiusa (recovery-friendly:
         se ne costruisce un altro). Le rotte sicure (minaccia 0) non hanno
         mai razzie. */
      const threat = path ? routeThreat(game, path) : 0;
      let raided = false;
      if (threat > 0) {
        const rng = ORION.rng.makeRng(game.seed + ':traderaid:' + route.id + ':' + game.timeImpulsi);
        const pirateMul = rankForXp(merc.xp).pirateMul;   // veterani meno esposti
        const pRaid = Math.min(0.5, RAID_BASE * threat * pirateMul);
        if (rng.chance(pRaid)) {
          raided = true;
          const wear = RAID_WEAR_MIN + Math.round(rng.range(0, RAID_WEAR_MAX - RAID_WEAR_MIN));
          merc.wear = mercantileWear(merc) + wear;
          /* Cargo perso: la sorgente paga, la destinazione non riceve. */
          src.stock[route.resource] = (src.stock[route.resource] || 0) - flow;
          events.push({
            kind: 'trade-raid',
            routeId: route.id, src: route.src, dst: route.dst,
            resource: route.resource, lost: flow, wear: wear,
            sysId: raidSystem(game, path),
            impulso: game.timeImpulsi
          });
          if (merc.wear >= WEAR_MAX) {
            /* Mercantile ritirato: chiudi la rotta (libera lo slot) e
               rimuovi l'entità dalla colonia. */
            events.push({
              kind: 'trade-mercantile-lost',
              routeId: route.id, src: route.src, mercId: merc.id,
              impulso: game.timeImpulsi
            });
            const mi = src.mercantili.indexOf(merc);
            if (mi >= 0) src.mercantili.splice(mi, 1);
            const ri = activeRoutes(game).indexOf(route);
            if (ri >= 0) activeRoutes(game).splice(ri, 1);
            continue;
          }
        }
      }

      if (!raided) {
        src.stock[route.resource] = (src.stock[route.resource] || 0) - flow;
        if (!dst.stock) dst.stock = { met: 0, en: 0, food: 0, water: 0 };
        dst.stock[route.resource] = (dst.stock[route.resource] || 0) + flow;
        budget -= flow;
        route.delivered = (route.delivered || 0) + flow;
      } else {
        /* La razzia consuma comunque la quota di throughput (il convoglio è
           partito). */
        budget -= flow;
      }

      /* Maturazione xp del mercantile: 1 xp ogni TRIP_PER_HOP × hops Ι di
         servizio effettivo. Anche sopravvivendo a una razzia (§15.7). */
      route.tripProgress = (route.tripProgress || 0) + 1;
      const tripLen = TRIP_PER_HOP * Math.max(1, route.hops || 1);
      if (route.tripProgress >= tripLen) {
        route.tripProgress = 0;
        const before = rankForXp(merc.xp).id;
        merc.xp = (merc.xp || 0) + 1;
        const after = rankForXp(merc.xp).id;
        if (after !== before) {
          events.push({
            kind: 'mercantile-promoted',
            mercId: merc.id, rank: after, srcKey: route.src,
            impulso: game.timeImpulsi
          });
        }
      }
      if (budget <= 0) break;
    }
  }

  /* Percorso BFS di una rotta (src → dst). null se non risolvibile. */
  function routePath(game, route) {
    const F = root.ORION.fleet;
    const cols = game.colonies || {};
    const src = cols[route.src], dst = cols[route.dst];
    if (!src || !dst || !F || !F.computePath) return null;
    return F.computePath(game.galaxy, src.systemId, dst.systemId);
  }

  /* Presenza ostile su un sistema intermedio (esclusi gli estremi). */
  function hasHostileTransit(game, path, CO) {
    for (let i = 1; i < path.length - 1; i++) {
      if (CO.hostilePresenceAt(game, path[i])) return true;
    }
    return false;
  }

  /* Minaccia razzia sul percorso (§15.7): max pirateThreat sui sistemi
     intermedi + bump per transito in un sistema coeso non-alleato (§13.6). */
  function routeThreat(game, path) {
    const AI = root.ORION.ai;
    const COH = root.ORION.cohesion;
    let threat = 0;
    for (let i = 1; i < path.length - 1; i++) {
      const sys = path[i];
      if (AI && AI.pirateThreat) threat = Math.max(threat, AI.pirateThreat(game, sys));
      if (COH && COH.isCohesive && COH.isCohesive(game, sys)) threat += COHESION_THREAT;
    }
    return Math.max(0, Math.min(1, threat));
  }

  /* Sistema intermedio più minaccioso (per la cronaca della razzia). */
  function raidSystem(game, path) {
    const AI = root.ORION.ai;
    let best = path.length > 2 ? path[1] : path[0];
    let bestT = -1;
    for (let i = 1; i < path.length - 1; i++) {
      const t = (AI && AI.pirateThreat) ? AI.pirateThreat(game, path[i]) : 0;
      if (t > bestT) { bestT = t; best = path[i]; }
    }
    return best;
  }

  function markInterrupt(route, status, events, game, src, dst) {
    if (route.status === status) return;        // già nello stesso stato → no spam
    route.status = status;
    events.push({
      kind: 'trade-route-interrupted',
      routeId: route.id, src: route.src, dst: route.dst,
      resource: route.resource, reason: status,
      impulso: game.timeImpulsi
    });
  }

  function dropRoute(game, route, events, reason) {
    releaseRouteMercantile(game, route);
    const arr = activeRoutes(game);
    const idx = arr.indexOf(route);
    if (idx >= 0) arr.splice(idx, 1);
    events.push({
      kind: 'trade-route-closed',
      routeId: route.id, src: route.src, dst: route.dst,
      reason: reason, impulso: game.timeImpulsi
    });
  }

  /* Durata minima della coda mercantili di una colonia (per nextEventImpulsi). */
  function minQueueDuration(game) {
    let min = Infinity;
    const cols = (game && game.colonies) || {};
    Object.keys(cols).forEach(function (k) {
      const c = cols[k];
      if (!c || !c.assets || !Array.isArray(c.assets.mercantileQueue)) return;
      c.assets.mercantileQueue.forEach(function (q) {
        if ((q.duration || 0) > 0 && q.duration < min) min = q.duration;
      });
    });
    return isFinite(min) ? min : Infinity;
  }

  /* ------------------------------------------------------------------
     Helper UI/test.
     ------------------------------------------------------------------ */
  function routesForColony(game, colonyKey) {
    return activeRoutes(game).filter(function (r) {
      return r.src === colonyKey || r.dst === colonyKey;
    });
  }
  function rankLabel(xp) { return rankForXp(xp).label; }

  ORION.trade = {
    TRADE_RESOURCES: TRADE_RESOURCES,
    MERCANTILE_TIERS: MERCANTILE_TIERS,
    MERC_RANKS: MERC_RANKS,
    MARKET_ROUTES: MARKET_ROUTES,
    MARKET_THROUGHPUT: MARKET_THROUGHPUT,
    ensureColonyTrade: ensureColonyTrade,
    getTier: getTier,
    rankForXp: rankForXp,
    rankLabel: rankLabel,
    hangarLevelOf: hangarLevelOf,
    marketLevelOf: marketLevelOf,
    buildableTier: buildableTier,
    mercantileCargo: mercantileCargo,
    mercantileMaxHops: mercantileMaxHops,
    mercantileWear: mercantileWear,
    routePath: routePath,
    routeThreat: routeThreat,
    WEAR_MAX: WEAR_MAX,
    marketCapacity: marketCapacity,
    routesUsed: routesUsed,
    activeRoutes: activeRoutes,
    routesForColony: routesForColony,
    idleMercantili: idleMercantili,
    findMercantile: findMercantile,
    canBuildMercantile: canBuildMercantile,
    startMercantileBuild: startMercantileBuild,
    cancelMercantileBuild: cancelMercantileBuild,
    processColonyAssets: processColonyAssets,
    routeHopCount: routeHopCount,
    canCreateRoute: canCreateRoute,
    createRoute: createRoute,
    findRoute: findRoute,
    cancelRoute: cancelRoute,
    setRouteRate: setRouteRate,
    processRoutes: processRoutes,
    minQueueDuration: minQueueDuration
  };
})(typeof window !== 'undefined' ? window : this);
