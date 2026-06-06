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

    /* Gestione rifiuti — Fase 0 (decisione #48). Modello IBRIDO: i rifiuti
       sono una QUANTITÀ accumulata (`colony.waste.stock`) e una SATURAZIONE
       (stock/capacità) che genera pressione. Popolazione e industria li
       producono; gli impianti di riciclo li trattano (→ energia) e ne alzano
       la capacità. Oltre la soglia di guardia la saturazione abbatte la
       produzione in modo PROGRESSIVO — il "deperimento" del pianeta — ma
       sempre recuperabile (decisione #22: mai fail-state; basta 1 impianto
       di riciclo per invertire la rotta). Numeri tarati perché in Fase 0 la
       pressione si avverta solo nel lungo periodo su colonie sviluppate. */
    WASTE_PER_POP:       0.15,   // rifiuti / unità pop / Ι
    WASTE_BY_CAT: {              // rifiuti / modulo / Ι per categoria struttura
      estrattiva: 0.30, produttiva: 0.60, militare: 0.30,
      ricerca:    0.10, civile:    0.10, avanzata:  0.25
    },
    WASTE_BASE_CAPACITY: 500,    // contenimento di base della colonia
    WASTE_ENERGY_YIELD:  0.25,   // energia recuperata per unità di rifiuto trattato
    WASTE_SAT_WARN:      0.70,   // saturazione oltre cui inizia il malus (stato 'saturo')
    WASTE_MALUS_SAT:     0.10,   // malus produzione a saturazione = 1.0
    WASTE_MALUS_CRIT:    0.25,   // malus massimo (saturazione ≥ 2.0, overflow ignorato)

    /* Combattimento M09 — Fase A (decisione #49). Filosofia "declino a
       spirale con leve di recovery": le perdite alimentano un MORALE
       d'impero in calo (→ moltiplicatore negativo sulla produzione, come
       scarsità/rifiuti) e una PRESSIONE che alza la frequenza delle razzie.
       Tutto BOUNDED e recovery-friendly (#22): un singolo scontro perso non
       è catastrofico, ma una CATENA di sconfitte compone la spirale. La
       morale risale e la pressione decade da sole nel tempo → recovery
       passivo; le leve attive (consolidare/abbandonare) sono Fase B. */
    WAR_MORALE_FLOOR:     0.6,   // pavimento del moltiplicatore produzione da morale
    WAR_MORALE_RECOVER:   0.004, // /Ι risalita morale verso 1.0
    WAR_PRESSURE_DECAY:   0.01,  // /Ι decadimento pressione verso 0
    WAR_MORALE_PER_SHIP:  0.012, // calo morale per nave persa
    WAR_MORALE_PER_LOOT:  0.04,  // calo morale per colonia saccheggiata
    WAR_MORALE_PER_DEFEAT:0.02,  // calo morale per battaglia persa dal giocatore
    WAR_PRESSURE_PER_LOSS:0.06,  // +pressione per evento negativo
    WAR_MORALE_PER_WIN:   0.015, // risalita morale per battaglia vinta (recupero attivo)

    /* Razzie pirata (incursioni inbound, §17.5). Cadenza all'AI-tick; la
       probabilità di lancio scala con la pressione. Preavviso = ETA di
       viaggio (recovery-friendly: il giocatore vede l'incursione arrivare). */
    PIRATE_INCURSION_BASE: 0.05, // prob. base/covo/AI-tick (a pressione 0)
    PIRATE_INCURSION_PRESSURE: 0.25, // +prob a pressione 1.0
    PIRATE_RAID_LOOT_FRAC: 0.18, // frazione di stock saccheggiata se i predoni vincono (bounded)
    PIRATE_RAID_STRUCT_DMG: 35,  // hp tolti a una struttura colpita
    PIRATE_RAID_POP_LOSS:   1,   // unità pop perse in un saccheggio

    /* Riparazione passiva (recovery-friendly, §10.2): le strutture
       danneggiate in battaglia risalgono di hp da sole quando il sistema
       non è sotto attacco. */
    STRUCT_REPAIR_PER_I:  1.5,   // hp/Ι recuperati dalle strutture danneggiate

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
    'batteria-difesa':   { militari: 2, tecnici: 1 },
    'scudo-planetario':  { militari: 1, tecnici: 2 },
    'centro-abitativo':  { operai: 1, tecnici: 1, mercanti: 1 },
    'ospedale':          { scienziati: 1, tecnici: 1 },
    'mercato':           { mercanti: 3 },
    'impianto-riciclo':  { operai: 1, tecnici: 1 },
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

  /* Stato rifiuti (decisione #48) — lazy init, NESSUN bump di schema:
     `colony.waste` (senza underscore) viene auto-serializzato come parte
     di game.colonies, i save vecchi caricano con waste undefined e lo
     ricreano al primo tick (pattern già usato per governor/commanders). */
  function ensureWaste(colony) {
    if (!colony.waste) {
      colony.waste = { stock: 0, saturation: 0, capacity: 0, net: 0, state: 'ok', announced: {} };
    }
    return colony.waste;
  }

  /* Capacità di contenimento rifiuti: base + moduli impianto di riciclo. */
  function wasteCapacity(colony) {
    let cap = CFG.WASTE_BASE_CAPACITY;
    const S = root.ORION.structures;
    Object.keys(colony.structures || {}).forEach(function (id) {
      const def = S.get(id);
      if (def && def.wasteCapacity) {
        cap += def.wasteCapacity * S.moduleSum(colony.structures[id].level || 1);
      }
    });
    return cap;
  }

  /* Malus di produzione da rifiuti — PROGRESSIVO (il "deperimento"):
     0 fino alla soglia di guardia, poi cresce linearmente fino a
     WASTE_MALUS_SAT a saturazione 1.0, e oltre (overflow) fino a
     WASTE_MALUS_CRIT a saturazione 2.0. Cappato: mai oltre il crit,
     mai un fail-state (decisione #22). */
  function wasteMalus(waste) {
    if (!waste) return 1;
    const sat = waste.saturation || 0;
    if (sat <= CFG.WASTE_SAT_WARN) return 1;
    if (sat < 1.0) {
      const t = (sat - CFG.WASTE_SAT_WARN) / (1.0 - CFG.WASTE_SAT_WARN);
      return 1 - CFG.WASTE_MALUS_SAT * t;
    }
    const over = Math.min(1, sat - 1.0);   // overflow: 0→1 da sat 1.0 a 2.0
    return 1 - (CFG.WASTE_MALUS_SAT + (CFG.WASTE_MALUS_CRIT - CFG.WASTE_MALUS_SAT) * over);
  }

  /* Helper di lettura per la UI (robusto anche prima del primo tick:
     ricalcola la capacità sullo stato corrente). */
  function wasteStatus(colony) {
    const w = colony.waste || { stock: 0, net: 0 };
    const cap = wasteCapacity(colony);
    const sat = cap > 0 ? (w.stock || 0) / cap : 0;
    let state = 'ok';
    if (sat >= 1.0) state = 'critico';
    else if (sat >= CFG.WASTE_SAT_WARN) state = 'saturo';
    return { stock: w.stock || 0, net: w.net || 0, capacity: cap, saturation: sat, state: state };
  }

  /* Stato di guerra d'impero (decisione #49) — lazy init, serializzato come
     game.warState (bump schema 9 in save.js). `morale` 0.6..1 modula la
     produzione globale; `pressure` 0..1 alza la frequenza delle razzie. */
  function ensureWarState(game) {
    if (!game.warState || typeof game.warState !== 'object') {
      game.warState = { morale: 1.0, pressure: 0 };
    }
    if (game.warState.morale == null) game.warState.morale = 1.0;
    if (game.warState.pressure == null) game.warState.pressure = 0;
    return game.warState;
  }
  /* Moltiplicatore di produzione dal morale d'impero (1.0 = nessun malus). */
  function warMalus(game) {
    const ws = game && game.warState;
    if (!ws) return 1;
    return Math.max(CFG.WAR_MORALE_FLOOR, Math.min(1, ws.morale || 1));
  }
  /* Registra un evento negativo (perdita) sullo stato di guerra: cala il
     morale, sale la pressione. Bounded. */
  function warRegisterLoss(game, moraleHit, pressureHit) {
    const ws = ensureWarState(game);
    ws.morale = Math.max(0.3, ws.morale - (moraleHit || 0));
    ws.pressure = Math.min(1, ws.pressure + (pressureHit || 0));
  }
  /* Registra una vittoria: piccolo recupero morale (leva attiva di recovery). */
  function warRegisterWin(game) {
    const ws = ensureWarState(game);
    ws.morale = Math.min(1, ws.morale + CFG.WAR_MORALE_PER_WIN);
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
      // Distribuisce la prima unità sulle classi proporzionalmente alla
      // vocazione: senza strutture risulta tutta in operai (target di base).
      addToBestClass(colony, 1);
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
        ("atterraggio, scarico moduli"). Recovery-friendly: finisce sola.

        DECISIONE #45 (emenda #37): la popolazione drena DAVVERO lo stock
        di cibo/acqua (POP_FOOD_PER_UNIT / POP_WATER_PER_UNIT per unità).
        La carestia è restaurata: se la produzione locale non copre il
        consumo, lo stock scende → low/crit triggerano normalmente.
        Il buffer 30 Ι prima del decremento pop (decisione #22, recovery-
        friendly) resta intatto: il giocatore ha sempre il tempo di reagire. */
  function processProduction(colony, planet, scar, game, colonyKey) {
    if (!colony.colonized) return null;
    const out = root.ORION.planet.structureOutput(colony, planet, game, colonyKey);
    const malus = scarcityMalus(scar);
    /* Decisione #48: la saturazione di rifiuti del tick precedente abbatte
       la produzione in modo progressivo (recovery-friendly, mai fail-state). */
    const wMalus = wasteMalus(colony.waste);
    /* Decisione #49: il morale d'impero in calo (catena di sconfitte)
       abbatte la produzione globale — il "declino a spirale". */
    const warM = warMalus(game);
    const settling = (colony.phase === 'settling') ? 0.5 : 1.0;
    const stock = colony.stock;
    const pop = colony.pop || { total: 0 };
    /* Drenaggio cibo/acqua da popolazione: solo in fase operational
       (durante settling la pop è bloccata e i moduli avanguardia sono
       autosufficienti, decisione #27). */
    const popFoodDemand  = (colony.phase !== 'settling') ? (pop.total || 0) * CFG.POP_FOOD_PER_UNIT  : 0;
    const popWaterDemand = (colony.phase !== 'settling') ? (pop.total || 0) * CFG.POP_WATER_PER_UNIT : 0;
    const net = {};
    ['met', 'en', 'food', 'water'].forEach(function (k) {
      const r = (out.rates[k] || 0) * malus * wMalus * warM * settling;
      const u = out.upkeep[k] || 0;
      let n = r - u;
      if (k === 'food')  n -= popFoodDemand;
      if (k === 'water') n -= popWaterDemand;
      net[k] = n;
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
        const oldTotal = pop.total;
        pop.total--;
        /* Classi in float: scala TUTTE proporzionalmente per mantenere il
           mix corrente (niente più "tolgo 1 dalla più numerosa", che con i
           float lascerebbe scorie inaspettate). */
        const ratio = pop.total / oldTotal;
        Object.keys(pop.classes).forEach(function (k) {
          pop.classes[k] = (pop.classes[k] || 0) * ratio;
        });
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

      /* Capacità di carico (DECISIONE #45, emenda #37): il consumo pop è
         ora drenato direttamente in processProduction → prod.net.food/water
         INCLUDE già la richiesta della popolazione corrente. Quindi il
         "surplus" che alimenta la crescita = net diretto (positivo = c'è
         margine per nuove unità; ≤0 = plateau o carestia). Legge del minimo
         tra cibo e acqua. La crescita resta lenta e di lungo periodo. */
      const surplus = Math.min(prod.net.food || 0, prod.net.water || 0);
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

  /* Distribuisce una nuova unità (o frazione di unità) sulla popolazione
     proporzionalmente al target. Con classi FRAZIONARIE l'unità non è
     "un singolo lavoratore" ma una porzione del corpo sociale: a target
     57/21/21 una nuova unità diventa operai+=0.57, militari+=0.21,
     tecnici+=0.21. Risultato: il mix mostrato segue subito la vocazione,
     anche a pop bassa (niente più oscillazione tra una classe e l'altra). */
  function addToBestClass(colony, amount) {
    amount = (amount == null) ? 1 : amount;
    const target = targetClassWeights(colony);
    let totalW = 0;
    Object.keys(target).forEach(function (k) { totalW += target[k]; });
    if (totalW <= 0) {
      colony.pop.classes.operai = (colony.pop.classes.operai || 0) + amount;
      return;
    }
    Object.keys(target).forEach(function (k) {
      colony.pop.classes[k] = (colony.pop.classes[k] || 0) + (target[k] / totalW) * amount;
    });
  }

  /* Riallinea continuamente il mix di classi verso la vocazione dedotta
     dalle strutture. Classi in float → spostiamo direttamente la frazione,
     niente più accumulatore intero (che a pop bassa faceva oscillare il mix
     tra una classe e l'altra ogni ~60 Ι, dando l'impressione di un bug). */
  function shiftClassMix(colony) {
    const target = targetClassWeights(colony);
    let totalW = 0;
    Object.keys(target).forEach(function (k) { totalW += target[k]; });
    if (totalW <= 0 || colony.pop.total <= 0) return;
    const total = colony.pop.total;
    let overK = null, overGap = 0, underK = null, underGap = 0;
    Object.keys(target).forEach(function (k) {
      const want = (target[k] / totalW) * total;
      const have = colony.pop.classes[k] || 0;
      const gap = have - want;
      if (gap > overGap) { overGap = gap; overK = k; }
      if (-gap > underGap) { underGap = -gap; underK = k; }
    });
    if (!overK || !underK || overK === underK) return;
    /* Tasso di shift: lento per design (recovery-friendly, decisione #22),
       ma accelerato a pop bassa così la vocazione è visibile da subito. */
    const speedMul = Math.max(1, 5 / Math.max(1, total));
    const move = Math.min(overGap, underGap) * CFG.POP_CLASS_SHIFT * speedMul;
    colony.pop.classes[overK] = Math.max(0, (colony.pop.classes[overK] || 0) - move);
    colony.pop.classes[underK] = (colony.pop.classes[underK] || 0) + move;
  }

  /* 5b) Rifiuti (decisione #48, Fase 0). Eseguito DOPO la produzione/pop:
     genera rifiuti da popolazione + industria, li tratta con gli impianti di
     riciclo (recuperando energia), aggiorna stock/saturazione/stato e
     accumula i rifiuti non trattati. Niente durante l'Insediamento (pop
     bloccata, attività ridotta). Determinismo: zero RNG. */
  function processWaste(game, colony, planet, events) {
    if (!colony.colonized) return;
    if (colony.phase === 'settling') return;
    const waste = ensureWaste(colony);
    const S = root.ORION.structures;

    // 1) Generazione (popolazione) + 2) industria/trattamento in un solo giro
    let gen = (colony.pop.total || 0) * CFG.WASTE_PER_POP;
    let process = 0;
    Object.keys(colony.structures || {}).forEach(function (id) {
      const def = S.get(id);
      if (!def) return;
      const msum = S.moduleSum(colony.structures[id].level || 1);
      const wcat = CFG.WASTE_BY_CAT[def.cat];
      if (wcat) gen += wcat * msum;
      if (def.wasteProcess) process += def.wasteProcess * msum;
    });

    const before = waste.stock || 0;
    let after = before + gen - process;
    if (after < 0) after = 0;
    // energia recuperata = rifiuti EFFETTIVAMENTE trattati × resa
    const processed = Math.max(0, (before + gen) - after);
    if (processed > 0 && CFG.WASTE_ENERGY_YIELD > 0) {
      colony.stock.en = (colony.stock.en || 0) + processed * CFG.WASTE_ENERGY_YIELD;
    }
    waste.stock = after;
    waste.net = gen - process;

    // 3) Saturazione → stato (progressivo, recovery-friendly)
    const cap = wasteCapacity(colony);
    waste.capacity = cap;
    const sat = cap > 0 ? after / cap : 0;
    waste.saturation = sat;
    const prev = waste.state;
    let state = 'ok';
    if (sat >= 1.0) state = 'critico';
    else if (sat >= CFG.WASTE_SAT_WARN) state = 'saturo';
    waste.state = state;

    // eventi (anti-spam come la scarsità)
    if (!waste.announced) waste.announced = {};
    if (state !== 'ok' && state !== prev && !waste.announced[state]) {
      waste.announced[state] = true;
      events.push({ kind: 'waste', sev: state, colony: colony, planet: planet, impulso: game.timeImpulsi });
    }
    if (state === 'ok' && prev !== 'ok') {
      waste.announced = {};
      events.push({ kind: 'waste-recover', from: prev, colony: colony, planet: planet, impulso: game.timeImpulsi });
    }
  }

  /* 6b) M07 — code asset (scafi Hangar / equipaggi Accademia).
        Decisione #37: counter scafi e array equipaggi separati dalla
        coda strutture; produzione 1/Ι (no malus scarsità — il loop le
        considera prodotti di "qualità", non risorse di flusso). */
  /* Counter monotono persistente per gli id "umani" delle entità
     (equipaggi, scafi, ecc.). Vive in `game.idSeq` come delta — lazy
     init, NESSUN bump di schema. Sostituisce i counter module-level
     `_assetCounter`/`_expCounter` che, essendo runtime-local, si
     resettavano a 0 ad ogni reload del save → collisione di ID e
     duplicati visivi "Equipaggio 1" nel roster. */
  function nextSeqId(game, prefix) {
    if (!game.idSeq) game.idSeq = {};
    const cur = (game.idSeq[prefix] | 0) + 1;
    game.idSeq[prefix] = cur;
    return prefix + '-' + cur;
  }
  /* Helper esposto: condiviso con expedition.js (vedi root.ORION.time). */
  function nextCrewId(game) { return nextSeqId(game, 'crew'); }

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
          /* M08 Fase A: il counter incrementa il KIND completato (default
             'explorer' per retro-compat con shipQueue legacy senza kind). */
          colony.ships = colony.ships || { explorer: 0 };
          const k = q.kind || 'explorer';
          colony.ships[k] = (colony.ships[k] || 0) + 1;
          events.push({
            kind: 'ship-built',
            colony: colony, planet: planet,
            shipKind: k,
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
          colony.crews.explorer.push({
            id: nextCrewId(game),
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

  /* 6d) M08 Fase A — flotte mobili. Itera game.fleets[] facendo avanzare
        gli ordini di movimento (idle/move/explore/patrol/return). NIENTE
        rimozione automatica: le flotte sono entità persistenti, vengono
        sciolte solo esplicitamente via ORION.fleet.dissolveFleet. */
  function processFleets(game, events) {
    if (!Array.isArray(game.fleets) || !game.fleets.length) return;
    if (!root.ORION.fleet || !root.ORION.fleet.tick) return;
    for (let i = 0; i < game.fleets.length; i++) {
      root.ORION.fleet.tick(game, game.fleets[i], events);
    }
  }

  /* ==================================================================
     M09 Fase A (decisione #49) — COMBATTIMENTO
     Tre trigger: scaramuccia anti-pirata [lampo], scaramuccia offensiva
     vs AI [lampo], assedio pirata a una colonia [multi-Impulso].
     Tutto deterministico (RNG seedato), recovery-friendly bounded.
     ================================================================== */

  function playerColonyKeyForSystem(game, sysId) {
    const cols = game.colonies || {};
    const keys = Object.keys(cols);
    for (let i = 0; i < keys.length; i++) {
      const c = cols[keys[i]];
      if (c && c.colonized && c.systemId === sysId) return keys[i];
    }
    return null;
  }
  function pirateNestAt(game, sysId) {
    const nests = game.piracy && game.piracy.nests;
    if (!nests) return null;
    for (let i = 0; i < nests.length; i++) if (nests[i].sysId === sysId) return nests[i];
    return null;
  }
  /* Flotte del giocatore presenti (docked/orbiting, non in transito) in un
     sistema, con almeno una nave armata. */
  function fleetsPresentAt(game, sysId) {
    const out = [];
    const fleets = game.fleets || [];
    for (let i = 0; i < fleets.length; i++) {
      const f = fleets[i];
      if (!f || !f.location) continue;
      if (f.location.systemId !== sysId) continue;
      if (f.location.status === 'in-transit') continue;
      out.push(f);
    }
    return out;
  }
  function fleetHasGuns(fleet) {
    const F = root.ORION.combat;
    if (!F) return false;
    const force = F.forceFromFleet(null, fleet, 'A');
    return F.totalFp(force) > 0;
  }

  /* 6e) Scaramucce LAMPO: una flotta del giocatore appena giunta (orbiting)
        in un sistema con presenza ostile (covo pirata o sistema AI ostile,
        ma NON una colonia del giocatore → quello è un assedio). Risolte in
        1 Impulso. Flag `combatResolvedAt` evita di rifare lo scontro mentre
        la flotta staziona; si azzera quando riparte (gestito in fleet.tick
        non serve: ricontrolliamo systemId). */
  function processSkirmishes(game, events) {
    const C = root.ORION.combat;
    if (!C) return;
    const fleets = game.fleets || [];
    for (let i = 0; i < fleets.length; i++) {
      const fleet = fleets[i];
      if (!fleet || !fleet.location) continue;
      if (fleet.location.status === 'in-transit') { fleet.combatResolvedAt = null; continue; }
      const sysId = fleet.location.systemId;
      if (fleet.combatResolvedAt === sysId) continue;     // già risolto qui
      if (!fleetHasGuns(fleet)) continue;
      // niente scaramuccia nel proprio sistema-colonia (è zona sicura / assedio)
      if (playerColonyKeyForSystem(game, sysId) != null) continue;

      const nest = pirateNestAt(game, sysId);
      const civ = (root.ORION.ai && root.ORION.ai.civForSystem) ? root.ORION.ai.civForSystem(game, sysId) : null;
      const civHostile = civ && civ.alive && (civ.disposition <= -40);

      let enemy = null, enemyKind = null;
      if (nest) { enemy = C.forceFromPirateNest(nest); enemyKind = 'pirate'; }
      else if (civHostile && root.ORION.ai.materialize) {
        enemy = C.forceFromMaterialized(root.ORION.ai.materialize(game, civ, sysId), 'B');
        enemyKind = 'ai';
      }
      if (!enemy) continue;

      fleet.combatResolvedAt = sysId;
      const A = C.forceFromFleet(game, fleet, 'A');
      const battleId = (game.timeImpulsi || 0) + ':' + sysId + ':' + fleet.id;
      const report = C.resolve(game, battleId, A, enemy);
      report.kind = 'skirmish';
      report.systemId = sysId;
      report.enemyKind = enemyKind;

      // Applica esito alla flotta del giocatore (perdite permanenti, +xp)
      const fleetOutcome = C.applyOutcomeToFleet(game, fleet, A);
      const playerWon = (report.winner === 'A');

      // Effetti per tipo nemico
      if (enemyKind === 'pirate') {
        if (playerWon) {
          nest.level = (nest.level || 1) - 1;
          if (nest.level <= 0) {
            game.piracy.nests = game.piracy.nests.filter(function (n) { return n !== nest; });
          }
        }
      } else if (enemyKind === 'ai' && root.ORION.ai.demobilize) {
        // indebolisce la civiltà (la perdita di potenza vive in demobilize)
        root.ORION.ai.demobilize(game, civ, { winner: playerWon ? 'player' : 'civ', report: report });
      }

      // Stato di guerra d'impero (catena di sconfitte → spirale)
      if (fleetOutcome.lost > 0) warRegisterLoss(game, fleetOutcome.lost * CFG.WAR_MORALE_PER_SHIP, fleetOutcome.lost * CFG.WAR_PRESSURE_PER_LOSS);
      if (playerWon) warRegisterWin(game);
      else warRegisterLoss(game, CFG.WAR_MORALE_PER_DEFEAT, CFG.WAR_PRESSURE_PER_LOSS);

      // Se la flotta è sopravvissuta ma ha perso → rientra alla base
      if (!playerWon && fleet.ships.length > 0 && root.ORION.fleet) {
        root.ORION.fleet.setOrder(game, fleet, { type: 'return' });
      }
      // Se la flotta è stata annientata → rimuovila
      if (fleet.ships.length === 0) {
        game.fleets = game.fleets.filter(function (f) { return f !== fleet; });
      }

      events.push({
        kind: 'battle-skirmish', report: report,
        fleetId: fleet.id, fleetName: fleet.name,
        playerWon: playerWon, lost: fleetOutcome.lost, promoted: fleetOutcome.promoted,
        systemId: sysId, impulso: game.timeImpulsi
      });
    }
  }

  /* 6f) Incursioni pirata INBOUND (§17.5): forze in viaggio verso una colonia
        del giocatore. Spawn in ai.js (gated dalla pressione). Qui le ticchiamo:
        all'arrivo creano un ASSEDIO (battaglia persistente). */
  function processIncursions(game, events) {
    if (!Array.isArray(game.incursions) || !game.incursions.length) return;
    const C = root.ORION.combat;
    const still = [];
    for (let i = 0; i < game.incursions.length; i++) {
      const inc = game.incursions[i];
      inc.eta = (inc.eta || 0) - 1;
      if (inc.eta > 0) { still.push(inc); continue; }
      // arrivo: la colonia esiste ancora?
      const colonyKey = playerColonyKeyForSystem(game, inc.targetSysId);
      if (!colonyKey || !C) continue;     // bersaglio sparito → incursione svanisce
      // crea la battaglia d'assedio
      const nest = { level: inc.level || 1 };
      const atkForce = C.forceFromPirateNest(nest);
      atkForce.formation = 'balanced';    // i predoni si sganciano se mauled
      const battle = {
        id: inc.id, kind: 'siege-pirate',
        systemId: inc.targetSysId, colonyKey: colonyKey,
        attacker: { name: atkForce.name, color: atkForce.color, formation: 'balanced',
                    combatants: atkForce.combatants },
        startAttackerHp: C.totalHp(atkForce),
        round: 0, nextRoundAt: (game.timeImpulsi || 0) + C.CFG.ROUND_EVERY_I,
        status: 'active', log: []
      };
      if (!Array.isArray(game.battles)) game.battles = [];
      game.battles.push(battle);
      events.push({
        kind: 'siege-begin', battleId: battle.id,
        systemId: inc.targetSysId, colonyKey: colonyKey,
        impulso: game.timeImpulsi
      });
    }
    game.incursions = still;
  }

  /* 6g) Assedi in corso: avanza 1 round ogni ROUND_EVERY_I Impulsi. Il
        difensore viene RICOSTRUITO dallo stato vivo (difese + flotte presenti)
        → rinforzi/ritirate fra i round contano (decisione #49). */
  function processBattles(game, events) {
    if (!Array.isArray(game.battles) || !game.battles.length) return;
    const C = root.ORION.combat;
    if (!C) return;
    const still = [];
    for (let bi = 0; bi < game.battles.length; bi++) {
      const battle = game.battles[bi];
      if (battle.status !== 'active') continue;
      const colonyKey = battle.colonyKey;
      const colony = game.colonies && game.colonies[colonyKey];
      // colonia sparita o non più nel sistema → l'assedio decade
      if (!colony || !colony.colonized || colony.systemId !== battle.systemId) {
        events.push({ kind: 'siege-end', battleId: battle.id, outcome: 'lifted',
          colonyKey: colonyKey, impulso: game.timeImpulsi });
        continue;
      }
      if ((game.timeImpulsi || 0) < battle.nextRoundAt) { still.push(battle); continue; }

      battle.round++;
      battle.nextRoundAt = (game.timeImpulsi || 0) + C.CFG.ROUND_EVERY_I;

      // Ricostruisci attaccante (pirati) dallo stato persistito
      const atk = {
        side: 'A', name: battle.attacker.name, color: battle.attacker.color,
        immobile: false, formation: battle.attacker.formation || 'balanced',
        combatants: battle.attacker.combatants
      };
      // Ricostruisci difensore dallo stato vivo: difese + flotte presenti
      const defDef = C.forceFromDefenses(game, colony, colonyKey, 'B');
      const present = fleetsPresentAt(game, battle.systemId);
      const defShips = [];
      for (let i = 0; i < present.length; i++) {
        const ff = C.forceFromFleet(game, present[i], 'B');
        for (let j = 0; j < ff.combatants.length; j++) defShips.push(ff.combatants[j]);
      }
      const def = {
        side: 'B', name: colony.name || 'Colonia', color: '#3fcaa0',
        immobile: defShips.length === 0,   // se ci sono flotte, la difesa può ritirarle
        formation: 'defensive',
        combatants: defDef.combatants.concat(defShips)
      };

      // niente difensori → saccheggio diretto
      if (def.combatants.length === 0) {
        applyLoot(game, colony, colonyKey, events);
        events.push({ kind: 'siege-end', battleId: battle.id, outcome: 'looted',
          colonyKey: colonyKey, systemId: battle.systemId, impulso: game.timeImpulsi });
        continue;
      }

      const rng = ORION.rng.makeRng((game.seed || '') + ':battle:' + battle.id + ':' + battle.round);
      const startAtkHp = C.totalHp(atk);
      const r = C.resolveRound(rng, atk, def);
      // scrivi gli esiti del difensore sullo stato vivo
      const survivorsDef = def.combatants;     // post-purge
      const wb = C.applyDefenderWriteback(colony, survivorsDef, r.destroyedB);
      if (wb.shipsLost > 0) warRegisterLoss(game, wb.shipsLost * CFG.WAR_MORALE_PER_SHIP, wb.shipsLost * CFG.WAR_PRESSURE_PER_LOSS);
      // l'attaccante hp residuo è già persistito (stesso array di oggetti)

      battle.log.push({ round: battle.round, lostDef: r.destroyedB.length, lostAtk: r.destroyedA.length,
        atkHp: Math.round(C.totalHp(atk)), defHp: Math.round(C.totalHp(def)) });

      events.push({ kind: 'siege-round', battleId: battle.id, round: battle.round,
        colonyKey: colonyKey, systemId: battle.systemId,
        atk: C.totalHp(atk), def: C.totalHp(def),
        lostDef: r.destroyedB.length, lostAtk: r.destroyedA.length,
        impulso: game.timeImpulsi });

      // fine assedio?
      const atkWiped = atk.combatants.length === 0;
      const atkRetreat = C.checkRetreat(atk, startAtkHp);
      const defWiped = def.combatants.length === 0;
      if (atkWiped || atkRetreat) {
        // difensori vincono: razzia respinta, covo indebolito
        warRegisterWin(game);
        events.push({ kind: 'siege-end', battleId: battle.id, outcome: 'repelled',
          colonyKey: colonyKey, systemId: battle.systemId, impulso: game.timeImpulsi });
        grantSiegeVeterancy(game, present);
        continue;
      }
      if (defWiped) {
        applyLoot(game, colony, colonyKey, events);
        events.push({ kind: 'siege-end', battleId: battle.id, outcome: 'looted',
          colonyKey: colonyKey, systemId: battle.systemId, impulso: game.timeImpulsi });
        continue;
      }
      // cap di sicurezza
      if (battle.round >= 12) {
        const win = C.totalHp(def) >= C.totalHp(atk);
        if (win) { warRegisterWin(game); }
        else { applyLoot(game, colony, colonyKey, events); }
        events.push({ kind: 'siege-end', battleId: battle.id, outcome: win ? 'repelled' : 'looted',
          colonyKey: colonyKey, systemId: battle.systemId, impulso: game.timeImpulsi });
        if (win) grantSiegeVeterancy(game, present);
        continue;
      }
      still.push(battle);
    }
    game.battles = still;
  }

  function grantSiegeVeterancy(game, fleets) {
    const C = root.ORION.combat;
    if (!C) return;
    for (let i = 0; i < fleets.length; i++) C.grantVeterancy(game, fleets[i]);
  }

  /* Saccheggio di una colonia (bounded, recovery-friendly #22/#49): ruba una
     frazione dello stock, danneggia una struttura, perde 1 pop. Niente
     distruzione totale in Fase A (la conquista/rasa è Fase B). */
  function applyLoot(game, colony, colonyKey, events) {
    const looted = {};
    ['met', 'en', 'food', 'water'].forEach(function (k) {
      const amt = Math.floor((colony.stock[k] || 0) * CFG.PIRATE_RAID_LOOT_FRAC);
      colony.stock[k] = Math.max(0, (colony.stock[k] || 0) - amt);
      looted[k] = amt;
    });
    // danneggia una struttura (deterministico: la prima per chiave)
    const ids = Object.keys(colony.structures || {});
    if (ids.length) {
      ids.sort();
      const st = colony.structures[ids[0]];
      st.hp = Math.max(5, (st.hp != null ? st.hp : 100) - CFG.PIRATE_RAID_STRUCT_DMG);
    }
    // perdita pop
    if (colony.pop && colony.pop.total > 1) {
      const old = colony.pop.total;
      colony.pop.total -= CFG.PIRATE_RAID_POP_LOSS;
      const ratio = colony.pop.total / old;
      Object.keys(colony.pop.classes).forEach(function (k) {
        colony.pop.classes[k] = (colony.pop.classes[k] || 0) * ratio;
      });
    }
    warRegisterLoss(game, CFG.WAR_MORALE_PER_LOOT, CFG.WAR_PRESSURE_PER_LOSS);
    events.push({ kind: 'colony-looted', colonyKey: colonyKey, colony: colony, looted: looted, impulso: game.timeImpulsi });
  }

  /* Decadimento dello stato di guerra (recovery passivo) + riparazione
     passiva delle strutture danneggiate (quando non sotto attacco). */
  function processWarState(game) {
    const ws = ensureWarState(game);
    ws.morale = Math.min(1, ws.morale + CFG.WAR_MORALE_RECOVER);
    ws.pressure = Math.max(0, ws.pressure - CFG.WAR_PRESSURE_DECAY);
  }
  function colonyUnderSiege(game, colonyKey) {
    const bs = game.battles || [];
    for (let i = 0; i < bs.length; i++) {
      if (bs[i].status === 'active' && bs[i].colonyKey === colonyKey) return true;
    }
    return false;
  }
  function processStructRepair(game, colony, colonyKey) {
    if (colonyUnderSiege(game, colonyKey)) return;   // niente riparazione sotto assedio
    const structs = colony.structures || {};
    Object.keys(structs).forEach(function (id) {
      const st = structs[id];
      if (st.hp != null && st.hp < 100) {
        st.hp = Math.min(100, st.hp + CFG.STRUCT_REPAIR_PER_I);
      }
    });
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
      ensureWaste(colony);
      const prod = processProduction(colony, planet, scar, game, keys[i]);
      processScarcity(game, colony, planet, prod, events);
      processPopulation(game, colony, planet, prod, events);
      processWaste(game, colony, planet, events);
      processObservatory(game, colony, planet, events);
      processAssets(game, colony, planet, events);
      processSettling(game, colony, planet, events);
      /* M09 (decisione #49, §10.2): riparazione passiva delle strutture
         danneggiate in battaglia, sospesa mentre la colonia è sotto assedio. */
      processStructRepair(game, colony, keys[i]);
    }
    /* M07: spedizioni in volo (1 tick per ogni Impulso). */
    processExpeditions(game, events);
    /* M08 Fase A: flotte mobili (movimento + ordini). */
    processFleets(game, events);
    /* M09 Fase A (decisione #49): combattimento. Scaramucce lampo (flotte
       co-locate con presenza ostile), incursioni pirata inbound, assedi in
       corso (1 round ogni ROUND_EVERY_I), poi decadimento dello stato di
       guerra (recovery passivo). L'AI (sotto) può lanciare nuove incursioni. */
    processSkirmishes(game, events);
    processIncursions(game, events);
    processBattles(game, events);
    processWarState(game);
    /* Decisione #45: Capitale di Gruppo — avanza timer di transizione
       (pre-capital → capital · decommissioning → null). Emette eventi
       a fine transizione. */
    if (root.ORION.capital && root.ORION.capital.tick) {
      root.ORION.capital.tick(game, events);
    }
    /* M07.1 (decisione #40): Governatore coloniale — Tier 1 "Vigile".
       Letture sullo stato già aggiornato del tick corrente; non agisce,
       emette solo eventi `gov-*` che la chronicle/auto-pause gestiscono
       come tutti gli altri. */
    if (root.ORION.governor && root.ORION.governor.tick) {
      root.ORION.governor.tick(game, events);
    }
    /* M10 Fase A (decisione #47): civiltà AI in background. Simulazione
       AGGREGATA a cadenza interna (ogni AI_EVERY_I Impulsi, dopo il warm-up):
       espansione, guerre AI-vs-AI, nascita/morte (roster vivo), ICG §5.4,
       disposizione emergente verso il giocatore, pirati atmosferici.
       Determinismo: RNG derivato da seed+Impulso, zero Math.random. */
    if (root.ORION.ai && root.ORION.ai.tick) {
      root.ORION.ai.tick(game, events);
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
      // Decisione #48: rifiuti in accumulo verso la prossima soglia
      // (guardia o overflow), così "Prossimo evento" si ferma prima del
      // deperimento. Solo se i rifiuti stanno effettivamente salendo.
      if (c.colonized && c.phase !== 'settling' && c.waste && c.waste.net > 0 && c.waste.capacity > 0) {
        const cap = c.waste.capacity;
        const warn = cap * CFG.WASTE_SAT_WARN;
        const st = c.waste.stock || 0;
        let tgt = null;
        if (st < warn) tgt = warn;
        else if (st < cap) tgt = cap;
        if (tgt != null) {
          const rem = Math.ceil((tgt - st) / c.waste.net);
          if (rem > 0 && rem < best) best = rem;
        }
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
    /* M08 Fase A: flotte in transito */
    if (Array.isArray(game.fleets)) {
      for (let i = 0; i < game.fleets.length; i++) {
        const f = game.fleets[i];
        if (!f || !f.location || f.location.status !== 'in-transit') continue;
        const d = f.etaImpulsi || 0;
        if (d > 0 && d < best) best = d;
      }
    }
    /* Decisione #45: transizioni capitale in corso. */
    if (root.ORION.capital && root.ORION.capital.nextTransitionDelta) {
      const d = root.ORION.capital.nextTransitionDelta(game);
      if (d > 0 && d < best) best = d;
    }
    /* M09 Fase A: incursioni pirata inbound + prossimo round d'assedio. */
    if (Array.isArray(game.incursions)) {
      for (let i = 0; i < game.incursions.length; i++) {
        const d = game.incursions[i].eta || 0;
        if (d > 0 && d < best) best = d;
      }
    }
    if (Array.isArray(game.battles)) {
      for (let i = 0; i < game.battles.length; i++) {
        const b = game.battles[i];
        if (b.status !== 'active') continue;
        const d = (b.nextRoundAt || 0) - (game.timeImpulsi || 0);
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
    nextSeqId: nextSeqId,
    nextCrewId: nextCrewId,
    targetClassWeights: targetClassWeights,
    ensureScarcity: ensureScarcity,
    /* Decisione #48 — gestione rifiuti (Fase 0) */
    ensureWaste: ensureWaste,
    wasteCapacity: wasteCapacity,
    wasteMalus: wasteMalus,
    wasteStatus: wasteStatus
  };
})(typeof window !== 'undefined' ? window : this);
