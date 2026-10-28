import type {
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
  AgentFramework,
  McplServerConfig,
} from '@animalabs/agent-framework';
import { resolveTimeZone } from '@animalabs/agent-framework';
import {
  DEFAULT_CONFIG_PATH,
  DEFAULT_AGENT_OVERLAY_PATH,
  readMcplServersFile,
  readAgentOverlay,
  saveAgentOverlay,
  resolveOverlayEntry,
  composeOverlay,
  serverProvisions,
  lostByReplacement,
  composeMcplChildEnv,
  cleartextCredential,
  cleartextCarrierText,
  overlayEntryProblem,
  overlayEntryReplaces,
  overlayEntryTombstones,
  hostVariableReferences,
  OverlayUnreadableError,
  NAMES_NOTHING,
  type AgentOverlayEntry,
  type ServerProvisions,
} from '../mcpl-config.js';
import { unknownToolResult } from './unknown-tool.js';
import { shown } from './shown.js';
import { isServerPresentation, SERVER_PRESENTATIONS_TEXT } from '../server-presentation.js';

export interface McplAdminModuleConfig {
  timeZone?: string;
  overlayPath?: string;
  configPath?: string;
}

function ok(text: string): ToolResult {
  return { success: true, data: text };
}

function fail(text: string): ToolResult {
  return { success: false, error: text, isError: true };
}

/** agent-framework prefixes each of the module's tools with its name, so the
 *  agent calls `mcpl-admin--mcpl_list`. */
const MODULE_NAME = 'mcpl-admin';
const tool = (name: string): string => `${MODULE_NAME}--${name}`;
const LIST = tool('mcpl_list');
const DEPLOY = tool('mcpl_deploy');
const RESTART = tool('mcpl_restart');
const UNLOAD = tool('mcpl_unload');

const sentence = (text: string): string => `${text.trim().replace(/\.+$/, '')}.`;
const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

function reasonText(error: unknown): string {
  if (error instanceof OverlayUnreadableError) {
    return `your overlay file, ${error.path}, ` +
      (error.problem === 'not-json' ? 'isn\'t valid JSON' : 'holds null, not an object with mcplServers');
  }
  return error instanceof Error ? error.message : String(error);
}

const REPAIR = 'fix the file (or, if you can\'t edit it, ask your operator to)';
const NOT_ASIDE = 'Don\'t move it aside: the operator\'s servers you unloaded would load again, and your deployments ' +
  'would be dropped.';

function overlayRepair(name?: string): string {
  return `${capital(REPAIR)}${name ? `, then call ${name} again` : ''}. ${NOT_ASIDE}`;
}

/** EMFILE and ENFILE: too many files open, in this process or in the
 *  system. */
const OWN_FAILURES = new Set(['EMFILE', 'ENFILE']);

function readRepair(error: unknown, name?: string): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && OWN_FAILURES.has(code)) {
    return 'This host has too many files open, which can pass: ' + (name
      ? `call ${name} again shortly, and if it fails the same way, ask your operator.`
      : `call ${LIST} shortly to read it, and if it still can't, ask your operator.`);
  }
  return `Ask your operator to fix it${name ? `, then call ${name} again` : ''}.`;
}

/** writeFileSync truncates the file at its open, so a failure after the open
 *  can leave it cut short. */
const BEFORE_WRITE = new Set([
  'EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EROFS', 'ELOOP', 'ENAMETOOLONG', 'EMFILE', 'ENFILE', 'ETXTBSY',
  'EBUSY',
]);

function partway(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && !BEFORE_WRITE.has(code);
}

/** EIO can come from the read before the write, or from the close after the
 *  whole content went out. */
const PARTWAY_TEXT = ' What your overlay file holds now isn\'t known: its old content, the new content whole, or ' +
  `the new content cut short. ${LIST} shows the entries it holds, or why it can't be read. If it says the file ` +
  `isn't valid JSON, the next host start will stop on it until it's fixed: ${REPAIR}. ${NOT_ASIDE}`;

const UNLOAD_REMEDY = `${UNLOAD} unloads it.`;

/** agent-framework's restart reconnects with the configuration stored at the
 *  server's last connect, whether it succeeded or not, so only a deploy
 *  corrects a wrong command, args or url. */
const CONNECT_REMEDY = `If its command, args or url is wrong, call ${DEPLOY} with each of its fields, the wrong one ` +
  `corrected, since a deploy replaces the entry whole; if the server itself needs fixing (its build, say), call ` +
  `${RESTART} once it's fixed. ${UNLOAD_REMEDY}`;

interface CallProgress {
  changed: boolean;
}

export class McplAdminModule implements Module {
  readonly name = MODULE_NAME;

  private framework: AgentFramework | null = null;
  private overlayPath: string;
  private configPath: string;
  private timeZone: string;

  constructor(config?: McplAdminModuleConfig) {
    this.overlayPath = config?.overlayPath ?? DEFAULT_AGENT_OVERLAY_PATH;
    this.configPath = config?.configPath ?? DEFAULT_CONFIG_PATH;
    this.timeZone = resolveTimeZone(config?.timeZone);
  }

  setFramework(framework: AgentFramework): void {
    this.framework = framework;
  }

  private identity: { accessFor(audience?: string): Promise<string> } | null = null;
  setIdentity(identity: { accessFor(audience?: string): Promise<string> } | null): void {
    this.identity = identity;
  }

  private operatorServers = new Map<string, ServerProvisions>();
  private operatorDefinitions: Array<{ id: string } & Record<string, unknown>> = [];
  setOperatorServers(servers: ReadonlyArray<{ id: string } & Record<string, unknown>>): void {
    this.operatorDefinitions = [...servers];
    this.operatorServers = new Map(servers.map((server) => [server.id, serverProvisions(server)]));
  }

