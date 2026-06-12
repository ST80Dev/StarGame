/* =====================================================================
   ORION EMPIRES — research.js
   Modulo M13 (Fase A): Tecnologia. Design: decisione #57, GDD §11.

   MODELLO "catalogo ampio + sorteggio per-partita" (decisione #57): la
   visione completa è un CATALOGO ampio (8 categorie §11.2) di cui ogni
   partita pesca dal seed solo un sottoinsieme. In FASE A implementiamo SOLO
   l'ossatura garantita — i **punti fermi**: le 5 tech che gatano ganci già
   cablati nel codice, così le funzioni già scritte non restano mai morte.
   Il **pool casuale** (sorteggio per-seed) + i suoi effetti — che per scelta
   dell'utente saranno SOLO modificatori passivi su meccaniche esistenti, mai
   nuove strutture/moduli da gestire — è scope di FASE B (bumperà catalogVersion
   → legacy-snapshot per-partita, come systemAlgVersion #55).

   RICERCA (decisione #57 Q2): pool d'impero distribuito (i laboratori §10 su
   più pianeti contribuiscono insieme, §11.1), UN progetto attivo alla volta.
   `out.rates.research` di ogni colonia (già calcolato in planet.js) finanzia
   il progetto attivo (`fund`), oltre ad accumularsi in `colony.researchAccum`
   per la pista vittoria Ascensione tech (#23, victory.js — invariato).

   I 5 PUNTI FERMI e i loro effetti VERI (cablati ai ganci esistenti):
     · iperguida   → ×1/3 su tempoLeg (fleet.js) + sblocca Mercantile T3 (trade.js)
     · scudi       → sblocca Scudo planetario (structures.js / planet.canBuild)
     · esotici     → sblocca Impianto esotico (structures.js / planet.canBuild)
     · bonifica    → sblocca Centro di ingegneria planetaria (slot, #45)
     · terraform   → sblocca Terraformatori (slot pianeta, #45). GAME-CHANGER:
                     doppia leva (decisione #57) = soglia di ricerca d'impero
                     (`minResearch`) + spesa secca di risorse all'attivazione
                     (`activationCost`, pagata dalla capitale, rimborso pieno
                     se si cambia progetto — recovery-friendly #22).
   Nota: tutti e 5 NON aggiungono micromanagement — o accendono strutture che
   ESISTONO GIÀ in structures.js (decisione #45, tech-gated) o applicano un
   modificatore passivo globale (iperguida). Nessuna nuova scheda da gestire.

   Determinismo (#5): nessun RNG in Fase A (il dado del pool è Fase B). Le
   transizioni sono funzioni pure dello stato. Recovery-friendly (#22): la
   ricerca è una leva, mai un fail-state.
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  const CATALOG_VERSION = 1;       // legacy-snapshot per partita (Fase B bumpa per il pool)
  const HYPER_T1_MUL = 1 / 3;      // iperguida T1: viaggio ×1/3 (decisione #32)

  /* Le 8 categorie §11.2 (il catalogo pieno vive qui; Fase A usa 4 di esse). */
  const CATEGORIES = {
    propulsione:  'Propulsione',
    armi:         'Armi',
    scudi:        'Scudi e armature',
    estrazione:   'Estrazione',
    biologia:     'Biologia',
    costruzione:  'Costruzione',
    informatica:  'Informatica',
    trasferimento:'Trasferimento'
  };

  /* ------------------------------------------------------------------
     CATALOGO FASE A — solo i 5 PUNTI FERMI. Campi tech:
       id          stabile (combacia coi marker `tech:<id>` in structures/trade)
       name/cat    etichetta + categoria §11.2
       cost        punti ricerca per completarla
       requires[]  prerequisiti (altri techId) — depth max ~2
       hidden      §11.1: visibile solo quando i prereq sono sbloccati
       minResearch soglia di ricerca d'impero (game-changer, doppia leva)
       activationCost  spesa secca di risorse all'avvio del progetto (game-changer)
       effect      'iperguida'|'scudi'|'esotici'|'bonifica'|'terraform'
       desc        descrizione breve
     ------------------------------------------------------------------ */
  const CATALOG = [
    {
      id: 'iperguida', name: 'Iperguida I', cat: 'propulsione', cost: 150,
      requires: [], effect: 'iperguida',
      desc: 'Salto iperspaziale di prima generazione: i tempi di viaggio inter-sistema delle flotte scendono a un terzo. Sblocca il Convoglio iperspaziale (Mercantile III).'
    },
    {
      id: 'scudi', name: 'Scudi deflettori', cat: 'scudi', cost: 180,
      requires: [], effect: 'scudi',
      desc: 'Campi di forza planetari: sblocca lo Scudo planetario (difesa §10.2). Non aggiunge gestione: è una struttura che potrai costruire dove serve.'
    },
    {
      id: 'esotici', name: 'Estrazione esotica', cat: 'estrazione', cost: 200,
      requires: [], effect: 'esotici',
      desc: 'Lavorazione dei materiali esotici §7.2: sblocca l\'Impianto esotico.'
    },
    {
      id: 'bonifica-territoriale', name: 'Bonifica territoriale', cat: 'costruzione', cost: 170,
      requires: [], effect: 'bonifica',
      desc: 'Ingegneria del suolo: sblocca il Centro di ingegneria planetaria, che aumenta gli slot di costruzione.'
    },
    {
      id: 'terraformazione', name: 'Terraformazione', cat: 'costruzione', cost: 420,
      requires: ['bonifica-territoriale'], hidden: true,
      minResearch: 600, activationCost: { met: 400, en: 200 },
      effect: 'terraform', gameChanger: true,
      desc: 'Rimodellare un mondo: sblocca i Terraformatori (forte espansione degli slot sui mondi-giardino). Game-changer: richiede ricerca d\'impero avanzata e una spesa di risorse all\'avvio (pagata dalla capitale).'
    }
  ];

  const BY_ID = {};
  CATALOG.forEach(function (t) { BY_ID[t.id] = t; });

  /* ------------------------------------------------------------------
     STATE — game.research = { catalogVersion, unlocked[], activeProject,
                               progress, activationPaid }
     activationPaid = { payerKey, cost } per il rimborso se si cambia progetto.
     ------------------------------------------------------------------ */
  function ensure(game) {
    if (!game) return null;
    if (!game.research || typeof game.research !== 'object') {
      game.research = { catalogVersion: CATALOG_VERSION, unlocked: [], activeProject: null, progress: 0, activationPaid: null };
    }
    const r = game.research;
    if (typeof r.catalogVersion !== 'number') r.catalogVersion = CATALOG_VERSION;
    if (!Array.isArray(r.unlocked)) r.unlocked = [];
    if (r.activeProject === undefined) r.activeProject = null;
    if (typeof r.progress !== 'number') r.progress = 0;
    if (r.activationPaid === undefined) r.activationPaid = null;
    return r;
  }

  /* La tech `id` fa parte del catalogo di questa partita?
     In Fase A: solo i 5 punti fermi (il pool/sorteggio è Fase B). */
  function inGame(game, id) { return !!BY_ID[id]; }

  function isUnlocked(game, id) {
    return !!(game && game.research && game.research.unlocked.indexOf(id) >= 0);
  }

  /* Soglia di ricerca d'impero (lifetime): Σ colony.researchAccum.
     Usata per i game-changer (doppia leva, decisione #57). */
  function empireResearchTotal(game) {
    let sum = 0;
    const cols = (game && game.colonies) || {};
    Object.keys(cols).forEach(function (k) {
      const c = cols[k];
      if (c) sum += c.researchAccum || 0;
    });
    return sum;
  }

  function prereqsMet(game, t) {
    const req = t.requires || [];
    for (let i = 0; i < req.length; i++) {
      if (!isUnlocked(game, req[i])) return false;
    }
    return true;
  }

  /* Visibile in UI (§11.1): nascosta finché i prereq non sono sbloccati. */
  function isVisible(game, t) {
    if (!inGame(game, t.id)) return false;
    if (!t.hidden) return true;
    return prereqsMet(game, t);
  }

  /* Colonia che paga l'activationCost dei game-changer: la capitale del
     gruppo natale (auto-promossa #45); fallback alla home, poi a una colonia
     qualsiasi colonizzata. */
  function payerColonyKey(game) {
    if (game.homePlanetKey && game.colonies && game.colonies[game.homePlanetKey]) {
      return game.homePlanetKey;
    }
    const cols = game.colonies || {};
    const keys = Object.keys(cols);
    for (let i = 0; i < keys.length; i++) {
      if (cols[keys[i]] && cols[keys[i]].colonized) return keys[i];
    }
    return null;
  }

  function canAfford(colony, cost) {
    if (!cost) return true;
    if (!colony || !colony.stock) return false;
    const keys = Object.keys(cost);
    for (let i = 0; i < keys.length; i++) {
      if ((colony.stock[keys[i]] || 0) < cost[keys[i]]) return false;
    }
    return true;
  }

  /* Ricercabile ORA: in gioco, non già sbloccata, prereq + soglia ricerca +
     (per i game-changer) capienza risorse all'avvio. */
  function canResearch(game, id) {
    const t = BY_ID[id];
    if (!t || !inGame(game, id)) return { ok: false, reason: 'Tecnologia non disponibile in questa partita' };
    if (isUnlocked(game, id)) return { ok: false, reason: 'Già sbloccata' };
    if (!prereqsMet(game, t)) {
      const miss = (t.requires || []).filter(function (r) { return !isUnlocked(game, r); })
        .map(function (r) { return (BY_ID[r] || { name: r }).name; });
      return { ok: false, reason: 'Richiede: ' + miss.join(', ') };
    }
    if (t.minResearch && empireResearchTotal(game) < t.minResearch) {
      return { ok: false, reason: 'Richiede ricerca d\'impero ≥ ' + t.minResearch + ' (game-changer)' };
    }
    if (t.activationCost) {
      const payer = payerColonyKey(game);
      if (!payer || !canAfford(game.colonies[payer], t.activationCost)) {
        return { ok: false, reason: 'Costo di attivazione non coperto dalla capitale' };
      }
    }
    return { ok: true };
  }

  /* Stato derivato per la UI: unlocked / active / available / locked / hidden. */
  function statusOf(game, id) {
    if (isUnlocked(game, id)) return 'unlocked';
    if (game.research && game.research.activeProject === id) return 'active';
    const t = BY_ID[id];
    if (t && !isVisible(game, t)) return 'hidden';
    return canResearch(game, id).ok ? 'available' : 'locked';
  }

  /* Catalogo della partita corrente con stato derivato (esclude le tech non
     visibili è scelta della UI; qui le includiamo con visible:false). */
  function catalogFor(game) {
    ensure(game);
    const out = [];
    CATALOG.forEach(function (t) {
      if (!inGame(game, t.id)) return;
      out.push({
        id: t.id, name: t.name, cat: t.cat, catLabel: CATEGORIES[t.cat] || t.cat,
        cost: t.cost, requires: (t.requires || []).slice(),
        gameChanger: !!t.gameChanger, minResearch: t.minResearch || 0,
        activationCost: t.activationCost || null,
        effect: t.effect || null, desc: t.desc || '',
        status: statusOf(game, t.id), visible: isVisible(game, t)
      });
    });
    return out;
  }

  /* Imposta il progetto attivo. Cambiare progetto azzera il progresso del
     precedente (un solo progetto attivo) e rimborsa l'eventuale activationCost
     già pagato. I game-changer pagano l'activationCost all'avvio (rimborso pieno
     in caso di cambio — recovery-friendly #22). */
  function setProject(game, id) {
    ensure(game);
    if (game.research.activeProject === id) return { ok: true };
    const chk = canResearch(game, id);
    if (!chk.ok) return chk;
    /* Rimborsa l'attivazione del progetto precedente (se era un game-changer). */
    refundActivation(game);
    const t = BY_ID[id];
    /* Paga l'activationCost del nuovo progetto (già verificato in canResearch). */
    if (t.activationCost) {
      const payer = payerColonyKey(game);
      const colony = game.colonies[payer];
      Object.keys(t.activationCost).forEach(function (k) {
        colony.stock[k] = (colony.stock[k] || 0) - t.activationCost[k];
      });
      game.research.activationPaid = { payerKey: payer, cost: Object.assign({}, t.activationCost) };
    } else {
      game.research.activationPaid = null;
    }
    game.research.activeProject = id;
    game.research.progress = 0;
    return { ok: true };
  }

  /* Rimborso pieno dell'activationCost al payer (se esiste ancora). */
  function refundActivation(game) {
    const ap = game.research && game.research.activationPaid;
    if (!ap) return;
    const colony = game.colonies && game.colonies[ap.payerKey];
    if (colony && colony.stock) {
      Object.keys(ap.cost).forEach(function (k) {
        colony.stock[k] = (colony.stock[k] || 0) + ap.cost[k];
      });
    }
    game.research.activationPaid = null;
  }

  function clearProject(game) {
    ensure(game);
    refundActivation(game);
    game.research.activeProject = null;
    game.research.progress = 0;
    return { ok: true };
  }

  /* Finanziamento per-tick: i punti di ricerca prodotti alimentano il
     progetto attivo (chiamato da time.js → processProduction per colonia). */
  function fund(game, amount) {
    if (!amount || amount <= 0) return;
    const r = ensure(game);
    if (!r.activeProject) return;
    r.progress = (r.progress || 0) + amount;
  }

  /* Completamento (chiamato 1×/Ι da time.js → tick, dopo il loop colonie).
     L'activationCost NON si rimborsa al completamento (l'hai usata: hai la tech). */
  function tick(game, events) {
    const r = ensure(game);
    if (!r.activeProject) return;
    const t = BY_ID[r.activeProject];
    if (!t) { r.activeProject = null; r.progress = 0; r.activationPaid = null; return; }
    if (r.progress >= t.cost) {
      if (r.unlocked.indexOf(t.id) < 0) r.unlocked.push(t.id);
      r.activeProject = null;
      r.progress = 0;
      r.activationPaid = null;
      if (events) {
        events.push({ kind: 'research-complete', techId: t.id, name: t.name, cat: t.cat,
          effect: t.effect || null, impulso: game.timeImpulsi });
      }
    }
  }

  /* Tasso di ricerca d'impero/Ι = Σ out.rates.research delle colonie.
     Cache su game.research._lastRate (aggiornata dal funding del tick);
     fallback al calcolo on-demand (nextEventImpulsi a gioco fermo). */
  function empireResearchRate(game) {
    if (!game.colonies || !ORION.planet || !ORION.system) return 0;
    let sum = 0;
    Object.keys(game.colonies).forEach(function (k) {
      const c = game.colonies[k];
      if (!c || !c.colonized) return;
      const parts = k.split(':');
      const sys = ORION.system.generate(game.galaxy, Number(parts[0]));
      const planet = ORION.planet.generate(game.galaxy, sys, parts[1]);
      if (!planet) return;
      const out = ORION.planet.structureOutput(c, planet, game, k);
      sum += (out.rates.research || 0);
    });
    return sum;
  }

  /* ETA in Ι al completamento del progetto attivo (per nextEventImpulsi). */
  function etaImpulsi(game) {
    const r = game && game.research;
    if (!r || !r.activeProject) return 0;
    const t = BY_ID[r.activeProject];
    if (!t) return 0;
    let rate = (typeof r._lastRate === 'number' && r._lastRate > 0) ? r._lastRate : empireResearchRate(game);
    if (rate <= 0) return 0;
    const remaining = t.cost - (r.progress || 0);
    if (remaining <= 0) return 1;
    return Math.max(1, Math.ceil(remaining / rate));
  }

  /* ------------------------------------------------------------------
     EFFETTO Fase A letto ai ganci esistenti.
     ------------------------------------------------------------------ */
  /* Moltiplicatore tempo di viaggio (fleet.js → tempoLeg). Iperguida T1 = ×1/3.
     I tier superiori (Iperguida II/III ×1/8, ×1/20, decisione #32) sono Fase B. */
  function hyperMul(game) {
    if (game && game.research && isUnlocked(game, 'iperguida')) return HYPER_T1_MUL;
    return 1;
  }

  ORION.research = {
    CATALOG_VERSION: CATALOG_VERSION,
    CATEGORIES: CATEGORIES,
    ensure: ensure,
    inGame: inGame,
    isUnlocked: isUnlocked,
    prereqsMet: prereqsMet,
    isVisible: isVisible,
    canResearch: canResearch,
    statusOf: statusOf,
    catalogFor: catalogFor,
    setProject: setProject,
    clearProject: clearProject,
    fund: fund,
    tick: tick,
    empireResearchTotal: empireResearchTotal,
    empireResearchRate: empireResearchRate,
    etaImpulsi: etaImpulsi,
    hyperMul: hyperMul,
    payerColonyKey: payerColonyKey,
    get: function (id) { return BY_ID[id] || null; }
  };
})(typeof window !== 'undefined' ? window : this);
