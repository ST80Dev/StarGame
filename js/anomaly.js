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
    HARVEST_RATE: 0.6,    // risorse/Ι raccolte da una flotta presente
    REGEN: 0.15,          // rigenerazione/Ι della riserva quando idle
    RELIC_HOLD: 40,       // Ι di presenza per esplorare una reliquia
    RELIC_REWARD: { met: 220, en: 130 },
    LOW_FRAC: 0.15        // soglia "riserva quasi esaurita" (evento una volta)
  };

  /* Mappa kind → comportamento. */
  const KINDS = {
    detriti:  { harvest: true, res: 'met', cap: 420 },
    nebulosa: { harvest: true, res: 'en',  cap: 320 },
    reliquie: { harvest: false, relic: true }
  };

  function ensure(game) {
    if (!game) return;
    if (!game.anomalies || typeof game.anomalies !== 'object') game.anomalies = {};
    /* Transitorio: sistemi già scansionati per i siti (evita di rigenerare il
       sistema ogni tick). Ricostruito al load — i siti veri vivono in
       game.anomalies (persistito). */
    if (!game._anomScanned) game._anomScanned = {};
  }

  /* Registra i siti di un sistema in game.anomalies (idempotente).
     Chiamata quando una flotta orbita lì o quando il giocatore apre il
     sistema. Genera il sistema dal seed (deterministico) una sola volta. */
  function ensureSites(game, sysId) {
    ensure(game);
    if (game._anomScanned[sysId]) return;
    game._anomScanned[sysId] = true;
    if (!(ORION.system && ORION.system.generate)) return;
    const sys = ORION.system.generate(game.galaxy, sysId);
    const anoms = (sys && sys.anomalies) || [];
    for (let i = 0; i < anoms.length; i++) {
      const a = anoms[i];
      const def = KINDS[a.kind];
      if (!def) continue;
      const key = a.seed || (sysId + ':a' + i);
      if (game.anomalies[key]) continue;
      if (def.relic) {
        game.anomalies[key] = { sysId: sysId, kind: 'reliquie', explored: false, progress: 0 };
      } else {
        game.anomalies[key] = { sysId: sysId, kind: a.kind, res: def.res, cap: def.cap, reserve: def.cap, lowFlag: false };
      }
    }
  }

  function playerFleetOrbitingAt(game, sysId) {
    const fl = game.fleets || [];
    for (let i = 0; i < fl.length; i++) {
      const f = fl[i];
      if (f && f.location && f.location.systemId === sysId &&
          (f.location.status === 'orbiting' || f.location.status === 'docked')) return f;
    }
    return null;
  }

  /* Colonia su cui depositare il raccolto: origine della flotta, altrimenti
     fallback (capitale/prima colonia via dispatch). */
  function depositColonyKey(game, fleet) {
    const ok = fleet && fleet.ownerColonyKey;
    if (ok && game.colonies[ok] && game.colonies[ok].colonized) return ok;
    if (ORION.dispatch && ORION.dispatch.payColonyKey) return ORION.dispatch.payColonyKey(game);
    const keys = Object.keys(game.colonies || {});
    for (let i = 0; i < keys.length; i++) if (game.colonies[keys[i]].colonized) return keys[i];
    return null;
  }

  function deposit(game, fleet, res, amt) {
    const k = depositColonyKey(game, fleet);
    const col = k && game.colonies[k];
    if (col && col.stock) col.stock[res] = (col.stock[res] || 0) + amt;
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
      const fleet = playerFleetOrbitingAt(game, site.sysId);
      if (site.kind === 'reliquie') {
        if (site.explored) continue;
        if (fleet) {
          site.progress = (site.progress || 0) + 1;
          if (site.progress >= CFG.RELIC_HOLD) {
            site.explored = true;
            const colKey = depositColonyKey(game, fleet);
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
      /* Raccolta ricorrente. */
      if (fleet && site.reserve > 0) {
        const take = Math.min(CFG.HARVEST_RATE, site.reserve);
        deposit(game, fleet, site.res, take);
        site.reserve -= take;
        if (!site.lowFlag && site.reserve <= site.cap * CFG.LOW_FRAC) {
          site.lowFlag = true;
          events.push({ kind: 'anomaly-depleted', sysId: site.sysId, res: site.res, impulso: game.timeImpulsi });
        }
      } else if (!fleet && site.reserve < site.cap) {
        site.reserve = Math.min(site.cap, site.reserve + CFG.REGEN);
        if (site.lowFlag && site.reserve > site.cap * CFG.LOW_FRAC * 2) site.lowFlag = false;
      }
    }
  }

  /* Per nextEventImpulsi: ferma il fast-forward al completamento di una
     reliquia in esplorazione (sito presidiato da una flotta). */
  function nextEventDelta(game) {
    if (!game || !game.anomalies) return 0;
    let best = Infinity;
    Object.keys(game.anomalies).forEach(function (k) {
      const s = game.anomalies[k];
      if (s.kind === 'reliquie' && !s.explored && playerFleetOrbitingAt(game, s.sysId)) {
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
      return {
        key: k, sysId: s.sysId, sysName: sys ? sys.name : '—', kind: s.kind,
        res: s.res || null, reserve: s.reserve, cap: s.cap,
        explored: !!s.explored, progress: s.progress || 0, loot: s.loot || null,
        harvesting: !!playerFleetOrbitingAt(game, s.sysId)
      };
    });
  }

  ORION.anomaly = {
    CFG: CFG,
    KINDS: KINDS,
    ensure: ensure,
    ensureSites: ensureSites,
    tick: tick,
    nextEventDelta: nextEventDelta,
    knownSites: knownSites
  };
})(typeof window !== 'undefined' ? window : this);
