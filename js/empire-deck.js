/* =====================================================================
   ORION EMPIRES — empire-deck.js
   Modulo M07.3 (decisione #62): "Dashboard Impero".

   Overlay DOM montato come sibling del .galaxy-holder quando il livello
   attivo è Galassia/Gruppo (mappa visibile, nessun sistema/pianeta
   aperto). Risolve il "centro freddo" segnalato dall'utente: navigando
   in galassia le info delle colonie vivono solo nella Plancia Operativa
   dx (una alla volta). Con 5+ colonie serve un colpo d'occhio.

   Principi (coerenti con la Plancia di Colonia, decisione #44):
     - È puro VIEW: riceve `state = { cards, summary }` già calcolato da
       main.js (controller) e lo renderizza. Niente accesso al motore,
       niente RNG, niente stato persistito (telemetria volatile in main.js).
     - Vanilla JS / no framework / no CDN / no Canvas (DOM + SVG sparkline).
     - Click su card → focus mappa sul sistema (onFocus). Un chevron
       dedicato apre la scheda colonia (onOpen). Sincronia con la sidebar.

   API:
     - mount(host, state, opts)   monta il deck
     - refresh(state)             re-render senza re-mount
     - destroy()                  smonta listener + DOM
     opts: { onFocus(sysId), onOpen(colKey), onClose() }
     state.cards[] = {
       key, sysId, name, tag(html), badges(html),
       people, peopleStr, peopleCapStr, dev(0..100),
       morale(0..1), moraleState('ok'|'low'|'crit'),
       stockTotal, stockNet, scarState('ok'|'low'|'crit'),
       phaseLabel, spark:{ pop:[], morale:[], stock:[] }
     }
     state.summary = { colonies, fleets, popStr, totalsHtml }
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function icon(name) { return (ORION.icon && ORION.icon(name)) || ''; }

  /* Sparkline SVG normalizzata. `series` = array di numeri (più recente in
     coda). viewBox fisso 100×28 → la card lo scala a piacere via CSS.
     Determinismo: nessun RNG, pura proiezione min/max. */
  function sparkline(series, cls) {
    const n = series ? series.length : 0;
    if (n < 2) {
      return '<svg class="espark espark--' + cls + '" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">' +
        '<line class="espark__flat" x1="0" y1="14" x2="100" y2="14"/></svg>';
    }
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = series[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const range = (max - min) || 1;
    const stepX = 100 / (n - 1);
    let pts = '';
    for (let i = 0; i < n; i++) {
      const x = (i * stepX);
      // y invertito (0 = alto). Padding 3px sopra/sotto per non tagliare.
      const y = 25 - ((series[i] - min) / range) * 22;
      pts += (i ? ' ' : '') + x.toFixed(1) + ',' + y.toFixed(1);
    }
    // area + linea (riempimento morbido sotto la curva)
    const area = '0,28 ' + pts + ' 100,28';
    return '<svg class="espark espark--' + cls + '" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">' +
      '<polygon class="espark__area" points="' + area + '"/>' +
      '<polyline class="espark__line" points="' + pts + '"/>' +
    '</svg>';
  }

  class EmpireDeck {
    constructor() {
      this.host = null;
      this.state = null;
      this.opts = {};
      this._onClick = this._onClick.bind(this);
    }

    mount(host, state, opts) {
      this.host = host;
      this.state = state || { cards: [], summary: {} };
      this.opts = opts || {};
      host.classList.add('empire-deck');
      host.hidden = false;
      host.addEventListener('click', this._onClick);
      this._render();
      return this;
    }

    refresh(state) {
      if (state) this.state = state;
      this._render();
    }

    destroy() {
      if (this.host) {
        this.host.removeEventListener('click', this._onClick);
        this.host.innerHTML = '';
        this.host.classList.remove('empire-deck');
        this.host.hidden = true;
      }
      this.host = null;
      this.state = null;
    }

    _render() {
      if (!this.host) return;
      const cards = (this.state && this.state.cards) || [];
      const sum = (this.state && this.state.summary) || {};

      const header =
        '<header class="empire-deck__head">' +
          '<div class="empire-deck__title">' +
            '<span class="ui-icon ui-icon--amber empire-deck__title-icon" aria-hidden="true">' + icon('grid') + '</span>' +
            '<span>Dashboard Impero</span>' +
            '<span class="empire-deck__count">' + (sum.colonies || 0) + ' colonie</span>' +
          '</div>' +
          '<div class="empire-deck__totals">' + (sum.totalsHtml || '') + '</div>' +
          '<button type="button" class="empire-deck__close" data-edeck-action="close" title="Chiudi (mostra la mappa)" aria-label="Chiudi dashboard">' +
            '<span class="ui-icon" aria-hidden="true">' + icon('close') + '</span>' +
          '</button>' +
        '</header>';

      let body;
      if (!cards.length) {
        body = '<div class="empire-deck__empty">' +
          '<span class="ui-icon ui-icon--amber" aria-hidden="true">' + icon('roster') + '</span>' +
          '<p>Nessuna colonia operativa.</p>' +
          '<p class="empire-deck__empty-sub">Le tue colonie appariranno qui come griglia di colpo d\'occhio.</p>' +
        '</div>';
      } else {
        body = '<div class="empire-grid">' + cards.map(this._card, this).join('') + '</div>';
      }

      this.host.innerHTML = header + '<div class="empire-deck__scroll">' + body + '</div>';
    }

    _card(c) {
      const scarCls = c.scarState === 'crit' ? ' is-crit' : c.scarState === 'low' ? ' is-low' : '';
      const focusCls = c.focused ? ' is-focus' : '';
      const moraleCls = c.moraleState === 'crit' ? 'is-crit' : c.moraleState === 'low' ? 'is-low' : 'is-ok';
      const moralePct = Math.round((c.morale || 0) * 100);
      const netCls = c.stockNet > 0.01 ? 'is-pos' : c.stockNet < -0.01 ? 'is-neg' : '';
      const netStr = (c.stockNet > 0 ? '+' : c.stockNet < 0 ? '−' : '') +
        Math.abs(c.stockNet >= 10 ? Math.round(c.stockNet) : Math.round(c.stockNet * 10) / 10);

      return '<article class="ecard' + scarCls + focusCls + '" data-edeck-action="focus" data-sys="' + c.sysId + '" data-key="' + escapeHtml(c.key) + '" ' +
          'tabindex="0" role="button" title="Inquadra ' + escapeHtml(c.name) + ' sulla mappa">' +
        '<header class="ecard__head">' +
          '<span class="ecard__name"><strong>' + escapeHtml(c.name) + '</strong>' + (c.tag || '') + '</span>' +
          '<span class="ecard__badges">' + (c.badges || '') + '</span>' +
        '</header>' +
        (c.phaseLabel ? '<div class="ecard__phase">' + c.phaseLabel + '</div>' : '') +
        '<div class="ecard__metrics">' +
          /* Popolazione */
          '<div class="ecard__metric">' +
            '<div class="ecard__metric-head"><span class="ecard__metric-label">Popolaz.</span>' +
              '<span class="ecard__metric-val">' + escapeHtml(c.peopleStr) + '</span></div>' +
            sparkline(c.spark && c.spark.pop, 'pop') +
            '<div class="ecard__metric-sub">' + (c.dev | 0) + '% del tetto</div>' +
          '</div>' +
          /* Morale */
          '<div class="ecard__metric">' +
            '<div class="ecard__metric-head"><span class="ecard__metric-label">Morale</span>' +
              '<span class="ecard__metric-val ' + moraleCls + '">' + moralePct + '%</span></div>' +
            sparkline(c.spark && c.spark.morale, 'morale') +
            '<div class="ecard__metric-sub">&nbsp;</div>' +
          '</div>' +
          /* Risorse (stock totale) */
          '<div class="ecard__metric">' +
            '<div class="ecard__metric-head"><span class="ecard__metric-label">Scorte</span>' +
              '<span class="ecard__metric-val">' + escapeHtml(c.stockTotalStr) + '</span></div>' +
            sparkline(c.spark && c.spark.stock, 'stock') +
            '<div class="ecard__metric-sub ' + netCls + '">' + netStr + ' / Ι</div>' +
          '</div>' +
        '</div>' +
        '<button type="button" class="ecard__open" data-edeck-action="open" data-key="' + escapeHtml(c.key) + '" title="Apri la Plancia Operativa di ' + escapeHtml(c.name) + '">' +
          'Apri <span class="ui-icon" aria-hidden="true">' + icon('chevronRight') + '</span>' +
        '</button>' +
      '</article>';
    }

    _onClick(e) {
      const t = e.target.closest('[data-edeck-action]');
      if (!t || !this.host.contains(t)) return;
      const action = t.dataset.edeckAction;
      e.preventDefault();
      e.stopPropagation();
      if (action === 'close' && this.opts.onClose) {
        this.opts.onClose();
      } else if (action === 'open' && this.opts.onOpen) {
        this.opts.onOpen(t.dataset.key);
      } else if (action === 'focus' && this.opts.onFocus) {
        this.opts.onFocus(Number(t.dataset.sys), t.dataset.key);
      }
    }
  }

  ORION.EmpireDeck = EmpireDeck;
})(typeof window !== 'undefined' ? window : this);
