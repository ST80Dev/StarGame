/* =====================================================================
   ORION EMPIRES — galaxy-map.js
   Modulo M02: mappa galattica a nodi su Canvas 2D (GDD §5.1).

   Requisiti già fissati nelle decisioni di design:
   - Canvas RESPONSIVO (decisione #6): si adatta al contenitore via
     ResizeObserver e tiene conto di devicePixelRatio per nitidezza su
     schermi HiDPI.
   - Input UNIFICATO mouse/touch (decisione #6): tutto tramite Pointer
     Events (pan con trascinamento, zoom con rotella o pinch, tap/click
     per selezionare, hover per evidenziare). Niente funzioni legate al
     solo `hover`.

   Disegna: rotte stellari (archi), nodi-sistema (colore = tipo stella,
   alone = pericolo), nebbia di guerra (§5.1), etichette dei nomi noti,
   evidenziazione hover e selezione. Il pianeta base ha un anello.
   ===================================================================== */
'use strict';

(function (root) {
  const DISCOVERY = root.ORION.galaxy.DISCOVERY;

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

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
      this.onSelect = null;

      // viewport (trasformazione mondo->schermo)
      this.scale = 1;
      this.offsetX = 0;
      this.offsetY = 0;
      this.fitScale = 1; // scala base che fa entrare la galassia

      // dimensioni in pixel CSS
      this.cssW = 0;
      this.cssH = 0;
      this.dpr = 1;

      // interazione
      this.hoverId = -1;
      this.pointers = new Map(); // pointerId -> {x,y}
      this.dragging = false;
      this.dragMoved = false;
      this.lastPinchDist = 0;

      // riferimenti bound per add/removeEventListener
      this._onResize = this.resize.bind(this);
      this._raf = 0;
      this._needsRender = false;
    }

    mount(container, galaxy, state, opts) {
      opts = opts || {};
      this.container = container;
      this.galaxy = galaxy;
      this.state = state;
      this.onSelect = opts.onSelect || null;

      container.innerHTML = '';
      const canvas = document.createElement('canvas');
      canvas.className = 'galaxy-canvas';
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', 'Mappa galattica');
      canvas.style.touchAction = 'none'; // gestiamo noi pan/zoom via Pointer Events
      container.appendChild(canvas);

      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');

      this._bindEvents();

      // ResizeObserver per adattarsi al contenitore (decisione #6)
      if (typeof ResizeObserver !== 'undefined') {
        this._ro = new ResizeObserver(this._onResize);
        this._ro.observe(container);
      } else {
        window.addEventListener('resize', this._onResize);
      }

      this.resize(); // imposta dimensioni + fit iniziale
      return this;
    }

    destroy() {
      if (this._ro) { this._ro.disconnect(); this._ro = null; }
      else window.removeEventListener('resize', this._onResize);
      if (this._raf) cancelAnimationFrame(this._raf);
      if (this.canvas) this.canvas.replaceWith(this.canvas.cloneNode(false));
      this.canvas = null;
      this.ctx = null;
    }

    /* ---- Gestione dimensioni / DPR ---- */
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

      // scala che fa entrare lo spazio mondo [0,1] con un po' di margine
      const pad = 0.92;
      this.fitScale = Math.min(w, h) * pad;

      if (!hadFit) this.resetView();
      this.requestRender();
    }

    resetView() {
      this.scale = this.fitScale;
      // centra la galassia nel canvas
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

    nodeRadius() {
      // raggio del nodo in px, leggermente legato allo zoom
      return clamp(this.scale * 0.012, 3.2, 9);
    }

    /* ---- Hit testing ---- */
    pickAt(sx, sy) {
      const r = this.nodeRadius() + 6;
      const r2 = r * r;
      const sys = this.galaxy.systems;
      let best = -1;
      let bestD = r2;
      for (let i = 0; i < sys.length; i++) {
        const p = this.worldToScreen(sys[i].x, sys[i].y);
        const dx = p.x - sx;
        const dy = p.y - sy;
        const d = dx * dx + dy * dy;
        if (d <= bestD) { bestD = d; best = i; }
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
      if (this.pointers.size === 2) {
        this.lastPinchDist = this._pinchDist();
      }
    }

    _onPointerMove(e) {
      const p = this._localPos(e);

      if (!this.pointers.has(e.pointerId)) {
        // semplice hover (mouse senza pulsante premuto)
        const id = this.pickAt(p.x, p.y);
        if (id !== this.hoverId) {
          this.hoverId = id;
          this.canvas.style.cursor = id >= 0 ? 'pointer' : 'grab';
          this.requestRender();
        }
        return;
      }

      const prev = this.pointers.get(e.pointerId);
      this.pointers.set(e.pointerId, p);

      if (this.pointers.size === 2) {
        // pinch-zoom
        const d = this._pinchDist();
        if (this.lastPinchDist > 0) {
          const center = this._pinchCenter();
          this._zoomAt(center.x, center.y, d / this.lastPinchDist);
        }
        this.lastPinchDist = d;
        this.dragMoved = true;
        return;
      }

      // pan
      const dx = p.x - prev.x;
      const dy = p.y - prev.y;
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

      // tap/click senza trascinamento = selezione
      if (!wasDrag && e.pointerType !== undefined) {
        const id = this.pickAt(p.x, p.y);
        if (id >= 0) this.select(id);
      }
    }

    _onPointerLeave() {
      if (this.hoverId !== -1) {
        this.hoverId = -1;
        this.requestRender();
      }
      this.canvas.style.cursor = 'grab';
    }

    _onWheel(e) {
      e.preventDefault();
      const p = this._localPos(e);
      const factor = Math.pow(1.0015, -e.deltaY);
      this._zoomAt(p.x, p.y, factor);
    }

    _onDblClick(e) {
      e.preventDefault();
      this.resetView();
    }

    _zoomAt(sx, sy, factor) {
      const minScale = this.fitScale * 0.6;
      const maxScale = this.fitScale * 8;
      const newScale = clamp(this.scale * factor, minScale, maxScale);
      const k = newScale / this.scale;
      // mantieni il punto sotto al cursore fermo
      this.offsetX = sx - (sx - this.offsetX) * k;
      this.offsetY = sy - (sy - this.offsetY) * k;
      this.scale = newScale;
      this.requestRender();
    }

    _pinchDist() {
      const pts = Array.from(this.pointers.values());
      const dx = pts[0].x - pts[1].x;
      const dy = pts[0].y - pts[1].y;
      return Math.sqrt(dx * dx + dy * dy);
    }
    _pinchCenter() {
      const pts = Array.from(this.pointers.values());
      return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    }

    select(id) {
      this.state.selectedId = id;
      // selezionare un sistema lo "rivela" se era solo rilevato
      if (this.state.discovery[id] === DISCOVERY.UNKNOWN) {
        // resta sconosciuto: l'esplorazione vera è M07; qui non sveliamo
      }
      this.requestRender();
      if (this.onSelect) this.onSelect(id);
    }

    /* ---- Render loop (on-demand, non continuo) ---- */
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

      this._drawEdges(ctx);
      this._drawNodes(ctx);
    }

    _drawEdges(ctx) {
      const g = this.galaxy;
      const disc = this.state.discovery;
      ctx.lineWidth = 1;
      for (let i = 0; i < g.edges.length; i++) {
        const e = g.edges[i];
        // mostra una rotta solo se almeno un estremo è noto/rilevato
        const da = disc[e.a];
        const db = disc[e.b];
        if (da === DISCOVERY.UNKNOWN && db === DISCOVERY.UNKNOWN) continue;
        const known = da >= DISCOVERY.DETECTED && db >= DISCOVERY.DETECTED;
        const a = this.worldToScreen(g.systems[e.a].x, g.systems[e.a].y);
        const b = this.worldToScreen(g.systems[e.b].x, g.systems[e.b].y);
        ctx.strokeStyle = known ? 'rgba(86,122,220,0.40)' : 'rgba(86,122,220,0.14)';
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    _drawNodes(ctx) {
      const g = this.galaxy;
      const disc = this.state.discovery;
      const r = this.nodeRadius();
      const showLabels = this.scale > this.fitScale * 1.15;

      for (let i = 0; i < g.systems.length; i++) {
        const s = g.systems[i];
        const p = this.worldToScreen(s.x, s.y);
        // culling fuori schermo
        if (p.x < -30 || p.x > this.cssW + 30 || p.y < -30 || p.y > this.cssH + 30) continue;

        const d = disc[i];
        const isHome = i === g.homeId;
        const isSel = i === this.state.selectedId;
        const isHover = i === this.hoverId;

        if (d === DISCOVERY.UNKNOWN) {
          // nebbia di guerra: solo posizione approssimativa (§5.1)
          ctx.fillStyle = 'rgba(120,134,180,0.35)';
          ctx.beginPath();
          ctx.arc(p.x, p.y, Math.max(2, r * 0.55), 0, Math.PI * 2);
          ctx.fill();
          if (isSel || isHover) this._ring(ctx, p, r + 4, 'rgba(154,166,204,0.6)');
          continue;
        }

        // alone di pericolo (§5.3)
        const dangerCol = this._dangerColor(s.danger);
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 5, 0, Math.PI * 2);
        ctx.fillStyle = dangerCol.glow;
        ctx.fill();

        // corpo della stella (colore = tipo)
        const col = starColor(g, s.star);
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = col;
        ctx.fill();

        // sistemi solo "rilevati" leggermente smorzati
        if (d === DISCOVERY.DETECTED) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(6,9,22,0.45)';
          ctx.fill();
        }

        // anello pianeta base
        if (isHome) this._ring(ctx, p, r + 4, '#2fe6e0', 2);
        // selezione / hover
        if (isSel) this._ring(ctx, p, r + 7, '#ff9d3c', 2);
        else if (isHover) this._ring(ctx, p, r + 6, 'rgba(216,226,255,0.85)', 1.5);

        // etichetta (solo nomi noti e con zoom sufficiente, oppure home/selezione/hover)
        if (d >= DISCOVERY.DETECTED && (showLabels || isHome || isSel || isHover)) {
          this._label(ctx, p, s.name, r, isSel || isHover || isHome);
        }
      }
    }

    _ring(ctx, p, radius, color, width) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = width || 1.5;
      ctx.stroke();
    }

    _label(ctx, p, text, r, strong) {
      ctx.font = (strong ? '600 ' : '') + '11px "JetBrains Mono", ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const y = p.y + r + 4;
      ctx.fillStyle = strong ? 'rgba(216,226,255,0.95)' : 'rgba(154,166,204,0.75)';
      // leggera ombra per leggibilità sopra le rotte
      ctx.shadowColor = 'rgba(0,0,0,0.8)';
      ctx.shadowBlur = 3;
      ctx.fillText(text, p.x, y);
      ctx.shadowBlur = 0;
    }

    _dangerColor(d) {
      // verde (sicuro) -> giallo -> arancio -> rosso (letale)
      if (d <= 25) return { glow: 'rgba(79,224,138,0.18)' };
      if (d <= 50) return { glow: 'rgba(255,202,85,0.18)' };
      if (d <= 75) return { glow: 'rgba(255,157,60,0.20)' };
      return { glow: 'rgba(255,92,108,0.22)' };
    }
  }

  root.ORION = root.ORION || {};
  root.ORION.GalaxyMap = GalaxyMap;
})(typeof window !== 'undefined' ? window : this);
