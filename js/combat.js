/* =====================================================================
   ORION EMPIRES — combat.js
   Modulo M09 · Fase A: COMBATTIMENTO (GDD §12.5/§12.6, §19).

   Apre M09 con il MOTORE di risoluzione delle battaglie (decisione #49).
   Filosofia "declino a spirale con leve di recovery" (scelta utente):
     - le perdite sono REALI e permanenti (navi distrutte = perse §12.5,
       difese abbattute, strutture danneggiate, risorse saccheggiate);
     - una CATENA di sconfitte alimenta il morale d'impero (→ moltiplicatori
       negativi) e la pressione nemica (→ più razzie). Recovery sempre
       possibile con scelte oculate (Fase B: consolidare sulla capitale,
       abbandonare colonie indifendibili). Mai un wipe a freddo: il declino
       è graduale, annunciato, reversibile (spirito di #22).

   Questo modulo è PURO e DETERMINISTICO:
     - nessun Math.random: l'RNG deriva da `seed:combat:<battleId>`;
     - `resolve()` non muta lo stato di gioco — ritorna un REPORT;
     - l'applicazione degli esiti (perdite navi, danno strutture, ecc.)
       è fatta dai chiamanti (time.js) tramite gli helper `applyOutcome*`.

   Confini Fase A (decisione #49):
     - combattimento giocatore-iniziato (flotta → covo pirata / sistema AI
       ostile) + razzie pirata contro le colonie (difese + flotta in porto);
     - veteranità navi (Verde→Veterana→Elite→Leggendaria, §12.3);
     - report testuale (§12.5);
     - scaffold morale-impero / pressione.
   Rinviato a Fase B: incursioni AI strategiche con escalation, interrupt
   di move-route all'avvistamento, verbi morali ALIGNMENT_IMPACT,
   conquista/rasa colonie, game-over §19 pieno.

   Lessico SW-flavor (decisione #34): "squadrone", "bombardamento orbitale",
   "scialuppa di salvataggio", "covo pirata" — niente marchi specifici.
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  const CFG = {
    MAX_ROUNDS: 14,             // safety: una battaglia non gira all'infinito
    VET_FP_PER_TIER: 0.05,      // +5% potenza di fuoco per grado veterano (§12.3)
    FP_VARIANCE: 0.15,          // ±15% "fortuna" del round (deterministica dal seed)
    ROUND_EVERY_I: 5,           // assedi: 1 round di scambio ogni N Impulsi

    /* Soglie di ritirata per formazione (§12.5). Frazione di hp residua
       sotto cui una flotta MOBILE si sgancia. Le difese planetarie sono
       immobili → non si ritirano mai (combattono fino all'ultimo modulo). */
    RETREAT: { aggressive: 0.0, balanced: 0.30, defensive: 0.50 },

    /* Difese planetarie: ogni modulo di "Batteria di difesa" sintetizza un
       combattente con questi valori base (scalati da moduleSum). */
    DEF_BATTERY_HP: 60,
    DEF_BATTERY_FP: 8,
    DEF_SHIELD_HP: 90,          // lo Scudo planetario (tech-gated) aggiunge hp puri

    /* Pirati: una razzia da un covo di livello L schiera ~ (2 + L) predoni. */
    PIRATE_RAIDERS_BASE: 2,
    PIRATE_RAIDER_HP: 26,
    PIRATE_RAIDER_FP: 6,

    /* Forza AI materializzata (decisione #47): ogni "unità" del descrittore
       diventa un combattente di questa stazza (coarse, nebbia di guerra). */
    AI_UNIT_HP: 70,
    AI_UNIT_FP: 14,

    /* Veteranità navi (§12.3) — soglie xp → grado. */
    VET_TIERS: [
      { min: 0, id: 'verde',       label: 'Verde' },
      { min: 1, id: 'veterana',    label: 'Veterana' },
      { min: 3, id: 'elite',       label: 'Elite' },
      { min: 5, id: 'leggendaria', label: 'Leggendaria' }
    ]
  };

  /* Nomi propri per le navi LEGGENDARIE (§12.3: "nome generato
     proceduralmente"). Tono evocativo, niente marchi (#34). */
  const SHIP_NAMES = [
    'Sentinella', 'Aurora', 'Falce', 'Vindice', 'Bastione', 'Spettro',
    'Eco del Vuoto', 'Lama Stellare', 'Vigilia', 'Tempesta', 'Araldo',
    'Custode', 'Ira', 'Memoria', 'Pellegrina', 'Sentenza', 'Alba Nera',
    'Vespro', 'Reliquia', 'Zenit'
  ];

  /* ------------------------------------------------------------------
     Veteranità
     ------------------------------------------------------------------ */
  function veterancy(xp) {
    xp = xp | 0;
    let t = CFG.VET_TIERS[0];
    for (let i = 0; i < CFG.VET_TIERS.length; i++) {
      if (xp >= CFG.VET_TIERS[i].min) t = CFG.VET_TIERS[i];
    }
    return t;
  }
  function veterancyTierIndex(xp) {
    xp = xp | 0;
    let idx = 0;
    for (let i = 0; i < CFG.VET_TIERS.length; i++) {
      if (xp >= CFG.VET_TIERS[i].min) idx = i;
    }
    return idx;
  }
  function veterancyLabel(xp) { return veterancy(xp).label; }
  function vetFpMul(xp) { return 1 + CFG.VET_FP_PER_TIER * veterancyTierIndex(xp); }

  /* Potenza di fuoco di un combattente (fp base × bonus veteranità ×
     eventuale bonus Comandante Tattico passato come `cmdMul`). */
  function combatantFp(c) {
    const base = c.fp || 0;
    return base * vetFpMul(c.xp || 0) * (c.cmdMul || 1);
  }

  /* ------------------------------------------------------------------
     Costruzione delle FORZE (descrittori puri di combattimento).
     Una force = { side, name, color, immobile, combatants: [...] }.
     Ogni combatant = { id, kind, label, hp, maxHp, fp, xp, src }.
       src.type = 'ship'    → ref a fleet.ships[i] (per applicare l'esito)
       src.type = 'defense' → ref struttura difensiva (structId)
       src.type = 'pirate' | 'ai' → forza ostile (nessun ref persistente)
     ------------------------------------------------------------------ */

  /* Forza da una flotta del giocatore. Applica il bonus Comandante Tattico
     se la flotta ha un comandante assegnato con specializzazione 'tattico'. */
  function forceFromFleet(game, fleet, side) {
    const F = ORION.fleet;
    /* Figura di flotta (M14 Fase A, decisione #75): Comandante = +fuoco,
       Ingegnere = +scafo (durabilità), Stratega = imboscata (first-strike,
       applicata in resolve()). Sostituisce il vecchio check 'tattico' #43. */
    const cb = (ORION.commander && ORION.commander.combatBonus)
      ? ORION.commander.combatBonus(fleet) : { fpMul: 1, hpMul: 1, firstStrike: 0 };
    /* M15 — bonus di nave ammiraglia (GDD §12.1): +fuoco e +scafo a TUTTA
       la flotta, indipendente dalle figure. Si combina coi bonus comandante. */
    const flag = (F && F.flagshipBonus) ? F.flagshipBonus(fleet) : { fpMul: 1, hpMul: 1 };
    const cmdMul = cb.fpMul * flag.fpMul;
    /* M13 Fase B (decisione #57): tech armi/scudi = +X% potenza di fuoco e
       corazza alle navi DEL GIOCATORE (le flotte sono sue; le AI usano
       forceFromMaterialized → non toccate). Modificatori passivi. L'hpMul è
       un buffer di combattimento: il writeback (applyOutcomeToFleet) lo clampa
       al maxHp naturale così non resta inflazionato fra una battaglia e l'altra. */
    const RM = (ORION.research && ORION.research.mods) ? ORION.research.mods(game) : null;
    const fpMul = RM ? RM.fpMul : 1;
    const hpMul = (RM ? RM.hpMul : 1) * cb.hpMul * flag.hpMul;   // tech × Ingegnere × ammiraglia
    const combatants = [];
    const ships = (fleet && fleet.ships) || [];
    for (let i = 0; i < ships.length; i++) {
      const s = ships[i];
      const cls = (F && F.getClass(s.kind)) || { name: s.kind, fp: 0, hp: 1 };
      combatants.push({
        id: s.id,
        kind: s.kind,
        label: s.name ? (cls.name + ' «' + s.name + '»') : cls.name,
        hp: (s.hp != null ? s.hp : cls.hp) * hpMul,
        maxHp: cls.hp * hpMul,
        fp: (cls.fp || 0) * fpMul,
        xp: s.xp || 0,
        cmdMul: cmdMul,
        src: { type: 'ship', ref: s, fleet: fleet }
      });
    }
    return {
      side: side || 'A',
      name: fleet ? fleet.name : 'Flotta',
      color: '#5fa8ff',
      immobile: false,
      formation: (fleet && fleet.formation) || 'balanced',
      firstStrike: cb.firstStrike || 0,
      combatants: combatants
    };
  }

  /* Forza difensiva di una colonia: sintetizza un combattente per ogni
     struttura difensiva costruita (Batteria di difesa, Scudo planetario).
     Tagga `src` con lo structId così l'esito riduce l'hp della struttura. */
  function forceFromDefenses(game, colony, colonyKey, side) {
    const S = ORION.structures;
    const combatants = [];
    const structs = (colony && colony.structures) || {};
    Object.keys(structs).forEach(function (id) {
      const def = S && S.get(id);
      if (!def || !def.defense) return;
      const lvl = structs[id].level || 1;
      const msum = (S && S.moduleSum(lvl)) || lvl;
      const hpFull = (def.defenseHp || 0) * msum;
      // hp corrente proporzionale all'hp della struttura (0..100) se danneggiata
      const structHp = (structs[id].hp != null) ? structs[id].hp : 100;
      const hp = Math.max(1, Math.round(hpFull * structHp / 100));
      combatants.push({
        id: 'def-' + id,
        kind: id,
        label: def.name,
        hp: hp,
        maxHp: hpFull,
        fp: (def.defenseFp || 0) * msum,
        xp: 0,
        src: { type: 'defense', structId: id }
      });
    });
    return {
      side: side || 'B',
      name: (colony && colony.name) || 'Colonia',
      color: '#3fcaa0',
      immobile: true,
      formation: 'defensive',
      combatants: combatants
    };
  }

  /* Forza pirata da un covo (§17.5): N predoni in base al livello. */
  function forceFromPirateNest(nest) {
    const level = (nest && nest.level) || 1;
    const isBoss = !!(nest && nest.boss);
    const bossTier = isBoss ? Math.max(1, nest.bossTier || 1) : 0;
    /* M17 Fase B (#83): un covo-boss nominato è più duro — scorta più
       numerosa + un "Signore dei Predoni" d'élite (corazza/fuoco maggiori).
       Niente sortite: si affronta col motore M09 quando il giocatore vuole. */
    const n = CFG.PIRATE_RAIDERS_BASE + level + (isBoss ? bossTier * 2 : 0);
    const combatants = [];
    for (let i = 0; i < n; i++) {
      combatants.push({
        id: 'pir-' + i,
        kind: 'predone',
        label: 'Predone',
        hp: CFG.PIRATE_RAIDER_HP,
        maxHp: CFG.PIRATE_RAIDER_HP,
        fp: CFG.PIRATE_RAIDER_FP,
        xp: 0,
        src: { type: 'pirate' }
      });
    }
    if (isBoss) {
      const hp = CFG.PIRATE_RAIDER_HP * (3 + bossTier);
      combatants.push({
        id: 'pir-capo', kind: 'predone-capo',
        label: 'Signore dei Predoni',
        hp: hp, maxHp: hp, fp: CFG.PIRATE_RAIDER_FP * (2 + bossTier),
        xp: 0, src: { type: 'pirate' }
      });
    }
    return {
      side: 'B', name: isBoss && nest.name ? ('Predoni di ' + nest.name) : 'Predoni',
      color: '#b0763a',
      immobile: false, formation: 'aggressive', combatants: combatants
    };
  }

  /* Forza AI da un descrittore di materializzazione (decisione #47). */
  /* M16 (#81): forza difensiva di una STAZIONE spaziale. Una piattaforma
     immobile con corazza+fuoco difensivo (scala coi livelli/moduli). Il
     writeback dell'hp residuo è gestito dal chiamante (time.js) via il
     campo src.station. */
  function forceFromStation(game, station, side) {
    const ST = ORION.station;
    const stats = (ST && ST.defenseStats) ? ST.defenseStats(station) : { hp: station.hp || 1, fp: 0 };
    const combatants = [];
    if (stats.fp > 0 || stats.hp > 0) {
      combatants.push({
        id: 'station-' + station.id,
        kind: 'stazione',
        label: station.name || 'Stazione',
        hp: Math.max(1, Math.round(stats.hp)),
        maxHp: stats.maxHp || stats.hp,
        fp: stats.fp,
        xp: 0,
        src: { type: 'station', station: station }
      });
    }
    return {
      side: side || 'B',
      name: station.name || 'Stazione',
      color: '#7fc4ff',
      immobile: true,
      formation: 'defensive',
      combatants: combatants
    };
  }

  function forceFromMaterialized(descriptor, side) {
    const combatants = [];
    const units = Math.max(1, (descriptor && descriptor.units) || 1);
    /* M10 Fase B-2: il tech-tier della civ rende ogni unità più tosta
       (fuoco/corazza ≤ +25%). I moltiplicatori arrivano da
       ORION.ai.materialize; default 1 per pirati/fallback. */
    const fpMul = (descriptor && descriptor.fpMul) || 1;
    const hpMul = (descriptor && descriptor.hpMul) || 1;
    const uHp = Math.round(CFG.AI_UNIT_HP * hpMul);
    const uFp = Math.round(CFG.AI_UNIT_FP * fpMul);
    for (let i = 0; i < units; i++) {
      combatants.push({
        id: 'ai-' + i,
        kind: 'nave-aliena',
        label: 'Squadrone alieno',
        hp: uHp,
        maxHp: uHp,
        fp: uFp,
        xp: 0,
        src: { type: 'ai', civId: descriptor && descriptor.civId }
      });
    }
    return {
      side: side || 'B',
      name: (descriptor && descriptor.civName) || 'Forza aliena',
      color: (descriptor && descriptor.color) || '#e0556e',
      immobile: false, formation: 'balanced', combatants: combatants
    };
  }

  /* ------------------------------------------------------------------
     RISOLUZIONE — deterministica, a round simultanei.
     Entrambi i lati sparano in base allo stato di INIZIO round (scambio
     simultaneo, equo), poi si rimuovono i distrutti. Fuoco concentrato:
     il danno aggregato colpisce prima i bersagli più deboli (uccidere
     in fretta), con leggera varianza dall'RNG.
     ------------------------------------------------------------------ */
  function totalHp(force) {
    let h = 0;
    for (let i = 0; i < force.combatants.length; i++) h += Math.max(0, force.combatants[i].hp);
    return h;
  }
  function totalFp(force) {
    let f = 0;
    for (let i = 0; i < force.combatants.length; i++) f += combatantFp(force.combatants[i]);
    return f;
  }
  function retreatThreshold(formation) {
    const t = CFG.RETREAT[formation];
    return (t == null) ? CFG.RETREAT.balanced : t;
  }

  /* Distribuisce `dmg` totale su `force` colpendo prima i bersagli più
     deboli (ordine stabile + jitter rng). Ritorna i combattenti distrutti. */
  function applyDamage(force, dmg, rng) {
    if (dmg <= 0) return [];
    const order = force.combatants.slice().sort(function (a, b) {
      return a.hp - b.hp || (rng.float() - 0.5);
    });
    let remaining = dmg;
    const destroyed = [];
    for (let i = 0; i < order.length && remaining > 0; i++) {
      const c = order[i];
      if (c.hp <= 0) continue;
      const hit = Math.min(c.hp, remaining);
      c.hp -= hit;
      remaining -= hit;
      if (c.hp <= 0) destroyed.push(c);
    }
    return destroyed;
  }
  function purgeDestroyed(force) {
    force.combatants = force.combatants.filter(function (c) { return c.hp > 0; });
  }

  /* resolveRound — UN round di scambio simultaneo fra A e B. Mutua l'hp dei
     combattenti e rimuove i distrutti. Ritorna { fpA, fpB, destroyedA,
     destroyedB }. Condiviso da `resolve` (lampo: lo cicla in memoria) e
     dalle battaglie d'assedio (multi-Impulso: lo chiama 1 volta per round).
     RNG seedato per round → replay-safe anche tra save/load.

     Fattori aleatori (deterministici dal seed, decisione utente):
       - "fortuna" del round: la fp di ciascun lato oscilla di ±FP_VARIANCE;
       - varianza di mira: applyDamage colpisce prima i deboli con jitter rng.
     Così il più forte di solito vince ma gli upset esistono (§13.1). */
  function resolveRound(rng, A, B) {
    const luckA = 1 + (rng.float() - 0.5) * 2 * CFG.FP_VARIANCE;
    const luckB = 1 + (rng.float() - 0.5) * 2 * CFG.FP_VARIANCE;
    const fpA = totalFp(A) * luckA;
    const fpB = totalFp(B) * luckB;
    const destroyedB = applyDamage(B, fpA, rng);
    const destroyedA = applyDamage(A, fpB, rng);
    purgeDestroyed(A); purgeDestroyed(B);
    return {
      fpA: Math.round(fpA), fpB: Math.round(fpB),
      destroyedA: destroyedA, destroyedB: destroyedB
    };
  }

  /* Valuta lo stato di ritirata/fine dopo un round. Le forze immobili
     (difese planetarie) non si ritirano mai. */
  function checkRetreat(force, startHp) {
    if (force.immobile || force.combatants.length === 0 || startHp <= 0) return false;
    return totalHp(force) / startHp < retreatThreshold(force.formation);
  }

  /* winnerOf — esito a fronte di forze residue + flag di ritirata. */
  function winnerOf(A, B, retreatedA, retreatedB) {
    if (A.combatants.length === 0 && B.combatants.length === 0) return 'draw';
    if (A.combatants.length === 0) return 'B';
    if (B.combatants.length === 0) return 'A';
    if (retreatedA && !retreatedB) return 'B';
    if (retreatedB && !retreatedA) return 'A';
    return (totalHp(A) >= totalHp(B)) ? 'A' : 'B';
  }

  /* resolve — risoluzione LAMPO (1 Impulso): cicla resolveRound in memoria
     fino all'esito. Per le scaramucce interstellari (decisione #49: piccoli
     scontri / incontri nello spazio, non assedi a colonie). `battleId` deve
     essere stabile (timeImpulsi + systemId + id origine) per replay-safety. */
  function resolve(game, battleId, A, B) {
    const seed = (game && game.seed || '') + ':combat:' + battleId;
    const startA = { ships: A.combatants.length, hp: totalHp(A) };
    const startB = { ships: B.combatants.length, hp: totalHp(B) };
    const log = [];
    let round = 0;
    let retreatedA = false, retreatedB = false;

    /* Imboscata (Stratega, M14 §12.4): bordata d'apertura prima del primo
       round simultaneo. Una flotta con Stratega assegnato infligge una
       frazione del proprio fuoco "a freddo". Deterministico (rng seedato).
       In genere solo A (flotta del giocatore) ha firstStrike > 0. */
    const fsA = A.firstStrike || 0, fsB = B.firstStrike || 0;
    if (fsA > 0 || fsB > 0) {
      const orng = ORION.rng.makeRng(seed + ':opening');
      if (fsA > 0) applyDamage(B, totalFp(A) * fsA, orng);
      if (fsB > 0) applyDamage(A, totalFp(B) * fsB, orng);
      purgeDestroyed(A); purgeDestroyed(B);
    }

    while (round < CFG.MAX_ROUNDS && A.combatants.length > 0 && B.combatants.length > 0) {
      round++;
      const rng = ORION.rng.makeRng(seed + ':' + round);
      const r = resolveRound(rng, A, B);
      log.push({
        round: round, fpA: r.fpA, fpB: r.fpB,
        lostA: r.destroyedA.length, lostB: r.destroyedB.length,
        hpA: Math.round(totalHp(A)), hpB: Math.round(totalHp(B))
      });
      if (checkRetreat(A, startA.hp)) { retreatedA = true; break; }
      if (checkRetreat(B, startB.hp)) { retreatedB = true; break; }
    }

    return {
      battleId: battleId,
      rounds: round,
      winner: winnerOf(A, B, retreatedA, retreatedB),
      retreatedA: retreatedA, retreatedB: retreatedB,
      sideA: sideSummary(A, startA),
      sideB: sideSummary(B, startB),
      log: log,
      _A: A, _B: B
    };
  }

  function sideSummary(force, start) {
    return {
      name: force.name,
      color: force.color,
      immobile: !!force.immobile,
      before: start,
      after: { ships: force.combatants.length, hp: Math.round(totalHp(force)) },
      lost: start.ships - force.combatants.length
    };
  }

  /* ------------------------------------------------------------------
     APPLICAZIONE ESITI sullo stato di gioco (chiamati da time.js).
     Le perdite sono PERMANENTI (#49). I sopravvissuti delle flotte del
     giocatore guadagnano +1 xp (battaglia sopravvissuta, §12.3) e possono
     diventare LEGGENDARIE (nome proprio).
     ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------
     Equipaggio caduto con la nave (decisione utente 2026-06-26).
     Quando una nave è DISTRUTTA in combattimento muore il suo complemento
     d'equipaggio (somma `class.crew` delle navi perse), estratto con
     PREPONDERANZA verso i meno esperti (peso ∝ 1/(xp+1)): le reclute
     affondano più spesso, i veterani sono favoriti ma NON immuni.
     Deterministico (#5): rng seedato per-flotta+impulso, zero Math.random.
     NB: è il caso opposto alla rottamazione al porto (avaria/usura in
     viaggio, esploratore logoro che rientra) dove lo scafo si perde ma
     l'equipaggio si salva (#22) — qui la nave esplode coi suoi a bordo.
     Gli eventuali equipaggi in ECCEDENZA (oltre il complemento delle navi
     perse) sopravvivono. Ritorna il numero di equipaggi perduti. */
  function cullFleetCrew(game, fleet, crewToKill, seedScope) {
    if (!fleet || !Array.isArray(fleet.crew) || !(crewToKill > 0)) return 0;
    if (!ORION.rng || !ORION.rng.makeRng) return 0;
    const rng = ORION.rng.makeRng((game && game.seed || '') + ':crewloss:' + seedScope);
    let kill = Math.min(crewToKill, fleet.crew.length);
    let killed = 0;
    while (kill > 0 && fleet.crew.length > 0) {
      let total = 0;
      const weights = fleet.crew.map(function (c) {
        const w = 1 / (((c && c.xp) || 0) + 1);
        total += w;
        return w;
      });
      let pick = rng.float() * total;
      let idx = 0;
      /* L'ultimo indice è il fallback per il residuo floating-point. */
      for (; idx < weights.length - 1; idx++) {
        pick -= weights[idx];
        if (pick <= 0) break;
      }
      fleet.crew.splice(idx, 1);
      killed++;
      kill--;
    }
    return killed;
  }

  /* Somma del fabbisogno d'equipaggio (`class.crew`) di un insieme di navi.
     Quantifica quanti equipaggi muoiono con le navi distrutte. */
  function crewCostOfShips(ships) {
    const F = ORION.fleet;
    let n = 0;
    for (let i = 0; i < ships.length; i++) {
      const cls = F && F.getClass && F.getClass(ships[i].kind);
      n += (cls && cls.crew) || 1;
    }
    return n;
  }

  /* Applica l'esito a una flotta del giocatore: rimuove le navi distrutte,
     scrive l'hp residuo sui sopravvissuti, +1 xp, naming leggendario.
     L'equipaggio delle navi distrutte cade con lo scafo (cullFleetCrew).
     Ritorna { lost, survivors, promoted:[{name,kind}], crewLost }. */
  function applyOutcomeToFleet(game, fleet, force) {
    const survivingIds = {};
    for (let i = 0; i < force.combatants.length; i++) {
      survivingIds[force.combatants[i].id] = force.combatants[i];
    }
    const kept = [];
    const lostShips = [];
    let lost = 0;
    const promoted = [];
    for (let i = 0; i < fleet.ships.length; i++) {
      const s = fleet.ships[i];
      const surv = survivingIds[s.id];
      if (!surv) { lost++; lostShips.push(s); continue; }
      /* Clamp al maxHp naturale: l'hpMul da tech (Fase B) è un buffer di
         combattimento, non hp permanente → non si accumula fra battaglie. */
      const F = ORION.fleet;
      const naturalMax = (F && F.getClass(s.kind) && F.getClass(s.kind).hp) || surv.hp;
      s.hp = Math.max(1, Math.min(naturalMax, Math.round(surv.hp)));
      const beforeTier = veterancyTierIndex(s.xp || 0);
      s.xp = (s.xp || 0) + 1;
      const afterTier = veterancyTierIndex(s.xp);
      // promozione a Leggendaria → nome proprio (deterministico)
      if (afterTier >= 3 && !s.name) {
        const rng = ORION.rng.makeRng((game.seed || '') + ':shipname:' + s.id);
        s.name = rng.pick(SHIP_NAMES);
        promoted.push({ name: s.name, kind: s.kind });
      } else if (afterTier > beforeTier) {
        promoted.push({ name: null, kind: s.kind, tier: afterTier });
      }
      kept.push(s);
    }
    fleet.ships = kept;
    const crewLost = cullFleetCrew(game, fleet, crewCostOfShips(lostShips),
      (fleet.id || 'f') + ':' + (game && game.timeImpulsi || 0));
    return { lost: lost, survivors: kept.length, promoted: promoted, crewLost: crewLost };
  }

  /* Applica l'esito difensivo a una colonia: traduce l'hp residuo dei
     combattenti-difesa in hp delle strutture difensive (danno riparabile,
     §10.2). Le strutture non vengono MAI rimosse dal combattimento (al più
     ridotte a hp basso) — coerente con #49: difese abbattute ma ricostruibili. */
  function applyOutcomeToDefenses(colony, force, startForce) {
    // mappa structId → hp residuo aggregato / hp pieno
    const byStruct = {};
    for (let i = 0; i < startForce.combatants.length; i++) {
      const c = startForce.combatants[i];
      if (!c.src || c.src.type !== 'defense') continue;
      byStruct[c.src.structId] = byStruct[c.src.structId] || { full: 0, left: 0 };
      byStruct[c.src.structId].full += c.maxHp;
    }
    for (let i = 0; i < force.combatants.length; i++) {
      const c = force.combatants[i];
      if (!c.src || c.src.type !== 'defense') continue;
      if (byStruct[c.src.structId]) byStruct[c.src.structId].left += Math.max(0, c.hp);
    }
    Object.keys(byStruct).forEach(function (id) {
      const st = colony.structures[id];
      if (!st) return;
      const frac = byStruct[id].full > 0 ? byStruct[id].left / byStruct[id].full : 1;
      st.hp = Math.max(5, Math.round(100 * frac));   // mai a 0: la batteria resta, danneggiata
    });
  }

  /* ------------------------------------------------------------------
     ASSEDI (decisione #49, modello C/A): la battaglia a una colonia dura
     più Impulsi. Ogni round il difensore viene RICOSTRUITO dallo stato vivo
     (difese + flotte presenti) → la ricostruzione realizza i rinforzi/ritirate
     fra un round e l'altro. Dopo il round, scriviamo gli esiti sullo stato
     vivo: navi distrutte rimosse dalla flotta (permanente), hp residuo sulle
     navi/strutture sopravvissute. L'attaccante (pirati) vive INLINE nel
     battle entity (combattenti plain, serializzabili) → niente ref persistenti.
     ------------------------------------------------------------------ */

  /* Scrive l'esito di un round sul difensore vivo. `survivors` =
     force.combatants residui; `destroyed` = combattenti abbattuti nel round.
     Le navi distrutte sono rimosse dalla loro flotta (perdita permanente);
     le difese non si rimuovono mai (al più hp al pavimento). */
  function applyDefenderWriteback(game, colony, survivors, destroyed) {
    let shipsLost = 0;
    /* Navi distrutte raggruppate per flotta d'origine: la rimozione è
       immediata, la perdita d'equipaggio si calcola dopo (per-flotta). */
    const lostByFleet = [];
    function bucketFor(fleet) {
      for (let k = 0; k < lostByFleet.length; k++) {
        if (lostByFleet[k].fleet === fleet) return lostByFleet[k];
      }
      const b = { fleet: fleet, ships: [] };
      lostByFleet.push(b);
      return b;
    }
    // navi distrutte → rimozione dalla flotta di origine
    for (let i = 0; i < destroyed.length; i++) {
      const c = destroyed[i];
      if (c.src && c.src.type === 'ship' && c.src.fleet) {
        const fl = c.src.fleet;
        bucketFor(fl).ships.push(c.src.ref);
        fl.ships = fl.ships.filter(function (s) { return s.id !== c.src.ref.id; });
        shipsLost++;
      } else if (c.src && c.src.type === 'defense') {
        const st = colony.structures[c.src.structId];
        if (st) st.hp = 5;   // batteria abbattuta ma ricostruibile (#49)
      }
    }
    // sopravvissuti → hp residuo scritto sulla sorgente
    for (let i = 0; i < survivors.length; i++) {
      const c = survivors[i];
      if (c.src && c.src.type === 'ship') {
        c.src.ref.hp = Math.max(1, Math.round(c.hp));
      } else if (c.src && c.src.type === 'defense') {
        const st = colony.structures[c.src.structId];
        if (st && c.maxHp > 0) st.hp = Math.max(5, Math.round(100 * c.hp / c.maxHp));
      }
    }
    // equipaggio caduto con le navi distrutte (per-flotta, deterministico)
    let crewLost = 0;
    for (let k = 0; k < lostByFleet.length; k++) {
      const b = lostByFleet[k];
      crewLost += cullFleetCrew(game, b.fleet, crewCostOfShips(b.ships),
        (b.fleet.id || 'f') + ':' + (game && game.timeImpulsi || 0));
    }
    return { shipsLost: shipsLost, crewLost: crewLost };
  }

  /* Veteranità a fine battaglia: +1 xp alle navi sopravvissute di una
     flotta, con naming leggendario (§12.3). Ritorna le promozioni. */
  function grantVeterancy(game, fleet) {
    const promoted = [];
    if (!fleet || !Array.isArray(fleet.ships)) return promoted;
    for (let i = 0; i < fleet.ships.length; i++) {
      const s = fleet.ships[i];
      const beforeTier = veterancyTierIndex(s.xp || 0);
      s.xp = (s.xp || 0) + 1;
      const afterTier = veterancyTierIndex(s.xp);
      if (afterTier >= 3 && !s.name) {
        const rng = ORION.rng.makeRng((game.seed || '') + ':shipname:' + s.id);
        s.name = rng.pick(SHIP_NAMES);
        promoted.push({ name: s.name, kind: s.kind });
      } else if (afterTier > beforeTier) {
        promoted.push({ name: null, kind: s.kind, tier: afterTier });
      }
    }
    return promoted;
  }

  /* Helpers UI/test esposti. */
  function isDefenseStruct(def) { return !!(def && def.defense); }

  /* M09 Fase B (decisione #49): presenza ostile in un sistema (covo pirata
     o civiltà AI ostile), escludendo i sistemi-colonia del giocatore. Usata
     dall'interrupt di rotta (imboscata) e dai trigger di scaramuccia. */
  function hostilePresenceAt(game, sysId) {
    if (!game) return null;
    // pirati
    const nests = game.piracy && game.piracy.nests;
    if (nests) {
      for (let i = 0; i < nests.length; i++) {
        if (nests[i].sysId === sysId) return { kind: 'pirate', nest: nests[i] };
      }
    }
    // civiltà AI ostile che possiede il sistema
    if (ORION.ai && ORION.ai.civForSystem) {
      const civ = ORION.ai.civForSystem(game, sysId);
      if (civ && civ.alive) {
        /* M11 (#51): pace/tregua/alleanza = non-ostile (niente imboscate o
           scaramucce contro chi non è in guerra con te). */
        const rel = (ORION.diplomacy && ORION.diplomacy.effectiveRelation)
          ? ORION.diplomacy.effectiveRelation(game, civ) : null;
        if (rel === 'peace' || rel === 'truce' || rel === 'alliance') return null;
        if (rel === 'war' || civ.disposition <= -40) return { kind: 'ai', civ: civ };
      }
    }
    return null;
  }

  /* Peso fuoco→potenza, allineato a garrison.CFG.FP_WEIGHT (#93): la
     "potenza" sintetica P = corazza + fuoco×8 dà un singolo numero per il
     colpo d'occhio coerente con la soglia di presidio. */
  const POWER_FP_WEIGHT = 8;
  function powerOfForce(force) {
    if (!force) return 0;
    return Math.round(totalHp(force) + totalFp(force) * POWER_FP_WEIGHT);
  }

  /* Riepilogo difensivo di una colonia (richiesta utente: scheda Colonia →
     colpo d'occhio su quanto regge la colonia). Aggrega:
       - le STRUTTURE difensive (Batteria, Scudo) via forceFromDefenses;
       - le FLOTTE del giocatore presenti nel sistema (in orbita/in porto,
         non in transito) via forceFromFleet — gli stessi difensori che il
         motore d'assedio schiera (time.js processIncursions).
     Espone corazza (hp), fuoco (fp) e potenza (P) per ciascun gruppo + i
     totali, e — se ci sono covi pirata NOTI — la razzia peggiore conosciuta
     come riferimento di minaccia. Puro display: nessuna mutazione. */
  function colonyDefenseSummary(game, colony, colonyKey) {
    const empty = {
      struct: { count: 0, hp: 0, fp: 0, power: 0 },
      fleets: { count: 0, ships: 0, hp: 0, fp: 0, power: 0 },
      totalHp: 0, totalFp: 0, totalPower: 0, threat: null
    };
    if (!game || !colony) return empty;

    /* Strutture difensive. */
    const defForce = forceFromDefenses(game, colony, colonyKey, 'B');
    const struct = {
      count: defForce.combatants.length,
      hp: Math.round(totalHp(defForce)),
      fp: Math.round(totalFp(defForce)),
      power: powerOfForce(defForce)
    };

    /* Flotte che DIFENDEREBBERO la colonia: stesso criterio del motore
       d'assedio (time.js processIncursions) — presenti nel sistema (non in
       transito) E al CORPO della colonia (in porto o in orbita a quel corpo).
       Le flotte che lavorano su un altro corpo del sistema restano al loro
       posto e non contano. Se fleetCurrentBodyKey non è disponibile (test/
       chiamanti minimi), si ripiega sul livello-sistema. */
    const sysId = colony.systemId;
    const F = ORION.fleet;
    const colonyBodyKey = (function () {
      const parts = String(colonyKey || '').split(':');
      return parts.length === 2 ? parts[1] : null;
    })();
    const fleets = (game.fleets || []);
    let fCount = 0, fShips = 0, fHp = 0, fFp = 0, fPower = 0;
    for (let i = 0; i < fleets.length; i++) {
      const f = fleets[i];
      if (!f || !f.location) continue;
      if (f.location.systemId !== sysId) continue;
      if (f.location.status === 'in-transit') continue;
      if (colonyBodyKey != null && F && F.fleetCurrentBodyKey) {
        const bk = F.fleetCurrentBodyKey(game, f);
        if (bk == null || bk !== colonyBodyKey) continue;
      }
      const ff = forceFromFleet(game, f, 'B');
      if (!ff.combatants.length) continue;
      fCount++;
      fShips += ff.combatants.length;
      fHp += totalHp(ff);
      fFp += totalFp(ff);
      fPower += powerOfForce(ff);
    }
    const fleetsAgg = {
      count: fCount, ships: fShips,
      hp: Math.round(fHp), fp: Math.round(fFp), power: Math.round(fPower)
    };

    /* Minaccia di riferimento: la razzia più dura tra i covi pirata NOTI
       (intel #49) + l'eventuale covo nel sistema stesso. Worst-case che il
       giocatore sa di poter affrontare. */
    let threat = null;
    const seen = {};
    const candidates = [];
    const local = (game.piracy && game.piracy.nests)
      ? game.piracy.nests.filter(function (n) { return n.sysId === sysId; })[0] : null;
    if (local) { candidates.push(local); seen[local.sysId] = true; }
    const known = (ORION.ai && ORION.ai.knownNests) ? ORION.ai.knownNests(game) : [];
    for (let i = 0; i < known.length; i++) {
      if (seen[known[i].sysId]) continue;
      seen[known[i].sysId] = true;
      candidates.push(known[i]);
    }
    for (let i = 0; i < candidates.length; i++) {
      const n = candidates[i];
      const rf = forceFromPirateNest({ level: n.level || 1, boss: n.boss, bossTier: n.bossTier, name: n.name });
      const p = powerOfForce(rf);
      if (!threat || p > threat.power) {
        threat = {
          power: p, level: n.level || 1,
          name: n.name || null,
          boss: !!n.boss,
          local: !!(local && n.sysId === sysId)
        };
      }
    }

    return {
      struct: struct,
      fleets: fleetsAgg,
      totalHp: struct.hp + fleetsAgg.hp,
      totalFp: struct.fp + fleetsAgg.fp,
      totalPower: struct.power + fleetsAgg.power,
      threat: threat
    };
  }

  ORION.combat = {
    CFG: CFG,
    SHIP_NAMES: SHIP_NAMES,
    veterancy: veterancy,
    veterancyLabel: veterancyLabel,
    veterancyTierIndex: veterancyTierIndex,
    vetFpMul: vetFpMul,
    combatantFp: combatantFp,
    forceFromFleet: forceFromFleet,
    forceFromDefenses: forceFromDefenses,
    forceFromPirateNest: forceFromPirateNest,
    forceFromStation: forceFromStation,
    forceFromMaterialized: forceFromMaterialized,
    totalHp: totalHp,
    totalFp: totalFp,
    resolveRound: resolveRound,
    checkRetreat: checkRetreat,
    winnerOf: winnerOf,
    retreatThreshold: retreatThreshold,
    sideSummary: sideSummary,
    resolve: resolve,
    applyOutcomeToFleet: applyOutcomeToFleet,
    applyOutcomeToDefenses: applyOutcomeToDefenses,
    applyDefenderWriteback: applyDefenderWriteback,
    grantVeterancy: grantVeterancy,
    isDefenseStruct: isDefenseStruct,
    hostilePresenceAt: hostilePresenceAt,
    powerOfForce: powerOfForce,
    colonyDefenseSummary: colonyDefenseSummary
  };
})(typeof window !== 'undefined' ? window : this);
