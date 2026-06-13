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
      hp: 20, fp: 0, speed: 1.1, crew: 1, hangarLvl: 1, maintMet: 0.05
    },
    caccia: {
      id: 'caccia', name: 'Caccia stellare', glyph: '∢',
      cost: { met: 20, en: 8 }, time: 8,
      hp: 30, fp: 5, speed: 1.2, crew: 1, hangarLvl: 1, maintMet: 0.1
    },
    intercettore: {
      id: 'intercettore', name: 'Intercettore', glyph: '➤',
      cost: { met: 35, en: 15 }, time: 14,
      hp: 45, fp: 8, speed: 1.4, crew: 2, hangarLvl: 2, maintMet: 0.15
    },
    corvetta: {
      id: 'corvetta', name: 'Corvetta', glyph: '◅',
      cost: { met: 60, en: 25, food: 5 }, time: 22,
      hp: 80, fp: 12, speed: 1.0, crew: 4, hangarLvl: 2, maintMet: 0.25
    },
    fregata: {
      id: 'fregata', name: 'Fregata', glyph: '◣',
      cost: { met: 120, en: 50, food: 10 }, time: 40,
      hp: 160, fp: 25, speed: 0.85, crew: 8, hangarLvl: 3, maintMet: 0.5
    },
    /* Decisione #66: nave coloniale "Pioniere". Multi-uso (non consumata
       all'arrivo), riusabile, riparabile come ogni nave. fp 0 (civile) →
       in combattimento contribuisce solo come bersaglio (hp). speed 0.8 →
       più lenta di tutto (detta il passo della flotta). hangarLvl 1 per
       consentire colonizzazione intra-sistema già a inizio partita. */
    coloniale: {
      id: 'coloniale', name: 'Pioniere coloniale', glyph: '◉',
      cost: { met: 80, en: 40, food: 10, water: 10 }, time: 25,
      hp: 70, fp: 0, speed: 0.8, crew: 4, hangarLvl: 1, maintMet: 0.1,
      /* Decisione #66 estensione (sessione 2026-06-09): la nave coloniale
         trasporta livelli demografici. popCargo=2 = "seme demografico" che
         alimenta la fondazione o il rinforzo di una colonia esistente. */
      popCargo: 2
    },
    /* ============================================================
       M15 — Grandi navi (GDD §12.1, decisioni #41/#42).
       Navi capitali rare e costose: averne è un traguardo (§12.1
       "grandi navi rare"). Ospitano più figure (M14) in base alla
       classe — vedi fleetOfficerSlots. `dockWeight` = quanto pesano
       sugli attracchi (#41: caccia=1 … incrociatore alto). I tempi
       seguono il GDD §4.4 (Incrociatore 20-40, Dreadnought 180-240).
       ============================================================ */
    incrociatore: {
      id: 'incrociatore', name: 'Incrociatore', glyph: '◆',
      cost: { met: 240, en: 110, food: 20 }, time: 40,
      hp: 300, fp: 45, speed: 0.8, crew: 14, hangarLvl: 4,
      maintMet: 0.9, dockWeight: 3
    },
    /* Dreadnought + Ammiraglia: l'Hangar planetario NON basta (#41) →
       richiedono il Bacino orbitale (struttura dedicata, structures.js).
       L'Ammiraglia è UNICA per civiltà (GDD §12.1) + bonus di nave a
       tutta la flotta (flagshipBonus). */
    dreadnought: {
      id: 'dreadnought', name: 'Dreadnought', glyph: '⬢',
      cost: { met: 600, en: 280, food: 40 }, time: 200,
      hp: 650, fp: 95, speed: 0.65, crew: 30, hangarLvl: 5,
      requiresStruct: { id: 'bacino-orbitale', level: 1 },
      maintMet: 2.0, dockWeight: 6
    },
    ammiraglia: {
      id: 'ammiraglia', name: 'Nave Ammiraglia', glyph: '❖',
      cost: { met: 1000, en: 480, food: 80, water: 40 }, time: 280,
      hp: 1000, fp: 140, speed: 0.7, crew: 50, hangarLvl: 5,
      requiresStruct: { id: 'bacino-orbitale', level: 2 },
      maintMet: 3.0, dockWeight: 10,
      unique: true,        // GDD §12.1: una sola per civiltà
      flagship: true       // bonus di nave a tutta la flotta (flagshipBonus)
    }
  };

  /* Decisione #66 estensione: capienza pop per CLASSE coloniale. Le altre
     classi NON trasportano popolazione (popCargo: 0 implicito). */
  function fleetPopCargoCap(fleet) {
    if (!fleet || !Array.isArray(fleet.ships)) return 0;
    let cap = 0;
    for (let i = 0; i < fleet.ships.length; i++) {
      const cls = CLASSES[fleet.ships[i].kind];
      if (cls && cls.popCargo) cap += cls.popCargo;
    }
    return cap;
  }
  const CLASS_ORDER = ['explorer', 'caccia', 'intercettore', 'corvetta', 'fregata', 'incrociatore', 'dreadnought', 'ammiraglia', 'coloniale'];

  /* M15: una flotta contiene una nave di questa classe? */
  function fleetHasKind(fleet, kind) {
    if (!fleet || !Array.isArray(fleet.ships)) return false;
    for (let i = 0; i < fleet.ships.length; i++) {
      if (fleet.ships[i].kind === kind) return true;
    }
    return false;
  }

  /* M15 — slot figura (M14) ospitabili dalla flotta, dettati dalla nave
     capitale più grande presente (decisione utente 2026-06-12):
       nessuna capitale → 1 · Incrociatore → 2 · Dreadnought/Ammiraglia → 3.
     Max un bonus per ruolo (gestito in commander.assignToFleet). */
  function fleetOfficerSlots(fleet) {
    if (fleetHasKind(fleet, 'ammiraglia') || fleetHasKind(fleet, 'dreadnought')) return 3;
    if (fleetHasKind(fleet, 'incrociatore')) return 2;
    return 1;
  }

  /* M15 — bonus di NAVE AMMIRAGLIA (GDD §12.1 "bonus speciale"): la nave
     unica per civiltà dà +fuoco e +scafo a TUTTA la flotta, indipendente
     dalle figure. Letto da combat.forceFromFleet. */
  function flagshipBonus(fleet) {
    if (fleetHasKind(fleet, 'ammiraglia')) return { fpMul: 1.15, hpMul: 1.10 };
    return { fpMul: 1, hpMul: 1 };
  }

  /* M15 — peso d'attracco di una flotta/colonia (#41). Le navi capitali
     pesano più di una unità: una flotta di dreadnought satura il porto in
     fretta. Usato dal cap attracchi in expedition.js. */
  function dockWeightOf(kind) {
    const c = CLASSES[kind];
    return (c && c.dockWeight) ? c.dockWeight : 1;
  }

  /* Costanti del viaggio inter-sistema. Coerenti con expedition.js M07
     (decisione #32): un hop sub-luce dura 40-80 Ι (+ scaling danger). M13
     introdurrà i 3 tier di iperguida (×3, ×8, ×20). */
  const TRAVEL_BASE = 50;
  const TRAVEL_DANGER_FACTOR = 30;
  const TRAVEL_MIN = 40;
  const TRAVEL_MAX = 80;

  /* Decisione #66: durata costante della fase orbit (scout/setup atterraggio)
     dell'ordine `colonize`. La fase foundation usa il countdown già definito
     in §6.2 dal pianeta (colCost.impulsi), passato come `foundationI`. */
  const COLONIZE_ORBIT_DURATION = 10;

  /* Decisione #69 — Viveri di flotta (tether logistico morbido).
     Serbatoio di "autonomia in Ι" che cala 1/Ι lontano da un porto amico e
     si ricarica al cap quando vi si sosta. Caso peggiore: rientro forzato +
     deriva (lenta + usura), MAI blocco/distruzione (recovery-friendly #22). */
  const VIVERI_CAP = 250;          // autonomia bersaglio in Ι (confermata utente)
  /* Decisione utente 2026-06-11: la riserva di viaggio è a 4 risorse, con
     quantità tarate perché far partire/rifornire una flotta pesi davvero sul
     bilancio della colonia (cibo/acqua sostentamento equipaggio; metalli
     riparazioni; energia sistemi, in quota minore). Per Ι di autonomia,
     per equipaggio. Pieno (250 Ι) per 8 equip ≈ 140/100/80/50. */
  const VIVERI_RATE_FOOD = 0.07;   // food per equipaggio per Ι di autonomia
  const VIVERI_RATE_WATER = 0.05;  // acqua per equipaggio per Ι di autonomia
  const VIVERI_RATE_MET = 0.04;    // metalli per equipaggio per Ι (riparazioni)
  const VIVERI_RATE_EN = 0.025;    // energia per equipaggio per Ι (sistemi, la più piccola)
  const VIVERI_WARN = 60;          // soglia avviso (~25% del cap)
  const VIVERI_DRIFT_WEAR = 2;     // usura/Ι sulle navi in deriva (viveri a 0)
  const VIVERI_DRIFT_SLOW = 2;     // moltiplicatore durata leg in deriva

  function getClass(kind) {
    return CLASSES[kind] || null;
  }

  /* Decisione #66: la flotta ha almeno una nave coloniale? Usato dall'ordine
     `colonize` come gate di validazione. */
  function fleetHasColonial(fleet) {
    if (!fleet || !Array.isArray(fleet.ships)) return false;
    for (let i = 0; i < fleet.ships.length; i++) {
      if (fleet.ships[i].kind === 'coloniale') return true;
    }
    return false;
  }

  /* La flotta ha potenza di fuoco? (almeno una nave con fp > 0). Usato
     dall'interrupt di rotta (M09 Fase B): le disarmate non ingaggiano. */
  function fleetHasGunsLocal(fleet) {
    if (!fleet || !Array.isArray(fleet.ships)) return false;
    for (let i = 0; i < fleet.ships.length; i++) {
      const c = CLASSES[fleet.ships[i].kind];
      if (c && (c.fp || 0) > 0) return true;
    }
    return false;
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
    /* M13 (decisione #32/#57): l'Iperguida T1 riduce i tempi di viaggio a un
       terzo. Applicato qui (punto unico) così stima e durata reale coincidono
       per tutti i consumer (startNextLeg, routeImpulsi, wizard viveri). */
    let t = base / sp;
    if (ORION.research && ORION.research.hyperMul) t *= ORION.research.hyperMul(ORION.game);
    return Math.max(1, Math.round(t));
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

  /* Decisione di sessione (M08 wizard): variante di computePath che
     rispetta la NEBBIA DI GUERRA — non si può pianificare un viaggio
     attraverso sistemi UNKNOWN. Coerente col gioco: vedi solo ciò che
     conosci (EXPLORED + DETECTED).
       - `state.discovery[i]` ∈ { UNKNOWN, DETECTED, EXPLORED }
       - i nodi intermedi devono essere EXPLORED (li hai già visitati);
       - il nodo target può essere DETECTED se `allowDetectedTarget` è true
         (caso classico: "esploro un sistema rilevato sulla frontiera").
     Ritorna null se non c'è un cammino coerente.
     Nota: questa funzione NON sostituisce computePath — viene usata solo
     dalla UI di pianificazione (wizard). Il tick e gli ordini "vecchi"
     continuano a usare computePath sul grafo completo (la flotta
     potrebbe trovarsi in viaggio attraverso sistemi che vengono perduti
     di vista in seguito, ma quella è l'orchestrazione di M09/M11).      */
  function computeVisiblePath(galaxy, state, fromSysId, toSysId, allowDetectedTarget) {
    if (!galaxy || !galaxy.systems) return null;
    if (!state || !Array.isArray(state.discovery)) return null;
    if (fromSysId === toSysId) return [fromSysId];
    const D = (ORION.galaxy && ORION.galaxy.DISCOVERY) || { UNKNOWN: 0, DETECTED: 1, EXPLORED: 2 };
    const disc = state.discovery;
    /* il target deve essere visibile (DETECTED se permesso, altrimenti EXPLORED). */
    const dT = disc[toSysId];
    if (dT == null) return null;
    if (dT < D.DETECTED) return null;
    if (!allowDetectedTarget && dT < D.EXPLORED) return null;
    /* la sorgente deve essere a tutti gli effetti raggiungibile: di norma
       è EXPLORED (la flotta è lì), ma in scenari edge potrebbe essere
       DETECTED → accettiamo entrambi. */
    if (disc[fromSysId] < D.DETECTED) return null;
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
        if (visited[v]) continue;
        /* Per attraversare un nodo intermedio deve essere EXPLORED:
           non si pianifica un cammino attraverso sistemi solo "rilevati".
           Il TARGET è un'eccezione (può essere DETECTED se l'ordine
           lo permette esplicitamente). */
        if (v !== toSysId && disc[v] < D.EXPLORED) continue;
        if (v === toSysId && disc[v] < (allowDetectedTarget ? D.DETECTED : D.EXPLORED)) continue;
        visited[v] = true;
        prev[v] = u;
        queue.push(v);
      }
    }
    if (!visited[toSysId]) return null;
    const path = [];
    let cur = toSysId;
    while (cur !== -1) { path.unshift(cur); cur = prev[cur]; }
    return path;
  }

  /* Helper UI: lista delle destinazioni VISIBILI raggiungibili da
     `fromSysId` rispettando la nebbia di guerra, ognuna con il numero di
     hop (distanza BFS) e il discovery level. Ordinata per hop crescente.
     Pensata per il wizard dei viaggi (Step 2): l'utente sceglie tra
     sistemi conosciuti, sa la distanza, vede se può esplorare o solo
     trasferirsi/pattugliare. */
  function visibleDestinations(galaxy, state, fromSysId, opts) {
    opts = opts || {};
    const includeDetected = opts.includeDetected !== false;   // default true
    const includeExplored = opts.includeExplored !== false;   // default true
    const out = [];
    if (!galaxy || !state || !Array.isArray(state.discovery)) return out;
    const D = (ORION.galaxy && ORION.galaxy.DISCOVERY) || { UNKNOWN: 0, DETECTED: 1, EXPLORED: 2 };
    const n = galaxy.systems.length;
    /* BFS sui soli nodi EXPLORED + il target che può essere DETECTED. */
    const dist = new Array(n).fill(-1);
    dist[fromSysId] = 0;
    const queue = [fromSysId];
    let head = 0;
    while (head < queue.length) {
      const u = queue[head++];
      const links = galaxy.systems[u].links || [];
      for (let i = 0; i < links.length; i++) {
        const v = links[i];
        if (dist[v] >= 0) continue;
        const dv = state.discovery[v];
        if (dv < D.DETECTED) continue;          // niente UNKNOWN
        dist[v] = dist[u] + 1;
        /* solo i nodi EXPLORED proseguono la BFS (attraversabili).
           I DETECTED sono "foglia": raggiungibili come target ma non
           come transito. Coerente con computeVisiblePath. */
        if (dv >= D.EXPLORED) queue.push(v);
      }
    }
    for (let i = 0; i < n; i++) {
      if (i === fromSysId) continue;
      if (dist[i] < 0) continue;
      const dv = state.discovery[i];
      if (dv >= D.EXPLORED && !includeExplored) continue;
      if (dv === D.DETECTED && !includeDetected) continue;
      out.push({ sysId: i, hops: dist[i], discovery: dv });
    }
    out.sort(function (a, b) { return a.hops - b.hops || a.sysId - b.sysId; });
    return out;
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
      /* M14 → M15: figure di flotta. Slot multipli sulle navi capitali
         (vedi fleetOfficerSlots). Single source of truth. */
      officers: [],
      orders: { type: 'idle' },
      route: [],
      routeIdx: 0,
      etaImpulsi: 0,
      /* M09 (decisione #49): formazione di combattimento — determina la
         soglia di ritirata (aggressive 0% · balanced 30% · defensive 50%). */
      formation: 'balanced',
      /* Decisione #69: viveri di flotta. Nuova flotta provvista al porto
         d'origine (parte al cap). */
      viveri: VIVERI_CAP
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

  /* Decisione #66 estensione: imbarco/sbarco coloni tra una flotta con
     nave coloniale e una colonia. La flotta deve essere docked O orbiting
     nella stessa orbita della colonia (no in-transit). Vincoli:
       - amount > 0
       - amount ≤ fleetPopCargoCap(fleet) − fleet.popOnboard (in carico)
       - colony.pop.total − amount ≥ 1 (sempre 1 unità minima sulla sorgente)
       - target: pop.total + amount ≤ pop.cap (non sforare il tetto). */
  function embarkPop(game, fleet, colonyKey, amount) {
    if (!fleet) return { ok: false, reason: 'Flotta inesistente' };
    const colony = game.colonies && game.colonies[colonyKey];
    if (!colony) return { ok: false, reason: 'Colonia inesistente' };
    if (!colony.colonized) return { ok: false, reason: 'Colonia non operativa' };
    if (fleet.location.systemId !== colony.systemId) {
      return { ok: false, reason: 'Flotta non nello stesso sistema della colonia' };
    }
    if (fleet.location.status === 'in-transit') return { ok: false, reason: 'Flotta in viaggio' };
    amount = Math.max(0, amount | 0);
    if (amount <= 0) return { ok: false, reason: 'Quantità non valida' };
    const cap = fleetPopCargoCap(fleet);
    const onboard = fleet.popOnboard || 0;
    if (onboard + amount > cap) return { ok: false, reason: 'Capienza nave insufficiente (' + cap + ' livelli max)' };
    const popTotal = (colony.pop && colony.pop.total) || 0;
    if (popTotal - amount < 1) return { ok: false, reason: 'La colonia deve mantenere almeno 1 livello' };
    /* Imbarco: decremento colonia, increment fleet.popOnboard. */
    colony.pop.total = popTotal - amount;
    fleet.popOnboard = onboard + amount;
    /* Reset accumulo se la colonia scende sotto al livello attuale (display). */
    if (colony.pop.accum && colony.pop.total < (colony.pop.cap || 0)) {
      /* mantieni accum se sensato (frazione del livello corrente); il motore
         lo userà al prossimo tick di crescita. */
    }
    /* Avvia/rinnova il Bonus Diaspora sulla sorgente (recovery-friendly):
       60 Ι di crescita pop ×2. Vive in colony.diaspora { until, multiplier }. */
    const nowI = game.timeImpulsi || 0;
    colony.diaspora = {
      startedAt: nowI,
      until: nowI + 60,
      multiplier: 2.0
    };
    return { ok: true, popOnboard: fleet.popOnboard };
  }

  /* Sbarco coloni dalla flotta a una colonia operativa. */
  function disembarkPop(game, fleet, colonyKey, amount) {
    if (!fleet) return { ok: false, reason: 'Flotta inesistente' };
    const colony = game.colonies && game.colonies[colonyKey];
    if (!colony) return { ok: false, reason: 'Colonia inesistente' };
    if (!colony.colonized) return { ok: false, reason: 'Colonia non ancora operativa' };
    if (fleet.location.systemId !== colony.systemId) {
      return { ok: false, reason: 'Flotta non nello stesso sistema della colonia' };
    }
    if (fleet.location.status === 'in-transit') return { ok: false, reason: 'Flotta in viaggio' };
    amount = Math.max(0, amount | 0);
    if (amount <= 0) return { ok: false, reason: 'Quantità non valida' };
    const onboard = fleet.popOnboard || 0;
    if (amount > onboard) return { ok: false, reason: 'Coloni a bordo insufficienti' };
    const popTotal = (colony.pop && colony.pop.total) || 0;
    const popCap = (colony.pop && colony.pop.cap) || 0;
    if (popCap > 0 && popTotal + amount > popCap) {
      return { ok: false, reason: 'Tetto demografico raggiunto sulla colonia' };
    }
    colony.pop.total = popTotal + amount;
    fleet.popOnboard = onboard - amount;
    return { ok: true, popOnboard: fleet.popOnboard };
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
    /* Restituisci TUTTE le figure al pool d'Impero (#43/#49 → M15 multi-figura). */
    if (ORION.commander && ORION.commander.releaseAllFromFleet) {
      ORION.commander.releaseAllFromFleet(game, fleet);
    } else if (fleet.commander && ORION.commander && ORION.commander.releaseFromFleet) {
      ORION.commander.releaseFromFleet(game, fleet, { toColonyKey: fleet.ownerColonyKey });
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
    /* Qualunque nuovo ordine annulla l'intento offensivo precedente
       (M09 — decisione #49): re-ordinare una flotta cancella l'attacco. */
    fleet.attackTarget = null;
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
    /* Decisione #69: carico viveri alla partenza se la flotta è a un porto
       amico (tua colonia → addebito stock; porto alleato → gratis). */
    if (fleetAtFriendlyPort(game, fleet)) loadViveriAtPort(game, fleet);

    if (type === 'move' || type === 'explore') {
      const to = order.toSysId;
      if (to == null) return { ok: false, reason: 'Sistema di destinazione assente' };
      const path = computePath(game.galaxy, fleet.location.systemId, to);
      if (!path) return { ok: false, reason: 'Nessuna rotta verso il sistema target' };
      fleet.orders = { type: type, toSysId: to };
      fleet.route = path;
      fleet.routeIdx = 0;
      fleet.etaImpulsi = startNextLeg(game.galaxy, fleet);
      /* Decisione #60: reset flag incidente all'avvio di un nuovo explore. */
      if (type === 'explore') fleet._incidentRolled = false;
      return { ok: true };
    }

    /* M09 (decisione #49): ordine d'attacco. Viaggia come un `move` verso un
       sistema (tipicamente di una civiltà AI o un covo) e all'arrivo lo
       INGAGGIA — `attackTarget` segnala l'intento offensivo a
       processSkirmishes, che risolve lo scontro anche se la civiltà non è
       già ostile (atto di aggressione → verbo morale dark se buona/neutrale,
       light se maligna). Richiede potenza di fuoco.
       Decisione intra-sistema: l'ordine accetta opzionalmente un
       `bodyKey` per ingaggiare *quel* pianeta specifico (es. AI con più
       colonie nello stesso sistema). Se intra-sistema il viaggio
       inter-sistema viene saltato. */
    if (type === 'attack') {
      const to = order.toSysId;
      if (to == null) return { ok: false, reason: 'Sistema di destinazione assente' };
      if (!fleetHasGunsLocal(fleet)) return { ok: false, reason: 'La flotta è disarmata (nessuna potenza di fuoco)' };
      const bodyKey = (order.bodyKey != null) ? String(order.bodyKey) : null;
      const currentSys = fleet.location.systemId;
      /* Intra-sistema: zero viaggio, ingaggia subito al prossimo tick. */
      if (to === currentSys) {
        fleet.orders = { type: 'attack', toSysId: to, bodyKey: bodyKey };
        fleet.route = [currentSys];
        fleet.routeIdx = 0;
        fleet.location.status = 'orbiting';
        if (bodyKey) fleet.location.bodyKey = bodyKey;
        fleet.attackTarget = to;
        fleet.attackBodyKey = bodyKey;
        fleet.etaImpulsi = 0;
        return { ok: true };
      }
      const path = computePath(game.galaxy, currentSys, to);
      if (!path) return { ok: false, reason: 'Nessuna rotta verso il sistema target' };
      fleet.orders = { type: 'attack', toSysId: to, bodyKey: bodyKey };
      fleet.route = path;
      fleet.routeIdx = 0;
      fleet.attackTarget = to;
      fleet.attackBodyKey = bodyKey;
      fleet.etaImpulsi = startNextLeg(game.galaxy, fleet);
      return { ok: true };
    }

    /* Decisione intra-sistema: ordine `garrison`.
       order = { type:'garrison', toSysId, bodyKey }
       La flotta orbita VICINO al pianeta indicato (mio, neutrale, o AI in
       osservazione) restando pronta a reagire. NON ingaggia automaticamente:
       una minaccia in arrivo emette `garrison-threat-detected` che fa
       auto-pausa (decisione #31) e l'utente decide il da farsi.
       Intra-sistema: skip viaggio. Inter-sistema: viaggia come move, poi
       all'arrivo entra in garrison. */
    if (type === 'garrison') {
      const to = order.toSysId;
      const bodyKey = order.bodyKey != null ? String(order.bodyKey) : null;
      if (to == null || !bodyKey) return { ok: false, reason: 'Sistema/pianeta target assenti' };
      const sys = game.galaxy.systems[to];
      if (!sys) return { ok: false, reason: 'Sistema target inesistente' };
      const currentSys = fleet.location.systemId;
      const baseOrder = { type: 'garrison', toSysId: to, bodyKey: bodyKey };
      if (to === currentSys) {
        fleet.orders = baseOrder;
        fleet.route = [currentSys];
        fleet.routeIdx = 0;
        fleet.location.status = 'orbiting';
        fleet.location.bodyKey = bodyKey;
        fleet.etaImpulsi = 0;
        return { ok: true };
      }
      const path = computePath(game.galaxy, currentSys, to);
      if (!path) return { ok: false, reason: 'Nessuna rotta verso il sistema target' };
      fleet.orders = baseOrder;
      fleet.route = path;
      fleet.routeIdx = 0;
      fleet.etaImpulsi = startNextLeg(game.galaxy, fleet);
      return { ok: true };
    }

    /* Decisione #66: ordine di colonizzazione.
       order = { type:'colonize', toSysId, bodyKey, foundationI }
       3 fasi: travel (BFS multi-hop come move) → orbit (ORBIT_DURATION Ι)
       → foundation (foundationI Ι, paid by caller). Intra-sistema: skip
       direttamente a orbit. La nave coloniale è "impegnata" durante
       foundation; al termine la colonia diventa operativa, la flotta resta
       in orbita riassegnabile (auto-park, scelta utente #66).
       Recovery-friendly (#22): se la coloniale è persa in transit, refund
       50% applicato da combat.js + colony.colonizing annullato.
       Validazioni: ≥1 coloniale + crew sufficiente + target raggiungibile.
       Il costo COLONIZZAZIONE viene pagato DAL CHIAMANTE (main.js) prima
       di setOrder, così l'utente vede subito la deduzione (UX). */
    if (type === 'colonize') {
      const to = order.toSysId;
      const bodyKey = order.bodyKey;
      if (to == null || bodyKey == null) return { ok: false, reason: 'Destinazione assente' };
      if (!fleetHasColonial(fleet)) return { ok: false, reason: 'Nessuna nave coloniale in flotta' };
      const foundationI = Math.max(20, order.foundationI || 60);
      const orbitI = (typeof order.orbitI === 'number') ? Math.max(0, order.orbitI) : COLONIZE_ORBIT_DURATION;
      const currentSys = fleet.location.systemId;
      const intraSystem = (to === currentSys);
      if (!intraSystem) {
        const path = computePath(game.galaxy, currentSys, to);
        if (!path) return { ok: false, reason: 'Nessuna rotta verso il sistema target' };
        fleet.orders = {
          type: 'colonize',
          toSysId: to,
          bodyKey: bodyKey,
          phase: 'travel',
          orbitI: orbitI,
          foundationI: foundationI
        };
        fleet.route = path;
        fleet.routeIdx = 0;
        fleet.etaImpulsi = startNextLeg(game.galaxy, fleet);
        return { ok: true };
      }
      /* Intra-sistema: salta travel, parte dall'orbit. */
      fleet.orders = {
        type: 'colonize',
        toSysId: to,
        bodyKey: bodyKey,
        phase: 'orbit',
        phaseLeft: orbitI,
        orbitI: orbitI,
        foundationI: foundationI
      };
      fleet.route = [currentSys];
      fleet.routeIdx = 0;
      fleet.location.status = 'orbiting';
      fleet.etaImpulsi = 0;
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

    /* Fase B (decisione #46): rotta multi-tappa.
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

    /* Fase B (decisione #46): pattuglia su N sistemi in loop.
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
      fleet.legTotal = 0;
      return 0;
    }
    const from = fleet.location.systemId;
    /* La rotta include il sistema corrente in testa: il "next" è
       l'indice corrente + 1. */
    const nextIdx = fleet.routeIdx + 1;
    if (nextIdx >= fleet.route.length) {
      fleet.location.status = 'orbiting';
      fleet.legTotal = 0;
      return 0;
    }
    const toSys = fleet.route[nextIdx];
    fleet.location.status = 'in-transit';
    let t = tempoLeg(galaxy, from, toSys, fleetMinSpeed(fleet));
    /* Bonus Comandante Navigatore (#43): −15% durata viaggio. */
    if (ORION.commander && ORION.commander.fleetSpeedMul) {
      t = Math.max(1, Math.round(t * ORION.commander.fleetSpeedMul(fleet)));
    }
    /* Decisione #69: in deriva (viveri esauriti) la flotta arranca — i leg
       successivi durano di più (razionamento). */
    if (fleet._drift && (fleet.viveri || 0) <= 0) t = Math.max(1, t * VIVERI_DRIFT_SLOW);
    /* Fix bug renderer (decisione di sessione): stora il `legTotal`
       effettivo (post-modificatori comandante/deriva/incidenti) così il
       renderer in `_drawFleets` può interpolare correttamente la posizione
       della flotta lungo il leg. Senza, il renderer ricomputa solo
       `tempoLeg` puro → `eta > total` se ci sono modificatori → progress
       negativo → marker stuck al source. */
    fleet.legTotal = t;
    return t;
  }

  /* ------------------------------------------------------------------
     Incidenti su ordine 'explore' (decisione #60, migrazione M07→M08).
     Porta dentro fleet.js le 4 tipologie di incidente di expedition.js
     (50% ritardo / 30% usura / 15% critico / 5% scoperta fortuita).
     RNG deterministico da seed:fleet-incident:<fleet.id> — replay-safe.
     Si tira 1 sola volta per esplorazione (gated da fleet._incidentRolled).
     Recovery-friendly (#22): l'avaria critica perde lo scafo ma l'equipaggio
     si salva sempre (riprodotto dal pattern expedition.js).
     ------------------------------------------------------------------ */
  function _dangerForExplore(galaxy, fleet) {
    let sysId = fleet.location.systemId;
    if (fleet.orders && fleet.orders.type === 'explore' && fleet.orders.toSysId != null) {
      sysId = fleet.orders.toSysId;
    }
    const s = galaxy && galaxy.systems && galaxy.systems[sysId];
    if (!s) return 0.5;
    return Math.max(0, Math.min(1, (s.danger || 0) / 100));
  }
  function _accidentChanceForExplore(game, fleet) {
    const d = _dangerForExplore(game.galaxy, fleet);
    let c;
    if (d <= 0.33) c = 0.05;
    else if (d <= 0.66) c = 0.15;
    else c = 0.30;
    const xp = (fleet.crew && fleet.crew[0] && fleet.crew[0].xp) || 0;
    c *= 1 - Math.min(0.20, xp * 0.02);
    if (ORION.ai && ORION.ai.pirateThreat && fleet.orders && fleet.orders.toSysId != null) {
      const threat = ORION.ai.pirateThreat(game, fleet.orders.toSysId);
      if (threat > 0) c += threat * 0.15;
    }
    if (ORION.cohesion && ORION.cohesion.expeditionRiskBonus && fleet.orders && fleet.orders.toSysId != null) {
      c += ORION.cohesion.expeditionRiskBonus(game, fleet.orders.toSysId);
    }
    return Math.max(0, c);
  }
  function _rollExploreIncident(game, fleet, events) {
    if (fleet._incidentRolled) return;
    fleet._incidentRolled = true;
    if (!fleet.orders || fleet.orders.type !== 'explore') return;
    if (!ORION.rng || !ORION.rng.makeRng) return;
    const rng = ORION.rng.makeRng((game.seed || '') + ':fleet-incident:' + fleet.id);
    const chance = _accidentChanceForExplore(game, fleet);
    if (rng.float() >= chance) return;
    const danger = _dangerForExplore(game.galaxy, fleet);
    const r = rng.float();
    const ship = fleet.ships && fleet.ships[0];
    if (r < 0.50) {
      const extra = 10 + Math.floor(rng.float() * 11);
      fleet.etaImpulsi = (fleet.etaImpulsi || 0) + extra;
      /* Fix bug renderer: mantieni `legTotal` coerente con l'eta esteso
         dall'incidente, così l'interpolazione del marker resta corretta. */
      if (fleet.legTotal != null) fleet.legTotal = (fleet.legTotal || 0) + extra;
      events.push({ kind: 'fleet-incident', fleetId: fleet.id, fleetName: fleet.name,
        incident: { kind: 'delay', amount: extra }, impulso: game.timeImpulsi });
      return;
    }
    if (r < 0.80) {
      const w = 10 + Math.floor(rng.float() * 6);
      if (ship) ship.wear = Math.min(100, (ship.wear || 0) + w);
      events.push({ kind: 'fleet-incident', fleetId: fleet.id, fleetName: fleet.name,
        incident: { kind: 'wear', amount: w }, impulso: game.timeImpulsi });
      return;
    }
    if (r < 0.95) {
      if (danger > 0.5) {
        const back = 20 + Math.floor(rng.float() * 21);
        if (ship) ship.wear = 100;
        fleet._critBackOverride = back;
        events.push({ kind: 'fleet-incident', fleetId: fleet.id, fleetName: fleet.name,
          incident: { kind: 'critical', backDuration: back }, impulso: game.timeImpulsi });
        return;
      }
      const w = 10 + Math.floor(rng.float() * 6);
      if (ship) ship.wear = Math.min(100, (ship.wear || 0) + w);
      events.push({ kind: 'fleet-incident', fleetId: fleet.id, fleetName: fleet.name,
        incident: { kind: 'wear', amount: w }, impulso: game.timeImpulsi });
      return;
    }
    events.push({ kind: 'fleet-discovery-bonus', fleetId: fleet.id, fleetName: fleet.name,
      impulso: game.timeImpulsi });
  }

  /* ------------------------------------------------------------------
     Decisione #69 — Viveri di flotta. Il GAUGE è in Ι (autonomia
     ~costante); il COSTO in food/acqua del rifornimento scala con
     l'equipaggio (più bocche = più viveri in assoluto). Zero RNG →
     determinismo (#5). Lazy-init (nessun bump di schema): le flotte dei
     save vecchi partono al cap al primo tick.
     ------------------------------------------------------------------ */
  function viveriOf(fleet) {
    if (!fleet) return 0;
    if (fleet.viveri == null) fleet.viveri = VIVERI_CAP;
    return fleet.viveri;
  }
  function viveriCap() { return VIVERI_CAP; }
  function viveriStatus(fleet) {
    const v = viveriOf(fleet);
    if (v <= 0) return 'crit';
    if (v <= VIVERI_WARN) return 'low';
    return 'ok';
  }
  /* Colonia (tua, operativa) nel sistema indicato — per addebito stock. */
  function ownColonyAt(game, sysId) {
    const cols = game.colonies || {};
    for (const k in cols) {
      const c = cols[k];
      if (c && c.colonized && c.systemId === sysId) return c;
    }
    return null;
  }
  /* La flotta è a un porto amico? (tua colonia, una tua STAZIONE operativa
     #81, o colonia di AI alleata #51). */
  function fleetAtFriendlyPort(game, fleet) {
    if (!fleet || !fleet.location) return false;
    const sys = fleet.location.systemId;
    if (sys == null) return false;
    if (ownColonyAt(game, sys)) return true;
    /* M16 (#81): una tua stazione operativa con serbatoio è un porto amico
       avanzato — rifornisce le flotte in territorio profondo. */
    if (ORION.station && ORION.station.stationAt) {
      const st = ORION.station.stationAt(game, sys);
      if (st && ORION.station.isOperationalPort(st)) return true;
    }
    if (ORION.ai && ORION.ai.civForSystem) {
      const civ = ORION.ai.civForSystem(game, sys);
      if (civ && civ.relation === 'alliance') return true;
    }
    return false;
  }
  /* Rifornisce al cap. A una tua colonia addebita food/acqua dallo stock
     (parziale se a corto, recovery-friendly); porto alleato = gratis. Costo
     di 1 Ι di autonomia = equipaggio × (RATE_FOOD + RATE_WATER). */
  function loadViveriAtPort(game, fleet) {
    const cur = viveriOf(fleet);
    if (cur >= VIVERI_CAP) return 0;
    const crew = Math.max(1, fleetCrewRequired(fleet));
    const colony = ownColonyAt(game, fleet.location.systemId);
    let fillI = VIVERI_CAP - cur;
    if (!colony && ORION.station && ORION.station.stationAt) {
      /* M16 (#81): nessuna tua colonia qui ma una STAZIONE operativa →
         rifornisce dal proprio serbatoio (limitato → parziale, recovery-
         friendly). Se il serbatoio è a corto la flotta carica meno. */
      const st = ORION.station.stationAt(game, fleet.location.systemId);
      if (st && ORION.station.isOperationalPort(st)) {
        fillI = ORION.station.drawRefuel(game, st, crew, fillI);
        fleet.viveri = cur + fillI;
        return fillI;
      }
    }
    if (colony && colony.stock) {
      /* Riserva a 4 risorse: per ogni Ι di autonomia attinge cibo/acqua
         (sostentamento) + metalli/energia (riparazioni/sistemi, quota
         minore) dallo stock della colonia. La frazione caricabile è
         limitata dalla risorsa più scarsa (recovery-friendly: carica
         parziale, autonomia ridotta, mai un blocco). */
      const rate = { food: VIVERI_RATE_FOOD, water: VIVERI_RATE_WATER, met: VIVERI_RATE_MET, en: VIVERI_RATE_EN };
      let frac = 1;
      Object.keys(rate).forEach(function (k) {
        const per = crew * rate[k];
        const have = colony.stock[k] || 0;
        if (per * fillI > have && per > 0) frac = Math.min(frac, have / (per * fillI));
      });
      if (frac < 1) fillI = Math.floor(fillI * frac);
      if (fillI <= 0) return 0;
      Object.keys(rate).forEach(function (k) {
        colony.stock[k] = Math.max(0, (colony.stock[k] || 0) - crew * rate[k] * fillI);
      });
    }
    fleet.viveri = cur + fillI;
    return fillI;
  }
  /* Colonia più vicina (origine se viva, altrimenti BFS minima) — meta del
     rientro forzato in deriva. null in esilio (nessuna colonia → la flotta
     resta in deriva sul posto, mai un fail-state). */
  function nearestOwnColony(game, fleet) {
    const own = game.colonies && game.colonies[fleet.ownerColonyKey];
    if (own && own.colonized) return own;
    const cols = game.colonies || {};
    let best = null, bestHops = Infinity;
    for (const k in cols) {
      const c = cols[k];
      if (!c || !c.colonized) continue;
      const p = computePath(game.galaxy, fleet.location.systemId, c.systemId);
      if (p && (p.length - 1) < bestHops) { bestHops = p.length - 1; best = c; }
    }
    return best;
  }
  function maybeForceReturn(game, fleet) {
    if (!fleet.orders || fleet.orders.type === 'return') return;
    const home = nearestOwnColony(game, fleet);
    if (!home || home.systemId === fleet.location.systemId) return;
    const path = computePath(game.galaxy, fleet.location.systemId, home.systemId);
    if (!path) return;
    fleet.orders = { type: 'return', _forcedSupply: true };
    fleet.route = path;
    fleet.routeIdx = 0;
    fleet.etaImpulsi = startNextLeg(game.galaxy, fleet);
  }
  /* processViveri — un Impulso del serbatoio. Chiamato in cima a tick(),
     così anche le flotte idle lontane consumano (l'equipaggio mangia). */
  function processViveri(game, fleet, events) {
    if (!fleet || !fleet.location) return;
    if (fleet.viveri == null) fleet.viveri = VIVERI_CAP;
    if (fleetAtFriendlyPort(game, fleet)) {
      if (fleet.viveri < VIVERI_CAP) loadViveriAtPort(game, fleet);
      fleet._supplyWarned = false;
      if (fleet._drift) {
        fleet._drift = false;
        events.push({ kind: 'fleet-resupplied', fleetId: fleet.id, fleetName: fleet.name,
          systemId: fleet.location.systemId, impulso: game.timeImpulsi });
      }
      return;
    }
    if (fleet.viveri > 0) {
      /* Ingegnere di Flotta (M14 #75): consumo viveri più lento (viveriMul < 1). */
      const vmul = (root.ORION.commander && root.ORION.commander.viveriDrainMul)
        ? root.ORION.commander.viveriDrainMul(fleet) : 1;
      fleet.viveri = Math.max(0, fleet.viveri - vmul);
      if (fleet.viveri <= VIVERI_WARN && !fleet._supplyWarned) {
        fleet._supplyWarned = true;
        events.push({ kind: 'fleet-supply-low', fleetId: fleet.id, fleetName: fleet.name,
          systemId: fleet.location.systemId, viveri: fleet.viveri, impulso: game.timeImpulsi });
      }
    }
    if (fleet.viveri <= 0) {
      if (!fleet._drift) {
        fleet._drift = true;
        events.push({ kind: 'fleet-supply-critical', fleetId: fleet.id, fleetName: fleet.name,
          systemId: fleet.location.systemId, impulso: game.timeImpulsi });
      }
      if (fleet.location.status === 'in-transit' && Array.isArray(fleet.ships)) {
        for (let i = 0; i < fleet.ships.length; i++) {
          fleet.ships[i].wear = Math.min(100, (fleet.ships[i].wear || 0) + VIVERI_DRIFT_WEAR);
        }
      } else {
        /* Non in transito (orbiting/idle): rientro forzato al porto più
           vicino (riserva di rientro garantita #69). */
        maybeForceReturn(game, fleet);
      }
    }
  }
  /* Stima Ι di una rotta (per gli avvisi UI all'ordine). */
  function routeImpulsi(galaxy, fleet, path) {
    if (!Array.isArray(path) || path.length < 2) return 0;
    const sp = fleetMinSpeed(fleet);
    let t = 0;
    for (let i = 1; i < path.length; i++) t += tempoLeg(galaxy, path[i - 1], path[i], sp);
    return t;
  }
  /* Δ Impulsi al prossimo evento viveri (per nextEventImpulsi in time.js). */
  function viveriNextEventDelta(game, fleet) {
    if (!fleet || !fleet.location) return 0;
    if (fleetAtFriendlyPort(game, fleet)) return 0;
    const v = viveriOf(fleet);
    if (v > VIVERI_WARN) return v - VIVERI_WARN;
    if (v > 0) return v;
    return 0;
  }

  /* ------------------------------------------------------------------
     tick — 1 Impulso. Decrementa etaImpulsi se in transito; alla fine
     del leg avanza al prossimo sistema e gestisce arrivo/return/patrol.
     ------------------------------------------------------------------ */
  function tick(game, fleet, events) {
    if (!fleet || !fleet.orders) return;
    /* Decisione #69: viveri PRIMA di tutto (anche le flotte idle lontane
       consumano; il rifornimento ai porti amici resetta i flag). */
    processViveri(game, fleet, events);
    if (fleet.orders.type === 'idle') return;

    /* Decisione #60: incident roll una sola volta all'avvio dell'explore
       outbound (mentre in-transit). */
    if (fleet.orders.type === 'explore' && !fleet._incidentRolled &&
        fleet.location && fleet.location.status === 'in-transit') {
      _rollExploreIncident(game, fleet, events);
    }

    /* Fase B: per i nuovi ordini con dwell, il countdown di sosta avviene
       qui mentre la flotta è `orbiting`. */
    if (fleet.location.status === 'orbiting' && (fleet.orders.dwellLeft || 0) > 0) {
      fleet.orders.dwellLeft = (fleet.orders.dwellLeft || 0) - 1;
      if (fleet.orders.dwellLeft <= 0) {
        advanceCompoundOrder(game, fleet, events);
      }
      return;
    }

    /* Decisione #66: fasi `orbit` e `foundation` dell'ordine colonize.
       La flotta è `orbiting` al sistema target e fa il countdown della
       fase corrente; al termine transita alla fase successiva o completa. */
    if (fleet.location.status === 'orbiting' && fleet.orders.type === 'colonize' &&
        (fleet.orders.phase === 'orbit' || fleet.orders.phase === 'foundation')) {
      tickColonizePhase(game, fleet, events);
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
      _autoRevealAt(arrivedAt);
      events.push({
        kind: 'fleet-leg-hop',
        fleetId: fleet.id, fleetName: fleet.name,
        systemId: arrivedAt,
        impulso: game.timeImpulsi
      });
      /* M09 Fase B (decisione #49): imboscata in rotta. Se la flotta armata
         transita per un sistema con presenza ostile (covo pirata o civiltà
         AI ostile), l'avvistamento INTERROMPE la rotta: si ferma in orbita
         (ordine idle) e lo scontro viene risolto dal loop (processSkirmishes).
         Lo stato dei waypoint successivi viene perso: l'utente ridà l'ordine
         dopo lo scontro (recovery-friendly). Le flotte disarmate proseguono. */
      const CO = ORION.combat;
      if (CO && CO.hostilePresenceAt && CO.hostilePresenceAt(game, arrivedAt)
          && fleetHasGunsLocal(fleet)) {
        fleet.location.status = 'orbiting';
        fleet.etaImpulsi = 0;
        fleet.route = [arrivedAt];
        fleet.routeIdx = 0;
        fleet.orders = { type: 'idle' };
        fleet.combatResolvedAt = null;
        events.push({
          kind: 'fleet-intercepted',
          fleetId: fleet.id, fleetName: fleet.name,
          systemId: arrivedAt, impulso: game.timeImpulsi
        });
        return;
      }
      fleet.etaImpulsi = startNextLeg(game.galaxy, fleet);
      return;
    }

    /* Rotta completata. Cosa fare dipende dall'ordine. */
    const order = fleet.orders;
    /* Decisione #66: arrivo della fase `travel` di colonize → transita a
       `orbit`. La nave coloniale è ora orbitante al sistema target;
       parte il countdown ORBIT_DURATION, poi foundation.
       Loss-on-arrival not possible: la colonia non esiste ancora. */
    if (order.type === 'colonize' && order.phase === 'travel') {
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
      order.phase = 'orbit';
      order.phaseLeft = order.orbitI || COLONIZE_ORBIT_DURATION;
      events.push({
        kind: 'fleet-colonize-orbit',
        fleetId: fleet.id, fleetName: fleet.name,
        systemId: arrivedAt, bodyKey: order.bodyKey,
        impulso: game.timeImpulsi
      });
      return;
    }

    /* Decisione di sessione (post-feedback bug "sistema esplorato resta in
       nebbia"): se la flotta arriva FISICAMENTE in un sistema, lo conosce.
       Rivelazione coerente per qualsiasi ordine (move/attack/garrison/
       move-route/patrol/patrol-loop/return): una flotta in orbita di un
       sistema l'ha esplorato, indipendentemente dall'intento dell'ordine.
       Idempotente (revealSystem ritorna false se era già EXPLORED). */
    function _autoRevealAt(sysId) {
      if (!ORION.galaxy || !ORION.galaxy.revealSystem) return;
      const wasUnknown = ORION.galaxy.revealSystem(game.galaxy, sysId, game.state);
      if (wasUnknown) {
        events.push({
          kind: 'fleet-discovery',
          fleetId: fleet.id, fleetName: fleet.name,
          systemId: sysId,
          impulso: game.timeImpulsi
        });
      }
    }

    if (order.type === 'move' || order.type === 'attack') {
      _autoRevealAt(arrivedAt);
      /* L'attacco mantiene `fleet.attackTarget` (+ opzionale
         `fleet.attackBodyKey`): all'arrivo la flotta orbita e
         processSkirmishes ingaggia il bersaglio al tick successivo. */
      fleet.location.status = 'orbiting';
      if (order.type === 'attack' && order.bodyKey) {
        fleet.location.bodyKey = order.bodyKey;
      }
      fleet.etaImpulsi = 0;
      fleet.route = [arrivedAt];
      fleet.routeIdx = 0;
      events.push({
        kind: 'fleet-arrived',
        fleetId: fleet.id, fleetName: fleet.name,
        systemId: arrivedAt,
        bodyKey: (order.type === 'attack') ? (order.bodyKey || null) : null,
        impulso: game.timeImpulsi
      });
      fleet.orders = { type: 'idle' };
      return;
    }

    /* Decisione intra-sistema: arrivo `garrison` → la flotta entra in
       osservazione vicino al pianeta target. L'ordine RESTA attivo (non
       torna a idle): processGarrisonThreats vigila a ogni tick. */
    if (order.type === 'garrison') {
      _autoRevealAt(arrivedAt);
      fleet.location.status = 'orbiting';
      fleet.location.bodyKey = order.bodyKey || null;
      fleet.etaImpulsi = 0;
      fleet.route = [arrivedAt];
      fleet.routeIdx = 0;
      events.push({
        kind: 'fleet-arrived',
        fleetId: fleet.id, fleetName: fleet.name,
        systemId: arrivedAt, bodyKey: order.bodyKey || null,
        impulso: game.timeImpulsi
      });
      /* L'ordine garrison rimane attivo. */
      return;
    }

    if (order.type === 'explore') {
      /* Rivela il sistema (idempotente, decisione #5 — delta puro).
         _autoRevealAt gestisce sia il reveal che l'evento fleet-discovery. */
      _autoRevealAt(arrivedAt);
      events.push({
        kind: 'fleet-arrived',
        fleetId: fleet.id, fleetName: fleet.name,
        systemId: arrivedAt,
        impulso: game.timeImpulsi
      });
      /* Decisione #60: usura base del viaggio (come expedition.js):
         +8% + danger*10% sulla nave esploratrice all'arrivo. */
      const ship = fleet.ships && fleet.ships[0];
      if (ship && ship.kind === 'explorer') {
        const danger = _dangerForExplore(game.galaxy, fleet);
        const w = 8 + Math.round(danger * 10);
        ship.wear = Math.min(100, (ship.wear || 0) + w);
      }
      /* Auto-return alla colonia origine. Se incidente critico, override del
         ritorno con la durata d'emergenza. */
      const colony = game.colonies && game.colonies[fleet.ownerColonyKey];
      if (colony) {
        const back = computePath(game.galaxy, arrivedAt, colony.systemId);
        if (back) {
          fleet.orders = { type: 'return', _migratedFromExplore: true };
          fleet.route = back;
          fleet.routeIdx = 0;
          fleet.etaImpulsi = startNextLeg(game.galaxy, fleet);
          /* Critical incident: override durata ritorno con emergenza. */
          if (fleet._critBackOverride) {
            fleet.etaImpulsi = fleet._critBackOverride;
            fleet._critBackOverride = null;
          }
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
      _autoRevealAt(arrivedAt);
      const colony = game.colonies && game.colonies[fleet.ownerColonyKey];
      const docked = !!(colony && colony.systemId === arrivedAt);
      if (docked) {
        fleet.location.status = 'docked';
      } else {
        fleet.location.status = 'orbiting';
      }
      fleet.etaImpulsi = 0;
      fleet.route = [arrivedAt];
      fleet.routeIdx = 0;
      /* Decisione #60: se la flotta era un'esplorazione in rientro (1 scafo
         explorer + 1 crew, originata da setOrder('explore') o migrata da M07),
         e ora atterra alla colonia origine, gestisci:
         - crew +1 xp (incluso incidente non critico)
         - ship lost se wear>=100 → non torna al counter, evento fleet-ship-lost
         - Promozione Comandante (#43) se xp >= 5
         - Auto-dissolve della flotta (1 nave + 1 crew → torna tutto a colonia)
         Recovery-friendly: l'equipaggio è sempre salvo, lo scafo no. */
      const isExplore = order._migratedFromExplore || order._migratedFromExpedition ||
        (fleet.ships.length === 1 && fleet.crew.length === 1 &&
         fleet.ships[0] && fleet.ships[0].kind === 'explorer');
      if (docked && isExplore && colony) {
        const ship = fleet.ships[0];
        const crew = fleet.crew[0];
        const shipLost = !!(ship && ship.wear >= 100);
        /* xp +1 al crew (sempre, anche con incidente non critico). */
        if (crew) crew.xp = (crew.xp || 0) + 1;
        /* Identità STABILE: il crew conserva il proprio id (e quindi il
           callsign) per tutta la vita — niente più rinomina al rientro, che
           faceva "saltare" il codice dello stesso equipaggio (fix naming). */
        const newCrew = { id: crew.id, xp: crew.xp };
        /* Restituisci crew alla colonia. */
        if (!colony.crews) colony.crews = { explorer: [] };
        if (!Array.isArray(colony.crews.explorer)) colony.crews.explorer = [];
        colony.crews.explorer.push(newCrew);
        /* Restituisci scafo solo se non perso. */
        if (!shipLost) {
          if (!colony.ships) colony.ships = {};
          colony.ships.explorer = (colony.ships.explorer || 0) + 1;
        } else {
          events.push({
            kind: 'fleet-ship-lost',
            fleetId: fleet.id, fleetName: fleet.name,
            impulso: game.timeImpulsi
          });
        }
        /* Promozione Comandante (#43): se xp >= 5, spawn figura nominata. */
        const C = ORION.commander;
        if (C && C.isPromotable && C.isPromotable(newCrew.xp)) {
          /* Rientro esplorazione = servizio di viaggio → Ingegnere di Flotta (#75). */
          const promotedCmd = C.promote(game, newCrew, newCrew.xp, fleet.ownerColonyKey, 'ingegnere');
          if (promotedCmd) {
            events.push({
              kind: 'commander-promoted',
              commander: promotedCmd,
              colony: colony,
              fromCrewId: newCrew.id,
              impulso: game.timeImpulsi
            });
          }
        }
        /* Auto-dissolve della flotta esploratrice (era un veicolo monouso). */
        fleet.ships = [];
        fleet.crew = [];
        const idx = (game.fleets || []).indexOf(fleet);
        if (idx >= 0) game.fleets.splice(idx, 1);
        events.push({
          kind: 'fleet-route-complete',
          fleetId: fleet.id, fleetName: fleet.name,
          systemId: arrivedAt,
          impulso: game.timeImpulsi
        });
        return;
      }
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
      _autoRevealAt(arrivedAt);
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

    /* Fase B (decisione #46): rotta multi-tappa. La sotto-rotta verso la
       tappa corrente (wpIdx) è appena terminata. */
    if (order.type === 'move-route') {
      const wpReached = order.waypoints[order.wpIdx];
      /* Auto-reveal: la flotta è LÌ, conosce il sistema. Vale sempre,
         indipendentemente da `exploreEach` (che ora è ridondante ma
         lasciato come flag opzionale per UX). */
      _autoRevealAt(wpReached);
      events.push({
        kind: 'fleet-waypoint-reached',
        fleetId: fleet.id, fleetName: fleet.name,
        systemId: wpReached,
        wpIdx: order.wpIdx, wpTotal: order.waypoints.length,
        impulso: game.timeImpulsi
      });
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

    /* Fase B (decisione #46): pattuglia su N sistemi in loop. */
    if (order.type === 'patrol-loop') {
      const sysReached = order.loop[order.loopIdx];
      _autoRevealAt(sysReached);
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

  /* Decisione #66: countdown delle fasi `orbit` e `foundation` di colonize.
     - orbit (~10 Ι): scout/setup atterraggio. Al termine: crea/aggiorna
       `colony.colonizing` con `fleetId`, transita a foundation. La colonia
       compare in UI come "in arrivo" coerente con la convenzione M05.
     - foundation (resto del countdown): la nave è "atterrata"/impegnata.
       Al termine: colonia operativa (delega a ORION.time.completeColonization
       per stock/pop iniziali coerenti), fleet sblocca la coloniale, evento
       colony-done emesso. */
  function tickColonizePhase(game, fleet, events) {
    const order = fleet.orders;
    if (!order || order.type !== 'colonize') return;
    order.phaseLeft = (order.phaseLeft || 0) - 1;
    if (order.phaseLeft > 0) return;

    const sysId = fleet.location.systemId;
    const bodyKey = order.bodyKey;
    const colKey = sysId + ':' + bodyKey;

    if (order.phase === 'orbit') {
      /* Avvia la fase foundation: crea/aggiorna colony.colonizing con
         riferimento alla flotta. La colonia esiste già come delta nel
         game.colonies (creata da colonyForBody / createColony) ma con
         colonized:false. */
      const colony = game.colonies && game.colonies[colKey];
      if (!colony) {
        /* Errore difensivo: colonia delta inesistente. Recovery-friendly:
           termina l'ordine in orbita, niente fail-state. */
        fleet.orders = { type: 'idle' };
        events.push({
          kind: 'fleet-colonize-failed',
          fleetId: fleet.id, fleetName: fleet.name,
          systemId: sysId, bodyKey: bodyKey,
          reason: 'colony-delta-missing',
          impulso: game.timeImpulsi
        });
        return;
      }
      if (colony.colonized) {
        /* Già colonizzata da qualcun altro? Nel modello giocatore solo è
           impossibile, ma protezione difensiva. Annulla l'ordine. */
        fleet.orders = { type: 'idle' };
        events.push({
          kind: 'fleet-colonize-failed',
          fleetId: fleet.id, fleetName: fleet.name,
          systemId: sysId, bodyKey: bodyKey,
          reason: 'already-colonized',
          impulso: game.timeImpulsi
        });
        return;
      }
      colony.colonizing = {
        startedAt: (ORION.time && ORION.time.currentDS) ? ORION.time.currentDS(game) : null,
        duration: order.foundationI,
        fleetId: fleet.id
      };
      order.phase = 'foundation';
      order.phaseLeft = order.foundationI;
      events.push({
        kind: 'fleet-colonize-foundation',
        fleetId: fleet.id, fleetName: fleet.name,
        systemId: sysId, bodyKey: bodyKey,
        colKey: colKey,
        impulso: game.timeImpulsi
      });
      return;
    }

    if (order.phase === 'foundation') {
      /* Foundation completata: promuovi colonia a operativa via helper
         time.js (riusa stock/pop iniziali coerenti). La coloniale si
         sblocca: la flotta resta in orbita riassegnabile (auto-park).
         Decisione #66 estensione: il seme demografico viene dalla
         nave (popOnboard). Se la nave ha 2 coloni a bordo, la colonia
         nasce a 2 livelli invece di 1. */
      const colony = game.colonies && game.colonies[colKey];
      const seedLevels = Math.max(1, fleet.popOnboard || 0);
      if (colony && !colony.colonized && ORION.time && ORION.time.completeColonization) {
        ORION.time.completeColonization(game, colony, colKey, null, events, { seedLevels: seedLevels });
      } else if (colony && !colony.colonized) {
        /* Fallback se completeColonization non disponibile: applica il
           contratto minimo (coerente con processColonizing legacy). */
        colony.colonized = true;
        if (ORION.time && ORION.time.currentDS) colony.colonizedDS = ORION.time.currentDS(game);
        colony.pop = colony.pop || { total: 0, cap: 0, classes: {} };
        colony.pop.total = Math.max(colony.pop.total || 0, seedLevels);
        colony.stock = colony.stock || { met: 40, en: 30, food: 20, water: 20 };
      }
      /* Consuma popOnboard: tutti i coloni sbarcati alla fondazione. */
      fleet.popOnboard = 0;
      if (colony) {
        colony.colonizing = null;
      }
      events.push({
        kind: 'colony-done',
        colony: colony,
        planet: null,    /* il chiamante in main.js ricostruisce dal colKey */
        colKey: colKey,
        viaFleet: true,
        fleetId: fleet.id,
        impulso: game.timeImpulsi
      });
      /* Reset ordine: la flotta resta in orbita riassegnabile. */
      fleet.orders = { type: 'idle' };
      fleet.location.status = 'orbiting';
      fleet.etaImpulsi = 0;
      fleet.route = [sysId];
      fleet.routeIdx = 0;
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
      /* Servizio (decisione utente 2026-06-11): rotta lunga (≥3 tappe)
         conclusa → l'equipaggio matura. Anti-farm: le rotte brevi (1-2
         tappe) non danno xp. */
      if (order.waypoints && order.waypoints.length >= 3) {
        awardCrewXp(game, fleet, 1, events, 'travel');
      }
      finishCompound(game, fleet, events, 'route-complete');
      return;
    }

    if (order.type === 'patrol-loop') {
      order.loopIdx = (order.loopIdx + 1) % order.loop.length;
      /* Servizio: giro completo di pattuglia su ≥3 sistemi → +1 xp.
         Anti-farm: il ping-pong a 2 sistemi non matura; un giro a 3+
         sistemi costa ≥120 Ι, quindi la crescita è lenta (servizio). */
      if (order.loopIdx === 0 && order.loop.length >= 3) {
        awardCrewXp(game, fleet, 1, events, 'tactical');
      }
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

  /* Servizio vario (decisione utente 2026-06-11, emenda #39/#43): un
     equipaggio assegnato a una flotta matura xp anche da combattimenti
     vinti e missioni di flotta concluse, non solo esplorando. Al grado
     massimo (xp 10) emerge un Comandante (in panchina sulla colonia
     d'origine) e il crew si riforma (commander.promote resetta a 0).
     Deterministico (#5), recovery-friendly (#22): se la colonia d'origine
     non esiste più, l'xp resta sul crew e la promozione avverrà al rientro. */
  function awardCrewXp(game, fleet, amount, events, kind) {
    if (!fleet || !Array.isArray(fleet.crew) || !(amount > 0)) return;
    const C = root.ORION && root.ORION.commander;
    const colony = game.colonies && game.colonies[fleet.ownerColonyKey];
    for (let i = 0; i < fleet.crew.length; i++) {
      const cr = fleet.crew[i];
      if (!cr) continue;
      cr.xp = (cr.xp || 0) + amount;
      /* M14 (#75): accumula il TIPO di servizio → al momento della
         promozione il ruolo della figura riflette l'attività dominante. */
      if (C && C.bumpCrewSvc) C.bumpCrewSvc(cr, kind || 'combat', amount);
      /* Comandante a livello Impero (decisione utente 2026-06-11): la
         promozione avviene SEMPRE al grado massimo, anche se la flotta è
         lontano da casa / in esilio (niente colonia richiesta). */
      if (C && C.isPromotable && C.isPromotable(cr.xp)) {
        const cmd = C.promote(game, cr, cr.xp, fleet.ownerColonyKey);
        if (cmd && events) {
          events.push({
            kind: 'commander-promoted', commander: cmd,
            colony: colony, fromCrewId: cr.id,
            impulso: game.timeImpulsi
          });
        }
      }
    }
  }

  /* Stub upkeep — Fase A non applica costi di mantenimento alle flotte
     DISPIEGATE (loro pagano viveri #69 + usura). Lo estenderà M13. */
  function fleetUpkeep(_fleet) {
    return {};
  }

  /* Manutenzione navi PARCHEGGIATE (decisione utente 2026-06-11): occupare
     un attracco = riparazione/mantenimento → consuma metalli/Ι. Le navi
     DISPIEGATE in flotta NON pagano qui (hanno viveri + usura). Somma
     colony.ships[kind] × CLASSES[kind].maintMet. Recovery-friendly: è solo
     un drain sui metalli (se vanno a 0 → scarsità, mai perdita navi).
     GANCIO M16 (porto stellare orbitale): quando le stazioni aggiungeranno
     un parcheggio orbitale alla colonia, anche quelle navi pagheranno la
     manutenzione qui — basterà sommare il counter orbitale (es.
     colony.orbitalDock) con gli stessi maintMet. */
  function dockedMaintenance(colony) {
    if (!colony || !colony.ships) return 0;
    let met = 0;
    Object.keys(colony.ships).forEach(function (kind) {
      const n = colony.ships[kind] | 0;
      const cls = CLASSES[kind];
      if (n > 0 && cls && cls.maintMet) met += n * cls.maintMet;
    });
    /* M16: + somma navi nel porto orbitale (colony.orbitalDock) quando esisterà. */
    return met;
  }

  /* Manutenzione TOTALE al porto di una colonia (decisione utente 2026-06-11):
     navi di riserva (colony.ships) + navi delle FLOTTE ferme a questo porto
     (docked/orbiting nel sistema della colonia → sono in servizio/riparazione
     qui). Le flotte IN VIAGGIO non rientrano (pagano la riserva di viaggio a
     4 risorse). Chiude il loophole "parcheggia la riserva in una flotta ferma
     per evitare la manutenzione". */
  function portMaintenance(game, colony) {
    let met = dockedMaintenance(colony);
    const sys = colony && colony.systemId;
    if (game && Array.isArray(game.fleets) && sys != null) {
      game.fleets.forEach(function (f) {
        if (!f || !f.location || f.location.systemId !== sys) return;
        const st = f.location.status;
        if (st !== 'docked' && st !== 'orbiting') return;   // in-transit = in viaggio
        (f.ships || []).forEach(function (s) {
          const cls = CLASSES[s.kind];
          if (cls && cls.maintMet) met += cls.maintMet;
        });
      });
    }
    return met;
  }

  /* M09 (decisione #49): imposta la formazione di combattimento. */
  const FORMATIONS = ['aggressive', 'balanced', 'defensive'];
  function setFormation(fleet, formation) {
    if (!fleet) return { ok: false, reason: 'Flotta inesistente' };
    if (FORMATIONS.indexOf(formation) < 0) return { ok: false, reason: 'Formazione sconosciuta' };
    fleet.formation = formation;
    return { ok: true };
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
    computeVisiblePath: computeVisiblePath,
    visibleDestinations: visibleDestinations,
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
    awardCrewXp: awardCrewXp,
    fleetUpkeep: fleetUpkeep,
    dockedMaintenance: dockedMaintenance,
    portMaintenance: portMaintenance,
    ensureColonyShipKinds: ensureColonyShipKinds,
    FORMATIONS: FORMATIONS,
    setFormation: setFormation,
    fleetHasColonial: fleetHasColonial,
    /* M15 — grandi navi. */
    fleetHasKind: fleetHasKind,
    fleetOfficerSlots: fleetOfficerSlots,
    flagshipBonus: flagshipBonus,
    dockWeightOf: dockWeightOf,
    /* Decisione #66 estensione: API trasporto coloni. */
    fleetPopCargoCap: fleetPopCargoCap,
    embarkPop: embarkPop,
    disembarkPop: disembarkPop,
    /* Decisione #69: viveri di flotta (tether logistico). */
    viveriCap: viveriCap,
    viveriOf: viveriOf,
    viveriStatus: viveriStatus,
    fleetAtFriendlyPort: fleetAtFriendlyPort,
    loadViveriAtPort: loadViveriAtPort,
    routeImpulsi: routeImpulsi,
    viveriNextEventDelta: viveriNextEventDelta
  };
})(typeof window !== 'undefined' ? window : this);
