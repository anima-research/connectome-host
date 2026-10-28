import { createServer, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { existsSync, unlinkSync, mkdirSync, writeFileSync } from 'node:fs';

const dataDir = resolve(process.env.DATA_DIR || './data');
mkdirSync(dataDir, { recursive: true });
const socketPath = join(dataDir, 'ipc.sock');
const pidPath = join(dataDir, 'headless.pid');

if (existsSync(socketPath)) {
  try { unlinkSync(socketPath); } catch { }
}
writeFileSync(pidPath, String(process.pid));

let currentClient: Socket | null = null;

function emit(obj: Record<string, unknown>): void {
  if (!currentClient) return;
  try {
    currentClient.write(JSON.stringify({ ...obj, ts: Date.now() }) + '\n');
  } catch { }
}

const server = createServer((sock) => {
  if (currentClient) {
    try { currentClient.end(); } catch { }
  }
  currentClient = sock;
  textsReceived = 0;

  sock.setEncoding('utf8');
  let buf = '';
  sock.on('data', (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      dispatch(msg);
    }
  });

  sock.on('end', () => { if (currentClient === sock) currentClient = null; });
  sock.on('error', () => { });

  emit({ type: 'lifecycle', phase: 'ready', pid: process.pid, dataDir, idle: idleSaid });
  if (bootTurn) {
    bootTurn = false;
    emit({ type: 'inference:started', agentName: 'mock', replay: true });
    emit({ type: 'inference:completed', agentName: 'mock', replay: true });
  }
});

let bootTurn = process.env.MOCK_BOOT_TURN === '1';
let idleSaid = bootTurn;
let textsReceived = 0;

function started(): void {
  idleSaid = false;
  emit({ type: 'inference:started', agentName: 'mock' });
}

function idle(texts: number | null = textsReceived): void {
  idleSaid = true;
  emit({ type: 'lifecycle', phase: 'idle', ...(texts === null ? {} : { texts }) });
}

function simulateFinalInference(text: string, emitIdleAfter: boolean): void {
  started();
  emit({ type: 'inference:speech', agentName: 'mock', content: text });
  emit({ type: 'inference:completed', agentName: 'mock' });
  if (emitIdleAfter) {
    setTimeout(idle, 30);
  }
}

function dispatch(msg: Record<string, unknown>): void {
  const t = typeof msg.type === 'string' ? msg.type : '';
  if (t === 'subscribe') return;
  if (t === 'panel-request') {
    const op = typeof msg.op === 'string' ? msg.op : '';
    if (op === 'hang') return;
    if (op === 'fail') {
      emit({ type: 'panel-response', corrId: msg.corrId, op, ok: false, error: 'mock failure', status: 418 });
      return;
    }
    emit({ type: 'panel-response', corrId: msg.corrId, op, ok: true, data: { op, echo: msg.params ?? null } });
    return;
  }
  if (t === 'update-request') {
    const request = (msg.request ?? {}) as Record<string, unknown>;
    emit({ type: 'panel-response', corrId: msg.corrId, op: 'not-this', ok: true, data: { decoy: true } });
    emit({
      type: 'update-response', corrId: msg.corrId, ok: true,
      data: request.op === 'quiesce'
        ? { drained: false, activeTurnAgents: ['mock'], backgroundScripts: 0, echo: request }
        : { resumed: true, echo: request },
    });
    return;
  }
  if (t === 'shutdown') {
    emit({ type: 'lifecycle', phase: 'exiting', reason: 'shutdown' });
    setTimeout(() => process.exit(0), 50);
    return;
  }
  if (t === 'text' && typeof msg.content === 'string') {
    textsReceived += 1;
    idleSaid = false;
    const held = /^held:(.+)$/.exec(msg.content);
    if (held) {
      started();
      const releasedAt = held[1];
      const watching = setInterval(() => {
        if (!existsSync(releasedAt)) return;
        clearInterval(watching);
        emit({ type: 'inference:speech', agentName: 'mock', content: `echo: ${msg.content}` });
        emit({ type: 'inference:completed', agentName: 'mock' });
        setTimeout(idle, 30);
      }, 20);
      return;
    }
    const late = /^late:(\d+)/.exec(msg.content);
    if (late) {
      setTimeout(started, Number(late[1]));
      return;
    }
    const slow = /^slow:(\d+)/.exec(msg.content);
    if (slow) {
      started();
      setTimeout(() => {
        emit({ type: 'inference:speech', agentName: 'mock', content: `echo: ${msg.content}` });
        emit({ type: 'inference:completed', agentName: 'mock' });
        setTimeout(idle, 30);
      }, Number(slow[1]));
      return;
    }
    if (msg.content === 'stale-start-and-idle-first') {
      emit({ type: 'inference:started', agentName: 'mock' });
      emit({ type: 'lifecycle', phase: 'idle', texts: textsReceived - 1 });
      setTimeout(() => simulateFinalInference(`echo: ${msg.content}`, true), 300);
      return;
    }
    if (msg.content === 'no-texts') {
      started();
      emit({ type: 'inference:completed', agentName: 'mock' });
      setTimeout(() => idle(null), 30);
      return;
    }
    simulateFinalInference(`echo: ${msg.content}`, true);
    return;
  }
  if (t === 'command' && typeof msg.command === 'string') {
    const cmd = msg.command;
    if (cmd === '/hang') {
      started();
      emit({ type: 'inference:speech', agentName: 'mock', content: 'still thinking' });
      emit({ type: 'inference:completed', agentName: 'mock' });
      return;
    }
    if (cmd === '/crash') {
      process.exit(1);
    }
    if (cmd.startsWith('/tool-use-then-speak ')) {
      const finalText = cmd.slice('/tool-use-then-speak '.length);
      started();
      emit({ type: 'inference:tokens', agentName: 'mock', content: 'let me think' });
      emit({ type: 'inference:tool_calls_yielded', agentName: 'mock', calls: [{ id: 't1', name: 'dummy', input: {} }] });
      emit({ type: 'inference:completed', agentName: 'mock' });
      setTimeout(() => simulateFinalInference(finalText, true), 20);
      return;
    }
    if (cmd === '/exit-after-idle') {
      started();
      emit({ type: 'inference:completed', agentName: 'mock' });
      idle();
      setTimeout(() => {
        emit({ type: 'lifecycle', phase: 'exiting', reason: 'test' });
        setTimeout(() => process.exit(0), 50);
      }, 100);
      return;
    }
    if (cmd === '/turn-later') {
      setTimeout(() => {
        started();
        setTimeout(() => {
          emit({ type: 'inference:completed', agentName: 'mock' });
          idle();
        }, 400);
      }, 50);
      return;
    }
    if (cmd === '/help') {
      emit({ type: 'command-output', text: '--- mock help ---', style: 'system' });
      emit({ type: 'command-output', text: '  no real commands here', style: 'system' });
      return;
    }
  }
}

server.listen(socketPath);
server.on('error', () => { });

process.on('SIGTERM', () => {
  emit({ type: 'lifecycle', phase: 'exiting', reason: 'sigterm' });
  setTimeout(() => process.exit(0), 50);
});
