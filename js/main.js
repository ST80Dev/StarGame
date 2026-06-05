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
  fleet:     { caption: 'VISTA FLOTTA',     hint: 'La gestione della flotta arriverà più avanti nello sviluppo.' },
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
ORION.openPlanetKey = null;     // "<sysId>:<bodyKey>"
ORION.currentPlanet = null;
ORION.planetTab = 'colonia';    // 'colonia' | 'risorse' | 'strutture' | 'popolazione' | 'esplorazione' (M07)

/* Ultimo sistema annotato in cronaca (evita doppioni consecutivi). */
ORION.lastChronicleId = -1;

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
  /* M06.5: se il giocatore ha scelto un home diverso dal default
     generato (decisione #27), ricalibra prima di createState così la
     nebbia di guerra rispetta la nuova origine. */
  if (opts.homeWorld && Number.isInteger(opts.homeWorld.systemId)) {
    ORION.galaxy.recomputeDanger(galaxy, opts.homeWorld.systemId);
  }
  const state = ORION.galaxy.createState(galaxy);

  // Epoca d'inizio randomizzata DS 800.00–3000.00 (decisione #4), derivata
  // dal seed così da restare deterministica (parte del seed+delta).
  const erng = ORION.rng.makeRng(seed + ':epoch');
  const startOrbita = erng.int(800, 3000);

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
    expeditions: []
  };
  // startDS = Data Stellare INIZIALE (epoca .00), fissa per la partita.
  ORION.game.startDS = ORION.time.format(startOrbita * 100);

  // M04/M06.5: colonizza il pianeta natale (scelta esplicita se passata
  // dal menu, altrimenti homeWorld flaggato da system.js).
  colonizeHomePlanet(ORION.game, ORION.game.startDS);

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
    if (Array.isArray(saved.chronicle)) ORION.game.chronicle = saved.chronicle.slice();
    /* Tutorial: rispetta lo stato del payload se presente. */
    if (saved.tutorial && typeof saved.tutorial === 'object') {
      ORION.game.tutorial = {
        enabled: !!saved.tutorial.enabled,
        seenLessons: Array.isArray(saved.tutorial.seenLessons) ? saved.tutorial.seenLessons.slice() : []
      };
    }
  }
  /* Normalizza in ogni caso (idempotente) e mostra/nasconde la "?" in HUD. */
  if (ORION.tutorial && ORION.tutorial.initOnGame) {
    ORION.tutorial.initOnGame(ORION.game, tutorialEnabled);
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
      if (planet) people += ORION.planet.peopleAt((c.pop.total || 0) + (c.pop.accum || 0), planet);
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
  if (popEl) popEl.textContent = ORION.planet.formatPeople(people);
}

/* ---------------------------------------------------------------------
   Navigazione tra viste
   --------------------------------------------------------------------- */
