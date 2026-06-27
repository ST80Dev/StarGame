/* =====================================================================
   ORION EMPIRES — structures.js
   Modulo M04: catalogo strutture (GDD §10).

   Decisione #14: catalogo "medio" — 2-3 strutture per categoria,
   ~14 totali, sufficienti a dare scelte significative senza anticipare
   l'albero tecnologico (M13) o le navi/stazioni (M08/M15/M16).

   Ogni struttura ha:
     - id, name, cat, glyph, desc
     - cost {met,en,food,water,...}   risorse base (§7.1)
     - time  durata di costruzione in Impulsi (§4.4)
     - upkeep {en, ...}                consumo per Impulso
     - rates  produzione per Impulso (lettura M05; in M04 sono "potenziali")
     - slots  ingombro slot di costruzione (di solito 1)
     - bodyTypes? tipi su cui è costruibile (default: tutti gli abitabili)
     - requires?  prerequisiti — array di stringhe-gancio:
                  'tech:<id>'  → albero tech vero (M13, qui solo marker)
                  'struct:<id>:<lvl>' → altra struttura del pianeta
                  'scan'       → struttura di scansione attiva (per avanzate)
     - tag?  'orbital' per impianti su gassosi/cinture (non abitabili)
     - maxLevel  cap (default 3, espandibile con tech in M13)
     - hooks  {fleet, research, trade, ...} per moduli futuri (solo marker)

   NB: la produzione effettiva e i timer girano in M05. In M04 il catalogo
   serve a popolare la scheda costruzioni e a calcolare i potenziali del
   pianeta a riposo.
   ===================================================================== */
'use strict';

