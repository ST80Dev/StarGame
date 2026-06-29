/* =====================================================================
   journal.js — Diario Strategico (M-journal)

   Appunti del giocatore: categorie chiuse + tag chiusi + nota libera
   breve. Niente integrazione cronaca, niente auto-pause, niente scadenze.

   Stato di gioco (decisione #5): vive in `game.journal` e finisce nel
   save. Additivo / lazy-init (nessun bump di SCHEMA_VERSION): save vecchi
   caricano e `ensure(game)` inizializza `game.journal = { pins:[], nextId:1 }`.
   ===================================================================== */
(function (root) {
  'use strict';

  var ORION = root.ORION = root.ORION || {};

  var NOTE_MAX = 140;

  /* Categorie chiuse — vocabolario fisso. */
  var CATS = [
    { key: 'colonize', label: 'Colonizzare', tint: 'info',   iconName: 'planet' },
    { key: 'presidio', label: 'Presidio',    tint: 'amber',  iconName: 'shield' },
    { key: 'target',   label: 'Bersagli',    tint: 'pink',   iconName: 'sword' },
    { key: 'diplo',    label: 'Diplo',       tint: 'pink',   iconName: 'diplomacy' },
    { key: 'tech',     label: 'Tech',        tint: 'violet', iconName: 'research' },
    { key: 'note',     label: 'Note',        tint: 'soft',   iconName: 'book' }
  ];
  var CAT_KEYS = CATS.map(function (c) { return c.key; });
  function isCat(k) { return CAT_KEYS.indexOf(k) !== -1; }

  var PRIORITIES = ['hi', 'med', 'lo'];
  var ROLES_PRESIDIO = ['choke', 'border', 'rear', 'hub'];
  var REASONS_COLONIZE = ['res', 'slot', 'pos'];

  var PRIORITY_LABEL = { hi: 'Alta', med: 'Media', lo: 'Bassa' };
  var ROLE_LABEL = { choke: 'Choke', border: 'Confine', rear: 'Retrovia', hub: 'Hub' };
  var REASON_LABEL = { res: 'Risorse', slot: 'Slot', pos: 'Posizione' };

  /* ------------------------------------------------------------------
     lazy init + serialize/migrate
     ------------------------------------------------------------------ */
  function ensure(game) {
    if (!game) return;
    if (!game.journal || typeof game.journal !== 'object') {
      game.journal = { pins: [], nextId: 1 };
    }
    if (!Array.isArray(game.journal.pins)) game.journal.pins = [];
    if (typeof game.journal.nextId !== 'number' || game.journal.nextId < 1) {
      var max = 0;
      game.journal.pins.forEach(function (p) {
        var m = p && p.id ? String(p.id).match(/jp_(\d+)/) : null;
        if (m) { var n = parseInt(m[1], 10); if (n > max) max = n; }
      });
      game.journal.nextId = max + 1;
    }
    /* Normalizza pin lazy (campi opzionali). */
    game.journal.pins.forEach(function (p) {
      if (!p) return;
      if (!p.tags || typeof p.tags !== 'object') p.tags = { priority: 'med' };
      if (PRIORITIES.indexOf(p.tags.priority) === -1) p.tags.priority = 'med';
      if (typeof p.note !== 'string') p.note = '';
      if (!p.status) p.status = 'active';
    });
  }

  function serialize(game) {
    if (!game || !game.journal) return { pins: [], nextId: 1 };
    return {
      pins: game.journal.pins.slice(),
      nextId: game.journal.nextId | 0 || 1
    };
  }

  /* Letto da save.js al caricamento: il payload espone `journal`; qui
     normalizziamo in caso di save legacy senza il campo. Idempotente. */
  function migrate(payload) {
    if (!payload) return payload;
    if (!payload.journal || typeof payload.journal !== 'object') {
      payload.journal = { pins: [], nextId: 1 };
    }
    if (!Array.isArray(payload.journal.pins)) payload.journal.pins = [];
    return payload;
  }

  /* ------------------------------------------------------------------
     CRUD
     ------------------------------------------------------------------ */
  function clampNote(s) {
    if (typeof s !== 'string') s = '';
    s = s.trim();
    if (s.length > NOTE_MAX) s = s.slice(0, NOTE_MAX);
    return s;
  }

  function normalizeTags(cat, tagsIn) {
    var t = (tagsIn && typeof tagsIn === 'object') ? tagsIn : {};
    var out = { priority: PRIORITIES.indexOf(t.priority) !== -1 ? t.priority : 'med' };
    if (cat === 'presidio' && ROLES_PRESIDIO.indexOf(t.role) !== -1) out.role = t.role;
    if (cat === 'colonize' && REASONS_COLONIZE.indexOf(t.reason) !== -1) out.reason = t.reason;
    return out;
  }

  function addPin(game, opts) {
    ensure(game);
    opts = opts || {};
    var cat = isCat(opts.cat) ? opts.cat : 'note';
    var ref = (opts.ref && typeof opts.ref === 'object' && opts.ref.kind) ? {
      kind: String(opts.ref.kind),
      id: (opts.ref.id != null) ? opts.ref.id : null
    } : null;
    var pin = {
      id: 'jp_' + game.journal.nextId,
      cat: cat,
      ref: ref,
      refLabel: (typeof opts.refLabel === 'string') ? opts.refLabel : '',
      tags: normalizeTags(cat, opts.tags),
      note: clampNote(opts.note),
      createdAt: (typeof opts.createdAt === 'string') ? opts.createdAt : '',
      status: 'active'
    };
    game.journal.nextId = (game.journal.nextId | 0) + 1;
    game.journal.pins.push(pin);
    return pin;
  }

  function findIdx(game, id) {
    if (!game || !game.journal || !Array.isArray(game.journal.pins)) return -1;
    for (var i = 0; i < game.journal.pins.length; i++) {
      if (game.journal.pins[i] && game.journal.pins[i].id === id) return i;
    }
    return -1;
  }

  function removePin(game, id) {
    var i = findIdx(game, id);
    if (i < 0) return false;
    game.journal.pins.splice(i, 1);
    return true;
  }

  function setStatus(game, id, status) {
    var i = findIdx(game, id);
    if (i < 0) return false;
    if (status !== 'active' && status !== 'resolved' && status !== 'archived') return false;
    game.journal.pins[i].status = status;
    return true;
  }

  function updatePin(game, id, patch) {
    var i = findIdx(game, id);
    if (i < 0) return false;
    var p = game.journal.pins[i];
    if (!patch || typeof patch !== 'object') return false;
    /* Integrità: cat/ref/refLabel sono strutturali, non patchabili.
       Per cambiarli l'utente cancella e ricrea il pin. */
    if (typeof patch.note === 'string') p.note = clampNote(patch.note);
    if (patch.tags) p.tags = normalizeTags(p.cat, Object.assign({}, p.tags, patch.tags));
    return true;
  }

  function list(game, opts) {
    ensure(game);
    opts = opts || {};
    var wantStatus = opts.status || 'active';
    var wantCat = opts.cat || null;
    return game.journal.pins.filter(function (p) {
      if (!p) return false;
      if (wantStatus !== 'any' && p.status !== wantStatus) return false;
      if (wantCat && p.cat !== wantCat) return false;
      return true;
    });
  }

  function catMeta(key) {
    for (var i = 0; i < CATS.length; i++) if (CATS[i].key === key) return CATS[i];
    return CATS[CATS.length - 1]; // fallback 'note'
  }

  ORION.journal = {
    NOTE_MAX: NOTE_MAX,
    CATS: CATS,
    PRIORITIES: PRIORITIES,
    ROLES_PRESIDIO: ROLES_PRESIDIO,
    REASONS_COLONIZE: REASONS_COLONIZE,
    PRIORITY_LABEL: PRIORITY_LABEL,
    ROLE_LABEL: ROLE_LABEL,
    REASON_LABEL: REASON_LABEL,
    ensure: ensure,
    serialize: serialize,
    migrate: migrate,
    addPin: addPin,
    removePin: removePin,
    setStatus: setStatus,
    updatePin: updatePin,
    list: list,
    catMeta: catMeta
  };
})(typeof window !== 'undefined' ? window : this);