function initNavigation() {
  const items = document.querySelectorAll('.nav-item');
  const stage = document.querySelector('[data-view-stage]');

  items.forEach((item) => {
    item.addEventListener('click', () => {
      /* Guard: senza partita la navigazione non fa nulla (main menu
         attivo). I bottoni rimangono visibili ma inerti finché il
         giocatore non avvia/carica una partita dal menu (decisione #25). */
      if (!ORION.game) return;
      items.forEach((i) => i.classList.remove('is-active'));
      item.classList.add('is-active');
      renderView(stage, item.dataset.view);
    });
  });

  /* La vista iniziale viene attivata da `enterGame()` quando si lascia
     il main menu (decisione #25). */
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

  // Altre viste: smonta tutto e mostra il placeholder.
  if (ORION.planetView) { ORION.planetView.destroy(); ORION.planetView = null; ORION.openPlanetKey = null; ORION.currentPlanet = null; }
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
      '<nav class="galaxy-breadcrumb" data-breadcrumb aria-label="Percorso di navigazione"></nav>' +
      '<button class="seed-chip" data-action="copy-seed" type="button" ' +
        'title="Copia il seed negli appunti">' +
        '<span class="seed-chip__label">SEED</span>' +
        '<code class="seed-chip__value" data-bind="seed">' + g.seed + '</code>' +
      '</button>' +
      '<div class="galaxy-hint">Trascina · zoom rotella/pinch · <kbd>Shift</kbd>+trascina = ruota libera · <kbd>Alt</kbd>+trascina = roll · pinch a 2 dita ruota su touch</div>' +
    '</div>';

  const holder = stage.querySelector('.galaxy-holder');
  ORION.map = new ORION.GalaxyMap().mount(holder, g.galaxy, g.state, {
    onContext: onMapContext,
    onActivateSystem: (id) => openSystem(id)   // doppio click → vista interna (M03)
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
  const panel = document.querySelector('.panel--right');
  if (!panel) return;
  const title = panel.querySelector('.panel__title');
  const content = panel.querySelector('.panel__content');
  if (!title || !content) return;

  if (ctx.systemId >= 0) renderSystemPanel(title, content, ctx.systemId);
  else if (ctx.level === 'group' && ctx.groupId >= 0) renderGroupPanel(title, content, ctx.groupId);
  else renderGalaxyPanel(title, content);
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
/* "Persone correnti / tetto del pianeta", con units frazionarie per fluidità. */
function popRangePeople(colony, planet) {
  const u = (colony.pop.total || 0) + (colony.pop.accum || 0);
  return popPeople(u, planet) + ' / ' + popMaxPeople(planet);
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
      (isHome ? '<p class="sysinfo__home">★ Regione d\'origine</p>' : '') +
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
      (isHome ? '<p class="sysinfo__home">★ Sistema di partenza</p>' : '') +
      '<dl class="sysinfo__list">' +
        row('Nome', sys.name + (sys.realName ? ' <span class="sysinfo__tag">reale</span>' : '')) +
        row('Stella', starType ? starType.label : sys.star) +
        row('Stato', disc === DISCOVERY.EXPLORED ? 'Esplorato' : 'Rilevato') +
        row('Rotte', String(sys.links.length)) +
        row('Pericolo',
          '<span class="danger-badge ' + tierClass + '">' + sys.danger + ' · ' + sys.dangerTier + '</span>') +
      '</dl>' +
      '<button class="btn btn--mini btn--enter" data-action="enter-system" type="button">◉ Apri sistema ▸</button>' +
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
}

function updateSystemUI(system, bodyKey) {
  renderSystemBreadcrumb(system, bodyKey);
  const panel = document.querySelector('.panel--right');
  if (!panel) return;
  const title = panel.querySelector('.panel__title');
  const content = panel.querySelector('.panel__content');
  if (!title || !content) return;
  const disc = ORION.game.state.discovery[system.id];
  if (bodyKey) {
    const body = ORION.system.findBody(system, bodyKey);
    if (body) { renderBodyPanel(title, content, system, body); return; }
  }
  renderSystemInteriorPanel(title, content, system, disc);
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
      (system.isHome ? '<p class="sysinfo__home">★ Sistema di partenza</p>' : '') +
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
      ? '<p class="sysinfo__home">★ Pianeta base</p>'
      : '<p class="sysinfo__home">◉ Colonia attiva</p>';
  }

  content.innerHTML =
    '<div class="sysinfo">' +
      (body.homeWorld && !(colony && colony.colonized) ? '<p class="sysinfo__home">★ Mondo natale candidato</p>' : '') +
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
        ? '<button class="btn btn--mini btn--enter" data-action="enter-planet" type="button">○ Apri pianeta ▸</button>' +
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
  ORION.planetView = new ORION.PlanetView().mount(planetHolder, system, body, planet, colony, {
    onSelectMoon: function (mk) { openPlanet(sysId, mk); },
    onExit: function () { closePlanet(); }
  });

  setNavActive('planet');
  setGalaxyHint('planet');
  updatePlanetUI();

  pushChronicle(ORION.time.currentDS(g) + ' — Apertura scheda planetaria di <strong>' + body.name + '</strong>' + bodyTagHtml(sysId) + '.', 'planet');

  /* M06.6: tutorial — prima apertura di un pianeta. */
  if (ORION.tutorial) ORION.tutorial.fire('planet');
}

function closePlanet() {
  if (ORION.planetView) { ORION.planetView.destroy(); ORION.planetView = null; }
  ORION.openPlanetKey = null;
  ORION.currentPlanet = null;
  const root = document.querySelector('.galaxy-root');
  if (root) {
    const planetHolder = root.querySelector('[data-planet-holder]');
    const sysHolder = root.querySelector('[data-system-holder]');
    if (planetHolder) planetHolder.hidden = true;
    if (sysHolder) sysHolder.style.visibility = '';
  }
  setNavActive('system');
  setGalaxyHint('system');
  // riallinea il pannello destro alla selezione corrente del sistema
  if (ORION.currentSystem) updateSystemUI(ORION.currentSystem, ORION.systemView ? ORION.systemView.selectedKey : null);
}

function updatePlanetUI() {
  renderPlanetBreadcrumb();
  const panel = document.querySelector('.panel--right');
  if (!panel) return;
  const title = panel.querySelector('.panel__title');
  const content = panel.querySelector('.panel__content');
  if (!title || !content) return;
  renderPlanetPanel(title, content);
}

function renderPlanetBreadcrumb() {
  const el = document.querySelector('[data-breadcrumb]');
  if (!el) return;
  const g = ORION.game;
  const sys = ORION.currentSystem;
  const grp = findGroup(g.galaxy.systems[sys.id].cluster);
  const planet = ORION.currentPlanet;
  const body = ORION.system.findBody(sys, planet.bodyKey);
  const crumbs = ['<button class="crumb" data-crumb="galaxy" type="button">Galassia</button>'];
  if (grp) crumbs.push('<span class="crumb__sep">›</span>' +
    '<button class="crumb" data-crumb="group" data-id="' + grp.id + '" type="button">' + grp.name + '</button>');
  crumbs.push('<span class="crumb__sep">›</span>' +
    '<button class="crumb" data-crumb="system" type="button">' + sys.name + '</button>');
  crumbs.push('<span class="crumb__sep">›</span>' +
    '<span class="crumb is-current">' + body.name + '</span>');
  el.innerHTML = crumbs.join('');

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
  const tabs = ['colonia', 'risorse', 'strutture', 'popolazione'];
  if (hasExplorationAssets) tabs.push('esplorazione');
  if (!colony.colonized) ORION.planetTab = 'colonia';
  /* Se la tab attiva è 'esplorazione' ma non più visibile, fallback. */
  if (ORION.planetTab === 'esplorazione' && !hasExplorationAssets) ORION.planetTab = 'colonia';
  const activeTab = ORION.planetTab;
  const alerts = planetTabAlerts(colony);

  const head =
    '<div class="planet-head">' +
      '<p class="planet-head__type">' + def.label + (colony.isHomeBase ? ' · <strong>Pianeta base</strong>' : (colony.colonized ? ' · Colonia' : '')) + '</p>' +
    '</div>' +
    '<nav class="planet-tabs" role="tablist">' +
      tabs.map(function (t) {
        const meta = {
          colonia:      { icon: '⚑', label: 'Colonia',  full: 'Colonia' },
          risorse:      { icon: '⛁', label: 'Risorse',  full: 'Risorse' },
          strutture:    { icon: '⚒', label: 'Strutt.',  full: 'Strutture' },
          popolazione:  { icon: '♟', label: 'Pop.',     full: 'Popolazione' },
          esplorazione: { icon: '✦', label: 'Esplor.',  full: 'Esplorazione' }
        }[t];
        const disabled = (!colony.colonized && t !== 'colonia');
        const isActive = (t === activeTab);
        const alert = alerts[t];
        const alertCls = (alert && !isActive) ? ' has-alert has-alert--' + alert : '';
        const titleFull = meta.full + (alert ? ' · ' + alertTitle(t, colony, alert) : '');
        const inner = isActive
          ? '<span class="planet-tab__icon">' + meta.icon + '</span><span class="planet-tab__label">' + meta.label + '</span>'
          : '<span class="planet-tab__icon">' + meta.icon + '</span>';
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
  else if (activeTab === 'esplorazione') renderPlanetEsplorazioneTab(host, planet, colony);

  /* M06.6: tutorial — schede per tab pianeta. Risorse copre l'idea delle
     avanzate mascherate (§7.2); Strutture copre slot/coda/durata. */
  if (ORION.tutorial) {
    if (activeTab === 'strutture') ORION.tutorial.fire('build');
    else if (activeTab === 'risorse' && planet.advanced && planet.advanced.length > 0) {
      ORION.tutorial.fire('advanced');
    }
    else if (activeTab === 'esplorazione') ORION.tutorial.fire('exploration');
  }
}

/* M07: ritorna le spedizioni che originano da una colonia (per UI). */
function expeditionsForColony(colony) {
  if (!ORION.game || !Array.isArray(ORION.game.expeditions)) return [];
  const key = colony.systemId + ':' + colony.bodyKey;
  return ORION.game.expeditions.filter(function (e) {
    return e && e.originColonyKey === key && e.status !== 'done';
  });
}

/* --- Tab Colonia / Colonizzazione --- */
function renderPlanetColoniaTab(host, planet, colony) {
  const g = ORION.game;
  const def = ORION.system.BODY_TYPES[planet.type];

  if (colony.colonized) {
    const out = ORION.planet.structureOutput(colony, planet);
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
          '<p class="settle-banner__title">⏳ Insediamento in corso</p>' +
          '<p class="settle-banner__hint">Produzione al 50% · +50% velocità prima struttura · crescita pop bloccata.</p>' +
          '<dl class="sysinfo__list">' +
            row('Restanti', remain + ' I') +
            row('Avanzamento', pct + '%') +
          '</dl>' +
          '<div class="progress-bar"><div class="progress-bar__fill" style="width:' + pct + '%"></div></div>' +
        '</div>';
    }
    host.innerHTML =
      '<div class="sysinfo">' +
        settlingBanner +
        (colony.isHomeBase ? '<p class="sysinfo__home">★ Pianeta base — bonus +20% produzione</p>' : '<p class="sysinfo__home">◉ Colonia attiva</p>') +
        '<dl class="sysinfo__list">' +
          row('Colonizzato dal', colony.colonizedDS || '—') +
          row('Popolazione', popRangePeople(colony, planet)) +
          row('Slot utilizzati', out.used + ' / ' + planet.slots) +
          row('Ostilità ' + hostilityNoun(planet), planet.hostility) +
        '</dl>' +
        '<p class="sysinfo__sub">Riepilogo produzione (/Impulso)</p>' +
        rateGrid(out.rates, out.upkeep) +
        scarRow +
        renderGovernorSection(colony, planet) +
      '</div>';
    bindGovernorHandlers(host, planet, colony);
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
          row('Restanti', remain + ' I') +
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
      (homeInTrouble ? '<p class="panel__note">⚠ Crisi sulla colonia primaria: costo di migrazione ridotto.</p>' : '') +
      (reasons.length ? '<p class="panel__note">' + reasons.join(' ') + '</p>' : '') +
      '<button class="btn btn--mini btn--enter" data-action="colonize" type="button"' +
        (canPay && def.habitable ? '' : ' disabled') + '>◉ Colonizza ▸</button>' +
      '<p class="panel__note">Le spedizioni coloniali richiedono ' + cost.impulsi + ' Impulsi di viaggio. Avanza il tempo per veder arrivare la nave.</p>' +
    '</div>';

  const btn = host.querySelector('[data-action="colonize"]');
  if (btn) btn.addEventListener('click', function () { tryColonize(planet); });
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
  const recent = Array.isArray(gov.recent) ? gov.recent : [];
  const ALERT_LABEL = {
    'gov-queue-empty':    'Coda di costruzione ferma',
    'gov-slots-idle':     'Slot inutilizzati',
    'gov-pop-near-cap':   'Popolazione vicina al tetto',
    'gov-supply-falling': 'Stock in calo',
    'gov-veterans-idle':  'Veterani disponibili'
  };
  const recentHtml = recent.length
    ? '<ul class="gov-log">' + recent.slice(0, 5).map(function (a) {
        const ds = ORION.time.format((g.startEpochOrbita || 0) * 100 + a.impulso, 'compact');
        const sub = (a.kind === 'gov-supply-falling' && a.sub)
          ? ' · ' + (a.sub === 'food' ? 'cibo' : 'acqua') : '';
        return '<li class="gov-log__item"><span class="gov-log__ds">' + ds + '</span>' +
               '<span class="gov-log__msg">' + (ALERT_LABEL[a.kind] || a.kind) + sub + '</span></li>';
      }).join('') + '</ul>'
    : '<p class="panel__note gov-log__empty">Nessuna segnalazione recente.</p>';
  return '<div class="gov-section" data-bind="gov-section">' +
    '<div class="gov-section__head">' +
      '<p class="sysinfo__sub gov-section__title">' +
        '<span class="gov-section__glyph" aria-hidden="true">⚙</span> ' +
        'Governatore <em>(Tier 1 · Vigile)</em>' +
      '</p>' +
      '<label class="gov-toggle">' +
        '<input type="checkbox" data-action="gov-toggle"' + (enabled ? ' checked' : '') + '>' +
        '<span>' + (enabled ? 'Attivo' : 'Inattivo') + '</span>' +
      '</label>' +
    '</div>' +
    '<p class="panel__note gov-section__hint">' +
      (enabled
        ? 'Sorveglia coda, slot, popolazione, scorte e veterani — segnala in cronaca, non agisce.'
        : 'Attiva per ricevere segnalazioni contestuali su questa colonia.') +
    '</p>' +
    (enabled ? recentHtml : '') +
  '</div>';
}
function bindGovernorHandlers(host, planet, colony) {
  if (!host) return;
  const toggle = host.querySelector('[data-action="gov-toggle"]');
  if (!toggle) return;
  toggle.addEventListener('change', function (e) {
    if (!ORION.governor) return;
    ORION.governor.setEnabled(colony, e.target.checked);
    if (e.target.checked && ORION.tutorial) ORION.tutorial.fire('governor');
    if (ORION.save && ORION.save.autosave && ORION.game) ORION.save.autosave(ORION.game);
    /* Ri-render del tab corrente (mostra/nasconde il log recenti). */
    renderPlanetColoniaTab(host, planet, colony);
  });
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
  ['met', 'en', 'water', 'food'].forEach(function (k) {
    homeColony.stock[k] = Math.max(0, (homeColony.stock[k] || 0) - cost[k] * mul);
  });
  // M05: la colonia entra in stato "in arrivo" — il loop la attiverà al
  // termine del countdown (Impulsi da §4.4/§6.2).
  colony.colonizing = {
    startedAt: ORION.time.currentDS(g),
    duration: cost.impulsi
  };
  pushChronicle(ORION.time.currentDS(g) + ' — Spedizione coloniale in viaggio verso <strong>' + planet.name + '</strong>' + bodyTagHtml(planet.systemId) + ' (' + cost.impulsi + ' I).', 'planet');
  if (ORION.tutorial) ORION.tutorial.fire('specialization');
  persistGame(g);
  updateGlobalResourceHud();
  updatePlanetUI();
  if (ORION.planetView) ORION.planetView.refresh(colony);
}

/* --- Tab Risorse --- */
function renderPlanetRisorseTab(host, planet, colony) {
  const out = ORION.planet.structureOutput(colony, planet);
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
      rateGrid(out.rates, out.upkeep) +
      '<p class="sysinfo__sub">Risorse avanzate</p>' +
      advancedHtml +
    '</div>';
}

/* Saldo netto per Impulso che si otterrebbe espandendo (o costruendo)
   una struttura: produzione − consumo, dopo − prima. Tiene conto dei
   modificatori (es. fonderia che amplifica le miniere). */
function marginalNet(colony, planet, structId) {
  const before = ORION.planet.structureOutput(colony, planet);
  const cur = colony.structures[structId];
  const curLvl = cur ? (cur.level || 0) : 0;
  const clonedStructures = Object.assign({}, colony.structures);
  clonedStructures[structId] = { level: curLvl + 1, hp: cur ? cur.hp : 100 };
  const clonedColony = Object.assign({}, colony, { structures: clonedStructures });
  const after = ORION.planet.structureOutput(clonedColony, planet);
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
    parts.push('<span class="' + cls + '">' + sign + val + ' ' + resGlyph(k) + '</span>');
  });
  if (!parts.length) return '';
  return '<span class="struct-item__delta" title="Saldo netto per Impulso se costruita">' + parts.join(' ') + '</span>';
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

  let html = '<div class="sysinfo">' +
    '<p class="planet-slots">Slot · <strong>' + (used + inQueue) + ' / ' + planet.slots + '</strong>' +
      (inQueue ? ' <span class="planet-slots__queue">(' + inQueue + ' in coda)</span>' : '') + '</p>';

  // costruite
  const builtIds = Object.keys(colony.structures);
  if (builtIds.length) {
    html += '<p class="sysinfo__sub">Costruite</p><ul class="struct-list">';
    builtIds.forEach(function (id) {
      const def = S.get(id);
      const ent = colony.structures[id];
      const lvl = ent.level || 1;
      const maxL = def.maxLevel || 1;
      const slotInfo = (def.slots && def.slots > 1)
        ? (lvl * def.slots) + ' slot'
        : lvl + (lvl > 1 ? ' moduli' : ' modulo');
      const demoCheck = ORION.planet.canDemolish(colony, planet, id);
      const demoBtn = demoCheck.ok
        ? '<button class="btn btn--mini struct-item__demolish" data-demolish="' + id + '" type="button" title="Smantella (rimborso 50% · 70% sulla colonia natale · morale −0,10 per 30 Ι)">🗑</button>'
        : '<span class="struct-item__locked is-busy" title="' + demoCheck.reason + '">🗑</span>';
      // Decisione #38: bottone "+ Espandi" (aggiunge un modulo = +slot, costo escalante)
      let upBtn;
      let infoLine;
      if (lvl >= maxL) {
        upBtn = '<span class="struct-item__locked" title="Livello massimo (' + maxL + ')">max</span>';
        infoLine = '<div class="struct-item__cost struct-item__cost--max">Livello massimo</div>';
      } else {
        const up = ORION.planet.canBuild(colony, planet, id);
        const nextCost = S.stepCost(def, lvl + 1);
        const nextTime = S.stepTime(def, lvl + 1);
        const costStr = Object.keys(nextCost).map(function (k) { return '<span class="struct-item__cost-item">' + resGlyph(k) + nextCost[k] + '</span>'; }).join(' ');
        const balance = deltaBalanceHtml(marginalNet(colony, planet, id));
        if (up.ok) {
          upBtn = '<button class="btn btn--mini btn--icon" data-build="' + id + '" type="button" title="Espandi a ×' + (lvl + 1) + ' (+' + (def.slots || 1) + ' slot)" aria-label="Espandi">+</button>';
        } else {
          upBtn = '<span class="struct-item__locked struct-item__locked--icon" title="' + escapeHtml(up.reason) + '" aria-label="Espandi (bloccato)">+</span>';
        }
        infoLine = '<div class="struct-item__cost"><span class="struct-item__cost-label">×' + (lvl + 1) + '</span> ' + costStr + ' <span class="struct-item__cost-time">' + nextTime + ' I</span>' + (balance ? ' ' + balance : '') + '</div>';
      }
      html += '<li class="struct-item is-built">' +
        '<span class="struct-item__glyph">' + def.glyph + '</span>' +
        '<div class="struct-item__main">' +
          '<div class="struct-item__name">' + def.name + ' <span class="struct-item__lvl">×' + lvl + '</span> <span class="struct-item__cat">' + slotInfo + '</span></div>' +
          infoLine +
        '</div>' +
        upBtn + demoBtn +
      '</li>';
    });
    html += '</ul>';
  }

  // in coda — con countdown e barra di avanzamento (M05)
  if (colony.queue.length) {
    html += '<p class="sysinfo__sub">In costruzione</p><ul class="struct-list">';
    colony.queue.forEach(function (q, idx) {
      const def = S.get(q.id);
      const isDemo = q.target === 'demolish';
      const total = isDemo ? Math.max(1, Math.round((def.time || 2) / 2)) : (def.time || 1);
      const remain = Math.max(0, q.duration | 0);
      const pct = Math.round(((total - remain) / total) * 100);
      const label = isDemo ? ('Smantellamento di ' + def.name) : def.name;
      const cancelTitle = isDemo ? 'Annulla smantellamento (nessuna penalità)' : 'Annulla (rimborso 80%)';
      html += '<li class="struct-item is-queue' + (isDemo ? ' is-demolish' : '') + '">' +
        '<span class="struct-item__glyph">' + def.glyph + '</span>' +
        '<div class="struct-item__main">' +
          '<div class="struct-item__name">' + label + ' <span class="struct-item__cat">' + remain + ' / ' + total + ' I</span></div>' +
          '<div class="progress-bar progress-bar--mini"><div class="progress-bar__fill" style="width:' + pct + '%"></div></div>' +
        '</div>' +
        '<button class="btn btn--mini struct-item__cancel" data-cancel="' + idx + '" type="button" title="' + cancelTitle + '">×</button>' +
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
          '<div class="struct-item__name">Mappatura risorse avanzate <span class="struct-item__cat">' + remain + ' I</span></div>' +
          '<div class="progress-bar progress-bar--mini"><div class="progress-bar__fill" style="width:' + pct + '%"></div></div>' +
        '</div>' +
      '</div>';
  }

  // M07 (decisione #39): blocco Cantieri & Squadre — visibile solo se
  // almeno una delle due strutture-gancio è costruita.
  html += renderCantieriSection(colony, planet);

  // costruibili — solo strutture NON ancora presenti (decisione #38: quelle
  // già costruite si potenziano dal bottone "+ Espandi" in "Costruite").
  const available = S.buildableOn(planet.type).filter(function (def) {
    return !colony.structures[def.id];
  });
  html += '<p class="sysinfo__sub">Costruibili</p>';
  const byCat = {};
  available.forEach(function (def) { (byCat[def.cat] = byCat[def.cat] || []).push(def); });
  Object.keys(S.CATEGORIES).forEach(function (cat) {
    const list = byCat[cat]; if (!list) return;
    html += '<details class="struct-cat" open><summary>' + S.CATEGORIES[cat].glyph + ' ' + S.CATEGORIES[cat].label + '</summary><ul class="struct-list">';
    list.forEach(function (def) {
      const check = ORION.planet.canBuild(colony, planet, def.id);
      const cost = def.cost || {};
      const costStr = Object.keys(cost).map(function (k) { return '<span class="struct-item__cost-item">' + resGlyph(k) + cost[k] + '</span>'; }).join(' ');
      const balance = deltaBalanceHtml(marginalNet(colony, planet, def.id));
      let statusCell;
      let extraClass = check.ok ? '' : ' is-locked';
      if (check.ok) {
        statusCell = '<button class="btn btn--mini" data-build="' + def.id + '" type="button">Costruisci</button>';
      } else if (check.code === 'building') {
        const qEntry = colony.queue.find(function (q) { return q.id === def.id; });
        const total = def.time || 1;
        const remain = qEntry ? Math.max(0, qEntry.duration | 0) : total;
        statusCell = '<span class="struct-item__locked is-building" title="In costruzione (' + remain + ' / ' + total + ' I)">▶ In costruzione · ' + remain + '/' + total + ' I</span>';
        extraClass += ' is-building';
      } else if (check.code === 'demolishing') {
        const qEntry = colony.queue.find(function (q) { return q.id === def.id; });
        const total = Math.max(1, Math.round((def.time || 2) / 2));
        const remain = qEntry ? Math.max(0, qEntry.duration | 0) : total;
        statusCell = '<span class="struct-item__locked is-demolish" title="In smantellamento (' + remain + ' / ' + total + ' I)">🛠 Smantellamento · ' + remain + '/' + total + ' I</span>';
        extraClass += ' is-building';
      } else if (check.code === 'busy') {
        statusCell = '<span class="struct-item__locked is-busy" title="' + check.reason + '">⏳ Occupato</span>';
      } else {
        statusCell = '<span class="struct-item__locked" title="' + check.reason + '">◌</span>';
      }
      html += '<li class="struct-item' + extraClass + '" title="' + def.desc + '">' +
        '<span class="struct-item__glyph">' + def.glyph + '</span>' +
        '<div class="struct-item__main">' +
          '<div class="struct-item__name">' + def.name + ' <span class="struct-item__cat">' + def.time + ' I</span></div>' +
          '<div class="struct-item__cost">' + costStr + (balance ? ' ' + balance : '') + '</div>' +
        '</div>' +
        '<button class="btn btn--mini struct-item__info" data-info="' + def.id + '" type="button" title="Cosa fa, bonus/malus, concatenazioni" aria-label="Informazioni su ' + def.name + '">i</button>' +
        statusCell +
      '</li>';
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
  /* M07: cantieri scafi/equipaggi */
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

function tryBuild(id) {
  const g = ORION.game;
  const colony = g.colonies[ORION.openPlanetKey];
  const planet = ORION.currentPlanet;
  // M05: la struttura va in coda e maturerà col game loop. Niente più
  // auto-complete (era lo stub M04).
  const r = ORION.planet.startBuild(colony, planet, id, ORION.time.currentDS(g));
  if (!r.ok) { console.info('Costruzione rifiutata:', r.reason); return; }
  const def = ORION.structures.get(id);
  pushChronicle(ORION.time.currentDS(g) + ' — Avviata costruzione: <strong>' + def.name + '</strong> su ' + planet.name + bodyTagHtml(planet.systemId) + ' (' + def.time + ' I).', 'planet');
  /* M06.7: alla prima costruzione di un certo tipo, mostra la scheda
     tutorial dedicata (rispetta isEnabled + isSeen — niente spam). */
  if (ORION.tutorial && ORION.tutorial.fire) ORION.tutorial.fire('struct:' + id);
  persistGame(g);
  updateGlobalResourceHud();
  updatePlanetUI();
}

function tryCancel(idx) {
  const colony = ORION.game.colonies[ORION.openPlanetKey];
  ORION.planet.cancelBuild(colony, idx);
  updateGlobalResourceHud();
  updatePlanetUI();
}

function tryDemolish(id) {
  const g = ORION.game;
  const colony = g.colonies[ORION.openPlanetKey];
  const planet = ORION.currentPlanet;
  const def = ORION.structures.get(id);
  if (!def) return;
  const refundPct = colony.isHomeBase ? 70 : 50;
  const dur = Math.max(1, Math.round((def.time || 2) / 2));
  const confirmMsg = 'Smantellare "' + def.name + '"?\n\n'
    + '· Tempo: ' + dur + ' Ι (occupa il cantiere)\n'
    + '· Rimborso: ' + refundPct + '% del costo originale\n'
    + '· Morale −0,10 per 30 Ι (decadimento lineare)\n\n'
    + 'La struttura resta operativa fino alla fine dello smantellamento.';
  if (!window.confirm(confirmMsg)) return;
  const r = ORION.planet.startDemolish(colony, planet, id, ORION.time.currentDS(g));
  if (!r.ok) { console.info('Smantellamento rifiutato:', r.reason); return; }
  pushChronicle(ORION.time.currentDS(g) + ' — Avviato smantellamento: <strong>' + def.name + '</strong> su ' + planet.name + bodyTagHtml(planet.systemId) + ' (' + dur + ' Ι).', 'planet');
  persistGame(g);
  updateGlobalResourceHud();
  updatePlanetUI();
}

/* =====================================================================
   M07 — Cantieri & Squadre (decisione #37): UI nella tab Strutture
   ===================================================================== */
function renderCantieriSection(colony, planet) {
  const hasHangar = !!(colony.structures && colony.structures['cantiere-navale']);
  const hasAcademy = !!(colony.structures && colony.structures['accademia-militare']);
  if (!hasHangar && !hasAcademy) return '';
  const E = (ORION.expedition && ORION.expedition.CFG) || {};
  const shipCost = E.SHIP_COST || { met: 25, en: 12 };
  const shipTime = E.SHIP_TIME || 10;
  const crewCost = E.CREW_COST || { food: 12, water: 6 };
  const crewTime = E.CREW_TIME || 12;
  ORION.planet.ensureAssets(colony);

  function costStr(c) {
    return Object.keys(c).map(function (k) { return resGlyph(k) + c[k]; }).join(' · ');
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

  if (hasHangar) {
    const sShips = colony.ships && colony.ships.explorer || 0;
    const queue = colony.assets.shipQueue || [];
    const payOk = canPay(shipCost);
    html += '<div class="cantieri-row">' +
      '<div class="cantieri-row__head">' +
        '<span class="cantieri-row__glyph" aria-hidden="true">▱</span>' +
        '<span class="cantieri-row__name">Hangar di costruzione</span>' +
        '<span class="cantieri-row__counter">Scafi: <strong>' + sShips + '</strong></span>' +
      '</div>';
    queue.forEach(function (q, idx) {
      const total = shipTime;
      const remain = Math.max(0, q.duration | 0);
      const pct = Math.round(((total - remain) / total) * 100);
      html += '<div class="struct-item is-queue">' +
        '<span class="struct-item__glyph">▱</span>' +
        '<div class="struct-item__main">' +
          '<div class="struct-item__name">Scafo esploratore <span class="struct-item__cat">' + remain + ' / ' + total + ' I</span></div>' +
          '<div class="progress-bar progress-bar--mini"><div class="progress-bar__fill" style="width:' + pct + '%"></div></div>' +
        '</div>' +
        '<button class="btn btn--mini struct-item__cancel" data-cancel-ship="' + idx + '" type="button" title="Annulla (rimborso 50%)">×</button>' +
      '</div>';
    });
    html += '<div class="cantieri-row__build">' +
      '<span class="cantieri-row__cost">' + costStr(shipCost) + ' · ' + shipTime + ' I</span>' +
      '<button class="btn btn--mini" data-build-ship type="button"' + (payOk ? '' : ' disabled') + '>+ Scafo esploratore</button>' +
    '</div></div>';
  }

  if (hasAcademy) {
    const crews = (colony.crews && colony.crews.explorer) || [];
    const avg = crews.length ? (ORION.expedition.averageXp(crews)).toFixed(1) : '0';
    const queue = colony.assets.crewQueue || [];
    const payOk = canPay(crewCost);
    html += '<div class="cantieri-row">' +
      '<div class="cantieri-row__head">' +
        '<span class="cantieri-row__glyph" aria-hidden="true">⚔</span>' +
        '<span class="cantieri-row__name">Accademia militare</span>' +
        '<span class="cantieri-row__counter">Equipaggi: <strong>' + crews.length + '</strong>' +
          (crews.length ? ' <span class="xp-chip" title="Esperienza media">xp ' + avg + '</span>' : '') +
        '</span>' +
      '</div>';
    queue.forEach(function (q, idx) {
      const total = crewTime;
      const remain = Math.max(0, q.duration | 0);
      const pct = Math.round(((total - remain) / total) * 100);
      html += '<div class="struct-item is-queue">' +
        '<span class="struct-item__glyph">⚔</span>' +
        '<div class="struct-item__main">' +
          '<div class="struct-item__name">Equipaggio esploratore <span class="struct-item__cat">' + remain + ' / ' + total + ' I</span></div>' +
          '<div class="progress-bar progress-bar--mini"><div class="progress-bar__fill" style="width:' + pct + '%"></div></div>' +
        '</div>' +
        '<button class="btn btn--mini struct-item__cancel" data-cancel-crew="' + idx + '" type="button" title="Annulla (rimborso 50%)">×</button>' +
      '</div>';
    });
    html += '<div class="cantieri-row__build">' +
      '<span class="cantieri-row__cost">' + costStr(crewCost) + ' · ' + crewTime + ' I</span>' +
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
  const r = ORION.planet.startShipBuild(colony, planet);
  if (!r.ok) { console.info('Costruzione scafo rifiutata:', r.reason); showToast(r.reason); return; }
  pushChronicle(ORION.time.currentDS(g) + ' — Avviata costruzione di uno <strong>scafo esploratore</strong> su ' + planet.name + bodyTagHtml(planet.systemId) + '.', 'planet');
  persistGame(g);
  updateGlobalResourceHud();
  updatePlanetUI();
}

function tryBuildCrew() {
  const g = ORION.game;
  const colony = g.colonies[ORION.openPlanetKey];
  const planet = ORION.currentPlanet;
  const r = ORION.planet.startCrewBuild(colony, planet);
  if (!r.ok) { console.info('Formazione equipaggio rifiutata:', r.reason); showToast(r.reason); return; }
  pushChronicle(ORION.time.currentDS(g) + ' — Avviata formazione di un <strong>equipaggio esploratore</strong> presso l\'Accademia di ' + planet.name + bodyTagHtml(planet.systemId) + '.', 'planet');
  persistGame(g);
  updateGlobalResourceHud();
  updatePlanetUI();
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
          '<span class="expedition-item__eta">ETA ' + rem + ' I</span>' +
        '</div>' +
        '<div class="expedition-item__bars">' +
          '<div class="wear-bar" title="Usura scafo ' + wear + '%">' +
            '<div class="wear-bar__fill" style="width:' + wear + '%"></div>' +
            '<span class="wear-bar__label">scafo ' + wear + '%</span>' +
          '</div>' +
          '<span class="xp-chip" title="' + enr.label + '">xp ' + xp + ' · ' + enr.label + '</span>' +
          (incCount ? '<span class="expedition-item__inc" title="Incidenti accumulati">⚠ ' + incCount + '</span>' : '') +
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
      '<button class="btn btn--mini btn--enter" data-action="exp-organize" type="button"' +
        ((canOrganize && hasTargets) ? '' : ' disabled') +
        ' title="' + (canOrganize ? (hasTargets ? 'Pianifica un salto iperspaziale' : 'Nessuna rotta inesplorata adiacente') : 'Servono uno scafo e un equipaggio') + '">' +
        '✦ Organizza spedizione ▸' +
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
    const chance = ORION.expedition.accidentChance(g.galaxy, sid, crewXp);
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
        '<div><dt>Durata viaggio</dt><dd>' + dur + ' I (a/r)</dd></div>' +
        '<div><dt>Rischio incidente</dt><dd>' + Math.round(chance * 100) + '%</dd></div>' +
      '</dl>' +
      '<div class="expedition-card__actions">' +
        '<button class="btn btn--mini btn--primary" data-action="exp-launch" data-sys="' + sid + '" type="button">✦ Invia</button>' +
      '</div>' +
    '</div>';
  }).join('');

  host.innerHTML =
    '<div class="expedition-pick-overlay__panel" role="document">' +
      '<header class="expedition-pick-overlay__head">' +
        '<h2 class="expedition-pick-overlay__title">Organizza spedizione</h2>' +
        '<button class="btn btn--mini" data-action="exp-pick-close" type="button" aria-label="Chiudi">✕</button>' +
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
  const r = ORION.expedition.launch(g, key, targetSystemId);
  if (!r.ok) { showToast(r.reason || 'Lancio rifiutato'); return; }
  const sys = g.galaxy.systems[targetSystemId];
  const acr = regionAcronymFor(targetSystemId);
  const tag = acr ? ' <span class="name-tag">[' + acr + ']</span>' : '';
  pushChronicle(ORION.time.currentDS(g) + ' — Spedizione partita verso <strong>' +
    (sys ? sys.name : 'sistema ignoto') + '</strong>' + tag +
    ' · salto iperspaziale, durata stimata ' + r.expedition.durationOut + ' I.', 'explore');
  if (ORION.tutorial) ORION.tutorial.fire('expedition-launch');
  closeExpeditionPicker();
  persistGame(g);
  updatePlanetUI();
}

/* --- Tab Popolazione --- */
function renderPlanetPopolazioneTab(host, planet, colony) {
  const classes = colony.pop.classes;
  const total = colony.pop.total;
  const cap = colony.pop.cap;
  // Persone correnti (units frazionarie per fluidità): le classi ne sono
  // una quota proporzionale (interi internamente → persone a schermo).
  const peopleNow = ORION.planet.peopleAt(total + (colony.pop.accum || 0), planet);
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

  // Capacità di carico locale (decisione #37): il consumo pro-capite è una
  // RICHIESTA sulla produzione di cibo/acqua, non un drenaggio dello stock.
  // La popolazione cresce finché produzione > consumo e si stabilizza in
  // plateau quando si pareggiano — senza carestia. Legge del minimo.
  const out = ORION.planet.structureOutput(colony, planet);
  const foodNet = (out.rates.food || 0) - (out.upkeep.food || 0);
  const waterNet = (out.rates.water || 0) - (out.upkeep.water || 0);
  const sustFood = CFG.POP_FOOD_PER_UNIT > 0 ? foodNet / CFG.POP_FOOD_PER_UNIT : 0;
  const sustWater = CFG.POP_WATER_PER_UNIT > 0 ? waterNet / CFG.POP_WATER_PER_UNIT : 0;
  let sustainable = Math.min(sustFood, sustWater);
  if (sustainable < 0) sustainable = 0;
  if (sustainable > cap) sustainable = cap;
  const limitRes = sustWater <= sustFood ? 'acqua' : 'cibo';
  const foodSurplus = foodNet - total * CFG.POP_FOOD_PER_UNIT;
  const waterSurplus = waterNet - total * CFG.POP_WATER_PER_UNIT;
  const surplus = Math.min(foodSurplus, waterSurplus);
  const supplyFactor = surplus <= 0 ? 0 : Math.min(1, surplus / CFG.POP_SUPPLY_REF);

  const critFW = scar && (scar.food.state === 'crit' || scar.water.state === 'crit');
  const canGrow = !settling && total < cap && supplyFactor > 0 && !critFW;
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
    growthStr = '+' + ORION.planet.formatPeople(marginal) + ' / Impulso';
  } else if (settling) {
    growthStr = 'ferma (Insediamento)';
  } else if (total >= cap) {
    growthStr = 'al cap del pianeta';
  } else if (critFW) {
    growthStr = 'ferma (carenza critica)';
  } else {
    growthStr = 'plateau · ' + limitRes + ' locale al limite';
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
    targetHtml = '<p class="panel__note">Mix tendenziale: ' + targetBits + '</p>';
  }

  host.innerHTML =
    '<div class="sysinfo">' +
      '<dl class="sysinfo__list">' +
        row('Popolazione', popRangePeople(colony, planet)) +
        row('Sostenibile (locale)', '~' + Math.floor(sustainable) + ' / ' + cap + ' unità · ' +
            ORION.planet.formatPeople(ORION.planet.peopleAt(sustainable, planet)) +
            ' <span class="pop-limit">(limite: ' + limitRes + ')</span>') +
        row('Morale', morale.toFixed(2) + ' / ' + CFG.POP_MORALE_MAX.toFixed(2)) +
        row('Crescita', '<span class="rate ' + (canGrow ? 'rate--pos' : 'rate--neg') + '">' + growthStr + '</span>') +
      '</dl>' +
      '<p class="panel__note">Morale: ' + moraleParts.join(' · ') + '. Moltiplica la crescita della popolazione.</p>' +
      '<p class="panel__note">La crescita si ferma in <strong>plateau</strong> (senza carestia) quando l\'ambiente non regge più popolazione. Entrano in gioco più fattori — risorse, energia, <strong>morale</strong> — e una città che cresce ne mette alla prova di nuovi. Osserva cosa cala e adatta la colonia.</p>' +
      '<p class="sysinfo__sub">Classi funzionali</p>' +
      bars +
      targetHtml +
    '</div>';

  if (ORION.tutorial) ORION.tutorial.fire('population');
}

/* --- helper: barre dei potenziali e altre UI atomiche --- */
function potentialBars(planet) {
  const keys = ['met', 'en', 'food', 'water'];
  const labels = { met: 'Metalli', en: 'Energia', food: 'Cibo', water: 'Acqua' };
  return '<ul class="pot-list">' + keys.map(function (k) {
    const v = planet.potentials[k] || 0;
    return '<li class="pot-item"><span class="pot-item__label">' + resGlyph(k) + ' ' + labels[k] + '</span>' +
      '<div class="pot-item__bar"><div class="pot-item__fill pot--' + k + '" style="width:' + v + '%"></div></div>' +
      '<span class="pot-item__val">' + v + '</span></li>';
  }).join('') + '</ul>';
}

function rateGrid(rates, upkeep) {
  function fmtNet(v) { return (v >= 0 ? '+' : '−') + (Math.round(Math.abs(v) * 100) / 100); }
  function fmtAbs(v) { return Math.round(Math.abs(v) * 100) / 100; }
  const items = [];
  ['met', 'en', 'food', 'water'].forEach(function (k) {
    const r = rates[k] || 0; const u = upkeep[k] || 0; const net = r - u;
    if (r || u) items.push(row(resLabel(k), '<span class="rate ' + (net >= 0 ? 'rate--pos' : 'rate--neg') + '">' + fmtNet(net) + ' / I</span> <span class="rate-aux">(+' + fmtAbs(r) + ' / −' + fmtAbs(u) + ')</span>'));
  });
  if (rates.research) items.push(row('Ricerca', '<span class="rate rate--pos">+' + (Math.round(rates.research * 100) / 100) + ' / I</span>'));
  if (rates.scan) items.push(row('Scansione', '<span class="rate rate--pos">+' + rates.scan + ' / I</span>'));
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

/* Colore del pallino di un corpo per le chip della sidebar. */
function bodyDotColor(b) {
  const pal = ORION.system.BODY_TYPES[b.type].palette;
  if (pal.bands) return ORION.system.GAS_VARIANTS[b.variant || 0].base;
  return pal.land || pal.rock || '#9aa6cc';
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
  'build-done': true, 'demolish-done': true, 'colony-done': true, 'scan-done': true,
  'scarcity': true, 'scarcity-recover': true, 'pop-loss': true,
  'victory': true, 'settle-stage': true, 'settle-done': true,
  /* M07 (decisione #37): pausa solo su esiti notevoli. Non su launch
     (azione utente), né su ship-built/crew-formed (frequenti). */
  'expedition-arrived': true, 'expedition-ship-lost': true, 'expedition-discovery': true,
  /* M07.1 (decisione #40): le 2 segnalazioni urgenti del Governatore
     si auto-pausano (carenze in arrivo e coda ferma da troppo); le 3
     strategiche (slot liberi, pop vicina al tetto, veterani inattivi)
     restano in cronaca senza interrompere il gioco. L'utente può
     spegnere ognuna dall'overlay di pausa. */
  'gov-supply-falling': true, 'gov-queue-empty': true,
  'gov-slots-idle': false, 'gov-pop-near-cap': false, 'gov-veterans-idle': false
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
  /* Shortcuts globali (decisione #31): Space play/pause · +/- speed
     · → singolo Ι · E prossimo evento. Ignorati su input/textarea. */
  document.addEventListener('keydown', function (e) {
    if (!ORION.game) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.target.isContentEditable) return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); changeSpeed(+1); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); changeSpeed(-1); }
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
    const base = (g.startEpochOrbita || 0) * 100 + (g.timeImpulsi || 0);
    /* mostra l'Ι "in transito": la cifra Ι scorre verso la successiva */
    setHudDate(ORION.time.format(base + Math.floor(frac), 'compact'));
    ORION.timer.rafId = requestAnimationFrame(frame);
  }
  ORION.timer.rafId = requestAnimationFrame(frame);
}
function stopDateInterpolation() {
  if (ORION.timer.rafId) { cancelAnimationFrame(ORION.timer.rafId); ORION.timer.rafId = null; }
}

/* Disegna i 5 controlli compatti (decisione #31) nella barra HUD. */
function renderTimeControls() {
  const host = document.querySelector('[data-bind="time-controls"]');
  if (!host) return;
  const playing = ORION.timer.playing;
  const glyph = playing ? '⏸' : '▶';
  const label = timerLabel();
  const idx = PLAY_LEVELS.indexOf(ORION.timer.level);
  const atMin = idx <= 0, atMax = idx >= PLAY_LEVELS.length - 1;
  host.innerHTML =
    '<button class="btn btn--mini btn--play-step" data-action="play-slower" type="button"' +
    (atMin ? ' disabled' : '') + ' title="Rallenta (-)">−</button>' +
    '<button class="btn btn--play" data-action="play-toggle" type="button" title="Play/Pause (Space)">' +
      '<span class="btn__glyph" aria-hidden="true">' + glyph + '</span>' +
      '<span class="btn__label">' + escapeHtml(label) + '</span>' +
    '</button>' +
    '<button class="btn btn--mini btn--play-step" data-action="play-faster" type="button"' +
    (atMax ? ' disabled' : '') + ' title="Accelera (+)">+</button>' +
    '<button class="btn btn--mini" data-action="play-step" type="button" title="Singolo Impulso (→)">' +
      '<span class="btn__glyph" aria-hidden="true">⏵Ι</span>' +
    '</button>' +
    '<button class="btn btn--primary btn--next-event" data-action="advance-to-event" type="button" title="Prossimo evento (E)">' +
      '<span class="btn__glyph" aria-hidden="true">⏭</span>' +
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
    'colony-done': 'Nuova colonia',
    'scan-done': 'Scansione completata',
    'scarcity': 'Carenza',
    'scarcity-recover': 'Carenza rientrata',
    'pop-loss': 'Calo popolazione',
    'victory': 'Pista chiusa',
    'settle-stage': 'Fase Insediamento',
    'settle-done': 'Insediamento completato',
    'expedition-arrived': 'Spedizione: sistema esplorato',
    'expedition-ship-lost': 'Spedizione: scafo perso',
    'expedition-discovery': 'Spedizione: scoperta fortuita',
    'gov-queue-empty': 'Governatore: coda di costruzione ferma',
    'gov-slots-idle': 'Governatore: slot inutilizzati',
    'gov-pop-near-cap': 'Governatore: popolazione vicina al tetto',
    'gov-supply-falling': 'Governatore: stock in calo',
    'gov-veterans-idle': 'Governatore: veterani disponibili'
  };
  /* Raggruppa per kind: una checkbox per categoria, una sola voce di sintesi. */
  const byKind = {};
  triggered.forEach(function (e) { (byKind[e.kind] = byKind[e.kind] || []).push(e); });
  let html = '<div class="event-overlay__panel" role="alertdialog" aria-label="Evento — tempo in pausa">' +
    '<h3 class="event-overlay__title">⏸ Tempo in pausa</h3>' +
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
  const ds = ORION.time.format((ORION.game.startEpochOrbita || 0) * 100 + ev.impulso);
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
    pushChronicle(ds + ' — Nuovo <strong>scafo esploratore</strong> pronto al varo su ' + pname + ptag + '.', 'planet');
  } else if (ev.kind === 'crew-formed') {
    pushChronicle(ds + ' — Nuovo <strong>equipaggio esploratore</strong> brevettato dall\'Accademia di ' + pname + ptag + '.', 'planet');
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
  }
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
  document.querySelectorAll('.nav-item').forEach((i) => {
    i.classList.toggle('is-active', i.dataset.view === view);
  });
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
  if (el) el.textContent = ds;
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
    (hasGame ? '<button class="btn" data-action="save-export" type="button">⬇ Esporta .json</button>' : '') +
    '<button class="btn" data-action="save-import" type="button">⬆ Importa .json</button>' +
    (hasGame ? '<button class="btn btn--danger" data-action="save-newgame" type="button">✦ Nuova partita</button>' : '') +
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
  return '<div class="save-card' + (perms.isAuto ? ' save-card--auto' : '') + '">' +
    '<div class="save-card__name">' + escapeHtml(meta.name) + '</div>' +
    '<dl class="save-card__meta">' +
      '<div><dt>Data Stellare</dt><dd>' + ds + '</dd></div>' +
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
  const orb = p.startEpochOrbita || 0;
  const i = p.timeImpulsi || 0;
  return ORION.time.format(orb * 100 + i, 'compact');
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
function enterGame() {
  if (ORION.planetView) { ORION.planetView.destroy(); ORION.planetView = null; ORION.openPlanetKey = null; ORION.currentPlanet = null; }
  if (ORION.systemView) { ORION.systemView.destroy(); ORION.systemView = null; ORION.openSystemId = -1; ORION.currentSystem = null; }
  if (ORION.map) { ORION.map.destroy(); ORION.map = null; }
  hideMainMenu();
  const stage = document.querySelector('[data-view-stage]');
  if (stage) renderGalaxyView(stage);
  setNavActive('galaxy');
  updateGlobalResourceHud();
  setHudDate(ORION.time.currentDS(ORION.game));
  renderTimeControls();        /* #31: ridisegna i 5 controlli per la partita */
  updateTimeControlsHint();
  /* M06.6: tutorial — la "?" diventa attiva solo dentro partita. */
  updateTutorialButton();
  /* Welcome: prima trigger della partita (solo se tutorial attivo e non già vista). */
  if (ORION.tutorial) ORION.tutorial.fire('welcome');
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
      '<button class="btn btn--menu btn--menu-primary' + (hasAuto ? '' : ' is-disabled') + '" ' +
        'data-action="menu-continue" type="button"' + (hasAuto ? '' : ' disabled') + '>' +
        '<span class="btn__glyph">▶</span> Continua' +
        (meta ? '<span class="btn__sub">' + escapeHtml(meta) + '</span>' : '<span class="btn__sub">nessun autosave</span>') +
      '</button>' +
      '<button class="btn btn--menu" data-action="menu-new" type="button">' +
        '<span class="btn__glyph">✦</span> Nuova partita' +
        '<span class="btn__sub">scegli seed, preset, ironman</span>' +
      '</button>' +
      '<button class="btn btn--menu" data-action="menu-load" type="button">' +
        '<span class="btn__glyph">📂</span> Carica partita' +
        '<span class="btn__sub">slot + import .json</span>' +
      '</button>' +
      '<button class="btn btn--menu" data-action="menu-info" type="button">' +
        '<span class="btn__glyph">ⓘ</span> Info' +
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

/* Etichetta breve per il sub del bottone Continua: "DS xxx · seed". */
function autoMetaFromPayload(p) {
  if (!p) return null;
  const ds = currentDsOfPayload(p);
  return ds + ' · seed ' + p.seed;
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
        '<span class="main-menu__field-label">Seed</span>' +
        '<div class="main-menu__field-row">' +
          '<input class="main-menu__input" type="text" data-bind="menu-seed" ' +
            'value="' + escapeHtml(ORION.menuForm.seed) + '" maxlength="32" autocomplete="off">' +
          '<button type="button" class="btn btn--mini" data-action="menu-seed-new" title="Genera un nuovo seed">⟳ Genera</button>' +
        '</div>' +
        '<span class="main-menu__field-hint">Il seed cristallizza la galassia. Sarà visibile in partita ma non rigenerabile.</span>' +
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

  seedInput.addEventListener('input', function () {
    ORION.menuForm.seed = seedInput.value.trim() || ORION.rng.newSeed();
  });
  seedBtn.addEventListener('click', function () {
    ORION.menuForm.seed = ORION.rng.newSeed();
    seedInput.value = ORION.menuForm.seed;
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
        candidates.length + ' candidati (uno per regione · seed <code>' + escapeHtml(seed) + '</code>). ' +
        'La scelta cristallizza il sistema d\'origine: il pericolo della galassia si ricalibra da lì.' +
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
      '<div><dt>Pericolo</dt><dd>' + escapeHtml(c.system.dangerTier) + ' (' + c.system.danger + ')</dd></div>' +
      '<div><dt>Ostilità ' + hostilityNoun(c.planet) + '</dt><dd>' + c.planet.hostility + '</dd></div>' +
      '<div><dt>Pop. max</dt><dd>' + popMaxPeople(c.planet) + '</dd></div>' +
      '<div><dt>Slot</dt><dd>' + c.planet.slots + '</dd></div>' +
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

function potBar(label, val) {
  const v = Math.max(0, Math.min(100, val));
  return '<div class="main-menu__pot">' +
    '<span class="main-menu__pot-label">' + label + '</span>' +
    '<span class="main-menu__pot-track"><span class="main-menu__pot-fill" style="width:' + v + '%"></span></span>' +
    '<span class="main-menu__pot-val">' + v + '</span>' +
  '</div>';
}

function confirmHomeAndStart(candidate) {
  const PRESETS = (ORION.victory && ORION.victory.PRESETS) || {};
  const presetId = ORION.menuForm.preset || 'classic';
  const presetMods = Object.assign({}, PRESETS[presetId] || PRESETS.classic || {});
  if (ORION.menuForm.ironman) presetMods.ironman = true;
  const mode = {
    startedAs: 'sandbox',
    preset: presetId,
    modifiers: presetMods
  };
  clearSavedGame();
  newGame(ORION.menuForm.seed, {
    mode: mode,
    homeWorld: { systemId: candidate.systemId, bodyKey: candidate.bodyKey },
    tutorialEnabled: !!ORION.menuForm.tutorial
  });
  /* Reset preview + form per la prossima apertura */
  ORION.menuPreview = null;
  ORION.menuForm = { seed: null, preset: presetId, ironman: !!presetMods.ironman, tutorial: !!ORION.menuForm.tutorial };
  enterGame();
  showToast('Colonia su ' + candidate.planet.name + ' · seed ' + ORION.game.seed);
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
function boot() {
  /* M06: assorbe eventuale autosave M05 (chiavi legacy). Idempotente. */
  if (ORION.save && ORION.save.migrateLegacy) ORION.save.migrateLegacy();
  /* Decisione #25: il boot non entra più direttamente in partita —
     si parte sempre dal main menu (Continua / Nuova / Carica / Info). */
  initNavigation();
  initTimeControls();
  initSaveControls();
  initTutorialControls();
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
