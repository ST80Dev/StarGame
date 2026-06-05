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
     - format(absImpulsi, mode)    formatta nel "Calendario del Faro" (#30):
                                     mode 'full'     → "Ω1·Φ87·Κ6·Ι47"
                                     mode 'compact'  → "1·87·6·47" (default)
                                     mode 'duration' → "2Κ·20Ι" (omette zeri di testa)
     - currentDS(game)             Data Stellare corrente del game (compatta)
     - currentDSFull(game)         versione estesa con sigle greche

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
    POP_GROWTH_BASE: 0.007,     // unità pop / Impulso a morale 1, no malus (decisione #37: crescita lenta, di lungo periodo)
    POP_MORALE_HOMEBASE: 0.15,  // +morale pianeta base §8.1
    POP_MORALE_HABITATION: 0.05,// +morale per centro abitativo
    POP_MORALE_MAX: 1.35,
    POP_GROWTH_HOSPITAL: 0.6,   // moltiplicatore se ospedale presente
    POP_FAMINE_AFTER: 30,       // I di carestia/sete prima del decremento
    POP_FAMINE_RATE: 30,        // 1 unità ogni N I sotto carestia
    POP_CLASS_SHIFT: 0.015,     // velocità riallineamento mix classi/Impulso

    /* Capacità di carico §9.3 (decisione #37) — consumo pro-capite + plateau.
       La popolazione consuma cibo/acqua per unità: la crescita si ferma in
       PLATEAU quando la produzione LOCALE eguaglia il consumo, SENZA carestia
       (il netto resta ≈0, lo stock stabile). Per superare il plateau servono
       più fattorie/impianti idrici o — per i mondi più capienti — import via
       rotte commerciali (M12). Contabilità per-colonia (emenda decisione #35).
       Il consumo si applica solo in fase `operational` (non durante settling). */
    POP_FOOD_PER_UNIT:  2.5,    // cibo consumato per unità di pop / Impulso (decisione #38: ritarato sul modello a moduli)
    POP_WATER_PER_UNIT: 2.0,    // acqua consumata per unità di pop / Impulso
    POP_SUPPLY_REF:     3,      // surplus locale che dà crescita a velocità piena
    POP_LEVEL_COST:     0.6,    // freno temporale: ogni livello costa 1+0.6·(pop−1) accumulo

    /* Cancelli strutturali impliciti (decisione #37bis): oltre la "capacità
       abitativa" della colonia il sovraffollamento abbatte la morale → la
       crescita si ferma in plateau. Non c'è alcun avviso esplicito: il
       giocatore vede la morale calare mentre la città cresce e deduce che
       serve sviluppare l'habitat (centro abitativo, ospedale, e in futuro
       strutture tech M13). Le risorse decidono un tetto, l'habitat un altro:
       cresce solo chi soddisfa entrambi. Numeri qui, mai mostrati in UI. */
    POP_HOUSING_BASE:      3.0,   // unità sostenibili dall'insediamento nudo
    POP_HOUSING_PER_LEVEL: 4.5,   // capacità abitativa per resa-cumulata moduli centro abitativo
    POP_HOSPITAL_HOUSING:  3.0,   // capacità extra per resa-cumulata moduli ospedale (densità/sanità)
    POP_CROWD_START:       0.8,   // rapporto pop/capacità oltre cui inizia il malus
    POP_CROWD_SLOPE:       2.5,   // ripidità del crollo morale da sovraffollamento

    /* Osservatorio §7.3 */
    SCAN_OBSERVATION_I: 10,     // I di osservazione dopo completamento

    /* "Prossimo evento" */
    NEXT_EVENT_FALLBACK: 10,    // I se non c'è nessun evento pianificato
    NEXT_EVENT_HARD_CAP: 500,   // safety

    /* Multi-pista vittoria (decisione #23): il victoryCheck è costoso →
       lo chiamiamo ogni N Impulsi, non a ogni tick. L'hook esiste anche
       senza M20 così il loop non va rifattorizzato dopo. */
    VICTORY_CHECK_EVERY_I: 5
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

  /* --- Helpers ---
     CALENDARIO DEL FARO (decisione #30 — sostituisce "DS <orb>.<imp>" di M05).
     Quattro unità ancorate alla pulsar di Orion:
       Ι (iota)  = Impulso (battito)     — atomica
       Κ (kappa) = Ciclo di nutazione    = 50 Ι
       Φ (phi)   = Fase di precessione   = 20 Κ = 1000 Ι
       Ω (omega) = Eone (grande risonanza) = 100 Φ = 100 000 Ι
     I rapporti irregolari (50:20:100) sono *intenzionalmente* non potenze
     di 10: l'occhio non collassa più i campi a un decimale e ogni unità
     "conta" davvero (vedi discussione di sessione → CLAUDE.md decisione #30).

     Retro-compatibilità con il delta serializzato (schema 4): manteniamo
     il campo `startEpochOrbita` come SEME NUMERICO dell'epoca d'inizio
     — vecchia semantica "Orbita = 100 I": startEpochOrbita * 100 = absI(0).
     Niente bump di schema, save esistenti restano compatibili. */
  const I_PER_K = 50;
  const K_PER_PHI = 20;
  const PHI_PER_OMEGA = 100;
  const I_PER_PHI = I_PER_K * K_PER_PHI;          // 1000
  const I_PER_OMEGA = I_PER_PHI * PHI_PER_OMEGA;  // 100 000

  function splitFaro(absI) {
    absI = Math.max(0, Math.floor(absI || 0));
    const omega = Math.floor(absI / I_PER_OMEGA); absI -= omega * I_PER_OMEGA;
    const phi   = Math.floor(absI / I_PER_PHI);   absI -= phi * I_PER_PHI;
    const kappa = Math.floor(absI / I_PER_K);     absI -= kappa * I_PER_K;
    return { O: omega, F: phi, K: kappa, I: absI };
  }

  /* Formato configurabile: 'full' / 'compact' (default) / 'duration'. */
  function format(absImp, mode) {
    const p = splitFaro(absImp);
    mode = mode || 'compact';
    if (mode === 'full') {
      return 'Ω' + p.O + '·Φ' + p.F + '·Κ' + p.K + '·Ι' + p.I;
    }
    if (mode === 'duration') {
      /* Per le durate: omettiamo gli zeri di testa, mostriamo solo i campi
         significativi. Sempre almeno Ι (anche se 0). Esempi:
            14   → "14Ι"
            60   → "1Κ·10Ι"
            120  → "2Κ·20Ι"
            1200 → "1Φ·4Κ"  (Ι=0 omesso se ci sono unità superiori non-zero)
            100000 → "1Ω"   (tutto il resto a zero) */
      const parts = [];
      if (p.O) parts.push('Ω' + p.O);
      if (p.F) parts.push('Φ' + p.F);
      if (p.K) parts.push('Κ' + p.K);
      if (p.I || parts.length === 0) parts.push('Ι' + p.I);
      return parts.join('·');
    }
    /* compact: "1·87·6·47" — sigla in testa per disambiguare. */
    return p.O + '·' + p.F + '·' + p.K + '·' + p.I;
  }

  function currentDS(game) {
    if (!game) return '—';
    const base = (game.startEpochOrbita || 0) * 100;
    return format(base + (game.timeImpulsi || 0), 'compact');
  }
  function currentDSFull(game) {
    if (!game) return '—';
    const base = (game.startEpochOrbita || 0) * 100;
    return format(base + (game.timeImpulsi || 0), 'full');
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
    /* M06.5 (decisione #27): durante l'Insediamento la PRIMA entry in
       coda matura il 50% più in fretta (bonus "moduli avanguardia"
       della fondazione). Decremento 1.5 invece di 1.0 sulla prima. */
    const settling = (colony.phase === 'settling');
    const stillQueued = [];
    for (let i = 0; i < colony.queue.length; i++) {
      const q = colony.queue[i];
      const dec = (settling && i === 0) ? 1.5 : 1;
      q.duration = (q.duration || 0) - dec;
      if (q.duration <= 0) {
        const def = root.ORION.structures.get(q.id);
        if (!def) continue;
        if (q.target === 'demolish') {
          /* Smantellamento completato (decisione recovery-friendly):
             - rimuove la struttura,
             - rimborsa il 50% del costo originale (70% sulla natale: il
               cantiere principale ha infrastruttura di smontaggio migliore),
             - applica un malus morale -0.10 con decadimento lineare su
               30 Ι (gestito in processPopulation). Mai fail-state.
             Se l'osservatorio smontato era l'origine della scansione,
             interrompe la scansione in corso (riavviabile ricostruendo). */
          delete colony.structures[q.id];
          const refundRate = colony.isHomeBase ? 0.7 : 0.5;
          if (def.cost) {
            Object.keys(def.cost).forEach(function (k) {
              colony.stock[k] = (colony.stock[k] || 0) + Math.floor(def.cost[k] * refundRate);
            });
          }
          colony.moraleMalus = {
            amount: 0.10,
            startedAt: game.timeImpulsi,
            expiresAt: game.timeImpulsi + 30
          };
          if (q.id === 'osservatorio' && !colony.scanned.active) {
            colony.scanned.progress = 0;
          }
          events.push({
            kind: 'demolish-done',
            colony: colony, planet: planet,
            structId: q.id, structName: def.name,
            refundRate: refundRate,
            impulso: game.timeImpulsi
          });
        } else {
          // Completa la struttura (oppure upgrade futuro M13)
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
        }
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
      // Ogni nuova colonia nasce con un seme di 1 unità (≈ 50 coloni nel
      // display §9). In futuro (migrazione, M07+) si potrà seminare di più
      // spostando popolazione da una colonia sorgente — l'engine accetta
      // qualsiasi pop.total senza ribilanciare (la pop non guida i calcoli).
      colony.pop.total = 1;
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

  /* 3) Produzione/consumo per Impulso con malus di scarsità.
        M06.5 (decisione #27): durante `settling` la produzione è al 50%
        ("atterraggio, scarico moduli"). Recovery-friendly: finisce sola. */
  function processProduction(colony, planet, scar) {
    if (!colony.colonized) return null;
    const out = root.ORION.planet.structureOutput(colony, planet);
    const malus = scarcityMalus(scar);
    const settling = (colony.phase === 'settling') ? 0.5 : 1.0;
    const stock = colony.stock;
    const net = {};
    ['met', 'en', 'food', 'water'].forEach(function (k) {
      const r = (out.rates[k] || 0) * malus * settling;
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
    /* M06.5 (decisione #27): durante l'Insediamento la pop è bloccata.
       Niente crescita, niente decremento (il famine timer non scatta
       perché stock parte sopra zero e settling dura poco). Esce dopo
       settlingDuration Impulsi. */
    if (colony.phase === 'settling') return;
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
      // malus temporaneo da smantellamento: decadimento lineare su 30 Ι
      if (colony.moraleMalus) {
        const mm = colony.moraleMalus;
        if (game.timeImpulsi >= mm.expiresAt) {
          colony.moraleMalus = null;
        } else {
          const span = mm.expiresAt - mm.startedAt;
          const left = mm.expiresAt - game.timeImpulsi;
          morale -= mm.amount * (left / span);
          if (morale < 0.2) morale = 0.2;
        }
      }
      // penalità "allerta" su cibo/acqua
      if (scar.food.state === 'low' || scar.water.state === 'low') morale *= 0.6;

      /* Sovraffollamento (cancello strutturale implicito, decisione #37bis):
         oltre la capacità abitativa la morale crolla → crescita in plateau.
         Il giocatore lo deduce vedendo la morale calare; si rialza sviluppando
         l'habitat (centro abitativo, ospedale, future strutture M13). */
      const hosp = (colony.structures['ospedale'] && colony.structures['ospedale'].level) || 0;
      const Sm = root.ORION.structures;
      const housingCap = CFG.POP_HOUSING_BASE
        + (habit > 0 ? Sm.moduleSum(habit) : 0) * CFG.POP_HOUSING_PER_LEVEL
        + (hosp > 0 ? Sm.moduleSum(hosp) : 0) * CFG.POP_HOSPITAL_HOUSING;
      const crowd = housingCap > 0 ? pop.total / housingCap : 99;
      if (crowd > CFG.POP_CROWD_START) {
        morale *= Math.max(0.05, 1 - (crowd - CFG.POP_CROWD_START) * CFG.POP_CROWD_SLOPE);
      }

      let growth = CFG.POP_GROWTH_BASE * morale;
      if (colony.structures['ospedale']) growth *= (1 + CFG.POP_GROWTH_HOSPITAL);

      /* Capacità di carico (decisione #37): il consumo pro-capite della
         popolazione è una RICHIESTA sulla produzione (non un drenaggio dello
         stock → niente carestia da popolazione). La crescita è alimentata dal
         SURPLUS = produzione locale − consumo (legge del minimo: vince il più
         scarso tra cibo e acqua). Quando il surplus → 0 la crescita → 0: la
         popolazione si stabilizza in PLATEAU senza mai carestia né "low". Per
         alzare il tetto: più fattorie/idrici o import via rotte (M12). */
      const foodSurplus  = (prod.net.food  || 0) - pop.total * CFG.POP_FOOD_PER_UNIT;
      const waterSurplus = (prod.net.water || 0) - pop.total * CFG.POP_WATER_PER_UNIT;
      const surplus = Math.min(foodSurplus, waterSurplus);
      const supplyFactor = surplus <= 0 ? 0 : Math.min(1, surplus / CFG.POP_SUPPLY_REF);

      growth *= supplyFactor;
      pop.accum += growth;
      /* Freno temporale (decisione #37): ogni livello costa più accumulo del
         precedente — `1 + POP_LEVEL_COST·(pop−1)`. Salire è progressivamente
         più lento anche con risorse abbondanti, ma NON impedisce di raggiungere
         la capacità di carico: la regola decide il *tempo*, le risorse il *dove*.
         Saturare il cap resta un obiettivo di lungo periodo (serve import). */
      let unitCost = 1 + CFG.POP_LEVEL_COST * (pop.total - 1);
      while (pop.accum >= unitCost && pop.total < pop.cap) {
        pop.total++;
        pop.accum -= unitCost;
        // nuovo individuo va nella classe più piccola con bias dalle strutture
        addToBestClass(colony);
        unitCost = 1 + CFG.POP_LEVEL_COST * (pop.total - 1);
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

  /* 6b) M07 — code asset (scafi Hangar / equipaggi Accademia).
        Decisione #37: counter scafi e array equipaggi separati dalla
        coda strutture; produzione 1/Ι (no malus scarsità — il loop le
        considera prodotti di "qualità", non risorse di flusso). */
  let _assetCounter = 0;
  function processAssets(game, colony, planet, events) {
    if (!colony.assets) return;
    /* Scafi */
    const sq = colony.assets.shipQueue;
    if (Array.isArray(sq) && sq.length) {
      const still = [];
      for (let i = 0; i < sq.length; i++) {
        const q = sq[i];
        q.duration = (q.duration || 0) - 1;
        if (q.duration <= 0) {
          colony.ships = colony.ships || { explorer: 0 };
          colony.ships.explorer = (colony.ships.explorer || 0) + 1;
          events.push({
            kind: 'ship-built',
            colony: colony, planet: planet,
            shipKind: q.kind || 'explorer',
            impulso: game.timeImpulsi
          });
        } else {
          still.push(q);
        }
      }
      colony.assets.shipQueue = still;
    }
    /* Equipaggi */
    const cq = colony.assets.crewQueue;
    if (Array.isArray(cq) && cq.length) {
      const still = [];
      for (let i = 0; i < cq.length; i++) {
        const q = cq[i];
        q.duration = (q.duration || 0) - 1;
        if (q.duration <= 0) {
          colony.crews = colony.crews || { explorer: [] };
          if (!Array.isArray(colony.crews.explorer)) colony.crews.explorer = [];
          _assetCounter++;
          colony.crews.explorer.push({
            id: 'crew-' + (game.timeImpulsi || 0) + '-' + _assetCounter,
            xp: 0
          });
          events.push({
            kind: 'crew-formed',
            colony: colony, planet: planet,
            crewKind: q.kind || 'explorer',
            impulso: game.timeImpulsi
          });
        } else {
          still.push(q);
        }
      }
      colony.assets.crewQueue = still;
    }
  }

  /* 6c) M07 — spedizioni in viaggio. Itera game.expeditions[], rimuove
        quelle 'done'. Gli eventi tipo expedition-* sono gestiti dal
        modulo expedition.js. */
  function processExpeditions(game, events) {
    if (!Array.isArray(game.expeditions) || !game.expeditions.length) return;
    if (!root.ORION.expedition || !root.ORION.expedition.tick) return;
    const still = [];
    for (let i = 0; i < game.expeditions.length; i++) {
      const exp = game.expeditions[i];
      root.ORION.expedition.tick(game, exp, events);
      if (exp.status !== 'done') still.push(exp);
    }
    game.expeditions = still;
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
      processAssets(game, colony, planet, events);
      processSettling(game, colony, planet, events);
    }
    /* M07: spedizioni in volo (1 tick per ogni Impulso). */
    processExpeditions(game, events);
    /* M07.1 (decisione #40): Governatore coloniale — Tier 1 "Vigile".
       Letture sullo stato già aggiornato del tick corrente; non agisce,
       emette solo eventi `gov-*` che la chronicle/auto-pause gestiscono
       come tutti gli altri. */
    if (root.ORION.governor && root.ORION.governor.tick) {
      root.ORION.governor.tick(game, events);
    }
  }

  /* M06.5 (decisione #27): scriptata della fase Insediamento.
     Voci di cronaca emerse ai tick 0/20/40/fine + transizione automatica
     a `operational`. Niente RNG: tutto deterministico.
     Recovery-friendly (decisione #22): la fase finisce SEMPRE da sola,
     non c'è azione utente che possa bloccarla. */
  function processSettling(game, colony, planet, events) {
    if (colony.phase !== 'settling') return;
    if (colony.settlingStart == null) return;
    const elapsed = game.timeImpulsi - colony.settlingStart;
    const dur = Math.max(1, colony.settlingDuration || 60);

    /* Voci scriptate a frazioni della durata (0%, ~33%, ~66%, 100%).
       Frazioni invece di tick fissi così le voci scalano coi preset
       (Speedrun 30 I, Incubo 90 I, Lungo respiro 120 I). */
    if (!colony._settlingMilestones) colony._settlingMilestones = {};
    const milestones = colony._settlingMilestones;
    const tick33 = Math.floor(dur * 0.33);
    const tick66 = Math.floor(dur * 0.66);

    if (elapsed === 1 && !milestones.start) {
      milestones.start = true;
      events.push({ kind: 'settle-stage', stage: 'landing',  colony: colony, planet: planet, impulso: game.timeImpulsi });
    }
    if (elapsed === tick33 && !milestones.mid1) {
      milestones.mid1 = true;
      events.push({ kind: 'settle-stage', stage: 'founding', colony: colony, planet: planet, impulso: game.timeImpulsi });
    }
    if (elapsed === tick66 && !milestones.mid2) {
      milestones.mid2 = true;
      events.push({ kind: 'settle-stage', stage: 'civic',    colony: colony, planet: planet, impulso: game.timeImpulsi });
    }
    if (elapsed >= dur) {
      colony.phase = 'operational';
      colony._settlingMilestones = null;
      events.push({ kind: 'settle-done', colony: colony, planet: planet, impulso: game.timeImpulsi });
    }
  }

  /* Multi-pista (decisione #23): chiama victory.check ogni N Impulsi,
     emette evento "victory" alla prima pista chiusa. */
  function maybeCheckVictory(game, events) {
    if (!root.ORION.victory) return false;
    if ((game.timeImpulsi % CFG.VICTORY_CHECK_EVERY_I) !== 0) return false;
    const results = root.ORION.victory.check(game);
    let won = null;
    for (let i = 0; i < results.length; i++) {
      if (results[i].won) { won = results[i]; break; }
    }
    if (won) {
      events.push({
        kind: 'victory',
        track: won.track,
        score: won.score,
        impulso: game.timeImpulsi
      });
      return true;
    }
    return false;
  }

  /* Avanza N Impulsi raccogliendo gli eventi notevoli. Lo "snap" visuale
     a fine batch è gestito dal chiamante (main.js → refreshHud).
     Decisione #23: applica `mode.modifiers.tsgSpeed` (×1/×2/×4): in M05
     ne moltiplichiamo solo il count di Impulsi processati (semantica
     "il tempo scorre più veloce a parità di click"). M20 rifinirà se
     servirà una semantica diversa (es. scalare i rates a parità di tick). */
  function advance(impulsi) {
    const game = ORION.game;
    if (!game) return { events: [], impulsi: 0 };
    impulsi = Math.max(0, Math.floor(impulsi || 0));
    const speed = (game.mode && game.mode.modifiers && game.mode.modifiers.tsgSpeed) || 1;
    const effective = impulsi * Math.max(1, speed | 0);
    const events = [];
    for (let i = 0; i < effective; i++) {
      tick(game, events);
      if (maybeCheckVictory(game, events)) break;   // stop alla prima pista chiusa
    }
    return { events: events, impulsi: effective };
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
      // M06.5: fase Insediamento in corso (decisione #27)
      if (c.phase === 'settling' && c.settlingStart != null) {
        const end = c.settlingStart + (c.settlingDuration || 60);
        const rem = end - (game.timeImpulsi || 0);
        if (rem > 0 && rem < best) best = rem;
      }
      // M07: scafi/equipaggi in costruzione
      if (c.assets) {
        const sq = c.assets.shipQueue || [];
        for (let i = 0; i < sq.length; i++) {
          const d = sq[i].duration || 0;
          if (d > 0 && d < best) best = d;
        }
        const cq = c.assets.crewQueue || [];
        for (let i = 0; i < cq.length; i++) {
          const d = cq[i].duration || 0;
          if (d > 0 && d < best) best = d;
        }
      }
    });
    /* M07: spedizioni in viaggio (outbound o returning) */
    if (Array.isArray(game.expeditions)) {
      for (let i = 0; i < game.expeditions.length; i++) {
        const e = game.expeditions[i];
        if (!e || e.status === 'done') continue;
        const d = (e.status === 'outbound') ? e.durationOut : e.durationBack;
        if (d > 0 && d < best) best = d;
      }
    }
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
    currentDSFull: currentDSFull,
    splitFaro: splitFaro,
    I_PER_K: I_PER_K, I_PER_PHI: I_PER_PHI, I_PER_OMEGA: I_PER_OMEGA,
    tick: tick,
    advance: advance,
    advanceToNextEvent: advanceToNextEvent,
    nextEventImpulsi: nextEventImpulsi,
    targetClassWeights: targetClassWeights,
    ensureScarcity: ensureScarcity
  };
})(typeof window !== 'undefined' ? window : this);
