/**
 * Commands:
 *   /undo          — Revert to state before last agent turn
 *   /redo          — Re-apply last undone action
 *   /nudge [agent] — Run inference on current context (no new events)
 *   /checkpoint N  — Save current state as named checkpoint
 *   /restore N     — Branch from checkpoint, switch to it
 *   /branches      — List all Chronicle branches
 *   /checkout N    — Switch to named branch
 *   /history [n]   — Show the last n messages (20 by default)
 *   /lessons       — Show current lesson library
 *   /status        — Show agent/module status
 *   /clear         — Clear conversation display
 *   /mcp list|add|remove|env — Manage MCPL server config
 *   /tools [agent] — Each tool's effective class (MCPL RFC-008) and its source
 *   /budget [N]    — Show/set stream token budget (e.g. /budget 1m)
 *   /fast [on|off|status] — Toggle Codex subscription Fast mode
 *   /session       — Session management (list, new, switch, rename, delete)
 *   /recipe        — Show current recipe info
 *   /newtopic      — Reset head window (auto-summarize or with user context)
 *   /export        — Export lessons to ./output/ (JSON + markdown)
 *   /usage         — Show session token usage and costs
 *   /bug <text>    — Assemble a bug report to file on GitHub (nothing is sent)
 *   /update        — Update, Restart and Go back
 *   /help          — List commands
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AgentFramework } from '@animalabs/agent-framework';
import type { ContextManager } from '@animalabs/context-manager';
import type { Recipe } from './recipe.js';
import type { CredentialActionId, CredentialState } from './credential-state.js';
import { readMcplServersFile, saveMcplServers, DEFAULT_CONFIG_PATH, DEFAULT_AGENT_OVERLAY_PATH } from './mcpl-config.js';
import { buildBugReport, composedServerConfigs, gatherBugReportFacts, runtimeMode, type LiveSetup } from './bug-report.js';
import { parseCommand } from './command-name.js';
import { OperatorActionError, storedInjectionMarkOf } from '@animalabs/agent-framework';
import type { Line } from './output-line.js';
import { fmtTokens } from './tui.js';
import { modelThinking } from './logging-adapter.js';
import { formatToolClassRows, readToolClasses } from './tool-lifecycle-config.js';
import { type FleetModule, formatChildRow } from './modules/fleet-module.js';
import { EXACT_VERSION } from './update/install.js';
import { HOST_STOPPING, SWITCH_UNDER_WAY, refusedWhileSwitching, sessionChangesRunning, trackOperatorWork } from './session-switch.js';
import { hostUpdate, type UpdateAnswer } from './update/update.js';
import { goBackLines, goBackUnread, statusLines } from './web/update-text.js';

interface AppContext {
  framework: AgentFramework;
  agentName?: string;
  sessionManager: import('./session-manager.js').SessionManager;
  recipe: Recipe;
  branchState: BranchState;
  codexAdapter?: {
    isFastMode(): boolean;
    setFastMode(enabled: boolean): void;
  };
  credentials?: {
    snapshot(): CredentialState;
    runAction(id: CredentialActionId, params?: { token?: string }): Promise<CredentialState>;
  } | null;
  stopping?: boolean;
  switching?: boolean;
  switchSession(id: string): Promise<unknown>;
}

export type { Line };

export interface StatePoint {
  branchName: string;
  messageId?: string;
}

export interface BranchState {
  undoStack: StatePoint[];
  redoStack: StatePoint[];
  checkpoints: Map<string, StatePoint>;
}

export function createBranchState(): BranchState {
  return {
    undoStack: [],
    redoStack: [],
    checkpoints: new Map(),
  };
}

export function resetBranchState(bs: BranchState): void {
  bs.undoStack.length = 0;
  bs.redoStack.length = 0;
  bs.checkpoints.clear();
}

export interface CommandResult {
  lines: Line[];
  quit?: boolean;
  switchToSessionId?: string;
  branchChanged?: boolean;
  asyncWork?: Promise<CommandResult>;
  refused?: boolean;
  switchToFleetPeek?: string;
  switchToFleetView?: boolean;
}

function getAgentCM(framework: AgentFramework, agentName?: string): ContextManager | null {
  if (agentName) {
    const agent = framework.getAgent(agentName);
    if (agent) return agent.getContextManager() ?? null;
  }
  const all = framework.getAllAgents();
  return all[0]?.getContextManager() ?? null;
}

/**
 * agent-framework writes a turn's reply onto whatever branch is current when
 * it lands, and a branch switch moves the branch of every agent sharing the
 * store, so a branch move waits for every agent's turn to end and /newtopic
 * for the main agent's: stop the generation, then move the head.
 */
function inFlightGuard(app: AppContext, cmd: string, everyAgent = false): CommandResult | null {
  const framework = app.framework;
  const main = (app.agentName ? framework.getAgent(app.agentName) : undefined) ?? framework.getAllAgents()[0];
  const agents = everyAgent ? framework.getAllAgents() : [main];
  const statusOf = (agent: unknown) => (agent as { state?: { status?: string } } | undefined)?.state?.status;
  const nameOf = (agent: unknown) => (agent as { name?: string } | undefined)?.name ?? 'agent';
  const busy = agents.filter((agent) => {
    const status = statusOf(agent);
    return status !== undefined && status !== 'idle';
  });
  if (busy.length === 0) return null;
  const wayOn = !busy.includes(main)
    ? `Wait for ${busy.length === 1 ? 'the turn' : 'those turns'} to end, then retry.`
    : busy.length === 1
      ? 'Wait for the turn to end, or stop it, then retry.'
      : `Wait for those turns to end, then retry; ${nameOf(main)}'s can be stopped.`;
  return {
    lines: [
      { text: `/${cmd} refused: a turn is in flight (${busy.map((agent) => `${nameOf(agent)}: ${statusOf(agent)}`).join(', ')}).`, style: 'system' },
      { text: '  Moving the head mid-generation would attach the streaming reply to the wrong', style: 'system' },
      { text: `  branch/request. ${wayOn}`, style: 'system' },
    ],
  };
}

function moveStore(
  framework: AgentFramework,
  target: string,
  words: { done: string; failed: string },
  landed: () => void = () => {},
  created = false,
): Promise<CommandResult> {
  const from = framework.getStore().currentBranch().name;
  return Promise.resolve()
    .then(() => framework.switchBranch(target))
    .then(
      (): CommandResult => {
        landed();
        return { lines: [{ text: words.done, style: 'system' }], branchChanged: true };
      },
      (err: unknown): CommandResult => {
        const message = err instanceof Error ? err.message : String(err);
        const refused = err instanceof OperatorActionError;
        if (!refused && from !== target && framework.getStore().currentBranch().name === target) {
          landed();
          return {
            lines: [
              { text: `${words.done} Refreshing the _config mount from it failed: ${message}`, style: 'system' },
              { text: `  The gate's files may still be the previous branch's. /checkout ${target} runs the refresh again.`, style: 'system' },
            ],
            branchChanged: true,
          };
        }
        const lines: Line[] = [{ text: `${words.failed}: ${message}`, style: 'system' }];
        if (created) {
          try {
            framework.getStore().deleteBranch(target);
          } catch (removal) {
            lines.push({ text: `  The branch "${target}" made for it stays: removing it failed (${removal instanceof Error ? removal.message : String(removal)}).`, style: 'system' });
          }
        }
        lines.push({
          text: err instanceof OperatorActionError && err.code === 'agent-busy'
            ? '  This command moved nothing. Try again once what it names has finished.'
            : '  This command moved nothing.',
          style: 'system',
        });
        return { lines };
      },
    );
}

const CHANGES_THE_SESSION = new Set(['undo', 'redo', 'checkout', 'branchto', 'newtopic', 'nudge', 'puppet']);
const CHANGES_THE_SESSION_GIVEN_A_VALUE = new Set(['checkpoint', 'restore', 'budget']);
const SUBCOMMANDS_THAT_CHANGE_THE_SESSION = new Map([
  ['session', new Set(['rename', 'delete', 'rm'])],
  ['fleet', new Set(['stop', 'kill', 'restart'])],
]);

function sessionChangeNamed(cmd: string, args: string[]): string | null {
  if (CHANGES_THE_SESSION.has(cmd)) return `/${cmd}`;
  if (CHANGES_THE_SESSION_GIVEN_A_VALUE.has(cmd) && args.length > 0) return `/${cmd}`;
  if (SUBCOMMANDS_THAT_CHANGE_THE_SESSION.get(cmd)?.has(args[0] ?? '')) return `/${cmd} ${args[0]}`;
  return null;
}

