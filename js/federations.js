/* =====================================================================
   ORION EMPIRES — federations.js  (M10 Fase B — decisione #52 §13.8)

   FEDERAZIONI EMERGENTI — fusione di alleanze AI durature in entità
   composite. Nome composito, colore mix, somma di sistemi/pianeti/potere,
   decisioni concertate (movimenti unificati, espansione coordinata).

   Modello (decisione #52 §13.8):
     - Le civs originali RESTANO in `game.civs` (cache, marker `civ.federationId`).
     - `game.federations.list[] = { id, name, color, memberIds, initialPlanets,
                                    formedAt, lastTrustTick }`.
     - `game.federations.trust = { 'civA|civB': value }` chiave ordinata.
     - Trust accumulato fra coppie ALLEATE; >= TRUST_THRESHOLD + vocazioni
       compatibili → spawn federation.
     - Fragilità: se un membro perde >50% dei pianeti iniziali O le vocazioni
       diventano incompatibili (cambio dovuto a fase/decline) → si spezza.
     - Iterativa: una federazione che resta solida ed entra in alleanza con
       un'altra federazione → blocco a 3+. (Trattato come coppia AI standard:
       il merge ricalcola membri e federation precedente è dissolta.)

   Vincoli (#5/#22): ZERO `Math.random` (lo scorrere del tempo è il
   driver — niente esiti aleatori). Recovery-friendly: dissoluzione di
   una federazione NON elimina le civs, le rilascia con `federationId=null`
   e trust resettato.
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  const CFG = {
    /* Trust accumulato ogni AI-tick (8 Ι): 1 punto per coppia alleata.
       Soglia 200 → ~1600 Ι di alleanza prima di proporre fusione. */
    TRUST_PER_TICK: 1,
    TRUST_THRESHOLD: 200,
    TRUST_DECAY_ON_BREAK: 0,    // memoria del trust si resetta sui pezzi
    /* Fragilità */
    PLANETS_LOSS_RATIO: 0.5,    // perde >50% iniziale → spezza
    /* Stati narrativi */
    NAME_PREFIX: 'Federazione di '
  };

  /* Matrice di compatibilità vocazionale (simmetrica). Strategia: ammettiamo
     fusioni tra vocazioni di "famiglia" simile (pacifici insieme; militari
     pragmatici insieme), escludiamo i conflitti d'anima evidenti. */
  const VOC_COMPATIBLE = {
    sedentari:     { sedentari: 1, mercantili: 1, mistici: 1, tecnocratici: 1, isolazionisti: 1 },
    mercantili:    { mercantili: 1, sedentari: 1, tecnocratici: 1, mistici: 1, espansionisti: 1 },
    espansionisti: { espansionisti: 1, mercantili: 1, imperialisti: 1, tecnocratici: 1 },
    isolazionisti: { isolazionisti: 1, sedentari: 1, tecnocratici: 1 },
    predoni:       { predoni: 1, imperialisti: 1 },
    mistici:       { mistici: 1, sedentari: 1, mercantili: 1, tecnocratici: 1 },
    tecnocratici:  { tecnocratici: 1, sedentari: 1, mercantili: 1, espansionisti: 1, isolazionisti: 1, mistici: 1 },
    imperialisti:  { imperialisti: 1, espansionisti: 1, predoni: 1 }
  };

  function compatibleVocations(vA, vB) {
    if (!vA || !vB) return false;
    return !!(VOC_COMPATIBLE[vA] && VOC_COMPATIBLE[vA][vB]);
  }

  /* ---------- Stato persistito ---------- */
  function ensureState(game) {
    if (!game.federations || typeof game.federations !== 'object') {
      game.federations = { list: [], trust: {} };
    }
    if (!Array.isArray(game.federations.list)) game.federations.list = [];
    if (!game.federations.trust || typeof game.federations.trust !== 'object') {
      game.federations.trust = {};
    }
    return game.federations;
  }

  function pairKey(idA, idB) {
    return idA < idB ? (idA + '|' + idB) : (idB + '|' + idA);
  }

  function byId(game, fedId) {
    const list = (game.federations && game.federations.list) || [];
    for (let i = 0; i < list.length; i++) if (list[i].id === fedId) return list[i];
    return null;
  }

  function federationOf(game, civId) {
    const list = (game.federations && game.federations.list) || [];
    for (let i = 0; i < list.length; i++) {
      if (list[i].memberIds.indexOf(civId) >= 0) return list[i];
    }
    return null;
  }

  function isFederated(game, civId) {
    return !!federationOf(game, civId);
  }

  function memberCivs(game, fed) {
    const ids = (fed && fed.memberIds) || [];
    return (game.civs || []).filter(function (c) { return ids.indexOf(c.id) >= 0 && c.alive; });
  }

  /* ---------- Mix di colori (semplice, deterministico) ---------- */
  function hexToRgb(h) {
    h = String(h || '#808080').replace('#', '');
    if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }
  function rgbToHex(r, g, b) {
    function H(n) { const s = Math.max(0, Math.min(255, Math.round(n))).toString(16); return s.length === 1 ? '0' + s : s; }
    return '#' + H(r) + H(g) + H(b);
  }
  function mixColors(colors) {
    if (!colors || !colors.length) return '#888';
    let r = 0, g = 0, b = 0;
    colors.forEach(function (c) { const rgb = hexToRgb(c); r += rgb.r; g += rgb.g; b += rgb.b; });
    return rgbToHex(r / colors.length, g / colors.length, b / colors.length);
  }

  /* Nome federazione = "Federazione di X-Y" usando i proper-name più
     riconoscibili (ultima parola del nome civiltà). Determinismo: ordine
     stabile per civId. */
  function lastWord(name) {
    if (!name) return '';
    const parts = String(name).trim().split(/\s+/);
    return parts[parts.length - 1] || name;
  }
  function makeName(members) {
    const sorted = members.slice().sort(function (a, b) { return a.id < b.id ? -1 : 1; });
    return CFG.NAME_PREFIX + sorted.map(function (m) { return lastWord(m.name); }).join('-');
  }

  /* ---------- Spawn / Dissolve ---------- */

  function spawn(game, civA, civB, events) {
    const st = ensureState(game);
    /* Se uno dei due è già federato, fai un MERGE: assorbi i membri del
       suo federation_id e dissolvi la federazione precedente. */
    const fedA = federationOf(game, civA.id);
    const fedB = federationOf(game, civB.id);
    const memberIds = new Set();
    if (fedA) fedA.memberIds.forEach(function (id) { memberIds.add(id); });
    else memberIds.add(civA.id);
    if (fedB) fedB.memberIds.forEach(function (id) { memberIds.add(id); });
    else memberIds.add(civB.id);

    /* Dissolvi le precedenti se erano federate (senza emettere "broken"
       narrativo: è un upgrade, non una rottura). */
    if (fedA) silentRemove(st, fedA.id);
    if (fedB && (!fedA || fedB.id !== fedA.id)) silentRemove(st, fedB.id);

    const ids = Array.from(memberIds);
    const members = (game.civs || []).filter(function (c) { return ids.indexOf(c.id) >= 0; });
    if (members.length < 2) return null;

    const fed = {
      id: 'fed-' + (game.timeImpulsi || 0) + '-' + ids.sort().join('-'),
      name: makeName(members),
      color: mixColors(members.map(function (m) { return m.color; })),
      memberIds: ids.slice(),
      initialPlanets: {},
      formedAt: game.timeImpulsi || 0
    };
    members.forEach(function (m) {
      fed.initialPlanets[m.id] = (m.planets || []).length;
      m.federationId = fed.id;
      /* M10 Fase B punto 2: federation = +1 interazione + scatto verso
         'familiar' al prossimo tick (la federazione vale come "alleanza ≥1000 Ι"
         simbolica). */
      if (ORION.ai && ORION.ai.addInteraction) ORION.ai.addInteraction(m);
    });
    st.list.push(fed);

    if (events) {
      events.push({
        kind: 'federation-formed', fedId: fed.id, fedName: fed.name,
        fedColor: fed.color,
        memberNames: members.map(function (m) { return m.name; }),
        impulso: game.timeImpulsi || 0
      });
    }
    return fed;
  }

  /* Rimozione silenziosa (no evento) — usata dal merge. */
  function silentRemove(state, fedId) {
    state.list = state.list.filter(function (f) { return f.id !== fedId; });
    /* Reset memberId.federationId è opzionale (lo riassegniamo subito). */
  }

  function dissolve(game, fedId, reason, events) {
    const st = ensureState(game);
    const fed = st.list.filter(function (f) { return f.id === fedId; })[0];
    if (!fed) return;
    /* Rilascia i membri (federationId=null). */
    (game.civs || []).forEach(function (c) {
      if (c.federationId === fedId) c.federationId = null;
    });
    /* Resetta trust delle coppie membri (decisione: memoria del trust va a 0). */
    const ids = fed.memberIds;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        delete st.trust[pairKey(ids[i], ids[j])];
      }
    }
    st.list = st.list.filter(function (f) { return f.id !== fedId; });
    if (events) {
      events.push({
        kind: 'federation-broken', fedId: fed.id, fedName: fed.name,
        fedColor: fed.color, reason: reason || 'unknown',
        memberNames: ids.map(function (id) {
          const c = (game.civs || []).filter(function (cc) { return cc.id === id; })[0];
          return c ? c.name : id;
        }),
        impulso: game.timeImpulsi || 0
      });
    }
  }

  /* ---------- Tick ---------- */

  function tick(game, events) {
    if (!game || !Array.isArray(game.civs)) return;
    const st = ensureState(game);
    const now = game.timeImpulsi || 0;

    /* 1) Accumulo trust per ogni coppia ALLEATA viva (e non già nella stessa
          federazione). Soglia 200 → ~1600 Ι. */
    const live = game.civs.filter(function (c) { return c.alive; });
    for (let i = 0; i < live.length; i++) {
      const A = live[i];
      if (A.relation !== 'alliance') continue;
      for (let j = i + 1; j < live.length; j++) {
        const B = live[j];
        if (B.relation !== 'alliance') continue;
        /* M11 Fase A: la "relation" è bilaterale solo verso il GIOCATORE. Per
           le coppie AI-vs-AI usiamo come proxy: entrambe alleate del giocatore
           e con vocazioni compatibili → si fidano fra loro. */
        if (!compatibleVocations(A.vocation, B.vocation)) continue;
        const fedA = federationOf(game, A.id);
        const fedB = federationOf(game, B.id);
        if (fedA && fedA === fedB) continue;
        const key = pairKey(A.id, B.id);
        st.trust[key] = (st.trust[key] || 0) + CFG.TRUST_PER_TICK;

        /* Soglia: spawn (o merge se uno dei due era già in una federazione). */
        if (st.trust[key] >= CFG.TRUST_THRESHOLD) {
          spawn(game, A, B, events);
          delete st.trust[key];
        }
      }
    }

    /* 2) Fragilità: per ogni federazione viva, verifica se un membro ha perso
          >50% pianeti iniziali O se le vocazioni sono diventate incompatibili. */
    const toDissolve = [];
    st.list.forEach(function (fed) {
      const members = memberCivs(game, fed);
      /* Se ≤1 membro vivo, dissolvi (silente: nessuno con cui federare). */
      if (members.length < 2) {
        toDissolve.push({ id: fed.id, reason: 'members-fallen' });
        return;
      }
      /* Perdita pianeti >50%. */
      for (let i = 0; i < members.length; i++) {
        const m = members[i];
        const initN = fed.initialPlanets[m.id] || 0;
        if (!initN) continue;
        const nowN = (m.planets || []).length;
        if (nowN < initN * (1 - CFG.PLANETS_LOSS_RATIO)) {
          toDissolve.push({ id: fed.id, reason: 'territory-loss' });
          return;
        }
      }
      /* Vocazioni divergenti (può succedere se il driver cambia: lazy check). */
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          if (!compatibleVocations(members[i].vocation, members[j].vocation)) {
            toDissolve.push({ id: fed.id, reason: 'vocation-drift' });
            return;
          }
        }
      }
    });
    /* Dissolvi (deduplica per id). */
    const seen = new Set();
    toDissolve.forEach(function (d) {
      if (seen.has(d.id)) return; seen.add(d.id);
      dissolve(game, d.id, d.reason, events);
    });
  }

  /* ---------- Decisioni concertate (gancio per ai.js) ----------
     I membri di una federazione condividono il "tono" politico: se uno è
     in guerra, la federazione lo segnala (per future incursioni coordinate
     M11/M17). In Fase B punto 1 esponiamo solo gli helper. */
  function isAllyOf(game, civId, otherId) {
    /* Stessa federazione = alleato implicito. */
    const fed = federationOf(game, civId);
    if (!fed) return false;
    return fed.memberIds.indexOf(otherId) >= 0;
  }

  ORION.federations = {
    CFG: CFG,
    VOC_COMPATIBLE: VOC_COMPATIBLE,
    compatibleVocations: compatibleVocations,
    ensureState: ensureState,
    byId: byId,
    federationOf: federationOf,
    isFederated: isFederated,
    memberCivs: memberCivs,
    spawn: spawn,
    dissolve: dissolve,
    tick: tick,
    isAllyOf: isAllyOf,
    /* per test */
    _pairKey: pairKey
  };
})(typeof window !== 'undefined' ? window : this);
