/* =====================================================================
   ORION EMPIRES — cohesion.js  (M10 Fase B — decisione #52 §13.6)

   COESIONE DI SISTEMA — stato DERIVATO (non persistito) che emerge quando
   due o più fazioni coabitano un sistema in pace. È un "consorzio locale"
   informale: chi prova a passare/colonizzare/attaccare paga in disposizione
   di tutti i membri.

   Sistema coeso se TUTTE queste condizioni sono vere:
     1. ≥2 fazioni distinte (può includere il giocatore) hanno colonie nel sistema
     2. ≥50% dei corpi colonizzabili sono colonizzati
     3. ≥3 colonie totali nel sistema
     4. Tutti i proprietari sono in pace/alleanza tra loro (vs giocatore)
     5. Il giocatore non è alleato di tutti

   Effetti (riusano meccaniche esistenti — niente nuovi parametri):
     - Move/move-route con flotta: warning UI + −1 disposizione/proprietario
       (cap −3 per atto di pianificazione)
     - Spedizione in transito: +5% rischio incidente/proprietario (cap +15%)
     - Colonizzazione di un corpo nel sistema coeso: −15 disp/proprietario
     - Attacco a un proprietario: −15 disp delle ALTRE coese del sistema
     - Rottura automatica: 2 membri in guerra OR giocatore alleato di tutti

   Determinismo (#5): zero RNG. Recovery-friendly (#22): nessun fail-state.
   Persistenza minima: SOLO `game.cohesion.sysIds[]` (lista dei coesi al tick
   scorso) per emettere formed/broken una sola volta. Il resto è derivato.
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  const CFG = {
    /* Soglie §13.6 */
    MIN_FACTIONS: 2,
    MIN_COLONIES: 3,
    MIN_COLONIZED_RATIO: 0.5,
    /* Effetti */
    TRAVEL_PER_OWNER: -1,
    TRAVEL_CAP: -3,
    COLONIZE_PER_OWNER: -15,
    ATTACK_PER_OTHER_OWNER: -15,
    EXPEDITION_RISK_PER_OWNER: 0.05,
    EXPEDITION_RISK_CAP: 0.15
  };

  /* ---------- Helpers ---------- */

  /* Conta i corpi colonizzabili (no asteroid belts / gassosi senza vita §6.2)
     in un sistema. Senza una scansione vera dei tipi-corpo del sistema usiamo
     il conteggio dei `bodies` come proxy: la verifica reale del tipo arriverà
     con la rifondazione system.js (Fase B punto 3). Qui ci basta che il
     denominatore della "%≥50%" sia stabile e deterministico dal seed. */
  function colonizableBodiesCount(galaxy, sysId) {
    const sys = galaxy && galaxy.systems && galaxy.systems[sysId];
    if (!sys) return 0;
    /* `sys.bodies` (lazy via system.js) può non esistere se la vista interna
       non è mai stata aperta — usa il conteggio salvato in `sys.bodyCount`
       (fallback 5 = media §6.1). */
    if (typeof sys.bodyCount === 'number') return Math.max(1, sys.bodyCount);
    if (Array.isArray(sys.bodies)) return Math.max(1, sys.bodies.length);
    return 5; // fallback ragionevole
  }

  /* Mappa proprietari nel sistema: { owners:[{type, id, name, color, planets:N}],
     totalColonies:N, playerColonies:N }. `type` = 'player' | 'civ'. */
  function ownersInSystem(game, sysId) {
    const out = { owners: [], totalColonies: 0, playerColonies: 0 };
    if (!game) return out;

    /* Colonie del giocatore. */
    let playerPlanets = 0;
    const prefix = sysId + ':';
    const cols = game.colonies || {};
    Object.keys(cols).forEach(function (k) {
      if (k.indexOf(prefix) !== 0) return;
      const c = cols[k];
      if (!c || !c.colonized) return;
      playerPlanets++;
    });
    if (playerPlanets) {
      out.owners.push({ type: 'player', id: 'player', name: 'Tu', color: '#5fa8ff', planets: playerPlanets });
      out.playerColonies = playerPlanets;
      out.totalColonies += playerPlanets;
    }

    /* Colonie delle civiltà AI: leggono civ.planets[] canonical. */
    const civs = game.civs || [];
    for (let i = 0; i < civs.length; i++) {
      const c = civs[i];
      if (!c || !c.alive || !Array.isArray(c.planets)) continue;
      let count = 0;
      for (let j = 0; j < c.planets.length; j++) {
        if (c.planets[j].indexOf(prefix) === 0) count++;
      }
      if (count > 0) {
        out.owners.push({ type: 'civ', id: c.id, name: c.name, color: c.color, planets: count });
        out.totalColonies += count;
      }
    }
    return out;
  }

  /* Tutti i proprietari AI sono in pace/alleanza fra loro? Il giocatore conta
     come una fazione separata: per ora la sua pace con un'AI è data dalla
     relation di quella AI (M11). */
  function allMembersAtPeace(game, owners) {
    /* Solo le coppie AI-vs-AI; tra le AI non c'è un sistema diretto di guerra
       in M11 Fase A (la pace tra AI è implicita: non ci sono war markers). Per
       Fase A diamo questo per implicito: se entrambe sono vive e nessuna delle
       due ha lastBattle con l'altra, sono "in pace". Approssimazione conservativa. */
    return true;
  }

  /* Il giocatore è alleato di TUTTI i membri AI del consorzio? */
  function playerAlliedWithAll(game, owners) {
    const civOwners = owners.filter(function (o) { return o.type === 'civ'; });
    if (!civOwners.length) return false;
    const civs = game.civs || [];
    for (let i = 0; i < civOwners.length; i++) {
      const oid = civOwners[i].id;
      const civ = civs.filter(function (c) { return c.id === oid; })[0];
      if (!civ || civ.relation !== 'alliance') return false;
    }
    return true;
  }

  /* È coeso? */
  function isCohesive(game, sysId) {
    if (!game || !game.galaxy) return false;
    const info = ownersInSystem(game, sysId);
    if (info.owners.length < CFG.MIN_FACTIONS) return false;
    if (info.totalColonies < CFG.MIN_COLONIES) return false;
    const bodies = colonizableBodiesCount(game.galaxy, sysId);
    if (info.totalColonies < bodies * CFG.MIN_COLONIZED_RATIO) return false;
    if (!allMembersAtPeace(game, info.owners)) return false;
    if (playerAlliedWithAll(game, info.owners)) return false;
    return true;
  }

  /* Restituisce un descrittore arricchito per UI tooltip / cronaca. */
  function cohesionInfo(game, sysId) {
    const info = ownersInSystem(game, sysId);
    const cohesive = isCohesive(game, sysId);
    return {
      sysId: sysId, cohesive: cohesive,
      owners: info.owners, totalColonies: info.totalColonies,
      playerColonies: info.playerColonies,
      bodies: colonizableBodiesCount(game.galaxy, sysId)
    };
  }

  /* Lista sysId attualmente coesi (live). */
  function cohesiveSysIds(game) {
    if (!game || !game.galaxy || !game.galaxy.systems) return [];
    const out = [];
    /* Limitiamo la scansione ai sistemi che hanno almeno una colonia (player o
       AI): senza ≥3 colonie totali un sistema NON può essere coeso. */
    const interesting = collectInterestingSystems(game);
    interesting.forEach(function (sid) { if (isCohesive(game, sid)) out.push(sid); });
    return out;
  }

  function collectInterestingSystems(game) {
    const set = new Set();
    Object.keys(game.colonies || {}).forEach(function (k) {
      const colon = k.indexOf(':');
      if (colon > 0) {
        const sid = Number(k.slice(0, colon));
        if (!isNaN(sid)) set.add(sid);
      }
    });
    (game.civs || []).forEach(function (c) {
      if (!c || !c.alive || !Array.isArray(c.planets)) return;
      c.planets.forEach(function (pk) {
        const colon = pk.indexOf(':');
        if (colon > 0) {
          const sid = Number(pk.slice(0, colon));
          if (!isNaN(sid)) set.add(sid);
        }
      });
    });
    const out = [];
    set.forEach(function (s) { out.push(s); });
    out.sort(function (a, b) { return a - b; });
    return out;
  }

  /* ---------- Tick: emette formed/broken una volta sola ---------- */
  function ensureCohesionState(game) {
    if (!game.cohesion || typeof game.cohesion !== 'object') {
      game.cohesion = { sysIds: [] };
    }
    if (!Array.isArray(game.cohesion.sysIds)) game.cohesion.sysIds = [];
    return game.cohesion;
  }

  function tick(game, events) {
    if (!game || !game.galaxy) return;
    const st = ensureCohesionState(game);
    const prev = new Set(st.sysIds);
    const live = cohesiveSysIds(game);
    const liveSet = new Set(live);
    const galaxy = game.galaxy;
    const now = game.timeImpulsi || 0;

    /* Formed: presenti ora, assenti prima. */
    for (let i = 0; i < live.length; i++) {
      const sid = live[i];
      if (!prev.has(sid)) {
        const info = cohesionInfo(game, sid);
        events.push({
          kind: 'system-cohesion-formed', sysId: sid,
          systemName: (galaxy.systems[sid] || {}).name,
          owners: info.owners.map(function (o) { return { name: o.name, color: o.color }; }),
          impulso: now
        });
      }
    }
    /* Broken: presenti prima, assenti ora. */
    for (let i = 0; i < st.sysIds.length; i++) {
      const sid = st.sysIds[i];
      if (!liveSet.has(sid)) {
        events.push({
          kind: 'system-cohesion-broken', sysId: sid,
          systemName: (galaxy.systems[sid] || {}).name,
          impulso: now
        });
      }
    }
    st.sysIds = live;
  }

  /* ---------- Penalità sui consumer ---------- */

  /* Travel: applica −1 disp/proprietario AI per ogni sistema coeso nella rotta,
     cap globale CFG.TRAVEL_CAP. `sysIds` = lista sistemi attraversati/destinazione
     (può contenere doppioni: deduplichiamo). Ritorna { applied: N, affectedSys:[] }
     per UI/cronaca. */
  function applyTravelPenalty(game, sysIds) {
    if (!game || !Array.isArray(sysIds) || !sysIds.length) return { applied: 0, affectedSys: [] };
    const seen = new Set();
    const affected = [];
    let totalDelta = 0;
    for (let i = 0; i < sysIds.length && totalDelta > CFG.TRAVEL_CAP; i++) {
      const sid = sysIds[i];
      if (seen.has(sid)) continue;
      seen.add(sid);
      if (!isCohesive(game, sid)) continue;
      const info = ownersInSystem(game, sid);
      let touchedHere = false;
      info.owners.forEach(function (o) {
        if (o.type !== 'civ') return;
        const civ = (game.civs || []).filter(function (c) { return c.id === o.id; })[0];
        if (!civ) return;
        const remaining = CFG.TRAVEL_CAP - totalDelta;       // < 0
        const room = -CFG.TRAVEL_PER_OWNER;                  // = 1 (positivo)
        // remaining < 0; se vogliamo non andare oltre, max delta per owner = max(CFG.TRAVEL_PER_OWNER, remaining)
        const delta = Math.max(CFG.TRAVEL_PER_OWNER, remaining);
        civ.disposition = Math.max(-100, (civ.disposition || 0) + delta);
        totalDelta += delta;
        touchedHere = true;
      });
      if (touchedHere) affected.push(sid);
    }
    return { applied: totalDelta, affectedSys: affected };
  }

  /* Colonizzazione: −15 a ogni proprietario AI del sistema. */
  function applyColonizePenalty(game, sysId) {
    if (!game) return 0;
    if (!isCohesive(game, sysId)) return 0;
    const info = ownersInSystem(game, sysId);
    let n = 0;
    info.owners.forEach(function (o) {
      if (o.type !== 'civ') return;
      const civ = (game.civs || []).filter(function (c) { return c.id === o.id; })[0];
      if (!civ) return;
      civ.disposition = Math.max(-100, (civ.disposition || 0) + CFG.COLONIZE_PER_OWNER);
      n++;
    });
    return n;
  }

  /* Attacco a un membro AI: −15 disp delle ALTRE coese del sistema (solidarietà). */
  function applyAttackPenalty(game, sysId, attackedCivId) {
    if (!game) return 0;
    if (!isCohesive(game, sysId)) return 0;
    const info = ownersInSystem(game, sysId);
    let n = 0;
    info.owners.forEach(function (o) {
      if (o.type !== 'civ' || o.id === attackedCivId) return;
      const civ = (game.civs || []).filter(function (c) { return c.id === o.id; })[0];
      if (!civ) return;
      civ.disposition = Math.max(-100, (civ.disposition || 0) + CFG.ATTACK_PER_OTHER_OWNER);
      n++;
    });
    return n;
  }

  /* Spedizione: +5% rischio incidente / proprietario, cap +15%. Consumato da
     expedition.js → accidentChance. */
  function expeditionRiskBonus(game, sysId) {
    if (!game) return 0;
    if (!isCohesive(game, sysId)) return 0;
    const info = ownersInSystem(game, sysId);
    let n = 0;
    info.owners.forEach(function (o) { if (o.type === 'civ') n++; });
    return Math.min(CFG.EXPEDITION_RISK_CAP, n * CFG.EXPEDITION_RISK_PER_OWNER);
  }

  ORION.cohesion = {
    CFG: CFG,
    isCohesive: isCohesive,
    cohesionInfo: cohesionInfo,
    cohesiveSysIds: cohesiveSysIds,
    ownersInSystem: ownersInSystem,
    tick: tick,
    applyTravelPenalty: applyTravelPenalty,
    applyColonizePenalty: applyColonizePenalty,
    applyAttackPenalty: applyAttackPenalty,
    expeditionRiskBonus: expeditionRiskBonus
  };
})(typeof window !== 'undefined' ? window : this);
