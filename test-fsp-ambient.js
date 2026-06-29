/* =====================================================================
   Test headless — Campo di prossimità FSP (richiesta utente 2026-06-29).
   Esegui con:  node test-fsp-ambient.js
   Verifica:
     1. legField agisce SOLO se il leg tocca la zona (nearSys + entro 1 hop).
     2. Firme per classe: grav = malus (rallenta/usura); relic/emis hanno
        canali boon (segno negativo).
     3. Cap aggregato rispettato con overlap di più FSP.
     4. Determinismo: stesso seed/istanza → stesso campo; wildcard temporale
        stabile per istanza.
     5. noteAmbientFelt: emette UNA volta il nudge per FSP non classificato,
        marca `_felt`, e NON emette per FSP già classificato.
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
const ORION = load('js/phenomena.js');
const PH = ORION.phenomena;

function assert(cond, msg) {
  if (!cond) { console.error('  ✗ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  console.log('  ✓', msg);
}
function approx(a, b, eps) { return Math.abs(a - b) <= (eps == null ? 1e-9 : eps); }

/* Galassia finta: grafo lineare 0-1-2-3-4-5. _phenomena è settato a mano
   così forGalaxy() non rigenera (bypassa la generazione dal seed). */
function lineGalaxy(phenomena) {
  const systems = [];
  for (let i = 0; i < 6; i++) {
    const links = [];
    if (i > 0) links.push(i - 1);
    if (i < 5) links.push(i + 1);
    systems.push({ id: i, name: 'S' + i, x: i * 0.1, y: 0.5, danger: 0, links: links });
  }
  return { seed: 'TST', systems: systems, groups: [], _phenomena: phenomena };
}
function fsp(over) {
  return Object.assign({ id: 'P0', cls: 'grav', variant: 'maelstrom', nearSys: 2,
    intensity: 1, unique: false, tenor: -0.2, effectSeed: 'TST:phenom:P0' }, over || {});
}

console.log('— Test 1: zona = nearSys + entro 1 hop');
{
  const gx = lineGalaxy([fsp()]); // grav su nearSys=2 → zona {1,2,3}
  const inZone = PH.legField(gx, 2, 3);   // entrambe in zona
  const edge   = PH.legField(gx, 0, 1);   // 1 è vicino di 2 → in zona
  const out    = PH.legField(gx, 4, 5);   // 4,5 fuori zona
  assert(inZone.ids.length === 1 && inZone.dragMul > 1, 'leg interno alla zona → campo attivo (drag>1)');
  assert(edge.ids.length === 1, 'leg con un estremo a 1 hop dall\'aggancio → campo attivo');
  assert(out.ids.length === 0 && out.dragMul === 1 && out.wearMul === 1,
    'leg fuori zona → nessun effetto (moltiplicatori = 1)');
  assert(PH.within1Hop(gx, 2, 2) && PH.within1Hop(gx, 1, 2) && PH.within1Hop(gx, 3, 2) && !PH.within1Hop(gx, 4, 2),
    'within1Hop: nearSys e vicini sì, 2 hop no');
}

console.log('\n— Test 2: firme per classe (malus grav, boon relic/emis)');
{
  const grav  = PH.legField(lineGalaxy([fsp({ cls: 'grav' })]), 2, 3);
  const relic = PH.legField(lineGalaxy([fsp({ cls: 'relic', tenor: 0.3 })]), 2, 3);
  const emis  = PH.legField(lineGalaxy([fsp({ cls: 'emis', tenor: 0.1 })]), 2, 3);
  assert(grav.dragMul > 1 && grav.wearMul > 1,
    'grav: rallenta e usura di più (malus su entrambi i canali)');
  assert(relic.wearMul < 1,
    'relic: meno usura (riparo/acque calme = boon)');
  assert(emis.dragMul < 1 && emis.wearMul > 1,
    'emis: più veloce (boon viaggio) ma un filo di usura da radiazioni');
}

console.log('\n— Test 3: cap aggregato con overlap');
{
  const two = PH.legField(lineGalaxy([
    fsp({ id: 'P0', cls: 'grav', effectSeed: 'A' }),
    fsp({ id: 'P1', cls: 'grav', effectSeed: 'B' })
  ]), 2, 3);
  assert(two.ids.length === 2, 'due grav sovrapposti → entrambi contano');
  assert(approx(two.drag, PH.AMBIENT.DRAG_CAP) && two.dragMul <= 1 + PH.AMBIENT.DRAG_CAP + 1e-9,
    'drag aggregato cappato a DRAG_CAP (non esplode con l\'overlap)');
  assert(two.wear <= PH.AMBIENT.WEAR_CAP_UP + 1e-9,
    'wear aggregato entro il cap');
}

