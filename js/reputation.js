/* =====================================================================
   ORION EMPIRES — reputation.js
   Modulo M18: Reputazione e Indice di Corruzione Galattica (ICG).

   Cosa fa questo modulo (decisione #47 + GDD §5.4 + §14):
     - Non REIMPLEMENTA lo stato (`game.reputation` resta gestito da
       diplomacy.js, `game.icg` resta gestito da ai.js): è una FAÇADE che
       espone get/breakdown/record + uno storico cap 20 degli eventi che
       hanno mosso i valori.
     - Registra SOLO le mutazioni discrete (azioni del giocatore, esiti
       missione, scelte di crisi). I drift passivi (decay ICG, drift
       Reputazione verso target morale, aggregazione AI alignment) NON
       finiscono nello storico — sono "respiro" che si vede solo nel
       valore corrente, sennò satureremmo il buffer.
     - Emette voce di Cronaca quando una soglia significativa viene
       attraversata (ICG 40/60/80, Reputazione 30/50/70).

   Storico: `game.repHistory = [{ ds, kind:'rep'|'icg', delta, before,
   after, source, label }]`, FIFO cap 20. Additivo lazy nel save (nessun
   bump di schema: campo opzionale, init [] al primo accesso).

   Convenzioni:
     - I valori restano in [0..100]. Le soglie sono dichiarate qui sotto
       come fonte di verità (riusate dalla vista).
     - record(game, 'rep'|'icg', delta, source, label) è idempotente
       rispetto al valore: si limita a tracciare, NON applica il delta
       (chi chiama lo ha già applicato sullo state).
     - applyAndRecord(...) è lo helper combinato per i nuovi call-site:
       calcola before/after e applica clamp 0..100 prima di registrare.

   Architettura: namespace globale ORION, niente bundler, niente
   dipendenze. Caricato dopo diplomacy.js / ai.js in index.html.
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  const HISTORY_CAP = 20;

  /* Soglie significative §5.4 (ICG) e §14 (Reputazione). Crescenti.
     Le fasce sotto la prima soglia sono "verdi". */
  const ICG_THRESHOLDS = [40, 60, 80];
  const REP_THRESHOLDS = [30, 50, 70];

  /* Etichette fascia per la vista (entro la prima soglia → "stabile" /
     "neutra"; per ICG più alto è peggio, per Rep è meglio). */
  const ICG_BAND_LABEL = ['Stabile', 'Tensione', 'Crisi', 'Collasso'];
  const REP_BAND_LABEL = ['Disprezzo', 'Diffidenza', 'Neutrale', 'Stima'];

  /* Tono per CSS (riusa le classi badge ok/warn/bad/crit del progetto). */
  const ICG_BAND_TONE  = ['ok', 'warn', 'bad', 'crit'];
  const REP_BAND_TONE  = ['crit', 'bad', 'warn', 'ok'];

  function bandIndex(value, thresholds) {
    let i = 0;
    for (; i < thresholds.length; i++) if (value < thresholds[i]) return i;
    return i; /* sopra l'ultima soglia */
  }

  function ensure(game) {
    if (!game) return;
    if (!Array.isArray(game.repHistory)) game.repHistory = [];
    if (!game._repBands) {
      const ic = (typeof game.icg === 'number') ? game.icg : 20;
      const rp = (typeof game.reputation === 'number') ? game.reputation : 50;
      game._repBands = {
        icg: bandIndex(ic, ICG_THRESHOLDS),
        rep: bandIndex(rp, REP_THRESHOLDS)
      };
    }
  }

  function getRep(game) {
    if (!game) return 50;
    if (ORION.diplomacy && ORION.diplomacy.reputation) return ORION.diplomacy.reputation(game);
    return Math.round(typeof game.reputation === 'number' ? game.reputation : 50);
  }
  function getICG(game) {
    if (!game) return 0;
    return Math.round(typeof game.icg === 'number' ? game.icg : 20);
  }

  /* Registra una mutazione discreta nello storico (cap 20). Non
     applica il delta: assume che il chiamante abbia già aggiornato
     game.reputation / game.icg.
     - kind: 'rep' | 'icg'
     - delta: numero firmato (può essere clampato dal chiamante)
     - source: id stabile ('dispatch','crisis','diplomacy','figure',...)
     - label: stringa umana ("Missione: convoglio scortato")
  */
  function record(game, kind, delta, source, label) {
    if (!game || (kind !== 'rep' && kind !== 'icg')) return;
    if (!Number.isFinite(delta) || delta === 0) return;
    ensure(game);
    const after = (kind === 'rep') ? getRep(game) : getICG(game);
    const before = clamp01(after - delta);
    game.repHistory.unshift({
      ds: game.timeImpulsi || 0,
      kind: kind,
      delta: Math.round(delta * 100) / 100,
      before: Math.round(before),
      after: Math.round(after),
      source: source || 'other',
      label: label || ''
    });
    if (game.repHistory.length > HISTORY_CAP) {
      game.repHistory.length = HISTORY_CAP;
    }
    /* Dopo aver registrato, valuta se abbiamo attraversato una soglia
       e in caso emetti una voce di cronaca (solo crossing, non ad ogni
       tick). */
    detectAndEmitCrossing(game, kind);
  }

  function clamp01(v) { return Math.max(0, Math.min(100, v)); }

  /* Applica il delta e registra in un colpo solo. Usato dai call-site
     nuovi (vita più semplice). Restituisce il valore aggiornato. */
  function applyAndRecord(game, kind, delta, source, label) {
    if (!game || !Number.isFinite(delta) || delta === 0) return null;
    ensure(game);
    if (kind === 'rep') {
      const before = (typeof game.reputation === 'number') ? game.reputation : 50;
      game.reputation = clamp01(before + delta);
      record(game, 'rep', game.reputation - before, source, label);
      return game.reputation;
    }
    if (kind === 'icg') {
      const before = (typeof game.icg === 'number') ? game.icg : 20;
      game.icg = clamp01(before + delta);
      record(game, 'icg', game.icg - before, source, label);
      return game.icg;
    }
    return null;
  }

  /* Rileva attraversamento di soglia (su o giù) e emette evento cronaca.
     Salva l'ultimo "band" osservato in game._repBands per evitare
     duplicati: emettiamo solo quando l'indice di fascia cambia. */
  function detectAndEmitCrossing(game, kind) {
    ensure(game);
    if (kind === 'icg') {
      const ic = getICG(game);
      const newBand = bandIndex(ic, ICG_THRESHOLDS);
      const oldBand = game._repBands.icg;
      if (newBand !== oldBand) {
        game._repBands.icg = newBand;
        emit(game, 'icg-threshold', {
          direction: newBand > oldBand ? 'up' : 'down',
          fromBand: ICG_BAND_LABEL[oldBand] || '—',
          toBand:   ICG_BAND_LABEL[newBand] || '—',
          value: ic
        });
      }
    } else {
      const rp = getRep(game);
      const newBand = bandIndex(rp, REP_THRESHOLDS);
      const oldBand = game._repBands.rep;
      if (newBand !== oldBand) {
        game._repBands.rep = newBand;
        emit(game, 'rep-threshold', {
          direction: newBand > oldBand ? 'up' : 'down',
          fromBand: REP_BAND_LABEL[oldBand] || '—',
          toBand:   REP_BAND_LABEL[newBand] || '—',
          value: rp
        });
      }
    }
  }

  /* Helper cronaca centralizzato (rispetta il pattern di module.js).
     Push diretto su game.chronicle con kind + label; la categoria
     'galaxy' è coerente con KIND_LABELS (registrato in main.js). */
  function emit(game, kind, payload) {
    const entry = Object.assign({
      kind: kind,
      cat: 'galaxy',
      mod: 'reputation',
      impulso: game.timeImpulsi || 0
    }, payload || {});
    if (Array.isArray(game.chronicle)) {
      game.chronicle.unshift(entry);
      if (game.chronicle.length > 200) game.chronicle.length = 200;
    }
    /* Opzionale: auto-pausa quando si peggiora di fascia su ICG ≥ Crisi
       (decisione #31: eventi importanti pausano). */
    if (kind === 'icg-threshold' && payload && payload.direction === 'up'
        && (payload.toBand === 'Crisi' || payload.toBand === 'Collasso')) {
      if (ORION.time && ORION.time.autoPauseIfRunning) {
        try { ORION.time.autoPauseIfRunning('icg-threshold'); } catch (_) { /* niente */ }
      }
    }
  }

  /* ------------------------------------------------------------------
     Breakdown: fattori istantanei che spingono ICG e Reputazione.
     Non si tratta di una formula simulata: leggiamo i contributi noti
     dai moduli esistenti (vittoria/morale tracks, figure di colonia,
     conteggio AI buone/maligne, presenza Pellegrini di Solhar, etc.)
     e li presentiamo come spiegazione narrativa, con segno e peso.
     ------------------------------------------------------------------ */
  function breakdown(game) {
    if (!game) return { rep: emptyBreak('rep'), icg: emptyBreak('icg'), recent: [] };
    ensure(game);
    return {
      rep: repBreakdown(game),
      icg: icgBreakdown(game),
      recent: (game.repHistory || []).slice(0, HISTORY_CAP)
    };
  }

  function emptyBreak(kind) {
    const value = 0;
    return { value: value, band: 0, bandLabel: '—', tone: 'ok', factors: [] };
  }

  function repBreakdown(game) {
    const value = getRep(game);
    const band = bandIndex(value, REP_THRESHOLDS);
    const factors = [];

    /* Piste morali → drift target. */
    const tracks = game.victoryTracks || {};
    const light = tracks.reputationLight || 0;
    const dark  = tracks.reputationDark  || 0;
    if (light > 0.01) factors.push({
      label: 'Verbi morali "luce"',
      detail: 'Atti di protezione, alleanze, distress accolti',
      sign: +1,
      weight: Math.round(light * 40)
    });
    if (dark > 0.01) factors.push({
      label: 'Verbi morali "ombra"',
      detail: 'Tradimenti, ultimatum, vassallaggio coercitivo',
      sign: -1,
      weight: Math.round(dark * 40)
    });

    /* Figure civiche di colonia (Prefetto / Logista / Console) — piccolo
       drift continuo positivo se elevate. */
    const CF = ORION.colonyFigure;
    if (CF && CF.reputationDriftFromFigures) {
      const drift = CF.reputationDriftFromFigures(game) || 0;
      if (drift > 0.001) factors.push({
        label: 'Figure civiche',
        detail: 'Prefetto / Logista / Console in servizio',
        sign: +1,
        weight: Math.round(drift * 1000) / 10
      });
    }

    /* Pellegrini di Solhar (§13.7) — bonus passivo se nella galassia. */
    const hasPellegrini = (game.civs || []).some(function (c) {
      return c && c.alive && c.constant === 'pellegrini';
    });
    if (hasPellegrini) factors.push({
      label: 'Pellegrini di Solhar',
      detail: 'Influenza ideologica positiva nella galassia',
      sign: +1, weight: 2
    });

    /* Trattati di passaggio attivi → drift lento positivo (M11). */
    const passages = (game.civs || []).filter(function (c) { return c && c.passageTreaty; }).length;
    if (passages > 0) factors.push({
      label: 'Trattati di passaggio',
      detail: passages + ' civiltà con libero transito',
      sign: +1, weight: passages
    });

    /* Guerre attive (civ.relation === 'war') → drift negativo lieve. */
    const wars = (game.civs || []).filter(function (c) { return c && c.alive && c.relation === 'war'; }).length;
    if (wars > 0) factors.push({
      label: 'Guerre attive',
      detail: wars + ' fronte/i aperto/i',
      sign: -1, weight: wars * 2
    });

    return {
      value: value,
      band: band,
      bandLabel: REP_BAND_LABEL[band] || '—',
      tone: REP_BAND_TONE[band] || 'warn',
      thresholds: REP_THRESHOLDS.slice(),
      factors: factors
    };
  }

  function icgBreakdown(game) {
    const value = getICG(game);
    const band = bandIndex(value, ICG_THRESHOLDS);
    const factors = [];

    /* Bilancio AI buone/maligne (M10 — fonte principale del livello). */
    const civs = (game.civs || []).filter(function (c) { return c && c.alive; });
    let good = 0, evil = 0;
    civs.forEach(function (c) {
      if (c.alignment === 'good') good++;
      else if (c.alignment === 'evil') evil++;
    });
    if (evil > good) factors.push({
      label: 'Pressione "ombra"',
      detail: evil + ' civiltà maligne vs ' + good + ' benevole',
      sign: +1, weight: (evil - good) * 3
    });
    else if (good > evil) factors.push({
      label: 'Civiltà benevole',
      detail: good + ' civiltà di luce vs ' + evil + ' di ombra',
      sign: -1, weight: (good - evil) * 3
    });

    /* Pellegrini → decay ICG (§13.7: bonus passivo). */
    const hasPellegrini = civs.some(function (c) { return c.constant === 'pellegrini'; });
    if (hasPellegrini) factors.push({
      label: 'Pellegrini di Solhar',
      detail: 'Bonus passivo al decadimento ICG',
      sign: -1, weight: 2
    });

    /* Crisi pendenti (M17 Fase C) — pressione visibile. */
    const pendingCrises = (game.crises || []).filter(function (cr) { return cr && cr.status === 'pending'; }).length;
    if (pendingCrises > 0) factors.push({
      label: 'Crisi galattiche in corso',
      detail: pendingCrises + ' crisi pendente/i',
      sign: +1, weight: pendingCrises * 5
    });

    /* Anomalie hazard ignorate (§17.6.4) — drip ICG da phenomena.js. */
    const hazards = countActiveHazards(game);
    if (hazards > 0) factors.push({
      label: 'Hazard non gestiti',
      detail: hazards + ' anomalia/e biologica/temporale attiva/e',
      sign: +1, weight: hazards
    });

    /* Drift naturale verso baseline (20). */
    factors.push({
      label: 'Decadimento verso baseline (20)',
      detail: 'L\'ICG tende lentamente al valore di quiete galattica',
      sign: value > 20 ? -1 : +1,
      weight: 1
    });

    return {
      value: value,
      band: band,
      bandLabel: ICG_BAND_LABEL[band] || '—',
      tone: ICG_BAND_TONE[band] || 'warn',
      thresholds: ICG_THRESHOLDS.slice(),
      factors: factors
    };
  }

  function countActiveHazards(game) {
    /* Best-effort: legge dal modulo phenomena se espone uno snapshot;
       altrimenti zero (non vogliamo aprire la struttura privata). */
    if (ORION.phenomena && typeof ORION.phenomena.countActiveHazards === 'function') {
      try { return ORION.phenomena.countActiveHazards(game) | 0; } catch (_) { return 0; }
    }
    return 0;
  }

  /* ------------------------------------------------------------------
     API pubblica.
     ------------------------------------------------------------------ */
  ORION.reputation = {
    HISTORY_CAP: HISTORY_CAP,
    ICG_THRESHOLDS: ICG_THRESHOLDS,
    REP_THRESHOLDS: REP_THRESHOLDS,
    ICG_BAND_LABEL: ICG_BAND_LABEL,
    REP_BAND_LABEL: REP_BAND_LABEL,
    ICG_BAND_TONE:  ICG_BAND_TONE,
    REP_BAND_TONE:  REP_BAND_TONE,
    ensure: ensure,
    getRep: getRep,
    getICG: getICG,
    record: record,
    applyAndRecord: applyAndRecord,
    breakdown: breakdown,
    bandIndex: bandIndex
  };

})(typeof window !== 'undefined' ? window : globalThis);