function stillRunning(app: AppContext): CommandResult | null {
  const names = sessionChangesRunning(app);
  if (names.length === 0) return null;
  const one = names.length === 1;
  return {
    lines: [{
      text: `${names.join(', ')} ${one ? 'is' : 'are'} still running, so the switch isn't started; try again once ${one ? 'it has' : 'they have'} finished.`,
      style: 'system',
    }],
  };
}

export function handleCommand(command: string, app: AppContext): CommandResult {
  const cmd = parseCommand(command).name;
  const change = sessionChangeNamed(cmd, command.slice(1).trim().split(/\s+/).slice(1));
  const result = dispatchCommand(command, cmd, change, app);
  if (result.asyncWork) result.asyncWork = trackOperatorWork(app, change, result.asyncWork);
  return result;
}

function dispatchCommand(command: string, cmd: string, change: string | null, app: AppContext): CommandResult {
  const parts = command.slice(1).trim().split(/\s+/);
  const args = parts.slice(1);
  const refused = change ? refusedWhileSwitching(app, change) : null;
  if (refused) return { lines: [{ text: refused, style: 'system' }] };
  const framework = app.framework;

  switch (cmd) {
    case 'quit':
    case 'q': {
      const hasLessons = framework.getAllModules().some(m => m.name === 'lessons');
      if (!hasLessons) {
        return { lines: [{ text: 'Goodbye.', style: 'system' }], quit: true };
      }
      const exportResult = handleExport(app);
      return { lines: exportResult.lines, quit: true };
    }

    case 'help':
      return {
        lines: [
          { text: '--- Commands ---', style: 'system' },
          { text: '  /quit, /q              Exit the app', style: 'system' },
          { text: '  /status                Show agent status', style: 'system' },
          { text: '  /clear                 Clear this client\'s display (history/context are kept)', style: 'system' },
          { text: '  /lessons               Show lesson library', style: 'system' },
          { text: '  /export                Export lessons to ./output/ (JSON + markdown)', style: 'system' },
          { text: '  /undo                  Revert last agent turn', style: 'system' },
          { text: '  /redo                  Re-apply undone action', style: 'system' },
          { text: '  /nudge [agent]         Run inference on current context (no new events)', style: 'system' },
          { text: '  /puppet <tool> [json]  Admin: execute a tool AS the agent, store the pair', style: 'system' },
          { text: '  /checkpoint [name]     Save current state (no name: list checkpoints)', style: 'system' },
          { text: '  /restore [name]        Restore to checkpoint (no name: list checkpoints)', style: 'system' },
          { text: '  /branches              List Chronicle branches and checkpoints', style: 'system' },
          { text: '  /checkout <name>       Switch to branch', style: 'system' },
          { text: '  /history [n]           Show the last n messages (20 by default)', style: 'system' },
          { text: '  /find <text>           Search messages for text', style: 'system' },
          { text: '  /branchto <msgId>      Branch from a specific message', style: 'system' },
          { text: '  /mcp list              List MCPL servers', style: 'system' },
          { text: '  /mcp add <id> <cmd>    Add/overwrite server', style: 'system' },
          { text: '  /mcp remove <id>       Remove a server', style: 'system' },
          { text: '  /mcp env <id> K=V ...  Set env vars on server', style: 'system' },
          { text: '  /tools [agent]         Each tool\'s effective class and where it came from', style: 'system' },
          { text: '  /budget [tokens]       Show/set stream token budget', style: 'system' },
          { text: '  /fast [on|off|status]  Toggle Codex subscription Fast mode', style: 'system' },
          { text: '  /auth [status|refresh|login|recheck|token <tok>]  Subscription credential state + actions', style: 'system' },
          { text: '  /session               Show current session', style: 'system' },
          { text: '  /session list          List all sessions', style: 'system' },
          { text: '  /session new [name]    Create new session', style: 'system' },
          { text: '  /session switch <name or id> Switch to session', style: 'system' },
          { text: '  /session rename <name> Rename current session', style: 'system' },
          { text: '  /session delete <name or id> --confirm  Delete a session (irreversible)', style: 'system' },
          { text: '  /recipe                Show current recipe info', style: 'system' },
          { text: '  /newtopic [context]    Reset head window (auto-summarize if empty)', style: 'system' },
          { text: '  /usage                 Show session token usage and costs', style: 'system' },
          { text: '  /bug <text>            Assemble a bug report to file on GitHub: shown first, nothing sent', style: 'system' },
          { text: '  /fleet                 Show / peek / stop / restart cross-process children', style: 'system' },
          { text: '                         (subcommands: list | status [name] | view | peek <name> | stop <name> | restart <name>)', style: 'system' },
          { text: '  /update                Whether a newer release is out, and this install\'s update state', style: 'system' },
          { text: '                         (subcommands: check | install | restart [wait | now | resume | <version>] | back [(keep | restore) [<version>]])', style: 'system' },
        ],
      };

    case 'clear':
      return { lines: [{ text: '(display cleared on clients; history and context are kept)', style: 'system' }] };

    case 'status':
      return handleStatus(framework);

    case 'lessons':
      return handleLessons(framework);

    case 'export':
      return handleExport(app);

    case 'undo':
      return inFlightGuard(app, cmd, true) ?? handleUndo(app);

    case 'nudge':
      return handleNudge(app, args[0]);

    case 'puppet':
      return handlePuppet(app, args);

    case 'redo':
      return inFlightGuard(app, cmd, true) ?? handleRedo(app);

    // Name-taking commands take the rest of the line, so a name may contain
    // spaces (/checkpoint my test point).
    case 'checkpoint':
      return handleCheckpoint(app, args.join(' ') || undefined);

    case 'restore':
      return inFlightGuard(app, cmd, true) ?? handleRestore(app, args.join(' ') || undefined);

    case 'branches':
      return handleBranches(app);

    case 'checkout':
      return inFlightGuard(app, cmd, true) ?? handleCheckout(framework, args.join(' ') || undefined);

    case 'history':
      return handleHistory(framework, args[0]);

    case 'branchto':
      return inFlightGuard(app, cmd, true) ?? handleBranchTo(app, args[0]);

    case 'find':
      return handleFind(framework, args.join(' '));

    case 'mcp':
      return handleMcp(args);

    case 'tools':
      return handleTools(framework, args.join(' ') || undefined);

    case 'budget':
      return handleBudget(framework, args[0]);

    case 'fast':
      return handleFast(app, args[0]);

    case 'auth':
      return handleAuth(app, args);

    case 'session':
      return handleSession(app, args);

    case 'recipe':
      return handleRecipe(app);

    case 'newtopic':
      return inFlightGuard(app, cmd) ?? handleNewTopic(app, args);

    case 'bug':
      return handleBug(command, app);

    case 'usage':
      return handleUsage(app);

    case 'fleet':
      return handleFleet(app, args);

    case 'update':
      return handleUpdate(args);

    default:
      return {
        lines: [{ text: `Unknown command: /${cmd}. Type /help.`, style: 'system' }],
      };
  }
}

/** /update: the state, and Update, Restart and Go back. Each answer's
 *  lines come back as the command's follow-up. Restart and Go back's two
 *  ways take the release they're for, as the Web UI sends them, so the
 *  host refuses rather than act on another one. */
function handleUpdate(args: string[]): CommandResult {
  const say = (lines: string[]): CommandResult => ({ lines: lines.map((text) => ({ text, style: 'system' as const })) });
  const after = (first: string, work: Promise<UpdateAnswer>): CommandResult =>
    ({ ...say([first]), asyncWork: work.then((answer) => ({ ...say(answer.lines), ...(answer.done ? {} : { refused: true }) })) });
  const [sub, choice, release, extra] = args;
  const usage = { ...say(['Usage: /update [check | install | restart [wait | now | resume | <version>] | back [(keep | restore) [<version>]]]']), refused: true };
  if (extra !== undefined) return usage;
  const version = (word: string | undefined): word is string => word !== undefined && EXACT_VERSION.test(word);
  if (sub === undefined || (sub === 'check' && choice === undefined)) {
    return after('Reading the registry…',
      hostUpdate.readRegistry().then(() => {
        const status = hostUpdate.status();
        return { done: status.check?.ok !== false, lines: statusLines(status) };
      }));
  }
  if (sub === 'install' && choice === undefined) return after('Reading the registry, then installing…', hostUpdate.install());
  if (sub === 'restart' && release === undefined) {
    const quiescing = 'Restarting unless refused: turns in progress get up to 2 min to end…';
    if (choice === undefined) return after(quiescing, hostUpdate.restartToInstalled());
    if (choice === 'wait') return after('Waiting up to 10 min more for turns to end…', hostUpdate.waitLonger());
    if (choice === 'now') return after('Stopping now…', hostUpdate.stopNow());
    if (choice === 'resume') return after('Calling the restart off…', hostUpdate.resume());
    if (version(choice)) return after(quiescing, hostUpdate.restartToInstalled(choice));
  }
  if (sub === 'back') {
    if (choice === undefined) {
      const status = hostUpdate.status();
      return { ...say(goBackLines(status)), ...(status.install && goBackUnread(status) === undefined ? {} : { refused: true }) };
    }
    if ((choice === 'keep' || choice === 'restore') && (release === undefined || version(release))) {
      return after('Going back unless refused: turns in progress get up to 2 min to end…', hostUpdate.goBack(choice === 'keep', release));
    }
  }
  return usage;
}

