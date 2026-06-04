/* =====================================================================
   ORION EMPIRES — time.js
   Modulo M05: TEMPO E AVANZAMENTO (GDD §4).

   Cuore del game loop: l'Impulso (I) è l'unità atomica del tempo. Tutto
   ciò che il GDD descrive come "tasso per Impulso" o "durata in Impulsi"
   viene processato qui.

   ORION.time esposto:
     - advance(impulsi)            avanza N Impulsi, processa code/produzione
     - advanceToNextEvent()        salta al prossimo evento notevole
     - tick(game)                  un singolo Impulso (esposto per test)
     - format(absImpulsi)          formatta in "DS <orbita>.<impulsi>"
     - currentDS(game)             Data Stellare corrente del game

   Determinismo / idempotenza:
     - Nessun RNG dipendente da Math.random nel loop. Se servisse stocastica
       (M07/M10), il seed sarà `game.seed + ':tick:' + game.timeImpulsi`.
     - Lo stato è interamente nel delta (game.timeImpulsi, colony.*):
       passare N Impulsi una volta è equivalente a passarne N (per ora,
       senza eventi narrativi e senza AI — M10/M17).

   Filosofia di bilanciamento (decisione M05):
     - La scarsità (§7.4) è SEMPRE recuperabile. Niente fail-state qui:
       solo frizione che svanisce appena il giocatore reagisce.
     - Una crisi non lascia "marchi permanenti": stato ripristinato dopo
       3 Impulsi di rete positiva.
     - La pop può scendere solo per fame/sete prolungata, e lentamente
       (1 unità ogni 30 I), così c'è sempre tempo di reagire.
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  /* --- Costanti di bilanciamento (centralizzate per future tarature) --- */
  const CFG = {
    /* Scarsità §7.4 — frizione graduale, mai game-over */
    SCARCITY_LOW_STOCK: 20,     // soglia "allerta" se netto negativo
    PROD_MALUS_LOW:   0.10,     // −10% produzione globale in allerta
    PROD_MALUS_CRIT:  0.30,     // −30% in critico (stock=0, netto<0)
    RECOVERY_IMPULSI: 3,        // I di netto positivo per uscire dallo stato

    /* Popolazione §9.3 */
    POP_GROWTH_BASE: 0.018,     // unità pop / Impulso a morale 1, no malus
    POP_MORALE_HOMEBASE: 0.15,  // +morale pianeta base §8.1
    POP_MORALE_HABITATION: 0.05,// +morale per centro abitativo
    POP_MORALE_MAX: 1.35,
    POP_GROWTH_HOSPITAL: 0.6,   // moltiplicatore se ospedale presente
    POP_FAMINE_AFTER: 30,       // I di carestia/sete prima del decremento
    POP_FAMINE_RATE: 30,        // 1 unità ogni N I sotto carestia
    POP_CLASS_SHIFT: 0.015,     // velocità riallineamento mix classi/Impulso

    /* Osservatorio §7.3 */
    SCAN_OBSERVATION_I: 10,     // I di osservazione dopo completamento

    /* "Prossimo evento" */
    NEXT_EVENT_FALLBACK: 10,    // I se non c'è nessun evento pianificato
    NEXT_EVENT_HARD_CAP: 500    // safety
  };

  /* Vettori di bias di classe per struttura (M05): le costruzioni
     orientano gradualmente il mix della popolazione (§9.3). */
  const CLASS_BIAS = {
    'miniera':           { operai: 2 },
    'centrale-solare':   { tecnici: 1, operai: 1 },
    'impianto-idrico':   { tecnici: 1, operai: 1 },
    'fattoria':          { operai: 2 },
    'fonderia':          { tecnici: 2, operai: 1 },
    'raffineria':        { tecnici: 2 },
    'laboratorio':       { scienziati: 3 },
    'osservatorio':      { scienziati: 2 },
    'cantiere-navale':   { militari: 2, operai: 1 },
    'accademia-militare':{ militari: 3 },
    'centro-abitativo':  { operai: 1, tecnici: 1, mercanti: 1 },
    'ospedale':          { scienziati: 1, tecnici: 1 },
    'mercato':           { mercanti: 3 },
    'impianto-esotico':  { scienziati: 2, tecnici: 1 }
  };

  /* --- Helpers --- */
  function format(absImp) {
    const orb = Math.floor(absImp / 100);
    const rem = absImp - orb * 100;
    const s = rem < 10 ? '0' + rem : '' + rem;
    return 'DS ' + orb + '.' + s;
  }

  function currentDS(game) {
    if (!game) return 'DS —';
    const base = (game.startEpochOrbita || 0) * 100;
    return format(base + (game.timeImpulsi || 0));
  }

  /* Stato di scarsità di default (idempotente, creato lazy). */
  function ensureScarcity(colony) {
    if (!colony._scar) {
      colony._scar = {
        met:   { state: 'ok', recover: 0 },
        en:    { state: 'ok', recover: 0 },
        food:  { state: 'ok', recover: 0 },
        water: { state: 'ok', recover: 0 },
        famineI: 0,    // I consecutivi di cibo/acqua a zero
        announced: {}  // {state: true} per evitare spam in cronaca
      };
    }
    return colony._scar;
  }

  function ensureGrowth(colony) {
    if (colony.pop.accum == null) colony.pop.accum = 0;
    return colony.pop;
  }

  /* Calcola il malus globale di produzione in base alla scarsità.
     Restituisce un fattore moltiplicativo (1.0 = nessun malus). */
  function scarcityMalus(scar) {
    let worst = 0;
    ['met', 'en', 'food', 'water'].forEach(function (k) {
      const s = scar[k].state;
      if (s === 'crit' && worst < 2) worst = 2;
      else if (s === 'low' && worst < 1) worst = 1;
    });
    if (worst === 2) return 1 - CFG.PROD_MALUS_CRIT;
    if (worst === 1) return 1 - CFG.PROD_MALUS_LOW;
    return 1;
  }

  /* ==================================================================
     SOTTOFASI DEL TICK (una colonia, un Impulso)
     ================================================================== */

  /* 1) Coda di costruzione: decrementa duration, completa quelle a 0. */
  function processQueue(game, colony, planet, events) {
    if (!colony.queue || !colony.queue.length) return;
    const stillQueued = [];
    for (let i = 0; i < colony.queue.length; i++) {
      const q = colony.queue[i];
      q.duration = (q.duration || 0) - 1;
      if (q.duration <= 0) {
        // Completa la struttura (oppure upgrade futuro M13)
        const def = root.ORION.structures.get(q.id);
        if (!def) continue;
        colony.structures[q.id] = colony.structures[q.id] || { level: 0, hp: 100 };
        colony.structures[q.id].level = (colony.structures[q.id].level || 0) + 1;
        // Osservatorio: avvia la finestra di osservazione (M05)
        if (q.id === 'osservatorio' && !colony.scanned.active) {
          colony.scanned.progress = 0;
        }
        events.push({
          kind: 'build-done',
          colony: colony, planet: planet,
          structId: q.id, structName: def.name,
          impulso: game.timeImpulsi
        });
      } else {
        stillQueued.push(q);
      }
    }
    colony.queue = stillQueued;
  }

  /* 2) Colonizzazione in corso (per pianeti non natali) */
  function processColonizing(game, colony, planet, events) {
    if (!colony.colonizing) return;
    colony.colonizing.duration = (colony.colonizing.duration || 0) - 1;
    if (colony.colonizing.duration <= 0) {
      colony.colonized = true;
      colony.colonizedDS = currentDS(game);
      colony.pop.total = Math.max(1, Math.round(planet.popCap * 0.15));
      colony.pop.classes.operai = colony.pop.total;
      colony.stock = { met: 40, en: 30, food: 20, water: 20 };
      colony.colonizing = null;
      events.push({
        kind: 'colony-done',
        colony: colony, planet: planet,
        impulso: game.timeImpulsi
      });
    }
  }

  /* 3) Produzione/consumo per Impulso con malus di scarsità. */
  function processProduction(colony, planet, scar) {
    if (!colony.colonized) return null;
    const out = root.ORION.planet.structureOutput(colony, planet);
    const malus = scarcityMalus(scar);
    const stock = colony.stock;
    const net = {};
    ['met', 'en', 'food', 'water'].forEach(function (k) {
      const r = (out.rates[k] || 0) * malus;
      const u = out.upkeep[k] || 0;
      net[k] = r - u;
      stock[k] = (stock[k] || 0) + net[k];
      if (stock[k] < 0) stock[k] = 0;     // i negativi diventano "carestia"
    });
    // Ricerca/exotic si accumulano in campi gancio (M13).
    if (out.rates.research) {
      colony.researchAccum = (colony.researchAccum || 0) + out.rates.research * malus;
    }
    if (out.rates.exotic) {
      colony.exoticAccum = (colony.exoticAccum || 0) + out.rates.exotic * malus;
    }
    // popCap dinamica da centri abitativi
    if (out.rates.popCap) {
      colony.pop.cap = planet.popCap + Math.round(out.rates.popCap);
    } else {
      colony.pop.cap = planet.popCap;
    }
    return { net: net, rates: out.rates, upkeep: out.upkeep, malus: malus };
  }

  /* 4) Aggiorna stato di scarsità per ogni risorsa base.
     Recovery automatico dopo N Impulsi di rete positiva. */
  function processScarcity(game, colony, planet, prod, events) {
    if (!prod) return;
    const scar = ensureScarcity(colony);
    const stock = colony.stock;
    const net = prod.net;
    ['met', 'en', 'food', 'water'].forEach(function (k) {
      const cur = scar[k];
      const s = stock[k];
      const n = net[k];
      // Crit: stock a 0 e ancora in negativo
      if (s <= 0 && n < 0) {
        if (cur.state !== 'crit') {
          cur.state = 'crit';
          cur.recover = 0;
          if (!scar.announced['crit:' + k]) {
            scar.announced['crit:' + k] = true;
            events.push({
              kind: 'scarcity', sev: 'crit', res: k,
              colony: colony, planet: planet, impulso: game.timeImpulsi
            });
          }
        }
      } else if (s <= CFG.SCARCITY_LOW_STOCK && n < 0) {
        if (cur.state === 'ok') {
          cur.state = 'low';
          cur.recover = 0;
          if (!scar.announced['low:' + k]) {
            scar.announced['low:' + k] = true;
            events.push({
              kind: 'scarcity', sev: 'low', res: k,
              colony: colony, planet: planet, impulso: game.timeImpulsi
            });
          }
        }
      }
      // Recovery: netto positivo per N I → torno a OK
      if (cur.state !== 'ok' && n >= 0) {
        cur.recover++;
        if (cur.recover >= CFG.RECOVERY_IMPULSI) {
          const prevState = cur.state;
          cur.state = 'ok';
          cur.recover = 0;
          // permetto un nuovo annuncio se ricade, ma non ne genero qui
          delete scar.announced['low:' + k];
          delete scar.announced['crit:' + k];
          events.push({
            kind: 'scarcity-recover', from: prevState, res: k,
            colony: colony, planet: planet, impulso: game.timeImpulsi
          });
        }
      } else if (n < 0) {
        cur.recover = 0;
      }
    });
    // Contatore di carestia (cibo o acqua a 0 con netto neg)
    const famish = (stock.food <= 0 && net.food < 0) || (stock.water <= 0 && net.water < 0);
    scar.famineI = famish ? scar.famineI + 1 : 0;
  }

  /* 5) Crescita popolazione §9.3. Recovery-friendly:
        - cresce solo con cibo+acqua disponibili
        - decremento SOLO dopo carestia prolungata (>= POP_FAMINE_AFTER I)
          e a ritmo lento (1 unità ogni POP_FAMINE_RATE I) */
  function processPopulation(game, colony, planet, prod, events) {
    if (!colony.colonized || !prod) return;
    const pop = ensureGrowth(colony);
    const scar = ensureScarcity(colony);

    // Decremento da carestia prolungata
    if (scar.famineI >= CFG.POP_FAMINE_AFTER) {
      const overflow = scar.famineI - CFG.POP_FAMINE_AFTER;
      if (overflow > 0 && (overflow % CFG.POP_FAMINE_RATE) === 0 && pop.total > 1) {
        pop.total--;
        // togli dalle classi proporzionalmente (dalla più numerosa)
        let maxK = null, maxV = -1;
        Object.keys(pop.classes).forEach(function (k) {
          if (pop.classes[k] > maxV) { maxV = pop.classes[k]; maxK = k; }
        });
        if (maxK) pop.classes[maxK] = Math.max(0, pop.classes[maxK] - 1);
        events.push({
          kind: 'pop-loss', colony: colony, planet: planet, impulso: game.timeImpulsi
        });
      }
    }

    // Crescita: serve cibo&acqua presenti, non in critico
    const canGrow = scar.food.state !== 'crit' && scar.water.state !== 'crit'
                 && colony.stock.food > 0 && colony.stock.water > 0
                 && pop.total < pop.cap;
    if (canGrow) {
      // morale: base + homebase + centri abitativi, capped
      let morale = 1.0;
      if (colony.isHomeBase) morale += CFG.POP_MORALE_HOMEBASE;
      const habit = (colony.structures['centro-abitativo'] && colony.structures['centro-abitativo'].level) || 0;
      morale += Math.min(CFG.POP_MORALE_MAX - 1.0, habit * CFG.POP_MORALE_HABITATION);
      if (morale > CFG.POP_MORALE_MAX) morale = CFG.POP_MORALE_MAX;
      // penalità "allerta" su cibo/acqua
      if (scar.food.state === 'low' || scar.water.state === 'low') morale *= 0.6;

      let growth = CFG.POP_GROWTH_BASE * morale;
      if (colony.structures['ospedale']) growth *= (1 + CFG.POP_GROWTH_HOSPITAL);
      pop.accum += growth;
      while (pop.accum >= 1 && pop.total < pop.cap) {
        pop.total++;
        pop.accum -= 1;
        // nuovo individuo va nella classe più piccola con bias dalle strutture
        addToBestClass(colony);
      }
    }

    // Shift lento del mix di classi verso il "target" suggerito dalle
    // strutture costruite. Non sposta più di POP_CLASS_SHIFT/Impulso.
    shiftClassMix(colony);
  }

  function targetClassWeights(colony) {
    const w = { operai: 1, scienziati: 0, militari: 0, mercanti: 0, tecnici: 0 };
    Object.keys(colony.structures).forEach(function (id) {
      const bias = CLASS_BIAS[id];
      if (!bias) return;
      const lvl = (colony.structures[id].level || 1);
      Object.keys(bias).forEach(function (k) {
        w[k] = (w[k] || 0) + bias[k] * lvl;
      });
    });
    return w;
  }

  function addToBestClass(colony) {
    const target = targetClassWeights(colony);
    // sceglie la classe in cui c'è il "deficit" più grande rispetto al target
    const total = Math.max(1, colony.pop.total);
    let totalW = 0;
    Object.keys(target).forEach(function (k) { totalW += target[k]; });
    if (totalW <= 0) { colony.pop.classes.operai++; return; }
    let bestK = 'operai', bestGap = -Infinity;
    Object.keys(target).forEach(function (k) {
      const want = (target[k] / totalW) * total;
      const have = colony.pop.classes[k] || 0;
      const gap = want - have;
      if (gap > bestGap) { bestGap = gap; bestK = k; }
    });
    colony.pop.classes[bestK] = (colony.pop.classes[bestK] || 0) + 1;
  }

  function shiftClassMix(colony) {
    const target = targetClassWeights(colony);
    let totalW = 0;
    Object.keys(target).forEach(function (k) { totalW += target[k]; });
    if (totalW <= 0 || colony.pop.total <= 0) return;
    const total = colony.pop.total;
    // trova la classe più "in eccesso" e quella più "in difetto"
    let overK = null, overGap = 0, underK = null, underGap = 0;
    Object.keys(target).forEach(function (k) {
      const want = (target[k] / totalW) * total;
      const have = colony.pop.classes[k] || 0;
      const gap = have - want;
      if (gap > overGap) { overGap = gap; overK = k; }
      if (-gap > underGap) { underGap = -gap; underK = k; }
    });
    if (!overK || !underK || overK === underK) return;
    // sposta una frazione (lentamente)
    const move = Math.min(overGap, underGap) * CFG.POP_CLASS_SHIFT;
    // accumulatore per spostamenti frazionari
    colony._classAccum = colony._classAccum || {};
    const key = overK + '>' + underK;
    colony._classAccum[key] = (colony._classAccum[key] || 0) + move;
    if (colony._classAccum[key] >= 1) {
      const n = Math.floor(colony._classAccum[key]);
      colony._classAccum[key] -= n;
      const moved = Math.min(n, colony.pop.classes[overK] || 0);
      colony.pop.classes[overK] -= moved;
      colony.pop.classes[underK] = (colony.pop.classes[underK] || 0) + moved;
    }
  }

  /* 6) Osservatorio: avanza scansione, sblocca avanzate al traguardo. */
  function processObservatory(game, colony, planet, events) {
    const obs = colony.structures['osservatorio'];
    if (!obs || colony.scanned.active) return;
    colony.scanned.progress = (colony.scanned.progress || 0) + 1 * (obs.level || 1);
    if (colony.scanned.progress >= CFG.SCAN_OBSERVATION_I) {
      root.ORION.planet.applyScan(colony, planet);
      events.push({
        kind: 'scan-done', colony: colony, planet: planet, impulso: game.timeImpulsi
      });
    }
  }

  /* ==================================================================
     TICK & ADVANCE
     ================================================================== */

  function tick(game, events) {
    game.timeImpulsi = (game.timeImpulsi || 0) + 1;
    const colonies = game.colonies || {};
    const keys = Object.keys(colonies);
    for (let i = 0; i < keys.length; i++) {
      const colony = colonies[keys[i]];
      if (!colony) continue;
      const parts = keys[i].split(':');
      const sysId = Number(parts[0]);
      const bodyKey = parts[1];
      const system = root.ORION.system.generate(game.galaxy, sysId);
      const planet = root.ORION.planet.generate(game.galaxy, system, bodyKey);
      if (!planet) continue;

      processColonizing(game, colony, planet, events);
      processQueue(game, colony, planet, events);
      if (!colony.colonized) continue;

      const scar = ensureScarcity(colony);
      const prod = processProduction(colony, planet, scar);
      processScarcity(game, colony, planet, prod, events);
      processPopulation(game, colony, planet, prod, events);
      processObservatory(game, colony, planet, events);
    }
  }

  /* Avanza N Impulsi raccogliendo gli eventi notevoli. Lo "snap" visuale
     a fine batch è gestito dal chiamante (main.js → refreshHud). */
  function advance(impulsi) {
    const game = ORION.game;
    if (!game) return { events: [], impulsi: 0 };
    impulsi = Math.max(0, Math.floor(impulsi || 0));
    const events = [];
    for (let i = 0; i < impulsi; i++) {
      tick(game, events);
    }
    return { events: events, impulsi: impulsi };
  }

  /* Trova il prossimo Impulso "interessante": minimo dei timer attivi. */
  function nextEventImpulsi(game) {
    if (!game || !game.colonies) return CFG.NEXT_EVENT_FALLBACK;
    let best = Infinity;
    Object.keys(game.colonies).forEach(function (k) {
      const c = game.colonies[k];
      if (!c) return;
      // costruzioni in coda
      if (c.queue && c.queue.length) {
        for (let i = 0; i < c.queue.length; i++) {
          const d = c.queue[i].duration || 0;
          if (d > 0 && d < best) best = d;
        }
      }
      // colonizzazione in corso
      if (c.colonizing && c.colonizing.duration > 0 && c.colonizing.duration < best) {
        best = c.colonizing.duration;
      }
      // osservatorio in scansione
      if (c.structures && c.structures['osservatorio'] && !c.scanned.active) {
        const lvl = c.structures['osservatorio'].level || 1;
        const rem = Math.ceil((CFG.SCAN_OBSERVATION_I - (c.scanned.progress || 0)) / lvl);
        if (rem > 0 && rem < best) best = rem;
      }
    });
    if (!isFinite(best)) return CFG.NEXT_EVENT_FALLBACK;
    return Math.min(CFG.NEXT_EVENT_HARD_CAP, Math.max(1, best));
  }

  function advanceToNextEvent() {
    const game = ORION.game;
    if (!game) return { events: [], impulsi: 0 };
    return advance(nextEventImpulsi(game));
  }

  ORION.time = {
    CFG: CFG,
    CLASS_BIAS: CLASS_BIAS,
    format: format,
    currentDS: currentDS,
    tick: tick,
    advance: advance,
    advanceToNextEvent: advanceToNextEvent,
    nextEventImpulsi: nextEventImpulsi,
    targetClassWeights: targetClassWeights,
    ensureScarcity: ensureScarcity
  };
})(typeof window !== 'undefined' ? window : this);
