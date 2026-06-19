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
  research:  { caption: 'VISTA RICERCA',    hint: 'Pool d’impero + albero tecnologico (M13).' },
  diplomacy: { caption: 'VISTA DIPLOMAZIA', hint: 'La diplomazia arriverà più avanti nello sviluppo.' },
  crews:     { caption: 'ROSTER EQUIPAGGI', hint: 'Riepilogo equipaggi e figure d\'impero.' }
};

/* Stato sidebar/centrale del Roster Equipaggi (richiesta utente 2026-06-16).
   Volatile in memoria + persistito in localStorage (UI_GUIDE §9: mai nel
   save di partita). Valori inizializzati anche se loadUiPrefs non scatta. */
ORION.crewSidebarSort = 'xp';     /* 'xp' | 'system' | 'status' */
ORION.crewCentralPrefs = {
  tab: 'crews',                   /* 'crews' | 'figures' */
  sort: 'xp',
  filterSys: 'all',
  filterStatus: 'all',
  filterXp: 'all',
  filterDom: 'all'
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
   Accordion: una sola sezione aperta per volta (default: Roster).
   NB: superato dalle linguette a icone (ORION.lpTab) — tenuto solo per
   retro-compat delle prefs vecchie e di lpAccordionOpen/normalize. */
ORION.lpSectionCollapsed = { roster: false, nav: true, launcher: true, council: true };

/* Linguetta attiva della Plancia d'Impero (stesso meccanismo della dx).
   'roster' | 'nav' | 'launcher' | 'council' | 'chronicle'. Persistita in
   uiprefs (è una scelta d'interfaccia, non stato di gioco). */
ORION.lpTab = 'roster';

/* Filtro cronaca (feedback utente 2026-06-15): la cronaca era affollata
   da eventi di routine (build/varo/lancio/mercantili/governatore/insediamento
   ecc.). 'important' = default, silenzia il rumore e mantiene solo eventi
   strategici (combattimento, diplomazia, civ, dispacci, figure, crisi,
   capitali, milestone). 'all' = comportamento storico. Persistita in
   uiprefs (UI_GUIDE §9 — non stato di gioco). Le voci silenziate NON
   entrano in game.chronicle: cambiare filtro a metà partita scarta il
   pregresso filtrato (mostra solo quanto già accumulato). */
ORION.chronicleFilter = 'important';

/* Set dei kind "rumore": eventi di routine/atmosferici che NON valgono
   un'interruzione della cronaca. Tutto ciò che NON è qui è considerato
   importante (default-deny lato rumore = comportamento conservativo:
   se un kind nuovo nasce e non è classificato, finisce in "important"
   per sicurezza, e si valuta in revisione). Allineato alla logica dei
   DEFAULT_AUTOPAUSE OFF (decisione #31) ma con classificazione separata. */
const CHRONICLE_NOISE_KINDS = new Set([
  /* Costruzione/produzione routine. */
  'build-done', 'ship-built', 'crew-formed', 'mercantile-built', 'mercantile-promoted',
  /* Smantellamento/downgrade: avviato dal giocatore, log della colonia
     basta — non serve cronaca (feedback utente 2026-06-17). */
  'demolish-done', 'downgrade-done',
  /* Insediamento (4 voci per ogni nuova colonia → rumore). */
  'settle-stage',
  /* Coda governatore Tier 2 (azioni automatiche, log nel pannello dedicato). */
  'gov-build-started', 'gov-expand-started', 'gov-asset-started',
  /* Segnalazioni Tier 1 (le opportunità e i preventivi sono UI, non eventi). */
  'gov-queue-empty', 'gov-slots-idle', 'gov-pop-near-cap', 'gov-supply-falling', 'gov-veterans-idle',
  /* Capitale: il varo è importante, il subentro graduale no. */
  'capital-decommissioned', 'capital-transition-end',
  /* Figure: l'emersione è importante, il rank-up no. */
  'commander-ranked', 'colony-figure-ranked',
  /* Consiglio: solo i consigli (non proposte/atti) sono atmosferici. */
  'council-advice',
  /* Flotte: hop e waypoint sono rumore; arrivo a destinazione resta importante. */
  'fleet-launched', 'fleet-leg-hop', 'fleet-route-complete', 'fleet-waypoint-reached',
  'fleet-discovery',
  /* Colonizzazione: orbit/foundation sono fasi intermedie; colony-done resta. */
  'fleet-colonize-orbit', 'fleet-colonize-foundation',
  /* Spedizioni: lancio è azione utente, dock-overflow è informativo. */
  'expedition-launch', 'expedition-dock-overflow',
  /* Commercio routine: la rotta interrotta/ripresa non è strategica
     (vive nella tab Rotte). */
  'trade-route-interrupted', 'trade-route-resumed', 'trade-route-closed',
  'trade-raid', 'trade-mercantile-lost',
  'agreement-suspended', 'agreement-resumed', 'agreement-ended',
  'waste-deal-closed',
  /* Coesione/federazioni: stato derivato, atmosferico. */
  'cohesion-attack-backlash', 'system-cohesion-formed', 'system-cohesion-broken',
  /* Assedio round-per-round: l'inizio e la fine sono importanti; i round in mezzo no. */
  'siege-round',
  /* Rifornimento flotta: il drop a low/critical è importante, il top-up no. */
  'fleet-resupplied',
  /* Recovery di scarsità/rifiuti: la crisi è importante, il rientro no. */
  'scarcity-recover', 'waste-recover',
  /* Diplomazia automatica: scadenza tregua silenziosa, expirations dispacci. */
  'diplo-truce-expired', 'dispatch-expired', 'dispatch-void', 'diplo-offer-expired',
  /* Anomalie esaurite: l'evento "trovata" è importante, l'esaurimento no. */
  'anomaly-depleted',
  /* Stazione upgrade è informativo (la costruzione e gli attacchi restano). */
  'station-upgraded', 'station-resupplied',
  /* Scafo leggero/medio assemblato alla stazione: routine come 'ship-built'. */
  'station-ship-built',
  /* Raider che svanisce senza colpire: atmosferico. */
  'raider-fizzle'
]);

/* Helper: l'evento è rumore? Letto da chronicleEvent prima di pushChronicle. */
function isChronicleNoise(ev) {
  return ev && ev.kind && CHRONICLE_NOISE_KINDS.has(ev.kind);
}

/* Eventi "silenziosi": vengono mostrati nel log della cronaca ma NON
   attivano l'aura pulsante sulla linguetta. Pensati per azioni avviate
   dal giocatore (avvii costruzione, smantellamenti, downgrade, formazione
   equipaggio, assemblaggio flotte): il click stesso è il feedback —
   un'aura aggiuntiva è solo rumore visivo (feedback utente 2026-06-17). */
const CHRONICLE_SILENT_KINDS = new Set([
  /* Vuoto al momento: i completamenti routine sono stati promossi a
     CHRONICLE_NOISE_KINDS (zero entry). Lasciato il meccanismo per
     futuri kind che vogliamo "presenti ma senza pulsazione". */
]);
function isChronicleSilent(ev) {
  return ev && ev.kind && CHRONICLE_SILENT_KINDS.has(ev.kind);
}

/* Cronaca a due sezioni (sostituisce filtro Importanti/Tutto):
   - 'galaxy': contatti civiltà, diplomazia, AI lontane (voci), pirati,
     stazioni, flotte in viaggio/scoperte, occupazioni, scoperte/scansioni.
   - 'colony': eventi interni dell'impero — carestie, rientri carestia,
     waste, perdita popolazione, milestone capitali, colonie, ricerca,
     vittorie, consiglio. */
function chronicleCategoryFromKind(kind) {
  if (!kind) return 'colony';
  if (kind.indexOf('civ-') === 0) return 'galaxy';
  if (kind.indexOf('diplo-') === 0) return 'galaxy';
  if (kind.indexOf('pirate-') === 0) return 'galaxy';
  if (kind.indexOf('fleet-') === 0) return 'galaxy';
  if (kind.indexOf('station-') === 0) return 'galaxy';
  if (kind.indexOf('siege-') === 0) return 'galaxy';
  if (kind.indexOf('expedition-') === 0) return 'galaxy';
  if (kind.indexOf('trade-') === 0) return 'galaxy';
  if (kind.indexOf('agreement-') === 0) return 'galaxy';
  if (kind.indexOf('raider-') === 0) return 'galaxy';
  if (kind.indexOf('cohesion-') === 0) return 'galaxy';
  if (kind.indexOf('dispatch-') === 0) return 'galaxy';
  if (kind === 'system-occupied' || kind === 'system-released' ||
      kind === 'system-cohesion-formed' || kind === 'system-cohesion-broken' ||
      kind === 'scan-done' || kind === 'anomaly-depleted' ||
      kind === 'commander-ranked' || kind === 'waste-deal-closed') return 'galaxy';
  return 'colony';
}
/* Fallback per entry storiche senza `cat` (save pre-bump): deriva dalla
   classe semantica `mod` (UI_GUIDE §7 — stessi colori usati nel rendering). */
function chronicleCategoryFromMod(mod) {
  if (mod === 'civ' || mod === 'fleet' || mod === 'explore') return 'galaxy';
  return 'colony';
}
/* Stato non-letto per linguetta (aura pulsante quando arriva un evento
   importante in una sezione non attiva). Vive in localStorage via uiprefs. */
ORION.chronicleUnread = { galaxy: false, colony: false };
ORION.chronicleSection = 'galaxy';

/* Misteriosità voci AI lontane (decisione #34, R2):
   - rank 0 (sconosciuta): nome e regione velati ("una potenza ignota",
     "regioni non cartografate");
   - rank 1 (avvistata): nome reale, regione attenuata ("regioni remote");
   - rank ≥ 2 (contatto): testo pieno.
   Si applica a civ-expand, civ-emerged, civ-war, civ-fallen — eventi che
   possono parlare di civiltà mai incontrate direttamente. */
function chronicleCivKnowRank(civName) {
  if (!civName || !ORION.game || !Array.isArray(ORION.game.civs)) return 0;
  const c = ORION.game.civs.find(function (x) { return x.name === civName; });
  if (!c) return 0;
  return (ORION.ai && ORION.ai.knowledgeRank) ? ORION.ai.knowledgeRank(c) : 3;
}
function chronicleMysteryCiv(civName, regionLabel) {
  const rank = chronicleCivKnowRank(civName);
  if (rank >= 2) return { name: escapeHtml(civName || '—'), region: escapeHtml(regionLabel || '—'), mystery: false };
  if (rank >= 1) return { name: escapeHtml(civName || '—'), region: 'regioni remote', mystery: true };
  return { name: 'una potenza ignota', region: 'regioni non cartografate', mystery: true };
}

/* Sezioni dell'accordion Plancia d'Impero (la cronaca è gestita a parte).
   Tenuta come unica fonte così aggiungere una sezione non rompe il toggle
   (bug #78: 'council' mancava qui → non si riapriva più). */
const LP_ACCORDION_SECTIONS = ['roster', 'nav', 'launcher', 'council'];

/* Accordion Plancia d'Impero: apre SOLO `openId`, collassa le altre
   (chronicle inclusa). `openId === null` → tutte chiuse. */
function lpAccordionOpen(openId) {
  LP_ACCORDION_SECTIONS.forEach(function (k) {
    ORION.lpSectionCollapsed[k] = (k !== openId);
  });
  ORION.chronicleCollapsed = (openId !== 'chronicle');
}
/* Normalizza a una sola sezione aperta (per save vecchi con più aperte). */
function normalizeLpAccordion() {
  let openId = LP_ACCORDION_SECTIONS.find(function (k) { return !ORION.lpSectionCollapsed[k]; }) || null;
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
    if (typeof d.lpTab === 'string') ORION.lpTab = d.lpTab;
    /* Filtro cronaca: 'important' (default) silenzia il rumore di routine
       — solo eventi strategici/notevoli. 'all' mostra tutto come storico.
       Compat back: la cronaca ora è a due sezioni (Galassia/Colonie),
       ma manteniamo il caricamento del campo per non perdere prefs vecchie. */
    if (d.chronicleFilter === 'all' || d.chronicleFilter === 'important') {
      ORION.chronicleFilter = d.chronicleFilter;
    }
    if (d.chronicleSection === 'galaxy' || d.chronicleSection === 'colony') {
      ORION.chronicleSection = d.chronicleSection;
    }
    if (d.chronicleUnread && typeof d.chronicleUnread === 'object') {
      ORION.chronicleUnread = {
        galaxy: !!d.chronicleUnread.galaxy,
        colony: !!d.chronicleUnread.colony
      };
    }
    if (d.crewSidebarSort === 'xp' || d.crewSidebarSort === 'system' || d.crewSidebarSort === 'status') {
      ORION.crewSidebarSort = d.crewSidebarSort;
    }
    if (d.crewCentralPrefs && typeof d.crewCentralPrefs === 'object') {
      Object.assign(ORION.crewCentralPrefs, d.crewCentralPrefs);
    }
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
      empireDeckOpen: ORION.empireDeckOpen,
      lpTab: ORION.lpTab,
      chronicleFilter: ORION.chronicleFilter,
      chronicleSection: ORION.chronicleSection,
      chronicleUnread: ORION.chronicleUnread,
      crewSidebarSort: ORION.crewSidebarSort,
      crewCentralPrefs: ORION.crewCentralPrefs
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
    /* M11 Fase B parziale: sistemi occupati dopo vittoria su civiltà AI.
       Lazy, additivo; nessun bump di schema. */
    occupations: {},
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
  ORION.game.startDS = ORION.time.format(startOrbita * 100);

  // M04/M06.5: colonizza il pianeta natale (scelta esplicita se passata
  // dal menu, altrimenti homeWorld flaggato da system.js).
  colonizeHomePlanet(ORION.game, ORION.game.startDS);
  /* Decisione #45: auto-promuove la home come capitale del proprio gruppo
     (idempotente: non sovrascrive una capitale già designata). */
  if (ORION.capital && ORION.capital.initFromHome) {
    ORION.capital.initFromHome(ORION.game);
  }
  /* M14 Fase B2 (decisione #78): genera il Consiglio della Civiltà dal seed. */
  if (ORION.council && ORION.council.ensure) ORION.council.ensure(ORION.game);
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
    /* Counter ID persistiti (equipaggi, ...). Riconciliati comunque al load
       da migrateLegacyCrewIds per i save vecchi privi del campo. */
    if (saved.idSeq && typeof saved.idSeq === 'object') ORION.game.idSeq = Object.assign({}, saved.idSeq);
    ORION.game.colonies = saved.colonies || ORION.game.colonies;
    ORION.game.homePlanetKey = saved.homePlanetKey || ORION.game.homePlanetKey;
    if (saved.mode) ORION.game.mode = saved.mode;
    if (saved.victoryTracks) ORION.game.victoryTracks = saved.victoryTracks;
    if (typeof saved.victoryFocus === 'string') ORION.game.victoryFocus = saved.victoryFocus;
    if (saved.eventSchedule) ORION.game.eventSchedule = saved.eventSchedule;
    if (Array.isArray(saved.expeditions)) ORION.game.expeditions = saved.expeditions.slice();
    if (Array.isArray(saved.fleets)) ORION.game.fleets = saved.fleets.slice();
    /* M16 (decisione #81): stazioni spaziali (entità top-level). */
    if (Array.isArray(saved.stations)) ORION.game.stations = saved.stations.slice();
    if (Array.isArray(saved.commanders)) ORION.game.commanders = saved.commanders.slice();
    /* M14 Fase A (#75): converte le figure legacy (specialization → role) e
       riallinea i rank labels. Idempotente — no-op se già in formato #75. */
    if (ORION.commander && ORION.commander.migrateAll) ORION.commander.migrateAll(ORION.game);
    /* M14 Fase B1 (#77): figure di colonia (pool idle; le assegnate vivono
       su colony.figure). Save pre-25 → pool vuoto. */
    if (Array.isArray(saved.colonyFigures)) ORION.game.colonyFigures = saved.colonyFigures.slice();
    if (ORION.colonyFigure && ORION.colonyFigure.ensure) ORION.colonyFigure.ensure(ORION.game);
    /* M14 Fase B2 (#78): Consiglio della Civiltà. Save pre-26 → ensure lo
       genera dal seed; altrimenti ripristina lo stato salvato. */
    if (saved.council && typeof saved.council === 'object') ORION.game.council = saved.council;
    /* M14 Fase B3 (#79): pool Luminari. */
    if (Array.isArray(saved.luminari)) ORION.game.luminari = saved.luminari.slice();
    if (ORION.council && ORION.council.ensure) ORION.council.ensure(ORION.game);
    /* M13 Fase A (decisione #57): ricerca tecnologica. Save pre-23 → null;
       ORION.research.ensure() sotto completa lo stato vuoto. */
    if (saved.research && typeof saved.research === 'object') {
      ORION.game.research = {
        catalogVersion: saved.research.catalogVersion || 1,
        unlocked: Array.isArray(saved.research.unlocked) ? saved.research.unlocked.slice() : [],
        activeProject: saved.research.activeProject || null,
        progress: saved.research.progress || 0,
        activationPaid: saved.research.activationPaid || null
      };
    }
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
    /* M18.x (richiesta utente 2026-06-18): flotte ambientali AI in volo. */
    if (Array.isArray(saved.aiFleets)) ORION.game.aiFleets = saved.aiFleets.slice();
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
    if (Array.isArray(saved.wasteDeals)) ORION.game.wasteDeals = saved.wasteDeals.slice();
    /* M17 Fase A (decisione #83): Dispacci & Missioni + Memoria Storica. */
    if (Array.isArray(saved.missions)) ORION.game.missions = saved.missions.slice();
    if (Array.isArray(saved.memoria)) ORION.game.memoria = saved.memoria.slice();
    if (saved.dispatchMeta && typeof saved.dispatchMeta === 'object') {
      ORION.game.dispatchMeta = Object.assign({ lastOfferAt: -1, offers: 0, completed: 0 }, saved.dispatchMeta);
    }
    if (Array.isArray(saved.contracts)) ORION.game.contracts = saved.contracts.slice();
    if (Array.isArray(saved.crises)) ORION.game.crises = saved.crises.slice();
    if (saved.crisisMeta && typeof saved.crisisMeta === 'object') ORION.game.crisisMeta = Object.assign({ icgTier: 0 }, saved.crisisMeta);
    if (saved.anomalies && typeof saved.anomalies === 'object') ORION.game.anomalies = Object.assign({}, saved.anomalies);
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
  /* M13 Fase A (decisione #57): inizializza lo stato ricerca se assente
     (partita nuova o save pre-schema-23). Idempotente. */
  if (ORION.research && ORION.research.ensure) {
    ORION.research.ensure(ORION.game);
  }
  /* M17 Fase A (decisione #83): inizializza Dispacci/Missioni/Memoria se
     assenti (partita nuova o save pre-schema-30) e ricostruisce il seen-set
     della Memoria. Idempotente. */
  if (ORION.dispatch && ORION.dispatch.ensure) {
    ORION.dispatch.ensure(ORION.game);
  }
  if (ORION.anomaly && ORION.anomaly.ensure) {
    ORION.anomaly.ensure(ORION.game);
    /* Pre-scan dei sistemi-colonia (incluso il sistema natale): registra in
       game.anomalies i siti §17.3 deterministicamente, così la tab
       Esplorazione mostra subito le anomalie intra-sistema senza attendere
       che una flotta orbiti nel proprio sistema. Diagnostica utente
       2026-06-16: "non vedo le anomalie del mio stesso sistema". */
    if (ORION.anomaly.ensureSites) {
      const seen = {};
      Object.keys(ORION.game.colonies || {}).forEach(function (k) {
        const c = ORION.game.colonies[k];
        if (!c || c.systemId == null) return;
        if (seen[c.systemId]) return;
        seen[c.systemId] = true;
        ORION.anomaly.ensureSites(ORION.game, c.systemId);
      });
    }
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
  updateGlobalResourceHud();
}

/* Aggrega lo stock di tutte le colonie nell'HUD risorse-base. La vera
   produzione/aggiornamento per Impulso arriverà con M05. */
function updateGlobalResourceHud() {
  const totals = { met: 0, en: 0, food: 0, water: 0 };
  let totalUnits = 0;
  let totalCap = 0;
  let colonyCount = 0;
  if (ORION.game && ORION.game.colonies) {
    Object.keys(ORION.game.colonies).forEach(function (k) {
      const c = ORION.game.colonies[k];
      if (!c.colonized) return;
      totals.met += c.stock.met || 0;
      totals.en  += c.stock.en  || 0;
      totals.food += c.stock.food || 0;
      totals.water += c.stock.water || 0;
      // Popolazione: somma LIVELLI d'impero (refactor 2026-06-09).
      const units = (c.pop && c.pop.total) || 0;
      const cap = (c.pop && c.pop.cap) || 0;
      totalUnits += units;
      totalCap += cap;
      colonyCount++;
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
  if (popEl) {
    /* HUD aggregato: somma livelli / cap d'impero. Refactor 2026-06-09.
       Feedback utente 2026-06-15: il display era poco esplicito come
       "aggregato". Ora la riga mostra "X / Y · N col." se ≥2 colonie,
       per chiarire visivamente che è la somma d'impero (non la sola
       capitale). Con 1 colonia il contatore è omesso (ridondante). */
    const colonyTag = colonyCount >= 2
      ? '<span class="pop-colony-count" title="' + colonyCount + ' colonie operative"> · ' + colonyCount + ' col.</span>'
      : '';
    popEl.innerHTML = popAnimSpan('hud:pop', totalUnits) +
      '<span class="pop-ceiling"> / ' + totalCap + '</span>' +
      colonyTag;
    ensurePopAnim();
  }
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

  /* Viste NON-mappa (fleet / civ / market / placeholder): la action bar
     contestuale è agganciata al viewport (sibling dello stage), non si
     resetta da sola cambiando vista. La nascondiamo esplicitamente qui
     così non rimane "incollata" con un corpo selezionato da una sessione
     sistema precedente. Le viste mappa (galaxy/group/system/planet)
     ri-popolano la bar via onMapContext / updateSystemUI / updatePlanetUI. */
  renderContextActionBar(null);

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

  // M16 (decisione #81): vista "Stazioni" — avamposti logistico-militari.
  // Costruzione remota da colonia, lista stazioni con livello/serbatoio/
  // difesa/stato rifornimento, upgrade/smantella. Read+azione, no Canvas.
  if (view === 'stations') {
    if (ORION.planetView) { ORION.planetView.destroy(); ORION.planetView = null; ORION.openPlanetKey = null; ORION.currentPlanet = null; } if (ORION.planetOverlay) { ORION.planetOverlay.destroy(); ORION.planetOverlay = null; }
    if (ORION.colonyDeck) { ORION.colonyDeck.destroy(); ORION.colonyDeck = null; }
    if (ORION.systemView) { ORION.systemView.destroy(); ORION.systemView = null; ORION.openSystemId = -1; ORION.currentSystem = null; }
    if (ORION.map) { ORION.map.destroy(); ORION.map = null; }
    renderStationsView(stage);
    return;
  }

  // M13 Fase A (decisione #57): vista "Ricerca" — pool d'impero + albero
  // tecnologico (i 5 punti fermi). Read+azione (scegli progetto), no Canvas.
  if (view === 'research') {
    if (ORION.planetView) { ORION.planetView.destroy(); ORION.planetView = null; ORION.openPlanetKey = null; ORION.currentPlanet = null; } if (ORION.planetOverlay) { ORION.planetOverlay.destroy(); ORION.planetOverlay = null; }
    if (ORION.colonyDeck) { ORION.colonyDeck.destroy(); ORION.colonyDeck = null; }
    if (ORION.systemView) { ORION.systemView.destroy(); ORION.systemView = null; ORION.openSystemId = -1; ORION.currentSystem = null; }
    if (ORION.map) { ORION.map.destroy(); ORION.map = null; }
    renderResearchView(stage);
    return;
  }

  // Riepilogo equipaggi impero (richiesta utente 2026-06-16): vista
  // espansa con filtri/ordinamenti + tab Figure. Lo snapshot vive in
  // ORION.crewRoster (modulo dedicato).
  if (view === 'crews') {
    if (ORION.planetView) { ORION.planetView.destroy(); ORION.planetView = null; ORION.openPlanetKey = null; ORION.currentPlanet = null; } if (ORION.planetOverlay) { ORION.planetOverlay.destroy(); ORION.planetOverlay = null; }
    if (ORION.colonyDeck) { ORION.colonyDeck.destroy(); ORION.colonyDeck = null; }
    if (ORION.systemView) { ORION.systemView.destroy(); ORION.systemView = null; ORION.openSystemId = -1; ORION.currentSystem = null; }
    if (ORION.map) { ORION.map.destroy(); ORION.map = null; }
    if (ORION.crewRoster && ORION.crewRoster.renderCentral) ORION.crewRoster.renderCentral(stage);
    return;
  }

  // M17 Fase A (decisione #83): vista "Dispacci" — incarichi disponibili
  // (offerte non bloccanti), incarichi in corso + Memoria Storica §17.2.
  if (view === 'dispatch') {
    if (ORION.planetView) { ORION.planetView.destroy(); ORION.planetView = null; ORION.openPlanetKey = null; ORION.currentPlanet = null; } if (ORION.planetOverlay) { ORION.planetOverlay.destroy(); ORION.planetOverlay = null; }
    if (ORION.colonyDeck) { ORION.colonyDeck.destroy(); ORION.colonyDeck = null; }
    if (ORION.systemView) { ORION.systemView.destroy(); ORION.systemView = null; ORION.openSystemId = -1; ORION.currentSystem = null; }
    if (ORION.map) { ORION.map.destroy(); ORION.map = null; }
    renderDispatchView(stage);
    return;
  }

  // Dashboard "Destino" (decisione #23 esteso): visuale riepilogativa delle
  // 7 piste di vittoria con soglie provvisorie + focus narrativo opzionale.
  if (view === 'destiny') {
    if (ORION.planetView) { ORION.planetView.destroy(); ORION.planetView = null; ORION.openPlanetKey = null; ORION.currentPlanet = null; } if (ORION.planetOverlay) { ORION.planetOverlay.destroy(); ORION.planetOverlay = null; }
    if (ORION.colonyDeck) { ORION.colonyDeck.destroy(); ORION.colonyDeck = null; }
    if (ORION.systemView) { ORION.systemView.destroy(); ORION.systemView = null; ORION.openSystemId = -1; ORION.currentSystem = null; }
    if (ORION.map) { ORION.map.destroy(); ORION.map = null; }
    renderDestinyView(stage);
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
    onDiveIn: (id) => openSystem(id),          // decisione #80: scroll-in → sistema centrato
    // M08 polish (decisione #61): drag&drop dal canvas per ordinare flotte.
    // Polish post-wizard: il click sul marker NON entra più direttamente
    // in picker mode — apre un popup info con dettagli del viaggio; il
    // popup ha bottoni per impostare rotta / aprire wizard. Stesso UX
    // del feedback utente "se ci clicco mi deve dare le info precise".
    onFleetPicked: (fleetId, sx, sy) => openFleetInfoPopup(fleetId, sx, sy),
    onFleetOrderRequest: (req) => applyFleetOrderFromMap(req),
    onFleetPickerCancel: () => exitFleetPicker(true),
    onAiFleetPicked: (aiFleetId, sx, sy) => openAiFleetPopup(aiFleetId, sx, sy)   // M18.x
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

/* Popolazione (§9) — display LIVELLI ONLY (refactor sessione 2026-06-09,
   estensione decisione #66). Su feedback utente: la rappresentazione "persone"
   con curva geometrica creava asimmetrie strane nei trasferimenti (togliere
   2 unità da un mondo a 10 unità = "milioni che spariscono" sul display
   mentre il target ne riceve solo qualche centinaio). Soluzione: abbandono
   completo del display "persone", uso solo i livelli (unità del motore) come
   fonte di verità visiva. La curva persone↔livelli resta INTERNAMENTE in
   planet.js (peopleAt/popCeiling/formatPeople) per backward compat con UI
   future o save, ma TUTTI i call site sono migrati a livelli.

   Vantaggi del modello:
   • Trasferimento simmetrico: −2 livelli sulla sorgente, +2 livelli sul
     target. Sempre uguale, sempre chiaro.
   • Niente "wow 4X" da 10 Mld, ma chiarezza totale (X/Y livelli + barra).
   • Bilanciamento intatto (curva interna invariata per produzione/scarsità). */

/* Solo cap per uso isolato (es. "tetto del pianeta"). */
function popMaxLabel(planet) {
  const cap = (planet && planet.popCap) || 0;
  return cap > 0 ? String(cap) : '—';
}
/* "Livello corrente / tetto" con animazione — usato dove prima c'era
   popRangePeople. La frazione (popUnits) anima fluida da X.0 a X.999
   tra un livello e l'altro; al level-up il motore matura colony.pop.total
   e il display si stabilizza sul nuovo intero. */
function popRangeLevel(colony, planet) {
  const units = ORION.planet.popUnits(colony) || 0;
  const cap = (colony && colony.pop && colony.pop.cap) || (planet && planet.popCap) || 0;
  const key = 'pop:' + colony.systemId + ':' + colony.bodyKey;
  return popAnimSpan(key, units, { decimals: 1 }) +
    ' <span class="pop-ceiling">/ ' + cap + '</span>';
}
/* Legacy: popPeople/popMaxPeople/popRangePeople sono mantenuti per
   call site UI esterni che potrebbero ancora referenziarli (es. plugin),
   ma rinviano alle versioni livelli. */
function popPeople(units, planet) { void planet; return Math.round(units || 0); }
function popMaxPeople(planet) { return popMaxLabel(planet); }
function popRangePeople(colony, planet) { return popRangeLevel(colony, planet); }

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
/* decisione #80 — mini-dissolvenza sull'holder che compare a ogni cambio di
   livello (Galassia↔Sistema↔Pianeta), così lo scroll-in/out non "stacca" di
   colpo. Vale per scroll, bottoni e doppio-click (stessi open/close). */
function zoomFadeIn(el) {
  if (!el) return;
  el.classList.remove('is-zoom-entering');
  void el.offsetWidth;                       // forza il restart dell'animazione
  el.classList.add('is-zoom-entering');
  setTimeout(function () { if (el) el.classList.remove('is-zoom-entering'); }, 260);
}

function openSystem(id) {
  const g = ORION.game;
  if (!g) return;
  const root = document.querySelector('.galaxy-root');
  if (!root) return;

  const disc = g.state.discovery[id];
  const system = ORION.system.generate(g.galaxy, id);

  /* M17 Fase C (#83): aprire un sistema ESPLORATO ne registra le anomalie
     come siti noti (raccolta ricorrente / reliquie) per la vista Dispacci. */
  if (disc >= 2 && ORION.anomaly && ORION.anomaly.ensureSites) ORION.anomaly.ensureSites(g, id);

  g.state.selectedId = id;
  ORION.openSystemId = id;
  ORION.currentSystem = system;

  const sysHolder = root.querySelector('[data-system-holder]');
  const galHolder = root.querySelector('.galaxy-holder');
  if (galHolder) galHolder.style.visibility = 'hidden';
  if (sysHolder) { sysHolder.hidden = false; zoomFadeIn(sysHolder); }

  if (ORION.systemView) ORION.systemView.destroy();
  ORION.systemView = new ORION.SystemView().mount(sysHolder, system, {
    discovery: disc,
    onSelectBody: (key) => updateSystemUI(system, key),
    onActivateBody: (key) => openPlanet(id, key),
    /* Click su marker flotta in vista sistema → stesso popup info delle
       flotte interstellari (richiesta utente 2026-06-15). */
    onFleetClick: (fleetId, cx, cy) => openFleetInfoPopup(fleetId, cx, cy),
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

  /* M06.6: tutorial — prima apertura di un sistema. Soppresso durante la
     sequenza d'apertura (non deve comparire sopra il volo cinematico). */
  if (ORION.tutorial && !(ORION.cinematics && ORION.cinematics.active && ORION.cinematics.active())) {
    ORION.tutorial.fire('system');
  }
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
    if (galHolder) { galHolder.style.visibility = ''; zoomFadeIn(galHolder); }
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
      /* Aggrega per tipo: un sistema può avere più anomalie grezze dello stesso
         tipo, ma è UN solo sito di ricognizione per tipo (vedi anomaly.js,
         chiave canonica sysId:kind) → niente righe doppie. Lo stato/azione vive
         nella tab Esplorazione della colonia ("Anomalie raggiungibili"). */
      const seen = {};
      const items = [];
      system.anomalies.forEach(function (a) {
        if (seen[a.kind]) return;
        seen[a.kind] = true;
        items.push('<li class="anomaly-item anomaly--' + a.kind + '" title="' + a.desc + '">' + a.label + '</li>');
      });
      detail += '<p class="sysinfo__sub">Anomalie</p><ul class="anomaly-list">' + items.join('') + '</ul>';
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

/* Helper riutilizzabile: blocco "Costo colonizzazione" con confronto stock
   home + nota Pioniere/provviste. Usato da `renderBodyPanel` (vista sistema)
   e da `renderPlanetColoniaTab` (vista pianeta tab Colonia).
   opts: { compact: bool } — modalità compatta (no header sezione, no nota
   finale Impulsi/Ostilità — già mostrate altrove). */
function renderColonizeCostBlock(planet, opts) {
  opts = opts || {};
  const g = ORION.game;
  if (!g) return '';
  const cost = planet.colCost || {};
  const home = g.colonies[g.homePlanetKey];
  const homeColonized = !!(home && home.colonized);
  const homeInTrouble = !!(home && home._scar &&
    (home._scar.food.state === 'crit' || home._scar.water.state === 'crit'));
  const colKey = planet.systemId + ':' + planet.bodyKey;
  const thisColony = g.colonies[colKey];
  const costMul = (homeColonized && !(thisColony && thisColony.isHomeBase) && !homeInTrouble) ? 5 : 1;
  const stockHome = homeColonized ? home.stock : { met: 0, en: 0, food: 0, water: 0 };
  const reqCost = {
    met:   Math.round((cost.met   || 0) * costMul),
    en:    Math.round((cost.en    || 0) * costMul),
    water: Math.round((cost.water || 0) * costMul),
    food:  Math.round((cost.food  || 0) * costMul)
  };
  const canPay =
    stockHome.met   >= reqCost.met &&
    stockHome.en    >= reqCost.en &&
    stockHome.water >= reqCost.water &&
    stockHome.food  >= reqCost.food;
  function costRow(label, key, glyph) {
    const req = reqCost[key];
    const have = Math.floor(stockHome[key] || 0);
    const short = req - have;
    const cls = short > 0 ? ' cost-row--short' : ' cost-row--ok';
    const tail = short > 0
      ? ' <span class="cost-row__short">manca ' + short + '</span>'
      : '';
    return '<div class="cost-row' + cls + '">' +
      '<span class="cost-row__label">' + label + '</span>' +
      '<span class="cost-row__req">' + req + ' ' + glyph + '</span>' +
      '<span class="cost-row__have">/ ' + have + '</span>' +
      tail +
    '</div>';
  }
  const F = ORION.fleet;
  const anyColonialReady = F && (
    (g.fleets || []).some(function (f) { return f && F.fleetHasColonial && F.fleetHasColonial(f); }) ||
    Object.keys(g.colonies || {}).some(function (k) {
      const c = g.colonies[k];
      return c && c.ships && (c.ships.coloniale || 0) > 0;
    })
  );
  const colonialClass = F && F.getClass ? F.getClass('coloniale') : null;
  const pioneerNote = (!anyColonialReady && colonialClass && colonialClass.cost)
    ? '<p class="panel__note panel__note--accessory">' +
        '<strong>+ Nave Pioniere</strong> da costruire (Hangar lvl 1, ' + colonialClass.time + ' Ι): ' +
        (colonialClass.cost.met || 0) + ' ' + resGlyph('met') + ' · ' +
        (colonialClass.cost.en || 0) + ' ' + resGlyph('en') + ' · ' +
        (colonialClass.cost.water || 0) + ' ' + resGlyph('water') + ' · ' +
        (colonialClass.cost.food || 0) + ' ' + resGlyph('food') +
      '</p>'
    : '';
  const mulNote = costMul > 1
    ? '<p class="panel__note">×' + costMul + ' perché la colonia primaria è ancora produttiva.</p>'
    : '';
  const crisisNote = homeInTrouble
    ? '<p class="panel__note panel__note--warn"><span class="ui-icon panel__note-icon panel__note-icon--warn" aria-hidden="true">' + ((ORION.icon && ORION.icon('warning')) || '') + '</span> Crisi sulla colonia primaria: costo di migrazione ridotto.</p>'
    : '';
  const shortNote = canPay
    ? ''
    : '<p class="panel__note panel__note--warn">Risorse insufficienti per partire — accumula quelle in rosso prima.</p>';
  return '<p class="sysinfo__sub">Costo colonizzazione' +
      (homeColonized ? ' <span class="sysinfo__sub-aux">(stock della capitale)</span>' : '') +
    '</p>' +
    '<div class="cost-table">' +
      costRow('Metalli', 'met', resGlyph('met')) +
      costRow('Energia', 'en', resGlyph('en')) +
      costRow('Acqua', 'water', resGlyph('water')) +
      costRow('Cibo', 'food', resGlyph('food')) +
    '</div>' +
    (opts.compact
      ? ''
      : '<dl class="sysinfo__list">' +
          row('Impulsi', Math.round(cost.impulsi || 0)) +
          row('Ostilità ' + hostilityNoun(planet), planet.hostility) +
        '</dl>'
    ) +
    pioneerNote +
    '<p class="panel__note panel__note--accessory"><strong>+ Provviste viaggio</strong> coloni: <strong>30</strong> ' + resGlyph('food') + ' · <strong>15</strong> ' + resGlyph('water') + ' per ogni livello demografico imbarcato (slider nel selettore).</p>' +
    mulNote +
    crisisNote +
    shortNote;
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
  if (planetHolder) { planetHolder.hidden = false; zoomFadeIn(planetHolder); }

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

  /* M06.6: tutorial — prima apertura di un pianeta. Soppresso durante la
     sequenza d'apertura (compare a fine intro col welcome). */
  if (ORION.tutorial && !(ORION.cinematics && ORION.cinematics.active && ORION.cinematics.active())) {
    ORION.tutorial.fire('planet');
  }
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
    if (sysHolder) { sysHolder.style.visibility = ''; zoomFadeIn(sysHolder); }
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
        /* Solo icone: l'etichetta della tab attiva faceva sforare la barra a
           destra (scrollbar) man mano che le sezioni aumentano. Il nome pieno
           resta nel tooltip `title` (hover) e in aria-label (accessibilità). */
        const inner = iconHtml;
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
      /* Riconosce come "spedizione di esplorazione" anche le flotte
         lanciate con il default del picker (returnHome=OFF, decisione
         2026-06-16): l'ordine è `move-route` con `exploreEach:true` e
         una sola tappa, un singolo scafo esploratore. Senza questo
         riconoscimento, lanciare l'esplorazione default farebbe sparire
         la scheda Esplorazione dal pannello colonia. */
      const onlyExplorer = f.ships && f.ships.length === 1 &&
                           f.ships[0] && f.ships[0].kind === 'explorer';
      const isExploreLike = (t === 'explore') ||
        (t === 'move-route' && f.orders.exploreEach === true && onlyExplorer) ||
        (t === 'return' && onlyExplorer &&
         (f.orders._migratedFromExplore || f.orders._migratedFromExpedition));
      if (!isExploreLike) continue;
      const ship = f.ships && f.ships[0];
      const crew = f.crew && f.crew[0];
      const isOutbound = (t === 'explore') || (t === 'move-route');
      const wpTarget = (t === 'move-route' && f.orders.waypoints && f.orders.waypoints.length)
        ? f.orders.waypoints[f.orders.waypoints.length - 1] : null;
      out.push({
        id: f.id,
        originColonyKey: key,
        targetSystemId: (t === 'explore') ? f.orders.toSysId
                      : (wpTarget != null) ? wpTarget
                      : (f.route && f.route[f.route.length - 1]),
        status: isOutbound ? 'outbound' : 'returning',
        durationOut: isOutbound ? (f.etaImpulsi || 0) : 0,
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

/* Ricognizioni attive (survey) lanciate da questa colonia. Separate dalle
   esplorazioni inter-sistema (`expeditionsForColony`) per evitare il counter
   confuso "X spedizioni" che mescolava i due flussi: le survey sono missioni
   a permanenza sull'anomalia, non viaggi di scoperta. */
function surveysForColony(colony) {
  const g = ORION.game;
  if (!g || !colony || !Array.isArray(g.fleets)) return [];
  const key = colony.systemId + ':' + colony.bodyKey;
  const out = [];
  for (let i = 0; i < g.fleets.length; i++) {
    const f = g.fleets[i];
    if (!f || f.ownerColonyKey !== key) continue;
    if (!f.orders || f.orders.type !== 'survey') continue;
    out.push(f);
  }
  return out;
}

/* Esploratori monouso (1 scafo esploratore + 1 equipaggio) appartenenti a
   questa colonia che attendono di essere riportati nei counter:
   - REMOTI: idle/survey, fermi in sosta in un sistema diverso da casa
     (tipicamente lancio col default `move-route` + returnHome OFF — a fine
     rotta restano in orbita al target).
   - A CASA: ormeggiati/in orbita al sistema della colonia ma rimasti come
     flotta separata invece di rifondersi nei counter (bug 2026-06-17: scout
     iniziale rientrato già-a-casa via setOrder('return') con rotta a 0 leg).
     Per non listare flotte appena assemblate (wizard) e ancora senza ordini,
     a casa includiamo solo gli scout "reduci" da una missione: usura > 0,
     già premiati da un'esplorazione, o con ordine return/survey pendente.
   In entrambi i casi il pannello offre un'azione one-click che li ricuce
   (scafo + equipaggio tornano disponibili sulla colonia). */
function idleExplorerFleetsForColony(colony) {
  const g = ORION.game;
  if (!g || !colony || !Array.isArray(g.fleets)) return [];
  const key = colony.systemId + ':' + colony.bodyKey;
  const homeSys = colony.systemId;
  const out = [];
  for (let i = 0; i < g.fleets.length; i++) {
    const f = g.fleets[i];
    if (!f || f.ownerColonyKey !== key) continue;
    if (!f.location) continue;
    if (f.location.status === 'in-transit') continue;
    if (!Array.isArray(f.ships) || f.ships.length !== 1) continue;
    if (!f.ships[0] || f.ships[0].kind !== 'explorer') continue;
    if (!Array.isArray(f.crew) || f.crew.length !== 1) continue;
    const ot = (f.orders && f.orders.type) || 'idle';
    const atHome = f.location.systemId === homeSys;
    if (atHome) {
      if (ot !== 'idle' && ot !== 'return' && ot !== 'survey') continue;
      const used = (f.ships[0].wear || 0) > 0 || f._exploreRewarded || ot === 'return' || ot === 'survey';
      if (!used) continue;
    } else {
      if (ot !== 'idle' && ot !== 'survey') continue;
    }
    out.push(f);
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
      if (ORION.tutorial) ORION.tutorial.fire('settling');
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
    /* Decisione #66 estensione (P1 sessione 2026-06-09): chip ⚡ Diaspora
       quando il bonus crescita pop ×2 è attivo (post-imbarco coloni #66).
       Visibile finché `colony.diaspora.until > now`. */
    let diasporaLine = '';
    if (colony.diaspora && colony.diaspora.until > (g.timeImpulsi || 0)) {
      const dLeft = colony.diaspora.until - (g.timeImpulsi || 0);
      const mul = colony.diaspora.multiplier || 2;
      diasporaLine =
        '<p class="diaspora-banner" title="Bonus Diaspora: crescita pop ×' + mul + ' attiva post-imbarco coloni">' +
          '<span class="diaspora-banner__icon">⚡</span> ' +
          '<strong>Bonus Diaspora</strong> · crescita pop ×' + mul +
          ' · <strong>' + dLeft + ' ' + iU() + '</strong> rimanenti' +
        '</p>';
    }
    host.innerHTML =
      '<div class="sysinfo">' +
        settlingBanner +
        stateLine +
        diasporaLine +
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
        renderColonyFigureSection(colony, planet) +
      '</div>';
    bindGovernorHandlers(host, planet, colony);
    bindCapitalHandlers(host, planet, colony);
    bindColonyFigureHandlers(host, planet, colony);
    ensurePopAnim();
    return;
  }

  // Colonizzazione in corso (M05 legacy + #66 con fleet).
  // Fix UI sessione 2026-06-15: nel flusso #66 (fleetId presente) il motore
  // decrementa fleet.orders.phaseLeft, NON colony.colonizing.duration → la UI
  // mostrava "Restanti 102" e "Avanzamento 0%" fissi. Ora calcoliamo dal vivo.
  if (colony.colonizing) {
    let remain, total, phaseLabel = '◌ Spedizione coloniale in viaggio';
    if (colony.colonizing.fleetId && ORION.game && ORION.game.fleets) {
      const fleet = ORION.game.fleets.filter(function (f) { return f && f.id === colony.colonizing.fleetId; })[0];
      if (fleet && fleet.orders && fleet.orders.type === 'colonize') {
        const order = fleet.orders;
        const orbitI = order.orbitI || 10;
        const foundationI = order.foundationI || planet.colCost.impulsi;
        if (order.phase === 'foundation') {
          phaseLabel = '◌ Fondazione in corso';
          remain = Math.max(0, order.phaseLeft | 0);
          total = foundationI;
        } else if (order.phase === 'orbit') {
          phaseLabel = '◌ In orbita · preparazione atterraggio';
          remain = Math.max(0, (order.phaseLeft | 0) + foundationI);
          total = orbitI + foundationI;
        } else {
          /* travel: somma leg corrente + leg residui di rotta + orbit + foundation. */
          phaseLabel = '◌ Spedizione coloniale in viaggio';
          const route = fleet.route || [];
          const routeIdx = fleet.routeIdx || 0;
          let travelRemain = fleet.etaImpulsi | 0;
          if (ORION.fleet && ORION.fleet.tempoLeg && ORION.fleet.fleetMinSpeed) {
            const ms = ORION.fleet.fleetMinSpeed(fleet);
            for (let i = routeIdx + 1; i < route.length - 1; i++) {
              travelRemain += ORION.fleet.tempoLeg(ORION.game.galaxy, route[i], route[i + 1], ms);
            }
          }
          remain = travelRemain + orbitI + foundationI;
          total = remain;  /* snapshot iniziale non memorizzato → approssimazione */
        }
      } else {
        remain = Math.max(0, colony.colonizing.duration | 0);
        total = planet.colCost.impulsi;
      }
    } else {
      /* Flusso legacy M05 senza fleet. */
      remain = Math.max(0, colony.colonizing.duration | 0);
      total = planet.colCost.impulsi;
    }
    const pct = total > 0 ? Math.round(((total - remain) / total) * 100) : 0;
    host.innerHTML =
      '<div class="sysinfo">' +
        '<p class="sysinfo__home">' + phaseLabel + '</p>' +
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
  // NB: ramo dead-path in pratica perché renderPlanetColoniaTab viene
  // chiamato solo da renderDxPanel (sidebar dx → mostra solo MIE colonie).
  // L'utente non vedrà mai questo ramo. Il vero display "costo colonizzazione
  // con confronto stock" vive ora nella action bar in basso (vista sistema),
  // che è dove l'utente seleziona un pianeta non-suo. Lasciamo qui la versione
  // semplice per backward compat / futuro uso.
  const cost = planet.colCost;
  const hostility = planet.hostility;
  const reasons = [];
  if (!def.habitable) reasons.push('Corpo non abitabile — solo estrazione.');
  const home = g.colonies[g.homePlanetKey];
  const homeColonized = !!(home && home.colonized);
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

/* M14 Fase B1 (decisione #77): sezione "Figura di colonia" nella tab Colonia.
   Mostra la figura assegnata (ruolo/rango/bonus) o l'invito ad assegnarne una
   dal pool d'Impero + il progresso di maturazione amministrativa. */
function renderColonyFigureSection(colony, planet) {
  const CF = ORION.colonyFigure;
  if (!CF || !colony || !colony.colonized || colony.phase === 'settling') return '';
  const fig = colony.figure;
  const glyph = (ORION.icon && ORION.icon('star')) || '★';
  let body;
  if (fig) {
    const race = fig.raceLabel ? (' · <span class="colfig-race">' + escapeHtml(fig.raceLabel) + '</span>') : '';
    body =
      '<div class="colfig-card colfig-card--' + escapeHtml(fig.role) + '">' +
        '<div class="colfig-card__top"><strong>' + escapeHtml((fig.rank || '') + ' ' + fig.name) + '</strong>' +
          ' · <span class="colfig-role">' + escapeHtml(CF.roleLabel(fig)) + '</span></div>' +
        '<div class="colfig-card__meta"><span class="colfig-trait" title="Tratto">' + escapeHtml(fig.traitLabel || '—') + '</span>' + race +
          ' · <span class="xp-chip">xp ' + (fig.xp | 0) + '</span></div>' +
        '<div class="colfig-card__bonus">' + escapeHtml(CF.bonusLabel(fig)) + '</div>' +
        '<button class="btn btn--mini btn--danger" data-action="colfig-release" type="button">Rilascia</button>' +
      '</div>';
  } else {
    const avail = CF.assignableOf(ORION.game).length;
    const prog = Math.min(100, Math.round(((colony.adminXp || 0) / CF.ADMIN_THRESHOLD) * 100));
    body =
      '<p class="panel__note colfig-empty">Nessuna figura assegnata. ' +
        (avail > 0
          ? 'In organico: <strong>' + avail + '</strong> disponibili.'
          : 'Le figure <strong>emergono</strong> dalle colonie mature (Governatore di sector se hai un Governatore attivo, altrimenti Ingegnere capo).') +
      '</p>' +
      '<div class="colfig-prog"><div class="colfig-prog__bar" style="width:' + prog + '%"></div></div>' +
      '<p class="panel__note colfig-prog__label">Maturazione amministrativa: ' + prog + '%</p>' +
      (avail > 0 ? '<button class="btn btn--mini" data-action="colfig-assign" type="button">Assegna figura</button>' : '');
  }
  return '<div class="gov-section colfig-section">' +
    '<div class="gov-section__head"><p class="sysinfo__sub gov-section__title">' +
      '<span class="gov-section__glyph ui-icon ui-icon--amber" aria-hidden="true">' + glyph + '</span> Figura di colonia</p></div>' +
    body +
  '</div>';
}
function bindColonyFigureHandlers(host, planet, colony) {
  if (!host || !ORION.colonyFigure) return;
  const colKey = planet.systemId + ':' + planet.bodyKey;
  const persist = function () { if (ORION.save && ORION.save.autosave && ORION.game) ORION.save.autosave(ORION.game); };
  const rel = host.querySelector('[data-action="colfig-release"]');
  if (rel) rel.addEventListener('click', function () {
    ORION.colonyFigure.releaseFromColony(ORION.game, colony);
    pushChronicle(ORION.time.currentDS(ORION.game) + ' — Figura di colonia sollevata dall\'incarico su <strong>' + escapeHtml(systemNameFromKey(ORION.game, colKey)) + '</strong>.', 'figure');
    persist(); renderPlanetColoniaTab(host, planet, colony);
  });
  const asg = host.querySelector('[data-action="colfig-assign"]');
  if (asg) asg.addEventListener('click', function () {
    openColonyFigurePicker(colKey, host, planet, colony);
  });
}
/* M14 Fase B2 (#78): testo dei suggerimenti del Consiglio della Civiltà. */
const COUNCIL_RES_LABEL = { met: 'metalli', en: 'energia', food: 'cibo', water: 'acqua' };
function councilAdviceParts(role, topic, ref, res) {
  const g = ORION.game;
  const adv = (ORION.council && g) ? ORION.council.advisorByRole(g, role) : null;
  const who = adv ? (adv.label + ' ' + adv.name)
    : ((ORION.council && ORION.council.ROLES[role]) ? ORION.council.ROLES[role].label : 'Consiglio');
  const cn = ref ? systemNameFromKey(g, ref) : '';
  const rl = res ? (COUNCIL_RES_LABEL[res] || res) : '';
  let msg;
  switch (topic) {
    case 'incursion-inbound': msg = 'un\'incursione è in rotta' + (cn ? ' verso <strong>' + escapeHtml(cn) + '</strong>' : '') + '. Valuta rinforzi, richiamo flotte o evacuazione.'; break;
    case 'pressure-high': msg = 'la pressione nemica è alta. Consolida sulla capitale o cerca tregue diplomatiche.'; break;
    case 'colony-undefended': msg = '<strong>' + escapeHtml(cn) + '</strong> è priva di difese planetarie con il nemico vicino.'; break;
    case 'scarcity-crit': msg = 'carestia critica di <strong>' + escapeHtml(rl) + '</strong> su <strong>' + escapeHtml(cn) + '</strong>: intervieni subito.'; break;
    case 'scarcity-low': msg = 'scorte di <strong>' + escapeHtml(rl) + '</strong> in calo su <strong>' + escapeHtml(cn) + '</strong>.'; break;
    case 'research-idle': msg = 'i laboratori producono ricerca ma nessun progetto è attivo. Scegli una tecnologia.'; break;
    default: msg = 'segnala una situazione da valutare.';
  }
  return { who: who, msg: msg };
}
function councilAdviceHtml(ev) {
  const p = councilAdviceParts(ev.role, ev.topic, ev.ref, ev.res);
  return '<strong>' + escapeHtml(p.who) + '</strong>: ' + p.msg;
}
function councilWho(role) {
  const g = ORION.game;
  const adv = (ORION.council && g) ? ORION.council.advisorByRole(g, role) : null;
  return adv ? (adv.label + ' ' + adv.name)
    : ((ORION.council && ORION.council.ROLES[role]) ? ORION.council.ROLES[role].label : 'Consiglio');
}
/* Descrizione di un'azione preparata dal Consiglio (proposta o autonoma). */
function councilActionDesc(action) {
  const g = ORION.game;
  if (!action) return '';
  if (action.type === 'diplo') return 'una <strong>proposta di pace</strong> con <strong>' + escapeHtml(action.civName || '—') + '</strong>';
  if (action.type === 'trade-route') return 'una <strong>rotta</strong> di ' + escapeHtml(COUNCIL_RES_LABEL[action.resource] || action.resource) +
    ' da <strong>' + escapeHtml(systemNameFromKey(g, action.src)) + '</strong> a <strong>' + escapeHtml(systemNameFromKey(g, action.dst)) + '</strong>';
  if (action.type === 'research') return 'l\'avvio della ricerca <strong>«' + escapeHtml(action.techName || '') + '»</strong>';
  return action.type;
}

/* M14 Fase B3 (#79): picker di elevazione di una figura al seggio del Consiglio.
   Elevare RITIRA la figura dal servizio operativo (scelta con peso). */
function openCouncilElevatePicker(role) {
  const g = ORION.game, C = ORION.council;
  if (!C) return;
  const elig = C.eligibleFor(g, role);
  if (!elig.length) { showToast('Nessuna figura idonea per questo seggio'); return; }
  const roleLabel = (C.ROLES[role] && C.ROLES[role].label) || 'Consigliere';
  const source = (C.ROLES[role] && C.ROLES[role].source) || '';
  const rows = elig.map(function (e) {
    return '<button class="cmd-pick__row" data-elev="' + escapeHtml(e.id) + '" data-colkey="' + escapeHtml(e.colonyKey || '') + '" data-kind="' + escapeHtml(e.kind) + '" type="button">' +
      '<span class="cmd-pick__name">★ ' + escapeHtml(e.name) + '</span>' +
      '<span class="cmd-pick__meta">' + escapeHtml(e.descr || '') + '</span>' +
    '</button>';
  }).join('');
  const adv = C.advisorByRole(g, role);
  const cur = C.hasFigure(adv)
    ? '<p class="attack-overlay__sub">Seggio attuale: <strong>' + escapeHtml(C.seatName(adv)) + '</strong> (' + escapeHtml(C.seatSource(adv)) + '). Elevarne un\'altra congeda quella in carica.</p>'
    : '';
  const html =
    '<div class="attack-overlay" data-elev-overlay>' +
      '<div class="attack-overlay__panel">' +
        '<header class="attack-overlay__head"><h3>★ Eleva al ' + escapeHtml(roleLabel) + '</h3>' +
          '<button class="attack-overlay__x btn--icon-only" data-elev-close type="button" aria-label="Chiudi">' +
            ((ORION.icon && ORION.icon('close')) || '✕') + '</button></header>' +
        '<p class="attack-overlay__sub">Fonte: <strong>' + escapeHtml(source) + '</strong>. Elevare <strong>ritira la figura dal servizio operativo</strong> (sblocca il livello Autonomo + dimezza l\'attesa).</p>' +
        cur +
        '<div class="cmd-pick__list">' + rows + '</div>' +
      '</div>' +
    '</div>';
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  const node = wrap.firstChild;
  document.body.appendChild(node);
  function close() { if (node.parentNode) node.parentNode.removeChild(node); }
  node.querySelector('[data-elev-close]').addEventListener('click', close);
  node.addEventListener('click', function (e) { if (e.target === node) close(); });
  node.querySelectorAll('[data-elev]').forEach(function (b) {
    b.addEventListener('click', function () {
      const r = C.elevate(g, role, b.dataset.kind, b.dataset.elev, b.dataset.colkey || null);
      if (!r.ok) { showToast(r.reason || 'Elevazione fallita'); return; }
      pushChronicle(ORION.time.currentDS(g) + ' — <strong>' + escapeHtml(r.figure.name) + '</strong> (' + escapeHtml(r.figure.originLabel) + ') si ritira nel <strong>' + escapeHtml(roleLabel) + '</strong>.', 'figure');
      if (ORION.save && ORION.save.autosave) ORION.save.autosave(g);
      close(); renderLeftPanel();
    });
  });
}

/* Picker di assegnazione: elenca le figure di colonia idle nel pool d'Impero. */
function openColonyFigurePicker(colKey, host, planet, colony) {
  const g = ORION.game, CF = ORION.colonyFigure;
  if (!CF) return;
  const avail = CF.assignableOf(g);
  if (!avail.length) { showToast('Nessuna figura di colonia disponibile — emergono dalle colonie mature'); return; }
  const starHtml = (ORION.icon && ORION.icon('star')) || '★';
  const rows = avail.map(function (f) {
    const origin = f.originColonyKey ? (' · da ' + escapeHtml(systemNameFromKey(g, f.originColonyKey))) : '';
    return '<button class="cmd-pick__row" data-colfig="' + escapeHtml(f.id) + '" type="button">' +
      '<span class="cmd-pick__name">' + starHtml + ' ' + escapeHtml((f.rank || '') + ' ' + f.name) + '</span>' +
      '<span class="cmd-pick__meta">' + escapeHtml(CF.roleLabel(f)) + ' · ' + escapeHtml(CF.bonusLabel(f)) +
        ' · ' + escapeHtml(f.traitLabel || '') + origin + '</span>' +
    '</button>';
  }).join('');
  const html =
    '<div class="attack-overlay" data-colfig-overlay>' +
      '<div class="attack-overlay__panel">' +
        '<header class="attack-overlay__head"><h3>' + starHtml + ' Figura per ' + escapeHtml(systemNameFromKey(g, colKey)) + '</h3>' +
          '<button class="attack-overlay__x btn--icon-only" data-colfig-close type="button" aria-label="Chiudi">' +
            ((ORION.icon && ORION.icon('close')) || '✕') + '</button></header>' +
        '<p class="attack-overlay__sub">Ruoli: <strong>Governatore di sector</strong> (deleghe più rapide, autonomia) · <strong>Ingegnere capo</strong> (−tempo assemblaggio). Una sola figura per colonia.</p>' +
        '<div class="cmd-pick__list">' + rows + '</div>' +
      '</div>' +
    '</div>';
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  const node = wrap.firstChild;
  document.body.appendChild(node);
  function close() { if (node.parentNode) node.parentNode.removeChild(node); }
  node.querySelector('[data-colfig-close]').addEventListener('click', close);
  node.addEventListener('click', function (e) { if (e.target === node) close(); });
  node.querySelectorAll('[data-colfig]').forEach(function (b) {
    b.addEventListener('click', function () {
      const r = CF.assignToColony(g, colony, colKey, b.dataset.colfig);
      if (!r.ok) { showToast(r.reason || 'Assegnazione fallita'); return; }
      pushChronicle(ORION.time.currentDS(g) + ' — <strong>' + escapeHtml((r.figure.rank || '') + ' ' + r.figure.name) +
        '</strong> assume l\'incarico di <strong>' + escapeHtml(CF.roleLabel(r.figure)) + '</strong> su <strong>' +
        escapeHtml(systemNameFromKey(g, colKey)) + '</strong>.', 'figure');
      if (ORION.save && ORION.save.autosave) ORION.save.autosave(g);
      close(); renderPlanetColoniaTab(host, planet, colony);
    });
  });
}

/* Decisione #66: la colonizzazione richiede una nave coloniale "Pioniere"
   in una flotta. tryColonize ora apre il fleet picker invece di colonizzare
   astrattamente. La home iniziale è auto-colonizzata in newGame (no ship).
   Recovery-friendly: se nessuna flotta valida, toast informativo. */
function tryColonize(planet) {
  const g = ORION.game;
  if (!g) return;
  const colKey = planet.systemId + ':' + planet.bodyKey;
  const colony = g.colonies[colKey];
  if (!colony || colony.colonized || colony.colonizing) return;
  const homeColony = g.colonies[g.homePlanetKey];
  if (!homeColony || !homeColony.colonized) return;
  openColonizePicker(planet);
}

/* Flotte candidate per colonizzare il pianeta dato. Filtri:
   - non in-transit
   - almeno 1 coloniale
   - crew sufficiente per la composizione
   - sistema target raggiungibile (o già stesso sistema → intra) */
function colonizeCapableFleets(g, planet) {
  const out = [];
  const F = ORION.fleet;
  if (!F) return out;
  const sysId = planet.systemId;
  (g.fleets || []).forEach(function (f) {
    if (!f || !f.location || f.location.status === 'in-transit') return;
    if (!F.fleetHasColonial(f)) return;
    /* Non già impegnata in altra colonizzazione. */
    if (f.orders && f.orders.type === 'colonize') return;
    const crewReq = F.fleetCrewRequired(f);
    if ((f.crew || []).length < crewReq) return;
    if (f.location.systemId === sysId) { out.push(f); return; }
    if (F.computePath(g.galaxy, f.location.systemId, sysId)) out.push(f);
  });
  return out;
}

/* Decisione "Quick path" (sessione 2026-06-15): identifica le colonie che
   hanno gli ingredienti per ASSEMBLARE al volo una flotta coloniale
   diretta al pianeta target (1 Pioniere in hangar + 4 crew in accademia
   + path BFS al sistema target). Risponde alla confusione UX segnalata
   dall'utente: "ho Pioniere + 4 crew ma cliccando Colonizza mi dice che
   non ho nave coloniale" → il picker considerava solo le flotte già
   esistenti. Recovery-friendly: nessuna risorsa consumata finché
   l'utente non conferma. */
function colonizeCreatableColonies(g, planet) {
  const out = [];
  const F = ORION.fleet;
  if (!F) return out;
  const targetSys = planet.systemId;
  const COLONIAL_CREW_NEED = 4;  /* crew richiesto per la classe coloniale */
  Object.keys(g.colonies || {}).forEach(function (ck) {
    const c = g.colonies[ck];
    if (!c || !c.colonized || c.phase === 'settling') return;
    if (!c.ships || (c.ships.coloniale || 0) < 1) return;
    const crewPool = (c.crews && c.crews.explorer) || [];
    if (crewPool.length < COLONIAL_CREW_NEED) return;
    /* Path BFS dalla colonia origine al sistema target (incluso intra). */
    let path = null;
    let hops = 0;
    if (c.systemId === targetSys) {
      path = [targetSys];
      hops = 0;
    } else {
      path = F.computePath(g.galaxy, c.systemId, targetSys);
      if (!path) return;
      hops = path.length - 1;
    }
    out.push({ colonyKey: ck, colony: c, sysId: c.systemId, hops: hops, path: path });
  });
  return out;
}

/* Costo colonizzazione effettivo + check fondi sulla colonia origine
   della flotta (non più solo home base). */
/* Costo extra per coloni a bordo (decisione bilanciamento sessione 2026-06-09,
   fix B): ogni livello di pop trasportato sulla nave coloniale consuma
   provviste per il viaggio + setup. Razionale narrativo: i pionieri mangiano
   e bevono durante settimane di viaggio iperspaziale + bootstrap dell'avamposto.
   Tarato per far sentire il costo dell'imbarco senza renderlo proibitivo. */
const COLONIST_COST_PER_LEVEL = { food: 30, water: 15 };

function colonizeCostInfo(g, planet, fleet, loadPop) {
  const cost = planet.colCost;
  const homeColony = g.colonies[g.homePlanetKey];
  const homeInTrouble = !!(homeColony && homeColony._scar &&
    (homeColony._scar.food.state === 'crit' || homeColony._scar.water.state === 'crit'));
  /* Il moltiplicatore §6.2 si applica se la home è ancora produttiva.
     Per coerenza con il flusso legacy, il check è sulla home (non sulla
     colonia origine della flotta). */
  const mul = (homeInTrouble || (g.colonies[planet.systemId + ':' + planet.bodyKey] || {}).isHomeBase) ? 1 : 5;
  /* Fix B: i coloni considerati per il costo sono quelli effettivamente
     a bordo + quelli che il picker sta per imbarcare ora (additivo).
     Se loadPop è undefined, il chiamante non ha ancora deciso → 0. */
  const onboardNow = (fleet && fleet.popOnboard) || 0;
  const extraLoad = (typeof loadPop === 'number') ? Math.max(0, loadPop | 0) : 0;
  const colonistTotal = onboardNow + extraLoad;
  const colonistCost = {
    met:   0,
    en:    0,
    water: COLONIST_COST_PER_LEVEL.water * colonistTotal,
    food:  COLONIST_COST_PER_LEVEL.food * colonistTotal
  };
  const totalCost = {
    met:   Math.round(cost.met   * mul),
    en:    Math.round(cost.en    * mul),
    water: Math.round(cost.water * mul) + colonistCost.water,
    food:  Math.round(cost.food  * mul) + colonistCost.food
  };
  /* Le risorse vengono prese dalla colonia origine della flotta. */
  const payerKey = fleet ? fleet.ownerColonyKey : g.homePlanetKey;
  const payer = g.colonies[payerKey];
  const stock = payer ? payer.stock : { met: 0, en: 0, food: 0, water: 0 };
  const canPay =
    (stock.met   || 0) >= totalCost.met   &&
    (stock.en    || 0) >= totalCost.en    &&
    (stock.water || 0) >= totalCost.water &&
    (stock.food  || 0) >= totalCost.food;
  return {
    totalCost: totalCost, mul: mul, homeInTrouble: homeInTrouble,
    payerKey: payerKey, payer: payer, canPay: canPay,
    baseImpulsi: cost.impulsi,
    colonistCost: colonistCost, colonistTotal: colonistTotal
  };
}

function openColonizePicker(planet) {
  const g = ORION.game;
  const F = ORION.fleet;
  if (!g || !F) return;
  const fleets = colonizeCapableFleets(g, planet);
  /* Quick path (sessione 2026-06-15): colonie che possono assemblare al volo
     una flotta coloniale. Se ho già un Pioniere in hangar + 4 crew, non serve
     andare al pannello flotte: il picker mostra direttamente l'opzione. */
  const creatable = colonizeCreatableColonies(g, planet);
  if (!fleets.length && !creatable.length) {
    /* Spiega perché. Diagnostica completa: hangar/crew/raggiungibilità. */
    const anyColonialShip = Object.keys(g.colonies || {}).some(function (ck) {
      const c = g.colonies[ck];
      return c && c.ships && (c.ships.coloniale || 0) > 0;
    });
    const anyColonialInFleet = (g.fleets || []).some(function (f) { return f && F.fleetHasColonial(f); });
    if (!anyColonialShip && !anyColonialInFleet) {
      showToast('Nessuna nave coloniale: costruisci un Pioniere all\'Hangar');
    } else if (anyColonialShip && !anyColonialInFleet) {
      showToast('Pioniere disponibile ma manca equipaggio (servono 4 esploratori dall\'Accademia)');
    } else {
      showToast('Nessuna flotta coloniale può raggiungere il sistema');
    }
    return;
  }
  /* Auto-fire lezione tutorial al primo openColonizePicker. */
  if (ORION.tutorial) ORION.tutorial.fire('colonial-ship');
  const sys = g.galaxy.systems[planet.systemId];
  const rows = fleets.map(function (f) {
    const intra = (f.location.systemId === planet.systemId);
    const path = intra ? [planet.systemId] : F.computePath(g.galaxy, f.location.systemId, planet.systemId);
    const hops = path ? path.length - 1 : 0;
    /* Costo iniziale calcolato col defaultLoad (anticipo del costo coloni B). */
    const popCargoCap = F.fleetPopCargoCap ? F.fleetPopCargoCap(f) : 0;
    const onboardNow = f.popOnboard || 0;
    const _info0 = colonizeCostInfo(g, planet, f, 0);
    const srcPop = (_info0.payer && _info0.payer.pop && _info0.payer.pop.total) || 0;
    const roomOnShip = Math.max(0, popCargoCap - onboardNow);
    const srcAvailable = Math.max(0, srcPop - 1);
    const maxLoad = Math.min(roomOnShip, srcAvailable);
    const defaultLoad = onboardNow > 0 ? 0 : Math.min(maxLoad, popCargoCap);
    const info = colonizeCostInfo(g, planet, f, defaultLoad);
    const orbit = 10;
    const minSpeed = F.fleetMinSpeed(f);
    /* Decisione utente: l'intra-sistema ora ha un viaggio reale corpo→corpo. */
    const travelEst = intra
      ? (F.intraTravelI ? F.intraTravelI(g, f, planet.bodyKey) : 0)
      : hops * F.tempoLeg(g.galaxy, f.location.systemId, planet.systemId, minSpeed);
    /* Decisione #66 (refinement): foundation = colCost.impulsi pieno (dipende
       da grandezza+ostilità del pianeta, NON dal viaggio). Travel e orbit
       sono additivi. */
    const total = travelEst + orbit + Math.max(20, info.baseImpulsi);
    const cost = info.totalCost;
    const payerName = colonyNameFromKey(info.payerKey);
    const costHtml = (info.canPay ? '' : '<span class="colonize-pick__warn">Risorse insufficienti</span>');
    /* Estratto del costo extra coloni per UI esplicita. */
    const cExtra = info.colonistCost;
    const colonistTotal = info.colonistTotal;
    const colonistCostNote = colonistTotal > 0
      ? '<span class="colonize-pick__colonist-note">+ provviste viaggio per ' + colonistTotal + ' coloni: <strong>' + cExtra.food + ' ' + resGlyph('food') + ' · ' + cExtra.water + ' ' + resGlyph('water') + '</strong></span>'
      : '';
    /* Decisione #66 estensione + Fix (C) sessione 2026-06-09: il picker RISPETTA
       i coloni già a bordo (imbarcati via Manage overlay). Lo slider rappresenta
       l'imbarco AGGIUNTIVO, non il totale a bordo. Variabili popCargoCap/onboardNow/
       maxLoad/defaultLoad sono già state calcolate sopra per il costo info. */
    const totalLabel = '<strong data-pop-total="' + escapeHtml(f.id) + '">' + (onboardNow + defaultLoad) + '</strong> / ' + popCargoCap;
    const alreadyTxt = onboardNow > 0
      ? '<span class="colonize-pick__already">Già a bordo: <strong>' + onboardNow + '</strong>' +
          (maxLoad > 0 ? ' · imbarca ora: <strong data-pop-out="' + escapeHtml(f.id) + '">' + defaultLoad + '</strong>' : '') +
        '</span>'
      : '<label>Coloni a bordo: <strong data-pop-out="' + escapeHtml(f.id) + '">' + defaultLoad + '</strong> / ' + popCargoCap + '</label>';
    const sliderDisabled = (maxLoad === 0);
    const warnTxt = (maxLoad === 0 && onboardNow === 0)
      ? '<span class="colonize-pick__warn">Sorgente troppo piccola per imbarcare</span>'
      : '';
    return '<div class="colonize-pick__card" data-fleet-row="' + escapeHtml(f.id) + '">' +
      '<button class="attack-pick__row" data-fleet="' + escapeHtml(f.id) + '"' + (info.canPay ? '' : ' disabled') + ' type="button">' +
        '<span class="attack-pick__name">' + escapeHtml(f.name) + '</span>' +
        '<span class="attack-pick__meta">' +
          (f.ships || []).length + ' navi · ' + (hops === 0 ? 'intra-sistema' : hops + ' salti') +
          ' · ~' + total + ' ' + iU() +
          ' · costo da ' + escapeHtml(payerName) +
          ' (' + cost.met + ' ' + resGlyph('met') + ' · ' + cost.en + ' ' + resGlyph('en') +
          ' · ' + cost.water + ' ' + resGlyph('water') + ' · ' + cost.food + ' ' + resGlyph('food') + ')' +
          (costHtml ? ' · ' + costHtml : '') +
        '</span>' +
      '</button>' +
      (popCargoCap > 0 ?
        '<div class="colonize-pick__pop">' +
          alreadyTxt +
          (onboardNow > 0 ? '<span class="colonize-pick__total">Totale alla colonia: ' + totalLabel + '</span>' : '') +
          '<input type="range" min="0" max="' + maxLoad + '" step="1" value="' + defaultLoad + '" data-pop-input="' + escapeHtml(f.id) + '" data-pop-onboard="' + onboardNow + '"' + (sliderDisabled ? ' disabled' : '') + '>' +
          warnTxt +
          (colonistTotal > 0 ? '<span class="colonize-pick__colonist-cost" data-colonist-cost="' + escapeHtml(f.id) + '">' + colonistCostNote + '</span>' : '<span class="colonize-pick__colonist-cost" data-colonist-cost="' + escapeHtml(f.id) + '"></span>') +
        '</div>'
        : ''
      ) +
    '</div>';
  }).join('');

  /* Quick path (sessione 2026-06-15): card "Crea spedizione coloniale" per
     ogni colonia con Pioniere in hangar + 4 crew + path al sistema target.
     Un click → createFleet + assignShips coloniale + assignCrew 4 + doColonize. */
  const COLONIAL_CARGO = 2;
  const COLONIAL_CREW_NEED = 4;
  const createRows = creatable.map(function (c) {
    const ck = c.colonyKey;
    const cname = colonyNameFromKey(ck);
    const intra = (c.sysId === planet.systemId);
    /* Stima viaggio: serve la velocità della nave coloniale. */
    const colonialClass = F.getClass('coloniale');
    const speed = colonialClass ? colonialClass.speed : 0.8;
    const travelEst = intra ? 0 : c.hops * F.tempoLeg(g.galaxy, c.sysId, planet.systemId, speed);
    /* Mock fleet per il calcolo costo (popOnboard=0, ownerColonyKey=ck). */
    const mockFleet = { id: '__mock__', ownerColonyKey: ck, popOnboard: 0, ships: [{ kind: 'coloniale', hp: 70 }], crew: [], location: { systemId: c.sysId, status: 'docked' } };
    const srcPop = (c.colony.pop && c.colony.pop.total) || 0;
    const maxLoadC = Math.max(0, Math.min(COLONIAL_CARGO, srcPop - 1));
    const defaultLoadC = maxLoadC;
    const infoC = colonizeCostInfo(g, planet, mockFleet, defaultLoadC);
    const orbit = 10;
    const totalI = travelEst + orbit + Math.max(20, infoC.baseImpulsi);
    const costC = infoC.totalCost;
    const canPayC = infoC.canPay;
    const cExtraC = infoC.colonistCost;
    const colonistTotalC = infoC.colonistTotal;
    const dataId = 'create-' + ck;
    const colonistNoteC = colonistTotalC > 0
      ? '<span class="colonize-pick__colonist-note">+ provviste viaggio per ' + colonistTotalC + ' coloni: <strong>' + cExtraC.food + ' ' + resGlyph('food') + ' · ' + cExtraC.water + ' ' + resGlyph('water') + '</strong></span>'
      : '';
    const popHtmlC = '<div class="colonize-pick__pop">' +
      '<label>Coloni a bordo: <strong data-pop-out="' + escapeHtml(dataId) + '">' + defaultLoadC + '</strong> / ' + COLONIAL_CARGO + '</label>' +
      '<input type="range" min="0" max="' + maxLoadC + '" step="1" value="' + defaultLoadC + '" data-pop-input="' + escapeHtml(dataId) + '" data-pop-onboard="0"' + (maxLoadC === 0 ? ' disabled' : '') + '>' +
      (maxLoadC === 0 ? '<span class="colonize-pick__warn">Sorgente troppo piccola per imbarcare</span>' : '') +
      '<span class="colonize-pick__colonist-cost" data-colonist-cost="' + escapeHtml(dataId) + '">' + colonistNoteC + '</span>' +
    '</div>';
    return '<div class="colonize-pick__card colonize-pick__card--create" data-create-row="' + escapeHtml(ck) + '">' +
      '<button class="attack-pick__row" data-create-fleet="' + escapeHtml(ck) + '"' + (canPayC ? '' : ' disabled') + ' type="button">' +
        '<span class="attack-pick__name">' +
          '<span class="colonize-pick__new-badge">🆕</span> Spedizione coloniale da <strong>' + escapeHtml(cname) + '</strong>' +
        '</span>' +
        '<span class="attack-pick__meta">' +
          '1 Pioniere · ' + COLONIAL_CREW_NEED + ' equipaggi · ' +
          (intra ? 'intra-sistema' : c.hops + ' salti') +
          ' · ~' + totalI + ' ' + iU() +
          ' (' + costC.met + ' ' + resGlyph('met') + ' · ' + costC.en + ' ' + resGlyph('en') +
          ' · ' + costC.water + ' ' + resGlyph('water') + ' · ' + costC.food + ' ' + resGlyph('food') + ')' +
          (canPayC ? '' : ' · <span class="colonize-pick__warn">Risorse insufficienti</span>') +
        '</span>' +
      '</button>' +
      popHtmlC +
    '</div>';
  }).join('');
  const html =
    '<div class="attack-overlay" data-colonize-overlay>' +
      '<div class="attack-overlay__panel">' +
        '<header class="attack-overlay__head"><h3>' +
          '<span class="ui-icon ui-icon--cyan" aria-hidden="true">' + ((ORION.icon && ORION.icon('star')) || '◉') + '</span> ' +
          'Colonizza ' + escapeHtml(planet.name) +
        '</h3>' +
          '<button class="attack-overlay__x" data-colonize-close type="button" aria-label="Chiudi">' +
            '<span class="ui-icon" aria-hidden="true">' + ((ORION.icon && ORION.icon('close')) || '✕') + '</span>' +
          '</button></header>' +
        '<p class="attack-overlay__sub">Destinazione: <strong>' + escapeHtml(planet.name) + '</strong>' +
          (sys ? ' nel sistema ' + escapeHtml(sys.name) : '') +
          ' · scegli una flotta esistente o crea al volo una spedizione coloniale.</p>' +
        '<div class="attack-pick__list">' +
          (fleets.length > 0 ? '<p class="colonize-pick__section-label">Flotte coloniali pronte</p>' + rows : '') +
          (creatable.length > 0
            ? (fleets.length > 0 ? '<p class="colonize-pick__section-label colonize-pick__section-label--create">Oppure crea al volo</p>' : '') + createRows
            : '') +
        '</div>' +
        '<p class="attack-overlay__hint">La nave coloniale viaggia, orbita per il setup, poi atterra come avamposto. La flotta resta in orbita al termine.</p>' +
      '</div>' +
    '</div>';
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  const node = wrap.firstChild;
  document.body.appendChild(node);
  function close() { if (node.parentNode) node.parentNode.removeChild(node); }
  node.querySelector('[data-colonize-close]').addEventListener('click', close);
  node.addEventListener('click', function (e) { if (e.target === node) close(); });
  /* Live update del label "Coloni a bordo: N" mentre l'utente muove lo slider.
     Fix (C): se c'è onboard preesistente, aggiorna anche il totale visualizzato.
     Fix (B): ricalcola e mostra il costo extra coloni (food/water) live. */
  node.querySelectorAll('[data-pop-input]').forEach(function (inp) {
    inp.addEventListener('input', function () {
      const fid = inp.getAttribute('data-pop-input');
      const onboard = parseInt(inp.getAttribute('data-pop-onboard'), 10) || 0;
      const out = node.querySelector('[data-pop-out="' + fid + '"]');
      const tot = node.querySelector('[data-pop-total="' + fid + '"]');
      const val = parseInt(inp.value, 10) || 0;
      if (out) out.textContent = String(val);
      if (tot) tot.textContent = String(onboard + val) + ' / ' + tot.textContent.split('/')[1].trim();
      /* Ricalcola costo extra coloni (B). */
      const noteHost = node.querySelector('[data-colonist-cost="' + fid + '"]');
      if (noteHost) {
        const colonistTot = onboard + val;
        if (colonistTot > 0) {
          const food = COLONIST_COST_PER_LEVEL.food * colonistTot;
          const water = COLONIST_COST_PER_LEVEL.water * colonistTot;
          noteHost.innerHTML = '<span class="colonize-pick__colonist-note">+ provviste viaggio per ' + colonistTot + ' coloni: <strong>' + food + ' ' + resGlyph('food') + ' · ' + water + ' ' + resGlyph('water') + '</strong></span>';
        } else {
          noteHost.innerHTML = '';
        }
      }
    });
  });
  node.querySelectorAll('[data-fleet]').forEach(function (b) {
    b.addEventListener('click', function () {
      const fleet = (g.fleets || []).filter(function (f) { return f.id === b.dataset.fleet; })[0];
      if (!fleet) { close(); return; }
      /* Leggi loadPop dallo slider della card di questa flotta. */
      const inp = node.querySelector('[data-pop-input="' + fleet.id + '"]');
      const loadPop = inp ? parseInt(inp.value, 10) || 0 : 0;
      doColonize(planet, fleet, loadPop);
      close();
    });
  });
  /* Quick path: assembla flotta coloniale al volo da una colonia con
     Pioniere + 4 crew, poi imposta l'ordine colonize.
     Recovery-friendly: se assignShips o assignCrew falliscono per qualsiasi
     ragione, la flotta appena creata viene dissolta (rollback). */
  node.querySelectorAll('[data-create-fleet]').forEach(function (b) {
    b.addEventListener('click', function () {
      const ck = b.dataset.createFleet;
      const inp = node.querySelector('[data-pop-input="create-' + ck + '"]');
      const loadPop = inp ? parseInt(inp.value, 10) || 0 : 0;
      runQuickColonize(planet, ck, loadPop);
      close();
    });
  });
}

/* Quick path: crea flotta + assegna 1 coloniale + 4 crew + setOrder colonize.
   Usato dal picker quando l'utente non ha una flotta coloniale pronta ma
   ha gli ingredienti in hangar/accademia. */
function runQuickColonize(planet, colonyKey, loadPop) {
  const g = ORION.game;
  const F = ORION.fleet;
  if (!g || !F) return;
  const colony = g.colonies && g.colonies[colonyKey];
  if (!colony) { showToast('Colonia origine non valida'); return; }
  const COLONIAL_CREW_NEED = 4;
  /* Pre-check: hangar + crew ancora disponibili (potrebbero essere stati
     consumati da un'altra azione tra il render del picker e il click). */
  if (!colony.ships || (colony.ships.coloniale || 0) < 1) {
    showToast('Pioniere non più disponibile in hangar');
    return;
  }
  const crewPool = (colony.crews && colony.crews.explorer) || [];
  if (crewPool.length < COLONIAL_CREW_NEED) {
    showToast('Equipaggio insufficiente in accademia');
    return;
  }
  /* Niente nome esplicito: lo riceverà al setOrder('colonize') sotto come
     callsign progressivo "Pioniere N" (decisione utente 2026-06-15). */
  const cr = F.createFleet(g, colonyKey, null);
  if (!cr.ok) { showToast('Creazione flotta: ' + (cr.reason || 'errore')); return; }
  const newFleet = cr.fleet;
  if (!newFleet) { showToast('Errore interno: flotta non creata'); return; }
  /* Assegna 1 coloniale. */
  const aShip = F.assignShips(g, newFleet, colonyKey, 'coloniale', 1);
  if (!aShip.ok) {
    F.dissolveFleet(g, newFleet);
    showToast('Assegnazione Pioniere: ' + (aShip.reason || 'errore'));
    return;
  }
  /* Assegna 4 crew. */
  const aCrew = F.assignCrew(g, newFleet, colonyKey, COLONIAL_CREW_NEED);
  if (!aCrew.ok) {
    F.dissolveFleet(g, newFleet);
    showToast('Assegnazione equipaggio: ' + (aCrew.reason || 'errore'));
    return;
  }
  /* Spedizione assemblata: azione del giocatore — nessuna voce in cronaca
     (feedback utente 2026-06-17, rumore in Colonie). La conferma è visiva
     nel roster flotte. */
  /* doColonize fa il resto (costo + embarkPop + setOrder).
     Se doColonize fallisce internamente (es. risorse insufficienti, ordine
     rifiutato) la flotta resta assemblata ma idle in orbita della colonia —
     recovery-friendly: l'utente può poi mandarla manualmente. */
  doColonize(planet, newFleet, loadPop);
}

/* Esegue la colonizzazione: deduce il costo, imposta l'ordine `colonize`
   sulla flotta. Decisione #66: il costo è pagato all'inizio (UX), refund
   gestito da combat.js se la coloniale è persa in transit. */
function doColonize(planet, fleet, loadPop) {
  const g = ORION.game;
  const F = ORION.fleet;
  if (!g || !F) return;
  const colKey = planet.systemId + ':' + planet.bodyKey;
  const colony = g.colonies[colKey];
  if (!colony || colony.colonized || colony.colonizing) return;
  /* Fix (C) sessione 2026-06-09: loadPop dal picker rappresenta l'imbarco
     AGGIUNTIVO. La pop già a bordo (fleet.popOnboard) NON viene re-imbarcata
     né re-sottratta dalla colonia. Il costo coloni (B) considera SOMMA dei
     livelli totali a bordo (già + nuovi), perché tutti consumano provviste. */
  const cap = F.fleetPopCargoCap ? F.fleetPopCargoCap(fleet) : 0;
  const onboardNow = fleet.popOnboard || 0;
  const roomOnShip = Math.max(0, cap - onboardNow);
  const reqLoad = (typeof loadPop === 'number') ? Math.max(0, Math.min(roomOnShip, loadPop | 0)) : 0;
  /* Costo info ricalcolato con loadPop effettivo (decisione B: provviste extra). */
  const info = colonizeCostInfo(g, planet, fleet, reqLoad);
  if (!info.canPay) { showToast('Risorse insufficienti'); return; }
  /* Imbarco SOLO della quota aggiuntiva. Se 0 e la flotta ha già coloni a bordo,
     nessun imbarco viene chiamato → nessuna nuova Diaspora attivata. */
  if (reqLoad > 0) {
    const embarkRes = F.embarkPop(g, fleet, info.payerKey, reqLoad);
    if (!embarkRes.ok) {
      showToast('Imbarco coloni: ' + (embarkRes.reason || 'errore'));
      return;
    }
  }
  /* Deduce dal payer (colonia origine della flotta). */
  ['met', 'en', 'water', 'food'].forEach(function (k) {
    info.payer.stock[k] = Math.max(0, (info.payer.stock[k] || 0) - info.totalCost[k]);
  });
  /* Calcola le 3 fasi e imposta l'ordine.
     Decisione #66 (refinement, sessione 2026-06-09): foundation dipende solo
     dal pianeta (grandezza+ostilità via colCost.impulsi §6.2), NON dal viaggio.
     Travel e orbit si aggiungono sopra. Intra-sistema → totale ≈ orbit + foundation;
     extra-sistema → totale ≈ travel + orbit + foundation (M13 iperguida scalerà
     solo il travel). Più fisicamente intuitivo + travel diventa "visibile" come
     costo, motivazione narrativa per M13. */
  const intra = (fleet.location.systemId === planet.systemId);
  const orbitI = 10;
  const foundationI = Math.max(20, info.baseImpulsi);
  /* Memo del costo pagato per refund 50% se nave persa in transit. */
  fleet._colonizePaidCost = {
    coloniale: F.getClass('coloniale').cost,
    colonization: { met: info.totalCost.met, en: info.totalCost.en, food: info.totalCost.food, water: info.totalCost.water },
    payerKey: info.payerKey
  };
  const r = F.setOrder(g, fleet, {
    type: 'colonize',
    toSysId: planet.systemId,
    bodyKey: planet.bodyKey,
    orbitI: orbitI,
    foundationI: foundationI
  });
  if (!r.ok) {
    /* Rollback risorse. */
    ['met', 'en', 'water', 'food'].forEach(function (k) {
      info.payer.stock[k] = (info.payer.stock[k] || 0) + info.totalCost[k];
    });
    /* Fix rollback completo sessione 2026-06-09: se abbiamo imbarcato coloni
       in questo doColonize (reqLoad > 0), embarkPop ha già sottratto la pop
       dalla colonia origine + attivato la Diaspora. Se setOrder fallisce,
       quei side-effects vanno annullati: pop torna alla sorgente, Diaspora
       rimossa (era stata appena creata da embarkPop in questo flusso).
       NB: i coloni preesistenti (onboardNow) restano sulla flotta — quelli
       erano stati imbarcati in precedenza via Manage, NON è il nostro flusso
       da rollbackare. */
    if (reqLoad > 0 && info.payer && info.payer.pop) {
      const popCap = info.payer.pop.cap || 0;
      const room = Math.max(0, popCap - (info.payer.pop.total || 0));
      const back = Math.min(reqLoad, room);
      info.payer.pop.total = (info.payer.pop.total || 0) + back;
      fleet.popOnboard = Math.max(0, (fleet.popOnboard || 0) - reqLoad);
      /* La Diaspora era stata creata/rinnovata da embarkPop nel flusso corrente
         (startedAt === g.timeImpulsi). La rimuoviamo solo se è "fresca" — così
         non eliminiamo una Diaspora preesistente legittima. */
      if (info.payer.diaspora && info.payer.diaspora.startedAt === (g.timeImpulsi || 0)) {
        info.payer.diaspora = null;
      }
    }
    fleet._colonizePaidCost = null;
    showToast(r.reason || 'Ordine rifiutato');
    return;
  }
  /* Callsign d'esordio "Pioniere N" se ancora "Squadrone N" default. */
  maybeAutoRenameFleet(g, fleet, { type: 'colonize', toSysId: planet.systemId });
  pushChronicle(ORION.time.currentDS(g) + ' — Spedizione coloniale <strong>' + escapeHtml(fleet.name) +
    '</strong> in viaggio verso <strong>' + escapeHtml(planet.name) + '</strong>' + bodyTagHtml(planet.systemId) +
    (intra ? ' (rotta intra-sistema)' : ' (' + (r.path ? r.path.length - 1 : 1) + ' salti)') + '.', 'planet');
  if (ORION.tutorial) {
    ORION.tutorial.fire('specialization');
    ORION.tutorial.fire('colonial-ship');
  }
  /* M10 Fase B (decisione #52 §13.6): colonizzare in un sistema coeso
     costa −15 disposizione a ciascun proprietario AI. */
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
  if (typeof renderLeftPanel === 'function') renderLeftPanel();
  if (typeof renderDxPanel === 'function') renderDxPanel();
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
  /* Avvio costruzione struttura: rumore in Colonie — la coda della
     colonia è il feedback (build-done idem fuori dal log). */
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
  const r = ORION.planet.startDemolish(colony, planet, id, ORION.time.currentDS(g));
  if (!r.ok) {
    console.info('Smantellamento rifiutato:', r.reason);
    showToast(r.reason || 'Smantellamento rifiutato');
    return;
  }
  /* Avvio smantellamento/downgrade: azione del giocatore, niente entry
     in cronaca — la coda della colonia mostra il lavoro in corso. */
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
  host.querySelectorAll('[data-cancel-merc]').forEach(function (btn) {
    btn.addEventListener('click', function () { tryCancelMerc(Number(btn.dataset.cancelMerc)); });
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
/* Callsign FONETICO stabile e univoco per equipaggio (scelta utente: callsign
   fonetico a tema, sapore SW-flavor senza marchi — decisione #34). Pool ampio
   di 80 parole evocative (predatori · armi · fenomeni · corpi celesti · reparti
   militari) + numero 1..199 → 15.920 callsign distinti: margine abbondante per
   la longevità del gioco e per il ricambio (gli equipaggi muoiono in
   combattimento). Il seq univoco (dall'id `crew-<seq>`) è mappato con una
   permutazione moltiplicativa → BIJEZIONE: seq diversi danno callsign diversi
   ("non già assegnato"), e consecutivi risultano sparsi. Deterministico
   (replay-safe #5, niente Math.random). Es. "Falco-7", "Spettro-142". Nasce
   con l'equipaggio e non cambia mai (niente rinomina al rientro). */
const CREW_WORDS = [
  'Falco', 'Corvo', 'Lupo', 'Vipera', 'Aquila', 'Pantera', 'Lince', 'Sciacallo',
  'Grifone', 'Drago', 'Scorpione', 'Cobra', 'Lama', 'Lancia', 'Falce', 'Pugnale',
  'Asta', 'Maglio', 'Dardo', 'Saetta', 'Artiglio', 'Zanna', 'Spettro', 'Eco',
  'Ombra', 'Alba', 'Eclissi', 'Aurora', 'Tempesta', 'Fulmine', 'Cenere', 'Brace',
  'Miraggio', 'Vortice', 'Abisso', 'Zenit', 'Nadir', 'Cometa', 'Meteora', 'Pulsar',
  'Quasar', 'Nova', 'Orione', 'Nebulosa', 'Sentinella', 'Vettore', 'Ronda', 'Guardiano',
  'Vedetta', 'Avanguardia', 'Rapace', 'Bagliore', 'Crepuscolo', 'Astore', 'Procione',
  'Ariete', 'Bisonte', 'Chimera', 'Fenice', 'Idra',
  'Razzo', 'Spada', 'Scudo', 'Sciame', 'Lampo', 'Tuono', 'Stella', 'Astro',
  'Baluardo', 'Vessillo', 'Stendardo', 'Alabarda', 'Balestra', 'Falange', 'Legione',
  'Centurione', 'Sciabola', 'Calabrone', 'Mantide', 'Sparviero'
];
function crewCallsign(seq) {
  const W = CREW_WORDS.length;                  // 80 parole
  const N = 199;                                // numeri 1..199
  const M = W * N;                              // 15.920 combinazioni
  const s = ((((seq | 0) * 99991) % M) + M) % M; // 99991 coprimo con M → bijezione
  const w = Math.floor(s / N);
  const num = (s % N) + 1;
  return CREW_WORDS[w] + '-' + num;
}
function crewShortLabel(id) {
  if (!id) return 'Equipaggio';
  /* `crew-<seq>` → callsign stabile dal seq. Eventuali ID legacy
     `crew-<imp>-<n>` vengono migrati a `crew-<seq>` in enterGame. */
  const m = /-(\d+)$/.exec(String(id));
  return m ? crewCallsign(Number(m[1])) : String(id);
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

/* M15 — motivo (breve) per cui una nave capitale NON è costruibile su questa
   colonia: manca il Bacino orbitale al livello richiesto, oppure la Nave
   Ammiraglia esiste già (unica per civiltà). Ritorna '' se nessun blocco
   specifico capitale. Rispecchia i gate di planet.startShipBuild. */
function capitalBuildBlock(colony, cls) {
  if (!cls) return '';
  if (cls.requiresStruct) {
    const rs = cls.requiresStruct;
    const ent = colony.structures && colony.structures[rs.id];
    if (!ent || (ent.level || 0) < (rs.level || 1)) {
      const sdef = ORION.structures && ORION.structures.get(rs.id);
      return (sdef ? sdef.name : rs.id) + ' lvl ' + (rs.level || 1);
    }
  }
  if (cls.unique && ORION.game) {
    let n = 0;
    const cols = ORION.game.colonies || {};
    Object.keys(cols).forEach(function (ck) {
      const c = cols[ck];
      if (c && c.ships) n += (c.ships[cls.id] || 0);
      const q = c && c.assets && c.assets.shipQueue;
      if (Array.isArray(q)) for (let i = 0; i < q.length; i++) if (q[i].kind === cls.id) n++;
    });
    (ORION.game.fleets || []).forEach(function (f) {
      (f.ships || []).forEach(function (s) { if (s.kind === cls.id) n++; });
    });
    if (n >= 1) return 'già esistente (unica)';
  }
  return '';
}

/* Visual per classe nave nella riserva Hangar (#42): icona SVG dedicata
   (icons.js) + tinta per ruolo (esplorazione ciano · combattimento caldo ·
   coloniale verde · capitali M15). Fallback al glifo monocolore se manca. */
const SHIP_VIS = {
  explorer:     { icon: 'shipExplorer',     tone: 'cyan' },
  caccia:       { icon: 'shipCaccia',       tone: 'gold' },
  intercettore: { icon: 'shipIntercettore', tone: 'amber' },
  corvetta:     { icon: 'shipCorvetta',     tone: 'pink' },
  fregata:      { icon: 'shipFregata',      tone: 'violet' },
  coloniale:    { icon: 'shipColoniale',    tone: 'green' },
  incrociatore: { icon: 'shipIncrociatore', tone: 'pink' },
  dreadnought:  { icon: 'shipDreadnought',  tone: 'pink' },
  ammiraglia:   { icon: 'shipAmmiraglia',   tone: 'gold' }
};
function shipVisIcon(cls) {
  const v = SHIP_VIS[cls.id] || { tone: 'soft' };
  const svg = (v.icon && ORION.icon && ORION.icon(v.icon)) || '';
  const inner = svg || ('<span class="hangar-ship__glyph">' + (cls.glyph || '◈') + '</span>');
  return '<span class="hangar-ship__ico ui-icon ui-icon--' + v.tone + '" aria-hidden="true">' + inner + '</span>';
}

/* Riquadro di riepilogo della riserva navi a terra (#42): una card per
   classe presente, con icona estesa + conteggio + stazza (hp/fuoco/eq). */
function shipReserveBox(colony, classes) {
  const cards = classes.map(function (cls) {
    const n = (colony.ships && colony.ships[cls.id]) || 0;
    if (!n) return null;
    const stats = [];
    if (cls.hp) stats.push('<span title="Corazza">♥ ' + cls.hp + '</span>');
    if (cls.fp) stats.push('<span title="Potenza di fuoco">⚔ ' + cls.fp + '</span>');
    if (cls.crew) stats.push('<span title="Equipaggio richiesto">☗ ' + cls.crew + '</span>');
    return '<div class="hangar-ship" title="' + escapeHtml(cls.name) + '">' +
        shipVisIcon(cls) +
        '<div class="hangar-ship__main">' +
          '<div class="hangar-ship__top"><b>×' + n + '</b> ' + escapeHtml(cls.name) + '</div>' +
          '<div class="hangar-ship__stats">' + stats.join('<i>·</i>') + '</div>' +
        '</div>' +
      '</div>';
  }).filter(Boolean);
  if (!cards.length) {
    return '<div class="hangar-reserve hangar-reserve--empty">Nessuna nave in riserva — costruiscine una qui sotto.</div>';
  }
  return '<div class="hangar-reserve">' + cards.join('') + '</div>';
}

function renderCantieriSection(colony, planet) {
  const hasHangar = !!(colony.structures && colony.structures['cantiere-navale']);
  const hasAcademy = !!(colony.structures && colony.structures['accademia-militare']);
  /* Decisione utente 2026-06-11: i Comandanti sono figure a livello Impero
     (game.commanders) e vivono nella vista Flotta (buildCommanderRoster),
     non più nella scheda colonia. */
  if (!hasHangar && !hasAcademy) return '';
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
    '<p class="sysinfo__sub">Cantieri & Squadre</p>';

  if (hasHangar) {
    /* M08 Fase A (decisione #42): counter di TUTTE le classi navi note. */
    const F = ORION.fleet || {};
    const classes = (F.classList ? F.classList() : []);
    ORION.fleet && ORION.fleet.ensureColonyShipKinds && ORION.fleet.ensureColonyShipKinds(colony);
    let sShips = 0;
    classes.forEach(function (cls) { sShips += (colony.ships && colony.ships[cls.id]) || 0; });
    const queue = colony.assets.shipQueue || [];
    const mercQueue = (colony.assets && colony.assets.mercantileQueue) || [];
    const payOk = canPay(shipCost);
    /* Decisione #41: cantieri (build paralleli) + attracchi (porto a terra). */
    const E = ORION.expedition || {};
    const buildSlots = E.hangarBuildSlots ? E.hangarBuildSlots(colony) : 1;
    /* Posti d'attracco TOTALI = attracchi + cantieri (le navi in costruzione
       prenotano il posto, 2026-06-18). Combacia col gate canBuildShip. */
    const docks = E.hangarBerthCapacity ? E.hangarBerthCapacity(colony)
                : (E.hangarDockCapacity ? E.hangarDockCapacity(colony) : 1);
    const active = E.activeShipBuilds ? E.activeShipBuilds(colony) : queue.length;
    /* Cantieri occupati = scafi + mercantili in coda (#56). Gli attracchi
       (docks) restano solo per gli scafi: i mercantili non occupano il porto. */
    const cantieriUse = E.activeCantieriUse ? E.activeCantieriUse(colony) : (active + mercQueue.length);
    const flying = E.shipsOnExpedition ? E.shipsOnExpedition(ORION.game, ORION.openPlanetKey) : 0;
    /* M15: attracchi PESATI (le capitali contano più di 1). Usa il conteggio
       del motore così il display combacia col gate canBuildShip. */
    const bound = E.totalShipsBound ? E.totalShipsBound(ORION.game, colony, ORION.openPlanetKey).total : (sShips + active + flying);
    const techBonus = E.techSpeedBonus ? E.techSpeedBonus(colony) : 0;
    const cantieriCls = cantieriUse >= buildSlots ? ' cantieri-cap--full' : '';
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
    const check = E.canBuildShip ? E.canBuildShip(ORION.game, colony, ORION.openPlanetKey, pickedKind) : { ok: true };
    /* M15 — gate aggiuntivo per le navi capitali: Bacino orbitale + unicità
       Nave Ammiraglia (rispecchia startShipBuild). */
    const capBlock = capitalBuildBlock(colony, pickedCls);
    const buildEnabled = payOkShip && check.ok && !capBlock;
    const blockReason = capBlock || (!check.ok ? check.reason : (!payOkShip ? 'Risorse insufficienti' : ''));

    html += '<div class="cantieri-row">' +
      '<div class="cantieri-row__head">' +
        '<span class="cantieri-row__glyph" aria-hidden="true">▱</span>' +
        '<span class="cantieri-row__name">Hangar di costruzione <span class="cantieri-row__base">lvl ' + hangarLvl + '</span></span>' +
        '<span class="cantieri-row__counter">Scafi a terra: <strong>' + sShips + '</strong></span>' +
      '</div>' +
      '<div class="cantieri-row__caps">' +
        '<span class="cantieri-cap' + cantieriCls + '" title="Build paralleli abilitati dal livello dell\'Hangar (scafi + mercantili)">Cantieri <strong>' + cantieriUse + ' / ' + buildSlots + '</strong></span>' +
        '<span class="cantieri-cap' + portCls + '" title="Posti d\'attracco totali (attracchi + cantieri): le navi in costruzione prenotano il posto · in spedizione: ' + flying + '">Attracchi <strong>' + bound + ' / ' + docks + '</strong></span>' +
        ((F.portMaintenance && F.portMaintenance(ORION.game, colony) > 0)
          ? '<span class="cantieri-cap" title="Manutenzione/riparazione delle navi al porto: riserva + flotte ferme qui (occupare un attracco consuma metalli). Le flotte in viaggio pagano la riserva di viaggio.">Manutenzione <strong>−' + F.portMaintenance(ORION.game, colony).toFixed(2) + ' ' + resIcon('met') + '/' + iU() + '</strong></span>'
          : '') +
        ((F.portMaintenanceEn && F.portMaintenanceEn(ORION.game, colony) > 0)
          ? '<span class="cantieri-cap" title="Sistemi delle navi capitali al porto (incrociatore/dread/ammiraglia): consumano energia per i sistemi di bordo anche da fermi.">Sistemi <strong>−' + F.portMaintenanceEn(ORION.game, colony).toFixed(2) + ' ' + resIcon('en') + '/' + iU() + '</strong></span>'
          : '') +
        techHtml +
      '</div>' +
      shipReserveBox(colony, classes);
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
    /* Mercantili in costruzione (#56): condividono i cantieri dell'Hangar ma
       si avviano dalla tab Rotte. Mostrarli qui evita la dissonanza "vario un
       mercantile e non lo vedo nell'Hangar". */
    const TR = ORION.trade;
    mercQueue.forEach(function (q, idx) {
      const t = (TR && TR.getTier) ? (TR.getTier(q.tier) || {}) : {};
      const total = q.totalTime || q.duration || 1;
      const remain = Math.max(0, q.duration | 0);
      const pct = Math.round(((total - remain) / total) * 100);
      html += '<div class="struct-item is-queue">' +
        '<span class="struct-item__glyph">' + (t.glyph || '◈') + '</span>' +
        '<div class="struct-item__main">' +
          '<div class="struct-item__name">' + escapeHtml(t.name || ('Mercantile tier ' + q.tier)) + ' <span class="struct-item__cat">mercantile · ' + remain + ' / ' + total + '</span> ' + iU() + '</div>' +
          '<div class="progress-bar progress-bar--mini"><div class="progress-bar__fill" style="width:' + pct + '%"></div></div>' +
        '</div>' +
        '<button class="btn btn--mini btn--icon-only struct-item__cancel" data-cancel-merc="' + idx + '" type="button" title="Annulla (rimborso 50%)" aria-label="Annulla">' + uiIcon('close', 'pink') + '</button>' +
      '</div>';
    });

    /* Dropdown classi: opzioni disabilitate se l'Hangar non è di livello
       adeguato (M08 Fase A, decisione #42) o se manca il Bacino orbitale /
       la Nave Ammiraglia esiste già (M15). */
    const options = classes.map(function (cls) {
      const lockedByHangar = (cls.hangarLvl || 1) > hangarLvl;
      const capReason = capitalBuildBlock(colony, cls);
      let label = cls.glyph + ' ' + cls.name;
      if (lockedByHangar) label += ' — Hangar lvl ' + cls.hangarLvl;
      else if (capReason) label += ' — ' + capReason;
      const sel = (cls.id === pickedKind) ? ' selected' : '';
      const dis = (lockedByHangar || capReason) ? ' disabled' : '';
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
    /* Roster per-colonia (richiesta utente 2026-06-16): mostra SOLO gli
       equipaggi a riposo qui. Quelli imbarcati su flotta o in spedizione
       appartengono concettualmente alla flotta che li trasporta — il
       riepilogo d'impero vive nella scheda "Equipaggi" della sidebar sx +
       Roster esteso al centro. Il counter resta in `away` per il totale. */
    const away = expeditionsForColony(colony);
    const totalCrews = crews.length + away.length;
    /* Decisione utente 2026-06-11: cap addestramenti dal livello d'Accademia. */
    const academyLvl = (colony.structures['accademia-militare'].level) || 1;
    const trainSlots = E2.academyTrainSlots ? E2.academyTrainSlots(colony) : queue.length;
    const activeCrew = E2.activeCrewBuilds ? E2.activeCrewBuilds(colony) : queue.length;
    const crewCapFull = activeCrew >= trainSlots;
    const trainCls = crewCapFull ? ' is-full' : '';
    html += '<div class="cantieri-row">' +
      '<div class="cantieri-row__head">' +
        '<span class="cantieri-row__glyph ui-icon ui-icon--pink" aria-hidden="true">' + ((ORION.icon && ORION.icon('forces')) || '⚔') + '</span>' +
        '<span class="cantieri-row__name">Accademia militare <span class="cantieri-row__base">lvl ' + academyLvl + '</span></span>' +
        '<span class="cantieri-row__counter">Equipaggi: <strong>' + totalCrews + '</strong>' +
          (totalCrews ? ' <span class="xp-chip" title="Esperienza media (a riposo)">xp ' + avg + '</span>' : '') +
        '</span>' +
      '</div>' +
      '<div class="cantieri-row__caps">' +
        '<span class="cantieri-cap' + trainCls + '" title="Equipaggi in addestramento contemporaneo, abilitati dal livello dell\'Accademia">Addestramenti <strong>' + activeCrew + ' / ' + trainSlots + '</strong></span>' +
        (function () {
          /* Razioni equipaggio al porto (2026-06-15): drain cibo/acqua per crews
             idle sulla colonia. Le flotte in viaggio o ferme qui non contano:
             i loro crews mangiano dai viveri di flotta (#69). */
          const EXP = ORION.expedition;
          if (!EXP || !EXP.crewPortConsumption || colony.phase === 'settling') return '';
          const cp = EXP.crewPortConsumption(ORION.game, colony);
          if (!cp || cp.crews <= 0) return '';
          return '<span class="cantieri-cap" title="Razioni cibo/acqua per equipaggi idle sulla colonia. Gli equipaggi in missione mangiano dai viveri di flotta.">Razioni <strong>' + cp.crews + ' eq.</strong> · <strong>−' + cp.food.toFixed(2) + ' ' + resIcon('food') + '</strong> · <strong>−' + cp.water.toFixed(2) + ' ' + resIcon('water') + '</strong> / ' + iU() + '</span>';
        })() +
      '</div>';
    /* Roster per-equipaggio (richiesta utente 2026-06-16): SOLO equipaggi a
       riposo qui — quelli imbarcati o in missione appartengono concettualmente
       alla flotta che li trasporta, visibili nel Roster Equipaggi d'impero
       (sidebar sx "Equipaggi" + vista centrale espansa). */
    if (crews.length) {
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
      html += '</ul>';
      if (away.length) {
        html += '<div class="crew-roster__away-hint">' +
          '<span class="xp-chip">' + away.length + '</span> ' +
          'equipaggi originari di questa colonia ora in viaggio/missione — vedi <strong>Equipaggi</strong> (sidebar sx).' +
        '</div>';
      }
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
      '<button class="btn btn--mini" data-build-crew type="button"' +
        ((payOk && !crewCapFull) ? '' : ' disabled') +
        (crewCapFull ? ' title="Accademia satura (' + activeCrew + '/' + trainSlots + ') — potenzia l\'Accademia per addestrare più equipaggi in parallelo"' : '') +
        '>+ Equipaggio</button>' +
    '</div></div>';
  }

  html += '</div>';
  return html;
}

function tryBuildShip() {
  const g = ORION.game;
  const colony = g.colonies[ORION.openPlanetKey];
  const planet = ORION.currentPlanet;
  if (!colony || !planet) { showToast('Nessuna colonia in focus'); return; }
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
      /* Avvio costruzione scafo: rumore in cronaca — l'Hangar mostra
         già la build in coda. */
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
  if (!colony || !planet) { showToast('Nessuna colonia in focus'); return; }
  const msg = '<p>Formare un <strong>equipaggio esploratore</strong> presso l\'Accademia di <strong>' + escapeHtml(planet.name) + '</strong>?</p>';
  confirmAction({
    title: 'Formazione equipaggio',
    message: msg,
    confirmLabel: 'Forma',
    onConfirm: function () {
      const r = ORION.planet.startCrewBuild(colony, planet);
      if (!r.ok) { console.info('Formazione equipaggio rifiutata:', r.reason); showToast(r.reason); return; }
      /* Avvio formazione equipaggio: rumore in cronaca — l'Accademia
         mostra il training in coda. */
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
function tryCancelMerc(idx) {
  if (!ORION.trade) return;
  const colony = ORION.game.colonies[ORION.openPlanetKey];
  if (!colony) return;
  const r = ORION.trade.cancelMercantileBuild(colony, idx);
  if (!r.ok) { showToast(r.reason || 'Annullamento rifiutato'); return; }
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
  /* Estrattore §17.3 (richiesta utente 2026-06-16): scafo dedicato al
     drenaggio anomalie/cinture. Per le anomalie va bene anche l'esploratore
     (compat), ma l'Estrattore è la scelta consigliata. */
  const extractors = (colony.ships && colony.ships.estrattore) || 0;
  const crews = (colony.crews && colony.crews.explorer) || [];
  const xpAvg = crews.length ? ORION.expedition.averageXp(crews).toFixed(1) : '0';

  const expeditions = expeditionsForColony(colony);
  const surveys = surveysForColony(colony);
  const idleScouts = idleExplorerFleetsForColony(colony);

  /* Decisione utente 2026-06-17: il counter "X spedizioni" era ambiguo —
     non distingueva esplorazioni inter-sistema e ricognizioni anomalia
     (survey), né mostrava gli esploratori in sosta al target (move-route
     default OFF). Ora un riepilogo a 3 voci con CTA dedicate. */
  function plural(n, sing, plur) { return n === 1 ? sing : plur; }
  function partsRow(label, n, sub) {
    if (n <= 0) return '';
    return '<div class="lp-launcher lp-launcher--single">' +
      '<button class="lp-launcher__btn" data-action="exp-open-fleets" type="button">' +
        '<span class="lp-launcher__glyph ui-icon" aria-hidden="true">' + ((ORION.icon && ORION.icon('fleet')) || '') + '</span>' +
        '<span>' + escapeHtml(n + ' ' + label) + '</span>' +
        '<span class="lp-launcher__sub">' + escapeHtml(sub) + '</span>' +
      '</button>' +
    '</div>';
  }
  let listHtml = '';
  if (expeditions.length) {
    listHtml += partsRow(
      plural(expeditions.length, 'esplorazione attiva', 'esplorazioni attive'),
      expeditions.length,
      'apri Flotte e guerra · stato/usura/viveri'
    );
  }
  if (surveys.length) {
    listHtml += partsRow(
      plural(surveys.length, 'ricognizione anomalia', 'ricognizioni anomalia'),
      surveys.length,
      'flotte in raccolta sull\'anomalia · apri Flotte'
    );
  }
  if (idleScouts.length) {
    const homeSysId = colony.systemId;
    const idleHtml = idleScouts.map(function (f) {
      const atHome = f.location.systemId === homeSysId;
      const sysLbl = (g.galaxy.systems[f.location.systemId] || {}).name || '—';
      const ot = f.orders && f.orders.type;
      const otLbl = atHome ? 'all\'attracco' : (ot === 'survey' ? 'in raccolta' : 'in sosta');
      /* A casa l'azione ricuce subito (scafo+equipaggio nei counter): "Riporta
         in servizio". Remoto: ordine di rientro che viaggia fino a casa. */
      const btnLabel = atHome ? 'Riporta in servizio' : 'Richiama a base';
      const btnTitle = atHome
        ? 'Smobilita lo scout ormeggiato: scafo + equipaggio tornano subito disponibili nella colonia.'
        : 'Ordine Rientra alla base: la flotta torna qui, poi scafo + equipaggio rientrano nei conteggi della colonia.';
      return '<li class="expedition-item">' +
        '<div class="expedition-item__head">' +
          '<span class="expedition-item__status expedition-status--outbound">' + escapeHtml(f.name || 'Esploratore') + '</span>' +
          '<span class="expedition-item__target">' + escapeHtml(sysLbl) + '</span>' +
          '<span class="expedition-item__eta">' + escapeHtml(otLbl) + '</span>' +
        '</div>' +
        '<div class="expedition-item__bars">' +
          '<button class="btn btn--mini btn--primary" data-action="exp-recall" data-fleet="' + escapeHtml(f.id) + '" type="button" title="' + btnTitle + '">' + btnLabel + '</button>' +
        '</div>' +
      '</li>';
    }).join('');
    listHtml += '<p class="sysinfo__sub">Esploratori da riportare in servizio</p>' +
      '<ul class="expedition-list">' + idleHtml + '</ul>';
  }
  if (!listHtml) {
    listHtml = '<p class="panel__note">Nessuna missione attiva. Costruisci scafi e equipaggi, poi pianifica una rotta.</p>';
  }

  const canOrganize = ships >= 1 && crews.length >= 1;
  /* Decisione #76: lista target multi-hop attraverso lo spazio esplorato
     (BFS della nebbia di guerra), non più la sola adiacenza a 1 hop di M07.
     `visibleDestinations(includeDetected:true, includeExplored:false)` ritorna
     SOLO i sistemi DETECTED raggiungibili attraverso corridoi EXPLORED — la
     frontiera vera, che cresce man mano che esplori. Coerente col Fleet
     Wizard (stessa fonte). */
  const reachable = ORION.fleet.visibleDestinations(g.galaxy, g.state, colony.systemId,
    { includeDetected: true, includeExplored: false });
  const hasTargets = reachable.length > 0;

  /* Anomalie §17.3 raggiungibili (decisione di sessione: esplorazione
     interna delle anomalie dalla tab Esplorazione). Inviare una flotta che
     RESTA (ordine survey) sul sistema dell'anomalia per raccogliere/esplorare. */
  const anomalies = reachableAnomaliesFor(colony);
  let anomHtml;
  if (!ORION.anomaly) {
    anomHtml = '';
  } else if (anomalies.length) {
    anomHtml = '<ul class="expedition-list">' + anomalies.map(function (s) {
      const sys = g.galaxy.systems[s.sysId];
      const acr = regionAcronymFor(s.sysId);
      const tag = acr ? ' <span class="name-tag">[' + acr + ']</span>' : '';
      const meta = anomalyKindMeta(s.kind);
      /* Per le cinture asteroidali aggiungiamo il nome del corpo: in un
         sistema possono esserci più cinture, l'utente deve distinguerle.
         Nota: g.galaxy.systems[id] è lo stub di galassia (name/links), non
         il sistema generato — findBody ha bisogno di quest'ultimo. */
      let bodyNote = '';
      if (s.kind === 'cintura' && s.bodyKey && ORION.system && ORION.system.generate && ORION.system.findBody) {
        const sysFull = ORION.system.generate(g.galaxy, s.sysId);
        const body = sysFull ? ORION.system.findBody(sysFull, s.bodyKey) : null;
        if (body && body.name) bodyNote = ' · <span class="expedition-item__body">' + escapeHtml(body.name) + '</span>';
      }
      let stateTxt;
      if (s.kind === 'reliquie') {
        const pct = Math.round(((s.progress || 0) / (ORION.anomaly.CFG.RELIC_HOLD || 40)) * 100);
        stateTxt = 'esplorazione ' + pct + '%';
      } else {
        const pct = s.cap ? Math.round((s.reserve / s.cap) * 100) : 0;
        stateTxt = meta.res + ' · riserva ' + pct + '%';
      }
      /* Mini riepilogo del drenaggio (richiesta utente 2026-06-16): numeri
         assoluti delle risorse raccolte fino a quel momento + rate per Ι.
         Visibile per i siti harvest, solo se c'è qualcosa di rilevante. */
      let harvestTxt = '';
      if (s.kind !== 'reliquie') {
        const got = +(s.harvested || 0).toFixed(1);
        const rate = s.harvestRate != null ? s.harvestRate : 0.6;
        const resLbl = resShortLabel(s.res);
        if (s.harvesting) {
          harvestTxt = '<span class="xp-chip xp-chip--harvest" title="Risorse raccolte da questo sito · ritmo per Impulso">raccolti <strong>' + got + ' ' + resLbl + '</strong> · <strong>' + rate + '</strong>/' + iU() + '</span>';
        } else if (got > 0) {
          harvestTxt = '<span class="xp-chip" title="Risorse raccolte da questo sito (raccolta interrotta)">raccolti ' + got + ' ' + resLbl + '</span>';
        }
      }
      const here = s.sysId === colony.systemId;
      const dist = here ? 'stesso sistema' : (s.hops + ' salti');
      const canSend = (extractors >= 1 || ships >= 1) && crews.length >= 1 && !s.harvesting;
      const sendTitle = s.harvesting ? 'Una flotta è già presente sul sito'
        : (canSend
            ? (extractors >= 1
                ? 'Invia un Estrattore a drenare (resta sul posto, rate scalato sull\'Hangar)'
                : 'Invia un esploratore a drenare (rate base — costruisci un Estrattore per più resa)')
            : 'Servono uno scafo (Estrattore o esploratore) e un equipaggio');
      const bodyAttr = s.bodyKey ? (' data-body="' + escapeHtml(s.bodyKey) + '"') : '';
      return '<li class="expedition-item">' +
        '<div class="expedition-item__head">' +
          '<span class="expedition-item__status expedition-status--outbound">' + meta.label + '</span>' +
          '<span class="expedition-item__target">' + escapeHtml(sys ? sys.name : '—') + tag + bodyNote + '</span>' +
          '<span class="expedition-item__eta">' + dist + '</span>' +
        '</div>' +
        '<div class="expedition-item__bars">' +
          '<span class="xp-chip" title="Stato del sito">' + stateTxt + '</span>' +
          harvestTxt +
          (s.harvesting ? '<span class="xp-chip" title="Flotta presente">✦ in raccolta</span>' : '') +
          '<button class="btn btn--mini btn--primary" data-action="anom-send" data-sys="' + s.sysId + '" data-kind="' + s.kind + '"' + bodyAttr + ' type="button"' +
            (canSend ? '' : ' disabled') + ' title="' + sendTitle + '">Invia flotta</button>' +
        '</div>' +
      '</li>';
    }).join('') + '</ul>';
  } else {
    anomHtml = '<p class="panel__note">Nessuna anomalia nota nei sistemi esplorati raggiungibili. Esplora i sistemi vicini per scoprirne.</p>';
  }

  host.innerHTML =
    '<div class="sysinfo">' +
      '<p class="sysinfo__sub">Risorse disponibili</p>' +
      '<dl class="sysinfo__list">' +
        row('Scafi esploratori', String(ships)) +
        row('Estrattori', String(extractors)) +
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
      (ORION.anomaly ? ('<p class="sysinfo__sub">Anomalie raggiungibili</p>' + anomHtml) : '') +
      '<p class="panel__note">Costruisci scafi nell\'<em>Hangar di costruzione</em> e forma equipaggi nell\'<em>Accademia militare</em>. ' +
        'Ogni missione completata restituisce l\'equipaggio con +1 xp; gli scafi accumulano usura per Ι in viaggio e in raccolta. ' +
        'L\'<em>Estrattore</em> è dedicato al drenaggio: rate scalato sul livello dell\'Hangar (lvl1=0.6/Ι · lvl2=0.8 · lvl3=1.0 · lvl4=1.2 · lvl5=1.4). ' +
        'Le <em>anomalie §17.3</em> si sfruttano inviando una flotta che <strong>resta sul posto</strong>: ' +
        'detriti/cinture→metalli, nebulose→energia (raccolta ricorrente), reliquie→ricompensa una-tantum. ' +
        'Il rientro automatico scatta a viveri esauriti o wear ≥ 80%; riparazione al porto colonia (Hangar) o stazione orbitale lvl ≥ 2.</p>' +
    '</div>';

  const btn = host.querySelector('[data-action="exp-organize"]');
  if (btn && !btn.disabled) btn.addEventListener('click', function () { openExpeditionPicker(colony); });
  /* Link compatto al roster centrale (dedup pannello dx ↔ vista Flotte). */
  const openFleetsBtn = host.querySelector('[data-action="exp-open-fleets"]');
  if (openFleetsBtn) openFleetsBtn.addEventListener('click', function () { navigateView('fleet'); });
  host.querySelectorAll('[data-action="anom-send"]').forEach(function (b) {
    b.addEventListener('click', function () {
      openAnomalySurveyPicker(colony, Number(b.dataset.sys), b.dataset.kind, b.dataset.body || null);
    });
  });
  /* Decisione utente 2026-06-17: bottone "Richiama a base"/"Riporta in
     servizio" per gli esploratori monouso fermi (remoti in sosta o
     ormeggiati a casa ma non rifusi nei counter). Setta ordine `return`:
     se la flotta è già a casa (rotta a 0 leg) setOrder la ricuce subito
     (res.dissolved); altrimenti viaggia e si dissolve al docking. */
  host.querySelectorAll('[data-action="exp-recall"]').forEach(function (b) {
    b.addEventListener('click', function () {
      const fid = b.dataset.fleet;
      const fleet = (ORION.game.fleets || []).filter(function (f) { return f && f.id === fid; })[0];
      if (!fleet) { showToast('Flotta non trovata'); return; }
      const name = fleet.name || 'Esploratore';
      const res = ORION.fleet.setOrder(ORION.game, fleet, { type: 'return' });
      if (!res.ok) { showToast(res.reason || 'Richiamo rifiutato'); return; }
      if (res.dissolved) {
        pushChronicle(ORION.time.currentDS(ORION.game) + ' — <strong>' + escapeHtml(name) + '</strong> smobilitata: scafo ed equipaggio di nuovo disponibili sulla colonia.', 'explore');
      } else {
        pushChronicle(ORION.time.currentDS(ORION.game) + ' — <strong>' + escapeHtml(name) + '</strong> in rientro alla base.', 'explore');
      }
      persistGame(ORION.game);
      updatePlanetUI();
    });
  });
}

/* Metadati di presentazione per il tipo di anomalia (§17.3). */
function anomalyKindMeta(kind) {
  if (kind === 'detriti')  return { label: 'Campo di detriti',      res: 'metalli' };
  if (kind === 'nebulosa') return { label: 'Nebulosa',              res: 'energia' };
  if (kind === 'reliquie') return { label: 'Reliquia antica',       res: null };
  if (kind === 'cintura')  return { label: 'Cintura asteroidale',   res: 'metalli' };
  return { label: kind, res: null };
}

/* Etichetta breve della risorsa per UI "raccolti X met". */
function resShortLabel(res) {
  if (res === 'met') return 'met';
  if (res === 'en')  return 'en';
  if (res === 'food') return 'food';
  if (res === 'water') return 'water';
  return res || '';
}

/* Anomalie note (§17.3) nei sistemi ESPLORATI raggiungibili da questa
   colonia (incluso il suo stesso sistema). Registra i siti dal seed
   (deterministico, idempotente) e li ordina per distanza in salti. */
function reachableAnomaliesFor(colony) {
  const g = ORION.game;
  if (!g || !ORION.anomaly || !ORION.anomaly.ensureSites) return [];
  const D = ORION.galaxy.DISCOVERY;
  const start = colony.systemId;
  const hops = {}; hops[start] = 0;
  const queue = [start];
  while (queue.length) {
    const u = queue.shift();
    const sys = g.galaxy.systems[u];
    const links = (sys && sys.links) || [];
    for (let i = 0; i < links.length; i++) {
      const v = links[i];
      if (hops[v] != null) continue;
      if (g.state.discovery[v] < D.EXPLORED) continue;
      hops[v] = hops[u] + 1;
      queue.push(v);
    }
  }
  Object.keys(hops).forEach(function (sid) { ORION.anomaly.ensureSites(g, Number(sid)); });
  /* knownSites ritorna UN sito per (sistema, tipo) — chiave canonica in
     anomaly.js → niente doppioni. */
  const sites = ORION.anomaly.knownSites(g).filter(function (s) {
    if (hops[s.sysId] == null) return false;
    if (s.kind === 'reliquie') return !s.explored;   // esaurite: non mostrare
    return true;                                       // detriti/nebulosa: anche in rigenerazione
  });
  sites.forEach(function (s) { s.hops = hops[s.sysId]; });
  sites.sort(function (a, b) { return a.hops - b.hops; });
  return sites;
}

/* Invia una flotta di ricognizione (1 scafo + 1 equipaggio) verso il
   sistema di un'anomalia con ordine `survey`: arriva e RESTA a
   raccogliere/esplorare. Stesso pattern di doLaunchExpedition (decisione
   #60), ma l'ordine non rientra. */
function doSurveyAnomaly(colony, targetSystemId, anomalyKind, bodyKey, opts) {
  opts = opts || {};
  const g = ORION.game;
  const key = colony.systemId + ':' + colony.bodyKey;
  if (!ORION.fleet || !ORION.fleet.createFleet) { showToast('Modulo flotta non disponibile'); return; }
  const extractorsAvail = (colony.ships && colony.ships.estrattore) || 0;
  const explorersAvail  = (colony.ships && colony.ships.explorer)   || 0;
  /* Decisione utente 2026-06-17: se l'opt.shipKind è esplicito (picker),
     rispettarlo. Altrimenti preferiamo Esploratore per le reliquie (l'
     Estrattore non porta vantaggi quando anomaly.harvest=false: meglio
     tenerlo per cinture/detriti/nebulose) e Estrattore per il resto. */
  let shipKind = opts.shipKind;
  if (shipKind !== 'estrattore' && shipKind !== 'explorer') {
    if (anomalyKind === 'reliquie') {
      shipKind = explorersAvail >= 1 ? 'explorer' : (extractorsAvail >= 1 ? 'estrattore' : null);
    } else {
      shipKind = extractorsAvail >= 1 ? 'estrattore' : (explorersAvail >= 1 ? 'explorer' : null);
    }
  }
  if (shipKind === 'estrattore' && extractorsAvail < 1) {
    shipKind = explorersAvail >= 1 ? 'explorer' : null;
  }
  if (shipKind === 'explorer' && explorersAvail < 1) {
    shipKind = extractorsAvail >= 1 ? 'estrattore' : null;
  }
  const crewsAvail = (colony.crews && Array.isArray(colony.crews.explorer)) ? colony.crews.explorer.length : 0;
  if (!shipKind) { showToast('Nessuno scafo idoneo (Estrattore o Esploratore) disponibile'); return; }
  if (crewsAvail < 1) { showToast('Nessun equipaggio disponibile'); return; }
  const cf = ORION.fleet.createFleet(g, key, null);
  if (!cf.ok) { showToast(cf.reason || 'Creazione flotta fallita'); return; }
  const fleet = cf.fleet;
  const as = ORION.fleet.assignShips(g, fleet, key, shipKind, 1);
  if (!as.ok) { ORION.fleet.dissolveFleet(g, fleet); showToast(as.reason || 'Assegnazione nave fallita'); return; }
  let ac = null;
  if (opts.crewId != null && ORION.fleet.assignCrewById) {
    ac = ORION.fleet.assignCrewById(g, fleet, key, opts.crewId);
  }
  if (!ac || !ac.ok) ac = ORION.fleet.assignCrew(g, fleet, key, 1);
  if (!ac.ok) { ORION.fleet.dissolveFleet(g, fleet); showToast(ac.reason || 'Assegnazione equipaggio fallita'); return; }
  const so = ORION.fleet.setOrder(g, fleet, { type: 'survey', toSysId: targetSystemId, anomalyKind: anomalyKind || null, bodyKey: bodyKey || null });
  if (!so.ok) { ORION.fleet.dissolveFleet(g, fleet); showToast(so.reason || 'Ordine ricognizione rifiutato'); return; }
  /* Callsign d'esordio "Vedetta N". */
  maybeAutoRenameFleet(g, fleet, { type: 'survey', toSysId: targetSystemId });
  const sys = g.galaxy.systems[targetSystemId];
  const acr = regionAcronymFor(targetSystemId);
  const tag = acr ? ' <span class="name-tag">[' + acr + ']</span>' : '';
  const where = (targetSystemId === colony.systemId)
    ? 'verso l\'anomalia nel sistema'
    : 'verso l\'anomalia di <strong>' + (sys ? sys.name : 'sistema') + '</strong>' + tag;
  pushChronicle(ORION.time.currentDS(g) + ' — Flotta di ricognizione in rotta ' + where + '.', 'explore');
  if (ORION.tutorial) ORION.tutorial.fire('anomalies');
  persistGame(g);
  updatePlanetUI();
}

/* Decisione #76: stima del tempo di viaggio (sola andata) verso un sistema,
   sommando ORION.fleet.tempoLeg lungo il percorso BFS reale. minSpeed 1.1 =
   velocità della nave coloniale/esploratore "Pioniere". È un'indicazione: a
   runtime i modificatori (Comandante Navigatore, deriva viveri, iperguida)
   possono variare leggermente il valore. */
function estimateExpeditionDuration(galaxy, fromSysId, targetSysId) {
  if (!ORION.fleet || !ORION.fleet.computePath) return 0;
  const path = ORION.fleet.computePath(galaxy, fromSysId, targetSysId);
  if (!path || path.length < 2) return 0;
  let t = 0;
  for (let i = 0; i < path.length - 1; i++) {
    t += ORION.fleet.tempoLeg(galaxy, path[i], path[i + 1], 1.1);
  }
  return t;
}

function openExpeditionPicker(colony, opts) {
  opts = opts || {};
  const g = ORION.game;
  /* Decisione #76: target multi-hop attraverso lo spazio esplorato (frontiera
     DETECTED), non più solo l'adiacenza a 1 hop. Stessa fonte del Fleet Wizard. */
  const reachable = ORION.fleet.visibleDestinations(g.galaxy, g.state, colony.systemId,
    { includeDetected: true, includeExplored: false });
  const ships = (colony.ships && colony.ships.explorer) || 0;
  const crews = (colony.crews && colony.crews.explorer) || [];
  /* Equipaggi ordinati per esperienza decrescente (il veterano in testa). */
  const crewsSorted = crews.slice().sort(function (a, b) { return (b.xp || 0) - (a.xp || 0); });

  /* Decisione #76: l'utente sceglie QUALE equipaggio mandare (per esperienza),
     non più "il primo in lista". Selezione persistita tra i re-render. */
  let selectedCrewId = opts.selectedCrewId;
  if (selectedCrewId == null || !crews.some(function (c) { return c.id === selectedCrewId; })) {
    selectedCrewId = crewsSorted.length ? crewsSorted[0].id : null;
  }
  const selCrew = crews.filter(function (c) { return c.id === selectedCrewId; })[0] || null;
  const crewXp = selCrew ? (selCrew.xp || 0) : 0;
  /* Default OFF (richiesta utente 2026-06-16): la flotta resta in orbita
     al sistema esplorato. Spuntare per farla rientrare a base. */
  const returnHome = opts.returnHome === true;

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

  /* ----- Selettore equipaggio (chip cliccabili per esperienza) ----- */
  let crewChips;
  if (!crewsSorted.length) {
    crewChips = '<p class="panel__note">Nessun equipaggio disponibile: formane uno nell\'<em>Accademia militare</em>.</p>';
  } else {
    crewChips = '<div class="exp-crew-select" role="radiogroup" aria-label="Scegli equipaggio">' +
      crewsSorted.map(function (c) {
        const xp = c.xp || 0;
        const enr = ORION.expedition.enrichmentForXp(xp);
        const sel = c.id === selectedCrewId;
        return '<button class="exp-crew-chip' + (sel ? ' is-selected' : '') + '" type="button"' +
          ' role="radio" aria-checked="' + (sel ? 'true' : 'false') + '"' +
          ' data-action="exp-crew-pick" data-crew="' + escapeHtml(String(c.id)) + '"' +
          ' title="' + escapeHtml(enr.label) + ' · xp ' + xp + '">' +
          '<span class="exp-crew-chip__rank">' + escapeHtml(enr.label) + '</span>' +
          '<span class="exp-crew-chip__xp">xp ' + xp + '</span>' +
        '</button>';
      }).join('') +
    '</div>';
  }

  const cards = reachable.map(function (d) {
    const sid = d.sysId;
    const sys = g.galaxy.systems[sid];
    const acr = regionAcronymFor(sid);
    const tag = acr ? ' <span class="name-tag">[' + acr + ']</span>' : '';
    const oneWay = estimateExpeditionDuration(g.galaxy, colony.systemId, sid);
    const dur = returnHome ? oneWay * 2 : oneWay;
    const durLabel = returnHome ? (dur + ' ' + iU() + ' (a/r)') : (oneWay + ' ' + iU() + ' (sola andata)');
    const chance = ORION.expedition.accidentChance(g.galaxy, sid, crewXp, g);
    const dangerTier = sys.dangerTier || ORION.galaxy.dangerTier(sys.danger);
    return '<div class="expedition-card">' +
      '<div class="expedition-card__head">' +
        '<span class="expedition-card__name">' + escapeHtml(sys.name) + tag + '</span>' +
        '<span class="danger-badge tier--' + dangerTier + '">' + sys.danger + ' · ' + dangerTier + '</span>' +
      '</div>' +
      '<dl class="save-card__meta">' +
        '<div><dt>Distanza</dt><dd>' + d.hops + ' salti</dd></div>' +
        '<div><dt>Durata viaggio</dt><dd>' + durLabel + '</dd></div>' +
        '<div><dt>Rischio incidente</dt><dd>' + Math.round(chance * 100) + '%</dd></div>' +
      '</dl>' +
      '<div class="expedition-card__actions">' +
        '<button class="btn btn--mini btn--primary btn--with-icon" data-action="exp-launch" data-sys="' + sid + '" type="button"' +
          (selectedCrewId == null ? ' disabled title="Serve un equipaggio"' : '') + '>' +
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
        'Equipaggi: <strong>' + crews.length + '</strong>. Scegli l\'equipaggio da impegnare:</p>' +
      crewChips +
      '<label class="exp-return-opt">' +
        '<input type="checkbox" data-action="exp-return-toggle"' + (returnHome ? ' checked' : '') + '> ' +
        'Rientra alla base dopo aver esplorato' +
        '<small> (togli la spunta per restare in orbita al target)</small>' +
      '</label>' +
      '<div class="expedition-pick-overlay__grid">' + cards + '</div>' +
    '</div>';
  host.hidden = false;

  /* Stato corrente preservato tra i re-render. */
  function reopen(next) {
    openExpeditionPicker(colony, {
      selectedCrewId: (next && 'selectedCrewId' in next) ? next.selectedCrewId : selectedCrewId,
      returnHome: (next && 'returnHome' in next) ? next.returnHome : returnHome
    });
  }

  host.addEventListener('click', function (e) {
    if (e.target === host || e.target.closest('[data-action="exp-pick-close"]')) {
      closeExpeditionPicker();
    }
  });
  host.querySelectorAll('[data-action="exp-crew-pick"]').forEach(function (b) {
    b.addEventListener('click', function () { reopen({ selectedCrewId: b.dataset.crew }); });
  });
  const retToggle = host.querySelector('[data-action="exp-return-toggle"]');
  if (retToggle) retToggle.addEventListener('change', function () { reopen({ returnHome: retToggle.checked }); });
  host.querySelectorAll('[data-action="exp-launch"]').forEach(function (b) {
    if (b.disabled) return;
    b.addEventListener('click', function () {
      const sid = Number(b.dataset.sys);
      doLaunchExpedition(colony, sid, { returnHome: returnHome, crewId: selectedCrewId });
    });
  });
}

function closeExpeditionPicker() {
  const host = document.querySelector('[data-bind="exp-picker"]');
  if (host) { host.hidden = true; host.innerHTML = ''; }
}

/* Picker per "Invia flotta" su anomalia (decisione utente 2026-06-17):
   prima era un quick-action che usava primo scafo idoneo + primo
   equipaggio in lista, senza scelta. Disallineato dal picker spedizione
   e fastidioso quando si vuole mandare un equipaggio specifico a una
   reliquia. Apriamo un dialog con stessa estetica del picker spedizione:
   scelta scafo (Estrattore/Esploratore) + scelta equipaggio (chip per xp).
   Per le reliquie il default è Esploratore (sull'anomalia.harvest=false
   l'Estrattore non aggiunge nulla: meglio tenerlo per le miniere vere). */
function openAnomalySurveyPicker(colony, targetSystemId, anomalyKind, bodyKey, opts) {
  opts = opts || {};
  const g = ORION.game;
  const extractors = (colony.ships && colony.ships.estrattore) || 0;
  const explorers  = (colony.ships && colony.ships.explorer)   || 0;
  const crews = (colony.crews && colony.crews.explorer) || [];
  const crewsSorted = crews.slice().sort(function (a, b) { return (b.xp || 0) - (a.xp || 0); });

  /* Default scafo: reliquie → esploratore (estrattore non porta vantaggi
     sui siti relic), altrimenti estrattore (rate scalato sull'Hangar).
     Fallback all'unico disponibile. */
  const isRelic = anomalyKind === 'reliquie';
  let defaultKind;
  if (extractors >= 1 && explorers >= 1) {
    defaultKind = isRelic ? 'explorer' : 'estrattore';
  } else if (extractors >= 1) {
    defaultKind = 'estrattore';
  } else if (explorers >= 1) {
    defaultKind = 'explorer';
  } else {
    defaultKind = null;
  }
  let selectedKind = opts.shipKind;
  if (selectedKind !== 'estrattore' && selectedKind !== 'explorer') selectedKind = defaultKind;
  if (selectedKind === 'estrattore' && extractors < 1) selectedKind = explorers >= 1 ? 'explorer' : null;
  if (selectedKind === 'explorer'   && explorers   < 1) selectedKind = extractors >= 1 ? 'estrattore' : null;

  let selectedCrewId = opts.selectedCrewId;
  if (selectedCrewId == null || !crews.some(function (c) { return c.id === selectedCrewId; })) {
    selectedCrewId = crewsSorted.length ? crewsSorted[0].id : null;
  }

  let host = document.querySelector('[data-bind="anom-picker"]');
  if (!host) {
    host = document.createElement('div');
    host.className = 'expedition-pick-overlay';
    host.setAttribute('data-bind', 'anom-picker');
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-modal', 'true');
    host.setAttribute('aria-label', 'Invia flotta su anomalia');
    document.body.appendChild(host);
  }

  const meta = anomalyKindMeta(anomalyKind);
  const sys = g.galaxy.systems[targetSystemId];
  const acr = regionAcronymFor(targetSystemId);
  const tag = acr ? ' <span class="name-tag">[' + acr + ']</span>' : '';

  /* Chip selettore tipo scafo. */
  function shipChip(kind, label, sub, count, disabled) {
    const sel = selectedKind === kind;
    return '<button class="exp-crew-chip' + (sel ? ' is-selected' : '') + '" type="button"' +
      ' role="radio" aria-checked="' + (sel ? 'true' : 'false') + '"' +
      ' data-action="anom-ship-pick" data-kind="' + escapeHtml(kind) + '"' +
      (disabled ? ' disabled title="Nessuno disponibile"' : ' title="' + escapeHtml(sub) + '"') + '>' +
      '<span class="exp-crew-chip__rank">' + escapeHtml(label) + '</span>' +
      '<span class="exp-crew-chip__xp">' + count + ' disp.</span>' +
    '</button>';
  }
  const shipChips = '<div class="exp-crew-select" role="radiogroup" aria-label="Scegli scafo">' +
    shipChip('estrattore', 'Estrattore', 'rate scalato sull\'Hangar — consigliato per harvest', extractors, extractors < 1) +
    shipChip('explorer',   'Esploratore', 'rate base, niente bonus harvest', explorers, explorers < 1) +
  '</div>';

  let crewChips;
  if (!crewsSorted.length) {
    crewChips = '<p class="panel__note">Nessun equipaggio disponibile: formane uno nell\'<em>Accademia militare</em>.</p>';
  } else {
    crewChips = '<div class="exp-crew-select" role="radiogroup" aria-label="Scegli equipaggio">' +
      crewsSorted.map(function (c) {
        const xp = c.xp || 0;
        const enr = ORION.expedition.enrichmentForXp(xp);
        const sel = c.id === selectedCrewId;
        return '<button class="exp-crew-chip' + (sel ? ' is-selected' : '') + '" type="button"' +
          ' role="radio" aria-checked="' + (sel ? 'true' : 'false') + '"' +
          ' data-action="anom-crew-pick" data-crew="' + escapeHtml(String(c.id)) + '"' +
          ' title="' + escapeHtml(enr.label) + ' · xp ' + xp + '">' +
          '<span class="exp-crew-chip__rank">' + escapeHtml(enr.label) + '</span>' +
          '<span class="exp-crew-chip__xp">xp ' + xp + '</span>' +
        '</button>';
      }).join('') +
    '</div>';
  }

  const canSend = selectedKind != null && selectedCrewId != null;
  const sendTitle = !selectedKind ? 'Nessuno scafo idoneo disponibile'
    : !selectedCrewId ? 'Serve un equipaggio'
    : 'Invia la flotta sul sito (resta in raccolta finché non la richiami)';

  host.innerHTML =
    '<div class="expedition-pick-overlay__panel" role="document">' +
      '<header class="expedition-pick-overlay__head">' +
        '<h2 class="expedition-pick-overlay__title">Invia flotta su anomalia</h2>' +
        '<button class="btn btn--mini btn--icon-only" data-action="anom-pick-close" type="button" aria-label="Chiudi">' +
          '<span class="ui-icon" aria-hidden="true">' + ((ORION.icon && ORION.icon('close')) || '✕') + '</span>' +
        '</button>' +
      '</header>' +
      '<p class="panel__note">' + escapeHtml(meta.label) + ' nel sistema <strong>' + (sys ? escapeHtml(sys.name) : '—') + '</strong>' + tag + '.</p>' +
      '<p class="sysinfo__sub">Scafo</p>' +
      shipChips +
      '<p class="sysinfo__sub">Equipaggio</p>' +
      crewChips +
      '<div class="expedition-card__actions" style="margin-top:12px">' +
        '<button class="btn btn--mini btn--primary btn--with-icon" data-action="anom-launch" type="button"' +
          (canSend ? '' : ' disabled') + ' title="' + escapeHtml(sendTitle) + '">' +
          '<span class="ui-icon" aria-hidden="true">' + ((ORION.icon && ORION.icon('send')) || '') + '</span> Invia flotta' +
        '</button>' +
      '</div>' +
    '</div>';
  host.hidden = false;

  function reopen(next) {
    openAnomalySurveyPicker(colony, targetSystemId, anomalyKind, bodyKey, {
      shipKind: (next && 'shipKind' in next) ? next.shipKind : selectedKind,
      selectedCrewId: (next && 'selectedCrewId' in next) ? next.selectedCrewId : selectedCrewId
    });
  }

  host.addEventListener('click', function (e) {
    if (e.target === host || e.target.closest('[data-action="anom-pick-close"]')) {
      closeAnomalySurveyPicker();
    }
  });
  host.querySelectorAll('[data-action="anom-ship-pick"]').forEach(function (b) {
    if (b.disabled) return;
    b.addEventListener('click', function () { reopen({ shipKind: b.dataset.kind }); });
  });
  host.querySelectorAll('[data-action="anom-crew-pick"]').forEach(function (b) {
    b.addEventListener('click', function () { reopen({ selectedCrewId: b.dataset.crew }); });
  });
  const launchBtn = host.querySelector('[data-action="anom-launch"]');
  if (launchBtn && !launchBtn.disabled) {
    launchBtn.addEventListener('click', function () {
      doSurveyAnomaly(colony, targetSystemId, anomalyKind, bodyKey, {
        shipKind: selectedKind, crewId: selectedCrewId
      });
      closeAnomalySurveyPicker();
    });
  }
}

function closeAnomalySurveyPicker() {
  const host = document.querySelector('[data-bind="anom-picker"]');
  if (host) { host.hidden = true; host.innerHTML = ''; }
}

function doLaunchExpedition(colony, targetSystemId, opts) {
  opts = opts || {};
  const returnHome = opts.returnHome === true;    // default OFF (richiesta utente 2026-06-17)
  const g = ORION.game;
  const key = colony.systemId + ':' + colony.bodyKey;
  /* Decisione #60: lancio come flotta con ordine explore (sostituisce
     ORION.expedition.launch). Crea una flotta dedicata, assegna 1 scafo
     esploratore e l'equipaggio SCELTO (#76), poi setOrder. */
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
  /* Crea flotta + assegna 1 scafo + l'equipaggio scelto (per id, #76);
     fallback al primo in lista se l'id non è indicato/non più disponibile. */
  /* Niente nome esplicito: lo riceverà al setOrder('explore') come
     callsign progressivo "Segugio N" (decisione utente 2026-06-15). */
  const cf = ORION.fleet.createFleet(g, key, null);
  if (!cf.ok) { showToast(cf.reason || 'Creazione flotta fallita'); return; }
  const fleet = cf.fleet;
  const as = ORION.fleet.assignShips(g, fleet, key, 'explorer', 1);
  if (!as.ok) { ORION.fleet.dissolveFleet(g, fleet); showToast(as.reason || 'Assegnazione nave fallita'); return; }
  let ac = null;
  if (opts.crewId != null && ORION.fleet.assignCrewById) {
    ac = ORION.fleet.assignCrewById(g, fleet, key, opts.crewId);
  }
  if (!ac || !ac.ok) ac = ORION.fleet.assignCrew(g, fleet, key, 1);
  if (!ac.ok) { ORION.fleet.dissolveFleet(g, fleet); showToast(ac.reason || 'Assegnazione equipaggio fallita'); return; }
  /* returnHome ON → ordine explore (auto-return). OFF → move-route con la
     singola tappa + exploreEach=true + returnHome=false: rivela il target e
     RESTA in orbita. Stesso pattern del Fleet Wizard (#46/#76). */
  const order = returnHome
    ? { type: 'explore', toSysId: targetSystemId }
    : { type: 'move-route', waypoints: [targetSystemId], dwell: [0], exploreEach: true, returnHome: false };
  const so = ORION.fleet.setOrder(g, fleet, order);
  if (!so.ok) { ORION.fleet.dissolveFleet(g, fleet); showToast(so.reason || 'Ordine esplorazione rifiutato'); return; }
  /* Callsign d'esordio "Segugio N". */
  maybeAutoRenameFleet(g, fleet, order);
  const sys = g.galaxy.systems[targetSystemId];
  const acr = regionAcronymFor(targetSystemId);
  const tag = acr ? ' <span class="name-tag">[' + acr + ']</span>' : '';
  const enr = ORION.expedition.enrichmentForXp((fleet.crew[0] && fleet.crew[0].xp) || 0);
  pushChronicle(ORION.time.currentDS(g) + ' — Spedizione partita verso <strong>' +
    (sys ? sys.name : 'sistema ignoto') + '</strong>' + tag +
    ' · equipaggio ' + enr.label +
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
  return { met: 'metalli', en: 'energia', food: 'cibo', water: 'acqua', waste: 'rifiuti ♻' }[k] || k;
}
function tradeRouteStatusMeta(status) {
  if (status === 'interrupted-source') return { label: 'sorgente esaurita', cls: 'warn' };
  if (status === 'interrupted-route')  return { label: 'rotta ostile', cls: 'crit' };
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
      /* Modifica inline del flusso (solo rotte uscenti): slider 1..cargo. */
      let rateCtrl = '<span class="route-item__res">' + resIcon(r.resource) + ' ' + r.rate + '/' + iU() + '</span>';
      if (outbound) {
        const oMerc = T.findMercantile(colony, r.mercId);
        const oMax = oMerc ? T.mercantileCargo(oMerc) : r.rate;
        rateCtrl = '<span class="route-item__res">' + resIcon(r.resource) +
          ' <input type="range" class="route-item__rate-input" min="1" max="' + oMax + '" step="0.5" value="' + r.rate + '" data-action="route-rate" data-rid="' + r.id + '" title="Flusso per Impulso (max cargo ' + oMax + ')">' +
          ' <strong data-rate-out="' + r.id + '">' + r.rate + '</strong>/' + iU() + '</span>';
      }
      return '<li class="route-item">' +
        '<div class="route-item__head">' +
          '<span class="route-item__dir">' + dir + '</span>' +
          '<span class="route-item__peer">' + colonyNameFromKey(otherKey) + '</span>' +
          rateCtrl +
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
  host.querySelectorAll('[data-action="route-rate"]').forEach(function (s) {
    s.addEventListener('input', function () {
      const out = host.querySelector('[data-rate-out="' + s.dataset.rid + '"]');
      if (out) out.textContent = String(parseFloat(s.value) || 1);
    });
    s.addEventListener('change', function () { doSetRouteRate(s.dataset.rid, parseFloat(s.value) || 1); });
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
  if (!g) return 'commercio';
  const routes = (ORION.trade && ORION.trade.routesUsed(g)) || 0;
  const held = (ORION.treasury && ORION.treasury.heldCurrencies(g)) || [];
  const parts = [];
  if (routes > 0) parts.push(routes + ' rotte');
  if (held.length > 0) parts.push(held.length + (held.length === 1 ? ' valuta' : ' valute'));
  return parts.length ? parts.join(' · ') : 'nessuna rotta';
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

/* Modifica del flusso (rate Z) di una rotta attiva. Niente confirm: è una
   leva da regolare al volo secondo i bisogni (decisione utente 2026-06-15).
   Il motore (setRouteRate) clampa a [1, cargo del mercantile]. */
function doSetRouteRate(routeId, rate) {
  const g = ORION.game;
  const r = ORION.trade.setRouteRate(g, routeId, rate);
  if (!r.ok) { showToast(r.reason || 'Rate rifiutato'); return; }
  persistGame(g);
  updatePlanetUI();
  if (ORION._currentView === 'market') renderView(document.querySelector('[data-view-stage]'), 'market');
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
  let rate = null;   /* null = usa il massimo del cargo del mercantile */

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
      /* hops === 0 = colonia nello stesso sistema (intra-sistema): rotta
         legittima e a costo nullo. Solo hops < 0 = irraggiungibile. */
      return hops >= 0 && hops <= maxHops;
    });
  }

  function render() {
    const merc = T.findMercantile(colony, mercId);
    const maxRate = merc ? T.mercantileCargo(merc) : 1;
    /* rate scelto dall'utente, default = cargo max; clampato al cargo corrente. */
    const curRate = Math.max(1, Math.min(rate == null ? maxRate : rate, maxRate));
    const dests = destinations();
    const mercOpts = idle.map(function (m) {
      const t = T.getTier(m.tier) || {};
      return '<option value="' + m.id + '"' + (m.id === mercId ? ' selected' : '') + '>' +
        escapeHtml(t.name || ('Tier ' + m.tier)) + ' · ' + T.rankLabel(m.xp) + ' · cargo ' + T.mercantileCargo(m) + ' · ' + T.mercantileMaxHops(m) + ' salti</option>';
    }).join('');
    const resList = T.ROUTE_RESOURCES || T.TRADE_RESOURCES;
    const resOpts = resList.map(function (k) {
      return '<option value="' + k + '"' + (k === resource ? ' selected' : '') + '>' + tradeResLabel(k) + '</option>';
    }).join('');
    const stockOf = function (c, res) {
      if (res === 'waste') return c.waste ? Math.round(c.waste.stock || 0) : 0;
      return c.stock ? Math.round(c.stock[res] || 0) : 0;
    };
    const destCards = dests.length ? dests.map(function (k) {
      const hops = T.routeHopCount(g, srcKey, k);
      const c = g.colonies[k];
      const stock = stockOf(c, resource);
      return '<div class="route-dest-card">' +
        '<div class="route-dest-card__head">' +
          '<span class="route-dest-card__name">' + colonyNameFromKey(k) + '</span>' +
          '<span class="route-dest-card__hops">' + (hops === 0 ? 'stesso sistema' : (hops + ' salti')) + '</span>' +
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
          '<label class="route-picker__field route-picker__field--rate">Flusso: ' +
            '<input type="range" min="1" max="' + maxRate + '" step="0.5" value="' + curRate + '" data-bind="route-rate">' +
            '<strong data-bind="route-rate-out">' + curRate + '</strong> / ' + iU() +
          '</label>' +
        '</div>' +
        '<div class="expedition-pick-overlay__grid">' + destCards + '</div>' +
        '<p class="panel__note">Imposta il flusso per Impulso (max = cargo del mercantile ' + maxRate + '/' + iU() + '; per andare oltre serve un mercantile di livello superiore). Regolabile anche dopo, dalla rotta attiva. Si interrompe da solo se la sorgente esaurisce la risorsa o se il throughput del Mercato è saturo.</p>' +
      '</div>';

    host.querySelector('[data-bind="route-merc"]').addEventListener('change', function () {
      mercId = this.value; rate = null; render();   /* nuovo cargo → ricalibra default */
    });
    host.querySelector('[data-bind="route-res"]').addEventListener('change', function () {
      resource = this.value; render();
    });
    const rateInp = host.querySelector('[data-bind="route-rate"]');
    if (rateInp) rateInp.addEventListener('input', function () {
      rate = parseFloat(this.value) || 1;
      const outEl = host.querySelector('[data-bind="route-rate-out"]');
      if (outEl) outEl.textContent = String(rate);
    });
    host.querySelectorAll('[data-action="route-do"]').forEach(function (b) {
      b.addEventListener('click', function () { doCreateRoute(srcKey, b.dataset.dst, resource, mercId, curRate); });
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
function doCreateRoute(srcKey, dstKey, resource, mercId, rate) {
  const g = ORION.game;
  const r = ORION.trade.createRoute(g, srcKey, dstKey, resource, (rate != null ? rate : null), mercId);
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
/* Dashboard "Destino" — visuale riepilogativa delle 7 piste di vittoria
   (decisione #23 esteso). Soglie PROVVISORIE da victory.js (M20/GDD §16 le
   calibreranno). Le piste girano tutte in parallelo: vince chi chiude per
   prima. Il "focus" è solo enfasi narrativa, mutabile e senza lock. */
function renderDestinyView(stage) {
  if (!stage) return;
  const g = ORION.game;
  const V = ORION.victory;
  if (!g || !V || !V.progress) return;

  const rows = V.progress(g);
  const focus = V.getFocus ? V.getFocus(g) : null;
  const fmt = (ORION.format && ORION.format.compact)
    ? ORION.format.compact
    : function (n) { return String(Math.round(n)); };

  const cardsHtml = rows.map(function (r) {
    const pct = Math.max(0, Math.min(100, Math.round(r.score * 100)));
    const isFocus = (r.track === focus);
    const won = r.won;
    const icon = (ORION.icon && ORION.icon(r.icon)) || '';
    const barCls = won ? 'is-won' : (isFocus ? 'is-focus' : '');
    const focusBtn = isFocus
      ? '<button class="btn btn--mini" data-action="destiny-focus" data-track="" type="button">Togli focus</button>'
      : '<button class="btn btn--mini btn--enter" data-action="destiny-focus" data-track="' + r.track + '" type="button">Punta a questo</button>';
    return '<li class="destiny-card' + (isFocus ? ' is-focus' : '') + (won ? ' is-won' : '') + '">' +
      '<div class="destiny-card__head">' +
        '<span class="destiny-card__icon ui-icon" aria-hidden="true">' + icon + '</span>' +
        '<span class="destiny-card__title">' + escapeHtml(r.label) +
          (isFocus ? ' <span class="destiny-card__flag">focus</span>' : '') + '</span>' +
        '<span class="destiny-card__pct">' + pct + '%</span>' +
      '</div>' +
      '<div class="destiny-bar"><span class="destiny-bar__fill ' + barCls + '" style="width:' + pct + '%"></span></div>' +
      '<div class="destiny-card__metric">' + escapeHtml(r.metric) + ': <strong>' +
        fmt(r.cur) + '</strong> / ' + fmt(r.goal) + '</div>' +
      '<p class="destiny-card__hint">' + escapeHtml(r.hint) + '</p>' +
      '<div class="destiny-card__foot">' + focusBtn + '</div>' +
    '</li>';
  }).join('');

  const focusLabel = focus ? (V.TRACK_LABELS[focus] || focus) : null;
  const bannerHtml = focus
    ? '<div class="destiny-banner is-set">Ambizione dichiarata: <strong>' + escapeHtml(focusLabel) + '</strong>' +
        ' <button class="btn btn--mini" data-action="destiny-focus" data-track="" type="button">Annulla</button></div>'
    : '<div class="destiny-banner">Nessuna ambizione dichiarata — esplora, e decidi a cosa puntare strada facendo.</div>';

  stage.innerHTML =
    '<div class="fleet-view destiny-view">' +
      '<header class="fleet-view__head">' +
        '<h2 class="fleet-view__title">Destino <span class="fleet-view__sub">7 vie alla vittoria</span></h2>' +
      '</header>' +
      bannerHtml +
      '<p class="panel__note">Tutte le vie corrono in parallelo: vince chi chiude per prima una qualsiasi soglia. ' +
        'Dichiarare un <em>focus</em> non blocca nulla — è solo l’ambizione del tuo popolo, e puoi cambiarla quando vuoi. ' +
        '<em>Soglie provvisorie</em> (in calibrazione).</p>' +
      '<ul class="destiny-grid">' + cardsHtml + '</ul>' +
    '</div>';

  stage.querySelectorAll('[data-action="destiny-focus"]').forEach(function (b) {
    b.addEventListener('click', function () {
      const track = b.dataset.track || null;
      const prev = V.getFocus(g);
      if (track === prev) return;
      V.setFocus(g, track);
      if (track) {
        pushChronicle('Il tuo popolo vede in te <strong>' + escapeHtml(V.TRACK_LABELS[track] || track) + '</strong>.', 'system');
      } else if (prev) {
        pushChronicle('Il tuo popolo ricalibra le proprie ambizioni.', 'system');
      }
      persistGame(g);
      renderDestinyView(stage);
      renderLeftPanel();
    });
  });
}

/* M13 Fase A (decisione #57): vista "Ricerca". Pool d'impero distribuito,
   1 progetto attivo; albero dei 5 punti fermi raggruppato per categoria §11.2.
   I rami nascosti (§11.1) compaiono solo quando i prereq sono sbloccati. */
function renderResearchView(stage) {
  if (!stage) return;
  const g = ORION.game;
  const R = ORION.research;
  if (!g || !R) return;
  R.ensure(g);
  if (ORION.tutorial) ORION.tutorial.fire('research-overview');

  const cat = R.catalogFor(g);
  const rate = (g.research._lastRate && g.research._lastRate > 0) ? g.research._lastRate : R.empireResearchRate(g);
  const total = Math.round(R.empireResearchTotal(g));
  const unlocked = g.research.unlocked.length;

  /* ----- bonus passivi attivi (Fase B): rende visibili i modificatori ----- */
  let bonusHtml = '';
  if (R.mods) {
    const m = R.mods(g);
    const chips = [];
    const pct = function (v) { return '+' + Math.round((v - 1) * 100) + '%'; };
    if (m.extractionMul > 1) chips.push(pct(m.extractionMul) + ' estrazione');
    if (m.buildSpeedMul > 1) chips.push(pct(m.buildSpeedMul) + ' costruzione');
    if (m.researchMul > 1) chips.push(pct(m.researchMul) + ' ricerca');
    if (m.fpMul > 1) chips.push(pct(m.fpMul) + ' fuoco navi');
    if (m.hpMul > 1) chips.push(pct(m.hpMul) + ' corazza navi');
    if (m.popGrowthMul > 1) chips.push(pct(m.popGrowthMul) + ' crescita pop');
    if (m.cargoMul > 1) chips.push(pct(m.cargoMul) + ' cargo rotte');
    if (m.hopBonus > 0) chips.push('+' + m.hopBonus + ' raggio rotte');
    const hyper = R.hyperMul(g);
    if (hyper < 1) chips.push('viaggi ×' + (Math.round(1 / hyper) === 3 ? '⅓' : ('1/' + Math.round(1 / hyper))));
    if (chips.length) {
      bonusHtml = '<p class="sysinfo__sub">Bonus passivi attivi</p><div class="res-bonuses">' +
        chips.map(function (c) { return '<span class="res-bonus">' + escapeHtml(c) + '</span>'; }).join('') + '</div>';
    }
  }

  /* ----- progetto attivo ----- */
  let activeHtml;
  if (g.research.activeProject) {
    const t = R.get(g.research.activeProject);
    const prog = g.research.progress || 0;
    const pct = t ? Math.max(0, Math.min(100, Math.round(prog / t.cost * 100))) : 0;
    const eta = R.etaImpulsi(g);
    activeHtml =
      '<div class="res-active">' +
        '<div class="res-active__head">' +
          '<span class="res-active__name">' + escapeHtml(t ? t.name : g.research.activeProject) + '</span>' +
          '<span class="res-active__eta">' + (eta > 0 ? ('completa in ~' + eta + ' ' + iU()) : 'in attesa di ricerca') + '</span>' +
        '</div>' +
        '<div class="res-bar"><div class="res-bar__fill" style="width:' + pct + '%"></div></div>' +
        '<div class="res-active__foot">' +
          '<span class="res-active__prog">' + Math.round(prog) + ' / ' + (t ? t.cost : '?') + ' punti</span>' +
          '<button class="btn btn--mini btn--danger" data-action="research-cancel" type="button">Annulla progetto</button>' +
        '</div>' +
      '</div>';
  } else {
    activeHtml = '<p class="panel__note">Nessun progetto attivo. Scegli una tecnologia da ricercare qui sotto: i laboratori di tutto l\'impero la finanziano insieme.</p>';
  }

  /* ----- albero per categoria (solo tech visibili §11.1) ----- */
  const cats = Object.keys(R.CATEGORIES);
  let treeHtml = '';
  cats.forEach(function (cid) {
    const items = cat.filter(function (t) { return t.cat === cid && t.visible; });
    if (!items.length) return;
    treeHtml += '<p class="sysinfo__sub">' + escapeHtml(R.CATEGORIES[cid]) + '</p>';
    treeHtml += '<ul class="res-list">' + items.map(function (t) {
      let chip, action = '';
      if (t.status === 'unlocked') {
        chip = '<span class="res-chip res-chip--ok">✓ sbloccata</span>';
      } else if (t.status === 'active') {
        chip = '<span class="res-chip res-chip--active">in ricerca</span>';
      } else if (t.status === 'available') {
        chip = '<span class="res-chip res-chip--avail">' + t.cost + ' punti</span>';
        action = '<button class="btn btn--mini btn--enter" data-action="research-pick" data-id="' + t.id + '" type="button">Ricerca</button>';
      } else { /* locked */
        const cr = R.canResearch(g, t.id);
        chip = '<span class="res-chip res-chip--lock" title="' + escapeHtml(cr.reason || '') + '">bloccata</span>';
      }
      const gc = t.gameChanger ? '<span class="res-gc" title="Game-changer">★</span>' : '';
      let meta = '';
      if (t.requires.length) {
        meta += '<span class="res-meta">richiede ' + t.requires.map(function (rq) {
          return escapeHtml((R.get(rq) || { name: rq }).name);
        }).join(', ') + '</span>';
      }
      if (t.gameChanger) {
        const acParts = t.activationCost ? Object.keys(t.activationCost).map(function (k) {
          return resIcon(k) + ' ' + t.activationCost[k];
        }).join(' ') : '';
        meta += '<span class="res-meta">ricerca d\'impero ≥ ' + t.minResearch + (acParts ? (' · attivazione ' + acParts) : '') + '</span>';
      }
      return '<li class="res-item res-item--' + t.status + '">' +
        '<div class="res-item__head">' +
          '<span class="res-item__name">' + gc + escapeHtml(t.name) + '</span>' + chip +
        '</div>' +
        '<p class="res-item__desc">' + escapeHtml(t.desc) + '</p>' +
        (meta ? '<div class="res-item__meta">' + meta + '</div>' : '') +
        (action ? '<div class="res-item__action">' + action + '</div>' : '') +
      '</li>';
    }).join('') + '</ul>';
  });

  stage.innerHTML =
    '<div class="fleet-view research-view">' +
      '<header class="fleet-view__head">' +
        '<h2 class="fleet-view__title">Ricerca <span class="fleet-view__sub">M13 · Tecnologia</span></h2>' +
      '</header>' +
      '<div class="market-summary">' +
        '<div class="market-summary__cell"><span class="market-summary__val">' + (Math.round(rate * 10) / 10) + '</span><span class="market-summary__lbl">Ricerca / ' + iU() + '</span></div>' +
        '<div class="market-summary__cell"><span class="market-summary__val">' + total + '</span><span class="market-summary__lbl">Ricerca d\'impero</span></div>' +
        '<div class="market-summary__cell"><span class="market-summary__val">' + unlocked + ' / ' + cat.length + '</span><span class="market-summary__lbl">Tech sbloccate</span></div>' +
      '</div>' +
      bonusHtml +
      '<p class="sysinfo__sub">Progetto attivo</p>' +
      activeHtml +
      treeHtml +
      '<p class="panel__note">I <em>laboratori</em> §10 di tutte le colonie alimentano un <em>pool d\'impero</em> unico: un progetto alla volta. Costruire più laboratori accelera ogni ricerca. Alcune tecnologie restano nascoste finché non sblocchi il prerequisito.</p>' +
    '</div>';

  /* ----- handlers ----- */
  stage.querySelectorAll('[data-action="research-pick"]').forEach(function (b) {
    b.addEventListener('click', function () {
      const r = ORION.research.setProject(g, b.dataset.id);
      if (!r.ok) { showToast(r.reason || 'Ricerca non disponibile'); return; }
      if (ORION.tutorial) ORION.tutorial.fire('research-tree');
      persistGame(g);
      renderResearchView(stage);
    });
  });
  const cancelBtn = stage.querySelector('[data-action="research-cancel"]');
  if (cancelBtn) cancelBtn.addEventListener('click', function () {
    ORION.research.clearProject(g);
    persistGame(g);
    renderResearchView(stage);
  });
}

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

/* =====================================================================
   M16 (decisione #81) — Vista "Stazioni" spaziali.
   ===================================================================== */
function stationLauncherSub() {
  const g = ORION.game, ST = ORION.station;
  if (!g || !ST) return 'M16';
  const list = ST.listOf(g);
  if (!list.length) return 'nessuna';
  const building = list.filter(function (s) { return s.phase === 'building'; }).length;
  return list.length + (building ? (' · ' + building + ' in opera') : '');
}

function stationSupplyMeta(state) {
  if (state === 'isolated') return { cls: 'crit', label: 'isolata' };
  if (state === 'low') return { cls: 'warn', label: 'a corto' };
  return { cls: 'ok', label: 'rifornita' };
}

function renderStationsView(stage) {
  if (!stage) return;
  const g = ORION.game, ST = ORION.station;
  if (!g || !ST) return;
  if (ORION.tutorial) ORION.tutorial.fire('stations');

  const list = ST.listOf(g);
  const operational = list.filter(function (s) { return s.phase === 'operational'; }).length;
  const building = list.filter(function (s) { return s.phase === 'building'; }).length;

  function sysTag(id) { return systemTagHtml(id); }
  function sysName(id) { const s = g.galaxy.systems[id]; return s ? s.name : '—'; }

  let listHtml;
  if (list.length) {
    listHtml = '<ul class="station-list">' + list.map(function (st) {
      const lvl = Math.max(0, st.level);
      const cap = ST.supplyCap(Math.max(1, lvl));
      const supFrac = cap > 0 ? Math.max(0, Math.min(1, (st.supply || 0) / cap)) : 0;
      const sup = stationSupplyMeta(st.supplyState);
      const def = ST.defenseStats(st);
      const hpFrac = def.maxHp > 0 ? Math.max(0, Math.min(1, def.hp / def.maxHp)) : 0;

      let body;
      if (!ST.isPlayerStation(st)) {
        /* M16 Fase B (#81): stazione catturata — presidio nemico riconquistabile. */
        const civ = (g.civs || []).filter(function (c) { return c.id === st.owner; })[0];
        body = '<div class="station-captured-note">⚠ <strong>Catturata</strong>' +
          (civ ? (' da ' + escapeHtml(civ.name)) : '') +
          ' — invia una flotta armata e usa <em>Attacca</em> sul sistema per riprenderla.</div>';
      } else if (st.phase === 'building') {
        const prog = st.buildTotal > 0 ? Math.max(0, Math.min(1, 1 - (st.buildLeft || 0) / st.buildTotal)) : 0;
        const verb = (st.level === 0) ? 'Costruzione' : 'Potenziamento a lvl ' + (st.level + 1);
        body =
          '<div class="station-build">' + verb + ' · ' + Math.ceil(st.buildLeft || 0) + ' ' + iU() + ' rimanenti' +
            '<div class="station-bar"><div class="station-bar__fill station-bar__fill--build" style="width:' + Math.round(prog * 100) + '%"></div></div>' +
          '</div>' +
          '<button class="btn btn--mini btn--danger" data-action="station-cancel" data-id="' + st.id + '" type="button">Annulla</button>';
      } else {
        const upg = ST.canUpgrade(g, st);
        const upgBtn = (st.level >= ST.CFG.MAX_LEVEL)
          ? '<span class="station-maxed">livello massimo</span>'
          : '<button class="btn btn--mini btn--enter" data-action="station-upgrade" data-id="' + st.id + '"' +
              (upg.ok ? '' : ' disabled') + ' type="button" title="' + (upg.ok ? ('Costo ' + stationCostStr(upg.cost) + ' · ' + upg.time + ' ' + iU()) : escapeHtml(upg.reason || '')) + '">+ Espandi</button>';
        body =
          '<div class="station-stats">' +
            '<div class="station-stat">' +
              '<span class="station-stat__lbl">Serbatoio</span>' +
              '<div class="station-bar"><div class="station-bar__fill station-bar__fill--' + sup.cls + '" style="width:' + Math.round(supFrac * 100) + '%"></div></div>' +
              '<span class="station-stat__val is-' + sup.cls + '">' + Math.round(st.supply || 0) + ' / ' + cap + ' · ' + sup.label + '</span>' +
            '</div>' +
            '<div class="station-stat">' +
              '<span class="station-stat__lbl">Corazza</span>' +
              '<div class="station-bar"><div class="station-bar__fill station-bar__fill--hp" style="width:' + Math.round(hpFrac * 100) + '%"></div></div>' +
              '<span class="station-stat__val">' + def.hp + ' / ' + def.maxHp + ' · ⚔ ' + def.fp + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="station-actions">' + upgBtn +
            '<button class="btn btn--mini btn--danger" data-action="station-demolish" data-id="' + st.id + '" type="button">Smantella</button>' +
          '</div>' +
          stationYardHtml(st);
      }

      const capturedCls = ST.isPlayerStation(st) ? '' : ' is-captured';
      return '<li class="station-item' + capturedCls + '">' +
        '<div class="station-item__head">' +
          '<span class="station-item__name">' + escapeHtml(st.name) + ' <span class="station-item__sys">' + sysName(st.systemId) + sysTag(st.systemId) + '</span></span>' +
          '<span class="station-item__lvl">' + (ST.isPlayerStation(st) ? (st.level > 0 ? ('lvl ' + st.level) : 'in opera') : 'occupata') + '</span>' +
        '</div>' +
        body +
      '</li>';
    }).join('') + '</ul>';
  } else {
    listHtml = '<p class="panel__note">Nessuna stazione. Costruisci un avamposto in un sistema esplorato vicino a una tua colonia: rifornisce le flotte in territorio profondo (#69) e fortifica il sistema.</p>';
  }

  /* Almeno una colonia operativa può fondare? */
  const canFound = myColonyKeys().some(function (k) {
    const c = g.colonies[k]; return c && c.colonized && c.phase !== 'settling';
  });

  stage.innerHTML =
    '<div class="fleet-view station-view">' +
      '<header class="fleet-view__head">' +
        '<h2 class="fleet-view__title">Stazioni spaziali <span class="fleet-view__sub">M16 · Avamposti</span></h2>' +
      '</header>' +
      '<div class="market-summary">' +
        '<div class="market-summary__cell"><span class="market-summary__val">' + operational + '</span><span class="market-summary__lbl">Operative</span></div>' +
        '<div class="market-summary__cell"><span class="market-summary__val">' + building + '</span><span class="market-summary__lbl">In costruzione</span></div>' +
        '<div class="market-summary__cell"><span class="market-summary__val">' + ST.CFG.BUILD_RANGE + '</span><span class="market-summary__lbl">Raggio (salti)</span></div>' +
      '</div>' +
      '<button class="btn btn--enter station-view__new" data-action="station-new" type="button"' + (canFound ? '' : ' disabled') + '>' +
        '+ Costruisci stazione</button>' +
      listHtml +
      '<p class="panel__note">Una stazione si costruisce <em>a distanza</em> da una tua colonia (max ' + ST.CFG.BUILD_RANGE + ' salti) e cresce di livello come una struttura: ogni modulo aggiunge corazza, fuoco difensivo e capacità del serbatoio. La <em>linea di rifornimento</em> dalla colonia riempie il serbatoio; se isolata le funzioni degradano (mai distrutta da sé). Le flotte si riforniscono qui in territorio profondo.</p>' +
    '</div>';

  const newBtn = stage.querySelector('[data-action="station-new"]');
  if (newBtn && !newBtn.disabled) newBtn.addEventListener('click', function () { openStationBuildPicker(stage); });
  stage.querySelectorAll('[data-action="station-upgrade"]').forEach(function (b) {
    if (b.disabled) return;
    b.addEventListener('click', function () {
      const st = ST.stationById(g, b.dataset.id);
      const r = ST.upgrade(g, st);
      if (!r.ok) { showToast(r.reason || 'Potenziamento rifiutato'); return; }
      persistGame(g); renderStationsView(stage); updateGlobalResourceHud();
    });
  });
  stage.querySelectorAll('[data-action="station-demolish"]').forEach(function (b) {
    b.addEventListener('click', function () {
      const st = ST.stationById(g, b.dataset.id);
      if (!confirm('Smantellare ' + (st ? st.name : 'la stazione') + '? Rimborso 50% del costo del livello corrente.')) return;
      ST.demolish(g, b.dataset.id);
      persistGame(g); renderStationsView(stage); updateGlobalResourceHud();
    });
  });
  stage.querySelectorAll('[data-action="station-cancel"]').forEach(function (b) {
    b.addEventListener('click', function () {
      ST.cancelBuild(g, b.dataset.id);
      persistGame(g); renderStationsView(stage); updateGlobalResourceHud();
    });
  });
  /* Cantiere leggero/medio: assembla / annulla scafo. */
  stage.querySelectorAll('[data-action="station-build"]').forEach(function (b) {
    if (b.disabled) return;
    b.addEventListener('click', function () { openStationShipPicker(stage, b.dataset.id); });
  });
  stage.querySelectorAll('[data-action="station-build-cancel"]').forEach(function (b) {
    b.addEventListener('click', function () {
      const st = ST.stationById(g, b.dataset.id);
      ST.cancelShipBuild(g, st, Number(b.dataset.idx));
      persistGame(g); renderStationsView(stage);
    });
  });
}

/* Pannello "Cantiere leggero/medio" di una stazione operativa: riserva
   metalli + slip + coda di assemblaggio. Vuoto se il livello non offre slip. */
function stationYardHtml(st) {
  const ST = ORION.station, F = ORION.fleet;
  if (!ST || !ST.buildSlotsFor) return '';
  const slots = ST.buildSlotsFor(st);
  if (slots <= 0) return '';
  const metCap = ST.metReserveCap(st.level);
  const metFrac = metCap > 0 ? Math.max(0, Math.min(1, (st.metReserve || 0) / metCap)) : 0;
  const q = st.buildQueue || [];
  let qHtml = '';
  if (q.length) {
    qHtml = '<ul class="station-yard__queue">' + q.map(function (job, i) {
      const cls = (F && F.getClass(job.kind)) || { name: job.kind, glyph: '◈' };
      const prog = job.total > 0 ? Math.max(0, Math.min(1, 1 - (job.left || 0) / job.total)) : 0;
      const perI = (job.metCost || 0) / Math.max(1, job.total);
      const paused = (i < slots) && ((st.metReserve || 0) < perI);
      return '<li class="station-yard__job">' +
        '<span class="struct-item__glyph">' + cls.glyph + '</span> ' + escapeHtml(cls.name) +
        ' · ' + Math.ceil(job.left || 0) + ' ' + iU() +
        (paused ? ' · <span class="is-crit">in pausa (metallo)</span>' : '') +
        '<div class="station-bar"><div class="station-bar__fill station-bar__fill--build" style="width:' + Math.round(prog * 100) + '%"></div></div>' +
        '<button class="btn btn--mini btn--danger" data-action="station-build-cancel" data-id="' + st.id + '" data-idx="' + i + '" type="button">×</button>' +
      '</li>';
    }).join('') + '</ul>';
  }
  return '<div class="station-yard">' +
    '<div class="station-stat">' +
      '<span class="station-stat__lbl">Riserva metalli</span>' +
      '<div class="station-bar"><div class="station-bar__fill station-bar__fill--met" style="width:' + Math.round(metFrac * 100) + '%"></div></div>' +
      '<span class="station-stat__val">' + Math.round(st.metReserve || 0) + ' / ' + metCap + ' ' + resIcon('met') + '</span>' +
    '</div>' +
    '<div class="station-yard__head">Cantiere leggero/medio · ' + q.length + '/' + slots + ' slip</div>' +
    qHtml +
    '<button class="btn btn--mini btn--enter" data-action="station-build" data-id="' + st.id + '"' +
      (q.length >= slots ? ' disabled' : '') + ' type="button">+ Assembla scafo</button>' +
  '</div>';
}

/* Picker delle classi assemblabili alla stazione (≤ Fregata). Costo in solo
   metallo (attinto dalla riserva nel tempo). */
function openStationShipPicker(stage, stationId) {
  const g = ORION.game, ST = ORION.station, F = ORION.fleet;
  if (!g || !ST || !F) return;
  const st = ST.stationById(g, stationId);
  if (!st) return;

  const ov = document.createElement('div');
  ov.className = 'fleet-create-overlay';
  function close() { ov.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }

  const classes = (ST.CFG.SHIPYARD_CLASSES || []).map(function (k) { return F.getClass(k); }).filter(Boolean);
  const rows = classes.map(function (cls) {
    const chk = ST.canBuildShipAt(g, st, cls.id);
    const met = ST.shipMetCost(cls.id), time = ST.shipBuildTime(cls.id);
    return '<li class="station-cand">' +
      '<span class="station-cand__name"><span class="struct-item__glyph">' + cls.glyph + '</span> ' + escapeHtml(cls.name) + '</span>' +
      '<span class="station-cand__hops">' + met + ' ' + resIcon('met') + ' · ' + time + ' ' + iU() + '</span>' +
      '<button class="btn btn--mini btn--enter" data-kind="' + cls.id + '"' + (chk.ok ? '' : ' disabled title="' + escapeHtml(chk.reason || '') + '"') + ' type="button">Assembla</button>' +
    '</li>';
  }).join('');

  ov.innerHTML =
    '<div class="fleet-create-overlay__panel">' +
      '<header class="fleet-create-overlay__head">' +
        '<h3>Cantiere · ' + escapeHtml(st.name || 'stazione') + '</h3>' +
        '<button class="btn btn--mini" data-close type="button">✕</button>' +
      '</header>' +
      '<p class="sysinfo__sub">La stazione assembla navi leggere/medie dalla riserva di metalli (le navi grandi si fanno solo su colonia). Il costo è in solo metallo.</p>' +
      '<ul class="station-cand-list">' + rows + '</ul>' +
    '</div>';

  ov.querySelector('[data-close]').addEventListener('click', close);
  ov.querySelectorAll('[data-kind]').forEach(function (b) {
    if (b.disabled) return;
    b.addEventListener('click', function () {
      const r = ST.startShipBuild(g, st, b.dataset.kind);
      if (!r.ok) { showToast(r.reason || 'Assemblaggio rifiutato'); return; }
      persistGame(g); close(); renderStationsView(stage);
    });
  });

  document.body.appendChild(ov);
  document.addEventListener('keydown', onKey);
  ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
}

function stationCostStr(c) {
  return Object.keys(c).map(function (k) { return resIcon(k) + c[k]; }).join(' · ');
}

/* =====================================================================
   M17 Fase A (decisione #83) — Dispacci & Missioni + Memoria Storica
   ===================================================================== */
function dispatchPending() {
  const DP = ORION.dispatch, g = ORION.game;
  if (!DP || !g) return false;
  return !!(DP.pendingOffers(g).length || (DP.activeCrises && DP.activeCrises(g).length));
}
function dispatchLauncherSub() {
  const DP = ORION.dispatch, g = ORION.game;
  if (!DP || !g) return 'M17';
  const cri = (DP.activeCrises ? DP.activeCrises(g) : []).length;
  if (cri) return '⚠ ' + cri + (cri === 1 ? ' crisi' : ' crisi');
  const off = DP.pendingOffers(g).length;
  const act = DP.activeMissions(g).length;
  if (off) return off + (off === 1 ? ' nuovo' : ' nuovi');
  if (act) return act + ' in corso';
  return 'nessuno';
}
function dispatchSysName(sid) {
  const g = ORION.game; const s = g && g.galaxy.systems[sid];
  return s ? s.name : '—';
}
/* Testo dell'obiettivo (sui verbi esistenti — la missione osserva). */
function dispatchObjective(m, active) {
  const sn = dispatchSysName(m.targetSysId) + (m.targetSysId >= 0 ? systemTagHtml(m.targetSysId) : '');
  if (m.type === 'bounty') return 'Sgomina il covo pirata su ' + sn + ' — invia una flotta armata.';
  if (m.type === 'reach') return 'Raggiungi ' + sn + ' con una flotta.';
  const left = active && m.progress ? (m.progress.holdLeft == null ? m.holdI : m.progress.holdLeft) : m.holdI;
  const verb = (m.type === 'resupply') ? 'Mantieni una flotta a ' : 'Presidia ';
  return verb + sn + ' · ' + Math.max(0, Math.ceil(left)) + ' / ' + m.holdI + ' ' + iU() + ' di presenza.';
}
function dispatchRewardStr(m) {
  const r = m.reward || {};
  const parts = [];
  if (r.res) Object.keys(r.res).forEach(function (k) { parts.push(resIcon(k) + r.res[k]); });
  if (r.credits && r.credits.amount) parts.push('✦ ' + r.credits.amount);
  if (typeof r.reputation === 'number' && r.reputation) parts.push('rep +' + r.reputation);
  if (typeof r.disposition === 'number' && r.disposition && m.sourceCivId) parts.push('relazioni +' + r.disposition);
  return parts.join(' · ') || '—';
}

function renderDispatchView(stage) {
  if (!stage) return;
  const g = ORION.game, DP = ORION.dispatch;
  if (!g || !DP) return;
  if (ORION.tutorial) ORION.tutorial.fire('dispatches');

  const offers = DP.pendingOffers(g);
  const active = DP.activeMissions(g);
  const now = g.timeImpulsi || 0;
  const completed = (g.dispatchMeta && g.dispatchMeta.completed) || 0;

  const bossBadge = function (m) { return m.boss ? '<span class="dispatch-boss">⚑ BOSS</span> ' : ''; };
  function offerCard(m) {
    const ttl = Math.max(0, m.expiresAt - now);
    return '<li class="dispatch-card dispatch-card--' + m.type + (m.boss ? ' is-boss' : '') + '">' +
      '<div class="dispatch-card__head">' +
        '<span class="dispatch-card__title">' + bossBadge(m) + escapeHtml(m.title) + '</span>' +
        '<span class="dispatch-card__ttl">scade in ' + Math.ceil(ttl) + ' ' + iU() + '</span>' +
      '</div>' +
      '<div class="dispatch-card__src">da <strong>' + escapeHtml(m.sourceName) + '</strong></div>' +
      '<div class="dispatch-card__desc">' + escapeHtml(m.desc) + '</div>' +
      '<div class="dispatch-card__obj">Obiettivo: ' + dispatchObjective(m, false) + '</div>' +
      '<div class="dispatch-card__reward">Ricompensa: ' + dispatchRewardStr(m) + '</div>' +
      '<div class="dispatch-card__actions">' +
        '<button class="btn btn--mini btn--enter" data-dispatch-accept="' + m.id + '" type="button">Accetta</button>' +
        '<button class="btn btn--mini btn--danger" data-dispatch-decline="' + m.id + '" type="button">Rifiuta</button>' +
      '</div>' +
    '</li>';
  }
  function activeCard(m) {
    const dl = Math.max(0, (m.deadline || 0) - now);
    return '<li class="dispatch-card dispatch-card--' + m.type + ' is-active' + (m.boss ? ' is-boss' : '') + '">' +
      '<div class="dispatch-card__head">' +
        '<span class="dispatch-card__title">' + bossBadge(m) + escapeHtml(m.title) + '</span>' +
        '<span class="dispatch-card__ttl">entro ' + Math.ceil(dl) + ' ' + iU() + '</span>' +
      '</div>' +
      '<div class="dispatch-card__src">per <strong>' + escapeHtml(m.sourceName) + '</strong></div>' +
      '<div class="dispatch-card__obj">' + dispatchObjective(m, true) + '</div>' +
      '<div class="dispatch-card__reward">Ricompensa: ' + dispatchRewardStr(m) + '</div>' +
      '<div class="dispatch-card__actions">' +
        '<button class="btn btn--mini btn--danger" data-dispatch-abandon="' + m.id + '" type="button">Abbandona</button>' +
      '</div>' +
    '</li>';
  }

  const offersHtml = offers.length
    ? '<ul class="dispatch-list">' + offers.map(offerCard).join('') + '</ul>'
    : '<p class="panel__note">Nessun incarico disponibile. I dispacci arrivano col tempo da civiltà contattate, dal Sindacato Mekhari e come segnali di frontiera.</p>';
  const activeHtml = active.length
    ? '<ul class="dispatch-list">' + active.map(activeCard).join('') + '</ul>'
    : '<p class="panel__note">Nessun incarico in corso.</p>';

  /* M17 Fase B (#83): cacciatori di taglie freelance (Mekhari, auto-risolutivi). */
  let huntersHtml = '';
  const mekhariOn = !!(ORION.mekhari && ORION.mekhari.isAvailable && ORION.mekhari.isAvailable(g));
  if (mekhariOn && ORION.tutorial) ORION.tutorial.fire('mekhari-hunters');
  if (mekhariOn) {
    const nests = DP.knownNestsDetailed(g);
    const contracts = DP.activeContracts(g);
    const contractSys = {};
    contracts.forEach(function (c) { contractSys[c.targetSysId] = c; });
    const rows = nests.map(function (n) {
      const c = contractSys[n.sysId];
      const tag = n.boss ? '<span class="dispatch-boss">⚑ ' + escapeHtml(n.bossName || 'BOSS') + '</span> ' : '';
      if (c) {
        const eta = Math.max(0, c.resolveAt - now);
        return '<li class="hunter-row is-hired">' + tag + escapeHtml(n.sysName) +
          ' <span class="hunter-row__sys">' + systemTagHtml(n.sysId) + '</span>' +
          '<span class="hunter-row__eta">cacciatori in azione · ' + Math.ceil(eta) + ' ' + iU() + '</span></li>';
      }
      const q = DP.huntQuote(g, n.sysId);
      const btn = q.ok
        ? '<button class="btn btn--mini" data-hunt="' + n.sysId + '" type="button" title="Paga dalla Tesoreria">Assolda · ✦ ' + q.credits + '</button>'
        : '<span class="hunter-row__na">' + escapeHtml(q.reason || '—') + '</span>';
      return '<li class="hunter-row">' + tag + escapeHtml(n.sysName) +
        ' <span class="hunter-row__sys">' + systemTagHtml(n.sysId) + ' · lvl ' + n.level + '</span>' + btn + '</li>';
    }).join('');
    huntersHtml =
      '<section class="dispatch-sec"><h3 class="dispatch-sec__title">Cacciatori di taglie · Mekhari</h3>' +
        (nests.length
          ? '<ul class="hunter-list">' + rows + '</ul>'
          : '<p class="panel__note">Nessun covo pirata noto. Esplora la Frontiera per scovarli.</p>') +
        '<p class="panel__note">Il Sindacato Mekhari ingaggia <strong>cacciatori freelance</strong> che sgominano un covo per te (paghi dalla Tesoreria, si risolve da solo dopo un po\'). Se sul covo pende una tua taglia, si completa anche quella.</p>' +
      '</section>';
  }

  /* M17 Fase C (#83): crisi in sospeso (rispondi → riapre il modale). */
  const crises = DP.activeCrises ? DP.activeCrises(g) : [];
  let crisisHtml = '';
  if (crises.length) {
    crisisHtml = '<section class="dispatch-sec"><h3 class="dispatch-sec__title">Crisi in sospeso</h3>' +
      '<ul class="dispatch-list">' + crises.map(function (c) {
        const dl = Math.max(0, (c.expiresAt || 0) - now);
        return '<li class="dispatch-card dispatch-card--crisis is-boss">' +
          '<div class="dispatch-card__head"><span class="dispatch-card__title">⚠ ' + escapeHtml(c.title) + '</span>' +
          '<span class="dispatch-card__ttl">decidi entro ' + Math.ceil(dl) + ' ' + iU() + '</span></div>' +
          '<div class="dispatch-card__desc">' + escapeHtml(c.body) + '</div>' +
          '<div class="dispatch-card__actions"><button class="btn btn--mini btn--danger" data-crisis-open="' + c.id + '" type="button">Rispondi</button></div>' +
        '</li>';
      }).join('') + '</ul></section>';
  }

  /* M17 Fase C (#83): le anomalie esplorabili §17.3 NON vivono più qui
     (erano "scomode" e ridondanti). Stanno ora dove sono pertinenti: la
     scheda del Sistema (stato/riserva, contestuale all'ispezione) e la tab
     Esplorazione della colonia ("Anomalie raggiungibili" + Invia flotta). */

  const mem = (g.memoria || []);
  const memHtml = mem.length
    ? '<ul class="memoria-list">' + mem.slice(0, 60).map(function (e) {
        return '<li class="memoria-item memoria-item--' + (e.mod || 'system') + '">' +
          '<span class="memoria-item__ds">' + ORION.time.format(e.impulso) + '</span>' +
          '<span class="memoria-item__txt">' + escapeHtml(e.text) + '</span>' +
        '</li>';
      }).join('') + '</ul>'
    : '<p class="panel__note">La storia del tuo popolo si scriverà qui: prime colonie, primi contatti, alleanze, svolte.</p>';

  stage.innerHTML =
    '<div class="fleet-view dispatch-view">' +
      '<header class="fleet-view__head">' +
        '<h2 class="fleet-view__title">Dispacci &amp; Missioni <span class="fleet-view__sub">M17 · Eventi</span></h2>' +
      '</header>' +
      '<div class="market-summary">' +
        '<div class="market-summary__cell"><span class="market-summary__val">' + offers.length + '</span><span class="market-summary__lbl">Disponibili</span></div>' +
        '<div class="market-summary__cell"><span class="market-summary__val">' + active.length + '</span><span class="market-summary__lbl">In corso</span></div>' +
        '<div class="market-summary__cell"><span class="market-summary__val">' + completed + '</span><span class="market-summary__lbl">Completati</span></div>' +
      '</div>' +
      crisisHtml +
      '<section class="dispatch-sec"><h3 class="dispatch-sec__title">Incarichi disponibili</h3>' + offersHtml + '</section>' +
      '<section class="dispatch-sec"><h3 class="dispatch-sec__title">Incarichi in corso</h3>' + activeHtml + '</section>' +
      '<p class="panel__note">Gli incarichi si adempiono con le flotte che già hai: manda una squadra a sgominare un covo, a raggiungere o presidiare un sistema. Accettare è un impegno; abbandonare o lasciar scadere costa qualche relazione, completare ricompensa.</p>' +
      huntersHtml +
      '<section class="dispatch-sec dispatch-sec--memoria"><h3 class="dispatch-sec__title">Memoria Storica</h3>' + memHtml + '</section>' +
    '</div>';

  stage.querySelectorAll('[data-dispatch-accept]').forEach(function (b) {
    b.addEventListener('click', function () {
      const r = DP.accept(g, b.dataset.dispatchAccept);
      if (!r.ok) { showToast(r.reason || 'Non riuscito'); return; }
      showToast('Incarico accettato');
      persistGame(g); renderDispatchView(stage); renderLeftPanel();
    });
  });
  stage.querySelectorAll('[data-dispatch-decline]').forEach(function (b) {
    b.addEventListener('click', function () {
      DP.decline(g, b.dataset.dispatchDecline);
      persistGame(g); renderDispatchView(stage); renderLeftPanel();
    });
  });
  stage.querySelectorAll('[data-dispatch-abandon]').forEach(function (b) {
    b.addEventListener('click', function () {
      if (!confirm('Abbandonare l\'incarico? Costa qualche punto di relazione.')) return;
      DP.abandon(g, b.dataset.dispatchAbandon);
      persistGame(g); renderDispatchView(stage); renderLeftPanel();
    });
  });
  stage.querySelectorAll('[data-crisis-open]').forEach(function (b) {
    b.addEventListener('click', function () { showCrisisModal(b.dataset.crisisOpen); });
  });
  stage.querySelectorAll('[data-hunt]').forEach(function (b) {
    b.addEventListener('click', function () {
      const sid = Number(b.dataset.hunt);
      const r = DP.hireHunter(g, sid);
      if (!r.ok) { showToast(r.reason || 'Non riuscito'); return; }
      const sys = g.galaxy.systems[sid];
      pushChronicle(ORION.time.format(g.timeImpulsi) + ' — Cacciatori Mekhari ingaggiati su <strong>' +
        (sys ? sys.name : '—') + '</strong> (✦ ' + r.credits + ').', 'civ');
      showToast('Cacciatori assoldati · ✦ ' + r.credits + ' · in azione tra ' + r.eta + ' Ι');
      persistGame(g); renderDispatchView(stage); updateGlobalResourceHud();
    });
  });
}

/* Overlay di costruzione: scegli la colonia fondatrice + il sistema target
   (esplorato, entro raggio, senza stazione), poi conferma. */
function openStationBuildPicker(stage) {
  const g = ORION.game, ST = ORION.station;
  if (!g || !ST) return;
  const mine = myColonyKeys().filter(function (k) {
    const c = g.colonies[k]; return c && c.colonized && c.phase !== 'settling';
  });
  if (!mine.length) { showToast('Nessuna colonia operativa'); return; }
  if (!ORION.stationBuildColony || mine.indexOf(ORION.stationBuildColony) < 0) ORION.stationBuildColony = mine[0];

  const ov = document.createElement('div');
  ov.className = 'fleet-create-overlay';
  function close() { ov.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }

  function render() {
    const colKey = ORION.stationBuildColony;
    const colony = g.colonies[colKey];
    const colOpts = mine.map(function (k) {
      return '<option value="' + k + '"' + (k === colKey ? ' selected' : '') + '>' + colonyNameFromKey(k) + '</option>';
    }).join('');

    /* Candidati: sistemi esplorati entro raggio, senza stazione. */
    const disc = g.state.discovery;
    const EXP = ORION.galaxy.DISCOVERY.EXPLORED;
    const cands = [];
    for (let id = 0; id < (g.galaxy.systems.length || 0); id++) {
      if (id === colony.systemId) continue;
      if (disc[id] < EXP) continue;
      if (ST.stationAt(g, id)) continue;
      const hops = ST.hopsBetween(g.galaxy, colony.systemId, id);
      if (hops > ST.CFG.BUILD_RANGE) continue;
      cands.push({ id: id, hops: hops });
    }
    cands.sort(function (a, b) { return a.hops - b.hops; });

    const cost = ST.stepCost(1), time = ST.stepTime(1);
    const payable = cost && Object.keys(cost).every(function (k) { return (colony.stock[k] || 0) >= cost[k]; });

    let candHtml;
    if (cands.length) {
      candHtml = '<ul class="station-cand-list">' + cands.map(function (c) {
        const s = g.galaxy.systems[c.id];
        const occ = ST.stationAt(g, c.id);
        return '<li class="station-cand">' +
          '<span class="station-cand__name">' + (s ? s.name : '—') + systemTagHtml(c.id) + '</span>' +
          '<span class="station-cand__hops">' + c.hops + ' salti</span>' +
          '<button class="btn btn--mini btn--enter" data-build="' + c.id + '"' + (payable ? '' : ' disabled') + ' type="button">Costruisci</button>' +
        '</li>';
      }).join('') + '</ul>';
    } else {
      candHtml = '<p class="panel__note">Nessun sistema esplorato libero entro ' + ST.CFG.BUILD_RANGE + ' salti da questa colonia. Esplora di più o scegli un\'altra colonia fondatrice.</p>';
    }

    ov.innerHTML =
      '<div class="fleet-create-overlay__panel">' +
        '<header class="fleet-create-overlay__head">' +
          '<h3>Costruisci stazione</h3>' +
          '<button class="btn btn--mini" data-close type="button">✕</button>' +
        '</header>' +
        '<label class="fleet-field"><span>Colonia fondatrice</span>' +
          '<select class="fleet-row__select" data-bind="station-colony">' + colOpts + '</select></label>' +
        '<p class="sysinfo__sub">Costo ' + stationCostStr(cost) + ' · ' + time + ' ' + iU() +
          (payable ? '' : ' <span class="is-crit">(risorse insufficienti)</span>') + '</p>' +
        '<p class="sysinfo__sub">Sistemi raggiungibili</p>' +
        candHtml +
      '</div>';

    const sel = ov.querySelector('[data-bind="station-colony"]');
    if (sel) sel.addEventListener('change', function () { ORION.stationBuildColony = this.value; render(); });
    ov.querySelector('[data-close]').addEventListener('click', close);
    ov.querySelectorAll('[data-build]').forEach(function (b) {
      if (b.disabled) return;
      b.addEventListener('click', function () {
        const targetId = Number(b.dataset.build);
        const r = ST.build(g, ORION.stationBuildColony, targetId);
        if (!r.ok) { showToast(r.reason || 'Costruzione rifiutata'); return; }
        /* Avvio costruzione stazione: azione del giocatore — niente
           entry in cronaca, la vista Stazioni mostra il cantiere. */
        persistGame(g); close(); renderStationsView(stage); updateGlobalResourceHud();
      });
    });
  }

  render();
  document.body.appendChild(ov);
  document.addEventListener('keydown', onKey);
  ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
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
  /* Nome del corpo target di un ordine (anomalia/colonia/avamposto), se il
     corpo è dentro `sysId`. Usa il generatore di sistema (deterministico). */
  function bodyNameOf(sysId, bodyKey) {
    if (!bodyKey || sysId == null || sysId < 0) return null;
    if (!ORION.system || !ORION.system.generate || !ORION.system.findBody) return null;
    try {
      const ds = ORION.system.generate(g.galaxy, sysId);
      const b = ds && ORION.system.findBody(ds, bodyKey);
      return b ? b.name : null;
    } catch (e) { return null; }
  }
  /* Riepilogo "dove sta" una flotta — corretto durante viaggi inter- e
     intra-sistema (richiesta utente 2026-06-18: NON mostrare il sistema di
     partenza come posizione quando la flotta è già in volo). */
  function fleetLocLabel(f) {
    if (!f || !f.location) return uiIcon('system', 'amber') + ' —';
    const loc = f.location;
    /* INTRA — manovra dentro un sistema verso un corpo (estrattori,
       ricognizione anomalia interna, ecc.). */
    if (loc.status === 'in-transit' && loc.intra) {
      const sysId = loc.intra.systemId;
      const bodyLbl = bodyNameOf(sysId, loc.intra.toBodyKey);
      const eta = (f.etaImpulsi | 0);
      return uiIcon('system', 'amber') + ' <strong>' + escapeHtml(sysName(sysId)) + '</strong>' + systemTagHtml(sysId) +
        (bodyLbl
          ? ' <span class="fleet-item__body">· → ' + escapeHtml(bodyLbl) + (eta > 0 ? ' (' + eta + ' ' + iU() + ')' : '') + '</span>'
          : ' <span class="fleet-item__body">· manovra interna' + (eta > 0 ? ' (' + eta + ' ' + iU() + ')' : '') + '</span>');
    }
    /* INTER — viaggio iperspaziale tra sistemi. Mostra DESTINAZIONE finale
       (non il sistema-stub di partenza) + sotto-info col nodo di provenienza
       e l'ETA al prossimo hop. */
    if (loc.status === 'in-transit') {
      const destSys = (f.orders && f.orders.toSysId != null) ? f.orders.toSysId
        : (Array.isArray(f.route) && f.route.length ? f.route[f.route.length - 1] : loc.systemId);
      const fromSys = (Array.isArray(f.route) && f.routeIdx < f.route.length) ? f.route[f.routeIdx] : loc.systemId;
      const nextHop = (Array.isArray(f.route) && f.routeIdx + 1 < f.route.length) ? f.route[f.routeIdx + 1] : null;
      const eta = (f.etaImpulsi | 0);
      const subInner = (nextHop != null && nextHop !== destSys)
        ? ('verso ' + escapeHtml(sysName(nextHop)) + ' · ' + eta + ' ' + iU() + ' da ' + escapeHtml(sysName(fromSys)))
        : (eta + ' ' + iU() + ' da ' + escapeHtml(sysName(fromSys)));
      return uiIcon('fleet', 'cyan') + ' <strong>in viaggio → ' + escapeHtml(sysName(destSys)) + '</strong>' + systemTagHtml(destSys) +
        ' <span class="fleet-item__body">· ' + subInner + '</span>';
    }
    /* STATICO — orbiting/docked: sistema corrente (+ corpo se rilevabile). */
    const sysTag = (loc.systemId >= 0) ? systemTagHtml(loc.systemId) : '';
    const bn = fleetBodyName(g, f);
    return uiIcon('system', 'amber') + ' <strong>' + escapeHtml(sysName(loc.systemId)) + '</strong>' + sysTag +
      (bn ? ' <span class="fleet-item__body">· ' + escapeHtml(bn) + '</span>' : '');
  }
  function fleetStatusLabel(f) {
    if (!f || !f.location) return '—';
    if (f.location.status === 'in-transit') return 'in viaggio (arrivo in ' + (f.etaImpulsi | 0) + ' ' + iU() + ')';
    return ORION.fleet.berthLabel(ORION.fleet.berthOf(ORION.game, f));
  }
  function orderLabel(f) {
    const o = f && f.orders;
    if (!o) return 'idle';
    const bodyFrag = function (sysId, bk) {
      const bn = bodyNameOf(sysId, bk);
      return bn ? ' · ' + bn : '';
    };
    if (o.type === 'idle') return (f.location && f.location.status === 'orbiting') ? '⏸ in sosta' : 'in attesa';
    if (o.type === 'move') return 'spostamento a ' + sysName(o.toSysId) + bodyFrag(o.toSysId, o.bodyKey);
    if (o.type === 'attack') return '⚔ attacco a ' + sysName(o.toSysId) + bodyFrag(o.toSysId, o.bodyKey);
    if (o.type === 'explore') return 'esplorazione di ' + sysName(o.toSysId);
    if (o.type === 'survey') return '✦ raccolta anomalia · ' + sysName(o.toSysId) + bodyFrag(o.toSysId, o.bodyKey);
    if (o.type === 'recon') return 'ricognizione di ' + sysName(o.toSysId) + bodyFrag(o.toSysId, o.bodyKey);
    if (o.type === 'colonize') return 'colonizzazione di ' + sysName(o.toSysId) + bodyFrag(o.toSysId, o.bodyKey);
    if (o.type === 'garrison') return 'presidio di ' + sysName(o.toSysId) + bodyFrag(o.toSysId, o.bodyKey);
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
    /* Card = solo riepilogo, ZERO bottoni (richiesta utente 2026-06-13).
       Click sulla card → Dettaglio flotta (pannello unico). */
    const FORM_LABEL = { aggressive: 'Aggressiva', balanced: 'Bilanciata', defensive: 'Difensiva' };
    /* Hop dalla colonia più vicina (BFS multi-sorgente sul grafo rotte). */
    const homeDist = (function () {
      const sys = g.galaxy.systems;
      const dist = new Array(sys.length).fill(-1);
      const q = [];
      Object.keys(g.colonies).forEach(function (k) {
        const c = g.colonies[k];
        if (c && c.colonized && c.systemId >= 0 && dist[c.systemId] !== 0) { dist[c.systemId] = 0; q.push(c.systemId); }
      });
      let head = 0;
      while (head < q.length) {
        const u = q[head++]; const links = (sys[u] && sys[u].links) || [];
        for (let i = 0; i < links.length; i++) { const v = links[i]; if (dist[v] < 0) { dist[v] = dist[u] + 1; q.push(v); } }
      }
      return dist;
    })();
    function cardHtml(f) {
      const counter = {};
      (f.ships || []).forEach(function (s) { counter[s.kind] = (counter[s.kind] || 0) + 1; });
      const counterHtml = Object.keys(counter).map(function (k) {
        const cls = (ORION.fleet && ORION.fleet.getClass(k)) || { glyph: '?', name: k };
        return '<span class="fleet-item__ship" title="' + escapeHtml(cls.name) + '">' + fleetShipIcon(k) + ' ' + counter[k] + '</span>';
      }).join('') || '<span class="cantieri-row__base">flotta vuota</span>';
      const status = fleetStatusLabel(f);
      const statusCls = (f.location && f.location.status) || 'idle';
      const vetHtml = fleetVeterancyHtml(f);
      const formation = (f.formation) || 'balanced';
      const officers = (ORION.commander && ORION.commander.officersOf) ? ORION.commander.officersOf(f) : (f.commander ? [f.commander] : []);
      const slots = (ORION.fleet && ORION.fleet.fleetOfficerSlots) ? ORION.fleet.fleetOfficerSlots(f) : 1;
      const offChip = officers.length
        ? '<span class="fleet-chip fleet-chip--off" title="Ufficiali a bordo">' + uiIcon('star', 'amber') + ' ' + officers.length + '/' + slots + '</span>'
        : '';
      const popCap = ORION.fleet && ORION.fleet.fleetPopCargoCap ? ORION.fleet.fleetPopCargoCap(f) : 0;
      const popChip = popCap > 0
        ? '<span class="fleet-chip fleet-chip--pop" title="Coloni a bordo (livelli)">◉ ' + (f.popOnboard || 0) + '/' + popCap + '</span>'
        : '';
      const hd = homeDist[f.location.systemId];
      const distChip = (hd >= 0)
        ? '<span class="fleet-chip fleet-chip--dist" title="Distanza dalla colonia più vicina">' + uiIcon('roster', 'amber') + ' ' + (hd === 0 ? 'a casa' : hd + ' hop') + '</span>'
        : '';
      const viveriHtml = fleetViveriHtml(f);
      const wearHtml = fleetWearHtml(f);
      return '<li class="fleet-item fleet-item--card" data-fleet-id="' + escapeHtml(f.id) + '" tabindex="0" role="button" aria-label="Apri dettaglio ' + escapeHtml(f.name) + '">' +
        '<div class="fleet-item__head">' +
          '<span class="fleet-item__name">' + uiIcon('fleet', 'cyan') + ' <strong>' + escapeHtml(f.name) + '</strong> ' +
            '<span class="cantieri-row__base">· ' + escapeHtml(systemNameFromKey(g, f.ownerColonyKey)) + '</span></span>' +
          '<span class="fleet-status fleet-status--' + statusCls + '">' + status + '</span>' +
        '</div>' +
        '<div class="fleet-item__row">' +
          '<span class="fleet-item__loc">' + fleetLocLabel(f) + '</span>' +
          '<span class="fleet-item__order">' + escapeHtml(orderLabel(f)) + '</span>' +
        '</div>' +
        '<div class="fleet-item__meta">' + counterHtml +
          '<span class="fleet-chip" title="Equipaggio">' + uiIcon('forces', 'amber') + ' ' + (f.crew ? f.crew.length : 0) + '/' + (ORION.fleet ? ORION.fleet.fleetCrewRequired(f) : 0) + '</span>' +
          distChip +
          '<span class="fleet-chip fleet-chip--form" title="Formazione">' + FORM_LABEL[formation] + '</span>' +
          offChip + popChip +
          '<span class="fleet-item__open" aria-hidden="true">' + uiIcon('chevronRight', 'soft') + '</span>' +
        '</div>' +
        viveriHtml + wearHtml + vetHtml +
      '</li>';
    }
    /* Raggruppamento per gruppo stellare (sezioni collassabili). */
    ORION._fleetGroupCollapsed = ORION._fleetGroupCollapsed || {};
    const byGroup = {};
    g.fleets.forEach(function (f) {
      const cl = (g.galaxy.systems[f.location.systemId] || {}).cluster;
      (byGroup[cl] = byGroup[cl] || []).push(f);
    });
    const groupIds = Object.keys(byGroup).sort(function (a, b) {
      return byGroup[b].length - byGroup[a].length || Number(a) - Number(b);
    });
    listHtml = '<div class="fleet-groups">' + groupIds.map(function (cl) {
      const grp = g.galaxy.groups[cl] || {};
      const acr = grp.acronym ? ' <span class="name-tag">[' + escapeHtml(grp.acronym) + ']</span>' : '';
      const collapsed = !!ORION._fleetGroupCollapsed[cl];
      const head = '<button class="fleet-group__head" data-group-toggle="' + cl + '" type="button">' +
        '<span class="fleet-group__caret">' + (collapsed ? '▸' : '▾') + '</span>' +
        uiIcon('group', 'violet') + ' <strong>' + escapeHtml(grp.name || ('Gruppo ' + cl)) + '</strong>' + acr +
        '<span class="fleet-group__count">' + byGroup[cl].length + '</span></button>';
      const body = collapsed ? '' : '<ul class="fleet-list">' + byGroup[cl].map(cardHtml).join('') + '</ul>';
      return '<section class="fleet-group">' + head + body + '</section>';
    }).join('') + '</div>';
  }

  const canCreate = eligibleColonies.length > 0;
  stage.innerHTML =
    '<div class="fleet-view">' +
      '<header class="fleet-view__head">' +
        '<h2 class="fleet-view__title">Flotte e guerra <span class="fleet-view__sub">M09 · Fase A</span></h2>' +
        '<div class="fleet-view__actions">' +
          '<button class="btn btn--mini btn--primary btn--with-icon" data-action="fleet-create" type="button"' +
            (canCreate ? '' : ' disabled title="Serve una colonia con Hangar di costruzione"') + '>' + uiIcon('plus', 'cyan') + ' Crea flotta</button>' +
          '<button class="btn btn--mini btn--with-icon" data-action="fleet-manage" type="button"' +
            (g.fleets.length >= 1 ? '' : ' disabled title="Nessuna flotta attiva"') + '>' + uiIcon('refresh', 'cyan') + ' Gestione flotte</button>' +
        '</div>' +
      '</header>' +
      buildWarSection(g) +
      buildCommanderRoster(g) +
      '<p class="panel__note">Le flotte si compongono dalle navi a terra e dagli equipaggi della colonia origine. ' +
        'La <strong>formazione</strong> determina la soglia di ritirata in battaglia. Le navi che sopravvivono ' +
        'salgono di grado (Verde→Veterana→Elite→Leggendaria) e diventano più forti.</p>' +
      listHtml +
    '</div>';

  /* Handlers */
  stage.querySelectorAll('[data-action="fleet-create"]').forEach(function (b) {
    b.addEventListener('click', function () { openFleetDetail(null); });
  });
  stage.querySelectorAll('[data-action="fleet-manage"]').forEach(function (b) {
    b.addEventListener('click', function () { openFleetManageInFlight(); });
  });
  /* Card cliccabile → Dettaglio flotta (mouse + tastiera). */
  stage.querySelectorAll('.fleet-item--card').forEach(function (card) {
    function open() { openFleetDetail(card.dataset.fleetId); }
    card.addEventListener('click', open);
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  });
  /* Toggle collasso dei gruppi stellari. */
  stage.querySelectorAll('[data-group-toggle]').forEach(function (b) {
    b.addEventListener('click', function () {
      const cl = b.dataset.groupToggle;
      ORION._fleetGroupCollapsed = ORION._fleetGroupCollapsed || {};
      ORION._fleetGroupCollapsed[cl] = !ORION._fleetGroupCollapsed[cl];
      renderFleetView(stage);
    });
  });
  /* Sezione Guerra (buildWarSection) — handler invariati. */
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
    b.addEventListener('click', function () { openRecallOverlay(stage); });
  });
}

/* Roster "Comandanti dell'Impero" (decisione utente 2026-06-11): i
   Comandanti sono figure A LIVELLO IMPERO, non legate a una colonia.
   Elenca il pool idle (game.commanders) + quelli al comando di una flotta.
   La provenienza ("emerso su X") resta come etichetta narrativa. */
/* Etichetta ruolo §12.4 di una figura (con fallback per save legacy). */
function cmdRoleLabel(c) {
  if (!c) return '—';
  if (ORION.commander && ORION.commander.roleLabel) return ORION.commander.roleLabel(c);
  return c.roleLabel || c.role || c.specializationLabel || c.specialization || '—';
}
function buildCommanderRoster(g) {
  if (!ORION.commander || !ORION.commander.allOf) return '';
  const all = ORION.commander.allOf(g);
  if (!all.length) return '';
  const starHtml = uiIcon('star', 'amber');
  const rows = all.map(function (c) {
    const fleet = c.assignedFleetId ? findFleet(c.assignedFleetId) : null;
    const statusHtml = (c.status === 'assigned')
      ? 'al comando di <strong>' + escapeHtml(fleet ? fleet.name : '—') + '</strong>'
      : 'in panchina';
    const origin = c.originColonyKey ? (' · emerso su ' + escapeHtml(systemNameFromKey(g, c.originColonyKey))) : '';
    const race = c.raceLabel ? (' · <span class="commander-roster__race" title="Archetipo">' + escapeHtml(c.raceLabel) + '</span>') : '';
    return '<li class="commander-roster__item">' +
      '<span class="commander-roster__rank">' + escapeHtml(c.rank || 'Tenente') + '</span>' +
      '<span class="commander-roster__name">' + escapeHtml(c.name || '—') + '</span>' +
      '<span class="commander-roster__spec commander-roster__spec--' + escapeHtml(c.role || 'comandante') + '">' + escapeHtml(cmdRoleLabel(c)) + '</span>' +
      '<span class="commander-roster__trait" title="Tratto">' + escapeHtml(c.traitLabel || c.trait || '—') + '</span>' + race +
      '<span class="xp-chip" title="Esperienza individuale (cresce in servizio)">xp ' + (c.xp | 0) + '</span>' +
      '<span class="commander-roster__bonus" title="Bonus attivi">' + escapeHtml(ORION.commander.bonusLabel(c)) + '</span>' +
      '<span class="commander-roster__status commander-roster__status--' + escapeHtml(c.status || 'idle') + '">' + statusHtml + origin + '</span>' +
    '</li>';
  }).join('');
  return '<div class="cantieri-row commander-row">' +
    '<div class="cantieri-row__head">' +
      '<span class="cantieri-row__glyph ui-icon ui-icon--amber" aria-hidden="true">' + starHtml + '</span>' +
      '<span class="cantieri-row__name">Figure dell\'Impero</span>' +
      '<span class="cantieri-row__counter">In organico: <strong>' + all.length + '</strong></span>' +
    '</div>' +
    '<ul class="commander-roster">' + rows + '</ul>' +
    '<p class="commander-row__hint">Figure di flotta emerse dal servizio (§12.4): <strong>Comandante</strong> (fuoco) · <strong>Ingegnere di Flotta</strong> (viaggio/scafo) · <strong>Stratega</strong> (imboscate). Il rango cresce in battaglia. Le navi capitali (M15) ospitano più ufficiali — assegnale col pulsante <strong>★ Ufficiali</strong>.</p>' +
  '</div>';
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
  /* Leva di recovery: richiamo flotte MIRATO (colonia di raduno + ambito). */
  if ((g.fleets || []).length) {
    html += ' <button class="btn btn--mini btn--with-icon" data-action="war-recall" type="button" title="Richiama le flotte verso una colonia di raduno, entro N hop o N Impulsi">' +
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

/* Decisione utente 2026-06-16: gauge usura scafi a livello flotta.
   Riassume per colpo d'occhio l'usura media + il picco (worst-case): la
   soglia di rientro forzato per singolo scafo è 80%, quindi il "peak" è
   il segnale più azionabile. Stato cromatico mirrors fleet-viveri:
   ok (peak<50%) · low (50-79%) · crit (≥80%). Restituisce stringa vuota
   per flotte senza navi (mai render in tal caso). */
function fleetWearHtml(fleet) {
  if (!fleet || !Array.isArray(fleet.ships) || !fleet.ships.length) return '';
  let sum = 0, max = 0, n = 0;
  for (let i = 0; i < fleet.ships.length; i++) {
    const s = fleet.ships[i];
    const w = Math.min(100, Math.max(0, (s && s.wear) || 0));
    sum += w; if (w > max) max = w; n++;
  }
  if (!n) return '';
  const avg = Math.round(sum / n);
  const peak = Math.round(max);
  const st = peak >= 80 ? 'crit' : peak >= 50 ? 'low' : 'ok';
  const peakStr = (peak !== avg) ? ' · peak ' + peak + '%' : '';
  const label = 'Usura ' + avg + '%' + peakStr;
  /* Riparazione solo ATTRACCATA (hangar o stazione): in orbita-parcheggio
     niente refit (decisione utente 2026-06-18). */
  const orbitParked = ORION.fleet && ORION.fleet.berthOf &&
    ORION.fleet.berthOf(ORION.game, fleet) === 'orbit';
  const repairHint = orbitParked
    ? ' ⚠ In orbita-parcheggio NON si ripara: attracca in hangar o alla stazione.'
    : '';
  return '<div class="fleet-wear fleet-wear--' + st + '" title="Usura scafi della flotta: media e picco. Singolo scafo ≥80% → rientro forzato. Si ripara solo ATTRACCATA (hangar colonia o stazione orbitale lvl≥2), non in orbita.' + repairHint + '">' +
    '<span class="fleet-wear__ico ui-icon ui-icon--amber" aria-hidden="true">⚒</span> ' +
    '<span class="fleet-wear__lbl">' + label + '</span>' +
    '<span class="fleet-wear__bar"><span class="fleet-wear__fill" style="width:' + avg + '%"></span></span>' +
    '</div>';
}

/* Decisione #69: gauge viveri di flotta. Autonomia in Ι (0..cap) con stato
   ok/low/crit colorato. La flotta a un porto amico è sempre rifornita. */
function fleetViveriHtml(fleet) {
  const F = ORION.fleet;
  if (!F || !F.viveriOf || !fleet || !fleet.ships || !fleet.ships.length) return '';
  const cap = F.viveriCapOf ? F.viveriCapOf(fleet) : (F.viveriCap ? F.viveriCap() : 250);
  const v = Math.max(0, Math.round(F.viveriOf(fleet)));
  const st = F.viveriStatus ? F.viveriStatus(fleet) : 'ok';
  const atPort = (ORION.game && F.fleetAtFriendlyPort) ? F.fleetAtFriendlyPort(ORION.game, fleet) : false;
  const pct = Math.max(0, Math.min(100, Math.round(v / cap * 100)));
  const drift = fleet._drift ? ' · <strong>deriva</strong>' : '';
  const portTag = atPort ? ' · al porto' : '';
  const label = v + ' / ' + cap + ' Ι' + portTag + drift;
  return '<div class="fleet-viveri fleet-viveri--' + st + '" title="Viveri: autonomia della flotta lontano da un porto amico (#69)">' +
    '<span class="fleet-viveri__ico ui-icon ui-icon--green" aria-hidden="true">◇</span> ' +
    '<span class="fleet-viveri__lbl">Viveri ' + label + '</span>' +
    '<span class="fleet-viveri__bar"><span class="fleet-viveri__fill" style="width:' + pct + '%"></span></span>' +
    '</div>';
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
/* Richiamo flotte MIRATO (richiesta utente 2026-06-13). Sostituisce il
   vecchio "return indiscriminato a tutti": scegli una colonia di raduno +
   un ambito (Tutte / entro N hop / entro N Ι di viaggio) e richiama solo le
   flotte che rientrano nel filtro. Recovery-friendly: niente fail-state. */
function openRecallOverlay(stage) {
  const g = ORION.game;
  const F = ORION.fleet;
  if (!g || !F) return;
  const colKeys = Object.keys(g.colonies).filter(function (k) {
    const c = g.colonies[k]; return c && c.colonized && c.systemId >= 0;
  });
  if (!colKeys.length) { showToast('Nessuna colonia di raduno'); return; }
  if (!(g.fleets || []).length) { showToast('Nessuna flotta da richiamare'); return; }

  const S = {
    destKey: (function () {
      if (ORION.capital) { for (let i = 0; i < colKeys.length; i++) if (ORION.capital.isCapital(g, colKeys[i])) return colKeys[i]; }
      return colKeys[0];
    })(),
    scope: 'hops',  /* all | hops | imp */
    n: 4
  };
  const host = ensureFleetOverlayHost('fleet-detail');
  host.onclick = function (e) { if (e.target === host) close(); };
  function close() { closeFleetOverlay(); if (stage) renderFleetView(stage); }
  function sysNameOf(id) { const s = g.galaxy.systems[id]; return s ? s.name : '—'; }

  function hopsTo(f, destSys) { const p = F.computePath(g.galaxy, f.location.systemId, destSys); return p ? p.length - 1 : -1; }
  function impTo(f, destSys) {
    const p = F.computePath(g.galaxy, f.location.systemId, destSys);
    if (!p || p.length < 2) return 0;
    const ms = F.fleetMinSpeed ? F.fleetMinSpeed(f) : 1;
    let t = 0; for (let i = 0; i < p.length - 1; i++) t += F.tempoLeg(g.galaxy, p[i], p[i + 1], ms);
    return Math.round(t);
  }
  function matches() {
    const destSys = g.colonies[S.destKey].systemId;
    return (g.fleets || []).filter(function (f) {
      if (f.location.systemId === destSys) return false;  /* già a destinazione */
      if (S.scope === 'all') return hopsTo(f, destSys) >= 0;
      const h = hopsTo(f, destSys);
      if (h < 0) return false;
      return (S.scope === 'hops') ? (h <= S.n) : (impTo(f, destSys) <= S.n);
    });
  }
  function render() {
    const destSys = g.colonies[S.destKey].systemId;
    const optsHtml = colKeys.map(function (k) {
      const cap = (ORION.capital && ORION.capital.isCapital(g, k)) ? ' ★' : '';
      return '<option value="' + escapeHtml(k) + '"' + (k === S.destKey ? ' selected' : '') + '>' +
        escapeHtml(systemNameFromKey(g, k)) + cap + '</option>';
    }).join('');
    const matched = matches();
    const list = matched.length
      ? '<ul class="fdetail__dest-list">' + matched.map(function (f) {
          const h = hopsTo(f, destSys);
          return '<li class="fdetail__dest"><span class="fdetail__dest-name">' + escapeHtml(f.name) + '</span>' +
            '<span class="fdetail__dest-meta">' + escapeHtml(sysNameOf(f.location.systemId)) + ' · ' +
            (h >= 0 ? h + ' hop · ' + impTo(f, destSys) + ' ' + iU() : 'irraggiungibile') + '</span></li>';
        }).join('') + '</ul>'
      : '<p class="fdetail__empty">Nessuna flotta rientra nel filtro.</p>';
    const seg = [['all', 'Tutte'], ['hops', 'Entro N hop'], ['imp', 'Entro N Ι']].map(function (s) {
      return '<button class="fdetail__seg' + (S.scope === s[0] ? ' is-active' : '') + '" data-scope="' + s[0] + '" type="button">' + s[1] + '</button>';
    }).join('');
    const numRow = (S.scope === 'all') ? '' :
      '<label class="fdetail__dwell">' + (S.scope === 'hops' ? 'Max hop' : 'Max ' + iU()) +
      ' <input type="number" data-bind="recall-n" min="1" max="' + (S.scope === 'hops' ? 30 : 2000) + '" value="' + S.n + '"></label>';
    const body =
      '<div class="fdetail__sec"><div class="fdetail__sec-h">' + uiIcon('roster', 'amber') + ' Raduno verso</div>' +
        '<select class="fdetail__select" data-bind="recall-dest">' + optsHtml + '</select></div>' +
      '<div class="fdetail__sec"><div class="fdetail__sec-h">' + uiIcon('refresh', 'cyan') + ' Ambito</div>' +
        '<div class="fdetail__seg-row">' + seg + '</div>' + numRow + '</div>' +
      '<div class="fdetail__sec"><div class="fdetail__sec-h">' + uiIcon('fleet', 'cyan') + ' Anteprima' +
        '<span class="fdetail__opt">' + matched.length + ' / ' + (g.fleets || []).length + '</span></div>' + list + '</div>';
    const footer =
      '<button class="btn btn--mini" data-action="fleet-overlay-close" type="button">Annulla</button>' +
      '<button class="btn btn--mini btn--primary btn--with-icon" data-act="recall-go" type="button"' + (matched.length ? '' : ' disabled') + '>' +
        uiIcon('refresh', 'cyan') + ' Richiama ' + matched.length + '</button>';
    host.innerHTML = '<div class="fdetail__panel" role="document">' +
      '<header class="fdetail__head"><div class="fdetail__title">' + uiIcon('fleet', 'cyan') + '<h2>Richiama flotte</h2></div>' +
        '<button class="fdetail__x btn--icon-only" data-action="fleet-overlay-close" type="button" aria-label="Chiudi">' + uiIcon('close') + '</button></header>' +
      '<div class="fdetail__body">' + body + '</div>' +
      '<div class="fdetail__foot">' + footer + '</div></div>';
    bind();
    host.hidden = false;
  }
  function bind() {
    host.querySelectorAll('[data-action="fleet-overlay-close"]').forEach(function (b) { b.addEventListener('click', close); });
    const dest = host.querySelector('[data-bind="recall-dest"]');
    if (dest) dest.addEventListener('change', function () { S.destKey = dest.value; render(); });
    host.querySelectorAll('[data-scope]').forEach(function (b) { b.addEventListener('click', function () { S.scope = b.dataset.scope; render(); }); });
    const num = host.querySelector('[data-bind="recall-n"]');
    if (num) num.addEventListener('change', function () { S.n = Math.max(1, parseInt(num.value || '1', 10) || 1); render(); });
    const go = host.querySelector('[data-act="recall-go"]');
    if (go) go.addEventListener('click', doRecall);
  }
  function doRecall() {
    const matched = matches();
    if (!matched.length) return;
    const destSys = g.colonies[S.destKey].systemId;
    let n = 0;
    matched.forEach(function (f) {
      const ord = (f.ownerColonyKey === S.destKey) ? { type: 'return' } : { type: 'move', toSysId: destSys };
      if (F.setOrder(g, f, ord).ok) n++;
    });
    pushChronicle(ORION.time.currentDS(g) + ' — Richiamo flotte: <strong>' + n + '</strong> in rotta verso <strong>' +
      escapeHtml(systemNameFromKey(g, S.destKey)) + '</strong>.', 'planet');
    persistGame(g);
    close();
  }
  render();
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

/* M17 Fase C (#83): modale crisi a scelte (l'altra metà dell'ibrido).
   Si apre su `crisis-raised` (auto-pausa) o dal pannello Dispacci. Ogni
   scelta applica le conseguenze (minacce reali via M09 + effetti soft). */
function showCrisisModal(crisisId) {
  const g = ORION.game, DP = ORION.dispatch;
  if (!g || !DP) return;
  const c = (g.crises || []).filter(function (x) { return x.id === crisisId && x.status === 'pending'; })[0];
  if (!c) return;
  if (document.querySelector('[data-crisis-modal]')) return; // evita doppioni
  if (ORION.tutorial) ORION.tutorial.fire('crises');
  const ttl = (DP.CFG && DP.CFG.CRISIS_TTL) || 60;
  const choicesHtml = c.choices.map(function (ch) {
    return '<button class="btn crisis-choice" data-crisis-choice="' + ch.id + '" type="button">' +
      '<span class="crisis-choice__label">' + escapeHtml(ch.label) + '</span>' +
      '<span class="crisis-choice__desc">' + escapeHtml(ch.desc) + '</span>' +
    '</button>';
  }).join('');
  const html =
    '<div class="battle-modal crisis-modal" data-crisis-modal>' +
      '<div class="battle-modal__panel">' +
        '<header class="battle-modal__head"><h3>' + uiIcon('warning', 'pink') + ' ' + escapeHtml(c.title) + '</h3></header>' +
        '<p class="battle-modal__text">' + escapeHtml(c.body) + '</p>' +
        '<div class="crisis-choices">' + choicesHtml + '</div>' +
        '<p class="crisis-modal__note">Decidi entro ~' + ttl + ' ' + iU() + ': altrimenti prevarrà l\'inazione. Puoi anche rimandare (✕) e rispondere dal pannello Dispacci.</p>' +
        '<button class="btn btn--mini crisis-modal__defer" data-crisis-defer type="button">Rimanda</button>' +
      '</div>' +
    '</div>';
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  const node = wrap.firstChild;
  document.body.appendChild(node);
  function close() { if (node.parentNode) node.parentNode.removeChild(node); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  node.querySelector('[data-crisis-defer]').addEventListener('click', close);
  node.querySelectorAll('[data-crisis-choice]').forEach(function (b) {
    b.addEventListener('click', function () {
      const r = DP.resolveCrisis(g, crisisId, b.dataset.crisisChoice);
      if (!r.ok) { showToast(r.reason || 'Non riuscito'); return; }
      (r.events || []).forEach(function (ev) { chronicleEvent(ev); if (DP.recordMemoria) DP.recordMemoria(g, ev); });
      pushChronicle(ORION.time.format(g.timeImpulsi) + ' — Crisi <strong>' + escapeHtml(c.title) + '</strong>: scelto "' + escapeHtml(r.label) + '".', 'civ');
      persistGame(g); close();
      renderLeftPanel();
      if (ORION._currentView === 'dispatch') { const st = document.querySelector('[data-view-stage]'); if (st) renderDispatchView(st); }
      updateGlobalResourceHud();
    });
  });
}

/* M17 Fase C (#83): popup di resoconto a fine esplorazione di un'anomalia
   (reliquia). Mette in PAUSA il gioco (stopPlay) e sintetizza le risorse
   trovate + eventuali novità. Richiesta utente: game-pause + resoconto. */
function showAnomalyRecapModal(events) {
  const g = ORION.game;
  if (!g || !events || !events.length) return;
  if (document.querySelector('[data-anomaly-recap]')) return; // niente doppioni
  if (typeof stopPlay === 'function') stopPlay();              // pausa il tempo

  const rows = events.map(function (ev) {
    const loot = ev.reward || {};
    const lootStr = Object.keys(loot).map(function (r) { return resIcon(r) + Math.round(loot[r]); }).join(' · ') || '—';
    return '<li class="recap-row">' +
      '<span class="recap-row__site">Reliquie antiche · <strong>' + escapeHtml(ev.sysName || '—') + '</strong>' +
        (ev.sysId >= 0 ? systemTagHtml(ev.sysId) : '') + '</span>' +
      '<span class="recap-row__loot">' + lootStr + '</span>' +
    '</li>';
  }).join('');

  const html =
    '<div class="battle-modal anomaly-recap" data-anomaly-recap>' +
      '<div class="battle-modal__panel">' +
        '<header class="battle-modal__head"><h3>' + uiIcon('check', 'green') + ' Esplorazione completata</h3></header>' +
        '<p class="battle-modal__text">Tracce di una civiltà perduta recuperate. Bottino portato alla colonia:</p>' +
        '<ul class="recap-list">' + rows + '</ul>' +
        '<p class="recap-note">La voce resta nella <strong>Memoria Storica</strong> e nel pannello <strong>Dispacci · Anomalie</strong>.</p>' +
        '<div class="battle-modal__sides"><button class="btn btn--primary" data-anomaly-recap-close type="button">Riprendi</button></div>' +
      '</div>' +
    '</div>';
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  const node = wrap.firstChild;
  document.body.appendChild(node);
  function close() { if (node.parentNode) node.parentNode.removeChild(node); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape' || e.key === 'Enter') close(); }
  document.addEventListener('keydown', onKey);
  node.querySelector('[data-anomaly-recap-close]').addEventListener('click', close);
  node.addEventListener('click', function (e) { if (e.target === node) close(); });
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
    /* SPOTTED — minimo: nome + sigla regione + nudge per il contatto. */
    if (rank >= KNOWLEDGE.spotted && rank < KNOWLEDGE.contacted) {
      /* Trova un loro sistema noto al giocatore (DETECTED+) per il bottone
         "Mostra sulla mappa". Nudge "early-game pacing" 2026-06-15: senza
         un appiglio visivo il "sistema da esplorare" resta opaco. */
      const knownSys = (c.systems || []).filter(function (sid) {
        const d = g.state && g.state.discovery ? g.state.discovery[sid] : 0;
        return d != null && d >= 1; /* DETECTED+ */
      });
      const focusBtn = knownSys.length
        ? '<button type="button" class="civ-card__focus" data-action="civ-focus" data-sys="' + knownSys[0] +
            '" title="Apri la mappa galassia centrata su uno dei loro sistemi">📍 Mostra sulla mappa</button>'
        : '';
      body = '<div class="civ-card__row"><span class="civ-card__k">Regione</span><span>' +
        escapeHtml(seat.name || '—') + '</span></div>' +
        '<p class="panel__note civ-card__hint">Hai avvistato un loro sistema. <strong>Esplora un loro sistema</strong> con una spedizione/flotta per stabilire un <strong>contatto formale</strong> — solo allora ottieni dossier completo, diplomazia, accordi.</p>' +
        (focusBtn ? '<div class="civ-card__actions">' + focusBtn + '</div>' : '');
    }
    /* UNKNOWN (solo 4 Costanti): mostra ruolo + hint contatto. */
    if (rank < KNOWLEDGE.spotted && factionDef) {
      body = '<p class="panel__note civ-card__hint">Fazione fissa della galassia · ruolo sempre noto. Per il dossier servono interazioni dirette.</p>';
    }
    /* CONTACTED+ — dossier base. Il grado di intel (fragmentary/partial/
       complete) attenua i dettagli per chi è stato contattato con una
       flotta esile. Default 'complete' per backward compat con civ
       contattate prima dell'introduzione del meccanismo. */
    if (rank >= KNOWLEDGE.contacted) {
      const intelLvl = c.intelLevel || 'complete';
      const intelRank = ORION.ai.intelLevelRank ? ORION.ai.intelLevelRank(intelLvl) : 3;
      const disp = Math.round(c.disposition || 0);
      const dispLabel = ORION.ai.dispositionLabel(disp);
      const pct = Math.max(0, Math.min(100, (disp + 100) / 2));
      const dispCls = disp <= -15 ? 'neg' : (disp >= 15 ? 'pos' : 'mid');
      let relChip = '', dipActions = '';
      if (DIP && intelRank >= 2) {
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
      /* Allineamento mostrato come "?" in modalità frammentaria. */
      const alignChip = (intelRank >= 2)
        ? '<span class="civ-chip civ-chip--' + c.alignment + '">' + (ALIGN_LABEL[c.alignment] || c.alignment) + '</span>'
        : '<span class="civ-chip civ-chip--unknown" title="Intel insufficiente: manda una flotta più potente">Allineamento ?</span>';

      /* Chip intel: indicatore visivo del grado di dossier ottenuto. */
      const INTEL_LABEL = { fragmentary: 'Frammentario', partial: 'Parziale', complete: 'Completo' };
      const intelChip = '<span class="civ-intel civ-intel--' + intelLvl +
        '" title="Dossier ' + escapeHtml(INTEL_LABEL[intelLvl] || intelLvl) +
        '. Aumenta la presenza nel loro sistema con una flotta più potente per affinarlo.">' +
        '⌖ ' + escapeHtml(INTEL_LABEL[intelLvl] || intelLvl) + '</span>';

      /* M11 Fase B parziale: dispaccio AI pendente — banner con accetta/rifiuta. */
      let offerHtml = '';
      if (c.pendingOffer && DIP && intelRank >= 2) {
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

      /* Sede + disposizione: visibili da partial in su. In fragmentary
         restano nascoste, sostituite da un hint. */
      const seatRow = (intelRank >= 2)
        ? '<div class="civ-card__row"><span class="civ-card__k">Sede</span><span>' +
            escapeHtml(seat.tierLabel || '—') + (seat.name ? ' · ' + escapeHtml(seat.name) : '') + '</span></div>'
        : '';
      const dispBlock = (intelRank >= 2)
        ? '<div class="civ-disp">' +
            '<div class="civ-disp__top"><span class="civ-card__k">Disposizione verso di te</span>' +
              '<span class="civ-disp__label civ-disp__label--' + dispCls + '">' + dispLabel + '</span></div>' +
            '<div class="civ-disp__bar"><span class="civ-disp__mid" aria-hidden="true"></span>' +
              '<span class="civ-disp__fill civ-disp__fill--' + dispCls + '" style="width:' + pct.toFixed(0) + '%"></span></div>' +
          '</div>'
        : '<p class="panel__note civ-card__hint">Dossier <strong>frammentario</strong>. La flotta presente ha raccolto solo l\'essenziale — ' +
            '<strong>manda una flotta più potente</strong> (corvette, fregate, navi capitali) nel loro sistema per ottenere disposizione, sede e diplomazia.</p>';

      body = '<div class="civ-card__chips">' + alignChip + relChip + fedChip + intelChip + '</div>' +
        offerHtml +
        seatRow +
        dispBlock +
        dipActions +
        ((intelRank >= 2) ? civTradeHtml(g, c) + civWasteHtml(g, c) : '');
    }
    /* KNOWN+ — vocazione + tratto + intel forza. Vincolato a intel
       'complete': anche se le interazioni promuovono a known, i dettagli
       interni richiedono una buona presenza di flotta. */
    const intelRankForExtras = ORION.ai.intelLevelRank ? ORION.ai.intelLevelRank(c.intelLevel || 'complete') : 3;
    if (rank >= KNOWLEDGE.known && intelRankForExtras >= 3) {
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

    return '<li class="civ-card civ-card--' + (c.knowledge || 'unknown') + '"' +
      ' data-civ-id="' + escapeHtml(String(c.id)) + '"' +
      ' style="--civ-color:' + escapeHtml(c.color) + '">' +
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
  /* Nudge "early-game pacing" 2026-06-15: dalle card SPOTTED, click su
     "📍 Mostra sulla mappa" porta alla mappa galassia centrata su un loro
     sistema già DETECTED dal giocatore — appiglio visivo per chi non sa
     dove vada a "esplorare un loro sistema". */
  stage.querySelectorAll('[data-action="civ-focus"]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const sid = Number(btn.dataset.sys);
      if (!Number.isFinite(sid) || sid < 0) return;
      if (g.state) g.state.selectedId = sid;
      navigateView('group');
      if (ORION.map && ORION.map.focusSystemCentered) ORION.map.focusSystemCentered(sid);
    });
  });
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
  /* #48 Fase 2b: handler export rifiuti. */
  stage.querySelectorAll('[data-action="waste-deal-open"]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const civ = (g.civs || []).filter(function (c) { return c.id === btn.dataset.civ; })[0];
      if (civ) openWasteDealPicker(civ, stage);
    });
  });
  stage.querySelectorAll('[data-action="waste-deal-cancel"]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const r = ORION.trade.cancelWasteDeal(g, btn.dataset.deal);
      if (!r.ok) { showToast(r.reason || 'Annullamento rifiutato'); return; }
      showToast('Contratto rifiuti chiuso');
      persistGame(g);
      renderCivView(stage);
    });
  });

  /* Dossier civiltà / Diplomazia da un pianeta straniero: il chiamante setta
     ORION.pendingCivFocus = civId; qui scrolliamo sulla card e la
     evidenziamo per pochi secondi. */
  const focusId = ORION.pendingCivFocus;
  ORION.pendingCivFocus = null;
  if (focusId != null) {
    const card = stage.querySelector('[data-civ-id="' + String(focusId).replace(/"/g, '\\"') + '"]');
    if (card) {
      try { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { card.scrollIntoView(); }
      card.classList.add('civ-card--focus');
      setTimeout(function () { card.classList.remove('civ-card--focus'); }, 2200);
    }
  }
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

/* #48 Fase 2b: blocco "Rifiuti" nella card civiltà (export rifiuti). */
function civWasteHtml(g, civ) {
  const T = ORION.trade;
  if (!T || !T.openWasteDeal) return '';
  const rel = ORION.diplomacy ? ORION.diplomacy.effectiveRelation(g, civ) : (civ.relation || 'peace');
  const list = T.wasteDealsForCiv(g, civ.id);
  let inner = '';
  if (list.length) {
    inner += '<ul class="agr-list">' + list.map(function (d) {
      const stCls = d.status === 'active' ? 'ok' : 'warn';
      const stLbl = d.status === 'active' ? 'attivo' : 'sospeso';
      const modLbl = d.mode === 'sell' ? 'vende (+cr)' : 'smaltisce (−cr)';
      return '<li class="agr-item">' +
        '<span class="agr-item__deal">♻ ' + d.flow + '/' + iU() + ' · ' + escapeHtml(systemNameFromKey(g, d.colonyKey)) + ' · ' + modLbl + '</span>' +
        '<span class="route-item__status is-' + stCls + '">' + stLbl + '</span>' +
        '<button class="btn btn--mini btn--danger" data-action="waste-deal-cancel" data-deal="' + d.id + '" type="button" title="Chiudi contratto">×</button>' +
      '</li>';
    }).join('') + '</ul>';
  }
  const canTrade = (rel === 'peace' || rel === 'alliance');
  if (canTrade) {
    const values = T.wasteDealValues(civ);
    inner += '<button class="btn btn--mini" data-action="waste-deal-open" data-civ="' + escapeHtml(civ.id) + '" type="button">+ Export rifiuti</button>' +
      '<p class="panel__note agr-note">' + (values ? 'Valorizza i rifiuti: <strong>li compra</strong>.' : 'Accetta i rifiuti come <strong>smaltimento a pagamento</strong>.') + '</p>';
  } else {
    inner += '<p class="panel__note agr-note">L\'export rifiuti richiede <strong>pace o alleanza</strong>.</p>';
  }
  return '<div class="civ-trade"><span class="civ-card__k">Rifiuti ♻</span>' + inner + '</div>';
}

/* Overlay scelta colonia per l'export rifiuti (#48 Fase 2b). */
function openWasteDealPicker(civ, civStage) {
  const g = ORION.game;
  const T = ORION.trade;
  if (!T) return;
  const mine = myColonyKeys().filter(function (k) {
    const c = g.colonies[k];
    return c && c.colonized && !T.wasteDealsForCiv(g, civ.id).some(function (d) { return d.colonyKey === k; });
  });
  if (!mine.length) { showToast('Nessuna colonia disponibile per un nuovo contratto'); return; }
  /* Scelta semplice: la colonia con più rifiuti accumulati. */
  let best = mine[0], bestW = -1;
  mine.forEach(function (k) {
    const w = (g.colonies[k].waste && g.colonies[k].waste.stock) || 0;
    if (w > bestW) { bestW = w; best = k; }
  });
  const r = T.openWasteDeal(g, civ.id, best);
  if (!r.ok) { showToast(r.reason); return; }
  const modLbl = r.deal.mode === 'sell' ? 'acquisto' : 'smaltimento a pagamento';
  pushChronicle(ORION.time.currentDS(g) + ' — Contratto rifiuti con <strong>' + escapeHtml(civ.name) +
    '</strong> (' + modLbl + ') da <strong>' + escapeHtml(systemNameFromKey(g, best)) + '</strong>.', 'civ');
  persistGame(g);
  if (civStage) renderCivView(civStage);
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

function systemNameFromKey(g, key) {
  const parts = (key || '').split(':');
  if (parts.length < 2) return '—';
  const sid = Number(parts[0]);
  const sys = g.galaxy && g.galaxy.systems && g.galaxy.systems[sid];
  return sys ? sys.name : ('Sistema ' + sid);
}

/* Nome del corpo celeste su cui si trova la flotta (#88 follow-up): la
   posizione precisa oltre al sistema. Ritorna null se la flotta è in orbita
   generica del sistema (nessun corpo specifico) o è in viaggio (il bodyKey
   sarebbe quello di partenza, fuorviante). */
function fleetBodyName(g, fleet) {
  if (!fleet || !fleet.location || fleet.location.status === 'in-transit') return null;
  if (!ORION.fleet || !ORION.fleet.fleetCurrentBodyKey) return null;
  if (!ORION.system || !ORION.system.generate || !ORION.system.findBody) return null;
  const sysId = fleet.location.systemId;
  if (sysId == null || sysId < 0) return null;
  const bk = ORION.fleet.fleetCurrentBodyKey(g, fleet);
  if (bk == null) return null;
  let sys; try { sys = ORION.system.generate(g.galaxy, sysId); } catch (e) { return null; }
  const b = sys ? ORION.system.findBody(sys, bk) : null;
  return b ? b.name : null;
}

/* Icona della classe nave (catalogo §12.1) con tinta flotta. */
function fleetShipIcon(kind) {
  const nm = 'ship' + kind.charAt(0).toUpperCase() + kind.slice(1);
  return uiIcon(nm, 'cyan');
}

/* =====================================================================
   NOMI FLOTTA AUTO-DERIVATI DALL'ORDINE (#88)
   Il nome non si sceglie alla creazione: si adatta all'ordine impartito
   (Esplorazione/Trasferimento/Attacco/…). Sovrascrive SOLO il default
   neutro "Squadrone N" → un nome scelto a mano dall'utente non viene mai
   toccato. Sempre rinominabile dal dettaglio flotta.
   ===================================================================== */
/* Callsign per scopo (decisione utente 2026-06-15, sostituisce i nomi
   descrittivi "Esplorazione → X"): un sostantivo militare/scenografico per
   tipo di ordine + numero progressivo. L'identità resta stabile anche se la
   flotta cambia ordine successivamente (callsign d'esordio). Sempre
   rinominabile a mano dal dettaglio (✎). */
const FLEET_CALLSIGNS = {
  'explore': 'Segugio',
  'move': 'Convoglio',
  'attack': 'Lama',
  'colonize': 'Pioniere',
  'patrol': 'Sentinella',
  'patrol-loop': 'Sentinella',
  'garrison': 'Sentinella',
  'survey': 'Vedetta',
  /* Decisione utente 2026-06-16: una flotta con scafo Estrattore in survey
     d'anomalia è di funzione "estrazione", non ricognizione → callsign
     dedicato. orderDerivedFleetName/suggestedRenameFor selezionano questa
     chiave quando la flotta porta almeno un estrattore. */
  'extract': 'Estrattore'
};
/* Pool secondario (decisione utente 2026-06-15): un secondo nome per scopo,
   proposto come DEFAULT quando l'utente rinomina manualmente. Così è "guidato
   a creare un nuovo nome+numero libero per quell'ordine" (ridefinizione
   manuale tipica dopo un cambio missione). */
const FLEET_CALLSIGNS_ALT = {
  'explore': 'Pellegrino',
  'move': 'Carovana',
  'attack': 'Lupo',
  'colonize': 'Avanguardia',
  'patrol': 'Bastione',
  'patrol-loop': 'Bastione',
  'garrison': 'Bastione',
  'survey': 'Bussola',
  'extract': 'Minatrice'
};
/* Numero progressivo per quel callsign: max suffisso numerico tra le flotte
   esistenti col prefisso "<Base> ", +1. Robusto a rinomine manuali (chi
   ribattezza "Segugio 1" → "Mia Flotta" lascia un buco, la successiva sarà
   "Segugio N+1"). */
function nextProgressiveFor(g, base) {
  const re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+(\\d+)$');
  let max = 0;
  (g.fleets || []).forEach(function (f) {
    const m = re.exec(f.name || '');
    if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; }
  });
  return max + 1;
}
/* Decisione utente 2026-06-16: una flotta in `survey` con almeno uno scafo
   Estrattore a bordo è funzionalmente in estrazione, non in ricognizione →
   chiave callsign 'extract' anziché 'survey'. Restituisce la chiave effettiva
   da usare per il pool di nomi. */
function effectiveCallsignKey(fleet, order) {
  if (!order || !order.type) return null;
  if (order.type === 'survey' && fleet && Array.isArray(fleet.ships)) {
    for (let i = 0; i < fleet.ships.length; i++) {
      if (fleet.ships[i] && fleet.ships[i].kind === 'estrattore') return 'extract';
    }
  }
  return order.type;
}
function orderDerivedFleetName(g, order, fleet) {
  if (!order || !order.type) return null;
  let base = null;
  if (order.type === 'move-route') {
    /* esplora-ogni-tappa → Segugio; rotta cargo/movimento → Convoglio */
    base = order.exploreEach ? 'Segugio' : 'Convoglio';
  } else {
    base = FLEET_CALLSIGNS[effectiveCallsignKey(fleet, order)] || null;
  }
  if (!base) return null;   // 'return' e tipi sconosciuti → nessun ribattesimo
  return base + ' ' + nextProgressiveFor(g, base);
}
function isDefaultFleetName(name) { return /^Squadrone\s+\d+$/.test(name || ''); }
function maybeAutoRenameFleet(g, fleet, order) {
  if (!fleet || !isDefaultFleetName(fleet.name)) return;
  const nm = orderDerivedFleetName(g, order, fleet);
  if (nm) fleet.name = nm.slice(0, 40);
}
/* Suggerimento di rinomina manuale (decisione utente 2026-06-15): propone il
   pool ALT del tipo di ordine corrente + primo numero libero. È solo un
   default pre-popolato nell'input ✎ — l'utente è libero di modificare. Per
   ordini idle/return o sconosciuti restituisce null (l'input resta sul nome
   corrente). */
function suggestedRenameFor(g, fleet) {
  const order = fleet && fleet.orders;
  if (!order || !order.type || order.type === 'idle' || order.type === 'return') return null;
  let base = null;
  if (order.type === 'move-route') {
    base = order.exploreEach ? FLEET_CALLSIGNS_ALT['explore'] : FLEET_CALLSIGNS_ALT['move'];
  } else {
    base = FLEET_CALLSIGNS_ALT[effectiveCallsignKey(fleet, order)] || null;
  }
  if (!base) return null;
  return base + ' ' + nextProgressiveFor(g, base);
}

/* =====================================================================
   GESTIONE FLOTTE IN VOLO (#88) — strada alternativa al "Crea flotta".
   Due modi:
   (a) Flotte già INSIEME (stesso sistema, nessuna in viaggio) → smista
       navi/equipaggi tra loro o fondile subito.
   (b) Flotte SPARSE → scegli un punto d'incontro: annulla gli ordini
       correnti e le convoglia lì (con conferma), dove poi le fonderai.
   Riusa l'overlay flotta. Nessuna logica di creazione: solo smistamento.
   ===================================================================== */
function openFleetManageInFlight() {
  const g = ORION.game;
  if (!g || !Array.isArray(g.fleets)) return;
  /* Usa la classe `fleet-detail` (stesso stile overlay full-screen +
     gestione `[hidden]` di .fleet-create-overlay/.fleet-wizard/.fleet-detail
     in css/style.css). Una classe a sé `fleet-manage` non aveva regole CSS
     → l'host esisteva nel DOM ma non era visibile (fix PR #205 → segnalato
     dall'utente: "Gestione flotte non attiva nulla"). */
  const host = ensureFleetOverlayHost('fleet-detail');
  host.onclick = function (e) { if (e.target === host) close(); };
  const M = { keep: {}, selected: {}, rendezSys: '' };

  function close() {
    closeFleetOverlay();
    const stage = document.querySelector('[data-view-stage]');
    if (stage && stage.querySelector('.fleet-view')) renderFleetView(stage);
  }
  function sysName(id) { const s = g.galaxy.systems[id]; return s ? s.name : '—'; }
  function head(icon, tone, title) {
    return '<div class="fdetail__sec-h">' + uiIcon(icon, tone) + ' ' + escapeHtml(title) + '</div>';
  }

  function render() {
    const fleets = g.fleets || [];
    /* Con <2 flotte non c'è nulla da smistare/fondere: spiega (anziché un
       bottone disabilitato muto) ed elenca le flotte presenti — così la
       flotta in esplorazione è visibilmente conteggiata (#88 follow-up). */
    const fewNote = (fleets.length < 2)
      ? '<p class="fdetail__hint">' + uiIcon('info', 'soft') + ' Per smistare navi/equipaggi o fondere flotte ne servono almeno <strong>2</strong>. ' +
        'Le tue flotte (anche quelle in esplorazione/viaggio) sono elencate qui sotto.</p>'
      : '';
    /* Gruppi co-localizzati (≥2 flotte, nessuna in transito). */
    const bySys = {};
    fleets.forEach(function (f) {
      if (!f.location || f.location.status === 'in-transit') return;
      (bySys[f.location.systemId] = bySys[f.location.systemId] || []).push(f);
    });
    const coGroups = Object.keys(bySys).filter(function (s) { return bySys[s].length >= 2; });

    /* --- Sezione "insieme adesso" --- */
    let togetherHtml;
    if (!coGroups.length) {
      togetherHtml = '<div class="fdetail__sec">' + head('fleet', 'cyan', 'Flotte insieme') +
        '<p class="fdetail__empty">Nessun gruppo di flotte nello stesso sistema. Usa il rendezvous qui sotto per convogliarle.</p></div>';
    } else {
      togetherHtml = coGroups.map(function (s) {
        const arr = bySys[s];
        if (!M.keep[s] || !findFleet(M.keep[s]) || arr.indexOf(findFleet(M.keep[s])) < 0) M.keep[s] = arr[0].id;
        const keepOpts = arr.map(function (f) {
          return '<option value="' + escapeHtml(f.id) + '"' + (f.id === M.keep[s] ? ' selected' : '') + '>' + escapeHtml(f.name) + '</option>';
        }).join('');
        const others = arr.filter(function (f) { return f.id !== M.keep[s]; });
        const rows = others.map(function (f) {
          const counter = {}; f.ships.forEach(function (sh) { counter[sh.kind] = (counter[sh.kind] || 0) + 1; });
          const shipBtns = Object.keys(counter).map(function (k) {
            const cls = ORION.fleet.getClass(k) || { name: k };
            return '<button class="btn btn--mini" data-xfer-ship="' + escapeHtml(f.id) + '" data-kind="' + escapeHtml(k) + '" data-sys="' + s + '" type="button" title="Trasferisci una ' + escapeHtml(cls.name) + ' alla destinazione">' +
              fleetShipIcon(k) + ' ' + counter[k] + ' →</button>';
          }).join('');
          const crewBtn = (f.crew && f.crew.length) ?
            '<button class="btn btn--mini" data-xfer-crew="' + escapeHtml(f.id) + '" data-sys="' + s + '" type="button" title="Trasferisci un equipaggio alla destinazione">' +
              uiIcon('forces', 'amber') + ' ' + f.crew.length + ' →</button>' : '';
          return '<div class="fmanage__row">' +
            '<span class="fmanage__name">' + uiIcon('fleet', 'cyan') + ' ' + escapeHtml(f.name) + '</span>' +
            '<span class="fmanage__btns">' + shipBtns + crewBtn +
              '<button class="btn btn--mini btn--primary" data-merge="' + escapeHtml(f.id) + '" data-sys="' + s + '" type="button">Fondi →</button>' +
            '</span></div>';
        }).join('');
        return '<div class="fdetail__sec">' + head('system', 'amber', sysName(Number(s))) +
          '<label class="fmanage__keep">Destinazione <select class="fdetail__select" data-keep-sys="' + s + '">' + keepOpts + '</select></label>' +
          (rows || '<p class="fdetail__hint">—</p>') +
          '<p class="fdetail__hint">"→" sposta 1 unità verso la destinazione · "Fondi" sposta tutto e scioglie la flotta.</p>' +
        '</div>';
      }).join('');
    }

    /* --- Sezione rendezvous --- */
    const cand = {};
    fleets.forEach(function (f) { if (f.location && f.location.systemId >= 0) cand[f.location.systemId] = true; });
    Object.keys(g.colonies).forEach(function (k) { const c = g.colonies[k]; if (c && c.colonized && c.systemId >= 0) cand[c.systemId] = true; });
    const candIds = Object.keys(cand).map(Number).sort(function (a, b) { return sysName(a).localeCompare(sysName(b)); });
    if ((!M.rendezSys || cand[M.rendezSys] == null) && candIds.length) M.rendezSys = String(candIds[0]);
    const rzOpts = candIds.map(function (id) {
      return '<option value="' + id + '"' + (String(id) === M.rendezSys ? ' selected' : '') + '>' + escapeHtml(sysName(id)) + '</option>';
    }).join('');
    const flChecks = fleets.map(function (f) {
      const checked = M.selected[f.id] ? ' checked' : '';
      const loc = (f.location && f.location.status === 'in-transit')
        ? ('in viaggio · ' + (f.etaImpulsi | 0) + ' ' + iU())
        : ('in ' + escapeHtml(sysName(f.location.systemId)));
      return '<label class="fmanage__check"><input type="checkbox" data-sel="' + escapeHtml(f.id) + '"' + checked + '> ' +
        '<strong>' + escapeHtml(f.name) + '</strong> <span class="fmanage__loc">' + loc + '</span></label>';
    }).join('');
    const nSel = Object.keys(M.selected).filter(function (k) { return M.selected[k]; }).length;
    const rendezHtml = '<div class="fdetail__sec">' + head('fleet', 'cyan', 'Convoglia flotte sparse') +
      (fleets.length ? '<div class="fmanage__checks">' + flChecks + '</div>' : '<p class="fdetail__empty">Nessuna flotta.</p>') +
      (candIds.length ? '<label class="fmanage__keep">Punto d’incontro <select class="fdetail__select" data-bind="rendez-sys">' + rzOpts + '</select></label>' : '') +
      '<button class="btn btn--mini btn--primary btn--with-icon" data-act="rendez" type="button"' + (nSel < 1 ? ' disabled' : '') + '>' +
        uiIcon('fleet', 'cyan') + ' Convoglia le selezionate (' + nSel + ')</button>' +
      '<p class="fdetail__hint">Annulla gli ordini correnti delle flotte scelte e le invia al punto d’incontro. Lì potrai fonderle.</p>' +
    '</div>';

    host.innerHTML =
      '<div class="fdetail__panel" role="document">' +
        '<header class="fdetail__head"><div class="fdetail__title">' + uiIcon('fleet', 'cyan') +
          '<h2>Gestione flotte in volo</h2></div>' +
          '<button class="fdetail__x btn--icon-only" data-act="close" type="button" aria-label="Chiudi">' + uiIcon('close') + '</button></header>' +
        '<div class="fdetail__body">' + fewNote + togetherHtml + rendezHtml + '</div>' +
        '<div class="fdetail__foot"><button class="btn btn--mini btn--primary" data-act="close" type="button">Chiudi</button></div>' +
      '</div>';
    bind();
    host.hidden = false;
  }

  function bind() {
    host.querySelectorAll('[data-act="close"]').forEach(function (b) { b.addEventListener('click', close); });
    host.querySelectorAll('[data-keep-sys]').forEach(function (sel) {
      sel.addEventListener('change', function () { M.keep[sel.dataset.keepSys] = sel.value; render(); });
    });
    host.querySelectorAll('[data-xfer-ship]').forEach(function (b) {
      b.addEventListener('click', function () {
        const from = findFleet(b.dataset.xferShip); const to = findFleet(M.keep[b.dataset.sys]);
        const r = ORION.fleet.transferShips(g, from, to, b.dataset.kind, 1);
        if (!r.ok) { showToast(r.reason); return; } persistGame(g); render();
      });
    });
    host.querySelectorAll('[data-xfer-crew]').forEach(function (b) {
      b.addEventListener('click', function () {
        const from = findFleet(b.dataset.xferCrew); const to = findFleet(M.keep[b.dataset.sys]);
        const r = ORION.fleet.transferCrew(g, from, to, 1);
        if (!r.ok) { showToast(r.reason); return; } persistGame(g); render();
      });
    });
    host.querySelectorAll('[data-merge]').forEach(function (b) {
      b.addEventListener('click', function () {
        const from = findFleet(b.dataset.merge); const to = findFleet(M.keep[b.dataset.sys]);
        if (!from || !to) return;
        if (!window.confirm('Fondere «' + from.name + '» in «' + to.name + '»? La prima verrà sciolta e le sue navi/equipaggi/figure passeranno alla seconda.')) return;
        const r = ORION.fleet.mergeFleets(g, from, to);
        if (!r.ok) { showToast(r.reason); return; }
        pushChronicle(ORION.time.currentDS(g) + ' — Flotte unite in <strong>' + escapeHtml(to.name) + '</strong>.', 'planet');
        persistGame(g); render();
      });
    });
    host.querySelectorAll('[data-sel]').forEach(function (c) {
      c.addEventListener('change', function () { M.selected[c.dataset.sel] = c.checked; render(); });
    });
    const rz = host.querySelector('[data-bind="rendez-sys"]');
    if (rz) rz.addEventListener('change', function () { M.rendezSys = rz.value; });
    const rzBtn = host.querySelector('[data-act="rendez"]');
    if (rzBtn) rzBtn.addEventListener('click', function () {
      const sysId = Number(M.rendezSys);
      const sel = Object.keys(M.selected).filter(function (k) { return M.selected[k]; }).map(findFleet).filter(Boolean);
      if (!sel.length) return;
      const toMove = sel.filter(function (f) { return !(f.location && f.location.systemId === sysId && f.location.status !== 'in-transit'); });
      if (!toMove.length) { showToast('Le flotte scelte sono già al punto d’incontro'); return; }
      if (!window.confirm('Convogliare ' + toMove.length + ' flotta/e a «' + sysName(sysId) + '»? Gli ordini correnti verranno annullati.')) return;
      let ok = 0, fail = 0;
      toMove.forEach(function (f) {
        const r = ORION.fleet.setOrder(g, f, { type: 'move', toSysId: sysId });
        if (r.ok) { maybeAutoRenameFleet(g, f, { type: 'move', toSysId: sysId }); ok++; } else fail++;
      });
      if (ok) pushChronicle(ORION.time.currentDS(g) + ' — ' + ok + ' flotta/e convogliata/e verso <strong>' + escapeHtml(sysName(sysId)) + '</strong>.', 'explore');
      if (fail) showToast(fail + ' flotta/e non convogliabile/i (rotta o equipaggio).');
      M.selected = {};
      persistGame(g); render();
    });
  }

  render();
}

/* =====================================================================
   DETTAGLIO FLOTTA — pannello unico (richiesta utente 2026-06-13).
   Sostituisce i 3 overlay slegati (Crea flotta / Gestisci navi-eq. /
   Wizard ordini) e il roster di bottoni sulla card. UN solo pannello a
   tema raggruppa, per una flotta: posizione in tempo reale (dove si trova
   in quell'Impulso), ordine da impartire (builder inline), composizione
   navi+equipaggio, formazione, ufficiali, coloni a bordo, viveri.
   La pagina principale resta un riepilogo di card cliccabili senza
   bottoni. fleetId === null → modalità "nuova flotta".
   ===================================================================== */
function openFleetDetail(fleetId, opts) {
  opts = opts || {};
  const g = ORION.game;
  if (!g) return;
  if (!Array.isArray(g.fleets)) g.fleets = [];
  let fleet = fleetId ? findFleet(fleetId) : null;

  if (ORION.tutorial) ORION.tutorial.fire('fleet-classes');

  /* Stato del pannello (closure): builder ordine + modalità "nuova". */
  const D = {
    newColonyKey: null,
    /* Carrello composizione della modalità "nuova" (#88): la flotta non
       viene materializzata finché non confermi. `crew` = lista di id
       equipaggio scelti per grado (mutua i chip della tab Esplorazione).
       `creating`: vero finché la flotta non è stata materializzata —
       composizione + ordine vivono nella stessa schermata, un unico
       "Crea e parti" atomicizza tutto. */
    draft: { ships: {}, crew: [] },
    creating: !fleet,
    /* Stadio 3: destinazione/missione pre-compilate da mappa (ingresso
       destination-first). null → renderNew sceglie il default. */
    dest: opts.dest ? { sysId: opts.dest.sysId, bodyKey: opts.dest.bodyKey || null } : null,
    mission: opts.mission || null,
    renaming: false,
    ordOpen: !!opts.orders,
    ord: { tripType: null, target: null, waypoints: [], opt: { returnHome: false, exploreEach: false } }
  };

  const host = ensureFleetOverlayHost('fleet-detail');
  host.onclick = function (e) { if (e.target === host) closeDetail(); };

  function closeDetail() {
    closeFleetOverlay();
    const stage = document.querySelector('[data-view-stage]');
    if (stage && stage.querySelector('.fleet-view')) renderFleetView(stage);
  }

  /* ---- helpers locali ---- */
  function sysName(id) { const s = g.galaxy.systems[id]; return s ? s.name : '—'; }
  function statusLabel(f) {
    const loc = f && f.location; if (!loc) return '—';
    if (loc.status === 'in-transit') return 'in viaggio · ' + (f.etaImpulsi | 0) + ' ' + iU();
    return ORION.fleet.berthLabel(ORION.fleet.berthOf(g, f));
  }
  function orderLabel(f) {
    const o = f && f.orders;
    if (!o || o.type === 'idle') {
      if (f && f.location && f.location.status === 'orbiting') return '⏸ in sosta a ' + sysName(f.location.systemId);
      return 'in attesa di ordini';
    }
    if (o.type === 'move') return 'rotta → ' + sysName(o.toSysId);
    if (o.type === 'attack') return 'attacco → ' + sysName(o.toSysId);
    if (o.type === 'explore') return 'esplorazione → ' + sysName(o.toSysId);
    if (o.type === 'survey') return 'anomalia → ' + sysName(o.toSysId);
    if (o.type === 'return') return 'rientro alla base';
    if (o.type === 'patrol') return 'pattuglia ' + sysName(o.sysA) + ' ↔ ' + sysName(o.sysB);
    if (o.type === 'move-route') return 'rotta a tappe (' + ((o.wpIdx || 0) + 1) + '/' + (o.waypoints || []).length + ')';
    if (o.type === 'patrol-loop') return 'pattuglia ciclica · ' + (o.loop || []).length + ' nodi';
    return o.type;
  }
  function eligibleColonies() {
    const out = [];
    Object.keys(g.colonies).forEach(function (k) {
      const c = g.colonies[k];
      if (c && c.colonized && c.structures && c.structures['cantiere-navale']) out.push(k);
    });
    return out;
  }

  /* ---- shell ---- */
  function shell(title, sub, body, footer) {
    return '<div class="fdetail__panel" role="document">' +
      '<header class="fdetail__head">' +
        '<div class="fdetail__title">' + uiIcon('fleet', 'cyan') +
          '<h2>' + escapeHtml(title) + '</h2>' +
          (sub ? '<span class="fdetail__sub">' + sub + '</span>' : '') +
        '</div>' +
        '<button class="fdetail__x btn--icon-only" data-action="fleet-overlay-close" type="button" aria-label="Chiudi">' +
          uiIcon('close') + '</button>' +
      '</header>' +
      '<div class="fdetail__body">' + body + '</div>' +
      (footer ? '<div class="fdetail__foot">' + footer + '</div>' : '') +
    '</div>';
  }
  function secHead(icon, tone, title, extra) {
    return '<div class="fdetail__sec-h">' + uiIcon(icon, tone) + ' ' + title +
      (extra ? ' <span class="fdetail__opt">' + extra + '</span>' : '') + '</div>';
  }

  function render() {
    if (D.creating) {
      /* Stub di flotta-bozza: stesso shape della flotta reale (location,
         ships, crew) così riusiamo `renderDestArea`/`renderOrdOpts`/
         `buildOrder` come per le flotte esistenti. Non viene mai pushato
         in g.fleets: vive solo nella closure finché non si conferma. */
      fleet = buildDraftFleet();
    }
    host.innerHTML = D.creating ? renderNew() : renderExisting();
    bind();
    host.hidden = false;
  }

  /* Costruisce una flotta-bozza dai dati del carrello (D.draft) ancorata
     alla colonia origine scelta (D.newColonyKey, status 'docked'). */
  function buildDraftFleet() {
    const elig = eligibleColonies();
    if (D.newColonyKey == null || elig.indexOf(D.newColonyKey) < 0) {
      D.newColonyKey = elig[0] || null;
    }
    const ck = D.newColonyKey;
    const col = ck ? g.colonies[ck] : null;
    const sysId = col ? col.systemId : 0;
    const ships = [];
    Object.keys(D.draft.ships || {}).forEach(function (k) {
      const n = D.draft.ships[k] || 0;
      for (let i = 0; i < n; i++) ships.push({ kind: k });
    });
    return {
      id: '__draft__',
      name: 'Nuova flotta',
      ownerColonyKey: ck,
      location: { systemId: sysId, status: 'docked' },
      ships: ships,
      crew: (D.draft.crew || []).slice(),
      orders: null,
      formation: 'balanced',
      /* Capienza serbatoio configurabile alla partenza (slider): se
         l'utente l'ha toccata vive in D.draft.viveriCap, altrimenti
         viveriCapOf restituirà il default. `viveri` = pieno (la flotta
         nasce al porto amico, carica al cap). */
      viveriCap: (D.draft.viveriCap != null) ? D.draft.viveriCap : undefined,
      viveri: (D.draft.viveriCap != null) ? D.draft.viveriCap : undefined
    };
  }

  /* ===== Modalità nuova (#88: composizione nella creazione) =====
     Scegli colonia + navi + equipaggio in un "carrello" e vedi subito le
     disponibilità: la flotta è materializzata SOLO su Conferma (Annulla
     non crea nulla → niente flotta-fantasma da dissolvere). Il nome non
     si sceglie qui: si adatta all'ordine che darai (sempre rinominabile). */
  function renderNew() {
    const elig = eligibleColonies();
    if (!elig.length) {
      return shell('Nuova flotta', null,
        '<p class="fdetail__hint">' + uiIcon('warning', 'gold') + ' Serve una colonia con <strong>Hangar di costruzione</strong> per formare una flotta.</p>',
        '<button class="btn btn--mini" data-action="fleet-overlay-close" type="button">Chiudi</button>');
    }
    /* ===== DESTINAZIONE (primo concetto, Stadio 2.3a) ===== */
    const DISC = (ORION.galaxy && ORION.galaxy.DISCOVERY) || { DETECTED: 1, EXPLORED: 2 };
    const disc = (g.state && g.state.discovery) || {};
    function capSysId() {
      let hk = null;
      Object.keys(g.colonies).forEach(function (k) { if (g.colonies[k] && g.colonies[k].isHomeBase) hk = k; });
      return hk ? Number(String(hk).split(':')[0]) : ((g.galaxy && g.galaxy.homeId) || 0);
    }
    function sysDist(a, b) {
      const A = g.galaxy.systems[a], B = g.galaxy.systems[b];
      if (!A || !B) return Infinity;
      const dx = (A.x || 0) - (B.x || 0), dy = (A.y || 0) - (B.y || 0), dz = (A.z || 0) - (B.z || 0);
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    function knownCivsInSystem(sysId) {
      const out = [];
      (g.civs || []).forEach(function (c) {
        if (!c || !c.alive || !Array.isArray(c.systems)) return;
        if (c.systems.indexOf(sysId) < 0) return;
        const rank = (ORION.ai && ORION.ai.knowledgeRank) ? ORION.ai.knowledgeRank(c) : 2;
        if (rank >= 1) out.push(c);
      });
      if (!out.length && ORION.ai && ORION.ai.civForSystem) {
        const c = ORION.ai.civForSystem(g, sysId);
        const rank = (c && ORION.ai.knowledgeRank) ? ORION.ai.knowledgeRank(c) : 0;
        if (c && c.alive && rank >= 1) out.push(c);
      }
      return out;
    }
    function civKnownName(c) {
      const rank = (ORION.ai && ORION.ai.knowledgeRank) ? ORION.ai.knowledgeRank(c) : 2;
      return rank >= 2 ? c.name : 'Ignota';
    }
    const capId = capSysId();
    /* Distanza dalla capitale in SALTI (BFS sul grafo), per ordinare e mostrare. */
    function hopsFromCap(s) {
      if (s === capId) return 0;
      const p = ORION.fleet.computePath ? ORION.fleet.computePath(g.galaxy, capId, s) : null;
      return p ? (p.length - 1) : null;
    }
    const knownSys = [];
    for (let i = 0; i < g.galaxy.systems.length; i++) { if ((disc[i] || 0) >= DISC.DETECTED) knownSys.push(i); }
    const hopsMap = {};
    knownSys.forEach(function (s) { hopsMap[s] = hopsFromCap(s); });
    knownSys.sort(function (a, b) {
      const ha = hopsMap[a] == null ? 1e9 : hopsMap[a];
      const hb = hopsMap[b] == null ? 1e9 : hopsMap[b];
      if (ha !== hb) return ha - hb;
      return sysDist(capId, a) - sysDist(capId, b);
    });
    if (!D.dest) D.dest = { sysId: null, bodyKey: null };
    if (D.dest.sysId == null || (disc[D.dest.sysId] || 0) < DISC.DETECTED) {
      const nonCap = knownSys.filter(function (s) { return s !== capId; });
      D.dest.sysId = nonCap.length ? nonCap[0] : (knownSys.length ? knownSys[0] : capId);
      D.dest.bodyKey = null;
    }

    if (!D.newColonyKey || elig.indexOf(D.newColonyKey) < 0) {
      /* Origine di default = colonia idonea più vicina alla destinazione. */
      D.newColonyKey = elig.slice().sort(function (a, b) {
        return sysDist(Number(String(a).split(':')[0]), D.dest.sysId) -
               sysDist(Number(String(b).split(':')[0]), D.dest.sysId);
      })[0];
      D.draft = { ships: {}, crew: [] };
    }
    if (!D.draft) D.draft = { ships: {}, crew: [] };
    if (!Array.isArray(D.draft.crew)) D.draft.crew = [];
    const colony = g.colonies[D.newColonyKey];
    if (colony && ORION.fleet.ensureColonyShipKinds) ORION.fleet.ensureColonyShipKinds(colony);
    /* Origine in due passi (feedback utente): SISTEMA a sx, COLONIA a dx —
       gestisce il caso di più colonie nello stesso sistema. */
    function sysIdOf(k) { return Number(String(k).split(':')[0]); }
    function colonyLabel(k) {
      const parts = String(k).split(':'); const sid = Number(parts[0]); const bk = parts[1];
      try {
        const sys = ORION.system.generate(g.galaxy, sid);
        const pl = ORION.planet.generate(g.galaxy, sys, bk);
        if (pl && pl.name) return pl.name;
      } catch (e) { /* fallback */ }
      return 'Corpo ' + bk;
    }
    const curSysId = sysIdOf(D.newColonyKey);
    /* Sistemi distinti con colonia idonea, ordinati per vicinanza alla
       destinazione (le navi dalle colonie più vicine — feedback utente). */
    const sysIds = [];
    elig.forEach(function (k) { const s = sysIdOf(k); if (sysIds.indexOf(s) < 0) sysIds.push(s); });
    sysIds.sort(function (a, b) { return sysDist(a, D.dest.sysId) - sysDist(b, D.dest.sysId); });
    const sysOptsHtml = sysIds.map(function (s) {
      const nm = (g.galaxy.systems[s] && g.galaxy.systems[s].name) || ('Sistema ' + s);
      return '<option value="' + s + '"' + (s === curSysId ? ' selected' : '') + '>' + escapeHtml(nm) + '</option>';
    }).join('');
    /* Colonie idonee nel sistema scelto. */
    const colsInSys = elig.filter(function (k) { return sysIdOf(k) === curSysId; });
    const colOptsHtml = colsInSys.map(function (k) {
      return '<option value="' + escapeHtml(k) + '"' + (k === D.newColonyKey ? ' selected' : '') + '>' +
        escapeHtml(colonyLabel(k)) + '</option>';
    }).join('');
    const multiCol = colsInSys.length > 1;

    /* Composizione navi — due pannelli (a disposizione → in flotta), click
       per spostare un'unità (Stadio 2.2, niente drag&drop: parità touch).
       Riusa gli handler data-draft-ship-add/rem (già wired). */
    let availTiles = '', fleetTiles = '';
    ORION.fleet.classList().forEach(function (cls) {
      const avail = (colony && colony.ships[cls.id]) || 0;
      const inCart = D.draft.ships[cls.id] || 0;
      const ground = avail - inCart;
      if (avail <= 0 && inCart <= 0) return;
      if (ground > 0) {
        availTiles +=
          '<button class="fcompose__tile" type="button" data-draft-ship-add="' + cls.id + '" ' +
            'title="Aggiungi ' + escapeHtml(cls.name) + ' alla flotta">' +
            '<span class="fcompose__glyph">' + fleetShipIcon(cls.id) + '</span>' +
            '<span class="fcompose__name">' + escapeHtml(cls.name) + '</span>' +
            '<span class="fcompose__cnt">×' + ground + '</span></button>';
      }
      if (inCart > 0) {
        fleetTiles +=
          '<button class="fcompose__tile is-active" type="button" data-draft-ship-rem="' + cls.id + '" ' +
            'title="Togli ' + escapeHtml(cls.name) + ' dalla flotta">' +
            '<span class="fcompose__glyph">' + fleetShipIcon(cls.id) + '</span>' +
            '<span class="fcompose__name">' + escapeHtml(cls.name) + '</span>' +
            '<span class="fcompose__cnt">×' + inCart + '</span></button>';
      }
    });
    if (!availTiles) availTiles = '<p class="fdetail__empty">Nessuna nave a terra: costruiscile all’Hangar di questa colonia.</p>';
    if (!fleetTiles) fleetTiles = '<p class="fcompose__empty">Clicca una nave a sinistra per aggiungerla.</p>';
    const shipRows =
      '<div class="fcompose">' +
        '<div class="fcompose__col">' +
          '<div class="fcompose__col-h">A disposizione</div>' +
          '<div class="fcompose__list">' + availTiles + '</div>' +
        '</div>' +
        '<div class="fcompose__arrow" aria-hidden="true">▸</div>' +
        '<div class="fcompose__col">' +
          '<div class="fcompose__col-h">In flotta</div>' +
          '<div class="fcompose__list fcompose__list--fleet">' + fleetTiles + '</div>' +
        '</div>' +
      '</div>';

    /* Fabbisogno equipaggio (calcolato prima dei chip per il cap di selezione). */
    let nShips = 0, crewReq = 0;
    Object.keys(D.draft.ships).forEach(function (k) {
      const n = D.draft.ships[k] || 0; nShips += n;
      const cls = ORION.fleet.getClass(k); crewReq += (cls && cls.crew ? cls.crew : 0) * n;
    });

    /* Equipaggio — selezione PER GRADO (mutua i chip della tab Esplorazione,
       #76): vedi quali livelli hai e quanti, e scegli QUALI imbarcare. */
    const crewList = (colony && colony.crews && Array.isArray(colony.crews.explorer)) ? colony.crews.explorer.slice() : [];
    /* Pulisci selezioni non più disponibili (es. cambio colonia). */
    D.draft.crew = D.draft.crew.filter(function (id) { return crewList.some(function (c) { return c.id === id; }); });
    function crewGradeLabel(xp) {
      return (ORION.expedition && ORION.expedition.enrichmentForXp) ? ORION.expedition.enrichmentForXp(xp).label : ('xp ' + xp);
    }
    /* Inventario per grado di ciò che è a terra (quanti di quel livello). */
    const byGrade = {};
    crewList.forEach(function (c) { const l = crewGradeLabel(c.xp || 0); byGrade[l] = (byGrade[l] || 0) + 1; });
    const invLine = Object.keys(byGrade).length
      ? '<div class="fcrew-inv">A terra: ' + Object.keys(byGrade).map(function (l) {
          return '<span class="fcrew-inv__item">' + escapeHtml(l) + ' ×' + byGrade[l] + '</span>';
        }).join('') + '</div>'
      : '';
    const crewSel = D.draft.crew.length;
    /* Cap selezione: non si imbarca piu' equipaggio di quanto serve alle navi
       scelte (0 navi → nessuna selezione). I chip non selezionati si bloccano
       una volta raggiunto il fabbisogno; quelli selezionati restano (per togliere). */
    const crewAtCap = crewReq <= 0 || crewSel >= crewReq;
    const crewChips = crewList.slice().sort(function (a, b) { return (b.xp || 0) - (a.xp || 0); }).map(function (c) {
      const sel = D.draft.crew.indexOf(c.id) >= 0;
      const lbl = crewGradeLabel(c.xp || 0);
      const lockAdd = !sel && crewAtCap;
      const tip = lockAdd
        ? (crewReq <= 0 ? 'Aggiungi prima una nave' : 'Equipaggio già al completo per le navi scelte')
        : ((sel ? 'Rimuovi dalla flotta' : 'Imbarca') + ' · ' + lbl + ' · xp ' + (c.xp || 0));
      return '<button class="exp-crew-chip' + (sel ? ' is-selected' : '') + '" type="button" data-draft-crew-toggle="' + escapeHtml(String(c.id)) + '"' +
        (lockAdd ? ' disabled' : '') + ' title="' + escapeHtml(tip) + '">' +
        '<span class="exp-crew-chip__rank">' + escapeHtml(lbl) + '</span>' +
        '<span class="exp-crew-chip__xp">xp ' + (c.xp || 0) + '</span></button>';
    }).join('');
    const crewBody = crewList.length
      ? invLine + '<div class="exp-crew-select fcrew-pick">' + crewChips + '</div>'
      : '<p class="fdetail__empty">Nessun equipaggio a terra: formane in <em>Accademia militare</em>.</p>';

    /* Riepilogo: stato equipaggio (nShips/crewReq calcolati sopra). */
    const crewOk = crewSel >= crewReq;
    const sumChips =
      '<span class="fdetail__sumchip">' + nShips + ' navi</span>' +
      '<span class="fdetail__sumchip ' + (crewOk ? 'is-ok' : 'is-warn') + '" title="Equipaggio richiesto per gli ordini di movimento">' +
        (crewOk ? '✓' : '⚠') + ' eq. ' + crewSel + '/' + crewReq + '</span>';

    /* ===== Sezione DESTINAZIONE (primo passo, Stadio 2.3a) ===== */
    const destSysOpts = knownSys.map(function (s) {
      const nm = (g.galaxy.systems[s] && g.galaxy.systems[s].name) || ('Sistema ' + s);
      const h = hopsMap[s];
      const hop = (h === 0) ? 'capitale' : (h != null ? (h + ' salti') : 'irr.');
      const cn = knownCivsInSystem(s).length;
      return '<option value="' + s + '"' + (s === D.dest.sysId ? ' selected' : '') + '>' +
        escapeHtml(nm) + ' · ' + hop + (cn ? ' · ' + cn + ' AI' : '') + '</option>';
    }).join('');
    /* Selettore corpi: pianeti + LUNE (annidate in body.moons) + giganti/cinture,
       differenziati per tipo con glifo (Stadio 2.3b, feedback utente). */
    function bodyTypeGlyph(type) {
      const d = ORION.system && ORION.system.BODY_TYPES ? ORION.system.BODY_TYPES[type] : null;
      const cat = d ? d.cat : '';
      return cat === 'gas' ? '⬡' : cat === 'belt' ? '≈' : cat === 'moon' ? '◌' : '◉';
    }
    function bodyTypeLabel(type) {
      const d = ORION.system && ORION.system.BODY_TYPES ? ORION.system.BODY_TYPES[type] : null;
      return d ? d.label : type;
    }
    function bodyOption(b, isMoon) {
      const g0 = bodyTypeGlyph(b.type);
      const pre = isMoon ? '  ' : '';
      return '<option value="' + escapeHtml(b.key) + '"' + (String(D.dest.bodyKey || '') === String(b.key) ? ' selected' : '') + '>' +
        pre + g0 + ' ' + escapeHtml(b.name || b.key) + ' · ' + escapeHtml(bodyTypeLabel(b.type)) + '</option>';
    }
    let destBodyHtml = '';
    const destExplored = (disc[D.dest.sysId] || 0) >= DISC.EXPLORED;
    if (destExplored && ORION.system && ORION.system.generate) {
      let dbodies = [];
      try { const dsys = ORION.system.generate(g.galaxy, D.dest.sysId); dbodies = (dsys && dsys.bodies) || []; } catch (e) { dbodies = []; }
      if (dbodies.length) {
        let bopts = '<option value="">— orbita generica —</option>';
        dbodies.forEach(function (b) {
          if (!b || !b.key) return;
          bopts += bodyOption(b, false);
          (b.moons || []).forEach(function (m) { if (m && m.key) bopts += bodyOption(m, true); });
        });
        destBodyHtml = '<select class="fdetail__select" data-bind="dest-body" aria-label="Corpo di destinazione">' + bopts + '</select>';
      }
    } else if (!destExplored) {
      destBodyHtml = '<span class="fdest__hint">' + uiIcon('info', 'soft') + ' Sistema non esplorato: corpo non selezionabile.</span>';
    }
    /* Presenza AI nota (feedback utente): quante/quali nel sistema + sul corpo. */
    const dCivs = knownCivsInSystem(D.dest.sysId);
    let aiLine = dCivs.length
      ? '<div class="fdest__ai">' + uiIcon('civ', 'pink') + ' AI nel sistema: <strong>' + dCivs.length + '</strong> · ' +
          dCivs.map(function (c) { return '<span class="fdest__civ">' + escapeHtml(civKnownName(c)) + '</span>'; }).join(' ') + '</div>'
      : '<div class="fdest__ai fdest__ai--none">Nessuna AI nota nel sistema</div>';
    if (D.dest.bodyKey && ORION.ai && ORION.ai.civForPlanet) {
      const bc = ORION.ai.civForPlanet(g, D.dest.sysId, D.dest.bodyKey);
      if (bc) aiLine += '<div class="fdest__ai">' + uiIcon('civ', 'pink') + ' Sul corpo: <span class="fdest__civ">' + escapeHtml(civKnownName(bc)) + '</span></div>';
    }
    const destSec = '<div class="fdetail__sec fdetail__sec--dest is-editing">' +
      secHead('pin', 'cyan', 'Destinazione', 'primo passo') +
      '<div class="fdetail__origin">' +
        '<select class="fdetail__select" data-bind="dest-system" aria-label="Sistema di destinazione">' + destSysOpts + '</select>' +
        destBodyHtml +
      '</div>' + aiLine +
    '</div>';

    /* ===== Sezione MISSIONE (Stadio 2.4/2.4b) — guidata da fleetTarget+actionsFor.
       "Sposta" sempre disponibile; le azioni valide per l'oggetto (Attacca/
       Estrai/Ricognizione/Colonizza) compaiono solo se valide E se la
       composizione le consente. Colonizza diventa il default suggerito quando
       hai una coloniale su un corpo colonizzabile. */
    const draftFleet = buildDraftFleet();
    const destTarget = ORION.fleetTarget ? ORION.fleetTarget.describe(g, D.dest.sysId, D.dest.bodyKey) : null;
    const rawActs = (ORION.fleet.actionsFor && destTarget) ? ORION.fleet.actionsFor(destTarget, draftFleet) : [];
    const MISSION_META = {
      move:     { ic: 'send',      tone: 'cyan',   lab: 'Sposta',       arr: 'Solo spostamento' },
      attack:   { ic: 'sword',     tone: 'pink',   lab: 'Attacca',      arr: 'Attacca' },
      extract:  { ic: 'resources', tone: 'amber',  lab: 'Estrai',       arr: 'Estrai' },
      recon:    { ic: 'spy',       tone: 'violet', lab: 'Ricognizione', arr: 'Ricognizione' },
      colonize: { ic: 'home',      tone: 'amber',  lab: 'Colonizza',    arr: 'Colonizza' }
    };
    const GATE_LABEL = { coloniale: 'nave coloniale', estrattore: 'estrattore', fuoco: 'potenza di fuoco' };
    const misOpts = [{ id: 'move', available: true, gate: null, future: false }];
    rawActs.forEach(function (a) {
      if (a.id === 'dock' || a.id === 'defend-ally') return; // dock = Sposta su colonia; defend-ally futura
      misOpts.push(a);
    });
    const selectableIds = misOpts.filter(function (a) {
      return a.available && !a.future && MISSION_META[a.id];
    }).map(function (a) { return a.id; });
    if (!D.mission || selectableIds.indexOf(D.mission) < 0) {
      /* Default suggerito: Colonizza se possibile, altrimenti solo spostamento. */
      D.mission = selectableIds.indexOf('colonize') >= 0 ? 'colonize' : 'move';
    }
    const misChips = misOpts.map(function (a) {
      const meta = MISSION_META[a.id]; if (!meta) return '';
      const disabled = !a.available || a.future;
      const sel = (D.mission === a.id) && !disabled;
      const gateTxt = (!a.available && a.gate) ? (GATE_LABEL[a.gate] || a.gate) : '';
      const title = gateTxt ? 'Serve: ' + gateTxt : meta.arr;
      const sfx = gateTxt ? ' <span class="fdetail__chip-note">' + escapeHtml(gateTxt) + '</span>' : '';
      return '<button class="fdetail__chip' + (sel ? ' is-active' : '') + '" type="button" data-mission="' + a.id + '"' +
        (disabled ? ' disabled' : '') + ' title="' + escapeHtml(title) + '">' +
        uiIcon(meta.ic, meta.tone) + ' ' + meta.arr + sfx + '</button>';
    }).join('');
    const misSec = '<div class="fdetail__sec fdetail__sec--ord is-editing">' +
      secHead('send', 'cyan', 'Sposta — e all’arrivo', MISSION_META[D.mission] ? MISSION_META[D.mission].arr : 'Solo spostamento') +
      '<div class="fdetail__chips">' + misChips + '</div>' +
    '</div>';

    /* Sezione viveri (slider capienza serbatoio) — SEMPRE presente per non far
       saltare l'altezza del modal; disabilitata finché non c'è una nave. */
    const supSec = secSupplyDraft(crewReq, nShips > 0);

    /* ===== Riepilogo viaggio (sticky, Stadio 2.5) — live su ogni render. ===== */
    const sumSysName = (g.galaxy.systems[D.dest.sysId] || {}).name || ('Sistema ' + D.dest.sysId);
    let sumBodyName = '';
    if (D.dest.bodyKey) {
      try { const ds = ORION.system.generate(g.galaxy, D.dest.sysId); const b = ORION.system.findBody(ds, D.dest.bodyKey); if (b) sumBodyName = ' · ' + (b.name || b.key); } catch (e) { /* */ }
    }
    const sumMisLab = MISSION_META[D.mission] ? MISSION_META[D.mission].lab : 'Sposta';
    let sumEta = '—';
    if (nShips > 0) {
      const oSys = sysIdOf(D.newColonyKey);
      if (oSys === D.dest.sysId) sumEta = 'intra-sistema';
      else {
        const p = ORION.fleet.computePath ? ORION.fleet.computePath(g.galaxy, oSys, D.dest.sysId) : null;
        sumEta = p ? (ORION.fleet.routeImpulsi(g.galaxy, draftFleet, p) + ' Ι') : 'irraggiungibile';
      }
    }
    const sumVcap = (D.draft.viveriCap != null) ? D.draft.viveriCap : (ORION.fleet.VIVERI_CAP || 250);
    const riepilogo = '<div class="fdetail__summary">' +
      '<span class="fsum__chip">' + uiIcon('pin', 'cyan') + ' ' + escapeHtml(sumSysName) + escapeHtml(sumBodyName) + '</span>' +
      '<span class="fsum__chip">' + uiIcon('send', 'cyan') + ' ' + escapeHtml(sumMisLab) + '</span>' +
      '<span class="fsum__chip ' + (crewOk ? 'is-ok' : 'is-crit') + '">' + nShips + ' navi · eq ' + crewSel + '/' + crewReq + '</span>' +
      '<span class="fsum__chip">' + uiIcon('clock', 'amber') + ' ' + escapeHtml(sumEta) + '</span>' +
      '<span class="fsum__chip">' + uiIcon('resources', 'amber') + ' ' + sumVcap + ' Ι</span>' +
    '</div>';

    const body =
      riepilogo +
      destSec +
      '<div class="fdetail__sec">' + secHead('roster', 'amber', 'Origine', 'colonia più vicina') +
        '<div class="fdetail__origin">' +
          '<select class="fdetail__select" data-bind="new-system" aria-label="Sistema di origine">' + sysOptsHtml + '</select>' +
          '<select class="fdetail__select" data-bind="new-colony" aria-label="Colonia di origine"' + (multiCol ? '' : ' disabled') + '>' + colOptsHtml + '</select>' +
        '</div></div>' +
      '<div class="fdetail__sec">' + secHead('fleet', 'cyan', 'Navi', 'clic per spostare') + shipRows + '</div>' +
      '<div class="fdetail__sec">' + secHead('forces', 'amber', 'Equipaggio',
        '<span class="fcrew-count ' + (crewOk ? 'is-ok' : 'is-crit') + '">in flotta ' + crewSel + '/' + crewReq + '</span>') + crewBody + '</div>' +
      supSec +
      misSec +
      '<p class="fdetail__hint">' + uiIcon('info', 'soft') + ' Il nome si adatterà alla missione. <strong>Annulla</strong> non crea nulla.</p>';

    /* Validazione globale: composizione + destinazione (o corpo colonizzabile). */
    const isColonize = D.mission === 'colonize';
    const draftOrder = (nShips > 0 && !isColonize) ? buildCreateOrder() : null;
    const colonizeReady = isColonize && D.dest && D.dest.sysId != null && !!D.dest.bodyKey;
    const canCreate = nShips > 0 && crewOk && (isColonize ? colonizeReady : !!draftOrder);
    const disabledReason = (nShips <= 0)
      ? 'Aggiungi almeno una nave'
      : (!crewOk ? 'Equipaggio insufficiente'
                 : (isColonize ? (colonizeReady ? '' : 'Scegli un corpo colonizzabile')
                               : (!draftOrder ? 'Scegli una destinazione' : '')));

    const footer =
      '<div class="fdetail__sum">' + sumChips + '</div>' +
      '<button class="btn btn--mini" data-action="fleet-overlay-close" type="button">Annulla</button>' +
      '<button class="btn btn--mini btn--primary btn--with-icon" data-act="create" type="button"' +
        (canCreate ? '' : ' disabled title="' + escapeHtml(disabledReason) + '"') + '>' +
        uiIcon('check', 'cyan') + ' Crea e parti</button>';
    return shell('Nuova flotta', null, body, footer);
  }

  /* Variante del builder ordini per la modalità "nuova": sempre aperto,
     niente toggle "cambia/annulla" e niente coppia "Conferma/Annulla
     ordine" inline — il footer globale "Crea e parti" gestisce la conferma
     atomica composizione + ordine. */
  function renderOrderBuilderDraft() {
    const TRIPS = [
      { id: 'explore', ic: 'system', lab: 'Esplora' },
      { id: 'transfer', ic: 'fleet', lab: 'Trasferisci' },
      { id: 'hold', ic: 'pin', lab: '⏸ Sosta' },
      { id: 'patrol', ic: 'refresh', lab: 'Pattuglia A↔B' },
      { id: 'patrol-loop', ic: 'refresh', lab: 'Ciclica' },
      { id: 'move-route', ic: 'fleet', lab: 'Rotta a tappe' },
      { id: 'dock', ic: 'home', lab: 'Ormeggia a…' }
    ];
    const dockN = dockTargets().length;
    let h = '<div class="fdetail__ord-build"><div class="fdetail__chips">' + TRIPS.map(function (t) {
      const dis = (t.id === 'dock' && dockN === 0);
      const act = (D.ord.tripType === t.id) ? ' is-active' : '';
      return '<button class="fdetail__chip' + act + '" data-trip="' + t.id + '" type="button"' + (dis ? ' disabled' : '') + '>' +
        uiIcon(t.ic, 'cyan') + ' ' + t.lab + '</button>';
    }).join('') + '</div>';
    const tt = D.ord.tripType;
    if (tt) h += renderDestArea(tt);
    if (tt) h += renderOrdOpts(tt);
    if (!tt) h += '<p class="fdetail__hint">Scegli un tipo di missione qui sopra.</p>';
    return h + '</div>';
  }

  /* Sezione viveri per la flotta-bozza: slider capienza serbatoio + costo
     stimato del pieno. Riusa data-bind dello slider di secSupply così il
     binder esistente (in bind()) lo intercetta — in modalità creazione
     scrive in D.draft.viveriCap invece che su fleet.viveriCap. */
  function secSupplyDraft(crewReq, enabled) {
    const F = ORION.fleet;
    if (!F.viveriCapOf || !F.setViveriCap) return '';
    const dis = !enabled;
    const min = F.VIVERI_CAP_MIN || 50;
    const max = F.VIVERI_CAP_MAX || 1500;
    const def = F.VIVERI_CAP || 250;
    const cap = (D.draft.viveriCap != null) ? D.draft.viveriCap : def;
    const crew = Math.max(1, crewReq | 0);
    const rate = {
      food: F.VIVERI_RATE_FOOD || 0.07, water: F.VIVERI_RATE_WATER || 0.05,
      met: F.VIVERI_RATE_MET || 0.04, en: F.VIVERI_RATE_EN || 0.025
    };
    const m = Math.ceil(crew * rate.met * cap);
    const e = Math.ceil(crew * rate.en * cap);
    const f = Math.ceil(crew * rate.food * cap);
    const w = Math.ceil(crew * rate.water * cap);
    const costStr = '⛭ ' + m + ' · ⚡ ' + e + ' · ❖ ' + f + ' · ≈ ' + w;
    const hint = 'Capienza serbatoio: scegli quanta autonomia caricare al pieno alla partenza. Costo proporzionale a equipaggio (' + crew + ') × Ι caricati.';
    return '<div class="fdetail__sec fdetail__sec--supply' + (dis ? ' is-locked' : '') + '">' +
      secHead('forces', 'amber', 'Viveri alla partenza', dis ? 'aggiungi una nave' : '') +
      '<div class="fleet-viveri-cap" title="' + escapeHtml(hint) + '">' +
        '<label class="fleet-viveri-cap__lbl">Capienza serbatoio · <strong data-bind="vcap-val">' + cap + '</strong> Ι</label>' +
        '<input type="range" min="' + min + '" max="' + max + '" step="10" value="' + cap + '" data-bind="vcap-slider"' + (dis ? ' disabled' : '') + '>' +
        '<div class="fleet-viveri-cap__cost">Pieno completo: <span data-bind="vcap-cost">' + costStr + '</span></div>' +
      '</div>' +
    '</div>';
  }

  /* ===== Modalità dettaglio (flotta esistente) ===== */
  function renderExisting() {
    const body = secRename() + secPos() + secOrders() + secComposition() + secFormation() + secOfficers() + secPop() + secSupply();
    let footer;
    if (D.ordOpen) {
      /* Edit ordine in corso → il footer diventa la coppia Annulla /
         Conferma ordine, e nasconde Dissolvi/Chiudi per evitare l'uscita
         silenziosa che lasciava l'edit pending senza esito (stesso
         principio del flusso "Crea e parti" della nuova flotta). */
      const order = buildOrder();
      const canConfirm = !!order;
      const disReason = !canConfirm ? 'Definisci la destinazione' : '';
      footer =
        '<button class="btn btn--mini" data-act="ord-cancel" type="button">Annulla modifica</button>' +
        '<button class="btn btn--mini btn--primary btn--with-icon" data-act="ord-confirm" type="button"' +
          (canConfirm ? '' : ' disabled title="' + escapeHtml(disReason) + '"') + '>' +
          uiIcon('check', 'cyan') + ' Conferma ordine</button>';
    } else {
      footer =
        '<button class="btn btn--mini btn--danger btn--with-icon" data-act="dissolve" type="button">' + uiIcon('trash', 'pink') + ' Dissolvi</button>' +
        '<button class="btn btn--mini btn--primary" data-action="fleet-overlay-close" type="button">Chiudi</button>';
    }
    return shell(fleet.name, 'M09 · Fase A', body, footer);
  }

  /* Rinomina inline (#88): il nome auto-derivato dall'ordine resta sempre
     editabile dall'utente. */
  function secRename() {
    if (!D.renaming) return '';
    /* Decisione utente 2026-06-15: pre-popola l'input con il SECONDO nome
       del pool dell'ordine corrente + primo numero libero — così la rinomina
       manuale è guidata verso "altro nome per quello scopo, numero nuovo".
       Se l'ordine non mappa (idle/return), resta il nome corrente. */
    const suggest = suggestedRenameFor(g, fleet);
    const initial = suggest || fleet.name;
    const hint = suggest
      ? '<p class="fdetail__hint fdetail__rename-hint">Suggerito per l’ordine corrente — modifica liberamente.</p>'
      : '';
    return '<div class="fdetail__sec fdetail__rename">' +
      '<input class="fdetail__input" type="text" data-bind="rename-input" value="' + escapeHtml(initial) + '" maxlength="40" aria-label="Nome flotta">' +
      '<button class="btn btn--mini btn--primary" data-act="rename-save" type="button">Rinomina</button>' +
      '<button class="btn btn--mini" data-act="rename-cancel" type="button">Annulla</button>' +
      hint +
    '</div>';
  }

  function secPos() {
    const loc = fleet.location || {};
    const tag = (loc.systemId >= 0) ? systemTagHtml(loc.systemId) : '';
    const statusCls = loc.status || 'idle';
    const renBtn = D.renaming ? '' :
      '<button class="fdetail__rename-btn" data-act="rename-toggle" type="button" title="Rinomina flotta" aria-label="Rinomina flotta">✎</button>';
    const bn = fleetBodyName(g, fleet);
    const bodyHtml = bn ? ' <span class="fdetail__pos-body">· ' + escapeHtml(bn) + '</span>' : '';
    return '<div class="fdetail__pos">' +
      '<div class="fdetail__pos-main">' + uiIcon('system', 'amber') +
        ' in <strong>' + escapeHtml(sysName(loc.systemId)) + '</strong> ' + tag + bodyHtml +
        ' <span class="fleet-status fleet-status--' + statusCls + '">' + statusLabel(fleet) + '</span>' + renBtn + '</div>' +
      '<div class="fdetail__pos-sub">' + uiIcon('roster', 'amber') + ' da ' +
        escapeHtml(systemNameFromKey(g, fleet.ownerColonyKey)) + '</div>' +
    '</div>';
  }

  /* ----- Ordini (builder inline) -----
     I pulsanti scopo sono SEMPRE visibili (altezza card stabile): di default
     disabilitati. "cambia" li abilita; "annulla" mantiene l'ordine corrente
     e li ri-disabilita (richiesta utente 2026-06-14). */
  function secOrders() {
    const enabled = D.ordOpen;
    const h = '<div class="fdetail__sec fdetail__sec--ord' + (enabled ? ' is-editing' : '') + '">' +
      '<div class="fdetail__sec-h">' + uiIcon('fleet', 'cyan') + ' Ordine' +
        '<button class="fdetail__toggle" data-act="ord-toggle" type="button">' +
          (enabled ? 'annulla' : 'cambia') + '</button></div>' +
      '<div class="fdetail__ord-cur">' + escapeHtml(orderLabel(fleet)) + '</div>' +
      renderOrderBuilder(enabled);
    return h + '</div>';
  }
  function renderOrderBuilder(enabled) {
    const TRIPS = [
      { id: 'explore', ic: 'system', lab: 'Esplora' },
      { id: 'transfer', ic: 'fleet', lab: 'Trasferisci' },
      { id: 'hold', ic: 'pin', lab: '⏸ Sosta' },
      { id: 'patrol', ic: 'refresh', lab: 'Pattuglia A↔B' },
      { id: 'patrol-loop', ic: 'refresh', lab: 'Ciclica' },
      { id: 'move-route', ic: 'fleet', lab: 'Rotta a tappe' },
      { id: 'dock', ic: 'home', lab: 'Ormeggia a…' }
    ];
    const dockN = dockTargets().length;
    let h = '<div class="fdetail__ord-build"><div class="fdetail__chips">' + TRIPS.map(function (t) {
      const dis = !enabled || (t.id === 'dock' && dockN === 0);
      const act = (D.ord.tripType === t.id) ? ' is-active' : '';
      return '<button class="fdetail__chip' + act + '" data-trip="' + t.id + '" type="button"' + (dis ? ' disabled' : '') + '>' +
        uiIcon(t.ic, 'cyan') + ' ' + t.lab + '</button>';
    }).join('') + '</div>';
    if (enabled) {
      const tt = D.ord.tripType;
      if (tt) h += renderDestArea(tt);
      if (tt) h += renderOrdOpts(tt) + renderOrdConfirm(tt);
    }
    return h + '</div>';
  }
  /* Tue colonie raggiungibili dove la flotta può andare a ORMEGGIARSI
     (decisione A: "Rientro" → "Trasferisci a <colonia> + ormeggia"). Esclude
     il sistema attuale se già ormeggiata. Una voce per sistema. */
  function dockTargets() {
    const seen = {}; const out = [];
    Object.keys(g.colonies).forEach(function (k) {
      const c = g.colonies[k];
      if (!c || !c.colonized || c.systemId < 0 || seen[c.systemId]) return;
      if (c.systemId === fleet.location.systemId && fleet.location.status === 'docked') return;
      const path = ORION.fleet.computePath(g.galaxy, fleet.location.systemId, c.systemId);
      if (!path) return;
      seen[c.systemId] = true;
      out.push({ sysId: c.systemId, hops: path.length - 1 });
    });
    out.sort(function (a, b) { return a.hops - b.hops; });
    return out;
  }
  function renderWaypoints() {
    if (!D.ord.waypoints.length) return '<p class="fdetail__empty">Nessuna tappa: aggiungine dalla lista.</p>';
    return '<ul class="fdetail__wp-list">' + D.ord.waypoints.map(function (wp, i) {
      return '<li class="fdetail__wp"><span class="fdetail__wp-n">' + (i + 1) + '.</span> ' +
        escapeHtml(g.galaxy.systems[wp.sysId].name) + ' <span class="fdetail__wp-d">' + wp.dwell + ' ' + iU() + '</span>' +
        '<button class="btn btn--mini" data-rm-wp="' + i + '" type="button" aria-label="Rimuovi">×</button></li>';
    }).join('') + '</ul>';
  }
  function renderDestArea(tt) {
    const isExplore = (tt === 'explore');
    const isHold = (tt === 'hold');
    const isMulti = (tt === 'move-route' || tt === 'patrol-loop' || tt === 'patrol');
    /* Ormeggia a… → elenco delle TUE colonie raggiungibili (riusa move). */
    if (tt === 'dock') {
      const tg = dockTargets();
      if (!tg.length) return '<p class="fdetail__empty">Nessuna colonia raggiungibile dove ormeggiare.</p>';
      const rows = tg.map(function (d) {
        const s = g.galaxy.systems[d.sysId];
        const grp = g.galaxy.groups[s.cluster] || {};
        const acr = grp.acronym ? '<span class="name-tag">[' + escapeHtml(grp.acronym) + ']</span>' : '';
        const selA = (D.ord.target === d.sysId);
        return '<li class="fdetail__dest' + (selA ? ' is-selected' : '') + '">' +
          '<span class="fdetail__dest-name">' + uiIcon('roster', 'amber') + ' ' + escapeHtml(s.name) + ' ' + acr + '</span>' +
          '<span class="fdetail__dest-meta">' + d.hops + ' hop</span>' +
          '<button class="btn btn--mini' + (selA ? ' is-active' : '') + '" data-pick-target="' + d.sysId + '" type="button">' + (selA ? '✓' : 'scegli') + '</button>' +
        '</li>';
      }).join('');
      return '<p class="fdetail__hint">Scegli una tua colonia: la flotta ci arriva e si <strong>ormeggia</strong>.</p>' +
        '<ul class="fdetail__dest-list">' + rows + '</ul>';
    }
    /* Sosta = "resta dove sei". Se la flotta è ferma, NON è un selettore di
       sistema: si conferma e basta (sistema attuale già preselezionato dal
       click sull'ordine). Solo se è IN VIAGGIO mostra dove fermarsi.
       Per parcheggiare ALTROVE si usa "Trasferisci" (arriva e resta in orbita). */
    if (isHold && fleet.location.status !== 'in-transit') {
      const cur = fleet.location.systemId;
      return '<p class="fdetail__hint">' + uiIcon('info', 'soft') +
        ' La flotta <strong>resta in orbita</strong> a <strong>' + escapeHtml(sysName(cur)) + '</strong> ' +
        'in attesa (utile per radunare più flotte e poi <strong>fonderle</strong>). ' +
        'Per fermarti a un <em>altro</em> sistema usa <em>Trasferisci</em>.</p>' +
        '<ul class="fdetail__dest-list"><li class="fdetail__dest is-selected">' +
          '<span class="fdetail__dest-name">📍 Resta qui · ' + escapeHtml(sysName(cur)) + '</span>' +
          '<span class="fdetail__dest-meta">sistema attuale</span>' +
          '<button class="btn btn--mini is-active" data-pick-target="' + cur + '" type="button">✓</button>' +
        '</li></ul>';
    }
    /* Esplora = solo frontiera. Trasferisci/multi/Sosta-in-viaggio = sistemi
       già esplorati (per la Sosta in viaggio: dove fermarsi). */
    const dests = ORION.fleet.visibleDestinations(g.galaxy, g.state, fleet.location.systemId, {
      includeDetected: isExplore,
      includeExplored: !isExplore
    });
    let h = isMulti ? renderWaypoints() : '';
    if (isHold) {
      h += '<p class="fdetail__hint">' + uiIcon('info', 'soft') +
        ' La flotta è in viaggio: scegli a quale sistema fermarsi e restare in orbita.</p>';
    }
    if (!dests.length) {
      return h + '<p class="fdetail__empty">' +
        (isExplore ? 'Nessun sistema rilevato sulla frontiera.' : 'Nessun sistema raggiungibile.') + '</p>';
    }
    const rows = dests.map(function (d) {
      const s = g.galaxy.systems[d.sysId];
      const grp = g.galaxy.groups[s.cluster] || {};
      const acr = grp.acronym ? '<span class="name-tag">[' + escapeHtml(grp.acronym) + ']</span>' : '';
      const tier = s.dangerTier || 'sicuro';
      const sel = (!isMulti && D.ord.target === d.sysId) ? ' is-selected' : '';
      const act = isMulti
        ? '<button class="btn btn--mini" data-add-wp="' + d.sysId + '" type="button">+ tappa</button>'
        : '<button class="btn btn--mini' + (D.ord.target === d.sysId ? ' is-active' : '') + '" data-pick-target="' + d.sysId + '" type="button">' +
            (D.ord.target === d.sysId ? '✓' : 'scegli') + '</button>';
      return '<li class="fdetail__dest' + sel + '">' +
        '<span class="fdetail__dest-name">' + escapeHtml(s.name) + ' ' + acr + '</span>' +
        '<span class="fdetail__dest-meta">' + d.hops + ' hop · <span class="danger-badge tier--' + tier + '">' + s.danger + '</span></span>' +
        act + '</li>';
    }).join('');
    h += '<ul class="fdetail__dest-list">' + rows + '</ul>';
    if (isMulti) h += '<label class="fdetail__dwell">Sosta nuove tappe <input type="number" data-bind="next-dwell" min="0" max="200" value="0"> ' + iU() + '</label>';
    return h;
  }
  function renderOrdOpts(tt) {
    if (tt === 'explore') {
      return '<label class="fdetail__check"><input type="checkbox" data-bind="opt-return"' + (D.ord.opt.returnHome ? ' checked' : '') + '> Rientra dopo aver esplorato</label>' +
        '<p class="fdetail__hint">Deseleziona per <strong>restare in orbita</strong> al sistema esplorato (in sosta).</p>';
    }
    if (tt === 'move-route') {
      return '<label class="fdetail__check"><input type="checkbox" data-bind="opt-explore-each"' + (D.ord.opt.exploreEach ? ' checked' : '') + '> Esplora ogni tappa</label>' +
        '<label class="fdetail__check"><input type="checkbox" data-bind="opt-return"' + (D.ord.opt.returnHome ? ' checked' : '') + '> Rientra al termine</label>';
    }
    return '';
  }
  /* Stadio 2.3a — ordine del flusso destination-first (creazione). Missione
     di default "Sposta" (M1[+M2] verso il corpo se scelto). Il picker missione
     completo (Attacca/Estrai/Ricognizione/Colonizza) arriva al 2.4. */
  function buildCreateOrder() {
    if (!D.dest || D.dest.sysId == null) return null;
    const sys = D.dest.sysId, bk = D.dest.bodyKey || null;
    const m = D.mission || 'move';
    if (m === 'attack') return { type: 'attack', toSysId: sys, bodyKey: bk };
    if (m === 'recon') return { type: 'recon', toSysId: sys, bodyKey: bk };
    if (m === 'extract') {
      /* anomalyKind: giacimento del corpo (cintura/gassoso) o anomalia fluttuante. */
      let kind = null;
      if (bk && ORION.system && ORION.system.generate && ORION.system.findBody && ORION.anomaly && ORION.anomaly.bodyGiacimento) {
        try {
          const ds = ORION.system.generate(g.galaxy, sys);
          const b = ORION.system.findBody(ds, bk);
          const gi = b && ORION.anomaly.bodyGiacimento(b);
          if (gi) kind = gi.kind;
        } catch (e) { /* fallback */ }
      }
      if (!kind && ORION.fleetTarget) { const t = ORION.fleetTarget.describe(g, sys, bk); kind = t.anomalyKind; }
      if (!kind) return null;
      return { type: 'survey', toSysId: sys, anomalyKind: kind, bodyKey: bk };
    }
    /* default: Sposta (M1[+M2]). */
    return { type: 'move', toSysId: sys, bodyKey: bk };
  }

  function buildOrder() {
    const o = D.ord;
    if (o.tripType === 'explore') {
      if (o.target == null) return null;
      if (o.opt.returnHome) return { type: 'explore', toSysId: o.target };
      return { type: 'move-route', waypoints: [o.target], dwell: [0], exploreEach: true, returnHome: false };
    }
    if (o.tripType === 'transfer') return o.target != null ? { type: 'move', toSysId: o.target } : null;
    if (o.tripType === 'hold') {
      if (o.target == null) return null;
      /* "Resta qui" sul sistema attuale = nessun viaggio → idle (parcheggio).
         Altrimenti raggiungi il sistema e parcheggia (move arriva in orbita). */
      if (o.target === fleet.location.systemId && fleet.location.status !== 'in-transit') return { type: 'idle' };
      return { type: 'move', toSysId: o.target };
    }
    if (o.tripType === 'patrol') return o.waypoints.length >= 2 ? { type: 'patrol', sysA: o.waypoints[0].sysId, sysB: o.waypoints[1].sysId } : null;
    if (o.tripType === 'patrol-loop') return o.waypoints.length >= 2 ? { type: 'patrol-loop', loop: o.waypoints.map(function (w) { return w.sysId; }), dwell: o.waypoints.map(function (w) { return w.dwell; }) } : null;
    if (o.tripType === 'move-route') return o.waypoints.length ? { type: 'move-route', waypoints: o.waypoints.map(function (w) { return w.sysId; }), dwell: o.waypoints.map(function (w) { return w.dwell; }), exploreEach: o.opt.exploreEach, returnHome: o.opt.returnHome } : null;
    /* Ormeggia a… → un `move` verso il sistema della colonia: all'arrivo la
       flotta si ormeggia (decisione A). */
    if (o.tripType === 'dock') return o.target != null ? { type: 'move', toSysId: o.target } : null;
    return null;
  }
  function renderOrdConfirm(tt) {
    const order = buildOrder();
    if (!order) {
      const need = (tt === 'move-route') ? 'almeno una tappa'
        : (tt === 'patrol' || tt === 'patrol-loop') ? 'almeno 2 sistemi'
        : (tt === 'hold') ? 'una destinazione (o "Resta qui")'
        : 'una destinazione';
      return '<p class="fdetail__hint">Scegli ' + need + '.</p>';
    }
    /* "Resta qui" (idle): nessun viaggio → niente check equipaggio/viveri.
       Pulsanti Annulla/Conferma vivono nel footer della modal (sia in
       creazione che in dettaglio esistente con D.ordOpen). */
    if (order.type === 'idle') {
      return '<div class="fdetail__sum">' +
        '<span class="fdetail__sumchip is-ok">⏸ resta in orbita qui</span></div>';
    }
    const crewOk = fleet.crew.length >= ORION.fleet.fleetCrewRequired(fleet);
    let chips = '<span class="fdetail__sumchip ' + (crewOk ? 'is-ok' : 'is-warn') + '">' +
      (crewOk ? '✓' : '⚠') + ' eq. ' + fleet.crew.length + '/' + ORION.fleet.fleetCrewRequired(fleet) + '</span>';
    if (ORION.fleet.supplyOutlook) {
      const so = ORION.fleet.supplyOutlook(g, fleet, order);
      if (so) {
        let cls, ic;
        if (so.enough) { cls = 'is-ok'; ic = '✓ viveri'; }
        else if (so.refuelEnRoute) { cls = 'is-ok'; ic = '⛽ porto in rotta'; }
        else if (so.payableEnRoute) { cls = 'is-warn'; ic = '⛽ rifornimento a pagamento'; }
        else { cls = 'is-warn'; ic = '⚠ oltre autonomia'; }
        chips += '<span class="fdetail__sumchip ' + cls + '" title="~' + so.routeI + ' Ι rotta · ' + so.autonomyI + ' Ι autonomia">' + ic + '</span>';
      }
    }
    return '<div class="fdetail__sum">' + chips + '</div>';
  }

  /* Colonia-PORTO: la tua colonia nel sistema dove la flotta è ora (decisione
     A 2026-06-15 — si gestisce dove è ormeggiata, non alla sola origine). */
  function portColonyKey() {
    return (ORION.fleet.ownColonyKeyAt) ? ORION.fleet.ownColonyKeyAt(g, fleet.location.systemId) : fleet.ownerColonyKey;
  }
  /* ----- Composizione (navi + equipaggio) ----- */
  function secComposition() {
    const ck = portColonyKey();
    const colony = ck ? g.colonies[ck] : null;
    const docked = !!(colony && fleet.location.status === 'docked' && fleet.location.systemId === colony.systemId);
    if (colony) ORION.fleet.ensureColonyShipKinds(colony);
    const classes = ORION.fleet.classList();
    let rows = '';
    classes.forEach(function (cls) {
      const inDock = (colony && colony.ships[cls.id]) || 0;
      let inFleet = 0; fleet.ships.forEach(function (s) { if (s.kind === cls.id) inFleet++; });
      if (inDock <= 0 && inFleet <= 0) return;
      rows += '<div class="fdetail__crow">' +
        '<span class="fdetail__crow-n">' + fleetShipIcon(cls.id) + ' ' + escapeHtml(cls.name) + '</span>' +
        '<span class="fdetail__crow-c">flotta <strong>' + inFleet + '</strong> · terra ' + inDock + '</span>' +
        '<span class="fdetail__crow-b">' +
          '<button class="btn btn--mini" data-add-ship="' + cls.id + '" type="button"' + ((!docked || inDock <= 0) ? ' disabled' : '') + '>+</button>' +
          '<button class="btn btn--mini" data-rem-ship="' + cls.id + '" type="button"' + ((!docked || inFleet <= 0) ? ' disabled' : '') + '>−</button>' +
        '</span></div>';
    });
    if (!rows) rows = '<p class="fdetail__empty">Nessuna nave: costruiscile all’Hangar della colonia.</p>';
    const crewAvail = (colony && colony.crews && colony.crews.explorer && colony.crews.explorer.length) || 0;
    const crewInFleet = fleet.crew ? fleet.crew.length : 0;
    const crewReq = ORION.fleet.fleetCrewRequired(fleet);
    /* Riga info + restituzione equipaggio. */
    const crewInfoRow = '<div class="fdetail__crow">' +
      '<span class="fdetail__crow-n">' + uiIcon('forces', 'amber') + ' Equipaggio</span>' +
      '<span class="fdetail__crow-c">flotta <strong>' + crewInFleet + '</strong>/' + crewReq + ' · terra ' + crewAvail + '</span>' +
      '<span class="fdetail__crow-b">' +
        '<button class="btn btn--mini" data-act="rem-crew" type="button"' + ((!docked || crewInFleet <= 0) ? ' disabled' : '') + ' title="Restituisci un equipaggio alla colonia">−</button>' +
      '</span></div>';
    /* Selettore equipaggio PER GRADO (richiesta utente 2026-06-14): scegli
       quale assegnare, non "+1 a caso". Riusa lo stile dei chip Esplorazione. */
    let crewPick = '';
    if (docked && crewAvail > 0) {
      const crews = (colony.crews.explorer || []).slice().sort(function (a, b) { return (b.xp || 0) - (a.xp || 0); });
      crewPick = '<div class="exp-crew-select fdetail__crew-pick" role="group" aria-label="Assegna equipaggio per grado">' +
        crews.map(function (c) {
          const xp = c.xp || 0;
          const lbl = (ORION.expedition && ORION.expedition.enrichmentForXp) ? ORION.expedition.enrichmentForXp(xp).label : ('xp ' + xp);
          return '<button class="exp-crew-chip" type="button" data-add-crew-id="' + escapeHtml(String(c.id)) + '" title="Assegna ' + escapeHtml(lbl) + ' · xp ' + xp + '">' +
            '<span class="exp-crew-chip__rank">' + escapeHtml(lbl) + '</span>' +
            '<span class="exp-crew-chip__xp">xp ' + xp + '</span></button>';
        }).join('') +
      '</div>';
    } else if (docked) {
      crewPick = '<p class="fdetail__hint">Nessun equipaggio a terra: formane in <em>Accademia</em>.</p>';
    }
    const crewRow = crewInfoRow + crewPick;
    const note = docked ? '' : '<p class="fdetail__hint">All’attracco della colonia origine per modificare la composizione.</p>';
    const vet = fleetVeterancyHtml(fleet).replace('fleet-item__vets', 'fdetail__vets');
    return '<div class="fdetail__sec">' + secHead('forces', 'amber', 'Composizione') + rows + crewRow + note + vet + '</div>';
  }

  /* ----- Formazione ----- */
  function secFormation() {
    const FORMS = [{ id: 'aggressive', lab: 'Aggressiva' }, { id: 'balanced', lab: 'Bilanciata' }, { id: 'defensive', lab: 'Difensiva' }];
    const cur = fleet.formation || 'balanced';
    const seg = FORMS.map(function (f) {
      return '<button class="fdetail__seg' + (f.id === cur ? ' is-active' : '') + '" data-form="' + f.id + '" type="button">' + f.lab + '</button>';
    }).join('');
    return '<div class="fdetail__sec">' + secHead('forces', 'pink', 'Formazione', 'soglia di ritirata') +
      '<div class="fdetail__seg-row">' + seg + '</div></div>';
  }

  /* ----- Ufficiali (M14/M15) ----- */
  function secOfficers() {
    if (!ORION.commander) return '';
    const officers = ORION.commander.officersOf(fleet);
    const slots = (ORION.fleet && ORION.fleet.fleetOfficerSlots) ? ORION.fleet.fleetOfficerSlots(fleet) : 1;
    const avail = ORION.commander.assignableOf(g);
    const star = uiIcon('star', 'amber');
    let cur = officers.length
      ? officers.map(function (o) {
          return '<div class="fdetail__off"><span>' + star + ' <strong>' + escapeHtml((o.rank || '') + ' ' + o.name) + '</strong> · ' +
            escapeHtml(cmdRoleLabel(o)) + ' <span class="fdetail__off-b">' + escapeHtml(ORION.commander.bonusLabel(o)) + '</span></span>' +
            '<button class="btn btn--mini btn--danger" data-off-release="' + escapeHtml(o.id) + '" type="button">' + uiIcon('close', 'pink') + '</button></div>';
        }).join('')
      : '<p class="fdetail__hint">Nessun ufficiale a bordo.</p>';
    const full = officers.length >= slots;
    const rolesAboard = officers.map(function (o) { return o.role; });
    let pick = '';
    if (!full && avail.length) {
      pick = '<div class="fdetail__off-pick">' + avail.map(function (a) {
        const c = a.commander; const dup = rolesAboard.indexOf(c.role) >= 0;
        return '<button class="btn btn--mini" data-off-assign="' + escapeHtml(c.id) + '" type="button"' + (dup ? ' disabled title="ruolo già a bordo"' : '') + '>' +
          star + ' ' + escapeHtml((c.rank || '') + ' ' + c.name) + ' · ' + escapeHtml(cmdRoleLabel(c)) + '</button>';
      }).join('') + '</div>';
    }
    return '<div class="fdetail__sec">' + secHead('star', 'amber', 'Ufficiali', officers.length + '/' + slots) + cur + pick + '</div>';
  }

  /* ----- Coloni a bordo (#66) ----- */
  function secPop() {
    const popCap = ORION.fleet.fleetPopCargoCap(fleet);
    if (popCap <= 0) return '';
    const popOnboard = fleet.popOnboard || 0;
    const canDock = (fleet.location.status === 'docked' || fleet.location.status === 'orbiting');
    const sameSys = fleet.location.systemId;
    const keys = Object.keys(g.colonies || {}).filter(function (k) {
      const c = g.colonies[k]; return c && c.colonized && c.systemId === sameSys && c.pop;
    });
    let rows;
    if (!keys.length || !canDock) {
      rows = '<p class="fdetail__hint">' + (canDock ? 'Nessuna colonia operativa in questo sistema.' : 'All’attracco/orbita di una colonia per imbarcare.') + '</p>';
    } else {
      rows = keys.map(function (ck) {
        const c = g.colonies[ck]; const cname = systemNameFromKey(g, ck);
        const cpop = (c.pop && c.pop.total) || 0; const ccap = (c.pop && c.pop.cap) || 0;
        const canE = cpop > 1 && popOnboard < popCap; const canD = popOnboard > 0 && cpop < ccap;
        const dia = c.diaspora && c.diaspora.until > (g.timeImpulsi || 0);
        const dchip = dia ? ' <span class="fleet-pop__diaspora">⚡ ' + (c.diaspora.until - (g.timeImpulsi || 0)) + ' ' + iU() + '</span>' : '';
        return '<div class="fdetail__crow"><span class="fdetail__crow-n">' + escapeHtml(cname) +
          ' <span class="fdetail__crow-c">' + cpop + '/' + ccap + ' liv.' + dchip + '</span></span>' +
          '<span class="fdetail__crow-b">' +
            '<button class="btn btn--mini" data-embark="' + escapeHtml(ck) + '" type="button"' + (canE ? '' : ' disabled') + ' title="Imbarca 1 livello (Bonus Diaspora ×2/60 Ι)">+ imbarca</button>' +
            '<button class="btn btn--mini" data-disembark="' + escapeHtml(ck) + '" type="button"' + (canD ? '' : ' disabled') + ' title="Sbarca 1 livello">− sbarca</button>' +
          '</span></div>';
      }).join('');
    }
    return '<div class="fdetail__sec">' + secHead('roster', 'amber', 'Coloni a bordo', popOnboard + '/' + popCap + ' liv.') + rows + '</div>';
  }

  /* ----- Viveri (#69) -----
     Bilanciamento 2026-06-16: slider capienza serbatoio. Il giocatore sceglie
     da VIVERI_CAP_MIN a VIVERI_CAP_MAX l'autonomia massima della flotta.
     Costo proporzionale al crew × cap. Editabile solo se non in transito
     (in volo il serbatoio è "fissato" alla scelta fatta in porto). */
  function secSupply() {
    const v = fleetViveriHtml(fleet);
    if (!v) return '';
    const F = ORION.fleet;
    /* Decisione utente 2026-06-16: rifornimento e modifica capienza
       serbatoio AMMESSI SOLO al porto amico (tua colonia, tua stazione
       operativa, colonia alleata) — `fleetAtFriendlyPort` codifica già
       le 3 condizioni "ancorata · stazione orbitale · orbita in mia
       colonia" + esclude le flotte in survey (vedi nota in fleet.js).
       Fuori da queste situazioni nascondiamo il bottone Rifornisci e
       disabilitiamo lo slider capienza: non si fanno operazioni di
       porto a metà strada in sistemi alieni. */
    const atFriendlyPort = !!(F.fleetAtFriendlyPort && F.fleetAtFriendlyPort(g, fleet));
    let refuel = '';
    if (atFriendlyPort && F.payablePortAt && F.payRefuelAt &&
        F.payablePortAt(g, fleet.location.systemId) &&
        F.viveriOf(fleet) < F.viveriCapOf(fleet)) {
      const rc = F.payRefuelCost(g, fleet);
      refuel = '<button class="btn btn--mini btn--with-icon" data-act="refuel" type="button">⛽ Rifornisci (' + rc + ' cr)</button>';
    }
    /* Slider capienza serbatoio. */
    let capSlider = '';
    if (F.setViveriCap && F.viveriCapOf) {
      const cap = F.viveriCapOf(fleet);
      const min = F.VIVERI_CAP_MIN || 50;
      const max = F.VIVERI_CAP_MAX || 1500;
      const crew = (F.fleetCrewRequired ? F.fleetCrewRequired(fleet) : 0) || 1;
      const editable = atFriendlyPort;
      /* Stima costo PIENO completo (Ι caricati = cap, crew totale × rate). */
      const rate = {
        food: F.VIVERI_RATE_FOOD || 0.07, water: F.VIVERI_RATE_WATER || 0.05,
        met: F.VIVERI_RATE_MET || 0.04, en: F.VIVERI_RATE_EN || 0.025
      };
      const cost = {
        food: Math.ceil(crew * rate.food * cap),
        water: Math.ceil(crew * rate.water * cap),
        met: Math.ceil(crew * rate.met * cap),
        en: Math.ceil(crew * rate.en * cap)
      };
      const costStr = '⛭ ' + cost.met + ' · ⚡ ' + cost.en + ' · ❖ ' + cost.food + ' · ≈ ' + cost.water;
      const editAttr = editable ? '' : ' disabled';
      const inTransit = fleet.location && fleet.location.status === 'in-transit';
      const hintTxt = editable
        ? 'Capienza serbatoio: scegli quanta autonomia caricare alla prossima sosta al porto. Costo proporzionale a equipaggio (' + crew + ') × Ι caricati.'
        : inTransit
          ? 'In viaggio: capienza non modificabile fino al ritorno al porto.'
          : 'Modifica capienza disponibile solo al porto amico (tua colonia, tua stazione, alleato).';
      capSlider =
        '<div class="fleet-viveri-cap" title="' + escapeHtml(hintTxt) + '">' +
          '<label class="fleet-viveri-cap__lbl">Capienza serbatoio · <strong data-bind="vcap-val">' + cap + '</strong> Ι</label>' +
          '<input type="range" min="' + min + '" max="' + max + '" step="10" value="' + cap + '" data-bind="vcap-slider"' + editAttr + '>' +
          '<div class="fleet-viveri-cap__cost">Pieno completo: <span data-bind="vcap-cost">' + costStr + '</span></div>' +
        '</div>';
    }
    /* Decisione utente 2026-06-16: pillola usura accanto ai viveri nel
       riepilogo flotta (vista e dettaglio). Empty string se la flotta non
       ha navi (caso degenere) — già coperto da fleetWearHtml. */
    const wearH = fleetWearHtml(fleet);
    return '<div class="fdetail__sec fdetail__sec--supply">' + v + wearH + refuel + capSlider + '</div>';
  }

  /* ===== Handlers ===== */
  function bind() {
    host.querySelectorAll('[data-action="fleet-overlay-close"]').forEach(function (b) {
      b.addEventListener('click', closeDetail);
    });
    /* --- nuova flotta (#88: carrello + Conferma/Annulla) --- */
    /* Destinazione (Stadio 2.3a): sistema + corpo. */
    const destSysSel = host.querySelector('[data-bind="dest-system"]');
    if (destSysSel) destSysSel.addEventListener('change', function () {
      if (!D.dest) D.dest = { sysId: null, bodyKey: null };
      D.dest.sysId = Number(destSysSel.value); D.dest.bodyKey = null; render();
    });
    const destBodySel = host.querySelector('[data-bind="dest-body"]');
    if (destBodySel) destBodySel.addEventListener('change', function () {
      if (!D.dest) D.dest = { sysId: null, bodyKey: null };
      D.dest.bodyKey = destBodySel.value || null; render();
    });
    /* Picker missione (Stadio 2.4). */
    host.querySelectorAll('[data-mission]').forEach(function (b) {
      if (b.disabled) return;
      b.addEventListener('click', function () { D.mission = b.dataset.mission; render(); });
    });
    const newSysSel = host.querySelector('[data-bind="new-system"]');
    if (newSysSel) newSysSel.addEventListener('change', function () {
      const sid = Number(newSysSel.value);
      const elig = eligibleColonies();
      const first = elig.filter(function (k) { return Number(String(k).split(':')[0]) === sid; })[0];
      if (first) { D.newColonyKey = first; D.draft = { ships: {}, crew: [] }; render(); }
    });
    const newColSel = host.querySelector('[data-bind="new-colony"]');
    if (newColSel) newColSel.addEventListener('change', function () {
      D.newColonyKey = newColSel.value; D.draft = { ships: {}, crew: [] }; render();
    });
    host.querySelectorAll('[data-draft-ship-add]').forEach(function (b) {
      b.addEventListener('click', function () {
        const k = b.dataset.draftShipAdd; const col = g.colonies[D.newColonyKey];
        if (col && ORION.fleet.ensureColonyShipKinds) ORION.fleet.ensureColonyShipKinds(col);
        const avail = (col && col.ships[k]) || 0; const cur = D.draft.ships[k] || 0;
        if (cur < avail) D.draft.ships[k] = cur + 1; render();
      });
    });
    host.querySelectorAll('[data-draft-ship-rem]').forEach(function (b) {
      b.addEventListener('click', function () {
        const k = b.dataset.draftShipRem; const cur = D.draft.ships[k] || 0;
        if (cur > 0) D.draft.ships[k] = cur - 1; render();
      });
    });
    /* Toggle equipaggio PER GRADO (per id): scegli quali livelli imbarcare. */
    host.querySelectorAll('[data-draft-crew-toggle]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!Array.isArray(D.draft.crew)) D.draft.crew = [];
        const id = b.dataset.draftCrewToggle;
        const i = D.draft.crew.indexOf(id);
        if (i >= 0) { D.draft.crew.splice(i, 1); }
        else {
          /* Cap: non oltre il fabbisogno equipaggio delle navi scelte. */
          let req = 0;
          Object.keys(D.draft.ships).forEach(function (k) {
            const n = D.draft.ships[k] || 0; const cls = ORION.fleet.getClass(k);
            req += (cls && cls.crew ? cls.crew : 0) * n;
          });
          if (D.draft.crew.length >= req) return;
          D.draft.crew.push(id);
        }
        render();
      });
    });
    const createBtn = host.querySelector('[data-act="create"]');
    if (createBtn) createBtn.addEventListener('click', function () {
      const colKey = D.newColonyKey;
      const draft = D.draft || { ships: {}, crew: [] };
      const draftCrew = Array.isArray(draft.crew) ? draft.crew : [];
      let nShips = 0; Object.keys(draft.ships).forEach(function (k) { nShips += draft.ships[k] || 0; });
      if (nShips <= 0) { showToast('Aggiungi almeno una nave alla flotta'); return; }
      /* Missione: colonize usa il flusso dedicato (costo per-pianeta); le
         altre costruiscono un ordine standard. */
      const isColonize = (D.mission === 'colonize');
      const order = isColonize ? null : buildCreateOrder();
      if (!isColonize && !order) { showToast('Scegli una destinazione'); return; }
      if (isColonize && !(D.dest && D.dest.bodyKey != null)) { showToast('Scegli un corpo colonizzabile'); return; }
      /* Materializza solo ora: createFleet + assegnazioni + ordine in un colpo.
         Rollback completo se qualcosa fallisce (#22). */
      const r = ORION.fleet.createFleet(g, colKey, null);
      if (!r.ok) { showToast(r.reason); return; }
      const nf = r.fleet;
      if (D.draft.viveriCap != null && ORION.fleet.setViveriCap) {
        ORION.fleet.setViveriCap(nf, D.draft.viveriCap);
        nf.viveri = nf.viveriCap;
      }
      let failed = null;
      Object.keys(draft.ships).forEach(function (k) {
        if (failed) return; const n = draft.ships[k] || 0; if (n <= 0) return;
        const ar = ORION.fleet.assignShips(g, nf, colKey, k, n);
        if (!ar.ok) failed = ar.reason;
      });
      for (let ci = 0; ci < draftCrew.length && !failed; ci++) {
        const ac = ORION.fleet.assignCrewById(g, nf, colKey, draftCrew[ci]);
        if (!ac.ok) failed = ac.reason;
      }
      if (failed) { ORION.fleet.dissolveFleet(g, nf); showToast(failed); return; }

      if (isColonize) {
        /* Riusa doColonize (costo §6.2 + ordine colonize + rollback). */
        let planet = null;
        try { const dsys = ORION.system.generate(g.galaxy, D.dest.sysId); planet = ORION.planet.generate(g.galaxy, dsys, D.dest.bodyKey); } catch (e) { planet = null; }
        if (!planet) { ORION.fleet.dissolveFleet(g, nf); showToast('Pianeta non valido'); return; }
        doColonize(planet, nf, 0);   // mostra il toast in caso di costo/ordine ko
        if (!nf.orders || nf.orders.type !== 'colonize') { ORION.fleet.dissolveFleet(g, nf); return; }
        persistGame(g);
        fleet = nf; D.creating = false;
        D.ord = { tripType: null, target: null, waypoints: [], opt: { returnHome: false, exploreEach: false } };
        closeDetail();
        return;
      }

      const so = ORION.fleet.setOrder(g, nf, order);
      if (!so.ok) { ORION.fleet.dissolveFleet(g, nf); showToast(so.reason); return; }
      /* Auto-rename + penalità coesione coerenti con `doConfirmOrder`. */
      maybeAutoRenameFleet(g, nf, order);
      if (ORION.cohesion && ORION.cohesion.applyTravelPenalty && order.type !== 'idle' && order.type !== 'return') {
        const sysIds = collectOrderSystems(g, nf, order);
        const pen = ORION.cohesion.applyTravelPenalty(g, sysIds);
        if (pen.applied < 0) showToast('Rotta attraverso ' + pen.affectedSys.length + ' sistema coeso — disposizione ' + pen.applied);
      }
      /* Nuova flotta formata dal giocatore: niente entry — la flotta
         compare in tab Flotte e il toast/UI sono il feedback. */
      persistGame(g);
      fleet = nf;
      D.creating = false;
      D.ord = { tripType: null, target: null, waypoints: [], opt: { returnHome: false, exploreEach: false } };
      closeDetail();
    });

    /* --- Interazioni ordine (condivise creazione + dettaglio) ---
       Vivono sopra il guard `D.creating` perché agiscono solo su D.ord —
       servono identiche per costruire la flotta-bozza in creazione e per
       cambiare ordine a una flotta esistente. */
    host.querySelectorAll('[data-trip]').forEach(function (b) {
      b.addEventListener('click', function () {
        D.ord.tripType = b.dataset.trip; D.ord.target = null; D.ord.waypoints = [];
        /* Sosta su flotta ferma = "resta qui": preseleziona il sistema
           attuale → conferma in un click (#89 fix). In creazione, "qui" =
           sistema della colonia origine, sempre 'docked'. */
        if (b.dataset.trip === 'hold' && fleet && fleet.location.status !== 'in-transit') {
          D.ord.target = fleet.location.systemId;
        }
        render();
      });
    });
    host.querySelectorAll('[data-pick-target]').forEach(function (b) {
      b.addEventListener('click', function () { D.ord.target = Number(b.dataset.pickTarget); render(); });
    });
    host.querySelectorAll('[data-add-wp]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (D.ord.tripType === 'patrol' && D.ord.waypoints.length >= 2) {
          showToast('A↔B usa solo 2 sistemi. Scegli "Ciclica" per più nodi.'); return;
        }
        const dw = host.querySelector('[data-bind="next-dwell"]');
        const dwell = dw ? Math.max(0, parseInt(dw.value || '0', 10) || 0) : 0;
        D.ord.waypoints.push({ sysId: Number(b.dataset.addWp), dwell: dwell });
        render();
      });
    });
    host.querySelectorAll('[data-rm-wp]').forEach(function (b) {
      b.addEventListener('click', function () { D.ord.waypoints.splice(Number(b.dataset.rmWp), 1); render(); });
    });
    const optRet = host.querySelector('[data-bind="opt-return"]');
    if (optRet) optRet.addEventListener('change', function () { D.ord.opt.returnHome = optRet.checked; render(); });
    const optExp = host.querySelector('[data-bind="opt-explore-each"]');
    if (optExp) optExp.addEventListener('change', function () { D.ord.opt.exploreEach = optExp.checked; render(); });

    /* Slider capienza serbatoio (#69, bilanciamento 2026-06-16). Bindato
       per ENTRAMBE le modalità: in creazione scrive D.draft.viveriCap
       (la flotta sarà materializzata con quel cap al pieno); in dettaglio
       esistente passa per F.setViveriCap + persistGame. */
    const vcapSlider = host.querySelector('[data-bind="vcap-slider"]');
    if (vcapSlider) {
      const valEl = host.querySelector('[data-bind="vcap-val"]');
      const costEl = host.querySelector('[data-bind="vcap-cost"]');
      const F = ORION.fleet;
      const crew = (F.fleetCrewRequired ? F.fleetCrewRequired(fleet) : 0) || 1;
      const rate = {
        food: F.VIVERI_RATE_FOOD || 0.07, water: F.VIVERI_RATE_WATER || 0.05,
        met: F.VIVERI_RATE_MET || 0.04, en: F.VIVERI_RATE_EN || 0.025
      };
      function updatePreview(val) {
        if (valEl) valEl.textContent = val;
        if (costEl) {
          const m = Math.ceil(crew * rate.met * val);
          const e = Math.ceil(crew * rate.en * val);
          const f = Math.ceil(crew * rate.food * val);
          const w = Math.ceil(crew * rate.water * val);
          costEl.textContent = '⛭ ' + m + ' · ⚡ ' + e + ' · ❖ ' + f + ' · ≈ ' + w;
        }
      }
      vcapSlider.addEventListener('input', function () {
        updatePreview(parseInt(vcapSlider.value, 10) || 0);
      });
      vcapSlider.addEventListener('change', function () {
        const val = parseInt(vcapSlider.value, 10) || 0;
        if (D.creating) {
          /* Clampa nello stesso range di setViveriCap. */
          const min = F.VIVERI_CAP_MIN || 50;
          const max = F.VIVERI_CAP_MAX || 1500;
          D.draft.viveriCap = Math.max(min, Math.min(max, val));
          render();
        } else {
          F.setViveriCap(fleet, val);
          persistGame(g);
          render();
        }
      });
    }

    if (D.creating) return;

    /* --- rinomina (#88) --- */
    const renToggle = host.querySelector('[data-act="rename-toggle"]');
    if (renToggle) renToggle.addEventListener('click', function () { D.renaming = true; render(); });
    const renCancel = host.querySelector('[data-act="rename-cancel"]');
    if (renCancel) renCancel.addEventListener('click', function () { D.renaming = false; render(); });
    const renSave = host.querySelector('[data-act="rename-save"]');
    if (renSave) renSave.addEventListener('click', function () {
      const inp = host.querySelector('[data-bind="rename-input"]');
      const nm = inp ? inp.value.trim() : '';
      if (nm) fleet.name = nm.slice(0, 40);
      D.renaming = false; persistGame(g); render();
    });

    /* --- ordini --- */
    const ordToggle = host.querySelector('[data-act="ord-toggle"]');
    if (ordToggle) ordToggle.addEventListener('click', function () {
      D.ordOpen = !D.ordOpen;
      if (D.ordOpen) {
        if (ORION.tutorial) ORION.tutorial.fire('fleet-orders');
      } else {
        /* Annulla → mantiene l'ordine corrente e ridisabilita i pulsanti. */
        D.ord = { tripType: null, target: null, waypoints: [], opt: { returnHome: false, exploreEach: false } };
      }
      render();
    });
    /* Annulla esplicito (#88 follow-up): chiude il builder senza cambiare
       l'ordine corrente. Coppia chiara con "Conferma ordine". */
    const ordCancel = host.querySelector('[data-act="ord-cancel"]');
    if (ordCancel) ordCancel.addEventListener('click', function () {
      D.ordOpen = false;
      D.ord = { tripType: null, target: null, waypoints: [], opt: { returnHome: false, exploreEach: false } };
      render();
    });
    /* I bind condivisi su trip/pick-target/add-wp/rm-wp/opt-* stanno
       sopra il guard D.creating — qui resta solo `ord-confirm` che
       richiede una flotta reale. */
    const ordConfirm = host.querySelector('[data-act="ord-confirm"]');
    if (ordConfirm) ordConfirm.addEventListener('click', doConfirmOrder);

    /* --- composizione --- (al PORTO corrente, non alla sola origine) */
    host.querySelectorAll('[data-add-ship]').forEach(function (b) {
      b.addEventListener('click', function () {
        const r = ORION.fleet.assignShips(g, fleet, portColonyKey(), b.dataset.addShip, 1);
        if (!r.ok) { showToast(r.reason); return; } persistGame(g); render();
      });
    });
    host.querySelectorAll('[data-rem-ship]').forEach(function (b) {
      b.addEventListener('click', function () {
        const r = ORION.fleet.unassignShips(g, fleet, portColonyKey(), b.dataset.remShip, 1);
        if (!r.ok) { showToast(r.reason); return; } persistGame(g); render();
      });
    });
    /* Assegna l'equipaggio SCELTO per grado (non +1 a caso). */
    host.querySelectorAll('[data-add-crew-id]').forEach(function (b) {
      b.addEventListener('click', function () {
        const r = ORION.fleet.assignCrewById(g, fleet, portColonyKey(), b.dataset.addCrewId);
        if (!r.ok) { showToast(r.reason); return; } persistGame(g); render();
      });
    });
    const remCrew = host.querySelector('[data-act="rem-crew"]');
    if (remCrew) remCrew.addEventListener('click', function () {
      const r = ORION.fleet.unassignCrew(g, fleet, portColonyKey(), 1);
      if (!r.ok) { showToast(r.reason); return; } persistGame(g); render();
    });

    /* --- formazione --- */
    host.querySelectorAll('[data-form]').forEach(function (b) {
      b.addEventListener('click', function () {
        ORION.fleet.setFormation(fleet, b.dataset.form); persistGame(g); render();
      });
    });

    /* --- ufficiali --- */
    host.querySelectorAll('[data-off-assign]').forEach(function (b) {
      b.addEventListener('click', function () {
        const r = ORION.commander.assignToFleet(g, fleet, b.dataset.offAssign);
        if (!r.ok) { showToast(r.reason || 'Assegnazione fallita'); return; }
        pushChronicle(ORION.time.currentDS(g) + ' — <strong>★ ' + escapeHtml(r.commander.rank + ' ' + r.commander.name) +
          '</strong> assume un ruolo su <strong>' + escapeHtml(fleet.name) + '</strong>.', 'figure');
        persistGame(g); render();
      });
    });
    host.querySelectorAll('[data-off-release]').forEach(function (b) {
      b.addEventListener('click', function () {
        ORION.commander.releaseFromFleet(g, fleet, b.dataset.offRelease);
        pushChronicle(ORION.time.currentDS(g) + ' — Ufficiale sollevato dal comando di <strong>' + escapeHtml(fleet.name) + '</strong>.', 'figure');
        persistGame(g); render();
      });
    });

    /* --- coloni --- */
    host.querySelectorAll('[data-embark]').forEach(function (b) {
      b.addEventListener('click', function () {
        const ck = b.dataset.embark;
        const r = ORION.fleet.embarkPop(g, fleet, ck, 1);
        if (!r.ok) { showToast(r.reason); return; }
        pushChronicle(ORION.time.currentDS(g) + ' — <strong>' + escapeHtml(fleet.name) + '</strong>: 1 livello di pionieri imbarcato da <strong>' +
          escapeHtml(systemNameFromKey(g, ck)) + '</strong> · Diaspora ×2/60 ' + iU() + '.', 'planet');
        persistGame(g); refreshColonyViews(ck); render();
      });
    });
    host.querySelectorAll('[data-disembark]').forEach(function (b) {
      b.addEventListener('click', function () {
        const ck = b.dataset.disembark;
        const r = ORION.fleet.disembarkPop(g, fleet, ck, 1);
        if (!r.ok) { showToast(r.reason); return; }
        pushChronicle(ORION.time.currentDS(g) + ' — <strong>' + escapeHtml(fleet.name) + '</strong>: 1 livello di pionieri sbarcato a <strong>' +
          escapeHtml(systemNameFromKey(g, ck)) + '</strong>.', 'planet');
        persistGame(g); refreshColonyViews(ck); render();
      });
    });

    /* --- viveri --- */
    const refuelBtn = host.querySelector('[data-act="refuel"]');
    if (refuelBtn) refuelBtn.addEventListener('click', function () {
      const r = ORION.fleet.payRefuelAt(g, fleet);
      if (!r.ok) { showToast(r.reason); return; }
      pushChronicle(ORION.time.currentDS(g) + ' — <strong>' + escapeHtml(fleet.name) + '</strong> rifornita presso <strong>' +
        escapeHtml((r.civ && r.civ.name) || 'porto in pace') + '</strong> (−' + r.cost + ' cr).', 'planet');
      persistGame(g); render();
    });

    /* Slider capienza serbatoio già bindato sopra (vale anche in
       creazione, su D.draft.viveriCap). */

    /* --- dissolvi --- */
    const dissolve = host.querySelector('[data-act="dissolve"]');
    if (dissolve) dissolve.addEventListener('click', function () {
      const r = ORION.fleet.dissolveFleet(g, fleet);
      if (!r.ok) { showToast(r.reason); return; }
      pushChronicle(ORION.time.currentDS(g) + ' — Flotta <strong>' + escapeHtml(fleet.name) + '</strong> sciolta.', 'planet');
      persistGame(g); closeDetail();
    });
  }

  function refreshColonyViews(ck) {
    if (ORION.openPlanetKey === ck && typeof updatePlanetUI === 'function') updatePlanetUI();
    if (typeof renderDxPanel === 'function') renderDxPanel();
  }

  function doConfirmOrder() {
    const order = buildOrder();
    if (!order) return;
    const r = ORION.fleet.setOrder(g, fleet, order);
    if (!r.ok) { showToast(r.reason); return; }
    /* #88: il nome si adatta all'ordine (solo se ancora il default neutro). */
    maybeAutoRenameFleet(g, fleet, order);
    if (ORION.cohesion && ORION.cohesion.applyTravelPenalty && order.type !== 'idle' && order.type !== 'return') {
      const sysIds = collectOrderSystems(g, fleet, order);
      const pen = ORION.cohesion.applyTravelPenalty(g, sysIds);
      if (pen.applied < 0) showToast('Rotta attraverso ' + pen.affectedSys.length + ' sistema coeso — disposizione ' + pen.applied);
    }
    pushChronicle(ORION.time.currentDS(g) + ' — <strong>' + escapeHtml(fleet.name) + '</strong>: ' +
      escapeHtml(orderLabel({ orders: order })) + '.', 'explore');
    persistGame(g);
    D.ordOpen = false;
    D.ord = { tripType: null, target: null, waypoints: [], opt: { returnHome: false, exploreEach: false } };
    /* Confermare un ordine è l'azione finale: chiudiamo la modal invece
       di tornare al dettaglio "view" — simmetrico con "Crea e parti". */
    closeDetail();
  }

  render();
}

/* Ordini flotta: la firma resta per i call site storici (#61 picker, marker
   mappa). Apre il Dettaglio flotta col builder ordini già espanso. */
function openFleetOrdersOverlay(fleetId) { return openFleetDetail(fleetId, { orders: true }); }

/* --- Tab Popolazione --- */
function renderPlanetPopolazioneTab(host, planet, colony) {
  const classes = colony.pop.classes;
  const total = colony.pop.total;
  const cap = colony.pop.cap;
  // Classi §9.2 — refactor 2026-06-09: display in LIVELLI invece di persone.
  // Le classi sono quote frazionarie del totale unità; mostriamo % + livelli
  // equivalenti (es. "62% · 4.3 lv").
  const order = ['operai', 'scienziati', 'militari', 'mercanti', 'tecnici'];
  const labels = { operai: 'Operai', scienziati: 'Scienziati', militari: 'Militari', mercanti: 'Mercanti', tecnici: 'Tecnici' };
  let bars = '<ul class="class-list">';
  order.forEach(function (k) {
    const v = classes[k] || 0;
    const pct = total > 0 ? Math.round(v * 100 / total) : 0;
    const lvEq = total > 0 ? v.toFixed(1) : '0';
    bars += '<li class="class-item"><span class="class-item__label">' + labels[k] + '</span>' +
      '<div class="class-item__bar"><div class="class-item__fill class--' + k + '" style="width:' + pct + '%"></div></div>' +
      '<span class="class-item__val">' + pct + '% · ' + lvEq + ' lv</span></li>';
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
  // Crescita in LIVELLI/Impulso (refactor 2026-06-09): unità/Ι diviso il
  // costo del livello (freno temporale: ogni livello costa di più).
  let growthStr;
  if (canGrow) {
    const unitCost = 1 + CFG.POP_LEVEL_COST * (total - 1);
    const marginalLv = growthEst / Math.max(1, unitCost);
    let suffix = '';
    /* Decisione #45 emenda v3: messaggio runway-based. */
    if (runway < RUNWAY_LOW && isFinite(runway)) {
      suffix = ' · rallentata · scorte ' + limitRunway + ' basse (' + runway + ' Ι rimanenti)';
    } else if ((drainFood > 0 || drainWater > 0) && isFinite(runway)) {
      suffix = ' · consuma riserve (' + runway + ' Ι rimanenti)';
    }
    /* Formato: +0.012 lv/Ι oppure ~1 livello ogni N Ι (più leggibile a bassa
       velocità). Scegli il formato più informativo. */
    if (marginalLv >= 0.01) {
      growthStr = '+' + marginalLv.toFixed(3) + ' livelli / Ι' + suffix;
    } else if (marginalLv > 0) {
      const iPerLv = Math.round(1 / marginalLv);
      growthStr = '~1 livello ogni ' + iPerLv + ' Ι' + suffix;
    } else {
      growthStr = 'ferma' + suffix;
    }
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
        row('Popolazione', popRangeLevel(colony, planet) + ' livelli') +
        row('Sostenibile (locale)', '~' + Math.floor(sustainable) + ' / ' + cap + ' livelli' +
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
  const fmtNet = ORION.format.rate;
  function fmtAbs(v) { return Math.round(Math.abs(v) * 100) / 100; }
  /* Decisione #45: il consumo pro-capite della popolazione drena cibo/acqua
     dallo stock (time.js processProduction). Lo mostriamo esplicitamente nel
     riepilogo perché in passato l'utente vedeva "+4 /I" senza capire perché
     lo stock scendeva. Solo in fase operational (Insediamento è bloccato).

     I tassi mostrati sono la PRODUZIONE REALE: `productionFactors` applica gli
     stessi moltiplicatori del tick (Insediamento ×0.5, scarsità, rifiuti,
     morale di guerra) ai tassi grezzi di structureOutput. Prima la tab
     mostrava i tassi teorici → durante l'Insediamento "+5.98 prod" mentre la
     realtà era 5.98×0.5 ≈ 2.99 (e netto ≈ 0 con upkeep 3). */
  const pf = (ORION.time && ORION.time.productionFactors)
    ? ORION.time.productionFactors(ORION.game, colony)
    : { prodMul: 1, popFood: 0, popWater: 0, popMet: 0, popEn: 0, crewFood: 0, crewWater: 0 };
  /* Decisione utente (2026-06-15): il flusso delle rotte commerciali deve
     pesare nel saldo. + in entrata sulla destinazione, − in uscita sulla
     sorgente (flussi EFFETTIVI, conteggiano il budget di throughput). */
  const colKey = colony.systemId + ':' + colony.bodyKey;
  const tradeNet = (ORION.trade && ORION.trade.colonyTradeFlow)
    ? ORION.trade.colonyTradeFlow(ORION.game, colKey)
    : { met: 0, en: 0, food: 0, water: 0 };
  /* Bilanciamento 2026-06-16: manutenzione flotta (met dalle navi parcheggiate
     + en dalle capitali). Specchio coerente di processProduction in time.js,
     così il saldo mostrato qui coincide con quello reale tick-per-tick. */
  const F = ORION.fleet;
  const shipMet = (F && F.portMaintenance) ? F.portMaintenance(ORION.game, colony) : 0;
  const shipEn  = (F && F.portMaintenanceEn) ? F.portMaintenanceEn(ORION.game, colony) : 0;
  const items = [];
  ['met', 'en', 'food', 'water'].forEach(function (k) {
    const r = (rates[k] || 0) * pf.prodMul; const u = upkeep[k] || 0;
    const popDrain =
      k === 'food'  ? pf.popFood  :
      k === 'water' ? pf.popWater :
      k === 'met'   ? (pf.popMet  || 0) :
      k === 'en'    ? (pf.popEn   || 0) : 0;
    const crewDrain = k === 'food' ? (pf.crewFood || 0) : k === 'water' ? (pf.crewWater || 0) : 0;
    const shipDrain = k === 'met' ? shipMet : k === 'en' ? shipEn : 0;
    const trade = tradeNet[k] || 0;   // + entrata, − uscita
    const net = r - u - popDrain - crewDrain - shipDrain + trade;
    if (!(r || u || popDrain || crewDrain || shipDrain || trade)) return;
    let aux = '+' + fmtAbs(r) + ' prod / −' + fmtAbs(u) + ' uso';
    if (popDrain > 0) aux += ' / −' + fmtAbs(popDrain) + ' pop';
    if (crewDrain > 0) aux += ' / −' + fmtAbs(crewDrain) + ' razioni';
    if (shipDrain > 0) aux += ' / −' + fmtAbs(shipDrain) + ' flotta';
    if (trade > 0) aux += ' / +' + fmtAbs(trade) + ' commercio';
    else if (trade < 0) aux += ' / −' + fmtAbs(trade) + ' commercio';
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
  confirmActions: true,   // chiede conferma su build/demolisci/colonizza/...
  surfaceLevel: 'medio-scuro', // luminosità superfici (regolabile per ambiente)
  cinematics: 'piene'     // scenografia accadimenti: piene | ridotte | off
};

/* Cinematiche degli accadimenti (Fase 1). reduced-motion le forza a "off"
   lato ORION.cinematics; qui resta la sola preferenza utente. */
const CINEMATICS_LEVELS = {
  'piene':   { label: 'Piene' },
  'ridotte': { label: 'Ridotte' },
  'off':     { label: 'Off' }
};
const CINEMATICS_ORDER = ['piene', 'ridotte', 'off'];
ORION.prefs = Object.assign({}, DEFAULT_PREFS);

/* Livelli di luminosità delle superfici (decisione #67). Un solo knob
   (--c-surface-rgb, vedi UI_GUIDE §1) declinato in 4 gradazioni navy che
   restano nel tema. Il giocatore le regola in base alla luce attorno a sé;
   preferenza di dispositivo, persistita in localStorage['orion.prefs'],
   NON nel save. */
const SURFACE_LEVELS = {
  'scuro':       { label: 'Scuro',       surface: '24 31 58',  violet: '32 24 54',  deep: '15 20 44' },
  'medio-scuro': { label: 'Medio-scuro', surface: '33 44 82',  violet: '42 32 70',  deep: '21 28 60' },
  'medio':       { label: 'Medio',       surface: '41 55 98',  violet: '52 40 86',  deep: '28 37 76' },
  'chiaro':      { label: 'Chiaro',      surface: '52 68 120', violet: '64 50 104', deep: '36 47 94' }
};
const SURFACE_ORDER = ['scuro', 'medio-scuro', 'medio', 'chiaro'];

function applySurfaceLevel(id) {
  const lvl = SURFACE_LEVELS[id] || SURFACE_LEVELS['medio-scuro'];
  const r = document.documentElement;
  r.style.setProperty('--c-surface-rgb', lvl.surface);
  r.style.setProperty('--c-surface-violet-rgb', lvl.violet);
  r.style.setProperty('--c-bg-deep-rgb', lvl.deep);
}

function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_LS_KEY);
    if (raw) ORION.prefs = Object.assign({}, DEFAULT_PREFS, JSON.parse(raw));
    else ORION.prefs = Object.assign({}, DEFAULT_PREFS);
  } catch (_) { ORION.prefs = Object.assign({}, DEFAULT_PREFS); }
  if (!SURFACE_LEVELS[ORION.prefs.surfaceLevel]) ORION.prefs.surfaceLevel = 'medio-scuro';
  if (!CINEMATICS_LEVELS[ORION.prefs.cinematics]) ORION.prefs.cinematics = 'piene';
  applySurfaceLevel(ORION.prefs.surfaceLevel);
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
        '<div class="prefs-row prefs-row--levels">' +
          '<span class="prefs-row__label">Luminosità interfaccia</span>' +
          '<div class="prefs-levels" role="group" aria-label="Luminosità superfici">' +
            SURFACE_ORDER.map(function (id) {
              return '<button type="button" class="prefs-level' +
                (id === ORION.prefs.surfaceLevel ? ' is-active' : '') +
                '" data-surface-level="' + id + '">' + escapeHtml(SURFACE_LEVELS[id].label) + '</button>';
            }).join('') +
          '</div>' +
          '<span class="prefs-row__hint">Regola lo sfondo di schede e pannelli in base alla luce attorno a te ' +
          '(più scuro al buio, più chiaro in ambienti luminosi). Non influisce sulla partita.</span>' +
        '</div>' +
        '<div class="prefs-row prefs-row--levels">' +
          '<span class="prefs-row__label">Cinematiche degli accadimenti</span>' +
          '<div class="prefs-levels" role="group" aria-label="Cinematiche">' +
            CINEMATICS_ORDER.map(function (id) {
              return '<button type="button" class="prefs-level' +
                (id === ORION.prefs.cinematics ? ' is-active' : '') +
                '" data-cine-level="' + id + '">' + escapeHtml(CINEMATICS_LEVELS[id].label) + '</button>';
            }).join('') +
          '</div>' +
          '<span class="prefs-row__hint">Effetti scenografici sugli eventi (rivelazione di un sistema inesplorato, ' +
          'partenza di una flotta in iperspazio). <strong>Piene</strong>: tutti gli effetti · ' +
          '<strong>Ridotte</strong>: solo micro-effetti leggeri · <strong>Off</strong>: nessuno. ' +
          'Se il sistema richiede animazioni ridotte vengono disattivate comunque. Non influisce sulla partita.</span>' +
        '</div>' +
      '</div>' +
    '</div>';
  host.hidden = false;
  if (typeof ORION.injectStaticSvgIcons === 'function') ORION.injectStaticSvgIcons(host);

  host.querySelector('input[data-pref="confirmActions"]').addEventListener('change', function (e) {
    ORION.prefs.confirmActions = !!e.target.checked;
    savePrefs();
  });
  /* Luminosità superfici: applica subito (live) + persisti + aggiorna lo stato attivo. */
  host.querySelectorAll('[data-surface-level]').forEach(function (b) {
    b.addEventListener('click', function () {
      const id = b.dataset.surfaceLevel;
      ORION.prefs.surfaceLevel = id;
      applySurfaceLevel(id);
      savePrefs();
      host.querySelectorAll('[data-surface-level]').forEach(function (x) {
        x.classList.toggle('is-active', x.dataset.surfaceLevel === id);
      });
    });
  });
  /* Cinematiche: preferenza pura (effetto al prossimo evento), persisti + stato attivo. */
  host.querySelectorAll('[data-cine-level]').forEach(function (b) {
    b.addEventListener('click', function () {
      const id = b.dataset.cineLevel;
      if (!CINEMATICS_LEVELS[id]) return;
      ORION.prefs.cinematics = id;
      savePrefs();
      host.querySelectorAll('[data-cine-level]').forEach(function (x) {
        x.classList.toggle('is-active', x.dataset.cineLevel === id);
      });
    });
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
  'gov-build-started': false, 'gov-expand-started': false, 'gov-asset-started': false,
  /* M14 Fase B1 (#77): figure di colonia. Emergenza notevole (ON), rank OFF. */
  'colony-figure-emerged': true, 'colony-figure-ranked': false,
  /* M14 Fase B2 (#78): Consiglio della Civiltà. Consigli OFF (non allarmi);
     la proposta da approvare ferma il tempo (ON); l'azione autonoma OFF. */
  'council-advice': false, 'council-proposal': true, 'council-acted': false,
  /* M14 Fase B3 (#79): costituzione notevole (ON); luminare/successione/
     congedo sono atmosferici (OFF). */
  'council-constituted': true, 'luminary-emerged': false,
  'council-succession': false, 'figure-retired': false,
  /* M08 Fase A (decisione #42): arrivo flotta + rotta completata + scoperta
     fortuita auto-pausano (esiti notevoli). Il launch è azione utente,
     non sorpresa. Hop intermedi mai. */
  'fleet-arrived': true, 'fleet-route-complete': true, 'fleet-discovery': true,
  'fleet-launched': false, 'fleet-leg-hop': false,
  /* M15 — varo di una nave capitale: evento notevole (auto-pausa ON). Le
     navi piccole restano silenziose (ship-built non listata = OFF). */
  'capital-built': true,
  /* M16 (decisione #81): stazioni spaziali. Costruzione/potenziamento e
     attacco/distruzione sono notevoli (ON); l'isolamento è un nudge a
     rifornire (ON); il rifornimento ripristinato è buona notizia (OFF). */
  'station-built': true, 'station-upgraded': true, 'station-attacked': true,
  'station-destroyed': true, 'station-isolated': true, 'station-resupplied': false,
  /* M16 Fase B (#81): cattura/riconquista di una stazione — eventi notevoli. */
  'station-captured': true, 'station-retaken': true,
  /* Decisione #69: viveri. L'avviso e l'esaurimento auto-pausano (finestra
     per reagire); il rifornimento no (è una buona notizia di routine). */
  'fleet-supply-low': true, 'fleet-supply-critical': true, 'fleet-resupplied': false,
  /* Decisione intra-sistema: minaccia sopra una flotta in garrison.
     Default ON — l'utente decide il da farsi (Ingaggia/Ritira/Resta). */
  'garrison-threat-detected': true,
  /* M17 Fase A (decisione #83): Dispacci & Missioni. L'offerta è
     un'opportunità non bloccante (OFF, vive nel pannello Dispacci);
     gli esiti done/failed sono notevoli (ON); scadenza/void OFF. */
  'dispatch-offered': false, 'dispatch-done': true, 'dispatch-failed': true,
  'dispatch-expired': false, 'dispatch-void': false,
  /* M17 Fase B (#83): contractor Mekhari risolto — notevole (covo sgominato). */
  'mekhari-contract-done': true,
  /* M17 Fase C (#83): crisi a scelte → ferma il tempo (serve decidere).
     Reliquia trovata: la pausa + il resoconto li gestisce il popup dedicato
     (showAnomalyRecapModal in runAdvance), quindi OFF qui per non duplicare
     l'overlay generico. Giacimento esausto = atmosferico (OFF). */
  'crisis-raised': true, 'crisis-lapsed': true, 'anomaly-relic-found': false, 'anomaly-depleted': false,
  /* Fase B (decisione #46): tappa intermedia raggiunta. Default OFF —
     non interrompiamo a ogni waypoint, può essere una rotta lunga. L'arrivo
     finale e la `route-complete` continuano a fermare il tempo. */
  'fleet-waypoint-reached': false,
  /* Decisione #43 (M07.2): nascita di un Comandante nominato — evento
     narrativo forte (nuova figura giocabile), auto-pausa di default. */
  'commander-promoted': true,
  /* M14 (#75): salita di rango della figura — atmosferico, non interrompe. */
  'commander-ranked': false,
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
  'civ-spotted': true,
  'civ-contact': true,
  'civ-intel-upgraded': false,
  'pirate-nest-recon': false,
  'civ-fallen': true,
  'civ-emerged': true,
  /* M18.x (richiesta utente 2026-06-18): flotte ambientali AI. Il
     rilevamento generico è atmosferico (OFF, niente interruzioni);
     l'avvicinamento a una colonia e la scaramuccia sono notevoli (ON). */
  'aifleet-detected': false,
  'aifleet-approach': true,
  'aifleet-crossed': false,
  'aifleet-skirmish': true,
  'aifleet-destroyed': true,
  'follow-lost': false,
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
  'cohesion-attack-backlash': false,
  'system-cohesion-broken': false,
  'federation-formed': true,
  'federation-broken': true,
  /* M13 Fase A (decisione #57): completamento di una ricerca — momento
     notevole (sblocca strutture/effetti), auto-pausa ON. */
  'research-complete': true,
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
  'agreement-suspended': false, 'agreement-resumed': false, 'agreement-ended': false,
  /* #48 Fase 2b: export rifiuti — auto-chiusura atmosferica. */
  'waste-deal-closed': false,
  /* Decisione #66: fasi della nave coloniale. L'orbit phase è breve e
     scenografica → OFF. Foundation start è atmosferico (la colonia
     "in arrivo" appare già in UI) → OFF. Failure (colonia perduta) è
     notevole → ON. La fine della foundation emette `colony-done` che è
     già auto-pausa ON. */
  'fleet-colonize-orbit': false,
  'fleet-colonize-foundation': false,
  'fleet-colonize-failed': true
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
    else if (act === 'play-step')   { stopPlay(); manualAdvance(1); }
    else if (act === 'advance-to-event') { stopPlay(); manualAdvance(null); }
  });
  /* Shortcuts globali (decisione #31): Space play/pause · → singolo Ι ·
     E prossimo evento. Ignorati su input/textarea.
     +/- rimossi: confliggevano con Ctrl + +/- (zoom browser). */
  document.addEventListener('keydown', function (e) {
    if (!ORION.game) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.target.isContentEditable) return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); stopPlay(); manualAdvance(1); }
    else if (e.key === 'e' || e.key === 'E') { e.preventDefault(); stopPlay(); manualAdvance(null); }
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
  if (ORION.cinematics && res) ORION.cinematics.onEvents(res.events);
  if (res && res.events && shouldAutoPause(res.events)) {
    stopPlay();
    showEventOverlay(res.events);
  }
}
/* Avanzamento manuale (pulsante +1 Ι · → · "Prossimo evento" · E):
   stesso loop di playTick ma SENZA il timer. Mostra l'overlay degli
   eventi notevoli (decisione #31) anche quando si scorre a mano un
   singolo Impulso → l'utente si accorge di cosa è successo in quell'Ι. */
function manualAdvance(impulsi) {
  const res = runAdvance(impulsi);
  if (ORION.cinematics && res) ORION.cinematics.onEvents(res.events);
  if (res && res.events && shouldAutoPause(res.events)) {
    showEventOverlay(res.events);
  }
  return res;
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

/* Helper: formatta un numero per la pop-anim. Default = intero; con
   `decimals` ritorna un float fisso (es. 8.3 con decimals=1). Refactor
   2026-06-09 (estensione decisione #66): abbandonato `formatPeople` come
   formattatore default → ora usa numeri puri (livelli). */
function _popFmt(value, decimals) {
  if (decimals && decimals > 0) {
    const n = (typeof value === 'number') ? value : parseFloat(value) || 0;
    return n.toFixed(decimals);
  }
  return String(Math.round(value || 0));
}

function popAnimSpan(key, value, opts) {
  const a = ORION._popAnim;
  /* Back-compat: se opts è una stringa, la trattiamo come extraClass. */
  let extraClass = '', decimals = 0;
  if (typeof opts === 'string') extraClass = opts;
  else if (opts && typeof opts === 'object') {
    extraClass = opts.extraClass || '';
    decimals = opts.decimals || 0;
  }
  if (a.shown[key] == null) a.shown[key] = value;   // prima volta: niente animazione da 0
  const cls = 'pop-anim' + (extraClass ? ' ' + extraClass : '');
  const attrs = ' data-pop-key="' + escapeHtml(key) + '"' +
                ' data-pop-target="' + value + '"' +
                (decimals ? ' data-pop-decimals="' + decimals + '"' : '');
  return '<span class="' + cls + '"' + attrs + '>' +
    escapeHtml(_popFmt(a.shown[key], decimals)) + '</span>';
}
ORION.popAnimSpan = popAnimSpan;

function popAnimFrame() {
  const a = ORION._popAnim;
  const els = document.querySelectorAll('.pop-anim[data-pop-key]');
  let active = false;
  els.forEach(function (el) {
    const key = el.getAttribute('data-pop-key');
    const target = parseFloat(el.getAttribute('data-pop-target')) || 0;
    const decimals = parseInt(el.getAttribute('data-pop-decimals'), 10) || 0;
    let shown = a.shown[key];
    if (shown == null) shown = target;
    const tol = decimals > 0 ? Math.pow(10, -decimals) * 0.5 : 0.5;
    if (Math.abs(shown - target) > tol) {
      shown = shown + (target - shown) * 0.14;       // approccio esponenziale ~liscio
      if (Math.abs(shown - target) <= tol) shown = target;
      a.shown[key] = shown;
      el.textContent = _popFmt(shown, decimals);
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
    'gov-asset-started': 'Governatore: scafo di scorta avviato',
    'colony-figure-emerged': 'Nuova figura di colonia',
    'colony-figure-ranked': 'Figura di colonia promossa',
    'council-advice': 'Consiglio della Civiltà',
    'council-proposal': 'Consiglio: decisione da approvare',
    'council-acted': 'Consiglio: azione autonoma',
    'council-constituted': 'Consiglio costituito',
    'luminary-emerged': 'Nuovo Luminare',
    'council-succession': 'Consiglio: avvicendamento',
    'figure-retired': 'Figura in congedo',
    'fleet-arrived': 'Flotta arrivata',
    'fleet-route-complete': 'Flotta: rotta completata',
    'fleet-discovery': 'Flotta: sistema esplorato',
    'fleet-launched': 'Flotta: salto iperspaziale',
    'capital-built': 'Nave capitale varata',
    'station-built': 'Stazione completata',
    'station-ship-built': 'Stazione: scafo assemblato',
    'station-upgraded': 'Stazione potenziata',
    'station-attacked': 'Stazione sotto attacco',
    'station-captured': 'Stazione catturata',
    'station-retaken': 'Stazione riconquistata',
    'station-destroyed': 'Stazione distrutta',
    'station-isolated': 'Stazione isolata',
    'station-resupplied': 'Stazione rifornita',
    'fleet-supply-low': 'Flotta: viveri in esaurimento',
    'fleet-supply-critical': 'Flotta: viveri esauriti',
    'fleet-resupplied': 'Flotta rifornita',
    'dispatch-offered': 'Nuovo incarico disponibile',
    'dispatch-done': 'Incarico completato',
    'dispatch-failed': 'Incarico fallito',
    'mekhari-contract-done': 'Cacciatori Mekhari: covo sgominato',
    'crisis-raised': 'Crisi galattica: decisione richiesta',
    'crisis-lapsed': 'Crisi ignorata',
    'anomaly-relic-found': 'Reliquia antica esplorata',
    'anomaly-depleted': 'Giacimento quasi esausto',
    'fleet-leg-hop': 'Flotta: hop intermedio',
    'fleet-waypoint-reached': 'Flotta: tappa raggiunta',
    'garrison-threat-detected': 'Garrison: minaccia rilevata',
    'fleet-colonize-orbit': 'Coloniale: orbita di setup',
    'fleet-colonize-foundation': 'Coloniale: fondazione in corso',
    'fleet-colonize-failed': 'Coloniale: fondazione fallita',
    'commander-promoted': 'Nuova figura di flotta',
    'commander-ranked': 'Figura promossa di rango',
    'capital-declared': 'Capitale di gruppo dichiarata',
    'capital-transition-end': 'Capitale entrata in carica',
    'capital-decommissioned': 'Vecchia capitale decommissionata',
    'civ-spotted': 'Civiltà avvistata',
    'civ-contact': 'Primo contatto con una civiltà',
    'civ-intel-upgraded': 'Dossier civiltà aggiornato',
    'pirate-nest-recon': 'Ricognizione covo pirata',
    'civ-expand': 'Civiltà AI: espansione',
    'civ-war': 'Guerra tra civiltà',
    'civ-battle': 'Battaglia tra civiltà (vista)',
    'civ-fallen': 'Civiltà caduta',
    'civ-emerged': 'Nuova civiltà emersa',
    'aifleet-detected': 'Flotta non identificata rilevata',
    'aifleet-approach': 'Flotta in avvicinamento alla colonia',
    'aifleet-crossed': 'Flotta altrui incrociata',
    'aifleet-skirmish': 'Scaramuccia con flotta altrui',
    'aifleet-destroyed': 'Flotta altrui intercettata e dispersa',
    'follow-lost': 'Contatto perso',
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
    'cohesion-attack-backlash': 'Sistema coeso: solidarietà contro il tuo attacco',
    'system-cohesion-broken': 'Sistema coeso: dissolto',
    'federation-formed': 'Federazione emergente',
    'federation-broken': 'Federazione dissolta',
    'research-complete': 'Ricerca completata',
    'mercantile-built': 'Mercantile varato',
    'mercantile-promoted': 'Mercantile promosso',
    'trade-route-interrupted': 'Rotta commerciale interrotta',
    'trade-route-resumed': 'Rotta commerciale ripresa',
    'trade-route-closed': 'Rotta commerciale chiusa',
    'trade-raid': 'Razzia pirata su rotta',
    'trade-mercantile-lost': 'Mercantile perso',
    'waste-deal-closed': 'Contratto rifiuti chiuso',
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

  let crisisToOpen = null;
  const relicRecap = [];
  if (res.events && res.events.length) {
    res.events.forEach(function (ev) {
      chronicleEvent(ev);
      /* M17 (decisione #83): Memoria Storica — registra le milestone
         (firsts + svolte) da ogni evento. Idempotente (seen-set). */
      if (ORION.dispatch && ORION.dispatch.recordMemoria) ORION.dispatch.recordMemoria(g, ev);
      if (ev.kind === 'crisis-raised') crisisToOpen = ev.crisisId;
      if (ev.kind === 'anomaly-relic-found') relicRecap.push(ev);
    });
  }
  /* M17 Fase C: una crisi appena sollevata apre il modale a scelte. */
  if (crisisToOpen) showCrisisModal(crisisToOpen);
  /* M17 Fase C: fine esplorazione anomalia → pausa + popup di resoconto. */
  if (relicRecap.length) showAnomalyRecapModal(relicRecap);
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
  /* Decisione utente: ridisegna la vista Sistema così i marker flotta
     (incl. spostamenti intra-sistema) si muovono col tempo. */
  if (ORION.systemView && ORION.systemView.requestRender) ORION.systemView.requestRender();
  updateTimeControlsHint();
  persistGame(g);
  /* Rilancia l'animazione DS dal tick corrente (ricomincia da Ι appena maturato) */
  if (ORION.timer && ORION.timer.playing) {
    ORION.timer.lastTickReal = performance.now();
  }
  return res;
}

function chronicleEvent(ev) {
  /* Cronaca a 2 sezioni (Galassia/Colonie): il rumore di routine
     (build, varo navi, lancio flotta, hop, mercantili, governatore,
     insediamento, ecc.) viene SEMPRE scartato — la sidebar mostra solo
     gli eventi che richiedono attenzione. I dettagli operativi vivono
     nei pannelli dedicati (colonia, flotta, rotte). */
  if (isChronicleNoise(ev)) return;
  /* Kind "silenziosi" (es. completamenti smantellamento/downgrade avviati
     dal giocatore): l'entry compare nel log ma non fa pulsare la linguetta.
     Flag transitorio consumato da pushChronicle e resettato a fine evento. */
  ORION._chronicleSilentNext = isChronicleSilent(ev);
  try { return _chronicleEventBody(ev); }
  finally { ORION._chronicleSilentNext = false; }
}
function _chronicleEventBody(ev) {
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
    /* Decisione #66 estensione: se la nave coloniale ha trasportato coloni,
       la colonia nasce con N livelli iniziali invece di 1. */
    const seed = ev.seedLevels || 1;
    const seedTxt = seed > 1 ? ' con <strong>' + seed + ' livelli</strong> di pionieri sbarcati' : '';
    pushChronicle(ds + ' — Nuova colonia attiva su <strong>' + pname + '</strong>' + ptag + seedTxt + '.', 'planet');
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
  } else if (ev.kind === 'station-ship-built') {
    /* M16: scafo leggero/medio assemblato al cantiere di una stazione. */
    const sk = ev.shipKind || 'caccia';
    const scls = (ORION.fleet && ORION.fleet.getClass(sk)) || { name: 'scafo' };
    const sName = (ev.systemId != null && ORION.game.galaxy.systems[ev.systemId])
      ? ORION.game.galaxy.systems[ev.systemId].name : '—';
    pushChronicle(ds + ' — Nuovo <strong>' + escapeHtml(scls.name) + '</strong> assemblato alla stazione <strong>' +
      escapeHtml(ev.name || 'orbitale') + '</strong> in ' + escapeHtml(sName) +
      (ev.systemId != null ? systemTagHtml(ev.systemId) : '') + '.', 'fleet');
  } else if (ev.kind === 'capital-built') {
    /* M15: varo di una nave capitale — evento notevole (auto-pausa ON). */
    const sk = ev.shipKind || 'incrociatore';
    const scls = (ORION.fleet && ORION.fleet.getClass(sk)) || { name: 'nave capitale' };
    const isAdm = sk === 'ammiraglia';
    pushChronicle(ds + ' — ' + (isAdm ? '★ ' : '') + 'La <strong>' + escapeHtml(scls.name) + '</strong> esce dai bacini di ' + pname + ptag + (isAdm ? ' — la nave ammiraglia della civiltà.' : '.'), 'planet');
    if (ORION.tutorial) ORION.tutorial.fire('capital-ships');
  } else if (ev.kind === 'station-built' || ev.kind === 'station-upgraded' ||
             ev.kind === 'station-attacked' || ev.kind === 'station-destroyed' ||
             ev.kind === 'station-isolated' || ev.kind === 'station-resupplied' ||
             ev.kind === 'station-captured' || ev.kind === 'station-retaken') {
    const sName = (ev.systemId != null && ORION.game.galaxy.systems[ev.systemId])
      ? ORION.game.galaxy.systems[ev.systemId].name : '—';
    const where = '<strong>' + escapeHtml(ev.name || 'Stazione') + '</strong> in ' + escapeHtml(sName) + (ev.systemId != null ? systemTagHtml(ev.systemId) : '');
    if (ev.kind === 'station-captured') {
      pushChronicle(ds + ' — ' + where + ' è stata <strong>catturata</strong> da <strong>' + escapeHtml(ev.civName || 'una civiltà') + '</strong>: ora è un presidio nemico. Riconquistala con un attacco.', 'system');
      if (ORION.map && ORION.map.requestRender) ORION.map.requestRender();
    } else if (ev.kind === 'station-retaken') {
      pushChronicle(ds + ' — ' + where + ' <strong>riconquistata</strong>: torna sotto il tuo controllo (danneggiata).', 'fleet');
      if (ORION.map && ORION.map.requestRender) ORION.map.requestRender();
    } else if (ev.kind === 'station-built') {
      pushChronicle(ds + ' — ' + where + ' è operativa: rifornisce le flotte e fortifica il sistema.', 'fleet');
      if (ORION.tutorial) ORION.tutorial.fire('stations');
    } else if (ev.kind === 'station-upgraded') {
      pushChronicle(ds + ' — ' + where + ' potenziata a <strong>livello ' + (ev.level || '?') + '</strong>.', 'fleet');
    } else if (ev.kind === 'station-attacked') {
      const enemy = ev.enemyKind === 'ai' ? 'una forza ostile' : 'i predoni';
      pushChronicle(ds + ' — ' + where + (ev.won ? ' respinge ' + enemy + '.' : ' è sotto attacco da ' + enemy + '!'), 'system');
    } else if (ev.kind === 'station-destroyed') {
      pushChronicle(ds + ' — ' + where + ' è stata <strong>distrutta</strong>. Si potrà ricostruire.', 'system');
    } else if (ev.kind === 'station-isolated') {
      pushChronicle(ds + ' — ' + where + ' è <strong>isolata</strong>: serbatoio a secco, funzioni ridotte. Riavvicina una colonia o rifornisci.', 'system');
    } else {
      pushChronicle(ds + ' — ' + where + ' di nuovo rifornita.', 'fleet');
    }
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
    const why = ev.reason === 'interrupted-route' ? 'rotta ostile' : 'sorgente esaurita';
    pushChronicle(ds + ' — Rotta ' + colonyNameFromKey(ev.src) + ' → ' + colonyNameFromKey(ev.dst) + ' <strong>interrotta</strong> (' + why + ').', 'system');
  } else if (ev.kind === 'trade-route-resumed') {
    pushChronicle(ds + ' — Rotta ' + colonyNameFromKey(ev.src) + ' → ' + colonyNameFromKey(ev.dst) + ' di nuovo <strong>operativa</strong>.', 'system');
  } else if (ev.kind === 'trade-route-closed') {
    pushChronicle(ds + ' — Rotta commerciale chiusa.', 'system');
  } else if (ev.kind === 'waste-deal-closed') {
    pushChronicle(ds + ' — Contratto di export rifiuti chiuso.', 'system');
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
    const raceTxt = c.raceLabel ? (' · <em>' + escapeHtml(c.raceLabel) + '</em>') : '';
    pushChronicle(ds + ' — <strong>' + escapeHtml(c.rank) + ' ' + escapeHtml(c.name) + '</strong> emerge dall\'equipaggio leggendario su ' + pname + ptag + ' · ruolo <em>' + escapeHtml(cmdRoleLabel(c)) + '</em> · tratto <em>' + escapeHtml(c.traitLabel) + '</em>' + raceTxt + '.', 'figure');
    if (ORION.tutorial && ORION.tutorial.fire) ORION.tutorial.fire('commander-promoted');
  } else if (ev.kind === 'commander-ranked') {
    /* M14 (#75): la figura sale di rango servendo in battaglia. */
    const c = ev.commander;
    pushChronicle(ds + ' — <strong>' + escapeHtml(c.name) + '</strong> promosso al rango di <strong>' + escapeHtml(ev.rank) + '</strong> (' + escapeHtml(cmdRoleLabel(c)) + ').', 'figure');
  } else if (ev.kind === 'colony-figure-emerged') {
    /* M14 Fase B1 (#77): una colonia matura genera una figura amministrativa. */
    const f = ev.figure;
    const roleL = ORION.colonyFigure ? ORION.colonyFigure.roleLabel(f) : (f.roleLabel || f.role);
    const cn = systemNameFromKey(ORION.game, ev.colonyKey);
    pushChronicle(ds + ' — <strong>' + escapeHtml(f.name) + '</strong> emerge come <strong>' + escapeHtml(roleL) + '</strong> dall\'amministrazione matura di <strong>' + escapeHtml(cn) + '</strong> · tratto <em>' + escapeHtml(f.traitLabel || '') + '</em>.', 'figure');
    if (ORION.tutorial && ORION.tutorial.fire) ORION.tutorial.fire('colony-figure');
  } else if (ev.kind === 'colony-figure-ranked') {
    const f = ev.figure;
    pushChronicle(ds + ' — <strong>' + escapeHtml(f.name) + '</strong> sale al rango di <strong>' + escapeHtml(ev.rank) + '</strong>.', 'figure');
  } else if (ev.kind === 'gov-asset-started') {
    pushChronicle(ds + ' — <strong>Governatore di sector di ' + pname + ptag + '</strong>: avviato uno scafo esploratore di scorta.', 'figure');
  } else if (ev.kind === 'council-advice') {
    /* M14 Fase B2 (#78): suggerimento del Consiglio della Civiltà §9.4. */
    pushChronicle(ds + ' — ' + councilAdviceHtml(ev), 'council');
    if (ORION.tutorial && ORION.tutorial.fire) ORION.tutorial.fire('council');
  } else if (ev.kind === 'council-proposal') {
    /* Propositivo: il consigliere ha preparato un'azione, decide il giocatore. */
    pushChronicle(ds + ' — <strong>' + escapeHtml(councilWho(ev.role)) + '</strong> ha preparato ' + councilActionDesc(ev.action) + ': decidi nel <strong>Consiglio</strong> (Plancia d\'Impero).', 'council');
    if (ORION.tutorial && ORION.tutorial.fire) ORION.tutorial.fire('council');
  } else if (ev.kind === 'council-acted') {
    /* Autonomo: il consigliere ha agito da solo entro i suoi limiti. */
    pushChronicle(ds + ' — <strong>' + escapeHtml(councilWho(ev.role)) + '</strong> (autonomo) ha messo in atto ' + councilActionDesc(ev.action) + '.', 'council');
  } else if (ev.kind === 'council-constituted') {
    /* M14 Fase B3 (#79): il Consiglio si costituisce quando la civiltà cresce. */
    pushChronicle(ds + ' — Il <strong>Consiglio della Civiltà</strong> si è costituito: tre consiglieri d\'Impero affiancano la tua guida (Plancia d\'Impero).', 'council');
    if (ORION.tutorial && ORION.tutorial.fire) ORION.tutorial.fire('council');
  } else if (ev.kind === 'luminary-emerged') {
    pushChronicle(ds + ' — Un <strong>Luminare</strong>, <strong>' + escapeHtml(ev.figure.name) + '</strong>, emerge dai progressi della ricerca: elevabile al Consiglio Scientifico.', 'figure');
  } else if (ev.kind === 'council-succession') {
    const rl = (ORION.council && ORION.council.ROLES[ev.role]) ? ORION.council.ROLES[ev.role].label : 'Consigliere';
    pushChronicle(ds + ' — <strong>' + escapeHtml(ev.toName) + '</strong> subentra a <strong>' + escapeHtml(ev.fromFigure) + '</strong> come <strong>' + escapeHtml(rl) + '</strong>.', 'council');
  } else if (ev.kind === 'figure-retired') {
    const where = ev.scope === 'colony' ? 'amministrativo' : 'di flotta';
    pushChronicle(ds + ' — <strong>' + escapeHtml(ev.name) + '</strong> (' + escapeHtml(ev.roleLabel || where) + ') si congeda dopo un lungo servizio.', 'figure');
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
  } else if (ev.kind === 'garrison-threat-detected') {
    const fname = ev.fleetName || '—';
    const sys = ORION.game.galaxy.systems[ev.systemId];
    const stag = ev.systemId != null && ev.systemId >= 0 ? systemTagHtml(ev.systemId) : '';
    pushChronicle(ds + ' — ⚠ <strong>Minaccia rilevata</strong> presso <strong>' +
      escapeHtml(fname) + '</strong> in difesa di ' + (sys ? sys.name : '—') + stag + '.', 'system');
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
  } else if (ev.kind === 'fleet-colonize-orbit') {
    /* Decisione #66: la coloniale è arrivata e orbita per il setup
       atterraggio. Voce informativa, niente auto-pausa di default. */
    const fname = ev.fleetName || '—';
    const sys = ORION.game.galaxy.systems[ev.systemId];
    const stag = ev.systemId != null && ev.systemId >= 0 ? systemTagHtml(ev.systemId) : '';
    pushChronicle(ds + ' — <strong>' + escapeHtml(fname) + '</strong> in orbita di scout presso <strong>' +
      (sys ? sys.name : '—') + '</strong>' + stag + ' — preparazione atterraggio.', 'planet');
    if (ORION.map && ORION.map.requestRender) ORION.map.requestRender();
  } else if (ev.kind === 'fleet-colonize-foundation') {
    /* Decisione #66: foundation phase iniziata, la colonia è formalmente
       "in arrivo" (colony.colonizing). */
    const fname = ev.fleetName || '—';
    const sys = ORION.game.galaxy.systems[ev.systemId];
    pushChronicle(ds + ' — <strong>' + escapeHtml(fname) + '</strong>: primo avamposto fondato su <strong>' +
      (sys ? sys.name : '—') + '</strong>. Fondazione in corso.', 'planet');
  } else if (ev.kind === 'fleet-colonize-failed') {
    const fname = ev.fleetName || '—';
    const sys = ORION.game.galaxy.systems[ev.systemId];
    /* Decisione #66 estensione (P0): mostra coloni salvati in scialuppa. */
    const saved = ev.popSaved || 0;
    const savedTxt = saved > 0
      ? ' · <strong>' + saved + ' livell' + (saved === 1 ? 'o' : 'i') + '</strong> di pionieri tornati in scialuppa'
      : '';
    pushChronicle(ds + ' — <strong>' + escapeHtml(fname) + '</strong>: fondazione annullata presso <strong>' +
      (sys ? sys.name : '—') + '</strong> · motivo: ' + escapeHtml(ev.reason || '—') + savedTxt + '.', 'planet');
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
    pushChronicle(ds + ' — <strong>Governatore di ' + pname + ptag + '</strong>: ' + (ev.count || 1) + ' equipaggio/i con esperienza disponibile/i, nessuna spedizione in corso.', 'explore');
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
  } else if (ev.kind === 'research-complete') {
    /* M13 Fase A (decisione #57): ricerca completata. Blurb dell'effetto
       sbloccato (struttura esistente o modificatore passivo). */
    const techBlurb = {
      iperguida: 'viaggi di flotta ×⅓ · sbloccato il Convoglio iperspaziale (Mercantile III)',
      hyper2: 'viaggi di flotta ×⅛ (Iperguida II)',
      hyper3: 'viaggi di flotta ×1/20 (Iperguida III)',
      scudi: 'sbloccato lo <strong>Scudo planetario</strong>',
      esotici: 'sbloccato l\'<strong>Impianto esotico</strong>',
      bonifica: 'sbloccato il <strong>Centro di ingegneria planetaria</strong> (più slot)',
      terraform: 'sbloccati i <strong>Terraformatori</strong> (forte espansione slot)'
    };
    let blurb = techBlurb[ev.effect];
    if (!blurb) {
      /* Tech del pool (modificatore passivo): usa la sua descrizione. */
      const def = ORION.research && ORION.research.get(ev.techId);
      blurb = (def && def.desc) ? escapeHtml(def.desc) : 'nuovo ramo tecnologico disponibile';
    }
    pushChronicle(ds + ' — <strong>Ricerca completata</strong>: <strong>' + escapeHtml(ev.name || ev.techId) + '</strong> · ' + blurb + '.', 'planet');
    if (ORION.tutorial) ORION.tutorial.fire('research-overview');
  } else if (ev.kind === 'civ-contact') {
    /* Primo contatto. Il tratto è noto solo se intel >= partial; altrimenti
       si mostra "tratto ignoto". Il messaggio si adatta al reason. */
    const reasonHint = (ev.reason === 'presence')
      ? 'La tua flotta presente ha colto i primi segnali · dossier nella vista Civiltà ⬡'
      : 'dossier nella vista Civiltà ⬡';
    const traitFrag = ev.traitLabel ? ' · <em>' + escapeHtml(ev.traitLabel) + '</em>' : '';
    pushChronicle(ds + ' — <strong>Primo contatto</strong> con <strong>' + escapeHtml(ev.civName) + '</strong> nel/nella ' + escapeHtml(ev.regionLabel) + traitFrag + ' · <span class="chronicle__hint">' + reasonHint + '</span>.', 'civ');
    if (ORION.tutorial) ORION.tutorial.fire('civilizations');
  } else if (ev.kind === 'civ-spotted') {
    /* "Avvistata": esplori un loro sistema, nessun atto formale ancora.
       Mantieni una flotta nel loro sistema per 3-4 Ι → contatto automatico. */
    pushChronicle(ds + ' — Civiltà <strong>' + escapeHtml(ev.civName) + '</strong> avvistata nel/nella ' + escapeHtml(ev.regionLabel) + ' · <span class="chronicle__hint">mantieni una flotta nel loro sistema per il contatto formale</span>.', 'civ');
  } else if (ev.kind === 'aifleet-detected') {
    /* M18.x: i sensori (colonia/flotta) hanno captato una flotta altrui in
       volo. Identità svelata solo con intel piena; altrimenti "non
       identificata" (misteriosità #34). */
    const whoFrag = ev.civName ? (' di <strong>' + escapeHtml(ev.civName) + '</strong>') : '';
    const compFrag = ev.compKnown ? (' · missione di <em>' + escapeHtml(ev.missionLabel) + '</em>') : '';
    const hint = ev.nearColony
      ? 'rilevata dai sensori di colonia — avvicina una flotta per scrutarne la composizione'
      : 'incrociata dai sensori di flotta — può essere seguita';
    pushChronicle(ds + ' — Flotta non identificata' + whoFrag + ' rilevata nel/nella ' + escapeHtml(ev.regionLabel) + compFrag + ' · <span class="chronicle__hint">' + hint + '</span>.', 'civ');
  } else if (ev.kind === 'aifleet-approach') {
    const who = ev.civName ? ('<strong>' + escapeHtml(ev.civName) + '</strong>') : 'Una flotta non identificata';
    pushChronicle(ds + ' — ' + who + ' (' + escapeHtml(ev.missionLabel) + ') è giunta nelle vicinanze di una tua colonia nel/nella ' + escapeHtml(ev.regionLabel) + ' · <span class="chronicle__hint">valuta scorta, scrutinio o intercettazione</span>.', 'civ');
  } else if (ev.kind === 'aifleet-crossed') {
    /* M18.x: incrocio passivo — info raccolte senza fermarsi. L'utente può
       decidere di "Segui" per saperne di più. */
    const whoFrag = ev.civName ? (' di <strong>' + escapeHtml(ev.civName) + '</strong>') : '';
    const compFrag = ev.compKnown ? (' (missione di <em>' + escapeHtml(ev.missionLabel) + '</em>)') : ' (composizione ignota)';
    pushChronicle(ds + ' — <strong>' + escapeHtml(ev.fleetName || 'La tua flotta') + '</strong> ha incrociato una flotta' + whoFrag + compFrag + ' nel/nella ' + escapeHtml(ev.regionLabel) + ' · <span class="chronicle__hint">puoi dare l\'ordine «Segui» per scrutarla meglio</span>.', 'civ');
  } else if (ev.kind === 'aifleet-skirmish') {
    const who = ev.civName ? ('<strong>' + escapeHtml(ev.civName) + '</strong>') : 'una flotta ostile';
    const hitFrag = ev.shipsHit > 0 ? (ev.shipsHit + ' scafi colpiti') : 'nessun danno serio';
    pushChronicle(ds + ' — Scaramuccia: <strong>' + escapeHtml(ev.fleetName || 'la tua flotta') + '</strong> ha incrociato ' + who + ' nel/nella ' + escapeHtml(ev.regionLabel) + ' (' + hitFrag + ') · <span class="chronicle__hint">flotta avversaria sganciata — ripara e valuta il rientro</span>.', 'civ');
  } else if (ev.kind === 'aifleet-destroyed') {
    const who = ev.civName ? ('<strong>' + escapeHtml(ev.civName) + '</strong>') : 'una flotta non identificata';
    pushChronicle(ds + ' — <strong>' + escapeHtml(ev.fleetName || 'La tua flotta') + '</strong> ha intercettato e disperso ' + who + ' nel/nella ' + escapeHtml(ev.regionLabel) + ' · <span class="chronicle__hint">contatto eliminato</span>.', 'civ');
  } else if (ev.kind === 'follow-lost') {
    const why = ev.reason === 'noroute' ? 'nessuna rotta verso il contatto' : 'il contatto si è dileguato';
    pushChronicle(ds + ' — <strong>' + escapeHtml(ev.fleetName || 'La tua flotta') + '</strong> ha perso il contatto inseguito (' + why + ') · <span class="chronicle__hint">flotta in attesa di nuovi ordini</span>.', 'civ');
  } else if (ev.kind === 'civ-intel-upgraded') {
    const INTEL_LABEL = { fragmentary: 'frammentario', partial: 'parziale', complete: 'completo' };
    pushChronicle(ds + ' — Dossier su <strong>' + escapeHtml(ev.civName) + '</strong> aggiornato: <strong>' + escapeHtml(INTEL_LABEL[ev.to] || ev.to) + '</strong> (era ' + escapeHtml(INTEL_LABEL[ev.from] || ev.from || '—') + ') · <span class="chronicle__hint">flotta più potente nel loro sistema</span>.', 'civ');
  } else if (ev.kind === 'pirate-nest-recon') {
    const INTEL_LABEL = { fragmentary: 'parziale', partial: 'parziale', complete: 'completa' };
    pushChronicle(ds + ' — Ricognizione <strong>' + escapeHtml(INTEL_LABEL[ev.to] || ev.to) + '</strong> di un covo pirata nel/nella ' + escapeHtml(ev.regionLabel) + ' · <span class="chronicle__hint">forza e livello stimati nella vista Civiltà ⬡</span>.', 'civ');
  } else if (ev.kind === 'civ-expand') {
    /* Voce di cronaca "da lontano": effetto senza svelare la mappa.
       Misteriosità (#34): se la civ non è stata contattata, nome e regione
       restano vaghi — "voci" è il registro corretto. */
    const m = chronicleMysteryCiv(ev.civName, ev.regionLabel);
    pushChronicle(ds + ' — Voci da' + (m.mystery ? ' ' : 'l/dalla ') + m.region + ': <strong>' + m.name + '</strong> ha annesso un nuovo sistema.', 'civ');
  } else if (ev.kind === 'civ-war') {
    const mw = chronicleMysteryCiv(ev.winner, ev.regionLabel);
    const ml = chronicleMysteryCiv(ev.loser, ev.regionLabel);
    const regionLbl = (mw.mystery && ml.mystery) ? 'in regioni non cartografate' : ('nel/nella ' + escapeHtml(ev.regionLabel));
    pushChronicle(ds + ' — <strong>' + mw.name + '</strong> strappa un sistema a <strong>' + ml.name + '</strong> ' + regionLbl + '.', 'civ');
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
    const mf = chronicleMysteryCiv(ev.civName, '');
    const mc = chronicleMysteryCiv(ev.conqueror, '');
    pushChronicle(ds + ' — <strong>' + mf.name + '</strong> è caduta: ridotta a zero sistemi, assorbita da <strong>' + mc.name + '</strong>.', 'civ');
  } else if (ev.kind === 'civ-emerged') {
    const me = chronicleMysteryCiv(ev.civName, ev.regionLabel);
    pushChronicle(ds + ' — ' + (me.mystery
      ? 'Voci di una nuova potenza emergente da ' + me.region + ' · <em>identità non confermata</em>'
      : 'Una nuova potenza emerge nel/nella ' + me.region + ': <strong>' + me.name + '</strong>') + '.', 'civ');
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
  } else if (ev.kind === 'cohesion-attack-backlash') {
    /* Coesione #54 (cablata in pulizia #68 Fase 3): solidarietà locale. */
    const stag = ev.sysId != null && ev.sysId >= 0 ? systemTagHtml(ev.sysId) : '';
    pushChronicle(ds + ' — <strong>Solidarietà locale</strong>' + stag + ': il tuo attacco a <strong>' +
      escapeHtml(ev.attackedName || '—') + '</strong> indigna ' + ev.count +
      (ev.count === 1 ? ' civiltà vicina' : ' civiltà vicine') + ' del sistema coeso (−15 disposizione).', 'civ');
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
       Fase B: può essere un'incursione AI di conquista (più grave).
       Bug fix 2026-06-15 (feedback utente "in arrivo a ___"): quando il
       bersaglio è una stazione (M16 Fase B #82), `targetColonyKey` è null
       e colonyNameFromKey ritorna '—'. Riusiamo siegeTargetName che già
       gestisce entrambi i casi (mappiamo i campi su quelli che si aspetta). */
    const tn = siegeTargetName({
      stationId: ev.targetStationId,
      colonyKey: ev.targetColonyKey,
      systemId: ev.targetSysId
    });
    const tag = ev.targetSysId >= 0 ? bodyTagHtml(ev.targetSysId) : '';
    const who = (ev.attackerKind === 'ai')
      ? ('Forza d\'invasione di <strong>' + escapeHtml(ev.civName || 'una civiltà') + '</strong>')
      : '<strong>Incursione pirata</strong>';
    pushChronicle(ds + ' — ' + who + ' in rotta verso ' + tn + tag +
      ' · arrivo stimato fra <strong>' + ev.eta + ' ' + iU() + '</strong>. Prepara le difese.', 'system');
    if (ORION.tutorial) ORION.tutorial.fire(ev.attackerKind === 'ai' ? 'siege' : 'combat');
    /* Richiedi un re-render della mappa: il marker pulsante sul bersaglio
       deve apparire subito, non al prossimo tick. */
    if (ORION.map && ORION.map.requestRender) ORION.map.requestRender();
  } else if (ev.kind === 'siege-begin') {
    const cn = siegeTargetName(ev);
    const tag = ev.systemId >= 0 ? bodyTagHtml(ev.systemId) : '';
    pushChronicle(ds + ' — <strong>Assedio</strong> su ' + cn + tag + ': l\'attaccante ingaggia le difese. ' +
      '<span class="chronicle__hint">reazioni nella vista Flotta ⬡</span>', 'system');
    if (ORION.tutorial) ORION.tutorial.fire('siege');
    if (ORION.map && ORION.map.requestRender) ORION.map.requestRender();
  } else if (ev.kind === 'siege-round') {
    const cn = siegeTargetName(ev);
    pushChronicle(ds + ' — Assedio di ' + cn + ' · round ' + ev.round + ' — difese ' + Math.round(ev.def) +
      ' / attaccante ' + Math.round(ev.atk) + '.', 'system');
  } else if (ev.kind === 'siege-end') {
    const cn = siegeTargetName(ev);
    const tag = ev.systemId >= 0 ? bodyTagHtml(ev.systemId) : '';
    let txt;
    if (ev.outcome === 'repelled') txt = '<strong>Assedio respinto</strong> su ' + cn + tag + ' — l\'attaccante si ritira.';
    else if (ev.outcome === 'looted') txt = '<strong>' + cn + tag + ' saccheggiata</strong>: risorse trafugate, danni.';
    else if (ev.outcome === 'captured') txt = '<strong>' + cn + tag + ' catturata</strong>: ora è un presidio nemico — riconquistala con un attacco.';
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
  } else if (ev.kind === 'fleet-supply-low') {
    const sys = ORION.game.galaxy.systems[ev.systemId];
    const stag = ev.systemId >= 0 ? systemTagHtml(ev.systemId) : '';
    pushChronicle(ds + ' — <strong>' + escapeHtml(ev.fleetName) + '</strong>: viveri in esaurimento (' +
      Math.max(0, Math.round(ev.viveri || 0)) + ' ' + iU() + ' di autonomia) presso <strong>' +
      (sys ? sys.name : '—') + '</strong>' + stag + '. Rifornisci a un porto amico o fai rotta verso casa.', 'system');
    if (ORION.tutorial) ORION.tutorial.fire('fleet-supply');
  } else if (ev.kind === 'fleet-supply-critical') {
    const sys = ORION.game.galaxy.systems[ev.systemId];
    const stag = ev.systemId >= 0 ? systemTagHtml(ev.systemId) : '';
    pushChronicle(ds + ' — <strong>' + escapeHtml(ev.fleetName) + '</strong>: <strong>viveri esauriti</strong> presso <strong>' +
      (sys ? sys.name : '—') + '</strong>' + stag + '. Razionamento: ho impostato <strong>Rientro al porto più vicino</strong> (lenta + usura). ' +
      'Dai un altro ordine per cambiare, oppure lasciala rientrare.', 'system');
  } else if (ev.kind === 'fleet-resupplied') {
    const sys = ORION.game.galaxy.systems[ev.systemId];
    pushChronicle(ds + ' — <strong>' + escapeHtml(ev.fleetName) + '</strong> rifornita presso <strong>' +
      (sys ? sys.name : '—') + '</strong>: viveri al massimo, deriva rientrata.', 'system');
  } else if (ev.kind === 'dispatch-offered') {
    /* Courtship 2026-06-15: se è la prima offerta in "modalità premurosa",
       lo evidenziamo per far capire al giocatore che il sistema esiste
       (altrimenti potrebbe ignorarla pensando sia rumore). */
    const courtshipHint = ev.courtship
      ? ' <span class="chronicle__hint">(primo segnale dalla galassia — il sistema Dispacci è attivo)</span>'
      : ' <span class="chronicle__hint">(pannello Dispacci ✉)</span>';
    pushChronicle(ds + ' — Nuovo incarico da <strong>' + escapeHtml(ev.sourceName || '—') + '</strong>: ' +
      escapeHtml(ev.title || '') + courtshipHint + '.', 'civ');
  } else if (ev.kind === 'dispatch-done') {
    pushChronicle(ds + ' — Incarico completato: <strong>' + escapeHtml(ev.title || '') + '</strong> · ricompensa riscossa.', 'civ');
  } else if (ev.kind === 'dispatch-failed') {
    pushChronicle(ds + ' — Incarico fallito: <strong>' + escapeHtml(ev.title || '') + '</strong> · qualche relazione incrinata.', 'crit');
  } else if (ev.kind === 'dispatch-expired') {
    pushChronicle(ds + ' — Incarico scaduto senza risposta: ' + escapeHtml(ev.title || '') + '.', 'system');
  } else if (ev.kind === 'dispatch-void') {
    pushChronicle(ds + ' — Incarico annullato: ' + escapeHtml(ev.title || '') + (ev.reason ? ' (' + escapeHtml(ev.reason) + ')' : '') + '.', 'system');
  } else if (ev.kind === 'mekhari-contract-done') {
    const sys = ORION.game.galaxy.systems[ev.sysId];
    const who = ev.boss && ev.name ? ('il covo-boss <strong>' + escapeHtml(ev.name) + '</strong>') : 'il covo pirata';
    pushChronicle(ds + ' — Cacciatori Mekhari hanno sgominato ' + who + ' su <strong>' + (sys ? sys.name : '—') + '</strong>.', 'civ');
  } else if (ev.kind === 'crisis-raised') {
    pushChronicle(ds + ' — <strong>Crisi galattica:</strong> ' + escapeHtml(ev.title || '—') + ' <span class="chronicle__hint">(pannello Dispacci · rispondi)</span>.', 'crit');
  } else if (ev.kind === 'crisis-lapsed') {
    pushChronicle(ds + ' — Crisi <strong>' + escapeHtml(ev.title || '—') + '</strong> ignorata: prevale l\'inazione (' + escapeHtml(ev.choiceLabel || '') + ').', 'crit');
  } else if (ev.kind === 'anomaly-relic-found') {
    const sys = ORION.game.galaxy.systems[ev.sysId];
    const loot = ev.reward || {};
    const lootStr = Object.keys(loot).map(function (r) { return resIcon(r) + Math.round(loot[r]); }).join(' · ');
    pushChronicle(ds + ' — Reliquie antiche esplorate su <strong>' + (sys ? sys.name : '—') + '</strong>: cache recuperata' + (lootStr ? ' (' + lootStr + ')' : '') + '.', 'system');
  } else if (ev.kind === 'anomaly-depleted') {
    const sys = ORION.game.galaxy.systems[ev.sysId];
    pushChronicle(ds + ' — Il giacimento su <strong>' + (sys ? sys.name : '—') + '</strong> è quasi esausto: si rigenererà col tempo.', 'system');
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

/* Nome del bersaglio di un assedio (colonia o stazione M16 Fase B #81). */
function siegeTargetName(ev) {
  if (ev.stationId) {
    const g = ORION.game;
    const st = (g && ORION.station) ? ORION.station.stationById(g, ev.stationId) : null;
    if (st) return '<strong>' + escapeHtml(st.name) + '</strong>';
    const sn = (g && ev.systemId != null && g.galaxy.systems[ev.systemId]) ? g.galaxy.systems[ev.systemId].name : null;
    return sn ? ('<strong>la stazione in ' + escapeHtml(sn) + '</strong>') : '<strong>una stazione</strong>';
  }
  return colonyNameFromKey(ev.colonyKey);
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
    /* Refactor 2026-06-09: telemetria pop in LIVELLI (unità) invece di persone.
       Sparkline mostra crescita unità (1, 2, 3, … 12). */
    const levels = ORION.planet.popUnits(c) || 0;
    const morale = ORION.time.colonyMorale ? ORION.time.colonyMorale(g, c) : 1;
    const stock = (c.stock.met || 0) + (c.stock.en || 0) + (c.stock.food || 0) + (c.stock.water || 0);
    push(t.pop, levels); push(t.morale, morale); push(t.stock, stock);
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
function fmtStock(v) { return ORION.format.stock(v); }

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

    /* Popolazione — refactor 2026-06-09: LIVELLI invece di persone. */
    const popUnitsCol = ORION.planet.popUnits(c) || 0;
    const popCapCol = (c.pop && c.pop.cap) || (planet && planet.popCap) || 0;
    totalPeople += popUnitsCol;
    const dev = Math.round(ORION.planet.popMaturity(c, planet) * 100);

    /* Morale (helper puro). */
    const morale = ORION.time.colonyMorale ? ORION.time.colonyMorale(g, c) : 1;
    const moraleState = morale >= 0.9 ? 'ok' : morale >= 0.65 ? 'low' : 'crit';

    /* Scorte totali + saldo netto/Ι REALE (incluso drenaggio pop + malus
       temporanei come nel deck e nella tab Risorse — productionFactors). */
    const out = ORION.planet.structureOutput(c, planet, g);
    const pf = (ORION.time && ORION.time.productionFactors)
      ? ORION.time.productionFactors(g, c)
      : { prodMul: 1, popFood: 0, popWater: 0, popMet: 0, popEn: 0, crewFood: 0, crewWater: 0 };
    /* Bilanciamento 2026-06-16: include manutenzione flotta met/en al porto,
       allineato a processProduction (drenaggio reale del tick). */
    const Fdash = ORION.fleet;
    const shipMet = (Fdash && Fdash.portMaintenance) ? Fdash.portMaintenance(g, c) : 0;
    const shipEn  = (Fdash && Fdash.portMaintenanceEn) ? Fdash.portMaintenanceEn(g, c) : 0;
    let stockTotal = 0, stockNet = 0;
    ['met', 'en', 'food', 'water'].forEach(function (rk) {
      stockTotal += (c.stock[rk] || 0);
      const popDrain =
        rk === 'food'  ? pf.popFood  :
        rk === 'water' ? pf.popWater :
        rk === 'met'   ? (pf.popMet  || 0) :
        rk === 'en'    ? (pf.popEn   || 0) : 0;
      const crewDrain = rk === 'food' ? (pf.crewFood || 0) : rk === 'water' ? (pf.crewWater || 0) : 0;
      const shipDrain = rk === 'met' ? shipMet : rk === 'en' ? shipEn : 0;
      stockNet += (out.rates[rk] || 0) * pf.prodMul - (out.upkeep[rk] || 0) - popDrain - crewDrain - shipDrain;
    });

    const tel = (ORION._empireTel && ORION._empireTel[k]) || { pop: [], morale: [], stock: [] };

    cards.push({
      key: k, sysId: sysId, name: planet.name, tag: bodyTagHtml(sysId),
      badges: badges.join(''), phaseLabel: phaseLabel,
      /* Refactor 2026-06-09: peopleStr → levelStr (display livelli). */
      people: popUnitsCol,
      peopleStr: popUnitsCol.toFixed(1) + ' / ' + popCapCol,
      levelStr: popUnitsCol.toFixed(1) + ' / ' + popCapCol,
      dev: dev,
      morale: morale, moraleState: moraleState,
      stockTotal: stockTotal, stockTotalStr: fmtStock(stockTotal), stockNet: stockNet,
      scarState: scarState,
      isCapital: !!isCapital,
      focused: (k === dxKey),
      spark: { pop: tel.pop, morale: tel.morale, stock: tel.stock }
    });
  });

  /* Ordine: capitale prima, poi per livelli decrescenti. */
  cards.sort(function (a, b) {
    if (a.isCapital !== b.isCapital) return a.isCapital ? -1 : 1;
    return b.people - a.people;
  });

  const totalsHtml =
    '<span class="empire-deck__total">' + uiIcon('home', 'cyan') + ' ' +
      totalPeople.toFixed(1) + ' livelli</span>' +
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

  /* ----- Navigazione (Galassia/Gruppo/Sistema/Pianeta) -----
     La sezione "Navigazione" separata è stata rimossa (decisione utente
     2026-06-16): le voci vivono ora come strip orizzontale in cima al
     Roster. Definita qui sopra perché viene consumata nella stessa render
     dal blocco Roster. */
  const navItems = [
    { view: 'galaxy', icon: 'galaxy', label: 'Galassia' },
    { view: 'group',  icon: 'group',  label: 'Gruppo' },
    { view: 'system', icon: 'system', label: 'Sistema' },
    { view: 'planet', icon: 'planet', label: 'Pianeta' }
  ];
  function navItemsHtml() {
    return navItems.map(function (n) {
      const active = (n.view === currentView) ? ' is-active' : '';
      const icon = (ORION.icon && ORION.icon(n.icon)) || '';
      return '<button class="nav-item' + active + '" data-view="' + n.view + '" type="button" title="' + escapeHtml(n.label) + '" aria-label="' + escapeHtml(n.label) + '">' +
        '<span class="nav-item__glyph ui-icon" aria-hidden="true">' + icon + '</span>' +
        '<span class="nav-item__label">' + n.label + '</span></button>';
    }).join('');
  }

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

  function fleetItemHtml(f) {
    const loc = f.location || {};
    const sysId = (loc.systemId != null && loc.systemId >= 0) ? loc.systemId : -1;
    const sysOf = function (id) { const s = id >= 0 ? g.galaxy.systems[id] : null; return s ? s.name : '—'; };
    const status = loc.status || 'idle';
    const berth = (status === 'docked' || status === 'orbiting') ? ORION.fleet.berthOf(g, f) : null;
    const statusLbl = status === 'docked' ? (berth === 'station' ? 'stazione' : 'hangar')
                    : status === 'in-transit' ? 'viaggio'
                    : (berth === 'orbit' ? 'parcheggio' : 'orbita');
    const cls = status === 'docked' ? 'ok' : status === 'in-transit' ? 'info' : 'warn';
    const fleetIcon = (ORION.icon && ORION.icon('fleet')) || '';
    /* Sub-text "dove sta" — corretto durante viaggi (richiesta utente
       2026-06-18): NON mostrare il sistema-stub di partenza come posizione
       quando la flotta è già in volo. Inter: "in viaggio → Dest (N Ι)".
       Intra: "Sys · → Body (N Ι)". Statico: "in Sys". */
    let subTxt;
    if (status === 'in-transit' && loc.intra) {
      const sId = loc.intra.systemId;
      let bodyName = null;
      if (loc.intra.toBodyKey && ORION.system && ORION.system.generate && ORION.system.findBody) {
        try { const ds = ORION.system.generate(g.galaxy, sId); const b = ds && ORION.system.findBody(ds, loc.intra.toBodyKey); bodyName = b ? b.name : null; } catch (e) { /* */ }
      }
      const eta = (f.etaImpulsi | 0);
      subTxt = sysOf(sId) + (bodyName ? ' · → ' + bodyName : ' · manovra interna') + (eta > 0 ? ' (' + eta + ' ' + iU() + ')' : '');
    } else if (status === 'in-transit') {
      const destSys = (f.orders && f.orders.toSysId != null) ? f.orders.toSysId
        : (Array.isArray(f.route) && f.route.length ? f.route[f.route.length - 1] : sysId);
      const eta = (f.etaImpulsi | 0);
      subTxt = 'in viaggio → ' + sysOf(destSys) + (eta > 0 ? ' (' + eta + ' ' + iU() + ')' : '');
    } else {
      subTxt = 'in ' + sysOf(sysId);
    }
    /* Comando in corso, sotto al sub-luogo, in mini-pill — coerente con
       l'ordine mostrato nella vista flotte (richiesta utente). */
    const o = f.orders;
    let orderTxt = '';
    if (o && o.type && o.type !== 'idle') {
      const tn = o.toSysId != null ? sysOf(o.toSysId) : '';
      if (o.type === 'move')          orderTxt = 'spostamento a ' + tn;
      else if (o.type === 'attack')   orderTxt = '⚔ attacco a ' + tn;
      else if (o.type === 'explore')  orderTxt = 'esplorazione di ' + tn;
      else if (o.type === 'survey')   orderTxt = '✦ raccolta anomalia · ' + tn;
      else if (o.type === 'recon')    orderTxt = 'ricognizione di ' + tn;
      else if (o.type === 'colonize') orderTxt = 'colonizzazione di ' + tn;
      else if (o.type === 'garrison') orderTxt = 'presidio di ' + tn;
      else if (o.type === 'return')   orderTxt = 'rientro alla base';
      else if (o.type === 'patrol')   orderTxt = 'pattuglia';
      else if (o.type === 'move-route') {
        const tot = (o.waypoints || []).length, cur = (o.wpIdx || 0) + 1;
        orderTxt = 'rotta a tappe (' + cur + '/' + tot + ')';
      } else if (o.type === 'patrol-loop') orderTxt = 'pattuglia ciclica';
      else orderTxt = o.type;
    }
    const orderHtml = orderTxt ? '<span class="lp-item__order">' + escapeHtml(orderTxt) + '</span>' : '';
    /* Decisione utente 2026-06-16: pillola usura/viveri su una SECONDA riga,
       sotto nome+badge. Inline mangiava la prima riga e troncava il nome. */
    const wearH = fleetWearHtml(f);
    const viveriH = fleetViveriHtml(f);
    return '<button class="lp-item lp-item--fleet" data-action="roster-fleet" data-id="' + escapeHtml(f.id) + '" data-sys="' + sysId + '" type="button">' +
      '<span class="lp-item__head">' +
        '<span class="lp-item__glyph ui-icon" aria-hidden="true">' + fleetIcon + '</span>' +
        '<span class="lp-item__name"><strong>' + escapeHtml(f.name) + '</strong> <span class="lp-item__sub">' + escapeHtml(subTxt) + '</span></span>' +
        '<span class="lp-item__badges"><span class="lp-item__badge lp-item__badge--' + cls + '">' + statusLbl + '</span></span>' +
      '</span>' +
      (orderHtml ? ('<span class="lp-item__row">' + orderHtml + '</span>') : '') +
      ((viveriH || wearH) ? ('<span class="lp-item__row">' + viveriH + wearH + '</span>') : '') +
    '</button>';
  }
  /* Stazioni orbitali (M16): elencate nel Roster come pari delle colonie
     (scelta utente). Click → vista Stazioni; lo stato (operativa/in opera/
     catturata/isolata) finisce nel badge. */
  const stations = (g.stations || []);
  const myStations = stations.filter(function (s) {
    return ORION.station && ORION.station.isPlayerStation
      ? ORION.station.isPlayerStation(s)
      : (s && s.owner == null);
  });
  function stationItemHtml(st) {
    const sysId = st.systemId;
    const sysName = sysId >= 0 && g.galaxy.systems[sysId] ? g.galaxy.systems[sysId].name : '—';
    const tag = bodyTagHtml(sysId); // sistema → tag regione
    let badgeLbl = 'operativa', badgeCls = 'ok';
    if (st.phase === 'building') { badgeLbl = 'in opera'; badgeCls = 'info'; }
    else if (st.supplyState === 'isolated') { badgeLbl = 'isolata'; badgeCls = 'crit'; }
    else if (st.supplyState === 'low') { badgeLbl = 'a corto'; badgeCls = 'warn'; }
    const lvl = Math.max(0, st.level | 0);
    const lvlChip = (st.phase === 'building' && lvl === 0)
      ? ''
      : '<span class="lp-item__badge lp-item__badge--info" title="Livello">lvl ' + lvl + '</span>';
    const stIcon = (ORION.icon && ORION.icon('station')) || '';
    const nm = st.name || ('Stazione ' + st.id);
    return '<button class="lp-item lp-item--station" data-action="roster-station" data-id="' + escapeHtml(st.id) + '" data-sys="' + sysId + '" type="button">' +
      '<span class="lp-item__glyph ui-icon" aria-hidden="true">' + stIcon + '</span>' +
      '<span class="lp-item__name"><strong>' + escapeHtml(nm) + '</strong>' + tag +
        ' <span class="lp-item__sub">in ' + escapeHtml(sysName) + '</span></span>' +
      '<span class="lp-item__badges">' + lvlChip +
        '<span class="lp-item__badge lp-item__badge--' + badgeCls + '">' + badgeLbl + '</span>' +
      '</span>' +
    '</button>';
  }
  const stationItems = myStations.map(stationItemHtml).join('');
  /* Riepilogo flotte raggruppate per gruppo stellare (specchio sintetico
     della vista centrale) per la linguetta dedicata "Flotte". */
  function fleetGroupedHtml() {
    const byG = {};
    fleets.forEach(function (f) {
      const cl = (g.galaxy.systems[f.location.systemId] || {}).cluster;
      (byG[cl] = byG[cl] || []).push(f);
    });
    const ids = Object.keys(byG).sort(function (a, b) { return byG[b].length - byG[a].length || Number(a) - Number(b); });
    return ids.map(function (cl) {
      const grp = g.galaxy.groups[cl] || {};
      const acr = grp.acronym ? ' <span class="name-tag">[' + escapeHtml(grp.acronym) + ']</span>' : '';
      return '<div class="lp-fleet-group">' +
        '<div class="lp-fleet-group__h">' + uiIcon('group', 'violet') +
          ' <strong>' + escapeHtml(grp.name || ('Gruppo ' + cl)) + '</strong>' + acr +
          '<span class="lp-fleet-group__n">' + byG[cl].length + '</span></div>' +
        byG[cl].map(fleetItemHtml).join('') +
      '</div>';
    }).join('');
  }

  /* Sezione Roster (decisione utente 2026-06-16):
     - rimossa la sezione "Navigazione" → i 4 livelli (Galassia/Gruppo/Sistema/
       Pianeta) vivono come strip orizzontale sempre visibile in testa alla
       sidebar (decisione utente 2026-06-16, seconda iterazione: fuori dal
       Roster, tra nome impero e linguette — utile in qualunque tab).
     - rimosse le flotte dal Roster (vivono nella linguetta dedicata "Flotte")
     - aggiunte le stazioni orbitali sotto le colonie come pari delle colonie */
  const navHorizontalHtml = '<nav class="lp-nav-horizontal" role="tablist" aria-label="Livello di navigazione">' +
    navItemsHtml() + '</nav>';
  const colonyGroupHtml = '<div class="lp-roster-group">' +
    '<div class="lp-roster-group__h">Colonie <span class="lp-roster-group__n">' + myKeys.length + '</span></div>' +
    (myKeys.length ? colItems : '<p class="lp-empty">Nessuna colonia operativa.</p>') +
  '</div>';
  const stationGroupHtml = '<div class="lp-roster-group">' +
    '<div class="lp-roster-group__h">Stazioni orbitali <span class="lp-roster-group__n">' + myStations.length + '</span></div>' +
    (myStations.length ? stationItems : '<p class="lp-empty">Nessuna stazione orbitale.</p>') +
  '</div>';
  const rosterBody = colonyGroupHtml + stationGroupHtml;
  const rosterCount = myKeys.length + ' colonie · ' + myStations.length + ' stazioni';
  /* Alert sulla linguetta Roster: scarsità crit (rosso) / low (ambra). */
  let rosterAlert = null;
  myKeys.forEach(function (k) {
    const sc = g.colonies[k] && g.colonies[k]._scar;
    if (!sc) return;
    ['met','en','food','water'].forEach(function (rk) {
      const s = sc[rk] && sc[rk].state;
      if (s === 'crit') rosterAlert = 'bad';
      else if (s === 'low' && rosterAlert !== 'bad') rosterAlert = 'warn';
    });
  });

  /* navItems definito in testa a renderLeftPanel — riusato qui sotto. */

  /* ----- Launcher (Diplomazia/Ricerca/Mercato + vista Flotte/Civiltà) ----- */
  function launcherIcon(name) {
    return (ORION.icon && ORION.icon(name)) || '';
  }
  const vFocus = (ORION.victory && ORION.victory.getFocus) ? ORION.victory.getFocus(g) : null;
  const vFocusSub = vFocus ? (ORION.victory.TRACK_LABELS[vFocus] || vFocus) : 'nessun focus';
  const launcherHtml =
    '<button class="lp-launcher__btn lp-launcher__btn--destiny' + (currentView === 'destiny' ? ' is-active' : '') + '" data-view="destiny" type="button">' +
      '<span class="lp-launcher__glyph ui-icon" aria-hidden="true">' + launcherIcon('trophy') + '</span>' +
      '<span>Destino</span>' +
      '<span class="lp-launcher__sub">' + escapeHtml(vFocusSub) + '</span>' +
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
    '</button>' +
    '<button class="lp-launcher__btn' + (currentView === 'stations' ? ' is-active' : '') + '" data-view="stations" type="button">' +
      '<span class="lp-launcher__glyph ui-icon" aria-hidden="true">' + launcherIcon('station') + '</span>' +
      '<span>Stazioni</span>' +
      '<span class="lp-launcher__sub">' + stationLauncherSub() + '</span>' +
    '</button>' +
    '<button class="lp-launcher__btn' + (currentView === 'dispatch' ? ' is-active' : '') + (dispatchPending() ? ' lp-launcher__btn--alert' : '') + '" data-view="dispatch" type="button">' +
      '<span class="lp-launcher__glyph ui-icon" aria-hidden="true">' + launcherIcon('dispatch') + '</span>' +
      '<span>Dispacci</span>' +
      '<span class="lp-launcher__sub">' + dispatchLauncherSub() + '</span>' +
    '</button>';

  /* ----- Cronaca (collassabile) -----
     Manteniamo sempre un <ul data-bind="chronicle"> presente nel DOM
     così che pushChronicle/restoreChronicleDom funzionino anche quando
     la lista è vuota al boot. */
  /* Cronaca a 2 sezioni (Galassia / Colonie) — sostituisce il vecchio
     segmented control "Importanti / Tutto" che non filtrava il pregresso.
     Galassia: voci/diplomazia/AI/flotte/stazioni/scoperte.
     Colonie: avvisi interni (carestie, rientri, capitali, vittorie,
     consiglio). Il rumore di routine (build/varo/hop/insediamento) è
     escluso a monte in chronicleEvent → non finisce in nessuna sezione. */
  const sec = (ORION.chronicleSection === 'colony') ? 'colony' : 'galaxy';
  ORION.chronicleSection = sec;
  const unread = ORION.chronicleUnread || { galaxy: false, colony: false };
  const cronAll = (g.chronicle || []).slice(0, 40);
  const cronFiltered = cronAll.filter(function (e) {
    const cat = e.cat || chronicleCategoryFromMod(e.mod);
    return cat === sec;
  });
  const sectionsHtml =
    '<div class="chron-sections" role="tablist" aria-label="Sezioni cronaca">' +
      '<button class="chron-sections__btn' + (sec === 'galaxy' ? ' is-active' : '') +
        ((unread.galaxy && sec !== 'galaxy') ? ' has-alert' : '') + '" ' +
        'data-chron-section="galaxy" type="button" ' +
        'title="Voci dalla galassia: contatti, diplomazia, civiltà AI, flotte e scoperte.">Galassia' +
        ((unread.galaxy && sec !== 'galaxy') ? '<span class="chron-sections__dot" aria-hidden="true"></span>' : '') +
      '</button>' +
      '<button class="chron-sections__btn' + (sec === 'colony' ? ' is-active' : '') +
        ((unread.colony && sec !== 'colony') ? ' has-alert' : '') + '" ' +
        'data-chron-section="colony" type="button" ' +
        'title="Avvisi dalle colonie: carestie, rientri, milestone, consiglio.">Colonie' +
        ((unread.colony && sec !== 'colony') ? '<span class="chron-sections__dot" aria-hidden="true"></span>' : '') +
      '</button>' +
    '</div>';
  const cronHtml = sectionsHtml + '<ul class="chronicle__log">' + (cronFiltered.length
    ? cronFiltered.map(function (e) {
        const mod = e.mod ? ' chronicle__entry--' + e.mod : '';
        return '<li class="chronicle__entry' + mod + '">' + e.html + '</li>';
      }).join('')
    : '<li class="chronicle__entry chronicle__entry--system">Nessuna voce.</li>'
  ) + '</ul>';

  /* Identità del popolo (decisione #65): banner cliccabile in testa → editor. */
  const emp = ORION.game && ORION.game.empire;
  const empHtml = '<button type="button" class="lp-empire" data-action="empire-edit" title="Rinomina il tuo popolo">' +
    '<span class="lp-empire__name">' + escapeHtml(emp ? formatEmpire(emp) : '—') + '</span>' +
    '<span class="lp-empire__edit" aria-hidden="true">✎</span>' +
  '</button>';
  /* M14 Fase B2/B3 (#78/#79): Consiglio della Civiltà §9.4 — costituito a
     soglia; ogni seggio istituzionale o con figura elevata; delega + proposte. */
  let councilBody = '';
  let councilProposals = 0;
  if (ORION.council && ORION.council.list && ORION.council.isConstituted(g)) {
    const advs = ORION.council.list(g);
    const LVL = ORION.council.LEVEL_LABEL;
    councilBody = '<ul class="lp-council">' + advs.map(function (a) {
      const gl = (ORION.council.ROLES[a.role] && ORION.council.ROLES[a.role].glyph) || '•';
      const allowed = ORION.council.allowedLevels(a);
      const lvSel = '<select class="lp-council__level" data-council-level="' + a.role + '" title="Livello di delega">' +
        allowed.map(function (lv) { return '<option value="' + lv + '"' + (a.level === lv ? ' selected' : '') + '>' + LVL[lv] + '</option>'; }).join('') +
        '</select>';
      const fig = ORION.council.hasFigure(a);
      const src = fig
        ? '<span class="lp-council__fig" title="Figura elevata (ritirata dal servizio)">★ ' + escapeHtml(ORION.council.seatSource(a)) + '</span>'
        : '<span class="lp-council__interim" title="Consigliere istituzionale">istituzionale</span>';
      const elig = ORION.council.eligibleFor(g, a.role);
      const elevBtn = (elig.length)
        ? '<button class="btn btn--mini lp-council__elev" data-council-elevate="' + a.role + '" type="button" title="Eleva una figura del dominio al seggio">↑ Eleva (' + elig.length + ')</button>'
        : '';
      let mid;
      if (a.pending) {
        councilProposals++;
        mid = '<div class="lp-council__proposal">' +
          '<div class="lp-council__ptext">Pronto: ' + councilActionDesc(a.pending) + '</div>' +
          '<div class="lp-council__pbtns">' +
            '<button class="btn btn--mini" data-council-accept="' + a.role + '" type="button">Approva</button>' +
            '<button class="btn btn--mini btn--danger" data-council-reject="' + a.role + '" type="button">Rifiuta</button>' +
          '</div></div>';
      } else if (a.lastAdvice) {
        mid = '<div class="lp-council__advice">' + councilAdviceParts(a.role, a.lastAdvice.topic, a.lastAdvice.ref, a.lastAdvice.res).msg + '</div>';
      } else {
        mid = '<div class="lp-council__advice"><span class="lp-council__idle">Nessun rilievo recente.</span></div>';
      }
      const log = (a.decisions && a.decisions.length)
        ? '<div class="lp-council__log">Ultime: ' + a.decisions.slice(0, 3).map(function (d) { return escapeHtml(d.label); }).join(' · ') + '</div>'
        : '';
      return '<li class="lp-council__item lp-council__item--' + a.role + '">' +
        '<div class="lp-council__head"><span class="lp-council__glyph">' + gl + '</span> ' +
          '<strong>' + escapeHtml(ORION.council.seatName(a)) + '</strong> · ' + escapeHtml(a.label) + lvSel + '</div>' +
        '<div class="lp-council__sub">' + src + elevBtn + '</div>' +
        mid + log +
      '</li>';
    }).join('') + '</ul>';
  }

  /* ----- Linguette a icone (stesso meccanismo/stile della dx) -----
     Le 5 macro-sezioni diventano tab: una sola attiva per volta, niente
     più scroll alto/basso per cambiare sezione. Riusa le classi
     .planet-tabs/.planet-tab del pannello dx → stile identico (glow). */
  /* Flotte come SEZIONE dedicata, fuori da "Sale e moduli" (richiesta utente
     2026-06-13): linguetta propria con launcher alla vista + roster flotte
     cliccabili + avviso minacce di guerra. */
  const warThreats = ((g.incursions || []).length) + ((g.battles || []).filter(function (b) { return b.status === 'active'; }).length);
  const fleetTabBody =
    '<div class="lp-launcher lp-launcher--single">' +
      '<button class="lp-launcher__btn' + (currentView === 'fleet' ? ' is-active' : '') + '" data-view="fleet" type="button">' +
        '<span class="lp-launcher__glyph ui-icon" aria-hidden="true">' + launcherIcon('fleet') + '</span>' +
        '<span>Flotte e guerra</span>' +
        '<span class="lp-launcher__sub">' + fleets.length + (warThreats ? ' · ⚠' + warThreats : '') + '</span>' +
      '</button>' +
    '</div>' +
    (warThreats
      ? '<div class="lp-fleet-war">' + uiIcon('warning', 'pink') + ' ' + warThreats + ' minaccia' + (warThreats === 1 ? '' : '/e') + ' in corso — apri la vista per gestirle</div>'
      : '') +
    (fleets.length ? fleetGroupedHtml() : '<p class="lp-empty">Nessuna flotta attiva. Crea una flotta da un Hangar.</p>');

  /* Riepilogo equipaggi (richiesta utente 2026-06-16): linguetta gemella
     di "Flotte". Alert ambra se ≥1 equipaggio è vicino alla promozione. */
  let crewSnap = null;
  let crewAlert = null;
  if (ORION.crewRoster && ORION.crewRoster.snapshot) {
    crewSnap = ORION.crewRoster.snapshot(g);
    if (crewSnap.totals.promotable > 0) crewAlert = 'info';
  }

  const lpTabs = [
    { id: 'roster',    iconName: 'roster',    tone: 'cyan',   label: 'Roster',        alert: rosterAlert },
    { id: 'fleet',     iconName: 'fleet',     tone: 'cyan',   label: 'Flotte',        alert: warThreats ? 'bad' : null },
    { id: 'crews',     iconName: 'forces',    tone: 'amber',  label: 'Equipaggi',     alert: crewAlert },
    { id: 'launcher',  iconName: 'settings',  tone: 'gold',   label: 'Sale e moduli', alert: (typeof dispatchPending === 'function' && dispatchPending()) ? 'info' : null }
  ];
  if (councilBody) {
    lpTabs.push({ id: 'council', iconName: 'star', tone: 'amber', label: 'Consiglio', alert: councilProposals ? 'warn' : null });
  }
  /* Aura sulla linguetta Cronaca: pulsa se c'è almeno una sezione con
     eventi importanti non visti (e la tab Cronaca non è quella attiva). */
  const chronUnreadAny = !!((ORION.chronicleUnread && (ORION.chronicleUnread.galaxy || ORION.chronicleUnread.colony)));
  lpTabs.push({ id: 'chronicle', iconName: 'chronicle', tone: 'green', label: 'Cronaca', alert: chronUnreadAny ? 'info' : null });

  /* Linguetta attiva: se 'council' ma il Consiglio non è costituito, fallback. */
  let activeLp = ORION.lpTab;
  if (!lpTabs.some(function (t) { return t.id === activeLp; })) activeLp = 'roster';
  ORION.lpTab = activeLp;

  const tabsHtml = '<nav class="planet-tabs lp-tabs" role="tablist">' +
    lpTabs.map(function (t) {
      const iconSvg = (ORION.icon && ORION.icon(t.iconName)) || '';
      const isActive = (t.id === activeLp);
      const alertCls = (t.alert && !isActive) ? ' has-alert has-alert--' + t.alert : '';
      const iconHtml = '<span class="planet-tab__icon ui-icon planet-tab__icon--' + t.tone + '" aria-hidden="true">' + iconSvg + '</span>';
      return '<button class="planet-tab' + (isActive ? ' is-active' : '') + alertCls + '" data-lp-tab="' + t.id + '" type="button"' +
        ' title="' + escapeHtml(t.label) + '" aria-label="' + escapeHtml(t.label) + '">' + iconHtml + '</button>';
    }).join('') +
  '</nav>';

  /* Corpo della sola sezione attiva. */
  let bodyHtml = '';
  if (activeLp === 'roster') {
    bodyHtml = '<div class="lp-tab-body"><div class="lp-tab-body__count">' + rosterCount + '</div>' + rosterBody + '</div>';
  } else if (activeLp === 'fleet') {
    bodyHtml = '<div class="lp-tab-body">' + fleetTabBody + '</div>';
  } else if (activeLp === 'crews') {
    const crewBody = (ORION.crewRoster && ORION.crewRoster.renderSidebarTab)
      ? ORION.crewRoster.renderSidebarTab(g)
      : '<p class="lp-empty">Modulo equipaggi non disponibile.</p>';
    bodyHtml = '<div class="lp-tab-body lp-tab-body--crew">' + crewBody + '</div>';
  } else if (activeLp === 'launcher') {
    bodyHtml = '<div class="lp-tab-body"><div class="lp-launcher">' + launcherHtml + '</div></div>';
  } else if (activeLp === 'council') {
    bodyHtml = '<div class="lp-tab-body">' + councilBody + '</div>';
  } else if (activeLp === 'chronicle') {
    bodyHtml = '<div class="lp-tab-body lp-tab-body--chron" data-bind="chronicle-host">' + cronHtml + '</div>';
  }

  host.innerHTML = empHtml + navHorizontalHtml + tabsHtml + bodyHtml;

  /* Bind tab Equipaggi (richiesta utente 2026-06-16): ordinamento ciclico
     + click su riga (focus colonia o sistema/gruppo). Idempotente: cerca
     solo se la tab è attiva. */
  if (activeLp === 'crews' && ORION.crewRoster && ORION.crewRoster.bindSidebarTab) {
    ORION.crewRoster.bindSidebarTab(host);
  }

  /* Mantieni `[data-bind="chronicle"]` valido per pushChronicle/restore:
     ri-tagghiamo l'UL come "chronicle" così le funzioni esistenti continuano
     a funzionare senza modifiche (presente solo a tab Cronaca attiva; le
     funzioni guardano `if (!log) return` → fonte di verità game.chronicle). */
  const ul = host.querySelector('.chronicle__log');
  if (ul) ul.setAttribute('data-bind', 'chronicle');

  /* Bind linguette sezione cronaca (Galassia/Colonie): cambio sezione +
     reset aura "non letti" per la sezione appena aperta. */
  host.querySelectorAll('[data-chron-section]').forEach(function (b) {
    b.addEventListener('click', function () {
      const v = b.dataset.chronSection;
      if (v !== 'galaxy' && v !== 'colony') return;
      if (!ORION.chronicleUnread) ORION.chronicleUnread = { galaxy: false, colony: false };
      ORION.chronicleUnread[v] = false;
      if (ORION.chronicleSection === v) {
        saveUiPrefs();
        renderLeftPanel();
        return;
      }
      ORION.chronicleSection = v;
      saveUiPrefs();
      renderLeftPanel();
    });
  });

  /* Identità popolo: click sul banner → editor (decisione #65). */
  const empBtn = host.querySelector('[data-action="empire-edit"]');
  if (empBtn) empBtn.addEventListener('click', openEmpireEditor);

  /* Bind handlers — linguette: cambia ORION.lpTab e ridisegna.
     Aprendo la tab Cronaca azzeriamo l'aura della sezione attualmente
     visualizzata (le voci stanno per essere lette). */
  host.querySelectorAll('[data-lp-tab]').forEach(function (b) {
    b.addEventListener('click', function () {
      ORION.lpTab = b.dataset.lpTab;
      if (ORION.lpTab === 'chronicle' && ORION.chronicleUnread) {
        const cur = ORION.chronicleSection || 'galaxy';
        ORION.chronicleUnread[cur] = false;
      }
      saveUiPrefs();
      renderLeftPanel();
    });
  });
  /* M14 Fase B2 (#78): Consiglio — dropdown delega + Approva/Rifiuta proposta.
     stopPropagation sulla select: è dentro la testata cliccabile della sezione. */
  host.querySelectorAll('[data-council-level]').forEach(function (sel) {
    sel.addEventListener('click', function (e) { e.stopPropagation(); });
    sel.addEventListener('change', function (e) {
      e.stopPropagation();
      if (ORION.council) ORION.council.setLevel(ORION.game, sel.dataset.councilLevel, sel.value);
      if (ORION.tutorial) ORION.tutorial.fire('council');
      persistGame(ORION.game);
      renderLeftPanel();
    });
  });
  host.querySelectorAll('[data-council-accept]').forEach(function (b) {
    b.addEventListener('click', function () {
      const evs = [];
      const r = ORION.council.acceptProposal(ORION.game, b.dataset.councilAccept, evs);
      evs.forEach(function (ev) { chronicleEvent(ev); });
      showToast(r && r.ok ? 'Decisione del Consiglio approvata' : ('Non riuscita: ' + ((r && r.reason) || '')));
      persistGame(ORION.game);
      renderLeftPanel();
    });
  });
  host.querySelectorAll('[data-council-reject]').forEach(function (b) {
    b.addEventListener('click', function () {
      ORION.council.rejectProposal(ORION.game, b.dataset.councilReject);
      persistGame(ORION.game);
      renderLeftPanel();
    });
  });
  host.querySelectorAll('[data-council-elevate]').forEach(function (b) {
    b.addEventListener('click', function () { openCouncilElevatePicker(b.dataset.councilElevate); });
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
      const fid = btn.dataset.id;
      const fleet = (ORION.game && ORION.game.fleets || []).find(function (f) { return f.id === fid; });
      const loc = fleet && fleet.location;
      /* Decisione utente 2026-06-16: una flotta parcheggiata o impegnata in
         un task intra-sistema (attracco/orbita/intra-transit) merita lo zoom
         a livello SISTEMA — la mostriamo sull'anomalia/corpo/colonia con
         dettaglio immediato. Solo il viaggio INTERSTELLARE (in-transit senza
         `intra`) resta a livello gruppo, dove la flotta è un puntino lungo
         la rotta tra stelle. */
      if (sid >= 0 && ORION.game && ORION.game.state) ORION.game.state.selectedId = sid;
      const inInterstellar = !!(loc && loc.status === 'in-transit' && !loc.intra);
      if (inInterstellar) {
        navigateView('group');
        if (sid >= 0 && ORION.map && ORION.map.focusSystemCentered) ORION.map.focusSystemCentered(sid);
      } else {
        navigateView('system');
      }
    });
  });
  /* Stazioni orbitali nel Roster (decisione utente 2026-06-16): click →
     apre la vista Stazioni (parità con le colonie). */
  host.querySelectorAll('[data-action="roster-station"]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const sid = Number(btn.dataset.sys);
      if (sid >= 0 && ORION.game && ORION.game.state) ORION.game.state.selectedId = sid;
      navigateView('stations');
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
  rebind('[data-cancel-merc]', function (b) { tryCancelMerc(Number(b.dataset.cancelMerc)); });
  rebind('[data-cancel-crew]', function (b) { tryCancelCrew(Number(b.dataset.cancelCrew)); });
  /* I bottoni reali della tab Forze emettono `data-build-ship`/`data-build-crew`
     (non `data-action="..."`): senza i selettori giusti la rebind non li
     intercettava e il listener centrale girava col contesto già ripristinato
     (currentPlanet null a livello galassia → crash, o colonia sbagliata). */
  rebind('[data-build-ship]', function () { tryBuildShip(); });
  rebind('[data-build-crew]', function () { tryBuildCrew(); });
  /* Dropdown classe nave: la scelta va scritta sulla colonia dx, non su
     quella navigata al centro. */
  content.querySelectorAll('[data-ship-kind]').forEach(function (sel) {
    const nb = sel.cloneNode(true);
    sel.parentNode.replaceChild(nb, sel);
    nb.addEventListener('change', withDxScope(function () {
      if (!ORION.cantieriPickedKind) ORION.cantieriPickedKind = {};
      ORION.cantieriPickedKind[dxKey] = nb.value;
      renderDxPanel();
    }));
  });
  rebind('[data-action="capital-declare"]', function () {
    /* Il bind originale di capital-declare contiene logica complessa
       (confirm, pushChronicle); per riusarlo intero, lo richiamiamo dal
       bindCapitalHandlers. Re-installiamo: */
    bindCapitalHandlers(content, planet, colony);
    /* Triggera click del nuovo bottone (è già stato sostituito sopra,
       quindi questo è no-op se il flusso è completato — fallback). */
  });
  /* Governor dropdowns (decisione #59 Tier 2): rebind diretto. */
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
  let infoCardHtml = '';
  /* PR-N: a livello SISTEMA con corpo selezionato → info card contestuale
     (nome+tipo+stato+potenziali) + bottoni di azione. Chiude il buco UX
     della decisione #50: con la dx fissa sulla MIA colonia, navigando in
     sistema non si vedeva nulla cliccando sui corpi altrui. */
  if (ctx && ctx.level === 'system' && ctx.bodyKey && ORION.currentSystem) {
    const sysId = ctx.systemId;
    const system = ORION.currentSystem;
    const body = ORION.system && ORION.system.findBody ? ORION.system.findBody(system, ctx.bodyKey) : null;
    if (body) {
      /* Genera (o riusa) il planet per leggere potentials/colCost. */
      const memoKey = sysId + ':' + ctx.bodyKey;
      ORION._planetMemo = ORION._planetMemo || {};
      let planet = ORION._planetMemo[memoKey];
      if (!planet && ORION.planet && ORION.planet.generate) {
        try {
          planet = ORION.planet.generate(g.galaxy, system, ctx.bodyKey);
          if (planet) ORION._planetMemo[memoKey] = planet;
        } catch (_) { /* fallback below */ }
      }
      const def = ORION.system && ORION.system.BODY_TYPES ? ORION.system.BODY_TYPES[body.type] : null;
      const typeLabel = def ? def.label : body.type;
      const habitable = !!(def && def.habitable);
      const colKey = sysId + ':' + ctx.bodyKey;
      const colony = g.colonies[colKey];
      const civ = (ORION.ai && ORION.ai.civForSystem) ? ORION.ai.civForSystem(g, sysId) : null;
      const isMine = !!(colony && colony.colonized);
      const isForeign = !!(civ && !isMine);
      const isFree = !isMine && !isForeign;

      /* Badge stato del corpo */
      let badgeHtml = '';
      if (isMine && colony.isHomeBase) {
        badgeHtml = '<span class="bodyinfo__badge bodyinfo__badge--home">' + icnHtml('star', 'amber') + ' Pianeta base</span>';
      } else if (isMine) {
        badgeHtml = '<span class="bodyinfo__badge bodyinfo__badge--colony">' + icnHtml('star', 'cyan') + ' Colonia attiva</span>';
      } else if (isForeign) {
        const align = (civ.alignment || '').toLowerCase();
        const aClass = align === 'bene' ? 'good' : align === 'male' ? 'bad' : 'warn';
        badgeHtml = '<span class="bodyinfo__badge bodyinfo__badge--civ bodyinfo__badge--' + aClass + '">' + icnHtml('civ', 'pink') + ' ' + escapeHtml(civ.name) + '</span>';
      } else if (body.homeWorld) {
        badgeHtml = '<span class="bodyinfo__badge bodyinfo__badge--candidate">' + icnHtml('star', 'amber') + ' Mondo natale candidato</span>';
      } else if (isFree && habitable) {
        badgeHtml = '<span class="bodyinfo__badge bodyinfo__badge--free">Libero · colonizzabile</span>';
      } else if (isFree && !habitable) {
        badgeHtml = '<span class="bodyinfo__badge bodyinfo__badge--inhospital">Non abitabile</span>';
      }

      /* Mini-barre dei 4 potenziali (sempre, se disponibili dal planet). */
      let potsHtml = '';
      if (planet && planet.potentials) {
        const labels = { met: 'Met', en: 'En', food: 'Cib', water: 'Acq' };
        potsHtml = '<div class="bodyinfo__pots" title="Potenziali risorse base (0-100)">';
        ['met', 'en', 'food', 'water'].forEach(function (k) {
          const v = planet.potentials[k] || 0;
          potsHtml +=
            '<span class="bodyinfo__pot bodyinfo__pot--' + k + '">' +
              '<span class="bodyinfo__pot-lbl">' + labels[k] + '</span>' +
              '<span class="bodyinfo__pot-bar"><i style="width:' + Math.max(0, Math.min(100, v)) + '%"></i></span>' +
              '<span class="bodyinfo__pot-val">' + v + '</span>' +
            '</span>';
        });
        potsHtml += '</div>';
      }

      /* Moons + anomalie quick info */
      let extraHtml = '';
      const moonCount = body.moons ? body.moons.length : 0;
      if (moonCount) {
        extraHtml += '<span class="bodyinfo__meta">● ' + moonCount + ' lun' + (moonCount === 1 ? 'a' : 'e') + '</span>';
      }

      /* Decisione di sessione: chip secondari "in colpo d'occhio" sotto le
         barre dei potenziali. Mostriamo i dati che NON sono ancora visibili
         da nessun'altra parte a livello Sistema: slot/popCap/pericolo/
         ostilità/avanzate (numero mascherato, l'identità arriva con la
         scansione §7.3). I gas/cinture non sono colonizzabili → niente
         slot/pop ma comunque pericolo (sistema) + estrazione. */
      let chipsHtml = '';
      if (planet) {
        const isBelt = def && def.cat === 'belt';
        const isGas  = def && def.cat === 'gas';
        const sysDanger = (g.galaxy.systems[sysId] && g.galaxy.systems[sysId].danger) || 0;
        const sysTier   = (g.galaxy.systems[sysId] && g.galaxy.systems[sysId].dangerTier) || '';
        const dCls = sysDanger >= 70 ? 'is-crit' : sysDanger >= 40 ? 'is-warn' : 'is-ok';
        const hostility = planet.hostility != null ? planet.hostility : null;
        const hCls = hostility == null ? '' :
          (hostility >= 20 ? 'is-crit' : hostility >= 10 ? 'is-warn' : 'is-ok');
        const advN = (planet.advanced && planet.advanced.length) || 0;
        const chips = [];
        if (!isBelt && !isGas) {
          chips.push('<span class="bodyinfo__chip" title="Slot di costruzione disponibili §10.2">' +
            '<span class="bodyinfo__chip-k">Slot</span>' +
            '<span class="bodyinfo__chip-v">' + (planet.slots != null ? planet.slots : '—') + '</span></span>');
          if (planet.popCap > 0) {
            chips.push('<span class="bodyinfo__chip" title="Popolazione massima sostenibile (unità)">' +
              '<span class="bodyinfo__chip-k">Pop max</span>' +
              '<span class="bodyinfo__chip-v">' + planet.popCap + '</span></span>');
          }
        } else {
          chips.push('<span class="bodyinfo__chip is-mute" title="' + (isBelt ? 'Cintura asteroidale: solo estrazione orbitale' : 'Gigante gassoso: solo estrazione orbitale') + '">' +
            '<span class="bodyinfo__chip-k">' + (isBelt ? 'Cintura' : 'Gassoso') + '</span>' +
            '<span class="bodyinfo__chip-v">estraz. orbitale</span></span>');
        }
        chips.push('<span class="bodyinfo__chip ' + dCls + '" title="Pericolo §5.3 del sistema (raggio dalla tua origine)">' +
          '<span class="bodyinfo__chip-k">Pericolo</span>' +
          '<span class="bodyinfo__chip-v">' + sysDanger + (sysTier ? (' · ' + sysTier) : '') + '</span></span>');
        if (hostility != null) {
          chips.push('<span class="bodyinfo__chip ' + hCls + '" title="Ostilità locale del corpo: clima, geologia, fauna ostile">' +
            '<span class="bodyinfo__chip-k">Ostilità</span>' +
            '<span class="bodyinfo__chip-v">' + hostility + '</span></span>');
        }
        if (advN > 0) {
          chips.push('<span class="bodyinfo__chip is-violet" title="Risorse avanzate §7.2 presenti — identità rivelata da un osservatorio">' +
            '<span class="bodyinfo__chip-k">⚛ Avanzate</span>' +
            '<span class="bodyinfo__chip-v">' + advN + ' — scansiona</span></span>');
        }
        chipsHtml = '<div class="bodyinfo__chips">' + chips.join('') + '</div>';
      }

      /* Distanza UNIVERSALE dalla colonia più vicina, indipendente dalla
         velocità delle navi.
         - INTER-sistema (hops≥1): salti = BFS sul grafo iperspaziale
           (galaxy.routes/links); tempo = Σ fleet.tempoLeg(_, _, _, 1.0) →
           minSpeed=1.0 (Cargo leggero / Caccia base).
         - INTRA-sistema (stessa stella): distanza orbitale euclidea tra i
           due corpi (riusa la geometria di system.js: orbit×angle + lune
           in orbita relativa al genitore), convertita in Ι con il
           placeholder GDD §13 (4-12 Ι base) → fattore 6 dà 2-12 Ι per
           distanze tipiche 0.3-2.0 unità di mondo. È onesto: oggi
           l'engine fa 0 Ι intra-sistema (decisione #67), ma la distanza
           fisica esiste e questo valore servirà quando l'iperdrive
           intra-sistema (decisione #32) e M16 introdurranno un costo
           reale di spostamento.
         Le colonie INTRA-sistema vincono sempre su quelle inter (sono
         oggettivamente più vicine). Tra intra → min distanza. Tra inter
         → min hops, ties → min Ι. */
      let distHtml = '';
      const F = ORION.fleet;
      if (F && F.computePath && F.tempoLeg && g.colonies) {
        /* Posizione di mondo di un corpo (riusa la formula di
           system-view.js#bodyWorldPos). Per le lune: orbita relativa al
           genitore. */
        function bodyWorldPos(sys, b) {
          if (b.parentKey) {
            const parent = ORION.system.findBody(sys, b.parentKey);
            const pp = parent ? {
              x: Math.cos(parent.angle) * parent.orbit,
              y: Math.sin(parent.angle) * parent.orbit
            } : { x: 0, y: 0 };
            return {
              x: pp.x + Math.cos(b.angle) * (b.moonOrbit || 0),
              y: pp.y + Math.sin(b.angle) * (b.moonOrbit || 0)
            };
          }
          return {
            x: Math.cos(b.angle) * (b.orbit || 0),
            y: Math.sin(b.angle) * (b.orbit || 0)
          };
        }
        const targetPos = bodyWorldPos(system, body);
        const INTRA_FACTOR = 6;   // dist 0.3-2.0 → ~2-12 Ι (GDD §13 base 4-12)
        let bestIntra = null, bestInter = null;
        const keys = Object.keys(g.colonies);
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i];
          const c = g.colonies[k];
          if (!c || !c.colonized) continue;
          const parts = String(k).split(':');
          const fromSys = parseInt(parts[0], 10);
          const fromBk = parts[1];
          if (isNaN(fromSys)) continue;
          if (k === colKey) continue;   // non confrontare con se stesso (es. mia colonia su questo stesso corpo)
          if (fromSys === sysId) {
            /* Intra-sistema: distanza orbitale. */
            const cBody = ORION.system.findBody(system, fromBk);
            if (!cBody) continue;
            const cPos = bodyWorldPos(system, cBody);
            const dx = targetPos.x - cPos.x, dy = targetPos.y - cPos.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const intraI = Math.max(1, Math.round(dist * INTRA_FACTOR));
            if (!bestIntra || intraI < bestIntra.intraI) {
              bestIntra = { intraI: intraI, colonyKey: k };
            }
          } else {
            const path = F.computePath(g.galaxy, fromSys, sysId);
            if (!path) continue;
            const hops = path.length - 1;
            let timeI = 0;
            for (let j = 0; j < hops; j++) timeI += F.tempoLeg(g.galaxy, path[j], path[j + 1], 1);
            if (!bestInter || hops < bestInter.hops || (hops === bestInter.hops && timeI < bestInter.timeI)) {
              bestInter = { hops: hops, timeI: timeI, colonyKey: k };
            }
          }
        }
        /* Le intra-sistema vincono sempre. */
        const best = bestIntra ? Object.assign({ kind: 'intra' }, bestIntra)
                              : bestInter ? Object.assign({ kind: 'inter' }, bestInter) : null;
        if (best) {
          let cname = '—';
          try {
            const cs = parseInt(String(best.colonyKey).split(':')[0], 10);
            const cb = String(best.colonyKey).split(':')[1];
            const sys2 = ORION.system.generate(g.galaxy, cs);
            const pl2 = ORION.planet.generate(g.galaxy, sys2, cb);
            if (pl2 && pl2.name) cname = pl2.name;
          } catch (_) { /* fallback */ }
          let line;
          if (best.kind === 'intra') {
            const intraFmt = (ORION.time && ORION.time.format)
              ? ORION.time.format(best.intraI, 'duration')
              : (best.intraI + ' I');
            line = '<strong>intra-sistema</strong>' +
              ' · <span class="bodyinfo__dist-time">~' + intraFmt + '</span>' +
              ' da <strong>' + escapeHtml(cname) + '</strong>';
          } else {
            const durFmt = (ORION.time && ORION.time.format)
              ? ORION.time.format(best.timeI, 'duration')
              : (best.timeI + ' I');
            line = '<strong>' + best.hops + ' salt' + (best.hops === 1 ? 'o' : 'i') + '</strong>' +
              ' · <span class="bodyinfo__dist-time">~' + durFmt + '</span>' +
              ' da <strong>' + escapeHtml(cname) + '</strong>';
          }
          const tipText = best.kind === 'intra'
            ? 'Distanza orbitale stimata (valore standard, indipendente da velocità navi)'
            : 'Distanza standard (velocità 1.0): le tue navi vere viaggiano più veloci col loro speed';
          distHtml = '<div class="bodyinfo__dist" title="' + tipText + '">' +
            '<span class="bodyinfo__dist-icon" aria-hidden="true">✦</span> ' +
            '<span class="bodyinfo__dist-k">Distanza</span> ' + line +
          '</div>';
        }
      }

      /* Feedback utente 2026-06-15: dettaglio costo colonizzazione direttamente
         nella action bar (in basso). Riusa la helper renderColonizeCostBlock
         con flag compact (no header sezione Impulsi/Ostilità, già mostrati
         altrove). Mostrato solo se il pianeta è ancora libero e abitabile. */
      let costBlockHtml = '';
      if (isFree && habitable && planet && planet.colCost) {
        costBlockHtml =
          '<div class="bodyinfo__cost">' +
            renderColonizeCostBlock(planet, { compact: true }) +
          '</div>';
      }

      infoCardHtml =
        '<div class="bodyinfo">' +
          '<div class="bodyinfo__head">' +
            '<span class="bodyinfo__name">' + escapeHtml(body.name) + '</span>' +
            '<span class="bodyinfo__type">' + escapeHtml(typeLabel) + '</span>' +
            badgeHtml + extraHtml +
          '</div>' +
          potsHtml +
          chipsHtml +
          distHtml +
          costBlockHtml +
        '</div>';

      /* Bottoni di azione coerenti con il livello pianeta. */
      buttons.push('<button class="actionbar__btn actionbar__btn--primary btn--with-icon" data-action="ctx-open-body" data-body="' + escapeHtml(ctx.bodyKey) + '" title="Apri vista pianeta per ' + escapeHtml(body.name) + '">' +
        icnHtml('planet', 'blue') + ' Apri ' + escapeHtml(body.name) +
      '</button>');

      /* Stadio 3: ingresso destination-first dalla mappa → apre il modal
         flotta con questo corpo come destinazione pre-compilata. */
      buttons.push('<button class="actionbar__btn btn--with-icon" data-action="ctx-send-fleet" data-sys="' + sysId + '" data-body="' + escapeHtml(ctx.bodyKey) + '" title="Apri il compositore flotta per mandare una flotta qui">' +
        icnHtml('send', 'cyan') + ' Manda flotta qui</button>');

      if (isFree && habitable && planet && planet.colCost) {
        const home = g.colonies[g.homePlanetKey];
        const homeColonized = !!(home && home.colonized);
        const homeInTrouble = !!(home && home._scar &&
          (home._scar.food.state === 'crit' || home._scar.water.state === 'crit'));
        const costMul = (homeColonized && !body.homeWorld && !homeInTrouble) ? 5 : 1;
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
        buttons.push('<button class="actionbar__btn btn--with-icon" data-action="ctx-colonize-body" data-body="' + escapeHtml(ctx.bodyKey) + '"' +
          (canPay ? '' : ' disabled') + ' title="' + escapeHtml(tooltip) + '">' +
          icnHtml('build', 'cyan') + ' Colonizza</button>');
      }

      if (isForeign) {
        buttons.push('<button class="actionbar__btn btn--with-icon" data-action="ctx-civ-dossier" data-civ="' + escapeHtml(civ.id) + '">' +
          icnHtml('civ', 'pink') + ' Dossier civiltà</button>');
      }
    }
  }

  if (ctx && ctx.level === 'planet' && ORION.currentPlanet) {
    const sysId = ctx.systemId;
    const planet = ORION.currentPlanet;
    const colKey = sysId + ':' + planet.bodyKey;
    const colony = g.colonies[colKey];
    /* Decisione intra-sistema: preferisci `civForPlanet` (planet-level) a
       `civForSystem` (system-level) — è più preciso quando un sistema è
       condiviso da civ diverse (#52 §13.6). Fallback per save legacy. */
    const civ = (ORION.ai && ORION.ai.civForPlanet)
      ? ORION.ai.civForPlanet(g, sysId, planet.bodyKey)
      : ((ORION.ai && ORION.ai.civForSystem) ? ORION.ai.civForSystem(g, sysId) : null);
    const isMine = !!(colony && colony.colonized);
    const isForeign = !!(civ && !isMine);
    const isFree = !isMine && !isForeign;
    const def = ORION.system && ORION.system.BODY_TYPES ? ORION.system.BODY_TYPES[planet.type] : null;
    const habitable = !!(def && def.habitable);

    /* Stadio 3: ingresso destination-first dalla mappa/pianeta → apre il
       compositore flotta con questo corpo come destinazione. */
    buttons.push('<button class="actionbar__btn btn--with-icon" data-action="ctx-send-fleet" data-sys="' + sysId + '" data-body="' + escapeHtml(planet.bodyKey) + '" title="Apri il compositore flotta per mandare una flotta qui">' +
      icnHtml('send', 'cyan') + ' Manda flotta qui</button>');

    if (isFree && habitable && !colony.colonizing && !colony.colonized) {
      /* Feedback utente 2026-06-15: anche al livello pianeta (vista pianeta
         aperta) mostriamo il dettaglio costo nella action bar in basso. */
      infoCardHtml =
        '<div class="bodyinfo">' +
          '<div class="bodyinfo__cost">' +
            renderColonizeCostBlock(planet, { compact: true }) +
          '</div>' +
        '</div>';
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
         flotta armata che può raggiungere il sistema.
         Decisione intra-sistema: passa anche `data-body` per ingaggiare il
         pianeta SPECIFICO (sistema condiviso). openAttackPicker userà il
         bodyKey nell'ordine setOrder. */
      const strikers = attackCapableFleets(g, sysId);
      if (strikers.length) {
        buttons.push('<button class="actionbar__btn actionbar__btn--danger btn--with-icon" data-action="ctx-attack" data-sys="' + sysId + '" data-body="' + escapeHtml(planet.bodyKey) + '" data-civ="' + escapeHtml(civ.id) + '" title="Ordina a una flotta armata di attaccare questo pianeta">' +
          icnHtml('sword', 'pink') + ' Attacca ' + escapeHtml(planet.name) + '</button>');
      } else {
        buttons.push('<button class="actionbar__btn btn--with-icon" disabled title="Serve una flotta armata che possa raggiungere il sistema">' +
          icnHtml('sword', 'soft') + ' Attacca</button>');
      }
      buttons.push('<button class="actionbar__btn btn--with-icon" disabled title="Richiede M19 Spionaggio">' +
        icnHtml('spy', 'violet') + ' Pianifica spionaggio (M19)</button>');
    }

    /* Decisione intra-sistema: bottone "⊕ Schiera in difesa" per qualunque
       pianeta (mio/neutrale/AI) se ho almeno una flotta nel suo sistema.
       Pone la flotta in `garrison` orbita di osservazione. Una minaccia
       in arrivo emette `garrison-threat-detected` con auto-pausa (#31). */
    const garrFleets = garrisonCandidateFleets(g, sysId);
    if (garrFleets.length) {
      buttons.push('<button class="actionbar__btn btn--with-icon" data-action="ctx-garrison" data-sys="' + sysId + '" data-body="' + escapeHtml(planet.bodyKey) + '" title="Schiera una tua flotta in osservazione di questo pianeta. Una minaccia in arrivo metterà in pausa il tempo e ti chiederà cosa fare.">' +
        icnHtml('shield', 'cyan') + ' Schiera in difesa</button>');
    }
  }

  /* PR-N: l'action bar a livello sistema appare anche con la sola info
     card (senza bottoni). Mostriamola se c'è uno qualsiasi dei due. */
  if (!buttons.length && !infoCardHtml) { host.hidden = true; host.innerHTML = ''; return; }
  host.innerHTML =
    (infoCardHtml || '') +
    (buttons.length ? '<div class="actionbar__buttons">' + buttons.join('') + '</div>' : '');
  host.hidden = false;
  /* Handlers */
  const cBtn = host.querySelector('[data-action="ctx-colonize"]');
  if (cBtn) cBtn.addEventListener('click', function () {
    if (ORION.currentPlanet) tryColonize(ORION.currentPlanet);
  });
  const dBtn = host.querySelector('[data-action="ctx-civ-dossier"]');
  if (dBtn) dBtn.addEventListener('click', function () {
    ORION.pendingCivFocus = dBtn.dataset.civ || null;
    navigateView('civ');
  });
  const dipBtn = host.querySelector('[data-action="ctx-diplomacy"]');
  if (dipBtn) dipBtn.addEventListener('click', function () {
    ORION.pendingCivFocus = dipBtn.dataset.civ || null;
    navigateView('civ');
  });
  const aBtn = host.querySelector('[data-action="ctx-attack"]');
  if (aBtn) aBtn.addEventListener('click', function () {
    /* Decisione intra-sistema: passa anche bodyKey per ingaggio mirato. */
    openAttackPicker(parseInt(aBtn.dataset.sys, 10), aBtn.dataset.civ, aBtn.dataset.body || null);
  });
  const gBtn = host.querySelector('[data-action="ctx-garrison"]');
  if (gBtn) gBtn.addEventListener('click', function () {
    openGarrisonPicker(parseInt(gBtn.dataset.sys, 10), gBtn.dataset.body || null);
  });
  /* Stadio 3: "Manda flotta qui" → compositore con destinazione pre-compilata. */
  host.querySelectorAll('[data-action="ctx-send-fleet"]').forEach(function (sf) {
    sf.addEventListener('click', function () {
      const sysId = parseInt(sf.dataset.sys, 10);
      if (isNaN(sysId)) return;
      openFleetDetail(null, { dest: { sysId: sysId, bodyKey: sf.dataset.body || null } });
    });
  });
  /* PR-N: nuovi handler per livello SISTEMA con corpo selezionato. */
  const oBtn = host.querySelector('[data-action="ctx-open-body"]');
  if (oBtn) oBtn.addEventListener('click', function () {
    const sys = ORION.currentSystem;
    if (sys) openPlanet(sys.id, oBtn.dataset.body);
  });
  const cbBtn = host.querySelector('[data-action="ctx-colonize-body"]');
  if (cbBtn) cbBtn.addEventListener('click', function () {
    const sys = ORION.currentSystem;
    if (!sys) return;
    const key = sys.id + ':' + cbBtn.dataset.body;
    let p = ORION._planetMemo && ORION._planetMemo[key];
    if (!p && ORION.planet && ORION.planet.generate) {
      try { p = ORION.planet.generate(ORION.game.galaxy, sys, cbBtn.dataset.body); } catch (_) {}
    }
    if (p) tryColonize(p);
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

/* Decisione intra-sistema: flotte che possono essere messe in `garrison`
   su un pianeta del sistema target. A differenza di `attack`, non serve
   essere armati (anche una flotta di scout può osservare). Devono però
   poter raggiungere il sistema (BFS). */
function garrisonCandidateFleets(g, sysId) {
  const out = [];
  const F = ORION.fleet;
  if (!F) return out;
  (g.fleets || []).forEach(function (f) {
    if (!f || !f.location || f.location.status === 'in-transit') return;
    if (!(f.ships && f.ships.length)) return;
    if (f.location.systemId === sysId) { out.push(f); return; }
    if (F.computePath(g.galaxy, f.location.systemId, sysId)) out.push(f);
  });
  return out;
}

/* Overlay di scelta flotta per la garrison di un pianeta. Lista delle
   flotte candidate (vedi sopra), con metadata (composizione + hop). */
function openGarrisonPicker(sysId, bodyKey) {
  const g = ORION.game;
  const sys = g.galaxy.systems[sysId];
  const fleets = garrisonCandidateFleets(g, sysId);
  if (!fleets.length) { showToast('Nessuna flotta disponibile può raggiungere il sistema'); return; }
  let planetName = null;
  if (bodyKey && ORION.system && ORION.system.generate) {
    try {
      const ss = ORION.system.generate(g.galaxy, sysId);
      const body = ss && ORION.system.findBody(ss, bodyKey);
      planetName = body ? body.name : null;
    } catch (_) {}
  }
  const F = ORION.fleet;
  const rows = fleets.map(function (f) {
    const path = F.computePath(g.galaxy, f.location.systemId, sysId);
    const hops = path ? path.length - 1 : 0;
    const fp = (f.ships || []).reduce(function (a, s) { const c = F.getClass(s.kind); return a + (c ? c.fp || 0 : 0); }, 0);
    const intra = (f.location.systemId === sysId) ? ' · <em>già nel sistema</em>' : '';
    return '<button class="attack-pick__row" data-fleet="' + escapeHtml(f.id) + '" type="button">' +
      '<span class="attack-pick__name">' + escapeHtml(f.name) + '</span>' +
      '<span class="attack-pick__meta">' + (f.ships || []).length + ' navi · fp ' + fp + ' · ' + hops + ' salti' + intra + '</span>' +
    '</button>';
  }).join('');
  const tgtTxt = planetName ? (planetName + ' (' + (sys ? sys.name : '—') + ')') : (sys ? sys.name : '—');
  const html =
    '<div class="attack-overlay" data-garrison-overlay>' +
      '<div class="attack-overlay__panel">' +
        '<header class="attack-overlay__head"><h3>' +
          '<span class="ui-icon ui-icon--cyan" aria-hidden="true">' + ((ORION.icon && ORION.icon('shield')) || '⊕') + '</span> ' +
          'Schiera in difesa di ' + escapeHtml(tgtTxt) +
        '</h3>' +
          '<button class="attack-overlay__x" data-garr-close type="button" aria-label="Chiudi">' +
            '<span class="ui-icon" aria-hidden="true">' + ((ORION.icon && ORION.icon('close')) || '✕') + '</span>' +
          '</button></header>' +
        '<p class="attack-overlay__sub">La flotta orbiterà vicino al pianeta in osservazione. ' +
          '<strong>Non ingaggia automaticamente</strong>: una minaccia in arrivo metterà il tempo in pausa e ti chiederà cosa fare ' +
          '(Ingaggia / Ritira / Resta).</p>' +
        '<div class="attack-pick__list">' + rows + '</div>' +
        '<p class="attack-overlay__hint">Recovery-friendly: niente combattimento senza consenso esplicito.</p>' +
      '</div>' +
    '</div>';
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  const node = wrap.firstChild;
  document.body.appendChild(node);
  function close() { if (node.parentNode) node.parentNode.removeChild(node); }
  node.querySelector('[data-garr-close]').addEventListener('click', close);
  node.addEventListener('click', function (e) { if (e.target === node) close(); });
  node.querySelectorAll('[data-fleet]').forEach(function (b) {
    b.addEventListener('click', function () {
      const fleet = (g.fleets || []).filter(function (f) { return f.id === b.dataset.fleet; })[0];
      if (!fleet) { close(); return; }
      const r = ORION.fleet.setOrder(g, fleet, { type: 'garrison', toSysId: sysId, bodyKey: bodyKey });
      if (!r.ok) { showToast(r.reason || 'Ordine rifiutato'); return; }
      pushChronicle(ORION.time.currentDS(g) + ' — Schieramento difensivo: <strong>' + escapeHtml(fleet.name) +
        '</strong> in osservazione di <strong>' + escapeHtml(tgtTxt) + '</strong>' +
        (sysId >= 0 ? systemTagHtml(sysId) : '') + '.', 'system');
      persistGame(g);
      close();
      if (ORION.map && ORION.map.requestRender) ORION.map.requestRender();
      showToast(fleet.name + ' schierata in difesa');
    });
  });
}

/* =====================================================================
   FLEET INFO POPUP (polish post-wizard) — click su marker → popup info.

   L'utente ha chiesto: "se ci clicco mi deve dare le info precise del
   viaggio in corso". Il click sul marker mostra ora un popup ancorato
   al punto di click con: nome flotta, navi (count + glifi classi),
   equipaggio (count + xp medio), ordine corrente in italiano, ETA se
   in transito, e bottoni di azione (Wizard / Imposta rotta dal canvas /
   Chiudi). Il popup chiude su click esterno o Esc.
   ===================================================================== */
function openFleetInfoPopup(fleetId, screenX, screenY) {
  const g = ORION.game;
  if (!g) return;
  const fleet = (g.fleets || []).filter(function (f) { return f.id === fleetId; })[0];
  if (!fleet) return;

  closeFleetInfoPopup();
  /* Evidenza visiva sulla mappa: rotta + etichetta + anello giallo della
     flotta selezionata (anche se non siamo in picker mode). */
  if (ORION.map && ORION.map.setHighlightedFleet) {
    ORION.map.setHighlightedFleet(fleetId);
  }
  const node = document.createElement('div');
  node.className = 'fleet-info-popup';
  node.id = 'fleet-info-popup';
  node.setAttribute('role', 'dialog');
  node.setAttribute('aria-label', 'Informazioni flotta ' + fleet.name);

  /* Composizione navi */
  const F = ORION.fleet;
  const byKind = {};
  (fleet.ships || []).forEach(function (s) { byKind[s.kind] = (byKind[s.kind] || 0) + 1; });
  const shipsHtml = Object.keys(byKind).map(function (k) {
    const c = F && F.getClass ? F.getClass(k) : null;
    const glyph = c ? c.glyph : '?';
    return '<span title="' + escapeHtml(c ? c.name : k) + '">' + glyph + '×' + byKind[k] + '</span>';
  }).join(' ');
  /* Equipaggio + xp medio */
  const crewN = (fleet.crew || []).length;
  const xpAvg = crewN ? ((fleet.crew.reduce(function (a, c) { return a + (c.xp || 0); }, 0)) / crewN) : 0;
  /* Ordine corrente in italiano + dettagli */
  const orderInfo = describeFleetOrder(g, fleet);
  /* Posizione corrente */
  const posSys = g.galaxy.systems[fleet.location.systemId];
  const posStatus = fleet.location.status === 'in-transit' ? 'in viaggio'
                  : ORION.fleet.berthLabel(ORION.fleet.berthOf(g, fleet));

  node.innerHTML =
    '<header class="fleet-info-popup__head">' +
      '<h3 class="fleet-info-popup__name">' + escapeHtml(fleet.name) + '</h3>' +
      '<button class="btn btn--mini btn--icon-only" data-action="fleet-info-close" type="button" aria-label="Chiudi">' +
        '<span class="ui-icon" aria-hidden="true">' + ((ORION.icon && ORION.icon('close')) || '✕') + '</span>' +
      '</button>' +
    '</header>' +
    '<dl class="fleet-info-popup__meta">' +
      '<div><dt>Posizione</dt><dd>' + escapeHtml(posSys ? posSys.name : '—') + ' · ' + posStatus + '</dd></div>' +
      '<div><dt>Navi</dt><dd>' + (shipsHtml || '<em>nessuna</em>') + '</dd></div>' +
      '<div><dt>Equipaggio</dt><dd>' + crewN + (crewN ? ' (xp medio ' + xpAvg.toFixed(1) + ')' : '') + '</dd></div>' +
      '<div><dt>Ordine</dt><dd>' + orderInfo.label + '</dd></div>' +
      (orderInfo.targetSummary ? '<div><dt>Rotta</dt><dd>' + orderInfo.targetSummary + '</dd></div>' : '') +
      (orderInfo.eta != null ? '<div><dt>Arrivo in</dt><dd>' + orderInfo.eta + ' Ι</dd></div>' : '') +
    '</dl>' +
    '<div class="fleet-info-popup__actions">' +
      '<button class="btn btn--mini btn--primary btn--with-icon" data-action="fleet-info-detail" type="button">' + uiIcon('settings', 'cyan') + ' Dettaglio</button>' +
      '<button class="btn btn--mini btn--with-icon" data-action="fleet-info-wizard" type="button">' + uiIcon('fleet', 'cyan') + ' Ordini</button>' +
      '<button class="btn btn--mini btn--with-icon" data-action="fleet-info-pick" type="button">' + uiIcon('pin', 'cyan') + ' Rotta da mappa</button>' +
      ((ORION.aifleet && ORION.aifleet.detectedFleets(g).length)
        ? '<button class="btn btn--mini btn--with-icon" data-action="fleet-info-follow" type="button">' + uiIcon('spy', 'pink') + ' Segui contatto</button>'
        : '') +
    '</div>';

  document.body.appendChild(node);
  /* Posizionamento: prova a destra del punto, ma se sfora vai a sinistra. */
  const margin = 12;
  const rectW = 260;       /* stima */
  const rectH = 220;       /* stima */
  let x = screenX + 16;
  let y = screenY - 16;
  if (x + rectW > window.innerWidth - margin) x = screenX - rectW - 16;
  if (x < margin) x = margin;
  if (y + rectH > window.innerHeight - margin) y = window.innerHeight - rectH - margin;
  if (y < margin) y = margin;
  node.style.left = x + 'px';
  node.style.top = y + 'px';

  /* Handlers */
  node.querySelector('[data-action="fleet-info-close"]').addEventListener('click', closeFleetInfoPopup);
  node.querySelector('[data-action="fleet-info-detail"]').addEventListener('click', function () {
    closeFleetInfoPopup();
    openFleetDetail(fleetId);
  });
  node.querySelector('[data-action="fleet-info-wizard"]').addEventListener('click', function () {
    closeFleetInfoPopup();
    openFleetReorder(fleetId);   // Stadio 3.2: riordino col nuovo modello
  });
  node.querySelector('[data-action="fleet-info-pick"]').addEventListener('click', function () {
    closeFleetInfoPopup();
    enterFleetPicker(fleetId);
  });
  const followBtn = node.querySelector('[data-action="fleet-info-follow"]');
  if (followBtn) followBtn.addEventListener('click', function () {
    closeFleetInfoPopup();
    openFollowContactChooser(fleetId);
  });
  /* Chiudi su click esterno (al successivo evento, per non chiudere subito). */
  setTimeout(function () {
    document.addEventListener('click', _maybeCloseFleetInfoPopup, true);
    document.addEventListener('keydown', _fleetInfoEscHandler);
  }, 0);
}

/* ===================================================================
   M18.x — INSEGUIMENTO FLOTTE AI (richiesta utente 2026-06-18).
   Popup contestuale sul marker di una flotta AI rilevata (click su mappa)
   + chooser "Segui contatto" dai comandi di una tua flotta. Tre ordini:
   Segui · Intercetta · Scorta. Riusa la classe .fleet-info-popup (nessun
   CSS nuovo) e i bottoni .btn--mini (UI_GUIDE §6).
   =================================================================== */
function closeAiFleetPopup() {
  const n = document.getElementById('ai-fleet-popup');
  if (n && n.parentNode) n.parentNode.removeChild(n);
  document.removeEventListener('click', _maybeCloseAiFleetPopup, true);
  document.removeEventListener('keydown', _aiFleetEscHandler);
}
function _maybeCloseAiFleetPopup(e) {
  const n = document.getElementById('ai-fleet-popup');
  if (n && !n.contains(e.target)) closeAiFleetPopup();
}
function _aiFleetEscHandler(e) { if (e.key === 'Escape') closeAiFleetPopup(); }

/* Applica un ordine di inseguimento (mode ∈ shadow/intercept/escort). */
function assignFollowOrder(fleetId, aiFleetId, mode) {
  const g = ORION.game;
  if (!g || !ORION.aifleet) return;
  const r = ORION.aifleet.setFollow(g, fleetId, aiFleetId, mode);
  if (!r.ok) { showToast(r.reason || 'Ordine non possibile'); return; }
  const fleet = (g.fleets || []).filter(function (f) { return f.id === fleetId; })[0];
  showToast((fleet ? fleet.name : 'Flotta') + ': ' + r.modeLabel + ' contatto');
  closeAiFleetPopup();
  if (ORION.map && ORION.map.requestRender) ORION.map.requestRender();
}

/* Righe-azione (Segui/Intercetta/Scorta) per un contatto, legate a un
   selettore di flotta `getFleetId`. */
function aiFollowActionsHtml() {
  return '<div class="fleet-info-popup__actions fleet-info-popup__actions--row">' +
    '<button class="btn btn--mini btn--primary" data-ai-mode="shadow" type="button" title="Pedina a distanza, raccogli intel">' + uiIcon('spy', 'violet') + ' Segui</button>' +
    '<button class="btn btn--mini" data-ai-mode="intercept" type="button" title="Raggiungi e ingaggia se ostile">' + uiIcon('sword', 'pink') + ' Intercetta</button>' +
    '<button class="btn btn--mini" data-ai-mode="escort" type="button" title="Accompagna una flotta non ostile">' + uiIcon('fleet', 'cyan') + ' Scorta</button>' +
  '</div>';
}

function openAiFleetPopup(aiFleetId, screenX, screenY) {
  const g = ORION.game;
  if (!g || !ORION.aifleet) return;
  const af = ORION.aifleet.byId(g, aiFleetId);
  if (!af) { showToast('Contatto non più disponibile'); return; }
  closeFleetInfoPopup();
  closeAiFleetPopup();

  const comp = ORION.aifleet.composition(af);
  const label = ORION.aifleet.label(g, af);
  const posSys = g.galaxy.systems[af.systemId];
  const intelPct = Math.round((af.intel || 0) * 100);
  const fleets = (g.fleets || []).filter(function (f) { return f && f.ships && f.ships.length; });

  const node = document.createElement('div');
  node.className = 'fleet-info-popup';
  node.id = 'ai-fleet-popup';
  node.setAttribute('role', 'dialog');
  node.setAttribute('aria-label', 'Contatto ' + label);

  let body =
    '<header class="fleet-info-popup__head">' +
      '<h3 class="fleet-info-popup__name">' + uiIcon('fleet', 'pink') + ' ' + escapeHtml(label) + '</h3>' +
      '<button class="btn btn--mini btn--icon-only" data-action="ai-close" type="button" aria-label="Chiudi">' +
        '<span class="ui-icon" aria-hidden="true">' + ((ORION.icon && ORION.icon('close')) || '✕') + '</span>' +
      '</button>' +
    '</header>' +
    '<dl class="fleet-info-popup__meta">' +
      '<div><dt>Posizione</dt><dd>' + escapeHtml(posSys ? posSys.name : '—') + (af.status === 'in-transit' ? ' · in viaggio' : ' · in orbita') + '</dd></div>' +
      '<div><dt>Composizione</dt><dd>' + escapeHtml(comp.text) + '</dd></div>' +
      '<div><dt>Intel</dt><dd>' + intelPct + '%</dd></div>' +
    '</dl>';

  if (!fleets.length) {
    body += '<p class="fleet-info-popup__hint">Nessuna tua flotta disponibile per inseguire questo contatto.</p>';
  } else {
    const opts = fleets.map(function (f) {
      const s = g.galaxy.systems[f.location.systemId];
      return '<option value="' + escapeHtml(f.id) + '">' + escapeHtml(f.name) + (s ? ' — ' + escapeHtml(s.name) : '') + '</option>';
    }).join('');
    body +=
      '<label class="fleet-info-popup__row"><span>Con la flotta</span>' +
        '<select data-ai-fleet-select class="main-menu__select">' + opts + '</select>' +
      '</label>' +
      aiFollowActionsHtml();
  }
  node.innerHTML = body;
  document.body.appendChild(node);

  /* Posizionamento (come openFleetInfoPopup). */
  const margin = 12, rectW = 270, rectH = 230;
  let x = (screenX || 0) + 16, y = (screenY || 0) - 16;
  if (x + rectW > window.innerWidth - margin) x = (screenX || 0) - rectW - 16;
  if (x < margin) x = margin;
  if (y + rectH > window.innerHeight - margin) y = window.innerHeight - rectH - margin;
  if (y < margin) y = margin;
  node.style.left = x + 'px';
  node.style.top = y + 'px';

  node.querySelector('[data-action="ai-close"]').addEventListener('click', closeAiFleetPopup);
  if (fleets.length) {
    const sel = node.querySelector('[data-ai-fleet-select]');
    node.querySelectorAll('[data-ai-mode]').forEach(function (b) {
      b.addEventListener('click', function () {
        assignFollowOrder(sel.value, aiFleetId, b.getAttribute('data-ai-mode'));
      });
    });
  }
  setTimeout(function () {
    document.addEventListener('click', _maybeCloseAiFleetPopup, true);
    document.addEventListener('keydown', _aiFleetEscHandler);
  }, 0);
  if (ORION.tutorial && ORION.tutorial.fire) ORION.tutorial.fire('ai-fleet-follow');
}

/* Chooser dei contatti rilevati, legato a una TUA flotta (entry "dai
   comandi flotta"): elenca le flotte AI note, ognuna con Segui/Intercetta/
   Scorta. Riusa .fleet-info-popup, centrato. */
function openFollowContactChooser(fleetId) {
  const g = ORION.game;
  if (!g || !ORION.aifleet) return;
  closeAiFleetPopup();
  const contacts = ORION.aifleet.detectedFleets(g);
  if (!contacts.length) { showToast('Nessun contatto rilevato'); return; }
  const fleet = (g.fleets || []).filter(function (f) { return f.id === fleetId; })[0];
  if (!fleet) { showToast('Flotta non trovata'); return; }

  const node = document.createElement('div');
  node.className = 'fleet-info-popup';
  node.id = 'ai-fleet-popup';
  node.setAttribute('role', 'dialog');
  node.setAttribute('aria-label', 'Contatti rilevati');

  const rows = contacts.map(function (af) {
    const comp = ORION.aifleet.composition(af);
    const s = g.galaxy.systems[af.systemId];
    return '<div class="fleet-info-popup__contact" data-ai-id="' + escapeHtml(af.id) + '">' +
      '<div class="fleet-info-popup__contact-head">' + escapeHtml(ORION.aifleet.label(g, af)) +
        ' <span class="fleet-info-popup__contact-sub">' + escapeHtml(comp.text) + (s ? ' · ' + escapeHtml(s.name) : '') + '</span></div>' +
      '<div class="fleet-info-popup__actions">' +
        '<button class="btn btn--mini btn--primary" data-ai-mode="shadow" type="button">Segui</button>' +
        '<button class="btn btn--mini" data-ai-mode="intercept" type="button">Intercetta</button>' +
        '<button class="btn btn--mini" data-ai-mode="escort" type="button">Scorta</button>' +
      '</div></div>';
  }).join('');

  node.innerHTML =
    '<header class="fleet-info-popup__head">' +
      '<h3 class="fleet-info-popup__name">' + uiIcon('spy', 'pink') + ' ' + escapeHtml(fleet.name) + ' · contatti</h3>' +
      '<button class="btn btn--mini btn--icon-only" data-action="ai-close" type="button" aria-label="Chiudi">' +
        '<span class="ui-icon" aria-hidden="true">' + ((ORION.icon && ORION.icon('close')) || '✕') + '</span>' +
      '</button>' +
    '</header>' + rows;

  document.body.appendChild(node);
  node.style.left = Math.max(12, (window.innerWidth - 280) / 2) + 'px';
  node.style.top = Math.max(12, (window.innerHeight - 320) / 2) + 'px';

  node.querySelector('[data-action="ai-close"]').addEventListener('click', closeAiFleetPopup);
  node.querySelectorAll('.fleet-info-popup__contact').forEach(function (row) {
    const aiId = row.getAttribute('data-ai-id');
    row.querySelectorAll('[data-ai-mode]').forEach(function (b) {
      b.addEventListener('click', function () { assignFollowOrder(fleetId, aiId, b.getAttribute('data-ai-mode')); });
    });
  });
  setTimeout(function () {
    document.addEventListener('click', _maybeCloseAiFleetPopup, true);
    document.addEventListener('keydown', _aiFleetEscHandler);
  }, 0);
}

/* Stadio 3.2 — Riordino di una flotta ESISTENTE col nuovo modello
   (Destinazione + Missione via fleetTarget/actionsFor). Modal additivo:
   non tocca l'editor "Dettaglio" (renderExisting). Niente composizione: la
   flotta ha già navi/equipaggio; si sceglie solo dove e cosa fare. */
function openFleetReorder(fleetId) {
  const g = ORION.game;
  if (!g) return;
  const fleet = (g.fleets || []).filter(function (f) { return f.id === fleetId; })[0];
  if (!fleet) { showToast('Flotta non trovata'); return; }
  const F = ORION.fleet;
  const DISC = (ORION.galaxy && ORION.galaxy.DISCOVERY) || { DETECTED: 1, EXPLORED: 2 };
  const disc = (g.state && g.state.discovery) || {};
  const fromSys = fleet.location.systemId;
  function sysName2(id) { const s = g.galaxy.systems[id]; return s ? s.name : ('Sistema ' + id); }
  function hops(s) { if (s === fromSys) return 0; const p = F.computePath ? F.computePath(g.galaxy, fromSys, s) : null; return p ? p.length - 1 : null; }
  function knownCivs(sysId) {
    const out = [];
    (g.civs || []).forEach(function (c) {
      if (!c || !c.alive || !Array.isArray(c.systems)) return;
      if (c.systems.indexOf(sysId) < 0) return;
      if ((ORION.ai && ORION.ai.knowledgeRank ? ORION.ai.knowledgeRank(c) : 2) >= 1) out.push(c);
    });
    if (!out.length && ORION.ai && ORION.ai.civForSystem) {
      const c = ORION.ai.civForSystem(g, sysId);
      if (c && c.alive && (ORION.ai.knowledgeRank ? ORION.ai.knowledgeRank(c) : 2) >= 1) out.push(c);
    }
    return out;
  }
  function civName(c) { return (ORION.ai && ORION.ai.knowledgeRank ? ORION.ai.knowledgeRank(c) : 2) >= 2 ? c.name : 'Ignota'; }
  function bodyGlyph(type) { const d = ORION.system && ORION.system.BODY_TYPES ? ORION.system.BODY_TYPES[type] : null; const cat = d ? d.cat : ''; return cat === 'gas' ? '⬡' : cat === 'belt' ? '≈' : cat === 'moon' ? '◌' : '◉'; }
  function bodyTypeLabel(type) { const d = ORION.system && ORION.system.BODY_TYPES ? ORION.system.BODY_TYPES[type] : null; return d ? d.label : type; }
  const MISSION_META = {
    move: { ic: 'send', tone: 'cyan', lab: 'Sposta', arr: 'Solo spostamento' },
    attack: { ic: 'sword', tone: 'pink', lab: 'Attacca', arr: 'Attacca' },
    extract: { ic: 'resources', tone: 'amber', lab: 'Estrai', arr: 'Estrai' },
    recon: { ic: 'spy', tone: 'violet', lab: 'Ricognizione', arr: 'Ricognizione' },
    colonize: { ic: 'home', tone: 'amber', lab: 'Colonizza', arr: 'Colonizza' }
  };
  const GATE_LABEL = { coloniale: 'nave coloniale', estrattore: 'estrattore', fuoco: 'potenza di fuoco' };
  const knownSys = [];
  for (let i = 0; i < g.galaxy.systems.length; i++) if ((disc[i] || 0) >= DISC.DETECTED) knownSys.push(i);
  const hopsMap = {}; knownSys.forEach(function (s) { hopsMap[s] = hops(s); });
  knownSys.sort(function (a, b) { const ha = hopsMap[a] == null ? 1e9 : hopsMap[a], hb = hopsMap[b] == null ? 1e9 : hopsMap[b]; return ha - hb; });
  const R = { dest: { sysId: null, bodyKey: null }, mission: null };
  const cur = fleet.orders && fleet.orders.toSysId;
  if (cur != null && (disc[cur] || 0) >= DISC.DETECTED) { R.dest.sysId = cur; R.dest.bodyKey = fleet.orders.bodyKey || null; }
  else { const nh = knownSys.filter(function (s) { return s !== fromSys; }); R.dest.sysId = nh.length ? nh[0] : (knownSys[0] != null ? knownSys[0] : fromSys); }

  const host = ensureFleetOverlayHost('fleet-detail');
  host.hidden = false;
  host.onclick = function (e) { if (e.target === host) closeFleetOverlay(); };

  function buildOrder() {
    const sys = R.dest.sysId, bk = R.dest.bodyKey || null, m = R.mission || 'move';
    if (m === 'attack') return { type: 'attack', toSysId: sys, bodyKey: bk };
    if (m === 'recon') return { type: 'recon', toSysId: sys, bodyKey: bk };
    if (m === 'extract') {
      let kind = null;
      if (bk && ORION.system && ORION.anomaly && ORION.anomaly.bodyGiacimento) {
        try { const ds = ORION.system.generate(g.galaxy, sys); const b = ORION.system.findBody(ds, bk); const gi = b && ORION.anomaly.bodyGiacimento(b); if (gi) kind = gi.kind; } catch (e) { /* */ }
      }
      if (!kind && ORION.fleetTarget) kind = ORION.fleetTarget.describe(g, sys, bk).anomalyKind;
      if (!kind) return null;
      return { type: 'survey', toSysId: sys, anomalyKind: kind, bodyKey: bk };
    }
    return { type: 'move', toSysId: sys, bodyKey: bk };
  }
  function render() {
    const sysOpts = knownSys.map(function (s) {
      const nm = sysName2(s); const h = hopsMap[s]; const hop = h === 0 ? 'qui' : (h != null ? h + ' salti' : 'irr.');
      const cn = knownCivs(s).length;
      return '<option value="' + s + '"' + (s === R.dest.sysId ? ' selected' : '') + '>' + escapeHtml(nm) + ' · ' + hop + (cn ? ' · ' + cn + ' AI' : '') + '</option>';
    }).join('');
    let bodyHtml = '';
    const explored = (disc[R.dest.sysId] || 0) >= DISC.EXPLORED;
    if (explored && ORION.system && ORION.system.generate) {
      let bodies = []; try { const ds = ORION.system.generate(g.galaxy, R.dest.sysId); bodies = (ds && ds.bodies) || []; } catch (e) { bodies = []; }
      if (bodies.length) {
        let bopts = '<option value="">— orbita generica —</option>';
        bodies.forEach(function (b) {
          if (!b || !b.key) return;
          bopts += '<option value="' + escapeHtml(b.key) + '"' + (String(R.dest.bodyKey || '') === String(b.key) ? ' selected' : '') + '>' + bodyGlyph(b.type) + ' ' + escapeHtml(b.name || b.key) + ' · ' + escapeHtml(bodyTypeLabel(b.type)) + '</option>';
          (b.moons || []).forEach(function (m) { if (m && m.key) bopts += '<option value="' + escapeHtml(m.key) + '"' + (String(R.dest.bodyKey || '') === String(m.key) ? ' selected' : '') + '>  ' + bodyGlyph(m.type) + ' ' + escapeHtml(m.name || m.key) + ' · ' + escapeHtml(bodyTypeLabel(m.type)) + '</option>'; });
        });
        bodyHtml = '<select class="fdetail__select" data-bind="ro-body" aria-label="Corpo di destinazione">' + bopts + '</select>';
      }
    } else if (!explored) {
      bodyHtml = '<span class="fdest__hint">' + uiIcon('info', 'soft') + ' Sistema non esplorato: corpo non selezionabile.</span>';
    }
    const dc = knownCivs(R.dest.sysId);
    let aiLine = dc.length ? '<div class="fdest__ai">' + uiIcon('civ', 'pink') + ' AI nel sistema: <strong>' + dc.length + '</strong> · ' + dc.map(function (c) { return '<span class="fdest__civ">' + escapeHtml(civName(c)) + '</span>'; }).join(' ') + '</div>' : '<div class="fdest__ai fdest__ai--none">Nessuna AI nota nel sistema</div>';
    if (R.dest.bodyKey && ORION.ai && ORION.ai.civForPlanet) { const bc = ORION.ai.civForPlanet(g, R.dest.sysId, R.dest.bodyKey); if (bc) aiLine += '<div class="fdest__ai">' + uiIcon('civ', 'pink') + ' Sul corpo: <span class="fdest__civ">' + escapeHtml(civName(bc)) + '</span></div>'; }
    const target = ORION.fleetTarget ? ORION.fleetTarget.describe(g, R.dest.sysId, R.dest.bodyKey) : null;
    const rawActs = (F.actionsFor && target) ? F.actionsFor(target, fleet) : [];
    const opts = [{ id: 'move', available: true, gate: null, future: false }];
    rawActs.forEach(function (a) { if (a.id === 'dock' || a.id === 'defend-ally') return; opts.push(a); });
    const selable = opts.filter(function (a) { return a.available && !a.future && MISSION_META[a.id]; }).map(function (a) { return a.id; });
    if (!R.mission || selable.indexOf(R.mission) < 0) R.mission = selable.indexOf('colonize') >= 0 ? 'colonize' : 'move';
    const chips = opts.map(function (a) {
      const meta = MISSION_META[a.id]; if (!meta) return '';
      const disabled = !a.available || a.future;
      const sel = R.mission === a.id && !disabled;
      const gate = (!a.available && a.gate) ? (GATE_LABEL[a.gate] || a.gate) : '';
      const sfx = gate ? ' <span class="fdetail__chip-note">' + escapeHtml(gate) + '</span>' : '';
      return '<button class="fdetail__chip' + (sel ? ' is-active' : '') + '" type="button" data-ro-mission="' + a.id + '"' + (disabled ? ' disabled' : '') + ' title="' + escapeHtml(gate ? 'Serve: ' + gate : meta.arr) + '">' + uiIcon(meta.ic, meta.tone) + ' ' + meta.arr + sfx + '</button>';
    }).join('');
    let eta = '—';
    if (R.dest.sysId === fromSys) eta = 'intra-sistema';
    else { const p = F.computePath(g.galaxy, fromSys, R.dest.sysId); eta = p ? (F.routeImpulsi(g.galaxy, fleet, p) + ' Ι') : 'irraggiungibile'; }
    const order = buildOrder();
    const isCol = R.mission === 'colonize';
    const ready = isCol ? !!R.dest.bodyKey : !!order;
    host.innerHTML =
      '<div class="fdetail__panel" role="document">' +
        '<header class="fdetail__head"><div class="fdetail__title">' + uiIcon('fleet', 'cyan') +
          '<h2>Riordina ' + escapeHtml(fleet.name) + '</h2></div>' +
          '<button class="fdetail__x btn--icon-only" data-ro-close type="button" aria-label="Chiudi">' + uiIcon('close') + '</button></header>' +
        '<div class="fdetail__body">' +
          '<div class="fdetail__summary"><span class="fsum__chip">' + uiIcon('pin', 'cyan') + ' da ' + escapeHtml(sysName2(fromSys)) + '</span>' +
            '<span class="fsum__chip">' + uiIcon('send', 'cyan') + ' ' + escapeHtml(MISSION_META[R.mission] ? MISSION_META[R.mission].lab : 'Sposta') + '</span>' +
            '<span class="fsum__chip">' + uiIcon('clock', 'amber') + ' ' + escapeHtml(eta) + '</span></div>' +
          '<div class="fdetail__sec fdetail__sec--dest is-editing"><div class="fdetail__sec-h">' + uiIcon('pin', 'cyan') + ' Destinazione</div>' +
            '<div class="fdetail__origin"><select class="fdetail__select" data-bind="ro-system" aria-label="Sistema di destinazione">' + sysOpts + '</select>' + bodyHtml + '</div>' + aiLine + '</div>' +
          '<div class="fdetail__sec fdetail__sec--ord is-editing"><div class="fdetail__sec-h">' + uiIcon('send', 'cyan') + ' Sposta — e all’arrivo</div><div class="fdetail__chips">' + chips + '</div></div>' +
        '</div>' +
        '<div class="fdetail__foot">' +
          '<button class="btn btn--mini" data-ro-close type="button">Annulla</button>' +
          '<button class="btn btn--mini btn--primary btn--with-icon" data-ro-confirm type="button"' + (ready ? '' : ' disabled') + '>' + uiIcon('check', 'cyan') + ' Conferma ordine</button>' +
        '</div>' +
      '</div>';
    bindRO();
  }
  function bindRO() {
    host.querySelectorAll('[data-ro-close]').forEach(function (b) { b.addEventListener('click', closeFleetOverlay); });
    const ss = host.querySelector('[data-bind="ro-system"]');
    if (ss) ss.addEventListener('change', function () { R.dest.sysId = Number(ss.value); R.dest.bodyKey = null; render(); });
    const bs = host.querySelector('[data-bind="ro-body"]');
    if (bs) bs.addEventListener('change', function () { R.dest.bodyKey = bs.value || null; render(); });
    host.querySelectorAll('[data-ro-mission]').forEach(function (b) { if (b.disabled) return; b.addEventListener('click', function () { R.mission = b.dataset.roMission; render(); }); });
    const cf = host.querySelector('[data-ro-confirm]');
    if (cf) cf.addEventListener('click', doConfirmRO);
  }
  function doConfirmRO() {
    if (R.mission === 'colonize') {
      let planet = null;
      try { const ds = ORION.system.generate(g.galaxy, R.dest.sysId); planet = ORION.planet.generate(g.galaxy, ds, R.dest.bodyKey); } catch (e) { planet = null; }
      if (!planet) { showToast('Pianeta non valido'); return; }
      doColonize(planet, fleet, 0);
      if (!fleet.orders || fleet.orders.type !== 'colonize') return; // doColonize ha già mostrato il motivo
    } else {
      const order = buildOrder();
      if (!order) { showToast('Definisci destinazione e missione'); return; }
      const r = F.setOrder(g, fleet, order);
      if (!r.ok) { showToast(r.reason || 'Ordine rifiutato'); return; }
      maybeAutoRenameFleet(g, fleet, order);
    }
    persistGame(g);
    closeFleetOverlay();
    if (ORION.map && ORION.map.requestRender) ORION.map.requestRender();
    showToast(fleet.name + ' · nuovo ordine impartito');
  }
  render();
}

function _maybeCloseFleetInfoPopup(e) {
  const node = document.getElementById('fleet-info-popup');
  if (!node) { document.removeEventListener('click', _maybeCloseFleetInfoPopup, true); return; }
  if (node.contains(e.target)) return;
  closeFleetInfoPopup();
}
function _fleetInfoEscHandler(e) {
  if (e.key === 'Escape') closeFleetInfoPopup();
}
function closeFleetInfoPopup() {
  const node = document.getElementById('fleet-info-popup');
  if (node && node.parentNode) node.parentNode.removeChild(node);
  document.removeEventListener('click', _maybeCloseFleetInfoPopup, true);
  document.removeEventListener('keydown', _fleetInfoEscHandler);
  /* Rimuovi l'evidenza giallo della flotta selezionata. Se sta entrando
     in picker mode (chiamato da `enterFleetPicker` subito dopo), il
     `setFleetPickerMode(fleetId,...)` riattiverà l'highlight da quel
     percorso. */
  if (ORION.map && ORION.map.setHighlightedFleet) {
    ORION.map.setHighlightedFleet(null);
  }
}

/* describeFleetOrder — testo italiano dell'ordine corrente + summary
   destinazioni per il popup info. */
function describeFleetOrder(g, fleet) {
  const o = fleet.orders || {};
  const sysName = function (id) { const s = g.galaxy.systems[id]; return s ? s.name : '—'; };
  const inTransit = fleet.location && fleet.location.status === 'in-transit';
  const eta = inTransit ? (fleet.etaImpulsi | 0) : null;
  if (o.type === 'idle' || !o.type) {
    if (fleet.location && fleet.location.status === 'orbiting') return { label: '⏸ <em>in sosta</em>', eta: eta };
    return { label: '<em>in attesa</em>', eta: eta };
  }
  if (o.type === 'move')    return { label: 'rotta verso ' + escapeHtml(sysName(o.toSysId)),    eta: eta };
  if (o.type === 'explore') return { label: 'esplorazione di ' + escapeHtml(sysName(o.toSysId)), eta: eta };
  if (o.type === 'survey')  return { label: '✦ anomalia di ' + escapeHtml(sysName(o.toSysId)),   eta: eta };
  if (o.type === 'attack')  return { label: 'attacco a ' + escapeHtml(sysName(o.toSysId)),       eta: eta };
  if (o.type === 'return')  return { label: 'rientro alla base',                                 eta: eta };
  if (o.type === 'patrol') {
    return { label: 'pattuglia ' + escapeHtml(sysName(o.sysA)) + ' ↔ ' + escapeHtml(sysName(o.sysB)), eta: eta };
  }
  if (o.type === 'move-route') {
    const wps = o.waypoints || [];
    const cur = (o.wpIdx || 0) + 1;
    const summary = wps.map(function (id, i) {
      const n = escapeHtml(sysName(id));
      return (i + 1 === cur) ? '<strong>' + n + '</strong>' : n;
    }).join(' → ') + (o.returnHome ? ' → 🏠' : '');
    return { label: 'rotta a tappe (' + cur + '/' + wps.length + ')', targetSummary: summary, eta: eta };
  }
  if (o.type === 'patrol-loop') {
    const loop = o.loop || [];
    const cur = (o.loopIdx || 0);
    const summary = loop.map(function (id, i) {
      const n = escapeHtml(sysName(id));
      return (i === cur) ? '<strong>' + n + '</strong>' : n;
    }).join(' ↻ ');
    return { label: 'pattuglia ciclica · ' + loop.length + ' nodi', targetSummary: summary, eta: eta };
  }
  return { label: escapeHtml(o.type), eta: eta };
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

/* Overlay di scelta flotta per un attacco offensivo su un sistema AI.
   Decisione intra-sistema: `bodyKey` opzionale → l'ordine d'attacco
   ingaggia QUEL pianeta specifico (sistemi condivisi #52 §13.6). */
function openAttackPicker(sysId, civId, bodyKey) {
  const g = ORION.game;
  const sys = g.galaxy.systems[sysId];
  const civ = (g.civs || []).filter(function (c) { return c.id === civId; })[0];
  const fleets = attackCapableFleets(g, sysId);
  if (!fleets.length) { showToast('Nessuna flotta armata può raggiungere il sistema'); return; }
  const targetBodyKey = bodyKey ? String(bodyKey) : null;
  let targetPlanetName = null;
  if (targetBodyKey && ORION.system && ORION.system.generate) {
    try {
      const ss = ORION.system.generate(g.galaxy, sysId);
      const body = ss && ORION.system.findBody(ss, targetBodyKey);
      targetPlanetName = body ? body.name : null;
    } catch (_) {}
  }
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
      const r = ORION.fleet.setOrder(g, fleet, { type: 'attack', toSysId: sysId, bodyKey: targetBodyKey });
      if (!r.ok) { showToast(r.reason || 'Ordine rifiutato'); return; }
      const tgtTxt = targetPlanetName ? (targetPlanetName + ' (' + (sys ? sys.name : '—') + ')') : (sys ? sys.name : '—');
      pushChronicle(ORION.time.currentDS(g) + ' — Ordine d\'attacco: <strong>' + escapeHtml(fleet.name) +
        '</strong> in rotta verso <strong>' + escapeHtml(tgtTxt) + '</strong>' +
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
  const home = galaxy.systems[galaxy.homeId];
  const homeGrp = galaxy.groups.find(function (gp) { return gp.id === galaxy.homeGroupId; });
  const homeTag = homeGrp && homeGrp.acronym ? ' <span class="name-tag">[' + homeGrp.acronym + ']</span>' : '';
  const html = startDS + ' — Galassia generata: ' + galaxy.count + ' sistemi. ' +
    'Origine nel sistema <strong>' + home.name + '</strong>' + homeTag + '.';
  if (ORION.game) ORION.game.chronicle = [{ html: html, mod: 'system', cat: 'galaxy' }];
  /* All'avvio partita resetta gli "unread" e fa partire dalla sezione Galassia. */
  ORION.chronicleUnread = { galaxy: false, colony: false };
  const log = document.querySelector('[data-bind="chronicle"]');
  if (!log) return;
  log.innerHTML =
    (ORION.chronicleSection === 'galaxy'
      ? '<li class="chronicle__entry chronicle__entry--system">' + html + '</li>'
      : '<li class="chronicle__entry chronicle__entry--system">Nessuna voce.</li>');
}

function pushChronicle(html, modifier, category, opts) {
  /* `category` opzionale: se assente la deriviamo dal modifier (regola
     di fallback per chiamate dirette non passate da chronicleEvent).
     `opts.silent` (o `ORION._chronicleSilentNext` settato da chronicleEvent
     per un kind in CHRONICLE_SILENT_KINDS): l'entry entra nel log ma non
     attiva l'aura pulsante sulla linguetta. */
  const cat = (category === 'galaxy' || category === 'colony')
    ? category
    : chronicleCategoryFromMod(modifier || '');
  const silent = !!((opts && opts.silent) || ORION._chronicleSilentNext);
  /* Persist nel game state: il DOM lo ricaviamo, ma la fonte di verità
     per il save (e il replay dopo F5) è game.chronicle[]. */
  if (ORION.game) {
    if (!Array.isArray(ORION.game.chronicle)) ORION.game.chronicle = [];
    ORION.game.chronicle.unshift({ html: html, mod: modifier || '', cat: cat });
    if (ORION.game.chronicle.length > MAX_CHRONICLE) {
      ORION.game.chronicle.length = MAX_CHRONICLE;
    }
  }
  /* Aura "non letti" sulla linguetta: l'utente sta guardando la cronaca
     solo se la tab Cronaca è attiva E la sezione mostrata coincide con
     la categoria dell'evento. In ogni altro caso → flag unread per la
     categoria, così la linguetta pulsa. */
  const looking = (ORION.lpTab === 'chronicle') && (ORION.chronicleSection === cat);
  if (!looking && !silent) {
    if (!ORION.chronicleUnread) ORION.chronicleUnread = { galaxy: false, colony: false };
    const wasUnread = ORION.chronicleUnread[cat];
    ORION.chronicleUnread[cat] = true;
    if (!wasUnread) {
      saveUiPrefs();
      if (typeof renderLeftPanel === 'function') {
        try { renderLeftPanel(); } catch (_) { /* niente */ }
      }
    }
    return;
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
  const sec = ORION.chronicleSection || 'galaxy';
  const filtered = game.chronicle.filter(function (e) {
    const cat = e.cat || chronicleCategoryFromMod(e.mod);
    return cat === sec;
  });
  log.innerHTML = (filtered.length
    ? filtered.map(function (e) {
        const mod = e.mod ? ' chronicle__entry--' + e.mod : '';
        return '<li class="chronicle__entry' + mod + '">' + e.html + '</li>';
      }).join('')
    : '<li class="chronicle__entry chronicle__entry--system">Nessuna voce.</li>');
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

  /* Cloud: stato + bottoni manuali. La lista degli slot remoti si carica
     on-demand (un GET piccolo). Lo stato di sync e' un indicatore live. */
  html += cloudSectionHtml();

  /* Backup automatici locali (creati dal reconcile cloud quando il cloud
     sovrascrive il locale). Visibile solo se ce ne sono. */
  html += backupSectionHtml();

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
  attachCloudHandlers(body);
}

/* ------------------------------------------------------------------
   Sezione Cloud nella modale Save (decisione di sessione).
   ------------------------------------------------------------------ */
function cloudSectionHtml() {
  if (!ORION.cloud) return '';
  const C = ORION.cloud;
  const enabled = C.isEnabled();
  const s = C.STATE || {};
  let label = '—';
  let cls = 'cloud-state cloud-state--idle';
  if (!enabled) { label = 'Disabilitato'; cls = 'cloud-state cloud-state--off'; }
  else if (s.status === 'syncing') { label = 'Sincronizzazione…'; cls = 'cloud-state cloud-state--sync'; }
  else if (s.status === 'ok' && s.lastSyncAt) { label = 'OK · ' + new Date(s.lastSyncAt).toLocaleTimeString(); cls = 'cloud-state cloud-state--ok'; }
  else if (s.status === 'error') { label = 'Errore: ' + (s.lastError || 'sconosciuto'); cls = 'cloud-state cloud-state--err'; }
  else if (s.status === 'offline') { label = 'Offline'; cls = 'cloud-state cloud-state--err'; }

  const toggleLabel = enabled ? 'Disabilita cloud' : 'Abilita cloud';
  const hasGame = !!ORION.game;

  return '<section class="save-section">' +
    '<h3 class="save-section__title">☁ Cloud sync</h3>' +
    '<div class="cloud-row">' +
      '<span class="' + cls + '">' + escapeHtml(label) + '</span>' +
      '<div class="cloud-actions">' +
        (hasGame ? '<button class="btn btn--mini" data-action="cloud-push-now" type="button">Sincronizza ora</button>' : '') +
        '<button class="btn btn--mini" data-action="cloud-refresh-list" type="button">Mostra slot remoti</button>' +
        '<button class="btn btn--mini" data-action="cloud-toggle" type="button">' + escapeHtml(toggleLabel) + '</button>' +
      '</div>' +
    '</div>' +
    '<div class="cloud-remote" data-bind="cloud-remote"></div>' +
    '</section>';
}

function attachCloudHandlers(root) {
  if (!ORION.cloud) return;
  const C = ORION.cloud;
  const push = root.querySelector('[data-action="cloud-push-now"]');
  if (push) push.addEventListener('click', function () {
    if (!ORION.game) return;
    showToast('☁ Sincronizzazione in corso…');
    C.pushNow('autosave', ORION.game)
      .then(function () { showToast('☁ Autosave sincronizzato'); renderSaveModal(); })
      .catch(function (err) { showToast('☁ Errore: ' + (err && err.message || err)); renderSaveModal(); });
  });
  const tog = root.querySelector('[data-action="cloud-toggle"]');
  if (tog) tog.addEventListener('click', function () {
    C.setEnabled(!C.isEnabled());
    showToast(C.isEnabled() ? '☁ Cloud abilitato' : '☁ Cloud disabilitato');
    renderSaveModal();
  });
  const ref = root.querySelector('[data-action="cloud-refresh-list"]');
  if (ref) ref.addEventListener('click', function () { refreshCloudRemoteList(); });
  /* Backup automatici: scarica / cancella. */
  root.querySelectorAll('[data-action="backup-download"]').forEach(function (b) {
    b.addEventListener('click', function () {
      const ok = ORION.cloud.downloadBackup(Number(b.dataset.idx));
      showToast(ok ? '⬇ Backup scaricato' : 'Backup non trovato');
    });
  });
  root.querySelectorAll('[data-action="backup-delete"]').forEach(function (b) {
    b.addEventListener('click', function () {
      if (!confirm('Cancellare questo backup automatico? Resta solo se è già stato scaricato.')) return;
      ORION.cloud.deleteBackup(Number(b.dataset.idx));
      renderSaveModal();
    });
  });
}

function backupSectionHtml() {
  if (!ORION.cloud || !ORION.cloud.listBackups) return '';
  const list = ORION.cloud.listBackups();
  if (!list || !list.length) return '';
  let h = '<section class="save-section">' +
    '<h3 class="save-section__title">Backup automatici locali (' + list.length + ')</h3>' +
    '<p class="save-section__hint">' +
      'Creati automaticamente quando il cloud sovrascrive il locale. ' +
      'Conservati nel browser (gli ultimi ' + ORION.cloud.CFG.BACKUP_KEEP + '). Scaricali se vuoi tenerli al sicuro.' +
    '</p>' +
    '<ul class="backup-list">';
  list.forEach(function (b) {
    const date = b.ts ? new Date(b.ts).toLocaleString() : '—';
    h += '<li class="backup-list__item">' +
      '<div class="backup-list__meta">' +
        '<div><strong>' + escapeHtml(b.label) + '</strong> · ' + escapeHtml(b.ds) + ' · seed <code>' + escapeHtml(b.seed) + '</code></div>' +
        '<div class="backup-list__date">' + escapeHtml(date) + '</div>' +
      '</div>' +
      '<div class="backup-list__actions">' +
        '<button class="btn btn--mini" data-action="backup-download" data-idx="' + b.idx + '" type="button">⬇ Scarica</button>' +
        '<button class="btn btn--mini btn--danger" data-action="backup-delete" data-idx="' + b.idx + '" type="button">Cancella</button>' +
      '</div>' +
    '</li>';
  });
  h += '</ul></section>';
  return h;
}

function refreshCloudRemoteList() {
  const host = document.querySelector('[data-bind="cloud-remote"]');
  if (!host) return;
  host.innerHTML = '<p class="save-empty">Caricamento…</p>';
  ORION.cloud.list().then(function (rows) {
    if (!rows || !rows.length) { host.innerHTML = '<p class="save-empty">Nessun salvataggio nel cloud.</p>'; return; }
    /* ordina: autosave, s0..s4 */
    const order = { 'autosave': -1, 's0': 0, 's1': 1, 's2': 2, 's3': 3, 's4': 4 };
    rows.sort(function (a, b) { return (order[a.slot] || 99) - (order[b.slot] || 99); });
    let h = '<ul class="save-grid">';
    rows.forEach(function (r) {
      h += '<li class="save-grid__item">' + cloudCardHtml(r) + '</li>';
    });
    h += '</ul>';
    host.innerHTML = h;
    host.querySelectorAll('[data-action="cloud-pull"]').forEach(function (b) {
      b.addEventListener('click', function () { cloudPullToLocal(b.dataset.slot); });
    });
    host.querySelectorAll('[data-action="cloud-delete"]').forEach(function (b) {
      b.addEventListener('click', function () { cloudDeleteRemote(b.dataset.slot); });
    });
  }).catch(function (err) {
    host.innerHTML = '<p class="save-empty">Errore: ' + escapeHtml(String(err && err.message || err)) + '</p>';
  });
}

function cloudCardHtml(row) {
  const date = row.updated_at ? new Date(row.updated_at).toLocaleString() : '—';
  const isAuto = row.slot === 'autosave';
  const idx = isAuto ? -1 : parseInt(row.slot.substring(1), 10);
  return '<div class="save-card save-card--cloud' + (isAuto ? ' save-card--auto' : '') + '">' +
    '<div class="save-card__name">☁ ' + escapeHtml(isAuto ? 'Autosave' : ('Slot ' + (idx + 1))) + '</div>' +
    '<dl class="save-card__meta">' +
      (row.empire_label ? '<div><dt>Popolo</dt><dd><strong>' + escapeHtml(row.empire_label) + '</strong></dd></div>' : '') +
      (row.ds_label ? '<div><dt>' + uiIcon('clock', 'soft') + ' Data Stellare</dt><dd>' + escapeHtml(row.ds_label) + '</dd></div>' : '') +
      '<div><dt>Seed</dt><dd><code>' + escapeHtml(row.seed || '—') + '</code></dd></div>' +
      '<div><dt>Schema</dt><dd>' + (row.schema || 0) + '</dd></div>' +
      '<div><dt>Aggiornato</dt><dd>' + date + '</dd></div>' +
    '</dl>' +
    '<div class="save-card__actions">' +
      '<button class="btn btn--mini" data-action="cloud-pull" data-slot="' + escapeHtml(row.slot) + '" type="button">Scarica nel locale</button>' +
      '<button class="btn btn--mini btn--danger" data-action="cloud-delete" data-slot="' + escapeHtml(row.slot) + '" type="button">Elimina remoto</button>' +
    '</div>' +
    '</div>';
}

function cloudPullToLocal(slot) {
  if (!ORION.cloud) return;
  if (!confirm('Scaricare il salvataggio cloud "' + slot + '" e sovrascrivere quello locale corrispondente? La copia locale precedente verrà esportata come .json di backup.')) return;
  ORION.cloud.pull(slot).then(function (row) {
    if (!row) { showToast('Slot vuoto sul cloud'); return; }
    /* Backup del locale prima di sovrascrivere. */
    const localMeta = (slot === 'autosave')
      ? ORION.cloud.localAutosaveMeta()
      : ORION.cloud.localSlotMeta(parseInt(slot.substring(1), 10));
    if (localMeta && localMeta.payload) {
      ORION.cloud.backupLocalPayload(localMeta.payload, 'pre-pull-' + slot);
    }
    if (slot === 'autosave') ORION.cloud.writeLocalAutosave(row);
    else ORION.cloud.writeLocalSlot(parseInt(slot.substring(1), 10), row);
    showToast('☁ Slot ' + slot + ' scaricato nel locale');
    renderSaveModal();
  }).catch(function (err) { showToast('☁ Errore: ' + (err && err.message || err)); });
}

function cloudDeleteRemote(slot) {
  if (!ORION.cloud) return;
  if (!confirm('Eliminare definitivamente lo slot "' + slot + '" dal cloud? Il locale resta intatto.')) return;
  ORION.cloud.del(slot).then(function () {
    showToast('☁ Slot ' + slot + ' eliminato dal cloud');
    refreshCloudRemoteList();
  });
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
  enterGame({ intro: 'load' });
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
  const SEQ = /^crew-(\d+)$/;
  game.idSeq = game.idSeq || {};
  /* 1ª passata: riconcilia il counter col massimo seq già presente (colonie
     + flotte). Necessario per i save senza idSeq persistito, così i nuovi
     equipaggi NON ricollidono con quelli esistenti (es. crew-3 già in giro). */
  let maxSeq = game.idSeq.crew | 0;
  function scanSeq(list) {
    if (!Array.isArray(list)) return;
    list.forEach(function (c) {
      const m = c && typeof c.id === 'string' && SEQ.exec(c.id);
      if (m) maxSeq = Math.max(maxSeq, Number(m[1]));
    });
  }
  Object.keys(game.colonies).forEach(function (k) {
    const col = game.colonies[k];
    scanSeq(col && col.crews && col.crews.explorer);
  });
  if (Array.isArray(game.fleets)) game.fleets.forEach(function (f) { scanSeq(f && f.crew); });
  game.idSeq.crew = maxSeq;
  /* 2ª passata: rinomina gli ID col formato legacy `crew-<imp>-<n>`. */
  Object.keys(game.colonies).forEach(function (k) {
    const col = game.colonies[k];
    const list = col && col.crews && col.crews.explorer;
    if (!Array.isArray(list)) return;
    list.forEach(function (c) {
      if (c && typeof c.id === 'string' && LEGACY.test(c.id)) {
        c.id = T && T.nextCrewId ? T.nextCrewId(game)
                                 : ('crew-' + (game.idSeq.crew = (game.idSeq.crew | 0) + 1));
      }
    });
  });
}

function enterGame(opts) {
  opts = opts || {};
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
  /* PR mobile: mostra la bottom tab bar ora che la partita è attiva. */
  updateMobileNav();
  /* Sequenza d'apertura (intro cinematica). Se attiva, posticipa il welcome
     a fine intro (così non compare sopra il volo); le lezioni 'system'/
     'planet' restano soppresse durante la cinematica (vedi openSystem/
     openPlanet). Con cinematiche OFF o reduced-motion → comportamento storico
     (welcome subito, nessun volo). */
  const introKind = opts.intro;   // 'new' | 'load' | undefined
  const cine = ORION.cinematics;
  if (introKind && cine && cine.playIntro && cine.mode && cine.mode() !== 'off') {
    const g = ORION.game;
    let homeBody = null;
    if (g.homePlanetKey) {
      const parts = String(g.homePlanetKey).split(':');
      if (parts.length === 2) homeBody = parts[1];
    }
    cine.playIntro({
      kind: introKind,
      homeSystemId: g.galaxy ? g.galaxy.homeId : null,
      homeGroupId: g.galaxy ? g.galaxy.homeGroupId : null,
      homeBodyKey: homeBody,
      capitalSystemId: g.galaxy ? g.galaxy.homeId : null,
      onDone: function () { if (ORION.tutorial && introKind === 'new') ORION.tutorial.fire('welcome'); }
    });
  } else {
    /* Welcome: prima trigger della partita (solo se tutorial attivo e non già vista). */
    if (ORION.tutorial) ORION.tutorial.fire('welcome');
  }
}

function escapeHtml(s) { return ORION.util.escapeHtml(s); }

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
    enterGame({ intro: 'load' });
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
  enterGame({ intro: 'new' });
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
  /* Cinematiche (Fase 1): aggancia la navigazione così il regista può portare
     alla vista del sistema appena esplorato senza dipendere da main.js. */
  if (ORION.cinematics) ORION.cinematics.bind({
    openSystem: function (id) { openSystem(id); },
    openPlanet: function (sysId, bodyKey) { openPlanet(sysId, bodyKey); }
  });
  initMobileNav();
  initMainMenu();
  showMainMenu('home');
  /* Cloud sync (decisione di sessione): reconciliation autosave al boot,
     piu' recente vince, backup .json del perdente. Non blocca il menu —
     se finisce dopo "Continua", l'utente ha gia' caricato il locale; in
     quel caso lo invitiamo a ricaricare con un toast. */
  reconcileCloudAtBoot();
  console.info('%cOrion Empires ' + ORION.version + ' — main menu pronto.', 'color:#2fe6e0');
}

function reconcileCloudAtBoot() {
  if (!ORION.cloud || !ORION.cloud.reconcileAtBoot) return;
  if (!ORION.cloud.isEnabled()) return;
  showToast('☁ Controllo cloud…');
  ORION.cloud.reconcileAtBoot().then(function (res) {
    if (!res) return;
    switch (res.action) {
      case 'pulled-overwrote-local':
        showToast('☁ Cloud più recente: locale sostituito (backup nel pannello Save)');
        /* Se l'utente e' gia' entrato in partita, suggerisci ricarica. */
        if (ORION.game) showToast('Ricarica la pagina per usare il save cloud appena scaricato');
        break;
      case 'pulled-fresh':
        showToast('☁ Salvataggio cloud scaricato (nessun locale)');
        break;
      case 'pushed-initial':
        showToast('☁ Autosave caricato nel cloud');
        break;
      case 'pushed-local-newer':
        showToast('☁ Locale più recente: cloud aggiornato');
        break;
      case 'in-sync':
        /* niente toast: rumore inutile a ogni avvio */
        break;
      case 'offline':
        showToast('☁ Cloud non raggiungibile: gioco offline');
        break;
      case 'disabled':
      case 'empty':
      default:
        break;
    }
    renderSaveModal();   /* se la modale e' aperta, aggiorna lo stato */
  });
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
