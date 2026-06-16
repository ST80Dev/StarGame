/* =====================================================================
   crew-roster.js — Riepilogo equipaggi impero (sidebar sx + vista centrale)

   Decisione utente 2026-06-16: una scheda "Equipaggi" gemella di "Flotte"
   nella sidebar sx (sintesi compatta con un toggle d'ordine) + una vista
   centrale espansa con filtri (sistema, stato, soglia xp, attività
   dominante) e tab gemella "Figure" per le promozioni §12.4.

   Lo snapshot è puro: legge `game` e restituisce un array di righe
   `{ id, label, xp, enr, dominant, status, statusLabel, systemId,
      systemName, colonyKey, fleetId, fleetName, eta }` — gli stessi dati
   alimentano sidebar e vista centrale (single source of truth).

   Persistenza UI: ordinamento sidebar e filtri vista centrale vivono in
   `localStorage['orion.uiprefs']` via `ORION.uiPrefs`, mai nel save di
   partita (UI_GUIDE §9).
   ===================================================================== */
(function (root) {
  'use strict';

  function esc(s) {
    s = (s == null) ? '' : String(s);
    return s.replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function uiIcon(name, tone) {
    var O = root.ORION || {};
    var svg = (O.icon && O.icon(name)) || '';
    var cls = 'ui-icon' + (tone ? ' ui-icon--' + tone : '');
    return '<span class="' + cls + '" aria-hidden="true">' + svg + '</span>';
  }
  function crewLabel(id) {
    if (typeof root.crewShortLabel === 'function') return root.crewShortLabel(id);
    return id || 'Equipaggio';
  }
  function enrichmentFor(xp) {
    var EXP = (root.ORION || {}).expedition;
    if (EXP && EXP.enrichmentForXp) return EXP.enrichmentForXp(xp);
    return { label: '—', tier: 0 };
  }
  function dominantOf(svc) {
    if (!svc) return null;
    var c = svc.combat | 0, t = svc.travel | 0, k = svc.tactical | 0;
    if (!c && !t && !k) return null;
    if (c >= t && c >= k) return 'combat';
    if (t >= k) return 'travel';
    return 'tactical';
  }
  var DOMINANT_LABEL = {
    combat:   { short: 'combat.',  long: 'Combattimenti',         role: 'Comandante' },
    travel:   { short: 'viaggio',  long: 'Viaggi/manutenzione',   role: 'Ingegnere' },
    tactical: { short: 'pattuglia', long: 'Pattuglie/ricognizioni', role: 'Stratega' }
  };

  /* Etichetta di stato per la cronaca della flotta (allineata a renderFleetView). */
  function fleetStatusOf(f) {
    if (!f || !f.location) return { id: 'unknown', label: '—' };
    if (f.location.status === 'docked') return { id: 'docked', label: 'attracco' };
    if (f.location.status === 'in-transit') return { id: 'transit', label: 'viaggio' };
    return { id: 'orbit', label: 'orbita' };
  }

  /* ------------------------------------------------------------------
     snapshot(game) — raccoglie tutti gli equipaggi (a riposo + imbarcati +
     legacy expeditions) e tutte le figure (idle pool + officers di flotta).
     ------------------------------------------------------------------ */
  function snapshot(g) {
    var out = {
      crews: [],
      figures: [],
      totals: {
        crews: 0, atRest: 0, onFleet: 0, inTransit: 0,
        promotable: 0, avgXp: 0,
        figures: 0
      }
    };
    if (!g) return out;
    var sys = (g.galaxy && g.galaxy.systems) || [];
    function sysName(id) { return (id >= 0 && sys[id]) ? sys[id].name : '—'; }
    function colonyName(key) {
      if (!key) return '';
      var c = g.colonies && g.colonies[key];
      if (!c) return key;
      if (typeof root.planetForColony === 'function') {
        var p = root.planetForColony(c);
        if (p && p.name) return p.name;
      }
      return 'Colonia ' + key;
    }

    /* (1) A riposo presso colonia. */
    Object.keys(g.colonies || {}).forEach(function (k) {
      var c = g.colonies[k];
      if (!c || !c.colonized) return;
      var arr = (c.crews && c.crews.explorer) || [];
      for (var i = 0; i < arr.length; i++) {
        var cw = arr[i]; if (!cw) continue;
        var xp = cw.xp | 0;
        var d = dominantOf(cw.svc);
        out.crews.push({
          id: cw.id,
          label: crewLabel(cw.id),
          xp: xp,
          enr: enrichmentFor(xp),
          svc: cw.svc || null,
          dominant: d,
          status: 'rest',
          statusLabel: 'a riposo',
          statusDetail: colonyName(k),
          systemId: c.systemId,
          systemName: sysName(c.systemId),
          colonyKey: k,
          colonyName: colonyName(k),
          fleetId: null,
          fleetName: null,
          eta: 0,
          promotable: xp >= 8
        });
      }
    });

    /* (2) Imbarcati su una flotta. */
    var fleets = g.fleets || [];
    for (var fi = 0; fi < fleets.length; fi++) {
      var f = fleets[fi]; if (!f) continue;
      var fst = fleetStatusOf(f);
      var crew = f.crew || [];
      for (var j = 0; j < crew.length; j++) {
        var cc = crew[j]; if (!cc) continue;
        var fxp = cc.xp | 0;
        var dd = dominantOf(cc.svc);
        var detail;
        if (fst.id === 'transit') {
          var toId = (f.orders && (f.orders.toSysId != null)) ? f.orders.toSysId
            : (f.route && f.route.length ? f.route[f.route.length - 1] : -1);
          detail = sysName(f.location.systemId) + ' → ' + sysName(toId) +
            ' (ETA ' + (f.etaImpulsi | 0) + ' Ι)';
        } else {
          detail = sysName(f.location.systemId) + (fst.id === 'docked' ? ' (attracco)' : ' (orbita)');
        }
        out.crews.push({
          id: cc.id,
          label: crewLabel(cc.id),
          xp: fxp,
          enr: enrichmentFor(fxp),
          svc: cc.svc || null,
          dominant: dd,
          status: fst.id === 'transit' ? 'transit' : 'fleet',
          statusLabel: fst.id === 'transit' ? 'in viaggio' : ('imbarcato · ' + fst.label),
          statusDetail: detail,
          systemId: f.location ? f.location.systemId : -1,
          systemName: sysName(f.location ? f.location.systemId : -1),
          colonyKey: f.ownerColonyKey || null,
          colonyName: f.ownerColonyKey ? colonyName(f.ownerColonyKey) : '',
          fleetId: f.id,
          fleetName: f.name,
          eta: f.etaImpulsi | 0,
          promotable: fxp >= 8
        });
      }
    }

    /* (3) Legacy expeditions (saves storici, non più popolato da M08+). */
    var legacy = g.expeditions || [];
    for (var ei = 0; ei < legacy.length; ei++) {
      var e = legacy[ei]; if (!e || e.status === 'done') continue;
      var exp = e.crewXp | 0;
      out.crews.push({
        id: e.crewId,
        label: crewLabel(e.crewId),
        xp: exp,
        enr: enrichmentFor(exp),
        svc: null,
        dominant: 'tactical',
        status: 'expedition',
        statusLabel: 'in spedizione',
        statusDetail: 'verso ' + sysName(e.targetSystemId),
        systemId: e.targetSystemId,
        systemName: sysName(e.targetSystemId),
        colonyKey: e.originColonyKey || null,
        colonyName: e.originColonyKey ? colonyName(e.originColonyKey) : '',
        fleetId: null,
        fleetName: null,
        eta: e.durationOut | 0,
        promotable: exp >= 8
      });
    }

    /* Figure: pool idle + officers su flotta. */
    var pool = g.commanders || [];
    for (var pi = 0; pi < pool.length; pi++) {
      var cmd = pool[pi]; if (!cmd) continue;
      out.figures.push({
        id: cmd.id, name: cmd.name, rank: cmd.rank, role: cmd.role,
        roleLabel: cmd.roleLabel, trait: cmd.traitLabel || cmd.trait || '',
        race: cmd.raceLabel || cmd.race || '', xp: cmd.xp | 0,
        status: 'idle',
        statusLabel: 'a riposo',
        statusDetail: cmd.originColonyKey ? ('riserva · ' + colonyName(cmd.originColonyKey)) : 'riserva',
        systemId: -1, systemName: '—',
        colonyKey: cmd.originColonyKey || null,
        fleetId: null, fleetName: null
      });
    }
    for (var fk = 0; fk < fleets.length; fk++) {
      var ff = fleets[fk]; if (!ff) continue;
      var officers = (ff.officers && ff.officers.slice && ff.officers.slice()) || (ff.commander ? [ff.commander] : []);
      var fs = fleetStatusOf(ff);
      for (var oi = 0; oi < officers.length; oi++) {
        var of = officers[oi]; if (!of) continue;
        out.figures.push({
          id: of.id, name: of.name, rank: of.rank, role: of.role,
          roleLabel: of.roleLabel, trait: of.traitLabel || of.trait || '',
          race: of.raceLabel || of.race || '', xp: of.xp | 0,
          status: fs.id === 'transit' ? 'transit' : 'fleet',
          statusLabel: 'su ' + ff.name + ' · ' + fs.label,
          statusDetail: sysName(ff.location ? ff.location.systemId : -1),
          systemId: ff.location ? ff.location.systemId : -1,
          systemName: sysName(ff.location ? ff.location.systemId : -1),
          colonyKey: ff.ownerColonyKey || null,
          fleetId: ff.id, fleetName: ff.name
        });
      }
    }

    /* Totali */
    var tot = out.totals;
    var s = 0;
    out.crews.forEach(function (cw) {
      tot.crews++;
      if (cw.status === 'rest') tot.atRest++;
      else if (cw.status === 'transit' || cw.status === 'expedition') tot.inTransit++;
      else tot.onFleet++;
      if (cw.promotable) tot.promotable++;
      s += cw.xp;
    });
    tot.avgXp = tot.crews ? (s / tot.crews) : 0;
    tot.figures = out.figures.length;
    return out;
  }

  /* ------------------------------------------------------------------
     Sidebar: HTML compatto. Un solo toggle d'ordine (xp ↓ · sistema ·
     stato). Header con totali. Click su riga → focus.
     ------------------------------------------------------------------ */
  var SORT_MODES = ['xp', 'system', 'status'];
  var SORT_LABEL = { xp: 'xp ↓', system: 'sistema', status: 'stato' };

  function getSidebarSort() {
    var O = root.ORION || {};
    var s = O.crewSidebarSort;
    return SORT_MODES.indexOf(s) >= 0 ? s : 'xp';
  }
  function cycleSidebarSort() {
    var O = root.ORION || {};
    var cur = getSidebarSort();
    var i = SORT_MODES.indexOf(cur);
    O.crewSidebarSort = SORT_MODES[(i + 1) % SORT_MODES.length];
    if (typeof root.saveUiPrefs === 'function') root.saveUiPrefs();
  }
  function STATUS_ORDER(s) {
    return s === 'rest' ? 0 : s === 'fleet' ? 1 : s === 'transit' ? 2 : 3;
  }
  function sortCrews(list, mode) {
    var arr = list.slice();
    if (mode === 'xp') {
      arr.sort(function (a, b) { return (b.xp - a.xp) || a.label.localeCompare(b.label); });
    } else if (mode === 'system') {
      arr.sort(function (a, b) {
        return a.systemName.localeCompare(b.systemName) ||
               STATUS_ORDER(a.status) - STATUS_ORDER(b.status) ||
               (b.xp - a.xp);
      });
    } else {
      arr.sort(function (a, b) {
        return STATUS_ORDER(a.status) - STATUS_ORDER(b.status) ||
               (b.xp - a.xp) ||
               a.label.localeCompare(b.label);
      });
    }
    return arr;
  }
  function statusBadgeCls(s) {
    return s === 'rest' ? 'ok' : s === 'fleet' ? 'info' : s === 'transit' ? 'warn' : 'info';
  }
  function statusBadgeLabel(s) {
    return s === 'rest' ? 'a riposo' : s === 'fleet' ? 'imbarcato' :
           s === 'transit' ? 'in viaggio' : 'spedizione';
  }

  function renderSidebarTab(g) {
    var snap = snapshot(g);
    var tot = snap.totals;
    if (!tot.crews) {
      return '<p class="lp-empty">Nessun equipaggio formato. Forma equipaggi in Accademia militare.</p>';
    }
    var mode = getSidebarSort();
    var sorted = sortCrews(snap.crews, mode);

    var header =
      '<div class="lp-crew-head">' +
        '<button class="lp-crew-sort" data-crew-sort type="button" title="Ordina (ciclico): xp / sistema / stato">' +
          uiIcon('refresh') + '<span class="lp-crew-sort__lbl">' + SORT_LABEL[mode] + '</span>' +
        '</button>' +
        '<div class="lp-crew-totals">' +
          '<span><strong>' + tot.crews + '</strong> eq.</span>' +
          '<span class="lp-crew-totals__sep">·</span>' +
          '<span title="Esperienza media">⌀ xp <strong>' + tot.avgXp.toFixed(1) + '</strong></span>' +
          (tot.promotable ? ('<span class="lp-crew-totals__sep">·</span>' +
            '<span class="lp-crew-pro" title="Vicini alla promozione (xp ≥ 8)">★ <strong>' + tot.promotable + '</strong></span>') : '') +
        '</div>' +
        '<button class="lp-crew-open" data-crew-open type="button" title="Apri Roster esteso nel pannello centrale" aria-label="Roster esteso">' +
          uiIcon('chronicle') +
        '</button>' +
      '</div>';

    var rowsHtml = sorted.map(function (cw) {
      var bcls = statusBadgeCls(cw.status);
      var dom = cw.dominant ? DOMINANT_LABEL[cw.dominant] : null;
      var domChip = dom
        ? '<span class="lp-crew-dom" title="Attività dominante: ' + esc(dom.long) + ' → ruolo atteso ' + esc(dom.role) + '">' + esc(dom.short) + '</span>'
        : '';
      var proChip = cw.promotable
        ? '<span class="lp-crew-promochip" title="Vicino alla promozione">★</span>'
        : '';
      return '<button class="lp-crew-row lp-crew-row--' + cw.status + '" type="button" ' +
          'data-crew-focus="1" ' +
          'data-status="' + esc(cw.status) + '" ' +
          'data-sys="' + (cw.systemId | 0) + '" ' +
          (cw.colonyKey ? 'data-colony="' + esc(cw.colonyKey) + '" ' : '') +
          (cw.fleetId ? 'data-fleet="' + esc(cw.fleetId) + '" ' : '') +
          '>' +
        '<span class="lp-crew-row__top">' +
          '<span class="lp-crew-row__name"><strong>' + esc(cw.label) + '</strong>' + proChip + '</span>' +
          '<span class="lp-crew-row__xp crew-roster__rank--t' + cw.enr.tier + '" title="' + esc(cw.enr.label) + '">xp ' + cw.xp + '</span>' +
        '</span>' +
        '<span class="lp-crew-row__bot">' +
          '<span class="lp-crew-row__status lp-crew-row__status--' + bcls + '">' + statusBadgeLabel(cw.status) + '</span>' +
          '<span class="lp-crew-row__detail" title="' + esc(cw.statusDetail) + '">' + esc(cw.statusDetail) + '</span>' +
          domChip +
        '</span>' +
      '</button>';
    }).join('');

    return header + '<div class="lp-crew-list">' + rowsHtml + '</div>';
  }

  /* Bind handlers: ordinamento ciclico + click su riga (focus). */
  function bindSidebarTab(host) {
    if (!host) return;
    var sortBtn = host.querySelector('[data-crew-sort]');
    if (sortBtn) sortBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      cycleSidebarSort();
      if (typeof root.renderLeftPanel === 'function') root.renderLeftPanel();
    });
    var openBtn = host.querySelector('[data-crew-open]');
    if (openBtn) openBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (typeof root.navigateView === 'function') root.navigateView('crews');
    });
    host.querySelectorAll('[data-crew-focus]').forEach(function (b) {
      b.addEventListener('click', function () {
        focusCrewRow(b.dataset);
      });
    });
  }

  /* Click su riga: a riposo → apre la colonia (navigateView('planet') sul
     pianeta cliccato, identica logica al roster colonia). Imbarcato/in
     viaggio → apre il sistema/gruppo della flotta, identica logica a
     roster-fleet. */
  function focusCrewRow(ds) {
    var O = root.ORION || {};
    var status = ds.status;
    var sid = Number(ds.sys);
    if (status === 'rest' && ds.colony) {
      var parts = String(ds.colony).split(':');
      var rsid = Number(parts[0]); var bk = parts[1];
      if (typeof root.navigateView === 'function') root.navigateView('planet');
      if (O.openSystemId !== rsid && typeof root.openSystem === 'function') root.openSystem(rsid);
      if (typeof root.openPlanet === 'function') root.openPlanet(rsid, bk);
      return;
    }
    /* su flotta: stessa logica di roster-fleet */
    var fleet = (O.game && O.game.fleets || []).find(function (f) { return f.id === ds.fleet; });
    var loc = fleet && fleet.location;
    if (sid >= 0 && O.game && O.game.state) O.game.state.selectedId = sid;
    var inInterstellar = !!(loc && loc.status === 'in-transit' && !loc.intra);
    if (inInterstellar) {
      if (typeof root.navigateView === 'function') root.navigateView('group');
      if (sid >= 0 && O.map && O.map.focusSystemCentered) O.map.focusSystemCentered(sid);
    } else {
      if (typeof root.navigateView === 'function') root.navigateView('system');
    }
  }

  /* ------------------------------------------------------------------
     Vista centrale espansa: filtri + ordinamenti + tab Equipaggi/Figure.
     ------------------------------------------------------------------ */
  function getCentralPrefs() {
    var O = root.ORION || {};
    if (!O.crewCentralPrefs) {
      O.crewCentralPrefs = {
        tab: 'crews',
        sort: 'xp',
        filterSys: 'all',
        filterStatus: 'all',
        filterXp: 'all',
        filterDom: 'all'
      };
    }
    return O.crewCentralPrefs;
  }
  function persistPrefs() {
    if (typeof root.saveUiPrefs === 'function') root.saveUiPrefs();
  }

  function renderCentral(stage) {
    if (!stage) return;
    var O = root.ORION || {};
    var g = O.game;
    if (!g) { stage.innerHTML = '<p class="panel__note">Avvia una partita dal menu.</p>'; return; }
    var prefs = getCentralPrefs();
    var snap = snapshot(g);
    var sys = (g.galaxy && g.galaxy.systems) || [];

    var systemOptions = [{ id: 'all', label: 'Tutti i sistemi' }];
    var seen = {};
    snap.crews.forEach(function (cw) {
      if (cw.systemId >= 0 && !seen[cw.systemId]) {
        seen[cw.systemId] = true;
        systemOptions.push({ id: String(cw.systemId), label: cw.systemName });
      }
    });
    systemOptions.sort(function (a, b) {
      if (a.id === 'all') return -1; if (b.id === 'all') return 1;
      return a.label.localeCompare(b.label);
    });

    function applyFiltersCrews(list) {
      return list.filter(function (cw) {
        if (prefs.filterSys !== 'all' && String(cw.systemId) !== prefs.filterSys) return false;
        if (prefs.filterStatus !== 'all' && cw.status !== prefs.filterStatus) return false;
        if (prefs.filterXp === 'pro8' && cw.xp < 8) return false;
        if (prefs.filterXp === 'pro10' && cw.xp < 10) return false;
        if (prefs.filterDom !== 'all' && cw.dominant !== prefs.filterDom) return false;
        return true;
      });
    }
    function sortCentral(list) {
      var arr = list.slice();
      if (prefs.sort === 'xp') {
        arr.sort(function (a, b) { return (b.xp - a.xp) || a.label.localeCompare(b.label); });
      } else if (prefs.sort === 'rank') {
        arr.sort(function (a, b) { return (b.enr.tier - a.enr.tier) || (b.xp - a.xp); });
      } else if (prefs.sort === 'system') {
        arr.sort(function (a, b) { return a.systemName.localeCompare(b.systemName) || (b.xp - a.xp); });
      } else if (prefs.sort === 'status') {
        arr.sort(function (a, b) { return STATUS_ORDER(a.status) - STATUS_ORDER(b.status) || (b.xp - a.xp); });
      }
      return arr;
    }

    var tot = snap.totals;
    var tabsHtml = '<div class="crew-view__tabs" role="tablist">' +
      '<button class="crew-view__tab' + (prefs.tab === 'crews' ? ' is-active' : '') + '" data-crew-tab="crews" type="button">Equipaggi <span class="crew-view__tab-n">' + tot.crews + '</span></button>' +
      '<button class="crew-view__tab' + (prefs.tab === 'figures' ? ' is-active' : '') + '" data-crew-tab="figures" type="button">Figure <span class="crew-view__tab-n">' + tot.figures + '</span></button>' +
    '</div>';

    var headerHtml =
      '<div class="fleet-view__head">' +
        '<h2 class="fleet-view__title">' + uiIcon('forces', 'amber') + ' Roster Equipaggi Impero <span class="fleet-view__sub">snapshot live</span></h2>' +
      '</div>' +
      '<div class="crew-view__totals">' +
        '<span><strong>' + tot.crews + '</strong> equipaggi</span> · ' +
        '<span><strong>' + tot.atRest + '</strong> a riposo</span> · ' +
        '<span><strong>' + tot.onFleet + '</strong> imbarcati</span> · ' +
        '<span><strong>' + tot.inTransit + '</strong> in viaggio</span> · ' +
        '<span title="Esperienza media">⌀ xp <strong>' + tot.avgXp.toFixed(2) + '</strong></span> · ' +
        '<span title="xp ≥ 8 — vicini alla promozione">★ <strong>' + tot.promotable + '</strong> in pipeline</span>' +
      '</div>';

    var body;
    if (prefs.tab === 'figures') {
      body = renderFiguresBody(snap.figures, prefs);
    } else {
      var filtered = applyFiltersCrews(snap.crews);
      var ordered = sortCentral(filtered);
      body = renderCrewsBody(ordered, prefs, systemOptions, snap.crews.length);
    }

    stage.innerHTML = '<div class="fleet-view crew-view">' + headerHtml + tabsHtml + body + '</div>';

    /* Bind */
    stage.querySelectorAll('[data-crew-tab]').forEach(function (b) {
      b.addEventListener('click', function () {
        prefs.tab = b.dataset.crewTab; persistPrefs(); renderCentral(stage);
      });
    });
    stage.querySelectorAll('[data-crew-filter]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        prefs[sel.dataset.crewFilter] = sel.value; persistPrefs(); renderCentral(stage);
      });
    });
    stage.querySelectorAll('[data-crew-csort]').forEach(function (b) {
      b.addEventListener('click', function () {
        prefs.sort = b.dataset.crewCsort; persistPrefs(); renderCentral(stage);
      });
    });
    stage.querySelectorAll('[data-crew-focus]').forEach(function (b) {
      b.addEventListener('click', function () { focusCrewRow(b.dataset); });
    });
    stage.querySelectorAll('[data-crew-reset]').forEach(function (b) {
      b.addEventListener('click', function () {
        prefs.filterSys = 'all'; prefs.filterStatus = 'all';
        prefs.filterXp = 'all'; prefs.filterDom = 'all';
        persistPrefs(); renderCentral(stage);
      });
    });
  }

  function renderCrewsBody(rows, prefs, systemOptions, totalUnfiltered) {
    var statusOptions = [
      { id: 'all', label: 'Tutti gli stati' },
      { id: 'rest', label: 'A riposo' },
      { id: 'fleet', label: 'Imbarcati (attracco/orbita)' },
      { id: 'transit', label: 'In viaggio' },
      { id: 'expedition', label: 'In spedizione (legacy)' }
    ];
    var xpOptions = [
      { id: 'all',   label: 'Tutti gli xp' },
      { id: 'pro8',  label: '≥ 8 (vicino a promozione)' },
      { id: 'pro10', label: '≥ 10 (pronto a emergere)' }
    ];
    var domOptions = [
      { id: 'all',      label: 'Tutte le attività' },
      { id: 'combat',   label: 'Combattimenti → Comandante' },
      { id: 'travel',   label: 'Viaggi → Ingegnere' },
      { id: 'tactical', label: 'Pattuglie → Stratega' }
    ];
    function selHtml(name, opts, value) {
      return '<select class="crew-filter" data-crew-filter="' + name + '">' +
        opts.map(function (o) {
          return '<option value="' + esc(o.id) + '"' + (String(value) === String(o.id) ? ' selected' : '') + '>' + esc(o.label) + '</option>';
        }).join('') +
      '</select>';
    }
    var SORTS = [
      { id: 'xp',     label: 'xp ↓' },
      { id: 'rank',   label: 'grado' },
      { id: 'system', label: 'sistema' },
      { id: 'status', label: 'stato' }
    ];
    var sortsHtml = SORTS.map(function (s) {
      return '<button class="crew-sort-btn' + (prefs.sort === s.id ? ' is-active' : '') + '" data-crew-csort="' + s.id + '" type="button">' + esc(s.label) + '</button>';
    }).join('');

    var filtersHtml =
      '<div class="crew-view__filters">' +
        selHtml('filterSys', systemOptions, prefs.filterSys) +
        selHtml('filterStatus', statusOptions, prefs.filterStatus) +
        selHtml('filterXp', xpOptions, prefs.filterXp) +
        selHtml('filterDom', domOptions, prefs.filterDom) +
        '<div class="crew-view__sorts">' +
          '<span class="crew-view__sorts-l">Ordina:</span>' + sortsHtml +
        '</div>' +
        '<button class="btn btn--mini" data-crew-reset type="button" title="Reset filtri">Reset</button>' +
      '</div>';

    if (!rows.length) {
      return filtersHtml + '<p class="panel__note">' +
        (totalUnfiltered ? 'Nessun equipaggio corrisponde ai filtri correnti.' : 'Nessun equipaggio formato — vai in Accademia militare.') +
      '</p>';
    }

    var tableHtml =
      '<table class="crew-table">' +
        '<thead><tr>' +
          '<th>Equipaggio</th>' +
          '<th>Grado · xp</th>' +
          '<th>Attività</th>' +
          '<th>Stato</th>' +
          '<th>Ubicazione</th>' +
          '<th>Origine</th>' +
        '</tr></thead>' +
        '<tbody>' +
        rows.map(function (cw) {
          var dom = cw.dominant ? DOMINANT_LABEL[cw.dominant] : null;
          var pro = cw.promotable
            ? '<span class="lp-crew-promochip" title="Vicino alla promozione (xp ≥ 8)">★</span>' : '';
          /* mini-barra verso prossima soglia (10) */
          var prog = Math.max(0, Math.min(100, Math.round((cw.xp / 10) * 100)));
          return '<tr class="crew-table__row" data-crew-focus="1" data-status="' + esc(cw.status) + '" ' +
            'data-sys="' + (cw.systemId | 0) + '" ' +
            (cw.colonyKey ? 'data-colony="' + esc(cw.colonyKey) + '" ' : '') +
            (cw.fleetId ? 'data-fleet="' + esc(cw.fleetId) + '" ' : '') +
            'tabindex="0">' +
            '<td><strong>' + esc(cw.label) + '</strong>' + pro + '</td>' +
            '<td>' +
              '<span class="crew-roster__rank crew-roster__rank--t' + cw.enr.tier + '">' + esc(cw.enr.label) + '</span> ' +
              '<span class="crew-table__xp">xp ' + cw.xp + '</span>' +
              '<span class="crew-table__bar" title="Progresso verso emersione (xp 10)"><span class="crew-table__bar-fill" style="width:' + prog + '%"></span></span>' +
            '</td>' +
            '<td>' + (dom ? '<span class="lp-crew-dom" title="' + esc(dom.long) + '">' + esc(dom.short) + '</span> <span class="crew-table__role">→ ' + esc(dom.role) + '</span>' : '<span class="crew-table__nodom">—</span>') + '</td>' +
            '<td><span class="lp-crew-row__status lp-crew-row__status--' + statusBadgeCls(cw.status) + '">' + statusBadgeLabel(cw.status) + '</span></td>' +
            '<td>' + esc(cw.statusDetail) + '</td>' +
            '<td>' + (cw.colonyName ? esc(cw.colonyName) : '<span class="crew-table__nodom">—</span>') + '</td>' +
          '</tr>';
        }).join('') +
        '</tbody>' +
      '</table>';

    return filtersHtml + tableHtml;
  }

  function renderFiguresBody(figures, prefs) {
    if (!figures.length) {
      return '<p class="panel__note">Nessuna figura emersa. Le figure (§12.4) nascono quando un equipaggio raggiunge xp ≥ 10.</p>';
    }
    var rows = figures.slice().sort(function (a, b) {
      return (b.xp - a.xp) || a.name.localeCompare(b.name);
    });
    var tableHtml =
      '<table class="crew-table crew-table--figures">' +
        '<thead><tr>' +
          '<th>Figura</th>' +
          '<th>Ruolo · Grado</th>' +
          '<th>xp</th>' +
          '<th>Tratto · Razza</th>' +
          '<th>Stato</th>' +
        '</tr></thead>' +
        '<tbody>' +
        rows.map(function (fg) {
          return '<tr class="crew-table__row" data-crew-focus="1" data-status="' + esc(fg.status) + '" ' +
            'data-sys="' + (fg.systemId | 0) + '" ' +
            (fg.colonyKey ? 'data-colony="' + esc(fg.colonyKey) + '" ' : '') +
            (fg.fleetId ? 'data-fleet="' + esc(fg.fleetId) + '" ' : '') +
            'tabindex="0">' +
            '<td><strong>' + esc(fg.name || '—') + '</strong></td>' +
            '<td>' + esc(fg.roleLabel || fg.role || '—') + ' · ' + esc(fg.rank || '—') + '</td>' +
            '<td>' + (fg.xp | 0) + '</td>' +
            '<td>' + esc(fg.trait || '—') + ' · ' + esc(fg.race || '—') + '</td>' +
            '<td>' + esc(fg.statusLabel || '—') + ' <span class="crew-table__detail">' + esc(fg.statusDetail || '') + '</span></td>' +
          '</tr>';
        }).join('') +
        '</tbody>' +
      '</table>';
    return tableHtml;
  }

  root.ORION = root.ORION || {};
  root.ORION.crewRoster = {
    snapshot: snapshot,
    renderSidebarTab: renderSidebarTab,
    bindSidebarTab: bindSidebarTab,
    renderCentral: renderCentral,
    getSidebarSort: getSidebarSort,
    focusCrewRow: focusCrewRow
  };
}(typeof window !== 'undefined' ? window : this));