  /** How agents are shown a server at first, as configured: by the agent's own
   *  overlay entry where it defines the server (it replaces the operator's
   *  definition whole, so without a presentation it's full), else by the
   *  operator's definition, else in full; unknown while the overlay can't be
   *  read, as its source is. Each agent's own switch since isn't shown. */
  private configuredPresentation(id: string, overlay: Record<string, AgentOverlayEntry> | null): string {
    if (overlay === null) return 'unknown';
    const own = entryOf(overlay, id);
    if (own && overlayEntryReplaces(own)) return isServerPresentation(own.presentation) ? own.presentation : 'full';
    const operator = this.operatorDefinitions.find((d) => d.id === id)?.presentation;
    return isServerPresentation(operator) ? operator : 'full';
  }

  private replacement(id: string, overlay: Record<string, AgentOverlayEntry>): { lost: string | null } | null {
    const entry = entryOf(overlay, id);
    const operator = this.operatorServers.get(id);
    if (!operator || !overlayEntryReplaces(entry)) return null;
    return { lost: lostByReplacement(operator, entry) };
  }

  private skippedAdvice(id: string): string {
    return this.operatorServers.has(id)
      ? `redeploy with ${DEPLOY} to replace it; ${UNLOAD} would tombstone the operator's definition, so it stays unloaded`
      : `redeploy with ${DEPLOY}, or ${UNLOAD} it`;
  }

  private tombstoneAdvice(id: string): string {
    return this.operatorServers.has(id)
      ? `${DEPLOY} would load your own entry in its place, and removing the tombstone from your overlay file (or, if ` +
        'you can\'t edit it, asking your operator to) loads the operator\'s definition again at the next host start'
      : `redeploy with ${DEPLOY} to restore it`;
  }

  private overlayNote(id: string, overlay: Record<string, AgentOverlayEntry>, onDeploy: boolean): string {
    const entry = Object.hasOwn(overlay, id) ? overlay[id] : undefined;
    const problem = entry === undefined ? null : overlayEntryProblem(entry);
    if (problem !== null) {
      return ` Your overlay entry for "${id}" is malformed (${problem}), so the next host start skips it` +
        `${this.operatorServers.has(id) ? ' and loads the operator\'s definition' : ''}; ${this.skippedAdvice(id)}.`;
    }
    if (!onDeploy && overlayEntryTombstones(entry)) {
      return ` Your overlay tombstones "${id}", so the next host start leaves it unloaded; ${this.tombstoneAdvice(id)}.`;
    }
    if (!overlayEntryReplaces(entry)) return '';
    const replacement = this.replacement(id, overlay);
    const refs = hostVariableReferences(entry);
    const literal = refs.length === 0 ? '' :
      `Your entry names a host variable in ${refs.join(', ')}, and only a recipe substitutes those, ` +
      'so the server gets that text as written.';
    const sentences: string[] = [];
    if (replacement?.lost) {
      sentences.push(
        `Your overlay entry replaces the operator's definition of "${id}" and lacks its ${replacement.lost}, ` +
        'so the server, run from your entry, gets none of the operator\'s values for them.',
        literal || 'Naming a host variable in your entry wouldn\'t fill them in, since only a recipe substitutes those.',
        `To go back to the operator's definition, ${UNLOAD} "${id}": that removes your entry, and the ` +
        'operator\'s loads again at the next host start.',
      );
    } else {
      if (replacement && onDeploy) sentences.push(`Your overlay entry replaces the operator's definition of "${id}".`);
      if (literal) {
        sentences.push(literal, 'If the server needs the variable\'s value, ask your operator to add the server to the recipe, ' +
          'which fills host variables in.');
      }
    }
    return sentences.length > 0 ? ` ${sentences.join(' ')}` : '';
  }

  async start(_ctx: ModuleContext): Promise<void> {}

  async stop(): Promise<void> {
    this.framework = null;
  }

  getTools(): ToolDefinition[] {
    return this.definitions();
  }

  /** MCPL administration is rare: its tools live in agent-framework's built-in
   *  toolset ("settings"), out of the tool list. */
  toolPlacement(_toolName: string): 'builtin' {
    return 'builtin';
  }

