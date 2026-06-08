/* Orion Empires — Planet Overlay (decisione #66)
   ------------------------------------------------------------------
   Overlay leggero sopra il planet-canvas (sotto la Plancia di Colonia)
   che disegna 3 layer ADDITIVI per dare "vita" al pianeta al centro
   della scena, senza appesantire la CPU:

   1) Marker SVG strutture sulla sfera (posizione sferica deterministica
      da seed, proiezione 2D coerente col bake, glow per categoria,
      pulse pesante se la struttura è in costruzione in coda).
   2) Anello orbitale CSS-only rotante (decorativo, dà movimento anche
      a gioco fermo — animazione CSS, niente rAF JS).
   3) Indicatori DOM ai 4 cardinali esterni alla sfera:
      N = capitale ★ / fase Insediamento %
      E = scarsità (low/crit di cibo/acqua/energia/metalli)
      S = rifiuti ♻ (saturazione)
      W = flotte in orbita 🛰 (contatore)

   Vincoli rispettati:
   - Vanilla JS, no framework, no CDN, no WebGL (§2 GDD).
   - Sync agganciato a planet-view.render() (già on-demand): nessun rAF
     proprio. Le animazioni "vive" sono CSS keyframes.
   - Determinismo (decisione #5): posizioni marker derivate da seed
     deterministico, mai Math.random.
   - Recovery-friendly (decisione #22): nessuna mutazione di stato,
     puro display.
   - Desktop-only via media query (≥1000px) — coerente con decisione
     #63 (mobile usa sheet a tutto schermo, niente sfera centrale).
*/
(function (root) {
  const ORION = root.ORION = root.ORION || {};

  /* RNG hash deterministico (mulberry32 mini, no dipendenza da rng.js
     per restare indipendente — basta una funzione pseudo-casuale stabile
     per posizione marker su superficie). */
  function hashStr(s) {
    let h = 1779033703 ^ s.length;
    for (let i = 0; i < s.length; i++) {
      h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      h = (h ^= h >>> 16) >>> 0;
      return h / 4294967296;
    };
  }

  /* Tinte per categoria (UI_GUIDE §1, coerenti con la sidebar). */
  const CAT_COLOR = {
    estrattiva: '#f0b870',
    produttiva: '#7ad9e8',
    ricerca:    '#b89cf0',
    militare:   '#e88a8a',
    civile:     '#9fd0a8',
    avanzata:   '#e89cd8'
  };

  /* Glifo abbreviato per il marker (usa il glyph del catalogo se c'è,
     fallback alla prima lettera del nome). */
  function structGlyph(def) {
    if (def && def.glyph) return def.glyph;
    if (def && def.name) return def.name.charAt(0);
    return '•';
  }

  /* Determina la categoria della struttura dal catalogo. */
  function structDef(id) {
    if (!ORION.structures || !ORION.structures.get) return null;
    return ORION.structures.get(id);
  }

  /* Posizione sferica deterministica per una struttura: (theta, phi)
     concentrate sulla fascia tropicale visibile (phi piccolo) così
     stanno sul "lato giorno" più spesso. Sparse abbastanza da non
     accavallarsi a parità di seed. */
  function spherePosFor(seed, idx) {
    const rng = hashStr(seed + ':struct:' + idx);
    const theta = rng() * Math.PI * 2;
    const phi   = (rng() - 0.5) * 0.9; // ~±26° dall'equatore
    return { theta: theta, phi: phi };
  }

  /* Proietta (theta, phi) sulla sfera vista da camera fissa con
     lightDir. Ritorna { nx, ny, nz, lit } in coordinate sferiche
     unitarie. nz>0 = lato visibile, nz<0 = retro. */
  function projectSphere(theta, phi, lightDir) {
    const cp = Math.cos(phi);
    const nx = cp * Math.sin(theta);
    const ny = Math.sin(phi);
    const nz = cp * Math.cos(theta);
    let lit = 0;
    if (lightDir) {
      // dot(normal, lightDir) → 1 in piena luce, -1 in pieno buio.
      lit = nx * lightDir[0] + (-ny) * lightDir[1] + nz * lightDir[2];
    }
    return { nx: nx, ny: ny, nz: nz, lit: lit };
  }

  function PlanetOverlay() {
    this.host = null;
    this.root = null;
    this.svg = null;
    this.gMarkers = null;
    this.cardinalsBox = null;
    this.badges = {};
    this.planet = null;
    this.colony = null;
    this.body = null;
    this.system = null;
    this.markerData = []; // { id, theta, phi, def, level, building }
  }

  PlanetOverlay.prototype.mount = function (host, system, body, planet, colony) {
    this.host = host;
    this.system = system;
    this.body = body;
    this.planet = planet;
    this.colony = colony;

    const div = document.createElement('div');
    div.className = 'planet-overlay';
    div.setAttribute('aria-hidden', 'true');
    div.innerHTML =
      '<svg class="planet-overlay__svg" xmlns="http://www.w3.org/2000/svg">' +
        '<g class="planet-overlay__orbit"></g>' +
        '<g class="planet-overlay__markers"></g>' +
      '</svg>' +
      '<div class="planet-overlay__cardinals">' +
        '<div class="planet-overlay__badge" data-pos="n" hidden></div>' +
        '<div class="planet-overlay__badge" data-pos="e" hidden></div>' +
        '<div class="planet-overlay__badge" data-pos="s" hidden></div>' +
        '<div class="planet-overlay__badge" data-pos="w" hidden></div>' +
      '</div>';
    host.appendChild(div);

    this.root = div;
    this.svg = div.querySelector('.planet-overlay__svg');
    this.gOrbit = div.querySelector('.planet-overlay__orbit');
    this.gMarkers = div.querySelector('.planet-overlay__markers');
    this.cardinalsBox = div.querySelector('.planet-overlay__cardinals');
    const badges = div.querySelectorAll('.planet-overlay__badge');
    for (let i = 0; i < badges.length; i++) {
      this.badges[badges[i].getAttribute('data-pos')] = badges[i];
    }

    this._buildMarkerData();
    this._renderMarkers();
    this._renderCardinals();
    this.sync();
    return this;
  };

  /* Aggiorna i dati senza ricreare DOM (chiamato da main.js quando la
     colonia cambia: build/colonize/etc.). */
  PlanetOverlay.prototype.refresh = function (planet, colony) {
    if (planet) this.planet = planet;
    if (colony) this.colony = colony;
    this._buildMarkerData();
    this._renderMarkers();
    this._renderCardinals();
    this.sync();
  };

  /* Costruisce la lista di marker (uno per tipo di struttura presente,
     con eventuale flag "in costruzione" dalla coda). */
  PlanetOverlay.prototype._buildMarkerData = function () {
    this.markerData = [];
    if (!this.colony || !this.colony.colonized) return;
    const seed = this.planet && this.planet.seed
      ? String(this.planet.seed)
      : (this.body && this.body.seed ? String(this.body.seed) : 'x');

    // Set degli id "in costruzione" dalla coda (pulse animato).
    const buildingIds = {};
    const queue = this.colony.queue || [];
    for (let i = 0; i < queue.length; i++) {
      if (queue[i] && queue[i].id) buildingIds[queue[i].id] = true;
    }

    const structs = this.colony.structures || {};
    const ids = Object.keys(structs);
    // Ordine deterministico: stabile fra refresh.
    ids.sort();
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const inst = structs[id];
      if (!inst) continue;
      const def = structDef(id);
      const pos = spherePosFor(seed, i);
      this.markerData.push({
        id: id,
        def: def,
        level: inst.level || 1,
        building: !!buildingIds[id],
        theta: pos.theta,
        phi: pos.phi
      });
      delete buildingIds[id];
    }
    // Strutture in coda non ancora costruite (es. prima volta): marker
    // fantasma con pulse veloce.
    const ghostIds = Object.keys(buildingIds);
    for (let j = 0; j < ghostIds.length; j++) {
      const gid = ghostIds[j];
      const def = structDef(gid);
      const pos = spherePosFor(seed, ids.length + j);
      this.markerData.push({
        id: gid,
        def: def,
        level: 0,
        building: true,
        ghost: true,
        theta: pos.theta,
        phi: pos.phi
      });
    }
  };

  /* Genera/aggiorna i nodi SVG dei marker. */
  PlanetOverlay.prototype._renderMarkers = function () {
    if (!this.gMarkers) return;
    this.gMarkers.innerHTML = '';
    const svgNS = 'http://www.w3.org/2000/svg';
    for (let i = 0; i < this.markerData.length; i++) {
      const m = this.markerData[i];
      const color = (m.def && CAT_COLOR[m.def.cat]) || '#cfe0ff';
      const g = document.createElementNS(svgNS, 'g');
      g.setAttribute('class',
        'pm' + (m.building ? ' pm--building' : '') + (m.ghost ? ' pm--ghost' : ''));
      g.setAttribute('data-id', m.id);
      g.style.setProperty('--pm-color', color);
      // stagger del pulse per dare un effetto "vivo" non sincrono
      g.style.setProperty('--pm-delay', ((i * 0.37) % 3.2).toFixed(2) + 's');

      // Anello esterno glow
      const halo = document.createElementNS(svgNS, 'circle');
      halo.setAttribute('class', 'pm__halo');
      halo.setAttribute('r', '8');
      g.appendChild(halo);
      // Cerchio pieno
      const dot = document.createElementNS(svgNS, 'circle');
      dot.setAttribute('class', 'pm__dot');
      dot.setAttribute('r', '4');
      g.appendChild(dot);
      // Glifo testo
      const txt = document.createElementNS(svgNS, 'text');
      txt.setAttribute('class', 'pm__glyph');
      txt.setAttribute('text-anchor', 'middle');
      txt.setAttribute('dominant-baseline', 'central');
      txt.textContent = structGlyph(m.def);
      g.appendChild(txt);
      // Badge livello (×L) se livello > 1
      if (m.level > 1) {
        const lvl = document.createElementNS(svgNS, 'text');
        lvl.setAttribute('class', 'pm__lvl');
        lvl.setAttribute('text-anchor', 'start');
        lvl.setAttribute('dominant-baseline', 'central');
        lvl.textContent = '×' + m.level;
        g.appendChild(lvl);
      }
      g.style.display = 'none'; // posizionato in sync()
      // tooltip nativo
      const title = document.createElementNS(svgNS, 'title');
      title.textContent = (m.def ? m.def.name : m.id)
        + (m.level > 0 ? ' · livello ' + m.level : '')
        + (m.building ? ' · in costruzione' : '');
      g.appendChild(title);
      this.gMarkers.appendChild(g);
    }
  };

  /* Indicatori DOM ai 4 cardinali. Logica recovery-friendly: niente
     allarmi se non c'è nulla da segnalare, badge nascosto. */
  PlanetOverlay.prototype._renderCardinals = function () {
    const c = this.colony;
    const planet = this.planet;
    if (!c || !c.colonized) {
      for (const k in this.badges) this.badges[k].hidden = true;
      return;
    }

    /* NORD — capitale / fase Insediamento */
    const isCapital = !!(ORION.capital && ORION.capital.isCapital
      && ORION.game && planet && planet.systemId != null
      && ORION.capital.isCapital(ORION.game,
        planet.systemId + ':' + (planet.bodyKey || (this.body && this.body.key))));
    const inSettling = c.phase === 'settling' && c.settlingStart != null && c.settlingDuration > 0;
    const bN = this.badges.n;
    if (inSettling) {
      const now = ORION.game ? (ORION.game.timeImpulsi || 0) : 0;
      const elapsed = Math.max(0, now - c.settlingStart);
      const pct = Math.min(100, Math.round(100 * elapsed / c.settlingDuration));
      bN.hidden = false;
      bN.className = 'planet-overlay__badge planet-overlay__badge--settling';
      bN.innerHTML = '<span class="po-glyph">◌</span>' +
        '<span class="po-label">Insediamento</span>' +
        '<span class="po-value">' + pct + '%</span>';
    } else if (isCapital) {
      bN.hidden = false;
      bN.className = 'planet-overlay__badge planet-overlay__badge--capital';
      bN.innerHTML = '<span class="po-glyph">★</span>' +
        '<span class="po-label">Capitale</span>';
    } else {
      bN.hidden = true;
    }

    /* EST — scarsità (low/crit) */
    const bE = this.badges.e;
    const scar = this._readScarcity();
    if (scar) {
      bE.hidden = false;
      bE.className = 'planet-overlay__badge planet-overlay__badge--scar planet-overlay__badge--' + scar.state;
      bE.innerHTML = '<span class="po-glyph">⚠</span>' +
        '<span class="po-label">' + scar.label + '</span>' +
        '<span class="po-value">' + (scar.state === 'crit' ? 'Critico' : 'Scarso') + '</span>';
    } else {
      bE.hidden = true;
    }

    /* SUD — rifiuti (solo se la saturazione ≥ 0.4 — altrimenti il
       contesto non serve un badge dedicato, vivono già nella tab). */
    const bS = this.badges.s;
    let wasteShown = false;
    if (ORION.time && ORION.time.ensureWaste && ORION.time.wasteCapacity) {
      const w = ORION.time.ensureWaste(c);
      const cap = ORION.time.wasteCapacity(c) || 1;
      const sat = Math.max(0, (w.stock || 0) / cap);
      if (sat >= 0.4) {
        wasteShown = true;
        let cls = 'ok';
        let label = 'Rifiuti';
        if (sat >= 1) cls = 'crit';
        else if (sat >= 0.7) cls = 'warn';
        bS.hidden = false;
        bS.className = 'planet-overlay__badge planet-overlay__badge--waste planet-overlay__badge--' + cls;
        bS.innerHTML = '<span class="po-glyph">♻</span>' +
          '<span class="po-label">' + label + '</span>' +
          '<span class="po-value">' + Math.round(sat * 100) + '%</span>';
      }
    }
    if (!wasteShown) bS.hidden = true;

    /* OVEST — flotte in orbita nel sistema corrente */
    const bW = this.badges.w;
    const orbitN = this._countOrbitingFleets();
    if (orbitN > 0) {
      bW.hidden = false;
      bW.className = 'planet-overlay__badge planet-overlay__badge--fleet';
      bW.innerHTML = '<span class="po-glyph">⬢</span>' +
        '<span class="po-label">In orbita</span>' +
        '<span class="po-value">' + orbitN + '</span>';
    } else {
      bW.hidden = true;
    }
  };

  /* Restituisce {state:'low'|'crit', label} se cibo/acqua/energia/metalli
     sono in stato di scarsità, altrimenti null. Legge i flag già
     calcolati dal motore (decisione #22). */
  PlanetOverlay.prototype._readScarcity = function () {
    const c = this.colony;
    if (!c || !c._scar) return null;
    const order = ['food', 'water', 'en', 'met'];
    const labels = { food: 'Cibo', water: 'Acqua', en: 'Energia', met: 'Metalli' };
    let crit = null, low = null;
    for (let i = 0; i < order.length; i++) {
      const k = order[i];
      const st = c._scar[k];
      if (!st) continue;
      if (st.state === 'crit' && !crit) crit = { state: 'crit', label: labels[k] };
      else if (st.state === 'low' && !low) low = { state: 'low', label: labels[k] };
    }
    return crit || low;
  };

  /* Conteggio flotte (giocatore) in orbita nel sistema corrente. */
  PlanetOverlay.prototype._countOrbitingFleets = function () {
    if (!ORION.game || !ORION.game.fleets || !this.planet) return 0;
    const sysId = this.planet.systemId;
    if (sysId == null) return 0;
    let n = 0;
    const fleets = ORION.game.fleets;
    for (let i = 0; i < fleets.length; i++) {
      const f = fleets[i];
      if (!f || !f.location) continue;
      if (f.location.systemId === sysId && f.location.status === 'orbiting') n++;
    }
    return n;
  };

  /* Sync: chiamato a ogni render di planet-view. Riallinea l'svg al
     canvas e ricalcola le coordinate proiettate dei marker. CPU: una
     manciata di sin/cos per marker, niente DOM creation. */
  PlanetOverlay.prototype.sync = function () {
    if (!this.root || !this.host) return;
    const pv = ORION.planetView;
    if (!pv || !pv.getSphereGeometry) {
      this.root.style.display = 'none';
      return;
    }
    const g = pv.getSphereGeometry();
    if (!g.cssW || !g.cssH || !g.R) {
      this.root.style.display = 'none';
      return;
    }
    this.root.style.display = '';
    // dimensiona l'SVG al canvas
    this.svg.setAttribute('viewBox', '0 0 ' + g.cssW + ' ' + g.cssH);
    this.svg.style.width = g.cssW + 'px';
    this.svg.style.height = g.cssH + 'px';

    // anello orbitale (CSS gestisce la rotazione via animation)
    if (this.gOrbit) {
      this.gOrbit.innerHTML =
        '<ellipse class="po-orbit" cx="' + g.px.toFixed(1) + '" cy="' + g.py.toFixed(1) + '"' +
        ' rx="' + (g.R * 1.18).toFixed(1) + '" ry="' + (g.R * 0.34).toFixed(1) + '"' +
        ' transform="rotate(-14 ' + g.px.toFixed(1) + ' ' + g.py.toFixed(1) + ')"/>';
    }

    // riposiziona ogni marker
    const ld = g.lightDir;
    const nodes = this.gMarkers ? this.gMarkers.children : [];
    for (let i = 0; i < nodes.length && i < this.markerData.length; i++) {
      const m = this.markerData[i];
      const p = projectSphere(m.theta, m.phi, ld);
      const node = nodes[i];
      if (p.nz <= 0.05) {
        // dietro l'orizzonte → nascondi
        node.style.display = 'none';
        continue;
      }
      const x = g.px + p.nx * g.R * 0.92;  // 0.92 per stare leggermente "dentro" l'orizzonte
      const y = g.py + p.ny * g.R * 0.92;
      // attenua quando vicino al bordo (limb fade)
      const depth = Math.max(0, Math.min(1, p.nz));
      const opacity = 0.35 + 0.65 * depth;
      // più luminoso sul lato giorno, più "lampada notturna" sul lato notte
      const litFactor = (p.lit + 1) / 2; // 0..1
      node.style.display = '';
      node.setAttribute('transform', 'translate(' + x.toFixed(1) + ',' + y.toFixed(1) + ')');
      node.style.opacity = opacity.toFixed(2);
      // var CSS che il foglio stile usa per il glow
      node.style.setProperty('--pm-lit', litFactor.toFixed(2));
    }

    // posizione cardinali esterni alla sfera
    const off = Math.max(g.R * 1.26, g.R + 36);
    const place = (el, dx, dy) => {
      if (!el || el.hidden) return;
      // ancoraggio al centro badge: traslo del 50%
      el.style.left = (g.px + dx) + 'px';
      el.style.top = (g.py + dy) + 'px';
    };
    place(this.badges.n, 0, -off);
    place(this.badges.e, off, 0);
    place(this.badges.s, 0, off);
    place(this.badges.w, -off, 0);
  };

  PlanetOverlay.prototype.destroy = function () {
    if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
    this.host = null;
    this.root = null;
    this.svg = null;
    this.gMarkers = null;
    this.gOrbit = null;
    this.cardinalsBox = null;
    this.badges = {};
    this.markerData = [];
  };

  ORION.PlanetOverlay = PlanetOverlay;
  ORION.planetOverlay = null;

})(typeof window !== 'undefined' ? window : this);
