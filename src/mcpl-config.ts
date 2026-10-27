import { readFileSync, writeFileSync, existsSync, lstatSync, unlinkSync, openSync, fstatSync, closeSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { agentOverlayPath } from './update/agent-overlay-path.js';
import { namesEnvReference, type RecipeToolLifecycle } from './recipe.js';
import { validateToolLifecycle } from './tool-lifecycle-config.js';
import { parseHandWrittenJson } from './hand-written-json.js';
import { resolveServerBinding, serverConfigProblems } from '@animalabs/agent-framework';

/** Default config file path, resolved from cwd. */
export const DEFAULT_CONFIG_PATH = resolve(process.cwd(), 'mcpl-servers.json');

/**
 * JSON.parse's message can quote a stretch of the text it refuses, and the
 * file can hold a token in an env block.
 */
function parseServersFile(path: string): unknown {
  const raw = readFileSync(path, 'utf-8');
  let parsed: unknown;
  try {
    parsed = parseHandWrittenJson(raw);
  } catch (error) {
    if (error instanceof SyntaxError) throw new SyntaxError(`${path} isn't valid JSON`);
    throw error;
  }
  if (parsed === null) throw new TypeError(`${path} holds null, not an object with mcplServers`);
  return parsed;
}

/**
 * Serializable subset of McplServerConfig.
 */
export interface ServerFileEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Opt in to the full host environment for stdio servers. Requires an
   * agent-framework version with inheritEnv support; prefer explicit env. */
  inheritEnv?: boolean;
  toolPrefix?: string;
  reconnect?: boolean;
  reconnectIntervalMs?: number;
  reconnectMaxIntervalMs?: number;
  enabledFeatureSets?: string[];
  disabledFeatureSets?: string[];
  enabledTools?: string[];
  disabledTools?: string[];
  /** @deprecated One-time migration input for legacy installations. */
  channelSubscription?: 'auto' | 'manual' | string[];
  /**
   * Name of a network access grant (an archipelago audience, e.g.
   * "eidoverse"). Purely declarative here: at load/deploy time the host
   * attaches a credential provider that fetches something fresh on every
   * dial via the identity module. `access` is a name, not a secret.
   */
  access?: string;
  /** MCPL tool lifecycle (RFC-007) policy — see RecipeMcpServer.toolLifecycle. */
  toolLifecycle?: RecipeToolLifecycle;
  /** MCPL RFC-014 opt-in — see RecipeMcpServer.toolHints. */
  toolHints?: boolean;
}

export interface McplServersFile {
  mcplServers: Record<string, ServerFileEntry>;
}

export type LoadedServerConfig = ServerFileEntry & { id: string };

export function loadMcplServers(configPath: string): LoadedServerConfig[] {
  if (!existsSync(configPath)) return [];

  const parsed = parseServersFile(configPath) as McplServersFile;
  if (!parsed.mcplServers || typeof parsed.mcplServers !== 'object') return [];

  const configDir = dirname(resolve(configPath));
  const servers: LoadedServerConfig[] = [];

  for (const [id, entry] of Object.entries(parsed.mcplServers)) {
    const args = entry.args?.map(arg => {
      if (arg.startsWith('./') || arg.startsWith('../')) {
        return resolve(configDir, arg);
      }
      return arg;
    });

    servers.push({
      id,
      command: entry.command,
      args,
      env: entry.env,
      ...(entry.inheritEnv !== undefined
        ? { inheritEnv: checkedInheritEnv(entry.inheritEnv, `mcpl-servers.json: mcplServers.${id}`) }
        : {}),
      toolPrefix: entry.toolPrefix,
      reconnect: entry.reconnect,
      reconnectIntervalMs: entry.reconnectIntervalMs,
      reconnectMaxIntervalMs: entry.reconnectMaxIntervalMs,
      enabledFeatureSets: entry.enabledFeatureSets,
      disabledFeatureSets: entry.disabledFeatureSets,
      enabledTools: entry.enabledTools,
      disabledTools: entry.disabledTools,
      channelSubscription: entry.channelSubscription,
      ...(entry.toolLifecycle !== undefined ? { toolLifecycle: checkedToolLifecycle(entry.toolLifecycle, id) } : {}),
      ...(entry.toolHints !== undefined ? { toolHints: checkedToolHints(entry.toolHints, id) } : {}),
    });
  }

  return servers;
}