function credentialLines(state: CredentialState): Line[] {
  const lines: Line[] = [
    { text: `Credential (${state.provider}): ${state.kind}${state.kind === 'ok' ? '' : ` — ${state.message}`}`, style: 'system' },
  ];
  if (state.expiresAt !== undefined) {
    lines.push({ text: `  expires ${new Date(state.expiresAt).toISOString()}${state.rotatable ? ' (host can refresh)' : ' (no refresh token — paste a new one when it expires)'}`, style: 'system' });
  } else {
    lines.push({ text: `  expiry unknown; ${state.rotatable ? 'host can refresh' : 'not host-rotatable'}`, style: 'system' });
  }
  if (state.unsaved !== undefined) {
    lines.push({ text: `  WARNING: ${state.unsaved}. /auth recheck writes it again.`, style: 'system' });
  }
  if (state.until !== undefined && state.kind === 'quota-spent') {
    lines.push({ text: `  resets ${new Date(state.until).toISOString()}`, style: 'system' });
  }
  if (state.login) {
    lines.push({ text: `  login: open ${state.login.verificationUrl} and enter code ${state.login.userCode}`, style: 'system' });
  }
  if (state.actions.length > 0) {
    lines.push({ text: `  actions: ${state.actions.map((a) => `/auth ${a.id === 'set-token' ? 'token <tok>' : a.id}`).join(', ')}`, style: 'system' });
  }
  if (state.lastAction) {
    lines.push({ text: `  last action: ${state.lastAction.id} ${state.lastAction.ok ? 'ok' : 'FAILED'} — ${state.lastAction.message}`, style: 'system' });
  }
  return lines;
}

function handleAuth(app: AppContext, args: string[]): CommandResult {
  const monitor = app.credentials;
  if (!monitor) {
    return {
      lines: [{
        text: '/auth is available only on a subscription credential (ANTHROPIC_AUTH_TOKEN, ANTHROPIC_OAUTH_CREDENTIALS_FILE or provider "openai-codex").',
        style: 'system',
      }],
    };
  }
  const sub = (args[0] ?? 'status').toLowerCase();
  if (sub === 'status') return { lines: credentialLines(monitor.snapshot()) };
  const usage: CommandResult = { lines: [{ text: 'Usage: /auth [status|refresh|login|recheck|token <tok>]', style: 'system' }] };
  let id: CredentialActionId;
  let params: { token?: string } = {};
  switch (sub) {
    case 'refresh':
    case 'login':
    case 'recheck':
      id = sub;
      break;
    case 'token': {
      const token = args.slice(1).join(' ').trim();
      if (!token) return usage;
      id = 'set-token';
      params = { token };
      break;
    }
    default:
      return usage;
  }
  return {
    lines: [{ text: `/auth ${id}: running…`, style: 'system' }],
    asyncWork: monitor.runAction(id, params).then((state) => ({
      lines: [
        { text: `/auth ${id}: ${state.lastAction?.ok ? 'done' : 'FAILED'} — ${state.lastAction?.message ?? 'no outcome recorded'}`, style: 'system' },
        ...credentialLines(state),
      ],
    })),
  };
}

function handleFast(app: AppContext, mode?: string): CommandResult {
  const adapter = app.codexAdapter;
  if (!adapter) {
    return {
      lines: [{
        text: '/fast is available only when agent.provider is "openai-codex".',
        style: 'system',
      }],
    };
  }

  const normalized = mode?.toLowerCase();
  if (normalized === undefined || normalized === 'status') {
    return {
      lines: [{
        text: `Codex Fast mode request is ${adapter.isFastMode() ? 'ON' : 'OFF'}.`,
        style: 'system',
      }],
    };
  }
  if (normalized !== 'on' && normalized !== 'off') {
    return { lines: [{ text: 'Usage: /fast [on|off|status]', style: 'system' }] };
  }

  const enabled = normalized === 'on';
  adapter.setFastMode(enabled);
  return {
    lines: [{
      text: enabled
        ? 'Codex Fast mode requested (higher subscription credit consumption when applied).'
        : 'Codex Fast mode request disabled.',
      style: 'system',
    }],
  };
}

function handleSession(app: AppContext, args: string[]): CommandResult {
  const sub = args[0];
  switch (sub) {
    case undefined:
      return handleSessionInfo(app);
    case 'list':
    case 'ls':
      return handleSessionList(app);
    case 'new':
    case 'create':
      return handleSessionNew(app, args.slice(1).join(' ') || undefined);
    case 'switch':
    case 'sw':
      return handleSessionSwitch(app, args.slice(1).join(' ') || undefined);
    case 'rename':
      return handleSessionRename(app, args.slice(1).join(' ') || undefined);
    case 'delete':
    case 'rm':
      return handleSessionDelete(app, args.slice(1));
    default:
      return { lines: [{ text: `Unknown /session subcommand: ${sub}. Try /session list.`, style: 'system' }] };
  }
}

function handleSessionInfo(app: AppContext): CommandResult {
  const session = app.sessionManager.getActiveSession();
  if (!session) {
    return { lines: [{ text: 'No active session.', style: 'system' }] };
  }

  const lines: Line[] = [
    { text: '--- Current Session ---', style: 'system' },
    { text: `  Name: ${session.name}${session.manuallyNamed ? '' : ' (auto)'}`, style: 'system' },
    { text: `  ID: ${session.id}`, style: 'system' },
    { text: `  Created: ${session.createdAt}`, style: 'system' },
    { text: `  Last accessed: ${session.lastAccessedAt}`, style: 'system' },
  ];

  if (session.messageCount !== undefined) {
    lines.push({ text: `  Messages: ${session.messageCount}`, style: 'system' });
  }

  return { lines };
}

function handleSessionList(app: AppContext): CommandResult {
  const sessions = app.sessionManager.listSessions();
  const active = app.sessionManager.getActiveSession();

  if (sessions.length === 0) {
    return { lines: [{ text: 'No sessions.', style: 'system' }] };
  }

  const lines: Line[] = [{ text: `--- Sessions (${sessions.length}) ---`, style: 'system' }];
  for (const s of sessions) {
    const marker = s.id === active?.id ? ' *' : '';
    const msgs = s.messageCount !== undefined ? ` (${s.messageCount} msgs)` : '';
    const naming = s.manuallyNamed ? '' : ' (auto)';
    lines.push({
      text: `  ${s.name}${naming} [${s.id}]${msgs}${marker}`,
      style: 'system',
    });
  }

  return { lines };
}

const switchUnderWay: CommandResult = {
  lines: [{ text: `${SWITCH_UNDER_WAY[0]!.toUpperCase()}${SWITCH_UNDER_WAY.slice(1)}.`, style: 'system' }],
};
const hostStopping: CommandResult = {
  lines: [{ text: `${HOST_STOPPING[0]!.toUpperCase()}${HOST_STOPPING.slice(1)}.`, style: 'system' }],
};

function handleSessionNew(app: AppContext, name?: string): CommandResult {
  if (app.stopping) return hostStopping;
  if (app.switching) return switchUnderWay;
  const running = stillRunning(app);
  if (running) return running;
  const session = app.sessionManager.createSession(name);
  resetBranchState(app.branchState);

  return {
    lines: [{ text: `Switching to new session: ${session.name} [${session.id}]...`, style: 'system' }],
    switchToSessionId: session.id,
  };
}

