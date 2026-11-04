import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnHost } from '../lib/common.mjs';
import * as commonLib from '../lib/common.mjs';

test('a host that can\'t be started exits, with why in its output, rather than throwing an error no one listens for', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spawn-'));
  try {
    const { child, out } = spawnHost({ hostDir: dir, recipePath: join(dir, 'recipe.json'), dataDir: dir, cwd: dir, sockPath: join(dir, 'sock'), env: { PATH: join(dir, 'nothing-here') } });
    const [code] = await once(child, 'exit');
    assert.equal(code, 'ENOENT');
    assert.match(out.join(''), /couldn't start the host: spawn bun ENOENT/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a command that fails shows the last 3,000 characters of its output, and keeps the whole output beside them', () => {
  const run = () => commonLib.sh('bash', ['-c', 'printf "START"; head -c 5000 /dev/zero | tr "\\0" x; printf "END"; exit 3']);
  let error = null;
  try { run(); } catch (e) { error = e; }
  assert.ok(error, 'the command fails');
  const shown = error.message.split('exited 3\n')[1];
  assert.equal(shown, `${'x'.repeat(2997)}END`, 'the shown output is its last 3,000 characters');
  assert.equal(error.full?.split('exited 3\n')[1], `START${'x'.repeat(5000)}END`, 'the whole output is kept beside it');
});
