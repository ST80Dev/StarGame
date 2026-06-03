# CLAUDE.md — Stato di sviluppo di Orion Empires

> File di stato aggiornato a ogni sessione, come richiesto dal GDD (§0, §21).
> La **fonte di verità** del design è `ORION_EMPIRES_GDD.md`.
> Sviluppo **modulo per modulo**: ogni modulo va confermato prima di passare al successivo.

---

## Identità del progetto

- **Titolo:** Orion Empires
- **Tipo:** 4X spaziale strategico a pannelli (testuale, non action, non libro-game)
- **Stack:** Vanilla JS puro, HTML, CSS — nessun framework, nessun CDN, nessuna chiamata esterna
- **Piattaforma:** Browser / GitHub Pages
- **Salvataggio:** localStorage (slot multipli) — da implementare in M06

---

## Stato moduli

Legenda: ✅ completato · 🚧 in corso · ⬜ non iniziato · ⏸️ in attesa di conferma

| #   | Modulo                         | Stato | Note |
|-----|--------------------------------|:----:|------|
| M01 | Struttura base (shell, tema, layout) | ⏸️ | Implementato — in attesa di conferma utente |
| M02 | Galassia (gen. procedurale, mappa Canvas) | ⬜ | |
| M03 | Sistema stellare               | ⬜ | |
| M04 | Pianeta base                   | ⬜ | |
| M05 | Tempo e Cicli (TSG, game loop) | ⬜ | |
| M06 | Salvataggio (localStorage)     | ⬜ | |
| M07 | Esplorazione                   | ⬜ | |
| M08 | Flotta base                    | ⬜ | |
| M09 | Combattimento                  | ⬜ | |
| M10 | Civiltà AI                     | ⬜ | |
| M11 | Diplomazia                     | ⬜ | |
| M12 | Commercio                      | ⬜ | |
| M13 | Tecnologia                     | ⬜ | |
| M14 | Figure speciali                | ⬜ | |
| M15 | Grandi navi                    | ⬜ | |
| M16 | Stazioni spaziali              | ⬜ | |
| M17 | Eventi e narrazione            | ⬜ | |
| M18 | Reputazione e ICG              | ⬜ | |
| M19 | Spionaggio                     | ⬜ | |
| M20 | Polish e bilanciamento         | ⬜ | |

---

## M01 — Struttura base · cosa è stato fatto

**Obiettivo (GDD §20):** HTML shell, CSS tema, layout pannelli, font.

- `index.html` — shell completa con:
  - Sfondo stellare parallax (3 layer, CSS puro)
  - **HUD superiore:** brand, barra risorse base (Metalli/Energia/Cibo/Acqua), indici globali (ICG, Reputazione, **Data Stellare**) — valori segnaposto `—`
  - **Corpo a 3 colonne:** pannello navigazione (sinistra), viewport centrale (futura mappa Canvas), pannello Consiglio/dettagli (destra)
  - **HUD inferiore:** Cronaca Galattica + **controllo del tempo** (salti +1/+2/+5/+10 Cicli + "Prossimo evento", disabilitati finché non c'è un game loop)
- `css/style.css` — tema scuro spaziale completo:
  - Tutto il theming via **CSS custom properties** (`:root`)
  - Palette: nero profondo + blu/viola + accenti ciano/arancio (come da §3)
  - Layout a griglia, pannelli semitrasparenti con blur, scrollbar a tema
  - Animazioni parallax e pulse con rispetto di `prefers-reduced-motion`
  - Responsive (collassa pannelli su schermi stretti)
- `js/main.js` — bootstrap minimo: switch della vista attiva nella navigazione. **Nessuna logica di gioco** (per non anticipare moduli futuri).
- Gli attributi `data-bind="..."` sui valori HUD sono predisposti per il binding dati dei moduli futuri.

### Aggancio per i moduli futuri
- I valori HUD usano `data-bind` (es. `data-bind="metalli"`, `data-bind="icg"`, `data-bind="data-stellare"`).
- Il viewport centrale ha `[data-view-stage]`: lì verrà montato il Canvas 2D (M02/M03).
- I controlli del tempo: `data-action="advance"` con `data-cicli="1|2|5|10"`, e `data-action="advance-to-event"`. Il game loop temporale arriva in M05.

---

## Decisioni prese

1. **Font senza CDN.** Il GDD suggerisce *Orbitron* da Google Fonts (§3), ma vieta anche dipendenze/CDN esterni (§2). Per rispettare il vincolo più stringente si usa uno **stack di font** (`--font-display`) che impiega Orbitron se installato localmente, con fallback di sistema. In futuro si potrà includere il font come file locale (`/fonts`) senza chiamate esterne.
2. **Branch `main`.** Il repository era vuoto: l'impalcatura iniziale fa da base. Lo sviluppo avviene sul branch dedicato indicato per la sessione.
3. **JS minimale in M01.** Nessuna struttura di gioco anticipata: i file `js/galaxy.js`, `js/planet.js`, ecc. previsti dal GDD §2 verranno creati nei rispettivi moduli.
4. **Tempo al posto dei turni (GDD §4 riscritto).** Su richiesta utente l'avanzamento non è più "a turni" ma a **tempo**, cardine del gioco. Introdotto il **Tempo Standard Galattico (TSG)**, slegato da giorno/anno terrestri e ancorato a un riferimento galattico (Faro di Orion):
   - Unità: **Ciclo** (atomica) · **Fase** = 10 C · **Orbita** = 100 C · **Èra** = 1000 C
   - HUD mostra la **Data Stellare** `DS <orbita>.<cicli>` (es. `DS 100.13`)
   - Avanzamento: salti **+1/+2/+5/+10 Cicli** + **"Avanza fino al prossimo evento"**
   - Durate del GDD §4 ricalibrate in Cicli (passi 1-10 sensati); termine "turno" sostituito da "Ciclo" in tutto il GDD
   - Nomi delle unità rinominabili se l'utente preferisce.

---

## Problemi aperti / da decidere più avanti

- Includere o meno il font Orbitron come asset locale (`/fonts`) in un modulo di polish (M20).
- Definire lo schema dello stato di gioco (game state) prima di M04/M05.
- Strategia di layout della mappa galattica su Canvas (clustering procedurale) da affrontare in M02.

---

## Struttura file attuale

```
stargame/
├── index.html          ✅ shell UI
├── css/
│   └── style.css        ✅ tema scuro spaziale
├── js/
│   └── main.js          ✅ bootstrap shell
├── CLAUDE.md            ✅ questo file
├── README.md            ✅
└── ORION_EMPIRES_GDD.md ✅ documento di design (fonte di verità)
```

Gli altri file/cartelle previsti dal GDD §2 (`js/galaxy.js`, `data/`, ecc.)
verranno aggiunti nei moduli corrispondenti.

---

_Ultimo aggiornamento: 2026-06-03 — M01 + modello a tempo (TSG) al posto dei turni._
