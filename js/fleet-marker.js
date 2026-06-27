/* =====================================================================
   ORION EMPIRES — fleet-marker.js
   Rappresentazione delle flotte su canvas (mappa galassia + vista sistema),
   richiesta utente 2026-06-26.

   Due modi, scelti dal chiamante in base allo zoom:
     • lead        → una sola icona = nave più "forte" della flotta
                      (per zoom out: colpo d'occhio sulla classe di punta);
     • composition → la flotta scomposta in icone per tipo + numero
                      (per zoom in / vista sistema).

   Le icone sono gli SVG di classe del catalogo (icons.js), rasterizzati e
   tintati via ORION.rasterIcon (cache + blit drawImage, pattern planet-view).
   Finché l'immagine non è pronta si disegna il glyph della classe come
   fallback. `onReady` (di solito map.requestRender) ridisegna a load finito.

   Niente stato persistito, niente RNG: pura resa derivata dai dati flotta.
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};
  const RASTER_PX = 64; /* risoluzione unica di rasterizzazione → scala in drawImage */

  /* Disegna una singola icona di classe centrata in (cx,cy), lato `px`.
     Fallback al glyph della classe se l'icona non è pronta / assente.
     `colorHex` (opzionale) forza una tinta diversa da quella di classe —
     usato per le flotte AI: sempre nel colore della civ. */
  function drawShip(ctx, cx, cy, px, kind, onReady, colorHex) {
    const F = ORION.fleet;
    const vis = (F && F.classVisual) ? F.classVisual(kind) : { icon: null, hex: '#98a3c8', glyph: '◈' };
    const tint = colorHex || vis.hex;
    const img = (vis.icon && ORION.rasterIcon) ? ORION.rasterIcon(vis.icon, tint, RASTER_PX, onReady) : null;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.65)';
    ctx.shadowBlur = Math.max(2, px * 0.16);
    if (img) {
      ctx.drawImage(img, cx - px / 2, cy - px / 2, px, px);
    } else {
      /* glyph fallback (icona non ancora caricata o classe senza icona) */
      const fpx = Math.round(px * 0.92);
      ctx.font = '600 ' + fpx + 'px "JetBrains Mono", ui-monospace, monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(1.5, fpx / 6);
      ctx.strokeStyle = 'rgba(8,12,24,0.9)';
      ctx.shadowBlur = 0;
      ctx.strokeText(vis.glyph, cx, cy);
      ctx.fillStyle = tint;
      ctx.fillText(vis.glyph, cx, cy);
    }
    ctx.restore();
  }

  /* Etichetta numerica "×n" con stroke scuro per leggibilità. */
  function drawCount(ctx, x, y, n, fontPx, align) {
    ctx.save();
    ctx.font = '700 ' + Math.round(fontPx) + 'px "JetBrains Mono", ui-monospace, monospace';
    ctx.textAlign = align || 'left'; ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(2, fontPx / 3.5);
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    const t = '×' + n;
    ctx.strokeText(t, x, y);
    ctx.fillStyle = 'rgba(232,240,255,0.97)';
    ctx.fillText(t, x, y);
    ctx.restore();
  }

  ORION.fleetMarker = {
    RASTER_PX: RASTER_PX,

    /* Icona singola della nave di punta (classe più forte). `size` = lato px.
       `colorHex` (opzionale) forza la tinta (flotte AI = colore civ).
       Ritorna il semi-ingombro orizzontale (per posizionare un'etichetta). */
    lead(ctx, cx, cy, size, fleet, onReady, colorHex) {
      const F = ORION.fleet;
      const kind = (F && F.leadKind) ? F.leadKind(fleet) : null;
      if (!kind) return size / 2;
      drawShip(ctx, cx, cy, size, kind, onReady, colorHex);
      return size / 2;
    },

    /* Flotta scomposta: riga di icone per tipo + "×n". Centrata su (cx,cy).
       `cell` = lato icona px. opts: { max=4 }. Ritorna { w, h } d'ingombro. */
    composition(ctx, cx, cy, cell, fleet, onReady, opts) {
      opts = opts || {};
      const F = ORION.fleet;
      const comp = (F && F.composition) ? F.composition(fleet) : [];
      if (!comp.length) return { w: 0, h: 0 };
      const max = opts.max || 4;
      const shown = comp.slice(0, max);
      let extra = 0;
      for (let i = max; i < comp.length; i++) extra += comp[i].n;
      const fontPx = Math.max(8, cell * 0.5);
      const gap = cell * 0.34;

      /* Pre-misura per centrare la riga. */
      ctx.save();
      ctx.font = '700 ' + Math.round(fontPx) + 'px "JetBrains Mono", ui-monospace, monospace';
      const cellWidths = shown.map(function (it) {
        return cell * 0.86 + 2 + ctx.measureText('×' + it.n).width;
      });
      let extraW = 0;
      if (extra > 0) extraW = gap + ctx.measureText('+' + extra).width + cell * 0.2;
      ctx.restore();

      let totalW = 0;
      for (let i = 0; i < cellWidths.length; i++) totalW += cellWidths[i] + (i ? gap : 0);
      totalW += extraW;

      let x = cx - totalW / 2;
      for (let i = 0; i < shown.length; i++) {
        if (i) x += gap;
        const it = shown[i];
        drawShip(ctx, x + cell * 0.43, cy, cell, it.kind, onReady);
        drawCount(ctx, x + cell * 0.86 + 2, cy + cell * 0.04, it.n, fontPx, 'left');
        x += cellWidths[i];
      }
      if (extra > 0) {
        x += gap;
        ctx.save();
        ctx.font = '700 ' + Math.round(fontPx) + 'px "JetBrains Mono", ui-monospace, monospace';
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(2, fontPx / 3.5);
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText('+' + extra, x, cy);
        ctx.fillStyle = 'rgba(180,192,224,0.95)';
        ctx.fillText('+' + extra, x, cy);
        ctx.restore();
      }
      return { w: totalW, h: cell };
    }
  };
})(typeof window !== 'undefined' ? window : this);
