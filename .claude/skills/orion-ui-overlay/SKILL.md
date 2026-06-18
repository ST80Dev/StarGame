---
name: orion-ui-overlay
description: Creare un modale/overlay full-screen in Orion Empires con il pattern canonico (host data-bind, role=dialog, scrim + backdrop blur, chiusura su scrim/X/Esc, stato volatile mai nel save). Usa quando devi aprire una finestra modale, un picker, un selettore o un editor in overlay. PRIMA leggi UI_GUIDE.md (R2): vincolante come la gestione branch.
---

# Creare un overlay/modale

⚠️ **Leggi `UI_GUIDE.md` prima** (R2, stessa autorevolezza di R1). In conflitto UI vince UI_GUIDE.

Gli overlay sono `position: fixed; inset: 0` con scrim semitrasparente + `backdrop-filter: blur(4px)`,
panel centrato, z-index 200+ (tutorial 400, save 300, picker ~350). Pattern ripetuto 10+ volte
(`.save-modal`, `.expedition-pick-overlay`, `.attack-overlay`, `.event-overlay`,
`.fleet-create-overlay`). Modello reale: `openExpeditionPicker()` in `js/main.js:4809`.

## 1. Riusa se puoi
Per un modale generico (titolo + contenuto scrollabile + X) **riusa `.save-modal`** invece di
inventare una classe nuova (UI_GUIDE §6). Crea una classe dedicata solo se la geometria differisce
davvero (es. griglia di card come il picker).

## 2. Open: host idempotente + innerHTML + handlers
```js
function openMyOverlay(args) {
  let host = document.querySelector('[data-bind="my-overlay"]');
  if (!host) {
    host = document.createElement('div');
    host.className = 'my-overlay';               // o 'save-modal' se riusi
    host.setAttribute('data-bind', 'my-overlay');
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-modal', 'true');
    host.setAttribute('aria-label', 'Titolo accessibile');
    document.body.appendChild(host);
  }
  host.innerHTML =
    '<div class="my-overlay__panel">' +
      '<header class="my-overlay__head">' +
        '<h2 class="my-overlay__title">Titolo</h2>' +
        '<button class="btn btn--mini btn--icon-only" type="button" data-action="close-overlay" aria-label="Chiudi">' +
          uiIcon('close', 'soft') +            // catalogo icone, vedi skill orion-ui-icon
        '</button>' +
      '</header>' +
      '<div class="my-overlay__body">' + contentHtml + '</div>' +
    '</div>';
  host.hidden = false;

  // Chiusura: click su scrim (host stesso) o sul bottone X
  host.onclick = function (e) {
    if (e.target === host || (e.target.closest && e.target.closest('[data-action="close-overlay"]'))) {
      closeMyOverlay();
    }
  };
  // Esc
  host._onKey = function (e) { if (e.key === 'Escape') closeMyOverlay(); };
  document.addEventListener('keydown', host._onKey);
}

function closeMyOverlay() {
  const host = document.querySelector('[data-bind="my-overlay"]');
  if (!host) return;
  if (host._onKey) { document.removeEventListener('keydown', host._onKey); host._onKey = null; }
  host.hidden = true;
  host.innerHTML = '';
}
```
Re-render (es. dopo una selezione interna): richiama `openMyOverlay(args)` con lo stato aggiornato
passato negli `args` (pattern del picker: la selezione è persistita tra i re-render via `opts`).

## 3. CSS canonico
```css
.my-overlay {
  position: fixed; inset: 0; z-index: 350;
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
  background: rgb(var(--c-surface-rgb) / 0.78);   /* scrim — NON terne hardcoded (UI_GUIDE §1) */
  backdrop-filter: blur(4px);
}
.my-overlay[hidden] { display: none; }
.my-overlay__panel {
  width: min(720px, 100%);
  max-height: 90vh; overflow-y: auto;
  background: var(--c-panel);
  border: 1px solid var(--c-border);
  border-radius: 8px;                              /* pannelli grandi: 8px (UI_GUIDE §5) */
  box-shadow: var(--shadow-panel), inset 0 1px 0 var(--c-panel-hilite);
  padding: 20px 24px;
}
.my-overlay__head {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 12px;
}
.my-overlay__title {
  font-family: var(--font-display); font-size: 1rem;
  letter-spacing: 0.12em; text-transform: uppercase; color: var(--c-accent);
}
```

## 4. Regole
- **Superfici via token**: usa `rgb(var(--c-surface-rgb) / α)` / `var(--c-panel)`, mai terne RGB
  hardcoded (UI_GUIDE §1). Scrim/dimmer scuri (`rgba(0,0,0,…)`) ammessi solo per contrasto.
- **Geometria**: radius 8px pannello, padding ≤ 24px, font ≥ 0.70rem (UI_GUIDE §2/§5).
- **Accessibilità** (UI_GUIDE §10): `role="dialog"` + `aria-modal` + `aria-label`, `type="button"`
  su tutti i bottoni, chiusura su Esc.
- **Stato volatile mai nel save** (UI_GUIDE §9, decisione #5): lo stato dell'overlay vive in
  closure/`ORION._<feature>` transitorio, non in `game.*`.
- **Icone**: tematiche + glow, via `uiIcon(name, tone)` (skill `orion-ui-icon`).
- Se introduci una sigla/concetto nuovo nel modale → aggiungi una lezione (skill `orion-tutorial-lesson`).

## Checklist
- [ ] letto UI_GUIDE.md
- [ ] riuso `.save-modal` valutato prima di nuova classe
- [ ] host con `data-bind` + role/aria, `host.hidden` per show/hide
- [ ] chiusura su scrim + X + Esc, con cleanup del listener keydown
- [ ] superfici via token, radius/padding/font conformi
- [ ] stato volatile fuori dal save
