/* =====================================================================
   ORION EMPIRES — fleet-naming.js
   Regola di gioco dei nomi flotta auto-derivati (#88), estratta da main.js
   (Revisione 2026, Fase 2). Puro: nessun DOM. Il nome fa parte dello stato
   (fleet.name) e finisce nel save, quindi vive nella simulazione.
   ===================================================================== */
(function (root) {
  'use strict';
  const ORION = root.ORION || (root.ORION = {});

  /* =====================================================================
     NOMI FLOTTA AUTO-DERIVATI (#88 → composition-first, richiesta utente
     2026-06-26)
     Il nome non si sceglie alla creazione: descrive *cosa è* la flotta.
     Priorità (alto→basso):
       1. Override funzionale per composizione (qualsiasi ordine):
          estrattore a bordo → Estrattore · coloniale a bordo → Pioniere.
          "Prevale lo scopo": una flotta con un estrattore È un estrattore,
          anche se scortata da caccia.
       2. Overlay di scopo per ordine caratterizzante: pattuglia/presidio →
          Sentinella · esplora → Segugio. Si applica AL VOLO a ogni cambio
          ordine (non solo alla nascita). L'attacco NON ribattezza (decisione
          utente 2026-06-26): l'identità di composizione prevale — una flotta
          di linea resta tale anche mentre attacca.
       3. Identità per nave di punta (la più forte, fleet.leadKind) × TAGLIA
          della flotta: il nome cresce da poche unità (Pattuglia) a moltitudine
          e potenza (Armata, Titano). Copre il caso neutro `move`/`idle`.
     Ribattezza SOLO nomi auto-derivati (default "Squadrone N", callsign
     correnti e legacy) → un nome scelto a mano (es. "Pattuglia Alfa",
     "Mia Flotta") non viene mai toccato. Sempre rinominabile dal dettaglio.
     ===================================================================== */
  /* Identità per (nave di punta × taglia). Per ogni classe di punta una terna
     [poche 1–3, diverse 4–7, molte 8+]: il nome cresce da "poche unità" a
     "moltitudine + potenza". L'intercettore (veloce) ha una terna a parte
     (Saetta/Falco) anche quando è la nave maggiore tra caccia minori. */
  const FLEET_COMP_TIERS = {
    'explorer':     ['Segugio',   'Segugio',    'Segugio'],     // ricognizione (flat)
    'caccia':       ['Pattuglia', 'Squadriglia', 'Stormo'],
    'intercettore': ['Saetta',    'Falco',      'Stormo'],      // a parte (veloce)
    'corvetta':     ['Compagnia', 'Battaglione', 'Brigata'],
    'fregata':      ['Compagnia', 'Battaglione', 'Brigata'],
    'incrociatore': ['Corazzata', 'Legione',    'Armata'],
    'dreadnought':  ['Corazzata', 'Legione',    'Armata'],
    'ammiraglia':   ['Titano',    'Titano',     'Titano'],      // apice (nave unica)
    'estrattore':   ['Estrattore','Estrattore', 'Estrattore'],  // (anche via override #1)
    'coloniale':    ['Pioniere',  'Pioniere',   'Pioniere']     // (anche via override #1)
  };
  /* Bucket di taglia dal numero di navi: 0=poche(1–3) · 1=diverse(4–7) · 2=molte(8+). */
  function fleetSizeBucket(fleet) {
    const n = (fleet && Array.isArray(fleet.ships)) ? fleet.ships.length : 0;
    if (n >= 8) return 2;
    if (n >= 4) return 1;
    return 0;
  }
  /* Overlay di scopo: ordini che caratterizzano la missione e prevalgono
     sull'identità di composizione (ma NON sugli override funzionali §1).
     L'attacco è volutamente assente: non ribattezza (decisione 2026-06-26). */
  const FLEET_ORDER_NAMES = {
    'patrol': 'Sentinella',
    'patrol-loop': 'Sentinella',
    'garrison': 'Sentinella',
    'explore': 'Segugio'
  };
  /* Pool secondario (sinonimi): proposto come DEFAULT quando l'utente rinomina
     manualmente — un nome+numero alternativo libero. Stesse chiavi dei due
     cataloghi sopra. */
  const FLEET_NAME_ALT = {
    'Segugio': 'Pellegrino', 'Estrattore': 'Minatrice', 'Pattuglia': 'Ronda',
    'Squadriglia': 'Nugolo', 'Stormo': 'Sciame', 'Saetta': 'Strale', 'Falco': 'Astore',
    'Compagnia': 'Coorte', 'Battaglione': 'Reparto', 'Brigata': 'Schiera',
    'Corazzata': 'Baluardo', 'Legione': 'Falange', 'Armata': 'Armada',
    'Titano': 'Colosso', 'Pioniere': 'Avanguardia', 'Sentinella': 'Bastione'
  };
  /* Tutte le basi che generiamo noi (correnti + legacy): un nome che combacia
     con "<base> <numero>" è considerato auto-derivato → rinominabile al volo.
     Le basi legacy ("Convoglio", "Vedetta", "Carovana", …) restano qui così i
     save vecchi migrano al primo cambio ordine, senza bump di schema. */
  const FLEET_AUTO_BASES = [
    'Squadrone',
    /* basi correnti (composizione × taglia + override + overlay) */
    'Segugio', 'Estrattore', 'Pioniere', 'Sentinella',
    'Pattuglia', 'Squadriglia', 'Stormo', 'Saetta', 'Falco',
    'Compagnia', 'Battaglione', 'Brigata',
    'Corazzata', 'Legione', 'Armata', 'Titano',
    /* basi primarie storiche (versioni precedenti di questo branch): restano
       qui così i nomi auto già assegnati migrano al primo cambio ordine. */
    'Flottiglia', 'Squadra', 'Falange', 'Aquila', 'Leviatano', 'Lama',
    'Convoglio', 'Vedetta'
  ];
  /* Numero progressivo per quella base: max suffisso numerico tra le flotte
     esistenti col prefisso "<Base> ", +1. Robusto a rinomine manuali (chi
     ribattezza "Segugio 1" → "Mia Flotta" lascia un buco, la successiva sarà
     "Segugio N+1"). */
  function nextProgressiveFor(g, base) {
    const re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+(\\d+)$');
    let max = 0;
    (g.fleets || []).forEach(function (f) {
      const m = re.exec(f.name || '');
      if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; }
    });
    return max + 1;
  }
  /* Una flotta porta almeno una nave di questa classe? */
  function fleetCarries(fleet, kind) {
    if (!fleet || !Array.isArray(fleet.ships)) return false;
    for (let i = 0; i < fleet.ships.length; i++) {
      if (fleet.ships[i] && fleet.ships[i].kind === kind) return true;
    }
    return false;
  }
  /* Base auto-derivata per (composizione, ordine), senza numero. Implementa le
     tre priorità descritte sopra. null = nessuna base sensata (flotta vuota o
     ordine/composizione sconosciuti) → non ribattezzare. */
  function autoFleetBase(fleet, order) {
    /* §1 — override funzionali per composizione (prevalgono su tutto). */
    if (fleetCarries(fleet, 'estrattore')) return 'Estrattore';
    if (fleetCarries(fleet, 'coloniale')) return 'Pioniere';
    /* §2 — overlay di scopo dall'ordine caratterizzante. */
    if (order && order.type) {
      if (order.type === 'colonize') return 'Pioniere';
      if (order.type === 'move-route' && order.exploreEach) return 'Segugio';
      const ov = FLEET_ORDER_NAMES[order.type];
      if (ov) return ov;
    }
    /* §3 — identità per nave di punta × taglia (caso neutro: move/idle/cargo). */
    const lead = (ORION.fleet && ORION.fleet.leadKind) ? ORION.fleet.leadKind(fleet) : null;
    const tier = lead && FLEET_COMP_TIERS[lead];
    return tier ? tier[fleetSizeBucket(fleet)] : null;
  }
  /* Compone base + numero. Se la flotta porta GIÀ un nome auto con la stessa
     base, ne conserva il numero (niente renumber-churn a ogni cambio ordine). */
  function autoFleetName(g, fleet, order) {
    const base = autoFleetBase(fleet, order);
    if (!base) return null;
    const keep = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+\\d+$');
    if (fleet && keep.test(fleet.name || '')) return fleet.name;
    return base + ' ' + nextProgressiveFor(g, base);
  }
  /* Un nome è auto-derivato (quindi ribattezzabile al volo) se combacia con
     "<base nota> <numero>". Tutto il resto è considerato scelto a mano e
     intoccabile. */
  function isAutoFleetName(name) {
    name = name || '';
    for (let i = 0; i < FLEET_AUTO_BASES.length; i++) {
      const re = new RegExp('^' + FLEET_AUTO_BASES[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+\\d+$');
      if (re.test(name)) return true;
    }
    return false;
  }
  function maybeAutoRenameFleet(g, fleet, order) {
    /* Ribattezza al volo a ogni ordine, purché il nome sia ancora auto-derivato
       (default o callsign): così "Lama"/"Sentinella" compaiono al cambio ordine
       e i "Convoglio" legacy migrano alla nuova identità di composizione. */
    if (!fleet || !isAutoFleetName(fleet.name)) return;
    const nm = autoFleetName(g, fleet, order);
    if (nm && nm !== fleet.name) fleet.name = nm.slice(0, 40);
  }
  /* Suggerimento di rinomina manuale: propone il sinonimo della base auto-derivata
     corrente + primo numero libero. È solo un default pre-popolato nell'input ✎ —
     l'utente è libero di modificare. null per flotte senza base sensata. */
  function suggestedRenameFor(g, fleet) {
    const base = autoFleetBase(fleet, fleet && fleet.orders);
    if (!base) return null;
    const alt = FLEET_NAME_ALT[base] || base;
    return alt + ' ' + nextProgressiveFor(g, alt);
  }

  ORION.fleetNaming = {
    maybeAutoRename: maybeAutoRenameFleet,
    suggestedRename: suggestedRenameFor,
    autoName: autoFleetName,
    isAutoName: isAutoFleetName
  };
})(typeof window !== 'undefined' ? window : globalThis);
