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
    }

    mount(container, system, opts) {
      opts = opts || {};
      this.container = container;
      this.system = system;
      this.discovery = opts.discovery == null ? DISCOVERY.UNKNOWN : opts.discovery;
      this.onSelectBody = opts.onSelectBody || null;
      this.onActivateBody = opts.onActivateBody || null;
      this.onExit = opts.onExit || null;

      container.innerHTML = '';
      const canvas = document.createElement('canvas');
      canvas.className = 'system-canvas';
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', 'Vista del sistema ' + system.name);
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
      if (!wasDrag) this._handleClick(p.x, p.y);
    }

    _handleClick(sx, sy) {
      const key = this.pickBody(sx, sy);
      this.selectBody(key); // key === null deseleziona
    }

    _onPointerLeave() {
      if (this.hoverKey !== null) { this.hoverKey = null; this.requestRender(); }
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
      const minScale = this.fitScale * 0.55;
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
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.cssW, this.cssH);

      this._drawDust(ctx);

      if (!this.detected()) { this._drawLocked(ctx); return; }

      const star = this.worldToScreen(0, 0);
      this._drawOrbits(ctx, star);
      if (this.revealed()) this._drawAnomalyFields(ctx);
      this._drawStars(ctx, star);
      this._drawBodies(ctx, star);
      if (this.revealed()) this._drawAnomalyMarkers(ctx);
      this._drawFleets(ctx);
    }

    /* Decisione utente: flotte del giocatore DENTRO questo sistema. Disegna
       il marker accanto al corpo orbitato (location.bodyKey), e per uno
       spostamento intra-sistema (location.intra) interpola la posizione lungo
       la tratta corpo→corpo con la linea tratteggiata — allineato alla grafica
       dei viaggi inter-sistema della mappa galassia. */
    _drawFleets(ctx) {
      const game = root.ORION && root.ORION.game;
      if (!game || !Array.isArray(game.fleets) || !game.fleets.length || !this.system) return;
      const sysId = this.system.id;
      const SY = root.ORION.system;
      const findBody = (k) => (SY && SY.findBody) ? SY.findBody(this.system, k) : null;
      for (let i = 0; i < game.fleets.length; i++) {
        const f = game.fleets[i];
        if (!f || !f.location || f.location.systemId !== sysId) continue;
        let wpos = null, routeFrom = null, routeTo = null;
        const intra = f.location.intra;
        if (intra) {
          const a = intra.fromBodyKey != null ? findBody(intra.fromBodyKey) : null;
          const b = intra.toBodyKey != null ? findBody(intra.toBodyKey) : null;
          const pa = a ? this.bodyWorldPos(a) : { x: 0, y: 0 };
          const pb = b ? this.bodyWorldPos(b) : { x: 0, y: 0 };
          const total = intra.totalI || 1;
          const eta = Math.max(0, f.etaImpulsi || 0);
          const t = total > 0 ? Math.max(0, Math.min(1, 1 - eta / total)) : 1;
          wpos = { x: pa.x + (pb.x - pa.x) * t, y: pa.y + (pb.y - pa.y) * t };
          routeFrom = pa; routeTo = pb;
        } else {
          let bk = f.location.bodyKey;
          if (bk == null && f.location.status === 'docked' && f.ownerColonyKey != null) {
            const parts = String(f.ownerColonyKey).split(':');
            if (parts.length === 2 && parseInt(parts[0], 10) === sysId) bk = parts[1];
          }
          const b = bk != null ? findBody(bk) : null;
          wpos = b ? this.bodyWorldPos(b) : { x: 0, y: 0 };
        }
        const p = this.worldToScreen(wpos.x, wpos.y);
        /* Linea tratteggiata della traversata intra-sistema. */
        if (routeFrom && routeTo) {
          const sa = this.worldToScreen(routeFrom.x, routeFrom.y);
          const sb = this.worldToScreen(routeTo.x, routeTo.y);
          ctx.save();
          ctx.strokeStyle = 'rgba(120,200,240,0.5)';
          ctx.lineWidth = 1.2; ctx.setLineDash([4, 4]);
          ctx.beginPath(); ctx.moveTo(sa.x, sa.y); ctx.lineTo(sb.x, sb.y); ctx.stroke();
          ctx.restore();
        }
        /* Offset deterministico dal corpo (non sovrapporsi al pianeta). */
        let h = 0; const id = f.id || ('f' + i);
        for (let c = 0; c < id.length; c++) h = (h * 31 + id.charCodeAt(c)) | 0;
        h = Math.abs(h);
        const ang = intra ? 0 : (h % 360) * Math.PI / 180;
        const off = intra ? 0 : 13;
        const mx = p.x + Math.cos(ang) * off, my = p.y + Math.sin(ang) * off;
        const st = f.location.status;
        const col = (st === 'in-transit') ? '#7fd0f0' : (st === 'docked') ? '#9fd0a8' : '#f0d670';
        ctx.save();
        ctx.fillStyle = col;
        ctx.strokeStyle = 'rgba(8,12,24,0.85)'; ctx.lineWidth = 1.5;
        const r = 5;
        ctx.beginPath();
        ctx.moveTo(mx, my - r); ctx.lineTo(mx + r, my);
        ctx.lineTo(mx, my + r); ctx.lineTo(mx - r, my); ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = 'rgba(222,236,255,0.92)';
        ctx.font = '10px system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillText((f.name || '').slice(0, 14), mx + r + 3, my);
        ctx.restore();
      }
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

      if (r > 3.5 || isSel || isHover || body.homeWorld) {
        this._label(ctx, p, body.name, r, isSel || isHover || body.homeWorld);
      }
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
