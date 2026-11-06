import { readFileSync } from 'node:fs';
import type {
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
} from '@animalabs/agent-framework';
import { formatZonedDateTime, resolveTimeZone } from '@animalabs/agent-framework';
import { unknownToolResult } from './unknown-tool.js';
import { hostNoteMetadata } from '../speaker.js';
import { EXACT_VERSION } from '../update/install.js';
import { hostUpdate, type HostUpdate, type UpdateAnswer } from '../update/update.js';
import {
  ARMED_RETRY, QUIET_MOMENT, TOOL_CANCEL, TOOL_WAYS, armedName, goBackLines, inAgentWords, inShellWords, statusLines,
  toolWays,
} from '../web/update-text.js';
import {
  SELF_RESTART_EXIT_CODE,
  selfRestart as processSelfRestart,
  type SelfRestartRecord,
  type SelfRestartRequest,
  type SelfRestartState,
} from '../self-restart.js';

export const DEFAULT_SELF_RESTART_COOLDOWN_MINUTES = 10;

export interface LifecycleModuleConfig {
  dataDir: string;
  cooldownMinutes?: number;
  timeZone?: string;
  state?: SelfRestartState;
  now?: () => Date;
  hostVersion?: string;
  selfRestart?: boolean;
  selfUpdate?: boolean;
  update?: HostUpdate;
  headless: boolean;
  installCommand?: string;
}

function readHostVersion(): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

const TOOL_DESCRIPTION =
  'Restart your own host process. Use it to pick up something that only takes effect at start: ' +
  'an edited recipe or config, rebuilt host code, or to recover from a state you cannot get out of otherwise. ' +
  'For one MCPL server, mcpl-admin--mcpl_restart (if you have it, in the built-in "settings" toolset, or in your ' +
  'tool list if that lacks toolsets--open or toolsets--act) is the lighter option and keeps you running. ' +
  'The restart does not interrupt you: it happens once this turn has ended and nothing is in flight ' +
  '(no turn, subagent run or background script still going). ' +
  'The host then exits with code 75 for whatever supervises it (launchd, systemd, a fleet parent) to start it again, ' +
  'usually within seconds; if nothing does, it stays down until someone starts it. Messages that arrive ' +
  'while it is down are handled by whatever catch-up each channel does on reconnect. ' +
  'Your memory and workspace persist. With prompt caching on, a restart that picks up changed tools or a changed ' +
  'system prompt writes your prompt cache afresh on your first turn after it. ' +
  "After the restart, one line in the host's main conversation says who asked, when, why, and when the host came back. " +
  '`cancel: true` disarms a pending restart, whoever asked for it. There is a cooldown between restarts.';

const UPDATE_ACTIONS = ['check', 'notes', 'install', 'restart', 'back', 'cancel'] as const;

