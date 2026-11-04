import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnHost } from '../lib/common.mjs';

test('a host that can\'t be started exits, with why in its output, rather than throwing an error no one listens for', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spawn-'));
  try {
    const { child, out } = spawnHost({ hostDir: dir, recipePath: join(dir, 'recipe.json'), dataDir: dir, cwd: dir, sockPath: join(dir, 'sock'), env: { PATH: join(dir, 'nothing-here') } });
    const [code] = await once(child, 'exit');
    assert.equal(code, 'ENOENT');
    assert.match(out.join(''), /couldn't start the host: spawn bun ENOENT/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
