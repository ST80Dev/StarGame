/* =====================================================================
   commander.js — Figure Comandante (decisione #43, gancio M14)

   Promozione equipaggio M07 → Comandante nominato.
   Trigger: al rientro di una spedizione un equipaggio raggiunge il grado
   massimo 'Leggende' (xp ≥ 10, decisione utente 2026-06-11; coerente con
   expedition.enrichmentForXp). L'esperienza dello staff veterano "esce"
   col Comandante e viene aggregata nella figura.
   Effetto (scelta utente):
     - nasce una figura Comandante che eredita la xp del crew
     - l'equipaggio NON viene consumato (sono più persone): la sua xp è
       resettata a 0 → il crew riparte come "neo-riformato", l'entità
       non si brucia, niente doppioni xp.

   Bonus interim ("in panchina", scelta utente): la figura nasce con
   nome + rango + tratto + specializzazione + xp, viene listata nella
   tab Forze. Nessun bonus attivo finché M08 (flotta da combattimento)
   non l'aggancerà alle navi evolute. Per ora `status: 'idle'`.

   Determinismo (decisione #5): RNG derivato da
   `seed:commander:<crewId>` — replay identico.

   Persistenza (decisione utente 2026-06-11): i Comandanti sono figure
   A LIVELLO IMPERO, NON legate a una colonia. Pool idle in
   `game.commanders[]`; quelli al comando vivono su `fleet.commander`
   (single source of truth). `originColonyKey` resta come provenienza
   narrativa. Save schema 22 (migrazione v21→v22 sposta i vecchi
   `colony.commanders[]` nel pool d'Impero).

   Lessico SW-flavor (decisione #34): rank "Comandante" come carica
   iniziale (M08/M15 estenderanno a Capitano/Ammiraglio); nomi propri
   procedurali (niente personaggi 1:1).
   ===================================================================== */
