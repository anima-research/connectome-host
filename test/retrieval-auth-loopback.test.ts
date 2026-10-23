import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModuleContext } from '@animalabs/agent-framework';
import {
  WebUiModule,
  __getSharedServerPortForTests,
  stopWebUiServer,
} from '../src/modules/web-ui-module.js';

describe('retrieval operator authentication on credential-free loopback', () => {
  let webUiModule: WebUiModule | undefined;
  let root: string;
  let baseUrl: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'retrieval-auth-loopback-'));
    const staticRoot = join(root, 'web');
    mkdirSync(staticRoot);
    writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><title>loopback</title>');
    webUiModule = new WebUiModule({
      port: 0,
      host: '127.0.0.1',
      staticDir: staticRoot,
    });
    await webUiModule.start({} as ModuleContext);
    const port = __getSharedServerPortForTests();
    if (!port) throw new Error('webui server not bound; did start() succeed?');
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await webUiModule?.stop();
    await stopWebUiServer();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('denies both retrieval routes without changing ordinary loopback routes', async () => {
    expect((await fetch(`${baseUrl}/`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/debug/context`)).status).toBe(503);

    for (const path of ['/debug/retrieval', '/debug/retrieval/view']) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });
});
