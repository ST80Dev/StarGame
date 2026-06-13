/* =====================================================================
   ORION EMPIRES — planet.js
   Modulo M04: dati del PIANETA e stato della COLONIA.

   Strategia seed+delta (decisione #5):
     - STRUTTURA IMMUTABILE (questo file, generate()): potenziali risorse,
       slot di costruzione, popolazione massima, candidate risorse avanzate
       (parzialmente nascoste, decisione #15), palette derivata dal tipo.
       Tutto deterministico dal seed del corpo (':planet:<sysId>:<bodyKey>',
       riusa il `body.seed` definito in system.js). NON va salvata.
     - STATO MUTEVOLE (createColony / colonize / queue / ecc.): è il delta
       serializzabile per M06 — `schemaVersion`, valori per Impulso ancora
       da girare in M05.

   Scope M04 (decisione #14): definizione dei tassi-per-Impulso e
   durate-in-Impulsi (§4.4) + UI; l'avanzamento nel tempo è M05.
   ===================================================================== */
'use strict';

(function (root) {
  const makeRng = root.ORION.rng.makeRng;
  const BODY_TYPES = root.ORION.system.BODY_TYPES;

  const SCHEMA_VERSION = 1;

  /* ------------------------------------------------------------------
     Potenziali risorse base per tipo (§7.1). Scala 0-100.
     Il pianeta finale aggiunge ±15 di varianza dal proprio seed.
     Le LUNE ereditano dal tipo del padre scalato 0.55.
     I corpi orbitali (gassoso/cintura) sono solo estrazione: cibo/acqua=0.
     ------------------------------------------------------------------ */
  const BASE_POTENTIAL = {
    terrestre:  { met: 38, en: 42, food: 82, water: 75 },
    desertico:  { met: 78, en: 55, food: 18, water: 12 },
    oceanico:   { met: 32, en: 38, food: 62, water: 96 },
    ghiacciato: { met: 52, en: 28, food: 22, water: 84 },
    vulcanico:  { met: 84, en: 92, food: 10, water: 22 },
    forestale:  { met: 26, en: 38, food: 86, water: 72 },
    gassoso:    { met: 8,  en: 78, food: 0,  water: 5  },   // estrazione orbitale (§6.3)
    cintura:    { met: 72, en: 12, food: 0,  water: 5  },   // solo metalli puri
    luna:       { met: 40, en: 30, food: 8,  water: 28 }    // sovrascritta dal padre
  };

  /* Slot di costruzione (§10.2). Espandibili con tech (M13) e con le
     strutture di bonifica/terraformazione (decisione #45).
     Decisione #45 — rebalance future-ready: i numeri base sono dimensionati
     per dare spazio a 3 ladder progressivi:
       1) Base nudo (qui sotto): la colonia "media" usa ~⅔ degli slot per
          economia/popolazione, lasciando margine per difese (M09), stazioni
          (M15/M16) e strutture tech (M13).
       2) Bonifica territoriale: +8 (giardino) / +5 (fabbrica) / +3 (piccolo)
          via Centro di ingegneria planetaria (struttura tech-gated).
       3) Terraformazione: +12 (giardino) / +7 (fabbrica) via Terraformatori
          (tech-gated, richiede Bonifica).
     + Riserva di +10 slot per la capitale del gruppo (decisione #45).
     I numeri qui EMENDANO le decisioni #35/#36/#38 (rispettivamente: bumped
     mondi piccoli · varianza 0..+2 · BASE_SLOTS dimensionati). */
  const BASE_SLOTS = {
    terrestre: 35, desertico: 20, oceanico: 35,
    ghiacciato: 20, vulcanico: 20, forestale: 32,
    gassoso:   14, cintura:    14, luna:      14
  };

  /* Popolazione massima (in "unità popolazione", §9). 0 = non abitabile. */
  const BASE_POP_CAP = {
    terrestre: 12, desertico: 5, oceanico: 8,
    ghiacciato: 4, vulcanico: 4, forestale: 9,
    gassoso: 0, cintura: 0, luna: 3
  };

  /* ------------------------------------------------------------------
     POPOLAZIONE — display "realistico" (solo presentazione, §9).
     Il motore lavora in UNITÀ intere (BASE_POP_CAP, crescita in time.js):
     queste funzioni traducono le unità in un numero di PERSONE plausibile
     senza toccare nessun calcolo tarato (produzione/scarsità/classi).

     Mappatura per-pianeta: ogni corpo interpola geometricamente da
     POP_FLOOR (50 coloni a 1 unità = fondazione) fino al proprio TETTO
     di tipo quando raggiunge la sua capacità base. Così un terrestre pieno
     fa ~10 Mld, un mondo piccolo ~qualche 100 Mln, una luna ~50.000 — i
     numeri richiesti, e una curva demografica credibile (piccola all'inizio,
     esplode a metà, satura al tetto). NON va salvato: è puro display.
     ------------------------------------------------------------------ */
  const POP_FLOOR = 50;                  // persone a 1 unità (colonia appena fondata)
  const POP_CEILING = {
    terrestre:  1.0e10,  // 10 Mld
    forestale:  7.0e9,   // 7 Mld
    oceanico:   5.0e9,   // 5 Mld
    desertico:  6.0e8,   // 600 Mln
    vulcanico:  4.0e8,   // 400 Mln
    ghiacciato: 3.0e8,   // 300 Mln
    luna:       5.0e4,   // 50.000
    gassoso:    0, cintura: 0
  };

  function popCeiling(planet) {
    if (!planet) return 0;
    const m = POP_CEILING[planet.type];
    return (m == null) ? 0 : m;
  }

  /* Persone stimate per `units` unità su `planet` (units può essere
     frazionario per uno scorrimento fluido del numero). */
  function peopleAt(units, planet) {
    const M = popCeiling(planet);
    if (M <= 0) return 0;
    const refCap = Math.max(2, (planet && planet.popCap) || 2);
    let u = units;
    if (u < 1) u = 1;
    const t = (u - 1) / (refCap - 1);
    let people = POP_FLOOR * Math.pow(M / POP_FLOOR, t);
    if (people < POP_FLOOR) people = POP_FLOOR;
    if (people > M) people = M;     // clamp se i centri abitativi spingono oltre la capacità base
    return Math.round(people);
  }

  /* Unità popolazione "frazionarie" per il DISPLAY (fix scalini).
     Il motore tiene pop.total intero + pop.accum (accumulo verso il prossimo
     livello, denominato in `unitCost` che CRESCE col livello: 1+0.6·(pop−1)).
     Sommare accum grezzo a total sfora — accum può valere più di 1 unità — e
     al level-up il numero mostrato tornava indietro di scatto (dente di sega).
     Qui normalizziamo l'accumulo a una frazione vera in [0,1) del livello
     corrente, così il numero scorre monotòno tra un livello e l'altro. Solo
     presentazione: nessun calcolo tarato dipende da questo. */
  function popUnits(colony) {
    if (!colony || !colony.pop) return 0;
    const total = colony.pop.total || 0;
    if (total <= 0) return 0;
    const cap = colony.pop.cap || total;
    if (total >= cap) return cap;            // al cap l'accumulo non viene drenato: niente frazione
    const accum = colony.pop.accum || 0;
    const T = root.ORION && root.ORION.time;
    const levelCost = (T && T.CFG && typeof T.CFG.POP_LEVEL_COST === 'number') ? T.CFG.POP_LEVEL_COST : 0.6;
    const unitCost = 1 + levelCost * (total - 1);
    let frac = unitCost > 0 ? accum / unitCost : 0;
    if (frac < 0) frac = 0;
    if (frac > 0.999) frac = 0.999;          // mai "raggiungere" il livello prima del motore
    return total + frac;
  }

  /* Maturità demografica t ∈ [0,1]: la posizione lungo la curva-S (lo stesso
     `t` interno a peopleAt). La barra UI usa QUESTO valore → riempimento e
     numero di persone restano perceptivamente coerenti: la barra dice "quanto
     è sviluppata la colonia", non un rapporto lineare di unità (che dava il
     "29% di barra ma 285 persone su 7 Mld"). */
  function popMaturity(colony, planet) {
    const refCap = Math.max(2, (planet && planet.popCap) || (colony && colony.pop && colony.pop.cap) || 2);
    const u = popUnits(colony);
    if (u <= 1) return 0;
    let t = (u - 1) / (refCap - 1);
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    return t;
  }

  /* Formattazione italiana compatta: intero < 1.000, migliaia col punto,
     poi "Mln" / "Mld" con max 1 decimale (niente decimale ≥ 100). */
  function formatPeople(n) {
    n = Math.round(n || 0);
    if (n <= 0) return '0';
    if (n < 1000) return String(n);
    if (n < 1.0e6) return groupThousands(n);
    if (n < 1.0e9) return abbrev(n / 1.0e6) + ' Mln';
    return abbrev(n / 1.0e9) + ' Mld';
  }
  function abbrev(v) {
    const s = (v >= 100) ? Math.round(v).toString()
                         : (Math.round(v * 10) / 10).toString();
    return s.replace('.', ',');   // separatore decimale italiano
  }
  function groupThousands(n) {
    const s = String(n);
    let out = '';
    for (let i = 0; i < s.length; i++) {
      if (i > 0 && (s.length - i) % 3 === 0) out += '.';
      out += s[i];
    }
    return out;
  }

  /* ------------------------------------------------------------------
     Risorse avanzate (§7.2). Candidate per tipo: l'identità si rivela
     con la struttura "osservatorio" (decisione #15 — gancio scansione).
     ------------------------------------------------------------------ */
  const ADVANCED = {
    cristalli:  { label: 'Cristalli energetici', glyph: '◇' },
    esotici:    { label: 'Metalli esotici',      glyph: '⬢' },
    biomassa:   { label: 'Biomassa rara',        glyph: '❀' },
    gasNobili:  { label: 'Gas nobili',           glyph: '◌' },
    reliquie:   { label: 'Reliquie antiche',     glyph: '⌖' },
    dati:       { label: 'Dati sintetici',       glyph: '⌘' }
  };
  /* Pesi delle candidate per tipo di corpo. */
  const ADVANCED_WEIGHTS = {
    terrestre:  { biomassa: 3, dati: 1, gasNobili: 1 },
    desertico:  { cristalli: 3, esotici: 2, reliquie: 1 },
    oceanico:   { biomassa: 3, gasNobili: 2 },
    ghiacciato: { gasNobili: 3, biomassa: 1, cristalli: 1 },
    vulcanico:  { esotici: 4, cristalli: 3, reliquie: 1 },
    forestale:  { biomassa: 4, dati: 1 },
    gassoso:    { gasNobili: 5, cristalli: 2 },
    cintura:    { esotici: 4, cristalli: 3, reliquie: 1 },
    luna:       { cristalli: 2, esotici: 1, reliquie: 1, gasNobili: 1 }
  };

  function weightedPick(rng, weights) {
    const keys = Object.keys(weights);
    let total = 0;
    for (let i = 0; i < keys.length; i++) total += weights[keys[i]];
    let r = rng.float() * total;
    for (let i = 0; i < keys.length; i++) {
      r -= weights[keys[i]];
      if (r <= 0) return keys[i];
    }
    return keys[0];
  }

  const clamp = root.ORION.util.clamp;

  /* ==================================================================
     GENERAZIONE (immutabile, deterministica dal seed del corpo)
     ================================================================== */
  function generate(galaxy, system, bodyKey) {
    const body = root.ORION.system.findBody(system, bodyKey);
    if (!body) return null;
    const def = BODY_TYPES[body.type];
    const rng = makeRng(body.seed + ':planet');

    // Per le lune i potenziali ereditano dal padre (scalato 0.55).
    let basePot;
    if (def.cat === 'moon') {
      const parent = root.ORION.system.findBody(system, body.parentKey);
      const parentDef = parent ? BODY_TYPES[parent.type] : null;
      const src = parentDef && BASE_POTENTIAL[parent.type] ? BASE_POTENTIAL[parent.type] : BASE_POTENTIAL.luna;
      basePot = { met: Math.round(src.met * 0.55), en: Math.round(src.en * 0.55),
                  food: Math.round(src.food * 0.55), water: Math.round(src.water * 0.55) };
    } else {
      basePot = BASE_POTENTIAL[body.type] || BASE_POTENTIAL.terrestre;
    }

    let potentials = {
      met:   clamp(basePot.met   + rng.int(-15, 15), 0, 100),
      en:    clamp(basePot.en    + rng.int(-15, 15), 0, 100),
      food:  clamp(basePot.food  + rng.int(-15, 15), 0, 100),
      water: clamp(basePot.water + rng.int(-15, 15), 0, 100)
    };

    /* M10 Fase B punto 3 (decisione #52 §6.1): marginale = ×0.80 potenziali
       in media + bilanciamenti complementari al prime (forte in acqua+energia,
       debole in cibo+metalli). I body.* flag arrivano dalla generazione V2. */
    if (body.marginal) {
      potentials.met   = Math.round(potentials.met * 0.7);
      potentials.food  = Math.round(potentials.food * 0.7);
      potentials.en    = Math.min(100, Math.round(potentials.en * 1.05));
      potentials.water = Math.min(100, Math.round(potentials.water * 1.05));
    }
    /* Sistema metallifero anomalo: +50% potenziali metallo. */
    if (body.metalRich) {
      potentials.met = Math.min(100, Math.round(potentials.met * 1.5));
    }

    // Slot — ±1 dalla base, mai sotto 2.
    const slotsBase = BASE_SLOTS[def.cat === 'moon' ? 'luna' : body.type] || 4;
    let slots = Math.max(2, slotsBase + rng.int(0, 2));
    if (body.marginal) slots = Math.max(2, Math.round(slots * 0.75));

    // Capacità popolazione (0 se non abitabile).
    let popCap = BASE_POP_CAP[def.cat === 'moon' ? 'luna' : body.type] || 0;
    if (popCap > 0) popCap = Math.max(2, popCap + rng.int(-1, 2));
    if (body.marginal && popCap > 0) popCap = Math.max(2, Math.round(popCap * 0.75));

    // Candidate risorse avanzate (0-3): identità nascoste finché lo
    // stato della colonia non flagga `scanned` (decisione #15).
    const weights = ADVANCED_WEIGHTS[def.cat === 'moon' ? 'luna' : body.type] || {};
    const candidates = [];
    if (Object.keys(weights).length) {
      const n = rng.chance(0.85) ? rng.int(1, 3) : 0;
      const taken = {};
      for (let i = 0; i < n; i++) {
        let tries = 0, id = null;
        while (tries++ < 6) {
          const cand = weightedPick(rng, weights);
          if (!taken[cand]) { id = cand; taken[cand] = true; break; }
        }
        if (id) candidates.push({
          id: id,
          potential: clamp(40 + rng.int(0, 60), 30, 100)   // 30-100
        });
      }
    }

    // Pericolo locale del corpo (oltre al pericolo §5.3 del sistema):
    // vulcanico/ghiacciato/cintura sono più ostili.
    const hostility = ({ vulcanico: 30, ghiacciato: 18, desertico: 12, cintura: 25, gassoso: 0, luna: 8,
                         terrestre: 5, oceanico: 8, forestale: 7 })[body.type] || 10;

    // Costo di colonizzazione (Impulsi + risorse). Il pianeta natale ne è
    // esente. Per gli altri: 90-150 Impulsi + risorse (§6.2/§4.4); finché
    // il primo è "produttivo" il costo è moltiplicato (gestione in M05).
    const colCostBase = {
      met: 80, en: 40, water: 20, food: 10,
      impulsi: 90 + rng.int(0, 60)
    };
    if (def.cat === 'belt' || def.cat === 'gas') {
      colCostBase.met += 60; colCostBase.en += 40; colCostBase.impulsi += 20;
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      systemId: system.id,
      bodyKey: body.key,
      name: body.name,
      type: body.type,
      cat: def.cat,
      habitable: def.habitable,
      seed: body.seed + ':planet',
      potentials: potentials,
      slots: slots,
      popCap: popCap,
      advanced: candidates,        // [{id, potential}] — identità rivelata dopo scan
      hostility: hostility,
      colCost: colCostBase
    };
  }

  /* ==================================================================
     STATO COLONIA (delta — serializzabile per M06)
     ================================================================== */

  /* Stato iniziale: NON colonizzato.
     M06.5 (decisione #27): aggiunti i campi della fase Insediamento.
     Default `phase: 'operational'` mantiene la retro-compat coi save
     schema 3 (colonie pre-M06.5 sono già operative). */
  function createColony(planet) {
    return {
      schemaVersion: SCHEMA_VERSION,
      systemId: planet.systemId,
      bodyKey:  planet.bodyKey,
      colonized: false,
      colonizedDS: null,
      isHomeBase: false,           // §8.1: bonus pianeta base
      structures: {},              // { [id]: { level, hp } }
      queue: [],                   // [{ id, target:'build|upgrade', startedAt, duration }]
      pop:   { total: 0, cap: planet.popCap, classes: { operai: 0, scienziati: 0, militari: 0, mercanti: 0, tecnici: 0 } },
      stock: { met: 0, en: 0, food: 0, water: 0 },
      scanned: { active: false, advancedKnown: [] },   // §7.3 — sblocca con osservatorio (M05)
      /* M06.5: fase Insediamento. */
      phase: 'operational',         // 'settling' | 'operational'
      settlingStart: null,          // Impulso (game.timeImpulsi) in cui inizia l'Insediamento
      settlingDuration: 60,         // durata in Impulsi (sovrascritta dal preset all'init)
      /* M07 (decisione #37): scafi e equipaggi prodotti dall'Hangar e
         dall'Accademia. Scafi sono counter (intercambiabili), equipaggi
         sono entità con xp persistente. Le code dedicate (assets.*) sono
         separate da `queue` (strutture).
         M08 Fase A (decisione #42): il counter scafi è esteso a tutte
         le 5 classi note (explorer/caccia/intercettore/corvetta/fregata).
         I save schema 5 senza i nuovi kind vengono normalizzati nella
         sub-migrazione v5→v6 e lazy via ORION.fleet.ensureColonyShipKinds. */
      ships:  { explorer: 0, caccia: 0, intercettore: 0, corvetta: 0, fregata: 0, coloniale: 0 },
      crews:  { explorer: [] },                     // [{ id, xp }]
      assets: { shipQueue: [], crewQueue: [] }      // [{ kind, duration }]
    };
  }

  /* Colonizzazione del pianeta natale all'avvio della partita.
     M06.5 (decisione #27): la colonia non parte più "operativa" ma in
     fase `settling` con stock ridotto e pop bloccata. Le tarature
     vivono in victory.js → PRESETS (settlingDuration, startStockMul,
     startPopBase). La promozione a `operational` la fa il loop in
     time.js dopo `settlingDuration` Impulsi.

     `opts` (opzionale):
       - duration:    override settlingDuration (default 60)
       - stockMul:    override moltiplicatore stock (default 1.0)
       - popBase:     override popolazione iniziale (default 3)
       - phase:       'operational' per saltare l'Insediamento (load save) */
  function colonizeHome(colony, planet, startDS, opts) {
    opts = opts || {};
    colony.colonized = true;
    colony.colonizedDS = startDS || null;
    colony.isHomeBase = true;
    /* Popolazione iniziale §9: M06.5 fissa (no più % di popCap). */
    const popBase = Math.max(1, Math.min(opts.popBase || 3, planet.popCap || 12));
    colony.pop.total = popBase;
    /* Classi frazionarie: la colonia natale nasce 50/50 operai/tecnici come
       seme. Lo shift di time.js converge poi alla vocazione dedotta dalle
       strutture costruite (non più int → niente oscillazione a pop bassa). */
    colony.pop.classes.operai = popBase * 0.5;
    colony.pop.classes.tecnici = popBase * 0.5;
    /* Stock di avvio M06.5: ridotto a ~55% del buffer M06 (decisione #27)
       — l'atterraggio consuma. Moltiplicatore da preset. */
    const mul = (typeof opts.stockMul === 'number') ? opts.stockMul : 1.0;
    colony.stock = {
      met:   Math.round(120 * mul),
      en:    Math.round(60  * mul),
      food:  Math.round(50  * mul),
      water: Math.round(50  * mul)
    };
    /* Fase Insediamento. `'operational'` come override solo per i load
       di save vecchi (retro-compat schema 3). */
    if (opts.phase === 'operational') {
      colony.phase = 'operational';
      colony.settlingStart = null;
    } else {
      colony.phase = 'settling';
      colony.settlingStart = 0;   // riferito a game.timeImpulsi (parte da 0)
      colony.settlingDuration = Math.max(1, opts.duration || 60);
    }
    return colony;
  }

  /* M06.5: avvia la fase Insediamento su una colonia esistente. Usato
     se in futuro vorremo applicare l'Insediamento anche al SECONDO
     corpo colonizzato (oggi non lo facciamo, il task limita a Fase 0
     della colonia originaria). Lasciato come API pubblica per
     coerenza con future estensioni. */
  function startSettling(colony, planet, startImpulsi, duration) {
    colony.phase = 'settling';
    colony.settlingStart = startImpulsi || 0;
    colony.settlingDuration = Math.max(1, duration || 60);
    return colony;
  }

  /* ------------------------------------------------------------------
     SLOT EFFETTIVI (decisione #45) — somma del base + espansione da
     strutture (Centro di ingegneria planetaria, Terraformatori) + bonus
     capitale di gruppo (+10 se la colonia è capitale piena).

     Parametri:
       - planet (immutabile)
       - colony (delta, opzionale: senza colonia ritorna solo planet.slots)
       - game   (opzionale: serve per il bonus capitale; senza, lo si
                ignora e si torna solo a slot + espansioni)
       - colonyKey (opzionale: chiave per lookup in game.capitals; se
                manca e game c'è, prova a derivarla da systemId:bodyKey)
     ------------------------------------------------------------------ */
  function effectiveSlots(planet, colony, game, colonyKey) {
    if (!planet) return 0;
    let total = planet.slots || 0;
    if (colony && colony.structures) {
      const S = root.ORION.structures;
      const ids = Object.keys(colony.structures);
      for (let i = 0; i < ids.length; i++) {
        const def = S && S.get(ids[i]);
        if (!def || !def.expandsSlots) continue;
        const bonus = def.expandsSlots[planet.type];
        if (!bonus) continue;
        const lvl = colony.structures[ids[i]].level || 1;
        const msum = S && S.moduleSum ? S.moduleSum(lvl) : lvl;
        total += bonus * msum;
      }
    }
    if (game && root.ORION.capital && root.ORION.capital.slotsBonus) {
      const key = colonyKey || (colony ? (colony.systemId + ':' + colony.bodyKey) : null);
      if (key) total += root.ORION.capital.slotsBonus(game, key);
    }
    return Math.round(total);
  }

  /* Helper interno: deriva la colonyKey per le API che ne hanno bisogno. */
  function _colonyKey(colony) {
    if (!colony) return null;
    return colony.systemId + ':' + colony.bodyKey;
  }

  /* ------------------------------------------------------------------
     CALCOLI: produzione potenziale per Impulso (lettura, no avanzamento).
     Combina i tassi delle strutture con i potenziali del pianeta.
     Bonus pianeta base §8.1 (EMENDATA da decisione #45): il +20% legacy
     su isHomeBase viene sostituito dal +15% uniforme della "Capitale di
     Gruppo". La home iniziale è auto-promossa a capitale del proprio
     gruppo (capital.initFromHome) → eredita il bonus senza interruzioni.
     Per i test headless senza modulo capital, fallback a isHomeBase ×1.15.
     ------------------------------------------------------------------ */
  function structureOutput(colony, planet, game, colonyKey) {
    const out = { met: 0, en: 0, food: 0, water: 0, research: 0, scan: 0, popCap: 0, popGrowth: 0, exotic: 0 };
    const upkeep = { met: 0, en: 0, food: 0, water: 0 };
    if (!colony.colonized) return { rates: out, upkeep: upkeep, used: 0 };

    const S = root.ORION.structures;
    const ids = Object.keys(colony.structures);
    const pot = planet.potentials;
    let slotsUsed = 0;

    // mappa di moltiplicatori applicati dalle produttive (per id sorgente).
    // Decisione #38: i modifiers scalano con la resa cumulata dei moduli.
    const mods = {};
    for (let i = 0; i < ids.length; i++) {
      const def = S.get(ids[i]);
      if (!def || !def.modifiers) continue;
      const lvl = colony.structures[ids[i]].level || 1;
      const msum = S.moduleSum(lvl);
      Object.keys(def.modifiers).forEach(function (k) {
        mods[k] = (mods[k] || 0) + def.modifiers[k] * msum;
      });
    }

    for (let i = 0; i < ids.length; i++) {
      const def = S.get(ids[i]);
      if (!def) continue;
      const ent = colony.structures[ids[i]];
      const lvl = ent.level || 1;
      // Decisione #38: PRODUZIONE = resa cumulata moduli (rendimento crescente),
      // UPKEEP = lineare (×livello, ogni modulo consuma uguale), SLOT = ×livello.
      const msum = S.moduleSum(lvl);
      slotsUsed += S.slotFootprint(def, lvl);
      /* Decisione #49 (M09, §10.2): le strutture DANNEGGIATE in battaglia
         producono meno (efficienza ∝ hp/100). Default hp=100 → nessun
         effetto sui save esistenti. L'upkeep resta pieno (struttura
         danneggiata costa comunque) → penalità realistica + spinta a riparare. */
      const hpFactor = Math.max(0, Math.min(1, (ent.hp != null ? ent.hp : 100) / 100));

      Object.keys(def.rates || {}).forEach(function (k) {
        // i tassi "risorsa base" sono modulati dal potenziale del pianeta
        let base = def.rates[k] * msum * hpFactor;
        if (k === 'met')   base *= pot.met / 60;
        if (k === 'en')    base *= pot.en  / 60;
        if (k === 'food')  base *= pot.food / 60;
        if (k === 'water') base *= pot.water / 60;
        // bonus capitale di gruppo §8.1 (EMENDATA da decisione #45):
        // +15% se capitale piena, 0 se pre-capital, -10% se decommissioning.
        // Fallback per test headless: senza il modulo capital, usa il
        // +20% legacy su isHomeBase per non rompere i test esistenti.
        const C = root.ORION.capital;
        if (C && C.bonusOf) {
          const key = colonyKey || _colonyKey(colony);
          const bonus = C.bonusOf(game, key);
          if (bonus) base *= (1 + bonus);
        } else if (colony.isHomeBase) {
          base *= 1.20;     // fallback legacy (test headless senza capital.js)
        }
        // modificatori da produttive (es. fonderia → +40%/modulo miniera)
        const modKey = def.id + '.rates.' + k;
        if (mods[modKey]) base *= (1 + mods[modKey]);
        out[k] = (out[k] || 0) + base;
      });

      Object.keys(def.upkeep || {}).forEach(function (k) {
        upkeep[k] = (upkeep[k] || 0) + def.upkeep[k] * lvl;
      });
    }
    /* M13 Fase B (decisione #57): tech estrazione = modificatore passivo
       globale sulla produzione delle 4 risorse base (zero nuove strutture). */
    const RM = root.ORION.research;
    if (RM && RM.mods) {
      const exMul = RM.mods(game).extractionMul;
      if (exMul && exMul !== 1) {
        ['met', 'en', 'food', 'water'].forEach(function (k) { if (out[k]) out[k] *= exMul; });
      }
    }
    return { rates: out, upkeep: upkeep, used: slotsUsed };
  }

  /* Verifica prerequisiti di una struttura sulla colonia.
     Decisione #45: accetta `game` (opzionale) per leggere il bonus slot
     della capitale di gruppo. Senza `game` (test headless / chiamanti
     legacy) usa planet.slots puro = comportamento pre-#45. */
  function canBuild(colony, planet, structId, game) {
    const def = root.ORION.structures.get(structId);
    if (!def) return { ok: false, reason: 'Struttura sconosciuta' };
    // tipo di corpo compatibile
    const types = def.bodyTypes;
    if (types && types.indexOf(planet.type) < 0) return { ok: false, reason: 'Non costruibile su ' + planet.type };
    // in coda al cantiere (build o demolish): prioritario perché lo stato
    // transitorio è ciò che il giocatore deve vedere
    for (let qi = 0; qi < colony.queue.length; qi++) {
      if (colony.queue[qi].id === structId) {
        const isDemo = colony.queue[qi].target === 'demolish';
        return { ok: false, reason: isDemo ? 'In smantellamento' : 'In costruzione', code: isDemo ? 'demolishing' : 'building' };
      }
    }
    // Decisione #38: una struttura esistente si POTENZIA (aggiunge un modulo)
    // finché è sotto maxLevel. Ogni modulo occupa slot-base slot in più.
    const S2 = root.ORION.structures;
    const existing = colony.structures[structId];
    const curLevel = existing ? (existing.level || 1) : 0;
    if (existing && curLevel >= (def.maxLevel || 1)) {
      return { ok: false, reason: 'Livello massimo raggiunto', code: 'maxlevel' };
    }
    const nextLevel = curLevel + 1;
    // slot disponibili (footprint = slot-base × livello)
    const used = Object.keys(colony.structures).reduce(function (a, id) {
      const d = root.ORION.structures.get(id);
      return a + S2.slotFootprint(d, colony.structures[id].level || 1);
    }, 0);
    const inQueue = colony.queue.reduce(function (a, q) {
      const d = root.ORION.structures.get(q.id);
      return a + ((d && d.slots) || 1);   // ogni voce in coda = +1 modulo
    }, 0);
    const slotCap = effectiveSlots(planet, colony, game);
    if (used + inQueue + (def.slots || 1) > slotCap) return { ok: false, reason: 'Slot insufficienti' };
    // prerequisiti gancio (decisione: in M04 solo segnaliamo,
    // l'attivazione vera dei tech è M13; 'scan' = osservatorio costruito)
    const req = def.requires || [];
    for (let i = 0; i < req.length; i++) {
      const r = req[i];
      if (r === 'scan') {
        if (!colony.structures['osservatorio']) return { ok: false, reason: 'Richiede osservatorio' };
      } else if (r.indexOf('struct:') === 0) {
        const parts = r.split(':');           // struct:<id>:<lvl>
        const id = parts[1], lvl = parseInt(parts[2] || '1', 10);
        const have = colony.structures[id];
        if (!have || (have.level || 1) < lvl) return { ok: false, reason: 'Richiede ' + (root.ORION.structures.get(id) || { name: id }).name + ' lvl ' + lvl };
      } else if (r.indexOf('tech:') === 0) {
        // M13 (decisione #57): la tech è disponibile se sbloccata nel pool
        // d'impero. Fallback difensivo: se il modulo research non è caricato
        // (test headless legacy), la tech resta bloccata come prima.
        const techId = r.slice(5);
        if (!root.ORION.research || !root.ORION.research.isUnlocked(game, techId)) {
          const tdef = root.ORION.research && root.ORION.research.get(techId);
          return { ok: false, reason: 'Richiede ricerca: ' + ((tdef && tdef.name) || techId) };
        }
      }
    }
    // risorse: costo escalante del prossimo modulo (decisione #38)
    const cost = S2.stepCost(def, nextLevel);
    const keys = Object.keys(cost);
    for (let i = 0; i < keys.length; i++) {
      if ((colony.stock[keys[i]] || 0) < cost[keys[i]]) {
        return { ok: false, reason: 'Risorse insufficienti (' + keys[i] + ')' };
      }
    }
    // cantiere planetario occupato: una struttura alla volta per pianeta
    // (decisione: coda lunga 1; vedi CLAUDE.md). Check ultimo: i blocchi
    // permanenti hanno priorità nei tooltip.
    if (colony.queue.length >= 1) {
      return { ok: false, reason: 'Cantiere planetario occupato', code: 'busy' };
    }
    return { ok: true, isUpgrade: !!existing, nextLevel: nextLevel };
  }

  /* Avvia una costruzione: sottrae il costo dallo stock e mette in coda.
     L'avanzamento del timer e il completamento sono M05. */
  function startBuild(colony, planet, structId, startedAtDS, game) {
    const check = canBuild(colony, planet, structId, game);
    if (!check.ok) return check;
    const S = root.ORION.structures;
    const def = S.get(structId);
    const nextLevel = check.nextLevel || 1;
    // Decisione #38: costo/tempo del prossimo modulo escalano col livello.
    const cost = S.stepCost(def, nextLevel);
    const time = S.stepTime(def, nextLevel);
    Object.keys(cost).forEach(function (k) { colony.stock[k] = (colony.stock[k] || 0) - cost[k]; });
    colony.queue.push({
      id: structId,
      target: check.isUpgrade ? 'upgrade' : 'build',
      toLevel: nextLevel,
      startedAt: startedAtDS || null,
      duration: time,
      /* Salviamo il tempo totale al momento dell'enqueue così la UI può
         mostrare progress veri (es. "8/12 Ι" per un L2). Senza questo il
         display usava def.time base e produceva "14/9" su upgrade. */
      totalTime: time
    });
    return { ok: true };
  }

  /* Annulla una voce in coda. Build: rimborsa l'80% del costo speso.
     Demolish: nessun rimborso (non era stato speso nulla), la struttura
     resta intatta. */
  function cancelBuild(colony, index) {
    if (index < 0 || index >= colony.queue.length) return { ok: false };
    const q = colony.queue.splice(index, 1)[0];
    if (q.target === 'demolish') return { ok: true };
    const def = root.ORION.structures.get(q.id);
    if (def && def.cost) {
      const refund = root.ORION.structures.stepCost(def, q.toLevel || 1);
      Object.keys(refund).forEach(function (k) {
        colony.stock[k] = (colony.stock[k] || 0) + Math.floor(refund[k] * 0.8);
      });
    }
    return { ok: true };
  }

  /* Verifica se una struttura costruita può essere smantellata. */
  function canDemolish(colony, planet, structId) {
    const def = root.ORION.structures.get(structId);
    if (!def) return { ok: false, reason: 'Struttura sconosciuta' };
    if (!colony.structures[structId]) return { ok: false, reason: 'Non costruita' };
    if (colony.queue.length >= 1) {
      return { ok: false, reason: 'Cantiere planetario occupato', code: 'busy' };
    }
    return { ok: true };
  }

  /* Avvia uno smantellamento. Occupa il cantiere come una build (coda
     lunga 1), durata = metà del tempo di costruzione, niente costo
     immediato. Il rimborso (50%, 70% sulla colonia natale) e il malus
     morale -0.10 per 30 Ι vengono applicati al completamento in time.js
     (decisione recovery-friendly: il malus decade da solo). */
  function startDemolish(colony, planet, structId, startedAtDS) {
    const check = canDemolish(colony, planet, structId);
    if (!check.ok) return check;
    const def = root.ORION.structures.get(structId);
    const dur = Math.max(1, Math.round((def.time || 2) / 2));
    colony.queue.push({
      id: structId,
      target: 'demolish',
      startedAt: startedAtDS || null,
      duration: dur,
      totalTime: dur
    });
    return { ok: true };
  }

  /* Sblocca le identità delle risorse avanzate del pianeta — chiamato
     dal completamento dell'osservatorio (M05). In M04 si può chiamare
     manualmente da debug ma di default resta off. */
  function applyScan(colony, planet) {
    if (colony.scanned.active) return;
    colony.scanned.active = true;
    colony.scanned.advancedKnown = planet.advanced.map(function (a) { return a.id; });
  }

  /* ==================================================================
     M07 — Cantieri & Squadre (decisione #37)
     Scafi (Hangar di costruzione, id 'cantiere-navale') e equipaggi
     (Accademia militare, id 'accademia-militare'). Costo+durata fissi
     dalle costanti di ORION.expedition.CFG quando il modulo è caricato,
     fallback inline per i test headless.
     ================================================================== */

  function expCfg(key, fallback) {
    if (root.ORION && root.ORION.expedition && root.ORION.expedition.CFG) {
      return root.ORION.expedition.CFG[key];
    }
    return fallback;
  }

  function ensureAssets(colony) {
    if (!colony.ships) colony.ships = { explorer: 0 };
    /* M08 Fase A: assicura che tutte le 5 classi note abbiano un counter
       (lazy, idempotente). Save vecchi caricano senza modifiche. */
    if (root.ORION && root.ORION.fleet && root.ORION.fleet.ensureColonyShipKinds) {
      root.ORION.fleet.ensureColonyShipKinds(colony);
    } else if (colony.ships.explorer == null) {
      colony.ships.explorer = 0;
    }
    if (!colony.crews) colony.crews = { explorer: [] };
    if (!colony.assets) colony.assets = { shipQueue: [], crewQueue: [] };
    if (!Array.isArray(colony.assets.shipQueue)) colony.assets.shipQueue = [];
    if (!Array.isArray(colony.assets.crewQueue)) colony.assets.crewQueue = [];
  }

  function hasStructLevel(colony, structId, lvl) {
    const ent = colony.structures && colony.structures[structId];
    return !!(ent && (ent.level || 0) >= (lvl || 1));
  }

  function canPay(colony, cost) {
    const keys = Object.keys(cost || {});
    for (let i = 0; i < keys.length; i++) {
      if ((colony.stock[keys[i]] || 0) < cost[keys[i]]) return false;
    }
    return true;
  }
  function pay(colony, cost) {
    Object.keys(cost || {}).forEach(function (k) {
      colony.stock[k] = (colony.stock[k] || 0) - cost[k];
    });
  }

  /* M15 — conta le navi di una classe già possedute dal giocatore
     (a terra + in coda + in flotta). Usato per l'unicità della Nave
     Ammiraglia (GDD §12.1: una sola per civiltà). */
  function countPlayerShipsOfKind(game, kind) {
    let n = 0;
    const cols = (game && game.colonies) || {};
    Object.keys(cols).forEach(function (ck) {
      const c = cols[ck];
      if (c && c.ships) n += (c.ships[kind] || 0);
      const q = c && c.assets && c.assets.shipQueue;
      if (Array.isArray(q)) for (let i = 0; i < q.length; i++) if (q[i].kind === kind) n++;
    });
    const fleets = (game && game.fleets) || [];
    for (let i = 0; i < fleets.length; i++) {
      const ships = fleets[i].ships || [];
      for (let j = 0; j < ships.length; j++) if (ships[j].kind === kind) n++;
    }
    return n;
  }

  function startShipBuild(colony, planet, game, colonyKey, kind) {
    ensureAssets(colony);
    /* M08 Fase A (decisione #42): la classe nave viene dal catalogo
       ORION.fleet.CLASSES. Default 'explorer' per retro-compat coi chiamanti
       M07 (che non passavano `kind`). */
    kind = kind || 'explorer';
    const F = root.ORION && root.ORION.fleet;
    const cls = F && F.getClass ? F.getClass(kind) : null;
    let cost, time, reqLvl;
    if (cls) {
      cost = cls.cost;
      time = cls.time;
      reqLvl = cls.hangarLvl || 1;
    } else {
      /* Fallback test headless: comportamento M07 originale. */
      cost = expCfg('SHIP_COST', { met: 25, en: 12 });
      time = expCfg('SHIP_TIME', 10);
      reqLvl = 1;
    }
    /* Decisione #41/#42 + M15: capacità hangar/bacino (cantieri + attracchi
       pesati dalla classe). Deleghiamo a canBuildShip passando la classe. */
    const E = root.ORION && root.ORION.expedition;
    if (E && E.canBuildShip) {
      const check = E.canBuildShip(game, colony, colonyKey, kind);
      if (!check.ok) return check;
    } else if (!hasStructLevel(colony, 'cantiere-navale', 1)) {
      return { ok: false, reason: 'Hangar di costruzione non costruito' };
    }
    if (!hasStructLevel(colony, 'cantiere-navale', reqLvl)) {
      return { ok: false, reason: 'Hangar di costruzione lvl ' + reqLvl + ' richiesto per ' + (cls ? cls.name : kind) };
    }
    /* M15 — Dreadnought/Ammiraglia richiedono il Bacino orbitale (#41). */
    if (cls && cls.requiresStruct) {
      const rs = cls.requiresStruct;
      let satisfied = hasStructLevel(colony, rs.id, rs.level || 1);
      /* M16 Fase B (#81): un Bacino ORBITALE (stazione di livello alto entro
         raggio) soddisfa il requisito dei capitali al posto di quello planetario. */
      if (!satisfied && rs.id === 'bacino-orbitale' && game &&
          root.ORION.station && root.ORION.station.orbitalShipyardFor) {
        satisfied = root.ORION.station.orbitalShipyardFor(game, colonyKey, rs.level || 1);
      }
      if (!satisfied) {
        const sdef = root.ORION && root.ORION.structures && root.ORION.structures.get(rs.id);
        const sname = sdef ? sdef.name : rs.id;
        return { ok: false, reason: sname + ' lvl ' + (rs.level || 1) + ' richiesto per ' + cls.name + ' (anche un cantiere orbitale vicino)' };
      }
    }
    /* M15 — Nave Ammiraglia unica per civiltà (GDD §12.1). */
    if (cls && cls.unique && game && countPlayerShipsOfKind(game, kind) >= 1) {
      return { ok: false, reason: cls.name + ': ne esiste già una (unica per civiltà)' };
    }
    if (E && E.applyTechSpeed) time = E.applyTechSpeed(time, colony);
    if (!canPay(colony, cost)) return { ok: false, reason: 'Risorse insufficienti' };
    pay(colony, cost);
    colony.assets.shipQueue.push({ kind: kind, duration: time, totalTime: time });
    return { ok: true };
  }

  function startCrewBuild(colony, planet) {
    ensureAssets(colony);
    /* Decisione utente 2026-06-11: cap di addestramenti contemporanei dal
       livello d'Accademia. Se ORION.expedition è caricato deleghiamo a
       canBuildCrew; altrimenti fallback al solo controllo di esistenza. */
    const E = root.ORION && root.ORION.expedition;
    if (E && E.canBuildCrew) {
      const check = E.canBuildCrew(colony);
      if (!check.ok) return check;
    } else if (!hasStructLevel(colony, 'accademia-militare', 1)) {
      return { ok: false, reason: 'Accademia militare non costruita' };
    }
    const cost = expCfg('CREW_COST', { food: 12, water: 6 });
    let time = expCfg('CREW_TIME', 12);
    /* Decisione #41: i tecnici accelerano anche l'addestramento equipaggi
       (analogia: logistica/ingegneria di supporto). Riusa `E` sopra. */
    if (E && E.applyTechSpeed) time = E.applyTechSpeed(time, colony);
    if (!canPay(colony, cost)) return { ok: false, reason: 'Risorse insufficienti' };
    pay(colony, cost);
    colony.assets.crewQueue.push({ kind: 'explorer', duration: time, totalTime: time });
    return { ok: true };
  }

  function cancelShipBuild(colony, idx) {
    ensureAssets(colony);
    if (idx < 0 || idx >= colony.assets.shipQueue.length) return { ok: false };
    const entry = colony.assets.shipQueue.splice(idx, 1)[0];
    /* M08 Fase A: rimborso per il KIND corretto (50%, recovery-friendly). */
    const F = root.ORION && root.ORION.fleet;
    const cls = (entry && entry.kind && F && F.getClass) ? F.getClass(entry.kind) : null;
    const cost = (cls && cls.cost) ? cls.cost : expCfg('SHIP_COST', { met: 25, en: 12 });
    Object.keys(cost).forEach(function (k) {
      colony.stock[k] = (colony.stock[k] || 0) + Math.floor(cost[k] * 0.5);
    });
    return { ok: true };
  }

  function cancelCrewBuild(colony, idx) {
    ensureAssets(colony);
    if (idx < 0 || idx >= colony.assets.crewQueue.length) return { ok: false };
    colony.assets.crewQueue.splice(idx, 1);
    const cost = expCfg('CREW_COST', { food: 12, water: 6 });
    Object.keys(cost).forEach(function (k) {
      colony.stock[k] = (colony.stock[k] || 0) + Math.floor(cost[k] * 0.5);
    });
    return { ok: true };
  }

  root.ORION = root.ORION || {};
  root.ORION.planet = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    ADVANCED: ADVANCED,
    BASE_POTENTIAL: BASE_POTENTIAL,
    POP_FLOOR: POP_FLOOR,
    POP_CEILING: POP_CEILING,
    popCeiling: popCeiling,
    peopleAt: peopleAt,
    popUnits: popUnits,
    popMaturity: popMaturity,
    formatPeople: formatPeople,
    generate: generate,
    createColony: createColony,
    colonizeHome: colonizeHome,
    startSettling: startSettling,
    structureOutput: structureOutput,
    effectiveSlots: effectiveSlots,
    canBuild: canBuild,
    startBuild: startBuild,
    cancelBuild: cancelBuild,
    canDemolish: canDemolish,
    startDemolish: startDemolish,
    applyScan: applyScan,
    /* M07 (decisione #37) — cantieri/squadre */
    ensureAssets: ensureAssets,
    startShipBuild: startShipBuild,
    startCrewBuild: startCrewBuild,
    cancelShipBuild: cancelShipBuild,
    cancelCrewBuild: cancelCrewBuild
  };
})(typeof window !== 'undefined' ? window : this);
