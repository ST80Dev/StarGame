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

ORION.version = '0.2.0-M02';

/* Etichette provvisorie del viewport per le viste non ancora implementate. */
ORION.viewLabels = {
  system:    { caption: 'VISTA SISTEMA',    hint: 'La vista del sistema stellare arriverà nel modulo M03.' },
  planet:    { caption: 'VISTA PIANETA',    hint: 'La gestione del pianeta arriverà nel modulo M04.' },
  fleet:     { caption: 'VISTA FLOTTA',     hint: 'La gestione della flotta arriverà nel modulo M08.' },
  research:  { caption: 'VISTA RICERCA',    hint: "L'albero tecnologico arriverà nel modulo M13." },
  diplomacy: { caption: 'VISTA DIPLOMAZIA', hint: 'La diplomazia arriverà nel modulo M11.' }
};

/* Stato di partita corrente (in memoria). Il salvataggio è M06. */
ORION.game = null;
ORION.map = null;

/* ---------------------------------------------------------------------
   Generazione/avvio di una partita (galassia)
   --------------------------------------------------------------------- */
function newGame(seed) {
  seed = seed || ORION.rng.newSeed();
  const galaxy = ORION.galaxy.generate(seed);
  const state = ORION.galaxy.createState(galaxy);

  // Epoca d'inizio randomizzata DS 800.00–3000.00 (decisione #4), derivata
  // dal seed così da restare deterministica (parte del seed+delta).
  const erng = ORION.rng.makeRng(seed + ':epoch');
  const startOrbita = erng.int(800, 3000);
  const startDS = 'DS ' + startOrbita + '.00';

  ORION.game = { galaxy: galaxy, state: state, seed: seed, startDS: startDS };

  setHudDate(startDS);
  resetChronicle(galaxy, startDS);
  return ORION.game;
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
  // smonta la mappa se attiva
  if (ORION.map) { ORION.map.destroy(); ORION.map = null; }

  if (view === 'galaxy') {
    renderGalaxyView(stage);
  } else {
    renderViewPlaceholder(stage, view);
  }
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
  if (ORION.map) { ORION.map.destroy(); ORION.map = null; }
  if (!ORION.game) newGame();
  const g = ORION.game;

  stage.innerHTML =
    '<div class="galaxy-root">' +
      '<div class="galaxy-holder"></div>' +
      '<div class="galaxy-overlay">' +
        '<div class="galaxy-overlay__row">' +
          '<span class="galaxy-overlay__label">SEED</span>' +
          '<code class="galaxy-overlay__seed" data-bind="seed">' + g.seed + '</code>' +
        '</div>' +
        '<div class="galaxy-overlay__row">' +
          '<span class="galaxy-overlay__meta">' + g.galaxy.count + ' sistemi</span>' +
        '</div>' +
        '<div class="galaxy-overlay__actions">' +
          '<button class="btn btn--mini" data-action="galaxy-reset" type="button" title="Reinquadra (doppio click)">⤢ Inquadra</button>' +
          '<button class="btn btn--mini" data-action="galaxy-new" type="button" title="Genera una nuova galassia">✦ Nuova</button>' +
        '</div>' +
      '</div>' +
      '<div class="galaxy-hint">Trascina per spostare · rotella/pinch per zoom · click su un sistema</div>' +
    '</div>';

  const holder = stage.querySelector('.galaxy-holder');
  ORION.map = new ORION.GalaxyMap().mount(holder, g.galaxy, g.state, {
    onSelect: onSystemSelected
  });

  // mostra subito i dettagli del sistema selezionato (pianeta base)
  onSystemSelected(g.state.selectedId);

  // comandi overlay
  const resetBtn = stage.querySelector('[data-action="galaxy-reset"]');
  const newBtn = stage.querySelector('[data-action="galaxy-new"]');
  if (resetBtn) resetBtn.addEventListener('click', () => ORION.map.resetView());
  if (newBtn) newBtn.addEventListener('click', () => {
    newGame();
    renderGalaxyView(stage);
  });
}

/* ---------------------------------------------------------------------
   Pannello destro: dettagli del sistema selezionato
   --------------------------------------------------------------------- */
function onSystemSelected(id) {
  const g = ORION.game;
  if (!g) return;
  const sys = g.galaxy.systems[id];
  const disc = g.state.discovery[id];
  const DISCOVERY = ORION.galaxy.DISCOVERY;

  const panel = document.querySelector('.panel--right');
  if (!panel) return;
  const title = panel.querySelector('.panel__title');
  const content = panel.querySelector('.panel__content');
  if (!title || !content) return;

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
      '<p class="panel__note">Il contenuto del sistema (corpi celesti, anomalie) arriverà nel modulo M03.</p>' +
    '</div>';

  function row(k, v) {
    return '<dt>' + k + '</dt><dd>' + v + '</dd>';
  }
}

/* ---------------------------------------------------------------------
   HUD / Cronaca
   --------------------------------------------------------------------- */
function setHudDate(ds) {
  const el = document.querySelector('[data-bind="data-stellare"]');
  if (el) el.textContent = ds;
}

function resetChronicle(galaxy, startDS) {
  const log = document.querySelector('[data-bind="chronicle"]');
  if (!log) return;
  const home = galaxy.systems[galaxy.homeId];
  log.innerHTML =
    '<li class="chronicle__entry chronicle__entry--system">' +
      startDS + ' — Galassia generata: ' + galaxy.count + ' sistemi. ' +
      'Origine nel sistema <strong>' + home.name + '</strong>.' +
    '</li>';
}

/* ---------------------------------------------------------------------
   Avvio
   --------------------------------------------------------------------- */
function boot() {
  newGame();          // genera la prima galassia
  initNavigation();   // monta la vista galassia
  console.info('%cOrion Empires ' + ORION.version + ' — galassia pronta (seed ' + ORION.game.seed + ').', 'color:#2fe6e0');
}

document.addEventListener('DOMContentLoaded', boot);
