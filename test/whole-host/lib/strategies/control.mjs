import { createServer } from 'node:net';
import { rmSync } from 'node:fs';

export function lineReader(stream, onMessage) {
  let buf = '';
  stream.setEncoding('utf-8');
  stream.on('data', (part) => {
    buf += part;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      onMessage(msg);
    }
  });
}

export async function listenForPeers(path) {
  rmSync(path, { force: true });
  const sockets = new Set();
  const pending = new Map();
  const waiters = new Set();
  const current = new Map();
  const generations = new Map();
  const closings = new Map();
  const noticeListeners = [];
  let nextId = 1;

  const settle = (id, fn) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    fn(p);
  };

  const server = createServer((sock) => {
    sockets.add(sock);
    const conn = { sock, peer: null };
    lineReader(sock, (msg) => {
      if (msg.type === 'hello') {
        conn.peer = String(msg.peer);
        generations.set(conn.peer, (generations.get(conn.peer) ?? 0) + 1);
        current.set(conn.peer, conn);
        for (const w of waiters) if (w.peer === conn.peer && generations.get(conn.peer) > w.since) w.done();
        return;
      }
      if (msg.type === 'notice') {
        const { type, ...notice } = msg;
        for (const cb of noticeListeners) cb({ peer: conn.peer, ...notice });
        return;
      }
      settle(msg.id, (p) => (msg.error
        ? p.reject(Object.assign(new Error(`${p.label} failed: ${msg.error.message}`), { code: msg.error.code, data: msg.error.data }))
        : p.resolve(msg.result)));
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      sockets.delete(sock);
      if (conn.peer) closings.set(conn.peer, (closings.get(conn.peer) ?? 0) + 1);
      if (current.get(conn.peer) === conn) current.delete(conn.peer);
      for (const [id, p] of pending) {
        if (p.conn === conn) settle(id, () => p.reject(new Error(`the fixture ${conn.peer}'s connection closed while ${p.label} was pending`)));
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });

  const request = (peer, op, body, label, timeoutMs) => {
    const conn = current.get(peer);
    if (!conn) return Promise.reject(new Error(`no ${peer} is connected to ${path}, so ${label} wasn't sent`));
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => settle(id, () => reject(new Error(`${label} had no answer in ${timeoutMs} ms`))), timeoutMs);
      pending.set(id, { resolve, reject, timer, label, conn });
      conn.sock.write(`${JSON.stringify({ id, op, ...body })}\n`);
    });
  };

  return {
    generation(peer) { return generations.get(peer) ?? 0; },
    closed(peer) { return closings.get(peer) ?? 0; },
    waitConnected(peer, { since = 0, timeoutMs = 30_000 } = {}) {
      if ((generations.get(peer) ?? 0) > since && current.has(peer)) return Promise.resolve(generations.get(peer));
      return new Promise((resolve, reject) => {
        const w = {
          peer,
          since,
          done: () => { waiters.delete(w); clearTimeout(w.timer); resolve(generations.get(peer)); },
          fail: (e) => { waiters.delete(w); clearTimeout(w.timer); reject(e); },
          timer: setTimeout(() => { waiters.delete(w); reject(new Error(`no fixture ${peer} connected to ${path} within ${timeoutMs} ms`)); }, timeoutMs),
        };
        waiters.add(w);
      });
    },
    hostCommand(params, { timeoutMs = 60_000 } = {}) {
      return request('server', 'host', { params }, `host/command ${String(params?.command)}`, timeoutMs);
    },
    async deliver(message, { timeoutMs = 60_000 } = {}) {
      const label = `delivery ${JSON.stringify(message?.messageId)} to channel ${JSON.stringify(message?.channelId)}`;
      const answer = await request('server', 'deliver', { message }, label, timeoutMs);
      const item = answer?.results?.find?.((r) => r.messageId === message.messageId);
      if (!item?.accepted) throw new Error(`the host didn't accept ${label}: ${item?.reason ?? JSON.stringify(answer)}`);
      return item;
    },
    moduleRequest(op, body = {}, { timeoutMs = 60_000 } = {}) {
      return request('module', op, body, `the harness module's ${op}`, timeoutMs);
    },
    advance(at, { timeoutMs = 10_000 } = {}) {
      return request('clock', 'advance', { at }, `advancing the clock to ${JSON.stringify(at)}`, timeoutMs);
    },
    release(canary, { timeoutMs = 10_000 } = {}) {
      return request('server', 'release', { canary }, `releasing the call held for ${JSON.stringify(canary)}`, timeoutMs);
    },
    onNotice(cb) { noticeListeners.push(cb); },
    async close() {
      for (const [id, p] of pending) settle(id, () => p.reject(new Error(`the control socket closed while ${p.label} was pending`)));
      for (const w of waiters) w.fail(new Error(`the control socket at ${path} closed before a fixture ${w.peer} connected`));
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
      rmSync(path, { force: true });
    },
  };
}
