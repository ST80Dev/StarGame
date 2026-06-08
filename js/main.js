/* =====================================================================
   ORION EMPIRES — main.js
   Bootstrap della shell UI + integrazione del modulo M02 (Galassia).

   M01: navigazione tra viste.
   M02: genera la galassia procedurale (deterministica dal seed),
        monta la mappa a nodi su Canvas nel viewport, mostra i dettagli
        del sistema selezionato nel pannello destro.
   Il game loop temporale resta M05; qui la Data Stellare iniziale è solo
   impostata (epoca randomizzata dal seed, §4 / decisione #4).
   ===================================================================== */
'use strict';

const ORION = window.ORION || (window.ORION = {});

ORION.version = '0.6.6';

/* Etichette provvisorie del viewport per le viste non ancora implementate. */
ORION.viewLabels = {
  research:  { caption: 'VISTA RICERCA',    hint: "L'albero tecnologico arriverà più avanti nello sviluppo." },
  diplomacy: { caption: 'VISTA DIPLOMAZIA', hint: 'La diplomazia arriverà più avanti nello sviluppo.' }
};

/* Stato di partita corrente (in memoria). Il salvataggio è M06. */
ORION.game = null;
ORION.map = null;

/* Vista interna del sistema (M03): istanza attiva + id del sistema aperto. */
ORION.systemView = null;
ORION.openSystemId = -1;
ORION.currentSystem = null;

/* Vista pianeta (M04): istanza attiva + chiave del corpo aperto. */
ORION.planetView = null;
ORION.colonyDeck = null;        // M07.2 (decisione #44): Plancia di Colonia
ORION.openPlanetKey = null;     // "<sysId>:<bodyKey>" — pianeta navigato al centro
ORION.currentPlanet = null;
ORION.planetTab = 'colonia';    // 'colonia' | 'risorse' | 'strutture' | 'popolazione' | 'esplorazione' (M07)

/* Ultimo sistema annotato in cronaca (evita doppioni consecutivi). */
ORION.lastChronicleId = -1;

/* =====================================================================
   Decisione #50 — Plancia Operativa pinnata (dx indipendente dalla nav)
   `dxPinnedColonyKey` = colonia "in focus" del pannello dx. Quando l'utente
   cambia esplicitamente il selector → flag `dxIsPinned=true` e da quel
   momento la dx non segue più la navigazione. Quando false, segue le
   colonie mie aperte al centro come default comodo.
   ===================================================================== */
ORION.dxPinnedColonyKey = null;
ORION.dxIsPinned = false;
/* Tab in vita per la dx (separata da planetTab che è del centro). Stessi
   id ('colonia' | 'risorse' | ...) per coerenza con renderPlanetPanel. */
ORION.dxTab = 'colonia';
/* Cronaca: stato collassato (sx). Persistito in localStorage. */
ORION.chronicleCollapsed = true;
/* Stato delle sezioni della Plancia d'Impero (id → bool collassato).
   Accordion: una sola sezione aperta per volta (default: Roster). */
ORION.lpSectionCollapsed = { roster: false, nav: true, launcher: true };

/* Accordion Plancia d'Impero: apre SOLO `openId`, collassa le altre
   (chronicle inclusa). `openId === null` → tutte chiuse. */
function lpAccordionOpen(openId) {
  ['roster', 'nav', 'launcher'].forEach(function (k) {
    ORION.lpSectionCollapsed[k] = (k !== openId);
  });
  ORION.chronicleCollapsed = (openId !== 'chronicle');
}
/* Normalizza a una sola sezione aperta (per save vecchi con più aperte). */
function normalizeLpAccordion() {
  const order = ['roster', 'nav', 'launcher'];
  let openId = order.find(function (k) { return !ORION.lpSectionCollapsed[k]; }) || null;
  if (openId == null && !ORION.chronicleCollapsed) openId = 'chronicle';
  lpAccordionOpen(openId || 'roster');
}

/* =====================================================================
   Decisione #62 — Dashboard Impero (M07.3)
   Overlay al centro a livello Galassia/Gruppo: griglia di card-colonia
   con sparkline (telemetria volatile) + badge + click→focus mappa.
   `empireDeckOpen` è una preferenza UI (persistita in uiprefs, NON nel
   save). La telemetria vive in `ORION._empireTel` (volatile, ricostruita
   giocando — coerente con UI_GUIDE §9: non è stato di gioco).
   ===================================================================== */
ORION.empireDeck = null;
ORION.empireDeckOpen = true;       /* default aperto: il centro a galassia è altrimenti "freddo" */
ORION._empireTel = {};             /* { colonyKey: { pop:[], morale:[], stock:[], lastI } } */
const EMPIRE_TEL_MAX = 50;         /* finestra di rilevamenti per le sparkline */

/* Persistenza preferenze UI (NON nel save: vivono solo in localStorage,
   sono scelte di interfaccia indipendenti dalla partita). */
function loadUiPrefs() {
  try {
    const raw = localStorage.getItem('orion.uiprefs');
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d.chronicleCollapsed != null) ORION.chronicleCollapsed = !!d.chronicleCollapsed;
    if (d.lpSectionCollapsed && typeof d.lpSectionCollapsed === 'object') {
      Object.assign(ORION.lpSectionCollapsed, d.lpSectionCollapsed);
    }
    if (d.empireDeckOpen != null) ORION.empireDeckOpen = !!d.empireDeckOpen;
    /* La pin si recupera per partita (chiave seed-aware), perché un
       seed diverso → colonie diverse → il pin vecchio non è valido. */
  } catch (_) { /* niente */ }
  /* Accordion: forza una sola sezione aperta (anche per prefs vecchie). */
  normalizeLpAccordion();
}
function saveUiPrefs() {
  try {
    localStorage.setItem('orion.uiprefs', JSON.stringify({
      chronicleCollapsed: ORION.chronicleCollapsed,
      lpSectionCollapsed: ORION.lpSectionCollapsed,
      empireDeckOpen: ORION.empireDeckOpen
    }));
  } catch (_) { /* niente */ }
}
function loadDxPin(game) {
  try {
    if (!game || !game.seed) return;
    const raw = localStorage.getItem('orion.dxPin.' + game.seed);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d && d.key && game.colonies && game.colonies[d.key]) {
      ORION.dxPinnedColonyKey = d.key;
      ORION.dxIsPinned = !!d.pinned;
    }
  } catch (_) { /* niente */ }
}
function saveDxPin() {
  try {
    const g = ORION.game;
    if (!g || !g.seed) return;
    localStorage.setItem('orion.dxPin.' + g.seed, JSON.stringify({
      key: ORION.dxPinnedColonyKey, pinned: ORION.dxIsPinned
    }));
  } catch (_) { /* niente */ }
}

/* Lista colonie del giocatore (operative o in insediamento o in arrivo). */
function myColonyKeys() {
  const g = ORION.game;
  if (!g || !g.colonies) return [];
  return Object.keys(g.colonies).filter(function (k) {
    const c = g.colonies[k];
    return !!c && (c.colonized || c.colonizing || c.phase === 'settling');
  });
}

/* Risolve la colonia "attiva" per la dx (auto-follow se non pinned). */
function resolveDxColonyKey() {
  const g = ORION.game;
  if (!g) return null;
  const mine = myColonyKeys();
  if (!mine.length) return null;
  /* Se pinned e ancora valida → usala. */
  if (ORION.dxIsPinned && ORION.dxPinnedColonyKey && g.colonies[ORION.dxPinnedColonyKey]) {
    if (mine.indexOf(ORION.dxPinnedColonyKey) >= 0) return ORION.dxPinnedColonyKey;
  }
  /* Auto-follow: se il pianeta navigato al centro è una colonia mia,
     usa quella. Tradeoff (documentato in decisione #50): auto-follow
     finché non c'è pin esplicito, comodo nel caso comune. */
  if (ORION.openPlanetKey && mine.indexOf(ORION.openPlanetKey) >= 0) {
    return ORION.openPlanetKey;
  }
  /* Fallback: l'ultima usata (se valida) o home. */
  if (ORION.dxPinnedColonyKey && mine.indexOf(ORION.dxPinnedColonyKey) >= 0) {
    return ORION.dxPinnedColonyKey;
  }
  if (g.homePlanetKey && mine.indexOf(g.homePlanetKey) >= 0) return g.homePlanetKey;
  return mine[0];
}

/* ---------------------------------------------------------------------
   Generazione/avvio di una partita (galassia)
   --------------------------------------------------------------------- */
/* Persistenza M06 (decisione #24): tutta in `ORION.save` (js/save.js).
   Questi wrapper restano per dare un punto unico di chiamata dentro
   main.js e per rimanere idempotenti se save.js non fosse ancora carico
   (defensive). Slot multipli + export/import .json + cronaca persistita
   vivono nel modulo dedicato. */
function persistGame(game) {
  if (ORION.save && ORION.save.autosave) ORION.save.autosave(game);
  // Le colonie sono cambiate (build/colonize/advance): la mappa galassia
  // mostra anelli caldi sui sistemi colonizzati → forziamo un redraw.
  if (ORION.map && ORION.map.requestRender) ORION.map.requestRender();
}
function clearSavedGame() {
  if (ORION.save && ORION.save.clearAutosave) ORION.save.clearAutosave();
}

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

function newGame(seed, opts) {
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

  ORION.game = {
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
    /* M11 Fase B parziale: sistemi occupati dopo vittoria su civiltà AI.
       Lazy, additivo; nessun bump di schema. */
    occupations: {},
    /* Identità del popolo del giocatore (decisione #65): { prefix, proper }.
       Default derivato dalla colonia natale dopo colonizeHomePlanet se non
       passato dal menu. Persistito (schema 20). */
    empire: (opts.empire && opts.empire.proper)
      ? { prefix: opts.empire.prefix || 'repubblica', proper: String(opts.empire.proper) }
      : null
  };
  // startDS = Data Stellare INIZIALE (epoca .00), fissa per la partita.
  ORION.game.startDS = ORION.time.format(startOrbita * 100);

  // M04/M06.5: colonizza il pianeta natale (scelta esplicita se passata
  // dal menu, altrimenti homeWorld flaggato da system.js).
  colonizeHomePlanet(ORION.game, ORION.game.startDS);
  /* Decisione #45: auto-promuove la home come capitale del proprio gruppo
     (idempotente: non sovrascrive una capitale già designata). */
  if (ORION.capital && ORION.capital.initFromHome) {
    ORION.capital.initFromHome(ORION.game);
  }
  /* M12 Fase A2 (decisione #56 §15.4): saldo iniziale nella valuta della
     regione d'origine (solo per partite nuove — se c'è un payload, il
     restore sotto sovrascrive le balances). */
  if (!opts.payload && ORION.treasury && ORION.treasury.seedStartingBalance) {
    ORION.treasury.seedStartingBalance(ORION.game);
  }

  // M06: se c'è un payload (autosave/slot/import), ripristina i delta
  // sopra la galassia rigenerata. La galassia stessa resta sacra
  // (seed+delta, decisione #5).
  const saved = opts.payload || null;
  if (saved && saved.seed === seed) {
    ORION.game.timeImpulsi = saved.timeImpulsi || 0;
    ORION.game.colonies = saved.colonies || ORION.game.colonies;
    ORION.game.homePlanetKey = saved.homePlanetKey || ORION.game.homePlanetKey;
    if (saved.mode) ORION.game.mode = saved.mode;
    if (saved.victoryTracks) ORION.game.victoryTracks = saved.victoryTracks;
    if (saved.eventSchedule) ORION.game.eventSchedule = saved.eventSchedule;
    if (Array.isArray(saved.expeditions)) ORION.game.expeditions = saved.expeditions.slice();
    if (Array.isArray(saved.fleets)) ORION.game.fleets = saved.fleets.slice();
    if (Array.isArray(saved.chronicle)) ORION.game.chronicle = saved.chronicle.slice();
    /* Decisione #45: ripristina mapping capitali; se vuoto, initFromHome
       sotto auto-popola con la home (retro-compat schema 6). */
    if (saved.capitals && typeof saved.capitals === 'object') {
      ORION.game.capitals = Object.assign({}, saved.capitals);
    }
    /* M10 Fase A (decisione #47): ripristina civiltà AI / pirati / ICG.
       Se il payload è di uno schema < 8 questi sono vuoti → ORION.ai.ensure()
       sotto li genera dal seed (la galassia preesiste, prende vita al load). */
    if (Array.isArray(saved.civs)) ORION.game.civs = saved.civs.slice();
    if (saved.piracy && typeof saved.piracy === 'object') ORION.game.piracy = saved.piracy;
    if (typeof saved.icg === 'number') ORION.game.icg = saved.icg;
    /* M09 Fase A (decisione #49): ripristina combattimenti pendenti +
       stato di guerra (retro-compat: schema < 9 → vuoti/morale pieno). */
    if (Array.isArray(saved.incursions)) ORION.game.incursions = saved.incursions.slice();
    if (Array.isArray(saved.battles)) ORION.game.battles = saved.battles.slice();
    if (saved.warState && typeof saved.warState === 'object') ORION.game.warState = saved.warState;
    /* M09 Fase B: sconfitta + verbi morali. */
    if (saved.defeated !== undefined) ORION.game.defeated = saved.defeated;
    if (saved.alignmentDeeds && typeof saved.alignmentDeeds === 'object') ORION.game.alignmentDeeds = saved.alignmentDeeds;
    /* M11 Fase A (decisione #51): reputazione globale (relation per-civ è
       dentro saved.civs). */
    if (typeof saved.reputation === 'number') ORION.game.reputation = saved.reputation;
    /* M10 Fase B (decisione #52 §13.6/§13.8): coesione di sistema + federazioni
       emergenti. Stato minimo (lista sysIds coesi al tick scorso, lista
       federations + trust). Schema 14+; per save pre-14 ensureState() al
       prossimo tick farà il setup lazy. */
    if (saved.cohesion && typeof saved.cohesion === 'object') {
      ORION.game.cohesion = saved.cohesion;
    }
    if (saved.federations && typeof saved.federations === 'object') {
      ORION.game.federations = saved.federations;
    }
    /* M12 Fase A1 (decisione #53 §15.2): rotte commerciali interne. I
       mercantili vivono in saved.colonies (auto-ripristinati). */
    if (Array.isArray(saved.tradeRoutes)) ORION.game.tradeRoutes = saved.tradeRoutes.slice();
    /* M12 Fase A2 (decisione #56 §15.4): Tesoreria — ripristina le balances
       (le valute si rigenerano dal seed). */
    if (saved.treasury && typeof saved.treasury === 'object' && saved.treasury.balances) {
      ORION.game.treasury = { balances: Object.assign({}, saved.treasury.balances) };
    }
    /* M12 Fase A2 (decisione #56 §15.3): accordi commerciali AI. */
    if (Array.isArray(saved.tradeAgreements)) ORION.game.tradeAgreements = saved.tradeAgreements.slice();
    /* M11 Fase B parziale: sistemi occupati (additivo, no migrazione). */
    if (saved.occupations && typeof saved.occupations === 'object') {
      ORION.game.occupations = Object.assign({}, saved.occupations);
    }
    /* Identità del popolo (decisione #65, schema 20). Save pre-20 → null,
       il fallback sotto deriva il default dalla colonia natale. */
    if (saved.empire && saved.empire.proper) {
      ORION.game.empire = { prefix: saved.empire.prefix || 'repubblica', proper: String(saved.empire.proper) };
    }
    /* Schema 12: ripristina nebbia di guerra (sistemi esplorati/rilevati).
       Prima del fix la scoperta veniva persa al load → i sistemi esplorati
       tornavano grigi. Validazione difensiva: deve essere un array della
       stessa lunghezza della galassia, altrimenti recovery best-effort. */
    if (Array.isArray(saved.discovery) && saved.discovery.length === ORION.game.state.discovery.length) {
      for (let i = 0; i < saved.discovery.length; i++) {
        const v = saved.discovery[i];
        if (Number.isInteger(v) && v >= ORION.game.state.discovery[i]) {
          ORION.game.state.discovery[i] = v;
        }
      }
    } else {
      /* Save pre-schema-12: la nebbia di guerra non era persistita.
         Best-effort recovery dalle altre fonti del payload (colonie,
         flotte, spedizioni, parsing nomi sistema in cronaca). */
      recoverDiscoveryFromPayload(ORION.game, saved);
    }
    if (Number.isInteger(saved.selectedId) && saved.selectedId >= 0 && saved.selectedId < ORION.game.state.discovery.length) {
      ORION.game.state.selectedId = saved.selectedId;
    }
    /* Tutorial: rispetta lo stato del payload se presente. */
    if (saved.tutorial && typeof saved.tutorial === 'object') {
      ORION.game.tutorial = {
        enabled: !!saved.tutorial.enabled,
        seenLessons: Array.isArray(saved.tutorial.seenLessons) ? saved.tutorial.seenLessons.slice() : []
      };
    }
  }
  /* Identità del popolo (decisione #65): se non scelta dal menu né presente
     nel payload, deriva un default dalla colonia natale (es. "Repubblica di
     Glicine"). */
  if (!ORION.game.empire || !ORION.game.empire.proper) {
    ORION.game.empire = defaultEmpire(ORION.game);
  }
  /* Normalizza in ogni caso (idempotente) e mostra/nasconde la "?" in HUD. */
  if (ORION.tutorial && ORION.tutorial.initOnGame) {
    ORION.tutorial.initOnGame(ORION.game, tutorialEnabled);
  }
  /* Decisione #45: assicura che la home sia capitale del proprio gruppo
     anche dopo il restore di un save schema 6 (capitals: {} di default).
     Idempotente: se game.capitals contiene già un mapping per il gruppo
     della home, non fa nulla. */
  if (ORION.capital && ORION.capital.initFromHome) {
    ORION.capital.initFromHome(ORION.game);
  }
  /* M10 Fase A (decisione #47): genera le civiltà AI dal seed se assenti
     (partita nuova o save pre-schema-8). Idempotente: non rigenera se il
     payload conteneva già game.civs. Va DOPO colonizeHomePlanet così i
     sistemi del giocatore non vengono mai annessi alle AI. */
  if (ORION.ai && ORION.ai.ensure) {
    ORION.ai.ensure(ORION.game);
  }
  /* M11 Fase A (decisione #51): inizializza la reputazione globale §14 se
     assente (save pre-schema-11 → parte dall'anteprima M10). Idempotente. */
  if (ORION.diplomacy && ORION.diplomacy.ensureReputation) {
    ORION.diplomacy.ensureReputation(ORION.game);
  }

  setHudDate(ORION.time.currentDS(ORION.game));
  updateGlobalResourceHud();
  /* Cronaca: se abbiamo entry persistite, le ripristiniamo nel DOM;
     altrimenti partiamo da capo con la voce di benvenuto. */
  if (ORION.game.chronicle && ORION.game.chronicle.length) {
    restoreChronicleDom(ORION.game);
  } else {
    resetChronicle(galaxy, ORION.game.startDS);
  }
  persistGame(ORION.game);
  return ORION.game;
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
  game.colonies[galaxy.homeId + ':' + homeBody.key] = colony;
  game.homePlanetKey = galaxy.homeId + ':' + homeBody.key;
  updateGlobalResourceHud();
}

/* Aggrega lo stock di tutte le colonie nell'HUD risorse-base. La vera
   produzione/aggiornamento per Impulso arriverà con M05. */
function updateGlobalResourceHud() {
  const totals = { met: 0, en: 0, food: 0, water: 0 };
  let people = 0;
  if (ORION.game && ORION.game.colonies) {
    Object.keys(ORION.game.colonies).forEach(function (k) {
      const c = ORION.game.colonies[k];
      if (!c.colonized) return;
      totals.met += c.stock.met || 0;
      totals.en  += c.stock.en  || 0;
      totals.food += c.stock.food || 0;
      totals.water += c.stock.water || 0;
      // Popolazione: somma delle PERSONE reali (curva per-pianeta §9).
      const planet = planetForColony(c);
      if (planet) people += ORION.planet.peopleAt(ORION.planet.popUnits(c), planet);
    });
  }
  const setVal = function (key, v) {
    const el = document.querySelector('[data-bind="' + key + '"]');
    if (el) el.textContent = Math.round(v).toString();
  };
  setVal('metalli', totals.met);
  setVal('energia', totals.en);
  setVal('cibo', totals.food);
  setVal('acqua', totals.water);
  const popEl = document.querySelector('[data-bind="popolazione"]');
  if (popEl) { popEl.innerHTML = popAnimSpan('hud:pop', Math.round(people)); ensurePopAnim(); }
  updateGlobalIndicesHud();
  /* Decisione #50: la dx mostra lo stato della colonia in focus —
     rinfreschiamola con l'HUD globale. La sx (Roster) ha badge che
     dipendono da scarsità/coda ma re-renderarla ad ogni tick costa
     scroll-position della cronaca: la rifacciamo solo agli eventi
     "grossi" (build/colonize/load), non ad ogni resource hud. */
  if (ORION.game && document.querySelector('[data-bind="dx-content"]')) {
    renderDxPanel();
  }
  /* M07.3 (decisione #62): rinfresca la Dashboard Impero se visibile
     (no-op se la scena non è la mappa o il deck è chiuso). */
  updateEmpireDeck();
}

/* M10 Fase A (decisione #47): ICG §5.4 + Reputazione §14 come ANTEPRIMA.
   I valori veri/sistematizzati arrivano con M18; qui mostriamo l'output
   emergente dello strato AI (ICG dalle azioni delle civiltà maligne/buone,
   Reputazione dalla media delle disposizioni delle civiltà contattate). */
function updateGlobalIndicesHud() {
  const g = ORION.game;
  if (!g) return;
  const icgEl = document.querySelector('[data-bind="icg"]');
  if (icgEl && typeof g.icg === 'number') icgEl.textContent = Math.round(g.icg).toString();
  const repEl = document.querySelector('[data-bind="reputazione"]');
  if (repEl) {
    /* M11 (#51): Reputazione §14 sistematizzata (game.reputation). Fallback
       all'anteprima M10 per save non ancora migrati. */
    if (ORION.diplomacy && ORION.diplomacy.reputation) {
      repEl.textContent = ORION.diplomacy.reputation(g).toString();
    } else if (ORION.ai && ORION.ai.reputationPreview) {
      repEl.textContent = ORION.ai.reputationPreview(g).toString();
    }
  }
}

/* ---------------------------------------------------------------------
   Navigazione tra viste
   --------------------------------------------------------------------- */
function initNavigation() {
  /* Decisione #50: la navigazione vive ora nel pannello sx come sezione
     "Navigazione" dentro la Plancia d'Impero. Il binding avviene in
     renderLeftPanel() ogni volta che il pannello si ridisegna. La vista
     iniziale viene attivata da `enterGame()` (decisione #25). */
}

/* Wrapper: cambia la vista del centro come faceva il vecchio nav.
   Chiamato dai bottoni della navigazione e dai launcher (decisione #50). */
function navigateView(view) {
  if (!ORION.game) return;
  closeMobileSheets();   /* PR mobile: cambiare vista chiude eventuali sheet aperte */
  const stage = document.querySelector('[data-view-stage]');
  if (stage) renderView(stage, view);
  setNavActive(view);
  renderLeftPanel();
  updateMobileNavActive();
}

function renderView(stage, view) {
  if (!stage) return;

  // Galassia / Sistema / Pianeta condividono lo stage: ogni livello è un
  // layer sopra il precedente (#9). La mappa rimane sotto e preserva lo
  // zoom anche quando entriamo nel sistema o nel pianeta.
  if (view === 'galaxy' || view === 'group' || view === 'system' || view === 'planet') {
    if (!ORION.map) renderGalaxyView(stage);
    const g = ORION.game;

    if (view === 'group') {
      if (ORION.openPlanetKey) closePlanet();
      if (ORION.openSystemId >= 0) closeSystem();
      const selId = (g.state.selectedId >= 0) ? g.state.selectedId : g.galaxy.homeId;
      const cluster = g.galaxy.systems[selId].cluster;
      if (ORION.map) ORION.map.focusGroup(cluster);
      return;
    }

    if (view === 'planet') {
      // se non c'è ancora un sistema aperto, apriamo quello del pianeta natale
      const homeKey = g.homePlanetKey || (g.galaxy.homeId + ':b0');
      const parts = homeKey.split(':');
      const sysId = Number(parts[0]);
      const bKey = parts[1];
      if (ORION.openSystemId !== sysId) openSystem(sysId);
      openPlanet(sysId, bKey);
      return;
    }

    if (ORION.openPlanetKey) closePlanet();

    if (view === 'system') {
      const sid = (g && g.state.selectedId >= 0) ? g.state.selectedId : g.galaxy.homeId;
      openSystem(sid);
    } else if (ORION.openSystemId >= 0) {
      closeSystem();
    }
    return;
  }

  // M08 Fase A: vista Flotta dedicata (lista + ordini). La mappa attiva
  // sui canvas è Fase B.
  if (view === 'fleet') {
    if (ORION.planetView) { ORION.planetView.destroy(); ORION.planetView = null; ORION.openPlanetKey = null; ORION.currentPlanet = null; } if (ORION.planetOverlay) { ORION.planetOverlay.destroy(); ORION.planetOverlay = null; }
    if (ORION.systemView) { ORION.systemView.destroy(); ORION.systemView = null; ORION.openSystemId = -1; ORION.currentSystem = null; }
    if (ORION.map) { ORION.map.destroy(); ORION.map = null; }
    renderFleetView(stage);
    return;
  }

  // M10 Fase B (decisione #47): vista "Civiltà" — dossier delle civiltà AI
  // contattate + anteprima ICG/Reputazione. Read-only, niente diplomazia
  // interattiva (M11).
  if (view === 'civ') {
    if (ORION.planetView) { ORION.planetView.destroy(); ORION.planetView = null; ORION.openPlanetKey = null; ORION.currentPlanet = null; } if (ORION.planetOverlay) { ORION.planetOverlay.destroy(); ORION.planetOverlay = null; }
    if (ORION.colonyDeck) { ORION.colonyDeck.destroy(); ORION.colonyDeck = null; }
    if (ORION.systemView) { ORION.systemView.destroy(); ORION.systemView = null; ORION.openSystemId = -1; ORION.currentSystem = null; }
    if (ORION.map) { ORION.map.destroy(); ORION.map = null; }
    renderCivView(stage);
    return;
  }

  // M12 Fase A1 (decisione #53): vista "Mercato" — riepilogo d'impero del
  // commercio interno (capacità, rotte, mercantili). La gestione operativa
  // (crea/cancella, costruisci mercantili) vive nella tab Rotte per-colonia.
  if (view === 'market') {
    if (ORION.planetView) { ORION.planetView.destroy(); ORION.planetView = null; ORION.openPlanetKey = null; ORION.currentPlanet = null; } if (ORION.planetOverlay) { ORION.planetOverlay.destroy(); ORION.planetOverlay = null; }
    if (ORION.colonyDeck) { ORION.colonyDeck.destroy(); ORION.colonyDeck = null; }
    if (ORION.systemView) { ORION.systemView.destroy(); ORION.systemView = null; ORION.openSystemId = -1; ORION.currentSystem = null; }
    if (ORION.map) { ORION.map.destroy(); ORION.map = null; }
    renderMarketView(stage);
    return;
  }

  // Altre viste: smonta tutto e mostra il placeholder.
  if (ORION.planetView) { ORION.planetView.destroy(); ORION.planetView = null; ORION.openPlanetKey = null; ORION.currentPlanet = null; } if (ORION.planetOverlay) { ORION.planetOverlay.destroy(); ORION.planetOverlay = null; }
  if (ORION.colonyDeck) { ORION.colonyDeck.destroy(); ORION.colonyDeck = null; }
  if (ORION.systemView) { ORION.systemView.destroy(); ORION.systemView = null; ORION.openSystemId = -1; ORION.currentSystem = null; }
  if (ORION.map) { ORION.map.destroy(); ORION.map = null; }
  renderViewPlaceholder(stage, view);
}

function renderViewPlaceholder(stage, view) {
  const label = ORION.viewLabels[view] || { caption: view.toUpperCase(), hint: '' };
  stage.innerHTML =
    '<div class="viewport__placeholder">' +
      '<span class="viewport__glyph" aria-hidden="true">◈</span>' +
      '<p class="viewport__caption">' + label.caption + '</p>' +
      '<p class="viewport__hint">' + label.hint + '</p>' +
    '</div>';
}

/* ---------------------------------------------------------------------
   Vista Galassia: overlay (seed/comandi) + Canvas
   --------------------------------------------------------------------- */
function renderGalaxyView(stage) {
  if (ORION.planetView) { ORION.planetView.destroy(); ORION.planetView = null; }
  if (ORION.planetOverlay) { ORION.planetOverlay.destroy(); ORION.planetOverlay = null; }
  if (ORION.colonyDeck) { ORION.colonyDeck.destroy(); ORION.colonyDeck = null; }
  ORION.openPlanetKey = null;
  ORION.currentPlanet = null;
  if (ORION.systemView) { ORION.systemView.destroy(); ORION.systemView = null; }
  ORION.openSystemId = -1;
  ORION.currentSystem = null;
  if (ORION.map) { ORION.map.destroy(); ORION.map = null; }
  /* Decisione #5/#25: la partita nasce solo dal main menu — non più
     auto-generazione qui dentro. Se per qualche ragione manca, torniamo
     al menu (niente seed silenziosi). */
  if (!ORION.game) { showMainMenu(); return; }
  const g = ORION.game;

  stage.innerHTML =
    '<div class="galaxy-root">' +
      '<div class="galaxy-holder"></div>' +
      '<div class="system-holder" data-system-holder hidden></div>' +
      '<div class="planet-holder" data-planet-holder hidden></div>' +
      '<div class="colony-deck" data-colony-deck hidden aria-label="Plancia di colonia"></div>' +
      /* M07.3 (decisione #62): Dashboard Impero — overlay al centro a livello galassia. */
      '<div class="empire-deck" data-empire-deck hidden aria-label="Dashboard Impero"></div>' +
      '<button class="empire-deck-toggle" data-empire-toggle type="button" hidden aria-label="Mostra/nascondi Dashboard Impero"></button>' +
      '<nav class="galaxy-breadcrumb" data-breadcrumb aria-label="Percorso di navigazione"></nav>' +
      '<div class="galaxy-hint">Trascina · zoom rotella/pinch · <kbd>Shift</kbd>+trascina = ruota libera · <kbd>Alt</kbd>+trascina = roll · pinch a 2 dita ruota su touch</div>' +
    '</div>';

  const holder = stage.querySelector('.galaxy-holder');
  ORION.map = new ORION.GalaxyMap().mount(holder, g.galaxy, g.state, {
    onContext: onMapContext,
    onActivateSystem: (id) => openSystem(id),  // doppio click → vista interna (M03)
    // M08 polish (decisione #61): drag&drop dal canvas per ordinare flotte.
    onFleetPicked: (fleetId) => enterFleetPicker(fleetId),
    onFleetOrderRequest: (req) => applyFleetOrderFromMap(req),
    onFleetPickerCancel: () => exitFleetPicker(true)
  });

  setNavActive('galaxy');
  // contesto iniziale (galassia)
  onMapContext({ level: 'galaxy', groupId: -1, systemId: -1 });

  const seedChip = stage.querySelector('[data-action="copy-seed"]');
  if (seedChip) seedChip.addEventListener('click', () => {
    const seed = ORION.game && ORION.game.seed;
    if (!seed) return;
    const done = () => showToast('Seed ' + seed + ' copiato');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(seed).then(done, () => showToast('Seed: ' + seed));
    } else {
      showToast('Seed: ' + seed);
    }
  });

  /* M07.3 (decisione #62): Dashboard Impero — toggle + prima render. */
  const eToggle = stage.querySelector('[data-empire-toggle]');
  if (eToggle) eToggle.addEventListener('click', toggleEmpireDeck);
  updateEmpireDeck();
}

/* ---------------------------------------------------------------------
   Contesto di navigazione: breadcrumb + pannello destro coerente
   con la scala selezionata (Galassia / Gruppo / Sistema).
   --------------------------------------------------------------------- */
function onMapContext(ctx) {
  // Quando la vista interna del sistema è aperta, è lei a gestire
  // breadcrumb e pannello: ignora il contesto della mappa galassia.
  if (ORION.openSystemId >= 0) return;
  /* M06.6: tutorial — entrata nel livello "gruppo" (zoom o click su regione). */
  if (ORION.tutorial && ctx.level === 'group') ORION.tutorial.fire('galaxy');
  setNavActive(ctx.level === 'group' ? 'group' : 'galaxy');
  renderBreadcrumb(ctx);
  /* Decisione #50: la dx non segue più la navigazione — è la Plancia
     Operativa indipendente. Le info del sistema/gruppo/galassia selezionati
     vengono mostrate nell'action bar contestuale al centro e/o nella sx.
     Aggiorniamo solo l'action bar centro qui (e renderLeftPanel per refresh). */
  renderContextActionBar(ctx);
  renderLeftPanel();
  updateEmpireDeck();   /* #62: galassia↔gruppo restano scena mappa */
}

function renderBreadcrumb(ctx) {
  const el = document.querySelector('[data-breadcrumb]');
  if (!el) return;
  const g = ORION.game;
  const crumbs = [];
  crumbs.push('<button class="crumb' + (ctx.level === 'galaxy' && ctx.systemId < 0 ? ' is-current' : '') +
    '" data-crumb="galaxy" type="button">Galassia</button>');
  if (ctx.groupId >= 0 && (ctx.level === 'group' || ctx.systemId >= 0)) {
    const grp = findGroup(ctx.groupId);
    if (grp) crumbs.push('<span class="crumb__sep">›</span>' +
      '<button class="crumb' + (ctx.systemId < 0 ? ' is-current' : '') +
      '" data-crumb="group" data-id="' + grp.id + '" type="button">' + grp.name + '</button>');
  }
  if (ctx.systemId >= 0) {
    const sys = g.galaxy.systems[ctx.systemId];
    const known = g.state.discovery[ctx.systemId] >= ORION.galaxy.DISCOVERY.DETECTED;
    crumbs.push('<span class="crumb__sep">›</span>' +
      '<span class="crumb is-current">' + (known ? sys.name : 'Sistema ignoto') + '</span>');
  }
  el.innerHTML = crumbs.join('');

  el.querySelectorAll('[data-crumb]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.crumb === 'galaxy') ORION.map.focusGalaxy();
      else if (btn.dataset.crumb === 'group') ORION.map.focusGroup(Number(btn.dataset.id));
    });
  });
}

function findGroup(id) {
  const groups = ORION.game.galaxy.groups;
  for (let i = 0; i < groups.length; i++) if (groups[i].id === id) return groups[i];
  return null;
}

function row(k, v) { return '<div class="kv"><dt>' + k + '</dt><dd>' + v + '</dd></div>'; }

/* Sostantivo del corpo per etichette ("Ostilità pianeta/luna/oggetto"). */
function hostilityNoun(planet) {
  if (!planet) return 'corpo';
  if (planet.cat === 'moon') return 'luna';
  if (planet.cat === 'belt') return 'oggetto';
  return 'pianeta';
}

/* Popolazione (§9): il motore lavora in unità intere, ma a schermo le
   traduciamo in PERSONE plausibili via la curva per-pianeta di planet.js
   (ORION.planet.peopleAt / popCeiling / formatPeople). Solo presentazione:
   nessun calcolo tarato dipende da questi numeri. `units` può essere
   frazionario (pop.total + accum) per uno scorrimento fluido. */
function popPeople(units, planet) {
  return ORION.planet.formatPeople(ORION.planet.peopleAt(units, planet));
}
function popMaxPeople(planet) {
  const m = ORION.planet.popCeiling(planet);
  return m > 0 ? ORION.planet.formatPeople(m) : '—';
}
/* "Persone correnti / tetto del pianeta": il valore corrente è uno span
   animato (scorre verso il bersaglio, niente scatti), il tetto è il
   massimo demografico del pianeta (asintoto della curva). */
function popRangePeople(colony, planet) {
  const people = ORION.planet.peopleAt(ORION.planet.popUnits(colony), planet);
  const key = 'pop:' + colony.systemId + ':' + colony.bodyKey;
  return popAnimSpan(key, people) +
    ' <span class="pop-ceiling">/ ' + popMaxPeople(planet) + '</span>';
}

/* Memo runtime dei pianeti generati (deterministici dal seed): serve per
   sommare le persone nell'HUD senza rigenerare a ogni refresh. NON è
   serializzato — è solo una cache di derivati. */
ORION._planetMemo = ORION._planetMemo || {};
function planetForColony(colony) {
  if (!colony) return null;
  const key = colony.systemId + ':' + colony.bodyKey;
  let p = ORION._planetMemo[key];
  if (!p && ORION.game && ORION.game.galaxy) {
    const system = ORION.system.generate(ORION.game.galaxy, colony.systemId);
    p = ORION.planet.generate(ORION.game.galaxy, system, colony.bodyKey);
    if (p) ORION._planetMemo[key] = p;
  }
  return p;
}

/* ---------------------------------------------------------------------
   Decisione #26 — Tag di appartenenza (sigla regione, nome sistema)
   I corpi celesti hanno ora nomi propri dal tema del sistema (Zaffiro,
   Smeraldo…). Per non perdere il contesto di "dove sei" lo mostriamo
   come un piccolo tag accessorio accanto al nome, non dentro al nome.
   --------------------------------------------------------------------- */
function regionAcronymFor(sysId) {
  const g = ORION.game;
  if (!g) return '';
  const sys = g.galaxy.systems[sysId];
  if (!sys) return '';
  const grp = findGroup(sys.cluster);
  return (grp && grp.acronym) || '';
}

function tagHtml(text) {
  if (!text) return '';
  return ' <span class="name-tag">' + text + '</span>';
}

/* Tag per il nome di un sistema: [VLV] */
function systemTagHtml(sysId) {
  return tagHtml(regionAcronymFor(sysId));
}

/* Tag per il nome di un pianeta/luna: [VLV·Vega II] */
function bodyTagHtml(sysId) {
  const g = ORION.game;
  if (!g) return '';
  const sys = g.galaxy.systems[sysId];
  if (!sys) return '';
  const acr = regionAcronymFor(sysId);
  return tagHtml((acr ? acr + '·' : '') + sys.name);
}

/* --- Pannello: livello Galassia --- */
function renderGalaxyPanel(title, content) {
  const g = ORION.game;
  const DISCOVERY = ORION.galaxy.DISCOVERY;
  let known = 0, dangerSum = 0;
  g.state.discovery.forEach((d) => { if (d >= DISCOVERY.DETECTED) known++; });
  g.galaxy.systems.forEach((s) => { dangerSum += s.danger; });
  const avgDanger = Math.round(dangerSum / g.galaxy.count);

  title.textContent = 'Galassia';
  const regions = g.galaxy.groups.map((gp) =>
    '<button class="region-chip" data-region="' + gp.id + '" type="button" ' +
      'style="--rc:' + groupCss(gp.id) + '">' +
      (gp.id === g.galaxy.homeGroupId ? '★ ' : '') + gp.name + tagHtml(gp.acronym) +
      '<span class="region-chip__n">' + gp.members.length + '</span>' +
    '</button>'
  ).join('');

  content.innerHTML =
    '<div class="sysinfo">' +
      '<dl class="sysinfo__list">' +
        row('Galassia', '<strong>' + escapeHtml(ORION.names.galaxyName(g.seed)) + '</strong>') +
        row('Seed', '<code>' + g.seed + '</code>') +
        row('Sistemi', String(g.galaxy.count)) +
        row('Gruppi stellari', String(g.galaxy.groups.length)) +
        row('Noti', known + ' / ' + g.galaxy.count) +
        row('Data Stellare', ORION.time.currentDS(g)) +
        row('Pericolo medio', '<span class="danger-badge tier--' + ORION.galaxy.dangerTier(avgDanger) + '">' + avgDanger + '</span>') +
      '</dl>' +
      '<p class="sysinfo__sub">Gruppi stellari</p>' +
      '<div class="region-list">' + regions + '</div>' +
      '<p class="panel__note">Clicca un gruppo per entrare e vederne i sistemi.</p>' +
    '</div>';

  content.querySelectorAll('[data-region]').forEach((btn) => {
    btn.addEventListener('click', () => ORION.map.focusGroup(Number(btn.dataset.region)));
  });
}

/* --- Pannello: livello Gruppo stellare --- */
function renderGroupPanel(title, content, groupId) {
  const g = ORION.game;
  const DISCOVERY = ORION.galaxy.DISCOVERY;
  const grp = findGroup(groupId);
  if (!grp) { renderGalaxyPanel(title, content); return; }

  // distribuzione tipi stella: SOLO sui sistemi noti (nebbia di guerra §5.1)
  const typeCount = {};
  let known = 0;
  grp.members.forEach((sid) => {
    if (g.state.discovery[sid] < DISCOVERY.DETECTED) return;
    known++;
    const s = g.galaxy.systems[sid];
    typeCount[s.star] = (typeCount[s.star] || 0) + 1;
  });
  const types = Object.keys(typeCount).length
    ? Object.keys(typeCount).map((t) => {
        const def = g.galaxy.starTypes.find((x) => x.id === t);
        return (def ? def.label : t) + ' ×' + typeCount[t];
      }).join(', ')
    : '— da esplorare —';

  const rep = g.galaxy.systems[grp.repId];
  const isHome = grp.id === g.galaxy.homeGroupId;

  const sysList = grp.members.map((sid) => {
    const s = g.galaxy.systems[sid];
    const kn = g.state.discovery[sid] >= DISCOVERY.DETECTED;
    const sel = sid === g.state.selectedId;
    return '<button class="sys-chip' + (sel ? ' is-sel' : '') + (kn ? '' : ' is-fog') + '" ' +
      'data-sys="' + sid + '" type="button" title="' + (kn ? s.name : 'Sistema ignoto') + '">' +
      '<span class="sys-chip__dot" style="--sc:' + (kn ? starCss(g, s.star) : 'rgba(120,134,180,0.5)') + '"></span>' +
      (kn ? s.name : '— ignoto —') +
      (sid === g.galaxy.homeId ? ' ★' : '') +
    '</button>';
  }).join('');

  title.innerHTML = grp.name + tagHtml(grp.acronym);
  content.innerHTML =
    '<div class="sysinfo">' +
      (isHome ? '<p class="sysinfo__home">' + uiIcon('star', 'amber') + ' Regione d\'origine</p>' : '') +
      '<dl class="sysinfo__list">' +
        row('Sistemi', grp.members.length + ' (' + known + ' noti)') +
        row('Tipi stella', types) +
        row('Riferimento', rep.name) +
        row('Pericolo medio', '<span class="danger-badge tier--' + grp.dangerTier + '">' + grp.danger + ' · ' + grp.dangerTier + '</span>') +
      '</dl>' +
      '<p class="sysinfo__sub">Sistemi del gruppo</p>' +
      '<div class="sys-list">' + sysList + '</div>' +
      '<p class="panel__note">Clicca un sistema per i dettagli · doppio click per inquadrarlo.</p>' +
    '</div>';

  content.querySelectorAll('[data-sys]').forEach((btn) => {
    btn.addEventListener('click', () => ORION.map.selectSystem(Number(btn.dataset.sys)));
  });
}

/* --- Pannello: livello Sistema (dettagli del sistema selezionato) --- */
function renderSystemPanel(title, content, id) {
  const g = ORION.game;
  const sys = g.galaxy.systems[id];
  const disc = g.state.discovery[id];
  const DISCOVERY = ORION.galaxy.DISCOVERY;
  const isHome = id === g.galaxy.homeId;
  const known = disc >= DISCOVERY.DETECTED;
  const starType = g.galaxy.starTypes.find((t) => t.id === sys.star);

  title.innerHTML = known ? (sys.name + systemTagHtml(id)) : 'Sistema sconosciuto';

  if (!known) {
    content.innerHTML =
      '<div class="sysinfo">' +
        '<p class="sysinfo__fog">Posizione rilevata, dettagli ignoti.<br>' +
          'Richiede esplorazione.</p>' +
      '</div>';
    return;
  }

  const tierClass = 'tier--' + sys.dangerTier;
  content.innerHTML =
    '<div class="sysinfo">' +
      (isHome ? '<p class="sysinfo__home">' + uiIcon('star', 'amber') + ' Sistema di partenza</p>' : '') +
      '<dl class="sysinfo__list">' +
        row('Nome', sys.name + (sys.realName ? ' <span class="sysinfo__tag">reale</span>' : '')) +
        row('Stella', starType ? starType.label : sys.star) +
        row('Stato', disc === DISCOVERY.EXPLORED ? 'Esplorato' : 'Rilevato') +
        row('Rotte', String(sys.links.length)) +
        row('Pericolo',
          '<span class="danger-badge ' + tierClass + '">' + sys.danger + ' · ' + sys.dangerTier + '</span>') +
      '</dl>' +
      '<button class="btn btn--mini btn--enter btn--with-icon" data-action="enter-system" type="button">' +
        '<span class="ui-icon ui-icon--amber" aria-hidden="true">' + ((ORION.icon && ORION.icon('system')) || '') + '</span> Apri sistema' +
        '<span class="ui-icon ui-icon--soft" aria-hidden="true">' + ((ORION.icon && ORION.icon('chevronRight')) || '') + '</span>' +
      '</button>' +
      '<p class="panel__note">Vista interna: stella/e, corpi celesti in orbita e anomalie. Doppio click sul nodo per entrare.</p>' +
    '</div>';

  const enter = content.querySelector('[data-action="enter-system"]');
  if (enter) enter.addEventListener('click', () => openSystem(id));
}

/* =====================================================================
   M03 — Vista interna del sistema stellare
   Il SystemView è un layer sopra la mappa galassia (dentro .galaxy-root);
   breadcrumb e pannello destro diventano coerenti col livello Sistema.
   --------------------------------------------------------------------- */
function openSystem(id) {
  const g = ORION.game;
  if (!g) return;
  const root = document.querySelector('.galaxy-root');
  if (!root) return;

  const disc = g.state.discovery[id];
  const system = ORION.system.generate(g.galaxy, id);

  g.state.selectedId = id;
  ORION.openSystemId = id;
  ORION.currentSystem = system;

  chronicleSystemEntry(system, disc);

  const sysHolder = root.querySelector('[data-system-holder]');
  const galHolder = root.querySelector('.galaxy-holder');
  if (galHolder) galHolder.style.visibility = 'hidden';
  if (sysHolder) sysHolder.hidden = false;

  if (ORION.systemView) ORION.systemView.destroy();
  ORION.systemView = new ORION.SystemView().mount(sysHolder, system, {
    discovery: disc,
    onSelectBody: (key) => updateSystemUI(system, key),
    onActivateBody: (key) => openPlanet(id, key),
    onExit: () => {
      const cluster = g.galaxy.systems[id].cluster;
      closeSystem();
      if (ORION.map) ORION.map.focusGroup(cluster);
    }
  });

  setNavActive('system');
  setGalaxyHint('system');
  updateSystemUI(system, null);
  updateEmpireDeck();   /* #62: scena = sistema → nascondi Dashboard Impero */

  /* M06.6: tutorial — prima apertura di un sistema. */
  if (ORION.tutorial) ORION.tutorial.fire('system');
}

function closeSystem() {
  if (ORION.openPlanetKey) closePlanet();
  if (ORION.systemView) { ORION.systemView.destroy(); ORION.systemView = null; }
  ORION.openSystemId = -1;
  ORION.currentSystem = null;
  const root = document.querySelector('.galaxy-root');
  if (root) {
    const sysHolder = root.querySelector('[data-system-holder]');
    const galHolder = root.querySelector('.galaxy-holder');
    if (sysHolder) sysHolder.hidden = true;
    if (galHolder) galHolder.style.visibility = '';
  }
  setNavActive('galaxy');
  setGalaxyHint('galaxy');
  updateEmpireDeck();   /* #62: tornati alla mappa → ri-mostra Dashboard se aperta */
}

function updateSystemUI(system, bodyKey) {
  renderSystemBreadcrumb(system, bodyKey);
  /* Decisione #50: la dx non segue più. Le azioni contestuali
     (apri pianeta, colonizza, dossier AI) sono nell'action bar. */
  renderContextActionBar({ level: 'system', systemId: system.id, bodyKey: bodyKey || null });
  renderLeftPanel();
}

/* Breadcrumb: Galassia › Gruppo › Sistema › [Corpo] */
function renderSystemBreadcrumb(system, bodyKey) {
  const el = document.querySelector('[data-breadcrumb]');
  if (!el) return;
  const g = ORION.game;
  const grp = findGroup(g.galaxy.systems[system.id].cluster);
  const known = g.state.discovery[system.id] >= ORION.galaxy.DISCOVERY.DETECTED;
  const crumbs = ['<button class="crumb" data-crumb="galaxy" type="button">Galassia</button>'];
  if (grp) crumbs.push('<span class="crumb__sep">›</span>' +
    '<button class="crumb" data-crumb="group" data-id="' + grp.id + '" type="button">' + grp.name + '</button>');
  crumbs.push('<span class="crumb__sep">›</span>' +
    '<button class="crumb' + (bodyKey ? '' : ' is-current') + '" data-crumb="system" type="button">' +
    (known ? system.name : 'Sistema ignoto') + '</button>');
  if (bodyKey) {
    const body = ORION.system.findBody(system, bodyKey);
    crumbs.push('<span class="crumb__sep">›</span>' +
      '<span class="crumb is-current">' + (body ? body.name : '—') + '</span>');
  }
  el.innerHTML = crumbs.join('');

  el.querySelectorAll('[data-crumb]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.crumb;
      if (kind === 'galaxy') { closeSystem(); if (ORION.map) ORION.map.focusGalaxy(); }
      else if (kind === 'group') { const cl = Number(btn.dataset.id); closeSystem(); if (ORION.map) ORION.map.focusGroup(cl); }
      else if (kind === 'system') { if (ORION.systemView) ORION.systemView.selectBody(null); }
    });
  });
}

/* --- Pannello: livello Sistema (interno) --- */
function renderSystemInteriorPanel(title, content, system, disc) {
  const DISCOVERY = ORION.galaxy.DISCOVERY;
  const known = disc >= DISCOVERY.DETECTED;
  title.innerHTML = known ? (system.name + systemTagHtml(system.id)) : 'Sistema sconosciuto';

  if (!known) {
    content.innerHTML =
      '<div class="sysinfo"><p class="sysinfo__fog">Posizione rilevata, interno ignoto.<br>' +
        'Richiede esplorazione.</p></div>';
    return;
  }

  const explored = disc >= DISCOVERY.EXPLORED;
  const bodyCount = system.bodies.length;
  const tierClass = 'tier--' + system.dangerTier;
  const selKey = ORION.systemView ? ORION.systemView.selectedKey : null;

  let detail = '';
  if (explored) {
    const chips = system.bodies.map((b) => {
      const def = ORION.system.BODY_TYPES[b.type];
      const moonCount = b.moons ? b.moons.length : 0;
      const moonNote = moonCount
        ? '<span class="body-chip__moons" title="' + moonCount + ' lun' + (moonCount === 1 ? 'a' : 'e') + '">● ' + moonCount + '</span>'
        : '';
      const bodyColony = ORION.game.colonies[system.id + ':' + b.key] || null;
      let badge = '';
      let classMod = '';
      if (bodyColony && bodyColony.colonized) {
        if (bodyColony.isHomeBase) {
          badge = '<span class="body-chip__badge body-chip__badge--home" title="Pianeta base">★ BASE</span>';
          classMod = ' is-home';
        } else {
          badge = '<span class="body-chip__badge body-chip__badge--colony" title="Colonia attiva">◉ COLONIA</span>';
          classMod = ' is-colony';
        }
      } else if (b.homeWorld) {
        badge = '<span class="body-chip__badge body-chip__badge--candidate" title="Mondo natale candidato">★</span>';
      }
      return '<button class="sys-chip' + (b.key === selKey ? ' is-sel' : '') + classMod + '" data-body="' + b.key + '" type="button" title="' + def.label + '">' +
        '<span class="sys-chip__dot" style="--sc:' + bodyDotColor(b) + '"></span>' +
        '<span class="body-chip__name">' + b.name + '</span> · ' + def.label + badge + moonNote +
        '</button>';
    }).join('');
    detail = '<p class="sysinfo__sub">Corpi celesti</p><div class="sys-list">' + chips + '</div>';
    if (system.anomalies.length) {
      detail += '<p class="sysinfo__sub">Anomalie</p><ul class="anomaly-list">' +
        system.anomalies.map((a) => '<li class="anomaly-item anomaly--' + a.kind + '" title="' + a.desc + '">' + a.label + '</li>').join('') +
        '</ul>';
    }
  } else {
    detail = '<p class="panel__note">Sistema rilevato ma non scansionato: <strong>' + bodyCount +
      '</strong> corpi celesti individuati. Dettagli, tipi e anomalie richiedono l\'esplorazione.</p>';
  }

  content.innerHTML =
    '<div class="sysinfo">' +
      (system.isHome ? '<p class="sysinfo__home">' + uiIcon('star', 'amber') + ' Sistema di partenza</p>' : '') +
      '<dl class="sysinfo__list">' +
        row('Stella', system.stars.label) +
        row('Corpi', explored ? String(bodyCount) : bodyCount + ' (rilevati)') +
        row('Stato', explored ? 'Esplorato' : 'Rilevato') +
        row('Pericolo', '<span class="danger-badge ' + tierClass + '">' + system.danger + ' · ' + system.dangerTier + '</span>') +
      '</dl>' +
      detail +
      '<p class="panel__note">Clicca un oggetto per i dati base · doppio click per inquadrarlo.</p>' +
    '</div>';

  content.querySelectorAll('[data-body]').forEach((btn) => {
    btn.addEventListener('click', () => { if (ORION.systemView) ORION.systemView.selectBody(btn.dataset.body); });
  });
}

/* --- Pannello: livello Corpo celeste (dati base §6.3 + apri pianeta M04) --- */
function renderBodyPanel(title, content, system, body) {
  const def = ORION.system.BODY_TYPES[body.type];
  const catLabel = { rocky: 'Pianeta', gas: 'Gigante gassoso', moon: 'Luna', belt: 'Cintura asteroidale' }[def.cat] || '—';
  title.innerHTML = body.name + bodyTagHtml(system.id);

  let extra = '';
  if (body.parentKey) {
    const parent = ORION.system.findBody(system, body.parentKey);
    extra += row('Satellite di', parent ? parent.name : '—');
  } else if (def.cat !== 'belt') {
    extra += row('Orbita', '#' + ((body.index != null ? body.index : 0) + 1));
  }
  if (def.cat !== 'belt' && def.cat !== 'moon' && body.moons && body.moons.length) {
    extra += row('Lune', String(body.moons.length));
  }

  // M04: lo stato colonia (se esiste) e l'apertura della vista pianeta.
  const colKey = system.id + ':' + body.key;
  const colony = ORION.game.colonies[colKey] || null;
  let statusLine = '';
  if (def.cat === 'belt') statusLine = '<p class="panel__note">Cintura asteroidale: solo estrazione orbitale.</p>';
  else if (colony && colony.colonized) {
    statusLine = colony.isHomeBase
      ? '<p class="sysinfo__home">' + uiIcon('star', 'amber') + ' Pianeta base</p>'
      : '<p class="sysinfo__home">' + uiIcon('dotCircle', 'cyan') + ' Colonia attiva</p>';
  }

  content.innerHTML =
    '<div class="sysinfo">' +
      (body.homeWorld && !(colony && colony.colonized) ? '<p class="sysinfo__home">' + uiIcon('star', 'amber') + ' Mondo natale candidato</p>' : '') +
      statusLine +
      '<dl class="sysinfo__list">' +
        row('Tipo', def.label) +
        row('Classe', catLabel) +
        row('Abitabile', def.habitable ? 'Sì' : 'No') +
        extra +
      '</dl>' +
      '<p class="sysinfo__sub">Caratteristiche</p>' +
      '<dl class="sysinfo__list">' +
        row('Vantaggi', def.vantaggi) +
        row('Svantaggi', def.svantaggi) +
      '</dl>' +
      (def.cat !== 'belt'
        ? '<button class="btn btn--mini btn--enter btn--with-icon" data-action="enter-planet" type="button">' +
            '<span class="ui-icon ui-icon--blue" aria-hidden="true">' + ((ORION.icon && ORION.icon('planet')) || '') + '</span> Apri pianeta' +
            '<span class="ui-icon ui-icon--soft" aria-hidden="true">' + ((ORION.icon && ORION.icon('chevronRight')) || '') + '</span>' +
          '</button>' +
          '<p class="panel__note">Vista pianeta: sfera procedurale, risorse, strutture, popolazione.</p>'
        : '') +
    '</div>';

  const enter = content.querySelector('[data-action="enter-planet"]');
  if (enter) enter.addEventListener('click', function () { openPlanet(system.id, body.key); });
}

/* =====================================================================
   M04 — Vista Pianeta (livello "Pianeta" della navigazione gerarchica)
   Layer sopra system-holder (analogo a system-holder sopra galaxy-holder).
   ===================================================================== */
function openPlanet(sysId, bodyKey) {
  const g = ORION.game;
  if (!g) return;

  // assicurati che il sistema sia caricato (se entri dalla nav diretta)
  if (ORION.openSystemId !== sysId) openSystem(sysId);

  const system = ORION.currentSystem;
  const body = ORION.system.findBody(system, bodyKey);
  if (!body) return;
  const def = ORION.system.BODY_TYPES[body.type];
  if (def.cat === 'belt') return;   // cinture: nessuna vista pianeta

  const planet = ORION.planet.generate(g.galaxy, system, bodyKey);
  if (!planet) return;
  const colKey = sysId + ':' + bodyKey;
  let colony = g.colonies[colKey];
  if (!colony) {
    colony = ORION.planet.createColony(planet);
    g.colonies[colKey] = colony;
  }

  ORION.openPlanetKey = colKey;
  ORION.currentPlanet = planet;
  ORION.planetTab = colony.colonized ? 'risorse' : 'colonia';

  const root = document.querySelector('.galaxy-root');
  if (!root) return;
  const planetHolder = root.querySelector('[data-planet-holder]');
  const sysHolder = root.querySelector('[data-system-holder]');
  if (sysHolder) sysHolder.style.visibility = 'hidden';
  if (planetHolder) planetHolder.hidden = false;

  if (ORION.planetView) ORION.planetView.destroy();
  if (ORION.planetOverlay) { ORION.planetOverlay.destroy(); ORION.planetOverlay = null; }
  ORION.planetView = new ORION.PlanetView().mount(planetHolder, system, body, planet, colony, {
    onSelectMoon: function (mk) { openPlanet(sysId, mk); },
    onExit: function () { closePlanet(); }
  });

  /* Decisione #66: overlay SVG sopra il planet-canvas (sotto il deck)
     con marker strutture, anello orbitale, badge cardinali "vivi". */
  if (ORION.PlanetOverlay) {
    ORION.planetOverlay = new ORION.PlanetOverlay().mount(planetHolder, system, body, planet, colony);
  }

  /* M07.2 (decisione #44): Plancia di Colonia — overlay DOM con widget
     a cardinali (top-bar, risorse XXL, strutture costruite con "+Espandi",
     coda, popolazione, cronaca filtrata). Sincronia con la sidebar. */
  mountColonyDeck(planet, colony, body);

  setNavActive('planet');
  setGalaxyHint('planet');
  updatePlanetUI();
  updateEmpireDeck();   /* #62: scena = pianeta → nascondi Dashboard Impero */

  pushChronicle(ORION.time.currentDS(g) + ' — Apertura scheda planetaria di <strong>' + body.name + '</strong>' + bodyTagHtml(sysId) + '.', 'planet');

  /* M06.6: tutorial — prima apertura di un pianeta. */
  if (ORION.tutorial) ORION.tutorial.fire('planet');
}

function closePlanet() {
  if (ORION.planetView) { ORION.planetView.destroy(); ORION.planetView = null; }
  if (ORION.planetOverlay) { ORION.planetOverlay.destroy(); ORION.planetOverlay = null; }
  if (ORION.colonyDeck) { ORION.colonyDeck.destroy(); ORION.colonyDeck = null; }
  ORION.openPlanetKey = null;
  ORION.currentPlanet = null;
  const root = document.querySelector('.galaxy-root');
  if (root) {
    const planetHolder = root.querySelector('[data-planet-holder]');
    const sysHolder = root.querySelector('[data-system-holder]');
    const deckHolder = root.querySelector('[data-colony-deck]');
    if (planetHolder) planetHolder.hidden = true;
    if (sysHolder) sysHolder.style.visibility = '';
    if (deckHolder) deckHolder.hidden = true;
  }
  setNavActive('system');
  setGalaxyHint('system');
  // riallinea il pannello destro alla selezione corrente del sistema
  if (ORION.currentSystem) updateSystemUI(ORION.currentSystem, ORION.systemView ? ORION.systemView.selectedKey : null);
}

function updatePlanetUI() {
  renderPlanetBreadcrumb();
  /* M07.2: la Plancia di Colonia esiste solo se il corpo è colonizzato.
     Va creata "lazy" se la colonizzazione si completa mentre la vista
     pianeta è già aperta (caso più frequente: arrivi sul corpo NON
     colonizzato, lo colonizzi, il loop chiude colony.colonizing).      */
  const colony = ORION.openPlanetKey ? ORION.game.colonies[ORION.openPlanetKey] : null;
  if (colony && colony.colonized && ORION.currentPlanet) {
    if (!ORION.colonyDeck) {
      const body = ORION.system.findBody(ORION.currentSystem, ORION.currentPlanet.bodyKey);
      mountColonyDeck(ORION.currentPlanet, colony, body);
    } else {
      ORION.colonyDeck.refresh(ORION.currentPlanet, colony);
    }
    /* Decisione #66: tieni vivo l'overlay (marker + cardinali) ad ogni
       cambio di colonia (build/cancel/scarsità/insediamento/flotte). */
    if (ORION.planetOverlay) ORION.planetOverlay.refresh(ORION.currentPlanet, colony);
  } else if (ORION.colonyDeck) {
    /* Non più colonizzato (es. test/edge) o nessuna colonia: smonta. */
    ORION.colonyDeck.destroy();
    ORION.colonyDeck = null;
    const deckHolder = document.querySelector('[data-colony-deck]');
    if (deckHolder) deckHolder.hidden = true;
  }
  /* Decisione #50: la dx è ora indipendente — autofollow se non pinned.
     Se il pianeta navigato è una colonia mia, è la default. */
  renderDxPanel();
  /* Action bar contestuale al centro: colonizza / dossier AI / etc. */
  renderContextActionBar({
    level: 'planet',
    systemId: ORION.currentSystem ? ORION.currentSystem.id : -1,
    bodyKey: ORION.currentPlanet ? ORION.currentPlanet.bodyKey : null
  });
  /* M07.2 polish: lo sfondo "foreign" si monta/rinfresca quando si
     apre un pianeta AI (Punto 3). */
  refreshForeignDeck();
  renderLeftPanel();
}

/* M07.2 (decisione #44): monta la Plancia di Colonia.
   Le azioni del deck delegano alle stesse funzioni della sidebar
   (tryBuild / tryCancel / tutorial.openLesson) — sincronia totale. */
function mountColonyDeck(planet, colony, body) {
  if (!colony || !colony.colonized || !ORION.ColonyDeck) return;
  const root = document.querySelector('.galaxy-root');
  if (!root) return;
  const deckHolder = root.querySelector('[data-colony-deck]');
  if (!deckHolder) return;
  if (ORION.colonyDeck) ORION.colonyDeck.destroy();
  ORION.colonyDeck = new ORION.ColonyDeck().mount(deckHolder, planet, colony, body, {
    onBuild: function (id) { tryBuild(id); },
    onCancel: function (idx) { tryCancel(idx); },
    onInfo: function (id) {
      if (ORION.tutorial && ORION.tutorial.openLesson) {
        ORION.tutorial.openLesson('struct:' + id);
      }
    },
    onOpenTab: function (tabId) {
      ORION.planetTab = tabId;
      updatePlanetUI();
    }
  });
  /* Dopo il mount, ridimensiona la planet-view: ora che il deck DOM
     esiste, resize() misura la sua altezza e adatta fitR/cy della sfera
     in modo che non venga sopraffatta dalle card (M07.2 iter 3). */
  if (ORION.planetView && ORION.planetView.resize) {
    requestAnimationFrame(function () { ORION.planetView.resize(); });
  }
}

function renderPlanetBreadcrumb() {
  const el = document.querySelector('[data-breadcrumb]');
  if (!el) return;
  const g = ORION.game;
  const sys = ORION.currentSystem;
  const grp = findGroup(g.galaxy.systems[sys.id].cluster);
  const planet = ORION.currentPlanet;
  const body = ORION.system.findBody(sys, planet.bodyKey);
  const colKey = sys.id + ':' + planet.bodyKey;
  const colony = g.colonies && g.colonies[colKey];

  /* M07.2 polish (decisione #44): la breadcrumb del livello pianeta
     unifica anche le info che prima vivevano nella top-bar del deck e
     nel titleBadge del canvas (nome+tipo+chip fase/base). Stile dedicato
     `.crumb--body` per il nome pianeta (Orbitron grande). Info ausiliarie
     (tipo + chip) sulla destra in `.breadcrumb__info`. */
  const crumbs = ['<button class="crumb" data-crumb="galaxy" type="button">Galassia</button>'];
  if (grp) crumbs.push('<span class="crumb__sep">›</span>' +
    '<button class="crumb" data-crumb="group" data-id="' + grp.id + '" type="button">' + grp.name + '</button>');
  crumbs.push('<span class="crumb__sep">›</span>' +
    '<button class="crumb" data-crumb="system" type="button">' + sys.name + '</button>');
  crumbs.push('<span class="crumb__sep">›</span>' +
    '<span class="crumb crumb--body is-current">' + escapeHtml(body.name) + '</span>');

  const bodyDef = ORION.system.BODY_TYPES[planet.type];
  const typeLabel = bodyDef ? (bodyDef.label || planet.type) : planet.type;
  let phaseChip = '';
  if (colony && colony.phase === 'settling' && colony.settlingStart != null) {
    const dur = colony.settlingDuration || 60;
    const elapsed = Math.max(0, (g.timeImpulsi || 0) - colony.settlingStart);
    const pct = Math.min(100, Math.round((elapsed / dur) * 100));
    /* PR-D: chip phase con SVG icona (UI_GUIDE §3) — ⏳/◌ erano emoji
       codepoint con rendering OS-dependent. */
    phaseChip = '<span class="crumb-chip crumb-chip--phase">' + uiIcon('transition', 'violet') + ' Insediamento · ' + pct + '%</span>';
  } else if (colony && colony.colonizing) {
    phaseChip = '<span class="crumb-chip crumb-chip--phase">' + uiIcon('transition', 'violet') + ' Coloniale in viaggio</span>';
  } else if (colony && colony.isHomeBase) {
    phaseChip = '<span class="crumb-chip crumb-chip--home">' + uiIcon('star', 'amber') + ' Pianeta base · +20%</span>';
  } else if (colony && colony.colonized) {
    phaseChip = '<span class="crumb-chip">' + uiIcon('dotCircle', 'cyan') + ' Operativa</span>';
  }

  const infoHtml =
    '<div class="breadcrumb__info">' +
      '<span class="breadcrumb__type">' + escapeHtml(typeLabel) + '</span>' +
      phaseChip +
    '</div>';

  el.innerHTML =
    '<div class="breadcrumb__crumbs">' + crumbs.join('') + '</div>' +
    infoHtml;

  el.querySelectorAll('[data-crumb]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const kind = btn.dataset.crumb;
      if (kind === 'galaxy') { closePlanet(); closeSystem(); if (ORION.map) ORION.map.focusGalaxy(); }
      else if (kind === 'group') { const cl = Number(btn.dataset.id); closePlanet(); closeSystem(); if (ORION.map) ORION.map.focusGroup(cl); }
      else if (kind === 'system') { closePlanet(); }
    });
  });
}

/* --- Pannello: scheda pianeta con tab --- */
/* Stato di alert per ogni linguetta del pianeta (ambra/rosso). Usato
   per evidenziare attività in corso sulle schede non attive. */
function planetTabAlerts(colony) {
  const a = {};
  // strutture: coda di cantiere o osservatorio in scansione
  if (colony.queue && colony.queue.length) {
    a.strutture = colony.queue[0].target === 'demolish' ? 'bad' : 'info';
  } else if (colony.structures && colony.structures['osservatorio'] && colony.scanned && !colony.scanned.active) {
    a.strutture = 'info';
  }
  // risorse: scarsità low/crit
  if (colony.scarcity) {
    ['met','en','food','water'].forEach(function (k) {
      const s = colony.scarcity[k] && colony.scarcity[k].state;
      if (s === 'crit') a.risorse = 'bad';
      else if (s === 'low' && a.risorse !== 'bad') a.risorse = 'warn';
    });
  }
  // popolazione: malus morale temporaneo
  if (colony.moraleMalus) a.popolazione = 'warn';
  // colonia: insediamento o colonizzazione in corso
  if (colony.colonizing || colony.phase === 'settling') a.colonia = 'info';
  // forze: coda scafi/equipaggi attiva
  if (colony.assets && (
    (colony.assets.shipQueue && colony.assets.shipQueue.length) ||
    (colony.assets.crewQueue && colony.assets.crewQueue.length)
  )) a.forze = 'info';
  return a;
}

function alertTitle(tab, colony, level) {
  if (tab === 'strutture' && colony.queue && colony.queue.length) {
    const q = colony.queue[0];
    const def = ORION.structures.get(q.id);
    const verb = q.target === 'demolish' ? 'Smantellamento' : 'Costruzione';
    return verb + ' di ' + (def ? def.name : q.id) + ' (' + (q.duration | 0) + ' Ι)';
  }
  if (tab === 'strutture') return 'Osservatorio in scansione';
  if (tab === 'risorse') return level === 'bad' ? 'Scarsità critica' : 'Scarsità in allerta';
  if (tab === 'popolazione') return 'Morale in calo';
  if (tab === 'colonia') return colony.phase === 'settling' ? 'Insediamento in corso' : 'Colonizzazione in corso';
  if (tab === 'forze') return 'Reclutamento in corso';
  return '';
}

function renderPlanetPanel(title, content) {
  const planet = ORION.currentPlanet;
  const colony = ORION.game.colonies[ORION.openPlanetKey];
  const def = ORION.system.BODY_TYPES[planet.type];
  const sysId = ORION.currentSystem ? ORION.currentSystem.id : -1;
  title.innerHTML = planet.name + bodyTagHtml(sysId);

  /* M07 (decisione #37): tab Esplorazione visibile solo se la colonia ha
     mai prodotto scafi/equipaggi (o ne sta producendo / ha spedizioni
     attive da qui). Non vogliamo mostrarla preventivamente: sblocca quando
     l'utente costruisce Hangar/Accademia e avvia la prima produzione. */
  const hasExplorationAssets = colony.colonized && (
    (colony.ships && (colony.ships.explorer || 0) > 0) ||
    (colony.crews && Array.isArray(colony.crews.explorer) && colony.crews.explorer.length > 0) ||
    (colony.assets && ((colony.assets.shipQueue && colony.assets.shipQueue.length) ||
                       (colony.assets.crewQueue && colony.assets.crewQueue.length))) ||
    expeditionsForColony(colony).length > 0
  );
  /* Tab Forze (reclutamento — gancio M08/M14): visibile non appena è
     costruita una struttura che recluta personale (Hangar / Accademia).
     Tenuta separata da Strutture per non sovraccaricarla e per dare casa
     alle classi future (flotta da combattimento, figure speciali, …). */
  const hasRecruitment = colony.colonized && colony.structures && (
    !!colony.structures['cantiere-navale'] ||
    !!colony.structures['accademia-militare']
  );
  /* M12 Fase A1 (decisione #53): tab Rotte visibile non appena la colonia
     ha un Mercato §10 (l'hub delle rotte interne) o partecipa già a una
     rotta. La casa del commercio interno per-colonia. */
  const hasTrade = colony.colonized && (
    !!(colony.structures && colony.structures['mercato']) ||
    (Array.isArray(colony.mercantili) && colony.mercantili.length > 0) ||
    (ORION.trade && ORION.trade.routesForColony(ORION.game, ORION.openPlanetKey).length > 0)
  );
  const tabs = ['colonia', 'risorse', 'strutture', 'popolazione'];
  if (hasRecruitment) tabs.push('forze');
  if (hasExplorationAssets) tabs.push('esplorazione');
  if (hasTrade) tabs.push('rotte');
  if (!colony.colonized) ORION.planetTab = 'colonia';
  /* Fallback se la tab attiva non è più visibile. */
  if (ORION.planetTab === 'esplorazione' && !hasExplorationAssets) ORION.planetTab = 'colonia';
  if (ORION.planetTab === 'forze' && !hasRecruitment) ORION.planetTab = 'colonia';
  if (ORION.planetTab === 'rotte' && !hasTrade) ORION.planetTab = 'colonia';
  const activeTab = ORION.planetTab;
  const alerts = planetTabAlerts(colony);

  const head =
    '<div class="planet-head">' +
      '<p class="planet-head__type">' + def.label + (colony.isHomeBase ? ' · <strong>Pianeta base</strong>' : (colony.colonized ? ' · Colonia' : '')) + '</p>' +
    '</div>' +
    '<nav class="planet-tabs" role="tablist">' +
      tabs.map(function (t) {
        /* PR-B: icone SVG via ORION.icon + classe colore tematico
           coerente con UI_GUIDE §3 (un concetto = una tinta). */
        const meta = {
          colonia:      { iconName: 'home',      tone: 'amber',  label: 'Colonia',  full: 'Colonia' },
          risorse:      { iconName: 'resources', tone: 'gold',   label: 'Risorse',  full: 'Risorse' },
          strutture:    { iconName: 'build',     tone: 'cyan',   label: 'Strutt.',  full: 'Strutture' },
          popolazione:  { iconName: 'civ',       tone: 'pink',   label: 'Pop.',     full: 'Popolazione' },
          forze:        { iconName: 'forces',    tone: 'red',    label: 'Forze',    full: 'Forze e reclutamento' },
          esplorazione: { iconName: 'fleet',     tone: 'cyan',   label: 'Esplor.',  full: 'Esplorazione' },
          rotte:        { iconName: 'market',    tone: 'gold',   label: 'Rotte',    full: 'Rotte commerciali' }
        }[t];
        const iconSvg = (ORION.icon && ORION.icon(meta.iconName)) || '';
        const disabled = (!colony.colonized && t !== 'colonia');
        const isActive = (t === activeTab);
        const alert = alerts[t];
        const alertCls = (alert && !isActive) ? ' has-alert has-alert--' + alert : '';
        const titleFull = meta.full + (alert ? ' · ' + alertTitle(t, colony, alert) : '');
        const iconHtml = '<span class="planet-tab__icon ui-icon planet-tab__icon--' + meta.tone + '" aria-hidden="true">' + iconSvg + '</span>';
        const inner = isActive
          ? iconHtml + '<span class="planet-tab__label">' + meta.label + '</span>'
          : iconHtml;
        return '<button class="planet-tab' + (isActive ? ' is-active' : '') + alertCls + '" data-tab="' + t + '" type="button"' +
          ' title="' + titleFull + '" aria-label="' + titleFull + '"' +
          (disabled ? ' disabled' : '') + '>' + inner + '</button>';
      }).join('') +
    '</nav>' +
    '<div class="planet-tab-content" data-planet-tab-content></div>';
  content.innerHTML = head;

  content.querySelectorAll('[data-tab]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      ORION.planetTab = btn.dataset.tab;
      renderPlanetPanel(title, content);
    });
  });

  const host = content.querySelector('[data-planet-tab-content]');
  if (!host) return;
  if (activeTab === 'colonia')      renderPlanetColoniaTab(host, planet, colony);
  else if (activeTab === 'risorse') renderPlanetRisorseTab(host, planet, colony);
  else if (activeTab === 'strutture') renderPlanetStruttureTab(host, planet, colony);
  else if (activeTab === 'popolazione') renderPlanetPopolazioneTab(host, planet, colony);
  else if (activeTab === 'forze') renderPlanetForzeTab(host, planet, colony);
  else if (activeTab === 'esplorazione') renderPlanetEsplorazioneTab(host, planet, colony);
  else if (activeTab === 'rotte') renderPlanetRotteTab(host, planet, colony);

  /* M06.6: tutorial — schede per tab pianeta. Risorse copre l'idea delle
     avanzate mascherate (§7.2); Strutture copre slot/coda/durata. */
  if (ORION.tutorial) {
    if (activeTab === 'strutture') ORION.tutorial.fire('build');
    else if (activeTab === 'risorse' && planet.advanced && planet.advanced.length > 0) {
      ORION.tutorial.fire('advanced');
    }
    else if (activeTab === 'esplorazione') ORION.tutorial.fire('exploration');
    else if (activeTab === 'rotte') ORION.tutorial.fire('trade-routes');
  }
}

/* M07: ritorna le spedizioni che originano da una colonia (per UI).
   Decisione #60: legge sia game.expeditions (legacy/transitorio) che le flotte
   explore provenienti dalla colonia. Le flotte explore esposte come oggetti
   "expedition-like" per back-compat UI. */
function expeditionsForColony(colony) {
  const g = ORION.game;
  if (!g) return [];
  const key = colony.systemId + ':' + colony.bodyKey;
  const out = [];
  if (Array.isArray(g.expeditions)) {
    for (let i = 0; i < g.expeditions.length; i++) {
      const e = g.expeditions[i];
      if (e && e.originColonyKey === key && e.status !== 'done') out.push(e);
    }
  }
  if (Array.isArray(g.fleets)) {
    for (let i = 0; i < g.fleets.length; i++) {
      const f = g.fleets[i];
      if (!f || f.ownerColonyKey !== key) continue;
      if (!f.orders) continue;
      const t = f.orders.type;
      const isExploreLike = (t === 'explore') ||
        (t === 'return' && f.ships && f.ships.length === 1 &&
         f.ships[0] && f.ships[0].kind === 'explorer' &&
         (f.orders._migratedFromExplore || f.orders._migratedFromExpedition));
      if (!isExploreLike) continue;
      const ship = f.ships && f.ships[0];
      const crew = f.crew && f.crew[0];
      out.push({
        id: f.id,
        originColonyKey: key,
        targetSystemId: (t === 'explore') ? f.orders.toSysId : (f.route && f.route[f.route.length - 1]),
        status: (t === 'explore') ? 'outbound' : 'returning',
        durationOut: (t === 'explore') ? (f.etaImpulsi || 0) : 0,
        durationBack: (t === 'return') ? (f.etaImpulsi || 0) : null,
        shipWear: (ship && ship.wear) || 0,
        crewId: crew && crew.id,
        crewXp: (crew && crew.xp) || 0,
        incidents: [],
        _fleetRef: f
      });
    }
  }
  return out;
}

/* --- Tab Colonia / Colonizzazione --- */
function renderPlanetColoniaTab(host, planet, colony) {
  const g = ORION.game;
  const def = ORION.system.BODY_TYPES[planet.type];

  if (colony.colonized) {
    const out = ORION.planet.structureOutput(colony, planet, ORION.game);
    const scar = colony._scar;
    let scarRow = '';
    if (scar) {
      const labels = { met: 'Metalli', en: 'Energia', food: 'Cibo', water: 'Acqua' };
      const bits = [];
      ['met', 'en', 'food', 'water'].forEach(function (k) {
        if (scar[k].state !== 'ok') {
          const t = scar[k].state === 'crit' ? 'critica' : 'allerta';
          bits.push('<span class="scar-tag scar--' + scar[k].state + '">' + labels[k] + ' · ' + t + '</span>');
        }
      });
      if (bits.length) scarRow = '<p class="sysinfo__sub">Stato risorse</p><p class="scar-row">' + bits.join(' ') + '</p>';
    }
    /* Decisione #48 (Fase 0 — rifiuti): accumulo, saturazione e netto/Ι.
       Non è nell'HUD fisso: vive nella scheda colonia finché non diventa
       rilevante. Il "deperimento" è la saturazione che abbatte la produzione. */
    let wasteRow = '';
    if (ORION.time && ORION.time.wasteStatus) {
      const W = ORION.time.wasteStatus(colony);
      const pct = Math.round(W.saturation * 100);
      const cls = W.state === 'critico' ? 'crit' : W.state === 'saturo' ? 'low' : 'ok';
      const stateLbl = W.state === 'critico' ? 'critica' : W.state === 'saturo' ? 'satura' : 'nominale';
      const netTxt = (W.net > 0 ? '+' : '') + (Math.round(W.net * 10) / 10);
      const barPct = Math.min(100, pct);
      /* Guadagno energia temporaneo da riciclo (finché ci sono rifiuti da
         bruciare) — richiesta utente: renderlo visibile (decisione #48). */
      const enGain = Math.round((W.energyGain || 0) * 10) / 10;
      const enGainRow = enGain > 0
        ? row('Energia da riciclo', '<span class="waste-energy">+' + enGain + ' ' + resIcon('en') + '/' + iU() + '</span> <span class="waste-energy__note">(finché brucia)</span>')
        : '';
      wasteRow =
        '<p class="sysinfo__sub">Rifiuti ♻</p>' +
        '<dl class="sysinfo__list">' +
          row('Accumulo', Math.round(W.stock) + ' / ' + Math.round(W.capacity)) +
          row('Saturazione', '<span class="waste-tag waste--' + cls + '">' + stateLbl + ' · ' + pct + '%</span>') +
          row('Netto', impHtml(netTxt, '/') + (W.net > 0 ? ' (in accumulo)' : W.net < 0 ? ' (in calo)' : ' (stabile)')) +
          enGainRow +
        '</dl>' +
        '<div class="progress-bar"><div class="progress-bar__fill waste-fill--' + cls + '" style="width:' + barPct + '%"></div></div>' +
        (W.state !== 'ok'
          ? '<p class="waste-hint">La saturazione abbassa la produzione. Costruisci un <strong>Impianto di riciclo</strong> per trattare i rifiuti e recuperarne energia.</p>'
          : '');
    }
    /* M06.5 (decisione #27): banner fase Insediamento con countdown e
       progress bar. Recovery-friendly: finisce sempre da sola. */
    let settlingBanner = '';
    if (colony.phase === 'settling' && colony.settlingStart != null) {
      const dur = colony.settlingDuration || 60;
      const elapsed = Math.max(0, (g.timeImpulsi || 0) - colony.settlingStart);
      const remain = Math.max(0, dur - elapsed);
      const pct = Math.min(100, Math.round((elapsed / dur) * 100));
      settlingBanner =
        '<div class="settle-banner">' +
          '<p class="settle-banner__title">' + uiIcon('transition', 'violet') + ' Insediamento in corso</p>' +
          '<p class="settle-banner__hint">Produzione al 50% · +50% velocità prima struttura · crescita pop bloccata.</p>' +
          '<dl class="sysinfo__list">' +
            row('Restanti', impHtml(remain)) +
            row('Avanzamento', pct + '%') +
          '</dl>' +
          '<div class="progress-bar"><div class="progress-bar__fill" style="width:' + pct + '%"></div></div>' +
        '</div>';
    }
    /* Decisione #45: chip stato capitale al posto del banner +20% legacy.
       Il bonus +15% capitale piena ha sostituito il +20% home base (#8). */
    const isCap = (ORION.capital && ORION.capital.isCapital) ? ORION.capital.isCapital(g, ORION.openPlanetKey) : !!colony.isHomeBase;
    const capState = colony.capitalState && colony.capitalState.phase;
    let stateLine;
    if (capState === 'capital' || (isCap && !capState)) {
      stateLine = '<p class="sysinfo__home">' + uiIcon('star', 'gold') + ' Capitale di gruppo — bonus +15% produzione, +10 slot</p>';
    } else if (capState === 'pre-capital') {
      stateLine = '<p class="sysinfo__home">' + uiIcon('transition', 'cyan') + ' In transizione (entrante) — bonus capitale in attivazione</p>';
    } else if (capState === 'decommissioning') {
      stateLine = '<p class="sysinfo__home">' + uiIcon('transition', 'pink') + ' In decommissioning — malus −10% produzione fino al passaggio</p>';
    } else {
      stateLine = '<p class="sysinfo__home">' + uiIcon('dotCircle', 'cyan') + ' Colonia attiva</p>';
    }
    host.innerHTML =
      '<div class="sysinfo">' +
        settlingBanner +
        stateLine +
        '<dl class="sysinfo__list">' +
          row('Colonizzato dal', colony.colonizedDS || '—') +
          row('Popolazione', popRangePeople(colony, planet)) +
          row('Slot utilizzati', out.used + ' / ' + ORION.planet.effectiveSlots(planet, colony, g)) +
          row('Ostilità ' + hostilityNoun(planet), planet.hostility) +
        '</dl>' +
        scarRow +
        wasteRow +
        renderCapitalSection(colony, planet) +
        renderGovernorSection(colony, planet) +
      '</div>';
    bindGovernorHandlers(host, planet, colony);
    bindCapitalHandlers(host, planet, colony);
    ensurePopAnim();
    return;
  }

  // Colonizzazione in corso (M05)
  if (colony.colonizing) {
    const total = planet.colCost.impulsi;
    const remain = Math.max(0, colony.colonizing.duration | 0);
    const pct = Math.round(((total - remain) / total) * 100);
    host.innerHTML =
      '<div class="sysinfo">' +
        '<p class="sysinfo__home">◌ Spedizione coloniale in viaggio</p>' +
        '<dl class="sysinfo__list">' +
          row('Partenza',  colony.colonizing.startedAt || '—') +
          row('Restanti', remain + ' ' + iU()) +
          row('Avanzamento', pct + '%') +
        '</dl>' +
        '<div class="progress-bar"><div class="progress-bar__fill" style="width:' + pct + '%"></div></div>' +
        '<p class="panel__note">Avanza il tempo per veder arrivare la nave coloniale. La colonia si attiverà automaticamente.</p>' +
      '</div>';
    return;
  }

  // non colonizzato: scheda di valutazione + bottone "Colonizza"
  const cost = planet.colCost;
  const hostility = planet.hostility;
  const reasons = [];
  if (!def.habitable) reasons.push('Corpo non abitabile — solo estrazione.');
  const home = g.colonies[g.homePlanetKey];
  const homeColonized = !!(home && home.colonized);
  // §6.2: finché il primo pianeta è "produttivo" il costo è elevato — ma
  // se è in crisi (cibo/acqua critici), il costo torna basso ("migrazione
  // naturale forzata", §6.2 eccezione). Recovery-friendly (decisione M05).
  const homeInTrouble = !!(home && home._scar &&
    (home._scar.food.state === 'crit' || home._scar.water.state === 'crit'));
  const costMul = (homeColonized && !colony.isHomeBase && !homeInTrouble) ? 5 : 1;

  const stockHome = homeColonized ? home.stock : { met: 0, en: 0, food: 0, water: 0 };
  const canPay =
    stockHome.met   >= cost.met   * costMul &&
    stockHome.en    >= cost.en    * costMul &&
    stockHome.water >= cost.water * costMul &&
    stockHome.food  >= cost.food  * costMul;

  host.innerHTML =
    '<div class="sysinfo">' +
      '<p class="panel__note">Tutti i corpi sono colonizzabili, ma con caratteristiche diverse. La prima colonia condiziona tutto.</p>' +
      '<p class="sysinfo__sub">Potenziale risorse</p>' +
      potentialBars(planet) +
      '<p class="sysinfo__sub">Costo colonizzazione</p>' +
      '<dl class="sysinfo__list">' +
        row('Metalli',  Math.round(cost.met   * costMul)) +
        row('Energia',  Math.round(cost.en    * costMul)) +
        row('Acqua',    Math.round(cost.water * costMul)) +
        row('Cibo',     Math.round(cost.food  * costMul)) +
        row('Impulsi',  Math.round(cost.impulsi)) +
        row('Ostilità ' + hostilityNoun(planet), hostility) +
      '</dl>' +
      (costMul > 1 ? '<p class="panel__note">×' + costMul + ' perché la colonia primaria è ancora produttiva.</p>' : '') +
      (homeInTrouble ? '<p class="panel__note panel__note--warn"><span class="ui-icon panel__note-icon panel__note-icon--warn" aria-hidden="true">' + ((ORION.icon && ORION.icon('warning')) || '') + '</span> Crisi sulla colonia primaria: costo di migrazione ridotto.</p>' : '') +
      (reasons.length ? '<p class="panel__note">' + reasons.join(' ') + '</p>' : '') +
      '<button class="btn btn--mini btn--enter" data-action="colonize" type="button"' +
        (canPay && def.habitable ? '' : ' disabled') + '>◉ Colonizza ▸</button>' +
      '<p class="panel__note">Le spedizioni coloniali richiedono ' + cost.impulsi + ' Impulsi di viaggio. Avanza il tempo per veder arrivare la nave.</p>' +
    '</div>';

  const btn = host.querySelector('[data-action="colonize"]');
  if (btn) btn.addEventListener('click', function () { tryColonize(planet); });
}

/* --- Decisione #45: Capitale di Gruppo, sezione tab Colonia ---
   Max 1 capitale per gruppo. Bottone "Dichiara capitale" disponibile
   se la colonia è operativa e non è già capitale piena. Cambio supportato
   (transizione 80 Ι con malus −10% sulla vecchia e bonus 0 sulla nuova). */
function renderCapitalSection(colony, planet) {
  const g = ORION.game;
  if (!g || !ORION.capital) return '';
  if (colony.phase === 'settling') return '';
  const colKey = ORION.openPlanetKey;
  if (!colKey) return '';
  const cap = ORION.capital;
  const gid = cap.groupOfColony(g, colKey);
  if (gid == null) return '';
  /* Nome del gruppo per il bottone (sigla regione comoda). */
  const groups = (g.galaxy && g.galaxy.groups) || [];
  let groupName = 'gruppo';
  for (let i = 0; i < groups.length; i++) {
    if (groups[i].id === gid) {
      groupName = groups[i].name || groups[i].label || groupName;
      break;
    }
  }
  const isCap = cap.isCapital(g, colKey);
  const st = colony.capitalState && colony.capitalState.phase;
  const check = cap.canDeclare(g, colKey);
  const currentCapKey = cap.getOf(g, gid);
  let statusHtml;
  if (st === 'capital' || (isCap && !st)) {
    statusHtml = '<p class="capital-state capital-state--capital">★ Capitale del <strong>' + escapeHtml(groupName) + '</strong> — bonus +15% produzione, +10 slot.</p>';
  } else if (st === 'pre-capital') {
    const dur = colony.capitalState.transitionDuration || cap.TRANSITION_DURATION;
    const remain = Math.max(0, (colony.capitalState.transitionEnd || 0) - (g.timeImpulsi || 0));
    const pct = Math.min(100, Math.round(((dur - remain) / dur) * 100));
    statusHtml = '<p class="capital-state capital-state--pre-capital">◌ Transizione in corso (entrante) — ' + impHtml(remain) + ' al passaggio.</p>' +
      '<div class="capital-transition-bar"><div class="capital-transition-bar__fill" style="width:' + pct + '%"></div></div>';
  } else if (st === 'decommissioning') {
    const dur = colony.capitalState.transitionDuration || cap.TRANSITION_DURATION;
    const remain = Math.max(0, (colony.capitalState.transitionEnd || 0) - (g.timeImpulsi || 0));
    const pct = Math.min(100, Math.round(((dur - remain) / dur) * 100));
    statusHtml = '<p class="capital-state capital-state--decommissioning">◌ Decommissioning — malus −10% per altri ' + impHtml(remain) + '.</p>' +
      '<div class="capital-transition-bar capital-transition-bar--neg"><div class="capital-transition-bar__fill" style="width:' + pct + '%"></div></div>';
  } else {
    statusHtml = '<p class="capital-state">◉ Colonia di gruppo (non capitale).</p>';
  }
  let actionHtml = '';
  if (check.ok) {
    const label = currentCapKey
      ? 'Dichiara capitale del ' + groupName + ' (sostituisci attuale)'
      : 'Dichiara capitale del ' + groupName;
    actionHtml = '<button type="button" class="btn btn--mini capital-declare-btn" data-action="capital-declare">' +
      '★ ' + escapeHtml(label) +
      '</button>';
  } else if (st && (st === 'pre-capital' || st === 'decommissioning')) {
    actionHtml = '<p class="panel__note capital-section__hint">Transizione in corso — attendi che si stabilizzi.</p>';
  }
  return '<div class="capital-section" data-bind="capital-section">' +
    '<p class="sysinfo__sub capital-section__title">' +
      '<span class="capital-section__glyph" aria-hidden="true">★</span> Capitale di gruppo' +
    '</p>' +
    statusHtml +
    actionHtml +
    '<p class="panel__note capital-section__hint">Una sola capitale per gruppo stellare. Benefici futuri: sede ambasciata (diplomazia), figura Governatore di sector.</p>' +
  '</div>';
}

function bindCapitalHandlers(host, planet, colony) {
  if (!host) return;
  const btn = host.querySelector('[data-action="capital-declare"]');
  if (!btn) return;
  btn.addEventListener('click', function () {
    const g = ORION.game;
    if (!g || !ORION.capital) return;
    const colKey = ORION.openPlanetKey;
    const check = ORION.capital.canDeclare(g, colKey);
    if (!check.ok) { console.info('Dichiarazione rifiutata:', check.reason); return; }
    if (check.previousCapital) {
      const msg = 'Verrà sostituita la capitale attuale del gruppo. La transizione richiede ' +
        ORION.capital.TRANSITION_DURATION + ' Ι, durante i quali la vecchia capitale ha −10% produzione e la nuova ancora 0 bonus. Procedere?';
      if (!window.confirm(msg)) return;
    }
    const res = ORION.capital.declare(g, colKey, g.timeImpulsi || 0);
    if (!res.ok) return;
    /* Evento di cronaca a parte del tick (la dichiarazione è azione utente). */
    const cap = ORION.capital;
    const gid = cap.groupOfColony(g, colKey);
    const groups = (g.galaxy && g.galaxy.groups) || [];
    let groupName = 'gruppo';
    for (let i = 0; i < groups.length; i++) {
      if (groups[i].id === gid) { groupName = groups[i].name || groupName; break; }
    }
    pushChronicle(ORION.time.currentDS(g) + ' — <strong>' + escapeHtml(planet.name) + bodyTagHtml(planet.systemId) + '</strong> dichiarata capitale del <em>' + escapeHtml(groupName) + '</em> (transizione ' + cap.TRANSITION_DURATION + ' ' + iU() + ').', 'planet');
    if (ORION.tutorial && ORION.tutorial.fire) ORION.tutorial.fire('capital');
    persistGame(g);
    updatePlanetUI();
  });
}

/* --- M07.1 (decisione #40): Governatore coloniale, sezione tab Colonia ---
   Tier 1 "Vigile": solo notifiche, mai agisce. Sblocco ≥ 3 colonie
   operative (`ORION.governor.isAvailable`). Opt-in per colonia. */
function renderGovernorSection(colony, planet) {
  const g = ORION.game;
  if (!g || !ORION.governor) return '';
  if (colony.phase === 'settling') return '';
  if (!ORION.governor.isAvailable(g)) return '';
  const gov = ORION.governor.ensureState(colony);
  const enabled = !!gov.enabled;
  const level = gov.level || (enabled ? 'vigile' : 'off');
  const vocation = gov.vocation || 'equilibrata';
  const recent = Array.isArray(gov.recent) ? gov.recent : [];
  const decisions = Array.isArray(gov.decisions) ? gov.decisions : [];
  const ALERT_LABEL = {
    'gov-queue-empty':    'Coda di costruzione ferma',
    'gov-slots-idle':     'Slot inutilizzati',
    'gov-pop-near-cap':   'Popolazione vicina al tetto',
    'gov-supply-falling': 'Stock in calo',
    'gov-veterans-idle':  'Veterani disponibili'
  };
  const LEVELS = ORION.governor.LEVELS || ['off','vigile','operativo-cauto','operativo-attivo'];
  const VOCATIONS = ORION.governor.VOCATIONS || ['estrattiva','agricola','militare','ricerca','equilibrata'];
  const LEVEL_LABEL = ORION.governor.LEVEL_LABEL || {};
  const VOCATION_LABEL = ORION.governor.VOCATION_LABEL || {};

  const levelOpts = LEVELS.map(function (lv) {
    return '<option value="' + lv + '"' + (lv === level ? ' selected' : '') + '>' +
           escapeHtml(LEVEL_LABEL[lv] || lv) + '</option>';
  }).join('');
  const vocOpts = VOCATIONS.map(function (v) {
    return '<option value="' + v + '"' + (v === vocation ? ' selected' : '') + '>' +
           escapeHtml(VOCATION_LABEL[v] || v) + '</option>';
  }).join('');

  const recentHtml = recent.length
    ? '<ul class="gov-log">' + recent.slice(0, 5).map(function (a) {
        const ds = ORION.time.format(a.impulso, 'compact');
        const sub = (a.kind === 'gov-supply-falling' && a.sub)
          ? ' · ' + (a.sub === 'food' ? 'cibo' : 'acqua') : '';
        return '<li class="gov-log__item"><span class="gov-log__ds">' + ds + '</span>' +
               '<span class="gov-log__msg">' + (ALERT_LABEL[a.kind] || a.kind) + sub + '</span></li>';
      }).join('') + '</ul>'
    : '<p class="panel__note gov-log__empty">Nessuna segnalazione recente.</p>';

  const isOperative = (level === 'operativo-cauto' || level === 'operativo-attivo');
  const decisionsHtml = isOperative ? (decisions.length
    ? '<ul class="gov-decisions__log">' + decisions.slice(0, 5).map(function (d) {
        const ds = ORION.time.format(d.impulso, 'compact');
        const SDEF = ORION.structures && ORION.structures.get(d.structId);
        const sname = SDEF ? SDEF.name : (d.structId || '—');
        const verb = d.kind === 'expand' ? 'Espande' : 'Costruisce';
        const lvl = d.level && d.level > 1 ? ' lvl ' + d.level : '';
        return '<li class="gov-log__item"><span class="gov-log__ds">' + ds + '</span>' +
               '<span class="gov-log__msg">' + verb + ' <strong>' + escapeHtml(sname) + '</strong>' + lvl + '</span></li>';
      }).join('') + '</ul>'
    : '<p class="panel__note gov-log__empty">Nessuna decisione recente.</p>') : '';

  const tierLabel = level === 'off' ? 'Off'
    : level === 'vigile' ? 'Tier 1 · Vigile'
    : level === 'operativo-cauto' ? 'Tier 2 · Operativo (cauto)'
    : level === 'operativo-attivo' ? 'Tier 2 · Operativo (attivo)'
    : level;

  const hint = level === 'off'
    ? 'Scegli un livello per delegare la gestione di questa colonia.'
    : level === 'vigile'
      ? 'Sorveglia coda, slot, popolazione, scorte e veterani — segnala in cronaca, non agisce.'
      : level === 'operativo-cauto'
        ? 'Accoda nuove strutture secondo la vocazione (mai espande, mai cancella). Auto-pausa in scarsità.'
        : 'Accoda nuove strutture ed espande moduli esistenti in surplus. Mai cancella. Auto-pausa in scarsità.';

  return '<div class="gov-section" data-bind="gov-section">' +
    '<div class="gov-section__head">' +
      '<p class="sysinfo__sub gov-section__title">' +
        '<span class="gov-section__glyph ui-icon" aria-hidden="true">' + ((ORION.icon && ORION.icon('settings')) || '') + '</span> ' +
        'Governatore <em>(' + escapeHtml(tierLabel) + ')</em>' +
      '</p>' +
    '</div>' +
    '<div class="gov-section__controls">' +
      '<label class="gov-select"><span>Livello</span>' +
        '<select data-action="gov-level">' + levelOpts + '</select>' +
      '</label>' +
      '<label class="gov-select"><span>Vocazione</span>' +
        '<select data-action="gov-vocation"' + (level === 'off' ? ' disabled' : '') + '>' + vocOpts + '</select>' +
      '</label>' +
      (isOperative ? '<button type="button" class="btn btn--ghost gov-suspend" data-action="gov-suspend">Sospendi</button>' : '') +
    '</div>' +
    '<p class="panel__note gov-section__hint">' + escapeHtml(hint) + '</p>' +
    (enabled ? '<div class="gov-section__panels">' +
       '<div class="gov-section__panel"><p class="panel__note gov-log__title">Segnalazioni</p>' + recentHtml + '</div>' +
       (isOperative ? '<div class="gov-section__panel"><p class="panel__note gov-log__title">Decisioni recenti</p>' + decisionsHtml + '</div>' : '') +
     '</div>' : '') +
  '</div>';
}
function bindGovernorHandlers(host, planet, colony) {
  if (!host) return;
  const persist = function () {
    if (ORION.save && ORION.save.autosave && ORION.game) ORION.save.autosave(ORION.game);
  };
  /* Backward compat: il vecchio checkbox toggle non c'è più, ma rebind
     code lato dx-panel può ancora cercarlo: no-op se assente. */
  const oldToggle = host.querySelector('[data-action="gov-toggle"]');
  if (oldToggle) {
    oldToggle.addEventListener('change', function (e) {
      if (!ORION.governor) return;
      ORION.governor.setEnabled(colony, e.target.checked);
      if (e.target.checked && ORION.tutorial) ORION.tutorial.fire('governor');
      persist();
      renderPlanetColoniaTab(host, planet, colony);
    });
  }
  /* Level dropdown (decisione #59). */
  const levelSel = host.querySelector('[data-action="gov-level"]');
  if (levelSel) {
    levelSel.addEventListener('change', function (e) {
      if (!ORION.governor) return;
      ORION.governor.setLevel(colony, e.target.value);
      if (e.target.value !== 'off' && ORION.tutorial) ORION.tutorial.fire('governor');
      persist();
      renderPlanetColoniaTab(host, planet, colony);
    });
  }
  /* Vocation dropdown (decisione #59). */
  const vocSel = host.querySelector('[data-action="gov-vocation"]');
  if (vocSel) {
    vocSel.addEventListener('change', function (e) {
      if (!ORION.governor) return;
      ORION.governor.setVocation(colony, e.target.value);
      if (ORION.tutorial) ORION.tutorial.fire('governor-vocation');
      persist();
      renderPlanetColoniaTab(host, planet, colony);
    });
  }
  /* Suspend button: torna a 'vigile' come stato "occhi extra ma niente
     azioni" — leva di recovery sempre disponibile (decisione #59/#22). */
  const susp = host.querySelector('[data-action="gov-suspend"]');
  if (susp) {
    susp.addEventListener('click', function () {
      if (!ORION.governor) return;
      ORION.governor.setLevel(colony, 'vigile');
      persist();
      renderPlanetColoniaTab(host, planet, colony);
    });
  }
}

function tryColonize(planet) {
  const g = ORION.game;
  const colKey = planet.systemId + ':' + planet.bodyKey;
  const colony = g.colonies[colKey];
  if (!colony || colony.colonized || colony.colonizing) return;
  const homeColony = g.colonies[g.homePlanetKey];
  if (!homeColony || !homeColony.colonized) return;
  const cost = planet.colCost;
  // §6.2: finché il primo pianeta è "produttivo" il costo è elevato.
  // §6.2 eccezione: se il pianeta base è in carestia/critico, il costo
  // torna basso (migrazione naturale forzata) — recovery-friendly.
  const homeInTrouble = !!(homeColony._scar &&
    (homeColony._scar.food.state === 'crit' || homeColony._scar.water.state === 'crit'));
  const mul = (homeInTrouble || colony.isHomeBase) ? 1 : 5;
  const totalCost = { met: cost.met * mul, en: cost.en * mul, food: cost.food * mul, water: cost.water * mul };
  const msg = '<p>Lanciare una spedizione coloniale verso <strong>' + escapeHtml(planet.name) + '</strong>?</p>' +
    '<p>Costo (×' + mul + '): <strong>' + formatCostHtml(totalCost) + '</strong><br>' +
    'Viaggio: <strong>' + cost.impulsi + ' Ι</strong> (' + ORION.time.format(cost.impulsi, 'duration') + ')</p>' +
    (mul > 1 ? '<p class="confirm-hint">Il moltiplicatore ×5 scade automaticamente se la base entra in carestia critica.</p>' : '');
  confirmAction({
    title: 'Spedizione coloniale',
    message: msg,
    confirmLabel: 'Lancia spedizione',
    onConfirm: function () { _doColonize(planet, colKey, colony, homeColony, totalCost, cost); }
  });
}
function _doColonize(planet, colKey, colony, homeColony, totalCost, cost) {
  const g = ORION.game;
  ['met', 'en', 'water', 'food'].forEach(function (k) {
    homeColony.stock[k] = Math.max(0, (homeColony.stock[k] || 0) - totalCost[k]);
  });
  // M05: la colonia entra in stato "in arrivo" — il loop la attiverà al
  // termine del countdown (Impulsi da §4.4/§6.2).
  colony.colonizing = {
    startedAt: ORION.time.currentDS(g),
    duration: cost.impulsi
  };
  pushChronicle(ORION.time.currentDS(g) + ' — Spedizione coloniale in viaggio verso <strong>' + planet.name + '</strong>' + bodyTagHtml(planet.systemId) + ' (' + cost.impulsi + ' ' + iU() + ').', 'planet');
  if (ORION.tutorial) ORION.tutorial.fire('specialization');
  /* M10 Fase B (decisione #52 §13.6): colonizzare in un sistema coeso
     costa −15 disposizione a ciascun proprietario AI. Recovery-friendly
     (#22): scelta consapevole, mai blocco. */
  if (ORION.cohesion && ORION.cohesion.applyColonizePenalty) {
    const nHit = ORION.cohesion.applyColonizePenalty(g, planet.systemId);
    if (nHit > 0) {
      pushChronicle(ORION.time.currentDS(g) + ' — Il consorzio locale di <strong>' + (g.galaxy.systems[planet.systemId] || {}).name + '</strong> reagisce: disposizione di ' + nHit + ' proprietari in calo.', 'civ');
    }
  }
  persistGame(g);
  updateGlobalResourceHud();
  updatePlanetUI();
  if (ORION.planetView) ORION.planetView.refresh(colony);
  if (ORION.planetOverlay) ORION.planetOverlay.refresh(planet, colony);
}

/* --- Tab Risorse --- */
function renderPlanetRisorseTab(host, planet, colony) {
  const out = ORION.planet.structureOutput(colony, planet, ORION.game);
  const advancedHtml = advancedResHtml(planet, colony);
  const stockRows = ['met', 'en', 'food', 'water'].map(function (k) {
    return row(resLabel(k), Math.round(colony.stock[k] || 0));
  }).join('');
  host.innerHTML =
    '<div class="sysinfo">' +
      '<p class="sysinfo__sub">Potenziali ' + bodyKindGen(planet) + '</p>' +
      potentialBars(planet) +
      '<p class="sysinfo__sub">Scorte in colonia</p>' +
      '<dl class="sysinfo__list">' + stockRows + '</dl>' +
      '<p class="sysinfo__sub">Produzione potenziale per Impulso</p>' +
      rateGrid(out.rates, out.upkeep, colony) +
      '<p class="sysinfo__sub">Risorse avanzate</p>' +
      advancedHtml +
    '</div>';
}

/* Saldo netto per Impulso che si otterrebbe espandendo (o costruendo)
   una struttura: produzione − consumo, dopo − prima. Tiene conto dei
   modificatori (es. fonderia che amplifica le miniere). */
function marginalNet(colony, planet, structId) {
  const before = ORION.planet.structureOutput(colony, planet, ORION.game);
  const cur = colony.structures[structId];
  const curLvl = cur ? (cur.level || 0) : 0;
  const clonedStructures = Object.assign({}, colony.structures);
  clonedStructures[structId] = { level: curLvl + 1, hp: cur ? cur.hp : 100 };
  const clonedColony = Object.assign({}, colony, { structures: clonedStructures });
  const after = ORION.planet.structureOutput(clonedColony, planet, ORION.game);
  const delta = {};
  ['met', 'en', 'food', 'water'].forEach(function (k) {
    const beforeNet = (before.rates[k] || 0) - (before.upkeep[k] || 0);
    const afterNet  = (after.rates[k]  || 0) - (after.upkeep[k]  || 0);
    delta[k] = afterNet - beforeNet;
  });
  return delta;
}

function deltaBalanceHtml(delta) {
  const parts = [];
  ['met', 'en', 'food', 'water'].forEach(function (k) {
    const v = delta[k] || 0;
    if (Math.abs(v) < 0.01) return;
    const sign = v > 0 ? '+' : '−';
    const val = Math.round(Math.abs(v) * 100) / 100;
    const cls = v > 0 ? 'struct-item__d--pos' : 'struct-item__d--neg';
    parts.push('<span class="' + cls + '">' + sign + val + ' ' + resIcon(k) + '</span>');
  });
  if (!parts.length) return '';
  return '<span class="struct-item__delta" title="Saldo netto per Impulso se costruita">' + parts.join(' ') + '</span>';
}

/* Badge livello con gradiente coerente al progresso lvl/maxLevel.
   - L1..L< quartile basso → ciano pallido (struttura appena seminata)
   - quartile medio → ciano acceso
   - quartile alto → ambra
   - prossimo al max → arancio acceso
   - lvl = maxLevel → oro con bagliore (apice). */
function levelBadgeHtml(lvl, maxL) {
  let cls;
  if (lvl >= maxL) {
    cls = 'lv-max';
  } else {
    const ratio = maxL > 1 ? (lvl - 1) / (maxL - 1) : 0;
    if (ratio < 0.25) cls = 'lv-1';
    else if (ratio < 0.50) cls = 'lv-2';
    else if (ratio < 0.75) cls = 'lv-3';
    else cls = 'lv-4';
  }
  return '<span class="struct-item__lvl-badge ' + cls + '" title="Livello ' + lvl + ' di ' + maxL + '">L' + lvl + '</span>';
}

/* --- Tab Strutture --- */
function renderPlanetStruttureTab(host, planet, colony) {
  const S = ORION.structures;
  const used = Object.keys(colony.structures).reduce(function (a, id) {
    const d = S.get(id); return a + S.slotFootprint(d, colony.structures[id].level || 1);
  }, 0);
  const inQueue = colony.queue.reduce(function (a, q) {
    const d = S.get(q.id); return a + ((d && d.slots) || 1);
  }, 0);
  const queueCount = colony.queue.length;

  let html = '<div class="sysinfo">' +
    '<p class="planet-slots">Slot · <strong>' + (used + inQueue) + ' / ' + ORION.planet.effectiveSlots(planet, colony, ORION.game) + '</strong>' +
      (queueCount ? ' <span class="planet-slots__queue">(' + queueCount + ' ' + (queueCount === 1 ? 'progetto' : 'progetti') + ' in coda · ' + inQueue + ' slot)</span>' : '') + '</p>';

  // in coda — con countdown e barra di avanzamento (M05)
  if (colony.queue.length) {
    html += '<p class="sysinfo__sub">In costruzione</p><ul class="struct-list">';
    colony.queue.forEach(function (q, idx) {
      const def = S.get(q.id);
      const isDemo = q.target === 'demolish';
      /* Usa il totalTime memorizzato sull'entry (cattura stepTime al livello
         giusto). Fallback per save legacy: ricalcola da stepTime(toLevel). */
      const fallbackTotal = isDemo
        ? Math.max(1, Math.round((def.time || 2) / 2))
        : (S.stepTime ? S.stepTime(def, q.toLevel || 1) : (def.time || 1));
      const total = q.totalTime || fallbackTotal;
      const remain = Math.max(0, Math.ceil(q.duration || 0));
      const pct = Math.round(((total - remain) / total) * 100);
      const label = isDemo ? ('Smantellamento di ' + def.name) : def.name;
      const cancelTitle = isDemo ? 'Annulla smantellamento (nessuna penalità)' : 'Annulla (rimborso 80%)';
      html += '<li class="struct-item is-queue' + (isDemo ? ' is-demolish' : '') + '">' +
        '<span class="struct-item__glyph">' + def.glyph + '</span>' +
        '<div class="struct-item__main">' +
          '<div class="struct-item__name">' + label + ' ' + impHtml(remain + ' / ' + total) + '</div>' +
          '<div class="progress-bar progress-bar--mini"><div class="progress-bar__fill" style="width:' + pct + '%"></div></div>' +
        '</div>' +
        '<button class="btn btn--mini btn--icon-only struct-item__cancel" data-cancel="' + idx + '" type="button" title="' + cancelTitle + '" aria-label="Annulla">' + uiIcon('close', 'pink') + '</button>' +
      '</li>';
    });
    html += '</ul>';
  }

  // Osservatorio in scansione (decisione M05): mostra il progresso
  if (colony.structures['osservatorio'] && !colony.scanned.active) {
    const lvl = colony.structures['osservatorio'].level || 1;
    const total = ORION.time.CFG.SCAN_OBSERVATION_I;
    const cur = Math.min(total, colony.scanned.progress || 0);
    const pct = Math.round(cur * 100 / total);
    const remain = Math.max(0, Math.ceil((total - cur) / lvl));
    html += '<p class="sysinfo__sub">Osservatorio · scansione</p>' +
      '<div class="struct-item is-queue">' +
        '<span class="struct-item__glyph">◎</span>' +
        '<div class="struct-item__main">' +
          '<div class="struct-item__name">Mappatura risorse avanzate ' + impHtml(remain) + '</div>' +
          '<div class="progress-bar progress-bar--mini"><div class="progress-bar__fill" style="width:' + pct + '%"></div></div>' +
        '</div>' +
      '</div>';
  }

  // Cantieri & Squadre (M07) → spostati nella tab dedicata "Forze".
  // La tab si sblocca quando è costruita Hangar o Accademia.

  // Strutture — elenco unificato per categoria (decisione #42):
  // ogni voce mostra il proprio stato (costruita L<n> con "+ Espandi" /
  // costruibile con "+" / bloccata con motivo). Le code "In costruzione"
  // e "Osservatorio · scansione" restano blocchi separati sopra.
  const allDefs = S.buildableOn(planet.type);
  const byCat = {};
  allDefs.forEach(function (def) { (byCat[def.cat] = byCat[def.cat] || []).push(def); });
  html += '<p class="sysinfo__sub">Strutture</p>';
  Object.keys(S.CATEGORIES).forEach(function (cat) {
    const list = byCat[cat]; if (!list) return;
    const built = list.filter(function (d) { return !!colony.structures[d.id]; }).length;
    const countChip = ' <span class="struct-cat__count">' + built + '/' + list.length + '</span>';
    html += '<details class="struct-cat" open><summary>' + S.CATEGORIES[cat].glyph + ' ' + S.CATEGORIES[cat].label + countChip + '</summary><ul class="struct-list">';
    list.forEach(function (def) {
      const ent = colony.structures[def.id];
      if (ent) {
        // === BUILT ===
        const lvl = ent.level || 1;
        const maxL = def.maxLevel || 1;
        const demoCheck = ORION.planet.canDemolish(colony, planet, def.id);
        const demoBtn = demoCheck.ok
          ? '<button class="btn btn--mini btn--icon-only struct-item__demolish" data-demolish="' + def.id + '" type="button" title="' + (lvl >= 2 ? ('Downgrade lvl ' + lvl + '→' + (lvl - 1) + ' (rimborso 50% / 70% natale dello step lvl ' + lvl + ' · morale −0,10 per 30 Ι)') : 'Smantella (rimborso 50% / 70% natale del costo base · morale −0,10 per 30 Ι)') + '" aria-label="' + (lvl >= 2 ? 'Downgrade' : 'Smantella') + '">' + uiIcon('trash', 'pink') + '</button>'
          : '<span class="struct-item__locked is-busy" title="' + demoCheck.reason + '">' + uiIcon('trash', 'soft') + '</span>';
        let upBtn, infoLine, timeChip = '';
        if (lvl >= maxL) {
          upBtn = '<span class="struct-item__locked" title="Livello massimo (' + maxL + ')">max</span>';
          infoLine = '<div class="struct-item__cost struct-item__cost--max">Livello massimo</div>';
        } else {
          const up = ORION.planet.canBuild(colony, planet, def.id, ORION.game);
          const nextCost = S.stepCost(def, lvl + 1);
          const nextTime = S.stepTime(def, lvl + 1);
          const costStr = Object.keys(nextCost).map(function (k) { return '<span class="struct-item__cost-item">' + resIcon(k) + nextCost[k] + '</span>'; }).join(' ');
          const balance = deltaBalanceHtml(marginalNet(colony, planet, def.id));
          if (up.ok) {
            upBtn = '<button class="btn btn--mini btn--icon" data-build="' + def.id + '" type="button" title="Espandi a L' + (lvl + 1) + ' (+' + (def.slots || 1) + ' slot)" aria-label="Espandi">+</button>';
          } else {
            upBtn = '<span class="struct-item__locked struct-item__locked--icon" title="' + escapeHtml(up.reason) + '" aria-label="Espandi (bloccato)">+</span>';
          }
          timeChip = ' ' + impHtml(nextTime);
          infoLine = '<div class="struct-item__cost"><span class="struct-item__cost-label">L' + (lvl + 1) + '</span> ' + costStr + (balance ? ' ' + balance : '') + '</div>';
        }
        html += '<li class="struct-item is-built">' +
          '<span class="struct-item__glyph">' + def.glyph + '</span>' +
          '<div class="struct-item__main">' +
            '<div class="struct-item__name">' + levelBadgeHtml(lvl, maxL) + def.name + timeChip + '</div>' +
            infoLine +
          '</div>' +
          '<button class="btn btn--mini btn--icon-only struct-item__info" data-info="' + def.id + '" type="button" title="Cosa fa, bonus/malus, concatenazioni" aria-label="Informazioni su ' + def.name + '">' + uiIcon('info', 'violet') + '</button>' +
          upBtn + demoBtn +
        '</li>';
      } else {
        // === NON COSTRUITA ===
        const check = ORION.planet.canBuild(colony, planet, def.id, ORION.game);
        const cost = def.cost || {};
        const costStr = Object.keys(cost).map(function (k) { return '<span class="struct-item__cost-item">' + resIcon(k) + cost[k] + '</span>'; }).join(' ');
        const balance = deltaBalanceHtml(marginalNet(colony, planet, def.id));
        let statusCell;
        let extraClass = check.ok ? '' : ' is-locked';
        if (check.ok) {
          statusCell = '<button class="btn btn--mini btn--icon" data-build="' + def.id + '" type="button" title="Costruisci ' + escapeHtml(def.name) + '" aria-label="Costruisci ' + escapeHtml(def.name) + '">+</button>';
        } else if (check.code === 'building') {
          const qEntry = colony.queue.find(function (q) { return q.id === def.id; });
          const total = def.time || 1;
          const remain = qEntry ? Math.max(0, qEntry.duration | 0) : total;
          statusCell = '<span class="struct-item__locked is-building" title="In costruzione (' + remain + ' / ' + total + ' Ι)">▶ In costruzione · ' + impHtml(remain + '/' + total) + '</span>';
          extraClass += ' is-building';
        } else if (check.code === 'demolishing') {
          const qEntry = colony.queue.find(function (q) { return q.id === def.id; });
          const total = Math.max(1, Math.round((def.time || 2) / 2));
          const remain = qEntry ? Math.max(0, qEntry.duration | 0) : total;
          statusCell = '<span class="struct-item__locked is-demolish" title="In smantellamento (' + remain + ' / ' + total + ' Ι)">🛠 Smantellamento · ' + impHtml(remain + '/' + total) + '</span>';
          extraClass += ' is-building';
        } else if (check.code === 'busy') {
          statusCell = '<span class="struct-item__locked is-busy" title="' + check.reason + '">' + uiIcon('transition', 'soft') + ' Occupato</span>';
        } else {
          statusCell = '<span class="struct-item__locked" title="' + check.reason + '">◌</span>';
        }
        html += '<li class="struct-item' + extraClass + '" title="' + def.desc + '">' +
          '<span class="struct-item__glyph">' + def.glyph + '</span>' +
          '<div class="struct-item__main">' +
            '<div class="struct-item__name">' + def.name + ' ' + impHtml(def.time) + '</div>' +
            '<div class="struct-item__cost">' + costStr + (balance ? ' ' + balance : '') + '</div>' +
          '</div>' +
          '<button class="btn btn--mini btn--icon-only struct-item__info" data-info="' + def.id + '" type="button" title="Cosa fa, bonus/malus, concatenazioni" aria-label="Informazioni su ' + def.name + '">' + uiIcon('info', 'violet') + '</button>' +
          statusCell +
        '</li>';
      }
    });
    html += '</ul></details>';
  });

  html += '</div>';
  host.innerHTML = html;

  host.querySelectorAll('[data-build]').forEach(function (btn) {
    btn.addEventListener('click', function () { tryBuild(btn.dataset.build); });
  });
  host.querySelectorAll('[data-cancel]').forEach(function (btn) {
    btn.addEventListener('click', function () { tryCancel(Number(btn.dataset.cancel)); });
  });
  host.querySelectorAll('[data-demolish]').forEach(function (btn) {
    btn.addEventListener('click', function () { tryDemolish(btn.dataset.demolish); });
  });
  /* Listener cantieri/equipaggi: ora vivono nella tab Forze. */
  /* M06.7: bottone ⓘ apre la scheda tutorial della struttura (on-demand,
     ignora isEnabled — è un manuale leggero). */
  host.querySelectorAll('[data-info]').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (ORION.tutorial && ORION.tutorial.openLesson) {
        ORION.tutorial.openLesson('struct:' + btn.dataset.info);
      }
    });
  });
}

/* Helper: formatta il costo come riga "12 ⛭ · 5 ⚡" (HTML con resIcon). */
function formatCostHtml(cost) {
  if (!cost) return '—';
  const parts = [];
  ['met','en','food','water'].forEach(function (k) {
    const v = cost[k]; if (v == null || v === 0) return;
    const icon = (typeof resIcon === 'function') ? resIcon(k) : (typeof resGlyph === 'function' ? resGlyph(k) : '');
    parts.push(Math.round(v) + ' ' + icon);
  });
  return parts.join(' · ') || '—';
}

function tryBuild(id) {
  const g = ORION.game;
  /* Cattura il contesto colonia/pianeta AL MOMENTO del click, non al confirm:
     il dialog è asincrono, e se il click viene dalla Plancia dx (decisione #50)
     `withDxScope` ripristina `ORION.openPlanetKey` nel finally *prima* che
     l'utente confermi. Senza snapshot, _doBuild legge null e crasha. */
  const ctxKey = ORION.openPlanetKey;
  const ctxPlanet = ORION.currentPlanet;
  const colony = g.colonies[ctxKey];
  if (!colony || !ctxPlanet) { showToast('Nessuna colonia in focus'); return; }
  const def = ORION.structures.get(id);
  if (!def) return;
  const chk = ORION.planet.canBuild(colony, ctxPlanet, id, g);
  if (!chk.ok) { showToast(chk.reason || 'Costruzione rifiutata'); return; }
  const nextLevel = chk.nextLevel || 1;
  const cost = ORION.structures.stepCost(def, nextLevel);
  const time = ORION.structures.stepTime(def, nextLevel);
  const verb = chk.isUpgrade ? ('Espandere ' + def.name + ' a livello ' + nextLevel) : ('Costruire ' + def.name);
  const msg = '<p>' + verb + ' su <strong>' + escapeHtml(ctxPlanet.name) + '</strong>?</p>' +
    '<p>Costo: <strong>' + formatCostHtml(cost) + '</strong><br>' +
    'Tempo: <strong>' + time + ' Ι</strong> (' + ORION.time.format(time, 'duration') + ')</p>';
  confirmAction({
    title: chk.isUpgrade ? 'Conferma espansione' : 'Conferma costruzione',
    message: msg,
    confirmLabel: chk.isUpgrade ? 'Espandi' : 'Costruisci',
    onConfirm: function () { _doBuild(id, ctxKey, ctxPlanet); }
  });
}
function _doBuild(id, ctxKey, ctxPlanet) {
  const g = ORION.game;
  /* Fallback ai globali per i call-site legacy che non passano lo scope. */
  const key = ctxKey || ORION.openPlanetKey;
  const planet = ctxPlanet || ORION.currentPlanet;
  const colony = g.colonies[key];
  if (!colony || !planet) { showToast('Colonia non trovata'); return; }
  const r = ORION.planet.startBuild(colony, planet, id, ORION.time.currentDS(g), g);
  if (!r.ok) {
    console.info('Costruzione rifiutata:', r.reason);
    showToast(r.reason || 'Costruzione rifiutata');
    return;
  }
  const def = ORION.structures.get(id);
  pushChronicle(ORION.time.currentDS(g) + ' — Avviata costruzione: <strong>' + def.name + '</strong> su ' + planet.name + bodyTagHtml(planet.systemId) + ' (' + def.time + ' ' + iU() + ').', 'planet');
  if (ORION.tutorial && ORION.tutorial.fire) {
    ORION.tutorial.fire('struct:' + id);
    if (id === 'centro-ingegneria-planetaria') ORION.tutorial.fire('terraforming');
  }
  persistGame(g);
  updateGlobalResourceHud();
  updatePlanetUI();
}

function tryCancel(idx) {
  const colony = ORION.game.colonies[ORION.openPlanetKey];
  const q = colony.queue && colony.queue[idx];
  if (!q) return;
  const def = ORION.structures.get(q.id);
  const name = def ? def.name : q.id;
  const isDemo = q.target === 'demolish';
  const msg = isDemo
    ? '<p>Annullare lo smantellamento di <strong>' + escapeHtml(name) + '</strong>?</p>' +
      '<p>La struttura resterà intatta.</p>'
    : '<p>Annullare la costruzione di <strong>' + escapeHtml(name) + '</strong> ' +
      (q.toLevel > 1 ? ('(espansione a L' + q.toLevel + ') ') : '') + '?</p>' +
      '<p>Rimborso: <strong>80%</strong> del costo speso.</p>';
  confirmAction({
    title: isDemo ? 'Annulla smantellamento' : 'Annulla costruzione',
    message: msg,
    confirmLabel: 'Sì, annulla',
    cancelLabel: 'Continua',
    onConfirm: function () {
      ORION.planet.cancelBuild(colony, idx);
      updateGlobalResourceHud();
      updatePlanetUI();
    }
  });
}

function tryDemolish(id) {
  const g = ORION.game;
  /* Stesso pattern di tryBuild: snapshot del contesto per sopravvivere al
     ripristino di `withDxScope` mentre il dialog è aperto (decisione #50). */
  const ctxKey = ORION.openPlanetKey;
  const ctxPlanet = ORION.currentPlanet;
  const colony = g.colonies[ctxKey];
  if (!colony || !ctxPlanet) { showToast('Nessuna colonia in focus'); return; }
  const def = ORION.structures.get(id);
  if (!def) return;
  const refundPct = colony.isHomeBase ? 70 : 50;
  const refundRate = colony.isHomeBase ? 0.7 : 0.5;
  const dur = Math.max(1, Math.round((def.time || 2) / 2));
  const struct = colony.structures[id];
  const lvl = struct ? (struct.level || 0) : 0;
  const isDowngrade = lvl >= 2;
  const refundCost = isDowngrade
    ? ORION.structures.stepCost(def, lvl)
    : (def.cost || {});
  const refundPreview = Object.keys(refundCost).map(function (k) {
    return resIcon(k) + ' ' + Math.floor((refundCost[k] || 0) * refundRate);
  }).join(' · ') || '—';
  const title = isDowngrade ? 'Conferma downgrade' : 'Conferma smantellamento';
  const verb = isDowngrade
    ? ('Ridurre <strong>' + escapeHtml(def.name) + '</strong> dal livello ' + lvl + ' al livello ' + (lvl - 1) + '?')
    : ('Smantellare definitivamente <strong>' + escapeHtml(def.name) + '</strong> (livello 1)?');
  const note = isDowngrade
    ? '<p class="confirm-hint">Solo il modulo superiore viene smontato. I livelli inferiori restano operativi.</p>'
    : '<p class="confirm-hint">La struttura resta operativa fino alla fine. A 0 viene rimossa dalla colonia.</p>';
  const msg = '<p>' + verb + '</p>' +
    '<p>Tempo: <strong>' + dur + ' Ι</strong> (occupa il cantiere)<br>' +
    'Rimborso: <strong>' + refundPct + '%</strong> ' +
    (isDowngrade ? 'del costo del modulo livello ' + lvl : 'del costo base') +
    ' → <strong>' + refundPreview + '</strong><br>' +
    'Morale: <strong>−0,10 per 30 Ι</strong> (decadimento lineare)</p>' +
    note;
  confirmAction({
    title: title,
    message: msg,
    confirmLabel: isDowngrade ? 'Downgrade' : 'Smantella',
    danger: true,
    onConfirm: function () { _doDemolish(id, ctxKey, ctxPlanet); }
  });
}
function _doDemolish(id, ctxKey, ctxPlanet) {
  const g = ORION.game;
  const key = ctxKey || ORION.openPlanetKey;
  const planet = ctxPlanet || ORION.currentPlanet;
  const colony = g.colonies[key];
  if (!colony || !planet) { showToast('Colonia non trovata'); return; }
  const def = ORION.structures.get(id);
  if (!def) return;
  const dur = Math.max(1, Math.round((def.time || 2) / 2));
  const struct = colony.structures[id];
  const lvl = struct ? (struct.level || 0) : 0;
  const r = ORION.planet.startDemolish(colony, planet, id, ORION.time.currentDS(g));
  if (!r.ok) {
    console.info('Smantellamento rifiutato:', r.reason);
    showToast(r.reason || 'Smantellamento rifiutato');
    return;
  }
  const verb = lvl >= 2
    ? ('Avviato downgrade: <strong>' + def.name + '</strong> (lvl ' + lvl + '→' + (lvl - 1) + ')')
    : ('Avviato smantellamento: <strong>' + def.name + '</strong>');
  pushChronicle(ORION.time.currentDS(g) + ' — ' + verb + ' su ' + planet.name + bodyTagHtml(planet.systemId) + ' (' + dur + ' Ι).', 'planet');
  persistGame(g);
  updateGlobalResourceHud();
  updatePlanetUI();
}

/* =====================================================================
   Tab Forze e reclutamento — gancio M07 → M08/M14.
   Casa unica del reclutamento personale (oggi: scafi+equipaggi
   esploratori). Visibile solo se almeno una struttura di reclutamento
   è costruita (Hangar o Accademia). I moduli futuri (M08 flotta da
   combattimento, M14 figure speciali) aggiungeranno qui le proprie
   sezioni.
   ===================================================================== */
function renderPlanetForzeTab(host, planet, colony) {
  const inner = renderCantieriSection(colony, planet);
  if (!inner) {
    host.innerHTML = '<div class="sysinfo"><p class="panel__note">' +
      'Costruisci un <em>Hangar di costruzione</em> o un\'<em>Accademia militare</em> ' +
      'per iniziare a reclutare scafi ed equipaggi.</p></div>';
    return;
  }
  host.innerHTML = '<div class="sysinfo">' + inner + '</div>';
  host.querySelectorAll('[data-build-ship]').forEach(function (btn) {
    btn.addEventListener('click', function () { tryBuildShip(); });
  });
  host.querySelectorAll('[data-build-crew]').forEach(function (btn) {
    btn.addEventListener('click', function () { tryBuildCrew(); });
  });
  host.querySelectorAll('[data-cancel-ship]').forEach(function (btn) {
    btn.addEventListener('click', function () { tryCancelShip(Number(btn.dataset.cancelShip)); });
  });
  host.querySelectorAll('[data-cancel-crew]').forEach(function (btn) {
    btn.addEventListener('click', function () { tryCancelCrew(Number(btn.dataset.cancelCrew)); });
  });
  /* M08 Fase A: dropdown classe nave. La scelta è ricordata per-colonia
     in ORION.cantieriPickedKind (vive in memoria, non nel save). */
  host.querySelectorAll('[data-ship-kind]').forEach(function (sel) {
    sel.addEventListener('change', function () {
      if (!ORION.cantieriPickedKind) ORION.cantieriPickedKind = {};
      ORION.cantieriPickedKind[ORION.openPlanetKey || ''] = sel.value;
      updatePlanetUI();
    });
  });
}

/* =====================================================================
   M07 — Cantieri & Squadre (decisione #37): HTML del blocco, riutilizzato
   dalla tab Forze (M07.x).
   ===================================================================== */
/* Etichetta breve e leggibile per un equipaggio a partire dal suo id
   tecnico. Formato nuovo: `crew-<seq>` (counter persistente, vedi
   time.nextCrewId) → "Equipaggio 7". Formato legacy: `crew-<imp>-<n>`
   → estrae l'ultimo gruppo numerico (migrato a lazy da
   migrateLegacyCrewIds). Fallback: id grezzo. */
function crewShortLabel(id) {
  if (!id) return 'Equipaggio';
  const m = /-(\d+)$/.exec(String(id));
  return m ? ('Equipaggio ' + m[1]) : String(id);
}

/* Helper HTML per le sigle del Calendario del Faro (decisione #30).
   PR-H: ogni sigla è ora una piccola icona SVG colorata (UI_GUIDE §3
   strategia B) — niente più capsule ambra uniforme. Tinte tematiche
   distinte per scansione rapida: Ι ciano (atomic, ricorrente),
   Κ verde (ciclo), Φ ambra (fase), Ω viola (eone raro).
   La lettera greca resta come fallback se ORION.icon non è caricato. */
const DS_UNIT_MAP = { 'Ι': 'iota', 'Κ': 'kappa', 'Φ': 'phi', 'Ω': 'omega' };
function dsUnit(letter) {
  const iconName = DS_UNIT_MAP[letter];
  if (!iconName || !(ORION && ORION.icon)) {
    return '<span class="ds-unit" aria-hidden="true">' + letter + '</span>';
  }
  return '<span class="ds-unit ds-unit--' + iconName + '" title="' +
    iconName.charAt(0).toUpperCase() + iconName.slice(1) +
    '" aria-hidden="true">' + ORION.icon(iconName) + '</span>';
}
function iU() { return dsUnit('Ι'); }      /* Impulso */

/* PR-J: helper per durate/rate in Impulsi (Ι). Avvolge numero + glifo
   in un pill ciano compatto in modo che il glifo non sembri un
   divisorio o una "I" isolata. Usa la stessa tinta della DATA in
   header (UI_GUIDE §1: Ι = ciano).
   - impHtml("10")          → "10 Ι" in pill ciano
   - impHtml("5/10")        → "5/10 Ι" in pill ciano (durata)
   - impHtml("+4.1", "/")   → "+4.1 / Ι" in pill ciano (rate per Ι) */
function impHtml(value, sep) {
  const iotaSvg = (ORION && ORION.icon) ? ORION.icon('iota') : '';
  const sepHtml = sep ? '<span class="imp-pill__sep">' + sep + '</span>' : '';
  if (!iotaSvg) return value + (sep ? ' ' + sep + ' Ι' : ' Ι');
  return '<span class="imp-pill">' +
    '<span class="imp-pill__n">' + value + '</span>' + sepHtml +
    '<span class="imp-pill__u ui-icon ui-icon--iota" aria-hidden="true">' + iotaSvg + '</span>' +
  '</span>';
}

/* PR-D: helper inline per inserire icona SVG con tinta + glow morbido,
   coerente con UI_GUIDE §3. Usato dove l'HTML è generato dinamicamente
   (sysinfo__home, chip, label di stato). Ritorna stringa HTML. */
function uiIcon(name, tone) {
  if (!ORION.icon) return '';
  const cls = tone ? (' ui-icon--' + tone) : '';
  return '<span class="ui-icon' + cls + '" aria-hidden="true">' + ORION.icon(name) + '</span>';
}
function kU() { return dsUnit('Κ'); }      /* Ciclo di nutazione */
function phU() { return dsUnit('Φ'); }     /* Fase di precessione */
function omU() { return dsUnit('Ω'); }     /* Eone */

function renderCantieriSection(colony, planet) {
  const hasHangar = !!(colony.structures && colony.structures['cantiere-navale']);
  const hasAcademy = !!(colony.structures && colony.structures['accademia-militare']);
  /* Decisione #43: i Comandanti nascono dagli equipaggi M07 ma vivono
     anche se Accademia/Hangar venissero demoliti — mostriamo la sezione
     comunque per non perdere figure storiche. */
  const commanders = (ORION.commander && ORION.commander.listOf(colony)) || [];
  const hasCommanders = commanders.length > 0;
  if (!hasHangar && !hasAcademy && !hasCommanders) return '';
  const E = (ORION.expedition && ORION.expedition.CFG) || {};
  const shipCost = E.SHIP_COST || { met: 25, en: 12 };
  const shipTime = E.SHIP_TIME || 10;
  const crewCost = E.CREW_COST || { food: 12, water: 6 };
  const crewTime = E.CREW_TIME || 12;
  ORION.planet.ensureAssets(colony);

  function costStr(c) {
    return Object.keys(c).map(function (k) { return resIcon(k) + c[k]; }).join(' · ');
  }
  function canPay(c) {
    const ks = Object.keys(c);
    for (let i = 0; i < ks.length; i++) {
      if ((colony.stock[ks[i]] || 0) < c[ks[i]]) return false;
    }
    return true;
  }

  let html = '<div class="cantieri-section">' +
    '<p class="sysinfo__sub">Cantieri & Squadre <span class="cantieri-section__hint">(esplorazione)</span></p>';

  /* Decisione #43: Comandanti nominati emersi dagli equipaggi veterani.
     Per ora "in panchina" (status:'idle') — M08 li aggancerà alle navi. */
  if (hasCommanders) {
    html += '<div class="cantieri-row commander-row">' +
      '<div class="cantieri-row__head">' +
        '<span class="cantieri-row__glyph ui-icon ui-icon--amber" aria-hidden="true">' + ((ORION.icon && ORION.icon('star')) || '★') + '</span>' +
        '<span class="cantieri-row__name">Comandanti</span>' +
        '<span class="cantieri-row__counter">In organico: <strong>' + commanders.length + '</strong></span>' +
      '</div>' +
      '<ul class="commander-roster">';
    commanders.forEach(function (c) {
      const statusLabel = c.status === 'idle'
        ? 'in panchina'
        : escapeHtml(c.status || '—');
      html += '<li class="commander-roster__item">' +
        '<span class="commander-roster__rank">' + escapeHtml(c.rank || 'Comandante') + '</span>' +
        '<span class="commander-roster__name">' + escapeHtml(c.name || '—') + '</span>' +
        '<span class="commander-roster__spec" title="' + escapeHtml((ORION.commander.SPEC_POOL.find(function (s) { return s.id === c.specialization; }) || {}).hint || '') + '">' +
          escapeHtml(c.specializationLabel || c.specialization || '—') +
        '</span>' +
        '<span class="commander-roster__trait" title="Tratto">' + escapeHtml(c.traitLabel || c.trait || '—') + '</span>' +
        '<span class="xp-chip" title="Esperienza ereditata dall\'equipaggio">xp ' + (c.xp | 0) + '</span>' +
        '<span class="commander-roster__status commander-roster__status--' + escapeHtml(c.status || 'idle') + '">' + statusLabel + '</span>' +
      '</li>';
    });
    html += '</ul>' +
      '<p class="commander-row__hint">Le navi evolute (corvette, fregate, incrociatori) potranno essere comandate da queste figure — disponibili con il modulo Flotta.</p>' +
    '</div>';
  }

  if (hasHangar) {
    /* M08 Fase A (decisione #42): counter di TUTTE le classi navi note. */
    const F = ORION.fleet || {};
    const classes = (F.classList ? F.classList() : []);
    ORION.fleet && ORION.fleet.ensureColonyShipKinds && ORION.fleet.ensureColonyShipKinds(colony);
    let sShips = 0;
    classes.forEach(function (cls) { sShips += (colony.ships && colony.ships[cls.id]) || 0; });
    const queue = colony.assets.shipQueue || [];
    const payOk = canPay(shipCost);
    /* Decisione #41: cantieri (build paralleli) + attracchi (porto a terra). */
    const E = ORION.expedition || {};
    const buildSlots = E.hangarBuildSlots ? E.hangarBuildSlots(colony) : 1;
    const docks = E.hangarDockCapacity ? E.hangarDockCapacity(colony) : 1;
    const active = E.activeShipBuilds ? E.activeShipBuilds(colony) : queue.length;
    const flying = E.shipsOnExpedition ? E.shipsOnExpedition(ORION.game, ORION.openPlanetKey) : 0;
    const bound = sShips + active + flying;
    const techBonus = E.techSpeedBonus ? E.techSpeedBonus(colony) : 0;
    const cantieriCls = active >= buildSlots ? ' cantieri-cap--full' : '';
    const portCls = bound >= docks ? ' cantieri-cap--full' : '';
    const techHtml = techBonus > 0
      ? ' <span class="cantieri-tech-chip" title="Bonus tecnici: ' + (E.techCountOf ? E.techCountOf(colony) : 0) + ' tecnici → −' + Math.round(techBonus * 100) + '% tempo costruzione">' + uiIcon('settings', 'soft') + ' −' + Math.round(techBonus * 100) + '%</span>'
      : '';
    const hangarLvl = (colony.structures['cantiere-navale'] && colony.structures['cantiere-navale'].level) || 1;

    /* Selezione classe corrente (persistente per-colonia in memoria). */
    if (!ORION.cantieriPickedKind) ORION.cantieriPickedKind = {};
    const colKey = ORION.openPlanetKey || '';
    let pickedKind = ORION.cantieriPickedKind[colKey] || 'explorer';
    /* Se la classe selezionata è sopra il livello dell'Hangar, scendi a
       una compatibile. */
    if ((F.getClass && (F.getClass(pickedKind) || {}).hangarLvl || 1) > hangarLvl) {
      pickedKind = 'explorer';
      ORION.cantieriPickedKind[colKey] = pickedKind;
    }
    const pickedCls = (F.getClass && F.getClass(pickedKind)) || { cost: shipCost, time: shipTime, hangarLvl: 1, name: 'Scafo esploratore' };
    const effShipTime = E.applyTechSpeed ? E.applyTechSpeed(pickedCls.time, colony) : pickedCls.time;
    const payOkShip = canPay(pickedCls.cost);
    const check = E.canBuildShip ? E.canBuildShip(ORION.game, colony, ORION.openPlanetKey) : { ok: true };
    const buildEnabled = payOkShip && check.ok;
    const blockReason = !check.ok ? check.reason : (!payOkShip ? 'Risorse insufficienti' : '');

    /* Counter per-classe (riepilogo compatto). */
    const counterParts = classes.map(function (cls) {
      const n = (colony.ships && colony.ships[cls.id]) || 0;
      if (!n) return null;
      return '<span title="' + escapeHtml(cls.name) + '">' + cls.glyph + ' ' + n + '</span>';
    }).filter(Boolean);
    const counterHtml = counterParts.length
      ? counterParts.join(' · ')
      : '<span class="cantieri-row__base">nessuna nave</span>';

    html += '<div class="cantieri-row">' +
      '<div class="cantieri-row__head">' +
        '<span class="cantieri-row__glyph" aria-hidden="true">▱</span>' +
        '<span class="cantieri-row__name">Hangar di costruzione <span class="cantieri-row__base">lvl ' + hangarLvl + '</span></span>' +
        '<span class="cantieri-row__counter">Scafi: <strong>' + sShips + '</strong> ' + counterHtml + '</span>' +
      '</div>' +
      '<div class="cantieri-row__caps">' +
        '<span class="cantieri-cap' + cantieriCls + '" title="Build paralleli abilitati dal livello dell\'Hangar">Cantieri <strong>' + active + ' / ' + buildSlots + '</strong></span>' +
        '<span class="cantieri-cap' + portCls + '" title="Posti d\'attracco a terra · in spedizione: ' + flying + '">Attracchi <strong>' + bound + ' / ' + docks + '</strong></span>' +
        techHtml +
      '</div>';
    queue.forEach(function (q, idx) {
      const qKind = q.kind || 'explorer';
      const qCls = (F.getClass && F.getClass(qKind)) || { name: 'Scafo esploratore', glyph: '▱' };
      const total = q.totalTime || effShipTime;
      const remain = Math.max(0, q.duration | 0);
      const pct = Math.round(((total - remain) / total) * 100);
      html += '<div class="struct-item is-queue">' +
        '<span class="struct-item__glyph">' + qCls.glyph + '</span>' +
        '<div class="struct-item__main">' +
          '<div class="struct-item__name">' + escapeHtml(qCls.name) + ' <span class="struct-item__cat">' + remain + ' / ' + total + '</span> ' + iU() + '</div>' +
          '<div class="progress-bar progress-bar--mini"><div class="progress-bar__fill" style="width:' + pct + '%"></div></div>' +
        '</div>' +
        '<button class="btn btn--mini btn--icon-only struct-item__cancel" data-cancel-ship="' + idx + '" type="button" title="Annulla (rimborso 50%)" aria-label="Annulla">' + uiIcon('close', 'pink') + '</button>' +
      '</div>';
    });

    /* Dropdown classi: opzioni disabilitate se l'Hangar non è di livello
       adeguato (M08 Fase A, decisione #42). */
    const options = classes.map(function (cls) {
      const lockedByHangar = (cls.hangarLvl || 1) > hangarLvl;
      const label = cls.glyph + ' ' + cls.name + (lockedByHangar ? ' — Hangar lvl ' + cls.hangarLvl : '');
      const sel = (cls.id === pickedKind) ? ' selected' : '';
      const dis = lockedByHangar ? ' disabled' : '';
      return '<option value="' + cls.id + '"' + sel + dis + '>' + escapeHtml(label) + '</option>';
    }).join('');

    const buildAttrs = buildEnabled ? '' : (' disabled title="' + escapeHtml(blockReason) + '"');
    html += '<div class="cantieri-row__build">' +
      '<select class="cantieri-row__select" data-ship-kind aria-label="Classe nave">' + options + '</select>' +
      '<span class="cantieri-row__cost">' + costStr(pickedCls.cost) + ' · ' + effShipTime + ' ' + iU() + (techBonus > 0 ? ' <span class="cantieri-row__base">(' + pickedCls.time + ' base)</span>' : '') + '</span>' +
      '<button class="btn btn--mini" data-build-ship type="button"' + buildAttrs + '>+ Costruisci</button>' +
    '</div></div>';
  }

  if (hasAcademy) {
    const crews = (colony.crews && colony.crews.explorer) || [];
    const avg = crews.length ? (ORION.expedition.averageXp(crews)).toFixed(1) : '0';
    const queue = colony.assets.crewQueue || [];
    const payOk = canPay(crewCost);
    const E2 = ORION.expedition || {};
    const techBonus2 = E2.techSpeedBonus ? E2.techSpeedBonus(colony) : 0;
    const effCrewTime = E2.applyTechSpeed ? E2.applyTechSpeed(crewTime, colony) : crewTime;
    /* Equipaggi in missione: vivono nelle spedizioni (rimossi dall'array
       della colonia al lancio), li recuperiamo per mostrarli nel roster. */
    const away = expeditionsForColony(colony);
    const totalCrews = crews.length + away.length;
    html += '<div class="cantieri-row">' +
      '<div class="cantieri-row__head">' +
        '<span class="cantieri-row__glyph ui-icon ui-icon--pink" aria-hidden="true">' + ((ORION.icon && ORION.icon('forces')) || '⚔') + '</span>' +
        '<span class="cantieri-row__name">Accademia militare</span>' +
        '<span class="cantieri-row__counter">Equipaggi: <strong>' + totalCrews + '</strong>' +
          (totalCrews ? ' <span class="xp-chip" title="Esperienza media (a riposo)">xp ' + avg + '</span>' : '') +
        '</span>' +
      '</div>';
    /* Roster per-equipaggio: a riposo (assegnabili) + in missione. */
    if (totalCrews) {
      html += '<ul class="crew-roster">';
      crews.forEach(function (c) {
        const enr = ORION.expedition.enrichmentForXp(c.xp || 0);
        html += '<li class="crew-roster__item">' +
          '<span class="crew-roster__rank crew-roster__rank--t' + enr.tier + '">' + enr.label + '</span>' +
          '<span class="crew-roster__id">' + escapeHtml(crewShortLabel(c.id)) + '</span>' +
          '<span class="xp-chip" title="Esperienza">xp ' + (c.xp || 0) + '</span>' +
          '<span class="crew-roster__status crew-roster__status--rest">a riposo</span>' +
        '</li>';
      });
      away.forEach(function (e) {
        const enr = ORION.expedition.enrichmentForXp(e.crewXp || 0);
        const target = ORION.game.galaxy.systems[e.targetSystemId];
        const tname = target ? target.name : '—';
        const st = e.status === 'returning' ? 'in rientro' : 'in missione';
        html += '<li class="crew-roster__item crew-roster__item--away">' +
          '<span class="crew-roster__rank crew-roster__rank--t' + enr.tier + '">' + enr.label + '</span>' +
          '<span class="crew-roster__id">' + escapeHtml(crewShortLabel(e.crewId)) + '</span>' +
          '<span class="xp-chip" title="Esperienza">xp ' + (e.crewXp || 0) + '</span>' +
          '<span class="crew-roster__status crew-roster__status--away" title="' + escapeHtml(tname) + '">' + st + ' → ' + escapeHtml(tname) + '</span>' +
        '</li>';
      });
      html += '</ul>';
    }
    queue.forEach(function (q, idx) {
      const total = q.totalTime || effCrewTime;
      const remain = Math.max(0, q.duration | 0);
      const pct = Math.round(((total - remain) / total) * 100);
      html += '<div class="struct-item is-queue">' +
        '<span class="struct-item__glyph ui-icon ui-icon--pink" aria-hidden="true">' + ((ORION.icon && ORION.icon('forces')) || '⚔') + '</span>' +
        '<div class="struct-item__main">' +
          '<div class="struct-item__name">Equipaggio esploratore <span class="struct-item__cat">' + remain + ' / ' + total + '</span> ' + iU() + '</div>' +
          '<div class="progress-bar progress-bar--mini"><div class="progress-bar__fill" style="width:' + pct + '%"></div></div>' +
        '</div>' +
        '<button class="btn btn--mini btn--icon-only struct-item__cancel" data-cancel-crew="' + idx + '" type="button" title="Annulla (rimborso 50%)" aria-label="Annulla">' + uiIcon('close', 'pink') + '</button>' +
      '</div>';
    });
    html += '<div class="cantieri-row__build">' +
      '<span class="cantieri-row__cost">' + costStr(crewCost) + ' · ' + effCrewTime + ' ' + iU() + (techBonus2 > 0 ? ' <span class="cantieri-row__base">(' + crewTime + ' base)</span>' : '') + '</span>' +
      '<button class="btn btn--mini" data-build-crew type="button"' + (payOk ? '' : ' disabled') + '>+ Equipaggio esploratore</button>' +
    '</div></div>';
  }

  html += '</div>';
  return html;
}

function tryBuildShip() {
  const g = ORION.game;
  const colony = g.colonies[ORION.openPlanetKey];
  const planet = ORION.currentPlanet;
  const kind = (ORION.cantieriPickedKind && ORION.cantieriPickedKind[ORION.openPlanetKey]) || 'explorer';
  const cls = (ORION.fleet && ORION.fleet.getClass(kind)) || { name: 'Scafo esploratore', cost: {}, time: 0 };
  const msg = '<p>Costruire <strong>' + escapeHtml(cls.name) + '</strong> su <strong>' + escapeHtml(planet.name) + '</strong>?</p>' +
    '<p>Costo: <strong>' + formatCostHtml(cls.cost) + '</strong><br>' +
    'Tempo: <strong>' + (cls.time || 0) + ' Ι</strong></p>';
  confirmAction({
    title: 'Costruzione scafo',
    message: msg,
    confirmLabel: 'Costruisci',
    onConfirm: function () {
      const r = ORION.planet.startShipBuild(colony, planet, g, ORION.openPlanetKey, kind);
      if (!r.ok) { console.info('Costruzione scafo rifiutata:', r.reason); showToast(r.reason); return; }
      pushChronicle(ORION.time.currentDS(g) + ' — Avviata costruzione di una <strong>' + cls.name + '</strong> su ' + planet.name + bodyTagHtml(planet.systemId) + '.', 'planet');
      persistGame(g);
      updateGlobalResourceHud();
      updatePlanetUI();
    }
  });
}

function tryBuildCrew() {
  const g = ORION.game;
  const colony = g.colonies[ORION.openPlanetKey];
  const planet = ORION.currentPlanet;
  const msg = '<p>Formare un <strong>equipaggio esploratore</strong> presso l\'Accademia di <strong>' + escapeHtml(planet.name) + '</strong>?</p>';
  confirmAction({
    title: 'Formazione equipaggio',
    message: msg,
    confirmLabel: 'Forma',
    onConfirm: function () {
      const r = ORION.planet.startCrewBuild(colony, planet);
      if (!r.ok) { console.info('Formazione equipaggio rifiutata:', r.reason); showToast(r.reason); return; }
      pushChronicle(ORION.time.currentDS(g) + ' — Avviata formazione di un <strong>equipaggio esploratore</strong> presso l\'Accademia di ' + planet.name + bodyTagHtml(planet.systemId) + '.', 'planet');
      persistGame(g);
      updateGlobalResourceHud();
      updatePlanetUI();
    }
  });
}

function tryCancelShip(idx) {
  const colony = ORION.game.colonies[ORION.openPlanetKey];
  ORION.planet.cancelShipBuild(colony, idx);
  persistGame(ORION.game);
  updateGlobalResourceHud();
  updatePlanetUI();
}
function tryCancelCrew(idx) {
  const colony = ORION.game.colonies[ORION.openPlanetKey];
  ORION.planet.cancelCrewBuild(colony, idx);
  persistGame(ORION.game);
  updateGlobalResourceHud();
  updatePlanetUI();
}

/* =====================================================================
   M07 — Tab Esplorazione (decisione #37)
   Mostra spedizioni attive (status, ETA, wear, xp) + bottone "Organizza
   spedizione" → overlay con lista sistemi DETECTED/UNKNOWN raggiungibili
   da questa colonia (via galaxy.routes).
   ===================================================================== */
function renderPlanetEsplorazioneTab(host, planet, colony) {
  const g = ORION.game;
  ORION.planet.ensureAssets(colony);
  const ships = (colony.ships && colony.ships.explorer) || 0;
  const crews = (colony.crews && colony.crews.explorer) || [];
  const xpAvg = crews.length ? ORION.expedition.averageXp(crews).toFixed(1) : '0';

  const expeditions = expeditionsForColony(colony);

  let listHtml;
  if (expeditions.length) {
    listHtml = '<ul class="expedition-list">' + expeditions.map(function (e) {
      const target = g.galaxy.systems[e.targetSystemId];
      const acr = regionAcronymFor(e.targetSystemId);
      const targetName = target ? target.name : '—';
      const tag = acr ? ' <span class="name-tag">[' + acr + ']</span>' : '';
      const status = e.status;
      const rem = (status === 'outbound') ? (e.durationOut | 0) :
                  (status === 'returning') ? (e.durationBack | 0) : 0;
      const wear = Math.min(100, e.shipWear || 0);
      const xp = e.crewXp || 0;
      const incCount = (e.incidents || []).length;
      const enr = ORION.expedition.enrichmentForXp(xp);
      const statusLabel = status === 'outbound' ? 'In rotta' :
                          status === 'returning' ? 'Rientro' : 'Conclusa';
      return '<li class="expedition-item">' +
        '<div class="expedition-item__head">' +
          '<span class="expedition-item__status expedition-status--' + status + '">' + statusLabel + '</span>' +
          '<span class="expedition-item__target">' + escapeHtml(targetName) + tag + '</span>' +
          '<span class="expedition-item__eta">ETA ' + rem + ' ' + iU() + '</span>' +
        '</div>' +
        '<div class="expedition-item__bars">' +
          '<div class="wear-bar" title="Usura scafo ' + wear + '%">' +
            '<div class="wear-bar__fill" style="width:' + wear + '%"></div>' +
            '<span class="wear-bar__label">scafo ' + wear + '%</span>' +
          '</div>' +
          '<span class="xp-chip" title="' + enr.label + '">xp ' + xp + ' · ' + enr.label + '</span>' +
          (incCount ? '<span class="expedition-item__inc" title="Incidenti accumulati">' + uiIcon('warning', 'gold') + ' ' + incCount + '</span>' : '') +
        '</div>' +
      '</li>';
    }).join('') + '</ul>';
  } else {
    listHtml = '<p class="panel__note">Nessuna spedizione attiva. Costruisci scafi e equipaggi, poi pianifica una rotta.</p>';
  }

  const canOrganize = ships >= 1 && crews.length >= 1;
  const reachable = ORION.expedition.reachableTargets(g.galaxy, g.state, colony.systemId);
  const hasTargets = reachable.length > 0;

  host.innerHTML =
    '<div class="sysinfo">' +
      '<p class="sysinfo__sub">Risorse disponibili</p>' +
      '<dl class="sysinfo__list">' +
        row('Scafi esploratori', String(ships)) +
        row('Equipaggi', crews.length + (crews.length ? ' (xp medio ' + xpAvg + ')' : '')) +
        row('Sistemi raggiungibili', String(reachable.length)) +
      '</dl>' +
      '<button class="btn btn--mini btn--enter btn--with-icon" data-action="exp-organize" type="button"' +
        ((canOrganize && hasTargets) ? '' : ' disabled') +
        ' title="' + (canOrganize ? (hasTargets ? 'Pianifica un salto iperspaziale' : 'Nessuna rotta inesplorata adiacente') : 'Servono uno scafo e un equipaggio') + '">' +
        '<span class="ui-icon ui-icon--cyan" aria-hidden="true">' + ((ORION.icon && ORION.icon('fleet')) || '') + '</span> Organizza spedizione' +
        '<span class="ui-icon ui-icon--soft" aria-hidden="true">' + ((ORION.icon && ORION.icon('chevronRight')) || '') + '</span>' +
      '</button>' +
      '<p class="sysinfo__sub">Spedizioni attive</p>' +
      listHtml +
      '<p class="panel__note">Costruisci scafi nell\'<em>Hangar di costruzione</em> e forma equipaggi nell\'<em>Accademia militare</em>. ' +
        'Ogni missione completata restituisce l\'equipaggio con +1 xp; gli scafi accumulano usura. ' +
        'I tre tier di <em>iperguida</em> ridurranno i tempi di salto iperspaziale.</p>' +
    '</div>';

  const btn = host.querySelector('[data-action="exp-organize"]');
  if (btn && !btn.disabled) btn.addEventListener('click', function () { openExpeditionPicker(colony); });
}

function openExpeditionPicker(colony) {
  const g = ORION.game;
  const reachable = ORION.expedition.reachableTargets(g.galaxy, g.state, colony.systemId);
  const ships = (colony.ships && colony.ships.explorer) || 0;
  const crews = (colony.crews && colony.crews.explorer) || [];
  const crewXp = crews.length ? (crews[0].xp || 0) : 0;

  let host = document.querySelector('[data-bind="exp-picker"]');
  if (!host) {
    host = document.createElement('div');
    host.className = 'expedition-pick-overlay';
    host.setAttribute('data-bind', 'exp-picker');
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-modal', 'true');
    host.setAttribute('aria-label', 'Organizza spedizione');
    document.body.appendChild(host);
  }

  const cards = reachable.map(function (sid) {
    const sys = g.galaxy.systems[sid];
    const acr = regionAcronymFor(sid);
    const tag = acr ? ' <span class="name-tag">[' + acr + ']</span>' : '';
    const dur = ORION.expedition.computeDuration(g.galaxy, sid, crewXp);
    const chance = ORION.expedition.accidentChance(g.galaxy, sid, crewXp, g);
    const dangerN = ORION.expedition.dangerNorm(g.galaxy, sid);
    const dangerTier = sys.dangerTier || ORION.galaxy.dangerTier(sys.danger);
    const DISCOVERY = ORION.galaxy.DISCOVERY;
    const disc = g.state.discovery[sid];
    const discLabel = disc >= DISCOVERY.DETECTED ? 'rilevato' : 'ignoto';
    const nameLabel = disc >= DISCOVERY.DETECTED ? sys.name : 'Sistema ignoto';
    return '<div class="expedition-card">' +
      '<div class="expedition-card__head">' +
        '<span class="expedition-card__name">' + escapeHtml(nameLabel) + tag + '</span>' +
        '<span class="danger-badge tier--' + dangerTier + '">' + sys.danger + ' · ' + dangerTier + '</span>' +
      '</div>' +
      '<dl class="save-card__meta">' +
        '<div><dt>Stato</dt><dd>' + discLabel + '</dd></div>' +
        '<div><dt>Durata viaggio</dt><dd>' + dur + ' ' + iU() + ' (a/r)</dd></div>' +
        '<div><dt>Rischio incidente</dt><dd>' + Math.round(chance * 100) + '%</dd></div>' +
      '</dl>' +
      '<div class="expedition-card__actions">' +
        '<button class="btn btn--mini btn--primary btn--with-icon" data-action="exp-launch" data-sys="' + sid + '" type="button">' +
          '<span class="ui-icon" aria-hidden="true">' + ((ORION.icon && ORION.icon('send')) || '') + '</span> Invia' +
        '</button>' +
      '</div>' +
    '</div>';
  }).join('');

  host.innerHTML =
    '<div class="expedition-pick-overlay__panel" role="document">' +
      '<header class="expedition-pick-overlay__head">' +
        '<h2 class="expedition-pick-overlay__title">Organizza spedizione</h2>' +
        '<button class="btn btn--mini btn--icon-only" data-action="exp-pick-close" type="button" aria-label="Chiudi">' +
          '<span class="ui-icon" aria-hidden="true">' + ((ORION.icon && ORION.icon('close')) || '✕') + '</span>' +
        '</button>' +
      '</header>' +
      '<p class="panel__note">Scafi disponibili: <strong>' + ships + '</strong> · ' +
        'Equipaggi: <strong>' + crews.length + '</strong>. Verrà impegnato il primo equipaggio in lista (' +
        (crews.length ? 'xp ' + (crews[0].xp || 0) : 'nessuno') + ').</p>' +
      '<div class="expedition-pick-overlay__grid">' + cards + '</div>' +
    '</div>';
  host.hidden = false;

  host.addEventListener('click', function (e) {
    if (e.target === host || e.target.matches('[data-action="exp-pick-close"]')) {
      closeExpeditionPicker();
    }
  });
  host.querySelectorAll('[data-action="exp-launch"]').forEach(function (b) {
    b.addEventListener('click', function () {
      const sid = Number(b.dataset.sys);
      doLaunchExpedition(colony, sid);
    });
  });
}

function closeExpeditionPicker() {
  const host = document.querySelector('[data-bind="exp-picker"]');
  if (host) { host.hidden = true; host.innerHTML = ''; }
}

function doLaunchExpedition(colony, targetSystemId) {
  const g = ORION.game;
  const key = colony.systemId + ':' + colony.bodyKey;
  /* Decisione #60: lancio come flotta con ordine explore (sostituisce
     ORION.expedition.launch). Crea una flotta dedicata, assegna 1 scafo
     esploratore e 1 equipaggio dal pool della colonia, poi setOrder explore. */
  if (!ORION.fleet || !ORION.fleet.createFleet) {
    /* Fallback estremo: nessun modulo flotta caricato. */
    showToast('Modulo flotta non disponibile'); return;
  }
  /* Pre-check: scafo + equipaggio disponibili in colonia. */
  const shipsAvail = (colony.ships && colony.ships.explorer) || 0;
  const crewsAvail = (colony.crews && Array.isArray(colony.crews.explorer))
    ? colony.crews.explorer.length : 0;
  if (shipsAvail < 1) { showToast('Nessuno scafo esploratore disponibile'); return; }
  if (crewsAvail < 1) { showToast('Nessun equipaggio esploratore disponibile'); return; }
  /* Crea flotta + assegna 1 scafo + 1 crew. */
  const cf = ORION.fleet.createFleet(g, key, 'Esplorazione');
  if (!cf.ok) { showToast(cf.reason || 'Creazione flotta fallita'); return; }
  const fleet = cf.fleet;
  const as = ORION.fleet.assignShips(g, fleet, key, 'explorer', 1);
  if (!as.ok) { ORION.fleet.dissolveFleet(g, fleet); showToast(as.reason || 'Assegnazione nave fallita'); return; }
  const ac = ORION.fleet.assignCrew(g, fleet, key, 1);
  if (!ac.ok) { ORION.fleet.dissolveFleet(g, fleet); showToast(ac.reason || 'Assegnazione equipaggio fallita'); return; }
  const so = ORION.fleet.setOrder(g, fleet, { type: 'explore', toSysId: targetSystemId });
  if (!so.ok) { ORION.fleet.dissolveFleet(g, fleet); showToast(so.reason || 'Ordine esplorazione rifiutato'); return; }
  const sys = g.galaxy.systems[targetSystemId];
  const acr = regionAcronymFor(targetSystemId);
  const tag = acr ? ' <span class="name-tag">[' + acr + ']</span>' : '';
  pushChronicle(ORION.time.currentDS(g) + ' — Spedizione partita verso <strong>' +
    (sys ? sys.name : 'sistema ignoto') + '</strong>' + tag +
    ' · salto iperspaziale, durata stimata ' + (fleet.etaImpulsi || 0) + ' ' + iU() + '.', 'explore');
  if (ORION.tutorial) ORION.tutorial.fire('expedition-launch');
  closeExpeditionPicker();
  persistGame(g);
  updatePlanetUI();
}

/* =====================================================================
   M12 Fase A1 — Tab ROTTE (commercio interno, decisione #53 §15.2/§15.6)
   Per-colonia: capacità di mercato, mercantili (costruzione + roster),
   rotte attive (crea/cancella). La gestione d'impero vive nella vista
   "Mercato" (launcher sx).
   ===================================================================== */
function tradeResLabel(k) {
  return { met: 'metalli', en: 'energia', food: 'cibo', water: 'acqua' }[k] || k;
}
function tradeRouteStatusMeta(status) {
  if (status === 'interrupted-source') return { label: 'sorgente esaurita', cls: 'warn' };
  if (status === 'interrupted-route')  return { label: 'transito ostile', cls: 'crit' };
  return { label: 'attiva', cls: 'ok' };
}

function renderPlanetRotteTab(host, planet, colony) {
  const g = ORION.game;
  const T = ORION.trade;
  if (!T) { host.innerHTML = '<p class="panel__note">Modulo commercio non disponibile.</p>'; return; }
  const colKey = ORION.openPlanetKey;
  T.ensureColonyTrade(colony);

  const cap = T.marketCapacity(g);
  const used = T.routesUsed(g);
  const marketLvl = T.marketLevelOf(colony);
  const mercs = colony.mercantili || [];
  const queue = (colony.assets && colony.assets.mercantileQueue) || [];
  const routes = T.routesForColony(g, colKey);

  /* ----- Capacità ----- */
  let html = '<div class="trade-tab">';
  html += '<p class="sysinfo__sub">Capacità commerciale</p>' +
    '<dl class="sysinfo__list">' +
      row('Mercato locale', marketLvl > 0 ? ('lvl ' + marketLvl) : '<em>non costruito</em>') +
      row('Rotte d\'impero', used + ' / ' + cap.routes) +
      row('Throughput d\'impero', cap.throughput + ' ' + iU() + ' tot') +
    '</dl>';
  if (marketLvl <= 0) {
    html += '<p class="panel__note">Costruisci un <em>Mercato</em> (scheda Strutture) per aprire rotte: ogni livello aggiunge rotte simultanee e throughput, sommati su tutte le tue colonie.</p>';
  }

  /* ----- Mercantili ----- */
  const buildable = T.buildableTier(colony, g);
  html += '<p class="sysinfo__sub">Mercantili <span class="cantieri-section__hint">(consorzio)</span></p>';
  if (mercs.length) {
    html += '<ul class="merc-roster">' + mercs.map(function (m) {
      const t = T.getTier(m.tier) || {};
      const rank = T.rankLabel(m.xp);
      const onRoute = m.status === 'on-route';
      const wear = T.mercantileWear ? T.mercantileWear(m) : (m.wear || 0);
      const wearHtml = wear > 0
        ? '<span class="merc-roster__wear' + (wear >= 70 ? ' is-high' : '') + '" title="Usura da razzie: a 100% il mercantile è ritirato">usura ' + Math.round(wear) + '%</span>'
        : '';
      return '<li class="merc-roster__item">' +
        '<span class="merc-roster__glyph" aria-hidden="true">' + (t.glyph || '◈') + '</span>' +
        '<span class="merc-roster__name">' + escapeHtml(t.name || ('Tier ' + m.tier)) + '</span>' +
        '<span class="xp-chip" title="Esperienza viaggi">xp ' + (m.xp | 0) + ' · ' + rank + '</span>' +
        '<span class="merc-roster__cargo" title="Cargo · raggio">cargo ' + T.mercantileCargo(m) + ' · ' + T.mercantileMaxHops(m) + ' salti</span>' +
        wearHtml +
        '<span class="merc-roster__status merc-roster__status--' + (onRoute ? 'busy' : 'idle') + '">' + (onRoute ? 'in rotta' : 'a riposo') + '</span>' +
      '</li>';
    }).join('') + '</ul>';
  } else {
    html += '<p class="panel__note">Nessun mercantile. Costruiscine uno all\'<em>Hangar di costruzione</em> per servire le rotte.</p>';
  }
  /* Build mercantili (richiede Hangar). */
  if (T.hangarLevelOf(colony) > 0) {
    html += '<div class="merc-build">';
    T.MERCANTILE_TIERS.forEach(function (t) {
      const can = T.canBuildMercantile(g, colony, colKey, t.tier);
      const locked = t.tier > buildable;
      const costStr = Object.keys(t.cost).map(function (k) { return resIcon(k) + t.cost[k]; }).join(' · ');
      const reason = locked
        ? (T.hangarLevelOf(colony) < t.hangarLvl ? 'Hangar lvl ' + t.hangarLvl : 'richiede iperguida (M13)')
        : (can.ok ? '' : can.reason);
      html += '<button class="btn btn--mini merc-build__btn" data-action="merc-build" data-tier="' + t.tier + '" type="button"' +
        (can.ok ? '' : ' disabled') +
        ' title="' + escapeHtml(can.ok ? ('Costo: ' + t.name) : reason) + '">' +
        '<span aria-hidden="true">' + t.glyph + '</span> ' + escapeHtml(t.name) +
        ' <span class="merc-build__cost">' + costStr + ' · ' + t.time + ' ' + iU() + '</span>' +
        (locked ? ' <span class="merc-build__lock">🔒</span>' : '') +
      '</button>';
    });
    html += '</div>';
    if (queue.length) {
      html += '<ul class="merc-queue">' + queue.map(function (q, i) {
        const t = T.getTier(q.tier) || {};
        const pct = q.totalTime ? Math.round((1 - (q.duration / q.totalTime)) * 100) : 0;
        return '<li class="merc-queue__item">' +
          '<span class="merc-queue__name">' + escapeHtml(t.name || ('Tier ' + q.tier)) + '</span>' +
          '<div class="progress-bar progress-bar--mini"><div class="progress-bar__fill" style="width:' + pct + '%"></div></div>' +
          '<span class="merc-queue__eta">' + (q.duration | 0) + ' ' + iU() + '</span>' +
          '<button class="btn btn--mini btn--danger" data-action="merc-cancel" data-idx="' + i + '" type="button" title="Annulla (rimborso 50%)">×</button>' +
        '</li>';
      }).join('') + '</ul>';
    }
  } else {
    html += '<p class="panel__note">Serve un <em>Hangar di costruzione</em> per varare mercantili.</p>';
  }

  /* ----- Rotte ----- */
  html += '<p class="sysinfo__sub">Rotte attive</p>';
  if (routes.length) {
    html += '<ul class="route-list">' + routes.map(function (r) {
      const meta = tradeRouteStatusMeta(r.status);
      const outbound = (r.src === colKey);
      const otherKey = outbound ? r.dst : r.src;
      const dir = outbound ? '→' : '←';
      /* §15.7: indicatore minaccia razzia sul percorso. */
      let threatHtml = '';
      if (T.routePath && T.routeThreat) {
        const path = T.routePath(g, r);
        const th = path ? T.routeThreat(g, path) : 0;
        if (th > 0) {
          const lvl = th >= 0.4 ? 'crit' : 'warn';
          threatHtml = ' · <span class="route-item__threat is-' + lvl + '" title="Rischio razzia pirata sul percorso">☠ ' + Math.round(th * 100) + '%</span>';
        }
      }
      return '<li class="route-item">' +
        '<div class="route-item__head">' +
          '<span class="route-item__dir">' + dir + '</span>' +
          '<span class="route-item__peer">' + colonyNameFromKey(otherKey) + '</span>' +
          '<span class="route-item__res">' + resIcon(r.resource) + ' ' + r.rate + '/' + iU() + '</span>' +
          '<span class="route-item__status is-' + meta.cls + '">' + meta.label + '</span>' +
        '</div>' +
        '<div class="route-item__foot">' +
          '<span class="route-item__hops">' + (r.hops | 0) + ' salti · consegnato ' + Math.round(r.delivered || 0) + threatHtml + '</span>' +
          (outbound ? '<button class="btn btn--mini btn--danger" data-action="route-cancel" data-rid="' + r.id + '" type="button">Chiudi rotta</button>' : '') +
        '</div>' +
      '</li>';
    }).join('') + '</ul>';
  } else {
    html += '<p class="panel__note">Nessuna rotta da questa colonia.</p>';
  }
  const idle = T.idleMercantili(colony);
  const canOpen = marketLvl >= 0 && cap.routes > 0 && used < cap.routes && idle.length > 0;
  html += '<button class="btn btn--mini btn--enter" data-action="route-new" type="button"' +
    (canOpen ? '' : ' disabled') +
    ' title="' + (cap.routes <= 0 ? 'Serve un Mercato' : (used >= cap.routes ? 'Limite rotte raggiunto' : (idle.length <= 0 ? 'Serve un mercantile a riposo' : 'Apri una nuova rotta da questa colonia'))) + '">' +
    '+ Nuova rotta' +
  '</button>';
  html += '<p class="panel__note">Le rotte spostano una risorsa per Impulso da questa colonia a un\'altra (early: cibo/acqua dai mondi-giardino ai mondi-fabbrica → sblocca il tetto popolazione). Il flusso è passivo, limitato dal Mercato (rotte+throughput) e dal raggio del mercantile.</p>';

  /* ----- Banco regionale (M12 Fase A2, §15.4) ----- */
  const Tr = ORION.treasury;
  if (Tr) {
    const cluster = Tr.clusterOfColony(g, colKey);
    const cur = Tr.currencyFor(g, cluster);
    if (cur) {
      const bal = Tr.balance(g, cluster);
      const sp = Tr.spread(g, cluster);
      const mek = Tr.mekhariInCluster(g, cluster);
      html += '<p class="sysinfo__sub">Banco regionale <span class="cantieri-section__hint">(' + escapeHtml(cur.name) + ')</span></p>';
      html += '<dl class="sysinfo__list">' +
        row('Valuta locale', '<strong>' + bal.toFixed(2) + '</strong> ' + escapeHtml(cur.symbol)) +
        row('Spread', Math.round(sp * 100) + '%' + (mek ? ' <span class="cur-item__mek" title="Mekhari presente">⬡</span>' : '')) +
      '</dl>';
      html += '<div class="bank-grid">' + TRADE_BANK_RES.map(function (k) {
        const qs = Tr.quoteSell(g, colKey, k, 10);
        const qb = Tr.quoteBuy(g, colKey, k, 10);
        const stock = Math.round((colony.stock[k] || 0));
        return '<div class="bank-row">' +
          '<span class="bank-row__res">' + resIcon(k) + ' ' + tradeResLabel(k) + ' <span class="bank-row__stock">(' + stock + ')</span></span>' +
          '<button class="btn btn--mini" data-action="bank-sell" data-res="' + k + '" type="button" title="Vendi 10 → +' + (qs.ok ? qs.get.toFixed(1) : '0') + ' ' + escapeHtml(cur.symbol) + '">Vendi 10</button>' +
          '<button class="btn btn--mini" data-action="bank-buy" data-res="' + k + '" type="button" title="Compra 10 → −' + (qb.ok ? qb.cost.toFixed(1) : '0') + ' ' + escapeHtml(cur.symbol) + '">Compra 10</button>' +
        '</div>';
      }).join('') + '</div>';
      html += '<p class="panel__note">Vendi le risorse in eccedenza per <em>valuta locale</em>, o comprala dove sei carente. Lo spread cala con reputazione alta e dove operano i Mekhari. Cambia tra valute dalla vista <em>Mercato</em>.</p>';
    }
  }
  html += '</div>';

  host.innerHTML = html;

  host.querySelectorAll('[data-action="merc-build"]').forEach(function (b) {
    b.addEventListener('click', function () { doBuildMercantile(colony, Number(b.dataset.tier)); });
  });
  host.querySelectorAll('[data-action="merc-cancel"]').forEach(function (b) {
    b.addEventListener('click', function () { doCancelMercantile(colony, Number(b.dataset.idx)); });
  });
  host.querySelectorAll('[data-action="route-cancel"]').forEach(function (b) {
    b.addEventListener('click', function () { doCancelRoute(b.dataset.rid); });
  });
  host.querySelectorAll('[data-action="bank-sell"]').forEach(function (b) {
    b.addEventListener('click', function () { doBankTrade(colony, 'sell', b.dataset.res); });
  });
  host.querySelectorAll('[data-action="bank-buy"]').forEach(function (b) {
    b.addEventListener('click', function () { doBankTrade(colony, 'buy', b.dataset.res); });
  });
  const nb = host.querySelector('[data-action="route-new"]');
  if (nb && !nb.disabled) nb.addEventListener('click', function () { openRoutePicker(colony); });
}

/* Sublabel del launcher "Mercato" (sx): rotte attive + n. valute possedute.
   Niente "crediti neutri" in UI: il giocatore non ha mai esperito un credito,
   è solo un'unità di calcolo. Mostriamo invece quante valute distinte ha. */
function marketLauncherSub() {
  const g = ORION.game;
  if (!g) return 'M12';
  const routes = (ORION.trade && ORION.trade.routesUsed(g)) || 0;
  const held = (ORION.treasury && ORION.treasury.heldCurrencies(g)) || [];
  const parts = [];
  if (routes > 0) parts.push(routes + ' rotte');
  if (held.length > 0) parts.push(held.length + (held.length === 1 ? ' valuta' : ' valute'));
  return parts.length ? parts.join(' · ') : 'M12';
}

const TRADE_BANK_RES = ['met', 'en', 'food', 'water'];
const TRADE_BANK_QTY = 10;
function doBankTrade(colony, dir, resource) {
  const g = ORION.game;
  const Tr = ORION.treasury;
  if (!Tr) return;
  const colKey = colony.systemId + ':' + colony.bodyKey;
  const r = (dir === 'sell')
    ? Tr.sellResource(g, colKey, resource, TRADE_BANK_QTY)
    : Tr.buyResource(g, colKey, resource, TRADE_BANK_QTY);
  if (!r.ok) { showToast(r.reason || 'Operazione rifiutata'); return; }
  if (ORION.tutorial) ORION.tutorial.fire('treasury');
  showToast(dir === 'sell'
    ? 'Venduti ' + TRADE_BANK_QTY + ' ' + tradeResLabel(resource) + ' → +' + r.got.toFixed(1) + ' ' + r.currency.symbol
    : 'Comprati ' + TRADE_BANK_QTY + ' ' + tradeResLabel(resource) + ' → −' + r.cost.toFixed(1) + ' ' + r.currency.symbol);
  persistGame(g);
  updatePlanetUI();
}

function doBuildMercantile(colony, tier) {
  const t = ORION.trade.getTier(tier);
  const msg = '<p>Costruire <strong>' + escapeHtml(t ? t.name : 'Mercantile') + '</strong> presso l\'Hangar di <strong>' + escapeHtml((colony && colony.body && colony.body.name) || '—') + '</strong>?</p>' +
    (t && t.cost ? '<p>Costo: <strong>' + formatCostHtml(t.cost) + '</strong><br>Tempo: <strong>' + (t.time || 0) + ' Ι</strong></p>' : '');
  confirmAction({
    title: 'Costruzione mercantile',
    message: msg,
    confirmLabel: 'Costruisci',
    onConfirm: function () {
      const g = ORION.game;
      const colKey = colony.systemId + ':' + colony.bodyKey;
      const r = ORION.trade.startMercantileBuild(colony, null, g, colKey, tier);
      if (!r.ok) { showToast(r.reason || 'Costruzione rifiutata'); return; }
      if (ORION.tutorial) ORION.tutorial.fire('mercantili');
      showToast((t ? t.name : 'Mercantile') + ' in costruzione');
      persistGame(g);
      updatePlanetUI();
    }
  });
}
function doCancelMercantile(colony, idx) {
  confirmAction({
    title: 'Annulla costruzione mercantile',
    message: '<p>Annullare la costruzione del mercantile in coda?</p>',
    confirmLabel: 'Sì, annulla',
    cancelLabel: 'Continua',
    onConfirm: function () {
      const g = ORION.game;
      const r = ORION.trade.cancelMercantileBuild(colony, idx);
      if (!r.ok) { showToast(r.reason || 'Annullamento rifiutato'); return; }
      persistGame(g);
      updatePlanetUI();
    }
  });
}
function doCancelRoute(routeId) {
  confirmAction({
    title: 'Chiudi rotta commerciale',
    message: '<p>Chiudere la rotta? Il mercantile assegnato torna a riposo.</p>',
    confirmLabel: 'Chiudi rotta',
    cancelLabel: 'Mantieni',
    onConfirm: function () {
      const g = ORION.game;
      const r = ORION.trade.cancelRoute(g, routeId);
      if (!r.ok) { showToast(r.reason || 'Chiusura rifiutata'); return; }
      showToast('Rotta chiusa');
      persistGame(g);
      updatePlanetUI();
      if (ORION._currentView === 'market') renderView(document.querySelector('[data-view-stage]'), 'market');
    }
  });
}

/* Overlay creazione rotta: destinazione (colonia raggiungibile) + risorsa
   + mercantile + rate. */
function openRoutePicker(colony) {
  const g = ORION.game;
  const T = ORION.trade;
  /* Chiave derivata dalla colonia (robusta nel contesto dx, dove al click
     ORION.openPlanetKey è già ripristinato alla colonia del centro). */
  const srcKey = colony.systemId + ':' + colony.bodyKey;
  const idle = T.idleMercantili(colony);
  if (!idle.length) { showToast('Nessun mercantile a riposo'); return; }

  /* Stato di selezione locale all'overlay. */
  let mercId = idle[0].id;
  let resource = 'food';

  let host = document.querySelector('[data-bind="route-picker"]');
  if (!host) {
    host = document.createElement('div');
    host.className = 'expedition-pick-overlay';
    host.setAttribute('data-bind', 'route-picker');
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-modal', 'true');
    host.setAttribute('aria-label', 'Nuova rotta commerciale');
    document.body.appendChild(host);
  }

  function destinations() {
    /* Colonie del giocatore diverse dalla sorgente, raggiungibili entro il
       raggio del mercantile selezionato. */
    const merc = T.findMercantile(colony, mercId);
    const maxHops = merc ? T.mercantileMaxHops(merc) : 1;
    return myColonyKeys().filter(function (k) {
      if (k === srcKey) return false;
      const c = g.colonies[k];
      if (!c || !c.colonized) return false;
      const hops = T.routeHopCount(g, srcKey, k);
      return hops > 0 && hops <= maxHops;
    });
  }

  function render() {
    const merc = T.findMercantile(colony, mercId);
    const maxRate = merc ? T.mercantileCargo(merc) : 1;
    const dests = destinations();
    const mercOpts = idle.map(function (m) {
      const t = T.getTier(m.tier) || {};
      return '<option value="' + m.id + '"' + (m.id === mercId ? ' selected' : '') + '>' +
        escapeHtml(t.name || ('Tier ' + m.tier)) + ' · ' + T.rankLabel(m.xp) + ' · cargo ' + T.mercantileCargo(m) + ' · ' + T.mercantileMaxHops(m) + ' salti</option>';
    }).join('');
    const resOpts = T.TRADE_RESOURCES.map(function (k) {
      return '<option value="' + k + '"' + (k === resource ? ' selected' : '') + '>' + tradeResLabel(k) + '</option>';
    }).join('');
    const destCards = dests.length ? dests.map(function (k) {
      const hops = T.routeHopCount(g, srcKey, k);
      const c = g.colonies[k];
      const stock = c.stock ? Math.round(c.stock[resource] || 0) : 0;
      return '<div class="route-dest-card">' +
        '<div class="route-dest-card__head">' +
          '<span class="route-dest-card__name">' + colonyNameFromKey(k) + '</span>' +
          '<span class="route-dest-card__hops">' + hops + ' salti</span>' +
        '</div>' +
        '<p class="route-dest-card__meta">' + tradeResLabel(resource) + ' in loco: ' + stock + '</p>' +
        '<button class="btn btn--mini btn--primary" data-action="route-do" data-dst="' + k + '" type="button">Apri rotta</button>' +
      '</div>';
    }).join('') : '<p class="panel__note">Nessuna colonia raggiungibile entro il raggio del mercantile. Usa un mercantile di livello superiore o avvicina le colonie.</p>';

    host.innerHTML =
      '<div class="expedition-pick-overlay__panel" role="document">' +
        '<header class="expedition-pick-overlay__head">' +
          '<h2 class="expedition-pick-overlay__title">Nuova rotta da ' + colonyNameFromKey(srcKey) + '</h2>' +
          '<button class="btn btn--mini btn--icon-only" data-action="route-pick-close" type="button" aria-label="Chiudi">' +
            '<span class="ui-icon" aria-hidden="true">' + ((ORION.icon && ORION.icon('close')) || '✕') + '</span>' +
          '</button>' +
        '</header>' +
        '<div class="route-picker__controls">' +
          '<label class="route-picker__field">Mercantile <select data-bind="route-merc">' + mercOpts + '</select></label>' +
          '<label class="route-picker__field">Risorsa <select data-bind="route-res">' + resOpts + '</select></label>' +
          '<span class="route-picker__rate">Flusso max: <strong>' + maxRate + '</strong> ' + iU() + '</span>' +
        '</div>' +
        '<div class="expedition-pick-overlay__grid">' + destCards + '</div>' +
        '<p class="panel__note">Il flusso parte al massimo del cargo del mercantile (regolabile poi cancellando e ricreando la rotta). Si interrompe da solo se la sorgente esaurisce la risorsa.</p>' +
      '</div>';

    host.querySelector('[data-bind="route-merc"]').addEventListener('change', function () {
      mercId = this.value; render();
    });
    host.querySelector('[data-bind="route-res"]').addEventListener('change', function () {
      resource = this.value; render();
    });
    host.querySelectorAll('[data-action="route-do"]').forEach(function (b) {
      b.addEventListener('click', function () { doCreateRoute(srcKey, b.dataset.dst, resource, mercId); });
    });
    host.querySelector('[data-action="route-pick-close"]').addEventListener('click', closeRoutePicker);
  }

  host.addEventListener('click', function (e) { if (e.target === host) closeRoutePicker(); });
  render();
  host.hidden = false;
}
function closeRoutePicker() {
  const host = document.querySelector('[data-bind="route-picker"]');
  if (host) { host.hidden = true; host.innerHTML = ''; }
}
function doCreateRoute(srcKey, dstKey, resource, mercId) {
  const g = ORION.game;
  const r = ORION.trade.createRoute(g, srcKey, dstKey, resource, null, mercId);
  if (!r.ok) { showToast(r.reason || 'Rotta rifiutata'); return; }
  pushChronicle(ORION.time.currentDS(g) + ' — Nuova rotta commerciale: ' +
    colonyNameFromKey(srcKey) + ' → ' + colonyNameFromKey(dstKey) +
    ' · <strong>' + tradeResLabel(resource) + '</strong> ' + r.route.rate + '/' + iU() + '.', 'planet');
  if (ORION.tutorial) ORION.tutorial.fire('trade-routes');
  closeRoutePicker();
  persistGame(g);
  updatePlanetUI();
}

/* =====================================================================
   M12 Fase A1 — Vista MERCATO (riepilogo d'impero, decisione #53 §15.2)
   ===================================================================== */
function renderMarketView(stage) {
  if (!stage) return;
  const g = ORION.game;
  const T = ORION.trade;
  if (!g || !T) return;
  if (ORION.tutorial) ORION.tutorial.fire('trade-routes');

  const cap = T.marketCapacity(g);
  const routes = T.activeRoutes(g);
  /* Conta mercantili su tutte le colonie. */
  let totalMercs = 0, idleMercs = 0;
  myColonyKeys().forEach(function (k) {
    const c = g.colonies[k];
    const ms = (c && c.mercantili) || [];
    totalMercs += ms.length;
    ms.forEach(function (m) { if (m.status !== 'on-route') idleMercs++; });
  });

  let routesHtml;
  if (routes.length) {
    routesHtml = '<ul class="route-list">' + routes.map(function (r) {
      const meta = tradeRouteStatusMeta(r.status);
      return '<li class="route-item">' +
        '<div class="route-item__head">' +
          '<span class="route-item__peer">' + colonyNameFromKey(r.src) + ' → ' + colonyNameFromKey(r.dst) + '</span>' +
          '<span class="route-item__res">' + resIcon(r.resource) + ' ' + r.rate + '/' + iU() + '</span>' +
          '<span class="route-item__status is-' + meta.cls + '">' + meta.label + '</span>' +
        '</div>' +
        '<div class="route-item__foot">' +
          '<span class="route-item__hops">' + (r.hops | 0) + ' salti · consegnato ' + Math.round(r.delivered || 0) + '</span>' +
          '<button class="btn btn--mini btn--danger" data-action="market-route-cancel" data-rid="' + r.id + '" type="button">Chiudi rotta</button>' +
        '</div>' +
      '</li>';
    }).join('') + '</ul>';
  } else {
    routesHtml = '<p class="panel__note">Nessuna rotta attiva. Apri rotte dalla tab <em>Rotte</em> di una colonia con un Mercato e un mercantile.</p>';
  }

  /* ----- Tesoreria (M12 Fase A2, §15.4) ----- */
  const Tr = ORION.treasury;
  let treasuryHtml = '';
  if (Tr) {
    const held = Tr.heldCurrencies(g);
    let portfolio;
    if (held.length) {
      portfolio = '<ul class="cur-list">' + held.map(function (c) {
        const mek = Tr.mekhariInCluster(g, c.clusterId);
        return '<li class="cur-item">' +
          '<span class="cur-item__sym" title="' + escapeHtml(c.region) + '">' + escapeHtml(c.symbol) + '</span>' +
          '<span class="cur-item__name">' + escapeHtml(c.name) + (mek ? ' <span class="cur-item__mek" title="Sindacato Mekhari presente: spread ridotto">⬡</span>' : '') + '</span>' +
          '<span class="cur-item__bal">' + Tr.balance(g, c.clusterId).toFixed(2) + '</span>' +
        '</li>';
      }).join('') + '</ul>';
    } else {
      portfolio = '<p class="panel__note">Portfolio vuoto. Vendi risorse al <em>Banco regionale</em> (tab Rotte di una colonia) per ottenere valuta locale.</p>';
    }
    treasuryHtml =
      '<p class="sysinfo__sub">Tesoreria <span class="cantieri-section__hint">(' + (held.length || 'nessuna') + (held.length === 1 ? ' valuta' : ' valute') + ')</span></p>' +
      portfolio +
      '<button class="btn btn--mini btn--enter" data-action="treasury-exchange" type="button"' +
        (held.length ? '' : ' disabled') + '>⇄ Cambia valuta</button>';
  }

  /* ----- Mercato grigio Mekhari (M12 Fase B, §15.5) ----- */
  const mekhariHtml = buildMekhariPanel(g);

  stage.innerHTML =
    '<div class="fleet-view market-view">' +
      '<header class="fleet-view__head">' +
        '<h2 class="fleet-view__title">Mercato interno <span class="fleet-view__sub">M12 · Commercio</span></h2>' +
      '</header>' +
      '<div class="market-summary">' +
        '<div class="market-summary__cell"><span class="market-summary__val">' + routes.length + ' / ' + cap.routes + '</span><span class="market-summary__lbl">Rotte attive</span></div>' +
        '<div class="market-summary__cell"><span class="market-summary__val">' + cap.throughput + '</span><span class="market-summary__lbl">Throughput ' + iU() + '</span></div>' +
        '<div class="market-summary__cell"><span class="market-summary__val">' + idleMercs + ' / ' + totalMercs + '</span><span class="market-summary__lbl">Mercantili a riposo</span></div>' +
      '</div>' +
      '<p class="sysinfo__sub">Rotte d\'impero</p>' +
      routesHtml +
      treasuryHtml +
      mekhariHtml +
      '<p class="panel__note">La capacità di rotte e throughput è data dai <em>Mercati</em> §10 di tutte le tue colonie. ' +
        'Le <em>valute regionali</em> (una per regione) si guadagnano vendendo risorse al banco regionale e si cambiano qui con spread modulato da reputazione + presenza Mekhari.</p>' +
    '</div>';

  stage.querySelectorAll('[data-action="market-route-cancel"]').forEach(function (b) {
    b.addEventListener('click', function () {
      const r = ORION.trade.cancelRoute(g, b.dataset.rid);
      if (!r.ok) { showToast(r.reason || 'Chiusura rifiutata'); return; }
      persistGame(g);
      renderMarketView(stage);
    });
  });
  const exBtn = stage.querySelector('[data-action="treasury-exchange"]');
  if (exBtn && !exBtn.disabled) exBtn.addEventListener('click', function () { openExchangeOverlay(stage); });
  /* Mekhari: selettore colonia + acquisti contrabbando. */
  const mekSel = stage.querySelector('[data-bind="mek-colony"]');
  if (mekSel) mekSel.addEventListener('change', function () { ORION.mekhariColonyKey = this.value; renderMarketView(stage); });
  stage.querySelectorAll('[data-action="mek-buy"]').forEach(function (b) {
    b.addEventListener('click', function () { doSmuggle(b.dataset.res, stage); });
  });
}

/* Pannello del mercato grigio Mekhari (§15.5 b). Visibile solo se i Mekhari
   sono stati contattati. Compra risorse base per una colonia pagando dalla
   Tesoreria (qualunque valuta) a sovrapprezzo + costo reputazione. */
const MEKHARI_LOT = 25;
function buildMekhariPanel(g) {
  const MK = ORION.mekhari;
  if (!MK || !MK.isAvailable(g)) return '';
  const mine = myColonyKeys().filter(function (k) { const c = g.colonies[k]; return c && c.colonized; });
  if (!mine.length) return '';
  /* Colonia selezionata (memoria, non salvata). */
  if (!ORION.mekhariColonyKey || mine.indexOf(ORION.mekhariColonyKey) < 0) ORION.mekhariColonyKey = mine[0];
  const colKey = ORION.mekhariColonyKey;
  const sc = MK.surcharge(g);
  const credits = (ORION.treasury && ORION.treasury.totalCredits(g)) || 0;
  /* Prezzo mostrato nella valuta della regione della colonia destinataria
     (è il "prezzo equivalente locale"). Il backend continua a spendere via
     spendCredits attingendo da qualunque valuta del portfolio. */
  const Tr = ORION.treasury;
  const colCluster = Tr ? Tr.clusterOfColony(g, colKey) : null;
  const localCur = (Tr && colCluster != null) ? Tr.currencyFor(g, colCluster) : null;
  const localPrice = function (cr) {
    return (localCur && localCur.value > 0) ? (cr / localCur.value) : cr;
  };
  const localSym = localCur ? localCur.symbol : '';
  const colOpts = mine.map(function (k) {
    return '<option value="' + k + '"' + (k === colKey ? ' selected' : '') + '>' + colonyNameFromKey(k) + '</option>';
  }).join('');
  const rows = MK.BUY_RES.map(function (res) {
    const q = MK.quoteSmuggle(g, colKey, res, MEKHARI_LOT);
    const afford = q.ok && credits + 1e-6 >= q.costCredits;
    const priceLocal = q.ok ? localPrice(q.costCredits) : 0;
    const title = q.ok ? ('Compra ' + MEKHARI_LOT + ' → ≈ ' + priceLocal.toFixed(0) + ' ' + localSym + ' equivalenti · −' + q.repCost.toFixed(1) + ' reputazione') : (q.reason || '');
    return '<div class="bank-row">' +
      '<span class="bank-row__res">' + resIcon(res) + ' ' + tradeResLabel(res) + '</span>' +
      '<button class="btn btn--mini" data-action="mek-buy" data-res="' + res + '" type="button"' + (afford ? '' : ' disabled') + ' title="' + escapeHtml(title) + '">' +
        'Compra ' + MEKHARI_LOT + ' <span class="mek-cost">≈' + (q.ok ? priceLocal.toFixed(0) + ' ' + localSym : '—') + '</span>' +
      '</button>' +
    '</div>';
  }).join('');
  return '<p class="sysinfo__sub">Mercato grigio Mekhari <span class="cantieri-section__hint">(sovrapprezzo ' + Math.round(sc * 100) + '% · costa reputazione)</span></p>' +
    '<label class="route-picker__field">Colonia <select data-bind="mek-colony">' + colOpts + '</select></label>' +
    '<div class="bank-grid">' + rows + '</div>' +
    '<p class="panel__note">Il Sindacato Mekhari rifornisce qualunque colonia accettando <em>qualunque valuta</em> del tuo portfolio — utile dove non hai la valuta locale o sei bloccato. Paghi un sovrapprezzo da <strong>mercato grigio</strong> e un <strong>costo di reputazione</strong> §14 (pista Tiranno). Mercato secondario delle risorse avanzate e contratti mercenari arrivano con M13/M14.</p>';
}

function doSmuggle(resource, stage) {
  const g = ORION.game;
  const MK = ORION.mekhari;
  if (!MK) return;
  const colKey = ORION.mekhariColonyKey;
  const r = MK.buySmuggle(g, colKey, resource, MEKHARI_LOT);
  if (!r.ok) { showToast(r.reason || 'Acquisto rifiutato'); return; }
  /* Voce cronaca: prezzo nella valuta della regione di destinazione (no "crediti" in UI). */
  const Tr = ORION.treasury;
  const colCluster = Tr ? Tr.clusterOfColony(g, colKey) : null;
  const localCur = (Tr && colCluster != null) ? Tr.currencyFor(g, colCluster) : null;
  const priceLocal = (localCur && localCur.value > 0) ? (r.costCredits / localCur.value) : r.costCredits;
  const priceLabel = localCur ? (priceLocal.toFixed(0) + ' ' + localCur.symbol + ' equivalenti') : (priceLocal.toFixed(0));
  pushChronicle(ORION.time.currentDS(g) + ' — Mercato grigio Mekhari: ' + MEKHARI_LOT + ' ' + tradeResLabel(resource) +
    ' a ' + colonyNameFromKey(colKey) + ' (≈ ' + priceLabel + ' · −' + r.repCost.toFixed(1) + ' reputazione).', 'system');
  if (ORION.tutorial) ORION.tutorial.fire('mekhari');
  showToast('Contrabbando: +' + MEKHARI_LOT + ' ' + tradeResLabel(resource));
  persistGame(g);
  if (stage) renderMarketView(stage);
}

/* Overlay di cambio valuta (M12 Fase A2, §15.4). */
function openExchangeOverlay(marketStage) {
  const g = ORION.game;
  const Tr = ORION.treasury;
  if (!Tr) return;
  const all = Tr.currencies(g);
  const held = Tr.heldCurrencies(g);
  if (!held.length) { showToast('Nessuna valuta da cambiare'); return; }
  let fromC = held[0].clusterId;
  let toC = (all.find(function (c) { return c.clusterId !== fromC; }) || held[0]).clusterId;
  let amount = '';

  let host = document.querySelector('[data-bind="exchange-overlay"]');
  if (!host) {
    host = document.createElement('div');
    host.className = 'expedition-pick-overlay';
    host.setAttribute('data-bind', 'exchange-overlay');
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-modal', 'true');
    host.setAttribute('aria-label', 'Cambia valuta');
    document.body.appendChild(host);
  }

  function curName(cid) { const c = Tr.currencyFor(g, cid); return c ? c.name : '—'; }

  function render() {
    const fromOpts = held.map(function (c) {
      return '<option value="' + c.clusterId + '"' + (c.clusterId === fromC ? ' selected' : '') + '>' +
        escapeHtml(c.name) + ' · ' + Tr.balance(g, c.clusterId).toFixed(2) + '</option>';
    }).join('');
    const toOpts = all.filter(function (c) { return c.clusterId !== fromC; }).map(function (c) {
      return '<option value="' + c.clusterId + '"' + (c.clusterId === toC ? ' selected' : '') + '>' + escapeHtml(c.name) + '</option>';
    }).join('');
    host.innerHTML =
      '<div class="expedition-pick-overlay__panel" role="document">' +
        '<header class="expedition-pick-overlay__head">' +
          '<h2 class="expedition-pick-overlay__title">Cambia valuta</h2>' +
          '<button class="btn btn--mini btn--icon-only" data-action="ex-close" type="button" aria-label="Chiudi">' +
            '<span class="ui-icon" aria-hidden="true">' + ((ORION.icon && ORION.icon('close')) || '✕') + '</span>' +
          '</button>' +
        '</header>' +
        '<div class="route-picker__controls">' +
          '<label class="route-picker__field">Da <select data-bind="ex-from">' + fromOpts + '</select></label>' +
          '<label class="route-picker__field">A <select data-bind="ex-to">' + toOpts + '</select></label>' +
          '<label class="route-picker__field">Importo <input type="number" min="0" step="1" data-bind="ex-amt" value="' + escapeHtml(amount) + '"></label>' +
        '</div>' +
        '<p class="panel__note" data-bind="ex-quote"></p>' +
        '<div class="expedition-card__actions">' +
          '<button class="btn btn--mini btn--primary" data-action="ex-do" type="button">Esegui cambio</button>' +
        '</div>' +
        '<p class="panel__note">Lo spread dipende dalla tua reputazione §14 e dalla presenza del Sindacato Mekhari nella regione di destinazione (arbitraggio → spread più basso).</p>' +
      '</div>';

    /* Aggiorna solo riga quote + stato bottone (no full re-render sul tasto). */
    function refreshQuote() {
      const amt = parseFloat(amount) || 0;
      const q = (amt > 0) ? Tr.quoteExchange(g, fromC, toC, amt) : null;
      const line = host.querySelector('[data-bind="ex-quote"]');
      const doBtn = host.querySelector('[data-action="ex-do"]');
      if (q && q.ok && Tr.balance(g, fromC) >= amt) {
        line.innerHTML = 'Ricevi <strong>' + q.get.toFixed(2) + '</strong> ' + escapeHtml(curName(toC)) +
          ' · tasso ' + q.rate.toFixed(3) + ' · spread ' + Math.round(q.spread * 100) + '%';
        doBtn.disabled = false;
      } else {
        line.innerHTML = (amt > 0 && Tr.balance(g, fromC) < amt) ? 'Saldo insufficiente.' : 'Inserisci un importo da cambiare.';
        doBtn.disabled = true;
      }
    }
    refreshQuote();

    host.querySelector('[data-bind="ex-from"]').addEventListener('change', function () { fromC = Number(this.value); if (toC === fromC) { const alt = all.find(function (c) { return c.clusterId !== fromC; }); toC = alt ? alt.clusterId : toC; } render(); });
    host.querySelector('[data-bind="ex-to"]').addEventListener('change', function () { toC = Number(this.value); render(); });
    host.querySelector('[data-bind="ex-amt"]').addEventListener('input', function () { amount = this.value; refreshQuote(); });
    host.querySelector('[data-action="ex-close"]').addEventListener('click', closeExchangeOverlay);
    host.querySelector('[data-action="ex-do"]').addEventListener('click', function () {
      const r = Tr.exchange(g, fromC, toC, parseFloat(amount) || 0);
      if (!r.ok) { showToast(r.reason || 'Cambio rifiutato'); return; }
      showToast('Cambiati ' + r.spent.toFixed(2) + ' → ' + r.got.toFixed(2) + ' ' + curName(toC));
      persistGame(g);
      closeExchangeOverlay();
      if (marketStage) renderMarketView(marketStage);
    });
  }
  host.addEventListener('click', function (e) { if (e.target === host) closeExchangeOverlay(); });
  render();
  host.hidden = false;
}
function closeExchangeOverlay() {
  const host = document.querySelector('[data-bind="exchange-overlay"]');
  if (host) { host.hidden = true; host.innerHTML = ''; }
}

/* =====================================================================
   M08 Fase A — Vista FLOTTE (decisione #42)
   Lista flotte + overlay "Crea flotta" + overlay "Ordini" + bottone
   "Dissolvi". UI volutamente minima: la mappa attiva (drag-and-drop su
   sistemi) arriva in Fase B.
   ===================================================================== */
function renderFleetView(stage) {
  if (!stage) return;
  const g = ORION.game;
  if (!g) return;
  if (!Array.isArray(g.fleets)) g.fleets = [];
  /* M08 Fase B: tutorial — overview alla prima apertura della vista. */
  if (ORION.tutorial) ORION.tutorial.fire('fleet-overview');

  /* Helpers locali */
  function sysName(id) {
    const s = g.galaxy.systems[id];
    return s ? s.name : '—';
  }
  function fleetStatusLabel(f) {
    if (!f || !f.location) return '—';
    if (f.location.status === 'docked') return 'all\'attracco';
    if (f.location.status === 'in-transit') return 'in transito (ETA ' + (f.etaImpulsi | 0) + ' ' + iU() + ')';
    return 'in orbita';
  }
  function orderLabel(f) {
    const o = f && f.orders;
    if (!o) return 'idle';
    if (o.type === 'idle') return 'in attesa';
    if (o.type === 'move') return 'rotta verso ' + sysName(o.toSysId);
    if (o.type === 'attack') return '⚔ attacco a ' + sysName(o.toSysId);
    if (o.type === 'explore') return 'esplorazione di ' + sysName(o.toSysId);
    if (o.type === 'return') return 'rientro alla base';
    if (o.type === 'patrol') return 'pattuglia ' + sysName(o.sysA) + ' ↔ ' + sysName(o.sysB);
    if (o.type === 'move-route') {
      const tot = (o.waypoints || []).length;
      const cur = (o.wpIdx || 0) + 1;
      return 'rotta a tappe (' + cur + '/' + tot + ')';
    }
    if (o.type === 'patrol-loop') {
      return 'pattuglia ciclica · ' + (o.loop || []).length + ' nodi';
    }
    return o.type;
  }
  function colonyName(key) {
    const parts = (key || '').split(':');
    if (parts.length < 2) return '—';
    const sid = Number(parts[0]);
    const sys = g.galaxy.systems[sid];
    return sys ? sys.name : ('Sistema ' + sid);
  }

  /* Colonie che possono creare una flotta: colonizzate + con Hangar lvl ≥ 1. */
  const eligibleColonies = [];
  Object.keys(g.colonies).forEach(function (k) {
    const c = g.colonies[k];
    if (!c || !c.colonized) return;
    if (!c.structures || !c.structures['cantiere-navale']) return;
    eligibleColonies.push({ key: k, colony: c });
  });

  /* Lista flotte */
  let listHtml;
  if (g.fleets.length === 0) {
    listHtml = '<p class="panel__note">Nessuna flotta attiva. Costruisci scafi in un Hangar e crea una flotta per ' +
      'poter eseguire ordini di movimento/esplorazione.</p>';
  } else {
    listHtml = '<ul class="fleet-list">' + g.fleets.map(function (f) {
      const ships = f.ships || [];
      const counter = {};
      ships.forEach(function (s) { counter[s.kind] = (counter[s.kind] || 0) + 1; });
      const counterHtml = Object.keys(counter).map(function (k) {
        const cls = (ORION.fleet && ORION.fleet.getClass(k)) || { glyph: '?', name: k };
        return '<span title="' + escapeHtml(cls.name) + '">' + cls.glyph + ' ' + counter[k] + '</span>';
      }).join(' · ') || '<span class="cantieri-row__base">flotta vuota</span>';
      const sysTag = (f.location && f.location.systemId >= 0) ? systemTagHtml(f.location.systemId) : '';
      const status = fleetStatusLabel(f);
      const statusCls = (f.location && f.location.status) || 'idle';
      /* M09: veteranità navi (§12.3) — elenca i gradi non-Verdi e i nomi
         delle Leggendarie. */
      const vetHtml = fleetVeterancyHtml(f);
      const FORM_LABEL = { aggressive: 'Aggressiva', balanced: 'Bilanciata', defensive: 'Difensiva' };
      const formation = (f.formation) || 'balanced';
      /* M09 (#43/#49): Comandante assegnato → bonus di specializzazione. */
      const cmd = f.commander;
      /* PR-E: ★ → SVG star ambra per il Comandante (Figura nominata
         emergente dagli equipaggi veterani, decisione #43). */
      const starHtml = uiIcon('star', 'amber');
      const cmdHtml = cmd
        ? '<div class="fleet-item__cmd">' + starHtml + ' <strong>' + escapeHtml(cmd.rank + ' ' + cmd.name) + '</strong> · ' +
            escapeHtml(cmd.specializationLabel || cmd.specialization) +
            ' <span class="fleet-item__cmdbonus">' + escapeHtml(ORION.commander ? ORION.commander.bonusLabel(cmd) : '') + '</span></div>'
        : '';
      const cmdBtnLabel = cmd
        ? (starHtml + ' ' + escapeHtml(cmd.name))
        : (starHtml + ' Comandante');
      return '<li class="fleet-item" data-fleet-id="' + escapeHtml(f.id) + '">' +
        '<div class="fleet-item__head">' +
          '<span class="fleet-item__name"><strong>' + escapeHtml(f.name) + '</strong> ' +
            '<span class="cantieri-row__base">(da ' + escapeHtml(colonyName(f.ownerColonyKey)) + ')</span></span>' +
          '<span class="fleet-status fleet-status--' + statusCls + '">' + status + '</span>' +
        '</div>' +
        '<div class="fleet-item__row">' +
          '<span class="fleet-item__loc">in <strong>' + escapeHtml(sysName(f.location.systemId)) + '</strong>' + sysTag + '</span>' +
          '<span class="fleet-item__order">' + escapeHtml(orderLabel(f)) + '</span>' +
        '</div>' +
        '<div class="fleet-item__ships">' + counterHtml +
          ' · <span class="cantieri-row__base">equipaggio ' + (f.crew ? f.crew.length : 0) + ' / ' +
          (ORION.fleet ? ORION.fleet.fleetCrewRequired(f) : 0) + '</span></div>' +
        vetHtml +
        cmdHtml +
        '<div class="fleet-item__actions">' +
          '<button class="btn btn--mini" data-action="fleet-orders" data-fleet="' + escapeHtml(f.id) + '" type="button">Ordini ▸</button>' +
          '<button class="btn btn--mini btn--with-icon" data-action="fleet-formation" data-fleet="' + escapeHtml(f.id) + '" type="button" title="Soglia di ritirata in battaglia">' +
            '<span class="ui-icon ui-icon--pink" aria-hidden="true">' + ((ORION.icon && ORION.icon('forces')) || '') + '</span> ' + FORM_LABEL[formation] +
          '</button>' +
          '<button class="btn btn--mini" data-action="fleet-commander" data-fleet="' + escapeHtml(f.id) + '" type="button" title="Assegna un Comandante alla flotta">' + cmdBtnLabel + '</button>' +
          '<button class="btn btn--mini" data-action="fleet-manage" data-fleet="' + escapeHtml(f.id) + '" type="button">Gestisci navi/eq.</button>' +
          '<button class="btn btn--mini btn--danger" data-action="fleet-dissolve" data-fleet="' + escapeHtml(f.id) + '" type="button">Dissolvi</button>' +
        '</div>' +
      '</li>';
    }).join('') + '</ul>';
  }

  const canCreate = eligibleColonies.length > 0;
  stage.innerHTML =
    '<div class="fleet-view">' +
      '<header class="fleet-view__head">' +
        '<h2 class="fleet-view__title">Flotte e guerra <span class="fleet-view__sub">M09 · Fase A</span></h2>' +
        '<button class="btn btn--primary" data-action="fleet-create" type="button"' +
          (canCreate ? '' : ' disabled title="Serve una colonia con Hangar di costruzione"') + '>+ Crea flotta</button>' +
      '</header>' +
      buildWarSection(g) +
      '<p class="panel__note">Le flotte si compongono dalle navi a terra e dagli equipaggi della colonia origine. ' +
        'La <strong>formazione</strong> determina la soglia di ritirata in battaglia. Le navi che sopravvivono ' +
        'salgono di grado (Verde→Veterana→Elite→Leggendaria) e diventano più forti.</p>' +
      listHtml +
    '</div>';

  /* Handlers */
  stage.querySelectorAll('[data-action="fleet-create"]').forEach(function (b) {
    b.addEventListener('click', function () { openFleetCreateOverlay(eligibleColonies); });
  });
  stage.querySelectorAll('[data-action="fleet-formation"]').forEach(function (b) {
    b.addEventListener('click', function () { cycleFleetFormation(b.dataset.fleet, stage); });
  });
  stage.querySelectorAll('[data-action="siege-tribute"]').forEach(function (b) {
    b.addEventListener('click', function () { handleSiegeTribute(b.dataset.battle, stage); });
  });
  stage.querySelectorAll('[data-action="siege-retreat"]').forEach(function (b) {
    b.addEventListener('click', function () { handleSiegeRetreat(b.dataset.battle, stage); });
  });
  stage.querySelectorAll('[data-action="battle-report"]').forEach(function (b) {
    b.addEventListener('click', function () { openBattleReport(); });
  });
  stage.querySelectorAll('[data-action="siege-evacuate"]').forEach(function (b) {
    b.addEventListener('click', function () { handleEvacuate(b.dataset.colony, stage); });
  });
  stage.querySelectorAll('[data-action="war-recall"]').forEach(function (b) {
    b.addEventListener('click', function () { handleRecallFleets(stage); });
  });
  stage.querySelectorAll('[data-action="fleet-orders"]').forEach(function (b) {
    b.addEventListener('click', function () { openFleetOrdersOverlay(b.dataset.fleet); });
  });
  stage.querySelectorAll('[data-action="fleet-commander"]').forEach(function (b) {
    b.addEventListener('click', function () { openCommanderPicker(b.dataset.fleet, stage); });
  });
  stage.querySelectorAll('[data-action="fleet-manage"]').forEach(function (b) {
    b.addEventListener('click', function () { openFleetManageOverlay(b.dataset.fleet); });
  });
  stage.querySelectorAll('[data-action="fleet-dissolve"]').forEach(function (b) {
    b.addEventListener('click', function () {
      const fleet = findFleet(b.dataset.fleet);
      if (!fleet) return;
      const r = ORION.fleet.dissolveFleet(g, fleet);
      if (!r.ok) { showToast(r.reason); return; }
      pushChronicle(ORION.time.currentDS(g) + ' — Flotta <strong>' + escapeHtml(fleet.name) + '</strong> sciolta.', 'planet');
      persistGame(g);
      renderFleetView(stage);
    });
  });
}

/* =====================================================================
   M09 Fase A (decisione #49) — UI guerra/assedi + veteranità navi
   ===================================================================== */

/* Sezione "Guerra" in cima alla vista Flotta: morale d'impero + pressione,
   incursioni inbound (con ETA), assedi in corso con le reazioni
   (paga tributo / ritira flotte difensori / rinforza). */
function buildWarSection(g) {
  const ws = g.warState || { morale: 1, pressure: 0 };
  const moralePct = Math.round((ws.morale || 1) * 100);
  const pressPct = Math.round((ws.pressure || 0) * 100);
  const moraleCls = moralePct >= 90 ? 'ok' : moralePct >= 70 ? 'warn' : 'crit';
  const incursions = (g.incursions || []).slice();
  const battles = (g.battles || []).filter(function (b) { return b.status === 'active'; });

  let html = '<div class="war-section">';
  /* M09 Fase B: stato di esilio (0 colonie, partita non-hard). */
  if (g.defeated === 'exile') {
    html += '<div class="war-exile">' + uiIcon('warning', 'gold') + ' <strong>Esilio</strong>: la tua civiltà non ha più colonie. Sopravvivi nelle flotte — ricolonizza per risorgere.</div>';
  }
  html += '<div class="war-meters">' +
    '<div class="war-meter war-meter--' + moraleCls + '"><span class="war-meter__lbl">Morale d\'impero</span>' +
      '<div class="war-meter__bar"><i style="width:' + moralePct + '%"></i></div><span class="war-meter__val">' + moralePct + '%</span></div>' +
    '<div class="war-meter war-meter--press"><span class="war-meter__lbl">Pressione nemica</span>' +
      '<div class="war-meter__bar"><i style="width:' + pressPct + '%"></i></div><span class="war-meter__val">' + pressPct + '%</span></div>' +
    '</div>';

  if (ORION.lastBattle) {
    html += '<button class="btn btn--mini btn--with-icon" data-action="battle-report" type="button">' +
      uiIcon('sword', 'pink') + ' Ultimo report di battaglia ' + uiIcon('chevronRight', 'soft') +
    '</button>';
  }
  /* Leva di recovery: richiamo flotte alla capitale (concentra la difesa). */
  if ((g.fleets || []).length) {
    html += ' <button class="btn btn--mini btn--with-icon" data-action="war-recall" type="button" title="Tutte le flotte rientrano alla colonia origine">' +
      uiIcon('refresh', 'cyan') + ' Richiama flotte' +
    '</button>';
  }

  if (incursions.length) {
    html += '<div class="war-incursions"><h4 class="war-h">Incursioni in arrivo</h4><ul>';
    incursions.forEach(function (inc) {
      html += '<li>' + uiIcon('warning', 'gold') + ' Predoni verso ' + colonyNameFromKey(inc.targetColonyKey) +
        ' · arrivo fra <strong>' + (inc.eta | 0) + ' ' + iU() + '</strong></li>';
    });
    html += '</ul></div>';
  }

  if (battles.length) {
    html += '<div class="war-sieges"><h4 class="war-h">Assedi in corso</h4>';
    battles.forEach(function (b) {
      const C = ORION.combat;
      const atkHp = C ? Math.round(C.totalHp({ combatants: b.attacker.combatants })) : 0;
      const cost = siegeTributeCost(b);
      const costStr = ['met', 'en'].filter(function (k) { return cost[k] > 0; })
        .map(function (k) { return resIcon(k) + ' ' + cost[k]; }).join(' · ');
      const isAi = b.attackerKind === 'ai';
      const who = isAi ? escapeHtml(b.attacker.name) : 'predoni';
      const tributeLbl = isAi ? 'Tributo → tregua' : 'Paga tributo';
      html += '<div class="war-siege' + (isAi ? ' war-siege--ai' : '') + '">' +
        '<div class="war-siege__head">Assedio di ' + colonyNameFromKey(b.colonyKey) +
          ' · round ' + (b.round | 0) + ' · ' + who + ' ' + atkHp + ' hp</div>' +
        '<div class="war-siege__actions">' +
          '<button class="btn btn--mini btn--with-icon" data-action="siege-retreat" data-battle="' + escapeHtml(b.id) + '" type="button">' +
            uiIcon('refresh', 'cyan') + ' Ritira flotte</button>' +
          '<button class="btn btn--mini btn--with-icon" data-action="siege-tribute" data-battle="' + escapeHtml(b.id) + '" type="button">' +
            uiIcon('diplomacy', 'amber') + ' ' + tributeLbl + ' (' + (costStr || 'gratis') + ')</button>' +
          '<button class="btn btn--mini btn--with-icon btn--danger" data-action="siege-evacuate" data-colony="' + escapeHtml(b.colonyKey) + '" type="button" title="Abbandona la colonia recuperando metà delle risorse alla capitale">' +
            uiIcon('warning', 'pink') + ' Evacua colonia</button>' +
        '</div>' +
        '<p class="war-siege__hint">Rinforza spostando una flotta su questo sistema (si unisce alla difesa al prossimo round); oppure consolida altrove.</p>' +
      '</div>';
    });
    html += '</div>';
  }

  if (!incursions.length && !battles.length) {
    html += '<p class="panel__note war-quiet">Nessuna minaccia diretta. Le difese planetarie (Batteria ⊕, Scudo ◈) ' +
      'proteggono i sistemi delle colonie; le flotte difendono dove sostano.</p>';
  }
  html += '</div>';
  return html;
}

/* Costo del tributo per chiudere un assedio: proporzionale alla forza
   residua dei predoni (leva di recovery, recovery-friendly #49). */
function siegeTributeCost(battle) {
  const C = ORION.combat;
  const atkHp = C ? C.totalHp({ combatants: battle.attacker.combatants }) : 50;
  return { met: Math.round(atkHp * 0.6), en: Math.round(atkHp * 0.3) };
}

/* Veteranità di una flotta (§12.3): righe per le navi non-Verdi. */
function fleetVeterancyHtml(fleet) {
  const C = ORION.combat;
  if (!C || !fleet.ships || !fleet.ships.length) return '';
  const vets = fleet.ships.filter(function (s) { return (s.xp || 0) >= 1; });
  if (!vets.length) return '';
  const chips = vets.map(function (s) {
    const cls = (ORION.fleet && ORION.fleet.getClass(s.kind)) || { name: s.kind };
    const lbl = C.veterancyLabel(s.xp || 0);
    const nm = s.name ? ' «' + escapeHtml(s.name) + '»' : '';
    return '<span class="vet-chip vet-chip--' + C.veterancyTierIndex(s.xp || 0) + '">' +
      escapeHtml(cls.name) + nm + ' · ' + lbl + '</span>';
  }).join('');
  return '<div class="fleet-item__vets">' + chips + '</div>';
}

function cycleFleetFormation(fleetId, stage) {
  const g = ORION.game; const fleet = findFleet(fleetId);
  if (!fleet || !ORION.fleet) return;
  const order = ORION.fleet.FORMATIONS || ['aggressive', 'balanced', 'defensive'];
  const cur = order.indexOf(fleet.formation || 'balanced');
  const next = order[(cur + 1) % order.length];
  ORION.fleet.setFormation(fleet, next);
  persistGame(g);
  renderFleetView(stage);
}

/* M09 (#43/#49): overlay di assegnazione Comandante → flotta. Elenca i
   Comandanti idle in panchina su tutte le colonie + opzione di rilascio. */
function openCommanderPicker(fleetId, stage) {
  const g = ORION.game;
  const fleet = findFleet(fleetId);
  if (!fleet || !ORION.commander) return;
  const avail = ORION.commander.assignableOf(g);
  const cur = fleet.commander;
  if (!avail.length && !cur) { showToast('Nessun Comandante disponibile — emergono dagli equipaggi veterani (xp≥5)'); return; }
  const starHtml = uiIcon('star', 'amber');
  const rows = avail.map(function (a) {
    const c = a.commander;
    return '<button class="cmd-pick__row" data-cmd="' + escapeHtml(c.id) + '" type="button">' +
      '<span class="cmd-pick__name">' + starHtml + ' ' + escapeHtml(c.rank + ' ' + c.name) + '</span>' +
      '<span class="cmd-pick__meta">' + escapeHtml(c.specializationLabel || c.specialization) +
        ' · ' + escapeHtml(ORION.commander.bonusLabel(c)) + ' · ' + escapeHtml(c.traitLabel || '') +
        ' · da ' + escapeHtml(colonyName(a.colonyKey)) + '</span>' +
    '</button>';
  }).join('') || '<p class="cmd-pick__empty">Nessun Comandante in panchina.</p>';
  const curHtml = cur
    ? '<div class="cmd-pick__current">Assegnato: <strong>' + starHtml + ' ' + escapeHtml(cur.rank + ' ' + cur.name) + '</strong> · ' +
        escapeHtml(cur.specializationLabel || cur.specialization) +
        ' <button class="btn btn--mini btn--with-icon btn--danger" data-cmd-release type="button">' +
        uiIcon('close', 'pink') + ' Rimuovi</button></div>'
    : '';
  const html =
    '<div class="attack-overlay" data-cmd-overlay>' +
      '<div class="attack-overlay__panel">' +
        '<header class="attack-overlay__head"><h3>' + starHtml + ' Comandante di ' + escapeHtml(fleet.name) + '</h3>' +
          '<button class="attack-overlay__x btn--icon-only" data-cmd-close type="button" aria-label="Chiudi">' +
            uiIcon('close') + '</button></header>' +
        curHtml +
        '<p class="attack-overlay__sub">Specializzazioni: <strong>Tattico</strong> +10% fuoco · <strong>Navigatore</strong> −15% durata viaggio · <strong>Logista</strong> (gancio M12).</p>' +
        '<div class="cmd-pick__list">' + rows + '</div>' +
      '</div>' +
    '</div>';
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  const node = wrap.firstChild;
  document.body.appendChild(node);
  function close() { if (node.parentNode) node.parentNode.removeChild(node); }
  node.querySelector('[data-cmd-close]').addEventListener('click', close);
  node.addEventListener('click', function (e) { if (e.target === node) close(); });
  const rel = node.querySelector('[data-cmd-release]');
  if (rel) rel.addEventListener('click', function () {
    ORION.commander.releaseFromFleet(g, fleet);
    pushChronicle(ORION.time.currentDS(g) + ' — Comandante sollevato dal comando di <strong>' + escapeHtml(fleet.name) + '</strong>.', 'figure');
    persistGame(g); close(); renderFleetView(stage);
  });
  node.querySelectorAll('[data-cmd]').forEach(function (b) {
    b.addEventListener('click', function () {
      const r = ORION.commander.assignToFleet(g, fleet, b.dataset.cmd);
      if (!r.ok) { showToast(r.reason || 'Assegnazione fallita'); return; }
      pushChronicle(ORION.time.currentDS(g) + ' — <strong>★ ' + escapeHtml(r.commander.rank + ' ' + r.commander.name) +
        '</strong> assume il comando di <strong>' + escapeHtml(fleet.name) + '</strong> (' +
        escapeHtml(ORION.commander.bonusLabel(r.commander)) + ').', 'figure');
      persistGame(g); close(); renderFleetView(stage);
    });
  });
}

function handleSiegeTribute(battleId, stage) {
  const g = ORION.game;
  const battle = (g.battles || []).filter(function (b) { return b.id === battleId; })[0];
  if (!battle) { renderFleetView(stage); return; }
  const colony = g.colonies[battle.colonyKey];
  if (!colony) return;
  const cost = siegeTributeCost(battle);
  if ((colony.stock.met || 0) < cost.met || (colony.stock.en || 0) < cost.en) {
    showToast('Risorse insufficienti per il tributo'); return;
  }
  colony.stock.met -= cost.met; colony.stock.en -= cost.en;
  battle.status = 'done';
  g.battles = (g.battles || []).filter(function (b) { return b !== battle; });
  let extra = '';
  if (battle.attackerKind === 'ai' && battle.attackerCiv) {
    /* Tregua breve con la civiltà: non riattacca per un po' (leva di
       recovery; la diplomazia piena è M11). */
    const civ = (g.civs || []).filter(function (c) { return c.id === battle.attackerCiv; })[0];
    if (civ) { civ.truceUntil = (g.timeImpulsi || 0) + 200; extra = ' Tregua di 200 ' + iU() + '.'; }
  }
  pushChronicle(ORION.time.currentDS(g) + ' — Tributo pagato: assedio revocato su ' +
    colonyNameFromKey(battle.colonyKey) + '.' + extra, 'system');
  persistGame(g);
  renderFleetView(stage);
}

/* Leva di recovery: evacua una colonia (recupera metà risorse alla capitale,
   sistema neutrale). Recovery-friendly: le flotte non si perdono. */
function handleEvacuate(colonyKey, stage) {
  const name = colonyNameFromKey(colonyKey).replace(/<[^>]+>/g, '');
  const msg = '<p>Evacuare <strong>' + escapeHtml(name) + '</strong>?</p>' +
    '<p>Recuperi <strong>metà delle risorse</strong> alla capitale; la colonia viene abbandonata.</p>' +
    '<p class="confirm-hint">Le flotte assegnate non si perdono — leva di recovery.</p>';
  confirmAction({
    title: 'Conferma evacuazione',
    message: msg,
    confirmLabel: 'Evacua',
    danger: true,
    force: true,    // sempre conferma anche se il toggle è OFF
    onConfirm: function () { _doEvacuate(colonyKey, stage); }
  });
}
function _doEvacuate(colonyKey, stage) {
  const g = ORION.game;
  const r = ORION.time.evacuateColony(g, colonyKey);
  if (!r.ok) { showToast(r.reason || 'Evacuazione fallita'); return; }
  const parts = ['met', 'en', 'food', 'water'].filter(function (k) { return (r.recovered || {})[k] > 0; })
    .map(function (k) { return resGlyph(k) + ' ' + r.recovered[k]; });
  pushChronicle(ORION.time.currentDS(g) + ' — Colonia evacuata: ' +
    (parts.length ? 'recuperati ' + parts.join(' · ') + ' alla capitale' : 'nessuna risorsa recuperata') + '.', 'system');
  /* L'evacuazione può portare a 0 colonie → controlla la sconfitta. */
  if (ORION.time.tick) { /* no-op: il controllo avviene al prossimo tick */ }
  persistGame(g);
  renderFleetView(stage);
  if (ORION.map && ORION.map.requestRender) ORION.map.requestRender();
}

/* Leva di recovery: richiama tutte le flotte alla colonia origine. */
function handleRecallFleets(stage) {
  const g = ORION.game;
  let n = 0;
  (g.fleets || []).forEach(function (f) {
    if (f.location && f.location.status === 'docked') return;   // già a casa
    const r = ORION.fleet.setOrder(g, f, { type: 'return' });
    if (r.ok) n++;
  });
  showToast(n ? (n + ' flotta/e in rientro alla base') : 'Nessuna flotta da richiamare');
  persistGame(g);
  renderFleetView(stage);
}

/* M09 Fase B: schermata di fine partita (solo modalità gameOver). */
function showDefeatModal() {
  const g = ORION.game;
  const html =
    '<div class="battle-modal" data-defeat-modal>' +
      '<div class="battle-modal__panel">' +
        '<header class="battle-modal__head"><h3>' +
          uiIcon('warning', 'pink') + ' La civiltà è caduta' +
        '</h3></header>' +
        '<p class="battle-modal__verdict battle-modal__verdict--lose">' +
          uiIcon('sword', 'pink') + ' Sconfitta' +
        '</p>' +
        '<p>Senza più colonie, il tuo impero si dissolve negli annali galattici. ' +
        'La galassia continua a vivere senza di te.</p>' +
        '<div class="battle-modal__sides"><button class="btn btn--primary" data-defeat-menu type="button">Torna al menu</button></div>' +
      '</div>' +
    '</div>';
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  const node = wrap.firstChild;
  document.body.appendChild(node);
  const btn = node.querySelector('[data-defeat-menu]');
  if (btn) btn.addEventListener('click', function () {
    if (node.parentNode) node.parentNode.removeChild(node);
    if (typeof stopTimerIfRunning === 'function') stopTimerIfRunning();
    if (typeof showMainMenu === 'function') showMainMenu('home');
  });
}

function handleSiegeRetreat(battleId, stage) {
  const g = ORION.game;
  const battle = (g.battles || []).filter(function (b) { return b.id === battleId; })[0];
  if (!battle) { renderFleetView(stage); return; }
  let n = 0;
  (g.fleets || []).forEach(function (f) {
    if (f.location && f.location.systemId === battle.systemId && f.location.status !== 'in-transit') {
      const r = ORION.fleet.setOrder(g, f, { type: 'return' });
      if (r.ok) n++;
    }
  });
  showToast(n ? (n + ' flotta/e in ritirata') : 'Nessuna flotta da ritirare');
  persistGame(g);
  renderFleetView(stage);
}

/* Modale: ultimo report di battaglia (§12.5). */
function openBattleReport() {
  const rep = ORION.lastBattle;
  if (!rep) return;
  const g = ORION.game;
  const sys = (rep.systemId != null && g.galaxy.systems[rep.systemId]) ? g.galaxy.systems[rep.systemId].name : '—';
  let rows = (rep.log || []).map(function (r) {
    return '<tr><td>' + r.round + '</td><td>' + r.fpA + '</td><td>' + r.fpB + '</td>' +
      '<td>' + r.hpA + '</td><td>' + r.hpB + '</td><td>' + r.lostA + '/' + r.lostB + '</td></tr>';
  }).join('');
  const winLabel = rep.winner === 'A' ? 'Vittoria' : rep.winner === 'B' ? 'Sconfitta' : 'Stallo';
  const html =
    '<div class="battle-modal" data-battle-modal>' +
      '<div class="battle-modal__panel">' +
        '<header class="battle-modal__head"><h3>' +
          '<span class="ui-icon ui-icon--pink" aria-hidden="true">' + ((ORION.icon && ORION.icon('sword')) || '') + '</span> ' +
          'Report di battaglia — ' + escapeHtml(sys) +
        '</h3>' +
          '<button class="btn btn--mini btn--icon-only" data-close-battle type="button" aria-label="Chiudi">' +
            '<span class="ui-icon" aria-hidden="true">' + ((ORION.icon && ORION.icon('close')) || '✕') + '</span>' +
          '</button></header>' +
        '<p class="battle-modal__verdict battle-modal__verdict--' + (rep.winner === 'A' ? 'win' : 'lose') + '">' +
          '<span class="ui-icon ' + (rep.winner === 'A' ? 'ui-icon--gold' : 'ui-icon--pink') + '" aria-hidden="true">' +
            ((ORION.icon && ORION.icon(rep.winner === 'A' ? 'trophy' : 'sword')) || '') +
          '</span> ' + winLabel + ' in ' + rep.rounds + ' round</p>' +
        '<div class="battle-modal__sides">' +
          '<span><strong>' + escapeHtml(rep.sideA.name) + '</strong>: ' + rep.sideA.before.ships + '→' + rep.sideA.after.ships + ' navi</span>' +
          '<span><strong>' + escapeHtml(rep.sideB.name) + '</strong>: ' + rep.sideB.before.ships + '→' + rep.sideB.after.ships + ' unità</span>' +
        '</div>' +
        '<table class="battle-modal__log"><thead><tr><th>R</th><th>fp▲</th><th>fp▼</th><th>hp▲</th><th>hp▼</th><th>perse</th></tr></thead>' +
          '<tbody>' + rows + '</tbody></table>' +
      '</div>' +
    '</div>';
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  const node = wrap.firstChild;
  document.body.appendChild(node);
  function close() { if (node.parentNode) node.parentNode.removeChild(node); }
  node.addEventListener('click', function (e) { if (e.target === node) close(); });
  node.querySelector('[data-close-battle]').addEventListener('click', close);
}

/* =====================================================================
   M10 Fase B (decisione #47) — Vista "Civiltà" + dossier
   Read-only: mostra le civiltà AI CONTATTATE con il loro dossier
   (allineamento, archetipo, tratto, sede, sistemi noti, disposizione) +
   anteprima ICG §5.4 / Reputazione §14. La diplomazia interattiva (M11)
   e lo scontro (M09) restano fuori scope.
   ===================================================================== */
function renderCivView(stage) {
  if (!stage) return;
  const g = ORION.game;
  if (!g) return;
  if (!ORION.ai) { renderViewPlaceholder(stage, 'civ'); return; }
  /* Tutorial: concetti sulle civiltà alla prima apertura della vista. */
  if (ORION.tutorial) ORION.tutorial.fire('civilizations');

  const ALIGN_LABEL = { bene: 'Bene', male: 'Male', neutrale: 'Neutrale' };
  const KNOWLEDGE = ORION.ai.KNOWLEDGE || { unknown:0, spotted:1, contacted:2, known:3, familiar:4 };
  /* M10 Fase B punto 2 (decisione #52 §13.10): scoperta progressiva a 5 gradi.
     `visibleCivs` ritorna tutte le civiltà ≥ avvistate (esclude le sconosciute).
     Le **4 Costanti** sono sempre visibili nella loro sezione fissa anche se
     'unknown' — il nome+ruolo sono sempre noti. */
  const visible = (ORION.ai.visibleCivs ? ORION.ai.visibleCivs(g) : ORION.ai.contactedCivs(g));
  const icg = (typeof g.icg === 'number') ? Math.round(g.icg) : '—';
  const DIP = ORION.diplomacy;
  const rep = DIP ? DIP.reputation(g) : (ORION.ai.reputationPreview ? ORION.ai.reputationPreview(g) : '—');

  /* --- Card adattiva al grado di scoperta ---
     unknown/spotted: solo nome + sigla regione + chip "grado"
     contacted: + allineamento + sede + relazione + barra disposizione
     known: + vocazione + tratto + dossier completo + intel forza
     familiar: + last battle + reason + chip oro */
  function renderCivCard(c, fixedShown) {
    const rank = ORION.ai.knowledgeRank ? ORION.ai.knowledgeRank(c) : (c.contacted ? 2 : 0);
    const kLabel = ORION.ai.knowledgeLabel ? ORION.ai.knowledgeLabel(c) : null;
    const seat = (g.galaxy.groups.find(function (gp) { return gp.id === c.homeGroupId; }) || {});
    const factionDef = (c.faction && ORION.factions && ORION.factions.byId) ? ORION.factions.byId(c.faction) : null;

    /* Header sempre presente: nome, swatch colore, eventuale chip grado.
       4 Costanti: ruolo SEMPRE noto anche in unknown. */
    let head = '<div class="civ-card__head">' +
      '<span class="civ-card__swatch" aria-hidden="true"></span>' +
      '<span class="civ-card__name">' + escapeHtml(c.name) + '</span>';
    if (kLabel) head += '<span class="civ-grade civ-grade--' + (c.knowledge || 'unknown') + '">' + escapeHtml(kLabel) + '</span>';
    /* Ruolo (solo 4 Costanti): visibile sempre. */
    if (factionDef) head += '<span class="civ-faction-role">' + escapeHtml(factionDef.role) + '</span>';
    head += '</div>';

    let body = '';
    /* SPOTTED — minimo: nome + sigla regione. */
    if (rank >= KNOWLEDGE.spotted && rank < KNOWLEDGE.contacted) {
      body = '<div class="civ-card__row"><span class="civ-card__k">Regione</span><span>' +
        escapeHtml(seat.name || '—') + '</span></div>' +
        '<p class="panel__note civ-card__hint">Hai avvistato un loro sistema. Avvicinati con la diplomazia o uno scontro per ottenere un <strong>dossier completo</strong>.</p>';
    }
    /* UNKNOWN (solo 4 Costanti): mostra ruolo + hint contatto. */
    if (rank < KNOWLEDGE.spotted && factionDef) {
      body = '<p class="panel__note civ-card__hint">Fazione fissa della galassia · ruolo sempre noto. Per il dossier servono interazioni dirette.</p>';
    }
    /* CONTACTED+ — dossier base. */
    if (rank >= KNOWLEDGE.contacted) {
      const disp = Math.round(c.disposition || 0);
      const dispLabel = ORION.ai.dispositionLabel(disp);
      const pct = Math.max(0, Math.min(100, (disp + 100) / 2));
      const dispCls = disp <= -15 ? 'neg' : (disp >= 15 ? 'pos' : 'mid');
      let relChip = '', dipActions = '';
      if (DIP) {
        const drel = DIP.effectiveRelation(g, c);
        relChip = '<span class="dip-relchip ' + DIP.relationStateClass(drel) + '" title="Stato diplomatico">' +
          escapeHtml(DIP.relationLabel(drel)) + '</span>';
        const acts = DIP.availableActions(g, c);
        const onCd = DIP.onCooldown(g, c);
        dipActions = '<div class="dip-actions">' + acts.map(function (a) {
          const ev = DIP.evaluate(g, c, a);
          const danger = (a === 'declare-war' || a === 'break-alliance');
          const hint = ev.unilateral ? 'Effetto immediato'
            : (onCd ? 'Dispaccio inviato di recente — attendi'
                    : 'Esito ' + ev.likelihood + ' · ' + ev.reason);
          return '<button type="button" class="dip-btn' + (danger ? ' dip-btn--danger' : '') + '"' +
            ' data-dip-civ="' + escapeHtml(c.id) + '" data-dip-act="' + a + '"' +
            (onCd && !ev.unilateral ? ' disabled' : '') +
            ' title="' + escapeHtml(hint) + '">' + escapeHtml(DIP.actionLabel(a)) +
            (ev.unilateral ? '' : ' <span class="dip-btn__odds">' + ev.likelihood + '</span>') +
            '</button>';
        }).join('') + '</div>';
      }
      let fedChip = '';
      if (ORION.federations && ORION.federations.federationOf) {
        const fed = ORION.federations.federationOf(g, c.id);
        if (fed) {
          fedChip = '<span class="civ-fedchip" title="Membro di una federazione emergente" style="--fed-color:' +
            escapeHtml(fed.color) + '">⬢ ' + escapeHtml(fed.name) + '</span>';
        }
      }
      const alignChip = '<span class="civ-chip civ-chip--' + c.alignment + '">' + (ALIGN_LABEL[c.alignment] || c.alignment) + '</span>';
      /* M11 Fase B parziale: dispaccio AI pendente — banner con accetta/rifiuta. */
      let offerHtml = '';
      if (c.pendingOffer && DIP) {
        const off = c.pendingOffer;
        const lab = DIP.offerLabel(off.actionId);
        const ttl = Math.max(0, (off.expiresAt || 0) - (g.timeImpulsi || 0));
        offerHtml = '<div class="dip-offer">' +
          '<span class="dip-offer__icon" aria-hidden="true">✉</span>' +
          '<span class="dip-offer__text"><strong>Dispaccio:</strong> offrono <strong>' + escapeHtml(lab) +
            '</strong> · scade tra ' + ttl + ' Ι</span>' +
          '<button type="button" class="dip-btn dip-btn--primary" data-dip-offer="' + escapeHtml(c.id) + '" data-dip-resp="accept">Accetta</button>' +
          '<button type="button" class="dip-btn dip-btn--danger" data-dip-offer="' + escapeHtml(c.id) + '" data-dip-resp="reject">Rifiuta</button>' +
        '</div>';
      }
      body = '<div class="civ-card__chips">' + alignChip + relChip + fedChip + '</div>' +
        offerHtml +
        '<div class="civ-card__row"><span class="civ-card__k">Sede</span><span>' +
          escapeHtml(seat.tierLabel || '—') + (seat.name ? ' · ' + escapeHtml(seat.name) : '') + '</span></div>' +
        '<div class="civ-disp">' +
          '<div class="civ-disp__top"><span class="civ-card__k">Disposizione verso di te</span>' +
            '<span class="civ-disp__label civ-disp__label--' + dispCls + '">' + dispLabel + '</span></div>' +
          '<div class="civ-disp__bar"><span class="civ-disp__mid" aria-hidden="true"></span>' +
            '<span class="civ-disp__fill civ-disp__fill--' + dispCls + '" style="width:' + pct.toFixed(0) + '%"></span></div>' +
        '</div>' +
        dipActions +
        civTradeHtml(g, c);
    }
    /* KNOWN+ — vocazione + tratto + intel forza. */
    if (rank >= KNOWLEDGE.known) {
      const vocLabel = (ORION.ai.VOCATIONS && c.vocation && ORION.ai.VOCATIONS[c.vocation]) ? ORION.ai.VOCATIONS[c.vocation].label : '—';
      const affLabel = (ORION.ai.AFFINITIES && c.affinity && ORION.ai.AFFINITIES[c.affinity]) ? ORION.ai.AFFINITIES[c.affinity].label : '—';
      const known = ORION.ai.knownSystemsCount(g, c);
      const ptier = ORION.ai.powerTier(c.power || 0);
      const force = ORION.ai.forceEstimate ? ORION.ai.forceEstimate(g, c) : 0;
      const extras =
        '<div class="civ-card__row"><span class="civ-card__k">Vocazione</span><span class="civ-voc">' + escapeHtml(vocLabel) + '</span>' +
          '<span class="civ-card__k">Affinità</span><span>' + escapeHtml(affLabel) + '</span></div>' +
        '<div class="civ-card__row"><span class="civ-card__k">Tratto</span><span>' + escapeHtml(c.traitLabel || '—') + '</span></div>' +
        '<div class="civ-card__row"><span class="civ-card__k">Potenza</span><span class="civ-power civ-power--' + ptier + '">' + ptier + '</span>' +
          '<span class="civ-card__k">Forza stimata</span><span>≈ ' + force + ' unità</span>' +
          '<span class="civ-card__k">Sistemi noti</span><span>' + known + '</span></div>';
      /* Inserisci extras DOPO i chip + sede e PRIMA della barra disposizione. */
      body = body.replace('<div class="civ-disp">', extras + '<div class="civ-disp">');
    }
    /* FAMILIAR — last battle + reason + chip oro. */
    if (rank >= KNOWLEDGE.familiar) {
      let lastB = '';
      if (c.lastBattle) {
        const lb = c.lastBattle;
        const sys = (lb.sysId != null && lb.sysId >= 0 && g.galaxy.systems[lb.sysId]) ? g.galaxy.systems[lb.sysId].name : null;
        const verdict = lb.result === 'win' ? 'vittoria tua' : 'sconfitta tua';
        const where = sys ? ' a <strong>' + escapeHtml(sys) + '</strong>' : '';
        const when = ORION.time ? ORION.time.format(lb.impulso) : '';
        lastB = '<div class="civ-card__row civ-lastbattle civ-lastbattle--' + (lb.result === 'win' ? 'win' : 'loss') + '">' +
          '<span class="civ-card__k">Ultimo scontro</span><span>' + verdict + where +
          (when ? ' · <span class="civ-card__when">' + escapeHtml(when) + '</span>' : '') + '</span></div>';
      }
      const reason = ORION.ai.dispositionReason ? ORION.ai.dispositionReason(g, c) : '';
      const reasonHtml = reason ? '<div class="civ-disp__reason">' + escapeHtml(reason) + '</div>' : '';
      /* Append reason within disposition + lastBattle before dip-actions. */
      body = body.replace('</div><div class="dip-actions">', reasonHtml + '</div>' + lastB + '<div class="dip-actions">');
      if (body.indexOf('dip-actions') < 0) {
        body += lastB; // fallback
      }
    }

    return '<li class="civ-card civ-card--' + (c.knowledge || 'unknown') + '" style="--civ-color:' + escapeHtml(c.color) + '">' +
      head + body + '</li>';
  }

  /* Separa 4 Costanti dalle altre. Le 4 Costanti sono sempre visibili nella
     loro sezione fissa anche se 'unknown'. */
  const allCivs = (g.civs || []).filter(function (c) { return c.alive; });
  const costantiCivs = allCivs.filter(function (c) { return !!c.faction; });
  const otherVisible = visible.filter(function (c) { return !c.faction; });

  /* Ordina per grado decrescente (familiar → known → contacted → spotted). */
  function rankOf(c) { return ORION.ai.knowledgeRank ? ORION.ai.knowledgeRank(c) : (c.contacted ? 2 : 0); }
  otherVisible.sort(function (a, b) { return rankOf(b) - rankOf(a); });

  /* Sezione fissa "Le Quattro Costanti". */
  let constHtml = '<div class="civ-constants">' +
    '<h3 class="civ-constants__title">⬡ Le Quattro Costanti</h3>' +
    '<p class="panel__note">Fazioni fisse della galassia · nome e ruolo <strong>sempre noti</strong> · dossier completo per gradi (avvicinati con diplomazia o scontro).</p>' +
    '<ul class="civ-list">' + costantiCivs.map(function (c) { return renderCivCard(c, true); }).join('') + '</ul>' +
  '</div>';

  /* Card per le altre civiltà (visibili = ≥ spotted). */
  let cards;
  if (!otherVisible.length) {
    cards = '<p class="panel__note">Nessuna civiltà ancora <strong>avvistata</strong> oltre le 4 Costanti. <strong>Esplora la galassia</strong> ' +
      '(spedizioni M07 / flotte M08): vedere un loro sistema scatta l\'<strong>avvistamento</strong>; ' +
      'un atto formale (diplomazia, scontro) le promuove a <strong>contattate</strong>.</p>';
  } else {
    cards = '<ul class="civ-list">' + otherVisible.map(function (c) { return renderCivCard(c, false); }).join('') + '</ul>';
  }

  /* Stato di guerra d'impero (§ M09): morale + pressione, contesto globale. */
  const ws = g.warState || { morale: 1, pressure: 0 };
  const moralePct = Math.round((ws.morale != null ? ws.morale : 1) * 100);
  const pressure = Math.round(ws.pressure || 0);
  const deeds = g.alignmentDeeds || { light: 0, dark: 0 };

  /* M10 Fase B (decisione #52 §13.8): federazioni emergenti attive. Lista
     compatta con membri e Ι di vita. */
  let fedsHtml = '';
  const feds = (g.federations && Array.isArray(g.federations.list)) ? g.federations.list : [];
  if (feds.length) {
    fedsHtml = '<div class="civ-feds">' +
      '<h3 class="civ-feds__title">⬢ Federazioni emergenti</h3>' +
      '<ul class="civ-feds__list">' + feds.map(function (f) {
        const names = (f.memberIds || []).map(function (id) {
          const c = (g.civs || []).filter(function (cc) { return cc.id === id; })[0];
          return c ? c.name : id;
        }).join(' + ');
        const age = Math.max(0, (g.timeImpulsi || 0) - (f.formedAt || 0));
        return '<li class="civ-fed" style="--fed-color:' + escapeHtml(f.color) + '">' +
          '<span class="civ-fed__swatch" aria-hidden="true"></span>' +
          '<span class="civ-fed__name"><strong>' + escapeHtml(f.name) + '</strong></span>' +
          '<span class="civ-fed__members">' + escapeHtml(names) + '</span>' +
          '<span class="civ-fed__age">attiva da ' + age + ' Ι</span></li>';
      }).join('') + '</ul></div>';
  }

  /* M10 Fase B (decisione #52 §13.6): sistemi coesi noti (DETECTED+).
     Contesto per la diplomazia: muovere/colonizzare/attaccare qui costa. */
  let cohHtml = '';
  const cohList = (g.cohesion && Array.isArray(g.cohesion.sysIds)) ? g.cohesion.sysIds : [];
  if (cohList.length && ORION.cohesion) {
    const DET = (ORION.galaxy && ORION.galaxy.DISCOVERY) ? ORION.galaxy.DISCOVERY.DETECTED : 1;
    const visible = cohList.filter(function (sid) { return (g.state.discovery[sid] || 0) >= DET; });
    if (visible.length) {
      cohHtml = '<div class="civ-cohesion">' +
        '<h3 class="civ-cohesion__title">⌬ Sistemi coesi noti</h3>' +
        '<ul class="civ-cohesion__list">' + visible.map(function (sid) {
          const info = ORION.cohesion.cohesionInfo(g, sid);
          const sys = g.galaxy.systems[sid] || {};
          const tag = systemTagHtml(sid);
          const owners = info.owners.map(function (o) {
            return '<span class="civ-coh-owner" style="--coh-c:' + escapeHtml(o.color) + '">' +
              escapeHtml(o.name) + '</span>';
          }).join(' + ');
          return '<li class="civ-cohesion__item"><span class="civ-coh-sys"><strong>' + escapeHtml(sys.name || '—') + '</strong>' + tag + '</span>' +
            '<span class="civ-coh-owners">' + owners + '</span>' +
            '<span class="civ-coh-stats">' + info.totalColonies + ' colonie · ' + info.bodies + ' corpi</span></li>';
        }).join('') + '</ul>' +
        '<p class="panel__note">Passare, attaccare o colonizzare in un sistema coeso costa <strong>disposizione</strong> ' +
          'a tutti i proprietari (consorzio §13.6). Rompi il consorzio mettendo in guerra due membri o alleandoti con tutti.</p>' +
      '</div>';
    }
  }

  /* M10 Fase E: covi pirata NOTI — bersagli raidabili (manda una flotta
     armata sul sistema per sgominarli e incassare la taglia). */
  let nestsHtml = '';
  const nests = ORION.ai.knownNests ? ORION.ai.knownNests(g) : [];
  if (nests.length) {
    nestsHtml = '<div class="civ-nests">' +
      '<h3 class="civ-nests__title">☠ Minacce pirata note</h3>' +
      '<ul class="civ-nests__list">' + nests.map(function (n) {
        const tag = (n.sysId != null && n.sysId >= 0) ? systemTagHtml(n.sysId) : '';
        return '<li class="civ-nest"><span class="civ-nest__sys"><strong>' + escapeHtml(n.name) + '</strong>' + tag + '</span>' +
          '<span class="civ-nest__lvl">covo liv. ' + n.level + '</span>' +
          '<span class="civ-nest__taglia">taglia ≈ ' + resIcon('met') + (25 * n.level + 40) + ' ' + resIcon('en') + (12 * n.level + 20) + '</span></li>';
      }).join('') + '</ul>' +
      '<p class="panel__note civ-nests__hint">Manda una <strong>flotta armata</strong> su questi sistemi per sgominare i covi: ' +
        'sconfiggerli frutta una <strong>taglia</strong> e riduce le razzie. I predoni, però, possono colpire le tue ' +
        'flotte lasciate <em>esposte</em> in orbita lontano dalle colonie.</p>' +
      '</div>';
  }

  /* M11 Fase B parziale: sistemi OCCUPATI dal giocatore (post-skirmish vinto
     su civiltà AI). Lista con bottone "Abbandona" come leva di recupero. */
  let occHtml = '';
  const occMap = g.occupations || {};
  const occIds = Object.keys(occMap);
  if (occIds.length) {
    occHtml = '<div class="civ-occupations">' +
      '<h3 class="civ-occupations__title">▣ Sistemi occupati <span class="civ-occ__count">' + occIds.length + '</span></h3>' +
      '<ul class="civ-occupations__list">' + occIds.map(function (sid) {
        const occ = occMap[sid];
        const sys = g.galaxy.systems[sid] || {};
        const tag = systemTagHtml(Number(sid));
        const since = Math.max(0, (g.timeImpulsi || 0) - (occ.sinceI || 0));
        const alignCls = occ.fromAlignment || 'neutrale';
        return '<li class="civ-occupation" style="--occ-color:' + escapeHtml(occ.fromCivColor || '#888') + '">' +
          '<span class="civ-occ__sys"><strong>' + escapeHtml(sys.name || ('Sistema ' + sid)) + '</strong>' + tag + '</span>' +
          '<span class="civ-occ__from">strappato a <span class="civ-chip civ-chip--' + alignCls + '">' + escapeHtml(occ.fromCivName || '—') + '</span></span>' +
          '<span class="civ-occ__since">da ' + since + ' Ι</span>' +
          '<button type="button" class="btn btn--mini btn--danger" data-action="occ-release" data-sys="' + escapeHtml(sid) + '">Abbandona</button>' +
        '</li>';
      }).join('') + '</ul>' +
      '<p class="panel__note">L\'occupazione di un sistema AI conta per la pista <strong>Egemone</strong>. ' +
        'Abbandonare un\'occupazione su una civiltà non maligna restituisce un po\' di <strong>reputazione</strong>.</p>' +
    '</div>';
  }

  stage.innerHTML =
    '<div class="civ-view">' +
      '<header class="fleet-view__head">' +
        '<h2 class="fleet-view__title">Civiltà della galassia <span class="fleet-view__sub">M10 · M11 Diplomazia</span></h2>' +
        '<div class="civ-indices">' +
          '<span class="civ-index" title="Indice Corruzione Galattica (§5.4)">ICG <strong>' + icg + '</strong></span>' +
          '<span class="civ-index" title="Reputazione globale (§14)">Reputazione <strong>' + rep + '</strong></span>' +
          '<span class="civ-index" title="Morale d\'impero (M09): cala con le sconfitte, riduce la produzione">Morale <strong>' + moralePct + '%</strong></span>' +
          '<span class="civ-index" title="Pressione nemica (M09): sale con le sconfitte, attira più attacchi">Pressione <strong>' + pressure + '</strong></span>' +
        '</div>' +
      '</header>' +
      '<p class="panel__note">Le civiltà vivono in <strong>background</strong> (espandono, si fanno guerra, cadono e ' +
        'nascono). Dossier <strong>combat-aware</strong> con <strong>stato diplomatico</strong>: puoi <strong>dichiarare guerra</strong>, ' +
        '<strong>proporre pace</strong> o <strong>alleanza</strong> (non-aggressione) — l\'esito dipende da disposizione, ' +
        '<strong>reputazione</strong> e allineamento. Le tue azioni morali finora — <span class="civ-deeds civ-deeds--light">' + (deeds.light || 0) + ' luce</span> · ' +
        '<span class="civ-deeds civ-deeds--dark">' + (deeds.dark || 0) + ' ombra</span>. ' +
        'Gli scontri si risolvono col <strong>Combattimento</strong> (M09).</p>' +
      constHtml +
      fedsHtml +
      cohHtml +
      occHtml +
      nestsHtml +
      cards +
    '</div>';

  /* M11 (#51): handler delle proposte diplomatiche (delega sul contenitore). */
  if (DIP) {
    if (ORION.tutorial) ORION.tutorial.fire('diplomacy');
    stage.querySelectorAll('[data-dip-act]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const civ = (g.civs || []).filter(function (c) { return c.id === btn.dataset.dipCiv; })[0];
        if (!civ) return;
        runDiplomacyAction(civ, btn.dataset.dipAct);
      });
    });
    /* M11 Fase B parziale: risposta a un'offerta AI (accetta/rifiuta). */
    stage.querySelectorAll('[data-dip-offer]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const civ = (g.civs || []).filter(function (c) { return c.id === btn.dataset.dipOffer; })[0];
        if (!civ) return;
        respondToAiOffer(civ, btn.dataset.dipResp === 'accept');
      });
    });
  }
  /* M11 Fase B parziale: rilascio occupazione sistema. */
  stage.querySelectorAll('[data-action="occ-release"]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const sid = Number(btn.dataset.sys);
      if (!Number.isFinite(sid)) return;
      const sys = g.galaxy.systems[sid];
      const sysName = sys ? sys.name : ('sistema ' + sid);
      confirmAction({
        title: 'Rilascia occupazione',
        message: '<p>Abbandonare l\'occupazione di <strong>' + escapeHtml(sysName) + '</strong>?</p>' +
          '<p class="confirm-hint">Se hai conquistato il sistema da una civiltà buona o neutrale, ' +
          'il rilascio è un atto di clemenza (+3 reputazione).</p>',
        confirmLabel: 'Rilascia',
        danger: true,
        force: true,
        onConfirm: function () {
          const r = ORION.time.releaseOccupation(g, sid);
          if (!r.ok) { showToast(r.reason || 'Rilascio rifiutato'); return; }
          chronicleEvent({ kind: 'system-released', sysId: sid, impulso: g.timeImpulsi });
          persistGame(g);
          updateGlobalIndicesHud();
          renderCivView(stage);
        }
      });
    });
  });
  /* M12 Fase A2 (#56 §15.3): handler accordi commerciali. */
  stage.querySelectorAll('[data-action="agr-propose"]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const civ = (g.civs || []).filter(function (c) { return c.id === btn.dataset.civ; })[0];
      if (civ) openAgreementPicker(civ, stage);
    });
  });
  stage.querySelectorAll('[data-action="agr-cancel"]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const r = ORION.agreements.cancel(g, btn.dataset.agr);
      if (!r.ok) { showToast(r.reason || 'Annullamento rifiutato'); return; }
      showToast('Accordo chiuso');
      persistGame(g);
      renderCivView(stage);
    });
  });
}

/* M12 Fase A2 (#56 §15.3): blocco "Commercio" nella card civiltà. */
function civTradeHtml(g, civ) {
  const AG = ORION.agreements;
  if (!AG) return '';
  const rel = ORION.diplomacy ? ORION.diplomacy.effectiveRelation(g, civ) : (civ.relation || 'peace');
  const list = AG.agreementsFor(g, civ.id);
  let inner = '';
  if (list.length) {
    inner += '<ul class="agr-list">' + list.map(function (a) {
      const stCls = a.status === 'active' ? 'ok' : (a.status === 'suspended' ? 'crit' : 'warn');
      const stLbl = a.status === 'active' ? 'attivo' : (a.status === 'suspended' ? 'sospeso' : 'interrotto');
      return '<li class="agr-item">' +
        '<span class="agr-item__deal">' + resIcon(a.giveRes) + ' ' + a.flow + ' → ' + resIcon(a.getRes) + ' ' + (Math.round(a.flow * a.ratio * 10) / 10) + ' /' + iU() + '</span>' +
        '<span class="agr-item__dur">' + (a.duration | 0) + ' ' + iU() + '</span>' +
        '<span class="route-item__status is-' + stCls + '">' + stLbl + '</span>' +
        '<button class="btn btn--mini btn--danger" data-action="agr-cancel" data-agr="' + a.id + '" type="button" title="Chiudi accordo">×</button>' +
      '</li>';
    }).join('') + '</ul>';
  }
  const canTrade = (rel === 'peace' || rel === 'alliance');
  const full = list.length >= AG.MAX_PER_CIV;
  if (canTrade && !full) {
    inner += '<button class="btn btn--mini" data-action="agr-propose" data-civ="' + escapeHtml(civ.id) + '" type="button">+ Proponi accordo</button>';
  } else if (!canTrade) {
    inner += '<p class="panel__note agr-note">Il commercio richiede <strong>pace o alleanza</strong>.</p>';
  }
  return '<div class="civ-trade"><span class="civ-card__k">Commercio</span>' + inner + '</div>';
}

/* Overlay proposta accordo commerciale (M12 Fase A2, §15.3). */
function openAgreementPicker(civ, civStage) {
  const g = ORION.game;
  const AG = ORION.agreements;
  if (!AG) return;
  const mine = myColonyKeys().filter(function (k) { const c = g.colonies[k]; return c && c.colonized; });
  if (!mine.length) { showToast('Nessuna colonia operativa'); return; }
  let colonyKey = mine[0];
  let giveRes = 'met', getRes = 'food';
  let flow = 10;

  let host = document.querySelector('[data-bind="agr-picker"]');
  if (!host) {
    host = document.createElement('div');
    host.className = 'expedition-pick-overlay';
    host.setAttribute('data-bind', 'agr-picker');
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-modal', 'true');
    host.setAttribute('aria-label', 'Proponi accordo commerciale');
    document.body.appendChild(host);
  }

  function render() {
    const colOpts = mine.map(function (k) {
      return '<option value="' + k + '"' + (k === colonyKey ? ' selected' : '') + '>' + colonyNameFromKey(k) + '</option>';
    }).join('');
    function resOpts(sel) {
      return AG.TRADE_RES.map(function (r) {
        return '<option value="' + r + '"' + (r === sel ? ' selected' : '') + '>' + tradeResLabel(r) + '</option>';
      }).join('');
    }
    host.innerHTML =
      '<div class="expedition-pick-overlay__panel" role="document">' +
        '<header class="expedition-pick-overlay__head">' +
          '<h2 class="expedition-pick-overlay__title">Accordo commerciale · ' + escapeHtml(civ.name) + '</h2>' +
          '<button class="btn btn--mini btn--icon-only" data-action="agr-close" type="button" aria-label="Chiudi">' +
            '<span class="ui-icon" aria-hidden="true">' + ((ORION.icon && ORION.icon('close')) || '✕') + '</span>' +
          '</button>' +
        '</header>' +
        '<div class="route-picker__controls">' +
          '<label class="route-picker__field">Colonia <select data-bind="agr-col">' + colOpts + '</select></label>' +
          '<label class="route-picker__field">Dai <select data-bind="agr-give">' + resOpts(giveRes) + '</select></label>' +
          '<label class="route-picker__field">Ricevi <select data-bind="agr-get">' + resOpts(getRes) + '</select></label>' +
          '<label class="route-picker__field">Flusso/' + iU() + ' <input type="number" min="' + AG.FLOW_MIN + '" max="' + AG.FLOW_MAX + '" step="1" data-bind="agr-flow" value="' + flow + '"></label>' +
        '</div>' +
        '<p class="panel__note" data-bind="agr-preview"></p>' +
        '<div class="expedition-card__actions">' +
          '<button class="btn btn--mini btn--primary" data-action="agr-do" type="button">Proponi</button>' +
        '</div>' +
        '<p class="panel__note">I termini sono <strong>bloccati</strong> alla stipula e dipendono dalla tua reputazione §14 (soglie discrete) e dall\'allineamento del partner. Durata ' + AG.DURATION_DEFAULT + ' ' + iU() + '. In guerra l\'accordo si sospende; riprende a pace.</p>' +
      '</div>';

    /* Aggiorna solo preview + bottone (no full re-render sul tasto del flusso). */
    function refreshPreview() {
      const line = host.querySelector('[data-bind="agr-preview"]');
      const doBtn2 = host.querySelector('[data-action="agr-do"]');
      const chk = AG.canPropose(g, civ.id, colonyKey, giveRes, getRes, flow);
      if (giveRes === getRes) {
        line.innerHTML = 'Scegli due risorse diverse.';
        doBtn2.disabled = true;
        return;
      }
      const ratio = AG.termsRatio(g, civ, giveRes, getRes);
      const getQty = Math.round(flow * ratio * 10) / 10;
      const verdict = chk.ok ? ('esito <strong>' + chk.likelihood + '</strong>') : ('<strong>' + escapeHtml(chk.reason) + '</strong>');
      line.innerHTML = 'Dai <strong>' + flow + '</strong> ' + tradeResLabel(giveRes) + '/' + iU() +
        ' → ricevi <strong>' + getQty + '</strong> ' + tradeResLabel(getRes) + '/' + iU() + ' · ' + verdict;
      doBtn2.disabled = !chk.ok;
    }
    refreshPreview();

    host.querySelector('[data-bind="agr-col"]').addEventListener('change', function () { colonyKey = this.value; refreshPreview(); });
    host.querySelector('[data-bind="agr-give"]').addEventListener('change', function () { giveRes = this.value; refreshPreview(); });
    host.querySelector('[data-bind="agr-get"]').addEventListener('change', function () { getRes = this.value; refreshPreview(); });
    host.querySelector('[data-bind="agr-flow"]').addEventListener('input', function () { flow = Math.max(AG.FLOW_MIN, Math.min(AG.FLOW_MAX, parseInt(this.value, 10) || AG.FLOW_MIN)); refreshPreview(); });
    host.querySelector('[data-action="agr-close"]').addEventListener('click', closeAgreementPicker);
    const doBtn = host.querySelector('[data-action="agr-do"]');
    doBtn.addEventListener('click', function () {
      if (doBtn.disabled) return;
      const r = AG.propose(g, civ.id, colonyKey, giveRes, getRes, flow);
      if (!r.ok) { showToast(r.reason || 'Proposta rifiutata'); return; }
      pushChronicle(ORION.time.currentDS(g) + ' — Accordo commerciale con <strong>' + escapeHtml(civ.name) + '</strong>: ' +
        flow + ' ' + tradeResLabel(giveRes) + '/' + iU() + ' ↔ ' + (Math.round(flow * r.agreement.ratio * 10) / 10) + ' ' + tradeResLabel(getRes) + '/' + iU() + '.', 'explore');
      if (ORION.tutorial) ORION.tutorial.fire('trade-ai');
      showToast('Accordo stipulato');
      persistGame(g);
      closeAgreementPicker();
      if (civStage) renderCivView(civStage);
    });
  }
  host.addEventListener('click', function (e) { if (e.target === host) closeAgreementPicker(); });
  render();
  host.hidden = false;
}
function closeAgreementPicker() {
  const host = document.querySelector('[data-bind="agr-picker"]');
  if (host) { host.hidden = true; host.innerHTML = ''; }
}

/* M11 (#51): esegue un'azione diplomatica, registra in cronaca, persiste e
   ri-renderizza la vista Civiltà. Le azioni unilaterali (guerra/rottura)
   chiedono conferma per via degli effetti su reputazione. */
/* M10 Fase B helper: estrae i sistemi rilevanti per la penalità di transito da
   un ordine di flotta. Per `move`/`explore`/`attack` = singolo target;
   `move-route` = waypoints; `patrol-loop` = nodi loop; `patrol` = sysA+sysB. */
function collectOrderSystems(g, fleet, order) {
  if (!order) return [];
  if (order.type === 'move' || order.type === 'explore' || order.type === 'attack') {
    return order.toSysId != null ? [order.toSysId] : [];
  }
  if (order.type === 'move-route') return Array.isArray(order.waypoints) ? order.waypoints.slice() : [];
  if (order.type === 'patrol-loop') return Array.isArray(order.loop) ? order.loop.slice() : [];
  if (order.type === 'patrol') {
    const o = [];
    if (order.sysA != null) o.push(order.sysA);
    if (order.sysB != null) o.push(order.sysB);
    return o;
  }
  return [];
}

function runDiplomacyAction(civ, actionId) {
  const danger = (actionId === 'declare-war' || actionId === 'break-alliance');
  let title, msg, confirmLabel;
  if (actionId === 'declare-war') {
    title = 'Dichiara guerra';
    msg = '<p>Dichiarare guerra a <strong>' + escapeHtml(civ.name) + '</strong>?</p>' +
      (civ.alignment !== 'male'
        ? '<p>Aggredire una civiltà <strong>non maligna</strong> costa reputazione (verbo morale dark).</p>'
        : '<p>Aggredire una civiltà maligna è un atto di luce (+reputazione).</p>');
    confirmLabel = 'Dichiara guerra';
  } else if (actionId === 'break-alliance') {
    title = 'Rompi alleanza';
    msg = '<p>Rompere l\'alleanza con <strong>' + escapeHtml(civ.name) + '</strong>?</p>' +
      '<p>Costo: <strong>−10 reputazione</strong>. La civiltà ti vedrà come traditore.</p>';
    confirmLabel = 'Rompi';
  } else if (actionId === 'propose-peace') {
    title = 'Proponi pace';
    msg = '<p>Proporre pace a <strong>' + escapeHtml(civ.name) + '</strong>?</p>';
    confirmLabel = 'Proponi';
  } else if (actionId === 'propose-alliance') {
    title = 'Proponi alleanza';
    msg = '<p>Proporre alleanza a <strong>' + escapeHtml(civ.name) + '</strong>?</p>';
    confirmLabel = 'Proponi';
  } else {
    title = 'Dispaccio diplomatico';
    msg = '<p>Procedere?</p>';
    confirmLabel = 'Invia';
  }
  confirmAction({
    title: title,
    message: msg,
    confirmLabel: confirmLabel,
    danger: danger,
    force: danger,   // guerra + rottura sempre confermate
    onConfirm: function () { _doDiplomacyAction(civ, actionId); }
  });
}
function _doDiplomacyAction(civ, actionId) {
  const g = ORION.game;
  const DIP = ORION.diplomacy;
  if (!g || !DIP) return;
  const events = [];
  const res = DIP.apply(g, civ, actionId, events);
  if (!res.ok) { showToast(res.reason || 'Dispaccio rifiutato'); return; }
  events.forEach(function (ev) { chronicleEvent(ev); });
  persistGame(g);
  updateGlobalIndicesHud();
  const stage = document.querySelector('[data-view-stage]');
  if (stage && ORION._currentView === 'civ') renderCivView(stage);
  if (ORION.map && ORION.map.requestRender) ORION.map.requestRender();
  if (res.accepted === false) showToast(civ.name + ' ha respinto la proposta');
}

/* M11 Fase B parziale: accetta/rifiuta un'offerta diplomatica AI. */
function respondToAiOffer(civ, accept) {
  const g = ORION.game;
  const DIP = ORION.diplomacy;
  if (!g || !DIP || !civ || !civ.pendingOffer) return;
  const events = [];
  const res = DIP.respondToOffer(g, civ, accept, events);
  if (!res.ok) { showToast(res.reason || 'Risposta rifiutata'); return; }
  events.forEach(function (ev) { chronicleEvent(ev); });
  persistGame(g);
  updateGlobalIndicesHud();
  const stage = document.querySelector('[data-view-stage]');
  if (stage && ORION._currentView === 'civ') renderCivView(stage);
  if (ORION.map && ORION.map.requestRender) ORION.map.requestRender();
  showToast(accept ? ('Offerta accettata · ' + civ.name) : ('Offerta rifiutata · ' + civ.name));
}

function findFleet(id) {
  const g = ORION.game;
  if (!g || !Array.isArray(g.fleets)) return null;
  for (let i = 0; i < g.fleets.length; i++) {
    if (g.fleets[i].id === id) return g.fleets[i];
  }
  return null;
}

function closeFleetOverlay() {
  const host = document.querySelector('[data-bind="fleet-overlay"]');
  if (host) { host.hidden = true; host.innerHTML = ''; }
}

function ensureFleetOverlayHost(cls) {
  let host = document.querySelector('[data-bind="fleet-overlay"]');
  if (!host) {
    host = document.createElement('div');
    host.setAttribute('data-bind', 'fleet-overlay');
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-modal', 'true');
    document.body.appendChild(host);
  }
  host.className = cls;
  return host;
}

function openFleetCreateOverlay(eligibleColonies) {
  /* M08 Fase B: tutorial — classi navi alla prima creazione/manage. */
  if (ORION.tutorial) ORION.tutorial.fire('fleet-classes');
  const g = ORION.game;
  const host = ensureFleetOverlayHost('fleet-create-overlay');
  const colonyOptions = eligibleColonies.map(function (e) {
    const sys = g.galaxy.systems[e.colony.systemId];
    const lab = (sys ? sys.name : 'sistema') + ' · ' + e.key;
    return '<option value="' + escapeHtml(e.key) + '">' + escapeHtml(lab) + '</option>';
  }).join('');
  host.innerHTML =
    '<div class="fleet-create-overlay__panel" role="document">' +
      '<header class="fleet-create-overlay__head">' +
        '<h2>Crea flotta</h2>' +
        '<button class="btn btn--mini btn--icon-only" data-action="fleet-overlay-close" type="button" aria-label="Chiudi">' +
          '<span class="ui-icon" aria-hidden="true">' + ((ORION.icon && ORION.icon('close')) || '✕') + '</span>' +
        '</button>' +
      '</header>' +
      '<label class="fleet-field">Colonia origine' +
        '<select data-bind="fleet-create-colony">' + colonyOptions + '</select>' +
      '</label>' +
      '<label class="fleet-field">Nome (opzionale)' +
        '<input type="text" data-bind="fleet-create-name" placeholder="Squadrone X" maxlength="40">' +
      '</label>' +
      '<div class="fleet-create-overlay__actions">' +
        '<button class="btn btn--mini" data-action="fleet-overlay-close" type="button">Annulla</button>' +
        '<button class="btn btn--primary" data-action="fleet-create-confirm" type="button">Crea</button>' +
      '</div>' +
    '</div>';
  host.hidden = false;
  host.addEventListener('click', function (e) {
    if (e.target === host || e.target.matches('[data-action="fleet-overlay-close"]')) closeFleetOverlay();
  });
  host.querySelector('[data-action="fleet-create-confirm"]').addEventListener('click', function () {
    const colKey = host.querySelector('[data-bind="fleet-create-colony"]').value;
    const name = host.querySelector('[data-bind="fleet-create-name"]').value;
    const r = ORION.fleet.createFleet(g, colKey, name);
    if (!r.ok) { showToast(r.reason); return; }
    pushChronicle(ORION.time.currentDS(g) + ' — Nuova flotta <strong>' + escapeHtml(r.fleet.name) +
      '</strong> formata su ' + escapeHtml(colonyName_(g, colKey)) + '.', 'planet');
    persistGame(g);
    closeFleetOverlay();
    const stage = document.querySelector('[data-view-stage]');
    if (stage) renderFleetView(stage);
  });
}

function colonyName_(g, key) {
  const parts = (key || '').split(':');
  if (parts.length < 2) return '—';
  const sid = Number(parts[0]);
  const sys = g.galaxy && g.galaxy.systems && g.galaxy.systems[sid];
  return sys ? sys.name : ('Sistema ' + sid);
}

function openFleetManageOverlay(fleetId) {
  const g = ORION.game;
  const fleet = findFleet(fleetId);
  if (!fleet) return;
  const colony = g.colonies[fleet.ownerColonyKey];
  if (!colony) return;
  ORION.fleet.ensureColonyShipKinds(colony);
  const host = ensureFleetOverlayHost('fleet-create-overlay');

  /* Tabella per-classe: counter colonia, counter flotta, +/-. */
  const classes = ORION.fleet.classList();
  let rowsHtml = '';
  classes.forEach(function (cls) {
    const inDock = colony.ships[cls.id] || 0;
    let inFleet = 0;
    fleet.ships.forEach(function (s) { if (s.kind === cls.id) inFleet++; });
    rowsHtml +=
      '<tr>' +
        '<td>' + cls.glyph + ' ' + escapeHtml(cls.name) + '</td>' +
        '<td>' + inDock + '</td>' +
        '<td>' + inFleet + '</td>' +
        '<td>' +
          '<button class="btn btn--mini" data-action="fleet-add-ship" data-kind="' + cls.id + '" type="button"' +
            (inDock <= 0 || fleet.location.status !== 'docked' || fleet.location.systemId !== colony.systemId ? ' disabled' : '') +
            '>+1</button> ' +
          '<button class="btn btn--mini" data-action="fleet-rem-ship" data-kind="' + cls.id + '" type="button"' +
            (inFleet <= 0 || fleet.location.status !== 'docked' || fleet.location.systemId !== colony.systemId ? ' disabled' : '') +
            '>−1</button>' +
        '</td>' +
      '</tr>';
  });

  const crewAvail = (colony.crews && colony.crews.explorer && colony.crews.explorer.length) || 0;
  const crewInFleet = fleet.crew ? fleet.crew.length : 0;
  const crewReq = ORION.fleet.fleetCrewRequired(fleet);

  host.innerHTML =
    '<div class="fleet-create-overlay__panel" role="document">' +
      '<header class="fleet-create-overlay__head">' +
        '<h2>Gestisci ' + escapeHtml(fleet.name) + '</h2>' +
        '<button class="btn btn--mini btn--icon-only" data-action="fleet-overlay-close" type="button" aria-label="Chiudi">' +
          '<span class="ui-icon" aria-hidden="true">' + ((ORION.icon && ORION.icon('close')) || '✕') + '</span>' +
        '</button>' +
      '</header>' +
      '<p class="panel__note">La flotta deve essere all\'attracco della colonia origine per assegnare/restituire navi. ' +
        'Stato attuale: <strong>' + (fleet.location.status === 'docked' && fleet.location.systemId === colony.systemId
          ? 'attraccata su ' + colonyName_(g, fleet.ownerColonyKey)
          : 'fuori dalla base') + '</strong>.</p>' +
      '<table class="fleet-manage-table">' +
        '<thead><tr><th>Classe</th><th>A terra</th><th>In flotta</th><th>Azione</th></tr></thead>' +
        '<tbody>' + rowsHtml + '</tbody>' +
      '</table>' +
      '<p class="sysinfo__sub">Equipaggi</p>' +
      '<div class="fleet-crew-row">' +
        '<span>Colonia: <strong>' + crewAvail + '</strong> · Flotta: <strong>' + crewInFleet + '</strong> ' +
        '<span class="cantieri-row__base">(richiesti ' + crewReq + ')</span></span>' +
        '<button class="btn btn--mini" data-action="fleet-add-crew" type="button"' +
          (crewAvail <= 0 || fleet.location.status !== 'docked' || fleet.location.systemId !== colony.systemId ? ' disabled' : '') +
          '>+ Equipaggio</button>' +
        '<button class="btn btn--mini" data-action="fleet-rem-crew" type="button"' +
          (crewInFleet <= 0 || fleet.location.status !== 'docked' || fleet.location.systemId !== colony.systemId ? ' disabled' : '') +
          '>− Equipaggio</button>' +
      '</div>' +
      '<div class="fleet-create-overlay__actions">' +
        '<button class="btn btn--primary" data-action="fleet-overlay-close" type="button">Chiudi</button>' +
      '</div>' +
    '</div>';
  host.hidden = false;
  host.addEventListener('click', function (e) {
    if (e.target === host || e.target.matches('[data-action="fleet-overlay-close"]')) closeFleetOverlay();
  });
  host.querySelectorAll('[data-action="fleet-add-ship"]').forEach(function (b) {
    b.addEventListener('click', function () {
      const r = ORION.fleet.assignShips(g, fleet, fleet.ownerColonyKey, b.dataset.kind, 1);
      if (!r.ok) { showToast(r.reason); return; }
      persistGame(g); openFleetManageOverlay(fleet.id);
    });
  });
  host.querySelectorAll('[data-action="fleet-rem-ship"]').forEach(function (b) {
    b.addEventListener('click', function () {
      const r = ORION.fleet.unassignShips(g, fleet, fleet.ownerColonyKey, b.dataset.kind, 1);
      if (!r.ok) { showToast(r.reason); return; }
      persistGame(g); openFleetManageOverlay(fleet.id);
    });
  });
  host.querySelector('[data-action="fleet-add-crew"]').addEventListener('click', function () {
    const r = ORION.fleet.assignCrew(g, fleet, fleet.ownerColonyKey, 1);
    if (!r.ok) { showToast(r.reason); return; }
    persistGame(g); openFleetManageOverlay(fleet.id);
  });
  host.querySelector('[data-action="fleet-rem-crew"]').addEventListener('click', function () {
    const r = ORION.fleet.unassignCrew(g, fleet, fleet.ownerColonyKey, 1);
    if (!r.ok) { showToast(r.reason); return; }
    persistGame(g); openFleetManageOverlay(fleet.id);
  });
}

function openFleetOrdersOverlay(fleetId) {
  const g = ORION.game;
  const fleet = findFleet(fleetId);
  if (!fleet) return;
  /* M08 Fase B: tutorial — ordini e rotte composte alla prima apertura. */
  if (ORION.tutorial) ORION.tutorial.fire('fleet-orders');
  const host = ensureFleetOverlayHost('fleet-orders-overlay');

  /* Sistemi raggiungibili (nebbia di guerra rispettata: mostriamo tutti
     i sistemi con almeno una rotta dalla posizione corrente; per
     `explore` quelli non ancora EXPLORED). */
  const DISCOVERY = ORION.galaxy.DISCOVERY;
  const allReachable = [];
  for (let i = 0; i < g.galaxy.systems.length; i++) {
    if (i === fleet.location.systemId) continue;
    if (ORION.fleet.computePath(g.galaxy, fleet.location.systemId, i)) {
      allReachable.push(i);
    }
  }
  function sysOptionLabel(id) {
    const s = g.galaxy.systems[id];
    const disc = g.state.discovery[id];
    const tag = (disc >= DISCOVERY.EXPLORED) ? 'esplorato' : (disc >= DISCOVERY.DETECTED) ? 'rilevato' : 'ignoto';
    return s.name + ' · ' + tag;
  }
  const optsMove = allReachable.map(function (id) {
    return '<option value="' + id + '">' + escapeHtml(sysOptionLabel(id)) + '</option>';
  }).join('');
  const optsExplore = allReachable
    .filter(function (id) { return g.state.discovery[id] < DISCOVERY.EXPLORED; })
    .map(function (id) {
      return '<option value="' + id + '">' + escapeHtml(sysOptionLabel(id)) + '</option>';
    }).join('');

  host.innerHTML =
    '<div class="fleet-orders-overlay__panel" role="document">' +
      '<header class="fleet-orders-overlay__head">' +
        '<h2>Ordini · ' + escapeHtml(fleet.name) + '</h2>' +
        '<button class="btn btn--mini btn--icon-only" data-action="fleet-overlay-close" type="button" aria-label="Chiudi">' +
          '<span class="ui-icon" aria-hidden="true">' + ((ORION.icon && ORION.icon('close')) || '✕') + '</span>' +
        '</button>' +
      '</header>' +
      '<p class="panel__note">Posizione: <strong>' + escapeHtml(g.galaxy.systems[fleet.location.systemId].name) + '</strong>. ' +
        'Equipaggio: ' + fleet.crew.length + ' / ' + ORION.fleet.fleetCrewRequired(fleet) + ' richiesti. ' +
        'Velocità minima: ' + ORION.fleet.fleetMinSpeed(fleet).toFixed(2) + '.</p>' +
      '<section class="fleet-order-block">' +
        '<h3>Rotta verso (move)</h3>' +
        '<select data-bind="fleet-order-move">' + optsMove + '</select>' +
        '<button class="btn btn--mini" data-action="fleet-order-move" type="button">Imposta</button>' +
      '</section>' +
      '<section class="fleet-order-block">' +
        '<h3>Esplora (explore)</h3>' +
        '<select data-bind="fleet-order-explore">' + (optsExplore || '<option value="" disabled>Nessun sistema inesplorato</option>') + '</select>' +
        '<button class="btn btn--mini" data-action="fleet-order-explore" type="button"' +
          (optsExplore ? '' : ' disabled') + '>Imposta</button>' +
      '</section>' +
      '<section class="fleet-order-block">' +
        '<h3>Pattuglia A ↔ B (patrol)</h3>' +
        '<select data-bind="fleet-order-pat-a">' + optsMove + '</select>' +
        '<select data-bind="fleet-order-pat-b">' + optsMove + '</select>' +
        '<button class="btn btn--mini" data-action="fleet-order-patrol" type="button">Imposta</button>' +
      '</section>' +
      /* Fase B (decisione #46): rotta multi-tappa e pattuglia su N sistemi.
         Il giocatore costruisce la lista delle tappe (gancio per "vagare"
         tra sistemi favorevoli; AI/rifugi neutrali verranno con M10-M11). */
      '<section class="fleet-order-block fleet-order-block--route">' +
        '<h3>Rotta a tappe (move-route)</h3>' +
        '<p class="panel__note">Catena di sistemi. Per ogni tappa puoi impostare una sosta orbitale in Ι. ' +
          '<label class="fleet-order-flag"><input type="checkbox" data-bind="fleet-route-explore"> Esplora ogni tappa</label> ' +
          '<label class="fleet-order-flag"><input type="checkbox" data-bind="fleet-route-return"> Rientra alla base alla fine</label></p>' +
        '<ul class="fleet-route-list" data-bind="fleet-route-list"></ul>' +
        '<div class="fleet-route-add">' +
          '<select data-bind="fleet-route-pick">' + optsMove + '</select>' +
          '<input type="number" data-bind="fleet-route-dwell" min="0" max="200" step="1" value="0" title="Sosta orbitale in Ι"> Ι' +
          '<button class="btn btn--mini" data-action="fleet-route-add" type="button">+ Aggiungi tappa</button>' +
        '</div>' +
        '<button class="btn btn--mini" data-action="fleet-order-route" type="button">Imposta rotta</button>' +
      '</section>' +
      '<section class="fleet-order-block fleet-order-block--route">' +
        '<h3>Pattuglia su N sistemi (patrol-loop)</h3>' +
        '<p class="panel__note">Loop circolare su 2+ sistemi. La pattuglia riparte automaticamente.</p>' +
        '<ul class="fleet-route-list" data-bind="fleet-loop-list"></ul>' +
        '<div class="fleet-route-add">' +
          '<select data-bind="fleet-loop-pick">' + optsMove + '</select>' +
          '<input type="number" data-bind="fleet-loop-dwell" min="0" max="200" step="1" value="0" title="Sosta orbitale in Ι"> Ι' +
          '<button class="btn btn--mini" data-action="fleet-loop-add" type="button">+ Aggiungi nodo</button>' +
        '</div>' +
        '<button class="btn btn--mini" data-action="fleet-order-patrol-loop" type="button">Imposta pattuglia</button>' +
      '</section>' +
      '<section class="fleet-order-block">' +
        '<h3>Rientro alla base (return)</h3>' +
        '<button class="btn btn--mini" data-action="fleet-order-return" type="button">Imposta</button>' +
      '</section>' +
      '<section class="fleet-order-block">' +
        '<h3>Idle</h3>' +
        '<button class="btn btn--mini" data-action="fleet-order-idle" type="button">Imposta</button>' +
      '</section>' +
    '</div>';
  host.hidden = false;
  host.addEventListener('click', function (e) {
    if (e.target === host || e.target.matches('[data-action="fleet-overlay-close"]')) closeFleetOverlay();
  });

  function dispatch(order) {
    const r = ORION.fleet.setOrder(g, fleet, order);
    if (!r.ok) { showToast(r.reason); return; }
    /* M10 Fase B (decisione #52 §13.6): se la rotta tocca sistemi coesi,
       paga −1 disposizione/proprietario (cap −3 globale per atto di
       pianificazione). Warning narrativo in cronaca. */
    if (ORION.cohesion && ORION.cohesion.applyTravelPenalty && order.type !== 'idle' && order.type !== 'return') {
      const sysIds = collectOrderSystems(g, fleet, order);
      const pen = ORION.cohesion.applyTravelPenalty(g, sysIds);
      if (pen.applied < 0) {
        showToast('Rotta attraverso ' + pen.affectedSys.length + ' sistema coeso — disposizione ' + pen.applied + '/proprietari');
      }
    }
    if (order.type !== 'idle') {
      let label;
      if (order.type === 'move-route') {
        const tappe = order.waypoints.map(function (id) { return g.galaxy.systems[id].name; }).join(' → ');
        label = 'rotta a tappe: ' + tappe + (order.returnHome ? ' → rientro' : '');
      } else if (order.type === 'patrol-loop') {
        const nodi = order.loop.map(function (id) { return g.galaxy.systems[id].name; }).join(' ↻ ');
        label = 'pattuglia ciclica: ' + nodi;
      } else {
        const target = (order.type === 'patrol') ? order.sysA :
                       (order.type === 'return') ? (g.colonies[fleet.ownerColonyKey] || {}).systemId :
                       order.toSysId;
        label = 'ordine "' + order.type + '" verso ' + g.galaxy.systems[target].name;
      }
      pushChronicle(ORION.time.currentDS(g) + ' — <strong>' + escapeHtml(fleet.name) + '</strong>: ' + escapeHtml(label) + '.', 'explore');
    }
    persistGame(g);
    closeFleetOverlay();
    const stage = document.querySelector('[data-view-stage]');
    if (stage) renderFleetView(stage);
  }
  host.querySelector('[data-action="fleet-order-move"]').addEventListener('click', function () {
    const sel = host.querySelector('[data-bind="fleet-order-move"]');
    if (!sel || !sel.value) { showToast('Nessun sistema selezionato'); return; }
    dispatch({ type: 'move', toSysId: Number(sel.value) });
  });
  const expBtn = host.querySelector('[data-action="fleet-order-explore"]');
  if (expBtn) expBtn.addEventListener('click', function () {
    const sel = host.querySelector('[data-bind="fleet-order-explore"]');
    if (!sel || !sel.value) { showToast('Nessun sistema selezionato'); return; }
    dispatch({ type: 'explore', toSysId: Number(sel.value) });
  });
  host.querySelector('[data-action="fleet-order-patrol"]').addEventListener('click', function () {
    const a = host.querySelector('[data-bind="fleet-order-pat-a"]');
    const b = host.querySelector('[data-bind="fleet-order-pat-b"]');
    if (!a || !a.value || !b || !b.value) { showToast('Seleziona A e B'); return; }
    if (a.value === b.value) { showToast('A e B devono essere diversi'); return; }
    dispatch({ type: 'patrol', sysA: Number(a.value), sysB: Number(b.value) });
  });
  /* Fase B: stato locale dei costruttori rotta/loop (vive solo finché
     l'overlay è aperto — non serve persistere). Il rendering è delegato
     a una funzione che si chiama ad ogni mutazione. */
  const route = { wps: [], dwell: [] };
  const loop  = { wps: [], dwell: [] };

  function sysShort(id) {
    const s = g.galaxy.systems[id];
    return s ? s.name : ('#' + id);
  }
  function renderWpList(targetSel, store, removeAction) {
    const ul = host.querySelector(targetSel);
    if (!ul) return;
    if (store.wps.length === 0) {
      ul.innerHTML = '<li class="fleet-route-empty">Nessuna tappa.</li>';
      return;
    }
    ul.innerHTML = store.wps.map(function (sid, i) {
      return '<li class="fleet-route-item">' +
        '<span class="fleet-route-item__n">' + (i + 1) + '.</span>' +
        '<span class="fleet-route-item__name">' + escapeHtml(sysShort(sid)) + '</span>' +
        '<span class="fleet-route-item__dwell">' + (store.dwell[i] || 0) + ' Ι</span>' +
        '<button class="btn btn--mini btn--icon-only" data-action="' + removeAction + '" data-idx="' + i + '" type="button" title="Rimuovi tappa" aria-label="Rimuovi">' + uiIcon('close', 'pink') + '</button>' +
      '</li>';
    }).join('');
    ul.querySelectorAll('[data-action="' + removeAction + '"]').forEach(function (b) {
      b.addEventListener('click', function () {
        const idx = Number(b.dataset.idx);
        store.wps.splice(idx, 1);
        store.dwell.splice(idx, 1);
        renderWpList(targetSel, store, removeAction);
      });
    });
  }
  renderWpList('[data-bind="fleet-route-list"]', route, 'fleet-route-rm');
  renderWpList('[data-bind="fleet-loop-list"]', loop, 'fleet-loop-rm');

  const routeAddBtn = host.querySelector('[data-action="fleet-route-add"]');
  if (routeAddBtn) routeAddBtn.addEventListener('click', function () {
    const pick = host.querySelector('[data-bind="fleet-route-pick"]');
    const dw = host.querySelector('[data-bind="fleet-route-dwell"]');
    if (!pick || !pick.value) { showToast('Seleziona un sistema'); return; }
    route.wps.push(Number(pick.value));
    route.dwell.push(Math.max(0, parseInt(dw.value || '0', 10) || 0));
    renderWpList('[data-bind="fleet-route-list"]', route, 'fleet-route-rm');
  });
  const loopAddBtn = host.querySelector('[data-action="fleet-loop-add"]');
  if (loopAddBtn) loopAddBtn.addEventListener('click', function () {
    const pick = host.querySelector('[data-bind="fleet-loop-pick"]');
    const dw = host.querySelector('[data-bind="fleet-loop-dwell"]');
    if (!pick || !pick.value) { showToast('Seleziona un sistema'); return; }
    loop.wps.push(Number(pick.value));
    loop.dwell.push(Math.max(0, parseInt(dw.value || '0', 10) || 0));
    renderWpList('[data-bind="fleet-loop-list"]', loop, 'fleet-loop-rm');
  });

  host.querySelector('[data-action="fleet-order-route"]').addEventListener('click', function () {
    if (!route.wps.length) { showToast('Aggiungi almeno una tappa'); return; }
    const expFlag = host.querySelector('[data-bind="fleet-route-explore"]');
    const retFlag = host.querySelector('[data-bind="fleet-route-return"]');
    dispatch({
      type: 'move-route',
      waypoints: route.wps.slice(),
      dwell: route.dwell.slice(),
      exploreEach: !!(expFlag && expFlag.checked),
      returnHome:  !!(retFlag && retFlag.checked)
    });
  });
  host.querySelector('[data-action="fleet-order-patrol-loop"]').addEventListener('click', function () {
    if (loop.wps.length < 2) { showToast('Servono almeno 2 nodi per la pattuglia'); return; }
    dispatch({
      type: 'patrol-loop',
      loop: loop.wps.slice(),
      dwell: loop.dwell.slice()
    });
  });

  host.querySelector('[data-action="fleet-order-return"]').addEventListener('click', function () {
    dispatch({ type: 'return' });
  });
  host.querySelector('[data-action="fleet-order-idle"]').addEventListener('click', function () {
    dispatch({ type: 'idle' });
  });
}

/* --- Tab Popolazione --- */
function renderPlanetPopolazioneTab(host, planet, colony) {
  const classes = colony.pop.classes;
  const total = colony.pop.total;
  const cap = colony.pop.cap;
  // Persone correnti (units frazionarie per fluidità): le classi ne sono
  // una quota proporzionale (interi internamente → persone a schermo).
  const peopleNow = ORION.planet.peopleAt(ORION.planet.popUnits(colony), planet);
  const order = ['operai', 'scienziati', 'militari', 'mercanti', 'tecnici'];
  const labels = { operai: 'Operai', scienziati: 'Scienziati', militari: 'Militari', mercanti: 'Mercanti', tecnici: 'Tecnici' };
  let bars = '<ul class="class-list">';
  order.forEach(function (k) {
    const v = classes[k] || 0;
    const pct = total > 0 ? Math.round(v * 100 / total) : 0;
    const peopleK = total > 0 ? ORION.planet.formatPeople(peopleNow * v / total) : '0';
    bars += '<li class="class-item"><span class="class-item__label">' + labels[k] + '</span>' +
      '<div class="class-item__bar"><div class="class-item__fill class--' + k + '" style="width:' + pct + '%"></div></div>' +
      '<span class="class-item__val">' + peopleK + '</span></li>';
  });
  bars += '</ul>';

  // Calcolo crescita stimata per Impulso (visualizzazione).
  // Durante l'Insediamento (M06.5) il motore congela la crescita
  // (time.js processPopulation), quindi la stima dev'essere coerente: 0.
  const CFG = ORION.time.CFG;
  const scar = colony._scar;
  const settling = colony.phase === 'settling';

  // Capacità di carico locale (decisione #45, emenda v2): il consumo pop
  // drena lo stock (vedi time.js processProduction). MA la crescita NON è
  // gata sul saldo istantaneo: se lo stock è in stato 'ok' (riserve
  // abbondanti) la pop cresce a pieno regime anche con saldo negativo —
  // sta consumando il magazzino. Solo se le scorte scendono davvero
  // (low/crit) la crescita rallenta/si ferma. Coerente col motore.
  const out = ORION.planet.structureOutput(colony, planet, ORION.game);
  const foodNet = (out.rates.food || 0) - (out.upkeep.food || 0);
  const waterNet = (out.rates.water || 0) - (out.upkeep.water || 0);
  const sustFood = CFG.POP_FOOD_PER_UNIT > 0 ? foodNet / CFG.POP_FOOD_PER_UNIT : 0;
  const sustWater = CFG.POP_WATER_PER_UNIT > 0 ? waterNet / CFG.POP_WATER_PER_UNIT : 0;
  let sustainable = Math.min(sustFood, sustWater);
  if (sustainable < 0) sustainable = 0;
  if (sustainable > cap) sustainable = cap;
  const limitRes = sustWater <= sustFood ? 'acqua' : 'cibo';
  /* Saldo reale comprensivo di drenaggio pop. */
  const realFoodNet = foodNet - total * CFG.POP_FOOD_PER_UNIT;
  const realWaterNet = waterNet - total * CFG.POP_WATER_PER_UNIT;
  /* Runway (Ι rimanenti al ritmo di consumo) — gating relativo, scala da
     pop piccola a miliardi (decisione #45 emenda v3). */
  const drainFood = Math.max(0, -realFoodNet);
  const drainWater = Math.max(0, -realWaterNet);
  const runwayFood = drainFood > 0 ? Math.floor((colony.stock.food || 0) / drainFood) : Infinity;
  const runwayWater = drainWater > 0 ? Math.floor((colony.stock.water || 0) / drainWater) : Infinity;
  const runway = Math.min(runwayFood, runwayWater);
  const RUNWAY_LOW = CFG.POP_RUNWAY_LOW || 30;
  const RUNWAY_CRIT = CFG.POP_RUNWAY_CRIT || 10;
  /* Stock esaurito? identifica anche quale risorsa. */
  const foodOut = (colony.stock.food || 0) <= 0;
  const waterOut = (colony.stock.water || 0) <= 0;
  const critFW = foodOut || waterOut || runway < RUNWAY_CRIT;
  let supplyFactor;
  if (critFW) supplyFactor = 0;
  else if (runway < RUNWAY_LOW) supplyFactor = 0.3;
  else supplyFactor = 1;
  const limitRunway = runwayFood <= runwayWater ? 'cibo' : 'acqua';
  const canGrow = !settling && total < cap && supplyFactor > 0;
  // Morale: calcolato sempre (anche se la crescita è bloccata) per dare
  // visibilità della leva §9.3. Breakdown dei contributi mostrato sotto.
  const moraleParts = [];
  let morale = 1.0;
  moraleParts.push('base 1.00');
  if (colony.isHomeBase) {
    morale += CFG.POP_MORALE_HOMEBASE;
    moraleParts.push('+' + CFG.POP_MORALE_HOMEBASE.toFixed(2) + ' base');
  }
  const habit = (colony.structures['centro-abitativo'] && colony.structures['centro-abitativo'].level) || 0;
  if (habit > 0) {
    const habitBonus = Math.min(CFG.POP_MORALE_MAX - 1.0, habit * CFG.POP_MORALE_HABITATION);
    morale += habitBonus;
    moraleParts.push('+' + habitBonus.toFixed(2) + ' centri abitativi ×' + habit);
  }
  if (morale > CFG.POP_MORALE_MAX) morale = CFG.POP_MORALE_MAX;
  if (scar && (scar.food.state === 'low' || scar.water.state === 'low')) {
    morale *= 0.6;
    moraleParts.push('×0.6 carenza cibo/acqua');
  }
  // Sovraffollamento: segnale implicito (decisione #37bis). La morale cala
  // se la popolazione supera la capacità abitativa → spinge il giocatore a
  // sviluppare l'habitat senza dirglielo esplicitamente.
  const hospLvl = (colony.structures['ospedale'] && colony.structures['ospedale'].level) || 0;
  const Sm = ORION.structures;
  const housingCap = CFG.POP_HOUSING_BASE
    + (habit > 0 ? Sm.moduleSum(habit) : 0) * CFG.POP_HOUSING_PER_LEVEL
    + (hospLvl > 0 ? Sm.moduleSum(hospLvl) : 0) * CFG.POP_HOSPITAL_HOUSING;
  const crowd = housingCap > 0 ? total / housingCap : 99;
  if (crowd > CFG.POP_CROWD_START) {
    const crowdPen = Math.max(0.05, 1 - (crowd - CFG.POP_CROWD_START) * CFG.POP_CROWD_SLOPE);
    morale *= crowdPen;
    moraleParts.push('×' + crowdPen.toFixed(2) + ' sovraffollamento');
  }
  let growthEst = 0;
  if (canGrow) {
    growthEst = CFG.POP_GROWTH_BASE * morale * supplyFactor;
    if (colony.structures['ospedale']) growthEst *= (1 + CFG.POP_GROWTH_HOSPITAL);
  }
  // Crescita in PERSONE/Impulso: pendenza della curva × crescita in unità/I,
  // diviso il costo del livello (freno temporale: ogni livello costa di più).
  let growthStr;
  if (canGrow) {
    const M = ORION.planet.popCeiling(planet);
    const refCap = Math.max(2, planet.popCap || 2);
    const slope = M > 0 ? Math.log(M / ORION.planet.POP_FLOOR) / (refCap - 1) : 0;
    const unitCost = 1 + CFG.POP_LEVEL_COST * (total - 1);
    const marginal = peopleNow * slope * growthEst / Math.max(1, unitCost);
    let suffix = '';
    /* Decisione #45 emenda v3: messaggio runway-based.
       - saldo positivo (runway infinito): pulito, nessun suffisso
       - saldo neg ma runway > 30 Ι: "consuma riserve (X Ι rimanenti)"
       - runway 10-30 Ι: "rallentata · scorte basse (X Ι rimanenti)" */
    if (runway < RUNWAY_LOW && isFinite(runway)) {
      suffix = ' · rallentata · scorte ' + limitRunway + ' basse (' + runway + ' Ι rimanenti)';
    } else if ((drainFood > 0 || drainWater > 0) && isFinite(runway)) {
      suffix = ' · consuma riserve (' + runway + ' Ι rimanenti)';
    }
    growthStr = '+' + ORION.planet.formatPeople(marginal) + ' / Impulso' + suffix;
  } else if (settling) {
    growthStr = 'ferma (Insediamento)';
  } else if (total >= cap) {
    growthStr = 'al cap del pianeta';
  } else if (foodOut) {
    growthStr = 'ferma · scorte cibo esaurite';
  } else if (waterOut) {
    growthStr = 'ferma · scorte acqua esaurite';
  } else if (critFW) {
    growthStr = 'ferma · scorte ' + limitRunway + ' critiche (' + runway + ' Ι rimanenti)';
  } else {
    growthStr = 'plateau';
  }

  // Target classi suggerito dalle strutture
  const tw = ORION.time.targetClassWeights(colony);
  let twSum = 0; Object.keys(tw).forEach(function (k) { twSum += tw[k]; });
  let targetHtml = '';
  if (twSum > 0) {
    const targetBits = order.map(function (k) {
      const pct = Math.round((tw[k] || 0) / twSum * 100);
      return pct > 0 ? labels[k] + ' ' + pct + '%' : '';
    }).filter(Boolean).join(' · ');
    targetHtml = '<p class="panel__note panel__note--target">Vocazione a regime: ' + targetBits + '</p>';
  }

  host.innerHTML =
    '<div class="sysinfo">' +
      '<dl class="sysinfo__list">' +
        row('Popolazione', popRangePeople(colony, planet)) +
        row('Sostenibile (locale)', '~' + Math.floor(sustainable) + ' / ' + cap + ' unità · ' +
            ORION.planet.formatPeople(ORION.planet.peopleAt(sustainable, planet)) +
            ' <span class="pop-limit">(limite: ' + limitRes + ')</span>') +
        row('Morale', morale.toFixed(2) + ' / ' + CFG.POP_MORALE_MAX.toFixed(2) +
            ' <span class="rate-aux" title="' + escapeHtml(moraleParts.join(' · ')) + '">(dettagli)</span>') +
        row('Crescita', '<span class="rate ' + (canGrow ? 'rate--pos' : 'rate--neg') + '">' + growthStr + '</span>') +
      '</dl>' +
      '<p class="sysinfo__sub">Classi funzionali</p>' +
      bars +
      targetHtml +
    '</div>';

  ensurePopAnim();
  if (ORION.tutorial) ORION.tutorial.fire('population');
}

/* --- helper: barre dei potenziali e altre UI atomiche --- */
function potentialBars(planet) {
  const keys = ['met', 'en', 'food', 'water'];
  const labels = { met: 'Metalli', en: 'Energia', food: 'Cibo', water: 'Acqua' };
  return '<ul class="pot-list">' + keys.map(function (k) {
    const v = planet.potentials[k] || 0;
    return '<li class="pot-item"><span class="pot-item__label">' + resIcon(k) + ' ' + labels[k] + '</span>' +
      '<div class="pot-item__bar"><div class="pot-item__fill pot--' + k + '" style="width:' + v + '%"></div></div>' +
      '<span class="pot-item__val">' + v + '</span></li>';
  }).join('') + '</ul>';
}

function rateGrid(rates, upkeep, colony) {
  function fmtNet(v) { return (v >= 0 ? '+' : '−') + (Math.round(Math.abs(v) * 100) / 100); }
  function fmtAbs(v) { return Math.round(Math.abs(v) * 100) / 100; }
  /* Decisione #45: il consumo pro-capite della popolazione drena cibo/acqua
     dallo stock (time.js processProduction). Lo mostriamo esplicitamente nel
     riepilogo perché in passato l'utente vedeva "+4 /I" senza capire perché
     lo stock scendeva. Solo in fase operational (Insediamento è bloccato). */
  const CFG = ORION.time && ORION.time.CFG;
  const popTotal = (colony && colony.pop && colony.pop.total) || 0;
  const opPhase = !colony || colony.phase !== 'settling';
  const popFood  = (opPhase && CFG && popTotal > 0) ? popTotal * CFG.POP_FOOD_PER_UNIT  : 0;
  const popWater = (opPhase && CFG && popTotal > 0) ? popTotal * CFG.POP_WATER_PER_UNIT : 0;
  const items = [];
  ['met', 'en', 'food', 'water'].forEach(function (k) {
    const r = rates[k] || 0; const u = upkeep[k] || 0;
    const popDrain = k === 'food' ? popFood : k === 'water' ? popWater : 0;
    const net = r - u - popDrain;
    if (!(r || u || popDrain)) return;
    let aux = '+' + fmtAbs(r) + ' prod / −' + fmtAbs(u) + ' uso';
    if (popDrain > 0) aux += ' / −' + fmtAbs(popDrain) + ' pop';
    items.push(row(resLabel(k), '<span class="rate ' + (net >= 0 ? 'rate--pos' : 'rate--neg') + '">' + fmtNet(net) + '</span> / ' + iU() + ' <span class="rate-aux">(' + aux + ')</span>'));
  });
  if (rates.research) items.push(row('Ricerca', '<span class="rate rate--pos">+' + (Math.round(rates.research * 100) / 100) + '</span> / ' + iU()));
  if (rates.scan) items.push(row('Scansione', '<span class="rate rate--pos">+' + rates.scan + '</span> / ' + iU()));
  if (!items.length) return '<p class="panel__note">Nessuna produzione: costruisci strutture estrattive.</p>';
  return '<dl class="sysinfo__list">' + items.join('') + '</dl>';
}

function advancedResHtml(planet, colony) {
  if (!planet.advanced.length) return '<p class="panel__note">Nessuna risorsa avanzata rilevata su ' + bodyKindDem(planet) + '.</p>';
  const known = colony.scanned.active;
  if (!known) {
    return '<p class="advanced-hint">⚛ <strong>' + planet.advanced.length + ' risorse avanzate</strong> presenti — identità da scansionare (costruisci un <em>osservatorio</em>).</p>';
  }
  const ADV = ORION.planet.ADVANCED;
  return '<ul class="adv-list">' + planet.advanced.map(function (a) {
    const def = ADV[a.id]; if (!def) return '';
    return '<li class="adv-item">' +
      '<span class="adv-item__glyph">' + def.glyph + '</span>' +
      '<span class="adv-item__name">' + def.label + '</span>' +
      '<div class="adv-item__bar"><div class="adv-item__fill" style="width:' + a.potential + '%"></div></div>' +
      '<span class="adv-item__val">' + a.potential + '</span>' +
    '</li>';
  }).join('') + '</ul>';
}

function bodyIsMoon(planet) { return planet && planet.type === 'luna'; }
function bodyKindGen(planet) { return bodyIsMoon(planet) ? 'della luna' : 'del pianeta'; }
function bodyKindDem(planet) { return bodyIsMoon(planet) ? 'questa luna' : 'questo pianeta'; }

function resLabel(k) { return { met: 'Metalli', en: 'Energia', food: 'Cibo', water: 'Acqua' }[k] || k; }
function resGlyph(k) { return { met: '⛭', en: '⚡', food: '❖', water: '≈' }[k] || '·'; }
/* Versione HTML con colore tematico per risorsa — usata in tutti i punti
   UI dove il glifo accompagna un valore (costi struttura/scafo/equipaggio,
   produzione, potenziali). Risolve l'incoerenza per cui ⛭ nello HUD top
   è ciano-accentuato mentre nei costi era plain text. Coerente col tema
   NASA/Visions (decisione #8): metalli=acciaio, energia=oro, cibo=verde,
   acqua=azzurro. */
function resIcon(k) {
  const g = resGlyph(k);
  return '<span class="res-icon res-icon--' + k + '" aria-hidden="true">' + g + '</span>';
}

/* Colore del pallino di un corpo per le chip della sidebar. */
function bodyDotColor(b) {
  const pal = ORION.system.BODY_TYPES[b.type].palette;
  if (pal.bands) return ORION.system.GAS_VARIANTS[b.variant || 0].base;
  return pal.land || pal.rock || '#9aa6cc';
}

/* ---------------------------------------------------------------------
   Decisione di sessione (action-confirm): preferenze giocatore + modale
   di conferma per le azioni costose/irreversibili. Toggle globale
   `orion.confirmActions` (default ON per nuovi utenti, persistito in
   localStorage). Alcune azioni "sempre confermate" ignorano il toggle
   (guerra, rottura alleanza, evacua, rilascia occupazione).
   --------------------------------------------------------------------- */
const PREFS_LS_KEY = 'orion.prefs';
const DEFAULT_PREFS = {
  confirmActions: true   // chiede conferma su build/demolisci/colonizza/...
};
ORION.prefs = Object.assign({}, DEFAULT_PREFS);

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_LS_KEY);
    if (raw) ORION.prefs = Object.assign({}, DEFAULT_PREFS, JSON.parse(raw));
    else ORION.prefs = Object.assign({}, DEFAULT_PREFS);
  } catch (_) { ORION.prefs = Object.assign({}, DEFAULT_PREFS); }
}
function savePrefs() {
  try { localStorage.setItem(PREFS_LS_KEY, JSON.stringify(ORION.prefs)); }
  catch (_) { /* private mode */ }
}
function isConfirmActionsOn() { return !!(ORION.prefs && ORION.prefs.confirmActions); }

/* confirmAction(opts) — apre la modale di conferma e chiama onConfirm
   se l'utente conferma. Se `force` è false E il toggle delle conferme
   è OFF, esegue subito onConfirm senza chiedere.
   opts: { title, message (html ok), confirmLabel, cancelLabel, danger,
           force, onConfirm } */
function confirmAction(opts) {
  opts = opts || {};
  if (!opts.force && !isConfirmActionsOn()) {
    if (typeof opts.onConfirm === 'function') opts.onConfirm();
    return;
  }
  const orig = document.querySelector('[data-bind="confirm-modal"]');
  if (!orig) { if (opts.onConfirm) opts.onConfirm(); return; }
  /* BUG FIX: ogni chiamata precedente aveva fatto host.addEventListener
     senza removeEventListener in close(), accumulando listener fantasma
     ognuno con un onConfirm/onCancel "vecchio" catturato per closure.
     Al click di "Conferma" tutti i listener accumulati facevano fuoco e
     ciascuno chiamava il proprio onConfirm → l'utente vedeva azioni che
     non aveva richiesto (es. click su "Costruisci Centrale" eseguiva la
     vecchia "Costruisci Miniera" tutta insieme).
     Soluzione doppia:
     (1) cloniamo il nodo per buttare via TUTTI i listener pre-esistenti
         (compresi quelli lasciati dal vecchio codice e quelli di possibili
         dialog aperti e mai chiusi correttamente);
     (2) nominiamo onClick/onKey e li rimuoviamo esplicitamente in close();
     (3) latch `consumed` come cintura+bretelle: anche se per qualche
         ragione un listener fantasma fosse sopravvissuto, l'onConfirm
         può scattare al massimo una volta per invocazione. */
  const host = orig.cloneNode(false);
  orig.parentNode.replaceChild(host, orig);
  const title = escapeHtml(opts.title || 'Confermi?');
  const message = opts.message || '';   // HTML consentito
  const confirmLabel = escapeHtml(opts.confirmLabel || 'Conferma');
  const cancelLabel = escapeHtml(opts.cancelLabel || 'Annulla');
  const danger = !!opts.danger;
  host.innerHTML =
    '<div class="confirm-modal__panel' + (danger ? ' is-danger' : '') + '">' +
      '<h3 class="confirm-modal__title">' + title + '</h3>' +
      '<div class="confirm-modal__body">' + message + '</div>' +
      '<div class="confirm-modal__actions">' +
        '<button class="btn btn--mini" data-confirm-action="cancel" type="button">' + cancelLabel + '</button>' +
        '<button class="btn btn--primary' + (danger ? ' btn--danger' : '') + '" data-confirm-action="ok" type="button">' + confirmLabel + '</button>' +
      '</div>' +
    '</div>';
  host.hidden = false;
  /* Focus iniziale sul Conferma per Enter veloce. */
  const okBtn = host.querySelector('[data-confirm-action="ok"]');
  if (okBtn) setTimeout(function () { okBtn.focus(); }, 0);

  let consumed = false;
  function close() {
    host.hidden = true;
    host.innerHTML = '';
    document.removeEventListener('keydown', onKey, true);
    host.removeEventListener('click', onClick);
  }
  function onKey(e) {
    if (consumed) return;
    if (e.key === 'Escape') { consumed = true; e.preventDefault(); close(); if (opts.onCancel) opts.onCancel(); }
    else if (e.key === 'Enter') { consumed = true; e.preventDefault(); close(); if (opts.onConfirm) opts.onConfirm(); }
  }
  function onClick(e) {
    if (consumed) return;
    if (e.target === host) { consumed = true; close(); if (opts.onCancel) opts.onCancel(); return; }
    const btn = e.target.closest && e.target.closest('[data-confirm-action]');
    if (!btn) return;
    if (btn.dataset.confirmAction === 'ok') { consumed = true; close(); if (opts.onConfirm) opts.onConfirm(); }
    else { consumed = true; close(); if (opts.onCancel) opts.onCancel(); }
  }
  document.addEventListener('keydown', onKey, true);
  host.addEventListener('click', onClick);
}

/* --- Modale Preferenze --- */
function openPrefsModal() {
  const host = document.querySelector('[data-bind="prefs-modal"]');
  if (!host) return;
  const checked = isConfirmActionsOn() ? 'checked' : '';
  host.innerHTML =
    '<div class="prefs-modal__panel">' +
      '<header class="prefs-modal__header">' +
        '<h2 class="prefs-modal__title">Preferenze giocatore</h2>' +
        '<button class="btn btn--mini btn--icon-only" data-action="prefs-close" type="button" aria-label="Chiudi">' +
          '<span class="ui-icon" data-icon="close" aria-hidden="true"></span>' +
        '</button>' +
      '</header>' +
      '<div class="prefs-modal__body">' +
        '<label class="prefs-row">' +
          '<input type="checkbox" data-pref="confirmActions" ' + checked + '> ' +
          '<span class="prefs-row__label">Chiedi conferma sulle azioni</span>' +
          '<span class="prefs-row__hint">Costruzioni, espansioni, demolizioni, ordini di flotta, ' +
          'commercio. Alcune azioni con effetti pesanti (dichiara guerra, evacua colonia) ' +
          'chiedono comunque conferma anche se questa opzione è disattiva.</span>' +
        '</label>' +
      '</div>' +
    '</div>';
  host.hidden = false;
  if (typeof ORION.injectStaticSvgIcons === 'function') ORION.injectStaticSvgIcons(host);

  host.querySelector('input[data-pref="confirmActions"]').addEventListener('change', function (e) {
    ORION.prefs.confirmActions = !!e.target.checked;
    savePrefs();
  });
  host.querySelector('[data-action="prefs-close"]').addEventListener('click', closePrefsModal);
  host.addEventListener('click', function (e) {
    if (e.target === host) closePrefsModal();
  });
  document.addEventListener('keydown', function escClose(e) {
    if (e.key === 'Escape') { closePrefsModal(); document.removeEventListener('keydown', escClose, true); }
  }, true);
}
function closePrefsModal() {
  const host = document.querySelector('[data-bind="prefs-modal"]');
  if (host) { host.hidden = true; host.innerHTML = ''; }
}

function initPrefsControls() {
  loadPrefs();
  const btn = document.querySelector('[data-action="open-prefs"]');
  if (btn) btn.addEventListener('click', openPrefsModal);
}

/* ---------------------------------------------------------------------
   M05 — Controllo del tempo (GDD §4.3)
   Decisione #31: l'utente non clicca più "+N Impulsi" — accende il timer
   (▶) e il tempo scorre automaticamente, con auto-pausa su ogni evento
   notevole (decisione #31 trigger list). Il loop discreto Impulso-per-
   Impulso (M05) NON è toccato: l'auto-advance chiama runAdvance(1) per
   tick — il determinismo (decisione #5/#22) resta intatto.
   --------------------------------------------------------------------- */
const PLAY_LEVELS = [0.5, 1, 2, 4, 8, 16, 32];   // 7 livelli #31
const PLAY_BASE_SEC = 30;                         // 1× = 30 secondi reali / Ι
const PLAY_ANIM_THRESHOLD = 3.0;                  // animazione DS sotto 3s/Ι disattivata
const PLAY_DEFAULT_LEVEL = 1;                     // default: 1× (30s/Ι)
const PLAY_LS_LEVEL  = 'orion.playSpeed';
const PLAY_LS_PAUSES = 'orion.autopause';
const DEFAULT_AUTOPAUSE = {
  'build-done': true, 'demolish-done': true, 'downgrade-done': true, 'colony-done': true, 'scan-done': true,
  'scarcity': true, 'scarcity-recover': true, 'pop-loss': true,
  /* Decisione #48 (Fase 0): la saturazione rifiuti (saturo/critico) merita
     una pausa — è il nudge per agire prima del deperimento. Il rientro è
     buona notizia, non interrompe. */
  'waste': true, 'waste-recover': false,
  'victory': true, 'settle-stage': true, 'settle-done': true,
  /* M07 (decisione #37): pausa solo su esiti notevoli. Non su launch
     (azione utente), né su ship-built/crew-formed (frequenti). */
  'expedition-arrived': true, 'expedition-ship-lost': true, 'expedition-discovery': true,
  /* Decisione #41: cronaca info quando una nave rientra a porto saturo
     (in orbita parcheggio). Default OFF: è un'informazione, non un evento
     critico. L'utente può accenderla dall'overlay. */
  'expedition-dock-overflow': false,
  /* M07.1 (decisione #40): le 2 segnalazioni urgenti del Governatore
     si auto-pausano (carenze in arrivo e coda ferma da troppo); le 3
     strategiche (slot liberi, pop vicina al tetto, veterani inattivi)
     restano in cronaca senza interrompere il gioco. L'utente può
     spegnere ognuna dall'overlay di pausa. */
  'gov-supply-falling': true, 'gov-queue-empty': true,
  'gov-slots-idle': false, 'gov-pop-near-cap': false, 'gov-veterans-idle': false,
  /* M07.1 Tier 2 (decisione #59): azioni del Governatore (build/espande).
     Default OFF: frequenti/atmosferiche, visibili in cronaca + log dedicato. */
  'gov-build-started': false, 'gov-expand-started': false,
  /* M08 Fase A (decisione #42): arrivo flotta + rotta completata + scoperta
     fortuita auto-pausano (esiti notevoli). Il launch è azione utente,
     non sorpresa. Hop intermedi mai. */
  'fleet-arrived': true, 'fleet-route-complete': true, 'fleet-discovery': true,
  'fleet-launched': false, 'fleet-leg-hop': false,
  /* Fase B (decisione #46): tappa intermedia raggiunta. Default OFF —
     non interrompiamo a ogni waypoint, può essere una rotta lunga. L'arrivo
     finale e la `route-complete` continuano a fermare il tempo. */
  'fleet-waypoint-reached': false,
  /* Decisione #43 (M07.2): nascita di un Comandante nominato — evento
     narrativo forte (nuova figura giocabile), auto-pausa di default. */
  'commander-promoted': true,
  /* Decisione #45: eventi rari capitale di gruppo, sempre notevoli. */
  'capital-declared': true,
  'capital-transition-end': true,
  'capital-decommissioned': true,
  /* M10 Fase A (decisione #47): primo contatto, caduta e nascita di una
     civiltà sono notevoli → auto-pausa ON. Espansioni/guerre/razzie sono
     "voci di cronaca" atmosferiche e frequenti → OFF (niente interruzioni). */
  /* M10 Fase B punto 2 (decisione #52 §13.10): "Avvistata" è il grado
     atmosferico che precede il primo contatto. OFF di default — basta che
     compaia in cronaca senza interrompere; il vero contatto (`civ-contact`)
     resta auto-pausa ON. */
  'civ-spotted': false,
  'civ-contact': true,
  'civ-fallen': true,
  'civ-emerged': true,
  'civ-expand': false,
  'civ-war': false,
  'civ-battle': false,
  'pirate-raid': false,
  /* M10 Fase E: covo sgominato = notevole (ON); raid parziale OFF (frequente).
     Raider in arrivo + esito = notevoli (la tua flotta è sotto attacco). */
  'pirate-cleared': true,
  'pirate-raid-won': false,
  'raider-inbound': true,
  'raider-hit': true,
  'raider-fizzle': false,
  /* M09 Fase A (decisione #49): il combattimento è notevole → auto-pausa ON.
     L'incursione inbound è il PREAVVISO; l'assedio si auto-pausa a ogni round
     per dare la finestra di reazione (rinforza/ritira/tributo). */
  'incursion-inbound': true,
  'siege-begin': true,
  'siege-round': true,
  'siege-end': true,
  'battle-skirmish': true,
  'colony-looted': true,
  /* M09 Fase B: la spirale C — perdita/conquista di colonie, esilio,
     imboscata in rotta: tutti notevoli → auto-pausa ON. */
  'colony-conquered': true,
  'colony-razed': true,
  'empire-fallen': true,
  'fleet-intercepted': true,
  /* M11 Fase A (decisione #51): le transizioni diplomatiche sono atti
     dell'utente (proposte) → niente auto-pausa sulle proprie azioni. La
     scadenza di una tregua → guerra è invece una sorpresa rilevante. */
  'diplo-war': false, 'diplo-peace': false, 'diplo-alliance': false,
  'diplo-alliance-broken': false, 'diplo-rejected': false,
  'diplo-truce-expired': true,
  /* M11 Fase B parziale: dispacci AI proattivi e occupazioni di sistemi.
     Le offerte AI sono SORPRESE rilevanti (finestra di tempo per rispondere)
     → auto-pausa ON. Scadenza/rifiuto sono atmosferici → OFF. L'occupazione
     di un sistema AI è un atto geopolitico forte → ON. */
  'diplo-offer': true,
  'diplo-offer-expired': false,
  'diplo-offer-rejected': false,
  'system-occupied': true,
  'system-released': false,
  /* M10 Fase B (decisione #52 §13.6/§13.8): la coesione di sistema è
     atmosferica (consorzio locale che si forma o si scioglie ai confini) →
     OFF di default. Le federazioni emergenti, invece, sono eventi geopolitici
     forti (nuova entità composita o sua rottura) → ON. */
  'system-cohesion-formed': false,
  'system-cohesion-broken': false,
  'federation-formed': true,
  'federation-broken': true,
  /* M12 Fase A1 (decisione #53): eventi commercio. Tutti OFF di default —
     frequenti/atmosferici e recovery-friendly (le interruzioni rotta
     ripartono da sole). L'utente può accenderli dall'overlay. */
  'mercantile-built': false, 'mercantile-promoted': false,
  'trade-route-interrupted': false, 'trade-route-resumed': false,
  'trade-route-closed': false,
  /* §15.7 (Fase B): razzia sulla rotta = frequente/atmosferica → OFF; la
     perdita del mercantile è notevole → ON. */
  'trade-raid': false, 'trade-mercantile-lost': true,
  /* M12 Fase A2 (§15.3): accordi commerciali AI. Tutti OFF (atmosferici,
     recovery-friendly: le sospensioni riprendono da sole). */
  'agreement-suspended': false, 'agreement-resumed': false, 'agreement-ended': false
};

ORION.timer = {
  playing: false,
  level: PLAY_DEFAULT_LEVEL,
  intervalId: null,
  rafId: null,
  lastTickReal: 0,        // performance.now() dell'ultimo tick (per interpolazione)
  pauses: null            // caricato da localStorage
};

function loadTimerPrefs() {
  try {
    const lv = parseFloat(localStorage.getItem(PLAY_LS_LEVEL));
    if (lv && PLAY_LEVELS.indexOf(lv) >= 0) ORION.timer.level = lv;
    const ap = localStorage.getItem(PLAY_LS_PAUSES);
    ORION.timer.pauses = ap ? Object.assign({}, DEFAULT_AUTOPAUSE, JSON.parse(ap))
                            : Object.assign({}, DEFAULT_AUTOPAUSE);
  } catch (_) {
    ORION.timer.pauses = Object.assign({}, DEFAULT_AUTOPAUSE);
  }
}
function saveTimerPrefs() {
  try {
    localStorage.setItem(PLAY_LS_LEVEL, String(ORION.timer.level));
    localStorage.setItem(PLAY_LS_PAUSES, JSON.stringify(ORION.timer.pauses));
  } catch (_) { /* private mode */ }
}

function secPerImpulse(level) {
  /* 1× = 30s/Ι, gli altri livelli scalano linearmente: secPerI = 30/level */
  return PLAY_BASE_SEC / (level || 1);
}
function timerLabel() {
  const l = ORION.timer.level;
  const s = secPerImpulse(l);
  /* Arrotondamento a intero: la precisione esatta non conta, l'utente
     vede il ritmo (60/30/15/8/4/2/1 sui 7 livelli). Min 1s per non
     mostrare "0s" a velocità estreme. */
  const sStr = Math.max(1, Math.round(s)) + 's';
  return l + '× · ' + sStr + '/Ι';
}

function initTimeControls() {
  loadTimerPrefs();
  document.addEventListener('click', function (e) {
    const btn = e.target.closest && e.target.closest('[data-action]');
    if (!btn) return;
    const act = btn.dataset.action;
    if (act === 'play-toggle')      togglePlay();
    else if (act === 'play-faster') changeSpeed(+1);
    else if (act === 'play-slower') changeSpeed(-1);
    else if (act === 'play-step')   { stopPlay(); runAdvance(1); }
    else if (act === 'advance-to-event') { stopPlay(); runAdvance(null); }
  });
  /* Shortcuts globali (decisione #31): Space play/pause · → singolo Ι ·
     E prossimo evento. Ignorati su input/textarea.
     +/- rimossi: confliggevano con Ctrl + +/- (zoom browser). */
  document.addEventListener('keydown', function (e) {
    if (!ORION.game) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.target.isContentEditable) return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); stopPlay(); runAdvance(1); }
    else if (e.key === 'e' || e.key === 'E') { e.preventDefault(); stopPlay(); runAdvance(null); }
  });
  renderTimeControls();
  updateTimeControlsHint();
}

function changeSpeed(delta) {
  const idx = PLAY_LEVELS.indexOf(ORION.timer.level);
  const next = Math.max(0, Math.min(PLAY_LEVELS.length - 1, (idx < 0 ? 1 : idx) + delta));
  ORION.timer.level = PLAY_LEVELS[next];
  saveTimerPrefs();
  if (ORION.timer.playing) { stopPlay(); startPlay(); }   // riallinea l'intervallo
  renderTimeControls();
}

function togglePlay() {
  if (!ORION.game) return;
  if (ORION.timer.playing) stopPlay(); else startPlay();
}
function startPlay() {
  if (!ORION.game || ORION.timer.playing) return;
  ORION.timer.playing = true;
  ORION.timer.lastTickReal = performance.now();
  const ms = Math.max(100, secPerImpulse(ORION.timer.level) * 1000);
  ORION.timer.intervalId = setInterval(playTick, ms);
  startDateInterpolation();
  renderTimeControls();
}
function stopPlay() {
  if (!ORION.timer.playing) return;
  ORION.timer.playing = false;
  if (ORION.timer.intervalId) { clearInterval(ORION.timer.intervalId); ORION.timer.intervalId = null; }
  stopDateInterpolation();
  renderTimeControls();
  /* Snap finale alla DS reale (interpolazione spenta) */
  if (ORION.game) setHudDate(ORION.time.currentDS(ORION.game));
}
function playTick() {
  if (!ORION.game) { stopPlay(); return; }
  ORION.timer.lastTickReal = performance.now();
  /* Avanza 1 Ι: stesso loop di `runAdvance(1)`, ma controlliamo gli eventi
     per decidere se l'utente vuole essere fermato. */
  const res = runAdvance(1);
  if (res && res.events && shouldAutoPause(res.events)) {
    stopPlay();
    showEventOverlay(res.events);
  }
}
function shouldAutoPause(events) {
  if (!events || !events.length) return false;
  const prefs = ORION.timer.pauses || DEFAULT_AUTOPAUSE;
  for (let i = 0; i < events.length; i++) {
    if (prefs[events[i].kind]) return true;
  }
  return false;
}

/* Animazione B (decisione #31): tra un tick e l'altro, la DS in HUD
   scorre liscia con requestAnimationFrame. Disattivata sotto 3s/Ι. */
function startDateInterpolation() {
  stopDateInterpolation();
  if (secPerImpulse(ORION.timer.level) < PLAY_ANIM_THRESHOLD) return;
  function frame() {
    if (!ORION.timer.playing) return;
    const g = ORION.game;
    if (!g) return;
    const ms = secPerImpulse(ORION.timer.level) * 1000;
    const elapsed = performance.now() - ORION.timer.lastTickReal;
    const frac = Math.max(0, Math.min(0.999, elapsed / ms));
    const base = g.timeImpulsi || 0;
    /* mostra l'Ι "in transito": la cifra Ι scorre verso la successiva */
    setHudDate(ORION.time.format(base + Math.floor(frac), 'compact'));
    ORION.timer.rafId = requestAnimationFrame(frame);
  }
  ORION.timer.rafId = requestAnimationFrame(frame);
}
function stopDateInterpolation() {
  if (ORION.timer.rafId) { cancelAnimationFrame(ORION.timer.rafId); ORION.timer.rafId = null; }
}

/* ---------------------------------------------------------------
   Animazione del contatore popolazione (fix scalini, stile #31).
   Il motore aggiorna pop.total a fine batch; qui il numero MOSTRATO
   scorre con easing verso il bersaglio invece di scattare. Un solo
   rAF globale anima tutti gli span [data-pop-key] presenti nel DOM:
   legge il bersaglio da data-pop-target e tiene il valore "mostrato"
   in ORION._popAnim.shown[key] (numerico — formatPeople è lossy, non
   si può rileggere dal testo). Auto-stop quando tutti raggiungono il
   target. Indipendente dal play-timer: vale anche per il +1 manuale. */
ORION._popAnim = ORION._popAnim || { shown: {}, rafId: null };

function popAnimSpan(key, people, extraClass) {
  const a = ORION._popAnim;
  if (a.shown[key] == null) a.shown[key] = people;   // prima volta: niente animazione da 0
  return '<span class="pop-anim' + (extraClass ? ' ' + extraClass : '') + '" data-pop-key="' +
    escapeHtml(key) + '" data-pop-target="' + people + '">' +
    escapeHtml(ORION.planet.formatPeople(a.shown[key])) + '</span>';
}
ORION.popAnimSpan = popAnimSpan;

function popAnimFrame() {
  const a = ORION._popAnim;
  const els = document.querySelectorAll('.pop-anim[data-pop-key]');
  let active = false;
  els.forEach(function (el) {
    const key = el.getAttribute('data-pop-key');
    const target = parseFloat(el.getAttribute('data-pop-target')) || 0;
    let shown = a.shown[key];
    if (shown == null) shown = target;
    const tol = Math.max(1, target * 0.002);
    if (Math.abs(shown - target) > tol) {
      shown = shown + (target - shown) * 0.14;       // approccio esponenziale ~liscio
      if (Math.abs(shown - target) <= tol) shown = target;
      a.shown[key] = shown;
      el.textContent = ORION.planet.formatPeople(shown);
      active = true;
    } else {
      a.shown[key] = target;
    }
  });
  a.rafId = active ? requestAnimationFrame(popAnimFrame) : null;
}
function ensurePopAnim() {
  const a = ORION._popAnim;
  if (!a.rafId) a.rafId = requestAnimationFrame(popAnimFrame);
}
ORION.ensurePopAnim = ensurePopAnim;

/* Disegna i 5 controlli compatti (decisione #31) nella barra HUD. */
function renderTimeControls() {
  const host = document.querySelector('[data-bind="time-controls"]');
  if (!host) return;
  const playing = ORION.timer.playing;
  /* PR-E: SVG icons per i 5 controlli tempo (UI_GUIDE §3). Tinte:
     play/pause/step = ciano (azioni temporali); skipNext = oro (evento
     notevole). */
  const playSvg  = uiIcon(playing ? 'pause' : 'play', 'cyan');
  const stepSvg  = uiIcon('step', 'cyan');
  const eventSvg = uiIcon('skipNext', 'gold');
  const label = timerLabel();
  const idx = PLAY_LEVELS.indexOf(ORION.timer.level);
  const atMin = idx <= 0, atMax = idx >= PLAY_LEVELS.length - 1;
  host.innerHTML =
    '<button class="btn btn--mini btn--play-step" data-action="play-slower" type="button"' +
    (atMin ? ' disabled' : '') + ' title="Rallenta (-)">−</button>' +
    '<button class="btn btn--play" data-action="play-toggle" type="button" title="Play/Pause (Space)">' +
      '<span class="btn__glyph">' + playSvg + '</span>' +
      '<span class="btn__label">' + escapeHtml(label) + '</span>' +
    '</button>' +
    '<button class="btn btn--mini btn--play-step" data-action="play-faster" type="button"' +
    (atMax ? ' disabled' : '') + ' title="Accelera (+)">+</button>' +
    '<button class="btn btn--mini" data-action="play-step" type="button" title="Singolo Impulso (→)">' +
      '<span class="btn__glyph">' + stepSvg + '</span>' +
    '</button>' +
    '<button class="btn btn--primary btn--next-event" data-action="advance-to-event" type="button" title="Prossimo evento (E)">' +
      '<span class="btn__glyph">' + eventSvg + '</span>' +
      '<span class="btn__label">Evento</span>' +
      '<span class="time-control__delta" data-bind="event-delta">+— Ι</span>' +
    '</button>';
}

/* Overlay di auto-pausa: lista degli eventi che hanno scatenato lo stop +
   bottoni "Riprendi" e "Non pausare più su [tipo]". Decisione #31. */
function showEventOverlay(events) {
  const host = document.querySelector('[data-bind="event-overlay"]');
  if (!host || !events || !events.length) return;
  /* Mostra solo gli eventi che hanno fatto scattare la pausa (quelli con
     pref true). Riusa le stringhe della cronaca per coerenza. */
  const prefs = ORION.timer.pauses || DEFAULT_AUTOPAUSE;
  const triggered = events.filter(function (e) { return prefs[e.kind]; });
  const KIND_LABELS = {
    'build-done': 'Completamento struttura',
    'demolish-done': 'Smantellamento completato',
    'downgrade-done': 'Modulo smantellato',
    'colony-done': 'Nuova colonia',
    'scan-done': 'Scansione completata',
    'scarcity': 'Carenza',
    'scarcity-recover': 'Carenza rientrata',
    'waste': 'Rifiuti: saturazione',
    'waste-recover': 'Rifiuti: rientrata',
    'pop-loss': 'Calo popolazione',
    'victory': 'Pista chiusa',
    'settle-stage': 'Fase Insediamento',
    'settle-done': 'Insediamento completato',
    'expedition-arrived': 'Spedizione: sistema esplorato',
    'expedition-ship-lost': 'Spedizione: scafo perso',
    'expedition-discovery': 'Spedizione: scoperta fortuita',
    'expedition-dock-overflow': 'Hangar: nave in orbita parcheggio',
    'gov-queue-empty': 'Governatore: coda di costruzione ferma',
    'gov-slots-idle': 'Governatore: slot inutilizzati',
    'gov-pop-near-cap': 'Governatore: popolazione vicina al tetto',
    'gov-supply-falling': 'Governatore: stock in calo',
    'gov-veterans-idle': 'Governatore: veterani disponibili',
    'gov-build-started': 'Governatore: nuova costruzione accodata',
    'gov-expand-started': 'Governatore: espansione accodata',
    'fleet-arrived': 'Flotta arrivata',
    'fleet-route-complete': 'Flotta: rotta completata',
    'fleet-discovery': 'Flotta: sistema esplorato',
    'fleet-launched': 'Flotta: salto iperspaziale',
    'fleet-leg-hop': 'Flotta: hop intermedio',
    'fleet-waypoint-reached': 'Flotta: tappa raggiunta',
    'commander-promoted': 'Nuovo Comandante nominato',
    'capital-declared': 'Capitale di gruppo dichiarata',
    'capital-transition-end': 'Capitale entrata in carica',
    'capital-decommissioned': 'Vecchia capitale decommissionata',
    'civ-spotted': 'Civiltà avvistata',
    'civ-contact': 'Primo contatto con una civiltà',
    'civ-expand': 'Civiltà AI: espansione',
    'civ-war': 'Guerra tra civiltà',
    'civ-battle': 'Battaglia tra civiltà (vista)',
    'civ-fallen': 'Civiltà caduta',
    'civ-emerged': 'Nuova civiltà emersa',
    'pirate-raid': 'Razzia pirata',
    'pirate-cleared': 'Covo pirata sgominato',
    'pirate-raid-won': 'Covo pirata colpito',
    'raider-inbound': 'Predoni in rotta sulla tua flotta',
    'raider-hit': 'La tua flotta sotto attacco pirata',
    'raider-fizzle': 'Predoni a vuoto',
    'incursion-inbound': 'Incursione pirata in arrivo',
    'siege-begin': 'Assedio iniziato',
    'siege-round': 'Assedio: round',
    'siege-end': 'Assedio concluso',
    'battle-skirmish': 'Scontro nello spazio',
    'colony-looted': 'Colonia saccheggiata',
    'colony-conquered': 'Colonia conquistata',
    'colony-razed': 'Colonia rasa al suolo',
    'empire-fallen': 'Civiltà caduta',
    'fleet-intercepted': 'Flotta intercettata',
    'diplo-war': 'Guerra dichiarata',
    'diplo-peace': 'Pace stipulata',
    'diplo-alliance': 'Alleanza stretta',
    'diplo-alliance-broken': 'Alleanza rotta',
    'diplo-rejected': 'Proposta respinta',
    'diplo-truce-expired': 'Tregua scaduta',
    'diplo-offer': 'Dispaccio AI',
    'diplo-offer-expired': 'Offerta AI scaduta',
    'diplo-offer-rejected': 'Offerta AI rifiutata',
    'system-occupied': 'Sistema occupato',
    'system-released': 'Occupazione abbandonata',
    'system-cohesion-formed': 'Sistema coeso (consorzio formato)',
    'system-cohesion-broken': 'Sistema coeso: dissolto',
    'federation-formed': 'Federazione emergente',
    'federation-broken': 'Federazione dissolta',
    'mercantile-built': 'Mercantile varato',
    'mercantile-promoted': 'Mercantile promosso',
    'trade-route-interrupted': 'Rotta commerciale interrotta',
    'trade-route-resumed': 'Rotta commerciale ripresa',
    'trade-route-closed': 'Rotta commerciale chiusa',
    'trade-raid': 'Razzia pirata su rotta',
    'trade-mercantile-lost': 'Mercantile perso',
    'agreement-suspended': 'Accordo commerciale sospeso',
    'agreement-resumed': 'Accordo commerciale ripreso',
    'agreement-ended': 'Accordo commerciale concluso'
  };
  /* Raggruppa per kind: una checkbox per categoria, una sola voce di sintesi. */
  const byKind = {};
  triggered.forEach(function (e) { (byKind[e.kind] = byKind[e.kind] || []).push(e); });
  const pauseIcon = (ORION.icon && ORION.icon('warning')) || '';
  let html = '<div class="event-overlay__panel" role="alertdialog" aria-label="Evento — tempo in pausa">' +
    '<h3 class="event-overlay__title">' +
      '<span class="ui-icon ui-icon--gold event-overlay__title-icon" aria-hidden="true">' + pauseIcon + '</span> ' +
      'Tempo in pausa' +
    '</h3>' +
    '<ul class="event-overlay__list">';
  Object.keys(byKind).forEach(function (kind) {
    const list = byKind[kind];
    const lbl = KIND_LABELS[kind] || kind;
    html += '<li class="event-overlay__item">' +
      '<div class="event-overlay__row">' +
        '<span class="event-overlay__kind">' + escapeHtml(lbl) + '</span>' +
        '<span class="event-overlay__count">' + list.length + '×</span>' +
      '</div>' +
      '<label class="event-overlay__pref">' +
        '<input type="checkbox" data-pause-kind="' + kind + '"> ' +
        'Non fermare più su questo' +
      '</label>' +
    '</li>';
  });
  html += '</ul>' +
    '<div class="event-overlay__actions">' +
      '<button class="btn btn--mini" data-action="event-close" type="button">Chiudi</button>' +
      '<button class="btn btn--primary" data-action="event-resume" type="button">▶ Riprendi</button>' +
    '</div>' +
  '</div>';
  host.innerHTML = html;
  host.hidden = false;
  /* Handlers */
  host.querySelector('[data-action="event-resume"]').addEventListener('click', function () {
    applyEventOverlayPrefs(host);
    hideEventOverlay();
    startPlay();
  });
  host.querySelector('[data-action="event-close"]').addEventListener('click', function () {
    applyEventOverlayPrefs(host);
    hideEventOverlay();
  });
}
function applyEventOverlayPrefs(host) {
  host.querySelectorAll('input[data-pause-kind]').forEach(function (cb) {
    if (cb.checked) ORION.timer.pauses[cb.dataset.pauseKind] = false;
  });
  saveTimerPrefs();
}
function hideEventOverlay() {
  const host = document.querySelector('[data-bind="event-overlay"]');
  if (host) { host.hidden = true; host.innerHTML = ''; }
}

/* Esegue un avanzamento, traduce gli eventi in cronaca, aggiorna HUD/UI.
   Ritorna { events, impulsi } per consentire all'auto-advance di valutare
   gli eventi e decidere se fermarsi (decisione #31). */
function runAdvance(impulsi) {
  const g = ORION.game;
  if (!g) return null;
  /* M06.6: tutorial — primo avanzamento del tempo. */
  if (ORION.tutorial) ORION.tutorial.fire('advance');
  const before = g.timeImpulsi || 0;
  const res = (impulsi == null) ? ORION.time.advanceToNextEvent() : ORION.time.advance(impulsi);
  const after = g.timeImpulsi || 0;
  if (after === before) return res;

  if (res.events && res.events.length) {
    res.events.forEach(function (ev) { chronicleEvent(ev); });
  }
  setHudDate(ORION.time.currentDS(g));
  /* La pulse marca lo "snap a fine batch" (decisione M05). In auto-advance
     a 1 Ι/tick farebbe lampeggiare a ogni step — invadente. La saltiamo
     se il timer sta girando e l'animazione DS è attiva (sopra 3s/Ι). */
  const skipPulse = ORION.timer && ORION.timer.playing &&
                    secPerImpulse(ORION.timer.level) >= PLAY_ANIM_THRESHOLD;
  if (!skipPulse) pulseHud();
  /* M07.3 (decisione #62): un rilevamento di telemetria per batch, prima
     del refresh dell'HUD (così la Dashboard mostra l'ultimo punto). */
  sampleEmpireTelemetry();
  updateGlobalResourceHud();
  if (ORION.openPlanetKey) updatePlanetUI();
  updateTimeControlsHint();
  persistGame(g);
  /* Rilancia l'animazione DS dal tick corrente (ricomincia da Ι appena maturato) */
  if (ORION.timer && ORION.timer.playing) {
    ORION.timer.lastTickReal = performance.now();
  }
  return res;
}

function chronicleEvent(ev) {
  const ds = ORION.time.format(ev.impulso);
  const pname = (ev.planet && ev.planet.name) || '—';
  // Decisione #26: aggiungiamo il tag di appartenenza accanto al nome
  // del pianeta nelle voci di cronaca, così "Zaffiro" diventa subito
  // riconducibile a "Vega II nella regione VLV".
  const sysId = (ev.colony && typeof ev.colony.systemId === 'number') ? ev.colony.systemId
              : (ev.planet && typeof ev.planet.systemId === 'number') ? ev.planet.systemId
              : -1;
  const ptag = sysId >= 0 ? bodyTagHtml(sysId) : '';
  if (ev.kind === 'build-done') {
    pushChronicle(ds + ' — <strong>' + ev.structName + '</strong> operativa su ' + pname + ptag + '.', 'planet');
  } else if (ev.kind === 'demolish-done') {
    const refundPct = Math.round((ev.refundRate || 0) * 100);
    pushChronicle(ds + ' — <strong>' + ev.structName + '</strong> smantellata su ' + pname + ptag + ' (rimborso ' + refundPct + '%, morale −0,10 per 30 Ι).', 'planet');
  } else if (ev.kind === 'downgrade-done') {
    const refundPct = Math.round((ev.refundRate || 0) * 100);
    pushChronicle(ds + ' — <strong>' + ev.structName + '</strong> ridotta a livello ' + ev.toLevel + ' su ' + pname + ptag + ' (rimborso ' + refundPct + '% dello step lvl ' + ev.fromLevel + ', morale −0,10 per 30 Ι).', 'planet');
  } else if (ev.kind === 'colony-done') {
    pushChronicle(ds + ' — Nuova colonia attiva su <strong>' + pname + '</strong>' + ptag + '.', 'planet');
  } else if (ev.kind === 'scan-done') {
    const n = (ev.planet && ev.planet.advanced) ? ev.planet.advanced.length : 0;
    pushChronicle(ds + ' — Osservatorio di ' + pname + ptag + ': scansione completata, ' + n + ' risorse avanzate rivelate.', 'explore');
  } else if (ev.kind === 'scarcity') {
    const RES = { met: 'metalli', en: 'energia', food: 'cibo', water: 'acqua' };
    const sev = ev.sev === 'crit' ? 'critica' : 'in allerta';
    pushChronicle(ds + ' — ' + pname + ptag + ': carenza ' + sev + ' di <strong>' + RES[ev.res] + '</strong>.', 'system');
    /* M06.6: tutorial — prima volta che vediamo una carenza (low o crit). */
    if (ORION.tutorial) ORION.tutorial.fire('scarcity');
  } else if (ev.kind === 'scarcity-recover') {
    const RES = { met: 'metalli', en: 'energia', food: 'cibo', water: 'acqua' };
    pushChronicle(ds + ' — ' + pname + ptag + ': situazione <strong>' + RES[ev.res] + '</strong> rientrata.', 'system');
  } else if (ev.kind === 'waste') {
    /* Decisione #48 (Fase 0): saturazione rifiuti. */
    const sev = ev.sev === 'critico' ? 'critica (produzione in deperimento)' : 'satura';
    pushChronicle(ds + ' — ' + pname + ptag + ': gestione rifiuti <strong>' + sev + '</strong>.', 'system');
    if (ORION.tutorial) ORION.tutorial.fire('waste');
  } else if (ev.kind === 'waste-recover') {
    pushChronicle(ds + ' — ' + pname + ptag + ': saturazione rifiuti <strong>rientrata</strong>.', 'system');
  } else if (ev.kind === 'pop-loss') {
    pushChronicle(ds + ' — ' + pname + ptag + ': la popolazione cala per la carestia prolungata.', 'system');
  } else if (ev.kind === 'victory') {
    const label = (ORION.victory && ORION.victory.TRACK_LABELS[ev.track]) || ev.track;
    pushChronicle(ds + ' — <strong>Pista chiusa</strong>: ' + label + '.', 'explore');
  } else if (ev.kind === 'settle-stage') {
    /* M06.5 (decisione #27): voci scriptate della fase Insediamento. */
    const stage = ev.stage;
    let txt;
    if (stage === 'landing')       txt = 'Atterraggio dei moduli avanguardia su <strong>' + pname + '</strong>.';
    else if (stage === 'founding') txt = 'Fondazione di <strong>' + pname + '</strong>.';
    else /* civic */               txt = 'Primi insediamenti civili su <strong>' + pname + '</strong>.';
    pushChronicle(ds + ' — ' + txt, 'planet');
  } else if (ev.kind === 'settle-done') {
    pushChronicle(ds + ' — Insediamento completato — la colonia di <strong>' + pname + '</strong> è operativa.', 'planet');
  } else if (ev.kind === 'ship-built') {
    /* M08 Fase A: nome della classe dalla classe vera. */
    const sk = ev.shipKind || 'explorer';
    const scls = (ORION.fleet && ORION.fleet.getClass(sk)) || { name: 'scafo esploratore' };
    pushChronicle(ds + ' — Nuova <strong>' + scls.name + '</strong> pronta al varo su ' + pname + ptag + '.', 'planet');
  } else if (ev.kind === 'crew-formed') {
    pushChronicle(ds + ' — Nuovo <strong>equipaggio esploratore</strong> brevettato dall\'Accademia di ' + pname + ptag + '.', 'planet');
  } else if (ev.kind === 'mercantile-built') {
    /* M12 Fase A1: mercantile varato dall'Hangar. */
    const t = (ORION.trade && ORION.trade.getTier(ev.tier)) || { name: 'mercantile' };
    pushChronicle(ds + ' — Nuovo <strong>' + escapeHtml(t.name) + '</strong> pronto al varo su ' + pname + ptag + '.', 'planet');
    if (ORION.tutorial) ORION.tutorial.fire('mercantili');
  } else if (ev.kind === 'mercantile-promoted') {
    pushChronicle(ds + ' — Un mercantile del consorzio sale al rango <strong>' + escapeHtml(ev.rank) + '</strong> dopo le rotte percorse.', 'planet');
  } else if (ev.kind === 'trade-route-interrupted') {
    const why = ev.reason === 'interrupted-route' ? 'transito ostile' : 'sorgente esaurita';
    pushChronicle(ds + ' — Rotta ' + colonyNameFromKey(ev.src) + ' → ' + colonyNameFromKey(ev.dst) + ' <strong>interrotta</strong> (' + why + ').', 'system');
  } else if (ev.kind === 'trade-route-resumed') {
    pushChronicle(ds + ' — Rotta ' + colonyNameFromKey(ev.src) + ' → ' + colonyNameFromKey(ev.dst) + ' di nuovo <strong>operativa</strong>.', 'system');
  } else if (ev.kind === 'trade-route-closed') {
    pushChronicle(ds + ' — Rotta commerciale chiusa.', 'system');
  } else if (ev.kind === 'trade-raid') {
    const sys = ORION.game.galaxy.systems[ev.sysId];
    const where = sys ? (' presso <strong>' + escapeHtml(sys.name) + '</strong>') : '';
    pushChronicle(ds + ' — <strong>Razzia pirata</strong> sulla rotta ' + colonyNameFromKey(ev.src) + ' → ' + colonyNameFromKey(ev.dst) +
      where + ': persi ' + resIcon(ev.resource) + Math.round(ev.lost) + ' · usura mercantile +' + (ev.wear | 0) + '%.', 'system');
    if (ORION.tutorial) ORION.tutorial.fire('trade-raids');
  } else if (ev.kind === 'trade-mercantile-lost') {
    pushChronicle(ds + ' — Mercantile <strong>ritirato</strong> (usura 100%) sulla rotta da ' + colonyNameFromKey(ev.src) + ': rotta chiusa.', 'system');
  } else if (ev.kind === 'agreement-suspended' || ev.kind === 'agreement-resumed' || ev.kind === 'agreement-ended') {
    const civ = (ORION.game.civs || []).filter(function (c) { return c.id === ev.civId; })[0];
    const cname = civ ? civ.name : 'una civiltà';
    const verb = ev.kind === 'agreement-suspended' ? 'sospeso' : (ev.kind === 'agreement-resumed' ? 'ripreso' : 'concluso');
    pushChronicle(ds + ' — Accordo commerciale con <strong>' + escapeHtml(cname) + '</strong> ' + verb + '.', 'explore');
  } else if (ev.kind === 'commander-promoted') {
    /* Decisione #43: la promozione di una figura Comandante è il
       "punto di nascita" dei soggetti militari nominati (gancio M14). */
    const c = ev.commander;
    pushChronicle(ds + ' — <strong>' + escapeHtml(c.rank) + ' ' + escapeHtml(c.name) + '</strong> emerge dall\'equipaggio veterano su ' + pname + ptag + ' · specializzazione <em>' + escapeHtml(c.specializationLabel) + '</em> · tratto <em>' + escapeHtml(c.traitLabel) + '</em>.', 'figure');
    if (ORION.tutorial && ORION.tutorial.fire) ORION.tutorial.fire('commander-promoted');
  } else if (ev.kind === 'expedition-arrived') {
    const sys = ORION.game.galaxy.systems[ev.systemId];
    const tag = ev.systemId >= 0 ? systemTagHtml(ev.systemId) : '';
    pushChronicle(ds + ' — Salto iperspaziale completato: sistema <strong>' + (sys ? sys.name : '—') + '</strong>' + tag + ' esplorato.', 'explore');
    /* Forza un re-render della mappa galassia (il sistema target è ora EXPLORED) */
    if (ORION.map && ORION.map.requestRender) ORION.map.requestRender();
  } else if (ev.kind === 'expedition-incident') {
    const inc = ev.incident || {};
    let txt;
    if (inc.kind === 'delay')         txt = 'Incidente in rotta: ritardo (+' + inc.amount + ' Ι).';
    else if (inc.kind === 'wear')     txt = 'Incidente in rotta: avaria propulsori (+' + inc.amount + '% usura).';
    else if (inc.kind === 'critical') txt = 'Avaria critica: scafo compromesso, equipaggio in fuga su scialuppa di salvataggio.';
    else if (inc.kind === 'discovery')txt = 'Scoperta fortuita lungo la rotta iperspaziale.';
    else txt = 'Incidente in rotta.';
    pushChronicle(ds + ' — ' + txt, 'system');
  } else if (ev.kind === 'expedition-ship-lost') {
    pushChronicle(ds + ' — <strong>Scafo ritirato dal servizio</strong> (usura 100%): rotta di rientro su nave di soccorso.', 'system');
  } else if (ev.kind === 'expedition-return') {
    const exp = ev.expedition;
    const sys = exp && ORION.game.galaxy.systems[exp.targetSystemId];
    const tag = exp ? systemTagHtml(exp.targetSystemId) : '';
    pushChronicle(ds + ' — Spedizione rientrata da <strong>' + (sys ? sys.name : '—') + '</strong>' + tag +
      (ev.shipLost ? ' · scafo perso' : ' · equipaggio promosso (+1 xp)') + '.', 'explore');
  } else if (ev.kind === 'expedition-discovery') {
    pushChronicle(ds + ' — <strong>Scoperta fortuita</strong>: l\'equipaggio porta in patria osservazioni inattese.', 'explore');
  } else if (ev.kind === 'expedition-dock-overflow') {
    pushChronicle(ds + ' — Porto saturo su ' + pname + ptag + ' (' + (ev.bound || '?') + '/' + (ev.docks || '?') + '): la nave rientrata resta in <strong>orbita parcheggio</strong> in attesa di un attracco libero.', 'planet');
  } else if (ev.kind === 'fleet-launched') {
    const fname = ev.fleetName || '—';
    const sys = ORION.game.galaxy.systems[ev.systemId];
    const stag = ev.systemId != null && ev.systemId >= 0 ? systemTagHtml(ev.systemId) : '';
    pushChronicle(ds + ' — Salto iperspaziale: <strong>' + escapeHtml(fname) + '</strong> in rotta verso <strong>' +
      (sys ? sys.name : '—') + '</strong>' + stag + '.', 'explore');
  } else if (ev.kind === 'fleet-leg-hop') {
    /* Cronaca silenziata su ogni leg per evitare spam: il "fine rotta"
       e l'arrivo bastano. (Lasciamo l'evento perché potrebbe servire
       all'auto-pausa o all'UI in futuro.) */
  } else if (ev.kind === 'fleet-arrived') {
    const fname = ev.fleetName || '—';
    const sys = ORION.game.galaxy.systems[ev.systemId];
    const stag = ev.systemId != null && ev.systemId >= 0 ? systemTagHtml(ev.systemId) : '';
    pushChronicle(ds + ' — <strong>' + escapeHtml(fname) + '</strong> in orbita di <strong>' +
      (sys ? sys.name : '—') + '</strong>' + stag + '.', 'explore');
    if (ORION.map && ORION.map.requestRender) ORION.map.requestRender();
  } else if (ev.kind === 'fleet-route-complete') {
    const fname = ev.fleetName || '—';
    const sys = ORION.game.galaxy.systems[ev.systemId];
    const stag = ev.systemId != null && ev.systemId >= 0 ? systemTagHtml(ev.systemId) : '';
    pushChronicle(ds + ' — Rotta completata da <strong>' + escapeHtml(fname) + '</strong> presso <strong>' +
      (sys ? sys.name : '—') + '</strong>' + stag + '.', 'explore');
  } else if (ev.kind === 'fleet-discovery') {
    const fname = ev.fleetName || '—';
    const sys = ORION.game.galaxy.systems[ev.systemId];
    const stag = ev.systemId != null && ev.systemId >= 0 ? systemTagHtml(ev.systemId) : '';
    pushChronicle(ds + ' — <strong>' + escapeHtml(fname) + '</strong>: sistema <strong>' +
      (sys ? sys.name : '—') + '</strong>' + stag + ' esplorato.', 'explore');
    if (ORION.map && ORION.map.requestRender) ORION.map.requestRender();
  } else if (ev.kind === 'fleet-waypoint-reached') {
    /* Fase B (decisione #46): cronaca breve per ogni tappa. La voce è
       silenziata dal log se si chiude la prima tappa di un singolo move
       (già coperta da `fleet-arrived`); qui interessa solo nella catena
       multi-tappa. */
    const fname = ev.fleetName || '—';
    const sys = ORION.game.galaxy.systems[ev.systemId];
    const stag = ev.systemId != null && ev.systemId >= 0 ? systemTagHtml(ev.systemId) : '';
    if (ev.wpTotal > 1) {
      pushChronicle(ds + ' — <strong>' + escapeHtml(fname) + '</strong>: tappa ' + (ev.wpIdx + 1) + '/' + ev.wpTotal +
        ' raggiunta presso <strong>' + (sys ? sys.name : '—') + '</strong>' + stag + '.', 'explore');
    }
    if (ORION.map && ORION.map.requestRender) ORION.map.requestRender();
  } else if (ev.kind === 'gov-queue-empty') {
    pushChronicle(ds + ' — <strong>Governatore di ' + pname + ptag + '</strong>: la coda di costruzione è ferma — i cantieri attendono ordini.', 'planet');
    if (ORION.tutorial) ORION.tutorial.fire('governor');
  } else if (ev.kind === 'gov-slots-idle') {
    pushChronicle(ds + ' — <strong>Governatore di ' + pname + ptag + '</strong>: ' + (ev.free || 0) + ' slot di costruzione liberi, nessun progetto in coda.', 'planet');
    if (ORION.tutorial) ORION.tutorial.fire('governor');
  } else if (ev.kind === 'gov-pop-near-cap') {
    pushChronicle(ds + ' — <strong>Governatore di ' + pname + ptag + '</strong>: popolazione al ' + (ev.ratio || '—') + '% del tetto abitativo — è ora di espandere l\'habitat.', 'planet');
    if (ORION.tutorial) ORION.tutorial.fire('governor');
  } else if (ev.kind === 'gov-supply-falling') {
    const RES = { food: 'cibo', water: 'acqua' };
    pushChronicle(ds + ' — <strong>Governatore di ' + pname + ptag + '</strong>: scorte di <strong>' + RES[ev.res] + '</strong> in calo costante — carenza imminente se non si interviene.', 'system');
    if (ORION.tutorial) ORION.tutorial.fire('governor');
  } else if (ev.kind === 'gov-veterans-idle') {
    pushChronicle(ds + ' — <strong>Governatore di ' + pname + ptag + '</strong>: ' + (ev.count || 1) + ' equipaggio/i veterano/i disponibile/i, nessuna spedizione in corso.', 'explore');
    if (ORION.tutorial) ORION.tutorial.fire('governor');
  } else if (ev.kind === 'gov-build-started') {
    const SDEF = ORION.structures && ORION.structures.get(ev.structId);
    const sname = SDEF ? SDEF.name : (ev.structId || '—');
    pushChronicle(ds + ' — <strong>Governatore di ' + pname + ptag + '</strong>: avviata costruzione di <strong>' + sname + '</strong> (vocazione ' + (ev.vocation || '—') + ').', 'planet');
    if (ORION.tutorial) ORION.tutorial.fire('governor');
  } else if (ev.kind === 'gov-expand-started') {
    const SDEF = ORION.structures && ORION.structures.get(ev.structId);
    const sname = SDEF ? SDEF.name : (ev.structId || '—');
    pushChronicle(ds + ' — <strong>Governatore di ' + pname + ptag + '</strong>: espansione di <strong>' + sname + '</strong> al livello ' + (ev.level || '?') + '.', 'planet');
    if (ORION.tutorial) ORION.tutorial.fire('governor');
  } else if (ev.kind === 'capital-declared') {
    pushChronicle(ds + ' — <strong>' + pname + ptag + '</strong> dichiarata capitale di gruppo (transizione in corso).', 'planet');
    if (ORION.tutorial && ORION.tutorial.fire) ORION.tutorial.fire('capital');
  } else if (ev.kind === 'capital-transition-end') {
    pushChronicle(ds + ' — <strong>' + pname + ptag + '</strong> entra ufficialmente in carica come capitale di gruppo · bonus +15% produzione, +10 slot.', 'planet');
    if (ORION.tutorial && ORION.tutorial.fire) ORION.tutorial.fire('capital');
  } else if (ev.kind === 'capital-decommissioned') {
    pushChronicle(ds + ' — <strong>' + pname + ptag + '</strong> ha terminato il decommissioning · ritorno a regime normale.', 'planet');
  } else if (ev.kind === 'civ-contact') {
    /* M10 Fase A (decisione #47): primo contatto con una civiltà AI.
       La scheda-dossier vera arriva in Fase B; qui è una voce di cronaca. */
    pushChronicle(ds + ' — <strong>Primo contatto</strong> con <strong>' + escapeHtml(ev.civName) + '</strong> nel/nella ' + escapeHtml(ev.regionLabel) + ' · <em>' + escapeHtml(ev.traitLabel) + '</em> · <span class="chronicle__hint">dossier nella vista Civiltà ⬡</span>.', 'civ');
    if (ORION.tutorial) ORION.tutorial.fire('civilizations');
  } else if (ev.kind === 'civ-spotted') {
    /* M10 Fase B punto 2 (decisione #52 §13.10): "Avvistata" — esplori un
       loro sistema, ma nessun atto formale è ancora avvenuto. La vista
       Civiltà ⬡ mostra solo nome + sigla regione fino al contatto vero. */
    pushChronicle(ds + ' — Civiltà <strong>' + escapeHtml(ev.civName) + '</strong> avvistata nel/nella ' + escapeHtml(ev.regionLabel) + ' · <span class="chronicle__hint">dossier minimo nella vista Civiltà ⬡</span>.', 'civ');
  } else if (ev.kind === 'civ-expand') {
    /* Voce di cronaca "da lontano": effetto senza svelare la mappa. */
    pushChronicle(ds + ' — Voci dal/dalla ' + escapeHtml(ev.regionLabel) + ': <strong>' + escapeHtml(ev.civName) + '</strong> ha annesso un nuovo sistema.', 'civ');
  } else if (ev.kind === 'civ-war') {
    pushChronicle(ds + ' — <strong>' + escapeHtml(ev.winner) + '</strong> strappa un sistema a <strong>' + escapeHtml(ev.loser) + '</strong> nel/nella ' + escapeHtml(ev.regionLabel) + '.', 'civ');
    if (ORION.tutorial) ORION.tutorial.fire('civilizations');
  } else if (ev.kind === 'civ-battle') {
    /* M10 Fase D (decisione #47): guerra AI-vs-AI VISTA dal giocatore,
       risolta col motore M09 → report reale. */
    const stag = (ev.systemId != null && ev.systemId >= 0) ? systemTagHtml(ev.systemId) : '';
    const verdict = ev.outcome === 'taken'
      ? '<strong>' + escapeHtml(ev.attacker) + '</strong> conquista il sistema'
      : '<strong>' + escapeHtml(ev.defender) + '</strong> resiste all\'assalto di <strong>' + escapeHtml(ev.attacker) + '</strong>';
    pushChronicle(ds + ' — Battaglia di <strong>' + escapeHtml(ev.systemName || '—') + '</strong>' + stag + ': ' + verdict +
      ' · navi perse ' + (ev.lostA || 0) + '/' + (ev.lostB || 0) + ' in ' + (ev.rounds || 0) + ' round.', 'civ');
    if (ORION.map && ORION.map.requestRender) ORION.map.requestRender();
    if (ORION.tutorial) ORION.tutorial.fire('civilizations');
  } else if (ev.kind === 'civ-fallen') {
    pushChronicle(ds + ' — <strong>' + escapeHtml(ev.civName) + '</strong> è caduta: ridotta a zero sistemi, assorbita da <strong>' + escapeHtml(ev.conqueror) + '</strong>.', 'civ');
  } else if (ev.kind === 'civ-emerged') {
    pushChronicle(ds + ' — Una nuova potenza emerge nel/nella ' + escapeHtml(ev.regionLabel) + ': <strong>' + escapeHtml(ev.civName) + '</strong>.', 'civ');
  } else if (ev.kind === 'pirate-raid') {
    pushChronicle(ds + ' — Predoni hanno colpito una rotta nel/nella ' + escapeHtml(ev.regionLabel) + '.', 'system');
  } else if (ev.kind === 'diplo-war') {
    /* M11 Fase A (decisione #51): transizioni diplomatiche. */
    pushChronicle(ds + ' — <strong>Guerra dichiarata</strong> a <strong>' + escapeHtml(ev.civName) + '</strong>.', 'civ');
    if (ORION.tutorial) ORION.tutorial.fire('diplomacy');
  } else if (ev.kind === 'diplo-peace') {
    pushChronicle(ds + ' — <strong>Pace</strong> stipulata con <strong>' + escapeHtml(ev.civName) + '</strong> · ostilità sospese.', 'civ');
    if (ORION.tutorial) ORION.tutorial.fire('diplomacy');
  } else if (ev.kind === 'diplo-alliance') {
    pushChronicle(ds + ' — <strong>Alleanza</strong> stretta con <strong>' + escapeHtml(ev.civName) + '</strong> · patto di non-aggressione.', 'civ');
    if (ORION.tutorial) ORION.tutorial.fire('diplomacy');
  } else if (ev.kind === 'diplo-alliance-broken') {
    pushChronicle(ds + ' — <strong>Alleanza rotta</strong> con <strong>' + escapeHtml(ev.civName) + '</strong> · reputazione intaccata.', 'civ');
  } else if (ev.kind === 'diplo-rejected') {
    pushChronicle(ds + ' — <strong>' + escapeHtml(ev.civName) + '</strong> ha respinto la tua proposta diplomatica.', 'civ');
  } else if (ev.kind === 'diplo-truce-expired') {
    pushChronicle(ds + ' — La tregua con <strong>' + escapeHtml(ev.civName) + '</strong> è scaduta · stato di guerra ripristinato.', 'civ');
  } else if (ev.kind === 'diplo-offer') {
    /* M11 Fase B parziale: la AI ti invia un dispaccio (pace/alleanza). */
    const DIP = ORION.diplomacy;
    const lab = (DIP && DIP.offerLabel) ? DIP.offerLabel(ev.action) : ev.action;
    pushChronicle(ds + ' — <strong>Dispaccio</strong> da <strong>' + escapeHtml(ev.civName) +
      '</strong>: offrono <strong>' + escapeHtml(lab) + '</strong>. Apri la vista <strong>Civiltà</strong> per accettare o rifiutare.', 'civ');
    if (ORION.tutorial) ORION.tutorial.fire('diplomacy');
  } else if (ev.kind === 'diplo-offer-expired') {
    pushChronicle(ds + ' — L\'offerta di <strong>' + escapeHtml(ev.civName) + '</strong> è scaduta senza risposta.', 'civ');
  } else if (ev.kind === 'diplo-offer-rejected') {
    pushChronicle(ds + ' — Hai respinto l\'offerta di <strong>' + escapeHtml(ev.civName) + '</strong>.', 'civ');
  } else if (ev.kind === 'system-occupied') {
    /* M11 Fase B parziale: occupazione di un sistema AI dopo vittoria. */
    const sys = ORION.game.galaxy.systems[ev.sysId];
    const stag = ev.sysId != null && ev.sysId >= 0 ? systemTagHtml(ev.sysId) : '';
    pushChronicle(ds + ' — <strong>' + escapeHtml(sys ? sys.name : '—') + '</strong>' + stag +
      ' <strong>occupato</strong>: strappato a <strong>' + escapeHtml(ev.fromCivName || 'una civiltà') +
      '</strong>. Resta sotto il tuo controllo finché non lo abbandoni.', 'civ');
    if (ORION.map && ORION.map.requestRender) ORION.map.requestRender();
  } else if (ev.kind === 'system-released') {
    const sys = ORION.game.galaxy.systems[ev.sysId];
    const stag = ev.sysId != null && ev.sysId >= 0 ? systemTagHtml(ev.sysId) : '';
    pushChronicle(ds + ' — Occupazione di <strong>' + escapeHtml(sys ? sys.name : '—') + '</strong>' + stag +
      ' <strong>abbandonata</strong>.', 'civ');
    if (ORION.map && ORION.map.requestRender) ORION.map.requestRender();
  } else if (ev.kind === 'system-cohesion-formed') {
    /* M10 Fase B (decisione #52 §13.6): consorzio locale che emerge. */
    const stag = ev.sysId != null && ev.sysId >= 0 ? systemTagHtml(ev.sysId) : '';
    const names = (ev.owners || []).map(function (o) { return '<strong>' + escapeHtml(o.name) + '</strong>'; }).join(' + ');
    pushChronicle(ds + ' — <strong>Sistema coeso</strong> a <strong>' + escapeHtml(ev.systemName || '—') + '</strong>' + stag +
      ' · ' + names + ' coabitano in pace. Passare, attaccare o colonizzare costa disposizione di tutti i membri.', 'civ');
    if (ORION.tutorial) ORION.tutorial.fire('cohesion');
    if (ORION.map && ORION.map.requestRender) ORION.map.requestRender();
  } else if (ev.kind === 'system-cohesion-broken') {
    const stag = ev.sysId != null && ev.sysId >= 0 ? systemTagHtml(ev.sysId) : '';
    pushChronicle(ds + ' — Il consorzio locale a <strong>' + escapeHtml(ev.systemName || '—') + '</strong>' + stag + ' si è <strong>dissolto</strong>.', 'civ');
    if (ORION.map && ORION.map.requestRender) ORION.map.requestRender();
  } else if (ev.kind === 'federation-formed') {
    /* M10 Fase B (decisione #52 §13.8): federazione emergente, entità composita. */
    const members = (ev.memberNames || []).map(function (n) { return '<strong>' + escapeHtml(n) + '</strong>'; }).join(' + ');
    pushChronicle(ds + ' — Nasce la <strong>' + escapeHtml(ev.fedName) + '</strong>: ' + members +
      ' suggellano un patto federativo. Decisioni concertate, somma di pianeti e potenza.', 'civ');
    if (ORION.tutorial) ORION.tutorial.fire('federations');
  } else if (ev.kind === 'federation-broken') {
    const REASON = {
      'members-fallen': 'troppi membri caduti', 'territory-loss': 'perdita di territorio',
      'vocation-drift': 'divergenza di vocazioni', 'unknown': 'cause interne'
    };
    pushChronicle(ds + ' — La <strong>' + escapeHtml(ev.fedName) + '</strong> si è dissolta · ' +
      (REASON[ev.reason] || ev.reason || 'cause interne') + '.', 'civ');
  } else if (ev.kind === 'pirate-cleared') {
    /* M10 Fase E: covo sgominato → taglia. */
    const stag = ev.systemId != null && ev.systemId >= 0 ? systemTagHtml(ev.systemId) : '';
    const sys = (ev.systemId != null && ORION.game.galaxy.systems[ev.systemId]) ? ORION.game.galaxy.systems[ev.systemId].name : '—';
    const rw = ev.reward || {};
    pushChronicle(ds + ' — <strong>Covo pirata sgominato</strong> a <strong>' + escapeHtml(sys) + '</strong>' + stag +
      ' · taglia: ' + resIcon('met') + (rw.met || 0) + ' ' + resIcon('en') + (rw.en || 0) + '.', 'explore');
    if (ORION.tutorial) ORION.tutorial.fire('pirates');
  } else if (ev.kind === 'pirate-raid-won') {
    const stag = ev.systemId != null && ev.systemId >= 0 ? systemTagHtml(ev.systemId) : '';
    const rw = ev.reward || {};
    pushChronicle(ds + ' — Covo pirata colpito e indebolito' + stag + ' · bottino ' + resIcon('met') + (rw.met || 0) + ' ' + resIcon('en') + (rw.en || 0) + '.', 'explore');
    if (ORION.tutorial) ORION.tutorial.fire('pirates');
  } else if (ev.kind === 'raider-inbound') {
    const stag = ev.targetSysId != null && ev.targetSysId >= 0 ? systemTagHtml(ev.targetSysId) : '';
    pushChronicle(ds + ' — <strong>Predoni in rotta</strong> verso la flotta <strong>' + escapeHtml(ev.targetFleetName || '—') + '</strong>' + stag + ' (arrivo fra ' + (ev.eta || 0) + ' ' + iU() + ').', 'system');
    if (ORION.tutorial) ORION.tutorial.fire('pirates');
  } else if (ev.kind === 'raider-hit') {
    const stag = ev.systemId != null && ev.systemId >= 0 ? systemTagHtml(ev.systemId) : '';
    const verb = ev.playerWon ? 'respinge i predoni' : 'subisce l\'attacco predone';
    const losses = ev.lost > 0 ? ' · ' + ev.lost + ' nave/i perdute' : ' · nessuna perdita';
    pushChronicle(ds + ' — Flotta <strong>' + escapeHtml(ev.fleetName || '—') + '</strong> ' + verb + stag + losses + '.', 'system');
    if (ORION.tutorial) ORION.tutorial.fire('pirates');
  } else if (ev.kind === 'raider-fizzle') {
    /* preda fuggita: voce leggera, niente spam */
    pushChronicle(ds + ' — I predoni non hanno trovato la preda e si sono dileguati.', 'system');
  } else if (ev.kind === 'battle-skirmish') {
    /* M09 Fase A (decisione #49): scaramuccia lampo. */
    const sys = ORION.game.galaxy.systems[ev.systemId];
    const stag = ev.systemId != null && ev.systemId >= 0 ? systemTagHtml(ev.systemId) : '';
    const verb = ev.playerWon ? 'respinge il nemico' : 'è costretta alla ritirata';
    const losses = ev.lost > 0 ? ' · ' + ev.lost + ' nave/i perdute' : ' · nessuna perdita';
    /* Fase B: se lo scontro ha arretrato il confine di una civiltà AI. */
    let rollback = '';
    if (ev.report && ev.report.rolledBackSystem != null) {
      rollback = (ev.report.alignmentImpact === 'light')
        ? ' · <strong>sistema liberato</strong> (reputazione luminosa)'
        : ' · <strong>sistema strappato</strong> (reputazione oscura)';
    }
    pushChronicle(ds + ' — Scontro presso <strong>' + (sys ? sys.name : '—') + '</strong>' + stag + ': <strong>' +
      escapeHtml(ev.fleetName) + '</strong> ' + verb + losses + rollback + '.', ev.playerWon ? 'explore' : 'system');
    ORION.lastBattle = ev.report || null;
    if (ORION.tutorial) ORION.tutorial.fire('combat');
    if (ORION.map && ORION.map.requestRender) ORION.map.requestRender();
  } else if (ev.kind === 'incursion-inbound') {
    /* Preavviso (recovery-friendly #22): l'incursione arriva fra ETA Ι.
       Fase B: può essere un'incursione AI di conquista (più grave). */
    const cn = colonyNameFromKey(ev.targetColonyKey);
    const tag = ev.targetSysId >= 0 ? bodyTagHtml(ev.targetSysId) : '';
    const who = (ev.attackerKind === 'ai')
      ? ('Forza d\'invasione di <strong>' + escapeHtml(ev.civName || 'una civiltà') + '</strong>')
      : '<strong>Incursione pirata</strong>';
    pushChronicle(ds + ' — ' + who + ' in rotta verso ' + cn + tag +
      ' · arrivo stimato fra <strong>' + ev.eta + ' ' + iU() + '</strong>. Prepara le difese.', 'system');
    if (ORION.tutorial) ORION.tutorial.fire(ev.attackerKind === 'ai' ? 'siege' : 'combat');
  } else if (ev.kind === 'siege-begin') {
    const cn = colonyNameFromKey(ev.colonyKey);
    const tag = ev.systemId >= 0 ? bodyTagHtml(ev.systemId) : '';
    pushChronicle(ds + ' — <strong>Assedio</strong> su ' + cn + tag + ': i predoni ingaggiano le difese. ' +
      '<span class="chronicle__hint">reazioni nella vista Flotta ⬡</span>', 'system');
    if (ORION.tutorial) ORION.tutorial.fire('siege');
    if (ORION.map && ORION.map.requestRender) ORION.map.requestRender();
  } else if (ev.kind === 'siege-round') {
    const cn = colonyNameFromKey(ev.colonyKey);
    pushChronicle(ds + ' — Assedio di ' + cn + ' · round ' + ev.round + ' — difese ' + Math.round(ev.def) +
      ' / predoni ' + Math.round(ev.atk) + '.', 'system');
  } else if (ev.kind === 'siege-end') {
    const cn = colonyNameFromKey(ev.colonyKey);
    const tag = ev.systemId >= 0 ? bodyTagHtml(ev.systemId) : '';
    let txt;
    if (ev.outcome === 'repelled') txt = '<strong>Assedio respinto</strong> su ' + cn + tag + ' — i predoni si ritirano.';
    else if (ev.outcome === 'looted') txt = '<strong>' + cn + tag + ' saccheggiata</strong>: risorse trafugate, danni alle strutture.';
    else txt = 'Assedio revocato su ' + cn + tag + '.';
    pushChronicle(ds + ' — ' + txt, ev.outcome === 'repelled' ? 'explore' : 'system');
    if (ORION.map && ORION.map.requestRender) ORION.map.requestRender();
  } else if (ev.kind === 'colony-looted') {
    const cn = colonyNameFromKey(ev.colonyKey);
    const L = ev.looted || {};
    const parts = ['met', 'en', 'food', 'water'].filter(function (k) { return L[k] > 0; })
      .map(function (k) { return resGlyph(k) + ' ' + L[k]; });
    pushChronicle(ds + ' — Saccheggio di ' + cn + ': ' + (parts.join(' · ') || 'nulla di rilevante') + ' · morale d\'impero in calo.', 'system');
  } else if (ev.kind === 'colony-conquered') {
    /* M09 Fase B: colonia conquistata da una civiltà AI. */
    const cn = colonyNameFromKey(ev.colonyKey);
    pushChronicle(ds + ' — <strong>' + cn + ' è caduta</strong>: conquistata da <strong>' + escapeHtml(ev.civName || 'una civiltà') + '</strong>' +
      (ev.wasCapital ? ' — era la tua <strong>capitale</strong>' : '') + '. Il morale d\'impero crolla.', 'system');
    if (ORION.tutorial) ORION.tutorial.fire('decline');
    if (ORION.map && ORION.map.requestRender) ORION.map.requestRender();
  } else if (ev.kind === 'colony-razed') {
    const cn = colonyNameFromKey(ev.colonyKey);
    pushChronicle(ds + ' — <strong>' + cn + ' è stata rasa al suolo</strong> da <strong>' + escapeHtml(ev.civName || 'una civiltà') + '</strong>' +
      (ev.wasCapital ? ' — era la tua <strong>capitale</strong>' : '') + '. Non resta che cenere.', 'system');
    if (ORION.tutorial) ORION.tutorial.fire('decline');
    if (ORION.map && ORION.map.requestRender) ORION.map.requestRender();
  } else if (ev.kind === 'fleet-intercepted') {
    const sys = ORION.game.galaxy.systems[ev.systemId];
    const stag = ev.systemId >= 0 ? systemTagHtml(ev.systemId) : '';
    pushChronicle(ds + ' — <strong>' + escapeHtml(ev.fleetName) + '</strong> intercettata in rotta presso <strong>' +
      (sys ? sys.name : '—') + '</strong>' + stag + ': avvistamento ostile, scontro imminente.', 'system');
  } else if (ev.kind === 'empire-fallen') {
    if (ev.hard) {
      pushChronicle(ds + ' — <strong>La tua civiltà è caduta.</strong> Senza più colonie, l\'impero si dissolve negli annali galattici.', 'system');
      showDefeatModal();
    } else {
      pushChronicle(ds + ' — <strong>Esilio.</strong> Hai perso l\'ultima colonia: la tua civiltà sopravvive solo nelle flotte superstiti. Ricolonizza per risorgere.', 'system');
    }
  }
}

/* M09 (decisione #49): nome leggibile di una colonia dalla sua chiave
   "<sysId>:<bodyKey>" — rigenera system+planet dal seed (seed+delta #5). */
/* =====================================================================
   Identità del popolo del giocatore (decisione #65)
   Prefisso (archetipo di governo, riusa il pool AI #34) + nome proprio.
   ===================================================================== */
function empireArchetypeList() {
  const A = (ORION.ai && ORION.ai.ARCHETYPES) || {};
  return [].concat(A.bene || [], A.neutrale || [], A.male || []);
}
function empireArchById(id) {
  return empireArchetypeList().find(function (a) { return a.id === id; })
      || { id: 'repubblica', noun: 'Repubblica' };
}
/* "Impero Glicine" (direct) / "Repubblica di Glicine" — stessa regola AI. */
function formatEmpire(emp) {
  if (!emp || !emp.proper) return '';
  const a = empireArchById(emp.prefix);
  return a.noun + ' ' + (a.direct ? '' : 'di ') + emp.proper;
}
/* Nome PLAIN della colonia da una chiave "<sysId>:<bodyKey>" (per il default). */
function colonyPlainName(key) {
  const g = ORION.game;
  if (!g || !key) return '';
  const parts = String(key).split(':');
  const sid = Number(parts[0]); const bk = parts[1];
  try {
    const sys = ORION.system.generate(g.galaxy, sid);
    const pl = ORION.planet.generate(g.galaxy, sys, bk);
    return pl ? pl.name : ('Sistema ' + sid);
  } catch (e) { return 'Sistema ' + sid; }
}
/* Default: prefisso "Repubblica" + nome della colonia natale. */
function defaultEmpire(game) {
  const key = game && (game.homePlanetKey ||
    (game.homeWorld && Number.isInteger(game.homeWorld.systemId)
      ? (game.homeWorld.systemId + ':' + game.homeWorld.bodyKey) : null));
  const proper = (key && colonyPlainName(key)) ||
    (game && ORION.names && ORION.names.galaxyName(game.seed)) || 'Aurora';
  return { prefix: 'repubblica', proper: proper };
}

/* Editor in-game dell'identità (decisione #65): cambia prefisso e/o nome
   proprio in qualsiasi momento (es. cambio di intenti di gioco). */
function openEmpireEditor() {
  const g = ORION.game;
  if (!g) return;
  const emp = (g.empire && g.empire.proper) ? g.empire : defaultEmpire(g);
  const A = (ORION.ai && ORION.ai.ARCHETYPES) || {};
  const sources = [];
  [emp.proper, colonyPlainName(g.homePlanetKey), ORION.names.galaxyName(g.seed)]
    .forEach(function (s) { if (s && sources.indexOf(s) < 0) sources.push(s); });
  let srcIdx = 0;

  function optGroup(label, arr, cur) {
    if (!arr || !arr.length) return '';
    return '<optgroup label="' + label + '">' + arr.map(function (a) {
      return '<option value="' + a.id + '"' + (a.id === cur ? ' selected' : '') + '>' + escapeHtml(a.noun) + '</option>';
    }).join('') + '</optgroup>';
  }
  const selectHtml = '<select class="main-menu__select" data-bind="emp-prefix">' +
    optGroup('Luce / diplomatici', A.bene, emp.prefix) +
    optGroup('Neutrali / economici', A.neutrale, emp.prefix) +
    optGroup('Autoritari / diretti', A.male, emp.prefix) +
  '</select>';

  let ov = document.querySelector('[data-bind="empire-modal"]');
  if (ov) ov.remove();
  ov = document.createElement('div');
  ov.className = 'save-modal empire-modal';
  ov.setAttribute('data-bind', 'empire-modal');
  ov.innerHTML =
    '<div class="save-modal__panel">' +
      '<header class="save-modal__header">' +
        '<h2 class="save-modal__title"><span>Rinomina il tuo popolo</span></h2>' +
        '<button class="btn btn--mini btn--icon-only" data-action="emp-close" type="button" aria-label="Chiudi"><span class="ui-icon" data-icon="close" aria-hidden="true"></span></button>' +
      '</header>' +
      '<div class="save-modal__body">' +
        '<label class="main-menu__field"><span class="main-menu__field-label">Prefisso</span>' + selectHtml + '</label>' +
        '<label class="main-menu__field"><span class="main-menu__field-label">Nome proprio</span>' +
          '<span class="main-menu__seedrow">' +
            '<input type="text" class="main-menu__input" data-bind="emp-proper" maxlength="24" value="' + escapeHtml(emp.proper) + '">' +
            '<button type="button" class="btn btn--mini" data-action="emp-roll" title="Sorteggia">🎲</button>' +
          '</span>' +
        '</label>' +
        '<p class="main-menu__empire-preview">Anteprima: <strong data-bind="emp-preview"></strong></p>' +
        '<div class="main-menu__form-actions">' +
          '<button type="button" class="btn btn--mini" data-action="emp-close">Annulla</button>' +
          '<button type="button" class="btn btn--primary" data-action="emp-save">Salva</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(ov);
  injectStaticSvgIcons();

  const sel = ov.querySelector('[data-bind="emp-prefix"]');
  const inp = ov.querySelector('[data-bind="emp-proper"]');
  const prev = ov.querySelector('[data-bind="emp-preview"]');
  function preview() {
    prev.textContent = formatEmpire({ prefix: sel.value, proper: inp.value.trim() || sources[0] || 'Aurora' });
  }
  sel.addEventListener('change', preview);
  inp.addEventListener('input', preview);
  ov.querySelector('[data-action="emp-roll"]').addEventListener('click', function () {
    srcIdx = (srcIdx + 1) % sources.length; inp.value = sources[srcIdx]; preview();
  });
  function close() { ov.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
  ov.querySelectorAll('[data-action="emp-close"]').forEach(function (b) { b.addEventListener('click', close); });
  ov.querySelector('[data-action="emp-save"]').addEventListener('click', function () {
    g.empire = { prefix: sel.value, proper: inp.value.trim() || sources[0] || 'Aurora' };
    persistGame(g);
    renderLeftPanel();
    close();
    showToast('Popolo: ' + formatEmpire(g.empire));
  });
  preview();
}

function colonyNameFromKey(key) {
  const g = ORION.game;
  if (!g || !key) return '—';
  const parts = String(key).split(':');
  const sid = Number(parts[0]); const bk = parts[1];
  try {
    const sys = ORION.system.generate(g.galaxy, sid);
    const pl = ORION.planet.generate(g.galaxy, sys, bk);
    return pl ? ('<strong>' + escapeHtml(pl.name) + '</strong>') : ('Sistema ' + sid);
  } catch (e) { return 'Sistema ' + sid; }
}

/* Aggiorna solo il chip delta accanto a "⏭ Evento": il resto del bottone
   è ridisegnato da renderTimeControls(). Mostra il delta nel formato
   durata del Calendario del Faro (#30): es. "+1Κ·10Ι" invece di "+60 I". */
function updateTimeControlsHint() {
  const g = ORION.game;
  if (!g) return;
  const delta = document.querySelector('[data-bind="event-delta"]');
  if (!delta) return;
  const n = ORION.time.nextEventImpulsi(g);
  delta.textContent = '+' + ORION.time.format(n, 'duration');
}

/* Pulse rapida sui valori HUD per segnalare l'aggiornamento. */
function pulseHud() {
  const targets = document.querySelectorAll('.resource__value, .index--date .index__value');
  targets.forEach(function (el) {
    el.classList.remove('hud-pulse');
    // forza reflow per riavviare l'animazione
    // eslint-disable-next-line no-unused-expressions
    void el.offsetWidth;
    el.classList.add('hud-pulse');
  });
}

/* Sincronizza l'evidenziazione della navigazione sinistra. */
function setNavActive(view) {
  ORION._currentView = view;
  document.querySelectorAll('.nav-item').forEach((i) => {
    i.classList.toggle('is-active', i.dataset.view === view);
  });
}

/* =====================================================================
   Decisione #62 — Dashboard Impero (M07.3)
   Griglia di card-colonia al centro a livello Galassia/Gruppo. È UI pura:
   nessun motore, nessun bump di schema, telemetria volatile per le
   sparkline. Click su card → focus mappa (onFocus); "Apri" → scheda
   colonia (onOpen). Toggle per mostrare/nascondere la mappa sotto.
   ===================================================================== */

/* Telemetria: campiona pop/morale/scorte di ogni colonia operativa. Chiamata
   dopo un avanzamento del tempo (runAdvance) → ~1 rilevamento per Ι a ritmo
   normale, più rado a velocità alte o su "Prossimo evento". Volatile. */
function sampleEmpireTelemetry() {
  const g = ORION.game;
  if (!g || !g.colonies) return;
  if (!ORION._empireTel) ORION._empireTel = {};
  const tel = ORION._empireTel;
  const live = {};
  function push(arr, v) { arr.push(v); if (arr.length > EMPIRE_TEL_MAX) arr.shift(); }
  myColonyKeys().forEach(function (k) {
    const c = g.colonies[k];
    if (!c || !c.colonized) return;   /* solo colonie operative hanno telemetria */
    const planet = planetForColony(c);
    if (!planet) return;
    live[k] = true;
    let t = tel[k];
    if (!t) t = tel[k] = { pop: [], morale: [], stock: [], lastI: -1 };
    if (t.lastI === g.timeImpulsi) return;  /* dedupe: un campione per Ι */
    t.lastI = g.timeImpulsi;
    const people = ORION.planet.peopleAt(ORION.planet.popUnits(c), planet);
    const morale = ORION.time.colonyMorale ? ORION.time.colonyMorale(g, c) : 1;
    const stock = (c.stock.met || 0) + (c.stock.en || 0) + (c.stock.food || 0) + (c.stock.water || 0);
    push(t.pop, people); push(t.morale, morale); push(t.stock, stock);
  });
  /* Pulisci la telemetria delle colonie non più mie/operative (perse, evacuate). */
  Object.keys(tel).forEach(function (k) { if (!live[k]) delete tel[k]; });
}

/* Stato peggiore di scarsità su una colonia (riusa la logica del roster sx). */
function colonyWorstScarcity(c) {
  let worst = 'ok';
  if (!c || !c._scar) return worst;
  ['met', 'en', 'food', 'water'].forEach(function (rk) {
    const s = c._scar[rk] && c._scar[rk].state;
    if (s === 'crit') worst = 'crit';
    else if (s === 'low' && worst !== 'crit') worst = 'low';
  });
  return worst;
}

/* Formatta un numero di scorte in forma compatta (k). */
function fmtStock(v) {
  if (v == null || !isFinite(v)) return '—';
  const av = Math.abs(v);
  if (av >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (av >= 1000) return (v / 1000).toFixed(1) + 'k';
  return Math.round(v).toString();
}

/* Costruisce i dati delle card per la Dashboard Impero (controller → view). */
function buildEmpireState() {
  const g = ORION.game;
  const cards = [];
  if (!g) return { cards: cards, summary: {} };
  const dxKey = resolveDxColonyKey();
  const CFG = ORION.time && ORION.time.CFG;
  let alertCount = 0, totalPeople = 0;

  myColonyKeys().forEach(function (k) {
    const c = g.colonies[k];
    const planet = planetForColony(c);
    if (!planet) return;
    const sysId = c.systemId;
    const scarState = colonyWorstScarcity(c);
    if (scarState !== 'ok') alertCount++;

    /* Badge (coerenti col roster sx). */
    const badges = [];
    const isCapital = (ORION.capital && ORION.capital.isCapital && ORION.capital.isCapital(g, k));
    if (isCapital) badges.push('<span class="lp-item__badge lp-item__badge--ok" title="Capitale">★</span>');
    else if (c.isHomeBase) badges.push('<span class="lp-item__badge lp-item__badge--ok" title="Pianeta base">★</span>');
    if (scarState === 'crit') badges.push('<span class="lp-item__badge lp-item__badge--crit" title="Scarsità critica">!</span>');
    else if (scarState === 'low') badges.push('<span class="lp-item__badge lp-item__badge--warn" title="Scarsità">!</span>');
    if (c.queue && c.queue.length) badges.push('<span class="lp-item__badge lp-item__badge--info" title="Coda di costruzione">' + uiIcon('build') + '</span>');
    if (c.governor && Array.isArray(c.governor.recent) && c.governor.recent.length) {
      badges.push('<span class="lp-item__badge lp-item__badge--warn" title="Segnalazione del governatore">' + uiIcon('settings') + '</span>');
    }

    /* Fase (insediamento / in arrivo). */
    let phaseLabel = '';
    if (c.phase === 'settling' && c.settlingStart != null) {
      const dur = c.settlingDuration || 60;
      const pct = Math.min(100, Math.round(((g.timeImpulsi - c.settlingStart) / dur) * 100));
      phaseLabel = '<span class="ecard__phase-chip">⏳ Insediamento · ' + pct + '%</span>';
    } else if (c.colonizing) {
      phaseLabel = '<span class="ecard__phase-chip">◌ Coloniale in viaggio</span>';
    }

    /* Popolazione (persone reali + maturità). */
    const peopleNow = ORION.planet.peopleAt(ORION.planet.popUnits(c), planet);
    totalPeople += peopleNow;
    const dev = Math.round(ORION.planet.popMaturity(c, planet) * 100);

    /* Morale (helper puro). */
    const morale = ORION.time.colonyMorale ? ORION.time.colonyMorale(g, c) : 1;
    const moraleState = morale >= 0.9 ? 'ok' : morale >= 0.65 ? 'low' : 'crit';

    /* Scorte totali + saldo netto/Ι (incluso drenaggio pop come nel deck). */
    const out = ORION.planet.structureOutput(c, planet, g);
    const popTotal = (c.pop && c.pop.total) || 0;
    const opPhase = c.phase !== 'settling';
    const popFood = (opPhase && CFG && popTotal > 0) ? popTotal * CFG.POP_FOOD_PER_UNIT : 0;
    const popWater = (opPhase && CFG && popTotal > 0) ? popTotal * CFG.POP_WATER_PER_UNIT : 0;
    let stockTotal = 0, stockNet = 0;
    ['met', 'en', 'food', 'water'].forEach(function (rk) {
      stockTotal += (c.stock[rk] || 0);
      const drain = rk === 'food' ? popFood : rk === 'water' ? popWater : 0;
      stockNet += (out.rates[rk] || 0) - (out.upkeep[rk] || 0) - drain;
    });

    const tel = (ORION._empireTel && ORION._empireTel[k]) || { pop: [], morale: [], stock: [] };

    cards.push({
      key: k, sysId: sysId, name: planet.name, tag: bodyTagHtml(sysId),
      badges: badges.join(''), phaseLabel: phaseLabel,
      people: peopleNow, peopleStr: ORION.planet.formatPeople(peopleNow), dev: dev,
      morale: morale, moraleState: moraleState,
      stockTotal: stockTotal, stockTotalStr: fmtStock(stockTotal), stockNet: stockNet,
      scarState: scarState,
      isCapital: !!isCapital,
      focused: (k === dxKey),
      spark: { pop: tel.pop, morale: tel.morale, stock: tel.stock }
    });
  });

  /* Ordine: capitale prima, poi per popolazione decrescente. */
  cards.sort(function (a, b) {
    if (a.isCapital !== b.isCapital) return a.isCapital ? -1 : 1;
    return b.people - a.people;
  });

  const totalsHtml =
    '<span class="empire-deck__total">' + uiIcon('home', 'cyan') + ' ' +
      escapeHtml(ORION.planet.formatPeople(totalPeople)) + ' ab.</span>' +
    (alertCount ? '<span class="empire-deck__total is-crit">' + uiIcon('warning') + ' ' + alertCount + ' in allerta</span>' : '');

  return {
    cards: cards,
    summary: { colonies: cards.length, fleets: (g.fleets || []).length, totalsHtml: totalsHtml }
  };
}

/* Scena "mappa" = livello Galassia/Gruppo senza sistema/pianeta aperto. */
function empireSceneIsMap() {
  return !!(ORION.map && document.querySelector('.galaxy-root') &&
            ORION.openSystemId < 0 && !ORION.openPlanetKey);
}

/* Mostra/aggiorna/nasconde la Dashboard Impero in base alla scena + alla
   preferenza `empireDeckOpen`. Chiamata da tutti i punti di lifecycle che
   cambiano la scena al centro. */
function updateEmpireDeck() {
  const root = document.querySelector('.galaxy-root');
  if (!root) return;
  const deckHolder = root.querySelector('[data-empire-deck]');
  const toggle = root.querySelector('[data-empire-toggle]');
  const onMap = empireSceneIsMap();

  /* Toggle: visibile solo a livello mappa. */
  if (toggle) {
    toggle.hidden = !onMap;
    if (onMap) {
      const n = myColonyKeys().length;
      toggle.classList.toggle('is-active', !!ORION.empireDeckOpen);
      toggle.innerHTML = uiIcon('grid') +
        '<span class="empire-deck-toggle__lbl">Impero</span>' +
        '<span class="empire-deck-toggle__n">' + n + '</span>';
      toggle.title = ORION.empireDeckOpen ? 'Nascondi Dashboard Impero (mostra la mappa)' : 'Mostra Dashboard Impero';
    }
  }

  const shouldShow = onMap && !!ORION.empireDeckOpen;
  if (!shouldShow) {
    if (ORION.empireDeck) { ORION.empireDeck.destroy(); ORION.empireDeck = null; }
    if (deckHolder) deckHolder.hidden = true;
    return;
  }
  if (!deckHolder || !ORION.EmpireDeck) return;
  const state = buildEmpireState();
  const opts = {
    onClose: function () { ORION.empireDeckOpen = false; saveUiPrefs(); updateEmpireDeck(); },
    onFocus: function (sysId, key) {
      /* Inquadrare ha senso solo se la mappa è visibile: chiudiamo la
         dashboard (resta riapribile dal toggle "Impero"). */
      if (sysId < 0 || !ORION.map) return;
      ORION.empireDeckOpen = false; saveUiPrefs(); updateEmpireDeck();
      ORION.map.focusSystem(sysId); ORION.map.selectSystem(sysId);
      const c = key && ORION.game.colonies[key];
      const planet = c && planetForColony(c);
      if (planet) showToast('Inquadrato ' + planet.name);
    },
    onOpen: function (key) {
      if (!key) return;
      const parts = key.split(':');
      const sid = Number(parts[0]); const bk = parts[1];
      navigateView('planet');
      if (ORION.openSystemId !== sid) openSystem(sid);
      openPlanet(sid, bk);
    }
  };
  if (!ORION.empireDeck) {
    ORION.empireDeck = new ORION.EmpireDeck().mount(deckHolder, state, opts);
  } else {
    ORION.empireDeck.refresh(state);
  }
}

function toggleEmpireDeck() {
  ORION.empireDeckOpen = !ORION.empireDeckOpen;
  saveUiPrefs();
  updateEmpireDeck();
  /* M06.6/#29: tutorial — concetto Dashboard Impero alla prima apertura. */
  if (ORION.empireDeckOpen && ORION.tutorial) ORION.tutorial.fire('empire-dashboard');
}

/* =====================================================================
   Decisione #50 — Plancia d'Impero (pannello sx)
   Sezioni: Roster (colonie + flotte) · Navigazione · Diplomazia/Ricerca/Mercato · Cronaca
   ===================================================================== */
function renderLeftPanel() {
  const host = document.querySelector('[data-bind="left-panel"]');
  if (!host) return;
  const g = ORION.game;
  if (!g) {
    host.innerHTML = '<p class="lp-empty">Avvia una partita dal menu.</p>';
    return;
  }

  const myKeys = myColonyKeys();
  const fleets = (g.fleets || []);
  const civsContacted = (ORION.ai && ORION.ai.contactedCivs) ? ORION.ai.contactedCivs(g) : [];
  const currentView = ORION._currentView || 'galaxy';
  const dxKey = resolveDxColonyKey();

  /* ----- Roster ----- */
  const colItems = myKeys.map(function (k) {
    const c = g.colonies[k];
    const p = planetForColony(c);
    const name = p ? p.name : ('Colonia ' + k);
    const sysId = c.systemId;
    const tag = bodyTagHtml(sysId);
    const badges = [];
    if (c.phase === 'settling') badges.push('<span class="lp-item__badge lp-item__badge--info" title="Insediamento">' + uiIcon('transition') + '</span>');
    if (c.colonizing) badges.push('<span class="lp-item__badge lp-item__badge--info">◌</span>');
    if (ORION.capital && ORION.capital.isCapital && ORION.capital.isCapital(g, k)) {
      badges.push('<span class="lp-item__badge lp-item__badge--ok" title="Capitale">★</span>');
    } else if (c.isHomeBase) {
      badges.push('<span class="lp-item__badge lp-item__badge--ok" title="Pianeta base">★</span>');
    }
    if (c._scar) {
      let worst = 'ok';
      ['met','en','food','water'].forEach(function (rk) {
        const s = c._scar[rk] && c._scar[rk].state;
        if (s === 'crit') worst = 'crit';
        else if (s === 'low' && worst !== 'crit') worst = 'low';
      });
      if (worst === 'crit') badges.push('<span class="lp-item__badge lp-item__badge--crit" title="Scarsità critica">!</span>');
      else if (worst === 'low') badges.push('<span class="lp-item__badge lp-item__badge--warn" title="Scarsità">!</span>');
    }
    if (c.queue && c.queue.length) {
      badges.push('<span class="lp-item__badge lp-item__badge--info" title="Coda di costruzione">' + uiIcon('build') + '</span>');
    }
    if (c.governor && Array.isArray(c.governor.recent) && c.governor.recent.length) {
      badges.push('<span class="lp-item__badge lp-item__badge--warn" title="Segnalazione del governatore">' + uiIcon('settings') + '</span>');
    }
    const isFocus = (k === dxKey);
    const icon = (ORION.icon && ORION.icon('roster')) || '';
    return '<button class="lp-item' + (isFocus ? ' is-focus' : '') + '" data-action="roster-colony" data-key="' + escapeHtml(k) + '" type="button">' +
      '<span class="lp-item__glyph ui-icon" aria-hidden="true">' + icon + '</span>' +
      '<span class="lp-item__name"><strong>' + escapeHtml(name) + '</strong>' + tag + '</span>' +
      '<span class="lp-item__badges">' + badges.join('') + '</span>' +
    '</button>';
  }).join('');

  const fleetItems = fleets.map(function (f) {
    const sysId = (f.location && f.location.systemId >= 0) ? f.location.systemId : -1;
    const sysName = sysId >= 0 ? g.galaxy.systems[sysId].name : '—';
    const status = (f.location && f.location.status) || 'idle';
    const statusLbl = status === 'docked' ? 'attracco' : status === 'in-transit' ? 'transito' : 'orbita';
    const cls = status === 'docked' ? 'ok' : status === 'in-transit' ? 'info' : 'warn';
    const fleetIcon = (ORION.icon && ORION.icon('fleet')) || '';
    return '<button class="lp-item lp-item--fleet" data-action="roster-fleet" data-id="' + escapeHtml(f.id) + '" data-sys="' + sysId + '" type="button">' +
      '<span class="lp-item__glyph ui-icon" aria-hidden="true">' + fleetIcon + '</span>' +
      '<span class="lp-item__name"><strong>' + escapeHtml(f.name) + '</strong> <span class="lp-item__sub">in ' + escapeHtml(sysName) + '</span></span>' +
      '<span class="lp-item__badges"><span class="lp-item__badge lp-item__badge--' + cls + '">' + statusLbl + '</span></span>' +
    '</button>';
  }).join('');

  const rosterBody =
    (myKeys.length ? colItems : '<p class="lp-empty">Nessuna colonia operativa.</p>') +
    (fleets.length ? fleetItems : (myKeys.length ? '<p class="lp-empty">Nessuna flotta attiva.</p>' : ''));
  const rosterCount = myKeys.length + ' colonie · ' + fleets.length + ' flotte';

  /* ----- Navigazione (Galassia/Gruppo/Sistema/Pianeta) ----- */
  const navItems = [
    { view: 'galaxy', icon: 'galaxy', label: 'Galassia' },
    { view: 'group',  icon: 'group',  label: 'Gruppo' },
    { view: 'system', icon: 'system', label: 'Sistema' },
    { view: 'planet', icon: 'planet', label: 'Pianeta' }
  ];
  const navHtml = navItems.map(function (n) {
    const active = (n.view === currentView) ? ' is-active' : '';
    const icon = (ORION.icon && ORION.icon(n.icon)) || '';
    return '<button class="nav-item' + active + '" data-view="' + n.view + '" type="button">' +
      '<span class="nav-item__glyph ui-icon" aria-hidden="true">' + icon + '</span>' +
      '<span class="nav-item__label">' + n.label + '</span></button>';
  }).join('');

  /* ----- Launcher (Diplomazia/Ricerca/Mercato + vista Flotte/Civiltà) ----- */
  function launcherIcon(name) {
    return (ORION.icon && ORION.icon(name)) || '';
  }
  const launcherHtml =
    '<button class="lp-launcher__btn' + (currentView === 'fleet' ? ' is-active' : '') + '" data-view="fleet" type="button">' +
      '<span class="lp-launcher__glyph ui-icon" aria-hidden="true">' + launcherIcon('fleet') + '</span>' +
      '<span>Flotte</span>' +
      '<span class="lp-launcher__sub">' + fleets.length + '</span>' +
    '</button>' +
    '<button class="lp-launcher__btn' + (currentView === 'civ' ? ' is-active' : '') + '" data-view="civ" type="button">' +
      '<span class="lp-launcher__glyph ui-icon" aria-hidden="true">' + launcherIcon('diplomacy') + '</span>' +
      '<span>Diplomazia</span>' +
      '<span class="lp-launcher__sub">' + civsContacted.length + ' contatti</span>' +
    '</button>' +
    '<button class="lp-launcher__btn" data-view="research" type="button">' +
      '<span class="lp-launcher__glyph ui-icon" aria-hidden="true">' + launcherIcon('research') + '</span>' +
      '<span>Ricerca</span>' +
      '<span class="lp-launcher__sub">M13</span>' +
    '</button>' +
    '<button class="lp-launcher__btn" data-view="market" type="button">' +
      '<span class="lp-launcher__glyph ui-icon" aria-hidden="true">' + launcherIcon('market') + '</span>' +
      '<span>Mercato</span>' +
      '<span class="lp-launcher__sub">' + marketLauncherSub() + '</span>' +
    '</button>';

  /* ----- Cronaca (collassabile) -----
     Manteniamo sempre un <ul data-bind="chronicle"> presente nel DOM
     così che pushChronicle/restoreChronicleDom funzionino anche quando
     la lista è vuota al boot. */
  const cron = (g.chronicle || []).slice(0, 40);
  const cronHtml = '<ul class="chronicle__log">' + (cron.length
    ? cron.map(function (e) {
        const mod = e.mod ? ' chronicle__entry--' + e.mod : '';
        return '<li class="chronicle__entry' + mod + '">' + e.html + '</li>';
      }).join('')
    : '<li class="chronicle__entry chronicle__entry--system">Nessuna voce.</li>'
  ) + '</ul>';

  /* Compone le sezioni. */
  const collapsed = ORION.lpSectionCollapsed;
  function sec(id, title, count, body, extraCls) {
    const isCol = !!collapsed[id];
    return '<section class="lp-section ' + (extraCls || '') + (isCol ? ' is-collapsed' : '') + '" data-section="' + id + '">' +
      '<div class="lp-section__head" data-action="lp-toggle" data-id="' + id + '">' +
        '<span class="lp-section__caret"></span>' +
        '<span class="lp-section__title">' + title + '</span>' +
        (count ? '<span class="lp-section__count">' + count + '</span>' : '') +
      '</div>' +
      '<div class="lp-section__body">' + body + '</div>' +
    '</section>';
  }

  /* Titoli sezione: glifo SVG + testo separati per applicare la tinta tematica
     CSS (.lp-section__glyph--*). Migrazione UI_GUIDE §3 strategia B: niente
     più Unicode, ogni glifo è un'icona SVG da ORION.icons (PR-A). */
  function secTitle(glyphCls, iconName, text) {
    const icon = (ORION.icon && ORION.icon(iconName)) || '';
    return '<span class="lp-section__glyph lp-section__glyph--' + glyphCls + ' ui-icon" aria-hidden="true">' + icon + '</span>' +
           '<span class="lp-section__text">' + text + '</span>';
  }

  const chronCollapsed = !!ORION.chronicleCollapsed;
  /* Identità del popolo (decisione #65): banner cliccabile in testa → editor. */
  const emp = ORION.game && ORION.game.empire;
  const empHtml = '<button type="button" class="lp-empire" data-action="empire-edit" title="Rinomina il tuo popolo">' +
    '<span class="lp-empire__name">' + escapeHtml(emp ? formatEmpire(emp) : '—') + '</span>' +
    '<span class="lp-empire__edit" aria-hidden="true">✎</span>' +
  '</button>';
  host.innerHTML =
    empHtml +
    sec('roster',   secTitle('roster', 'roster',     'Roster'),         rosterCount, rosterBody) +
    sec('nav',      secTitle('nav',    'galaxy',     'Navigazione'),    '',          '<nav class="lp-nav">' + navHtml + '</nav>') +
    sec('launcher', secTitle('launch', 'settings',   'Sale e moduli'),  '',          '<div class="lp-launcher">' + launcherHtml + '</div>') +
    '<section class="lp-section lp-section--chron' + (chronCollapsed ? ' is-collapsed' : '') + '" data-section="chronicle">' +
      '<div class="lp-section__head" data-action="lp-toggle-chron">' +
        '<span class="lp-section__caret"></span>' +
        '<span class="lp-section__title">' + secTitle('chron', 'chronicle', 'Cronaca') + '</span>' +
        '<span class="lp-section__count">' + cron.length + '</span>' +
      '</div>' +
      '<div class="lp-section__body" data-bind="chronicle-host">' + cronHtml + '</div>' +
    '</section>';

  /* Mantieni `[data-bind="chronicle"]` valido per pushChronicle/restore:
     ri-tagghiamo l'UL come "chronicle" così le funzioni esistenti continuano
     a funzionare senza modifiche. */
  const ul = host.querySelector('.chronicle__log');
  if (ul) ul.setAttribute('data-bind', 'chronicle');

  /* Identità popolo: click sul banner → editor (decisione #65). */
  const empBtn = host.querySelector('[data-action="empire-edit"]');
  if (empBtn) empBtn.addEventListener('click', openEmpireEditor);

  /* Bind handlers — accordion: aprire una sezione collassa le altre. */
  host.querySelectorAll('[data-action="lp-toggle"]').forEach(function (h) {
    h.addEventListener('click', function () {
      const id = h.dataset.id;
      if (ORION.lpSectionCollapsed[id]) lpAccordionOpen(id);  // era chiusa → aprila sola
      else ORION.lpSectionCollapsed[id] = true;               // era aperta → chiudila
      saveUiPrefs();
      renderLeftPanel();
    });
  });
  const chronHead = host.querySelector('[data-action="lp-toggle-chron"]');
  if (chronHead) chronHead.addEventListener('click', function () {
    if (ORION.chronicleCollapsed) lpAccordionOpen('chronicle');
    else ORION.chronicleCollapsed = true;
    saveUiPrefs();
    renderLeftPanel();
  });
  host.querySelectorAll('[data-view]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const v = btn.dataset.view;
      if (v === 'research' || v === 'market') {
        navigateView(v);
        return;
      }
      navigateView(v);
    });
  });
  host.querySelectorAll('[data-action="roster-colony"]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const k = btn.dataset.key;
      const parts = k.split(':');
      const sid = Number(parts[0]);
      const bk = parts[1];
      navigateView('planet');
      /* navigateView('planet') usa il pianeta natale come default; sostituiamo
         con il pianeta cliccato. */
      if (ORION.openSystemId !== sid) openSystem(sid);
      openPlanet(sid, bk);
    });
  });
  host.querySelectorAll('[data-action="roster-fleet"]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const sid = Number(btn.dataset.sys);
      navigateView('fleet');
      /* Anche se la mappa non è visibile, conserviamo la selezione: utile
         al prossimo ritorno. */
      if (ORION.game && ORION.game.state && sid >= 0) ORION.game.state.selectedId = sid;
    });
  });
}

/* =====================================================================
   Decisione #50 — Plancia Operativa (pannello dx)
   La dx renderizza la scheda della colonia "in focus" (pinned o auto).
   Riusa renderPlanetPanel() esistente swapando temporaneamente
   ORION.openPlanetKey → la dx key, per non duplicare la logica delle tab.
   ===================================================================== */
function renderDxPanel() {
  const g = ORION.game;
  const header = document.querySelector('.panel__header--dx');
  const selectorHost = document.querySelector('[data-bind="dx-selector"]');
  const content = document.querySelector('[data-bind="dx-content"]');
  const title = header ? header.querySelector('.panel__title') : null;
  if (!content) return;

  if (!g) {
    if (title) title.textContent = 'Plancia Operativa';
    if (selectorHost) selectorHost.innerHTML = '';
    content.innerHTML = '<p class="panel__note">Avvia una partita dal menu.</p>';
    return;
  }

  const mine = myColonyKeys();
  if (!mine.length) {
    if (title) title.textContent = 'Plancia Operativa';
    if (selectorHost) selectorHost.innerHTML = '';
    content.innerHTML = '<p class="panel__note">Nessuna colonia operativa. Quando completi l\'Insediamento la colonia comparirà qui.</p>';
    return;
  }

  const dxKey = resolveDxColonyKey();
  if (!dxKey || !g.colonies[dxKey]) {
    content.innerHTML = '<p class="panel__note">Nessuna colonia selezionabile.</p>';
    return;
  }

  /* Renderizza il selector colonia. */
  if (selectorHost) {
    const opts = mine.map(function (k) {
      const c = g.colonies[k];
      const p = planetForColony(c);
      const name = p ? p.name : ('Colonia ' + k);
      const sysId = c.systemId;
      const acr = regionAcronymFor(sysId);
      const tag = acr ? ' [' + acr + ']' : '';
      /* PR-B: dingbat consistenti cross-OS (no emoji codepoints come ⏳).
         ◐ semicircolo per Insediamento, ◌ cerchio puntinato per viaggio,
         ★ stella per capitale/base. */
      let stChip = '';
      if (c.phase === 'settling') stChip = ' ◐';
      else if (c.colonizing) stChip = ' ◌';
      else if (ORION.capital && ORION.capital.isCapital && ORION.capital.isCapital(g, k)) stChip = ' ★';
      else if (c.isHomeBase) stChip = ' ★';
      const sel = (k === dxKey) ? ' selected' : '';
      return '<option value="' + escapeHtml(k) + '"' + sel + '>' + escapeHtml(name + tag + stChip) + '</option>';
    }).join('');
    const pinned = ORION.dxIsPinned;
    /* PR-B: pin button con SVG icon (UI_GUIDE §3). Stato pinned vs free
       differenziato dal colore (ambra = pin, soft = libero) e dalla
       classe is-pinned che il CSS usa per il bordo. */
    const pinIcon = (ORION.icon && ORION.icon('pin')) || '';
    selectorHost.innerHTML =
      '<select class="dx-selector__select" data-action="dx-pick" aria-label="Colonia in focus">' + opts + '</select>' +
      '<button class="dx-selector__pin' + (pinned ? ' is-pinned' : '') + '" data-action="dx-pin-toggle" type="button" ' +
        'title="' + (pinned ? 'Pin attivo — la dx non segue la navigazione' : 'Pin disattivo — segue il pianeta navigato') + '" ' +
        'aria-label="Pin colonia">' +
        '<span class="ui-icon" aria-hidden="true">' + pinIcon + '</span>' +
      '</button>';
    const sel = selectorHost.querySelector('[data-action="dx-pick"]');
    if (sel) sel.addEventListener('change', function () {
      ORION.dxPinnedColonyKey = sel.value;
      ORION.dxIsPinned = true;  /* cambio manuale = pin esplicito */
      saveDxPin();
      renderDxPanel();
      renderLeftPanel();
    });
    const pinBtn = selectorHost.querySelector('[data-action="dx-pin-toggle"]');
    if (pinBtn) pinBtn.addEventListener('click', function () {
      ORION.dxIsPinned = !ORION.dxIsPinned;
      if (ORION.dxIsPinned && !ORION.dxPinnedColonyKey) ORION.dxPinnedColonyKey = dxKey;
      saveDxPin();
      renderDxPanel();
      renderLeftPanel();
    });
  }

  /* Renderizza la scheda della colonia in focus.
     Trucco: renderPlanetPanel() legge ORION.openPlanetKey / currentPlanet
     hardcoded; swapiamo solo durante il render e li ripristiniamo,
     così il centro (canvas) resta indipendente. */
  const colony = g.colonies[dxKey];
  const parts = dxKey.split(':');
  const sysId = Number(parts[0]);
  const bodyKey = parts[1];
  let planet = null;
  if (ORION._planetMemo[dxKey]) planet = ORION._planetMemo[dxKey];
  else {
    try {
      const system = ORION.system.generate(g.galaxy, sysId);
      planet = ORION.planet.generate(g.galaxy, system, bodyKey);
      if (planet) ORION._planetMemo[dxKey] = planet;
    } catch (_) { /* niente */ }
  }
  if (!planet) {
    content.innerHTML = '<p class="panel__note">Errore: impossibile caricare la colonia.</p>';
    return;
  }

  /* Tab dx separata (per non confondersi con quella del centro). */
  if (!ORION.dxTab) ORION.dxTab = 'colonia';

  const savedKey = ORION.openPlanetKey;
  const savedPlanet = ORION.currentPlanet;
  const savedTab = ORION.planetTab;
  ORION.openPlanetKey = dxKey;
  ORION.currentPlanet = planet;
  ORION.planetTab = ORION.dxTab;
  try {
    if (title) {
      title.innerHTML = 'Plancia · ' + escapeHtml(planet.name) + bodyTagHtml(sysId);
    }
    renderPlanetPanel(title || document.createElement('h2'), content);
  } finally {
    /* renderPlanetPanel ha re-bindato i listener di tab a un closure
       che usa ORION.planetTab; salviamo prima di ripristinare. */
    ORION.dxTab = ORION.planetTab;
    ORION.openPlanetKey = savedKey;
    ORION.currentPlanet = savedPlanet;
    ORION.planetTab = savedTab;
  }
  /* I bottoni di tab dentro la dx-content cambiano ORION.planetTab e
     richiamano renderPlanetPanel: dobbiamo intercettare e re-routare a
     renderDxPanel. Sostituiamo i listener. */
  content.querySelectorAll('[data-tab]').forEach(function (btn) {
    const nb = btn.cloneNode(true);
    btn.parentNode.replaceChild(nb, btn);
    nb.addEventListener('click', function () {
      ORION.dxTab = nb.dataset.tab;
      renderDxPanel();
    });
  });

  /* Tutti gli handler che agiscono sulla colonia (tryBuild, tryCancel,
     tryDemolish, tryColonize, tryBuildShip/Crew, tryCancelShip/Crew,
     governor toggle, capital declare, ecc.) leggono ORION.openPlanetKey
     al CLICK. Per far sì che agiscano sulla colonia dx (anche se diversa
     da quella navigata al centro), intercettiamo i bottoni rilevanti e
     wrappiamo l'invocazione con uno swap temporaneo openPlanetKey↔dxKey.
     Capture-phase per arrivare prima dei listener originali. */
  function wrapDxAction(selector) {
    content.querySelectorAll(selector).forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        if (btn._dxWrapped) return;
        ev.stopImmediatePropagation();
      }, true);
    });
  }
  /* Approccio più solido: ri-installiamo i listener click su quei
     bottoni come "in-scope" della dx key. Cloniamo per buttare via tutti
     i listener esistenti, poi ricolleghiamo quelli noti, settando il
     contesto dx prima di chiamare la funzione di gioco. */
  function withDxScope(fn) {
    return function (ev) {
      const sk = ORION.openPlanetKey, sp = ORION.currentPlanet, st = ORION.planetTab;
      ORION.openPlanetKey = dxKey;
      ORION.currentPlanet = planet;
      ORION.planetTab = ORION.dxTab;
      try { fn.call(this, ev); }
      finally {
        ORION.dxTab = ORION.planetTab;
        ORION.openPlanetKey = sk;
        ORION.currentPlanet = sp;
        ORION.planetTab = st;
      }
    };
  }
  function rebind(selector, action) {
    content.querySelectorAll(selector).forEach(function (btn) {
      const nb = btn.cloneNode(true);
      btn.parentNode.replaceChild(nb, btn);
      nb.addEventListener('click', withDxScope(function () {
        action.call(this, nb);
        /* Dopo l'azione, ridisegna la dx per riflettere lo stato. */
        renderDxPanel();
      }));
    });
  }
  rebind('[data-build]',    function (b) { tryBuild(b.dataset.build); });
  rebind('[data-cancel]',   function (b) { tryCancel(Number(b.dataset.cancel)); });
  rebind('[data-demolish]', function (b) { tryDemolish(b.dataset.demolish); });
  rebind('[data-action="colonize"]', function () { tryColonize(planet); });
  rebind('[data-cancel-ship]', function (b) { tryCancelShip(Number(b.dataset.cancelShip)); });
  rebind('[data-cancel-crew]', function (b) { tryCancelCrew(Number(b.dataset.cancelCrew)); });
  rebind('[data-action="build-ship"]', function () { tryBuildShip(); });
  rebind('[data-action="build-crew"]', function () { tryBuildCrew(); });
  rebind('[data-action="capital-declare"]', function () {
    /* Il bind originale di capital-declare contiene logica complessa
       (confirm, pushChronicle); per riusarlo intero, lo richiamiamo dal
       bindCapitalHandlers. Re-installiamo: */
    bindCapitalHandlers(content, planet, colony);
    /* Triggera click del nuovo bottone (è già stato sostituito sopra,
       quindi questo è no-op se il flusso è completato — fallback). */
  });
  /* Governor toggle/dropdowns (decisione #59 Tier 2): rebind diretto. */
  content.querySelectorAll('[data-action="gov-toggle"]').forEach(function (chk) {
    const nb = chk.cloneNode(true);
    chk.parentNode.replaceChild(nb, chk);
    nb.addEventListener('change', withDxScope(function () {
      if (!ORION.governor) return;
      ORION.governor.setEnabled(colony, nb.checked);
      if (nb.checked && ORION.tutorial) ORION.tutorial.fire('governor');
      if (ORION.save && ORION.save.autosave && ORION.game) ORION.save.autosave(ORION.game);
      renderDxPanel();
    }));
  });
  content.querySelectorAll('[data-action="gov-level"]').forEach(function (sel) {
    const nb = sel.cloneNode(true);
    sel.parentNode.replaceChild(nb, sel);
    nb.addEventListener('change', withDxScope(function () {
      if (!ORION.governor) return;
      ORION.governor.setLevel(colony, nb.value);
      if (nb.value !== 'off' && ORION.tutorial) ORION.tutorial.fire('governor');
      if (ORION.save && ORION.save.autosave && ORION.game) ORION.save.autosave(ORION.game);
      renderDxPanel();
    }));
  });
  content.querySelectorAll('[data-action="gov-vocation"]').forEach(function (sel) {
    const nb = sel.cloneNode(true);
    sel.parentNode.replaceChild(nb, sel);
    nb.addEventListener('change', withDxScope(function () {
      if (!ORION.governor) return;
      ORION.governor.setVocation(colony, nb.value);
      if (ORION.tutorial) ORION.tutorial.fire('governor-vocation');
      if (ORION.save && ORION.save.autosave && ORION.game) ORION.save.autosave(ORION.game);
      renderDxPanel();
    }));
  });
  content.querySelectorAll('[data-action="gov-suspend"]').forEach(function (btn) {
    const nb = btn.cloneNode(true);
    btn.parentNode.replaceChild(nb, btn);
    nb.addEventListener('click', withDxScope(function () {
      if (!ORION.governor) return;
      ORION.governor.setLevel(colony, 'vigile');
      if (ORION.save && ORION.save.autosave && ORION.game) ORION.save.autosave(ORION.game);
      renderDxPanel();
    }));
  });
}

/* =====================================================================
   Decisione #50 — Action bar contestuale (centro, sopra/sotto la scena)
   Mostra azioni rilevanti per ciò che stai guardando:
     - pianeta libero colonizzabile → "Colonizza"
     - pianeta AI                   → "Apri dossier" / disabili: Diplomazia/Spionaggio/Attacca
     - mio pianeta                  → niente (la dx fa già il resto)
     - sistema/galassia             → niente
   ===================================================================== */
function renderContextActionBar(ctx) {
  const host = document.querySelector('[data-bind="action-bar"]');
  if (!host) return;
  const g = ORION.game;
  if (!g) { host.hidden = true; host.innerHTML = ''; return; }

  /* PR-D helper: emette uno <span class="ui-icon"> con SVG inline +
     tinta. Tonalità per i bottoni dell'action bar segue UI_GUIDE §1. */
  function icnHtml(name, tone) {
    const svg = (ORION.icon && ORION.icon(name)) || '';
    const cls = tone ? (' ui-icon--' + tone) : '';
    return '<span class="ui-icon' + cls + '" aria-hidden="true">' + svg + '</span>';
  }

  const buttons = [];
  if (ctx && ctx.level === 'planet' && ORION.currentPlanet) {
    const sysId = ctx.systemId;
    const planet = ORION.currentPlanet;
    const colKey = sysId + ':' + planet.bodyKey;
    const colony = g.colonies[colKey];
    const civ = (ORION.ai && ORION.ai.civForSystem) ? ORION.ai.civForSystem(g, sysId) : null;
    const isMine = !!(colony && colony.colonized);
    const isForeign = !!(civ && !isMine);
    const isFree = !isMine && !isForeign;
    const def = ORION.system && ORION.system.BODY_TYPES ? ORION.system.BODY_TYPES[planet.type] : null;
    const habitable = !!(def && def.habitable);

    if (isFree && habitable && !colony.colonizing && !colony.colonized) {
      /* Bottone Colonizza prominente. Controllo costi/eccezione §6.2
         replicato dalla scheda. */
      const home = g.colonies[g.homePlanetKey];
      const homeColonized = !!(home && home.colonized);
      const homeInTrouble = !!(home && home._scar &&
        (home._scar.food.state === 'crit' || home._scar.water.state === 'crit'));
      const costMul = (homeColonized && !colony.isHomeBase && !homeInTrouble) ? 5 : 1;
      const cost = planet.colCost;
      const stockHome = homeColonized ? home.stock : { met: 0, en: 0, food: 0, water: 0 };
      const canPay =
        stockHome.met   >= cost.met   * costMul &&
        stockHome.en    >= cost.en    * costMul &&
        stockHome.water >= cost.water * costMul &&
        stockHome.food  >= cost.food  * costMul;
      const tooltip = canPay
        ? 'Avvia spedizione coloniale (' + cost.impulsi + ' ' + iU() + ')'
        : 'Risorse insufficienti sulla colonia base' + (costMul > 1 ? ' (×' + costMul + ' per produttiva)' : '');
      buttons.push('<button class="actionbar__btn actionbar__btn--primary btn--with-icon" data-action="ctx-colonize"' +
        (canPay ? '' : ' disabled') + ' title="' + escapeHtml(tooltip) + '">' +
        icnHtml('build', 'cyan') + ' Colonizza ' + escapeHtml(planet.name) + '</button>');
    } else if (isForeign) {
      buttons.push('<button class="actionbar__btn actionbar__btn--primary btn--with-icon" data-action="ctx-civ-dossier" data-civ="' + escapeHtml(civ.id) + '">' +
        icnHtml('civ', 'pink') + ' Apri dossier civiltà</button>');
      /* M11 (#51): diplomazia attiva — apre la vista Civiltà sulle proposte. */
      buttons.push('<button class="actionbar__btn btn--with-icon" data-action="ctx-diplomacy" data-civ="' + escapeHtml(civ.id) + '" title="Apri la diplomazia con questa civiltà">' +
        icnHtml('diplomacy', 'pink') + ' Diplomazia</button>');
      /* M09 (decisione #49): attacco offensivo. Abilitato se c'è almeno una
         flotta armata che può raggiungere il sistema. */
      const strikers = attackCapableFleets(g, sysId);
      if (strikers.length) {
        buttons.push('<button class="actionbar__btn actionbar__btn--danger btn--with-icon" data-action="ctx-attack" data-sys="' + sysId + '" data-civ="' + escapeHtml(civ.id) + '" title="Ordina a una flotta armata di attaccare questo sistema">' +
          icnHtml('sword', 'pink') + ' Attacca</button>');
      } else {
        buttons.push('<button class="actionbar__btn btn--with-icon" disabled title="Serve una flotta armata che possa raggiungere il sistema">' +
          icnHtml('sword', 'soft') + ' Attacca</button>');
      }
      buttons.push('<button class="actionbar__btn btn--with-icon" disabled title="Richiede M19 Spionaggio">' +
        icnHtml('spy', 'violet') + ' Pianifica spionaggio (M19)</button>');
    }
  }

  if (!buttons.length) { host.hidden = true; host.innerHTML = ''; return; }
  host.innerHTML = buttons.join('');
  host.hidden = false;
  /* Handlers */
  const cBtn = host.querySelector('[data-action="ctx-colonize"]');
  if (cBtn) cBtn.addEventListener('click', function () {
    if (ORION.currentPlanet) tryColonize(ORION.currentPlanet);
  });
  const dBtn = host.querySelector('[data-action="ctx-civ-dossier"]');
  if (dBtn) dBtn.addEventListener('click', function () { navigateView('civ'); });
  const dipBtn = host.querySelector('[data-action="ctx-diplomacy"]');
  if (dipBtn) dipBtn.addEventListener('click', function () { navigateView('civ'); });
  const aBtn = host.querySelector('[data-action="ctx-attack"]');
  if (aBtn) aBtn.addEventListener('click', function () {
    openAttackPicker(parseInt(aBtn.dataset.sys, 10), aBtn.dataset.civ);
  });
}

/* M09 (decisione #49): flotte armate (fp>0) che possono raggiungere `sysId`
   da dove si trovano (docked/orbiting, non in volo). */
function attackCapableFleets(g, sysId) {
  const out = [];
  const F = ORION.fleet;
  if (!F) return out;
  (g.fleets || []).forEach(function (f) {
    if (!f || !f.location || f.location.status === 'in-transit') return;
    const armed = (f.ships || []).some(function (s) {
      const c = F.getClass(s.kind); return c && (c.fp || 0) > 0;
    });
    if (!armed) return;
    if (F.computePath(g.galaxy, f.location.systemId, sysId)) out.push(f);
  });
  return out;
}

/* =====================================================================
   M08 polish (decisione #61) — drag&drop dal canvas per ordinare flotte.
   Click su marker flotta → modalità picker → click su sistema target →
   applica ordine (default move, Shift=attack, Alt=explore). Esc annulla.
   Stato volatile in ORION._fleetPickerMode (non salvato).
   ===================================================================== */
function enterFleetPicker(fleetId) {
  const g = ORION.game;
  if (!g) return;
  const fleet = (g.fleets || []).filter(function (f) { return f.id === fleetId; })[0];
  if (!fleet) return;
  /* BFS dei sistemi raggiungibili dalla posizione corrente della flotta. */
  const F = ORION.fleet;
  if (!F) return;
  const from = fleet.location && fleet.location.systemId;
  if (from == null) return;
  const reachable = new Set();
  const sys = g.galaxy.systems;
  for (let i = 0; i < sys.length; i++) {
    if (i === from) continue;
    if (F.computePath(g.galaxy, from, i)) reachable.add(i);
  }
  ORION._fleetPickerMode = { fleetId: fleetId, fleetName: fleet.name };
  if (ORION.map && ORION.map.setFleetPickerMode) {
    ORION.map.setFleetPickerMode(fleetId, reachable);
  }
  showFleetPickerHint(fleet);
}

function exitFleetPicker(silent) {
  ORION._fleetPickerMode = null;
  if (ORION.map && ORION.map.setFleetPickerMode) {
    ORION.map.setFleetPickerMode(null);
  }
  hideFleetPickerHint();
  if (!silent) showToast('Modalità ordini annullata');
}

function showFleetPickerHint(fleet) {
  hideFleetPickerHint();
  const node = document.createElement('div');
  node.className = 'fleet-picker-hint';
  node.id = 'fleet-picker-hint';
  node.innerHTML = '<strong>' + escapeHtml(fleet.name) + '</strong>' +
    ' — click su un sistema per dare l\'ordine · ' +
    '<kbd>Shift</kbd>=attacca · <kbd>Alt</kbd>=esplora · <kbd>Esc</kbd>=annulla';
  document.body.appendChild(node);
}

function hideFleetPickerHint() {
  const ex = document.getElementById('fleet-picker-hint');
  if (ex && ex.parentNode) ex.parentNode.removeChild(ex);
}

function applyFleetOrderFromMap(req) {
  const g = ORION.game;
  if (!g || !req) return;
  const fleet = (g.fleets || []).filter(function (f) { return f.id === req.fleetId; })[0];
  if (!fleet) { exitFleetPicker(true); return; }
  const F = ORION.fleet;
  if (!F) { exitFleetPicker(true); return; }
  const sysId = req.sysId;
  const sys = g.galaxy.systems[sysId];
  if (!sys) { exitFleetPicker(true); return; }

  /* Validazione raggiungibilità. */
  if (!F.computePath(g.galaxy, fleet.location.systemId, sysId)) {
    showToast('Sistema non raggiungibile');
    return; /* resta in picker mode → l'utente può scegliere un altro target */
  }

  /* Determina il tipo ordine dai modifiers. Shift=attack, Alt=explore, default=move. */
  let order;
  let orderLabelText;
  if (req.shiftKey) {
    /* Attack richiede potenza di fuoco. */
    const fp = (fleet.ships || []).reduce(function (a, s) {
      const c = F.getClass(s.kind); return a + (c ? c.fp || 0 : 0);
    }, 0);
    if (fp <= 0) {
      showToast('Flotta disarmata: non può attaccare');
      return;
    }
    order = { type: 'attack', toSysId: sysId };
    orderLabelText = 'attacco';
  } else if (req.altKey) {
    /* Explore: rifiuta sistemi già EXPLORED. */
    const discovery = g.state && g.state.discovery;
    const EXPLORED = ORION.galaxy && ORION.galaxy.DISCOVERY && ORION.galaxy.DISCOVERY.EXPLORED;
    if (discovery && EXPLORED != null && discovery[sysId] === EXPLORED) {
      showToast('Sistema già esplorato');
      return;
    }
    order = { type: 'explore', toSysId: sysId };
    orderLabelText = 'esplorazione';
  } else {
    order = { type: 'move', toSysId: sysId };
    orderLabelText = 'rotta';
  }

  const r = F.setOrder(g, fleet, order);
  if (!r.ok) {
    showToast(r.reason || 'Ordine rifiutato');
    return;
  }
  pushChronicle(ORION.time.currentDS(g) + ' — Ordine via mappa: <strong>' +
    escapeHtml(fleet.name) + '</strong> · ' + orderLabelText + ' verso <strong>' +
    escapeHtml(sys.name) + '</strong>.', 'system');
  persistGame(g);
  exitFleetPicker(true);
  showToast(fleet.name + ' · ' + orderLabelText);
  if (ORION.map && ORION.map.requestRender) ORION.map.requestRender();
  /* Refresh sidebar che mostra l'ordine. */
  if (typeof renderLeftPanel === 'function') renderLeftPanel();
}

/* Overlay di scelta flotta per un attacco offensivo su un sistema AI. */
function openAttackPicker(sysId, civId) {
  const g = ORION.game;
  const sys = g.galaxy.systems[sysId];
  const civ = (g.civs || []).filter(function (c) { return c.id === civId; })[0];
  const fleets = attackCapableFleets(g, sysId);
  if (!fleets.length) { showToast('Nessuna flotta armata può raggiungere il sistema'); return; }
  const aggressive = civ && civ.alignment !== 'male';   // verbo morale dark
  const F = ORION.fleet;
  const rows = fleets.map(function (f) {
    const path = F.computePath(g.galaxy, f.location.systemId, sysId);
    const hops = path ? path.length - 1 : 0;
    const fp = (f.ships || []).reduce(function (a, s) { const c = F.getClass(s.kind); return a + (c ? c.fp || 0 : 0); }, 0);
    return '<button class="attack-pick__row" data-fleet="' + escapeHtml(f.id) + '" type="button">' +
      '<span class="attack-pick__name">' + escapeHtml(f.name) + '</span>' +
      '<span class="attack-pick__meta">' + (f.ships || []).length + ' navi · fp ' + fp + ' · ' + hops + ' salti</span>' +
    '</button>';
  }).join('');
  const html =
    '<div class="attack-overlay" data-attack-overlay>' +
      '<div class="attack-overlay__panel">' +
        '<header class="attack-overlay__head"><h3>' +
          '<span class="ui-icon ui-icon--pink" aria-hidden="true">' + ((ORION.icon && ORION.icon('sword')) || '') + '</span> ' +
          'Attacca ' + escapeHtml(sys ? sys.name : 'sistema') +
        '</h3>' +
          '<button class="attack-overlay__x" data-attack-close type="button" aria-label="Chiudi">' +
            '<span class="ui-icon" aria-hidden="true">' + ((ORION.icon && ORION.icon('close')) || '✕') + '</span>' +
          '</button></header>' +
        '<p class="attack-overlay__sub">Bersaglio: <strong>' + escapeHtml(civ ? civ.name : '—') + '</strong>' +
          (aggressive ? ' · <span class="attack-warn">aggressione contro una civiltà non ostile → reputazione oscura</span>' : ' · liberazione di un sistema maligno → reputazione luminosa') + '</p>' +
        '<div class="attack-pick__list">' + rows + '</div>' +
        '<p class="attack-overlay__hint">La flotta scelta partirà in rotta; lo scontro si risolve all\'arrivo nel sistema.</p>' +
      '</div>' +
    '</div>';
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  const node = wrap.firstChild;
  document.body.appendChild(node);
  function close() { if (node.parentNode) node.parentNode.removeChild(node); }
  node.querySelector('[data-attack-close]').addEventListener('click', close);
  node.addEventListener('click', function (e) { if (e.target === node) close(); });
  node.querySelectorAll('[data-fleet]').forEach(function (b) {
    b.addEventListener('click', function () {
      const fleet = (g.fleets || []).filter(function (f) { return f.id === b.dataset.fleet; })[0];
      if (!fleet) { close(); return; }
      const r = ORION.fleet.setOrder(g, fleet, { type: 'attack', toSysId: sysId });
      if (!r.ok) { showToast(r.reason || 'Ordine rifiutato'); return; }
      pushChronicle(ORION.time.currentDS(g) + ' — Ordine d\'attacco: <strong>' + escapeHtml(fleet.name) +
        '</strong> in rotta verso <strong>' + (sys ? sys.name : '—') + '</strong>' +
        (sysId >= 0 ? systemTagHtml(sysId) : '') + ' (' + escapeHtml(civ ? civ.name : '—') + ').', 'system');
      persistGame(g);
      close();
      if (ORION.map && ORION.map.requestRender) ORION.map.requestRender();
      showToast(fleet.name + ' in rotta d\'attacco');
    });
  });
}

/* =====================================================================
   Decisione #50 — Foreign Planet overlay (Punto 3)
   Quando il pianeta navigato appartiene a una civiltà AI: mostra una
   scheda read-only sopra la sfera (viola/grigia) con info pubbliche +
   stima impero + placeholder spionaggio. Niente azioni dirette (vivono
   nell'action bar al centro).
   ===================================================================== */
function refreshForeignDeck() {
  const root = document.querySelector('.galaxy-root');
  if (!root) return;
  /* Smonta sempre prima — se non più applicabile, rimane smontato. */
  const existing = root.querySelector('.deck-foreign');
  if (existing) existing.remove();
  const g = ORION.game;
  if (!g || !ORION.currentPlanet || !ORION.currentSystem) return;
  const sysId = ORION.currentSystem.id;
  const planet = ORION.currentPlanet;
  const colKey = sysId + ':' + planet.bodyKey;
  const colony = g.colonies[colKey];
  if (colony && colony.colonized) return;  /* mio: nessun foreign deck */
  if (!ORION.ai || !ORION.ai.civForSystem) return;
  const civ = ORION.ai.civForSystem(g, sysId);
  if (!civ) return;  /* pianeta libero: nessun foreign deck (action bar gestisce) */

  /* Mostra solo se DETECTED o EXPLORED — nebbia di guerra (#11). */
  const disc = g.state.discovery[sysId];
  if (disc == null || disc < (ORION.galaxy.DISCOVERY.DETECTED)) return;

  const ALIGN_LABEL = { bene: 'Bene', male: 'Male', neutrale: 'Neutrale' };
  const seat = (g.galaxy.groups || []).find(function (gp) { return gp.id === civ.homeGroupId; }) || {};
  const ptier = ORION.ai.powerTier ? ORION.ai.powerTier(civ.power || 0) : '—';
  const known = ORION.ai.knownSystemsCount ? ORION.ai.knownSystemsCount(g, civ) : civ.systems.length;
  const def = ORION.system.BODY_TYPES[planet.type];
  const tier = (g.galaxy.groups || []).find(function (gp) { return gp.id === g.galaxy.systems[sysId].cluster; }) || {};
  /* Stima a banda della struttura nemica — coarse (nebbia di guerra
     per le strutture interne). */
  const lo = Math.max(1, known);
  const hi = Math.max(lo + 1, known * 2);

  const html =
    '<div class="deck-foreign colony-deck--foreign" style="--civ-color:' + escapeHtml(civ.color) + '">' +
      '<div class="deck-foreign__head">' +
        '<span class="deck-foreign__swatch" aria-hidden="true"></span>' +
        '<span class="deck-foreign__name">' + escapeHtml(civ.name) + '</span>' +
        '<span class="deck-foreign__chip">' + (ALIGN_LABEL[civ.alignment] || civ.alignment) + '</span>' +
        '<span class="deck-foreign__chip">' + escapeHtml(civ.traitLabel || '—') + '</span>' +
      '</div>' +
      /* PR-D: emoji sostituiti da SVG inline (UI_GUIDE §3 strategia B).
         Cross-OS rendering consistente, glow morbido coerente. */
      '<section class="deck-foreign__section">' +
        '<h4><span class="ui-icon ui-icon--blue deck-foreign__h4-icon" aria-hidden="true">' + ((ORION.icon && ORION.icon('info')) || '') + '</span> Info pubbliche</h4>' +
        '<div class="deck-foreign__row"><span class="deck-foreign__k">Tipo corpo</span><span class="deck-foreign__v">' + escapeHtml(def ? def.label : planet.type) + '</span></div>' +
        '<div class="deck-foreign__row"><span class="deck-foreign__k">Regione</span><span class="deck-foreign__v">' + escapeHtml(tier.name || '—') + ' · ' + escapeHtml(tier.tierLabel || '—') + '</span></div>' +
        '<div class="deck-foreign__row"><span class="deck-foreign__k">Proprietario</span><span class="deck-foreign__v">' + escapeHtml(civ.name) + '</span></div>' +
      '</section>' +
      '<section class="deck-foreign__section">' +
        '<h4><span class="ui-icon ui-icon--gold deck-foreign__h4-icon" aria-hidden="true">' + ((ORION.icon && ORION.icon('resources')) || '') + '</span> Stima impero</h4>' +
        '<div class="deck-foreign__row"><span class="deck-foreign__k">Potenza percepita</span><span class="deck-foreign__v">' + escapeHtml(ptier) + '</span></div>' +
        '<div class="deck-foreign__row"><span class="deck-foreign__k">Sistemi noti</span><span class="deck-foreign__v">' + known + '</span></div>' +
        '<div class="deck-foreign__row"><span class="deck-foreign__k">Sede</span><span class="deck-foreign__v">' + escapeHtml(seat.name || '—') + '</span></div>' +
        '<div class="deck-foreign__row"><span class="deck-foreign__k">Struttura stimata</span><span class="deck-foreign__v">tra ' + lo + ' e ' + hi + ' insediamenti</span></div>' +
      '</section>' +
      '<section class="deck-foreign__section">' +
        '<h4><span class="ui-icon ui-icon--violet deck-foreign__h4-icon" aria-hidden="true">' + ((ORION.icon && ORION.icon('spy')) || '') + '</span> Intel dettagliato</h4>' +
        '<div class="deck-foreign__placeholder">Spionaggio (M19) — richiede una missione di intel attiva su questo mondo.</div>' +
      '</section>' +
    '</div>';
  root.insertAdjacentHTML('beforeend', html);
}

/* Suggerimento contestuale in fondo alla mappa. */
function setGalaxyHint(mode) {
  const el = document.querySelector('.galaxy-hint');
  if (!el) return;
  if (mode === 'planet')
    el.textContent = 'Trascina · zoom rotella/pinch · click sulle lune per aprirle · doppio click nel vuoto per uscire';
  else if (mode === 'system')
    el.textContent = 'Trascina · zoom rotella/pinch · click su un oggetto per i dati · doppio click su un corpo per aprirlo · doppio click nel vuoto per uscire';
  else
    el.textContent = 'Trascina · zoom rotella/pinch · Shift+trascina = ruota libera · Alt+trascina = roll · pinch a 2 dita ruota su touch';
}

/* Colori per UI (riusano la stessa logica della mappa). */
function groupCss(id) {
  const C = ['#2fe6e0', '#8a6cff', '#ff9d3c', '#d6457f', '#ffb000', '#5cc8ff', '#9d7bff', '#ff6f5c'];
  return C[((id % C.length) + C.length) % C.length];
}
function starCss(g, starId) {
  const t = g.galaxy.starTypes.find((s) => s.id === starId);
  return t ? t.color : '#ffffff';
}

/* ---------------------------------------------------------------------
   HUD / Cronaca
   --------------------------------------------------------------------- */
function setHudDate(ds) {
  const el = document.querySelector('[data-bind="data-stellare"]');
  if (!el) return;
  /* PR-H: se è disponibile la versione HTML colorata, usiamo innerHTML;
     altrimenti fallback a textContent (sicuro per stringhe). */
  if (ORION && ORION.time && ORION.time.currentDSHtml && ORION.game) {
    el.innerHTML = ORION.time.currentDSHtml(ORION.game);
  } else {
    el.textContent = ds;
  }
}

/* Stoppa il timer alla chiusura della partita per non avere advance
   in background dopo "Nuova partita" / Esc al main menu (decisione #31). */
function stopTimerIfRunning() {
  if (ORION && ORION.timer && ORION.timer.playing) {
    try { stopPlay(); } catch (_) { /* niente */ }
  }
}

/* Log limitato agli ultimi N (decisione #5): unica fonte di crescita
   illimitata della cronaca, quindi capata. Più recente in cima.
   M06: la cronaca è persistita nel save (decisione #24) — ogni push
   aggiorna sia il DOM che `game.chronicle[]`. */
const MAX_CHRONICLE = 40;

function resetChronicle(galaxy, startDS) {
  ORION.lastChronicleId = -1;
  const home = galaxy.systems[galaxy.homeId];
  const homeGrp = galaxy.groups.find(function (gp) { return gp.id === galaxy.homeGroupId; });
  const homeTag = homeGrp && homeGrp.acronym ? ' <span class="name-tag">[' + homeGrp.acronym + ']</span>' : '';
  const html = startDS + ' — Galassia generata: ' + galaxy.count + ' sistemi. ' +
    'Origine nel sistema <strong>' + home.name + '</strong>' + homeTag + '.';
  if (ORION.game) ORION.game.chronicle = [{ html: html, mod: 'system' }];
  const log = document.querySelector('[data-bind="chronicle"]');
  if (!log) return;
  log.innerHTML =
    '<li class="chronicle__entry chronicle__entry--system">' + html + '</li>';
}

function pushChronicle(html, modifier) {
  /* Persist nel game state: il DOM lo ricaviamo, ma la fonte di verità
     per il save (e il replay dopo F5) è game.chronicle[]. */
  if (ORION.game) {
    if (!Array.isArray(ORION.game.chronicle)) ORION.game.chronicle = [];
    ORION.game.chronicle.unshift({ html: html, mod: modifier || '' });
    if (ORION.game.chronicle.length > MAX_CHRONICLE) {
      ORION.game.chronicle.length = MAX_CHRONICLE;
    }
  }
  const log = document.querySelector('[data-bind="chronicle"]');
  if (!log) return;
  const li = document.createElement('li');
  li.className = 'chronicle__entry' + (modifier ? ' chronicle__entry--' + modifier : '');
  li.innerHTML = html;
  log.insertBefore(li, log.firstChild);
  while (log.children.length > MAX_CHRONICLE) log.removeChild(log.lastChild);
}

/* M06: ripristina la cronaca persistita nel DOM dopo un load/import.
   Ordine: più recente in cima (identico al runtime). */
function restoreChronicleDom(game) {
  const log = document.querySelector('[data-bind="chronicle"]');
  if (!log || !game || !Array.isArray(game.chronicle)) return;
  log.innerHTML = game.chronicle.map(function (e) {
    const mod = e.mod ? ' chronicle__entry--' + e.mod : '';
    return '<li class="chronicle__entry' + mod + '">' + e.html + '</li>';
  }).join('');
}

/* Annota in cronaca l'ingresso in un sistema, coerente con la nebbia di
   guerra §5.1. Il game loop temporale è M05: per ora usa la Data Stellare
   d'inizio. Evita doppioni consecutivi sullo stesso sistema. */
function chronicleSystemEntry(system, disc) {
  if (ORION.lastChronicleId === system.id) return;
  ORION.lastChronicleId = system.id;
  const DISCOVERY = ORION.galaxy.DISCOVERY;
  const ds = ORION.time.currentDS(ORION.game);
  const n = system.bodies.length;
  let text, mod;
  if (disc >= DISCOVERY.EXPLORED) {
    text = ds + ' — Ingresso nel sistema <strong>' + system.name + '</strong>' + systemTagHtml(system.id) + ' · ' +
      system.stars.label + ' · ' + n + ' corpi celesti.';
    mod = 'explore';
  } else if (disc >= DISCOVERY.DETECTED) {
    text = ds + ' — Avvicinamento a <strong>' + system.name + '</strong>' + systemTagHtml(system.id) + ' · sensori a lungo raggio: ' +
      n + ' corpi rilevati, interno da scansionare.';
    mod = 'system';
  } else {
    text = ds + ' — Rotta verso un sistema ignoto · richiede esplorazione.';
    mod = 'system';
  }
  pushChronicle(text, mod);
}

/* ---------------------------------------------------------------------
   M06 — Pannello salvataggi (slot multipli, export/import, nuova partita)
   --------------------------------------------------------------------- */
function initSaveControls() {
  const openBtn = document.querySelector('[data-action="open-save"]');
  if (openBtn) openBtn.addEventListener('click', openSaveModal);
  const modal = document.querySelector('[data-bind="save-modal"]');
  if (!modal) return;
  modal.addEventListener('click', function (e) {
    if (e.target === modal || e.target.matches('[data-action="save-close"]')) {
      closeSaveModal();
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !modal.hasAttribute('hidden')) closeSaveModal();
  });
}

function openSaveModal() {
  const modal = document.querySelector('[data-bind="save-modal"]');
  if (!modal) return;
  modal.removeAttribute('hidden');
  renderSaveModal();
  /* M06.6: tutorial — prima apertura del pannello salvataggi. */
  if (ORION.tutorial) ORION.tutorial.fire('save');
}
function closeSaveModal() {
  const modal = document.querySelector('[data-bind="save-modal"]');
  if (modal) modal.setAttribute('hidden', '');
}

function renderSaveModal() {
  const body = document.querySelector('[data-bind="save-body"]');
  if (!body) return;
  const data = ORION.save.list();
  const ironman = ORION.save.isIronman(ORION.game);

  /* Autosave (sempre visibile, sempre caricabile — anche in ironman) */
  const auto = data.autosave;
  let html = '<section class="save-section">' +
    '<h3 class="save-section__title">Autosave</h3>' +
    (auto ? saveCardHtml(auto, { canLoad: true, canSave: false, canErase: false, isAuto: true })
          : '<p class="save-empty">Nessun autosave ancora. Avvia il tempo o costruisci qualcosa.</p>') +
    '</section>';

  /* Slot manuali (5). Nascosti in ironman (decisione #23/#24).
     Dal main menu (game null) si può solo caricare/cancellare —
     niente salva/sovrascrivi (decisione #25). */
  const canSave = !!ORION.game;
  if (!ironman) {
    html += '<section class="save-section">' +
      '<h3 class="save-section__title">Slot manuali (5)</h3>' +
      '<ul class="save-grid">';
    for (let i = 0; i < ORION.save.MAX_MANUAL_SLOTS; i++) {
      const slot = data.slots[i];
      html += '<li class="save-grid__item">' +
        (slot
          ? saveCardHtml(slot, { canLoad: true, canSave: canSave, canErase: true })
          : (canSave ? emptySlotHtml(i) : emptySlotHtmlReadOnly(i))) +
        '</li>';
    }
    html += '</ul></section>';
  } else {
    html += '<section class="save-section">' +
      '<h3 class="save-section__title">Slot manuali</h3>' +
      '<p class="save-empty">Modalità Ironman: solo autosave + export/import .json.</p>' +
      '</section>';
  }

  /* Export/Import + Nuova partita. Export richiede una partita corrente;
     "Nuova partita" rimanda al main menu (decisione #25) e ha senso solo
     da dentro partita (altrimenti il main menu è già aperto). */
  const hasGame = !!ORION.game;
  html += '<section class="save-section save-section--actions">' +
    (hasGame ? '<button class="btn btn--with-icon" data-action="save-export" type="button">' +
      uiIcon('save', 'cyan') + ' Esporta .json</button>' : '') +
    '<button class="btn btn--with-icon" data-action="save-import" type="button">' +
      uiIcon('folder', 'cyan') + ' Importa .json</button>' +
    (hasGame ? '<button class="btn btn--with-icon btn--danger" data-action="save-newgame" type="button">' +
      uiIcon('plus', 'amber') + ' Nuova partita</button>' : '') +
    '</section>';

  body.innerHTML = html;
  attachSaveModalHandlers(body);
}

function saveCardHtml(meta, perms) {
  const ds = meta.ds || 'DS —';
  const date = meta.ts ? new Date(meta.ts).toLocaleString() : '—';
  const preset = meta.preset ? ' · ' + meta.preset : '';
  const buttons = [];
  if (perms.canLoad) buttons.push('<button class="btn btn--mini" data-action="save-load" data-idx="' + meta.idx + '" type="button">Carica</button>');
  if (perms.canSave) buttons.push('<button class="btn btn--mini" data-action="save-overwrite" data-idx="' + meta.idx + '" type="button">Sovrascrivi</button>');
  if (perms.canErase) buttons.push('<button class="btn btn--mini" data-action="save-erase" data-idx="' + meta.idx + '" type="button">Cancella</button>');
  /* PR-F: icone tematiche per i metadati save (UI_GUIDE §3). */
  return '<div class="save-card' + (perms.isAuto ? ' save-card--auto' : '') + '">' +
    '<div class="save-card__name">' +
      (perms.isAuto ? uiIcon('refresh', 'cyan') + ' ' : uiIcon('tag', 'amber') + ' ') +
      escapeHtml(meta.name) +
    '</div>' +
    '<dl class="save-card__meta">' +
      (meta.empire ? '<div><dt>Popolo</dt><dd><strong>' + escapeHtml(meta.empire) + '</strong></dd></div>' : '') +
      (meta.galaxyName ? '<div><dt>Galassia</dt><dd><strong>' + escapeHtml(meta.galaxyName) + '</strong></dd></div>' : '') +
      '<div><dt>' + uiIcon('clock', 'soft') + ' Data Stellare</dt><dd>' + ds + '</dd></div>' +
      '<div><dt>Seed</dt><dd><code>' + escapeHtml(meta.seed) + '</code></dd></div>' +
      '<div><dt>Colonie</dt><dd>' + meta.colonies + '</dd></div>' +
      '<div><dt>Modalità</dt><dd>' + escapeHtml(meta.mode) + preset + '</dd></div>' +
      '<div><dt>Salvato</dt><dd>' + date + '</dd></div>' +
    '</dl>' +
    '<div class="save-card__actions">' + buttons.join('') + '</div>' +
    '</div>';
}

function emptySlotHtml(idx) {
  return '<div class="save-card save-card--empty">' +
    '<div class="save-card__name">Slot ' + (idx + 1) + ' — vuoto</div>' +
    '<div class="save-card__actions">' +
      '<button class="btn btn--mini" data-action="save-new" data-idx="' + idx + '" type="button">Salva qui</button>' +
    '</div>' +
    '</div>';
}
function emptySlotHtmlReadOnly(idx) {
  return '<div class="save-card save-card--empty">' +
    '<div class="save-card__name">Slot ' + (idx + 1) + ' — vuoto</div>' +
    '</div>';
}

function attachSaveModalHandlers(root) {
  root.querySelectorAll('[data-action="save-load"]').forEach(function (b) {
    b.addEventListener('click', function () { handleLoad(Number(b.dataset.idx)); });
  });
  root.querySelectorAll('[data-action="save-overwrite"]').forEach(function (b) {
    b.addEventListener('click', function () { handleSave(Number(b.dataset.idx), true); });
  });
  root.querySelectorAll('[data-action="save-new"]').forEach(function (b) {
    b.addEventListener('click', function () { handleSave(Number(b.dataset.idx), false); });
  });
  root.querySelectorAll('[data-action="save-erase"]').forEach(function (b) {
    b.addEventListener('click', function () { handleErase(Number(b.dataset.idx)); });
  });
  const exp = root.querySelector('[data-action="save-export"]');
  if (exp) exp.addEventListener('click', handleExport);
  const imp = root.querySelector('[data-action="save-import"]');
  if (imp) imp.addEventListener('click', handleImport);
  const ng = root.querySelector('[data-action="save-newgame"]');
  if (ng) ng.addEventListener('click', handleNewGame);
}

function handleSave(idx, overwrite) {
  const g = ORION.game;
  if (!g) return;
  if (overwrite && !confirm('Sovrascrivere lo slot ' + (idx + 1) + ' con la partita corrente?')) return;
  const name = prompt('Nome dello slot:', 'Slot ' + (idx + 1));
  if (name === null) return;
  ORION.save.saveSlot(idx, g, name.trim() || ('Slot ' + (idx + 1)));
  showToast('Slot ' + (idx + 1) + ' salvato');
  renderSaveModal();
}

function handleLoad(idx) {
  /* idx === -1 → autosave */
  const payload = (idx === -1) ? ORION.save.loadAutosave() : ORION.save.loadSlot(idx);
  if (!payload) { alert('Slot vuoto o incompatibile.'); return; }
  if (!confirm('Caricare questa partita? La partita corrente verrà sostituita (salva prima se non vuoi perderla).')) return;
  loadPayloadAsGame(payload);
}

function handleErase(idx) {
  if (!confirm('Cancellare definitivamente lo slot ' + (idx + 1) + '?')) return;
  ORION.save.eraseSlot(idx);
  showToast('Slot ' + (idx + 1) + ' cancellato');
  renderSaveModal();
}

function handleExport() {
  const name = ORION.save.exportJson(ORION.game);
  if (name) showToast('Esportato: ' + name);
}

function handleImport() {
  ORION.save.pickJsonFile().then(function (text) {
    const r = ORION.save.parseImport(text);
    if (!r.ok) { alert('Import fallito: ' + r.reason); return; }
    const p = r.payload;
    const ironman = ORION.save.isIronman(ORION.game);
    const sameSeed = ORION.game && p.seed === ORION.game.seed;
    let msg = 'Caricare la partita seed ' + p.seed +
      ' (' + (currentDsOfPayload(p)) + ')?';
    if (!sameSeed) msg += ' La galassia verrà rigenerata dal seed del file.';
    msg += ' La partita corrente verrà sostituita.';
    if (ironman) msg += '\n\nModalità Ironman attiva: il file verrà ricevuto come autosave.';
    if (!confirm(msg)) return;
    loadPayloadAsGame(p);
  }).catch(function () { /* annullato dall'utente */ });
}

function currentDsOfPayload(p) {
  if (!p || !ORION.time) return '—';
  /* Decisione di sessione: ignoriamo startEpochOrbita (era offset random). */
  return ORION.time.format(p.timeImpulsi || 0, 'compact');
}

function handleNewGame() {
  /* Decisione #25: "Nuova partita" non rigenera silenziosamente. Si
     torna sempre al main menu nella scheda "Nuova" così il giocatore
     sceglie seed + preset prima di cristallizzare la partita. */
  closeSaveModal();
  showMainMenu('new');
}

function loadPayloadAsGame(payload) {
  /* M06: newGame ricostruisce la galassia dal seed del payload, poi
     applica il delta (colonie/tempo/cronaca/mode). Coerente con
     seed+delta (decisione #5). */
  newGame(payload.seed, { payload: payload });
  enterGame();
  showToast('Partita caricata');
  closeSaveModal();
}

/* Entra in partita (lascia il main menu, monta la mappa). Usato da:
   - Continua / Inizia / Carica dal main menu
   - load slot / import .json dal pannello save */
/* Migrazione lazy degli ID equipaggio legacy → counter monotono
   persistente. I save antecedenti al fix (formato `crew-<imp>-<n>` con
   counter module-local resettato a ogni reload) potevano contenere ID
   collidenti che il roster mostrava come "Equipaggio 1" duplicato.
   Idempotente: scorre ogni save e rinomina solo i crew col formato
   vecchio in `crew-<N>` con N preso dal counter persistente di game. */
function migrateLegacyCrewIds(game) {
  if (!game || !game.colonies) return;
  const T = ORION.time;
  const LEGACY = /^crew-\d+-\d+$/;
  Object.keys(game.colonies).forEach(function (k) {
    const col = game.colonies[k];
    const list = col && col.crews && col.crews.explorer;
    if (!Array.isArray(list)) return;
    list.forEach(function (c) {
      if (c && typeof c.id === 'string' && LEGACY.test(c.id)) {
        c.id = T && T.nextCrewId ? T.nextCrewId(game)
                                 : ('crew-' + ((game.idSeq = game.idSeq || {}).crew = (game.idSeq.crew | 0) + 1));
      }
    });
  });
}

function enterGame() {
  if (ORION.planetView) { ORION.planetView.destroy(); ORION.planetView = null; ORION.openPlanetKey = null; ORION.currentPlanet = null; } if (ORION.planetOverlay) { ORION.planetOverlay.destroy(); ORION.planetOverlay = null; }
  if (ORION.colonyDeck) { ORION.colonyDeck.destroy(); ORION.colonyDeck = null; }
  if (ORION.systemView) { ORION.systemView.destroy(); ORION.systemView = null; ORION.openSystemId = -1; ORION.currentSystem = null; }
  if (ORION.map) { ORION.map.destroy(); ORION.map = null; }
  /* Una tantum per ogni boot: rinomina i crew con ID legacy collidente. */
  migrateLegacyCrewIds(ORION.game);
  /* Decisione #50: ripristina il pin della dx per questo seed (se presente). */
  loadDxPin(ORION.game);
  hideMainMenu();
  /* M07.3 (decisione #62): primo rilevamento telemetria → la Dashboard
     Impero ha già un punto al primo render (sparkline non vuote). */
  ORION._empireTel = {};
  sampleEmpireTelemetry();
  const stage = document.querySelector('[data-view-stage]');
  if (stage) renderGalaxyView(stage);
  setNavActive('galaxy');
  updateGlobalResourceHud();
  setHudDate(ORION.time.currentDS(ORION.game));
  renderTimeControls();        /* #31: ridisegna i 5 controlli per la partita */
  updateTimeControlsHint();
  /* Decisione #50: prima render della Plancia d'Impero (sx) e della
     Plancia Operativa (dx) — restaura la cronaca nel DOM nuovo. */
  renderLeftPanel();
  restoreChronicleDom(ORION.game);
  renderDxPanel();
  /* M06.6: tutorial — la "?" diventa attiva solo dentro partita. */
  updateTutorialButton();
  /* Welcome: prima trigger della partita (solo se tutorial attivo e non già vista). */
  if (ORION.tutorial) ORION.tutorial.fire('welcome');
  /* PR mobile: mostra la bottom tab bar ora che la partita è attiva. */
  updateMobileNav();
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* Toast non invasivo (decisione #24 / §21: "salva prima di azioni
   irreversibili" — feedback discreto, niente popup). */
function showToast(text) {
  let host = document.querySelector('[data-bind="toast"]');
  if (!host) {
    host = document.createElement('div');
    host.className = 'save-toast';
    host.setAttribute('data-bind', 'toast');
    document.body.appendChild(host);
  }
  host.textContent = text;
  host.classList.add('is-visible');
  clearTimeout(host._t);
  host._t = setTimeout(function () { host.classList.remove('is-visible'); }, 1800);
}

/* =====================================================================
   Main menu pre-partita (decisione #25)
   Sempre mostrato al boot: cristallizza seed + mode + preset prima di
   entrare in partita. Da dentro la partita si torna qui solo via
   "Nuova partita" nel pannello Save (con conferma).
   ===================================================================== */

/* Stato locale del form "Nuova partita" — vive solo nel menu. */
ORION.menuForm = { seed: null, preset: 'classic', ironman: false, tutorial: true };
/* Vista corrente del menu: 'home' | 'new' | 'info' */
ORION.menuView = 'home';

function initMainMenu() {
  const menu = document.querySelector('[data-bind="main-menu"]');
  if (!menu) return;
  /* Backdrop click: niente — il main menu è la schermata principale
     e si chiude solo con un'azione esplicita (Continua/Inizia/Carica). */
  const ver = document.querySelector('[data-bind="main-menu-version"]');
  if (ver) ver.textContent = 'Orion Empires ' + ORION.version;
}

function showMainMenu(view) {
  ORION.menuView = view || 'home';
  stopTimerIfRunning();   // niente auto-advance mentre sei al menu (#31)
  closeMobileSheets();    // PR mobile: chiudi eventuali sheet aprendo il menu
  const menu = document.querySelector('[data-bind="main-menu"]');
  if (menu) menu.removeAttribute('hidden');
  renderMainMenu();
}

function hideMainMenu() {
  const menu = document.querySelector('[data-bind="main-menu"]');
  if (menu) menu.setAttribute('hidden', '');
}

function renderMainMenu() {
  const body = document.querySelector('[data-bind="main-menu-body"]');
  if (!body) return;
  if (ORION.menuView === 'new')      return renderMainMenuNew(body);
  if (ORION.menuView === 'home-pick') return renderMainMenuHomePick(body);
  if (ORION.menuView === 'empire-name') return renderMainMenuEmpireName(body);
  if (ORION.menuView === 'info')     return renderMainMenuInfo(body);
  return renderMainMenuHome(body);
}

/* --- Schermata principale: Continua / Nuova / Carica / Info --- */
function renderMainMenuHome(body) {
  const auto = ORION.save && ORION.save.loadAutosave ? ORION.save.loadAutosave() : null;
  const hasAuto = !!auto;
  const meta = hasAuto ? autoMetaFromPayload(auto) : null;

  body.innerHTML =
    '<div class="main-menu__actions">' +
      /* PR-E: emoji codepoint (📂, ⓘ, ✦) → SVG inline coerente con
         UI_GUIDE §3. Tinte: Continua=verde (azione positiva),
         Nuova=ambra (warm/scoperta), Carica=ciano (utility),
         Info=azzurro (informativo). */
      '<button class="btn btn--menu btn--menu-primary' + (hasAuto ? '' : ' is-disabled') + '" ' +
        'data-action="menu-continue" type="button"' + (hasAuto ? '' : ' disabled') + '>' +
        '<span class="btn__glyph">' + uiIcon('play', 'green') + '</span> Continua' +
        (meta ? '<span class="btn__sub">' + escapeHtml(meta) + '</span>' : '<span class="btn__sub">nessun autosave</span>') +
      '</button>' +
      '<button class="btn btn--menu" data-action="menu-new" type="button">' +
        '<span class="btn__glyph">' + uiIcon('plus', 'amber') + '</span> Nuova partita' +
        '<span class="btn__sub">scegli seed, preset, ironman</span>' +
      '</button>' +
      '<button class="btn btn--menu" data-action="menu-load" type="button">' +
        '<span class="btn__glyph">' + uiIcon('folder', 'cyan') + '</span> Carica partita' +
        '<span class="btn__sub">slot + import .json</span>' +
      '</button>' +
      '<button class="btn btn--menu" data-action="menu-info" type="button">' +
        '<span class="btn__glyph">' + uiIcon('info', 'blue') + '</span> Info' +
        '<span class="btn__sub">crediti e progetto</span>' +
      '</button>' +
    '</div>';

  const cont = body.querySelector('[data-action="menu-continue"]');
  if (cont && hasAuto) cont.addEventListener('click', function () {
    newGame(auto.seed, { payload: auto });
    enterGame();
    showToast('Partita ripresa');
  });
  const ng = body.querySelector('[data-action="menu-new"]');
  if (ng) ng.addEventListener('click', function () { showMainMenu('new'); });
  const load = body.querySelector('[data-action="menu-load"]');
  if (load) load.addEventListener('click', openSaveModal);
  const info = body.querySelector('[data-action="menu-info"]');
  if (info) info.addEventListener('click', function () { showMainMenu('info'); });

  /* Focus iniziale: Continua se presente, altrimenti Nuova. */
  const focusBtn = hasAuto ? cont : ng;
  if (focusBtn) setTimeout(function () { focusBtn.focus(); }, 0);
}

/* Etichetta breve per il sub del bottone Continua: "Nome galassia · DS xxx". */
function autoMetaFromPayload(p) {
  if (!p) return null;
  const ds = currentDsOfPayload(p);
  const gname = p.seed && ORION.names && ORION.names.galaxyName
    ? ORION.names.galaxyName(p.seed) : null;
  /* decisione #65: il nome del popolo è il reminder più forte. */
  let emp = null;
  if (p.empire && p.empire.proper) {
    const a = empireArchById(p.empire.prefix);
    emp = a.noun + ' ' + (a.direct ? '' : 'di ') + p.empire.proper;
  }
  return (emp ? emp + ' · ' : '') + (gname ? gname + ' · ' : '') + ds;
}

/* --- Form "Nuova partita": seed + preset + ironman --- */
function renderMainMenuNew(body) {
  /* Inizializza il form se non ancora fatto in questa apertura. */
  if (!ORION.menuForm.seed) ORION.menuForm.seed = ORION.rng.newSeed();
  const PRESETS = (ORION.victory && ORION.victory.PRESETS) || {};
  const presetLabels = {
    classic: 'Classico',
    speedrun: 'Speedrun (più veloce)',
    nightmare: 'Incubo (ironman, ostile)',
    longBreath: 'Lungo respiro (galassia ampia)'
  };
  const presetOpts = Object.keys(PRESETS).map(function (k) {
    const sel = (k === ORION.menuForm.preset) ? ' selected' : '';
    return '<option value="' + k + '"' + sel + '>' + (presetLabels[k] || k) + '</option>';
  }).join('');

  /* Se il preset corrente forza ironman (nightmare), il checkbox si
     allinea; altrimenti rispetta la scelta utente. */
  const presetForcesIronman = !!(PRESETS[ORION.menuForm.preset] && PRESETS[ORION.menuForm.preset].ironman);
  const ironman = presetForcesIronman ? true : !!ORION.menuForm.ironman;

  body.innerHTML =
    '<form class="main-menu__form" data-bind="menu-form">' +
      '<h2 class="main-menu__form-title">Nuova partita</h2>' +
      '<label class="main-menu__field">' +
        '<span class="main-menu__field-label">Galassia</span>' +
        '<div class="main-menu__galname" data-bind="menu-galname">' + escapeHtml(ORION.names.galaxyName(ORION.menuForm.seed)) + '</div>' +
        '<div class="main-menu__field-row">' +
          '<input class="main-menu__input main-menu__input--seed" type="text" data-bind="menu-seed" ' +
            'value="' + escapeHtml(ORION.menuForm.seed) + '" maxlength="32" autocomplete="off">' +
          '<button type="button" class="btn btn--mini" data-action="menu-seed-new" title="Genera un nuovo seed">⟳ Genera</button>' +
        '</div>' +
      '</label>' +
      '<label class="main-menu__field">' +
        '<span class="main-menu__field-label">Preset</span>' +
        '<select class="main-menu__input" data-bind="menu-preset">' + presetOpts + '</select>' +
        '<span class="main-menu__field-hint">Le piste di vittoria restano in parallelo: il preset dà solo enfasi narrativa.</span>' +
      '</label>' +
      '<label class="main-menu__field main-menu__field--row">' +
        '<input type="checkbox" data-bind="menu-ironman"' + (ironman ? ' checked' : '') +
          (presetForcesIronman ? ' disabled' : '') + '>' +
        '<span>Ironman <span class="main-menu__field-hint">— niente slot manuali, solo autosave + export/import .json' +
          (presetForcesIronman ? ' (imposto dal preset Incubo)' : '') + '</span></span>' +
      '</label>' +
      '<label class="main-menu__field main-menu__field--row">' +
        '<input type="checkbox" data-bind="menu-tutorial"' + (ORION.menuForm.tutorial ? ' checked' : '') + '>' +
        '<span>Tutorial iniziale <span class="main-menu__field-hint">— schede brevi e contestuali sui concetti chiave (non un walkthrough). Riapribile col bottone <kbd>?</kbd> in alto.</span></span>' +
      '</label>' +
      '<div class="main-menu__form-actions">' +
        '<button type="button" class="btn btn--mini" data-action="menu-cancel">← Indietro</button>' +
        '<button type="submit" class="btn btn--primary" data-action="menu-start">✦ Inizia partita</button>' +
      '</div>' +
    '</form>';

  const form = body.querySelector('[data-bind="menu-form"]');
  const seedInput = form.querySelector('[data-bind="menu-seed"]');
  const presetSel = form.querySelector('[data-bind="menu-preset"]');
  const ironChk = form.querySelector('[data-bind="menu-ironman"]');
  const seedBtn = form.querySelector('[data-action="menu-seed-new"]');
  const cancel = form.querySelector('[data-action="menu-cancel"]');

  const galnameEl = form.querySelector('[data-bind="menu-galname"]');
  const refreshGalname = function () {
    if (galnameEl) galnameEl.textContent = ORION.names.galaxyName(ORION.menuForm.seed);
  };
  seedInput.addEventListener('input', function () {
    ORION.menuForm.seed = seedInput.value.trim() || ORION.rng.newSeed();
    refreshGalname();
  });
  seedBtn.addEventListener('click', function () {
    ORION.menuForm.seed = ORION.rng.newSeed();
    seedInput.value = ORION.menuForm.seed;
    refreshGalname();
    seedInput.focus();
  });
  presetSel.addEventListener('change', function () {
    ORION.menuForm.preset = presetSel.value;
    renderMainMenu(); // rerender per riallineare ironman se forzato
  });
  if (ironChk) ironChk.addEventListener('change', function () {
    ORION.menuForm.ironman = !!ironChk.checked;
  });
  const tutChk = form.querySelector('[data-bind="menu-tutorial"]');
  if (tutChk) tutChk.addEventListener('change', function () {
    ORION.menuForm.tutorial = !!tutChk.checked;
  });
  cancel.addEventListener('click', function () { showMainMenu('home'); });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    startNewGameFromMenu();
  });
  setTimeout(function () { seedInput.focus(); seedInput.select(); }, 0);
}

function startNewGameFromMenu() {
  /* Conferma autosave PRIMA dello step "scegli colonia" — la scelta
     dell'origine è già "azione irreversibile" che porterà a partita. */
  const auto = ORION.save && ORION.save.loadAutosave ? ORION.save.loadAutosave() : null;
  if (auto && !confirm('Iniziare una nuova partita? L\'autosave corrente verrà sostituito (gli slot manuali restano).')) return;
  /* M06.5 (decisione #27): non avvii subito la partita — passi allo
     step "scegli colonia" che genera la galassia in anteprima e mostra
     i candidati. La partita parte solo a scelta confermata. */
  showMainMenu('home-pick');
}

/* M06.5 — Step "Scegli colonia originaria" (decisione #27 / GDD §6.2.bis).
   Genera la galassia in anteprima dal seed cristallizzato, pesca i
   candidati (uno per gruppo, max 6), mostra la griglia di card.
   Niente Canvas: le card sono puramente testuali (riusa lo stile delle
   save-card, decisione #24). */
function renderMainMenuHomePick(body) {
  /* Determinismo dal seed: se il seed o le opzioni rilevanti non sono
     cambiati, riusiamo la galassia di anteprima per evitare la
     rigenerazione (costa qualche ms). */
  const seed = ORION.menuForm.seed || ORION.rng.newSeed();
  ORION.menuForm.seed = seed;
  if (!ORION.menuPreview || ORION.menuPreview.seed !== seed) {
    const previewGalaxy = ORION.galaxy.generate(seed);
    const candidates = ORION.galaxy.pickHomeCandidates(previewGalaxy, 6);
    ORION.menuPreview = { seed: seed, galaxy: previewGalaxy, candidates: candidates };
  }
  const candidates = ORION.menuPreview.candidates;

  if (!candidates.length) {
    body.innerHTML = '<div class="main-menu__info">' +
      '<h2 class="main-menu__form-title">Nessun candidato trovato</h2>' +
      '<p>La galassia di questo seed non offre corpi abitabili sufficienti. Riprova con un seed diverso.</p>' +
      '<div class="main-menu__form-actions">' +
        '<button type="button" class="btn btn--mini" data-action="menu-back-new">← Indietro</button>' +
      '</div></div>';
    body.querySelector('[data-action="menu-back-new"]').addEventListener('click', function () { showMainMenu('new'); });
    return;
  }

  const cards = candidates.map(function (c) { return homeCandidateCardHtml(c); }).join('');
  body.innerHTML =
    '<div class="main-menu__pick">' +
      '<h2 class="main-menu__form-title">Scegli la colonia originaria</h2>' +
      '<p class="main-menu__field-hint">' +
        candidates.length + ' candidati (uno per regione · <strong>' + escapeHtml(ORION.names.galaxyName(seed)) + '</strong> · seed <code>' + escapeHtml(seed) + '</code>). ' +
        'La scelta cristallizza il sistema d\'origine: la galassia si ricalibra da lì. Il <strong>rischio pirati</strong> riflette la fascia (Nucleo sicuro → Orlo esposto), dove si concentrano covi e incursioni.' +
      '</p>' +
      '<div class="save-grid">' + cards + '</div>' +
      '<div class="main-menu__form-actions">' +
        '<button type="button" class="btn btn--mini" data-action="menu-back-new">← Indietro</button>' +
        '<button type="button" class="btn btn--mini" data-action="menu-pick-random">🎲 Scegli per me</button>' +
      '</div>' +
    '</div>';

  body.querySelectorAll('[data-action="pick-home"]').forEach(function (b) {
    b.addEventListener('click', function () {
      const idx = parseInt(b.dataset.idx, 10);
      confirmHomeAndStart(candidates[idx]);
    });
  });
  body.querySelector('[data-action="menu-back-new"]').addEventListener('click', function () { showMainMenu('new'); });
  body.querySelector('[data-action="menu-pick-random"]').addEventListener('click', function () {
    const rng = ORION.rng.makeRng(seed + ':pick');
    confirmHomeAndStart(candidates[rng.int(0, candidates.length - 1)]);
  });
}

function homeCandidateCardHtml(c) {
  const typeLabel = (ORION.system.BODY_TYPES[c.planet.type] || {}).label || c.planet.type;
  const p = c.planet.potentials;
  const advLine = c.planet.advancedCount > 0
    ? '<dd class="main-menu__adv">⚛ ' + c.planet.advancedCount + ' avanzate (da scansionare)</dd>'
    : '<dd class="main-menu__adv">⚛ nessuna avanzata</dd>';
  return '<div class="save-card save-card--candidate">' +
    '<div class="save-card__name">' + escapeHtml(c.planet.name) + ' <span class="main-menu__sub-inline">· ' + escapeHtml(typeLabel) + '</span></div>' +
    '<dl class="save-card__meta">' +
      '<div><dt>Regione</dt><dd>' + escapeHtml(c.groupName) + '</dd></div>' +
      '<div><dt>Sistema</dt><dd>' + escapeHtml(c.system.name) + ' · ' + escapeHtml(c.system.starLabel) + '</dd></div>' +
      '<div><dt>Rischio pirati</dt><dd>' + pirateRiskHtml(c.system) + '</dd></div>' +
      '<div><dt>Ostilità ' + hostilityNoun(c.planet) + '</dt><dd>' + c.planet.hostility + '</dd></div>' +
      '<div><dt>Pop. max</dt><dd>' + popMaxPeople(c.planet) + '</dd></div>' +
      '<div><dt>Slot</dt><dd>' + (c.planet.slots) + '</dd></div>' +
    '</dl>' +
    '<div class="main-menu__pot-bars">' +
      potBar('Met', p.met) + potBar('En', p.en) + potBar('Cibo', p.food) + potBar('Acqua', p.water) +
    '</div>' +
    '<dl class="save-card__meta">' + advLine + '</dl>' +
    '<div class="save-card__actions">' +
      '<button type="button" class="btn btn--mini btn--primary" data-action="pick-home" data-idx="' +
        // Trovo l'indice cercandolo nell'array dei candidati
        ORION.menuPreview.candidates.indexOf(c) + '">Inizia qui</button>' +
    '</div></div>';
}

/* Rischio pirati/esposizione del candidato d'origine, derivato dalla
   FASCIA del gruppo (Nucleo→Spazio Sconosciuto). È il segnale onesto che
   sopravvive alla scelta: il pericolo per-sistema si azzera quando il
   sistema diventa la tua origine (recomputeDanger), ma la fascia è
   immutabile e determina dove si seminano covi pirata e AI aggressive
   (Frontiera/Orlo). Più periferico = più esposto. */
function pirateRiskHtml(system) {
  const MAP = {
    nucleo:      { lvl: 'molto basso', cls: 'main-menu__risk--ok' },
    colonie:     { lvl: 'basso',       cls: 'main-menu__risk--ok' },
    frontiera:   { lvl: 'medio',       cls: 'main-menu__risk--warn' },
    orlo:        { lvl: 'alto',        cls: 'main-menu__risk--crit' },
    sconosciuto: { lvl: 'molto alto',  cls: 'main-menu__risk--crit' }
  };
  const r = MAP[system.tier] || { lvl: '—', cls: '' };
  const region = system.tierLabel ? ' <span class="main-menu__sub-inline">· ' + escapeHtml(system.tierLabel) + '</span>' : '';
  return '<span class="main-menu__risk ' + r.cls + '">' + escapeHtml(r.lvl) + '</span>' + region;
}

function potBar(label, val) {
  const v = Math.max(0, Math.min(100, val));
  return '<div class="main-menu__pot">' +
    '<span class="main-menu__pot-label">' + label + '</span>' +
    '<span class="main-menu__pot-track"><span class="main-menu__pot-fill" style="width:' + v + '%"></span></span>' +
    '<span class="main-menu__pot-val">' + v + '</span>' +
  '</div>';
}

/* Scelta colonia fatta → passa allo step "Dai un nome al tuo popolo"
   (decisione #65). La colonia scelta è stashata nel form. */
function confirmHomeAndStart(candidate) {
  ORION.menuForm.home = candidate;
  showMainMenu('empire-name');
}

/* Step identità popolo: prefisso (archetipo) + nome proprio (default dalla
   colonia natale, editabile + 🎲 che cicla le fonti celesti). */
function renderMainMenuEmpireName(body) {
  const candidate = ORION.menuForm.home;
  if (!candidate) { showMainMenu('home-pick'); return; }
  const seed = ORION.menuForm.seed;
  /* Fonti per il 🎲: colonia natale → regione → sistema → galassia. */
  const sources = [];
  [candidate.planet && candidate.planet.name, candidate.groupName,
   candidate.system && candidate.system.name, ORION.names.galaxyName(seed)]
    .forEach(function (s) { if (s && sources.indexOf(s) < 0) sources.push(s); });
  ORION.menuForm.empire = ORION.menuForm.empire || { prefix: 'repubblica', proper: sources[0] || 'Aurora', srcIdx: 0 };
  const form = ORION.menuForm.empire;

  const A = (ORION.ai && ORION.ai.ARCHETYPES) || {};
  function optGroup(label, arr) {
    if (!arr || !arr.length) return '';
    return '<optgroup label="' + label + '">' + arr.map(function (a) {
      return '<option value="' + a.id + '"' + (a.id === form.prefix ? ' selected' : '') + '>' + escapeHtml(a.noun) + '</option>';
    }).join('') + '</optgroup>';
  }
  const selectHtml = '<select class="main-menu__select" data-bind="emp-prefix">' +
    optGroup('Luce / diplomatici', A.bene) +
    optGroup('Neutrali / economici', A.neutrale) +
    optGroup('Autoritari / diretti', A.male) +
  '</select>';

  body.innerHTML =
    '<div class="main-menu__form">' +
      '<h2 class="main-menu__form-title">Dai un nome al tuo popolo</h2>' +
      '<p class="main-menu__field-hint">Come si chiamerà la tua civiltà? Il <strong>prefisso</strong> ne dà il tono ' +
        '(potrai cambiarlo in partita se cambi intenti); il <strong>nome proprio</strong> parte dalla tua colonia ' +
        'd\'origine ma puoi scriverlo o sortirlo come preferisci.</p>' +
      '<label class="main-menu__field"><span class="main-menu__field-label">Prefisso</span>' + selectHtml + '</label>' +
      '<label class="main-menu__field"><span class="main-menu__field-label">Nome proprio</span>' +
        '<span class="main-menu__seedrow">' +
          '<input type="text" class="main-menu__input" data-bind="emp-proper" maxlength="24" value="' + escapeHtml(form.proper) + '">' +
          '<button type="button" class="btn btn--mini" data-action="emp-roll" title="Sorteggia un nome">🎲</button>' +
        '</span>' +
      '</label>' +
      '<p class="main-menu__empire-preview">Anteprima: <strong data-bind="emp-preview"></strong></p>' +
      '<div class="main-menu__form-actions">' +
        '<button type="button" class="btn btn--mini" data-action="emp-back">← Indietro</button>' +
        '<button type="button" class="btn btn--mini" data-action="emp-skip">Salta</button>' +
        '<button type="button" class="btn btn--primary" data-action="emp-start">Inizia partita</button>' +
      '</div>' +
    '</div>';

  const sel = body.querySelector('[data-bind="emp-prefix"]');
  const inp = body.querySelector('[data-bind="emp-proper"]');
  const prev = body.querySelector('[data-bind="emp-preview"]');
  function refresh() {
    form.prefix = sel.value;
    form.proper = inp.value.trim() || sources[0] || 'Aurora';
    prev.textContent = formatEmpire(form);
  }
  sel.addEventListener('change', refresh);
  inp.addEventListener('input', function () { form.prefix = sel.value; form.proper = inp.value.trim(); prev.textContent = formatEmpire({ prefix: form.prefix, proper: form.proper || (sources[0] || 'Aurora') }); });
  body.querySelector('[data-action="emp-roll"]').addEventListener('click', function () {
    form.srcIdx = (form.srcIdx + 1) % sources.length;
    inp.value = sources[form.srcIdx];
    refresh();
  });
  body.querySelector('[data-action="emp-back"]').addEventListener('click', function () {
    ORION.menuForm.empire = null; showMainMenu('home-pick');
  });
  body.querySelector('[data-action="emp-skip"]').addEventListener('click', function () {
    startGameWithEmpire(null);
  });
  body.querySelector('[data-action="emp-start"]').addEventListener('click', function () {
    refresh();
    startGameWithEmpire({ prefix: form.prefix, proper: form.proper });
  });
  refresh();
}

/* Avvio reale della partita con l'identità scelta (o default se empire=null). */
function startGameWithEmpire(empire) {
  const candidate = ORION.menuForm.home;
  if (!candidate) { showMainMenu('home-pick'); return; }
  const PRESETS = (ORION.victory && ORION.victory.PRESETS) || {};
  const presetId = ORION.menuForm.preset || 'classic';
  const presetMods = Object.assign({}, PRESETS[presetId] || PRESETS.classic || {});
  if (ORION.menuForm.ironman) presetMods.ironman = true;
  const mode = { startedAs: 'sandbox', preset: presetId, modifiers: presetMods };
  clearSavedGame();
  newGame(ORION.menuForm.seed, {
    mode: mode,
    homeWorld: { systemId: candidate.systemId, bodyKey: candidate.bodyKey },
    tutorialEnabled: !!ORION.menuForm.tutorial,
    empire: (empire && empire.proper) ? empire : null
  });
  /* Reset preview + form per la prossima apertura */
  ORION.menuPreview = null;
  ORION.menuForm = { seed: null, preset: presetId, ironman: !!presetMods.ironman, tutorial: !!ORION.menuForm.tutorial };
  enterGame();
  showToast(formatEmpire(ORION.game.empire) + ' · ' + ORION.names.galaxyName(ORION.game.seed));
}

/* --- Info / Crediti --- */
function renderMainMenuInfo(body) {
  body.innerHTML =
    '<div class="main-menu__info">' +
      '<h2 class="main-menu__form-title">Informazioni</h2>' +
      '<p><strong>Orion Empires</strong> — 4X strategico spaziale a pannelli, scritto in vanilla JS puro (no framework, no CDN, no WebGL).</p>' +
      '<p>Sviluppo modulo per modulo. Vedi <code>CLAUDE.md</code> per lo stato e <code>ORION_EMPIRES_GDD.md</code> per il design.</p>' +
      '<p class="main-menu__field-hint">Build: ' + escapeHtml(ORION.version) + '</p>' +
      '<div class="main-menu__form-actions">' +
        '<button type="button" class="btn btn--mini" data-action="menu-cancel">← Indietro</button>' +
      '</div>' +
    '</div>';
  const back = body.querySelector('[data-action="menu-cancel"]');
  if (back) back.addEventListener('click', function () { showMainMenu('home'); });
}

/* ---------------------------------------------------------------------
   Avvio
   --------------------------------------------------------------------- */
function injectStaticSvgIcons() {
  /* PR-A (UI_GUIDE §3 strategia B): inietta SVG nelle icon-span statiche
     dichiarate in index.html con `data-icon="<nome>"`. Idempotente:
     skippa quelle già popolate. innerHTML è safe per SVG inline (l'HTML5
     parser gestisce il namespacing automaticamente). */
  if (!ORION.icon) return;
  document.querySelectorAll('[data-icon]').forEach(function (el) {
    if (el.innerHTML.trim()) return;
    const name = el.dataset.icon;
    const svg = ORION.icon(name);
    if (svg) el.innerHTML = svg;
  });
}

/* =====================================================================
   Navigazione mobile (PR mobile, decisione #6 emendata)
   Bottom tab bar (≤760px): Mappa / Colonia / Flotte / Civiltà / Altro.
   Mappa·Flotte·Civiltà cambiano la vista centrale (riusano navigateView);
   Colonia apre la Plancia Operativa (dx) come sheet; Altro apre la Plancia
   d'Impero (sx). Stato volatile su ORION, mai nel save (UI_GUIDE §9).
   ===================================================================== */
function initMobileNav() {
  const nav = document.querySelector('[data-bind="mobile-nav"]');
  if (!nav) return;
  nav.querySelectorAll('[data-mnav]').forEach(function (btn) {
    btn.addEventListener('click', function () { onMobileNav(btn.dataset.mnav); });
  });
  const scrim = document.querySelector('[data-bind="mobile-scrim"]');
  if (scrim) scrim.addEventListener('click', function () { closeMobileSheets(); });
  window.addEventListener('resize', function () {
    updateHudHeightVar();
    updateMobileNavActive();
  });
  updateHudHeightVar();
  updateMobileNav();
}

/* Misura l'altezza reale dell'HUD top (varia col wrap su mobile) e la
   espone come `--hud-h`: le sheet a tutto schermo partono SOTTO l'HUD così
   risorse/controlli tempo restano visibili anche con una scheda aperta. */
function updateHudHeightVar() {
  const hud = document.querySelector('.hud-top');
  if (!hud) return;
  const h = hud.offsetHeight || 0;
  if (h) document.documentElement.style.setProperty('--hud-h', h + 'px');
}

function onMobileNav(which) {
  if (!ORION.game) return;
  switch (which) {
    case 'map':    closeMobileSheets(); navigateView('galaxy'); break;
    case 'fleet':  closeMobileSheets(); navigateView('fleet');  break;
    case 'civ':    closeMobileSheets(); navigateView('civ');    break;
    case 'colony': toggleMobileSheet('right'); break;
    case 'more':   toggleMobileSheet('left');  break;
  }
  updateMobileNavActive();
}

function toggleMobileSheet(side) {
  setMobileSheet(ORION._mobileSheet === side ? null : side);
}

function setMobileSheet(side) {
  ORION._mobileSheet = side || null;
  if (side) updateHudHeightVar();   /* l'HUD può aver cambiato altezza (wrap) */
  const left  = document.querySelector('.panel--left');
  const right = document.querySelector('.panel--right');
  const scrim = document.querySelector('[data-bind="mobile-scrim"]');
  if (left)  left.classList.toggle('is-sheet-open',  side === 'left');
  if (right) right.classList.toggle('is-sheet-open', side === 'right');
  if (scrim) scrim.classList.toggle('is-on', !!side);
  updateMobileNavActive();
}

function closeMobileSheets() {
  if (ORION._mobileSheet) setMobileSheet(null);
}

/* Mostra/nasconde la barra mobile in base alla partita attiva (CSS la rende
   visibile solo sotto il breakpoint telefono). */
function updateMobileNav() {
  const has = !!ORION.game;
  document.body.classList.toggle('has-game', has);
  const nav   = document.querySelector('[data-bind="mobile-nav"]');
  const scrim = document.querySelector('[data-bind="mobile-scrim"]');
  if (nav)   nav.hidden = !has;
  if (scrim) scrim.hidden = !has;
  if (!has) closeMobileSheets();
  updateMobileNavActive();
  /* Tutorial: spiega la navigazione mobile la prima volta che la barra
     compare su schermo stretto (rispetta isEnabled/isSeen). */
  if (has && ORION.tutorial && window.matchMedia &&
      window.matchMedia('(max-width: 760px)').matches) {
    ORION.tutorial.fire('mobile-nav');
  }
}

function updateMobileNavActive() {
  const nav = document.querySelector('[data-bind="mobile-nav"]');
  if (!nav) return;
  let active = 'map';
  if (ORION._mobileSheet === 'right') active = 'colony';
  else if (ORION._mobileSheet === 'left') active = 'more';
  else if (ORION._currentView === 'fleet') active = 'fleet';
  else if (ORION._currentView === 'civ') active = 'civ';
  nav.querySelectorAll('[data-mnav]').forEach(function (b) {
    b.classList.toggle('is-active', b.dataset.mnav === active);
  });
}

function boot() {
  /* M06: assorbe eventuale autosave M05 (chiavi legacy). Idempotente. */
  if (ORION.save && ORION.save.migrateLegacy) ORION.save.migrateLegacy();
  /* PR-A: SVG icons negli host statici (HUD top, main menu). */
  injectStaticSvgIcons();
  /* Decisione #50: prefs UI persistite (cronaca collassata, sezioni sx). */
  loadUiPrefs();
  /* Decisione #25: il boot non entra più direttamente in partita —
     si parte sempre dal main menu (Continua / Nuova / Carica / Info). */
  initNavigation();
  initTimeControls();
  initSaveControls();
  initTutorialControls();
  initPrefsControls();
  initMobileNav();
  initMainMenu();
  showMainMenu('home');
  console.info('%cOrion Empires ' + ORION.version + ' — main menu pronto.', 'color:#2fe6e0');
}

/* M06.6: bottone "?" in HUD — apre l'indice di tutte le lezioni
   (decisione #27, manuale leggero). Nascosto finché non c'è partita. */
function initTutorialControls() {
  const btn = document.querySelector('[data-action="open-tutorial"]');
  if (!btn) return;
  btn.addEventListener('click', function () {
    if (!ORION.game || !ORION.tutorial) return;
    ORION.tutorial.openIndex();
  });
  updateTutorialButton();
}
function updateTutorialButton() {
  const btn = document.querySelector('[data-action="open-tutorial"]');
  if (!btn) return;
  if (ORION.game) btn.style.display = '';
  else btn.style.display = 'none';
}

document.addEventListener('DOMContentLoaded', boot);