function handleSessionSwitch(app: AppContext, nameOrId?: string): CommandResult {
  if (app.stopping) return hostStopping;
  if (app.switching) return switchUnderWay;
  if (!nameOrId) {
    return { lines: [{ text: 'Usage: /session switch <name or id>', style: 'system' }] };
  }

  const session = app.sessionManager.findSession(nameOrId);
  if (!session) {
    return { lines: [{ text: `Session "${nameOrId}" not found. Use /session list.`, style: 'system' }] };
  }

  const active = app.sessionManager.getActiveSession();
  if (active && session.id === active.id) {
    return { lines: [{ text: `Already on session "${session.name}".`, style: 'system' }] };
  }

  const running = stillRunning(app);
  if (running) return running;
  resetBranchState(app.branchState);

  return {
    lines: [{ text: `Switching to session: ${session.name} [${session.id}]...`, style: 'system' }],
    switchToSessionId: session.id,
  };
}

function handleSessionRename(app: AppContext, name?: string): CommandResult {
  if (!name) {
    return { lines: [{ text: 'Usage: /session rename <name>', style: 'system' }] };
  }

  const session = app.sessionManager.getActiveSession();
  if (!session) {
    return { lines: [{ text: 'No active session.', style: 'system' }] };
  }

  app.sessionManager.renameSession(session.id, name);
  return { lines: [{ text: `Session renamed to "${name}".`, style: 'system' }] };
}

function handleSessionDelete(app: AppContext, args: string[]): CommandResult {
  // Deletion is irreversible, so it takes an explicit second step: the bare
  // command shows exactly what matched (name + id + message count) and asks
  // for --confirm.
  const confirmed = args[args.length - 1] === '--confirm';
  const nameOrId = (confirmed ? args.slice(0, -1) : args).join(' ') || undefined;

  if (!nameOrId) {
    return { lines: [{ text: 'Usage: /session delete <name or id> [--confirm]', style: 'system' }] };
  }

  const session = app.sessionManager.findSession(nameOrId);
  if (!session) {
    return { lines: [{ text: `Session "${nameOrId}" not found.`, style: 'system' }] };
  }

  if (!confirmed) {
    const msgs = session.messageCount !== undefined ? `, ${session.messageCount} msgs` : '';
    return {
      lines: [
        { text: `Will delete session "${session.name}" [${session.id}]${msgs} — irreversible.`, style: 'system' },
        { text: `To proceed: /session delete ${session.id} --confirm`, style: 'system' },
      ],
    };
  }

  try {
    app.sessionManager.deleteSession(session.id);
    return { lines: [{ text: `Deleted session "${session.name}" [${session.id}].`, style: 'system' }] };
  } catch (err) {
    return { lines: [{ text: `Delete failed: ${err instanceof Error ? err.message : err}`, style: 'system' }] };
  }
}

function handleRecipe(app: AppContext): CommandResult {
  const r = app.recipe;
  const lines: Line[] = [
    { text: '--- Recipe ---', style: 'system' },
    { text: `  Name: ${r.name}`, style: 'system' },
  ];
  if (r.description) {
    lines.push({ text: `  Description: ${r.description}`, style: 'system' });
  }
  if (r.version) {
    lines.push({ text: `  Version: ${r.version}`, style: 'system' });
  }
  lines.push({ text: `  Agent: ${r.agent.name || 'agent'} (${r.agent.model || 'default'})`, style: 'system' });

  const mods = r.modules ?? {};
  const enabled = Object.entries(mods)
    .filter(([, v]) => v !== false)
    .map(([k]) => k);
  lines.push({ text: `  Modules: ${enabled.join(', ') || 'none'}`, style: 'system' });

  const mcpCount = r.mcpServers ? Object.keys(r.mcpServers).length : 0;
  lines.push({ text: `  MCP servers (recipe): ${mcpCount}`, style: 'system' });

  return { lines };
}

/**
 * `/bug <text>`: assemble a report for connectome-host's public issues, show
 * it, save it under DATA_DIR where it can, and give the link that opens
 * GitHub's new-issue form with it filled in, cut to fit the link where it's
 * long, saying what it leaves out. Nothing is sent: the reporter reads it in
 * the form and submits it themselves.
 */
function handleBug(command: string, app: AppContext): CommandResult {
  const text = parseCommand(command).rest.trim();
  if (text === '') {
    return {
      lines: [
        { text: 'Usage: /bug <what happened, in your own words>', style: 'system' },
        { text: '  Assembles a report for connectome-host\'s public issues: your words, the versions, the setup', style: 'system' },
        { text: '  as structure, and errors as kinds and code locations. It shows you the report and a link', style: 'system' },
        { text: '  that opens it on GitHub; nothing is sent until you submit it there.', style: 'system' },
      ],
    };
  }
  const dataDir = resolve(process.env.DATA_DIR || './data');
  const servers = composedServerConfigs(app.recipe.mcpServers, DEFAULT_CONFIG_PATH, DEFAULT_AGENT_OVERLAY_PATH);
  const framework = app.framework;
  const agent = (app.agentName ? framework.getAgent(app.agentName) : undefined) ?? framework.getAllAgents()[0];
  const facts = gatherBugReportFacts({
    mode: runtimeMode(),
    dataDir,
    recipe: app.recipe,
    liveServers: framework.listMcplServers(),
    serverConfig: servers.configFor,
    configNotes: servers.notes,
    live: {
      agent: agent as unknown as NonNullable<LiveSetup['agent']> | undefined,
      modules: framework.getAllModules().map((module) => module.name),
      wake: (app.recipe.modules as { wake?: unknown } | undefined)?.wake !== false,
    },
  });
  const { full, url, cut } = buildBugReport(text, facts);
  const path = join(dataDir, `bug-report-${facts.now.toISOString().replace(/[:.]/g, '-')}.txt`);
  let saved: string | null = null;
  let saveError = '';
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path, `${full.title}\n\nWhat happened:\n${full.what}\n\nReport:\n${full.report}\n\nFile it here:\n${url}\n`);
    saved = path;
  } catch (err) {
    saveError = err instanceof Error ? err.message : String(err);
  }
  const lines: Line[] = [
    { text: '--- Bug report: nothing has been sent ---', style: 'system' },
    { text: `Title: ${full.title}`, style: 'system' },
    { text: 'What happened (your words):', style: 'system' },
    ...full.what.split('\n').map((line) => ({ text: `  ${line}`, style: 'system' as const })),
    { text: '', style: 'system' },
    ...full.report.split('\n').map((line) => ({ text: line, style: 'system' as const })),
    { text: '', style: 'system' },
  ];
  if (cut.length > 0) {
    lines.push({
      text: saved
        ? `To fit the link, it leaves out ${cut.join(' and ')}. The saved file holds the full report.`
        : `To fit the link, it leaves out ${cut.join(' and ')}. The file couldn't be saved, so copy the full report above into the issue.`,
      style: 'system',
    });
  }
  lines.push({
    text: saved ? `Saved to ${saved}` : `Couldn't save it to a file (${saveError}).${cut.length > 0 ? '' : ' The link below holds the whole report.'}`,
    style: 'system',
  });
  lines.push({ text: 'To file it, open this link, read the report there, and submit it on GitHub:', style: 'system' });
  lines.push({ text: url, style: 'system' });
  return { lines };
}

function handleUsage(app: AppContext): CommandResult {
  const snapshot = app.framework.getSessionUsage();
  const lines: Line[] = [];
  const fmt = fmtTokens;

  const fmtCost = (cost?: { total: number; currency: string }) => {
    if (!cost) return '';
    return `  $${cost.total.toFixed(4)}`;
  };

  const { totals } = snapshot;
  lines.push({ text: '--- Session Usage ---', style: 'system' });
  lines.push({
    text: `  Total: ${fmt(totals.inputTokens)} in  ${fmt(totals.outputTokens)} out  ${fmt(totals.cacheReadTokens)} cache read  ${fmt(totals.cacheCreationTokens)} cache write${fmtCost(totals.estimatedCost)}`,
    style: 'system',
  });
  lines.push({ text: `  Inferences: ${snapshot.inferenceCount}`, style: 'system' });

  if (snapshot.byAgent.length > 0) {
    lines.push({ text: '', style: 'system' });
    lines.push({ text: '--- Per Agent ---', style: 'system' });
    for (const agent of snapshot.byAgent) {
      const u = agent.usage;
      lines.push({
        text: `  ${agent.agentName}  ${fmt(u.inputTokens)} in  ${fmt(u.outputTokens)} out  ${fmt(u.cacheReadTokens)} cache read  ${fmt(u.cacheCreationTokens)} cache write${fmtCost(u.estimatedCost)}  (${agent.inferenceCount} inf)`,
        style: 'system',
      });
    }
  }

  return { lines };
}

