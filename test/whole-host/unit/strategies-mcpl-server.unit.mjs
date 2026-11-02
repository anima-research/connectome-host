import { test } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { listenForPeers } from '../lib/strategies/control.mjs';
import { png, zlibStored } from '../lib/strategies/png.mjs';

const SERVER = fileURLToPath(new URL('../lib/strategies/mcpl-server.mjs', import.meta.url));

// agent-framework opens an MCPL server with initialize, the initialized notification and the policy request.
async function startHost({ control = '', channels = '', boot = '', answer = () => ({ result: { ok: true } }) } = {}) {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, FIXTURE_CONTROL: control, FIXTURE_CHANNELS: channels, FIXTURE_BOOT: boot }, stdio: ['pipe', 'pipe', 'pipe'] });
  const fromServer = [];
  const waiting = new Map();
  let nextId = 0;
  let buf = '';
  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if ('method' in msg) {
        fromServer.push(msg);
        if (msg.id === undefined) continue;
        Promise.resolve(answer(msg)).then((a) => {
          if (a && !child.stdin.destroyed) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...a }) + '\n');
        });
      } else {
        waiting.get(msg.id)?.(msg);
        waiting.delete(msg.id);
      }
    }
  });
  const request = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const exited = new Promise((r) => child.once('exit', r));
  const init = await request('initialize', { protocolVersion: '2024-11-05', capabilities: { experimental: { mcpl: { version: '0.5' } } }, clientInfo: { name: 'agent-framework', version: '1.0.0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const policy = await request('featureSets/update', { effectiveCapabilities: ['tools', 'channels.register', 'channels.incoming'] });
  const call = async (args) => (await request('tools/call', { name: 'result', arguments: args })).result;
  const stop = async () => { child.stdin.end(); child.kill('SIGKILL'); await exited; };
  return { child, init, policy, call, request, fromServer, stop, exited };
}

function tempSocket() {
  const dir = mkdtempSync(join(tmpdir(), 'fx-'));
  return { path: join(dir, 'c.sock'), done: () => rmSync(dir, { recursive: true, force: true }) };
}

const textOf = (r) => r.content.filter((b) => b.type === 'text').map((b) => b.text).join('');

function pngSize(b64) {
  const png = Buffer.from(b64, 'base64');
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'PNG signature');
  assert.equal(png.subarray(12, 16).toString('latin1'), 'IHDR');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

const CALLS = [
  { kind: 'prose', size: 4000, canary: 'CANARY-P-17' },
  { kind: 'code', size: 2500, canary: 'CANARY-C-4' },
  { kind: 'json', size: 3000, canary: 'CANARY-J-9' },
  { kind: 'image', width: 64, height: 48, canary: 'CANARY-I-2' },
];

test('S1: the same arguments give byte-identical results, in one process and in another', async () => {
  const a = await startHost();
  const b = await startHost();
  try {
    for (const args of CALLS) {
      const first = await a.call(args);
      const again = await a.call({ ...args });
      const elsewhere = await b.call(JSON.parse(JSON.stringify(args)));
      assert.equal(JSON.stringify(again), JSON.stringify(first), `${args.kind}: same process`);
      assert.equal(JSON.stringify(elsewhere), JSON.stringify(first), `${args.kind}: another process`);
      assert.notEqual(first.isError, true, `${args.kind}: not an error`);
    }
  } finally { await a.stop(); await b.stop(); }
});

test('S2: a text result is exactly the asked size with the canary at its start; json parses with the canary as its first member; an image is a PNG of the asked size with the canary beside it', async () => {
  const h = await startHost();
  try {
    for (const args of CALLS.filter((c) => c.kind !== 'image')) {
      for (const size of [args.size, args.size + 1, 257]) {
        const text = textOf(await h.call({ ...args, size }));
        assert.equal(text.length, size, `${args.kind} at ${size}`);
        if (args.kind === 'json') {
          assert.ok(text.startsWith(`{"canary":${JSON.stringify(args.canary)}`), `json at ${size} opens with its canary`);
          assert.equal(JSON.parse(text).canary, args.canary, `json at ${size} parses`);
        } else {
          assert.ok(text.startsWith(args.canary), `${args.kind} at ${size} begins with its canary`);
        }
      }
    }
    const img = await h.call({ kind: 'image', width: 37, height: 5, canary: 'CANARY-I-3' });
    const image = img.content.find((b) => b.type === 'image');
    assert.equal(image.mimeType, 'image/png');
    assert.deepEqual(pngSize(image.data), { width: 37, height: 5 });
    assert.ok(textOf(img).includes('CANARY-I-3'));
  } finally { await h.stop(); }
});

test('S3: arguments the server cannot honour get an error result naming what is wrong', async () => {
  const h = await startHost();
  try {
    const cases = [
      [{ kind: 'poem', size: 100, canary: 'C' }, /kind/],
      [{ kind: 'prose', size: 3, canary: 'CANARY-LONG' }, /size/],
      [{ kind: 'json', size: 12, canary: 'CANARY-J' }, /size/],
      [{ kind: 'prose', size: 100 }, /canary/],
      [{ kind: 'prose', size: 1.5, canary: 'C' }, /size/],
      [{ kind: 'prose', size: 1e9, canary: 'C' }, /size/],
      [{ kind: 'image', canary: 'C' }, /width/],
      [{ kind: 'image', width: 0, height: 4, canary: 'C' }, /width/],
      [{ kind: 'image', width: 2049, height: 4, canary: 'C' }, /width/],
      [{ kind: 'image', width: 4, height: 2049, canary: 'C' }, /height/],
      [{ kind: 'mixed', width: 2049, height: 4, size: 100, canary: 'C' }, /width/],
      [{ kind: 'mixed', width: 4, height: 2049, size: 100, canary: 'C' }, /height/],
    ];
    for (const [args, names] of cases) {
      const r = await h.call(args);
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.match(textOf(r), names, JSON.stringify(args));
    }
  } finally { await h.stop(); }
});

test('S4: a host command reaches the host with exactly its params, and the answer comes back whole; a host error comes back as a rejection', async () => {
  const sock = tempSocket();
  const ctl = await listenForPeers(sock.path);
  const answer = { ok: true, maintenance: { intervalMs: 5000, agents: [{ agentName: 'smoke', ready: false, pending: { compressions: 2 } }] }, hostMode: { mode: 'running' } };
  const h = await startHost({
    control: sock.path,
    answer: (msg) => (msg.params.command === 'fail' ? { error: { code: -32002, message: 'host/command requires host-owned authority' } } : { result: answer }),
  });
  try {
    await ctl.waitConnected('server', { since: 0, timeoutMs: 5000 });
    const params = { command: 'maintain', requesterName: 'fixture', nested: { a: [1, 2] } };
    const got = await ctl.hostCommand(params, { timeoutMs: 5000 });
    assert.deepEqual(got, answer);
    const sent = h.fromServer.filter((m) => m.method === 'host/command');
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].params, params);
    await assert.rejects(ctl.hostCommand({ command: 'fail' }, { timeoutMs: 5000 }), (e) => e.code === -32002 && /host-owned authority/.test(e.message));
  } finally { await h.stop(); await ctl.close(); sock.done(); }
});

