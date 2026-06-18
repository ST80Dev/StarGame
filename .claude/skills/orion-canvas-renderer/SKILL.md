---
name: orion-canvas-renderer
description: Creare un nuovo renderer Canvas 2D in Orion Empires col pattern canonico (render on-demand senza rAF loop, ResizeObserver, devicePixelRatio cap 2.5, backing-store vs CSS size, Pointer Events unificati mouse+touch, pinch-zoom, hit-testing). Usa quando aggiungi una vista grafica su <canvas> (mappa, scena sistema/pianeta, diagramma) o tocchi galaxy-map.js/system-view.js/planet-view.js. PRIMA leggi UI_GUIDE.md.
---

# Creare un renderer Canvas

⚠️ **Leggi `UI_GUIDE.md` prima** (R2). Vincoli progetto: **no WebGL**, solo Canvas 2D, render
**on-demand** (niente `requestAnimationFrame` loop continuo). I tre renderer esistenti
(`js/galaxy-map.js`, `js/system-view.js`, `js/planet-view.js`) condividono ~110-130 righe di
boilerplate identico: replica quel sottoinsieme.

## Scheletro (classe)
```js
class MyRenderer {
  constructor(container) {
    this.container = container;
    this.canvas = document.createElement('canvas');
    this.canvas.style.touchAction = 'none';        // indispensabile per pinch/pan touch
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.cssW = 0; this.cssH = 0; this.dpr = 1;
    this._needsRender = false; this._raf = 0;
    this.pointers = new Map(); this.lastPinchDist = 0;
    this._onResize = this.resize.bind(this);

    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(this._onResize);
      this._ro.observe(container);
    } else {
      window.addEventListener('resize', this._onResize);
    }
    this._bindEvents();
    this.resize();
  }

  /* --- SIZING: DPR cap 2.5, backing store separato dalla CSS size --- */
  resize() {
    if (!this.canvas || !this.container) return;
    const rect = this.container.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);     // ← CAP 2.5 obbligatorio
    this.cssW = w; this.cssH = h;
    this.canvas.width = Math.round(w * this.dpr);               // backing store (px reali)
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = w + 'px';                         // CSS size (px logici)
    this.canvas.style.height = h + 'px';
    this.requestRender();
  }

  /* --- RENDER ON-DEMAND: guard anti-duplicato, niente loop continuo --- */
  requestRender() {
    if (this._needsRender) return;
    this._needsRender = true;
    this._raf = requestAnimationFrame(this.render.bind(this));
  }
  render() {
    this._needsRender = false;
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);          // scala per DPR
    ctx.clearRect(0, 0, this.cssW, this.cssH);                 // pulisci in coord CSS, non backing
    // ... draw in coordinate CSS (cssW × cssH) ...
  }

  destroy() {
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    else window.removeEventListener('resize', this._onResize);
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this.canvas) this.canvas.replaceWith(this.canvas.cloneNode(false)); // stacca i listener
    this.canvas = null; this.ctx = null;
  }
}
```

## Input: Pointer Events unificati (mouse + touch)
```js
_bindEvents() {
  const c = this.canvas;
  c.addEventListener('pointerdown',  this._onPointerDown.bind(this));
  c.addEventListener('pointermove',  this._onPointerMove.bind(this));
  c.addEventListener('pointerup',    this._onPointerUp.bind(this));
  c.addEventListener('pointercancel',this._onPointerUp.bind(this));
  c.addEventListener('pointerleave', this._onPointerLeave.bind(this));
  c.addEventListener('wheel',        this._onWheel.bind(this), { passive: false });
  c.addEventListener('dblclick',     this._onDblClick.bind(this));
}
_localPos(e) {
  const rect = this.canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };  // coord CSS, allineate al render
}
```
- In `pointerdown`: `this.canvas.setPointerCapture(e.pointerId)` e registra in `this.pointers`.
- **Niente handler hover-only**: il touch non ha hover (UI_GUIDE / vincoli input).
- **Pinch a 2 dita**: quando `this.pointers.size === 2`, calcola distanza/centro tra i due punti e
  zooma sul centro; aggiorna `lastPinchDist`; `requestRender()`. (Modello in `galaxy-map.js`.)

## Hit-testing (selezione marker)
Picking circolare "il più vicino entro il raggio", in coordinate CSS:
```js
pick(sx, sy, items, radiusFn) {
  let best = null, bestD = Infinity;
  for (const it of items) {
    const p = this.project(it.x, it.y);     // world → screen (la tua proiezione)
    const r = radiusFn(it) + 7;             // padding tocco
    const dx = p.x - sx, dy = p.y - sy, d = dx * dx + dy * dy;
    if (d <= r * r && d < bestD) { bestD = d; best = it; }
  }
  return best;
}
```

## Helper di disegno ricorrenti
```js
// hex → rgba (presente identico in tutti e 3 i renderer)
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return 'rgba(' + ((n>>16)&255) + ',' + ((n>>8)&255) + ',' + (n&255) + ',' + a + ')';
}
// bloom/glow radiale
function bloom(ctx, cx, cy, r, color, alpha) {
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0,   hexA(color, alpha * 0.7));
  g.addColorStop(0.4, hexA(color, alpha * 0.16));
  g.addColorStop(1,   hexA(color, 0));
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2); ctx.fill();
}
```
**Backdrop deterministico** (polvere/stelle): genera da `ORION.rng.makeRng(seed + ':bg')` — stesso
seed → stesso starfield (decisione #5). Mai `Math.random` (vedi skill `orion-new-module`).

## Errori da evitare
- Dimenticare il **cap 2.5** sul DPR → backing store enorme su display HiDPI.
- Mischiare **backing store** (`canvas.width`) e **CSS size** (`canvas.style.width`): disegna sempre
  in coord CSS dopo `setTransform(dpr,…)`; `clearRect` usa `cssW/cssH`.
- Chiamare `render()` diretto invece di `requestRender()` → render duplicati nello stesso frame
  (eccezione: il tick di un'animazione camera in volo).
- `_localPos` con coordinate non allineate al render (usa `getBoundingClientRect`, non offset DOM).
- Lasciare `requestAnimationFrame` in loop continuo → viola "render on-demand".
- Niente `touch-action: none` sul canvas → il browser intercetta pan/pinch.

## Checklist
- [ ] letto UI_GUIDE.md
- [ ] `resize()` con DPR cap 2.5 + backing/CSS distinti + ResizeObserver (fallback `resize`)
- [ ] `requestRender()` con guard + `render()` con `setTransform(dpr)` + `clearRect(cssW,cssH)`
- [ ] Pointer Events unificati + `setPointerCapture` + `_localPos` in coord CSS
- [ ] pinch-zoom 2 dita, `touch-action: none`
- [ ] hit-testing circolare entro raggio
- [ ] backdrop/RNG deterministico dal seed
- [ ] `destroy()` che disconnette RO, cancella rAF, stacca i listener
