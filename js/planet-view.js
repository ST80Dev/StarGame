/* =====================================================================
   ORION EMPIRES — planet-view.js
   Modulo M04: vista PIANETA su Canvas 2D (GDD §6.2/§7/§8/§9/§10).

   È il livello "Pianeta" della navigazione gerarchica (§5.5, decisione
   #9). Si monta sopra lo stage come SystemView in M03 (un layer dentro
   `.galaxy-root`), così breadcrumb e pannello destro restano coerenti.

   Resa (decisione #16, evoluzione di system-view.js):
     - per ogni corpo si BAKERIA una sfera procedurale su offscreen canvas:
         · noise 3D hash-based (FBM 3 ottave) campionato in coordinate
           sferiche → texture diversa per ogni pianeta, deterministica
           dal seed del corpo;
         · lighting diffuso (N·L) + specular su mari/ghiacciai + leggero
           limb darkening + dettagli per tipo (nuvole, tempeste su
           gassosi, crepe di lava, calotte e creste sul ghiacciato,
           crateri irregolari sulla luna);
         · bordo atmosfera e terminatore "morbido" (gradient).
     - il bake si fa UNA VOLTA all'apertura e si blitta a runtime con
       `drawImage` (costo zero, render on-demand).
     - le lune del pianeta si vedono in piccolo in orbita statica
       attorno al pianeta nel medesimo canvas.

   Vincoli costanti (decisione #6): Canvas responsivo (ResizeObserver +
   devicePixelRatio) e input unificato mouse/touch (Pointer Events).
   ===================================================================== */
'use strict';

