/* =====================================================================
   ORION EMPIRES — colony-deck.js
   Modulo M07.2 (decisione #44): "Plancia di Colonia".

   Overlay DOM montato come sibling del .planet-holder quando il livello
   attivo è Pianeta E il corpo è colonizzato. La sfera bakata di
   planet-view.js resta come sfondo evocativo; sopra, widget a cardinali
   (top-bar / risorse / strutture / coda / popolazione / cronaca) per dare
   al *centro* il colpo d'occhio che oggi vive solo nella sidebar.

   Principi (decisione #44):
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
  /* Categorie strutture per tab + label breve (UI_GUIDE §4 parola
     abbreviata sui tab, non sigla 3-lettere, vedi anti-pattern). */
  const CAT_LABEL = {
    'estrattiva':  'Estr.',
    'produttiva':  'Prod.',
    'militare':    'Mil.',
    'civile':      'Civ.',
    'ricerca':     'Ric.',
    'avanzata':    'Av.'
  };
  const CAT_ORDER = ['estrattiva', 'produttiva', 'militare', 'civile', 'ricerca', 'avanzata'];

  /* Label abbreviate per le card strutture compatte (M07.2 iter 3,
     UI_GUIDE §4 — sigla solo dove l'utente esperto basta + tooltip
     parola piena al hover sul title della <li>). */
  const SHORT_LABEL = {
    'miniera': 'Miniera',
    'centrale-solare': 'Centrale',
    'impianto-idrico': 'Imp. idr.',
    'fattoria': 'Fattoria',
    'fonderia': 'Fonderia',
    'raffineria': 'Raffineria',
    'laboratorio': 'Laborat.',
    'osservatorio': 'Osservat.',
    'cantiere-navale': 'Hangar',
    'accademia-militare': 'Accademia',
    'batteria-difesa': 'Batteria',
    'scudo-planetario': 'Scudo',
    'centro-abitativo': 'Abitativo',
    'ospedale': 'Ospedale',
    'mercato': 'Mercato',
    'impianto-riciclo': 'Riciclo',
    'impianto-esotico': 'Imp. esot.',
    'centro-ingegneria-planetaria': 'Ingegn.',
    'terraformatori': 'Terraf.'
  };

  const escapeHtml = root.ORION.util.escapeHtml;

  const fmtNum = root.ORION.format.compact;
  const fmtRate = root.ORION.format.rateShort;

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

      /* M07.2 polish (decisione #44): nome pianeta + tipo + chip fase
         vivono ora nella breadcrumb estesa (renderPlanetBreadcrumb in
         main.js). Niente più _renderTopBar() qui, per non duplicare. */
      const html =
        '<div class="deck-grid">' +
          this._renderResources() +
          this._renderStructures() +
          this._renderQueue() +
          this._renderPopulation() +
          this._renderFooter() +
        '</div>';
      this.host.innerHTML = html;
      if (typeof ORION.ensurePopAnim === 'function') ORION.ensurePopAnim();
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

    /* PR-M: status cards in fondo alla colonna risorse (sx) — stesso
       stile delle .deck-res, così non rubano riga in alto al pianeta.
       Esposte da tablet in su (≥768px); su mobile collassano col resto
       della grid mobile. Ogni card: glyph + label + valore principale +
       sub (barra mini o ratio). */
    _renderStatusCards() {
      const colony = this.colony, planet = this.planet;
      const game = ORION.game;
      if (!planet || !colony || !game) return '';
      const icon = (name) => (ORION.icon ? ORION.icon(name) : '');
      /* Glyph SVG nel pattern .deck-res__icon — span con ui-icon class
         così eredita il glow morbido UI_GUIDE §3. */
      const glyph = (name) =>
        '<span class="ui-icon" aria-hidden="true">' + icon(name) + '</span>';

      const cards = [];

      /* === Slot: usati / cap (decisione #45) === */
      const S = ORION.structures;
      let slotsUsed = 0;
      Object.keys(colony.structures).forEach(function (id) {
        const def = S && S.get(id);
        if (def) slotsUsed += S.slotFootprint(def, colony.structures[id].level || 1);
      });
      const slotsCap = ORION.planet.effectiveSlots
        ? ORION.planet.effectiveSlots(planet, colony, game)
        : (planet.slots || 0);
      const slotsPct = slotsCap > 0 ? Math.min(100, Math.round(slotsUsed * 100 / slotsCap)) : 0;
      const slotsStateCls = slotsPct >= 95 ? ' is-crit' : slotsPct >= 80 ? ' is-low' : '';
      cards.push(
        '<div class="deck-res deck-status-card deck-status-card--slot' + slotsStateCls + '" title="Slot occupati / capacità planetaria">' +
          '<div class="deck-res__head">' +
            glyph('build') +
            '<span class="deck-res__label">Slot</span>' +
          '</div>' +
          '<div class="deck-res__value">' + slotsUsed + ' / ' + slotsCap + '</div>' +
          '<div class="deck-status-card__bar"><i style="width:' + slotsPct + '%"></i></div>' +
        '</div>'
      );

      /* === Rifiuti (decisione #48): stato + saturazione === */
      const waste = colony.waste;
      if (waste && waste.capacity > 0) {
        const sat = Math.round((waste.saturation || 0) * 100);
        const st = waste.state || 'ok';
        const wStateCls = st === 'crit' ? ' is-crit' : st === 'saturo' ? ' is-low' : '';
        const wLabel = st === 'crit' ? 'critico' : st === 'saturo' ? 'saturo' : 'ok';
        cards.push(
          '<div class="deck-res deck-status-card deck-status-card--waste' + wStateCls + '" title="Rifiuti — ' + waste.stock + ' / ' + waste.capacity + '">' +
            '<div class="deck-res__head">' +
              glyph('refresh') +
              '<span class="deck-res__label">Rifiuti</span>' +
            '</div>' +
            '<div class="deck-res__value">' + wLabel + '</div>' +
            '<div class="deck-status-card__bar"><i style="width:' + Math.min(100, sat) + '%"></i></div>' +
          '</div>'
        );
      }

      /* === Capitale / Pianeta base (decisione #45 / #8) === */
      const capKey = this.body ? planet.systemId + ':' + this.body.key : null;
      const isCap = capKey && ORION.capital && ORION.capital.isCapital
        ? ORION.capital.isCapital(game, capKey)
        : false;
      if (isCap) {
        cards.push(
          '<div class="deck-res deck-status-card deck-status-card--capital" title="Capitale di gruppo — bonus +15% produzione, +10 slot riserva">' +
            '<div class="deck-res__head">' +
              glyph('star') +
              '<span class="deck-res__label">Capitale</span>' +
            '</div>' +
            '<div class="deck-res__value">+15%</div>' +
            '<div class="deck-res__rate">prod · +10 slot</div>' +
          '</div>'
        );
      } else if (colony.isHomeBase) {
        cards.push(
          '<div class="deck-res deck-status-card deck-status-card--home" title="Pianeta base — bonus produzione iniziale (decisione #8)">' +
            '<div class="deck-res__head">' +
              glyph('star') +
              '<span class="deck-res__label">Pianeta base</span>' +
            '</div>' +
            '<div class="deck-res__value">+20%</div>' +
            '<div class="deck-res__rate">produzione</div>' +
          '</div>'
        );
      }

      /* === Morale d'impero (warState M09) === */
      const ws = game.warState;
      if (ws && typeof ws.morale === 'number') {
        const mor = Math.round(ws.morale * 100);
        const mStateCls = mor < 70 ? ' is-crit' : mor < 90 ? ' is-low' : '';
        cards.push(
          '<div class="deck-res deck-status-card deck-status-card--morale' + mStateCls + '" title="Morale d\'impero — sotto pressione cala con perdite belliche">' +
            '<div class="deck-res__head">' +
              glyph('forces') +
              '<span class="deck-res__label">Morale</span>' +
            '</div>' +
            '<div class="deck-res__value">' + mor + '%</div>' +
            '<div class="deck-status-card__bar"><i style="width:' + mor + '%"></i></div>' +
          '</div>'
        );
      }

      return cards.join('');
    }

    /* Card risorse XXL (colonna sinistra). */
    _renderResources() {
      const colony = this.colony, planet = this.planet;
      const out = ORION.planet.structureOutput(colony, planet, ORION.game);
      const scar = colony._scar;
      const keys = ['met', 'en', 'food', 'water'];
      /* Decisione #45: pop drena cibo/acqua dallo stock. Il saldo visualizzato
         deve includere il drenaggio, altrimenti vedi "+4 / Ι" ma lo stock cala.
         I tassi mostrati sono la PRODUZIONE REALE: productionFactors applica i
         malus temporanei del tick (Insediamento ×0.5, scarsità, rifiuti, guerra). */
      const pf = (ORION.time && ORION.time.productionFactors)
        ? ORION.time.productionFactors(ORION.game, colony)
        : { prodMul: 1, popFood: 0, popWater: 0, crewFood: 0, crewWater: 0 };
      /* Flusso rotte commerciali nel saldo (decisione utente 2026-06-15):
         + in entrata, − in uscita. */
      const colKey = colony.systemId + ':' + colony.bodyKey;
      const tradeNet = (ORION.trade && ORION.trade.colonyTradeFlow)
        ? ORION.trade.colonyTradeFlow(ORION.game, colKey)
        : { met: 0, en: 0, food: 0, water: 0 };
      /* Surplus estrattivo da anomalie/cinture/nebulose (richiesta utente
         2026-06-20): le flotte in raccolta versano il bottino sulla colonia
         d'origine, non sulla più vicina. Lo includiamo nel saldo e lo
         mostriamo come chip esplicito così è chiaro DA DOVE viene. */
      const anomFlow = (ORION.anomaly && ORION.anomaly.harvestByColony)
        ? (ORION.anomaly.harvestByColony(ORION.game)[colKey] || null)
        : null;
      const anomMet = anomFlow ? anomFlow.met : 0;
      const anomEn  = anomFlow ? anomFlow.en  : 0;

      let html = '<aside class="deck-resources" aria-label="Risorse della colonia">';
      keys.forEach(function (k) {
        const stock = colony.stock[k] || 0;
        const popDrain = k === 'food' ? pf.popFood : k === 'water' ? pf.popWater : 0;
        const crewDrain = k === 'food' ? (pf.crewFood || 0) : k === 'water' ? (pf.crewWater || 0) : 0;
        const anomBonus = k === 'met' ? anomMet : k === 'en' ? anomEn : 0;
        const net = (out.rates[k] || 0) * pf.prodMul - (out.upkeep[k] || 0) - popDrain - crewDrain + (tradeNet[k] || 0) + anomBonus;
        const state = scar && scar[k] ? scar[k].state : 'ok';
        const stateCls = state === 'crit' ? ' is-crit' : state === 'low' ? ' is-low' : '';
        const stateLabel = state === 'crit' ? 'critica' : state === 'low' ? 'allerta' : 'ok';
        const netCls = net > 0.01 ? 'is-pos' : net < -0.01 ? 'is-neg' : '';
        const anomChip = anomBonus > 0
          ? '<span class="deck-res__anom" title="Surplus da flotte in raccolta su anomalie">✦ +' + (Math.round(anomBonus * 10) / 10) + '/Ι</span>'
          : '';
        html +=
          '<div class="deck-res' + stateCls + '" data-res="' + k + '" title="' + RES_LABEL[k] + ' · ' + stateLabel + '">' +
            '<div class="deck-res__head">' +
              '<span class="deck-res__icon" aria-hidden="true">' + RES_GLYPH[k] + '</span>' +
              '<span class="deck-res__label">' + RES_LABEL[k] + '</span>' +
            '</div>' +
            '<div class="deck-res__value">' + fmtNum(stock) + '</div>' +
            '<div class="deck-res__rate ' + netCls + '">' + fmtRate(net) + ' / Ι</div>' +
            anomChip +
          '</div>';
      });
      /* PR-M: status cards (slot/rifiuti/capitale/morale) sotto le 4 res
         card, stesso pattern .deck-res per coerenza visiva. */
      html += this._renderStatusCards();
      html += '</aside>';
      return html;
    }

    /* Strutture costruite — entry-point per "+Espandi" e "Smantella".
       (Costruire nuovi tipi resta solo in sidebar — decisione #44.)
       PR-A: tab categoria + filtro (estrattiva/produttiva/militare/...). */
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

      /* Conteggio per categoria + render tab */
      const byCat = { all: builtIds.length };
      builtIds.forEach(function (id) {
        const def = S.get(id);
        if (!def) return;
        byCat[def.cat] = (byCat[def.cat] || 0) + 1;
      });
      /* Stato filtro: memorizzato in ORION.deckCatFilter (in-memory, non
         persistito — è preferenza UI volatile per la sessione corrente). */
      const filter = ORION.deckCatFilter || 'all';
      const activeFilter = byCat[filter] ? filter : 'all';

      let tabs = '<div class="deck-struct-tabs" role="tablist">' +
        '<button class="deck-struct-tab' + (activeFilter === 'all' ? ' is-active' : '') + '" ' +
          'data-deck-action="filter-cat" data-cat="all" type="button" role="tab">' +
          'Tutte <span class="deck-struct-tab__count">' + builtIds.length + '</span>' +
        '</button>';
      CAT_ORDER.forEach(function (cat) {
        if (!byCat[cat]) return;
        const isAct = activeFilter === cat;
        tabs += '<button class="deck-struct-tab' + (isAct ? ' is-active' : '') + '" ' +
          'data-deck-action="filter-cat" data-cat="' + cat + '" type="button" role="tab">' +
          (CAT_LABEL[cat] || cat) +
          ' <span class="deck-struct-tab__count">' + byCat[cat] + '</span>' +
        '</button>';
      });
      tabs += '</div>';
      html += tabs;

      /* Filtro ID per categoria scelta */
      const filtered = (activeFilter === 'all') ? builtIds : builtIds.filter(function (id) {
        const def = S.get(id);
        return def && def.cat === activeFilter;
      });

      html += '<ul class="deck-struct-list">';
      filtered.forEach(function (id) {
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
          const check = ORION.planet.canBuild(colony, planet, id, ORION.game);
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

        const shortName = SHORT_LABEL[id] || def.name;
        /* PR-G: ⓘ inline in alto a destra della card invece che assoluto
           (con padding-top dedicato) — risparmia una riga visiva. */
        html +=
          '<li class="deck-struct' + catCls + (inQueue ? ' is-busy' : '') + '" title="' + escapeHtml(def.name) + '">' +
            '<div class="deck-struct__top">' +
              '<span class="deck-struct__glyph">' + def.glyph + '</span>' +
              '<span class="deck-struct__name">' + escapeHtml(shortName) + '</span>' +
              '<span class="deck-struct__lvl">×' + lvl + '</span>' +
              '<button type="button" class="deck-struct__info ui-icon ui-icon--violet" data-deck-action="info" data-id="' + id + '" title="Cosa fa, bonus, concatenazioni" aria-label="Info">' +
                (ORION.icon ? ORION.icon('info') : 'ⓘ') +
              '</button>' +
            '</div>' +
            '<div class="deck-struct__bot">' +
              '<span class="deck-struct__pips">' + pips + '</span>' +
              action +
            '</div>' +
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
        /* Stesso pattern del pannello sidebar (main.js): se totalTime non è
           presente (save legacy), ricalcola da stepTime al livello giusto. */
        const fallbackTotal = isDemo
          ? Math.max(1, Math.round((def.time || 2) / 2))
          : (S.stepTime ? S.stepTime(def, q.toLevel || 1) : (def.time || 1));
        const total = q.totalTime || fallbackTotal;
        const remain = Math.max(0, Math.ceil(q.duration || 0));
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
      /* Refactor 2026-06-09: display LIVELLI invece di persone.
         Mostra "X.Y / Z" con animazione frazionaria fluida. */
      const unitsNow = ORION.planet.popUnits(colony) || 0;
      const dev = Math.round(ORION.planet.popMaturity(colony, planet) * 100);
      const numSpan = (typeof ORION.popAnimSpan === 'function')
        ? ORION.popAnimSpan('pop:' + colony.systemId + ':' + colony.bodyKey, unitsNow, { decimals: 1 })
        : escapeHtml(unitsNow.toFixed(1));

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

      /* Decisione #66 estensione (P1): chip ⚡ Diaspora se la colonia
         ha il bonus crescita ×2 attivo (post-imbarco coloni #66). */
      const game = ORION.game;
      const nowI = (game && game.timeImpulsi) || 0;
      const dia = colony.diaspora;
      const isDia = dia && dia.until > nowI;
      const diaChip = isDia
        ? '<span class="deck-pop__diaspora" title="Bonus Diaspora: crescita pop ×' + dia.multiplier + ' attiva, ' + (dia.until - nowI) + ' Ι rimanenti">⚡ Diaspora · ' + (dia.until - nowI) + ' Ι</span>'
        : '';

      /* Layout verticale per colonna stretta (M07.2 iter 3):
         label · livelli/cap · barra full-width · % sviluppo. */
      const totalHtml =
        '<div class="deck-pop__total" title="Livelli demografici · sviluppo ' + dev + '% verso il cap del pianeta">' +
          '<div class="deck-pop__total-row">' +
            '<span class="deck-pop__total-label">Popolazione' + diaChip + '</span>' +
            '<span class="deck-pop__total-pct">' + dev + '%</span>' +
          '</div>' +
          '<span class="deck-pop__total-num">' +
            numSpan +
            '<span class="sep">/</span>' +
            '<span class="cap">' + escapeHtml(String(cap)) + '</span>' +
          '</span>' +
          '<div class="deck-pop__bar"><div class="deck-pop__bar-fill" style="width:' + dev + '%"></div></div>' +
        '</div>';

      return '<section class="deck-population" aria-label="Popolazione">' +
        totalHtml +
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
      /* Cronaca collassabile (header cliccabile). Default: aperta su desktop,
         chiusa su mobile (≤760) — lì il deck è solo colpo d'occhio. Stato
         volatile in ORION.deckCronOpen (tri-stato: undefined = auto). */
      const wide = (typeof window !== 'undefined') && window.innerWidth > 760;
      const isOpen = (ORION.deckCronOpen === undefined) ? wide : !!ORION.deckCronOpen;
      const icon = (ORION.icon && ORION.icon('chronicle')) || '';
      return '<footer class="deck-footer' + (isOpen ? '' : ' is-collapsed') + '" aria-label="Cronaca colonia">' +
        '<button type="button" class="deck-section__head deck-cron-toggle" data-deck-action="toggle-cron" aria-expanded="' + isOpen + '">' +
          '<span class="deck-cron-icon ui-icon" aria-hidden="true">' + icon + '</span>' +
          '<span class="deck-section__title">Cronaca</span>' +
          '<span class="deck-cron-caret" aria-hidden="true">' + (isOpen ? '▾' : '▸') + '</span>' +
        '</button>' +
        (isOpen ? inner : '') +
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
      } else if (action === 'filter-cat') {
        ORION.deckCatFilter = t.dataset.cat;
        this._render();
      } else if (action === 'toggle-cron') {
        const wide = (typeof window !== 'undefined') && window.innerWidth > 760;
        const cur = (ORION.deckCronOpen === undefined) ? wide : !!ORION.deckCronOpen;
        ORION.deckCronOpen = !cur;
        this._render();
      }
    }
  }

  ORION.ColonyDeck = ColonyDeck;
})(typeof window !== 'undefined' ? window : this);
