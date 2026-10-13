/**
 * McplAdminModule — lets the agent deploy, restart, and unload its own MCPL
 * servers at runtime, without a host restart.
 *
 * Tools:
 *   - mcpl_list                → configured servers + live connection status
 *   - mcpl_deploy {id, ...}    → add/update a server and hot-connect it
 *   - mcpl_restart {id}        → kill + respawn a server (picks up rebuilt dist)
 *   - mcpl_unload {id}         → disconnect a server and remove its tools
 *
 * Persistence model (agent overlay):
 *   Agent deployments are written to `mcpl-servers.agent.json` (cwd), which
 *   index.ts merges over the recipe/file server list at startup — so agent
 *   deployments survive host restarts without touching human-owned recipe
 *   files or mcpl-servers.json. Unloading a recipe/file server writes a
 *   `{disabled: true}` tombstone to the overlay; unloading an agent-deployed
 *   server just deletes its overlay entry.
 *
 * Security: enabling this module in a recipe grants the agent the ability to
 * spawn arbitrary commands as the host user (mcpl_deploy). Recipe opt-in
 * (`modules: { mcplAdmin: true }`) is the permission gate.
 */

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
  serverProvisions,
  lostByReplacement,
  composeMcplChildEnv,
  cleartextCredential,
  cleartextCarrierText,
  overlayEntryProblem,
  overlayEntryReplaces,
  overlayEntryTombstones,
  hostVariableReferences,
  type AgentOverlayEntry,
  type ServerProvisions,
} from '../mcpl-config.js';

export interface McplAdminModuleConfig {
  /** IANA zone propagated to newly deployed stdio servers. */
  timeZone?: string;
  /** Path to the agent overlay file. Default: `mcpl-servers.agent.json` in cwd. */
  overlayPath?: string;
  /** Path to the human-owned server config file (read-only here). */
  configPath?: string;
  /** Where these operations surface to the model: 'tools' (default — four
   *  first-class slots, exactly the historical behavior) or 'utilities'
   *  (behind the framework's single `utils` meta-tool: mcpl management is a
   *  rare operation and needn't tax every inference with four schemas). */
  surface?: 'tools' | 'utilities';
}

function ok(text: string): ToolResult {
  return { success: true, data: text };
}

function fail(text: string): ToolResult {
  return { success: false, error: text, isError: true };
}

export class McplAdminModule implements Module {
  readonly name = 'mcpl-admin';

  private framework: AgentFramework | null = null;
  private overlayPath: string;
  private configPath: string;
  private timeZone: string;

  private surface: 'tools' | 'utilities';

  constructor(config?: McplAdminModuleConfig) {
    this.overlayPath = config?.overlayPath ?? DEFAULT_AGENT_OVERLAY_PATH;
    this.configPath = config?.configPath ?? DEFAULT_CONFIG_PATH;
    this.timeZone = resolveTimeZone(config?.timeZone);
    this.surface = config?.surface ?? 'tools';
  }

  /** Post-creation wiring (called from index.ts, mirrors ActivityModule.setFramework). */
  setFramework(framework: AgentFramework): void {
    this.framework = framework;
  }

  /** Optional identity plumbing (index.ts wires it when the recipe enables
   *  the identity module): lets deployed servers name an `access` grant that
   *  the host turns into a per-dial credential provider. The agent names the
   *  access; credentials never surface. */
  private identity: { accessFor(audience?: string): Promise<string> } | null = null;
  setIdentity(identity: { accessFor(audience?: string): Promise<string> } | null): void {
    this.identity = identity;
  }

  /** The operator's server definitions (recipe and mcpl-servers.json, before
   *  the agent overlay), by what an overlay entry replacing one can lose:
   *  names only, never a credential. index.ts wires it; without it, no
   *  receipt can say what a replacement lacks. */
  private operatorServers = new Map<string, ServerProvisions>();
  setOperatorServers(servers: ReadonlyArray<{ id: string } & Record<string, unknown>>): void {
    this.operatorServers = new Map(servers.map((server) => [server.id, serverProvisions(server)]));
  }

