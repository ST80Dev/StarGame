---
name: orion-ui-section
description: Costruire i widget UI ricorrenti della sidebar/viste di Orion Empires (header di sezione, item card cliccabile, badge di stato, chip, viste del viewport) riusando le classi canoniche e gli helper esistenti invece di inventare markup nuovo. Usa quando crei una sezione, una card, un badge di stato o una vista renderFooView. PRIMA leggi UI_GUIDE.md §6/§7.
---

# Widget UI ricorrenti (sezioni, card, badge, viste)

⚠️ **Leggi `UI_GUIDE.md` §6 (pattern ricorrenti) e §7 (stati semantici) prima** (R2). Regola d'oro:
**prima cerca una classe esistente**, riusala; crea markup nuovo solo se nessun pattern calza, e
motivalo nel commit.

## 1. Header di sezione (`.lp-section__head`)
Caret + glyph colorato + titolo + counter pill. Oggi esistono helper locali divergenti — `head()`
(`js/main.js:8323`) e `secHead()` (`js/main.js:8572`) — entrambi costruiti su `uiIcon()`:
```js
function secHead(icon, tone, title, extra) {
  return '<div class="fdetail__sec-h">' + uiIcon(icon, tone) + ' ' + title +
    (extra ? ' <span class="fdetail__opt">' + extra + '</span>' : '') + '</div>';
}
```
Per le sezioni della sidebar usa la classe canonica `.lp-section__head` (UI_GUIDE §6) e l'icona
tematica via `uiIcon(name, tone)` (skill `orion-ui-icon`). Se crei una sezione nuova, **mantieni un
unico stile di header** nel pannello (non mescolare `fdetail__sec-h` e `lp-section__head` nello
stesso contesto visivo).

## 2. Item card cliccabile (`.lp-item` / `.lp-launcher__btn`)
Glyph + nome + sub + badge. Struttura:
```html
<button class="lp-item" type="button" data-action="open-foo" data-id="…">
  <span class="ui-icon ui-icon--accent" aria-hidden="true">…svg…</span>
  <span class="lp-item__name">Nome</span>
  <span class="lp-item__sub">meta secondaria</span>
  <span class="lp-item__badge lp-item__badge--ok">OK</span>
</button>
```
Bottoni sempre `type="button"`. Selezione/focus: classe `.is-active`/`.is-focus` (UI_GUIDE §7).

## 3. Badge di stato (stati semantici riusabili — UI_GUIDE §7)
**Mai inventare tinte di stato nuove.** Usa il linguaggio comune:
| Stato | Classe | Tinta |
|---|---|---|
| OK | `.is-ok` / `…__badge--ok` | `var(--c-good)` |
| Allerta | `.is-low` / `.is-warn` | `#f0d670` |
| Critico | `.is-crit` | `var(--c-bad)` |
| Attivo | `.is-active` / `.is-focus` | bordo `var(--c-accent)` |
| Occupato | `.is-busy` | `opacity: .92` |
| Disabilitato | `[disabled]` / `.is-locked` | `opacity: .5-.6` |
Sigle badge: `OK · WRN · CRT · INF` (con `title=""` parola piena). Parola piena per i titoli di
sezione (Roster · Navigazione · Cronaca) — vedi UI_GUIDE §4.

## 4. Chip info read-only (`.deck-chip` / `.crumb-chip`)
Etichette neutre non cliccabili. Pill totale `border-radius: 999px`. Tag inline regione+sistema:
`.name-tag` (decisione #28).

## 5. Vista del viewport (`renderFooView(stage)`)
Pattern: header + contenuto scrollabile, render full (no VDOM), handler riattaccati ad ogni render,
re-render su cambio stato. Modelli: `renderFleetView` / `renderCivView` / `renderMarketView` in
`js/main.js`.
```js
function renderFooView(stage) {
  if (!stage) return;
  const g = ORION.game; if (!g) return;

  // helper locali (closures) che ritornano HTML
  function card(x) { return '<li class="lp-item" data-id="' + x.id + '">…</li>'; }

  stage.innerHTML =
    '<div class="foo-view">' +
      '<header class="foo-view__head">' +
        '<h2 class="foo-view__title">Titolo <span class="foo-view__sub">M.. · Fase</span></h2>' +
      '</header>' +
      '<ul class="foo-list">' + g.items.map(card).join('') + '</ul>' +
    '</div>';

  // handler (delegabili)
  stage.querySelectorAll('[data-id]').forEach(function (el) {
    el.addEventListener('click', function () { openFooDetail(el.dataset.id); });
  });
}
```
CSS della vista (UI_GUIDE §5): `padding: 16px 20px; height: auto; overflow-y: auto;` per il
contenitore; head `display:flex; justify-content:space-between; flex-wrap:wrap`. **Niente
auto-dimensionamento sul contenuto**: usa `minmax(0,1fr)` o block per evitare spill orizzontale su
mobile (UI_GUIDE storico 2026-06-07). Stato collassabile **volatile** in `ORION._<feature>Collapsed`,
**mai nel save** (UI_GUIDE §9).

## 6. Superfici, spaziatura, tipografia
- Sfondi via token: `var(--c-panel)` / `rgb(var(--c-surface-rgb) / α)`, **mai terne hardcoded** (§1).
- Radius: 4-6px card piccole, 8px pannelli, 999px pill (§5). Font ≥ 0.70rem, weight ≥ 400 (§2).
- Gap interni 4-10px; padding card 6-12px (§5).

## Checklist
- [ ] letto UI_GUIDE §6/§7
- [ ] riuso `.lp-section__head` / `.lp-item` / `.deck-chip` invece di markup nuovo
- [ ] stati con `.is-ok/.is-warn/.is-crit/.is-active/.is-busy` (niente tinte nuove)
- [ ] icone via `uiIcon(name, tone)` (skill orion-ui-icon)
- [ ] bottoni `type="button"`, aria-label dove serve
- [ ] superfici via token, geometria/tipografia conformi
- [ ] stato collassabile volatile fuori dal save
