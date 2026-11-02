// The host's web UI is a WebSocket to `/ws` on the URL it logs (`[webui] listening on <url>`); its welcome names the
// session (`welcome.session.id`), which a session-changing message such as `suppress` must carry.
export async function openWebUi({ url, basicAuth = null, timeoutMs = 30_000 }) {
  const headers = basicAuth ? { authorization: `Basic ${Buffer.from(`${basicAuth.username}:${basicAuth.password}`).toString('base64')}` } : {};
  const ws = new WebSocket(`${url.replace(/^http/, 'ws').replace(/\/$/, '')}/ws`, { headers });
  const received = [];
  const taken = new Set();
  const waiting = new Set();
  let closed = null;
  const look = () => {
    for (const w of [...waiting]) {
      const i = received.findIndex((m, k) => !taken.has(k) && w.test(m));
      if (i >= 0) { taken.add(i); waiting.delete(w); clearTimeout(w.timer); w.resolve(received[i]); }
      else if (closed) { waiting.delete(w); clearTimeout(w.timer); w.reject(new Error(`the web UI's socket closed (${closed}) before ${w.label}`)); }
    }
  };
  ws.addEventListener('message', (e) => {
    try { received.push(JSON.parse(String(e.data))); } catch { return; }
    look();
  });
  ws.addEventListener('close', (e) => { closed = `code ${e.code}${e.reason ? `: ${e.reason}` : ''}`; look(); });
  ws.addEventListener('error', () => { closed ??= 'an error'; look(); });
  const next = (test, { timeoutMs: ms = timeoutMs, label = 'the awaited message' } = {}) => new Promise((resolve, reject) => {
    const w = { test, resolve, reject, label, timer: setTimeout(() => { waiting.delete(w); reject(new Error(`no ${label} from the web UI in ${ms} ms`)); }, ms) };
    waiting.add(w);
    look();
  });
  const welcome = await next((m) => m.type === 'welcome', { label: 'welcome' });
  return {
    welcome,
    send(message) { ws.send(JSON.stringify(message)); },
    next,
    close() { try { ws.close(); } catch {} },
  };
}
