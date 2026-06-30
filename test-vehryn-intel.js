/* =====================================================================
   M19 §6e — Test headless per la VENDITA INFORMAZIONI del Conclave di Vehryn
   (decisione utente 2026-06-30: ruolo spostato dai Mekhari ai Vehryn).
   Esegui con:  node test-vehryn-intel.js
   Verifica:
     1. Gate Linea A: localizzazione/profilo richiedono che la civ bersaglio
        sia IDENTIFICATA (civ.flagSeen) o avvistata.
     2. Localizzazione: rivela i sistemi (discovery → EXPLORED) + promuove
        ad "Avvistata"; rifiuta quando tutto è già noto.
     3. Profilo: crea civ.greyIntel con forza a fascia (margine d'errore) e
        campi talvolta incerti; rifiuta se già posseduto.
     4. Voci di galassia: aggiunge voci, dedup sullo stesso Impulso, alcune
        anonime (non attendibili). Stato in game.vehrynIntel.
     5. Acquisti LEGITTIMI: costano crediti ma NON reputazione (≠ Mekhari).
     6. Determinismo (#5): stesso seed + stesso Impulso → stesso esito.
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
const ORION = load('js/galaxy.js');   // DISCOVERY + revealSystem reali

function assert(cond, msg) {
  if (!cond) { console.error('  ✗ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  console.log('  ✓', msg);
}

/* --- mock minimale delle API che vehryn.js usa ---------------------- */
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
let repAdjusted = 0;
ORION.diplomacy = {
  reputation: function (g) { return g.reputation; },
  adjustReputation: function (g, d) { repAdjusted += d; g.reputation += d; }
};
ORION.treasury = {
  totalCredits: function (g) { return g._credits; },
  spendCredits: function (g, c) {
    if (g._credits + 1e-6 < c) return { ok: false, reason: 'insuff' };
    g._credits -= c; return { ok: true };
  }
};

const V = load('js/vehryn.js').vehryn;

const D = ORION.galaxy.DISCOVERY;
function fakeGame() {
  return {
    timeImpulsi: 200,
    reputation: 50,
    _credits: 5000,
    galaxy: { seed: 'TST', systems: [{ links: [1] }, { links: [0, 2] }, { links: [1, 3] }, { links: [2] }] },
    state: { discovery: [D.EXPLORED, D.UNKNOWN, D.UNKNOWN, D.UNKNOWN] },
    civs: [
      { id: 'veh', name: 'Vehryn', faction: 'vehryn', alive: true, knowledge: 'contacted', planets: ['3:b0'], systems: [3] },
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
  assert(V.isAvailable(g) === true, 'Vehryn contattati → vendita info disponibile');
  assert(V.quoteLocate(g, 'r1').ok === false, 'localizzazione rifiutata su civ non identificata');
  assert(V.quoteProfile(g, 'r1').ok === false, 'profilo rifiutato su civ non identificata');
  g.civs[1].flagSeen = true;
  assert(V.quoteLocate(g, 'r1').ok === true, 'dopo flagSeen → localizzazione disponibile');
  assert(V.quoteProfile(g, 'r1').ok === true, 'dopo flagSeen → profilo disponibile');
}

console.log('— Test 2: localizzazione rivela i sistemi + promuove ad Avvistata');
{
  const g = fakeGame();
  g.civs[1].flagSeen = true;
  repAdjusted = 0;
  const credBefore = g._credits;
  const r = V.buyLocate(g, 'r1');
  assert(r.ok === true, 'acquisto localizzazione ok');
  assert(r.revealed === 2, 'rivelati i 2 sistemi di Vorthan (1 e 2)');
  assert(g.state.discovery[1] >= D.EXPLORED && g.state.discovery[2] >= D.EXPLORED, 'discovery[1] e [2] = EXPLORED');
  assert(g.civs[1].knowledge === 'spotted', 'civ promossa ad Avvistata');
  assert(g._credits < credBefore, 'crediti spesi');
  assert(repAdjusted === 0, 'NESSUN costo di reputazione (acquisto legittimo Vehryn)');
  assert(V.quoteLocate(g, 'r1').ok === false, 'rifiuta: sistemi già noti');
}

console.log('— Test 3: profilo crea snapshot con margine d\'errore');
{
  const g = fakeGame();
  g.civs[1].flagSeen = true;
  const r = V.buyProfile(g, 'r1');
  assert(r.ok === true, 'acquisto profilo ok');
  const gi = g.civs[1].greyIntel;
  assert(gi && gi.force, 'greyIntel.force presente');
  assert(gi.force.lo < gi.force.mid && gi.force.mid < gi.force.hi, 'forza è una FASCIA (lo < mid < hi)');
  assert(gi.I === g.timeImpulsi, 'snapshot DATATO (impulso registrato)');
  assert(gi.powerAtBuy === 120, 'potenza reale al momento dell\'acquisto registrata');
  assert(gi.source === 'vehryn', 'fonte marcata vehryn');
  assert(V.quoteProfile(g, 'r1').ok === false, 'rifiuta: dossier già posseduto');
}

console.log('— Test 4: voci di galassia, dedup e anonimato');
{
  const g = fakeGame();
  const r = V.buyRumor(g);
  assert(r.ok === true, 'acquisto voci ok');
  assert(r.added >= 1 && r.added <= V.RUMOR_BATCH, 'aggiunte 1..BATCH voci');
  assert(g.vehrynIntel.rumors.length === r.added, 'voci archiviate in game.vehrynIntel');
  assert(r.rumors.every(function (v) { return v.reliable || v.civId == null; }), 'voci non attendibili → anonime (civId null)');
  const r2 = V.buyRumor(g);
  assert(r2.ok === false, 'stesso Impulso: rifiuta (nessuna voce più fresca)');
}

console.log('— Test 5: determinismo (#5) — stesso seed + Impulso → stesso esito');
{
  const a = fakeGame(); a.civs[1].flagSeen = true;
  const b = fakeGame(); b.civs[1].flagSeen = true;
  V.buyProfile(a, 'r1'); V.buyProfile(b, 'r1');
  assert(JSON.stringify(a.civs[1].greyIntel) === JSON.stringify(b.civs[1].greyIntel),
    'greyIntel identico su due partite con stesso seed/Impulso');
  const ra = V.buyRumor(a), rb = V.buyRumor(b);
  assert(JSON.stringify(ra.rumors) === JSON.stringify(rb.rumors), 'voci identiche su due partite con stesso seed/Impulso');
}

if (!process.exitCode) console.log('\n✓ Tutti i test passati');
