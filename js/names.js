/* =====================================================================
   ORION EMPIRES — names.js
   Modulo M02: generazione dei nomi dei sistemi stellari (GDD §5.2).

   Regola GDD: "Mix 40% reali / 60% inventati, distribuiti casualmente
   (no logica geografica)".

   - REALI: pool fisso di 20 stelle reali (§5.2). Poiché una galassia può
     avere fino a 120 sistemi e i nomi reali disponibili sono solo 20,
     quando il quota del 40% supera il pool i nomi reali eccedenti
     ricevono una designazione di catalogo (numerale romano: "Rigel II",
     "Vega III"), convenzione comune nei 4X. Decisione documentata in
     CLAUDE.md.
   - INVENTATI: generati proceduralmente in tre stili (latino/classico,
     aspro/alieno, poetico/misterioso) combinando banchi di sillabe che
     includono anche gli esempi del GDD. Unicità garantita.

   Tutto è deterministico: dipende solo dall'RNG (quindi dal seed).
   ===================================================================== */
'use strict';

(function (root) {
  /* --- Pool nomi reali (§5.2) --- */
  const REAL = [
    'Aldebaran', 'Vega', 'Altair', 'Deneb', 'Rigel', 'Betelgeuse', 'Antares',
    'Procyon', 'Fomalhaut', 'Achernar', 'Mimosa', 'Hadar', 'Elnath',
    'Zubenelgenubi', 'Canopus', 'Arcturus', 'Spica', 'Pollux', 'Regulus', 'Sirius'
  ];

  /* Numerali romani per le designazioni di catalogo dei reali eccedenti. */
  const ROMAN = ['II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

  /* --- Banchi di sillabe per i tre stili inventati (§5.2) --- */

  /* Latino/classico: Vorthan, Caelum, Nexaris, Valdris, Omneth... */
  const CLASSIC = {
    onset: ['V', 'C', 'N', 'Val', 'Om', 'Ser', 'Cal', 'Dren', 'Tor', 'Mar',
            'Lor', 'Cor', 'Vel', 'Nor', 'Aur', 'Sol', 'Ter', 'Cae', 'Vor', 'Nex'],
    mid:   ['or', 'ae', 'al', 'ne', 'mn', 'av', 'en', 'ir', 'el', 'an',
            'ar', 'on', 'ur', 'in', 'es'],
    coda:  ['than', 'lum', 'aris', 'dris', 'eth', 'ath', 'vion', 'nor', 'tus',
            'mir', 'ron', 'dex', 'lia', 'nus', 'ter']
  };

  /* Aspro/alieno: Keth-Var, Draxis, Zorvahl, Thrennis, Karveth, Vrox... */
  const HARSH = {
    onset: ['Keth', 'Drax', 'Zor', 'Thren', 'Kar', 'Vrox', 'Sketh', 'Ghul',
            'Khaz', 'Grom', 'Vrak', 'Zhul', 'Thok', 'Krev', 'Xar', 'Drog'],
    mid:   ['', '', 'va', 'ar', 'or', 'is', 'ven', 'ak', 'ur', 'ox'],
    coda:  ['Var', 'is', 'ahl', 'nis', 'eth', 'ox', 'ara', 'ann', 'ax', 'ok',
            'urn', 'agg', 'ix', 'oth']
  };

  /* Poetico/misterioso: Serenthal, Auveth, Lirnos, Vaelith, Dawnspire... */
  const POETIC = {
    onset: ['Seren', 'Au', 'Lir', 'Vae', 'Dawn', 'Elor', 'Mir', 'Thys',
            'Lune', 'Astra', 'Cael', 'Sil', 'Eve', 'Nytha', 'Aeri', 'Sola'],
    mid:   ['', 'n', 'th', 've', 'li', 'ra', 'mo', 're', 'na', 'lo'],
    coda:  ['thal', 'eth', 'nos', 'lith', 'spire', 'ath', 'vael', 'sen',
            'mire', 'wyn', 'thys', 'lume', 'sael', 'enor']
  };

  const STYLES = [CLASSIC, HARSH, POETIC];

  /* Capitalizza correttamente un nome composto (gestisce trattini). */
  function tidy(name) {
    return name
      .split('-')
      .map(function (part) {
        if (!part) return part;
        return part.charAt(0).toUpperCase() + part.slice(1);
      })
      .join('-');
  }

  /* Genera un singolo nome inventato in uno stile a scelta dell'RNG. */
  function inventOne(rng) {
    const style = rng.pick(STYLES);
    let name = rng.pick(style.onset);

    // talvolta una sillaba centrale, per variare la lunghezza
    if (rng.chance(0.55)) name += rng.pick(style.mid);
    name += rng.pick(style.coda);

    // lo stile aspro a volte usa il trattino (Keth-Var)
    if (style === HARSH && rng.chance(0.25)) {
      name = rng.pick(HARSH.onset) + '-' + rng.pick(['Var', 'Rok', 'Zhul', 'Tar', 'Vox', 'Kor']);
    }

    return tidy(name.toLowerCase());
  }

  /* Genera `count` nomi unici secondo la regola 40/60.
     Ritorna un array mescolato (distribuzione casuale, no geografia). */
  function generate(rng, count) {
    const used = new Set();
    const out = [];

    // --- Quota reali: 40%, ma distribuita su tutto il count ---
    const realTarget = Math.round(count * 0.4);
    const realPool = rng.shuffle(REAL.slice());
    let realAdded = 0;
    let romanRound = 0;

    for (let i = 0; i < realTarget; i++) {
      let base = realPool[realAdded % realPool.length];
      let name = base;
      // oltre il pool: aggiungi designazione di catalogo (Rigel II, ...)
      if (realAdded >= realPool.length) {
        romanRound = Math.floor(realAdded / realPool.length) - 1;
        name = base + ' ' + (ROMAN[romanRound] || (romanRound + 2));
      }
      if (!used.has(name)) {
        used.add(name);
        out.push({ name: name, real: true });
        realAdded++;
      } else {
        realAdded++;
        i--; // riprova senza consumare la quota
      }
    }

    // --- Resto: nomi inventati unici ---
    let guard = 0;
    while (out.length < count && guard < count * 50) {
      guard++;
      const name = inventOne(rng);
      if (used.has(name)) continue;
      used.add(name);
      out.push({ name: name, real: false });
    }

    // fallback estremo (collisioni improbabili): completa con suffisso
    let n = 1;
    while (out.length < count) {
      const name = 'Sistema-' + n++;
      if (used.has(name)) continue;
      used.add(name);
      out.push({ name: name, real: false });
    }

    return rng.shuffle(out);
  }

  /* =====================================================================
     Nomi dei GRUPPI STELLARI / regioni (M02 — navigazione gerarchica)

     Decisione utente: schema "misto". Una regione prende il nome da un
     descrittore evocativo + un riferimento:
       - se il gruppo contiene un sistema dal nome REALE famoso (Vega,
         Sirius…), si usa quello come riferimento → "Velo di Vega";
       - altrimenti si genera un proprio nome evocativo (stile poetico
         §5.2) → "Distesa di Auvethal".
     Deterministico (dipende solo dall'RNG → dal seed). Nomi unici.
     ===================================================================== */
  const REGION_KINDS = [
    'Distesa', 'Velo', 'Braccio', 'Ammasso', 'Corona', 'Soglia',
    'Abisso', 'Cintura', 'Nube', 'Bastione', 'Confine', 'Marca'
  ];

  /* Un nome proprio evocativo (riusa il banco poetico §5.2). */
  function inventEvocative(rng) {
    let name = rng.pick(POETIC.onset);
    if (rng.chance(0.5)) name += rng.pick(POETIC.mid);
    name += rng.pick(POETIC.coda);
    return tidy(name.toLowerCase());
  }

  /* refs: array allineato ai gruppi, ogni elemento { real: 'Vega' | null }.
     Ritorna un array di nomi-regione unici, stesso ordine.

     Il RIFERIMENTO è unico: una stella reale nomina una sola regione; se
     più gruppi citerebbero la stessa reale (es. Altair + le sue
     designazioni di catalogo finite in cluster diversi) i successivi
     ricevono un nome evocativo, così le regioni restano distinte. */
  function generateRegions(rng, refs) {
    const used = new Set();      // nomi-regione completi
    const usedRefs = new Set();  // riferimenti già usati
    const out = [];

    function freshEvocative() {
      let r = '', guard = 0;
      do { r = inventEvocative(rng); guard++; } while (usedRefs.has(r) && guard < 40);
      return r;
    }

    for (let i = 0; i < refs.length; i++) {
      let ref = refs[i] && refs[i].real ? refs[i].real : null;
      if (!ref || usedRefs.has(ref)) ref = freshEvocative();
      usedRefs.add(ref);

      // scegli un descrittore non ancora abbinato
      let name = '', guard = 0;
      do {
        name = rng.pick(REGION_KINDS) + ' di ' + ref;
        guard++;
      } while (used.has(name) && guard < 40);
      if (used.has(name)) name = name + ' ' + (i + 1); // fallback estremo
      used.add(name);
      out.push(name);
    }
    return out;
  }

  /* =====================================================================
     Nomi propri dei CORPI CELESTI (decisione #26)

     Ogni sistema planetario ha un proprio TEMA (gemme, venti, alberi…) e
     i suoi corpi ricevono nomi propri inerenti al tema. Così invece di
     "Vega II II", "Vega II III", "Vega II IV" si ha "Zaffiro", "Smeraldo",
     "Rubino" — più memorabili, più "romantici" (tema NASA/Visions), e
     l'appartenenza al sistema viene comunque mostrata come tag/contesto
     nella UI (mai dentro al nome del corpo).

     18 temi × ~14 nomi = ~250 stringhe. Tema scelto deterministicamente
     dall'RNG del sistema (`<seed>:sys:<id>`); i nomi vengono assegnati ai
     corpi in ordine deterministico mescolato — quindi due sistemi che
     pescano lo stesso tema avranno comunque ordinamento diverso.

     I nomi NON devono essere unici tra sistemi: "Zaffiro" può esistere in
     più sistemi (in Vega II e in Sirius), perché il contesto di sistema
     li distingue (Vega II/Zaffiro vs Sirius/Zaffiro).
     ===================================================================== */
  const THEMES = [
    { id: 'gemme', label: 'Gemme',
      names: ['Zaffiro', 'Smeraldo', 'Rubino', 'Opale', 'Ametista', 'Topazio',
              'Onice', 'Giada', 'Ambra', 'Quarzo', 'Diamante', 'Granato',
              'Berillo', 'Tormalina'] },
    { id: 'pigmenti', label: 'Pigmenti antichi',
      names: ['Cobalto', 'Cinabro', 'Indaco', 'Vermiglio', 'Porpora', 'Ocra',
              'Lapislazzuli', 'Malachite', 'Carminio', 'Zafferano', 'Cremisi',
              'Magenta', 'Verderame', 'Sanguigna'] },
    { id: 'strumenti', label: 'Strumenti antichi',
      names: ['Lira', 'Cetra', 'Arpa', 'Flauto', 'Liuto', 'Salterio',
              'Cembalo', 'Ribeca', 'Tibia', 'Siringa', 'Crotalo', 'Aulos',
              'Buccina', 'Sistro'] },
    { id: 'venti', label: 'Venti',
      names: ['Zefiro', 'Borea', 'Austro', 'Euro', 'Maestrale', 'Scirocco',
              'Libeccio', 'Aliseo', 'Etesia', 'Foehn', 'Notos', 'Ponente',
              'Levante', 'Tramontana'] },
    { id: 'alberi', label: 'Alberi sacri',
      names: ['Cedro', 'Quercia', 'Salice', 'Betulla', 'Faggio', 'Olmo',
              'Tiglio', 'Ciliegio', 'Frassino', 'Acero', 'Olivastro', 'Tasso',
              'Sicomoro', 'Lentisco'] },
    { id: 'resine', label: 'Resine e profumi',
      names: ['Mirra', 'Incenso', 'Sandalo', 'Nardo', 'Storace', 'Galbano',
              'Olibano', 'Mastice', 'Benzoino', 'Zibetto', 'Patchouli', 'Iris',
              'Vetiver', 'Ambretta'] },
    { id: 'bestiari', label: 'Bestiari mitologici',
      names: ['Drago', 'Fenice', 'Grifone', 'Idra', 'Sfinge', 'Chimera',
              'Manticora', 'Basilisco', 'Pegaso', 'Kirin', 'Salamandra',
              'Garuda', 'Wyvern', 'Roc'] },
    { id: 'filosofia', label: 'Concetti greci',
      names: ['Aletheia', 'Eudaimonia', 'Apeiron', 'Logos', 'Nomos', 'Hyle',
              'Ananke', 'Telos', 'Praxis', 'Pneuma', 'Kairos', 'Sophia',
              'Pathos', 'Ethos'] },
    { id: 'costellazioni', label: 'Costellazioni minori',
      names: ['Acquario', 'Lince', 'Corvo', 'Vela', 'Centauro', 'Camaleonte',
              'Cigno', 'Aquila', 'Lupo', 'Bilancia', 'Freccia', 'Scudo',
              'Bussola', 'Cratere'] },
    { id: 'stelle', label: 'Stelle storiche',
      names: ['Algol', 'Mira', 'Polluce', 'Castore', 'Bellatrix', 'Mintaka',
              'Alnilam', 'Sadr', 'Albireo', 'Mizar', 'Alcor', 'Tania',
              'Megrez', 'Saiph'] },
    { id: 'terre', label: 'Terre leggendarie',
      names: ['Esperia', 'Anatolia', 'Cathay', 'Taprobana', 'Ofir', 'Punt',
              'Eldorado', 'Cipango', 'Avalon', 'Iperborea', 'Tule', 'Ultima',
              'Lemuria', 'Mu'] },
    { id: 'sostanze', label: 'Sostanze mitiche',
      names: ['Nepenthe', 'Lothos', 'Manna', 'Ichor', 'Ambrosia', 'Nettare',
              'Soma', 'Idromele', 'Amrita', 'Haoma', 'Theriaca', 'Mithridate',
              'Elixir', 'Quintessenza'] },
    { id: 'alchimia', label: 'Alchimia',
      names: ['Argento', 'Stagno', 'Antimonio', 'Bismuto', 'Vetriolo',
              'Calcantite', 'Realgar', 'Orpimento', 'Litargirio',
              'Auripigmento', 'Borace', 'Salnitro', 'Allume', 'Tartaro'] },
    { id: 'celeste', label: 'Geografia celeste',
      names: ['Boreale', 'Polare', 'Australe', 'Equatoriale', 'Tropicale',
              'Eclittica', 'Zenit', 'Nadir', 'Apogeo', 'Perigeo', 'Afelio',
              'Perielio', 'Sizigia', 'Opposizione'] },
    { id: 'stati', label: 'Stati poetici',
      names: ['Sogno', 'Veglia', 'Ombra', 'Eco', 'Riflesso', 'Miraggio',
              'Aurora', 'Tramonto', 'Penombra', 'Crepuscolo', 'Alba',
              'Silenzio', 'Vertigine', 'Quiete'] },
    { id: 'fiori', label: 'Fiori esotici',
      names: ['Loto', 'Camelia', 'Magnolia', 'Orchidea', 'Ninfea',
              'Crisantemo', 'Glicine', 'Edelweiss', 'Verbena', 'Belladonna',
              'Mandragora', 'Acanto', 'Asclepia', 'Gelsomino'] },
    { id: 'astronomici', label: 'Strumenti astronomici',
      names: ['Astrolabio', 'Sestante', 'Quadrante', 'Armilla', 'Clessidra',
              'Compasso', 'Diottra', 'Gnomone', 'Aliade', 'Meridiana',
              'Eclimetro', 'Telurio', 'Bilancino', 'Pelorus'] },
    { id: 'marine', label: 'Ninfe marine',
      names: ['Triton', 'Naiade', 'Nereide', 'Oceanide', 'Galatea', 'Calipso',
              'Aretusa', 'Anfitrite', 'Doride', 'Tetide', 'Climene', 'Filira',
              'Pleione', 'Eurinome'] }
  ];

  /* Sceglie un tema e ne ritorna una sequenza di nomi mescolata in modo
     deterministico (dall'RNG passato). I corpi del sistema piglieranno i
     nomi in ordine d'indice orbitale. */
  function bodyNamesForSystem(rng) {
    const theme = THEMES[rng.int(0, THEMES.length - 1)];
    const names = rng.shuffle(theme.names.slice());
    return { theme: theme.id, themeLabel: theme.label, names: names };
  }

  /* =====================================================================
     Sigla regione (decisione #26): 3 lettere a partire dal nome del gruppo
     stellare. Convenzione "Iniziali del nome completo": iniziale di ogni
     parola significativa (no preposizioni); se le iniziali sono meno di
     tre, completa prendendo la prima consonante non-iniziale dalla parola
     più lunga (poi vocali se nient'altro disponibile). La gestione delle
     collisioni tra gruppi diversi avviene in galaxy.js (suffisso numerico).
     ===================================================================== */
  const STOPWORDS = {
    'di': 1, 'del': 1, 'della': 1, 'dei': 1, 'delle': 1, 'dello': 1,
    'da': 1, 'dal': 1, 'dalla': 1, 'dai': 1, 'dalle': 1,
    'su': 1, 'sul': 1, 'sulla': 1, 'sui': 1, 'sulle': 1,
    'in': 1, 'nel': 1, 'nella': 1, 'nei': 1, 'nelle': 1,
    'a': 1, 'al': 1, 'alla': 1, 'ai': 1, 'alle': 1,
    'e': 1, 'ed': 1, 'o': 1, 'od': 1,
    'il': 1, 'lo': 1, 'la': 1, 'gli': 1, 'le': 1, 'i': 1,
    'tra': 1, 'fra': 1, 'con': 1, 'per': 1
  };

  const VOWELS = 'aeiouàèéìíòóùúAEIOUÀÈÉÌÍÒÓÙÚ';
  function isVowel(ch) { return VOWELS.indexOf(ch) >= 0; }

  function regionAcronym(name) {
    if (!name) return 'XXX';
    const parts = name.split(/[\s\-]+/).filter(function (w) {
      return w && !STOPWORDS[w.toLowerCase()];
    });
    if (parts.length === 0) {
      const clean = name.replace(/[^A-Za-zÀ-ÿ]/g, '');
      return (clean.slice(0, 3).toUpperCase() + 'XXX').slice(0, 3);
    }

    const initials = parts.map(function (p) { return p[0].toUpperCase(); });
    if (initials.length >= 3) return initials.slice(0, 3).join('');

    // parola più lunga (in caso di pareggio, la prima)
    let longestIdx = 0;
    for (let i = 1; i < parts.length; i++) {
      if (parts[i].length > parts[longestIdx].length) longestIdx = i;
    }
    const longest = parts[longestIdx];

    // raccoglie caratteri extra: prima le consonanti, poi le vocali
    const need = 3 - initials.length;
    const extra = [];
    for (let i = 1; i < longest.length && extra.length < need; i++) {
      if (!isVowel(longest[i])) extra.push(longest[i].toUpperCase());
    }
    for (let i = 1; i < longest.length && extra.length < need; i++) {
      if (isVowel(longest[i])) extra.push(longest[i].toUpperCase());
    }

    // inserisce l'extra subito dopo l'iniziale della parola più lunga
    const out = [];
    for (let i = 0; i < initials.length; i++) {
      out.push(initials[i]);
      if (i === longestIdx) {
        while (extra.length && out.length + (initials.length - 1 - i) < 3) {
          out.push(extra.shift());
        }
      }
    }
    while (out.length < 3) out.push(extra.shift() || 'X');
    return out.slice(0, 3).join('');
  }

  root.ORION = root.ORION || {};
  root.ORION.names = {
    generate: generate,
    generateRegions: generateRegions,
    inventEvocative: inventEvocative,
    bodyNamesForSystem: bodyNamesForSystem,
    regionAcronym: regionAcronym,
    REAL: REAL,
    REGION_KINDS: REGION_KINDS,
    THEMES: THEMES
  };
})(typeof window !== 'undefined' ? window : this);
