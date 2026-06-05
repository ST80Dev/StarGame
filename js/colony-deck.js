/* =====================================================================
   ORION EMPIRES — colony-deck.js
   Modulo M07.2 (decisione #42): "Plancia di Colonia".

   Overlay DOM montato come sibling del .planet-holder quando il livello
   attivo è Pianeta E il corpo è colonizzato. La sfera bakata di
   planet-view.js resta come sfondo evocativo; sopra, widget a cardinali
   (top-bar / risorse / strutture / coda / popolazione / cronaca) per dare
   al *centro* il colpo d'occhio che oggi vive solo nella sidebar.

   Principi (decisione #42):
     - Centro = colpo d'occhio + entry point ad alta frequenza (espandi
       modulo, annulla in coda). Sincronia con la sidebar: stessa azione,
       stesso effetto, niente "il deck sa cose che la sidebar non sa".
     - Sidebar = creazione (1 dei 14 tipi), configurazione (governator,
       tutorial), valori esatti. Resta funzionalmente completa.
     - Niente Canvas, solo DOM/SVG: scala meglio per testi/click, accessibile.
     - pointer-events: none di default sul deck-root (il pan/zoom del
       canvas planet sotto continua a funzionare), pointer-events: auto
       solo sui widget interattivi.
     - Vanilla JS / no framework / no CDN (§2).

   API:
     - mount(host, planet, colony, body, opts)  monta il deck nel container
     - refresh(planet, colony)                  re-render senza re-mount
     - destroy()                                smonta listener + DOM
     opts: { onBuild(id), onCancel(idx), onDemolish(id), onInfo(id),
             onOpenTab(tabId) }
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION;

  /* Glifo risorse (allineato a main.js → resGlyph). */
  const RES_GLYPH = { met: '⛭', en: '⚡', food: '❖', water: '≈' };
  const RES_LABEL = { met: 'Metalli', en: 'Energia', food: 'Cibo', water: 'Acqua' };
  const CLASS_ORDER = ['operai', 'scienziati', 'militari', 'mercanti', 'tecnici'];
  const CLASS_LABEL = {
    operai: 'Operai', scienziati: 'Scienziati', militari: 'Militari',
    mercanti: 'Mercanti', tecnici: 'Tecnici'
  };

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtNum(v) {
    if (v == null || !isFinite(v)) return '—';
    const av = Math.abs(v);
    if (av >= 1000) return (v / 1000).toFixed(1) + 'k';
    if (av >= 100) return Math.round(v).toString();
    return (Math.round(v * 10) / 10).toString();
  }
  function fmtRate(v) {
    if (v == null || !isFinite(v) || v === 0) return '0';
    const sign = v > 0 ? '+' : '−';
    const av = Math.abs(v);
    return sign + (av >= 10 ? av.toFixed(0) : av.toFixed(1));
  }

  class ColonyDeck {
    constructor() {
      this.host = null;
      this.planet = null;
      this.colony = null;
      this.body = null;
      this.opts = {};
      this._onClick = this._onClick.bind(this);
    }

    mount(host, planet, colony, body, opts) {
      this.host = host;
      this.planet = planet;
      this.colony = colony;
      this.body = body;
      this.opts = opts || {};
      host.classList.add('colony-deck');
      host.hidden = false;
      host.addEventListener('click', this._onClick);
      this._render();
      return this;
    }

    refresh(planet, colony) {
      if (planet) this.planet = planet;
      if (colony) this.colony = colony;
      this._render();
    }

    destroy() {
      if (this.host) {
        this.host.removeEventListener('click', this._onClick);
        this.host.innerHTML = '';
        this.host.classList.remove('colony-deck');
        this.host.hidden = true;
      }
      this.host = null;
      this.planet = null;
      this.colony = null;
      this.body = null;
    }

    /* ----- render -------------------------------------------------- */

    _render() {
      const planet = this.planet, colony = this.colony, body = this.body;
      if (!planet || !colony || !body) { this.host.innerHTML = ''; return; }

      const html =
        '<div class="deck-grid">' +
          this._renderTopBar() +
          this._renderResources() +
          this._renderStructures() +
          this._renderQueue() +
          this._renderPopulation() +
          this._renderFooter() +
        '</div>';
      this.host.innerHTML = html;
    }

    /* Top-bar: nome + tag regione + fase + morale. */
    _renderTopBar() {
      const body = this.body, colony = this.colony, planet = this.planet;
      const sysId = planet.systemId;
      const tag = (typeof root.bodyTagHtml === 'function') ? root.bodyTagHtml(sysId) : '';
      const bodyDef = ORION.system.BODY_TYPES[planet.type];
      const typeLabel = bodyDef ? bodyDef.label : planet.type;

      let phaseChip = '';
      if (colony.phase === 'settling' && colony.settlingStart != null) {
        const dur = colony.settlingDuration || 60;
        const elapsed = Math.max(0, (ORION.game.timeImpulsi || 0) - colony.settlingStart);
        const remain = Math.max(0, dur - elapsed);
        const pct = Math.min(100, Math.round((elapsed / dur) * 100));
        phaseChip =
          '<span class="deck-chip deck-chip--phase" title="Insediamento — fine in ' + remain + ' Ι">' +
            '⏳ Insediamento · ' + pct + '%' +
          '</span>';
      } else if (colony.colonizing) {
        phaseChip = '<span class="deck-chip deck-chip--phase">◌ Coloniale in viaggio</span>';
      } else if (colony.isHomeBase) {
        phaseChip = '<span class="deck-chip deck-chip--home">★ Pianeta base · +20%</span>';
      } else {
        phaseChip = '<span class="deck-chip">◉ Operativa</span>';
      }

      return '<div class="deck-topbar">' +
        '<div class="deck-topbar__title">' +
          '<span class="deck-topbar__name">' + escapeHtml(body.name) + '</span>' +
          tag +
        '</div>' +
        '<div class="deck-topbar__meta">' +
          '<span class="deck-topbar__type">' + escapeHtml(typeLabel) + '</span>' +
          phaseChip +
        '</div>' +
      '</div>';
    }

    /* Card risorse XXL (colonna sinistra). */
    _renderResources() {
      const colony = this.colony, planet = this.planet;
      const out = ORION.planet.structureOutput(colony, planet);
      const scar = colony._scar;
      const keys = ['met', 'en', 'food', 'water'];

      let html = '<aside class="deck-resources" aria-label="Risorse della colonia">';
      keys.forEach(function (k) {
        const stock = colony.stock[k] || 0;
        const net = (out.rates[k] || 0) - (out.upkeep[k] || 0);
        const state = scar && scar[k] ? scar[k].state : 'ok';
        const stateCls = state === 'crit' ? ' is-crit' : state === 'low' ? ' is-low' : '';
        const stateLabel = state === 'crit' ? 'critica' : state === 'low' ? 'allerta' : 'ok';
        const netCls = net > 0.01 ? 'is-pos' : net < -0.01 ? 'is-neg' : '';
        html +=
          '<div class="deck-res' + stateCls + '" data-res="' + k + '" title="' + RES_LABEL[k] + ' · ' + stateLabel + '">' +
            '<div class="deck-res__head">' +
              '<span class="deck-res__icon" aria-hidden="true">' + RES_GLYPH[k] + '</span>' +
              '<span class="deck-res__label">' + RES_LABEL[k] + '</span>' +
            '</div>' +
            '<div class="deck-res__value">' + fmtNum(stock) + '</div>' +
            '<div class="deck-res__rate ' + netCls + '">' + fmtRate(net) + ' / Ι</div>' +
          '</div>';
      });
      html += '</aside>';
      return html;
    }

    /* Strutture costruite — entry-point per "+Espandi" e "Smantella".
       (Costruire nuovi tipi resta solo in sidebar — decisione #42.)        */
    _renderStructures() {
      const colony = this.colony, planet = this.planet;
      const S = ORION.structures;
      const builtIds = Object.keys(colony.structures);

      let html = '<section class="deck-structures" aria-label="Strutture costruite">' +
        '<header class="deck-section__head">' +
          '<span class="deck-section__title">Strutture</span>' +
          '<span class="deck-section__sub">' + builtIds.length + ' tipi · ' +
            (colony.queue ? colony.queue.length : 0) + ' in coda</span>' +
        '</header>';

      if (!builtIds.length) {
        html += '<p class="deck-section__empty">Nessuna struttura ancora. Usa la sidebar per costruire la prima.</p>';
        html += '<div class="deck-structures__hint">' +
          '<button type="button" class="btn btn--mini" data-deck-action="open-tab" data-tab="strutture">' +
          '→ Vai a costruzione' +
          '</button></div>';
        html += '</section>';
        return html;
      }

      html += '<ul class="deck-struct-list">';
      builtIds.forEach(function (id) {
        const def = S.get(id);
        if (!def) return;
        const ent = colony.structures[id];
        const lvl = ent.level || 1;
        const maxL = def.maxLevel || 1;
        const isMax = lvl >= maxL;
        const inQueue = (colony.queue || []).find(function (q) { return q.id === id; });
        const catCls = ' deck-cat--' + def.cat;

        // Pip livelli (max 5)
        let pips = '';
        const pipMax = Math.min(maxL, 5);
        for (let i = 0; i < pipMax; i++) {
          pips += '<span class="deck-pip' + (i < lvl ? ' is-on' : '') + '"></span>';
        }

        let action;
        if (inQueue) {
          const total = inQueue.totalTime || inQueue.duration || (def.time || 1);
          const remain = Math.max(0, inQueue.duration | 0);
          const pct = Math.round(((total - remain) / total) * 100);
          action =
            '<div class="deck-struct__progress" title="In costruzione · ' + remain + '/' + total + ' Ι">' +
              '<div class="deck-struct__progress-fill" style="width:' + pct + '%"></div>' +
            '</div>';
        } else if (isMax) {
          action = '<span class="deck-struct__max" title="Livello massimo (' + maxL + ')">max</span>';
        } else {
          const check = ORION.planet.canBuild(colony, planet, id);
          const nextCost = S.stepCost(def, lvl + 1);
          const nextTime = S.stepTime(def, lvl + 1);
          const costStr = Object.keys(nextCost).map(function (k) {
            return '<span class="deck-cost-item">' + RES_GLYPH[k] + nextCost[k] + '</span>';
          }).join('');
          const enabled = check.ok;
          const reason = enabled ? ('Espandi a ×' + (lvl + 1) + ' · ' + nextTime + ' Ι') : check.reason;
          action =
            '<button type="button" class="deck-struct__expand' + (enabled ? '' : ' is-locked') + '" ' +
              'data-deck-action="expand" data-id="' + id + '" title="' + escapeHtml(reason) + '" ' +
              (enabled ? '' : 'disabled ') + '>' +
              '<span class="deck-struct__expand-plus">+</span>' +
              '<span class="deck-struct__expand-cost">' + costStr + '</span>' +
            '</button>';
        }

        html +=
          '<li class="deck-struct' + catCls + (inQueue ? ' is-busy' : '') + '">' +
            '<button type="button" class="deck-struct__info" data-deck-action="info" data-id="' + id + '" title="Cosa fa, bonus, concatenazioni">ⓘ</button>' +
            '<span class="deck-struct__glyph">' + def.glyph + '</span>' +
            '<div class="deck-struct__main">' +
              '<div class="deck-struct__name">' + escapeHtml(def.name) +
                ' <span class="deck-struct__lvl">×' + lvl + '</span>' +
              '</div>' +
              '<div class="deck-struct__pips">' + pips + '</div>' +
            '</div>' +
            action +
          '</li>';
      });
      html += '</ul></section>';
      return html;
    }

    /* Coda di costruzione (destra) — bottone "×" annulla. */
    _renderQueue() {
      const colony = this.colony;
      const queue = colony.queue || [];
      const S = ORION.structures;

      let html = '<aside class="deck-queue" aria-label="Coda di costruzione">' +
        '<header class="deck-section__head">' +
          '<span class="deck-section__title">Coda</span>' +
          '<span class="deck-section__sub">' + queue.length + '</span>' +
        '</header>';

      if (!queue.length) {
        html += '<p class="deck-section__empty">Nessun progetto in coda.</p>';
        html += '</aside>';
        return html;
      }

      html += '<ul class="deck-queue-list">';
      queue.forEach(function (q, idx) {
        const def = S.get(q.id);
        if (!def) return;
        const isDemo = q.target === 'demolish';
        const total = q.totalTime || (isDemo ? Math.max(1, Math.round((def.time || 2) / 2)) : (def.time || 1));
        const remain = Math.max(0, q.duration | 0);
        const pct = Math.round(((total - remain) / total) * 100);
        const label = isDemo ? ('Smantellamento di ' + def.name) : def.name;
        const cancelTitle = isDemo ? 'Annulla smantellamento' : 'Annulla (rimborso 80%)';
        html +=
          '<li class="deck-queue-item' + (isDemo ? ' is-demolish' : '') + '">' +
            '<span class="deck-queue-item__glyph">' + def.glyph + '</span>' +
            '<div class="deck-queue-item__main">' +
              '<div class="deck-queue-item__name">' + escapeHtml(label) +
                ' <span class="deck-queue-item__cd">' + remain + '/' + total + ' Ι</span>' +
              '</div>' +
              '<div class="deck-queue-item__bar"><div class="deck-queue-item__fill" style="width:' + pct + '%"></div></div>' +
            '</div>' +
            '<button type="button" class="deck-queue-item__cancel" data-deck-action="cancel" data-idx="' + idx + '" title="' + cancelTitle + '">×</button>' +
          '</li>';
      });
      html += '</ul></aside>';
      return html;
    }

    /* Chip classi popolazione (sopra il footer). */
    _renderPopulation() {
      const colony = this.colony, planet = this.planet;
      const pop = colony.pop;
      if (!pop) return '';
      const total = pop.total || 0;
      const cap = pop.cap || 0;
      const peopleNow = ORION.planet.peopleAt(total + (pop.accum || 0), planet);
      const peopleCap = ORION.planet.peopleAt(cap, planet);
      const pctCap = cap > 0 ? Math.min(100, Math.round(total * 100 / cap)) : 0;

      let chips = '<div class="deck-pop__chips">';
      CLASS_ORDER.forEach(function (k) {
        const v = pop.classes ? (pop.classes[k] || 0) : 0;
        const pct = total > 0 ? Math.round(v * 100 / total) : 0;
        chips += '<span class="deck-pop__chip class--' + k + '" title="' + CLASS_LABEL[k] + ' · ' + pct + '%">' +
          '<span class="deck-pop__chip-label">' + CLASS_LABEL[k].slice(0, 3) + '</span>' +
          '<span class="deck-pop__chip-pct">' + pct + '%</span>' +
        '</span>';
      });
      chips += '</div>';

      return '<section class="deck-population" aria-label="Popolazione">' +
        '<header class="deck-section__head">' +
          '<span class="deck-section__title">Popolazione</span>' +
          '<span class="deck-section__sub">' +
            ORION.planet.formatPeople(peopleNow) +
            ' / ' + ORION.planet.formatPeople(peopleCap) +
            ' (' + pctCap + '%)' +
          '</span>' +
        '</header>' +
        chips +
      '</section>';
    }

    /* Footer: ultime voci della cronaca che riguardano questa colonia. */
    _renderFooter() {
      const planet = this.planet;
      const game = ORION.game;
      const chron = (game && game.chronicle) || [];
      // Filtro semplice per nome pianeta (il payload chronicle è HTML).
      const needle = planet.name;
      const matches = [];
      /* game.chronicle è unshift-ato (entry 0 = più recente). */
      for (let i = 0; i < chron.length && matches.length < 3; i++) {
        const entry = chron[i];
        const text = entry && entry.html ? entry.html : '';
        if (text.indexOf(needle) >= 0) matches.push(text);
      }
      let inner;
      if (!matches.length) {
        inner = '<p class="deck-section__empty">Nessuna voce recente per questa colonia.</p>';
      } else {
        inner = '<ul class="deck-footer-log">' +
          matches.map(function (h) { return '<li>' + h + '</li>'; }).join('') +
          '</ul>';
      }
      return '<footer class="deck-footer" aria-label="Cronaca colonia">' +
        '<header class="deck-section__head">' +
          '<span class="deck-section__title">Cronaca</span>' +
        '</header>' +
        inner +
      '</footer>';
    }

    /* ----- eventi -------------------------------------------------- */

    _onClick(e) {
      const t = e.target.closest('[data-deck-action]');
      if (!t || !this.host.contains(t)) return;
      const action = t.dataset.deckAction;
      e.preventDefault();
      e.stopPropagation();
      if (action === 'expand' && this.opts.onBuild) {
        this.opts.onBuild(t.dataset.id);
      } else if (action === 'cancel' && this.opts.onCancel) {
        this.opts.onCancel(Number(t.dataset.idx));
      } else if (action === 'info' && this.opts.onInfo) {
        this.opts.onInfo(t.dataset.id);
      } else if (action === 'open-tab' && this.opts.onOpenTab) {
        this.opts.onOpenTab(t.dataset.tab);
      }
    }
  }

  ORION.ColonyDeck = ColonyDeck;
})(typeof window !== 'undefined' ? window : this);