  /**
   * How `id`'s overlay entry stands against the operator's definition it
   * replaces: null when it replaces none, else what it lacks of it (null
   * when nothing). An overlay entry replaces the definition whole, and it
   * can't name host variables, so what it lacks the server runs without.
   */
  private replacement(id: string, overlay: Record<string, AgentOverlayEntry>): { lost: string | null } | null {
    const entry = entryOf(overlay, id);
    const operator = this.operatorServers.get(id);
    if (!operator || !overlayEntryReplaces(entry)) return null;
    return { lost: lostByReplacement(operator, entry) };
  }

  /**
   * What to do about an overlay entry the boot skips. mcpl_unload of it
   * removes it for an id the operator doesn't define, since it loads
   * nothing; for one the operator defines, it tombstones the operator's
   * server, which then stays unloaded.
   */
  private skippedAdvice(id: string): string {
    return this.operatorServers.has(id)
      ? 'redeploy with mcpl_deploy to replace it; mcpl_unload would tombstone the operator\'s definition, so it stays unloaded'
      : 'redeploy with mcpl_deploy, or mcpl_unload it';
  }

  /**
   * How to bring back a tombstoned id. For an id the operator defines, no
   * tool restores the operator's definition: mcpl_deploy loads the agent's
   * own entry in its place, and mcpl_unload writes the tombstone again. Only
   * removing the tombstone from the file does.
   */
  private tombstoneAdvice(id: string): string {
    return this.operatorServers.has(id)
      ? 'mcpl_deploy would load your own entry in its place, and removing the tombstone from your overlay file loads the operator\'s definition again'
      : 'redeploy with mcpl_deploy to restore it';
  }