test('S5: with no server connected, a host command rejects at once', { timeout: 5000 }, async () => {
  const sock = tempSocket();
  const ctl = await listenForPeers(sock.path);
  try {
    await assert.rejects(ctl.hostCommand({ command: 'maintain' }, { timeoutMs: 600_000 }), /no server is connected/);
  } finally { await ctl.close(); sock.done(); }
});

test('S5: a command pending when the connection closes rejects at once', { timeout: 5000 }, async () => {
  const sock = tempSocket();
  const ctl = await listenForPeers(sock.path);
  const h = await startHost({ control: sock.path, answer: () => null });
  try {
    await ctl.waitConnected('server', { since: 0, timeoutMs: 5000 });
    const pending = ctl.hostCommand({ command: 'maintain' }, { timeoutMs: 600_000 });
    while (!h.fromServer.some((m) => m.method === 'host/command')) await new Promise((r) => setTimeout(r, 10));
    h.child.kill('SIGKILL');
    await assert.rejects(pending, /connection closed/);
  } finally { await h.stop(); await ctl.close(); sock.done(); }
});

test('S5: a command the host never answers rejects at the caller\'s bound, naming the command', { timeout: 5000 }, async () => {
  const sock = tempSocket();
  const ctl = await listenForPeers(sock.path);
  const h = await startHost({ control: sock.path, answer: () => null });
  try {
    await ctl.waitConnected('server', { since: 0, timeoutMs: 5000 });
    const t0 = Date.now();
    await assert.rejects(ctl.hostCommand({ command: 'maintain' }, { timeoutMs: 300 }), /maintain/);
    assert.ok(Date.now() - t0 >= 300);
  } finally { await h.stop(); await ctl.close(); sock.done(); }
});

