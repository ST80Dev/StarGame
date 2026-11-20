/* Cattura (o verifica) il golden replay: per ogni seed crea la partita,
   avanza N Impulsi e registra l'hash per sezione del save a ogni checkpoint.
   Uso: node tests/golden/capture.cjs [--write]  */
'use strict';
const fs = require('fs');
const path = require('path');
const { run } = require('./replay.cjs');
const OUT = path.join(__dirname, 'baseline.json');
const res = run();
if (process.argv.includes('--write')) {
  fs.writeFileSync(OUT, JSON.stringify(res, null, 1) + '\n');
  console.log('baseline scritta:', OUT);
} else {
  console.log(JSON.stringify(res, null, 1).slice(0, 2000));
}