console.log('\n— Test 4: determinismo + wildcard temporale stabile');
{
  const gxA = lineGalaxy([fsp({ cls: 'temp', tenor: 0 })]);
  const gxB = lineGalaxy([fsp({ cls: 'temp', tenor: 0 })]);
  const a1 = PH.legField(gxA, 2, 3), a2 = PH.legField(gxA, 2, 3);
  const b1 = PH.legField(gxB, 2, 3);
  assert(a1.dragMul === a2.dragMul && a1.wearMul === a2.wearMul,
    'stessa istanza → campo identico (cache segno wildcard, nessun drift)');
  assert(a1.dragMul === b1.dragMul && a1.wearMul === b1.wearMul,
    'stesso effectSeed su galassie distinte → stesso esito (replay-safe)');
}

console.log('\n— Test 5: rischio incidente di rotta (solo gravitazionali)');
{
  const gxGrav = lineGalaxy([fsp({ cls: 'grav' })]);          // grav su nearSys=2 → zona {1,2,3}
  const gxBio  = lineGalaxy([fsp({ cls: 'bio' })]);
  const routeThrough = [0, 1, 2, 3];   // attraversa la zona
  const routeClear   = [3, 4, 5];      // 4-5 fuori zona (3 è in zona ma la leg 3→4 tocca 3)
  const incGrav = PH.routeIncident(gxGrav, routeThrough);
  assert(incGrav > 0 && incGrav <= PH.AMBIENT.INCIDENT_CAP + 1e-9,
    'grav lungo la rotta → +rischio incidente (entro il cap)');
  assert(PH.routeIncident(gxBio, routeThrough) === 0,
    'bio (nessun canale incident) → +rischio = 0');
  assert(PH.routeIncident(gxGrav, [4, 5]) === 0,
    'rotta interamente fuori zona → +rischio = 0');
  /* Un FSP conta UNA volta anche se più leg toccano la sua zona. */
  const oneLeg = PH.routeIncident(gxGrav, [2, 3]);
  assert(approx(incGrav, oneLeg),
    'lo stesso grav non si somma per ogni leg toccata (conta una volta sola)');
  /* Cap aggregato con due grav distinti agganciati a sistemi diversi. */
  const gx2 = lineGalaxy([
    fsp({ id: 'P0', cls: 'grav', nearSys: 2, effectSeed: 'A' }),
    fsp({ id: 'P1', cls: 'grav', nearSys: 4, effectSeed: 'B' })
  ]);
  assert(PH.routeIncident(gx2, [0, 1, 2, 3, 4, 5]) <= PH.AMBIENT.INCIDENT_CAP + 1e-9,
    'due grav sulla rotta → +rischio cappato a INCIDENT_CAP');
}

console.log('\n— Test 6: nudge "si impara giocando" (una volta, non se classificato)');
{
  const D = PH.DISCOVERY;
  const gx = lineGalaxy([fsp()]);
  const game = { galaxy: gx, phenomena: {}, timeImpulsi: 100 };
  const fleet = { id: 1, name: 'Ricognitori' };
  const ev1 = [];
  PH.noteAmbientFelt(game, fleet, 2, 3, ev1);
  assert(ev1.length === 1 && ev1[0].kind === 'fsp-ambient' && ev1[0].id === 'P0',
    'primo transito in zona ignota → un nudge fsp-ambient');
  assert(game.phenomena['P0'] && game.phenomena['P0']._felt === true, 'istanza marcata _felt');
  const ev2 = [];
  PH.noteAmbientFelt(game, fleet, 2, 3, ev2);
  assert(ev2.length === 0, 'secondo transito → nessun nudge ripetuto');

  /* FSP già classificato: niente nudge (sai già cos\'è). */
  const gx2 = lineGalaxy([fsp({ id: 'PX', effectSeed: 'X' })]);
  const game2 = { galaxy: gx2, phenomena: { 'PX': { d: D.CLASSIFICATO } }, timeImpulsi: 100 };
  const ev3 = [];
  PH.noteAmbientFelt(game2, fleet, 2, 3, ev3);
  assert(ev3.length === 0, 'FSP classificato → nessun nudge ambientale');

  /* Fuori zona: niente nudge. */
  const ev4 = [];
  PH.noteAmbientFelt({ galaxy: lineGalaxy([fsp()]), phenomena: {}, timeImpulsi: 1 }, fleet, 4, 5, ev4);
  assert(ev4.length === 0, 'transito fuori zona → nessun nudge');
}

console.log('\nTutti i test del campo di prossimità FSP superati.');