(function (root) {
  'use strict';

  /* Soglia di promozione: xp ≥ 10 = grado 'Leggende', il massimo della
     scala equipaggio (coerente con expedition.enrichmentForXp).
     Cambiare qui se M14 vorrà alzarla. */
  var PROMOTION_THRESHOLD = 10;

  /* Pool nomi propri — neutri / sci-fi, evitando marchi (#34).
     ~40 voci, brevi, mix maschili/femminili/ambigui. */
  var NAME_POOL = [
    'Vance', 'Kade', 'Theron', 'Lyra', 'Rhea', 'Cassian',
    'Mira', 'Dax', 'Selene', 'Orin', 'Talia', 'Renn',
    'Soren', 'Kira', 'Halen', 'Nyx', 'Ardan', 'Vael',
    'Calix', 'Iona', 'Drev', 'Saskia', 'Korin', 'Eva',
    'Talos', 'Maren', 'Briar', 'Quill', 'Ondra', 'Sahir',
    'Vesper', 'Roan', 'Kessa', 'Idris', 'Nima', 'Caelen',
    'Ostara', 'Jarek', 'Liora', 'Tarek'
  ];

  /* Tratti personalità — orientano la narrazione (e in futuro
     piccoli modificatori tematici quando M08/M09 entreranno). */
  var TRAIT_POOL = [
    { id: 'audace',      label: 'Audace' },
    { id: 'prudente',    label: 'Prudente' },
    { id: 'risoluto',    label: 'Risoluto' },
    { id: 'carismatico', label: 'Carismatico' },
    { id: 'tenace',      label: 'Tenace' },
    { id: 'astuto',      label: 'Astuto' },
    { id: 'lucido',      label: 'Lucido' },
    { id: 'spavaldo',    label: 'Spavaldo' },
    { id: 'stoico',      label: 'Stoico' },
    { id: 'implacabile', label: 'Implacabile' }
  ];

  /* Specializzazioni — tematiche, copertura dei 3 grandi assi del
     gioco-flotta. M08/M09/M15 le aggancieranno ai bonus veri. */
  var SPEC_POOL = [
    { id: 'navigatore', label: 'Navigatore', hint: 'Esperto di rotte iperspaziali' },
    { id: 'tattico',    label: 'Tattico',    hint: 'Comando in battaglia' },
    { id: 'logista',    label: 'Logista',    hint: 'Gestione supply chain e usura' }
  ];

  function pickFromPool(rng, pool) {
    var idx = Math.floor(rng.float() * pool.length);
    if (idx >= pool.length) idx = pool.length - 1;
    return pool[idx];
  }

  /* Genera una figura Comandante a partire da un crewId.
     Esposta come API per test e per usi futuri (M14 farà
     promozioni alternative, es. da figura "Ufficiale" → "Capitano"). */
  function make(game, crewId, inheritedXp, originColonyKey) {
    var seed = (game && game.seed) || '';
    var rng = ORION.rng.makeRng(seed + ':commander:' + crewId);
    var name = pickFromPool(rng, NAME_POOL);
    var trait = pickFromPool(rng, TRAIT_POOL);
    var spec = pickFromPool(rng, SPEC_POOL);
    return {
      id: 'cmd-' + (game.timeImpulsi || 0) + '-' + crewId,
      name: name,
      rank: 'Comandante',          /* M08/M15 estenderà a Capitano/Ammiraglio */
      xp: inheritedXp | 0,         /* eredita l'esperienza dal crew */
      trait: trait.id,
      traitLabel: trait.label,
      specialization: spec.id,
      specializationLabel: spec.label,
      originColonyKey: originColonyKey,
      originCrewId: crewId,        /* traccia il crew di provenienza */
      status: 'idle',              /* "in panchina" finché M08 non aggancia */
      bornAt: game.timeImpulsi || 0
    };
  }

  /* Promozione vera e propria: chiamata al rientro/servizio di un
     equipaggio. Riceve l'oggetto crew (per resettarne la xp) e lo xp
     ereditato. Il Comandante è una figura A LIVELLO IMPERO (decisione
     utente 2026-06-11): vive in `game.commanders[]`, NON appartiene a una
     colonia. `originColonyKey` resta come etichetta narrativa "emerso su".
     Emerge SEMPRE (anche da una flotta in esilio, senza colonie).
     Ritorna la figura creata (o null se mancano dati). */
  function promote(game, crewEntry, inheritedXp, originColonyKey) {
    if (!game || !crewEntry) return null;
    if (!Array.isArray(game.commanders)) game.commanders = [];
    var cmd = make(game, crewEntry.id, inheritedXp, originColonyKey);
    game.commanders.push(cmd);
    /* Reset xp del crew: l'entità non si brucia, l'equipaggio si
       riforma sotto il vuoto lasciato dall'ufficiale promosso
       (scelta utente). */
    crewEntry.xp = 0;
    return cmd;
  }

  /* Helper: l'equipaggio appena tornato è candidato alla promozione?
     Centralizza la soglia così expedition.js resta agnostico. */
  function isPromotable(newXp) {
    return (newXp | 0) >= PROMOTION_THRESHOLD;
  }

  /* Pool idle a livello Impero (in panchina, non assegnati a flotte). */
  function list(game) {
    return (game && Array.isArray(game.commanders)) ? game.commanders : [];
  }

  /* Tutti i Comandanti dell'Impero: pool idle (game.commanders) +
     assegnati (su fleet.commander). Per le UI di roster. */
  function allOf(game) {
    var out = list(game).slice();
    ((game && game.fleets) || []).forEach(function (f) {
      if (f && f.commander) out.push(f.commander);
    });
    return out;
  }

  /* Lazy-init del pool d'Impero. */
  function ensure(game) {
    if (!game) return;
    if (!Array.isArray(game.commanders)) game.commanders = [];
  }

  /* ---------------------------------------------------------------
     Aggancio Comandante → flotta (M09, chiude il gancio #43/#49).
     `combat.js` legge già `fleet.commander.specialization` per il
     +10% Tattico; `fleet.js` legge il bonus Navigatore sul viaggio.
     Modello a "spostamento" (single source of truth): un Comandante
     vive O nel pool d'Impero (game.commanders) O su una flotta
     (fleet.commander), mai duplicato → round-trip JSON pulito.
     --------------------------------------------------------------- */

  /* Tutti i Comandanti assegnabili (idle, nel pool d'Impero). La chiave
     `colonyKey` resta come provenienza narrativa (dove è emerso). */
  function assignableOf(game) {
    return list(game)
      .filter(function (cmd) { return cmd.status !== 'assigned'; })
      .map(function (cmd) { return { colonyKey: cmd.originColonyKey || null, commander: cmd }; });
  }

  /* Assegna un Comandante idle (per id) alla flotta. Se la flotta ne ha
     già uno, prima lo rilascia. Recovery-friendly: niente perdita. */
  function assignToFleet(game, fleet, commanderId) {
    if (!game || !fleet) return { ok: false, reason: 'Dati mancanti' };
    if (fleet.commander && fleet.commander.id === commanderId) return { ok: true, commander: fleet.commander };
    var pool = list(game);
    var idx = -1;
    for (var i = 0; i < pool.length; i++) {
      if (pool[i].id === commanderId && pool[i].status !== 'assigned') { idx = i; break; }
    }
    if (idx < 0) return { ok: false, reason: 'Comandante non disponibile' };
    var found = pool[idx];
    if (fleet.commander) releaseFromFleet(game, fleet);   // libera il precedente
    pool.splice(idx, 1);                                  // esce dal pool d'Impero
    found.status = 'assigned';
    found.assignedFleetId = fleet.id;
    fleet.commander = found;
    return { ok: true, commander: found };
  }

  /* Rilascia il Comandante di una flotta, rimettendolo nel pool d'Impero.
     Sempre possibile (il pool esiste a prescindere dalle colonie → niente
     più verruca dell'esilio). `opts` mantenuta per compat, ignorata. */
  function releaseFromFleet(game, fleet, opts) {
    if (!fleet || !fleet.commander) return null;
    var cmd = fleet.commander;
    ensure(game);
    cmd.status = 'idle';
    delete cmd.assignedFleetId;
    game.commanders.push(cmd);
    fleet.commander = null;
    return cmd;
  }

  /* Moltiplicatore di velocità di viaggio dal Comandante (Navigatore −15%).
     Letto da fleet.js in startNextLeg. */
  function fleetSpeedMul(fleet) {
    var cmd = fleet && fleet.commander;
    if (cmd && cmd.specialization === 'navigatore') return 0.85;
    return 1;
  }

  /* Etichetta del bonus attivo, per la UI. */
  function bonusLabel(cmd) {
    if (!cmd) return '';
    if (cmd.specialization === 'tattico') return '+10% potenza di fuoco';
    if (cmd.specialization === 'navigatore') return '−15% durata viaggio';
    if (cmd.specialization === 'logista') return 'logistica/cargo (gancio M12)';
    return '';
  }

  root.ORION = root.ORION || {};
  root.ORION.commander = {
    PROMOTION_THRESHOLD: PROMOTION_THRESHOLD,
    NAME_POOL: NAME_POOL,
    TRAIT_POOL: TRAIT_POOL,
    SPEC_POOL: SPEC_POOL,
    make: make,
    promote: promote,
    isPromotable: isPromotable,
    list: list,
    allOf: allOf,
    ensure: ensure,
    assignableOf: assignableOf,
    assignToFleet: assignToFleet,
    releaseFromFleet: releaseFromFleet,
    fleetSpeedMul: fleetSpeedMul,
    bonusLabel: bonusLabel
  };
}(typeof window !== 'undefined' ? window : this));