function handleStatus(framework: AgentFramework): CommandResult {
  const agents = framework.getAllAgents();
  const lines: Line[] = [{ text: '--- Status ---', style: 'system' }];

  for (const agent of agents) {
    lines.push({ text: `  ${agent.name}: ${agent.state.status} (${agent.model})`, style: 'system' });
  }

  const cm = getAgentCM(framework);
  if (cm) {
    const branch = cm.currentBranch();
    lines.push({ text: `  Branch: ${branch.name} (head: ${branch.head})`, style: 'system' });
  }

  lines.push({ text: `  Queue depth: ${framework.getQueueDepth()}`, style: 'system' });

  return { lines };
}

/** For an agent whose thinking binds and whose window is set, agent-framework
 *  doesn't break the stream at maxStreamTokens mid-turn, only before a request
 *  the window can't hold (anima-research/context-manager#155). */
function windowInsteadOfBudget(agent: { model: string; physicalWindowTokens?: number }): number | undefined {
  return agent.physicalWindowTokens !== undefined && modelThinking(agent.model).binds ? agent.physicalWindowTokens : undefined;
}

function handleBudget(framework: AgentFramework, arg?: string): CommandResult {
  const agents = framework.getAllAgents();
  if (agents.length === 0) {
    return { lines: [{ text: 'No agents.', style: 'system' }] };
  }

  if (!arg) {
    const lines: Line[] = [{ text: '--- Stream Token Budgets ---', style: 'system' }];
    for (const agent of agents) {
      const budget = agent.maxStreamTokens;
      const last = agent.lastStreamInputTokens;
      const pct = budget > 0 ? ((last / budget) * 100).toFixed(0) : '—';
      const window = windowInsteadOfBudget(agent);
      lines.push({
        text: `  ${agent.name}: ${fmtTokens(budget)} (last: ${fmtTokens(last)}, ${pct}%)` +
          (window !== undefined
            ? `; its stream doesn't break at this budget mid-turn: for its size, only before a request its ${fmtTokens(window)} window can't hold`
            : ''),
        style: 'system',
      });
    }
    return { lines };
  }

  let tokens: number;
  const lower = arg.toLowerCase();
  if (lower.endsWith('m')) {
    tokens = parseFloat(lower.slice(0, -1)) * 1_000_000;
  } else if (lower.endsWith('k')) {
    tokens = parseFloat(lower.slice(0, -1)) * 1_000;
  } else {
    tokens = parseInt(arg, 10);
  }

  if (isNaN(tokens) || tokens <= 0) {
    return { lines: [{ text: `Invalid token count: "${arg}". Examples: 150k, 1m, 200000`, style: 'system' }] };
  }

  for (const agent of agents) {
    agent.maxStreamTokens = tokens;
  }

  const windowed = agents.filter((agent) => windowInsteadOfBudget(agent) !== undefined).map((agent) => agent.name);
  return {
    lines: [
      { text: `Stream budget set to ${fmtTokens(tokens)} tokens for all agents.`, style: 'system' },
      ...(windowed.length > 0
        ? [{
          text: `It's kept, but doesn't break the stream mid-turn for ${windowed.join(', ')}, whose thinking binds and ` +
            "whose window is set: for their size, their streams break only before a request the window can't hold.",
          style: 'system' as const,
        }]
        : []),
    ],
  };
}

function handleLessons(framework: AgentFramework): CommandResult {
  const modules = framework.getAllModules();
  const lessonsModule = modules.find(m => m.name === 'lessons') as
    { getLessons(): Array<{ id: string; content: string; confidence: number; tags: string[]; deprecated: boolean }> } | undefined;

  if (!lessonsModule) {
    return { lines: [{ text: 'Lessons module not loaded.', style: 'system' }] };
  }

  const lessons = lessonsModule.getLessons();
  const active = lessons.filter(l => !l.deprecated);

  if (active.length === 0) {
    return { lines: [{ text: 'No lessons yet. The agent will create them during analysis.', style: 'system' }] };
  }

  const lines: Line[] = [{ text: `--- Lessons (${active.length}) ---`, style: 'system' }];
  for (const l of active.sort((a, b) => b.confidence - a.confidence)) {
    const conf = (l.confidence * 100).toFixed(0);
    lines.push({
      text: `  [${conf}%] ${l.id}: ${l.content.slice(0, 80)}${l.content.length > 80 ? '...' : ''} (${l.tags.join(', ')})`,
      style: 'system',
    });
  }

  return { lines };
}

/** Export lessons to ./output/ as JSON and markdown. Called by /export and on quit. */
export function handleExport(app: AppContext): CommandResult {
  const modules = app.framework.getAllModules();
  type Readable = { id: string; content: string; confidence: number; tags: string[]; evidence: string[]; created: number; updated: number; deprecated: boolean; deprecationReason?: string };
  const lessonsModule = modules.find(m => m.name === 'lessons') as
    { getLessonRecords(): Array<{ stored: unknown; lesson: Readable; needsFix?: string }> } | undefined;

  if (!lessonsModule) {
    return { lines: [{ text: 'Lessons module not loaded — nothing to export.', style: 'system' }] };
  }

  const records = lessonsModule.getLessonRecords();
  if (records.length === 0) {
    return { lines: [{ text: 'No lessons to export.', style: 'system' }] };
  }

  const storedLessons = records.map(r => r.stored);
  const active = records.filter(r => !r.lesson.deprecated);
  const outDir = resolve('./output');
  mkdirSync(outDir, { recursive: true });

  const exportData = {
    exportedAt: new Date().toISOString(),
    sessionName: app.sessionManager.getActiveSession()?.name ?? 'unknown',
    recipeName: app.recipe.name,
    lessonCount: storedLessons.length,
    activeCount: active.length,
    lessons: storedLessons,
  };
  const jsonPath = resolve(outDir, 'lessons-export.json');
  writeFileSync(jsonPath, JSON.stringify(exportData, null, 2));

  const tagMap = new Map<string, typeof active>();
  for (const r of active) {
    for (const tag of r.lesson.tags.length ? r.lesson.tags : ['untagged']) {
      if (!tagMap.has(tag)) tagMap.set(tag, []);
      tagMap.get(tag)!.push(r);
    }
  }

  let md = `# Lessons Export\n\n`;
  md += `**Exported:** ${new Date().toISOString()}  \n`;
  md += `**Recipe:** ${app.recipe.name}  \n`;
  md += `**Active lessons:** ${active.length} (${storedLessons.length - active.length} deprecated)  \n\n`;

  for (const [tag, tagLessons] of [...tagMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    md += `## ${tag}\n\n`;
    for (const { lesson: l, needsFix } of tagLessons.sort((a, b) => b.lesson.confidence - a.lesson.confidence)) {
      const conf = (l.confidence * 100).toFixed(0);
      md += `- **[${conf}%]** ${l.content}`;
      if (l.evidence.length) md += `  \n  _Sources: ${l.evidence.join(', ')}_`;
      if (needsFix) md += `  \n  _${needsFix}_`;
      md += '\n';
    }
    md += '\n';
  }

  const mdPath = resolve(outDir, 'lessons-export.md');
  writeFileSync(mdPath, md);

  return {
    lines: [
      { text: `Exported ${active.length} lessons (${storedLessons.length - active.length} deprecated) to:`, style: 'system' },
      { text: `  ${jsonPath}`, style: 'system' },
      { text: `  ${mdPath}`, style: 'system' },
    ],
  };
}

/**
 * /puppet <toolName> [json-input]: execute one tool as the main agent, for
 * real, and store the tool_use and tool_result pair in its window, as a call
 * the model made. Refused unless the agent is idle and the tool is on its
 * surface. Doesn't wake the agent.
 */
function handlePuppet(app: AppContext, args: string[]): CommandResult {
  const toolName = args[0];
  if (!toolName) {
    return {
      lines: [
        { text: 'Usage: /puppet <toolName> [json-input]', style: 'system' },
        { text: '  Executes the tool AS the agent (for real) and stores the', style: 'system' },
        { text: '  tool_use + tool_result pair in its window. Requires idle.', style: 'system' },
      ],
    };
  }
  const rawInput = args.slice(1).join(' ').trim();
  let input: Record<string, unknown> = {};
  if (rawInput) {
    try {
      const parsed = JSON.parse(rawInput);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { lines: [{ text: 'puppet: input must be a JSON object', style: 'system' }] };
      }
      input = parsed;
    } catch (e) {
      return { lines: [{ text: `puppet: bad JSON input: ${e instanceof Error ? e.message : e}`, style: 'system' }] };
    }
  }
  const agentName = app.agentName ?? app.framework.getAllAgents()[0]?.name;
  if (!agentName) {
    return { lines: [{ text: 'puppet: no registered agent', style: 'system' }] };
  }
  const asyncWork = (async (): Promise<CommandResult> => {
    try {
      const { toolUseId, result } = await app.framework.puppetToolCall(agentName, toolName, input);
      const preview = result.isError
        ? `ERROR: ${result.error ?? 'unknown'}`
        : String(typeof result.data === 'string' ? result.data : JSON.stringify(result.data) ?? '').slice(0, 300);
      return {
        lines: [
          { text: `puppet ${agentName}: ${toolName} → ${result.isError ? 'error' : 'ok'} (${toolUseId})`, style: 'system' },
          { text: `  stored tool_use + tool_result in ${agentName}'s window (no wake).`, style: 'system' },
          { text: `  result: ${preview.replace(/\n/g, ' ')}`, style: 'system' },
        ],
      };
    } catch (e) {
      return { lines: [{ text: `puppet failed: ${e instanceof Error ? e.message : e}`, style: 'system' }] };
    }
  })();
  return {
    lines: [{ text: `puppet: executing ${toolName} as ${agentName}...`, style: 'system' }],
    asyncWork,
  };
}

