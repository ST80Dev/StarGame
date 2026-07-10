/* =====================================================================
   Test headless — Scontro ALLA PARI con flotte AI in rotta (2026-07-10).
   node test-aifleet-engage.js
   Verifica il nuovo motore di ingaggio (combat.js) che rende
   l'intercettazione di una flotta AI mobile una battaglia a round come gli
   scontri a postazioni fisse (M09):
     1. forceFromAiFleet: costruisce una forza reale dal roster af.ships,
        con id stabili e hp lazy dalle stat di classe.
     2. resolve produce un vero report (winner, rounds, sideA/sideB, log).
     3. Parità: una flotta player debole PUÒ perdere navi contro una AI forte.
     4. applyOutcomeToAiFleet: la AI battuta ma viva CONSERVA le superstiti
        (ritirata, opzione 2A) e ricalcola af.fp; azzerata → 0 navi.
     5. Determinismo (#5): stesso seed + stessa forza → stesso esito.
   ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const root = { console: console };
function load(rel) {
  const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
  return eval('(function(globalThis, window){' + src + '\nreturn globalThis.ORION;})')(root, root);
}
load('js/rng.js');
load('js/utils.js');
load('js/fleet.js');
const ORION = load('js/combat.js');
const C = ORION.combat;

let pass = 0;
function assert(c, m) { if (!c) { console.error('  ✗ FAIL:', m); process.exitCode = 1; throw new Error(m); } console.log('  ✓', m); pass++; }

function game(seed) {
  return { seed: seed || 'T', timeImpulsi: 100, galaxy: { systems: {} }, civs: [], fleets: [] };
}
function playerFleet(id, kinds) {
  return { id: id, name: 'Vanguard', formation: 'balanced',
    ships: kinds.map(function (k, i) { return { id: id + '-s' + i, kind: k, hp: null, xp: 0 }; }),
    crew: kinds.map(function (_, i) { return { id: 'c' + i, xp: 0 }; }) };
}
function aiFleet(id, kinds, civId) {
  return { id: id, civId: civId || null, civName: 'Ignoti', civColor: '#e0556e',
    ships: kinds.map(function (k) { return { kind: k }; }), fp: 0, homeSysId: 0, systemId: 3, status: 'orbiting' };
}

console.log('1) forceFromAiFleet — roster reale, id stabili, hp lazy');
(function () {
  const g = game();
  const af = aiFleet('aif-1', ['caccia', 'caccia', 'intercettore']);
  const B = C.forceFromAiFleet(g, af, 'B');
  assert(B.combatants.length === 3, 'una combatant per nave');
  assert(af.ships.every(function (s) { return typeof s.id === 'string' && s.id; }), 'id assegnati alle navi AI');
  const cls = ORION.fleet.getClass('caccia');
  assert(B.combatants[0].hp === cls.hp && B.combatants[0].fp === cls.fp, 'hp/fp dalle stat di classe');
  assert(B.side === 'B' && B.combatants[0].src.type === 'aifleet', 'src taggato aifleet per writeback');
})();

console.log('2) resolve — report reale, player forte vince; la AI perde/si ritira');
(function () {
  const g = game();
  const pf = playerFleet('pf-1', ['corvetta', 'corvetta', 'fregata']); // forte
  const af = aiFleet('aif-2', ['caccia', 'caccia']);                    // debole
  const A = C.forceFromFleet(g, pf, 'A');
  const B = C.forceFromAiFleet(g, af, 'B');
  const rep = C.resolve(g, 'aifleet:' + af.id + ':' + g.timeImpulsi, A, B);
  assert(rep && rep.rounds >= 1 && Array.isArray(rep.log), 'report con round e log');
  assert(rep.sideA && rep.sideB && rep.sideB.name === 'Ignoti', 'sommari sideA/sideB');
  assert(rep.winner === 'A', 'player forte vince');
  const outB = C.applyOutcomeToAiFleet(af, B);
  assert(outB.lost >= 1 || af.ships.every(function (s) { return s.hp < ORION.fleet.getClass('caccia').hp; }),
    'la AI subisce perdite reali (navi perse o scafi danneggiati)');
  const expFp = af.ships.reduce(function (n, s) { return n + (ORION.fleet.getClass(s.kind).fp || 0); }, 0);
  assert(af.fp === expFp, 'af.fp ricalcolato sulle superstiti (' + af.fp + ')');
})();

console.log('3) Parità — player debole PUÒ perdere navi; AI forte sopravvive e si ritira');
(function () {
  const g = game();
  const pf = playerFleet('pf-3', ['caccia']);                                   // debolissimo
  const af = aiFleet('aif-3', ['fregata', 'fregata', 'corvetta', 'corvetta']);  // forte
  const A = C.forceFromFleet(g, pf, 'A');
  const B = C.forceFromAiFleet(g, af, 'B');
  const hp0 = ORION.fleet.getClass('caccia').hp;
  const rep = C.resolve(g, 'aifleet:' + af.id + ':' + g.timeImpulsi, A, B);
  const outA = C.applyOutcomeToFleet(g, pf, A);
  C.applyOutcomeToAiFleet(af, B);
  assert(rep.winner === 'B', 'la AI forte prevale');
  const playerHurt = (pf.ships.length === 0) || (pf.ships[0].hp < hp0);
  assert(playerHurt, 'la flotta player subisce danni/perdite reali (parità, non più floor 1 immune)');
  assert(af.ships.length > 0, 'la AI sopravvive → può ritirarsi (opzione 2A)');
})();

console.log('4) Determinismo — stesso seed + stessa forza → stesso esito');
(function () {
  function run() {
    const g = game('DET');
    const pf = playerFleet('pf-d', ['corvetta', 'intercettore']);
    const af = aiFleet('aif-d', ['caccia', 'caccia', 'caccia']);
    const A = C.forceFromFleet(g, pf, 'A');
    const B = C.forceFromAiFleet(g, af, 'B');
    const rep = C.resolve(g, 'aifleet:' + af.id + ':' + g.timeImpulsi, A, B);
    C.applyOutcomeToFleet(g, pf, A);
    C.applyOutcomeToAiFleet(af, B);
    return { winner: rep.winner, rounds: rep.rounds, pfShips: pf.ships.length, afShips: af.ships.length,
      log: JSON.stringify(rep.log) };
  }
  const a = run(), b = run();
  assert(a.winner === b.winner && a.rounds === b.rounds, 'winner+rounds identici');
  assert(a.pfShips === b.pfShips && a.afShips === b.afShips, 'navi superstiti identiche');
  assert(a.log === b.log, 'log di battaglia identico round-per-round');
})();

console.log('\nTutti i test superati (' + pass + ' asserzioni).');
