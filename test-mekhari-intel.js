/* =====================================================================
   M19 §6e — Test headless per la RIFONDAZIONE dell'intel grigia Mekhari
   (richiesta utente 2026-06-29). Esegui con:  node test-mekhari-intel.js
   Verifica:
     1. Gate Linea A: localizzazione/profilo richiedono che la civ sia
        IDENTIFICATA (civ.flagSeen) o avvistata — non più "contattata".
     2. Localizzazione: rivela i sistemi (discovery → EXPLORED) + promuove
        ad "Avvistata"; rifiuta quando tutto è già noto.
     3. Profilo grigio: crea civ.greyIntel con forza a fascia (margine
        d'errore) e campi talvolta incerti; rifiuta se già posseduto.
     4. Voci di galassia: aggiunge voci, dedup sullo stesso Impulso, alcune
        anonime (non attendibili).
     5. Determinismo (#5): stesso seed + stesso Impulso → stesso esito.
   ===================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const root = { console: console };
function load(rel) {
  const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
  const wrap = '(function(globalThis, window){' + src + '\nreturn globalThis.ORION;})';
  return eval(wrap)(root, root);
}
load('js/rng.js');
const ORION = load('js/galaxy.js');   // serve DISCOVERY + revealSystem reali

function assert(cond, msg) {
  if (!cond) { console.error('  ✗ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  console.log('  ✓', msg);
}

/* --- mock minimale delle API che mekhari.js usa ---------------------- */
const KNOWLEDGE = { unknown: 0, spotted: 1, contacted: 2, known: 3, familiar: 4 };
const INTEL = { fragmentary: 1, partial: 2, complete: 3, deep: 4 };
ORION.ai = {
  KNOWLEDGE: KNOWLEDGE,
  knowledgeRank: function (c) { return KNOWLEDGE[(c && c.knowledge) || 'unknown'] || 0; },
  bumpKnowledge: function (c, lvl) {
    if (!c) return false;
    if ((KNOWLEDGE[c.knowledge || 'unknown'] || 0) >= KNOWLEDGE[lvl]) return false;
    c.knowledge = lvl; if (lvl === 'contacted') c.contacted = true; return true;
  },
  derivedSystems: function (c) { return (c.systems || []).slice(); },
  intelLevelRank: function (l) { return INTEL[l] || 0; },
  intelLevelFromProgress: function (p) { return p >= 10 ? 'deep' : p >= 6 ? 'complete' : p >= 3 ? 'partial' : 'fragmentary'; },
  dossier: function (c) { return { vocationLabel: 'Mercantili', systems: (c.systems || []).length }; },
  dispositionLabel: function (v) { return v < 0 ? 'Ostile' : 'Cordiale'; }
};
ORION.diplomacy = {
  reputation: function (g) { return g.reputation; },
  adjustReputation: function (g, d) { g.reputation = Math.max(0, Math.min(100, g.reputation + d)); }
};
ORION.treasury = {
  totalCredits: function (g) { return g._credits; },
  spendCredits: function (g, c) {
    if (g._credits + 1e-6 < c) return { ok: false, reason: 'insuff' };
    g._credits -= c; return { ok: true };
  }
};

const MK = load('js/mekhari.js').mekhari;

/* --- fixture: galassia lineare a 4 sistemi -------------------------- */
const D = ORION.galaxy.DISCOVERY;
function fakeGame() {
  return {
    timeImpulsi: 200,
    reputation: 50,
    _credits: 5000,
    galaxy: { seed: 'TST', systems: [{ links: [1] }, { links: [0, 2] }, { links: [1, 3] }, { links: [2] }] },
    state: { discovery: [D.EXPLORED, D.UNKNOWN, D.UNKNOWN, D.UNKNOWN] },
    civs: [
      { id: 'mek', name: 'Mekhari', faction: 'mekhari', alive: true, knowledge: 'contacted', planets: ['3:b0'], systems: [3] },
      { id: 'r1', name: 'Vorthan', alive: true, alignment: 'male', phase: 'rise', power: 120,
        disposition: -20, vocation: 'espansionisti', homeTier: 'orlo', knowledge: 'unknown', planets: ['1:b0', '2:b0'], systems: [1, 2] },
      { id: 'r2', name: 'Aelin', alive: true, alignment: 'bene', phase: 'growth', power: 60,
        disposition: 40, vocation: 'mercantili', homeTier: 'colonie', knowledge: 'unknown', planets: ['2:b1'], systems: [2] }
    ]
  };
}

