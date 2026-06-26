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

  /* ------------------------------------------------------------------
     M12 §15.5(a) — MERCATO SECONDARIO DELLE RISORSE AVANZATE.
     Sbloccato ora che M13 ha senso (l'Impianto esotico produce esotici
     che si accumulano in `colony.exoticAccum`). I Mekhari comprano i
     tuoi esotici in LOTTI per crediti regionali della colonia di
     origine. Direzione opposta al contrabbando: qui vendi TU, e la
     reputazione alta migliora il prezzo (clienti migliori, meno spread
     del fixer). Nessun costo reputazione: è commercio ordinario.
     ------------------------------------------------------------------ */
  const EXOTIC_LOT_SIZE = 5;            // 1 lotto = 5 unità esotico
  const EXOTIC_PRICE_PER_UNIT = 25;     // crediti base per unità

  function exoticPriceFactor(game) {
    /* Reputazione alta = clienti migliori → +bonus; bassa = spread fixer. */
    const rep = reputation(game);
    if (rep >= 70) return 1.15;
    if (rep >= 50) return 1.0;
    if (rep >= 30) return 0.9;
    return 0.8;
  }

  function quoteExoticSale(game, colonyKey, lots) {
    lots = Math.max(0, Math.floor(lots || 0));
    if (lots <= 0) return { ok: false, reason: 'Quantità non valida (servono lotti interi)' };
    if (!isAvailable(game)) return { ok: false, reason: 'Mercato secondario non disponibile (contatta i Mekhari)' };
    const colony = game.colonies && game.colonies[colonyKey];
    if (!colony || !colony.colonized) return { ok: false, reason: 'Colonia non operativa' };
    const stock = colony.exoticAccum || 0;
    const units = lots * EXOTIC_LOT_SIZE;
    if (stock + 1e-6 < units) {
      return { ok: false, reason: 'Esotici insufficienti (servono ' + units + ', disponibili ' + Math.floor(stock) + ')' };
    }
    const factor = exoticPriceFactor(game);
    const credits = Math.round(units * EXOTIC_PRICE_PER_UNIT * factor);
    return { ok: true, lots: lots, units: units, credits: credits, factor: factor,
      currency: regionalCurrencyOf(game, colonyKey) };
  }

  function regionalCurrencyOf(game, colonyKey) {
    const T = root.ORION.treasury;
    if (!T || !T.currencyOfColony) return null;
    return T.currencyOfColony(game, colonyKey);
  }

  function sellExotic(game, colonyKey, lots, events) {
    const q = quoteExoticSale(game, colonyKey, lots);
    if (!q.ok) return q;
    const T = root.ORION.treasury;
    if (!T || !T.creditRegional) return { ok: false, reason: 'Tesoreria non disponibile' };
    const colony = game.colonies[colonyKey];
    colony.exoticAccum = Math.max(0, (colony.exoticAccum || 0) - q.units);
    /* Accredita la valuta della regione della colonia di origine: il
       commercio è locale, non multi-valuta. */
    const credited = T.creditRegional(game, colonyKey, q.credits);
    if (events) events.push({ kind: 'mekhari-exotic-sold', colonyKey: colonyKey,
      lots: q.lots, units: q.units, credits: q.credits,
      currency: (credited && credited.currency) || q.currency,
      impulso: (game && game.timeImpulsi) || 0 });
    return { ok: true, lots: q.lots, units: q.units, credits: q.credits,
      currency: (credited && credited.currency) || q.currency };
  }

  /* ------------------------------------------------------------------
     M12 §15.5(c) — MERCENARI MEKHARI.
     Hub per ingaggiare un Comandante/Ingegnere/Stratega freelance PRE-
     FORMATO da assegnare a una tua flotta. È un SHORTCUT a pagamento:
     la via canonica resta crescere la crew M07 → figura emergente M14.
     Per evitare spam, un'unica offerta attiva alla volta. Si rigenera
     ogni REFRESH_EVERY_I (200 Ι, ~6 mesi reali al 1×), deterministica
     dal seed dell'impulso. Costa crediti scalati sul rank + sovrapprezzo
     Mekhari (lo stesso del contrabbando: i fixer si fanno pagare).
     Recovery-friendly (#22): non ti blocchi se non puoi pagare. Niente
     RNG fuori dal `makeRng(seed:mercenary:<I>)`.
     ------------------------------------------------------------------ */
  const MERC_REFRESH_EVERY_I = 200;
  const MERC_PRICE_BY_RANK = { tenente: 200, capitano: 350 };
  const MERC_RANKS = ['tenente', 'capitano'];
  const MERC_ROLES = ['comandante', 'ingegnere', 'stratega'];
  /* Probabilità Capitano = 0.30 (i Mekhari pescano meno spesso pezzi grossi). */
  const MERC_RANK_CAPITANO_PROB = 0.30;

  function ensureMekhariStore(game) {
    if (!game.mekhari) game.mekhari = {};
    return game.mekhari;
  }

  function currentMercenary(game) {
    if (!isAvailable(game)) return null;
    const m = ensureMekhariStore(game);
    return m.mercenary || null;
  }

  function refreshMercenary(game, events) {
    if (!isAvailable(game)) return { ok: false, reason: 'Mekhari non contattati' };
    const m = ensureMekhariStore(game);
    const now = (game && game.timeImpulsi) || 0;
    const seed = (game.seed || (game.galaxy && game.galaxy.seed) || 'NA') + ':mercenary:' + now;
    const rng = root.ORION.rng && root.ORION.rng.makeRng ? root.ORION.rng.makeRng(seed) : null;
    if (!rng) return { ok: false, reason: 'RNG non disponibile' };
    const rank = rng.chance(MERC_RANK_CAPITANO_PROB) ? 'capitano' : 'tenente';
    const role = MERC_ROLES[Math.floor(rng.float() * MERC_ROLES.length)];
    const C = root.ORION.commander;
    const trait = (C && C.pickTrait) ? C.pickTrait(rng, role) : null;
    const name = (C && C.pickName) ? C.pickName(rng) : ('Freelance #' + now);
    const basePrice = MERC_PRICE_BY_RANK[rank] || 200;
    const sc = surcharge(game);
    const costCredits = Math.round(basePrice * (1 + sc));
    m.mercenary = {
      id: 'merc-' + now,
      role: role, rank: rank, traitId: trait && trait.id,
      name: name, costCredits: costCredits, surcharge: sc,
      offeredAt: now
    };
    m.mercenaryRefreshedAt = now;
    if (events) events.push({ kind: 'mekhari-mercenary', merc: m.mercenary, impulso: now });
    return { ok: true, mercenary: m.mercenary };
  }

  /* Tick di refresh: chiamato dal loop. La prima offerta arriva dopo
     REFRESH_EVERY_I dal primo contatto (warmup), poi a cadenza fissa. */
  function tickMercenary(game, events) {
    if (!isAvailable(game)) return;
    const m = ensureMekhariStore(game);
    const now = (game && game.timeImpulsi) || 0;
    const last = m.mercenaryRefreshedAt;
    if (last == null) {
      /* Prima volta che siamo disponibili: registra l'istante e attendi
         il primo periodo prima di emettere offerte. */
      m.mercenaryRefreshedAt = now;
      return;
    }
    if (now - last >= MERC_REFRESH_EVERY_I) {
      refreshMercenary(game, events);
    }
  }

  function hireMercenary(game, fleetId, events) {
    const m = ensureMekhariStore(game);
    const merc = m.mercenary;
    if (!merc) return { ok: false, reason: 'Nessuna offerta attiva' };
    const fleet = (game.fleets || []).filter(function (f) { return f && f.id === fleetId; })[0];
    if (!fleet) return { ok: false, reason: 'Flotta non valida' };
    /* Verifica posti officer (dipende dal capitale più grosso, M15). */
    const C = root.ORION.commander;
    const slots = (C && C.officerSlots) ? C.officerSlots(fleet) : 1;
    if (!Array.isArray(fleet.officers)) fleet.officers = [];
    if (fleet.officers.length >= slots) {
      return { ok: false, reason: 'Posti officer pieni su questa flotta (' + slots + ')' };
    }
    /* Niente due figure dello stesso ruolo sulla stessa flotta (regola M15). */
    const dupRole = fleet.officers.some(function (o) { return o && o.role === merc.role; });
    if (dupRole) return { ok: false, reason: 'Hai già un ufficiale di questo ruolo a bordo' };
    const T = root.ORION.treasury;
    if (!T || !T.spendCredits) return { ok: false, reason: 'Tesoreria non disponibile' };
    if (T.totalCredits(game) + 1e-6 < merc.costCredits) {
      return { ok: false, reason: 'Tesoreria insufficiente (servono ≈' + merc.costCredits + ' crediti)' };
    }
    const spent = T.spendCredits(game, merc.costCredits);
    if (!spent.ok) return spent;
    /* Spawn officer via commander.makeFreelance (M12 §15.5c). Fallback per
       test headless senza commander caricato. */
    const officer = (C && C.makeFreelance)
      ? C.makeFreelance(game, merc)
      : { id: merc.id, role: merc.role, rank: merc.rank, name: merc.name,
          traitId: merc.traitId, xp: 0, origin: 'mekhari', spawnedAt: (game.timeImpulsi || 0) };
    fleet.officers.push(officer);
    /* Costo reputazione lieve: ingaggiare freelance erode l'immagine
       d'impero (pista Tiranno, magnitudo 1). */
    if (root.ORION.diplomacy && root.ORION.diplomacy.adjustReputation) {
      root.ORION.diplomacy.adjustReputation(game, -1);
    }
    m.mercenary = null;
    m.mercenaryRefreshedAt = (game.timeImpulsi || 0);
    if (events) events.push({ kind: 'mekhari-mercenary-hired', officer: officer,
      fleetId: fleet.id, fleetName: fleet.name, costCredits: merc.costCredits,
      impulso: (game.timeImpulsi || 0) });
    return { ok: true, officer: officer, fleet: fleet };
  }

  ORION.mekhari = {
    BUY_RES: BUY_RES,
    SURCHARGE_BASE: SURCHARGE_BASE,
    INTEL_CAP: INTEL_CAP,
    EXOTIC_LOT_SIZE: EXOTIC_LOT_SIZE,
    MERC_REFRESH_EVERY_I: MERC_REFRESH_EVERY_I,
    mekhariCiv: mekhariCiv,
    isAvailable: isAvailable,
    surcharge: surcharge,
    repCostFor: repCostFor,
    quoteSmuggle: quoteSmuggle,
    buySmuggle: buySmuggle,
    quoteIntel: quoteIntel,
    buyIntel: buyIntel,
    /* M12 §15.5(a) */
    quoteExoticSale: quoteExoticSale,
    sellExotic: sellExotic,
    exoticPriceFactor: exoticPriceFactor,
    /* M12 §15.5(c) */
    currentMercenary: currentMercenary,
    refreshMercenary: refreshMercenary,
    tickMercenary: tickMercenary,
    hireMercenary: hireMercenary
  };
})(typeof window !== 'undefined' ? window : this);
