/**
 * Bind-safety tests for WebUiModule.start().
 *
 * The security-critical invariant: the default bind is 0.0.0.0 (connectome
 * deployments are remote), and any non-loopback bind hard-requires Basic-Auth.
 * A recipe that turns on webui without credentials must fail loudly at startup
 * rather than silently exposing an unauthenticated admin surface — which now
 * includes /debug/context, dumping the full system prompt + conversation.
 *
 * These live in their own file because assertSafeBind only runs when no
 * process-level singleton server exists yet; Bun runs each test file in its
 * own process, so the singleton starts null here.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import type { ModuleContext } from '@animalabs/agent-framework';
import {
  WebUiModule,
  __resetSharedServerForTests,
} from '../src/modules/web-ui-module.js';

afterEach(async () => {
  await __resetSharedServerForTests();
});

describe('WebUiModule bind safety', () => {
  test('default bind (0.0.0.0) without basicAuth refuses to start', async () => {
    const mod = new WebUiModule({ port: 0 }); // no host → default 0.0.0.0, no auth
    await expect(mod.start({} as ModuleContext)).rejects.toThrow(/without auth/i);
  });

  test('explicit non-loopback host without basicAuth refuses to start', async () => {
    const mod = new WebUiModule({ port: 0, host: '0.0.0.0' });
    await expect(mod.start({} as ModuleContext)).rejects.toThrow(/without auth/i);
  });

  test('loopback bind without basicAuth is allowed (local dev)', async () => {
    const mod = new WebUiModule({ port: 0, host: '127.0.0.1' });
    await mod.start({} as ModuleContext); // must not throw
    await mod.stop();
  });

  test('non-loopback bind WITH basicAuth is allowed', async () => {
    const mod = new WebUiModule({
      port: 0,
      host: '0.0.0.0',
      basicAuth: { username: 'admin', password: 'open-sesame' },
    });
    await mod.start({} as ModuleContext); // must not throw
    await mod.stop();
  });
});
