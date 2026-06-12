/* =====================================================================
   commander.js — Figure di flotta (decisione #43 → M14 Fase A, decisione #75)

   "Emergenza dal basso" (GDD §12.4): le figure NON si creano, EMERGONO
   dall'equipaggio che raggiunge il grado massimo (xp ≥ 10, decisione #71)
   per servizio vario — combattimenti, rotte lunghe, pattuglie, esplorazioni
   (decisione utente 2026-06-11). L'esperienza dello staff veterano "esce"
   col la figura e viene aggregata in essa; il crew si riforma (xp a 0).

   M14 Fase A (decisione #75): tre RUOLI §12.4 al posto della singola
   "specializzazione" #43, scelti dall'ATTIVITÀ dominante del crew:
     - combattimenti  → Comandante  (potenza di fuoco, condotta in battaglia)
     - viaggi/manutenzione → Ingegnere di Flotta (viaggio, viveri, scafo)
     - pattuglie/ricognizioni → Stratega (imboscate, tattica)
   Così un impero pacifico/esploratore genera Ingegneri e Strateghi, uno
   militarizzato genera Comandanti — senza alcun cancello "prima la guerra".

   Ogni figura ha:
     - role   : i 3 tipi §12.4 (determina il profilo di bonus)
     - rank   : progressione individuale dall'xp (Tenente → Capitano →
                Commodoro → Ammiraglio) che SCALA la magnitudo dei bonus
     - trait  : tratto con MODIFICATORI VERI (non più solo etichetta)
     - race   : archetipo §18 (Umani/Kelhari/Vorn/Syndari/Mekhari/Anziani),
                per ora NARRATIVO (flavor); i bias-razza arrivano in Fase B
     - xp     : esperienza individuale, cresce servendo su una flotta

   Migrazione legacy: la vecchia `specialization` (#43) → role
   (tattico→comandante, navigatore/logista→ingegnere; logista lascia il
   tratto "Logistico"). Schema save 24 (v23→v24).

   Determinismo (#5): RNG derivato da `seed:commander:<crewId>`.
   Persistenza (decisione utente 2026-06-11): figure A LIVELLO IMPERO.
   Pool idle in `game.commanders[]`; quelle al comando vivono su
   `fleet.commander` (single source of truth).
   ===================================================================== */