/**
 * /nudge [agent]: queue an inference turn on the agent's current context
 * without adding any message or event. After an /undo, the agent takes
 * another turn at exactly what it then sees.
 */
function handleNudge(app: AppContext, agentName?: string): CommandResult {
  const r = app.framework.nudgeAgent(agentName, 'host-console');
  if (!r.ok) {
    return { lines: [{ text: `Nudge failed: ${r.error}`, style: 'system' }] };
  }
  const when = r.agentStatus === 'idle'
    ? 'running now'
    : `queued — runs when current turn settles (agent is ${r.agentStatus})`;
  return {
    lines: [{
      text: `Nudged ${r.agentName}: inference on current context, no new events (${when}).`,
      style: 'system',
    }],
  };
}

function handleUndo(app: AppContext): CommandResult {
  const { framework, branchState: bs } = app;
  const cm = getAgentCM(framework);
  if (!cm) return { lines: [{ text: 'No agent context manager.', style: 'system' }] };

  const { messages } = cm.queryMessages({});
  if (messages.length === 0) {
    return { lines: [{ text: 'Nothing to undo.', style: 'system' }] };
  }

  let undoPoint: string | undefined;
  const injected = (i: number): boolean => storedInjectionMarkOf(messages[i]!.metadata) !== undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.participant !== 'user' && !injected(i)) {
      let before = i - 1;
      while (before >= 0 && injected(before)) before--;
      undoPoint = before >= 0 ? messages[before]!.id : undefined;
      break;
    }
  }

  if (!undoPoint) {
    return { lines: [{ text: 'Nothing to undo (no agent messages found).', style: 'system' }] };
  }

  // context-manager's branchAt returns, and switchBranch takes, a branch's
  // name, not its numeric id.
  const currentBranch = cm.currentBranch();
  const newBranchName = `undo-${Date.now()}`;

  let createdBranchName: string;
  try {
    createdBranchName = cm.branchAt(undoPoint, newBranchName);
  } catch (err) {
    return { lines: [{ text: `Undo failed (branchAt): ${err}`, style: 'system' }] };
  }

  const asyncWork = moveStore(
    framework,
    createdBranchName,
    { done: `Undone. Switched to branch "${createdBranchName}".`, failed: 'Undo failed (switchBranch)' },
    () => {
      bs.redoStack.push({ branchName: currentBranch.name });
      bs.undoStack.push({ branchName: createdBranchName, messageId: undoPoint });
    },
    true,
  );

  return {
    lines: [{ text: `Undoing → branch "${createdBranchName}"...`, style: 'system' }],
    asyncWork,
  };
}

function handleRedo(app: AppContext): CommandResult {
  const { framework, branchState: bs } = app;
  const cm = getAgentCM(framework);
  if (!cm) return { lines: [{ text: 'No agent context manager.', style: 'system' }] };

  if (bs.redoStack.length === 0) {
    return { lines: [{ text: 'Nothing to redo.', style: 'system' }] };
  }

  const point = bs.redoStack[bs.redoStack.length - 1]!;
  const target = point.branchName;

  const drop = () => {
    const at = bs.redoStack.lastIndexOf(point);
    if (at >= 0) bs.redoStack.splice(at, 1);
  };
  const asyncWork = moveStore(framework, target, { done: `Redone. Switched to branch "${target}".`, failed: 'Redo failed' }, drop)
    .then((result) => {
      if (result.branchChanged || framework.getStore().listBranches().some((b) => b.name === target)) return result;
      drop();
      const next = bs.redoStack[bs.redoStack.length - 1];
      const after = next ? `the next /redo tries "${next.branchName}"` : 'nothing is left to redo';
      return { ...result, lines: [...result.lines, { text: `  The branch this redo returns to, "${target}", no longer exists, so that step is dropped; ${after}.`, style: 'system' as const }] };
    });

  return {
    lines: [{ text: `Redoing → branch "${target}"...`, style: 'system' }],
    asyncWork,
  };
}

function handleCheckpoint(app: AppContext, name?: string): CommandResult {
  if (!name) {
    const names = [...app.branchState.checkpoints.keys()];
    return {
      lines: [
        { text: 'Usage: /checkpoint <name>', style: 'system' },
        ...(names.length > 0
          ? [{ text: `Saved checkpoints: ${names.join(', ')}`, style: 'system' as const }]
          : []),
      ],
    };
  }

  const cm = getAgentCM(app.framework);
  if (!cm) return { lines: [{ text: 'No agent context manager.', style: 'system' }] };

  const branch = cm.currentBranch();
  const { messages } = cm.queryMessages({});
  const messageId = messages.length > 0 ? messages[messages.length - 1]!.id : undefined;
  app.branchState.checkpoints.set(name, { branchName: branch.name, messageId });

  return { lines: [{ text: `Checkpoint "${name}" saved at branch ${branch.name} (head: ${branch.head}).`, style: 'system' }] };
}

function handleRestore(app: AppContext, name?: string): CommandResult {
  if (!name) {
    const names = [...app.branchState.checkpoints.keys()];
    if (names.length === 0) {
      return { lines: [{ text: 'No checkpoints saved. Use /checkpoint <name> to create one.', style: 'system' }] };
    }
    return {
      lines: [
        { text: 'Available checkpoints:', style: 'system' },
        ...names.map(n => ({ text: `  ${n}`, style: 'system' as const })),
      ],
    };
  }

  const point = app.branchState.checkpoints.get(name);
  if (!point) {
    return { lines: [{ text: `Checkpoint "${name}" not found.`, style: 'system' }] };
  }

  const cm = getAgentCM(app.framework);
  if (!cm) return { lines: [{ text: 'No agent context manager.', style: 'system' }] };

  let target = point.branchName;
  let exact = false;
  let landed = () => {};
  if (point.messageId) {
    const { messages } = cm.queryMessages({});
    const atCheckpoint = messages.length > 0
      && messages[messages.length - 1]!.id === point.messageId;
    if (atCheckpoint) {
      return { lines: [{ text: `Already at checkpoint "${name}".`, style: 'system' }] };
    }
    try {
      const created = cm.branchAt(point.messageId, `restore-${name}-${Date.now()}`);
      target = created;
      exact = true;
      landed = () => {
        if (app.branchState.checkpoints.get(name) === point) app.branchState.checkpoints.set(name, { branchName: created, messageId: point.messageId });
      };
    } catch {
      // context-manager's branchAt finds the message on the current branch and
      // throws when it isn't there, as after an /undo: the restore then goes to
      // the checkpoint's branch head.
      target = point.branchName;
    }
  }

  const asyncWork = moveStore(
    app.framework,
    target,
    { done: `Restored to checkpoint "${name}" (branch: ${target}).`, failed: 'Restore failed' },
    landed,
    exact,
  ).then((result) => (result.branchChanged && point.messageId && !exact
    ? { ...result, lines: [...result.lines, { text: '  (note: exact checkpoint position unreachable from the current branch — restored to the branch head instead)', style: 'system' as const }] }
    : result));

  return {
    lines: [{ text: `Restoring → branch "${target}"...`, style: 'system' }],
    asyncWork,
  };
}

