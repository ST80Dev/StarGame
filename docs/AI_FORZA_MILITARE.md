# Forza militare delle civiltà IA — come funziona oggi

> Documento di analisi (Revisione 2026, 2026-11-26). Nessuna modifica al codice: serve a decidere in M20.
> Certezza: **[C]** letto nel codice · **[P]** dedotto · **[I]** ipotesi da verificare.

## In breve

Una civiltà IA ha **due rappresentazioni militari scollegate tra loro**:

1. **Forza astratta `civ.power`** — un numero. È l'unica cosa che conta nei combattimenti veri (assedi alle
   tue colonie, scaramucce quando attacchi un loro sistema, guerre tra IA). [C]
2. **Flotte ambientali `game.aiFleets`** — navi visibili sulla mappa (esploratori, estrattori, trasporti, a volte
   1-2 caccia di scorta). Danno vita alla mappa e possono scontrarsi con le tue flotte nello stesso sistema,
   ma **non attaccano colonie e non sono la forza d'invasione**. [C]

Distruggere le flotte visibili **non riduce** `civ.power` (aifleet.js non lo modifica mai). [C]
Le flotte che vedi quindi non dicono quanto è forte una civiltà.

## 1. `civ.power` — la forza vera

| Cosa la fa crescere | Dove |
|---|---|
| Base: 8 per pianeta alla nascita (`POWER_PER_PLANET`) | ai.js:924 |
| Crescita a ogni ciclo: 0,4 × pianeti × fase di espansione | ai.js:1085 |
| Colonizzazione (+5,6), conquista nelle guerre tra IA (+5,6) | ai.js:1101, 1337, 1350 |
| Colonia conquistata al giocatore (+15) | time.js:1814 |
| Aiuto ricevuto da un alleato in difficoltà (+5) | diplomacy.js:1034 |

| Cosa la fa calare | Dove |
|---|---|
| Perdite nelle guerre tra IA (−6 per nave), pianeta perso (−8) | ai.js:1325-1351 |
| Scaramuccia persa contro il giocatore (−12), vinta (−5) | ai.js:1816 (`demobilize`) |
| Pianeta tolto dal giocatore (−4) | time.js:1475 |
| Sabotaggio (spionaggio) | espionage.js:319 |

## 2. Come diventa una forza in battaglia

`ai.materialize(game, civ, sysId)` [C] trasforma il numero in unità di combattimento:

- **unità = `civ.power` / 25 × massa tecnologica × massa della vocazione**
- ogni unità ha HP 70 e fuoco 14 (combat.js), moltiplicati per tecnologia e vocazione
  (Mistici fragili, Imperialisti pesanti)

Usata in: assedi IA alle tue colonie (time.js:1565), scaramucce quando attacchi un loro sistema
(time.js:1349, 2180), guerre tra IA (ai.js:1320).

**Ogni battaglia schiera l'intera `civ.power`, ovunque avvenga e contemporaneamente.** [C] Non c'è ripartizione
tra colonie né "truppe impegnate altrove".

## 3. Cosa ti mostra l'interfaccia

La stima nel dossier civiltà usa `ai.aiCombatPowerAt` (main.js:9051, 9130), che **ragiona diversamente** [C]:

- applica un moltiplicatore di mobilitazione per relazione con te (alleanza 0, pace 0,40, tregua 0,60,
  ostile 0,85, guerra 1,0), fase e vocazione, e una penalità se hanno perso da poco;
- sottrae 1 unità per ogni incursione già in corso;
- **divide la forza tra le colonie** (la capitale pesa 1,5, le altre 0,7-1,2);
- aggiunge le flotte reali ferme nel sistema.

### Incongruenza principale

**La stima della UI sottostima pesantemente la difesa reale.** [C — misurato]
Simulazione: 10 partite × 1000 Impulsi, 426 colonie IA (tutte civiltà in pace col giocatore, partita passiva).
La stima della UI vale in **media il 4%** della forza che combatterebbe davvero, con **mediana 0%**: la
ripartizione tra colonie e il moltiplicatore di pace arrotondano a zero unità. Se attacchi, la battaglia usa
`materialize`, cioè **tutta** la forza. Il giocatore attacca convinto di avere un vantaggio che non ha.
Con relazione di guerra lo scarto si riduce (moltiplicatore 1,0) ma resta la divisione tra colonie. [P]

## 4. Altre osservazioni

- **Simultaneità** [C]: la stessa `civ.power` può difendere tre sistemi e assediarne un quarto nello stesso
  momento. Il costo delle incursioni in corso (`aiEngagementCost`) esiste solo nella stima UI.
- **Flotte ambientali come segnale** [P]: la scorta di caccia compare sopra 40 e 120 di potenza; è l'unico
  indizio visivo della forza, ed è molto grossolano.
- **Intelligence** [C]: il dossier dà una fascia di incertezza sulla `civ.power` (±60% → esatta con
  l'infiltrazione). Questa parte è coerente: il problema è la formula di stima, non l'incertezza.

## 5. Opzioni per M20

| Opzione | Cosa cambia | Costo |
|---|---|---|
| **A. Allineare la stima alla battaglia** ✅ fatto (2026-11-27) | La UI mostra la forza che combatterebbe davvero (`materialize`), con la stessa fascia d'incertezza | Basso. Solo calcolo della stima |
| **B. Mobilitazione anche in battaglia** | Le battaglie usano la stessa formula della stima (ripartizione tra colonie, relazione, truppe impegnate): attaccare una colonia periferica diventa più facile della capitale | Medio. Cambia molto l'equilibrio delle guerre |
| **C. Forza "fisica"** | `civ.power` si incarna in flotte militari reali sulla mappa: distruggerle indebolisce davvero la civiltà, la forza si sposta | Alto. Riprogettazione di IA, combattimento e prestazioni |

**Raccomandazione:** A subito (è un'incongruenza che inganna il giocatore, non una scelta di design: si può fare anche prima di M20); B come
decisione di bilanciamento dopo averla simulata; C solo se si vuole un gioco più "militare" e visivo — si
sposa bene con la mappa PixiJS (Fase 4) ma è il lavoro più grande.
