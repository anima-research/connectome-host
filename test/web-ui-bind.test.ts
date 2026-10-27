import { describe, test, expect, afterEach } from 'bun:test';
import type { ModuleContext } from '@animalabs/agent-framework';
import {
  WebUiModule,
  stopWebUiServer,
} from '../src/modules/web-ui-module.js';

afterEach(async () => {
  await stopWebUiServer();
});

describe('WebUiModule bind safety', () => {
  test('default bind (0.0.0.0) without basicAuth refuses to start', async () => {
    const mod = new WebUiModule({ port: 0 });
    await expect(mod.start({} as ModuleContext)).rejects.toThrow(/without auth/i);
  });

  test('explicit non-loopback host without basicAuth refuses to start', async () => {
    const mod = new WebUiModule({ port: 0, host: '0.0.0.0' });
    await expect(mod.start({} as ModuleContext)).rejects.toThrow(/without auth/i);
  });

  test('loopback bind without basicAuth is allowed (local dev)', async () => {
    const mod = new WebUiModule({ port: 0, host: '127.0.0.1' });
    await mod.start({} as ModuleContext);
    await mod.stop();
  });

  test('non-loopback bind WITH basicAuth is allowed', async () => {
    const mod = new WebUiModule({
      port: 0,
      host: '0.0.0.0',
      basicAuth: { username: 'admin', password: 'open-sesame' },
    });
    await mod.start({} as ModuleContext);
    await mod.stop();
  });
});
