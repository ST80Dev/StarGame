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
    /* Decisione #45 v3: SCARCITY_LOW_STOCK rimosso — soglie assolute non
       scalano. Lo state 'low'/'crit' ora deriva da POP_RUNWAY_LOW/CRIT
       (Ι rimanenti al ritmo attuale di drenaggio), gestito in processScarcity. */
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
    /* Bilanciamento 2026-06-16 (sessione capitale endgame): la popolazione
       drena anche met/en (servizi residenziali, climatizzazione, ricambi
       infrastrutturali). Specchio di POP_FOOD/WATER. Tarato perché una
       capitale terrestre maxata (pop 12) abbia break-even energia/metalli
       sotto questo livello e debba importare via rotte. */
    POP_EN_PER_UNIT:    0.5,    // energia consumata per unità di pop / Impulso
    POP_MET_PER_UNIT:   0.6,    // metalli consumati per unità di pop / Impulso (manutenzione civile)
    /* Razioni equipaggio AL PORTO (decisione 2026-06-15, speculare a #74
       manutenzione metalli): ogni equipaggio NON in viaggio drena cibo+acqua
       sulla colonia di sosta. "Non in viaggio" = idle in colony.crews.explorer
       + crews di flotte docked/orbiting nel sistema della colonia (in-transit
       esclusi: hanno la riserva di viaggio #74). Solo in fase operational.
       Per-equipaggio: razione superiore alla pop per-capita (squadre specializzate
       ben nutrite) ma totale piccolo (pochi crews vs milioni di abitanti).
       Dimezzato su feedback utente per non azzerare il netto in early game
       quando 6-10 crews rientrano simultaneamente. */
    CREW_PORT_FOOD:   0.20,     // cibo per equipaggio al porto / Impulso
    CREW_PORT_WATER:  0.15,     // acqua per equipaggio al porto / Impulso
    /* Decisione #45 emenda v3: gating della crescita pop per RUNWAY (Ι che
       le scorte coprono al ritmo attuale di consumo), non per stato assoluto
       del magazzino. Soglie scelte per coerenza con POP_FAMINE_AFTER (30 Ι):
       l'allerta scatta quando ti resta meno del tempo di reazione famine. */
    POP_RUNWAY_LOW:  30,        // < 30 Ι di scorte → crescita rallentata
    POP_RUNWAY_CRIT: 10,        // < 10 Ι di scorte → crescita ferma
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
    /* Gestione rifiuti — RETUNE (decisione #48): problema di LUNGO TERMINE,
       legato alla POPOLAZIONE e tarato sul MAX STRESS della colonia.
       - generazione pop SUPER-LINEARE (K·pop²): trascurabile a pop bassa,
         sale solo avvicinandosi al cap → ci si pensa solo a colonia matura.
       - industria = sorgente SECONDARIA (contributo piccolo).
       - capacità ALTA: a generazione massima il contenitore si riempie in
         ~170 Ι (non in pochi Ι), con ~120 Ι di margine prima del malus.
       - UN impianto di riciclo lvl1 (wasteProcess 10) regge lo stress max di
         un mondo-giardino pieno → niente più "rincorsa" agli upgrade.
       Filosofia invariata (decisione #22): mai fail-state, malus progressivo. */
    WASTE_POP_K:         0.04,   // rifiuti pop / Ι = K · pop² (super-lineare)
    WASTE_BY_CAT: {              // rifiuti / modulo / Ι per categoria (sorgente secondaria)
      estrattiva: 0.10, produttiva: 0.15, militare: 0.08,
      ricerca:    0.04, civile:    0.04, avanzata:  0.08
    },
    WASTE_BASE_CAPACITY: 2000,   // contenimento di base (buffer ampio → lungo termine)
    WASTE_ENERGY_YIELD:  0.30,   // energia recuperata per unità di rifiuto trattato (a livello 1)
    WASTE_EFF_PER_LEVEL: 0.05,   // +5% resa energia per livello del riciclo (L1 0.30 → L5 0.36)
    WASTE_SAT_WARN:      0.75,   // saturazione oltre cui inizia il malus (stato 'saturo')
    WASTE_MALUS_SAT:     0.10,   // malus produzione a saturazione = 1.0
    WASTE_MALUS_CRIT:    0.25,   // malus massimo (saturazione ≥ 2.0, overflow ignorato)
    /* #48 Fase 1: i mondi OSTILI (bassa pop, "liability") fanno da hub di
       riciclo — bonus su capacità + trattamento dell'impianto di riciclo.
       Dà scopo ai mondi-discarica quando ricevono rifiuti via rotte (Fase 2). */
    WASTE_RECYCLE_BODY_BONUS: {
      gassoso: 1.6, cintura: 1.5, vulcanico: 1.5, ghiacciato: 1.4, luna: 1.3, desertico: 1.2
    },

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
    AI_INCURSION_BASE: 0.05,     // M09 Fase B: prob. base incursione AI ostile/AI-tick
    PIRATE_RAID_LOOT_FRAC: 0.18, // frazione di stock saccheggiata se i predoni vincono (bounded)
    PIRATE_RAID_STRUCT_DMG: 35,  // hp tolti a una struttura colpita
    PIRATE_RAID_POP_LOSS:   1,   // unità pop perse in un saccheggio

    /* Riparazione passiva (recovery-friendly, §10.2): le strutture
       danneggiate in battaglia risalgono di hp da sole quando il sistema
       non è sotto attacco. */
    STRUCT_REPAIR_PER_I:  1.5,   // hp/Ι recuperati dalle strutture danneggiate
    STATION_DEFENSE_COOLDOWN: 8, // Ι fra due difese autonome di una stazione (#81)

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
       Κ (kappa) = Ciclo di nutazione    = 10 Ι
       Φ (phi)   = Fase di precessione   = 12 Κ = 120 Ι
       Ω (omega) = Eone (grande risonanza) = 20 Φ = 2400 Ι
     I rapporti irregolari (10:12:20) sono *intenzionalmente* non potenze
     di 10: l'occhio non collassa più i campi a un decimale e ogni unità
     "conta" davvero (vedi discussione di sessione → CLAUDE.md decisione #30).
     Rapporti ridotti rispetto alla v1 (50:20:100) per far comparire Φ/Ω
     anche in campagne brevi — vedi decisione di sessione.

     Decisione di sessione: il tempo parte da 0 per ogni partita.
     `startEpochOrbita` resta nel payload per retro-compat di shape, ma
     non viene più letto dal formatter — i save vecchi mostrano la loro
     `timeImpulsi` netta (equivalente a sottrarre l'offset iniziale). */
  const I_PER_K = 10;
  const K_PER_PHI = 12;
  const PHI_PER_OMEGA = 20;
  const I_PER_PHI = I_PER_K * K_PER_PHI;          // 120
  const I_PER_OMEGA = I_PER_PHI * PHI_PER_OMEGA;  // 2400

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
    /* Decisione di sessione: il tempo parte da 0 per ogni partita
       (timeImpulsi=0 al new), ignoriamo startEpochOrbita anche per i
       save vecchi — equivalente a "sottrarre l'offset iniziale". Niente
       migrazione: il campo resta sul disco ma non viene letto. */
    return format(game.timeImpulsi || 0, 'compact');
  }
  /* PR-H: versione HTML del formato compact con i 4 valori colorati
     per unità del Faro (Ω·Φ·Κ·Ι). Tinte coerenti con .ds-unit:
     Ω=viola · Φ=ambra · Κ=verde · Ι=ciano. Pensata per l'HUD DATA
     dove ogni segmento ha significato posizionale fisso. */
  function currentDSHtml(game) {
    if (!game) return '—';
    const p = splitFaro(game.timeImpulsi || 0);
    return '<span class="ds-val ds-val--omega">' + p.O + '</span>' +
      '<span class="ds-sep">·</span>' +
      '<span class="ds-val ds-val--phi">' + p.F + '</span>' +
      '<span class="ds-sep">·</span>' +
      '<span class="ds-val ds-val--kappa">' + p.K + '</span>' +
      '<span class="ds-sep">·</span>' +
      '<span class="ds-val ds-val--iota">' + p.I + '</span>';
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

  /* Capacità di contenimento rifiuti: base + moduli impianto di riciclo,
     amplificati dal moltiplicatore di riciclo (#48 Fase 1: tipo di mondo
     ostile × tech Ecologia/Riciclo), calcolato da processWaste e memorizzato
     in colony.waste.recycleMul (default 1 → save vecchi / pre-tick). */
  function wasteCapacity(colony) {
    let cap = CFG.WASTE_BASE_CAPACITY;
    const S = root.ORION.structures;
    const rmul = (colony.waste && colony.waste.recycleMul) || 1;
    Object.keys(colony.structures || {}).forEach(function (id) {
      const def = S.get(id);
      if (def && def.wasteCapacity) {
        cap += def.wasteCapacity * S.moduleSum(colony.structures[id].level || 1) * rmul;
      }
    });
    return cap;
  }
  /* #48 Fase 1: bonus di riciclo per tipo di corpo ostile (× su capacità e
     trattamento dell'impianto di riciclo). */
  function recycleBodyBonus(planet) {
    if (!planet) return 1;
    return CFG.WASTE_RECYCLE_BODY_BONUS[planet.type] || 1;
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
    const w = colony.waste || { stock: 0, net: 0, energyGain: 0 };
    const cap = wasteCapacity(colony);
    const sat = cap > 0 ? (w.stock || 0) / cap : 0;
    let state = 'ok';
    if (sat >= 1.0) state = 'critico';
    else if (sat >= CFG.WASTE_SAT_WARN) state = 'saturo';
    return {
      stock: w.stock || 0, net: w.net || 0,
      capacity: cap, saturation: sat, state: state,
      energyGain: w.energyGain || 0   // en/Ι recuperata dal riciclo (finché brucia)
    };
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
       della fondazione). Decremento 1.5 invece di 1.0 sulla prima.
       Il display usa Math.ceil sulla duration per non mostrare frazioni
       (decisione di sessione, vedi PR build-progress). */
    const settling = (colony.phase === 'settling');
    /* M13 Fase B (decisione #57): tech costruzione = la coda matura più in
       fretta (modificatore passivo, zero nuove strutture). */
    const buildMul = (root.ORION.research && root.ORION.research.mods)
      ? root.ORION.research.mods(game).buildSpeedMul : 1;
    const stillQueued = [];
    for (let i = 0; i < colony.queue.length; i++) {
      const q = colony.queue[i];
      const dec = ((settling && i === 0) ? 1.5 : 1) * buildMul;
      q.duration = (q.duration || 0) - dec;
      if (q.duration <= 0) {
        const def = root.ORION.structures.get(q.id);
        if (!def) continue;
        if (q.target === 'demolish') {
          /* Smantellamento completato (decisione #66 + recovery-friendly #22):
             - se la struttura è a livello ≥ 2 → DOWNGRADE: rimuove solo il
               modulo superiore (level -= 1), rimborso = stepCost del livello
               appena smantellato × refundRate (50% / 70% sulla natale).
               Simmetrico a cancelBuild che rimborsa lo step interrotto.
             - se è a livello 1 → DEMOLIZIONE COMPLETA: rimuove la struttura,
               rimborso = costo BASE × refundRate (comportamento storico).
             - sempre malus morale -0.10 per 30 Ι (decadimento lineare in
               processPopulation). Mai fail-state.
             Se l'osservatorio smantellato era l'origine della scansione e va
             a livello 0, interrompe la scansione in corso (riavviabile). */
          const struct = colony.structures[q.id];
          const lvlBefore = struct ? (struct.level || 0) : 0;
          const refundRate = colony.isHomeBase ? 0.7 : 0.5;
          const isDowngrade = lvlBefore >= 2;
          let refundDef;
          if (isDowngrade) {
            refundDef = root.ORION.structures.stepCost(def, lvlBefore);
            struct.level = lvlBefore - 1;
          } else {
            refundDef = def.cost || {};
            delete colony.structures[q.id];
          }
          Object.keys(refundDef || {}).forEach(function (k) {
            colony.stock[k] = (colony.stock[k] || 0) + Math.floor((refundDef[k] || 0) * refundRate);
          });
          colony.moraleMalus = {
            amount: 0.10,
            startedAt: game.timeImpulsi,
            expiresAt: game.timeImpulsi + 30
          };
          if (q.id === 'osservatorio' && !colony.scanned.active && !isDowngrade) {
            colony.scanned.progress = 0;
          }
          events.push({
            kind: isDowngrade ? 'downgrade-done' : 'demolish-done',
            colony: colony, planet: planet,
            structId: q.id, structName: def.name,
            refundRate: refundRate,
            fromLevel: lvlBefore,
            toLevel: isDowngrade ? lvlBefore - 1 : 0,
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

  /* 2) Colonizzazione in corso (per pianeti non natali).
     Decisione #66: se `colony.colonizing.fleetId` è valorizzato, la
     colonizzazione è "in mano" alla flotta coloniale → il countdown è
     gestito da fleet.js (tickColonizePhase). Qui processColonizing è
     no-op per non doppio-decrementare. Il path legacy (senza fleetId)
     resta attivo per i save vecchi (sub-migrazione v20→v21 non converte
     le colonizzazioni in corso). */
  function processColonizing(game, colony, planet, events) {
    if (!colony.colonizing) return;
    if (colony.colonizing.fleetId) return;  /* #66: gestita da fleet */
    colony.colonizing.duration = (colony.colonizing.duration || 0) - 1;
    if (colony.colonizing.duration <= 0) {
      completeColonization(game, colony, null, planet, events);
    }
  }

  /* Decisione #66: nave coloniale persa in scaramuccia/imboscata. Refund
     50% del costo coloniale + 50% del costo colonizzazione pagato. La
     colonizzazione viene annullata (se foundation in corso, pulisce
     colony.colonizing). L'ordine della flotta torna a idle.
     Recovery-friendly (#22): il giocatore non perde tutto, può rimettersi
     in piedi. Le risorse vengono restituite alla colonia origine (payerKey
     salvato in fleet._colonizePaidCost al setOrder). */
  function handleColonialLost(game, fleet, events) {
    const memo = fleet._colonizePaidCost;
    if (!memo) return;
    const payer = game.colonies && game.colonies[memo.payerKey];
    /* Decisione #66 estensione (P0 sessione 2026-06-09):
       50% dei coloni a bordo si salva in scialuppa di salvataggio e
       torna alla colonia origine (recovery-friendly #22, analogo al
       crew M07 esploratore #39). Capped al popCap della destinazione.
       Quel che eccede è perso. */
    let popSaved = 0;
    if (payer && fleet.popOnboard > 0) {
      popSaved = Math.floor((fleet.popOnboard || 0) / 2);
      if (popSaved > 0 && payer.pop) {
        const cap = payer.pop.cap || 0;
        const popNow = payer.pop.total || 0;
        const room = Math.max(0, cap - popNow);
        const added = Math.min(popSaved, room);
        payer.pop.total = popNow + added;
        if (added < popSaved) popSaved = added;  /* overflow scartato (no spazio) */
        if (added > 0) addToBestClass(payer, added);
      }
      fleet.popOnboard = 0;
    }
    if (payer && payer.stock) {
      const refund = {};
      ['met', 'en', 'food', 'water'].forEach(function (k) {
        const colCost = (memo.colonization && memo.colonization[k]) || 0;
        const shipCost = (memo.coloniale && memo.coloniale[k]) || 0;
        refund[k] = Math.round((colCost + shipCost) * 0.5);
        payer.stock[k] = (payer.stock[k] || 0) + refund[k];
      });
      events.push({
        kind: 'fleet-colonize-failed',
        fleetId: fleet.id, fleetName: fleet.name,
        systemId: fleet.location ? fleet.location.systemId : null,
        bodyKey: fleet.orders && fleet.orders.bodyKey,
        reason: 'coloniale-lost',
        refund: refund,
        popSaved: popSaved,
        payerKey: memo.payerKey,
        impulso: game.timeImpulsi
      });
    }
    /* Se il foundation era già iniziato, libera la colonia (annulla). */
    if (fleet.orders && fleet.orders.type === 'colonize') {
      const bk = fleet.orders.bodyKey;
      const sysId = fleet.orders.toSysId;
      if (bk != null && sysId != null) {
        const colKey = sysId + ':' + bk;
        const colony = game.colonies && game.colonies[colKey];
        if (colony && colony.colonizing && colony.colonizing.fleetId === fleet.id) {
          colony.colonizing = null;
        }
      }
    }
    /* Reset ordine flotta. */
    if (fleet.orders) fleet.orders = { type: 'idle' };
    fleet._colonizePaidCost = null;
  }

  /* Decisione #66: helper esportato per completare la colonizzazione
     (stock+pop iniziali coerenti). Chiamato sia da processColonizing
     (legacy path) sia da fleet.tickColonizePhase (foundation done).
     Idempotente: se già colonizzata, no-op.
     Recovery-friendly: applica il contratto minimo M05. */
  function completeColonization(game, colony, colonyKey, planet, events, opts) {
    if (!colony) return;
    if (colony.colonized) return;
    colony.colonized = true;
    colony.colonizedDS = currentDS(game);
    colony.pop = colony.pop || { total: 0, cap: 0, classes: { operai: 0, scienziati: 0, militari: 0, mercanti: 0, tecnici: 0 } };
    /* Decisione #66 estensione (sessione 2026-06-09): seedLevels permette
       di nascere con più di 1 livello se la nave coloniale ha trasportato
       coloni. Default = 1 (founding cold). Capped al popCap del pianeta. */
    const seed = (opts && opts.seedLevels) ? Math.max(1, opts.seedLevels | 0) : 1;
    const cap = (colony.pop.cap || (planet && planet.popCap) || seed);
    colony.pop.total = Math.min(seed, Math.max(1, cap));
    addToBestClass(colony, colony.pop.total);
    colony.stock = { met: 40, en: 30, food: 20, water: 20 };
    colony.colonizing = null;
    if (events) {
      events.push({
        kind: 'colony-done',
        colony: colony, planet: planet,
        colKey: colonyKey || null,
        seedLevels: colony.pop.total,
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
    /* Bilanciamento 2026-06-16: drenaggio met/en da popolazione (servizi
       residenziali). Solo in fase operational, come food/water. */
    const popEnDemand  = (colony.phase !== 'settling') ? (pop.total || 0) * CFG.POP_EN_PER_UNIT  : 0;
    const popMetDemand = (colony.phase !== 'settling') ? (pop.total || 0) * CFG.POP_MET_PER_UNIT : 0;
    /* Decisione utente 2026-06-11: manutenzione navi PARCHEGGIATE all'Hangar
       (riparazione/mantenimento) → drain metalli sulla colonia. Le navi
       dispiegate non pagano qui (riserva di viaggio a 4 risorse, viveri). */
    const F = root.ORION && root.ORION.fleet;
    /* Decisione utente 2026-06-17: durante l'Insediamento lo scafo di partenza
       (e qualunque altra nave eventualmente presente) NON paga manutenzione,
       speculare al crewPortConsumption già gated più sotto. La fase coincide
       con la stabilizzazione della colonia: niente drain di metalli/energia
       finché phase === 'settling'. */
    const settlingNow = (colony.phase === 'settling');
    const shipMetMaint = (!settlingNow && F && F.portMaintenance) ? F.portMaintenance(game, colony) : 0;
    /* Bilanciamento 2026-06-16: manutenzione energetica delle navi capitali al
       porto (incrociatore/dreadnought/ammiraglia). 0 se nessuna capitale. */
    const shipEnMaint = (!settlingNow && F && F.portMaintenanceEn) ? F.portMaintenanceEn(game, colony) : 0;
    /* Riparazione navi al porto (richiesta utente 2026-06-16): le flotte
       ferme al sistema di una colonia con Hangar recuperano wear nel
       tempo. Il costo metalli è proporzionale al wear effettivamente
       riparato, sommato al normale shipMetMaint sopra. Se wear=0 ovunque,
       costo=0 (niente drain inutile). */
    const shipRepairMet = (!settlingNow && F && F.tickPortRepair) ? F.tickPortRepair(game, colony) : 0;
    /* Razioni equipaggio al porto (decisione 2026-06-15): drain cibo/acqua
       sulla colonia per crews idle + crews di flotte parcheggiate. Solo
       operational (durante settling, decisione #27, gli equipaggi non sono
       ancora a regime). */
    const E = root.ORION && root.ORION.expedition;
    const crewPort = (E && E.crewPortConsumption && colony.phase !== 'settling')
      ? E.crewPortConsumption(game, colony) : { food: 0, water: 0 };
    const CF_yield = root.ORION && root.ORION.colonyFigure;
    const yieldM = (CF_yield && CF_yield.yieldMul) ? CF_yield.yieldMul(colony) : 1;
    const net = {};
    ['met', 'en', 'food', 'water'].forEach(function (k) {
      let r = (out.rates[k] || 0) * malus * wMalus * warM * settling;
      if ((k === 'met' || k === 'en') && yieldM !== 1) r *= yieldM;
      const u = out.upkeep[k] || 0;
      let n = r - u;
      if (k === 'met')   n -= shipMetMaint + shipRepairMet + popMetDemand;
      if (k === 'en')    n -= shipEnMaint  + popEnDemand;
      if (k === 'food')  n -= popFoodDemand  + crewPort.food;
      if (k === 'water') n -= popWaterDemand + crewPort.water;
      net[k] = n;
      stock[k] = (stock[k] || 0) + net[k];
      if (stock[k] < 0) stock[k] = 0;     // i negativi diventano "carestia"
    });
    // Ricerca: accumulo lifetime (pista Ascensione tech §23) + finanziamento
    // del progetto attivo (M13, decisione #57). Il tasso modulato dalla
    // scarsità (come l'accumulo storico) alimenta il pool d'impero.
    if (out.rates.research) {
      /* M13 Fase B (decisione #57): tech informatica = +X% velocità ricerca
         (modificatore passivo). Applicato uniformemente a funding + ETA +
         accumulo lifetime per coerenza. */
      const researchMul = (root.ORION.research && root.ORION.research.mods)
        ? root.ORION.research.mods(game).researchMul : 1;
      const research = out.rates.research * malus * researchMul;
      colony.researchAccum = (colony.researchAccum || 0) + research;
      if (root.ORION.research) {
        root.ORION.research.fund(game, research);
        if (game.research) game.research._rateAccum = (game.research._rateAccum || 0) + research;
      }
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
     Recovery automatico dopo N Impulsi di rete positiva.

     DECISIONE #45 emenda v3: le soglie sono RELATIVE al consumo (runway in Ι)
     non più assolute. Una soglia 20 cibo è banale per pop bassa e si esaurisce
     in 1 Ι con miliardi di abitanti — non scalabile. Ora:
       - crit: stock = 0 (esaurito) E saldo neg
       - low:  runway < POP_RUNWAY_LOW (30 Ι) E saldo neg
     Coerente con processPopulation (stesso threshold runway).
     Per metalli/energia, il drain è l'upkeep strutture: stesso meccanismo. */
  function processScarcity(game, colony, planet, prod, events) {
    if (!prod) return;
    const scar = ensureScarcity(colony);
    const stock = colony.stock;
    const net = prod.net;
    ['met', 'en', 'food', 'water'].forEach(function (k) {
      const cur = scar[k];
      const s = stock[k];
      const n = net[k];
      const drain = n < 0 ? -n : 0;
      const runway = drain > 0 ? s / drain : Infinity;
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
      } else if (runway < CFG.POP_RUNWAY_LOW && n < 0) {
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

  /* Capacità abitativa + sovraffollamento — funzione PURA riusata sia da
     `colonyMorale` (calcolo penalità), sia dalla UI (badge tab Popolazione,
     riga esplicita nel pannello, cronaca con isteresi). Estratta per
     evitare duplicazione tra time.js e main.js (single source). */
  function colonyHousing(_game, colony) {
    if (!colony) return { cap: 0, total: 0, crowd: 0, penalty: 1, over: false };
    const structures = colony.structures || {};
    const pop = colony.pop || { total: 0 };
    const habit = (structures['centro-abitativo'] && structures['centro-abitativo'].level) || 0;
    const hosp = (structures['ospedale'] && structures['ospedale'].level) || 0;
    const Sm = root.ORION.structures;
    const cap = CFG.POP_HOUSING_BASE
      + (habit > 0 ? Sm.moduleSum(habit) : 0) * CFG.POP_HOUSING_PER_LEVEL
      + (hosp > 0 ? Sm.moduleSum(hosp) : 0) * CFG.POP_HOSPITAL_HOUSING;
    const total = pop.total || 0;
    const crowd = cap > 0 ? total / cap : 99;
    const penalty = crowd > CFG.POP_CROWD_START
      ? Math.max(0.05, 1 - (crowd - CFG.POP_CROWD_START) * CFG.POP_CROWD_SLOPE)
      : 1;
    return { cap: cap, total: total, crowd: crowd, penalty: penalty, over: crowd > CFG.POP_CROWD_START };
  }

  /* Morale di colonia §9.3 — funzione PURA (nessuna scrittura sullo stato),
     single source of truth riusata sia dal loop crescita popolazione sia
     dalla Dashboard Impero (M07.3, decisione #62). Replica esatta del
     calcolo storico inline: base + pianeta base + centri abitativi (cap),
     malus temporaneo da smantellamento (decadimento lineare), penalità
     "allerta" su cibo/acqua, crollo da sovraffollamento. Read-only: legge
     `colony._scar` senza forzarne la creazione (così una chiamata di display
     non muta lo stato → determinismo #5 preservato). */
  function colonyMorale(game, colony) {
    if (!colony) return 1;
    const scar = colony._scar || { food: { state: 'ok' }, water: { state: 'ok' } };
    const structures = colony.structures || {};
    let morale = 1.0;
    if (colony.isHomeBase) morale += CFG.POP_MORALE_HOMEBASE;
    const habit = (structures['centro-abitativo'] && structures['centro-abitativo'].level) || 0;
    morale += Math.min(CFG.POP_MORALE_MAX - 1.0, habit * CFG.POP_MORALE_HABITATION);
    if (morale > CFG.POP_MORALE_MAX) morale = CFG.POP_MORALE_MAX;
    // malus temporaneo da smantellamento: decadimento lineare (solo se ancora attivo)
    if (colony.moraleMalus && game && game.timeImpulsi < colony.moraleMalus.expiresAt) {
      const mm = colony.moraleMalus;
      const span = mm.expiresAt - mm.startedAt;
      const left = mm.expiresAt - game.timeImpulsi;
      morale -= mm.amount * (left / span);
      if (morale < 0.2) morale = 0.2;
    }
    // penalità "allerta" su cibo/acqua
    if (scar.food.state === 'low' || scar.water.state === 'low') morale *= 0.6;
    // sovraffollamento (cancello strutturale implicito, decisione #37bis):
    // moltiplica per la penalità calcolata da colonyHousing (single source).
    morale *= colonyHousing(game, colony).penalty;
    return morale;
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
      /* Morale (decisione #62): calcolato dall'helper puro `colonyMorale`
         (single source riusata dalla Dashboard Impero). Prima azzeriamo
         l'eventuale malus scaduto — side-effect storico del loop, mantenuto
         qui per preservare il comportamento esatto (l'helper è read-only). */
      if (colony.moraleMalus && game.timeImpulsi >= colony.moraleMalus.expiresAt) {
        colony.moraleMalus = null;
      }
      let morale = colonyMorale(game, colony);
      const CF_civ = root.ORION && root.ORION.colonyFigure;
      if (CF_civ && CF_civ.moraleBonus) morale += CF_civ.moraleBonus(colony);

      let growth = CFG.POP_GROWTH_BASE * morale;
      if (colony.structures['ospedale']) growth *= (1 + CFG.POP_GROWTH_HOSPITAL);
      if (CF_civ && CF_civ.popGrowthMul) growth *= CF_civ.popGrowthMul(colony);

      /* Decisione #66 estensione (sessione 2026-06-09): Bonus Diaspora —
         dopo un imbarco di coloni, la colonia sorgente ha crescita ×2 per
         60 Ι. Compensa il "crollo display" del trasferimento facendo
         risalire rapidamente la pop ai livelli pre-imbarco. Vive in
         colony.diaspora { until, multiplier }. Auto-cleanup a scadenza. */
      if (colony.diaspora && colony.diaspora.until != null) {
        if (game.timeImpulsi <= colony.diaspora.until) {
          growth *= (colony.diaspora.multiplier || 2.0);
        } else {
          colony.diaspora = null;
        }
      }

      /* M13 Fase B (decisione #57): tech biologia = +X% crescita popolazione
         (modificatore passivo, zero nuove strutture). */
      if (root.ORION.research && root.ORION.research.mods) {
        growth *= root.ORION.research.mods(game).popGrowthMul;
      }

      /* Capacità di carico (DECISIONE #45 emenda v3): il consumo pop è
         drenato in processProduction. La crescita NON è gata sul saldo
         istantaneo né su soglie assolute (es. "20 cibo" è banale per pop
         bassa, esaurito in 1 Ι con miliardi) — ma sul RUNWAY: quanti Ι
         di consumo coprono le scorte attuali.
           - runway > POP_RUNWAY_LOW (30 Ι): pieno regime
           - runway POP_RUNWAY_CRIT..POP_RUNWAY_LOW (10..30): rallentato 0.3
           - runway < POP_RUNWAY_CRIT (10 Ι) o stock=0: fermo
         Threshold relativo: scala automaticamente da pop piccola a miliardi.
         Buffer 30 Ι di pop-loss (#22) resta sopra (`scar.famineI`). */
      const drainF = Math.max(0, -(prod.net.food || 0));
      const drainW = Math.max(0, -(prod.net.water || 0));
      const runwayF = drainF > 0 ? (colony.stock.food || 0) / drainF : Infinity;
      const runwayW = drainW > 0 ? (colony.stock.water || 0) / drainW : Infinity;
      const runway = Math.min(runwayF, runwayW);
      let supplyFactor;
      if ((colony.stock.food || 0) <= 0 || (colony.stock.water || 0) <= 0) {
        supplyFactor = 0;
      } else if (runway < CFG.POP_RUNWAY_CRIT) {
        supplyFactor = 0;
      } else if (runway < CFG.POP_RUNWAY_LOW) {
        supplyFactor = 0.3;
      } else {
        supplyFactor = 1;
      }

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

    /* Cronaca sovraffollamento con isteresi (entra ≥ 0.85, esce ≤ 0.78) —
       solo per colonie dove il giocatore *vorrebbe* far crescere la pop:
       mondi-giardino (decisione #38) o colonia con Centro Abitativo costruito
       (segno deliberato di investimento sulla popolazione). Sulle altre il
       sovraffollamento è accettato implicitamente (colonie estrattive) e
       non genera rumore. Stato persistito in `colony.crowdAlert` (additivo,
       lazy-init: undefined → false, niente bump schema). */
    const h = colonyHousing(game, colony);
    const wantsGrowth = isGrowthColony(colony, planet);
    if (wantsGrowth) {
      const wasAlert = !!colony.crowdAlert;
      if (!wasAlert && h.crowd >= CROWD_ALERT_ENTER) {
        colony.crowdAlert = true;
        events.push({
          kind: 'pop-crowd', colony: colony, planet: planet, impulso: game.timeImpulsi,
          crowd: h.crowd, penalty: h.penalty, cap: h.cap, total: h.total
        });
      } else if (wasAlert && h.crowd <= CROWD_ALERT_EXIT) {
        colony.crowdAlert = false;
        events.push({
          kind: 'pop-crowd-recover', colony: colony, planet: planet, impulso: game.timeImpulsi
        });
      }
    } else if (colony.crowdAlert) {
      // Smette di voler crescere (es. centro abitativo smantellato su mondo non-giardino)
      // → spegni l'allerta senza generare evento di "rientro".
      colony.crowdAlert = false;
    }
  }

  /* Soglie isteresi sovraffollamento — separate per evitare ping-pong.
     Entra ≥ 0.85 (pop > 85% del cap → penalità già ~−12%); esce ≤ 0.78
     (sotto la soglia POP_CROWD_START 0.80, con un margine). */
  const CROWD_ALERT_ENTER = 0.85;
  const CROWD_ALERT_EXIT  = 0.78;

  /* Mondo-giardino o colonia con investimento abitativo deliberato? */
  function isGrowthColony(colony, planet) {
    if (!colony || !planet) return false;
    if (planet.type === 'terrestre' || planet.type === 'oceanico' || planet.type === 'forestale') return true;
    const habit = colony.structures && colony.structures['centro-abitativo'];
    return !!(habit && habit.level > 0);
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

    /* #48 Fase 1: modificatori passivi dalla ricerca (Ecologia → meno
       generazione; Riciclo avanzato → più trattamento/capacità) + bonus per
       mondo ostile. recycleMul (eff tech × bonus corpo) è memorizzato per
       wasteCapacity/UI. */
    const eco = (root.ORION.research && root.ORION.research.mods) ? root.ORION.research.mods(game) : null;
    const genMul = eco ? (eco.wasteGenMul || 1) : 1;   // <1 con Ecologia
    const effMul = eco ? (eco.wasteEffMul || 1) : 1;   // >1 con Riciclo avanzato
    const recycleMul = effMul * recycleBodyBonus(planet);
    waste.recycleMul = recycleMul;

    // 1) Generazione (popolazione SUPER-LINEARE K·pop²) + 2) industria/trattamento
    //    Super-lineare: a pop bassa è trascurabile, conta solo vicino al cap.
    const pt = colony.pop.total || 0;
    let gen = pt * pt * CFG.WASTE_POP_K;
    let process = 0;
    let recyLevel = 0;   // livello dell'impianto di riciclo (per l'efficienza energia)
    Object.keys(colony.structures || {}).forEach(function (id) {
      const def = S.get(id);
      if (!def) return;
      const lvl = colony.structures[id].level || 1;
      const msum = S.moduleSum(lvl);
      const wcat = CFG.WASTE_BY_CAT[def.cat];
      if (wcat) gen += wcat * msum;
      if (def.wasteProcess) { process += def.wasteProcess * msum * recycleMul; if (lvl > recyLevel) recyLevel = lvl; }
    });
    gen *= genMul;

    const before = waste.stock || 0;
    let after = before + gen - process;
    if (after < 0) after = 0;
    // energia recuperata = rifiuti EFFETTIVAMENTE trattati × resa.
    // Resa cresce col livello del riciclo (+WASTE_EFF_PER_LEVEL/livello, decisione #48):
    // un impianto più potenziato estrae più energia per unità bruciata.
    const processed = Math.max(0, (before + gen) - after);
    const effYield = CFG.WASTE_ENERGY_YIELD * (1 + CFG.WASTE_EFF_PER_LEVEL * Math.max(0, recyLevel - 1));
    const energyGain = (processed > 0 && effYield > 0) ? processed * effYield : 0;
    if (energyGain > 0) {
      colony.stock.en = (colony.stock.en || 0) + energyGain;
    }
    waste.stock = after;
    waste.net = gen - process;
    /* Guadagno energia temporaneo da riciclo, finché ci sono rifiuti da
       bruciare — esposto alla UI (decisione #48). */
    waste.energyGain = energyGain;

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
          /* M15: il varo di una nave capitale è un evento notevole (auto-pausa
             ON), il resto resta frequente/silenzioso (ship-built OFF). */
          const isCapital = (k === 'incrociatore' || k === 'dreadnought' || k === 'ammiraglia');
          events.push({
            kind: isCapital ? 'capital-built' : 'ship-built',
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

  /* Decisione intra-sistema: sorveglianza per le flotte in `garrison`.
     A ogni tick, per ogni flotta che osserva un pianeta, verifica se nel
     sistema target è apparsa una presenza ostile (covo pirata, civ AI
     ostile, incursione inbound già visibile). Se sì emette
     `garrison-threat-detected` UNA SOLA VOLTA per minaccia distinta
     (anti-spam tramite `fleet._garrisonNotified`).
     L'evento è ON in auto-pausa di default (decisione #31): l'utente
     decide il da farsi via overlay (Ingaggia / Ritira / Resta).
     Recovery-friendly: nessun ingaggio automatico, nessun fail-state. */
  function processGarrisonThreats(game, events) {
    if (!Array.isArray(game.fleets) || !game.fleets.length) return;
    const CO = root.ORION.combat;
    if (!CO || !CO.hostilePresenceAt) return;
    for (let i = 0; i < game.fleets.length; i++) {
      const f = game.fleets[i];
      if (!f || !f.orders || f.orders.type !== 'garrison') continue;
      if (!f.location || f.location.status === 'in-transit') continue;
      const sysId = f.location.systemId;
      if (sysId == null) continue;
      const hostile = CO.hostilePresenceAt(game, sysId);
      const key = String(sysId);
      if (!hostile) {
        /* Minaccia rientrata → resetta il flag così una nuova minaccia
           riavvisa l'utente. */
        if (f._garrisonNotified && f._garrisonNotified[key]) {
          delete f._garrisonNotified[key];
        }
        continue;
      }
      if (!f._garrisonNotified) f._garrisonNotified = {};
      if (f._garrisonNotified[key]) continue;
      f._garrisonNotified[key] = game.timeImpulsi || 0;
      events.push({
        kind: 'garrison-threat-detected',
        fleetId: f.id, fleetName: f.name,
        systemId: sysId, bodyKey: f.location.bodyKey || (f.orders && f.orders.bodyKey) || null,
        impulso: game.timeImpulsi
      });
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
      /* Decisione intra-sistema: se l'attack ha `attackBodyKey`, cerca la
         civ che possiede QUEL pianeta specifico (sistemi condivisi #52).
         Fallback su `civForSystem` per attacchi che non specificano il body. */
      let civ = null;
      if (fleet.attackBodyKey && root.ORION.ai && root.ORION.ai.civForPlanet) {
        civ = root.ORION.ai.civForPlanet(game, sysId, fleet.attackBodyKey);
      }
      if (!civ) {
        civ = (root.ORION.ai && root.ORION.ai.civForSystem) ? root.ORION.ai.civForSystem(game, sysId) : null;
      }
      /* La flotta ingaggia una civiltà se questa è già ostile OPPURE se il
         giocatore ha dato un ordine d'attacco esplicito su questo sistema
         (M09 — decisione #49: aggressione offensiva, anche contro neutrali). */
      const civAttacked = civ && civ.alive && fleet.attackTarget === sysId;
      const civHostile = civ && civ.alive && (civ.disposition <= -40);

      let enemy = null, enemyKind = null;
      if (nest) { enemy = C.forceFromPirateNest(nest); enemyKind = 'pirate'; }
      else if ((civHostile || civAttacked) && root.ORION.ai.materialize) {
        enemy = C.forceFromMaterialized(root.ORION.ai.materialize(game, civ, sysId), 'B');
        enemyKind = 'ai';
        /* Aggressione contro una civiltà non già ostile: la relazione si
           deteriora (la diplomazia piena è M11). */
        if (civAttacked && !civHostile) civ.disposition = Math.max(-100, civ.disposition - 25);
        /* Coesione #54: attaccare un membro di un sistema coeso indispone
           anche gli ALTRI proprietari (solidarietà locale, −15 ciascuno). */
        if (civAttacked && root.ORION.cohesion && root.ORION.cohesion.applyAttackPenalty) {
          const nSolid = root.ORION.cohesion.applyAttackPenalty(game, sysId, civ.id);
          if (nSolid > 0) {
            events.push({ kind: 'cohesion-attack-backlash', sysId: sysId,
              attackedName: civ.name, count: nSolid, impulso: game.timeImpulsi });
          }
        }
      }
      /* M16 Fase B (#81): RICONQUISTA di una stazione catturata. Una flotta
         armata che ATTACCA esplicitamente il sistema ingaggia il presidio AI;
         vincendo riprende la stazione (recovery-friendly). */
      let retakeTarget = null;
      if (!enemy && root.ORION.station && root.ORION.station.capturedStationAt) {
        const capSt = root.ORION.station.capturedStationAt(game, sysId);
        if (capSt && fleet.attackTarget === sysId) {
          enemy = C.forceFromStation(game, capSt, 'B');
          enemyKind = 'captured-station';
          retakeTarget = capSt;
        }
      }
      if (!enemy) {
        if (fleet.attackTarget === sysId) { fleet.attackTarget = null; fleet.attackBodyKey = null; }
        continue;
      }

      fleet.combatResolvedAt = sysId;
      const A = C.forceFromFleet(game, fleet, 'A');
      /* M16 (#81): una tua STAZIONE nel sistema combatte al fianco della
         flotta (chokepoint fortificato). Le sue piattaforme si aggiungono
         al lato A; l'hp residuo è riscritto dopo lo scontro. */
      let coStation = null;
      if (root.ORION.station && root.ORION.station.playerStationAt) {
        const ms = root.ORION.station.playerStationAt(game, sysId);
        if (ms && ms.phase !== 'building' && ms.level >= 1) {
          const sf = C.forceFromStation(game, ms, 'A');
          if (sf.combatants.length) { A.combatants = A.combatants.concat(sf.combatants); coStation = ms; }
        }
      }
      const battleId = (game.timeImpulsi || 0) + ':' + sysId + ':' + fleet.id;
      const report = C.resolve(game, battleId, A, enemy);
      report.kind = 'skirmish';
      report.systemId = sysId;
      report.enemyKind = enemyKind;

      // Decisione #66: snapshot pre-combat per detection nave coloniale persa.
      const hadColonial = fleet._colonizePaidCost &&
        fleet.ships && fleet.ships.some(function (s) { return s.kind === 'coloniale'; });
      // Applica esito alla flotta del giocatore (perdite permanenti, +xp)
      const fleetOutcome = C.applyOutcomeToFleet(game, fleet, A);
      // M16 (#81): scrivi l'hp residuo / distruzione della stazione co-combattente
      if (coStation) { applyStationCombatOutcome(game, coStation, report._A, events); coStation._defendedAt = game.timeImpulsi; }
      const playerWon = (report.winner === 'A');
      /* Servizio (decisione utente 2026-06-11): scaramuccia vinta → +1 xp
         all'equipaggio aderente alla flotta sopravvissuta. */
      if (playerWon && root.ORION.fleet && root.ORION.fleet.awardCrewXp) {
        root.ORION.fleet.awardCrewXp(game, fleet, 1, events, 'combat');
      }
      /* M14 (#75) → M15: tutte le figure di flotta maturano in battaglia (§12.3). */
      if (playerWon && root.ORION.commander && root.ORION.commander.grantFleetXp) {
        root.ORION.commander.grantFleetXp(game, fleet, 1, events);
      }
      // Decisione #66: refund 50% se la coloniale è stata persa nel scontro.
      if (hadColonial) {
        const stillColonial = fleet.ships && fleet.ships.some(function (s) { return s.kind === 'coloniale'; });
        if (!stillColonial) handleColonialLost(game, fleet, events);
      }

      // M16 Fase B (#81): riconquista riuscita → la stazione torna tua
      if (retakeTarget && playerWon && root.ORION.station) {
        root.ORION.station.retakeStation(retakeTarget);
        if (fleet.attackTarget === sysId) { fleet.attackTarget = null; fleet.attackBodyKey = null; }
        events.push({ kind: 'station-retaken', stationId: retakeTarget.id, name: retakeTarget.name,
          systemId: sysId, impulso: game.timeImpulsi });
      }

      // Effetti per tipo nemico
      if (enemyKind === 'pirate') {
        if (playerWon) {
          /* M10 Fase E: raid riuscito su un covo → TAGLIA (risorse) alla
             colonia origine della flotta. Bottino maggiore se il covo è
             sgominato (level → 0). Recovery-friendly: ricompensa positiva. */
          const lvlBefore = nest.level || 1;
          nest.level = lvlBefore - 1;
          const cleared = nest.level <= 0;
          grantPirateBounty(game, fleet, lvlBefore, cleared, sysId, events);
          if (cleared) {
            game.piracy.nests = game.piracy.nests.filter(function (n) { return n !== nest; });
          }
        }
      } else if (enemyKind === 'ai' && root.ORION.ai.demobilize) {
        // indebolisce la civiltà (la perdita di potenza vive in demobilize)
        root.ORION.ai.demobilize(game, civ, { winner: playerWon ? 'player' : 'civ', report: report });
        /* M09 Fase B (decisione #49): se il giocatore VINCE in un sistema
           POSSEDUTO dalla civiltà, ne arretra il confine (il sistema torna
           neutrale — l'occupazione vera è M11/M12). Verbo morale
           (ALIGNMENT_IMPACT #23): liberare un sistema da una civiltà MALIGNA
           è "light"; aggredire una buona/neutrale è "dark". */
        if (playerWon && civ.systems.indexOf(sysId) >= 0) {
          /* M13 B-2 (decisione #93): rimossa la "occupazione di sistema" di
             M11 Fase A — incoerente col modello multi-proprietà per body
             (#52). La perdita è MIRATA al body attaccato (`attackBodyKey`,
             se noto) o al primo pianeta della civ nel sistema. La presenza
             militare sul sistema si dichiara col PRESIDIO (ORION.garrison),
             non si subisce automaticamente.
             Verbo morale (#23): liberare un body da una civ maligna è
             "light"; aggredire una buona/neutrale è "dark". */
          const targetBodyKey = fleet.attackBodyKey || null;
          let removedAny = false;
          if (root.ORION.ai && root.ORION.ai.removePlanet && targetBodyKey) {
            const planetKey = sysId + ':' + targetBodyKey;
            if ((civ.planets || []).indexOf(planetKey) >= 0) {
              root.ORION.ai.removePlanet(civ, planetKey);
              removedAny = true;
            }
          }
          /* Fallback: nessun body specifico → rimuovi il primo pianeta che
             la civ possiede in questo sistema. */
          if (!removedAny && Array.isArray(civ.planets)) {
            for (let pp = 0; pp < civ.planets.length; pp++) {
              const pk = civ.planets[pp];
              if (pk && pk.indexOf(sysId + ':') === 0) {
                if (root.ORION.ai && root.ORION.ai.removePlanet) {
                  root.ORION.ai.removePlanet(civ, pk);
                }
                removedAny = true;
                break;
              }
            }
          }
          if (removedAny) {
            civ.power = Math.max(0, civ.power - 4);
            const impact = (civ.alignment === 'male') ? 'light' : 'dark';
            if (root.ORION.victory && root.ORION.victory.applyAlignment) {
              root.ORION.victory.applyAlignment(game, impact, 1);
            }
            if (impact === 'light') bumpIcg(game, -1); else bumpIcg(game, 2);
            report.alignmentImpact = impact;
            report.bodyLost = targetBodyKey || null;
          }
          if ((civ.planets || []).length === 0) {
            civ.alive = false;
            events.push({ kind: 'civ-fallen', civName: civ.name, conqueror: 'le tue forze', impulso: game.timeImpulsi });
          }
          /* M13 B-2 (decisione #93): tentativo di cattura tech. Chance
             maggiore se il vittorioso ha raidato un body specifico (più
             vicino ai laboratori); altrimenti scaramuccia spaziale. */
          if (root.ORION.research && root.ORION.research.tryCaptureTech) {
            const captureKind = (removedAny && targetBodyKey) ? 'raid' : 'skirmish';
            root.ORION.research.tryCaptureTech(game, civ, captureKind, events);
          }
        }
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
        /* Le figure si salvano (scialuppa, come il crew M07): tornano nel
           pool d'Impero invece di perdersi (recovery-friendly #22). */
        if (root.ORION.commander && root.ORION.commander.releaseAllFromFleet) {
          root.ORION.commander.releaseAllFromFleet(game, fleet);
        }
        game.fleets = game.fleets.filter(function (f) { return f !== fleet; });
      }

      // L'intento offensivo è stato consumato
      if (fleet.attackTarget === sysId) { fleet.attackTarget = null; fleet.attackBodyKey = null; }

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
      /* M10 Fase E: i raider non assediano una colonia — colpiscono una
         flotta esposta (scaramuccia lampo). Risolto e tolto dalla coda. */
      if (inc.kind === 'pirate-raider') { resolvePirateRaider(game, inc, events); continue; }
      if (!C) continue;
      /* M16 Fase B (#81): bersaglio STAZIONE — l'incursione apre un assedio
         multi-round contro la stazione (anziché una colonia). */
      const ST = root.ORION.station;
      const targetStation = (inc.targetStationId && ST) ? ST.stationById(game, inc.targetStationId) : null;
      const colonyKey = inc.targetStationId ? null : playerColonyKeyForSystem(game, inc.targetSysId);
      // bersaglio sparito (colonia persa o stazione distrutta/catturata) → svanisce
      if (inc.targetStationId) {
        if (!targetStation || !ST.isPlayerStation(targetStation) || targetStation.systemId !== inc.targetSysId) continue;
      } else if (!colonyKey) {
        continue;
      }
      /* Forza attaccante: pirati (Fase A) o civiltà AI materializzata (Fase B).
         Gli AI possono CONQUISTARE/RADERE; i pirati solo saccheggiare. */
      let atkForce, attackerKind, attackerCiv = null;
      if (inc.kind === 'ai' && root.ORION.ai && root.ORION.ai.materialize) {
        const civ = (game.civs || []).filter(function (c) { return c.id === inc.civId; })[0];
        const desc = root.ORION.ai.materialize(game, civ || { power: (inc.level || 1) * 30, civName: inc.civName, color: inc.civColor }, inc.targetSysId);
        atkForce = C.forceFromMaterialized(desc, 'A');
        atkForce.formation = 'balanced';
        attackerKind = 'ai'; attackerCiv = inc.civId;
      } else {
        atkForce = C.forceFromPirateNest({ level: inc.level || 1 });
        atkForce.formation = 'balanced';    // i predoni si sganciano se mauled
        attackerKind = 'pirate';
      }
      const battle = {
        id: inc.id, kind: (attackerKind === 'ai') ? 'siege-ai' : 'siege-pirate',
        attackerKind: attackerKind, attackerCiv: attackerCiv,
        systemId: inc.targetSysId, colonyKey: colonyKey,
        stationId: inc.targetStationId || null,   // M16 Fase B (#81)
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
        systemId: inc.targetSysId, colonyKey: colonyKey, stationId: inc.targetStationId || null,
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
      /* M16 Fase B (#81): assedio a una STAZIONE — difensore = forza stazione
         + flotte presenti, esito cattura/distruzione. */
      if (battle.stationId) {
        if (processStationBattle(game, battle, events) === 'ongoing') still.push(battle);
        continue;
      }
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
      // AL CORPO ASSEDIATO (in porto alla colonia o in orbita a quel corpo).
      // Una flotta che mina un'anomalia in un ALTRO corpo dello stesso sistema
      // resta al suo lavoro: l'assedio è sul pianeta, non sul sistema intero.
      // È compito del giocatore portar via per tempo gli estrattori parcheggiati
      // sulla colonia se non vuole rischiarli (recovery-friendly #22: la scelta
      // c'è, non è un fail-state nascosto).
      const defDef = C.forceFromDefenses(game, colony, colonyKey, 'B');
      const colonyBodyKey = (function () {
        const parts = String(colonyKey).split(':');
        return parts.length === 2 ? parts[1] : null;
      })();
      const F = root.ORION.fleet;
      const present = fleetsPresentAt(game, battle.systemId).filter(function (f) {
        const bk = (F && F.fleetCurrentBodyKey) ? F.fleetCurrentBodyKey(game, f) : null;
        return bk != null && bk === colonyBodyKey;
      });
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

      // niente difensori → vittoria attaccante diretta
      if (def.combatants.length === 0) {
        const oc = applySiegeWin(game, battle, colony, colonyKey, events);
        events.push({ kind: 'siege-end', battleId: battle.id, outcome: oc,
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
        if (battle.attackerKind === 'ai' && root.ORION.ai && root.ORION.ai.recordBattle) {
          root.ORION.ai.recordBattle(game, battle.attackerCiv, 'win', 'siege-defense', battle.systemId);
        }
        events.push({ kind: 'siege-end', battleId: battle.id, outcome: 'repelled',
          colonyKey: colonyKey, systemId: battle.systemId, impulso: game.timeImpulsi });
        grantSiegeVeterancy(game, present, events);
        continue;
      }
      if (defWiped) {
        const oc = applySiegeWin(game, battle, colony, colonyKey, events);
        events.push({ kind: 'siege-end', battleId: battle.id, outcome: oc,
          colonyKey: colonyKey, systemId: battle.systemId, impulso: game.timeImpulsi });
        continue;
      }
      // cap di sicurezza
      if (battle.round >= 12) {
        const win = C.totalHp(def) >= C.totalHp(atk);
        if (win) {
          warRegisterWin(game);
          if (battle.attackerKind === 'ai' && root.ORION.ai && root.ORION.ai.recordBattle) {
            root.ORION.ai.recordBattle(game, battle.attackerCiv, 'win', 'siege-defense', battle.systemId);
          }
          events.push({ kind: 'siege-end', battleId: battle.id, outcome: 'repelled',
            colonyKey: colonyKey, systemId: battle.systemId, impulso: game.timeImpulsi });
          grantSiegeVeterancy(game, present, events);
        } else {
          const oc = applySiegeWin(game, battle, colony, colonyKey, events);
          events.push({ kind: 'siege-end', battleId: battle.id, outcome: oc,
            colonyKey: colonyKey, systemId: battle.systemId, impulso: game.timeImpulsi });
        }
        continue;
      }
      still.push(battle);
    }
    game.battles = still;
  }

  function grantSiegeVeterancy(game, fleets, events) {
    const C = root.ORION.combat;
    if (!C) return;
    for (let i = 0; i < fleets.length; i++) {
      C.grantVeterancy(game, fleets[i]);
      /* Servizio (decisione utente 2026-06-11): assedio respinto → +1 xp
         all'equipaggio delle flotte che hanno difeso la colonia. */
      if (root.ORION.fleet && root.ORION.fleet.awardCrewXp) {
        root.ORION.fleet.awardCrewXp(game, fleets[i], 1, events, 'combat');
      }
      if (root.ORION.commander && root.ORION.commander.grantFleetXp) {
        root.ORION.commander.grantFleetXp(game, fleets[i], 1, events);
      }
    }
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

  /* M10 Fase E: taglia per aver colpito un covo pirata. Le risorse vanno
     alla colonia origine della flotta (o, se sparita, alla capitale / a una
     colonia qualsiasi). Bottino ∝ livello del covo + bonus se sgominato. */
  function grantPirateBounty(game, fleet, lvlBefore, cleared, sysId, events) {
    let colonyKey = fleet && fleet.ownerColonyKey;
    let colony = colonyKey && game.colonies && game.colonies[colonyKey];
    if (!colony || !colony.colonized) {
      // fallback: prima colonia colonizzata disponibile
      colonyKey = null; colony = null;
      const keys = Object.keys(game.colonies || {});
      for (let i = 0; i < keys.length; i++) {
        const c = game.colonies[keys[i]];
        if (c && c.colonized) { colonyKey = keys[i]; colony = c; break; }
      }
    }
    const reward = {
      met: 25 * lvlBefore + (cleared ? 40 : 0),
      en:  12 * lvlBefore + (cleared ? 20 : 0)
    };
    if (colony && colony.stock) {
      colony.stock.met = (colony.stock.met || 0) + reward.met;
      colony.stock.en = (colony.stock.en || 0) + reward.en;
    }
    events.push({
      kind: cleared ? 'pirate-cleared' : 'pirate-raid-won',
      colonyKey: colonyKey, reward: reward, level: lvlBefore,
      systemId: sysId, impulso: game.timeImpulsi
    });
  }

  /* M10 Fase E: risoluzione di un RAIDER pirata contro una flotta del
     giocatore (scaramuccia lampo all'arrivo). Se la preda non è più in orbita
     nel sistema bersaglio, il raider svanisce (recovery-friendly #22). */
  function resolvePirateRaider(game, inc, events) {
    const C = root.ORION.combat;
    if (!C) return;
    const fleet = (game.fleets || []).filter(function (f) {
      return f && f.id === inc.targetFleetId && f.location &&
             f.location.systemId === inc.targetSysId && f.location.status === 'orbiting';
    })[0];
    if (!fleet) {                       // preda fuggita → raider a vuoto
      events.push({ kind: 'raider-fizzle', targetSysId: inc.targetSysId, impulso: game.timeImpulsi });
      return;
    }
    const raider = C.forceFromPirateNest({ level: inc.level || 1 });
    raider.side = 'A'; raider.formation = 'balanced';
    const B = C.forceFromFleet(game, fleet, 'B');
    const battleId = 'raider:' + inc.id;
    const report = C.resolve(game, battleId, raider, B);
    report.kind = 'raider'; report.systemId = inc.targetSysId; report.enemyKind = 'pirate';
    const outcome = C.applyOutcomeToFleet(game, fleet, B);
    const playerWon = (report.winner === 'B');
    /* Servizio (decisione utente 2026-06-11): raider respinto → +1 xp crew. */
    if (playerWon && root.ORION.fleet && root.ORION.fleet.awardCrewXp) {
      root.ORION.fleet.awardCrewXp(game, fleet, 1, events, 'combat');
    }
    if (playerWon && root.ORION.commander && root.ORION.commander.grantFleetXp) {
      root.ORION.commander.grantFleetXp(game, fleet, 1, events);
    }
    if (outcome.lost > 0) warRegisterLoss(game, outcome.lost * CFG.WAR_MORALE_PER_SHIP, outcome.lost * CFG.WAR_PRESSURE_PER_LOSS);
    if (playerWon) warRegisterWin(game);
    else warRegisterLoss(game, CFG.WAR_MORALE_PER_DEFEAT, CFG.WAR_PRESSURE_PER_LOSS);
    // flotta annientata → figure in salvo, rimuovi
    if (fleet.ships.length === 0) {
      if (root.ORION.commander && root.ORION.commander.releaseAllFromFleet) {
        root.ORION.commander.releaseAllFromFleet(game, fleet);
      }
      game.fleets = game.fleets.filter(function (f) { return f !== fleet; });
    }
    events.push({
      kind: 'raider-hit', report: report,
      fleetId: fleet.id, fleetName: fleet.name,
      playerWon: playerWon, lost: outcome.lost, promoted: outcome.promoted,
      systemId: inc.targetSysId, impulso: game.timeImpulsi
    });
  }

  /* M09 Fase B (decisione #49): esito di una vittoria attaccante. I pirati
     SACCHEGGIANO (non tengono territorio); le civiltà AI CONQUISTANO o
     RADONO secondo l'allineamento (predoni → rasa; altri → conquista).
     Ritorna l'outcome ('looted'|'conquered'|'razed'). */
  function applySiegeWin(game, battle, colony, colonyKey, events) {
    if (battle.attackerKind === 'ai') {
      const civ = (game.civs || []).filter(function (c) { return c.id === battle.attackerCiv; })[0];
      /* M10 Fase C (decisione #47): l'assedio AI è andato a segno → intel
         "sconfitta subita" nel dossier (perdita dal punto di vista del giocatore). */
      if (root.ORION.ai && root.ORION.ai.recordBattle) {
        root.ORION.ai.recordBattle(game, battle.attackerCiv, 'loss', 'siege-attack', colony.systemId);
      }
      const wasCapital = isCapitalColony(game, colonyKey);
      const sysId = colony.systemId;
      const raze = civ && civ.trait === 'predoni';
      // morale crollo (catena della spirale C): doppio + extra se capitale
      warRegisterLoss(game, CFG.WAR_MORALE_PER_LOOT * 2 + (wasCapital ? 0.10 : 0), CFG.WAR_PRESSURE_PER_LOSS * 1.5);
      if (raze) {
        removeColony(game, colonyKey, events);
        bumpIcg(game, 3);
        events.push({ kind: 'colony-razed', colonyKey: colonyKey, systemId: sysId,
          civName: civ ? civ.name : battle.attacker.name, wasCapital: wasCapital, impulso: game.timeImpulsi });
        return 'razed';
      }
      // conquista: il pianeta conquistato passa alla civiltà (#52: civ.planets canonical)
      if (civ && civ.alive) {
        const bodyKey = (colonyKey && colonyKey.indexOf(':') > 0)
          ? colonyKey.slice(colonyKey.indexOf(':') + 1) : 'b0';
        if (root.ORION.ai && root.ORION.ai.addPlanet) {
          root.ORION.ai.addPlanet(civ, sysId, bodyKey);
        } else {
          civ.systems = civ.systems || [];
          if (civ.systems.indexOf(sysId) < 0) civ.systems.push(sysId);
        }
        civ.power += 15;
      }
      removeColony(game, colonyKey, events);
      bumpIcg(game, 4);
      events.push({ kind: 'colony-conquered', colonyKey: colonyKey, systemId: sysId,
        civName: civ ? civ.name : battle.attacker.name, wasCapital: wasCapital, impulso: game.timeImpulsi });
      return 'conquered';
    }
    // pirati → saccheggio
    applyLoot(game, colony, colonyKey, events);
    return 'looted';
  }

  /* M16 Fase B (#81): un round d'assedio contro una stazione. Difensore =
     forza della stazione + flotte presenti (rinforzi/ritirate contano).
     Esito a difensore annientato: pirata → distrutta, AI → catturata
     (passa alla civiltà, riconquistabile). Recovery-friendly (#22). */
  function processStationBattle(game, battle, events) {
    const C = root.ORION.combat, ST = root.ORION.station;
    const st = ST && ST.stationById(game, battle.stationId);
    if (!st || !ST.isPlayerStation(st) || st.systemId !== battle.systemId) {
      events.push({ kind: 'siege-end', battleId: battle.id, outcome: 'lifted',
        stationId: battle.stationId, systemId: battle.systemId, impulso: game.timeImpulsi });
      return 'done';
    }
    if ((game.timeImpulsi || 0) < battle.nextRoundAt) return 'ongoing';
    battle.round++;
    battle.nextRoundAt = (game.timeImpulsi || 0) + C.CFG.ROUND_EVERY_I;
    st._underAttack = true;

    const atk = {
      side: 'A', name: battle.attacker.name, color: battle.attacker.color,
      immobile: false, formation: battle.attacker.formation || 'balanced',
      combatants: battle.attacker.combatants
    };
    const sf = C.forceFromStation(game, st, 'B');
    const present = fleetsPresentAt(game, battle.systemId);
    const defShips = [];
    for (let i = 0; i < present.length; i++) {
      const ff = C.forceFromFleet(game, present[i], 'B');
      for (let j = 0; j < ff.combatants.length; j++) defShips.push(ff.combatants[j]);
    }
    const def = {
      side: 'B', name: st.name, color: '#7fc4ff',
      immobile: defShips.length === 0, formation: 'defensive',
      combatants: sf.combatants.concat(defShips)
    };

    const rng = ORION.rng.makeRng((game.seed || '') + ':battle:' + battle.id + ':' + battle.round);
    const startAtkHp = C.totalHp(atk);
    const r = C.resolveRound(rng, atk, def);

    // writeback: hp stazione (combatant sopravvissuto) + perdite navi
    let stationAlive = false;
    for (let i = 0; i < def.combatants.length; i++) {
      const c = def.combatants[i];
      if (c.src && c.src.type === 'station') { stationAlive = true; st.hp = Math.max(1, Math.round(c.hp)); }
    }
    const wb = C.applyDefenderWriteback(null,
      def.combatants.filter(function (c) { return c.src && c.src.type === 'ship'; }),
      r.destroyedB.filter(function (c) { return c.src && c.src.type === 'ship'; }));
    if (wb.shipsLost > 0) warRegisterLoss(game, wb.shipsLost * CFG.WAR_MORALE_PER_SHIP, wb.shipsLost * CFG.WAR_PRESSURE_PER_LOSS);

    battle.log.push({ round: battle.round, lostDef: r.destroyedB.length, lostAtk: r.destroyedA.length,
      atkHp: Math.round(C.totalHp(atk)), defHp: Math.round(C.totalHp(def)) });
    events.push({ kind: 'siege-round', battleId: battle.id, round: battle.round,
      stationId: st.id, systemId: battle.systemId, atk: C.totalHp(atk), def: C.totalHp(def),
      lostDef: r.destroyedB.length, lostAtk: r.destroyedA.length, impulso: game.timeImpulsi });

    // la PIATTAFORMA è caduta → la stazione cade (le flotte presenti restano)
    if (!stationAlive) {
      const oc = applyStationSiegeWin(game, battle, st, events);
      events.push({ kind: 'siege-end', battleId: battle.id, outcome: oc,
        stationId: st.id, systemId: battle.systemId, impulso: game.timeImpulsi });
      return 'done';
    }
    const atkWiped = atk.combatants.length === 0;
    const atkRetreat = C.checkRetreat(atk, startAtkHp);
    if (atkWiped || atkRetreat) {
      warRegisterWin(game);
      if (battle.attackerKind === 'ai' && root.ORION.ai && root.ORION.ai.recordBattle) {
        root.ORION.ai.recordBattle(game, battle.attackerCiv, 'win', 'siege-defense', battle.systemId);
      }
      events.push({ kind: 'siege-end', battleId: battle.id, outcome: 'repelled',
        stationId: st.id, systemId: battle.systemId, impulso: game.timeImpulsi });
      grantSiegeVeterancy(game, present, events);
      return 'done';
    }
    if (battle.round >= 12) {
      const oc = applyStationSiegeWin(game, battle, st, events);
      events.push({ kind: 'siege-end', battleId: battle.id, outcome: oc,
        stationId: st.id, systemId: battle.systemId, impulso: game.timeImpulsi });
      return 'done';
    }
    return 'ongoing';
  }

  /* Esito di un assedio-stazione vinto dall'attaccante: AI → CATTURA
     (la stazione passa alla civiltà, riconquistabile), pirata → DISTRUZIONE.
     Recovery-friendly: catturata si riconquista, distrutta si ricostruisce. */
  function applyStationSiegeWin(game, battle, st, events) {
    const ST = root.ORION.station;
    warRegisterLoss(game, CFG.WAR_MORALE_PER_LOOT, CFG.WAR_PRESSURE_PER_LOSS);
    if (battle.attackerKind === 'ai') {
      const civ = (game.civs || []).filter(function (c) { return c.id === battle.attackerCiv; })[0];
      if (root.ORION.ai && root.ORION.ai.recordBattle) {
        root.ORION.ai.recordBattle(game, battle.attackerCiv, 'loss', 'siege-attack', battle.systemId);
      }
      if (civ && civ.alive) {
        ST.captureStation(st, civ.id);
        bumpIcg(game, 2);
        events.push({ kind: 'station-captured', stationId: st.id, name: st.name,
          systemId: battle.systemId, civName: civ.name, civColor: civ.color, impulso: game.timeImpulsi });
        return 'captured';
      }
    }
    // pirati (o civ sparita) → distruzione
    game.stations = ST.listOf(game).filter(function (s) { return s !== st; });
    events.push({ kind: 'station-destroyed', stationId: st.id, name: st.name,
      systemId: battle.systemId, impulso: game.timeImpulsi });
    return 'looted';
  }

  function isCapitalColony(game, colonyKey) {
    if (!game.capitals) return false;
    const gids = Object.keys(game.capitals);
    for (let i = 0; i < gids.length; i++) if (game.capitals[gids[i]] === colonyKey) return true;
    return false;
  }

  /* Rimozione di una colonia dal gioco (conquista/rasa/evacuazione).
     Pulisce il mapping capitale e le incursioni/assedi che la puntavano.
     Recovery-friendly: le flotte NON vengono distrutte (restano operative,
     orfane della base).
     M18 bridge: se la colonia aveva una figura assegnata, emette evento
     cronaca 'figure-lost' e applica −3 reputazione (la figura "muore in
     servizio"). La figura non rientra nel pool d'Impero. */
  function removeColony(game, colonyKey, events) {
    if (game.colonies && game.colonies[colonyKey] && game.colonies[colonyKey].figure) {
      const CF = root.ORION && root.ORION.colonyFigure;
      if (CF && CF.onColonyLost) CF.onColonyLost(game, game.colonies[colonyKey], colonyKey, events);
    }
    if (game.capitals) {
      Object.keys(game.capitals).forEach(function (gid) {
        if (game.capitals[gid] === colonyKey) delete game.capitals[gid];
      });
    }
    if (game.colonies) delete game.colonies[colonyKey];
    game.incursions = (game.incursions || []).filter(function (inc) { return inc.targetColonyKey !== colonyKey; });
    game.battles = (game.battles || []).filter(function (b) { return b.colonyKey !== colonyKey || b.status === 'done'; });
  }

  function bumpIcg(game, n) {
    if (typeof game.icg !== 'number') game.icg = 20;
    game.icg = Math.max(0, Math.min(100, game.icg + n));
  }

  /* M09 Fase B: rilevamento sconfitta. 0 colonie operative → "esilio"
     (default, partita infinita) o "gameover" (se mode.modifiers.gameOver,
     es. preset Incubo). Emette empire-fallen una sola volta. */
  function checkDefeat(game, events) {
    if (game.defeated) return;
    const cols = game.colonies || {};
    let alive = 0;
    Object.keys(cols).forEach(function (k) {
      const c = cols[k];
      if (c && (c.colonized || c.colonizing)) alive++;
    });
    if (alive > 0) return;
    const hard = !!(game.mode && game.mode.modifiers && game.mode.modifiers.gameOver);
    game.defeated = hard ? 'gameover' : 'exile';
    bumpIcg(game, 6);
    events.push({ kind: 'empire-fallen', hard: hard, impulso: game.timeImpulsi });
  }

  /* M09 Fase B — leva di recovery "Evacua colonia" (scelta utente):
     abbandono volontario. Recupera una frazione dello stock verso la
     capitale (o la prima colonia disponibile), poi rimuove la colonia
     (sistema neutrale). Recovery-friendly: niente perdita di flotte. */
  function evacuateColony(game, colonyKey) {
    const colony = game.colonies && game.colonies[colonyKey];
    if (!colony) return { ok: false, reason: 'Colonia inesistente' };
    // destinazione: una capitale diversa, altrimenti la prima colonia diversa
    let destKey = null;
    if (game.capitals) {
      Object.keys(game.capitals).forEach(function (gid) {
        const ck = game.capitals[gid];
        if (ck && ck !== colonyKey && game.colonies[ck]) destKey = destKey || ck;
      });
    }
    if (!destKey) {
      Object.keys(game.colonies).forEach(function (k) {
        if (k !== colonyKey && game.colonies[k] && game.colonies[k].colonized) destKey = destKey || k;
      });
    }
    const recovered = {};
    if (destKey) {
      const dest = game.colonies[destKey];
      ['met', 'en', 'food', 'water'].forEach(function (kk) {
        const amt = Math.floor((colony.stock[kk] || 0) * 0.5);   // recuperi metà
        dest.stock[kk] = (dest.stock[kk] || 0) + amt;
        recovered[kk] = amt;
      });
    }
    removeColony(game, colonyKey);
    return { ok: true, destKey: destKey, recovered: recovered };
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
  /* ------------------------------------------------------------------
     M16 (#81) — STAZIONI spaziali.
     ------------------------------------------------------------------ */
  /* Scrive l'hp residuo della stazione co-combattente; se la sua piattaforma
     è stata distrutta nello scontro → rimuove la stazione (recovery-friendly:
     si ricostruisce). */
  function applyStationCombatOutcome(game, station, force, events) {
    let survived = null;
    for (let i = 0; i < (force.combatants || []).length; i++) {
      const c = force.combatants[i];
      if (c.src && c.src.type === 'station' && c.src.station === station) { survived = c; break; }
    }
    if (survived) {
      station.hp = Math.max(1, Math.round(survived.hp));
      station._underAttack = true;   // sospende riparazione passiva del tick
    } else {
      // piattaforma abbattuta → stazione distrutta
      game.stations = (game.stations || []).filter(function (s) { return s !== station; });
      events.push({ kind: 'station-destroyed', stationId: station.id, name: station.name,
        systemId: station.systemId, impulso: game.timeImpulsi });
    }
  }

  /* Difesa autonoma della stazione: se una forza ostile è presente nel suo
     sistema e nessuna flotta del giocatore ha già risolto lì questo tick,
     la stazione combatte da sola (lampo, con cooldown per dare tempo di
     reagire — recovery-friendly #22). Perdendo viene distrutta (la
     conquista AI vera è Fase B). */
  function stationSiegeActive(game, stationId) {
    const b = game.battles;
    if (!Array.isArray(b)) return false;
    for (let i = 0; i < b.length; i++) if (b[i] && b[i].status === 'active' && b[i].stationId === stationId) return true;
    return false;
  }
  function processStationDefense(game, events) {
    const C = root.ORION.combat, ST = root.ORION.station;
    if (!C || !ST) return;
    const list = ST.listOf(game);
    for (let i = 0; i < list.length; i++) {
      const st = list[i];
      if (!st || st.phase === 'building' || st.level < 1) continue;
      if (!ST.isPlayerStation(st)) continue;                      // catturata → non difende per te
      // se c'è un assedio multi-round in corso su questa stazione, salta (lo
      // gestisce processBattles, non la difesa lampo)
      if (stationSiegeActive(game, st.id)) continue;
      if (st._defendedAt === game.timeImpulsi) continue;          // già difesa via flotta
      // cooldown anti-spam: una battaglia ogni STATION_DEFENSE_COOLDOWN Ι
      if (st._lastDefenseI != null && (game.timeImpulsi - st._lastDefenseI) < CFG.STATION_DEFENSE_COOLDOWN) continue;
      const sysId = st.systemId;
      if (!C.hostilePresenceAt(game, sysId)) { st._sieged = false; continue; }
      // costruisci la forza ostile (covo pirata o AI ostile materializzata)
      const nest = pirateNestAt(game, sysId);
      let enemy = null, enemyKind = null, civ = null;
      if (nest) { enemy = C.forceFromPirateNest(nest); enemyKind = 'pirate'; }
      else if (root.ORION.ai) {
        civ = root.ORION.ai.civForSystem ? root.ORION.ai.civForSystem(game, sysId) : null;
        if (civ && civ.alive && root.ORION.ai.materialize) {
          enemy = C.forceFromMaterialized(root.ORION.ai.materialize(game, civ, sysId), 'B');
          enemyKind = 'ai';
        }
      }
      if (!enemy || !enemy.combatants.length) continue;

      st._underAttack = true;
      st._lastDefenseI = game.timeImpulsi;
      const def = C.forceFromStation(game, st, 'A');
      if (!def.combatants.length) continue;
      const battleId = (game.timeImpulsi || 0) + ':station:' + st.id;
      const report = C.resolve(game, battleId, def, enemy);
      const won = (report.winner === 'A');
      /* Avviso (auto-pausa) solo alla PRIMA battaglia di un assedio continuo:
         un covo persistente raid ogni cooldown → niente spam di pause. */
      if (!st._sieged) {
        st._sieged = true;
        events.push({ kind: 'station-attacked', stationId: st.id, name: st.name,
          systemId: sysId, enemyKind: enemyKind, won: won, report: report, impulso: game.timeImpulsi });
      }
      // esito sull'ostile (pirati: attrito al covo)
      if (won && enemyKind === 'pirate' && nest) {
        nest.level = (nest.level || 1) - 1;
        if (nest.level <= 0 && game.piracy) {
          game.piracy.nests = game.piracy.nests.filter(function (n) { return n !== nest; });
        }
      } else if (enemyKind === 'ai' && civ && root.ORION.ai.demobilize) {
        root.ORION.ai.demobilize(game, civ, { winner: won ? 'player' : 'civ', report: report });
      }
      // writeback hp / distruzione della stazione
      applyStationCombatOutcome(game, st, report._A, events);
    }
  }

  /* Avanza costruzione/upkeep/riparazione di tutte le stazioni. */
  function processStations(game, events) {
    if (root.ORION.station && root.ORION.station.tick) root.ORION.station.tick(game, events);
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
    /* M13 (decisione #57): azzera l'accumulatore del tasso di ricerca del
       tick — viene riempito da processProduction e usato per l'ETA del
       progetto attivo (etaImpulsi). */
    if (root.ORION.research) {
      root.ORION.research.ensure(game);
      game.research._rateAccum = 0;
    }
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
      /* M12 Fase A1 (decisione #53, §15.6): matura la coda di costruzione
         dei mercantili dell'Hangar (parallela a scafi/equipaggi). */
      if (root.ORION.trade && root.ORION.trade.processColonyAssets) {
        root.ORION.trade.processColonyAssets(game, colony, planet, events);
      }
      processSettling(game, colony, planet, events);
      /* M09 (decisione #49, §10.2): riparazione passiva delle strutture
         danneggiate in battaglia, sospesa mentre la colonia è sotto assedio. */
      processStructRepair(game, colony, keys[i]);
      /* M14 Fase B1 (decisione #77): figure di colonia. La colonia operativa
         matura amministrativamente → a soglia emerge una figura (Governatore
         di sector / Ingegnere capo). La figura assegnata accumula xp servendo. */
      if (root.ORION.colonyFigure) {
        root.ORION.colonyFigure.maybeEmerge(game, colony, keys[i], events);
        root.ORION.colonyFigure.serveTick(game, colony, events);
      }
    }
    /* M07: spedizioni in volo (1 tick per ogni Impulso). */
    processExpeditions(game, events);
    /* M08 Fase A: flotte mobili (movimento + ordini). */
    processFleets(game, events);
    /* Decisione intra-sistema: sorveglianza garrison (notifica + auto-pausa
       quando una minaccia ostile entra nel sistema osservato). */
    processGarrisonThreats(game, events);
    /* M12 Fase A1 (decisione #53, §15.2): rotte commerciali interne —
       flusso passivo di risorse colonia→colonia entro il budget di
       throughput dei Mercati, maturazione xp dei mercantili, interruzioni
       recovery-friendly. Dopo la produzione (lo stock è già aggiornato). */
    if (root.ORION.trade && root.ORION.trade.processRoutes) {
      root.ORION.trade.processRoutes(game, events);
    }
    /* M12 Fase A2 (decisione #56 §15.3): accordi commerciali con le AI —
       flusso passivo risorsa↔risorsa, gate diplomatico (pace/alleanza),
       sospensione in guerra/tregua, durata. Dopo le rotte interne. */
    if (root.ORION.agreements && root.ORION.agreements.process) {
      root.ORION.agreements.process(game, events);
    }
    /* #48 Fase 2b: export rifiuti verso le AI (smaltimento a pagamento /
       vendita a chi li valorizza). Dopo gli accordi commerciali. */
    if (root.ORION.trade && root.ORION.trade.processWasteDeals) {
      root.ORION.trade.processWasteDeals(game, events);
    }
    /* M09 Fase A (decisione #49): combattimento. Scaramucce lampo (flotte
       co-locate con presenza ostile), incursioni pirata inbound, assedi in
       corso (1 round ogni ROUND_EVERY_I), poi decadimento dello stato di
       guerra (recovery passivo). L'AI (sotto) può lanciare nuove incursioni. */
    processSkirmishes(game, events);
    processIncursions(game, events);
    processBattles(game, events);
    /* M16 (#81): difesa autonoma delle stazioni (dopo le scaramucce, così le
       flotte hanno la prima occasione di ripulire la minaccia) + avanzamento
       costruzione/upkeep/riparazione delle stazioni. */
    processStationDefense(game, events);
    processStations(game, events);
    /* M13 B-2 (decisione #93): manutenzione presidi militari (cadenza
       TICK_EVERY_I interna). Decade compromised → lapsed se non rinforzato. */
    if (root.ORION.garrison && root.ORION.garrison.tick &&
        (game.timeImpulsi % root.ORION.garrison.CFG.TICK_EVERY_I) === 0) {
      root.ORION.garrison.tick(game, events);
    }
    processWarState(game);
    /* M09 Fase B: rilevamento sconfitta (0 colonie → esilio/gameover). */
    checkDefeat(game, events);
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
    /* M14 Fase B2 (decisione #78): Consiglio della Civiltà §9.4 — i 3
       consiglieri (Militare/Economico/Scientifico) emettono suggerimenti
       testuali periodici (non ogni Ι, self-rate-limited), letti sullo stato
       già aggiornato del tick. Solo consigli (auto-pausa OFF). */
    if (root.ORION.council && root.ORION.council.tick) {
      root.ORION.council.tick(game, events);
    }
    /* M14 Fase B3 (decisione #79): Luminari emergono dall'output di ricerca
       + ricambio automatico delle figure operative (congedo a fine mandato,
       solo notifica). Ambiente, nessuna azione forzata. */
    if (root.ORION.council && root.ORION.council.maybeEmergeLuminary) {
      root.ORION.council.maybeEmergeLuminary(game, events);
    }
    if (root.ORION.commander && root.ORION.commander.retireOld) {
      root.ORION.commander.retireOld(game, events);
    }
    if (root.ORION.colonyFigure && root.ORION.colonyFigure.retireOld) {
      root.ORION.colonyFigure.retireOld(game, events);
    }
    /* Contatto-da-presenza (2026-06-17): una flotta player nel sistema di
       una civ (o di un covo) formalizza il contatto in pochi Ι, e il grado
       di intel dipende dalla composizione della flotta. Gira ogni Ι (non al
       passo AI_EVERY_I) perché 3-4 Ι è la finestra desiderata. */
    if (root.ORION.ai && root.ORION.ai.processPresence) {
      root.ORION.ai.processPresence(game, events);
    }
    /* M10 Fase A (decisione #47): civiltà AI in background. Simulazione
       AGGREGATA a cadenza interna (ogni AI_EVERY_I Impulsi, dopo il warm-up):
       espansione, guerre AI-vs-AI, nascita/morte (roster vivo), ICG §5.4,
       disposizione emergente verso il giocatore, pirati atmosferici.
       Determinismo: RNG derivato da seed+Impulso, zero Math.random. */
    if (root.ORION.ai && root.ORION.ai.tick) {
      root.ORION.ai.tick(game, events);
    }
    /* M18.x (richiesta utente 2026-06-18): flotte ambientali AI fisiche
       (esploratori/estrattori/trasporti) che viaggiano sulla mappa fin
       dall'early game + rilevamento via sensori di colonie/flotte. Strato
       LEGGERO separato dalle incursioni ostili (sopra). Movimento ogni
       Impulso; spawn a cadenza interna. Determinismo: RNG da seed. */
    if (root.ORION.aifleet && root.ORION.aifleet.tick) {
      root.ORION.aifleet.tick(game, events);
    }
    /* M11 Fase A (decisione #51): diplomazia. Deriva lenta della reputazione
       verso il target morale (light/dark) + scadenza tregue → guerra.
       Determinismo: zero RNG. */
    if (root.ORION.diplomacy && root.ORION.diplomacy.tick) {
      root.ORION.diplomacy.tick(game, events);
    }
    /* M13 (decisione #57): ricerca tecnologica. Il progetto attivo è stato
       finanziato in processProduction; qui registriamo il tasso del tick (per
       l'ETA) e controlliamo il completamento (sblocco + evento). */
    if (root.ORION.research) {
      game.research._lastRate = game.research._rateAccum || 0;
      root.ORION.research.tick(game, events);
    }
    /* M17 Fase A (decisione #83): motore eventi / Dispacci & Missioni.
       Genera offerte (rare/calme, deterministiche), traccia gli obiettivi
       delle missioni attive sui verbi esistenti (covi sgominati, flotte
       presenti) e ne risolve l'esito. La Memoria Storica viene registrata
       in runAdvance (main.js) per ogni evento. */
    if (root.ORION.dispatch && root.ORION.dispatch.tick) {
      root.ORION.dispatch.tick(game, events);
    }
    /* M17 Fase C (#83): anomalie esplorabili §17.3 — raccolta ricorrente
       (detriti/nebulosa) + reliquie one-time, mentre una flotta orbita. */
    if (root.ORION.anomaly && root.ORION.anomaly.tick) {
      root.ORION.anomaly.tick(game, events);
    }
    /* FSP §17.7: scoperta di prossimità dei Fenomeni di Spazio Profondo +
       passivo dei nodi posseduti e presidiati. */
    if (root.ORION.phenomena && root.ORION.phenomena.tick) {
      root.ORION.phenomena.tick(game, events);
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
      if (game.defeated === 'gameover') break;        // M09 Fase B: fine partita (hard)
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
    /* M12 Fase A1: mercantili in costruzione (coda Hangar). */
    if (root.ORION.trade && root.ORION.trade.minQueueDuration) {
      const d = root.ORION.trade.minQueueDuration(game);
      if (d > 0 && d < best) best = d;
    }
    /* M12 Fase A2: accordi commerciali AI in scadenza. */
    if (root.ORION.agreements && root.ORION.agreements.minDuration) {
      const d = root.ORION.agreements.minDuration(game);
      if (d > 0 && d < best) best = d;
    }
    /* M13 (decisione #57): progetto di ricerca in completamento. */
    if (root.ORION.research && root.ORION.research.etaImpulsi) {
      const d = root.ORION.research.etaImpulsi(game);
      if (d > 0 && d < best) best = d;
    }
    /* M16 (#81): stazione in costruzione/upgrade. */
    if (root.ORION.station && root.ORION.station.minBuildLeft) {
      const d = root.ORION.station.minBuildLeft(game);
      if (d > 0 && d < best) best = d;
    }
    /* M17 (#83): scadenza più vicina di un incarico (offerta o deadline)
       → il fast-forward si ferma prima che un'opportunità scada o una
       missione fallisca silenziosamente. */
    if (root.ORION.dispatch && root.ORION.dispatch.nextEventDelta) {
      const d = root.ORION.dispatch.nextEventDelta(game);
      if (d > 0 && d < best) best = d;
    }
    if (root.ORION.anomaly && root.ORION.anomaly.nextEventDelta) {
      const d = root.ORION.anomaly.nextEventDelta(game);
      if (d > 0 && d < best) best = d;
    }
    /* M07: spedizioni in viaggio (outbound o returning) */
    if (Array.isArray(game.expeditions)) {
      for (let i = 0; i < game.expeditions.length; i++) {
        const e = game.expeditions[i];
        if (!e || e.status === 'done') continue;
        const d = (e.status === 'outbound') ? e.durationOut : e.durationBack;
        if (d > 0 && d < best) best = d;
      }
    }
    /* M08 Fase A: flotte in transito + Decisione #66: fasi orbit/foundation
       di colonize (la flotta è orbiting con phaseLeft countdown). */
    if (Array.isArray(game.fleets)) {
      for (let i = 0; i < game.fleets.length; i++) {
        const f = game.fleets[i];
        if (!f || !f.location) continue;
        if (f.location.status === 'in-transit') {
          const d = f.etaImpulsi || 0;
          if (d > 0 && d < best) best = d;
        } else if (f.location.status === 'orbiting' && f.orders &&
                   f.orders.type === 'colonize' &&
                   (f.orders.phase === 'orbit' || f.orders.phase === 'foundation')) {
          const d = f.orders.phaseLeft || 0;
          if (d > 0 && d < best) best = d;
        }
        /* Decisione #69: prossima soglia viveri (avviso/critico) per le
           flotte lontane da un porto amico → "Prossimo evento" si ferma
           prima del rientro forzato. */
        if (root.ORION.fleet && root.ORION.fleet.viveriNextEventDelta) {
          const dv = root.ORION.fleet.viveriNextEventDelta(game, f);
          if (dv > 0 && dv < best) best = dv;
        }
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

  /* M11 Fase B parziale: rilascio volontario di un sistema occupato.
     Recovery-friendly (#22): il giocatore può sempre abbandonare. Lieve
     bonus reputazione se l'occupazione era "dark" (atto di clemenza).
     Il sistema torna neutrale (nessuna re-assegnazione automatica alla
     vecchia civ — l'AI può ricolonizzarlo con i suoi cicli normali). */
  function releaseOccupation(game, sysId) {
    if (!game || !game.occupations) return { ok: false, reason: 'Nessuna occupazione attiva.' };
    const occ = game.occupations[sysId];
    if (!occ) return { ok: false, reason: 'Sistema non occupato.' };
    delete game.occupations[sysId];
    const wasDark = occ.fromAlignment !== 'male';
    /* Bonus reputazione discreto per il rilascio quando era atto dark. */
    if (wasDark && root.ORION.diplomacy && root.ORION.diplomacy.adjustReputation) {
      root.ORION.diplomacy.adjustReputation(game, 3);
    }
    return { ok: true, sysId: sysId, wasDark: wasDark };
  }

  function occupationCount(game) {
    if (!game || !game.occupations) return 0;
    return Object.keys(game.occupations).length;
  }

  /* DISPLAY — single source of truth dei moltiplicatori applicati a OGNI
     Impulso in processProduction. La UI (tab Risorse, deck colonia, dashboard
     impero) deve mostrare la PRODUZIONE REALE in qualunque condizione, inclusi
     i malus temporanei: Insediamento (×0.5), scarsità §7.4, rifiuti §48,
     morale di guerra §49. Prima questi pannelli mostravano i tassi teorici
     "nudi" → l'utente vedeva "+2.98 energia" durante l'Insediamento mentre la
     realtà era ≈0 (la metà della produzione meno l'upkeep pieno).

     PURO read-only: legge `colony._scar`/`colony.waste`/`game.warState` senza
     forzarne la creazione (come colonyMorale), così chiamarlo dalla UI non
     muta lo stato e non rompe il determinismo del replay.

     `prodMul` va applicato AI SOLI TASSI (rates). Upkeep e drenaggio pop NON
     sono scalati — coerente con processProduction (`n = r*mul - u - pop`). */
  function productionFactors(game, colony) {
    if (!colony) {
      return { prodMul: 1, settling: 1, scarcity: 1, waste: 1, war: 1,
        popFood: 0, popWater: 0, popMet: 0, popEn: 0 };
    }
    const sc = colony._scar ? scarcityMalus(colony._scar) : 1;
    const wa = wasteMalus(colony.waste);
    const wr = warMalus(game);
    const st = (colony.phase === 'settling') ? 0.5 : 1.0;
    const op = colony.phase !== 'settling';
    const pop = (colony.pop && colony.pop.total) || 0;
    /* Razioni equipaggio al porto (2026-06-15): drain di cibo/acqua per crews
       parcheggiati (idle + flotte ferme), specchio di popFood/popWater. */
    const E = root.ORION && root.ORION.expedition;
    const crewPort = (op && E && E.crewPortConsumption)
      ? E.crewPortConsumption(game, colony) : { food: 0, water: 0 };
    return {
      prodMul: sc * wa * wr * st,
      settling: st, scarcity: sc, waste: wa, war: wr,
      popFood:  op ? pop * CFG.POP_FOOD_PER_UNIT  : 0,
      popWater: op ? pop * CFG.POP_WATER_PER_UNIT : 0,
      popMet:   op ? pop * CFG.POP_MET_PER_UNIT   : 0,
      popEn:    op ? pop * CFG.POP_EN_PER_UNIT    : 0,
      crewFood:  crewPort.food,
      crewWater: crewPort.water
    };
  }

  ORION.time = {
    CFG: CFG,
    CLASS_BIAS: CLASS_BIAS,
    format: format,
    currentDS: currentDS,
    currentDSHtml: currentDSHtml,
    splitFaro: splitFaro,
    I_PER_K: I_PER_K, I_PER_PHI: I_PER_PHI, I_PER_OMEGA: I_PER_OMEGA,
    tick: tick,
    advance: advance,
    advanceToNextEvent: advanceToNextEvent,
    nextEventImpulsi: nextEventImpulsi,
    nextSeqId: nextSeqId,
    nextCrewId: nextCrewId,
    targetClassWeights: targetClassWeights,
    colonyMorale: colonyMorale,
    colonyHousing: colonyHousing,
    productionFactors: productionFactors,
    ensureScarcity: ensureScarcity,
    /* Decisione #48 — gestione rifiuti (Fase 0) */
    ensureWaste: ensureWaste,
    wasteCapacity: wasteCapacity,
    wasteMalus: wasteMalus,
    wasteStatus: wasteStatus,
    /* M09 Fase B — leve di recovery / esiti esposti per la UI */
    evacuateColony: evacuateColony,
    releaseOccupation: releaseOccupation,
    occupationCount: occupationCount,
    ensureWarState: ensureWarState,
    /* Decisione #66 — completamento colonizzazione (chiamato sia dal
       path legacy processColonizing sia da fleet.tickColonizePhase). */
    completeColonization: completeColonization
  };
})(typeof window !== 'undefined' ? window : this);
