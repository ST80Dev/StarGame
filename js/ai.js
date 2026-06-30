/* =====================================================================
   ORION EMPIRES — ai.js
   Modulo M10 · CIVILTÀ AI (GDD §13 rifondato — decisione #52).

   === RIFONDAZIONE FASE A (decisione #52) ===
   - **Frammentazione iniziale**: 2-4 imperi consolidati + 10-15 micro-
     civiltà + 4 Costanti (`factions.js`) = ~16-23 fazioni a inizio
     partita (vs 4-5 modello M10-Fase-A precedente).
   - **Vocazione persistente** (8 tipi) come DRIVER del comportamento, non
     solo "expand_chance". Sedentari, Mercantili, Espansionisti,
     Isolazionisti, Predoni, Mistici, Tecnocratici, Imperialisti.
   - **Affinità planetaria** come tratto secondario (6 famiglie):
     Ferrigna/Biotica/Glaciale/Mixta/Ancestrale/Orbitale. Modula la
     scelta di colonizzazione.
   - **Fasi vitali** (growth/rise/stable/decline/collapse) come
     MODULAZIONE: una Sedentaria in decline resta Sedentaria, cede
     pianeti ai bordi.
   - **Proprietà al pianeta** (decisione #52 §9): `civ.planets[]` come
     array di `'sysId:bodyKey'` (canonical, persistito); `civ.systems[]`
     resta come **cache derivata** (unique sysIds, ricalcolata ad ogni
     mutazione) → tutti i consumer esistenti continuano a funzionare.
   - **Calibrazione "calma"** (§13.5): warm-up 500 Ι, ramp ×0.3 nei 2000 Ι
     successivi, EXPAND_CHANCE_BASE 0.005 (vs 0.18 vecchio = 36× più
     lento), WAR_CHANCE 0.015, BIRTH_CHANCE 0.005. Target: ~25% galassia
     occupata a Ι 10000 — il giocatore ha sempre margine.

   === DETERMINISMO (#5/#22) ===
   Zero `Math.random`. Generazione `seed:civs`; tick di sfondo
   `seed:ai:<I>` (globale) + `seed:civ:<id>:<I>` (per civiltà).
   Recovery-friendly: nessuna AI può causare game-over (la pressione
   diretta vive in M09/Fase B).

   === CONFINE FASE A vs FASE B (refactor #52) ===
   Fase A (questa PR): modello dati + 8 vocazioni + 6 affinità + 5 fasi
   + calibrazione calma + 4 Costanti + migrazione schema v12→v13.
   Fase B (PR successiva): coesione di sistema, federazioni emergenti,
   vista Civiltà progressiva (sconosciuta→familiare), tutorial dedicato,
   marker planetari su galaxy-map.
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  /* ------------------------------------------------------------------
     ARCHETIPI di governo (decisione #34 — lessico SW-flavor).
     ------------------------------------------------------------------ */
  const ARCHETYPES = {
    bene: [
      { id: 'confederazione', noun: 'Confederazione' },
      { id: 'federazione',    noun: 'Federazione' },
      { id: 'repubblica',     noun: 'Repubblica' },
      { id: 'ordine',         noun: 'Ordine' }
    ],
    male: [
      { id: 'dominio',   noun: 'Dominio',   direct: true },
      { id: 'impero',    noun: 'Impero',    direct: true },
      { id: 'egemonia',  noun: 'Egemonia',  direct: true },
      { id: 'sindacato', noun: 'Sindacato', direct: true }
    ],
    neutrale: [
      { id: 'lega',      noun: 'Lega' },
      { id: 'consorzio', noun: 'Consorzio' },
      { id: 'concilio',  noun: 'Concilio' }
    ]
  };

  /* Caratteristica narrativa "al primo contatto" — eredità Fase A. La
     **vocazione** (sotto) è il driver vero del comportamento. */
  const TRAITS = {
    bene:     [{ id: 'diplomatici', label: 'Diplomatici, cercano alleanze' },
               { id: 'avanzati',    label: 'Tecnologicamente avanzati' },
               { id: 'mercantili',  label: 'Commercianti pacifici' }],
    male:     [{ id: 'espansionisti', label: 'Espansionisti aggressivi' },
               { id: 'predoni',       label: 'Saccheggiatori' },
               { id: 'spie',          label: 'Ricatti e spionaggio' }],
    neutrale: [{ id: 'opportunisti', label: 'Opportunisti' },
               { id: 'mercenari',    label: 'Mercanti imprevedibili' }]
  };

  /* ------------------------------------------------------------------
     VOCAZIONI (decisione #52 §13.2) — 8 tipi, driver primario del
     comportamento. I `*Mul` modulano CFG base; più alto = più attivo.
     `id` stabile per il save (persistito su civ.vocation).
     ------------------------------------------------------------------ */
  const VOCATIONS = {
    /* hpMul/fpMul/massMul (2026-06-26, opzione A): varianza delle statistiche
       di combattimento per CARATTERE. Spezzano il "tutto multiplo di 182":
       una civ militarista schiera unità più toste e numerose, una pacifica
       più fragili e poche. Composti con i moltiplicatori tech (techCombatMul)
       in materialize() e in aiCombatPowerAt. Centrati su 1.0 = unità "media" (182 P). */
    sedentari:     { weight: 0.25, expandMul: 0.20, warMul: 0.40, diplomatMul: 1.4, hpMul: 1.05, fpMul: 0.85, massMul: 0.85, label: 'Sedentari',     desc: 'Si tengono 2-4 pianeti. Reattivi solo se attaccati.' },
    mercantili:    { weight: 0.15, expandMul: 0.60, warMul: 0.50, diplomatMul: 1.6, hpMul: 0.90, fpMul: 0.80, massMul: 0.90, label: 'Mercantili',    desc: 'Espansione lenta + alleanze + rotte.' },
    espansionisti: { weight: 0.15, expandMul: 1.50, warMul: 1.30, diplomatMul: 0.8, hpMul: 1.05, fpMul: 1.10, massMul: 1.15, label: 'Espansionisti', desc: 'Crescita territoriale attiva. Guerre offensive.' },
    isolazionisti: { weight: 0.12, expandMul: 0.10, warMul: 0.90, diplomatMul: 0.4, hpMul: 1.25, fpMul: 0.95, massMul: 0.90, label: 'Isolazionisti', desc: 'Chiudono confini, attaccano gli intrusi.' },
    predoni:       { weight: 0.10, expandMul: 0.30, warMul: 1.40, diplomatMul: 0.3, hpMul: 0.85, fpMul: 1.25, massMul: 1.10, label: 'Predoni',       desc: 'Razzie sui vicini, taglie e bottino.' },
    mistici:       { weight: 0.10, expandMul: 0.40, warMul: 0.20, diplomatMul: 1.8, hpMul: 0.80, fpMul: 0.70, massMul: 0.80, label: 'Mistici',       desc: 'Convertono i vicini con dispacci. Non militari.' },
    tecnocratici:  { weight: 0.08, expandMul: 0.50, warMul: 0.30, diplomatMul: 1.2, hpMul: 1.15, fpMul: 1.15, massMul: 0.80, label: 'Tecnocratici',  desc: 'Focus tech, alleati di chi ha alta Reputazione.' },
    imperialisti:  { weight: 0.05, expandMul: 1.80, warMul: 1.60, diplomatMul: 0.6, hpMul: 1.20, fpMul: 1.20, massMul: 1.15, label: 'Imperialisti',  desc: 'Variante aggressiva. Rari ma pericolosi.' }
  };
  const VOCATION_IDS = Object.keys(VOCATIONS);

  /* ------------------------------------------------------------------
     AFFINITÀ PLANETARIA (decisione #52 §13.2 trait secondario).
     6 famiglie. `typeWeights` = pesi per i tipi-corpo §6.3. Peso 1.0
     = neutro; più alto = più preferito; più basso = evitato.
     ------------------------------------------------------------------ */
  const AFFINITIES = {
    ferrigna:    { weight: 0.20, label: 'Ferrigna',    typeWeights: { vulcanico: 2.0, desertico: 1.7, terrestre: 0.8, forestale: 0.6, oceanico: 0.7, ghiacciato: 0.8, gassoso: 0.5, luna: 1.0 } },
    biotica:     { weight: 0.20, label: 'Biotica',     typeWeights: { forestale: 2.0, oceanico: 1.7, terrestre: 1.4, desertico: 0.7, vulcanico: 0.5, ghiacciato: 0.6, gassoso: 0.4, luna: 0.6 } },
    glaciale:    { weight: 0.15, label: 'Glaciale',    typeWeights: { ghiacciato: 2.0, oceanico: 1.3, gassoso: 1.0, terrestre: 0.9, forestale: 0.7, desertico: 0.5, vulcanico: 0.5, luna: 1.2 } },
    mixta:       { weight: 0.20, label: 'Mixta',       typeWeights: { terrestre: 1.3, desertico: 1.1, oceanico: 1.1, ghiacciato: 1.0, vulcanico: 1.0, forestale: 1.0, gassoso: 0.9, luna: 0.9 } },
    ancestrale:  { weight: 0.10, label: 'Ancestrale',  typeWeights: { terrestre: 1.5, forestale: 1.3, oceanico: 1.2, desertico: 1.0, vulcanico: 0.8, ghiacciato: 0.8, gassoso: 0.6, luna: 0.8 } },
    orbitale:    { weight: 0.15, label: 'Orbitale',    typeWeights: { gassoso: 2.0, luna: 1.6, ghiacciato: 1.0, vulcanico: 0.8, terrestre: 0.7, desertico: 0.7, forestale: 0.5, oceanico: 0.7 } }
  };
  const AFFINITY_IDS = Object.keys(AFFINITIES);

  /* ------------------------------------------------------------------
     FASI VITALI (decisione #52 §13.4) — modulatore della vocazione.
     Mai sostituiscono il carattere; danno ritmo (espansione/declino).
     ------------------------------------------------------------------ */
  const PHASES = {
    growth:   { expandMul: 1.0, warMul: 1.0, declineLoss: 0,    minDuration: 800 },
    rise:     { expandMul: 1.5, warMul: 1.3, declineLoss: 0,    minDuration: 600 },
    stable:   { expandMul: 0.5, warMul: 0.6, declineLoss: 0,    minDuration: 1200 },
    decline:  { expandMul: 0,   warMul: 0.4, declineLoss: 250,  minDuration: 800 },
    collapse: { expandMul: 0,   warMul: 0,   declineLoss: 80,   minDuration: 400 }
  };
  /* Transizione: probabilità di passare a un'altra fase dopo minDuration. */
  const PHASE_TRANSITIONS = {
    growth:   [{ to: 'rise', p: 0.20 }, { to: 'stable', p: 0.50 }, { to: 'decline', p: 0.10 }],
    rise:     [{ to: 'stable', p: 0.55 }, { to: 'growth', p: 0.30 }, { to: 'decline', p: 0.10 }],
    stable:   [{ to: 'growth', p: 0.25 }, { to: 'rise', p: 0.10 }, { to: 'decline', p: 0.15 }],
    decline:  [{ to: 'collapse', p: 0.35 }, { to: 'stable', p: 0.30 }, { to: 'growth', p: 0.05 }],
    collapse: [{ to: 'decline', p: 0.10 }]
  };

  /* Palette (assegnata alla generazione). */
  const PALETTE = [
    '#e0556e', '#5fa8ff', '#9d7bff', '#3fcaa0',
    '#f0a64a', '#d96bd0', '#7fd0e6', '#c8d24a',
    '#ff8a65', '#6bd0a0', '#bf6bd9', '#5ac9c9',
    '#e8a4ff', '#a0c5ff'
  ];

  const NAME_POOL = [
    'Keth-Var', 'Aethon', 'Serenthal', 'Vorthan', 'Cygnus',
    'Draxis', 'Auvethal', 'Zorvahl', 'Caelum', 'Nexaris', 'Thyssen',
    'Karveth', 'Lirnos', 'Omneth', 'Valdris', 'Skethara', 'Mirvael',
    'Drennan', 'Calvion', 'Ghulvann', 'Serath', 'Vaelith', 'Tharkos',
    'Brevyn', 'Oraxis', 'Quel-Mor', 'Hethrin', 'Yldor', 'Pravon'
  ];

  /* ------------------------------------------------------------------
     CONFIG — calibrazione "calma" (decisione #52 §13.5).
     Numeri tarati perché il giocatore abbia orizzonte ~10000 Ι di
     espansione prima di pressione reale; ~75% libero a Ι 10000.
     ------------------------------------------------------------------ */
  const CFG = {
    /* Cadenza del simulatore (8 Ι, come Fase A originale). */
    AI_EVERY_I: 8,
    /* Warm-up (richiesta utente 2026-06-19: anticipato 500→250 per dare
       tensione un po' prima — pirati/incursioni/espansione). La rampa
       (AI_RAMP ×0.3→1.0) mantiene l'intensità iniziale ridotta. */
    AI_WARMUP_I: 250,
    /* Ramp dopo il warm-up: i primi 2000 Ι hanno chance ×0.3 (decollo
       dolce). Dopo: 1.0 piena. */
    AI_RAMP_DURATION: 2000,
    AI_RAMP_MULTIPLIER: 0.3,

    /* Frammentazione iniziale (§13.1). */
    EMPIRES_RANGE: [2, 4],          // imperi consolidati
    MICROS_RANGE: [10, 15],         // micro-civiltà
    EMPIRE_PLANETS: [5, 12],        // §13.1
    MICRO_PLANETS:  [1, 3],
    POWER_PER_PLANET: 8,

    /* Sfondo (CALMO). */
    POWER_GROWTH: 0.4,
    EXPAND_CHANCE_BASE: 0.005,      // vs vecchio 0.18 → 36× più lento
    WAR_CHANCE: 0.015,
    AIWAR_POWER_PER_LOSS: 6,
    BIRTH_CHANCE: 0.005,
    BIRTH_GRACE_I: 5000,            // nessun nuovo arrampicatore prima
    PIRATE_RAID_CHANCE: 0.06,
    PIRATE_RAIDER_CHANCE: 0.05,
    PIRATE_RAIDER_GRACE: 120,
    RUMOR_EXPAND_CHANCE: 0.30,
    RUMOR_WAR_CHANCE: 0.45,

    /* Disposizione → giocatore */
    DISPOSITION_DRIFT: 0.06,

    /* Phase tick: chance di transizione di fase per civ per AI-tick */
    PHASE_TRANSITION_CHANCE: 0.04,
    PHASE_RUMOR_CHANCE: 0.45,

    /* ICG §5.4 */
    ICG_PER_EVIL_EXPAND: 0.8,
    ICG_PER_GOOD_STABILIZE: 0.5,
    ICG_DECAY: 0.02,

    /* Contatto da presenza (decisione 2026-06-17): una flotta player in
       orbita/docked nel sistema di una civ (o di un covo pirata noto)
       formalizza il contatto in pochi Ι. */
    CONTACT_PRESENCE_I: 4,

    /* Dossier cumulativo (Stadio 1, docs/FLEET_FLOW.md): l'intel si ACCUMULA
       per presenza e persiste tra le visite. La composizione decide la
       VELOCITÀ (non il tetto): rate per Ι = max(FLOOR, score × RATE).
       Soglie livello su `intelProgress`: frammentario >0 · parziale ≥3 ·
       completo ≥6. Persistenza paga: il FLOOR garantisce un guadagno minimo
       a ogni visita → grindabile con flotta minima. (Tunabile in M20.) */
    INTEL_RATE: 0.2,
    INTEL_FLOOR: 0.1,

    /* MOBILITAZIONE (2026-06-26): coefficienti contestuali per stimare la
       forza che una civ schiera SU UN PUNTO PRECISO (colonia/sistema), non
       in astratto. Tutto vive qui — niente magic numbers nei display. */
    MOB: {
      /* Modulatori per stato della relazione vs giocatore. */
      REL: { alliance: 0.0, peace: 0.40, truce: 0.60, war: 1.00, hostile: 0.85 },
      /* Boost mobilitazione per la capitale (planets[0]); altre colonie 1.0. */
      CAPITAL_WEIGHT: 1.5,
      /* Ogni incursione AI inbound già in corso "impegna" N unità che NON
         difendono casa. Penalty espressa in unità (sottratte dal totale). */
      INCURSION_UNIT_COST: 1,
      /* Civ reduce dopo una sconfitta recente: −15% per Ι, con decadimento. */
      LAST_BATTLE_LOSS_PENALTY: 0.85,
      LAST_BATTLE_RECENCY_I: 200
    }
  };

  /* ------------------------------------------------------------------
     SCOPERTA PROGRESSIVA (decisione #52 §13.10) — 5 gradi che la vista
     Civiltà ⬡ usa per dosare le informazioni mostrate. Vivono come campo
     `civ.knowledge` (default 'unknown'), `civ.interactions` (contatore),
     `civ.allianceSince` (Ι), `civ.familiarSince` (Ι, monotono → familiar
     è sticky una volta raggiunto).
     ------------------------------------------------------------------ */
  const KNOWLEDGE = { unknown: 0, spotted: 1, contacted: 2, known: 3, familiar: 4 };
  const KNOWLEDGE_INV = ['unknown', 'spotted', 'contacted', 'known', 'familiar'];
  const KNOWN_INTERACTIONS = 3;
  const FAMILIAR_ALLIANCE_I = 1000;

  function knowledgeRank(civ) {
    if (!civ) return 0;
    return KNOWLEDGE[civ.knowledge || 'unknown'] || 0;
  }
  function bumpKnowledge(civ, level) {
    if (!civ) return false;
    const target = KNOWLEDGE[level];
    if (target == null) return false;
    if (knowledgeRank(civ) >= target) return false;
    civ.knowledge = level;
    if (level === 'contacted' && !civ.contacted) civ.contacted = true;
    return true;
  }
  function addInteraction(civ, n) {
    if (!civ) return;
    civ.interactions = (civ.interactions || 0) + (n || 1);
  }
  /* Promozione esplicita su atto formale. Idempotente. */
  function markContact(game, civ, events, reason) {
    if (!civ) return;
    addInteraction(civ);
    if (bumpKnowledge(civ, 'contacted')) {
      const firstSys = (civ.systems && civ.systems.length) ? civ.systems[0] : null;
      if (events) events.push({
        kind: 'civ-contact', civName: civ.name, civColor: civ.color,
        alignment: civ.alignment, traitLabel: civ.traitLabel,
        regionLabel: firstSys != null ? regionLabelOfSystem(game.galaxy, firstSys) : '—',
        reason: reason || 'formal-contact',
        impulso: game.timeImpulsi || 0
      });
    }
  }

  /* Composizione → intel: classi più grosse + maggior numero = dossier più
     completo. Lookup pesi mantenuto interno (l'AI conosce solo i kind, non
     deve dipendere da fleet.js). */
  const INTEL_SHIP_WEIGHT = {
    explorer: 0.5, caccia: 1, intercettore: 1, corvetta: 2, fregata: 3,
    incrociatore: 5, dreadnought: 6, ammiraglia: 7,
    coloniale: 0, estrattore: 0
  };
  const INTEL_LEVEL = { fragmentary: 1, partial: 2, complete: 3, deep: 4 };
  const INTEL_LEVEL_INV = [null, 'fragmentary', 'partial', 'complete', 'deep'];
  function fleetIntelScore(fleet) {
    if (!fleet || !Array.isArray(fleet.ships)) return 0;
    let s = 0;
    for (let i = 0; i < fleet.ships.length; i++) {
      const k = fleet.ships[i] && fleet.ships[i].kind;
      s += (INTEL_SHIP_WEIGHT[k] != null ? INTEL_SHIP_WEIGHT[k] : 1);
    }
    return s;
  }
  function intelLevelFromScore(score) {
    if (score >= 10) return 'deep';
    if (score >= 6) return 'complete';
    if (score >= 3) return 'partial';
    return 'fragmentary';
  }
  /* Stadio 1 — livello dal progresso cumulativo (vedi CFG.INTEL_RATE/FLOOR).
     Quattro livelli (2026-06-26): aggiunto 'deep' (Approfondito) raggiungibile
     per ricognizione prolungata oppure via Infiltrazione M19. */
  function intelLevelFromProgress(p) {
    if (p >= 10) return 'deep';
    if (p >= 6) return 'complete';
    if (p >= 3) return 'partial';
    return 'fragmentary';
  }
  /* Soglia di score sostenuto richiesta per superare un livello. Sotto la
     soglia, intelProgress viene cappato al limite inferiore del livello
     successivo (un esploratore da solo non chiude "Completo"). */
  const INTEL_SCORE_GATE = { partial: 0, complete: 3, deep: 5 };
  const INTEL_PROGRESS_CAP = { fragmentary: 2.9, partial: 5.9, complete: 9.9 };
  function intelLevelRank(level) { return INTEL_LEVEL[level] || 0; }
  /* Auto-promote: se intelProgress ha superato la soglia del livello successivo
     ma intelLevel non lo riflette (es. infiltrazione vecchia che metteva 6 e
     ora vale per "deep"), allinea senza generare evento. Idempotente. */
  function reconcileIntelLevel(civ) {
    if (!civ) return false;
    const derived = intelLevelFromProgress(civ.intelProgress || 0);
    if (intelLevelRank(derived) > intelLevelRank(civ.intelLevel)) {
      civ.intelLevel = derived;
      return true;
    }
    return false;
  }

  /* Tracciamento permanenza flotte player in sistemi rilevanti. Vive su
     game._presence (lazy, non serializzato — campo derivato).
       presence[civId|nest:sysId] = { sinceI, bestScore }
     Quando (I - sinceI) >= CONTACT_PRESENCE_I scatta il contatto / la
     ricognizione. Se la flotta esce dal sistema l'entry viene rimossa. */
  function ensurePresence(game) {
    if (!game._presence) game._presence = {};
    return game._presence;
  }
  function processPresence(game, events) {
    if (!game || !Array.isArray(game.fleets)) return;
    const I = game.timeImpulsi || 0;
    const presence = ensurePresence(game);

    /* Step 1: raccogli flotte player presenti per sistema con score max. */
    const fleetBySys = {};
    for (let i = 0; i < game.fleets.length; i++) {
      const f = game.fleets[i];
      if (!f || !f.location) continue;
      const st = f.location.status;
      if (st !== 'orbiting' && st !== 'docked') continue;
      const sid = f.location.systemId;
      if (sid == null || sid < 0) continue;
      const sc = fleetIntelScore(f);
      if (fleetBySys[sid] == null || sc > fleetBySys[sid]) fleetBySys[sid] = sc;
    }

    /* Step 2: per ogni civ AI viva, controlla se ha pianeti in un sistema
       con flotta player. Aggiorna timer / score. Se < contacted o intel
       upgradabile, scatta promozione. */
    const civs = game.civs || [];
    const activeKeys = {};
    for (let c = 0; c < civs.length; c++) {
      const civ = civs[c];
      if (!civ || !civ.alive) continue;
      const sysOwned = civ.systems || derivedSystems(civ);
      let bestSys = -1, bestScore = -1;
      for (let s = 0; s < sysOwned.length; s++) {
        const sid = sysOwned[s];
        if (fleetBySys[sid] == null) continue;
        if (fleetBySys[sid] > bestScore) { bestScore = fleetBySys[sid]; bestSys = sid; }
      }
      if (bestSys < 0) continue;
      const key = 'civ:' + civ.id;
      activeKeys[key] = true;
      let entry = presence[key];
      if (!entry || entry.sysId !== bestSys) {
        entry = presence[key] = { sysId: bestSys, sinceI: I };
      }
      /* Accumulo cumulativo (Stadio 1): ogni Ι di presenza aggiunge intel,
         con rate = velocità per composizione, FLOOR = guadagno minimo per
         persistenza. Persiste su civ.intelProgress (additivo, lazy).
         Permanenza cumulata (per L4): civ.intelPresenceI conta gli Ι totali
         in cui hai stazionato in un loro sistema. intelMaxScore = miglior
         score di flotta che hai portato lì (gate composizione per L3/L4). */
      civ.intelProgress = (civ.intelProgress || 0) +
        Math.max(CFG.INTEL_FLOOR, bestScore * CFG.INTEL_RATE);
      civ.intelPresenceI = (civ.intelPresenceI || 0) + 1;
      civ.intelMaxScore = Math.max(civ.intelMaxScore || 0, bestScore);
      /* Cap di progresso per composizione: per superare ogni soglia serve
         almeno una volta una flotta con score adeguato. Esempio: con un solo
         esploratore (score 0.5) il progresso si ferma a 5.9 → resta a Parziale. */
      if (civ.intelMaxScore < INTEL_SCORE_GATE.complete && civ.intelProgress > INTEL_PROGRESS_CAP.partial) {
        civ.intelProgress = INTEL_PROGRESS_CAP.partial;
      } else if (civ.intelMaxScore < INTEL_SCORE_GATE.deep && civ.intelProgress > INTEL_PROGRESS_CAP.complete) {
        civ.intelProgress = INTEL_PROGRESS_CAP.complete;
      }
      const newLevel = intelLevelFromProgress(civ.intelProgress);
      const newRank = intelLevelRank(newLevel);
      const curRank = intelLevelRank(civ.intelLevel);
      if (knowledgeRank(civ) < KNOWLEDGE.contacted) {
        /* Primo contatto: scatta dopo la permanenza minima. */
        if ((I - entry.sinceI) >= CFG.CONTACT_PRESENCE_I) {
          civ.intelLevel = newLevel;
          markContact(game, civ, events, 'presence');
        }
      } else if (newRank > curRank) {
        const prev = civ.intelLevel;
        civ.intelLevel = newLevel;
        if (events) events.push({
          kind: 'civ-intel-upgraded', civName: civ.name, civColor: civ.color, civId: civ.id,
          from: prev || 'fragmentary', to: newLevel,
          regionLabel: regionLabelOfSystem(game.galaxy, bestSys),
          impulso: I
        });
      }
    }

    /* Step 3: covi pirata noti. Stesso pattern. Salviamo intelLevel sul
       nest stesso (additivo, non serializza nulla di nuovo). */
    const nests = (game.piracy && game.piracy.nests) || [];
    for (let n = 0; n < nests.length; n++) {
      const nest = nests[n];
      if (!nest || nest.sysId == null) continue;
      const sc = fleetBySys[nest.sysId];
      if (sc == null) continue;
      const key = 'nest:' + nest.sysId;
      activeKeys[key] = true;
      let entry = presence[key];
      if (!entry) {
        entry = presence[key] = { sysId: nest.sysId, sinceI: I };
      }
      /* Accumulo cumulativo come per le civ (persiste su nest.intelProgress). */
      nest.intelProgress = (nest.intelProgress || 0) +
        Math.max(CFG.INTEL_FLOOR, sc * CFG.INTEL_RATE);
      if ((I - entry.sinceI) < CFG.CONTACT_PRESENCE_I) continue;
      const newLevel = intelLevelFromProgress(nest.intelProgress);
      const newRank = intelLevelRank(newLevel);
      const curRank = intelLevelRank(nest.intelLevel);
      if (newRank > curRank) {
        const prev = nest.intelLevel;
        nest.intelLevel = newLevel;
        if (events) events.push({
          kind: 'pirate-nest-recon', sysId: nest.sysId,
          regionLabel: regionLabelOfSystem(game.galaxy, nest.sysId),
          from: prev || null, to: newLevel,
          impulso: I
        });
      }
    }

    /* Step 4: pulisci entry di sistemi non più presidiati (così al ritorno
       il timer riparte). */
    const keys = Object.keys(presence);
    for (let k = 0; k < keys.length; k++) {
      if (!activeKeys[keys[k]]) delete presence[keys[k]];
    }
  }

  /* Stadio 4 (dossier): stato avanzamento intel per una flotta che orbita un
     sistema con civ AI / covo. `sysIdOverride` proietta su un altro sistema
     (es. anteprima nel modal di riordino) usando comunque lo score della
     flotta. Ritorna null se non applicabile. */
  function intelOutlook(game, fleet, sysIdOverride) {
    if (!game || !fleet || !fleet.location) return null;
    const projecting = (sysIdOverride != null);
    if (!projecting && fleet.location.status === 'in-transit') return null;
    const sysId = projecting ? sysIdOverride : fleet.location.systemId;
    let target = null, kind = null, name = null, id = null;
    const civ = civForSystem(game, sysId);
    if (civ && civ.alive) { target = civ; kind = 'civ'; name = civ.name; id = civ.id; }
    else {
      const nests = (game.piracy && game.piracy.nests) || [];
      for (let i = 0; i < nests.length; i++) {
        if (nests[i] && nests[i].sysId === sysId) { target = nests[i]; kind = 'nest'; name = 'Covo pirata'; id = 'nest:' + sysId; break; }
      }
    }
    if (!target) return null;
    const progress = target.intelProgress || 0;
    const level = intelLevelFromProgress(progress);
    const score = fleetIntelScore(fleet);
    const rate = Math.max(CFG.INTEL_FLOOR, score * CFG.INTEL_RATE);
    /* Quattro livelli (2026-06-26): 3 / 6 / 10. Il "complete" del payload
       resta vero solo a livello 'deep' raggiunto (non più solo dopo i 6). */
    let nextAt = null;
    if (progress < 3) nextAt = 3;
    else if (progress < 6) nextAt = 6;
    else if (progress < 10) nextAt = 10;
    const etaToNext = (nextAt != null && rate > 0) ? Math.ceil((nextAt - progress) / rate) : 0;
    return {
      kind: kind, name: name, id: id, sysId: sysId,
      level: level, progress: progress, nextAt: nextAt,
      rate: rate, etaToNext: etaToNext, complete: (nextAt == null)
    };
  }
  /* Avanzamento automatico contacted→known→familiar. Chiamato a ogni AI-tick
     per ogni civ viva (vedi `tick` sopra). */
  function maybePromoteKnowledge(game, civ, I) {
    const rank = knowledgeRank(civ);
    if (rank >= KNOWLEDGE.familiar) return;
    if (rank < KNOWLEDGE.contacted) return;
    if (rank < KNOWLEDGE.known) {
      if ((civ.interactions || 0) >= KNOWN_INTERACTIONS) bumpKnowledge(civ, 'known');
    }
    if (knowledgeRank(civ) === KNOWLEDGE.known) {
      const isFed = !!civ.federationId;
      const allianceLong = (civ.relation === 'alliance' && civ.allianceSince != null &&
                             (I - civ.allianceSince) >= FAMILIAR_ALLIANCE_I);
      if (isFed || allianceLong) {
        if (bumpKnowledge(civ, 'familiar')) {
          civ.familiarSince = I;
        }
      }
    }
  }

  /* ==================================================================
     HELPERS — sistemi posseduti / mappa proprietà / cache derivata.
     ================================================================== */

  /* Sistemi posseduti dal giocatore (home + colonie attive). */
  function playerSystems(game) {
    const set = new Set();
    if (game.galaxy) set.add(game.galaxy.homeId);
    const cols = game.colonies || {};
    Object.keys(cols).forEach(function (k) {
      const c = cols[k];
      if (!c || !c.colonized) return;
      const colon = k.indexOf(':');
      const sid = colon > 0 ? Number(k.slice(0, colon)) : Number(k);
      if (!isNaN(sid)) set.add(sid);
    });
    return set;
  }

  /* Parsing canonical planetKey "sysId:bodyKey" → { sysId, bodyKey }. */
  function parsePlanetKey(pk) {
    if (typeof pk !== 'string') return null;
    const colon = pk.indexOf(':');
    if (colon <= 0) return null;
    const sid = Number(pk.slice(0, colon));
    if (isNaN(sid)) return null;
    return { sysId: sid, bodyKey: pk.slice(colon + 1) };
  }

  /* Lista (ordinata, deduplicata) di sysId da civ.planets[]. */
  function derivedSystems(civ) {
    if (!civ || !Array.isArray(civ.planets)) return [];
    const seen = {};
    const out = [];
    for (let i = 0; i < civ.planets.length; i++) {
      const p = parsePlanetKey(civ.planets[i]);
      if (!p) continue;
      if (!seen[p.sysId]) { seen[p.sysId] = 1; out.push(p.sysId); }
    }
    return out;
  }

  /* Ricostruisce la cache civ.systems da civ.planets. */
  function rebuildSystemsCache(civ) {
    civ.systems = derivedSystems(civ);
  }

  /* API canonica di mutazione (mantiene cache in sync). */
  function addPlanet(civ, sysId, bodyKey) {
    const key = sysId + ':' + (bodyKey || 'b0');
    if (!Array.isArray(civ.planets)) civ.planets = [];
    if (civ.planets.indexOf(key) >= 0) return key;
    civ.planets.push(key);
    rebuildSystemsCache(civ);
    return key;
  }
  function removePlanet(civ, planetKey) {
    if (!Array.isArray(civ.planets)) { civ.planets = []; civ.systems = []; return; }
    const i = civ.planets.indexOf(planetKey);
    if (i < 0) return;
    civ.planets.splice(i, 1);
    rebuildSystemsCache(civ);
  }
  function removeAllInSystem(civ, sysId) {
    if (!Array.isArray(civ.planets)) { civ.planets = []; civ.systems = []; return 0; }
    const prefix = sysId + ':';
    const before = civ.planets.length;
    civ.planets = civ.planets.filter(function (p) { return p.indexOf(prefix) !== 0; });
    rebuildSystemsCache(civ);
    return before - civ.planets.length;
  }

  function civForSystem(game, sysId) {
    const civs = game.civs || [];
    for (let i = 0; i < civs.length; i++) {
      const c = civs[i];
      if (!c || !c.alive) continue;
      const sys = c.systems || derivedSystems(c);
      if (sys.indexOf(sysId) >= 0) return c;
    }
    return null;
  }

  /* Decisione intra-sistema: trova la civiltà che possiede SPECIFICAMENTE
     quel pianeta. Necessario quando il giocatore impartisce un ordine
     `attack{toSysId, bodyKey}` o `garrison{toSysId, bodyKey}` mirato a
     un pianeta preciso di un sistema condiviso (coabitazione, #52 §13.6).
     Ritorna null se il pianeta non è di alcuna civ AI viva. */
  function civForPlanet(game, sysId, bodyKey) {
    if (sysId == null || bodyKey == null) return null;
    const key = sysId + ':' + String(bodyKey);
    const civs = game.civs || [];
    for (let i = 0; i < civs.length; i++) {
      const c = civs[i];
      if (!c || !c.alive || !Array.isArray(c.planets)) continue;
      if (c.planets.indexOf(key) >= 0) return c;
    }
    return null;
  }

  function groupById(galaxy, gid) {
    const groups = galaxy.groups || [];
    for (let i = 0; i < groups.length; i++) if (groups[i].id === gid) return groups[i];
    return null;
  }
  function regionLabelOfSystem(galaxy, sysId) {
    const s = galaxy.systems[sysId];
    if (!s) return '—';
    const gp = groupById(galaxy, s.cluster);
    return gp ? gp.name : '—';
  }

  function expandableFrontier(game, civ, claimed, players) {
    const galaxy = game.galaxy;
    const out = [];
    const seen = new Set();
    const sys = civ.systems || derivedSystems(civ);
    for (let i = 0; i < sys.length; i++) {
      const s = galaxy.systems[sys[i]];
      if (!s) continue;
      const links = s.links || [];
      for (let j = 0; j < links.length; j++) {
        const nid = links[j];
        if (seen.has(nid)) continue;
        seen.add(nid);
        if (claimed.has(nid) || players.has(nid)) continue;
        out.push(nid);
      }
    }
    return out;
  }

  function borderSystemsBetween(galaxy, civA, civB) {
    const otherSet = new Set(civB.systems || derivedSystems(civB));
    const out = [];
    const sysA = civA.systems || derivedSystems(civA);
    for (let i = 0; i < sysA.length; i++) {
      const s = galaxy.systems[sysA[i]];
      if (!s) continue;
      const links = s.links || [];
      for (let j = 0; j < links.length; j++) {
        if (otherSet.has(links[j])) { out.push(sysA[i]); break; }
      }
    }
    return out;
  }
  function areAdjacent(galaxy, civA, civB) {
    return borderSystemsBetween(galaxy, civA, civB).length > 0;
  }

  function discovered(game, sysId) {
    const disc = game.state && game.state.discovery;
    if (!disc) return false;
    const D = ORION.galaxy && ORION.galaxy.DISCOVERY;
    return disc[sysId] >= (D ? D.DETECTED : 1);
  }

  /* ==================================================================
     GENERAZIONE — `seed:civs`, deterministica, idempotente via ensure().
     ================================================================== */

  function pickWeighted(rng, table, ids) {
    let total = 0;
    for (let i = 0; i < ids.length; i++) total += table[ids[i]].weight || 0;
    let r = rng.float() * total;
    for (let i = 0; i < ids.length; i++) {
      r -= table[ids[i]].weight || 0;
      if (r <= 0) return ids[i];
    }
    return ids[ids.length - 1];
  }

  /* Sceglie body key deterministico per un'espansione (lazy: usa 'b0'
     come default + variazione hash-based per varietà). Quando avremo
     bisogno del tipo reale (Fase B), useremo ORION.system.generate.
     Per ora basta una chiave coerente che non collida con il giocatore. */
  function pickBodyKey(rng, sysId, occupied) {
    /* occupied = set di planet keys già presi nel sistema (dal pool delle
       AI + del giocatore). Per ora ci limitiamo a 'b0'..'b6' rotazione. */
    const bodyIdx = rng.int(0, 6);
    for (let i = 0; i < 7; i++) {
      const idx = (bodyIdx + i) % 7;
      const key = sysId + ':b' + idx;
      if (!occupied || !occupied.has(key)) return 'b' + idx;
    }
    return 'b0';
  }

  function makeCivName(rng, alignment, used) {
    const archPool = ARCHETYPES[alignment];
    const arch = archPool[rng.int(0, archPool.length - 1)];
    const pool = rng.shuffle(NAME_POOL.slice());
    for (let i = 0; i < pool.length; i++) {
      const nm = arch.noun + (arch.direct ? ' ' : ' di ') + pool[i];
      if (!used[nm]) { return { name: nm, archetype: arch, proper: pool[i] }; }
    }
    /* fallback: append index */
    const idx = Object.keys(used).length;
    return { name: arch.noun + ' ' + (arch.direct ? '' : 'di ') + 'X-' + idx, archetype: arch, proper: 'X-' + idx };
  }

  function baseDisposition(alignment) {
    if (alignment === 'bene') return 25;
    if (alignment === 'male') return -25;
    return 0;
  }

  function generate(game) {
    const galaxy = game.galaxy;
    if (!galaxy || !galaxy.groups) return [];
    const rng = ORION.rng.makeRng(galaxy.seed + ':civs');

    /* Conteggi: imperi + micro-civiltà (le 4 Costanti vivono SOPRA in
       factions.js → ensureFactions). */
    const nEmpires = rng.int(CFG.EMPIRES_RANGE[0], CFG.EMPIRES_RANGE[1]);
    const nMicros  = rng.int(CFG.MICROS_RANGE[0],  CFG.MICROS_RANGE[1]);

    const groups = galaxy.groups;
    const homeGroupId = galaxy.homeGroupId;
    const seatGroups = groups.filter(function (g) { return g.id !== homeGroupId; });
    const TIER_RANK = { nucleo: 0, colonie: 1, frontiera: 2, orlo: 3, sconosciuto: 4 };
    seatGroups.sort(function (a, b) {
      return (TIER_RANK[a.tier] || 2) - (TIER_RANK[b.tier] || 2);
    });

    const players = playerSystems(game);
    const claimed = new Set();
    const civs = [];
    const usedNames = {};
    let civCounter = 0;

    /* --- Imperi consolidati: vocazione pesata, sedi nel Nucleo/Colonie. --- */
    for (let e = 0; e < nEmpires; e++) {
      /* Allineamento garantito: alterna mix. */
      const alignment = pickAlignment(e, nEmpires, rng);
      const vocation = pickWeighted(rng, VOCATIONS, VOCATION_IDS);
      const affinity = pickWeighted(rng, AFFINITIES, AFFINITY_IDS);
      const nameSpec = makeCivName(rng, alignment, usedNames);
      usedNames[nameSpec.name] = 1;
      const traitPool = TRAITS[alignment];
      const trait = traitPool[rng.int(0, traitPool.length - 1)];

      /* sede nel Nucleo/Colonie disponibili. */
      let seat = null;
      for (let s = 0; s < seatGroups.length; s++) {
        const g = seatGroups[s];
        if (g.tier === 'nucleo' || g.tier === 'colonie') {
          // gruppo non saturo
          const free = (g.members || []).filter(function (m) { return !claimed.has(m) && !players.has(m); });
          if (free.length >= 2) { seat = g; break; }
        }
      }
      if (!seat) {
        // fallback: qualsiasi gruppo con spazio
        for (let s = 0; s < seatGroups.length; s++) {
          const free = (seatGroups[s].members || []).filter(function (m) { return !claimed.has(m) && !players.has(m); });
          if (free.length >= 1) { seat = seatGroups[s]; break; }
        }
      }
      if (!seat) continue;

      const wantPlanets = rng.int(CFG.EMPIRE_PLANETS[0], CFG.EMPIRE_PLANETS[1]);
      const planets = seedTerritory(galaxy, seat, wantPlanets, claimed, players, rng, true);
      if (!planets.length) continue;

      civs.push(makeCiv({
        id: 'civ-emp-' + civCounter++,
        nameSpec: nameSpec, alignment: alignment, trait: trait,
        vocation: vocation, affinity: affinity,
        seat: seat, established: true, planets: planets, rng: rng
      }));
    }

    /* --- Micro-civiltà: vocazione pesata, sedi su Frontiera/Orlo. --- */
    for (let m = 0; m < nMicros; m++) {
      const rim = seatGroups.filter(function (g) {
        return g.tier === 'frontiera' || g.tier === 'orlo' || g.tier === 'sconosciuto' || g.tier === 'colonie';
      });
      if (!rim.length) break;
      const seat = rim[m % rim.length];
      const free = (seat.members || []).filter(function (id) { return !claimed.has(id) && !players.has(id); });
      if (!free.length) continue;

      const alignment = pickAlignment(m, nMicros, rng);
      const vocation = pickWeighted(rng, VOCATIONS, VOCATION_IDS);
      const affinity = pickWeighted(rng, AFFINITIES, AFFINITY_IDS);
      const nameSpec = makeCivName(rng, alignment, usedNames);
      usedNames[nameSpec.name] = 1;
      const traitPool = TRAITS[alignment];
      const trait = traitPool[rng.int(0, traitPool.length - 1)];

      const wantPlanets = rng.int(CFG.MICRO_PLANETS[0], CFG.MICRO_PLANETS[1]);
      const planets = seedTerritory(galaxy, seat, wantPlanets, claimed, players, rng, false);
      if (!planets.length) continue;

      civs.push(makeCiv({
        id: 'civ-mic-' + civCounter++,
        nameSpec: nameSpec, alignment: alignment, trait: trait,
        vocation: vocation, affinity: affinity,
        seat: seat, established: false, planets: planets, rng: rng
      }));
    }

    /* ICG iniziale (§5.4): basale proporzionale alla forza maligna vs buona. */
    let evil = 0, good = 0;
    civs.forEach(function (c) {
      if (c.alignment === 'male') evil += c.power;
      else if (c.alignment === 'bene') good += c.power;
    });
    const total = Math.max(1, evil + good);
    game.icg = Math.round(Math.max(8, Math.min(55, 25 + (evil - good) / total * 30)));

    /* Pirati: covi nei sistemi ad alto pericolo non posseduti. */
    game.piracy = { nests: seedPirateNests(game, rng, claimed, players) };

    return civs;
  }

  function pickAlignment(idx, total, rng) {
    /* Garantisci mix: prime 3 sono bene/male/neutrale (ciclo), poi peso. */
    if (idx === 0) return 'bene';
    if (idx === 1) return 'male';
    if (idx === 2) return 'neutrale';
    const r = rng.float();
    if (r < 0.35) return 'bene';
    if (r < 0.65) return 'male';
    return 'neutrale';
  }

  /* Semina territorio per una civ: parte da un sistema della sede non
     posseduto, cresce per adiacenza BFS. Restituisce array di planet keys
     ("sysId:bodyKey"). Aggiorna `claimed` (set di sysId). */
  function seedTerritory(galaxy, seat, wantPlanets, claimed, players, rng, preferSameGroup) {
    const seatSystems = (seat.members || []).slice().sort(function (a, b) { return a - b; });
    const owned = [];
    let seedSys = -1;
    for (let s = 0; s < seatSystems.length; s++) {
      const sid = seatSystems[s];
      if (!claimed.has(sid) && !players.has(sid)) { seedSys = sid; break; }
    }
    if (seedSys < 0) return [];
    owned.push(seedSys); claimed.add(seedSys);

    let guard = 0;
    /* Convertiamo wantPlanets in target sistemi: ~1.4 planet/system,
       quindi targetSystems = ceil(wantPlanets/1.4). */
    const wantSys = Math.max(1, Math.ceil(wantPlanets / 1.4));
    while (owned.length < wantSys && guard < 200) {
      guard++;
      const cands = [];
      for (let o = 0; o < owned.length; o++) {
        const s = galaxy.systems[owned[o]];
        if (!s) continue;
        const links = s.links || [];
        for (let l = 0; l < links.length; l++) {
          const nid = links[l];
          if (claimed.has(nid) || players.has(nid)) continue;
          cands.push(nid);
        }
      }
      if (!cands.length) break;
      cands.sort(function (a, b) {
        if (preferSameGroup) {
          const sa = galaxy.systems[a].cluster === seat.id ? 0 : 1;
          const sb = galaxy.systems[b].cluster === seat.id ? 0 : 1;
          return sa - sb || a - b;
        }
        return a - b;
      });
      const pick = cands[0];
      owned.push(pick); claimed.add(pick);
    }

    /* Genera planet keys: 1 pianeta per sistema + qualche sistema con 2 */
    const planets = [];
    for (let i = 0; i < owned.length; i++) {
      const sid = owned[i];
      planets.push(sid + ':b0');
      // 25% chance di un secondo pianeta nello stesso sistema (doppio prime/marginale)
      if (rng.chance(0.25) && planets.length < wantPlanets) {
        planets.push(sid + ':b1');
      }
      if (planets.length >= wantPlanets) break;
    }
    return planets;
  }

  function makeCiv(opts) {
    const civ = {
      id: opts.id,
      name: opts.nameSpec.name,
      archetype: opts.nameSpec.archetype.id,
      archetypeLabel: opts.nameSpec.archetype.noun,
      alignment: opts.alignment,
      trait: opts.trait.id,
      traitLabel: opts.trait.label,
      vocation: opts.vocation,
      affinity: opts.affinity,
      phase: 'growth',
      phaseSince: 0,
      color: PALETTE[Math.abs(hashCode(opts.id)) % PALETTE.length],
      homeGroupId: opts.seat.id,
      homeTier: opts.seat.tier,
      established: opts.established,
      planets: opts.planets,
      systems: [],
      power: opts.planets.length * CFG.POWER_PER_PLANET,
      disposition: baseDisposition(opts.alignment),
      relation: 'peace',
      contacted: false,
      alive: true,
      bornAt: 0
    };
    rebuildSystemsCache(civ);
    return civ;
  }

  function hashCode(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) { h = ((h << 5) - h + str.charCodeAt(i)) | 0; }
    return h;
  }

  function seedPirateNests(game, rng, claimed, players) {
    const galaxy = game.galaxy;
    const cand = [];
    for (let i = 0; i < galaxy.systems.length; i++) {
      const s = galaxy.systems[i];
      if (claimed.has(i) || players.has(i)) continue;
      if ((s.danger || 0) >= 60) cand.push(i);
    }
    rng.shuffle(cand);
    const k = Math.min(cand.length, rng.int(2, 4));
    const nests = [];
    for (let i = 0; i < k; i++) nests.push({ sysId: cand[i], level: 1 });
    return nests;
  }

  /* ==================================================================
     ENSURE — chiamato a boot / load. Idempotente.
     - Crea civs se mancanti (newGame)
     - Migra civs legacy (civ.systems senza civ.planets)
     - Assicura vocation/affinity/phase su tutte
     - Spawn 4 Costanti via factions.js (idempotente)
     ================================================================== */
  function ensure(game) {
    if (!game || !game.galaxy) return;

    if (!Array.isArray(game.civs) || !game.civs.length) {
      game.civs = generate(game);
    }

    /* Migra civs legacy + normalizza. */
    const galaxy = game.galaxy;
    const migrateRng = ORION.rng.makeRng(galaxy.seed + ':civ-migrate');
    for (let i = 0; i < game.civs.length; i++) {
      const c = game.civs[i];
      if (!c) continue;
      migrateLegacyCiv(c, galaxy, migrateRng);
    }

    /* Spawn 4 Costanti (idempotente). */
    if (ORION.factions && ORION.factions.ensureFactions) {
      ORION.factions.ensureFactions(game);
    }

    if (game.icg == null) game.icg = 20;
    if (!game.piracy || !Array.isArray(game.piracy.nests)) {
      game.piracy = { nests: [] };
    }
  }

  /* Converte una civ legacy (civ.systems senza civ.planets) al nuovo
     modello; assicura vocation/affinity/phase. Idempotente. */
  function migrateLegacyCiv(civ, galaxy, rng) {
    if (!Array.isArray(civ.planets) || !civ.planets.length) {
      if (Array.isArray(civ.systems) && civ.systems.length) {
        // Conversione deterministica: ogni sysId → 1 planet key 'sysId:b0'
        // (lazy: niente lookup body reale; sufficiente per la semantica).
        civ.planets = civ.systems.map(function (s) { return s + ':b0'; });
      } else {
        civ.planets = [];
      }
    }
    rebuildSystemsCache(civ);

    /* Assegna vocation/affinity deterministiche se mancanti. RNG seed
       ancorato a civ.id → stabilità tra session/load. */
    if (!civ.vocation || !VOCATIONS[civ.vocation]) {
      const lrng = ORION.rng.makeRng(galaxy.seed + ':legacy-voc:' + civ.id);
      /* Inferisci dalla trait esistente quando possibile. */
      const tInf = inferVocationFromTrait(civ.trait, civ.alignment);
      civ.vocation = tInf || pickWeighted(lrng, VOCATIONS, VOCATION_IDS);
    }
    if (!civ.affinity || !AFFINITIES[civ.affinity]) {
      const lrng = ORION.rng.makeRng(galaxy.seed + ':legacy-aff:' + civ.id);
      civ.affinity = pickWeighted(lrng, AFFINITIES, AFFINITY_IDS);
    }
    if (!civ.phase || !PHASES[civ.phase]) civ.phase = 'growth';
    if (civ.phaseSince == null) civ.phaseSince = 0;
    if (!civ.relation) civ.relation = 'peace';
    if (civ.disposition == null) civ.disposition = baseDisposition(civ.alignment);
    /* M10 Fase B punto 2 (decisione #52 §13.10): inizializza il grado di
       scoperta. Save legacy che avevano `civ.contacted=true` partono come
       'contacted' (interazione minima 1); gli altri come 'unknown'. */
    if (!civ.knowledge) {
      civ.knowledge = civ.contacted ? 'contacted' : 'unknown';
    }
    if (civ.interactions == null) {
      civ.interactions = civ.contacted ? 1 : 0;
    }
  }

  function inferVocationFromTrait(trait, alignment) {
    const map = {
      espansionisti: 'espansionisti',
      predoni:       'predoni',
      mercantili:    'mercantili',
      avanzati:      'tecnocratici',
      diplomatici:   'sedentari',
      spie:          'imperialisti',
      opportunisti:  'mercantili',
      mercenari:     'predoni'
    };
    return map[trait] || null;
  }

  /* ==================================================================
     SIMULAZIONE DI SFONDO — tick(game, events). Cadenza AI_EVERY_I,
     warm-up AI_WARMUP_I, ramp AI_RAMP_DURATION.
     ================================================================== */
  function tick(game, events) {
    if (!game || !Array.isArray(game.civs)) return;
    const I = game.timeImpulsi || 0;
    if (I < CFG.AI_WARMUP_I) return;
    if ((I % CFG.AI_EVERY_I) !== 0) return;

    const galaxy = game.galaxy;
    const players = playerSystems(game);
    const grng = ORION.rng.makeRng(galaxy.seed + ':ai:' + I);

    /* Ramp multiplier: nei primi 2000 Ι dopo warm-up, le chance sono ×0.3. */
    const sinceWarmup = I - CFG.AI_WARMUP_I;
    const rampMul = sinceWarmup < CFG.AI_RAMP_DURATION
      ? CFG.AI_RAMP_MULTIPLIER + (1 - CFG.AI_RAMP_MULTIPLIER) * (sinceWarmup / CFG.AI_RAMP_DURATION)
      : 1.0;

    /* Set sistemi posseduti (aggiornato durante il passo). */
    const claimed = new Set();
    game.civs.forEach(function (c) {
      if (c.alive) (c.systems || derivedSystems(c)).forEach(function (s) { claimed.add(s); });
    });

    let icgDelta = 0;

    /* --- Per civiltà --- */
    for (let i = 0; i < game.civs.length; i++) {
      const civ = game.civs[i];
      if (!civ.alive) continue;
      const crng = ORION.rng.makeRng(galaxy.seed + ':civ:' + civ.id + ':' + I);
      const voc = VOCATIONS[civ.vocation] || VOCATIONS.sedentari;
      const phase = PHASES[civ.phase] || PHASES.growth;

      /* Crescita potenza modulata da fase. */
      civ.power += CFG.POWER_GROWTH * (civ.planets || []).length * phase.expandMul;

      /* Espansione: chance modulata da vocazione + fase + ramp + faction. */
      const factionDef = civ.faction && ORION.factions ? ORION.factions.byId(civ.faction) : null;
      const factionExpMul = factionDef ? factionDef.expandMul : 1.0;
      let expandChance = CFG.EXPAND_CHANCE_BASE * voc.expandMul * phase.expandMul * factionExpMul * rampMul;
      if (!civ.established) expandChance *= 1.3;
      if (crng.chance(expandChance)) {
        const frontier = expandableFrontier(game, civ, claimed, players);
        if (frontier.length) {
          frontier.sort(function (a, b) { return a - b; });
          // affinità: peso opzionale (richiede inspectBodyType lazy, Fase B)
          const target = frontier[crng.int(0, frontier.length - 1)];
          const bodyKey = pickBodyKey(crng, target, null);
          addPlanet(civ, target, bodyKey);
          claimed.add(target);
          civ.power += CFG.POWER_PER_PLANET * 0.7;
          if (civ.alignment === 'male') icgDelta += CFG.ICG_PER_EVIL_EXPAND;
          else if (civ.alignment === 'bene') icgDelta -= CFG.ICG_PER_GOOD_STABILIZE;
          if (crng.chance(CFG.RUMOR_EXPAND_CHANCE) && discovered(game, target)) {
            events.push({
              kind: 'civ-expand', civName: civ.name, civColor: civ.color,
              alignment: civ.alignment,
              regionLabel: regionLabelOfSystem(galaxy, target),
              impulso: I
            });
          }
        }
      }

      /* Declino: perdita pianeti ai bordi nelle fasi decline/collapse. */
      if (phase.declineLoss > 0 && civ.planets.length > 1) {
        // (impulse-based: la perdita scatta ogni `declineLoss` Ι; controllo
        //  semplificato a probabilità per AI-tick)
        const lossChance = CFG.AI_EVERY_I / phase.declineLoss;
        if (crng.chance(lossChance)) {
          // perde il pianeta di confine "più esposto" (idx maggiore per
          // semplicità — è una scelta deterministica recovery-friendly)
          const lostKey = civ.planets[civ.planets.length - 1];
          const lostInfo = parsePlanetKey(lostKey);
          removePlanet(civ, lostKey);
          if (lostInfo) claimed.delete(lostInfo.sysId);  // ricontrolla i sysId
          civ.systems.forEach(function (s) { claimed.add(s); });
          civ.power = Math.max(0, civ.power - CFG.POWER_PER_PLANET * 0.5);
          if (civ.planets.length === 0) {
            civ.alive = false;
            events.push({ kind: 'civ-fallen', civName: civ.name, conqueror: 'il declino interno', impulso: I });
          }
        }
      }

      /* Fasi vitali: transizione probabilistica. */
      if (!civ.vocationLocked) maybePhaseTransition(civ, I, crng, events);

      /* Disposizione → giocatore. */
      driftDisposition(game, civ);

      /* M10 Fase B punto 2 (decisione #52 §13.10): scoperta progressiva
         a 5 gradi (unknown → spotted → contacted → known → familiar).
         Avvistare un sistema della civiltà la promuove a 'spotted' (chip
         "Avvistata" nella vista Civiltà ⬡). Il "contatto formale" si
         consuma quando arriva un atto vero (diplomazia/battaglia/incursione,
         vedi markContact altrove). */
      if (knowledgeRank(civ) < KNOWLEDGE.spotted && civSeenByPlayer(game, civ)) {
        bumpKnowledge(civ, 'spotted');
        const firstSys = (civ.systems && civ.systems.length) ? civ.systems[0] : null;
        events.push({
          kind: 'civ-spotted', civName: civ.name, civColor: civ.color,
          alignment: civ.alignment,
          regionLabel: firstSys != null ? regionLabelOfSystem(galaxy, firstSys) : '—',
          impulso: I
        });
      }
      /* Vehryn = informatori/archeologi (decisione utente 2026-06-30): scoprire
         uno dei loro avamposti apre SUBITO un canale. Diversamente dalle altre
         civ (dove "spotted" resta tale finché non c'è un atto formale), il
         Conclave si fa vivo da sé → promozione diretta a "contattato" (sblocca
         diplomazia + vendita informazioni §15.5e). Idempotente: se già ≥
         contacted, no-op. */
      if (civ.faction === 'vehryn' && knowledgeRank(civ) === KNOWLEDGE.spotted) {
        markContact(game, civ, events, 'vehryn-network');
      }
      /* Auto-promozione di grado in base alle interazioni accumulate. */
      maybePromoteKnowledge(game, civ, I);
    }

    /* --- Guerra AI-vs-AI (calma) --- */
    if (grng.chance(rampMul)) maybeWar(game, grng, events, function (d) { icgDelta += d; });

    /* --- Nascita arrampicatore (rara, post-grazia) --- */
    if (I >= CFG.BIRTH_GRACE_I) maybeBirth(game, grng, claimed, players, events);

    /* --- Pirati: razzia atmosferica + raider --- */
    maybePirateRaid(game, grng, events);
    maybePirateRaider(game, grng, events);

    /* --- M09: incursioni pirata + AI di conquista (invariate) --- */
    maybePirateIncursion(game, grng, events);
    maybeAiIncursion(game, grng, events);

    /* --- ICG: applica + decadimento dolce. ---
       M18 bridge: ogni figura Integerrimo a rango Console in servizio
       potenzia il decadimento verso il basale (+0.005/figura), narrativamente
       "amministratore incorruttibile contrasta la corruzione galattica". */
    if (game.icg == null) game.icg = 20;
    game.icg += icgDelta;
    const CF = ORION.colonyFigure;
    const icgDecayBonus = (CF && CF.icgDecayBonusFromFigures) ? CF.icgDecayBonusFromFigures(game) : 0;
    game.icg += (20 - game.icg) * (CFG.ICG_DECAY + icgDecayBonus);
    game.icg = Math.max(0, Math.min(100, game.icg));

    /* --- Fase B (decisione #52 §13.6 §13.8): coesione di sistema +
       federazioni emergenti. Entrambi i moduli sono PURI consumer dello
       stato `game.civs`/`game.colonies` — vivono sul tick AI per cadenza
       coerente (8 Ι). --- */
    if (ORION.cohesion && ORION.cohesion.tick) ORION.cohesion.tick(game, events);
    if (ORION.federations && ORION.federations.tick) ORION.federations.tick(game, events);
  }

  function maybePhaseTransition(civ, I, rng, events) {
    const phase = PHASES[civ.phase] || PHASES.growth;
    const sinceTransition = I - (civ.phaseSince || 0);
    if (sinceTransition < phase.minDuration) return;
    if (!rng.chance(CFG.PHASE_TRANSITION_CHANCE)) return;
    const trans = PHASE_TRANSITIONS[civ.phase] || [];
    if (!trans.length) return;
    let total = 0;
    for (let i = 0; i < trans.length; i++) total += trans[i].p;
    let r = rng.float() * total;
    let next = trans[0].to;
    for (let i = 0; i < trans.length; i++) {
      r -= trans[i].p;
      if (r <= 0) { next = trans[i].to; break; }
    }
    if (next === civ.phase) return;
    civ.phase = next;
    civ.phaseSince = I;
    if (rng.chance(CFG.PHASE_RUMOR_CHANCE)) {
      events.push({
        kind: 'civ-phase', civName: civ.name, civColor: civ.color,
        phase: next, alignment: civ.alignment, impulso: I
      });
    }
  }

  /* ==================================================================
     DISPOSIZIONE / PRIMO CONTATTO — invariati nella sostanza.
     ================================================================== */
  function driftDisposition(game, civ) {
    const tracks = game.victoryTracks || {};
    const light = tracks.reputationLight || 0;
    const dark = tracks.reputationDark || 0;
    let target = baseDisposition(civ.alignment);
    if (civ.alignment === 'bene') target += light * 40 - dark * 40;
    else if (civ.alignment === 'male') target += dark * 35 - light * 25;
    else target += (light - dark) * 15;
    if (civBordersPlayer(game, civ)) {
      target += (civ.alignment === 'male') ? -10 : (civ.alignment === 'bene' ? 6 : 0);
    }
    if (ORION.diplomacy && ORION.diplomacy.relationDispositionBias) {
      target += ORION.diplomacy.relationDispositionBias(civ);
    }
    target = Math.max(-100, Math.min(100, target));
    civ.disposition += (target - civ.disposition) * CFG.DISPOSITION_DRIFT;
    civ.disposition = Math.max(-100, Math.min(100, civ.disposition));
  }
  function civBordersPlayer(game, civ) {
    const galaxy = game.galaxy;
    const players = playerSystems(game);
    const sys = civ.systems || derivedSystems(civ);
    for (let i = 0; i < sys.length; i++) {
      const s = galaxy.systems[sys[i]];
      if (!s) continue;
      const links = s.links || [];
      for (let j = 0; j < links.length; j++) if (players.has(links[j])) return true;
    }
    return false;
  }
  function civSeenByPlayer(game, civ) {
    const sys = civ.systems || derivedSystems(civ);
    for (let i = 0; i < sys.length; i++) if (discovered(game, sys[i])) return true;
    return false;
  }

  /* ==================================================================
     GUERRA AI-vs-AI (calma + vocazione)
     ================================================================== */
  function maybeWar(game, rng, events, addIcg) {
    /* Chance globale modulata dalla MEDIA delle warMul delle civs vive
       — galassie di Mistici/Sedentari fanno meno guerre, di Predoni più. */
    const live = game.civs.filter(function (c) { return c.alive && (c.planets || []).length; });
    if (live.length < 2) return;
    let warMulSum = 0;
    for (let i = 0; i < live.length; i++) {
      const v = VOCATIONS[live[i].vocation] || VOCATIONS.sedentari;
      const p = PHASES[live[i].phase] || PHASES.growth;
      warMulSum += v.warMul * p.warMul;
    }
    const warMulAvg = warMulSum / live.length;
    if (!rng.chance(CFG.WAR_CHANCE * warMulAvg)) return;

    const galaxy = game.galaxy;
    /* coppie adiacenti con frizione (vocazione, allineamento). */
    const pairs = [];
    for (let a = 0; a < live.length; a++) {
      for (let b = a + 1; b < live.length; b++) {
        const A = live[a], B = live[b];
        // pacifici (mistici/sedentari) raramente attaccano
        const aV = VOCATIONS[A.vocation], bV = VOCATIONS[B.vocation];
        if ((aV && aV.warMul < 0.3) && (bV && bV.warMul < 0.3)) continue;
        const friction = (A.alignment === 'male' || B.alignment === 'male')
          || (A.alignment !== B.alignment);
        if (!friction) continue;
        if (areAdjacent(galaxy, A, B)) pairs.push([A, B]);
      }
    }
    if (!pairs.length) return;
    const pair = pairs[rng.int(0, pairs.length - 1)];

    let attacker = pair[0], defender = pair[1];
    if (defender.power > attacker.power) { const t = attacker; attacker = defender; defender = t; }

    const dborder = borderSystemsBetween(galaxy, defender, attacker);
    if (!dborder.length) return;
    dborder.sort(function (x, y) { return x - y; });
    const seenBorder = dborder.filter(function (s) { return discovered(game, s); });
    const witnessed = seenBorder.length > 0 && !!root.ORION.combat;
    const contested = witnessed
      ? seenBorder[rng.int(0, seenBorder.length - 1)]
      : dborder[rng.int(0, dborder.length - 1)];

    let attackerWon, report = null;
    if (witnessed) {
      const C = root.ORION.combat;
      const A = C.forceFromMaterialized(materialize(game, attacker, contested), 'A');
      const B = C.forceFromMaterialized(materialize(game, defender, contested), 'B');
      const battleId = 'aiwar:' + attacker.id + ':' + defender.id + ':' + contested + ':' + (game.timeImpulsi || 0);
      report = C.resolve(game, battleId, A, B);
      attackerWon = (report.winner === 'A');
      attacker.power = Math.max(0, attacker.power - report.sideA.lost * CFG.AIWAR_POWER_PER_LOSS);
      defender.power = Math.max(0, defender.power - report.sideB.lost * CFG.AIWAR_POWER_PER_LOSS);
    } else {
      const pWin = attacker.power / Math.max(1, attacker.power + defender.power);
      attackerWon = !(rng.float() > pWin * 1.1);
    }

    let winner, loser;
    if (attackerWon) {
      // L'attaccante conquista TUTTI i pianeti del difensore nel sistema conteso
      removeAllInSystem(defender, contested);
      addPlanet(attacker, contested, 'b0');
      attacker.power += CFG.POWER_PER_PLANET * 0.7;
      defender.power = Math.max(0, defender.power - CFG.POWER_PER_PLANET);
      if (attacker.alignment === 'male') addIcg(CFG.ICG_PER_EVIL_EXPAND);
      winner = attacker; loser = defender;
    } else {
      winner = defender; loser = attacker;
      if (!witnessed) {
        const aborder = borderSystemsBetween(galaxy, attacker, defender);
        if (aborder.length) {
          aborder.sort(function (x, y) { return x - y; });
          const taken = aborder[rng.int(0, aborder.length - 1)];
          removeAllInSystem(attacker, taken);
          addPlanet(defender, taken, 'b0');
          defender.power += CFG.POWER_PER_PLANET * 0.7;
          attacker.power = Math.max(0, attacker.power - CFG.POWER_PER_PLANET);
          if (defender.alignment === 'male') addIcg(CFG.ICG_PER_EVIL_EXPAND);
        }
      }
    }

    if (witnessed) {
      events.push({
        kind: 'civ-battle',
        attacker: attacker.name, attackerColor: attacker.color,
        defender: defender.name, defenderColor: defender.color,
        outcome: attackerWon ? 'taken' : 'held',
        systemId: contested, systemName: (galaxy.systems[contested] || {}).name,
        regionLabel: regionLabelOfSystem(galaxy, contested),
        lostA: report.sideA.lost, lostB: report.sideB.lost, rounds: report.rounds,
        impulso: game.timeImpulsi
      });
    } else if (rng.chance(CFG.RUMOR_WAR_CHANCE)) {
      events.push({
        kind: 'civ-war', winner: winner.name, winnerColor: winner.color,
        loser: loser.name, regionLabel: regionLabelOfSystem(galaxy, contested),
        impulso: game.timeImpulsi
      });
    }

    [attacker, defender].forEach(function (civ) {
      if (civ.alive && (civ.planets || []).length === 0) {
        civ.alive = false;
        const conq = (civ === attacker) ? defender : attacker;
        events.push({
          kind: 'civ-fallen', civName: civ.name, conqueror: conq.name,
          impulso: game.timeImpulsi
        });
      }
    });
  }

  function maybeBirth(game, rng, claimed, players, events) {
    if (!rng.chance(CFG.BIRTH_CHANCE)) return;
    const galaxy = game.galaxy;
    const rim = (galaxy.groups || []).filter(function (g) {
      return g.tier === 'frontiera' || g.tier === 'orlo' || g.tier === 'sconosciuto';
    });
    if (!rim.length) return;
    const grp = rim[rng.int(0, rim.length - 1)];
    const free = (grp.members || []).filter(function (s) {
      return !claimed.has(s) && !players.has(s);
    });
    if (!free.length) return;
    free.sort(function (a, b) { return a - b; });
    const seedSys = free[0];

    const alignment = rng.chance(0.6) ? 'male' : 'neutrale';
    const used = {}; game.civs.forEach(function (c) { used[c.name] = 1; });
    const nameSpec = makeCivName(rng, alignment, used);
    const traitPool = TRAITS[alignment];
    const trait = traitPool[rng.int(0, traitPool.length - 1)];
    const vocation = pickWeighted(rng, VOCATIONS, VOCATION_IDS);
    const affinity = pickWeighted(rng, AFFINITIES, AFFINITY_IDS);

    const civ = makeCiv({
      id: 'civ-' + game.civs.length + '-' + (game.timeImpulsi || 0),
      nameSpec: nameSpec, alignment: alignment, trait: trait,
      vocation: vocation, affinity: affinity,
      seat: grp, established: false,
      planets: [seedSys + ':b0'], rng: rng
    });
    civ.bornAt = game.timeImpulsi || 0;
    game.civs.push(civ);
    events.push({
      kind: 'civ-emerged', civName: civ.name, alignment: alignment,
      regionLabel: grp.name, impulso: game.timeImpulsi
    });
  }

  /* ==================================================================
     PIRATI / INCURSIONI — invariati semanticamente (riusano civ.systems
     come prima, ora derivata da civ.planets via cache).
     ================================================================== */

  function incursionTargeting(game, sysId) {
    const inc = game.incursions || [];
    for (let i = 0; i < inc.length; i++) if (inc[i].targetSysId === sysId) return true;
    return false;
  }
  function siegeActiveAt(game, sysId) {
    const bs = game.battles || [];
    for (let i = 0; i < bs.length; i++) {
      if (bs[i].status === 'active' && bs[i].systemId === sysId) return true;
    }
    return false;
  }
  /* M16 Fase B (#81): bersagli "stazione" — avamposti operativi del giocatore
     che un'incursione può assediare/catturare al pari di una colonia. */
  function playerStationTargets(game) {
    const out = [];
    const ST = ORION.station;
    if (!ST || !Array.isArray(game.stations)) return out;
    for (let i = 0; i < game.stations.length; i++) {
      const st = game.stations[i];
      if (!st || st.phase === 'building' || st.level < 1) continue;
      if (!ST.isPlayerStation(st)) continue;        // già catturata
      if (incursionTargeting(game, st.systemId) || siegeActiveAt(game, st.systemId)) continue;
      out.push({ key: null, sysId: st.systemId, stationId: st.id });
    }
    return out;
  }

  function maybePirateIncursion(game, rng, events) {
    if ((game.timeImpulsi || 0) < 120) return;
    const nests = game.piracy && game.piracy.nests;
    if (!nests || !nests.length) return;
    const T = ORION.time, cfg = (T && T.CFG) || {};
    const pressure = (game.warState && game.warState.pressure) || 0;
    const base = (cfg.PIRATE_INCURSION_BASE != null ? cfg.PIRATE_INCURSION_BASE : 0.05);
    const slope = (cfg.PIRATE_INCURSION_PRESSURE != null ? cfg.PIRATE_INCURSION_PRESSURE : 0.25);
    const chance = base + pressure * slope;
    const cols = [];
    Object.keys(game.colonies || {}).forEach(function (k) {
      const c = game.colonies[k];
      if (c && c.colonized && c.phase !== 'settling') cols.push({ key: k, sysId: c.systemId });
    });
    playerStationTargets(game).forEach(function (s) { cols.push(s); });
    if (!cols.length) return;
    if (!Array.isArray(game.incursions)) game.incursions = [];
    let spawned = 0;
    for (let i = 0; i < nests.length; i++) {
      const nest = nests[i];
      if (!rng.chance(chance)) continue;
      let best = null, bestHops = Infinity;
      for (let c = 0; c < cols.length; c++) {
        if (incursionTargeting(game, cols[c].sysId) || siegeActiveAt(game, cols[c].sysId)) continue;
        const path = (ORION.fleet && ORION.fleet.computePath)
          ? ORION.fleet.computePath(game.galaxy, nest.sysId, cols[c].sysId) : null;
        if (!path) continue;
        const hops = path.length - 1;
        if (hops < bestHops) { bestHops = hops; best = cols[c]; }
      }
      if (!best) continue;
      const eta = Math.max(20, Math.min(80, 20 + bestHops * 15));
      const id = 'inc-' + (game.timeImpulsi || 0) + '-' + i + '-' + (spawned++);
      game.incursions.push({
        id: id, kind: 'pirate', fromSysId: nest.sysId,
        targetSysId: best.sysId, targetColonyKey: best.key, targetStationId: best.stationId || null,
        level: nest.level || 1, eta: eta, launchedAt: game.timeImpulsi || 0
      });
      events.push({
        kind: 'incursion-inbound', incursionId: id,
        targetColonyKey: best.key, targetStationId: best.stationId || null, targetSysId: best.sysId,
        eta: eta, impulso: game.timeImpulsi
      });
    }
  }

  function maybeAiIncursion(game, rng, events) {
    if ((game.timeImpulsi || 0) < 160) return;
    const civs = (game.civs || []).filter(function (c) {
      return c.alive && (c.planets || []).length;
    });
    if (!civs.length) return;
    const T = ORION.time, cfg = (T && T.CFG) || {};
    const pressure = (game.warState && game.warState.pressure) || 0;
    const cols = [];
    Object.keys(game.colonies || {}).forEach(function (k) {
      const c = game.colonies[k];
      if (c && c.colonized && c.phase !== 'settling') cols.push({ key: k, sysId: c.systemId });
    });
    playerStationTargets(game).forEach(function (s) { cols.push(s); });
    if (!cols.length) return;
    if (!Array.isArray(game.incursions)) game.incursions = [];
    const threshold = -50 + pressure * 20;
    for (let i = 0; i < civs.length; i++) {
      const civ = civs[i];
      if (civ.faction === 'phaerion' || civ.faction === 'pellegrini') continue;  // Costanti non-belligeranti
      const rel = (ORION.diplomacy && ORION.diplomacy.effectiveRelation)
        ? ORION.diplomacy.effectiveRelation(game, civ) : null;
      if (rel === 'alliance' || rel === 'peace' || rel === 'truce') continue;
      if (civ.disposition > threshold) continue;
      if ((civ.truceUntil || 0) > (game.timeImpulsi || 0)) continue;
      if (!civBordersPlayer(game, civ)) continue;
      const voc = VOCATIONS[civ.vocation] || VOCATIONS.sedentari;
      const hostility = Math.min(1, Math.max(0, (-civ.disposition - 30) / 50));
      const base = (cfg.AI_INCURSION_BASE != null ? cfg.AI_INCURSION_BASE : 0.05);
      const chance = (base * (0.5 + hostility) + pressure * 0.18) * voc.warMul;
      if (!rng.chance(chance)) continue;
      const sysArr = civ.systems || derivedSystems(civ);
      let best = null, bestHops = Infinity;
      for (let s = 0; s < sysArr.length; s++) {
        const links = galaxyOf(game).systems[sysArr[s]].links || [];
        for (let c = 0; c < cols.length; c++) {
          if (incursionTargeting(game, cols[c].sysId) || siegeActiveAt(game, cols[c].sysId)) continue;
          if (links.indexOf(cols[c].sysId) >= 0) {
            if (1 < bestHops) { bestHops = 1; best = cols[c]; }
          }
        }
      }
      if (!best) {
        for (let c = 0; c < cols.length; c++) {
          if (incursionTargeting(game, cols[c].sysId) || siegeActiveAt(game, cols[c].sysId)) continue;
          const path = (ORION.fleet && ORION.fleet.computePath)
            ? ORION.fleet.computePath(galaxyOf(game), sysArr[0], cols[c].sysId) : null;
          if (!path) continue;
          const hops = path.length - 1;
          if (hops < bestHops) { bestHops = hops; best = cols[c]; }
        }
      }
      if (!best) continue;
      const eta = Math.max(25, Math.min(90, 25 + bestHops * 12));
      const id = 'inc-ai-' + (game.timeImpulsi || 0) + '-' + i;
      /* M10 Fase B-2: una civ tecnologicamente avanzata telegrafa
         un'incursione di livello più alto (≤ +25%). Lo scontro vero è
         comunque scalato da `materialize` (fpMul/hpMul). */
      const level = Math.max(1, Math.round((civ.power / 30) * (1 + TECH_CFG.FP_GAIN * techNorm(game, civ))));
      civ.relation = 'war';
      game.incursions.push({
        id: id, kind: 'ai', civId: civ.id, civName: civ.name, civColor: civ.color,
        fromSysId: sysArr[0], targetSysId: best.sysId, targetColonyKey: best.key, targetStationId: best.stationId || null,
        level: level, eta: eta, launchedAt: game.timeImpulsi || 0
      });
      events.push({
        kind: 'incursion-inbound', incursionId: id, attackerKind: 'ai',
        civName: civ.name, targetColonyKey: best.key, targetStationId: best.stationId || null, targetSysId: best.sysId,
        eta: eta, impulso: game.timeImpulsi
      });
    }
  }
  function galaxyOf(game) { return game.galaxy; }

  function maybePirateRaid(game, rng, events) {
    const nests = game.piracy && game.piracy.nests;
    if (!nests || !nests.length) return;
    if (!rng.chance(CFG.PIRATE_RAID_CHANCE)) return;
    const nest = nests[rng.int(0, nests.length - 1)];
    events.push({
      kind: 'pirate-raid',
      regionLabel: regionLabelOfSystem(game.galaxy, nest.sysId),
      impulso: game.timeImpulsi
    });
  }

  function maybePirateRaider(game, rng, events) {
    if ((game.timeImpulsi || 0) < CFG.PIRATE_RAIDER_GRACE) return;
    const nests = game.piracy && game.piracy.nests;
    if (!nests || !nests.length) return;
    const fleets = game.fleets || [];
    if (!fleets.length) return;
    if (!ORION.fleet || !ORION.fleet.computePath) return;
    const players = playerSystems(game);
    const exposed = [];
    for (let i = 0; i < fleets.length; i++) {
      const f = fleets[i];
      if (!f || !f.location || f.location.status !== 'orbiting') continue;
      if (players.has(f.location.systemId)) continue;
      exposed.push({ fleet: f });
    }
    if (!exposed.length) return;
    if (!Array.isArray(game.incursions)) game.incursions = [];
    for (let i = 0; i < nests.length; i++) {
      const nest = nests[i];
      if (!rng.chance(CFG.PIRATE_RAIDER_CHANCE)) continue;
      let best = null, bestHops = Infinity;
      for (let e = 0; e < exposed.length; e++) {
        const sysId = exposed[e].fleet.location.systemId;
        if (raiderTargeting(game, exposed[e].fleet.id)) continue;
        const path = ORION.fleet.computePath(game.galaxy, nest.sysId, sysId);
        if (!path) continue;
        const hops = path.length - 1;
        if (hops < bestHops) { bestHops = hops; best = exposed[e].fleet; }
      }
      if (!best) continue;
      const eta = Math.max(10, Math.min(60, 12 + bestHops * 12));
      const id = 'raid-' + (game.timeImpulsi || 0) + '-' + i;
      game.incursions.push({
        id: id, kind: 'pirate-raider', fromSysId: nest.sysId,
        targetSysId: best.location.systemId, targetFleetId: best.id,
        level: nest.level || 1, eta: eta, launchedAt: game.timeImpulsi || 0
      });
      events.push({
        kind: 'raider-inbound', raiderId: id,
        targetFleetId: best.id, targetFleetName: best.name,
        targetSysId: best.location.systemId, eta: eta, impulso: game.timeImpulsi
      });
    }
  }
  function raiderTargeting(game, fleetId) {
    const inc = game.incursions || [];
    for (let i = 0; i < inc.length; i++) {
      if (inc[i].kind === 'pirate-raider' && inc[i].targetFleetId === fleetId) return true;
    }
    return false;
  }

  function knownNests(game) {
    const nests = (game.piracy && game.piracy.nests) || [];
    const out = [];
    for (let i = 0; i < nests.length; i++) {
      if (!discovered(game, nests[i].sysId)) continue;
      const sys = game.galaxy.systems[nests[i].sysId];
      out.push({
        sysId: nests[i].sysId, level: nests[i].level || 1,
        name: sys ? sys.name : '—',
        regionLabel: regionLabelOfSystem(game.galaxy, nests[i].sysId)
      });
    }
    return out;
  }

  /* ==================================================================
     API DOSSIER / INTEL (Fase B+C eredità) — invariate.
     ================================================================== */

  function pirateThreat(game, sysId) {
    const nests = game.piracy && game.piracy.nests;
    if (!nests) return 0;
    const galaxy = game.galaxy;
    let threat = 0;
    for (let i = 0; i < nests.length; i++) {
      if (nests[i].sysId === sysId) threat = Math.max(threat, 0.4 * nests[i].level);
      else {
        const links = galaxy.systems[nests[i].sysId].links || [];
        if (links.indexOf(sysId) >= 0) threat = Math.max(threat, 0.2 * nests[i].level);
      }
    }
    return Math.min(1, threat);
  }

  function dossier(civ) {
    if (!civ) return null;
    const sys = civ.systems || derivedSystems(civ);
    return {
      name: civ.name, alignment: civ.alignment, archetypeLabel: civ.archetypeLabel,
      traitLabel: civ.traitLabel, color: civ.color, systems: sys.length,
      planets: (civ.planets || []).length,
      vocation: civ.vocation, vocationLabel: VOCATIONS[civ.vocation] ? VOCATIONS[civ.vocation].label : '—',
      affinity: civ.affinity, affinityLabel: AFFINITIES[civ.affinity] ? AFFINITIES[civ.affinity].label : '—',
      phase: civ.phase, faction: civ.faction || null,
      disposition: Math.round(civ.disposition), contacted: !!civ.contacted,
      tier: civ.homeTier
    };
  }

  function dispositionLabel(v) {
    if (v <= -40) return 'Ostile';
    if (v <= -15) return 'Diffidente';
    if (v < 15) return 'Neutrale';
    if (v < 40) return 'Cordiale';
    return 'Amichevole';
  }
  function powerTier(power) {
    if (power < 40) return 'debole';
    if (power < 90) return 'media';
    if (power < 160) return 'forte';
    return 'dominante';
  }

  /* ------------------------------------------------------------------
     LIVELLO TECNOLOGICO (decisione #52 §13 — M10 Fase B-2).
     `techNorm(game, civ)` ∈ [0,1] è una **funzione pura** (niente stato
     persistito → nessun bump di schema, #5 deterministico): deriva da
     vocazione (inclinazione tech), età della civ (maturazione satura) e
     un piccolo termine da power. Tecnocratici/Vehryn partono alti, i
     predoni bassi.

     CONTRAPPESO recovery-friendly (#22, richiesta utente 2026-06-19): il
     vantaggio tech NON deve creare uno svantaggio invisibile e
     irrecuperabile. Quindi "qualità ≠ quantità": una civ avanzata ha
     unità più toste (`fpMul`/`hpMul` ≤ +TECH_FP_GAIN) ma ne schiera
     MENO (`massMul` fino a −TECH_MASS_PENALTY) → l'aggregato di
     combattimento cresce al massimo ~+10%, mai un muro. In più, le
     vocazioni "tech" espandono/guerreggiano già meno (VOCATIONS) →
     avanzate ma piccole e pacifiche. Mai una civ grande+avanzata+ostile
     a freddo. ------------------------------------------------------- */
  const TECH_VOCATION_BIAS = {
    tecnocratici: 1.00, mistici: 0.60, isolazionisti: 0.55, mercantili: 0.45,
    sedentari: 0.40, imperialisti: 0.35, espansionisti: 0.30, predoni: 0.15
  };
  const TECH_CFG = {
    AGE_HALF: 6000,        // Ι: dimezzamento della maturazione (satura)
    BASE: 0.10,            // pavimento per tutti
    VOC_FLOOR: 0.40,       // peso vocazione a età 0
    VOC_AGE: 0.50,         // peso vocazione che matura con l'età
    POW_CAP: 0.15,         // contributo massimo dal power
    POW_DIV: 1200,         // power per saturare POW_CAP
    FP_GAIN: 0.25,         // +25% fuoco/corazza per unità all'avanguardia
    MASS_PENALTY: 0.12     // −12% numero unità all'avanguardia (contrappeso)
  };
  function techNorm(game, civ) {
    if (!civ) return 0.30;
    const bias = (civ.vocation && TECH_VOCATION_BIAS[civ.vocation] != null)
      ? TECH_VOCATION_BIAS[civ.vocation] : 0.40;
    const I = (game && game.timeImpulsi) || 0;
    const age = Math.max(0, I - (civ.established || 0));
    const ageNorm = age / (age + TECH_CFG.AGE_HALF);
    const vocComp = bias * (TECH_CFG.VOC_FLOOR + TECH_CFG.VOC_AGE * ageNorm);
    const powComp = Math.min(TECH_CFG.POW_CAP, (civ.power || 0) / TECH_CFG.POW_DIV);
    let t = TECH_CFG.BASE + vocComp + powComp;
    return t < 0 ? 0 : (t > 1 ? 1 : t);
  }
  const TECH_TIER_LABEL = ['Arretrata', 'Standard', 'Avanzata', 'Superiore', "All'avanguardia"];
  function techTierIndex(game, civ) {
    const t = techNorm(game, civ);
    if (t < 0.20) return 0;
    if (t < 0.40) return 1;
    if (t < 0.60) return 2;
    if (t < 0.80) return 3;
    return 4;
  }
  function techTierLabel(game, civ) { return TECH_TIER_LABEL[techTierIndex(game, civ)]; }
  /* Moltiplicatori di combattimento per le unità materializzate. */
  function techCombatMul(game, civ) {
    const t = techNorm(game, civ);
    return {
      fpMul: 1 + TECH_CFG.FP_GAIN * t,
      hpMul: 1 + TECH_CFG.FP_GAIN * t,
      massMul: 1 - TECH_CFG.MASS_PENALTY * t
    };
  }
  function knownSystemsCount(game, civ) {
    const sys = civ.systems || derivedSystems(civ);
    let n = 0;
    for (let i = 0; i < sys.length; i++) if (discovered(game, sys[i])) n++;
    return n;
  }
  function contactedCivs(game) {
    return (game.civs || []).filter(function (c) { return c.alive && c.contacted; });
  }
  /* M10 Fase B punto 2: tutte le civiltà visibili al giocatore (≥ avvistate).
     Esclude le "unknown". L'UI le ordina per grado decrescente. */
  function visibleCivs(game) {
    return (game.civs || []).filter(function (c) { return c.alive && knowledgeRank(c) >= KNOWLEDGE.spotted; });
  }
  /* Etichetta italiana del grado (per UI). */
  const KNOWLEDGE_LABEL = {
    unknown: 'Sconosciuta', spotted: 'Avvistata', contacted: 'Contattata',
    known: 'Conosciuta', familiar: 'Familiare'
  };
  function knowledgeLabel(civ) {
    return KNOWLEDGE_LABEL[civ && civ.knowledge || 'unknown'];
  }

  function materialize(game, civ, sysId) {
    if (!civ) return null;
    /* M10 Fase B-2: il tech-tier ridistribuisce la forza (qualità ≠
       quantità) — unità più toste ma in numero ridotto.
       Decisione 2026-06-26 (opzione A): compongo con la VOCAZIONE
       (voc.hpMul/fpMul/massMul). Spezza la rigida uniformità "tutte le
       unità AI hanno P=182": Mistici fragili, Imperialisti pesanti. */
    const tech = techCombatMul(game, civ);
    const voc = VOCATIONS[civ.vocation] || VOCATIONS.sedentari;
    const vHp = voc.hpMul != null ? voc.hpMul : 1;
    const vFp = voc.fpMul != null ? voc.fpMul : 1;
    const vMass = voc.massMul != null ? voc.massMul : 1;
    const rawUnits = (civ.power || 0) / 25;
    const units = Math.max(1, Math.round(rawUnits * tech.massMul * vMass));
    return {
      civId: civ.id, civName: civ.name, alignment: civ.alignment,
      color: civ.color, atSystem: sysId,
      units: units, power: civ.power || 0, ships: [],
      fpMul: tech.fpMul * vFp, hpMul: tech.hpMul * vHp,
      techTier: techTierIndex(game, civ)
    };
  }
  function demobilize(game, civ, outcome) {
    if (!civ || !outcome) return true;
    const loss = (outcome.winner === 'player') ? 12 : 5;
    civ.power = Math.max(0, civ.power - loss);
    recordBattle(game, civ.id, outcome.winner === 'player' ? 'win' : 'loss', 'skirmish',
      outcome.report && outcome.report.systemId);
    return true;
  }

  function recordBattle(game, civId, result, kind, sysId) {
    const civ = (game.civs || []).filter(function (c) { return c.id === civId; })[0];
    if (!civ) return;
    civ.lastBattle = {
      result: result, kind: kind || 'skirmish',
      sysId: (sysId == null ? -1 : sysId), impulso: game.timeImpulsi || 0
    };
    /* M10 Fase B punto 2 (decisione #52 §13.10): uno scontro vero è un atto
       diretto → contatto formale + interazione che conta per "Conosciuta". */
    /* Bugfix 2026-06-20: il contatto per battaglia non scriveva intelLevel,
       e il fallback UI ('complete') faceva passare le civ contattate via
       scontro come a dossier pieno. Inizializza coerentemente dal progresso
       cumulato (di solito 'fragmentary' se non c'era ricognizione attiva). */
    if (!civ.intelLevel) civ.intelLevel = intelLevelFromProgress(civ.intelProgress || 0);
    markContact(game, civ, null, 'battle');
  }
  function forceEstimate(game, civ) {
    return Math.max(1, Math.round((civ.power || 0) / 25));
  }
  /* Range di forza stimata in funzione del livello di dossier (decisione
     2026-06-26): a livelli bassi la stima è larga, a livelli alti si stringe;
     con deepIntel diventa il numero esatto.
       L1 frammentario : ± 60% → fascia molto larga
       L2 parziale     : ± 35%
       L3 completo     : ± 15%
       L4 approfondito : ±  5%
       L5 infiltrato   : esatto (deepIntel.power)
     Restituisce { lo, hi, mid, exact } in unità Forza Impero (≈ power). */
  function forceEstimateRange(game, civ, intelRank) {
    const exact = Math.max(1, Math.round((civ.power || 0)));
    if (civ.deepIntel && civ.deepIntel.power != null) {
      const di = Math.round(civ.deepIntel.power);
      return { lo: di, hi: di, mid: di, exact: true };
    }
    let pct = 0.60;
    if (intelRank >= 4) pct = 0.05;
    else if (intelRank >= 3) pct = 0.15;
    else if (intelRank >= 2) pct = 0.35;
    const span = Math.max(2, Math.round(exact * pct));
    return { lo: Math.max(1, exact - span), hi: exact + span, mid: exact, exact: false };
  }
  /* Forza Impero del giocatore, sulla stessa scala di civ.power per consentire
     un confronto onesto nella vista Civiltà. Punteggio narrativo: 8 per
     colonia (POWER_PER_PLANET) + ramp da battaglie vinte/perse (lazy, vive
     su game.playerForce additivo). */
  /* Aggrega la potenza di fuoco (fp) e l'integrità (hp) delle aifleet vive
     di una civ. Niente gating: l'helper torna i numeri grezzi, sta al
     chiamante decidere se mostrarli esatti o a range coi livelli intel. */
  function civFleetTotals(game, civ) {
    let count = 0, fp = 0, hp = 0, ships = 0;
    const list = (game && game.aiFleets) || [];
    for (let i = 0; i < list.length; i++) {
      const af = list[i];
      if (!af || af.civId !== civ.id) continue;
      count++;
      fp += (af.fp || 0);
      hp += (af.hp || 0);
      ships += Array.isArray(af.ships) ? af.ships.length : 0;
    }
    return { count: count, fp: Math.round(fp), hp: Math.round(hp), ships: ships };
  }
  /* Difese statiche delle colonie AI: non sono modellate (le AI non hanno
     `colony.structures` come il giocatore). Sintetizziamo una stima ONESTA
     a partire da civ.power: ~40% della Forza Impero è "infrastruttura" sul
     terreno, ripartito tra le colonie con peso deterministico per-pianeta.
     Esposto come totale + per-colonia (a L4 vedi quali sono scoperte). */
  function civDefensesTotal(civ) {
    const total = Math.max(0, Math.round((civ.power || 0) * 0.40));
    const n = Math.max(1, (civ.planets || []).length);
    return { total: total, perColonyAvg: Math.round(total / n) };
  }
  function civDefensePerColony(game, civ) {
    const planets = (civ.planets || []);
    const n = planets.length;
    if (!n) return [];
    const total = Math.max(0, Math.round((civ.power || 0) * 0.40));
    /* Pesi deterministici da seed di gioco + civId + planetKey, in [0.5, 1.5].
       Capitale (planets[0]) ha boost x1.5 fisso (sede meglio difesa). */
    const seed = (game && game.seed) || 0;
    const rng = ORION.rng && ORION.rng.makeRng ? ORION.rng.makeRng(seed + ':civdef:' + civ.id) : null;
    const weights = planets.map(function (pk, idx) {
      const base = rng ? (0.5 + rng.float()) : 1.0;
      return idx === 0 ? base * 1.5 : base;
    });
    const wsum = weights.reduce(function (a, b) { return a + b; }, 0) || 1;
    return planets.map(function (pk, idx) {
      const share = total * weights[idx] / wsum;
      return { planetKey: pk, defense: Math.max(0, Math.round(share)) };
    });
  }

  /* ------------------------------------------------------------------
     STIMA CONTESTUALE DI FORZA DI COMBATTIMENTO (decisione 2026-06-26).

     Risponde alla domanda: "se attacco QUESTO oggetto adesso, cosa
     affronto?". Stessa scala P = HP + FP*8 usata per la tua flotta
     (garrison.powerOf) e per le tue difese (combat.forceFromDefenses).

       aiCombatPowerAt(game, civ, targetKind, targetRef) →
         { real, mobilizable, total, components, range }

       - targetKind: 'fleet' | 'colony' | 'station' | 'system'
       - targetRef:
           fleet  → aifleet object o af.id
           colony → planetKey 'sid:bk'
           station→ station object o station.id
           system → sysId numerico

     Tutto deriva da costanti già nel modello:
       - combat.CFG.AI_UNIT_HP / AI_UNIT_FP  (statistiche unità)
       - garrison.CFG.FP_WEIGHT              (peso FP nella P)
       - techCombatMul(civ)                  (mod tecnologia)
       - VOCATIONS[voc].hpMul/fpMul/massMul  (mod carattere)
       - VOCATIONS[voc].warMul × PHASES[ph].warMul × MOB.REL[rel]
         × CAPITAL_WEIGHT / colony-weight    (mod mobilitazione)
     Niente magic number.
     ------------------------------------------------------------------ */

  /* P di una "unità AI" tipica per quella civ, con composizione tech+voc. */
  function aiPowerPerUnit(game, civ) {
    const tech = techCombatMul(game, civ);
    const voc = VOCATIONS[civ.vocation] || VOCATIONS.sedentari;
    const vHp = voc.hpMul != null ? voc.hpMul : 1;
    const vFp = voc.fpMul != null ? voc.fpMul : 1;
    const C = (root.ORION && root.ORION.combat && root.ORION.combat.CFG) || { AI_UNIT_HP: 70, AI_UNIT_FP: 14 };
    const GAR = (root.ORION && root.ORION.garrison && root.ORION.garrison.CFG) || { FP_WEIGHT: 8 };
    const uHp = Math.round(C.AI_UNIT_HP * tech.hpMul * vHp);
    const uFp = Math.round(C.AI_UNIT_FP * tech.fpMul * vFp);
    return uHp + uFp * GAR.FP_WEIGHT;
  }

  /* Unità "totali" che la civ potrebbe materializzare ovunque. */
  function aiTotalMobUnits(game, civ) {
    const tech = techCombatMul(game, civ);
    const voc = VOCATIONS[civ.vocation] || VOCATIONS.sedentari;
    const vMass = voc.massMul != null ? voc.massMul : 1;
    return Math.max(1, Math.round((civ.power || 0) / 25 * tech.massMul * vMass));
  }

  /* Moltiplicatore di mobilitazione (0..N) per UN PUNTO PRECISO, modulato da
     vocazione (warMul), fase (warMul), relazione vs giocatore, penalità per
     sconfitta recente. */
  function aiMobMul(game, civ) {
    const voc = VOCATIONS[civ.vocation] || VOCATIONS.sedentari;
    const phase = PHASES[civ.phase] || PHASES.growth;
    let rel = (root.ORION.diplomacy && root.ORION.diplomacy.effectiveRelation)
      ? root.ORION.diplomacy.effectiveRelation(game, civ)
      : (civ.relation || 'peace');
    /* effectiveRelation può tornare anche 'hostile'/'cordial'/'friendly'; per
       la mobilitazione li mappo su disposizione: ostile≈war-like, gli altri
       come pace. */
    if (rel === 'cordial' || rel === 'friendly') rel = 'peace';
    const relMul = (CFG.MOB.REL[rel] != null) ? CFG.MOB.REL[rel] : CFG.MOB.REL.peace;
    let mul = (voc.warMul || 1) * (phase.warMul || 1) * relMul;
    if (civ.lastBattle && civ.lastBattle.result === 'loss') {
      const dt = (game.timeImpulsi || 0) - (civ.lastBattle.impulso || 0);
      if (dt >= 0 && dt < CFG.MOB.LAST_BATTLE_RECENCY_I) mul *= CFG.MOB.LAST_BATTLE_LOSS_PENALTY;
    }
    return Math.max(0, mul);
  }

  /* Penalità "truppe già impegnate altrove": ogni incursione AI inbound già
     in corso da QUESTA civ sottrae N unità (default 1 per incursione). */
  function aiEngagementCost(game, civ) {
    if (!game || !Array.isArray(game.incursions)) return 0;
    let n = 0;
    for (let i = 0; i < game.incursions.length; i++) {
      const inc = game.incursions[i];
      if (inc && inc.kind === 'ai' && inc.civId === civ.id) n++;
    }
    return n * (CFG.MOB.INCURSION_UNIT_COST || 0);
  }

  /* Pesi delle colonie per la distribuzione mobilitazione: capitale boost
     fisso (CFG.MOB.CAPITAL_WEIGHT), altre seed-deterministiche in [0.7, 1.2]. */
  function aiColonyWeights(game, civ) {
    const planets = civ.planets || [];
    if (!planets.length) return { weights: [], sum: 0 };
    const seed = (game && game.seed) || 0;
    const rng = root.ORION.rng && root.ORION.rng.makeRng
      ? root.ORION.rng.makeRng(seed + ':aimob:' + civ.id)
      : null;
    const weights = planets.map(function (pk, idx) {
      if (idx === 0) return CFG.MOB.CAPITAL_WEIGHT || 1.5;
      const r = rng ? rng.float() : 0.5;
      return 0.7 + r * 0.5;
    });
    const sum = weights.reduce(function (a, b) { return a + b; }, 0) || 1;
    return { weights: weights, sum: sum };
  }

  /* Presenza reale di flotte AI ferme in un sistema (orbiting/docked) per
     quella civ. Dato concreto (NON una stima). */
  function realFleetPowerAtSystem(game, civId, sysId) {
    const GAR = root.ORION && root.ORION.garrison;
    if (!GAR || !GAR.powerOf) return 0;
    let p = 0;
    const list = (game && game.aiFleets) || [];
    for (let i = 0; i < list.length; i++) {
      const af = list[i];
      if (!af || af.civId !== civId || af.systemId !== sysId) continue;
      if (af.status === 'in-transit') continue;
      p += GAR.powerOf(game, af);
    }
    return Math.round(p);
  }

  function aiCombatPowerAt(game, civ, targetKind, targetRef) {
    if (!civ) return null;

    if (targetKind === 'fleet') {
      const GAR = root.ORION && root.ORION.garrison;
      let af = targetRef;
      if (typeof targetRef === 'string') {
        af = ((game && game.aiFleets) || []).filter(function (x) { return x && x.id === targetRef; })[0];
      }
      const p = (af && GAR && GAR.powerOf) ? Math.round(GAR.powerOf(game, af)) : 0;
      return { real: p, mobilizable: 0, total: p, components: { fleet: p } };
    }

    if (targetKind === 'station') {
      let st = targetRef;
      const stMod = root.ORION && root.ORION.station;
      if (typeof targetRef === 'string' && stMod && stMod.stationById) {
        st = stMod.stationById(game, targetRef);
      }
      const sid = st && st.systemId;
      const fleetP = (sid != null) ? realFleetPowerAtSystem(game, civ.id, sid) : 0;
      /* Le strutture stazione hanno difese modellate ma il calcolo è
         specifico di station.js; espongo solo il presidio reale qui. */
      return { real: fleetP, mobilizable: 0, total: fleetP, components: { presidio: fleetP } };
    }

    const pPerUnit = aiPowerPerUnit(game, civ);
    const totalUnits = aiTotalMobUnits(game, civ);
    const mobMul = aiMobMul(game, civ);
    const engagement = aiEngagementCost(game, civ);
    const availableUnits = Math.max(0, totalUnits * mobMul - engagement);

    if (targetKind === 'colony') {
      const planetKey = String(targetRef);
      const parts = planetKey.split(':');
      const sid = Number(parts[0]);
      const planets = civ.planets || [];
      const idx = planets.indexOf(planetKey);
      const ws = aiColonyWeights(game, civ);
      let colonyShare = 0;
      if (idx >= 0 && ws.sum > 0) colonyShare = ws.weights[idx] / ws.sum;
      const colonyUnits = Math.max(0, Math.round(availableUnits * colonyShare));
      const mobilizable = colonyUnits * pPerUnit;
      const real = realFleetPowerAtSystem(game, civ.id, sid);
      return {
        real: real, mobilizable: mobilizable, total: real + mobilizable,
        components: { fleetInOrbit: real, mobilizable: mobilizable, units: colonyUnits, pPerUnit: pPerUnit }
      };
    }

    if (targetKind === 'system') {
      const sid = Number(targetRef);
      const planets = civ.planets || [];
      const ws = aiColonyWeights(game, civ);
      let sumShare = 0;
      for (let i = 0; i < planets.length; i++) {
        const parts = planets[i].split(':');
        if (Number(parts[0]) === sid && ws.sum > 0) sumShare += ws.weights[i] / ws.sum;
      }
      const sysUnits = Math.max(0, Math.round(availableUnits * sumShare));
      const mobilizable = sysUnits * pPerUnit;
      const real = realFleetPowerAtSystem(game, civ.id, sid);
      return {
        real: real, mobilizable: mobilizable, total: real + mobilizable,
        components: { fleetInOrbit: real, mobilizable: mobilizable, units: sysUnits, pPerUnit: pPerUnit }
      };
    }

    return null;
  }

  function playerEmpireForce(game) {
    if (!game) return 0;
    let n = 0;
    const cols = game.colonies || {};
    Object.keys(cols).forEach(function (k) {
      const c = cols[k];
      if (c && c.colonized) n++;
    });
    const base = n * CFG.POWER_PER_PLANET;
    const bonus = (game.playerForceBonus || 0);
    return Math.max(0, Math.round(base + bonus));
  }
  function dispositionReason(game, civ) {
    const deeds = game.alignmentDeeds || { light: 0, dark: 0 };
    const near = civBordersPlayer(game, civ);
    const out = [];
    if (civ.alignment === 'bene') {
      if (deeds.light > deeds.dark) out.push('apprezza la tua condotta');
      if (deeds.dark > deeds.light + 1) out.push('disapprova le tue aggressioni');
    } else if (civ.alignment === 'male') {
      if (near) out.push('ti considera un bersaglio (confini vicini)');
      if (deeds.dark > deeds.light) out.push('rispetta la forza che mostri');
    } else {
      out.push('opportunista: pesa la tua forza');
    }
    if (civ.lastBattle) {
      out.push(civ.lastBattle.result === 'win' ? 'memore della sconfitta subita' : 'rinfrancata dalla vittoria su di te');
    }
    return out.length ? out.join(' · ') : 'nessun fattore rilevante';
  }
  function reputationPreview(game) {
    const civs = (game.civs || []).filter(function (c) { return c.alive && c.contacted; });
    if (!civs.length) return 50;
    let sum = 0;
    civs.forEach(function (c) { sum += c.disposition; });
    return Math.round(Math.max(0, Math.min(100, 50 + (sum / civs.length) * 0.5)));
  }

  ORION.ai = {
    CFG: CFG,
    ARCHETYPES: ARCHETYPES,
    TRAITS: TRAITS,
    VOCATIONS: VOCATIONS,
    AFFINITIES: AFFINITIES,
    PHASES: PHASES,
    generate: generate,
    ensure: ensure,
    tick: tick,
    /* Data-model API (decisione #52) */
    addPlanet: addPlanet,
    removePlanet: removePlanet,
    removeAllInSystem: removeAllInSystem,
    derivedSystems: derivedSystems,
    rebuildSystemsCache: rebuildSystemsCache,
    parsePlanetKey: parsePlanetKey,
    migrateLegacyCiv: migrateLegacyCiv,
    /* Lookups */
    civForSystem: civForSystem,
    civForPlanet: civForPlanet,
    pirateThreat: pirateThreat,
    /* Dossier / intel */
    dossier: dossier,
    reputationPreview: reputationPreview,
    dispositionLabel: dispositionLabel,
    powerTier: powerTier,
    /* M10 Fase B-2 (decisione #52 §13): livello tecnologico AI. */
    techNorm: techNorm,
    techTierIndex: techTierIndex,
    techTierLabel: techTierLabel,
    techCombatMul: techCombatMul,
    TECH_TIER_LABEL: TECH_TIER_LABEL,
    knownSystemsCount: knownSystemsCount,
    contactedCivs: contactedCivs,
    /* M10 Fase B punto 2 (decisione #52 §13.10): scoperta progressiva. */
    KNOWLEDGE: KNOWLEDGE,
    KNOWLEDGE_LABEL: KNOWLEDGE_LABEL,
    knowledgeRank: knowledgeRank,
    knowledgeLabel: knowledgeLabel,
    bumpKnowledge: bumpKnowledge,
    addInteraction: addInteraction,
    markContact: markContact,
    maybePromoteKnowledge: maybePromoteKnowledge,
    processPresence: processPresence,
    fleetIntelScore: fleetIntelScore,
    intelLevelFromScore: intelLevelFromScore,
    intelLevelFromProgress: intelLevelFromProgress,
    intelOutlook: intelOutlook,
    intelLevelRank: intelLevelRank,
    reconcileIntelLevel: reconcileIntelLevel,
    visibleCivs: visibleCivs,
    materialize: materialize,
    demobilize: demobilize,
    recordBattle: recordBattle,
    forceEstimate: forceEstimate,
    forceEstimateRange: forceEstimateRange,
    playerEmpireForce: playerEmpireForce,
    civFleetTotals: civFleetTotals,
    civDefensesTotal: civDefensesTotal,
    civDefensePerColony: civDefensePerColony,
    aiCombatPowerAt: aiCombatPowerAt,
    aiPowerPerUnit: aiPowerPerUnit,
    INTEL_LEVEL_INV: INTEL_LEVEL_INV,
    dispositionReason: dispositionReason,
    knownNests: knownNests,
    /* esposto per factions.js */
    _playerSystems: playerSystems
  };
})(typeof window !== 'undefined' ? window : this);