function checkedInheritEnv(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${where}.inheritEnv must be a boolean`);
  return value;
}

function checkedToolHints(value: unknown, id: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`mcpl-servers.json: mcplServers.${id}.toolHints must be true or false`);
  return value;
}

function checkedToolLifecycle(value: unknown, id: string): RecipeToolLifecycle {
  validateToolLifecycle(value, `mcpl-servers.json: mcplServers.${id}.toolLifecycle`);
  return value as RecipeToolLifecycle;
}

/**
 * Policy fields a recipe may set on a server it takes from
 * mcpl-servers.json by id.
 */
export const RECIPE_OVERRIDABLE_SERVER_FIELDS = [
  'channelSubscription', 'toolPrefix', 'enabledFeatureSets', 'disabledFeatureSets',
  'enabledTools', 'disabledTools', 'reconnect', 'reconnectIntervalMs', 'reconnectMaxIntervalMs',
  'inheritEnv',
  // A recipe may adopt WebSocket transport for a file-defined server.
  'url', 'transport', 'token', 'access',
  // MCPL RFC-007: observation of the agent's other tool calls is per-recipe
  // policy, like tool toggles — not a property of where the server came from.
  'toolLifecycle',
  // MCPL RFC-014: whether the host reads the server's tool hints, and so
  // whether its toolsets open and close, is how the agent is shown its
  // tools, which is the recipe's to decide.
  'toolHints',
] as const;

export function applyRecipeServerOverrides<T extends Record<string, unknown>>(
  fileEntry: T,
  recipeEntry: Record<string, unknown>,
): T & Record<string, unknown> {
  const merged: Record<string, unknown> = { ...fileEntry };
  for (const field of RECIPE_OVERRIDABLE_SERVER_FIELDS) {
    if (recipeEntry[field] !== undefined) merged[field] = recipeEntry[field];
  }
  return merged as T & Record<string, unknown>;
}

type MergedServer = { id: string; command?: string; url?: string; [k: string]: unknown };

export function mergeRecipeServers(
  recipeServers: Record<string, Record<string, unknown>>,
  fileServers: ReadonlyArray<{ id: string } & Record<string, unknown>>,
): MergedServer[] {
  const fileById = new Map(fileServers.map((s) => [s.id, s]));
  const out: MergedServer[] = [];
  for (const [id, recipeEntry] of Object.entries(recipeServers)) {
    const fileEntry = fileById.get(id);
    if (fileEntry) {
      out.push(applyRecipeServerOverrides(fileEntry, recipeEntry) as MergedServer);
    } else if (recipeEntry.command || recipeEntry.url) {
      out.push({ id, ...recipeEntry } as MergedServer);
    } else {
      throw new Error(
        `Recipe mcpServers.${id} has no "command" or "url", and mcpl-servers.json defines no "${id}" ` +
          `server for it to refer to`,
      );
    }
  }
  return out;
}

export { AGENT_OVERLAY_FILE_NAME, AGENT_OVERLAY_FILE_ENV } from './update/agent-overlay-path.js';

export const CHILD_AGENT_OVERLAY_FILE_NAME = 'mcpl-servers.agent.child.json';

/** The agent overlay's path: MCPL_AGENT_OVERLAY_FILE where the environment
 *  sets it, else mcpl-servers.agent.json, resolved from the working
 *  directory. */
export const DEFAULT_AGENT_OVERLAY_PATH = agentOverlayPath(process.cwd(), process.env);

/**
 * An overlay entry is either a full server definition (agent-deployed, loads
 * unconditionally — no recipe opt-in needed) or a tombstone `{disabled: true}`
 * that suppresses a recipe/file server the agent unloaded.
 *
 * Unlike `ServerFileEntry`, `command` is optional here: an entry has a
 * `command` (stdio) or a `url` (WebSocket), or both with a `transport`
 * saying which, and tombstones have neither.
 */
export interface AgentOverlayEntry extends Partial<ServerFileEntry> {
  /** WebSocket URL (WebSocket transport). */
  url?: string;
  transport?: 'stdio' | 'websocket';
  /** Bearer token for WebSocket auth. */
  token?: string;
  /** Tombstone: suppress a recipe/file server the agent unloaded. */
  disabled?: boolean;
}

export interface AgentOverlayFile {
  mcplServers: Record<string, AgentOverlayEntry>;
}

export class OverlayUnreadableError extends Error {
  constructor(readonly path: string, readonly problem: 'not-json' | 'null-root') {
    super(
      `the agent overlay ${path} ${problem === 'not-json' ? 'isn\'t valid JSON' : 'isn\'t an object with mcplServers'}: ` +
        'fix it: moving it aside would load every server the agent unloaded and drop its deployments',
    );
  }
}

export function readAgentOverlayFile(overlayPath: string): {
  servers: Record<string, AgentOverlayEntry>;
  otherKeys: string[];
  notes: string[];
} {
  if (!existsSync(overlayPath)) return { servers: {}, otherKeys: [], notes: [] };
  const raw = readFileSync(overlayPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = parseHandWrittenJson(raw);
  } catch {
    throw new OverlayUnreadableError(overlayPath, 'not-json');
  }
  if (parsed === null) throw new OverlayUnreadableError(overlayPath, 'null-root');
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { servers: {}, otherKeys: [], notes: ['has a root that isn\'t an object, so it holds no entries, as main read it'] };
  }
  const otherKeys = Object.keys(parsed).filter((k) => k !== 'mcplServers');
  const servers = (parsed as { mcplServers?: unknown }).mcplServers;
  if (servers === undefined || servers === null) return { servers: {}, otherKeys, notes: [] };
  if (Array.isArray(servers)) {
    return {
      servers: Object.fromEntries(servers.map((entry, i) => [String(i), entry])) as Record<string, AgentOverlayEntry>,
      otherKeys,
      notes: ['has an mcplServers that\'s a list, so its items are entries named by position ("0", "1", …), as main read them'],
    };
  }
  if (typeof servers !== 'object') {
    return { servers: {}, otherKeys, notes: ['has an mcplServers that isn\'t a map of entries, so nothing in it loads, as on main'] };
  }
  return { servers: servers as Record<string, AgentOverlayEntry>, otherKeys, notes: [] };
}

export function readAgentOverlay(overlayPath: string): Record<string, AgentOverlayEntry> {
  return readAgentOverlayFile(overlayPath).servers;
}

const OVERLAY_NAME_LIST_FIELDS = [
  'enabledFeatureSets',
  'disabledFeatureSets',
  'enabledTools',
  'disabledTools',
  'disabledCapabilities',
] as const;

export type OverlayEntryReading =
  | { entry: AgentOverlayEntry; notes: string[]; problem?: undefined }
  | { problem: string; entry?: undefined; notes?: undefined };

const isPlain = (v: unknown): v is string | number | boolean =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** JSON writes null in place of Infinity or NaN (a call's 1e400 parses as
 *  Infinity), so neither counts as plain to write. */
const isPlainToWrite = (v: unknown): v is string | number | boolean =>
  isPlain(v) && !(typeof v === 'number' && !Number.isFinite(v));

export const NAMES_NOTHING = 'it names no command to run and no url to dial';

/**
 * Fields only the operator's own config grants: the boot reads an agent
 * overlay entry without them, and the startup warnings name each one an
 * entry sets, with where the operator grants it.
 */
export const OPERATOR_ONLY_OVERLAY_FIELDS = ['enabledCapabilities', 'toolLifecycle', 'inheritEnv', 'allowHostCommands'] as const;
type OperatorOnlyField = (typeof OPERATOR_ONLY_OVERLAY_FIELDS)[number];

const OPERATOR_FIELD_HOME: Record<OperatorOnlyField, string> = {
  enabledCapabilities: "a server the recipe defines itself, with its own command or url and an id mcpl-servers.json doesn't define",
  toolLifecycle: 'mcpl-servers.json for a server the recipe names, or the recipe',
  inheritEnv: 'mcpl-servers.json for a server the recipe names, or the recipe',
  allowHostCommands: "a server the recipe defines itself, with its own command or url and an id mcpl-servers.json doesn't define",
};

/** agent-framework drops every advertised capability a disabledCapabilities
 *  pattern matches, whatever the enabled list says (capability-mask.ts). */
const NARROW_INSTEAD = '; to narrow what the server may advertise, list what to deny in its disabledCapabilities';

/** A list sets something even when it's empty: agent-framework reads any
 *  enabledCapabilities list as a mask of what the server may advertise, and
 *  an empty one lets nothing through. */
function setsSomething(value: unknown): boolean {
  return Boolean(value);
}

export function readOverlayEntry(raw: unknown, opts: { strict?: boolean } = {}): OverlayEntryReading {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { problem: 'it isn\'t an object' };
  const e: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  if (e.disabled === true) return { entry: { disabled: true }, notes: [] };
  if (e.disabled) return { problem: 'its disabled is neither true nor false' };
  if (opts.strict) {
    const problems: string[] = [];
    for (const k of ['command', 'url', 'token', 'access', 'toolPrefix']) {
      if (e[k] !== undefined && typeof e[k] !== 'string') problems.push(`its ${k} isn't text`);
    }
    if (e.transport !== undefined && e.transport !== 'stdio' && e.transport !== 'websocket') {
      problems.push('its transport is neither stdio nor websocket');
    }
    if (e.args !== undefined && (!Array.isArray(e.args) || !e.args.every((a) => typeof a === 'string'))) {
      problems.push('its args aren\'t a list of text');
    }
    if (e.env !== undefined) {
      if (e.env === null || typeof e.env !== 'object' || Array.isArray(e.env)) {
        problems.push('its env isn\'t a map of names to values');
      } else {
        const odd = Object.entries(e.env as Record<string, unknown>).filter(([, v]) => !isPlainToWrite(v)).map(([k]) => k);
        if (odd.length > 0) problems.push(`its env ${odd.join(', ')} ${odd.length === 1 ? 'isn\'t' : 'aren\'t'} text, a finite number or true/false`);
      }
    }
    for (const k of OVERLAY_NAME_LIST_FIELDS) {
      if (e[k] === undefined) continue;
      if (!Array.isArray(e[k])) {
        problems.push(`its ${k} isn't a list of names`);
        continue;
      }
      const items = e[k] as unknown[];
      if (!items.every((x) => typeof x === 'string')) problems.push(`its ${k} isn't a list of names`);
      if (items.some((x) => typeof x === 'string' && x.trim() === '')) {
        problems.push(`its ${k} holds an empty name, which matches nothing`);
      }
    }
    if (e.reconnect !== undefined && typeof e.reconnect !== 'boolean') problems.push('its reconnect is neither true nor false');
    if (e.toolHints !== undefined && typeof e.toolHints !== 'boolean') problems.push('its toolHints is neither true nor false');
    if (problems.length > 0) return { problem: problems.join('; ') };
  }
  const notes: string[] = [];
  if (e.args) {
    if (!Array.isArray(e.args) || !e.args.every(isPlain)) return { problem: 'its args aren\'t a list of text, numbers or true/false' };
    if (!e.args.every((a) => typeof a === 'string')) {
      e.args = e.args.map(String);
      notes.push('its args hold numbers or true/false, read as their text, where the host used to stop the start');
    }
  }
  for (const k of OVERLAY_NAME_LIST_FIELDS) {
    if (typeof e[k] === 'string' && e[k] !== '') {
      e[k] = [e[k]];
      notes.push(`its ${k} is one name, read as a list of one`);
    }
  }
  // agent-framework refuses a server whose reconnect is anything but true,
  // false or null.
  if (e.reconnect === null) e.reconnect = false;
  else if (e.reconnect !== undefined && typeof e.reconnect !== 'boolean') {
    const read = typeof e.reconnect === 'string' && e.reconnect.trim().toLowerCase() === 'false' ? false : Boolean(e.reconnect);
    notes.push(`its reconnect isn't true or false, so it's read as ${read}: write true or false, without quotes`);
    e.reconnect = read;
  }
  if (e.toolHints !== undefined && typeof e.toolHints !== 'boolean') {
    notes.push('its toolHints isn\'t true or false, so it\'s left out and the server gets the default: write true or false, without quotes');
    delete e.toolHints;
  }
  for (const k of OPERATOR_ONLY_OVERLAY_FIELDS) {
    if (setsSomething(e[k])) notes.push(`its ${k} is left out, since only the operator's config grants that: set it in ${OPERATOR_FIELD_HOME[k]}${k === 'enabledCapabilities' ? NARROW_INSTEAD : ''}`);
  }
  if (typeof e.toolPrefix === 'number' || typeof e.toolPrefix === 'boolean') {
    notes.push(`its toolPrefix is ${typeof e.toolPrefix === 'number' ? 'a number' : 'true or false'}, read as its text, so calls to its tools reach it`);
    e.toolPrefix = String(e.toolPrefix);
  } else if (e.toolPrefix !== null && typeof e.toolPrefix === 'object') {
    notes.push('its toolPrefix isn\'t text, so its tools take the default prefix, which calls to them reach');
    delete e.toolPrefix;
  }
  if (Array.isArray(e.disabledCapabilities) && e.disabledCapabilities.some((c) => { try { String(c); return false; } catch { return true; } })) {
    notes.push('its disabledCapabilities holds an item that can\'t be read as text, which denies nothing, where the host used to stop the start');
  }
  // agent-framework refuses a null transport (resolveServerBinding).
  if (e.transport === null) delete e.transport;
  if (!e.command && !e.url) return { problem: NAMES_NOTHING };
  if (openedBy(e) === null) notes.push('the framework refuses it as written (its own line at the start says why), so nothing connects in its place');
  return { entry: e as AgentOverlayEntry, notes };
}

