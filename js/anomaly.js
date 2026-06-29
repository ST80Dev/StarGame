/* =====================================================================
   ORION EMPIRES — anomaly.js  (M17 — Eventi e narrazione, Fase C, §17.3)

   Anomalie spaziali ESPLORABILI. Le anomalie sono già generate (immutabili,
   dal seed) in system.js come `sys.anomalies[{kind,seed,...}]`; qui diventano
   siti con cui interagire. Decisione #83 Fase C, scelta utente:

   - **Siti di raccolta RICORRENTE** (campo di detriti → metalli · nebulosa →
     energia): una flotta del giocatore in ORBITA nel sistema raccoglie X/Ι
     dalla riserva del sito; la riserva NON si esaurisce del tutto e si
     RIGENERA lentamente quando nessuna flotta è presente → è uno "spot" dove
     tornare periodicamente. Flusso passivo, niente spam (modello rotte M12).
   - **Reliquie antiche** = sito ONE-TIME: una flotta presente per RELIC_HOLD Ι
     → ricompensa (cache di risorse) + voce di Memoria Storica; poi è esaurito.

   Stato (delta serializzabile, additivo lazy — NESSUN bump di schema):
     game.anomalies[<anom.seed>] = { sysId, kind, res?, cap?, reserve?, explored?, progress?, lowFlag? }

   Determinismo (#5): zero RNG nel tick (la generazione delle anomalie è già
   deterministica dal seed). Recovery-friendly (#22): nessun fail-state; la
   riserva si rigenera, la flotta non rischia nulla restando a raccogliere.

   Buchi neri: lasciati come hazard di flavor (nessun meccanismo di raccolta) —
   estensione futura. Cinture asteroidali (corpi, non anomalie): gancio futuro.
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  const DISCOVERY_EXPLORED = 2;

  const CFG = {
    HARVEST_RATE: 0.6,    // risorse/Ι base con esploratore (legacy)
    /* Decisione utente 2026-06-27: rigenerazione velocizzata 0.15 → 1.0/Ι, e
       ora VALIDA ANCHE durante l'estrazione (vedi tick). Vale per TUTTI i siti
       harvest (energia: nebulosa/gassoso; metallo: detriti/cintura). Motivo:
       con la regen vecchia (solo a sito idle) un estrattore parcheggiato
       prosciugava il sito e il netto sostenibile crollava a ~0 — peggio ancora
       sull'energia, dove la flotta in orbita costa viveri (energia su stazza).
       Con regen continua il sito raggiunge un equilibrio ≈ regen, rendendo
       l'estrazione un supplemento reale invece di un burst una-tantum. */
    REGEN: 1.0,           // rigenerazione/Ι della riserva (continua, anche in harvest)
    RELIC_HOLD: 40,       // Ι di presenza per esplorare una reliquia
    RELIC_REWARD: { met: 220, en: 130 },
    LOW_FRAC: 0.15,       // soglia "riserva quasi esaurita" (evento una volta)
    /* Decisione utente 2026-06-16: usura per Ι sulle navi in survey/harvest.
       Più bassa del transito (0.05) — l'Estrattore è progettato per restare
       sul posto a lungo. Calibrazione target: ~1000 Ι di harvest continuo
       producono ~30% wear, lasciando margine per più cicli prima del refit. */
    WEAR_SURVEY_BASE: 0.03,
    /* Estrattore: rate base + bonus per livello Hangar della colonia origine.
       Decisione utente 2026-06-27: drenaggio alzato (0.6/0.2 → 1.0/0.3) così il
       burst è più veloce e il netto supera nettamente il costo viveri della
       flotta in orbita. lvl1=1.0 · lvl2=1.3 · lvl3=1.6 · lvl4=1.9 · lvl5=2.2.
       Calcolato come EXTRACTOR_RATE_BASE + EXTRACTOR_RATE_PER_LVL * (lvl-1). */
    EXTRACTOR_RATE_BASE: 1.0,
    EXTRACTOR_RATE_PER_LVL: 0.3,
    /* XP equipaggio durante harvest: +1 ogni N Ι di drenaggio effettivo. */
    SURVEY_XP_EVERY: 40
  };

  /* Mappa kind → comportamento.
     `perBody:true` (cintura) = un sito per ogni corpo del tipo nel sistema
     (più cinture in un sistema = più siti distinti). Per gli altri kind
     una sola entità per (sysId, kind). */
  const KINDS = {
    detriti:  { harvest: true, res: 'met', cap: 420 },
    nebulosa: { harvest: true, res: 'en',  cap: 320 },
    reliquie: { harvest: false, relic: true },
    /* Cintura asteroidale: corpo §6.3, esposta come sito harvest (richiesta
       utente 2026-06-16). Riserva maggiore delle altre — è una risorsa
       industriale ricorrente, non un'anomalia "rara". */
    cintura:  { harvest: true, res: 'met', cap: 600, perBody: true },
    /* Decisione A (Stadio 1, docs/FLEET_FLOW.md): GIACIMENTI su corpi non
       colonizzabili. Il gigante gassoso è sfruttabile (energia) — stesso
       modello perBody della cintura. Risponde a "estrarre da pianeta non
       colonizzabile" senza inventare meccaniche nuove. */
    gassoso:  { harvest: true, res: 'en', cap: 500, perBody: true }
  };

  /* Corpi (non colonizzabili) che espongono un giacimento sfruttabile:
     body.type → kind harvest. Cintura (met) + gigante gassoso (en). */
  const BODY_GIACIMENTO = { cintura: 'cintura', gassoso: 'gassoso' };

  /* Helper esposto: il corpo ha un giacimento? → { kind, res, cap } | null.
     Usato da actionsFor (gate Estrai) e dall'ingresso-da-mappa. Deterministico
     dal tipo del corpo (seed-derived), non legge lo stato di gioco. */
  function bodyGiacimento(body) {
    if (!body || !body.type) return null;
    const kind = BODY_GIACIMENTO[body.type];
    if (!kind) return null;
    const def = KINDS[kind];
    return { kind: kind, res: def.res, cap: def.cap };
  }

  function ensure(game) {
    if (!game) return;
    if (!game.anomalies || typeof game.anomalies !== 'object') game.anomalies = {};
    /* Transitorio: sistemi già scansionati per i siti (evita di rigenerare il
       sistema ogni tick). Ricostruito al load — i siti veri vivono in
       game.anomalies (persistito). */
    if (!game._anomScanned) game._anomScanned = {};
    /* Migrazione/dedup una-tantum per sessione: i save vecchi possono avere
       più entry per la STESSA anomalia (la chiave era basata su `a.seed`, che
       poteva variare tra generazioni dello stesso sistema → doppioni drenati
       da una sola flotta). Normalizziamo alla chiave canonica `sysId:kind`. */
    if (!game._anomNorm) { normalizeAnomalies(game); game._anomNorm = true; }
  }

  /* Chiave canonica di un sito: UNA entità per (sistema, tipo). Una flotta
     in orbita raccoglie/esplora quel tipo nel sistema — avere più "copie"
     della stessa anomalia non avrebbe senso (decisione di sessione).
     Eccezione: kind `perBody` (cintura) → chiave include bodyKey, perché
     più cinture nello stesso sistema sono siti distinti. */
  function siteKey(sysId, kind, bodyKey) {
    const def = KINDS[kind];
    if (def && def.perBody && bodyKey) return sysId + ':' + kind + ':' + bodyKey;
    return sysId + ':' + kind;
  }

  /* Rifonde game.anomalies sulle chiavi canoniche, unendo eventuali doppioni
     (tiene lo stato più "avanzato": riserva minima per la raccolta, esplorata/
     progresso massimo per le reliquie). Idempotente: già-canonico → invariato. */
  function normalizeAnomalies(game) {
    const old = game.anomalies || {};
    const next = {};
    Object.keys(old).forEach(function (k) {
      const s = old[k];
      if (!s || s.sysId == null || !s.kind) return;
      const ck = siteKey(s.sysId, s.kind, s.bodyKey);
      const e = next[ck];
      if (!e) { next[ck] = s; return; }
      if (s.kind === 'reliquie') {
        e.explored = e.explored || s.explored;
        e.progress = Math.max(e.progress || 0, s.progress || 0);
        if (s.loot) e.loot = s.loot;
      } else {
        if (s.reserve != null) e.reserve = Math.min(e.reserve != null ? e.reserve : Infinity, s.reserve);
        e.lowFlag = e.lowFlag || s.lowFlag;
      }
    });
    game.anomalies = next;
  }

  /* Registra i siti di un sistema in game.anomalies (idempotente).
     Chiamata quando una flotta orbita lì o quando il giocatore apre il
     sistema. Genera il sistema dal seed (deterministico) una sola volta.
     UNA entità per (sistema, tipo): più anomalie dello stesso tipo nello
     stesso sistema confluiscono in un solo sito (chiave canonica). */
  function ensureSites(game, sysId) {
    ensure(game);
    if (game._anomScanned[sysId]) return;
    /* Guard PRIMA del flag (fix sessione 2026-06-16): se ORION.system.generate
       non è caricato (transitorio, es. test headless), NON marchiamo come
       scansionato — altrimenti il sistema verrebbe saltato per sempre nella
       sessione corrente anche dopo che ORION.system diventa disponibile. */
    if (!(ORION.system && ORION.system.generate)) return;
    game._anomScanned[sysId] = true;
    const sys = ORION.system.generate(game.galaxy, sysId);
    /* Anomalie §17.3 (detriti/nebulosa/reliquie): UNA entità per (sistema, tipo). */
    const anoms = (sys && sys.anomalies) || [];
    const kinds = {};
    for (let i = 0; i < anoms.length; i++) { if (KINDS[anoms[i].kind]) kinds[anoms[i].kind] = true; }
    Object.keys(kinds).forEach(function (kind) {
      const def = KINDS[kind];
      const key = siteKey(sysId, kind);
      if (game.anomalies[key]) return;
      if (def.relic) {
        game.anomalies[key] = { sysId: sysId, kind: 'reliquie', explored: false, progress: 0, harvested: 0 };
      } else {
        game.anomalies[key] = { sysId: sysId, kind: kind, res: def.res, cap: def.cap, reserve: def.cap, lowFlag: false, harvested: 0 };
      }
    });
    /* Giacimenti su CORPI (decisione A): UN sito per ogni corpo non
       colonizzabile sfruttabile (cintura → met, gigante gassoso → en).
       Il corpo è §6.3, ma il modello harvest §17.3 si applica naturalmente
       (riserva ricorrente). Generalizza il vecchio loop solo-cinture. */
    const bodies = (sys && sys.bodies) || [];
    for (let j = 0; j < bodies.length; j++) {
      const b = bodies[j];
      if (!b || !b.key) continue;
      const kind = BODY_GIACIMENTO[b.type];
      if (!kind) continue;
      const gdef = KINDS[kind];
      const bk = siteKey(sysId, kind, b.key);
      if (game.anomalies[bk]) continue;
      game.anomalies[bk] = {
        sysId: sysId, kind: kind, bodyKey: b.key,
        res: gdef.res, cap: gdef.cap, reserve: gdef.cap,
        lowFlag: false, harvested: 0
      };
    }
  }

  /* Flotta presente nel sistema, a prescindere dall'ordine (uso generico). */
  /* Flotta che sta facendo RICOGNIZIONE su QUESTO sito specifico (sistema +
     tipo): ordine `survey` con anomalyKind corrispondente, presente in orbita.
     Così una flotta mandata sui detriti raccoglie SOLO i detriti, non la
     nebulosa dello stesso sistema (decisione di sessione). */
  function fleetSurveyingSite(game, sysId, kind, bodyKey) {
    const fl = game.fleets || [];
    /* Per kind perBody (cintura) il match richiede anche bodyKey: una flotta
       su una cintura specifica non drena le altre dello stesso sistema. */
    const def = KINDS[kind];
    const needBody = !!(def && def.perBody);
    for (let i = 0; i < fl.length; i++) {
      const f = fl[i];
      if (!f || !f.location || f.location.systemId !== sysId) continue;
      if (f.location.status !== 'orbiting' && f.location.status !== 'docked') continue;
      const o = f.orders;
      if (!o || o.type !== 'survey' || o.anomalyKind !== kind) continue;
      if (needBody && o.bodyKey !== bodyKey) continue;
      return f;
    }
    return null;
  }

  /* Colonia su cui depositare il raccolto (decisione utente 2026-06-20):
     **colonia attiva più vicina al sito** in distanza-hop sui collegamenti
     di galassia. Il giocatore può poi usare le rotte commerciali per
     spostare le risorse altrove. Fallback: origine della flotta →
     capitale/prima colonia colonizzata. BFS limitato ai sistemi del
     grafo (niente vincolo discovery: il giacimento è "stato scoperto"
     altrimenti la flotta non lo starebbe drenando). */
  function nearestActiveColonyKey(game, sysId) {
    if (!game || !game.colonies || !game.galaxy || !game.galaxy.systems) return null;
    /* Indicizza colonie per sistema (solo quelle effettivamente colonizzate). */
    const bySys = {};
    Object.keys(game.colonies).forEach(function (k) {
      const c = game.colonies[k];
      if (!c || !c.colonized) return;
      (bySys[c.systemId] = bySys[c.systemId] || []).push(k);
    });
    /* BFS sui link di galassia partendo dal sistema del sito. */
    const seen = {}; seen[sysId] = 0;
    const queue = [sysId];
    while (queue.length) {
      const u = queue.shift();
      if (bySys[u]) return bySys[u][0];
      const sys = game.galaxy.systems[u];
      const links = (sys && sys.links) || [];
      for (let i = 0; i < links.length; i++) {
        const v = links[i];
        if (seen[v] != null) continue;
        seen[v] = seen[u] + 1;
        queue.push(v);
      }
    }
    return null;
  }
  function depositColonyKey(game, fleet, site) {
    /* 1) Colonia attiva più vicina al sito (priorità nuova). Se non
       conosciamo il `site`, lo cerchiamo via reverse-lookup sulla flotta
       (caso raro: chiamanti vecchi). */
    let s = site;
    if (!s && fleet && game.anomalies) {
      const ks = Object.keys(game.anomalies);
      for (let i = 0; i < ks.length; i++) {
        const cand = game.anomalies[ks[i]];
        if (fleetSurveyingSite(game, cand.sysId, cand.kind, cand.bodyKey) === fleet) { s = cand; break; }
      }
    }
    if (s) {
      const near = nearestActiveColonyKey(game, s.sysId);
      if (near) return near;
    }
    /* 2) Fallback: colonia d'origine della flotta. */
    const ok = fleet && fleet.ownerColonyKey;
    if (ok && game.colonies[ok] && game.colonies[ok].colonized) return ok;
    /* 3) Fallback estremo: dispatch o prima colonia colonizzata. */
    if (ORION.dispatch && ORION.dispatch.payColonyKey) return ORION.dispatch.payColonyKey(game);
    const keys = Object.keys(game.colonies || {});
    for (let i = 0; i < keys.length; i++) if (game.colonies[keys[i]].colonized) return keys[i];
    return null;
  }

  function deposit(game, fleet, res, amt, site) {
    const k = depositColonyKey(game, fleet, site);
    const col = k && game.colonies[k];
    if (col && col.stock) col.stock[res] = (col.stock[res] || 0) + amt;
  }

  /* Rate di raccolta della flotta sul sito (decisione utente 2026-06-16).
     - Estrattore: base + bonus per livello Hangar della colonia origine.
       Se la flotta ha più Estrattori (caso teorico), il rate somma per ogni
       Estrattore (somma capacità di drenaggio).
     - Esploratore (fallback storico): CFG.HARVEST_RATE costante.
     - Cap implicito: il take è min(rate, site.reserve) nel chiamante.
     Niente effetto se nessuna delle due classi è presente (es. solo navi
     militari): rate=0, niente raccolta. */
  function harvestRateFor(game, fleet) {
    if (!fleet || !Array.isArray(fleet.ships) || !fleet.ships.length) return 0;
    let extractors = 0, explorers = 0;
    for (let i = 0; i < fleet.ships.length; i++) {
      const k = fleet.ships[i] && fleet.ships[i].kind;
      if (k === 'estrattore') extractors++;
      else if (k === 'explorer') explorers++;
    }
    if (extractors === 0 && explorers === 0) return 0;
    let rate = 0;
    if (extractors > 0) {
      const colony = game.colonies && game.colonies[fleet.ownerColonyKey];
      const hangar = colony && colony.structures && colony.structures['cantiere-navale'];
      const lvl = Math.max(1, (hangar && hangar.level | 0) || 1);
      rate += extractors * (CFG.EXTRACTOR_RATE_BASE + CFG.EXTRACTOR_RATE_PER_LVL * (lvl - 1));
    }
    /* L'esploratore in survey è il fallback minimo (compat con i save vecchi
       che hanno flotte di soli esploratori in survey). */
    if (extractors === 0 && explorers > 0) {
      rate = CFG.HARVEST_RATE;
    }
    return rate;
  }

  /* Usura per Ι sulle navi che drenano (richiesta utente 2026-06-16).
     Applicata SOLO se la raccolta è effettiva (chiamata dopo deposit),
     così navi su sito esausto non si usurano per niente. */
  function applySurveyWear(fleet) {
    if (!Array.isArray(fleet.ships)) return;
    const w = CFG.WEAR_SURVEY_BASE;
    for (let i = 0; i < fleet.ships.length; i++) {
      fleet.ships[i].wear = Math.min(100, (fleet.ships[i].wear || 0) + w);
    }
  }

  /* XP equipaggio durante harvest: +1 ogni N Ι di drenaggio effettivo.
     Counter persistito su fleet._surveyXpCounter, idempotente sui save. */
  function accrueSurveyXp(game, fleet, events) {
    fleet._surveyXpCounter = (fleet._surveyXpCounter || 0) + 1;
    if (fleet._surveyXpCounter < CFG.SURVEY_XP_EVERY) return;
    fleet._surveyXpCounter = 0;
    /* Riusa il path standard di XP equipaggio (mantiene il servizio
       'harvest' per il ruolo Ingegnere alla promozione, simmetria con
       'travel' degli esploratori). */
    if (ORION.fleet && ORION.fleet.awardCrewXp) {
      ORION.fleet.awardCrewXp(game, fleet, 1, events, 'harvest');
    }
  }

  function tick(game, events) {
    if (!game) return;
    ensure(game);
    /* Registra i siti per i sistemi dove orbita una flotta del giocatore. */
    (game.fleets || []).forEach(function (f) {
      if (f && f.location && f.location.systemId >= 0 &&
          (f.location.status === 'orbiting' || f.location.status === 'docked')) {
        ensureSites(game, f.location.systemId);
      }
    });
    const keys = Object.keys(game.anomalies);
    for (let i = 0; i < keys.length; i++) {
      const site = game.anomalies[keys[i]];
      /* Solo una flotta che sta facendo ricognizione SU QUESTO sito (sistema
         + tipo [+ bodyKey per cinture]) lo raccoglie/esplora — non basta
         orbitare nel sistema. */
      const fleet = fleetSurveyingSite(game, site.sysId, site.kind, site.bodyKey);
      if (site.kind === 'reliquie') {
        if (site.explored) continue;
        if (fleet) {
          site.progress = (site.progress || 0) + 1;
          if (site.progress >= CFG.RELIC_HOLD) {
            site.explored = true;
            const colKey = depositColonyKey(game, fleet, site);
            const col = colKey && game.colonies[colKey];
            if (col && col.stock) {
              Object.keys(CFG.RELIC_REWARD).forEach(function (r) { col.stock[r] = (col.stock[r] || 0) + CFG.RELIC_REWARD[r]; });
            }
            /* Salva il bottino sul sito (per il resoconto nella vista Dispacci)
               e portalo nell'evento (per il popup di resoconto a fine esplorazione). */
            site.loot = Object.assign({}, CFG.RELIC_REWARD);
            const sysNm = (game.galaxy.systems[site.sysId] || {}).name || '—';
            events.push({ kind: 'anomaly-relic-found', sysId: site.sysId, sysName: sysNm,
              reward: Object.assign({}, CFG.RELIC_REWARD), colonyKey: colKey, impulso: game.timeImpulsi });
          }
        }
        continue;
      }
      /* Rigenerazione CONTINUA (decisione utente 2026-06-27): la riserva si
         ricostituisce sempre, anche mentre una flotta estrae. A regime, se il
         drenaggio ≥ regen, il sito si stabilizza erogando ≈ regen/Ι in modo
         sostenibile (più il burst iniziale fino a `cap`). Vale per energia e
         metallo. Idempotente, deterministico (nessun RNG). */
      if (site.reserve < site.cap) {
        site.reserve = Math.min(site.cap, site.reserve + CFG.REGEN);
        if (site.lowFlag && site.reserve > site.cap * CFG.LOW_FRAC * 2) site.lowFlag = false;
      }
      /* Raccolta ricorrente. */
      if (fleet && site.reserve > 0) {
        const rate = harvestRateFor(game, fleet);
        const take = Math.min(rate, site.reserve);
        deposit(game, fleet, site.res, take, site);
        site.reserve -= take;
        site.harvested = (site.harvested || 0) + take;
        /* Usura/XP per Ι in survey (decisione utente 2026-06-16): le navi che
           drenano subiscono un drip leggero di wear; gli equipaggi maturano
           XP ogni SURVEY_XP_EVERY Ι. Trigger di rientro automatico se wear
           supera la soglia (delegato a fleet.forceReturnForWear). */
        applySurveyWear(fleet);
        accrueSurveyXp(game, fleet, events);
        if (!site.lowFlag && site.reserve <= site.cap * CFG.LOW_FRAC) {
          site.lowFlag = true;
          events.push({ kind: 'anomaly-depleted', sysId: site.sysId, res: site.res, impulso: game.timeImpulsi });
        }
        if (ORION.fleet && ORION.fleet.forceReturnForWear) {
          if (ORION.fleet.forceReturnForWear(game, fleet)) {
            events.push({ kind: 'fleet-wear-return', fleetId: fleet.id, fleetName: fleet.name,
              sysId: site.sysId, impulso: game.timeImpulsi });
          }
        }
      }
      /* (la rigenerazione idle del vecchio ramo `else` è ora coperta dalla
         regen continua in cima al blocco, valida con o senza flotta.) */
    }
  }

  /* Per nextEventImpulsi: ferma il fast-forward al completamento di una
     reliquia in esplorazione (sito presidiato da una flotta). */
  function nextEventDelta(game) {
    if (!game || !game.anomalies) return 0;
    let best = Infinity;
    Object.keys(game.anomalies).forEach(function (k) {
      const s = game.anomalies[k];
      if (s.kind === 'reliquie' && !s.explored && fleetSurveyingSite(game, s.sysId, s.kind, s.bodyKey)) {
        const d = CFG.RELIC_HOLD - (s.progress || 0);
        if (d > 0 && d < best) best = d;
      }
    });
    return isFinite(best) ? best : 0;
  }

  /* Siti noti (registrati) per la UI. */
  function knownSites(game) {
    if (!game || !game.anomalies) return [];
    return Object.keys(game.anomalies).map(function (k) {
      const s = game.anomalies[k];
      const sys = game.galaxy.systems[s.sysId];
      /* Fix display 2026-06-27: il rate mostrato in UI era CFG.HARVEST_RATE
         statico (0.6) per OGNI sito → sembrava che l'estrazione fosse sempre
         0.6/Ι a prescindere da nave e Hangar. Ora riflette la flotta reale che
         drena: Estrattore scala con l'Hangar d'origine (1.0→2.2), Esploratore
         resta al fallback 0.6. `harvestRate` è il deposito EFFETTIVO per Ι
         (cappato dalla riserva+regen: a sito esaurito converge alla regen
         sostenibile); `harvestRateGross` è la capacità lorda della flotta. */
      const fleet = fleetSurveyingSite(game, s.sysId, s.kind, s.bodyKey);
      const grossRate = fleet ? harvestRateFor(game, fleet) : 0;
      const effRate = fleet
        ? Math.round(Math.min(grossRate, (s.reserve || 0) + CFG.REGEN) * 10) / 10
        : CFG.HARVEST_RATE;
      return {
        key: k, sysId: s.sysId, sysName: sys ? sys.name : '—', kind: s.kind,
        bodyKey: s.bodyKey || null,
        res: s.res || null, reserve: s.reserve, cap: s.cap,
        explored: !!s.explored, progress: s.progress || 0, loot: s.loot || null,
        harvested: s.harvested || 0,
        harvestRate: effRate,
        harvestRateGross: grossRate,
        harvesting: !!fleet
      };
    });
  }

  /* Surplus estrattivo per colonia (in capo all'origine della flotta che
     drena, NON alla colonia più vicina al sito). Ritorna una mappa
     { [colKey]: { met, en, sitesMet, sitesEn, fleets, total } } usata
     dalla UI (vista Anomalie & sfruttamenti + scheda risorse colonia)
     per mostrare in modo esplicito da dove vengono i +X met/Ι extra.
     Stesso calcolo di `tick`: harvestRateFor (scala con Hangar) sul lato
     attivo del sito, cappato da reserve. */
  function harvestByColony(game) {
    const out = {};
    if (!game || !game.anomalies) return out;
    Object.keys(game.anomalies).forEach(function (k) {
      const s = game.anomalies[k];
      if (!s || s.kind === 'reliquie' || !(s.reserve > 0)) return;
      const fleet = fleetSurveyingSite(game, s.sysId, s.kind, s.bodyKey);
      if (!fleet) return;
      const colKey = depositColonyKey(game, fleet, s);
      if (!colKey) return;
      const rate = Math.min(harvestRateFor(game, fleet), s.reserve);
      if (rate <= 0) return;
      const slot = out[colKey] = out[colKey] || { met: 0, en: 0, sitesMet: 0, sitesEn: 0, fleets: 0, total: 0 };
      slot.fleets += 1;
      slot.total  += rate;
      if (s.res === 'met') { slot.met += rate; slot.sitesMet += 1; }
      else if (s.res === 'en') { slot.en += rate; slot.sitesEn += 1; }
    });
    return out;
  }

  ORION.anomaly = {
    CFG: CFG,
    KINDS: KINDS,
    ensure: ensure,
    ensureSites: ensureSites,
    tick: tick,
    nextEventDelta: nextEventDelta,
    knownSites: knownSites,
    harvestByColony: harvestByColony,
    bodyGiacimento: bodyGiacimento
  };
})(typeof window !== 'undefined' ? window : this);
