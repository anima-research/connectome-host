import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listenForPeers } from '../lib/strategies/control.mjs';

const PRELOAD = fileURLToPath(new URL('../lib/strategies/virtual-date.mjs', import.meta.url));
const noBun = spawnSync('bun', ['--version']).status === 0 ? false : 'bun is not on PATH';
const EPOCH = Date.UTC(2026, 0, 5, 9, 30, 0);
const ANSWER_BOUND_MS = 10_000;
const children = new Set();
after(() => { for (const child of children) child.kill('SIGKILL'); });

const TARGET = `
import { statSync } from 'node:fs';
class Sub extends Date { tag() { return 'sub'; } }
let buf = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    buf = buf.slice(i + 1);
    try {
      const mtime = statSync(process.argv[1]).mtime;
      const made = new Date();
      const sub = new Sub();
      process.stdout.write(JSON.stringify({
        now: Date.now(), made: made.getTime(), called: Date(),
        fromParts: new Date(2020, 0, 2, 3, 4, 5).getTime(), fromMs: new Date(12345).getTime(),
        parse: Date.parse('2021-03-04T05:06:07Z'), utc: Date.UTC(2022, 1, 3),
        mtimeIsDate: mtime instanceof Date, mtimeCtor: mtime.constructor === Date,
        madeIsDate: made instanceof Date, madeCtor: made.constructor === Date,
        subTag: typeof sub.tag === 'function' ? sub.tag() : null, subIsDate: sub instanceof Date, subTime: sub.getTime(),
      }) + '\\n');
    } catch (e) { process.stdout.write(JSON.stringify({ error: String(e) }) + '\\n'); }
  }
});
`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'fxd-'));
  const target = join(dir, 'target.mjs');
  writeFileSync(target, TARGET);
  return { dir, target, sock: join(dir, 'c.sock'), done: () => rmSync(dir, { recursive: true, force: true }) };
}

function startTarget(target, env) {
  const child = spawn('bun', ['--preload', PRELOAD, target], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  child.once('exit', () => children.delete(child));
  const lines = [];
  const waiters = [];
  let buf = '';
  let stderr = '';
  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
      waiters.shift()?.();
    }
  });
  const read = () => new Promise((resolve, reject) => {
    const want = lines.length + 1;
    const timer = setTimeout(() => reject(new Error(`the target answered no read within ${ANSWER_BOUND_MS} ms`)), ANSWER_BOUND_MS);
    waiters.push(() => { if (lines.length >= want) { clearTimeout(timer); resolve(lines[want - 1]); } });
    child.stdin.write('read\n');
  });
  const exited = new Promise((r) => child.once('exit', (code) => r(code)));
  // `close` comes once the child's output streams have ended too, so what it wrote to stderr is all there.
  const closed = new Promise((r) => child.once('close', (code) => r(code)));
  return { child, read, exited, closed, stderr: () => stderr, stop: async () => { child.kill('SIGKILL'); await exited; } };
}

test('D1, D3: the clock reads the epoch and stands still; dates from arguments, parse and UTC are unchanged; every date is a Date, the runtime\'s and a subclass\'s included', { skip: noBun, timeout: 30_000 }, async () => {
  const s = setup();
  const ctl = await listenForPeers(s.sock);
  const t = startTarget(s.target, { FIXTURE_CONTROL: s.sock, FIXTURE_EPOCH_MS: String(EPOCH) });
  try {
    await ctl.waitConnected('clock', { since: 0, timeoutMs: 10_000 });
    const first = await t.read();
    assert.equal(first.now, EPOCH);
    assert.equal(first.made, EPOCH);
    assert.equal(first.called, new Date(EPOCH).toString());
    assert.equal(first.fromParts, new Date(2020, 0, 2, 3, 4, 5).getTime());
    assert.equal(first.fromMs, 12345);
    assert.equal(first.parse, Date.parse('2021-03-04T05:06:07Z'));
    assert.equal(first.utc, Date.UTC(2022, 1, 3));
    for (const k of ['mtimeIsDate', 'mtimeCtor', 'madeIsDate', 'madeCtor', 'subIsDate']) assert.equal(first[k], true, k);
    assert.equal(first.subTag, 'sub');
    assert.equal(first.subTime, EPOCH);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal((await t.read()).now, EPOCH, 'it stands still between advances');
  } finally { await t.stop(); await ctl.close(); s.done(); }
});

test('D2: an advance resolves once the process reads the new time; an earlier time or a non-time is refused and the clock keeps its time; with no clock connected an advance rejects at once', { skip: noBun, timeout: 30_000 }, async () => {
  const s = setup();
  const ctl = await listenForPeers(s.sock);
  await assert.rejects(ctl.advance(EPOCH + 1, { timeoutMs: 600_000 }), /no clock is connected/);
  const t = startTarget(s.target, { FIXTURE_CONTROL: s.sock, FIXTURE_EPOCH_MS: String(EPOCH) });
  try {
    await ctl.waitConnected('clock', { since: 0, timeoutMs: 10_000 });
    const later = EPOCH + 4 * 60_000;
    await ctl.advance(later);
    const r = await t.read();
    assert.equal(r.now, later);
    assert.equal(r.made, later);
    await assert.rejects(ctl.advance(EPOCH), /doesn't go back/);
    await assert.rejects(ctl.advance('soon'), /time in milliseconds/);
    assert.equal((await t.read()).now, later, 'a refused advance leaves the clock where it was');
  } finally { await t.stop(); await ctl.close(); s.done(); }
});

test('D4: with a FIXTURE_EPOCH_MS that isn\'t a whole number of milliseconds, the empty one included, the process does not start, and says why', { skip: noBun, timeout: 30_000 }, async () => {
  const s = setup();
  try {
    for (const env of [{ FIXTURE_EPOCH_MS: '' }, { FIXTURE_EPOCH_MS: 'tomorrow' }]) {
      const t = startTarget(s.target, env);
      const code = await Promise.race([t.closed, new Promise((r) => setTimeout(() => r('still running'), 10_000))]);
      if (code === 'still running') await t.stop();
      assert.notEqual(code, 'still running', `${JSON.stringify(env)}: it started`);
      assert.notEqual(code, 0, JSON.stringify(env));
      assert.match(t.stderr(), /FIXTURE_EPOCH_MS/, JSON.stringify(env));
    }
  } finally { s.done(); }
});