export function overlayEntryProblem(entry: unknown, opts: { strict?: boolean } = {}): string | null {
  return readOverlayEntry(entry, opts).problem ?? null;
}

/**
 * Whether a URL's hostname, as the WHATWG parser gives it (lowercased, an
 * IPv6 address in brackets, an IPv4 address without a trailing dot), names
 * this machine: `localhost`, 127.0.0.0/8, `::1` and IPv4-mapped 127.0.0.0/8
 * addresses, which are loopback addresses, and the unspecified `0.0.0.0`,
 * `::` and `::ffff:0.0.0.0`, which aren't, but which Linux and macOS connect
 * to locally. Any other name, `localhost.` and names under `.localhost`
 * included, goes to a resolver that may not answer with this machine.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[(.*)\]$/, '$1');
  return host === 'localhost' || host === '::1' || host === '0.0.0.0' || host === '::'
    || host === '::ffff:0:0'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
    || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host);
}

export function cleartextCredential(
  entry: { url?: unknown; token?: unknown; access?: unknown; command?: unknown; transport?: unknown },
): { carrier: 'access' | 'token' | 'url'; host: string } | undefined {
  if (openedBy(entry) !== 'dial') return undefined;
  // Parsed as the transport parses it: an older overlay entry read leniently
  // can hold a url that isn't a string, which the URL constructor coerces.
  let url: URL;
  try {
    url = new URL(entry.url as string);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'ws:' || isLoopbackHost(url.hostname)) return undefined;
  // A token counts as any value the transport would send but a blank one,
  // which holds no secret (in query mode it sends a token of spaces, and an
  // empty parameter; in header mode it sends neither). A grant counts
  // whenever it's given, since its name, even a blank one, says nothing
  // about the credential it resolves to.
  const given = (v: unknown): boolean => (typeof v === 'string' ? v.trim() !== '' : Boolean(v));
  const granted = typeof entry.access === 'string' ? entry.access !== '' : Boolean(entry.access);
  const carrier = granted ? 'access'
    : given(entry.token) ? 'token'
    : url.username !== '' || url.password !== '' || url.searchParams.getAll('token').some(given) ? 'url'
    : undefined;
  return carrier ? { carrier, host: url.host } : undefined;
}

export function cleartextCarrierText(carrier: 'access' | 'token' | 'url', access?: unknown): string {
  if (carrier === 'access') return `the credential of its access grant ${JSON.stringify(String(access))}`;
  if (carrier === 'token') return 'its token';
  return "the user, password or token parameter in its url";
}

export function overlayEntryTombstones(entry: unknown): boolean {
  return readOverlayEntry(entry).entry?.disabled === true;
}

export function seedChildAgentOverlay(childPath: string, fromPath: string, copy: boolean): void {
  if (lstatSync(childPath, { throwIfNoEntry: false }) !== undefined) return;
  let content: string | Buffer = JSON.stringify({ mcplServers: {} }, null, 2) + '\n';
  let mode = 0o600;
  if (copy && existsSync(fromPath)) {
    const fd = openSync(fromPath, 'r');
    try {
      mode = fstatSync(fd).mode & 0o600;
      content = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  try {
    writeFileSync(childPath, content, { flag: 'wx', mode });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    try { unlinkSync(childPath); } catch {}
    throw error;
  }
}

/**
 * Writing through the existing file keeps its mode (it can hold tokens), a
 * symlink at its path, and a single-file bind mount; a new file renamed
 * over it would lose all three, and the rename fails outright on such a
 * mount. A crash in the middle of this small write can still leave the
 * file truncated, so the next boot stops on it, as it always could.
 */
