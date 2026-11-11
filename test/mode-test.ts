import { test } from 'bun:test';
import { accessSync, chmodSync, constants, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Root, and a process with CAP_DAC_OVERRIDE, read and write through any file mode.
const modesBind = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'setup-modes-'));
  try {
    const file = join(dir, 'shut');
    writeFileSync(file, '');
    chmodSync(file, 0o000);
    try {
      accessSync(file, constants.R_OK);
      return false;
    } catch {
      return true;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

export const modeTest = test.skipIf(!modesBind);
