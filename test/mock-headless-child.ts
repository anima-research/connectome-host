/**
 * Minimal wire-protocol-only mock of a headless child, used as
 * FleetModuleConfig.childIndexPath in orchestration tests.
 *
 * Implements just enough of the parent↔child protocol to exercise
 * fleet--relay / fleet--await / lifecycle:idle / inference:speech
 * without spinning up the full framework + Membrane + Chronicle stack.
 *
 * Commands it understands (on top of shutdown/subscribe from the real one):
 *   { "type": "text", "content": "..." }
 *       → emit inference:started, inference:speech, inference:completed,
 *         then lifecycle:idle after ~30ms (simulates final-inference round).
 *
 *   { "type": "command", "command": "/hang" }
 *       → same as text but SKIP the lifecycle:idle emit (for await timeout).
 *
 *   { "type": "command", "command": "/crash" }
 *       → process.exit(1) (for await crash-detection test).
 *
 *   { "type": "command", "command": "/tool-use-then-speak <text>" }
 *       → simulate a tool-using turn (tool_calls_yielded clears speech)
 *         followed by a final turn with the supplied text.
 */
import { createServer, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { existsSync, unlinkSync, mkdirSync, writeFileSync } from 'node:fs';

const dataDir = resolve(process.env.DATA_DIR || './data');
mkdirSync(dataDir, { recursive: true });
const socketPath = join(dataDir, 'ipc.sock');
const pidPath = join(dataDir, 'headless.pid');

if (existsSync(socketPath)) {
  try { unlinkSync(socketPath); } catch { /* noop */ }
}
writeFileSync(pidPath, String(process.pid));

let currentClient: Socket | null = null;

function emit(obj: Record<string, unknown>): void {
  if (!currentClient) return;
  try {
    currentClient.write(JSON.stringify({ ...obj, ts: Date.now() }) + '\n');
  } catch { /* noop */ }
}

const server = createServer((sock) => {
  if (currentClient) {
    try { currentClient.end(); } catch { /* noop */ }
  }
  currentClient = sock;

  let buf = '';
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf-8');
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
  sock.on('error', () => { /* swallow */ });

  // Ready with our own pid.
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
  if (t === 'subscribe') return;  // accept silently
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
      // Simulate text intake without going idle — for await-timeout testing.
      emit({ type: 'inference:started', agentName: 'mock' });
      emit({ type: 'inference:speech', agentName: 'mock', content: 'still thinking' });
      emit({ type: 'inference:completed', agentName: 'mock' });
      // No lifecycle:idle.
      return;
    }
    if (cmd === '/crash') {
      process.exit(1);
    }
    if (cmd.startsWith('/tool-use-then-speak ')) {
      const finalText = cmd.slice('/tool-use-then-speak '.length);
      // Round 1: thought preamble that ends in tool calls — speech tracker resets.
      emit({ type: 'inference:started', agentName: 'mock' });
      emit({ type: 'inference:tokens', agentName: 'mock', content: 'let me think' });
      emit({ type: 'inference:tool_calls_yielded', agentName: 'mock', calls: [{ id: 't1', name: 'dummy', input: {} }] });
      emit({ type: 'inference:completed', agentName: 'mock' });
      // Round 2: final speech — should be the one that lands in lastCompletedSpeech.
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
server.on('error', () => { /* swallow */ });

process.on('SIGTERM', () => {
  emit({ type: 'lifecycle', phase: 'exiting', reason: 'sigterm' });
  setTimeout(() => process.exit(0), 50);
});