console.log('— Test 1: gate Linea A richiede identificazione (flagSeen)');
{
  const g = fakeGame();
  assert(MK.isAvailable(g) === true, 'Mekhari contattati → mercato disponibile');
  assert(MK.quoteLocate(g, 'r1').ok === false, 'localizzazione rifiutata su civ non identificata');
  assert(MK.quoteProfile(g, 'r1').ok === false, 'profilo rifiutato su civ non identificata');
  g.civs[1].flagSeen = true; // come se aifleet avesse identificato una loro flotta
  assert(MK.quoteLocate(g, 'r1').ok === true, 'dopo flagSeen → localizzazione disponibile');
  assert(MK.quoteProfile(g, 'r1').ok === true, 'dopo flagSeen → profilo disponibile');
  assert(MK.civIdentified(g, g.civs[2]) === false, 'r2 non ancora identificata');
}

console.log('— Test 2: localizzazione rivela i sistemi + promuove ad Avvistata');
{
  const g = fakeGame();
  g.civs[1].flagSeen = true;
  const credBefore = g._credits, repBefore = g.reputation;
  const r = MK.buyLocate(g, 'r1');
  assert(r.ok === true, 'acquisto localizzazione ok');
  assert(r.revealed === 2, 'rivelati i 2 sistemi di Vorthan (1 e 2)');
  assert(g.state.discovery[1] >= D.EXPLORED && g.state.discovery[2] >= D.EXPLORED, 'discovery[1] e [2] = EXPLORED');
  assert(g.civs[1].knowledge === 'spotted', 'civ promossa ad Avvistata');
  assert(g._credits < credBefore, 'crediti spesi');
  assert(g.reputation < repBefore, 'costo di reputazione applicato');
  assert(MK.quoteLocate(g, 'r1').ok === false, 'rifiuta: sistemi già noti');
}

console.log('— Test 3: profilo grigio crea snapshot con margine d\'errore');
{
  const g = fakeGame();
  g.civs[1].flagSeen = true;
  const r = MK.buyProfile(g, 'r1');
  assert(r.ok === true, 'acquisto profilo ok');
  const gi = g.civs[1].greyIntel;
  assert(gi && gi.force, 'greyIntel.force presente');
  assert(gi.force.lo < gi.force.mid && gi.force.mid < gi.force.hi, 'forza è una FASCIA (lo < mid < hi)');
  assert(gi.force.lo >= 1, 'limite inferiore ≥ 1');
  assert(gi.I === g.timeImpulsi, 'snapshot DATATO (impulso registrato)');
  assert(gi.powerAtBuy === 120, 'potenza reale al momento dell\'acquisto registrata');
  assert(MK.quoteProfile(g, 'r1').ok === false, 'rifiuta: dossier già posseduto');
}

console.log('— Test 4: voci di galassia, dedup e anonimato');
{
  const g = fakeGame();
  const r = MK.buyRumor(g);
  assert(r.ok === true, 'acquisto voci ok');
  assert(r.added >= 1 && r.added <= MK.RUMOR_BATCH, 'aggiunte 1..BATCH voci');
  assert(g.mekhariIntel.rumors.length === r.added, 'voci archiviate in game.mekhariIntel');
  assert(r.rumors.every(function (v) { return typeof v.text === 'string' && v.text.length > 0; }), 'ogni voce ha testo');
  assert(r.rumors.every(function (v) { return v.reliable || v.civId == null; }), 'voci non attendibili → anonime (civId null)');
  /* stesso Impulso → stesse voci → niente di nuovo da vendere. */
  const r2 = MK.buyRumor(g);
  assert(r2.ok === false, 'stesso Impulso: rifiuta (nessuna voce più fresca)');
}

console.log('— Test 5: determinismo (#5) — stesso seed + Impulso → stesso esito');
{
  const a = fakeGame(); a.civs[1].flagSeen = true;
  const b = fakeGame(); b.civs[1].flagSeen = true;
  MK.buyProfile(a, 'r1'); MK.buyProfile(b, 'r1');
  assert(JSON.stringify(a.civs[1].greyIntel) === JSON.stringify(b.civs[1].greyIntel),
    'greyIntel identico su due partite con stesso seed/Impulso');
  const ra = MK.buyRumor(a), rb = MK.buyRumor(b);
  assert(JSON.stringify(ra.rumors) === JSON.stringify(rb.rumors), 'voci identiche su due partite con stesso seed/Impulso');
}

if (!process.exitCode) console.log('\n✓ Tutti i test passati');
