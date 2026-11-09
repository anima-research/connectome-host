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
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      const mod = new WebUiModule({ port: 0, host });
      await mod.start({} as ModuleContext);
      await mod.stop();
      await stopWebUiServer();
    }
  });

  test('without basicAuth, allowedOrigins other than a non-empty list of http or https URLs on a loopback name refuses to start, naming what it refused and both ways out', async () => {
    for (const [allowedOrigins, named] of [
      [[], 'allowedOrigins: []'],
      [['null'], '"null"'],
      [['http://127.0.0.1:7340', 'https://admin.example.internal'], '"https://admin.example.internal"'],
      [['ws://127.0.0.1:7340'], '"ws://127.0.0.1:7340"'],
      [[undefined as unknown as string], 'the allowedOrigins entry undefined'],
      [[['http://localhost:5173']] as unknown as string[], 'the allowedOrigins entry ["http://localhost:5173"]'],
      [['http://localhost.rebind.example'], '"http://localhost.rebind.example"'],
      ['http://localhost:5173' as unknown as string[], 'allowedOrigins "http://localhost:5173", which isn\'t a list,'],
      [{ a: 1 } as unknown as string[], 'allowedOrigins {"a":1}, which isn\'t a list,'],
    ] as const) {
      const given = (Array.isArray(allowedOrigins) ? [...allowedOrigins] : allowedOrigins) as string[];
      const refused = new WebUiModule({ port: 0, host: '127.0.0.1', allowedOrigins: given }).start({} as ModuleContext);
      await expect(refused).rejects.toThrow(named);
      await expect(refused).rejects.toThrow('Set basicAuth and make allowedOrigins a non-empty list of http or https origins, or remove allowedOrigins');
    }
  });

  test('with basicAuth, allowedOrigins other than a non-empty list of http or https URLs refuses to start, naming what it refused', async () => {
    const basicAuth = { username: 'admin', password: 'open-sesame' };
    for (const [allowedOrigins, named] of [
      [[], 'allowedOrigins: []'],
      [['null'], '"null"'],
      [['https://admin.example.internal', 'ws://admin.example.internal'], '"ws://admin.example.internal"'],
      [[['https://admin.example.internal']] as unknown as string[], 'the allowedOrigins entry ["https://admin.example.internal"]'],
      ['https://admin.example.internal' as unknown as string[], 'allowedOrigins "https://admin.example.internal", which isn\'t a list,'],
    ] as const) {
      const given = (Array.isArray(allowedOrigins) ? [...allowedOrigins] : allowedOrigins) as string[];
      const refused = new WebUiModule({ port: 0, host: '127.0.0.1', allowedOrigins: given, basicAuth }).start({} as ModuleContext);
      await expect(refused).rejects.toThrow(named);
      await expect(refused).rejects.toThrow('List the origins to accept, or remove allowedOrigins');
    }
  });

  test('without basicAuth, a list of http or https URLs on a loopback name, any port, or a null list starts; with basicAuth, a list of http or https URLs does', async () => {
    const auth = { username: 'admin', password: 'open-sesame' };
    for (const config of [
      { allowedOrigins: ['http://localhost:5173', 'https://[::1]:7340', 'http://127.0.0.1', 'http://localhost:80', 'http://localhost:5173/', 'http://localhost:5173/app'] },
      { allowedOrigins: null as unknown as string[] },
      { allowedOrigins: ['https://admin.example.internal', 'http://127.0.0.1:5173'], basicAuth: auth },
      { allowedOrigins: null as unknown as string[], basicAuth: auth },
    ]) {
      const mod = new WebUiModule({ port: 0, host: '127.0.0.1', ...config });
      await mod.start({} as ModuleContext);
      await mod.stop();
      await stopWebUiServer();
    }
  });

  test('basicAuth whose username or password is empty, missing or not a string refuses to start, naming the .env route', async () => {
    for (const basicAuth of [
      { username: 'admin', password: '' },
      { username: '', password: 'open-sesame' },
      { username: 'admin' } as unknown as { username: string; password: string },
      { username: 'admin', password: 42 } as unknown as { username: string; password: string },
    ]) {
      const refused = new WebUiModule({ port: 0, host: '127.0.0.1', basicAuth }).start({} as ModuleContext);
      await expect(refused).rejects.toThrow('username or password is empty, missing or not a string');
      await expect(refused).rejects.toThrow('.env');
    }
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
