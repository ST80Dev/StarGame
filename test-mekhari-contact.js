/* =====================================================================
   M19 §13.7/§13.10 — Test contatto automatico Mekhari (richiesta utente
   2026-06-30). Esegui con:  node test-mekhari-contact.js
   Verifica:
     1. markContact reale promuove una civ a "contattato" (+1 interazione).
     2. La guardia rank<contacted impedisce di richiamare markContact ogni
        tick → niente inflazione di civ.interactions (che farebbe fast-track
        errato a "Conosciuta", soglia 3 interazioni).
     3. Una volta contattati, mekhari.isAvailable() = true (sblocca mercato
        grigio + intel); prima è false.
   ===================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const root = { console: console };
function load(rel) {
  const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
  return eval('(function(globalThis,window){' + src + '\nreturn globalThis.ORION;})')(root, root);
}
load('js/rng.js'); load('js/utils.js'); load('js/galaxy.js'); load('js/ai.js');
root.ORION.treasury = { totalCredits: g => g._cr, spendCredits: (g, c) => { g._cr -= c; return { ok: true }; } };
root.ORION.diplomacy = { reputation: g => g.reputation, adjustReputation: (g, d) => { g.reputation += d; } };
const ORION = load('js/mekhari.js');
const AI = ORION.ai, MK = ORION.mekhari;

function assert(c, m) { if (!c) { console.error('  ✗ FAIL:', m); process.exitCode = 1; } else console.log('  ✓', m); }

function game() {
  return {
    timeImpulsi: 100, reputation: 50, _cr: 5000,
    galaxy: { seed: 'CT', systems: [{ links: [1] }, { links: [0] }] },
    civs: [{ id: 'mek', name: 'Mekhari', faction: 'mekhari', alive: true,
             knowledge: 'spotted', interactions: 0, planets: ['1:b0'], systems: [1], power: 80, disposition: 0 }]
  };
}

/* Replica la guardia usata in aifleet.markCivFlagSeen / ai.js (spotted→contact). */
function mekhariEncounter(g) {
  const civ = g.civs[0];
  const KN = AI.KNOWLEDGE || { contacted: 2 };
  if (civ.faction === 'mekhari' && AI.knowledgeRank(civ) < KN.contacted) {
    AI.markContact(g, civ, [], 'mekhari-network');
  }
}

console.log('— Test 1: prima del contatto il mercato grigio è chiuso');
{
  const g = game();
  assert(MK.isAvailable(g) === false, 'Mekhari solo "spotted" → mercato non disponibile');
}

console.log('— Test 2: incrocio/hub Mekhari → contattato + mercato aperto');
{
  const g = game();
  mekhariEncounter(g);
  assert(g.civs[0].knowledge === 'contacted', 'promosso a "contattato"');
  assert(g.civs[0].interactions === 1, 'una sola interazione registrata');
  assert(MK.isAvailable(g) === true, 'mercato grigio + intel ora disponibili');
}

console.log('— Test 3: incontri ripetuti NON gonfiano le interazioni');
{
  const g = game();
  for (let i = 0; i < 10; i++) mekhariEncounter(g); // come 10 tick con la flotta in vista
  assert(g.civs[0].interactions === 1, 'interactions resta 1 (guardia rank<contacted)');
  assert(g.civs[0].knowledge === 'contacted', 'resta "contattato", NON fast-track a "conosciuta"');
}

if (!process.exitCode) console.log('\n✓ Tutti i test passati');