(function (root) {
  /* Tipi di corpo abitabili (per filtrare le strutture costruibili). */
  const HABITABLE = ['terrestre', 'desertico', 'oceanico', 'ghiacciato', 'vulcanico', 'forestale', 'luna'];
  const ORBITAL  = ['gassoso', 'cintura'];   // non abitabili: solo estrazione orbitale (§6.3)

  const CATEGORIES = {
    estrattiva: { label: 'Estrattive', glyph: '⛏' },
    produttiva: { label: 'Produttive', glyph: '⚙' },
    ricerca:    { label: 'Ricerca',    glyph: '⌬' },
    militare:   { label: 'Militari',   glyph: '⚔' },
    civile:     { label: 'Civili',     glyph: '⌂' },
    avanzata:   { label: 'Avanzate',   glyph: '✦' }
  };

  /* ------------------------------------------------------------------
     Catalogo strutture. I numeri sono base level-1 (livelli successivi
     scalano ×(1 + 0.6·(lvl-1)) — applicato dal calcolo dei potenziali).
     ------------------------------------------------------------------ */
  const STRUCTURES = [
    // ===== Estrattive (4) — una per risorsa base (§7.1) =====
    {
      id: 'miniera', name: 'Miniera', cat: 'estrattiva', glyph: '⛏',
      desc: 'Estrae metalli dal sottosuolo o dagli asteroidi.',
      cost: { met: 40, en: 10 }, time: 10,
      /* Bilanciamento 2026-06-27: rimosso upkeep en (era 1). Gli estrattori
         base (miniera/idrico/fattoria) non drenano più energia: era la causa
         del cold-lock energetico early sui mondi a basso pot.en (con una sola
         centrale il netto andava negativo → stock a 0 → impossibile pagare il
         costo en per fare/potenziare la centrale → stallo, contro #22). Le
         altre strutture (lab/hangar/housing/esotici…) mantengono l'upkeep en:
         l'energia resta una decisione vera, non un fail-state a freddo. Anche
         coerente con l'aumentato drain energetico delle flotte (viveri su
         stazza). Simulazione: rompe il lock su ogni mondo natale plausibile. */
      upkeep: {},
      rates: { met: 4 },
      slots: 1, maxLevel: 5,
      bodyTypes: HABITABLE.concat(ORBITAL)
    },
    {
      id: 'centrale-solare', name: 'Centrale solare', cat: 'estrattiva', glyph: '⚡',
      desc: 'Pannelli ad alta efficienza per catturare l\'irradianza stellare.',
      cost: { met: 35, en: 5 }, time: 9,
      upkeep: {},
      rates: { en: 6 },   // decisione #70: 8 → 6 (ritocco lieve). #48 l'aveva alzato a 8 per coprire un deficit con flotta+esplorazione; i tagli di upkeep #48 (lab/ospedale/accademia/hangar) restano, quindi 6 non riapre quel deficit sui mondi medi ma rende l'energia una decisione vera sui mondi poveri (pot.en basso).
      slots: 1, maxLevel: 5,
      bodyTypes: HABITABLE.concat(['gassoso'])
    },
    {
      id: 'impianto-idrico', name: 'Impianto idrico', cat: 'estrattiva', glyph: '≈',
      desc: 'Pozzi, distillatori atmosferici o estrazione da ghiacci.',
      cost: { met: 30, en: 12 }, time: 10,
      upkeep: {},   // 2026-06-27: rimosso upkeep en (vedi miniera) — fix cold-lock energia early
      rates: { water: 4 },
      slots: 1, maxLevel: 5,
      bodyTypes: HABITABLE
    },
    {
      id: 'fattoria', name: 'Fattoria idroponica', cat: 'estrattiva', glyph: '❖',
      desc: 'Cicli chiusi di coltura adattati alla biochimica locale.',
      cost: { met: 25, en: 10, water: 5 }, time: 9,
      upkeep: { water: 1 },   // 2026-06-27: rimosso upkeep en (vedi miniera); resta l'acqua di processo
      rates: { food: 4 },
      slots: 1, maxLevel: 5,
      bodyTypes: HABITABLE
    },

    // ===== Produttive (2) =====
    {
      id: 'fonderia', name: 'Fonderia', cat: 'produttiva', glyph: '🜂',
      desc: 'Raffina i metalli grezzi: aumenta la resa delle miniere del 40% per livello.',
      cost: { met: 90, en: 35 }, time: 16,
      upkeep: { en: 3, met: 1 },   // +met: manutenzione macchinari (2026-06-11)
      rates: {},   // moltiplicatore, non produzione diretta
      modifiers: { 'miniera.rates.met': 0.40 },
      slots: 1, maxLevel: 3,
      bodyTypes: HABITABLE,
      requires: ['struct:miniera:1']
    },
    {
      id: 'raffineria', name: 'Raffineria energetica', cat: 'produttiva', glyph: '⚛',
      desc: 'Sintetizza vettori energetici di alta qualità da risorse locali.',
      cost: { met: 85, en: 30 }, time: 16,
      upkeep: { water: 2, met: 1 },   // +met manutenzione (2026-06-11)
      rates: { en: 2 },
      /* Bilanciamento 2026-06-16 (sessione capitale endgame): la raffineria
         restava troppo prolifica accoppiata alla centrale-solare a maxL,
         portando una capitale matura a +50 en/Ι di surplus. 0.40 → 0.25
         per spingere l'autosufficienza energetica sotto break-even a pop 10+,
         in linea con il design "import via rotte". La fonderia resta a 0.40
         (i metalli sono già drenati da maintMet di flotta). */
      modifiers: { 'centrale-solare.rates.en': 0.25 },
      slots: 1, maxLevel: 3,
      bodyTypes: HABITABLE,
      requires: ['struct:centrale-solare:1']
    },

    // ===== Ricerca (2) =====
    {
      id: 'laboratorio', name: 'Laboratorio', cat: 'ricerca', glyph: '⌬',
      desc: 'Contribuisce alla ricerca distribuita della civiltà.',
      cost: { met: 80, en: 30 }, time: 14,
      upkeep: { en: 2, met: 1 },   // bilanciamento 2026-06-16: +1 en (era 1, ora 2)
      rates: { research: 0.5 },   // pacing M13 (2026-06-13, #87): 3→0.5, la ricerca avanzata è un traguardo d'impero (spinge a colonizzare + costruire più lab)
      slots: 1, maxLevel: 4,
      bodyTypes: HABITABLE,
      hooks: ['research']         // gancio M13
    },
    {
      id: 'osservatorio', name: 'Osservatorio planetario', cat: 'ricerca', glyph: '◎',
      desc: 'Scansiona suolo, atmosfera e sottosuolo: rivela le risorse avanzate parzialmente nascoste.',
      cost: { met: 70, en: 35 }, time: 14,
      upkeep: { en: 2 },
      rates: { scan: 1 },
      slots: 1, maxLevel: 2,
      bodyTypes: HABITABLE.concat(ORBITAL),
      hooks: ['scan']             // sblocca identità delle risorse avanzate (M05)
    },

    // ===== Militari (2) =====
    {
      id: 'cantiere-navale', name: 'Hangar di costruzione', cat: 'militare', glyph: '▱',
      desc: 'Necessario per costruire astronavi. Offre cantieri (build paralleli) e attracchi (porto a terra). Cresce coi livelli.',
      cost: { met: 60, en: 25 }, time: 30,
      /* Bilanciamento 2026-06-27: L1 ABBASSATO 95→60 met, 40→25 en, time 50→30,
         upkeep 4 en/2 met → 3 en/1 met. Motivazione: l'early game era bloccato
         per ~300I sulle sole strutture militari, rendendo impossibile costruire
         pioniere+intercettore prima del mid. Per non sgonfiare anche i livelli
         alti, lo scaling per livello passa a L^1.3 (vedi EARLY_TIER_IDS in
         stepCost): L5 finisce ≈486 met (era 475), L2-L4 leggermente più morbidi.
         Bilanciamento 2026-06-16: hangar ABBASSATO 120→95 (sblocco esplorazione
         più rapido nell'early); upkeep en 3→4 (carico militare al porto). */
      upkeep: { en: 3, met: 1 },   // 2026-06-27: 4→3 en, 2→1 met (early relief)
      rates: {},
      slots: 2, maxLevel: 5,
      bodyTypes: HABITABLE,
      /* Decisione #41: capacità a doppia funzione.
         - buildSlots[L-1] = navi costruibili in parallelo a quel livello
         - docks[L-1]      = posti d'attracco a terra (porto planetario)
         Sono cumulativi sulla colonia (più Hangar = somma capacità).
         I porti stellari in orbita (M16) daranno cap molto più ampia. */
      hangarCapacity: {
        buildSlots: [2, 3, 4, 5, 7],
        docks:      [4, 8, 13, 18, 25]
      },
      hooks: ['fleet']            // gancio M08/M15
    },
    {
      id: 'accademia-militare', name: 'Accademia militare', cat: 'militare', glyph: '⚔',
      desc: 'Forma quadri militari e veterani (figure speciali, M14).',
      cost: { met: 50, en: 20, food: 8 }, time: 14,
      /* Bilanciamento 2026-06-27: L1 ABBASSATO 90→50 met, 45→20 en, 15→8 food,
         time 22→14. Stesso intento dell'Hangar (vedi sopra): early game troppo
         caro per arrivare al primo equipaggio. Scaling L^1.3 (EARLY_TIER_IDS)
         tiene morbida la curva fino a L5 (≈405 met vs vecchio 450). */
      upkeep: { en: 1, food: 1 },   // decisione #48: 2 → 1
      rates: {},
      slots: 1, maxLevel: 5,
      bodyTypes: HABITABLE,
      /* Decisione utente 2026-06-11: l'Accademia limita gli equipaggi in
         ADDESTRAMENTO CONTEMPORANEO in base al suo livello (specchio dei
         cantieri Hangar #41, ma legato all'Accademia). trainingSlots[L-1]
         = equipaggi formabili in parallelo a quel livello. */
      trainingSlots: [1, 2, 3, 4, 5],
      hooks: ['characters']       // gancio M14
    },
    /* Decisione #49 (M09 Fase A): difese planetarie. Occupano gli slot
       riservati dal dimensionamento BASE_SLOTS (#38/#45). Combattono quando
       il sistema della colonia è teatro di una battaglia: ogni modulo
       sintetizza un combattente difensivo (vedi combat.forceFromDefenses).
       I campi `defense`/`defenseFp`/`defenseHp` sono letti dal motore di
       combattimento; il danno in battaglia riduce `hp` della struttura
       (riparabile nel tempo, §10.2). */
    {
      id: 'batteria-difesa', name: 'Batteria di difesa', cat: 'militare', glyph: '⊕',
      desc: 'Torrette orbitali e cannoni planetari. Difende il sistema della colonia in battaglia. Cresce coi livelli (più moduli = più fuoco e corazza).',
      cost: { met: 100, en: 35 }, time: 18,
      upkeep: { en: 3, met: 1 },   // bilanciamento 2026-06-16: en 2→3
      rates: {},
      slots: 1, maxLevel: 5,
      bodyTypes: HABITABLE.concat(ORBITAL),
      defense: true,
      defenseFp: 8,             // potenza di fuoco per modulo (× moduleSum)
      defenseHp: 60             // corazza per modulo (× moduleSum)
    },
    {
      id: 'scudo-planetario', name: 'Scudo planetario', cat: 'militare', glyph: '◈',
      desc: 'Schermo deflettore ad alta energia: aggiunge corazza pura alla difesa del sistema. Richiede tecnologia degli scudi (M13).',
      /* Bilanciamento 2026-06-16: T3 ×2.7 sul costo base + upkeep en +50%
         (era +6, ora +9). Lo scaling per livello passa a L^1.4 (vedi stepCost). */
      cost: { met: 380, en: 240, water: 60 }, time: 40,
      upkeep: { en: 9, met: 1 },   // bilanciamento 2026-06-16: en 6→9
      rates: {},
      slots: 2, maxLevel: 2,
      bodyTypes: HABITABLE,
      requires: ['tech:scudi'],   // gancio M13
      defense: true,
      defenseFp: 2,             // lo scudo spara poco: è soprattutto corazza
      defenseHp: 90
    },

    // ===== Civili (4 — decisione #48 aggiunge l'impianto di riciclo) =====
    {
      id: 'centro-abitativo', name: 'Centro abitativo', cat: 'civile', glyph: '⌂',
      desc: 'Aumenta la capacità di popolazione e il morale.',
      cost: { met: 40, en: 10, water: 5 }, time: 10,
      /* Decisione #45: rimossa upkeep food dal centro abitativo — è housing,
         non logistica alimentare. Il cibo lo consuma la popolazione stessa
         (drenaggio reale sullo stock, processProduction in time.js). */
      upkeep: { en: 1, water: 1 },
      rates: {},                 // l'effetto vive nel gate sovraffollamento (§9.3)
      slots: 1, maxLevel: 5,
      bodyTypes: HABITABLE
    },
    {
      id: 'ospedale', name: 'Ospedale', cat: 'civile', glyph: '✚',
      desc: 'Accelera la crescita della popolazione e ne migliora la qualità.',
      cost: { met: 70, en: 30, food: 8 }, time: 14,
      upkeep: { en: 1, food: 1 },   // decisione #48: 2 → 1
      rates: { popGrowth: 0.2 },
      slots: 1, maxLevel: 3,
      bodyTypes: HABITABLE
    },
    {
      id: 'mercato', name: 'Mercato', cat: 'civile', glyph: '⇄',
      desc: 'Hub commerciale per le rotte interne. Ogni livello aggiunge rotte simultanee e throughput/Ι (M12 §15.2).',
      cost: { met: 65, en: 20 }, time: 12,
      upkeep: { en: 1 },
      rates: {},
      slots: 1, maxLevel: 5,
      bodyTypes: HABITABLE,
      hooks: ['trade'],           // gancio M12
      /* M12 Fase A1 (decisione #53, §15.2): capacità commerciale per
         livello. Sommata sui Mercati di tutte le colonie del giocatore.
         tradeRoutes = rotte simultanee, tradeThroughput = unità/Ι totali. */
      tradeRoutes: [2, 3, 4, 5, 7],
      tradeThroughput: [8, 12, 18, 26, 36]
    },
    /* Decisione #48 (Fase 0 — gestione rifiuti): popolazione e industria
       generano rifiuti continui; l'impianto di riciclo li tratta recuperando
       energia e alzando la capacità di contenimento → abbatte la saturazione
       (e quindi il "deperimento" graduale della produzione). I campi
       `wasteProcess` (rifiuti trattati per modulo/Ι) e `wasteCapacity`
       (contenimento aggiunto per modulo) sono letti da time.js → processWaste.
       Costruibile anche su corpi orbitali: gancio per le "colonie riciclanti"
       su mondi ostili (Fase 1, quando M13 sbloccherà le tech dedicate). */
    {
      id: 'impianto-riciclo', name: 'Impianto di riciclo', cat: 'civile', glyph: '♻',
      desc: 'Tratta i rifiuti prodotti da popolazione e industria, recuperandone energia. Si autoalimenta col rifiuto (nessun upkeep). Un solo impianto regge una grande colonia.',
      cost: { met: 65, en: 20 }, time: 12,
      /* Decisione #48 (retune): nessun upkeep energia — l'impianto è
         alimentato dal rifiuto che brucia (waste-to-energy). Così smaltire
         non litiga col budget energetico. */
      upkeep: {},
      rates: {},
      slots: 1, maxLevel: 5,
      bodyTypes: HABITABLE.concat(ORBITAL),
      wasteProcess: 12,       // rifiuti trattati per modulo / Ι (→ energia) — un lvl1 regge lo stress max con margine
      wasteCapacity: 300      // contenimento aggiunto per modulo
    },

    // ===== Avanzate (3 — decisione #45 aggiunge bonifica + terraformazione) =====
    {
      id: 'impianto-esotico', name: 'Impianto esotico', cat: 'avanzata', glyph: '✦',
      desc: 'Sfrutta risorse avanzate per moltiplicatori globali. Richiede una risorsa rara identificata sul pianeta.',
      cost: { met: 180, en: 95, water: 15 }, time: 40,
      upkeep: { en: 8, met: 2 },   // bilanciamento 2026-06-16: en 5→8, met 1→2
      rates: { exotic: 1 },
      slots: 2, maxLevel: 2,
      bodyTypes: HABITABLE.concat(ORBITAL),
      requires: ['scan', 'tech:esotici']   // gancio M13
    },
    /* Decisione #45: 2 strutture tech-gated che ESPANDONO la capacità di
       costruzione del pianeta. Il bonus slot vive nel campo `expandsSlots`
       (mappa per tipo corpo), letto da planet.effectiveSlots(). */
    {
      id: 'centro-ingegneria-planetaria', name: 'Centro di ingegneria planetaria', cat: 'avanzata', glyph: '⛭',
      desc: 'Bonifica territoriale: recupera terreno edificabile dalle aree marginali del pianeta. Espande la capacità di costruzione (slot).',
      cost: { met: 520, en: 230, water: 90 }, time: 50,
      upkeep: { en: 6, met: 3 },   // bilanciamento 2026-06-16: en 4→6, met 2→3
      rates: {},
      slots: 2, maxLevel: 1,
      bodyTypes: HABITABLE.concat(ORBITAL),
      requires: ['tech:bonifica-territoriale'],   // gancio M13
      /* Espansione slot per tipo corpo (decisione #45):
         - giardino (terrestre/oceanico/forestale): +8 slot
         - mondo-fabbrica (desertico/vulcanico/ghiacciato): +5
         - piccolo (luna/gassoso/cintura): +3 */
      expandsSlots: { terrestre: 8, oceanico: 8, forestale: 8,
                      desertico: 5, vulcanico: 5, ghiacciato: 5,
                      luna: 3, gassoso: 3, cintura: 3 }
    },
    {
      id: 'terraformatori', name: 'Terraformatori', cat: 'avanzata', glyph: '✦',
      desc: 'Trasforma il pianeta su scala continentale: nuovi biomi, nuovi spazi insediabili. Solo su corpi abitabili o industriali.',
      cost: { met: 800, en: 450, water: 150, food: 50 }, time: 90,
      upkeep: { en: 12, water: 2, met: 3 },   // bilanciamento 2026-06-16: en 8→12, met 2→3
      rates: {},
      slots: 3, maxLevel: 1,
      bodyTypes: ['terrestre', 'oceanico', 'forestale', 'desertico', 'vulcanico', 'ghiacciato'],
      requires: ['tech:terraformazione', 'struct:centro-ingegneria-planetaria:1'],
      expandsSlots: { terrestre: 12, oceanico: 12, forestale: 12,
                      desertico: 7, vulcanico: 7, ghiacciato: 7 }
    },
    /* M15 — Bacino di costruzione (decisione #41): cantiere pesante PLANETARIO
       per le navi grandi. L'Hangar (#41) basta per l'Incrociatore (lvl 4),
       ma Dreadnought e Nave Ammiraglia richiedono questa infrastruttura
       dedicata. Aggiunge cantieri (slip) e attracchi di grossa stazza,
       SOMMATI a quelli dell'Hangar in expedition.js. lvl 1 → Dreadnought,
       lvl 2 → Ammiraglia. Richiede un Hangar già evoluto (lvl 3).
       NB (rinomina 2026-06-18): era "Bacino orbitale" — è a terra, non in
       orbita; l'id resta `bacino-orbitale` per compatibilità save. La
       costruzione orbitale leggera/media vive sulla Stazione (M16). */
    {
      id: 'bacino-orbitale', name: 'Bacino di costruzione', cat: 'militare', glyph: '⊠',
      desc: 'Cantiere pesante per le navi grandi. lvl 1 sblocca il Dreadnought, lvl 2 la Nave Ammiraglia. Aggiunge cantieri e attracchi di grossa stazza.',
      cost: { met: 1300, en: 580, food: 80 }, time: 120,
      upkeep: { en: 9, met: 5 },   // bilanciamento 2026-06-16: en 6→9, met 3→5
      rates: {},
      slots: 4, maxLevel: 2,
      bodyTypes: HABITABLE,
      requires: ['struct:cantiere-navale:3'],   // serve un Hangar già evoluto
      /* Capacità aggiuntiva (#41): sommata a cantiere-navale.hangarCapacity
         in expedition.js. Le navi capitali pesano molto (dockWeight) → questi
         attracchi servono a contenerle senza saturare l'Hangar leggero. */
      hangarCapacity: {
        buildSlots: [1, 2],     // slip capitali (lente: 1-2 in parallelo)
        docks:      [12, 24]    // attracchi pesati
      },
      hooks: ['fleet']          // gancio M15/M16
    },
    /* M16 — Porto orbitale (decisione utente 2026-06-18): scalo orbitale che
       APPARTIENE alla colonia. NON costruisce navi: aggiunge solo posti
       d'attracco (surplus, SOMMATO a Hangar+Bacino in expedition.js) per
       ricoverare le flotte di casa oltre la capienza a terra. Le navi
       attraccate qui si riforniscono e riparano come a un porto di colonia
       (sono nel sistema della colonia). È il gemello "domestico" della
       Stazione: il Porto è legato a un pianeta, la Stazione è indipendente. */
    {
      id: 'porto-orbitale', name: 'Porto orbitale', cat: 'militare', glyph: '⚓',
      desc: 'Scalo orbitale della colonia. Aggiunge posti d\'attracco per le flotte (oltre Hangar e Bacino) e le rifornisce/ripara. Non costruisce navi.',
      cost: { met: 240, en: 110 }, time: 45,
      upkeep: { en: 3, met: 1 },
      rates: {},
      slots: 2, maxLevel: 5,
      bodyTypes: HABITABLE,
      requires: ['struct:cantiere-navale:2'],   // serve un Hangar già avviato
      /* Solo attracchi (niente buildSlots): il Porto non costruisce. Sommati
         agli attracchi di Hangar+Bacino in expedition.js (portoCap). */
      hangarCapacity: {
        docks: [8, 14, 22, 32, 44]
      },
      hooks: ['fleet']
    }
  ];

  /* Lookup per id. */
  const BY_ID = {};
  for (let i = 0; i < STRUCTURES.length; i++) BY_ID[STRUCTURES[i].id] = STRUCTURES[i];

  function get(id) { return BY_ID[id] || null; }
  function buildableOn(bodyType) {
    return STRUCTURES.filter(function (s) {
      const types = s.bodyTypes || HABITABLE;
      return types.indexOf(bodyType) >= 0;
    });
  }

  /* Modello "moduli a rendimento crescente" (decisione #38).
     Livello L = L moduli = L slot. La PRODUZIONE totale è la somma di L
     moduli, ognuno un po' più produttivo del precedente (rendimento
     crescente): modulo i = base·(1 + GAIN·(i−1)).
       moduleSum(L) = Σ_{i=1..L} (1 + GAIN·(i−1)) = L + GAIN·L·(L−1)/2
     Es. (GAIN 0.22): L1=1.0 · L2=2.2 · L3=3.66 · L4=5.32 · L5=7.2
     L'UPKEEP invece scala LINEARMENTE (ogni modulo consuma uguale) → l'output
     per slot sale, ma il costo cresce (vedi stepCost). */
  const GAIN = 0.22;
  function moduleSum(level) {
    const L = Math.max(1, level || 1);
    return L + GAIN * L * (L - 1) / 2;
  }
  /* Footprint slot di una struttura a un dato livello = slot-base × livello. */
  function slotFootprint(def, level) {
    return (def && def.slots ? def.slots : 1) * Math.max(1, level || 1);
  }

  /* Costo/tempo del modulo che porta AL livello L (decisione #38: escalano).
     Costo ×L (freno forte sul "tall"); tempo più dolce (×1 + 0.3·(L−1)).
     Bilanciamento 2026-06-16: le strutture TIER 3 (avanzate strategiche) usano
     una scala più ripida L^1.4 per rendere i salti di livello davvero costosi
     in end-game (scudo L2, esotico L2, bacino L2). Tutte le altre restano
     lineari.
     Bilanciamento 2026-06-27: gli edifici militari "early gate" (Hangar e
     Accademia) usano L^1.3 per il costo. Il loro L1 è stato abbassato di
     ~37/44% per sbloccare la prima flotta nell'early; lo scaling più ripido
     mantiene i livelli alti vicini ai valori storici (L5 Hangar ≈486 met vs
     475 storici). Il tempo resta lineare sulla nuova base più bassa → tempi
     ridotti su tutta la curva, coerente con lo scopo "militare giocabile". */
  const ADVANCED_TIER_IDS = ['scudo-planetario', 'centro-ingegneria-planetaria',
    'terraformatori', 'bacino-orbitale', 'impianto-esotico'];
  const EARLY_TIER_IDS = ['cantiere-navale', 'accademia-militare'];
  function scaleCost(cost, factor) {
    const out = {};
    Object.keys(cost || {}).forEach(function (k) { out[k] = Math.round(cost[k] * factor); });
    return out;
  }
  function stepCost(def, toLevel) {
    const L = Math.max(1, toLevel || 1);
    let factor;
    if (def && ADVANCED_TIER_IDS.indexOf(def.id) >= 0) factor = Math.pow(L, 1.4);
    else if (def && EARLY_TIER_IDS.indexOf(def.id) >= 0) factor = Math.pow(L, 1.3);
    else factor = L;
    return scaleCost(def.cost || {}, factor);
  }
  function stepTime(def, toLevel) {
    const L = Math.max(1, toLevel || 1);
    return Math.round((def.time || 1) * (1 + 0.3 * (L - 1)));
  }

  root.ORION = root.ORION || {};
  root.ORION.structures = {
    CATEGORIES: CATEGORIES,
    STRUCTURES: STRUCTURES,
    GAIN: GAIN,
    get: get,
    buildableOn: buildableOn,
    moduleSum: moduleSum,
    slotFootprint: slotFootprint,
    stepCost: stepCost,
    stepTime: stepTime,
    HABITABLE: HABITABLE,
    ORBITAL: ORBITAL
  };
})(typeof window !== 'undefined' ? window : this);
