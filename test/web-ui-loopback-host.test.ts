import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModuleContext } from '@animalabs/agent-framework';
import { WebUiModule, __getSharedServerPortForTests, stopWebUiServer } from '../src/modules/web-ui-module.js';

let module: WebUiModule | undefined;
let root: string | undefined;

afterEach(async () => {
  await module?.stop();
  await stopWebUiServer();
  module = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

async function serve(basicAuth?: { username: string; password: string } | null): Promise<number> {
  root = mkdtempSync(join(tmpdir(), 'web-ui-loopback-host-'));
  const staticDir = join(root, 'web');
  mkdirSync(staticDir);
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>loopback</title>');
  module = new WebUiModule({ port: 0, host: '127.0.0.1', staticDir, ...(basicAuth !== undefined ? { basicAuth: basicAuth as never } : {}) });
  await module.start({} as ModuleContext);
  const port = __getSharedServerPortForTests();
  if (!port) throw new Error('the Web UI server did not bind');
  return port;
}

interface Answer { code: number; body: string }

function ask(port: number, path: string, headers: Record<string, string>, opts: { method?: string; version?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let seen = '';
    const answer = (): Answer => {
      const [head = '', body = ''] = seen.split('\r\n\r\n');
      return { code: Number(head.split('\r\n')[0]?.split(' ')[1] ?? 0), body };
    };
    socket.on('connect', () => {
      const lines = [`${opts.method ?? 'GET'} ${path} HTTP/${opts.version ?? '1.1'}`,
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
      if (!('Connection' in headers)) lines.push('Connection: close');
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    socket.on('data', (chunk) => {
      seen += chunk.toString('latin1');
      const end = seen.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = seen.slice(0, end);
      const length = Number(/\r\ncontent-length: *(\d+)/i.exec(head)?.[1] ?? NaN);
      const whole = head.startsWith('HTTP/1.1 101') || opts.method === 'HEAD' || seen.length - end - 4 >= length;
      if (whole) {
        socket.destroy();
        resolve(answer());
      }
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(answer()));
  });
}

const code = async (...args: Parameters<typeof ask>) => (await ask(...args)).code;
const upgrade = (host: string, origin: string, extra: Record<string, string> = {}) => ({
  Host: host, Origin: origin, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
  'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...extra,
});
const auth = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

test('with no basic auth, a request under a name that isn\'t loopback reaches no route, and the 403 says to set basicAuth', async () => {
  const port = await serve();
  const names = [`rebind.example:${port}`, 'rebind.example', `127.0.0.1.rebind.example:${port}`, `localhost.rebind.example:${port}`, `127.1:${port}`];
  for (const host of names) {
    for (const path of ['/healthz', '/debug/context', '/']) expect(await code(port, path, { Host: host })).toBe(403);
    expect(await code(port, '/healthz', { Host: host }, { method: 'HEAD' })).toBe(403);
    expect(await code(port, '/ws', upgrade(host, `http://${host}`))).toBe(403);
  }
  expect((await ask(port, '/', { Host: names[0]! })).body).toContain('Set basicAuth');
});

test('with no basic auth, a Host that isn\'t a plain name or address is refused, and so is a request with none', async () => {
  const port = await serve();
  for (const host of ['evil@localhost', 'localhost/x', 'localhost#x', 'localhost\\x', `127.0.0.1@rebind.example:${port}`, '[127.0.0.1]', `[::2]:${port}`]) {
    expect(await code(port, '/', { Host: host })).toBe(403);
  }
  expect([400, 403]).toContain(await code(port, '/', {}));
  expect(await code(port, '/', {}, { version: '1.0' })).toBe(403);
});

test('with no basic auth, loopback\'s own names are served as before, with any port or none', async () => {
  const port = await serve();
  const health = await code(port, '/healthz', { Host: `127.0.0.1:${port}` });
  for (const host of [`localhost:${port}`, `LocalHost:${port}`, `[::1]:${port}`, 'localhost', '127.0.0.1', '[::1]', 'localhost:1']) {
    expect(await code(port, '/healthz', { Host: host })).toBe(health);
    expect(await code(port, '/', { Host: host })).toBe(200);
  }
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
    expect(await code(port, '/ws', upgrade(host, `http://${host}`))).toBe(101);
  }
  expect(await code(port, '/ws', upgrade(`127.0.0.1:${port}`, 'http://evil.example'))).toBe(403);
});

test('with basic auth, the Host isn\'t checked: any name answers 401 without credentials and is served with them', async () => {
  const port = await serve({ username: 'u', password: 'p' });
  for (const host of [`rebind.example:${port}`, `127.0.0.1:${port}`]) {
    expect(await code(port, '/', { Host: host })).toBe(401);
    expect(await code(port, '/', { Host: host, Authorization: auth('u', 'p') })).toBe(200);
    expect(await code(port, '/ws', upgrade(host, `http://${host}`))).toBe(401);
    expect(await code(port, '/ws', upgrade(host, `http://${host}`, { Authorization: auth('u', 'p') }))).toBe(101);
  }
});

test('a null basicAuth reads as none: the Host is checked, and the retrieval routes ask for credentials', async () => {
  const port = await serve(null);
  expect(await code(port, '/healthz', { Host: `rebind.example:${port}` })).toBe(403);
  expect(await code(port, '/debug/retrieval', { Host: `127.0.0.1:${port}` })).toBe(401);
});
