/**
 * postinstall builds the optional Web UI. Its failure must not fail the
 * host's install, and it used to vanish (`|| true`). The script now reports a
 * failed build on stderr, naming the retry command, still exiting 0; without
 * a `web/` directory it stays silent; a working build prints nothing extra.
 *
 * Runs the package's actual script with sh, in a scratch copy holding only a
 * stand-in `web/` package (no dependencies, so npm stays offline).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = (JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf-8')) as {
  scripts: { postinstall: string };
}).scripts.postinstall;

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function scratch(build?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'postinstall-web-'));
  dirs.push(dir);
  if (build !== undefined) {
    mkdirSync(join(dir, 'web'));
    writeFileSync(join(dir, 'web', 'package.json'), JSON.stringify({ name: 'zz-web', version: '0.0.0', private: true, scripts: { build } }));
  }
  return dir;
}

function run(cwd: string) {
  const result = spawnSync('sh', ['-c', script], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' },
  });
  return { status: result.status, stderr: result.stderr };
}

describe('postinstall Web UI build', () => {
  test('a failing build still installs (exit 0) and says so on stderr, with the retry command', () => {
    const { status, stderr } = run(scratch('exit 1'));
    expect(status).toBe(0);
    expect(stderr).toContain('connectome-host: the optional Web UI build failed');
    expect(stderr).toContain('Retry with: npm run build:web');
  }, 60_000);

  test('a working build reports nothing', () => {
    const { status, stderr } = run(scratch('true'));
    expect(status).toBe(0);
    expect(stderr).not.toContain('optional Web UI build failed');
  }, 60_000);

  test('no web/ directory: silent', () => {
    const { status, stderr } = run(scratch());
    expect(status).toBe(0);
    expect(stderr).toBe('');
  });
});
