/**
 * Headless daemon runtime.
 *
 * IPC: Unix domain socket at {DATA_DIR}/ipc.sock (override with --socket-path).
 *      Wire format: JSON Lines, one envelope per line, both directions.
 *
 * Output:  framework TraceEvents (filtered by client subscription) +
 *          lifecycle events ({type:"lifecycle",phase:"ready|idle|exiting"}).
 * Input:   {type:"subscribe",events:[...]} | {type:"text",content} |
 *          {type:"command",command:"/..."} | {type:"shutdown",graceful?}
 *
 * stdout + stderr are redirected to {DATA_DIR}/headless.log so the IPC
 * channel is the only structured output path (parent uses the socket, not
 * pipes).  PID lives at {DATA_DIR}/headless.pid for parent-side liveness.
 *
 * One client at a time.  Client disconnect does NOT exit the process —
 * children stay up across parent restarts and accept the next connection.
 *
 * See HEADLESS-FLEET-PLAN.md (root) for the full protocol spec.
 */

import { createServer, type Socket, type Server } from 'node:net';
import { createWriteStream, mkdirSync, existsSync, unlinkSync, writeFileSync, type WriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AppContext } from './index.js';
import { type IncomingCommand, matchesSubscription } from './modules/fleet-types.js';

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

interface HeadlessOptions {
  socketPath?: string;
  exitWhenIdle?: boolean;
}

// ---------------------------------------------------------------------------
// Argv parsing
// ---------------------------------------------------------------------------

