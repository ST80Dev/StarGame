# MODALITÀ DI GIOCO — Riferimento di progetto

> Documento di riferimento per le **modalità di gioco** di Orion Empires e per il loro impatto trasversale su tutti i moduli M01–M20.
> Le scelte qui descritte sono formalizzate come **decisione #22** in `CLAUDE.md`.
> La **fonte di verità** del design generale resta `ORION_EMPIRES_GDD.md`; questo file estende §16 (Vittoria) ancora da redigere nel GDD.
> Le decisioni architetturali sono congelate; i **parametri numerici** (soglie, durate, pesi) sono indicativi e verranno tarati in M20.

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

## 2. Catalogo delle 8 piste

| # | Pista | Trigger di vittoria (indicativo) | Durata stim. | Tier | Dipendenze moduli |
|---|---|---|---|---|---|
| 1 | **Sandbox** | nessuno (gioco libero) | ∞ | 0 | M05/M06 |
| 2 | **Esploratore** | ≥ 60% gruppi stellari `EXPLORED` entro N Impulsi | 20–30 min | 0 | M02, M05, M07 |
| 3 | **Colonizzatore** | ≥ X colonie con popolazione ≥ soglia | 35–50 min | 0 | M04, M05, M07, M08 |
| 4 | **Egemone economico** | stock cumulativo + dominio su Y valute regionali | 60–90 min | 1 | M04, M05, M12 |
| 5 | **Ascensione tecnologica** | sblocco di una *tecnologia Apice* + Z% albero §13 | 90–120 min | 2 | M04, M05, M13 |
| 6 | **Pacifista / Federatore** | Reputazione ≥ +R + W patti federativi attivi a fine timer | 50–70 min | 1 | M05, M11, M18 |
| 7 | **Tiranno / Sovrano oscuro** | Reputazione ≤ –R + K civiltà assoggettate/distrutte | 60–80 min | 2 | M05, M09, M10, M11, M18, M19 |
| 8 | **Sopravvissuto** | respingere una crisi §17 attivata alla DS 0 | 50–70 min | 2 | M05, M09, M10, M17 |

**Tier** = quando la pista diventa giocabile:
- **Tier 0**: day-one di M20 (richiede solo moduli già pianificati nel core).
- **Tier 1**: quando i moduli economia/diplomazia sono pronti (post M11/M12).
- **Tier 2**: a maturità del progetto (M13, M17, M19 completi).

L'infrastruttura per supportarle **tutte** va però predisposta in **M05**, indipendentemente da quando ognuna diventa vincibile.

---

## 3. Modello multi-pista

### 3.1 Comportamento

- Ogni partita inizia con tutte le piste attive con `score: 0`.
- Ogni `victoryTick` (vedi §8) ricalcola lo `score` di ognuna come frazione 0..1.
- La prima pista che raggiunge `score: 1` e supera il suo trigger di vittoria conclude la partita.
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

Quattro modificatori ortogonali alle 8 piste, configurabili (via preset o sblocco libero):

| Modificatore | Valori | Effetto tecnico | Impatto moduli |
|---|---|---|---|
| **Dimensione galassia** | Piccola (40) · Standard (80–120) · Grande (160) | parametro di `galaxy.generate` | M02 |
| **Pericolo §5.3** | Standard · Ostile (+50%) | moltiplicatore in `galaxy.js` + AI in M10 | M02, M10 |
| **Velocità TSG** | ×1 · ×2 · ×4 | divisore del tick principale del loop | M05 |
| **Ironman** | off · on | un solo slot save, no undo, no export manuale | M06 |

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
| **M05 Tempo & loop** | **cuore del sistema**: schedulazione `victoryTick`, slot `mode`/`victoryTracks`, modificatore TSG, scheduler eventi alla DS 0 |
| **M06 Save** | bump `schemaVersion: 2` con migrazione v1→v2; flag Ironman; export disabilitato in Ironman |
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

### 7.1 Estensione dello stato (`schemaVersion: 2`)

```js
ORION.game = {
  schemaVersion: 2,
  seed: "...",
  // M02/M03/M04 unchanged
  galaxy: { ... },
  systems: { ... },
  colonies: { ... },

  // NUOVO in M05
  mode: {
    startedAs: 'sandbox' | 'explorer' | 'colonizer' | 'economy'
             | 'tech'    | 'pacifist' | 'tyrant'   | 'survivor',
    preset:   'classic'  | 'speedrun' | 'nightmare' | 'longBreath' | 'custom',
    modifiers: {
      galaxySize: 'small' | 'standard' | 'large',
      hostility:  'standard' | 'hostile',
      tsgSpeed:   1 | 2 | 4,
      ironman:    false | true,
    },
  },

  victoryTracks: {
    exploration:      { score: 0, available: true,  won: false },
    colonization:     { score: 0, available: true,  won: false },
    economy:          { score: 0, available: false, won: false }, // M12
    tech:             { score: 0, available: false, won: false }, // M13
    reputationLight:  { score: 0, available: false, won: false }, // M11/M18
    reputationDark:   { score: 0, available: false, won: false }, // M19
    survival:         { score: 0, available: false, won: false }, // M17
  },

  victoryState: 'playing' | 'won' | 'lost',
  winner: null | { track, ds, snapshot },
}
```

### 7.2 Migrazione v1 → v2

In `load(save)`, se `schemaVersion === 1`:
- imposta `mode` ai default (sandbox / classic / modifiers di default);
- inizializza `victoryTracks` con `available` calcolato dai moduli presenti;
- imposta `victoryState: 'playing'`;
- aggiorna `schemaVersion: 2` e risalva.