function handleBranches(app: AppContext): CommandResult {
  const cm = getAgentCM(app.framework);
  if (!cm) return { lines: [{ text: 'No agent context manager.', style: 'system' }] };

  const branches = cm.listBranches();
  const current = cm.currentBranch();

  const lines: Line[] = [{ text: `--- Branches (${branches.length}) ---`, style: 'system' }];
  for (const b of branches) {
    const marker = b.id === current.id ? ' *' : '';
    lines.push({
      text: `  ${b.name} (head: ${b.head})${marker}`,
      style: 'system',
    });
  }

  const cps = [...app.branchState.checkpoints.entries()];
  if (cps.length > 0) {
    lines.push({ text: `--- Checkpoints (${cps.length}, this session) ---`, style: 'system' });
    for (const [name, point] of cps) {
      const at = point.messageId ? ` @ [${point.messageId}]` : '';
      lines.push({ text: `  ${name} → ${point.branchName}${at}`, style: 'system' });
    }
  }

  return { lines };
}

function handleCheckout(framework: AgentFramework, name?: string): CommandResult {
  if (!name) {
    return { lines: [{ text: 'Usage: /checkout <branch-name>', style: 'system' }] };
  }

  const cm = getAgentCM(framework);
  if (!cm) return { lines: [{ text: 'No agent context manager.', style: 'system' }] };

  const branches = cm.listBranches();
  const target = branches.find(b => b.name === name || b.id === name);
  if (!target) {
    return { lines: [{ text: `Branch "${name}" not found. Use /branches to list.`, style: 'system' }] };
  }

  const asyncWork = moveStore(framework, target.name, { done: `Switched to branch ${target.name}.`, failed: 'Checkout failed' });

  return {
    lines: [{ text: `Switching → branch ${target.name}...`, style: 'system' }],
    asyncWork,
  };
}

function handleFind(framework: AgentFramework, needle: string): CommandResult {
  const cm = getAgentCM(framework);
  if (!cm) return { lines: [{ text: 'No agent context manager.', style: 'system' }] };
  if (!needle) return { lines: [{ text: 'Usage: /find <text>', style: 'system' }] };
  const { messages } = cm.queryMessages({});
  const lines: Line[] = [{ text: `--- Find "${needle}" in ${messages.length} msgs ---`, style: 'system' }];
  const needleLc = needle.toLowerCase();
  for (const msg of messages) {
    const full = msg.content
      .map((b) => b.type === 'text' ? b.text : JSON.stringify(b))
      .join(' ');
    const at = full.toLowerCase().indexOf(needleLc);
    if (at >= 0) {
      const snip = full.slice(Math.max(0, at - 30), at + needle.length + 45).replace(/\s+/g, ' ');
      lines.push({ text: `  [${msg.id}] ${msg.participant}: ...${snip}...`, style: 'system' });
    }
  }
  if (lines.length === 1) lines.push({ text: '  (no matches)', style: 'system' });
  return { lines };
}

function handleBranchTo(app: AppContext, messageId: string | undefined): CommandResult {
  const cm = getAgentCM(app.framework);
  if (!cm) return { lines: [{ text: 'No agent context manager.', style: 'system' }] };
  if (!messageId) return { lines: [{ text: 'Usage: /branchto <messageId>', style: 'system' }] };
  const { messages } = cm.queryMessages({});
  const target = messages.find(m => String(m.id) === String(messageId));
  if (!target) return { lines: [{ text: `No message with id ${messageId} on current branch.`, style: 'system' }] };
  const newBranchName = `rollback-at-${messageId}-${Date.now()}`;
  let createdBranchName: string;
  try {
    createdBranchName = cm.branchAt(String(messageId), newBranchName);
  } catch (err) {
    return { lines: [{ text: `branchto failed (branchAt): ${err}`, style: 'system' }] };
  }
  const asyncWork = moveStore(
    app.framework,
    createdBranchName,
    {
      done: `Branched at [${messageId}] -> "${createdBranchName}" and switched. Everything after [${messageId}] is dropped on this branch; old branch preserved.`,
      failed: 'branchto failed (switchBranch)',
    },
    undefined,
    true,
  );
  return { lines: [{ text: `Branching at [${messageId}] -> "${createdBranchName}"...`, style: 'system' }], asyncWork };
}

function handleHistory(framework: AgentFramework, countArg?: string): CommandResult {
  const cm = getAgentCM(framework);
  if (!cm) return { lines: [{ text: 'No agent context manager.', style: 'system' }] };

  const { messages } = cm.queryMessages({});
  const lines: Line[] = [{ text: `--- History (${messages.length} messages) ---`, style: 'system' }];

  const recent = messages.slice(-(countArg && Number(countArg) > 0 ? Number(countArg) : 20));
  for (const msg of recent) {
    const text = msg.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join(' ')
      .slice(0, 60);
    const suffix = text.length >= 60 ? '...' : '';
    lines.push({
      text: `  [${msg.id}] ${msg.participant}: ${text}${suffix}`,
      style: 'system',
    });
  }

  return { lines };
}

function handleNewTopic(app: AppContext, args: string[]): CommandResult {
  const cm = getAgentCM(app.framework);
  if (!cm) return { lines: [{ text: 'No context manager.', style: 'system' }] };

  const userContext = args.join(' ').trim() || undefined;

  const asyncWork = cm.resetHeadWindow(userContext).then(summary => ({
    lines: [
      { text: 'Topic reset. Transition summary:', style: 'system' as const },
      { text: summary.slice(0, 300) + (summary.length > 300 ? '...' : ''), style: 'system' as const },
    ],
  })).catch(err => {
    const said = err instanceof Error ? err.message : String(err);
    return {
      lines: [{
        text: app.stopping ? `Topic reset stopped: the host is stopping. What the reset said: ${said}` : `Topic reset failed: ${said}`,
        style: 'system' as const,
      }],
    };
  });

  return {
    lines: [{ text: userContext
      ? 'Resetting topic with provided context...'
      : 'Generating transition summary...', style: 'system' }],
    asyncWork,
  };
}

/**
 * Every tool with its effective class and the source that decided it.
 * Without an agent: every tool the framework offers to anyone; with one:
 * exactly that agent's surface.
 */
function handleTools(framework: AgentFramework, agentName?: string): CommandResult {
  let rows: ReturnType<typeof readToolClasses>;
  try {
    rows = readToolClasses(framework, agentName);
  } catch (err) {
    return { lines: [{ text: err instanceof Error ? err.message : String(err), style: 'system' }] };
  }
  if (rows === null) {
    return { lines: [{ text: 'This agent-framework build does not report tool classes.', style: 'system' }] };
  }
  const scope = agentName === undefined ? 'all agents' : agentName;
  if (rows.length === 0) {
    return { lines: [{ text: `No tools offered (${scope}).`, style: 'system' }] };
  }
  const [summary, ...table] = formatToolClassRows(rows);
  const lines: Line[] = [
    { text: `--- Tool classes: ${rows.length} tool${rows.length === 1 ? '' : 's'} (${scope}) ---`, style: 'system' },
    { text: `  ${summary}`, style: 'system' },
    ...table.map((text): Line => ({ text: `  ${text}`, style: 'system' })),
  ];
  if (rows.some((r) => r.source === 'none')) {
    lines.push({
      text: '  Unclassed tools get the most restrictive handling (observers never see their arguments); ' +
        'class them with the recipe\'s toolClassOverrides.',
      style: 'system',
    });
  }
  return { lines };
}

function handleMcp(args: string[]): CommandResult {
  const sub = args[0];
  switch (sub) {
    case 'list':
    case undefined:
      return handleMcpList();
    case 'add':
      return handleMcpAdd(args.slice(1));
    case 'remove':
      return handleMcpRemove(args[1]);
    case 'env':
      return handleMcpEnv(args[1], args.slice(2));
    default:
      return { lines: [{ text: `Unknown /mcp subcommand: ${sub}. Try /mcp list.`, style: 'system' }] };
  }
}

function handleMcpList(): CommandResult {
  const servers = readMcplServersFile(DEFAULT_CONFIG_PATH);
  const entries = Object.entries(servers);

  if (entries.length === 0) {
    return { lines: [{ text: 'No MCPL servers configured. Use /mcp add <id> <command> [args...].', style: 'system' }] };
  }

  const lines: Line[] = [{ text: `--- MCPL Servers (${entries.length}) ---`, style: 'system' }];
  for (const [id, entry] of entries) {
    const cmdLine = [entry.command, ...(entry.args ?? [])].join(' ');
    lines.push({ text: `  ${id}: ${cmdLine}`, style: 'system' });
    if (entry.env && Object.keys(entry.env).length > 0) {
      const envStr = Object.entries(entry.env).map(([k, v]) => `${k}=${v}`).join(' ');
      lines.push({ text: `    env: ${envStr}`, style: 'system' });
    }
    if (entry.toolPrefix) {
      lines.push({ text: `    toolPrefix: ${entry.toolPrefix}`, style: 'system' });
    }
  }
  return { lines };
}

