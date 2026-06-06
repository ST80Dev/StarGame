/* =====================================================================
   ORION EMPIRES — tutorial.js
   Modulo M06.6: tutorial contestuale a schede (decisione #28).
   (Sviluppato in parallelo a M06.5; rinumerato dopo merge con main.)

   Filosofia (richiesta utente):
     - opt-in dal main menu "Nuova partita" (checkbox)
     - schede brevi e contestuali, NIENTE walkthrough ("clicca qui poi qui")
       → spiegano concetti e cosa conta, lasciano al giocatore le scelte
     - ogni lezione fa fuoco UNA VOLTA per partita (stato persistito nel save)
     - cresce coi moduli: ogni futuro modulo (M07/M08/M11/M12/M17/M19/M13)
       aggiunge le proprie lezioni a LESSONS senza toccare i trigger
     - sempre riapribile dal pulsante "?" in HUD (indice di lezioni viste +
       non viste, riapertura su demand → manuale leggero)

   Persistenza: `game.tutorial = { enabled: bool, seenLessons: [id…] }`.
   Lo schema save è 4 (sub-migrazione v3→v4 in save.js, fusa con M06.5).

   Architettura: namespace globale ORION, niente bundler, niente dipendenze.
   ===================================================================== */
'use strict';

(function (root) {
  const ORION = root.ORION = root.ORION || {};

  /* ------------------------------------------------------------------
     REGISTRO DELLE LEZIONI
     Ogni lezione ha:
       id     — identificatore stabile (anche event id del trigger)
       title  — titolo (1 riga)
       body   — HTML breve, max ~4-6 righe (no walkthrough)
       tag    — modulo o area di riferimento (M01/M02/.../M06)
     Le lezioni si attivano via ORION.tutorial.fire(id, ctx).
     Per aggiungere lezioni future, aggiungi voci qui e chiama fire(id)
     nel punto di codice rilevante — nessun'altra modifica al modulo.
     ------------------------------------------------------------------ */
  const LESSONS = [
    {
      id: 'welcome',
      tag: 'Inizio',
      title: 'Benvenuto in Orion Empires',
      body:
        '<p>4X strategico spaziale a pannelli. Non ci sono turni: il tempo scorre in <strong>Impulsi (<span class="ds-unit">Ι</span>)</strong> ' +
        'del Tempo Standard Galattico — sei tu a decidere quando avanzare coi bottoni in alto a destra.</p>' +
        '<p>Esistono <strong>7 piste di vittoria in parallelo</strong> (esplorazione, colonizzazione, dominio economico, ' +
        'ascensione tech, pace, oppressione, sopravvivenza alla crisi). Vince chi chiude per primo una qualsiasi pista. ' +
        'La modalità scelta dà solo enfasi narrativa: nessuna pista è lockata.</p>' +
        '<p class="tut-hint">Riapri questo tutorial dal pulsante <kbd>?</kbd> in alto, quando vuoi.</p>'
    },
    {
      id: 'galaxy',
      tag: 'Galassia',
      title: 'Mappa galattica',
      body:
        '<p>La galassia è gerarchica: <strong>Regione → Sistema → Pianeta</strong>. Al massimo zoom vedi le regioni ' +
        '(ammassi stellari con nome proprio); avvicinandoti compaiono le stelle. Doppio click su un sistema per entrarci.</p>' +
        '<p><kbd>Shift</kbd>+trascina ruota la galassia in 3D libero su tre assi (pinch a 2 dita su touch).</p>' +
        '<p>La <strong>nebbia di guerra</strong> nasconde i sistemi non rilevati: solo i corpi del sistema d\'origine ' +
        'e degli adiacenti sono visibili da subito. L\'esplorazione vera arriverà con le flotte.</p>'
    },
    {
      id: 'system',
      tag: 'Sistema',
      title: 'Sistema stellare',
      body:
        '<p>Ogni sistema ha 4-7 corpi celesti — talvolta con lune o <strong>anomalie</strong> (campi di detriti, ' +
        'nebulose locali, reliquie antiche). I tipi caldi stanno vicino alla stella, le fasce abitabili al centro, ' +
        'i ghiacciati e i gassosi all\'esterno.</p>' +
        '<p>I sistemi <strong>esplorati</strong> mostrano tutti i dettagli; i <strong>rilevati</strong> mostrano solo ' +
        'sagome da scansionare; gli <strong>ignoti</strong> non si aprono.</p>' +
        '<p class="tut-hint">Doppio click nel vuoto per tornare alla galassia.</p>'
    },
    {
      id: 'planet',
      tag: 'Pianeta',
      title: 'Vista pianeta',
      body:
        '<p>Ogni corpo ha <strong>potenziali risorse</strong> (metalli, energia, cibo, acqua) e un numero di ' +
        '<strong>slot di costruzione</strong>. La scheda a destra ha 4 tab: <em>Colonia · Risorse · Strutture · Popolazione</em>.</p>' +
        '<p>Il <strong>pianeta base</strong> ha +20% di produzione. Colonizzare un secondo corpo costa ×5 finché il base è ancora produttivo, ' +
        'ma se va in crisi (carenza critica di cibo o acqua) il costo torna basso — è la <em>migrazione naturale forzata</em>.</p>'
    },
    {
      id: 'build',
      tag: 'Strutture',
      title: 'Strutture, slot ed espansione',
      body:
        '<p>Ogni struttura occupa <strong>slot</strong> e si costruisce in <strong>Impulsi</strong> (non è istantanea: ' +
        'avanza il tempo per veder maturare la coda). Gli slot di un pianeta sono <strong>limitati</strong>: sono la tua ' +
        'risorsa strategica più scarsa.</p>' +
        '<p>Una struttura si <strong>espande</strong> (bottone "+ Espandi"): ogni livello aggiunge un <strong>modulo</strong> ' +
        '→ occupa <strong>1 slot in più</strong> e produce di più (i moduli successivi rendono un po\' più dei primi). Ma il ' +
        '<strong>costo cresce</strong> a ogni livello: espandere all\'infinito non conviene.</p>' +
        '<p>Le <strong>estrattive</strong> coprono il fabbisogno; le <strong>produttive</strong> (fonderia, raffineria) ' +
        '<strong>moltiplicano</strong> la resa delle estrattive. Con slot limitati devi <strong>scegliere la vocazione</strong> ' +
        'del pianeta: non puoi avere tutto al massimo. L\'<strong>osservatorio</strong> rivela le risorse avanzate dopo ~10 <span class="ds-unit">Ι</span>.</p>' +
        '<p><strong>Laboratorio</strong> e <strong>Osservatorio</strong> sono ganci per la tecnologia: accumulano contatori ' +
        'che si sbloccheranno con l\'albero tech. Puoi <strong>rinviarli senza penalità</strong>, oggi non danno benefici immediati.</p>' +
        '<p>Servono più slot? Più avanti sblocchi <strong>Centro di ingegneria planetaria</strong> (bonifica territoriale) e ' +
        '<strong>Terraformatori</strong>: strutture tech-gated che <strong>espandono lo spazio costruibile</strong> ' +
        'del pianeta. Inoltre la <strong>capitale di gruppo</strong> riceve +10 slot di riserva.</p>'
    },
    {
      id: 'advance',
      tag: 'Tempo',
      title: 'Calendario del Faro · scorrere del tempo',
      body:
        '<p>Il tempo è ancorato a una pulsar (il <em>Faro di Orion</em>) e si misura su 4 unità:</p>' +
        '<ul>' +
          '<li><strong>Ι</strong> (iota) — Impulso, il battito atomico</li>' +
          '<li><strong>Κ</strong> (kappa) — Ciclo, 50 Ι</li>' +
          '<li><strong>Φ</strong> (phi) — Fase, 20 Κ = 1000 Ι</li>' +
          '<li><strong>Ω</strong> (omega) — Eone, 100 Φ = 100 000 Ι</li>' +
        '</ul>' +
        '<p>La Data Stellare in alto è in formato compatto <code>Ω·Φ·Κ·Ι</code> (es. <code>1·87·6·47</code>). ' +
        'Le durate omettono gli zeri di testa (es. una colonizzazione di 120 Ι = <code>2Κ·20Ι</code>).</p>' +
        '<p>Il tempo scorre <strong>automaticamente</strong> con <strong>▶</strong> nella barra in alto. ' +
        'Cambia velocità con <kbd>+</kbd>/<kbd>−</kbd> (7 livelli, default 1× = 30s reali per Ι), ' +
        'pausa con <kbd>Spazio</kbd>, singolo Ι con <kbd>→</kbd>, salta al prossimo evento con <kbd>E</kbd>. ' +
        'Su ogni evento notevole il tempo <strong>si auto-pausa</strong>: puoi disattivare la pausa per categoria nel popup.</p>' +
        '<p>Il sistema è <strong>recovery-friendly</strong>: nessuna scelta del momento è perennemente punitiva.</p>'
    },
    {
      id: 'scarcity',
      tag: 'Tempo',
      title: 'Carenza risorse',
      body:
        '<p>Con stock ≤ 20 e netto negativo la colonia entra in <strong>allerta</strong> (−10% produzione globale); ' +
        'a zero diventa <strong>critica</strong> (−30%). Bastano <strong>3 Impulsi</strong> di netto ≥ 0 per uscirne.</p>' +
        '<p>Nessuna carenza è un fail-state: la popolazione cala solo dopo 30 Impulsi consecutivi di fame o sete, ' +
        'e poi di 1 unità ogni 30 <span class="ds-unit">Ι</span>. Hai sempre il tempo di riassestare la coda, costruire ciò che manca, o spostarti.</p>'
    },
    {
      id: 'specialization',
      tag: 'Strutture',
      title: 'Specializzazione planetaria',
      body:
        '<p>Un pianeta ha pochi <strong>slot</strong> (5-9 a seconda del tipo): non puoi metterci tutto. ' +
        'L\'idea del 4X è <strong>specializzare</strong> ogni colonia su una vocazione.</p>' +
        '<p>Ogni colonia ha la <strong>propria contabilità</strong> di risorse: costruisce e si mantiene con ciò che ' +
        'produce in loco. L\'HUD in alto mostra il <strong>totale dell\'impero</strong> come quadro d\'insieme, ma per ' +
        'spostare risorse tra colonie (es. portare cibo a un mondo molto popoloso) serviranno le ' +
        '<strong>rotte commerciali</strong> (in arrivo).</p>' +
        '<p><strong>Esempi di vocazione:</strong></p>' +
        '<ul>' +
          '<li><strong>Pianeta natale</strong> (terrestre, 8 slot) → polivalente: 4 estrattive base + abitativo + ospedale + ricerca.</li>' +
          '<li><strong>Mineraria</strong> (vulcanico/cintura) → 3-4 miniere + 1 fonderia (+40%/lvl) + 1 centrale. Pompa metalli.</li>' +
          '<li><strong>Agricola</strong> (forestale/oceanico) → 3-4 fattorie + 2 impianti idrici + abitativo. Pompa cibo e acqua.</li>' +
          '<li><strong>Militare</strong> (terrestre) → hangar + accademia + 4 estrattive base. Costruirà flotte (in arrivo).</li>' +
        '</ul>' +
        '<p>Le strutture <strong>moltiplicative</strong> (fonderia, raffineria) hanno senso solo se hai 2-3 strutture base della stessa categoria — su un pianeta polivalente con 1 sola miniera, la fonderia spreca slot.</p>'
    },
    {
      id: 'population',
      tag: 'Popolazione',
      title: 'Popolazione e capacità di carico',
      body:
        '<p>La popolazione è in <strong>unità</strong> (mostrate come abitanti reali) e cresce <strong>lentamente, di lungo ' +
        'periodo</strong>: ogni livello in più costa progressivamente più tempo.</p>' +
        '<p>Ogni unità di popolazione <strong>consuma davvero</strong> cibo e acqua dallo stock locale. Se la produzione locale ' +
        'non basta, lo stock scende → la colonia entra in <strong>allerta</strong> (≤20, malus −10%) o <strong>critico</strong> ' +
        '(=0, malus −30%). Bastano 3 Impulsi di netto positivo per uscirne.</p>' +
        '<p><strong>Buffer di tolleranza:</strong> la popolazione cala solo dopo <strong>30 Impulsi consecutivi</strong> di fame ' +
        'o sete, e poi di 1 unità ogni 30 <span class="ds-unit">Ι</span> — hai sempre il tempo di reagire prima di perdere persone.</p>' +
        '<p>La crescita si ferma in <strong>plateau</strong> quando produzione = consumo. Guarda la scheda Popolazione per ' +
        'capire <strong>cosa manca</strong>: più fattorie/impianti idrici, o (futuro) rifornimenti via rotte commerciali.</p>'
    },
    {
      id: 'waste',
      tag: 'Pianeta',
      title: 'Rifiuti e gestione',
      body:
        '<p>Popolazione e industria producono <strong>rifiuti</strong> in continuazione. Non sono una crisi: sono una ' +
        '<strong>leva</strong>. Si accumulano in un contenimento di colonia; la <strong>saturazione</strong> (accumulo / capacità) ' +
        'è ciò che conta.</p>' +
        '<p>Oltre il <strong>70%</strong> di saturazione la produzione inizia a <strong>deperire</strong> in modo progressivo ' +
        '(fino a −25% in overflow). Non è mai un fail-state (recovery-friendly): basta agire.</p>' +
        '<p>La leva principale è l\'<strong>Impianto di riciclo</strong>: tratta i rifiuti, ne <strong>recupera energia</strong> ' +
        'e <strong>alza la capacità</strong> di contenimento. Pochi moduli invertono la rotta.</p>' +
        '<p><strong>In arrivo:</strong> esportare i rifiuti alle civiltà AI (commercio) e dedicare i mondi ostili a ' +
        '<em>colonie riciclanti</em>, trasformando una zavorra in infrastruttura d\'impero.</p>'
    },
    {
      id: 'advanced',
      tag: 'Pianeta',
      title: 'Risorse avanzate',
      body:
        '<p>Oltre alle 4 risorse base, ogni corpo può ospitare 0-3 <strong>risorse avanzate</strong> ' +
        '(cristalli, esotici, biomassa, gas nobili, dati, reliquie). Il numero è visibile da subito, ma le identità ' +
        'restano <strong>mascherate</strong>.</p>' +
        '<p>Per rivelarle serve un <strong>osservatorio</strong>: dopo la costruzione parte una scansione di ~10 Impulsi, ' +
        'al termine sai esattamente cosa è disponibile. Tipi specifici di corpo favoriscono certe famiglie ' +
        '(es. vulcanico → esotici/cristalli, gassoso → gas nobili, forestale → biomassa/dati).</p>'
    },
    {
      id: 'save',
      tag: 'Salvataggi',
      title: 'Salvataggi e trasferimento',
      body:
        '<p>L\'<strong>autosave</strong> rotante si aggiorna dopo ogni azione importante (avanzamento, costruzione, ' +
        'colonizzazione). 5 <strong>slot manuali</strong> per i checkpoint volontari.</p>' +
        '<p><strong>Esporta .json</strong> per trasferire la partita tra dispositivi (PC ↔ tablet): il file è ' +
        'autosufficiente, la galassia si rigenera dal seed. <strong>Importa .json</strong> sostituisce la partita corrente.</p>' +
        '<p>In modalità <strong>Ironman</strong> (preset Incubo) gli slot manuali sono nascosti: solo autosave + export/import, ' +
        'niente save-scumming.</p>'
    },
    {
      id: 'civilizations',
      tag: 'Galassia · Civiltà',
      title: 'Le civiltà della galassia',
      body:
        '<p>La galassia <strong>preesiste</strong>: 4-5 civiltà AI vivono già, ognuna con un <strong>allineamento</strong> ' +
        '(Bene / Male / Neutrale-opportunista) e una <strong>caratteristica riconoscibile</strong>. Gli imperi consolidati ' +
        'stanno verso il <strong>Nucleo</strong>, gli arrampicatori verso la <strong>Frontiera</strong> e l\'<strong>Orlo</strong>.</p>' +
        '<p>Agiscono in <strong>background</strong>: espandono, si fanno guerra <em>tra loro</em>, possono cadere (ridotte a zero ' +
        'sistemi) o vederne nascere di nuove. Tu ne percepisci gli effetti dalla <strong>Cronaca</strong> (voci da regioni lontane) ' +
        'e dai confini colorati che compaiono sulla mappa <strong>man mano che esplori</strong>.</p>' +
        '<p>L\'<strong>ICG</strong> (Indice Corruzione Galattica, in HUD) sale quando le civiltà maligne si espandono, scende quando ' +
        'le buone stabilizzano. La loro <strong>disposizione</strong> verso di te si forma già ora; la diplomazia vera (trattati, ' +
        'alleanze) arriva più avanti.</p>'
    },
    {
      id: 'pirates',
      tag: 'Galassia · Pirati',
      title: 'Predoni e covi pirata',
      body:
        '<p>I <strong>covi pirata</strong> si annidano nei sistemi pericolosi dell\'Orlo. Quelli che hai <strong>rilevato</strong> ' +
        'compaiono sulla mappa con un teschio ☠ e nella lista <em>Minacce pirata</em> della vista Civiltà.</p>' +
        '<p>Sono <strong>bersagli raidabili</strong>: manda una <strong>flotta armata</strong> sul loro sistema — lo scontro si risolve ' +
        'da solo. Sgominare un covo frutta una <strong>taglia</strong> in risorse e <strong>riduce le razzie</strong> della zona.</p>' +
        '<p>Attenzione al rovescio: i predoni possono <strong>colpire le tue flotte esposte</strong> (in orbita lontano dalle colonie). ' +
        'Tieni le flotte vicino a casa o pronte a combattere. Taglie formali, covi-boss e contratti arriveranno con gli <strong>Eventi</strong> (M17).</p>'
    },
    {
      id: 'combat',
      tag: 'Guerra · Combattimento',
      title: 'Combattimento',
      body:
        '<p>Le navi hanno <strong>potenza di fuoco</strong> e <strong>corazza</strong>; ogni round entrambi i lati infliggono la ' +
        'loro fp aggregata. Più fp logori il nemico più in fretta, più corazza reggi di più. Conta anche la <strong>fortuna</strong> ' +
        '(piccola varianza) — il più forte di solito vince, ma gli upset esistono.</p>' +
        '<p><strong>Veteranità (§12.3):</strong> le navi che <strong>sopravvivono</strong> salgono di grado ' +
        '(Verde→Veterana→Elite→Leggendaria, +5% fuoco/grado). Tienile vive: una flotta esperta vale doppio. Le Leggendarie ' +
        'prendono un <strong>nome proprio</strong>.</p>' +
        '<p><strong>Formazione:</strong> imposta la soglia di ritirata — <em>Aggressiva</em> (combatti fino alla fine), ' +
        '<em>Bilanciata</em> (ritirata al 30%), <em>Difensiva</em> (al 50%). Gli scontri nello spazio si risolvono in un Impulso.</p>'
    },
    {
      id: 'siege',
      tag: 'Guerra · Assedi',
      title: 'Assedi alle colonie',
      body:
        '<p>Quando una forza ostile punta una tua colonia ricevi un <strong>preavviso</strong> (incursione in arrivo, con ETA): ' +
        'preparati. L\'<strong>assedio</strong> dura più Impulsi — un round di scambio ogni ~5 <span class="ds-unit">Ι</span>, con <strong>auto-pausa</strong> ' +
        'a ogni round per darti tempo di reagire.</p>' +
        '<p>Difendono le <strong>Batterie ⊕</strong> / <strong>Scudi ◈</strong> della colonia e qualunque <strong>flotta presente</strong>. ' +
        'A ogni round puoi: <strong>rinforzare</strong> (manda una flotta sul sistema, si unisce al round dopo), <strong>ritirare</strong> ' +
        'le flotte (le difese restano sole), o <strong>pagare un tributo</strong> ai pirati per farli desistere.</p>' +
        '<p>Se le difese cadono la colonia viene <strong>saccheggiata</strong> (risorse, danni alle strutture, pop) — mai distrutta ' +
        'in un colpo. Ma una <strong>catena di sconfitte</strong> abbassa il <strong>morale d\'impero</strong> (produzione in calo) e ' +
        'alza la <strong>pressione</strong> nemica: reagisci con scelte oculate o rischi una spirale.</p>'
    },
    {
      id: 'decline',
      tag: 'Guerra · Declino',
      title: 'La spirale e come spezzarla',
      body:
        '<p>Quando perdi colonie e flotte, il <strong>morale d\'impero</strong> crolla e la <strong>pressione</strong> sale: le AI ostili ' +
        'fiutano la debolezza e attaccano di più. Una civiltà <em>predatrice</em> può <strong>radere</strong> una colonia, una ' +
        '<em>espansionista</em> <strong>conquistarla</strong> (il sistema passa a lei). È la spirale del declino.</p>' +
        '<p><strong>Spezzala con scelte oculate</strong> (nella vista Flotta): <strong>⟲ Richiama flotte</strong> per concentrare la difesa ' +
        'sulla capitale · <strong>Evacua colonia</strong> indifendibile recuperando metà delle risorse · <strong>Tributo → tregua</strong> per ' +
        'comprare tempo contro un\'AI · trasferisci la capitale su un mondo più sicuro.</p>' +
        '<p><strong>Fine partita:</strong> di default la partita è <strong>infinita</strong> — a 0 colonie vai in "Esilio" ma puoi risorgere. ' +
        'Solo in modalità <em>Incubo</em> (o col toggle game-over) perdere l\'ultima colonia chiude la run. Quando ti stanchi, ' +
        '"Nuova partita" dal menu chiude sempre la corrente.</p>'
    },

    /* ================================================================
       Lezioni per-struttura (M06.7). Una scheda per ogni voce del
       catalogo §10: cosa fa, bonus/malus, concatenazioni con le altre
       strutture. Trigger: bottone ⓘ sulla scheda costruzioni + auto-fire
       al primo "Costruisci" di quel tipo. Id stabile: 'struct:<id>'.
       ================================================================ */
    {
      id: 'struct:miniera', tag: 'Strutture · ⛏', title: 'Miniera',
      body:
        '<p>Estrae <strong>metalli</strong>: ~4/I al livello 1, modulata dal <em>potenziale</em> del corpo ' +
        '(potenziale 60 = resa piena; 30 = metà). Uso 1 energia/I.</p>' +
        '<p><strong>Sinergia:</strong> la <em>Fonderia</em> moltiplica la resa di tutte le miniere del pianeta ' +
        'di +40% per livello (×1.40 / ×1.80 / ×2.20). Conviene avere almeno 2 miniere prima della fonderia.</p>' +
        '<p><strong>Attenzione:</strong> consuma energia. Senza centrali sufficienti vai in carenza globale (−10/−30%).</p>'
    },
    {
      id: 'struct:centrale-solare', tag: 'Strutture · ⚡', title: 'Centrale solare',
      body:
        '<p>Produce <strong>energia</strong>: ~4/I al livello 1, modulata dal potenziale en. Nessun uso — è la struttura ' +
        '"pulita" dell\'economia.</p>' +
        '<p><strong>Sinergia:</strong> la <em>Raffineria energetica</em> moltiplica la resa di tutte le centrali di +40% per livello, ' +
        'e produce a sua volta 2 en/I diretti — l\'unica produttiva con effetto doppio.</p>' +
        '<p><strong>Concatenazione:</strong> energia è risorsa-pilastro. Tutte le altre strutture la consumano: tienila in surplus.</p>'
    },
    {
      id: 'struct:impianto-idrico', tag: 'Strutture · ≈', title: 'Impianto idrico',
      body:
        '<p>Produce <strong>acqua</strong>: ~4/I al livello 1, modulata dal potenziale water. Uso 1 en/I.</p>' +
        '<p><strong>Concatenazione critica:</strong> la <em>Fattoria</em> consuma 1 acqua/I, l\'<em>Ospedale</em> 0 ma ne fa indirettamente bisogno via pop, ' +
        'e tutte le abitazioni richiedono 1 acqua/I. Se l\'acqua va in <strong>crit</strong> (zero stock), parte un timer di tolleranza: ' +
        'dopo 30 <span class="ds-unit">Ι</span> consecutivi di sete la popolazione cala 1 unità ogni 30 <span class="ds-unit">Ι</span>.</p>'
    },
    {
      id: 'struct:fattoria', tag: 'Strutture · ❖', title: 'Fattoria idroponica',
      body:
        '<p>Produce <strong>cibo</strong>: ~4/I al livello 1, modulata dal potenziale food. Uso 1 en + <strong>1 acqua/I</strong>.</p>' +
        '<p><strong>Concatenazione:</strong> dipende dall\'acqua. Se l\'impianto idrico è in difficoltà, le fattorie soffrono per prime ' +
        '→ cala il cibo → carenza popolazione. Pianta più impianti idrici prima delle fattorie.</p>' +
        '<p><strong>Salute della popolazione:</strong> cibo + acqua sono i due requisiti vitali. Cibo a zero per 30 <span class="ds-unit">Ι</span> consecutivi → −1 pop ogni 30 <span class="ds-unit">Ι</span> (recovery-friendly).</p>'
    },
    {
      id: 'struct:fonderia', tag: 'Strutture · 🜂', title: 'Fonderia',
      body:
        '<p><strong>Non produce direttamente:</strong> moltiplica tutte le miniere del pianeta di <strong>+40% per livello</strong> ' +
        '(lvl 1 → ×1.40, lvl 3 → ×2.20). Uso 3 en/I.</p>' +
        '<p><strong>Quando costruirla:</strong> almeno 2-3 miniere già operative, altrimenti il guadagno assoluto è basso ' +
        'rispetto all\'uso. Esempio: 3 miniere lvl 1 = 12 met/I → con fonderia lvl 1 = 15 met/I.</p>' +
        '<p><strong>Prerequisito:</strong> almeno una miniera già costruita sul pianeta.</p>'
    },
    {
      id: 'struct:raffineria', tag: 'Strutture · ⚛', title: 'Raffineria energetica',
      body:
        '<p><strong>Effetto doppio:</strong> produce 2 en/I diretti <em>e</em> moltiplica tutte le centrali del pianeta di ' +
        '<strong>+40% per livello</strong>. Uso 2 acqua/I (attenzione alla concatenazione idrica).</p>' +
        '<p><strong>Quando costruirla:</strong> dopo aver tappato il fabbisogno idrico — altrimenti il consumo extra di acqua ' +
        'può sbilanciare le fattorie.</p>' +
        '<p><strong>Prerequisito:</strong> almeno una centrale solare già costruita.</p>'
    },
    {
      id: 'struct:laboratorio', tag: 'Strutture · ⌬', title: 'Laboratorio',
      body:
        '<p>Produce <strong>ricerca</strong> distribuita: 3/I a livello 1. Uso 2 en/I.</p>' +
        '<p>Oggi i punti ricerca si accumulano ma l\'albero tecnologico vero arriverà più avanti nello sviluppo. ' +
        'Costruire laboratori adesso è un investimento — quando la ricerca sarà attiva, le tecnologie si sbloccheranno via via.</p>' +
        '<p><strong>Pista vittoria:</strong> contribuisce all\'<em>Ascensione tech</em>.</p>'
    },
    {
      id: 'struct:osservatorio', tag: 'Strutture · ◎', title: 'Osservatorio planetario',
      body:
        '<p>Scansiona il corpo per <strong>rivelare le identità delle risorse avanzate</strong> (cristalli, esotici, biomassa, ' +
        'gas nobili, dati, reliquie). Visibile il numero da subito; identità mascherate fino a fine scansione.</p>' +
        '<p><strong>Timeline:</strong> 14 <span class="ds-unit">Ι</span> per costruirlo + ~10 <span class="ds-unit">Ι</span> di scansione effettiva. Livello 2 dimezza il tempo di scansione.</p>' +
        '<p><strong>Prerequisito implicito</strong> per l\'<em>Impianto esotico</em>: senza scansione completata non si conosce ' +
        'la risorsa rara da sfruttare.</p>'
    },
    {
      id: 'struct:cantiere-navale', tag: 'Strutture · ▱', title: 'Hangar di costruzione',
      body:
        '<p>Cuore della tua flotta: <strong>costruisce astronavi</strong> e fa da <strong>porto a terra</strong> ' +
        'per quelle a riposo. Occupa 2 slot per modulo (struttura grossa) e ha uso 4 en + 1 met/I.</p>' +
        '<p><strong>Doppia capacità (cresce col livello):</strong></p>' +
        '<ul style="margin: 4px 0 6px 18px; font-size: 0.92em;">' +
          '<li><strong>Cantieri</strong> (navi costruibili in parallelo): 2 · 3 · 4 · 5 · 7 ai livelli 1-5</li>' +
          '<li><strong>Attracchi</strong> (posti d\'attracco a terra): 4 · 8 · 13 · 18 · 25</li>' +
        '</ul>' +
        '<p>Più hangar sulla stessa colonia <strong>cumulano</strong> entrambe le capacità.</p>' +
        '<p><strong>Bonus tecnici:</strong> la classe <em>tecnici</em> (vedi tab Popolazione) accelera la costruzione ' +
        'di scafi/equipaggi — <strong>−2.5% tempo per tecnico</strong> oltre la soglia 2, cap −30%. Una colonia "scientifica" ' +
        'con molti tecnici vara navi più in fretta.</p>' +
        '<p><strong>Quando il porto si satura</strong> (limite raggiunto): non puoi costruire altre navi finché non lanci ' +
        'una spedizione (libera attracco) o espandi l\'Hangar. Le navi che rientrano e non hanno posto restano in ' +
        '"orbita parcheggio" (nessuna penalità oggi — sarà M09: esposte a cattura).</p>' +
        '<p><strong>Ganci futuri:</strong> il <em>Porto stellare orbitale</em> (M16) darà capacità di attracco molto più ampia; ' +
        'il <em>Bacino orbitale</em> (M15) servirà alle grandi navi (incrociatori/dreadnought/ammiraglie).</p>' +
        '<p><strong>Concatenazione:</strong> l\'<em>Accademia militare</em> forma gli equipaggi che servono per usare le navi.</p>'
    },
    {
      id: 'struct:accademia-militare', tag: 'Strutture · ⚔', title: 'Accademia militare',
      body:
        '<p>Forma quadri militari, ufficiali e veterani (figure speciali). Oggi nessun effetto visibile. ' +
        'Uso moderato (2 en + 1 food/I).</p>' +
        '<p><strong>Sinergia futura:</strong> con l\'<em>Hangar di costruzione</em> alimenta una colonia a vocazione militare. ' +
        'In partite a vocazione <em>Tiranno</em> sarà struttura-chiave.</p>'
    },
    {
      id: 'struct:batteria-difesa', tag: 'Strutture · ⊕', title: 'Batteria di difesa',
      body:
        '<p>Difesa planetaria: <strong>torrette e cannoni</strong> che combattono quando il sistema della colonia è ' +
        'sotto assedio. Ogni modulo aggiunge <strong>fuoco (8 fp)</strong> e <strong>corazza (60 hp)</strong>; salendo di ' +
        'livello aggiungi moduli (resa cumulata crescente).</p>' +
        '<p><strong>Le difese non si ritirano mai</strong> (sono immobili): tengono finché reggono. Danneggiate in battaglia ' +
        'si <strong>riparano da sole</strong> nel tempo (quando non sotto attacco).</p>' +
        '<p><strong>Quando serve:</strong> sulle colonie esposte (vicine a covi pirata o a vicini ostili). Una colonia ricca e ' +
        'popolosa è il bersaglio più ambito — proteggila o rischi il saccheggio.</p>'
    },
    {
      id: 'struct:scudo-planetario', tag: 'Strutture · ◈', title: 'Scudo planetario',
      body:
        '<p>Schermo deflettore: aggiunge <strong>molta corazza</strong> (90 hp/modulo) alla difesa del sistema, spara poco. ' +
        'Va affiancato alle Batterie (che fanno il fuoco) per reggere assedi più lunghi.</p>' +
        '<p>Richiede la <strong>tecnologia degli scudi</strong> (M13): per ora è un gancio, sbloccabile con l\'albero tech.</p>'
    },
    {
      id: 'struct:centro-abitativo', tag: 'Strutture · ⌂', title: 'Centro abitativo',
      body:
        '<p>Aumenta la <strong>capacità di popolazione (popCap)</strong> di +2 per livello e dà <strong>+0.05 morale</strong> ' +
        '(cap 1.35, il pianeta base parte già a 1.15). Uso 1 en + 1 food + 1 water /I.</p>' +
        '<p><strong>Morale:</strong> moltiplica la crescita della popolazione (base 0.018 unità/I × morale). Più centri → ' +
        'più tetto demografico e crescita più rapida, ma anche più consumi vitali.</p>' +
        '<p><strong>Concatenazione critica:</strong> ogni centro consuma cibo + acqua. Non costruire centri se le filiere ' +
        'cibo/acqua non sono solide.</p>'
    },
    {
      id: 'struct:ospedale', tag: 'Strutture · ✚', title: 'Ospedale',
      body:
        '<p><strong>Accelera la crescita pop</strong>: ×1.6 (cioè +60%) sulla velocità base di 0.018 unità/I × morale.</p>' +
        '<p><strong>Esempio concreto:</strong> da popCap 3 a popCap 15 senza ospedale ≈ 500 <span class="ds-unit">Ι</span> (5 Orbite); con ospedale ≈ 310 <span class="ds-unit">Ι</span>. ' +
        'Conviene se prevedi tante abitazioni.</p>' +
        '<p><strong>Non protegge dalla carenza vitale:</strong> se cibo o acqua restano a zero per 30 <span class="ds-unit">Ι</span>, la pop cala comunque ' +
        '(1 unità ogni 30 <span class="ds-unit">Ι</span>, recovery-friendly).</p>'
    },
    {
      id: 'struct:mercato', tag: 'Strutture · ⇄', title: 'Mercato',
      body:
        '<p>Hub per le rotte commerciali interne all\'impero e per le <em>valute regionali</em> ' +
        '(ogni regione avrà una sua moneta a tema).</p>' +
        '<p>Oggi non produce nulla visibile. Costruirlo è un investimento per quando saranno attivi gli scambi tra colonie ' +
        '(produzione specializzata + trasferimento risorse).</p>' +
        '<p><strong>Pista vittoria:</strong> contribuirà all\'<em>Egemone economico</em>.</p>'
    },
    {
      id: 'struct:impianto-riciclo', tag: 'Strutture · ♻', title: 'Impianto di riciclo',
      body:
        '<p>Tratta i <strong>rifiuti</strong> generati da popolazione e industria: ne <strong>recupera energia</strong> ' +
        '(≈0.25 en per unità trattata) e <strong>alza la capacità</strong> di contenimento (+150 per modulo). Uso 1 en/I.</p>' +
        '<p><strong>Perché conta:</strong> sopra il 70% di saturazione la produzione della colonia inizia a deperire ' +
        '(fino a −25%). Un solo impianto a livello 1 tratta 3 rifiuti/Ι; espandendolo (rendimento crescente dei moduli) ' +
        'porti il netto in negativo e <strong>svuoti</strong> l\'accumulo.</p>' +
        '<p><strong>Sinergia:</strong> più popolazione e più industria → più rifiuti. Su colonie grandi e mature è una ' +
        'struttura quasi obbligata; su mondi piccoli può bastare un modulo.</p>' +
        '<p><strong>In arrivo:</strong> con le rotte commerciali potrai <em>esportare</em> i rifiuti, e i mondi ostili ' +
        'diventeranno <em>colonie riciclanti</em> dedicate.</p>'
    },
    {
      id: 'struct:impianto-esotico', tag: 'Strutture · ✦', title: 'Impianto esotico',
      body:
        '<p>Struttura <strong>avanzata</strong>: sfrutta una risorsa avanzata per dare <strong>moltiplicatori globali</strong> ' +
        'a tutta la civiltà (effetto cumulativo tra colonie). Uso 5 en/I, occupa 2 slot.</p>' +
        '<p><strong>Doppio prerequisito:</strong> (1) <em>scansione completata</em> sul pianeta (osservatorio), ' +
        '(2) tecnologia degli esotici sbloccata (oggi resta locked, in arrivo).</p>' +
        '<p><strong>Pista vittoria:</strong> chiave per l\'<em>Ascensione tech</em>; è la struttura più "endgame" del catalogo.</p>'
    },

    /* ================================================================
       M07 — Esplorazione (decisione #37). Due lezioni:
         exploration       — overview del sistema (sblocco tab)
         expedition-launch — al primo lancio riuscito
       ================================================================ */
    {
      id: 'exploration', tag: 'Esplorazione · ✦', title: 'Esplorare la galassia',
      body:
        '<p>I sistemi non noti vivono in <strong>nebbia di guerra</strong>: <em>UNKNOWN → DETECTED → EXPLORED</em>. ' +
        'Per scoprire l\'interno di un sistema rilevato (o ignorato) ti serve una <strong>spedizione</strong>.</p>' +
        '<p>Una spedizione consuma <strong>1 scafo esploratore</strong> (Hangar di costruzione) + ' +
        '<strong>1 equipaggio esploratore</strong> (Accademia militare). Gli equipaggi accumulano <strong>xp</strong> ad ogni rientro: ' +
        'più xp = viaggi più rapidi e meno incidenti (cap −15% durata, −20% incidenti).</p>' +
        '<p>Il <em>pericolo</em> del sistema target modula la durata del salto iperspaziale (40-80 Ι base) ' +
        'e la probabilità di incidente (5% sicuro → 30% letale). ' +
        '<strong>Recovery-friendly</strong>: nel peggiore dei casi perdi lo scafo, l\'equipaggio si salva sempre.</p>' +
        '<p>I tre tier di <em>iperguida</em> (in arrivo) ridurranno drasticamente le durate (×3, ×8, ×20).</p>'
    },
    {
      id: 'expedition-launch', tag: 'Esplorazione · ✦', title: 'Primo salto iperspaziale',
      body:
        '<p>La spedizione viaggia verso il sistema target, rivela il suo interno (passa a EXPLORED, ' +
        'i suoi vicini ignoti diventano DETECTED), poi rientra alla colonia d\'origine.</p>' +
        '<p><strong>Incidenti tipici:</strong> ritardo (+10-20 Ι), avaria minore (+10-15% usura), avaria critica ' +
        '(scafo perso, equipaggio in fuga — solo su pericolo > 50), scoperta fortuita (raro, positivo).</p>' +
        '<p><strong>Strategia:</strong> tieni gli equipaggi vivi e mandali in missione ripetutamente per costruire ' +
        '<em>veterani</em>. Uno scafo logoro al 100% va in pensione: niente fail-state, costruisci il prossimo.</p>' +
        '<p><strong>Ganci futuri:</strong> nuove classi di navi (caccia, fregata, incrociatore) e l\'iperguida sono in arrivo.</p>'
    },
    {
      id: 'governor', tag: 'Colonia · ⚙', title: 'Governatore coloniale',
      body:
        '<p>Quando il tuo impero supera <strong>3 colonie operative</strong>, in ogni scheda Colonia puoi attivare un ' +
        '<strong>Governatore (Tier 1 · Vigile)</strong>: non agisce mai, ma <strong>segnala in cronaca</strong> ' +
        'situazioni che meritano attenzione su quella colonia, così non sei costretto a ispezionare ogni pianeta a turno.</p>' +
        '<p>Il Tier 1 sorveglia 5 condizioni:</p>' +
        '<ul>' +
          '<li><strong>Coda ferma</strong> da troppo tempo (cantieri inutilizzati)</li>' +
          '<li><strong>Slot liberi</strong> e nessun progetto in coda (potenziale sprecato)</li>' +
          '<li><strong>Popolazione</strong> ≥ 90% del tetto abitativo (è ora di espandere l\'habitat)</li>' +
          '<li><strong>Scorte di cibo/acqua in calo</strong> per più Impulsi consecutivi (carenza imminente)</li>' +
          '<li><strong>Veterani disponibili</strong> senza spedizione in corso (forza esperta ferma)</li>' +
        '</ul>' +
        '<p>Le 2 segnalazioni più urgenti (carenze in arrivo, coda ferma) fanno <strong>auto-pausa</strong>; ' +
        'le altre restano in cronaca senza interrompere il gioco. Puoi spegnere ogni tipo dall\'overlay di pausa.</p>' +
        '<p><strong>Tier futuri:</strong> il Tier 2 <em>Operativo</em> gestirà in autonomia la coda secondo una ' +
        '<em>vocazione</em> scelta da te (estrattiva, agricola, militare, ricerca); il Tier 3 <em>Autonomo</em> ' +
        'estenderà la delega ad asset, difese e rotte commerciali. Richiederanno tech dedicati e una <em>figura ' +
        'Governatore</em> da assegnare alla colonia.</p>'
    },
    {
      id: 'commander-promoted', tag: 'Forze · ★', title: 'Un Comandante emerge dall\'equipaggio',
      body:
        '<p>Quando un equipaggio raggiunge <strong>xp 5</strong> (rango <em>asso</em>), dal gruppo emerge ' +
        'naturalmente un <strong>Comandante nominato</strong>: una figura militare con <strong>nome proprio</strong>, ' +
        '<strong>tratto di personalità</strong> e <strong>specializzazione</strong>.</p>' +
        '<p>Il Comandante eredita l\'esperienza che il crew aveva accumulato. L\'equipaggio <strong>non viene perso</strong> ' +
        'ma riparte da zero — sono più persone, l\'ufficiale si stacca e il gruppo si riforma sotto il vuoto lasciato.</p>' +
        '<p><strong>Specializzazioni</strong> (tre famiglie):</p>' +
        '<ul>' +
          '<li><strong>Navigatore</strong> — esperto di rotte iperspaziali</li>' +
          '<li><strong>Tattico</strong> — comando in battaglia</li>' +
          '<li><strong>Logista</strong> — supply chain e usura della flotta</li>' +
        '</ul>' +
        '<p>I Comandanti vengono elencati nella tab <strong>Forze</strong>. Per ora restano <em>in panchina</em>: ' +
        'i loro bonus si attiveranno con il modulo <strong>Flotta</strong> (M08), quando potranno essere assegnati ' +
        'a navi più evolute (corvette, fregate, incrociatori) e portare i bonus della loro specializzazione. ' +
        'Tienili da parte: sono il nucleo della tua futura ufficialità.</p>'
    },
    /* Decisione #45 — espansione slot via bonifica + terraformazione. */
    {
      id: 'terraforming', tag: 'Strutture · ⛭', title: 'Bonifica e Terraformazione',
      body:
        '<p>Hai pochi <strong>slot</strong> su questo pianeta? Esistono due strutture <em>tech-gated</em> che li espandono.</p>' +
        '<p><strong>Centro di ingegneria planetaria (⛭):</strong> bonifica le aree marginali del pianeta. ' +
        'Slot guadagnati per tipo:</p>' +
        '<ul>' +
          '<li><strong>Mondi-giardino</strong> (terrestre, oceanico, forestale): <strong>+8 slot</strong></li>' +
          '<li><strong>Mondi-fabbrica</strong> (desertico, vulcanico, ghiacciato): <strong>+5 slot</strong></li>' +
          '<li><strong>Piccoli</strong> (luna, gassoso, cintura): <strong>+3 slot</strong></li>' +
        '</ul>' +
        '<p><strong>Terraformatori (✦):</strong> tier 2, richiede la Bonifica già costruita. Trasforma il pianeta su scala ' +
        'continentale: <strong>+12 slot</strong> sui giardino, <strong>+7</strong> sui mondi-fabbrica (no luna/gassoso/cintura).</p>' +
        '<p>Entrambe richiedono una <strong>tecnologia dedicata</strong> (oggi non ancora disponibile — gancio per il modulo Ricerca futuro). ' +
        'Pensale come obiettivi di lungo periodo per i tuoi mondi più importanti.</p>'
    },
    {
      id: 'capital', tag: 'Colonia · ★', title: 'Capitale di Gruppo',
      body:
        '<p>Ogni <strong>gruppo stellare</strong> (regione della galassia) può avere <strong>una sola colonia capitale</strong> ' +
        'per volta. La capitale gode di:</p>' +
        '<ul>' +
          '<li><strong>+15% produzione</strong> uniforme su tutte le risorse</li>' +
          '<li><strong>+10 slot</strong> di riserva (per difese future, stazioni orbitali, ricerca avanzata)</li>' +
          '<li><strong>Sede ambasciata</strong> (futura, modulo Diplomazia)</li>' +
          '<li><strong>Governatore di sector</strong> (futuro, modulo Figure speciali)</li>' +
        '</ul>' +
        '<p>La <strong>home iniziale</strong> è auto-promossa a capitale del suo gruppo. Per cambiarla, vai nella scheda ' +
        'Colonia → "Dichiara capitale". <strong>Transizione 80 <span class="ds-unit">Ι</span></strong>: la vecchia capitale ' +
        'subisce <strong>−10% produzione</strong>, la nuova ha <strong>0 bonus</strong> finché non si stabilizza. ' +
        'Un cambio è quindi una scelta strategica seria.</p>' +
        '<p><strong>Ganci futuri:</strong> le capitali saranno bersagli politici/militari più ambiti (M09 difese, M11 diplomazia, M18 reputazione).</p>'
    },

    /* ==================================================================
       M08 — Flotta base (decisione #42 + decisione #46 Fase B)
       ================================================================== */
    {
      id: 'fleet-overview',
      tag: 'M08 · Flotta',
      title: 'Flotte e ordini',
      body:
        '<p>La <strong>flotta</strong> è un\'unità mobile composta da navi (entità individuali con <em>hp</em> e <em>usura</em>) ' +
        'e dall\'equipaggio che le opera. La crei dalla <em>vista Flotta</em> partendo da una colonia, ' +
        'le assegni navi dal counter dell\'Hangar e equipaggi dall\'Accademia, poi le dai ordini.</p>' +
        '<p>Ordini disponibili: <strong>idle</strong> (ferma) · <strong>move</strong> (rotta verso un sistema) · ' +
        '<strong>explore</strong> (rivela il sistema target e rientra) · <strong>patrol</strong> (A↔B continuo) · ' +
        '<strong>return</strong> (rientra alla base) · <strong>rotta a tappe</strong> (multi-waypoint con sosta opzionale) · ' +
        '<strong>pattuglia su N sistemi</strong> (loop ciclico).</p>' +
        '<p>La flotta viaggia alla velocità della <strong>nave più lenta</strong>. M13 introdurrà i 3 tier di <em>iperguida</em> ' +
        'che ridurranno drasticamente i tempi di salto iperspaziale.</p>'
    },
    {
      id: 'fleet-classes',
      tag: 'M08 · Classi',
      title: 'Cinque classi navi',
      body:
        '<p>Trade-off di base: velocità ↔ corazza ↔ fuoco. Le classi pesanti richiedono Hangar di livello superiore.</p>' +
        '<ul>' +
          '<li><strong>✦ Esploratore</strong> — hp 20, fp 0, spd 1.1 · ricognizione, nessun combattimento.</li>' +
          '<li><strong>∢ Caccia stellare</strong> — hp 30, fp 5, spd 1.2 · economico, anti-caccia.</li>' +
          '<li><strong>➤ Intercettore</strong> — hp 45, fp 8, spd 1.4 · classe più veloce, eccellente in inseguimento.</li>' +
          '<li><strong>◅ Corvetta</strong> — hp 80, fp 12, spd 1.0 · scorta multiruolo, equilibrata.</li>' +
          '<li><strong>◣ Fregata</strong> — hp 160, fp 25, spd 0.85 · linea di battaglia, lenta ma cara da abbattere.</li>' +
        '</ul>' +
        '<p>Le grandi navi (incrociatore/dreadnought/ammiraglia) arriveranno con M15 + Bacino orbitale (M16).</p>'
    },
    {
      id: 'fleet-orders',
      tag: 'M08 · Rotte',
      title: 'Rotte a tappe e pattuglie',
      body:
        '<p>Dalla finestra <strong>Ordini</strong> di una flotta puoi pianificare due ordini composti:</p>' +
        '<ul>' +
          '<li><strong>Rotta a tappe (move-route)</strong>: una catena di sistemi visitati in sequenza. ' +
            'Per ogni tappa puoi impostare una <em>sosta orbitale</em> in Ι. Opzioni: <em>Esplora ogni tappa</em> ' +
            '(rivela ogni sistema all\'arrivo) · <em>Rientra alla base alla fine</em>.</li>' +
          '<li><strong>Pattuglia su N sistemi (patrol-loop)</strong>: come <em>patrol</em>, ma su 2+ nodi in loop. ' +
            'La pattuglia non si ferma — perfetta per presidiare un confine.</li>' +
        '</ul>' +
        '<p>Senza consumo né uso, una flotta può <strong>vagare a lungo</strong> tra i sistemi favorevoli. ' +
        'I rifugi presso popoli terzi (recupero/rifornimento) arriveranno con <strong>M10 Civiltà AI</strong> + ' +
        '<strong>M11 Diplomazia</strong> (diritto di passaggio/d\'attracco) + <strong>M16 Stazioni orbitali</strong>.</p>'
    }
  ];

  /* Indice rapido id → lezione */
  const LESSON_BY_ID = {};
  LESSONS.forEach(function (l) { LESSON_BY_ID[l.id] = l; });

  /* ------------------------------------------------------------------
     STATO DI MODULO — riferimento al game corrente, popup attivo
     ------------------------------------------------------------------ */
  let _activeLessonId = null;

  function getGame() { return ORION.game; }

  function isEnabled(game) {
    game = game || getGame();
    return !!(game && game.tutorial && game.tutorial.enabled);
  }

  function isSeen(game, id) {
    game = game || getGame();
    if (!game || !game.tutorial) return false;
    return Array.isArray(game.tutorial.seenLessons) &&
           game.tutorial.seenLessons.indexOf(id) >= 0;
  }

  function markSeen(id) {
    const game = getGame();
    if (!game) return;
    if (!game.tutorial) game.tutorial = { enabled: false, seenLessons: [] };
    if (!Array.isArray(game.tutorial.seenLessons)) game.tutorial.seenLessons = [];
    if (game.tutorial.seenLessons.indexOf(id) < 0) {
      game.tutorial.seenLessons.push(id);
    }
  }

  /* Inizializza lo stato tutorial sul game (chiamato da newGame).
     Se il payload caricato aveva già uno stato, viene rispettato.  */
  function initOnGame(game, enabled) {
    if (!game) return;
    if (!game.tutorial) {
      game.tutorial = { enabled: !!enabled, seenLessons: [] };
    } else {
      /* Payload caricato: rispetta il flag se presente, altrimenti
         tieni il default ricevuto dal chiamante. */
      if (typeof game.tutorial.enabled !== 'boolean') game.tutorial.enabled = !!enabled;
      if (!Array.isArray(game.tutorial.seenLessons)) game.tutorial.seenLessons = [];
    }
  }

  function setEnabled(value) {
    const game = getGame();
    if (!game) return;
    if (!game.tutorial) game.tutorial = { enabled: false, seenLessons: [] };
    game.tutorial.enabled = !!value;
  }

  /* ------------------------------------------------------------------
     FIRE — chiamato dai punti rilevanti del gioco. Se il tutorial è
     abilitato e la lezione non è stata già vista, la mostra.
     Ritorna true se ha effettivamente aperto il popup.
     ------------------------------------------------------------------ */
  function fire(id) {
    if (!id || !LESSON_BY_ID[id]) return false;
    if (!isEnabled()) return false;
    if (isSeen(null, id)) return false;
    /* Se c'è già un popup aperto, non sovrapponiamo — la prossima
       trigger della stessa lezione non si perde (resta non-seen). */
    if (_activeLessonId) return false;
    showLesson(id);
    return true;
  }

  /* ------------------------------------------------------------------
     RENDER POPUP
     Si monta sopra tutto (z-index 400, sopra main-menu 200 e save 300).
     Pulsante "Ho capito" marca seen + chiude. Pulsante "Disabilita
     tutorial" toglie il flag enabled per il resto della partita
     (la "?" in HUD resta sempre disponibile per riapertura manuale).
     ------------------------------------------------------------------ */
  function ensureHost() {
    let host = document.querySelector('[data-bind="tutorial-modal"]');
    if (host) return host;
    host = document.createElement('div');
    host.className = 'tutorial-modal';
    host.setAttribute('data-bind', 'tutorial-modal');
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-modal', 'true');
    host.setAttribute('aria-label', 'Tutorial');
    host.hidden = true;
    document.body.appendChild(host);
    return host;
  }

  function escapeText(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function showLesson(id) {
    const lesson = LESSON_BY_ID[id];
    if (!lesson) return;
    _activeLessonId = id;
    const host = ensureHost();
    host.innerHTML =
      '<div class="tutorial-card" role="document">' +
        '<header class="tutorial-card__head">' +
          '<span class="tutorial-card__tag">' + escapeText(lesson.tag) + '</span>' +
          '<h2 class="tutorial-card__title">' + escapeText(lesson.title) + '</h2>' +
          '<button class="btn btn--mini btn--icon-only tutorial-card__close" data-action="tut-close" type="button" aria-label="Chiudi">' +
            '<span class="ui-icon" aria-hidden="true">' + ((typeof ORION !== 'undefined' && ORION.icon && ORION.icon('close')) || '✕') + '</span>' +
          '</button>' +
        '</header>' +
        '<div class="tutorial-card__body">' + lesson.body + '</div>' +
        '<footer class="tutorial-card__foot">' +
          '<button class="btn btn--mini tutorial-card__off" data-action="tut-off" type="button">Disabilita tutorial</button>' +
          '<button class="btn btn--primary tutorial-card__ok" data-action="tut-ok" type="button">Ho capito</button>' +
        '</footer>' +
      '</div>';
    host.hidden = false;

    host.querySelector('[data-action="tut-close"]').addEventListener('click', closeLesson);
    host.querySelector('[data-action="tut-ok"]').addEventListener('click', confirmLesson);
    host.querySelector('[data-action="tut-off"]').addEventListener('click', function () {
      setEnabled(false);
      confirmLesson();
      if (ORION.save && ORION.save.autosave && ORION.game) ORION.save.autosave(ORION.game);
    });
    /* Backdrop click chiude SENZA marcare seen (così se l'utente la
       chiude per sbaglio, ricomparirà alla prossima trigger). */
    host.addEventListener('click', function (e) {
      if (e.target === host) closeLesson();
    });
    /* Esc */
    document.addEventListener('keydown', escHandler);
  }

  function escHandler(e) {
    if (e.key === 'Escape' && _activeLessonId) closeLesson();
  }

  function closeLesson() {
    const host = document.querySelector('[data-bind="tutorial-modal"]');
    if (host) { host.hidden = true; host.innerHTML = ''; }
    _activeLessonId = null;
    document.removeEventListener('keydown', escHandler);
  }

  function confirmLesson() {
    if (_activeLessonId) markSeen(_activeLessonId);
    closeLesson();
    /* Persist seenLessons subito così non si perde su F5. */
    if (ORION.save && ORION.save.autosave && ORION.game) ORION.save.autosave(ORION.game);
  }

  /* ------------------------------------------------------------------
     INDICE — apre la lista completa di lezioni (viste + non viste),
     ciascuna riapribile a piacere. Manuale leggero richiesto dall'utente.
     ------------------------------------------------------------------ */
  function openIndex() {
    /* Se c'è una lezione attiva, non sovrapporre. */
    if (_activeLessonId) return;
    const host = ensureHost();
    const game = getGame();
    const enabled = isEnabled(game);
    /* PR-F: stato lezioni con SVG (UI_GUIDE §3) — check verde per
       lezione vista, transition viola per nuova. */
    const ICON = (typeof ORION !== 'undefined' && ORION.icon) ? ORION.icon : function () { return ''; };
    const checkSvg = '<span class="ui-icon ui-icon--green" aria-hidden="true">' + ICON('check') + '</span>';
    const newSvg   = '<span class="ui-icon ui-icon--violet" aria-hidden="true">' + ICON('transition') + '</span>';
    const rows = LESSONS.map(function (l) {
      const seen = isSeen(game, l.id);
      return '<button class="tutorial-index__row" data-tut-id="' + l.id + '" type="button">' +
        '<span class="tutorial-index__tag">' + escapeText(l.tag) + '</span>' +
        '<span class="tutorial-index__title">' + escapeText(l.title) + '</span>' +
        '<span class="tutorial-index__state ' + (seen ? 'is-seen' : 'is-unseen') + '">' +
          (seen ? checkSvg + ' vista' : newSvg + ' nuova') +
        '</span>' +
      '</button>';
    }).join('');
    host.innerHTML =
      '<div class="tutorial-card tutorial-card--index" role="document">' +
        '<header class="tutorial-card__head">' +
          '<span class="tutorial-card__tag">Tutorial</span>' +
          '<h2 class="tutorial-card__title">' +
            '<span class="ui-icon ui-icon--violet" aria-hidden="true">' + ICON('book') + '</span> ' +
            'Tutorial — indice' +
          '</h2>' +
          '<button class="btn btn--mini btn--icon-only tutorial-card__close" data-action="tut-close" type="button" aria-label="Chiudi">' +
            '<span class="ui-icon" aria-hidden="true">' + ((typeof ORION !== 'undefined' && ORION.icon && ORION.icon('close')) || '✕') + '</span>' +
          '</button>' +
        '</header>' +
        '<div class="tutorial-card__body">' +
          '<p class="tut-hint">Riapri qualsiasi scheda per rileggerla. Le schede non viste si aprono comunque da sole se il tutorial è attivo.</p>' +
          '<div class="tutorial-index">' + rows + '</div>' +
        '</div>' +
        '<footer class="tutorial-card__foot">' +
          '<label class="tutorial-toggle">' +
            '<input type="checkbox" data-action="tut-toggle"' + (enabled ? ' checked' : '') + '>' +
            '<span>Tutorial attivo (apri automaticamente le nuove schede)</span>' +
          '</label>' +
          '<button class="btn btn--primary tutorial-card__ok" data-action="tut-index-close" type="button">Chiudi</button>' +
        '</footer>' +
      '</div>';
    host.hidden = false;
    host.querySelector('[data-action="tut-close"]').addEventListener('click', closeIndex);
    host.querySelector('[data-action="tut-index-close"]').addEventListener('click', closeIndex);
    host.querySelector('[data-action="tut-toggle"]').addEventListener('change', function (e) {
      setEnabled(e.target.checked);
      if (ORION.save && ORION.save.autosave && ORION.game) ORION.save.autosave(ORION.game);
    });
    host.querySelectorAll('[data-tut-id]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const id = btn.dataset.tutId;
        closeIndex();
        /* Apertura manuale: NON consuma la "prima trigger" automatica.
           Se l'utente non clicca "Ho capito", la lezione resta non-seen
           e potrà comparire ancora al prossimo trigger contestuale. */
        showLesson(id);
      });
    });
    host.addEventListener('click', function (e) {
      if (e.target === host) closeIndex();
    });
    document.addEventListener('keydown', escHandlerIdx);
  }

  function escHandlerIdx(e) {
    if (e.key === 'Escape') closeIndex();
  }

  function closeIndex() {
    const host = document.querySelector('[data-bind="tutorial-modal"]');
    if (host) { host.hidden = true; host.innerHTML = ''; }
    document.removeEventListener('keydown', escHandlerIdx);
  }

  /* ------------------------------------------------------------------
     EXPORT
     ------------------------------------------------------------------ */
  /* Apertura on-demand: ignora isEnabled e isSeen (manuale leggero).
     Chiude qualsiasi popup attivo prima di mostrare la nuova scheda. */
  function openLesson(id) {
    if (!id || !LESSON_BY_ID[id]) return false;
    if (_activeLessonId) closeLesson();
    /* Se l'indice è aperto, lo smonta */
    const host = document.querySelector('[data-bind="tutorial-modal"]');
    if (host && !host.hidden) { host.hidden = true; host.innerHTML = ''; }
    showLesson(id);
    return true;
  }

  ORION.tutorial = {
    LESSONS: LESSONS,
    initOnGame: initOnGame,
    fire: fire,
    openLesson: openLesson,
    isEnabled: isEnabled,
    isSeen: isSeen,
    setEnabled: setEnabled,
    openIndex: openIndex,
    closeLesson: closeLesson
  };
})(typeof window !== 'undefined' ? window : this);