(function (root) {
  const makeRng = root.ORION.rng.makeRng;
  const BODY_TYPES = root.ORION.system.BODY_TYPES;
  const GAS_VARIANTS = root.ORION.system.GAS_VARIANTS;

  const clamp = root.ORION.util.clamp;
  const lerp = root.ORION.util.lerp;
  function smooth(t) { return t * t * (3 - 2 * t); }

  /* ------------------------------------------------------------------
     Noise 3D hash-based. Niente Perlin "vero" (basta value noise), ma
     deterministico e abbastanza ricco per superfici planetarie.
     ------------------------------------------------------------------ */
  function hash3(ix, iy, iz, seed) {
    let h = ix * 374761393 + iy * 668265263 + iz * 2147483647 ^ seed;
    h = (h ^ (h >>> 13)) * 1274126177;
    h = h ^ (h >>> 16);
    // float in [0,1)
    return (h >>> 0) / 4294967296;
  }
  function vnoise3(x, y, z, seed) {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const fx = x - ix, fy = y - iy, fz = z - iz;
    const u = smooth(fx), v = smooth(fy), w = smooth(fz);
    const c000 = hash3(ix,     iy,     iz,     seed);
    const c100 = hash3(ix + 1, iy,     iz,     seed);
    const c010 = hash3(ix,     iy + 1, iz,     seed);
    const c110 = hash3(ix + 1, iy + 1, iz,     seed);
    const c001 = hash3(ix,     iy,     iz + 1, seed);
    const c101 = hash3(ix + 1, iy,     iz + 1, seed);
    const c011 = hash3(ix,     iy + 1, iz + 1, seed);
    const c111 = hash3(ix + 1, iy + 1, iz + 1, seed);
    const x00 = lerp(c000, c100, u);
    const x10 = lerp(c010, c110, u);
    const x01 = lerp(c001, c101, u);
    const x11 = lerp(c011, c111, u);
    const y0  = lerp(x00, x10, v);
    const y1  = lerp(x01, x11, v);
    return lerp(y0, y1, w);
  }
  function fbm3(x, y, z, seed, octaves) {
    let amp = 0.5, freq = 1.0, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * vnoise3(x * freq, y * freq, z * freq, seed + o * 131);
      norm += amp;
      amp *= 0.5; freq *= 2.04;
    }
    return sum / norm;   // [0,1]
  }

  /* Hex → [r,g,b]. */
  function hexRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function mixRgb(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }
  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /* ------------------------------------------------------------------
     Campionamento del colore di superficie per tipo. La normale (dx,dy,dz)
     è già normalizzata; il sample si fa in coordinate sferiche con un
     piccolo "twist" sull'asse del pianeta (axial tilt deterministico).
     Restituisce { rgb, kSpec, kRough }:
       rgb    colore base [r,g,b] 0-255
       kSpec  coefficiente specular (0=opaco, 1=lucido)
       kRough perturbazione del normale ("rilievo") 0-1
     ------------------------------------------------------------------ */
  function sampleSurface(type, nx, ny, nz, seedNum, palette, body) {
    // twist: ruota l'asse del pianeta di un piccolo tilt
    const tilt = (body.tilt || 0) % Math.PI;
    const cs = Math.cos(tilt), sn = Math.sin(tilt);
    const ty = ny * cs - nz * sn;
    const tz = ny * sn + nz * cs;
    const tx = nx;

    const lat = Math.asin(ty);              // -π/2..π/2
    const lon = Math.atan2(tx, tz);         // -π..π
    const u = (lon / Math.PI) * 2.5;        // ripetizione orizzontale ~2x
    const v = (lat / Math.PI) * 2.5;

    if (type === 'gassoso') {
      const variant = body.variant || 0;
      const V = GAS_VARIANTS[variant];
      const base = hexRgb(V.base);
      const alt = hexRgb(V.alt);
      const spot = hexRgb(V.spot);
      // bande orizzontali (in lat) + turbolenza
      const band = 0.5 + 0.5 * Math.sin(lat * 8 + fbm3(u * 1.2, v * 4.0, 0.2, seedNum, 3) * 2.2);
      let col = mixRgb(base, alt, band);
      // grande macchia
      const blob = fbm3(u * 1.3, v * 1.3, 1.7, seedNum + 999, 3);
      if (blob > 0.72) col = mixRgb(col, spot, (blob - 0.72) * 3);
      return { rgb: col, kSpec: 0.05, kRough: 0.05 };
    }

    if (type === 'cintura') {
      const rock = hexRgb('#b6a888');
      return { rgb: rock, kSpec: 0, kRough: 0.2 };
    }

    // pianeti rocciosi: noise di "altezza" → mare vs. terra
    const cont = fbm3(u, v, 0.0, seedNum, 4);
    const detail = fbm3(u * 4.0, v * 4.0, 1.3, seedNum + 51, 3);
    const h = cont * 0.8 + detail * 0.2;

    const sea  = hexRgb(palette.sea);
    const land = hexRgb(palette.land);
    const accent = hexRgb(palette.accent || palette.land);

    if (type === 'oceanico') {
      // soprattutto mare, atolli sparsi
      if (h < 0.62) {
        const deep = mixRgb(sea, [0, 8, 32], 0.4 * (0.62 - h));
        return { rgb: deep, kSpec: 0.55, kRough: 0.02 };
      }
      if (h < 0.7) return { rgb: mixRgb(sea, accent, 0.6), kSpec: 0.25, kRough: 0.1 };
      return { rgb: mixRgb(land, accent, 0.3), kSpec: 0.05, kRough: 0.4 };
    }

    if (type === 'desertico') {
      // dune con striature
      const dune = mixRgb(sea, land, 0.4 + 0.6 * h);
      const streak = Math.sin(lat * 18 + fbm3(u * 3, v * 3, 4.0, seedNum, 2) * 4) * 0.08;
      return { rgb: mixRgb(dune, accent, clamp(0.2 + streak, 0, 0.5)), kSpec: 0.04, kRough: 0.5 };
    }

    if (type === 'ghiacciato') {
      // mare di ghiaccio + creste; calotte gestite globalmente sotto
      const ice = mixRgb([200, 220, 240], [240, 248, 255], 0.4 + 0.6 * h);
      const crack = fbm3(u * 6, v * 6, 2, seedNum + 13, 2);
      const cracked = mixRgb(ice, [120, 160, 200], (crack > 0.65 ? 0.3 : 0));
      return { rgb: cracked, kSpec: 0.45, kRough: 0.25 };
    }

    if (type === 'vulcanico') {
      // crosta scura + crepe luminescenti
      const crust = mixRgb([20, 8, 4], [80, 30, 20], h);
      const lava = fbm3(u * 7, v * 7, 3, seedNum + 71, 3);
      if (lava > 0.78) {
        const glow = mixRgb([255, 140, 40], [255, 220, 120], (lava - 0.78) * 5);
        return { rgb: glow, kSpec: 0.0, kRough: 0.4, emissive: (lava - 0.78) * 2.4 };
      }
      return { rgb: crust, kSpec: 0.04, kRough: 0.6 };
    }

    if (type === 'forestale') {
      // verdi densi, fiumi sparsi
      if (h < 0.45) return { rgb: mixRgb(sea, land, 0.3), kSpec: 0.35, kRough: 0.1 };
      const dense = mixRgb([30, 60, 36], [80, 130, 60], h);
      const veins = fbm3(u * 8, v * 8, 5, seedNum + 19, 2);
      if (veins > 0.74) return { rgb: mixRgb(dense, [50, 110, 160], 0.5), kSpec: 0.25, kRough: 0.2 };
      return { rgb: mixRgb(dense, accent, 0.2), kSpec: 0.05, kRough: 0.4 };
    }

    if (type === 'luna') {
      // maria + crateri (i crateri si aggiungono come strato separato dopo)
      const regolith = mixRgb([90, 92, 98], [180, 184, 192], h);
      const maria = fbm3(u * 1.5, v * 1.5, 0.5, seedNum + 5, 3);
      if (maria > 0.62) return { rgb: mixRgb(regolith, [55, 56, 64], 0.5), kSpec: 0.02, kRough: 0.3 };
      return { rgb: regolith, kSpec: 0.05, kRough: 0.4 };
    }

    // default: terrestre — mari/continenti + accenti
    if (h < 0.52) {
      const deep = mixRgb(sea, [0, 16, 40], (0.52 - h) * 0.6);
      return { rgb: deep, kSpec: 0.55, kRough: 0.02 };
    }
    if (h < 0.58) {
      return { rgb: mixRgb(sea, accent, 0.45), kSpec: 0.2, kRough: 0.15 };
    }
    const veg = mixRgb(land, accent, clamp(0.3 + (h - 0.58) * 1.4, 0, 0.6));
    return { rgb: veg, kSpec: 0.05, kRough: 0.4 };
  }

  /* ------------------------------------------------------------------
     BAKE della sfera planetaria. Restituisce un offscreen canvas che
     contiene un disco texturato e illuminato dello stesso `size` (px).
     Il blit avviene poi via drawImage (zero costo runtime).
     `lightDir`: vettore 3D (lx,ly,lz) normalizzato — direzione della luce
     (verso la stella). lz positivo = verso l'osservatore.
     ------------------------------------------------------------------ */
  function bakeSphere(planet, body, size, lightDir, opts) {
    opts = opts || {};
    const off = document.createElement('canvas');
    off.width = size; off.height = size;
    const octx = off.getContext('2d');
    const img = octx.createImageData(size, size);
    const data = img.data;

    const cx = size / 2, cy = size / 2;
    const r = size * 0.46;
    const def = BODY_TYPES[body.type] || BODY_TYPES.terrestre;
    const palette = def.palette || {};
    const seedNum = (function () {
      // hash del seed string in un intero
      let h = 2166136261;
      const s = planet.seed || body.seed || body.name;
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
      return h | 0;
    })();

    const lx = lightDir[0], ly = lightDir[1], lz = lightDir[2];

    // pre-calcoli per calotte polari, nuvole, luci notturne
    const hasIceCaps = !!palette.iceCaps;
    const hasCraters = !!palette.craters;
    const hasClouds = (body.type === 'terrestre' || body.type === 'oceanico' || body.type === 'forestale') && !opts.noClouds;
    const showNightLights = !!opts.nightLights;

    // crateri: lista deterministica (per le lune)
    let craters = [];
    if (hasCraters) {
      const cRng = makeRng((planet.seed || body.seed) + ':craters');
      const cN = cRng.int(8, 16);
      for (let i = 0; i < cN; i++) {
        // posizione in coordinate sferiche
        const cLat = cRng.range(-1.3, 1.3), cLon = cRng.range(-Math.PI, Math.PI);
        const cR = cRng.range(0.05, 0.14);   // raggio relativo alla sfera
        craters.push({ lat: cLat, lon: cLon, r: cR, rim: cRng.range(0.85, 1.05) });
      }
    }

    // bake pixel-per-pixel
    for (let py = 0; py < size; py++) {
      const dy = (py - cy) / r;
      for (let px = 0; px < size; px++) {
        const dx = (px - cx) / r;
        const d2 = dx * dx + dy * dy;
        const idx = (py * size + px) * 4;
        if (d2 >= 1) { data[idx + 3] = 0; continue; }
        const dz = Math.sqrt(1 - d2);

        // campiona superficie
        const samp = sampleSurface(body.type, dx, dy, dz, seedNum, palette, body);
        let rgb = samp.rgb;
        let kSpec = samp.kSpec;
        const emissive = samp.emissive || 0;

        // crateri (lune): se il punto cade dentro un cratere, scurisci
        if (hasCraters && craters.length) {
          // converti il punto in coords sferiche per confronto angolare
          const tilt = (body.tilt || 0) % Math.PI;
          const cs = Math.cos(tilt), sn = Math.sin(tilt);
          const ty = dy * cs - dz * sn, tz = dy * sn + dz * cs, tx = dx;
          const lat = Math.asin(ty), lon = Math.atan2(tx, tz);
          for (let i = 0; i < craters.length; i++) {
            const c = craters[i];
            const dLat = lat - c.lat;
            let dLon = lon - c.lon;
            if (dLon > Math.PI) dLon -= 2 * Math.PI;
            if (dLon < -Math.PI) dLon += 2 * Math.PI;
            const dd = Math.sqrt(dLat * dLat + dLon * dLon);
            if (dd < c.r * c.rim) {
              const t = dd / c.r;
              if (t < 0.85) rgb = mixRgb(rgb, [40, 42, 50], 0.55 * (1 - t));
              else rgb = mixRgb(rgb, [220, 222, 230], 0.45);   // bordo chiaro
              break;
            }
          }
        }

        // calotte polari
        if (hasIceCaps) {
          const polar = Math.abs(dy);
          if (polar > 0.78) {
            const t = clamp((polar - 0.78) / 0.22, 0, 1);
            rgb = mixRgb(rgb, [245, 250, 255], t);
            kSpec = 0.35;
          }
        }

        // nuvole (terrestri/oceanici/forestali)
        if (hasClouds) {
          const cl = fbm3(dx * 3.2, dy * 3.2, 5.7, seedNum + 217, 3);
          if (cl > 0.6) {
            const a = clamp((cl - 0.6) * 2.0, 0, 0.85);
            rgb = mixRgb(rgb, [250, 252, 255], a);
            kSpec = Math.max(kSpec - 0.1, 0);
          }
        }

        // lighting (Lambert + specular)
        const ndotl = dx * lx + dy * ly + dz * lz;
        const ambient = 0.12;
        let diffuse = Math.max(0, ndotl);
        // morbidezza al terminatore
        diffuse = Math.pow(diffuse, 0.9);
        let light = ambient + 0.95 * diffuse;

        let specular = 0;
        if (kSpec > 0 && diffuse > 0) {
          // riflesso sub-stellare: half-vector verso (0,0,1) → spec = (N·H)^k
          const hx = lx, hy = ly, hz = lz + 1;
          const hl = Math.sqrt(hx * hx + hy * hy + hz * hz) || 1;
          const ndh = Math.max(0, (dx * hx + dy * hy + dz * hz) / hl);
          specular = Math.pow(ndh, 24) * kSpec;
        }

        // luci della città (lato notte) per pianeti colonizzati
        let nightR = 0, nightG = 0, nightB = 0;
        if (showNightLights && diffuse < 0.15 && body.type !== 'gassoso') {
          const lights = fbm3(dx * 12, dy * 12, 9.0, seedNum + 333, 3);
          if (lights > 0.66) {
            const ll = (lights - 0.66) * 3.5 * (0.15 - diffuse) * 6;
            nightR = 220 * ll; nightG = 180 * ll; nightB = 90 * ll;
          }
        }

        let R = rgb[0] * light + specular * 255 + emissive * 220 + nightR;
        let G = rgb[1] * light + specular * 240 + emissive * 140 + nightG;
        let B = rgb[2] * light + specular * 255 + emissive *  60 + nightB;

        // limb darkening (più scuro vicino al bordo)
        const limb = 0.55 + 0.45 * dz;
        R *= limb; G *= limb; B *= limb;

        data[idx]     = clamp(R, 0, 255);
        data[idx + 1] = clamp(G, 0, 255);
        data[idx + 2] = clamp(B, 0, 255);
        // antialias circolare sul bordo
        const edge = clamp((1 - d2) * 50, 0, 1);
        data[idx + 3] = 255 * edge;
      }
    }
    octx.putImageData(img, 0, 0);
    return off;
  }

  /* ==================================================================
     PlanetView
     ================================================================== */
  class PlanetView {
    constructor() {
      this.canvas = null;
      this.ctx = null;
      this.container = null;
      this.system = null;
      this.body = null;
      this.planet = null;
      this.colony = null;
      this.onExit = null;
      this.onSelectMoon = null;
      this._navCdUntil = 0;            // decisione #80: cooldown tra livelli

      this.cssW = 0; this.cssH = 0; this.dpr = 1;
      this.scale = 1;       // moltiplicatore del raggio "fit"
      this.offX = 0; this.offY = 0;
      this.fitR = 1;

      this.tex = null;       // offscreen canvas del pianeta
      this.moonTex = [];     // [{key, canvas, radius, orbit, angle}]
      this.lightDir = [0.7, -0.4, 0.59];
      this.dust = [];

      this.pointers = new Map();
      this.dragging = false;
      this.dragMoved = false;
      this.lastPinchDist = 0;
      this.hoverMoonKey = null;

      this._onResize = this.resize.bind(this);
      this._raf = 0;
      this._needsRender = false;
    }

    mount(container, system, body, planet, colony, opts) {
      opts = opts || {};
      this.container = container;
      this.system = system;
      this.body = body;
      this.planet = planet;
      this.colony = colony;
      this.onExit = opts.onExit || null;
      this.onSelectMoon = opts.onSelectMoon || null;

      container.innerHTML = '';
      const canvas = document.createElement('canvas');
      canvas.className = 'planet-canvas';
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', 'Vista del pianeta ' + body.name);
      canvas.style.touchAction = 'none';
      container.appendChild(canvas);

      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');

      this._computeLightDir();
      this._bake();
      this._buildDust();
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
      if (this.canvas) this.canvas.replaceWith(this.canvas.cloneNode(false));
      this.canvas = null;
      this.ctx = null;
      this.tex = null;
      this.moonTex = [];
    }

    /* Re-bake (es. quando la colonia abilita luci notturne). */
    refresh(colony) {
      this.colony = colony || this.colony;
      this._bake();
      this.requestRender();
    }

    /* Decisione #66: geometria proiettata della sfera (px, py centrali +
       raggio R + lightDir). Letta dal PlanetOverlay per posizionare i
       marker SVG strutture in coordinate schermo coerenti col bake. */
    getSphereGeometry() {
      const cx = this.cssW / 2;
      const cy = this.cssH / 2 + (this._cyOffset || 0);
      const R = this.fitR * this.scale;
      return {
        px: cx + this.offX,
        py: cy + this.offY,
        R: R,
        cssW: this.cssW,
        cssH: this.cssH,
        lightDir: this.lightDir ? this.lightDir.slice() : [0, 0, 1]
      };
    }

    _computeLightDir() {
      // luce dalla stella verso il pianeta: la direzione 2D nello spazio
      // del sistema è (-px, -py) normalizzata; aggiungiamo una componente
      // z positiva (osservatore davanti) per dare l'illuminazione frontale.
      const wp = (function () {
        const b = this.body;
        if (b.parentKey) {
          const parent = root.ORION.system.findBody(this.system, b.parentKey);
          const px = parent ? Math.cos(parent.angle) * parent.orbit : 0;
          const py = parent ? Math.sin(parent.angle) * parent.orbit : 0;
          return { x: px + Math.cos(b.angle) * b.moonOrbit, y: py + Math.sin(b.angle) * b.moonOrbit };
        }
        return { x: Math.cos(b.angle) * b.orbit, y: Math.sin(b.angle) * b.orbit };
      }).call(this);
      const d = Math.hypot(wp.x, wp.y) || 1;
      const lx = -wp.x / d, ly = -wp.y / d;
      // proiezione 3D: la luce ha una componente z fissa positiva
      const lz = 0.55;
      const ln = Math.sqrt(lx * lx + ly * ly + lz * lz);
      this.lightDir = [lx * 0.85 / ln + lx * 0.0, ly * 0.85 / ln, lz / ln];
      // riscalo per avere modulo 1
      const m = Math.hypot.apply(null, this.lightDir) || 1;
      this.lightDir = [this.lightDir[0] / m, this.lightDir[1] / m, this.lightDir[2] / m];
    }

    _bake() {
      const SZ = 360;   // risoluzione del bake (offscreen)
      const nightLights = !!(this.colony && this.colony.colonized);
      this.tex = bakeSphere(this.planet, this.body, SZ, this.lightDir,
        { nightLights: nightLights });

      // lune (in piccolo) — solo se il corpo principale le ha
      this.moonTex = [];
      if (this.body.moons && this.body.moons.length) {
        for (let i = 0; i < this.body.moons.length; i++) {
          const m = this.body.moons[i];
          const fakePlanet = { seed: m.seed + ':planet', advanced: [] };
          // luna eredita una palette generica (palette del tipo "luna")
          const sz = 96;
          const cv = bakeSphere(fakePlanet, m, sz, this.lightDir, { noClouds: true });
          this.moonTex.push({
            key: m.key, name: m.name, canvas: cv,
            radius: 0.10 + i * 0.018,             // raggio visivo relativo al pianeta
            orbit: 0.78 + i * 0.18,               // orbita relativa al raggio pianeta
            angle: m.angle
          });
        }
      }
    }

    _buildDust() {
      const rng = makeRng((this.planet.seed || this.body.seed) + ':vbg');
      this.dust = [];
      for (let i = 0; i < 220; i++) {
        const m = Math.pow(rng.float(), 3);
        this.dust.push({
          x: rng.range(-1.6, 1.6), y: rng.range(-1.0, 1.0),
          size: 0.4 + m * 1.4, alpha: 0.10 + m * 0.55,
          warm: rng.chance(0.35)
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
      /* M07.2 iter 3: la sfera si dimensiona sull'altezza EFFETTIVA della
         scena (centrale) — sottrae top breadcrumb (~56px) e bottom band
         del deck (popolazione+strutture+cronaca, ~190px) se il deck è
         montato. cy viene shiftato verso l'alto della metà del reserve
         così la sfera resta visivamente al centro della porzione visibile.
         Misura il deck via DOM se presente. */
      const topReserve = 56;
      let bottomReserve = 0;
      const deck = document.querySelector('.colony-deck:not([hidden])');
      if (deck) {
        const struct = deck.querySelector('.deck-structures');
        if (struct) bottomReserve = struct.getBoundingClientRect().height + 18;
        else bottomReserve = 190; /* fallback se misurazione non disponibile */
      }
      const effH = Math.max(140, h - topReserve - bottomReserve);
      this.fitR = Math.min(w, effH) * 0.36;
      this._cyOffset = -bottomReserve / 2 + topReserve / 2;
      if (!hadFit) this.resetView();
      this.requestRender();
    }

    resetView() {
      this.scale = 1;
      this.offX = 0; this.offY = 0;
      this.requestRender();
    }

    /* ---- input ---- */
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
      this.pointers.set(e.pointerId, this._localPos(e));
      this.dragging = true; this.dragMoved = false;
      if (this.pointers.size === 2) this.lastPinchDist = this._pinchDist();
    }
    _onPointerMove(e) {
      const p = this._localPos(e);
      if (!this.pointers.has(e.pointerId)) {
        const mk = this._pickMoon(p.x, p.y);
        if (mk !== this.hoverMoonKey) {
          this.hoverMoonKey = mk;
          this.canvas.style.cursor = mk ? 'pointer' : 'grab';
          this.requestRender();
        }
        return;
      }
      const prev = this.pointers.get(e.pointerId);
      this.pointers.set(e.pointerId, p);
      if (this.pointers.size === 2) {
        const d = this._pinchDist();
        if (this.lastPinchDist > 0) {
          const k = d / this.lastPinchDist;
          /* decisione #80 — pinch-out contro il muro → risali al sistema. */
          if (k < 1 && this.scale <= 0.5 + 1e-3 && this._navReady() && this.onExit) {
            this._armNavCd(); this.onExit(); return;
          }
          this.scale = clamp(this.scale * k, 0.5, 3.5);
        }
        this.lastPinchDist = d;
        this.dragMoved = true;
        this.requestRender();
        return;
      }
      const dx = p.x - prev.x, dy = p.y - prev.y;
      if (Math.abs(dx) + Math.abs(dy) > 1) this.dragMoved = true;
      this.offX += dx; this.offY += dy;
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
        const mk = this._pickMoon(p.x, p.y);
        if (mk && this.onSelectMoon) this.onSelectMoon(mk);
      }
    }
    _onPointerLeave() { if (this.hoverMoonKey) { this.hoverMoonKey = null; this.requestRender(); } }
    _navReady() { return this._now() >= this._navCdUntil; }
    _armNavCd() { this._navCdUntil = this._now() + 450; }
    _now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

    _onWheel(e) {
      e.preventDefault();
      const k = Math.pow(1.0015, -e.deltaY);
      /* decisione #80 — contro il muro dello zoom OUT → risali al sistema. */
      if (k < 1 && this.scale <= 0.5 + 1e-3 && this._navReady() && this.onExit) {
        this._armNavCd(); this.onExit(); return;
      }
      this.scale = clamp(this.scale * k, 0.5, 3.5);
      this.requestRender();
    }
    _onDblClick(e) {
      e.preventDefault();
      const p = this._localPos(e);
      const mk = this._pickMoon(p.x, p.y);
      if (mk && this.onSelectMoon) { this.onSelectMoon(mk); return; }
      if (this.onExit) this.onExit();
    }
    _pinchDist() {
      const pts = Array.from(this.pointers.values());
      const dx = pts[0].x - pts[1].x, dy = pts[0].y - pts[1].y;
      return Math.sqrt(dx * dx + dy * dy);
    }
    _pickMoon(sx, sy) {
      if (!this.moonTex.length) return null;
      const r = this.fitR * this.scale;
      const cx = this.cssW / 2 + this.offX, cy = this.cssH / 2 + (this._cyOffset || 0) + this.offY;
      for (let i = 0; i < this.moonTex.length; i++) {
        const m = this.moonTex[i];
        const mx = cx + Math.cos(m.angle) * r * m.orbit;
        const my = cy + Math.sin(m.angle) * r * m.orbit;
        const mr = r * m.radius;
        const dx = sx - mx, dy = sy - my;
        if (dx * dx + dy * dy <= (mr + 8) * (mr + 8)) return m.key;
      }
      return null;
    }

    /* ---- render ---- */
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

      // sfondo: polvere stellare. cy shiftato verso l'alto in base al
      // reserve del deck (M07.2 iter 3) — la sfera resta al centro della
      // porzione visibile, non del canvas raw.
      const cx = this.cssW / 2, cy = this.cssH / 2 + (this._cyOffset || 0);
      for (let i = 0; i < this.dust.length; i++) {
        const d = this.dust[i];
        const x = cx + d.x * this.fitR * 1.6;
        const y = cy + d.y * this.fitR * 1.6;
        ctx.fillStyle = d.warm ? hexA('#ffe6b0', d.alpha) : hexA('#cfe0ff', d.alpha);
        ctx.fillRect(x, y, d.size, d.size);
      }

      // raggio del pianeta (fit + zoom + offset)
      const R = this.fitR * this.scale;
      const px = cx + this.offX, py = cy + this.offY;

      // bagliore stellare verso la luce (sfondo)
      this._starGlow(ctx, px, py, R);

      // anello atmosferico esterno (alone) per i corpi con atmosfera
      const palette = (BODY_TYPES[this.body.type] || {}).palette || {};
      if (palette.atmosphere) {
        const ag = ctx.createRadialGradient(px, py, R * 0.95, px, py, R * 1.18);
        ag.addColorStop(0, hexA(palette.atmosphere, 0.45));
        ag.addColorStop(1, hexA(palette.atmosphere, 0));
        ctx.fillStyle = ag;
        ctx.beginPath(); ctx.arc(px, py, R * 1.18, 0, Math.PI * 2); ctx.fill();
      }

      // pianeta (blit del bake)
      if (this.tex) {
        const sz = R * 2 / 0.92;   // il bake usa r=size*0.46 → riscala perché 2R = diametro
        ctx.drawImage(this.tex, px - sz / 2, py - sz / 2, sz, sz);
      }

      // anelli (gassosi grandi) — opzionali deterministici
      if (this.body.type === 'gassoso' && (this.body.variant != null && this.body.variant % 2 === 1)) {
        this._drawRings(ctx, px, py, R);
      }

      // lune in orbita
      for (let i = 0; i < this.moonTex.length; i++) {
        const m = this.moonTex[i];
        const mx = px + Math.cos(m.angle) * R * m.orbit;
        const my = py + Math.sin(m.angle) * R * m.orbit;
        const mR = R * m.radius;
        // orbita sottile
        ctx.strokeStyle = 'rgba(120,150,220,0.15)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(px, py, R * m.orbit, 0, Math.PI * 2); ctx.stroke();
        const msz = mR * 2 / 0.92;
        ctx.drawImage(m.canvas, mx - msz / 2, my - msz / 2, msz, msz);
        // label
        if (m.key === this.hoverMoonKey || mR > 18) {
          ctx.fillStyle = m.key === this.hoverMoonKey ? 'rgba(255,200,120,0.95)' : 'rgba(216,226,255,0.75)';
          ctx.font = '11px "JetBrains Mono", ui-monospace, monospace';
          ctx.textAlign = 'center';
          ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 3;
          ctx.fillText(m.name, mx, my + mR + 13);
          ctx.shadowBlur = 0;
        }
      }

      /* M07.2 polish (decisione #44): nome pianeta + tipo + stato colonia
         vivono ora nella breadcrumb estesa e nei widget della Plancia.
         I badge canvas (titleBadge/infoBadge) sono stati rimossi per
         evitare ridondanza visiva. Le funzioni restano definite ma non
         più chiamate da render(). */

      /* Decisione #66: dopo ogni render notifica l'overlay SVG così
         riallinea marker e ring alla nuova geometria (resize/pan/zoom). */
      if (root.ORION && root.ORION.planetOverlay && root.ORION.planetOverlay.sync) {
        root.ORION.planetOverlay.sync();
      }
    }

    _starGlow(ctx, px, py, R) {
      // direzione verso la stella nello schermo: la luce viene da (lx,ly,…)
      const sx = px + this.lightDir[0] * R * 5;
      const sy = py + this.lightDir[1] * R * 5;
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, R * 6);
      g.addColorStop(0, 'rgba(255,230,170,0.16)');
      g.addColorStop(1, 'rgba(255,230,170,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(sx, sy, R * 6, 0, Math.PI * 2); ctx.fill();
    }

    _drawRings(ctx, cx, cy, R) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(this.body.tilt || 0.35);
      ctx.scale(1, 0.32);
      const ringInner = R * 1.25, ringOuter = R * 1.85;
      const rng = makeRng(this.body.seed + ':rings');
      for (let i = 0; i < 22; i++) {
        const r0 = lerp(ringInner, ringOuter, i / 22);
        const r1 = lerp(ringInner, ringOuter, (i + 0.7) / 22);
        ctx.strokeStyle = 'rgba(' + (180 + rng.int(0, 40)) + ',' + (165 + rng.int(0, 30)) + ',' + (130 + rng.int(0, 30)) + ',' + rng.range(0.18, 0.55) + ')';
        ctx.lineWidth = (r1 - r0);
        ctx.beginPath(); ctx.arc(0, 0, (r0 + r1) / 2, -Math.PI, 0); ctx.stroke();
      }
      // anteriore (sopra il pianeta) — un sottile arco
      for (let i = 0; i < 22; i++) {
        const r0 = lerp(ringInner, ringOuter, i / 22);
        const r1 = lerp(ringInner, ringOuter, (i + 0.7) / 22);
        ctx.strokeStyle = 'rgba(' + (180 + rng.int(0, 40)) + ',' + (165 + rng.int(0, 30)) + ',' + (130 + rng.int(0, 30)) + ',' + rng.range(0.10, 0.35) + ')';
        ctx.lineWidth = (r1 - r0);
        ctx.beginPath(); ctx.arc(0, 0, (r0 + r1) / 2, 0, Math.PI); ctx.stroke();
      }
      ctx.restore();
    }

    _titleBadge(ctx, x, y) {
      ctx.font = '600 14px "JetBrains Mono", ui-monospace, monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(216,226,255,0.95)';
      ctx.shadowColor = 'rgba(0,0,0,0.85)'; ctx.shadowBlur = 4;
      ctx.fillText(this.body.name, x, y);
      ctx.font = '11px "JetBrains Mono", ui-monospace, monospace';
      ctx.fillStyle = 'rgba(154,166,204,0.85)';
      const def = BODY_TYPES[this.body.type] || {};
      ctx.fillText(def.label || this.body.type, x, y + 16);
      ctx.shadowBlur = 0;
    }

    _infoBadge(ctx) {
      const lines = [];
      const col = this.colony;
      if (col && col.colonized) lines.push(col.isHomeBase ? '★ PIANETA BASE' : '◉ COLONIZZATO');
      else lines.push('○ NON COLONIZZATO');
      lines.push('Slot: ' + this.planet.slots);
      if (this.planet.popCap > 0) lines.push('Cap demografico: ' + this.planet.popCap + ' livelli');
      else lines.push('Solo estrazione');

      ctx.font = '11px "JetBrains Mono", ui-monospace, monospace';
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      const pad = 10, x = 14, y = 14;
      const w = 170, h = lines.length * 16 + pad * 2 - 4;
      ctx.fillStyle = 'rgba(8,11,26,0.55)';
      ctx.strokeStyle = 'rgba(120,150,220,0.3)';
      ctx.lineWidth = 1;
      ctx.fillRect(x, y, w, h); ctx.strokeRect(x + 0.5, y + 0.5, w, h);
      ctx.fillStyle = 'rgba(216,226,255,0.92)';
      for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], x + pad, y + pad + i * 16);
    }
  }

  root.ORION = root.ORION || {};
  root.ORION.PlanetView = PlanetView;
  root.ORION.planetTex = { bakeSphere: bakeSphere };   // esposta per debug
})(typeof window !== 'undefined' ? window : this);
