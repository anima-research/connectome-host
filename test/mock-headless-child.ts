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

  emit({ type: 'lifecycle', phase: 'ready', pid: process.pid, dataDir });
});

function simulateFinalInference(text: string, emitIdleAfter: boolean): void {
  emit({ type: 'inference:started', agentName: 'mock' });
  emit({ type: 'inference:speech', agentName: 'mock', content: text });
  emit({ type: 'inference:completed', agentName: 'mock' });
  if (emitIdleAfter) {
    setTimeout(() => emit({ type: 'lifecycle', phase: 'idle' }), 30);
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
    simulateFinalInference(`echo: ${msg.content}`, true);
    return;
  }
  if (t === 'command' && typeof msg.command === 'string') {
    const cmd = msg.command;
    if (cmd === '/hang') {
      emit({ type: 'inference:started', agentName: 'mock' });
      emit({ type: 'inference:speech', agentName: 'mock', content: 'still thinking' });
      emit({ type: 'inference:completed', agentName: 'mock' });
      return;
    }
    if (cmd === '/crash') {
      process.exit(1);
    }
    if (cmd.startsWith('/tool-use-then-speak ')) {
      const finalText = cmd.slice('/tool-use-then-speak '.length);
      emit({ type: 'inference:started', agentName: 'mock' });
      emit({ type: 'inference:tokens', agentName: 'mock', content: 'let me think' });
      emit({ type: 'inference:tool_calls_yielded', agentName: 'mock', calls: [{ id: 't1', name: 'dummy', input: {} }] });
      emit({ type: 'inference:completed', agentName: 'mock' });
      setTimeout(() => simulateFinalInference(finalText, true), 20);
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
