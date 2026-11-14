import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FetchRefusal, guardedLookup, httpGet, isPublicAddress, type HttpGetOptions } from '../src/modules/fetch-http.js';

const hits: string[] = [];
let closedEarly = 0;
let port = 0;
let server: http.Server;

beforeAll(async () => {
  server = http.createServer((request, response) => {
    hits.push(request.url!);
    const path = request.url!;
    if (path === '/page') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('hello');
    } else if (path === '/headers') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(request.headers));
    } else if (path.startsWith('/to?')) {
      response.writeHead(302, { location: decodeURIComponent(path.slice(4)) });
      response.end();
    } else if (path.startsWith('/loop/')) {
      response.writeHead(302, { location: `/loop/${Number(path.slice(6)) + 1}` });
      response.end();
    } else if (path === '/endless') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      const timer = setInterval(() => response.write('x'.repeat(65_536)), 2);
      response.on('close', () => { clearInterval(timer); closedEarly++; });
    } else if (path === '/silent') {
      // Never answers.
    } else if (path === '/drip') {
      // Never silent for long, so only a whole-fetch deadline can stop it.
      response.writeHead(200, { 'content-type': 'text/plain' });
      const timer = setInterval(() => response.write('x'), 20);
      response.on('close', () => clearInterval(timer));
    } else if (path === '/vendor-json') {
      response.writeHead(200, { 'content-type': 'application/vnd.github+json' });
      response.end('{"ok":true}');
    } else if (path === '/svg') {
      response.writeHead(200, { 'content-type': 'image/svg+xml' });
      response.end('<svg xmlns="http://www.w3.org/2000/svg"/>');
    } else if (path === '/png') {
      response.writeHead(200, { 'content-type': 'image/png', 'content-length': '123456' });
      const timer = setInterval(() => response.write('x'), 5);
      response.on('close', () => { clearInterval(timer); closedEarly++; });
    } else if (path === '/gzip') {
      response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      response.end('not really');
    } else if (path === '/dropped') {
      response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '1000' });
      response.write('partial');
      setTimeout(() => response.destroy(), 10);
    } else {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('nope');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const OPTIONS: HttpGetOptions = { timeoutMs: 5_000, maxBytes: 1_000_000, maxRedirects: 5, userAgent: 'test-agent/1' };

/** The guard live, with this test's own server the one address it lets through. */
const onlyLoopback: HttpGetOptions = { ...OPTIONS, addressAllowed: (address) => address === '127.0.0.1' };

async function refusal(run: Promise<unknown>): Promise<string> {
  const error = await run.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(FetchRefusal);
  return (error as FetchRefusal).message;
}

describe('isPublicAddress', () => {
  test.each([
    ['127.0.0.1'], ['127.8.8.8'], ['10.1.2.3'], ['172.16.0.1'], ['172.31.255.255'], ['192.168.1.1'],
    ['100.95.42.53'], // a tailnet address
    ['169.254.169.254'], // cloud metadata
    ['0.0.0.0'], ['224.0.0.1'], ['255.255.255.255'], ['198.18.0.1'],
    ['::'], ['::1'], ['fc00::1'], ['fd12:3456::1'], ['fe80::1'], ['fe80::1%en0'], ['ff02::1'],
    ['::ffff:127.0.0.1'], ['::ffff:7f00:1'], ['::ffff:10.0.0.1'], ['::7f00:1'],
    ['64:ff9b::7f00:1'], ['64:ff9b:1::1'], ['2002:7f00:1::'], ['2001:db8::1'], ['::ffff:0:0'],
    ['not an address'], [''],
  ])('%s is not public', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  test.each([
    ['8.8.8.8'], ['1.1.1.1'], ['172.32.0.1'], ['172.15.255.255'], ['100.63.255.255'], ['100.128.0.1'], ['192.169.0.1'],
    ['2606:4700:4700::1111'], ['2a00:1450:4001::1'], ['::ffff:8.8.8.8'],
  ])('%s is public', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe('the guard reaches nothing private, and never connects trying', () => {
  // Every way to write loopback, with the default guard: the test's server is
  // listening at each one that can reach it, so a connection would be a hit.
  test.each([
    ['an IPv4 literal', () => `http://127.0.0.1:${port}/guarded`],
    ['a decimal IP', () => `http://2130706433:${port}/guarded`],
    ['a hex IP', () => `http://0x7f.0.0.1:${port}/guarded`],
    ['a short IP', () => `http://127.1:${port}/guarded`],
    ['a name that resolves to it', () => `http://localhost:${port}/guarded`],
    ['that name with a trailing dot', () => `http://localhost.:${port}/guarded`],
    ['that name in capitals', () => `http://LOCALHOST:${port}/guarded`],
    ['IPv6 loopback', () => `http://[::1]:${port}/guarded`],
    ['an IPv4-mapped IPv6 literal', () => `http://[::ffff:127.0.0.1]:${port}/guarded`],
  ])('%s', async (_label, address) => {
    const before = hits.length;
    expect(await refusal(httpGet(new URL(address()), OPTIONS))).toContain('private or local address');
    expect(hits.length).toBe(before);
  });

  test('a refused name doesn\'t say which address it resolved to, which would map internal names', async () => {
    const message = await refusal(httpGet(new URL(`http://localhost:${port}/`), OPTIONS));
    expect(message).toContain('resolves to a private or local address');
    expect(message).not.toMatch(/127\.0\.0\.1|::1/);
  });

  test('the refusal says who can change it', async () => {
    expect(await refusal(httpGet(new URL(`http://127.0.0.1:${port}/`), OPTIONS))).toContain('modules.fetch.allowPrivateNetwork');
  });

  test('a name is checked on every request, not only on its first connection', async () => {
    // A pooled socket is reused without a lookup, so a request after an
    // allowed one would skip the check: the bug this module's agent:false exists for.
    let allow = true;
    const options: HttpGetOptions = { ...OPTIONS, addressAllowed: () => allow };
    const url = new URL(`http://localhost:${port}/page`);
    expect((await httpGet(url, options)).status).toBe(200);
    allow = false;
    const before = hits.length;
    expect(await refusal(httpGet(url, options))).toContain('private or local address');
    expect(hits.length).toBe(before);
  });

  test('an allowing predicate lets it through', async () => {
    const got = await httpGet(new URL(`http://127.0.0.1:${port}/page`), { ...OPTIONS, addressAllowed: () => true });
    expect(got.body.toString()).toBe('hello');
  });
});

describe('a name server\'s answers', () => {
  const answering = (...addresses: string[]) => guardedLookup(isPublicAddress, (_host, _options, callback) => {
    callback(null, addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
  });
  const ask = (lookup: ReturnType<typeof guardedLookup>, all: boolean) =>
    new Promise<{ error: NodeJS.ErrnoException | null; result: unknown }>((resolve) => {
      lookup('name.test', { all } as never, ((error: NodeJS.ErrnoException | null, result: unknown) => resolve({ error, result })) as never);
    });

  test('a public answer passes, in whichever shape the connection asked for', async () => {
    expect((await ask(answering('8.8.8.8'), true)).result).toEqual([{ address: '8.8.8.8', family: 4 }]);
    expect((await ask(answering('8.8.8.8'), false)).result).toBe('8.8.8.8');
  });

  test.each([
    ['a private answer', ['10.0.0.1']],
    ['a private answer behind a public one', ['8.8.8.8', '10.0.0.1']],
    ['a mapped loopback answer behind a public one', ['2606:4700:4700::1111', '::ffff:127.0.0.1']],
    ['the metadata service', ['169.254.169.254']],
  ])('%s refuses the name', async (_label, addresses) => {
    const { error } = await ask(answering(...addresses), true);
    expect(error?.message).toContain('private or local address');
  });

  test('a name that changes its answer is checked on each lookup, the DNS rebinding case', async () => {
    const answers = ['8.8.8.8', '127.0.0.1'];
    const rebinding = guardedLookup(isPublicAddress, (_host, _options, callback) => {
      const address = answers.shift()!;
      callback(null, [{ address, family: 4 }]);
    });
    expect((await ask(rebinding, true)).error).toBeNull();
    expect((await ask(rebinding, true)).error?.message).toContain('private or local address');
  });
});

describe('redirects', () => {
  test('a redirect is followed, relative or absolute, and the final address is reported', async () => {
    const relative = await httpGet(new URL(`http://127.0.0.1:${port}/to?${encodeURIComponent('/page')}`), onlyLoopback);
    expect(relative.body.toString()).toBe('hello');
    expect(relative.url).toBe(`http://127.0.0.1:${port}/page`);
    const absolute = await httpGet(new URL(`http://127.0.0.1:${port}/to?${encodeURIComponent(`http://127.0.0.1:${port}/page`)}`), onlyLoopback);
    expect(absolute.body.toString()).toBe('hello');
  });

  test.each([
    ['a private IP', () => 'http://10.0.0.1/secret'],
    ['the metadata service', () => 'http://169.254.169.254/latest/meta-data/'],
    ['IPv6 loopback', () => `http://[::1]:${port}/secret`],
    ['a name that resolves to loopback', () => `http://localhost:${port}/secret`],
  ])('a public page can\'t redirect onto %s', async (_label, target) => {
    // localhost can answer 127.0.0.1, which this test allows, so that case
    // allows only the literal the first hop uses.
    const options: HttpGetOptions = { ...OPTIONS, addressAllowed: (a) => a === '127.0.0.1' && !target().includes('localhost') };
    const first = target().includes('localhost')
      ? { ...OPTIONS, addressAllowed: (() => { let hop = 0; return () => hop++ === 0; })() }
      : options;
    const before = hits.filter((h) => h === '/secret').length;
    expect(await refusal(httpGet(new URL(`http://127.0.0.1:${port}/to?${encodeURIComponent(target())}`), first))).toContain('private or local address');
    expect(hits.filter((h) => h === '/secret').length).toBe(before);
  });

  test('a redirect to another scheme is refused', async () => {
    const message = await refusal(httpGet(new URL(`http://127.0.0.1:${port}/to?${encodeURIComponent('file:///etc/passwd')}`), onlyLoopback));
    expect(message).toContain("file: addresses aren't fetched");
  });

  test('a redirect carrying credentials is refused', async () => {
    const message = await refusal(httpGet(new URL(`http://127.0.0.1:${port}/to?${encodeURIComponent(`http://u:p@127.0.0.1:${port}/page`)}`), onlyLoopback));
    expect(message).toContain('user name or password');
  });

  test('a redirect loop stops at the limit, and says where', async () => {
    const message = await refusal(httpGet(new URL(`http://127.0.0.1:${port}/loop/0`), onlyLoopback));
    expect(message).toContain('more than 5 times');
    expect(message).toContain('/loop/5');
  });
});

describe('what comes back', () => {
  test('credentials in the address are refused, and no credentials are sent', async () => {
    expect(await refusal(httpGet(new URL(`http://u:p@127.0.0.1:${port}/page`), onlyLoopback))).toContain('user name or password');
    const got = await httpGet(new URL(`http://127.0.0.1:${port}/headers`), onlyLoopback);
    const headers = JSON.parse(got.body.toString()) as Record<string, string>;
    expect(headers['user-agent']).toBe('test-agent/1');
    expect(headers['accept-encoding']).toBe('identity');
    expect(headers.authorization).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
  });

  test('a fragment is not sent', async () => {
    const got = await httpGet(new URL(`http://127.0.0.1:${port}/page#section`), onlyLoopback);
    expect(got.url).toBe(`http://127.0.0.1:${port}/page`);
  });

  test('an error status is an answer, with its body', async () => {
    const got = await httpGet(new URL(`http://127.0.0.1:${port}/missing`), onlyLoopback);
    expect(got.status).toBe(404);
    expect(got.body.toString()).toBe('nope');
  });

  test('a body past maxBytes keeps exactly the limit, says so, and closes the connection', async () => {
    const before = closedEarly;
    const got = await httpGet(new URL(`http://127.0.0.1:${port}/endless`), { ...onlyLoopback, maxBytes: 200_000 });
    expect(got.cut).toBe(true);
    expect(got.body.length).toBe(200_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(closedEarly).toBe(before + 1);
  });

  test('a clearly binary type is reported without being downloaded', async () => {
    const before = closedEarly;
    const got = await httpGet(new URL(`http://127.0.0.1:${port}/png`), onlyLoopback);
    expect(got.binary).toBe(true);
    expect(got.body.length).toBe(0);
    expect(got.declaredBytes).toBe(123456);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(closedEarly).toBe(before + 1);
  });

  test.each([['/vendor-json', '{"ok":true}'], ['/svg', '<svg xmlns="http://www.w3.org/2000/svg"/>']])('%s, a type that is text underneath, is read', async (path, body) => {
    const got = await httpGet(new URL(`http://127.0.0.1:${port}${path}`), onlyLoopback);
    expect(got.binary).toBe(false);
    expect(got.body.toString()).toBe(body);
  });

  test('a server that compresses anyway is refused, not read as garbage', async () => {
    expect(await refusal(httpGet(new URL(`http://127.0.0.1:${port}/gzip`), onlyLoopback))).toContain('compressed (gzip)');
  });

  test('a connection dropped partway is a failure, not a short document', async () => {
    expect(await refusal(httpGet(new URL(`http://127.0.0.1:${port}/dropped`), onlyLoopback))).toMatch(/closed the connection|partway/);
  });

  test('a server that never answers is stopped at the deadline', async () => {
    const started = Date.now();
    expect(await refusal(httpGet(new URL(`http://127.0.0.1:${port}/silent`), { ...onlyLoopback, timeoutMs: 200 }))).toContain('took longer');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test('a server that drips bytes is stopped at the deadline too', async () => {
    const started = Date.now();
    expect(await refusal(httpGet(new URL(`http://127.0.0.1:${port}/drip`), { ...onlyLoopback, timeoutMs: 200 }))).toContain('took longer');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test('a name that does not resolve is a failure with the reason', async () => {
    expect(await refusal(httpGet(new URL('http://no-such-host.invalid/'), OPTIONS))).toContain('the request failed');
  });
});

describe('https', () => {
  // Every other test here is plain http, and what would go wrong here is silent:
  // a dropped certificate check still fetches the page.
  test('a certificate this host does not trust is refused, and its server sends nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fetch-tls-'));
    const made = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')]);
    expect(made.exitCode).toBe(0);
    let served = 0;
    const secure = https.createServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (_request, response) => {
      served++;
      response.end('should not be read');
    });
    await new Promise<void>((resolve) => secure.listen(0, '127.0.0.1', resolve));
    const address = `https://127.0.0.1:${(secure.address() as AddressInfo).port}/`;
    try {
      expect(await refusal(httpGet(new URL(address), { ...OPTIONS, addressAllowed: () => true }))).toContain('the request failed');
      expect(served).toBe(0);
    } finally {
      secure.closeAllConnections();
      secure.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
