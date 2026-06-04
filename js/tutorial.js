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
      tag: 'M01',
      title: 'Benvenuto in Orion Empires',
      body:
        '<p>4X strategico spaziale a pannelli. Non ci sono turni: il tempo scorre in <strong>Impulsi (I)</strong> ' +
        'del Tempo Standard Galattico — sei tu a decidere quando avanzare coi bottoni in alto a destra.</p>' +
        '<p>Esistono <strong>7 piste di vittoria in parallelo</strong> (esplorazione, colonizzazione, dominio economico, ' +
        'ascensione tech, pace, oppressione, sopravvivenza alla crisi). Vince chi chiude per primo una qualsiasi pista. ' +
        'La modalità scelta dà solo enfasi narrativa: nessuna pista è lockata.</p>' +
        '<p class="tut-hint">Riapri questo tutorial dal pulsante <kbd>?</kbd> in alto, quando vuoi.</p>'
    },
    {
      id: 'galaxy',
      tag: 'M02',
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
      tag: 'M03',
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
      tag: 'M04',
      title: 'Vista pianeta',
      body:
        '<p>Ogni corpo ha <strong>potenziali risorse</strong> (metalli, energia, cibo, acqua) e un numero di ' +
        '<strong>slot di costruzione</strong>. La scheda a destra ha 4 tab: <em>Colonia · Risorse · Strutture · Popolazione</em>.</p>' +
        '<p>Il <strong>pianeta base</strong> ha +20% di produzione. Colonizzare un secondo corpo costa ×5 finché il base è ancora produttivo, ' +
        'ma se va in crisi (carenza critica di cibo o acqua) il costo torna basso — è la <em>migrazione naturale forzata</em>.</p>'
    },
    {
      id: 'build',
      tag: 'M04',
      title: 'Strutture, slot e coda',
      body:
        '<p>Le strutture occupano <strong>slot</strong> e impiegano <strong>Impulsi</strong> per essere completate ' +
        '(vedi la durata sotto ogni voce). Non sono istantanee: avanza il tempo per veder maturare la coda.</p>' +
        '<p>Le <strong>estrattive</strong> (miniere, centrali, fattorie, raccoglitori) coprono il fabbisogno; le ' +
        '<strong>produttive</strong> (fonderia, raffineria) <strong>moltiplicano</strong> quello che le estrattive producono. ' +
        'L\'<strong>osservatorio</strong> rivela l\'identità delle risorse avanzate dopo circa 10 I di scansione.</p>'
    },
    {
      id: 'advance',
      tag: 'M05',
      title: 'Tempo Standard Galattico',
      body:
        '<p>Unità: <strong>Impulso (I)</strong> · 10 I = 1 Arco · 100 I = 1 Orbita · 1000 I = 1 Èra. La Data Stellare in alto ' +
        'mostra <code>DS &lt;orbita&gt;.&lt;impulsi&gt;</code>.</p>' +
        '<p>Avanzare fa maturare costruzioni, produzione, popolazione e scansioni. <strong>"Prossimo evento"</strong> ' +
        'salta direttamente al prossimo cambio di stato significativo (fine costruzione, arrivo colonia, scansione completata…).</p>' +
        '<p>Il sistema è <strong>recovery-friendly</strong>: nessuna scelta del momento è perennemente punitiva, ' +
        'tutte le situazioni difficili si recuperano col tempo.</p>'
    },
    {
      id: 'scarcity',
      tag: 'M05',
      title: 'Carenza risorse',
      body:
        '<p>Con stock ≤ 20 e netto negativo la colonia entra in <strong>allerta</strong> (−10% produzione globale); ' +
        'a zero diventa <strong>critica</strong> (−30%). Bastano <strong>3 Impulsi</strong> di netto ≥ 0 per uscirne.</p>' +
        '<p>Nessuna carenza è un fail-state: la popolazione cala solo dopo 30 Impulsi consecutivi di fame o sete, ' +
        'e poi di 1 unità ogni 30 I. Hai sempre il tempo di riassestare la coda, costruire ciò che manca, o spostarti.</p>'
    },
    {
      id: 'advanced',
      tag: 'M04',
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
      tag: 'M06',
      title: 'Salvataggi e trasferimento',
      body:
        '<p>L\'<strong>autosave</strong> rotante si aggiorna dopo ogni azione importante (avanzamento, costruzione, ' +
        'colonizzazione). 5 <strong>slot manuali</strong> per i checkpoint volontari.</p>' +
        '<p><strong>Esporta .json</strong> per trasferire la partita tra dispositivi (PC ↔ tablet): il file è ' +
        'autosufficiente, la galassia si rigenera dal seed. <strong>Importa .json</strong> sostituisce la partita corrente.</p>' +
        '<p>In modalità <strong>Ironman</strong> (preset Incubo) gli slot manuali sono nascosti: solo autosave + export/import, ' +
        'niente save-scumming.</p>'
    },

    /* ================================================================
       Lezioni per-struttura (M06.7). Una scheda per ogni voce del
       catalogo §10: cosa fa, bonus/malus, concatenazioni con le altre
       strutture. Trigger: bottone ⓘ sulla scheda costruzioni + auto-fire
       al primo "Costruisci" di quel tipo. Id stabile: 'struct:<id>'.
       ================================================================ */
    {
      id: 'struct:miniera', tag: 'M04 · ⛏', title: 'Miniera',
      body:
        '<p>Estrae <strong>metalli</strong>: ~4/I al livello 1, modulata dal <em>potenziale §7.1</em> del corpo ' +
        '(potenziale 60 = resa piena; 30 = metà). Upkeep 1 energia/I.</p>' +
        '<p><strong>Sinergia:</strong> la <em>Fonderia</em> moltiplica la resa di tutte le miniere del pianeta ' +
        'di +25% per livello (×1.25 / ×1.50 / ×1.75). Conviene avere almeno 2-3 miniere prima della fonderia.</p>' +
        '<p><strong>Attenzione:</strong> consuma energia. Senza centrali sufficienti vai in carenza globale (−10/−30%).</p>'
    },
    {
      id: 'struct:centrale-solare', tag: 'M04 · ⚡', title: 'Centrale solare',
      body:
        '<p>Produce <strong>energia</strong>: ~4/I al livello 1, modulata dal potenziale en. Nessun upkeep — è la struttura ' +
        '"pulita" dell\'economia.</p>' +
        '<p><strong>Sinergia:</strong> la <em>Raffineria energetica</em> moltiplica la resa di tutte le centrali di +20% per livello, ' +
        'e produce a sua volta 2 en/I diretti — l\'unica produttiva con effetto doppio.</p>' +
        '<p><strong>Concatenazione:</strong> energia è risorsa-pilastro. Tutte le altre strutture la consumano: tienila in surplus.</p>'
    },
    {
      id: 'struct:impianto-idrico', tag: 'M04 · ≈', title: 'Impianto idrico',
      body:
        '<p>Produce <strong>acqua</strong>: ~4/I al livello 1, modulata dal potenziale water. Upkeep 1 en/I.</p>' +
        '<p><strong>Concatenazione critica:</strong> la <em>Fattoria</em> consuma 1 acqua/I, l\'<em>Ospedale</em> 0 ma ne fa indirettamente bisogno via pop, ' +
        'e tutte le abitazioni richiedono 1 acqua/I. Se l\'acqua va in <strong>crit</strong> (zero stock), parte il timer §7.4: ' +
        'dopo 30 I consecutivi di sete la popolazione cala 1 unità ogni 30 I.</p>'
    },
    {
      id: 'struct:fattoria', tag: 'M04 · ❖', title: 'Fattoria idroponica',
      body:
        '<p>Produce <strong>cibo</strong>: ~4/I al livello 1, modulata dal potenziale food. Upkeep 1 en + <strong>1 acqua/I</strong>.</p>' +
        '<p><strong>Concatenazione:</strong> dipende dall\'acqua. Se l\'impianto idrico è in difficoltà, le fattorie soffrono per prime ' +
        '→ cala il cibo → carenza popolazione. Pianta più impianti idrici prima delle fattorie.</p>' +
        '<p><strong>Salute pop §9.3:</strong> cibo + acqua sono i due requisiti vitali. Cibo a zero per 30 I consecutivi → −1 pop ogni 30 I (recovery-friendly).</p>'
    },
    {
      id: 'struct:fonderia', tag: 'M04 · 🜂', title: 'Fonderia',
      body:
        '<p><strong>Non produce direttamente:</strong> moltiplica tutte le miniere del pianeta di <strong>+25% per livello</strong> ' +
        '(lvl 1 → ×1.25, lvl 3 → ×1.75). Upkeep 3 en/I.</p>' +
        '<p><strong>Quando costruirla:</strong> almeno 2-3 miniere già operative, altrimenti il guadagno assoluto è basso ' +
        'rispetto all\'upkeep. Esempio: 3 miniere lvl 1 = 12 met/I → con fonderia lvl 1 = 15 met/I.</p>' +
        '<p><strong>Prerequisito:</strong> almeno una miniera già costruita sul pianeta.</p>'
    },
    {
      id: 'struct:raffineria', tag: 'M04 · ⚛', title: 'Raffineria energetica',
      body:
        '<p><strong>Effetto doppio:</strong> produce 2 en/I diretti <em>e</em> moltiplica tutte le centrali del pianeta di ' +
        '<strong>+20% per livello</strong>. Upkeep 2 acqua/I (attenzione alla concatenazione idrica).</p>' +
        '<p><strong>Quando costruirla:</strong> dopo aver tappato il fabbisogno idrico — altrimenti il consumo extra di acqua ' +
        'può sbilanciare le fattorie.</p>' +
        '<p><strong>Prerequisito:</strong> almeno una centrale solare già costruita.</p>'
    },
    {
      id: 'struct:laboratorio', tag: 'M04 · ⌬', title: 'Laboratorio',
      body:
        '<p>Produce <strong>ricerca</strong> distribuita: 3/I a livello 1. Upkeep 2 en/I.</p>' +
        '<p><strong>Gancio M13:</strong> oggi i punti ricerca si accumulano ma l\'albero tecnologico vero arriverà col modulo M13. ' +
        'Costruire laboratori adesso è un investimento — quando M13 sarà attivo, i tech che richiedono <code>tech:&lt;id&gt;</code> si sbloccheranno.</p>' +
        '<p><strong>Pista vittoria:</strong> contribuisce all\'<em>Ascensione tech</em> (#23).</p>'
    },
    {
      id: 'struct:osservatorio', tag: 'M04 · ◎', title: 'Osservatorio planetario',
      body:
        '<p>Scansiona il corpo per <strong>rivelare le identità delle risorse avanzate §7.2</strong> (cristalli, esotici, biomassa, ' +
        'gas nobili, dati, reliquie). Visibile il numero da subito; identità mascherate fino a fine scansione.</p>' +
        '<p><strong>Timeline:</strong> 14 I per costruirlo + ~10 I di scansione effettiva. Livello 2 dimezza il tempo di scansione.</p>' +
        '<p><strong>Prerequisito implicito</strong> per l\'<em>Impianto esotico</em>: senza scansione completata non si conosce ' +
        'la risorsa rara da sfruttare.</p>'
    },
    {
      id: 'struct:cantiere-navale', tag: 'M04 · ⬢', title: 'Hangar stellare',
      body:
        '<p><strong>Gancio M08+:</strong> serve a costruire astronavi, grandi astronavi e stazioni. Oggi non produce nulla di visibile, ' +
        'ma <strong>occupa 2 slot</strong> (struttura grossa) e ha upkeep alto (4 en + 1 met/I).</p>' +
        '<p><strong>Pianificazione:</strong> non costruirlo sul pianeta natale se hai solo 7-8 slot — meglio dedicarlo ' +
        'a una colonia "militare" specializzata quando arriverà M08.</p>' +
        '<p><strong>Concatenazione:</strong> l\'<em>Accademia militare</em> (M14) e questa formano insieme il polo militare.</p>'
    },
    {
      id: 'struct:accademia-militare', tag: 'M04 · ⚔', title: 'Accademia militare',
      body:
        '<p><strong>Gancio M14:</strong> forma quadri militari, ufficiali e veterani (figure speciali). Oggi nessun effetto visibile. ' +
        'Upkeep moderato (2 en + 1 food/I).</p>' +
        '<p><strong>Sinergia futura:</strong> con l\'<em>Hangar stellare</em> alimenta una colonia a vocazione militare. ' +
        'In partite a vocazione <em>Tiranno</em> (#23) sarà struttura-chiave.</p>'
    },
    {
      id: 'struct:centro-abitativo', tag: 'M04 · ⌂', title: 'Centro abitativo',
      body:
        '<p>Aumenta la <strong>capacità di popolazione (popCap)</strong> di +2 per livello e dà <strong>+0.05 morale</strong> ' +
        '(cap 1.35, il pianeta base parte già a 1.15). Upkeep 1 en + 1 food + 1 water /I.</p>' +
        '<p><strong>Morale:</strong> moltiplica la crescita pop §9.3 (base 0.018 unità/I × morale). Più centri → ' +
        'più tetto demografico e crescita più rapida, ma anche più consumi vitali.</p>' +
        '<p><strong>Concatenazione critica:</strong> ogni centro consuma cibo + acqua. Non costruire centri se le filiere ' +
        'cibo/acqua non sono solide.</p>'
    },
    {
      id: 'struct:ospedale', tag: 'M04 · ✚', title: 'Ospedale',
      body:
        '<p><strong>Accelera la crescita pop</strong>: ×1.6 (cioè +60%) sulla velocità base di 0.018 unità/I × morale.</p>' +
        '<p><strong>Esempio concreto:</strong> da popCap 3 a popCap 15 senza ospedale ≈ 500 I (5 Orbite); con ospedale ≈ 310 I. ' +
        'Conviene se prevedi tante abitazioni.</p>' +
        '<p><strong>Non protegge dalla carenza vitale:</strong> se cibo o acqua restano a zero per 30 I, la pop cala comunque ' +
        '(1 unità ogni 30 I, recovery-friendly).</p>'
    },
    {
      id: 'struct:mercato', tag: 'M04 · ⇄', title: 'Mercato',
      body:
        '<p><strong>Gancio M12:</strong> hub per le rotte commerciali interne all\'impero e per le <em>valute regionali</em> ' +
        'previste in §13 (decisione #13 — ogni regione ha una sua moneta a tema).</p>' +
        '<p>Oggi non produce nulla visibile. Costruirlo è un investimento per quando M12 attiverà gli scambi tra colonie ' +
        '(produzione specializzata + trasferimento risorse).</p>' +
        '<p><strong>Pista vittoria:</strong> contribuirà all\'<em>Egemone economico</em> (#23).</p>'
    },
    {
      id: 'struct:impianto-esotico', tag: 'M04 · ✦', title: 'Impianto esotico',
      body:
        '<p>Struttura <strong>avanzata</strong>: sfrutta una risorsa avanzata §7.2 per dare <strong>moltiplicatori globali</strong> ' +
        'a tutta la civiltà (effetto cumulativo tra colonie). Upkeep 5 en/I, occupa 2 slot.</p>' +
        '<p><strong>Doppio prerequisito:</strong> (1) <em>scansione completata</em> sul pianeta (osservatorio), ' +
        '(2) tech <code>tech:esotici</code> sbloccato (gancio M13 — oggi resta locked).</p>' +
        '<p><strong>Pista vittoria:</strong> chiave per l\'<em>Ascensione tech</em>; è la struttura più "endgame" del catalogo M04.</p>'
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
          '<button class="btn btn--mini tutorial-card__close" data-action="tut-close" type="button" aria-label="Chiudi">✕</button>' +
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
    const rows = LESSONS.map(function (l) {
      const seen = isSeen(game, l.id);
      return '<button class="tutorial-index__row" data-tut-id="' + l.id + '" type="button">' +
        '<span class="tutorial-index__tag">' + escapeText(l.tag) + '</span>' +
        '<span class="tutorial-index__title">' + escapeText(l.title) + '</span>' +
        '<span class="tutorial-index__state ' + (seen ? 'is-seen' : 'is-unseen') + '">' +
          (seen ? '✓ vista' : '◌ nuova') +
        '</span>' +
      '</button>';
    }).join('');
    host.innerHTML =
      '<div class="tutorial-card tutorial-card--index" role="document">' +
        '<header class="tutorial-card__head">' +
          '<span class="tutorial-card__tag">M06.6</span>' +
          '<h2 class="tutorial-card__title">Tutorial — indice</h2>' +
          '<button class="btn btn--mini tutorial-card__close" data-action="tut-close" type="button" aria-label="Chiudi">✕</button>' +
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
