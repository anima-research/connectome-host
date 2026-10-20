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
import { type IncomingCommand, matchesSubscription } from './modules/fleet-types.js';
import { AgentTreeReducer } from './state/agent-tree-reducer.js';
import { takeRecipeWarnings } from './recipe.js';
import { workspaceReadFields } from './workspace-read-result.js';

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
// The log's last lines
// ---------------------------------------------------------------------------

/** How long an exit waits for headless.log to take what was written to it. */
const LOG_FLUSH_LIMIT_MS = 2_000;

/** The log stream stdout and stderr writes go to, once runHeadless has
 *  opened it. It stays set after the log ends, so a later endHeadlessLog
 *  ends the same stream: it resolves at that stream's finish, or at once if
 *  the stream has already finished. */
let activeLog: WriteStream | null = null;

/**
 * End headless.log's stream, resolving once what was written to it is in
 * the file, or after LOG_FLUSH_LIMIT_MS if it never finishes, which the
 * host then says on its own stderr. process.exit drops a stream's pending
 * writes, so the exits made while the log is open wait for this first:
 * runHeadless's graceful shutdown, and main()'s handler for a fatal error.
 * (Other exits, such as an uncaught exception, don't.) Without an open log
 * it resolves at once.
 */
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

  // -- Redirect stdout/stderr writes BEFORE anything else here may log --
  // The IPC socket is the only structured output channel; direct
  // process.stdout/stderr.write calls become a debug log on disk.  Bun's
  // console.* bypasses these methods and writes to descriptors 1 and 2,
  // which for a fleet child are its startup.log, so console lines from
  // framework code land there, not here.
  //
  // Match the real process.stdout.write overload signature so libraries
  // passing (chunk, cb) or (chunk, encoding, cb) for backpressure /
  // flush confirmation don't have their callbacks silently swallowed.
  const logStream: WriteStream = createWriteStream(logPath, { flags: 'a' });
  activeLog = logStream;
  // Where this run's lines begin, as the TUI marks its error log: /bug reads
  // only the current session's (bug-report.ts).
  logStream.write(`\n${sessionMarker(new Date())}\n`);
  type StdWrite = typeof process.stdout.write;
  // From here, the host's own log lines and every write through
  // process.stdout.write or process.stderr.write come through here, as one
  // debug log. Once endHeadlessLog has ended the stream, such a line goes to
  // the process's own stderr instead, whichever stream it was written to:
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
  // The recipe was validated before this redirect: its warnings go into this log too.
  for (const warning of takeRecipeWarnings()) log(`warning: ${warning}`);

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

  // Initialize shutdown state before listen can expose ready to a client.
  let shuttingDown = false;

  // -- Connection state --
  let currentClient: Socket | null = null;
  // Default subscription: receive everything.  Smoke-test friendly; parents
  // are expected to send their own {type:"subscribe",events:[...]} on connect.
  let subscription = new Set<string>(['*']);

  // Events that bypass subscription filtering: protocol responses, not telemetry.
  // Clients narrow their event stream for bandwidth, not protocol correctness —
  // request/response pairs would be useless if the response got dropped.
  const FILTER_EXEMPT = new Set<string>([
    'snapshot',
    'lessons-snapshot',
    'workspace-mounts-snapshot',
    'workspace-tree-snapshot',
    'workspace-file-snapshot',
    'cancel-subagent-result',
    'panel-response',
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

  // -- Long-lived agent-tree reducer --
  // Subscribed to framework traces from process startup; accumulates state for
  // the lifetime of the child. Drives the 'describe' response. Same reducer
  // shape runs in the parent for fleet children — see docs/history/UNIFIED-TREE-PLAN.md §2.
  const treeReducer = new AgentTreeReducer();
  try {
    treeReducer.seedFrameworkAgents(app.framework.getAllAgents().map(a => a.name));
  } catch (err) {
    log(`seed framework agents failed: ${String(err)}`);
  }
  const startedAt = Date.now();

  // -- Wire framework trace events to socket and reducer --
  app.framework.onTrace((traceEvent) => {
    treeReducer.applyEvent(traceEvent);
    emit(traceEvent as unknown as Record<string, unknown>);
  });

  // -- Command dispatch --
  /** Commands each superseded client sent after its takeover, all dropped. */
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
    // Responses belong to the connection that requested them. Async work can
    // outlive that connection; a replacement client must not inherit its reply.
    // Framework telemetry still uses emit() directly and follows currentClient.
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
        // Commands with async follow-up (fleet kill/restart, puppet) put
        // their real outcome in asyncWork; without this await the IPC
        // caller only ever saw the "...starting" line and the result was
        // silently dropped.
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
        // Recovery verb: parent requests a full state snapshot at sync points
        // (cold start, reconnect, after restart). See docs/history/UNIFIED-TREE-PLAN.md §1.
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
        // Operator-panel query/mutation, shared verb. The SAME handler the
        // WebUI host runs locally answers here, so parent and child views of
        // any panel op can never drift. runPanelOp never throws — failures
        // come back as {ok:false} and still produce a panel-response, which
        // the parent's promise API requires to settle.
        const op = typeof cmd.op === 'string' ? cmd.op : '';
        const { runPanelOp } = await import('./web/panel-data.js');
        const result = await runPanelOp(app, op, cmd.params ?? {});
        reply({ type: 'panel-response', corrId: cmd.corrId, op, ...result });
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
        // Fire-and-forget; errors logged inside dispatchCommand.
        dispatchCommand(parsed, socket).catch((err: unknown) => {
          log(`dispatchCommand threw: ${String(err)}`);
        });
      }
    });

    // A client is gone at its 'end' (a clean end) or its 'close', whichever
    // comes first. 'close' follows an end and an error alike, and is the only
    // sign of a reset where a reset socket gets no 'end', as in Node (Bun
    // 1.4.2; Bun 1.3.14 gives it an 'end'): a parent that died with events
    // still unread. Without it, every emit would go to the dead socket until
    // the next client connected.
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
  async function gracefulShutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutdown: ${reason}`);
    emit({ type: 'lifecycle', phase: 'exiting', reason });

    // Give the exiting event a tick to flush onto the socket.
    await new Promise((r) => setTimeout(r, 50));

    let exitCode = 0;
    try { await app.framework.stop(); } catch (err) {
      exitCode = 1;
      log(`framework.stop() failed: ${String(err)}`);
    }
    try { server.close(); } catch (err) { log(`server.close() failed: ${String(err)}`); }
    try { if (existsSync(socketPath)) unlinkSync(socketPath); } catch (err) { log(`socket unlink failed: ${String(err)}`); }
    try { if (existsSync(pidPath)) unlinkSync(pidPath); } catch (err) { log(`pid unlink failed: ${String(err)}`); }

    // Exit once the log holds its last lines, a failed stop's included.
    void endHeadlessLog().then(() => process.exit(exitCode));
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
