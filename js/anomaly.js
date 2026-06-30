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
    REGEN: 1.0,           // fallback legacy (kind senza regenActive/regenIdle)
    /* Redesign estrazione 2026 (richiesta utente): la regen diventa DOPPIA per
       premiare lo SMISTAMENTO degli estrattori invece del "parcheggia e
       dimentica". Quando un estrattore/stazione è PRESENTE la riserva si
       rigenera poco (regenActive) → a regime rende poco, non conviene
       accamparsi; quando è ASSENTE si ricarica in fretta (regenIdle). I valori
       per-kind stanno in KINDS; questi sono i fallback. Rivede la decisione
       2026-06-27 (regen continua uguale sempre): ora l'accampamento È debole
       di proposito, ma regenActive > 0 resta recovery-friendly (#22). */
    REGEN_ACTIVE_DEFAULT: 0.5,
    REGEN_IDLE_DEFAULT: 2.0,
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
       Calcolato come EXTRACTOR_RATE_BASE + EXTRACTOR_RATE_PER_LVL * (lvl-1).
       Redesign estrazione 2026: rate (burst) alzato — l'estrattore consuma
       viveri e va rifornito, quindi il prelievo deve valere. base 1.0→3.0,
       per-lvl 0.3→0.5 → lvl1=3.0 · lvl3=4.0 · lvl5=5.0. Il netto a regime resta
       basso (governato da regenActive), il grosso è nel burst sulla riserva. */
    EXTRACTOR_RATE_BASE: 3.0,
    EXTRACTOR_RATE_PER_LVL: 0.5,
    /* XP equipaggio durante harvest: +1 ogni N Ι di drenaggio effettivo. */
    SURVEY_XP_EVERY: 40,
    /* Redesign lune 2026 — paniere + scan + stazione ancorata.
       OBS_SCAN_RANGE: hop entro cui una colonia con Osservatorio rivela lo
         strato avanzato di una luna (flag permanente site.advRevealed).
       ADV_WEIGHT_SCALE: scala il peso delle avanzate nel paniere (i potenziali
         avanzati 30-100 sovrasterebbero il base ~50; le teniamo una fetta
         pregiata ma non dominante).
       STATION_EXTRACT_*: rate di estrazione di una STAZIONE ancorata alla luna
         (alternativa all'estrattore, scala col livello stazione). lvl1=1.2 ·
         lvl2=1.6 · lvl3=2.0 · lvl4=2.4 — leggermente sopra un estrattore L1,
         premio del "set-and-forget" logistico. */
    OBS_SCAN_RANGE: 3,
    ADV_WEIGHT_SCALE: 0.3,
    /* Redesign estrazione 2026: rate stazione ancorata alzato in linea con
       l'estrattore (lvl1=2.0 · lvl4=3.8). */
    STATION_EXTRACT_BASE: 2.0,
    STATION_EXTRACT_PER_LVL: 0.6
  };

  /* Mappa kind → comportamento.
     `perBody:true` (cintura) = un sito per ogni corpo del tipo nel sistema
     (più cinture in un sistema = più siti distinti). Per gli altri kind
     una sola entità per (sysId, kind). */
  /* Redesign estrazione 2026 (richiesta utente): OGNI corpo è sfruttabile a
     PANIERE proporzionale ai potenziali; la regen è DOPPIA (active/idle) per
     premiare lo smistamento. Due categorie:
       - SOSTENUTI (pianeti rocciosi + lune): i corpi che "tappi" come
         supplemento; regenActive 1.0 (accampato rende un filo), regenIdle 3.0
         (ricarica veloce), cap grande.
       - CAMPI BURST (cinture, gassosi, anomalie): lo spot estremo da spremere
         e abbandonare; regenActive 0.5 (accampato ≈ nulla), regenIdle 2.0
         (ricarica più lenta → burst più raro), cap minore.
     Anomalie detriti/nebulosa restano MONO (sono campi a risorsa unica, non
     corpi a 4 potenziali). */
  const KINDS = {
    detriti:  { harvest: true, res: 'met', cap: 420, regenActive: 0.5, regenIdle: 2.0 },
    nebulosa: { harvest: true, res: 'en',  cap: 320, regenActive: 0.5, regenIdle: 2.0 },
    reliquie: { harvest: false, relic: true },
    /* Cintura/gassoso ora a PANIERE (i potenziali li rendono quasi-mono:
       cintura ≈ metallo, gassoso ≈ energia) → coerenza col resto. Categoria
       burst. */
    cintura:  { harvest: true, basket: true, cap: 600, perBody: true, regenActive: 0.5, regenIdle: 2.0 },
    gassoso:  { harvest: true, basket: true, cap: 500, perBody: true, regenActive: 0.5, regenIdle: 2.0 },
    /* Lune (redesign 2026): paniere proporzionale, categoria sostenuta. */
    luna:     { harvest: true, basket: true, cap: 1200, perBody: true, regenActive: 1.0, regenIdle: 3.0 },
    /* Pianeti rocciosi LIBERI (non colonizzati): paniere proporzionale ai 4
       potenziali, sfruttabili dall'orbita SENZA colonizzare (supplemento;
       niente pop/strutture). Un kind unico per tutti i tipi rocciosi — il mix
       è per-corpo dai potenziali reali. Categoria sostenuta. */
    pianeta:  { harvest: true, basket: true, cap: 1500, perBody: true, regenActive: 1.0, regenIdle: 3.0 }
  };

  /* Corpi che espongono un giacimento a paniere: body.type → kind. Ora TUTTI i
     corpi (pianeti rocciosi + lune + cinture + giganti). I pianeti rocciosi
     mappano al kind unico `pianeta`. */
  const BODY_GIACIMENTO = {
    cintura: 'cintura', gassoso: 'gassoso', luna: 'luna',
    terrestre: 'pianeta', desertico: 'pianeta', oceanico: 'pianeta',
    ghiacciato: 'pianeta', vulcanico: 'pianeta', forestale: 'pianeta'
  };

  /* Helper esposto: il corpo ha un giacimento? → { kind, res, cap } | null.
     Usato da actionsFor (gate Estrai) e dall'ingresso-da-mappa. Deterministico
     dal tipo del corpo (seed-derived), non legge lo stato di gioco. */
  function bodyGiacimento(body) {
    if (!body || !body.type) return null;
    const kind = BODY_GIACIMENTO[body.type];
    if (!kind) return null;
    const def = KINDS[kind];
    return { kind: kind, res: def.res || null, cap: def.cap, basket: !!def.basket };
  }

  /* Il corpo è una colonia (mia o comunque colonizzata)? Un pianeta colonizzato
     NON è un sito d'estrazione (la colonia lo lavora già — mutua esclusione
     colonizzazione/estrazione, redesign 2026). */
  function bodyIsColonized(game, sysId, bodyKey) {
    if (bodyKey == null || !game || !game.colonies) return false;
    const c = game.colonies[sysId + ':' + bodyKey];
    return !!(c && c.colonized);
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
       colonizzabile sfruttabile (cintura → met, gigante gassoso → en, luna →
       paniere). Il corpo è §6.3, ma il modello harvest §17.3 si applica
       naturalmente (riserva ricorrente). Generalizza il vecchio loop solo-cinture.
       IMPORTANTE: le lune NON sono in sys.bodies (top-level) ma annidate in
       body.moons → appiattiamo top-level + lune, così i siti-luna si creano. */
    const tops = (sys && sys.bodies) || [];
    const bodies = [];
    for (let t = 0; t < tops.length; t++) {
      const tb = tops[t];
      if (!tb) continue;
      bodies.push(tb);
      if (Array.isArray(tb.moons)) for (let mm = 0; mm < tb.moons.length; mm++) bodies.push(tb.moons[mm]);
    }
    for (let j = 0; j < bodies.length; j++) {
      const b = bodies[j];
      if (!b || !b.key) continue;
      const kind = BODY_GIACIMENTO[b.type];
      if (!kind) continue;
      /* Mutua esclusione: niente sito d'estrazione su un corpo colonizzato
         (la colonia lo lavora già). Vale per i pianeti — lune/cinture/giganti
         non sono colonizzabili. */
      if (bodyIsColonized(game, sysId, b.key)) continue;
      const gdef = KINDS[kind];
      const bk = siteKey(sysId, kind, b.key);
      if (game.anomalies[bk]) continue;
      const site = {
        sysId: sysId, kind: kind, bodyKey: b.key,
        res: gdef.res || null, cap: gdef.cap, reserve: gdef.cap,
        lowFlag: false, harvested: 0
      };
      /* Luna (paniere): calcola il mix proporzionale dai potenziali del corpo
         (seed-derived, deterministico). Strato avanzato gated da advRevealed. */
      if (gdef.basket) computeBasketMix(game, sysId, b.key, site);
      game.anomalies[bk] = site;
    }
  }

  /* Mix del paniere di una luna: pesi base dai 4 potenziali + peso esotico
     aggregato dalle risorse avanzate del corpo (scalato). Deterministico dal
     seed via ORION.planet.generate. Idempotente: ricalcolabile. Guard headless:
     senza planet/system caricati il sito resta senza mix (estrarrà 0 finché i
     moduli ci sono — i siti veri si creano comunque solo a moduli presenti). */
  function computeBasketMix(game, sysId, bodyKey, site) {
    if (!(ORION.planet && ORION.planet.generate && ORION.system && ORION.system.generate)) return;
    let planet = null;
    try {
      const sys = ORION.system.generate(game.galaxy, sysId);
      planet = ORION.planet.generate(game.galaxy, sys, bodyKey);
    } catch (_) { return; }
    if (!planet) return;
    const pot = planet.potentials || {};
    site.basket = true;
    site.mix = { met: pot.met || 0, en: pot.en || 0, food: pot.food || 0, water: pot.water || 0 };
    let exW = 0; const ids = [];
    (planet.advanced || []).forEach(function (a) { exW += (a.potential || 0); ids.push(a.id); });
    site.exoticW = Math.round(exW * CFG.ADV_WEIGHT_SCALE * 10) / 10;
    site.advIds = ids;            // identità avanzate (rivelate da advRevealed)
    /* advRevealed lazy (default falsy): true quando un Osservatorio entra in raggio. */
  }

  /* Registra i siti di TUTTI i sistemi ESPLORATI (non solo quelli dove orbita
     una flotta): così i giacimenti — lune incluse — compaiono nella vista
     sfruttamenti appena esplori il sistema, senza doverci passare con una
     flotta. Idempotente (guardia _anomScanned): costo una-tantum per sistema.
     Usato dalla UI della vista Anomalie & sfruttamenti. */
  function ensureExplored(game) {
    ensure(game);
    if (!(ORION.system && ORION.system.generate)) return;
    const disc = game && game.state && game.state.discovery;
    if (!Array.isArray(disc)) return;
    const EXP = (ORION.galaxy && ORION.galaxy.DISCOVERY) ? ORION.galaxy.DISCOVERY.EXPLORED : 2;
    for (let sysId = 0; sysId < disc.length; sysId++) {
      if (disc[sysId] >= EXP) ensureSites(game, sysId);
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

  /* Deposito a PANIERE (luna): ripartisce `take` su TUTTE le risorse del corpo
     in proporzione ai pesi. Base (met/en/food/water) → stock; strato avanzato
     (esotici) → colony.exoticAccum, incluso SOLO se site.advRevealed (scan
     Osservatorio). `fleet` può essere null (estrazione da stazione ancorata):
     depositColonyKey ricade comunque sulla colonia attiva più vicina al sito. */
  function depositBasket(game, fleet, site, take) {
    const mix = site.mix || { met: 0, en: 0, food: 0, water: 0 };
    let total = (mix.met || 0) + (mix.en || 0) + (mix.food || 0) + (mix.water || 0);
    let exoticShare = 0;
    if (site.advRevealed && site.exoticW > 0) { exoticShare = site.exoticW; total += exoticShare; }
    if (total <= 0) return;
    const k = depositColonyKey(game, fleet, site);
    const col = k && game.colonies[k];
    if (!col) return;
    if (col.stock) {
      ['met', 'en', 'food', 'water'].forEach(function (r) {
        const w = mix[r] || 0;
        if (w > 0) col.stock[r] = (col.stock[r] || 0) + take * (w / total);
      });
    }
    if (exoticShare > 0) col.exoticAccum = (col.exoticAccum || 0) + take * (exoticShare / total);
  }

  /* Deposito a PANIERE da una STAZIONE ANCORATA (redesign logistica 2026):
     l'estrazione è piena alla luna, ma l'estratto AUTO-ALIMENTA prima il
     magazzino della stazione (uso locale, piena efficienza), e SOLO l'eccedenza
     oltre i cap + gli esotici vengono consegnati alla colonia RIFORNITRICE
     `× L` (l'export lungo è lossy). L'energia estratta riempie store.en (serve
     al rifornimento flotte), non è più solo export. */
  function depositBasketToStation(game, station, site, take) {
    const mix = site.mix || { met: 0, en: 0, food: 0, water: 0 };
    let total = (mix.met || 0) + (mix.en || 0) + (mix.food || 0) + (mix.water || 0);
    let exoticShare = 0;
    if (site.advRevealed && site.exoticW > 0) { exoticShare = site.exoticW; total += exoticShare; }
    if (total <= 0) return;
    const S = ORION.station;
    const store = (S && S.ensureStore) ? S.ensureStore(station) : station.store;
    const cap = (S && S.storeCap) ? S.storeCap(Math.max(1, station.level || 1)) : null;
    const sup = (S && S.supplierColonyFor) ? S.supplierColonyFor(game, station) : null;
    const L = sup ? sup.L : 0;
    const col = sup && sup.colony;
    /* Strato base: riempi il magazzino verso il cap (locale), overflow → colonia × L. */
    ['met', 'en', 'food', 'water'].forEach(function (r) {
      const w = mix[r] || 0; if (w <= 0) return;
      let amt = take * (w / total);
      if (store && cap) {
        const room = (cap[r] || 0) - (store[r] || 0);
        const into = Math.max(0, Math.min(amt, room));
        store[r] = (store[r] || 0) + into;
        amt -= into;
      }
      if (amt > 0 && col && col.stock) col.stock[r] = (col.stock[r] || 0) + amt * L;
    });
    /* Esotici: la stazione non li usa → tutti alla colonia (exoticAccum) × L. */
    if (exoticShare > 0 && col) {
      col.exoticAccum = (col.exoticAccum || 0) + take * (exoticShare / total) * L;
    }
  }

  /* Stazione del giocatore ANCORATA a questo corpo (luna) e operativa →
     estrazione di default per sola presenza (no sotto-struttura, scelta utente).
     Mutua esclusione con l'estrattore: se ancorata, il sito è drenato dalla
     stazione (la flotta è ignorata, vedi tick). Slice 2 popola station.bodyKey
     via UI; qui il check è inerte finché nessuna stazione è ancorata. */
  function anchoredStation(game, site) {
    if (!site || site.bodyKey == null || !ORION.station) return null;
    const list = ORION.station.listOf ? ORION.station.listOf(game) : (game.stations || []);
    for (let i = 0; i < list.length; i++) {
      const st = list[i];
      if (!st || st.systemId !== site.sysId) continue;
      if (st.bodyKey == null || String(st.bodyKey) !== String(site.bodyKey)) continue;
      if (ORION.station.isPlayerStation && !ORION.station.isPlayerStation(st)) continue;
      if (st.phase === 'building' || (st.level || 0) < 1) continue;
      if (st.supplyState === 'isolated') continue;   // isolata → estrazione in pausa (recovery-friendly)
      return st;
    }
    return null;
  }
  function stationExtractRate(st) {
    const lvl = Math.max(1, st.level || 1);
    return CFG.STATION_EXTRACT_BASE + CFG.STATION_EXTRACT_PER_LVL * (lvl - 1);
  }

  /* Scan Osservatorio (redesign lune): una colonia con la struttura
     'osservatorio' rivela lo strato avanzato delle lune entro OBS_SCAN_RANGE
     hop. Ritorna l'indice {sysId:true} dei sistemi con Osservatorio, o null se
     nessuno (così il tick salta del tutto il pass). */
  function observatorySystems(game) {
    const cols = game.colonies || {};
    const idx = {}; let any = false;
    Object.keys(cols).forEach(function (k) {
      const c = cols[k];
      if (c && c.colonized && c.structures && c.structures['osservatorio']) { idx[c.systemId] = true; any = true; }
    });
    return any ? idx : null;
  }
  /* Un Osservatorio è entro OBS_SCAN_RANGE hop dal sistema del sito? (BFS) */
  function observatoryInRange(game, sysId, obsBySys) {
    if (!obsBySys || !game.galaxy || !game.galaxy.systems) return false;
    const R = CFG.OBS_SCAN_RANGE;
    const seen = {}; seen[sysId] = 0; const q = [sysId];
    while (q.length) {
      const u = q.shift(); const d = seen[u];
      if (obsBySys[u]) return true;
      if (d >= R) continue;
      const sys = game.galaxy.systems[u];
      const links = (sys && sys.links) || [];
      for (let i = 0; i < links.length; i++) {
        const v = links[i];
        if (seen[v] != null) continue;
        seen[v] = d + 1; q.push(v);
      }
    }
    return false;
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
    /* ... e per i sistemi con una STAZIONE del giocatore: una stazione ancorata
       a una luna estrae anche senza flotta presente, quindi il sito deve esistere. */
    (game.stations || []).forEach(function (st) {
      if (st && st.systemId >= 0 && (!ORION.station || !ORION.station.isPlayerStation || ORION.station.isPlayerStation(st))) {
        ensureSites(game, st.systemId);
      }
    });
    /* Scan Osservatorio: indice (una volta per tick) dei sistemi con
       Osservatorio, per rivelare lo strato avanzato delle lune in raggio. */
    const obsBySys = observatorySystems(game);
    const keys = Object.keys(game.anomalies);
    for (let i = 0; i < keys.length; i++) {
      const site = game.anomalies[keys[i]];
      /* Mutua esclusione: se il corpo è stato colonizzato, rimuovi il sito
         d'estrazione (la colonia lo lavora ora). Gestisce il colonizza-dopo. */
      if (site.bodyKey != null && bodyIsColonized(game, site.sysId, site.bodyKey)) {
        delete game.anomalies[keys[i]];
        continue;
      }
      /* Scan Osservatorio (luna): rivela in modo PERMANENTE lo strato avanzato
         se una colonia con Osservatorio è entro raggio. Flag persistito sul
         sito (game.anomalies è serializzato): scansiona una volta, sai per sempre. */
      if (site.basket && !site.advRevealed && site.exoticW > 0 && obsBySys &&
          observatoryInRange(game, site.sysId, obsBySys)) {
        site.advRevealed = true;
      }
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
      /* Backfill lazy: cinture/giganti dei save vecchi erano mono (res); ora
         sono a paniere → calcola il mix una volta (idempotente). */
      const kdef = KINDS[site.kind] || {};
      if (kdef.basket && !site.basket) computeBasketMix(game, site.sysId, site.bodyKey, site);

      /* Estrattore che drena QUESTO sito: stazione ancorata (basket) o flotta in
         survey. Su un corpo a paniere la stazione ha la PRECEDENZA sull'estrattore
         (mutua esclusione): se ancorata, la flotta è ignorata. */
      const station = site.basket ? anchoredStation(game, site) : null;
      const extractorPresent = !!station || !!fleet;

      /* Rigenerazione DOPPIA (redesign estrazione 2026): con un estrattore
         presente la riserva si rigenera POCO (regenActive → a regime rende poco,
         accamparsi non conviene); senza estrattore si ricarica IN FRETTA
         (regenIdle → pronta per il prossimo burst). Premia lo smistamento.
         Per-kind (pianeti/lune sostenuti vs cinture/giganti/anomalie burst). */
      if (site.reserve < site.cap) {
        const regen = extractorPresent
          ? (kdef.regenActive != null ? kdef.regenActive : CFG.REGEN_ACTIVE_DEFAULT)
          : (kdef.regenIdle != null ? kdef.regenIdle : CFG.REGEN_IDLE_DEFAULT);
        site.reserve = Math.min(site.cap, site.reserve + regen);
        if (site.lowFlag && site.reserve > site.cap * CFG.LOW_FRAC * 2) site.lowFlag = false;
      }
      /* Raccolta. */
      if (extractorPresent && site.reserve > 0) {
        const rate = station ? stationExtractRate(station) : harvestRateFor(game, fleet);
        const take = Math.min(rate, site.reserve);
        if (take > 0) {
          if (site.basket) {
            /* Stazione ancorata → auto-feed magazzino + overflow × L; flotta
               estrattore → deposito diretto alla colonia più vicina al sito. */
            if (station) depositBasketToStation(game, station, site, take);
            else depositBasket(game, fleet, site, take);
          } else deposit(game, fleet, site.res, take, site);
          site.reserve -= take;
          site.harvested = (site.harvested || 0) + take;
          /* Usura/XP per Ι in survey (decisione utente 2026-06-16): SOLO per le
             navi che drenano (non per le stazioni, che non si consumano). */
          if (fleet && !station) {
            applySurveyWear(fleet);
            accrueSurveyXp(game, fleet, events);
          }
          if (!site.lowFlag && site.reserve <= site.cap * CFG.LOW_FRAC) {
            site.lowFlag = true;
            events.push({ kind: 'anomaly-depleted', sysId: site.sysId, res: site.res || null, impulso: game.timeImpulsi });
          }
          if (fleet && !station && ORION.fleet && ORION.fleet.forceReturnForWear) {
            if (ORION.fleet.forceReturnForWear(game, fleet)) {
              events.push({ kind: 'fleet-wear-return', fleetId: fleet.id, fleetName: fleet.name,
                sysId: site.sysId, impulso: game.timeImpulsi });
            }
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

  /* Siti noti (registrati) per la UI. Esclude i corpi colonizzati (mutua
     esclusione: un pianeta colonizzato non è più un sito d'estrazione). */
  function knownSites(game) {
    if (!game || !game.anomalies) return [];
    return Object.keys(game.anomalies).filter(function (k) {
      const s = game.anomalies[k];
      return !(s && s.bodyKey != null && bodyIsColonized(game, s.sysId, s.bodyKey));
    }).map(function (k) {
      const s = game.anomalies[k];
      const sys = game.galaxy.systems[s.sysId];
      /* Fix display 2026-06-27: il rate mostrato in UI era CFG.HARVEST_RATE
         statico (0.6) per OGNI sito → sembrava che l'estrazione fosse sempre
         0.6/Ι a prescindere da nave e Hangar. Ora riflette la flotta reale che
         drena: Estrattore scala con l'Hangar d'origine (1.0→2.2), Esploratore
         resta al fallback 0.6. `harvestRate` è il deposito EFFETTIVO per Ι
         (cappato dalla riserva+regen: a sito esaurito converge alla regen
         sostenibile); `harvestRateGross` è la capacità lorda della flotta. */
      /* Una luna può essere drenata da una STAZIONE ancorata (senza flotta):
         il rate riflette la fonte attiva (stazione o flotta). */
      const station = s.basket ? anchoredStation(game, s) : null;
      const fleet = station ? null : fleetSurveyingSite(game, s.sysId, s.kind, s.bodyKey);
      const harvesting = !!station || !!fleet;
      const grossRate = station ? stationExtractRate(station) : (fleet ? harvestRateFor(game, fleet) : 0);
      /* A sito esaurito il ritmo effettivo converge alla regen ATTIVA (mentre
         estrai), non a quella idle. */
      const kdef = KINDS[s.kind] || {};
      const regA = kdef.regenActive != null ? kdef.regenActive : CFG.REGEN_ACTIVE_DEFAULT;
      const effRate = harvesting
        ? Math.round(Math.min(grossRate, (s.reserve || 0) + regA) * 10) / 10
        : CFG.HARVEST_RATE;
      return {
        key: k, sysId: s.sysId, sysName: sys ? sys.name : '—', kind: s.kind,
        bodyKey: s.bodyKey || null,
        res: s.res || null, reserve: s.reserve, cap: s.cap,
        explored: !!s.explored, progress: s.progress || 0, loot: s.loot || null,
        harvested: s.harvested || 0,
        harvestRate: effRate,
        harvestRateGross: grossRate,
        harvesting: harvesting,
        /* Redesign lune: metadati paniere per la UI. */
        basket: !!s.basket, mix: s.mix || null, exoticW: s.exoticW || 0,
        advRevealed: !!s.advRevealed, advIds: s.advIds || [],
        bySource: station ? 'station' : (fleet ? 'fleet' : null)
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
      const station = s.basket ? anchoredStation(game, s) : null;
      /* Estrazione da STAZIONE ancorata: auto-alimenta il magazzino della
         stazione (solo l'eccedenza ×L arriva alla colonia, variabile) → NON la
         contiamo nel surplus diretto per colonia. Qui solo l'estrattore-flotta. */
      if (station) return;
      const fleet = fleetSurveyingSite(game, s.sysId, s.kind, s.bodyKey);
      if (!fleet) return;
      const colKey = depositColonyKey(game, fleet, s);
      if (!colKey) return;
      const rate = Math.min(station ? stationExtractRate(station) : harvestRateFor(game, fleet), s.reserve);
      if (rate <= 0) return;
      const slot = out[colKey] = out[colKey] || { met: 0, en: 0, sitesMet: 0, sitesEn: 0, fleets: 0, total: 0 };
      slot.fleets += 1;
      slot.total  += rate;
      if (s.basket && s.mix) {
        /* Paniere: ripartisci il rate sui pesi base; il pannello surplus mostra
           met/en, le altre confluiscono comunque nello stock via depositBasket. */
        const mix = s.mix;
        let tot = (mix.met || 0) + (mix.en || 0) + (mix.food || 0) + (mix.water || 0);
        if (s.advRevealed && s.exoticW > 0) tot += s.exoticW;
        if (tot > 0) {
          if (mix.met > 0) { slot.met += rate * (mix.met / tot); slot.sitesMet += 1; }
          if (mix.en  > 0) { slot.en  += rate * (mix.en  / tot); slot.sitesEn += 1; }
        }
      } else if (s.res === 'met') { slot.met += rate; slot.sitesMet += 1; }
      else if (s.res === 'en') { slot.en += rate; slot.sitesEn += 1; }
    });
    return out;
  }

  ORION.anomaly = {
    CFG: CFG,
    KINDS: KINDS,
    ensure: ensure,
    ensureSites: ensureSites,
    ensureExplored: ensureExplored,
    tick: tick,
    nextEventDelta: nextEventDelta,
    knownSites: knownSites,
    harvestByColony: harvestByColony,
    bodyGiacimento: bodyGiacimento
  };
})(typeof window !== 'undefined' ? window : this);
