# ORION EMPIRES — Game Design Document
> Documento di riferimento per lo sviluppo con Claude Code  
> Repository: `stargame` (privato) | GitHub Pages attivo  
> Versione GDD: 1.0

---

## 0. ISTRUZIONI PER CLAUDE CODE

Questo documento è la fonte di verità per tutto lo sviluppo di *Orion Empires*.  
Prima di scrivere qualsiasi codice, leggi l'intera sezione pertinente.  
Sviluppa **modulo per modulo**, confermando ogni pezzo prima di procedere al successivo.  
Non anticipare funzionalità non ancora richieste.  
Mantieni sempre un `CLAUDE.md` aggiornato nella root del repository con lo stato attuale dello sviluppo.

---

## 1. IDENTITÀ DEL GIOCO

**Titolo:** Orion Empires  
**Repository:** stargame  
**Tipo:** 4X spaziale strategico (eXplore, eXpand, eXploit, eXterminate)  
**Interfaccia:** Testuale/pannelli — NON un action game, NON un libro game  
**Definizione "testuale":** Interfaccia a pannelli, tabelle, numeri, pulsanti, testo narrativo — stile Master of Orion / Dwarf Fortress UI  
**Piattaforma:** Browser (GitHub Pages), vanilla JS, nessuna dipendenza esterna  
**Salvataggio:** localStorage (slot multipli) + Export/Import file `.json` per trasferire le partite tra dispositivi (PC ↔ tablet)  

---

## 2. STACK TECNICO

```
stargame/
├── index.html              ← entry point, shell UI
├── css/
│   └── style.css           ← tema scuro spaziale, font evocativi, HUD sci-fi
├── js/
│   ├── main.js             ← inizializzazione, game loop, gestione del tempo
│   ├── galaxy.js           ← generazione procedurale galassia
│   ├── system.js           ← sistemi stellari, pianeti, lune
│   ├── planet.js           ← logica pianeti, risorse, strutture, popolazione
│   ├── fleet.js            ← navicelle, flotte, combattimento
│   ├── ai.js               ← civiltà AI, comportamenti, decisioni
│   ├── diplomacy.js        ← relazioni inter-civiltà, stati diplomatici
│   ├── trade.js            ← rotte commerciali, mercato interno
│   ├── research.js         ← albero tecnologico, ricerca distribuita
│   ├── events.js           ← eventi casuali, cronaca galattica, missioni
│   ├── characters.js       ← figure speciali, comandanti, consiglio
│   ├── save.js             ← salvataggio/caricamento localStorage
│   └── ui.js               ← rendering pannelli, transizioni, mappa
├── data/
│   ├── names.js            ← nomi sistemi stellari (reali + inventati)
│   ├── ships.js            ← definizioni navicelle e upgrade
│   ├── techs.js            ← albero tecnologico
│   ├── structures.js       ← strutture costruibili
│   └── archetypes.js       ← archetipi razze/figure
└── CLAUDE.md               ← stato sviluppo aggiornato ad ogni sessione
```

**Regole tecniche:**
- Vanilla JS puro, no framework, no CDN esterni
- CSS custom properties per tutto il theming
- Canvas 2D solo per mappa galattica e sistemi (no WebGL)
- localStorage per i salvataggi (slot multipli); in più Export/Import file `.json` con `schemaVersion` per il trasferimento manuale tra dispositivi
- Nessuna chiamata a server esterni (eventuale cloud-sync resta opzionale e futuro: stesso payload del save)
- Target: **desktop (browser PC) + tablet**; telefoni non supportati (viewport troppo ridotta). Larghezza minima ~768px, layout responsive a due fasce (desktop/tablet-landscape · tablet-portrait con pannello dettagli collassabile)
- Canvas responsivo (resize al contenitore + `devicePixelRatio`) e input unificato mouse/touch via Pointer Events

---

## 3. ESTETICA VISIVA

**Tema:** Scuro spaziale, HUD fantascienza, pannelli semitrasparenti  
**Palette:** Nero profondo + blu/viola spaziale + accenti ciano/arancio per elementi attivi  
**Font:** Display epico per titoli (es. Orbitron o simile da Google Fonts), monospace per dati numerici, leggibile per testo narrativo  
**Stelle:** Sfondo animato con stelle parallax in CSS  
**Pianeti:** Cerchi stilizzati con texture CSS procedurale (colori, anelli, atmosfere)  
**Transizioni:** Effetto warp/hyperjump tra sistemi, dissolvenze tra pannelli  
**Mappa galattica:** Canvas 2D — nodi collegati da linee, nebbia di guerra, pulsazioni su rotte attive  
**Mappa sistema:** Canvas 2D — orbite animate, pianeti con caratteristiche visive distinte  
**HUD:** Pannelli fissi con risorse, Data Stellare corrente, indice corruzione galattica, notifiche eventi  

---

## 4. TEMPO (TEMPO STANDARD GALATTICO)

**Principio fondamentale:** Il tempo scorre quando il giocatore lo fa scorrere. Nessuna attesa reale. Il **tempo è il cardine del gioco**: produzione, costruzione, ricerca, viaggi, eventi e diplomazia sono tutti espressi come *tassi per Impulso* e *durate in Impulsi*. Niente è scollegato dal flusso temporale.

### 4.1 Unità di tempo — niente giorni/anni terrestri
Il gioco si svolge attraverso la galassia e usa uno standard temporale slegato dalla rotazione di qualunque pianeta. L'unità è ancorata a un riferimento galattico (il **Faro di Orion**, una pulsar) ed è valida ovunque.

| Unità | Valore | Ruolo nel gioco |
|-------|--------|-----------------|
| **Impulso (I)** | unità atomica | passo base dell'avanzamento; granularità di tutti i timer |
| **Arco (A)** | 10 Impulsi | timer brevi, finestre di evento |
| **Orbita (O)** | 100 Impulsi | pianificazione strategica, durata accordi diplomatici/commerciali |
| **Èra (È)** | 1000 Impulsi | scala storica (Memoria Storica §17.2) |

> Il termine **"Impulso" sostituisce ovunque il vecchio "turno"** usato nelle prime bozze: ogni durata nel resto del documento è in Impulsi.

### 4.2 Data Stellare (display HUD)
Il tempo corrente è mostrato come **Data Stellare**: `DS <orbita>.<impulsi-nell'orbita>` (due decimali).
La parte intera sono le Orbite trascorse dallo zero del calendario (la calibrazione del Faro di Orion); i due decimali sono l'Impulso corrente all'interno dell'orbita (00-99). Il decimale delle decine corrisponde all'Arco.
Esempio di avanzamento: `DS 1873.00` → dopo 13 Impulsi `DS 1873.13` → dopo 100 Impulsi `DS 1874.00`.

**Epoca d'inizio randomizzata:** a ogni nuova partita la Data Stellare iniziale è estratta a caso nell'intervallo **DS 800.00 – DS 3000.00** (Orbita casuale, Impulsi a `.00`). La galassia preesiste sempre al giocatore: le civiltà AI e l'ICG sono già in moto. _(La randomizzazione effettiva avverrà con la generazione della partita, M02/M05.)_

### 4.3 Controllo dell'avanzamento
- **Salti rapidi:** pulsanti **+1 / +2 / +5 / +10 Impulsi** per il controllo fine.
- **"Avanza fino al prossimo evento":** salta automaticamente al prossimo momento significativo (fine costruzione, completamento ricerca, arrivo flotta, evento programmato). Evita il click-spam sui tempi lunghi e mantiene il giocatore padrone del ritmo (§21).
- **Salvataggio:** possibile in qualsiasi momento, anche tra un salto e l'altro.

### 4.4 Esempi di costi temporali (in Impulsi)
Valori ricalibrati perché i salti da 1-10 Impulsi restino significativi, mantenendo i rapporti relativi tra le voci.
- Struttura base (miniera semplice): **8-15 Impulsi**
- Struttura avanzata (cantiere navale): **45-75 Impulsi**
- Caccia leggero: **8-12 Impulsi**
- Corvetta / Incrociatore: **20-40 Impulsi**
- Fregata: **60-90 Impulsi**
- Dreadnought: **180-240 Impulsi** (~2 Orbite)
- Stazione orbitale: **120-150 Impulsi**
- Tecnologia base: **30-60 Impulsi**
- Tecnologia avanzata: **150-300 Impulsi**
- Colonizzazione secondo corpo stesso sistema: **90-150 Impulsi** + risorse

### 4.5 Interconnessione eventi-tempo
Tutto fluisce in modo continuo. Gli eventi hanno conseguenze temporali (un embargo dura X Impulsi, una guerra cambia rotte, una carestia rallenta le costruzioni). Le AI agiscono negli Impulsi che il giocatore fa scorrere. Niente è isolato.

---

## 5. LA GALASSIA

### 5.1 Struttura
- **Dimensione:** 80-120 sistemi stellari totali, fissi per partita
- **Visibilità iniziale:** Solo il sistema di partenza + sistemi adiacenti parzialmente visibili
- **Nebbia di guerra:** Sistemi non esplorati mostrano solo posizione approssimativa sulla mappa, nessun dettaglio
- **Generazione:** Procedurale a ogni nuova partita, seed salvabile
- **Rappresentazione:** Grafo a nodi su Canvas 2D, layout procedurale con clustering