  /**
   * A receipt's sentences about `id`'s overlay entry, or nothing: that it
   * replaces the operator's definition (always on deploy, which makes the
   * replacement; on restart only when it lacks something), what it lacks
   * with the way back, and which of its parts name a host variable, which
   * only a recipe substitutes.
   */
  private overlayNote(id: string, overlay: Record<string, AgentOverlayEntry>, onDeploy: boolean): string {
    const entry = Object.hasOwn(overlay, id) ? overlay[id] : undefined;
    // A malformed entry isn't what this server runs on, and the next start
    // skips it: say so, rather than nothing.
    const problem = entry === undefined ? null : overlayEntryProblem(entry);
    if (problem !== null) {
      return ` Your overlay entry for "${id}" is malformed (${problem}), so the next host start skips it` +
        `${this.operatorServers.has(id) ? ' and loads the operator\'s definition' : ''}; ${this.skippedAdvice(id)}.`;
    }
    // A restart of a tombstoned id fails as "not configured", which doesn't
    // say why or that the next start leaves it unloaded too.
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
        'so the server runs without the operator\'s values for them.',
        literal || 'An overlay entry can\'t name host variables.',
        `To go back to the operator's definition, mcpl_unload "${id}": that removes your entry, and the ` +
        'operator\'s loads again at the next host start.',
      );
    } else {
      if (replacement && onDeploy) sentences.push(`Your overlay entry replaces the operator's definition of "${id}".`);
      if (literal) sentences.push(literal);
    }
    return sentences.length > 0 ? ` ${sentences.join(' ')}` : '';
  }

  async start(_ctx: ModuleContext): Promise<void> {}

  async stop(): Promise<void> {
    this.framework = null;
  }

  getTools(): ToolDefinition[] {
    return this.surface === 'tools' ? this.definitions() : [];
  }

  /** Same definitions, same handler — the surface flag only decides whether
   *  they cost four slots or ride the `utils` meta-tool. */
  getUtilities(): ToolDefinition[] {
    return this.surface === 'utilities' ? this.definitions() : [];
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
          'config. Provide either `command` (stdio, spawned as the host user) or `url` ' +
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
    try {
      switch (call.name) {
        case 'mcpl_list':
          return this.handleList();
        case 'mcpl_deploy':
          return await this.forServer(input, () => this.handleDeploy(input));
        case 'mcpl_restart':
          return await this.forServer(input, () => this.handleRestart(input));
        case 'mcpl_unload':
          return await this.forServer(input, () => this.handleUnload(input));
        default:
          return fail(`Unknown tool: ${call.name}`);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return fail(`${call.name} failed: ${err.message}`);
    }
  }

  /** The tail of each server id's queue of deploy, restart and unload calls. */
  private readonly serverQueues = new Map<string, Promise<void>>();

  /**
   * Run `work` once every earlier deploy, restart or unload of the same id
   * has settled, so two calls for one server never interleave. An unload's
   * disconnect is never overtaken by a deploy that connects the server again,
   * which its overlay entry, identical or not, can't reveal, and a deploy's
   * connect is never overtaken by an unload that removes its entry. Calls
   * for other ids run as before.
   */
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

  // --------------------------------------------------------------------------
  // Handlers
  // --------------------------------------------------------------------------

  private requireFramework(): AgentFramework {
    if (!this.framework) {
      throw new Error('mcpl-admin module is not wired to the framework yet');
    }
    return this.framework;
  }

  private handleList(): ToolResult {
    const framework = this.requireFramework();
    // These fields land in agent-framework 0.8's MCPL grant work. Keep them
    // optional here so connectome-host remains truthful ("unknown") if it is
    // temporarily run against an older framework package during rollout.
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
      }
    >;
    const overlay = readAgentOverlay(this.overlayPath);
    const fileServers = readMcplServersFile(this.configPath);

    const lines: string[] = [];
    for (const s of live) {
      // The overlay is the source only for an entry that put a server in
      // place, the same test the boot's applyAgentOverlay makes.
      const replacement = this.replacement(s.id, overlay);
      const overlaySource = replacement
        ? `agent-overlay (replaces the operator's definition${replacement.lost ? `; lacks its ${replacement.lost}` : ''})`
        : 'agent-overlay';
      const source = overlayEntryReplaces(entryOf(overlay, s.id))
        ? overlaySource
        : Object.hasOwn(fileServers, s.id) ? 'file/recipe' : 'recipe';
      // The command, else the url, as main labelled it. The framework's status
      // carries no transport, so for a definition that names both, this can't
      // tell which one the framework opened.
      const target = s.command ?? s.url ?? '?';
      const connectionState = s.connected ? 'CONNECTED' : s.retrying ? 'RETRYING' : 'DISCONNECTED';
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
        `prefix=${s.toolPrefix}, source=${source}, ${target}`,
      );
    }

    // The overlay's entries the live list doesn't explain: malformed ones,
    // tombstones, and entries that aren't currently loaded
    const liveIds = new Set(live.map(s => s.id));
    for (const [id, entry] of Object.entries(overlay)) {
      const problem = overlayEntryProblem(entry);
      if (problem !== null) {
        lines.push(
          `${id}: MALFORMED in your overlay (${problem}), so the boot skips it` +
          `${this.operatorServers.has(id) ? ' and loads the operator\'s definition' : ''} — ${this.skippedAdvice(id)}`,
        );
      } else if (overlayEntryTombstones(entry)) {
        // A tombstone written while its server runs leaves it connected for
        // this session, which the line above already shows.
        lines.push(liveIds.has(id)
          ? `${id}: TOMBSTONED in your overlay, still connected this session; the next host start leaves it unloaded — ${this.tombstoneAdvice(id)}`
          : `${id}: UNLOADED (tombstoned in your overlay — ${this.tombstoneAdvice(id)})`);
      } else if (!liveIds.has(id)) {
        lines.push(`${id}: NOT LOADED (in your overlay but not connected — try mcpl_deploy again)`);
      }
    }

    if (lines.length === 0) {
      return ok('No MCPL servers configured. Use mcpl_deploy to add one.');
    }
    return ok(`MCPL servers (${lines.length}):\n` + lines.map(l => `  ${l}`).join('\n'));
  }

  private async handleDeploy(input: Record<string, unknown>): Promise<ToolResult> {
    const framework = this.requireFramework();
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id) return fail('mcpl_deploy requires a non-empty string `id`.');
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      return fail('`id` must match [a-zA-Z0-9_-]+ (it becomes part of tool names).');
    }
    // The one name the pattern admits that JavaScript doesn't take as a key:
    // `overlay["__proto__"] = entry` sets the overlay's prototype, so the
    // entry would never be saved.
    if (id === '__proto__') return fail('`id` can\'t be __proto__, which JavaScript reads as an object\'s prototype rather than a name.');

    // Each field the caller gives is judged as given, by the strict reading
    // below, rather than dropped or coerced into shape first, so a wrong kind
    // is refused instead of vanishing. A field is unspecified when it's left
    // out, null, or what strict function calling sends for its own kind when
    // every field is required: "" (or only spaces) for a text field, [] for
    // a list (env included, as before). Anything else is given, so "" for a
    // list or for reconnect, which has no unspecified value, is a wrong kind,
    // not a default. A persisted empty enabledFeatureSets would be deny-all
    // under the §5.3 pin (Mica's silently eventless eidoverse, 2026-08-04),
    // and so would a name list holding an empty name, which the strict
    // reading refuses; deny-all is disabledTools: ["*"] for tools, and for
    // feature sets, where `*` matches one dot-separated segment, a pattern
    // per depth (see resolveOverlayEntry). Numbers and true/false in a list
    // are read as their text, as the boot reads args.
    const given = (v: unknown): boolean => v !== undefined && v !== null;
    const givenText = (v: unknown): boolean => given(v) && !(typeof v === 'string' && v.trim() === '');
    const givenList = (v: unknown): boolean => given(v) && !(Array.isArray(v) && v.length === 0);
    const list = (v: unknown): unknown =>
      Array.isArray(v) ? v.map((x) => (typeof x === 'number' || typeof x === 'boolean' ? String(x) : x)) : v;

    const command = givenText(input.command) ? input.command : undefined;
    const url = givenText(input.url) ? input.url : undefined;
    if (command === undefined && url === undefined) return fail('mcpl_deploy requires either `command` (stdio) or `url` (websocket).');
    if (command !== undefined && url !== undefined) return fail('`command` and `url` are mutually exclusive.');

    const fields: Record<string, unknown> = {};
    if (command !== undefined) fields.command = command;
    if (url !== undefined) { fields.url = url; fields.transport = 'websocket'; }
    if (givenList(input.args)) fields.args = list(input.args);
    if (givenList(input.env)) fields.env = input.env;
    if (givenText(input.token)) fields.token = input.token;
    if (typeof input.access === 'string' ? input.access.trim() !== '' : given(input.access)) {
      if (typeof input.access === 'string' && !this.identity) {
        return fail(
          '`access` names a host-managed access grant, but this deployment has no identity ' +
          'configured — ask your operator to enable it (recipe `identity`), or supply a `token` (over wss://, or ws:// to this machine).',
        );
      }
      fields.access = typeof input.access === 'string' ? input.access.trim() : input.access;
    }
    if (givenText(input.toolPrefix)) fields.toolPrefix = input.toolPrefix;
    if (given(input.reconnect)) fields.reconnect = input.reconnect;
    for (const k of ['enabledFeatureSets', 'disabledFeatureSets', 'enabledTools', 'disabledTools']) {
      if (givenList(input[k])) fields[k] = list(input[k]);
    }

    // Never save an entry the boot would skip: what loads now must be what
    // loads at the next start. Without this, an env value such as null was
    // saved, resolveOverlayEntry returned null for it, and the deploy threw
    // after saving. A new write is held to
    // the plain shapes (strict), though the boot reads older files leniently.
    const problem = overlayEntryProblem(fields, { strict: true });
    if (problem) return fail(`mcpl_deploy refused: the entry would be malformed (${problem}), so nothing was saved.`);
    const entry = fields as AgentOverlayEntry;

    // A credential sent over ws:// to another machine (cleartextCredential
    // names the carriers it recognizes) can be read by anyone on the network
    // between. A deploy doesn't send one there. An operator who knows that
    // network is private can put the server in the recipe, where it loads
    // with a warning.
    const cleartext = cleartextCredential(entry);
    if (cleartext) {
      const configured = framework.listMcplServers().some(s => s.id === id);
      return fail(
        `mcpl_deploy refused: ${cleartextCarrierText(cleartext.carrier, entry.access)} would go to ${cleartext.host} ` +
        'over unencrypted ws://, where anyone on the network between can read it. Use a wss:// url, or, if that ' +
        'network is private, ask your operator to add the server to the recipe. Nothing was saved.' +
        (configured ? ` The server already configured as "${id}" is unchanged.` : ''),
      );
    }

    // Persist to the overlay first — a connect failure still leaves the entry
    // in place so the agent can fix the server and mcpl_restart it.
    const overlay = readAgentOverlay(this.overlayPath);
    overlay[id] = entry;
    saveAgentOverlay(this.overlayPath, overlay);

    const config = resolveOverlayEntry(id, entry, this.overlayPath) as unknown as McplServerConfig;
    // The child's env as the boot composes it for every server
    // (composeMcplChildEnv): the refusal-reaction baseline as a default the
    // entry's own env overrides, and the host's AGENT_TIMEZONE over both.
    config.env = composeMcplChildEnv(config.env as Record<string, string> | undefined, this.timeZone);
    if (entry.access && this.identity) {
      const identity = this.identity;
      const audience = entry.access;
      // Fresh credential on every dial, resolved host-side; the overlay
      // stores only the access NAME. See identity-module.ts header.
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
      const err = error instanceof Error ? error : new Error(String(error));
      return fail(
        `Server "${id}" was saved to your overlay but failed to connect: ${err.message}. ` +
        `Fix the server (check command/path/build) and run mcpl_restart, or mcpl_unload to remove it.${note}`,
      );
    }

    // A server with reconnect whose first dial failed comes back as a stub
    // that keeps retrying, without throwing: report what the status says.
    const status = framework.listMcplServers().find(s => s.id === id);
    if (!status?.connected) {
      return fail(
        `Server "${id}" was saved to your overlay but isn't connected${status?.retrying ? ' (it keeps retrying)' : ''}. ` +
        `Fix the server (check command/path/build) and run mcpl_restart, or mcpl_unload to remove it.${note}`,
      );
    }
    return ok(
      `${alreadyLoaded ? 'Redeployed' : 'Deployed'} server "${id}" — connected, ` +
      `${status.toolCount} tools under prefix ${status.toolPrefix}. ` +
      `Persisted to your agent overlay (survives host restarts).${note}`,
    );
  }

  private async handleRestart(input: Record<string, unknown>): Promise<ToolResult> {
    const framework = this.requireFramework();
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id) return fail('mcpl_restart requires `id`.');

    // The note is read before the restart, so a restart that throws still
    // carries it, and an overlay file that can't be read costs only the
    // note: the restart's own outcome is what the receipt reports. A parse
    // error can quote the file, which may hold values, so it isn't repeated.
    let note: string;
    try {
      const overlay = readAgentOverlay(this.overlayPath);
      note = this.overlayNote(id, overlay, false);
      // The restart reconnects with the configuration of the server's last
      // connect, while the note reads the file as it is now. An edit made
      // before that connect is already in it. That's said of a replacing
      // entry only: a skipped one
      // takes no effect, and a tombstoned id has no configuration left to
      // reconnect with once unloaded.
      if (note && overlayEntryReplaces(Object.hasOwn(overlay, id) ? overlay[id] : undefined)) {
        note += ' That describes your overlay file as it is now. The restart reconnects with the configuration of the ' +
          'server\'s last connect, at this host\'s start or your last mcpl_deploy of it, so a hand edit made since then ' +
          'takes effect at the next host start, unless a later mcpl_deploy replaces it.';
      }
    } catch {
      // readAgentOverlay throws only where the boot does too: a file it
      // can't read, that isn't JSON, or whose root is null. So the next
      // start stops on it.
      note = ' Your overlay file couldn\'t be read as an overlay, so nothing is said here about your entry, ' +
        'and the next host start will stop on it until the file is fixed.';
    }
    try {
      await framework.restartMcplServer(id);
    } catch (error) {
      return fail(`mcpl_restart failed: ${error instanceof Error ? error.message : String(error)}.${note}`);
    }
    const status = framework.listMcplServers().find(s => s.id === id);
    if (!status?.connected) {
      return fail(`Restarted server "${id}", but it isn't connected${status?.retrying ? ' (it keeps retrying)' : ''}.${note}`);
    }
    return ok(`Restarted server "${id}" — connected, ${status.toolCount} tools.${note}`);
  }

  /** What the next host start loads for `id`, read from `overlay` as this
   *  call leaves it, as a clause for a receipt. */
  private nextStart(id: string, overlay: Record<string, AgentOverlayEntry>): string {
    const entry = entryOf(overlay, id);
    if (overlayEntryTombstones(entry)) return 'your overlay tombstones it, so the next host start leaves it unloaded.';
    if (overlayEntryReplaces(entry)) return 'your overlay entry loads it again at the next host start.';
    if (this.operatorServers.has(id)) return 'the operator\'s definition loads it again at the next host start.';
    return 'nothing loads it at the next host start.';
  }

  private async handleUnload(input: Record<string, unknown>): Promise<ToolResult> {
    const framework = this.requireFramework();
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id) return fail('mcpl_unload requires `id`.');
    // As for mcpl_deploy: `overlay["__proto__"] = …` would set the prototype,
    // so a tombstone for it would never be saved.
    if (id === '__proto__') return fail('`id` can\'t be __proto__, which JavaScript reads as an object\'s prototype rather than a name.');
    const persist = input.persist !== false;

    const known = framework.listMcplServers().some(s => s.id === id);
    const operator = this.operatorServers.has(id);
    // Read before anything changes: a file the boot would stop on refuses
    // the unload here, with the server still loaded. An operator's server
    // that isn't loaded can still be unloaded, so that it stays unloaded at
    // the next start: one that failed to start, or one whose earlier unload
    // disconnected it but couldn't save.
    const overlay = readAgentOverlay(this.overlayPath);
    if (!known && !operator && entryOf(overlay, id) === undefined) {
      return fail(`Server "${id}" is not loaded and not in your overlay.`);
    }

    // Only a listed server is disconnected: an id the overlay alone names
    // has nothing loaded. The overlay changes only once the server is gone,
    // so a disconnect that fails changes nothing.
    if (known) {
      try {
        await framework.disconnectMcplServer(id);
      } catch (error) {
        return fail(
          `Server "${id}" couldn't be disconnected: ${error instanceof Error ? error.message : String(error)}. ` +
          'It may still be loaded in this session, and this unload changed nothing in your overlay.',
        );
      }
    }
    const head = known
      ? `Unloaded server "${id}" — its tools are gone from your toolset.`
      : `Server "${id}" wasn't loaded in this session.`;
    if (!persist) return ok(`${head} Session-only: ${this.nextStart(id, overlay)}`);

    // Read again after the disconnect and saved with nothing awaited between,
    // so a write for another id that landed meanwhile (its deploy, say) is
    // kept. No call for this id can land meanwhile (forServer). The server
    // is already gone if this fails, so the receipt says so, and what the
    // next start loads; an unload of it again records it.
    try {
      const current = known ? readAgentOverlay(this.overlayPath) : overlay;
      const entry = entryOf(current, id);
      // An agent-deployed entry is removed, and so is a malformed one for an
      // id the operator doesn't define, which loads nothing. Otherwise a
      // tombstone keeps it unloaded: the operator's server, a malformed entry
      // the boot would skip for the operator's, or a server whose definition
      // this module can't see.
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
      return fail(
        `${head} But your overlay couldn't be updated (${error instanceof Error ? error.message : String(error)}), ` +
        `so nothing was recorded: ${this.nextStart(id, overlay)} mcpl_unload "${id}" again records it once the file can be read and written.`,
      );
    }
  }
}

/** `id`'s own entry in an overlay: never a name the map inherits, such as
 *  `toString`. */
function entryOf(overlay: Record<string, AgentOverlayEntry>, id: string): AgentOverlayEntry | undefined {
  return Object.hasOwn(overlay, id) ? overlay[id] : undefined;
}

/** One of a server's tools with its effective class (RFC-008 §6), as
 *  listMcplServers() reports it on frameworks with tool classes. */
interface ServerToolClass {
  tool: string;
  serverTool: string;
  class: string[];
  source: 'override' | 'host' | 'server' | 'none';
}

/**
 * A server's tools grouped by effective class and source, e.g.
 * `{comms/server: say,send; media/override: render; unclassed: probe}`.
 * Sources: `server` = the server's own `_meta["mcpl/class"]`, `override` =
 * the operator's recipe override; unclassed tools never expose their
 * arguments to lifecycle observers. `unknown` on an older framework.
 */
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

/** Bound and quote the server-authored, equality-only revision before putting
 * it on a model-facing text surface. Conforming revisions fit well below the
 * limit; malformed peers cannot inject control lines or unbounded text. */
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
