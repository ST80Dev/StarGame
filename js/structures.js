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
      upkeep: { en: 1 },
      rates: { met: 4 },
      slots: 1, maxLevel: 5,
      bodyTypes: HABITABLE.concat(ORBITAL)
    },
    {
      id: 'centrale-solare', name: 'Centrale solare', cat: 'estrattiva', glyph: '⚡',
      desc: 'Pannelli ad alta efficienza per catturare l\'irradianza stellare.',
      cost: { met: 35, en: 5 }, time: 9,
      upkeep: {},
      rates: { en: 6 },
      slots: 1, maxLevel: 5,
      bodyTypes: HABITABLE.concat(['gassoso'])
    },
    {
      id: 'impianto-idrico', name: 'Impianto idrico', cat: 'estrattiva', glyph: '≈',
      desc: 'Pozzi, distillatori atmosferici o estrazione da ghiacci.',
      cost: { met: 30, en: 12 }, time: 10,
      upkeep: { en: 1 },
      rates: { water: 4 },
      slots: 1, maxLevel: 5,
      bodyTypes: HABITABLE
    },
    {
      id: 'fattoria', name: 'Fattoria idroponica', cat: 'estrattiva', glyph: '❖',
      desc: 'Cicli chiusi di coltura adattati alla biochimica locale.',
      cost: { met: 25, en: 10, water: 5 }, time: 9,
      upkeep: { en: 1, water: 1 },
      rates: { food: 4 },
      slots: 1, maxLevel: 5,
      bodyTypes: HABITABLE
    },

    // ===== Produttive (2) =====
    {
      id: 'fonderia', name: 'Fonderia', cat: 'produttiva', glyph: '🜂',
      desc: 'Raffina i metalli grezzi: aumenta la resa delle miniere del 40% per livello.',
      cost: { met: 70, en: 25 }, time: 16,
      upkeep: { en: 3 },
      rates: {},   // moltiplicatore, non produzione diretta
      modifiers: { 'miniera.rates.met': 0.40 },
      slots: 1, maxLevel: 3,
      bodyTypes: HABITABLE,
      requires: ['struct:miniera:1']
    },
    {
      id: 'raffineria', name: 'Raffineria energetica', cat: 'produttiva', glyph: '⚛',
      desc: 'Sintetizza vettori energetici di alta qualità da risorse locali.',
      cost: { met: 65, en: 20 }, time: 16,
      upkeep: { water: 2 },
      rates: { en: 2 },
      modifiers: { 'centrale-solare.rates.en': 0.40 },
      slots: 1, maxLevel: 3,
      bodyTypes: HABITABLE,
      requires: ['struct:centrale-solare:1']
    },

    // ===== Ricerca (2) =====
    {
      id: 'laboratorio', name: 'Laboratorio', cat: 'ricerca', glyph: '⌬',
      desc: 'Contribuisce alla ricerca distribuita della civiltà.',
      cost: { met: 60, en: 20 }, time: 14,
      upkeep: { en: 2 },
      rates: { research: 3 },
      slots: 1, maxLevel: 4,
      bodyTypes: HABITABLE,
      hooks: ['research']         // gancio M13
    },
    {
      id: 'osservatorio', name: 'Osservatorio planetario', cat: 'ricerca', glyph: '◎',
      desc: 'Scansiona suolo, atmosfera e sottosuolo: rivela le risorse avanzate parzialmente nascoste.',
      cost: { met: 55, en: 25 }, time: 14,
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
      cost: { met: 120, en: 40 }, time: 50,
      upkeep: { en: 4, met: 1 },
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
      cost: { met: 60, en: 30, food: 10 }, time: 22,
      upkeep: { en: 2, food: 1 },
      rates: {},
      slots: 1, maxLevel: 2,
      bodyTypes: HABITABLE,
      hooks: ['characters']       // gancio M14
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
      cost: { met: 55, en: 20, food: 5 }, time: 14,
      upkeep: { en: 2, food: 1 },
      rates: { popGrowth: 0.2 },
      slots: 1, maxLevel: 3,
      bodyTypes: HABITABLE
    },
    {
      id: 'mercato', name: 'Mercato', cat: 'civile', glyph: '⇄',
      desc: 'Hub commerciale per le rotte interne. Funzione piena nel modulo commercio (M12).',
      cost: { met: 50, en: 15 }, time: 12,
      upkeep: { en: 1 },
      rates: {},
      slots: 1, maxLevel: 2,
      bodyTypes: HABITABLE,
      hooks: ['trade']            // gancio M12
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
      desc: 'Tratta i rifiuti prodotti da popolazione e industria, recuperandone energia. Aumenta la capacità di contenimento e abbatte la saturazione.',
      cost: { met: 50, en: 15 }, time: 12,
      upkeep: { en: 1 },
      rates: {},
      slots: 1, maxLevel: 5,
      bodyTypes: HABITABLE.concat(ORBITAL),
      wasteProcess: 3,        // rifiuti trattati per modulo / Ι (→ energia)
      wasteCapacity: 150      // contenimento aggiunto per modulo
    },

    // ===== Avanzate (3 — decisione #45 aggiunge bonifica + terraformazione) =====
    {
      id: 'impianto-esotico', name: 'Impianto esotico', cat: 'avanzata', glyph: '✦',
      desc: 'Sfrutta risorse avanzate per moltiplicatori globali. Richiede una risorsa rara identificata sul pianeta.',
      cost: { met: 120, en: 60, water: 10 }, time: 40,
      upkeep: { en: 5 },
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
      cost: { met: 180, en: 80, water: 30 }, time: 50,
      upkeep: { en: 4 },
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
      cost: { met: 320, en: 180, water: 60, food: 20 }, time: 90,
      upkeep: { en: 8, water: 2 },
      rates: {},
      slots: 3, maxLevel: 1,
      bodyTypes: ['terrestre', 'oceanico', 'forestale', 'desertico', 'vulcanico', 'ghiacciato'],
      requires: ['tech:terraformazione', 'struct:centro-ingegneria-planetaria:1'],
      expandsSlots: { terrestre: 12, oceanico: 12, forestale: 12,
                      desertico: 7, vulcanico: 7, ghiacciato: 7 }
    }
  ];

  /* Lookup per id. */
  const BY_ID = {};
  for (let i = 0; i < STRUCTURES.length; i++) BY_ID[STRUCTURES[i].id] = STRUCTURES[i];

  function get(id) { return BY_ID[id] || null; }
  function byCategory(cat) { return STRUCTURES.filter(function (s) { return s.cat === cat; }); }
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
  /* Compat: vecchio nome usato altrove → ora resa cumulata dei moduli. */
  function levelScale(level) { return moduleSum(level); }

  /* Footprint slot di una struttura a un dato livello = slot-base × livello. */
  function slotFootprint(def, level) {
    return (def && def.slots ? def.slots : 1) * Math.max(1, level || 1);
  }

  /* Costo/tempo del modulo che porta AL livello L (decisione #38: escalano).
     Costo ×L (freno forte sul "tall"); tempo più dolce (×1 + 0.3·(L−1)). */
  function scaleCost(cost, factor) {
    const out = {};
    Object.keys(cost || {}).forEach(function (k) { out[k] = Math.round(cost[k] * factor); });
    return out;
  }
  function stepCost(def, toLevel) {
    return scaleCost(def.cost || {}, Math.max(1, toLevel || 1));
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
    byCategory: byCategory,
    buildableOn: buildableOn,
    levelScale: levelScale,
    moduleSum: moduleSum,
    slotFootprint: slotFootprint,
    stepCost: stepCost,
    stepTime: stepTime,
    HABITABLE: HABITABLE,
    ORBITAL: ORBITAL
  };
})(typeof window !== 'undefined' ? window : this);