### 5.2 Nomi sistemi
**Mix 40% reali / 60% inventati, distribuiti casualmente (no logica geografica)**

**Reali da pool:**
Aldebaran, Vega, Altair, Deneb, Rigel, Betelgeuse, Antares, Procyon, Fomalhaut, Achernar, Mimosa, Hadar, Elnath, Zubenelgenubi, Canopus, Arcturus, Spica, Pollux, Regulus, Sirius

**Inventati — tre stili:**
- Latino/classico: Vorthan, Caelum, Nexaris, Valdris, Omneth, Serath, Calvion, Drenath
- Aspro/alieno: Keth-Var, Draxis, Zorvahl, Thrennis, Karveth, Vrox, Skethara, Ghulvann
- Poetico/misterioso: Serenthal, Auveth, Lirnos, Vaelith, Dawnspire, Elorath, Mirvael, Thyssen

### 5.3 Pericolo galattico
- **Sistemi vicini:** Relativamente sicuri di default, pericolo da fattori locali (vicini ostili, instabilità, pirati)
- **Sistemi lontani:** Pericolo crescente con distanza dal pianeta base
- **Fattori locali:** Civiltà ostile nelle vicinanze, sistema conteso, anomalia spaziale, presenza pirata

### 5.4 Indice Corruzione Galattica (ICG)
- Valore 0-100 visibile sempre in HUD
- Sale quando civiltà maligne conquistano sistemi, saccheggiano, diffondono influenza
- Scende quando il giocatore o civiltà "buone" liberano sistemi, stringono alleanze, stabilizzano zone
- **Soglie:**
  - 0-30: Galassia relativamente stabile
  - 31-60: Tensioni crescenti, eventi negativi più frequenti
  - 61-80: Crisi galattica, civiltà buone sotto pressione, bonus nemici
  - 81-100: Collasso imminente — condizione di sconfitta progressiva
- **Obiettivo soft:** Mantenere ICG basso è uno scopo continuo, non un obiettivo rigido

### 5.5 Navigazione gerarchica (gruppi stellari)
La mappa è **scalabile a livelli**, con la sidebar destra che mostra dati
**coerenti con la scala selezionata**:

1. **Galassia** — i sistemi sono raggruppati in **gruppi stellari** (i cluster
   di generazione), mostrati come **regioni** con nome proprio. Nomi in schema
   **misto**: descrittore evocativo + riferimento (un sistema reale famoso del
   gruppo se presente, es. "Velo di Vega"; altrimenti un nome evocativo, es.
   "Distesa di Auvethal").
2. **Gruppo stellare** — entrando (click sulla regione o zoom) compaiono le
   **singole stelle-sistema** del gruppo, con rotte ed etichette.
3. **Sistema planetario** — la stella/e (incluse le **binarie**, §6.1) con i
   corpi in orbita. *(Vista interna: M03.)*
4. **Pianeta** — il singolo corpo celeste. *(Vista dettaglio: M04.)*

Una **breadcrumb** consente di risalire i livelli. I dati di scala superiore
restano soggetti alla **nebbia di guerra** (§5.1): di un gruppo non ancora
esplorato si conoscono nome, numero di sistemi e pericolo medio, ma non i tipi
stella dei sistemi ignoti.

---

## 6. I SISTEMI STELLARI

### 6.1 Struttura di un sistema
Ogni sistema contiene:
- 1 stella (tipo: nana gialla, gigante rossa, nana bianca, binaria...)
- **5-10 pianeti** + lune (sub-corpi di gassosi e rocciosi grandi) + cinture asteroidali
- Anomalie opzionali: campo di detriti, nebulosa locale, reliquie antiche

