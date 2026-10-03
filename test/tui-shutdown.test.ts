import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const control of ['ctrl-c', 'quit']) {
  for (const mode of ['healthy', 'failure', 'delayed-failure']) {
    test(`TUI ${control} shutdown ${mode} settles after terminal cleanup`, async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tui-shutdown-')));
      const child = spawn(process.execPath, [join(import.meta.dir, 'mock-tui-shutdown-child.ts'), mode, control], {
        cwd: dir, env: { ...process.env, DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout!.on('data', chunk => { stdout += chunk; });
      child.stderr!.on('data', chunk => { stderr += chunk; });
      const closed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
      try {
        const result = await closed;
        const match = stdout.match(/TUI_RESULT (\{[^\n]+\})/);
        if (!match) throw new Error(`No TUI result: ${stderr.replace(/[^\x20-\x7e\r\n\t]/g, '')}`);
        const receipt = JSON.parse(match[1]);
        expect(receipt).toEqual({
          status: mode === 'healthy' ? 'fulfilled' : 'rejected',
          stopCalls: 1, traceDetached: 1, destroyCalls: 1, unhandled: false,
          originalError: mode !== 'healthy',
        });
        expect(result.signal).toBeNull();
        expect(result.code).toBe(mode === 'healthy' ? 0 : 1);
        if (mode !== 'healthy') expect(stderr).toContain('injected Fleet cleanup failure');
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await closed;
        rmSync(dir, { recursive: true, force: true });
      }
    }, 15000);
  }
}
