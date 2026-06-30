/* =====================================================================
   M19 §13.7/§13.10 — Test contatto automatico Vehryn (decisione utente
   2026-06-30). Esegui con:  node test-vehryn-contact.js
   Verifica:
     1. markContact reale promuove una civ a "contattato" (+1 interazione).
     2. La guardia rank<contacted impedisce di richiamare markContact ogni
        tick → niente inflazione di civ.interactions (fast-track a "Conosciuta").
     3. Una volta contattati, vehryn.isAvailable() = true (sblocca vendita
        informazioni); prima è false.
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
root.ORION.diplomacy = { reputation: g => g.reputation, adjustReputation: (g, d) => { g.reputation = Math.max(0, Math.min(100, g.reputation + d)); } };
const ORION = load('js/vehryn.js');
const AI = ORION.ai, V = ORION.vehryn;

function assert(c, m) { if (!c) { console.error('  ✗ FAIL:', m); process.exitCode = 1; } else console.log('  ✓', m); }

function game() {
  return {
    timeImpulsi: 100, reputation: 50, _cr: 5000,
    galaxy: { seed: 'CT', systems: [{ links: [1] }, { links: [0] }] },
    civs: [{ id: 'veh', name: 'Vehryn', faction: 'vehryn', alive: true,
             knowledge: 'spotted', interactions: 0, planets: ['1:b0'], systems: [1], power: 80, disposition: 0 }]
  };
}

/* Replica la guardia usata in aifleet.markCivFlagSeen / ai.js (spotted→contact). */
function vehrynEncounter(g) {
  const civ = g.civs[0];
  const KN = AI.KNOWLEDGE || { contacted: 2 };
  if (civ.faction === 'vehryn' && AI.knowledgeRank(civ) < KN.contacted) {
    AI.markContact(g, civ, [], 'vehryn-network');
  }
}

console.log('— Test 1: prima del contatto la vendita info è chiusa');
{
  const g = game();
  assert(V.isAvailable(g) === false, 'Vehryn solo "spotted" → vendita non disponibile');
}

console.log('— Test 2: incrocio/avamposto Vehryn → contattato + canale aperto');
{
  const g = game();
  vehrynEncounter(g);
  assert(g.civs[0].knowledge === 'contacted', 'promosso a "contattato"');
  assert(g.civs[0].interactions === 1, 'una sola interazione registrata');
  assert(V.isAvailable(g) === true, 'vendita informazioni ora disponibile');
}

console.log('— Test 3: incontri ripetuti NON gonfiano le interazioni');
{
  const g = game();
  for (let i = 0; i < 10; i++) vehrynEncounter(g);
  assert(g.civs[0].interactions === 1, 'interactions resta 1 (guardia rank<contacted)');
  assert(g.civs[0].knowledge === 'contacted', 'resta "contattato", NON fast-track a "conosciuta"');
}

if (!process.exitCode) console.log('\n✓ Tutti i test passati');
