/* =====================================================================
   ORION EMPIRES — save.js
   Salvataggio e caricamento (GDD §2, §20, §21; decisioni #5, #24).

   - 5 slot manuali + 1 autosave in un'unica chiave localStorage atomica
   - export/import file `.json`
   - seed + delta: nel payload solo lo stato mutevole, la galassia si
     rigenera dal seed
   - STATE_FIELDS: elenco UNICO dei campi persistiti, usato sia da
     serialize sia dal ripristino (newgame.create → applyPayload)

   Revisione 2026 (Fase 2): schema azzerato a 100, nessuna migrazione dai
   save ≤ 32 (rifiutati con messaggio). Storia degli schemi: git log.
   ===================================================================== */
(function (root) {
  const ORION = root.ORION = root.ORION || {};

  const SCHEMA_VERSION = 100;

  /* Chiave nuova: lo store v3 (save pre-reset) resta intatto in
     localStorage ma non viene più letto. */
  const STORAGE_KEY = 'orion.saves.v4';

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
  /* Stato di partita persistito: UN SOLO elenco, usato sia da serialize sia
     dal ripristino (newgame.create con payload). Ogni voce è
     [campo di game, default]. Il default è usato quando il campo manca in
     memoria. Aggiungere qui un campo = salvato E ricaricato (il test di
     round-trip in tests/sim.test.mjs lo verifica). */
  const STATE_FIELDS = [
    ['startEpochOrbita', 0],
    ['timeImpulsi', 0],
    ['homePlanetKey', null],
    ['homeWorld', null],
    ['idSeq', {}],
    ['colonies', {}],
    ['mode', null],
    ['victoryTracks', {}],
    ['victoryFocus', null],
    ['eventSchedule', []],
    ['tutorial', { enabled: false, seenLessons: [] }],
    ['fleets', []],
    ['capitals', {}],
    ['civs', []],
    ['piracy', { nests: [] }],
    ['icg', null],
    ['incursions', []],
    ['battles', []],
    ['warState', { morale: 1.0, pressure: 0 }],
    ['defeated', null],
    ['alignmentDeeds', { light: 0, dark: 0 }],
    ['reputation', 50],
    ['cohesion', { sysIds: [] }],
    ['federations', { list: [], trust: {} }],
    ['tradeRoutes', []],
    ['treasury', { balances: {} }],
    ['tradeAgreements', []],
    ['wasteDeals', []],
    ['garrisons', {}],
    ['mekhariIntel', { rumors: [] }],
    ['empire', null],
    ['commanders', []],
    ['research', null],
    ['colonyFigures', []],
    ['council', null],
    ['stations', []],
    ['luminari', []],
    ['missions', []],
    ['memoria', []],
    ['dispatchMeta', { lastOfferAt: -1, offers: 0, completed: 0 }],
    ['contracts', []],
    ['crises', []],
    ['crisisMeta', { icgTier: 0 }],
    ['anomalies', {}],
    ['espionage', { ops: [], seq: 0 }],
    ['phenomena', {}],
    ['aiFleets', []],
    ['repHistory', []],
    ['journal', { pins: [], nextId: 1 }],
    ['chronicle', []]
  ];
  const clone = function (v) { return v == null ? v : JSON.parse(JSON.stringify(v)); };

  /* ------------------------------------------------------------------
     SERIALIZE — game (in memoria, con galaxy/state derivati) → payload
                 piatto (solo delta). La struttura immutabile (galassia,
                 sistemi, pianeti) si rigenera dal seed (decisione #5).
     ------------------------------------------------------------------ */
  function serialize(game) {
    if (!game) return null;
    const out = { schema: SCHEMA_VERSION, seed: game.seed };
    for (let i = 0; i < STATE_FIELDS.length; i++) {
      const k = STATE_FIELDS[i][0];
      out[k] = (game[k] === undefined) ? clone(STATE_FIELDS[i][1]) : game[k];
    }
    /* Trasformazioni: cache e liste cappate. */
    out.chronicle = capChronicle(game.chronicle);
    out.repHistory = Array.isArray(game.repHistory) ? game.repHistory.slice(0, 20) : [];
    if (game.research) {
      /* _lastRate/_rateAccum sono cache ricalcolate al primo tick. */
      out.research = {
        catalogVersion: game.research.catalogVersion,
        unlocked: game.research.unlocked,
        activeProject: game.research.activeProject || null,
        progress: game.research.progress || 0,
        activationPaid: game.research.activationPaid || null
      };
    }
    if (ORION.journal && ORION.journal.serialize) out.journal = ORION.journal.serialize(game);
    /* Nebbia di guerra: vive in game.state (derivato dal seed + delta). */
    out.discovery = (game.state && Array.isArray(game.state.discovery)) ? game.state.discovery.slice() : null;
    return out;
  }

  /* Ripristino: applica i campi del payload su una partita appena generata
     dal seed (chiamato da newgame.create). Deep-clone: la partita non
     condivide oggetti con il payload. */
  function applyPayload(game, payload) {
    for (let i = 0; i < STATE_FIELDS.length; i++) {
      const k = STATE_FIELDS[i][0];
      if (payload[k] !== undefined) game[k] = clone(payload[k]);
    }
    if (Array.isArray(payload.discovery) && game.state &&
        payload.discovery.length === game.state.discovery.length) {
      game.state.discovery = payload.discovery.slice();
    }
    return game;
  }

  function capChronicle(arr) {
    if (!Array.isArray(arr)) return [];
    if (arr.length <= CHRONICLE_CAP) return arr.slice();
    return arr.slice(0, CHRONICLE_CAP);
  }

  /* Verifica se un payload può essere caricato dalla versione corrente. */
  function isCompatible(payload) {
    if (!payload || !payload.seed || typeof payload.seed !== 'string') return false;
    /* Revisione 2026: solo lo schema corrente (i save pre-reset sono
       rifiutati con un messaggio, vedi incompatibilityReason). */
    return payload.schema === SCHEMA_VERSION;
  }

  /* Messaggio leggibile per un payload non caricabile. */
  function incompatibilityReason(payload) {
    if (!payload || !payload.seed) return 'File di salvataggio non valido.';
    if (typeof payload.schema === 'number' && payload.schema < SCHEMA_VERSION) {
      return 'Salvataggio di una versione precedente alla Revisione 2026 (schema ' + payload.schema +
        '): non è più caricabile. Inizia una nuova partita.';
    }
    if (typeof payload.schema === 'number' && payload.schema > SCHEMA_VERSION) {
      return 'Salvataggio creato da una versione più recente del gioco (schema ' + payload.schema + ').';
    }
    return 'Salvataggio incompatibile.';
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
    /* Cloud sync (debounced) — decisione di sessione. */
    if (ORION.cloud && ORION.cloud.schedulePush) {
      ORION.cloud.schedulePush('autosave', game);
    }
  }
  function loadAutosave() {
    const store = readStore();
    if (!store.autosave) return null;
    const p = store.autosave.payload;
    return isCompatible(p) ? p : null;
  }
  function clearAutosave() {
    const store = readStore();
    store.autosave = null;
    writeStore(store);
    if (ORION.cloud && ORION.cloud.del) ORION.cloud.del('autosave');
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
    const gname = p.seed && ORION.names && ORION.names.galaxyName
      ? ORION.names.galaxyName(p.seed) : null;
    return {
      idx: idx,
      name: slot.name || ('Slot ' + (idx + 1)),
      ts: slot.ts || 0,
      seed: p.seed || '—',
      galaxyName: gname,
      empire: empireLabelOf(p),     /* decisione #65: nome del popolo */
      ds: ds,
      colonies: colonies,
      mode: (p.mode && p.mode.startedAs) || 'sandbox',
      preset: (p.mode && p.mode.preset) || 'classic',
      schema: p.schema || 0
    };
  }
  /* Etichetta identità popolo da un payload (decisione #65), riusando il
     pool archetipi di ai.js. Null se assente (save < schema 20). */
  function empireLabelOf(p) {
    const e = p && p.empire;
    if (!e || !e.proper) return null;
    const A = (ORION.ai && ORION.ai.ARCHETYPES) || {};
    const all = [].concat(A.bene || [], A.neutrale || [], A.male || []);
    const a = all.find(function (x) { return x.id === e.prefix; }) || { noun: 'Repubblica' };
    return a.noun + ' ' + (a.direct ? '' : 'di ') + e.proper;
  }
  function currentDsLabel(payload) {
    if (!payload || !ORION.time || !ORION.time.format) return '—';
    /* Decisione di sessione: il tempo parte da 0, ignoriamo startEpochOrbita
       anche sui save vecchi (= sottrazione dell'offset iniziale). */
    return ORION.time.format(payload.timeImpulsi || 0, 'compact');
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
    /* Cloud sync immediato per gli slot manuali (azione esplicita dell'utente).
       Passiamo il nome cosi' il cloud lo persiste e i prompt successivi
       possono ripresentarlo come default. */
    if (ORION.cloud && ORION.cloud.pushNow) {
      ORION.cloud.pushNow('s' + idx, game, store.slots[idx].name);
    }
    return true;
  }
  function loadSlot(idx) {
    if (idx < 0 || idx >= MAX_MANUAL_SLOTS) return null;
    const store = readStore();
    const slot = store.slots[idx];
    if (!slot) return null;
    const p = slot.payload;
    return isCompatible(p) ? p : null;
  }
  function eraseSlot(idx) {
    if (idx < 0 || idx >= MAX_MANUAL_SLOTS) return false;
    const store = readStore();
    store.slots[idx] = null;
    writeStore(store);
    if (ORION.cloud && ORION.cloud.del) ORION.cloud.del('s' + idx);
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
    /* Nome galassia leggibile come prefisso (decisione "Galaxy name in UI",
       2026-06-07): orion_<NomeGalassia>_<seed>_DS<…>.json. Il seed resta
       (disambigua collisioni dovute a 480 combo finite). */
    let gslug = '';
    if (payload.seed && ORION.names && ORION.names.galaxyName) {
      gslug = ORION.names.galaxyName(payload.seed)
        .replace(/\s+/g, '-')
        .replace(/[^a-zA-Z0-9_-]/g, '');
    }
    /* Decisione di sessione (opzione A): nel filename solo l'Ι totale
       della partita corrente. Ordinabile lessicograficamente con padding
       fisso a 7 cifre (copre fino a Ω99 = 9.9M Ι), ASCII-safe. */
    const i = payload.timeImpulsi || 0;
    const dsStr = String(i).padStart(7, '0');
    const d = new Date();
    const pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    const ts = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
               pad(d.getHours()) + pad(d.getMinutes());
    const prefix = gslug ? 'orion_' + gslug + '_' + seed : 'orion_' + seed;
    return prefix + '_DS' + dsStr + '_' + ts + '.json';
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
    if (!isCompatible(data)) return { ok: false, reason: incompatibilityReason(data) };
    return { ok: true, payload: data };
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
    STORAGE_KEY: STORAGE_KEY,
    MAX_MANUAL_SLOTS: MAX_MANUAL_SLOTS,
    CHRONICLE_CAP: CHRONICLE_CAP,

    /* lifecycle */
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
    applyPayload: applyPayload,
    incompatibilityReason: incompatibilityReason,
    STATE_FIELDS: STATE_FIELDS,
    isCompatible: isCompatible,
    isIronman: isIronman,
    capChronicle: capChronicle
  };
})(typeof window !== 'undefined' ? window : this);
