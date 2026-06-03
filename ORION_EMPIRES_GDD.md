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
**Salvataggio:** localStorage, slot multipli  

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
- localStorage per salvataggi
- Nessuna chiamata a server esterni
- Mobile-friendly ma ottimizzato desktop

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

---

## 6. I SISTEMI STELLARI

### 6.1 Struttura di un sistema
Ogni sistema contiene:
- 1 stella (tipo: nana gialla, gigante rossa, nana bianca, binaria...)
- 4-7 corpi celesti: pianeti rocciosi, giganti gassosi, lune, cinture asteroidali
- Anomalie opzionali: campo di detriti, nebulosa locale, reliquie antiche

### 6.2 Colonizzazione
- **Tutti i corpi celesti sono colonizzabili** ma con caratteristiche molto diverse
- Il giocatore sceglie quale colonizzare per primo — scelta che condiziona tutto
- Gli altri rimangono disponibili ma a costo elevato finché il primo è produttivo
- **Eccezione:** Se il primo pianeta è esaurito o gravemente impoverito, colonizzare un secondo diventa più accessibile (migrazione naturale forzata)
- Colonizzare un secondo corpo richiede: tecnologia specifica + infrastruttura consolidata sul primo + risorse significative + tempo (90-150 Impulsi)

### 6.3 Tipi di corpo celeste e caratteristiche
| Tipo | Vantaggi | Svantaggi |
|------|----------|-----------|
| Pianeta terrestre | Agricoltura, popolazione alta | Risorse minerali medie |
| Pianeta desertico | Minerali abbondanti, rarità | Cibo scarso, caldo estremo |
| Pianeta oceanico | Acqua abbondante, biochimica | Costruzioni costose |
| Pianeta ghiacciato | Risorse criogeniche, rarità | Energia costosa, lento |
| Pianeta vulcanico | Energia geotermica, metalli pesanti | Instabile, pericoloso |
| Pianeta forestale | Biomassa, farmaceutici | Minerali scarsi |
| Gigante gassoso | Elio-3, gas rari | Non abitabile, solo estrazione orbitale |
| Luna | Varia, compatta | Gravità bassa, capacità ridotta |
| Cintura asteroidale | Minerali puri, metalli rari | Solo estrazione, non abitabile |

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
- Costruibili in qualsiasi sistema esplorato
- Funzioni: avamposto militare, deposito risorse, punto riparazione, hub commerciale
- Difendibili, attaccabili, conquistabili
- Richiedono rifornimento periodico dal pianeta più vicino

---

## 13. CIVILTÀ AI

### 13.1 Numero e caratteristiche
4-5 civiltà AI per partita, ognuna con:
- **Personalità marcata** ma con elemento di imprevedibilità
- **Allineamento:** Bene / Male / Neutrale-Opportunista
- **Caratteristica identificabile** al primo contatto

### 13.2 Archetipi civiltà (esempi — generare proceduralmente con variazioni)

**Civiltà "Bene":**
- *Confederazione di Aethon* — Diplomatici, commercio attivo, difensivi ma tenaci se attaccati. Cercano alleanze, aiutano civiltà sotto pressione.
- *Ordine di Serenthal* — Tecnologicamente avanzati, isolazionisti ma non ostili. Condividono tech in cambio di pace duratura.

**Civiltà "Male":**
- *Dominio Keth-Var* — Espansionisti aggressivi, saccheggio sistemi conquistati, tradiscono alleanze quando conviene. Aumentano ICG rapidamente.
- *Sindacato Mekhari* — Ricatti, spionaggio, controllo rotte commerciali. Non sempre in guerra aperta ma sempre pericolosi.

**Civiltà Neutrale-Opportunista:**
- *Lega di Vorthan* — Seguono chi vince. Commercianti prima di tutto, cambiano alleanze in base ai vantaggi. Imprevedibili.

### 13.3 Comportamenti AI
- Le AI si fanno guerra **tra loro** indipendentemente dal giocatore
- Espandono, colonizzano, costruiscono flotte in background
- Reagiscono alla reputazione del giocatore
- Le civiltà maligne aumentano ICG attivamente
- Le civiltà buone possono chiedere aiuto al giocatore tramite eventi

### 13.4 Diplomazia
**Stati base:**
- Guerra / Tregua / Pace / Alleanza

**Transizioni:** Avvengono tramite eventi, azioni del giocatore, cambiamenti di reputazione  
**Tradimenti:** Le civiltà maligne possono tradire alleanze — preavviso indiretto tramite segnali (cronaca galattica, spionaggio)

---

## 14. REPUTAZIONE

- Valore globale del giocatore nella galassia, visibile in HUD
- **Sale con:** Alleanze mantenute, sistemi liberati, aiuto a civiltà sotto attacco, commercio onesto
- **Scende con:** Tradimenti, attacchi a civiltà neutrali, saccheggi, ignorare richieste di aiuto
- **Effetti:** Civiltà neutrali si avvicinano o allontanano, prezzi commerciali variano, figure speciali più o meno disponibili, eventi diversi

---

## 15. COMMERCIO

- Rotte commerciali per singola risorsa, frutto di accordi diplomatici
- Gestione non dettagliata: si attivano, generano flusso automatico ogni Impulso
- **Eventi perturbativi:** Pirati, embargo, crisi di produzione, guerra nel sistema di transito
- Mercato interno tra propri pianeti: automatico, influenzato da distanza
- Commercio esterno con AI: proposta semplice (risorsa X per risorsa Y, durata accordo)

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
6. **[M06] Salvataggio** — localStorage, slot multipli, caricamento
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
