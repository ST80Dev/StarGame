/* =====================================================================
   ORION EMPIRES — system-view.js
   Modulo M03: vista interna del sistema stellare su Canvas 2D (GDD §6).

   È il livello "Sistema" della navigazione gerarchica (§5.5, decisione
   #9): stella/e al centro (incluse le binarie, §6.1), corpi celesti in
   orbita resi come DISCHI PROCEDURALI (bande, mottling, calotte, bordo
   atmosfera, terminatore), orbite sottili. Niente alone uniforme
   (direzione "NASA/Visions", decisione #8).

   Requisiti di sempre (decisione #6): Canvas responsivo (ResizeObserver +
   devicePixelRatio) e input unificato mouse/touch (Pointer Events).
   Render ON-DEMAND: i corpi sono in posizioni statiche deterministiche
   dal seed (scelta utente M03), nessun loop continuo.

   Nebbia di guerra (§5.1, scelta utente M03 "fedele"):
     EXPLORED → interno completo (corpi, dettagli, anomalie)
     DETECTED → stella + orbite, corpi come sagome "da scansionare"
     UNKNOWN  → schermo bloccato (richiede esplorazione, M07)
   ===================================================================== */
'use strict';

(function (root) {
  const makeRng = root.ORION.rng.makeRng;
  const DISCOVERY = root.ORION.galaxy.DISCOVERY;
  const BODY_TYPES = root.ORION.system.BODY_TYPES;
  const GAS_VARIANTS = root.ORION.system.GAS_VARIANTS;

  const clamp = root.ORION.util.clamp;
  const lerp = root.ORION.util.lerp;

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  /* Schiarisce/scurisce un colore esadecimale di un fattore d ∈ [-1,1]. */
  function shade(hex, d) {
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    if (d >= 0) { r += (255 - r) * d; g += (255 - g) * d; b += (255 - b) * d; }
    else { r += r * d; g += g * d; b += b * d; }
    return 'rgb(' + Math.round(r) + ',' + Math.round(g) + ',' + Math.round(b) + ')';
  }

  class SystemView {
    constructor() {
      this.canvas = null;
      this.ctx = null;
      this.container = null;
      this.system = null;
      this.discovery = DISCOVERY.UNKNOWN;
      this.onSelectBody = null;
      this.onActivateBody = null;
      this.onExit = null;
      this.onFleetClick = null;        // click su marker flotta (vista sistema)
      this._fleetHit = [];             // posizioni marker flotta per l'hit-test
      this.onAiFleetClick = null;      // click su marker flotta AI rilevata
      this._aiFleetHit = [];           // posizioni marker flotta AI per l'hit-test
      this._navCdUntil = 0;            // decisione #80: cooldown tra livelli

      this.scale = 1;
      this.offsetX = 0;
      this.offsetY = 0;
      this.fitScale = 1;

      this.cssW = 0; this.cssH = 0; this.dpr = 1;

      this.hoverKey = null;
      this.selectedKey = null;

      this.pointers = new Map();
      this.dragging = false;
      this.dragMoved = false;
      this.lastPinchDist = 0;

      this.dust = [];

      this._anim = false;
      this._tScale = 1; this._tox = 0; this._toy = 0;

      this._onResize = this.resize.bind(this);
      this._raf = 0;
      this._needsRender = false;

      /* Cinematiche (Fase 1): coda di effetti transitori disegnati sopra la
         scena, mossi da un rAF temporaneo che si autospegne (come _animTick →
         coerente con "render on-demand, niente loop continuo"). */
      this._fx = [];
      this._fxRaf = 0;
      this._fleetPos = {};   // ultima posizione schermo nota per marker flotta
    }

    mount(container, system, opts) {
      opts = opts || {};
      this.container = container;
      this.system = system;
      this.discovery = opts.discovery == null ? DISCOVERY.UNKNOWN : opts.discovery;
      this.onSelectBody = opts.onSelectBody || null;
      this.onActivateBody = opts.onActivateBody || null;
      this.onExit = opts.onExit || null;
      this.onFleetClick = opts.onFleetClick || null;
      this.onAiFleetClick = opts.onAiFleetClick || null;

      container.innerHTML = '';
      const canvas = document.createElement('canvas');
      canvas.className = 'system-canvas';
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', 'Vista del sistema ' + system.name);
      canvas.style.touchAction = 'none';
      container.appendChild(canvas);

      var tip = document.createElement('div');
      tip.className = 'sysview-tooltip';
      tip.style.display = 'none';
      container.appendChild(tip);
      this._tooltip = tip;
      this._chipHits = [];

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
      if (this._fxRaf) cancelAnimationFrame(this._fxRaf);
      this._fxRaf = 0; this._fx = [];
      this._anim = false;
      if (this._tooltip) { this._tooltip.remove(); this._tooltip = null; }
      if (this.canvas) this.canvas.replaceWith(this.canvas.cloneNode(false));
      this.canvas = null;
      this.ctx = null;
    }

    revealed() { return this.discovery >= DISCOVERY.EXPLORED; }
    detected() { return this.discovery >= DISCOVERY.DETECTED; }

    /* Polvere stellare di sfondo, deterministica dal seed del sistema
       (più rada e sobria della mappa galassia). */
    _buildBackdrop() {
      const rng = makeRng(this.system.seedBase + ':bg');
      this.dust = [];
      const n = 240;
      for (let i = 0; i < n; i++) {
        const m = Math.pow(rng.float(), 3);
        this.dust.push({
          x: rng.range(-1.25, 1.25),   // spazio-mondo centrato sulla stella
          y: rng.range(-1.25, 1.25),
          size: 0.4 + m * 1.4,
          alpha: 0.12 + m * 0.5,
          warm: rng.chance(0.4)
        });
      }
    }

    resize() {
      if (!this.canvas || !this.container) return;
      const rect = this.container.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);

      const hadFit = this.cssW > 0;
      this.cssW = w; this.cssH = h;
      this.canvas.width = Math.round(w * this.dpr);
      this.canvas.height = Math.round(h * this.dpr);
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';

      // l'orbita massima (≈1) deve entrare con margine
      this.fitScale = Math.min(w, h) * 0.46;
      if (!hadFit) this.resetView();
      this.requestRender();
    }

    resetView() {
      this.scale = this.fitScale;
      this.offsetX = this.cssW / 2;
      this.offsetY = this.cssH / 2;
      this.requestRender();
    }

    /* Mondo centrato sulla stella (0,0). screen = world*scale + offset. */
    worldToScreen(wx, wy) {
      return { x: wx * this.scale + this.offsetX, y: wy * this.scale + this.offsetY };
    }
    screenToWorld(sx, sy) {
      return { x: (sx - this.offsetX) / this.scale, y: (sy - this.offsetY) / this.scale };
    }

    /* Posizione-mondo di un corpo (gestisce le lune relative al pianeta). */
    bodyWorldPos(body) {
      if (body.parentKey) {
        const parent = this._parentOf(body);
        const p = parent ? this.bodyWorldPos(parent) : { x: 0, y: 0 };
        return { x: p.x + Math.cos(body.angle) * body.moonOrbit, y: p.y + Math.sin(body.angle) * body.moonOrbit };
      }
      return { x: Math.cos(body.angle) * body.orbit, y: Math.sin(body.angle) * body.orbit };
    }

    _parentOf(moon) {
      const bs = this.system.bodies;
      for (let i = 0; i < bs.length; i++) if (bs[i].key === moon.parentKey) return bs[i];
      return null;
    }

    /* ---- Hit testing ---- */
    pickBody(sx, sy) {
      if (!this.revealed()) return null;
      const bs = this.system.bodies;
      let best = null, bestD = Infinity;
      const consider = (body) => {
        const def = BODY_TYPES[body.type];
        if (def.cat === 'belt') {
          // selezione per prossimità all'anello
          const c = this.worldToScreen(0, 0);
          const dr = Math.sqrt((sx - c.x) * (sx - c.x) + (sy - c.y) * (sy - c.y));
          const ringR = body.orbit * this.scale;
          const tol = body.beltWidth * this.scale * 0.5 + 7;
          const d = Math.abs(dr - ringR);
          if (d <= tol && d < bestD) { bestD = d; best = body.key; }
          return;
        }
        const w = this.bodyWorldPos(body);
        const p = this.worldToScreen(w.x, w.y);
        const r = Math.max(this._screenRadius(body), 6) + 6;
        const dx = p.x - sx, dy = p.y - sy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d <= r && d < bestD) { bestD = d; best = body.key; }
      };
      for (let i = 0; i < bs.length; i++) {
        consider(bs[i]);
        for (let m = 0; m < bs[i].moons.length; m++) consider(bs[i].moons[m]);
      }
      return best;
    }

    _screenRadius(body) { return (body.radius || 0) * this.scale; }

    /* ---- Eventi (Pointer Events unificati, come GalaxyMap) ---- */
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
      this._anim = false;
      if (this.pointers.size === 2) this.lastPinchDist = this._pinchDist();
    }

    _onPointerMove(e) {
      const p = this._localPos(e);
      if (!this.pointers.has(e.pointerId)) {
        const hk = this.pickBody(p.x, p.y);
        if (hk !== this.hoverKey) {
          this.hoverKey = hk;
          this.canvas.style.cursor = hk ? 'pointer' : 'grab';
          this.requestRender();
        }
        this._updateChipTooltip(p);
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
      this.offsetX += dx; this.offsetY += dy;
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
      if (!wasDrag) {
        /* Click su un marker flotta → popup info (come sulla mappa galassia).
           Ha priorità sulla selezione del corpo. */
        const fid = this.pickFleet(p.x, p.y);
        if (fid != null && this.onFleetClick) { this.onFleetClick(fid, e.clientX, e.clientY); return; }
        /* Click su un marker flotta AI rilevata → dossier contatto. */
        const aid = this.pickAiFleet(p.x, p.y);
        if (aid != null && this.onAiFleetClick) { this.onAiFleetClick(aid, e.clientX, e.clientY); return; }
        this._handleClick(p.x, p.y);
      }
    }

    /* Hit-test dei marker flotta (posizioni memorizzate in _drawFleets).
       Raggio di hit derivato dalla dimensione corrente del marker (auto-zoom,
       decisione 2026-06-20) + margine fisso, così cliccare resta affidabile
       a qualunque livello di zoom. */
    pickFleet(sx, sy) {
      const hits = this._fleetHit || [];
      let best = null, bestD = Infinity;
      for (let i = 0; i < hits.length; i++) {
        const dx = hits[i].x - sx, dy = hits[i].y - sy;
        const d = dx * dx + dy * dy;
        const hr = (hits[i].r || 7) + 6;   // marker + alone di tolleranza
        if (d < hr * hr && d < bestD) { bestD = d; best = hits[i].id; }
      }
      return best;
    }
    /* Hit-test dei marker flotta AI (posizioni memorizzate in _drawAiFleets). */
    pickAiFleet(sx, sy) {
      const hits = this._aiFleetHit || [];
      let best = null, bestD = Infinity;
      for (let i = 0; i < hits.length; i++) {
        const dx = hits[i].x - sx, dy = hits[i].y - sy;
        const d = dx * dx + dy * dy;
        const hr = (hits[i].r || 8) + 6;
        if (d < hr * hr && d < bestD) { bestD = d; best = hits[i].id; }
      }
      return best;
    }

    _handleClick(sx, sy) {
      const key = this.pickBody(sx, sy);
      this.selectBody(key); // key === null deseleziona
    }

    _onPointerLeave() {
      if (this.hoverKey !== null) { this.hoverKey = null; this.requestRender(); }
      if (this._tooltip) this._tooltip.style.display = 'none';
      this.canvas.style.cursor = 'grab';
    }

    _onWheel(e) {
      e.preventDefault();
      this._anim = false;
      const p = this._localPos(e);
      this._zoomAt(p.x, p.y, Math.pow(1.0015, -e.deltaY));
    }

    _onDblClick(e) {
      e.preventDefault();
      const p = this._localPos(e);
      const key = this.pickBody(p.x, p.y);
      if (key) {
        if (this.onActivateBody) { this.selectBody(key); this.onActivateBody(key); }
        else this._frameBody(key);
        return;
      }
      // doppio click nel vuoto: esci verso la galassia
      if (this.onExit) this.onExit();
    }

    /* decisione #80 — corpo apribile più vicino al centro schermo (salta le
       cinture: non hanno vista pianeta). Soglia di distanza per non scendere
       se al centro non c'è nulla di inquadrato. */
    _bodyNearestCenter() {
      if (!this.revealed()) return null;
      const bs = this.system.bodies;
      const cx = this.cssW / 2, cy = this.cssH / 2;
      let best = null, bd = Infinity;
      for (let i = 0; i < bs.length; i++) {
        const b = bs[i];
        const def = BODY_TYPES[b.type];
        if (def && def.cat === 'belt') continue;
        const w = this.bodyWorldPos(b);
        const p = this.worldToScreen(w.x, w.y);
        const dx = p.x - cx, dy = p.y - cy, d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = b.key; }
      }
      const lim = Math.min(this.cssW, this.cssH) * 0.40;
      return bd <= lim * lim ? best : null;
    }

    _navReady() { return this._now() >= this._navCdUntil; }
    _armNavCd() { this._navCdUntil = this._now() + 450; }
    _now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

    _zoomAt(sx, sy, factor) {
      /* Feedback 2026-06-19: l'uscita verso il gruppo scattava troppo tardi
         (vista-sistema con molto margine vuoto) → soglia d'uscita alzata
         0.55×→0.75×: la transizione parte prima, salto meno marcato. */
      const minScale = this.fitScale * 0.75;
      const maxScale = this.fitScale * 14;
      /* decisione #80 — navigazione a zoom: contro il muro IN → scendi nel
         pianeta centrato; contro il muro OUT → risali alla galassia. */
      if (this._navReady()) {
        if (factor > 1 && this.scale >= maxScale - 1e-3 && this.onActivateBody) {
          const key = this._bodyNearestCenter();
          if (key) {
            this._armNavCd();
            // lascia margine sotto al max così, tornando dal pianeta, non si
            // ridiscende subito (anti-rimbalzo sulla giuntura).
            this.scale = maxScale * 0.78;
            this.selectBody(key);
            this.onActivateBody(key);
            return;
          }
        }
        if (factor < 1 && this.scale <= minScale + 1e-3 && this.onExit) {
          this._armNavCd();
          this.onExit();
          return;
        }
      }
      const newScale = clamp(this.scale * factor, minScale, maxScale);
      const k = newScale / this.scale;
      this.offsetX = sx - (sx - this.offsetX) * k;
      this.offsetY = sy - (sy - this.offsetY) * k;
      this.scale = newScale;
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

    _frameBody(key) {
      const body = root.ORION.system.findBody(this.system, key);
      if (!body) return;
      const w = this.bodyWorldPos(body);
      const r = Math.max(body.radius || body.moonOrbit || 0.05, 0.06);
      const s = clamp(Math.min(this.cssW, this.cssH) * 0.32 / r, this.fitScale * 0.55, this.fitScale * 14);
      this._animateTo(s, this.cssW / 2 - w.x * s, this.cssH / 2 - w.y * s);
      this.selectBody(key);
    }

    /* ---- Camera animata (riuso del pattern GalaxyMap) ---- */
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

    /* ---- API pubbliche ---- */
    selectBody(key) {
      if (key === this.selectedKey) { this.requestRender(); return; }
      this.selectedKey = key;
      this.requestRender();
      if (this.onSelectBody) this.onSelectBody(key);
    }
    focusBody(key) { this._frameBody(key); }

    /* ---- Render ---- */
    requestRender() {
      if (this._needsRender) return;
      this._needsRender = true;
      this._raf = requestAnimationFrame(this.render.bind(this));
    }

    render() {
      this._needsRender = false;
      const ctx = this.ctx;
      if (!ctx) return;
      this._chipHits = [];
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.cssW, this.cssH);

      this._drawDust(ctx);

      if (!this.detected()) { this._drawLocked(ctx); this._drawFx(ctx); return; }

      const star = this.worldToScreen(0, 0);
      this._drawOrbits(ctx, star);
      if (this.revealed()) this._drawAnomalyFields(ctx);
      this._drawStars(ctx, star);
      this._drawBodies(ctx, star);
      if (this.revealed()) this._drawAnomalyMarkers(ctx);
      this._drawFleets(ctx);
      this._drawAiFleets(ctx);
      this._drawFx(ctx);
    }

    /* ---- Cinematiche transitorie (Fase 1) ---------------------------------
       Le `play*` accodano un effetto e accendono il rAF; il regista
       (ORION.cinematics) decide SE chiamarle in base a preferenza utente e
       reduced-motion, quindi qui non si ri-controlla la modalità. */
    _startFx() {
      if (this._fxRaf) return;
      const self = this;
      const tick = function (t) {
        const now = (typeof t === 'number') ? t : self._now();
        self._fx = self._fx.filter(function (fx) { return (now - fx.start) < fx.dur; });
        self.render();
        if (self._fx.length) self._fxRaf = requestAnimationFrame(tick);
        else { self._fxRaf = 0; self.render(); }   // frame finale pulito
      };
      this._fxRaf = requestAnimationFrame(tick);
    }

    /* Dissolvenza nebbia→rivelazione del sistema (+ glow di coda sulle
       anomalie). La scena è già disegnata "rivelata": qui sopra ci passa un
       velo che si dirada dal centro stella verso i bordi. */
    playReveal() {
      if (!this.ctx) return;
      for (let i = 0; i < this._fx.length; i++) if (this._fx[i].type === 'reveal') return;
      this._fx.push({ type: 'reveal', start: this._now(), dur: 1300 });
      this._startFx();
    }

    /* Partenza di una flotta: il marker "chiude i portelloni" (si compatta),
       lampo, poi scia d'iperspazio verso l'esterno del sistema. */
    playFleetDeparture(fleetId) {
      if (!this.ctx) return;
      const cx = this.offsetX, cy = this.offsetY;   // stella = world(0,0)
      let pos = this._fleetPos && this._fleetPos[fleetId];
      if (!pos) {
        /* Fallback deterministico se la flotta non era a schermo: un punto su
           un'orbita media, angolo derivato dall'id (no Math.random, #5). */
        let h = 0; const s = String(fleetId || '');
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
        const ang = (Math.abs(h) % 1000) / 1000 * Math.PI * 2;
        const rr = Math.min(this.cssW, this.cssH) * 0.28;
        pos = { x: cx + Math.cos(ang) * rr, y: cy + Math.sin(ang) * rr };
      }
      const dx = pos.x - cx, dy = pos.y - cy;
      const d = Math.hypot(dx, dy) || 1;
      this._fx.push({
        type: 'departure', start: this._now(), dur: 720,
        x: pos.x, y: pos.y, ux: dx / d, uy: dy / d
      });
      this._startFx();
    }

    _drawFx(ctx) {
      if (!this._fx || !this._fx.length) return;
      const now = this._now();
      for (let i = 0; i < this._fx.length; i++) {
        const fx = this._fx[i];
        const p = clamp((now - fx.start) / fx.dur, 0, 1);
        if (fx.type === 'reveal') this._fxReveal(ctx, p);
        else if (fx.type === 'departure') this._fxDeparture(ctx, fx, p);
      }
    }

    _fxReveal(ctx, p) {
      const cx = this.offsetX, cy = this.offsetY;
      const ease = p * p * (3 - 2 * p);          // smoothstep
      const a = 1 - ease;                         // opacità del velo
      const diag = Math.hypot(this.cssW, this.cssH);
      // velo che si schiarisce dal centro verso i bordi
      if (a > 0.002) {
        const R = diag * (0.35 + 0.85 * ease);
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
        g.addColorStop(0, 'rgba(8,12,28,' + (a * 0.30).toFixed(3) + ')');
        g.addColorStop(0.6, 'rgba(8,12,28,' + (a * 0.80).toFixed(3) + ')');
        g.addColorStop(1, 'rgba(5,8,20,' + (a * 0.96).toFixed(3) + ')');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, this.cssW, this.cssH);
      }
      // anello di scansione che si espande
      const ringP = clamp(p * 1.1, 0, 1);
      const ringA = (1 - ringP) * 0.5;
      if (ringA > 0.01) {
        ctx.save();
        ctx.strokeStyle = 'rgba(120,210,235,' + ringA.toFixed(3) + ')';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, cy, ringP * diag * 0.55, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
      // coda: glow una-tantum sui marker anomalia (ultimo tratto)
      if (p > 0.55 && this.revealed() && this.system && this.system.anomalies) {
        const gp = clamp((p - 0.55) / 0.45, 0, 1);
        const pulse = Math.sin(gp * Math.PI);     // 0→1→0
        if (pulse > 0.01) {
          const A = this.system.anomalies;
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          for (let i = 0; i < A.length; i++) {
            const an = A[i];
            const w = { x: Math.cos(an.angle) * an.orbit, y: Math.sin(an.angle) * an.orbit };
            const pp = this.worldToScreen(w.x, w.y);
            const col = an.kind === 'reliquie' ? '255,202,85' : an.kind === 'nebulosa' ? '183,155,255' : '154,166,204';
            const rad = 16 * pulse;
            const g = ctx.createRadialGradient(pp.x, pp.y, 0, pp.x, pp.y, rad);
            g.addColorStop(0, 'rgba(' + col + ',' + (0.6 * pulse).toFixed(3) + ')');
            g.addColorStop(1, 'rgba(' + col + ',0)');
            ctx.fillStyle = g;
            ctx.beginPath(); ctx.arc(pp.x, pp.y, rad, 0, Math.PI * 2); ctx.fill();
          }
          ctx.restore();
        }
      }
    }

    _fxDeparture(ctx, fx, p) {
      const x = fx.x, y = fx.y, ux = fx.ux, uy = fx.uy;
      // 1) "portelloni che si chiudono": il marker si compatta
      const close = clamp(p / 0.35, 0, 1);
      const mr = 5 * (1 - 0.5 * close);
      const fade = 1 - clamp((p - 0.35) / 0.65, 0, 1);
      if (fade > 0.01) {
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.fillStyle = '#cfe8ff';
        ctx.strokeStyle = 'rgba(8,12,24,0.85)'; ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x, y - mr); ctx.lineTo(x + mr, y);
        ctx.lineTo(x, y + mr); ctx.lineTo(x - mr, y); ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.restore();
      }
      // 2) scia d'iperspazio + lampo al momento del salto
      if (p > 0.30) {
        const sp = clamp((p - 0.30) / 0.70, 0, 1);
        const len = sp * 64;
        const tail = 18 + sp * 24;
        const px = -uy, py = ux;   // perpendicolare → scie parallele
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round';
        for (let k = -1; k <= 1; k++) {
          const ox = px * k * 3, oy = py * k * 3;
          const hx = x + ox + ux * len, hy = y + oy + uy * len;
          const tx = hx - ux * tail, ty = hy - uy * tail;
          const g = ctx.createLinearGradient(tx, ty, hx, hy);
          const a = (1 - sp) * 0.9;
          g.addColorStop(0, 'rgba(127,208,240,0)');
          g.addColorStop(1, 'rgba(196,232,255,' + a.toFixed(3) + ')');
          ctx.strokeStyle = g;
          ctx.lineWidth = (k === 0) ? 2.2 : 1.3;
          ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(hx, hy); ctx.stroke();
        }
        if (p > 0.30 && p < 0.60) {
          const fp = 1 - Math.abs((p - 0.45) / 0.15);
          if (fp > 0) {
            const fr = 12 * fp;
            const fg = ctx.createRadialGradient(x, y, 0, x, y, fr * 2);
            fg.addColorStop(0, 'rgba(214,240,255,' + (0.7 * fp).toFixed(3) + ')');
            fg.addColorStop(1, 'rgba(214,240,255,0)');
            ctx.fillStyle = fg;
            ctx.beginPath(); ctx.arc(x, y, fr * 2, 0, Math.PI * 2); ctx.fill();
          }
        }
        ctx.restore();
      }
    }

    /* Decisione utente: flotte del giocatore DENTRO questo sistema. Disegna
       il marker accanto al corpo orbitato (location.bodyKey), e per uno
       spostamento intra-sistema (location.intra) interpola la posizione lungo
       la tratta corpo→corpo con la linea tratteggiata — allineato alla grafica
       dei viaggi inter-sistema della mappa galassia. */
    _drawFleets(ctx) {
      this._fleetHit = [];
      const game = root.ORION && root.ORION.game;
      if (!game || !Array.isArray(game.fleets) || !game.fleets.length || !this.system) return;
      const sysId = this.system.id;
      const SY = root.ORION.system;
      const findBody = (k) => (SY && SY.findBody) ? SY.findBody(this.system, k) : null;
      const hash01 = (id) => {
        let h = 0; const s = String(id || '');
        for (let c = 0; c < s.length; c++) h = (h * 31 + s.charCodeAt(c)) | 0;
        return (Math.abs(h) % 1000) / 1000;
      };
      /* Orbita più esterna del sistema → raggio di "vagabondaggio" per le
         flotte senza colonia (in giro per il sistema, mai sulla stella). */
      let maxOrbit = 0.12;
      for (let i = 0; i < this.system.bodies.length; i++) {
        const o = this.system.bodies[i].orbit || 0; if (o > maxOrbit) maxOrbit = o;
      }

      /* 1ª passata: risolvi l'ancora (corpo / loiter / intra) di ogni flotta
         nel sistema e conta quante condividono la stessa ancora, così da
         distribuirle su un anellino senza sovrapporle (selezionabili). */
      const entries = [];
      for (let i = 0; i < game.fleets.length; i++) {
        const f = game.fleets[i];
        if (!f || !f.location || f.location.systemId !== sysId) continue;
        /* Flotta in viaggio INTERSTELLARE (in-transit senza `intra`): durante
           il leg `location.systemId` resta sul sistema di partenza fino
           all'arrivo, quindi senza questo filtro comparirebbe (in loiter)
           nella vista del sistema d'origine pur essendo già "in viaggio"
           sulla mappa galassia → doppione (richiesta utente 2026-06-15).
           Le traversate intra-sistema (con `location.intra`) restano. */
        if (f.location.status === 'in-transit' && !f.location.intra) continue;
        const intra = f.location.intra || null;
        let anchorKey = null;
        let anomalyAnchor = null;
        if (!intra) {
          let bk = f.location.bodyKey;
          const o = f.orders || {};
          /* Corpo bersaglio in QUESTO sistema (garrison/attacco/colonizzazione
             portano un bodyKey): la flotta è lì sopra. */
          if (bk == null && o.bodyKey != null && (o.toSysId == null || o.toSysId === sysId)) bk = o.bodyKey;
          /* Decisione utente 2026-06-16: flotta in `survey` su anomalia di
             QUESTO sistema senza corpo associato (detriti/nebulosa/reliquie):
             ancoraggio sul glifo dell'anomalia per kind, non in orbita
             generica. Le anomalie body-tied (cintura) usano già bodyKey. */
          if (bk == null && o.type === 'survey' && o.anomalyKind &&
              (o.toSysId == null || o.toSysId === sysId)) {
            anomalyAnchor = o.anomalyKind;
          }
          /* "Parcheggiata" = attraccata oppure senza un compito attivo (idle).
             SOLO in questo caso la ancoriamo alla colonia. Una flotta che
             esplora / viaggia / fa ricognizione NON va messa sul pianeta
             (richiesta utente 2026-06-15): resta "in giro per il sistema". */
          const parked = (f.location.status === 'docked') || !o.type || o.type === 'idle';
          if (bk == null && !anomalyAnchor && parked) {
            if (f.ownerColonyKey != null) {
              const parts = String(f.ownerColonyKey).split(':');
              if (parts.length === 2 && parseInt(parts[0], 10) === sysId) bk = parts[1];
            }
            if (bk == null && game.colonies) {
              for (const ck in game.colonies) {
                const c = game.colonies[ck];
                if (c && c.colonized && c.systemId === sysId) {
                  const p2 = String(ck).split(':');
                  if (p2.length === 2) { bk = p2[1]; break; }
                }
              }
            }
          }
          anchorKey = bk; /* null → loiter (in giro per il sistema) */
        }
        entries.push({ f, intra, anchorKey, anomalyAnchor });
      }
      const groupKey = (e) => e.intra ? ('__i' + e.f.id)
                              : e.anomalyAnchor ? ('__an:' + e.anomalyAnchor)
                              : (e.anchorKey == null ? '__loiter' : e.anchorKey);
      const count = {}, idxMap = {};
      entries.forEach((e) => { const k = groupKey(e); count[k] = (count[k] || 0) + 1; });

      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]; const f = e.f;
        let mx, my, routeFrom = null, routeTo = null;
        const k = groupKey(e);
        const n = count[k];
        const idx = (idxMap[k] = (idxMap[k] || 0)); idxMap[k]++;
        if (e.intra) {
          const a = e.intra.fromBodyKey != null ? findBody(e.intra.fromBodyKey) : null;
          const b = e.intra.toBodyKey != null ? findBody(e.intra.toBodyKey) : null;
          const pa = a ? this.bodyWorldPos(a) : { x: 0, y: 0 };
          const pb = b ? this.bodyWorldPos(b) : { x: 0, y: 0 };
          const total = e.intra.totalI || 1;
          const t = total > 0 ? Math.max(0, Math.min(1, 1 - Math.max(0, f.etaImpulsi || 0) / total)) : 1;
          const w = { x: pa.x + (pb.x - pa.x) * t, y: pa.y + (pb.y - pa.y) * t };
          const p = this.worldToScreen(w.x, w.y);
          mx = p.x; my = p.y;
          routeFrom = this.worldToScreen(pa.x, pa.y); routeTo = this.worldToScreen(pb.x, pb.y);
        } else if (e.anchorKey != null) {
          /* A fianco del corpo: anellino appena fuori dal disco, distribuito
             se più flotte condividono lo stesso corpo. */
          const b = findBody(e.anchorKey);
          const w = b ? this.bodyWorldPos(b) : { x: 0, y: 0 };
          const p = this.worldToScreen(w.x, w.y);
          const br = Math.max(b ? this._screenRadius(b) : 5, 5);
          const ang = hash01(e.anchorKey) * Math.PI * 2 + (n > 1 ? idx * (Math.PI * 2 / n) : 0);
          const rr = br + 16;
          mx = p.x + Math.cos(ang) * rr; my = p.y + Math.sin(ang) * rr;
        } else if (e.anomalyAnchor) {
          /* Decisione utente 2026-06-16: ancoraggio sul glifo dell'anomalia
             (detriti/nebulosa/reliquie). Risolve la posizione cercando la
             prima anomalia del sistema con kind corrispondente. */
          const A = (this.system && this.system.anomalies) || [];
          let aw = null;
          for (let ai = 0; ai < A.length; ai++) {
            if (A[ai].kind === e.anomalyAnchor) {
              aw = { x: Math.cos(A[ai].angle) * A[ai].orbit, y: Math.sin(A[ai].angle) * A[ai].orbit };
              break;
            }
          }
          if (aw) {
            const p = this.worldToScreen(aw.x, aw.y);
            const ang = hash01('an:' + e.anomalyAnchor) * Math.PI * 2 + (n > 1 ? idx * (Math.PI * 2 / n) : 0);
            const rr = 14;
            mx = p.x + Math.cos(ang) * rr; my = p.y + Math.sin(ang) * rr;
          } else {
            /* Anomalia non presente nei dati del sistema → fallback loiter. */
            const frac = 0.5 + 0.4 * hash01('r' + f.id);
            const ang = hash01('a' + f.id) * Math.PI * 2;
            const lr = maxOrbit * frac;
            const p = this.worldToScreen(Math.cos(ang) * lr, Math.sin(ang) * lr);
            mx = p.x; my = p.y;
          }
        } else {
          /* "In giro per il sistema": punto deterministico su un'orbita media,
             scattered per flotta (e distribuito se più d'una). */
          const frac = 0.5 + 0.4 * hash01('r' + f.id);
          const ang = hash01('a' + f.id) * Math.PI * 2 + (n > 1 ? idx * (Math.PI * 2 / n) : 0);
          const lr = maxOrbit * frac;
          const p = this.worldToScreen(Math.cos(ang) * lr, Math.sin(ang) * lr);
          mx = p.x; my = p.y;
        }
        /* Linea tratteggiata della traversata intra-sistema. */
        if (routeFrom && routeTo) {
          ctx.save();
          ctx.strokeStyle = 'rgba(120,200,240,0.5)';
          ctx.lineWidth = 1.2; ctx.setLineDash([4, 4]);
          ctx.beginPath(); ctx.moveTo(routeFrom.x, routeFrom.y); ctx.lineTo(routeTo.x, routeTo.y); ctx.stroke();
          ctx.restore();
        }
        this._fleetHit.push({ id: f.id, x: mx, y: my });
        /* Memorizza l'ultima posizione nota (NON azzerata tra i frame): serve
           alla cinematica di partenza, che scatta quando la flotta è già in
           transito e quindi non più disegnata qui. */
        this._fleetPos[f.id] = { x: mx, y: my };
        const st = f.location.status;
        const col = (st === 'in-transit') ? '#7fd0f0' : (st === 'docked') ? '#9fd0a8' : '#f0d670';
        /* Vista sistema (richiesta utente 2026-06-26): la flotta è SEMPRE
           scomposta in icone per tipo + numero (le navi della classe del
           catalogo, rasterizzate da icons.js). Le icone crescono con lo
           zoom come gli altri elementi (this.scale). Alone nel colore di
           stato dietro, etichetta nome sotto. */
        const cell = clamp(this.scale * 0.03, 14, 30);
        const fontPx = Math.round(clamp(this.scale * 0.016, 10, 16));
        const FM = root.ORION && root.ORION.fleetMarker;
        /* alone di stato (movimento) dietro la composizione */
        ctx.save();
        const haloR = cell * 0.95;
        const glow = ctx.createRadialGradient(mx, my, 0, mx, my, haloR);
        glow.addColorStop(0, hexA(col, 0.50));
        glow.addColorStop(0.5, hexA(col, 0.16));
        glow.addColorStop(1, hexA(col, 0));
        ctx.fillStyle = glow;
        ctx.beginPath(); ctx.arc(mx, my, haloR, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        let box = { w: cell, h: cell };
        if (FM) {
          box = FM.composition(ctx, mx, my, cell, f,
            this._fmReady || (this._fmReady = this.requestRender.bind(this)),
            { max: 5 }) || box;
        } else {
          this._drawFleetGlow(ctx, mx, my, cell * 0.5, col);
        }
        /* hit-test: raggio che copre l'ingombro della composizione. */
        this._fleetHit[this._fleetHit.length - 1].r = Math.max(cell, (box.w || cell) / 2);
        /* etichetta nome, centrata SOTTO la composizione (con stroke per
           leggibilità su nebulose/polvere). */
        ctx.save();
        ctx.font = '600 ' + fontPx + 'px "JetBrains Mono", ui-monospace, monospace';
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(2, fontPx / 4);
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        const lbl = (f.name || '').slice(0, 18);
        const ly = my + cell * 0.62 + 2;
        ctx.strokeText(lbl, mx, ly);
        ctx.fillStyle = 'rgba(222,236,255,0.96)';
        ctx.fillText(lbl, mx, ly);
        ctx.restore();
      }
    }

    /* Flotte AI RILEVATE ferme in QUESTO sistema (richiesta utente 2026-06-20:
       "fai come le mie"). Marker a rombo nel colore della civ, un filo più
       grande dei tuoi, con etichetta graduata dall'intel. Le flotte AI in volo
       restano sulla mappa galassia (qui mostriamo solo quelle in orbita nel
       sistema). Niente RNG: posizione deterministica per id. */
    _drawAiFleets(ctx) {
      this._aiFleetHit = [];
      const game = root.ORION && root.ORION.game;
      if (!game || !Array.isArray(game.aiFleets) || !game.aiFleets.length || !this.system) return;
      const sysId = this.system.id;
      const CFGA = (root.ORION.aifleet && root.ORION.aifleet.CFG) || {};
      const PARTIAL = CFGA.INTEL_PARTIAL != null ? CFGA.INTEL_PARTIAL : 0.45;
      const hash01 = (id) => {
        let h = 0; const s = String(id || '');
        for (let c = 0; c < s.length; c++) h = (h * 31 + s.charCodeAt(c)) | 0;
        return (Math.abs(h) % 1000) / 1000;
      };
      let maxOrbit = 0.12;
      for (let i = 0; i < this.system.bodies.length; i++) {
        const o = this.system.bodies[i].orbit || 0; if (o > maxOrbit) maxOrbit = o;
      }
      const present = [];
      for (let i = 0; i < game.aiFleets.length; i++) {
        const af = game.aiFleets[i];
        if (!af || !af.detected) continue;
        if (af.status === 'in-transit') continue;      // in viaggio → mappa galassia
        if (af.systemId !== sysId) continue;
        present.push(af);
      }
      const n = present.length;
      for (let i = 0; i < n; i++) {
        const af = present[i];
        const frac = 0.55 + 0.35 * hash01('air' + af.id);
        const ang = hash01('aia' + af.id) * Math.PI * 2 + (n > 1 ? i * (Math.PI * 2 / n) : 0);
        const lr = maxOrbit * frac;
        const p = this.worldToScreen(Math.cos(ang) * lr, Math.sin(ang) * lr);
        const mx = p.x, my = p.y;
        this._aiFleetHit.push({ id: af.id, x: mx, y: my });
        const color = af.civColor || '#d0d0d0';
        const known = (af.intel || 0) >= PARTIAL;
        const FM = root.ORION && root.ORION.fleetMarker;
        /* Icona del contatto (richiesta utente 2026-06-26): intel < PARTIAL →
           icona nave GENERICA; intel ≥ PARTIAL → silhouette della nave MAGGIORE;
           composizione completa solo nel popup a FULL. Sempre colore civ. */
        const showLead = (af.intel || 0) >= PARTIAL && Array.isArray(af.ships) && af.ships.length;
        const r = clamp(this.scale * 0.024, 8, 18);
        const fontPx = Math.round(clamp(this.scale * 0.017, 11, 17));
        this._aiFleetHit[this._aiFleetHit.length - 1].r = r;
        ctx.save();
        if (!known) ctx.globalAlpha = 0.78;
        if (FM) {
          const cell = clamp(this.scale * 0.03, 14, 30);
          const haloR = cell * 0.95;
          const glow = ctx.createRadialGradient(mx, my, 0, mx, my, haloR);
          glow.addColorStop(0, hexA(color, 0.50));
          glow.addColorStop(0.5, hexA(color, 0.16));
          glow.addColorStop(1, hexA(color, 0));
          ctx.fillStyle = glow;
          ctx.beginPath(); ctx.arc(mx, my, haloR, 0, Math.PI * 2); ctx.fill();
          const onReady = this._fmReady || (this._fmReady = this.requestRender.bind(this));
          if (showLead) FM.lead(ctx, mx, my, cell, af, onReady, color);
          else FM.genericShip(ctx, mx, my, cell, onReady, color);
          this._aiFleetHit[this._aiFleetHit.length - 1].r = Math.max(r, cell * 0.6);
        } else {
          this._drawFleetGlow(ctx, mx, my, r, color, { hostile: true });
          if (!known) {
            ctx.fillStyle = 'rgba(255,255,255,0.96)';
            ctx.font = '700 ' + Math.max(10, Math.round(r * 0.85)) + 'px monospace';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText('?', mx, my + 0.5);
          }
        }
        /* Solo l'identificazione, niente missione/ETA (coerente con la mappa). */
        let lbl = (root.ORION.aifleet && root.ORION.aifleet.nameLabel) ? root.ORION.aifleet.nameLabel(game, af) : 'Contatto';
        if (lbl.length > 20) lbl = lbl.slice(0, 19) + '…';
        ctx.font = '600 ' + fontPx + 'px "JetBrains Mono", ui-monospace, monospace';
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(2, fontPx / 4);
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText(lbl, mx + r + 5, my);
        ctx.fillStyle = color;
        ctx.fillText(lbl, mx + r + 5, my);
        ctx.restore();
      }
    }

    /* Helper condiviso: icona "glow" della flotta (halo radiale + scafo a
       rombo allungato + highlight chiaro al centro). Coerente con la
       resa NASA/Visions del sistema (UI_GUIDE §1) — più riconoscibile del
       semplice rombo. `hostile:true` rende il rombo più appuntito (silhouette
       militare) e l'halo più aggressivo. */
    _drawFleetGlow(ctx, x, y, r, color, opts) {
      opts = opts || {};
      const hostile = !!opts.hostile;
      ctx.save();
      /* halo esterno radiale */
      const haloA = hostile ? 0.62 : 0.55;
      const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 3);
      glow.addColorStop(0, hexA(color, haloA));
      glow.addColorStop(0.45, hexA(color, haloA * 0.36));
      glow.addColorStop(1, hexA(color, 0));
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(x, y, r * 3, 0, Math.PI * 2); ctx.fill();
      /* scafo a rombo allungato in verticale */
      ctx.translate(x, y);
      const top  = -r * (hostile ? 1.30 : 1.15);
      const bot  =  r * (hostile ? 1.00 : 0.85);
      const side =  r * (hostile ? 0.60 : 0.70);
      ctx.beginPath();
      ctx.moveTo(0, top);
      ctx.lineTo(side, r * 0.5);
      ctx.lineTo(0, bot);
      ctx.lineTo(-side, r * 0.5);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = 'rgba(8,12,24,0.92)';
      ctx.lineWidth = Math.max(1, r * 0.12);
      ctx.lineJoin = 'round';
      ctx.stroke();
      /* highlight bianco al centro (riflesso) */
      ctx.beginPath();
      ctx.arc(0, -r * 0.10, r * 0.26, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fill();
      ctx.restore();
    }

    _drawDust(ctx) {
      for (let i = 0; i < this.dust.length; i++) {
        const d = this.dust[i];
        const p = this.worldToScreen(d.x, d.y);
        if (p.x < 0 || p.x > this.cssW || p.y < 0 || p.y > this.cssH) continue;
        ctx.fillStyle = d.warm ? hexA('#ffe6b0', d.alpha) : hexA('#cfe0ff', d.alpha);
        ctx.fillRect(p.x, p.y, d.size, d.size);
      }
    }

    _drawLocked(ctx) {
      const cx = this.cssW / 2, cy = this.cssH / 2;
      // stella generica fioca (tipo ignoto)
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 60);
      g.addColorStop(0, 'rgba(154,166,204,0.5)');
      g.addColorStop(1, 'rgba(154,166,204,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, 60, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(216,226,255,0.8)';
      ctx.font = '600 15px "JetBrains Mono", ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('SISTEMA IGNOTO', cx, cy + 96);
      ctx.fillStyle = 'rgba(154,166,204,0.7)';
      ctx.font = '12px "JetBrains Mono", ui-monospace, monospace';
      ctx.fillText('Richiede esplorazione (modulo M07)', cx, cy + 118);
    }

    _drawOrbits(ctx, star) {
      ctx.save();
      ctx.lineWidth = 1;
      for (let i = 0; i < this.system.bodies.length; i++) {
        const b = this.system.bodies[i];
        const def = BODY_TYPES[b.type];
        if (def.cat === 'belt') continue; // la cintura disegna i propri detriti
        const r = b.orbit * this.scale;
        if (r < 2) continue;
        ctx.strokeStyle = 'rgba(120,150,220,0.18)';
        ctx.beginPath(); ctx.arc(star.x, star.y, r, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
    }

    /* ---- Stelle centrali (core + corona + spicchi di diffrazione) ---- */
    _drawStars(ctx, star) {
      const S = this.system.stars;
      if (S.binary) {
        const off = S.sep * this.scale;
        this._drawStar(ctx, star.x - off, star.y, S.members[0].radius * this.scale, S.members[0].color);
        this._drawStar(ctx, star.x + off, star.y, S.members[1].radius * this.scale, S.members[1].color);
      } else {
        this._drawStar(ctx, star.x, star.y, S.members[0].radius * this.scale, S.members[0].color);
      }
    }

    _drawStar(ctx, x, y, r, color) {
      r = Math.max(r, 6);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      // corona
      const corona = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 3.2);
      corona.addColorStop(0, hexA(color, 0.55));
      corona.addColorStop(0.4, hexA(color, 0.18));
      corona.addColorStop(1, hexA(color, 0));
      ctx.fillStyle = corona;
      ctx.beginPath(); ctx.arc(x, y, r * 3.2, 0, Math.PI * 2); ctx.fill();
      // spicchi di diffrazione
      this._spike(ctx, x, y, r * 3.4, color, 0.5);
      ctx.restore();
      // disco luminoso (bianco al centro → colore al bordo)
      const core = ctx.createRadialGradient(x, y, 0, x, y, r);
      core.addColorStop(0, '#ffffff');
      core.addColorStop(0.45, shade(color, 0.35));
      core.addColorStop(1, color);
      ctx.fillStyle = core;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
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

    /* ---- Corpi celesti ---- */
    _drawBodies(ctx, star) {
      const bs = this.system.bodies;
      const reveal = this.revealed();
      for (let i = 0; i < bs.length; i++) {
        const b = bs[i];
        const def = BODY_TYPES[b.type];
        if (def.cat === 'belt') { this._drawBelt(ctx, star, b, reveal); continue; }
        this._drawBody(ctx, star, b, reveal);
        // le lune (sotto-corpi) si rivelano solo a sistema esplorato
        if (reveal) for (let m = 0; m < b.moons.length; m++) this._drawBody(ctx, star, b.moons[m], reveal);
      }
    }

    _drawBody(ctx, star, body, reveal) {
      const w = this.bodyWorldPos(body);
      const p = this.worldToScreen(w.x, w.y);
      const r = Math.max(this._screenRadius(body), reveal ? 3 : 4);
      if (p.x < -r - 20 || p.x > this.cssW + r + 20 || p.y < -r - 20 || p.y > this.cssH + r + 20) return;

      const isSel = body.key === this.selectedKey;
      const isHover = body.key === this.hoverKey;

      if (!reveal) {
        // sagoma "da scansionare" (DETECTED): disco grigio neutro
        ctx.fillStyle = 'rgba(120,134,180,0.5)';
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(154,166,204,0.5)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke();
        return;
      }

      // direzione della luce: dal corpo verso la stella (centro)
      const ldx = star.x - p.x, ldy = star.y - p.y;
      const ll = Math.hypot(ldx, ldy) || 1;
      const lx = ldx / ll, ly = ldy / ll;

      this._drawPlanet(ctx, p.x, p.y, r, body, lx, ly);

      if (isSel) this._reticle(ctx, p, r + 6, '#ff9d3c');
      else if (isHover) this._ring(ctx, p, r + 5, 'rgba(216,226,255,0.85)', 1.4);

      this._drawOwnerChip(ctx, p, r, body);

      if (r > 3.5 || isSel || isHover || body.homeWorld) {
        this._label(ctx, p, body.name, r, isSel || isHover || body.homeWorld);
      }
    }

    _drawOwnerChip(ctx, p, r, body) {
      var AI = root.ORION.ai;
      var game = root.ORION.game;
      if (!AI || !game) return;
      var sysId = this.system ? this.system.id : null;
      if (sysId == null) return;
      var clampFn = root.ORION.util.clamp;
      var chipS = clampFn(Math.round(r * 0.75), 5, 18);

      var isPlayerColony = false;
      var colKey = sysId + ':' + body.key;
      var col = game.colonies && game.colonies[colKey];
      if (col && col.colonized) isPlayerColony = true;

      var civ = AI.civForPlanet ? AI.civForPlanet(game, sysId, body.key) : null;

      if (!isPlayerColony && !civ) return;

      var color = isPlayerColony ? '#5fa8ff' : civ.color;
      var cx = p.x + r + Math.max(3, Math.round(r * 0.3));
      var cy = p.y - r;
      ctx.fillStyle = color;
      ctx.fillRect(cx, cy, chipS, chipS);
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = Math.max(0.6, chipS * 0.1);
      ctx.strokeRect(cx, cy, chipS, chipS);

      if (this._chipHits) {
        this._chipHits.push({
          x: cx, y: cy, w: chipS, h: chipS,
          bodyKey: body.key, bodyName: body.name,
          isPlayer: isPlayerColony, civ: civ, color: color
        });
      }
    }

    _updateChipTooltip(ptr) {
      var tip = this._tooltip;
      if (!tip) return;
      var hits = this._chipHits;
      var hit = null;
      for (var i = 0; i < hits.length; i++) {
        var h = hits[i];
        if (ptr.x >= h.x && ptr.x <= h.x + h.w && ptr.y >= h.y && ptr.y <= h.y + h.h) {
          hit = h; break;
        }
      }
      if (!hit) { tip.style.display = 'none'; return; }
      var esc = root.ORION.util && root.ORION.util.escapeHtml ? root.ORION.util.escapeHtml : function (s) { return s; };
      var html = '<span class="svtip__sw" style="--tc:' + esc(hit.color) + '"></span>';
      if (hit.isPlayer) {
        html += '<strong>Tua colonia</strong> — ' + esc(hit.bodyName);
      } else if (hit.civ) {
        html += '<strong>' + esc(hit.civ.name) + '</strong> — ' + esc(hit.bodyName);
      }
      tip.innerHTML = html;
      tip.style.display = '';
      var tx = ptr.x + 14;
      var ty = ptr.y - 10;
      if (tx + tip.offsetWidth > this.cssW - 8) tx = ptr.x - tip.offsetWidth - 10;
      if (ty + tip.offsetHeight > this.cssH - 8) ty = this.cssH - tip.offsetHeight - 8;
      if (ty < 4) ty = 4;
      tip.style.left = tx + 'px';
      tip.style.top = ty + 'px';
    }

    /* Disco planetario procedurale: base + dettaglio per tipo + terminatore
       + bordo atmosfera. Tutto deterministico dal seed del corpo. */
    _drawPlanet(ctx, cx, cy, r, body, lx, ly) {
      const def = BODY_TYPES[body.type];
      const pal = def.palette;
      const rng = makeRng(body.seed + ':draw');

      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();

      if (pal.bands) this._paintGas(ctx, cx, cy, r, body, rng);
      else this._paintRocky(ctx, cx, cy, r, def, pal, rng);

      // terminatore (emisfero notturno opposto alla stella)
      const tg = ctx.createLinearGradient(cx + lx * r, cy + ly * r, cx - lx * r, cy - ly * r);
      tg.addColorStop(0, 'rgba(0,0,0,0)');
      tg.addColorStop(0.48, 'rgba(2,4,12,0.05)');
      tg.addColorStop(0.66, 'rgba(2,4,12,0.34)');
      tg.addColorStop(1, 'rgba(1,2,8,0.82)');
      ctx.fillStyle = tg;
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

      // riflesso sub-stellare (morbido) sul lato illuminato
      const hl = ctx.createRadialGradient(cx + lx * r * 0.5, cy + ly * r * 0.5, 0, cx + lx * r * 0.5, cy + ly * r * 0.5, r * 0.9);
      hl.addColorStop(0, 'rgba(255,255,255,0.16)');
      hl.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = hl;
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

      ctx.restore();

      // bordo atmosfera: sottile semicerchio luminoso sul limbo illuminato
      if (pal.atmosphere) {
        ctx.save();
        ctx.lineWidth = Math.max(1, r * 0.10);
        const ang = Math.atan2(ly, lx);
        const ag = ctx.createLinearGradient(cx + lx * r, cy + ly * r, cx - lx * r, cy - ly * r);
        ag.addColorStop(0, hexA(pal.atmosphere, 0.7));
        ag.addColorStop(0.5, hexA(pal.atmosphere, 0.18));
        ag.addColorStop(1, hexA(pal.atmosphere, 0));
        ctx.strokeStyle = ag;
        ctx.beginPath();
        ctx.arc(cx, cy, r + ctx.lineWidth * 0.4, ang - Math.PI / 2, ang + Math.PI / 2);
        ctx.stroke();
        ctx.restore();
      }

      // contorno netto del disco
      ctx.strokeStyle = 'rgba(8,11,26,0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    }

    _paintGas(ctx, cx, cy, r, body, rng) {
      const v = GAS_VARIANTS[body.variant || 0];
      ctx.fillStyle = v.base;
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(body.tilt || 0);
      const n = rng.int(5, 9);
      let yy = -r;
      for (let i = 0; i < n; i++) {
        const h = (2 * r / n) * rng.range(0.7, 1.35);
        const t = rng.range(-0.16, 0.16);
        ctx.fillStyle = shade(rng.chance(0.5) ? v.base : v.alt, t);
        ctx.fillRect(-r, yy, r * 2, h + 0.5);
        yy += h;
      }
      // grande tempesta ovale (tipo Grande Macchia) occasionale
      if (rng.chance(0.55)) {
        ctx.fillStyle = hexA(v.spot, 0.6);
        const sx = rng.range(-r * 0.4, r * 0.4), sy = rng.range(-r * 0.4, r * 0.4);
        ctx.beginPath();
        ctx.ellipse(sx, sy, r * rng.range(0.16, 0.3), r * rng.range(0.09, 0.16), 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    _paintRocky(ctx, cx, cy, r, def, pal, rng) {
      // mare/base
      ctx.fillStyle = pal.sea;
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
      // continenti / chiazze
      const n = rng.int(6, 12);
      for (let i = 0; i < n; i++) {
        const a = rng.range(0, Math.PI * 2);
        const dist = rng.range(0, r * 0.85);
        const bx = cx + Math.cos(a) * dist, by = cy + Math.sin(a) * dist;
        const br = r * rng.range(0.12, 0.42);
        ctx.fillStyle = rng.chance(0.5) ? pal.land : shade(pal.land, rng.range(-0.12, 0.12));
        ctx.beginPath(); ctx.ellipse(bx, by, br, br * rng.range(0.6, 1), rng.range(0, Math.PI), 0, Math.PI * 2); ctx.fill();
      }
      // crateri (lune)
      if (pal.craters) {
        const cN = rng.int(4, 8);
        for (let i = 0; i < cN; i++) {
          const a = rng.range(0, Math.PI * 2), dist = rng.range(0, r * 0.8);
          const bx = cx + Math.cos(a) * dist, by = cy + Math.sin(a) * dist;
          const br = r * rng.range(0.05, 0.16);
          ctx.strokeStyle = shade(pal.sea, -0.25); ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.stroke();
        }
      }
      // crepe di lava luminose (vulcanico)
      if (pal.lava) {
        ctx.save();
        ctx.strokeStyle = pal.accent; ctx.lineWidth = Math.max(1, r * 0.06);
        ctx.shadowColor = pal.accent; ctx.shadowBlur = 6;
        const cN = rng.int(3, 6);
        for (let i = 0; i < cN; i++) {
          let a = rng.range(0, Math.PI * 2), dist = rng.range(0, r * 0.7);
          let bx = cx + Math.cos(a) * dist, by = cy + Math.sin(a) * dist;
          ctx.beginPath(); ctx.moveTo(bx, by);
          for (let s = 0; s < 3; s++) { bx += rng.range(-r * 0.3, r * 0.3); by += rng.range(-r * 0.3, r * 0.3); ctx.lineTo(bx, by); }
          ctx.stroke();
        }
        ctx.restore();
      }
      // calotte polari (ghiacciato)
      if (pal.iceCaps) {
        ctx.fillStyle = hexA('#ffffff', 0.85);
        ctx.beginPath(); ctx.ellipse(cx, cy - r * 0.82, r * 0.7, r * 0.28, 0, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.ellipse(cx, cy + r * 0.82, r * 0.7, r * 0.28, 0, 0, Math.PI * 2); ctx.fill();
      }
    }

    /* Cintura asteroidale: anello di detriti deterministici. */
    _drawBelt(ctx, star, body, reveal) {
      const rng = makeRng(body.seed + ':belt');
      const ringR = body.orbit * this.scale;
      const halfW = body.beltWidth * this.scale * 0.5;
      const n = 130;
      for (let i = 0; i < n; i++) {
        const a = rng.range(0, Math.PI * 2);
        const rad = ringR + (rng.float() - 0.5) * halfW * 2;
        const x = star.x + Math.cos(a) * rad;
        const y = star.y + Math.sin(a) * rad;
        if (x < 0 || x > this.cssW || y < 0 || y > this.cssH) continue;
        const sz = rng.range(0.6, 1.9);
        ctx.fillStyle = reveal ? hexA('#cabd9a', rng.range(0.4, 0.9)) : 'rgba(120,134,180,0.45)';
        ctx.fillRect(x, y, sz, sz);
      }
      // selezione/hover sull'anello
      if (body.key === this.selectedKey || body.key === this.hoverKey) {
        ctx.strokeStyle = body.key === this.selectedKey ? 'rgba(255,157,60,0.7)' : 'rgba(216,226,255,0.6)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(star.x, star.y, ringR + halfW, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(star.x, star.y, ringR - halfW, 0, Math.PI * 2); ctx.stroke();
        if (reveal) this._label(ctx, { x: star.x, y: star.y - ringR }, body.name, 4, true);
      }
    }

    /* Anomalie: campi (nebulosa/detriti) sotto i corpi, marker sopra. */
    _drawAnomalyFields(ctx) {
      const A = this.system.anomalies;
      for (let i = 0; i < A.length; i++) {
        const an = A[i];
        const w = { x: Math.cos(an.angle) * an.orbit, y: Math.sin(an.angle) * an.orbit };
        const p = this.worldToScreen(w.x, w.y);
        const rad = an.radius * this.scale;
        if (an.kind === 'nebulosa') {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad);
          g.addColorStop(0, hexA('#8a6cff', 0.22));
          g.addColorStop(0.5, hexA('#d6457f', 0.1));
          g.addColorStop(1, hexA('#8a6cff', 0));
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(p.x, p.y, rad, 0, Math.PI * 2); ctx.fill();
          ctx.restore();
        } else if (an.kind === 'detriti') {
          const rng = makeRng(an.seed + ':field');
          for (let k = 0; k < 60; k++) {
            const a = rng.range(0, Math.PI * 2), d = rng.range(0, rad);
            const x = p.x + Math.cos(a) * d, y = p.y + Math.sin(a) * d;
            ctx.fillStyle = hexA('#9aa6cc', rng.range(0.25, 0.7));
            const sz = rng.range(0.6, 1.6);
            ctx.fillRect(x, y, sz, sz);
          }
        }
      }
    }

    _drawAnomalyMarkers(ctx) {
      const A = this.system.anomalies;
      for (let i = 0; i < A.length; i++) {
        const an = A[i];
        const w = { x: Math.cos(an.angle) * an.orbit, y: Math.sin(an.angle) * an.orbit };
        const p = this.worldToScreen(w.x, w.y);
        const col = an.kind === 'reliquie' ? '#ffca55' : an.kind === 'nebulosa' ? '#b79bff' : '#9aa6cc';
        // glifo a rombo
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(Math.PI / 4);
        ctx.strokeStyle = col; ctx.lineWidth = 1.4;
        ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 3;
        ctx.strokeRect(-5, -5, 10, 10);
        ctx.restore();
        ctx.font = Math.round(10 * this._labelMul()) + 'px "JetBrains Mono", ui-monospace, monospace';
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillStyle = hexA(col, 0.85);
        ctx.shadowColor = 'rgba(0,0,0,0.85)'; ctx.shadowBlur = 3;
        ctx.fillText(an.label, p.x, p.y + 9);
        ctx.shadowBlur = 0;
      }
    }

    _ring(ctx, p, radius, color, width) {
      ctx.beginPath(); ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = color; ctx.lineWidth = width || 1.5; ctx.stroke();
    }
    _reticle(ctx, p, radius, color) {
      ctx.strokeStyle = color; ctx.lineWidth = 1.6;
      for (let q = 0; q < 4; q++) {
        const a0 = q * Math.PI / 2 + 0.35;
        ctx.beginPath(); ctx.arc(p.x, p.y, radius, a0, a0 + 0.9); ctx.stroke();
      }
    }
    // Moltiplicatore tipografico legato allo zoom: a fitScale = 1, cresce
    // facendo zoom-in così i nomi si leggono meglio, ma cappato (oltre 2×
    // il carattere si fissa) e mai sotto la dimensione base in zoom-out.
    _labelMul() {
      const base = this.fitScale || 1;
      return clamp(this.scale / base, 1, 2);
    }
    _label(ctx, p, text, r, strong) {
      const fs = Math.round(11 * this._labelMul());
      ctx.font = (strong ? '600 ' : '') + fs + 'px "JetBrains Mono", ui-monospace, monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillStyle = strong ? 'rgba(216,226,255,0.95)' : 'rgba(154,166,204,0.78)';
      ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 3;
      ctx.fillText(text, p.x, p.y + r + 4);
      ctx.shadowBlur = 0;
    }
  }

  root.ORION = root.ORION || {};
  root.ORION.SystemView = SystemView;
})(typeof window !== 'undefined' ? window : this);