test('S6: after a restart the new server takes the commands, and the old one closing later leaves it connected', async () => {
  const sock = tempSocket();
  const ctl = await listenForPeers(sock.path);
  const old = await startHost({ control: sock.path, answer: () => ({ result: { from: 'old' } }) });
  let fresh;
  try {
    await ctl.waitConnected('server', { since: 0, timeoutMs: 5000 });
    const gen = ctl.generation('server');
    fresh = await startHost({ control: sock.path, answer: () => ({ result: { from: 'new' } }) });
    await ctl.waitConnected('server', { since: gen, timeoutMs: 5000 });
    await old.stop();
    for (const until = Date.now() + 5000; ctl.closed('server') < 1;) {
      if (Date.now() > until) assert.fail('the control saw no server connection close within 5 s');
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.deepEqual(await ctl.hostCommand({ command: 'maintain' }, { timeoutMs: 5000 }), { from: 'new' });
  } finally { await old.stop(); await fresh?.stop(); await ctl.close(); sock.done(); }
});

const channelHost = (accepted, reason) => (msg) => {
  if (msg.method === 'channels/register') return { result: { results: msg.params.channels.map((c) => ({ id: c.id, accepted: true })) } };
  if (msg.method === 'channels/incoming') return { result: { results: msg.params.messages.map((m) => ({ messageId: m.messageId, accepted, ...(reason ? { reason } : {}) })) } };
  return { result: { ok: true } };
};

test('S7: the server registers the channels it is given, and a delivery reaches the host on its channel with its author, topic and time', async () => {
  const sock = tempSocket();
  const ctl = await listenForPeers(sock.path);
  const h = await startHost({ control: sock.path, channels: 'general, random', answer: channelHost(true) });
  const plain = await startHost();
  try {
    await ctl.waitConnected('server', { since: 0, timeoutMs: 5000 });
    const message = { channelId: 'general', messageId: 'step-7', author: { id: 'u-alice', name: 'Alice' }, topic: 'garden', text: 'CANARY-CH-1 hello', at: Date.UTC(2026, 0, 2, 3, 4, 5) };
    assert.deepEqual(await ctl.deliver(message, { timeoutMs: 5000 }), { messageId: 'step-7', accepted: true });
    const methods = h.fromServer.map((m) => m.method);
    const reg = h.fromServer.find((m) => m.method === 'channels/register');
    assert.deepEqual(reg.params.channels.map((c) => c.id), ['general', 'random']);
    assert.ok(methods.indexOf('channels/register') < methods.indexOf('channels/incoming'), 'registered before the first delivery');
    assert.deepEqual(h.fromServer.find((m) => m.method === 'channels/incoming').params, {
      messages: [{ channelId: 'general', messageId: 'step-7', author: { id: 'u-alice', name: 'Alice' }, timestamp: '2026-01-02T03:04:05.000Z', content: [{ type: 'text', text: 'CANARY-CH-1 hello' }], metadata: { topic: 'garden' } }],
    });
    await plain.call({ kind: 'prose', size: 10, canary: 'C' });
    assert.equal(plain.fromServer.some((m) => m.method === 'channels/register'), false, 'a server given no channels registers none');
  } finally { await h.stop(); await plain.stop(); await ctl.close(); sock.done(); }
});

test('S7: a refused message rejects with the host\'s reason; a channel the server doesn\'t register, or a field it can\'t send, rejects without reaching the host', async () => {
  const sock = tempSocket();
  const ctl = await listenForPeers(sock.path);
  const h = await startHost({ control: sock.path, channels: 'general', answer: channelHost(false, 'channel is tuned out') });
  try {
    await ctl.waitConnected('server', { since: 0, timeoutMs: 5000 });
    const ok = { channelId: 'general', messageId: 'm1', author: { id: 'u', name: 'U' }, text: 'hi', at: 0 };
    await assert.rejects(ctl.deliver(ok, { timeoutMs: 5000 }), /tuned out/);
    await assert.rejects(ctl.deliver({ ...ok, messageId: 'm2', channelId: 'nowhere' }, { timeoutMs: 5000 }), /nowhere/);
    await assert.rejects(ctl.deliver({ ...ok, messageId: 'm3', at: 'soon' }, { timeoutMs: 5000 }), /at must be/);
    await assert.rejects(ctl.deliver({ ...ok, messageId: 'm4', author: 'U' }, { timeoutMs: 5000 }), /author/);
    assert.deepEqual(h.fromServer.filter((m) => m.method === 'channels/incoming').map((m) => m.params.messages[0].messageId), ['m1']);
  } finally { await h.stop(); await ctl.close(); sock.done(); }
});

test('S8: a reply published to one of the server\'s channels is delivered, with ids fixed by boot and order; one to another channel is refused with a reason', async () => {
  const publish = (h, channelId, extra = {}) => h.request('channels/publish', { conversationId: 'smoke', channelId, content: [{ type: 'text', text: 'Noted.' }], ...extra });
  const a = await startHost({ channels: 'general', boot: '3', answer: channelHost(true) });
  const b = await startHost({ channels: 'general', boot: '3', answer: channelHost(true) });
  const later = await startHost({ channels: 'general', boot: '4', answer: channelHost(true) });
  try {
    const first = [(await publish(a, 'general')).result, (await publish(a, 'general', { threadId: null })).result];
    assert.deepEqual(first, [{ delivered: true, messageId: 'pub-3-1' }, { delivered: true, messageId: 'pub-3-2', threadId: null }]);
    const again = [(await publish(b, 'general')).result, (await publish(b, 'general', { threadId: null })).result];
    assert.deepEqual(again, first, 'the same boot and order give the same ids');
    assert.equal((await publish(later, 'general')).result.messageId, 'pub-4-1', 'a later boot gives ids of its own');
    const elsewhere = (await publish(a, 'nowhere')).result;
    assert.equal(elsewhere.delivered, false);
    assert.match(elsewhere.reason, /nowhere/);
  } finally { await a.stop(); await b.stop(); await later.stop(); }
});

test('S2b: an image\'s pixels are stored, not compressed, so the same colours give the same bytes from any zlib', () => {
  for (const n of [0, 1, 65_535, 65_536, 200_001]) {
    const raw = Buffer.from(Array.from({ length: n }, (_, i) => (i * 7) % 256));
    const z = zlibStored(raw);
    assert.deepEqual(inflateSync(z), raw, `${n} bytes round-trip through zlib`);
    // Stored blocks: each a 5-byte head (BTYPE 00) then its bytes as they are, between the zlib head and the Adler-32.
    const blocks = Math.max(1, Math.ceil(n / 0xffff));
    assert.equal(z.length, 2 + 5 * blocks + n + 4, `${n} bytes stored, not compressed`);
    for (let k = 0, at = 2; k < blocks; k++) {
      const len = z.readUInt16LE(at + 1);
      assert.equal(z[at] & 0b110, 0, `block ${k} of ${n} bytes is stored`);
      assert.deepEqual(z.subarray(at + 5, at + 5 + len), raw.subarray(k * 0xffff, k * 0xffff + len));
      at += 5 + len;
    }
  }
  const picker = () => { let k = 1; return (m) => { k = (k * 1103515245 + 12345) % 2147483648; return k % m; }; };
  const a = Buffer.from(png(400, 300, picker()), 'base64');
  assert.deepEqual(Buffer.from(png(400, 300, picker()), 'base64'), a, 'the same picks, the same bytes');
  assert.equal(createHash('sha256').update(Buffer.from(png(4, 3, picker()), 'base64')).digest('hex'), 'eead022f35527e799e94602d980ca449c99a8a93dcf6bb55697021884a7c68d3', 'the bytes themselves, as any zlib leaves them');
  const idat = a.indexOf('IDAT', 0, 'latin1');
  const pixels = inflateSync(a.subarray(idat + 4, idat + 4 + a.readUInt32BE(idat - 4)));
  assert.equal(pixels.length, 300 * (1 + 400 * 3), 'one filter byte and three per pixel, for each row');
});

test('S9: a delivery\'s images reach the host after its text, as image blocks; images that aren\'t { data, mimeType } reject without reaching the host', async () => {
  const sock = tempSocket();
  const ctl = await listenForPeers(sock.path);
  const h = await startHost({ control: sock.path, channels: 'general', answer: channelHost(true) });
  try {
    await ctl.waitConnected('server', { since: 0, timeoutMs: 5000 });
    const message = { channelId: 'general', messageId: 'pic', author: { id: 'u', name: 'U' }, text: 'CANARY-IMG look', images: [{ data: 'aGVsbG8=', mimeType: 'image/png' }], at: 0 };
    await ctl.deliver(message, { timeoutMs: 5000 });
    assert.deepEqual(h.fromServer.find((m) => m.method === 'channels/incoming').params.messages[0].content, [{ type: 'text', text: 'CANARY-IMG look' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }]);
    await assert.rejects(ctl.deliver({ ...message, messageId: 'bad', images: [{ data: 'x' }] }, { timeoutMs: 5000 }), /images/);
    assert.equal(h.fromServer.filter((m) => m.method === 'channels/incoming').length, 1);
  } finally { await h.stop(); await ctl.close(); sock.done(); }
});

test('S10: a call whose arguments say hold is answered only when the driver releases its canary, and the driver hears that it\'s held; releasing a canary no call holds rejects', async () => {
  const sock = tempSocket();
  const ctl = await listenForPeers(sock.path);
  const notices = [];
  ctl.onNotice((n) => notices.push(n));
  const h = await startHost({ control: sock.path });
  try {
    await ctl.waitConnected('server', { since: 0, timeoutMs: 5000 });
    let answered = null;
    const held = h.call({ kind: 'prose', size: 200, canary: 'CANARY-H-1', hold: true }).then((r) => { answered = r; return r; });
    for (const until = Date.now() + 5000; !notices.length;) {
      if (Date.now() > until) assert.fail('no held notice came within 5 s');
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.deepEqual(notices, [{ peer: 'server', notice: 'held', canary: 'CANARY-H-1' }]);
    assert.equal(textOf(await h.call({ kind: 'prose', size: 50, canary: 'CANARY-H-2' })).length, 50, 'other calls are answered meanwhile');
    assert.equal(answered, null);
    assert.deepEqual(await ctl.release('CANARY-H-1', { timeoutMs: 5000 }), { released: 'CANARY-H-1' });
    const r = await held;
    assert.equal(textOf(r).length, 200);
    assert.ok(textOf(r).startsWith('CANARY-H-1'));
    await assert.rejects(ctl.release('CANARY-H-1', { timeoutMs: 5000 }), /no call carrying/);
  } finally { await h.stop(); await ctl.close(); sock.done(); }
});

test('S11: a mixed result is a text, an image of the asked size and a text, the two texts together the asked size, each starting with the canary', async () => {
  const h = await startHost();
  try {
    const r = await h.call({ kind: 'mixed', size: 300, width: 32, height: 24, canary: 'CANARY-M-1' });
    assert.deepEqual(r.content.map((b) => b.type), ['text', 'image', 'text']);
    assert.equal(r.content[0].text.length + r.content[2].text.length, 300);
    assert.ok(r.content[0].text.startsWith('CANARY-M-1') && r.content[2].text.startsWith('CANARY-M-1'));
    assert.deepEqual(pngSize(r.content[1].data), { width: 32, height: 24 });
    assert.equal((await h.call({ kind: 'mixed', size: 300, canary: 'CANARY-M-2' })).isError, true, 'a mixed result needs its image size');
  } finally { await h.stop(); }
});

test('S12: a delivery\'s tags reach the host with it; tags that aren\'t strings reject without reaching the host', async () => {
  const sock = tempSocket();
  const ctl = await listenForPeers(sock.path);
  const h = await startHost({ control: sock.path, channels: 'general', answer: channelHost(true) });
  try {
    await ctl.waitConnected('server', { since: 0, timeoutMs: 5000 });
    const message = { channelId: 'general', messageId: 'tagged', author: { id: 'u', name: 'U' }, text: 'CANARY-T hi', tags: ['chat:addressed'], at: 0 };
    await ctl.deliver(message, { timeoutMs: 5000 });
    assert.deepEqual(h.fromServer.find((m) => m.method === 'channels/incoming').params.messages[0].tags, ['chat:addressed']);
    await assert.rejects(ctl.deliver({ ...message, messageId: 'bad', tags: [1] }, { timeoutMs: 5000 }), /tags/);
    assert.equal(h.fromServer.filter((m) => m.method === 'channels/incoming').length, 1);
  } finally { await h.stop(); await ctl.close(); sock.done(); }
});
