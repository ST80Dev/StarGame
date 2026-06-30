/* =====================================================================
   ORION EMPIRES — vehryn.js
   Conclave di Vehryn — VENDITORI DI INFORMAZIONI (M19 §6e/§13.7).
   Decisione utente 2026-06-30: il ruolo "vendita informazioni" appartiene
   ai Vehryn (archeologi delle stelle), NON ai Mekhari (che restano il
   trafficante del mercato grigio, vedi js/mekhari.js).

   Cosa vendono (intel sulle ALTRE civiltà — §15.5e riassegnata ai Vehryn):
     LINEA A — DOSSIER MIRATO su una civ di cui hai IDENTIFICATO una flotta
       (civ.flagSeen, da aifleet.js), anche senza contatto formale con essa:
         · LOCALIZZAZIONE: rivela DOVE sono le sue colonie (revealSystem) +
           promuove ad "Avvistata". Affidabilità ALTA (coordinate = fatto).
         · PROFILO GRIGIO: dossier approssimato e DATATO (forza a fascia con
           margine d'errore, allineamento/vocazione talvolta incerti) marchiato
           "fonte non verificata". Affidabilità MEDIA.
     LINEA B — VOCI DI GALASSIA: spunti generici a basso costo, affidabilità
       BASSA (alcune vaghe/anonime). Pescate dallo stato reale della galassia.

   Differenze rispetto al vecchio canale Mekhari (richiesta utente):
     - host = Vehryn (contattati). I Vehryn sono un conclave NEUTRALE e
       legittimo → l'acquisto costa SOLO crediti, NIENTE costo di reputazione
       (non è la pista Tiranno del mercato grigio).
     - i Vehryn vendono anche informazioni di ESPLORAZIONE (sistemi inesplorati,
       dati antichi, coordinate FSP): rinviato a un modulo successivo.

   DETERMINISMO (#5): zero Math.random. Sfumatura/voci derivano dal seed
   (`<galaxy.seed>:vehryn:<scope>`). Replay-safe.
   PERSISTENZA: civ.flagSeen/civ.greyIntel dentro game.civs (auto); voci in
   game.vehrynIntel.rumors (top-level additivo/lazy).
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  const LOCATE_BASE = 70;          // crediti base (affidabile)
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
  /* Sovrapprezzo del Conclave: come i Mekhari, il prezzo migliora con la tua
     reputazione/standing — ma è un onorario, non mercato nero. */
  const SURCHARGE_BASE = 0.25;
  const SURCHARGE_MIN = 0.10;
  const SURCHARGE_MAX = 0.45;

  function aiApi() { return root.ORION.ai; }
  function vehrynCiv(game) {
    const civs = (game && game.civs) || [];
    for (let i = 0; i < civs.length; i++) {
      if (civs[i] && civs[i].faction === 'vehryn' && civs[i].alive) return civs[i];
    }
    return null;
  }
  /* Disponibile se i Vehryn esistono e sono stati CONTATTATI (basta incrociarne
     una flotta o avvistarne un avamposto — vedi aifleet.js/ai.js). */
  function isAvailable(game) {
    const civ = vehrynCiv(game);
    if (!civ) return false;
    const AI = aiApi();
    const rank = (AI && AI.knowledgeRank) ? AI.knowledgeRank(civ) : (civ.contacted ? 2 : 0);
    return rank >= 2;
  }
  function reputation(game) {
    return root.ORION.diplomacy ? root.ORION.diplomacy.reputation(game)
         : (typeof game.reputation === 'number' ? game.reputation : 50);
  }
  function surcharge(game) {
    let s = SURCHARGE_BASE;
    const rep = reputation(game);
    if (rep >= 70) s *= 0.7;
    else if (rep >= 50) s *= 1.0;
    else if (rep >= 30) s *= 1.2;
    else s *= 1.4;
    return Math.max(SURCHARGE_MIN, Math.min(SURCHARGE_MAX, Math.round(s * 1000) / 1000));
  }
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
  function rngFor(game, scope) {
    const seed = (game && game.galaxy && game.galaxy.seed) || 'noseed';
    return root.ORION.rng.makeRng(seed + ':vehryn:' + scope);
  }
  function ensureIntel(game) {
    if (!game.vehrynIntel || typeof game.vehrynIntel !== 'object') game.vehrynIntel = { rumors: [] };
    if (!Array.isArray(game.vehrynIntel.rumors)) game.vehrynIntel.rumors = [];
    return game.vehrynIntel;
  }
  /* Prerequisito Linea A: hai identificato una sua flotta (flagSeen), l'hai
     già avvistata, o è una delle 4 Costanti (nome sempre noto §13.7). */
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

  /* --- LINEA A1 — LOCALIZZAZIONE ------------------------------------- */
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
    if (!isAvailable(game)) return { ok: false, reason: 'Conclave non disponibile (contatta i Vehryn)' };
    const civ = findCiv(game, civId);
    if (!civ || !civ.alive) return { ok: false, reason: 'Civiltà non disponibile' };
    if (civ.faction === 'vehryn') return { ok: false, reason: 'Il Conclave non vende le proprie coordinate' };
    if (!civIdentified(game, civ)) return { ok: false, reason: 'Identifica prima una sua flotta (pedinala) o avvistala' };
    const todo = locatableSystems(game, civ);
    if (!todo.length) return { ok: false, reason: 'Sai già dove si trovano le sue colonie' };
    const sc = surcharge(game);
    const cost = Math.round(LOCATE_BASE * (1 + sc));
    return { ok: true, costCredits: cost, surcharge: sc, systems: todo.length };
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
    return { ok: true, revealed: revealed, costCredits: q.costCredits };
  }

  /* --- LINEA A2 — PROFILO GRIGIO ------------------------------------- */
  function quoteProfile(game, civId) {
    if (!isAvailable(game)) return { ok: false, reason: 'Conclave non disponibile (contatta i Vehryn)' };
    const civ = findCiv(game, civId);
    if (!civ || !civ.alive) return { ok: false, reason: 'Civiltà non disponibile' };
    if (civ.faction === 'vehryn') return { ok: false, reason: 'Il Conclave non vende dossier su sé stesso' };
    if (!civIdentified(game, civ)) return { ok: false, reason: 'Identifica prima una sua flotta (pedinala) o avvistala' };
    const haveReal = intelRank(currentIntel(civ)) >= 2; // già "parziale"+ per vie tue
    if (civ.greyIntel || haveReal) return { ok: false, reason: 'Hai già un dossier almeno equivalente su di loro' };
    const sc = surcharge(game);
    const cost = Math.round(PROFILE_BASE * (1 + sc));
    return { ok: true, costCredits: cost, surcharge: sc };
  }
  /* Foto sfumata e DATATA del bersaglio (margine d'errore deterministico). */
  function buildGreySnapshot(game, civ, r, I) {
    const exact = Math.max(1, Math.round(civ.power || 0));
    const offset = r.range(-PROFILE_FORCE_OFFSET, PROFILE_FORCE_OFFSET);
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
      alignment: alignSure ? (civ.alignment || null) : null,
      vocationLabel: vocSure ? (dos.vocationLabel || null) : null,
      dispositionApprox: dapprox,
      systems: (civ.systems || []).length || (dos.systems || 0),
      source: 'vehryn'
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
    return { ok: true, costCredits: q.costCredits };
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
  function generateRumors(game, r, I) {
    const civs = (game.civs || []).filter(function (c) { return c && c.alive && c.faction !== 'vehryn'; });
    const cands = [];
    let evilPow = 0, goodPow = 0;
    for (let i = 0; i < civs.length; i++) {
      const c = civs[i];
      const power = c.power || 0;
      if (c.alignment === 'male') evilPow += power;
      else if (c.alignment === 'bene') goodPow += power;
      if (c.alignment === 'male' && (c.phase === 'growth' || c.phase === 'rise') && power >= 50) {
        cands.push({ kind: 'threat', civId: c.id, w: 3, make: function (rel) {
          return rel
            ? 'Si dice che ' + c.name + ', una potenza ' + alignWord(c) + ', stia espandendo la propria sfera militare. Tienili d\'occhio.'
            : 'Voci insistenti parlano di una potenza ' + alignWord(c) + ' in ascesa ' + tierWord(c) + ' — i dettagli restano confusi.';
        } });
      }
      if ((c.disposition || 0) >= 25 && (c.vocation === 'mercantili' || c.vocation === 'tecnocratici')) {
        cands.push({ kind: 'opportunity', civId: c.id, w: 2, make: function (rel) {
          return rel
            ? c.name + ' è ben disposta verso di te: un\'intesa commerciale o un\'alleanza potrebbe portarti vantaggi concreti.'
            : 'Gira voce che una civiltà ' + tierWord(c) + ' cerchi partner commerciali affidabili.';
        } });
      }
      if (c.phase === 'decline' || c.phase === 'collapse') {
        cands.push({ kind: 'opportunity', civId: c.id, w: 2, make: function (rel) {
          return rel
            ? c.name + ' è in ' + (c.phase === 'collapse' ? 'pieno collasso' : 'declino') + ': territori e rotte potrebbero presto restare scoperti.'
            : 'Si mormora di un impero ' + tierWord(c) + ' che vacilla — chi arriva primo raccoglie.';
        } });
      }
    }
    cands.push({ kind: 'mood', civId: null, w: 1, make: function () {
      if (evilPow > goodPow * 1.3) return 'Le correnti oscure prevalgono: le potenze maligne pesano più di quelle benevole. Tempi di cautela.';
      if (goodPow > evilPow * 1.3) return 'L\'equilibrio pende verso le potenze benevole: c\'è spazio per alleanze e commerci prosperi.';
      return 'La galassia è in equilibrio precario tra luce e ombra: nessuno schieramento domina, per ora.';
    } });

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
        civId: reliable ? cand.civId : null,
        reliable: reliable,
        text: cand.make(reliable)
      });
    }
    return out;
  }
  function quoteRumor(game) {
    if (!isAvailable(game)) return { ok: false, reason: 'Conclave non disponibile (contatta i Vehryn)' };
    const sc = surcharge(game);
    const cost = Math.round(RUMOR_BASE * (1 + sc));
    return { ok: true, costCredits: cost, surcharge: sc, count: RUMOR_BATCH };
  }
  function buyRumor(game) {
    if (!isAvailable(game)) return { ok: false, reason: 'Conclave non disponibile (contatta i Vehryn)' };
    const I = game.timeImpulsi || 0;
    const r = rngFor(game, 'rumor:' + I);
    const fresh = generateRumors(game, r, I);
    const intel = ensureIntel(game);
    const novel = fresh.filter(function (rm) {
      return !intel.rumors.some(function (x) { return x.text === rm.text; });
    });
    if (!novel.length) return { ok: false, reason: 'Il Conclave non ha voci più fresche per ora — torna più avanti' };
    const sc = surcharge(game);
    const cost = Math.round(RUMOR_BASE * (1 + sc));
    const sp = spend(game, cost);
    if (!sp.ok) return sp;
    for (let i = 0; i < novel.length; i++) intel.rumors.unshift(novel[i]);
    if (intel.rumors.length > RUMOR_MAX_STORED) intel.rumors.length = RUMOR_MAX_STORED;
    return { ok: true, added: novel.length, rumors: novel, costCredits: cost };
  }

  ORION.vehryn = {
    RUMOR_BATCH: RUMOR_BATCH,
    vehrynCiv: vehrynCiv,
    isAvailable: isAvailable,
    surcharge: surcharge,
    ensureIntel: ensureIntel,
    civIdentified: civIdentified,
    quoteLocate: quoteLocate,
    buyLocate: buyLocate,
    quoteProfile: quoteProfile,
    buyProfile: buyProfile,
    quoteRumor: quoteRumor,
    buyRumor: buyRumor
  };
})(typeof window !== 'undefined' ? window : this);
