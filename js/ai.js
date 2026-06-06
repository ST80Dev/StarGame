/* =====================================================================
   ORION EMPIRES — ai.js
   Modulo M10 · Fase A: CIVILTÀ AI (GDD §13, roadmap riga 598).

   Apre M10 con lo strato che rende la galassia VIVA e OSSERVABILE
   (decisione #47). Le civiltà AI:
     - esistono con territorio, allineamento, archetipo, tratto (§13.1/§13.2);
     - vivono in BACKGROUND in forma AGGREGATA (potenza + sistemi posseduti,
       niente colonie reali da simulare): è il principio LOD della
       decisione #47 — il dettaglio (flotte/colonie reali) si materializzerà
       SOLO al contatto col giocatore in Fase B (wiring M08/M09);
     - espandono nello spazio neutrale, si fanno guerra TRA loro (§13.3),
       possono SCOMPARIRE (ridotte a 0 sistemi) e NASCERNE di nuove sulla
       Frontiera (roster vivo, decisione #47);
     - alimentano l'ICG (§5.4) e una disposizione EMERGENTE verso il
       giocatore (anteprima della Reputazione §14, decisione #47).

   Geografia mista (decisione #47): imperi consolidati nel Nucleo,
   arrampicatori piccoli su Frontiera/Orlo. Usa il campo `tier` dei gruppi
   (decisione #34, aggiunto in galaxy.js).

   Visibilità (decisione #47): il giocatore vede i confini AI solo nei
   sistemi che ha DETECTED/EXPLORED; gli effetti lontani arrivano come
   VOCI di cronaca senza svelare la mappa.

   Determinismo (decisione #5/#22): ZERO Math.random. La generazione usa
   `seed:civs`; il tick di sfondo usa `seed:ai:<I>` (globale) e
   `seed:civ:<id>:<I>` (per civiltà). Replay identico. Recovery-friendly:
   nessuna AI può causare un game-over in Fase A (la pressione diretta è
   Fase B); le civiltà cadute spariscono, mai bloccano il giocatore.

   Confini di Fase A: NIENTE primo-contatto come scheda/dossier (solo il
   flag `contacted` + una voce di cronaca), NIENTE materializzazione in
   combattimento, NIENTE diplomazia interattiva (M11). Tutto questo è
   Fase B / moduli dedicati.
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  /* ------------------------------------------------------------------
     Archetipi di governo (decisione #34 — lessico SW-flavor, MAI un
     unico Impero/Repubblica galattico: sono categorie distribuite per
     regione). `direct` = il nome non usa il connettore "di".
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

  /* Caratteristica riconoscibile al primo contatto (§13.1). */
  const TRAITS = {
    bene: [
      { id: 'diplomatici', label: 'Diplomatici, cercano alleanze' },
      { id: 'avanzati',    label: 'Tecnologicamente avanzati, isolazionisti' },
      { id: 'mercantili',  label: 'Commercianti pacifici e difensivi' }
    ],
    male: [
      { id: 'espansionisti', label: 'Espansionisti aggressivi' },
      { id: 'predoni',       label: 'Saccheggiatori di sistemi' },
      { id: 'spie',          label: 'Ricatti e spionaggio' }
    ],
    neutrale: [
      { id: 'opportunisti', label: 'Opportunisti: seguono chi vince' },
      { id: 'mercenari',    label: 'Mercanti prima di tutto, imprevedibili' }
    ]
  };

  /* Tinte civiltà (assegnate alla generazione, usate dai marker mappa). */
  const PALETTE = [
    '#e0556e', '#5fa8ff', '#9d7bff', '#3fcaa0',
    '#f0a64a', '#d96bd0', '#7fd0e6', '#c8d24a'
  ];

  /* Pool di nomi propri di fazione (procedurali, decisione #34 — niente
     marchi 1:1). Mix aspro/poetico, unici per civiltà. */
  const NAME_POOL = [
    'Keth-Var', 'Aethon', 'Serenthal', 'Mekhari', 'Vorthan', 'Cygnus',
    'Draxis', 'Auvethal', 'Zorvahl', 'Caelum', 'Nexaris', 'Thyssen',
    'Karveth', 'Lirnos', 'Omneth', 'Valdris', 'Skethara', 'Mirvael',
    'Drennan', 'Calvion', 'Ghulvann', 'Serath', 'Vaelith', 'Tharkos'
  ];

  const CFG = {
    /* Cadenza del simulatore di sfondo: ogni N Impulsi (non a ogni tick:
       leggero e deterministico, come il victory-check). */
    AI_EVERY_I: 8,
    /* Warm-up: la galassia "preesiste" ma evitiamo sussulti immediati nei
       primissimi Impulsi mentre il giocatore fa l'Insediamento. */
    AI_WARMUP_I: 16,

    /* Generazione */
    CIV_MIN: 4, CIV_MAX: 5,             // §13.1: 4-5 civiltà
    CORE_SYSTEMS: [4, 7],               // imperi consolidati (Nucleo/Colonie)
    FRONTIER_SYSTEMS: [1, 3],           // arrampicatori (Frontiera/Orlo)
    POWER_PER_SYSTEM: 10,

    /* Sfondo. Le frequenze sono tarate per una galassia VIVA ma una
       cronaca LEGGIBILE (il log è capato a 40 voci): la simulazione gira
       di sfondo, ma solo una quota degli eventi diventa "voce". */
    POWER_GROWTH: 0.6,                  // crescita potenza/AI-tick per sistema
    EXPAND_CHANCE_BASE: 0.18,           // prob. base di annettere un sistema
    WAR_CHANCE: 0.14,                   // prob. di una schermaglia AI-vs-AI/AI-tick
    AIWAR_POWER_PER_LOSS: 6,            // M10 Fase D: potenza persa per nave distrutta in una guerra AI-vs-AI materializzata
    BIRTH_CHANCE: 0.015,                // prob. nascita nuovo arrampicatore/AI-tick
    PIRATE_RAID_CHANCE: 0.06,           // prob. razzia pirata/AI-tick (solo voce)
    PIRATE_RAIDER_CHANCE: 0.05,         // M10 Fase E: prob. che un covo lanci un raider contro una tua flotta esposta
    PIRATE_RAIDER_GRACE: 120,           // M10 Fase E: nessun raider prima di questo Impulso (grazia, recovery-friendly)
    RUMOR_EXPAND_CHANCE: 0.30,          // quota di espansioni che diventano "voce"
    RUMOR_WAR_CHANCE: 0.45,             // quota di guerre che diventano "voce"

    /* Disposizione verso il giocatore (anteprima §14) */
    DISPOSITION_DRIFT: 0.06,            // velocità di avvicinamento al target

    /* ICG §5.4 — contributi (M18 sistematizzerà) */
    ICG_PER_EVIL_EXPAND: 0.8,
    ICG_PER_GOOD_STABILIZE: 0.5,
    ICG_DECAY: 0.02                     // lieve ritorno verso il basale/AI-tick
  };

  /* ------------------------------------------------------------------
     Helpers di stato
     ------------------------------------------------------------------ */

  /* Sistemi posseduti dal giocatore (home + colonie attive): non
     annettibili dalle AI. */
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

  /* Mappa sysId → civId per i sistemi posseduti dalle AI vive. */
  function ownerMap(game) {
    const map = {};
    const civs = game.civs || [];
    for (let i = 0; i < civs.length; i++) {
      const c = civs[i];
      if (!c || !c.alive) continue;
      for (let j = 0; j < c.systems.length; j++) map[c.systems[j]] = c.id;
    }
    return map;
  }

  /* Civiltà che possiede `sysId` (o null). */
  function civForSystem(game, sysId) {
    const civs = game.civs || [];
    for (let i = 0; i < civs.length; i++) {
      const c = civs[i];
      if (c && c.alive && c.systems.indexOf(sysId) >= 0) return c;
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

  /* Frontiera espandibile di una civiltà: sistemi NON posseduti (né da AI
     né dal giocatore) adiacenti a un sistema della civiltà. */
  function expandableFrontier(game, civ, claimed, players) {
    const galaxy = game.galaxy;
    const out = [];
    const seen = new Set();
    for (let i = 0; i < civ.systems.length; i++) {
      const links = galaxy.systems[civ.systems[i]].links || [];
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

  /* Sistemi di confine di `civ` adiacenti a `other` (per le guerre). */
  function borderSystemsBetween(galaxy, civ, other) {
    const otherSet = new Set(other.systems);
    const out = [];
    for (let i = 0; i < civ.systems.length; i++) {
      const links = galaxy.systems[civ.systems[i]].links || [];
      for (let j = 0; j < links.length; j++) {
        if (otherSet.has(links[j])) { out.push(civ.systems[i]); break; }
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
     GENERAZIONE — eseguita una sola volta a inizio partita
     (idempotente via ensure()). Determinismo: seed:civs.
     ================================================================== */
  function generate(game) {
    const galaxy = game.galaxy;
    if (!galaxy || !galaxy.groups) return [];
    const rng = ORION.rng.makeRng(galaxy.seed + ':civs');
    const groups = galaxy.groups;

    /* Numero di civiltà: 4-5, ridotto se la galassia ha pochi gruppi
       (un gruppo è la sede del giocatore). Il modificatore galaxySize
       del preset (#23) può ampliare la galassia → più gruppi → più AI. */
    const homeGroupId = galaxy.homeGroupId;
    const seatGroups = groups.filter(function (g) { return g.id !== homeGroupId; });
    let n = rng.int(CFG.CIV_MIN, CFG.CIV_MAX);
    n = Math.max(1, Math.min(n, seatGroups.length));

    /* Allineamenti: garantisci almeno una Bene / Male / Neutrale, poi
       riempi il resto pesato verso Male/Bene (la Neutrale resta rara). */
    const alignments = ['bene', 'male', 'neutrale'];
    while (alignments.length < n) {
      const r = rng.float();
      alignments.push(r < 0.45 ? 'male' : r < 0.85 ? 'bene' : 'neutrale');
    }
    rng.shuffle(alignments);

    /* Ordina i gruppi-sede per fascia: i più centrali (Nucleo/Colonie)
       ospitano gli imperi consolidati, l'Orlo gli arrampicatori. */
    const TIER_RANK = { nucleo: 0, colonie: 1, frontiera: 2, orlo: 3, sconosciuto: 4 };
    seatGroups.sort(function (a, b) {
      return (TIER_RANK[a.tier] || 2) - (TIER_RANK[b.tier] || 2);
    });

    const names = rng.shuffle(NAME_POOL.slice());
    const players = playerSystems(game);
    const claimed = new Set();           // sistemi già assegnati a una civiltà
    const civs = [];

    for (let i = 0; i < n; i++) {
      const alignment = alignments[i];
      /* Sede: alterna preferenza per fascia in base all'allineamento.
         Bene → tende al Nucleo, Male/Neutrale → tende all'Orlo (decisione
         #34/#47). Scegliamo deterministicamente dal pool ordinato. */
      let seatIdx;
      if (alignment === 'bene') seatIdx = i % Math.max(1, Math.ceil(seatGroups.length / 2));
      else seatIdx = seatGroups.length - 1 - (i % Math.max(1, Math.ceil(seatGroups.length / 2)));
      seatIdx = Math.max(0, Math.min(seatGroups.length - 1, seatIdx));
      const seat = seatGroups[seatIdx];

      const archPool = ARCHETYPES[alignment];
      const arch = archPool[rng.int(0, archPool.length - 1)];
      const traitPool = TRAITS[alignment];
      const trait = traitPool[rng.int(0, traitPool.length - 1)];
      const properName = names[i % names.length];
      const civName = arch.noun + (arch.direct ? ' ' : ' di ') + properName;

      /* Consolidato vs arrampicatore in base alla fascia della sede. */
      const established = (seat.tier === 'nucleo' || seat.tier === 'colonie');
      const range = established ? CFG.CORE_SYSTEMS : CFG.FRONTIER_SYSTEMS;
      const want = rng.int(range[0], range[1]);

      /* Semina: parte da un sistema della sede non posseduto, poi cresce
         per adiacenza BFS restando preferibilmente nel proprio gruppo. */
      const seatSystems = (seat.members || []).slice().sort(function (a, b) { return a - b; });
      const owned = [];
      let seed = -1;
      for (let s = 0; s < seatSystems.length; s++) {
        const sid = seatSystems[s];
        if (!claimed.has(sid) && !players.has(sid)) { seed = sid; break; }
      }
      if (seed < 0) continue;            // sede satura: salta questa civiltà
      owned.push(seed); claimed.add(seed);

      let guard = 0;
      while (owned.length < want && guard < 400) {
        guard++;
        // candidati = adiacenti non posseduti (preferenza stesso gruppo)
        const cands = [];
        for (let o = 0; o < owned.length; o++) {
          const links = galaxy.systems[owned[o]].links || [];
          for (let l = 0; l < links.length; l++) {
            const nid = links[l];
            if (claimed.has(nid) || players.has(nid)) continue;
            cands.push(nid);
          }
        }
        if (!cands.length) break;
        // preferisci stesso cluster, poi il più vicino al seme
        cands.sort(function (a, b) {
          const sa = galaxy.systems[a].cluster === seat.id ? 0 : 1;
          const sb = galaxy.systems[b].cluster === seat.id ? 0 : 1;
          return sa - sb || a - b;
        });
        const pick = cands[0];
        owned.push(pick); claimed.add(pick);
      }

      civs.push({
        id: 'civ-' + i,
        name: civName,
        archetype: arch.id,
        archetypeLabel: arch.noun,
        alignment: alignment,
        trait: trait.id,
        traitLabel: trait.label,
        color: PALETTE[i % PALETTE.length],
        homeGroupId: seat.id,
        homeTier: seat.tier,
        established: established,
        systems: owned,
        power: owned.length * CFG.POWER_PER_SYSTEM,
        disposition: baseDisposition(alignment),
        contacted: false,
        alive: true,
        bornAt: 0
      });
    }

    /* ICG iniziale (§5.4): la galassia preesiste, parte da un basale
       proporzionale alla forza "maligna" già presente. */
    let evil = 0, good = 0;
    civs.forEach(function (c) {
      if (c.alignment === 'male') evil += c.power;
      else if (c.alignment === 'bene') good += c.power;
    });
    const total = Math.max(1, evil + good);
    game.icg = Math.round(Math.max(8, Math.min(55, 25 + (evil - good) / total * 30)));

    /* Pirati (§17.5, gancio leggero decisione #47): qualche covo nei
       sistemi ad alto pericolo dell'Orlo, non posseduti. */
    game.piracy = { nests: seedPirateNests(game, rng, claimed, players) };

    return civs;
  }

  function baseDisposition(alignment) {
    if (alignment === 'bene') return 25;
    if (alignment === 'male') return -25;
    return 0;
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

  /* Crea/normalizza lo stato AI sul game (idempotente). Non rigenera se
     i civs esistono già (load da save). */
  function ensure(game) {
    if (!game || !game.galaxy) return;
    if (!Array.isArray(game.civs) || !game.civs.length) {
      game.civs = generate(game);
    }
    if (game.icg == null) game.icg = 20;
    if (!game.piracy || !Array.isArray(game.piracy.nests)) {
      game.piracy = { nests: [] };
    }
  }

  /* ==================================================================
     SIMULAZIONE DI SFONDO — chiamata dal tick di time.js.
     Cadenza interna AI_EVERY_I, warm-up AI_WARMUP_I. Eventi notevoli +
     voci di cronaca rate-limitate emessi in `events`.
     ================================================================== */
  function tick(game, events) {
    if (!game || !Array.isArray(game.civs)) return;
    const I = game.timeImpulsi || 0;
    if (I < CFG.AI_WARMUP_I) return;
    if ((I % CFG.AI_EVERY_I) !== 0) return;

    const galaxy = game.galaxy;
    const players = playerSystems(game);
    const grng = ORION.rng.makeRng(galaxy.seed + ':ai:' + I);

    /* Set dei sistemi posseduti (aggiornato durante il passo). */
    const claimed = new Set();
    game.civs.forEach(function (c) {
      if (c.alive) c.systems.forEach(function (s) { claimed.add(s); });
    });

    let icgDelta = 0;

    /* --- Per civiltà: crescita potenza + espansione + disposizione --- */
    for (let i = 0; i < game.civs.length; i++) {
      const civ = game.civs[i];
      if (!civ.alive) continue;
      const crng = ORION.rng.makeRng(galaxy.seed + ':civ:' + civ.id + ':' + I);

      // crescita potenza (lenta, ∝ sistemi)
      civ.power += CFG.POWER_GROWTH * civ.systems.length;

      // espansione (pesata da archetipo + fascia di sede)
      let expandChance = CFG.EXPAND_CHANCE_BASE;
      if (civ.trait === 'espansionisti') expandChance *= 1.8;
      else if (civ.alignment === 'male') expandChance *= 1.3;
      else if (civ.alignment === 'bene') expandChance *= 0.7;
      if (!civ.established) expandChance *= 1.4;     // gli arrampicatori spingono
      if (crng.chance(expandChance)) {
        const frontier = expandableFrontier(game, civ, claimed, players);
        if (frontier.length) {
          frontier.sort(function (a, b) { return a - b; });
          const target = frontier[crng.int(0, frontier.length - 1)];
          civ.systems.push(target);
          claimed.add(target);
          civ.power += CFG.POWER_PER_SYSTEM * 0.5;
          if (civ.alignment === 'male') icgDelta += CFG.ICG_PER_EVIL_EXPAND;
          else if (civ.alignment === 'bene') icgDelta -= CFG.ICG_PER_GOOD_STABILIZE;
          // voce di cronaca rate-limitata (effetto lontano = solo "voce")
          if (crng.chance(CFG.RUMOR_EXPAND_CHANCE)) {
            events.push({
              kind: 'civ-expand', civName: civ.name, civColor: civ.color,
              alignment: civ.alignment,
              regionLabel: regionLabelOfSystem(galaxy, target),
              impulso: I
            });
          }
        }
      }

      // disposizione emergente verso il giocatore (anteprima §14)
      driftDisposition(game, civ);

      // primo contatto: il giocatore ha esplorato un sistema della civiltà?
      if (!civ.contacted && civSeenByPlayer(game, civ)) {
        civ.contacted = true;
        events.push({
          kind: 'civ-contact', civName: civ.name, civColor: civ.color,
          alignment: civ.alignment, traitLabel: civ.traitLabel,
          regionLabel: regionLabelOfSystem(galaxy, civ.systems[0]),
          impulso: I
        });
      }
    }

    /* --- Guerra AI-vs-AI: una schermaglia per AI-tick, tra una coppia
       adiacente con frizione di allineamento. --- */
    maybeWar(game, grng, events, function (d) { icgDelta += d; });

    /* --- Nascita di un nuovo arrampicatore sulla Frontiera/Orlo --- */
    maybeBirth(game, grng, claimed, players, events);

    /* --- Pirati: razzia atmosferica (voce di cronaca). --- */
    maybePirateRaid(game, grng, events);

    /* --- M10 Fase E: i predoni cacciano le tue flotte ESPOSTE (in orbita
       lontano dalle colonie). Gated da grazia iniziale; lo scontro è risolto
       all'arrivo in time.js (lampo). --- */
    maybePirateRaider(game, grng, events);

    /* --- M09 Fase A (decisione #49): incursione pirata "con denti" verso
       una colonia del giocatore. Gated dalla pressione (catena di sconfitte
       → più attacchi) + grazia iniziale: niente assedi a freddo. --- */
    maybePirateIncursion(game, grng, events);

    /* --- M09 Fase B (decisione #49): incursione AI STRATEGICA. Una civiltà
       ostile che confina col giocatore può lanciare una forza di conquista.
       Gated da disposizione molto bassa + pressione + grazia iniziale più
       lunga (niente guerra a freddo), e rispetta le tregue (truceUntil). --- */
    maybeAiIncursion(game, grng, events);

    /* --- ICG §5.4: applica i contributi dell'AI-tick + un decadimento
       dolce verso il basale "stabile" (20), così l'indice respira invece
       di salire monotòno. M18 sistematizzerà l'indice. --- */
    if (game.icg == null) game.icg = 20;
    game.icg += icgDelta;
    game.icg += (20 - game.icg) * CFG.ICG_DECAY;
    game.icg = Math.max(0, Math.min(100, game.icg));
  }

  /* Disposizione → target dipendente da allineamento, vicinanza al
     giocatore e dalle piste reputation light/dark (#23). */
  function driftDisposition(game, civ) {
    const tracks = game.victoryTracks || {};
    const light = tracks.reputationLight || 0;   // 0..1
    const dark = tracks.reputationDark || 0;     // 0..1
    let target = baseDisposition(civ.alignment);
    if (civ.alignment === 'bene') target += light * 40 - dark * 40;
    else if (civ.alignment === 'male') target += dark * 35 - light * 25;
    else target += (light - dark) * 15;
    // vicinanza: una civiltà che confina col giocatore reagisce di più
    if (civBordersPlayer(game, civ)) {
      target += (civ.alignment === 'male') ? -10 : (civ.alignment === 'bene' ? 6 : 0);
    }
    target = Math.max(-100, Math.min(100, target));
    civ.disposition += (target - civ.disposition) * CFG.DISPOSITION_DRIFT;
    civ.disposition = Math.max(-100, Math.min(100, civ.disposition));
  }

  function civBordersPlayer(game, civ) {
    const galaxy = game.galaxy;
    const players = playerSystems(game);
    for (let i = 0; i < civ.systems.length; i++) {
      const links = galaxy.systems[civ.systems[i]].links || [];
      for (let j = 0; j < links.length; j++) if (players.has(links[j])) return true;
    }
    return false;
  }
  function civSeenByPlayer(game, civ) {
    for (let i = 0; i < civ.systems.length; i++) {
      if (discovered(game, civ.systems[i])) return true;
    }
    return false;
  }

  function maybeWar(game, rng, events, addIcg) {
    if (!rng.chance(CFG.WAR_CHANCE)) return;
    const galaxy = game.galaxy;
    const live = game.civs.filter(function (c) { return c.alive && c.systems.length; });
    if (live.length < 2) return;
    // raccogli coppie adiacenti con frizione (almeno una Male, o Bene-vs-Male)
    const pairs = [];
    for (let a = 0; a < live.length; a++) {
      for (let b = a + 1; b < live.length; b++) {
        const A = live[a], B = live[b];
        const friction = (A.alignment === 'male' || B.alignment === 'male')
          || (A.alignment !== B.alignment);
        if (!friction) continue;
        if (areAdjacent(galaxy, A, B)) pairs.push([A, B]);
      }
    }
    if (!pairs.length) return;
    const pair = pairs[rng.int(0, pairs.length - 1)];

    /* Attaccante = più forte, difensore = più debole: il forte preme sul
       confine del debole. L'esito può comunque sorprendere (§13.1). */
    let attacker = pair[0], defender = pair[1];
    if (defender.power > attacker.power) { const t = attacker; attacker = defender; defender = t; }

    /* Sistema conteso = un sistema di confine del DIFENSORE adiacente
       all'attaccante. Se il giocatore ne vede almeno uno (DETECTED+),
       la guerra è "assistibile" → la risolviamo col motore M09 (Fase D). */
    const dborder = borderSystemsBetween(galaxy, defender, attacker);
    if (!dborder.length) return;
    dborder.sort(function (x, y) { return x - y; });
    const seenBorder = dborder.filter(function (s) { return discovered(game, s); });
    const witnessed = seenBorder.length > 0 && !!root.ORION.combat;
    const contested = witnessed
      ? seenBorder[rng.int(0, seenBorder.length - 1)]
      : dborder[rng.int(0, dborder.length - 1)];

    /* Esito. Witnessed → battaglia REALE materializzata (decisione #47 Fase D):
       le due civiltà diventano forze concrete e si scontrano col motore
       deterministico di M09; chi vince la battaglia decide il sistema. Le
       guerre LONTANE (non viste) restano astratte (zero costo/spam). */
    let attackerWon, report = null;
    if (witnessed) {
      const C = root.ORION.combat;
      const A = C.forceFromMaterialized(materialize(game, attacker, contested), 'A');
      const B = C.forceFromMaterialized(materialize(game, defender, contested), 'B');
      const battleId = 'aiwar:' + attacker.id + ':' + defender.id + ':' + contested + ':' + (game.timeImpulsi || 0);
      report = C.resolve(game, battleId, A, B);
      attackerWon = (report.winner === 'A');
      // costo della battaglia: le perdite si traducono in potenza persa
      attacker.power = Math.max(0, attacker.power - report.sideA.lost * CFG.AIWAR_POWER_PER_LOSS);
      defender.power = Math.max(0, defender.power - report.sideB.lost * CFG.AIWAR_POWER_PER_LOSS);
    } else {
      const pWin = attacker.power / Math.max(1, attacker.power + defender.power);
      attackerWon = !(rng.float() > pWin * 1.1);   // upset come prima (§13.1)
    }

    let winner, loser;
    if (attackerWon) {
      // l'attaccante conquista il sistema conteso
      defender.systems = defender.systems.filter(function (s) { return s !== contested; });
      attacker.systems.push(contested);
      attacker.power += CFG.POWER_PER_SYSTEM * 0.5;
      defender.power = Math.max(0, defender.power - CFG.POWER_PER_SYSTEM);
      if (attacker.alignment === 'male') addIcg(CFG.ICG_PER_EVIL_EXPAND);
      winner = attacker; loser = defender;
    } else {
      // il difensore resiste. Nelle guerre VISTE è una difesa riuscita
      // (nessun trasferimento); in quelle ASTRATTE conserviamo la regola
      // "il territorio cambia sempre" → il difensore-vincitore strappa un
      // sistema all'attaccante (equivalente all'upset originale).
      winner = defender; loser = attacker;
      if (!witnessed) {
        const aborder = borderSystemsBetween(galaxy, attacker, defender);
        if (aborder.length) {
          aborder.sort(function (x, y) { return x - y; });
          const taken = aborder[rng.int(0, aborder.length - 1)];
          attacker.systems = attacker.systems.filter(function (s) { return s !== taken; });
          defender.systems.push(taken);
          defender.power += CFG.POWER_PER_SYSTEM * 0.5;
          attacker.power = Math.max(0, attacker.power - CFG.POWER_PER_SYSTEM);
          if (defender.alignment === 'male') addIcg(CFG.ICG_PER_EVIL_EXPAND);
        }
      }
    }

    // Cronaca: le guerre VISTE producono un report reale ("hai assistito a…");
    // le lontane restano una "voce" rate-limitata.
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

    // Caduta (roster vivo): controlla ENTRAMBE (nell'upset astratto anche
    // l'attaccante può perdere il suo ultimo sistema).
    [attacker, defender].forEach(function (civ) {
      if (civ.alive && civ.systems.length === 0) {
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
    // un gruppo di Frontiera/Orlo con sistemi liberi
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
    const seed = free[0];

    // arrampicatore: archetipo Male/Neutrale, tratto coerente
    const alignment = rng.chance(0.6) ? 'male' : 'neutrale';
    const archPool = ARCHETYPES[alignment];
    const arch = archPool[rng.int(0, archPool.length - 1)];
    const traitPool = TRAITS[alignment];
    const trait = traitPool[rng.int(0, traitPool.length - 1)];
    // nome non ancora in uso
    const used = {}; game.civs.forEach(function (c) { used[c.name] = 1; });
    let proper = null;
    const pool = rng.shuffle(NAME_POOL.slice());
    for (let i = 0; i < pool.length; i++) {
      const nm = arch.noun + (arch.direct ? ' ' : ' di ') + pool[i];
      if (!used[nm]) { proper = pool[i]; break; }
    }
    if (!proper) return;
    const civName = arch.noun + (arch.direct ? ' ' : ' di ') + proper;
    const idx = game.civs.length;

    game.civs.push({
      id: 'civ-' + idx + '-' + game.timeImpulsi,   // id unico anche dopo cadute
      name: civName, archetype: arch.id, archetypeLabel: arch.noun,
      alignment: alignment, trait: trait.id, traitLabel: trait.label,
      color: PALETTE[idx % PALETTE.length],
      homeGroupId: grp.id, homeTier: grp.tier, established: false,
      systems: [seed], power: CFG.POWER_PER_SYSTEM,
      disposition: baseDisposition(alignment), contacted: false,
      alive: true, bornAt: game.timeImpulsi
    });
    events.push({
      kind: 'civ-emerged', civName: civName, alignment: alignment,
      regionLabel: grp.name, impulso: game.timeImpulsi
    });
  }

  /* M09 Fase A (decisione #49): un covo pirata lancia un'INCURSIONE inbound
     verso la colonia raggiungibile più vicina. La probabilità sale con la
     pressione (game.warState.pressure). Grazia iniziale (no assedi a freddo,
     recovery-friendly #22) + una sola incursione/assedio per colonia. */
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
  function maybePirateIncursion(game, rng, events) {
    if ((game.timeImpulsi || 0) < 120) return;     // grazia iniziale
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
        targetSysId: best.sysId, targetColonyKey: best.key,
        level: nest.level || 1, eta: eta, launchedAt: game.timeImpulsi || 0
      });
      events.push({
        kind: 'incursion-inbound', incursionId: id,
        targetColonyKey: best.key, targetSysId: best.sysId,
        eta: eta, impulso: game.timeImpulsi
      });
    }
  }

  /* M09 Fase B: una civiltà AI ostile lancia un'incursione di conquista
     verso una colonia del giocatore. Più tardiva e più rara dei pirati
     (la guerra vera non scoppia a freddo). Rispetta le tregue. */
  function maybeAiIncursion(game, rng, events) {
    if ((game.timeImpulsi || 0) < 160) return;     // grazia iniziale più lunga
    const civs = (game.civs || []).filter(function (c) { return c.alive && c.systems.length; });
    if (!civs.length) return;
    const T = ORION.time, cfg = (T && T.CFG) || {};
    const pressure = (game.warState && game.warState.pressure) || 0;
    const cols = [];
    Object.keys(game.colonies || {}).forEach(function (k) {
      const c = game.colonies[k];
      if (c && c.colonized && c.phase !== 'settling') cols.push({ key: k, sysId: c.systemId });
    });
    if (!cols.length) return;
    if (!Array.isArray(game.incursions)) game.incursions = [];
    const players = playerSystems(game);
    /* Soglia di ostilità RILASSATA dalla pressione (decisione #49): a impero
       in difficoltà (catena di sconfitte → pressione alta) anche civiltà
       moderatamente ostili "fiutano il sangue" e attaccano. Realizza la
       spirale: la debolezza invita all'aggressione. */
    const threshold = -50 + pressure * 20;     // pressione 1.0 → fino a -30
    for (let i = 0; i < civs.length; i++) {
      const civ = civs[i];
      if (civ.disposition > threshold) continue;
      if ((civ.truceUntil || 0) > (game.timeImpulsi || 0)) continue;  // tregua in corso
      if (!civBordersPlayer(game, civ)) continue;                // deve confinare
      // probabilità: bassa, cresce con ostilità + pressione
      const hostility = Math.min(1, Math.max(0, (-civ.disposition - 30) / 50));   // 0..1
      const base = (cfg.AI_INCURSION_BASE != null ? cfg.AI_INCURSION_BASE : 0.05);
      const chance = base * (0.5 + hostility) + pressure * 0.18;
      if (!rng.chance(chance)) continue;
      // bersaglio: colonia del giocatore confinante più vicina a un sistema della civ
      let best = null, bestHops = Infinity;
      for (let s = 0; s < civ.systems.length; s++) {
        const links = galaxyOf(game).systems[civ.systems[s]].links || [];
        for (let c = 0; c < cols.length; c++) {
          if (incursionTargeting(game, cols[c].sysId) || siegeActiveAt(game, cols[c].sysId)) continue;
          if (links.indexOf(cols[c].sysId) >= 0) {
            const hops = 1;
            if (hops < bestHops) { bestHops = hops; best = cols[c]; }
          }
        }
      }
      // se non confina direttamente, prova la più vicina raggiungibile
      if (!best) {
        for (let c = 0; c < cols.length; c++) {
          if (incursionTargeting(game, cols[c].sysId) || siegeActiveAt(game, cols[c].sysId)) continue;
          const path = (ORION.fleet && ORION.fleet.computePath)
            ? ORION.fleet.computePath(galaxyOf(game), civ.systems[0], cols[c].sysId) : null;
          if (!path) continue;
          const hops = path.length - 1;
          if (hops < bestHops) { bestHops = hops; best = cols[c]; }
        }
      }
      if (!best) continue;
      const eta = Math.max(25, Math.min(90, 25 + bestHops * 12));
      const id = 'inc-ai-' + (game.timeImpulsi || 0) + '-' + i;
      const level = Math.max(1, Math.round(civ.power / 30));
      game.incursions.push({
        id: id, kind: 'ai', civId: civ.id, civName: civ.name, civColor: civ.color,
        fromSysId: civ.systems[0], targetSysId: best.sysId, targetColonyKey: best.key,
        level: level, eta: eta, launchedAt: game.timeImpulsi || 0
      });
      events.push({
        kind: 'incursion-inbound', incursionId: id, attackerKind: 'ai',
        civName: civ.name, targetColonyKey: best.key, targetSysId: best.sysId,
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

  /* M10 Fase E: un covo lancia un RAIDER contro una flotta del giocatore
     ESPOSTA (in orbita lontano dalle colonie). Crea un'incursione di tipo
     'pirate-raider' che time.js risolve all'arrivo come scaramuccia lampo
     contro quella flotta. Grazia iniziale + una preda alla volta per covo.
     Recovery-friendly (#22): se la preda non c'è più, il raider svanisce. */
  function maybePirateRaider(game, rng, events) {
    if ((game.timeImpulsi || 0) < CFG.PIRATE_RAIDER_GRACE) return;
    const nests = game.piracy && game.piracy.nests;
    if (!nests || !nests.length) return;
    const fleets = game.fleets || [];
    if (!fleets.length) return;
    if (!ORION.fleet || !ORION.fleet.computePath) return;

    // flotte esposte: armate, in orbita, NON in un sistema-colonia del giocatore
    const players = playerSystems(game);
    const exposed = [];
    for (let i = 0; i < fleets.length; i++) {
      const f = fleets[i];
      if (!f || !f.location || f.location.status !== 'orbiting') continue;
      if (players.has(f.location.systemId)) continue;   // in casa = al sicuro
      const guns = (f.ships || []).some(function (s) {
        const cls = ORION.fleet.getClass && ORION.fleet.getClass(s.kind);
        return cls && cls.fp > 0;
      });
      // anche le flotte disarmate possono essere predate (anzi, sono prede facili)
      exposed.push({ fleet: f, armed: guns });
    }
    if (!exposed.length) return;

    if (!Array.isArray(game.incursions)) game.incursions = [];
    for (let i = 0; i < nests.length; i++) {
      const nest = nests[i];
      if (!rng.chance(CFG.PIRATE_RAIDER_CHANCE)) continue;
      // scegli la preda raggiungibile più vicina non già bersagliata
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

  /* M10 Fase E: covi pirata NOTI al giocatore (sistema DETECTED+). Per i
     marker sulla mappa e la lista "Minacce pirata" nel dossier. */
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

  /* ------------------------------------------------------------------
     API per Fase B / UI (innocue in Fase A)
     ------------------------------------------------------------------ */

  /* Minaccia pirata 0..1 su un sistema (gancio M07/M09: incidenti +
     combattimento). In Fase A è esposta ma non ancora consumata dagli
     incidenti delle spedizioni — wiring rimandato a Fase B/M09. */
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

  /* Dati per il dossier-civiltà (Fase B). In Fase A è disponibile per la
     cronaca/marker, la scheda vera arriva dopo. */
  function dossier(civ) {
    if (!civ) return null;
    return {
      name: civ.name, alignment: civ.alignment, archetypeLabel: civ.archetypeLabel,
      traitLabel: civ.traitLabel, color: civ.color, systems: civ.systems.length,
      disposition: Math.round(civ.disposition), contacted: !!civ.contacted,
      tier: civ.homeTier
    };
  }

  /* ------------------------------------------------------------------
     M10 Fase B (decisione #47): helper per il dossier-civiltà e la vista
     "Civiltà". Valori COARSE dove serve mantenere la nebbia (#5/§5.1):
     il giocatore conosce l'identità e la disposizione, ma la potenza
     resta una stima a fasce, non un numero esatto.
     ------------------------------------------------------------------ */
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
  /* Quanti sistemi della civiltà il giocatore ha già visto (DETECTED+).
     È ciò che il giocatore "sa", non il totale reale (nebbia di guerra). */
  function knownSystemsCount(game, civ) {
    let n = 0;
    for (let i = 0; i < civ.systems.length; i++) {
      if (discovered(game, civ.systems[i])) n++;
    }
    return n;
  }
  /* Lista delle civiltà già contattate (vive). */
  function contactedCivs(game) {
    return (game.civs || []).filter(function (c) { return c.alive && c.contacted; });
  }

  /* ------------------------------------------------------------------
     SCAFFOLD materializzazione LOD (decisione #47) — gancio M09.
     Quando una civiltà AGGREGATA deve entrare in uno scontro col
     giocatore, M09 la "materializzerà" in una forza concreta. Qui forniamo
     solo il DESCRITTORE (puro, nessuna mutazione di stato, nessun
     combattimento): M09 lo consumerà per costruire le entità reali, poi
     chiamerà demobilize() per riportare la civiltà ad aggregata.
     In Fase A/B la materializzazione NON avviene (lo scontro è M09).
     ------------------------------------------------------------------ */
  function materialize(game, civ, sysId) {
    if (!civ) return null;
    // forza concreta proporzionale alla potenza aggregata locale (coarse)
    const units = Math.max(1, Math.round(civ.power / 25));
    return {
      civId: civ.id, civName: civ.name, alignment: civ.alignment,
      color: civ.color, atSystem: sysId,
      units: units, power: civ.power,
      // M09 riempirà ships:[] con classi reali (riuso catalogo ORION.fleet)
      ships: []
    };
  }
  function demobilize(game, civ, outcome) {
    /* M09 Fase A (decisione #49): applica l'esito di una scaramuccia sulla
       potenza AGGREGATA della civiltà (niente perdita di sistemi in Fase A:
       la conquista è Fase B). Se vince il giocatore la civiltà perde potenza;
       se vince la civiltà, perde comunque un po' (ha speso forze). Bounded. */
    if (!civ || !outcome) return true;
    const loss = (outcome.winner === 'player') ? 12 : 5;
    civ.power = Math.max(0, civ.power - loss);
    /* M10 Fase C (decisione #47): registra l'esito come INTEL nel dossier
       (campo lazy, niente bump di schema — civ è serializzata in game.civs). */
    recordBattle(game, civ.id, outcome.winner === 'player' ? 'win' : 'loss', 'skirmish',
      outcome.report && outcome.report.systemId);
    return true;
  }

  /* ==================================================================
     M10 Fase C (decisione #47) — INTEL dossier combat-aware.
     Ora che M09 produce dati di combattimento, il dossier li riflette:
     stato di guerra/tregua col giocatore, stima della forza, ultimo
     scontro col suo esito, e il "perché" della disposizione. Tutto
     DERIVATO dallo stato esistente; l'unico campo nuovo è `civ.lastBattle`
     (lazy → niente bump di schema). Determinismo: nessun RNG.
     ================================================================== */

  /* Registra l'ultimo scontro col giocatore sul dossier della civiltà.
     result: 'win'|'loss' DAL PUNTO DI VISTA DEL GIOCATORE. */
  function recordBattle(game, civId, result, kind, sysId) {
    const civ = (game.civs || []).filter(function (c) { return c.id === civId; })[0];
    if (!civ) return;
    civ.lastBattle = {
      result: result, kind: kind || 'skirmish',
      sysId: (sysId == null ? -1 : sysId), impulso: game.timeImpulsi || 0
    };
  }

  /* Stato della relazione col giocatore (derivato): tregua → guerra attiva
     → ostile → disposizione. Per il chip del dossier. */
  function relationStatus(game, civ) {
    const now = game.timeImpulsi || 0;
    if ((civ.truceUntil || 0) > now) return { id: 'truce', label: 'Tregua' };
    const inc = (game.incursions || []).some(function (i) { return i.kind === 'ai' && i.civId === civ.id; });
    const bat = (game.battles || []).some(function (b) { return b.attackerKind === 'ai' && b.attackerCiv === civ.id && b.status === 'active'; });
    if (inc || bat) return { id: 'war', label: 'In guerra' };
    const d = civ.disposition || 0;
    if (d <= -40) return { id: 'hostile', label: 'Ostile' };
    if (d >= 40) return { id: 'friendly', label: 'Amichevole' };
    if (d >= 15) return { id: 'cordial', label: 'Cordiale' };
    return { id: 'neutral', label: 'Neutrale' };
  }

  /* Stima coarse della forza materializzabile (numero di unità), coerente
     con la formula di materialize(). Mantiene la nebbia (è una stima). */
  function forceEstimate(game, civ) {
    return Math.max(1, Math.round((civ.power || 0) / 25));
  }

  /* "Perché" della disposizione: euristica leggibile dai fattori che la
     guidano (allineamento, azioni morali del giocatore #23, vicinanza,
     ultimo scontro). Stringa breve per il dossier. */
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

  /* Reputazione globale del giocatore come anteprima (§14, decisione #47):
     media delle disposizioni delle civiltà CONTATTATE, mappata 0..100.
     Se nessun contatto, neutro (50). */
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
    generate: generate,
    ensure: ensure,
    tick: tick,
    ownerMap: ownerMap,
    civForSystem: civForSystem,
    pirateThreat: pirateThreat,
    dossier: dossier,
    reputationPreview: reputationPreview,
    /* Fase B */
    dispositionLabel: dispositionLabel,
    powerTier: powerTier,
    knownSystemsCount: knownSystemsCount,
    contactedCivs: contactedCivs,
    materialize: materialize,
    demobilize: demobilize,
    /* Fase C — intel dossier combat-aware */
    recordBattle: recordBattle,
    relationStatus: relationStatus,
    forceEstimate: forceEstimate,
    dispositionReason: dispositionReason,
    /* Fase E — pirati raidabili + raider */
    knownNests: knownNests
  };
})(typeof window !== 'undefined' ? window : this);