export function saveAgentOverlay(
  overlayPath: string,
  servers: Record<string, AgentOverlayEntry>,
): void {
  writeServersFile(overlayPath, servers);
}

function writeServersFile(path: string, servers: Record<string, unknown>): void {
  let root: Record<string, unknown> = {};
  if (existsSync(path)) {
    let parsed: unknown;
    try {
      parsed = parseHandWrittenJson(readFileSync(path, 'utf-8'));
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`${path} isn't valid JSON, so it wasn't overwritten`);
      throw error;
    }
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) root = parsed as Record<string, unknown>;
  }
  writeFileSync(path, JSON.stringify({ ...root, mcplServers: servers }, null, 2) + '\n', 'utf-8');
}

/**
 * Capabilities an agent-deployed server is never granted by default: the
 * consequential surfaces — context hooks (observation of and injection into
 * the agent's own inference), server-initiated inference, and inference
 * lifecycle. Bare parents: the config mask's subtree matching denies
 * everything beneath them, present and future. An operator who wants a
 * self-deployed server to hold one of these moves the server into the
 * recipe, where `enabledCapabilities` is theirs to write.
 */
export const AGENT_DEPLOY_DENIED_CAPABILITIES: readonly string[] = [
  'contextHooks',
  'inferenceRequest',
  'inferenceLifecycle',
  // MCPL RFC-007: observing the agent's OTHER tool calls (and their
  // arguments) is an operator grant. The bare parent masks both leaves, so a
  // toolLifecycle block the agent writes cannot re-grant them either.
  'toolLifecycle',
];

