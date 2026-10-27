/**
 * Headless daemon runtime.
 *
 * IPC: Unix domain socket at {DATA_DIR}/ipc.sock (override with --socket-path).
 *      Wire format: JSON Lines, one envelope per line, both directions.
 *
 * Output:  WireEvents (fleet-types.ts): framework TraceEvents and lifecycle
 *          events, each sent when the client's subscription matches it, and
 *          command-output and every command's response, always sent.
 * Input:   IncomingCommands (fleet-types.ts).
 *
 * process.stdout.write and process.stderr.write are redirected to
 * {DATA_DIR}/headless.log so the IPC channel is the only structured output
 * path (parent uses the socket, not pipes).  Bun's console.* writes to file
 * descriptors 1 and 2 directly, not through those methods, so console lines
 * go wherever those descriptors point: for a fleet child, the startup.log
 * its parent opened.  PID lives at {DATA_DIR}/headless.pid for parent-side
 * liveness.
 *
 * One client at a time.  Client disconnect does NOT exit the process —
 * children stay up across parent restarts and accept the next connection.
 *
 * See docs/fleet-protocol.md for the protocol reference.
 */

import { createServer, type Socket, type Server } from 'node:net';
import { createWriteStream, mkdirSync, existsSync, unlinkSync, writeFileSync, type WriteStream } from 'node:fs';
import { sessionMarker } from './bug-report.js';
import { join, resolve } from 'node:path';
import type { AppContext } from './index.js';
import type { TraceEvent } from '@animalabs/agent-framework';
import { type IncomingCommand, matchesSubscription } from './modules/fleet-types.js';
import { AgentTreeReducer } from './state/agent-tree-reducer.js';
import { takeRecipeWarnings } from './recipe.js';
import { workspaceReadFields } from './workspace-read-result.js';
import { SELF_RESTART_EXIT_CODE, selfRestart } from './self-restart.js';
import { RESTART_EXIT_CODE } from './update/contract.js';
import { hostUpdate } from './update/update.js';

interface HeadlessOptions {
  socketPath?: string;
  exitWhenIdle?: boolean;
}

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

const LOG_FLUSH_LIMIT_MS = 2_000;
const EXITING_FLUSH_MS = 50;

let activeLog: WriteStream | null = null;

/** process.exit drops a stream's pending writes, so the exits made while
 *  headless.log is open wait for this first. */
export function endHeadlessLog(): Promise<void> {
  const stream = activeLog;
  if (!stream) return Promise.resolve();
  return new Promise((done) => {
    const limit = setTimeout(() => {
      // This reaches the process's own stderr: under Bun console.error
      // writes there directly, and under Node through the redirect, which
      // sends what's written once the log has ended there.
      console.error(`[host] headless.log hadn't taken its last lines after ${LOG_FLUSH_LIMIT_MS / 1000} s, so this exit goes ahead without them`);
      done();
    }, LOG_FLUSH_LIMIT_MS);
    stream.end(() => { clearTimeout(limit); done(); });
  });
}

