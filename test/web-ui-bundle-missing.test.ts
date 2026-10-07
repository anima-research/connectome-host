/**
 * The optional Web UI bundle can be missing: its build runs in postinstall,
 * which can fail or be skipped (`--ignore-scripts`). At run time, a missing
 * bundle used to show only as a 503 to whoever opened the page. The host now
 * says so once at start, and the page keeps its 503 and its remedy.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModuleContext } from '@animalabs/agent-framework';
import {
  WebUiModule,
  __getSharedServerPortForTests,
  __resetSharedServerForTests,
} from '../src/modules/web-ui-module.js';

const dirs: string[] = [];
afterEach(async () => {
  await __resetSharedServerForTests();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function staticDir(withIndex: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'webui-bundle-'));
  dirs.push(dir);
  const root = join(dir, 'web');
  mkdirSync(root, { recursive: true });
  if (withIndex) writeFileSync(join(root, 'index.html'), '<!doctype html><title>t</title>');
  return root;
}

async function startCapturingWarnings(root: string): Promise<string[]> {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  try {
    await new WebUiModule({ port: 0, host: '127.0.0.1', staticDir: root }).start({} as ModuleContext);
  } finally {
    console.warn = orig;
  }
  return warnings.filter((w) => w.startsWith('[webui]'));
}

describe('WebUiModule with a missing bundle', () => {
  test('warns once at start, naming the bundle path and the remedy; the page still answers 503 with it', async () => {
    const root = staticDir(false);
    const warnings = await startCapturingWarnings(root);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`bundle not found at ${root}`);
    expect(warnings[0]).toContain('npm run build:web');

    // The server is a process singleton: a later start reuses it and says nothing more.
    expect(await startCapturingWarnings(root)).toHaveLength(0);

    const res = await fetch(`http://127.0.0.1:${__getSharedServerPortForTests()}/`);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('npm run build:web');
  });

  test('says nothing when the bundle is there', async () => {
    expect(await startCapturingWarnings(staticDir(true))).toHaveLength(0);
  });
});
