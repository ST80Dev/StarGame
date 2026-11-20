/* =====================================================================
   ORION EMPIRES — commands.js
   Livello comandi (Revisione 2026, Fase 2): le azioni del giocatore che
   modificano lo stato di gioco, separate dalla UI. Ogni comando prende
   (game, …) e ritorna { ok, reason?, …dati per la UI }. La UI mostra
   messaggi/cronaca e aggiorna le viste; il comando non tocca il DOM.
   ===================================================================== */
(function (root) {
  'use strict';
  const ORION = root.ORION || (root.ORION = {});

  /* ---------------- Colonizzazione (#66, §6.2) ---------------- */
  const COLONIST_COST_PER_LEVEL = { food: 30, water: 15 };

  function colonizeCost(g, planet, fleet, loadPop) {
    const cost = planet.colCost;
    const homeColony = g.colonies[g.homePlanetKey];
    const homeInTrouble = !!(homeColony && homeColony._scar &&
      (homeColony._scar.food.state === 'crit' || homeColony._scar.water.state === 'crit'));
    /* Il moltiplicatore §6.2 si applica se la home è ancora produttiva.
       Per coerenza con il flusso legacy, il check è sulla home (non sulla
       colonia origine della flotta). */
    const mul = (homeInTrouble || (g.colonies[planet.systemId + ':' + planet.bodyKey] || {}).isHomeBase) ? 1 : 5;
    /* Fix B: i coloni considerati per il costo sono quelli effettivamente
       a bordo + quelli che il picker sta per imbarcare ora (additivo).
       Se loadPop è undefined, il chiamante non ha ancora deciso → 0. */
    const onboardNow = (fleet && fleet.popOnboard) || 0;
    const extraLoad = (typeof loadPop === 'number') ? Math.max(0, loadPop | 0) : 0;
    const colonistTotal = onboardNow + extraLoad;
    const colonistCost = {
      met:   0,
      en:    0,
      water: COLONIST_COST_PER_LEVEL.water * colonistTotal,
      food:  COLONIST_COST_PER_LEVEL.food * colonistTotal
    };
    const totalCost = {
      met:   Math.round(cost.met   * mul),
      en:    Math.round(cost.en    * mul),
      water: Math.round(cost.water * mul) + colonistCost.water,
      food:  Math.round(cost.food  * mul) + colonistCost.food
    };
    /* Le risorse vengono prese dalla colonia origine della flotta. */
    const payerKey = fleet ? fleet.ownerColonyKey : g.homePlanetKey;
    const payer = g.colonies[payerKey];
    const stock = payer ? payer.stock : { met: 0, en: 0, food: 0, water: 0 };
    const canPay =
      (stock.met   || 0) >= totalCost.met   &&
      (stock.en    || 0) >= totalCost.en    &&
      (stock.water || 0) >= totalCost.water &&
      (stock.food  || 0) >= totalCost.food;
    return {
      totalCost: totalCost, mul: mul, homeInTrouble: homeInTrouble,
      payerKey: payerKey, payer: payer, canPay: canPay,
      baseImpulsi: cost.impulsi,
      colonistCost: colonistCost, colonistTotal: colonistTotal
    };
  }

  /* Avvia la colonizzazione: paga il costo dalla colonia origine della
     flotta, imbarca i coloni aggiuntivi, imposta l'ordine 'colonize' (con
     rollback completo se l'ordine è rifiutato), ribattezza la flotta e
     applica la penalità di coesione (#52 §13.6). */
  function colonize(g, planet, fleet, loadPop) {
    const F = ORION.fleet;
    if (!g || !F) return { ok: false, reason: null };
    const colKey = planet.systemId + ':' + planet.bodyKey;
    const colony = g.colonies[colKey];
    if (!colony || colony.colonized || colony.colonizing) return { ok: false, reason: null };
    /* Fix (C) sessione 2026-06-09: loadPop dal picker rappresenta l'imbarco
       AGGIUNTIVO. La pop già a bordo (fleet.popOnboard) NON viene re-imbarcata
       né re-sottratta dalla colonia. Il costo coloni (B) considera SOMMA dei
       livelli totali a bordo (già + nuovi), perché tutti consumano provviste. */
    const cap = F.fleetPopCargoCap ? F.fleetPopCargoCap(fleet) : 0;
    const onboardNow = fleet.popOnboard || 0;
    const roomOnShip = Math.max(0, cap - onboardNow);
    const reqLoad = (typeof loadPop === 'number') ? Math.max(0, Math.min(roomOnShip, loadPop | 0)) : 0;
    /* Costo info ricalcolato con loadPop effettivo (decisione B: provviste extra). */
    const info = colonizeCost(g, planet, fleet, reqLoad);
    if (!info.canPay) return { ok: false, reason: 'Risorse insufficienti' };
    /* Imbarco SOLO della quota aggiuntiva. Se 0 e la flotta ha già coloni a bordo,
       nessun imbarco viene chiamato → nessuna nuova Diaspora attivata. */
    if (reqLoad > 0) {
      const embarkRes = F.embarkPop(g, fleet, info.payerKey, reqLoad);
      if (!embarkRes.ok) {
        return { ok: false, reason: 'Imbarco coloni: ' + (embarkRes.reason || 'errore') };
      }
    }
    /* Deduce dal payer (colonia origine della flotta). */
    ['met', 'en', 'water', 'food'].forEach(function (k) {
      info.payer.stock[k] = Math.max(0, (info.payer.stock[k] || 0) - info.totalCost[k]);
    });
    /* Calcola le 3 fasi e imposta l'ordine.
       Decisione #66 (refinement, sessione 2026-06-09): foundation dipende solo
       dal pianeta (grandezza+ostilità via colCost.impulsi §6.2), NON dal viaggio.
       Travel e orbit si aggiungono sopra. Intra-sistema → totale ≈ orbit + foundation;
       extra-sistema → totale ≈ travel + orbit + foundation (M13 iperguida scalerà
       solo il travel). Più fisicamente intuitivo + travel diventa "visibile" come
       costo, motivazione narrativa per M13. */
    const intra = (fleet.location.systemId === planet.systemId);
    const orbitI = 10;
    const foundationI = Math.max(20, info.baseImpulsi);
    /* Memo del costo pagato per refund 50% se nave persa in transit. */
    fleet._colonizePaidCost = {
      coloniale: F.getClass('coloniale').cost,
      colonization: { met: info.totalCost.met, en: info.totalCost.en, food: info.totalCost.food, water: info.totalCost.water },
      payerKey: info.payerKey
    };
    const r = F.setOrder(g, fleet, {
      type: 'colonize',
      toSysId: planet.systemId,
      bodyKey: planet.bodyKey,
      orbitI: orbitI,
      foundationI: foundationI
    });
    if (!r.ok) {
      /* Rollback risorse. */
      ['met', 'en', 'water', 'food'].forEach(function (k) {
        info.payer.stock[k] = (info.payer.stock[k] || 0) + info.totalCost[k];
      });
      /* Fix rollback completo sessione 2026-06-09: se abbiamo imbarcato coloni
         in questo doColonize (reqLoad > 0), embarkPop ha già sottratto la pop
         dalla colonia origine + attivato la Diaspora. Se setOrder fallisce,
         quei side-effects vanno annullati: pop torna alla sorgente, Diaspora
         rimossa (era stata appena creata da embarkPop in questo flusso).
         NB: i coloni preesistenti (onboardNow) restano sulla flotta — quelli
         erano stati imbarcati in precedenza via Manage, NON è il nostro flusso
         da rollbackare. */
      if (reqLoad > 0 && info.payer && info.payer.pop) {
        const popCap = info.payer.pop.cap || 0;
        const room = Math.max(0, popCap - (info.payer.pop.total || 0));
        const back = Math.min(reqLoad, room);
        info.payer.pop.total = (info.payer.pop.total || 0) + back;
        fleet.popOnboard = Math.max(0, (fleet.popOnboard || 0) - reqLoad);
        /* La Diaspora era stata creata/rinnovata da embarkPop nel flusso corrente
           (startedAt === g.timeImpulsi). La rimuoviamo solo se è "fresca" — così
           non eliminiamo una Diaspora preesistente legittima. */
        if (info.payer.diaspora && info.payer.diaspora.startedAt === (g.timeImpulsi || 0)) {
          info.payer.diaspora = null;
        }
      }
      fleet._colonizePaidCost = null;
      return { ok: false, reason: r.reason || 'Ordine rifiutato' };
    }
    /* Callsign d'esordio "Pioniere N" se ancora auto-derivato. */
    if (ORION.fleetNaming) ORION.fleetNaming.maybeAutoRename(g, fleet, { type: 'colonize', toSysId: planet.systemId });
    /* Colonizzare in un sistema coeso costa disposizione ai proprietari AI. */
    const cohesionHits = (ORION.cohesion && ORION.cohesion.applyColonizePenalty)
      ? ORION.cohesion.applyColonizePenalty(g, planet.systemId) : 0;
    return { ok: true, intra: intra, path: r.path || null, cohesionHits: cohesionHits };
  }

  /* ---------------- Tributo d'assedio (leva di recovery #22) ---------------- */
  function siegeTributeCost(battle) {
    const C = ORION.combat;
    const atkHp = C ? C.totalHp({ combatants: battle.attacker.combatants }) : 50;
    return { met: Math.round(atkHp * 0.6), en: Math.round(atkHp * 0.3) };
  }
  const TRIBUTE_TRUCE_I = 200;

  /* Paga il tributo: l'assedio è revocato; con una civiltà AI scatta una
     tregua breve. Paga la colonia assediata (stazioni: non disponibile). */
  function payTribute(g, battleId) {
    const battle = (g.battles || []).filter(function (b) { return b.id === battleId; })[0];
    if (!battle) return { ok: false, reason: 'gone' };
    const colony = battle.colonyKey ? g.colonies[battle.colonyKey] : null;
    if (!colony) return { ok: false, reason: 'Il tributo è disponibile solo per gli assedi alle colonie' };
    const cost = siegeTributeCost(battle);
    if ((colony.stock.met || 0) < cost.met || (colony.stock.en || 0) < cost.en) {
      return { ok: false, reason: 'Risorse insufficienti per il tributo' };
    }
    colony.stock.met -= cost.met; colony.stock.en -= cost.en;
    battle.status = 'done';
    g.battles = (g.battles || []).filter(function (b) { return b !== battle; });
    let truceI = 0;
    if (battle.attackerKind === 'ai' && battle.attackerCiv) {
      const civ = (g.civs || []).filter(function (c) { return c.id === battle.attackerCiv; })[0];
      if (civ) { civ.truceUntil = (g.timeImpulsi || 0) + TRIBUTE_TRUCE_I; truceI = TRIBUTE_TRUCE_I; }
    }
    return { ok: true, cost: cost, colonyKey: battle.colonyKey, truceI: truceI };
  }

  ORION.commands = {
    COLONIST_COST_PER_LEVEL: COLONIST_COST_PER_LEVEL,
    colonizeCost: colonizeCost,
    colonize: colonize,
    siegeTributeCost: siegeTributeCost,
    payTribute: payTribute
  };
})(typeof window !== 'undefined' ? window : globalThis);