function handleMcpAdd(args: string[]): CommandResult {
  if (args.length < 2) {
    return { lines: [{ text: 'Usage: /mcp add <id> <command> [args...]', style: 'system' }] };
  }

  const [id, command, ...cmdArgs] = args;
  const servers = readMcplServersFile(DEFAULT_CONFIG_PATH);
  const prev = servers[id!];
  // Over an existing id, /mcp add replaces the command line (command and
  // args, which travel as one unit) and keeps its env and other settings: env
  // is edited with /mcp env and the panel editor.
  servers[id!] = {
    ...prev,
    command: command!,
    ...(cmdArgs.length > 0 ? { args: cmdArgs } : {}),
  };
  if (cmdArgs.length === 0) delete servers[id!]!.args;
  saveMcplServers(DEFAULT_CONFIG_PATH, servers);

  const keptEnv = prev?.env ? Object.keys(prev.env) : [];
  return {
    lines: [
      { text: `${prev ? 'Updated' : 'Added'} server "${id}". Restart to apply.`, style: 'system' },
      ...(keptEnv.length > 0
        ? [{ text: `  (kept env: ${keptEnv.join(', ')})`, style: 'system' as const }]
        : []),
    ],
  };
}

function handleMcpRemove(id?: string): CommandResult {
  if (!id) {
    return { lines: [{ text: 'Usage: /mcp remove <id>', style: 'system' }] };
  }

  const servers = readMcplServersFile(DEFAULT_CONFIG_PATH);
  if (!(id in servers)) {
    return { lines: [{ text: `Server "${id}" not found.`, style: 'system' }] };
  }

  delete servers[id];
  saveMcplServers(DEFAULT_CONFIG_PATH, servers);
  return { lines: [{ text: `Removed server "${id}". Restart to apply.`, style: 'system' }] };
}

function handleMcpEnv(id: string | undefined, pairs: string[]): CommandResult {
  if (!id || pairs.length === 0) {
    return { lines: [{ text: 'Usage: /mcp env <id> KEY=VALUE [KEY=VALUE ...]', style: 'system' }] };
  }

  const servers = readMcplServersFile(DEFAULT_CONFIG_PATH);
  if (!(id in servers)) {
    return { lines: [{ text: `Server "${id}" not found.`, style: 'system' }] };
  }

  const entry = servers[id]!;
  if (!entry.env) entry.env = {};

  const set: string[] = [];
  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx < 1) {
      return { lines: [{ text: `Invalid env pair: "${pair}". Expected KEY=VALUE.`, style: 'system' }] };
    }
    const key = pair.slice(0, eqIdx);
    const value = pair.slice(eqIdx + 1);
    entry.env[key] = value;
    set.push(key);
  }

  saveMcplServers(DEFAULT_CONFIG_PATH, servers);
  return { lines: [{ text: `Set ${set.join(', ')} on "${id}". Restart to apply.`, style: 'system' }] };
}

function getFleet(app: AppContext): FleetModule | null {
  const mod = app.framework.getAllModules().find((m) => m.name === 'fleet');
  return (mod as FleetModule | undefined) ?? null;
}

function handleFleet(app: AppContext, args: string[]): CommandResult {
  const fleet = getFleet(app);
  if (!fleet) {
    return {
      lines: [
        { text: 'Fleet module is not enabled in this recipe.', style: 'system' },
        { text: 'Add `"modules": { "fleet": true }` to your recipe JSON to enable.', style: 'system' },
      ],
    };
  }

  const sub = args[0];
  switch (sub) {
    case undefined:
    case 'list':
    case 'ls':
      return handleFleetList(fleet);
    case 'status':
      return handleFleetStatus(fleet, args[1]);
    case 'view':
      return { lines: [{ text: 'Opening fleet view. Press Tab to return.', style: 'system' }], switchToFleetView: true };
    case 'peek':
      if (!args[1]) return { lines: [{ text: 'Usage: /fleet peek <name>', style: 'system' }] };
      return handleFleetPeek(fleet, args[1]);
    case 'stop':
    case 'kill':
      if (!args[1]) return { lines: [{ text: 'Usage: /fleet stop <name>', style: 'system' }] };
      return handleFleetKill(fleet, args[1]);
    case 'restart':
      if (!args[1]) return { lines: [{ text: 'Usage: /fleet restart <name>', style: 'system' }] };
      return handleFleetRestart(fleet, args[1]);
    default:
      return {
        lines: [{ text: `Unknown /fleet subcommand: ${sub}. Try /fleet list.`, style: 'system' }],
      };
  }
}

function handleFleetList(fleet: FleetModule): CommandResult {
  const children = [...fleet.getChildren().values()];
  if (children.length === 0) {
    return { lines: [{ text: '(no children spawned)', style: 'system' }] };
  }
  const lines: Line[] = [{ text: '--- Fleet ---', style: 'system' }];
  for (const c of children) {
    lines.push({ text: `  ${formatChildRow(c)}`, style: 'system' });
  }
  return { lines };
}

function handleFleetStatus(fleet: FleetModule, name: string | undefined): CommandResult {
  if (!name) return handleFleetList(fleet);
  const c = fleet.getChildren().get(name);
  if (!c) return { lines: [{ text: `Unknown child: ${name}`, style: 'system' }] };
  const lines: Line[] = [
    { text: `--- ${c.name} ---`, style: 'system' },
    { text: `  recipe:     ${c.recipePath}`, style: 'system' },
    { text: `  dataDir:    ${c.dataDir}`, style: 'system' },
    { text: `  socket:     ${c.socketPath}`, style: 'system' },
    { text: `  pid:        ${c.pid ?? '-'}`, style: 'system' },
    { text: `  status:     ${c.status}`, style: 'system' },
    { text: `  startedAt:  ${new Date(c.startedAt).toISOString()}`, style: 'system' },
    { text: `  lastEvent:  ${c.lastEventAt ? new Date(c.lastEventAt).toISOString() : '-'}`, style: 'system' },
    { text: `  events:     ${c.events.length}`, style: 'system' },
    { text: `  subscribe:  ${c.subscription.join(', ') || '-'}`, style: 'system' },
  ];
  if (c.exitedAt) {
    lines.push({ text: `  exitedAt:   ${new Date(c.exitedAt).toISOString()}`, style: 'system' });
    lines.push({ text: `  exitCode:   ${c.exitCode ?? '-'} (${c.exitReason ?? '-'})`, style: 'system' });
  }
  return { lines };
}

function handleFleetPeek(fleet: FleetModule, name: string): CommandResult {
  const c = fleet.getChildren().get(name);
  if (!c) return { lines: [{ text: `Unknown child: ${name}`, style: 'system' }] };
  return {
    lines: [{ text: `Peeking ${name}. Press Esc to return.`, style: 'system' }],
    switchToFleetPeek: name,
  };
}

function handleFleetKill(fleet: FleetModule, name: string): CommandResult {
  const asyncWork = (async (): Promise<CommandResult> => {
    const res = await fleet.handleToolCall({ id: `slash-kill-${Date.now()}`, name: 'kill', input: { name } });
    if (!res.success) {
      return { lines: [{ text: `kill ${name} failed: ${res.error ?? 'unknown'}`, style: 'system' }] };
    }
    const data = res.data as { status?: string; exitCode?: number | null } | undefined;
    return {
      lines: [{ text: `kill ${name}: ${data?.status ?? 'done'} (exit ${data?.exitCode ?? '?'})`, style: 'system' }],
    };
  })();
  return {
    lines: [{ text: `Stopping ${name}...`, style: 'system' }],
    asyncWork,
  };
}

function handleFleetRestart(fleet: FleetModule, name: string): CommandResult {
  const asyncWork = (async (): Promise<CommandResult> => {
    const res = await fleet.handleToolCall({ id: `slash-restart-${Date.now()}`, name: 'restart', input: { name } });
    if (!res.success) {
      return { lines: [{ text: `restart ${name} failed: ${res.error ?? 'unknown'}`, style: 'system' }] };
    }
    return { lines: [{ text: `${name} restarted.`, style: 'system' }] };
  })();
  return {
    lines: [{ text: `Restarting ${name}...`, style: 'system' }],
    asyncWork,
  };
}
