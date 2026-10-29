/**
 * Commands:
 *   /undo          — Take the agent's last turn out of its window (the record keeps it)
 *   /redo          — Put the turn /undo took out back in the agent's window
 *   /nudge [agent] — Run inference on current context (no new events)
 *   /checkpoint N  — Save current position as named checkpoint
 *   /restore N     — Roll the record back to a checkpoint, on a new branch
 *   /branches      — List all Chronicle branches
 *   /checkout N    — Switch to named branch
 *   /branchto M    — Roll the record back to a message, on a new branch
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
import { asOwnRow, OperatorActionError, type Agent, type AgentFramework, type OperatorRequester } from '@animalabs/agent-framework';
import { isResettableStrategy, type ContextManager, type MessageMetadata, type StrategyContext } from '@animalabs/context-manager';
import type { Recipe } from './recipe.js';
import type { CredentialActionId, CredentialState } from './credential-state.js';
import { readMcplServersFile, saveMcplServers, DEFAULT_CONFIG_PATH, DEFAULT_AGENT_OVERLAY_PATH } from './mcpl-config.js';
import { buildBugReport, composedServerConfigs, gatherBugReportFacts, runtimeMode, type LiveSetup } from './bug-report.js';
import { parseCommand } from './command-name.js';
import type { Line } from './output-line.js';
import { fmtTokens } from './tui.js';
import { modelThinking } from './logging-adapter.js';
import { formatToolClassRows, readToolClasses } from './tool-lifecycle-config.js';
import { type FleetModule, formatChildRow } from './modules/fleet-module.js';
import { EXACT_VERSION } from './update/install.js';
import { SWITCH_UNDER_WAY } from './session-switch.js';
import { hostUpdate } from './update/update.js';
import { goBackLines, statusLines } from './web/update-text.js';

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
  switching?: boolean;
  stopping?: boolean;
  switchSession(id: string): Promise<void>;
}

export type { Line };

export interface StatePoint {
  branchName: string;
  messageId?: string;
}

/**
 * /undo and /redo keep no stacks here: since agent-framework #291 they are
 * the framework's undo and redo on the agent's window, which keep their own.
 */
export interface BranchState {
  checkpoints: Map<string, StatePoint>;
  /** Each agent's /newtopic waiting for a turn of it to end
   *  (transitionOnceIdle), by agent: aborting one ends its wait, with
   *  nothing stored. */
  newTopics?: Map<string, AbortController>;
}

export function createBranchState(): BranchState {
  return {
    checkpoints: new Map(),
  };
}

/** Called as the session or the branch is switched: the checkpoints go, and
 *  each /newtopic still waiting for a turn ends, storing nothing. */
export function resetBranchState(bs: BranchState): void {
  bs.checkpoints.clear();
  const waits = bs.newTopics;
  if (!waits) return;
  bs.newTopics = undefined;
  for (const wait of waits.values()) wait.abort('the session or the branch was switched');
}

