/* =====================================================================
   ORION EMPIRES — agreements.js
   Modulo M12 (Fase A2, slice 2): Commercio esterno con AI — accordi
   bilaterali (decisione #56/#53 §15.3).

   SCOPE (questo file):
     - ACCORDO bilaterale risorsa↔risorsa con una civiltà AI contattata:
       "do `flow` di X per Impulso, ricevo `flow×ratio` di Y" per `duration` Ι.
       Flusso passivo (no microgestione), coerente con le rotte interne (§15.2).
     - PREZZO a soglie discrete di Reputazione §14 (≥70 −15% / 50-69 0 /
       30-49 +10% / <30 +25% — dal punto di vista "quanto paghi": qui lo
       traduciamo in TERMINI ricevuti, rep alta = ricevi di più).
     - GATE diplomatico: accordi solo in pace/alleanza. Tregua = niente NUOVI
       (i vecchi proseguono). Guerra = sospensione automatica (riprende a pace).
     - Allineamento del partner modula leggermente i termini (Bene equo,
       Male gouger). Le risorse "vietate"/avanzate §7.2 → Fase B (qui solo
       le 4 base).

   Determinismo (#5/#22): zero Math.random. Accettazione = funzione pura di
   relazione+disposizione+reputazione. Il ratio è BLOCCATO alla stipula
   (proporzione P:Q fissa). Recovery-friendly: sospensione/interruzione mai
   distruttive, riprendono da sole; nessun saldo negativo.

   Faucet valuta regionale (§15.4): gancio leggero — completare scambi con
   una civiltà di una regione versa una piccola commissione nella valuta di
   quella regione (goodwill), se la Tesoreria è attiva.
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  const TRADE_RES = ['met', 'en', 'food', 'water'];

  const DURATION_DEFAULT = 500;   // Ι di validità di un accordo
  const FLOW_MIN = 1, FLOW_MAX = 20;
  const MAX_PER_CIV = 2;          // accordi simultanei per civiltà
  const COMMISSION = 0.02;        // valuta regionale per unità ricevuta (gancio §15.4)

  /* Spread di scambio (§15.3): la AI trattiene un margine. Lo spread è
     SEMPRE a sfavore del giocatore (≥ un floor > 0), ridotto dalla
     reputazione a soglie discrete e aumentato coi partner maligni. Modellato
     come spread — NON come bonus bilaterale — per evitare l'arbitraggio
     (un round-trip X→Y→X paga 2× lo spread, mai un guadagno). */
  function tradeSpread(game, civ) {
    let s = 0.12;
    const rep = (root.ORION.diplomacy ? root.ORION.diplomacy.reputation(game)
                 : (typeof game.reputation === 'number' ? game.reputation : 50));
    if (rep >= 70) s *= 0.6;
    else if (rep >= 50) s *= 1.0;
    else if (rep >= 30) s *= 1.3;
    else s *= 1.6;
    const al = civ && civ.alignment;
    if (al === 'bene') s *= 0.85;
    else if (al === 'male') s *= 1.2;
    /* M10 Fase B-2: una civ tecnologicamente superiore ha più leva
       contrattuale → spread leggermente peggiore; una arretrata, migliore.
       Effetto contenuto (±~7%) — il contrappeso al vantaggio tech è la
       loro massa militare ridotta, non il prezzo. */
    const AI = root.ORION.ai;
    if (AI && AI.techNorm) {
      const t = AI.techNorm(game, civ);   // 0..1
      s *= 1 + 0.15 * (t - 0.5);
    }
    return Math.max(0.03, Math.min(0.30, Math.round(s * 1000) / 1000));
  }

  function refPrice(res) {
    const T = root.ORION.treasury;
    if (T && T.REF_PRICE && T.REF_PRICE[res] != null) return T.REF_PRICE[res];
    /* Fallback se treasury non caricato. */
    return ({ met: 1.0, en: 0.9, food: 1.4, water: 1.2 })[res] || 1.0;
  }

  /* Ratio base = quanto Y ottieni per 1 X = REF(X)/REF(Y). */
  function baseRatio(giveRes, getRes) {
    return refPrice(giveRes) / refPrice(getRes);
  }
  /* Ratio effettivo (bloccato alla stipula) = ratio equo × (1 − spread).
     Ricevi sempre un po' meno del "giusto" REF: lo spread è il margine AI. */
  function termsRatio(game, civ, giveRes, getRes) {
    const r = baseRatio(giveRes, getRes) * (1 - tradeSpread(game, civ));
    return Math.round(r * 1000) / 1000;
  }

  function ensure(game) {
    if (!game) return;
    if (!Array.isArray(game.tradeAgreements)) game.tradeAgreements = [];
  }

  function relationOf(game, civ) {
    const D = root.ORION.diplomacy;
    if (D && D.effectiveRelation) return D.effectiveRelation(game, civ);
    return civ && civ.relation ? civ.relation : 'peace';
  }
  function civById(game, civId) {
    const civs = game.civs || [];
    for (let i = 0; i < civs.length; i++) if (civs[i].id === civId) return civs[i];
    return null;
  }

  /* ------------------------------------------------------------------
     Accettazione (deterministica). Gate diplomatico + soglie.
     ------------------------------------------------------------------ */
  function evaluateAccept(game, civ) {
    if (!civ || !civ.alive) return { ok: false, reason: 'Civiltà non disponibile' };
    const rel = relationOf(game, civ);
    if (rel === 'war') return { ok: false, reason: 'In guerra — niente commercio' };
    if (rel === 'truce') return { ok: false, reason: 'Tregua — nessun nuovo accordo' };
    /* Alleanza: accetta sempre. */
    if (rel === 'alliance') return { ok: true, likelihood: 'certa' };
    /* Pace: serve disposizione/reputazione minime. */
    const disp = civ.disposition || 0;
    const rep = (root.ORION.diplomacy ? root.ORION.diplomacy.reputation(game)
                 : (typeof game.reputation === 'number' ? game.reputation : 50));
    if (disp >= 10 || rep >= 55) return { ok: true, likelihood: 'probabile' };
    if (disp >= -15 && rep >= 35) return { ok: true, likelihood: 'incerta' };
    return { ok: false, reason: 'Disposizione/reputazione troppo basse' };
  }

  function agreementsFor(game, civId) {
    ensure(game);
    return game.tradeAgreements.filter(function (a) { return a.civId === civId; });
  }
  function agreementsForColony(game, colonyKey) {
    ensure(game);
    return game.tradeAgreements.filter(function (a) { return a.colonyKey === colonyKey; });
  }

  function canPropose(game, civId, colonyKey, giveRes, getRes, flow) {
    ensure(game);
    const civ = civById(game, civId);
    if (!civ) return { ok: false, reason: 'Civiltà inesistente' };
    const colony = game.colonies && game.colonies[colonyKey];
    if (!colony || !colony.colonized) return { ok: false, reason: 'Colonia non operativa' };
    if (TRADE_RES.indexOf(giveRes) < 0 || TRADE_RES.indexOf(getRes) < 0) {
      return { ok: false, reason: 'Risorsa non commerciabile' };
    }
    if (giveRes === getRes) return { ok: false, reason: 'Risorse uguali' };
    flow = Math.round(flow || 0);
    if (flow < FLOW_MIN || flow > FLOW_MAX) return { ok: false, reason: 'Flusso fuori range (' + FLOW_MIN + '–' + FLOW_MAX + ')' };
    if (agreementsFor(game, civId).length >= MAX_PER_CIV) {
      return { ok: false, reason: 'Massimo ' + MAX_PER_CIV + ' accordi con questa civiltà' };
    }
    /* Niente duplicati esatti. */
    const dup = game.tradeAgreements.some(function (a) {
      return a.civId === civId && a.colonyKey === colonyKey && a.giveRes === giveRes && a.getRes === getRes;
    });
    if (dup) return { ok: false, reason: 'Accordo identico già attivo' };
    const verdict = evaluateAccept(game, civ);
    if (!verdict.ok) return verdict;
    return { ok: true, likelihood: verdict.likelihood, civ: civ };
  }

  let _agrCounter = 0;
  function nextId(game) { _agrCounter++; return 'agr-' + ((game && game.timeImpulsi) || 0) + '-' + _agrCounter; }

  function propose(game, civId, colonyKey, giveRes, getRes, flow, duration) {
    const chk = canPropose(game, civId, colonyKey, giveRes, getRes, flow);
    if (!chk.ok) return chk;
    const civ = chk.civ;
    flow = Math.round(flow);
    const ratio = termsRatio(game, civ, giveRes, getRes);
    const agr = {
      id: nextId(game),
      civId: civId,
      colonyKey: colonyKey,
      giveRes: giveRes, getRes: getRes,
      flow: flow,
      ratio: ratio,
      duration: Math.max(1, duration || DURATION_DEFAULT),
      startedAt: game.timeImpulsi || 0,
      status: 'active',          // active | suspended (guerra) | interrupted (stock)
      delivered: 0
    };
    game.tradeAgreements.push(agr);
    return { ok: true, agreement: agr };
  }

  function findAgreement(game, id) {
    ensure(game);
    for (let i = 0; i < game.tradeAgreements.length; i++) if (game.tradeAgreements[i].id === id) return game.tradeAgreements[i];
    return null;
  }
  function cancel(game, id) {
    ensure(game);
    const idx = game.tradeAgreements.indexOf(findAgreement(game, id));
    if (idx < 0) return { ok: false, reason: 'Accordo inesistente' };
    game.tradeAgreements.splice(idx, 1);
    return { ok: true };
  }

  /* ------------------------------------------------------------------
     process — 1 Impulso. Flusso passivo + durata + sospensioni.
     ------------------------------------------------------------------ */
  function process(game, events) {
    ensure(game);
    const arr = game.tradeAgreements;
    if (!arr.length) return;
    /* Ordine deterministico per id. */
    const ordered = arr.slice().sort(function (a, b) { return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0); });
    for (let i = 0; i < ordered.length; i++) {
      const agr = ordered[i];
      const civ = civById(game, agr.civId);
      const colony = game.colonies && game.colonies[agr.colonyKey];

      /* Pulizia: civiltà caduta o colonia persa → chiudi. */
      if (!civ || !civ.alive || !colony || !colony.colonized) {
        endAgreement(game, agr, events, 'broken');
        continue;
      }
      const rel = relationOf(game, civ);
      /* Guerra/tregua → sospeso (la tregua congela i NUOVI; i vecchi
         restano ma non fluiscono finché non torna pace, scelta prudente). */
      if (rel === 'war' || rel === 'truce') {
        setStatus(agr, 'suspended', events, game);
        agr.duration--;
        if (agr.duration <= 0) endAgreement(game, agr, events, 'expired');
        continue;
      }
      /* Stock insufficiente alla sorgente → interrotto (riprende da solo). */
      const avail = colony.stock ? (colony.stock[agr.giveRes] || 0) : 0;
      if (avail < agr.flow) {
        setStatus(agr, 'interrupted', events, game);
        agr.duration--;
        if (agr.duration <= 0) endAgreement(game, agr, events, 'expired');
        continue;
      }
      /* Riprende se era sospeso/interrotto. */
      if (agr.status !== 'active') {
        agr.status = 'active';
        events.push({ kind: 'agreement-resumed', agrId: agr.id, civId: agr.civId, impulso: game.timeImpulsi });
      }
      /* Scambio. */
      const getQty = Math.round(agr.flow * agr.ratio * 100) / 100;
      colony.stock[agr.giveRes] = Math.round(((colony.stock[agr.giveRes] || 0) - agr.flow) * 100) / 100;
      colony.stock[agr.getRes] = Math.round(((colony.stock[agr.getRes] || 0) + getQty) * 100) / 100;
      agr.delivered = (agr.delivered || 0) + getQty;
      /* Gancio §15.4: piccola commissione nella valuta della regione della
         civiltà (goodwill commerciale). */
      grantCommission(game, civ, getQty);

      agr.duration--;
      if (agr.duration <= 0) endAgreement(game, agr, events, 'expired');
    }
  }

  function setStatus(agr, status, events, game) {
    if (agr.status === status) return;
    agr.status = status;
    events.push({ kind: 'agreement-suspended', agrId: agr.id, civId: agr.civId, reason: status, impulso: game.timeImpulsi });
  }
  function endAgreement(game, agr, events, reason) {
    const idx = game.tradeAgreements.indexOf(agr);
    if (idx >= 0) game.tradeAgreements.splice(idx, 1);
    events.push({ kind: 'agreement-ended', agrId: agr.id, civId: agr.civId, reason: reason, impulso: game.timeImpulsi });
  }

  /* Commissione in valuta regionale (gancio §15.4). Versa COMMISSION × getQty
     nella valuta della regione di sede della civiltà partner. */
  function grantCommission(game, civ, getQty) {
    const T = root.ORION.treasury;
    if (!T || !T.addBalance || !T.clusterOfSystem) return;
    const sys = (civ.systems && civ.systems.length) ? civ.systems[0] : null;
    if (sys == null) return;
    const cluster = T.clusterOfSystem(game, sys);
    if (cluster == null) return;
    T.addBalance(game, cluster, Math.round(getQty * COMMISSION * 100) / 100);
  }

  /* Durata minima residua (per nextEventImpulsi: fermarsi a fine accordo). */
  function minDuration(game) {
    ensure(game);
    let min = Infinity;
    game.tradeAgreements.forEach(function (a) {
      if ((a.duration || 0) > 0 && a.duration < min) min = a.duration;
    });
    return isFinite(min) ? min : Infinity;
  }

  ORION.agreements = {
    TRADE_RES: TRADE_RES,
    DURATION_DEFAULT: DURATION_DEFAULT,
    FLOW_MIN: FLOW_MIN,
    FLOW_MAX: FLOW_MAX,
    MAX_PER_CIV: MAX_PER_CIV,
    tradeSpread: tradeSpread,
    baseRatio: baseRatio,
    termsRatio: termsRatio,
    ensure: ensure,
    evaluateAccept: evaluateAccept,
    agreementsFor: agreementsFor,
    agreementsForColony: agreementsForColony,
    canPropose: canPropose,
    propose: propose,
    findAgreement: findAgreement,
    cancel: cancel,
    process: process,
    minDuration: minDuration
  };
})(typeof window !== 'undefined' ? window : this);
