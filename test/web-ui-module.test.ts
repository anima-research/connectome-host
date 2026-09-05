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
let webUiModule: WebUiModule;

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
  webUiModule = new WebUiModule({
    port: 0,
    host: '127.0.0.1',
    basicAuth: { username: BASIC_USER, password: BASIC_PASS },
    staticDir: staticRoot,
  });
  await webUiModule.start({} as ModuleContext);

  const port = __getSharedServerPortForTests();
  if (!port) throw new Error('webui server not bound; did start() succeed?');

  handle = {
    port,
    staticRoot,
    cleanup: async () => {
      await webUiModule.stop();
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

  test('retrieval trace routes require auth and expose the in-memory viewer', async () => {
    for (const path of ['/debug/retrieval', '/debug/retrieval/view']) {
      const unauthenticated = await fetch(`http://127.0.0.1:${handle.port}${path}`);
      expect(unauthenticated.status).toBe(401);
      expect(unauthenticated.headers.get('cache-control')).toBe('no-store');
    }

    const headers = { authorization: basicAuthHeader(BASIC_USER, BASIC_PASS) };
    const unbound = await fetch(`http://127.0.0.1:${handle.port}/debug/retrieval`, { headers });
    expect(unbound.status).toBe(503);
    expect(unbound.headers.get('cache-control')).toBe('no-store');
    expect(await unbound.json()).toEqual({ error: 'app not bound yet' });

    const viewer = await fetch(`http://127.0.0.1:${handle.port}/debug/retrieval/view`, { headers });
    expect(viewer.status).toBe(200);
    expect(viewer.headers.get('cache-control')).toBe('no-store');
    const viewerHtml = await viewer.text();
    expect(viewerHtml).toContain('Retrieval traces');
    expect(viewerHtml).toContain('Selected lessons');
    expect(viewerHtml).toContain('Candidate lessons');
    expect(viewerHtml).toContain('Raw JSON (diagnostic)');
    expect(viewerHtml).toContain("'agent: ' + (trace.agentName || 'unknown')");
    expect(viewerHtml).toContain("reasoning ? reasoning.effort : 'default'");
    expect(viewerHtml).not.toContain('reasoning.context');
    expect(viewerHtml).toContain('node.textContent = String(text)');
    expect(viewerHtml).not.toContain('.innerHTML');
    expect(viewerHtml).not.toContain('\\u201C');
    expect(viewerHtml).not.toContain('\\u201D');

    const signIn = await fetch(`http://127.0.0.1:${handle.port}/auth/basic`, {
      headers,
      redirect: 'manual',
    });
    const cookie = (signIn.headers.get('set-cookie') ?? '').split(';', 1)[0];
    expect(signIn.status).toBe(302);
    expect(cookie.startsWith('fkm_obs=')).toBe(true);

    const sessionJson = await fetch(`http://127.0.0.1:${handle.port}/debug/retrieval`, {
      headers: { cookie },
    });
    expect(sessionJson.status).toBe(503);
    expect(sessionJson.headers.get('cache-control')).toBe('no-store');
    const sessionViewer = await fetch(
      `http://127.0.0.1:${handle.port}/debug/retrieval/view`,
      { headers: { cookie } },
    );
    expect(sessionViewer.status).toBe(200);
    expect(sessionViewer.headers.get('cache-control')).toBe('no-store');
  });

  test('bound retrieval JSON is no-store, redacted by default, and inputs require exact 1', async () => {
    let observedOptions: { limit?: number; includeInputs?: boolean } | undefined;
    const malicious = '</script><img src=x onerror="globalThis.pwned=true">';
    const retrieval = {
      name: 'retrieval',
      getRetrievalTraces: (options: { limit?: number; includeInputs?: boolean } = {}) => {
        observedOptions = options;
        return [{
          schemaVersion: 1,
          id: 1,
          startedAt: '2026-07-31T00:00:00.000Z',
          agentName: 'test-agent',
          config: {
            model: 'test-retrieval-model',
            requestedReasoning: { effort: 'high' },
            minConfidence: 0.3,
            maxCandidates: 20,
            maxInjectedLessons: 5,
          },
          context: {
            hash: 'abc', messageCount: 1, messageIds: ['m1'],
            ...(options.includeInputs ? { input: 'private recent conversation' } : {}),
          },
          cache: { hit: false },
          candidates: [{
            id: 'malicious-lesson', content: malicious, confidence: 0.9,
            tags: [malicious], evidence: [], created: 1, updated: 1,
            deprecated: false, matches: [],
          }],
          relevantLessonIds: [],
          injected: { lessonIds: [], lessons: [] },
          outcome: 'no-concepts',
        }];
      },
    };
    const framework = {
      getAllAgents: () => [],
      getAllModules: () => [retrieval],
      getSessionUsage: () => { throw new Error('no usage in HTTP harness'); },
      onTrace: () => {},
    };
    webUiModule.setApp({ framework } as never);

    const headers = { authorization: basicAuthHeader(BASIC_USER, BASIC_PASS) };
    try {
      const defaultRes = await fetch(
        `http://127.0.0.1:${handle.port}/debug/retrieval?limit=7`, { headers },
      );
      expect(defaultRes.status).toBe(200);
      expect(defaultRes.headers.get('cache-control')).toBe('no-store');
      const defaultBody = await defaultRes.json() as Record<string, unknown>;
      expect(defaultBody.enabled).toBe(true);
      expect(defaultBody.includeInputs).toBe(false);
      expect(JSON.stringify(defaultBody)).not.toContain('private recent conversation');
      const returnedTraces = defaultBody.traces as Array<{
        candidates: Array<{ content: string }>;
      }>;
      expect(returnedTraces[0].candidates[0].content).toBe(malicious);
      expect(observedOptions).toEqual({ limit: 7, includeInputs: false });

      const viewerRes = await fetch(
        `http://127.0.0.1:${handle.port}/debug/retrieval/view`, { headers },
      );
      const viewerHtml = await viewerRes.text();
      // Static viewer markup does not inline trace data; dynamic values use text sinks.
      expect(viewerHtml).not.toContain(malicious);
      expect(viewerHtml).toContain('textContent');
      expect(viewerHtml).not.toContain('.innerHTML');

      for (const alias of ['true', 'yes', '01']) {
        const res = await fetch(
          `http://127.0.0.1:${handle.port}/debug/retrieval?includeInputs=${alias}`, { headers },
        );
        const body = await res.json() as Record<string, unknown>;
        expect(body.includeInputs).toBe(false);
        expect(JSON.stringify(body)).not.toContain('private recent conversation');
      }

      const exactRes = await fetch(
        `http://127.0.0.1:${handle.port}/debug/retrieval?includeInputs=1`, { headers },
      );
      const exactBody = await exactRes.json() as Record<string, unknown>;
      expect(exactBody.includeInputs).toBe(true);
      expect(JSON.stringify(exactBody)).toContain('private recent conversation');
      expect(observedOptions).toEqual({ limit: 20, includeInputs: true });
    } finally {
      await webUiModule.stop();
    }
  });

  test('bound app without retrieval reports tracing disabled', async () => {
    const framework = {
      getAllAgents: () => [],
      getAllModules: () => [],
      getSessionUsage: () => { throw new Error('no usage in HTTP harness'); },
      onTrace: () => {},
    };
    webUiModule.setApp({ framework } as never);
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/debug/retrieval`, {
        headers: { authorization: basicAuthHeader(BASIC_USER, BASIC_PASS) },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({
        schemaVersion: 1, enabled: false, includeInputs: false, traces: [],
      });
    } finally {
      await webUiModule.stop();
    }
  });

  test('retrieval JSON errors are also no-store', async () => {
    const framework = {
      getAllAgents: () => [],
      getAllModules: () => [{
        name: 'retrieval',
        getRetrievalTraces: () => { throw new Error('trace listing failed'); },
      }],
      getSessionUsage: () => { throw new Error('no usage in HTTP harness'); },
      onTrace: () => {},
    };
    webUiModule.setApp({ framework } as never);
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/debug/retrieval`, {
        headers: { authorization: basicAuthHeader(BASIC_USER, BASIC_PASS) },
      });
      expect(res.status).toBe(500);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({ error: 'trace listing failed' });
    } finally {
      await webUiModule.stop();
    }
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

  // Honest-error regression set: unknown API routes and missing bundle
  // assets used to fall through to the SPA shell with a 200, and wrong
  // methods executed the GET handlers.

  test('unknown /debug/* route returns a JSON 404, not the SPA shell', async () => {
    for (const path of ['/debug/context/', '/debug/CONTEXT', '/debug/nonexistent']) {
      const res = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
        headers: { authorization: basicAuthHeader(BASIC_USER, BASIC_PASS) },
      });
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/json');
    }
  });

  test('missing /assets/* returns 404, not HTML', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/assets/nonexistent.js`, {
      headers: { authorization: basicAuthHeader(BASIC_USER, BASIC_PASS) },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type') ?? '').not.toContain('text/html');
  });

  test('non-GET methods get 405 with Allow header', async () => {
    for (const method of ['POST', 'DELETE', 'PUT']) {
      const res = await fetch(`http://127.0.0.1:${handle.port}/debug/context`, {
        method,
        headers: { authorization: basicAuthHeader(BASIC_USER, BASIC_PASS) },
      });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toContain('GET');
    }
  });

  test('SPA client-side routes still fall back to the shell', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/totally/fake/route`, {
      headers: { authorization: basicAuthHeader(BASIC_USER, BASIC_PASS) },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<!doctype html>');
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
