/* =====================================================================
   Test headless — Equipaggio caduto con la nave in combattimento.
   Esegui con:  node test-crew-loss.js
   Verifica (decisione utente 2026-06-26):
     1. Una nave distrutta in battaglia uccide il suo complemento crew.
     2. L'equipaggio in ECCEDENZA oltre il complemento sopravvive.
     3. Estrazione PESATA verso i meno esperti (i veterani si salvano più spesso).
     4. Determinismo (#5): stesso seed/impulso → stessi caduti (replay-safe).
     5. Cap recovery-friendly: mai crew negativo se le navi perse > crew a bordo.
     6. applyDefenderWriteback (assedi) applica la stessa logica per-flotta.
   ===================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const root = { console: console, Math: Math };
function runFile(rel) {
  const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
  /* L'IIFE dei moduli si chiude su (typeof window !== 'undefined' ? window : this).
     Chiamando con `.call(root)`, `window` è indefinito → usa `this` = root. */
  (new Function(src)).call(root);
}

/* Classi nave minime (sottoinsieme di js/fleet.js → CLASSES). fp serve al
   targeting (scudo) e alla risoluzione; crew/popCargo alle perdite. */
const CLASSES = {
  explorer:    { id: 'explorer',    kind: 'explorer',    hp: 20,  fp: 2,  crew: 1 },
  estrattore:  { id: 'estrattore',  kind: 'estrattore',  hp: 35,  fp: 0,  crew: 1 },
  caccia:      { id: 'caccia',      kind: 'caccia',      hp: 30,  fp: 5,  crew: 1 },
  intercettore:{ id: 'intercettore',kind: 'intercettore',hp: 45,  fp: 8,  crew: 2 },
  corvetta:    { id: 'corvetta',    kind: 'corvetta',    hp: 80,  fp: 12, crew: 4 },
  fregata:     { id: 'fregata',     kind: 'fregata',     hp: 160, fp: 25, crew: 8 },
  coloniale:   { id: 'coloniale',   kind: 'coloniale',   hp: 70,  fp: 0,  crew: 4, popCargo: 2 }
};

runFile('js/rng.js');
root.ORION.fleet = { getClass: function (k) { return CLASSES[k]; } };
runFile('js/combat.js');

const ORION = root.ORION;
const C = ORION.combat;

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error('  ✗ FAIL:', msg); failures++; process.exitCode = 1; }
  else console.log('  ✓', msg);
}

let shipSeq = 0;
function ship(kind, xp) { return { id: 'sh' + (++shipSeq), kind: kind, hp: CLASSES[kind].hp, xp: xp || 0 }; }
function crew(xp) { return { id: 'cr' + (++shipSeq), xp: xp || 0 }; }

/* Costruisce una `force` (lato del giocatore) i cui combatants sono i
   SOPRAVVISSUTI: applyOutcomeToFleet considera persa ogni nave non presente. */
function forceOfSurvivors(survivors) {
  return { combatants: survivors.map(function (s) { return { id: s.id, hp: s.hp }; }) };
}

console.log('— Test 1: complemento della nave persa muore (1 explorer + 4 caccia → perdo 2)');
{
  const ships = [ship('explorer', 0), ship('caccia', 1), ship('caccia', 1), ship('caccia', 1), ship('caccia', 1)];
  const fleet = { id: 'f1', ships: ships.slice(), crew: [crew(0), crew(1), crew(2), crew(3), crew(4)] };
  // sopravvivono 3 caccia (perdo explorer + 1 caccia → crewCost 1+1 = 2)
  const survivors = [ships[2], ships[3], ships[4]];
  const out = C.applyOutcomeToFleet({ seed: 'S', timeImpulsi: 10 }, fleet, forceOfSurvivors(survivors));
  assert(out.lost === 2, 'navi perse = 2 (got ' + out.lost + ')');
  assert(fleet.ships.length === 3, 'navi rimaste = 3 (got ' + fleet.ships.length + ')');
  assert(out.crewLost === 2, 'equipaggi persi = 2 (got ' + out.crewLost + ')');
  assert(fleet.crew.length === 3, 'equipaggi rimasti = 3 (got ' + fleet.crew.length + ')');
}

