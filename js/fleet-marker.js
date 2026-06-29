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
  /* Core: rasterizza e disegna un'icona SVG (per nome) centrata in (cx,cy),
     lato px, tinta `tint`. Fallback al glyph se non pronta/assente. */
  function drawRaster(ctx, cx, cy, px, iconName, tint, onReady, glyphFallback) {
    const img = (iconName && ORION.rasterIcon) ? ORION.rasterIcon(iconName, tint, RASTER_PX, onReady) : null;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.65)';
    ctx.shadowBlur = Math.max(2, px * 0.16);
    if (img) {
      ctx.drawImage(img, cx - px / 2, cy - px / 2, px, px);
    } else {
      /* glyph fallback (icona non ancora caricata o assente) */
      const fpx = Math.round(px * 0.92);
      ctx.font = '600 ' + fpx + 'px "JetBrains Mono", ui-monospace, monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(1.5, fpx / 6);
      ctx.strokeStyle = 'rgba(8,12,24,0.9)';
      ctx.shadowBlur = 0;
      ctx.strokeText(glyphFallback || '◈', cx, cy);
      ctx.fillStyle = tint;
      ctx.fillText(glyphFallback || '◈', cx, cy);
    }
    ctx.restore();
  }

  /* Icona di una classe nave. `colorHex` opzionale forza la tinta. */
  function drawShip(ctx, cx, cy, px, kind, onReady, colorHex) {
    const F = ORION.fleet;
    const vis = (F && F.classVisual) ? F.classVisual(kind) : { icon: null, hex: '#98a3c8', glyph: '◈' };
    drawRaster(ctx, cx, cy, px, vis.icon, colorHex || vis.hex, onReady, vis.glyph);
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

    /* Icona nave GENERICA (non rivela la classe): per i contatti AI rilevati
       dai radar ma senza dossier completo — sappiamo che c'è una flotta di
       quella civ, non la sua composizione (resta nel popup, intel-gated). */
    genericShip(ctx, cx, cy, size, onReady, colorHex) {
      drawRaster(ctx, cx, cy, size, 'fleet', colorHex || '#cfe6ff', onReady, '➤');
      return size / 2;
    },

    /* Flotta scomposta: ELENCO VERTICALE (un tipo per riga, "tipo sopra tipo")
       di icone + "×n", ordinato per forza decrescente. Centrato su (cx,cy).
       `cell` = lato icona px. opts: { max=4 }. Ritorna { w, h } d'ingombro.
       Layout verticale (richiesta utente 2026-06-26): più leggibile delle
       icone affiancate in larghezza, soprattutto con icone ingrandite. */
    composition(ctx, cx, cy, cell, fleet, onReady, opts) {
      opts = opts || {};
      const F = ORION.fleet;
      const comp = (F && F.composition) ? F.composition(fleet) : [];
      if (!comp.length) return { w: 0, h: 0 };
      const max = opts.max || 4;
      const shown = comp.slice(0, max);
      let extra = 0;
      for (let i = max; i < comp.length; i++) extra += comp[i].n;
      const rows = shown.length + (extra > 0 ? 1 : 0);
      const fontPx = Math.max(9, cell * 0.55);
      const rowH = cell * 1.04;          /* riga = icona + respiro verticale */
      const countGap = cell * 0.18;      /* spazio icona → "×n" */

      /* Pre-misura: larghezza massima riga (icona + etichetta) per centrare. */
      ctx.save();
      ctx.font = '700 ' + Math.round(fontPx) + 'px "JetBrains Mono", ui-monospace, monospace';
      let maxRowW = 0;
      for (let i = 0; i < shown.length; i++) {
        const w = cell + countGap + ctx.measureText('×' + shown[i].n).width;
        if (w > maxRowW) maxRowW = w;
      }
      if (extra > 0) {
        const w = cell + countGap + ctx.measureText('+' + extra).width;
        if (w > maxRowW) maxRowW = w;
      }
      ctx.restore();

      const totalH = rows * rowH;
      const left = cx - maxRowW / 2;             /* colonna icone allineata a sx del blocco */
      let y = cy - totalH / 2 + rowH / 2;        /* centro della prima riga */

      for (let i = 0; i < shown.length; i++) {
        const it = shown[i];
        drawShip(ctx, left + cell / 2, y, cell, it.kind, onReady);
        drawCount(ctx, left + cell + countGap, y + cell * 0.02, it.n, fontPx, 'left');
        y += rowH;
      }
      if (extra > 0) {
        ctx.save();
        ctx.font = '700 ' + Math.round(fontPx) + 'px "JetBrains Mono", ui-monospace, monospace';
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(2, fontPx / 3.5);
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText('+' + extra, left + cell / 2, y);
        ctx.fillStyle = 'rgba(180,192,224,0.95)';
        ctx.fillText('+' + extra, left + cell / 2, y);
        ctx.restore();
      }
      return { w: maxRowW, h: totalH };
    }
  };
})(typeof window !== 'undefined' ? window : this);
