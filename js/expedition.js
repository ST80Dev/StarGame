/* =====================================================================
   ORION EMPIRES — expedition.js
   Capacità di Hangar (scafi, attracchi) e Accademia (equipaggi), bonus
   tecnologici di velocità, arricchimento per esperienza equipaggio, razioni
   al porto (M07/#37, #41, #69).

   Le spedizioni vere e proprie sono flotte con ordine 'explore' (decisione
   #60, fleet.js). Il vecchio motore spedizioni M07 (game.expeditions, tick,
   incidenti a fasce) è stato rimosso nella Revisione 2026.
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  /* --- Costanti di bilanciamento (decisione #37) --- */
  /* Costi/tempi di Hangar e Accademia (letti anche da planet.js e main.js).
     Le costanti di viaggio/incidente del vecchio modello M07 sono state
     rimosse (Revisione 2026): il modello reale vive in fleet.js. */
  const CFG = {
    SHIP_COST:  { met: 25, en: 12 },
    SHIP_TIME:  10,            // I per costruire 1 scafo in Hangar
    CREW_COST:  { food: 12, water: 6 },
    CREW_TIME:  12             // I per formare 1 equipaggio in Accademia
  };

  /* Contatore in-process per id unici di spedizione. Persiste solo per la
     sessione di runtime; gli id già emessi vivono in game.expeditions[]. */
  let _expCounter = 0;


  const clamp = root.ORION.util.clamp;

  /* xp medio di una lista di equipaggi */
  function averageXp(crews) {
    if (!Array.isArray(crews) || !crews.length) return 0;
    let s = 0;
    for (let i = 0; i < crews.length; i++) s += (crews[i].xp || 0);
    return s / crews.length;
  }


  /* ------------------------------------------------------------------
     Capacità Hangar (decisione #41)
     Il Hangar di costruzione fornisce due cap distinte, cumulative su
     tutti gli hangar costruiti sulla colonia:
       - cantieri (build paralleli)
       - attracchi (porto planetario a terra)
     I valori vivono in structures.js → cantiere-navale.hangarCapacity.
     I porti stellari in orbita (M16) daranno cap molto più alta.
     ------------------------------------------------------------------ */
  function hangarCapTable(kind) {
    const S = root.ORION && root.ORION.structures;
    const def = S && S.get('cantiere-navale');
    const hc = def && def.hangarCapacity;
    if (hc && Array.isArray(hc[kind])) return hc[kind];
    // fallback per test headless senza catalogo caricato
    return kind === 'buildSlots' ? [2, 3, 4, 5, 7] : [4, 8, 13, 18, 25];
  }
  function _capForLevel(table, level) {
    const L = Math.max(1, level | 0);
    return table[Math.min(L, table.length) - 1] || 0;
  }
  /* M15 — il Bacino di costruzione aggiunge capacità (cantieri + attracchi) per
     le navi grandi, SOMMATA all'Hangar (#41). Letta dal proprio hangarCapacity. */
  function bacinoCap(colony, kind) {
    const ent = colony && colony.structures && colony.structures['bacino-orbitale'];
    if (!ent) return 0;
    const S = root.ORION && root.ORION.structures;
    const def = S && S.get('bacino-orbitale');
    const hc = def && def.hangarCapacity;
    const table = (hc && Array.isArray(hc[kind])) ? hc[kind] : (kind === 'buildSlots' ? [1, 2] : [12, 24]);
    return _capForLevel(table, ent.level || 1);
  }
  /* M16 — il Porto orbitale aggiunge SOLO attracchi (surplus di posti),
     sommati a Hangar+Bacino. Non costruisce: niente buildSlots. */
  function portoCap(colony, kind) {
    if (kind !== 'docks') return 0;
    const ent = colony && colony.structures && colony.structures['porto-orbitale'];
    if (!ent) return 0;
    const S = root.ORION && root.ORION.structures;
    const def = S && S.get('porto-orbitale');
    const hc = def && def.hangarCapacity;
    const table = (hc && Array.isArray(hc.docks)) ? hc.docks : [8, 14, 22, 32, 44];
    return _capForLevel(table, ent.level || 1);
  }
  function hangarBuildSlots(colony) {
    const ent = colony && colony.structures && colony.structures['cantiere-navale'];
    let n = ent ? _capForLevel(hangarCapTable('buildSlots'), ent.level || 1) : 0;
    return n + bacinoCap(colony, 'buildSlots');
  }
  function hangarDockCapacity(colony) {
    const ent = colony && colony.structures && colony.structures['cantiere-navale'];
    let n = ent ? _capForLevel(hangarCapTable('docks'), ent.level || 1) : 0;
    return n + bacinoCap(colony, 'docks') + portoCap(colony, 'docks');
  }
  /* Posti d'attracco TOTALI a casa (decisione utente 2026-06-18): attracchi
     (docks) + cantieri (buildSlots). Le navi IN COSTRUZIONE prenotano il loro
     posto contro questo totale (es. Hangar lvl 1 → 4 + 2 = 6). I cantieri
     restano comunque il limite delle build CONTEMPORANEE (hangarBuildSlots).
     Unica fonte di verità per il "porto": canBuildShip, overflow spedizioni,
     UI e parcheggio flotte (fleet.parkAtArrival) usano tutti questo valore. */
  function hangarBerthCapacity(colony) {
    return hangarDockCapacity(colony) + hangarBuildSlots(colony);
  }
  /* Peso d'attracco di una classe nave (#41 → M15): le capitali pesano più
     di 1. Fallback 1 se ORION.fleet non è caricato (test headless). */
  function shipDockWeight(kind) {
    const F = root.ORION && root.ORION.fleet;
    return (F && F.dockWeightOf) ? F.dockWeightOf(kind) : 1;
  }
  function activeShipBuilds(colony) {
    return (colony && colony.assets && Array.isArray(colony.assets.shipQueue))
      ? colony.assets.shipQueue.length : 0;
  }
  /* ------------------------------------------------------------------
     Capacità Accademia (decisione utente 2026-06-11)
     L'Accademia limita gli equipaggi in ADDESTRAMENTO CONTEMPORANEO in
     base al suo livello (specchio dei cantieri Hangar #41). I valori
     vivono in structures.js → accademia-militare.trainingSlots.
     ------------------------------------------------------------------ */
  function academyCapTable() {
    const S = root.ORION && root.ORION.structures;
    const def = S && S.get('accademia-militare');
    const ts = def && def.trainingSlots;
    if (Array.isArray(ts)) return ts;
    return [1, 2, 3, 4, 5]; // fallback per test headless senza catalogo
  }
  function academyTrainSlots(colony) {
    const ent = colony && colony.structures && colony.structures['accademia-militare'];
    if (!ent) return 0;
    return _capForLevel(academyCapTable(), ent.level || 1);
  }
  function activeCrewBuilds(colony) {
    return (colony && colony.assets && Array.isArray(colony.assets.crewQueue))
      ? colony.assets.crewQueue.length : 0;
  }
  /* Si può accodare un nuovo equipaggio? Gate sul livello d'Accademia
     (recovery-friendly #22: motivo umano, niente fail-state). */
  function canBuildCrew(colony) {
    const slots = academyTrainSlots(colony);
    if (slots <= 0) return { ok: false, reason: 'Accademia militare non costruita' };
    const active = activeCrewBuilds(colony);
    if (active >= slots) {
      return { ok: false, reason: 'Accademia satura: ' + active + '/' + slots + ' addestramenti in corso (potenzia l\'Accademia)' };
    }
    return { ok: true };
  }
  /* Cantieri occupati = scafi in coda + mercantili in coda (decisione #41 +
     #56). I mercantili condividono i cantieri di costruzione con gli scafi
     (ma NON gli attracchi: vivono in colony.mercantili, fuori da colony.ships).
     canBuildShip/canBuildMercantile devono contarli ENTRAMBI contro i cantieri,
     altrimenti varare un mercantile e uno scafo nello stesso Hangar lvl 1
     (1 cantiere) sfora il limite in modo asimmetrico. */
  function activeMercBuilds(colony) {
    return (colony && colony.assets && Array.isArray(colony.assets.mercantileQueue))
      ? colony.assets.mercantileQueue.length : 0;
  }
  function activeCantieriUse(colony) {
    return activeShipBuilds(colony) + activeMercBuilds(colony);
  }
  /* Navi totali "afferenti" alla colonia: docked + in coda. EMENDA #41 (decisione #69): le navi DISPIEGATE in flotta
     liberano l'attracco e lasciano i libri della colonia natale — sono già
     fuori dal counter `colony.ships` (rimosse da assignShips) e fuori da
     game.expeditions (migrazione #60). Quindi l'attracco conta solo le navi
     A CASA (a terra + in costruzione): costruisci e dispieghi liberamente,
     senza ritrovarti la nave "sul conto" della colonia che l'ha costruita.
     Il limite "quanta flotta posso permettermi"
     vive ora nel sostentamento (viveri #69 + equipaggi + usura). */
  function totalShipsBound(game, colony, colonyKey) {
    /* M15: conteggio PESATO per attracco (le capitali pesano dockWeight>1)
       su TUTTE le classi a terra, non solo gli explorer. */
    let docked = 0;
    const ships = (colony && colony.ships) || {};
    Object.keys(ships).forEach(function (k) {
      docked += (ships[k] || 0) * shipDockWeight(k);
    });
    let queued = 0;
    const q = (colony && colony.assets && colony.assets.shipQueue) || [];
    for (let i = 0; i < q.length; i++) queued += shipDockWeight(q[i].kind || 'explorer');
    return { docked: docked, queued: queued, total: docked + queued };
  }

  /* Bonus tecnici (decisione #41).
     I tecnici riducono il tempo di assemblaggio scafi/equipaggi: −2.5%
     per tecnico oltre la soglia 2, cap −30%. Soft amplifier, mai un gate.
     Lavora sulle unità logiche di pop.classes.tecnici (decimali consentiti
     dal mix lento §9.2, vedi time.js — qui Math.floor per stabilità UI). */
  const TECH_BASE = 2;            // soglia "operativi": il primo bonus parte da T = 3
  const TECH_STEP = 0.025;        // −2.5% per tecnico extra
  const TECH_CAP  = 0.30;         // cap totale
  function techCountOf(colony) {
    const cl = colony && colony.pop && colony.pop.classes;
    return cl ? Math.max(0, Math.floor(cl.tecnici || 0)) : 0;
  }
  function techSpeedBonus(colony) {
    const t = techCountOf(colony);
    if (t <= TECH_BASE) return 0;
    return Math.min(TECH_CAP, (t - TECH_BASE) * TECH_STEP);
  }
  function applyTechSpeed(time, colony) {
    const b = techSpeedBonus(colony);
    let t = (b > 0) ? time * (1 - b) : time;
    /* M14 Fase B1 (decisione #77): Ingegnere capo assegnato → ulteriore
       riduzione del tempo di assemblaggio (moltiplicativa, oltre i tecnici #41). */
    const CF = root.ORION && root.ORION.colonyFigure;
    if (CF && CF.assemblyMul) t *= CF.assemblyMul(colony);
    return Math.max(1, Math.round(t));
  }

  /* canBuildShip — verifica preliminare per startShipBuild (decisione #41).
     Recovery-friendly: ritorna {ok:false, reason} con motivo umano. */
  function canBuildShip(game, colony, colonyKey, kind) {
    if (!colony) return { ok: false, reason: 'Colonia inesistente' };
    const ent = colony.structures && colony.structures['cantiere-navale'];
    if (!ent) return { ok: false, reason: 'Hangar di costruzione non costruito' };
    const slots = hangarBuildSlots(colony);
    const active = activeCantieriUse(colony);
    if (active >= slots) {
      return { ok: false, reason: 'Cantieri saturi (' + active + '/' + slots + '). Espandi l\'Hangar o il Bacino di costruzione.' };
    }
    const docks = hangarBerthCapacity(colony);
    const bound = totalShipsBound(game, colony, colonyKey).total;
    /* M15: la nave in arrivo pesa dockWeight (capitali > 1). Controlla che ci
       stia (non solo "almeno 1 unità libera"). Capacità = attracchi + cantieri
       (le navi in costruzione prenotano già il posto, #41 + 2026-06-18). */
    const w = kind ? shipDockWeight(kind) : 1;
    if (bound + w > docks) {
      return { ok: false, reason: 'Porto saturo (' + bound + '/' + docks + ', servono ' + w + '). Espandi l\'Hangar/Bacino o libera attracchi.' };
    }
    return { ok: true };
  }


  function enrichmentForXp(xp) {
    /* Gradi dell'EQUIPAGGIO (collettivo, decisione utente 2026-06-11):
       0 = Reclute · 1-2 = Operativi · 3-5 = Esperti · 6-9 = Veterani ·
       10+ = Leggende. Al grado massimo (Leggende, xp ≥ 10) emerge un
       Comandante e l'equipaggio si riforma (vedi commander.PROMOTION_THRESHOLD). */
    var x = xp | 0;
    if (x <= 0) return { label: 'Reclute', tier: 0 };
    if (x <= 2) return { label: 'Operativi', tier: 1 };
    if (x <= 5) return { label: 'Esperti', tier: 2 };
    if (x <= 9) return { label: 'Veterani', tier: 3 };
    return { label: 'Leggende', tier: 4 };
  }









  /* ------------------------------------------------------------------
     EXPORT
     ------------------------------------------------------------------ */
  /* Razioni equipaggio al porto (decisione 2026-06-15, speculare a #74
     fleet.portMaintenance per i metalli, ma con una differenza chiave): conta
     SOLO gli equipaggi idle in colony.crews.explorer (#39). I crews delle
     flotte parcheggiate nel sistema NON contano — quei crews mangiano dai
     viveri della flotta (#69), già pagati alla colonia in fase di top-up.
     Doppio-contarli (come si fa con i metalli in portMaintenance) sarebbe
     punitivo e mostrerebbe drenaggi misteriosi sulle colonie-snodo dove
     transitano flotte altrui. Rate per equipaggio/Ι in time.CFG. */
  function crewPortConsumption(game, colony) {
    if (!colony) return { food: 0, water: 0, crews: 0 };
    const T = root.ORION && root.ORION.time;
    if (!T || !T.CFG) return { food: 0, water: 0, crews: 0 };
    let crews = 0;
    if (colony.crews && Array.isArray(colony.crews.explorer)) {
      crews = colony.crews.explorer.length;
    }
    return {
      food:  crews * (T.CFG.CREW_PORT_FOOD  || 0),
      water: crews * (T.CFG.CREW_PORT_WATER || 0),
      crews: crews
    };
  }

  ORION.expedition = {
    CFG: CFG,
    crewPortConsumption: crewPortConsumption,
    averageXp: averageXp,
    enrichmentForXp: enrichmentForXp,
    /* M07 estensione (decisione #41) — capacità Hangar */
    hangarBuildSlots: hangarBuildSlots,
    activeMercBuilds: activeMercBuilds,
    activeCantieriUse: activeCantieriUse,
    hangarDockCapacity: hangarDockCapacity,
    hangarBerthCapacity: hangarBerthCapacity,
    activeShipBuilds: activeShipBuilds,
    academyTrainSlots: academyTrainSlots,
    activeCrewBuilds: activeCrewBuilds,
    canBuildCrew: canBuildCrew,
    totalShipsBound: totalShipsBound,
    canBuildShip: canBuildShip,
    techCountOf: techCountOf,
    techSpeedBonus: techSpeedBonus,
    applyTechSpeed: applyTechSpeed
  };
})(typeof window !== 'undefined' ? window : this);