export interface CommandResult {
  lines: Line[];
  quit?: boolean;
  switchToSessionId?: string;
  branchChanged?: boolean;
  asyncWork?: Promise<CommandResult>;
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
 * The agent a command acts for: the one the host resolved (app.agentName),
 * else the framework's primary, else the first registered.
 */
function commandAgent(app: AppContext): Agent | undefined {
  const framework = app.framework;
  const named = app.agentName ? framework.getAgent(app.agentName) : null;
  if (named) return named;
  const primary = typeof framework.getPrimaryAgentName === 'function' ? framework.getPrimaryAgentName() : null;
  return (primary ? framework.getAgent(primary) : null) ?? framework.getAllAgents()[0];
}

/** Who asked, in the framework's operator log: an operator's command. */
const HOST_COMMAND: OperatorRequester = { via: 'host-console' };

/** A thrown error's message. */
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * agent-framework writes a turn's reply onto whatever branch is current when
 * it lands, and a branch switch moves the branch of every agent sharing the
 * store, so the head moves only between turns: stop the generation, then
 * move the head.
 *
 * This checks the agent the command acts for, so the refusal comes at once
 * and offers to stop its turn, the one an operator can stop. The framework,
 * which each of these commands goes through, refuses a branch move or a
 * rollback while any agent sharing the store, the subconscious included, is
 * busy or has a turn alive, naming each, and writes the refusal to the
 * operator log; and an undo or a redo while the agent's own turn is alive,
 * not another agent's, since neither moves a branch.
 */
function inFlightGuard(app: AppContext, cmd: string): CommandResult | null {
  const agent = commandAgent(app);
  const status = (agent as { state?: { status?: string } } | undefined)?.state?.status;
  if (status === undefined || status === 'idle') return null;
  return {
    lines: [
      { text: `/${cmd} refused: a turn is in flight (${(agent as { name?: string }).name ?? 'agent'}: ${status}).`, style: 'system' },
      { text: '  Moving the head mid-generation would attach the streaming reply to the wrong', style: 'system' },
      { text: '  branch/request. Wait for the turn to end, or stop it, then retry.', style: 'system' },
    ],
  };
}

/**
 * The last line of a branch move or a rollback that didn't happen (#264):
 * this command moved nothing, and, when the store was busy, to try again
 * once what the framework's refusal names (an agent's turn, a fork being
 * created, a surgery or a switch) has finished. The framework's own words
 * say only "quiesce the host first".
 */
function movedNothing(err: unknown): Line {
  return {
    text: err instanceof OperatorActionError && err.code === 'agent-busy'
      ? '  This command moved nothing. Try again once what it names has finished.'
      : '  This command moved nothing.',
    style: 'system',
  };
}

/**
 * Move the store to an existing branch through the framework's switch
 * (/checkout, and /restore to a checkpoint's branch head; chronicle is
 * name-keyed, so it takes the name). The branch moves under every agent
 * sharing the store, so it is refused unless every one of them is idle;
 * each agent's context follows it (its strategy initialized again on the
 * branch, its window written down there if the branch predates it), and so
 * does the `_config` mount. The operator log records it as a checkout.
 *
 * What the framework answers decides what this says (#264). A refusal
 * (OperatorActionError) comes before anything moves, so it is never taken
 * for a move, whatever branch the store is on by then. Another rejection
 * with the store on the target is the one the framework documents after
 * the move, the `_config` mount failing: that is the move it was, so it is
 * answered as one, saying the gate's files may still be the previous
 * branch's and that `/checkout <branch>` runs the refresh again (a switch
 * to the branch the store is on re-initializes every agent's context and
 * re-materializes the mount).
 */
function switchStore(
  app: AppContext,
  target: string,
  note: string,
  words: { done: string; failed: string },
): Promise<CommandResult> {
  const framework = app.framework;
  const from = framework.getStore().currentBranch().name;
  return Promise.resolve()
    .then(() => framework.switchBranch(target, { requester: HOST_COMMAND, note }))
    .then(
      (): CommandResult => ({ lines: [{ text: words.done, style: 'system' }], branchChanged: true }),
      (err: unknown): CommandResult => {
        const message = messageOf(err);
        if (!(err instanceof OperatorActionError) && from !== target && framework.getStore().currentBranch().name === target) {
          return {
            lines: [
              { text: `${words.done} Refreshing the _config mount from it failed: ${message}`, style: 'system' },
              { text: `  The gate's files may still be the previous branch's. /checkout ${target} runs the refresh again.`, style: 'system' },
            ],
            branchChanged: true,
          };
        }
        return { lines: [{ text: `${words.failed}: ${message}`, style: 'system' }, movedNothing(err)] };
      },
    );
}

/**
 * The answer to a rollback (/restore to a checkpoint's message, /branchto)
 * that the framework rejected. rollbackToMessage refuses an unknown agent
 * or message, an invalid branch name and a busy store before it makes the
 * branch, so then this command moved nothing and made no branch to remove.
 * Its 'failed' comes once the branch was made and the switch to it failed:
 * its words say where it put the store back, and it keeps the branch for
 * diagnosis. When putting the store back failed too, the store is still on
 * the new branch (`from` is the branch it was on before the rollback): the
 * answer then says the branch changed, so the TUI and the Web UI show the
 * branch the store is on.
 */
function rollbackFailed(app: AppContext, from: string, failed: string, err: unknown): CommandResult {
  const lines: Line[] = [{ text: `${failed}: ${messageOf(err)}`, style: 'system' }];
  if (app.framework.getStore().currentBranch().name !== from) return { lines, branchChanged: true };
  if (!(err instanceof OperatorActionError && err.code === 'failed')) lines.push(movedNothing(err));
  return { lines };
}

export function handleCommand(command: string, app: AppContext): CommandResult {
  const parts = command.slice(1).trim().split(/\s+/);
  const cmd = parseCommand(command).name;
  const args = parts.slice(1);
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
          { text: '  /undo                  Take the agent\'s last turn out of its window (the record keeps it)', style: 'system' },
          { text: '  /redo                  Put the turn /undo took out back in its window', style: 'system' },
          { text: '  /nudge [agent]         Run inference on current context (no new events)', style: 'system' },
          { text: '  /puppet <tool> [json]  Admin: execute a tool AS the agent, store the pair', style: 'system' },
          { text: '  /checkpoint [name]     Save current state (no name: list checkpoints)', style: 'system' },
          { text: '  /restore [name]        Roll back to a checkpoint, on a new branch (no name: list checkpoints)', style: 'system' },
          { text: '  /branches              List Chronicle branches and checkpoints', style: 'system' },
          { text: '  /checkout <name>       Switch to branch', style: 'system' },
          { text: '  /history [n]           Show the last n messages (20 by default)', style: 'system' },
          { text: '  /find <text>           Search messages for text', style: 'system' },
          { text: '  /branchto <msgId>      Roll back to a message, on a new branch', style: 'system' },
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
          { text: '                         (subcommands: install | restart [wait | now | resume | <version>] | back [(keep | restore) [<version>]])', style: 'system' },
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
      return inFlightGuard(app, cmd) ?? handleUndo(app);

    case 'nudge':
      return handleNudge(app, args[0]);

    case 'puppet':
      return handlePuppet(app, args);

    case 'redo':
      return inFlightGuard(app, cmd) ?? handleRedo(app);

    // Name-taking commands take the rest of the line, so a name may contain
    // spaces (/checkpoint my test point).
    case 'checkpoint':
      return handleCheckpoint(app, args.join(' ') || undefined);

    case 'restore':
      return inFlightGuard(app, cmd) ?? handleRestore(app, args.join(' ') || undefined);

    case 'branches':
      return handleBranches(app);

    case 'checkout':
      return inFlightGuard(app, cmd) ?? handleCheckout(app, args.join(' ') || undefined);

    case 'history':
      return handleHistory(app, args[0]);

    case 'branchto':
      return inFlightGuard(app, cmd) ?? handleBranchTo(app, args[0]);

    case 'find':
      return handleFind(app, args.join(' '));

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
  const after = (first: string, work: Promise<{ lines: string[] }>): CommandResult =>
    ({ ...say([first]), asyncWork: work.then((answer) => say(answer.lines)) });
  const [sub, choice, release, extra] = args;
  const usage = say(['Usage: /update [install | restart [wait | now | resume | <version>] | back [(keep | restore) [<version>]]]']);
  if (extra !== undefined) return usage;
  const version = (word: string | undefined): word is string => word !== undefined && EXACT_VERSION.test(word);
  if (sub === undefined) {
    return after('Reading the registry…',
      hostUpdate.readRegistry().then(() => ({ lines: statusLines(hostUpdate.status()) })));
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
    if (choice === undefined) return say(goBackLines(hostUpdate.status()));
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

function handleSessionNew(app: AppContext, name?: string): CommandResult {
  if (app.switching) return switchUnderWay;
  const session = app.sessionManager.createSession(name);
  resetBranchState(app.branchState);

  return {
    lines: [{ text: `Switching to new session: ${session.name} [${session.id}]...`, style: 'system' }],
    switchToSessionId: session.id,
  };
}

function handleSessionSwitch(app: AppContext, nameOrId?: string): CommandResult {
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

/**
 * /undo: the framework's undo on the agent's window (agent-framework #291,
 * decision 4). The agent's last turn leaves its window, its own rows as
 * undone and the others' to be shown again at its next turn, and nothing
 * else changes: the record keeps the turn, no branch moves, and the
 * workspace and `_config` mounts, MCPL checkpoints and the inference log
 * stay as they are. Another agent's turn, newer or not, is left alone.
 * /branchto reverts the record.
 */
function handleUndo(app: AppContext): CommandResult {
  const agent = commandAgent(app);
  if (!agent) return { lines: [{ text: 'No agent.', style: 'system' }] };
  let undone: ReturnType<AgentFramework['undoLastTurn']>;
  try {
    undone = app.framework.undoLastTurn(agent.name, HOST_COMMAND);
  } catch (err) {
    return { lines: [{ text: `Undo failed: ${messageOf(err)}`, style: 'system' }] };
  }
  if (!undone.undone) return { lines: [{ text: 'Nothing to undo.', style: 'system' }] };
  const rows = undone.window?.retracted ?? 0;
  return {
    lines: [
      { text: `Undone: ${agent.name}'s last turn left its window (${rows} row${rows === 1 ? '' : 's'}).`, style: 'system' },
      { text: '  The record keeps it, and no branch moved: /redo puts it back, /branchto <msgId> reverts the record.', style: 'system' },
    ],
  };
}

/** /redo: the framework's redo of the agent's last undo, on its window: the undone turn's rows enter it again. */
function handleRedo(app: AppContext): CommandResult {
  const agent = commandAgent(app);
  if (!agent) return { lines: [{ text: 'No agent.', style: 'system' }] };
  let redone: ReturnType<AgentFramework['redo']>;
  try {
    redone = app.framework.redo(agent.name, HOST_COMMAND);
  } catch (err) {
    return { lines: [{ text: `Redo failed: ${messageOf(err)}`, style: 'system' }] };
  }
  if (!redone.redone) return { lines: [{ text: 'Nothing to redo.', style: 'system' }] };
  const rows = redone.window?.represented ?? 0;
  return {
    lines: [{ text: `Redone: ${agent.name}'s undone turn is back in its window (${rows} row${rows === 1 ? '' : 's'}).`, style: 'system' }],
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

  const cm = commandAgent(app)?.getContextManager();
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

  const agent = commandAgent(app);
  const cm = agent?.getContextManager();
  if (!agent || !cm) return { lines: [{ text: 'No agent context manager.', style: 'system' }] };

  // Restore to the recorded *position*: the framework's rollback to the
  // checkpoint's message, on a new branch, which it moves the store to with
  // every agent sharing it idle (rollbackToMessage). Switching to the stored
  // branch name alone would land on its head, which by now may include
  // everything the user wanted to roll back. Checkpoints taken on an empty
  // branch fall back to the head.
  if (point.messageId) {
    const { messages } = cm.queryMessages({});
    const atCheckpoint = messages.length > 0
      && messages[messages.length - 1]!.id === point.messageId;
    if (atCheckpoint) {
      return { lines: [{ text: `Already at checkpoint "${name}".`, style: 'system' }] };
    }
  }

  const toHead = (note: boolean): Promise<CommandResult> => switchStore(app, point.branchName, `/restore ${name}`, {
    done: `Restored to checkpoint "${name}" (branch: ${point.branchName}).`,
    failed: 'Restore failed',
  }).then((result) => (result.branchChanged && note
    ? { ...result, lines: [...result.lines, { text: '  (note: exact checkpoint position unreachable from the current branch — restored to the branch head instead)', style: 'system' as const }] }
    : result));
  // The checkpoint moves to the rollback's branch only once the rollback has
  // landed, and only if it is still the one this restore read (#264): saved
  // again, or cleared by a session reset, while the rollback waited, it is
  // left as it is now.
  const from = app.framework.getStore().currentBranch().name;
  const asyncWork = point.messageId
    ? app.framework.rollbackToMessage(agent.name, {
        messageId: point.messageId,
        requester: HOST_COMMAND,
        branchName: `restore-${name}-${Date.now()}`,
        note: `/restore ${name}`,
      }).then((rolled): CommandResult => {
        if (app.branchState.checkpoints.get(name) === point) {
          app.branchState.checkpoints.set(name, { branchName: rolled.targetBranch, messageId: point.messageId });
        }
        return {
          lines: [
            { text: `Restored to checkpoint "${name}" (branch: ${rolled.targetBranch}).`, style: 'system' },
            ...rollbackKeptLines(rolled, agent.name),
          ],
          branchChanged: true,
        };
      }, (err: unknown) => {
        // The rollback finds the message on the current branch and refuses
        // with 'unknown-message' when it isn't there, as after a /branchto:
        // the restore then goes to the checkpoint's branch head.
        if ((err as { code?: unknown } | null)?.code === 'unknown-message') return toHead(true);
        return rollbackFailed(app, from, 'Restore failed', err);
      }).catch((err: unknown) => ({
        lines: [{ text: `Restore failed: ${messageOf(err)}`, style: 'system' as const }],
      }))
    : toHead(false);

  return {
    lines: [{ text: `Restoring to checkpoint "${name}"...`, style: 'system' }],
    asyncWork,
  };
}

function handleBranches(app: AppContext): CommandResult {
  const cm = commandAgent(app)?.getContextManager();
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

function handleCheckout(app: AppContext, name?: string): CommandResult {
  if (!name) {
    return { lines: [{ text: 'Usage: /checkout <branch-name>', style: 'system' }] };
  }

  const cm = commandAgent(app)?.getContextManager();
  if (!cm) return { lines: [{ text: 'No agent context manager.', style: 'system' }] };

  const branches = cm.listBranches();
  const target = branches.find(b => b.name === name || b.id === name);
  if (!target) {
    return { lines: [{ text: `Branch "${name}" not found. Use /branches to list.`, style: 'system' }] };
  }

  // The framework's switch, every agent's context and the `_config` mount
  // following it (switchStore).
  const asyncWork = switchStore(app, target.name, `/checkout ${name}`, {
    done: `Switched to branch ${target.name}.`,
    failed: 'Checkout failed',
  });

  return {
    lines: [{ text: `Switching → branch ${target.name}...`, style: 'system' }],
    asyncWork,
  };
}

/** /find, in the command agent's context, as /branchto looks its ids up. */
function handleFind(app: AppContext, needle: string): CommandResult {
  const cm = commandAgent(app)?.getContextManager();
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

/**
 * What a rollback kept of the rows after its target, on a presented window
 * (agent-framework #291, decided answer 5 and DQ-1): the lines an operator
 * reads after `/branchto` or `/restore`, none when it kept nothing. The cut
 * is at the write that presented the target, so
 * - rows stored before that write and shown after it (`returnedToArrivals`)
 *   stay in the record: they wait out of the agent's window until its next
 *   turn starts, which presents them after what the window holds then;
 * - rows that one write presented with the target
 *   (`keptInWindowAfterTarget`) stay in the window after it, since a branch
 *   cut can't separate them, until a suppression or a hide takes them out.
 */
function rollbackKeptLines(
  rolled: { tailMessageId: string; returnedToArrivals?: number; keptInWindowAfterTarget?: number },
  agentName: string,
): Line[] {
  const at = `[${rolled.tailMessageId}]`;
  const lines: Line[] = [];
  const returned = rolled.returnedToArrivals ?? 0;
  if (returned > 0) {
    lines.push({
      text: returned === 1
        ? `  1 row after ${at} stays in the record: stored before ${agentName} was shown ${at}, it is out of its window until its next turn starts, and enters it then.`
        : `  ${returned} rows after ${at} stay in the record: stored before ${agentName} was shown ${at}, they are out of its window until its next turn starts, and enter it then.`,
      style: 'system',
    });
  }
  const kept = rolled.keptInWindowAfterTarget ?? 0;
  if (kept > 0) {
    const remedy = "The Web UI's suppress, or a hide by Discord message id,";
    lines.push({
      text: kept === 1
        ? `  1 row after ${at} stays in ${agentName}'s window: one write showed it with ${at}, and a branch cut can't separate them. ${remedy} takes it out.`
        : `  ${kept} rows after ${at} stay in ${agentName}'s window: one write showed them with ${at}, and a branch cut can't separate them. ${remedy} takes them out.`,
      style: 'system',
    });
  }
  return lines;
}

/**
 * /branchto: the framework's rollback to a message (rollbackToMessage): the
 * message becomes the tail of a new branch, which the store moves to with
 * every agent sharing it idle; the old branch keeps everything after it.
 * On a presented window some rows after the message can stay, and the
 * answer says which (rollbackKeptLines). Logged as an operator's rollback.
 */
function handleBranchTo(app: AppContext, messageId: string | undefined): CommandResult {
  const agent = commandAgent(app);
  const cm = agent?.getContextManager();
  if (!agent || !cm) return { lines: [{ text: 'No agent context manager.', style: 'system' }] };
  if (!messageId) return { lines: [{ text: 'Usage: /branchto <messageId>', style: 'system' }] };
  const { messages } = cm.queryMessages({});
  const target = messages.find(m => String(m.id) === String(messageId));
  if (!target) return { lines: [{ text: `No message with id ${messageId} on current branch.`, style: 'system' }] };
  const newBranchName = `rollback-at-${messageId}-${Date.now()}`;
  const from = app.framework.getStore().currentBranch().name;
  const asyncWork = app.framework.rollbackToMessage(agent.name, {
    messageId: String(messageId),
    requester: HOST_COMMAND,
    branchName: newBranchName,
    note: `/branchto ${messageId}`,
  })
    .then((rolled) => {
      const kept = rollbackKeptLines(rolled, agent.name);
      const after = kept.length === 0
        ? `Everything after [${rolled.tailMessageId}] is dropped on this branch`
        : `${rolled.messagesRemoved} message${rolled.messagesRemoved === 1 ? '' : 's'} after [${rolled.tailMessageId}] ${rolled.messagesRemoved === 1 ? 'is' : 'are'} dropped on this branch`;
      return {
        lines: [
          { text: `Branched at [${rolled.tailMessageId}] -> "${rolled.targetBranch}" and switched. ${after}; old branch preserved.`, style: 'system' as const },
          ...kept,
        ],
        branchChanged: true,
      };
    })
    .catch((err: unknown) => rollbackFailed(app, from, 'branchto failed', err));
  return { lines: [{ text: `Branching at [${messageId}] -> "${newBranchName}"...`, style: 'system' }], asyncWork };
}

/** /history: the command agent's context, which /branchto looks its ids up in. */
function handleHistory(app: AppContext, countArg?: string): CommandResult {
  const cm = commandAgent(app)?.getContextManager();
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
  const agent = commandAgent(app);
  const cm = agent?.getContextManager();
  if (!agent || !cm) return { lines: [{ text: 'No context manager.', style: 'system' }] };

  const userContext = args.join(' ').trim() || undefined;

  // The transition is the agent's own row (agent-framework #291): stamped for
  // it alone, so no other resident sharing the slot is shown it, and
  // presented as context-manager stores it, so the head window starts at a
  // row the agent's window holds. It is stored only while the agent is idle
  // with no turn alive (transitionOnceIdle). inFlightGuard reads the agent's
  // status alone: an idle agent's turn is still alive while a continuation
  // or a retry of it is on its way, and the transition is then stored once
  // that turn has ended. Given its text, an agent found idle with no turn
  // alive has it stored here, before anything awaits. A bare /newtopic
  // writes the summary first, and the agent can start a turn meanwhile
  // (newTopicOnceIdle).
  const metadata = asOwnRow(undefined, agent.name);
  const turnAlive = userContext !== undefined && !idleWithNoTurn(app.framework, agent.name);
  // One /newtopic waits for each agent. A later one replaces it, as the
  // operator's later word (a refusal would leave a mistyped transition to be
  // stored once the turn ends, with no way to correct it), and the earlier
  // one stores nothing. A wait ends too, storing nothing, at a session or a
  // branch switch (resetBranchState), at the host's stop, and once the
  // framework it was given against is no longer the host's.
  const branchState = app.branchState as BranchState | undefined;
  const waits = branchState ? (branchState.newTopics ??= new Map()) : new Map<string, AbortController>();
  const earlier = waits.get(agent.name);
  earlier?.abort(`a later /newtopic for ${agent.name} replaced it`);
  const wait = new AbortController();
  waits.set(agent.name, wait);
  const release = () => { if (waits.get(agent.name) === wait) waits.delete(agent.name); };
  const framework = app.framework;
  const lifetime: NewTopicLifetime = {
    signal: wait.signal,
    gone: () => app.stopping ? 'the host is stopping'
      : app.switching ? 'a session switch began'
      : app.framework !== framework ? 'the session it was given in has been switched away from'
      : undefined,
    storing: release,
  };
  const reset = userContext !== undefined
    ? givenTransitionOnceIdle(framework, agent.name, cm, userContext, metadata, lifetime)
    : newTopicOnceIdle(framework, agent.name, cm, metadata, lifetime);
  void reset.then(release, release);
  const asyncWork = reset.then(summary => ({
    lines: [
      { text: 'Topic reset. Transition summary:', style: 'system' as const },
      { text: summary.slice(0, 300) + (summary.length > 300 ? '...' : ''), style: 'system' as const },
    ],
  })).catch(err => ({
    lines: [{ text: `Topic reset failed: ${err instanceof Error ? err.message : err}`, style: 'system' as const }],
  }));

  return {
    lines: [
      { text: userContext
        ? 'Resetting topic with provided context...'
        : 'Generating transition summary...', style: 'system' },
      ...(turnAlive
        ? [{ text: `  A turn of ${agent.name}'s is still alive (a continuation or a retry of it on its way): ` +
            'the transition is stored once it has ended.', style: 'system' as const }]
        : []),
      ...(earlier
        ? [{ text: `  This replaces the /newtopic for ${agent.name} still waiting for a turn to end: that one stores nothing.`, style: 'system' as const }]
        : []),
    ],
    asyncWork,
  };
}

/** How long /newtopic waits, once it has its transition (its text, or a
 *  bare one's summary), for a turn of the agent to end, and how often it
 *  looks. Each wait reads them as it begins; a test shortens them. */
export const newTopicIdleWait = { waitMs: 10 * 60_000, pollMs: 100 };

/** What ends a /newtopic's wait, storing nothing (transitionOnceIdle). */
interface NewTopicLifetime {
  /** Aborted, with the reason, by a later /newtopic for the agent or a switch of the session or the branch. */
  signal: AbortSignal;
  /** Why the session it was given in has ended, once it has: the host is stopping or switching sessions, or its framework isn't the host's. */
  gone(): string | undefined;
  /** Called as it stores the transition, which a later /newtopic no longer replaces. */
  storing(): void;
}

/** Wait `ms`, or until `signal` aborts, on a timer that doesn't hold the process open. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    timer = setTimeout(done, ms);
    (timer as { unref?: () => void }).unref?.();
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Whether the agent is idle with no turn alive: no turn token, and no
 *  continuation or retry of its turn on its way (getHostModeStatus's
 *  activeTurnAgents, which the framework's own refusals read). */
function idleWithNoTurn(framework: AgentFramework, agentName: string): boolean {
  const agent = framework.getAgent(agentName) as { state?: { status?: string } } | null | undefined;
  if (agent?.state?.status !== undefined && agent.state.status !== 'idle') return false;
  const status = typeof framework.getHostModeStatus === 'function' ? framework.getHostModeStatus() : undefined;
  return !status?.activeTurnAgents.includes(agentName);
}

/**
 * Store `transition` as the agent's [Topic Transition] row and start its head
 * window there, once the agent is idle with no turn alive (#291, J-H3): by a
 * resetHeadWindow with it as its text, in the same step that finds the agent
 * so (given its text, resetHeadWindow stores and presents the row before it
 * first awaits). Stored inside a turn, the row would enter the agent's window
 * between rounds its requests were sent without, past the framework's turn
 * gate. A turn alive is waited for, up to newTopicIdleWait.waitMs, so the
 * transition follows it in the window. Nothing is stored if `lifetime`
 * ends the wait (its signal aborts, or its session is gone), if the agent is
 * still busy then (`begun.waited`, and the answer says `begun.again`), if
 * it has gone, or if the branch or the strategy changed since
 * `begun.strategy` and `begun.branch` were read (`begun.since`, and the
 * answer gives back `begun.kept`). When the agent is
 * idle with no turn alive as this is called, the row is stored before this
 * returns: nothing awaits before the first check.
 */
async function transitionOnceIdle(
  framework: AgentFramework,
  agentName: string,
  cm: ContextManager,
  transition: string,
  metadata: MessageMetadata,
  begun: { strategy: unknown; branch: string; since: string; waited: string; again: string; kept: string },
  lifetime: NewTopicLifetime,
): Promise<string> {
  const { waitMs, pollMs } = newTopicIdleWait;
  const deadline = Date.now() + waitMs;
  const nothingStored = 'nothing was stored';
  for (;;) {
    const ended = lifetime.signal.aborted ? String(lifetime.signal.reason) : lifetime.gone();
    if (ended !== undefined) throw new Error(`${ended}; ${nothingStored}${begun.kept}`);
    if (framework.getAgent(agentName)?.getContextManager() !== cm) {
      throw new Error(`${agentName} is no longer registered with this context; ${nothingStored}${begun.kept}`);
    }
    if (cm.getStrategy() !== begun.strategy || cm.currentBranch().id !== begun.branch) {
      throw new Error(`the branch or the strategy changed since ${begun.since}; ${nothingStored}${begun.kept}`);
    }
    // No await from these checks to the store: no turn starts, and the
    // session doesn't end, between them.
    if (idleWithNoTurn(framework, agentName)) {
      lifetime.storing();
      return cm.resetHeadWindow(transition, { metadata });
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${agentName} still had a turn alive ${Math.round(waitMs / 1000)} s after ${begun.waited}, ` +
          `and ${nothingStored}. ${begun.again}`,
      );
    }
    await pause(pollMs, lifetime.signal);
  }
}

/**
 * `/newtopic <text>`'s transition (transitionOnceIdle): stored here when the
 * agent is idle with no turn alive, and otherwise once its turn has ended. A
 * strategy that can't reset its head window is refused at once.
 */
function givenTransitionOnceIdle(
  framework: AgentFramework,
  agentName: string,
  cm: ContextManager,
  text: string,
  metadata: MessageMetadata,
  lifetime: NewTopicLifetime,
): Promise<string> {
  const strategy = cm.getStrategy();
  if (!isResettableStrategy(strategy)) return Promise.reject(new Error('Active strategy does not support head window reset'));
  return transitionOnceIdle(framework, agentName, cm, text, metadata, {
    strategy,
    branch: cm.currentBranch().id,
    since: '/newtopic was given',
    waited: '/newtopic was given',
    again: 'Run /newtopic again once its turn has ended.',
    kept: '',
  }, lifetime);
}

/**
 * A bare /newtopic's transition (#291, J-H3): the strategy's summary of the
 * head window is written first, an LLM call during which a turn of the agent
 * can start, and it is stored as the transition once the agent is idle with
 * no turn alive (transitionOnceIdle). Nothing is stored if the branch or the
 * strategy changed since the summary was begun: the summary is of the head
 * window that was there. Whenever nothing is stored, the answer gives the
 * summary back.
 *
 * The summary is the one resetHeadWindow writes for itself, from the
 * manager's own strategy context: context-manager has no public call that
 * writes it without storing it, so this reaches the manager's
 * createStrategyContext, and says so if a context-manager without it is
 * installed.
 */
async function newTopicOnceIdle(
  framework: AgentFramework,
  agentName: string,
  cm: ContextManager,
  metadata: MessageMetadata,
  lifetime: NewTopicLifetime,
): Promise<string> {
  const strategy = cm.getStrategy();
  if (!isResettableStrategy(strategy)) throw new Error('Active strategy does not support head window reset');
  const contextOf = (cm as unknown as { createStrategyContext?: () => StrategyContext }).createStrategyContext;
  if (typeof contextOf !== 'function') {
    throw new Error(
      "this context-manager can't write a transition summary apart from storing it; " +
        'give the transition yourself: /newtopic <text>',
    );
  }
  const branch = cm.currentBranch().id;
  const summary = await strategy.generateTransitionSummary(contextOf.call(cm));
  return transitionOnceIdle(framework, agentName, cm, summary, metadata, {
    strategy,
    branch,
    since: 'the transition summary was begun',
    waited: 'the transition summary was written',
    again: `To store it, run /newtopic with it as the text:\n${summary}`,
    kept: `. The summary it wrote, of the head window then:\n${summary}`,
  }, lifetime);
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
