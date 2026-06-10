/* =====================================================================
   ORION EMPIRES — utils.js (pulizia #68 Fase 2)
   Utility condivise tra moduli. Prima vivevano come copie locali
   identiche (clamp ×5, lerp ×3, escapeHtml ×3) o come formattatori
   divergenti sparsi (fmtNum/fmtStock/fmtNet/fmtRate). Nessuna logica
   nuova: le implementazioni sono quelle storiche, qui c'è solo la
   singola fonte di verità. Caricato subito dopo rng.js.

   API:
     ORION.util.clamp(v, lo, hi)
     ORION.util.lerp(a, b, t)
     ORION.util.smoothstep(e0, e1, x)   — Hermite su intervallo (GLSL)
     ORION.util.escapeHtml(s)
     ORION.format.compact(v)            — k per migliaia, 1 decimale (ex fmtNum)
     ORION.format.stock(v)              — k/M per scorte aggregate (ex fmtStock)
     ORION.format.rate(v)               — segno esplicito + 2 decimali (ex fmtNet)
     ORION.format.rateShort(v)          — segno + 0/1 decimali, '0' se zero (ex fmtRate)
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  /* --- Matematica --- */
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(e0, e1, x) {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  }

  /* --- HTML --- */
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  ORION.util = {
    clamp: clamp,
    lerp: lerp,
    smoothstep: smoothstep,
    escapeHtml: escapeHtml
  };

  /* --- Formattatori numerici UI --- */
  ORION.format = {
    /* Numero compatto: k per migliaia (1 decimale), 1 decimale sotto 100. */
    compact: function (v) {
      if (v == null || !isFinite(v)) return '—';
      const av = Math.abs(v);
      if (av >= 1000) return (v / 1000).toFixed(1) + 'k';
      if (av >= 100) return Math.round(v).toString();
      return (Math.round(v * 10) / 10).toString();
    },
    /* Scorte aggregate: k/M con 1 decimale. */
    stock: function (v) {
      if (v == null || !isFinite(v)) return '—';
      const av = Math.abs(v);
      if (av >= 1e6) return (v / 1e6).toFixed(1) + 'M';
      if (av >= 1000) return (v / 1000).toFixed(1) + 'k';
      return Math.round(v).toString();
    },
    /* Rate netto con segno esplicito (− tipografico) e 2 decimali. */
    rate: function (v) {
      return (v >= 0 ? '+' : '−') + (Math.round(Math.abs(v) * 100) / 100);
    },
    /* Rate compatto: '0' se zero, segno + 0/1 decimali adattivi. */
    rateShort: function (v) {
      if (v == null || !isFinite(v) || v === 0) return '0';
      const sign = v > 0 ? '+' : '−';
      const av = Math.abs(v);
      return sign + (av >= 10 ? av.toFixed(0) : av.toFixed(1));
    }
  };
})(typeof window !== 'undefined' ? window : this);
