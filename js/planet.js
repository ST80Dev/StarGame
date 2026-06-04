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

  /* Slot di costruzione (§10.2). Espandibili con tech (M13). */
  const BASE_SLOTS = {
    terrestre:  8, desertico:  6, oceanico:  6,
    ghiacciato: 5, vulcanico:  6, forestale: 7,
    gassoso:    3, cintura:    3, luna:      4
  };

  /* Popolazione massima (in "unità popolazione", §9). 0 = non abitabile. */
  const BASE_POP_CAP = {
    terrestre: 12, desertico: 5, oceanico: 8,
    ghiacciato: 4, vulcanico: 4, forestale: 9,
    gassoso: 0, cintura: 0, luna: 3
  };

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

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

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

    const potentials = {
      met:   clamp(basePot.met   + rng.int(-15, 15), 0, 100),
      en:    clamp(basePot.en    + rng.int(-15, 15), 0, 100),
      food:  clamp(basePot.food  + rng.int(-15, 15), 0, 100),
      water: clamp(basePot.water + rng.int(-15, 15), 0, 100)
    };

    // Slot — ±1 dalla base, mai sotto 2.
    const slotsBase = BASE_SLOTS[def.cat === 'moon' ? 'luna' : body.type] || 4;
    const slots = Math.max(2, slotsBase + rng.int(-1, 1));

    // Capacità popolazione (0 se non abitabile).
    let popCap = BASE_POP_CAP[def.cat === 'moon' ? 'luna' : body.type] || 0;
    if (popCap > 0) popCap = Math.max(2, popCap + rng.int(-1, 2));

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
      settlingDuration: 60          // durata in Impulsi (sovrascritta dal preset all'init)
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
    colony.pop.classes.operai = Math.floor(popBase * 0.5);
    colony.pop.classes.tecnici = popBase - colony.pop.classes.operai;
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
     CALCOLI: produzione potenziale per Impulso (lettura, no avanzamento).
     Combina i tassi delle strutture con i potenziali del pianeta.
     Bonus pianeta base §8.1: +20% se isHomeBase.
     ------------------------------------------------------------------ */
  function structureOutput(colony, planet) {
    const out = { met: 0, en: 0, food: 0, water: 0, research: 0, scan: 0, popCap: 0, popGrowth: 0, exotic: 0 };
    const upkeep = { met: 0, en: 0, food: 0, water: 0 };
    if (!colony.colonized) return { rates: out, upkeep: upkeep, used: 0 };

    const S = root.ORION.structures;
    const ids = Object.keys(colony.structures);
    const pot = planet.potentials;
    let slotsUsed = 0;

    // mappa di moltiplicatori applicati dalle produttive (per id sorgente)
    const mods = {};
    for (let i = 0; i < ids.length; i++) {
      const def = S.get(ids[i]);
      if (!def || !def.modifiers) continue;
      const lvl = colony.structures[ids[i]].level || 1;
      const lscale = S.levelScale(lvl);
      Object.keys(def.modifiers).forEach(function (k) {
        mods[k] = (mods[k] || 0) + def.modifiers[k] * lscale;
      });
    }

    for (let i = 0; i < ids.length; i++) {
      const def = S.get(ids[i]);
      if (!def) continue;
      const ent = colony.structures[ids[i]];
      const lvl = ent.level || 1;
      const lscale = S.levelScale(lvl);
      slotsUsed += (def.slots || 1);

      Object.keys(def.rates || {}).forEach(function (k) {
        // i tassi "risorsa base" sono modulati dal potenziale del pianeta
        let base = def.rates[k] * lscale;
        if (k === 'met')   base *= pot.met / 60;
        if (k === 'en')    base *= pot.en  / 60;
        if (k === 'food')  base *= pot.food / 60;
        if (k === 'water') base *= pot.water / 60;
        // bonus pianeta base §8.1
        if (colony.isHomeBase) base *= 1.20;
        // modificatori da produttive (es. fonderia → +25% miniera)
        const modKey = def.id + '.rates.' + k;
        if (mods[modKey]) base *= (1 + mods[modKey]);
        out[k] = (out[k] || 0) + base;
      });

      Object.keys(def.upkeep || {}).forEach(function (k) {
        upkeep[k] = (upkeep[k] || 0) + def.upkeep[k] * lscale;
      });
    }
    return { rates: out, upkeep: upkeep, used: slotsUsed };
  }

  /* I "potenziali teorici" del pianeta a regime, indipendenti dalla
     colonia: utili per la scheda di colonizzazione (cosa offre il
     pianeta se sviluppato). Tassi/Impulso con miniera+pannello+impianto
     +fattoria a livello 1, senza bonus pianeta base. */
  function theoreticalOutput(planet) {
    const pot = planet.potentials;
    return {
      met:   +(4 * (pot.met   / 60)).toFixed(2),
      en:    +(4 * (pot.en    / 60)).toFixed(2),
      food:  +(4 * (pot.food  / 60)).toFixed(2),
      water: +(4 * (pot.water / 60)).toFixed(2)
    };
  }

  /* Verifica prerequisiti di una struttura sulla colonia. */
  function canBuild(colony, planet, structId) {
    const def = root.ORION.structures.get(structId);
    if (!def) return { ok: false, reason: 'Struttura sconosciuta' };
    // tipo di corpo compatibile
    const types = def.bodyTypes;
    if (types && types.indexOf(planet.type) < 0) return { ok: false, reason: 'Non costruibile su ' + planet.type };
    // già costruita (M04: niente upgrade-in-coda multiplo; max una istanza
    // per id, gli upgrade si fanno tramite livelli — gestione M05)
    if (colony.structures[structId]) return { ok: false, reason: 'Già costruita (upgrade in M05)' };
    // slot disponibili
    const used = Object.keys(colony.structures).reduce(function (a, id) {
      const d = root.ORION.structures.get(id);
      return a + ((d && d.slots) || 1);
    }, 0);
    const inQueue = colony.queue.reduce(function (a, q) {
      const d = root.ORION.structures.get(q.id);
      return a + ((d && d.slots) || 1);
    }, 0);
    if (used + inQueue + (def.slots || 1) > planet.slots) return { ok: false, reason: 'Slot insufficienti' };
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
        // gancio M13: per ora consideriamo non disponibile.
        return { ok: false, reason: 'Richiede tecnologia (M13)' };
      }
    }
    // risorse
    const cost = def.cost || {};
    const keys = Object.keys(cost);
    for (let i = 0; i < keys.length; i++) {
      if ((colony.stock[keys[i]] || 0) < cost[keys[i]]) {
        return { ok: false, reason: 'Risorse insufficienti (' + keys[i] + ')' };
      }
    }
    return { ok: true };
  }

  /* Avvia una costruzione: sottrae il costo dallo stock e mette in coda.
     L'avanzamento del timer e il completamento sono M05. */
  function startBuild(colony, planet, structId, startedAtDS) {
    const check = canBuild(colony, planet, structId);
    if (!check.ok) return check;
    const def = root.ORION.structures.get(structId);
    const cost = def.cost || {};
    Object.keys(cost).forEach(function (k) { colony.stock[k] = (colony.stock[k] || 0) - cost[k]; });
    colony.queue.push({
      id: structId,
      target: 'build',
      startedAt: startedAtDS || null,
      duration: def.time
    });
    return { ok: true };
  }

  /* Annulla una voce in coda (rimborsa l'80% del costo, decisione locale). */
  function cancelBuild(colony, index) {
    if (index < 0 || index >= colony.queue.length) return { ok: false };
    const q = colony.queue.splice(index, 1)[0];
    const def = root.ORION.structures.get(q.id);
    if (def && def.cost) {
      Object.keys(def.cost).forEach(function (k) {
        colony.stock[k] = (colony.stock[k] || 0) + Math.floor(def.cost[k] * 0.8);
      });
    }
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

  root.ORION = root.ORION || {};
  root.ORION.planet = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    ADVANCED: ADVANCED,
    BASE_POTENTIAL: BASE_POTENTIAL,
    generate: generate,
    createColony: createColony,
    colonizeHome: colonizeHome,
    startSettling: startSettling,
    structureOutput: structureOutput,
    theoreticalOutput: theoreticalOutput,
    canBuild: canBuild,
    startBuild: startBuild,
    cancelBuild: cancelBuild,
    applyScan: applyScan
  };
})(typeof window !== 'undefined' ? window : this);
