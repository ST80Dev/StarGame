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
    /* Estrattore §17.3 (richiesta utente 2026-06-16): scafo industriale per
       il drenaggio sostenuto delle anomalie/cinture. Resta sul sito a
       raccogliere, harvest rate scalato sull'Hangar della colonia origine
       (vedi anomaly.js). Più lento e rugged dell'esploratore. Equipaggio
       riusato (esploratore) per evitare di moltiplicare le classi crew. */
    estrattore: {
      id: 'estrattore', name: 'Estrattore', glyph: '⊟',
      cost: { met: 50, en: 20 }, time: 16,
      hp: 35, fp: 0, speed: 0.9, crew: 1, hangarLvl: 1, maintMet: 0.08
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
      /* Bilanciamento 2026-06-16: capitali +30% maintMet (era 0.9 → 1.2) +
         nuovo maintEn per drenare l'energia in eccesso della capitale endgame
         (era 0, in deficit perché capitali grosse non costavano energia al porto). */
      maintMet: 1.2, maintEn: 0.3, dockWeight: 3
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
      maintMet: 2.7, maintEn: 0.6, dockWeight: 6   // bilanciamento 2026-06-16: maintMet +30%, +maintEn
    },
    ammiraglia: {
      id: 'ammiraglia', name: 'Nave Ammiraglia', glyph: '❖',
      cost: { met: 1000, en: 480, food: 80, water: 40 }, time: 280,
      hp: 1000, fp: 140, speed: 0.7, crew: 50, hangarLvl: 5,
      requiresStruct: { id: 'bacino-orbitale', level: 2 },
      maintMet: 4.0, maintEn: 0.9, dockWeight: 10,   // bilanciamento 2026-06-16: maintMet +30%, +maintEn
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
  const CLASS_ORDER = ['explorer', 'estrattore', 'caccia', 'intercettore', 'corvetta', 'fregata', 'incrociatore', 'dreadnought', 'ammiraglia', 'coloniale'];

  /* ============================================================
     SENSORI / RADAR (M18.x — flotte ambientali AI, richiesta utente
     2026-06-18). Ogni classe ha una "qualità sensori" 0..1: gli scafi
     da ricognizione (esploratore/intercettore) leggono lo spazio meglio
     delle navi da linea, lente e rumorose. Mappa SEPARATA dal catalogo
     CLASSES (additiva, diff minimo, nessuna migrazione: derivata, non
     persistita). Consumata da aifleet.js per il rilevamento delle
     flotte altrui e la stima della loro composizione. */
  const SENSOR_BY_CLASS = {
    explorer: 1.0, intercettore: 0.9, ammiraglia: 0.9, dreadnought: 0.7,
    caccia: 0.7, incrociatore: 0.6, corvetta: 0.6, fregata: 0.5,
    estrattore: 0.4, coloniale: 0.3
  };
  function shipSensor(kind) {
    return SENSOR_BY_CLASS[kind] != null ? SENSOR_BY_CLASS[kind] : 0.5;
  }
  /* Capacità sensoriale aggregata di una flotta: la guida lo scafo col
     sensore migliore (la ricognizione la fa la nave più adatta), con un
     piccolo bonus dalla numerosità (più occhi). `range` = hop di copertura
     attorno alla flotta (1 se ha uno scafo da ricognizione, altrimenti 0). */
  function fleetSensor(fleet) {
    if (!fleet || !Array.isArray(fleet.ships) || !fleet.ships.length) {
      return { power: 0, range: 0, recon: false };
    }
    let best = 0, recon = false, n = 0;
    for (let i = 0; i < fleet.ships.length; i++) {
      const k = fleet.ships[i].kind;
      const v = shipSensor(k);
      if (v > best) best = v;
      if (k === 'explorer' || k === 'intercettore') recon = true;
      n++;
    }
    const power = Math.min(1.2, best + Math.min(0.18, 0.05 * Math.log(1 + n)));
    return { power: power, range: recon ? 1 : 0, recon: recon };
  }

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

  /* ==================================================================
     POSTI D'ATTRACCO PER FLOTTE — parcheggio reale (decisione utente
     2026-06-18). Una flotta che arriva/sosta a una tua colonia (o tua
     stazione) "parcheggia" secondo una cascata di capacità:
       1) Hangar a terra (Cantiere navale) se c'è posto;
       2) altrimenti Stazione orbitale operativa se ha posto;
       3) altrimenti resta in ORBITA-parcheggio.
     Il "dove" vive in `location.berth ∈ {'hangar','station','orbit'}`,
     additivo/lazy: i save vecchi lo derivano (vedi berthOf) → niente bump.

     Regole (richiesta utente):
       - In orbita-parcheggio la flotta è RIFORNITA (viveri) ma NON si
         ripara: la riparazione avviene solo attraccata (hangar o stazione).
       - Capacità hangar parcheggio = attracchi (docks) + cantieri
         (buildSlots): le navi in COSTRUZIONE prenotano già il loro posto
         per quando saranno pronte. Lvl 1 → 4 + 2 = 6. Sta al giocatore
         riservarsi gli slot in base a quante ne sta costruendo.
       - L'occupazione è PESATA sulla stazza (dockWeightOf, #41): le navi
         capitali pesano più di 1.
       - L'occupazione attracchi decide il parcheggio ma NON blocca la
         costruzione (decisione #69 invariata: canBuildShip conta solo le
         navi a terra/in coda).
     Capacità stazione: base NON minimale (chi fonda una stazione ha già
     una flotta ampia, mid-game) e cresce col livello. Tarabile. */
  const STATION_BERTH_CAP_BY_LEVEL = [0, 10, 16, 24, 32]; // idx = station.level (1..4)

  function _exp() { return root.ORION && root.ORION.expedition; }

  /* Peso d'attracco totale di una flotta (somma delle sue navi). */
  function dockWeightOfFleet(fleet) {
    if (!fleet || !Array.isArray(fleet.ships)) return 0;
    let w = 0;
    for (let i = 0; i < fleet.ships.length; i++) {
      w += dockWeightOf(fleet.ships[i] && fleet.ships[i].kind);
    }
    return w;
  }
  /* Posti parcheggio dell'Hangar = attracchi + cantieri. Delega all'unica
     fonte di verità (expedition.hangarBerthCapacity) per restare allineato
     a canBuildShip e alla UI. Fallback locale se expedition non è caricato. */
  function hangarBerthCapacity(colony) {
    const E = _exp();
    if (!E) return 0;
    if (E.hangarBerthCapacity) return E.hangarBerthCapacity(colony);
    const docks = E.hangarDockCapacity ? E.hangarDockCapacity(colony) : 0;
    const slots = E.hangarBuildSlots ? E.hangarBuildSlots(colony) : 0;
    return docks + slots;
  }
  /* Posti d'attracco della Stazione orbitale, per livello. */
  function stationBerthCapacity(station) {
    if (!station) return 0;
    const lvl = Math.max(0, Math.min(station.level | 0, STATION_BERTH_CAP_BY_LEVEL.length - 1));
    return STATION_BERTH_CAP_BY_LEVEL[lvl] || 0;
  }
  function operationalStationAt(game, sysId) {
    const S = root.ORION && root.ORION.station;
    if (!S || !S.stationAt) return null;
    const st = S.stationAt(game, sysId);
    return (st && S.isOperationalPort && S.isOperationalPort(st)) ? st : null;
  }
  /* Peso occupato dalle FLOTTE ormeggiate in un berth dato del sistema
     (escludendo `self`, la flotta che sta cercando posto). */
  function fleetBerthWeightAt(game, sysId, berth, self) {
    let w = 0;
    const fleets = (game && game.fleets) || [];
    for (let i = 0; i < fleets.length; i++) {
      const f = fleets[i];
      if (!f || f === self || !f.location) continue;
      if (f.location.systemId !== sysId) continue;
      if (f.location.status !== 'docked') continue;
      if (berthOf(game, f) !== berth) continue;
      w += dockWeightOfFleet(f);
    }
    return w;
  }
  /* berthOf — dove è ormeggiata/parcheggiata una flotta. Esplicito da
     location.berth; per i save vecchi (campo assente) lo DERIVA: docked a
     una tua colonia → 'hangar'; docked a una tua stazione → 'station'; in
     orbita a un tuo porto → 'orbit'; altrimenti null (orbita generica o
     territorio altrui / in viaggio). */
  function berthOf(game, fleet) {
    if (!fleet || !fleet.location) return null;
    const st = fleet.location.status;
    if (st !== 'docked' && st !== 'orbiting') return null;   // in-transit → nessun berth
    if (fleet.location.berth) return fleet.location.berth;
    const sysId = fleet.location.systemId;
    if (st === 'docked') {
      if (ownColonyAt(game, sysId)) return 'hangar';
      if (operationalStationAt(game, sysId)) return 'station';
      return 'hangar';   // docked storico senza porto noto → assimila a terra
    }
    /* orbiting */
    if (ownColonyAt(game, sysId) || operationalStationAt(game, sysId)) return 'orbit';
    return null;
  }
  /* Etichetta umana del berth (per la UI). Distingue hangar / stazione /
     orbita-parcheggio dal generico "in orbita". */
  function berthLabel(berth) {
    if (berth === 'hangar') return 'in hangar';
    if (berth === 'station') return 'alla stazione orbitale';
    if (berth === 'orbit') return 'in orbita (parcheggio)';
    return 'in orbita';
  }
  /* parkAtArrival — cascata hangar→stazione→orbita all'arrivo/sosta in un
     sistema. Imposta location.status + berth + bodyKey. Ritorna il berth
     scelto ('hangar'|'station'|'orbit') o null (orbita generica, nessun
     tuo porto qui). */
  function parkAtArrival(game, fleet, sysId) {
    if (!fleet || !fleet.location) return null;
    const w = dockWeightOfFleet(fleet);
    /* 1) Hangar a terra: capacità = docks + buildSlots; usato = navi a
       terra + in coda (totalShipsBound) + flotte già in hangar. */
    const colony = ownColonyAt(game, sysId);
    if (colony) {
      const E = _exp();
      const cap = hangarBerthCapacity(colony);
      const colonyKey = ownColonyKeyAt(game, sysId);
      const bound = (E && E.totalShipsBound) ? E.totalShipsBound(game, colony, colonyKey).total : 0;
      const used = bound + fleetBerthWeightAt(game, sysId, 'hangar', fleet);
      if (used + w <= cap) {
        fleet.location.status = 'docked';
        fleet.location.bodyKey = null;
        fleet.location.berth = 'hangar';
        return 'hangar';
      }
    }
    /* 2) Stazione orbitale operativa. */
    const station = operationalStationAt(game, sysId);
    if (station) {
      const sused = fleetBerthWeightAt(game, sysId, 'station', fleet);
      if (sused + w <= stationBerthCapacity(station)) {
        fleet.location.status = 'docked';
        fleet.location.bodyKey = null;
        fleet.location.berth = 'station';
        return 'station';
      }
    }
    /* 3) Orbita-parcheggio (porto saturo) o orbita generica (nessun porto). */
    fleet.location.status = 'orbiting';
    fleet.location.bodyKey = null;
    fleet.location.berth = (colony || station) ? 'orbit' : null;
    return fleet.location.berth;
  }

  /* Costanti del viaggio inter-sistema. Coerenti con expedition.js M07
     (decisione #32): un hop sub-luce dura 40-80 Ι (+ scaling danger). M13
     introdurrà i 3 tier di iperguida (×3, ×8, ×20). */
  const TRAVEL_BASE = 50;
  const TRAVEL_DANGER_FACTOR = 30;
  const TRAVEL_MIN = 40;
  const TRAVEL_MAX = 80;

  /* Esperienza da viaggio (ricalibrazione 2026-06-15, emenda #39/#43/#71).
     L'equipaggio matura per SERVIZIO: ogni TRAVEL_XP_EVERY Ι effettivamente
     trascorsi in volo (qualunque ordine: move/attack/colonize/return/rotta/
     pattuglia/explore) → +1 xp. Così i viaggi semplici contano, non solo le
     esplorazioni a/r. Anti-farm: è ancorato al TEMPO reale di volo (la spola
     A→B non bara più del tempo che costa). Un hop dura 40-80 Ι → ~1-1.5 hop
     per xp; promozione a Comandante (xp 10, #71) ≈ 800 Ι di servizio. I bonus
     "speciali" (combattimento vinto, esplorazione completata) restano in
     aggiunta. Tarabile in M20. */
  const TRAVEL_XP_EVERY = 80;

  /* Decisione #66: durata costante della fase orbit (scout/setup atterraggio)
     dell'ordine `colonize`. La fase foundation usa il countdown già definito
     in §6.2 dal pianeta (colCost.impulsi), passato come `foundationI`. */
  const COLONIZE_ORBIT_DURATION = 10;

  /* Decisione #69 — Viveri di flotta (tether logistico morbido).
     Serbatoio di "autonomia in Ι" che cala 1/Ι lontano da un porto amico e
     si ricarica al cap quando vi si sosta. Caso peggiore: rientro forzato +
     deriva (lenta + usura), MAI blocco/distruzione (recovery-friendly #22). */
  const VIVERI_CAP = 250;          // autonomia bersaglio DEFAULT in Ι (capienza serbatoio personalizzabile per flotta)
  /* Bilanciamento 2026-06-16: il giocatore può ora scegliere quanta autonomia
     caricare alla partenza (slider 1→VIVERI_CAP_MAX). Default 250 (back-compat
     con save esistenti). Costo proporzionale: più carico = più crew × Ι × rate.
     Hard cap solo per sanity check (no overflow numerici / UI). */
  const VIVERI_CAP_MIN = 50;
  const VIVERI_CAP_MAX = 1500;
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
  /* Usura per Ι in transito (decisione utente 2026-06-16): sostituisce il
     lump-sum all'arrivo (era +8% + danger*10% solo esploratore). Modello
     unico per tutte le classi: drip leggero per Ι, scalato sul danger del
     sistema attraversato. Calibrazione target: ~25 viaggi da 40 Ι ≈ 65%
     wear cumulato (lascia margine per gli incidenti). */
  const WEAR_TRANSIT_BASE = 0.05;  // usura/Ι base in transito (danger=0)
  /* Soglia oltre la quale una flotta in survey rientra automaticamente.
     Coerente con il modello viveri (#69): nessuna distruzione, solo trigger
     di rientro. Sopra 80% la riparazione costa significativamente e il
     rischio incidente critico (wear=100) è alto. */
  const WEAR_RETURN_THRESHOLD = 80;
  /* Riparazione al porto (richiesta utente 2026-06-16): le flotte ferme al
     porto di una colonia con Hangar (o orbitanti al suo sistema) recuperano
     wear nel tempo. Tasso scalato sul livello Hangar; costo extra in metalli
     proporzionale al wear effettivamente riparato. */
  const REPAIR_RATE_BY_HANGAR = [0, 0.6, 1.0, 1.4, 1.8, 2.2]; // %wear/Ι per lvl (idx 0 unused, fino a lvl 5)
  const REPAIR_MET_PER_PCT = 0.4;  // metalli per %wear riparato (extra su maintMet)
  /* Tasso di riparazione presso una stazione orbitale (M16) operativa di
     livello ≥ 2. Fisso, indipendente dalla colonia origine: la stazione ha
     il proprio supply pool (vedi station.js) e il refit è un servizio
     standard. */
  const REPAIR_RATE_STATION = 1.0; // %wear/Ι alla stazione lvl ≥ 2
  const VIVERI_DRIFT_SLOW = 2;     // moltiplicatore durata leg in deriva
  const REFUEL_MARKUP = 1.6;       // sovrapprezzo rifornimento a pagamento presso AI in pace (#69)

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
         d'origine (parte al cap). Bilanciamento 2026-06-16: `viveriCap` è
         ora un campo per-flotta (personalizzabile dal giocatore). Default 250. */
      viveriCap: VIVERI_CAP,
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

  /* addNewShip — materializza UNA nave nuova (classe `kind`) direttamente
     nell'array di una flotta, senza passare dal counter di una colonia.
     Usata dal cantiere della Stazione (M16): la stazione assembla scafi
     leggeri/medi da una riserva di metalli e li consegna a una flotta
     ormeggiata. Ritorna l'entità nave creata, o null se classe ignota. */
  function addNewShip(game, fleet, kind) {
    const cls = CLASSES[kind];
    if (!fleet || !cls) return null;
    if (!Array.isArray(fleet.ships)) fleet.ships = [];
    const ship = { id: nextShipId(game), kind: kind, hp: cls.hp, wear: 0 };
    fleet.ships.push(ship);
    return ship;
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

  /* Decisione #76: assegna un equipaggio SPECIFICO (per id) anziché il
     primo in lista. Permette alla UI di scegliere il veterano giusto invece
     di "+1 a caso" (l'utente decide quale esperienza mandare in missione).
     Stessi vincoli di assignCrew (docked alla colonia origine). */
  function assignCrewById(game, fleet, colonyKey, crewId) {
    if (!fleet) return { ok: false, reason: 'Flotta inesistente' };
    if (crewId == null) return { ok: false, reason: 'Equipaggio non indicato' };
    const colony = game.colonies && game.colonies[colonyKey];
    if (!colony) return { ok: false, reason: 'Colonia inesistente' };
    if (fleet.location.status !== 'docked' || fleet.location.systemId !== colony.systemId) {
      return { ok: false, reason: 'La flotta deve essere all\'attracco della colonia' };
    }
    if (!colony.crews) colony.crews = { explorer: [] };
    if (!Array.isArray(colony.crews.explorer)) colony.crews.explorer = [];
    const idx = colony.crews.explorer.findIndex(function (c) { return c && c.id === crewId; });
    if (idx < 0) return { ok: false, reason: 'Equipaggio non disponibile' };
    fleet.crew.push(colony.crews.explorer.splice(idx, 1)[0]);
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
    /* Avvia/rinnova il Bonus Diaspora sulla sorgente (recovery-friendly).
       Bilanciamento sessione 2026-06-09 (fix A): ridotto da ×2.0 / 60 Ι a
       ×1.5 / 60 Ι. La crescita +100% compensava troppo la perdita di livelli
       (~50-80% del livello perso in 60 Ι su una colonia ben dotata, rendendo
       l'imbarco quasi "gratis"). A +50% il recupero si ferma intorno al
       20-30% nello stesso periodo: il giocatore SENTE la perdita ma non è
       punito (recovery-friendly #22). Combinato col fix B (provviste viaggio
       per livello imbarcato) rende l'imbarco una scelta strategica vera. */
    const nowI = game.timeImpulsi || 0;
    colony.diaspora = {
      startedAt: nowI,
      until: nowI + 60,
      multiplier: 1.5
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
    /* Decisione A (2026-06-15): scioglie restituendo gli asset alla colonia
       dove la flotta è ORMEGGIATA ADESSO (porto corrente), non più solo
       all'origine. Serve una tua colonia nel sistema + flotta non in viaggio. */
    if (fleet.location.status === 'in-transit') {
      return { ok: false, reason: 'La flotta è in viaggio. Ormeggiala a una tua colonia, poi sciogliela.' };
    }
    const colonyKey = ownColonyKeyAt(game, fleet.location.systemId);
    const colony = colonyKey && game.colonies[colonyKey];
    if (!colony) {
      return { ok: false, reason: 'La flotta deve essere ormeggiata a una tua colonia per essere sciolta.' };
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
      ORION.commander.releaseFromFleet(game, fleet, { toColonyKey: colonyKey });
    }
    /* Rimuovi la flotta dal gioco. */
    const idx = (game.fleets || []).indexOf(fleet);
    if (idx >= 0) game.fleets.splice(idx, 1);
    return { ok: true };
  }

  /* ------------------------------------------------------------------
     Gestione flotte in volo (decisione #88) — smistamento/fusione tra
     flotte CO-LOCALIZZATE (stesso sistema, nessuna in viaggio). A
     differenza di assignShips/assignCrew (colonia↔flotta, richiede
     l'attracco alla colonia origine), questi spostano unità FRA due
     entità mobili ovunque si trovino insieme. Zero RNG → determinismo
     (#5); recovery-friendly (#22): nessun fail-state, solo motivi umani.
     ------------------------------------------------------------------ */
  function fleetsCoLocated(a, b) {
    if (!a || !b || a === b) return false;
    if (!a.location || !b.location) return false;
    if (a.location.systemId !== b.location.systemId) return false;
    if (a.location.status === 'in-transit' || b.location.status === 'in-transit') return false;
    return true;
  }

  /* Sposta `count` navi di una classe da una flotta all'altra mantenendo
     l'identità dell'entità (hp/wear/xp/nome → veteranità preservata). */
  function transferShips(game, fromFleet, toFleet, kind, count) {
    if (!fromFleet || !toFleet) return { ok: false, reason: 'Flotta inesistente' };
    if (!fleetsCoLocated(fromFleet, toFleet)) {
      return { ok: false, reason: 'Le flotte devono trovarsi insieme nello stesso sistema (nessuna in viaggio)' };
    }
    if (!CLASSES[kind]) return { ok: false, reason: 'Classe nave sconosciuta' };
    count = Math.max(0, count | 0);
    if (count <= 0) return { ok: false, reason: 'Quantità non valida' };
    let moved = 0;
    for (let i = fromFleet.ships.length - 1; i >= 0 && moved < count; i--) {
      if (fromFleet.ships[i].kind === kind) {
        toFleet.ships.push(fromFleet.ships.splice(i, 1)[0]);
        moved++;
      }
    }
    if (moved === 0) return { ok: false, reason: 'Nessuna nave di quella classe da trasferire' };
    return { ok: true, moved: moved };
  }

  /* Sposta `count` equipaggi (entità con xp) da una flotta all'altra. */
  function transferCrew(game, fromFleet, toFleet, count) {
    if (!fromFleet || !toFleet) return { ok: false, reason: 'Flotta inesistente' };
    if (!fleetsCoLocated(fromFleet, toFleet)) {
      return { ok: false, reason: 'Le flotte devono trovarsi insieme nello stesso sistema (nessuna in viaggio)' };
    }
    count = Math.max(0, count | 0);
    if (count <= 0) return { ok: false, reason: 'Quantità non valida' };
    let moved = 0;
    while (moved < count && fromFleet.crew.length > 0) {
      toFleet.crew.push(fromFleet.crew.shift());
      moved++;
    }
    if (moved === 0) return { ok: false, reason: 'Flotta senza equipaggio da trasferire' };
    return { ok: true, moved: moved };
  }

  /* Fonde `fromFleet` in `toFleet`: navi + equipaggi + coloni + figure
     confluiscono nella destinazione, poi la sorgente è sciolta. La
     destinazione MANTIENE nome, ordine, owner e formazione. Le figure
     eccedenti gli slot della destinazione tornano nel pool d'Impero
     (#72). I viveri prendono il minimo (la flotta unita è rifornita come
     la sua parte peggiore). popOnboard sommato (sicuro: ≤ cap unito,
     additivo per nave coloniale). */
  function mergeFleets(game, fromFleet, toFleet) {
    if (!fromFleet || !toFleet) return { ok: false, reason: 'Flotta inesistente' };
    if (fromFleet === toFleet) return { ok: false, reason: 'Stessa flotta' };
    if (!fleetsCoLocated(fromFleet, toFleet)) {
      return { ok: false, reason: 'Le flotte devono trovarsi insieme nello stesso sistema (nessuna in viaggio)' };
    }
    while (fromFleet.ships.length) toFleet.ships.push(fromFleet.ships.shift());
    if (!Array.isArray(toFleet.crew)) toFleet.crew = [];
    while (fromFleet.crew && fromFleet.crew.length) toFleet.crew.push(fromFleet.crew.shift());
    toFleet.popOnboard = (toFleet.popOnboard || 0) + (fromFleet.popOnboard || 0);
    fromFleet.popOnboard = 0;
    if (typeof fromFleet.viveri === 'number') {
      const tv = (toFleet.viveri != null) ? toFleet.viveri : viveriCapOf(toFleet);
      toFleet.viveri = Math.min(tv, fromFleet.viveri);
    }
    /* Figure: rilascia quelle della sorgente al pool, poi prova a
       riassegnarle alla destinazione (rispetta slot + un bonus/ruolo). Le
       non assegnabili restano in panchina (idle). */
    if (ORION.commander && ORION.commander.officersOf) {
      const C = ORION.commander;
      const fromOff = C.officersOf(fromFleet).slice();
      if (C.releaseAllFromFleet) C.releaseAllFromFleet(game, fromFleet);
      if (C.assignToFleet) fromOff.forEach(function (o) { C.assignToFleet(game, toFleet, o.id); });
    }
    const idx = (game.fleets || []).indexOf(fromFleet);
    if (idx >= 0) game.fleets.splice(idx, 1);
    return { ok: true };
  }

  /* ------------------------------------------------------------------
     setOrder — assegna ordini a una flotta. Valida lo stato e (per gli
     ordini di movimento) calcola la rotta BFS. NON consuma Impulsi: la
     marcia avanza nel tick.
     ------------------------------------------------------------------ */
  function setOrder(game, fleet, order, opts) {
    if (!fleet) return { ok: false, reason: 'Flotta inesistente' };
    if (!order || !order.type) return { ok: false, reason: 'Ordine non valido' };
    if (fleet.ships.length === 0) return { ok: false, reason: 'Flotta vuota' };

    const type = order.type;
    /* Qualunque nuovo ordine annulla l'intento offensivo precedente
       (M09 — decisione #49): re-ordinare una flotta cancella l'attacco. */
    fleet.attackTarget = null;
    /* Stadio 1.4: un ordine MANUALE resetta il piano accodato (la coda
       appartiene al piano precedente). L'avanzamento interno della coda
       passa opts.fromQueue=true per non auto-cancellarsi. */
    if (!opts || !opts.fromQueue) fleet.queue = [];
    /* Stadio 1.6: ogni nuovo ordine apre un nuovo segmento di viaggio →
       riarma il tiro incidente (uno per segmento). Gli ordini intra/idle non
       tireranno comunque (gate in tick: rotta > 1, non intra). */
    fleet._incidentRolled = false;
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
      /* Stadio 1.5 — M2: `move` con bodyKey è una manovra verso un CORPO
         preciso. Inter-sistema: M1 fino al sistema, poi all'arrivo M2 verso
         il corpo (handler d'arrivo). Intra-sistema (to == sistema corrente):
         solo M2. Senza bodyKey resta M1 puro (orbita generica). */
      const bodyKey = (type === 'move' && order.bodyKey != null) ? String(order.bodyKey) : null;
      const currentSys = fleet.location.systemId;
      if (to === currentSys) {
        /* M2 puro (stesso sistema). */
        if (bodyKey == null) {
          /* Già in orbita generica: niente da percorrere. */
          fleet.orders = { type: 'idle' };
          fleet.route = [currentSys]; fleet.routeIdx = 0; fleet.etaImpulsi = 0;
          return { ok: true };
        }
        fleet.orders = { type: 'move', toSysId: to, bodyKey: bodyKey };
        const intraI = intraTravelI(game, fleet, bodyKey);
        if (intraI > 0) {
          beginIntraTransit(game, fleet, bodyKey, intraI);
        } else {
          /* Già al corpo. */
          fleet.route = [currentSys]; fleet.routeIdx = 0;
          fleet.location.status = 'orbiting'; fleet.location.bodyKey = bodyKey;
          fleet.etaImpulsi = 0;
          fleet.orders = { type: 'idle' };
        }
        return { ok: true };
      }
      const path = computePath(game.galaxy, currentSys, to);
      if (!path) return { ok: false, reason: 'Nessuna rotta verso il sistema target' };
      fleet.orders = { type: type, toSysId: to, bodyKey: bodyKey };
      fleet.route = path;
      fleet.routeIdx = 0;
      fleet.etaImpulsi = startNextLeg(game.galaxy, fleet);
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
      /* Intra-sistema: traversata corpo→corpo (se distante), poi ingaggio.
         attackTarget viene impostato all'ARRIVO (processSkirmishes salta le
         flotte in-transit). */
      if (to === currentSys) {
        fleet.orders = { type: 'attack', toSysId: to, bodyKey: bodyKey };
        const intraI = bodyKey != null ? intraTravelI(game, fleet, bodyKey) : 0;
        if (intraI > 0) {
          beginIntraTransit(game, fleet, bodyKey, intraI);
        } else {
          fleet.route = [currentSys];
          fleet.routeIdx = 0;
          fleet.location.status = 'orbiting';
          if (bodyKey) fleet.location.bodyKey = bodyKey;
          fleet.attackTarget = to;
          fleet.attackBodyKey = bodyKey;
          fleet.etaImpulsi = 0;
        }
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
        /* Intra-sistema: traversata corpo→corpo (se distante), poi osserva. */
        const intraI = intraTravelI(game, fleet, bodyKey);
        if (intraI > 0) {
          beginIntraTransit(game, fleet, bodyKey, intraI);
        } else {
          fleet.route = [currentSys];
          fleet.routeIdx = 0;
          fleet.location.status = 'orbiting';
          fleet.location.bodyKey = bodyKey;
          fleet.etaImpulsi = 0;
        }
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

    /* Ordine `survey` (esplorazione/sfruttamento anomalie §17.3, decisione
       di sessione): la flotta raggiunge il SISTEMA dell'anomalia e RESTA in
       orbita. La raccolta (detriti→met / nebulosa→en) e l'esplorazione delle
       reliquie avvengono passivamente in anomaly.tick finché la flotta è
       presente. Nessun bodyKey (l'anomalia non è un corpo). Intra-sistema:
       skip viaggio. Recovery-friendly: nessun rischio nel restare. */
    if (type === 'survey') {
      const to = order.toSysId;
      if (to == null) return { ok: false, reason: 'Sistema target assente' };
      const sys = game.galaxy.systems[to];
      if (!sys) return { ok: false, reason: 'Sistema target inesistente' };
      const currentSys = fleet.location.systemId;
      /* Decisione di sessione: la ricognizione è mirata a UNA anomalia
         specifica (sistema + tipo). Una flotta sui detriti NON drena anche
         la nebulosa dello stesso sistema. `anomalyKind` ∈ detriti/nebulosa/
         reliquie. */
      const baseOrder = { type: 'survey', toSysId: to, anomalyKind: order.anomalyKind || null, bodyKey: order.bodyKey || null };
      if (to === currentSys) {
        fleet.orders = baseOrder;
        fleet.route = [currentSys];
        fleet.routeIdx = 0;
        fleet.location.status = 'orbiting';
        /* Decisione utente 2026-06-16: la flotta sta operando SUL sito —
           se l'anomalia è body-tied (cintura) propaghiamo il bodyKey alla
           location così system-view la disegna sopra il corpo invece che
           in orbita generica. Per detriti/nebulosa/reliquie (no body)
           system-view risolve via orders.anomalyKind. */
        fleet.location.bodyKey = order.bodyKey || null;
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

    /* Stadio 1.5 — ordine `recon` (Ricognizione): la flotta raggiunge il
       sistema (di una civ AI / covo) e RESTA in orbita a costruire il dossier
       (ai.processPresence accumula l'intel per presenza, qualunque ordine; qui
       l'intento è esplicito e impegna la flotta). Opzionale bodyKey per
       ancorarsi a un pianeta AI. Continuativa → step terminale. */
    if (type === 'recon') {
      const to = order.toSysId;
      if (to == null) return { ok: false, reason: 'Sistema target assente' };
      const sys = game.galaxy.systems[to];
      if (!sys) return { ok: false, reason: 'Sistema target inesistente' };
      const currentSys = fleet.location.systemId;
      const bodyKey = order.bodyKey != null ? String(order.bodyKey) : null;
      const baseOrder = { type: 'recon', toSysId: to, bodyKey: bodyKey };
      if (to === currentSys) {
        fleet.orders = baseOrder;
        const intraI = bodyKey != null ? intraTravelI(game, fleet, bodyKey) : 0;
        if (intraI > 0) {
          beginIntraTransit(game, fleet, bodyKey, intraI);
        } else {
          fleet.route = [currentSys]; fleet.routeIdx = 0;
          fleet.location.status = 'orbiting';
          fleet.location.bodyKey = bodyKey;
          fleet.etaImpulsi = 0;
        }
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
      /* Intra-sistema: traversata corpo→corpo (se distante), poi orbit. */
      const intraI = intraTravelI(game, fleet, bodyKey);
      if (intraI > 0) {
        fleet.orders = {
          type: 'colonize', toSysId: to, bodyKey: bodyKey,
          phase: 'travel-intra', orbitI: orbitI, foundationI: foundationI
        };
        beginIntraTransit(game, fleet, bodyKey, intraI);
      } else {
        fleet.orders = {
          type: 'colonize', toSysId: to, bodyKey: bodyKey,
          phase: 'orbit', phaseLeft: orbitI, orbitI: orbitI, foundationI: foundationI
        };
        fleet.route = [currentSys];
        fleet.routeIdx = 0;
        fleet.location.status = 'orbiting';
        fleet.etaImpulsi = 0;
      }
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
      /* Flotta GIÀ nel sistema della colonia origine (rotta a 0 leg):
         ormeggia subito. Senza questo, startNextLeg lascia la flotta
         'orbiting' con ETA 0 e la logica d'arrivo (che fa 'docked') non
         viene mai eseguita → "Rientra" sembra non avere effetto e la
         flotta resta in orbita (bug segnalato 2026-06-15). */
      if (path.length <= 1) {
        /* Bug 2026-06-17: uno scout monouso (1 esploratore + 1 equipaggio)
           riportato/rientrato mentre è GIÀ nel sistema della colonia non
           passava mai dall'handler d'arrivo `return` (che ricuce scafo +
           equipaggio nei counter). Restava ormeggiato come flotta separata,
           invisibile alla sidebar Esplorazione e non riusabile (ripara al
           dock all'infinito). Qui pieghiamo subito lo scout nei counter,
           coerente col fold-back dell'arrivo. Le flotte multi-nave o non-
           esploratore mantengono l'ormeggio in posizione (niente smobilito
           a sorpresa di una flotta da combattimento). */
        const isScout = fleet.ships.length === 1 && fleet.crew.length === 1 &&
          fleet.ships[0] && fleet.ships[0].kind === 'explorer';
        if (isScout) {
          const d = dissolveFleet(game, fleet);
          if (d.ok) return { ok: true, dissolved: true };
        }
        /* Non scout: parcheggia con la cascata (hangar → stazione → orbita). */
        parkAtArrival(game, fleet, fleet.location.systemId);
        fleet.location.intra = null;
        fleet.etaImpulsi = 0;
        return { ok: true };
      }
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
    fleet.location.berth = null;   // in viaggio: nessun posto d'attracco occupato
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
     Incidenti di VIAGGIO (Stadio 1.6 — docs/FLEET_FLOW.md). Generalizza il
     vecchio incidente solo-explore (decisione #60) a QUALSIASI segmento di
     movimento inter-sistema, con rischio PROPORZIONALE agli Ι TOTALI del
     viaggio (non per leg). Un solo tiro per segmento (gated _incidentRolled).
     Le manovre intra-sistema (M2) NON tirano (rischio nullo, sistema noto).
     4 tipologie (50% ritardo / 30% usura / 15% critico / 5% scoperta fortuita).
     RNG deterministico da seed:fleet-incident:<fleet.id> — replay-safe.
     Recovery-friendly (#22): l'avaria critica perde lo scafo ma l'equipaggio
     si salva sempre. (Probabilità tunabili in M20.)
     ------------------------------------------------------------------ */
  const INCIDENT_RISK_PER_I = 0.0035;   // rischio per Ι di viaggio
  const INCIDENT_RISK_MAX = 0.55;       // cap sul rischio per segmento
  function _dangerForTravel(galaxy, fleet) {
    let sysId = (fleet.orders && fleet.orders.toSysId != null)
      ? fleet.orders.toSysId : fleet.location.systemId;
    const s = galaxy && galaxy.systems && galaxy.systems[sysId];
    if (!s) return 0.5;
    return Math.max(0, Math.min(1, (s.danger || 0) / 100));
  }
  function _accidentChanceForTravel(game, fleet, totalI) {
    const d = _dangerForTravel(game.galaxy, fleet);
    /* Rischio ∝ Ι totali, modulato dal danger del bersaglio. */
    let c = INCIDENT_RISK_PER_I * (totalI || 0) * (0.6 + 0.9 * d);
    const xp = (fleet.crew && fleet.crew[0] && fleet.crew[0].xp) || 0;
    c *= 1 - Math.min(0.20, xp * 0.02);
    if (ORION.ai && ORION.ai.pirateThreat && fleet.orders && fleet.orders.toSysId != null) {
      const threat = ORION.ai.pirateThreat(game, fleet.orders.toSysId);
      if (threat > 0) c += threat * 0.15;
    }
    if (ORION.cohesion && ORION.cohesion.expeditionRiskBonus && fleet.orders && fleet.orders.toSysId != null) {
      c += ORION.cohesion.expeditionRiskBonus(game, fleet.orders.toSysId);
    }
    return Math.max(0, Math.min(INCIDENT_RISK_MAX, c));
  }
  function _rollTravelIncident(game, fleet, events) {
    if (fleet._incidentRolled) return;
    fleet._incidentRolled = true;
    if (!ORION.rng || !ORION.rng.makeRng) return;
    const totalI = routeImpulsi(game.galaxy, fleet, fleet.route);
    const rng = ORION.rng.makeRng((game.seed || '') + ':fleet-incident:' + fleet.id + ':' + (game.timeImpulsi || 0));
    const chance = _accidentChanceForTravel(game, fleet, totalI);
    if (rng.float() >= chance) return;
    const danger = _dangerForTravel(game.galaxy, fleet);
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
    if (fleet.viveri == null) fleet.viveri = viveriCapOf(fleet);
    return fleet.viveri;
  }
  /* Capienza serbatoio della flotta (Ι). Lazy-init per save vecchi:
     viveriCap mancante → default 250. */
  function viveriCapOf(fleet) {
    if (!fleet) return VIVERI_CAP;
    if (fleet.viveriCap == null) fleet.viveriCap = VIVERI_CAP;
    return fleet.viveriCap;
  }
  /* Imposta la capienza serbatoio di una flotta (slider UI alla partenza).
     Clampato in [VIVERI_CAP_MIN, VIVERI_CAP_MAX]. Se il nuovo cap è inferiore
     all'autonomia corrente, eccedenza scartata (non si guadagna risorse). */
  function setViveriCap(fleet, cap) {
    if (!fleet) return 0;
    const c = Math.max(VIVERI_CAP_MIN, Math.min(VIVERI_CAP_MAX, Math.round(cap || 0)));
    fleet.viveriCap = c;
    if ((fleet.viveri || 0) > c) fleet.viveri = c;
    return c;
  }
  /* API legacy: ritorna il default globale (per back-compat di chiamanti
     che non hanno una flotta in mano). I nuovi consumer dovrebbero passare
     la flotta a viveriCapOf. */
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
  /* Chiave della tua colonia nel sistema indicato (la prima trovata). Usata
     dalle operazioni "al porto corrente" (decisione A 2026-06-15: una flotta
     si gestisce dove è ormeggiata, non più solo alla colonia d'origine). */
  function ownColonyKeyAt(game, sysId) {
    const cols = game.colonies || {};
    for (const k in cols) {
      const c = cols[k];
      if (c && c.colonized && c.systemId === sysId) return k;
    }
    return null;
  }
  /* Porto amico (rifornimento gratuito) nel sistema indicato? (tua colonia,
     una tua STAZIONE operativa #81, o colonia di AI alleata #51). */
  function isFriendlyPortAt(game, sys) {
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
  /* La flotta è a un porto amico? Una flotta IN VIAGGIO non lo è mai: durante
     un leg `location.systemId` resta sul nodo di partenza (aggiornato solo a
     fine leg) — senza questo guard l'andata da una colonia risulterebbe
     "sempre a un porto" e i viveri non si consumerebbero mai (#69 fix).
     Decisione utente 2026-06-16: una flotta impegnata in un task in-system
     che la inchioda fuori dall'attracco (`survey` su un'anomalia: orbita il
     sito e drena risorse) NON è al porto, anche se il sistema ospita una
     tua colonia. Niente tag "al porto" né auto-refill durante l'estrazione:
     "è decollata, è fuori dalla colonia". */
  function fleetAtFriendlyPort(game, fleet) {
    if (!fleet || !fleet.location) return false;
    if (fleet.location.status === 'in-transit') return false;
    const o = fleet.orders;
    if (o && o.type === 'survey') return false;
    return isFriendlyPortAt(game, fleet.location.systemId);
  }
  /* AI in PACE (non alleata, non in guerra) nel sistema indicato — porto dove
     rifornirsi A PAGAMENTO (valuta regionale M12, #69 follow-up). */
  function payablePortAt(game, sys) {
    if (sys == null || isFriendlyPortAt(game, sys)) return null;
    if (!ORION.ai || !ORION.ai.civForSystem) return null;
    const civ = ORION.ai.civForSystem(game, sys);
    if (civ && (civ.relation === 'peace' || civ.relation === 'truce')) return civ;
    return null;
  }
  /* Rifornisce al cap. A una tua colonia addebita food/acqua dallo stock
     (parziale se a corto, recovery-friendly); porto alleato = gratis. Costo
     di 1 Ι di autonomia = equipaggio × (RATE_FOOD + RATE_WATER). */
  function loadViveriAtPort(game, fleet) {
    const cap = viveriCapOf(fleet);
    const cur = viveriOf(fleet);
    if (cur >= cap) return 0;
    const crew = Math.max(1, fleetCrewRequired(fleet));
    const colony = ownColonyAt(game, fleet.location.systemId);
    let fillI = cap - cur;
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
    if (fleet.viveri == null) fleet.viveri = viveriCapOf(fleet);
    if (fleetAtFriendlyPort(game, fleet)) {
      if (fleet.viveri < viveriCapOf(fleet)) loadViveriAtPort(game, fleet);
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
  /* Usura per Ι in transito (decisione utente 2026-06-16). Sostituisce il
     lump-sum all'arrivo (era +8% + danger*10% solo esploratore). Applicata
     a tutte le navi della flotta in viaggio, scalata sul danger del SISTEMA
     CORRENTE (più realistico: l'ambiente reale che attraversano ora).
     - Skip se in deriva (#69): VIVERI_DRIFT_WEAR è già pesante e copre il caso.
     - Skip se non in transito.
     - Cap 100 come sempre, mai distruzione (recovery-friendly #22). */
  function applyTransitWear(game, fleet) {
    if (!fleet || !fleet.location || fleet.location.status !== 'in-transit') return;
    if (fleet._drift) return;
    if (!Array.isArray(fleet.ships) || !fleet.ships.length) return;
    const sys = game.galaxy && game.galaxy.systems && game.galaxy.systems[fleet.location.systemId];
    const danger = sys ? Math.max(0, Math.min(1, (sys.danger || 0) / 100)) : 0;
    const w = WEAR_TRANSIT_BASE * (1 + danger);
    for (let i = 0; i < fleet.ships.length; i++) {
      fleet.ships[i].wear = Math.min(100, (fleet.ships[i].wear || 0) + w);
    }
  }

  /* Riparazione al porto di una colonia (richiesta utente 2026-06-16,
     gating 2026-06-18). Chiamata dal tick di colonia (time.js) per Ι. Ripara
     SOLO le navi delle flotte attraccate IN HANGAR (berth 'hangar'): in
     orbita-parcheggio si rifornisce ma NON si ripara (richiesta utente). Tasso
     scalato sul livello Hangar; ritorna il costo metalli da scaricare sulla
     stock. Niente refit senza Hangar; niente costo per navi pristine (wear=0). */
  function tickPortRepair(game, colony) {
    if (!colony || !colony.structures || !game) return 0;
    const hangar = colony.structures['cantiere-navale'];
    if (!hangar || (hangar.level | 0) < 1) return 0;
    const lvl = Math.min(hangar.level | 0, REPAIR_RATE_BY_HANGAR.length - 1);
    const rate = REPAIR_RATE_BY_HANGAR[lvl];
    if (rate <= 0) return 0;
    const sysId = colony.systemId;
    let metCost = 0;
    (game.fleets || []).forEach(function (f) {
      if (!f || !f.location || f.location.systemId !== sysId) return;
      if (f.location.status !== 'docked' || berthOf(game, f) !== 'hangar') return;
      (f.ships || []).forEach(function (s) {
        const cur = s.wear || 0;
        if (cur <= 0) return;
        const repaired = Math.min(cur, rate);
        s.wear = cur - repaired;
        metCost += repaired * REPAIR_MET_PER_PCT;
      });
    });
    return metCost;
  }

  /* Riparazione presso una stazione orbitale (M16) operativa di livello ≥ 2.
     Chiamata dal tick stazione (station.js). Ripara SOLO le navi delle flotte
     ATTRACCATE alla stazione (berth 'station'): in orbita-parcheggio niente
     refit (gating 2026-06-18). Tasso fisso; niente costo esposto qui — la
     stazione ha il suo supply pool gestito altrove. */
  function tickStationRepair(game, station) {
    if (!game || !station || station.phase !== 'operational' || (station.level | 0) < 2) return 0;
    const sysId = station.systemId;
    const rate = REPAIR_RATE_STATION;
    let totalRepaired = 0;
    (game.fleets || []).forEach(function (f) {
      if (!f || !f.location || f.location.systemId !== sysId) return;
      if (f.location.status !== 'docked' || berthOf(game, f) !== 'station') return;
      (f.ships || []).forEach(function (s) {
        const cur = s.wear || 0;
        if (cur <= 0) return;
        const repaired = Math.min(cur, rate);
        s.wear = cur - repaired;
        totalRepaired += repaired;
      });
    });
    return totalRepaired;
  }

  /* Soglia wear: trigger di rientro forzato (richiesta utente 2026-06-16).
     Coerente col modello viveri (#69): la flotta si stacca dal task corrente
     (survey/patrol/idle) e rientra al porto amico più vicino. Esposto qui in
     fleet.js così anomaly.js può chiamarlo senza duplicare la logica. */
  function forceReturnForWear(game, fleet) {
    if (!fleet || !fleet.orders || fleet.orders.type === 'return') return false;
    if (!fleet.ships || !fleet.ships.length) return false;
    let maxW = 0;
    for (let i = 0; i < fleet.ships.length; i++) maxW = Math.max(maxW, fleet.ships[i].wear || 0);
    if (maxW < WEAR_RETURN_THRESHOLD) return false;
    maybeForceReturn(game, fleet);
    if (fleet.orders.type === 'return') {
      fleet.orders._forcedWear = true;
      return true;
    }
    return false;
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

  /* Avviso proattivo viveri (#69 follow-up): stima Ι della rotta di un ordine
     vs autonomia corrente + presenza di porti di rifornimento (amici gratis /
     AI in pace a pagamento) lungo il percorso. Ritorna null se non
     applicabile. La stima è di sola andata (advisory; la deriva fail-safe
     garantisce che la flotta non resti mai bloccata, #69). */
  function supplyOutlook(game, fleet, order) {
    if (!order || !fleet || !fleet.location) return null;
    let waypoints = null;
    switch (order.type) {
      case 'move': case 'explore': case 'transfer':
      case 'attack': case 'garrison': case 'colonize': case 'survey': case 'recon':
        if (order.toSysId != null) waypoints = [order.toSysId];
        break;
      case 'move-route': waypoints = order.waypoints || []; break;
      case 'patrol-loop': waypoints = order.loop || []; break;
      case 'patrol': waypoints = [order.sysA, order.sysB]; break;
      default: return null;
    }
    if (!waypoints || !waypoints.length) return null;
    const chain = buildChainedRoute(game.galaxy, fleet.location.systemId, waypoints);
    if (!chain || !chain.ok) return null;
    const sp = fleetMinSpeed(fleet);
    let routeI = 0, refuel = false, payable = false;
    for (let li = 0; li < chain.legs.length; li++) {
      const leg = chain.legs[li];
      for (let i = 1; i < leg.length; i++) {
        routeI += tempoLeg(game.galaxy, leg[i - 1], leg[i], sp);
        if (isFriendlyPortAt(game, leg[i])) refuel = true;
        else if (payablePortAt(game, leg[i])) payable = true;
      }
    }
    const autonomyI = viveriOf(fleet);
    return {
      routeI: Math.round(routeI),
      autonomyI: Math.round(autonomyI),
      enough: routeI <= autonomyI,
      refuelEnRoute: refuel,
      payableEnRoute: payable
    };
  }

  /* Costo in crediti del riempimento al cap presso un porto a pagamento. */
  function payRefuelCost(game, fleet) {
    const fillI = viveriCapOf(fleet) - viveriOf(fleet);
    if (fillI <= 0) return 0;
    const crew = Math.max(1, fleetCrewRequired(fleet));
    const ref = (ORION.treasury && ORION.treasury.REF_PRICE) || { met: 1, en: 0.9, food: 1.4, water: 1.2 };
    const perI = crew * (VIVERI_RATE_FOOD * ref.food + VIVERI_RATE_WATER * ref.water +
                         VIVERI_RATE_MET * ref.met + VIVERI_RATE_EN * ref.en);
    return Math.ceil(perI * fillI * REFUEL_MARKUP);
  }
  /* Rifornimento A PAGAMENTO presso una colonia AI in pace (#69 follow-up):
     paga in crediti (qualunque valuta, treasury.spendCredits) e riempie al
     cap. Azione utente esplicita (mai automatica → niente drain silenzioso). */
  function payRefuelAt(game, fleet) {
    if (!fleet || !fleet.location) return { ok: false, reason: 'Flotta non valida' };
    const civ = payablePortAt(game, fleet.location.systemId);
    if (!civ) return { ok: false, reason: 'Nessun porto in pace in questo sistema' };
    if (!ORION.treasury || !ORION.treasury.spendCredits) return { ok: false, reason: 'Tesoreria non disponibile' };
    if (viveriOf(fleet) >= viveriCapOf(fleet)) return { ok: false, reason: 'Serbatoio già pieno' };
    const cost = payRefuelCost(game, fleet);
    const paid = ORION.treasury.spendCredits(game, cost);
    if (!paid || !paid.ok) return { ok: false, reason: 'Crediti insufficienti (' + cost + ' richiesti)' };
    fleet.viveri = viveriCapOf(fleet);
    fleet._drift = false;
    fleet._supplyWarned = false;
    return { ok: true, cost: cost, civ: civ };
  }

  /* ------------------------------------------------------------------
     Spostamento INTRA-sistema (decisione utente "viaggio reale").
     Quando un ordine intra-sistema (colonize/garrison/attack) ha un corpo
     target diverso da quello corrente, la flotta NON si riposiziona più
     all'istante: percorre una distanza fittizia in Ι (ORION.system.intraImpulsi)
     restando `in-transit` con `location.intra = {fromBodyKey, toBodyKey,
     totalI}`. All'arrivo applica la continuazione dell'ordine (orbit per
     colonize, ingaggio per attack, osservazione per garrison).
     Lazy/additivo su fleet.location → nessun bump di schema.
     ------------------------------------------------------------------ */
  function fleetCurrentBodyKey(game, fleet) {
    if (fleet.location && fleet.location.bodyKey != null) return fleet.location.bodyKey;
    /* docked alla colonia origine → il corpo della colonia. */
    if (fleet.location && fleet.location.status === 'docked' && fleet.ownerColonyKey != null) {
      const parts = String(fleet.ownerColonyKey).split(':');
      if (parts.length === 2 && parseInt(parts[0], 10) === fleet.location.systemId) return parts[1];
    }
    return null;   // orbita generica del sistema → la stella (centro)
  }
  function intraTravelI(game, fleet, toBodyKey) {
    if (!ORION.system || !ORION.system.intraImpulsi || !ORION.system.generate) return 0;
    const sys = ORION.system.generate(game.galaxy, fleet.location.systemId);
    const fromBk = fleetCurrentBodyKey(game, fleet);
    return ORION.system.intraImpulsi(sys, fromBk, toBodyKey);
  }
  function beginIntraTransit(game, fleet, toBodyKey, intraI) {
    const sysId = fleet.location.systemId;
    fleet.location.intra = {
      systemId: sysId,
      fromBodyKey: fleetCurrentBodyKey(game, fleet),
      toBodyKey: toBodyKey,
      totalI: intraI
    };
    fleet.location.status = 'in-transit';
    fleet.route = [sysId];
    fleet.routeIdx = 0;
    fleet.etaImpulsi = intraI;
  }
  function arriveIntra(game, fleet, events) {
    const intra = fleet.location.intra;
    const order = fleet.orders || {};
    const sysId = fleet.location.systemId;
    const toBk = (intra && intra.toBodyKey != null) ? intra.toBodyKey :
                 (order.bodyKey != null ? order.bodyKey : null);
    fleet.location.bodyKey = toBk;
    fleet.location.intra = null;
    fleet.location.status = 'orbiting';
    fleet.etaImpulsi = 0;
    fleet.route = [sysId];
    fleet.routeIdx = 0;
    events.push({
      kind: 'fleet-arrived',
      fleetId: fleet.id, fleetName: fleet.name,
      systemId: sysId, bodyKey: toBk,
      impulso: game.timeImpulsi
    });
    if (order.type === 'colonize') {
      order.phase = 'orbit';
      order.phaseLeft = order.orbitI || COLONIZE_ORBIT_DURATION;
      events.push({
        kind: 'fleet-colonize-orbit',
        fleetId: fleet.id, fleetName: fleet.name,
        systemId: sysId, bodyKey: toBk,
        impulso: game.timeImpulsi
      });
    } else if (order.type === 'attack') {
      fleet.attackTarget = sysId;
      fleet.attackBodyKey = toBk;
    } else if (order.type === 'move') {
      /* Stadio 1.5 — M2 completata: la flotta orbita il corpo, step concluso
         → idle (la coda può avanzare). */
      fleet.orders = { type: 'idle' };
    }
    /* garrison/survey/recon: resta orbiting, l'ordine prosegue attivo. */
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
    /* Usura per Ι in transito (decisione utente 2026-06-16): drip uniforme su
       tutte le classi, scalato sul danger del sistema. Sostituisce il lump-sum
       all'arrivo dell'esploratore (rimosso più sotto). */
    applyTransitWear(game, fleet);
    if (fleet.orders.type === 'idle') {
      /* Stadio 1.4: la flotta è "settled" (fine di uno step non continuativo).
         Se c'è una coda, applica il prossimo step (M1→M2→azione). Gli ordini
         continuativi (survey/garrison/colonize) non passano da idle → restano
         terminali e la coda non avanza, come da design. */
      if (Array.isArray(fleet.queue) && fleet.queue.length) {
        applyNextQueued(game, fleet, events);
      }
      return;
    }

    /* Stadio 1.6: rischio di viaggio ∝ Ι totali, una sola volta per segmento
       INTER-sistema (rotta > 1, non per leg). Le manovre intra (location.intra)
       e le soste non tirano. Vale per qualsiasi ordine di movimento. */
    if (!fleet._incidentRolled && fleet.location &&
        fleet.location.status === 'in-transit' && !fleet.location.intra &&
        Array.isArray(fleet.route) && fleet.route.length > 1) {
      _rollTravelIncident(game, fleet, events);
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

    /* Spostamento INTRA-sistema (decisione utente): countdown della
       traversata corpo→corpo; all'arrivo applica la continuazione dell'ordine. */
    if (fleet.location.status === 'in-transit' && fleet.location.intra) {
      accrueTravelXp(game, fleet, events);
      fleet.etaImpulsi = (fleet.etaImpulsi || 0) - 1;
      if (fleet.etaImpulsi > 0) return;
      arriveIntra(game, fleet, events);
      return;
    }

    if (fleet.location.status !== 'in-transit') {
      /* docked o orbiting senza dwell: nulla da avanzare; gli ordini "arrived"
         sono gestiti immediatamente da setOrder o dal completamento del leg. */
      return;
    }
    accrueTravelXp(game, fleet, events);
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
        fleet.queue = [];   /* Stadio 1.4: scarta il piano residuo: ridecidi dopo lo scontro. */
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
      /* Stadio 1.5 — M1+M2 in un solo `move`: se l'ordine porta un bodyKey e
         il sistema NON è una tua colonia, l'arrivo (M1 completato) avvia la
         manovra intra verso il corpo (M2). L'ordine resta `move`: arriveIntra
         lo chiude a idle quando raggiunge il corpo. */
      if (order.type === 'move' && order.bodyKey != null && !ownColonyAt(game, arrivedAt)) {
        const intraI = intraTravelI(game, fleet, order.bodyKey);
        events.push({
          kind: 'fleet-arrived', fleetId: fleet.id, fleetName: fleet.name,
          systemId: arrivedAt, bodyKey: null, impulso: game.timeImpulsi
        });
        if (intraI > 0) {
          beginIntraTransit(game, fleet, order.bodyKey, intraI);
        } else {
          fleet.location.status = 'orbiting';
          fleet.location.bodyKey = order.bodyKey;
          fleet.etaImpulsi = 0; fleet.route = [arrivedAt]; fleet.routeIdx = 0;
          fleet.orders = { type: 'idle' };
        }
        return;
      }
      /* L'attacco mantiene `fleet.attackTarget` (+ opzionale
         `fleet.attackBodyKey`): all'arrivo la flotta orbita e
         processSkirmishes ingaggia il bersaglio al tick successivo. */
      /* Decisione A (2026-06-15): un `move` che arriva a un sistema con una
         TUA colonia ci si ORMEGGIA — la flotta non "appartiene" più alla sola
         colonia d'origine: atterra dove la mandi (riusa `move`, niente nuovi
         ordini). L'attacco resta in orbita per ingaggiare al tick successivo. */
      if (order.type === 'move' &&
          (ownColonyAt(game, arrivedAt) || operationalStationAt(game, arrivedAt))) {
        /* Cascata di parcheggio: hangar → stazione → orbita (vedi parkAtArrival). */
        parkAtArrival(game, fleet, arrivedAt);
      } else {
        fleet.location.status = 'orbiting';
        fleet.location.berth = null;
        if (order.type === 'attack' && order.bodyKey) {
          fleet.location.bodyKey = order.bodyKey;
        }
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

    /* Stadio 1.5 — arrivo `recon`: orbita e RESTA attivo; l'intel/dossier si
       accumula per presenza (ai.processPresence). bodyKey opzionale (ancora
       a un pianeta AI). Terminale: la coda non avanza. */
    if (order.type === 'recon') {
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
      /* L'ordine recon rimane attivo. */
      return;
    }

    /* Arrivo `survey`: la flotta entra in orbita e RESTA (l'ordine non torna
       a idle), così anomaly.tick continua a raccogliere/esplorare il sito. */
    if (order.type === 'survey') {
      _autoRevealAt(arrivedAt);
      fleet.location.status = 'orbiting';
      /* Vedi nota in setOrder/survey: propaga il bodyKey per ancorare la
         flotta al corpo dell'anomalia in system-view (cintura) — per
         anomalie non body-tied resta null e il render usa anomalyKind. */
      fleet.location.bodyKey = order.bodyKey || null;
      fleet.etaImpulsi = 0;
      fleet.route = [arrivedAt];
      fleet.routeIdx = 0;
      events.push({
        kind: 'fleet-arrived',
        fleetId: fleet.id, fleetName: fleet.name,
        systemId: arrivedAt,
        impulso: game.timeImpulsi
      });
      /* L'ordine survey rimane attivo. */
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
      /* Bonus "speciale" (ricalibrazione 2026-06-15, richiesta utente):
         l'esplorazione si premia al MOMENTO DELLA SCOPERTA (raggiunto +
         rivelato il target), CON O SENZA ritorno. Niente doppio conteggio:
         il rientro non riassegna più questo +1 (vedi handler `return`).
         awardCrewXp tiene il servizio 'travel' → ruolo Ingegnere alla
         promozione, coerente col vecchio roleHint 'ingegnere'. */
      if (!fleet._exploreRewarded) {
        fleet._exploreRewarded = true;
        awardCrewXp(game, fleet, 1, events, 'travel');
      }
      /* Sessione 2026-06-16: il lump-sum di usura all'arrivo (era +8% +
         danger*10% sull'esploratore) è stato sostituito dal drip per Ι in
         transito (applyTransitWear). Equivalente totale su un viaggio tipico
         di ~20-40 Ι, ma proporzionale alla DURATA REALE del viaggio e
         uniforme per tutte le classi (esploratore/estrattore/militari). */
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
        /* xp dell'esplorazione già assegnato all'ARRIVO (scoperta), con o
           senza ritorno (ricalibrazione 2026-06-15) → niente +1 qui, era
           doppio conteggio. Il viaggio di rientro matura già via
           accrueTravelXp tick-per-tick. */
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
      /* Flotta non-scout in rientro: parcheggia con la cascata di capacità
         (hangar → stazione → orbita). Se non c'è un tuo porto qui resta in
         orbita generica (parkAtArrival → berth null). */
      parkAtArrival(game, fleet, arrivedAt);
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
      /* Ricalibrazione 2026-06-15: l'xp di una rotta a tappe matura ora dal
         TEMPO di volo (accrueTravelXp tick-per-tick) — una rotta lunga
         accumula naturalmente più xp. Rimosso il bonus-milestone a fine
         rotta (era un surrogato del viaggio, ora ridondante). */
      finishCompound(game, fleet, events, 'route-complete');
      return;
    }

    if (order.type === 'patrol-loop') {
      order.loopIdx = (order.loopIdx + 1) % order.loop.length;
      /* Ricalibrazione 2026-06-15: l'xp della pattuglia matura dal TEMPO di
         volo (accrueTravelXp, taggato 'tactical' → Stratega). Rimosso il
         bonus a fine-giro: ora pattugliare a lungo paga continuamente. */
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
    const sysId = fleet.location.systemId;
    /* Se la rotta termina su un tuo porto, applica la cascata di parcheggio
       (hangar → stazione → orbita); altrimenti orbita generica. */
    if (ownColonyAt(game, sysId) || operationalStationAt(game, sysId)) {
      parkAtArrival(game, fleet, sysId);
    } else {
      fleet.location.status = 'orbiting';
      fleet.location.berth = null;
    }
    fleet.etaImpulsi = 0;
    fleet.route = [sysId];
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

  /* Esperienza da viaggio (ricalibrazione 2026-06-15): accumula gli Ι
     trascorsi in volo sulla flotta; ogni TRAVEL_XP_EVERY → +1 xp a tutto
     l'equipaggio (via awardCrewXp, che gestisce svc/ranghi/promozione).
     Chiamata a ogni tick in cui la flotta è in-transit (1 Ι di volo).
     `_travelI` persiste nel save (game.fleets serializzato wholesale) →
     l'accumulo parziale non si azzera a save/load. */
  function accrueTravelXp(game, fleet, events) {
    if (!fleet || !Array.isArray(fleet.crew) || !fleet.crew.length) return;
    fleet._travelI = (fleet._travelI || 0) + 1;
    if (fleet._travelI < TRAVEL_XP_EVERY) return;
    /* Tag del servizio (#75 emergenza-ruolo): pattugliare → 'tactical'
       (Stratega), il resto del volo → 'travel' (Ingegnere). Il combattimento
       resta separato (awardCrewXp 'combat' da time.js → Comandante). */
    const ot = fleet.orders && fleet.orders.type;
    const kind = (ot === 'patrol' || ot === 'patrol-loop') ? 'tactical' : 'travel';
    while (fleet._travelI >= TRAVEL_XP_EVERY) {
      fleet._travelI -= TRAVEL_XP_EVERY;
      awardCrewXp(game, fleet, 1, events, kind);
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
  /* Bilanciamento 2026-06-16: variante energia. Solo le capitali (incrociatore/
     dreadnought/ammiraglia) hanno maintEn; le altre 0. Specchio di
     dockedMaintenance per simmetria, niente cambio di API esistente. */
  function dockedMaintenanceEn(colony) {
    if (!colony || !colony.ships) return 0;
    let en = 0;
    Object.keys(colony.ships).forEach(function (kind) {
      const n = colony.ships[kind] | 0;
      const cls = CLASSES[kind];
      if (n > 0 && cls && cls.maintEn) en += n * cls.maintEn;
    });
    return en;
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
  /* Bilanciamento 2026-06-16: variante energia di portMaintenance.
     Specchio identico, ma somma maintEn (presente solo su capitali). */
  function portMaintenanceEn(game, colony) {
    let en = dockedMaintenanceEn(colony);
    const sys = colony && colony.systemId;
    if (game && Array.isArray(game.fleets) && sys != null) {
      game.fleets.forEach(function (f) {
        if (!f || !f.location || f.location.systemId !== sys) return;
        const st = f.location.status;
        if (st !== 'docked' && st !== 'orbiting') return;
        (f.ships || []).forEach(function (s) {
          const cls = CLASSES[s.kind];
          if (cls && cls.maintEn) en += cls.maintEn;
        });
      });
    }
    return en;
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

  /* ==================================================================
     STADIO 1 — Modello comandi (fonte di verità: docs/FLEET_FLOW.md)
     Funzioni PURE e additive: non cambiano il comportamento esistente,
     sono consumate da UI (modal) e mappa per offrire/validare gli step.
     ================================================================== */

  /* La flotta può estrarre (rate > 0)? Estrattore = rate pieno, esploratore
     = fallback minimo. Le reliquie non richiedono nulla (per presenza). */
  function fleetHasExtractor(fleet) {
    if (!fleet || !Array.isArray(fleet.ships)) return false;
    for (let i = 0; i < fleet.ships.length; i++) {
      const k = fleet.ships[i] && fleet.ships[i].kind;
      if (k === 'estrattore' || k === 'explorer') return true;
    }
    return false;
  }

  /* Etichetta di stato derivata (fleetStance) da (status, bodyKey, orders,
     composizione). Niente nuovo campo persistito: pura derivazione. Il nome
     del corpo lo aggiunge il chiamante (questa funzione non tocca la galassia).
       code ∈ port | transit | extracting | recon | defending | orbiting | holding */
  const STANCE_LABEL = {
    port: 'In porto',
    transit: 'In viaggio',
    extracting: 'In estrazione',
    recon: 'In ricognizione',
    defending: 'In difesa',
    orbiting: 'In orbita',
    holding: 'In sosta'
  };
  function fleetStance(fleet) {
    if (!fleet || !fleet.location) return { code: 'holding', label: STANCE_LABEL.holding, bodyKey: null };
    const loc = fleet.location;
    const ord = fleet.orders || {};
    const body = loc.bodyKey || null;
    if (loc.status === 'docked') return { code: 'port', label: STANCE_LABEL.port, bodyKey: body };
    if (loc.status === 'in-transit') return { code: 'transit', label: STANCE_LABEL.transit, bodyKey: null };
    /* orbiting */
    if (ord.type === 'survey' || ord.type === 'estrai') return { code: 'extracting', label: STANCE_LABEL.extracting, bodyKey: body };
    if (ord.type === 'recon') return { code: 'recon', label: STANCE_LABEL.recon, bodyKey: body };
    if (body) {
      if (fleetHasGunsLocal(fleet)) return { code: 'defending', label: STANCE_LABEL.defending, bodyKey: body };
      return { code: 'orbiting', label: STANCE_LABEL.orbiting, bodyKey: body };
    }
    return { code: 'holding', label: STANCE_LABEL.holding, bodyKey: null };
  }

  /* M2 (manovra intra-sistema verso un corpo) è proponibile solo se il
     sistema di destinazione è ESPLORATO: senza, i corpi non sono noti
     (gate di conoscenza). Un sistema solo *detected* accetta solo M1. */
  function canTargetBody(target) {
    return !!(target && target.explored);
  }

  /* actionsFor — la tabella master in codice. Funzione PURA di un
     descrittore NORMALIZZATO del bersaglio (lo costruisce il chiamante dai
     sottosistemi vivi) + flotta. Ritorna le Azioni di 3° livello con il loro
     stato di disponibilità (gateFlotta soddisfatto o no) senza filtrarle, così
     l'UI può mostrarle disabilitate con la motivazione.
       target = {
         kind,         // 'system'|'planet'|'moon'|'anomaly'|'nest'|'body'
         explored,     // sistema esplorato?
         ownColony,    // è una TUA colonia?
         colonizable,  // colonizzabile e libero?
         giacimento,   // corpo sfruttabile (Estrai)?
         anomalyKind,  // 'detriti'|'nebulosa'|'reliquie'|null
         aiPresent,    // civ AI occupante (attaccabile/reconnabile)
         aiAlly        // alleato (Difendi alleato — futura)
       }
     Ritorna [{ id, available, gate, future }] in ordine di default suggerito. */
  function actionsFor(target, fleet) {
    const out = [];
    if (!target) return out;
    const armed = fleetHasGunsLocal(fleet);
    const colonial = fleetHasColonial(fleet);
    const extractor = fleetHasExtractor(fleet);

    if (target.ownColony) {
      out.push({ id: 'dock', available: true, gate: null, future: false });
    }
    if (target.colonizable) {
      out.push({ id: 'colonize', available: colonial, gate: 'coloniale', future: false });
    }
    if (target.giacimento || target.anomalyKind) {
      const reliquie = target.anomalyKind === 'reliquie';
      out.push({ id: 'extract', available: reliquie ? true : extractor, gate: reliquie ? null : 'estrattore', future: false });
    }
    if (target.aiPresent || target.kind === 'nest') {
      out.push({ id: 'attack', available: armed, gate: 'fuoco', future: false });
    }
    if (target.aiPresent || target.aiAlly || target.kind === 'nest') {
      out.push({ id: 'recon', available: true, gate: null, future: false });
    }
    if (target.aiAlly) {
      out.push({ id: 'defend-ally', available: armed, gate: 'fuoco', future: true });
    }
    return out;
  }

  /* ------------------------------------------------------------------
     Stadio 1.4 — Coda comandi (fleet.queue). Step accodati manualmente
     che si applicano uno alla volta quando la flotta è "settled" (idle).
     Avanzamento agganciato in `tick` (hook idle). Editabile/interrompibile
     solo agli snodi (la flotta è ferma quando si avanza). Additivo/lazy:
     nessun campo nuovo nel save, guardie Array.isArray ovunque.
     ------------------------------------------------------------------ */
  function applyNextQueued(game, fleet, events) {
    if (!fleet || !Array.isArray(fleet.queue) || !fleet.queue.length) return false;
    const step = fleet.queue.shift();
    const r = setOrder(game, fleet, step, { fromQueue: true });
    if (!r.ok) {
      /* Step non più valido (mondo cambiato): degrada con grazia e scarta la
         coda residua (recovery-friendly #22) invece di fallire a freddo. */
      fleet.queue = [];
      if (events) events.push({
        kind: 'fleet-queue-aborted', fleetId: fleet.id, fleetName: fleet.name,
        reason: r.reason || null,
        systemId: fleet.location ? fleet.location.systemId : null,
        impulso: game.timeImpulsi || 0
      });
      return false;
    }
    if (events) events.push({
      kind: 'fleet-queue-advance', fleetId: fleet.id, fleetName: fleet.name,
      orderType: step.type,
      systemId: fleet.location ? fleet.location.systemId : null,
      impulso: game.timeImpulsi || 0
    });
    return true;
  }

  /* Imposta un PIANO: il primo step parte subito (setOrder, che resetta la
     coda preesistente), il resto va in coda. steps = [orderSpec, ...]. */
  function setPlan(game, fleet, steps) {
    if (!fleet) return { ok: false, reason: 'Flotta inesistente' };
    if (!Array.isArray(steps) || !steps.length) return { ok: false, reason: 'Piano vuoto' };
    const r = setOrder(game, fleet, steps[0]);
    if (!r.ok) return r;
    fleet.queue = steps.slice(1);
    return { ok: true };
  }
  function enqueueOrder(fleet, step) {
    if (!fleet || !step || !step.type) return { ok: false, reason: 'Step non valido' };
    if (!Array.isArray(fleet.queue)) fleet.queue = [];
    fleet.queue.push(step);
    return { ok: true };
  }
  function clearQueue(fleet) { if (fleet) fleet.queue = []; }

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
    addNewShip: addNewShip,
    unassignShips: unassignShips,
    assignCrew: assignCrew,
    assignCrewById: assignCrewById,
    unassignCrew: unassignCrew,
    dissolveFleet: dissolveFleet,
    /* Gestione flotte in volo (#88). */
    fleetsCoLocated: fleetsCoLocated,
    transferShips: transferShips,
    transferCrew: transferCrew,
    mergeFleets: mergeFleets,
    setOrder: setOrder,
    /* Stadio 1.4 — coda comandi (docs/FLEET_FLOW.md). */
    setPlan: setPlan,
    enqueueOrder: enqueueOrder,
    clearQueue: clearQueue,
    applyNextQueued: applyNextQueued,
    tick: tick,
    awardCrewXp: awardCrewXp,
    fleetUpkeep: fleetUpkeep,
    dockedMaintenance: dockedMaintenance,
    dockedMaintenanceEn: dockedMaintenanceEn,
    portMaintenance: portMaintenance,
    portMaintenanceEn: portMaintenanceEn,
    tickPortRepair: tickPortRepair,
    tickStationRepair: tickStationRepair,
    forceReturnForWear: forceReturnForWear,
    /* Posti d'attracco / parcheggio (decisione utente 2026-06-18). */
    berthOf: berthOf,
    berthLabel: berthLabel,
    parkAtArrival: parkAtArrival,
    dockWeightOfFleet: dockWeightOfFleet,
    hangarBerthCapacity: hangarBerthCapacity,
    stationBerthCapacity: stationBerthCapacity,
    operationalStationAt: operationalStationAt,
    STATION_BERTH_CAP_BY_LEVEL: STATION_BERTH_CAP_BY_LEVEL,
    WEAR_TRANSIT_BASE: WEAR_TRANSIT_BASE,
    WEAR_RETURN_THRESHOLD: WEAR_RETURN_THRESHOLD,
    REPAIR_RATE_BY_HANGAR: REPAIR_RATE_BY_HANGAR,
    REPAIR_MET_PER_PCT: REPAIR_MET_PER_PCT,
    REPAIR_RATE_STATION: REPAIR_RATE_STATION,
    ensureColonyShipKinds: ensureColonyShipKinds,
    ownColonyKeyAt: ownColonyKeyAt,
    FORMATIONS: FORMATIONS,
    setFormation: setFormation,
    fleetHasColonial: fleetHasColonial,
    fleetHasExtractor: fleetHasExtractor,
    /* M18.x — sensori/radar (flotte ambientali AI). */
    shipSensor: shipSensor,
    fleetSensor: fleetSensor,
    SENSOR_BY_CLASS: SENSOR_BY_CLASS,
    /* Stadio 1 — modello comandi (docs/FLEET_FLOW.md). */
    fleetStance: fleetStance,
    canTargetBody: canTargetBody,
    actionsFor: actionsFor,
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
    viveriCapOf: viveriCapOf,
    setViveriCap: setViveriCap,
    VIVERI_CAP_MIN: VIVERI_CAP_MIN,
    VIVERI_CAP_MAX: VIVERI_CAP_MAX,
    VIVERI_RATE_FOOD: VIVERI_RATE_FOOD,
    VIVERI_RATE_WATER: VIVERI_RATE_WATER,
    VIVERI_RATE_MET: VIVERI_RATE_MET,
    VIVERI_RATE_EN: VIVERI_RATE_EN,
    viveriOf: viveriOf,
    viveriStatus: viveriStatus,
    fleetAtFriendlyPort: fleetAtFriendlyPort,
    loadViveriAtPort: loadViveriAtPort,
    routeImpulsi: routeImpulsi,
    viveriNextEventDelta: viveriNextEventDelta,
    /* Spostamento intra-sistema (decisione utente): stima Ι corpo→corpo. */
    intraTravelI: intraTravelI,
    fleetCurrentBodyKey: fleetCurrentBodyKey,
    isFriendlyPortAt: isFriendlyPortAt,
    payablePortAt: payablePortAt,
    supplyOutlook: supplyOutlook,
    payRefuelCost: payRefuelCost,
    payRefuelAt: payRefuelAt
  };
})(typeof window !== 'undefined' ? window : this);
