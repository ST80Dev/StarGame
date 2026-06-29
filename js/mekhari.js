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

  /* ==================================================================
     INTEL GRIGIA (M19, GDD §6e) — RIFONDAZIONE (richiesta utente 2026-06-29).

     PROBLEMA del modello vecchio: vendeva un dossier "parziale" SOLO su civ
     già CONTATTATE — ma il contatto formale richiede di aver già presidiato
     un loro sistema, e a quel punto il "parziale" te lo costruivi da solo
     restando lì. Canale ridondante: pagavi per qualcosa che già avevi.

     NUOVO MODELLO — i Mekhari riempiono il BUCO che il pedinamento flotte
     lascia aperto ("conosco la bandiera, non so dove vivono né chi sono") e
     vendono spunti generici di galassia. Due linee:

       LINEA A — Dossier mirato su una civ di cui hai già IDENTIFICATO una
         flotta (civ.flagSeen, da aifleet.js) — anche senza contatto formale:
           · LOCALIZZAZIONE: rivela DOVE sono le loro colonie (revealSystem)
             + promuove ad "Avvistata". Affidabilità ALTA (coordinate = fatto).
           · PROFILO GRIGIO: dossier approssimato (forza a fascia con margine,
             disposizione/allineamento/vocazione talvolta incerti) marchiato
             "fonte non verificata". Affidabilità MEDIA. È una FOTO DATATA:
             non si aggiorna (invecchia), spinge allo spionaggio vero.

       LINEA B — VOCI DI GALASSIA: spunti generici a basso costo, affidabilità
         BASSA (alcune vaghe/anonime). Pescate dallo stato reale della galassia.

     DETERMINISMO (#5): zero Math.random. La sfumatura (margine d'errore,
     scelta delle voci, affidabilità) deriva dal seed:
       `<galaxy.seed>:mekhari:<scope>`. Stesso seed + stessa sequenza comandi
     → stato identico all'Impulso I → stesso esito.

     PERSISTENZA: civ.flagSeen/civ.greyIntel vivono dentro game.civs
     (auto-serializzato, nessun bump). Le voci in game.mekhariIntel.rumors
     (campo top-level additivo/lazy).
     ------------------------------------------------------------------ */
  const LOCATE_BASE = 70;          // crediti neutri base (affidabile)
  const PROFILE_BASE = 130;        // più caro (dossier, anche se sfumato)
  const RUMOR_BASE = 40;           // economico (spunti generici)
  const RUMOR_BATCH = 3;           // voci per acquisto
  const RUMOR_MAX_STORED = 12;     // cap voci archiviate
  const PROFILE_FORCE_OFFSET = 0.20; // bias deterministico sul centro stima
  const PROFILE_FORCE_SPAN = 0.40;   // semi-ampiezza fascia di forza
  const PROFILE_ALIGN_SURE = 0.70;   // prob. che l'allineamento sia certo
  const PROFILE_VOC_SURE = 0.60;     // prob. che la vocazione sia certa
  const PROFILE_DISPO_NOISE = 12;    // rumore deterministico su disposizione
  const RUMOR_RELIABLE = 0.70;       // prob. che una voce sia "attendibile"

  function aiApi() { return root.ORION.ai; }
  function findCiv(game, civId) {
    const civs = (game && game.civs) || [];
    for (let i = 0; i < civs.length; i++) if (civs[i] && civs[i].id === civId) return civs[i];
    return null;
  }
  function intelRank(level) {
    const AI = aiApi();
    if (AI && AI.intelLevelRank) return AI.intelLevelRank(level);
    return ({ fragmentary: 1, partial: 2, complete: 3, deep: 4 })[level] || 1;
  }
  function currentIntel(civ) {
    const AI = aiApi();
    return civ.intelLevel ||
      (AI && AI.intelLevelFromProgress ? AI.intelLevelFromProgress(civ.intelProgress || 0) : 'fragmentary');
  }
  /* RNG deterministico per-scope (seed galassia). */
  function rngFor(game, scope) {
    const seed = (game && game.galaxy && game.galaxy.seed) || 'noseed';
    return root.ORION.rng.makeRng(seed + ':mekhari:' + scope);
  }
  /* Stato top-level lazy per le voci di galassia. */
  function ensureIntel(game) {
    if (!game.mekhariIntel || typeof game.mekhariIntel !== 'object') game.mekhariIntel = { rumors: [] };
    if (!Array.isArray(game.mekhariIntel.rumors)) game.mekhariIntel.rumors = [];
    return game.mekhariIntel;
  }
  /* Prerequisito Linea A: hai identificato una loro flotta (flagSeen), li hai
     già avvistati, oppure è una delle 4 Costanti (nome sempre noto §13.7). */
  function civIdentified(game, civ) {
    if (!civ) return false;
    if (civ.flagSeen || civ.faction) return true;
    const AI = aiApi();
    return (AI && AI.knowledgeRank) ? AI.knowledgeRank(civ) >= 1 : !!civ.contacted;
  }
  function spend(game, cost) {
    const T = root.ORION.treasury;
    if (!T || !T.spendCredits) return { ok: false, reason: 'Tesoreria non disponibile' };
    if (T.totalCredits(game) + 1e-6 < cost) {
      return { ok: false, reason: 'Tesoreria insufficiente (servono ≈' + cost.toFixed(0) + ' crediti)' };
    }
    return T.spendCredits(game, cost);
  }
  function applyRepCost(game, repCost) {
    if (repCost > 0 && root.ORION.diplomacy && root.ORION.diplomacy.adjustReputation) {
      root.ORION.diplomacy.adjustReputation(game, -repCost);
    }
  }

  /* --- LINEA A1 — LOCALIZZAZIONE ------------------------------------- */
  /* Sistemi della civ non ancora pienamente noti (EXPLORED). */
  function locatableSystems(game, civ) {
    const AI = aiApi();
    const sys = (civ.systems && civ.systems.length) ? civ.systems
      : (AI && AI.derivedSystems ? AI.derivedSystems(civ) : []);
    const G = root.ORION.galaxy;
    const disc = game.state && game.state.discovery;
    const D = G && G.DISCOVERY;
    if (!disc || !D) return sys.slice();
    const out = [];
    for (let i = 0; i < sys.length; i++) {
      if (disc[sys[i]] < D.EXPLORED) out.push(sys[i]);
    }
    return out;
  }
  function quoteLocate(game, civId) {
    if (!isAvailable(game)) return { ok: false, reason: 'Mercato grigio non disponibile (contatta i Mekhari)' };
    const civ = findCiv(game, civId);
    if (!civ || !civ.alive) return { ok: false, reason: 'Civiltà non disponibile' };
    if (civ.faction === 'mekhari') return { ok: false, reason: 'I Mekhari non vendono coordinate proprie' };
    if (!civIdentified(game, civ)) return { ok: false, reason: 'Identifica prima una loro flotta (pedinala) o avvistali' };
    const todo = locatableSystems(game, civ);
    if (!todo.length) return { ok: false, reason: 'Sai già dove si trovano le loro colonie' };
    const sc = surcharge(game);
    const cost = Math.round(LOCATE_BASE * (1 + sc));
    return { ok: true, costCredits: cost, surcharge: sc, repCost: repCostFor(cost), systems: todo.length };
  }
  function buyLocate(game, civId) {
    const q = quoteLocate(game, civId);
    if (!q.ok) return q;
    const sp = spend(game, q.costCredits);
    if (!sp.ok) return sp;
    const civ = findCiv(game, civId);
    const G = root.ORION.galaxy;
    const todo = locatableSystems(game, civ);
    let revealed = 0;
    for (let i = 0; i < todo.length; i++) {
      if (G && G.revealSystem && G.revealSystem(game.galaxy, todo[i], game.state)) revealed++;
    }
    const AI = aiApi();
    if (AI && AI.bumpKnowledge) AI.bumpKnowledge(civ, 'spotted');
    applyRepCost(game, q.repCost);
    return { ok: true, revealed: revealed, costCredits: q.costCredits, repCost: q.repCost };
  }

  /* --- LINEA A2 — PROFILO GRIGIO ------------------------------------- */
  function quoteProfile(game, civId) {
    if (!isAvailable(game)) return { ok: false, reason: 'Mercato grigio non disponibile (contatta i Mekhari)' };
    const civ = findCiv(game, civId);
    if (!civ || !civ.alive) return { ok: false, reason: 'Civiltà non disponibile' };
    if (civ.faction === 'mekhari') return { ok: false, reason: 'I Mekhari non vendono dossier su sé stessi' };
    if (!civIdentified(game, civ)) return { ok: false, reason: 'Identifica prima una loro flotta (pedinala) o avvistali' };
    const haveReal = intelRank(currentIntel(civ)) >= 2; // già "parziale"+ per vie tue
    if (civ.greyIntel || haveReal) return { ok: false, reason: 'Hai già un dossier almeno equivalente su di loro' };
    const sc = surcharge(game);
    const cost = Math.round(PROFILE_BASE * (1 + sc));
    return { ok: true, costCredits: cost, surcharge: sc, repCost: repCostFor(cost) };
  }
  /* Foto sfumata e DATATA del bersaglio (margine d'errore deterministico). */
  function buildGreySnapshot(game, civ, r, I) {
    const exact = Math.max(1, Math.round(civ.power || 0));
    const offset = r.range(-PROFILE_FORCE_OFFSET, PROFILE_FORCE_OFFSET); // centro spostato
    const mid = Math.max(1, Math.round(exact * (1 + offset)));
    const span = Math.max(2, Math.round(mid * PROFILE_FORCE_SPAN));
    const alignSure = r.chance(PROFILE_ALIGN_SURE);
    const vocSure = r.chance(PROFILE_VOC_SURE);
    const AI = aiApi();
    const dos = (AI && AI.dossier) ? AI.dossier(civ) : {};
    const dnoise = Math.round(r.range(-PROFILE_DISPO_NOISE, PROFILE_DISPO_NOISE));
    const dapprox = Math.max(-100, Math.min(100, Math.round(civ.disposition || 0) + dnoise));
    return {
      I: I,
      powerAtBuy: exact,
      force: { lo: Math.max(1, mid - span), hi: mid + span, mid: mid },
      alignment: alignSure ? (civ.alignment || null) : null, // null = "incerto"
      vocationLabel: vocSure ? (dos.vocationLabel || null) : null,
      dispositionApprox: dapprox,
      systems: (civ.systems || []).length || (dos.systems || 0)
    };
  }
  function buyProfile(game, civId) {
    const q = quoteProfile(game, civId);
    if (!q.ok) return q;
    const sp = spend(game, q.costCredits);
    if (!sp.ok) return sp;
    const civ = findCiv(game, civId);
    const I = game.timeImpulsi || 0;
    const r = rngFor(game, 'profile:' + civId + ':' + I);
    civ.greyIntel = buildGreySnapshot(game, civ, r, I);
    applyRepCost(game, q.repCost);
    return { ok: true, costCredits: q.costCredits, repCost: q.repCost };
  }

  /* --- LINEA B — VOCI DI GALASSIA ------------------------------------ */
  function alignWord(c) {
    if (c.alignment === 'male') return 'di chiaro segno oscuro';
    if (c.alignment === 'bene') return 'di indole benevola';
    return 'di allineamento ambiguo';
  }
  function tierWord(c) {
    return ({
      nucleo: 'nel Nucleo', colonie: 'nelle Colonie Interne',
      frontiera: 'sulla Frontiera', orlo: "sull'Orlo Esterno"
    })[c.homeTier] || 'in una regione remota';
  }
  /* Costruisce i candidati-voce dallo stato reale, poi ne pesca RUMOR_BATCH
     in modo deterministico. Una voce "non attendibile" diventa vaga/anonima
     (spunto, non fatto verificato) — niente fabbricazione di falsi. */
  function generateRumors(game, r, I) {
    const civs = (game.civs || []).filter(function (c) { return c && c.alive && c.faction !== 'mekhari'; });
    const cands = [];
    let evilPow = 0, goodPow = 0;
    for (let i = 0; i < civs.length; i++) {
      const c = civs[i];
      const power = c.power || 0;
      if (c.alignment === 'male') evilPow += power;
      else if (c.alignment === 'bene') goodPow += power;
      /* Minaccia: maligna, in crescita, potenza notevole. */
      if (c.alignment === 'male' && (c.phase === 'growth' || c.phase === 'rise') && power >= 50) {
        cands.push({ kind: 'threat', civId: c.id, w: 3, make: function (rel) {
          return rel
            ? 'Si dice che ' + c.name + ', una potenza ' + alignWord(c) + ', stia espandendo la propria sfera militare. Tienili d\'occhio.'
            : 'Voci insistenti parlano di una potenza ' + alignWord(c) + ' in ascesa ' + tierWord(c) + ' — i dettagli restano confusi.';
        } });
      }
      /* Opportunità: ben disposta + mercantile/tecnocratica. */
      if ((c.disposition || 0) >= 25 && (c.vocation === 'mercantili' || c.vocation === 'tecnocratici')) {
        cands.push({ kind: 'opportunity', civId: c.id, w: 2, make: function (rel) {
          return rel
            ? c.name + ' è ben disposta verso di te: un\'intesa commerciale o un\'alleanza potrebbe portarti vantaggi concreti.'
            : 'Gira voce che una civiltà ' + tierWord(c) + ' cerchi partner commerciali affidabili.';
        } });
      }
      /* Opportunità: in declino/collasso → territori presto scoperti. */
      if (c.phase === 'decline' || c.phase === 'collapse') {
        cands.push({ kind: 'opportunity', civId: c.id, w: 2, make: function (rel) {
          return rel
            ? c.name + ' è in ' + (c.phase === 'collapse' ? 'pieno collasso' : 'declino') + ': territori e rotte potrebbero presto restare scoperti.'
            : 'Si mormora di un impero ' + tierWord(c) + ' che vacilla — chi arriva primo raccoglie.';
        } });
      }
    }
    /* Voce "umore di galassia" — sempre disponibile (fallback non vuoto). */
    cands.push({ kind: 'mood', civId: null, w: 1, make: function () {
      if (evilPow > goodPow * 1.3) return 'Le correnti oscure prevalgono: le potenze maligne pesano più di quelle benevole. Tempi di cautela.';
      if (goodPow > evilPow * 1.3) return 'L\'equilibrio pende verso le potenze benevole: c\'è spazio per alleanze e commerci prosperi.';
      return 'La galassia è in equilibrio precario tra luce e ombra: nessuno schieramento domina, per ora.';
    } });

    /* Pesca deterministica: espandi per peso, mischia, prendi BATCH unici. */
    const pool = [];
    for (let i = 0; i < cands.length; i++) for (let w = 0; w < cands[i].w; w++) pool.push(cands[i]);
    r.shuffle(pool);
    const out = [];
    const usedKeys = {};
    for (let i = 0; i < pool.length && out.length < RUMOR_BATCH; i++) {
      const cand = pool[i];
      const key = cand.kind + ':' + (cand.civId == null ? 'mood' : cand.civId);
      if (usedKeys[key]) continue;
      usedKeys[key] = true;
      const reliable = r.chance(RUMOR_RELIABLE);
      out.push({
        I: I,
        kind: cand.kind,
        civId: reliable ? cand.civId : null, // voce vaga = anonima
        reliable: reliable,
        text: cand.make(reliable)
      });
    }
    return out;
  }
  function quoteRumor(game) {
    if (!isAvailable(game)) return { ok: false, reason: 'Mercato grigio non disponibile (contatta i Mekhari)' };
    const sc = surcharge(game);
    const cost = Math.round(RUMOR_BASE * (1 + sc));
    return { ok: true, costCredits: cost, surcharge: sc, repCost: repCostFor(cost), count: RUMOR_BATCH };
  }
  function buyRumor(game) {
    if (!isAvailable(game)) return { ok: false, reason: 'Mercato grigio non disponibile (contatta i Mekhari)' };
    const I = game.timeImpulsi || 0;
    const r = rngFor(game, 'rumor:' + I);
    const fresh = generateRumors(game, r, I);
    const intel = ensureIntel(game);
    const novel = fresh.filter(function (rm) {
      return !intel.rumors.some(function (x) { return x.text === rm.text; });
    });
    if (!novel.length) return { ok: false, reason: 'I Mekhari non hanno voci più fresche per ora — torna più avanti' };
    const sc = surcharge(game);
    const cost = Math.round(RUMOR_BASE * (1 + sc));
    const sp = spend(game, cost);
    if (!sp.ok) return sp;
    for (let i = 0; i < novel.length; i++) intel.rumors.unshift(novel[i]);
    if (intel.rumors.length > RUMOR_MAX_STORED) intel.rumors.length = RUMOR_MAX_STORED;
    const repCost = repCostFor(cost);
    applyRepCost(game, repCost);
    return { ok: true, added: novel.length, rumors: novel, costCredits: cost, repCost: repCost };
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
    RUMOR_BATCH: RUMOR_BATCH,
    mekhariCiv: mekhariCiv,
    isAvailable: isAvailable,
    surcharge: surcharge,
    repCostFor: repCostFor,
    quoteSmuggle: quoteSmuggle,
    buySmuggle: buySmuggle,
    ensureIntel: ensureIntel,
    civIdentified: civIdentified,
    /* Linea A — dossier mirato */
    quoteLocate: quoteLocate,
    buyLocate: buyLocate,
    quoteProfile: quoteProfile,
    buyProfile: buyProfile,
    /* Linea B — voci di galassia */
    quoteRumor: quoteRumor,
    buyRumor: buyRumor
  };
})(typeof window !== 'undefined' ? window : this);
