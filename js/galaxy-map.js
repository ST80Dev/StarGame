/* =====================================================================
   ORION EMPIRES — galaxy-map.js
   Modulo M02: mappa galattica su Canvas 2D (GDD §5.1) con
   NAVIGAZIONE GERARCHICA A ZOOM (decisione M02-nav):

     Galassia → Gruppo stellare → (Sistema → Pianeta: M03/M04)

   Resa "realistica" (decisione #8): niente alone uniforme sui nodi —
   nebulose + polvere stellare di sfondo, bloom/spicchi sulle poche
   stelle brillanti, marker netti coi gruppi-colore.

   PSEUDO-3D (decisione #18, su feedback utente post-M04). Il disco
   galattico è rappresentato a tre dimensioni:
     - ogni sistema ha (x, y) nel piano + un z (banda per cluster, così
       le regioni si separano anche in profondità → niente più overlap);
     - una proiezione `project(wx, wy, wz)` applica una rotazione yaw
       attorno all'asse galattico (Z), una rotazione pitch fissa (tilt
       del disco) attorno all'asse orizzontale (X), e una prospettiva
       leggera (gli oggetti vicini al viewer sono leggermente più grandi);
     - z-sort sui nodi così quelli "davanti" si disegnano sopra;
     - Shift+drag (mouse) / touch a 2 dita ⇄ ruota lo yaw — il pinch
       continua a zoomare. Esiste anche un pulsante "Galassia" che
       ripristina yaw=0 e scala iniziale.
     - dust e nebulose hanno anch'esse un z e ruotano col disco (immersivo);
     - una "ecliptica" sottile (cerchio tratteggiato sul piano z=0)
       dà un riferimento di profondità.

   Vincolo §2 rispettato: tutto in Canvas 2D, niente WebGL.

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
  function shortestAngle(from, to) {
    // restituisce un target equivalente a `to` ma più vicino a `from`
    let d = ((to - from + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (d < -Math.PI) d += Math.PI * 2;
    return from + d;
  }

  /* ------------------------------------------------------------------
     Quaternion (decisione #20): rotazione libera 360° su tutti e 3 gli
     assi senza gimbal lock. Sostituisce la coppia yaw/pitch.
     ------------------------------------------------------------------ */
  function Quat(w, x, y, z) { this.w = w; this.x = x; this.y = y; this.z = z; }
  Quat.identity = function () { return new Quat(1, 0, 0, 0); };
  Quat.fromAxisAngle = function (ax, ay, az, ang) {
    const h = ang * 0.5, s = Math.sin(h);
    return new Quat(Math.cos(h), ax * s, ay * s, az * s);
  };
  Quat.prototype.mul = function (o) {
    return new Quat(
      this.w * o.w - this.x * o.x - this.y * o.y - this.z * o.z,
      this.w * o.x + this.x * o.w + this.y * o.z - this.z * o.y,
      this.w * o.y - this.x * o.z + this.y * o.w + this.z * o.x,
      this.w * o.z + this.x * o.y - this.y * o.x + this.z * o.w
    );
  };
  Quat.prototype.normalize = function () {
    const n = Math.sqrt(this.w * this.w + this.x * this.x + this.y * this.y + this.z * this.z);
    if (n === 0) return Quat.identity();
    return new Quat(this.w / n, this.x / n, this.y / n, this.z / n);
  };
  Quat.prototype.rotate = function (vx, vy, vz) {
    const w = this.w, x = this.x, y = this.y, z = this.z;
    const ww = w * w, xx = x * x, yy = y * y, zz = z * z;
    const wx = w * x, wy = w * y, wz = w * z;
    const xy = x * y, xz = x * z, yz = y * z;
    return {
      x: vx * (ww + xx - yy - zz) + 2 * vy * (xy - wz) + 2 * vz * (xz + wy),
      y: 2 * vx * (xy + wz) + vy * (ww - xx + yy - zz) + 2 * vz * (yz - wx),
      z: 2 * vx * (xz - wy) + 2 * vy * (yz + wx) + vz * (ww - xx - yy + zz)
    };
  };
  /* Interpolazione lineare normalizzata: per piccoli angoli è
     indistinguibile da slerp ed evita la complessità. */
  Quat.lerp = function (a, b, t) {
    let bw = b.w, bx = b.x, by = b.y, bz = b.z;
    const dot = a.w * bw + a.x * bx + a.y * by + a.z * bz;
    if (dot < 0) { bw = -bw; bx = -bx; by = -by; bz = -bz; }
    return new Quat(
      a.w + (bw - a.w) * t,
      a.x + (bx - a.x) * t,
      a.y + (by - a.y) * t,
      a.z + (bz - a.z) * t
    ).normalize();
  };
  Quat.prototype.distSq = function (o) {
    let bw = o.w, bx = o.x, by = o.y, bz = o.z;
    const dot = this.w * bw + this.x * bx + this.y * by + this.z * bz;
    if (dot < 0) { bw = -bw; bx = -bx; by = -by; bz = -bz; }
    const dw = this.w - bw, dx = this.x - bx, dy = this.y - by, dz = this.z - bz;
    return dw * dw + dx * dx + dy * dy + dz * dz;
  };

  /* Colori per gruppo (accenti del tema, ciclici). */
  const GROUP_COLORS = [
    '#2fe6e0', '#8a6cff', '#ff9d3c', '#d6457f',
    '#ffb000', '#5cc8ff', '#9d7bff', '#ff6f5c'
  ];
  /* Varianti "label" — gli stessi accenti con luminosità alzata, così
     restano leggibili come testo su #04060f anche le tinte più scure
     (viola/rosa/arancio scuro). */
  const GROUP_LABEL_COLORS = [
    '#7df6f0', '#b9a7ff', '#ffc07a', '#ff8fb4',
    '#ffd35e', '#a3ddff', '#c7adff', '#ffa094'
  ];
  function groupColor(id) { return GROUP_COLORS[((id % GROUP_COLORS.length) + GROUP_COLORS.length) % GROUP_COLORS.length]; }
  function groupLabelColor(id) { return GROUP_LABEL_COLORS[((id % GROUP_LABEL_COLORS.length) + GROUP_LABEL_COLORS.length) % GROUP_LABEL_COLORS.length]; }

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

  /* Tilt iniziale del disco galattico — quaternion fisso, ~31° attorno
     all'asse X (orizzontale schermo). L'utente poi è libero su 3 assi. */
  const DEFAULT_PITCH = 0.55;             // ~31°
  function defaultOrient() { return Quat.fromAxisAngle(1, 0, 0, DEFAULT_PITCH); }
  /* Distanza camera-centro: regola l'intensità della prospettiva. */
  const VIEWER_D = 1.55;

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

      // pseudo-3D — rotazione libera 360° via quaternion (decisione #20)
      this.orient = defaultOrient();

      // navigazione gerarchica
      this.activeGroupId = -1; // gruppo "entrato" esplicitamente (-1 = nessuno)

      // dimensioni in pixel CSS
      this.cssW = 0;
      this.cssH = 0;
      this.dpr = 1;

      // interazione
      this.hoverSystem = -1;
      this.hoverGroup = -1;
      this.hoverCluster = -1;       // cluster di hoverSystem (per highlight)
      this.pointers = new Map();
      this.dragging = false;
      this.dragMoved = false;
      this.lastPinchDist = 0;
      this.lastPinchAngle = 0;
      this.rotateModifier = false;  // Shift premuto = arcball (yaw+pitch)
      this.rollModifier = false;    // Alt premuto = drag ruota roll

      // sfondo deterministico (nebulose + polvere + stelle), in spazio mondo 3D
      this.nebulae = [];
      this.dust = [];
      this.brightStars = [];

      // animazione camera
      this._anim = false;
      this._tScale = 1; this._tox = 0; this._toy = 0;
      this._tOrient = defaultOrient();

      this._onResize = this.resize.bind(this);
      this._onKeyDown = this._handleKeyDown.bind(this);
      this._onKeyUp = this._handleKeyUp.bind(this);
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
      window.addEventListener('keydown', this._onKeyDown);
      window.addEventListener('keyup', this._onKeyUp);

      this.resize();
      // re-render quando i webfont (Orbitron, JetBrains Mono) sono pronti,
      // così le etichette canvas si "agganciano" senza rimbalzo di fallback.
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => { if (this.canvas) this.requestRender(); });
      }
      return this;
    }

    destroy() {
      if (this._ro) { this._ro.disconnect(); this._ro = null; }
      else window.removeEventListener('resize', this._onResize);
      window.removeEventListener('keydown', this._onKeyDown);
      window.removeEventListener('keyup', this._onKeyUp);
      if (this._raf) cancelAnimationFrame(this._raf);
      this._anim = false;
      if (this.canvas) this.canvas.replaceWith(this.canvas.cloneNode(false));
      this.canvas = null;
      this.ctx = null;
    }

    /* ---- Sfondo deterministico (dal seed): nebulose + polvere stellare ----
       Tutti gli elementi hanno una z così ruotano col disco galattico. */
    _buildBackdrop() {
      const rng = root.ORION.rng.makeRng(this.galaxy.seed + ':backdrop');
      // nebulose: blob morbidi in spazio mondo, vicino al piano galattico
      // Nebulose ridotte all'osso (richiesta utente "vista più pulita,
      // meno alone nubuloso colorato"): 6 macchie sobrie, alpha bassa.
      this.nebulae = [];
      const nNeb = 6;
      for (let i = 0; i < nNeb; i++) {
        this.nebulae.push({
          x: rng.range(-0.05, 1.05),
          y: rng.range(-0.05, 1.05),
          z: rng.range(-0.08, 0.08),
          r: rng.range(0.16, 0.34),
          color: rng.pick(NEBULA_COLORS),
          alpha: rng.range(0.02, 0.055)
        });
      }
      // polvere stellare decorativa: distribuita nel disco con un po' di alone.
      // Densità e alpha contenuti per non sbiadire le etichette (fix utente).
      this.dust = [];
      const nDust = 360;
      for (let i = 0; i < nDust; i++) {
        const m = Math.pow(rng.float(), 3);
        this.dust.push({
          x: rng.range(-0.08, 1.08),
          y: rng.range(-0.08, 1.08),
          z: rng.range(-0.14, 0.14),
          size: 0.4 + m * 1.5,
          alpha: 0.14 + m * 0.55,
          warm: rng.chance(0.5)
        });
      }
      // Stelle "eroe" decorative con bloom + spicchi di diffrazione.
      this.brightStars = [];
      for (let i = 0; i < 8; i++) {
        this.brightStars.push({
          x: rng.range(0.06, 0.94),
          y: rng.range(0.06, 0.94),
          z: rng.range(-0.04, 0.04),
          len: 14 + rng.float() * 18,
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
      this.orient = defaultOrient();
      this.requestRender();
    }

    /* ---- Proiezione mondo 3D → schermo (quaternionica) ----
       Pipeline: world(x,y,z) → centro a (0.5,0.5,0) → rotazione `orient`
       (libera su 3 assi) → prospettiva → scala+offset. */
    project(wx, wy, wz) {
      const dx = wx - 0.5;
      const dy = wy - 0.5;
      const dz = wz || 0;

      const r = this.orient.rotate(dx, dy, dz);
      const persp = VIEWER_D / Math.max(0.4, VIEWER_D - r.z);

      const cx0 = this.offsetX + this.scale * 0.5;
      const cy0 = this.offsetY + this.scale * 0.5;
      return {
        x: r.x * persp * this.scale + cx0,
        y: r.y * persp * this.scale + cy0,
        depth: r.z,
        parallax: persp
      };
    }

    /* Inverso approssimato di project (solo per pan/zoom centrato sul puntatore):
       considera la proiezione come una mappatura affine attorno al centro corrente.
       Sufficiente per zoom-at-cursor. */
    screenToWorldApprox(sx, sy) {
      const cx0 = this.offsetX + this.scale * 0.5;
      const cy0 = this.offsetY + this.scale * 0.5;
      // ignora prospettiva e rotazione: stima locale
      return { x: 0.5 + (sx - cx0) / this.scale, y: 0.5 + (sy - cy0) / this.scale };
    }

    /* Quanto sono "rivelate" le singole stelle (0 = solo regioni, 1 = stelle).
       Transizione continua guidata dallo zoom; quando si è ENTRATI in un
       gruppo (click su regione / breadcrumb) le stelle sono piene. */
    nodeReveal() {
      if (this.activeGroupId >= 0) return 1;
      return smoothstep(1.5, 2.7, this.scale / this.fitScale);
    }

    nodeRadius(parallax) {
      const r = clamp(this.scale * 0.012, 3.6, 8);
      return r * (parallax || 1);
    }

    /* Livello "effettivo" corrente, derivato da zoom/selezione. */
    effectiveLevel() {
      return this.nodeReveal() >= 0.5 ? 'group' : 'galaxy';
    }

    _groupNearestCenter() {
      // gruppo il cui centroide proiettato è più vicino al centro schermo
      const groups = this.galaxy.groups;
      const sc = { x: this.cssW / 2, y: this.cssH / 2 };
      let best = -1, bd = Infinity;
      for (let i = 0; i < groups.length; i++) {
        const p = this.project(groups[i].cx, groups[i].cy, groups[i].cz || 0);
        const dx = p.x - sc.x, dy = p.y - sc.y;
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

    /* ---- Hit testing (su coordinate proiettate) ---- */
    pickSystem(sx, sy) {
      const sys = this.galaxy.systems;
      let best = -1, bestD = Infinity;
      for (let i = 0; i < sys.length; i++) {
        const p = this.project(sys[i].x, sys[i].y, sys[i].z || 0);
        const r = this.nodeRadius(p.parallax) + 7;
        const dx = p.x - sx, dy = p.y - sy;
        const d = dx * dx + dy * dy;
        if (d <= r * r && d < bestD) { bestD = d; best = i; }
      }
      return best;
    }

    pickGroup(sx, sy) {
      const groups = this.galaxy.groups;
      let best = -1, bestD = Infinity;
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        const c = this.project(g.cx, g.cy, g.cz || 0);
        const rad = Math.max(28, g.radius * this.scale * c.parallax + 18);
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

    _handleKeyDown(e) {
      if (e.key === 'Shift') this.rotateModifier = true;
      if (e.key === 'Alt') this.rollModifier = true;
      // Q/E yaw (asse Y schermo) · R/F roll (asse Z vista) · T/G pitch (asse X)
      let axis = null, ang = 0;
      if (e.key === 'q' || e.key === 'Q') { axis = [0, 1, 0]; ang = -0.20; }
      else if (e.key === 'e' || e.key === 'E') { axis = [0, 1, 0]; ang =  0.20; }
      else if (e.key === 'r' || e.key === 'R') { axis = [0, 0, 1]; ang = -0.20; }
      else if (e.key === 'f' || e.key === 'F') { axis = [0, 0, 1]; ang =  0.20; }
      else if (e.key === 't' || e.key === 'T') { axis = [1, 0, 0]; ang = -0.20; }
      else if (e.key === 'g' || e.key === 'G') { axis = [1, 0, 0]; ang =  0.20; }
      if (axis) {
        const dq = Quat.fromAxisAngle(axis[0], axis[1], axis[2], ang);
        this.orient = dq.mul(this.orient).normalize();
        this.requestRender();
      }
    }
    _handleKeyUp(e) {
      if (e.key === 'Shift') this.rotateModifier = false;
      if (e.key === 'Alt') this.rollModifier = false;
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
      this._anim = false;            // un'interazione interrompe l'animazione
      if (this.pointers.size === 2) {
        this.lastPinchDist = this._pinchDist();
        this.lastPinchAngle = this._pinchAngle();
      }
    }

    _onPointerMove(e) {
      const p = this._localPos(e);

      if (!this.pointers.has(e.pointerId)) {
        // hover
        let hs = -1, hg = -1;
        if (this.nodeReveal() >= 0.5) hs = this.pickSystem(p.x, p.y);
        else hg = this.pickGroup(p.x, p.y);
        const hc = hs >= 0 ? this.galaxy.systems[hs].cluster : -1;
        if (hs !== this.hoverSystem || hg !== this.hoverGroup || hc !== this.hoverCluster) {
          this.hoverSystem = hs; this.hoverGroup = hg; this.hoverCluster = hc;
          this.canvas.style.cursor = (hs >= 0 || hg >= 0) ? 'pointer' : 'grab';
          this.requestRender();
        }
        return;
      }

      const prev = this.pointers.get(e.pointerId);
      this.pointers.set(e.pointerId, p);

      if (this.pointers.size === 2) {
        // 2 dita: pinch zooma; la rotazione delle dita applica roll
        // (rotazione attorno all'asse della vista), naturale su touch.
        const d = this._pinchDist();
        const a = this._pinchAngle();
        if (this.lastPinchDist > 0) {
          const center = this._pinchCenter();
          this._zoomAt(center.x, center.y, d / this.lastPinchDist);
          let da = a - this.lastPinchAngle;
          if (da > Math.PI) da -= Math.PI * 2;
          if (da < -Math.PI) da += Math.PI * 2;
          this._applyRoll(da);
        }
        this.lastPinchDist = d;
        this.lastPinchAngle = a;
        this.dragMoved = true;
        this.requestRender();
        return;
      }

      const dx = p.x - prev.x, dy = p.y - prev.y;
      if (Math.abs(dx) + Math.abs(dy) > 1) this.dragMoved = true;

      if (this.rollModifier) {
        // Alt + drag orizzontale = roll (asse Z della vista)
        this._applyRoll(dx * 0.012);
      } else if (this.rotateModifier) {
        // Shift + drag = arcball: rotazione attorno a un asse perpendicolare
        // al movimento del puntatore, sul piano dello schermo.
        // Drag orizzontale → asse Y schermo → ruota in "yaw" rispetto al
        // disco corrente. Drag verticale → asse X schermo → "pitch".
        // Funziona su tutti e 3 gli assi: drag diagonali = oblique.
        this._applyArcball(dx, dy);
      } else {
        this.offsetX += dx;
        this.offsetY += dy;
      }
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
        const id = this.pickSystem(sx, sy);
        if (id >= 0) { this.selectSystem(id); return; }
      } else {
        const gid = this.pickGroup(sx, sy);
        if (gid >= 0) { this.focusGroup(gid); return; }
      }
    }

    _onPointerLeave() {
      if (this.hoverSystem !== -1 || this.hoverGroup !== -1) {
        this.hoverSystem = -1; this.hoverGroup = -1; this.hoverCluster = -1;
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
    _pinchAngle() {
      const pts = Array.from(this.pointers.values());
      return Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
    }

    /* Applica un incremento di rotazione "arcball": l'asse è perpendicolare
       al vettore di trascinamento sullo schermo (camera-frame), l'angolo è
       proporzionale alla lunghezza del drag. Compone la rotazione DAVANTI
       all'orient corrente (camera-frame). */
    _applyArcball(dx, dy) {
      const mag = Math.hypot(dx, dy);
      if (mag < 0.5) return;
      // axis ⊥ drag nel piano schermo: (-dy, dx, 0). Segno scelto perché
      // drag orizzontale → ruota il disco "come un giradischi sotto al
      // pollice" — la sensazione naturale.
      const ax = -dy / mag, ay = dx / mag;
      const angle = mag * 0.012;
      const dq = Quat.fromAxisAngle(ax, ay, 0, angle);
      this.orient = dq.mul(this.orient).normalize();
    }

    _applyRoll(angle) {
      if (!angle) return;
      const dq = Quat.fromAxisAngle(0, 0, 1, angle);
      this.orient = dq.mul(this.orient).normalize();
    }

    /* ---- Camera animata verso un riquadro-mondo (proiettato) ----
       Compone scale/offset per fittare un bbox in coordinate "ruotate" 2D
       (x,y dopo orient, prima della prospettiva). Sufficiente per
       inquadrature gradevoli senza un solver completo della prospettiva. */
    _rotatedXY(wx, wy, wz) {
      const r = this.orient.rotate(wx - 0.5, wy - 0.5, wz || 0);
      return { x: r.x, y: r.y };
    }

    _cameraForRotatedBounds(points, fill, minS) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < points.length; i++) {
        const r = this._rotatedXY(points[i].x, points[i].y, points[i].z || 0);
        if (r.x < minX) minX = r.x; if (r.x > maxX) maxX = r.x;
        if (r.y < minY) minY = r.y; if (r.y > maxY) maxY = r.y;
      }
      const w = Math.max(maxX - minX, 0.06), h = Math.max(maxY - minY, 0.06);
      let s = Math.min(this.cssW / w, this.cssH / h) * (fill || 0.62);
      s = clamp(s, minS || this.fitScale * 0.6, this.fitScale * 9);
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      const ox = this.cssW / 2 - cx * s - s * 0.5;
      const oy = this.cssH / 2 - cy * s - s * 0.5;
      return { s: s, ox: ox, oy: oy };
    }

    _animateTo(s, ox, oy, orient) {
      this._tScale = s; this._tox = ox; this._toy = oy;
      this._tOrient = orient || this.orient;
      if (!this._anim) { this._anim = true; this._animTick(); }
    }

    _animTick() {
      if (!this._anim || !this.ctx) return;
      const k = 0.2;
      this.scale = lerp(this.scale, this._tScale, k);
      this.offsetX = lerp(this.offsetX, this._tox, k);
      this.offsetY = lerp(this.offsetY, this._toy, k);
      this.orient = Quat.lerp(this.orient, this._tOrient, k);
      const done = Math.abs(this.scale - this._tScale) < this._tScale * 0.002 &&
        Math.abs(this.offsetX - this._tox) < 0.5 && Math.abs(this.offsetY - this._toy) < 0.5 &&
        this.orient.distSq(this._tOrient) < 0.00005;
      if (done) {
        this.scale = this._tScale; this.offsetX = this._tox; this.offsetY = this._toy;
        this.orient = this._tOrient; this._anim = false;
      }
      this.render();
      if (this._anim) requestAnimationFrame(this._animTick.bind(this));
    }

    /* ---- API di navigazione (usate anche dalla breadcrumb) ---- */
    focusGalaxy() {
      this.activeGroupId = -1;
      this.state.selectedId = -1;
      // ripristina orientation di default oltre a scala e offset
      this._animateTo(
        this.fitScale,
        (this.cssW - this.fitScale) / 2,
        (this.cssH - this.fitScale) / 2,
        defaultOrient()
      );
      this._emitContext(true);
    }

    focusGroup(id) {
      const g = this._groupById(id);
      if (!g) return;
      this.activeGroupId = id;
      if (this.state.selectedId >= 0 && this.galaxy.systems[this.state.selectedId].cluster !== id) {
        this.state.selectedId = -1;
      }
      const pad = 0.03;
      const pts = [
        { x: g.minX - pad, y: g.minY - pad, z: g.minZ || 0 },
        { x: g.maxX + pad, y: g.minY - pad, z: g.minZ || 0 },
        { x: g.minX - pad, y: g.maxY + pad, z: g.maxZ || 0 },
        { x: g.maxX + pad, y: g.maxY + pad, z: g.maxZ || 0 },
        { x: g.cx,         y: g.cy,         z: g.cz   || 0 }
      ];
      const cam = this._cameraForRotatedBounds(pts, 0.62, this.fitScale * 1.8);
      this._animateTo(cam.s, cam.ox, cam.oy);
      this._emitContext(true);
    }

    focusSystem(id) {
      const s = this.galaxy.systems[id];
      if (!s) return;
      this.activeGroupId = s.cluster;
      const span = 0.16;
      const pts = [
        { x: s.x - span, y: s.y - span, z: s.z || 0 },
        { x: s.x + span, y: s.y - span, z: s.z || 0 },
        { x: s.x - span, y: s.y + span, z: s.z || 0 },
        { x: s.x + span, y: s.y + span, z: s.z || 0 }
      ];
      const cam = this._cameraForRotatedBounds(pts, 0.8);
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
      this._drawEcliptic(ctx);

      const reveal = this.nodeReveal();
      const regionAlpha = 1 - smoothstep(0.2, 0.85, reveal);

      if (regionAlpha > 0.01) this._drawRegions(ctx, regionAlpha);
      if (reveal > 0.01) {
        this._drawEdges(ctx, reveal);
        this._drawNodes(ctx, reveal);
      }

      this._emitContext(false);
    }

    /* Nebulose sobrie: niente più compositing additivo (era responsabile
       della saturazione cumulativa), solo gradient morbidi a bassa alpha. */
    _drawNebulae(ctx) {
      ctx.save();
      for (let i = 0; i < this.nebulae.length; i++) {
        const n = this.nebulae[i];
        const p = this.project(n.x, n.y, n.z);
        const rad = n.r * this.scale * p.parallax;
        if (p.x + rad < 0 || p.x - rad > this.cssW || p.y + rad < 0 || p.y - rad > this.cssH) continue;
        const fade = clamp(0.6 + p.depth * 1.6, 0.35, 1.1);
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad);
        g.addColorStop(0, hexA(n.color, n.alpha * fade));
        g.addColorStop(0.55, hexA(n.color, n.alpha * 0.25 * fade));
        g.addColorStop(1, hexA(n.color, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    /* Polvere stellare + poche stelle eroe. Tutto col z dello sfondo,
       quindi ruota col disco e dà la sensazione di volume. */
    _drawDust(ctx) {
      for (let i = 0; i < this.dust.length; i++) {
        const d = this.dust[i];
        const p = this.project(d.x, d.y, d.z);
        if (p.x < 0 || p.x > this.cssW || p.y < 0 || p.y > this.cssH) continue;
        const fade = clamp(0.55 + p.depth * 1.6, 0.3, 1.1);
        ctx.fillStyle = d.warm ? hexA('#ffe6b0', d.alpha * fade) : hexA('#cfe0ff', d.alpha * fade);
        const sz = d.size * (0.85 + p.parallax * 0.5);
        ctx.fillRect(p.x, p.y, sz, sz);
      }
      for (let i = 0; i < this.brightStars.length; i++) {
        const b = this.brightStars[i];
        const p = this.project(b.x, b.y, b.z);
        if (p.x < -40 || p.x > this.cssW + 40 || p.y < -40 || p.y > this.cssH + 40) continue;
        const col = b.warm ? '#ffe6b0' : '#dfeaff';
        // cap del parallax sui dettagli decorativi: evita bloom giganti che
        // saturano la mappa quando il pitch porta una stella vicina al viewer.
        const par = Math.min(p.parallax, 1.3);
        const len = b.len * par * 0.85;
        this._spike(ctx, p.x, p.y, len, col, 0.4);
        const bloomR = 6 * par;
        const bg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, bloomR);
        bg.addColorStop(0, hexA(col, 0.7));
        bg.addColorStop(0.4, hexA(col, 0.16));
        bg.addColorStop(1, hexA(col, 0));
        ctx.fillStyle = bg;
        ctx.beginPath(); ctx.arc(p.x, p.y, bloomR, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.beginPath(); ctx.arc(p.x, p.y, 1.3 * par, 0, Math.PI * 2); ctx.fill();
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

    /* Piano galattico (z=0) come cerchio tratteggiato: ancora di profondità. */
    _drawEcliptic(ctx) {
      const reveal = this.nodeReveal();
      const a = 0.22 + (1 - reveal) * 0.18;
      if (a < 0.04) return;
      const N = 96;
      ctx.save();
      ctx.setLineDash([4, 6]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(140,170,230,' + a + ')';
      ctx.beginPath();
      for (let i = 0; i <= N; i++) {
        const t = (i / N) * Math.PI * 2;
        const wx = 0.5 + Math.cos(t) * 0.46;
        const wy = 0.5 + Math.sin(t) * 0.46;
        const p = this.project(wx, wy, 0);
        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.restore();
    }

    /* Regioni come SACCHE 3D (decisione #21): l'hull del cluster non è
       più un anello piatto sul piano galattico, ma un wireframe che
       mostra l'estensione del gruppo anche in z. Tre "fette" — equatore
       (hull pieno alla z media), tappo superiore e inferiore (hull
       scalato a ~0.55 alla z massima/minima del cluster) — più alcuni
       connettori verticali ai vertici dell'hull. Quando ruoti la
       galassia su qualsiasi asse, le sacche restano coerenti come
       volumi e mostrano da subito chi sta sopra e chi sotto. */
    _drawRegions(ctx, alpha) {
      const groups = this.galaxy.groups;
      const order = groups.slice().sort((a, b) => {
        const pa = this.project(a.cx, a.cy, a.cz || 0);
        const pb = this.project(b.cx, b.cy, b.cz || 0);
        return pa.depth - pb.depth;
      });

      for (let i = 0; i < order.length; i++) {
        const g = order[i];
        const col = groupColor(g.id);
        const isActive = g.id === this.activeGroupId;
        const isHome = g.id === this.galaxy.homeGroupId;
        const isHover = g.id === this.hoverGroup;
        const c = this.project(g.cx, g.cy, g.cz || 0);
        const depthFade = clamp(0.75 + c.depth * 0.8, 0.7, 1.05);

        const zR = Math.max(Math.abs((g.maxZ || 0) - (g.cz || 0)),
                            Math.abs((g.cz || 0) - (g.minZ || 0)), 0.03);
        const baseAlpha = (isActive || isHover ? 0.78 : 0.52) * alpha * depthFade;
        const capAlpha  = (isActive || isHover ? 0.50 : 0.32) * alpha * depthFade;

        if (g.hull && g.hull.length >= 3) {
          // equatore (z = cz, scala 1.0)
          this._drawHullAt(ctx, g, g.cz || 0, 1.0, col, baseAlpha, isActive || isHover ? 2.0 : 1.6);
          // tappi sopra/sotto (scala ridotta → forma "a lente")
          this._drawHullAt(ctx, g, (g.cz || 0) + zR, 0.55, col, capAlpha, 1.2);
          this._drawHullAt(ctx, g, (g.cz || 0) - zR, 0.55, col, capAlpha, 1.2);

          // connettori verticali a ~5-7 vertici equispaziati dell'hull
          const N = g.hull.length;
          const stride = Math.max(1, Math.round(N / 6));
          ctx.save();
          ctx.lineWidth = 1.3;
          ctx.strokeStyle = hexA(col, capAlpha);
          for (let k = 0; k < N; k += stride) {
            const v = g.hull[k];
            const sx = g.cx + (v.x - g.cx);
            const sy = g.cy + (v.y - g.cy);
            const tx = g.cx + (v.x - g.cx) * 0.55;
            const ty = g.cy + (v.y - g.cy) * 0.55;
            const pTop = this.project(tx, ty, (g.cz || 0) + zR);
            const pMid = this.project(sx, sy, g.cz || 0);
            const pBot = this.project(tx, ty, (g.cz || 0) - zR);
            ctx.beginPath();
            ctx.moveTo(pTop.x, pTop.y); ctx.lineTo(pMid.x, pMid.y); ctx.lineTo(pBot.x, pBot.y);
            ctx.stroke();
          }
          ctx.restore();
        }

        // etichetta regione con backdrop scuro + stroke per restare leggibile
        // sopra polvere/nebulose. Sempre frontale (proietta al centroide 3D).
        const labelText = (isHome ? '★ ' : '') + g.name.toUpperCase();
        const subText = g.members.length + ' sistemi';
        ctx.font = '700 15px "Orbitron", "Eurostile", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const m = ctx.measureText(labelText);
        ctx.font = '600 12px "JetBrains Mono", ui-monospace, monospace';
        const m2 = ctx.measureText(subText);
        const bgW = Math.max(m.width, m2.width) + 24, bgH = 40;
        // backdrop più opaco con bordo sottile del colore del gruppo
        ctx.fillStyle = 'rgba(6,8,18,' + (0.82 * alpha) + ')';
        ctx.fillRect(c.x - bgW / 2, c.y - bgH / 2, bgW, bgH);
        ctx.strokeStyle = hexA(col, 0.45 * alpha * depthFade);
        ctx.lineWidth = 1;
        ctx.strokeRect(c.x - bgW / 2 + 0.5, c.y - bgH / 2 + 0.5, bgW - 1, bgH - 1);
        // titolo regione: stroke scuro 3px + fill colore-label brillato
        ctx.font = '700 15px "Orbitron", "Eurostile", system-ui, sans-serif';
        ctx.lineJoin = 'round';
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText(labelText, c.x, c.y - 7);
        const labelCol = isActive || isHover ? '#ffffff' : groupLabelColor(g.id);
        ctx.fillStyle = hexA(labelCol, (isActive || isHover ? 1 : 0.98) * alpha * depthFade);
        ctx.fillText(labelText, c.x, c.y - 7);
        // sottotitolo "N sistemi" mono, anche lui con stroke
        ctx.font = '600 12px "JetBrains Mono", ui-monospace, monospace';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText(subText, c.x, c.y + 11);
        ctx.fillStyle = hexA('#e6edff', 0.95 * alpha * depthFade);
        ctx.fillText(subText, c.x, c.y + 11);
      }
    }

    /* Disegna l'hull del gruppo a una specifica z, scalandolo da `g.cx, g.cy`
       per ottenere la "fetta" desiderata (1.0 = equatore, 0.55 = tappi). */
    _drawHullAt(ctx, g, z, scale, col, alpha, width) {
      ctx.save();
      ctx.setLineDash([4, 5]);
      ctx.lineWidth = width || 1;
      ctx.strokeStyle = hexA(col, alpha);
      ctx.beginPath();
      for (let h = 0; h < g.hull.length; h++) {
        const v = g.hull[h];
        const sx = g.cx + (v.x - g.cx) * scale;
        const sy = g.cy + (v.y - g.cy) * scale;
        const p = this.project(sx, sy, z);
        if (h === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.closePath(); ctx.stroke();
      ctx.restore();
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
        const a = this.project(g.systems[e.a].x, g.systems[e.a].y, g.systems[e.a].z || 0);
        const b = this.project(g.systems[e.b].x, g.systems[e.b].y, g.systems[e.b].z || 0);
        // smorza un po' i tratti che vanno "in profondità"
        const fade = clamp(0.55 + Math.min(a.depth, b.depth) * 1.4, 0.4, 1.0);
        ctx.strokeStyle = known
          ? 'rgba(86,122,220,' + (0.40 * reveal * fade) + ')'
          : 'rgba(86,122,220,' + (0.14 * reveal * fade) + ')';
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }

    /* Nodi con z-sort: lontani prima, vicini sopra. */
    _drawNodes(ctx, reveal) {
      const g = this.galaxy;
      const disc = this.state.discovery;
      const showLabels = reveal > 0.7;
      ctx.globalAlpha = reveal;

      // sistemi con almeno una colonia attiva (oltre al sistema base, evidenziato a parte).
      const colonySys = new Set();
      const colonies = root.ORION.game && root.ORION.game.colonies;
      if (colonies) {
        for (const k in colonies) {
          const c = colonies[k];
          if (!c || !c.colonized) continue;
          const colon = k.indexOf(':');
          if (colon > 0) colonySys.add(k.slice(0, colon));
        }
      }

      // proietta tutti e z-sort
      const items = new Array(g.systems.length);
      for (let i = 0; i < g.systems.length; i++) {
        const s = g.systems[i];
        const p = this.project(s.x, s.y, s.z || 0);
        items[i] = { i: i, p: p };
      }
      items.sort((a, b) => a.p.depth - b.p.depth);   // dietro → davanti

      for (let k = 0; k < items.length; k++) {
        const it = items[k];
        const i = it.i; const p = it.p; const s = g.systems[i];
        if (p.x < -30 || p.x > this.cssW + 30 || p.y < -30 || p.y > this.cssH + 30) continue;

        const d = disc[i];
        const isHome = i === g.homeId;
        const isSel = i === this.state.selectedId;
        const isHover = i === this.hoverSystem;
        const sameCluster = this.hoverCluster >= 0 && s.cluster === this.hoverCluster;

        const r = this.nodeRadius(p.parallax);
        // depth fade: nodi più lontani leggermente più tenui
        // (post-feedback: più piatto, così i sistemi "in fondo" restano leggibili)
        const fade = clamp(0.78 + p.depth * 0.9, 0.7, 1.0);

        if (d === DISCOVERY.UNKNOWN) {
          ctx.fillStyle = 'rgba(120,134,180,' + (0.40 * fade) + ')';
          ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(1.6, r * 0.5), 0, Math.PI * 2); ctx.fill();
          if (isSel || isHover) this._ring(ctx, p, r + 4, 'rgba(154,166,204,0.6)');
          continue;
        }

        // anello sottile di pericolo (§5.3) — niente alone sfocato
        const dcol = this._dangerColor(s.danger, fade);
        this._ring(ctx, p, r + 2.5, dcol, 1);

        // corpo della stella (colore = tipo); depth fade
        const col = starColor(g, s.star);
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = col; ctx.globalAlpha = reveal * fade;
        ctx.fill();
        ctx.globalAlpha = reveal;

        if (d === DISCOVERY.DETECTED) {
          ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(6,9,22,0.4)'; ctx.fill();
        }

        // highlight cluster all'hover (aiuta a capire l'appartenenza)
        if (sameCluster && !isHover) {
          const gc = groupColor(s.cluster);
          this._ring(ctx, p, r + 4.5, hexA(gc, 0.55), 1);
        }

        if (isHome) { this._ring(ctx, p, r + 5, '#2fe6e0', 1.5); this._ring(ctx, p, r + 8.5, 'rgba(47,230,224,0.5)', 1); }
        else if (colonySys.has(s.id)) {
          // colonia secondaria: anello caldo discreto + glifo ◉
          this._ring(ctx, p, r + 5, '#ff9d3c', 1.4);
          this._ring(ctx, p, r + 8, 'rgba(255,157,60,0.45)', 1);
        }
        if (isSel) this._reticle(ctx, p, r + 7, '#ff9d3c');
        else if (isHover) this._ring(ctx, p, r + 6, 'rgba(216,226,255,0.85)', 1.5);

        const hasColony = colonySys.has(s.id);
        if (d >= DISCOVERY.DETECTED && (showLabels || isHome || isSel || isHover || hasColony)) {
          this._label(ctx, p, s.name, r, isSel || isHover || isHome || hasColony, fade);
        }
      }
      ctx.globalAlpha = 1;
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

    _label(ctx, p, text, r, strong, fade) {
      ctx.font = (strong ? '700 ' : '600 ') + '12px "JetBrains Mono", ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const y = p.y + r + 5;
      const a = (strong ? 1 : 0.88) * (fade == null ? 1 : fade);
      // stroke scuro al posto del solo shadowBlur: più contrasto sui campi nebulosa
      ctx.lineJoin = 'round';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.88)';
      ctx.strokeText(text, p.x, y);
      ctx.fillStyle = strong ? 'rgba(240,246,255,' + a + ')' : 'rgba(204,216,250,' + a + ')';
      ctx.fillText(text, p.x, y);
    }

    _dangerColor(d, fade) {
      const a = 0.7 * (fade == null ? 1 : fade);
      const ah = 0.75 * (fade == null ? 1 : fade);
      const ax = 0.8 * (fade == null ? 1 : fade);
      if (d <= 25) return 'rgba(79,224,138,' + a + ')';
      if (d <= 50) return 'rgba(255,202,85,' + a + ')';
      if (d <= 75) return 'rgba(255,157,60,' + ah + ')';
      return 'rgba(255,92,108,' + ax + ')';
    }
  }

  root.ORION = root.ORION || {};
  root.ORION.GalaxyMap = GalaxyMap;
})(typeof window !== 'undefined' ? window : this);
