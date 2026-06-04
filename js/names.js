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

  root.ORION = root.ORION || {};
  root.ORION.names = { generate, generateRegions, inventEvocative, REAL, REGION_KINDS };
})(typeof window !== 'undefined' ? window : this);
