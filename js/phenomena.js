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
    if (game.galaxy) forGalaxy(game.galaxy);
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
        intensity: ph.intensity,
        disc: st.d || DISCOVERY.ECO,
        owned: !!st.owned, used: !!st.used, marked: !!st.marked
      };
    });
  }

  ORION.phenomena = {
    DISCOVERY: DISCOVERY,
    CLASSES: CLASSES,
    CLASS_ORDER: CLASS_ORDER,
    PROFILES: PROFILES,
    CFG: CFG,
    profileFor: profileFor,
    generate: generate,
    forGalaxy: forGalaxy,
    ensure: ensure,
    stateOf: stateOf,
    list: list
  };
})(typeof window !== 'undefined' ? window : this);