### 7.3 Crescita del save

Trascurabile: ~200 byte fissi per `mode` + ~50 byte/pista. Nessun log di crescita illimitata legato alle modalità.

### 7.4 Ironman

In modalità Ironman:
- un solo slot di save (sovrascritto automaticamente a ogni Impulso o checkpoint);
- export/import `.json` disabilitato (decisione #5 violata di proposito per integrità del run);
- nessuna funzione di undo / reload mid-game;
- avviso esplicito in schermata Nuova partita.

---

## 8. Impatto sul game loop (M05)

### 8.1 Tick principale

```
ogni Impulso:
  1. avanza la DS di +1
  2. processa code di costruzione (M04)
  3. produce/consuma risorse (M04)
  4. cresce popolazione (M04/M09)
  5. fa muovere flotte (M08)
  6. processa eventi schedulati (M17)
  7. AI prende decisioni (M10)
  8. se DS % victoryTickInterval == 0:
        - chiama victoryCheck(state) → Array<TrackResult>
        - aggiorna victoryTracks
        - se qualche track ha won:true:
              imposta victoryState = 'won', winner = ...
              ferma il loop, apre schermata Fine partita
```

### 8.2 `victoryCheck(state) → Array<TrackResult>`

Firma standard:

```js
function victoryCheck(state) {
  return [
    checkExploration(state),
    checkColonization(state),
    checkEconomy(state),
    checkTech(state),
    checkReputationLight(state),
    checkReputationDark(state),
    checkSurvival(state),
  ];
}
// TrackResult = { track: string, score: 0..1, won: boolean, available: boolean }
```

Ogni `check*` è puro: non muta lo stato, legge solo. Un check ritorna `available: false` se il modulo che lo alimenta non esiste ancora.

### 8.3 Frequenza

`victoryTickInterval = 5 Impulsi` (default). Granularità sufficiente per UX, costo trascurabile. Parametrizzabile in M20.

### 8.4 Velocità TSG

Il modificatore `tsgSpeed` agisce **solo sul timer reale** del loop, non sulla logica:
- ×1 = 1 Impulso ogni N ms;
- ×2 = 1 Impulso ogni N/2 ms;
- ×4 = 1 Impulso ogni N/4 ms.

Il giocatore può sempre mettere in pausa o passo-singolo.

### 8.5 Eventi ancorati alla DS 0

Lo scheduler eventi §17 deve supportare la programmazione di un evento al momento di creazione partita (`triggerAt: 'gameStart'`). Usato per la crisi del Sopravvissuto.

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

### 12.1 In M05 (infrastruttura)

**Obbligatorio per il loop:**
- bump `schemaVersion: 2` + migrazione v1→v2;
- slot `mode` e `victoryTracks` nello stato;
- `victoryCheck(state)` chiamato ogni `victoryTickInterval` Impulsi;
- modificatore `tsgSpeed` sul timer del loop;
- scheduler eventi supporta `triggerAt: 'gameStart'`;
- check Tier 0 vincolabili: `checkExploration`, `checkColonization`, `checkSandbox` (sempre `available:false` perché non vincibile, ma valida la firma).

**Predisposto, non attivo:**
- gli altri 5 check ritornano `{available:false}` finché i moduli non li alimentano;
- campo `alignmentImpact` nelle action definition (anche se nessuna azione lo usa ancora).

### 12.2 In M11/M12/M13 (Tier 1)

- `checkEconomy` attivato (espone stock cumulativo + valute regionali);
- `checkReputationLight` attivato;
- azioni "light" marcate `alignmentImpact: 'light'`.

### 12.3 In M17/M19 (Tier 2)

- `checkReputationDark` attivato + 2–3 verbi extra del Tiranno;
- `checkSurvival` attivato + crisi schedulabili a `gameStart`;
- `checkTech` attivato + marker `isApexTech` su almeno una tech.

### 12.4 In M20 (esperienza utente)

- schermata Nuova partita con scelta modalità + preset;
- tracker "Vie di vittoria" nel pannello *Consiglio*;
- notifiche di avvicinamento in Cronaca Galattica;
- schermata Fine partita;
- taratura numerica definitiva di tutte le soglie;
- bilanciamento delle combinazioni preset.

---

## 13. Glossario sintetico

- **Pista (track)**: una delle 8 condizioni di vittoria attive in parallelo.
- **Modalità di partenza (`startedAs`)**: l'enfasi narrativa scelta all'avvio. Non blocca le altre piste.
- **Preset**: pacchetto curato di modalità + modificatori, scegliblie in blocco.
- **Modificatori**: 4 parametri ortogonali (dimensione/pericolo/TSG/ironman).
- **`victoryCheck`**: hook puro del game loop che ricalcola lo score di tutte le piste.
- **`victoryTickInterval`**: ogni quanti Impulsi il loop chiama `victoryCheck` (default 5).
- **Allineamento**: marcatore `'light' | 'dark' | null` sulle azioni di gioco, alimenta le piste Reputazione.
- **Pivot premiato**: vincere su una pista diversa dalla `startedAs` (achievement narrativo).
- **Tier**: 0 = vincibile al day-one M20; 1 = post M11/M12; 2 = post M13/M17/M19.
- **DS 0**: data stellare dell'inizio partita; può essere bersaglio di eventi (Sopravvissuto).

---

_Documento creato a corredo di decisione #22 in `CLAUDE.md`._
_Modifica autorizzata solo se la decisione architetturale cambia. I parametri numerici saranno tarati in M20._
