/* =====================================================================
   colony-figure.js — Figure di colonia (M14 Fase B1, decisione #77)

   Chiude i ganci #40 (Governatore di sector, Tier 3) e #41 (Ingegnere
   capo). Parallelo alle figure di flotta (commander.js #75) ma sul lato
   colonia: una figura A LIVELLO IMPERO assegnabile a UNA colonia.

   EMERGENZA da maturità (non si comprano): una colonia operativa accumula
   `colony.adminXp`; a soglia emerge UNA figura. Il RUOLO riflette il
   carattere della colonia (leva di agency, parallelo a #75):
     - colonia con Governatore attivo (#59) → Governatore di sector
       (l'amministrazione è maturata in leadership)
     - altrimenti → Ingegnere capo (maturità industriale)

   Due RUOLI:
     - governatore (di sector): AMPLIFICA il Governatore #59 — cooldown
       ridotto, sblocco anche con <3 colonie, Tier 3-light (auto-rimpiazzo
       di un esploratore perso).
     - ingegnere-capo: −tempo di assemblaggio scafi/equipaggi (estende il
       bonus tecnici #41).

   RANGHI civici (xp individuale, cresce servendo): Funzionario → Prefetto
   → Console, scalano la magnitudo dei bonus.
   TRATTO leggero (modificatori veri). RAZZA §18 narrativa (come #75).

   Determinismo (#5): RNG `seed:colfig:<colonyKey>:<n>`. Recovery-friendly
   (#22): nessun fail-state; le figure non si perdono.
   Single source of truth: figura in `game.colonyFigures[]` (idle) O su
   `colony.figure` (assegnata). Schema save 25.
   ===================================================================== */
