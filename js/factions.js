/* =====================================================================
   ORION EMPIRES — factions.js
   Modulo M10 rifondazione (decisione #52): le **4 Costanti**.

   Fazioni FISSE sempre presenti in ogni galassia. Vivono SOPRA il
   conteggio dinamico di §13.1 (non riducono lo slot di micro/imperi).
   Visibili nella vista Civiltà ⬡ come sezione fissa con nome+ruolo
   sempre noti (anche prima del contatto), dossier per gradi come le
   altre.

   Determinismo (#5): seeding da `seed:factions`. Idempotente:
   ensureFactions() non rigenera se le 4 Costanti sono già presenti.

   Confine di Fase A (foundation): qui si crea solo la generazione +
   territorio iniziale. Le **funzioni speciali** (Mekhari banca grigia,
   Vehryn vendita informazioni, Phaerion intransigenti sui confini,
   Pellegrini conversione) sono ganci che vivranno in M12/M19 e nei
   moduli dedicati. Ognuna è una `civ` regolare con `civ.faction` settato.
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  /* Catalogo 4 Costanti (decisione #52 §13.7). */
  const FACTIONS = [
    {
      id: 'mekhari',
      name: 'Sindacato Mekhari',
      role: 'Mercato grigio e taglie',
      alignment: 'neutrale',
      archetype: 'sindacato',
      archetypeLabel: 'Sindacato',
      vocation: 'mercantili',
      affinity: 'mixta',
      color: '#d96bd0',
      sizeRange: [4, 6],
      distribution: 'sparse',   // 1 hub per cluster
      expandMul: 0.20,          // ~1 nodo ogni ~4000-8000 Ι
      traitLabel: 'Fixer del mercato grigio · spread basso nei cluster'
    },
    {
      id: 'vehryn',
      name: 'Conclave di Vehryn',
      role: 'Vendono informazioni',
      alignment: 'neutrale',
      archetype: 'concilio',
      archetypeLabel: 'Concilio',
      vocation: 'tecnocratici',
      affinity: 'glaciale',
      color: '#7fd0e6',
      sizeRange: [2, 4],
      distribution: 'sparse',
      expandMul: 0.60,
      traitLabel: 'Archeologi delle stelle · dati antichi §7.2'
    },
    {
      id: 'phaerion',
      name: 'Guardiani di Phaerion',
      role: 'Custodi della tech antica',
      alignment: 'bene',
      archetype: 'ordine',
      archetypeLabel: 'Ordine',
      vocation: 'isolazionisti',
      affinity: 'ancestrale',
      color: '#c8d24a',
      sizeRange: [2, 3],
      distribution: 'concentrated',  // sede + 1-2 satelliti
      expandMul: 0,               // non espandono mai
      traitLabel: 'Intransigenti sui confini · tech antica'
    },
    {
      id: 'pellegrini',
      name: 'Pellegrini di Solhar',
      role: 'Predicatori erranti',
      alignment: 'bene',
      archetype: 'ordine',
      archetypeLabel: 'Ordine',
      vocation: 'mistici',
      affinity: 'biotica',
      color: '#9d7bff',
      sizeRange: [3, 5],
      distribution: 'sparse',
      expandMul: 0.70,
      traitLabel: 'Conversione e missioni · figura speciale religiosa'
    }
  ];

  function byId(id) {
    for (let i = 0; i < FACTIONS.length; i++) if (FACTIONS[i].id === id) return FACTIONS[i];
    return null;
  }
  function isFaction(civ) { return !!(civ && civ.faction); }

  /* Spawn iniziale delle 4 Costanti, idempotente. Richiede galaxy +
     ORION.ai. Chiamato da ORION.ai.ensure(game) durante boot/load. */
  function ensureFactions(game) {
    if (!game || !game.galaxy || !Array.isArray(game.civs)) return;
    const galaxy = game.galaxy;
    const rng = ORION.rng.makeRng(galaxy.seed + ':factions');
    const existing = {};
    for (let i = 0; i < game.civs.length; i++) {
      const c = game.civs[i];
      if (c && c.faction) existing[c.faction] = true;
    }
    /* Sistemi già occupati (player + altre civs) — non sovrascriviamo. */
    const taken = new Set();
    const playerSystems = (ORION.ai && ORION.ai._playerSystems)
      ? ORION.ai._playerSystems(game) : new Set();
    playerSystems.forEach(function (s) { taken.add(s); });
    game.civs.forEach(function (c) {
      if (!c || !c.alive) return;
      const sys = ORION.ai && ORION.ai.derivedSystems ? ORION.ai.derivedSystems(c) : (c.systems || []);
      sys.forEach(function (s) { taken.add(s); });
    });

    for (let f = 0; f < FACTIONS.length; f++) {
      const def = FACTIONS[f];
      if (existing[def.id]) continue;
      const wantSystems = rng.int(def.sizeRange[0], def.sizeRange[1]);
      const seeds = pickSeats(galaxy, def, wantSystems, taken, rng);
      if (!seeds.length) continue;
      const civ = createFactionCiv(def, seeds, galaxy, rng);
      // sigla per i sistemi posseduti
      civ.planets = seeds.map(function (sid) { return sid + ':b0'; });
      civ.systems = seeds.slice();
      seeds.forEach(function (s) { taken.add(s); });
      game.civs.push(civ);
    }
  }

  function pickSeats(galaxy, def, want, taken, rng) {
    const groups = galaxy.groups || [];
    if (def.distribution === 'concentrated') {
      /* sede + satelliti adiacenti — scegli un gruppo del Nucleo/Colonie
         per i Phaerion (custodi → vicini ai centri civilizzati). */
      const goodGroups = groups.filter(function (g) {
        return g.id !== galaxy.homeGroupId && (g.tier === 'nucleo' || g.tier === 'colonie');
      });
      const pool = goodGroups.length ? goodGroups : groups.filter(function (g) { return g.id !== galaxy.homeGroupId; });
      if (!pool.length) return [];
      pool.sort(function (a, b) { return a.id - b.id; });
      const gp = pool[rng.int(0, pool.length - 1)];
      const members = (gp.members || []).slice().sort(function (a, b) { return a - b; });
      const out = [];
      for (let i = 0; i < members.length && out.length < want; i++) {
        if (!taken.has(members[i])) out.push(members[i]);
      }
      return out;
    }
    /* sparse: 1 hub per cluster, gruppi diversi. */
    const pool = groups.filter(function (g) { return g.id !== galaxy.homeGroupId; })
      .slice().sort(function (a, b) { return a.id - b.id; });
    const shuffled = rng.shuffle(pool.slice());
    const out = [];
    for (let i = 0; i < shuffled.length && out.length < want; i++) {
      const members = (shuffled[i].members || []).slice().sort(function (a, b) { return a - b; });
      for (let j = 0; j < members.length; j++) {
        if (!taken.has(members[j])) { out.push(members[j]); break; }
      }
    }
    return out;
  }

  function createFactionCiv(def, seedSysIds, galaxy, rng) {
    const homeSys = seedSysIds[0];
    const homeGroup = galaxy.systems[homeSys] ? galaxy.systems[homeSys].cluster : galaxy.homeGroupId;
    const grp = (galaxy.groups || []).filter(function (g) { return g.id === homeGroup; })[0];
    return {
      id: 'faction-' + def.id,
      faction: def.id,                 // marker per riconoscere le 4 Costanti
      name: def.name,
      role: def.role,
      archetype: def.archetype,
      archetypeLabel: def.archetypeLabel,
      alignment: def.alignment,
      trait: 'faction-' + def.id,
      traitLabel: def.traitLabel,
      color: def.color,
      vocation: def.vocation,
      vocationLocked: true,            // vocazione fissa, mai modulata
      affinity: def.affinity,
      affinityLocked: true,
      phase: 'stable',                 // sempre stabili (mai growth/decline classici)
      homeGroupId: homeGroup,
      homeTier: grp ? grp.tier : 'colonie',
      established: true,
      planets: [],                     // riempito dal chiamante
      systems: [],
      power: seedSysIds.length * 12,
      disposition: def.alignment === 'bene' ? 18 : (def.alignment === 'male' ? -18 : 0),
      relation: 'peace',
      contacted: false,
      alive: true,
      bornAt: 0
    };
  }

  ORION.factions = {
    FACTIONS: FACTIONS,
    byId: byId,
    isFaction: isFaction,
    ensureFactions: ensureFactions
  };
})(typeof window !== 'undefined' ? window : this);