(function (root) {
  'use strict';

  /* Soglia di promozione: xp ≥ 10 = grado 'Leggende' (scala equipaggio,
     coerente con expedition.enrichmentForXp / decisione #71). */
  var PROMOTION_THRESHOLD = 10;

  /* Ranghi — progressione individuale, scalano la magnitudo dei bonus.
     Niente "Comandante" qui per non confonderlo col ruolo (#34 lessico).
     Una figura nasce dallo staff a xp 10 → Tenente, poi cresce in servizio. */
  var RANKS = [
    { id: 'tenente',    label: 'Tenente',    min: 0 },
    { id: 'capitano',   label: 'Capitano',   min: 18 },
    { id: 'commodoro',  label: 'Commodoro',  min: 40 },
    { id: 'ammiraglio', label: 'Ammiraglio', min: 75 }
  ];

  /* I tre RUOLI §12.4 (il primo asse, determina il profilo di bonus). */
  var ROLES = {
    comandante: { id: 'comandante', label: 'Comandante',          glyph: '★', hint: 'Morale, potenza di fuoco, condotta in battaglia' },
    ingegnere:  { id: 'ingegnere',  label: 'Ingegnere di Flotta', glyph: '⚙', hint: 'Consumi di viaggio, viveri, resistenza dello scafo' },
    stratega:   { id: 'stratega',   label: 'Stratega',            glyph: '◈', hint: 'Imboscate, tattica, difesa perimetrale' }
  };
  var ROLE_ORDER = ['comandante', 'ingegnere', 'stratega'];

  /* Pool nomi propri — neutri / sci-fi, evitando marchi (#34). */
  var NAME_POOL = [
    'Vance', 'Kade', 'Theron', 'Lyra', 'Rhea', 'Cassian',
    'Mira', 'Dax', 'Selene', 'Orin', 'Talia', 'Renn',
    'Soren', 'Kira', 'Halen', 'Nyx', 'Ardan', 'Vael',
    'Calix', 'Iona', 'Drev', 'Saskia', 'Korin', 'Eva',
    'Talos', 'Maren', 'Briar', 'Quill', 'Ondra', 'Sahir',
    'Vesper', 'Roan', 'Kessa', 'Idris', 'Nima', 'Caelen',
    'Ostara', 'Jarek', 'Liora', 'Tarek'
  ];

  /* Tratti con MODIFICATORI VERI (M14 Fase A). I campi di `mod` sono bonus
     ADDITIVI applicati in bonuses(): fpMul/hpMul/firstStrike si sommano al
     moltiplicatore; travelMul/viveriMul RIDUCONO ulteriormente il fattore
     (viaggio più corto / viveri più lenti). Magnitudo piccola: il ruolo +
     rango restano il driver principale, il tratto colora. */
  var TRAIT_POOL = [
    { id: 'audace',      label: 'Audace',      mod: { fpMul: 0.03, firstStrike: 0.02 } },
    { id: 'prudente',    label: 'Prudente',    mod: { hpMul: 0.04 } },
    { id: 'risoluto',    label: 'Risoluto',    mod: { fpMul: 0.02 } },
    { id: 'carismatico', label: 'Carismatico', mod: { fpMul: 0.02, hpMul: 0.02 } },
    { id: 'tenace',      label: 'Tenace',      mod: { hpMul: 0.05 } },
    { id: 'astuto',      label: 'Astuto',      mod: { firstStrike: 0.04 } },
    { id: 'lucido',      label: 'Lucido',      mod: { firstStrike: 0.03 } },
    { id: 'logistico',   label: 'Logistico',   mod: { travelMul: 0.04, viveriMul: 0.06 } },
    { id: 'stoico',      label: 'Stoico',      mod: { hpMul: 0.03 } },
    { id: 'implacabile', label: 'Implacabile', mod: { fpMul: 0.04 } }
  ];

  /* Archetipi §18 — per ora NARRATIVI (flavor): nessun modificatore.
     I bias-razza (Kelhari +fuoco caccia, Vorn +riparazione, ...) arrivano
     in Fase B. Pesi: Umani comuni, Anziani del Vuoto rarissimi. */
  var RACE_POOL = [
    { id: 'umani',   label: 'Umani',            weight: 6 },
    { id: 'kelhari', label: 'Kelhari',          weight: 4 },
    { id: 'vorn',    label: 'Vorn',             weight: 3 },
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
    for (i = 0; i < pool.length; i++) {
      x -= pool[i].weight || 1;
      if (x <= 0) return pool[i];
    }
    return pool[pool.length - 1];
  }

  /* ---------------------------------------------------------------
     Rango (dall'xp individuale) + bonus per ruolo/rango/tratto.
     --------------------------------------------------------------- */
  function rankIndexForXp(xp) {
    xp = xp | 0;
    var idx = 0;
    for (var i = 0; i < RANKS.length; i++) if (xp >= RANKS[i].min) idx = i;
    return idx;
  }
  function rankFor(xp) { return RANKS[rankIndexForXp(xp)]; }
  function rankLabel(cmd) { return rankFor((cmd && cmd.xp) || 0).label; }
  function roleLabel(cmd) {
    var r = cmd && ROLES[cmd.role];
    return r ? r.label : 'Comandante';
  }
  function traitMod(id) {
    for (var i = 0; i < TRAIT_POOL.length; i++) if (TRAIT_POOL[i].id === id) return TRAIT_POOL[i].mod || {};
    return {};
  }

  /* Bundle di bonus della figura (ruolo + rango + tratto). Driver di tutti
     gli effetti veri letti dai consumer (combat.js / fleet.js). */
  function bonuses(cmd) {
    var b = { fpMul: 1, hpMul: 1, firstStrike: 0, travelMul: 1, viveriMul: 1 };
    if (!cmd) return b;
    var r = rankIndexForXp(cmd.xp || 0);   // 0..3
    if (cmd.role === 'comandante') {
      b.fpMul = 1 + 0.08 + 0.04 * r;        // +8% (Tenente) → +20% (Ammiraglio)
    } else if (cmd.role === 'stratega') {
      b.firstStrike = 0.06 + 0.03 * r;      // imboscata 6% → 15%
      b.fpMul = 1 + 0.02 + 0.01 * r;        // leggera spinta di fuoco
    } else if (cmd.role === 'ingegnere') {
      b.hpMul = 1 + 0.05 + 0.03 * r;        // scafo +5% → +14%
      b.travelMul = 1 - (0.10 + 0.03 * r);  // viaggio −10% → −19%
      b.viveriMul = 1 - (0.10 + 0.03 * r);  // viveri consumati più lenti
    }
    var t = traitMod(cmd.trait);
    if (t.fpMul) b.fpMul += t.fpMul;
    if (t.hpMul) b.hpMul += t.hpMul;
    if (t.firstStrike) b.firstStrike += t.firstStrike;
    if (t.travelMul) b.travelMul -= t.travelMul;   // ulteriore sconto viaggio
    if (t.viveriMul) b.viveriMul -= t.viveriMul;   // ulteriore risparmio viveri
    /* clamp di sicurezza */
    b.travelMul = Math.max(0.5, b.travelMul);
    b.viveriMul = Math.max(0.4, b.viveriMul);
    b.firstStrike = Math.min(0.30, b.firstStrike);
    return b;
  }

  /* ---------------------------------------------------------------
     Emergenza: il ruolo deriva dall'ATTIVITÀ dominante del crew.
     --------------------------------------------------------------- */
  function dominantRole(crewEntry) {
    var svc = crewEntry && crewEntry.svc;
    if (!svc) return 'comandante';
    var c = svc.combat || 0, t = svc.travel || 0, k = svc.tactical || 0;
    if (c >= t && c >= k) return 'comandante';   // ha combattuto di più
    if (t >= k) return 'ingegnere';              // ha viaggiato di più
    return 'stratega';                           // ha pattugliato/esplorato vario
  }

  /* Accumula servizio sul crew (kind ∈ combat|travel|tactical). Lazy. */
  function bumpCrewSvc(crewEntry, kind, amount) {
    if (!crewEntry || !(amount > 0)) return;
    if (kind !== 'combat' && kind !== 'travel' && kind !== 'tactical') return;
    if (!crewEntry.svc) crewEntry.svc = { combat: 0, travel: 0, tactical: 0 };
    crewEntry.svc[kind] = (crewEntry.svc[kind] || 0) + amount;
  }

  /* Genera una figura a partire da un crewId + ruolo. */
  function make(game, crewId, inheritedXp, originColonyKey, role) {
    var seed = (game && game.seed) || '';
    var rng = ORION.rng.makeRng(seed + ':commander:' + crewId);
    var name = pickFromPool(rng, NAME_POOL);
    var trait = pickFromPool(rng, TRAIT_POOL);
    var race = pickWeighted(rng, RACE_POOL);
    if (!ROLES[role]) role = 'comandante';
    var xp = inheritedXp | 0;
    return {
      id: 'cmd-' + (game.timeImpulsi || 0) + '-' + crewId,
      name: name,
      role: role,
      roleLabel: ROLES[role].label,
      rank: rankFor(xp).label,
      xp: xp,
      trait: trait.id,
      traitLabel: trait.label,
      race: race.id,
      raceLabel: race.label,
      originColonyKey: originColonyKey,
      originCrewId: crewId,
      status: 'idle',
      bornAt: game.timeImpulsi || 0
    };
  }

  /* Promozione: figura A LIVELLO IMPERO (game.commanders[]). Il ruolo viene
     dall'attività dominante del crew, salvo `roleHint` esplicito (es. le
     spedizioni passano 'ingegnere' = viaggio). Emerge SEMPRE (anche in
     esilio). Reset di xp E servizio del crew (l'entità non si brucia). */
  function promote(game, crewEntry, inheritedXp, originColonyKey, roleHint) {
    if (!game || !crewEntry) return null;
    if (!Array.isArray(game.commanders)) game.commanders = [];
    var role = (roleHint && ROLES[roleHint]) ? roleHint : dominantRole(crewEntry);
    var cmd = make(game, crewEntry.id, inheritedXp, originColonyKey, role);
    game.commanders.push(cmd);
    crewEntry.xp = 0;
    crewEntry.svc = { combat: 0, travel: 0, tactical: 0 };
    return cmd;
  }

  function isPromotable(newXp) { return (newXp | 0) >= PROMOTION_THRESHOLD; }

  /* Esperienza individuale della figura (cresce in servizio su una flotta).
     Può far salire di rango → evento `commander-ranked`. */
  function grantXp(game, cmd, amount, events) {
    if (!cmd || !(amount > 0)) return;
    var before = rankIndexForXp(cmd.xp || 0);
    cmd.xp = (cmd.xp || 0) + amount;
    var after = rankIndexForXp(cmd.xp);
    cmd.rank = RANKS[after].label;
    if (after > before && events) {
      events.push({
        kind: 'commander-ranked', commander: cmd,
        rank: RANKS[after].label, impulso: game && game.timeImpulsi
      });
    }
  }

  function list(game) {
    return (game && Array.isArray(game.commanders)) ? game.commanders : [];
  }
  /* M15 — accessor canonico delle figure assegnate a una flotta. Il modello
     M14 usava lo slot singolo `fleet.commander`; M15 ospita più figure sulle
     navi capitali → `fleet.officers[]`. Back-compat: se una flotta ha ancora
     il vecchio slot singolo, lo si vede come lista di 1. */
  function officersOf(fleet) {
    if (!fleet) return [];
    if (Array.isArray(fleet.officers)) return fleet.officers;
    return fleet.commander ? [fleet.commander] : [];
  }
  /* Normalizza la flotta al modello multi-slot (idempotente). */
  function ensureOfficers(fleet) {
    if (!fleet) return [];
    if (!Array.isArray(fleet.officers)) {
      fleet.officers = fleet.commander ? [fleet.commander] : [];
    }
    if (fleet.commander) fleet.commander = null;   // single source of truth = officers[]
    return fleet.officers;
  }
  function allOf(game) {
    var out = list(game).slice();
    ((game && game.fleets) || []).forEach(function (f) {
      officersOf(f).forEach(function (o) { out.push(o); });
    });
    return out;
  }
  function ensure(game) {
    if (!game) return;
    if (!Array.isArray(game.commanders)) game.commanders = [];
  }

  /* Migrazione di una singola figura legacy (#43 → #75). Idempotente. */
  function migrateFigure(cmd) {
    if (!cmd) return cmd;
    if (!cmd.role) {
      var s = cmd.specialization;
      cmd.role = (s === 'tattico') ? 'comandante'
        : (s === 'navigatore' || s === 'logista') ? 'ingegnere'
        : 'comandante';
      if (s === 'logista' && !cmd.trait) { cmd.trait = 'logistico'; cmd.traitLabel = 'Logistico'; }
    }
    if (!ROLES[cmd.role]) cmd.role = 'comandante';
    cmd.roleLabel = ROLES[cmd.role].label;
    if (!cmd.race) { cmd.race = 'umani'; cmd.raceLabel = 'Umani'; }
    cmd.rank = rankFor(cmd.xp || 0).label;
    return cmd;
  }
  /* Converte tutte le figure dell'Impero (pool + assegnate). Idempotente.
     M15: normalizza anche lo slot singolo legacy → fleet.officers[]. */
  function migrateAll(game) {
    if (!game) return;
    ensure(game);
    game.commanders.forEach(migrateFigure);
    (game.fleets || []).forEach(function (f) {
      if (!f) return;
      ensureOfficers(f);
      f.officers.forEach(migrateFigure);
    });
  }

  /* ---------------------------------------------------------------
     Aggancio figura → flotta (single source of truth).
     --------------------------------------------------------------- */
  function assignableOf(game) {
    return list(game)
      .filter(function (cmd) { return cmd.status !== 'assigned'; })
      .map(function (cmd) { return { colonyKey: cmd.originColonyKey || null, commander: cmd }; });
  }
  /* Quanti slot figura ospita la flotta (dalla nave capitale più grande,
     M15). Fallback 1 se ORION.fleet non è caricato (test headless). */
  function officerSlots(fleet) {
    var F = root.ORION && root.ORION.fleet;
    return (F && F.fleetOfficerSlots) ? F.fleetOfficerSlots(fleet) : 1;
  }
  function assignToFleet(game, fleet, commanderId) {
    if (!game || !fleet) return { ok: false, reason: 'Dati mancanti' };
    var officers = ensureOfficers(fleet);
    /* già a bordo? no-op idempotente */
    for (var k = 0; k < officers.length; k++) {
      if (officers[k].id === commanderId) return { ok: true, commander: officers[k] };
    }
    var pool = list(game);
    var idx = -1;
    for (var i = 0; i < pool.length; i++) {
      if (pool[i].id === commanderId && pool[i].status !== 'assigned') { idx = i; break; }
    }
    if (idx < 0) return { ok: false, reason: 'Figura non disponibile' };
    var found = pool[idx];
    /* M15 — vincoli multi-slot: capienza dalla classe capitale + max un
       bonus per ruolo (due Comandanti non si sommano). */
    var slots = officerSlots(fleet);
    if (officers.length >= slots) {
      return { ok: false, reason: 'Posti ufficiale pieni (' + officers.length + '/' + slots + '): serve una nave capitale più grande' };
    }
    for (var j = 0; j < officers.length; j++) {
      if (officers[j].role === found.role) {
        return { ok: false, reason: 'Ruolo ' + (ROLES[found.role] ? ROLES[found.role].label : found.role) + ' già presente in flotta' };
      }
    }
    pool.splice(idx, 1);
    found.status = 'assigned';
    found.assignedFleetId = fleet.id;
    officers.push(found);
    return { ok: true, commander: found };
  }
  /* Rilascia UNA figura (per id) o, senza id, TUTTE (back-compat con i
     chiamanti M14 che passavano solo la flotta — annientamento/dissolve). */
  function releaseFromFleet(game, fleet, opts) {
    if (!fleet) return null;
    var officers = ensureOfficers(fleet);
    if (!officers.length) return null;
    ensure(game);
    var id = (typeof opts === 'string') ? opts : (opts && opts.commanderId) || null;
    if (!id) {
      /* nessun id → rilascia tutte (semantica storica) */
      var released = officers.slice();
      released.forEach(function (cmd) {
        cmd.status = 'idle'; delete cmd.assignedFleetId; game.commanders.push(cmd);
      });
      fleet.officers = [];
      return released.length === 1 ? released[0] : released;
    }
    for (var i = 0; i < officers.length; i++) {
      if (officers[i].id === id) {
        var cmd = officers.splice(i, 1)[0];
        cmd.status = 'idle'; delete cmd.assignedFleetId; game.commanders.push(cmd);
        return cmd;
      }
    }
    return null;
  }
  function releaseAllFromFleet(game, fleet) {
    return releaseFromFleet(game, fleet);
  }

  /* M15 — xp a TUTTE le figure di flotta (servizio condiviso). Sostituisce
     i call-site che davano xp solo a fleet.commander. */
  function grantFleetXp(game, fleet, amount, events) {
    officersOf(fleet).forEach(function (o) { grantXp(game, o, amount, events); });
  }

  /* Aggrega i bonus delle figure di una flotta (M15). Max un bonus per
     ruolo è già garantito da assignToFleet → moltiplichiamo i canali
     moltiplicativi e sommiamo l'imboscata. Con una sola figura coincide col
     comportamento M14. */
  function aggregateBonuses(fleet) {
    var agg = { fpMul: 1, hpMul: 1, firstStrike: 0, travelMul: 1, viveriMul: 1 };
    officersOf(fleet).forEach(function (cmd) {
      var b = bonuses(cmd);
      agg.fpMul *= b.fpMul;
      agg.hpMul *= b.hpMul;
      agg.firstStrike += b.firstStrike;
      agg.travelMul *= b.travelMul;
      agg.viveriMul *= b.viveriMul;
    });
    agg.firstStrike = Math.min(0.30, agg.firstStrike);
    agg.travelMul = Math.max(0.5, agg.travelMul);
    agg.viveriMul = Math.max(0.4, agg.viveriMul);
    return agg;
  }
  /* Moltiplicatore di durata viaggio (Ingegnere). Letto da fleet.startNextLeg. */
  function fleetSpeedMul(fleet) {
    return aggregateBonuses(fleet).travelMul;
  }
  /* Moltiplicatore di consumo viveri (Ingegnere/Logistico). Letto da
     fleet.processViveri. <1 = consumo più lento. */
  function viveriDrainMul(fleet) {
    return aggregateBonuses(fleet).viveriMul;
  }
  /* Bundle di combattimento per la flotta (Comandante fp / Ingegnere scafo /
     Stratega imboscata). Letto da combat.forceFromFleet + resolve. */
  function combatBonus(fleet) {
    var b = aggregateBonuses(fleet);
    return { fpMul: b.fpMul, hpMul: b.hpMul, firstStrike: b.firstStrike };
  }

  /* Etichetta concisa dei bonus attivi, per la UI. */
  function bonusLabel(cmd) {
    if (!cmd) return '';
    var b = bonuses(cmd), parts = [];
    if (b.fpMul > 1.001) parts.push('+' + Math.round((b.fpMul - 1) * 100) + '% fuoco');
    if (b.firstStrike > 0.001) parts.push('imboscata +' + Math.round(b.firstStrike * 100) + '%');
    if (b.hpMul > 1.001) parts.push('scafo +' + Math.round((b.hpMul - 1) * 100) + '%');
    if (b.travelMul < 0.999) parts.push('−' + Math.round((1 - b.travelMul) * 100) + '% viaggio');
    if (b.viveriMul < 0.999) parts.push('−' + Math.round((1 - b.viveriMul) * 100) + '% viveri');
    return parts.join(' · ');
  }

  root.ORION = root.ORION || {};
  root.ORION.commander = {
    PROMOTION_THRESHOLD: PROMOTION_THRESHOLD,
    RANKS: RANKS,
    ROLES: ROLES,
    ROLE_ORDER: ROLE_ORDER,
    NAME_POOL: NAME_POOL,
    TRAIT_POOL: TRAIT_POOL,
    RACE_POOL: RACE_POOL,
    make: make,
    promote: promote,
    isPromotable: isPromotable,
    grantXp: grantXp,
    bumpCrewSvc: bumpCrewSvc,
    dominantRole: dominantRole,
    bonuses: bonuses,
    rankFor: rankFor,
    rankLabel: rankLabel,
    roleLabel: roleLabel,
    list: list,
    allOf: allOf,
    ensure: ensure,
    migrateFigure: migrateFigure,
    migrateAll: migrateAll,
    assignableOf: assignableOf,
    assignToFleet: assignToFleet,
    releaseFromFleet: releaseFromFleet,
    releaseAllFromFleet: releaseAllFromFleet,
    officersOf: officersOf,
    ensureOfficers: ensureOfficers,
    officerSlots: officerSlots,
    grantFleetXp: grantFleetXp,
    aggregateBonuses: aggregateBonuses,
    fleetSpeedMul: fleetSpeedMul,
    viveriDrainMul: viveriDrainMul,
    combatBonus: combatBonus,
    bonusLabel: bonusLabel
  };
}(typeof window !== 'undefined' ? window : this));