(function (root) {
  'use strict';

  var ADMIN_RATE = 0.03;       // adminXp per Ι su colonia operativa (~4000 Ι/figura)
  var ADMIN_THRESHOLD = 120;   // soglia di emergenza
  var SERVICE_PER_XP = 100;    // Ι di servizio sano per +1 xp individuale

  var RANKS = [
    { id: 'funzionario', label: 'Funzionario', min: 0 },
    { id: 'prefetto',    label: 'Prefetto',    min: 20 },
    { id: 'console',     label: 'Console',     min: 50 }
  ];

  var ROLES = {
    governatore:    { id: 'governatore',    label: 'Governatore di sector', glyph: '⬡', hint: 'Amplifica il Governatore: deleghe più rapide, autonomia estesa' },
    'ingegnere-capo': { id: 'ingegnere-capo', label: 'Ingegnere capo',        glyph: '⚙', hint: 'Velocizza l\'assemblaggio di scafi ed equipaggi' }
  };

  var NAME_POOL = [
    'Aldric', 'Bree', 'Corvin', 'Delia', 'Esra', 'Fenn',
    'Galea', 'Hadi', 'Ilse', 'Joren', 'Kane', 'Lena',
    'Maro', 'Nadia', 'Osric', 'Petra', 'Quen', 'Riva',
    'Sten', 'Tamsin', 'Ulric', 'Vera', 'Wen', 'Yara',
    'Zara', 'Bastian', 'Cleo', 'Doran', 'Elin', 'Ferro'
  ];

  /* Tratti civici con modificatori veri (additivi, piccoli). */
  var TRAIT_POOL = [
    { id: 'meticoloso',  label: 'Meticoloso',  mod: { assembly: 0.04 } },
    { id: 'autorevole',  label: 'Autorevole',  mod: { cooldown: 0.06 } },
    { id: 'pragmatico',  label: 'Pragmatico',  mod: { assembly: 0.02, cooldown: 0.03 } },
    { id: 'integerrimo', label: 'Integerrimo', mod: {} },
    { id: 'visionario',  label: 'Visionario',  mod: {} },
    { id: 'instancabile',label: 'Instancabile',mod: { assembly: 0.03 } }
  ];

  /* Archetipi §18 — narrativi (come #75). */
  var RACE_POOL = [
    { id: 'umani',   label: 'Umani',            weight: 6 },
    { id: 'kelhari', label: 'Kelhari',          weight: 3 },
    { id: 'vorn',    label: 'Vorn',             weight: 4 },
    { id: 'syndari', label: 'Syndari',          weight: 2 },
    { id: 'mekhari', label: 'Mekhari',          weight: 2 },
    { id: 'anziani', label: 'Anziani del Vuoto', weight: 1 }
  ];

  function pickFromPool(rng, pool) {
    var idx = Math.floor(rng.float() * pool.length);
    if (idx >= pool.length) idx = pool.length - 1;
    return pool[idx];
  }
  function pickWeighted(rng, pool) {
    var total = 0, i;
    for (i = 0; i < pool.length; i++) total += pool[i].weight || 1;
    var x = rng.float() * total;
    for (i = 0; i < pool.length; i++) { x -= pool[i].weight || 1; if (x <= 0) return pool[i]; }
    return pool[pool.length - 1];
  }
  function rankIndexForXp(xp) {
    xp = xp | 0;
    var idx = 0;
    for (var i = 0; i < RANKS.length; i++) if (xp >= RANKS[i].min) idx = i;
    return idx;
  }
  function rankFor(xp) { return RANKS[rankIndexForXp(xp)]; }
  function rankLabel(fig) { return rankFor((fig && fig.xp) || 0).label; }
  function roleLabel(fig) { var r = fig && ROLES[fig.role]; return r ? r.label : 'Funzionario'; }
  function traitMod(id) {
    for (var i = 0; i < TRAIT_POOL.length; i++) if (TRAIT_POOL[i].id === id) return TRAIT_POOL[i].mod || {};
    return {};
  }

  function ensure(game) {
    if (!game) return;
    if (!Array.isArray(game.colonyFigures)) game.colonyFigures = [];
  }

  /* Bundle bonus (ruolo + rango + tratto). */
  function bonuses(fig) {
    var b = { cooldownMul: 1, assemblyMul: 1, tier3: false, subThreshold: false };
    if (!fig) return b;
    var r = rankIndexForXp(fig.xp || 0);   // 0..2
    var t = traitMod(fig.trait);
    if (fig.role === 'governatore') {
      b.cooldownMul = 1 - (0.15 + 0.10 * r) - (t.cooldown || 0);   // 0.85 → 0.65 (+tratto)
      b.tier3 = true;
      b.subThreshold = true;
    } else if (fig.role === 'ingegnere-capo') {
      b.assemblyMul = 1 - (0.10 + 0.05 * r) - (t.assembly || 0);   // 0.90 → 0.80 (+tratto)
    }
    b.cooldownMul = Math.max(0.5, b.cooldownMul);
    b.assemblyMul = Math.max(0.55, b.assemblyMul);
    return b;
  }

  /* Genera una figura per una colonia + ruolo. RNG deterministico dal
     conteggio nascite di quella colonia. */
  function make(game, colonyKey, role, n) {
    var seed = (game && game.seed) || '';
    var rng = ORION.rng.makeRng(seed + ':colfig:' + colonyKey + ':' + (n | 0));
    var name = pickFromPool(rng, NAME_POOL);
    var trait = pickFromPool(rng, TRAIT_POOL);
    var race = pickWeighted(rng, RACE_POOL);
    if (!ROLES[role]) role = 'ingegnere-capo';
    return {
      id: 'colfig-' + (game.timeImpulsi || 0) + '-' + colonyKey + '-' + (n | 0),
      name: name,
      role: role,
      roleLabel: ROLES[role].label,
      rank: RANKS[0].label,
      xp: 0,
      trait: trait.id,
      traitLabel: trait.label,
      race: race.id,
      raceLabel: race.label,
      originColonyKey: colonyKey,
      status: 'idle',
      bornAt: game.timeImpulsi || 0
    };
  }

  /* Emergenza: chiamata dal tick per ogni colonia operativa. Accumula
     adminXp; a soglia fa emergere UNA figura nel pool d'Impero. Il ruolo
     riflette se la colonia ha un Governatore attivo (#59). */
  function maybeEmerge(game, colony, colonyKey, events) {
    if (!game || !colony) return;
    if (colony.phase && colony.phase !== 'operational') return;   // niente in Insediamento
    ensure(game);
    colony.adminXp = (colony.adminXp || 0) + ADMIN_RATE;
    if (colony.adminXp < ADMIN_THRESHOLD) return;
    colony.adminXp = 0;
    var n = (colony.figuresBorn || 0);
    colony.figuresBorn = n + 1;
    var govActive = !!(colony.governor && colony.governor.level && colony.governor.level !== 'off');
    var role = govActive ? 'governatore' : 'ingegnere-capo';
    var fig = make(game, colonyKey, role, n);
    game.colonyFigures.push(fig);
    if (events) events.push({ kind: 'colony-figure-emerged', figure: fig, colonyKey: colonyKey, impulso: game.timeImpulsi });
    return fig;
  }

  /* Esperienza individuale della figura assegnata (cresce in servizio sano).
     Accumula su un contatore Ι e converte a +1 xp ogni SERVICE_PER_XP. */
  function serveTick(game, colony, events) {
    var fig = colony && colony.figure;
    if (!fig) return;
    fig._serviceI = (fig._serviceI || 0) + 1;
    if (fig._serviceI < SERVICE_PER_XP) return;
    fig._serviceI = 0;
    grantXp(game, fig, 1, events);
  }
  function grantXp(game, fig, amount, events) {
    if (!fig || !(amount > 0)) return;
    var before = rankIndexForXp(fig.xp || 0);
    fig.xp = (fig.xp || 0) + amount;
    var after = rankIndexForXp(fig.xp);
    fig.rank = RANKS[after].label;
    if (after > before && events) {
      events.push({ kind: 'colony-figure-ranked', figure: fig, rank: RANKS[after].label, impulso: game && game.timeImpulsi });
    }
  }

  function list(game) { return (game && Array.isArray(game.colonyFigures)) ? game.colonyFigures : []; }
  function allOf(game) {
    var out = list(game).slice();
    var cols = (game && game.colonies) || {};
    Object.keys(cols).forEach(function (k) { if (cols[k] && cols[k].figure) out.push(cols[k].figure); });
    return out;
  }
  function assignableOf(game) {
    return list(game).filter(function (f) { return f.status !== 'assigned'; });
  }

  /* Assegna una figura idle a una colonia (single slot). Se la colonia ne
     ha già una, prima la rilascia. */
  function assignToColony(game, colony, colonyKey, figureId) {
    if (!game || !colony) return { ok: false, reason: 'Dati mancanti' };
    if (colony.figure && colony.figure.id === figureId) return { ok: true, figure: colony.figure };
    var pool = list(game);
    var idx = -1;
    for (var i = 0; i < pool.length; i++) { if (pool[i].id === figureId && pool[i].status !== 'assigned') { idx = i; break; } }
    if (idx < 0) return { ok: false, reason: 'Figura non disponibile' };
    var found = pool[idx];
    if (colony.figure) releaseFromColony(game, colony);
    pool.splice(idx, 1);
    found.status = 'assigned';
    found.assignedColonyKey = colonyKey;
    colony.figure = found;
    return { ok: true, figure: found };
  }
  function releaseFromColony(game, colony) {
    if (!colony || !colony.figure) return null;
    var fig = colony.figure;
    ensure(game);
    fig.status = 'idle';
    delete fig.assignedColonyKey;
    delete fig._serviceI;
    game.colonyFigures.push(fig);
    colony.figure = null;
    return fig;
  }

  /* Helper letti dai consumer. */
  function governanceBonus(colony) {
    var fig = colony && colony.figure;
    if (fig && fig.role === 'governatore') return bonuses(fig);
    return { cooldownMul: 1, assemblyMul: 1, tier3: false, subThreshold: false };
  }
  /* Moltiplicatore tempo di assemblaggio dalla figura (Ingegnere capo). */
  function assemblyMul(colony) {
    var fig = colony && colony.figure;
    if (fig && fig.role === 'ingegnere-capo') return bonuses(fig).assemblyMul;
    return 1;
  }
  /* La colonia ha un Governatore di sector assegnato? (sblocco/cooldown #59) */
  function hasGovernatore(colony) {
    var fig = colony && colony.figure;
    return !!(fig && fig.role === 'governatore');
  }

  function bonusLabel(fig) {
    if (!fig) return '';
    var b = bonuses(fig), parts = [];
    if (b.cooldownMul < 0.999) parts.push('−' + Math.round((1 - b.cooldownMul) * 100) + '% attesa deleghe');
    if (b.assemblyMul < 0.999) parts.push('−' + Math.round((1 - b.assemblyMul) * 100) + '% assemblaggio');
    if (b.tier3) parts.push('autonomia estesa');
    return parts.join(' · ');
  }

  /* Ricambio automatico (decisione #79): le figure di colonia hanno un
     mandato lungo; superato, vanno in congedo da sole (notifica). La
     pipeline (adminXp) genera i successori. */
  var CF_TENURE_BASE = 8000, CF_TENURE_SPREAD = 4000;
  function cfHash(s) {
    var h = 2166136261; s = '' + s;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
    return h >>> 0;
  }
  function cfTenure(id) { return CF_TENURE_BASE + (cfHash(id) % (CF_TENURE_SPREAD + 1)); }
  function retireOld(game, events) {
    if (!game) return;
    ensure(game);
    var now = game.timeImpulsi || 0;
    function expired(f) { return (now - (f.bornAt || 0)) >= cfTenure(f.id); }
    function notify(f) {
      if (events) events.push({ kind: 'figure-retired', scope: 'colony', name: (f.rank || '') + ' ' + f.name, roleLabel: roleLabel(f), impulso: now });
    }
    /* assegnate (su colony.figure) */
    var cols = game.colonies || {};
    Object.keys(cols).forEach(function (k) {
      var f = cols[k] && cols[k].figure;
      if (f && expired(f)) { cols[k].figure = null; notify(f); }
    });
    /* idle nel pool */
    var pool = list(game);
    for (var j = pool.length - 1; j >= 0; j--) {
      if (expired(pool[j])) { var fig = pool.splice(j, 1)[0]; notify(fig); }
    }
  }

  root.ORION = root.ORION || {};
  root.ORION.colonyFigure = {
    ADMIN_THRESHOLD: ADMIN_THRESHOLD,
    RANKS: RANKS,
    ROLES: ROLES,
    NAME_POOL: NAME_POOL,
    TRAIT_POOL: TRAIT_POOL,
    RACE_POOL: RACE_POOL,
    ensure: ensure,
    make: make,
    maybeEmerge: maybeEmerge,
    serveTick: serveTick,
    grantXp: grantXp,
    bonuses: bonuses,
    rankFor: rankFor,
    rankLabel: rankLabel,
    roleLabel: roleLabel,
    list: list,
    allOf: allOf,
    assignableOf: assignableOf,
    assignToColony: assignToColony,
    releaseFromColony: releaseFromColony,
    governanceBonus: governanceBonus,
    assemblyMul: assemblyMul,
    hasGovernatore: hasGovernatore,
    bonusLabel: bonusLabel,
    retireOld: retireOld
  };
}(typeof window !== 'undefined' ? window : this));
