/* =====================================================================
   ORION EMPIRES — fleet.js
   Modulo M08 (Fase A): Flotta base — modello dati + classi navi + flotte
   mobili con ordini base.

   FASE A (questo file):
     - 5 classi navi (explorer/caccia/intercettore/corvetta/fregata)
     - entità flotta serializzabile con counter+individui (hp/wear/id)
     - ordini idle/move/explore/patrol/return
     - pathfinding BFS multi-hop su galaxy.systems[*].links
     - tick di flotta deterministico (no RNG nel movimento)
     - stub fleetUpkeep — l'upkeep vero arriva con M13 (tech logistica)
   FASE B (task separato): mappa galassia "attiva", tutorial, migrazione
   spedizioni M07 → flotte, polish.

   Misto counter/entità (vincolo task):
     - in colonia il counter `colony.ships.<kind>` resta intercambiabile
       (gli scafi a terra sono fungibili);
     - quando uno scafo entra in flotta diventa un'entità
       `{ id, kind, hp, wear }` con stato proprio.

   Determinismo (decisione #5/#22): zero `Math.random` nel tick. Gli id
   delle entità sono derivati dal timer in-process + counter; replay-safe
   per la stessa sequenza di comandi.

   Lessico SW-flavor (decisione #34): "salto iperspaziale", "rotta
   iperspaziale", "in orbita". I tre tier di iperguida M13 (decisione #32)
   ridurranno il `tempoLeg` qui calcolato.
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  /* Catalogo classi navi (Fase A). Parametri dalla scheda task M08. */
  const CLASSES = {
    explorer: {
      id: 'explorer', name: 'Scafo esploratore', glyph: '✦',
      cost: { met: 25, en: 12 }, time: 10,
      hp: 20, fp: 0, speed: 1.1, crew: 1, hangarLvl: 1
    },
    caccia: {
      id: 'caccia', name: 'Caccia stellare', glyph: '∢',
      cost: { met: 20, en: 8 }, time: 8,
      hp: 30, fp: 5, speed: 1.2, crew: 1, hangarLvl: 1
    },
    intercettore: {
      id: 'intercettore', name: 'Intercettore', glyph: '➤',
      cost: { met: 35, en: 15 }, time: 14,
      hp: 45, fp: 8, speed: 1.4, crew: 2, hangarLvl: 2
    },
    corvetta: {
      id: 'corvetta', name: 'Corvetta', glyph: '◅',
      cost: { met: 60, en: 25, food: 5 }, time: 22,
      hp: 80, fp: 12, speed: 1.0, crew: 4, hangarLvl: 2
    },
    fregata: {
      id: 'fregata', name: 'Fregata', glyph: '◣',
      cost: { met: 120, en: 50, food: 10 }, time: 40,
      hp: 160, fp: 25, speed: 0.85, crew: 8, hangarLvl: 3
    }
  };
  const CLASS_ORDER = ['explorer', 'caccia', 'intercettore', 'corvetta', 'fregata'];

  /* Costanti del viaggio inter-sistema. Coerenti con expedition.js M07
     (decisione #32): un hop sub-luce dura 40-80 Ι (+ scaling danger). M13
     introdurrà i 3 tier di iperguida (×3, ×8, ×20). */
  const TRAVEL_BASE = 50;
  const TRAVEL_DANGER_FACTOR = 30;
  const TRAVEL_MIN = 40;
  const TRAVEL_MAX = 80;

  function getClass(kind) {
    return CLASSES[kind] || null;
  }

  function dangerOf(galaxy, sysId) {
    const s = galaxy && galaxy.systems && galaxy.systems[sysId];
    if (!s) return 0.5;
    return Math.max(0, Math.min(1, (s.danger || 0) / 100));
  }

  /* tempoLeg — durata di un singolo hop fra due sistemi adiacenti.
     Formula richiesta dal task: clamp(50 + danger·30, 40, 80) × (1/minSpeed).
     `minSpeed` = minima velocità delle navi in flotta (la flotta viaggia
     alla velocità della nave più lenta). */
  function tempoLeg(galaxy, fromSysId, toSysId, minSpeed) {
    const d = dangerOf(galaxy, toSysId);
    let base = TRAVEL_BASE + d * TRAVEL_DANGER_FACTOR;
    if (base < TRAVEL_MIN) base = TRAVEL_MIN;
    if (base > TRAVEL_MAX) base = TRAVEL_MAX;
    const sp = minSpeed && minSpeed > 0 ? minSpeed : 1;
    return Math.max(1, Math.round(base / sp));
  }

  /* Velocità minima delle navi in flotta (la più lenta detta il passo). */
  function fleetMinSpeed(fleet) {
    if (!fleet || !Array.isArray(fleet.ships) || !fleet.ships.length) return 1;
    let m = Infinity;
    for (let i = 0; i < fleet.ships.length; i++) {
      const cls = CLASSES[fleet.ships[i].kind];
      const sp = cls ? cls.speed : 1;
      if (sp < m) m = sp;
    }
    return isFinite(m) ? m : 1;
  }

  /* Capacità di crew totale richiesta da una flotta (Σ class.crew × ships). */
  function fleetCrewRequired(fleet) {
    if (!fleet || !Array.isArray(fleet.ships)) return 0;
    let n = 0;
    for (let i = 0; i < fleet.ships.length; i++) {
      const cls = CLASSES[fleet.ships[i].kind];
      n += cls ? cls.crew : 1;
    }
    return n;
  }

  /* ------------------------------------------------------------------
     Pathfinding — BFS sul grafo `galaxy.systems[*].links`. Restituisce
     l'array dei sistemi attraversati (incluso il sorgente e il target),
     oppure null se non c'è cammino.
     ------------------------------------------------------------------ */
  function computePath(galaxy, fromSysId, toSysId) {
    if (!galaxy || !galaxy.systems) return null;
    if (fromSysId === toSysId) return [fromSysId];
    const src = galaxy.systems[fromSysId];
    const dst = galaxy.systems[toSysId];
    if (!src || !dst) return null;
    const n = galaxy.systems.length;
    const visited = new Array(n).fill(false);
    const prev = new Array(n).fill(-1);
    visited[fromSysId] = true;
    const queue = [fromSysId];
    let head = 0;
    while (head < queue.length) {
      const u = queue[head++];
      if (u === toSysId) break;
      const links = galaxy.systems[u].links || [];
      for (let i = 0; i < links.length; i++) {
        const v = links[i];
        if (!visited[v]) {
          visited[v] = true;
          prev[v] = u;
          queue.push(v);
        }
      }
    }
    if (!visited[toSysId]) return null;
    const path = [];
    let cur = toSysId;
    while (cur !== -1) { path.unshift(cur); cur = prev[cur]; }
    return path;
  }

  /* ------------------------------------------------------------------
     ID generators in-process (deterministici per sequenza, salvati nel
     game.fleets[] dopo la creazione).
     ------------------------------------------------------------------ */
  let _fleetCounter = 0;
  let _shipCounter = 0;
  let _crewCounter = 0;

  function nextFleetId(game) {
    _fleetCounter++;
    return 'flt-' + (game.timeImpulsi || 0) + '-' + _fleetCounter;
  }
  function nextShipId(game) {
    _shipCounter++;
    return 'shp-' + (game.timeImpulsi || 0) + '-' + _shipCounter;
  }
  function nextCrewId(game) {
    _crewCounter++;
    return 'crw-' + (game.timeImpulsi || 0) + '-' + _crewCounter;
  }

  /* Conta il numero di flotte già esistenti per dare un nome di default
     stile "Squadrone 1". */
  function defaultFleetName(game) {
    const n = Array.isArray(game.fleets) ? game.fleets.length : 0;
    return 'Squadrone ' + (n + 1);
  }

  /* ------------------------------------------------------------------
     createFleet — crea una flotta vuota ancorata alla colonia origine.
     La flotta nasce `idle` e `docked` nel sistema della colonia.
     ------------------------------------------------------------------ */
  function createFleet(game, ownerColonyKey, name) {
    if (!game) return { ok: false, reason: 'Partita non inizializzata' };
    const colony = game.colonies && game.colonies[ownerColonyKey];
    if (!colony) return { ok: false, reason: 'Colonia inesistente' };
    if (!colony.colonized) return { ok: false, reason: 'Colonia non operativa' };
    if (!Array.isArray(game.fleets)) game.fleets = [];
    const fleet = {
      id: nextFleetId(game),
      name: (name && String(name).trim()) || defaultFleetName(game),
      ownerColonyKey: ownerColonyKey,
      location: { systemId: colony.systemId, status: 'docked' },
      ships: [],
      crew: [],
      orders: { type: 'idle' },
      route: [],
      routeIdx: 0,
      etaImpulsi: 0
    };
    game.fleets.push(fleet);
    return { ok: true, fleet: fleet };
  }

  /* ensureColonyShipKinds — il counter colonia ha sempre tutte le 5
     classi note (default 0). Lazy, idempotente. */
  function ensureColonyShipKinds(colony) {
    if (!colony.ships) colony.ships = {};
    for (let i = 0; i < CLASS_ORDER.length; i++) {
      const k = CLASS_ORDER[i];
      if (colony.ships[k] == null) colony.ships[k] = 0;
    }
  }

  /* assignShips — sposta `count` navi di una classe dal counter colonia
     all'array della flotta come entità individuali. La colonia deve
     essere nel sistema della flotta e la flotta `docked`. */
  function assignShips(game, fleet, colonyKey, kind, count) {
    if (!fleet) return { ok: false, reason: 'Flotta inesistente' };
    const cls = CLASSES[kind];
    if (!cls) return { ok: false, reason: 'Classe nave sconosciuta' };
    count = Math.max(0, count | 0);
    if (count <= 0) return { ok: false, reason: 'Quantità non valida' };
    const colony = game.colonies && game.colonies[colonyKey];
    if (!colony) return { ok: false, reason: 'Colonia inesistente' };
    if (fleet.location.status !== 'docked') {
      return { ok: false, reason: 'La flotta deve essere all\'attracco' };
    }
    if (fleet.location.systemId !== colony.systemId) {
      return { ok: false, reason: 'Flotta non in orbita della colonia' };
    }
    ensureColonyShipKinds(colony);
    if ((colony.ships[kind] || 0) < count) {
      return { ok: false, reason: 'Navi disponibili insufficienti' };
    }
    colony.ships[kind] -= count;
    for (let i = 0; i < count; i++) {
      fleet.ships.push({
        id: nextShipId(game),
        kind: kind,
        hp: cls.hp,
        wear: 0
      });
    }
    return { ok: true };
  }

  /* unassignShips — riporta `count` navi della classe dalla flotta al
     counter colonia. La flotta deve essere `docked` nel sistema della
     colonia. Le entità rimosse perdono la propria identità (intercambiabili
     a terra) — coerente col misto counter/entità. */
  function unassignShips(game, fleet, colonyKey, kind, count) {
    if (!fleet) return { ok: false, reason: 'Flotta inesistente' };
    if (!CLASSES[kind]) return { ok: false, reason: 'Classe nave sconosciuta' };
    count = Math.max(0, count | 0);
    if (count <= 0) return { ok: false, reason: 'Quantità non valida' };
    const colony = game.colonies && game.colonies[colonyKey];
    if (!colony) return { ok: false, reason: 'Colonia inesistente' };
    if (fleet.location.status !== 'docked' || fleet.location.systemId !== colony.systemId) {
      return { ok: false, reason: 'La flotta deve essere all\'attracco della colonia' };
    }
    let removed = 0;
    for (let i = fleet.ships.length - 1; i >= 0 && removed < count; i--) {
      if (fleet.ships[i].kind === kind) {
        fleet.ships.splice(i, 1);
        removed++;
      }
    }
    if (removed === 0) return { ok: false, reason: 'Nessuna nave di quella classe in flotta' };
    ensureColonyShipKinds(colony);
    colony.ships[kind] = (colony.ships[kind] || 0) + removed;
    return { ok: true, returned: removed };
  }

  /* assignCrew — sposta `count` equipaggi (presi dall'array colonia) sulla
     flotta. Riusa colony.crews.explorer (la classe SCAFI è separata dalla
     classe EQUIPAGGI in M07: per ora c'è una sola classe d'equipaggio,
     M14 introdurrà figure speciali). Persistono xp. */
  function assignCrew(game, fleet, colonyKey, count) {
    if (!fleet) return { ok: false, reason: 'Flotta inesistente' };
    count = Math.max(0, count | 0);
    if (count <= 0) return { ok: false, reason: 'Quantità non valida' };
    const colony = game.colonies && game.colonies[colonyKey];
    if (!colony) return { ok: false, reason: 'Colonia inesistente' };
    if (fleet.location.status !== 'docked' || fleet.location.systemId !== colony.systemId) {
      return { ok: false, reason: 'La flotta deve essere all\'attracco della colonia' };
    }
    if (!colony.crews) colony.crews = { explorer: [] };
    if (!Array.isArray(colony.crews.explorer)) colony.crews.explorer = [];
    if (colony.crews.explorer.length < count) {
      return { ok: false, reason: 'Equipaggi disponibili insufficienti' };
    }
    for (let i = 0; i < count; i++) {
      fleet.crew.push(colony.crews.explorer.shift());
    }
    return { ok: true };
  }

  function unassignCrew(game, fleet, colonyKey, count) {
    if (!fleet) return { ok: false, reason: 'Flotta inesistente' };
    count = Math.max(0, count | 0);
    if (count <= 0) return { ok: false, reason: 'Quantità non valida' };
    const colony = game.colonies && game.colonies[colonyKey];
    if (!colony) return { ok: false, reason: 'Colonia inesistente' };
    if (fleet.location.status !== 'docked' || fleet.location.systemId !== colony.systemId) {
      return { ok: false, reason: 'La flotta deve essere all\'attracco della colonia' };
    }
    if (!colony.crews) colony.crews = { explorer: [] };
    if (!Array.isArray(colony.crews.explorer)) colony.crews.explorer = [];
    let removed = 0;
    while (removed < count && fleet.crew.length > 0) {
      colony.crews.explorer.push(fleet.crew.shift());
      removed++;
    }
    if (removed === 0) return { ok: false, reason: 'Flotta senza equipaggio' };
    return { ok: true, returned: removed };
  }

  /* dissolveFleet — riporta navi+equipaggi alla colonia origine (se la
     flotta è già nel sistema della colonia), poi rimuove la flotta da
     game.fleets. Recovery-friendly (decisione #22): se la flotta non è
     in orbita della colonia, restituisce ok:false con motivo umano —
     l'utente deve prima darle ordine `return`. */
  function dissolveFleet(game, fleet) {
    if (!fleet) return { ok: false, reason: 'Flotta inesistente' };
    const colony = game.colonies && game.colonies[fleet.ownerColonyKey];
    if (!colony) return { ok: false, reason: 'Colonia origine non più esistente' };
    if (fleet.location.systemId !== colony.systemId || fleet.location.status === 'in-transit') {
      return { ok: false, reason: 'La flotta deve essere all\'attracco della colonia. Imposta "Rientra" e attendi.' };
    }
    /* Restituisci navi al counter colonia per classe. */
    ensureColonyShipKinds(colony);
    for (let i = 0; i < fleet.ships.length; i++) {
      const s = fleet.ships[i];
      colony.ships[s.kind] = (colony.ships[s.kind] || 0) + 1;
    }
    /* Restituisci equipaggi. */
    if (!colony.crews) colony.crews = { explorer: [] };
    if (!Array.isArray(colony.crews.explorer)) colony.crews.explorer = [];
    for (let i = 0; i < fleet.crew.length; i++) {
      colony.crews.explorer.push(fleet.crew[i]);
    }
    /* Rimuovi la flotta dal gioco. */
    const idx = (game.fleets || []).indexOf(fleet);
    if (idx >= 0) game.fleets.splice(idx, 1);
    return { ok: true };
  }

  /* ------------------------------------------------------------------
     setOrder — assegna ordini a una flotta. Valida lo stato e (per gli
     ordini di movimento) calcola la rotta BFS. NON consuma Impulsi: la
     marcia avanza nel tick.
     ------------------------------------------------------------------ */
  function setOrder(game, fleet, order) {
    if (!fleet) return { ok: false, reason: 'Flotta inesistente' };
    if (!order || !order.type) return { ok: false, reason: 'Ordine non valido' };
    if (fleet.ships.length === 0) return { ok: false, reason: 'Flotta vuota' };

    const type = order.type;
    if (type === 'idle') {
      fleet.orders = { type: 'idle' };
      fleet.route = [];
      fleet.routeIdx = 0;
      fleet.etaImpulsi = 0;
      return { ok: true };
    }

    /* Per gli ordini di movimento la flotta deve avere abbastanza
       equipaggio (≥ somma class.crew). Recovery-friendly: si pone come
       requisito d'ordine, non come check distruttivo. */
    const crewReq = fleetCrewRequired(fleet);
    if (fleet.crew.length < crewReq) {
      return { ok: false, reason: 'Equipaggio insufficiente: ' + fleet.crew.length + ' / ' + crewReq + ' richiesti' };
    }

    if (type === 'move' || type === 'explore') {
      const to = order.toSysId;
      if (to == null) return { ok: false, reason: 'Sistema di destinazione assente' };
      const path = computePath(game.galaxy, fleet.location.systemId, to);
      if (!path) return { ok: false, reason: 'Nessuna rotta verso il sistema target' };
      fleet.orders = { type: type, toSysId: to };
      fleet.route = path;
      fleet.routeIdx = 0;
      fleet.etaImpulsi = startNextLeg(game.galaxy, fleet);
      return { ok: true };
    }

    if (type === 'patrol') {
      const a = order.sysA, b = order.sysB;
      if (a == null || b == null) return { ok: false, reason: 'Sistemi A/B mancanti' };
      const pa = computePath(game.galaxy, fleet.location.systemId, a);
      if (!pa) return { ok: false, reason: 'Nessuna rotta verso A' };
      const ab = computePath(game.galaxy, a, b);
      if (!ab) return { ok: false, reason: 'Nessuna rotta tra A e B' };
      fleet.orders = { type: 'patrol', sysA: a, sysB: b, leg: 'toA' };
      fleet.route = pa;
      fleet.routeIdx = 0;
      fleet.etaImpulsi = startNextLeg(game.galaxy, fleet);
      return { ok: true };
    }

    /* Fase B (decisione #67): rotta multi-tappa.
       order = {
         type: 'move-route',
         waypoints: [sysId, ...],          // 1+ tappe in sequenza
         dwell?:    [I, ...],              // pause orbitali a ogni tappa (0 default)
         exploreEach?: bool,               // se true, rivela ogni tappa all'arrivo
         returnHome?: bool                 // se true, dopo l'ultima ritorna alla colonia
       }
       La flotta non rientra automaticamente: si ferma sull'ultima tappa
       a meno che returnHome=true. Le pause permettono di "vagare" tra
       i sistemi favorevoli (gancio narrativo M10/M11/M16). */
    if (type === 'move-route') {
      const wp = Array.isArray(order.waypoints) ? order.waypoints.slice() : null;
      if (!wp || wp.length === 0) return { ok: false, reason: 'Nessuna tappa indicata' };
      /* Tutte le tappe devono essere raggiungibili in catena dalla posizione
         corrente — costruiamo la rotta concatenando i BFS leg-per-leg. */
      const validation = buildChainedRoute(game.galaxy, fleet.location.systemId, wp);
      if (!validation.ok) return validation;
      const dwell = Array.isArray(order.dwell) ? order.dwell.slice(0, wp.length) : [];
      while (dwell.length < wp.length) dwell.push(0);
      fleet.orders = {
        type: 'move-route',
        waypoints: wp,
        dwell: dwell,
        exploreEach: !!order.exploreEach,
        returnHome: !!order.returnHome,
        wpIdx: 0,
        dwellLeft: 0
      };
      /* Iniziamo la prima sotto-rotta verso la prima tappa. */
      fleet.route = validation.legs[0];
      fleet.routeIdx = 0;
      fleet.etaImpulsi = startNextLeg(game.galaxy, fleet);
      return { ok: true };
    }

    /* Fase B (decisione #67): pattuglia su N sistemi in loop.
       order = {
         type: 'patrol-loop',
         loop: [sysId, sysId, sysId, ...],   // ≥ 2 sistemi
         dwell?: [I, ...]                    // pause orbitali per nodo
       }
       Sostituisce `patrol{A,B}` quando il giocatore vuole una pattuglia
       circolare più articolata. Il vecchio `patrol` resta per back-compat
       coi save schema 6 in volo. */
    if (type === 'patrol-loop') {
      const loop = Array.isArray(order.loop) ? order.loop.slice() : null;
      if (!loop || loop.length < 2) return { ok: false, reason: 'La pattuglia richiede almeno 2 sistemi' };
      /* Validiamo che ciascuna tappa sia raggiungibile dalla precedente. */
      const v = buildChainedRoute(game.galaxy, fleet.location.systemId, loop);
      if (!v.ok) return v;
      const dwell = Array.isArray(order.dwell) ? order.dwell.slice(0, loop.length) : [];
      while (dwell.length < loop.length) dwell.push(0);
      fleet.orders = {
        type: 'patrol-loop',
        loop: loop,
        dwell: dwell,
        loopIdx: 0,
        dwellLeft: 0
      };
      fleet.route = v.legs[0];
      fleet.routeIdx = 0;
      fleet.etaImpulsi = startNextLeg(game.galaxy, fleet);
      return { ok: true };
    }

    if (type === 'return') {
      const colony = game.colonies && game.colonies[fleet.ownerColonyKey];
      if (!colony) return { ok: false, reason: 'Colonia origine non più esistente' };
      const path = computePath(game.galaxy, fleet.location.systemId, colony.systemId);
      if (!path) return { ok: false, reason: 'Nessuna rotta verso la colonia di origine' };
      fleet.orders = { type: 'return' };
      fleet.route = path;
      fleet.routeIdx = 0;
      fleet.etaImpulsi = startNextLeg(game.galaxy, fleet);
      return { ok: true };
    }

    return { ok: false, reason: 'Tipo ordine sconosciuto' };
  }

  /* buildChainedRoute — verifica che una sequenza di waypoint sia
     raggiungibile da `from` e ritorna i singoli sub-percorsi BFS:
       legs[0] = from  → wp[0]
       legs[1] = wp[0] → wp[1]
       ...
     Ritorna { ok:false, reason } al primo tratto non risolvibile.
     Coerente con seed+delta (decisione #5): le rotte vivono nel grafo
     immutabile della galassia, sono deterministiche per (from, wp[]). */
  function buildChainedRoute(galaxy, from, waypoints) {
    if (!Array.isArray(waypoints) || !waypoints.length) {
      return { ok: false, reason: 'Nessuna tappa indicata' };
    }
    const legs = [];
    let prev = from;
    for (let i = 0; i < waypoints.length; i++) {
      const wp = waypoints[i];
      if (wp == null || !galaxy.systems[wp]) {
        return { ok: false, reason: 'Tappa ' + (i + 1) + ' non valida' };
      }
      if (wp === prev) {
        /* Tappa che coincide con il punto corrente: leg lungo 1 (no movimento). */
        legs.push([prev]);
        continue;
      }
      const path = computePath(galaxy, prev, wp);
      if (!path) {
        return { ok: false, reason: 'Tappa ' + (i + 1) + ' non raggiungibile' };
      }
      legs.push(path);
      prev = wp;
    }
    return { ok: true, legs: legs };
  }

  /* Imposta lo stato di transito per il prossimo leg della rotta corrente.
     Ritorna l'ETA in Impulsi del leg. Se la flotta è già a destinazione
     (route esaurita) ritorna 0 e lascia lo status `orbiting`. */
  function startNextLeg(galaxy, fleet) {
    if (!Array.isArray(fleet.route) || fleet.route.length === 0) {
      fleet.location.status = 'orbiting';
      return 0;
    }
    const from = fleet.location.systemId;
    /* La rotta include il sistema corrente in testa: il "next" è
       l'indice corrente + 1. */
    const nextIdx = fleet.routeIdx + 1;
    if (nextIdx >= fleet.route.length) {
      fleet.location.status = 'orbiting';
      return 0;
    }
    const toSys = fleet.route[nextIdx];
    fleet.location.status = 'in-transit';
    return tempoLeg(galaxy, from, toSys, fleetMinSpeed(fleet));
  }

  /* ------------------------------------------------------------------
     tick — 1 Impulso. Decrementa etaImpulsi se in transito; alla fine
     del leg avanza al prossimo sistema e gestisce arrivo/return/patrol.
     ------------------------------------------------------------------ */
  function tick(game, fleet, events) {
    if (!fleet || !fleet.orders) return;
    if (fleet.orders.type === 'idle') return;

    /* Fase B: per i nuovi ordini con dwell, il countdown di sosta avviene
       qui mentre la flotta è `orbiting`. */
    if (fleet.location.status === 'orbiting' && (fleet.orders.dwellLeft || 0) > 0) {
      fleet.orders.dwellLeft = (fleet.orders.dwellLeft || 0) - 1;
      if (fleet.orders.dwellLeft <= 0) {
        advanceCompoundOrder(game, fleet, events);
      }
      return;
    }

    if (fleet.location.status !== 'in-transit') {
      /* docked o orbiting senza dwell: nulla da avanzare; gli ordini "arrived"
         sono gestiti immediatamente da setOrder o dal completamento del leg. */
      return;
    }
    fleet.etaImpulsi = (fleet.etaImpulsi || 0) - 1;
    if (fleet.etaImpulsi > 0) return;

    /* Fine leg: avanza al prossimo sistema della rotta. */
    fleet.routeIdx++;
    const arrivedAt = fleet.route[fleet.routeIdx];
    fleet.location.systemId = arrivedAt;

    /* Se la rotta non è finita, prepara il prossimo leg. */
    if (fleet.routeIdx + 1 < fleet.route.length) {
      events.push({
        kind: 'fleet-leg-hop',
        fleetId: fleet.id, fleetName: fleet.name,
        systemId: arrivedAt,
        impulso: game.timeImpulsi
      });
      fleet.etaImpulsi = startNextLeg(game.galaxy, fleet);
      return;
    }

    /* Rotta completata. Cosa fare dipende dall'ordine. */
    const order = fleet.orders;
    if (order.type === 'move') {
      fleet.location.status = 'orbiting';
      fleet.etaImpulsi = 0;
      fleet.route = [arrivedAt];
      fleet.routeIdx = 0;
      events.push({
        kind: 'fleet-arrived',
        fleetId: fleet.id, fleetName: fleet.name,
        systemId: arrivedAt,
        impulso: game.timeImpulsi
      });
      fleet.orders = { type: 'idle' };
      return;
    }

    if (order.type === 'explore') {
      /* Rivela il sistema (idempotente, decisione #5 — delta puro). */
      if (ORION.galaxy && ORION.galaxy.revealSystem) {
        const revealed = ORION.galaxy.revealSystem(game.galaxy, arrivedAt, game.state);
        if (revealed) {
          events.push({
            kind: 'fleet-discovery',
            fleetId: fleet.id, fleetName: fleet.name,
            systemId: arrivedAt,
            impulso: game.timeImpulsi
          });
        }
      }
      events.push({
        kind: 'fleet-arrived',
        fleetId: fleet.id, fleetName: fleet.name,
        systemId: arrivedAt,
        impulso: game.timeImpulsi
      });
      /* Auto-return alla colonia origine. */
      const colony = game.colonies && game.colonies[fleet.ownerColonyKey];
      if (colony) {
        const back = computePath(game.galaxy, arrivedAt, colony.systemId);
        if (back) {
          fleet.orders = { type: 'return' };
          fleet.route = back;
          fleet.routeIdx = 0;
          fleet.etaImpulsi = startNextLeg(game.galaxy, fleet);
          return;
        }
      }
      /* Niente colonia o niente rotta: resta in orbita. */
      fleet.location.status = 'orbiting';
      fleet.etaImpulsi = 0;
      fleet.route = [arrivedAt];
      fleet.routeIdx = 0;
      fleet.orders = { type: 'idle' };
      return;
    }

    if (order.type === 'return') {
      const colony = game.colonies && game.colonies[fleet.ownerColonyKey];
      if (colony && colony.systemId === arrivedAt) {
        fleet.location.status = 'docked';
      } else {
        fleet.location.status = 'orbiting';
      }
      fleet.etaImpulsi = 0;
      fleet.route = [arrivedAt];
      fleet.routeIdx = 0;
      events.push({
        kind: 'fleet-route-complete',
        fleetId: fleet.id, fleetName: fleet.name,
        systemId: arrivedAt,
        impulso: game.timeImpulsi
      });
      fleet.orders = { type: 'idle' };
      return;
    }

    if (order.type === 'patrol') {
      events.push({
        kind: 'fleet-route-complete',
        fleetId: fleet.id, fleetName: fleet.name,
        systemId: arrivedAt,
        impulso: game.timeImpulsi
      });
      /* Inverti la gamba: toA → toB → toA → … */
      const nextTarget = (order.leg === 'toA') ? order.sysB : order.sysA;
      const nextLegLabel = (order.leg === 'toA') ? 'toB' : 'toA';
      const path = computePath(game.galaxy, arrivedAt, nextTarget);
      if (path && path.length > 1) {
        fleet.orders = { type: 'patrol', sysA: order.sysA, sysB: order.sysB, leg: nextLegLabel };
        fleet.route = path;
        fleet.routeIdx = 0;
        fleet.etaImpulsi = startNextLeg(game.galaxy, fleet);
      } else {
        /* Niente rotta: degrada a orbiting idle. */
        fleet.location.status = 'orbiting';
        fleet.etaImpulsi = 0;
        fleet.route = [arrivedAt];
        fleet.routeIdx = 0;
        fleet.orders = { type: 'idle' };
      }
      return;
    }

    /* Fase B (decisione #67): rotta multi-tappa. La sotto-rotta verso la
       tappa corrente (wpIdx) è appena terminata. */
    if (order.type === 'move-route') {
      const wpReached = order.waypoints[order.wpIdx];
      events.push({
        kind: 'fleet-waypoint-reached',
        fleetId: fleet.id, fleetName: fleet.name,
        systemId: wpReached,
        wpIdx: order.wpIdx, wpTotal: order.waypoints.length,
        impulso: game.timeImpulsi
      });
      if (order.exploreEach && ORION.galaxy && ORION.galaxy.revealSystem) {
        const revealed = ORION.galaxy.revealSystem(game.galaxy, wpReached, game.state);
        if (revealed) {
          events.push({
            kind: 'fleet-discovery',
            fleetId: fleet.id, fleetName: fleet.name,
            systemId: wpReached,
            impulso: game.timeImpulsi
          });
        }
      }
      /* Imposta orbita + dwell della tappa raggiunta. */
      fleet.location.status = 'orbiting';
      fleet.etaImpulsi = 0;
      fleet.route = [arrivedAt];
      fleet.routeIdx = 0;
      const dwell = (order.dwell && order.dwell[order.wpIdx]) || 0;
      order.dwellLeft = dwell;
      /* Se non c'è dwell, avanza subito al prossimo waypoint. */
      if (dwell <= 0) advanceCompoundOrder(game, fleet, events);
      return;
    }

    /* Fase B (decisione #67): pattuglia su N sistemi in loop. */
    if (order.type === 'patrol-loop') {
      const sysReached = order.loop[order.loopIdx];
      events.push({
        kind: 'fleet-waypoint-reached',
        fleetId: fleet.id, fleetName: fleet.name,
        systemId: sysReached,
        wpIdx: order.loopIdx, wpTotal: order.loop.length,
        impulso: game.timeImpulsi
      });
      fleet.location.status = 'orbiting';
      fleet.etaImpulsi = 0;
      fleet.route = [arrivedAt];
      fleet.routeIdx = 0;
      const dwell = (order.dwell && order.dwell[order.loopIdx]) || 0;
      order.dwellLeft = dwell;
      if (dwell <= 0) advanceCompoundOrder(game, fleet, events);
      return;
    }
  }

  /* advanceCompoundOrder — dopo aver "consumato" una tappa di un ordine
     compound (move-route o patrol-loop) e l'eventuale dwell, programma
     la prossima sotto-rotta. Estratto in una funzione per essere
     chiamabile sia dal completamento della rotta che dalla scadenza
     dello dwell (in orbiting). */
  function advanceCompoundOrder(game, fleet, events) {
    const order = fleet.orders;
    if (!order) return;

    if (order.type === 'move-route') {
      order.wpIdx++;
      if (order.wpIdx < order.waypoints.length) {
        const next = order.waypoints[order.wpIdx];
        const path = computePath(game.galaxy, fleet.location.systemId, next);
        if (path) {
          fleet.route = path;
          fleet.routeIdx = 0;
          fleet.etaImpulsi = startNextLeg(game.galaxy, fleet);
        } else {
          /* Tappa diventata irraggiungibile: termina l'ordine in orbita. */
          finishCompound(game, fleet, events, 'route-broken');
        }
        return;
      }
      /* Fine catena: opzionalmente rientro a casa. */
      if (order.returnHome) {
        const colony = game.colonies && game.colonies[fleet.ownerColonyKey];
        if (colony && colony.systemId !== fleet.location.systemId) {
          const back = computePath(game.galaxy, fleet.location.systemId, colony.systemId);
          if (back) {
            fleet.orders = { type: 'return' };
            fleet.route = back;
            fleet.routeIdx = 0;
            fleet.etaImpulsi = startNextLeg(game.galaxy, fleet);
            return;
          }
        }
      }
      finishCompound(game, fleet, events, 'route-complete');
      return;
    }

    if (order.type === 'patrol-loop') {
      order.loopIdx = (order.loopIdx + 1) % order.loop.length;
      const next = order.loop[order.loopIdx];
      const path = computePath(game.galaxy, fleet.location.systemId, next);
      if (path && path.length > 1) {
        fleet.route = path;
        fleet.routeIdx = 0;
        fleet.etaImpulsi = startNextLeg(game.galaxy, fleet);
      } else if (path && path.length === 1) {
        /* Già lì: ricomincia subito col dwell della tappa. */
        const dwell = (order.dwell && order.dwell[order.loopIdx]) || 0;
        order.dwellLeft = dwell;
        if (dwell <= 0) advanceCompoundOrder(game, fleet, events);
      } else {
        finishCompound(game, fleet, events, 'route-broken');
      }
      return;
    }
  }

  function finishCompound(game, fleet, events, reason) {
    fleet.location.status = 'orbiting';
    fleet.etaImpulsi = 0;
    fleet.route = [fleet.location.systemId];
    fleet.routeIdx = 0;
    fleet.orders = { type: 'idle' };
    events.push({
      kind: 'fleet-route-complete',
      fleetId: fleet.id, fleetName: fleet.name,
      systemId: fleet.location.systemId,
      reason: reason,
      impulso: game.timeImpulsi
    });
  }

  /* Stub upkeep — Fase A non applica costi di mantenimento. Lo
     introdurrà M13 (tech logistica) o un polish dedicato. */
  function fleetUpkeep(_fleet) {
    return {};
  }

  /* Helper esposti per UI e tutorial. */
  function classList() {
    return CLASS_ORDER.map(function (id) { return CLASSES[id]; });
  }
  function isReachable(galaxy, fromSysId, toSysId) {
    if (fromSysId === toSysId) return false;
    return !!computePath(galaxy, fromSysId, toSysId);
  }

  ORION.fleet = {
    CLASSES: CLASSES,
    CLASS_ORDER: CLASS_ORDER,
    classList: classList,
    getClass: getClass,
    computePath: computePath,
    buildChainedRoute: buildChainedRoute,
    tempoLeg: tempoLeg,
    fleetMinSpeed: fleetMinSpeed,
    fleetCrewRequired: fleetCrewRequired,
    isReachable: isReachable,
    createFleet: createFleet,
    assignShips: assignShips,
    unassignShips: unassignShips,
    assignCrew: assignCrew,
    unassignCrew: unassignCrew,
    dissolveFleet: dissolveFleet,
    setOrder: setOrder,
    tick: tick,
    fleetUpkeep: fleetUpkeep,
    ensureColonyShipKinds: ensureColonyShipKinds
  };
})(typeof window !== 'undefined' ? window : this);
