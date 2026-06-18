/* =====================================================================
   ORION EMPIRES — cinematics.js
   "Regista" degli accadimenti scenografici (Fase 1).

   Ascolta gli stessi eventi di cronaca che alimentano l'auto-pausa
   (decisione #31) e, per i kind "scenografici", riproduce un breve beat
   visivo NON invasivo, disegnato dentro i canvas esistenti (system-view).

   Vincoli rispettati:
   - Determinismo (#5): le cinematiche sono PURO vestito visivo, non
     toccano lo stato di gioco → replay-safe per costruzione.
   - Accessibilità (UI_GUIDE §8): `prefers-reduced-motion: reduce` forza
     la modalità "off" a prescindere dalla preferenza utente.
   - Preferenza utente `ORION.prefs.cinematics` ∈ { piene | ridotte | off }
     (in localStorage['orion.prefs'], MAI nel save di partita).

   Livelli:
     piene   → tutti i beat (reveal sistema + partenza flotta)
     ridotte → solo micro-FX in-canvas leggeri (partenza flotta)
     off     → nessuna animazione (comportamento storico invariato)
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  const VALID = { 'piene': true, 'ridotte': true, 'off': true };

  function reducedMotion() {
    try {
      return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (_) { return false; }
  }

  function perfNow() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smooth(p) { return p * p * (3 - 2 * p); }

  /* Piccolo RNG deterministico (per il guscio decorativo di galassie lontane:
     posizioni stabili per seed, niente Math.random sparso — coerente con #5,
     anche se è puro scenario non salvato). */
  function seededRng(seedStr) {
    let h = 1779033703 ^ String(seedStr).length;
    for (let i = 0; i < String(seedStr).length; i++) {
      h = Math.imul(h ^ String(seedStr).charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      h ^= h >>> 16;
      return (h >>> 0) / 4294967296;
    };
  }

  const Cinematics = {
    _nav: null,

    /* main.js inietta i ganci di navigazione (openSystem) al boot, così il
       regista resta disaccoppiato dal modulo principale. */
    bind(nav) { this._nav = nav || null; },

    /* Modalità EFFETTIVA: reduced-motion ha la precedenza (→ off). */
    mode() {
      if (reducedMotion()) return 'off';
      const m = ORION.prefs && ORION.prefs.cinematics;
      return VALID[m] ? m : 'piene';
    },

    /* Punto d'aggancio unico: chiamato dopo ogni runAdvance con la lista
       eventi dell'Impulso (sia dal play-loop sia dall'avanzamento manuale). */
    onEvents(events) {
      if (!events || !events.length) return;
      const mode = this.mode();
      if (mode === 'off') return;

      let revealed = false; // un solo reveal per batch (evita "yank" multipli)
      for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        if (!ev) continue;
        if (ev.kind === 'fleet-launched') {
          /* Partenza flotta in iperspazio — micro-FX livello A (piene+ridotte). */
          this._departure(ev);
        } else if (mode === 'piene' && !revealed && ev.kind === 'fleet-discovery') {
          /* Arrivo in sistema inesplorato — reveal livello C (solo "piene"). */
          if (this._reveal(ev)) revealed = true;
        }
      }
    },

    /* --- Partenza flotta: solo se stai GIÀ guardando il sistema d'origine
       (nessun cambio di vista forzato → non invasivo). --- */
    _departure(ev) {
      const sv = ORION.systemView;
      if (!sv || ev.systemId == null) return;
      if (ORION.openSystemId !== ev.systemId) return;
      if (typeof sv.playFleetDeparture === 'function') sv.playFleetDeparture(ev.fleetId);
    },

    /* --- Reveal sistema: porta alla vista del sistema appena esplorato e
       avvia la dissolvenza nebbia→rivelazione (richiesta utente). --- */
    _reveal(ev) {
      if (ev.systemId == null) return false;
      if (this._blocked()) return false;   // non dirottare da pianeta/modale

      if (ORION.openSystemId !== ev.systemId) {
        if (this._nav && typeof this._nav.openSystem === 'function') {
          this._nav.openSystem(ev.systemId);
        } else {
          return false;
        }
      }
      const sv = ORION.systemView;
      if (sv && typeof sv.playReveal === 'function') { sv.playReveal(); return true; }
      return false;
    },

    /* Non dirottare la vista se l'utente è dentro un pianeta o se è aperta
       una modale a pieno schermo (save/preferenze/battaglia/reliquia). */
    _blocked() {
      if (ORION.openPlanetKey) return true;
      try {
        const sel = '.save-modal:not([hidden]), .prefs-modal:not([hidden]), ' +
                    '.battle-modal:not([hidden]), [data-anomaly-recap]';
        if (document.querySelector(sel)) return true;
      } catch (_) { /* no DOM */ }
      return false;
    },

    /* ===================================================================
       SEQUENZA D'APERTURA — "Primo Salto" (nuova partita) / "Ritorno"
       (caricamento). Camera che scende in continuo lungo la gerarchia di
       navigazione (galassia → gruppo → sistema → pianeta) rivelando la
       nebbia di guerra. Puro vestito: la colonizzazione avviene comunque
       nello stato di gioco; qui la si mostra (replay-safe, #5).

       opts = { kind:'new'|'load', homeSystemId, homeGroupId, homeBodyKey,
                capitalSystemId, onDone }
       =================================================================== */
    active() { return !!(this._intro && this._intro.active); },

    playIntro(opts) {
      opts = opts || {};
      const done = (typeof opts.onDone === 'function') ? opts.onDone : function () {};
      const kind = (opts.kind === 'load') ? 'load' : 'new';
      const mode = this.mode();   // piene | ridotte | off (reduced-motion → off)
      const nav = this._nav || {};
      const homeSys = opts.homeSystemId;
      const homeGroup = opts.homeGroupId;
      const homeBody = opts.homeBodyKey;
      const targetSys = (kind === 'load' && opts.capitalSystemId != null)
        ? opts.capitalSystemId : homeSys;

      // off / reduced-motion o bersaglio ignoto → nessuna intro (storico).
      if (mode === 'off' || targetSys == null || !nav.openSystem) { done(); return; }

      const self = this;
      const st = this._intro = {
        active: true, abort: false, raf: 0, watchdog: 0,
        overlay: null, canvas: null, decor: (mode === 'piene') ? 1 : 0,
        decorItems: null, landing: null, landed: false
      };
      let finished = false;
      function finish() {
        if (finished) return; finished = true;
        st.active = false; st.abort = true;
        if (st.raf) cancelAnimationFrame(st.raf);
        if (st.watchdog) clearTimeout(st.watchdog);
        self._teardownOverlay(st);
        /* Garantisci la vista finale corretta anche su skip a metà. */
        try {
          if (kind === 'new') {
            if (!st.landed) {
              if (nav.openSystem) nav.openSystem(targetSys);
              if (homeBody != null && nav.openPlanet) nav.openPlanet(targetSys, homeBody);
            }
          } else {
            if (ORION.openSystemId !== targetSys && nav.openSystem) nav.openSystem(targetSys);
          }
        } catch (_) { /* mai bloccare il gioco */ }
        self._intro = null;
        done();
      }
      st.finish = finish;

      this._buildOverlay(st, finish);
      st.watchdog = setTimeout(finish, 22000);   // failsafe: il gioco non resta mai ostaggio

      (async function run() {
        try {
          if (mode === 'piene') {
            await self._flyGalaxy(st, targetSys, homeGroup);
          }
          if (st.abort) return;
          if (nav.openSystem) nav.openSystem(targetSys);
          await self._sleep(st, 140);
          if (st.abort) return;
          const sv = ORION.systemView;
          if (kind === 'new') {
            if (sv && sv.playReveal) sv.playReveal();
            await self._sleep(st, 1250);
            if (st.abort) return;
            if (sv && homeBody != null && sv.focusBody) sv.focusBody(homeBody);
            await self._sleep(st, 820);
            if (st.abort) return;
            if (nav.openPlanet && homeBody != null) { nav.openPlanet(targetSys, homeBody); st.landed = true; }
            await self._landing(st);
          } else {
            // caricamento: posati sulla capitale, galassia allo stato reale
            await self._sleep(st, 700);
          }
        } catch (_) { /* finally → finish */ }
        finally { finish(); }
      })();
    },

    /* --- Volo camera galassia → gruppo → sistema (livello "piene") --- */
    _flyGalaxy(st, targetSys, homeGroup) {
      const self = this;
      const map = ORION.map;
      if (!map || !map.cinematicTarget || !map.applyCamera) return Promise.resolve();
      const galT = map.cinematicTarget('galaxy');
      if (!galT) return Promise.resolve();
      // partenza "molto out": galassia minuscola al centro
      const s0 = galT.s * 0.4;
      map.applyCamera(s0, (map.cssW - s0) / 2, (map.cssH - s0) / 2, galT.orient);
      this._renderOverlay(st);
      return self._tweenCamera(st, map, galT, 1500, function (e) {
        st.decor = 1 - e;                 // le galassie lontane sfumano
        self._renderOverlay(st);
      }).then(function () {
        if (st.abort) return;
        const grpT = (homeGroup != null) ? map.cinematicTarget('group', homeGroup) : null;
        return grpT ? self._tweenCamera(st, map, grpT, 1700) : null;
      }).then(function () {
        if (st.abort) return;
        const sysT = map.cinematicTarget('system', targetSys);
        return sysT ? self._tweenCamera(st, map, sysT, 1500) : null;
      });
    },

    _tweenCamera(st, map, to, ms, onUpdate) {
      return new Promise(function (resolve) {
        if (st.abort) { resolve(); return; }
        const from = { s: map.scale, ox: map.offsetX, oy: map.offsetY };
        const t0 = perfNow();
        function frame() {
          if (st.abort) { resolve(); return; }
          const p = clamp((perfNow() - t0) / ms, 0, 1);
          const e = smooth(p);
          map.applyCamera(
            lerp(from.s, to.s, e),
            lerp(from.ox, to.ox, e),
            lerp(from.oy, to.oy, e)
          );
          if (onUpdate) onUpdate(e);
          if (p < 1) st.raf = requestAnimationFrame(frame);
          else resolve();
        }
        st.raf = requestAnimationFrame(frame);
      });
    },

    _sleep(st, ms) {
      return new Promise(function (resolve) {
        if (st.abort) { resolve(); return; }
        const t0 = perfNow();
        function tick() {
          if (st.abort || (perfNow() - t0) >= ms) { resolve(); return; }
          st.raf = requestAnimationFrame(tick);
        }
        st.raf = requestAnimationFrame(tick);
      });
    },

    /* --- Atterraggio dell'esploratore: capsula che scende + flash, disegnati
       sull'overlay sopra il pianeta appena aperto (centrato). --- */
    _landing(st) {
      const self = this;
      return new Promise(function (resolve) {
        if (st.abort) { resolve(); return; }
        const t0 = perfNow(); const ms = 1500;
        function frame() {
          if (st.abort) { resolve(); return; }
          const p = clamp((perfNow() - t0) / ms, 0, 1);
          st.landing = p;
          self._renderOverlay(st);
          if (p < 1) st.raf = requestAnimationFrame(frame);
          else { st.landing = null; self._renderOverlay(st); resolve(); }
        }
        st.raf = requestAnimationFrame(frame);
      });
    },

    /* ---- Overlay (tela decorativa + pulsante salta) ---- */
    _buildOverlay(st, onSkip) {
      const self = this;
      try {
        let el = document.querySelector('[data-cinematic-overlay]');
        if (!el) {
          el = document.createElement('div');
          el.setAttribute('data-cinematic-overlay', '');
          el.className = 'cinematic-overlay';
          document.body.appendChild(el);
        }
        el.innerHTML = '';
        const cv = document.createElement('canvas');
        cv.className = 'cinematic-overlay__canvas';
        el.appendChild(cv);
        const skipBtn = document.createElement('button');
        skipBtn.type = 'button';
        skipBtn.className = 'cinematic-overlay__skip';
        skipBtn.textContent = 'Salta intro ›';
        el.appendChild(skipBtn);
        st.overlay = el; st.canvas = cv;
        this._sizeOverlay(st);
        if (st.decor > 0) this._buildDecor(st);
        this._renderOverlay(st);

        const skip = function (e) { if (e) e.preventDefault(); onSkip(); };
        el.addEventListener('pointerdown', skip);
        skipBtn.addEventListener('click', function (e) { e.stopPropagation(); skip(e); });
        st._onKey = function (ev) {
          if (ev.key === 'Escape' || ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onSkip(); }
        };
        document.addEventListener('keydown', st._onKey, true);
        st._onResize = function () { self._sizeOverlay(st); self._renderOverlay(st); };
        root.addEventListener('resize', st._onResize);
      } catch (_) { /* DOM assente: il run procede comunque, finirà da solo */ }
    },

    _sizeOverlay(st) {
      if (!st.canvas) return;
      const dpr = Math.min(root.devicePixelRatio || 1, 2.5);
      const w = root.innerWidth || 0, h = root.innerHeight || 0;
      st.cssW = w; st.cssH = h; st.dpr = dpr;
      st.canvas.width = Math.round(w * dpr);
      st.canvas.height = Math.round(h * dpr);
      st.canvas.style.width = w + 'px';
      st.canvas.style.height = h + 'px';
    },

    _buildDecor(st) {
      const seed = (ORION.game && ORION.game.seed) ? ORION.game.seed : 'orion';
      const rng = seededRng('intro:' + seed);
      const items = [];
      const n = 7;
      const palette = ['#9fb6ff', '#c8a8ff', '#ffd6a8', '#a8e6ff', '#d8c0ff'];
      for (let i = 0; i < n; i++) {
        items.push({
          x: rng(), y: rng(),
          r: 26 + rng() * 70,
          rot: rng() * Math.PI,
          flat: 0.32 + rng() * 0.4,
          col: palette[(rng() * palette.length) | 0],
          spiral: rng() > 0.5
        });
      }
      st.decorItems = items;
    },

    _renderOverlay(st) {
      const cv = st.canvas; if (!cv) return;
      const ctx = cv.getContext('2d'); if (!ctx) return;
      const w = st.cssW || 0, h = st.cssH || 0;
      ctx.setTransform(st.dpr || 1, 0, 0, st.dpr || 1, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // 1) guscio decorativo: galassie lontane che sfumano col primo zoom
      if (st.decor > 0.001 && st.decorItems) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < st.decorItems.length; i++) {
          const it = st.decorItems[i];
          const cx = it.x * w, cy = it.y * h;
          const a = st.decor;
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate(it.rot);
          ctx.scale(1, it.flat);
          const g = ctx.createRadialGradient(0, 0, 0, 0, 0, it.r);
          g.addColorStop(0, hexA(it.col, 0.55 * a));
          g.addColorStop(0.35, hexA(it.col, 0.22 * a));
          g.addColorStop(1, hexA(it.col, 0));
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(0, 0, it.r, 0, Math.PI * 2); ctx.fill();
          // nucleo
          ctx.fillStyle = hexA('#ffffff', 0.5 * a);
          ctx.beginPath(); ctx.arc(0, 0, it.r * 0.12, 0, Math.PI * 2); ctx.fill();
          ctx.restore();
        }
        ctx.restore();
        // vignettatura leggera, anch'essa in dissolvenza
        const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.72);
        vg.addColorStop(0, 'rgba(2,4,12,0)');
        vg.addColorStop(1, 'rgba(2,4,12,' + (0.5 * st.decor).toFixed(3) + ')');
        ctx.fillStyle = vg;
        ctx.fillRect(0, 0, w, h);
      }

      // 2) atterraggio dell'esploratore sopra il pianeta
      if (st.landing != null) this._drawLanding(ctx, st, w, h);
    },

    _drawLanding(ctx, st, w, h) {
      const p = st.landing;
      const cx = w / 2, cy = h * 0.52;
      // discesa con ease-in
      const descend = clamp(p / 0.6, 0, 1);
      const ey = lerp(-h * 0.18, cy - Math.min(w, h) * 0.10, descend * descend);
      const touch = clamp((p - 0.55) / 0.25, 0, 1);   // 0→1 nel tratto d'impatto
      // scia/fiamma del propulsore (mentre scende)
      if (p < 0.72) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const flame = (1 - descend) * 0.6 + 0.4;
        const fg = ctx.createLinearGradient(cx, ey, cx, ey + 46 * flame);
        fg.addColorStop(0, 'rgba(196,232,255,' + (0.9 * (1 - touch)).toFixed(3) + ')');
        fg.addColorStop(1, 'rgba(127,208,240,0)');
        ctx.fillStyle = fg;
        ctx.beginPath();
        ctx.moveTo(cx - 4, ey); ctx.lineTo(cx + 4, ey);
        ctx.lineTo(cx, ey + 46 * flame); ctx.closePath(); ctx.fill();
        ctx.restore();
      }
      // capsula (piccolo cono) finché non è "atterrata"
      if (p < 0.78) {
        ctx.save();
        ctx.globalAlpha = 1 - touch;
        ctx.fillStyle = '#dfeaff';
        ctx.strokeStyle = 'rgba(8,12,24,0.85)'; ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(cx, ey - 7);
        ctx.lineTo(cx + 5, ey + 4);
        ctx.lineTo(cx - 5, ey + 4);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.restore();
      }
      // flash + anello d'insediamento al contatto
      if (p > 0.55) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const fp = Math.sin(touch * Math.PI);   // 0→1→0
        if (fp > 0.001) {
          const fr = Math.min(w, h) * 0.06 * fp;
          const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, fr * 2.4);
          g.addColorStop(0, 'rgba(220,240,255,' + (0.8 * fp).toFixed(3) + ')');
          g.addColorStop(1, 'rgba(220,240,255,0)');
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(cx, cy, fr * 2.4, 0, Math.PI * 2); ctx.fill();
        }
        // anello che si espande dopo il contatto
        const ring = clamp((p - 0.62) / 0.38, 0, 1);
        if (ring > 0.001) {
          const rr = Math.min(w, h) * (0.04 + ring * 0.14);
          ctx.strokeStyle = 'rgba(150,220,235,' + ((1 - ring) * 0.6).toFixed(3) + ')';
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.restore();
      }
    },

    _teardownOverlay(st) {
      try {
        if (st._onResize) root.removeEventListener('resize', st._onResize);
        if (st._onKey) document.removeEventListener('keydown', st._onKey, true);
        if (st.overlay && st.overlay.parentNode) st.overlay.parentNode.removeChild(st.overlay);
      } catch (_) { /* noop */ }
      st.overlay = null; st.canvas = null;
    }
  };

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  ORION.cinematics = Cinematics;
})(typeof window !== 'undefined' ? window : this);