/** OpenAI strict function calling forces every schema property, so an
 *  agent's tool call arrives with `[]` where it meant "unspecified". */
const OVERLAY_LIST_FIELDS = [
  'enabledFeatureSets',
  'disabledFeatureSets',
  'enabledTools',
  'disabledTools',
] as const;

/**
 * A relative `./` or `../` arg resolves against the working directory:
 * agent-framework spawns a stdio server with no cwd of its own.
 *
 * agent-framework reads `enabledTools: []` as all tools, and a present but
 * empty `enabledFeatureSets` as deny-all (MCPL §5.3). Tool patterns are
 * whole-name globs, `*` any run. A feature-set pattern's `*` stands for
 * exactly one dot-separated segment, and a pattern only matches names with
 * as many segments, so `disabledFeatureSets: ["*"]` denies `channels` but not
 * `memory.retrieval`.
 */
export function resolveOverlayEntry(
  id: string,
  entry: AgentOverlayEntry,
): ({ id: string; command?: string; url?: string } & Record<string, unknown>) | null {
  const read = readOverlayEntry(entry).entry;
  if (!read || read.disabled === true) return null;
  const { disabled: _d, ...fields } = read;
  const rec = fields as Record<string, unknown>;
  for (const k of OVERLAY_LIST_FIELDS) {
    if (Array.isArray(rec[k]) && (rec[k] as unknown[]).length === 0) delete rec[k];
  }
  for (const k of OPERATOR_ONLY_OVERLAY_FIELDS) delete rec[k];
  if (read.url && rec.reconnect === undefined) rec.reconnect = true;
  const denied = new Set<string>([
    ...AGENT_DEPLOY_DENIED_CAPABILITIES,
    // Each item as String() reads it, so a nested list such as [["channels"]]
    // still denies "channels". String() throws on a parsed object whose own
    // toString isn't a function, and such an item names nothing.
    ...(Array.isArray(rec.disabledCapabilities)
      ? (rec.disabledCapabilities as unknown[]).flatMap((c) => { try { return [String(c)]; } catch { return []; } })
      : []),
  ]);
  return {
    id,
    ...rec,
    disabledCapabilities: [...denied].sort(),
    ...(Array.isArray(rec.args)
      ? {
          args: (rec.args as string[]).map(arg =>
            arg.startsWith('./') || arg.startsWith('../') ? resolve(process.cwd(), arg) : arg,
          ),
        }
      : {}),
  };
}

