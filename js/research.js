/* =====================================================================
   ORION EMPIRES — research.js
   Modulo M13: Tecnologia. Design: decisione #57, GDD §11.

   MODELLO "catalogo ampio + sorteggio per-partita" (decisione #57): la
   visione completa è un CATALOGO ampio (8 categorie §11.2) di cui ogni
   partita pesca dal seed solo un sottoinsieme. I **punti fermi** (5 tech
   garantite) gatano ganci già cablati nel codice; il **pool** (Fase B) è
   pescato per-seed (~60%, `poolSet`) con effetti SOLO modificatori passivi
   (`mod`) su meccaniche esistenti — vincolo utente: nessuna tech aggiunge
   strutture/moduli da gestire. `catalogVersion` 1 = solo i 5 (partite Fase A);
   2 = 5 + pool (legacy-snapshot per-partita, come systemAlgVersion #55).
   Iperguida II/III estendono `hyperMul`. AI-tech-tier e tech catturabili
   restano Fase B-2; conseguenze narrative §11.3 → M17.

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

  const CATALOG_VERSION = 2;       // Fase B: catalogo + pool. Le partite Fase A (catalogVersion 1) restano coi soli 5 (legacy-snapshot #55).
  const HYPER_T1_MUL = 1 / 3;      // iperguida T1: viaggio ×1/3 (decisione #32)
  const HYPER_T2_MUL = 1 / 8;      // iperguida T2 (Fase B)
  const HYPER_T3_MUL = 1 / 20;     // iperguida T3 (Fase B)
  const POOL_DRAW = 0.6;           // ~60% del pool pescato per-seed (decisione #57)

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
  /* PUNTI FERMI (guaranteed:true): sempre nel catalogo di ogni partita.
     POOL (guaranteed:false): pescato per-seed (~60%) quando catalogVersion≥2.
     Gli effetti del pool sono SOLO modificatori passivi (`mod`) su meccaniche
     esistenti — vincolo utente: nessuna tech aggiunge strutture/moduli da
     gestire. Canali mod (decisione #57 Fase B, set curato ~6-7):
       extractionMul · buildSpeedMul · researchMul · fpMul · hpMul ·
       popGrowthMul · cargoMul · hopBonus  (additivi su base 1, hopBonus intero).
     Le Iperguida II/III non usano `mod`: estendono `hyperMul` (effect hyperN). */
  const CATALOG = [
    /* ---- 5 PUNTI FERMI (garantiti) ---- */
    {
      id: 'iperguida', name: 'Iperguida I', cat: 'propulsione', cost: 150,
      requires: [], effect: 'iperguida', guaranteed: true,
      desc: 'Salto iperspaziale di prima generazione: i tempi di viaggio inter-sistema delle flotte scendono a un terzo. Sblocca il Convoglio iperspaziale (Mercantile III).'
    },
    {
      id: 'scudi', name: 'Scudi deflettori', cat: 'scudi', cost: 180,
      requires: [], effect: 'scudi', guaranteed: true,
      desc: 'Campi di forza planetari: sblocca lo Scudo planetario (difesa §10.2). Non aggiunge gestione: è una struttura che potrai costruire dove serve.'
    },
    {
      id: 'esotici', name: 'Estrazione esotica', cat: 'estrazione', cost: 200,
      requires: [], effect: 'esotici', guaranteed: true,
      desc: 'Lavorazione dei materiali esotici §7.2: sblocca l\'Impianto esotico.'
    },
    {
      id: 'bonifica-territoriale', name: 'Bonifica territoriale', cat: 'costruzione', cost: 170,
      requires: [], effect: 'bonifica', guaranteed: true,
      desc: 'Ingegneria del suolo: sblocca il Centro di ingegneria planetaria, che aumenta gli slot di costruzione.'
    },
    {
      id: 'terraformazione', name: 'Terraformazione', cat: 'costruzione', cost: 420,
      requires: ['bonifica-territoriale'], hidden: true, guaranteed: true,
      minResearch: 600, activationCost: { met: 400, en: 200 },
      effect: 'terraform', gameChanger: true,
      desc: 'Rimodellare un mondo: sblocca i Terraformatori (forte espansione degli slot sui mondi-giardino). Game-changer: richiede ricerca d\'impero avanzata e una spesa di risorse all\'avvio (pagata dalla capitale).'
    },

    /* ---- POOL (pescato per-seed, ~60%): solo modificatori passivi ---- */
    /* Propulsione — Iperguida II/III (estendono hyperMul, non `mod`) */
    {
      id: 'iperguida-2', name: 'Iperguida II', cat: 'propulsione', cost: 320,
      requires: ['iperguida'], effect: 'hyper2',
      desc: 'Seconda generazione di iperguida: i viaggi di flotta scendono a un ottavo del tempo subluce.'
    },
    {
      id: 'iperguida-3', name: 'Iperguida III', cat: 'propulsione', cost: 640,
      requires: ['iperguida-2'], hidden: true, minResearch: 800, gameChanger: true, effect: 'hyper3',
      desc: 'Iperguida di terza generazione: viaggi quasi istantanei su scala galattica (un ventesimo del tempo). Game-changer: richiede ricerca d\'impero avanzata.'
    },
    /* Armi — fpMul */
    {
      id: 'cannoni-massa', name: 'Cannoni a massa', cat: 'armi', cost: 220,
      requires: [], mod: { fpMul: 0.10 },
      desc: 'Acceleratori cinetici: +10% potenza di fuoco a tutte le tue navi in combattimento.'
    },
    {
      id: 'lancio-siluri', name: 'Lanciasiluri pesanti', cat: 'armi', cost: 300,
      requires: ['cannoni-massa'], mod: { fpMul: 0.15 },
      desc: 'Ordigni a lungo raggio: +15% potenza di fuoco aggiuntiva.'
    },
    /* Scudi e armature — hpMul */
    {
      id: 'corazze-composite', name: 'Corazze composite', cat: 'scudi', cost: 220,
      requires: [], mod: { hpMul: 0.12 },
      desc: 'Leghe stratificate: +12% corazza (hp) alle tue navi.'
    },
    {
      id: 'campi-deflettori', name: 'Campi deflettori avanzati', cat: 'scudi', cost: 320,
      requires: ['scudi'], mod: { hpMul: 0.15 },
      desc: 'Schermatura attiva di bordo: +15% resistenza (hp) alle tue navi.'
    },
    /* Estrazione — extractionMul */
    {
      id: 'trivelle-profonde', name: 'Trivelle profonde', cat: 'estrazione', cost: 200,
      requires: [], mod: { extractionMul: 0.10 },
      desc: '+10% alla produzione di risorse base di tutte le colonie.'
    },
    {
      id: 'nano-estrattori', name: 'Nano-estrattori', cat: 'estrazione', cost: 300,
      requires: ['trivelle-profonde'], mod: { extractionMul: 0.15 },
      desc: '+15% aggiuntivo alla produzione di risorse base.'
    },
    /* Biologia — popGrowthMul */
    {
      id: 'agro-sintesi', name: 'Agro-sintesi', cat: 'biologia', cost: 200,
      requires: [], mod: { popGrowthMul: 0.15 },
      desc: '+15% alla velocità di crescita della popolazione.'
    },
    {
      id: 'medicina-avanzata', name: 'Medicina avanzata', cat: 'biologia', cost: 280,
      requires: [], mod: { popGrowthMul: 0.12 },
      desc: '+12% aggiuntivo alla crescita della popolazione.'
    },
    /* Biologia — gestione rifiuti (#48 Fase 1): modificatori passivi sul
       ciclo dei rifiuti (nessuna nuova struttura, vincolo #57). */
    {
      id: 'ecologia', name: 'Ecologia industriale', cat: 'biologia', cost: 240,
      requires: [], mod: { wasteGenMul: -0.25 },
      desc: '−25% rifiuti generati da popolazione e industria.'
    },
    {
      id: 'riciclo-avanzato', name: 'Riciclo avanzato', cat: 'biologia', cost: 320,
      requires: ['ecologia'], mod: { wasteEffMul: 0.40 },
      desc: '+40% capacità di trattamento e resa energetica degli impianti di riciclo.'
    },
    /* Costruzione — buildSpeedMul */
    {
      id: 'architetture-modulari', name: 'Architetture modulari', cat: 'costruzione', cost: 210,
      requires: [], mod: { buildSpeedMul: 0.15 },
      desc: '+15% alla velocità di costruzione delle strutture.'
    },
    {
      id: 'automazione-cantieri', name: 'Automazione dei cantieri', cat: 'costruzione', cost: 300,
      requires: ['architetture-modulari'], mod: { buildSpeedMul: 0.20 },
      desc: '+20% aggiuntivo alla velocità di costruzione.'
    },
    /* Informatica — researchMul */
    {
      id: 'reti-neurali', name: 'Reti neurali', cat: 'informatica', cost: 220,
      requires: [], mod: { researchMul: 0.15 },
      desc: '+15% alla velocità di ricerca (i laboratori rendono di più).'
    },
    {
      id: 'calcolo-quantistico', name: 'Calcolo quantistico', cat: 'informatica', cost: 320,
      requires: ['reti-neurali'], mod: { researchMul: 0.20 },
      desc: '+20% aggiuntivo alla velocità di ricerca.'
    },
    /* Trasferimento — cargo / raggio rotte */
    {
      id: 'container-modulari', name: 'Container modulari', cat: 'trasferimento', cost: 200,
      requires: [], mod: { cargoMul: 0.15 },
      desc: '+15% capacità di carico dei mercantili sulle rotte commerciali.'
    },
    {
      id: 'nav-commerciale', name: 'Navigazione commerciale iperspaziale', cat: 'trasferimento', cost: 280,
      requires: ['iperguida'], mod: { hopBonus: 1 },
      desc: '+1 salto al raggio massimo dei mercantili (rotte più lunghe).'
    }
  ];

  /* ------------------------------------------------------------------
     PACING (richiesta utente 2026-06-13): la ricerca deve essere un
     traguardo d'IMPERO (più colonie + più laboratori che lavorano sullo
     stesso pool, §11.1), non una cosa da una-colonia-early. Due leve:
       - resa per-laboratorio abbassata a ⅓ (structures.js: rates.research 3→1)
       - costi tech ×COST_MUL e soglie game-changer ×MINRES_MUL
     Netto: completare una tech ≈ 9× più lento di prima. Applicato qui in
     un solo punto così vale anche per le tech aggiunte in futuro. Le soglie
     restano facili da ritoccare col playtest (M20).
     ------------------------------------------------------------------ */
  const COST_MUL = 4;     // costo per tech (#87: ×4, ricerca = traguardo d'impero)
  const MINRES_MUL = 3;   // soglia di ricerca d'impero (game-changer)
  CATALOG.forEach(function (t) {
    if (t.cost) t.cost = Math.round(t.cost * COST_MUL);
    if (t.minResearch) t.minResearch = Math.round(t.minResearch * MINRES_MUL);
  });

  const BY_ID = {};
  const POOL_IDS = [];
  CATALOG.forEach(function (t) {
    BY_ID[t.id] = t;
    if (!t.guaranteed) POOL_IDS.push(t.id);
  });
  POOL_IDS.sort();   // ordine stabile per il sorteggio deterministico

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

  /* ------------------------------------------------------------------
     SORTEGGIO PER-SEED (Fase B, decisione #57). Le tech del POOL sono
     "impossibili" in questa partita se non pescate. Il sottoinsieme è
     DETERMINISTICO dal seed (`seed:tech-pool`) e stabile per tutta la
     partita → ri-derivabile al load, niente da persistere oltre a
     catalogVersion (legacy-snapshot #55). Le partite Fase A
     (catalogVersion 1) non hanno pool: solo i 5 punti fermi.
     Pruning a fixpoint: una tech del pool con un prereq di pool NON
     pescato viene tolta (niente rami morti irraggiungibili).
     ------------------------------------------------------------------ */
  function poolSet(game) {
    const r = game && game.research;
    if (!r || (r.catalogVersion || 1) < 2) return {};   // Fase A: nessun pool
    if (r._poolSet && r._poolSeed === game.seed) return r._poolSet;
    const sel = {};
    if (ORION.rng && ORION.rng.makeRng) {
      const rng = ORION.rng.makeRng(String(game.seed) + ':tech-pool');
      POOL_IDS.forEach(function (id) { if (rng.chance(POOL_DRAW)) sel[id] = true; });
    } else {
      POOL_IDS.forEach(function (id) { sel[id] = true; });
    }
    let changed = true;
    while (changed) {
      changed = false;
      POOL_IDS.forEach(function (id) {
        if (!sel[id]) return;
        (BY_ID[id].requires || []).forEach(function (rq) {
          const pt = BY_ID[rq];
          if (pt && !pt.guaranteed && !sel[rq]) { delete sel[id]; changed = true; }
        });
      });
    }
    r._poolSet = sel;
    r._poolSeed = game.seed;
    return sel;
  }

  /* La tech `id` fa parte del catalogo di questa partita? Punti fermi:
     sempre. Pool: solo se pescato per-seed (catalogVersion≥2). */
  function inGame(game, id) {
    const t = BY_ID[id];
    if (!t) return false;
    if (t.guaranteed) return true;
    return !!poolSet(game)[id];
  }

  /* ------------------------------------------------------------------
     MODIFICATORI PASSIVI (Fase B). Aggregati dalle tech sbloccate con
     campo `mod`. Canali moltiplicativi (base 1 + Σ bonus) + hopBonus
     additivo. Letti ai ganci esistenti (un solo punto per canale):
       extractionMul → planet.structureOutput (produzione base)
       buildSpeedMul → time.js (maturazione coda)
       researchMul   → time.js / research (finanziamento progetto)
       fpMul / hpMul → combat.js (forze del giocatore)
       popGrowthMul  → time.js (crescita pop)
       cargoMul / hopBonus → trade.js (mercantili)
     Cache invalidata quando cresce `unlocked` (cresce solo, mai cala). */
  function mods(game) {
    const base = { extractionMul: 1, buildSpeedMul: 1, researchMul: 1, fpMul: 1, hpMul: 1, popGrowthMul: 1, cargoMul: 1, hopBonus: 0, wasteGenMul: 1, wasteEffMul: 1 };
    const r = game && game.research;
    if (!r || !Array.isArray(r.unlocked)) return base;
    if (r._mods && r._modsLen === r.unlocked.length) return r._mods;
    r.unlocked.forEach(function (id) {
      const t = BY_ID[id];
      if (!t || !t.mod) return;
      Object.keys(t.mod).forEach(function (k) {
        if (k === 'hopBonus') base.hopBonus += t.mod[k];
        else base[k] = (base[k] || 1) + t.mod[k];
      });
    });
    r._mods = base;
    r._modsLen = r.unlocked.length;
    return base;
  }

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
    /* Fase B: la tech researchMul accelera anche l'ETA (coerente col funding). */
    return sum * mods(game).researchMul;
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
  /* Moltiplicatore tempo di viaggio (fleet.js → tempoLeg). Iperguida I/II/III
     = ×1/3, ×1/8, ×1/20 (decisione #32). Vince il tier più alto sbloccato. */
  function hyperMul(game) {
    if (!game || !game.research) return 1;
    if (isUnlocked(game, 'iperguida-3')) return HYPER_T3_MUL;
    if (isUnlocked(game, 'iperguida-2')) return HYPER_T2_MUL;
    if (isUnlocked(game, 'iperguida')) return HYPER_T1_MUL;
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
    mods: mods,
    poolSet: poolSet,
    payerColonyKey: payerColonyKey,
    get: function (id) { return BY_ID[id] || null; }
  };
})(typeof window !== 'undefined' ? window : this);