console.log('\n— Test 2: corvetta (crew 4) distrutta uccide 4 equipaggi');
{
  const ships = [ship('corvetta', 0), ship('caccia', 0)];
  const fleet = { id: 'f2', ships: ships.slice(), crew: [crew(0), crew(0), crew(0), crew(0), crew(0)] };
  // sopravvive solo il caccia → persa la corvetta (crewCost 4)
  const out = C.applyOutcomeToFleet({ seed: 'S', timeImpulsi: 3 }, fleet, forceOfSurvivors([ships[1]]));
  assert(out.crewLost === 4, 'equipaggi persi = 4 (got ' + out.crewLost + ')');
  assert(fleet.crew.length === 1, 'equipaggi rimasti = 1 (got ' + fleet.crew.length + ')');
}

console.log('\n— Test 3: equipaggio in eccedenza sopravvive (5 navi, 7 crew, perdo 1 caccia)');
{
  const ships = [ship('caccia', 0), ship('caccia', 0), ship('caccia', 0), ship('caccia', 0), ship('caccia', 0)];
  const fleet = { id: 'f3', ships: ships.slice(), crew: [crew(0), crew(0), crew(0), crew(0), crew(0), crew(0), crew(0)] };
  const out = C.applyOutcomeToFleet({ seed: 'S', timeImpulsi: 1 }, fleet, forceOfSurvivors(ships.slice(0, 4)));
  assert(out.crewLost === 1, 'solo 1 equipaggio perso (got ' + out.crewLost + ')');
  assert(fleet.crew.length === 6, '6 equipaggi rimasti, eccedenza salva (got ' + fleet.crew.length + ')');
}

console.log('\n— Test 4: cap recovery-friendly (navi perse pesano più del crew a bordo)');
{
  const ships = [ship('corvetta', 0), ship('corvetta', 0)]; // crewCost perso = 4+4 = 8
  const fleet = { id: 'f4', ships: ships.slice(), crew: [crew(0), crew(0), crew(0)] }; // solo 3 crew
  const out = C.applyOutcomeToFleet({ seed: 'S', timeImpulsi: 2 }, fleet, forceOfSurvivors([]));
  assert(out.crewLost === 3, 'capato al crew disponibile = 3 (got ' + out.crewLost + ')');
  assert(fleet.crew.length === 0, 'nessun crew negativo (got ' + fleet.crew.length + ')');
}

console.log('\n— Test 5: determinismo (stesso seed/impulso → stessi caduti)');
{
  function run() {
    const ships = [ship('caccia', 0), ship('caccia', 0), ship('caccia', 0), ship('caccia', 0)];
    // crew con id stabili per confronto
    const cr = [{ id: 'A', xp: 5 }, { id: 'B', xp: 0 }, { id: 'C', xp: 0 }, { id: 'D', xp: 3 }];
    const fleet = { id: 'fdet', ships: ships.slice(), crew: cr.map(function (c) { return { id: c.id, xp: c.xp }; }) };
    C.applyOutcomeToFleet({ seed: 'FIXED', timeImpulsi: 42 }, fleet, forceOfSurvivors([ships[0], ships[1]]));
    return fleet.crew.map(function (c) { return c.id; }).sort().join(',');
  }
  const a = run(), b = run();
  assert(a === b, 'due esecuzioni → stessi superstiti (' + a + ' === ' + b + ')');
}

