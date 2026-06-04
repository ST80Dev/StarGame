/* =====================================================================
   ORION EMPIRES — galaxy-map.js
   Modulo M02: mappa galattica su Canvas 2D (GDD §5.1) con
   NAVIGAZIONE GERARCHICA A ZOOM (decisione M02-nav):

     Galassia → Gruppo stellare → (Sistema → Pianeta: M03/M04)

   Resa "realistica" (decisione utente): niente alone uniforme su ogni
   nodo. Il colore viene da nebulose + polvere stellare di sfondo; le
   stelle decorative sono puntini netti con bloom/spicchi di diffrazione
   solo sulle più brillanti; i sistemi-gioco sono marker puliti con anello
   sottile per il pericolo.

   Reveal CONTINUO guidato dallo zoom: al livello Galassia si vedono le
   REGIONI (inviluppo morbido + nome); avvicinandosi (zoom o click su una
   regione) compaiono le singole STELLE-sistema del gruppo. Il livello
   "effettivo" e la selezione vengono notificati alla UI via onContext.

   Requisiti di sempre (decisione #6): Canvas responsivo (ResizeObserver +
   devicePixelRatio) e input unificato mouse/touch (Pointer Events).
   ===================================================================== */
'use strict';

(function (root) {
  const DISCOVERY = root.ORION.galaxy.DISCOVERY;

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(e0, e1, x) {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  }

  /* Colori per gruppo (accenti del tema, ciclici). */
  const GROUP_COLORS = [
    '#2fe6e0', '#8a6cff', '#ff9d3c', '#d6457f',
    '#ffb000', '#5cc8ff', '#9d7bff', '#ff6f5c'
  ];
  function groupColor(id) { return GROUP_COLORS[((id % GROUP_COLORS.length) + GROUP_COLORS.length) % GROUP_COLORS.length]; }

  /* Palette nebulose (allineata agli accenti del tema). */
  const NEBULA_COLORS = ['#2fe6e0', '#8a6cff', '#ff9d3c', '#d6457f', '#ffb000', '#5cc8ff'];

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  function starColor(galaxy, starId) {
    const t = galaxy.starTypes.find(function (s) { return s.id === starId; });
    return t ? t.color : '#ffffff';
  }

  class GalaxyMap {
    constructor() {
      this.canvas = null;
      this.ctx = null;
      this.container = null;
      this.galaxy = null;
      this.state = null;
      this.onContext = null;
      this.onActivateSystem = null;

      // viewport (trasformazione mondo->schermo)
      this.scale = 1;
      this.offsetX = 0;
      this.offsetY = 0;
      this.fitScale = 1; // scala base che fa entrare la galassia

      // navigazione gerarchica
      this.activeGroupId = -1; // gruppo "entrato" esplicitamente (-1 = nessuno)

      // dimensioni in pixel CSS
      this.cssW = 0;
      this.cssH = 0;
      this.dpr = 1;

      // interazione
      this.hoverSystem = -1;
      this.hoverGroup = -1;
      this.pointers = new Map();
      this.dragging = false;
      this.dragMoved = false;
      this.lastPinchDist = 0;

      // sfondo deterministico (nebulose + polvere), in spazio mondo
      this.nebulae = [];
      this.dust = [];
      this.brightStars = [];

      // animazione camera
      this._anim = false;
      this._tScale = 1; this._tox = 0; this._toy = 0;

      this._onResize = this.resize.bind(this);
      this._raf = 0;
      this._needsRender = false;
      this._ctxSig = '';
    }

    mount(container, galaxy, state, opts) {
      opts = opts || {};
      this.container = container;
      this.galaxy = galaxy;
      this.state = state;
      this.onContext = opts.onContext || null;
      this.onActivateSystem = opts.onActivateSystem || null;

      container.innerHTML = '';
      const canvas = document.createElement('canvas');
      canvas.className = 'galaxy-canvas';
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', 'Mappa galattica');
      canvas.style.touchAction = 'none';
      container.appendChild(canvas);

      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');

      this._buildBackdrop();
      this._bindEvents();

      if (typeof ResizeObserver !== 'undefined') {
        this._ro = new ResizeObserver(this._onResize);
        this._ro.observe(container);
      } else {
        window.addEventListener('resize', this._onResize);
      }

      this.resize();
      return this;
    }

    destroy() {
      if (this._ro) { this._ro.disconnect(); this._ro = null; }
      else window.removeEventListener('resize', this._onResize);
      if (this._raf) cancelAnimationFrame(this._raf);
      this._anim = false;
      if (this.canvas) this.canvas.replaceWith(this.canvas.cloneNode(false));
      this.canvas = null;
      this.ctx = null;
    }

    /* ---- Sfondo deterministico (dal seed): nebulose + polvere stellare ---- */
    _buildBackdrop() {
      const rng = root.ORION.rng.makeRng(this.galaxy.seed + ':backdrop');
      // nebulose: blob in spazio mondo, leggermente oltre i bordi
      this.nebulae = [];
      const nNeb = 14;
      for (let i = 0; i < nNeb; i++) {
        this.nebulae.push({
          x: rng.range(-0.1, 1.1),
          y: rng.range(-0.1, 1.1),
          r: rng.range(0.18, 0.46),
          color: rng.pick(NEBULA_COLORS),
          alpha: rng.range(0.05, 0.16)
        });
      }
      // polvere stellare decorativa: tanti puntini deboli (legge di potenza)
      this.dust = [];
      const nDust = 520;
      for (let i = 0; i < nDust; i++) {
        const m = Math.pow(rng.float(), 3);
        this.dust.push({
          x: rng.range(-0.08, 1.08),
          y: rng.range(-0.08, 1.08),
          size: 0.4 + m * 1.7,
          alpha: 0.2 + m * 0.7,
          warm: rng.chance(0.5)
        });
      }
      // poche stelle "eroe" con bloom + spicchi di diffrazione
      this.brightStars = [];
      for (let i = 0; i < 8; i++) {
        this.brightStars.push({
          x: rng.range(0.04, 0.96),
          y: rng.range(0.04, 0.96),
          len: 16 + rng.float() * 22,
          warm: rng.chance(0.4)
        });
      }
    }

    /* ---- Dimensioni / DPR ---- */
    resize() {
      if (!this.canvas || !this.container) return;
      const rect = this.container.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);

      const hadFit = this.cssW > 0;
      this.cssW = w;
      this.cssH = h;
      this.canvas.width = Math.round(w * this.dpr);
      this.canvas.height = Math.round(h * this.dpr);
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';

      const pad = 0.92;
      this.fitScale = Math.min(w, h) * pad;

      if (!hadFit) this.resetView();
      this.requestRender();
    }

    resetView() {
      this.scale = this.fitScale;
      this.offsetX = (this.cssW - this.scale) / 2;
      this.offsetY = (this.cssH - this.scale) / 2;
      this.requestRender();
    }

    /* ---- Trasformazioni mondo <-> schermo ---- */
    worldToScreen(wx, wy) {
      return { x: wx * this.scale + this.offsetX, y: wy * this.scale + this.offsetY };
    }
    screenToWorld(sx, sy) {
      return { x: (sx - this.offsetX) / this.scale, y: (sy - this.offsetY) / this.scale };
    }

    /* Quanto sono "rivelate" le singole stelle (0 = solo regioni, 1 = stelle).
       Transizione continua guidata dallo zoom; quando si è ENTRATI in un
       gruppo (click su regione / breadcrumb) le stelle sono piene. */
    nodeReveal() {
      if (this.activeGroupId >= 0) return 1;
      return smoothstep(1.5, 2.7, this.scale / this.fitScale);
    }

    nodeRadius() {
      return clamp(this.scale * 0.010, 2.6, 7);
    }

    /* Livello "effettivo" corrente, derivato da zoom/selezione. */
    effectiveLevel() {
      return this.nodeReveal() >= 0.5 ? 'group' : 'galaxy';
    }

    _groupNearestCenter() {
      const c = this.screenToWorld(this.cssW / 2, this.cssH / 2);
      const groups = this.galaxy.groups;
      let best = -1, bd = Infinity;
      for (let i = 0; i < groups.length; i++) {
        const dx = groups[i].cx - c.x, dy = groups[i].cy - c.y;
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = groups[i].id; }
      }
      return best;
    }

    _groupById(id) {
      const groups = this.galaxy.groups;
      for (let i = 0; i < groups.length; i++) if (groups[i].id === id) return groups[i];
      return null;
    }

    /* ---- Hit testing ---- */
    pickSystem(sx, sy) {
      const r = this.nodeRadius() + 7;
      const r2 = r * r;
      const sys = this.galaxy.systems;
      let best = -1, bestD = r2;
      for (let i = 0; i < sys.length; i++) {
        const p = this.worldToScreen(sys[i].x, sys[i].y);
        const dx = p.x - sx, dy = p.y - sy;
        const d = dx * dx + dy * dy;
        if (d <= bestD) { bestD = d; best = i; }
      }
      return best;
    }

    pickGroup(sx, sy) {
      const groups = this.galaxy.groups;
      let best = -1, bestD = Infinity;
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        const c = this.worldToScreen(g.cx, g.cy);
        const rad = Math.max(28, g.radius * this.scale + 18);
        const dx = c.x - sx, dy = c.y - sy;
        const d = dx * dx + dy * dy;
        if (d <= rad * rad && d < bestD) { bestD = d; best = g.id; }
      }
      return best;
    }

    /* ---- Eventi (Pointer Events unificati) ---- */
    _bindEvents() {
      const c = this.canvas;
      c.addEventListener('pointerdown', this._onPointerDown.bind(this));
      c.addEventListener('pointermove', this._onPointerMove.bind(this));
      c.addEventListener('pointerup', this._onPointerUp.bind(this));
      c.addEventListener('pointercancel', this._onPointerUp.bind(this));
      c.addEventListener('pointerleave', this._onPointerLeave.bind(this));
      c.addEventListener('wheel', this._onWheel.bind(this), { passive: false });
      c.addEventListener('dblclick', this._onDblClick.bind(this));
    }

    _localPos(e) {
      const rect = this.canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    _onPointerDown(e) {
      this.canvas.setPointerCapture(e.pointerId);
      const p = this._localPos(e);
      this.pointers.set(e.pointerId, p);
      this.dragging = true;
      this.dragMoved = false;
      this._anim = false; // un'interazione interrompe l'animazione camera
      if (this.pointers.size === 2) this.lastPinchDist = this._pinchDist();
    }

    _onPointerMove(e) {
      const p = this._localPos(e);

      if (!this.pointers.has(e.pointerId)) {
        // hover
        let hs = -1, hg = -1;
        if (this.nodeReveal() >= 0.5) hs = this.pickSystem(p.x, p.y);
        else hg = this.pickGroup(p.x, p.y);
        if (hs !== this.hoverSystem || hg !== this.hoverGroup) {
          this.hoverSystem = hs; this.hoverGroup = hg;
          this.canvas.style.cursor = (hs >= 0 || hg >= 0) ? 'pointer' : 'grab';
          this.requestRender();
        }
        return;
      }

      const prev = this.pointers.get(e.pointerId);
      this.pointers.set(e.pointerId, p);

      if (this.pointers.size === 2) {
        const d = this._pinchDist();
        if (this.lastPinchDist > 0) {
          const center = this._pinchCenter();
          this._zoomAt(center.x, center.y, d / this.lastPinchDist);
        }
        this.lastPinchDist = d;
        this.dragMoved = true;
        return;
      }

      const dx = p.x - prev.x, dy = p.y - prev.y;
      if (Math.abs(dx) + Math.abs(dy) > 1) this.dragMoved = true;
      this.offsetX += dx;
      this.offsetY += dy;
      this.requestRender();
    }

    _onPointerUp(e) {
      const p = this._localPos(e);
      const wasDrag = this.dragMoved;
      this.pointers.delete(e.pointerId);
      if (this.canvas.hasPointerCapture && this.canvas.hasPointerCapture(e.pointerId)) {
        this.canvas.releasePointerCapture(e.pointerId);
      }
      if (this.pointers.size < 2) this.lastPinchDist = 0;
      if (this.pointers.size === 0) this.dragging = false;

      if (!wasDrag && e.pointerType !== undefined) this._handleClick(p.x, p.y);
    }

    _handleClick(sx, sy) {
      if (this.nodeReveal() >= 0.5) {
        // livello gruppo: seleziona un sistema
        const id = this.pickSystem(sx, sy);
        if (id >= 0) { this.selectSystem(id); return; }
      } else {
        // livello galassia: entra in una regione
        const gid = this.pickGroup(sx, sy);
        if (gid >= 0) { this.focusGroup(gid); return; }
      }
    }

    _onPointerLeave() {
      if (this.hoverSystem !== -1 || this.hoverGroup !== -1) {
        this.hoverSystem = -1; this.hoverGroup = -1;
        this.requestRender();
      }
      this.canvas.style.cursor = 'grab';
    }

    _onWheel(e) {
      e.preventDefault();
      this._anim = false;
      const p = this._localPos(e);
      const factor = Math.pow(1.0015, -e.deltaY);
      this._zoomAt(p.x, p.y, factor);
    }

    _onDblClick(e) {
      e.preventDefault();
      const p = this._localPos(e);
      if (this.nodeReveal() >= 0.5) {
        const id = this.pickSystem(p.x, p.y);
        if (id >= 0) {
          this.selectSystem(id);
          if (this.onActivateSystem) this.onActivateSystem(id); // → Sistema (M03)
          return;
        }
        // doppio click nel vuoto al livello gruppo: torna alla galassia
        this.focusGalaxy();
      } else {
        const gid = this.pickGroup(p.x, p.y);
        if (gid >= 0) this.focusGroup(gid);
        else this.focusGalaxy();
      }
    }

    _zoomAt(sx, sy, factor) {
      const minScale = this.fitScale * 0.6;
      const maxScale = this.fitScale * 9;
      const newScale = clamp(this.scale * factor, minScale, maxScale);
      const k = newScale / this.scale;
      this.offsetX = sx - (sx - this.offsetX) * k;
      this.offsetY = sy - (sy - this.offsetY) * k;
      this.scale = newScale;
      // zoom-out marcato: esci dal gruppo "entrato" (torni alla galassia)
      if (this.scale < this.fitScale * 1.5) this.activeGroupId = -1;
      this.requestRender();
    }

    _pinchDist() {
      const pts = Array.from(this.pointers.values());
      const dx = pts[0].x - pts[1].x, dy = pts[0].y - pts[1].y;
      return Math.sqrt(dx * dx + dy * dy);
    }
    _pinchCenter() {
      const pts = Array.from(this.pointers.values());
      return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    }

    /* ---- Camera animata verso un riquadro-mondo ---- */
    _cameraForBounds(minX, minY, maxX, maxY, fill, minS) {
      const w = Math.max(maxX - minX, 0.05), h = Math.max(maxY - minY, 0.05);
      let s = Math.min(this.cssW / w, this.cssH / h) * (fill || 0.62);
      s = clamp(s, minS || this.fitScale * 0.6, this.fitScale * 9);
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      return { s: s, ox: this.cssW / 2 - cx * s, oy: this.cssH / 2 - cy * s };
    }

    _animateTo(s, ox, oy) {
      this._tScale = s; this._tox = ox; this._toy = oy;
      if (!this._anim) { this._anim = true; this._animTick(); }
    }

    _animTick() {
      if (!this._anim || !this.ctx) return;
      const k = 0.2;
      this.scale = lerp(this.scale, this._tScale, k);
      this.offsetX = lerp(this.offsetX, this._tox, k);
      this.offsetY = lerp(this.offsetY, this._toy, k);
      const done = Math.abs(this.scale - this._tScale) < this._tScale * 0.002 &&
        Math.abs(this.offsetX - this._tox) < 0.5 && Math.abs(this.offsetY - this._toy) < 0.5;
      if (done) { this.scale = this._tScale; this.offsetX = this._tox; this.offsetY = this._toy; this._anim = false; }
      this.render();
      if (this._anim) requestAnimationFrame(this._animTick.bind(this));
    }

    /* ---- API di navigazione (usate anche dalla breadcrumb) ---- */
    focusGalaxy() {
      this.activeGroupId = -1;
      this.state.selectedId = -1;
      this._animateTo(this.fitScale, (this.cssW - this.fitScale) / 2, (this.cssH - this.fitScale) / 2);
      this._emitContext(true);
    }

    focusGroup(id) {
      const g = this._groupById(id);
      if (!g) return;
      this.activeGroupId = id;
      // entrando in una regione mostriamo il pannello del gruppo, non
      // l'eventuale sistema selezionato in precedenza
      if (this.state.selectedId >= 0 && this.galaxy.systems[this.state.selectedId].cluster !== id) {
        this.state.selectedId = -1;
      }
      const pad = 0.03;
      // garantisci uno zoom-in oltre lo scuro della galassia (min 1.8× fit)
      const cam = this._cameraForBounds(g.minX - pad, g.minY - pad, g.maxX + pad, g.maxY + pad, 0.62, this.fitScale * 1.8);
      this._animateTo(cam.s, cam.ox, cam.oy);
      this._emitContext(true);
    }

    focusSystem(id) {
      const s = this.galaxy.systems[id];
      if (!s) return;
      this.activeGroupId = s.cluster;
      const span = 0.16;
      const cam = this._cameraForBounds(s.x - span, s.y - span, s.x + span, s.y + span, 0.8);
      this._animateTo(cam.s, cam.ox, cam.oy);
    }

    selectSystem(id) {
      this.state.selectedId = id;
      this.activeGroupId = this.galaxy.systems[id].cluster;
      this.requestRender();
      this._emitContext(true);
    }

    /* ---- Notifica del contesto alla UI (livello/gruppo/sistema) ---- */
    _emitContext(force) {
      if (!this.onContext) return;
      const level = this.effectiveLevel();
      let groupId = this.activeGroupId;
      if (groupId < 0 && level === 'group') groupId = this._groupNearestCenter();
      // riporta il sistema selezionato solo se appartiene al gruppo in contesto
      let systemId = -1;
      if (level === 'group' && this.state.selectedId >= 0 &&
        this.galaxy.systems[this.state.selectedId].cluster === groupId) {
        systemId = this.state.selectedId;
      }
      const sig = level + ':' + groupId + ':' + systemId;
      if (!force && sig === this._ctxSig) return;
      this._ctxSig = sig;
      this.onContext({ level: level, groupId: groupId, systemId: systemId });
    }

    /* ---- Render (on-demand) ---- */
    requestRender() {
      if (this._needsRender) return;
      this._needsRender = true;
      this._raf = requestAnimationFrame(this.render.bind(this));
    }

    render() {
      this._needsRender = false;
      const ctx = this.ctx;
      if (!ctx) return;

      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.cssW, this.cssH);

      this._drawNebulae(ctx);
      this._drawDust(ctx);

      const reveal = this.nodeReveal();
      const regionAlpha = 1 - smoothstep(0.2, 0.85, reveal); // svaniscono quando entri

      if (regionAlpha > 0.01) this._drawRegions(ctx, regionAlpha);
      if (reveal > 0.01) {
        this._drawEdges(ctx, reveal);
        this._drawNodes(ctx, reveal);
      }

      this._emitContext(false);
    }

    /* Nebulose: blob morbidi in spazio mondo (additivi). */
    _drawNebulae(ctx) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < this.nebulae.length; i++) {
        const n = this.nebulae[i];
        const c = this.worldToScreen(n.x, n.y);
        const rad = n.r * this.scale;
        if (c.x + rad < 0 || c.x - rad > this.cssW || c.y + rad < 0 || c.y - rad > this.cssH) continue;
        const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, rad);
        g.addColorStop(0, hexA(n.color, n.alpha));
        g.addColorStop(0.5, hexA(n.color, n.alpha * 0.35));
        g.addColorStop(1, hexA(n.color, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(c.x, c.y, rad, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    /* Polvere stellare decorativa: puntini netti + poche stelle brillanti. */
    _drawDust(ctx) {
      for (let i = 0; i < this.dust.length; i++) {
        const d = this.dust[i];
        const p = this.worldToScreen(d.x, d.y);
        if (p.x < 0 || p.x > this.cssW || p.y < 0 || p.y > this.cssH) continue;
        ctx.fillStyle = d.warm ? hexA('#ffe6b0', d.alpha) : hexA('#cfe0ff', d.alpha);
        ctx.fillRect(p.x, p.y, d.size, d.size);
      }
      for (let i = 0; i < this.brightStars.length; i++) {
        const b = this.brightStars[i];
        const p = this.worldToScreen(b.x, b.y);
        if (p.x < -40 || p.x > this.cssW + 40 || p.y < -40 || p.y > this.cssH + 40) continue;
        const col = b.warm ? '#ffe6b0' : '#dfeaff';
        this._spike(ctx, p.x, p.y, b.len, col, 0.5);
        const bg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 7);
        bg.addColorStop(0, hexA(col, 0.85));
        bg.addColorStop(0.4, hexA(col, 0.22));
        bg.addColorStop(1, hexA(col, 0));
        ctx.fillStyle = bg;
        ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.beginPath(); ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2); ctx.fill();
      }
    }

    _spike(ctx, x, y, len, col, a) {
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      ctx.lineWidth = 1;
      for (let i = 0; i < dirs.length; i++) {
        const gx = x + dirs[i][0] * len, gy = y + dirs[i][1] * len;
        const g = ctx.createLinearGradient(x, y, gx, gy);
        g.addColorStop(0, hexA(col, a));
        g.addColorStop(1, hexA(col, 0));
        ctx.strokeStyle = g;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(gx, gy); ctx.stroke();
      }
    }

    /* Regioni: inviluppo morbido + alone tenue + etichetta col nome. */
    _drawRegions(ctx, alpha) {
      const groups = this.galaxy.groups;
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        const col = groupColor(g.id);
        const isActive = g.id === this.activeGroupId;
        const isHome = g.id === this.galaxy.homeGroupId;
        const isHover = g.id === this.hoverGroup;
        const c = this.worldToScreen(g.cx, g.cy);
        const rad = Math.max(36, g.radius * this.scale * 1.25);

        // alone tenue
        const glow = ctx.createRadialGradient(c.x, c.y, rad * 0.2, c.x, c.y, rad);
        glow.addColorStop(0, hexA(col, 0.12 * alpha));
        glow.addColorStop(1, hexA(col, 0));
        ctx.fillStyle = glow;
        ctx.beginPath(); ctx.arc(c.x, c.y, rad, 0, Math.PI * 2); ctx.fill();

        // contorno inviluppo (convex hull) — punteggiato
        if (g.hull && g.hull.length >= 3) {
          ctx.save();
          ctx.setLineDash([4, 5]);
          ctx.lineWidth = isActive || isHover ? 1.6 : 1;
          ctx.strokeStyle = hexA(col, (isActive || isHover ? 0.5 : 0.28) * alpha);
          ctx.beginPath();
          for (let h = 0; h < g.hull.length; h++) {
            const hp = this.worldToScreen(g.hull[h].x, g.hull[h].y);
            if (h === 0) ctx.moveTo(hp.x, hp.y); else ctx.lineTo(hp.x, hp.y);
          }
          ctx.closePath(); ctx.stroke();
          ctx.restore();
        }

        // etichetta regione
        ctx.font = '600 13px "JetBrains Mono", ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.85)';
        ctx.shadowBlur = 4;
        ctx.fillStyle = hexA(isActive || isHover ? '#ffffff' : col, (isActive || isHover ? 0.95 : 0.7) * alpha);
        ctx.fillText((isHome ? '★ ' : '') + g.name.toUpperCase(), c.x, c.y);
        ctx.shadowBlur = 0;

        // contatore sistemi sotto il nome
        ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
        ctx.fillStyle = hexA('#9aa6cc', 0.7 * alpha);
        ctx.fillText(g.members.length + ' sistemi', c.x, c.y + 16);
      }
    }

    _drawEdges(ctx, reveal) {
      const g = this.galaxy;
      const disc = this.state.discovery;
      ctx.lineWidth = 1;
      for (let i = 0; i < g.edges.length; i++) {
        const e = g.edges[i];
        const da = disc[e.a], db = disc[e.b];
        if (da === DISCOVERY.UNKNOWN && db === DISCOVERY.UNKNOWN) continue;
        const known = da >= DISCOVERY.DETECTED && db >= DISCOVERY.DETECTED;
        const a = this.worldToScreen(g.systems[e.a].x, g.systems[e.a].y);
        const b = this.worldToScreen(g.systems[e.b].x, g.systems[e.b].y);
        ctx.strokeStyle = known
          ? 'rgba(86,122,220,' + (0.40 * reveal) + ')'
          : 'rgba(86,122,220,' + (0.14 * reveal) + ')';
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }

    _drawNodes(ctx, reveal) {
      const g = this.galaxy;
      const disc = this.state.discovery;
      const r = this.nodeRadius();
      const showLabels = reveal > 0.7;
      ctx.globalAlpha = reveal;

      for (let i = 0; i < g.systems.length; i++) {
        const s = g.systems[i];
        const p = this.worldToScreen(s.x, s.y);
        if (p.x < -30 || p.x > this.cssW + 30 || p.y < -30 || p.y > this.cssH + 30) continue;

        const d = disc[i];
        const isHome = i === g.homeId;
        const isSel = i === this.state.selectedId;
        const isHover = i === this.hoverSystem;

        if (d === DISCOVERY.UNKNOWN) {
          // nebbia di guerra: posizione approssimativa, marker tenue
          ctx.fillStyle = 'rgba(120,134,180,0.40)';
          ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(1.6, r * 0.5), 0, Math.PI * 2); ctx.fill();
          if (isSel || isHover) this._ring(ctx, p, r + 4, 'rgba(154,166,204,0.6)');
          continue;
        }

        // anello sottile di pericolo (§5.3) — niente alone sfocato
        const dcol = this._dangerColor(s.danger);
        this._ring(ctx, p, r + 2.5, dcol, 1);

        // corpo della stella (colore = tipo)
        const col = starColor(g, s.star);
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = col; ctx.fill();

        // sistemi solo "rilevati" leggermente smorzati
        if (d === DISCOVERY.DETECTED) {
          ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(6,9,22,0.4)'; ctx.fill();
        }

        // home: doppio anello pulito; selezione: reticolo; hover: anello chiaro
        if (isHome) { this._ring(ctx, p, r + 5, '#2fe6e0', 1.5); this._ring(ctx, p, r + 8.5, 'rgba(47,230,224,0.5)', 1); }
        if (isSel) this._reticle(ctx, p, r + 7, '#ff9d3c');
        else if (isHover) this._ring(ctx, p, r + 6, 'rgba(216,226,255,0.85)', 1.5);

        if (d >= DISCOVERY.DETECTED && (showLabels || isHome || isSel || isHover)) {
          this._label(ctx, p, s.name, r, isSel || isHover || isHome);
        }
      }
      ctx.globalAlpha = 1;
    }

    _ring(ctx, p, radius, color, width) {
      ctx.beginPath(); ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = color; ctx.lineWidth = width || 1.5; ctx.stroke();
    }

    /* Reticolo di selezione: 4 archi separati (look "strumento"). */
    _reticle(ctx, p, radius, color) {
      ctx.strokeStyle = color; ctx.lineWidth = 1.6;
      for (let q = 0; q < 4; q++) {
        const a0 = q * Math.PI / 2 + 0.35;
        ctx.beginPath(); ctx.arc(p.x, p.y, radius, a0, a0 + 0.9); ctx.stroke();
      }
    }

    _label(ctx, p, text, r, strong) {
      ctx.font = (strong ? '600 ' : '') + '11px "JetBrains Mono", ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const y = p.y + r + 4;
      ctx.fillStyle = strong ? 'rgba(216,226,255,0.95)' : 'rgba(154,166,204,0.75)';
      ctx.shadowColor = 'rgba(0,0,0,0.8)';
      ctx.shadowBlur = 3;
      ctx.fillText(text, p.x, y);
      ctx.shadowBlur = 0;
    }

    _dangerColor(d) {
      if (d <= 25) return 'rgba(79,224,138,0.7)';
      if (d <= 50) return 'rgba(255,202,85,0.7)';
      if (d <= 75) return 'rgba(255,157,60,0.75)';
      return 'rgba(255,92,108,0.8)';
    }
  }

  root.ORION = root.ORION || {};
  root.ORION.GalaxyMap = GalaxyMap;
})(typeof window !== 'undefined' ? window : this);
