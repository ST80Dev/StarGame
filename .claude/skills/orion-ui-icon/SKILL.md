---
name: orion-ui-icon
description: Aggiungere o usare un'icona SVG nel catalogo centralizzato di Orion Empires (js/icons.js → ORION.icon/ORION.icons) con tinta tematica + glow, secondo UI_GUIDE §3. Usa quando ti serve un glyph nuovo per una sezione/bottone/badge, o vedi un glyph Unicode "piatto" da migrare a SVG canonico. PRIMA leggi UI_GUIDE.md §3.
---

# Aggiungere/usare un'icona

⚠️ **Leggi `UI_GUIDE.md` §3 prima** (R2). Principio: *un concetto = una tinta = un'icona*. Niente
glyph "piatto" color-text; ogni icona porta la sua tinta tematica + glow morbido. Per il nuovo
codice il canone è **inline SVG** (approccio B), non glyph Unicode.

Catalogo centralizzato: `js/icons.js`. API: `ORION.icon(name)` → stringa SVG; `ORION.icons` → mappa.
Wrapper HTML: `uiIcon(name, tone)` in `js/main.js:4055`.

## 1. Aggiungi la voce al catalogo
`js/icons.js`, oggetto `ICONS`. Usa l'helper `svg(inner)` (`js/icons.js:28`) che impone il formato
canonico (viewBox 24×24, `stroke="currentColor"`, `stroke-width=2`, linecap/linejoin round —
stile lineare tipo Lucide):
```js
const ICONS = {
  // ...
  /* Alert — triangolo con punto esclamativo. */
  alert: svg(
    '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>' +
    '<line x1="12" y1="9"  x2="12" y2="13"/>' +
    '<line x1="12" y1="17" x2="12.01" y2="17"/>'
  ),
};
```
Regole sul path:
- ViewBox **24×24**, coordinate dentro quell'area, decimali semplificati.
- **Nessun colore nell'SVG**: il colore arriva da `currentColor` (la classe `.ui-icon--{tone}`).
- Tratto coerente (2px round). Per riempimenti puntuali usa `fill="currentColor"` sul singolo
  elemento (es. nucleo di una stella), non sull'intero svg.
- `name` univoco e semantico (kebab/camel come gli esistenti: `galaxy`, `shipColoniale`, `dispatch`).

`ORION.icon(name)` ritorna `ICONS[name] || ''` (`js/icons.js:459`): un nome assente non rompe nulla
ma rende stringa vuota — attento ai typo.

## 2. Usa l'icona
HTML via il wrapper (mette `aria-hidden` + classe tono):
```js
uiIcon('alert', 'warn')   // → <span class="ui-icon ui-icon--warn" aria-hidden="true">…svg…</span>
```
La **tinta** la dà la classe `.ui-icon--{tone}` in CSS (`color: var(--c-…)`), il **glow** è
`filter: drop-shadow(0 0 3px currentColor)` su `.ui-icon` (UI_GUIDE §3: blur 3-4px, alpha 0.35-0.45,
niente alone marcato). Toni e mapping concetto→tinta: UI_GUIDE §1 (ciano nav/flotte, ambra
colonia/sistema, viola ricerca/tutorial, verde mercato, rosa civ/critico, oro capitale, azzurro
pianeta/intel).

Se manca la classe `.ui-icon--<tone>` in CSS, aggiungila accanto alle altre:
```css
.ui-icon--warn { color: #f0d670; }   /* o var(--c-…) appropriato */
```

## 3. Migrazione da glyph Unicode (approccio A → B)
UI_GUIDE §3: i glyph Unicode forzati restano solo come fallback nelle sezioni vecchie; quando
tocchi quel codice, migra opportunisticamente a SVG. **Mai mescolare A e B nello stesso pannello.**

## 4. Coerenza & onboarding
- Riusa la tinta canonica del concetto (UI_GUIDE §1) — niente accenti "estetici" arbitrari.
- 3 livelli di prominenza (hero ~1.05rem / standard ~0.95-1.0rem / inline ~0.85-0.9rem, §3).
- Se l'icona rappresenta un **concetto nuovo**, aggiungi la lezione tutorial (skill
  `orion-tutorial-lesson`, UI_GUIDE §0.9).
- Anteprima: `icons-preview.html` / `icons-preview.svg` documentano il catalogo.

## Checklist
- [ ] voce in `ICONS` via `svg(...)`, viewBox 24×24, `currentColor`, no colori inline
- [ ] `name` univoco, nessun typo nei punti d'uso
- [ ] usata con `uiIcon(name, tone)` + classe `.ui-icon--{tone}` esistente in CSS
- [ ] tinta = mapping concetto→colore di UI_GUIDE §1, glow conforme §3
- [ ] (concetto nuovo) lezione tutorial aggiunta