export async function runHeadless(app: AppContext, argv: string[] = []): Promise<void> {
  const opts = parseHeadlessArgs(argv);
  const dataDir = resolve(process.env.DATA_DIR || './data');
  const socketPath = opts.socketPath ?? join(dataDir, 'ipc.sock');
  const logPath = join(dataDir, 'headless.log');
  const pidPath = join(dataDir, 'headless.pid');

  mkdirSync(dataDir, { recursive: true });
  selfRestart.attachHeadless();

  // Bun's console.* bypasses these methods and writes to descriptors 1 and 2,
  // which for a fleet child are its startup.log, so console lines from
  // framework code land there, not here.
  //
  // Match the real process.stdout.write overload signature so libraries
  // passing (chunk, cb) or (chunk, encoding, cb) for backpressure /
  // flush confirmation don't have their callbacks silently swallowed.
  const logStream: WriteStream = createWriteStream(logPath, { flags: 'a' });
  activeLog = logStream;
  logStream.write(`\n${sessionMarker(new Date())}\n`);
  type StdWrite = typeof process.stdout.write;
  // Once endHeadlessLog has ended the stream, such a line goes to the
  // process's own stderr instead, whichever stream it was written to:
  // writing it to the ended stream would make the stream error, drop the
  // lines still pending and, with nothing listening, end the process.
  const toStderr = process.stderr.write.bind(process.stderr) as (...args: unknown[]) => boolean;
  const writeLog = (
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean => {
    if (logStream.writableEnded) return toStderr(chunk, encodingOrCb, cb);
    return typeof encodingOrCb === 'function'
      ? logStream.write(chunk, encodingOrCb)
      : logStream.write(chunk, encodingOrCb as BufferEncoding, cb);
  };
  const makeRedirect = (): StdWrite => function (
    this: unknown,
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean {
    return writeLog(chunk, encodingOrCb, cb);
  } as StdWrite;
  process.stdout.write = makeRedirect();
  process.stderr.write = makeRedirect();

  const log = (msg: string): void => {
    writeLog(`[${new Date().toISOString()}] ${msg}\n`);
  };

  log(`headless start pid=${process.pid} dataDir=${dataDir} socket=${socketPath}`);
  for (const warning of takeRecipeWarnings()) log(`warning: ${warning}`);

  // A previous instance that crashed without unlinking its socket would make
  // listen() fail with EADDRINUSE.
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
      log('removed stale socket');
    } catch (err) {
      log(`stale-socket cleanup failed: ${String(err)}`);
    }
  }

  try {
    writeFileSync(pidPath, String(process.pid));
  } catch (err) {
    log(`pid file write failed: ${String(err)}`);
  }

  let shuttingDown = false;

  let currentClient: Socket | null = null;
  // Framework events from before the first client connected, sent to it on
  // connect so a parent that attaches after the boot still hears it (the
  // restart notices a re-created tune-out epoch or an ended fork leave).
  // The FIRST 1,000 are kept — the boot is what they are for — and the
  // count past that is said. Null once a client has connected: a later
  // client sends `describe` for a snapshot.
  let bootEvents: Record<string, unknown>[] | null = [];
  let bootDropped = 0;
  const BOOT_EVENT_CAP = 1000;
  let subscription = new Set<string>(['*']);

  const FILTER_EXEMPT = new Set<string>([
    'snapshot',
    'lessons-snapshot',
    'workspace-mounts-snapshot',
    'workspace-tree-snapshot',
    'workspace-file-snapshot',
    'cancel-subagent-result',
    'panel-response',
    'update-response',
    'command-output',
  ]);

  function emit(event: Record<string, unknown>): void {
    // A socket that has ended or errored takes no more writes. It stops being
    // current at its 'end' or 'close', but an error comes a tick before that.
    if (!currentClient || currentClient.destroyed || currentClient.writableEnded) return;
    const type = typeof event.type === 'string' ? event.type : '';
    if (!FILTER_EXEMPT.has(type) && !matchesSubscription(type, subscription)) return;
    try {
      currentClient.write(JSON.stringify({ ...event, ts: Date.now() }) + '\n');
    } catch (err) {
      log(`emit failed for type=${type}: ${String(err)}`);
    }
  }

  const treeReducer = new AgentTreeReducer();
  try {
    treeReducer.seedFrameworkAgents(app.framework.getAllAgents().map(a => a.name));
  } catch (err) {
    log(`seed framework agents failed: ${String(err)}`);
  }
  const startedAt = Date.now();

  // The boot comes first: main() holds what create() replays and what
  // start() emitted before this sink existed (registry restore, work a stop
  // cut off, resumed tune-out epochs), so the tree sees the boot whole. No
  // client is connected yet and emit() would drop them, so until the first
  // client connects the events are kept for it instead.
  const onFrameworkTrace = (traceEvent: TraceEvent): void => {
    treeReducer.applyEvent(traceEvent);
    const event = traceEvent as unknown as Record<string, unknown>;
    if (bootEvents && !currentClient) {
      if (bootEvents.length < BOOT_EVENT_CAP) bootEvents.push(event);
      else bootDropped++;
      return;
    }
    emit(event);
  };
  if (app.bootTraces) bootDropped += app.bootTraces.handOver(onFrameworkTrace);
  else app.framework.onTrace(onFrameworkTrace);

  const droppedCommands = new WeakMap<Socket, number>();

  async function dispatchCommand(cmd: IncomingCommand, requester: Socket): Promise<void> {
    // Only the current client commands the child. A superseded client is
    // end()ed, but lines it wrote before it learned of that still arrive, and
    // so do lines it writes afterwards on runtimes where end() only
    // half-closes the socket, as in Node (Bun 1.4.2). Its subscribe would
    // replace the current client's filter, and its text would reach the
    // agent. So whatever the child reads from it after the takeover is
    // dropped: the first command logged, the rest counted at its disconnect.
    // The rule applies when a line is read: a command admitted while its
    // client was current finishes, and reply() below drops its answers.
    if (requester !== currentClient) {
      const dropped = (droppedCommands.get(requester) ?? 0) + 1;
      droppedCommands.set(requester, dropped);
      if (dropped === 1) log(`command dropped: ${String(cmd.type).slice(0, 80)}; its client was superseded`);
      return;
    }
    const reply = (event: Record<string, unknown>): void => {
      if (currentClient !== requester || requester.destroyed || requester.writableEnded) {
        log(`reply dropped: ${String(event.type)}, requester superseded/closed`);
        return;
      }
      emit(event);
    };
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
          reply({ type: 'command-output', text: line.text, style: line.style ?? null });
        }
        if (result.asyncWork) {
          const followUp = await result.asyncWork;
          for (const line of followUp.lines) {
            reply({ type: 'command-output', text: line.text, style: line.style ?? null });
          }
        }
        if (result.switchToSessionId) {
          await app.switchSession(result.switchToSessionId);
          reply({ type: 'command-output', text: 'Session switched.', style: 'system' });
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
      case 'describe': {
        const snap = treeReducer.getSnapshot();
        reply({
          type: 'snapshot',
          corrId: cmd.corrId,
          asOfTs: snap.asOfTs,
          child: {
            name: app.recipe.name,
            pid: process.pid,
            recipe: app.recipe.name,
            startedAt,
          },
          tree: {
            nodes: snap.nodes as unknown as Array<Record<string, unknown>>,
            callIdIndex: snap.callIdIndex,
          },
        });
        return;
      }
      case 'request-lessons': {
        const mod = app.framework.getAllModules().find((m) => m.name === 'lessons') as
          | { getLessons(): Array<{ id: string; content: string; confidence: number; tags: string[]; deprecated: boolean; deprecationReason?: string; created?: number; updated?: number }> }
          | undefined;
        if (!mod) {
          reply({ type: 'lessons-snapshot', corrId: cmd.corrId, loaded: false, lessons: [] });
          return;
        }
        const lessons = mod.getLessons().map(l => ({
          id: l.id,
          content: l.content,
          confidence: l.confidence,
          tags: l.tags,
          deprecated: l.deprecated,
          ...(l.deprecationReason ? { deprecationReason: l.deprecationReason } : {}),
          ...(typeof l.created === 'number' ? { created: l.created } : {}),
          ...(typeof l.updated === 'number' ? { updated: l.updated } : {}),
        }));
        reply({ type: 'lessons-snapshot', corrId: cmd.corrId, loaded: true, lessons });
        return;
      }
      case 'request-workspace-mounts': {
        const mod = app.framework.getAllModules().find((m) => m.name === 'workspace') as
          | { handleToolCall(call: { name: string; input: unknown; id?: string }): Promise<{ success: boolean; data?: unknown; error?: string }> }
          | undefined;
        if (!mod) {
          reply({ type: 'workspace-mounts-snapshot', corrId: cmd.corrId, loaded: false, mounts: [] });
          return;
        }
        try {
          const result = await mod.handleToolCall({ name: 'ls', input: {}, id: `headless-ls-${Date.now()}` });
          const data = (result.data ?? {}) as { mounts?: Array<{ name: string; path: string; mode: string }> };
          reply({ type: 'workspace-mounts-snapshot', corrId: cmd.corrId, loaded: true, mounts: data.mounts ?? [] });
        } catch {
          reply({ type: 'workspace-mounts-snapshot', corrId: cmd.corrId, loaded: true, mounts: [] });
        }
        return;
      }
      case 'request-workspace-tree': {
        const mod = app.framework.getAllModules().find((m) => m.name === 'workspace') as
          | { handleToolCall(call: { name: string; input: unknown; id?: string }): Promise<{ success: boolean; data?: unknown; error?: string }> }
          | undefined;
        if (!mod) {
          reply({ type: 'workspace-tree-snapshot', corrId: cmd.corrId, mount: cmd.mount, entries: [] });
          return;
        }
        try {
          const result = await mod.handleToolCall({
            name: 'ls', input: { path: cmd.mount, recursive: true }, id: `headless-tree-${Date.now()}`,
          });
          const data = (result.data ?? {}) as { entries?: Array<{ path: string; size: number }> };
          reply({ type: 'workspace-tree-snapshot', corrId: cmd.corrId, mount: cmd.mount, entries: data.entries ?? [] });
        } catch {
          reply({ type: 'workspace-tree-snapshot', corrId: cmd.corrId, mount: cmd.mount, entries: [] });
        }
        return;
      }
      case 'request-workspace-file': {
        const mod = app.framework.getAllModules().find((m) => m.name === 'workspace') as
          | { handleToolCall(call: { name: string; input: unknown; id?: string }): Promise<{ success: boolean; data?: unknown; structured?: unknown; error?: string }> }
          | undefined;
        if (!mod) {
          reply({ type: 'workspace-file-snapshot', corrId: cmd.corrId, path: cmd.path, totalLines: 0, fromLine: 1, toLine: 0, content: '', truncated: false, error: 'workspace module not loaded' });
          return;
        }
        const LIMIT = 5000;
        try {
          const result = await mod.handleToolCall({
            name: 'read', input: { path: cmd.path, limit: LIMIT }, id: `headless-read-${Date.now()}`,
          });
          if (!result.success) {
            reply({ type: 'workspace-file-snapshot', corrId: cmd.corrId, path: cmd.path, totalLines: 0, fromLine: 1, toLine: 0, content: '', truncated: false, error: result.error ?? 'read failed' });
            return;
          }
          const data = workspaceReadFields(result);
          const totalLines = data.totalLines ?? 0;
          const toLine = data.toLine ?? totalLines;
          reply({
            type: 'workspace-file-snapshot',
            corrId: cmd.corrId,
            path: data.path ?? cmd.path,
            totalLines,
            fromLine: data.fromLine ?? 1,
            toLine,
            content: data.content ?? '',
            truncated: toLine < totalLines,
          });
        } catch (err) {
          reply({ type: 'workspace-file-snapshot', corrId: cmd.corrId, path: cmd.path, totalLines: 0, fromLine: 1, toLine: 0, content: '', truncated: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      case 'panel-request': {
        const op = typeof cmd.op === 'string' ? cmd.op : '';
        const { runPanelOp } = await import('./web/panel-data.js');
        const result = await runPanelOp(app, op, cmd.params ?? {});
        reply({ type: 'panel-response', corrId: cmd.corrId, op, ...result });
        return;
      }
      case 'update-request': {
        const { answerSwitchRequest } = await import('./update/quiesce.js');
        try {
          const data = await answerSwitchRequest(app.framework, cmd.request);
          reply({ type: 'update-response', corrId: cmd.corrId, ok: true, data });
        } catch (error) {
          reply({ type: 'update-response', corrId: cmd.corrId, ok: false, error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      case 'cancel-subagent': {
        const mod = app.framework.getAllModules().find((m) => m.name === 'subagent') as
          | { cancelSubagent(name: string): boolean }
          | undefined;
        if (!mod) {
          reply({
            type: 'cancel-subagent-result',
            corrId: cmd.corrId,
            name: cmd.name,
            cancelled: false,
            reason: 'subagent module not loaded',
          });
          return;
        }
        const ok = mod.cancelSubagent(cmd.name);
        reply({
          type: 'cancel-subagent-result',
          corrId: cmd.corrId,
          name: cmd.name,
          cancelled: ok,
          ...(ok ? {} : { reason: 'subagent not running' }),
        });
        return;
      }
      default: {
        const t = (cmd as { type?: unknown }).type;
        log(`unknown command type: ${String(t).slice(0, 80)}`);
      }
    }
  }

  const server: Server = createServer((socket) => {
    if (currentClient) {
      log('new client connecting; closing previous client');
      try { currentClient.end(); } catch { }
    }
    currentClient = socket;
    log('client connected');

    subscription = new Set<string>(['*']);

    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
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
        dispatchCommand(parsed, socket).catch((err: unknown) => {
          log(`dispatchCommand threw: ${String(err)}`);
        });
      }
    });

    // A client is gone at its 'end' (a clean end) or its 'close', whichever
    // comes first. 'close' follows an end and an error alike, and is the
    // only sign of a reset where a reset socket gets no 'end', as in Node
    // (Bun 1.4.2; Bun 1.3.14 gives it an 'end'): a parent that died with
    // events still unread.
    let gone = false;
    const release = (): void => {
      if (gone) return;
      gone = true;
      if (currentClient === socket) {
        currentClient = null;
        log('client disconnected; child stays up');
        return;
      }
      const dropped = droppedCommands.get(socket) ?? 0;
      log(`superseded client disconnected${dropped > 0 ? `; ${dropped} command(s) it sent after the takeover were dropped` : ''}`);
    };
    socket.on('end', release);
    socket.on('close', release);

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

    // The first client then hears the boot it missed, oldest first and each
    // marked `replay: true`, before anything live; the default subscription
    // lets all of it through, since the parent's `subscribe` can't have
    // arrived yet. If the boot outran the caps, the replay ends by saying
    // how much was cut.
    if (bootEvents) {
      const replay = bootEvents;
      bootEvents = null;
      for (const event of replay) emit({ ...event, replay: true });
      if (bootDropped > 0) emit({ type: 'lifecycle', phase: 'replay-truncated', dropped: bootDropped, kept: replay.length });
    }
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

  async function gracefulShutdown(reason: string, cleanExitCode = 0): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutdown: ${reason}`);
    emit({ type: 'lifecycle', phase: 'exiting', reason });

    await new Promise((r) => setTimeout(r, EXITING_FLUSH_MS));

    let exitCode = cleanExitCode;
    try { await app.framework.stop(); } catch (err) {
      exitCode = 1;
      log(`framework.stop() failed: ${String(err)}`);
    }
    try { server.close(); } catch (err) { log(`server.close() failed: ${String(err)}`); }
    try { if (existsSync(socketPath)) unlinkSync(socketPath); } catch (err) { log(`socket unlink failed: ${String(err)}`); }
    try { if (existsSync(pidPath)) unlinkSync(pidPath); } catch (err) { log(`pid unlink failed: ${String(err)}`); }
    selfRestart.recordExit(reason, exitCode);

    void endHeadlessLog().then(() => process.exit(exitCode));
  }

  process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
  process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });
  hostUpdate.attachStop({
    supervised: true,
    stop: (reason, farewell) => { log(farewell); void gracefulShutdown(reason, RESTART_EXIT_CODE); },
  });

  // `lifecycle:idle` fires on every work→quiescent transition so the parent
  // can implement fleet--await (block until child finished its task).
  // --exit-when-idle is a strict overlay: same detection, additionally
  // shuts down at the first quiet poll with no self-restart armed. While one
  // is armed, quiet also means nothing in flight, and it exits 75 instead.
  //
  // `inference:speech` fires once per "final" inference round — the round
  // that completed without yielding tool calls.  It carries the accumulated
  // speech text, letting the parent implement fleet--relay without having
  // to subscribe to the whole token stream.
  {
    const IDLE_CONFIRM_MS = 500;
    const nothingInFlight = (): boolean => {
      const host = app.framework.getHostModeStatus();
      if (!host.drained || host.gatedRequests > 0 || host.backgroundScripts > 0) return false;
      if (app.framework.getQueueDepth() > 0) return false;
      const subagents = (app.framework.getAllModules().find((m) => m.name === 'subagent') as
        | { getConcurrencyStatus(): { active: number; queued: number } }
        | undefined)?.getConcurrencyStatus();
      return !subagents || (subagents.active === 0 && subagents.queued === 0);
    };
    const primaryAgentName = app.recipe.agent.name ?? 'agent';
    let hadAtLeastOneInference = false;
    let idleSince = 0;
    let windowArmed = false;
    let idleEmitted = false;

    let currentSpeech = '';

    app.framework.onTrace((event) => {
      const t = (event as { type?: string }).type;
      const agentName = (event as { agentName?: string }).agentName;

      if (t === 'inference:started') {
        hadAtLeastOneInference = true;
        idleEmitted = false;
        if (agentName === primaryAgentName) currentSpeech = '';
      } else if (t === 'inference:tokens' && agentName === primaryAgentName) {
        const content = (event as { content?: string }).content;
        if (content) currentSpeech += content;
      } else if (t === 'inference:tool_calls_yielded' && agentName === primaryAgentName) {
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
      const armed = selfRestart.isArmed();
      if (armed) hadAtLeastOneInference = true;
      if (armed !== windowArmed) { windowArmed = armed; idleSince = 0; }
      if (!hadAtLeastOneInference || !allIdle || (armed && !nothingInFlight())) {
        idleSince = 0;
        return;
      }
      if (idleSince === 0) { idleSince = Date.now(); return; }
      if (Date.now() - idleSince < IDLE_CONFIRM_MS) return;
      if (!idleEmitted) {
        idleEmitted = true;
        log('quiescent — emitting lifecycle:idle');
        emit({ type: 'lifecycle', phase: 'idle' });
      }
      if (armed) {
        clearInterval(idlePoll);
        void gracefulShutdown('self-restart', SELF_RESTART_EXIT_CODE);
        return;
      }
      if (opts.exitWhenIdle) {
        clearInterval(idlePoll);
        void gracefulShutdown('exit-when-idle');
      }
    }, 100);
  }

  await new Promise<void>(() => { });
}
