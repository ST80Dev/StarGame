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

ORION.version = '0.4.0-M04';

/* Etichette provvisorie del viewport per le viste non ancora implementate. */
ORION.viewLabels = {
  fleet:     { caption: 'VISTA FLOTTA',     hint: 'La gestione della flotta arriverà nel modulo M08.' },
  research:  { caption: 'VISTA RICERCA',    hint: "L'albero tecnologico arriverà nel modulo M13." },
  diplomacy: { caption: 'VISTA DIPLOMAZIA', hint: 'La diplomazia arriverà nel modulo M11.' }
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
ORION.planetTab = 'colonia';    // 'colonia' | 'risorse' | 'strutture' | 'popolazione'

/* Ultimo sistema annotato in cronaca (evita doppioni consecutivi). */
ORION.lastChronicleId = -1;

/* ---------------------------------------------------------------------
   Generazione/avvio di una partita (galassia)
   --------------------------------------------------------------------- */
/* Preview leggera della persistenza (M06): il seed della partita corrente
   vive in localStorage così l'F5 NON cambia galassia. Il salvataggio
   completo (delta colonie, scoperte, cronaca) arriva con M06; qui basta
   il seed perché la struttura della galassia si rigenera identica
   (decisione #5 seed+delta). Il pulsante "Nuova" del menu rigenera. */
const SEED_KEY = 'orion.seed';

function loadSavedSeed() {
  try { return window.localStorage.getItem(SEED_KEY) || null; }
  catch (e) { return null; }
}
function persistSeed(seed) {
  try { window.localStorage.setItem(SEED_KEY, seed); } catch (e) {}
}
function clearSavedSeed() {
  try { window.localStorage.removeItem(SEED_KEY); } catch (e) {}
}

function newGame(seed) {
  seed = seed || ORION.rng.newSeed();
  persistSeed(seed);
  const galaxy = ORION.galaxy.generate(seed);
  const state = ORION.galaxy.createState(galaxy);

  // Epoca d'inizio randomizzata DS 800.00–3000.00 (decisione #4), derivata
  // dal seed così da restare deterministica (parte del seed+delta).
  const erng = ORION.rng.makeRng(seed + ':epoch');
  const startOrbita = erng.int(800, 3000);
  const startDS = 'DS ' + startOrbita + '.00';

  ORION.game = {
    galaxy: galaxy, state: state, seed: seed, startDS: startDS,
    /* M04: stato colonie. Chiave "<sysId>:<bodyKey>" → ColonyState (delta,
       serializzabile per M06). La struttura immutabile del pianeta è
       rigenerata dal seed (decisione #5). */
    colonies: {}
  };

  // M04: colonizza il pianeta natale (homeWorld del sistema d'origine).
  colonizeHomePlanet(ORION.game, startDS);

  setHudDate(startDS);
  resetChronicle(galaxy, startDS);
  return ORION.game;
}

/* Genera struttura+colonia per il mondo natale e popola l'HUD risorse. */
function colonizeHomePlanet(game, startDS) {
  const galaxy = game.galaxy;
  const homeSys = ORION.system.generate(galaxy, galaxy.homeId);
  let homeBody = null;
  for (let i = 0; i < homeSys.bodies.length; i++) {
    if (homeSys.bodies[i].homeWorld) { homeBody = homeSys.bodies[i]; break; }
  }
  if (!homeBody) homeBody = homeSys.bodies[Math.floor(homeSys.bodies.length / 2)];
  const planet = ORION.planet.generate(galaxy, homeSys, homeBody.key);
  const colony = ORION.planet.createColony(planet);
  ORION.planet.colonizeHome(colony, planet, startDS);
  game.colonies[galaxy.homeId + ':' + homeBody.key] = colony;
  game.homePlanetKey = galaxy.homeId + ':' + homeBody.key;
  updateGlobalResourceHud();
}

/* Aggrega lo stock di tutte le colonie nell'HUD risorse-base. La vera
   produzione/aggiornamento per Impulso arriverà con M05. */
function updateGlobalResourceHud() {
  const totals = { met: 0, en: 0, food: 0, water: 0 };
  if (ORION.game && ORION.game.colonies) {
    Object.keys(ORION.game.colonies).forEach(function (k) {
      const c = ORION.game.colonies[k];
      if (!c.colonized) return;
      totals.met += c.stock.met || 0;
      totals.en  += c.stock.en  || 0;
      totals.food += c.stock.food || 0;
      totals.water += c.stock.water || 0;
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
}

/* ---------------------------------------------------------------------
   Navigazione tra viste
   --------------------------------------------------------------------- */
function initNavigation() {
  const items = document.querySelectorAll('.nav-item');
  const stage = document.querySelector('[data-view-stage]');

  items.forEach((item) => {
    item.addEventListener('click', () => {
      items.forEach((i) => i.classList.remove('is-active'));
      item.classList.add('is-active');
      renderView(stage, item.dataset.view);
    });
  });

  // vista iniziale = galassia
  renderView(stage, 'galaxy');
}

function renderView(stage, view) {
  if (!stage) return;

  // Galassia / Sistema / Pianeta condividono lo stage: ogni livello è un
  // layer sopra il precedente (#9). La mappa rimane sotto e preserva lo
  // zoom anche quando entriamo nel sistema o nel pianeta.
  if (view === 'galaxy' || view === 'system' || view === 'planet') {
    if (!ORION.map) renderGalaxyView(stage);
    const g = ORION.game;

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
  if (!ORION.game) newGame();
  const g = ORION.game;

  stage.innerHTML =
    '<div class="galaxy-root">' +
      '<div class="galaxy-holder"></div>' +
      '<div class="system-holder" data-system-holder hidden></div>' +
      '<div class="planet-holder" data-planet-holder hidden></div>' +
      '<nav class="galaxy-breadcrumb" data-breadcrumb aria-label="Percorso di navigazione"></nav>' +
      '<div class="galaxy-overlay">' +
        '<div class="galaxy-overlay__row">' +
          '<span class="galaxy-overlay__label">SEED</span>' +
          '<code class="galaxy-overlay__seed" data-bind="seed">' + g.seed + '</code>' +
        '</div>' +
        '<div class="galaxy-overlay__row">' +
          '<span class="galaxy-overlay__meta">' + g.galaxy.count + ' sistemi · ' + g.galaxy.groups.length + ' gruppi</span>' +
        '</div>' +
        '<div class="galaxy-overlay__actions">' +
          '<button class="btn btn--mini" data-action="galaxy-reset" type="button" title="Torna alla vista galassia">⤢ Galassia</button>' +
          '<button class="btn btn--mini" data-action="galaxy-new" type="button" title="Genera una nuova galassia">✦ Nuova</button>' +
        '</div>' +
      '</div>' +
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

  const resetBtn = stage.querySelector('[data-action="galaxy-reset"]');
  const newBtn = stage.querySelector('[data-action="galaxy-new"]');
  if (resetBtn) resetBtn.addEventListener('click', () => {
    if (ORION.openSystemId >= 0) closeSystem();
    ORION.map.focusGalaxy();
  });
  if (newBtn) newBtn.addEventListener('click', () => {
    newGame();
    renderGalaxyView(stage);
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

function row(k, v) { return '<dt>' + k + '</dt><dd>' + v + '</dd>'; }

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
      (gp.id === g.galaxy.homeGroupId ? '★ ' : '') + gp.name +
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
        row('Data Stellare', g.startDS) +
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

  title.textContent = grp.name;
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

  title.textContent = known ? sys.name : 'Sistema sconosciuto';

  if (!known) {
    content.innerHTML =
      '<div class="sysinfo">' +
        '<p class="sysinfo__fog">Posizione rilevata, dettagli ignoti.<br>' +
          'Richiede esplorazione (modulo M07).</p>' +
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
      '<p class="panel__note">Vista interna: stella/e, corpi celesti in orbita e anomalie (M03). Doppio click sul nodo per entrare.</p>' +
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
    onExit: () => {
      const cluster = g.galaxy.systems[id].cluster;
      closeSystem();
      if (ORION.map) ORION.map.focusGroup(cluster);
    }
  });

  setNavActive('system');
  setGalaxyHint('system');
  updateSystemUI(system, null);
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
  title.textContent = known ? system.name : 'Sistema sconosciuto';

  if (!known) {
    content.innerHTML =
      '<div class="sysinfo"><p class="sysinfo__fog">Posizione rilevata, interno ignoto.<br>' +
        'Richiede esplorazione (modulo M07).</p></div>';
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
      const moonNote = b.moons && b.moons.length ? '<span class="body-chip__moons">☾' + b.moons.length + '</span>' : '';
      return '<button class="sys-chip' + (b.key === selKey ? ' is-sel' : '') + '" data-body="' + b.key + '" type="button" title="' + def.label + '">' +
        '<span class="sys-chip__dot" style="--sc:' + bodyDotColor(b) + '"></span>' +
        '<span class="body-chip__name">' + b.name + '</span> · ' + def.label + (b.homeWorld ? ' ★' : '') + moonNote +
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
      '</strong> corpi celesti individuati. Dettagli, tipi e anomalie richiedono l\'esplorazione (modulo M07).</p>';
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
      '<p class="panel__note">Clicca un corpo per i dati base · doppio click per inquadrarlo. Colonizzazione e gestione: modulo M04.</p>' +
    '</div>';

  content.querySelectorAll('[data-body]').forEach((btn) => {
    btn.addEventListener('click', () => { if (ORION.systemView) ORION.systemView.selectBody(btn.dataset.body); });
  });
}

/* --- Pannello: livello Corpo celeste (dati base §6.3 + apri pianeta M04) --- */
function renderBodyPanel(title, content, system, body) {
  const def = ORION.system.BODY_TYPES[body.type];
  const catLabel = { rocky: 'Pianeta', gas: 'Gigante gassoso', moon: 'Luna', belt: 'Cintura asteroidale' }[def.cat] || '—';
  title.textContent = body.name;

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
  if (def.cat === 'belt') statusLine = '<p class="panel__note">Cintura asteroidale: solo estrazione orbitale (§6.3).</p>';
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
      '<p class="sysinfo__sub">Caratteristiche (§6.3)</p>' +
      '<dl class="sysinfo__list">' +
        row('Vantaggi', def.vantaggi) +
        row('Svantaggi', def.svantaggi) +
      '</dl>' +
      (def.cat !== 'belt'
        ? '<button class="btn btn--mini btn--enter" data-action="enter-planet" type="button">○ Apri pianeta ▸</button>' +
          '<p class="panel__note">Vista pianeta: sfera procedurale, risorse, strutture, popolazione (M04).</p>'
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

  pushChronicle(((g.startDS || 'DS —')) + ' — Apertura scheda planetaria di <strong>' + body.name + '</strong>.', 'planet');
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
function renderPlanetPanel(title, content) {
  const planet = ORION.currentPlanet;
  const colony = ORION.game.colonies[ORION.openPlanetKey];
  const def = ORION.system.BODY_TYPES[planet.type];
  title.textContent = planet.name;

  const tabs = ['colonia', 'risorse', 'strutture', 'popolazione'];
  if (!colony.colonized) ORION.planetTab = 'colonia';
  const activeTab = ORION.planetTab;

  const head =
    '<div class="planet-head">' +
      '<p class="planet-head__type">' + def.label + (colony.isHomeBase ? ' · <strong>Pianeta base</strong>' : (colony.colonized ? ' · Colonia' : '')) + '</p>' +
    '</div>' +
    '<nav class="planet-tabs" role="tablist">' +
      tabs.map(function (t) {
        const label = { colonia: 'Colonia', risorse: 'Risorse', strutture: 'Strutture', popolazione: 'Popolazione' }[t];
        const disabled = (!colony.colonized && t !== 'colonia');
        return '<button class="planet-tab' + (t === activeTab ? ' is-active' : '') + '" data-tab="' + t + '" type="button"' +
          (disabled ? ' disabled' : '') + '>' + label + '</button>';
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
}

/* --- Tab Colonia / Colonizzazione --- */
function renderPlanetColoniaTab(host, planet, colony) {
  const g = ORION.game;
  const def = ORION.system.BODY_TYPES[planet.type];

  if (colony.colonized) {
    const out = ORION.planet.structureOutput(colony, planet);
    host.innerHTML =
      '<div class="sysinfo">' +
        (colony.isHomeBase ? '<p class="sysinfo__home">★ Pianeta base — bonus +20% produzione (§8.1)</p>' : '<p class="sysinfo__home">◉ Colonia attiva</p>') +
        '<dl class="sysinfo__list">' +
          row('Colonizzato dal', colony.colonizedDS || '—') +
          row('Popolazione', colony.pop.total + ' / ' + colony.pop.cap) +
          row('Slot utilizzati', out.used + ' / ' + planet.slots) +
        '</dl>' +
        '<p class="sysinfo__sub">Riepilogo produzione</p>' +
        rateGrid(out.rates, out.upkeep) +
        '<p class="panel__note">L\'avanzamento della produzione richiede il game loop temporale (M05).</p>' +
      '</div>';
    return;
  }

  // non colonizzato: scheda di valutazione + bottone "Colonizza"
  const cost = planet.colCost;
  const hostility = planet.hostility;
  const reasons = [];
  if (!def.habitable) reasons.push('Corpo non abitabile — solo estrazione (§6.3).');
  const homeColonized = !!(g.colonies[g.homePlanetKey] && g.colonies[g.homePlanetKey].colonized);
  // §6.2: finché il primo pianeta è "produttivo" il costo è elevato. In M04
  // segnaliamo, l'aggiustamento numerico è da gestire in M05.
  const costMul = (homeColonized && !colony.isHomeBase) ? 5 : 1;

  const stockHome = homeColonized ? g.colonies[g.homePlanetKey].stock : { met: 0, en: 0, food: 0, water: 0 };
  const canPay =
    stockHome.met   >= cost.met   * costMul &&
    stockHome.en    >= cost.en    * costMul &&
    stockHome.water >= cost.water * costMul &&
    stockHome.food  >= cost.food  * costMul;

  host.innerHTML =
    '<div class="sysinfo">' +
      '<p class="panel__note">Tutti i corpi sono colonizzabili, ma con caratteristiche diverse (§6.2). La prima colonia condiziona tutto.</p>' +
      '<p class="sysinfo__sub">Potenziale risorse (§7.1)</p>' +
      potentialBars(planet) +
      '<p class="sysinfo__sub">Costo colonizzazione (§4.4 · §6.2)</p>' +
      '<dl class="sysinfo__list">' +
        row('Metalli',  Math.round(cost.met   * costMul)) +
        row('Energia',  Math.round(cost.en    * costMul)) +
        row('Acqua',    Math.round(cost.water * costMul)) +
        row('Cibo',     Math.round(cost.food  * costMul)) +
        row('Impulsi',  Math.round(cost.impulsi)) +
        row('Ostilità', hostility) +
      '</dl>' +
      (costMul > 1 ? '<p class="panel__note">×' + costMul + ' perché la colonia primaria è ancora produttiva (§6.2).</p>' : '') +
      (reasons.length ? '<p class="panel__note">' + reasons.join(' ') + '</p>' : '') +
      '<button class="btn btn--mini btn--enter" data-action="colonize" type="button"' +
        (canPay && def.habitable ? '' : ' disabled') + '>◉ Colonizza ▸</button>' +
      '<p class="panel__note">Colonizzare ulteriori corpi richiede tempo (90-150 Impulsi) — il timer di completamento gira in M05. In M04 la prima colonizzazione (pianeta natale) è istantanea, le altre vengono accodate.</p>' +
    '</div>';

  const btn = host.querySelector('[data-action="colonize"]');
  if (btn) btn.addEventListener('click', function () { tryColonize(planet); });
}

function tryColonize(planet) {
  const g = ORION.game;
  const colKey = planet.systemId + ':' + planet.bodyKey;
  const colony = g.colonies[colKey];
  if (!colony || colony.colonized) return;
  const homeColony = g.colonies[g.homePlanetKey];
  if (!homeColony || !homeColony.colonized) return;
  const cost = planet.colCost;
  const mul = (!colony.isHomeBase) ? 5 : 1;
  ['met', 'en', 'water', 'food'].forEach(function (k) {
    homeColony.stock[k] -= cost[k] * mul;
  });
  // In M04 segniamo la colonia come "in arrivo": completata istantaneamente
  // qui, ma il timer reale arriverà in M05. Per ora niente coda separata.
  colony.colonized = true;
  colony.colonizedDS = g.startDS;
  colony.pop.total = 1;
  colony.pop.classes.operai = 1;
  colony.stock = { met: 30, en: 20, food: 15, water: 15 };
  pushChronicle((g.startDS || 'DS —') + ' — Nuova colonia su <strong>' + planet.name + '</strong>.', 'planet');
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
      '<p class="sysinfo__sub">Potenziali del corpo (§7.1)</p>' +
      potentialBars(planet) +
      '<p class="sysinfo__sub">Scorte in colonia</p>' +
      '<dl class="sysinfo__list">' + stockRows + '</dl>' +
      '<p class="sysinfo__sub">Produzione potenziale per Impulso (M05)</p>' +
      rateGrid(out.rates, out.upkeep) +
      '<p class="sysinfo__sub">Risorse avanzate (§7.2)</p>' +
      advancedHtml +
    '</div>';
}

/* --- Tab Strutture --- */
function renderPlanetStruttureTab(host, planet, colony) {
  const S = ORION.structures;
  const used = Object.keys(colony.structures).reduce(function (a, id) {
    const d = S.get(id); return a + ((d && d.slots) || 1);
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
      html += '<li class="struct-item is-built">' +
        '<span class="struct-item__glyph">' + def.glyph + '</span>' +
        '<span class="struct-item__name">' + def.name + ' <span class="struct-item__lvl">lvl ' + (ent.level || 1) + '</span></span>' +
        '<span class="struct-item__cat">' + S.CATEGORIES[def.cat].label + '</span>' +
      '</li>';
    });
    html += '</ul>';
  }

  // in coda
  if (colony.queue.length) {
    html += '<p class="sysinfo__sub">In costruzione (timer M05)</p><ul class="struct-list">';
    colony.queue.forEach(function (q, idx) {
      const def = S.get(q.id);
      html += '<li class="struct-item is-queue">' +
        '<span class="struct-item__glyph">' + def.glyph + '</span>' +
        '<span class="struct-item__name">' + def.name + '</span>' +
        '<span class="struct-item__cat">' + q.duration + ' I</span>' +
        '<button class="btn btn--mini struct-item__cancel" data-cancel="' + idx + '" type="button" title="Annulla (rimborso 80%)">×</button>' +
      '</li>';
    });
    html += '</ul>';
  }

  // costruibili
  const available = S.buildableOn(planet.type);
  html += '<p class="sysinfo__sub">Costruibili</p>';
  const byCat = {};
  available.forEach(function (def) { (byCat[def.cat] = byCat[def.cat] || []).push(def); });
  Object.keys(S.CATEGORIES).forEach(function (cat) {
    const list = byCat[cat]; if (!list) return;
    html += '<details class="struct-cat" open><summary>' + S.CATEGORIES[cat].glyph + ' ' + S.CATEGORIES[cat].label + '</summary><ul class="struct-list">';
    list.forEach(function (def) {
      const check = ORION.planet.canBuild(colony, planet, def.id);
      const cost = def.cost || {};
      const costStr = Object.keys(cost).map(function (k) { return resGlyph(k) + cost[k]; }).join(' · ');
      html += '<li class="struct-item' + (check.ok ? '' : ' is-locked') + '" title="' + def.desc + '">' +
        '<span class="struct-item__glyph">' + def.glyph + '</span>' +
        '<div class="struct-item__main">' +
          '<div class="struct-item__name">' + def.name + ' <span class="struct-item__cat">' + def.time + ' I</span></div>' +
          '<div class="struct-item__cost">' + costStr + '</div>' +
        '</div>' +
        (check.ok
          ? '<button class="btn btn--mini" data-build="' + def.id + '" type="button">Costruisci</button>'
          : '<span class="struct-item__locked" title="' + check.reason + '">◌</span>') +
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
}

function tryBuild(id) {
  const g = ORION.game;
  const colony = g.colonies[ORION.openPlanetKey];
  const planet = ORION.currentPlanet;
  const r = ORION.planet.startBuild(colony, planet, id, g.startDS);
  if (!r.ok) { console.info('Costruzione rifiutata:', r.reason); return; }
  // In M04 senza game loop: completiamo immediatamente la struttura dopo
  // l'accodamento. Quando arriverà M05 sarà il loop a maturare il timer.
  const def = ORION.structures.get(id);
  colony.queue.pop();    // rimuove l'entry appena aggiunta
  colony.structures[id] = { level: 1, hp: 100 };
  // se costruisco l'osservatorio, la scansione si attiva → svela avanzate
  if (def.id === 'osservatorio') ORION.planet.applyScan(colony, planet);
  pushChronicle((g.startDS || 'DS —') + ' — <strong>' + def.name + '</strong> completata su ' + planet.name + '.', 'planet');
  updateGlobalResourceHud();
  updatePlanetUI();
}

function tryCancel(idx) {
  const colony = ORION.game.colonies[ORION.openPlanetKey];
  ORION.planet.cancelBuild(colony, idx);
  updateGlobalResourceHud();
  updatePlanetUI();
}

/* --- Tab Popolazione --- */
function renderPlanetPopolazioneTab(host, planet, colony) {
  const classes = colony.pop.classes;
  const total = colony.pop.total;
  const cap = colony.pop.cap;
  const order = ['operai', 'scienziati', 'militari', 'mercanti', 'tecnici'];
  const labels = { operai: 'Operai', scienziati: 'Scienziati', militari: 'Militari', mercanti: 'Mercanti', tecnici: 'Tecnici' };
  let bars = '<ul class="class-list">';
  order.forEach(function (k) {
    const v = classes[k] || 0;
    const pct = total > 0 ? Math.round(v * 100 / total) : 0;
    bars += '<li class="class-item"><span class="class-item__label">' + labels[k] + '</span>' +
      '<div class="class-item__bar"><div class="class-item__fill class--' + k + '" style="width:' + pct + '%"></div></div>' +
      '<span class="class-item__val">' + v + '</span></li>';
  });
  bars += '</ul>';

  host.innerHTML =
    '<div class="sysinfo">' +
      '<dl class="sysinfo__list">' +
        row('Popolazione', total + ' / ' + cap) +
        row('Crescita', '+ via M05') +
      '</dl>' +
      '<p class="sysinfo__sub">Classi funzionali (§9.2)</p>' +
      bars +
      '<p class="panel__note">La composizione si aggiusta lentamente in base alle strutture (§9.3). L\'aggiornamento richiede il game loop (M05).</p>' +
    '</div>';
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
  function fmt(v) { return (v >= 0 ? '+' : '') + (Math.round(v * 100) / 100); }
  const items = [];
  ['met', 'en', 'food', 'water'].forEach(function (k) {
    const r = rates[k] || 0; const u = upkeep[k] || 0; const net = r - u;
    if (r || u) items.push(row(resLabel(k), '<span class="rate ' + (net >= 0 ? 'rate--pos' : 'rate--neg') + '">' + fmt(net) + ' / I</span> <span class="rate-aux">(+' + fmt(r) + ' / −' + fmt(u) + ')</span>'));
  });
  if (rates.research) items.push(row('Ricerca', '<span class="rate rate--pos">+' + (Math.round(rates.research * 100) / 100) + ' / I</span>'));
  if (rates.scan) items.push(row('Scansione', '<span class="rate rate--pos">+' + rates.scan + ' / I</span>'));
  if (!items.length) return '<p class="panel__note">Nessuna produzione: costruisci strutture estrattive.</p>';
  return '<dl class="sysinfo__list">' + items.join('') + '</dl>';
}

function advancedResHtml(planet, colony) {
  if (!planet.advanced.length) return '<p class="panel__note">Nessuna risorsa avanzata rilevata su questo corpo.</p>';
  const known = colony.scanned.active;
  if (!known) {
    return '<p class="advanced-hint">⚛ <strong>' + planet.advanced.length + ' risorse avanzate</strong> presenti — identità da scansionare (costruisci un <em>osservatorio</em>, §7.3).</p>';
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

function resLabel(k) { return { met: 'Metalli', en: 'Energia', food: 'Cibo', water: 'Acqua' }[k] || k; }
function resGlyph(k) { return { met: '⛭', en: '⚡', food: '❖', water: '≈' }[k] || '·'; }

/* Colore del pallino di un corpo per le chip della sidebar. */
function bodyDotColor(b) {
  const pal = ORION.system.BODY_TYPES[b.type].palette;
  if (pal.bands) return ORION.system.GAS_VARIANTS[b.variant || 0].base;
  return pal.land || pal.rock || '#9aa6cc';
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
    el.textContent = 'Trascina · zoom rotella/pinch · click su un corpo per i dati · doppio click nel vuoto per uscire';
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

/* Log limitato agli ultimi N (decisione #5): unica fonte di crescita
   illimitata della cronaca, quindi capata. Più recente in cima. */
const MAX_CHRONICLE = 40;

function resetChronicle(galaxy, startDS) {
  ORION.lastChronicleId = -1;
  const log = document.querySelector('[data-bind="chronicle"]');
  if (!log) return;
  const home = galaxy.systems[galaxy.homeId];
  log.innerHTML =
    '<li class="chronicle__entry chronicle__entry--system">' +
      startDS + ' — Galassia generata: ' + galaxy.count + ' sistemi. ' +
      'Origine nel sistema <strong>' + home.name + '</strong>.' +
    '</li>';
}

function pushChronicle(html, modifier) {
  const log = document.querySelector('[data-bind="chronicle"]');
  if (!log) return;
  const li = document.createElement('li');
  li.className = 'chronicle__entry' + (modifier ? ' chronicle__entry--' + modifier : '');
  li.innerHTML = html;
  log.insertBefore(li, log.firstChild);
  while (log.children.length > MAX_CHRONICLE) log.removeChild(log.lastChild);
}

/* Annota in cronaca l'ingresso in un sistema, coerente con la nebbia di
   guerra §5.1. Il game loop temporale è M05: per ora usa la Data Stellare
   d'inizio. Evita doppioni consecutivi sullo stesso sistema. */
function chronicleSystemEntry(system, disc) {
  if (ORION.lastChronicleId === system.id) return;
  ORION.lastChronicleId = system.id;
  const DISCOVERY = ORION.galaxy.DISCOVERY;
  const ds = (ORION.game && ORION.game.startDS) ? ORION.game.startDS : 'DS —';
  const n = system.bodies.length;
  let text, mod;
  if (disc >= DISCOVERY.EXPLORED) {
    text = ds + ' — Ingresso nel sistema <strong>' + system.name + '</strong> · ' +
      system.stars.label + ' · ' + n + ' corpi celesti.';
    mod = 'explore';
  } else if (disc >= DISCOVERY.DETECTED) {
    text = ds + ' — Avvicinamento a <strong>' + system.name + '</strong> · sensori a lungo raggio: ' +
      n + ' corpi rilevati, interno da scansionare.';
    mod = 'system';
  } else {
    text = ds + ' — Rotta verso un sistema ignoto · richiede esplorazione (M07).';
    mod = 'system';
  }
  pushChronicle(text, mod);
}

/* ---------------------------------------------------------------------
   Avvio
   --------------------------------------------------------------------- */
function boot() {
  // Se in localStorage c'è un seed di una partita precedente, lo riusiamo
  // (preview M06: l'F5 mantiene la stessa galassia). "Nuova" rigenera.
  newGame(loadSavedSeed());
  initNavigation();
  console.info('%cOrion Empires ' + ORION.version + ' — galassia pronta (seed ' + ORION.game.seed + ').', 'color:#2fe6e0');
}

document.addEventListener('DOMContentLoaded', boot);
