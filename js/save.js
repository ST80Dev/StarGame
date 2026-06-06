/* =====================================================================
   ORION EMPIRES — save.js
   Modulo M06: salvataggio e caricamento (GDD §2, §20, §21).

   Estende la preview di M05 (chiave 'orion.game', schema 2) con:
     - slot multipli (5 manuali + 1 autosave) in un'unica chiave atomica
       'orion.saves.v3'
     - export/import file `.json` (trasferimento manuale tra dispositivi)
     - cronaca persistita nel payload (ultime 40 entry, log limitato §5)
     - migrazione automatica v1 → v2 → v3 (sub-migrazioni componibili)

   Decisione di sessione (#24):
     - import .json con seed diverso → rigenera galassia dal seed del file
       (coerente con seed+delta, decisione #5). La partita corrente viene
       sostituita con conferma esplicita.
     - card testuali per gli slot, niente screenshot del Canvas (cap
       localStorage rispettato, ~10KB/slot vs ~200KB con thumb).
     - ironman (decisione #23, preset nightmare): nascosti slot manuali e
       pulsante "Carica slot"; autosave + export/import .json restano
       attivi (l'export è backup tra dispositivi, non save-scumming).
     - boot: continua sempre dall'autosave; "Nuova partita" come azione
       esplicita nel pannello salvataggi.

   Architettura: namespace globale ORION, niente bundler. Tutto il
   payload è già seed+delta (la galassia si rigenera dal seed), quindi
   anche i save tardivi pesano poche decine di KB.
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  /* Schema 4: fondo M06.5 (decisione #27, scelta colonia + Insediamento)
     e M06.6 (decisione #28, tutorial contestuale).
     - M06.5 aggiunge `homeWorld` + colonia.phase/settlingStart/settlingDuration
     - M06.6 aggiunge game.tutorial = { enabled, seenLessons }
     Sub-migrazioni componibili: v1→v2 (victory), v2→v3 (chronicle), v3→v4
     (homeWorld:null + colonia operational + tutorial vuoto, retro-compat). */
  /* Schema 8 (M10 Fase A, decisione #47): aggiunge lo stato delle civiltà
     AI (game.civs), i pirati (game.piracy) e l'ICG (game.icg). */
  /* Schema 9 (M09 Fase A, decisione #49): aggiunge le incursioni pirata
     inbound (game.incursions), gli assedi in corso (game.battles) e lo
     stato di guerra d'impero morale/pressione (game.warState). La veteranità
     delle navi vive dentro fleet.ships[*] (auto-serializzata via game.fleets);
     l'hp delle strutture danneggiate vive in colony.structures (auto). */
  const SCHEMA_VERSION = 9;

  const STORAGE_KEY = 'orion.saves.v3';
  /* Chiavi legacy assorbite e cancellate alla prima migrazione. */
  const LEGACY_GAME_KEY = 'orion.game';
  const LEGACY_SEED_KEY = 'orion.seed';

  /* Slot manuali: 5 (decisione di sessione). L'autosave è separato. */
  const MAX_MANUAL_SLOTS = 5;
  /* Log cronaca capato (decisione #5). */
  const CHRONICLE_CAP = 40;

  /* ------------------------------------------------------------------
     STORAGE — lettura/scrittura atomica della chiave unica
     ------------------------------------------------------------------ */
  function readStore() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return { autosave: null, slots: [] };
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return { autosave: null, slots: [] };
      data.slots = Array.isArray(data.slots) ? data.slots : [];
      if (data.autosave === undefined) data.autosave = null;
      return data;
    } catch (e) {
      return { autosave: null, slots: [] };
    }
  }
  function writeStore(store) {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); }
    catch (e) { /* localStorage pieno: lasciamo silenzioso per ora. */ }
  }

  /* ------------------------------------------------------------------
     SERIALIZE — game (in memoria, con galaxy/state derivati) → payload
                 piatto (solo delta, schema versionato).
     ------------------------------------------------------------------ */
  function serialize(game) {
    if (!game) return null;
    return {
      schema: SCHEMA_VERSION,
      seed: game.seed,
      startEpochOrbita: game.startEpochOrbita,
      timeImpulsi: game.timeImpulsi || 0,
      homePlanetKey: game.homePlanetKey,
      colonies: game.colonies,
      mode: game.mode,
      victoryTracks: game.victoryTracks,
      eventSchedule: game.eventSchedule || [],
      chronicle: capChronicle(game.chronicle),
      /* M06.5 (decisione #27): scelta colonia originaria, salvata
         esplicitamente per non doverla rideterminare al runtime. */
      homeWorld: game.homeWorld || null,
      /* M06.6 (decisione #28): stato tutorial contestuale. */
      tutorial: game.tutorial || { enabled: false, seenLessons: [] },
      /* M07 (decisione #37): spedizioni in corso. Le colonie già contengono
         ships/crews/assets quindi vengono auto-serializzate via game.colonies. */
      expeditions: Array.isArray(game.expeditions) ? game.expeditions : [],
      /* M08 Fase A (decisione #42): flotte mobili. Counter scafi per
         classe vive in colony.ships e viene auto-serializzato. */
      fleets: Array.isArray(game.fleets) ? game.fleets : [],
      /* Decisione #45: mapping centrale gruppo→capitale. Lo stato
         capitalState delle singole colonie vive in game.colonies e
         viene auto-serializzato. */
      capitals: (game.capitals && typeof game.capitals === 'object') ? game.capitals : {},
      /* M10 Fase A (decisione #47): civiltà AI + pirati + ICG come delta.
         La struttura immutabile della galassia (sistemi, fasce, rotte) si
         rigenera dal seed; qui salviamo solo lo stato mutevole (chi possiede
         cosa, potenza, disposizione, ICG). */
      civs: Array.isArray(game.civs) ? game.civs : [],
      piracy: (game.piracy && typeof game.piracy === 'object') ? game.piracy : { nests: [] },
      icg: (typeof game.icg === 'number') ? game.icg : null,
      /* M09 Fase A (decisione #49): incursioni inbound, assedi in corso,
         stato di guerra d'impero (morale/pressione). */
      incursions: Array.isArray(game.incursions) ? game.incursions : [],
      battles: Array.isArray(game.battles) ? game.battles : [],
      warState: (game.warState && typeof game.warState === 'object') ? game.warState : { morale: 1.0, pressure: 0 }
    };
  }

  function capChronicle(arr) {
    if (!Array.isArray(arr)) return [];
    if (arr.length <= CHRONICLE_CAP) return arr.slice();
    return arr.slice(0, CHRONICLE_CAP);
  }

  /* ------------------------------------------------------------------
     MIGRATIONS — sub-migrazioni componibili. Ogni modulo futuro che
     cambia il payload bumpa SCHEMA_VERSION e aggiunge una riga qui.
     ------------------------------------------------------------------ */
  function migrate(payload) {
    if (!payload) return payload;
    /* v1 → v2 è di victory.js (mode + victoryTracks) — riusiamo l'esistente. */
    if ((payload.schema || 1) < 2 && ORION.victory && ORION.victory.migrate) {
      payload = ORION.victory.migrate(payload);
    }
    /* v2 → v3 (M06): aggiungi chronicle[] vuota. Niente è perso, ma il
       log riparte dal momento del primo save in schema 3. */
    if ((payload.schema || 2) < 3) {
      if (!Array.isArray(payload.chronicle)) payload.chronicle = [];
      payload.schema = 3;
    }
    /* v3 → v4: fonde M06.5 (homeWorld + colonia.phase) e M06.6 (tutorial).
       - M06.5 (decisione #27): aggiungi homeWorld:null e marca ogni colonia
         esistente come 'operational'. NIENTE Insediamento retroattivo per
         i save vecchi (sarebbe punitivo: chi ha già giocato deve restare
         operativo).
       - M06.6 (decisione #28): aggiungi stato tutorial. Per i save legacy
         il tutorial parte disabilitato (l'utente conosce già il gioco)
         ma le lezioni restano riapribili dalla "?". */
    if ((payload.schema || 3) < 4) {
      if (!payload.homeWorld) payload.homeWorld = null;
      if (payload.colonies && typeof payload.colonies === 'object') {
        Object.keys(payload.colonies).forEach(function (k) {
          const c = payload.colonies[k];
          if (!c) return;
          if (!c.phase) c.phase = 'operational';
          if (c.settlingStart === undefined) c.settlingStart = null;
          if (c.settlingDuration === undefined) c.settlingDuration = 60;
        });
      }
      if (!payload.tutorial || typeof payload.tutorial !== 'object') {
        payload.tutorial = { enabled: false, seenLessons: [] };
      }
      if (!Array.isArray(payload.tutorial.seenLessons)) {
        payload.tutorial.seenLessons = [];
      }
      payload.schema = 4;
    }
    /* v4 → v5 (M07, decisione #37): aggiungi expeditions[] e i campi
       ships/crews/assets ad ogni colonia, se mancanti. Retro-compat:
       save vecchi caricano con 0 scafi, 0 equipaggi, nessuna spedizione. */
    if ((payload.schema || 4) < 5) {
      if (!Array.isArray(payload.expeditions)) payload.expeditions = [];
      if (payload.colonies && typeof payload.colonies === 'object') {
        Object.keys(payload.colonies).forEach(function (k) {
          const c = payload.colonies[k];
          if (!c) return;
          if (!c.ships) c.ships = { explorer: 0 };
          if (!c.crews) c.crews = { explorer: [] };
          if (!c.assets) c.assets = { shipQueue: [], crewQueue: [] };
          if (!Array.isArray(c.assets.shipQueue)) c.assets.shipQueue = [];
          if (!Array.isArray(c.assets.crewQueue)) c.assets.crewQueue = [];
        });
      }
      payload.schema = 5;
    }
    /* v5 → v6 (M08 Fase A, decisione #42): aggiungi fleets[] e i counter
       per le 5 classi note in ogni colonia. Default kind='explorer' su
       shipQueue legacy senza campo `kind`. Retro-compat: save M07 caricano
       con 0 flotte e tutti i counter ship a 0 (tranne `explorer` se già
       presente). */
    if ((payload.schema || 5) < 6) {
      if (!Array.isArray(payload.fleets)) payload.fleets = [];
      const KINDS = ['explorer', 'caccia', 'intercettore', 'corvetta', 'fregata'];
      if (payload.colonies && typeof payload.colonies === 'object') {
        Object.keys(payload.colonies).forEach(function (k) {
          const c = payload.colonies[k];
          if (!c) return;
          if (!c.ships) c.ships = {};
          KINDS.forEach(function (kk) { if (c.ships[kk] == null) c.ships[kk] = 0; });
          if (c.assets && Array.isArray(c.assets.shipQueue)) {
            for (let i = 0; i < c.assets.shipQueue.length; i++) {
              if (!c.assets.shipQueue[i].kind) c.assets.shipQueue[i].kind = 'explorer';
            }
          }
        });
      }
      payload.schema = 6;
    }
    /* v6 → v7 (Decisione #45): aggiungi game.capitals (lazy: vuoto qui,
       initFromHome lo popolerà al caricamento). Le colonie esistenti
       lasciano capitalState undefined → bonusOf fallback su isCapital
       letto dal mapping centrale. Niente migrazione distruttiva. */
    if ((payload.schema || 6) < 7) {
      if (!payload.capitals || typeof payload.capitals !== 'object') {
        payload.capitals = {};
      }
      payload.schema = 7;
    }
    /* v7 → v8 (M10 Fase A, decisione #47): aggiungi civs/piracy/icg.
       Lazy: vuoti qui, ORION.ai.ensure() li genera dal seed al caricamento
       (idempotente). Save vecchi caricano e la galassia "prende vita" alla
       prima apertura, coerente con seed+delta. */
    if ((payload.schema || 7) < 8) {
      if (!Array.isArray(payload.civs)) payload.civs = [];
      if (!payload.piracy || typeof payload.piracy !== 'object') payload.piracy = { nests: [] };
      if (payload.icg == null) payload.icg = null;
      payload.schema = 8;
    }
    /* v8 → v9 (M09 Fase A, decisione #49): aggiungi incursions/battles/warState.
       Lazy: vuoti qui. Save vecchi caricano senza combattimenti pendenti e con
       morale d'impero pieno. La veteranità navi e l'hp strutture sono additivi
       sui rispettivi entity → retro-compat 100%. */
    if ((payload.schema || 8) < 9) {
      if (!Array.isArray(payload.incursions)) payload.incursions = [];
      if (!Array.isArray(payload.battles)) payload.battles = [];
      if (!payload.warState || typeof payload.warState !== 'object') {
        payload.warState = { morale: 1.0, pressure: 0 };
      }
      payload.schema = 9;
    }
    return payload;
  }

  /* Verifica se un payload può essere caricato dalla versione corrente. */
  function isCompatible(payload) {
    if (!payload || !payload.seed || typeof payload.seed !== 'string') return false;
    if (typeof payload.schema !== 'number') return false;
    /* Niente downgrade: rifiutiamo schema più nuovi del nostro. */
    if (payload.schema > SCHEMA_VERSION) return false;
    return true;
  }

  /* ------------------------------------------------------------------
     LEGACY MIGRATION — assorbe il vecchio formato M05 (orion.game +
     orion.seed) come autosave, poi cancella le chiavi vecchie. Idempotente.
     ------------------------------------------------------------------ */
  function migrateLegacy() {
    const store = readStore();
    if (store.autosave || (store.slots && store.slots.length > 0)) {
      /* Store moderno già presente: niente da fare. Eventuali residui
         legacy verranno comunque cancellati. */
      cleanupLegacyKeys();
      return store;
    }
    let raw = null;
    try { raw = window.localStorage.getItem(LEGACY_GAME_KEY); } catch (e) {}
    if (!raw) { cleanupLegacyKeys(); return store; }
    try {
      let data = JSON.parse(raw);
      data = migrate(data);
      if (isCompatible(data)) {
        store.autosave = {
          payload: data,
          name: 'Autosave (importata da M05)',
          ts: Date.now()
        };
        writeStore(store);
      }
    } catch (e) { /* ignora payload legacy corrotto */ }
    cleanupLegacyKeys();
    return store;
  }
  function cleanupLegacyKeys() {
    try { window.localStorage.removeItem(LEGACY_GAME_KEY); } catch (e) {}
    try { window.localStorage.removeItem(LEGACY_SEED_KEY); } catch (e) {}
  }

  /* ------------------------------------------------------------------
     AUTOSAVE — sostituisce sempre lo slot autosave (rotante a 1).
     Decisione: nessun debounce, lo scenario "click rapidi" è coperto
     dal batch a fine advance.
     ------------------------------------------------------------------ */
  function autosave(game) {
    if (!game) return;
    const store = readStore();
    store.autosave = {
      payload: serialize(game),
      name: 'Autosave',
      ts: Date.now()
    };
    writeStore(store);
  }
  function loadAutosave() {
    const store = readStore();
    if (!store.autosave) return null;
    const p = migrate(store.autosave.payload);
    return isCompatible(p) ? p : null;
  }
  function clearAutosave() {
    const store = readStore();
    store.autosave = null;
    writeStore(store);
  }

  /* ------------------------------------------------------------------
     SLOT MANUALI — 5 slot, identificati per indice 0..4.
     ------------------------------------------------------------------ */
  function list() {
    const store = readStore();
    /* Restituisci sempre l'array di MAX_MANUAL_SLOTS, con null nei vuoti,
       così la UI può iterare sull'indice senza if extra. */
    const slots = [];
    for (let i = 0; i < MAX_MANUAL_SLOTS; i++) {
      slots.push(store.slots[i] ? slotMeta(i, store.slots[i]) : null);
    }
    const auto = store.autosave ? slotMeta(-1, store.autosave) : null;
    return { autosave: auto, slots: slots };
  }
  function slotMeta(idx, slot) {
    const p = slot.payload || {};
    /* Card testuale: seed + DS + n. colonie + n. sistemi esplorati +
       modalità + preset. Niente screenshot (decisione #24, costo
       localStorage). */
    let colonies = 0;
    if (p.colonies) {
      Object.keys(p.colonies).forEach(function (k) {
        if (p.colonies[k] && p.colonies[k].colonized) colonies++;
      });
    }
    const ds = currentDsLabel(p);
    return {
      idx: idx,
      name: slot.name || ('Slot ' + (idx + 1)),
      ts: slot.ts || 0,
      seed: p.seed || '—',
      ds: ds,
      colonies: colonies,
      mode: (p.mode && p.mode.startedAs) || 'sandbox',
      preset: (p.mode && p.mode.preset) || 'classic',
      schema: p.schema || 0
    };
  }
  function currentDsLabel(payload) {
    if (!payload || !ORION.time || !ORION.time.format) return '—';
    const orb = payload.startEpochOrbita || 0;
    const i = payload.timeImpulsi || 0;
    return ORION.time.format(orb * 100 + i, 'compact');
  }

  function saveSlot(idx, game, name) {
    if (idx < 0 || idx >= MAX_MANUAL_SLOTS) return false;
    if (!game) return false;
    const store = readStore();
    store.slots[idx] = {
      payload: serialize(game),
      name: name || ('Slot ' + (idx + 1)),
      ts: Date.now()
    };
    writeStore(store);
    return true;
  }
  function loadSlot(idx) {
    if (idx < 0 || idx >= MAX_MANUAL_SLOTS) return null;
    const store = readStore();
    const slot = store.slots[idx];
    if (!slot) return null;
    const p = migrate(slot.payload);
    return isCompatible(p) ? p : null;
  }
  function eraseSlot(idx) {
    if (idx < 0 || idx >= MAX_MANUAL_SLOTS) return false;
    const store = readStore();
    store.slots[idx] = null;
    writeStore(store);
    return true;
  }

  /* ------------------------------------------------------------------
     EXPORT / IMPORT — file .json (decisione #5).
     Nome file: orion_<seed>_DS<orbita>-<impulsi>_<YYYYMMDDHHmm>.json
     (deterministico per stato + timestamp leggibile per ordine
     cronologico — decisione #24).
     ------------------------------------------------------------------ */
  function exportJson(game) {
    if (!game) return;
    const payload = serialize(game);
    const text = JSON.stringify(payload);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFilename(payload);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    /* lascia che il browser scarichi prima di revocare */
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    return a.download;
  }
  function exportFilename(payload) {
    const seed = (payload.seed || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
    const orb = payload.startEpochOrbita || 0;
    const i = payload.timeImpulsi || 0;
    const dsOrb = orb + Math.floor(i / 100);
    const dsI = i % 100;
    const d = new Date();
    const pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    const ts = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
               pad(d.getHours()) + pad(d.getMinutes());
    return 'orion_' + seed + '_DS' + dsOrb + '-' + pad(dsI) + '_' + ts + '.json';
  }

  /* Parsa + valida un blob .json. Ritorna { ok, payload, reason }. */
  function parseImport(text) {
    if (!text) return { ok: false, reason: 'file vuoto' };
    let data;
    try { data = JSON.parse(text); }
    catch (e) { return { ok: false, reason: 'JSON non valido' }; }
    if (!data || typeof data !== 'object') return { ok: false, reason: 'payload non valido' };
    if (!data.seed || typeof data.seed !== 'string') return { ok: false, reason: 'seed assente' };
    if (typeof data.schema !== 'number') return { ok: false, reason: 'schema assente' };
    if (data.schema > SCHEMA_VERSION) {
      return { ok: false, reason: 'schema ' + data.schema + ' più recente di quello supportato (' + SCHEMA_VERSION + ')' };
    }
    const migrated = migrate(data);
    if (!isCompatible(migrated)) return { ok: false, reason: 'payload incompatibile dopo migrazione' };
    return { ok: true, payload: migrated };
  }

  /* Helper che apre un file picker e ritorna una Promise col testo. */
  function pickJsonFile() {
    return new Promise(function (resolve, reject) {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.addEventListener('change', function () {
        const f = input.files && input.files[0];
        if (!f) { reject(new Error('nessun file selezionato')); return; }
        const reader = new FileReader();
        reader.onload = function () { resolve(String(reader.result || '')); };
        reader.onerror = function () { reject(reader.error || new Error('lettura fallita')); };
        reader.readAsText(f);
      });
      input.click();
    });
  }

  /* ------------------------------------------------------------------
     IRONMAN — guard sul load manuale (decisione #23). Lascia passare
     autosave e import/export .json (vedi commento in testa).
     ------------------------------------------------------------------ */
  function isIronman(game) {
    return !!(game && game.mode && game.mode.modifiers && game.mode.modifiers.ironman);
  }

  ORION.save = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    MAX_MANUAL_SLOTS: MAX_MANUAL_SLOTS,
    CHRONICLE_CAP: CHRONICLE_CAP,

    /* lifecycle */
    migrateLegacy: migrateLegacy,
    autosave: autosave,
    loadAutosave: loadAutosave,
    clearAutosave: clearAutosave,

    /* slot */
    list: list,
    saveSlot: saveSlot,
    loadSlot: loadSlot,
    eraseSlot: eraseSlot,

    /* file .json */
    exportJson: exportJson,
    exportFilename: exportFilename,
    parseImport: parseImport,
    pickJsonFile: pickJsonFile,

    /* helpers */
    serialize: serialize,
    migrate: migrate,
    isCompatible: isCompatible,
    isIronman: isIronman,
    capChronicle: capChronicle
  };
})(typeof window !== 'undefined' ? window : this);
