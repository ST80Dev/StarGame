# MODALITÀ DI GIOCO — Riferimento di progetto

> Documento di riferimento per le **modalità di gioco** di Orion Empires e per il loro impatto trasversale su tutti i moduli M01–M20.
> Le scelte qui descritte sono formalizzate come **decisione #23** in `CLAUDE.md` (l'infrastruttura tecnica è inoltre legata a decisione #22 — M05 game loop recovery-friendly).
> La **fonte di verità** del design generale resta `ORION_EMPIRES_GDD.md`; questo file estende §16 (Vittoria) ancora da redigere nel GDD.
> Le decisioni architetturali sono congelate; i **parametri numerici** (soglie, durate, pesi) sono indicativi e verranno tarati in M20.
>
> **Stato implementazione (M05 già rilasciato in main, PR #13):** l'infrastruttura — game state esteso, `victoryCheck`, hook `eventSchedule[]`, registry `ALIGNMENT_IMPACT`, preset, modificatori, save bumpato a `schema: 2` con migrazione `v1→v2` — è **già presente** in `js/victory.js`. Le formule di scoring sono placeholder irraggiungibili (tutte le partite di M05 girano di fatto in Sandbox). La UI di scelta modalità, le formule reali e i preset numerici sono **M20**.

---

## 1. Visione

Le modalità di gioco servono a **due scopi**:

1. **Rigiocabilità**: la stessa galassia può essere giocata in 8 modi diversi, con dinamiche di partita radicalmente differenti.
2. **Tempo di partita scalabile**: alcune modalità sono pensate per partite brevi (20–40 min), altre per partite lunghe (60–120 min), tutte sulla stessa codebase.

**Principi fondamentali (non negoziabili):**

- **Multi-pista**: ogni partita ha *tutte* le 8 piste attive in parallelo. La modalità scelta all'avvio è solo **enfasi narrativa** (tutorial, eventi iniziali, AI di partenza), non un lock. Si vince chiudendo *una qualsiasi* pista.
- **Tracker esplicito**: il giocatore vede sempre il proprio avanzamento su tutte le piste. Niente sorprese: scoprire il *come si vince* è parte del gioco, non *quanto manca*.
- **Galassia immutabile**: nessuna modalità modifica la generazione galassia o i pianeti. Tutto vive nel **delta** dello stato di gioco. Lo stesso seed è giocabile in ogni modalità.
- **Determinismo preservato**: seed+delta (decisione #5) resta la spina dorsale. Modalità ed eventi vivono nel delta serializzabile.
- **Implementazione progressiva**: nessun big-bang. Le modalità arrivano a tier in M20 e oltre.

---

## 2. Catalogo: 8 modalità di partenza, 7 piste vincibili

**Sandbox** è una **modalità di partenza** (nessuna condizione di vittoria attiva, gioco libero) ma **non è una pista vincibile**: il giocatore in Sandbox può comunque chiudere una qualsiasi delle altre 7 piste se i suoi numeri arrivano a soglia. Le altre 7 sono **piste vincibili** vere e proprie.

| # | Modalità / Pista | Trigger di vittoria (indicativo) | Durata stim. | Tier | Dipendenze moduli |
|---|---|---|---|---|---|
| 1 | **Sandbox** (solo modalità) | nessuno (gioco libero, le 7 piste restano attive in sottofondo) | ∞ | 0 | M05/M06 |
| 2 | **Esploratore** | ≥ 60% gruppi stellari `EXPLORED` entro N Impulsi | 20–30 min | 0 | M02, M05, M07 |
| 3 | **Colonizzatore** | ≥ X colonie con popolazione ≥ soglia | 35–50 min | 0 | M04, M05, M07, M08 |
| 4 | **Egemone economico** | stock cumulativo + dominio su Y valute regionali | 60–90 min | 1 | M04, M05, M12 |
| 5 | **Ascensione tecnologica** | sblocco di una *tecnologia Apice* + Z% albero §13 | 90–120 min | 2 | M04, M05, M13 |
| 6 | **Pacifista / Federatore** | Reputazione ≥ +R + W patti federativi attivi a fine timer | 50–70 min | 1 | M05, M11, M18 |
| 7 | **Tiranno / Sovrano oscuro** | Reputazione ≤ –R + K civiltà assoggettate/distrutte | 60–80 min | 2 | M05, M09, M10, M11, M18, M19 |
| 8 | **Sopravvissuto** | respingere una crisi §17 iniettata in `eventSchedule[]` alla DS 0 | 50–70 min | 2 | M05, M09, M10, M17 |

**Tier** = quando la pista diventa giocabile:
- **Tier 0**: day-one di M20 (richiede solo moduli già pianificati nel core).
- **Tier 1**: quando i moduli economia/diplomazia sono pronti (post M11/M12).
- **Tier 2**: a maturità del progetto (M13, M17, M19 completi).

L'infrastruttura per supportarle **tutte** va però predisposta in **M05**, indipendentemente da quando ognuna diventa vincibile.

---

## 3. Modello multi-pista

### 3.1 Comportamento

- Ogni partita inizia con le **7 piste** attive con `score: 0` (Sandbox è solo `startedAs`, non ha una pista).
- Ogni `CFG.VICTORY_CHECK_EVERY_I` Impulsi (vedi §8) `ORION.victory.check(game)` ricalcola lo `score` di ognuna come frazione 0..1.
- La prima pista che raggiunge `won: true` conclude la partita (un evento `victory` è scritto in cronaca).
- Il giocatore può ignorare la "modalità di partenza" e finire vincendo una pista diversa: comportamento *emergente* incoraggiato.

### 3.2 Modalità di partenza (`startedAs`)

La modalità scelta all'avvio non blocca le altre piste, ma influenza:
- **Tutorial / tooltip iniziali**: contestualizzati alla pista scelta.
- **Eventi narrativi iniziali §17**: leggermente sbilanciati verso la pista scelta nei primi N Impulsi.
- **AI di partenza**: in Sopravvissuto, crisi attivata alla DS 0; in Pacifista, civiltà vicine partono neutre; in Tiranno, qualche civiltà parte già ostile.
- **Achievement / riepilogo finale**: distinzione fra "scelta la modalità X, vinta come X" vs "scelta X, vinta come Y" (premio narrativo per i pivot).

### 3.3 Tracker visivo

Il pannello *Consiglio* (sidebar destra) mostra un blocco **"Vie di vittoria"** sempre visibile in partita libera (Sandbox), con una barra per pista:

```
Vie di vittoria
■■■■■□□□□□  Esploratore       52%
■■■□□□□□□□  Colonizzatore     31%   ← in avvicinamento
■□□□□□□□□□  Egemone economico 12%
■■■■■■■□□□  Reputazione (+)   71%   ← in avvicinamento
□□□□□□□□□□  Reputazione (–)    3%
□□□□□□□□□□  Ascensione tech    0%
○○○○○○○○○○  Tiranno          n.a.   ← richiede M19
○○○○○○○○○○  Sopravvissuto    n.a.   ← crisi non attiva
```

Le piste non sbloccate (modulo non implementato o condizioni non attive) sono visibili come *n.a.* in grigio.

---

## 4. Modificatori trasversali

Quattro modificatori ortogonali alle 8 modalità di partenza, configurabili (via preset o sblocco libero). I primi tre sono numerici nello stato (`1` = standard), per coerenza con la struttura già implementata in M05; la semantica enum esposta in UI è M20.

| Modificatore | Valori (UI M20) | Stato (oggi) | Effetto tecnico | Impatto moduli |
|---|---|---|---|---|
| **Dimensione galassia** | Piccola (40) · Standard (80–120) · Grande (160) | `galaxySize: 1` | parametro di `galaxy.generate` | M02 |
| **Pericolo §5.3** | Standard · Ostile (+50%) | `hostility: 1` | moltiplicatore in `galaxy.js` + AI in M10 | M02, M10 |
| **Velocità TSG** | ×1 · ×2 · ×4 | `tsgSpeed: 1` | moltiplicatore di Impulsi processati per click | M05 |
| **Ironman** | off · on | `ironman: false` | un solo slot save, no undo, no export manuale | M06 |

**Combinazioni nominali**: 8 × 3 × 2 × 3 × 2 = 288. Realisticamente ~30–40 sensate.

---

## 5. Preset

Per proteggere il giocatore dalla paralisi delle combinazioni e dalle accoppiate squilibrate, la schermata "Nuova partita" mostra **3–4 preset curati** (testi finali in M20):

| Preset | Modalità | Dimensione | Pericolo | TSG | Ironman | Durata target |
|---|---|---|---|---|---|---|
| **Classico** | scelta libera | Standard | Standard | ×1 | off | 50–80 min |
| **Speedrun** | Esploratore o Colonizzatore | Piccola | Standard | ×2 | off | 15–25 min |
| **Incubo** | scelta libera | Standard | Ostile | ×1 | on | 60–100 min |
| **Lungo respiro** | Ascensione tech | Grande | Standard | ×1 | off | 90–150 min |

Un toggle "**Personalizza**" sblocca i 4 modificatori liberamente con avviso:
> Alcune combinazioni possono risultare squilibrate (es. galassia grande + TSG ×4 + Ironman).

---

## 6. Impatto sui moduli

Tabella di responsabilità: cosa ogni modulo **deve esporre** perché le modalità funzionino.

| Modulo | Responsabilità aggiunta |
|---|---|
| **M02 Galassia** | parametro `size` nel generate; hook per moltiplicatore pericolo §5.3 |
| **M03 Sistema** | nessuna modifica strutturale |
| **M04 Pianeta** | nessuna modifica strutturale; tracker Colonizzatore conta da qui |
| **M05 Tempo & loop** ✅ | **cuore del sistema, già implementato** in `js/victory.js`: `ORION.victory.check`, slot `mode`/`victoryTracks`/`eventSchedule`, modificatore `tsgSpeed` come ×Impulsi/click, `ALIGNMENT_IMPACT`, `PRESETS` |
| **M06 Save** | bump `schema: 2` già fatto in M05 con `migrate(v1→v2)`; M06 aggiungerà flag Ironman applicato (un solo slot, no export) |
| **M07 Esplorazione** | espone `exploredGroupsCount` per pista Esploratore |
| **M08 Flotta** | nessuna modifica strutturale |
| **M09 Combattimento** | espone `civilizationsDefeated` per pista Tiranno; conteggio battaglie iniziate/subite per allineamento |
| **M10 AI** | tiene conto del modificatore Pericolo; profili AI iniziali influenzati da `startedAs` (Pacifista/Tiranno) |
| **M11 Diplomazia** | espone `activeFederations` per pista Pacifista; espone `vassals`/`subjugated` per pista Tiranno |
| **M12 Commercio** | espone stock cumulativo, valute regionali dominate (pista Egemone) |
| **M13 Tecnologia** | espone albero %, marker `isApexTech` per pista Ascensione |
| **M14–M16 Figure/Navi/Stazioni** | nessuna modifica strutturale |
| **M17 Eventi & narrazione** | supporto a eventi **ancorati a DS 0** (crisi del Sopravvissuto); eventi narrativi sbilanciati per `startedAs` nei primi N Impulsi |
| **M18 Reputazione & ICG** | espone valore corrente; alimenta piste Pacifista (+) e Tiranno (–) |
| **M19 Spionaggio** | espone azioni dark (sabotaggio, propaganda) marcate `alignmentImpact: 'dark'`; alimenta pista Tiranno |
| **M20 Polish & bilanciamento** | implementazione UI delle modalità, preset, schermata Nuova partita / Fine partita, tarature numeriche definitive |

---

## 7. Impatto sul data model & save

### 7.1 Estensione dello stato (`schema: 2`) — **già implementato in M05**

> Struttura reale come implementata in `js/victory.js` (PR #13, in main):

```js
ORION.game = {
  schema: 2,                  // bumpato in M05, era 1
  seed: "...",
  // M02/M03/M04 invariati
  galaxy: { ... },
  systems: { ... },
  colonies: { ... },
  timeImpulsi: 0,             // M05
  cronaca: [...],             // M05

  // NUOVI in M05 (decisione #23)
  mode: {
    startedAs: 'sandbox' | 'explorer' | 'colonizer' | 'economy'
             | 'tech'    | 'pacifist' | 'tyrant'   | 'survivor',
    preset:   'classic'  | 'speedrun' | 'nightmare' | 'longBreath' | 'custom',
    modifiers: {
      galaxySize: 1,          // numerico (1=standard, M20 deciderà semantica enum)
      hostility:  1,          // numerico (1=standard)
      tsgSpeed:   1 | 2 | 4,  // moltiplicatore di Impulsi/click
      ironman:    false | true,
    },
  },

  victoryTracks: {
    exploration:      { score: 0, won: false },
    colonization:     { score: 0, won: false },
    economy:          { score: 0, won: false },
    tech:             { score: 0, won: false },
    reputationLight:  { score: 0, won: false },
    reputationDark:   { score: 0, won: false },
    survival:         { score: 0, won: false },
  },

  eventSchedule: [],          // gancio M17 — Sopravvissuto inietterà qui la crisi a DS 0
}
```

### 7.2 Migrazione v1 → v2 — **già implementato in M05**

`ORION.victory.migrate(state)` viene chiamata automaticamente al caricamento se `schema === 1`:
- imposta `mode` ai default (`sandbox` / `classic` / modificatori a 1 / ironman off);
- inizializza i 7 `victoryTracks` a `{ score: 0, won: false }`;
- inizializza `eventSchedule: []`;
- aggiorna `schema: 2` e risalva.

Nessun campo `victoryState` separato: il flag `won` per pista + il primo `won:true` rilevato dal loop sono sufficienti.

### 7.3 Crescita del save

Trascurabile: ~200 byte fissi per `mode` + ~50 byte/pista. Nessun log di crescita illimitata legato alle modalità.

### 7.4 Ironman

In modalità Ironman:
- un solo slot di save (sovrascritto automaticamente a ogni Impulso o checkpoint);
- export/import `.json` disabilitato (decisione #5 violata di proposito per integrità del run);
- nessuna funzione di undo / reload mid-game;
- avviso esplicito in schermata Nuova partita.

---

## 8. Impatto sul game loop (M05) — **già implementato**

### 8.1 Tick principale (come implementato in `js/time.js`)

```
ogni click "+N Impulsi" (moltiplicato per tsgSpeed):
  per ogni Impulso:
    1. avanza timeImpulsi (la DS si deriva da qui)
    2. matura code di costruzione (M04)
    3. matura colonizzazioni in arrivo
    4. produce/consuma risorse (M04, con potenziali §7.1 e bonus §8.1)
    5. applica scarsità §7.4 (ok/low/crit, recupero in 3 I)
    6. cresce popolazione §9.3 + shift classi §9.2
    7. avanza scansione osservatorio §7.3
    8. se timeImpulsi % CFG.VICTORY_CHECK_EVERY_I == 0:
          ORION.victory.check(game) → aggiorna victoryTracks
          se una pista ha won:true → emette evento 'victory' in cronaca,
                                     ferma il batch
  (eventi schedulati in eventSchedule[] → M17, oggi vuoto)
  (AI in M10, oggi inesistente)
snap a fine batch + pulse CSS 380 ms sui valori HUD
```

### 8.2 `ORION.victory.check(game) → Array<TrackResult>`

Firma reale (in `js/victory.js`):

```js
ORION.victory.check(game)
// → [
//     { track: 'exploration',     score: 0..1, won: false },
//     { track: 'colonization',    score: 0..1, won: false },
//     { track: 'economy',         score: 0..1, won: false },
//     { track: 'tech',            score: 0..1, won: false },
//     { track: 'reputationLight', score: 0..1, won: false },
//     { track: 'reputationDark',  score: 0..1, won: false },
//     { track: 'survival',        score: 0..1, won: false },
//   ]
```

Ogni check è **puro** (non muta lo stato). In M05 le formule sono **placeholder con soglie irraggiungibili** (`won` sempre `false`): la struttura della firma è quella definitiva, M20 sostituirà solo le formule.

### 8.3 Frequenza

`CFG.VICTORY_CHECK_EVERY_I = 5` Impulsi (default in `victory.js`). Granularità sufficiente per UX, costo trascurabile. Parametrizzabile in M20.

### 8.4 Velocità TSG — semantica scelta in M05

Il modificatore `tsgSpeed` (1/2/4) è applicato come **moltiplicatore di Impulsi processati per click** (semantica più semplice rispetto a "frequenza del tick reale"):
- click `+5` con `tsgSpeed: 2` → processa 10 Impulsi;
- non altera i rates per Impulso, solo quanti Impulsi maturano per azione utente.

M20 deciderà se rifinire questa semantica o introdurre un autoplay temporizzato (oggi assente: il loop è guidato dai pulsanti HUD).

### 8.5 Eventi ancorati alla DS 0

Il game state contiene `eventSchedule: []` (gancio M17). Quando M17 sarà attivo, la modalità Sopravvissuto inietterà al boot un evento `{ at: 0, kind: 'crisis', ... }`; il loop di M05 è già pronto a leggere questo array, ma in M05 non c'è codice di consumo (eventSchedule resta vuoto).

---

## 9. Impatto su UI/UX

### 9.1 Schermata "Nuova partita" (M20)

Nuova schermata sostitutiva del bootstrap automatico:
- selettore di **modalità di partenza** (8 piste, con descrizione narrativa);
- selettore di **preset** (3–4, con anteprima dei modificatori);
- toggle **Personalizza** che espande i 4 modificatori;
- campo seed (manuale o "random");
- pulsante "Inizia partita".

Fino a M20: tutte le partite partono come `sandbox` / `classic` / modifiers default (comportamento attuale invariato).

### 9.2 Tracker in-game

Bloccola **"Vie di vittoria"** nel pannello *Consiglio* (vedi §3.3), sempre visibile, aggiornato a ogni `victoryTick`.

### 9.3 Notifiche di avvicinamento

Cronaca Galattica emette eventi narrativi alle soglie:
- 50% di una pista: "L'Impero si avvicina al dominio commerciale di tre regioni."
- 75% di una pista: "Tre civiltà rivali sono state assoggettate. Il timore si diffonde."
- 90% di una pista: "Un'altra esplorazione e la galassia non avrà più segreti."

### 9.4 Schermata "Fine partita"

Riepilogo:
- pista vincente + DS di vittoria;
- punteggio finale di tutte le altre piste (per achievement);
- highlight se la vittoria è arrivata su una pista **diversa** dalla `startedAs` (pivot premiato);
- pulsante "Nuova partita" / "Continua a giocare" (sandbox post-vittoria).

### 9.5 HUD

Nessuna nuova voce nell'HUD fisso. Tutto vive nel pannello destro contestuale o nella schermata Fine partita.

---

## 10. Verbi di gioco con allineamento

Per alimentare le piste Reputazione (+) e Reputazione (–), tutte le azioni di gioco rilevanti vengono marcate:

```js
{
  id: 'sabotage_colony',
  alignmentImpact: 'dark',   // 'dark' | 'light' | null
  reputationDelta: -8,
  ...
}
```

### 10.1 Azioni "light" (per Pacifista)

Esistenti nei moduli pianificati:
- proposta di trattato (M11);
- mediazione fra civiltà (M11);
- patto federativo (M11);
- aiuto umanitario / dono di risorse (M11/M12).

### 10.2 Azioni "dark" (per Tiranno)

Massimo 2–3 verbi nuovi per lato (decisione utente: poche azioni extra):
- **Saccheggio** di sistema/colonia rivale (M09);
- **Propaganda** ostile in regione (M19);
- **Schiavismo** / assoggettamento post-conquista (M11);
- **Sabotaggio** infrastrutturale (M19, già previsto in §19).

Tutti questi verbi:
- ricevono `alignmentImpact: 'dark'`;
- riducono Reputazione (M18);
- aumentano `score` della pista `reputationDark`;
- possono ridurre `score` della pista `reputationLight` (in alcuni casi).

### 10.3 Azioni neutre

La maggioranza delle azioni di gioco (colonizzare, costruire, esplorare, ricercare, commerciare alla pari) ha `alignmentImpact: null` e non influisce sull'allineamento.

---

## 11. Determinismo & seed

- **Galassia, sistemi, pianeti**: rigenerati identici dal seed (decisione #5). **Nessuna modalità li tocca.**
- **Stato modalità (`mode`, `victoryTracks`, eventi)**: vive interamente nel **delta**, serializzato in v2.
- **Crisi del Sopravvissuto**: evento iniettato alla DS 0 sul delta, non sul seed. Stesso seed → stesse stelle → giocabile in qualunque modalità.
- **AI / RNG di partita**: usano un sub-RNG `mulberry32(seed + 'run')` separato da quello galattico, per non contaminare la rigenerazione galattica.

---

## 12. Roadmap di implementazione

### 12.1 In M05 (infrastruttura) — ✅ **FATTO** (PR #13 in main)

Tutto implementato in `js/victory.js` e integrato in `js/time.js`/`js/main.js`:
- ✅ bump `schema: 1 → 2` con `ORION.victory.migrate(v1→v2)` automatica;
- ✅ slot `mode` (startedAs / preset / modifiers) e `victoryTracks` (7 piste) nello stato;
- ✅ `ORION.victory.check(game)` chiamato dal loop ogni `CFG.VICTORY_CHECK_EVERY_I = 5` Impulsi;
- ✅ modificatore `tsgSpeed` esposto e applicato come moltiplicatore di Impulsi/click;
- ✅ `eventSchedule: []` (gancio M17 — Sopravvissuto);
- ✅ registry `ALIGNMENT_IMPACT` pronto per i verbi morali (M09/M11/M19);
- ✅ 4 preset definiti in `PRESETS` (Classico/Speedrun/Incubo/Lungo respiro) con i 4 modificatori;
- ✅ tutte le 7 piste hanno una funzione di check; le formule sono **placeholder con soglie irraggiungibili** (M20 le sostituirà);
- ✅ eventi `victory` emessi in cronaca al `won:true`.

### 12.2 In M11/M12/M13 (Tier 1)

- formula reale per `checkEconomy` (espone stock cumulativo + valute regionali, decisione #13);
- formula reale per `checkReputationLight`;
- azioni "light" marcate `alignmentImpact: 'light'` via `ALIGNMENT_IMPACT`.

### 12.3 In M17/M19 (Tier 2)

- formula reale per `checkReputationDark` + 2–3 verbi extra del Tiranno marcati `dark`;
- formula reale per `checkSurvival` + consumo di `eventSchedule[]` (crisi `triggerAt: 'gameStart'`);
- formula reale per `checkTech` + marker `isApexTech` su almeno una tech.

### 12.4 In M20 (esperienza utente)

- schermata Nuova partita con scelta `startedAs` + preset (+ "Personalizza" per i modificatori liberi);
- tracker "Vie di vittoria" nel pannello *Consiglio* (le barre per le 7 piste);
- notifiche di avvicinamento in Cronaca Galattica (soglie 50%/75%/90%);
- schermata Fine partita (pista vincente + score delle altre + premio "pivot");
- **taratura numerica definitiva** di tutte le soglie nei `check*` (oggi placeholder);
- **definizione dei valori finali dei 4 preset** (oggi `PRESETS` ha modificatori ma non descrizioni narrative né durate target);
- bilanciamento delle combinazioni preset.

---

## 13. Glossario sintetico

- **Pista (track)**: una delle **7 condizioni di vittoria** attive in parallelo (Sandbox non è una pista).
- **Modalità di partenza (`startedAs`)**: una delle **8 modalità** (le 7 piste + Sandbox); enfasi narrativa scelta all'avvio. Non blocca le altre piste.
- **Preset**: pacchetto curato di `startedAs` + 4 modificatori, scegliblie in blocco. Definiti in `victory.js` → `PRESETS`.
- **Modificatori**: 4 parametri ortogonali (`galaxySize` / `hostility` / `tsgSpeed` / `ironman`).
- **`ORION.victory.check(game)`**: hook puro del game loop che ricalcola lo score di tutte le 7 piste.
- **`CFG.VICTORY_CHECK_EVERY_I`**: ogni quanti Impulsi il loop chiama `check` (default 5).
- **`ALIGNMENT_IMPACT`**: registry in `victory.js` per marcare azioni `'light' | 'dark' | null`, alimenta le piste Reputazione.
- **`eventSchedule[]`**: array di eventi schedulati nello stato (gancio M17), usato dal Sopravvissuto per la crisi a DS 0.
- **Pivot premiato**: vincere su una pista diversa dalla `startedAs` (achievement narrativo, UI in M20).
- **Tier**: 0 = vincibile al day-one M20 (formule + UI); 1 = post M11/M12; 2 = post M13/M17/M19.
- **DS 0**: data stellare dell'inizio partita; bersaglio di eventi (Sopravvissuto).
- **`schema: 2`**: versione del save dopo il bump di M05 (decisione #23). Migrazione automatica da `schema: 1`.

---

_Documento creato a corredo di decisione #22 in `CLAUDE.md`._
_Modifica autorizzata solo se la decisione architetturale cambia. I parametri numerici saranno tarati in M20._
