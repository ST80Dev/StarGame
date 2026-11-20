/* =====================================================================
   ORION EMPIRES — newgame.js (Revisione 2026, Fase 1)
   Creazione della partita: galassia dal seed + stato iniziale + colonia
   natale + init idempotente dei sottosistemi; opzionale ripristino dei
   delta da un payload di save.

   Estratto da main.js (newGame) per rendere la simulazione creabile
   headless (test golden replay). Nessun accesso a DOM/HUD: la UI chiama
   ORION.newgame.create() e poi aggiorna le proprie viste.

   NB: imposta ORION.game come faceva newGame — diversi moduli leggono
   ancora il global (debito noto, vedi docs/AUDIT_2026.md §1.2).
   ===================================================================== */
(function (root) {
  'use strict';
  const ORION = root.ORION || (root.ORION = {});

  /* Deep copy difensiva di un oggetto mode (decisione #23). */
  function cloneMode(m) {
    if (!m) return null;
    return {
      startedAs: m.startedAs || 'sandbox',
      preset: m.preset || 'classic',
      modifiers: Object.assign({}, m.modifiers || {})
    };
  }

  /* Recovery best-effort della nebbia di guerra per save pre-schema-11.
     Promuove a EXPLORED ogni sistema deducibile dalle fonti del payload
     (e DETECTED i loro vicini, come fa revealSystem). Idempotente, mai
     downgrade. */
  function recoverDiscoveryFromPayload(game, saved) {
    if (!game || !saved || !game.galaxy || !game.state) return;
    const D = ORION.galaxy.DISCOVERY;
    const galaxy = game.galaxy;
    const reveal = function (sid) {
      if (!Number.isInteger(sid) || sid < 0 || sid >= galaxy.count) return;
      ORION.galaxy.revealSystem(galaxy, sid, game.state);
    };
    /* (1) colonie: la chiave è "<sysId>:<bodyKey>" → ogni sysId è esplorato. */
    if (saved.colonies && typeof saved.colonies === 'object') {
      Object.keys(saved.colonies).forEach(function (k) {
        const sid = parseInt(String(k).split(':')[0], 10);
        reveal(sid);
      });
    }
    /* (2) flotte: posizione corrente + waypoint/loop + colonia origine. */
    if (Array.isArray(saved.fleets)) {
      saved.fleets.forEach(function (f) {
        if (!f) return;
        if (f.location && Number.isInteger(f.location.systemId)) reveal(f.location.systemId);
        if (f.ownerColonyKey) {
          const sid = parseInt(String(f.ownerColonyKey).split(':')[0], 10);
          reveal(sid);
        }
        if (f.orders) {
          if (Array.isArray(f.orders.waypoints)) f.orders.waypoints.forEach(reveal);
          if (Array.isArray(f.orders.loop)) f.orders.loop.forEach(reveal);
          if (Number.isInteger(f.orders.toSysId)) reveal(f.orders.toSysId);
        }
        if (Array.isArray(f.route)) f.route.forEach(reveal);
      });
    }
    /* (3) spedizioni attive: il target è (o è stato) esplorato a destinazione. */
    if (Array.isArray(saved.expeditions)) {
      saved.expeditions.forEach(function (e) {
        if (e && Number.isInteger(e.targetSystemId)) reveal(e.targetSystemId);
      });
    }
    /* (4) cronaca: parsing dei nomi di sistema (<strong>NOME</strong>).
       Indicizza i nomi → systemId una volta, poi cerca le occorrenze in
       contesti che implicano scoperta ("esplorato", "in orbita di",
       "Salto iperspaziale verso"). */
    if (Array.isArray(saved.chronicle) && saved.chronicle.length) {
      const nameToId = Object.create(null);
      for (let i = 0; i < galaxy.systems.length; i++) {
        const sn = galaxy.systems[i].name;
        if (sn) nameToId[sn] = i;
      }
      const strongRe = /<strong>([^<]+)<\/strong>/g;
      const hints = /(esplorato|in orbita di|Salto iperspaziale|rientrata da|Rotta completata)/i;
      saved.chronicle.forEach(function (entry) {
        const html = entry && entry.html ? entry.html : (typeof entry === 'string' ? entry : '');
        if (!html || !hints.test(html)) return;
        let m;
        strongRe.lastIndex = 0;
        while ((m = strongRe.exec(html)) !== null) {
          const sid = nameToId[m[1]];
          if (Number.isInteger(sid)) reveal(sid);
        }
      });
    }
  }

  /* Nome PLAIN della colonia da una chiave "<sysId>:<bodyKey>". */
  function colonyPlainName(game, key) {
    if (!game || !key) return '';
    const parts = String(key).split(':');
    const sid = Number(parts[0]); const bk = parts[1];
    try {
      const sys = ORION.system.generate(game.galaxy, sid);
      const pl = ORION.planet.generate(game.galaxy, sys, bk);
      return pl ? pl.name : ('Sistema ' + sid);
    } catch (e) { return 'Sistema ' + sid; }
  }

  /* Default identità (decisione #65): "Repubblica" + nome colonia natale. */
  function defaultEmpire(game) {
    const key = game && (game.homePlanetKey ||
      (game.homeWorld && Number.isInteger(game.homeWorld.systemId)
        ? (game.homeWorld.systemId + ':' + game.homeWorld.bodyKey) : null));
    const proper = (key && colonyPlainName(game, key)) ||
      (game && ORION.names && ORION.names.galaxyName(game.seed)) || 'Aurora';
    return { prefix: 'repubblica', proper: proper };
  }

  /* Genera struttura+colonia per il mondo natale e popola l'HUD risorse.
     M06.5: se `game.homeWorld` è stato impostato dalla scelta menu
     (decisione #27), usa il bodyKey esplicito (può differire dall'
     `homeWorld` flaggato da system.js, perché il candidato è stato pescato
     con scoring leggermente diverso). */
  function colonizeHomePlanet(game, startDS) {
    const galaxy = game.galaxy;
    const homeSys = ORION.system.generate(galaxy, galaxy.homeId);
    let homeBody = null;
    /* Preferenza: bodyKey esplicito dal menu (M06.5) */
    if (game.homeWorld && game.homeWorld.bodyKey) {
      homeBody = ORION.system.findBody(homeSys, game.homeWorld.bodyKey);
    }
    /* Fallback: bandiera homeWorld di system.js (retro-compat) */
    if (!homeBody) {
      for (let i = 0; i < homeSys.bodies.length; i++) {
        if (homeSys.bodies[i].homeWorld) { homeBody = homeSys.bodies[i]; break; }
      }
    }
    if (!homeBody) homeBody = homeSys.bodies[Math.floor(homeSys.bodies.length / 2)];
    const planet = ORION.planet.generate(galaxy, homeSys, homeBody.key);
    const colony = ORION.planet.createColony(planet);
    /* M06.5 (decisione #27): leggi le tarature dal preset corrente. */
    const mods = (game.mode && game.mode.modifiers) || {};
    const settlingOpts = {
      duration: mods.settlingDuration || 60,
      stockMul: (typeof mods.startStockMul === 'number') ? mods.startStockMul : 1.0,
      popBase:  mods.startPopBase || 3
    };
    ORION.planet.colonizeHome(colony, planet, startDS, settlingOpts);
    /* Scafo + equipaggio di partenza (decisione utente 2026-06-17): il
       giocatore arriva sul mondo natale con la nave coloniale d'approdo,
       così durante l'Insediamento può già esplorare i sistemi limitrofi e
       fare i primi contatti mentre la colonia si stabilizza. Lo scout è
       "speciale": non richiede Hangar/porto per essere lanciato, ma una
       volta costruito il Cantiere navale occupa regolarmente 1 attracco
       (gate canBuildShip). L'equipaggio nasce a xp=2 ("Operativi") — non
       sono reclute, hanno portato qui la colonia. Nessun upkeep durante
       `settling` (vedi crewPortConsumption e ship maintenance gate in
       time.js). Se la nave/equipaggio si perde in spedizione, niente
       refund: rischio consapevole del giocatore. */
    if (!Array.isArray(colony.crews.explorer)) colony.crews.explorer = [];
    colony.ships.explorer = (colony.ships.explorer || 0) + 1;
    const T = ORION.time;
    const starterCrewId = (T && T.nextCrewId) ? T.nextCrewId(game) : 'crew-home-starter';
    colony.crews.explorer.push({ id: starterCrewId, xp: 2 });
    game.colonies[galaxy.homeId + ':' + homeBody.key] = colony;
    game.homePlanetKey = galaxy.homeId + ':' + homeBody.key;
  }

  function create(seed, opts) {
    opts = opts || {};
    /* Se ci viene passato un payload (load slot / import .json), il seed
       viene da lì — coerente con seed+delta (decisione #5/#24). */
    if (opts.payload && opts.payload.seed) seed = opts.payload.seed;
    /* M06.5: payload v4 contiene esplicitamente la scelta della colonia
       originaria (decisione #27). Se presente, sovrascrive opts.homeWorld. */
    if (opts.payload && opts.payload.homeWorld) opts.homeWorld = opts.payload.homeWorld;
    seed = seed || ORION.rng.newSeed();
    const galaxy = ORION.galaxy.generate(seed);
    /* M10 Fase B punto 3 (decisione #52 §6.1): algoritmo di generazione
       sistemi. Nuove partite usano V2 (5-10 pianeti, 8 configurazioni,
       marginali); save legacy (schema ≤ 14) restano su V1 per preservare
       i body keys delle colonie esistenti (legacy snapshot per-galassia,
       non per-sistema, per semplicità d'implementazione). Override da payload. */
    galaxy.systemAlgVersion = (opts.payload && opts.payload.systemAlgVersion === 1) ? 1 : 2;
    /* M06.5: se il giocatore ha scelto un home diverso dal default
       generato (decisione #27), ricalibra prima di createState così la
       nebbia di guerra rispetta la nuova origine. */
    if (opts.homeWorld && Number.isInteger(opts.homeWorld.systemId)) {
      ORION.galaxy.recomputeDanger(galaxy, opts.homeWorld.systemId);
    }
    const state = ORION.galaxy.createState(galaxy);

    // Decisione di sessione: il tempo parte sempre da Ω0·Φ0·Κ0·Ι0.
    // L'idea originaria della decisione #4 (epoca random per dare il feel
    // "galassia preesistente") creava una zavorra cognitiva — meglio
    // raccontare il passato della galassia con rovine/lore/eventi (M17).
    // Il campo resta nel payload (compat di shape) ma non viene letto.
    const startOrbita = 0;

    /* Tutorial (M06.5, decisione #27). Il flag arriva da:
         - opts.tutorialEnabled (form "Nuova partita" del main menu)
         - opts.payload.tutorial (load slot / autosave / import .json)
       Se manca, default OFF. */
    const tutorialEnabled = !!opts.tutorialEnabled;

    const game = ORION.game = {
      galaxy: galaxy, state: state, seed: seed,
      startEpochOrbita: startOrbita,
      timeImpulsi: 0,
      /* M04: stato colonie. Chiave "<sysId>:<bodyKey>" → ColonyState (delta,
         serializzabile per M06). La struttura immutabile del pianeta è
         rigenerata dal seed (decisione #5). */
      colonies: {},
      /* M05/decisione #23 — infrastruttura multi-pista. La UI di scelta
         modalità arriva in M20; per ora ogni partita parte sandbox/classic
         coi modificatori di default. Tutte le piste sono comunque attive
         in parallelo: il tracker dei punteggi si aggiorna a ogni
         VICTORY_CHECK_EVERY_I (vedi time.js). */
      mode: (opts.mode && cloneMode(opts.mode)) ||
            (ORION.victory ? ORION.victory.defaultMode() : { startedAs: 'sandbox', preset: 'classic', modifiers: {} }),
      victoryTracks: ORION.victory ? ORION.victory.defaultTracks() : {},
      /* Scheduler eventi (gancio M17). In M05 vuoto; il Sopravvissuto
         (decisione #23) inietterà una crisi ancorata a DS 0. */
      eventSchedule: [],
      /* M06: cronaca persistita (decisione #24, cap a ORION.save.CHRONICLE_CAP).
         Più recente in TESTA all'array, identico al DOM. */
      chronicle: [],
      /* M06.5: scelta della colonia originaria (decisione #27). Salvata
         esplicitamente come delta per non doverla rideterminare al runtime
         (vincolo seed+delta). Se null, fallback al homeWorld scelto da
         system.js — retro-compat con save schema 3. */
      homeWorld: (opts.homeWorld && Number.isInteger(opts.homeWorld.systemId))
        ? { systemId: opts.homeWorld.systemId, bodyKey: opts.homeWorld.bodyKey }
        : null,
      /* M06.6: stato tutorial (decisione #28). Persistito nel save (schema 4). */
      tutorial: { enabled: tutorialEnabled, seenLessons: [] },
      /* M07 (decisione #37): spedizioni di esplorazione in viaggio. */
      expeditions: [],
      /* M08 Fase A (decisione #42): flotte mobili. */
      fleets: [],
      /* M16 (decisione #81): stazioni spaziali (entità top-level). */
      stations: [],
      /* Comandanti a livello Impero (decisione utente 2026-06-11): pool idle.
         Quelli assegnati vivono su fleet.officers[] (M15 multi-slot). */
      commanders: [],
      /* M14 Fase B1 (decisione #77): figure di colonia (pool idle d'Impero).
         Quelle assegnate vivono su colony.figure. */
      colonyFigures: [],
      /* M13 (decisione #57): ricerca tecnologica. catalogVersion = quella corrente
         (Fase B → 2: 5 punti fermi + pool pescato per-seed). Le partite Fase A
         restano a 1 (solo i 5) via legacy-snapshot. */
      research: { catalogVersion: (ORION.research ? ORION.research.CATALOG_VERSION : 2), unlocked: [], activeProject: null, progress: 0, activationPaid: null },
      /* Decisione #45: mapping centrale gruppo→capitale (lazy initFromHome
         dopo colonizeHomePlanet). */
      capitals: {},
      /* M10 Fase A (decisione #47): civiltà AI, pirati e ICG. Generati dal
         seed via ORION.ai.ensure() dopo la colonizzazione della home (idempotente:
         restano vuoti se ripristinati da un payload). */
      civs: [],
      piracy: { nests: [] },
      icg: null,
      /* M09 Fase A (decisione #49): combattimento. Incursioni pirata inbound,
         assedi in corso, stato di guerra d'impero (morale/pressione). */
      incursions: [],
      battles: [],
      warState: { morale: 1.0, pressure: 0 },
      /* M18.x (richiesta utente 2026-06-18): flotte ambientali AI fisiche in
         volo sulla mappa (esploratori/estrattori/trasporti). */
      aiFleets: [],
      /* M09 Fase B (decisione #49): stato di sconfitta (null/esilio/gameover)
         + accumulatore verbi morali (→ piste reputation). */
      defeated: null,
      alignmentDeeds: { light: 0, dark: 0 },
      /* M11 Fase A (decisione #51): reputazione globale §14 (neutra all'avvio).
         Lo stato diplomatico per-civiltà vive in game.civs (relation). */
      reputation: 50,
      /* M10 Fase B (decisione #52 §13.6/§13.8): stato derivato della coesione
         di sistema (solo lista sysIds correntemente coesi, per emettere
         formed/broken una sola volta) + federazioni emergenti (lista + trust
         per coppia AI alleata). Il marker `civ.federationId` vive su game.civs. */
      cohesion: { sysIds: [] },
      federations: { list: [], trust: {} },
      /* M12 Fase A1 (decisione #53 §15.2): rotte commerciali interne. I
         mercantili (entità con xp) vivono in colony.mercantili. */
      tradeRoutes: [],
      /* M12 Fase A2 (decisione #56 §15.4): Tesoreria — portfolio valute
         regionali. Solo le balances sono persistite; le valute si rigenerano
         dal seed. */
      treasury: { balances: {} },
      /* M12 Fase A2 (decisione #56 §15.3): accordi commerciali bilaterali
         con le civiltà AI. */
      tradeAgreements: [],
      /* #48 Fase 2b: contratti di export rifiuti verso le AI. */
      wasteDeals: [],
      /* Intel grigia Mekhari (M19 §6e): voci di galassia acquistate. Additivo. */
      mekhariIntel: { rumors: [] },
      /* M17 Fase A (decisione #83): Dispacci & Missioni + Memoria Storica.
         missions = offerte/incarichi; memoria = log milestone permanente
         (uncapped); dispatchMeta = stato del generatore (cooldown/contatori). */
      missions: [],
      memoria: [],
      dispatchMeta: { lastOfferAt: -1, offers: 0, completed: 0 },
      /* M17 Fase B (#83): contractor Mekhari (cacciatori di taglie). */
      contracts: [],
      /* M17 Fase C (#83): crisi pendenti + meta soglie ICG + anomalie esplorabili. */
      crises: [],
      crisisMeta: { icgTier: 0 },
      anomalies: {},
      /* Identità del popolo del giocatore (decisione #65): { prefix, proper }.
         Default derivato dalla colonia natale dopo colonizeHomePlanet se non
         passato dal menu. Persistito (schema 20). */
      empire: (opts.empire && opts.empire.proper)
        ? { prefix: opts.empire.prefix || 'repubblica', proper: String(opts.empire.proper) }
        : null
    };
    // startDS = Data Stellare INIZIALE (epoca .00), fissa per la partita.
    game.startDS = ORION.time.format(startOrbita * 100);

    // M04/M06.5: colonizza il pianeta natale (scelta esplicita se passata
    // dal menu, altrimenti homeWorld flaggato da system.js).
    colonizeHomePlanet(game, game.startDS);
    /* Decisione #45: auto-promuove la home come capitale del proprio gruppo
       (idempotente: non sovrascrive una capitale già designata). */
    if (ORION.capital && ORION.capital.initFromHome) {
      ORION.capital.initFromHome(game);
    }
    /* M14 Fase B2 (decisione #78): genera il Consiglio della Civiltà dal seed. */
    if (ORION.council && ORION.council.ensure) ORION.council.ensure(game);
    /* M12 Fase A2 (decisione #56 §15.4): saldo iniziale nella valuta della
       regione d'origine (solo per partite nuove — se c'è un payload, il
       restore sotto sovrascrive le balances). */
    if (!opts.payload && ORION.treasury && ORION.treasury.seedStartingBalance) {
      ORION.treasury.seedStartingBalance(game);
    }

    // M06: se c'è un payload (autosave/slot/import), ripristina i delta
    // sopra la galassia rigenerata. La galassia stessa resta sacra
    // (seed+delta, decisione #5).
    const saved = opts.payload || null;
    if (saved && saved.seed === seed) {
      game.timeImpulsi = saved.timeImpulsi || 0;
      /* Counter ID persistiti (equipaggi, ...). Riconciliati comunque al load
         da migrateLegacyCrewIds per i save vecchi privi del campo. */
      if (saved.idSeq && typeof saved.idSeq === 'object') game.idSeq = Object.assign({}, saved.idSeq);
      game.colonies = saved.colonies || game.colonies;
      game.homePlanetKey = saved.homePlanetKey || game.homePlanetKey;
      if (saved.mode) game.mode = saved.mode;
      if (saved.victoryTracks) game.victoryTracks = saved.victoryTracks;
      if (typeof saved.victoryFocus === 'string') game.victoryFocus = saved.victoryFocus;
      if (saved.eventSchedule) game.eventSchedule = saved.eventSchedule;
      if (Array.isArray(saved.expeditions)) game.expeditions = saved.expeditions.slice();
      if (Array.isArray(saved.fleets)) game.fleets = saved.fleets.slice();
      /* M16 (decisione #81): stazioni spaziali (entità top-level). */
      if (Array.isArray(saved.stations)) game.stations = saved.stations.slice();
      if (Array.isArray(saved.commanders)) game.commanders = saved.commanders.slice();
      /* M14 Fase A (#75): converte le figure legacy (specialization → role) e
         riallinea i rank labels. Idempotente — no-op se già in formato #75. */
      if (ORION.commander && ORION.commander.migrateAll) ORION.commander.migrateAll(game);
      /* M14 Fase B1 (#77): figure di colonia (pool idle; le assegnate vivono
         su colony.figure). Save pre-25 → pool vuoto. */
      if (Array.isArray(saved.colonyFigures)) game.colonyFigures = saved.colonyFigures.slice();
      if (ORION.colonyFigure && ORION.colonyFigure.ensure) ORION.colonyFigure.ensure(game);
      /* M14 Fase B2 (#78): Consiglio della Civiltà. Save pre-26 → ensure lo
         genera dal seed; altrimenti ripristina lo stato salvato. */
      if (saved.council && typeof saved.council === 'object') game.council = saved.council;
      /* M14 Fase B3 (#79): pool Luminari. */
      if (Array.isArray(saved.luminari)) game.luminari = saved.luminari.slice();
      if (ORION.council && ORION.council.ensure) ORION.council.ensure(game);
      /* M13 Fase A (decisione #57): ricerca tecnologica. Save pre-23 → null;
         ORION.research.ensure() sotto completa lo stato vuoto. */
      if (saved.research && typeof saved.research === 'object') {
        game.research = {
          catalogVersion: saved.research.catalogVersion || 1,
          unlocked: Array.isArray(saved.research.unlocked) ? saved.research.unlocked.slice() : [],
          activeProject: saved.research.activeProject || null,
          progress: saved.research.progress || 0,
          activationPaid: saved.research.activationPaid || null
        };
      }
      if (Array.isArray(saved.chronicle)) game.chronicle = saved.chronicle.slice();
      /* Decisione #45: ripristina mapping capitali; se vuoto, initFromHome
         sotto auto-popola con la home (retro-compat schema 6). */
      if (saved.capitals && typeof saved.capitals === 'object') {
        game.capitals = Object.assign({}, saved.capitals);
      }
      /* M10 Fase A (decisione #47): ripristina civiltà AI / pirati / ICG.
         Se il payload è di uno schema < 8 questi sono vuoti → ORION.ai.ensure()
         sotto li genera dal seed (la galassia preesiste, prende vita al load). */
      if (Array.isArray(saved.civs)) game.civs = saved.civs.slice();
      if (saved.piracy && typeof saved.piracy === 'object') game.piracy = saved.piracy;
      if (typeof saved.icg === 'number') game.icg = saved.icg;
      /* M09 Fase A (decisione #49): ripristina combattimenti pendenti +
         stato di guerra (retro-compat: schema < 9 → vuoti/morale pieno). */
      if (Array.isArray(saved.incursions)) game.incursions = saved.incursions.slice();
      if (Array.isArray(saved.battles)) game.battles = saved.battles.slice();
      /* M18.x (richiesta utente 2026-06-18): flotte ambientali AI in volo. */
      if (Array.isArray(saved.aiFleets)) game.aiFleets = saved.aiFleets.slice();
      /* M-journal (Diario Strategico): applica lo stato del Diario dal save.
         Additivo / lazy: se il save non ha `journal`, l'ensure al boot crea
         la struttura vuota. */
      if (saved.journal && typeof saved.journal === 'object') {
        game.journal = {
          pins: Array.isArray(saved.journal.pins) ? saved.journal.pins.slice() : [],
          nextId: (typeof saved.journal.nextId === 'number') ? saved.journal.nextId : 1
        };
      }
      if (saved.warState && typeof saved.warState === 'object') game.warState = saved.warState;
      /* M09 Fase B: sconfitta + verbi morali. */
      if (saved.defeated !== undefined) game.defeated = saved.defeated;
      if (saved.alignmentDeeds && typeof saved.alignmentDeeds === 'object') game.alignmentDeeds = saved.alignmentDeeds;
      /* M11 Fase A (decisione #51): reputazione globale (relation per-civ è
         dentro saved.civs). */
      if (typeof saved.reputation === 'number') game.reputation = saved.reputation;
      /* M10 Fase B (decisione #52 §13.6/§13.8): coesione di sistema + federazioni
         emergenti. Stato minimo (lista sysIds coesi al tick scorso, lista
         federations + trust). Schema 14+; per save pre-14 ensureState() al
         prossimo tick farà il setup lazy. */
      if (saved.cohesion && typeof saved.cohesion === 'object') {
        game.cohesion = saved.cohesion;
      }
      if (saved.federations && typeof saved.federations === 'object') {
        game.federations = saved.federations;
      }
      /* M12 Fase A1 (decisione #53 §15.2): rotte commerciali interne. I
         mercantili vivono in saved.colonies (auto-ripristinati). */
      if (Array.isArray(saved.tradeRoutes)) game.tradeRoutes = saved.tradeRoutes.slice();
      /* M12 Fase A2 (decisione #56 §15.4): Tesoreria — ripristina le balances
         (le valute si rigenerano dal seed). */
      if (saved.treasury && typeof saved.treasury === 'object' && saved.treasury.balances) {
        game.treasury = { balances: Object.assign({}, saved.treasury.balances) };
      }
      /* M12 Fase A2 (decisione #56 §15.3): accordi commerciali AI. */
      if (Array.isArray(saved.tradeAgreements)) game.tradeAgreements = saved.tradeAgreements.slice();
      if (Array.isArray(saved.wasteDeals)) game.wasteDeals = saved.wasteDeals.slice();
      /* M17 Fase A (decisione #83): Dispacci & Missioni + Memoria Storica. */
      if (Array.isArray(saved.missions)) game.missions = saved.missions.slice();
      if (Array.isArray(saved.memoria)) game.memoria = saved.memoria.slice();
      if (saved.dispatchMeta && typeof saved.dispatchMeta === 'object') {
        game.dispatchMeta = Object.assign({ lastOfferAt: -1, offers: 0, completed: 0 }, saved.dispatchMeta);
      }
      if (Array.isArray(saved.contracts)) game.contracts = saved.contracts.slice();
      if (Array.isArray(saved.crises)) game.crises = saved.crises.slice();
      if (saved.crisisMeta && typeof saved.crisisMeta === 'object') game.crisisMeta = Object.assign({ icgTier: 0 }, saved.crisisMeta);
      /* M18: storico delle ultime 20 mutazioni discrete di ICG/Reputazione.
         Additivo lazy (no bump schema): save vecchi → [] e il modulo lo
         inizializza al primo accesso via ORION.reputation.ensure(). */
      if (Array.isArray(saved.repHistory)) game.repHistory = saved.repHistory.slice(0, 20);
      if (saved.anomalies && typeof saved.anomalies === 'object') game.anomalies = Object.assign({}, saved.anomalies);
      /* M19 Fase A (spionaggio): operazioni coperte in corso. Additivo lazy
         (nessun bump di schema): save vecchi → ensure() sotto crea lo stato
         vuoto. civ.deepIntel vive dentro saved.civs (ripristinato wholesale). */
      if (saved.espionage && typeof saved.espionage === 'object') game.espionage = saved.espionage;
      /* FSP §17.7 (Fenomeni di Spazio Profondo): stato delta additivo (scoperta/
         proprietà). Save vecchi senza chiave → {}: gli FSP esistono comunque
         (rigenerati dal seed) e partono tutti a "Eco" come in partita nuova. */
      if (saved.phenomena && typeof saved.phenomena === 'object') game.phenomena = Object.assign({}, saved.phenomena);
      /* Presidi militari (#93) — fix B1: ora persistiti. */
      if (saved.garrisons && typeof saved.garrisons === 'object') {
        game.garrisons = Object.assign({}, saved.garrisons);
      }
      /* Intel grigia Mekhari (M19 §6e): voci acquistate (additivo, no migrazione).
         I marker per-civ flagSeen/greyIntel arrivano dentro saved.civs. */
      if (saved.mekhariIntel && Array.isArray(saved.mekhariIntel.rumors)) {
        game.mekhariIntel = { rumors: saved.mekhariIntel.rumors.slice() };
      }
      /* Identità del popolo (decisione #65, schema 20). Save pre-20 → null,
         il fallback sotto deriva il default dalla colonia natale. */
      if (saved.empire && saved.empire.proper) {
        game.empire = { prefix: saved.empire.prefix || 'repubblica', proper: String(saved.empire.proper) };
      }
      /* Schema 12: ripristina nebbia di guerra (sistemi esplorati/rilevati).
         Prima del fix la scoperta veniva persa al load → i sistemi esplorati
         tornavano grigi. Validazione difensiva: deve essere un array della
         stessa lunghezza della galassia, altrimenti recovery best-effort. */
      if (Array.isArray(saved.discovery) && saved.discovery.length === game.state.discovery.length) {
        for (let i = 0; i < saved.discovery.length; i++) {
          const v = saved.discovery[i];
          if (Number.isInteger(v) && v >= game.state.discovery[i]) {
            game.state.discovery[i] = v;
          }
        }
      } else {
        /* Save pre-schema-12: la nebbia di guerra non era persistita.
           Best-effort recovery dalle altre fonti del payload (colonie,
           flotte, spedizioni, parsing nomi sistema in cronaca). */
        recoverDiscoveryFromPayload(game, saved);
      }
      if (Number.isInteger(saved.selectedId) && saved.selectedId >= 0 && saved.selectedId < game.state.discovery.length) {
        game.state.selectedId = saved.selectedId;
      }
      /* Tutorial: rispetta lo stato del payload se presente. */
      if (saved.tutorial && typeof saved.tutorial === 'object') {
        game.tutorial = {
          enabled: !!saved.tutorial.enabled,
          seenLessons: Array.isArray(saved.tutorial.seenLessons) ? saved.tutorial.seenLessons.slice() : []
        };
      }
    }
    /* Identità del popolo (decisione #65): se non scelta dal menu né presente
       nel payload, deriva un default dalla colonia natale (es. "Repubblica di
       Glicine"). */
    if (!game.empire || !game.empire.proper) {
      game.empire = defaultEmpire(game);
    }
    /* Normalizza in ogni caso (idempotente) e mostra/nasconde la "?" in HUD. */
    if (ORION.tutorial && ORION.tutorial.initOnGame) {
      ORION.tutorial.initOnGame(game, tutorialEnabled);
    }
    /* Decisione #45: assicura che la home sia capitale del proprio gruppo
       anche dopo il restore di un save schema 6 (capitals: {} di default).
       Idempotente: se game.capitals contiene già un mapping per il gruppo
       della home, non fa nulla. */
    if (ORION.capital && ORION.capital.initFromHome) {
      ORION.capital.initFromHome(game);
    }
    /* M10 Fase A (decisione #47): genera le civiltà AI dal seed se assenti
       (partita nuova o save pre-schema-8). Idempotente: non rigenera se il
       payload conteneva già game.civs. Va DOPO colonizeHomePlanet così i
       sistemi del giocatore non vengono mai annessi alle AI. */
    if (ORION.ai && ORION.ai.ensure) {
      ORION.ai.ensure(game);
    }
    /* M11 Fase A (decisione #51): inizializza la reputazione globale §14 se
       assente (save pre-schema-11 → parte dall'anteprima M10). Idempotente. */
    if (ORION.diplomacy && ORION.diplomacy.ensureReputation) {
      ORION.diplomacy.ensureReputation(game);
    }
    /* M13 Fase A (decisione #57): inizializza lo stato ricerca se assente
       (partita nuova o save pre-schema-23). Idempotente. */
    if (ORION.research && ORION.research.ensure) {
      ORION.research.ensure(game);
    }
    /* M17 Fase A (decisione #83): inizializza Dispacci/Missioni/Memoria se
       assenti (partita nuova o save pre-schema-30) e ricostruisce il seen-set
       della Memoria. Idempotente. */
    if (ORION.dispatch && ORION.dispatch.ensure) {
      ORION.dispatch.ensure(game);
    }
    /* M19 Fase A (spionaggio): inizializza lo stato operazioni coperte se
       assente (partita nuova o save pre-M19). Idempotente. */
    if (ORION.espionage && ORION.espionage.ensure) {
      ORION.espionage.ensure(game);
    }
    if (ORION.anomaly && ORION.anomaly.ensure) {
      ORION.anomaly.ensure(game);
      /* Pre-scan dei sistemi-colonia (incluso il sistema natale): registra in
         game.anomalies i siti §17.3 deterministicamente, così la tab
         Esplorazione mostra subito le anomalie intra-sistema senza attendere
         che una flotta orbiti nel proprio sistema. Diagnostica utente
         2026-06-16: "non vedo le anomalie del mio stesso sistema". */
      if (ORION.anomaly.ensureSites) {
        const seen = {};
        Object.keys(game.colonies || {}).forEach(function (k) {
          const c = game.colonies[k];
          if (!c || c.systemId == null) return;
          if (seen[c.systemId]) return;
          seen[c.systemId] = true;
          ORION.anomaly.ensureSites(game, c.systemId);
        });
      }
    }
    /* FSP §17.7 (Fenomeni di Spazio Profondo): init stato delta + pre-genera la
       lista immutabile dal seed (cache su galaxy._phenomena). Idempotente:
       funziona identico su partita nuova e su save pre-FSP (delta vuoto → tutti
       a "Eco"). Niente rendering/interazione qui (Fasi 2-3). */
    /* M-journal: lazy-init del Diario Strategico. Idempotente. */
    if (ORION.journal && ORION.journal.ensure) {
      ORION.journal.ensure(game);
    }
    if (ORION.phenomena && ORION.phenomena.ensure) {
      ORION.phenomena.ensure(game);
      /* Baseline SILENZIOSA al boot/load: marca a CONTATTO gli FSP già in zone
         esplorate, così compaiono subito sulla mappa senza voci di Cronaca
         retroattive. Le NUOVE rilevazioni durante il gioco restano eventful
         (phenomena.tick le segnala). */
      if (ORION.phenomena.detect) ORION.phenomena.detect(game, null);
    }

    return game;
  }

  ORION.newgame = {
    create: create,
    defaultEmpire: defaultEmpire,
    colonizeHomePlanet: colonizeHomePlanet,
    cloneMode: cloneMode
  };
})(typeof window !== 'undefined' ? window : globalThis);
