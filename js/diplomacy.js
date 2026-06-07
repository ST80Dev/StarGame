/* =====================================================================
   ORION EMPIRES — diplomacy.js  (M11 — Diplomazia, Fase A)

   Decisione #51. Trasforma la disposizione EMERGENTE di M10 in una
   relazione DIPLOMATICA formale e negoziabile.

   Modello (scelte utente):
     - STATO ESPLICITO `civ.relation` ∈ { war, truce, peace, alliance },
       persistito. La `disposition` (−100..100) lo CONDIZIONA (se la AI
       accetta una proposta) ma NON lo cambia da sola.
     - Negoziazione BASE in Fase A: solo il giocatore propone, la AI
       accetta/rifiuta in modo DETERMINISTICO (disposizione + reputazione
       + allineamento + pressione). Niente controfferta (è Fase B).
     - REPUTAZIONE §14 sistematizzata: `game.reputation` 0..100 persistito,
       leva concreta sulle soglie di accettazione.
     - Alleanza "leggera": non-aggressione (gate sulle incursioni AI) +
       bonus reputazione. Niente mappa condivisa / flotte combinate (M11).

   Vincoli: vanilla JS, no CDN/framework/WebGL. Determinismo (#5): ZERO
   Math.random qui dentro. Recovery-friendly (#22): nessuna azione causa
   fail-state; la pace REVOCA incursioni/assedi pendenti di quella civiltà.
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  const RELATIONS = ['war', 'truce', 'peace', 'alliance'];

  /* Stato semantico (UI_GUIDE §7) per ogni relazione. */
  const RELATION_STATE = {
    war: 'is-crit',       // rosso/bad
    truce: 'is-warn',     // oro
    peace: 'is-ok',       // verde/good
    alliance: 'is-active' // accento (alleanza = premium)
  };
  const RELATION_LABEL = {
    war: 'Guerra', truce: 'Tregua', peace: 'Pace', alliance: 'Alleanza'
  };

  const CFG = {
    REP_DEFAULT: 50,
    REP_MIN: 0, REP_MAX: 100,
    REP_DRIFT: 0.04,          // verso il target light/dark, per AI-tick
    DRIFT_EVERY_I: 8,         // cadenza (allineata ad AI_EVERY_I)
    /* Effetti dei verbi diplomatici sulla reputazione globale. */
    REP_ON_ALLIANCE: 6,
    REP_ON_BREAK_ALLIANCE: -10,
    REP_ON_PEACE: 3,
    REP_ON_WAR_INNOCENT: -8,  // guerra a civ buona/neutrale
    REP_ON_WAR_EVIL: 2,       // guerra a civ maligna (lieve plauso)
    /* Soglie di accettazione AI (deterministiche). */
    PEACE_DISP_MIN: -30,      // pace accettata se disposizione ≥ questo
    PEACE_REP_HELP: 60,       // ...oppure reputazione molto alta
    ALLY_DISP_MIN: 45,        // alleanza richiede disposizione alta
    ALLY_REP_MIN: 55,         // ...e buona reputazione (civ buone)
    /* Disposizione "pavimento" dopo un atto formale. */
    PEACE_DISP_FLOOR: 5,
    ALLY_DISP_FLOOR: 45,
    /* Cooldown anti-spam per coppia (giocatore↔civ), in Ι. */
    PROPOSAL_COOLDOWN: 40
  };

  /* ---------- Reputazione globale (§14) ---------- */
  function ensureReputation(game) {
    if (game && typeof game.reputation !== 'number') {
      /* Se esiste l'anteprima M10 partiamo da lì, altrimenti neutro. */
      const seed = (ORION.ai && ORION.ai.reputationPreview)
        ? ORION.ai.reputationPreview(game) : CFG.REP_DEFAULT;
      game.reputation = seed;
    }
    return game ? game.reputation : CFG.REP_DEFAULT;
  }
  function reputation(game) { return Math.round(ensureReputation(game)); }
  function adjustReputation(game, delta) {
    ensureReputation(game);
    game.reputation = Math.max(CFG.REP_MIN, Math.min(CFG.REP_MAX, game.reputation + delta));
    return game.reputation;
  }

  /* ---------- Relazione per-civiltà ---------- */
  function ensureRelation(civ) {
    if (civ && !civ.relation) civ.relation = 'peace';
    return civ ? civ.relation : 'peace';
  }
  /* Relazione EFFETTIVA: una tregua scaduta vale 'war'. */
  function effectiveRelation(game, civ) {
    if (!civ) return 'peace';
    const rel = ensureRelation(civ);
    if (rel === 'truce') {
      const now = (game && game.timeImpulsi) || 0;
      if ((civ.truceUntil || 0) <= now) return 'war';
    }
    return rel;
  }
  function relationLabel(rel) { return RELATION_LABEL[rel] || rel; }
  function relationStateClass(rel) { return RELATION_STATE[rel] || ''; }

  /* Bias che la relazione formale esercita sul TARGET di disposizione
     (consumato da ai.driftDisposition): alleati si fidano, nemici no. */
  function relationDispositionBias(civ) {
    const rel = (civ && civ.relation) || 'peace';
    if (rel === 'alliance') return 40;
    if (rel === 'war') return -15;
    if (rel === 'truce') return 5;
    return 0;
  }

  /* ---------- Azioni proponibili ---------- */
  /* Restituisce gli id azione disponibili per lo stato corrente.
     Solo il giocatore propone (Fase A). */
  function availableActions(game, civ) {
    const rel = effectiveRelation(game, civ);
    if (rel === 'war')      return ['sue-peace'];
    if (rel === 'truce')    return ['propose-peace', 'declare-war'];
    if (rel === 'alliance') return ['break-alliance'];
    return ['propose-alliance', 'declare-war']; // peace (default)
  }

  const ACTION_LABEL = {
    'sue-peace': 'Proponi pace',
    'propose-peace': 'Proponi pace',
    'propose-alliance': 'Proponi alleanza',
    'declare-war': 'Dichiara guerra',
    'break-alliance': 'Rompi alleanza'
  };
  function actionLabel(id) { return ACTION_LABEL[id] || id; }

  /* ---------- Valutazione deterministica della proposta ---------- */
  /* Ritorna { accept:bool, unilateral:bool, likelihood:'certa'|'probabile'
     |'incerta'|'improbabile', reason:str }. Niente RNG. */
  function evaluate(game, civ, actionId) {
    ensureReputation(game);
    const disp = (civ && civ.disposition) || 0;
    const rep = game.reputation;
    const align = civ && civ.alignment;
    const pressure = (game.warState && game.warState.pressure) || 0;

    if (actionId === 'declare-war' || actionId === 'break-alliance') {
      return { accept: true, unilateral: true, likelihood: 'certa',
        reason: 'Atto unilaterale: ha effetto immediato.' };
    }

    if (actionId === 'sue-peace' || actionId === 'propose-peace') {
      /* La AI accetta la pace se non troppo ostile, o se la tua reputazione
         è alta, o se è lei stessa sotto pressione (vuole tregua). */
      const ok = disp >= CFG.PEACE_DISP_MIN || rep >= CFG.PEACE_REP_HELP || pressure >= 0.6;
      return {
        accept: ok, unilateral: false,
        likelihood: ok ? (disp >= 0 ? 'probabile' : 'incerta') : 'improbabile',
        reason: ok ? 'La controparte è disposta a deporre le armi.'
                   : 'Troppo ostile per accettare la pace adesso.'
      };
    }

    if (actionId === 'propose-alliance') {
      let ok = disp >= CFG.ALLY_DISP_MIN;
      if (align === 'bene') ok = ok && rep >= CFG.ALLY_REP_MIN;      // i buoni vogliono onore
      else if (align === 'male') ok = ok && rep <= (100 - CFG.ALLY_REP_MIN); // i maligni diffidano dei santi
      // i neutrali bastano la disposizione
      return {
        accept: ok, unilateral: false,
        likelihood: ok ? 'probabile' : (disp >= CFG.ALLY_DISP_MIN - 15 ? 'incerta' : 'improbabile'),
        reason: ok ? 'I rapporti sono abbastanza saldi per un patto.'
                   : (disp < CFG.ALLY_DISP_MIN
                      ? 'Disposizione insufficiente per un\'alleanza.'
                      : 'La tua reputazione non li convince.')
      };
    }
    return { accept: false, unilateral: false, likelihood: 'improbabile', reason: 'Azione non disponibile.' };
  }

  /* Cooldown per evitare spam di proposte sulla stessa civiltà. */
  function onCooldown(game, civ) {
    const now = (game && game.timeImpulsi) || 0;
    return (civ && civ.lastProposalAt != null) &&
           (now - civ.lastProposalAt) < CFG.PROPOSAL_COOLDOWN;
  }

  /* ---------- Applicazione dell'azione ---------- */
  /* Esegue la transizione di stato + effetti su reputazione/disposizione e
     accoda gli eventi in `events`. Ritorna { ok, accepted, reason }. */
  function apply(game, civ, actionId, events) {
    if (!game || !civ) return { ok: false, reason: 'Civiltà non valida.' };
    events = events || [];
    ensureRelation(civ);
    ensureReputation(game);
    const verdict = evaluate(game, civ, actionId);
    const now = game.timeImpulsi || 0;

    /* Le proposte negoziabili rispettano un cooldown anti-spam. */
    if (!verdict.unilateral && onCooldown(game, civ)) {
      return { ok: false, reason: 'Hai già inviato un dispaccio di recente. Attendi.' };
    }
    if (!verdict.unilateral) civ.lastProposalAt = now;

    if (!verdict.accept) {
      events.push({ kind: 'diplo-rejected', civId: civ.id, civName: civ.name,
        civColor: civ.color, action: actionId, impulso: now });
      return { ok: true, accepted: false, reason: verdict.reason };
    }

    switch (actionId) {
      case 'declare-war': {
        civ.relation = 'war';
        civ.truceUntil = 0;
        civ.allianceSince = null;
        civ.disposition = Math.min(civ.disposition || 0, -20);
        const innocent = civ.alignment !== 'male';
        adjustReputation(game, innocent ? CFG.REP_ON_WAR_INNOCENT : CFG.REP_ON_WAR_EVIL);
        applyMoralVerb(game, innocent ? 'dark' : 'light');
        events.push({ kind: 'diplo-war', civId: civ.id, civName: civ.name,
          civColor: civ.color, impulso: now });
        break;
      }
      case 'sue-peace':
      case 'propose-peace': {
        civ.relation = 'peace';
        civ.truceUntil = 0;
        civ.allianceSince = null;
        civ.disposition = Math.max(civ.disposition || 0, CFG.PEACE_DISP_FLOOR);
        adjustReputation(game, CFG.REP_ON_PEACE);
        callOffAggression(game, civ);   // recovery: revoca incursioni/assedi pendenti
        events.push({ kind: 'diplo-peace', civId: civ.id, civName: civ.name,
          civColor: civ.color, impulso: now });
        break;
      }
      case 'propose-alliance': {
        civ.relation = 'alliance';
        civ.truceUntil = 0;
        civ.allianceSince = now;
        civ.disposition = Math.max(civ.disposition || 0, CFG.ALLY_DISP_FLOOR);
        adjustReputation(game, CFG.REP_ON_ALLIANCE);
        callOffAggression(game, civ);
        events.push({ kind: 'diplo-alliance', civId: civ.id, civName: civ.name,
          civColor: civ.color, impulso: now });
        break;
      }
      case 'break-alliance': {
        civ.relation = 'peace';
        civ.allianceSince = null;
        civ.disposition = (civ.disposition || 0) - 15;
        adjustReputation(game, CFG.REP_ON_BREAK_ALLIANCE);
        events.push({ kind: 'diplo-alliance-broken', civId: civ.id, civName: civ.name,
          civColor: civ.color, impulso: now });
        break;
      }
      default:
        return { ok: false, reason: 'Azione sconosciuta.' };
    }
    /* M10 Fase B punto 2 (decisione #52 §13.10): ogni atto diplomatico è
       contatto formale + interazione che conta per "Conosciuta" e oltre. */
    if (ORION.ai && ORION.ai.markContact) ORION.ai.markContact(game, civ, events, 'diplomacy');
    return { ok: true, accepted: true, reason: verdict.reason };
  }

  /* Revoca incursioni inbound e assedi attivi di una civiltà (pace/alleanza).
     Recovery-friendly (#22): la diplomazia È una leva di uscita dalla guerra. */
  function callOffAggression(game, civ) {
    if (Array.isArray(game.incursions)) {
      game.incursions = game.incursions.filter(function (i) { return i.civId !== civ.id; });
    }
    if (Array.isArray(game.battles)) {
      game.battles = game.battles.filter(function (b) { return b.attackerCiv !== civ.id; });
    }
  }

  /* Verbo morale → piste reputation light/dark + ICG (riuso M09). */
  function applyMoralVerb(game, kind) {
    if (ORION.victory && ORION.victory.applyAlignment) {
      ORION.victory.applyAlignment(game, kind);
    }
  }

  /* ---------- Tick: drift reputazione + scadenza tregue ---------- */
  function tick(game, events) {
    if (!game) return;
    const now = game.timeImpulsi || 0;
    ensureReputation(game);

    /* Tregue scadute → tornano in guerra (downgrade esplicito). */
    (game.civs || []).forEach(function (c) {
      if (!c || !c.alive) return;
      if (c.relation === 'truce' && (c.truceUntil || 0) <= now) {
        c.relation = 'war';
        if (events) events.push({ kind: 'diplo-truce-expired', civId: c.id,
          civName: c.name, civColor: c.color, impulso: now });
      }
    });

    /* Reputazione: deriva lenta verso il target dato dalle piste morali
       (light/dark), così i verbi M09 continuano a contare. Cadenzata. */
    if (now % CFG.DRIFT_EVERY_I === 0) {
      const tracks = game.victoryTracks || {};
      const light = tracks.reputationLight || 0;   // 0..1
      const dark = tracks.reputationDark || 0;     // 0..1
      const target = Math.max(CFG.REP_MIN, Math.min(CFG.REP_MAX, 50 + (light - dark) * 40));
      game.reputation += (target - game.reputation) * CFG.REP_DRIFT;
      game.reputation = Math.max(CFG.REP_MIN, Math.min(CFG.REP_MAX, game.reputation));
    }
  }

  /* Conteggi per HUD/UI. */
  function alliesOf(game) {
    return (game.civs || []).filter(function (c) { return c.alive && c.relation === 'alliance'; });
  }
  function atWarWith(game) {
    return (game.civs || []).filter(function (c) {
      return c.alive && effectiveRelation(game, c) === 'war';
    });
  }

  ORION.diplomacy = {
    CFG: CFG,
    RELATIONS: RELATIONS,
    RELATION_LABEL: RELATION_LABEL,
    ensureReputation: ensureReputation,
    reputation: reputation,
    adjustReputation: adjustReputation,
    ensureRelation: ensureRelation,
    effectiveRelation: effectiveRelation,
    relationLabel: relationLabel,
    relationStateClass: relationStateClass,
    relationDispositionBias: relationDispositionBias,
    availableActions: availableActions,
    actionLabel: actionLabel,
    evaluate: evaluate,
    onCooldown: onCooldown,
    apply: apply,
    tick: tick,
    alliesOf: alliesOf,
    atWarWith: atWarWith
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