const UPDATE_DESCRIPTION =
  'Update your own host to a newer connectome-host release, or go back to the one before, with nobody\'s hands needed. ' +
  '`action`:\n' +
  '- check: what is out and what it costs (which releases since yours are breaking, and which rewrite your prompt ' +
  'cache once), the release you run, an install under way, an armed restart, and how the last switch ended: committed, ' +
  'or went back, and why.\n' +
  '- notes: once a release newer than yours is installed, the notes of each release after yours up to it, from its ' +
  'own CHANGELOG.md, when they fit in one answer (24,000 characters). When they don\'t, it lists those releases with ' +
  'each one\'s size, and notes with `version` gives one release\'s notes: their first part, if even those don\'t fit, ' +
  'with how much was left out and where the rest is. check names it while a newer release is installed.\n' +
  '- install: installs the newest release beside the one you run, which runs on. It answers once the install has ' +
  'begun; check shows when it is done.\n' +
  '- restart: arms a restart onto the newest release installed. It begins at the host\'s first quiet moment, once ' +
  QUIET_MOMENT + ', however long that takes, so it goes only once every host has said no turn is running there, ' +
  'and asks nobody: your turn ends as it would. ' +
  ARMED_RETRY + ' The host then stops, and its service starts it again on the new release. If the host stops for ' +
  'any other reason first, nothing stays armed, and from its next start check says the restart didn\'t go ahead, with that stop as the ' +
  'reason, though a crash, a forced kill (SIGKILL) or a record the host can\'t write leaves no word of it. An ' +
  'operator\'s own Restart or Go back also takes its place. Until the host next starts, or until you arm another, ' +
  'check says when one didn\'t go ahead for another reason, and why.\n' +
  '- back: arms a Go back to the release whose data the copy holds, the same way. `data` is required. keep runs ' +
  'that release on your data as it is now, so you lose nothing; if it can\'t read that data, its start goes back to ' +
  'the release you run now by itself, and restore is the way then. restore puts back the copy taken at the last ' +
  'switch, so everything since then, for you everything you have lived since, is set aside, not deleted.\n' +
  '- cancel: disarms an armed restart or Go back before it begins.\n' +
  '`version`, with restart or back, is the release you looked at: if the release they would go to is another by ' +
  'then, nothing is armed. With notes, it is the release whose notes you want. Restart and back need the host to ' +
  'run headless with `CONNECTOME_SUPERVISED=1` in its ' +
  'environment when it started. `connectome service install` sets it only for a service that starts the host again ' +
  'when it exits with 75 and with 1, and a service written by hand needs the line and both restarts. Elsewhere they ' +
  'refuse, say why, and arm nothing. After a restart nothing tells you it happened: check says what you run now ' +
  'and how the switch went. ';

const NO_INSTALL_HEADLESS =
  'The person who runs your host can\'t call this tool, so never give them its name or an action of it to type. ' +
  'This host runs headless with no install of its own, so it has no command of theirs to update it: a fleet child is ' +
  'updated with its parent\'s install where its parent has one, and any other host by hand (docs/DEPLOYMENTS.md, ' +
  '"Updating an install"), and your restart and back refuse here, saying so.';

const personHeadless = (command: string): string =>
  'The person who runs your install can\'t call this tool, so never give them its name or an action of it to type. ' +
  'This host runs headless, so their own command for each is typed in a shell, as the user your host runs as: check ' +
  `is \`${command} update check\`, install is \`${command} update install\`, restart is \`${command} update restart\`, ` +
  `and back is \`${command} update back\`, then \`${command} update back keep\` or \`${command} update back restore\`. ` +
  'Their restart and back begin at once, without waiting for a quiet moment: new turns are held, turns in progress ' +
  'get up to 2 min to end, and if any don\'t, their command says who is still busy and how to wait longer, stop now or call ' +
  'it off. notes and cancel have no command of theirs: check gives them a link to the notes, and only your cancel ' +
  'disarms a restart or Go back you armed, though their own restart or back goes ahead in its place.';

const PERSON_IN_A_TERMINAL =
  'The person who runs your install can\'t call this tool, so never give them its name or an action of it to type. ' +
  'This host runs in a terminal, so their own command for each is typed there: check is `/update check`, install is ' +
  '`/update install`, restart is `/update restart`, and back is `/update back`, then `/update back keep` or ' +
  '`/update back restore`. `connectome update` in another shell doesn\'t reach this host. Their restart and back ' +
  'begin at once, without waiting for a quiet moment: new turns are held, turns in progress get up to 2 min to end, ' +
  'and if any don\'t, its answer says who is still busy and how to wait longer, stop now or call it off. Once it ' +
  'stops, they start the host again themselves, and that start switches. notes and cancel have no command of ' +
  'theirs: check gives them a link to the notes, and only your cancel disarms a restart or Go back you armed, ' +
  'though their own restart or back goes ahead in its place.';

function updateTool(headless: boolean, command: string | null): ToolDefinition {
  return {
    name: 'update',
    description: UPDATE_DESCRIPTION + (!headless ? PERSON_IN_A_TERMINAL : command === null ? NO_INSTALL_HEADLESS
      : personHeadless(command)),
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...UPDATE_ACTIONS] },
        version: {
          type: 'string',
          description: 'With restart or back: the exact release you looked at, such as 0.15.0. With notes: the release ' +
            'whose notes you want.',
        },
        data: { type: 'string', enum: ['keep', 'restore'], description: 'With back, and only then: keep or restore.' },
      },
      required: ['action'],
    },
  };
}