export function applyAgentOverlay<T extends { id: string }>(
  servers: T[],
  overlayPath: string,
): Array<T | ({ id: string } & Record<string, unknown>)> {
  return composeOverlay(servers, readAgentOverlay(overlayPath));
}

export function composeOverlay<T extends { id: string }>(
  servers: T[],
  overlay: Record<string, AgentOverlayEntry>,
): Array<T | ({ id: string } & Record<string, unknown>)> {
  if (Object.keys(overlay).length === 0) return servers;

  const result: Array<T | ({ id: string } & Record<string, unknown>)> =
    servers.filter(s => !overlayEntryTombstones(Object.hasOwn(overlay, s.id) ? overlay[s.id] : undefined));

  for (const [id, entry] of Object.entries(overlay)) {
    const loaded = resolveOverlayEntry(id, entry);
    if (!loaded) continue;
    const idx = result.findIndex(s => s.id === id);
    if (idx >= 0) result[idx] = loaded;
    else result.push(loaded);
  }

  return result;
}

export interface ServerProvisions {
  env: string[];
  token: boolean;
  access: string | null;
  inheritEnv: boolean;
  grants: GrantField[];
}

type GrantField = Exclude<OperatorOnlyField, 'inheritEnv'>;

/** As agent-framework reads each operator-only field: host commands only for
 *  true; capabilities for any list, which masks what the server may
 *  advertise, an empty one letting nothing through, and whose patterns grant
 *  the paths denied by default (capability-mask.ts, capability-grant.ts); and
 *  tool lifecycle for an `observe` or `inputs` policy object (configGrants).
 *  create() refuses an allowHostCommands such as "true", and the framework
 *  can't read an enabledCapabilities that isn't a list (its negotiation calls
 *  `.some` on it and throws). */
