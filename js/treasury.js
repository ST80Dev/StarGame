/* =====================================================================
   ORION EMPIRES — treasury.js
   Modulo M12 (Fase A2): Tesoreria & valute regionali (decisione #56/#53 §15.4).

   SCOPE FASE A2 (questo file):
     - Una VALUTA per regione (cluster stellare §9), nome+simbolo+valore
       derivati dal seed (deterministici, NON persistiti: si rigenerano come
       la galassia — seed+delta, decisione #5). Tono SW-flavor (decisione #34).
     - TESORERIA: portfolio delle valute possedute (`game.treasury.balances`,
       l'unico stato persistito) + CAMBIO sempre disponibile (digitale, no
       banca fisica) con SPREAD modulato da Reputazione §14 + presenza Mekhari.
     - BANCO REGIONALE: conversione base risorsa↔valuta locale al prezzo di
       riferimento regionale (la "vendita in regione" §15.4) — faucet e sink
       della valuta finché gli accordi AI (§15.3) e i beni esclusivi
       (M13/M14/M17) non daranno altri canali.

   FASE B/futuri: spread "convenienza locale" come servizio Mekhari pieno,
   beni esclusivi regionali da comprare in valuta (M13/M14), tributi/dazi
   sulle rotte AI, tassi dinamici come vettore eventi (M17).

   Determinismo (decisione #5/#22): le valute (nome/simbolo/valore) vengono
   dal seed; le operazioni (cambio/vendita/acquisto) sono matematica pura su
   balances/stock modulata da reputazione+Mekhari (stato), zero RNG. Replay
   identico. Recovery-friendly: nessun fail-state, nessun saldo negativo.
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  /* Prezzo di riferimento delle 4 risorse base in "crediti" neutri. Cibo e
     acqua valgono di più (sono i driver di crescita più scarsi, emenda #45/#37). */
  const REF_PRICE = { met: 1.0, en: 0.9, food: 1.4, water: 1.2 };

  /* Spread base e modulatori (§15.4). */
  const SPREAD_BASE = 0.08;
  const SPREAD_MIN = 0.02;
  const SPREAD_MAX = 0.16;
  const REP_GOOD = 70, REP_BAD = 30;
  const REP_GOOD_MUL = 0.7, REP_BAD_MUL = 1.3;
  const MEKHARI_MUL = 0.7;          // arbitraggio Mekhari: spread più basso

  /* Saldo iniziale nella valuta della regione d'origine. */
  const START_BALANCE = 250;

  /* Prefissi tematici per i nomi-valuta (tono SW-flavor, decisione #34).
     Si combinano col nome della regione (es. "Stilla di Vega", "Lama Keth"). */
  const CUR_PREFIXES = [
    'Stilla', 'Lama', 'Voto', 'Scaglia', 'Conio', 'Tessera', 'Lumen',
    'Grano', 'Sigillo', 'Marca', 'Obolo', 'Talento', 'Cifra', 'Vincolo',
    'Scheggia', 'Pegno'
  ];

  /* ------------------------------------------------------------------
     Lazy-init dello stato persistito (solo le balances). Le valute
     (nome/simbolo/valore) sono cache derivata dal seed in game._currencies.
     ------------------------------------------------------------------ */
  function ensure(game) {
    if (!game) return;
    if (!game.treasury || typeof game.treasury !== 'object') game.treasury = { balances: {} };
    if (!game.treasury.balances || typeof game.treasury.balances !== 'object') game.treasury.balances = {};
  }

  /* baseName — toglie eventuali designazioni di catalogo dal nome regione
     per estrarre la parola distintiva (ultima significativa). */
  function distinctiveWord(name) {
    const tokens = String(name || '').split(/\s+/).filter(Boolean);
    if (!tokens.length) return 'Regione';
    /* L'ultima parola è di solito il riferimento (es. "Velo di Vega" → Vega,
       "Braccio di Canopus" → Canopus, "Ammasso Keth-Var" → Keth-Var). */
    return tokens[tokens.length - 1];
  }

  /* Calcola (e cachea) le valute della galassia: una per gruppo stellare. */
  function currencies(game) {
    if (game._currencies && game._currencies._seed === game.seed) return game._currencies.list;
    const list = [];
    const groups = (game.galaxy && game.galaxy.groups) || [];
    for (let i = 0; i < groups.length; i++) {
      const gp = groups[i];
      const rng = ORION.rng.makeRng(game.seed + ':currency:' + gp.id);
      const prefix = rng.pick(CUR_PREFIXES);
      const word = distinctiveWord(gp.name);
      const withDi = rng.chance(0.7);
      const name = prefix + (withDi ? ' di ' : ' ') + word;
      const symbol = (prefix.charAt(0) + (word.charAt(0) || '')).toUpperCase();
      /* Valore relativo (quanto "vale" un'unità): 0.75–1.35. */
      const value = Math.round(rng.range(0.75, 1.35) * 100) / 100;
      list.push({
        clusterId: gp.id,
        region: gp.name,
        acronym: gp.acronym || '',
        name: name,
        symbol: symbol,
        value: value
      });
    }
    game._currencies = { _seed: game.seed, list: list };
    return list;
  }

  function currencyFor(game, clusterId) {
    const list = currencies(game);
    for (let i = 0; i < list.length; i++) if (list[i].clusterId === clusterId) return list[i];
    return null;
  }

  /* Cluster (gruppo stellare) di un sistema / di una colonia. */
  function clusterOfSystem(game, sysId) {
    const s = game.galaxy && game.galaxy.systems && game.galaxy.systems[sysId];
    return s ? (s.cluster != null ? s.cluster : (s.clusterId != null ? s.clusterId : null)) : null;
  }
  function clusterOfColony(game, colonyKey) {
    const c = game.colonies && game.colonies[colonyKey];
    if (!c) return null;
    return clusterOfSystem(game, c.systemId);
  }

  /* Saldo in una valuta (0 se assente). */
  function balance(game, clusterId) {
    ensure(game);
    return game.treasury.balances[clusterId] || 0;
  }
  function addBalance(game, clusterId, delta) {
    ensure(game);
    const cur = game.treasury.balances[clusterId] || 0;
    const next = Math.max(0, cur + delta);
    game.treasury.balances[clusterId] = Math.round(next * 100) / 100;
    return game.treasury.balances[clusterId];
  }

  /* Saldo iniziale (chiamato una sola volta a newGame). Idempotente: non
     ricarica se la regione d'origine ha già un saldo. */
  function seedStartingBalance(game) {
    ensure(game);
    const homeCluster = clusterOfSystem(game, game.galaxy ? game.galaxy.homeId : -1);
    if (homeCluster == null) return;
    if (!game.treasury.balances[homeCluster]) {
      game.treasury.balances[homeCluster] = START_BALANCE;
    }
  }

  /* Presenza Mekhari (4 Costanti §13.7) in un cluster → arbitraggio = spread
     più basso (§15.4). */
  function mekhariInCluster(game, clusterId) {
    const civs = game.civs || [];
    for (let i = 0; i < civs.length; i++) {
      const c = civs[i];
      if (!c || c.faction !== 'mekhari') continue;
      const sys = c.systems || [];
      for (let j = 0; j < sys.length; j++) {
        if (clusterOfSystem(game, sys[j]) === clusterId) return true;
      }
    }
    return false;
  }

  /* Spread effettivo per una valuta (§15.4): base × fattore reputazione ×
     bonus Mekhari, clampato. */
  function spread(game, clusterId) {
    let s = SPREAD_BASE;
    const rep = (typeof game.reputation === 'number') ? game.reputation : 50;
    if (rep >= REP_GOOD) s *= REP_GOOD_MUL;
    else if (rep < REP_BAD) s *= REP_BAD_MUL;
    if (mekhariInCluster(game, clusterId)) s *= MEKHARI_MUL;
    return Math.max(SPREAD_MIN, Math.min(SPREAD_MAX, Math.round(s * 1000) / 1000));
  }

  /* ------------------------------------------------------------------
     CAMBIO valuta↔valuta. Tasso lordo = value_from / value_to; lo spread
     della valuta acquisita (`to`) è la frizione.
     ------------------------------------------------------------------ */
  function crossRate(game, fromCluster, toCluster) {
    const a = currencyFor(game, fromCluster), b = currencyFor(game, toCluster);
    if (!a || !b) return 0;
    return a.value / b.value;
  }
  function quoteExchange(game, fromCluster, toCluster, amount) {
    amount = Math.max(0, amount || 0);
    if (fromCluster === toCluster) return { ok: false, reason: 'Stessa valuta' };
    const rate = crossRate(game, fromCluster, toCluster);
    if (!rate) return { ok: false, reason: 'Valuta sconosciuta' };
    const sp = spread(game, toCluster);
    const gross = amount * rate;
    const net = gross * (1 - sp);
    return { ok: true, get: Math.round(net * 100) / 100, rate: rate, spread: sp };
  }
  function exchange(game, fromCluster, toCluster, amount) {
    ensure(game);
    amount = Math.round(Math.max(0, amount || 0) * 100) / 100;
    if (amount <= 0) return { ok: false, reason: 'Importo non valido' };
    if (balance(game, fromCluster) < amount) return { ok: false, reason: 'Saldo insufficiente' };
    const q = quoteExchange(game, fromCluster, toCluster, amount);
    if (!q.ok) return q;
    addBalance(game, fromCluster, -amount);
    addBalance(game, toCluster, q.get);
    return { ok: true, spent: amount, got: q.get, spread: q.spread };
  }

  /* ------------------------------------------------------------------
     BANCO REGIONALE — converte risorse base ↔ valuta locale (della regione
     della colonia) al prezzo di riferimento, con spread.
       vendita: dai `amount` di risorsa, ricevi crediti/valuta (−spread)
       acquisto: paghi valuta (+spread), ricevi `amount` di risorsa
     ------------------------------------------------------------------ */
  function quoteSell(game, colonyKey, resource, amount) {
    amount = Math.max(0, amount || 0);
    if (REF_PRICE[resource] == null) return { ok: false, reason: 'Risorsa non commerciabile' };
    const cluster = clusterOfColony(game, colonyKey);
    const cur = currencyFor(game, cluster);
    if (!cur) return { ok: false, reason: 'Nessuna valuta regionale' };
    const sp = spread(game, cluster);
    const credits = amount * REF_PRICE[resource];
    const got = (credits / cur.value) * (1 - sp);
    return { ok: true, cluster: cluster, currency: cur, get: Math.round(got * 100) / 100, spread: sp };
  }
  function sellResource(game, colonyKey, resource, amount) {
    ensure(game);
    amount = Math.round(Math.max(0, amount || 0) * 100) / 100;
    if (amount <= 0) return { ok: false, reason: 'Quantità non valida' };
    const colony = game.colonies && game.colonies[colonyKey];
    if (!colony || !colony.colonized) return { ok: false, reason: 'Colonia non operativa' };
    if ((colony.stock[resource] || 0) < amount) return { ok: false, reason: 'Risorsa insufficiente' };
    const q = quoteSell(game, colonyKey, resource, amount);
    if (!q.ok) return q;
    colony.stock[resource] = Math.round(((colony.stock[resource] || 0) - amount) * 100) / 100;
    addBalance(game, q.cluster, q.get);
    return { ok: true, sold: amount, got: q.get, cluster: q.cluster, currency: q.currency };
  }
  function quoteBuy(game, colonyKey, resource, amount) {
    amount = Math.max(0, amount || 0);
    if (REF_PRICE[resource] == null) return { ok: false, reason: 'Risorsa non commerciabile' };
    const cluster = clusterOfColony(game, colonyKey);
    const cur = currencyFor(game, cluster);
    if (!cur) return { ok: false, reason: 'Nessuna valuta regionale' };
    const sp = spread(game, cluster);
    const credits = amount * REF_PRICE[resource];
    const cost = (credits / cur.value) * (1 + sp);
    return { ok: true, cluster: cluster, currency: cur, cost: Math.round(cost * 100) / 100, spread: sp };
  }
  function buyResource(game, colonyKey, resource, amount) {
    ensure(game);
    amount = Math.round(Math.max(0, amount || 0) * 100) / 100;
    if (amount <= 0) return { ok: false, reason: 'Quantità non valida' };
    const colony = game.colonies && game.colonies[colonyKey];
    if (!colony || !colony.colonized) return { ok: false, reason: 'Colonia non operativa' };
    const q = quoteBuy(game, colonyKey, resource, amount);
    if (!q.ok) return q;
    if (balance(game, q.cluster) < q.cost) return { ok: false, reason: 'Valuta insufficiente' };
    addBalance(game, q.cluster, -q.cost);
    colony.stock[resource] = Math.round(((colony.stock[resource] || 0) + amount) * 100) / 100;
    return { ok: true, bought: amount, cost: q.cost, cluster: q.cluster, currency: q.currency };
  }

  /* Valute con saldo > 0 (per la UI portfolio). */
  function heldCurrencies(game) {
    ensure(game);
    return currencies(game).filter(function (c) {
      return (game.treasury.balances[c.clusterId] || 0) > 0;
    });
  }
  function totalCredits(game) {
    /* Valore aggregato del portfolio in crediti neutri (Σ saldo×value). */
    ensure(game);
    let tot = 0;
    currencies(game).forEach(function (c) {
      tot += (game.treasury.balances[c.clusterId] || 0) * c.value;
    });
    return Math.round(tot * 100) / 100;
  }

  /* Spende `credits` (valore neutro) attingendo dalle valute possedute, in
     ordine di valore-di-possesso decrescente (le più "pesanti" prima). Usato
     dal fixer Mekhari (§15.5), che accetta qualunque valuta. Ritorna
     { ok, spent } o { ok:false } se il portfolio non basta. Deterministico. */
  function spendCredits(game, credits) {
    ensure(game);
    credits = Math.round(Math.max(0, credits || 0) * 100) / 100;
    if (credits <= 0) return { ok: true, spent: 0 };
    if (totalCredits(game) + 1e-6 < credits) return { ok: false, reason: 'Tesoreria insufficiente' };
    /* Ordina le valute per valore-di-possesso (balance × value) decrescente. */
    const ranked = currencies(game).map(function (c) {
      return { cid: c.clusterId, value: c.value, hold: (game.treasury.balances[c.clusterId] || 0) * c.value };
    }).filter(function (x) { return x.hold > 0; })
      .sort(function (a, b) { return b.hold - a.hold; });
    let need = credits;
    for (let i = 0; i < ranked.length && need > 1e-6; i++) {
      const take = Math.min(need, ranked[i].hold);
      addBalance(game, ranked[i].cid, -(take / ranked[i].value));
      need -= take;
    }
    return { ok: true, spent: credits };
  }

  ORION.treasury = {
    REF_PRICE: REF_PRICE,
    SPREAD_BASE: SPREAD_BASE,
    START_BALANCE: START_BALANCE,
    ensure: ensure,
    currencies: currencies,
    currencyFor: currencyFor,
    clusterOfSystem: clusterOfSystem,
    clusterOfColony: clusterOfColony,
    balance: balance,
    addBalance: addBalance,
    seedStartingBalance: seedStartingBalance,
    mekhariInCluster: mekhariInCluster,
    spread: spread,
    crossRate: crossRate,
    quoteExchange: quoteExchange,
    exchange: exchange,
    quoteSell: quoteSell,
    sellResource: sellResource,
    quoteBuy: quoteBuy,
    buyResource: buyResource,
    heldCurrencies: heldCurrencies,
    totalCredits: totalCredits,
    spendCredits: spendCredits
  };
})(typeof window !== 'undefined' ? window : this);