export class LifecycleModule implements Module {
  readonly name = 'lifecycle';

  private readonly dataDir: string;
  private readonly cooldownMs: number;
  private readonly timeZone: string;
  private readonly state: SelfRestartState;
  private readonly now: () => Date;
  private readonly hostVersion: string | undefined;
  private readonly selfRestart: boolean;
  private readonly selfUpdate: boolean;
  private readonly update: HostUpdate;
  private readonly headless: boolean;
  private readonly command: string;
  private readonly ownInstall: boolean;

  constructor(config: LifecycleModuleConfig) {
    this.dataDir = config.dataDir;
    this.cooldownMs = (config.cooldownMinutes ?? DEFAULT_SELF_RESTART_COOLDOWN_MINUTES) * 60_000;
    this.timeZone = resolveTimeZone(config.timeZone);
    this.state = config.state ?? processSelfRestart;
    this.now = config.now ?? (() => new Date());
    this.hostVersion = 'hostVersion' in config ? config.hostVersion : readHostVersion();
    this.selfRestart = config.selfRestart ?? true;
    this.selfUpdate = config.selfUpdate ?? false;
    this.update = config.update ?? hostUpdate;
    this.headless = config.headless;
    this.command = config.installCommand ?? 'connectome';
    this.ownInstall = config.installCommand !== undefined;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const record = this.state.takeCompleted(this.dataDir, this.now());
    // agent-framework puts a module's write in the primary's window, which
    // ordinary residents share.
    if (record) ctx.addMessage('user', [{ type: 'text', text: this.backNote(record) }], hostNoteMetadata('restart'));
  }

  async stop(): Promise<void> {}

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  getTools(): ToolDefinition[] {
    return [
      ...(this.selfRestart ? [this.restartTool()] : []),
      ...(this.selfUpdate ? [updateTool(this.headless, this.ownInstall ? this.command : null)] : []),
    ];
  }