function grantsThrough(field: GrantField, value: unknown): boolean {
  const isPolicy = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v);
  switch (field) {
    case 'allowHostCommands': return value === true;
    case 'enabledCapabilities': return Array.isArray(value);
    case 'toolLifecycle': {
      if (!isPolicy(value)) return false;
      const block = value as Record<string, unknown>;
      return isPolicy(block.observe) || isPolicy(block.inputs);
    }
  }
}

export function serverProvisions(definition: Record<string, unknown>): ServerProvisions {
  const env = definition.env && typeof definition.env === 'object' ? Object.keys(definition.env) : [];
  const access = typeof definition.access === 'string' ? definition.access : '';
  return {
    env: env.sort(),
    token: Boolean(definition.token),
    access: access || null,
    inheritEnv: definition.inheritEnv === true,
    grants: OPERATOR_ONLY_OVERLAY_FIELDS.filter((k): k is GrantField => k !== 'inheritEnv' && grantsThrough(k, definition[k])),
  };
}

const LACKED_GRANT: Record<GrantField, string> = {
  enabledCapabilities: 'enabled capabilities (enabledCapabilities)',
  toolLifecycle: 'tool lifecycle (toolLifecycle)',
  allowHostCommands: 'host commands (allowHostCommands)',
};

const namesHostVariable = (text: unknown): boolean => typeof text === 'string' && namesEnvReference(text);

/** agent-framework spreads an env that isn't a map into names such as "0",
 *  none a name a definition maps. */
const envOf = (entry: AgentOverlayEntry): Record<string, unknown> =>
  entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env) ? entry.env : {};

/** By agent-framework's own rules (resolveServerBinding and
 *  serverConfigProblems): 'dial' for its url, 'spawn' for its command, or
 *  null for an entry it refuses when it connects. */
export const openedBy = (entry: { transport?: unknown; url?: unknown; command?: unknown }): 'dial' | 'spawn' | null => {
  try {
    const config: Record<string, unknown> = { id: '', ...entry };
    for (const k of OPERATOR_ONLY_OVERLAY_FIELDS) delete config[k];
    const passed = config as unknown as Parameters<typeof serverConfigProblems>[0];
    if (serverConfigProblems(passed).length > 0) return null;
    return resolveServerBinding(passed).transport === 'stdio' ? 'spawn' : 'dial';
  } catch {
    return null;
  }
};

export function hostVariableReferences(raw: AgentOverlayEntry): string[] {
  const refs: string[] = [];
  const entry = readOverlayEntry(raw).entry;
  if (!entry) return refs;
  const opened = openedBy(entry);
  if (opened === 'spawn') {
    if (namesHostVariable(entry.command)) refs.push('command');
    if (Array.isArray(entry.args) && entry.args.some(namesHostVariable)) refs.push('args');
    const env = envOf(entry);
    for (const name of Object.keys(env).sort()) {
      if (namesHostVariable(env[name]) && !hostSetsOverServer(name)) refs.push(`env ${name}`);
    }
  } else if (opened === 'dial') {
    if (namesHostVariable(entry.url)) refs.push('url');
    if (namesHostVariable(entry.token)) refs.push('token');
    if (namesHostVariable(entry.access)) refs.push('access');
  }
  return refs;
}

/**
 * agent-framework gives a stdio child its declared env and, for a short
 * allowlist (PATH, HOME, locale, proxies and the like), the host's own values.
 */