console.log('\n— Test 6: preponderanza verso i meno esperti (veterano sopravvive più spesso)');
{
  // 1 veterano (xp 20) + 5 reclute (xp 0). Perdo 5 navi su 6 → muoiono 5 crew su 6.
  // Il veterano dovrebbe sopravvivere nella stragrande maggioranza dei seed.
  let vetSurvived = 0;
  const N = 200;
  for (let s = 0; s < N; s++) {
    const ships = [];
    for (let i = 0; i < 6; i++) ships.push(ship('caccia', 0));
    const cr = [{ id: 'VET', xp: 20 }];
    for (let i = 0; i < 5; i++) cr.push({ id: 'rk' + i, xp: 0 });
    const fleet = { id: 'fbias' + s, ships: ships.slice(), crew: cr };
    C.applyOutcomeToFleet({ seed: 'BIAS', timeImpulsi: s }, fleet, forceOfSurvivors([ships[0]]));
    if (fleet.crew.some(function (c) { return c.id === 'VET'; })) vetSurvived++;
  }
  const rate = vetSurvived / N;
  console.log('    veterano sopravvissuto in ' + vetSurvived + '/' + N + ' (' + (rate * 100).toFixed(0) + '%)');
  // Senza bias ci si aspetta ~ (1/6 muore) → veterano sopravvive ~ ? In realtà
  // muoiono 5 su 6: senza peso il veterano sopravvive ~1/6 (17%). Col peso 1/(xp+1)
  // il veterano (peso 1/21) è quasi sempre risparmiato → atteso >> 60%.
  assert(rate > 0.6, 'veterano risparmiato nella maggioranza dei casi (>60%, got ' + (rate * 100).toFixed(0) + '%)');
}

console.log('\n— Test 7: applyDefenderWriteback (assedio) uccide il crew per-flotta');
{
  const cFighter = ship('caccia', 0);
  const cExpl = ship('explorer', 0);
  const fleet = { id: 'fsiege', ships: [cFighter, cExpl], crew: [crew(0), crew(0)] };
  // due combatants distrutti, entrambi della stessa flotta
  const destroyed = [
    { src: { type: 'ship', fleet: fleet, ref: cFighter } },
    { src: { type: 'ship', fleet: fleet, ref: cExpl } }
  ];
  const wb = C.applyDefenderWriteback({ seed: 'S', timeImpulsi: 7 }, null, [], destroyed);
  assert(wb.shipsLost === 2, 'navi perse difesa = 2 (got ' + wb.shipsLost + ')');
  assert(wb.crewLost === 2, 'equipaggi persi difesa = 2 (got ' + wb.crewLost + ')');
  assert(fleet.ships.length === 0 && fleet.crew.length === 0, 'flotta svuotata (navi+crew)');
}

/* Combatant per resolveRound (lato giocatore: src.type 'ship' → schermabile). */
function shipCombatant(kind) {
  return { id: 'c' + (++shipSeq), kind: kind, hp: CLASSES[kind].hp, maxHp: CLASSES[kind].hp,
    fp: CLASSES[kind].fp, xp: 0, src: { type: 'ship' } };
}
function enemyForce(fp) {
  return { side: 'B', name: 'Predoni', immobile: false, formation: 'balanced',
    combatants: [{ id: 'enemy', kind: 'predone', hp: 100000, maxHp: 100000, fp: fp, xp: 0, src: { type: 'pirate' } }] };
}
function playerForce(kinds) {
  return { side: 'A', name: 'Flotta', immobile: false, formation: 'aggressive',
    combatants: kinds.map(shipCombatant) };
}

console.log('\n— Test 8: scudo — i civili (Pioniere/esploratore) non muoiono se resta una nave da guerra');
{
  let violations = 0;
  for (let s = 0; s < 80; s++) {
    const A = playerForce(['caccia', 'explorer', 'coloniale']);
    const B = enemyForce(28); // ~ uccide al più 1 nave per round
    const rng = ORION.rng.makeRng('SCREEN:' + s);
    const r = C.resolveRound(rng, A, B);
    const deadKinds = r.destroyedA.map(function (c) { return c.kind; });
    const cacciaAlive = A.combatants.some(function (c) { return c.kind === 'caccia'; });
    // se un civile è morto MA il caccia è ancora vivo → violazione dello scudo
    if ((deadKinds.indexOf('explorer') >= 0 || deadKinds.indexOf('coloniale') >= 0) && cacciaAlive) violations++;
  }
  assert(violations === 0, 'mai un civile distrutto con la scorta ancora viva (violazioni: ' + violations + ')');
}

