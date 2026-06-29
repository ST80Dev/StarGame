/* =====================================================================
   ORION EMPIRES — phenomena.js  (FSP — Fenomeni di Spazio Profondo, §17.7)

   Categoria SEPARATA dalle Anomalie §17.3 (anomaly.js): quelle vivono
   DENTRO i sistemi; gli FSP vivono nello SPAZIO INTERSTELLARE sulla mappa
   galattica, anche FUORI dalle rotte (negli interstizi tra cluster, ai
   bordi, nel vuoto). Punti casuali da scoprire / sfruttare / evitare il cui
   effetto il giocatore impara giocando (opacità by design, GDD §20/§17.7).

   FASE 1 (questo file): SOLO data-layer.
     - Generazione DETERMINISTICA dal seed (struttura immutabile, niente
       costo di salvataggio — si rigenera con la galassia, come i gruppi).
     - "Profilo fenomenologico" per-galassia → variabilità TRA partite.
     - Piazzamento off-lane + distribuzioni miste → variabilità DENTRO la
       stessa galassia (cluster / vuoti / frontiera, frequenza con jitter).
     - Stato delta lazy in `game.phenomena[id]` (additivo, NESSUN bump schema).
   NON inclusi qui (fasi successive): rendering mappa (Fase 2), scansione/
   investigazione/risoluzione effetti + Cronaca/tutorial (Fase 3), varchi e
   contendibilità AI (Fasi 4-5). Gli EFFETTI non vivono in questo file.

   Determinismo (#5): zero Math.random; tutto da ORION.rng.makeRng(seed...).
   Recovery-friendly (#22): nessuno stato qui è punitivo o di fail.
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  /* Livelli di scoperta (grammatica §17.7.2). Solo la definizione: la
     promozione tra livelli è logica di Fase 3. */
  const DISCOVERY = { ECO: 0, CONTATTO: 1, CLASSIFICATO: 2, RIVELATO: 3 };

  const CFG = {
    /* Distanza minima dal sistema più vicino: garantisce "off-lane" (un FSP
       non coincide mai con un sistema). In unità mappa normalizzata [0,1]. */
    MIN_OFF: 0.022,
    /* Un punto è considerato "vuoto profondo" se dista almeno questo dal
       sistema più vicino (usato in modalità di piazzamento 'void'). */
    VOID_MIN: 0.075,
    /* Padding dai bordi della mappa. */
    PAD: 0.02,
    /* Tetto di FSP "unici con nome" per galassia (GDD §17.7.5: 0-2). */
    MAX_UNIQUE: 2,
    /* Conteggio atteso calibrato su una galassia "standard" di ~100 sistemi;
       scalato linearmente con galaxy.count. */
    REF_SYSTEMS: 100
  };

  /* ------------------------------------------------------------------
     CLASSI (§17.7.3). Metadati di GENERAZIONE e PRESENTAZIONE soltanto.
     `tenor`  = tendenza (boon>0 / hazard<0) — NON l'effetto.
     `base`   = conteggio atteso su REF_SYSTEMS sistemi (prima di profilo).
     `tierBias` = peso di scelta del gruppo per tier (placement 'cluster').
     `modeBias` = peso delle modalità di piazzamento.
     `variants` = sottotipi leggibili; il primo è il più comune.
     `glyph`  = placeholder testuale (il rendering vero è Fase 2 via icons).
     ------------------------------------------------------------------ */
  const CLASSES = {
    grav: {
      id: 'grav', label: 'Gravitazionale', glyph: '◎', tenor: -0.2, base: 3.0,
      variants: ['maelstrom', 'lente', 'varco'],
      tierBias: { nucleo: 3, colonie: 2, frontiera: 1, orlo: 1, sconosciuto: 1 },
      modeBias: { cluster: 0.5, void: 0.4, frontier: 0.1 }
    },
    relic: {
      id: 'relic', label: 'Reliquia / Artificiale', glyph: '⬡', tenor: 0.3, base: 3.0,
      variants: ['relitto', 'megastruttura', 'avamposto'],
      tierBias: { nucleo: 1, colonie: 1, frontiera: 2, orlo: 3, sconosciuto: 3 },
      modeBias: { cluster: 0.4, frontier: 0.4, void: 0.2 }
    },
    emis: {
      id: 'emis', label: 'Emissione / Stellare', glyph: '✶', tenor: 0.1, base: 2.5,
      variants: ['pulsar', 'tempesta'],
      tierBias: { nucleo: 1, colonie: 1, frontiera: 1, orlo: 1, sconosciuto: 1 },
      modeBias: { cluster: 0.6, void: 0.3, frontier: 0.1 }
    },
    bio: {
      id: 'bio', label: 'Biologica / Esotica', glyph: '❋', tenor: -0.1, base: 2.0,
      variants: ['sciame', 'marea'],
      tierBias: { nucleo: 1, colonie: 2, frontiera: 2, orlo: 1, sconosciuto: 1 },
      modeBias: { cluster: 0.6, void: 0.2, frontier: 0.2 }
    },
    temp: {
      id: 'temp', label: 'Temporale / Vuoto', glyph: '⌖', tenor: 0.0, base: 0.8,
      variants: ['eco', 'distorsione'],
      tierBias: { nucleo: 1, colonie: 1, frontiera: 1, orlo: 2, sconosciuto: 3 },
      modeBias: { void: 0.7, frontier: 0.2, cluster: 0.1 }
    }
  };
  const CLASS_ORDER = ['grav', 'relic', 'emis', 'bio', 'temp'];

  /* Varianti candidate a diventare "uniche con nome" (event-tier, §17.7.5). */
  const UNIQUE_VARIANTS = { varco: 1, megastruttura: 1, avamposto: 1 };

  /* ------------------------------------------------------------------
     PROFILI FENOMENOLOGICI (§17.7.5 asse A — variabilità TRA partite).
     `density` moltiplica il `base` per classe; assente = 1. `richness`
     scala l'intero set; `tenor` sbilancia boon/hazard (default ~0).
     `w` = peso di estrazione. Default 'equilibrata'.
     ------------------------------------------------------------------ */
  const PROFILES = [
    { id: 'equilibrata', w: 4, richness: 1.0, tenor: 0.0, density: {} },
    { id: 'ricca-reliquie', w: 2, richness: 1.2, tenor: 0.2,
      density: { relic: 1.8, grav: 0.9, bio: 0.9 } },
    { id: 'travagliata', w: 2, richness: 1.2, tenor: -0.3,
      density: { grav: 1.8, bio: 1.3, relic: 0.8 } },
    { id: 'silente', w: 2, richness: 0.6, tenor: 0.0,
      density: { grav: 0.8, relic: 0.8, emis: 0.8, bio: 0.8, temp: 1.4 } },
    { id: 'fertile', w: 1, richness: 1.1, tenor: 0.1,
      density: { bio: 1.8, emis: 1.2, relic: 0.9 } },
    { id: 'antica', w: 1, richness: 1.0, tenor: 0.0,
      density: { relic: 1.4, temp: 1.6, emis: 0.9 } }
  ];

  /* ------------------------------------------------------------------
     Helper deterministici
     ------------------------------------------------------------------ */
  function mkRng(galaxy, scope) {
    return ORION.rng.makeRng(String(galaxy.seed) + ':phenomena:' + scope);
  }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function clampPt(p) {
    p.x = clamp(p.x, CFG.PAD, 1 - CFG.PAD);
    p.y = clamp(p.y, CFG.PAD, 1 - CFG.PAD);
    return p;
  }

  /* Estrazione pesata da [{w}] con un rng. */
  function weightedPick(arr, rng) {
    let total = 0;
    for (let i = 0; i < arr.length; i++) total += (arr[i].w || 0);
    let r = rng.range(0, total);
    for (let i = 0; i < arr.length; i++) {
      r -= (arr[i].w || 0);
      if (r <= 0) return arr[i];
    }
    return arr[arr.length - 1];
  }

  /* Estrazione pesata da una mappa {chiave:peso}. */
  function weightedKey(weights, rng) {
    const keys = Object.keys(weights);
    let total = 0;
    for (let i = 0; i < keys.length; i++) total += weights[keys[i]];
    let r = rng.range(0, total);
    for (let i = 0; i < keys.length; i++) {
      r -= weights[keys[i]];
      if (r <= 0) return keys[i];
    }
    return keys[keys.length - 1];
  }

  /* Conteggio con jitter; ammette 0 (variabilità: una classe può mancare). */
  function rollCount(expected, rng) {
    if (expected <= 0) return 0;
    const n = expected * rng.range(0.6, 1.4);
    const base = Math.floor(n);
    return base + (rng.chance(n - base) ? 1 : 0);
  }

  function dist2(ax, ay, bx, by) {
    const dx = ax - bx, dy = ay - by;
    return dx * dx + dy * dy;
  }

  /* Sistema più vicino a (x,y) → { id, dist }. */
  function nearestSystem(galaxy, x, y) {
    const sys = galaxy.systems;
    let bestId = -1, bestD2 = Infinity;
    for (let i = 0; i < sys.length; i++) {
      const d2 = dist2(x, y, sys[i].x, sys[i].y);
      if (d2 < bestD2) { bestD2 = d2; bestId = i; }
    }
    return { id: bestId, dist: Math.sqrt(bestD2) };
  }

  /* Gruppo (cluster) più vicino a (x,y) per centroide → id. */
  function nearestGroupId(galaxy, x, y) {
    const gs = galaxy.groups;
    let bestId = gs.length ? gs[0].id : null, bestD2 = Infinity;
    for (let i = 0; i < gs.length; i++) {
      const d2 = dist2(x, y, gs[i].cx, gs[i].cy);
      if (d2 < bestD2) { bestD2 = d2; bestId = gs[i].id; }
    }
    return bestId;
  }

  /* Garantisce off-lane: se il punto è troppo vicino a un sistema, lo
     allontana lungo la direzione opposta fino a MIN_OFF. Idempotente entro
     i bordi (clamp finale). */
  function ensureOffLane(galaxy, p) {
    let near = nearestSystem(galaxy, p.x, p.y);
    if (near.dist >= CFG.MIN_OFF) return near;
    const s = galaxy.systems[near.id];
    let dx = p.x - s.x, dy = p.y - s.y;
    let len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-6) { dx = 1; dy = 0; len = 1; } // degenerato: spingi verso +x
    const push = (CFG.MIN_OFF - near.dist) + 0.004;
    p.x += (dx / len) * push;
    p.y += (dy / len) * push;
    clampPt(p);
    return nearestSystem(galaxy, p.x, p.y);
  }

  /* ------------------------------------------------------------------
     PIAZZAMENTO (§17.7.5 asse B). Tre modalità:
       cluster  — vicino a un gruppo (tier-pesato), off-lane.
       void     — negli interstizi tra cluster (lontano da ogni sistema).
       frontier — appena oltre un sistema ad alto pericolo, verso l'esterno.
     ------------------------------------------------------------------ */
  function samplePoint(galaxy, def, mode, rng) {
    let x, y, z = 0;
    const groups = galaxy.groups;

    if (mode === 'void') {
      // rejection sampling: punto profondo (lontano da ogni sistema)
      let bx = 0.5, by = 0.5, bestD = -1;
      for (let t = 0; t < 24; t++) {
        const cx = rng.range(CFG.PAD, 1 - CFG.PAD);
        const cy = rng.range(CFG.PAD, 1 - CFG.PAD);
        const d = nearestSystem(galaxy, cx, cy).dist;
        if (d > bestD) { bestD = d; bx = cx; by = cy; }
        if (d >= CFG.VOID_MIN) { bx = cx; by = cy; break; }
      }
      x = bx; y = by;
      z = rng.range(-0.06, 0.06);
    } else if (mode === 'frontier') {
      // pesa i sistemi per pericolo (danger^2) → preferisce la frontiera
      const sys = galaxy.systems;
      let total = 0;
      for (let i = 0; i < sys.length; i++) {
        const d = sys[i].danger || 0; total += d * d + 1;
      }
      let r = rng.range(0, total), pick = sys[0];
      for (let i = 0; i < sys.length; i++) {
        const d = sys[i].danger || 0; r -= (d * d + 1);
        if (r <= 0) { pick = sys[i]; break; }
      }
      // direzione dal centro galattico verso il sistema → spingi oltre
      let dx = pick.x - 0.5, dy = pick.y - 0.5;
      let len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1e-6) { const a = rng.range(0, Math.PI * 2); dx = Math.cos(a); dy = Math.sin(a); len = 1; }
      const off = rng.range(0.02, 0.07);
      x = pick.x + (dx / len) * off + rng.range(-0.02, 0.02);
      y = pick.y + (dy / len) * off + rng.range(-0.02, 0.02);
      z = (pick.z || 0) + rng.range(-0.04, 0.04);
    } else {
      // cluster: scegli un gruppo per tier-bias, campiona attorno al centroide
      const weights = {};
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        weights[String(g.id)] = (def.tierBias[g.tier] != null ? def.tierBias[g.tier] : 1);
      }
      const gid = Number(weightedKey(weights, rng));
      let g = groups[0];
      for (let i = 0; i < groups.length; i++) if (groups[i].id === gid) { g = groups[i]; break; }
      const ang = rng.range(0, Math.PI * 2);
      const rad = (g.radius || 0.05) * rng.range(0.5, 1.4) + 0.012;
      x = g.cx + Math.cos(ang) * rad;
      y = g.cy + Math.sin(ang) * rad;
      z = (g.cz || 0) + rng.range(-0.035, 0.035);
    }

    const p = clampPt({ x: x, y: y, z: z });
    const near = ensureOffLane(galaxy, p);
    return {
      x: p.x, y: p.y, z: p.z,
      groupId: nearestGroupId(galaxy, p.x, p.y),
      nearSys: near.id,
      nearDist: +near.dist.toFixed(5)
    };
  }

  /* ------------------------------------------------------------------
     NOMI procedurali (#34 — SW-flavor, niente marchi). Deterministici per
     istanza. Solo flavor: usati alla classificazione/unicità in Fase 3.
     ------------------------------------------------------------------ */
  const NAME_SYL = ['vor', 'keth', 'dra', 'xis', 'nar', 'thal', 'ser', 'eth',
    'val', 'dris', 'om', 'lir', 'nos', 'vael', 'cael', 'rax', 'zor', 'vyn',
    'thys', 'mir', 'ghul', 'vann', 'auv', 'oren'];
  const NAME_PREFIX = {
    grav: ['Vortice', 'Gorgo', 'Abisso'],
    relic: ['Rovine di', 'Eredità di', 'Sepolcro di'],
    emis: ['Faro', 'Pulsar', 'Bagliore'],
    bio: ['Distesa', 'Banco', 'Marea'],
    temp: ['Eco', 'Frattura', 'Soglia']
  };
  function makeToken(rng) {
    const n = rng.int(2, 3);
    let s = '';
    for (let i = 0; i < n; i++) s += rng.pick(NAME_SYL);
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function makeName(galaxy, ph) {
    const rng = ORION.rng.makeRng(String(galaxy.seed) + ':phenomname:' + ph.id);
    const pref = (NAME_PREFIX[ph.cls] || ['Anomalia'])[rng.int(0, (NAME_PREFIX[ph.cls] || [0, 0, 0]).length - 1)];
    return pref + ' ' + makeToken(rng);
  }

  /* ------------------------------------------------------------------
     GENERAZIONE — struttura IMMUTABILE (rigenerata dal seed, non salvata).
     ------------------------------------------------------------------ */
  function profileFor(galaxy) {
    const rng = mkRng(galaxy, 'profile');
    const base = weightedPick(PROFILES, rng);
    const density = {};
    for (let i = 0; i < CLASS_ORDER.length; i++) {
      const c = CLASS_ORDER[i];
      const d = (base.density && base.density[c] != null) ? base.density[c] : 1;
      density[c] = d * rng.range(0.7, 1.3);
    }
    return {
      archetype: base.id,
      richness: base.richness * rng.range(0.85, 1.15),
      tenor: clamp(base.tenor + rng.range(-0.15, 0.15), -1, 1),
      density: density
    };
  }

  function generate(galaxy) {
    if (!galaxy || !galaxy.systems || !galaxy.groups) return [];
    const profile = profileFor(galaxy);
    const rng = mkRng(galaxy, 'gen');
    const scale = (galaxy.count || galaxy.systems.length) / CFG.REF_SYSTEMS;
    const list = [];
    let idx = 0;

    for (let ci = 0; ci < CLASS_ORDER.length; ci++) {
      const cls = CLASS_ORDER[ci];
      const def = CLASSES[cls];
      const expected = def.base * profile.richness * profile.density[cls] * scale;
      const count = rollCount(expected, rng);
      for (let k = 0; k < count; k++) {
        const mode = weightedKey(def.modeBias, rng);
        const pt = samplePoint(galaxy, def, mode, rng);
        // variante pesata: la prima è la più comune
        const vIdx = rng.chance(0.62) ? 0 : rng.int(1, def.variants.length - 1);
        const variant = def.variants[Math.min(vIdx, def.variants.length - 1)];
        const id = 'P' + (idx++);
        list.push({
          id: id,
          cls: cls,
          variant: variant,
          mode: mode,
          x: +pt.x.toFixed(5),
          y: +pt.y.toFixed(5),
          z: +pt.z.toFixed(5),
          groupId: pt.groupId,
          nearSys: pt.nearSys,
          nearDist: pt.nearDist,
          tenor: def.tenor,
          intensity: +rng.range(0, 1).toFixed(4),
          unique: false,
          name: '',
          // seme per la risoluzione effetti (Fase 3): stabile per istanza
          effectSeed: String(galaxy.seed) + ':phenom:' + id
        });
      }
    }

    assignUniques(galaxy, list, rng);
    for (let i = 0; i < list.length; i++) list[i].name = makeName(galaxy, list[i]);
    return list;
  }

  /* Assegna fino a MAX_UNIQUE flag "unico con nome" (event-tier), preferendo
     le varianti candidate; budget 0..MAX_UNIQUE estratto dal seed. */
  function assignUniques(galaxy, list, rng) {
    const budget = rng.int(0, CFG.MAX_UNIQUE);
    if (budget <= 0) return;
    const cand = [];
    for (let i = 0; i < list.length; i++) {
      if (UNIQUE_VARIANTS[list[i].variant] || list[i].cls === 'temp') cand.push(i);
    }
    if (!cand.length) return;
    rng.shuffle(cand);
    const n = Math.min(budget, cand.length);
    for (let i = 0; i < n; i++) list[cand[i]].unique = true;
  }

  /* Lista immutabile con cache transitoria sulla galassia (come i gruppi:
     si rigenera dal seed, non vive nel save). */
  function forGalaxy(galaxy) {
    if (!galaxy) return [];
    if (!galaxy._phenomena) galaxy._phenomena = generate(galaxy);
    return galaxy._phenomena;
  }

  /* ------------------------------------------------------------------
     STATO (delta) — additivo lazy, NESSUN bump di schema.
     game.phenomena[id] = { d: discoveryLevel, owned?, used?, marked?, ... }
     ------------------------------------------------------------------ */
  function ensure(game) {
    if (!game) return;
    if (!game.phenomena || typeof game.phenomena !== 'object') game.phenomena = {};
    // pre-genera la lista immutabile se la galassia è disponibile (cache)
    if (game.galaxy) { forGalaxy(game.galaxy); applyVarchiLinks(game); }
  }

  function stateOf(game, id) {
    if (!game || !game.phenomena) return { d: DISCOVERY.ECO };
    return game.phenomena[id] || { d: DISCOVERY.ECO };
  }

  /* Vista per la UI (Fase 2/3): immutabile + stato delta unito. */
  function list(game) {
    if (!game || !game.galaxy) return [];
    const items = forGalaxy(game.galaxy);
    return items.map(function (ph) {
      const st = stateOf(game, ph.id);
      const g = game.galaxy.groups && game.galaxy.groups[ph.groupId];
      return {
        id: ph.id, cls: ph.cls, classLabel: CLASSES[ph.cls].label,
        glyph: CLASSES[ph.cls].glyph, variant: ph.variant, mode: ph.mode,
        x: ph.x, y: ph.y, z: ph.z, groupId: ph.groupId,
        groupName: g ? g.name : null,
        unique: ph.unique, name: ph.name, tenor: ph.tenor,
        intensity: ph.intensity, nearSys: ph.nearSys,
        disc: st.d || DISCOVERY.ECO,
        owned: !!st.owned, used: !!st.used, marked: !!st.marked,
        outcome: st.outcome || null
      };
    });
  }

  /* ==================================================================
     FASE 3 — SCOPERTA, INTERAZIONE, EFFETTI
     I 4 verbi (§17.7.2): Scansiona · Investiga · Sfrutta/Controlla · Marca.
     Il giocatore conosce i verbi; l'EFFETTO si rivela solo investigando.
     Tutto deterministico (effectSeed per istanza). Recovery-friendly:
     gli hazard sono limitati (le navi sopravvivono), nessun fail-state.
     ================================================================== */

  const DISC_EXPLORED = 2; // ORION.galaxy DISCOVERY.EXPLORED

  /* Tuning effetti (in codice, non player-facing: opacità by design). I
     valori sono CAP modesti — gli FSP NON sono game-winner (§17.7.1). */
  const FX = {
    DETECT_RADIUS: 0.10,         // un sistema esplorato entro questo raggio rileva l'FSP
    CACHE_MIN: 60, CACHE_SPAN: 240,   // cache risorse one-shot (×intensità)
    LOSS_MIN: 20, LOSS_SPAN: 90,      // perdita risorse (hazard)
    WEAR_MIN: 8, WEAR_SPAN: 22,       // usura navi (hazard), cap 100
    REVEAL_MIN: 1, REVEAL_SPAN: 3,    // sistemi rivelati (intel)
    UNIQUE_MULT: 1.6,                 // gli unici sono più "grossi" (sempre capati)
    PASSIVE_RATE_MIN: 0.3, PASSIVE_RATE_SPAN: 0.9, // trickle/Ι nodo posseduto
    PASSIVE_CAP: 1500,           // tetto totale dal nodo posseduto (anti-game-winner)
    /* Fase 5 — contendibilità: un nodo posseduto e NON presidiato può essere
       sottratto dall'AI. Grazia generosa (puoi assentarti) + roll periodico
       deterministico scalato da pericolo/ICG. Recovery-friendly: si ri-rivendica. */
    CONTEST_GRACE: 250,          // Ι senza presidio prima di rischiare
    CONTEST_PERIOD: 120,         // un solo roll ogni N Ι
    CONTEST_P_BASE: 0.12,        // probabilità base (scalata, cap 0.6)
    /* Fase 5 — pressione ICG da hazard classificati ma NON gestiti (né
       investigati/neutralizzati né marcati come da evitare). Lieve; l'ICG
       decade verso 20 in ai.js, quindi è una tensione, non una spirale. */
    ICG_HAZARD_DRIP: 0.004, ICG_DRIP_MAX_SOURCES: 6
  };
  /* Etichette fazione per il flavor della contendibilità (#34, §13.7). */
  function contestFaction(ph, rng) {
    if (ph.cls === 'relic' || ph.cls === 'temp' || ph.unique) return 'il Conclave di Vehryn';
    return rng.pick(['una banda pirata', 'il Sindacato Mekhari', 'il Conclave di Vehryn']);
  }
  /* Risorsa "naturale" per classe (cache/loss). bio sceglie food/water. */
  const RES_BY_CLASS = { grav: 'en', relic: 'met', emis: 'en', bio: 'food', temp: 'met' };
  const RES_LABEL = { met: 'metalli', en: 'energia', food: 'cibo', water: 'acqua' };

  function byId(galaxy, id) {
    const items = forGalaxy(galaxy);
    for (let i = 0; i < items.length; i++) if (items[i].id === id) return items[i];
    return null;
  }
  function ensureState(game, id) {
    if (!game.phenomena || typeof game.phenomena !== 'object') game.phenomena = {};
    if (!game.phenomena[id]) game.phenomena[id] = { d: DISCOVERY.ECO };
    return game.phenomena[id];
  }

  /* Una flotta DEL GIOCATORE presente (in orbita/attracco) nel sistema. */
  function playerFleetAtSystem(game, sysId) {
    const fl = game.fleets || [];
    for (let i = 0; i < fl.length; i++) {
      const f = fl[i];
      if (!f || !f.location || f.location.systemId !== sysId) continue;
      if (f.location.status === 'orbiting' || f.location.status === 'docked') return f;
    }
    return null;
  }
  function colonyInSystem(game, sysId) {
    const cols = game.colonies || {};
    const keys = Object.keys(cols);
    for (let i = 0; i < keys.length; i++) {
      const c = cols[keys[i]];
      if (c && c.systemId === sysId && c.colonized) return keys[i];
    }
    return null;
  }
  function depositColonyKey(game) {
    if (ORION.dispatch && ORION.dispatch.payColonyKey) {
      const k = ORION.dispatch.payColonyKey(game);
      if (k && game.colonies[k]) return k;
    }
    const keys = Object.keys(game.colonies || {});
    for (let i = 0; i < keys.length; i++) if (game.colonies[keys[i]].colonized) return keys[i];
    return null;
  }
  function deposit(game, res, amt) {
    const k = depositColonyKey(game);
    const col = k && game.colonies[k];
    if (col && col.stock) { col.stock[res] = Math.max(0, (col.stock[res] || 0) + amt); return true; }
    return false;
  }

  /* ------------------------------------------------------------------
     SCOPERTA (livello CONTATTO): un FSP "pinga" sulla mappa quando un
     sistema esplorato è vicino (il suo nearSys, o uno entro DETECT_RADIUS).
     Con `events` → emette voce di Cronaca per le NUOVE rilevazioni; senza
     (boot/load) → baseline silenziosa (niente spam retroattivo).
     ------------------------------------------------------------------ */
  function isDetected(game, ph) {
    const disc = game.state && game.state.discovery;
    if (!disc) return false;
    if ((disc[ph.nearSys] || 0) >= DISC_EXPLORED) return true;
    const sys = game.galaxy.systems;
    const r2 = FX.DETECT_RADIUS * FX.DETECT_RADIUS;
    for (let i = 0; i < sys.length; i++) {
      if ((disc[i] || 0) < DISC_EXPLORED) continue;
      const dx = sys[i].x - ph.x, dy = sys[i].y - ph.y;
      if (dx * dx + dy * dy <= r2) return true;
    }
    return false;
  }
  function detect(game, events) {
    if (!game || !game.galaxy) return;
    const items = forGalaxy(game.galaxy);
    for (let i = 0; i < items.length; i++) {
      const ph = items[i];
      const st = game.phenomena[ph.id];
      if (st && (st.d || 0) >= DISCOVERY.CONTATTO) continue;
      if (!isDetected(game, ph)) continue;
      const s = ensureState(game, ph.id);
      s.d = DISCOVERY.CONTATTO;
      if (events) {
        const sys = game.galaxy.systems[ph.nearSys];
        events.push({
          kind: 'fsp-contact', id: ph.id,
          sysId: ph.nearSys, sysName: sys ? sys.name : '—',
          x: ph.x, y: ph.y, impulso: game.timeImpulsi || 0
        });
      }
    }
  }

  /* Descrittore ambiguo mostrato alla CLASSIFICAZIONE (non rivela l'effetto). */
  const DESCRIPTORS = ['firma dormiente', 'eco antica', 'lettura instabile',
    'risonanza irregolare', 'traccia fredda', 'segnatura profonda'];
  function descriptorFor(ph) {
    const rng = ORION.rng.makeRng(ph.effectSeed + ':desc');
    return rng.pick(DESCRIPTORS);
  }
  function tenorHint(ph) {
    return ph.tenor > 0.12 ? 'promettente' : (ph.tenor < -0.12 ? 'minaccioso' : 'incerto');
  }

  /* ------------------------------------------------------------------
     AZIONE 1 — SCANSIONA (Contatto → Classificato). Richiede una flotta o
     una colonia nel sistema d'aggancio (nearSys). Nessun effetto.
     ------------------------------------------------------------------ */
  function canScan(game, id) {
    const ph = byId(game.galaxy, id); if (!ph) return { ok: false, reason: 'assente' };
    const st = ensureState(game, id);
    if ((st.d || 0) !== DISCOVERY.CONTATTO) return { ok: false, reason: 'non-contatto' };
    if (playerFleetAtSystem(game, ph.nearSys) || colonyInSystem(game, ph.nearSys)) return { ok: true };
    return { ok: false, reason: 'serve flotta o colonia nel sistema d\'aggancio' };
  }
  function scan(game, id) {
    const c = canScan(game, id); if (!c.ok) return c;
    const ph = byId(game.galaxy, id);
    const st = ensureState(game, id);
    st.d = DISCOVERY.CLASSIFICATO;
    return { ok: true, classLabel: CLASSES[ph.cls].label, variant: ph.variant,
      descriptor: descriptorFor(ph), tenorHint: tenorHint(ph) };
  }

  /* ------------------------------------------------------------------
     RISOLUTORE EFFETTI (one-shot, deterministico da effectSeed). Categorie:
     cache (boon risorse, sfruttabile) · intel (rivela sistemi) · hazard
     (usura/perdita, recovery-friendly) · shortcut (varco, gancio Fase 4) ·
     dormant (inconcludente). Magnitudini ∝ intensità, sempre capate.
     ------------------------------------------------------------------ */
  const CAT_WEIGHTS = {
    grav:  { hazard: 0.45, intel: 0.25, shortcut: 0.20, cache: 0.10 },
    relic: { cache: 0.55, intel: 0.30, hazard: 0.15 },
    emis:  { intel: 0.55, cache: 0.25, hazard: 0.20 },
    bio:   { cache: 0.50, hazard: 0.35, intel: 0.15 },
    temp:  { cache: 0.2, intel: 0.2, hazard: 0.2, shortcut: 0.2, dormant: 0.2 }
  };
  function revealNearbySystems(game, ph, k) {
    const sys = game.galaxy.systems;
    const order = [];
    for (let i = 0; i < sys.length; i++) {
      const dx = sys[i].x - ph.x, dy = sys[i].y - ph.y;
      order.push({ id: i, d2: dx * dx + dy * dy });
    }
    order.sort(function (a, b) { return a.d2 - b.d2; });
    let done = 0;
    for (let i = 0; i < order.length && done < k; i++) {
      if (ORION.galaxy && ORION.galaxy.revealSystem) {
        if (ORION.galaxy.revealSystem(game.galaxy, order[i].id, game.state)) done++;
        else {
          // già esplorato: promuovilo comunque "consumando" lo slot solo se ignoto
          const disc = game.state && game.state.discovery;
          if (disc && (disc[order[i].id] || 0) < DISC_EXPLORED) { disc[order[i].id] = DISC_EXPLORED; done++; }
        }
      }
    }
    return done;
  }
  function resolveEffect(game, ph) {
    const rng = ORION.rng.makeRng(ph.effectSeed + ':fx');
    const cat = weightedKey(CAT_WEIGHTS[ph.cls] || CAT_WEIGHTS.temp, rng);
    const mult = ph.unique ? FX.UNIQUE_MULT : 1;
    const inten = ph.intensity || 0.5;

    if (cat === 'cache') {
      let res = RES_BY_CLASS[ph.cls] || 'met';
      if (ph.cls === 'bio') res = rng.chance(0.5) ? 'food' : 'water';
      const amt = Math.round((FX.CACHE_MIN + inten * FX.CACHE_SPAN) * mult);
      deposit(game, res, amt);
      return { category: 'cache', res: res, amount: amt, exploitable: true,
        text: 'Cache di risorse recuperata: +' + amt + ' ' + RES_LABEL[res] + '.' };
    }
    if (cat === 'intel') {
      const k = FX.REVEAL_MIN + Math.round(inten * FX.REVEAL_SPAN);
      const done = revealNearbySystems(game, ph, k);
      return { category: 'intel', reveals: done, exploitable: false,
        text: done > 0 ? ('Dati di navigazione: rivelati ' + done + ' sistemi vicini.')
                       : 'Dati di navigazione: nessun sistema nuovo nei dintorni.' };
    }
    if (cat === 'hazard') {
      const wear = Math.min(60, Math.round(FX.WEAR_MIN + inten * FX.WEAR_SPAN));
      const fleet = playerFleetAtSystem(game, ph.nearSys);
      if (fleet && Array.isArray(fleet.ships)) {
        for (let i = 0; i < fleet.ships.length; i++) {
          fleet.ships[i].wear = Math.min(100, (fleet.ships[i].wear || 0) + wear);
        }
      }
      let lossTxt = '';
      if (rng.chance(0.5)) {
        const res = RES_BY_CLASS[ph.cls] || 'met';
        const loss = Math.round(FX.LOSS_MIN + inten * FX.LOSS_SPAN);
        deposit(game, res, -loss);
        lossTxt = ' Perduti ' + loss + ' ' + RES_LABEL[res] + '.';
      }
      return { category: 'hazard', wear: wear, exploitable: false,
        text: 'Pericolo! Le navi subiscono usura (+' + wear + '%).' + lossTxt };
    }
    if (cat === 'shortcut') {
      // varco: individua un'estremità lontana e rivelala (sai dove porta)
      const sys = game.galaxy.systems;
      let far = ph.nearSys, farD = -1;
      for (let i = 0; i < sys.length; i++) {
        const dx = sys[i].x - ph.x, dy = sys[i].y - ph.y, d = dx * dx + dy * dy;
        if (d > farD) { farD = d; far = i; }
      }
      revealOne(game, far);
      const nm = sys[far] ? sys[far].name : '—';
      return { category: 'shortcut', varcoTo: far, exploitable: true,
        text: 'Varco instabile verso ' + nm + '. Prendine il controllo per aprire la rotta.' };
    }
    return { category: 'dormant', exploitable: false,
      text: 'Lettura inconcludente: il fenomeno resta silente, per ora.' };
  }
  function revealOne(game, sysId) {
    if (ORION.galaxy && ORION.galaxy.revealSystem) { ORION.galaxy.revealSystem(game.galaxy, sysId, game.state); return; }
    const disc = game.state && game.state.discovery;
    if (disc && (disc[sysId] || 0) < DISC_EXPLORED) disc[sysId] = DISC_EXPLORED;
  }

  /* ------------------------------------------------------------------
     EFFETTO degli FSP UNICI (event-tier, §17.7.5 — gancio Faro di Orion /
     Anziani del Vuoto). Payload distintivo: cache colossale (più risorse) +
     dati antichi (rivela sistemi) + eventuale varco se la variante è 'varco'.
     Sempre capato (rari, 0-2/galassia): game-changer, non game-winner.
     Registra una voce di Memoria Storica permanente.
     ------------------------------------------------------------------ */
  function resolveUniqueEffect(game, ph) {
    const rng = ORION.rng.makeRng(ph.effectSeed + ':uniq');
    const inten = ph.intensity || 0.5;
    const metAmt = Math.round(300 + inten * 500);   // cap ~800
    const enAmt = Math.round(200 + inten * 400);    // cap ~600
    deposit(game, 'met', metAmt);
    deposit(game, 'en', enAmt);
    const k = 3 + Math.round(inten * 3);            // 3..6 sistemi
    const done = revealNearbySystems(game, ph, k);
    let varcoTo = null, varcoTxt = '';
    if (ph.variant === 'varco') {
      const sys = game.galaxy.systems;
      let far = ph.nearSys, farD = -1;
      for (let i = 0; i < sys.length; i++) {
        const dx = sys[i].x - ph.x, dy = sys[i].y - ph.y, d = dx * dx + dy * dy;
        if (d > farD) { farD = d; far = i; }
      }
      revealOne(game, far);
      varcoTo = far;
      varcoTxt = ' Si apre inoltre un varco verso ' + (sys[far] ? sys[far].name : '—') + '.';
    }
    return {
      category: 'unique', exploitable: true, res: 'met',
      amount: metAmt, en: enAmt, reveals: done, varcoTo: varcoTo,
      text: 'Eredità degli Anziani del Vuoto: cache colossale (+' + metAmt + ' metalli, +' +
        enAmt + ' energia) e dati antichi (' + done + ' sistemi rivelati).' + varcoTxt
    };
  }

  /* ------------------------------------------------------------------
     AZIONE 2 — INVESTIGA (Classificato → Rivelato). Richiede flotta nel
     sistema d'aggancio. Risolve e applica l'effetto (one-shot).
     ------------------------------------------------------------------ */
  function canInvestigate(game, id) {
    const ph = byId(game.galaxy, id); if (!ph) return { ok: false, reason: 'assente' };
    const st = ensureState(game, id);
    if ((st.d || 0) !== DISCOVERY.CLASSIFICATO) return { ok: false, reason: 'non-classificato' };
    if (!playerFleetAtSystem(game, ph.nearSys)) return { ok: false, reason: 'serve una tua flotta nel sistema d\'aggancio' };
    return { ok: true };
  }
  function investigate(game, id) {
    const c = canInvestigate(game, id); if (!c.ok) return c;
    const ph = byId(game.galaxy, id);
    const st = ensureState(game, id);
    const outcome = ph.unique ? resolveUniqueEffect(game, ph) : resolveEffect(game, ph);
    st.d = DISCOVERY.RIVELATO;
    st.outcome = outcome;
    st.used = !outcome.exploitable; // gli effetti non sfruttabili si esauriscono
    if (outcome.varcoTo != null) st.varcoTo = outcome.varcoTo;
    if (ph.unique && ORION.dispatch && ORION.dispatch.recordMemoria) {
      const sys = game.galaxy.systems[ph.nearSys];
      ORION.dispatch.recordMemoria(game, { kind: 'fsp-unique', name: ph.name,
        sysName: sys ? sys.name : '—', impulso: game.timeImpulsi || 0 });
    }
    return { ok: true, outcome: outcome };
  }

  /* ------------------------------------------------------------------
     AZIONE 3 — SFRUTTA/CONTROLLA (Rivelato + sfruttabile). Rivendica il
     nodo: effetto passivo (trickle) mentre lo presidi (vedi tick).
     Contendibile dall'AI in Fase 5.
     ------------------------------------------------------------------ */
  function canExploit(game, id) {
    const ph = byId(game.galaxy, id); if (!ph) return { ok: false, reason: 'assente' };
    const st = ensureState(game, id);
    if ((st.d || 0) !== DISCOVERY.RIVELATO || !st.outcome || !st.outcome.exploitable)
      return { ok: false, reason: 'non-sfruttabile' };
    if (st.owned) return { ok: false, reason: 'già sotto controllo' };
    if (!playerFleetAtSystem(game, ph.nearSys)) return { ok: false, reason: 'serve una tua flotta nel sistema d\'aggancio' };
    return { ok: true };
  }
  function exploit(game, id) {
    const c = canExploit(game, id); if (!c.ok) return c;
    const st = ensureState(game, id);
    st.owned = true; st.passiveTotal = st.passiveTotal || 0;
    st.undef = 0; st.aiFaction = null; // riconquista: azzera indifesa/fazione
    if (st.varcoTo != null) applyVarchiLinks(game); // (ri)attiva la scorciatoia
    return { ok: true, category: st.outcome.category };
  }

  /* ------------------------------------------------------------------
     VARCHI (§17.7.5) — i varco posseduti aggiungono una scorciatoia di
     navigazione per le TUE flotte. Il pathfinding (fleet.js) è una BFS su
     galaxy.systems[].links: aggiungiamo l'arco A↔B IN MEMORIA (la galassia
     si rigenera dal seed ad ogni load → niente persistenza dell'arco; la
     fonte di verità è la proprietà nel save, ri-applicata al boot).
     Idempotente. Travel per-hop → un varco trasforma un viaggio multi-hop
     in un solo hop (risparmio di Ι), preferito automaticamente dalla BFS.
     ------------------------------------------------------------------ */
  function varchiEdges(game) {
    const out = [];
    if (!game || !game.galaxy || !game.phenomena) return out;
    const items = forGalaxy(game.galaxy);
    for (let i = 0; i < items.length; i++) {
      const ph = items[i];
      const st = game.phenomena[ph.id];
      if (st && st.owned && st.varcoTo != null) out.push({ a: ph.nearSys, b: st.varcoTo, id: ph.id });
    }
    return out;
  }
  /* Sincronizza gli archi-varco nei links della galassia: aggiunge quelli
     dei varco posseduti e RIMUOVE quelli non più posseduti (es. varco perso
     per contesa → la scorciatoia si chiude). Traccia solo gli archi creati da
     noi (galaxy._varcoLinks, transitorio) → non tocca mai i link nativi. */
  function applyVarchiLinks(game) {
    if (!game || !game.galaxy) return;
    const galaxy = game.galaxy, sys = galaxy.systems;
    if (!galaxy._varcoLinks) galaxy._varcoLinks = {};
    const tracked = galaxy._varcoLinks;
    const desired = {};
    varchiEdges(game).forEach(function (e) {
      if (e.a == null || e.b == null || e.a === e.b) return;
      desired[e.a + '-' + e.b] = { a: e.a, b: e.b };
      desired[e.b + '-' + e.a] = { a: e.b, b: e.a };
    });
    Object.keys(tracked).forEach(function (key) {
      if (desired[key]) return;
      const e = tracked[key]; delete tracked[key];
      if (sys[e.a] && Array.isArray(sys[e.a].links)) {
        const idx = sys[e.a].links.indexOf(e.b);
        if (idx >= 0) sys[e.a].links.splice(idx, 1);
      }
    });
    Object.keys(desired).forEach(function (key) {
      if (tracked[key]) return;
      const e = desired[key];
      if (!sys[e.a] || !sys[e.b]) return;
      if (!Array.isArray(sys[e.a].links)) sys[e.a].links = [];
      if (sys[e.a].links.indexOf(e.b) < 0) { sys[e.a].links.push(e.b); tracked[key] = e; }
    });
  }

  /* AZIONE 4 — MARCA/EVITA (sempre disponibile da Contatto in poi). */
  function toggleMark(game, id) {
    const st = ensureState(game, id);
    st.marked = !st.marked;
    return { ok: true, marked: st.marked };
  }

  /* ==================================================================
     CAMPO DI PROSSIMITÀ (richiesta utente 2026-06-29) — estende §17.7.4.
     Oltre all'effetto ONE-SHOT dell'investigazione (resolveEffect: hazard
     usura/perdita) e al passivo del nodo POSSEDUTO, ogni FSP proietta un
     debole CAMPO AMBIENTALE PERMANENTE sul suo sistema d'aggancio (nearSys)
     e sui sistemi entro 1 hop. Una flotta che percorre un leg toccando quella
     zona ne risente in CONTINUO finché vi transita:
       - drag → la traversata RALLENTA (malus) o ACCELERA (boon: faro/varco);
       - wear → le navi si USURANO di più (malus) o di meno (boon: riparo).
     Così la presenza del corpo speciale è strategica e perenne (una "zona da
     evitare" — o da cercare) senza serbare il valore alla sola investigazione.

     Tarature (in codice = OPACO by design §20: nessun numero al giocatore):
     leggere e cappate (§17.7.1 "non game-winner"). Si SENTONO ma non affossano
     chi nasce adiacente — caso peggiore (un grav a piena intensità sul tuo
     sistema): leg ~+13%, drip usura ~+30%; su un leg da ~60 Ι ≈ +0.9% wear.
     Tenore di default BILANCIATO: alcune classi danno malus, altre boon.

     Determinismo (#5): tutto STRUTTURALE dal seed (classe/intensità/unicità +
     segno wildcard stabile per istanza). Nessun RNG nel tick (il segno
     temporale è cached sull'istanza immutabile, rigenerata col seed).
     Recovery-friendly (#22): nessun fail-state; non transitare è una scelta,
     e l'effetto è sempre lieve.
     ================================================================== */
  const AMBIENT = {
    /* Coefficienti grezzi per classe a intensità piena, PRIMA dello scaling.
       Due canali confermati (risposta utente 2026-06-29): VIAGGIO + USURA.
       Ogni classe ha però una FIRMA distinta (peso/segno diverso), così
       oggetti diversi si comportano in modo diverso senza esporre i numeri.
         drag>0 = rallenta il viaggio · wear>0 = usura di più gli scafi.
       I boon hanno segno negativo. Allineati ai `tenor` di catalogo (§17.7.3).

       TIPO di effetto diverso per classe (risposta utente 2026-06-29 "classi
       diverse → effetti diversi"): oltre a drag/wear, i GRAVITAZIONALI hanno un
       canale `incident` (>0) = aumentano il rischio di incidente di viaggio
       lungo la rotta ("viaggi deformati", §17.7.3). Le altre classi non ce
       l'hanno (incident assente = 0). È un effetto di ROTTA (non per-leg): vedi
       routeIncident. Recovery-friendly: gli incidenti non sono mai letali. */
    BY_CLASS: {
      grav:  { drag:  0.9, wear:  0.5, incident: 0.9 }, // pozzo di marea: deforma i viaggi (rischio incidente)
      bio:   { drag:  0.2, wear:  0.7 },                 // spore/corrosione: logorio degli scafi
      emis:  { drag: -0.7, wear:  0.4 },                 // pulsar/faro: rotta più spedita, ma radiazioni
      relic: { drag: -0.1, wear: -0.7 },                 // struttura dormiente: acque calme, meno usura
      temp:  { drag:  0.0, wear:  0.0 }                  // wildcard: segno per-istanza (vedi ambientRaw)
    },
    TEMP_MAG: 0.5,         // ampiezza del wildcard temporale (segno dal seed)
    DRAG_PER_FSP: 0.15,    // tetto |Δ| durata leg per singolo FSP a pieno regime
    WEAR_PER_FSP: 0.6,     // tetto |Δ| sul drip di usura per singolo FSP
    INCIDENT_PER_FSP: 0.10,// +prob. incidente per singolo grav a pieno regime
    UNIQUE_MULT: 1.3,      // gli unici pesano un filo di più (sempre cappati)
    DRAG_CAP: 0.20,        // |Δ| max aggregato durata leg (overlap di più FSP)
    WEAR_CAP_UP: 0.8,      // +80% max sul drip di usura (aggregato)
    WEAR_CAP_DOWN: 0.6,    // −60% max sul drip di usura (aggregato)
    INCIDENT_CAP: 0.15,    // +15pp max al rischio incidente dalle zone (aggregato)
    FELT_MIN: 0.04         // soglia |drag|+|wear| sotto cui non si emette il nudge
  };

  /* Contributo ambientale grezzo (segnato) di UN FSP, scalato per intensità e
     unicità. Per la classe temporale i segni sono wildcard ma STABILI per
     istanza (cached sull'oggetto immutabile → nessun RNG ripetuto nel tick). */
  function ambientRaw(ph) {
    const base = AMBIENT.BY_CLASS[ph.cls] || AMBIENT.BY_CLASS.temp;
    let drag = base.drag, wear = base.wear;
    if (ph.cls === 'temp') {
      if (!ph._ambSign) {
        const r = ORION.rng.makeRng(ph.effectSeed + ':ambient');
        ph._ambSign = { d: r.chance(0.5) ? 1 : -1, w: r.chance(0.5) ? 1 : -1 };
      }
      drag = ph._ambSign.d * AMBIENT.TEMP_MAG;
      wear = ph._ambSign.w * AMBIENT.TEMP_MAG;
    }
    const inten = ph.intensity != null ? ph.intensity : 0.5;
    const um = ph.unique ? AMBIENT.UNIQUE_MULT : 1;
    return {
      drag: drag * inten * um * AMBIENT.DRAG_PER_FSP,
      wear: wear * inten * um * AMBIENT.WEAR_PER_FSP,
      incident: (base.incident || 0) * inten * um * AMBIENT.INCIDENT_PER_FSP
    };
  }

  /* sysId è entro 1 hop dal sistema d'aggangio `nearSys`? (cioè nearSys
     stesso o un suo vicino diretto sui link di galassia). */
  function within1Hop(galaxy, sysId, nearSys) {
    if (sysId == null || nearSys == null) return false;
    if (sysId === nearSys) return true;
    const s = galaxy.systems && galaxy.systems[nearSys];
    return !!(s && Array.isArray(s.links) && s.links.indexOf(sysId) >= 0);
  }
  /* Il leg from→to attraversa la zona dell'FSP (una delle due estremità è
     entro 1 hop dal nearSys)? */
  function legTouchesZone(galaxy, fromSys, toSys, nearSys) {
    return within1Hop(galaxy, fromSys, nearSys) || within1Hop(galaxy, toSys, nearSys);
  }

  /* Campo ambientale combinato sul leg from→to: somma i contributi di tutti
     gli FSP la cui zona lo tocca, poi CAPPA l'aggregato. Puramente strutturale
     (galaxy + lista immutabile): non legge lo stato di scoperta, così l'effetto
     è perenne e "si impara giocando" (§17.7.1). Ritorna i moltiplicatori per
     durata leg e drip di usura + gli id degli FSP coinvolti (per il nudge). */
  function legField(galaxy, fromSys, toSys) {
    const out = { dragMul: 1, wearMul: 1, drag: 0, wear: 0, ids: [] };
    if (!galaxy || !galaxy.systems) return out;
    const items = forGalaxy(galaxy);
    let sumDrag = 0, sumWear = 0;
    for (let i = 0; i < items.length; i++) {
      const ph = items[i];
      if (!legTouchesZone(galaxy, fromSys, toSys, ph.nearSys)) continue;
      const raw = ambientRaw(ph);
      sumDrag += raw.drag;
      sumWear += raw.wear;
      out.ids.push(ph.id);
    }
    if (!out.ids.length) return out;
    sumDrag = clamp(sumDrag, -AMBIENT.DRAG_CAP, AMBIENT.DRAG_CAP);
    sumWear = clamp(sumWear, -AMBIENT.WEAR_CAP_DOWN, AMBIENT.WEAR_CAP_UP);
    out.drag = sumDrag; out.wear = sumWear;
    out.dragMul = 1 + sumDrag;
    out.wearMul = 1 + sumWear;
    return out;
  }

  /* Delta additivo al RISCHIO INCIDENTE di viaggio dell'INTERA rotta (richiesta
     utente 2026-06-29): i Fenomeni gravitazionali lungo il cammino deformano i
     viaggi. Aggregato per ROTTA — un FSP conta UNA volta anche se più leg
     toccano la sua zona — poi cappato a INCIDENT_CAP. Solo la classe grav ha
     incident>0; le altre non contribuiscono. Strutturale/deterministico. */
  function routeIncident(galaxy, route) {
    if (!galaxy || !galaxy.systems || !Array.isArray(route) || route.length < 2) return 0;
    const items = forGalaxy(galaxy);
    let sum = 0;
    for (let i = 0; i < items.length; i++) {
      const ph = items[i];
      const inc = ambientRaw(ph).incident;
      if (!inc) continue;
      let touched = false;
      for (let k = 1; k < route.length && !touched; k++) {
        if (legTouchesZone(galaxy, route[k - 1], route[k], ph.nearSys)) touched = true;
      }
      if (touched) sum += inc;
    }
    return clamp(sum, 0, AMBIENT.INCIDENT_CAP);
  }

  /* Nudge "si impara giocando": quando una flotta del giocatore transita per
     la prima volta in un campo ambientale NON ancora classificato e l'effetto
     è percepibile, emette UNA voce di Cronaca opaca (niente numeri) e marca
     l'istanza come `_felt` (delta additivo, idempotente, persistito). Spinge
     a scansionare/investigare l'FSP per capirne la natura. */
  function noteAmbientFelt(game, fleet, fromSys, toSys, events) {
    if (!game || !game.galaxy || !events || !fleet) return;
    const f = legField(game.galaxy, fromSys, toSys);
    if (!f.ids.length) return;
    if (Math.abs(f.drag) + Math.abs(f.wear) < AMBIENT.FELT_MIN) return;
    for (let i = 0; i < f.ids.length; i++) {
      const id = f.ids[i];
      const st = ensureState(game, id);
      if ((st.d || 0) >= DISCOVERY.CLASSIFICATO || st._felt) continue;
      st._felt = true;
      const ph = byId(game.galaxy, id);
      const sys = ph && game.galaxy.systems[ph.nearSys];
      events.push({ kind: 'fsp-ambient', id: id, fleetId: fleet.id, fleetName: fleet.name,
        sysId: ph ? ph.nearSys : null, sysName: sys ? sys.name : '—',
        impulso: game.timeImpulsi || 0 });
    }
  }

  /* ------------------------------------------------------------------
     TICK — scoperta di prossimità + passivo dei nodi posseduti.
     ------------------------------------------------------------------ */
  function tick(game, events) {
    if (!game || !game.galaxy) return;
    ensure(game);
    detect(game, events);
    const items = forGalaxy(game.galaxy);
    const now = game.timeImpulsi || 0;
    let icgDrip = 0, dripSources = 0;
    for (let i = 0; i < items.length; i++) {
      const ph = items[i];
      const st = game.phenomena[ph.id];
      if (!st) continue;
      const disc = st.d || 0;

      /* Pressione ICG: hazard classificati ma non gestiti (non investigati/
         neutralizzati, non marcati come da evitare). Marcarli o risolverli
         ferma la pressione → il verbo "Evita" è contenimento concreto. */
      if (disc >= DISCOVERY.CLASSIFICATO && ph.tenor < 0 && !st.marked && !st.used && !st.owned) {
        if (dripSources < FX.ICG_DRIP_MAX_SOURCES) { icgDrip += FX.ICG_HAZARD_DRIP; dripSources++; }
      }

      if (!st.owned || !st.outcome) continue;
      const presidio = playerFleetAtSystem(game, ph.nearSys);

      /* Passivo: nodi cache/unici posseduti e PRESIDIATI → trickle capato. */
      if ((st.outcome.category === 'cache' || st.outcome.category === 'unique') &&
          (st.passiveTotal || 0) < FX.PASSIVE_CAP && presidio) {
        const rate = FX.PASSIVE_RATE_MIN + (ph.intensity || 0.5) * FX.PASSIVE_RATE_SPAN;
        const take = Math.min(rate, FX.PASSIVE_CAP - (st.passiveTotal || 0));
        if (deposit(game, st.outcome.res || 'met', take)) st.passiveTotal = (st.passiveTotal || 0) + take;
      }

      /* Contendibilità: se presidiato, sei al sicuro; altrimenti il contatore
         "indifeso" sale e, oltre la grazia, un roll periodico deterministico
         può far sottrarre il nodo a una fazione AI (Vehryn/pirati/Mekhari). */
      if (presidio) { st.undef = 0; continue; }
      st.undef = (st.undef || 0) + 1;
      if (st.undef < FX.CONTEST_GRACE) continue;
      const bucket = Math.floor(now / FX.CONTEST_PERIOD);
      if (st._contestBucket === bucket) continue;
      st._contestBucket = bucket;
      const rng = ORION.rng.makeRng(ph.effectSeed + ':contest:' + bucket);
      const sys = game.galaxy.systems[ph.nearSys];
      const danger = (sys && sys.danger) || 0;
      const p = Math.min(0.6, FX.CONTEST_P_BASE * (0.5 + danger / 100 + (game.icg || 20) / 200));
      if (rng.chance(p)) {
        st.owned = false; st.undef = 0;
        st.aiFaction = contestFaction(ph, rng);
        // il varco perde l'attivazione (resta rivelato/ri-rivendicabile)
        if (events) events.push({ kind: 'fsp-lost', id: ph.id, sysId: ph.nearSys,
          sysName: sys ? sys.name : '—', name: ph.name, faction: st.aiFaction, impulso: now });
      }
    }
    if (icgDrip > 0) {
      game.icg = Math.max(0, Math.min(100, (typeof game.icg === 'number' ? game.icg : 20) + icgDrip));
    }
  }

  ORION.phenomena = {
    DISCOVERY: DISCOVERY,
    CLASSES: CLASSES,
    CLASS_ORDER: CLASS_ORDER,
    PROFILES: PROFILES,
    CFG: CFG,
    FX: FX,
    profileFor: profileFor,
    generate: generate,
    forGalaxy: forGalaxy,
    ensure: ensure,
    stateOf: stateOf,
    list: list,
    byId: byId,
    detect: detect,
    tick: tick,
    descriptorFor: descriptorFor,
    tenorHint: tenorHint,
    canScan: canScan, scan: scan,
    canInvestigate: canInvestigate, investigate: investigate,
    canExploit: canExploit, exploit: exploit,
    toggleMark: toggleMark,
    AMBIENT: AMBIENT,
    legField: legField,
    routeIncident: routeIncident,
    within1Hop: within1Hop,
    noteAmbientFelt: noteAmbientFelt,
    varchiEdges: varchiEdges,
    applyVarchiLinks: applyVarchiLinks,
    playerFleetAtSystem: playerFleetAtSystem,
    colonyInSystem: colonyInSystem
  };
})(typeof window !== 'undefined' ? window : this);
