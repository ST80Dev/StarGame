/* =====================================================================
   M19 — Test headless per il segno morale dello spionaggio
   (decisione 2026-06-26 "atti di luce e ombra").
   Esegui con:  node test-espionage-morality.js
   Verifica:
     1. targetMoralClass classifica benign / evil / neutral dai soli dati
        esistenti (alignment + relation + betrayalOutlook).
     2. Infiltrazione = atto NEUTRO: ombra solo contro un amico/benevolo.
     3. Sabotaggio/Furto = atti lesivi: ombra SEMPRE ≥ pavimento, magnitudo
        crescente verso bersagli innocenti, mai zero contro un maligno.
     4. resolve(): il karma scatta SOLO sul successo; il fallimento colpisce
        reputazione/ICG ma NON l'inclinazione morale.
     5. Determinismo: stesso seed + stesso armI → stesso esito (replay-safe).
   ===================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

/* Carica rng.js, victory.js, espionage.js nello STESSO namespace ORION finto
   (così espionage trova ORION.victory.applyAlignment e ORION.rng.makeRng). */
const root = { console: console };
function load(rel) {
  const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
  const wrap = '(function(globalThis, window){' + src + '\nreturn globalThis.ORION;})';
  return eval(wrap)(root, root);
}
load('js/rng.js');
load('js/victory.js');
const ORION = load('js/espionage.js');

