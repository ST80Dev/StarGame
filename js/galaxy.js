/* =====================================================================
   ORION EMPIRES — galaxy.js
   Modulo M02: generazione procedurale della galassia (GDD §5).

   Produce DUE cose nettamente separate (decisione #5 — seed+delta):

   1) STRUTTURA IMMUTABILE  — `generate(seed)`
      Tutto ciò che si rigenera identico dal seed: sistemi (posizione,
      nome, tipo stella, pericolo, cluster), rotte stellari (grafo),
      sistema di partenza, confini della mappa. NON va salvata: basta il
      seed per ricostruirla.

   2) STATO MUTEVOLE (delta) — `createState(galaxy)`
      Ciò che cambia giocando e che andrà salvato in M06: livello di
      scoperta dei sistemi (nebbia di guerra, §5.1/§5.3), selezione
      corrente. Qui è inizializzato; l'esplorazione vera è M07.

   Coordinate dei sistemi in spazio normalizzato [0,1]×[0,1]; il
   rendering (galaxy-map.js) le proietta sul Canvas.
   ===================================================================== */
'use strict';

(function (root) {
  const SCHEMA_VERSION = 1;

  /* Tipi di stella (uso minimale in M02: colore del nodo sulla mappa).
     Il contenuto completo del sistema — corpi, anomalie — è M03 (§6). */
  const STAR_TYPES = [
    { id: 'yellow', label: 'Nana gialla',  color: '#ffd86b', weight: 30 },
    { id: 'orange', label: 'Nana arancione', color: '#ffae5c', weight: 18 },
    { id: 'red',    label: 'Gigante rossa', color: '#ff6f5c', weight: 16 },
    { id: 'white',  label: 'Nana bianca',  color: '#dfe9ff', weight: 14 },
    { id: 'blue',   label: 'Stella blu',   color: '#7fb6ff', weight: 12 },
    { id: 'binary', label: 'Binaria',      color: '#c79bff', weight: 10 }
  ];

  /* Livelli di scoperta (nebbia di guerra, §5.1). */
  const DISCOVERY = {
    UNKNOWN:  0, // posizione solo approssimativa, nessun dettaglio
    DETECTED: 1, // rilevato (adiacente al noto): posizione + nome
    EXPLORED: 2  // pienamente noto
  };

  function pickStarType(rng) {
    const total = STAR_TYPES.reduce(function (s, t) { return s + t.weight; }, 0);
    let r = rng.float() * total;
    for (let i = 0; i < STAR_TYPES.length; i++) {
      r -= STAR_TYPES[i].weight;
      if (r <= 0) return STAR_TYPES[i].id;
    }
    return STAR_TYPES[0].id;
  }

  function dist2(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
  }

  function clampv(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /* ------------------------------------------------------------------
     Layout procedurale con clustering (§5.1)

     Obiettivi (richiesta utente):
     - galassie con FORMA VARIABILE (per lo più verso il quasi-sferico,
       ma anche ellittiche o irregolari), non sempre appiattite;
     - gruppi stellari POCO SOVRAPPOSTI, così da poterli nominare come
       regioni distinte.

     Strategia:
     1) inviluppo galattico per-seed (disco con aspetto/rotazione
        randomizzati, bias verso il circolare);
     2) centri-cluster con DISTANZA MINIMA reciproca (separazione);
     3) forma per cluster variabile: raggio diverso, aspetto con bias
        sferico, rotazione, 1–3 sotto-ammassi (contorni non regolari);
     4) appartenenza di VORONOI: ogni sistema appartiene al centro più
        vicino → i territori dei gruppi non si intersecano.
     ------------------------------------------------------------------ */
  function layoutSystems(rng, count) {
    const margin = 0.06;
    const minDist = 0.5 / Math.sqrt(count); // separazione tra nodi (vista zoom)
    const minDist2 = minDist * minDist;

    const clusterCount = rng.int(4, 7);

    // 1) inviluppo galattico: disco centrato, aspetto perlopiù ~1 (sferico)
    const Rg = rng.range(0.32, 0.44);
    const galAspect = 1 + Math.pow(rng.float(), 2) * 0.5;
    const galAngle = rng.float() * Math.PI;
    function sampleEnvelope() {
      const rr = Math.sqrt(rng.float());              // disco uniforme
      const a = rng.float() * Math.PI * 2;
      const px = Math.cos(a) * rr * Rg;
      const py = Math.sin(a) * rr * (Rg / galAspect);
      return {
        x: 0.5 + px * Math.cos(galAngle) - py * Math.sin(galAngle),
        y: 0.5 + px * Math.sin(galAngle) + py * Math.cos(galAngle)
      };
    }

    // 2) centri-cluster con distanza minima reciproca
    const centers = [];
    let minCenterDist = (Rg * 1.6) / Math.sqrt(clusterCount);
    let guard = 0;
    while (centers.length < clusterCount && guard < 5000) {
      guard++;
      const p = sampleEnvelope();
      if (p.x < margin || p.x > 1 - margin || p.y < margin || p.y > 1 - margin) continue;
      let ok = true;
      for (let j = 0; j < centers.length; j++) {
        if (dist2(centers[j], p) < minCenterDist * minCenterDist) { ok = false; break; }
      }
      if (ok) centers.push({ x: p.x, y: p.y });
      if (guard % 800 === 0) minCenterDist *= 0.85; // allenta se fatica
    }
    while (centers.length < clusterCount) {
      const p = sampleEnvelope();
      centers.push({ x: clampv(p.x, margin, 1 - margin), y: clampv(p.y, margin, 1 - margin) });
    }

    // distanza dal vicino più prossimo (per contenere i raggi)
    centers.forEach(function (c, i) {
      let nn = Infinity;
      centers.forEach(function (d, j) {
        if (i !== j) { const dd = Math.sqrt(dist2(c, d)); if (dd < nn) nn = dd; }
      });
      c.nn = isFinite(nn) ? nn : 0.4;
    });

    // 3) forma per cluster: raggio, aspetto (bias sferico), rotazione, sotto-ammassi
    centers.forEach(function (c) {
      c.r = Math.min(rng.range(0.09, 0.17), 0.7 * c.nn);
      c.aspect = 1 + Math.pow(rng.float(), 2) * 0.85; // perlopiù ~1
      c.angle = rng.float() * Math.PI;
      const nSub = rng.int(1, 3);
      c.subs = [{ dx: 0, dy: 0, w: 1 }];
      for (let s = 1; s < nSub; s++) {
        const a = rng.float() * Math.PI * 2;
        const rad = rng.range(0.3, 0.7) * c.r;
        c.subs.push({ dx: Math.cos(a) * rad, dy: Math.sin(a) * rad, w: rng.range(0.4, 0.9) });
      }
      c.subW = c.subs.reduce(function (s, x) { return s + x.w; }, 0);
    });

    // quote per cluster proporzionali all'area
    const totalArea = centers.reduce(function (s, c) { return s + c.r * c.r; }, 0) || 1;
    const quota = centers.map(function (c) {
      return Math.max(3, Math.round(count * (c.r * c.r) / totalArea));
    });
    // aggiusta la somma a `count`
    let qsum = quota.reduce(function (s, q) { return s + q; }, 0);
    let qi = 0;
    while (qsum > count) { if (quota[qi % quota.length] > 3) { quota[qi % quota.length]--; qsum--; } qi++; }
    while (qsum < count) { quota[qi % quota.length]++; qsum++; qi++; }

    function nearestCenter(x, y) {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < centers.length; i++) {
        const d = (centers[i].x - x) * (centers[i].x - x) + (centers[i].y - y) * (centers[i].y - y);
        if (d < bd) { bd = d; bi = i; }
      }
      return bi;
    }

    // 4) campiona i membri (Voronoi + distanza minima tra nodi)
    const positions = [];
    for (let ci = 0; ci < centers.length; ci++) {
      const c = centers[ci];
      let placed = 0, g2 = 0;
      const need = quota[ci];
      while (placed < need && g2 < need * 200) {
        g2++;
        let rsel = rng.float() * c.subW, sub = c.subs[0];
        for (let s = 0; s < c.subs.length; s++) { rsel -= c.subs[s].w; if (rsel <= 0) { sub = c.subs[s]; break; } }
        const lx = rng.gauss() * c.r * 0.55;
        const ly = rng.gauss() * (c.r / c.aspect) * 0.55;
        const x = c.x + sub.dx + (lx * Math.cos(c.angle) - ly * Math.sin(c.angle));
        const y = c.y + sub.dy + (lx * Math.sin(c.angle) + ly * Math.cos(c.angle));
        if (x < margin || x > 1 - margin || y < margin || y > 1 - margin) continue;
        if (nearestCenter(x, y) !== ci) continue; // territori non sovrapposti
        let ok = true;
        for (let j = 0; j < positions.length; j++) {
          if (dist2(positions[j], { x: x, y: y }) < minDist2) { ok = false; break; }
        }
        if (!ok) continue;
        positions.push({ x: x, y: y, cluster: ci });
        placed++;
      }
      // fallback: completa la quota vicino al centro
      while (placed < need) {
        positions.push({
          x: clampv(c.x + rng.gauss() * c.r * 0.4, margin, 1 - margin),
          y: clampv(c.y + rng.gauss() * c.r * 0.4, margin, 1 - margin),
          cluster: ci
        });
        placed++;
      }
    }

    return positions;
  }

  /* ------------------------------------------------------------------
     Grafo delle rotte stellari (§5.1: grafo a nodi)
     Strategia: MST (albero di copertura minimo) per garantire la
     connettività di tutta la galassia, poi qualche rotta extra corta per
     creare anelli e scorciatoie locali. Deterministico.
     ------------------------------------------------------------------ */
  function buildEdges(rng, systems) {
    const n = systems.length;
    const edgeSet = new Set();
    const edges = [];

    function key(a, b) { return a < b ? a + '-' + b : b + '-' + a; }
    function addEdge(a, b) {
      if (a === b) return;
      const k = key(a, b);
      if (edgeSet.has(k)) return;
      edgeSet.add(k);
      edges.push({ a: a, b: b });
      systems[a].links.push(b);
      systems[b].links.push(a);
    }

    // --- MST con algoritmo di Prim (O(n^2), va benissimo per ~120 nodi) ---
    const inTree = new Array(n).fill(false);
    const best = new Array(n).fill(Infinity);
    const bestFrom = new Array(n).fill(-1);
    inTree[0] = true;
    for (let j = 1; j < n; j++) {
      best[j] = dist2(systems[0], systems[j]);
      bestFrom[j] = 0;
    }
    for (let added = 1; added < n; added++) {
      let u = -1;
      let bd = Infinity;
      for (let j = 0; j < n; j++) {
        if (!inTree[j] && best[j] < bd) { bd = best[j]; u = j; }
      }
      if (u === -1) break;
      inTree[u] = true;
      addEdge(bestFrom[u], u);
      for (let j = 0; j < n; j++) {
        if (!inTree[j]) {
          const d = dist2(systems[u], systems[j]);
          if (d < best[j]) { best[j] = d; bestFrom[j] = u; }
        }
      }
    }

    // --- Rotte extra: per ogni nodo, collega ai vicini più prossimi
    //     finché non raggiunge un piccolo grado, entro una distanza max. ---
    const maxLinkDist = (1.6 / Math.sqrt(n));
    const maxLinkDist2 = maxLinkDist * maxLinkDist;
    for (let i = 0; i < n; i++) {
      const targetDegree = rng.int(2, 4);
      if (systems[i].links.length >= targetDegree) continue;

      // ordina i candidati per distanza
      const cands = [];
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const d = dist2(systems[i], systems[j]);
        if (d <= maxLinkDist2) cands.push({ j: j, d: d });
      }
      cands.sort(function (p, q) { return p.d - q.d; });

      for (let c = 0; c < cands.length && systems[i].links.length < targetDegree; c++) {
        addEdge(i, cands[c].j);
      }
    }

    return edges;
  }

  /* ------------------------------------------------------------------
     Pericolo galattico (§5.3): cresce con la distanza dal pianeta base,
     più fattori locali casuali. 0–100.
     ------------------------------------------------------------------ */
  function computeDanger(rng, systems, homeId) {
    const home = systems[homeId];
    let maxD = 0;
    for (let i = 0; i < systems.length; i++) {
      const d = Math.sqrt(dist2(home, systems[i]));
      if (d > maxD) maxD = d;
    }
    for (let i = 0; i < systems.length; i++) {
      const d = Math.sqrt(dist2(home, systems[i]));
      const distFactor = maxD > 0 ? d / maxD : 0;          // 0 vicino, 1 lontano
      const local = rng.range(-0.12, 0.18);                // fattori locali
      let danger = Math.round((distFactor * 0.85 + 0.05 + local) * 100);
      danger = Math.max(0, Math.min(100, danger));
      systems[i].danger = i === homeId ? 0 : danger;
    }
  }

  function dangerTier(d) {
    if (d <= 25) return 'sicuro';
    if (d <= 50) return 'instabile';
    if (d <= 75) return 'pericoloso';
    return 'letale';
  }

  /* Nome-base di un sistema, senza designazione di catalogo ("Rigel II" -> "Rigel"). */
  function baseName(name) {
    return name.replace(/\s+[IVX]+$/, '');
  }

  /* Inviluppo convesso (monotone chain di Andrew) dei punti membri di un
     gruppo. Serve a disegnare il contorno morbido della regione. */
  function convexHull(points) {
    if (points.length < 3) return points.slice();
    const pts = points.slice().sort(function (a, b) {
      return a.x === b.x ? a.y - b.y : a.x - b.x;
    });
    const cross = function (o, a, b) {
      return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    };
    const lower = [];
    for (let i = 0; i < pts.length; i++) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pts[i]) <= 0) lower.pop();
      lower.push(pts[i]);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0) upper.pop();
      upper.push(pts[i]);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper).map(function (p) { return { x: p.x, y: p.y }; });
  }

  /* ------------------------------------------------------------------
     Gruppi stellari / regioni (M02 — navigazione gerarchica)
     Ogni cluster diventa un "gruppo" navigabile: centroide, confini,
     inviluppo, raggio, pericolo medio, sistema rappresentativo e nome
     (schema "misto", vedi names.generateRegions). Deterministico.
     ------------------------------------------------------------------ */
  function buildGroups(rng, systems) {
    const byCluster = {};
    systems.forEach(function (s) {
      (byCluster[s.cluster] = byCluster[s.cluster] || []).push(s);
    });

    const groups = Object.keys(byCluster).map(function (k) {
      const members = byCluster[k];
      let cx = 0, cy = 0, minX = 1, minY = 1, maxX = 0, maxY = 0, dangerSum = 0;
      members.forEach(function (m) {
        cx += m.x; cy += m.y; dangerSum += m.danger;
        if (m.x < minX) minX = m.x; if (m.x > maxX) maxX = m.x;
        if (m.y < minY) minY = m.y; if (m.y > maxY) maxY = m.y;
      });
      cx /= members.length; cy /= members.length;

      // raggio = distanza massima dal centroide (per l'alone della regione)
      let radius = 0;
      members.forEach(function (m) {
        const d = Math.sqrt((m.x - cx) * (m.x - cx) + (m.y - cy) * (m.y - cy));
        if (d > radius) radius = d;
      });

      // sistema rappresentativo: preferisci un nome reale, poi il più connesso
      const reals = members.filter(function (m) { return m.realName; });
      const pool = reals.length ? reals : members;
      let rep = pool[0];
      pool.forEach(function (m) { if (m.links.length > rep.links.length) rep = m; });

      return {
        id: Number(k),
        members: members.map(function (m) { return m.id; }),
        cx: cx, cy: cy,
        minX: minX, minY: minY, maxX: maxX, maxY: maxY,
        radius: radius,
        hull: convexHull(members.map(function (m) { return { x: m.x, y: m.y }; })),
        danger: Math.round(dangerSum / members.length),
        repId: rep.id,
        hasReal: reals.length > 0,
        name: ''     // assegnato sotto
      };
    });

    groups.sort(function (a, b) { return a.id - b.id; });

    // nomi regione (schema "misto")
    const refs = groups.map(function (gp) {
      return { real: gp.hasReal ? baseName(systems[gp.repId].name) : null };
    });
    const names = root.ORION.names.generateRegions(rng, refs);
    groups.forEach(function (gp, i) {
      gp.name = names[i];
      gp.dangerTier = dangerTier(gp.danger);
    });

    return groups;
  }

  /* ==================================================================
     GENERAZIONE STRUTTURA IMMUTABILE
     ================================================================== */
  function generate(seed) {
    const rng = root.ORION.rng.makeRng(seed);

    // §5.1: 80–120 sistemi, fissi per partita
    const count = rng.int(80, 120);

    // posizioni + cluster
    const positions = layoutSystems(rng, count);

    // nomi §5.2 (consuma l'RNG in modo deterministico)
    const names = root.ORION.names.generate(rng, count);

    const systems = positions.map(function (p, i) {
      return {
        id: i,
        name: names[i].name,
        realName: names[i].real,
        x: p.x,
        y: p.y,
        cluster: p.cluster,
        star: pickStarType(rng),
        danger: 0,        // calcolato dopo (serve homeId)
        links: []         // riempito da buildEdges
      };
    });

    // rotte stellari
    const edges = buildEdges(rng, systems);

    // §5.1: sistema di partenza. Scelta: un sistema in zona relativamente
    // centrale e ben connesso, di tipo "ospitale" se possibile.
    const homeId = chooseHome(rng, systems);

    // pericolo §5.3 (dipende dalla distanza dal pianeta base)
    computeDanger(rng, systems, homeId);
    systems.forEach(function (s) { s.dangerTier = dangerTier(s.danger); });

    // gruppi stellari / regioni navigabili (struttura immutabile)
    const groups = buildGroups(rng, systems);
    const homeGroupId = systems[homeId].cluster;

    return {
      schemaVersion: SCHEMA_VERSION,
      seed: seed,
      count: count,
      systems: systems,
      edges: edges,
      groups: groups,
      homeId: homeId,
      homeGroupId: homeGroupId,
      bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
      starTypes: STAR_TYPES
    };
  }

  /* Sceglie il sistema di partenza: vicino al baricentro e ben connesso. */
  function chooseHome(rng, systems) {
    let cx = 0;
    let cy = 0;
    systems.forEach(function (s) { cx += s.x; cy += s.y; });
    cx /= systems.length;
    cy /= systems.length;

    let bestId = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < systems.length; i++) {
      const s = systems[i];
      const d = Math.sqrt((s.x - cx) * (s.x - cx) + (s.y - cy) * (s.y - cy));
      // più vicino al centro e con più rotte = punteggio migliore
      const score = s.links.length * 1.0 - d * 4.0 + rng.range(0, 0.4);
      if (score > bestScore) { bestScore = score; bestId = i; }
    }
    return bestId;
  }

  /* ==================================================================
     STATO MUTEVOLE (delta) — da salvare in M06
     ================================================================== */
  function createState(galaxy) {
    const discovery = new Array(galaxy.count).fill(DISCOVERY.UNKNOWN);

    // §5.1: all'inizio è noto solo il sistema di partenza; gli adiacenti
    // sono "rilevati" (posizione + nome) ma non esplorati.
    discovery[galaxy.homeId] = DISCOVERY.EXPLORED;
    galaxy.systems[galaxy.homeId].links.forEach(function (nid) {
      if (discovery[nid] === DISCOVERY.UNKNOWN) discovery[nid] = DISCOVERY.DETECTED;
    });

    return {
      schemaVersion: SCHEMA_VERSION,
      seed: galaxy.seed,        // basta questo per rigenerare la struttura
      discovery: discovery,     // livello di scoperta per sistema (indice = id)
      selectedId: galaxy.homeId
    };
  }

  root.ORION = root.ORION || {};
  root.ORION.galaxy = {
    generate: generate,
    createState: createState,
    DISCOVERY: DISCOVERY,
    dangerTier: dangerTier,
    SCHEMA_VERSION: SCHEMA_VERSION
  };
})(typeof window !== 'undefined' ? window : this);