function parseHeadlessArgs(argv: string[]): HeadlessOptions {
  const opts: HeadlessOptions = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--socket-path' && i + 1 < argv.length) {
      opts.socketPath = argv[i + 1];
      i++;
    } else if (argv[i] === '--exit-when-idle') {
      opts.exitWhenIdle = true;
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function runHeadless(app: AppContext, argv: string[] = []): Promise<void> {
  const opts = parseHeadlessArgs(argv);
  const dataDir = resolve(process.env.DATA_DIR || './data');
  const socketPath = opts.socketPath ?? join(dataDir, 'ipc.sock');
  const logPath = join(dataDir, 'headless.log');
  const pidPath = join(dataDir, 'headless.pid');

  mkdirSync(dataDir, { recursive: true });

  // -- Redirect stdout/stderr BEFORE anything else may log --
  // The IPC socket is the only structured output channel; stdout/stderr
  // become a debug log on disk.  Done first so any later console.log from
  // framework code lands in the file, not on a parent's pipe.
  //
  // Match the real process.stdout.write overload signature so libraries
  // passing (chunk, cb) or (chunk, encoding, cb) for backpressure /
  // flush confirmation don't have their callbacks silently swallowed.
  const logStream: WriteStream = createWriteStream(logPath, { flags: 'a' });
  type StdWrite = typeof process.stdout.write;
  const makeRedirect = (): StdWrite => {
    const redirect = function (
      this: unknown,
      chunk: string | Uint8Array,
      encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
      cb?: (err?: Error | null) => void,
    ): boolean {
      if (typeof encodingOrCb === 'function') {
        return logStream.write(chunk, encodingOrCb);
      }
      if (encodingOrCb !== undefined) {
        return logStream.write(chunk, encodingOrCb, cb);
      }
      return logStream.write(chunk);
    } as StdWrite;
    return redirect;
  };
  process.stdout.write = makeRedirect();
  process.stderr.write = makeRedirect();

  const log = (msg: string): void => {
    logStream.write(`[${new Date().toISOString()}] ${msg}\n`);
  };

  log(`headless start pid=${process.pid} dataDir=${dataDir} socket=${socketPath}`);

  // -- Stale socket cleanup --
  // If a previous instance crashed without unlink, listen() would EADDRINUSE.
  // The PID file would tell us if a previous instance is still alive, but
  // for Phase 1 we assume single-tenancy per data dir and just remove.
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
      log('removed stale socket');
    } catch (err) {
      log(`stale-socket cleanup failed: ${String(err)}`);
    }
  }

  // -- PID file (for Phase 5 liveness probing by parent) --
  try {
    writeFileSync(pidPath, String(process.pid));
  } catch (err) {
    log(`pid file write failed: ${String(err)}`);
  }

  // -- Connection state --
  let currentClient: Socket | null = null;
  // Default subscription: receive everything.  Smoke-test friendly; parents
  // are expected to send their own {type:"subscribe",events:[...]} on connect.
  let subscription = new Set<string>(['*']);

  function emit(event: Record<string, unknown>): void {
    if (!currentClient) return;
    const type = typeof event.type === 'string' ? event.type : '';
    if (!matchesSubscription(type, subscription)) return;
    try {
      currentClient.write(JSON.stringify({ ...event, ts: Date.now() }) + '\n');
    } catch (err) {
      log(`emit failed for type=${type}: ${String(err)}`);
    }
  }

  // -- Wire framework trace events to socket --
  app.framework.onTrace((traceEvent) => {
    emit(traceEvent as unknown as Record<string, unknown>);
  });

  // -- Command dispatch --
  async function dispatchCommand(cmd: IncomingCommand): Promise<void> {
    switch (cmd.type) {
      case 'subscribe': {
        if (!Array.isArray(cmd.events)) {
          log('subscribe rejected: events must be array');
          return;
        }
        subscription = new Set(cmd.events);
        log(`subscription set: ${[...subscription].join(', ') || '(none)'}`);
        return;
      }
      case 'text': {
        if (typeof cmd.content !== 'string') {
          log('text rejected: content must be string');
          return;
        }
        app.framework.pushEvent({
          type: 'external-message',
          source: 'headless',
          content: cmd.content,
          metadata: {},
          triggerInference: true,
        });
        return;
      }
      case 'command': {
        if (typeof cmd.command !== 'string') {
          log('command rejected: command must be string');
          return;
        }
        const { handleCommand } = await import('./commands.js');
        const result = handleCommand(cmd.command, app);
        for (const line of result.lines) {
          emit({ type: 'command-output', text: line.text, style: line.style ?? null });
        }
        if (result.switchToSessionId) {
          await app.switchSession(result.switchToSessionId);
          emit({ type: 'command-output', text: 'Session switched.', style: 'system' });
        }
        if (result.quit) {
          await gracefulShutdown('command:/quit');
        }
        return;
      }
      case 'shutdown': {
        await gracefulShutdown(cmd.graceful === false ? 'shutdown:immediate' : 'shutdown:graceful');
        return;
      }
      default: {
        const t = (cmd as { type?: unknown }).type;
        log(`unknown command type: ${String(t)}`);
      }
    }
  }

  // -- Socket server --
  const server: Server = createServer((socket) => {
    if (currentClient) {
      log('new client connecting; closing previous client');
      try { currentClient.end(); } catch { /* noop */ }
    }
    currentClient = socket;
    log('client connected');

    // Reset subscription to default on new connection so old filters
    // don't carry across parents.
    subscription = new Set<string>(['*']);

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      let nlIdx: number;
      while ((nlIdx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nlIdx).trim();
        buffer = buffer.slice(nlIdx + 1);
        if (!line) continue;
        let parsed: IncomingCommand;
        try {
          parsed = JSON.parse(line) as IncomingCommand;
        } catch (err) {
          log(`malformed JSON line dropped (${(err as Error).message}): ${line.slice(0, 200)}`);
          continue;
        }
        // Fire-and-forget; errors logged inside dispatchCommand.
        dispatchCommand(parsed).catch((err: unknown) => {
          log(`dispatchCommand threw: ${String(err)}`);
        });
      }
    });

    socket.on('end', () => {
      if (currentClient === socket) {
        currentClient = null;
        log('client disconnected; child stays up');
      }
    });

    socket.on('error', (err) => {
      log(`client socket error: ${String(err)}`);
    });

    // Send ready event as soon as the socket is live.  The framework was
    // already started before runHeadless was invoked, so 'ready' here means
    // the IPC channel is open and the framework is accepting events.
    emit({
      type: 'lifecycle',
      phase: 'ready',
      pid: process.pid,
      dataDir,
      recipe: app.recipe.name,
    });
  });

  server.on('error', (err) => {
    log(`server error: ${String(err)}`);
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.listen(socketPath, () => {
      log(`socket listening at ${socketPath}`);
      resolveListen();
    });
    server.once('error', rejectListen);
  });

  // -- Shutdown --
  let shuttingDown = false;
  async function gracefulShutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutdown: ${reason}`);
    emit({ type: 'lifecycle', phase: 'exiting', reason });

    // Give the exiting event a tick to flush onto the socket.
    await new Promise((r) => setTimeout(r, 50));

    try { await app.framework.stop(); } catch (err) { log(`framework.stop() failed: ${String(err)}`); }
    try { server.close(); } catch (err) { log(`server.close() failed: ${String(err)}`); }
    try { if (existsSync(socketPath)) unlinkSync(socketPath); } catch (err) { log(`socket unlink failed: ${String(err)}`); }
    try { if (existsSync(pidPath)) unlinkSync(pidPath); } catch (err) { log(`pid unlink failed: ${String(err)}`); }
    try { logStream.end(); } catch { /* noop */ }

    // Small delay so logStream.end() can flush before we exit.
    setTimeout(() => process.exit(0), 50);
  }

  process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
  process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });

  // ------------------------------------------------------------------
  // Synthetic wire events: lifecycle:idle (quiescence) + inference:speech
  // ------------------------------------------------------------------
  //
  // `lifecycle:idle` fires on every work→quiescent transition so the parent
  // can implement fleet--await (block until child finished its task).
  // --exit-when-idle is a strict overlay: same detection, additionally
  // shuts down on the transition.
  //
  // `inference:speech` fires once per "final" inference round — the round
  // that completed without yielding tool calls.  It carries the accumulated
  // speech text, letting the parent implement fleet--relay without having
  // to subscribe to the whole token stream.
  {
    const IDLE_CONFIRM_MS = 500;
    const primaryAgentName = app.recipe.agent.name ?? 'agent';
    let hadAtLeastOneInference = false;
    let idleSince = 0;
    let idleEmitted = false;

    // Speech accumulator for the primary agent.  Reset on inference:started
    // and on inference:tool_calls_yielded (that round was a tool-use turn,
    // not the final speech).  Emitted on inference:completed if non-empty.
    let currentSpeech = '';

    app.framework.onTrace((event) => {
      const t = (event as { type?: string }).type;
      const agentName = (event as { agentName?: string }).agentName;

      if (t === 'inference:started') {
        hadAtLeastOneInference = true;
        idleEmitted = false;  // new activity — allow another idle emit when it ends
        if (agentName === primaryAgentName) currentSpeech = '';
      } else if (t === 'inference:tokens' && agentName === primaryAgentName) {
        const content = (event as { content?: string }).content;
        if (content) currentSpeech += content;
      } else if (t === 'inference:tool_calls_yielded' && agentName === primaryAgentName) {
        // Tool-call round: speech so far was thought preamble, not final.
        currentSpeech = '';
      } else if (t === 'inference:completed' && agentName === primaryAgentName) {
        if (currentSpeech) {
          emit({ type: 'inference:speech', agentName, content: currentSpeech });
        }
        currentSpeech = '';
      }
    });

    const idlePoll = setInterval(() => {
      if (shuttingDown) { clearInterval(idlePoll); return; }
      const agents = app.framework.getAllAgents();
      const allIdle = agents.every((a) => a.state.status === 'idle');
      if (!hadAtLeastOneInference || !allIdle) {
        idleSince = 0;
        return;
      }
      if (idleSince === 0) { idleSince = Date.now(); return; }
      if (Date.now() - idleSince >= IDLE_CONFIRM_MS && !idleEmitted) {
        idleEmitted = true;
        log('quiescent — emitting lifecycle:idle');
        emit({ type: 'lifecycle', phase: 'idle' });
        if (opts.exitWhenIdle) {
          clearInterval(idlePoll);
          void gracefulShutdown('exit-when-idle');
        }
      }
    }, 100);
  }

  // Stay up indefinitely.  Shutdown is the only thing that resolves us
  // (via process.exit), so this Promise intentionally never fulfils.
  await new Promise<void>(() => { /* park */ });
}
