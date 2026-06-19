/* =====================================================================
   ORION EMPIRES — garrison.js
   M11/M13 — Presidio militare di sistema (decisione #93).

   Modello: una flotta abbastanza potente ferma in un sistema può dichiarare
   un PRESIDIO. La proprietà di pianeti/lune resta granulare (decisione #52);
   il presidio è SOLO "controllo militare di transito" basato sulla presenza
   fisica della flotta. Sostituisce `game.occupations` (che assumeva un
   passaggio di proprietà a livello sistema — incoerente col #52).

   API minima: declare/release/tick. Mai distruttivo:
     - decade automaticamente se la flotta lascia il sistema, scende sotto
       soglia, o viene distrutta (recovery-friendly #22).
     - lo status 'compromised' dà 20 Ι di grazia per ripristinare la potenza
       prima del decadimento (rinforzi).

   Effetti:
     1. Tag visivo + dichiarazione (UI/cronaca);
     2. Ingaggio automatico delle flotte ostili in transito (riusa combat
        scaramuccia esistente — la flotta di presidio combatte normalmente,
        non aggiungiamo un secondo motore);
     3. Negoziazione passaggio per pace/alleanza via dispaccio (M17) —
        cablato in `dispatch.js` / qui ci limitiamo a esporre l'API di
        consultazione;
     4. Mai cambio di proprietà — solo presenza militare dichiarata.

   Soglia (richiesta utente 2026-06-19): almeno 1 nave Fregata+ E potenza
   aggregata ≥ 500 punti (P = Σ hp + fp×8 per ogni nave militare;
   esclusi explorer/estrattore/coloniale).

   Persistenza: lazy/additivo (`game.garrisons` come oggetto chiave per sysId).
   NESSUN bump di schema — semplice rimozione delle vecchie `game.occupations`
   al load (recovery-friendly: il sistema torna libero).
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  const CFG = {
    MIN_CATEGORICAL: 'fregata',   // 1 nave di questa classe (o superiore) richiesta
    MIN_AGGREGATE: 500,           // ≥500 punti presidio
    TICK_EVERY_I: 10,             // ricontrollo soglia
    GRACE_I: 20,                  // grazia "compromesso" prima di decadimento
    FP_WEIGHT: 8                  // potenza per nave: hp + fp×FP_WEIGHT
  };

  /* Ordine classi militari dal più leggero al più pesante (per la soglia
     categorica). Allineato a fleet.js CLASSES. */
  const MILITARY_RANK = {
    caccia: 1, intercettore: 2, corvetta: 3,
    fregata: 4, incrociatore: 5, dreadnought: 6, ammiraglia: 7
  };
  function isMilitary(kind) { return MILITARY_RANK[kind] != null; }
  function meetsCategorical(kind) {
    return (MILITARY_RANK[kind] || 0) >= (MILITARY_RANK[CFG.MIN_CATEGORICAL] || 0);
  }

  /* Potenza aggregata di una flotta (P = Σ hp + fp×8 per nave militare).
     Le navi civili (explorer/estrattore/coloniale) sono escluse: non
     hanno presa difensiva su un sistema. */
  function powerOf(game, fleet) {
    const F = ORION.fleet;
    if (!fleet || !F || !F.CLASSES || !Array.isArray(fleet.ships)) return 0;
    let p = 0;
    for (let i = 0; i < fleet.ships.length; i++) {
      const s = fleet.ships[i];
      if (!s || !isMilitary(s.kind)) continue;
      const cls = F.CLASSES[s.kind];
      if (!cls) continue;
      p += (cls.hp || 0) + (cls.fp || 0) * CFG.FP_WEIGHT;
    }
    return p;
  }
  function hasCategoricalShip(fleet) {
    if (!fleet || !Array.isArray(fleet.ships)) return false;
    for (let i = 0; i < fleet.ships.length; i++) {
      const s = fleet.ships[i];
      if (s && meetsCategorical(s.kind)) return true;
    }
    return false;
  }

  function ensure(game) {
    if (!game) return null;
    if (!game.garrisons || typeof game.garrisons !== 'object') game.garrisons = {};
    /* Migrazione lazy: il vecchio game.occupations (M11 Fase A parziale) è
       incoerente col modello multi-proprietà per body (#52). Lo scartiamo:
       i sistemi non sono mai stati "del giocatore" senza presenza militare
       attiva — restano semplicemente liberi (le civ avevano già perso i
       pianeti via removeAllInSystem, quella perdita resta). */
    if (game.occupations) delete game.occupations;
    return game.garrisons;
  }

  /* È una flotta utilizzabile per il presidio? Ferma nel sistema, sopra
     soglia, e (nel caso di rinforzo) coerente col proprietario corrente. */
  function statusOfFleet(game, fleet) {
    if (!fleet || !fleet.location) return { ok: false, reason: 'Flotta non disponibile' };
    if (fleet.location.status === 'in-transit') return { ok: false, reason: 'Flotta in viaggio' };
    if (!hasCategoricalShip(fleet)) return { ok: false, reason: 'Serve almeno una Fregata o superiore' };
    const p = powerOf(game, fleet);
    if (p < CFG.MIN_AGGREGATE) return { ok: false, reason: 'Potenza ' + p + ' < ' + CFG.MIN_AGGREGATE + ' richiesti' };
    return { ok: true, power: p };
  }

  function canDeclare(game, fleet) {
    if (!game || !fleet) return { ok: false, reason: '—' };
    const chk = statusOfFleet(game, fleet);
    if (!chk.ok) return chk;
    const g = ensure(game);
    const sysId = fleet.location.systemId;
    const existing = g[sysId];
    if (existing && existing.fleetId !== fleet.id) {
      return { ok: false, reason: 'Sistema già presidiato' };
    }
    return { ok: true, power: chk.power };
  }

  function declare(game, fleet, events) {
    const chk = canDeclare(game, fleet);
    if (!chk.ok) return chk;
    const g = ensure(game);
    const sysId = fleet.location.systemId;
    if (g[sysId] && g[sysId].fleetId === fleet.id) return { ok: true, alreadyDeclared: true };
    g[sysId] = {
      sysId: sysId, fleetId: fleet.id, ownerId: 'player',
      declaredAt: game.timeImpulsi || 0,
      status: 'active', compromisedSince: null,
      lastPower: chk.power
    };
    if (events) {
      events.push({ kind: 'garrison-declared', sysId: sysId, fleetId: fleet.id,
        fleetName: fleet.name || ('Flotta ' + fleet.id), impulso: game.timeImpulsi });
    }
    return { ok: true };
  }

  function release(game, sysId, events, reason) {
    const g = ensure(game);
    if (!g[sysId]) return { ok: true };
    const removed = g[sysId];
    delete g[sysId];
    if (events) {
      events.push({ kind: 'garrison-released', sysId: sysId, fleetId: removed.fleetId,
        reason: reason || 'released', impulso: game.timeImpulsi });
    }
    return { ok: true };
  }

  function ofSystem(game, sysId) {
    const g = ensure(game);
    return g[sysId] || null;
  }
  function isGarrisoned(game, sysId) { return !!ofSystem(game, sysId); }
  function ownerOf(game, sysId) {
    const e = ofSystem(game, sysId);
    return e ? e.ownerId : null;
  }
  function fleetOfGarrison(game, sysId) {
    const e = ofSystem(game, sysId);
    if (!e) return null;
    const fleets = game.fleets || [];
    for (let i = 0; i < fleets.length; i++) if (fleets[i] && fleets[i].id === e.fleetId) return fleets[i];
    return null;
  }

  /* Manutenzione del presidio: ogni TICK_EVERY_I controlla che la flotta
     designata sia ancora nel sistema, viva, e sopra soglia. Status:
       active     — tutto ok
       compromised — fuori soglia o flotta uscita, GRACE_I per rientrare;
                     se rientra, torna active; se scade, decade. */
  function tick(game, events) {
    const g = ensure(game);
    const sysIds = Object.keys(g);
    if (!sysIds.length) return;
    const I = game.timeImpulsi || 0;
    for (let i = 0; i < sysIds.length; i++) {
      const sysId = sysIds[i];
      const entry = g[sysId];
      if (!entry) continue;
      const fleet = fleetOfGarrison(game, Number(sysId));
      let healthy = false;
      let power = 0;
      if (fleet && fleet.location && fleet.location.systemId === Number(sysId) &&
          fleet.location.status !== 'in-transit') {
        power = powerOf(game, fleet);
        healthy = hasCategoricalShip(fleet) && power >= CFG.MIN_AGGREGATE;
      }
      if (healthy) {
        if (entry.status === 'compromised') {
          entry.status = 'active'; entry.compromisedSince = null;
          if (events) events.push({ kind: 'garrison-restored', sysId: Number(sysId),
            fleetId: entry.fleetId, impulso: I });
        }
        entry.lastPower = power;
        continue;
      }
      // Non healthy: passa a compromised o scade
      if (entry.status !== 'compromised') {
        entry.status = 'compromised'; entry.compromisedSince = I;
        if (events) events.push({ kind: 'garrison-compromised', sysId: Number(sysId),
          fleetId: entry.fleetId, impulso: I });
        continue;
      }
      if (I - (entry.compromisedSince || I) >= CFG.GRACE_I) {
        delete g[sysId];
        if (events) events.push({ kind: 'garrison-lapsed', sysId: Number(sysId),
          fleetId: entry.fleetId, impulso: I });
      }
    }
  }

  /* ------------------------------------------------------------------
     INGAGGIO INTRUSI — riusa il combat esistente. Quando una flotta
     ostile (war o disposizione <= -40) entra in un sistema presidiato dal
     giocatore, il sistema di scaramuccia in time.js già la ingaggia se
     trovi una flotta ostile e c'è hostilePresenceAt. Qui esponiamo solo
     l'helper "should challenge?" per civ in pace/alleanza (negoziazione
     passaggio via dispaccio M17). Il combat vero NON è qui — viene da
     processSkirmishes con l'ostilità già esistente.
     ------------------------------------------------------------------ */
  function shouldRequestPassage(game, sysId, civ) {
    if (!isGarrisoned(game, sysId)) return false;
    if (ownerOf(game, sysId) !== 'player') return false;
    if (!civ || !civ.alive) return false;
    const D = root.ORION.diplomacy;
    const rel = (D && D.effectiveRelation) ? D.effectiveRelation(game, civ) : (civ.relation || 'peace');
    return (rel === 'peace' || rel === 'alliance' || rel === 'truce');
  }

  ORION.garrison = {
    CFG: CFG,
    ensure: ensure,
    canDeclare: canDeclare,
    declare: declare,
    release: release,
    ofSystem: ofSystem,
    isGarrisoned: isGarrisoned,
    ownerOf: ownerOf,
    fleetOfGarrison: fleetOfGarrison,
    powerOf: powerOf,
    hasCategoricalShip: hasCategoricalShip,
    statusOfFleet: statusOfFleet,
    shouldRequestPassage: shouldRequestPassage,
    tick: tick
  };
})(typeof window !== 'undefined' ? window : this);