console.log('\n— Test 9: ordine ~crescente per stazza, con varianza (non sempre lineare)');
{
  // 4 navi da guerra; danno per ~2 vittime. Atteso: cadono per lo più le piccole
  // (caccia/intercettore), la fregata quasi mai; ma con qualche eccezione (jitter).
  let cacciaDead = 0, fregataDead = 0, exactSmallTwo = 0;
  const N = 300;
  for (let s = 0; s < N; s++) {
    const A = playerForce(['caccia', 'intercettore', 'corvetta', 'fregata']);
    const B = enemyForce(78); // ~ caccia(30)+intercettore(45)
    const rng = ORION.rng.makeRng('ORDER:' + s);
    const r = C.resolveRound(rng, A, B);
    const dead = r.destroyedA.map(function (c) { return c.kind; }).sort().join(',');
    if (dead.indexOf('caccia') >= 0) cacciaDead++;
    if (dead.indexOf('fregata') >= 0) fregataDead++;
    if (dead === 'caccia,intercettore') exactSmallTwo++;
  }
  console.log('    caccia morto ' + cacciaDead + '/' + N + ' · fregata morta ' + fregataDead + '/' + N +
    ' · esito {caccia,intercettore} ' + exactSmallTwo + '/' + N);
  assert(cacciaDead / N > 0.8, 'la nave più piccola (caccia) cade quasi sempre (>80%)');
  assert(fregataDead / N < 0.2, 'la più grande (fregata) cade raramente (<20%)');
  assert(exactSmallTwo > 0 && exactSmallTwo < N, 'ordine prevalente ma NON sempre identico (jitter presente)');
}

console.log('\n— Test 10: i coloni muoiono col Pioniere distrutto (tutti se è l\'unico vettore)');
{
  const ships = [ship('coloniale', 0), ship('caccia', 0)];
  const fleet = { id: 'fcol', ships: ships.slice(), crew: [crew(0), crew(0), crew(0), crew(0), crew(0)], popOnboard: 2 };
  // sopravvive il caccia → perso il Pioniere
  const out = C.applyOutcomeToFleet({ seed: 'S', timeImpulsi: 1 }, fleet, forceOfSurvivors([ships[1]]));
  assert(out.colonistsLost === 2, 'coloni persi = 2 (got ' + out.colonistsLost + ')');
  assert(fleet.popOnboard === 0, 'popOnboard azzerato (got ' + fleet.popOnboard + ')');
}

console.log('\n— Test 11: con 2 Pionieri, perderne 1 uccide la quota proporzionale dei coloni');
{
  const ships = [ship('coloniale', 0), ship('coloniale', 0), ship('caccia', 0)];
  const fleet = { id: 'fcol2', ships: ships.slice(), crew: [crew(0), crew(0)], popOnboard: 4 };
  // sopravvivono 1 Pioniere + caccia → perso 1 Pioniere su 2
  const out = C.applyOutcomeToFleet({ seed: 'S', timeImpulsi: 1 }, fleet, forceOfSurvivors([ships[1], ships[2]]));
  assert(out.colonistsLost === 2, 'coloni persi = 4×1/2 = 2 (got ' + out.colonistsLost + ')');
  assert(fleet.popOnboard === 2, 'restano 2 livelli sul Pioniere superstite (got ' + fleet.popOnboard + ')');
}

console.log('\n— Test 12: perdere una nave NON coloniale non tocca i coloni');
{
  const ships = [ship('coloniale', 0), ship('caccia', 0)];
  const fleet = { id: 'fcol3', ships: ships.slice(), crew: [crew(0), crew(0)], popOnboard: 2 };
  // sopravvive il Pioniere → perso il caccia
  const out = C.applyOutcomeToFleet({ seed: 'S', timeImpulsi: 1 }, fleet, forceOfSurvivors([ships[0]]));
  assert(out.colonistsLost === 0, 'nessun colono perso (got ' + out.colonistsLost + ')');
  assert(fleet.popOnboard === 2, 'popOnboard invariato (got ' + fleet.popOnboard + ')');
}

console.log('\n' + (failures === 0 ? '✅ Tutti i test superati.' : '❌ ' + failures + ' test falliti.'));
