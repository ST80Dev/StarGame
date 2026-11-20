/* I test headless storici (script node con assert propri) girano sotto Vitest
   come sottoprocessi: un exit code ≠ 0 fa fallire il test. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'legacy');
describe('test storici (tests/legacy)', () => {
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.cjs')).sort()) {
    it(f, () => { execFileSync(process.execPath, [path.join(dir, f)], { stdio: 'pipe', timeout: 30000 }); });
  }
});
