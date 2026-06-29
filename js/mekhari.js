/* =====================================================================
   ORION EMPIRES — mekhari.js
   Modulo M12 (Fase B, slice 2): Sindacato Mekhari come fixer del mercato
   grigio (decisione #56/#53 §15.5).

   SCOPE (questo file) — la parte di §15.5 implementabile ORA:
     - (b) CONTRABBANDO: i Mekhari sono un fixer GALATTICO. Una volta
       CONTATTATI (sono una delle 4 Costanti §13.7), vendono risorse base a
       QUALUNQUE colonia accettando QUALUNQUE valuta del tuo portfolio
       (attingono dalla Tesoreria intera, §15.4), a un SOVRAPPREZZO da
       mercato grigio + un COSTO DI REPUTAZIONE §14 (alimenta la pista
       Tiranno, decisione #23). È una leva di emergenza/convenienza: paghi
       caro e in reputazione, ma ottieni rifornimenti ovunque, anche dove
       non hai la valuta locale.
     - (f) spread "convenienza locale": già in A2 (la presenza Mekhari
       abbassa lo spread del cambio/banco).

   RINVIATO (dipende da moduli futuri):
     - (a) MERCATO SECONDARIO di risorse avanzate §7.2 → M13: oggi le
       avanzate non hanno alcun uso (si accumulano solo in colony.exoticAccum
       come gancio M13), quindi comprarle sarebbe un guscio vuoto.
     - (c) contratti mercenari → M14 · (d) taglie pirata → M17 ·
       (e) intel grigia → M19.

   Determinismo (#5/#22): zero RNG. Le operazioni sono azioni utente (fuori
   dal tick), matematica pura su Tesoreria/stock/reputazione. Recovery-friendly:
   nessun fail-state; il sovrapprezzo + costo reputazione sono il prezzo.
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  const BUY_RES = ['met', 'en', 'food', 'water'];

  /* Sovrapprezzo base del mercato grigio (oltre il prezzo di riferimento).
     Ridotto da reputazione alta (i Mekhari ti trattano meglio se hai buona
     fama come cliente), clampato. */
  const SURCHARGE_BASE = 0.35;
  const SURCHARGE_MIN = 0.15;
  const SURCHARGE_MAX = 0.60;

  /* Costo di reputazione del contrabbando: punti §14 persi per credito speso,
     con un tetto per transazione. */
  const REP_COST_RATE = 0.01;   // 100 crediti spesi → 1 punto reputazione
  const REP_COST_CAP = 5;

  function mekhariCiv(game) {
    const civs = (game && game.civs) || [];
    for (let i = 0; i < civs.length; i++) {
      if (civs[i] && civs[i].faction === 'mekhari' && civs[i].alive) return civs[i];
    }
    return null;
  }

  /* Disponibile se i Mekhari esistono e sono stati almeno CONTATTATI (atto
     formale: diplomazia/scontro/scambio). Le 4 Costanti hanno nome+ruolo
     sempre noti, ma il servizio si sblocca col contatto. */
  function isAvailable(game) {
    const civ = mekhariCiv(game);
    if (!civ) return false;
    const AI = root.ORION.ai;
    const rank = (AI && AI.knowledgeRank) ? AI.knowledgeRank(civ) : (civ.contacted ? 2 : 0);
    return rank >= 2;   // >= contacted
  }

  function reputation(game) {
    return root.ORION.diplomacy ? root.ORION.diplomacy.reputation(game)
         : (typeof game.reputation === 'number' ? game.reputation : 50);
  }

  /* Sovrapprezzo effettivo: base × fattore reputazione, clampato. */
  function surcharge(game) {
    let s = SURCHARGE_BASE;
    const rep = reputation(game);
    if (rep >= 70) s *= 0.7;
    else if (rep >= 50) s *= 1.0;
    else if (rep >= 30) s *= 1.2;
    else s *= 1.4;
    return Math.max(SURCHARGE_MIN, Math.min(SURCHARGE_MAX, Math.round(s * 1000) / 1000));
  }

  function refPrice(res) {
    const T = root.ORION.treasury;
    if (T && T.REF_PRICE && T.REF_PRICE[res] != null) return T.REF_PRICE[res];
    return ({ met: 1.0, en: 0.9, food: 1.4, water: 1.2 })[res] || 1.0;
  }

  function repCostFor(credits) {
    return Math.min(REP_COST_CAP, Math.round(credits * REP_COST_RATE * 100) / 100);
  }

  /* ------------------------------------------------------------------
     INTEL GRIGIA (M19, GDD §6e): i Mekhari vendono informazioni su altre
     civiltà — remota (nessuna flotta), a pagamento, MENO completa dello
     spionaggio vero: porta il dossier al massimo a "parziale" (il dossier
     COMPLETO + i segreti restano appannaggio dell'Infiltrazione M19).
     ------------------------------------------------------------------ */
  const INTEL_BASE_PRICE = 60;     // crediti neutri, base prima del sovrapprezzo
  const INTEL_CAP = 'partial';     // tetto del canale grigio

  function intelRank(level) {
    const AI = root.ORION.ai;
    if (AI && AI.intelLevelRank) return AI.intelLevelRank(level);
    return ({ fragmentary: 1, partial: 2, complete: 3 })[level] || 1;
  }
  function currentIntel(civ) {
    const AI = root.ORION.ai;
    return civ.intelLevel ||
      (AI && AI.intelLevelFromProgress ? AI.intelLevelFromProgress(civ.intelProgress || 0) : 'fragmentary');
  }
  function findCiv(game, civId) {
    const civs = (game && game.civs) || [];
    for (let i = 0; i < civs.length; i++) if (civs[i] && civs[i].id === civId) return civs[i];
    return null;
  }

  /* Preventivo intel grigia su una civiltà bersaglio. */
  function quoteIntel(game, civId) {
    if (!isAvailable(game)) return { ok: false, reason: 'Mercato grigio non disponibile (contatta i Mekhari)' };
    const civ = findCiv(game, civId);
    if (!civ || !civ.alive) return { ok: false, reason: 'Civiltà non disponibile' };
    if (civ.faction === 'mekhari') return { ok: false, reason: 'I Mekhari non vendono dossier su sé stessi' };
    const AI = root.ORION.ai;
    const krank = (AI && AI.knowledgeRank) ? AI.knowledgeRank(civ) : (civ.contacted ? 2 : 0);
    if (krank < 2) return { ok: false, reason: 'Serve prima un contatto formale con questa civiltà' };
    if (intelRank(currentIntel(civ)) >= intelRank(INTEL_CAP)) {
      return { ok: false, reason: 'I Mekhari non hanno nulla di più affidabile su di loro' };
    }
    const sc = surcharge(game);
    const cost = Math.round(INTEL_BASE_PRICE * (1 + sc));
    return { ok: true, costCredits: cost, surcharge: sc, repCost: repCostFor(cost), toLevel: INTEL_CAP };
  }

  /* Acquisto: paga in crediti (qualunque valuta), porta il dossier a parziale.
     Costo di reputazione del mercato grigio (§14, pista Tiranno), come smuggle.
     Nessun rischio, nessuna flotta richiesta. Deterministico. */
  function buyIntel(game, civId) {
    const q = quoteIntel(game, civId);
    if (!q.ok) return q;
    const T = root.ORION.treasury;
    if (!T || !T.spendCredits) return { ok: false, reason: 'Tesoreria non disponibile' };
    if (T.totalCredits(game) + 1e-6 < q.costCredits) {
      return { ok: false, reason: 'Tesoreria insufficiente (servono ≈' + q.costCredits.toFixed(0) + ' crediti)' };
    }
    const spent = T.spendCredits(game, q.costCredits);
    if (!spent.ok) return spent;
    const civ = findCiv(game, civId);
    civ.intelLevel = INTEL_CAP;
    if ((civ.intelProgress || 0) < 3) civ.intelProgress = 3;   // soglia "parziale"
    if (q.repCost > 0 && root.ORION.diplomacy && root.ORION.diplomacy.adjustReputation) {
      root.ORION.diplomacy.adjustReputation(game, -q.repCost);
    }
    return { ok: true, toLevel: INTEL_CAP, costCredits: q.costCredits, repCost: q.repCost };
  }

  /* Preventivo di contrabbando: costo in crediti (valore neutro, pagabile da
     qualunque valuta) + costo di reputazione. */
  function quoteSmuggle(game, colonyKey, resource, amount) {
    amount = Math.max(0, amount || 0);
    if (BUY_RES.indexOf(resource) < 0) return { ok: false, reason: 'Risorsa non disponibile' };
    if (!isAvailable(game)) return { ok: false, reason: 'Mercato grigio non disponibile (contatta i Mekhari)' };
    const colony = game.colonies && game.colonies[colonyKey];
    if (!colony || !colony.colonized) return { ok: false, reason: 'Colonia non operativa' };
    const sc = surcharge(game);
    const costCredits = Math.round(amount * refPrice(resource) * (1 + sc) * 100) / 100;
    return { ok: true, costCredits: costCredits, surcharge: sc, repCost: repCostFor(costCredits) };
  }

  function buySmuggle(game, colonyKey, resource, amount) {
    amount = Math.round(Math.max(0, amount || 0) * 100) / 100;
    if (amount <= 0) return { ok: false, reason: 'Quantità non valida' };
    const q = quoteSmuggle(game, colonyKey, resource, amount);
    if (!q.ok) return q;
    const T = root.ORION.treasury;
    if (!T || !T.spendCredits) return { ok: false, reason: 'Tesoreria non disponibile' };
    if (T.totalCredits(game) + 1e-6 < q.costCredits) {
      return { ok: false, reason: 'Tesoreria insufficiente (servono ≈' + q.costCredits.toFixed(0) + ' crediti)' };
    }
    const spent = T.spendCredits(game, q.costCredits);
    if (!spent.ok) return spent;
    const colony = game.colonies[colonyKey];
    colony.stock[resource] = Math.round(((colony.stock[resource] || 0) + amount) * 100) / 100;
    /* Costo di reputazione del mercato grigio (§14, pista Tiranno). */
    if (q.repCost > 0 && root.ORION.diplomacy && root.ORION.diplomacy.adjustReputation) {
      root.ORION.diplomacy.adjustReputation(game, -q.repCost);
    }
    return { ok: true, bought: amount, costCredits: q.costCredits, repCost: q.repCost };
  }

  ORION.mekhari = {
    BUY_RES: BUY_RES,
    SURCHARGE_BASE: SURCHARGE_BASE,
    INTEL_CAP: INTEL_CAP,
    mekhariCiv: mekhariCiv,
    isAvailable: isAvailable,
    surcharge: surcharge,
    repCostFor: repCostFor,
    quoteSmuggle: quoteSmuggle,
    buySmuggle: buySmuggle,
    quoteIntel: quoteIntel,
    buyIntel: buyIntel
  };
})(typeof window !== 'undefined' ? window : this);