function assert(cond, msg) {
  if (!cond) { console.error('  ✗ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  console.log('  ✓', msg);
}

function fakeGame() {
  return { seed: 'TST', timeImpulsi: 100, reputation: 50, icg: 20,
           alignmentDeeds: { light: 0, dark: 0 }, civs: [], fleets: [] };
}
function civ(over) {
  return Object.assign({ id: 'c1', name: 'Rivali', alive: true, alignment: null,
                         relation: 'peace', disposition: 0, power: 100 }, over || {});
}

const E = ORION.espionage;

console.log('— Test 1: targetMoralClass');
{
  const g = fakeGame();
  assert(E._targetMoralClass(g, civ({ alignment: 'bene' })) === 'benign', 'fazione benevola → benign');
  assert(E._targetMoralClass(g, civ({ relation: 'alliance' })) === 'benign', 'alleato (anche non-bene) → benign');
  assert(E._targetMoralClass(g, civ({ alignment: 'male' })) === 'evil', 'fazione maligna → evil');
  assert(E._targetMoralClass(g, civ({ relation: 'war' })) === 'evil', 'in guerra con te → evil (aggressore)');
  assert(E._targetMoralClass(g, civ({})) === 'neutral', 'neutrale in pace → neutral');
  /* L'alleanza vince sull'allineamento maligno (tradimento della fiducia). */
  assert(E._targetMoralClass(g, civ({ alignment: 'male', relation: 'alliance' })) === 'benign',
    'alleato maligno → benign (spiarlo è tradire l\'alleanza)');
}

console.log('\n— Test 2: Infiltrazione = atto neutro (ombra solo contro amici)');
{
  const g = fakeGame();
  assert(E._darkAmountFor(g, civ({ alignment: 'bene' }), 'infiltrate') === 1, 'infiltrare un benevolo → ombra lieve (1)');
  assert(E._darkAmountFor(g, civ({ relation: 'alliance' }), 'infiltrate') === 1, 'infiltrare un alleato → ombra lieve (1)');
  assert(E._darkAmountFor(g, civ({ alignment: 'male' }), 'infiltrate') === 0, 'infiltrare un maligno → 0 (autodifesa)');
  assert(E._darkAmountFor(g, civ({ relation: 'war' }), 'infiltrate') === 0, 'infiltrare un aggressore → 0');
  assert(E._darkAmountFor(g, civ({}), 'infiltrate') === 0, 'infiltrare un neutrale → 0');
}

console.log('\n— Test 3: Sabotaggio/Furto = ombra sempre ≥ pavimento');
{
  const g = fakeGame();
  ['sabotage', 'steal'].forEach(function (t) {
    const base = E.CFG[t === 'sabotage' ? 'SABOTAGE' : 'STEAL'].alignBase; // 2
    assert(E._darkAmountFor(g, civ({ alignment: 'bene' }), t) === base + 1, t + ' su innocente → ombra piena (' + (base + 1) + ')');
    assert(E._darkAmountFor(g, civ({}), t) === base, t + ' su neutrale → ombra base (' + base + ')');
    const evil = E._darkAmountFor(g, civ({ alignment: 'male' }), t);
    assert(evil === Math.max(1, base - 1), t + ' su maligno → ombra attenuata (' + evil + ')');
    assert(evil >= 1, t + ' su maligno → MAI zero (la via al Tiranno resta aperta)');
  });
}

console.log('\n— Test 4: resolve() — karma solo sul successo, non sul fallimento');
{
  /* Cerco due seed/armI: uno che dà successo e uno che dà fallimento, a parità
     di probabilità, per esercitare entrambi i rami in modo deterministico. */
  function runInfiltrateMalign(armI) {
    const g = fakeGame();
    const c = civ({ alignment: 'male' });   // infiltrare un maligno → atto neutro
    g.civs.push(c);
    const op = { id: 1, civId: c.id, sysId: 0, type: 'infiltrate', armI: armI };
    const events = [];
    E._resolve(g, op, c, { score: 0 }, events);
    return { g: g, c: c, ok: events[0].ok };
  }
  let sawWin = false, sawFail = false;
  for (let a = 0; a < 40 && !(sawWin && sawFail); a++) {
    const r = runInfiltrateMalign(a);
    if (r.ok) {
      sawWin = true;
      assert(r.g.alignmentDeeds.dark === 0, 'infiltrazione RIUSCITA su maligno → karma d\'ombra 0 (atto neutro)');
    } else {
      sawFail = true;
      assert(r.g.alignmentDeeds.dark === 0, 'infiltrazione SCOPERTA → karma d\'ombra 0 (non il karma)');
      assert(r.g.reputation < 50, 'infiltrazione SCOPERTA → reputazione scende');
    }
  }
  assert(sawWin && sawFail, 'esercitati entrambi i rami successo/fallimento');

  /* Sabotaggio riuscito su innocente → karma pieno applicato una volta. */
  function runSabotageInnocent(armI) {
    const g = fakeGame();
    const c = civ({ alignment: 'bene' });
    g.civs.push(c);
    const op = { id: 1, civId: c.id, sysId: 0, type: 'sabotage', armI: armI };
    const events = [];
    E._resolve(g, op, c, { score: 99 }, events); // score alto → p alta → più probabile successo
    return { g: g, ok: events[0].ok };
  }
  let checkedWin = false;
  for (let a = 0; a < 40 && !checkedWin; a++) {
    const r = runSabotageInnocent(a);
    if (r.ok) {
      checkedWin = true;
      assert(r.g.alignmentDeeds.dark === 3, 'sabotaggio RIUSCITO su innocente → ombra piena (3)');
    }
  }
  assert(checkedWin, 'trovato almeno un sabotaggio riuscito da verificare');
}

console.log('\n— Test 5: determinismo (stesso seed + armI → stesso esito)');
{
  function run() {
    const g = fakeGame();
    const c = civ({ alignment: 'bene' });
    g.civs.push(c);
    const events = [];
    E._resolve(g, { id: 1, civId: c.id, sysId: 0, type: 'sabotage', armI: 7 }, c, { score: 5 }, events);
    return { ok: events[0].ok, dark: g.alignmentDeeds.dark, rep: g.reputation, power: c.power };
  }
  const a = run(), b = run();
  assert(a.ok === b.ok && a.dark === b.dark && a.rep === b.rep && a.power === b.power,
    'due esecuzioni identiche → esito identico (replay-safe)');
}

console.log('\n✓ Tutti i test superati.');
