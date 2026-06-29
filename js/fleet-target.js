/* =====================================================================
   ORION EMPIRES — fleet-target.js  (Stadio 2.1 — flusso flotte)

   Descrittore NORMALIZZATO di un bersaglio (sistema o corpo) per
   ORION.fleet.actionsFor / canTargetBody. È il PONTE unico tra i
   sottosistemi vivi (system/ai/anomaly/colonies/galaxy) e l'UI: lo usano
   sia il modal sia l'ingresso-da-mappa, così la logica "che azioni offrire"
   vive in UN solo punto (fonte di verità: docs/FLEET_FLOW.md §5).

   Pura coordinazione: nessuno stato proprio, nessun DOM. Tollerante ai
   moduli non caricati (guardie) per i test headless.
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  function discoveryLevel(game, sysId) {
    const v = (game && game.state && game.state.discovery) ? game.state.discovery[sysId] : undefined;
    return (typeof v === 'number') ? v : 0;
  }
  function exploredAt(game, sysId) {
    const D = (ORION.galaxy && ORION.galaxy.DISCOVERY) || { EXPLORED: 2 };
    return discoveryLevel(game, sysId) >= (D.EXPLORED != null ? D.EXPLORED : 2);
  }

  /* Covo pirata nel sistema (presenza ostile a livello sistema). */
  function nestAt(game, sysId) {
    const nests = (game && game.piracy && game.piracy.nests) || [];
    for (let i = 0; i < nests.length; i++) {
      if (nests[i] && nests[i].sysId === sysId) return nests[i];
    }
    return null;
  }

  /* Tipo di anomalia su (sistema, corpo). Per i siti body-tied (cintura/
     gassoso) il giacimento è già coperto da anomaly.bodyGiacimento; qui
     serve soprattutto per detriti/nebulosa/reliquie (livello sistema). */
  function anomalyKindAt(game, sysId, bodyKey) {
    const anoms = (game && game.anomalies) || {};
    const bk = bodyKey != null ? String(bodyKey) : null;
    const keys = Object.keys(anoms);
    for (let i = 0; i < keys.length; i++) {
      const s = anoms[keys[i]];
      if (!s || s.sysId !== sysId) continue;
      const sBody = s.bodyKey != null ? String(s.bodyKey) : null;
      if (bk == null) { if (sBody == null) return s.kind; }
      else if (sBody === bk) return s.kind;
    }
    return null;
  }

  function findBody(game, sysId, bodyKey) {
    if (bodyKey == null || !ORION.system || !ORION.system.generate || !ORION.system.findBody) return null;
    let sys = null;
    try { sys = ORION.system.generate(game.galaxy, sysId); } catch (_) { return null; }
    return ORION.system.findBody(sys, bodyKey) || null;
  }

  /* describe(game, sysId, bodyKey?) → descrittore per actionsFor.
       kind: 'system' | 'body' | 'nest'
       explored, ownColony, colonizable, giacimento, anomalyKind,
       aiPresent, aiAlly  (+ sysId, bodyKey, nest) */
  function describe(game, sysId, bodyKey) {
    const bk = bodyKey != null ? String(bodyKey) : null;
    const out = {
      kind: bk == null ? 'system' : 'body',
      sysId: sysId, bodyKey: bk,
      explored: exploredAt(game, sysId),
      ownColony: false, colonizable: false, giacimento: false,
      anomalyKind: null, aiPresent: false, aiAlly: false, nest: false
    };
    if (!game) return out;

    const nest = nestAt(game, sysId);
    out.nest = !!nest;

    const body = findBody(game, sysId, bk);
    const def = (body && ORION.system && ORION.system.BODY_TYPES) ? ORION.system.BODY_TYPES[body.type] : null;
    const habitable = !!(def && def.habitable);

    /* Mia colonia su questo corpo? */
    if (bk != null && game.colonies) {
      const col = game.colonies[sysId + ':' + bk];
      out.ownColony = !!(col && col.colonized);
    }

    /* Presenza AI: prima per pianeta (sistemi condivisi), poi per sistema. */
    let civ = null;
    if (bk != null && ORION.ai && ORION.ai.civForPlanet) civ = ORION.ai.civForPlanet(game, sysId, bk);
    if (!civ && ORION.ai && ORION.ai.civForSystem) civ = ORION.ai.civForSystem(game, sysId);
    const aiHere = !!(civ && !out.ownColony);
    out.aiAlly = aiHere && civ.relation === 'alliance';
    out.aiPresent = aiHere && !out.aiAlly;

    /* Libero + abitabile → colonizzabile. */
    const isFree = !out.ownColony && !aiHere;
    out.colonizable = !!(isFree && habitable);

    /* Giacimento sfruttabile (non sulla mia colonia). */
    if (body && ORION.anomaly && ORION.anomaly.bodyGiacimento) {
      out.giacimento = !out.ownColony && !!ORION.anomaly.bodyGiacimento(body);
      /* Mutua esclusione (redesign lune): se una STAZIONE è ancorata a questa
         luna, estrae lei di default → non si manda anche un estrattore. */
      if (out.giacimento && bk != null && ORION.station && ORION.station.stationAnchoredAt &&
          ORION.station.stationAnchoredAt(game, sysId, bk)) {
        out.giacimento = false;
        out.stationAnchored = true;
      }
    }

    out.anomalyKind = anomalyKindAt(game, sysId, bk);

    /* Covo: bersaglio attaccabile/reconnabile a livello sistema. */
    if (nest && bk == null) out.kind = 'nest';

    return out;
  }

  /* Azioni disponibili per un bersaglio, già pronte per l'UI: delega a
     ORION.fleet.actionsFor sul descrittore. Comodo one-shot. */
  function actionsAt(game, sysId, bodyKey, fleet) {
    const t = describe(game, sysId, bodyKey);
    const acts = (ORION.fleet && ORION.fleet.actionsFor) ? ORION.fleet.actionsFor(t, fleet) : [];
    return { target: t, actions: acts };
  }

  ORION.fleetTarget = {
    describe: describe,
    actionsAt: actionsAt,
    exploredAt: exploredAt,
    nestAt: nestAt,
    anomalyKindAt: anomalyKindAt
  };
})(typeof window !== 'undefined' ? window : this);