**Variabilità di configurazione (decisione #52):** i sistemi non seguono una distribuzione fissa "1 abitabile per fascia orbitale" come nel sistema solare terrestre. Le orbite indicano una **preferenza** del tipo planetario (interno → vulcanico/desertico al 70%, abitabile centrale al 70%, esterno → ghiacciato/gassoso al 70%) ma con un **30% di "anomalia fisica" ammessa** che produce configurazioni inaspettate (ghiacciati intrappolati vicino alla stella, gassosi innatamente interni, ecc.). Distribuzione globale tarata per dare ~1.4 abitabili per sistema in media:

| Configurazione sistema | Frequenza | Note |
|---|---|---|
| **Standard single-prime** | ~45% | 1 abitabile prime + estrattivi + gassosi |
| **Standard prime+marginale** | ~25% | 1 prime + 1 marginale (×0.75 slot/pop/potenziali) |
| **Doppio prime** | ~8% | 2 abitabili distinti (es. terr+ocean) |
| **Triplo prime** (raro) | ~2% | Sistema "paradiso", bersaglio strategico |
| **Senza prime** | ~10% | Solo estrattivi/gassosi |
| **Sistema metallifero anomalo** | ~5% | 4-6 vulcanici/desertici, niente abitabili, +50% potenziali metallo |
| **Sistema delle nebbie / gassoso** | ~3% | 3-5 gassosi + lune, rifugio per fazioni orbitali |
| **Stranezza fisica** | ~2% | Configurazione irregolare (es. tutti ghiacciati attorno a stella calda), eventi §17 gancio |

I marginali (terrestre/oceanico/forestale "piccoli") hanno:
- **Slot** ridotti a ×0.75 del prime (vedi §10.2 per slot base)
- **Pop cap** ×0.75
- **Potenziali §7.1** ×0.80 mediamente, con bilanciamenti **complementari** al prime (es. prime forte in cibo+metalli, marginale forte in acqua+energia)

Effetto: la **coabitazione naturale** giocatore/AI in uno stesso sistema diventa plausibile (tu sul prime, una micro-AI sul marginale o su un vulcanico). Si veda §13.6 per le dinamiche di coesione.

### 6.2 Colonizzazione
- **Tutti i corpi celesti sono colonizzabili** ma con caratteristiche molto diverse
- Il giocatore sceglie quale colonizzare per primo — scelta che condiziona tutto
- Gli altri rimangono disponibili ma a costo elevato finché il primo è produttivo
- **Eccezione:** Se il primo pianeta è esaurito o gravemente impoverito, colonizzare un secondo diventa più accessibile (migrazione naturale forzata)
- Colonizzare un secondo corpo richiede: tecnologia specifica + infrastruttura consolidata sul primo + risorse significative + tempo (90-150 Impulsi)

#### 6.2.bis Avvio partita (3 fasi)

L'avvio non è "colonia già operativa": l'umanità (o civiltà giocata) **sceglie** la propria origine tra una rosa di candidati e poi affronta una breve fase di **Insediamento** prima della piena operatività. Coerente con §6.2 ("la scelta che condiziona tutto"): la scelta della colonia originaria è la prima decisione strategica.

**Fase 0 — Scelta colonia originaria**
- Alla pressione di "Nuova partita" il sistema mostra **una rosa di candidati** (uno per gruppo stellare della galassia, cap a **6** per non sovraccaricare la UI).
- Ogni candidato è il **miglior corpo abitabile** del proprio sistema (fascia abitabile §6.1; tipi rocky-habitable preferiti).
- Il sistema che contiene il candidato scelto diventa il **sistema d'origine**; il pericolo §5.3 si ricalibra dalla sua posizione (la mappa delle distanze cambia con la scelta).
- Il giocatore può "Scegli per me" (random tra i candidati) per saltare la decisione.
- Determinismo (decisione #5): stesso seed → stessi candidati. La scelta finale viene salvata nel game state come `homeWorld: { systemId, bodyKey }`, NON ricavata dal seed al runtime.

**Fase 1 — Insediamento (`settling`)**
- La colonia parte in stato `settling` per ~**60 Impulsi** (taratura da preset, vedi §16/decisione #23). Durante la fase:
  - **Produzione strutturale ridotta a 50%** (atterraggio, scarico moduli, prime infrastrutture provvisorie)
  - **Bonus +50% sulla velocità di costruzione della prima struttura** (la coda parte avvantaggiata: serve far decollare la colonia in fretta)
  - **Crescita popolazione bloccata** (la pop iniziale non sale finché non finisce l'Insediamento — la fertilità tornerà con l'operatività)
  - **Cronaca scriptata**: voci predeterminate ("Atterraggio dei moduli avanguardia" al tick 0, "Fondazione di `<nome colonia>`" al tick ~20, "Primi insediamenti civili" al tick ~40, "Insediamento completato — la colonia è operativa" al termine)
- Tarature da preset (default 60 I): Speedrun 30 I · Incubo 90 I · Lungo respiro 120 I.
- La fase è **recovery-friendly** (decisione #22): finisce sempre da sola, mai un fail-state. Anche con scelte pessime, il giocatore non resta bloccato.

**Fase 2 — Operativa (`operational`)**
- Stato pieno: produzione 100%, crescita pop attiva, bonus pianeta base §8.1, scarsità §7.4 normale.
- Da qui in poi il loop M05 lavora come da specifica.

**Stato iniziale di colonia (preset Classico, default)**
- `pop.total = 3` (fisso; preset: Speedrun 5 / Incubo 2 / Lungo respiro 3)
- `stock = { met: 120, en: 60, food: 50, water: 50 }` (≈55% del buffer M06: l'atterraggio consuma)
- `isHomeBase = true` (§8.1)
- `phase = 'settling'`, `settlingStart = startDS`, `settlingDuration = 60` (preset)
- Stock × `startStockMul` (Classico 1.0 · Speedrun 1.5 · Incubo 0.5 · Lungo respiro 1.2)

### 6.3 Tipi di corpo celeste e caratteristiche
| Tipo | Vantaggi | Svantaggi |
|------|----------|-----------|
| Pianeta terrestre | Agricoltura, popolazione alta | Risorse minerali medie |
| Pianeta desertico | Minerali abbondanti, rarità | Cibo scarso, caldo estremo |
| Pianeta oceanico | Acqua abbondante, biochimica | Costruzioni costose |
| Pianeta ghiacciato | Risorse criogeniche, rarità | Energia costosa, lento |
| Pianeta vulcanico | Energia geotermica, metalli pesanti | Instabile, pericoloso |
| Pianeta forestale | Biomassa, farmaceutici | Minerali scarsi |
| Gigante gassoso | Elio-3, gas rari | Non abitabile, solo estrazione orbitale (energia) |
| Luna | Estrazione a **paniere** (tutte le risorse in proporzione) + strato avanzato | **Non colonizzabile** (redesign 2026), gravità bassa |
| Cintura asteroidale | Minerali puri, metalli rari | Solo estrazione (metalli), non abitabile |

> **Redesign lune (2026).** La luna **non è più colonizzabile**: competeva male coi
> pianeti (14 slot, pop cap 3, brutta copia di un mondo vero). Ora è un **giacimento
> a paniere** non abitabile, nello stesso paradigma di cinture (metalli) e giganti
> gassosi (energia), ma con un profilo estrattivo distinto:
> - **Strato base** — estrae **tutte e 4 le risorse base in proporzione** ai potenziali
>   seed-derived (non solo la più abbondante), depositate nello stock della colonia
>   attiva più vicina.
> - **Strato avanzato** — risorse avanzate (esotici) verso `exoticAccum`, sbloccato
>   solo quando una colonia con **Osservatorio** è entro raggio (la scansione rivela
>   in modo permanente l'identità avanzata: ridà un mestiere durevole all'Osservatorio).
> - **Due vie d'estrazione:** flotta con **Estrattore** in survey (via base, early-game)
>   oppure **Stazione ancorata** alla luna (estrae di default per sola presenza, rate ∝
>   livello stazione). Le due si **escludono a vicenda** sullo stesso corpo: con una
>   stazione ancorata non si manda anche un estrattore.
> - Riserva più capiente delle altre, stessa rigenerazione continua (recovery-friendly).
>   I corpi prime d'origine restano rocciosi: nessun impatto su home/AI.

---

## 7. RISORSE

### 7.1 Risorse base (sempre visibili, fondamentali)
- **Metalli** — costruzioni, navicelle
- **Energia** — alimenta tutto
- **Cibo** — sostiene la popolazione
- **Acqua** — crescita popolazione, alcuni processi

### 7.2 Risorse avanzate (parzialmente nascoste, sbloccano upgrade e tech)
- **Cristalli energetici** — propulsione avanzata, armi ad energia
- **Metalli esotici** — scafi resistenti, armature
- **Biomassa rara** — farmaceutici, potenziamenti popolazione
- **Gas nobili** — tecnologie atmosferiche, scudi
- **Reliquie antiche** — trovabili esplorando, sbloccano tech uniche
- **Dati sintetici** — ricerca accelerata, IA

### 7.3 Scoperta risorse
- Risorse base: visibili subito alla colonizzazione
- Risorse avanzate: si scoprono costruendo strutture esplorative, dopo X Impulsi, o tramite eventi
- Alcune risorse rarissime appaiono solo come eventi speciali o nelle reliquie

### 7.4 Scarsità
- La scarsità crea **frizione e rallentamenti**, non game over improvvisi
- Sotto soglia critica: malus a produzione, morale, velocità costruzione
- Non si "fermano" le operazioni di colpo — si degradano gradualmente
- Il giocatore ha sempre un Impulso di preavviso negli eventi

### 7.5 Mercato interno
- Pianeti colonizzati possono rifornirsi a vicenda
- Costo di trasporto proporzionale alla distanza (Impulsi + risorse)
- Surplus automaticamente redistribuito se rotte interne attive
- Distanza tra sistemi influisce significativamente sull'efficienza

---

## 8. PIANETA BASE

### 8.1 Bonus pianeta base
- +20% produzione su tutte le strutture
- Sede del Consiglio della Civiltà
- Attrae figure speciali più facilmente
- Morale popolazione sempre +10
- Hub principale rotte commerciali interne

### 8.2 Trasferimento pianeta base
**Formula concettuale:** `Costo = Dimensione × Radicamento ÷ Livello Tecnologico`

| Fase civiltà | Costo base | Note |
|-------------|-----------|------|
| Piccola/giovane | Basso | Poco da smontare, popolazione adattabile |
| Media | Significativo | Qualche Impulso di instabilità, fattibile |
| Grande | Alto | Traumatico, molti Impulsi, rischio eventi |
| Impero consolidato | Altissimo | Quasi scelta disperata se tech bassa |

**Tecnologia come moltiplicatore:** Livello tech alto riduce il costo proporzionalmente — navi migliori, smontaggio rapido, architetture modulari.

**Due modalità:**
1. **Graduale:** X Impulsi con due capitali parziali, bonus dimezzati su entrambe — meno traumatico
2. **Immediato:** Costo enorme in risorse, shock immediato — solo per emergenze

**Limiti:** Max 2 trasferimenti per partita (costo del terzo è proibitivo)

---

## 9. POPOLAZIONE E CLASSI FUNZIONALI

### 9.1 Principio
La popolazione è gestita in background — non si assegnano singoli lavoratori a singole strutture. La composizione per classi influenza i numeri globali, emerge negli eventi.

### 9.2 Classi funzionali
| Classe | Influenza |
|--------|-----------|
| **Operai** | Velocità costruzione strutture, produzione risorse base |
| **Scienziati** | Velocità ricerca, qualità tech sbloccate |
| **Militari** | Qualità navicelle prodotte, efficienza combattimento |
| **Mercanti** | Efficienza rotte commerciali, prezzi diplomazia |
| **Tecnici** | Efficienza strutture, riduzione consumi energia |

### 9.3 Crescita
- La popolazione cresce automaticamente ogni Impulso in base a: cibo, acqua, morale, strutture abitative
- La composizione per classi si aggiusta lentamente in base alle strutture presenti
- Più cantieri navali → più militari nel tempo
- Più laboratori → più scienziati
- Il giocatore influenza indirettamente tramite cosa costruisce

### 9.4 Consiglio della Civiltà
3 figure non più operative, esperti di settore, con opinioni:
- **Consigliere Militare** — valuta minacce, suggerisce espansione o difesa
- **Consigliere Economico** — monitora risorse, commercio, segnala criticità
- **Consigliere Scientifico** — guida priorità ricerca, segnala opportunità tech

Il Consiglio interviene tramite **eventi testuali** periodici — non ogni Impulso. Il giocatore può ignorare i suggerimenti ma con possibili conseguenze non immediate.

---

## 10. STRUTTURE

### 10.1 Categorie
- **Estrattive:** Miniere, pozzi energetici, impianti idrici, fattorie
- **Produttive:** Fonderie, raffinerie, fabbriche componenti
- **Ricerca:** Laboratori, osservatori, archivi
- **Militari:** Cantieri navali, accademie, basi di lancio
- **Civili:** Centri abitativi, ospedali, mercati
- **Avanzate:** Stazioni di trasferimento, impianti esotici (richiedono risorse rare)

### 10.2 Regole costruzione
- Ogni struttura ha costo in risorse + tempo (Impulsi)
- Alcune strutture richiedono prerequisiti tecnologici
- Strutture danneggiate in guerra riducono efficienza, riparabili
- Limite slot costruzione per pianeta (espandibile con tech)

---

## 11. TECNOLOGIA

### 11.1 Principio
- L'albero tech è **parzialmente nascosto** — le tech avanzate non sono visibili finché non si è abbastanza sviluppati
- La ricerca è **distribuita** — laboratori su più pianeti contribuiscono insieme
- Tech **catturabili** conquistando sistemi nemici avanzati

### 11.2 Categorie tech
- **Propulsione** — velocità navi, range salto iperspaziale
- **Armi** — potenza fuoco, tipi di armamento
- **Scudi e armature** — resistenza navi
- **Estrazione** — efficienza risorse, accesso risorse rare
- **Biologia** — crescita popolazione, classi funzionali
- **Costruzione** — velocità e qualità strutture, slot pianeta
- **Informatica** — spionaggio, efficienza gestione, anomalie
- **Trasferimento** — colonizzazione avanzata, logistica inter-sistema

### 11.3 Conseguenze narrative (occasionali)
Alcune tech particolarmente potenti possono scatenare reazioni diplomatiche o eventi speciali — non sistematicamente, ma come sorpresa occasionale.

---

## 12. FLOTTA E COMBATTIMENTO

### 12.1 Classi navicelle
| Classe | Ruolo | Upgrade | Figure assegnabili |
|--------|-------|---------|-------------------|
| **Caccia leggero** | Intercettore veloce, massa | Sì | Nessuna |
| **Bombardiere** | Anti-strutture | Sì | Nessuna |
| **Corvetta** | Schermaglie, pattuglia | Sì | Nessuna |
| **Incrociatore** | Combattimento medio | Sì | Nessuna |
| **Fregata** | Capitale media | Sì | Comandante + Ingegnere O Stratega |
| **Dreadnought** | Capitale pesante, rara | Sì | Comandante + Ingegnere + Stratega |
| **Nave Ammiraglia** | Unica per civiltà | Sì | Tutte le figure + bonus speciale |

### 12.2 Upgrade navicelle
Ogni navicella ha slot upgrade:
- **Armi:** Laser, cannoni a particelle, missili, armi esotiche (tech avanzata)
- **Scudi:** Scudi energetici, armature composite, scudi rigenerativi
- **Motori:** Velocità, consumo, range
- **Sistemi:** Sensori, mimetismo, supporto vita esteso

### 12.3 Veteranità e esperienza
- Le navicelle accumula esperienza da battaglie sopravvissute
- Livelli: Verde → Veterana → Elite → Leggendaria
- Ogni livello: +5% efficienza combattimento, riduzione errori tattici
- Navi leggendarie hanno nome proprio generato proceduralmente

### 12.4 Figure di flotta — emergenza dal basso
**Le figure non si creano artificialmente — emergono dalle battaglie:**
- Un pilota di caccia sopravvive a N battaglie → candidato promozione
- Il giocatore riceve notifica: "Il pilota [nome] si è distinto — promuovere?"
- Una volta promosso diventa figura assegnabile alle grandi navi

**Tre figure:**
| Figura | Effetto |
|--------|---------|
| **Comandante** | Morale flotta, comportamento battaglia, efficacia ritirata |
| **Ingegnere di Flotta** | Velocità riparazione, consumi viaggio, resistenza danni |
| **Stratega** | Scelte tattiche automatiche, bonus imboscate, difesa perimetrale |

**Figure = personaggi unici:** Hanno nome, background, razza (vedi archetipi), statistiche. Se muoiono in battaglia sono persi per sempre.

**Grandi navi rare:** Le Fregate e soprattutto i Dreadnought sono costosi e lenti da costruire — averne molti è un traguardo, non la norma. Questo rende le figure assegnabili preziose e le perdite pesanti.

### 12.5 Combattimento
**Quasi-automatico con controllo minimo:**
- Il giocatore sceglie: obiettivo prioritario, formazione (aggressiva/difensiva/bilanciata), comportamento in caso di perdite (tieni posizione/ritirati al 30%/ritirati al 50%)
- Il combattimento si risolve in fasi automatiche
- Report testuale dettagliato: fasi di battaglia, perdite, eventi notevoli, veterani emersi
- Navi distrutte: perdita permanente — navi gravemente danneggiate riparabili in base al livello danni

### 12.6 Battaglie campali multi-flotta
Quando più flotte (proprie e/o alleate vs nemiche) convergono sullo stesso sistema:
- Battaglia unica con fasi distinte
- Ordine di arrivo conta (chi arriva prima ha vantaggio posizionale)
- Possibilità di coordinare con alleati AI (se diplomazia attiva)

### 12.7 Stazioni spaziali
- Costruibili in qualsiasi sistema esplorato; una sola stazione per sistema.
- Entità a **livelli (1→4)**, non strutture interne: le funzioni sono fisse, la capacità scala col livello.
- Funzioni: avamposto militare (difesa), porto di rifornimento flotte (#69), cantiere navi leggere/medie (≤ Fregata), riparazione/refit, e — se **ancorata a una luna** — estrazione a paniere (vedi §6.3).
- Difendibili, attaccabili, conquistabili.

#### 12.7.1 Logistica stazione (redesign 2026)

**Magazzino tipizzato unico.** La stazione tiene un magazzino delle **4 risorse base** `{food, water, met, en}`, *quasi come lo stock di una colonia* (non più un "serbatoio astratto"). Da qui attinge per **tutto**:
- **Rifornimento flotte (#69):** consuma le 4 risorse nelle **stesse proporzioni** del rifornimento a colonia (`food/water/met` su equipaggio, `en` su stazza — voce dominante). Coerenza piena col meccanismo base.
- **Cantiere navale:** il metallo per assemblare scafi esce **dallo stesso magazzino** (niente più riserva metalli separata).
- **Upkeep / riparazione:** piccolo drenaggio di sostentamento.

Cap **per-risorsa**, scalato col livello: un rifornimento (dominato dall'energia) svuota soprattutto la casella energia, lasciando food/water per upkeep e difesa.

**Rifornitrice esplicita & riassegnabile.** Ogni stazione è legata a **UNA colonia rifornitrice**, scelta dal giocatore (default = fondatrice), **riassegnabile liberamente**. La colonia riempie il magazzino per-risorsa (1:1 dal suo stock). Così puoi spostare il carico da una colonia in difficoltà a una florida, e una colonia ricca può reggere più stazioni.

**Gradiente di distanza `L`.** Niente più muro netto a 4 hop. Sia la costruzione sia la rifornitura sono ammesse **fino a 8 hop**, ma con efficienza logistica `L ∈ [0.50, 1.00]`:
- `h ≤ 4` → `L = 1.0` (pieno regime); lineare fino a `L = 0.50` a 8 hop; `h > 8` → `isolated`.
- `L` scala **solo i ritmi** (lentezza/logistica): velocità di rifornimento (in), riparazione, metallo al cantiere, e **consegna dell'estratto alla colonia** (out).
- `L` **non** tocca la potenza ferma: una stazione integra/riparata combatte al **100% ovunque**. Il malus di una base lontana emerge dalla lentezza di rifornimento/riparazione, non da un debuff sulle strutture al 100%.
- Se la rifornitrice è persa → auto-fallback alla colonia valida più vicina ≤8 hop (voce di cronaca); nessuna ≤8 → `isolated` (recovery-friendly: husk difensivo riconquistabile, mai distrutto).

Scelta strategica risultante: **base avanzata lontana** = utile per tenere una flotta dove non hai colonie (difesa/porto pieni se in salute), ma **lenta da rifornire/riparare** e con **estrazione poco redditizia netta** → l'estrazione efficiente la fai vicino casa.

**Auto-feed estrazione (stazione ancorata a luna).** La luna rende il **paniere pieno** (nessun `L` sull'estrazione). I 4 base estratti **auto-alimentano il magazzino della stazione** (uso locale, piena efficienza), rendendo una base ancorata più autosufficiente. **Esotici + l'eccedenza** oltre i cap del magazzino vengono **consegnati alla colonia rifornitrice `× L`** (l'export lungo è lossy). L'energia estratta serve in loco al rifornimento, non è solo export.

---

## 13. CIVILTÀ AI

> Questa sezione riflette la **rifondazione del motore AI** (decisione #52): galassia frammentata e organica, vocazioni persistenti come driver di comportamento, AI proattive ma differenziate, 4 fazioni fisse "di colore", federazioni emergenti, dinamiche imprevedibili ma controllate.

### 13.1 Frammentazione iniziale (nessun monolite)
La galassia parte come **arcipelago di popoli**, non come scacchiera spartita tra 4-5 imperi. Conteggio iniziale (deterministico dal seed, valori target):

| Componente | Numero | Note |
|---|---|---|
| **Imperi consolidati** | 2-4 | 5-12 pianeti ciascuno, presenza territoriale matura |
| **Micro-civiltà** | 10-15 | 1-3 pianeti ciascuna, presenza minima ma viva |
| **4 Costanti fisse** | 4 (sempre presenti) | Vedi §13.7 |
| **Totale fazioni** | ~16-23 | A inizio partita |

L'**occupazione iniziale di pianeti** target ~10% della galassia, con vincolo deterministico "spazio libero giocatore ≥ 65%" → il giocatore parte con **enorme margine di espansione**. Crescita AI calibrata (vedi §13.5) lascia ~75% libero anche a Ι 10000.

### 13.2 Vocazioni AI (driver di comportamento)
Ogni AI nasce con una **vocazione persistente**, determinata dal seed, che ne plasma TUTTO il comportamento (espansione, diplomazia, guerra, commercio). Vocazione = carattere, non parametro.

| Vocazione | Peso generazione | Comportamento caratteristico |
|---|---|---|
| **Sedentari** | 25% | Si tengono 2-4 pianeti. Non espandono di iniziativa. Reattivi solo se attaccati. Proattivi diplomaticamente. |
| **Mercantili** | 15% | Espansione lenta + focus alleanze + rotte. Propongono accordi commerciali. Ostili a chi rompe il commercio. |
| **Espansionisti** | 15% | Classica crescita territoriale attiva. Guerre offensive ammesse. |
| **Isolazionisti** | 12% | Chiudono confini, rifiutano dispacci, pattugliano. Attaccano chi entra senza permesso. |
| **Predoni** | 10% | Poche colonie fisse + razzie sui vicini. Vivono di taglie e bottino. |
| **Mistici** | 10% | "Convertono" piccoli vicini con dispacci diplomatici. Non militari. |
| **Tecnocratici** | 8% | Focus tech, neutrali militarmente, alleati naturali di chi ha alta Reputazione. |
| **Imperialisti** | 5% | Variante aggressiva degli espansionisti. Rari ma pericolosi. |

**Affinità planetaria** come tratto secondario (decisione #52 punto 6): ogni AI riceve anche un'**affinità di tipo planetario** che ne modula le scelte di colonizzazione — es. *Imperialista + Ferrigna* predilige vulcanici/desertici, *Sedentaria + Biotica* predilige forestali/oceanici. Peso ×2.0 sulla scelta di pianeti del tipo preferito, senza esclusività. Effetto: paesaggio diversificato, coabitazione naturale (tu sul prime, AI ferrigna sul vulcanico dello stesso sistema).

### 13.3 Allineamento (asse morale)
Indipendente dalla vocazione. Mix garantito alla generazione:
- **Bene** (~35%): preferiscono pace, alleanze, aiuto agli alleati. Penalità Reputazione su aggressione verso di loro.
- **Male** (~30%): preferiscono dominio, tradimenti, ICG attivo. Penalità Reputazione su alleanza con loro (sei "compromesso").
- **Neutrale** (~35%): seguono convenienza. Risposte deterministiche al contesto.

Allineamento × Vocazione = matrice di caratteri unica. Es. *Mercantile Bene* è equo e affidabile; *Mercantile Male* è il classico ricattatore; *Sedentario Bene* è il vicino fidato; *Predone Male* è la minaccia tipica.

### 13.4 Fasi vitali (modulazione, non sostituzione)
Ogni AI attraversa **fasi** che modulano la sua vocazione senza cambiarla. Una Sedentaria in declino cede sistemi ma resta Sedentaria.

| Fase | Effetto |
|---|---|
| **growth** (default alla nascita) | Vocazione piena, espansione/azione attiva |
| **rise** | ×1.5 azione caratteristica per 600-1000 Ι |
| **stable** | ×0.5 espansione, guerre solo difensive |
| **decline** | Espansione 0, perde 1 pianeta ogni ~250 Ι ai bordi, vulnerabile |
| **collapse** | Perde 1 pianeta ogni ~80 Ι, terminale |

Transizioni deterministiche (`seed:civ:<id>:phase`) con probabilità per-fase. Le fasi danno **ritmo** alla vocazione, generano voci narrative ("L'Impero X entra in declino"), creano **finestre di opportunità** per il giocatore.

### 13.5 Calibrazione espansione (galassia "calma")
Numeri tarati perché il giocatore abbia spazio decisionale (orizzonte realistico ~10000 Ι per maturare un impero competitivo):

| Parametro | Valore | Effetto |
|---|---|---|
| **Warmup iniziale** | 500 Ι | 0 movimenti AI. Insediamento + prima struttura tranquilli |
| **Ramp early-game** | ×0.3 nei 2000 Ι successivi | Decollo dolce, ~3-5 annessioni totali |
| **Chance espansione base** | 0.005 per AI per AI-tick | A 10000 Ι: ~30-35 annessioni totali in galassia |
| **Chance guerre AI-vs-AI** | 0.015 per AI-tick | ~1 schermaglia ogni ~80 Ι |
| **Chance nascita arrampicatore** | 0.005 | Nessun nuovo prima di ~5000 Ι |

A Ι 10000 la galassia tipica è ~25% AI occupata, **75% libera**. Mai strangolata.

### 13.6 Proprietà al pianeta + coesione di sistema
**La proprietà è al pianeta, non al sistema** (decisione #52 punto 9). Un sistema può ospitare colonie di proprietari diversi. Stato del sistema derivato:
- **Esclusivo** (Player o AI X): solo colonie di un proprietario
- **Sotto influenza X**: ≥66% colonie sono di X
- **Conteso/Condiviso**: due o più proprietari senza maggioranza
- **Neutrale**: nessuna colonia

**Colonizzare in un sistema con presenza altrui** ha conseguenze sulla disposizione del proprietario (no blocco hard):

| Relazione | Penalità disposizione |
|---|---|
| Alleanza | 0 (alleati condividono) |
| Pace + amichevole | −5 |
| Pace + neutrale/ostile | −10 |
| Tregua | −15 |
| Guerra | 0 (ma assedio possibile dalla colonia vicina) |

**Sistema coeso** (consorzio locale emergente): un sistema è coeso se TUTTE le condizioni sono vere:
1. ≥2 fazioni distinte hanno colonie nel sistema
2. ≥50% dei corpi colonizzabili sono colonizzati
3. ≥3 colonie totali nel sistema
4. Tutti i proprietari sono in pace/alleanza tra loro
5. Il giocatore non è alleato di tutti

**Effetti del sistema coeso** (riusano meccaniche esistenti, niente nuovi parametri):
- **Move/move-route con flotta**: warning UI + −1 disposizione/proprietario (cap −3/visita)
- **Spedizione in transito**: +5% incidente per proprietario (cap +15%)
- **Colonizzazione**: penalità rafforzata −15 disposizione/proprietario
- **Attacco a una coesa**: solidarietà → −15 disposizione delle altre coese
- **Rottura coesione**: se due membri entrano in guerra, o tu diventi alleato di tutti, la coesione cade automaticamente

UI: alone ambra tratteggiato sul nodo + tooltip "Sistema coeso · X+Y+Z in pace". Cronaca `system-cohesion-formed`/`broken` (atmosfera, auto-pause OFF).

### 13.7 Le Quattro Costanti (fazioni fisse di colore)
Quattro fazioni **sempre presenti** in ogni galassia, ognuna con funzione narrativa/gameplay unica. Vivono sopra il conteggio di §13.1 (non riducono lo slot di micro o imperi). Visibili nella vista Civiltà ⬡ come sezione fissa "Le Quattro Costanti" con nome+ruolo sempre noti (anche prima del contatto), dossier completo dopo interazione.

| Fazione | Sistemi | Distribuzione | Funzione |
|---|---|---|---|
| **Sindacato Mekhari** | 6-9 | Sparsa — 1 hub per cluster (rete capillare) | Mercato grigio, contrabbando, taglie pirata, intel grigia (M19), spread ridotto nei cluster dove presente. **Rete capillare + molte carovane in viaggio** → facili da incrociare; avvistarne un hub *o* identificarne una flotta **apre subito il contatto** (fixer che si fa vivo da sé). **Vocazione fissa: Mercantile.** |
| **Conclave di Vehryn** | 2-4 | Sparsa — avamposti presso sistemi con anomalie/reliquie | Vendita informazioni su sistemi inesplorati, dati antichi §7.2, contratti scoperta. **Vocazione fissa: Tecnocratici + affinità Glaciale.** |
| **Guardiani di Phaerion** | 2-3 | Concentrata — sede ancestrale + 1-2 satelliti | Custodi di tech antica, intransigenti sui confini (scaramuccia su violazione), forniscono tech rare se aiutati. **Vocazione fissa: Isolazionisti + affinità Ancestrale.** |
| **Pellegrini di Solhar** | 3-5 | Sparsa — missioni in cluster Nucleo/Colonie | Conversione diplomatica (dispacci, alleanze ideologiche), figure speciali religiose (gancio M14), bonus passivo decadimento ICG quando galassia allineata. Subiscono secessioni eretiche (scissione → nuova micro-AI). **Vocazione fissa: Mistici + affinità Biotica.** |

Le 4 Costanti hanno **comportamenti speciali rispetto alle vocazioni base**: i Mekhari espandono pianissimo (~1 nuovo nodo ogni ~4000-8000 Ι), i Phaerion non espandono affatto (subiscono solo decline lento), Vehryn e Pellegrini espandono con cadenza media ma in direzioni dettate dalla loro funzione (Vehryn segue le anomalie nuove, Pellegrini cercano civiltà da convertire).

### 13.8 Federazioni emergenti (fusione di alleanze)
Quando due AI restano alleate per ≥N Ι senza tradimenti, accumulano **trust reciproco**. Superata una soglia + vocazioni compatibili, una propone **patto federativo**. Se entrambe accettano (deterministicamente, in base a vocazione+allineamento), si **fondono** in una entità composita:
- **Nome composito** (es. "Federazione di Aethon-Vega")
- **Colore unificato** (mix delle tinte originali)
- **Somma sistemi/pianeti/potere** delle due
- **Decisioni concertate** (movimenti unificati, espansione coordinata)

**Fragilità interna**: se le vocazioni divergono troppo (es. Sedentaria + Imperialista), o un membro perde >50% del proprio territorio originario, la federazione **si spezza** → pezzi tornano AI separate (memoria del trust resta a 0).

**Iterazione**: una federazione può a sua volta federarsi con un'altra → in late-game possono emergere **blocchi** composti da 4-6 micro originali → guerre totali blocco-vs-blocco quando arrivano.

Vivono come campo composito calcolato run-time (`game.federations[]`) — non sostituiscono le `civs` ma le riferenziano.

### 13.9 Diplomazia (stati base)
**Stati**: Guerra / Tregua / Pace / Alleanza (vedi §13.4 e implementazione decisione #51).

**Transizioni**: tramite azioni del giocatore (M11), eventi (§17), cambi di reputazione (§14). **Tradimenti**: AI di allineamento Male possono tradire alleanze con preavviso indiretto (cronaca, spionaggio M19). AI di allineamento Bene non tradiscono mai (vincolo del loro carattere).

**AI proattive**: tutte le AI fanno cose, lo stile dipende dalla vocazione. Una Sedentaria propone rotte commerciali ma non guerre; una Predona razzia ma non offre alleanze; una Mistica invia dispacci di conversione regolarmente.

### 13.10 Vista Civiltà ⬡ — scoperta progressiva
Le AI appaiono nel dossier **per gradi di intimità** (decisione #52):

| Grado | Trigger | Info visibili |
|---|---|---|
| **Sconosciuta** | Default | Nessuna voce |
| **Avvistata** | Esplori un loro pianeta/sistema | Nome + sigla regione + chip "Avvistata" |
| **Contattata** | Dispaccio diplomatico, scontro, primo evento | + allineamento + sede + relazione |
| **Conosciuta** | ≥3 interazioni significative | + **vocazione** + tratto + dossier completo + intel forza |
| **Familiare** | Alleanza ≥1000 Ι, o federazione | + cronaca specifica della relazione + ultimo scontro + perché disposizione |

Le **4 Costanti** sono visibili in sezione fissa con nome+ruolo sempre noti, dossier per gradi come le altre.

**Identificazione bandiera (sotto "Avvistata"):** pedinare/incrociare una flotta AI fino a riconoscerne l'identità (intel piena) registra un marker `flagSeen` sulla civ — conosci la sua esistenza/identità ma non sai ancora dove vive né nulla del dossier. Non promuove di grado, ma sblocca il **dossier mirato dei Mekhari** (§15.5e) su quella civ. **Eccezione Mekhari:** identificarne una flotta *o* avvistarne un hub li porta direttamente a **Contattata** (il fixer si fa vivo da sé → diplomazia + mercato grigio + intel aperti).

---

## 14. REPUTAZIONE

- Valore globale del giocatore nella galassia, visibile in HUD
- **Sale con:** Alleanze mantenute, sistemi liberati, aiuto a civiltà sotto attacco, commercio onesto
- **Scende con:** Tradimenti, attacchi a civiltà neutrali, saccheggi, ignorare richieste di aiuto
- **Effetti:** Civiltà neutrali si avvicinano o allontanano, prezzi commerciali variano, figure speciali più o meno disponibili, eventi diversi

---

## 15. COMMERCIO

> Questa sezione riflette la **versione leggera** del commercio (decisione #53): baratto come spina dorsale, rotte come flusso passivo per Impulso (no microgestione), valute regionali leggere come integrazione, mercantili a livelli con xp come navi commerciali dedicate. Niente sistemi tipo EVE.

### 15.1 Principi guida
- **Baratto risorsa↔risorsa** resta la spina dorsale degli accordi diplomatici (eredità §13.4).
- **Valute regionali leggere** integrano il baratto dove il baratto è poco adatto (servizi, accessi, beni esclusivi, mercenari).
- **Rotte** = flusso automatico per Impulso (no microgestione). Capacità dimensionata dal Mercato §10. Nessun consumo Energia (le navi mercantili sono già un costo + portano usura + rischiano pirati).
- **Mercantili a livelli** come classe nave dedicata: range e capacità dipendono da livello costruttivo + xp viaggi.
- **Rischi**: pirati §17.5, embargo diplomatico (M11), crisi di produzione locali, guerra nel sistema di transito, sistemi coesi (§13.6).

### 15.2 Mercato interno (rotte colonia↔colonia)
- **Capacità totale**: ogni Mercato §10 contribuisce **N rotte massime** + **throughput/Ι**, sommato sulle colonie del giocatore.
  - Mercato lvl 1: 2 rotte, 8 unità/Ι
  - Mercato lvl 3: 4 rotte, 18 unità/Ι
  - Mercato lvl 5: 7 rotte, 36 unità/Ι
- **Distanza** modulata dal **livello di costruzione del mercantile** (vedi §15.6), non da decadimento del throughput.
- **Risorse trasportabili**: 4 base (met/en/food/water) + risorse avanzate §7.2 (in lotti, con prerequisiti tech).
- **Uso primario early-game**: spostare cibo/acqua dai mondi-giardino ai mondi-fabbrica/lune che ne sono carenti → sblocca la saturazione del cap popolazione (emenda decisione #45/#37 — i grandi mondi raggiungono il cap pieno solo con import).
- **Configurazione rotta**: scegli pianeta sorgente + pianeta destinazione + risorsa + quantità target/Ι. La rotta resta attiva finché non la cancelli o la sorgente esaurisce stock.

### 15.3 Commercio esterno con AI
- **Accordo bilaterale**: proposta diplomatica "risorsa X per risorsa Y in proporzione P:Q, durata D Ι". Gate sulla relazione (vedi tabella sotto).
- **Reputazione modula i prezzi** a **soglie discrete** (no curva continua, leggibile):

| Reputazione del giocatore | Modificatore prezzo |
|---|---|
| ≥ 70 | −15% (sconto buona fama) |
| 50-69 | 0% (mercato standard) |
| 30-49 | +10% (sovrapprezzo diffidenza) |
| < 30 | +25% (paghi caro per la reputazione torbida) |

- **Gate diplomatico**: accordi possibili solo in pace/alleanza. Tregua = no nuovi accordi (vecchi proseguono). Guerra/embargo = sospensione automatica.
- **Allineamento del partner** modula la **disponibilità delle risorse**: una AI Bene non commercia in risorse vietate (reliquie maligne, contrabbando), una AI Male le offre con sovrapprezzo.

### 15.4 Tesoreria & valute regionali
- **Una valuta per regione** (cluster stellare, decisione #9), nome generato dal seed (es. *Stilla di Vega*, *Lama Keth*, *Voto Serenthal*). Tematiche di tono SW-flavor (decisione #34).
- **Tesoreria** (vista dedicata, sezione della Plancia d'Impero sx): portfolio di tutte le valute possedute, tassi di cambio correnti, comando "Cambia X di valuta A in valuta B".
- **Cambio sempre disponibile** (digitale, no banca fisica da raggiungere): cambi quando vuoi dalla Tesoreria → semplifica il flusso, elimina friction inutile.
- **Spread = f(Reputazione + Mekhari)**:
  - Reputazione ≥ 70: spread base ridotto del 30%
  - Reputazione 30-69: spread standard
  - Reputazione < 30: spread base aumentato del 30%
  - **Bonus Mekhari**: nei cluster dove i Mekhari (4 Costanti, §13.7) sono presenti, lo spread è strutturalmente più basso (−30% addizionale) perché loro fanno arbitraggio.
- **Come si ottiene valuta locale**:
  - **Vendendo** risorse in regione (rotte commerciali con AI di quel cluster)
  - **Missioni** per civiltà di quel cluster (M17)
  - **Cambio** dalla Tesoreria con altre valute possedute (sempre disponibile)
- **Come si spende**: per **beni e servizi esclusivi della regione** (motivo unico per averla):
  - Beni rari della cultura locale (tech regionali in M13)
  - Accessi a porti/stazioni AI di quel cluster
  - Ingaggi mercenari, contrabbandieri, figure speciali (M14)
  - Pagamento tributi/dazi su rotte attraverso territorio AI

### 15.5 Sindacato Mekhari come fixer del mercato grigio
Una delle 4 Costanti (§13.7). Funzione **non bancaria** (il cambio è digitale e sempre disponibile), ma **fixer**:
- **(a) Mercato secondario**: gli unici a vendere certe risorse avanzate §7.2 in lotti grossi (cristalli rari, dati antichi, reliquie). Chi non ha un osservatorio fortunato passa da loro.
- **(b) Contrabbando**: aggirano embarghi diplomatici (M11/M17). Se sei in guerra con una civiltà che ti embargo'a, i Mekhari ti rivendono comunque le sue risorse con sovrapprezzo + costo reputazione. Pista Tiranno (#23).
- **(c) Contratti mercenari** (gancio M14): hub naturale per ingaggiare Comandanti freelance, Contrabbandieri, Cacciatori di taglie.
- **(d) Taglie pirata** (gancio M17): mettono taglie sui covi e pagano in valuta locale + reputazione mista.
- **(e) Intel grigia** (M19): vendono informazioni su flotte/colonie altrui — costoso e meno affidabile dello spionaggio vero, ma "passivo". Due linee: **dossier mirato** su una civ di cui hai identificato una flotta (localizzazione delle colonie + profilo grigio sfumato e datato) e **voci di galassia** (spunti generici, economici, a bassa affidabilità). Prerequisito: aver **contattato i Mekhari** (basta incrociarne una flotta o avvistarne un hub — vedi §13.7); il dossier mirato richiede inoltre di aver **identificato** la civ bersaglio (pedinata/incrociata una sua flotta).
- **(f) Spread "convenienza locale"**: effetto sistemico passivo (vedi §15.4) — non un servizio da richiedere.

### 15.6 Mercantili come classe nave dedicata
**Nuova classe nave** in `fleet.js` (§11): **Mercantile**, accanto a caccia/intercettore/corvetta/fregata. Caratteristiche:
- **Cargo come stat propria** (non fp, non corazza): unità trasportate per viaggio
- **Livello tecnico di costruzione 1-3** (Cargo leggero / Cargo pesante / Convoglio iperspaziale), determinato dal livello dell'Hangar di costruzione che lo vara + tech M13 quando arriverà
- **Range = funzione di livello + xp**:
  - Lvl 1: 1 hop
  - Lvl 2: 3 hop
  - Lvl 3: galassia diametrale (richiede iperguida M13)
  - +1 hop bonus a xp veterana, +2 a leggendaria
- **Esperienza individuale (analogia con M07 equipaggi e M09 veteranità navi)**: ogni viaggio completato = +1 xp. Bonus: +10% cargo a esperta, −% rischio pirati con xp.
- **Comandante Logista** (decisione #43, gancio M12): assegnato alla flotta mercantile, dà +X% cargo / +Y% velocità (parametri da tarare, gancio M14).

### 15.7 Eventi perturbativi (§17 gancio)
Le rotte sono soggette a:
- **Razzia pirata** (§17.5): cargo perso, mercantile danneggiato (wear+), xp comunque guadagnata se sopravvive
- **Embargo diplomatico** (M11): la rotta passa per territorio di una civiltà che ha embargo'a → sospesa automaticamente
- **Crisi di produzione locale**: sorgente esaurisce → la rotta si interrompe per N Ι, cronaca segnala
- **Guerra nel sistema di transito**: la rotta si interrompe finché la guerra non finisce o cambi destinazione
- **Sistema coeso ostile** (§13.6): il transito attraverso un sistema coeso non-alleato cala disposizione del consorzio + +5% rischio incidente

### 15.8 Confine M12 vs futuro
- **M12 Fase A** (prima implementazione codice): §15.2 (mercato interno) + accordi base §15.3 + Tesoreria §15.4 + Mercantili classe nave §15.6
- **M12 Fase B**: §15.5 funzioni Mekhari complete (contrabbando, contratti mercenari, intel grigia), eventi perturbativi avanzati §15.7
- **Mercato nero / contrabbando come sistema pieno** → M17 (Eventi e narrazione)
- **Tassi di cambio dinamici come vettore eventi** → M17

### 15.9 Ganci futuri
- **Porto stellare orbitale** (M16, stazioni spaziali): hub portuale di grande stazza, bonus throughput rispetto agli Hangar planetari (decisione #41).
- **Logista Comandante** (M14): cargo flotte mercantili.
- **Rifiuti come commodity** (decisione #48 Fase 2): export rifiuti come asse diplomatico/commerciale con AI.
- **Tech M13** che sbloccano: rotte a lungo raggio, riduzione costo costruzione mercantili, sblocco lvl 3 mercantile.

---

## 16. SPIONAGGIO

- Leggero, non predominante
- Si mandano agenti in sistemi nemici (costo risorse + Impulsi di viaggio)
- **Azioni disponibili:** Raccolta informazioni (flotte, strutture), sabotaggio occasionale (rallenta costruzione), corruzione (indebolisce lealtà popolazione)
- Agenti possono essere scoperti → incidente diplomatico
- Non microgestione — eventi agenzia occasionali, non sistema complesso

---

## 17. EVENTI E NARRAZIONE

### 17.1 Cronaca Galattica
- Pannello "notiziario" aggiornato ogni X Impulsi
- Riporta eventi galattici dal punto di vista esterno
- Esempi: "La flotta del Dominio Keth-Var ha raso al suolo il sistema di Rigel." / "La Confederazione di Aethon propone un trattato di non aggressione alle civiltà della zona nord."
- Dà senso di mondo vivo senza che il giocatore veda tutto direttamente

### 17.2 Memoria Storica
- Log narrativo automatico della propria civiltà
- Riletturable come "storia" della partita
- Aggiornato da eventi significativi: prima colonizzazione, prima battaglia, prima alleanza, perdita di un sistema...

### 17.3 Anomalie Spaziali
- **Buchi neri:** Sistemi adiacenti hanno modificatori di viaggio, navi possono perdersi
- **Nebulose:** Bloccano sensori, rendono sistema difficile da esplorare e combattere
- **Reliquie antiche:** Siti su pianeti/sistemi, esplorabili con navi apposite, sbloccano tech uniche o eventi speciali
- **Campo di detriti:** Rallenta navigazione, possibile recupero risorse

### 17.4 Missioni secondarie
- Appaiono spontaneamente come eventi
- Esempi: richiesta di scorta commerciale, segnale di soccorso in sistema inesplorato, contratto bounty su pirata specifico, richiesta di rifornimento da civiltà alleata sotto assedio
- Accettare/rifiutare ha conseguenze su reputazione e relazioni

### 17.5 Pirati
- Fazione non diplomatica, non giocabile
- Saltuari, non predominanti
- Si annidano in sistemi abbandonati o border zone
- Attaccano rotte commerciali, navi esplorazione isolate
- Non eliminabili definitivamente — si riducono, tornano

### 17.6 Eventi ciclici — NO
(Esclusi per scelta del designer — le stagioni galattiche non fanno parte del design)

### 17.7 Fenomeni di Spazio Profondo (FSP)

> **Distinzione da §17.3.** Le *Anomalie Spaziali* (§17.3, modulo `anomaly.js`)
> vivono **dentro i sistemi** (campi di detriti, nebulose locali, reliquie,
> cinture, gassosi) e si vedono nella vista-sistema. I **Fenomeni di Spazio
> Profondo (FSP)** sono una categoria **separata**: vivono **sulla mappa
> galattica, nello spazio interstellare**, anche **fuori dalle rotte** tra i
> sistemi (negli interstizi tra cluster, ai bordi, nel vuoto). Modulo dedicato:
> `js/phenomena.js`. Non modificano `anomaly.js`, ma ne riusano i pattern
> collaudati (siteKey / ensure / tick / eventi Cronaca / gating su scoperta).

#### 17.7.1 Intento di design

Gli FSP introducono **varietà emergente** sulla mappa: posti casuali da
**scoprire / sfruttare / evitare**, il cui significato il giocatore impara
**giocando**, non leggendolo. Principio guida (allineato a §20 "l'opacità è by
design"): il giocatore conosce **sempre come interagire** (i verbi), **mai
l'effetto preciso** finché non si impegna.

**Non sono game-winner.** Sono **moltiplicatori potenziali e contingenti**:
- Il valore **dipende dalla direzione strategica** del giocatore (ricerca /
  economia / militare / espansione): lo stesso FSP vale *molto* per una
  vocazione e *poco* per un'altra ("da poco a molto").
- Sono **game-changer possibili, mai garantiti**: cap sulle magnitudini,
  rendimenti decrescenti, nessun singolo FSP che chiude la partita.
- **Recovery-friendly (#22):** ogni malus/hazard ha una via d'uscita; non
  interagire è sempre una scelta valida; i nodi posseduti sono **contendibili**
  dall'AI (questo è il limite anti-game-winner).

#### 17.7.2 Grammatica di scoperta (4 livelli)

| Livello | Come ci arrivi | Cosa sai |
|---|---|---|
| **Eco** | non rilevato | nulla (al più un `?` se un sistema vicino esplorato lo sfiora coi sensori) |
| **Contatto** | flotta/sonda nel raggio sensori, o osservatorio | *"Segnale anomalo"*: c'è e **dove**, non **cosa** |
| **Classificato** | **scansione a distanza** (economica, basso rischio) | la **classe** + descrittore ambiguo (*"firma dormiente"*, *"eco antica"*, *"lettura instabile"*) + **il menu dei verbi** |
| **Rivelato** | ci entri / lo sfrutti / lo attivi (impegno) | l'effetto si risolve → Cronaca + nudge tutorial |

**Verbi disponibili** (noti anche da bendato):
- **Rileva/Scansiona** — da *Contatto* a *Classificato*.
- **Investiga (entra)** — l'impegno che rivela l'effetto; alcuni FSP richiedono
  nave/modulo apposito (sonda, nave scientifica, scorta).
- **Sfrutta / Controlla** — vedi §17.7.4.
- **Evita/Marca** — lo bolli *zona interdetta*; rotte e AI lo aggirano.

#### 17.7.3 Catalogo — 5 classi leggibili (glifo riconoscibile)

I **tenori** indicano la tendenza, **non** l'effetto (volutamente non blindato).

1. **Gravitazionali** (glifo: vortice/lente) — *Pozzo di marea* (hazard, viaggi
   deformati/dispersione, o scorciatoia temeraria) · *Lente gravitazionale*
   (misto, osservatorio = sensori/ricerca, o trappola) · *Varco* (raro,
   scorciatoia potenziale tra due punti lontani, instabile — §17.7.5).
2. **Reliquie / Artificiali** (glifo: sigillo) — *Relitto/Cimitero di navi*
   (boon+rischio: recupero, ma sorvegliato o esca pirata) · *Megastruttura
   dormiente / Faro spento* (misto, raro, gancio Faro di Orion) · *Avamposto
   degli Anziani del Vuoto* (raro/unico, §17.7.5; tech unica o figura §18).
3. **Emissione / Stellari** (glifo: pulsazione) — *Pulsar / Faro naturale*
   (boon: beacon nav, dirada nebbia, ma radiazioni equipaggio) · *Tempesta di
   plasma / nube di radiazioni* (hazard; **hazard-in-movimento rinviato a fase
   futura** — in v1 statico).
4. **Biologiche / Esotiche** (glifo: spirale organica) — *Sciame nello spazio*
   (misto: biorisorsa o ostile se provocato) · *Marea di spore dormienti*
   (hazard: se disturbata si diffonde, alza pericolo locale o alimenta ICG).
5. **Temporali / Anomalie del Vuoto** (glifo: frattura) — *Eco temporale /
   Distorsione* (wildcard imprevedibile; *stranezza fisica* §6.1 a scala
   galattica; rara, effetto da tabella ampia).

#### 17.7.4 Due modi di trarne valore

- **Controllo persistente** — *rivendichi* l'FSP (avamposto/presidio sopra):
  effetto **passivo continuo**, un nodo che possiedi. **Contendibile** da
  Vehryn/pirati/AI (insidia o sottrazione). È il vincolo anti-game-winner.
- **Uso una tantum** — *attivi/investighi*: bonus **o** malus immediato, una
  scommessa. Si **consuma**.
- **Campo di prossimità (perenne)** — anche senza interagirci, ogni FSP
  proietta un **debole campo ambientale** sul **sistema d'aggancio e su quelli
  entro 1 hop**. Una flotta che vi **transita** ne risente in **continuo**:
  effetti **leggeri, cappati e opachi** (il giocatore li *sente*, non li legge
  a numeri) che variano per **classe** (es. gravitazionali = viaggi più lenti,
  scafi sollecitati e **maggior rischio di incidente** lungo la rotta; faro =
  rotta più spedita; struttura dormiente = acque calme/meno usura). Rende la
  presenza dei corpi speciali **strategica e perenne** — una *zona da evitare*
  (o da cercare) per le rotte — senza affossare chi nasce adiacente. Vale anche
  per le flottiglie ambientali AI (canale di viaggio). Recovery-friendly (#22):
  sempre lieve, e marcare/aggirare la zona è una scelta valida.

#### 17.7.5 Variabilità (due assi)

**A) Tra partite — "Profilo fenomenologico" della galassia** (dal seed): ogni
galassia tira un carattere (es. *Ricca di reliquie / povera di pericoli*,
*Travagliata: molti vortici gravitazionali*, *Silente: pochi FSP ma estremi*).
Manopole: moltiplicatore di densità per classe + ricchezza globale + tenore
(boon↔hazard). Tenore di default **bilanciato**.

**B) Dentro la stessa galassia** — distribuzioni mescolate:
- **Correlate ai cluster/tier**: reliquie/artificiali → *Orlo/Spazio
  Sconosciuto*; gravitazionali → *Nucleo*; biologiche → gruppi nebulosi.
- **Nei vuoti** (off-lane): alcune appaiono negli **interstizi tra cluster**,
  dove non c'è né sistema né rotta.
- **Riding sul pericolo §5.3**: frequenza/intensità crescono con la distanza
  da casa (riuso `s.danger`).
- **Jitter**: conteggio per-classe con tasso dal seed + roll d'intensità per
  istanza → due FSP "stessa classe" risultano diversi.
- **Unici con nome**: 0–2 megastrutture/entità event-tier per galassia,
  parzialmente garantite parzialmente seed-gated (varchi e unici **inclusi in
  v1**).

#### 17.7.6 Agganci all'esistente

- **Vehryn** (§13.7) seguono le anomalie nuove → corsa alle reliquie/FSP
  artificiali, ci piantano avamposti. **Pirati** annidati presso certi relitti.
  **Mekhari** vendono coordinate di FSP non scoperti.
- **ICG**: classi hazard ignorate possono spingerlo su.
- **Determinismo (#5)**: piazzamento/classe/intensità da `seed:phenom:<id>`.

#### 17.7.7 Note tecniche (estensione, non duplicazione)

Modulo nuovo `js/phenomena.js`; rendering `_drawPhenomena` sulla galaxy-map con
coordinate normalizzate `[0,1]³` (off-lane); gating su nebbia di guerra;
persistenza **additiva** nel save (migrazione lazy, niente bump distruttivo dove
possibile); eventi Cronaca con `kind` dedicati (KIND_LABELS + DEFAULT_AUTOPAUSE);
lezioni tutorial ai punti di scoperta. **Fuori v1:** hazard-in-movimento.

---

## 18. ARCHETIPI RAZZE/FIGURE

Sei archetipi mischiati in tutte le civiltà (inclusa la propria come figure speciali/comandanti):

| Archetipo | Caratteristiche | Ruolo preferito |
|-----------|----------------|-----------------|
| **Umani** | Versatili, nessun bonus/malus specifico | Qualsiasi |
| **Kelhari** | Umanoidi felini, agilissimi, istinto predatorio. Leali ma orgogliosi | Comandante caccia/corvette, piloti elite |
| **Vorn** | Massicce creature rocciose, lente ma resistentissime | Ingegnere di Flotta, costruttori |
| **Syndari** | Capacità percettive ampliate, quasi telepatiche. Rari | Stratega, Consigliere Scientifico |
| **Mekhari** | Parzialmente cibernetici, nessuna lealtà naturale. Si "acquistano" | Spie, Comandanti freddi |
| **Anziani del Vuoto** | Rarissimi, antichi, origine sconosciuta. Appaiono come eventi speciali | Qualsiasi — cambiano la partita, attraggono attenzione |

---

## 19. CONDIZIONI DI VITTORIA E SCONFITTA

### Vittoria
**Nessuna condizione rigida unica** — sandbox con obiettivi opzionali:
- Dominanza galattica (controllo X% sistemi)
- Superiorità tecnologica (raggiungere tech di livello massimo)
- Egemonia economica (controllo rotte commerciali principali)
- Alleanza suprema (formare coalizione di civiltà buone che domina la galassia)

### Sconfitta
- ICG raggiunge 100 → collasso galattico progressivo, eventi sempre più devastanti, difficile sopravvivere
- Pianeta base distrutto senza alternativa → fine partita
- Civiltà ridotta a 0 sistemi → fine partita

### Obiettivo continuo
**Mantenere ICG basso** è lo scopo principale — dà direzione senza imporre un finale rigido.

---

## 20. ORDINE DI SVILUPPO CONSIGLIATO

Sviluppare rigorosamente in questo ordine, confermando ogni modulo prima del successivo:

1. **[M01] Struttura base** — HTML shell, CSS tema, layout pannelli, font
2. **[M02] Galassia** — Generazione procedurale, Canvas 2D mappa, nebbia di guerra, nomi
3. **[M03] Sistema stellare** — Vista sistema, pianeti/lune, selezione colonizzazione
4. **[M04] Pianeta base** — Risorse, strutture, popolazione, tempo, costruzione
5. **[M05] Tempo e avanzamento** — Game loop, avanzamento in Impulsi (TSG), timer costruzioni
6. **[M06] Salvataggio** — localStorage (slot multipli) + Export/Import `.json` (schemaVersion, validazione); galassia salvata come **seed + delta** (struttura rigenerata, salvato solo lo stato mutevole); cronaca con **log limitato** (ultimi N eventi)
7. **[M07] Esplorazione** — Navicelle esplorazione, viaggio, scoperta sistemi
8. **[M08] Flotta base** — Caccia/corvette, costruzione, movimento
9. **[M09] Combattimento** — Risoluzione battaglia, report, veteranità
10. **[M10] Civiltà AI** — Generazione, comportamenti base, espansione
11. **[M11] Diplomazia** — Stati relazioni, transizioni, effetti
12. **[M12] Commercio** — Rotte, mercato interno, eventi perturbativi
13. **[M13] Tecnologia** — Albero parziale, ricerca distribuita, unlock
14. **[M14] Figure speciali** — Emergenza dal basso, promozione, assegnazione
15. **[M15] Grandi navi** — Fregate, Dreadnought, Nave Ammiraglia
16. **[M16] Stazioni spaziali** — Costruzione, difesa, funzioni
17. **[M17] Eventi e narrazione** — Cronaca, memoria, anomalie, missioni
18. **[M18] Reputazione e ICG** — Sistema reputazione, indice corruzione
19. **[M19] Spionaggio** — Agenti, azioni, conseguenze
20. **[M20] Polish e bilanciamento** — Tuning valori, UX, tutorial minimo

---

## 21. NOTE FINALI PER CLAUDE CODE

- **Non spiegare al giocatore tutti i meccanismi** — l'opacità è by design. Tutorial minimo, scoperta organica.
- **Gli eventi devono essere interconnessi** — un evento influenza il successivo, tutto fluisce.
- **Niente è isolato** — guerra cambia commercio, commercio cambia diplomazia, tecnologia cambia tutto.
- **Il giocatore controlla il ritmo** — mai forzare attese, mai bloccare su un singolo evento.
- **Salvare sempre prima di ogni azione irreversibile** — prompt discreto, non invasivo.
- **La galassia vive** — le AI agiscono anche quando il giocatore non avanza i Impulsi (al prossimo avanzamento vengono processati i Impulsi AI).
- Aggiornare `CLAUDE.md` a ogni sessione con: moduli completati, moduli in corso, decisioni prese, problemi aperti.
