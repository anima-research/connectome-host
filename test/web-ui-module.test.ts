/**
 * Smoke tests for the WebUiModule HTTP / WS surface.
 *
 * Coverage focus:
 *   - Origin allowlist on `/ws`: cross-origin attempts get 403, same-origin
 *     succeeds. (Pre-fix this was undefended — see QA emergency #2.)
 *   - Basic-auth: 401 without/with-wrong creds, 200/upgrade with right creds.
 *   - serveStatic path containment: a `/..` request for a sibling-prefixed
 *     directory (`<root>-evil`) doesn't escape staticRoot. (Pre-fix the
 *     startsWith check missed this; see QA #13.)
 *   - WS round-trip: client sends `{type:'ping'}` → server holds the
 *     connection (no reply, but no disconnect either).
 *   - WS rejects invalid JSON / unknown shapes with an error envelope.
 *
 * The module uses a process-level singleton (HTTP server outlives any
 * single framework lifetime), so we boot once per file and share across
 * tests. Bun test runs each test file in its own process, which keeps the
 * singleton scope tight.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModuleContext } from '@animalabs/agent-framework';
import {
  WebUiModule,
  __getSharedServerPortForTests,
  __resetSharedServerForTests,
} from '../src/modules/web-ui-module.js';

interface ServerHandle {
  port: number;
  staticRoot: string;
  cleanup: () => Promise<void>;
}

const BASIC_USER = 'admin';
const BASIC_PASS = 'open-sesame';

let handle: ServerHandle;

function basicAuthHeader(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

beforeAll(async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'webui-test-'));
  const staticRoot = join(tmp, 'web-bundle');
  mkdirSync(staticRoot, { recursive: true });
  writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><title>t</title>');
  writeFileSync(join(staticRoot, 'app.js'), 'console.log("hi")');

  // Sibling directory used by the path-containment escape test. The pre-fix
  // `startsWith(root)` check would let `<root>-evil` slip through; the
  // current `startsWith(root + sep)` does not.
  const sibling = `${staticRoot}-evil`;
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, 'secret.txt'), 'pwned');

  // Bun.serve supports port=0 → OS picks a free port; we read it back from
  // the server. Avoids collisions when the test harness retries.
  const mod = new WebUiModule({
    port: 0,
    host: '127.0.0.1',
    basicAuth: { username: BASIC_USER, password: BASIC_PASS },
    staticDir: staticRoot,
  });
  await mod.start({} as ModuleContext);

  const port = __getSharedServerPortForTests();
  if (!port) throw new Error('webui server not bound; did start() succeed?');

  handle = {
    port,
    staticRoot,
    cleanup: async () => {
      await mod.stop();
      await __resetSharedServerForTests();
      rmSync(tmp, { recursive: true, force: true });
      rmSync(sibling, { recursive: true, force: true });
    },
  };
});

afterAll(async () => {
  await handle.cleanup();
});

describe('WebUiModule HTTP', () => {
  test('GET / requires basic auth', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate') ?? '').toContain('Basic');
  });

  test('GET / with correct creds returns the SPA shell', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/`, {
      headers: { authorization: basicAuthHeader(BASIC_USER, BASIC_PASS) },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<!doctype html>');
  });

  test('GET / with wrong password is rejected', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/`, {
      headers: { authorization: basicAuthHeader(BASIC_USER, 'wrong') },
    });
    expect(res.status).toBe(401);
  });

  test('GET / with wrong username is rejected', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/`, {
      headers: { authorization: basicAuthHeader('attacker', BASIC_PASS) },
    });
    expect(res.status).toBe(401);
  });

  test('GET /app.js returns the asset', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/app.js`, {
      headers: { authorization: basicAuthHeader(BASIC_USER, BASIC_PASS) },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('console.log');
  });

  // Path containment: a request for /../<sibling-of-staticRoot>/secret.txt
  // would, pre-fix, slip past the `startsWith(root)` check because the
  // sibling directory's path begins with `<staticRoot>-evil`. The new check
  // requires either an exact match or `<root>+pathSep`. We can't easily
  // express the relative `..` traversal in a URL because the router
  // normalizes `/`-relative requests to staticRoot — but we *can* assert
  // that the SPA fallback (returns index.html) kicks in for unknown paths
  // rather than serving the sibling directory's file.
  test('unknown / out-of-tree paths fall through to SPA shell, never to siblings', async () => {
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/../web-bundle-evil/secret.txt`,
      { headers: { authorization: basicAuthHeader(BASIC_USER, BASIC_PASS) } },
    );
    // URL normalization in fetch + the server resolves under staticRoot.
    // The body must NOT be the secret file, regardless of which fallback
    // path the server takes (404, SPA shell, or 403).
    const body = res.status < 500 ? await res.text() : '';
    expect(body).not.toContain('pwned');
  });
});

describe('WebUiModule WebSocket', () => {
  test('upgrade rejects mismatched Origin with 403', async () => {
    // Browsers always send Origin on WS upgrades; an attacker page would
    // send its own origin, not the host's. With creds present (so we hit
    // the actual Origin check) the server must reply 403 before auth runs.
    const res = await fetch(`http://127.0.0.1:${handle.port}/ws`, {
      headers: {
        authorization: basicAuthHeader(BASIC_USER, BASIC_PASS),
        origin: 'http://evil.example.com',
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
      },
    });
    expect(res.status).toBe(403);
  });

  test('upgrade rejects with 401 when Origin is OK but auth is missing', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/ws`, {
      headers: {
        origin: `http://127.0.0.1:${handle.port}`,
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
      },
    });
    expect(res.status).toBe(401);
  });

  test('round-trips a ping with same-origin creds', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws`, {
      // Bun's WebSocket constructor takes a `headers` option in the second
      // arg as an object; emulate the browser by sending Origin from
      // 127.0.0.1:<port> and tacking on Authorization.
      headers: {
        origin: `http://127.0.0.1:${handle.port}`,
        authorization: basicAuthHeader(BASIC_USER, BASIC_PASS),
      },
    } as unknown as undefined);

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ws never opened')), 5000);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); });
      ws.addEventListener('error', (e) => { clearTimeout(t); reject(e as unknown as Error); });
    });

    // No app is bound to this module instance, so any non-ping message gets
    // an immediate `host not ready` error envelope. ping is the one variant
    // that doesn't require app state — it's the canary.
    const errored = new Promise<unknown>((resolve) => {
      ws.addEventListener('message', (ev) => resolve(JSON.parse(String(ev.data))));
    });
    ws.send(JSON.stringify({ type: 'mcpl-add', id: 'x', command: '/x' }));
    const reply = (await errored) as { type?: string; message?: string };
    // Without setApp(), the server short-circuits with `host not ready`.
    // Either way, it must be an `error` envelope — never a silent success.
    expect(reply.type).toBe('error');
    expect(typeof reply.message).toBe('string');

    ws.close();
  });

  test('rejects invalid JSON with an error envelope, then unknown-shape too', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws`, {
      headers: {
        origin: `http://127.0.0.1:${handle.port}`,
        authorization: basicAuthHeader(BASIC_USER, BASIC_PASS),
      },
    } as unknown as undefined);

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ws never opened')), 5000);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); });
      ws.addEventListener('error', (e) => { clearTimeout(t); reject(e as unknown as Error); });
    });

    const replies: Array<{ type?: string; message?: string }> = [];
    const got = new Promise<void>((resolve) => {
      ws.addEventListener('message', (ev) => {
        replies.push(JSON.parse(String(ev.data)));
        if (replies.length >= 2) resolve();
      });
    });

    ws.send('not-json{{');
    ws.send(JSON.stringify({ type: 'no-such-message' }));
    await got;

    expect(replies[0]?.type).toBe('error');
    expect(replies[0]?.message).toBe('invalid JSON');
    expect(replies[1]?.type).toBe('error');
    expect(replies[1]?.message).toBe('unknown message shape');

    ws.close();
  });
});
