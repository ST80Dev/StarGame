/* =====================================================================
   ORION EMPIRES — main.js
   Modulo M01: bootstrap della shell UI.
   Nessuna logica di gioco qui: i moduli successivi (M02+) si
   aggancieranno a questo punto di inizializzazione.
   ===================================================================== */
'use strict';

const ORION = {
  version: '0.1.1-M01',
  /* Tempo Standard Galattico (TSG) — unità base: Ciclo.
     Gerarchia decimale: 1 Fase = 10 Cicli · 1 Orbita = 100 Cicli · 1 Èra = 1000 Cicli.
     Data Stellare visualizzata: DS <orbita>.<cicli-nell'orbita>.
     I controlli di avanzamento (data-action="advance" con data-cicli, e
     data-action="advance-to-event") sono predisposti ma inerti: il game
     loop temporale verrà implementato in M05. */
  /* Etichette provvisorie del viewport per ciascuna vista.
     Verranno sostituite dal rendering reale (Canvas) nei moduli futuri. */
  viewLabels: {
    galaxy:    { caption: 'VISTA GALASSIA',   hint: 'La mappa galattica verrà generata nel modulo M02.' },
    system:    { caption: 'VISTA SISTEMA',    hint: 'La vista del sistema stellare arriverà nel modulo M03.' },
    planet:    { caption: 'VISTA PIANETA',    hint: 'La gestione del pianeta arriverà nel modulo M04.' },
    fleet:     { caption: 'VISTA FLOTTA',     hint: 'La gestione della flotta arriverà nel modulo M08.' },
    research:  { caption: 'VISTA RICERCA',    hint: "L'albero tecnologico arriverà nel modulo M13." },
    diplomacy: { caption: 'VISTA DIPLOMAZIA', hint: 'La diplomazia arriverà nel modulo M11.' }
  }
};

/* ---------------------------------------------------------------------
   Navigazione tra viste (solo cambio di stato visuale per ora)
   --------------------------------------------------------------------- */
function initNavigation() {
  const items = document.querySelectorAll('.nav-item');
  const stage = document.querySelector('[data-view-stage]');

  items.forEach((item) => {
    item.addEventListener('click', () => {
      items.forEach((i) => i.classList.remove('is-active'));
      item.classList.add('is-active');
      renderViewPlaceholder(stage, item.dataset.view);
    });
  });
}

function renderViewPlaceholder(stage, view) {
  if (!stage) return;
  const label = ORION.viewLabels[view] || { caption: view.toUpperCase(), hint: '' };
  stage.innerHTML =
    '<div class="viewport__placeholder">' +
      '<span class="viewport__glyph" aria-hidden="true">◈</span>' +
      '<p class="viewport__caption">' + label.caption + '</p>' +
      '<p class="viewport__hint">' + label.hint + '</p>' +
    '</div>';
}

/* ---------------------------------------------------------------------
   Avvio
   --------------------------------------------------------------------- */
function boot() {
  initNavigation();
  console.info('%cOrion Empires ' + ORION.version + ' — shell pronta.', 'color:#2fe6e0');
}

document.addEventListener('DOMContentLoaded', boot);