  private definitions(): ToolDefinition[] {
    return [
      {
        name: 'mcpl_list',
        description:
          'List all MCPL servers: connection/retry state, whether policy was established, ' +
          'the effective grant, masked/denied capability paths, host-command authority, ' +
          'validated manifest revision/fetch/negotiation freshness, tool count, each tool\'s ' +
          'effective class and where it came from, target, and config source.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'mcpl_deploy',
        description:
          'Deploy an MCPL server: persist it to your agent overlay (survives host ' +
          'restarts) and hot-connect it now — its tools become available immediately. ' +
          'If a server with this id is already running it is restarted with the new ' +
          'config. A deploy replaces the server\'s entry whole, so give each of its fields ' +
          'every time, not only the one you change. Provide either `command` (stdio, ' +
          'spawned as the host user) or `url` ' +
          '(WebSocket). Relative ./ args resolve against the host working directory. ' +
          'Sensible defaults: omit (or pass empty) the list fields and every feature ' +
          'set and tool the server offers is available; an empty array means ' +
          '"unspecified", never deny-all. Deny-all for tools is disabledTools: ["*"]; ' +
          'in feature-set patterns `*` matches exactly one dot-separated segment, so ' +
          'deny every set with disabledFeatureSets: ["*", "*.*", "*.*.*"] (names up ' +
          'to three segments). Self-deployed servers get channels + tools ' +
          'only — consequential capabilities (context hooks around your inference, ' +
          'server-initiated inference, inference lifecycle) are host-masked; a server ' +
          'that genuinely needs one is an operator conversation, not a deploy flag.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Unique server id (also the default tool prefix: mcpl--<id>).' },
            command: { type: 'string', description: 'Executable to spawn (stdio transport). Mutually exclusive with url.' },
            args: { type: 'array', items: { type: 'string' }, description: 'Arguments for the command.' },
            env: { type: 'object', description: 'Environment variables for the spawned process.' },
            url: { type: 'string', description: 'WebSocket URL (websocket transport). Mutually exclusive with command. A user, password or `token` parameter in it is a credential, which mcpl_deploy takes only over wss://, or ws:// to this machine (for example, localhost or a loopback address).' },
            token: { type: 'string', description: 'Token for WebSocket auth, sent as the url\'s `token` parameter (only when the operator hands you one — prefer `access`). mcpl_deploy takes it only with a wss:// url, or ws:// to this machine (for example, localhost or a loopback address).' },
            access: { type: 'string', description: 'Name of a host-managed access grant (e.g. "eidoverse"): the host attaches your standing credentials to the connection automatically. Nothing for you to obtain or handle. mcpl_deploy takes it only with a wss:// url, or ws:// to this machine (for example, localhost or a loopback address).' },
            toolPrefix: { type: 'string', description: 'Tool namespace prefix. Default: mcpl--<id>.' },
            reconnect: { type: 'boolean', description: 'Auto-reconnect on transport failure. Default: true for websocket URLs (a bounced server comes back on its own), false for stdio. Note: does NOT respawn a crashed child — use mcpl_restart for that.' },
            enabledFeatureSets: { type: 'array', items: { type: 'string' }, description: 'Feature-set allowlist (* wildcard). Omit or pass [] for all offered.' },
            disabledFeatureSets: { type: 'array', items: { type: 'string' }, description: 'Feature-set deny-list; wins over enabled.' },
            enabledTools: { type: 'array', items: { type: 'string' }, description: 'Tool allow-list (bare names, * wildcard). Omit or pass [] for all offered.' },
            disabledTools: { type: 'array', items: { type: 'string' }, description: 'Tool deny-list; wins over enabledTools.' },
            presentation: {
              type: 'string',
              enum: ['full', 'tab', 'closed-tab'],
              description: 'How you are shown this server. "full" (the default): its tools in your tool list. "tab": ' +
                'connected and its events still arrive, but none of its tools is in your list until you ' +
                'toolsets--open {server}; toolsets--close {server} hides them again. "closed-tab": like a tab, and it ' +
                'starts disconnected whenever the host starts, until you toolsets--open {server}; the deploy itself ' +
                'connects it now. A tab suits a server you use now and then; you can switch later with ' +
                'toolsets--open/--close either way.',
            },
          },
          required: ['id'],
        },
      },
      {
        name: 'mcpl_restart',
        description:
          'Restart an MCPL server: kill the process and respawn it with its current ' +
          'config. Use after rebuilding a server\'s dist, or to recover a crashed ' +
          'server (reconnect:true does not respawn dead children — this does). ' +
          'CAUTION: restarting the server that carries your active conversation ' +
          '(e.g. discord) briefly interrupts your own message delivery; it reconnects ' +
          'within a few seconds.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Server id to restart.' },
          },
          required: ['id'],
        },
      },
      {
        name: 'mcpl_unload',
        description:
          'Unload an MCPL server: disconnect it and remove its tools from your ' +
          'toolset. By default this persists (an unloaded recipe server stays ' +
          'unloaded after host restarts; an agent-deployed server is deleted from ' +
          'your overlay). Pass persist:false to unload for this session only. ' +
          'WARNING: unloading the server that carries your conversation (e.g. ' +
          'discord) cuts your own communication channel — you would need another ' +
          'route (or a human) to get it back.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Server id to unload.' },
            persist: { type: 'boolean', description: 'Persist across host restarts (default true).' },
          },
          required: ['id'],
        },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    const input = (call.input ?? {}) as Record<string, unknown>;
    const progress: CallProgress = { changed: false };
    try {
      switch (call.name) {
        case 'mcpl_list':
          return this.handleList();
        case 'mcpl_deploy':
          return await this.forServer(input, () => this.handleDeploy(input, progress));
        case 'mcpl_restart':
          return await this.forServer(input, () => this.handleRestart(input, progress));
        case 'mcpl_unload':
          return await this.forServer(input, () => this.handleUnload(input, progress));
        default:
          return unknownToolResult(this, call.name);
      }
    } catch (error) {
      if (progress.changed) {
        return fail(
          `${tool(call.name)} failed partway: ${sentence(reasonText(error))} What it changed before then stays ` +
          `changed; ${LIST} shows each server's state.`,
        );
      }
      const failed = call.name === 'mcpl_list' ? 'failed' : 'failed, and nothing was changed';
      return fail(`${tool(call.name)} ${failed}: ${sentence(reasonText(error))}`);
    }
  }

  private readonly serverQueues = new Map<string, Promise<void>>();

  private forServer(input: Record<string, unknown>, work: () => Promise<ToolResult>): Promise<ToolResult> {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id) return work();
    const run = (this.serverQueues.get(id) ?? Promise.resolve()).then(work);
    const tail = run.then(() => undefined, () => undefined);
    this.serverQueues.set(id, tail);
    void tail.then(() => { if (this.serverQueues.get(id) === tail) this.serverQueues.delete(id); });
    return run;
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  private requireFramework(): AgentFramework {
    if (!this.framework) throw new Error('the MCPL admin tools have stopped, so they can\'t act');
    return this.framework;
  }

  private handleList(): ToolResult {
    const framework = this.requireFramework();
    const live = framework.listMcplServers() as Array<
      ReturnType<AgentFramework['listMcplServers']>[number] & {
        retrying?: boolean;
        policyEstablished?: boolean;
        effectiveGrant?: string[];
        maskedCapabilities?: string[];
        deniedCapabilities?: string[];
        allowHostCommands?: boolean;
        manifestState?: {
          lastValidatedRevision: string | null;
          lastFetchedAt: number | null;
          lastNegotiatedAt: number | null;
        };
        toolClasses?: ServerToolClass[];
        /** agent-framework 0.29: kept disconnected as a closed tab until it's opened. */
        closedTab?: boolean;
      }
    >;
    const notes: string[] = [];
    let overlay: Record<string, AgentOverlayEntry> | null = null;
    try {
      overlay = readAgentOverlay(this.overlayPath);
    } catch (error) {
      notes.push(capital(this.unusableOverlay(error, 'this list can\'t show your overlay\'s own entries, or which servers they define')));
    }
    let fileServers: ReturnType<typeof readMcplServersFile> | null = null;
    try {
      fileServers = readMcplServersFile(this.configPath);
    } catch (error) {
      const system = typeof (error as { code?: unknown } | null)?.code === 'string';
      notes.push(
        `The operator's server file${system ? `, ${this.configPath},` : ''} couldn't be read (${reasonText(error)}), so ` +
        'this list can\'t show which servers it defines. The next host start will stop on the file ' +
        `${system ? 'while it can\'t be read' : 'until it\'s fixed'}, before it loads any server, so what this list says ` +
        'a start loads holds once a start gets past the file, if the file still defines what it did at this host\'s ' +
        `start. ${system ? readRepair(error) : 'It\'s theirs to fix, so ' +
        'ask your operator.'} Of these tools, only this listing reads it.`,
      );
    }

    const lines: string[] = [];
    for (const s of live) {
      let source: string;
      if (overlay === null) {
        source = 'unknown';
      } else if (overlayEntryReplaces(entryOf(overlay, s.id))) {
        const replacement = this.replacement(s.id, overlay);
        source = replacement
          ? `agent-overlay (replaces the operator's definition${replacement.lost ? `; lacks its ${replacement.lost}` : ''})`
          : 'agent-overlay';
      } else {
        source = fileServers === null ? 'unknown' : Object.hasOwn(fileServers, s.id) ? 'file/recipe' : 'recipe';
      }
      const target = s.command ?? s.url ?? '?';
      const connectionState = s.closedTab
        ? `CLOSED TAB (disconnected until it's opened: toolsets--open {"server": "${s.id}"}, or ${RESTART} connects it)`
        : s.connected ? 'CONNECTED' : s.retrying ? 'RETRYING' : 'DISCONNECTED';
      const policyState = s.policyEstablished === undefined
        ? 'unknown'
        : s.policyEstablished ? 'established' : 'not-established';
      const hostCommands = s.allowHostCommands === undefined
        ? 'unknown'
        : s.allowHostCommands ? 'allow' : 'deny';
      lines.push(
        `${s.id}: ${connectionState} — policy=${policyState}, ` +
        `grant=${formatCapabilityList(s.effectiveGrant)}, ` +
        `masked=${formatCapabilityList(s.maskedCapabilities)}, ` +
        `denied=${formatCapabilityList(s.deniedCapabilities)}, ` +
        `hostCommands=${hostCommands}, ` +
        `manifest=${formatManifestState(s.manifestState)}; ${s.toolCount} tools, ` +
        `classes=${formatServerToolClasses(s.toolClasses)}, ` +
        `presentation=${this.configuredPresentation(s.id, overlay)}, ` +
        `prefix=${s.toolPrefix}, source=${source}, ${target}`,
      );
    }

    const liveIds = new Set(live.map(s => s.id));
    for (const [id, entry] of Object.entries(overlay ?? {})) {
      const problem = overlayEntryProblem(entry);
      if (problem !== null) {
        lines.push(
          `${id}: MALFORMED in your overlay (${problem}), so the boot skips it` +
          `${this.operatorServers.has(id) ? ' and loads the operator\'s definition' : ''} — ${this.skippedAdvice(id)}`,
        );
      } else if (overlayEntryTombstones(entry)) {
        lines.push(liveIds.has(id)
          ? `${id}: TOMBSTONED in your overlay, still connected this session; the next host start leaves it unloaded — ${this.tombstoneAdvice(id)}`
          : `${id}: UNLOADED (tombstoned in your overlay — ${this.tombstoneAdvice(id)})`);
      } else if (!liveIds.has(id)) {
        lines.push(
          `${id}: NOT LOADED (in your overlay but not connected: the next host start loads it, and ${DEPLOY} with each ` +
          'of its fields loads it now, since a deploy replaces the entry whole)',
        );
      }
    }

    const closing = notes.map((n) => `\n${n}`).join('');
    if (lines.length === 0) {
      return ok(`No MCPL servers are loaded.${overlay ? ` Use ${DEPLOY} to add one.` : ''}${closing}`);
    }
    return ok(`MCPL servers (${lines.length}):\n` + lines.map(l => `  ${l}`).join('\n') + closing);
  }

  private declared(name: string): string[] {
    return Object.keys((this.definitions().find((d) => d.name === name)!.inputSchema as { properties: object }).properties);
  }

  private undeclared(name: string, input: Record<string, unknown>): { keys: string[]; text: string } | null {
    const declared = this.declared(name);
    const keys = Object.keys(input).filter((k) => input[k] !== undefined && !declared.includes(k));
    if (keys.length === 0) return null;
    return {
      keys,
      text: `${keys.map((k) => JSON.stringify(k)).join(', ')} ${keys.length === 1 ? 'isn\'t a field' : 'aren\'t fields'} ` +
        `of ${tool(name)}, which takes ${declared.join(', ')}.`,
    };
  }

  private async handleDeploy(input: Record<string, unknown>, progress: CallProgress): Promise<ToolResult> {
    const framework = this.requireFramework();
    const problems: string[] = [];
    const undeclared = this.undeclared('mcpl_deploy', input);
    if (undeclared) problems.push(undeclared.text);
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    let idOk = false;
    if (!id) {
      problems.push(
        '`id` is missing or empty, or isn\'t text: give the server\'s name as text, such as "my-server", in letters, ' +
        'digits, _ and -, since it becomes part of its tools\' names.',
      );
    } else if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      const cleaned = id.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
      problems.push(
        `The id ${JSON.stringify(id)} has characters other than letters, digits, _ and -, and it becomes part of ` +
        `tool names: use one such as ${JSON.stringify(cleaned && cleaned !== '__proto__' ? cleaned : 'my-server')}.`,
      );
    } else if (id === '__proto__') {
      // `overlay["__proto__"] = entry` sets the overlay's prototype.
      problems.push(
        '"__proto__" can\'t be a server id, since JavaScript reads it as an object\'s prototype rather than a name: ' +
        'choose another.',
      );
    } else {
      idOk = true;
    }

    const given = (v: unknown): boolean => v !== undefined && v !== null;
    const givenText = (v: unknown): boolean => given(v) && !(typeof v === 'string' && v.trim() === '');
    const givenList = (v: unknown): boolean => given(v) && !(Array.isArray(v) && v.length === 0);
    const list = (v: unknown): unknown =>
      Array.isArray(v) ? v.map((x) => (typeof x === 'number' || typeof x === 'boolean' ? String(x) : x)) : v;

    const command = givenText(input.command) ? input.command : undefined;
    const url = givenText(input.url) ? input.url : undefined;
    if (command === undefined && url === undefined) {
      problems.push(
        'Neither `command` nor `url` was given, or both were empty: give `command`, the executable to spawn for a ' +
        'stdio server, or `url`, the ws:// or wss:// address of a WebSocket server.',
      );
    } else if (command !== undefined && url !== undefined) {
      problems.push(
        'Both `command` and `url` were given: give one, since a server is either spawned from a command (stdio) or ' +
        'dialled at a url (WebSocket).',
      );
    }
    if (typeof url === 'string') {
      let scheme: string | null = null;
      try {
        scheme = new URL(url).protocol;
      } catch {
      }
      if (scheme !== 'ws:' && scheme !== 'wss:') {
        problems.push(
          `\`url\` ${scheme === null ? 'doesn\'t parse as a url' : `begins ${JSON.stringify(scheme)}, not ws: or wss:`}. ` +
          'Give the server\'s ws:// or wss:// address.',
        );
      }
    }

    const fields: Record<string, unknown> = {};
    if (command !== undefined) fields.command = command;
    if (url !== undefined) { fields.url = url; fields.transport = 'websocket'; }
    if (givenList(input.args)) fields.args = list(input.args);
    if (givenList(input.env)) fields.env = input.env;
    if (givenText(input.token)) fields.token = input.token;
    if (typeof input.access === 'string' ? input.access.trim() !== '' : given(input.access)) {
      if (typeof input.access === 'string' && !this.identity) {
        problems.push(
          '`access` names a host-managed access grant, but this host has no identity configured to supply its ' +
          'credential: leave `access` out, give the server\'s `token` instead (taken only over wss://, or ws:// to ' +
          'this machine), or ask your operator to enable identity (recipe `identity`).',
        );
      } else {
        fields.access = typeof input.access === 'string' ? input.access.trim() : input.access;
      }
    }
    if (givenText(input.toolPrefix)) fields.toolPrefix = input.toolPrefix;
    if (given(input.reconnect)) fields.reconnect = input.reconnect;
    for (const k of ['enabledFeatureSets', 'disabledFeatureSets', 'enabledTools', 'disabledTools']) {
      if (givenList(input[k])) fields[k] = list(input[k]);
    }
    if (givenText(input.presentation)) {
      if (isServerPresentation(input.presentation)) fields.presentation = input.presentation;
      else {
        problems.push(
          `\`presentation\` is ${JSON.stringify(input.presentation)}, which isn't ${SERVER_PRESENTATIONS_TEXT}: leave it out ` +
          'for "full", the default.',
        );
      }
    }

    const problem = overlayEntryProblem(fields, { strict: true });
    const malformed = problem !== null && problem !== NAMES_NOTHING;
    if (malformed) problems.push(`The entry would be malformed: ${problem}.`);

    let overlay: Record<string, AgentOverlayEntry>;
    try {
      overlay = readAgentOverlay(this.overlayPath);
    } catch (error) {
      return fail(`Nothing was deployed or saved: ${this.unusableOverlay(error, 'your entry can\'t be saved in it', DEPLOY)}`);
    }
    if (typeof fields.toolPrefix === 'string' || (idOk && fields.toolPrefix === undefined)) {
      const prefix = typeof fields.toolPrefix === 'string' ? fields.toolPrefix : `mcpl--${id}`;
      const holder = this.prefixHolder(framework, id, prefix, overlay);
      if (holder) {
        problems.push(
          `Its tool prefix "${prefix}"${fields.toolPrefix === undefined ? ', the default for this id,' : ''} is ` +
          `${holder}, and agent-framework refuses a prefix two hold: give \`toolPrefix\` a name of its own.`,
        );
      }
    }
    if (problems.length > 0) {
      return fail(
        `Nothing was deployed or saved: ${problems.join(' ')} Correct ${problems.length === 1 ? 'it' : 'each'}` +
        `${malformed ? ' (or leave out a field the server can do without)' : ''} and call ${DEPLOY} again.`,
      );
    }
    const entry = fields as AgentOverlayEntry;

    const cleartext = cleartextCredential(entry);
    if (cleartext) {
      const configured = framework.listMcplServers().some(s => s.id === id);
      return fail(
        `Nothing was deployed: ${cleartextCarrierText(cleartext.carrier, entry.access)} would go to ${cleartext.host} ` +
        'over unencrypted ws://, where anyone on the network between can read it, so nothing was saved.' +
        (configured ? ` The server already configured as "${id}" is unchanged.` : '') +
        ' Use a wss:// url, or, if that network is private, ask your operator to add the server to the recipe.',
      );
    }

    overlay[id] = entry;
    progress.changed = true;
    try {
      saveAgentOverlay(this.overlayPath, overlay);
    } catch (error) {
      // Bun's errors from the write itself (ENOSPC, say) name no file.
      const cut = partway(error);
      return fail(
        `${cut ? 'Saving' : 'Nothing was deployed: saving'} your overlay file, ${this.overlayPath}, failed ` +
        `(${reasonText(error)}), so no server was connected or restarted. ` +
        (cut
          ? `Once that's fixed, call ${DEPLOY} again; if you can't fix it, ask your operator.${PARTWAY_TEXT}`
          : readRepair(error, DEPLOY)),
      );
    }

    const config = resolveOverlayEntry(id, entry) as unknown as McplServerConfig;
    // agent-framework adds its reaction-suppression default to a stdio child's
    // env unless the env declares a baseline.
    config.env = composeMcplChildEnv(config.env as Record<string, string> | undefined, this.timeZone);
    if (entry.access && this.identity) {
      const identity = this.identity;
      const audience = entry.access;
      // agent-framework calls accessProvider at every dial.
      config.accessProvider = () => identity.accessFor(audience);
    }

    const alreadyLoaded = framework.listMcplServers().some(s => s.id === id);
    const note = this.overlayNote(id, overlay, true);
    try {
      if (alreadyLoaded) {
        await framework.restartMcplServer(id, config);
      } else {
        await framework.connectMcplServer(config);
      }
    } catch (error) {
      return fail(
        `Server "${id}" was saved to your overlay, but ${alreadyLoaded ? 'restarting it with that entry' : 'connecting it'} ` +
        `failed: ${sentence(reasonText(error))} ${this.afterFailure(framework, id, false)}${note}`,
      );
    }

    const status = framework.listMcplServers().find(s => s.id === id);
    if (!status?.connected) {
      return fail(
        `Server "${id}" was saved to your overlay, but it isn't connected` +
        `${status?.retrying ? `; it keeps retrying on its own, so it may still connect, which ${LIST} shows` : ''}. ` +
        `${CONNECT_REMEDY}${note}`,
      );
    }
    return ok(
      `${alreadyLoaded ? 'Redeployed' : 'Deployed'} server "${id}" — connected, ` +
      `${status.toolCount} tools under prefix ${status.toolPrefix}. ` +
      `Persisted to your agent overlay (survives host restarts).${note}`,
    );
  }

  private async handleRestart(input: Record<string, unknown>, progress: CallProgress): Promise<ToolResult> {
    const framework = this.requireFramework();
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    const problems: string[] = [];
    if (!id) problems.push(`${RESTART} needs \`id\` as text, the server's id as ${LIST} shows it.`);
    const undeclared = this.undeclared('mcpl_restart', input);
    if (undeclared) {
      const forDeploy = undeclared.keys.filter((k) => this.declared('mcpl_deploy').includes(k));
      problems.push(undeclared.text + (forDeploy.length === 0 ? '' :
        ` ${DEPLOY} takes ${forDeploy.join(', ')}: deploy the server again, with each of its fields, to change ` +
        `${forDeploy.length === 1 ? 'it' : 'them'}.`));
    }
    if (problems.length > 0) return fail(`Nothing was restarted: ${problems.join(' ')}`);

    let overlay: Record<string, AgentOverlayEntry> | null = null;
    let unreadable = '';
    try {
      overlay = readAgentOverlay(this.overlayPath);
    } catch (error) {
      unreadable = ` ${capital(this.unusableOverlay(
        error, `nothing is said here about your entry, and ${DEPLOY} and an ${UNLOAD} that persists are refused`,
      ))}`;
    }
    // agent-framework restarts only a server it holds a configuration for, and
    // listMcplServers lists exactly those.
    const loaded = framework.listMcplServers().map((s) => s.id);
    if (!loaded.includes(id)) {
      return fail(
        `Nothing was restarted: no server "${id}" is loaded in this session. ` +
        `${loaded.length > 0 ? `Loaded: ${loaded.map((s) => `"${s}"`).join(', ')}.` : 'None is loaded.'}` +
        `${overlay ? this.notLoadedAdvice(id, overlay) : unreadable}`,
      );
    }
    let note = unreadable;
    if (overlay) {
      note = this.overlayNote(id, overlay, false);
      if (note && overlayEntryReplaces(entryOf(overlay, id))) {
        note += ' That describes your overlay file as it is now. The restart reconnects with the configuration of the ' +
          `server's last connect, at this host's start or your last ${DEPLOY} of it, so a hand edit made since then ` +
          `takes effect at the next host start, unless a later ${DEPLOY} replaces it.`;
      }
    }
    progress.changed = true;
    try {
      await framework.restartMcplServer(id);
    } catch (error) {
      return fail(
        `The restart of "${id}" didn't complete: ${sentence(reasonText(error))} ` +
        `${this.afterFailure(framework, id, true, overlay ?? undefined)}${note}`,
      );
    }
    const status = framework.listMcplServers().find(s => s.id === id);
    if (!status?.connected) {
      return fail(
        `Restarted server "${id}", but it isn't connected` +
        `${status?.retrying ? `; it keeps retrying on its own, so it may still connect, which ${LIST} shows` : ''}. ` +
        `${this.restartRemedy(id, overlay)}${note}`,
      );
    }
    return ok(`Restarted server "${id}" — connected, ${status.toolCount} tools.${note}`);
  }

  private afterFailure(
    framework: AgentFramework,
    id: string,
    restart: boolean,
    restartOf?: Record<string, AgentOverlayEntry>,
  ): string {
    let status: { connected: boolean; retrying: boolean } | undefined;
    try {
      status = framework.listMcplServers().find((s) => s.id === id);
    } catch {
      return `What state it's in now couldn't be read: ${LIST} shows it, and if that fails too, ask your operator.`;
    }
    if (status?.connected) {
      return restart
        ? `It's still running as it was: once the cause is fixed, call ${RESTART} again.`
        : 'It\'s still running its previous configuration: your new entry is saved, and the next host start loads ' +
          `it, but it isn't in effect now. Once the cause is fixed, call ${DEPLOY} again to apply it.`;
    }
    if (!status) {
      if (restart) {
        return `It isn't loaded in this session any more, so ${RESTART} can't reach it.` +
          (restartOf
            ? this.notLoadedAdvice(id, restartOf, false)
            : this.operatorServers.has(id)
              ? ` Which defines it isn't known while your overlay file can't be read. Once it can, ${LIST} shows ` +
                `your own entry for it, if there is one, which ${DEPLOY} with each of its fields loads again; ` +
                'otherwise your operator\'s definition loads again at the next host start, unless your overlay ' +
                `unloads it, and ${DEPLOY} would load your own entry in its place.`
              : ` ${DEPLOY} with each of its fields can load it again once your overlay file can be read, since a ` +
                'deploy replaces the entry whole.');
      }
      return `It isn't loaded in this session, so ${RESTART} can't reach it. Your entry is saved, so the next host ` +
        `start loads it; once the cause is fixed, call ${DEPLOY} again to load it now. ${UNLOAD} removes the saved ` +
        'entry.';
    }
    const retrying = status.retrying ? `; it keeps retrying on its own, so it may still connect, which ${LIST} shows` : '';
    if (restart) return `It isn't connected${retrying}. ${this.restartRemedy(id, restartOf ?? null)}`;
    return `It isn't connected${retrying}. Your entry is saved, and the next host start loads it; once the cause is ` +
      `fixed, call ${DEPLOY} again to apply it now. ${UNLOAD_REMEDY}`;
  }

  /** agent-framework's create() refuses a tool prefix two holders share, so the
   *  next start would stop on it; connectMcplServer refuses it too, but only
   *  after the save. */
  private prefixHolder(
    framework: AgentFramework,
    id: string,
    prefix: string,
    overlay: Record<string, AgentOverlayEntry>,
  ): string | null {
    if (framework.getModule(prefix)) return `the name of the host's module "${prefix}"`;
    const prefixOf = (s: { id: string; toolPrefix?: unknown }): string =>
      typeof s.toolPrefix === 'string' ? s.toolPrefix : `mcpl--${s.id}`;
    const others = Object.fromEntries(Object.entries(overlay).filter(([key]) => key !== id));
    const nextStart = composeOverlay(this.operatorDefinitions, others);
    const other = [...nextStart, ...framework.listMcplServers()].find((s) => s.id !== id && prefixOf(s) === prefix);
    return other ? `held by server "${other.id}"` : null;
  }

  private restartRemedy(id: string, overlay: Record<string, AgentOverlayEntry> | null): string {
    const unload = overlay === null ? `${UNLOAD} with \`persist: false\` unloads it for this session.` : UNLOAD_REMEDY;
    const rebuilt = `if the server itself needs fixing (its build, say), call ${RESTART} once it's fixed. ${unload}`;
    const unseen = `its args and env aren't shown to you, and ${DEPLOY} would replace it whole with your own entry`;
    if (overlay === null) {
      return this.operatorServers.has(id)
        ? `If its command, args or url is wrong, what corrects it depends on which defines it, which ${LIST} shows ` +
          `once your overlay file can be read: your own entry takes ${DEPLOY} with each of its fields; your ` +
          `operator's definition is theirs to correct, so ask them, since ${unseen}. ${capital(rebuilt)}`
        : `If its command, args or url is wrong, ${DEPLOY} with each of its fields corrects it once your overlay ` +
          `file can be read; ${rebuilt}`;
    }
    if (!overlayEntryReplaces(entryOf(overlay, id)) && this.operatorServers.has(id)) {
      return `If its command, args or url is wrong, that's your operator's definition to correct, so ask them: ${unseen}; ` +
        rebuilt;
    }
    return CONNECT_REMEDY;
  }

  private notLoadedAdvice(id: string, overlay: Record<string, AgentOverlayEntry>, note = true): string {
    const entry = entryOf(overlay, id);
    if (entry !== undefined && (overlayEntryProblem(entry) !== null || overlayEntryTombstones(entry))) {
      return note ? this.overlayNote(id, overlay, false) : '';
    }
    if (overlayEntryReplaces(entry)) {
      return ` Your overlay has an entry for "${id}", so the next host start loads it; ${DEPLOY} with each of its ` +
        'fields loads it now, since a deploy replaces the entry whole.';
    }
    if (this.operatorServers.has(id)) {
      return ` Your operator defines "${id}", so the next host start loads it again; ${DEPLOY} would load your own ` +
        'entry in its place now.';
    }
    return ` Neither your overlay nor your operator defines "${id}".`;
  }

  private unusableOverlay(error: unknown, so?: string, again?: string): string {
    const unreadable = error instanceof OverlayUnreadableError;
    return `${unreadable ? reasonText(error) : `your overlay file, ${this.overlayPath}, couldn't be read (${reasonText(error)})`}` +
      `${so ? `, so ${so}` : ''}. The next host start will stop on the file ` +
      `${unreadable ? 'until it\'s fixed' : 'while it can\'t be read'}. ` +
      (unreadable ? overlayRepair(again) : readRepair(error, again));
  }

  private nextStart(id: string, overlay: Record<string, AgentOverlayEntry>): string {
    const entry = entryOf(overlay, id);
    if (overlayEntryTombstones(entry)) return 'your overlay tombstones it, so the next host start leaves it unloaded.';
    if (overlayEntryReplaces(entry)) return 'your overlay entry loads it again at the next host start.';
    if (this.operatorServers.has(id)) return 'the operator\'s definition loads it again at the next host start.';
    return 'nothing loads it at the next host start.';
  }

  private async handleUnload(input: Record<string, unknown>, progress: CallProgress): Promise<ToolResult> {
    const framework = this.requireFramework();
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    const problems: string[] = [];
    if (!id) problems.push(`${UNLOAD} needs \`id\` as text, the server's id as ${LIST} shows it.`);
    // `overlay["__proto__"] = …` would set the prototype.
    if (id === '__proto__') {
      problems.push(
        'your overlay can\'t record "__proto__", which JavaScript reads as an object\'s prototype rather than a name, ' +
        'so no server by that id can be unloaded here.',
      );
    }
    const undeclared = this.undeclared('mcpl_unload', input);
    if (undeclared) problems.push(undeclared.text);
    if (input.persist !== undefined && input.persist !== null && typeof input.persist !== 'boolean') {
      problems.push(`\`persist\` is true or false, not ${shown(input.persist)}.`);
    }
    if (problems.length > 0) return fail(`Nothing was unloaded: ${problems.join(' ')}`);
    const persist = input.persist !== false;

    const loaded = framework.listMcplServers().map((s) => s.id);
    const known = loaded.includes(id);
    const operator = this.operatorServers.has(id);
    const loadedText = loaded.length > 0 ? `Loaded: ${loaded.map((s) => `"${s}"`).join(', ')}.` : 'None is loaded.';
    let read: { overlay: Record<string, AgentOverlayEntry> } | { error: unknown };
    try {
      read = { overlay: readAgentOverlay(this.overlayPath) };
    } catch (error) {
      read = { error };
    }
    if ('error' in read) {
      if (!known && !operator) {
        return fail(
          `Nothing was unloaded: no server "${id}" is loaded or defined by your operator. ${loadedText} ` +
          capital(this.unusableOverlay(read.error, `whether it names "${id}" isn't known`, `${UNLOAD} "${id}"`)),
        );
      }
      if (persist) {
        return fail(
          'Nothing was unloaded: ' +
          this.unusableOverlay(read.error, 'the unload can\'t be recorded in it', `${UNLOAD} "${id}"`) +
          (known ? ` To stop "${id}" for this session in the meantime, call ${UNLOAD} with \`persist: false\`.` : ''),
        );
      }
    } else if (!known && !operator && entryOf(read.overlay, id) === undefined) {
      return fail(`Nothing was unloaded: no server "${id}" is loaded, defined by your operator, or in your overlay. ${loadedText}`);
    }

    if (known) {
      progress.changed = true;
      try {
        await framework.disconnectMcplServer(id);
      } catch (error) {
        return fail(
          `Server "${id}" couldn't be disconnected: ${sentence(reasonText(error))} It may still be loaded in this ` +
          `session, and this unload changed nothing in your overlay. ${LIST} shows whether it's loaded; call ` +
          `${UNLOAD} "${id}" again to retry.`,
        );
      }
    }
    const head = known
      ? `Unloaded server "${id}" — its tools are gone from your toolset.`
      : `Server "${id}" wasn't loaded in this session.`;
    if ('error' in read) return ok(`${head} Session-only. ${capital(this.unusableOverlay(read.error))}`);
    const overlay = read.overlay;
    if (!persist) return ok(`${head} Session-only: ${this.nextStart(id, overlay)}`);

    progress.changed = true;
    let held: Record<string, AgentOverlayEntry>;
    try {
      held = known ? readAgentOverlay(this.overlayPath) : overlay;
    } catch (error) {
      return fail(`${head} But ${this.unusableOverlay(error, 'the unload isn\'t recorded', `${UNLOAD} "${id}"`)}`);
    }
    const current = { ...held };
    try {
      const entry = entryOf(current, id);
      if (overlayEntryReplaces(entry) || (entry !== undefined && !operator && overlayEntryProblem(entry) !== null)) {
        const restores = operator && overlayEntryReplaces(entry);
        delete current[id];
        saveAgentOverlay(this.overlayPath, current);
        return ok(`${head} ${restores
          ? `Removed from your agent overlay; the operator's definition of "${id}" loads again at the next host start.`
          : 'Removed from your agent overlay.'}`);
      }
      current[id] = { disabled: true };
      saveAgentOverlay(this.overlayPath, current);
      return ok(`${head} Tombstoned in your overlay — it stays unloaded across host restarts; ${this.tombstoneAdvice(id)}.`);
    } catch (error) {
      // Bun's errors from the write itself (ENOSPC, say) name no file.
      return fail(
        `${head} ${partway(error)
          ? `But saving your overlay file, ${this.overlayPath}, failed (${reasonText(error)}).${PARTWAY_TEXT} If the ` +
            `file doesn't hold the unload, ${UNLOAD} "${id}" again records it once the file can be read and written.`
          : `But your overlay file, ${this.overlayPath}, couldn't be updated (${reasonText(error)}), so the unload isn't ` +
            `recorded: ${this.nextStart(id, held)} ${readRepair(error, `${UNLOAD} "${id}"`)}`}`,
      );
    }
  }
}

function entryOf(overlay: Record<string, AgentOverlayEntry>, id: string): AgentOverlayEntry | undefined {
  return Object.hasOwn(overlay, id) ? overlay[id] : undefined;
}

/** One of a server's tools with its effective class (MCPL RFC-008 §5-6). */
interface ServerToolClass {
  tool: string;
  serverTool: string;
  class: string[];
  source: 'override' | 'host' | 'server' | 'none';
}

/** Sources: `server` is the server's own `_meta["mcpl/class"]`, `override`
 *  the operator's recipe override; agent-framework never shows an unclassed
 *  tool's arguments to lifecycle observers. */
function formatServerToolClasses(rows: ServerToolClass[] | undefined): string {
  if (rows === undefined) return 'unknown';
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    const key = r.class.length === 0 ? 'unclassed' : `${r.class.join('+')}/${r.source}`;
    const names = groups.get(key) ?? [];
    names.push(r.serverTool || r.tool);
    groups.set(key, names);
  }
  const parts = [...groups.entries()].map(([key, names]) => `${key}: ${names.join(',')}`);
  return `{${parts.join('; ')}}`;
}

function formatCapabilityList(paths: string[] | undefined): string {
  if (paths === undefined) return 'unknown';
  return `[${paths.join(',')}]`;
}

function formatManifestState(state: {
  lastValidatedRevision: string | null;
  lastFetchedAt: number | null;
  lastNegotiatedAt: number | null;
} | undefined): string {
  if (state === undefined) return 'unknown';
  return `{revision=${formatManifestRevision(state.lastValidatedRevision)},` +
    `fetchedAt=${formatManifestTimestamp(state.lastFetchedAt)},` +
    `negotiatedAt=${formatManifestTimestamp(state.lastNegotiatedAt)}}`;
}

/** The manifest revision is an opaque, server-authored string (MCPL RFC-003
 *  §3). */
function formatManifestRevision(revision: string | null): string {
  if (revision === null) return 'none';
  const bounded = revision.length <= 64 ? revision : `${revision.slice(0, 61)}...`;
  return JSON.stringify(bounded);
}

function formatManifestTimestamp(timestamp: number | null): string {
  if (timestamp === null) return 'none';
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? 'invalid' : date.toISOString();
}