  private restartTool(): ToolDefinition {
    return {
      name: 'restart',
      description: TOOL_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Why you are restarting, in a sentence. The line after the restart shows it, and the host\'s data dir keeps it.',
          },
          cancel: {
            type: 'boolean',
            description: 'true disarms a pending restart instead of requesting one; it needs no reason.',
          },
        },
      },
    };
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    if (call.name === 'update' && this.selfUpdate) return this.handleUpdate(call);
    if (call.name !== 'restart' || !this.selfRestart) return unknownToolResult(this, call.name);
    const input = (call.input ?? {}) as { reason?: unknown; cancel?: unknown };
    if (input.cancel !== undefined && typeof input.cancel !== 'boolean') {
      return { success: false, error: '`cancel` must be true or false.', isError: true };
    }

    const caller = call.callerAgentName;

    if (input.cancel === true) {
      const pending = this.state.armedRequest();
      let cancelled: boolean;
      try {
        cancelled = this.state.cancel();
      } catch (err) {
        return {
          success: false,
          isError: true,
          error: `The restart is still armed: its request in the data dir could not be removed (${err instanceof Error ? err.message : String(err)}).`,
        };
      }
      if (!cancelled) {
        const update = this.update.armedSwitch();
        return { success: true, data: update === null
          ? 'No restart was pending, so there was nothing to cancel.'
          : `No plain restart was pending. ${armedName(update)} is armed since ` +
            `${this.when(update.since)}: ${TOOL_CANCEL} disarms it.` };
      }
      return {
        success: true,
        data: `Cancelled the restart ${this.asker(pending!, caller)} asked for at ${this.when(pending!.requestedAt)}. The host won't restart for it.`,
      };
    }

    if (typeof input.reason !== 'string' || input.reason.trim() === '') {
      return { success: false, error: '`reason` is required: say in a sentence why you are restarting.', isError: true };
    }
    const reason = input.reason.trim();

    if (!this.state.isHeadless()) {
      return {
        success: false,
        isError: true,
        error:
          'Nothing was armed: this host is not running in headless mode, so nothing would start it again, ' +
          'and an exit would stop you until someone starts you by hand. Ask an operator to restart you.',
      };
    }

    const pending = this.state.armedRequest();
    if (pending) {
      return {
        success: true,
        data:
          `A restart is already pending, asked for by ${this.asker(pending, caller)} at ${this.when(pending.requestedAt)} ` +
          `(reason: ${pending.reason}). It happens once this turn ends and nothing is in flight. ` +
          '`cancel: true` disarms it.',
      };
    }

    const update = this.update.armedSwitch();
    if (update !== null) {
      return {
        success: false,
        isError: true,
        error: `Nothing was armed: ${armedName(update, false)} is armed since ${this.when(update.since)}, and it restarts ` +
          `the host at a quiet moment. ${TOOL_CANCEL} disarms it, if you'd rather restart without it.`,
      };
    }

    const now = this.now();
    const last = this.state.lastCompleted(this.dataDir);
    if (last && this.cooldownMs > 0) {
      const back = Date.parse(last.backAt);
      if (Number.isFinite(back) && now.getTime() - back < this.cooldownMs) {
        const next = new Date(back + this.cooldownMs);
        return {
          success: false,
          isError: true,
          error:
            `Nothing was armed: the host's last self-restart came back at ${this.when(last.backAt)}, and restarts are ` +
            `at least ${this.cooldownMs / 60_000} minutes apart. The next one can be asked for from ${this.when(next.toISOString())}.`,
        };
      }
    }

    let armed;
    try {
      armed = this.state.arm(this.dataDir, {
        requestedAt: now.toISOString(),
        reason,
        ...(caller ? { requestedBy: caller } : {}),
        ...(this.hostVersion ? { hostVersion: this.hostVersion } : {}),
      });
    } catch (err) {
      return {
        success: false,
        isError: true,
        error: `Nothing was armed: the request could not be written to the data dir (${err instanceof Error ? err.message : String(err)}).`,
      };
    }

    return {
      success: true,
      data:
        `Restart armed at ${this.when(armed.requestedAt)}. It happens once this turn ends and nothing is in flight: ` +
        `the host exits with code ${SELF_RESTART_EXIT_CODE} for whatever supervises it to start it again, and if nothing does, ` +
        'it stays down until someone starts it. With prompt caching on, a restart that picks up changed tools or a ' +
        'changed system prompt writes your prompt cache afresh on your first turn after it. ' +
        'To disarm it before then, call this again with cancel: true.',
    };
  }

  private async handleUpdate(call: ToolCall): Promise<ToolResult> {
    const input = (call.input ?? {}) as { action?: unknown; version?: unknown; data?: unknown };
    const refuse = (error: string): ToolResult => ({ success: false, isError: true, error });
    const unknown = Object.keys(input).filter((key) => !['action', 'version', 'data'].includes(key));
    if (unknown.length > 0) {
      return refuse(`This tool takes \`action\`, \`version\` and \`data\`, not ${unknown.map((key) => `\`${key}\``).join(', ')}, ` +
        'and nothing was done.');
    }
    if (typeof input.action !== 'string' || !(UPDATE_ACTIONS as readonly string[]).includes(input.action)) {
      return refuse(`\`action\` must be one of ${UPDATE_ACTIONS.join(', ')}, and nothing was done.`);
    }
    if (input.version !== undefined && (typeof input.version !== 'string' || !EXACT_VERSION.test(input.version))) {
      return refuse('`version` must be an exact release, such as 0.15.0, and nothing was done.');
    }
    if (input.data !== undefined && input.data !== 'keep' && input.data !== 'restore') {
      return refuse('`data` must be keep or restore, and nothing was done.');
    }
    if (input.version !== undefined && input.action !== 'restart' && input.action !== 'back' && input.action !== 'notes') {
      return refuse(`\`version\` goes with restart, back or notes, not ${input.action}, and nothing was done.`);
    }
    if (input.data !== undefined && input.action !== 'back') {
      return refuse(`\`data\` goes with back, not ${input.action}, and nothing was done.`);
    }
    const version = input.version as string | undefined;
    const by = call.callerAgentName ?? null;
    const plainRestart = (pending: NonNullable<ReturnType<SelfRestartState['armedRequest']>>): string =>
      `a plain restart (lifecycle--restart) is pending, asked for by ${this.asker(pending, call.callerAgentName)} at ` +
      `${this.when(pending.requestedAt)}. It restarts the host once every agent is idle and nothing is in flight, and ` +
      (this.selfRestart ? 'lifecycle--restart with cancel: true disarms it, for an agent given that tool.'
        : 'it isn\'t yours to cancel, since ' +
        'lifecycle--restart isn\'t granted here.');
    const selfRestartPending = (): UpdateAnswer | null => {
      const pending = this.state.armedRequest();
      return pending === null ? null : { done: false, lines: [`Nothing was armed: ${plainRestart(pending)}`] };
    };
    const capital = (line: string) => line.charAt(0).toUpperCase() + line.slice(1);
    let answer: UpdateAnswer;
    switch (input.action as (typeof UPDATE_ACTIONS)[number]) {
      case 'check': {
        await this.update.readRegistry();
        const status = this.update.status();
        const pending = this.state.armedRequest();
        answer = { done: status.check?.ok !== false, lines: [
          ...statusLines(status, toolWays(this.headless, this.command)), ...(pending === null ? [] : [capital(plainRestart(pending))]),
          ...this.update.notesPointer(status.installed),
        ] };
        break;
      }
      case 'notes':
        answer = this.update.installedNotes(version);
        break;
      case 'install':
        answer = await this.update.startInstall(TOOL_WAYS.check);
        break;
      case 'restart':
        answer = selfRestartPending() ?? this.update.armRestart(by, version, toolWays(this.headless, this.command));
        break;
      case 'back':
        answer = input.data === undefined
          ? { done: false, lines: ['Nothing was armed: back needs `data`, keep or restore.',
            ...goBackLines(this.update.status(), toolWays(this.headless, this.command))] }
          : selfRestartPending() ??
            this.update.armGoBack(input.data === 'keep', by, version, toolWays(this.headless, this.command));
        break;
      case 'cancel': {
        const armed = this.update.armedSwitch() !== null;
        answer = await this.update.cancelArmed();
        const pending = this.state.armedRequest();
        if (!armed && pending !== null) answer = { done: true, lines: [...answer.lines, capital(plainRestart(pending))] };
        break;
      }
    }
    const said = inAgentWords(answer.lines.join('\n'));
    const text = this.headless && input.action !== 'notes' ? inShellWords(said, this.command) : said;
    return answer.done ? { success: true, data: text } : refuse(text);
  }

  private when(iso: string): string {
    const d = new Date(iso);
    return Number.isFinite(d.getTime()) ? formatZonedDateTime(d, this.timeZone) : iso;
  }

  private asker(request: SelfRestartRequest, caller?: string): string {
    if (request.requestedBy === undefined) return 'an agent';
    return request.requestedBy === caller ? 'you' : request.requestedBy;
  }

  private backNote(record: SelfRestartRecord): string {
    const who = record.requestedBy ?? 'An agent';
    const asked = `${who} asked for a host restart at ${this.when(record.requestedAt)} (reason: ${record.reason})`;
    const back = `back at ${this.when(record.backAt)}`;
    if (!record.cleanExit) {
      return `[self-restart] ${asked}. The host's exit wasn't recorded (it may have crashed or been killed first); ${back}.`;
    }
    const stopped = record.exitReason && record.exitReason !== 'self-restart'
      ? `the host stopped at ${this.when(record.exitedAt!)} for another reason first (${record.exitReason})`
      : `the host stopped at ${this.when(record.exitedAt!)}`;
    return `[self-restart] ${asked}; ${stopped}; ${back}.`;
  }
}
