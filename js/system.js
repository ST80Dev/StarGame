/* =====================================================================
   ORION EMPIRES — system.js
   Modulo M03: generazione procedurale dell'INTERNO di un sistema
   stellare (GDD §6).

   Coerente con la strategia seed+delta (decisione #5): la struttura
   dell'interno è interamente DERIVATA dal seed della galassia + l'id del
   sistema (`<seed>:sys:<id>`), quindi NON va salvata — si rigenera
   identica. Nessun costo di salvataggio.

   La stella deriva dal tipo già scelto in M02 (`galaxy.systems[id].star`:
   gialla/arancione/rossa/bianca/blu/binaria), così la vista interna è
   coerente con il colore del nodo sulla mappa.

   Scope M03: struttura + dati base dei corpi (§6.1/§6.3). La gestione e
   la colonizzazione del pianeta (popolazione, risorse, edifici) è M04.
   ===================================================================== */
'use strict';

(function (root) {
  const makeRng = root.ORION.rng.makeRng;

  const SCHEMA_VERSION = 1;

  /* Numerali romani per la designazione dei corpi (Vega I, Vega II…). */
  const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
  const MOON_LETTERS = ['a', 'b', 'c', 'd'];

  /* ------------------------------------------------------------------
     Caratteristiche fisiche delle stelle (mappa dai tipi M02).
     `rel` = raggio relativo; `world` lo scala in unità-mondo (orbite ≤ 1).
     ------------------------------------------------------------------ */
  const STAR_PHYS = {
    yellow: { label: 'Nana gialla',    color: '#ffd86b', rel: 1.00 },
    orange: { label: 'Nana arancione', color: '#ffae5c', rel: 0.86 },
    red:    { label: 'Gigante rossa',  color: '#ff6f5c', rel: 1.70 },
    white:  { label: 'Nana bianca',    color: '#dfe9ff', rel: 0.52 },
    blue:   { label: 'Stella blu',     color: '#7fb6ff', rel: 1.45 }
  };

  /* ------------------------------------------------------------------
     Tipi di corpo celeste (§6.3) — vantaggi/svantaggi dal GDD + palette
     per la resa procedurale (NASA/Visions, decisione #8).
       cat: rocky | gas | moon | belt
     ------------------------------------------------------------------ */
  const BODY_TYPES = {
    terrestre: {
      label: 'Pianeta terrestre', cat: 'rocky', habitable: true,
      vantaggi: 'Agricoltura, popolazione alta', svantaggi: 'Risorse minerali medie',
      palette: { sea: '#27598f', land: '#3f8a55', accent: '#6fb56a', atmosphere: '#aee0ff' }
    },
    desertico: {
      label: 'Pianeta desertico', cat: 'rocky', habitable: true,
      vantaggi: 'Minerali abbondanti, rarità', svantaggi: 'Cibo scarso, caldo estremo',
      palette: { sea: '#a96f38', land: '#c98a4b', accent: '#e6b878', atmosphere: '#ffdca0' }
    },
    oceanico: {
      label: 'Pianeta oceanico', cat: 'rocky', habitable: true,
      vantaggi: 'Acqua abbondante, biochimica', svantaggi: 'Costruzioni costose',
      palette: { sea: '#1f5aa0', land: '#2f74c0', accent: '#7fc6ea', atmosphere: '#bfe6ff' }
    },
    ghiacciato: {
      label: 'Pianeta ghiacciato', cat: 'rocky', habitable: true,
      vantaggi: 'Risorse criogeniche, rarità', svantaggi: 'Energia costosa, lento',
      palette: { sea: '#a9c9e6', land: '#cfe6f5', accent: '#ffffff', atmosphere: '#eaf6ff', iceCaps: true }
    },
    vulcanico: {
      label: 'Pianeta vulcanico', cat: 'rocky', habitable: true,
      vantaggi: 'Energia geotermica, metalli pesanti', svantaggi: 'Instabile, pericoloso',
      palette: { sea: '#3a1813', land: '#5a241c', accent: '#ff6a2a', atmosphere: '#ff8a4c', lava: true }
    },
    forestale: {
      label: 'Pianeta forestale', cat: 'rocky', habitable: true,
      vantaggi: 'Biomassa, farmaceutici', svantaggi: 'Minerali scarsi',
      palette: { sea: '#1f5a39', land: '#2f7a44', accent: '#7fbf5c', atmosphere: '#cfeec0' }
    },
    gassoso: {
      label: 'Gigante gassoso', cat: 'gas', habitable: false,
      vantaggi: 'Elio-3, gas rari', svantaggi: 'Non abitabile, solo estrazione orbitale',
      palette: { bands: true }   // colore scelto per-corpo (varianti sotto)
    },
    luna: {
      label: 'Luna', cat: 'moon', habitable: true,
      vantaggi: 'Varia, compatta', svantaggi: 'Gravità bassa, capacità ridotta',
      palette: { sea: '#7c8290', land: '#9aa0ad', accent: '#c2c8d2', craters: true }
    },
    cintura: {
      label: 'Cintura asteroidale', cat: 'belt', habitable: false,
      vantaggi: 'Minerali puri, metalli rari', svantaggi: 'Solo estrazione, non abitabile',
      palette: { rock: '#b6a888' }
    }
  };

  /* Varianti cromatiche dei giganti gassosi (tan / salmone / verdino). */
  const GAS_VARIANTS = [
    { base: '#c8ad77', alt: '#a98a56', spot: '#e6d3a2' },
    { base: '#c08a72', alt: '#9a5e50', spot: '#e8b6a0' },
    { base: '#8fae9a', alt: '#5f8474', spot: '#cfe6d6' },
    { base: '#b59ac8', alt: '#7d5e96', spot: '#e0cdf0' }
  ];

  /* Anomalie spaziali opzionali (§6.1). */
  const ANOMALY_KINDS = {
    detriti: { label: 'Campo di detriti', desc: 'Relitti e frammenti in deriva: insidie alla navigazione, possibili recuperi.' },
    nebulosa: { label: 'Nebulosa locale', desc: 'Gas denso che acceca i sensori: effetti su scansioni ed esplorazione.' },
    reliquie: { label: 'Reliquie antiche', desc: 'Tracce di una civiltà perduta: potenziali tecnologie uniche (§7.2).' }
  };

  function weightedPick(rng, weights) {
    const keys = Object.keys(weights);
    let total = 0;
    for (let i = 0; i < keys.length; i++) total += weights[keys[i]];
    let r = rng.float() * total;
    for (let i = 0; i < keys.length; i++) {
      r -= weights[keys[i]];
      if (r <= 0) return keys[i];
    }
    return keys[0];
  }

  /* Distribuzione dei tipi per fascia orbitale (interno caldo → esterno
     freddo). t ∈ [0,1] dal corpo più interno al più esterno. */
  function zoneWeights(t) {
    if (t < 0.32) return { vulcanico: 4, desertico: 3, cintura: 1, terrestre: 1 };
    if (t < 0.62) return { terrestre: 3, oceanico: 3, forestale: 2, desertico: 1, cintura: 1 };
    return { ghiacciato: 3, gassoso: 4, cintura: 2, oceanico: 1 };
  }

  /* ------------------------------------------------------------------
     Stella/e centrali. Le binarie (§6.1) sono due componenti attorno al
     baricentro comune; i pianeti orbitano il baricentro (circumbinari).
     ------------------------------------------------------------------ */
  function buildStars(rng, starKind) {
    if (starKind === 'binary') {
      const comps = ['yellow', 'orange', 'red', 'white', 'blue'];
      const a = rng.pick(comps);
      let b = rng.pick(comps);
      const A = STAR_PHYS[a], B = STAR_PHYS[b];
      return {
        binary: true,
        label: 'Binaria · ' + A.label + ' + ' + B.label,
        sep: rng.range(0.07, 0.11),
        members: [
          { kind: a, label: A.label, color: A.color, radius: 0.050 * A.rel },
          { kind: b, label: B.label, color: B.color, radius: 0.050 * B.rel }
        ]
      };
    }
    const P = STAR_PHYS[starKind] || STAR_PHYS.yellow;
    return {
      binary: false,
      label: P.label,
      sep: 0,
      members: [{ kind: starKind, label: P.label, color: P.color, radius: 0.075 * P.rel }]
    };
  }

  /* Raggi orbitali crescenti e spaziati, normalizzati nell'intervallo
     [0.18, 0.95] dello spazio-mondo del sistema. */
  function orbitRadii(rng, n) {
    const raw = [];
    let r = 0;
    for (let i = 0; i < n; i++) { r += rng.range(0.09, 0.17); raw.push(r); }
    const lo = raw[0], hi = raw[n - 1];
    const span = hi - lo || 1;
    return raw.map(function (x) { return 0.18 + ((x - lo) / span) * (0.95 - 0.18); });
  }

  /* ==================================================================
     GENERAZIONE DELL'INTERNO (immutabile, derivata dal seed)
     ================================================================== */
  function generate(galaxy, systemId) {
    const sys = galaxy.systems[systemId];
    const seedBase = galaxy.seed + ':sys:' + systemId;
    const rng = makeRng(seedBase);

    const stars = buildStars(rng, sys.star);

    // §6.1: 4–7 corpi celesti (slot orbitali primari: pianeti, gassosi,
    // cinture). Le lune sono corpi-figli aggiuntivi.
    const count = rng.int(4, 7);
    const radii = orbitRadii(rng, count);

    // Decisione #26: ogni sistema ha un proprio tema; i corpi ricevono
    // nomi propri dal tema (deterministico dal seed). Le lune appendono
    // la lettera (a/b/c) al nome del pianeta padre, restando "figlie"
    // visivamente.
    const themePack = root.ORION.names.bodyNamesForSystem(rng);

    const isHome = systemId === galaxy.homeId;
    let habitableSlot = -1;     // per garantire un mondo ospitale al sistema d'origine
    let bestHabT = Infinity;

    const bodies = [];
    for (let i = 0; i < count; i++) {
      const t = count > 1 ? i / (count - 1) : 0.5;
      const type = weightedPick(rng, zoneWeights(t));
      const def = BODY_TYPES[type];
      const childSeed = seedBase + ':b' + i;
      const properName = themePack.names[i % themePack.names.length];
      const body = {
        key: 'b' + i,
        index: i,
        type: type,
        // Nome proprio dal tema del sistema (decisione #26). Il contesto
        // di appartenenza (sigla regione + sistema) viene mostrato dalla
        // UI come tag, mai dentro al nome stesso.
        name: properName,
        designation: ROMAN[i],
        systemName: sys.name,
        orbit: radii[i],
        angle: rng.range(0, Math.PI * 2),
        seed: childSeed,
        moons: []
      };

      if (def.cat === 'belt') {
        body.beltWidth = rng.range(0.03, 0.06);
        body.radius = 0;
      } else if (def.cat === 'gas') {
        body.radius = rng.range(0.046, 0.072);
        body.variant = rng.int(0, GAS_VARIANTS.length - 1);
        body.tilt = rng.range(-0.18, 0.18);
      } else {
        body.radius = rng.range(0.022, 0.040);
        body.tilt = rng.range(0, Math.PI * 2);
      }

      // lune (§6.1): i gassosi ne hanno sempre alcune; i pianeti rocciosi
      // grandi talvolta una.
      let moonCount = 0;
      if (def.cat === 'gas') moonCount = rng.int(1, 3);
      else if (def.cat === 'rocky' && rng.chance(0.38)) moonCount = 1;
      for (let m = 0; m < moonCount; m++) {
        body.moons.push({
          key: body.key + 'm' + m,
          index: m,
          type: 'luna',
          name: body.name + ' ' + MOON_LETTERS[m],   // es. "Zaffiro a"
          designation: ROMAN[i] + ' ' + MOON_LETTERS[m],
          systemName: sys.name,
          parentKey: body.key,
          moonOrbit: body.radius + 0.026 + m * 0.022 + rng.range(0, 0.02),
          angle: rng.range(0, Math.PI * 2),
          radius: rng.range(0.010, 0.018),
          seed: childSeed + ':m' + m
        });
      }

      // tieni traccia dello slot più vicino alla fascia abitabile
      if (def.habitable && def.cat === 'rocky') {
        const dH = Math.abs(t - 0.45);
        if (dH < bestHabT) { bestHabT = dH; habitableSlot = i; }
      }
      bodies.push(body);
    }

    // §5.1/§6.2: il sistema d'origine deve offrire un mondo ospitale.
    if (isHome) {
      const slot = habitableSlot >= 0 ? habitableSlot : Math.floor(count / 2);
      const b = bodies[slot];
      if (BODY_TYPES[b.type].cat !== 'rocky' || !BODY_TYPES[b.type].habitable) {
        b.type = 'terrestre';
        b.radius = Math.max(b.radius || 0, 0.03);
        b.beltWidth = undefined;
      }
      b.homeWorld = true;
    }

    // Anomalie opzionali (§6.1): 0–2.
    const anomalies = [];
    if (rng.chance(0.6)) {
      const kinds = Object.keys(ANOMALY_KINDS);
      const nA = rng.int(1, 2);
      for (let a = 0; a < nA; a++) {
        const kind = rng.pick(kinds);
        anomalies.push({
          kind: kind,
          label: ANOMALY_KINDS[kind].label,
          desc: ANOMALY_KINDS[kind].desc,
          orbit: rng.range(0.22, 0.96),
          angle: rng.range(0, Math.PI * 2),
          radius: kind === 'nebulosa' ? rng.range(0.12, 0.22) : rng.range(0.04, 0.08),
          seed: seedBase + ':a' + a
        });
      }
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      id: systemId,
      seedBase: seedBase,
      name: sys.name,
      realName: sys.realName,
      starKind: sys.star,
      stars: stars,
      bodies: bodies,
      anomalies: anomalies,
      danger: sys.danger,
      dangerTier: sys.dangerTier,
      isHome: isHome,
      theme: themePack.theme,
      themeLabel: themePack.themeLabel
    };
  }

  /* Cerca un corpo (pianeta o luna) per chiave. */
  function findBody(system, key) {
    for (let i = 0; i < system.bodies.length; i++) {
      const b = system.bodies[i];
      if (b.key === key) return b;
      for (let m = 0; m < b.moons.length; m++) {
        if (b.moons[m].key === key) return b.moons[m];
      }
    }
    return null;
  }

  root.ORION = root.ORION || {};
  root.ORION.system = {
    generate: generate,
    findBody: findBody,
    BODY_TYPES: BODY_TYPES,
    STAR_PHYS: STAR_PHYS,
    ANOMALY_KINDS: ANOMALY_KINDS,
    GAS_VARIANTS: GAS_VARIANTS,
    SCHEMA_VERSION: SCHEMA_VERSION
  };
})(typeof window !== 'undefined' ? window : this);