export function lostByReplacement(operator: ServerProvisions, raw: AgentOverlayEntry): string | null {
  const lost: string[] = [];
  const entry = readOverlayEntry(raw).entry;
  if (!entry || entry.disabled === true) return null;
  const opened = openedBy(entry);
  if (opened === null) return null;
  if (opened === 'spawn') {
    const declared = new Set(
      Object.entries(envOf(entry)).filter(([, value]) => !namesHostVariable(value)).map(([name]) => name),
    );
    const missing = operator.env.filter((name) => !declared.has(name) && !hostSetsOverServer(name));
    if (missing.length > 0) lost.push(`env ${missing.join(', ')}`);
    if (operator.inheritEnv) lost.push('inherited host environment (inheritEnv)');
  } else if (opened === 'dial') {
    const token = Boolean(entry.token) && !namesHostVariable(entry.token);
    if (operator.token && !token) lost.push('token');
    const access = typeof entry.access === 'string' ? entry.access : '';
    if (operator.access && access !== operator.access) lost.push(`access grant "${operator.access}"`);
  }
  for (const k of operator.grants) lost.push(LACKED_GRANT[k]);
  return lost.length > 0 ? lost.join('; ') : null;
}

function hostSetsOverServer(name: string): boolean {
  const mapped = '\u0000mapped';
  return composeMcplChildEnv({ [name]: mapped }, '')[name] !== mapped;
}

export function overlayEntryReplaces(entry: unknown): entry is AgentOverlayEntry {
  const read = entry === undefined ? undefined : readOverlayEntry(entry).entry;
  return read !== undefined && read.disabled !== true;
}

export function overlayWarnings(
  operatorServers: ReadonlyArray<{ id: string } & Record<string, unknown>>,
  overlayPath: string,
): string[] {
  const operatorById = new Map(operatorServers.map((server) => [server.id, server]));
  const lines: string[] = [];
  const { servers, otherKeys, notes } = readAgentOverlayFile(overlayPath);
  for (const note of notes) lines.push(`[mcpl] the agent overlay (${overlayPath}) ${note}`);
  if (otherKeys.length > 0) {
    lines.push(
      `[mcpl] the agent overlay (${overlayPath}) has keys besides mcplServers, ${otherKeys.map((k) => JSON.stringify(k)).join(', ')}, ` +
      'which the boot ignores: an entry or tombstone under a misspelled key doesn\'t load',
    );
  }
  for (const [id, entry] of Object.entries(servers)) {
    const reading = readOverlayEntry(entry);
    if (reading.problem !== undefined) {
      lines.push(
        `[mcpl] server "${id}": the agent overlay (${overlayPath}) entry is malformed (${reading.problem}), so the boot skips it` +
        (operatorById.has(id) ? ' and the operator\'s definition loads' : ''),
      );
      continue;
    }
    for (const note of reading.notes) {
      lines.push(`[mcpl] server "${id}": the agent overlay (${overlayPath}) entry loads, but ${note}`);
    }
    if (!overlayEntryReplaces(entry)) continue;
    const operator = operatorById.get(id);
    const lost = operator ? lostByReplacement(serverProvisions(operator), entry) : null;
    if (lost) {
      lines.push(
        `[mcpl] server "${id}": the agent overlay (${overlayPath}) replaces the operator's definition ` +
        `and lacks its ${lost}, so the server runs without the operator's values for them`,
      );
    }
    const refs = hostVariableReferences(entry);
    if (refs.length > 0) {
      lines.push(
        `[mcpl] server "${id}": the agent overlay (${overlayPath}) names a host variable in its ` +
        `${refs.join(', ')}, which only a recipe substitutes, so the server gets that text as written`,
      );
    }
  }
  return lines;
}

export function readMcplServersFile(configPath: string): Record<string, ServerFileEntry> {
  if (!existsSync(configPath)) return {};
  return (parseServersFile(configPath) as McplServersFile).mcplServers ?? {};
}

export function saveMcplServers(configPath: string, servers: Record<string, ServerFileEntry>): void {
  writeServersFile(configPath, servers);
}

/**
 * AgentFramework supplies DISCORD_SUPPRESSED_REACTIONS_BASELINE later,
 * where it knows its awareness marker and retained recovery outbox emojis.
 * A host-side refusal-only default would override that complete default.
 * Explicit operator env passes through unchanged, whatever its type. The
 * framework then lets a baseline with tokens, as the Discord adapter parses
 * them, replace its default, and reads any other value (blank, commas
 * alone, null) as unset. A non-string value counts as its string form, so
 * `false` or `0` replaces the default. For an inheritEnv entry, a baseline
 * with tokens in the host's own environment replaces it too.
 */
export function composeMcplChildEnv(
  serverEnv: Record<string, string> | undefined,
  timeZone: string,
): Record<string, string> {
  return {
    ...(serverEnv ?? {}),
    AGENT_TIMEZONE: timeZone,
  };
}
