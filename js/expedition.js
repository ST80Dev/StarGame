/* =====================================================================
   ORION EMPIRES — expedition.js
   Modulo M07: Esplorazione (decisione #37).

   Spedizioni di scouting che richiedono uno SCAFO ESPLORATORE (prodotto
   dall'Hangar di costruzione) e un EQUIPAGGIO ESPLORATORE (prodotto
   dall'Accademia militare). Una spedizione viaggia verso un sistema
   DETECTED o UNKNOWN adiacente (via rotte del grafo galassia), all'arrivo
   lo promuove a EXPLORED e i suoi vicini UNKNOWN a DETECTED, poi torna
   alla colonia di origine restituendo l'equipaggio con +1 xp.

   Filosofia recovery-friendly (decisione #22): nessun esito può causare
   game-over o perdita di colonia. Al peggio si perde lo scafo (l'utente
   ne costruisce un altro). Niente fail-state.

   Determinismo (decisione #5): tutto l'RNG usa
     ORION.rng.makeRng(game.seed + ':expedition:' + expId)
   così replay/persistenza/save sono riproducibili.

   Lessico Star Wars-flavor (decisione #34): "salto iperspaziale",
   "iperguida", "rotta iperspaziale" — la velocità subluce di base
   giustifica le durate (40-80 Ι per 1 hop, scalabili in M13 dai 3 tier
   di iperdrive — decisione #32).
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  /* --- Costanti di bilanciamento (decisione #37) --- */
  const CFG = {
    SHIP_COST:  { met: 25, en: 12 },
    SHIP_TIME:  10,            // I per costruire 1 scafo in Hangar
    CREW_COST:  { food: 12, water: 6 },
    CREW_TIME:  12,            // I per formare 1 equipaggio in Accademia

    TRAVEL_BASE: 50,           // base durata viaggio inter-sistema (1 hop)
    TRAVEL_DANGER_FACTOR: 30,  // +N*danger (0..1) Ι
    TRAVEL_MIN: 40,
    TRAVEL_MAX: 80,

    WEAR_BASE: 8,              // +% wear per spedizione
    WEAR_DANGER_FACTOR: 10,    // +% extra in base a danger (0..1)
    WEAR_MAX: 100,

    XP_DURATION_REDUCTION: 0.01,    // -1% durata per xp
    XP_DURATION_CAP: 0.15,          // cap -15%
    XP_ACCIDENT_REDUCTION: 0.02,    // -2% chance incidente per xp
    XP_ACCIDENT_CAP: 0.20,          // cap -20%

    ACCIDENT_LOW:   0.05,      // danger <= 0.33
    ACCIDENT_MID:   0.15,      // 0.33 < danger <= 0.66
    ACCIDENT_HIGH:  0.30,      // danger > 0.66
    PIRATE_ACCIDENT: 0.15,     // M10 Fase B: +rischio max da covo pirata (threat 1.0)

    INCIDENT_DELAY_MIN: 10,    // +Ι ritardo
    INCIDENT_DELAY_MAX: 20,
    INCIDENT_WEAR_MIN:  10,    // +% wear
    INCIDENT_WEAR_MAX:  15,
    INCIDENT_CRIT_DANGER_THRESHOLD: 0.5,  // avaria critica solo sopra
    INCIDENT_CRIT_BACK_MIN: 20,
    INCIDENT_CRIT_BACK_MAX: 40
  };

  /* Contatore in-process per id unici di spedizione. Persiste solo per la
     sessione di runtime; gli id già emessi vivono in game.expeditions[]. */
  let _expCounter = 0;

  /* ------------------------------------------------------------------
     Helpers
     ------------------------------------------------------------------ */
  function dangerNorm(galaxy, systemId) {
    const s = galaxy && galaxy.systems && galaxy.systems[systemId];
    if (!s) return 0.5;
    return Math.max(0, Math.min(1, (s.danger || 0) / 100));
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /* xp medio di una lista di equipaggi */
  function averageXp(crews) {
    if (!Array.isArray(crews) || !crews.length) return 0;
    let s = 0;
    for (let i = 0; i < crews.length; i++) s += (crews[i].xp || 0);
    return s / crews.length;
  }

  /* Conteggio scafi/equipaggi disponibili in colonia (non impegnati in
     spedizioni in corso). I disponibili sono già contati: quando lanciamo
     decrementiamo ships.explorer e rimuoviamo l'equipaggio dall'array. */
  function availableShips(colony) {
    return (colony && colony.ships && colony.ships.explorer) || 0;
  }
  function availableCrews(colony) {
    if (!colony || !colony.crews) return [];
    return (colony.crews.explorer || []).slice();
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
  function hangarBuildSlots(colony) {
    const ent = colony && colony.structures && colony.structures['cantiere-navale'];
    if (!ent) return 0;
    return _capForLevel(hangarCapTable('buildSlots'), ent.level || 1);
  }
  function hangarDockCapacity(colony) {
    const ent = colony && colony.structures && colony.structures['cantiere-navale'];
    if (!ent) return 0;
    return _capForLevel(hangarCapTable('docks'), ent.level || 1);
  }
  function activeShipBuilds(colony) {
    return (colony && colony.assets && Array.isArray(colony.assets.shipQueue))
      ? colony.assets.shipQueue.length : 0;
  }
  function shipsOnExpedition(game, originColonyKey) {
    if (!game || !Array.isArray(game.expeditions)) return 0;
    let n = 0;
    for (let i = 0; i < game.expeditions.length; i++) {
      const e = game.expeditions[i];
      if (e.status !== 'done' && e.originColonyKey === originColonyKey) n++;
    }
    return n;
  }
  /* Navi totali "afferenti" alla colonia: docked + in coda + in spedizione.
     Le in spedizione hanno lasciato il porto ma occupano una matricola
     della colonia → tornando dovranno trovare posto (#41). */
  function totalShipsBound(game, colony, colonyKey) {
    const docked = availableShips(colony);                 // contatore a terra
    const queued = activeShipBuilds(colony);               // in costruzione (occupano cantiere ma non porto)
    const flying = shipsOnExpedition(game, colonyKey);     // in viaggio
    return { docked: docked, queued: queued, flying: flying, total: docked + queued + flying };
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
    if (b <= 0) return time;
    return Math.max(1, Math.round(time * (1 - b)));
  }

  /* canBuildShip — verifica preliminare per startShipBuild (decisione #41).
     Recovery-friendly: ritorna {ok:false, reason} con motivo umano. */
  function canBuildShip(game, colony, colonyKey) {
    if (!colony) return { ok: false, reason: 'Colonia inesistente' };
    const ent = colony.structures && colony.structures['cantiere-navale'];
    if (!ent) return { ok: false, reason: 'Hangar di costruzione non costruito' };
    const slots = hangarBuildSlots(colony);
    const active = activeShipBuilds(colony);
    if (active >= slots) {
      return { ok: false, reason: 'Cantieri saturi (' + active + '/' + slots + '). Espandi l\'Hangar o attendi.' };
    }
    const docks = hangarDockCapacity(colony);
    const bound = totalShipsBound(game, colony, colonyKey).total;
    if (bound >= docks) {
      return { ok: false, reason: 'Porto saturo (' + bound + '/' + docks + ' navi). Espandi l\'Hangar o lancia spedizioni per liberare attracchi.' };
    }
    return { ok: true };
  }

  /* Riduzione durata per xp (cap a XP_DURATION_CAP). */
  function durationXpScale(xp) {
    const r = Math.min(CFG.XP_DURATION_CAP, (xp || 0) * CFG.XP_DURATION_REDUCTION);
    return 1 - r;
  }
  function accidentXpScale(xp) {
    const r = Math.min(CFG.XP_ACCIDENT_CAP, (xp || 0) * CFG.XP_ACCIDENT_REDUCTION);
    return 1 - r;
  }

  function enrichmentForXp(xp) {
    /* Etichetta veterano: 0 = recluta, 1-2 = veterano, 3-4 = esperto, 5+ asso */
    if (!xp || xp <= 0) return { label: 'recluta', tier: 0 };
    if (xp <= 2) return { label: 'veterano', tier: 1 };
    if (xp <= 4) return { label: 'esperto', tier: 2 };
    return { label: 'asso', tier: 3 };
  }

  /* Calcola durata viaggio (base, prima delle riduzioni xp). */
  function computeDuration(galaxy, targetSystemId, crewXp) {
    const d = dangerNorm(galaxy, targetSystemId);
    let base = CFG.TRAVEL_BASE + d * CFG.TRAVEL_DANGER_FACTOR;
    base = clamp(Math.round(base), CFG.TRAVEL_MIN, CFG.TRAVEL_MAX);
    const dur = Math.round(base * durationXpScale(crewXp || 0));
    return Math.max(1, dur);
  }

  function accidentChance(galaxy, targetSystemId, crewXp, game) {
    const d = dangerNorm(galaxy, targetSystemId);
    let c;
    if (d <= 0.33) c = CFG.ACCIDENT_LOW;
    else if (d <= 0.66) c = CFG.ACCIDENT_MID;
    else c = CFG.ACCIDENT_HIGH;
    c *= accidentXpScale(crewXp || 0);
    /* M10 Fase B (decisione #47): i covi pirata (§17.5) danno "denti" al
       pericolo — alzano il rischio di incidente lungo la rotta riusando
       ORION.ai.pirateThreat. Recovery-friendly (#22): aumenta solo la
       probabilità, non introduce un esito fatale nuovo (la risoluzione di
       uno scontro vero resta a M09). `game` è opzionale per retro-compat. */
    if (game && ORION.ai && ORION.ai.pirateThreat) {
      const threat = ORION.ai.pirateThreat(game, targetSystemId);
      if (threat > 0) c += threat * CFG.PIRATE_ACCIDENT;
    }
    return Math.max(0, c);
  }

  /* ------------------------------------------------------------------
     Adiacenza: per ora ci limitiamo ai sistemi RAGGIUNGIBILI in 1 hop
     dal sistema della colonia origine, usando le rotte del grafo
     galassia. Hop multipli sono un'estensione futura (M08+).
     ------------------------------------------------------------------ */
  function isReachable(galaxy, fromSystemId, targetSystemId) {
    if (fromSystemId === targetSystemId) return false;
    const s = galaxy && galaxy.systems && galaxy.systems[fromSystemId];
    if (!s || !Array.isArray(s.links)) return false;
    return s.links.indexOf(targetSystemId) >= 0;
  }

  function reachableTargets(galaxy, state, fromSystemId) {
    const out = [];
    const s = galaxy.systems[fromSystemId];
    if (!s || !s.links) return out;
    const DISCOVERY = ORION.galaxy.DISCOVERY;
    for (let i = 0; i < s.links.length; i++) {
      const tid = s.links[i];
      const disc = state.discovery[tid];
      /* esplorabile solo se DETECTED o UNKNOWN (EXPLORED non ha più nulla
         di nuovo). */
      if (disc < DISCOVERY.EXPLORED) out.push(tid);
    }
    return out;
  }

  /* ------------------------------------------------------------------
     canLaunch — verifica preliminare. Recovery-friendly: ritorna
     {ok:false, reason} con motivo umano se non si può lanciare.
     ------------------------------------------------------------------ */
  function canLaunch(game, originColonyKey, targetSystemId) {
    if (!game) return { ok: false, reason: 'Partita non inizializzata' };
    const colony = game.colonies && game.colonies[originColonyKey];
    if (!colony) return { ok: false, reason: 'Colonia inesistente' };
    if (!colony.colonized) return { ok: false, reason: 'Colonia non operativa' };
    if (colony.systemId === targetSystemId) return { ok: false, reason: 'Sistema già conosciuto (origine)' };
    const galaxy = game.galaxy;
    if (!galaxy || !galaxy.systems[targetSystemId]) return { ok: false, reason: 'Sistema target inesistente' };
    const DISCOVERY = ORION.galaxy.DISCOVERY;
    const disc = game.state && game.state.discovery && game.state.discovery[targetSystemId];
    if (disc >= DISCOVERY.EXPLORED) return { ok: false, reason: 'Sistema già esplorato' };
    if (!isReachable(galaxy, colony.systemId, targetSystemId)) {
      return { ok: false, reason: 'Sistema non raggiungibile da questa colonia' };
    }
    if (availableShips(colony) < 1) return { ok: false, reason: 'Nessuno scafo esploratore disponibile' };
    if (availableCrews(colony).length < 1) return { ok: false, reason: 'Nessun equipaggio esploratore disponibile' };
    return { ok: true };
  }

  /* ------------------------------------------------------------------
     launch — crea la spedizione, decrementa scafo+equipaggio, registra
     in game.expeditions. Determinismo: id e RNG derivano dal timeImpulsi
     corrente + counter (replay-safe: stesso seed + stessa sequenza di
     comandi → stessi id).
     ------------------------------------------------------------------ */
  function launch(game, originColonyKey, targetSystemId) {
    const check = canLaunch(game, originColonyKey, targetSystemId);
    if (!check.ok) return { ok: false, reason: check.reason };
    const colony = game.colonies[originColonyKey];
    /* Pesca il PRIMO equipaggio dall'array (deterministico) — quello con
       l'id più vecchio. Se in futuro vorremo "scegli equipaggio" come UX,
       basterà passare il crewId in opts. */
    const crews = colony.crews.explorer;
    const crew = crews.shift();    // rimuove e ritorna il primo
    colony.ships.explorer = Math.max(0, (colony.ships.explorer || 0) - 1);

    _expCounter++;
    const id = 'exp-' + (game.timeImpulsi || 0) + '-' + _expCounter;
    const durationOut = computeDuration(game.galaxy, targetSystemId, crew.xp || 0);

    const exp = {
      id: id,
      originColonyKey: originColonyKey,
      targetSystemId: targetSystemId,
      status: 'outbound',
      launchedAt: game.timeImpulsi || 0,
      durationOut: durationOut,     // I rimanenti in outbound (decresce)
      durationBack: null,            // calcolato all'arrivo (xp può salire)
      arriveAt: null,
      returnAt: null,
      shipWear: 0,                   // 0..100% — la traveltime base = +8% + danger
      crewId: crew.id,
      crewXp: crew.xp || 0,
      incidents: [],
      result: null
    };

    if (!Array.isArray(game.expeditions)) game.expeditions = [];
    game.expeditions.push(exp);
    return { ok: true, expedition: exp };
  }

  /* ------------------------------------------------------------------
     applyIncident — chiamato durante il viaggio (1 sola estrazione,
     all'avvio del leg outbound: il viaggio di andata è dove si rischia,
     coerentemente con un "salto iperspaziale verso l'ignoto"). RNG
     deterministico dal seed+id spedizione.
     ------------------------------------------------------------------ */
  function rollIncident(game, exp) {
    const rng = ORION.rng.makeRng(game.seed + ':expedition:' + exp.id);
    const chance = accidentChance(game.galaxy, exp.targetSystemId, exp.crewXp || 0, game);
    if (rng.float() >= chance) return null;
    const danger = dangerNorm(game.galaxy, exp.targetSystemId);
    /* Distribuzione (decisione #37):
       50% ritardo · 30% usura extra · 15% avaria critica (solo danger>0.5)
       · 5% scoperta fortuita */
    const r = rng.float();
    if (r < 0.50) {
      const extra = rng.int(CFG.INCIDENT_DELAY_MIN, CFG.INCIDENT_DELAY_MAX);
      exp.durationOut += extra;
      const inc = { kind: 'delay', amount: extra };
      exp.incidents.push(inc);
      return inc;
    }
    if (r < 0.80) {
      const w = rng.int(CFG.INCIDENT_WEAR_MIN, CFG.INCIDENT_WEAR_MAX);
      exp.shipWear = Math.min(CFG.WEAR_MAX, (exp.shipWear || 0) + w);
      const inc = { kind: 'wear', amount: w };
      exp.incidents.push(inc);
      return inc;
    }
    if (r < 0.95) {
      if (danger > CFG.INCIDENT_CRIT_DANGER_THRESHOLD) {
        /* Avaria critica: scafo perso, equipaggio si salva. Il ritorno
           usa una rotta di emergenza più corta (20-40 Ι). Lo scafo NON
           sarà restituito in colonia: il flag shipLost lo segnala. */
        const back = rng.int(CFG.INCIDENT_CRIT_BACK_MIN, CFG.INCIDENT_CRIT_BACK_MAX);
        const inc = { kind: 'critical', backDuration: back };
        exp.incidents.push(inc);
        exp.shipWear = CFG.WEAR_MAX;
        exp._critBackOverride = back;
        return inc;
      }
      /* danger basso: fallback a "usura extra" */
      const w = rng.int(CFG.INCIDENT_WEAR_MIN, CFG.INCIDENT_WEAR_MAX);
      exp.shipWear = Math.min(CFG.WEAR_MAX, (exp.shipWear || 0) + w);
      const inc = { kind: 'wear', amount: w };
      exp.incidents.push(inc);
      return inc;
    }
    /* Scoperta fortuita (positivo). M17 eventi vero — qui solo cronaca. */
    const inc = { kind: 'discovery' };
    exp.incidents.push(inc);
    return inc;
  }

  /* ------------------------------------------------------------------
     tick — chiamato dal game loop ad ogni Impulso, per ogni spedizione.
     Restituisce eventi che il loop principale aggiungerà a `events[]`.
     ------------------------------------------------------------------ */
  function tick(game, exp, events) {
    if (!exp || exp.status === 'done') return;
    /* All'avvio del primo tick dell'outbound, tira incidente (1 volta sola). */
    if (exp.status === 'outbound' && !exp._incidentRolled) {
      exp._incidentRolled = true;
      const inc = rollIncident(game, exp);
      if (inc) {
        events.push({
          kind: 'expedition-incident',
          expedition: exp,
          incident: inc,
          impulso: game.timeImpulsi
        });
      }
    }

    if (exp.status === 'outbound') {
      exp.durationOut = (exp.durationOut || 0) - 1;
      if (exp.durationOut <= 0) {
        /* Arrivo: rivela il sistema target, accumula usura del viaggio,
           prepara il ritorno. Se incidente critico, accorcia il ritorno
           e marca lo scafo come perso (al rientro non viene restituito). */
        exp.arriveAt = game.timeImpulsi;
        /* usura base + scaling danger */
        const danger = dangerNorm(game.galaxy, exp.targetSystemId);
        const w = CFG.WEAR_BASE + Math.round(danger * CFG.WEAR_DANGER_FACTOR);
        exp.shipWear = Math.min(CFG.WEAR_MAX, (exp.shipWear || 0) + w);

        /* Rivela il sistema (idempotente). */
        if (ORION.galaxy && ORION.galaxy.revealSystem) {
          ORION.galaxy.revealSystem(game.galaxy, exp.targetSystemId, game.state);
        }
        events.push({
          kind: 'expedition-arrived',
          expedition: exp,
          systemId: exp.targetSystemId,
          impulso: game.timeImpulsi
        });

        /* Calcola ritorno: stesso base durata, lo scafo è lo stesso ma
           con xp già accumulato (l'utente avrà comunque +xp al rientro).
           Se critico, override. */
        let durBack;
        if (exp._critBackOverride) {
          durBack = exp._critBackOverride;
        } else {
          durBack = computeDuration(game.galaxy, exp.targetSystemId, exp.crewXp || 0);
        }
        exp.durationBack = durBack;
        exp.status = 'returning';
      }
      return;
    }

    if (exp.status === 'returning') {
      exp.durationBack = (exp.durationBack || 0) - 1;
      if (exp.durationBack <= 0) {
        exp.returnAt = game.timeImpulsi;
        /* Restituisci equipaggio alla colonia origine con +1 xp.
           Se la colonia non esiste più (futuro M09: distrutta), niente. */
        const colony = game.colonies && game.colonies[exp.originColonyKey];
        const shipLost = (exp.shipWear >= CFG.WEAR_MAX);
        if (colony) {
          if (!colony.crews) colony.crews = { explorer: [] };
          if (!Array.isArray(colony.crews.explorer)) colony.crews.explorer = [];
          /* Counter persistente: vedi nota in time.js → nextCrewId.
             Prima usavamo _expCounter (module-local) che si resettava al
             reload del save → ID collidevano con quelli formati
             dall'Accademia e il roster mostrava "Equipaggio 1" duplicato. */
          var T = root.ORION && root.ORION.time;
          var crewId = (T && T.nextCrewId)
            ? T.nextCrewId(game)
            : 'crew-' + (game.timeImpulsi || 0) + '-' + (++_expCounter);
          var newCrew = {
            id: crewId,
            xp: (exp.crewXp || 0) + 1
          };
          colony.crews.explorer.push(newCrew);
          /* Decisione #43: se l'equipaggio raggiunge la soglia 'asso'
             (xp ≥ 5), un Comandante emerge dal gruppo. La figura eredita
             la xp, l'equipaggio resta nel roster ma con xp resettata a 0
             (scelta utente: i crew sono "più persone", il capitano si
             stacca, il gruppo si riforma sotto il vuoto lasciato). */
          var promotedCmd = null;
          var C = root.ORION && root.ORION.commander;
          if (C && C.isPromotable(newCrew.xp)) {
            promotedCmd = C.promote(game, colony, newCrew, newCrew.xp, exp.originColonyKey);
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
          /* Scafo restituito solo se non perso. Decisione #41: la nave
             torna comunque al counter (recovery-friendly #22), ma se il
             porto è saturo emettiamo un evento informativo "in orbita
             parcheggio" — niente penalità meccanica oggi (sarà M09:
             esposte a cattura/attacco). */
          if (!shipLost) {
            colony.ships = colony.ships || { explorer: 0 };
            colony.ships.explorer = (colony.ships.explorer || 0) + 1;
            const docks = hangarDockCapacity(colony);
            const bound = totalShipsBound(game, colony, exp.originColonyKey).total;
            if (docks > 0 && bound > docks) {
              events.push({
                kind: 'expedition-dock-overflow',
                expedition: exp,
                docks: docks,
                bound: bound,
                impulso: game.timeImpulsi
              });
            }
          }
        }
        if (shipLost) {
          events.push({
            kind: 'expedition-ship-lost',
            expedition: exp,
            impulso: game.timeImpulsi
          });
        }
        events.push({
          kind: 'expedition-return',
          expedition: exp,
          shipLost: shipLost,
          impulso: game.timeImpulsi
        });
        /* Evento scoperta fortuita (5%): la rivelazione c'è già stata
           all'arrivo; al rientro emettiamo l'evento positivo per la
           cronaca / auto-pausa (#31). */
        for (let i = 0; i < (exp.incidents || []).length; i++) {
          if (exp.incidents[i].kind === 'discovery') {
            events.push({
              kind: 'expedition-discovery',
              expedition: exp,
              impulso: game.timeImpulsi
            });
            break;
          }
        }
        exp.status = 'done';
      }
      return;
    }
  }

  /* ------------------------------------------------------------------
     EXPORT
     ------------------------------------------------------------------ */
  ORION.expedition = {
    CFG: CFG,
    canLaunch: canLaunch,
    launch: launch,
    tick: tick,
    computeDuration: computeDuration,
    accidentChance: accidentChance,
    availableShips: availableShips,
    availableCrews: availableCrews,
    averageXp: averageXp,
    enrichmentForXp: enrichmentForXp,
    reachableTargets: reachableTargets,
    isReachable: isReachable,
    dangerNorm: dangerNorm,
    /* M07 estensione (decisione #41) — capacità Hangar */
    hangarBuildSlots: hangarBuildSlots,
    hangarDockCapacity: hangarDockCapacity,
    activeShipBuilds: activeShipBuilds,
    shipsOnExpedition: shipsOnExpedition,
    totalShipsBound: totalShipsBound,
    canBuildShip: canBuildShip,
    techCountOf: techCountOf,
    techSpeedBonus: techSpeedBonus,
    applyTechSpeed: applyTechSpeed
  };
})(typeof window !== 'undefined' ? window : this);
