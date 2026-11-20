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
    /* Algoritmo sistemi V2 (5-10 corpi). V1 era solo per save legacy. */
    galaxy.systemAlgVersion = 2;
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

    /* Ripristino da save (autosave/slot/import): i delta del payload sopra
       la galassia rigenerata dal seed (decisione #5). L'elenco dei campi è
       unico e vive in save.js (STATE_FIELDS). */
    const saved = opts.payload || null;
    if (saved && saved.seed === seed) {
      ORION.save.applyPayload(game, saved);
      /* Completano eventuali parti derivate (idempotenti). */
      if (ORION.colonyFigure && ORION.colonyFigure.ensure) ORION.colonyFigure.ensure(game);
      if (ORION.council && ORION.council.ensure) ORION.council.ensure(game);
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
