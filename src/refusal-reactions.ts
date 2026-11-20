import { REFUSAL_REACTIONS, REFUSAL_REACTION_FALLBACK } from '@animalabs/agent-framework';
import { randomUUID } from 'node:crypto';
import type { AgentFramework, McplServerConfig, ToolDefinition, ToolResult } from '@animalabs/agent-framework';

// Structural optional facet: stock AF 0.33 recipes still load. No named runtime
// import of an unreleased AF export, no assertion of the entire framework class.
export interface Refusal {
  readonly agentName: string;
  readonly agentInstanceId: string;
  readonly turnId: number;
  readonly category: string;
  readonly rewind: 'handled' | 'unhandled';
  readonly origin?: Readonly<{ serverId: string; binding: string; channelId: string; threadId?: string; messageRef: string }>;
}
interface Bridge {
  version: 1;
  takeOwnership(handler: (refusal: Refusal) => Promise<void>): () => void;
  isCurrent(refusal: Refusal): boolean;
  serverBinding(id: string): string | undefined;
  /** Opaque configuration lifetime identity supplied by the bridge.
   * Automatic in-place reconnect preserves it; not executable/realm attestation. */
  serverEpoch(id: string): string | undefined;
}
export const DISCORD_REFUSAL_MARKERS: Readonly<Record<string, string>> = Object.freeze({
  ...REFUSAL_REACTIONS, unknown: REFUSAL_REACTION_FALLBACK,
});
export const DISCORD_SOURCE = 'dc80b2fba48308fdfe13a9920ff744ead0118c01';
export const ZULIP_SOURCE = '61298a12396c27e7cebc004f31cf67c958e35930';

type Discord = { kind: 'discord'; sourceRevision: typeof DISCORD_SOURCE };
type Zulip = {
  kind: 'zulip'; sourceRevision: typeof ZULIP_SOURCE;
  realmTag: string; idMode: 'strict' | 'compat' | 'legacy';
  /** Names must be preflighted by the operator for this realm; no live proof. */
  emojis: Record<string, string> & { unknown: string };
  availableEmojiNames: string[];
};
export type RefusalDriverConfig = { serverId: string } & (Discord | Zulip);
export interface RefusalReactionConfig {
  /** ALL Discord servers leave legacy ownership, even those not selected here. */
  ownership: 'whole-framework';
  servers: RefusalDriverConfig[];
}
type Surface = Pick<AgentFramework, 'executeToolCall' | 'getAllTools' | 'listMcplServers'> & {
  notifyOps?: (kind: string, agent: string, message: string, data?: Record<string, unknown>) => void;
};
const object = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;

/** Shape checks shared by recipe loading and direct runtime callers. Connector
 * contract checks remain in prepare, after child environments are composed. */
export function validateRefusalReactionConfig(value: unknown): asserts value is RefusalReactionConfig | undefined {
  if (value === undefined) return;
  const config = object(value);
  const fail = (path: string, requirement: string): never => { throw new Error(`Recipe mainRefusalReactions${path} ${requirement}`); };
  if (!config) fail('', 'must be an object');
  if (config!.ownership !== 'whole-framework') fail('.ownership', 'must be "whole-framework"');
  if (!Array.isArray(config!.servers)) fail('.servers', 'must be an array');
  const ids = new Set<string>();
  for (const [index, entry] of (config!.servers as unknown[]).entries()) {
    const driver = object(entry);
    let path = `.servers[${index}]`;
    if (!driver) fail(path, 'must be an object');
    if (typeof driver!.serverId !== 'string' || !driver!.serverId.trim()) fail(path + '.serverId', 'must be a nonempty string');
    const id = driver!.serverId as string;
    path += ` (${JSON.stringify(id)})`;
    if (ids.has(id)) fail(path, 'duplicates a refusal reaction server');
    ids.add(id);
    if (driver!.kind !== 'discord' && driver!.kind !== 'zulip') fail(path + '.kind', 'must be discord or zulip');
    if (typeof driver!.sourceRevision !== 'string' || !driver!.sourceRevision) fail(path + '.sourceRevision', 'must be a nonempty string');
    if (driver!.kind === 'zulip') {
      if (typeof driver!.realmTag !== 'string') fail(path + '.realmTag', 'must be a string');
      if (!['strict', 'compat', 'legacy'].includes(driver!.idMode as string)) fail(path + '.idMode', 'must be strict, compat or legacy');
      const emojis = object(driver!.emojis);
      if (!emojis || typeof emojis.unknown !== 'string' || !emojis.unknown || Object.values(emojis).some(e => typeof e !== 'string')) fail(path + '.emojis', 'must map categories to strings with a nonempty unknown fallback');
      if (!Array.isArray(driver!.availableEmojiNames) || driver!.availableEmojiNames.some(e => typeof e !== 'string')) fail(path + '.availableEmojiNames', 'must be an array of strings');
    }
  }
}

export function assertRefusalBridgeAvailable(value: unknown): void {
  if (typeof object(value)?.getMainRefusalBridge !== 'function') {
    throw new Error('mainRefusalReactions is unsupported by this Agent Framework; no handover was performed');
  }
}
function bridgeOf(value: unknown): Bridge {
  assertRefusalBridgeAvailable(value);
  const facet = (value as { getMainRefusalBridge(): unknown }).getMainRefusalBridge();
  const b = object(facet);
  if (b?.version !== 1 || typeof b.takeOwnership !== 'function' || typeof b.isCurrent !== 'function' || typeof b.serverBinding !== 'function' || typeof b.serverEpoch !== 'function') {
    throw new Error('Unsupported main refusal bridge capability');
  }
  return facet as Bridge;
}
const tokens = (raw: string | undefined) => (raw ?? '').split(',').map(s => s.trim()).filter(Boolean);
const emojiName = (v: string) => /^[a-z0-9_+-]+$/.test(v);

/** Prepare ONLY the explicit recipe's in-memory child config, never an operator
 * filter file, grant, persisted setting, subscription or connector repository. */
export function prepareRefusalReactions(config: RefusalReactionConfig | undefined, servers: McplServerConfig[]): McplServerConfig[] {
  validateRefusalReactionConfig(config);
  if (config === undefined) return servers;
  const prepared = servers.map(s => ({ ...s, env: { ...s.env } }));
  for (const driver of config.servers) {
    const serverId = driver.serverId;
    const matches = prepared.filter(s => s.id === driver.serverId);
    const server = matches[0];
    if (matches.length !== 1 || !server?.command || server.url || server.inheritEnv === true) throw new Error(`Refusal server ${driver.serverId}: requires one known stdio server with explicit child environment`);
    if (server.presentation === 'closed-tab') throw new Error(`Refusal server ${driver.serverId}: closed-tab selection is unsupported`);
    if (driver.kind === 'discord' && driver.sourceRevision === DISCORD_SOURCE) {
      // Omission preserves AF's per-spawn protective default, including retained
      // awareness markers. Validate coverage only for an operator replacement.
      const seed = server.env.DISCORD_SUPPRESSED_REACTIONS_BASELINE;
      if (seed !== undefined && Object.values(DISCORD_REFUSAL_MARKERS).some(e => !tokens(seed).includes(e))) throw new Error(`Refusal server ${driver.serverId}: Discord refusal suppression seed is incomplete`);
    } else if (driver.kind === 'zulip' && driver.sourceRevision === ZULIP_SOURCE) {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(driver.realmTag) || !['strict', 'compat', 'legacy'].includes(driver.idMode)) throw new Error('Invalid Zulip ID contract');
      if (!driver.emojis?.unknown || Object.values(driver.emojis).some(e => !emojiName(e) || !driver.availableEmojiNames?.includes(e))) throw new Error('Zulip emoji names require explicit realm preflight');
      if (server.env.ZULIP_ID_MODE !== driver.idMode || server.env.ZULIP_REALM_TAG !== driver.realmTag) throw new Error('Zulip driver does not match the configured child ID contract');
      // The reviewed fork ALWAYS unions this NAME baseline with operator filters.
      server.env.ZULIP_SUPPRESSED_REACTIONS_BASELINE = [...new Set([
        ...tokens(server.env.ZULIP_SUPPRESSED_REACTIONS_BASELINE), ...Object.values(driver.emojis),
      ])].join(',');
    } else throw new Error(`Refusal server ${serverId}: unsupported source contract`);
    Object.freeze(server.env);
    if (server.args) server.args = Object.freeze([...server.args]) as string[];
    Object.freeze(server);
  }
  return prepared;
}

function acceptsString(property: unknown): boolean {
  const type = object(property)?.type;
  return type === 'string' || (Array.isArray(type) && type.includes('string'));
}
function schemaAccepts(tool: ToolDefinition | undefined, args: Record<string, string>): boolean {
  const schema = object(tool?.inputSchema);
  const properties = object(schema?.properties);
  if (!properties || schema?.type !== 'object' || Object.keys(schema).some(k => !['type', 'properties', 'required', 'additionalProperties', 'description', '$schema', 'title'].includes(k))) return false;
  if (schema.required !== undefined && !Array.isArray(schema.required)) return false;
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') return false;
  if (Object.keys(args).some(k => !acceptsString(properties[k]) || Object.keys(object(properties[k])!).some(p => !['type', 'description', 'title'].includes(p)))) return false;
  return !Array.isArray(schema.required) || schema.required.every(k => typeof k === 'string' && Object.hasOwn(args, k));
}
function zulipRef(id: string, driver: Zulip): boolean {
  if (driver.idMode === 'legacy') return false; // numeric-only schema: no coercion
  const match = /^([a-z0-9][a-z0-9_-]{0,63}):([0-9]+)$/.exec(id);
  const digits = match ? (match[1] === driver.realmTag ? match[2] : undefined)
    : driver.idMode === 'compat' && /^[0-9]+$/.test(id) ? id : undefined;
  // Bound parsing resources and preserve the ORIGINAL opaque token for tools/call.
  return digits !== undefined && digits.length <= 16 && BigInt(digits) > 0n && BigInt(digits) <= 9007199254740991n;
}
function payload(result: ToolResult): Record<string, unknown> | undefined {
  if (!result.success || result.isError) return undefined;
  if (typeof result.data === 'string') {
    try { return object(JSON.parse(result.data)); } catch { return undefined; }
  }
  const direct = object(result.data);
  if (direct) return direct;
  if (Array.isArray(result.data) && result.data.length === 1) {
    const block = object(result.data[0]);
    if (block?.type === 'text' && typeof block.text === 'string') {
      try { return object(JSON.parse(block.text)); } catch { return undefined; }
    }
  }
  return undefined;
}

/** ADD only. Bounded in-memory turn dedup; attempts, including unknown acks, are
 * consumed BEFORE I/O. No retry, deletion, new inference, or persistent guarantee.
 * Snapshots the bridge's opaque lifetime identity. Replacement fails closed
 * with ownership retained; the host offers no runtime rearm. */
export function installRefusalReactions(framework: Surface, config: RefusalReactionConfig, prepared: McplServerConfig[],
  diagnostic: (status: string) => void = status => console.error(`[refusal-reaction] ${status}`),
): () => void {
  const bridge = bridgeOf(framework);
  // Revalidate and freeze operator configuration; a later recipe mutation cannot
  // change the emitted markers without changing the child's protective seed.
  const drivers = structuredClone(config);
  const validated = prepareRefusalReactions(drivers, prepared);
  const bindings = new Map(validated.map(s => [s.id, bridge.serverBinding(s.id)]));
  const epochs = new Map(validated.map(s => [s.id, bridge.serverEpoch(s.id)]));
  for (const driver of drivers.servers) {
    const rows = framework.listMcplServers().filter(s => s.id === driver.serverId);
    if (rows.length !== 1 || !rows[0]!.connected || rows[0]!.transport !== 'stdio' || rows[0]!.refused !== null
      || bindings.get(driver.serverId) === undefined || epochs.get(driver.serverId) === undefined) {
      throw new Error(`Refusal server ${driver.serverId}: must be connected with a supported binding and epoch before ownership; closed tabs and failed connects are unsupported`);
    }
  }
  const alerted = new Set<string>();
  const seen = new Set<string>();
  let pending = 0;
  let active = true;
  const release = bridge.takeOwnership(async refusal => {
    if (!active) return;
    const report = (status: string) => {
      const data = { serverId: refusal.origin?.serverId ?? null, agentName: refusal.agentName, turnId: refusal.turnId, category: refusal.category };
      diagnostic(`${status} ${JSON.stringify(data)}`);
      if (active && bridge.isCurrent(refusal) && refusal.origin && !status.startsWith('add-acknowledged') && !alerted.has(refusal.origin.serverId)) {
        alerted.add(refusal.origin.serverId);
        framework.notifyOps?.('refusal-reaction-unavailable', refusal.agentName,
          `Refusal marker unavailable on ${refusal.origin.serverId}: ${status}`, { ...data, status });
      }
    };
    const key = JSON.stringify([refusal.agentInstanceId, refusal.turnId]);
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 1024) seen.delete(seen.values().next().value!);
    if (refusal.rewind === 'handled') return;
    if (!refusal.origin) { report('unknown-origin: local diagnostic only; no first-refusal home fallback'); return; }
    const origin = refusal.origin;
    const driver = drivers.servers.find(d => d.serverId === origin.serverId);
    if (!driver) { report('unsupported-driver'); return; }
    const current = () => active && bridge.isCurrent(refusal) && bindings.get(origin.serverId) !== undefined
      && bindings.get(origin.serverId) === origin.binding && bridge.serverBinding(origin.serverId) === origin.binding
      && epochs.get(origin.serverId) !== undefined && epochs.get(origin.serverId) === bridge.serverEpoch(origin.serverId);
    const servers = framework.listMcplServers().filter(s => s.id === origin.serverId);
    const server = servers.length === 1 ? servers[0] : undefined;
    if (!current() || !server?.connected || server.transport !== 'stdio' || server.refused !== null) { report('stale-or-unsupported-server'); return; }
    // The advertised tools are the framework's effective, capability-filtered
    // surface. executeToolCall additionally enforces the named agent's allowlist.
    const prefix = server.toolPrefix;
    const toolName = `${prefix}--add_reaction`;
    const advertised = (name: string) => {
      const matches = framework.getAllTools().filter(t => t.name === name);
      return matches.length === 1 ? matches[0] : undefined;
    };
    let args: Record<string, string>;
    if (driver.kind === 'discord') {
      // Documented canonical connector contract; NEVER blind split/last segment.
      if (!/^discord:(?:dm|[0-9]{17,20}):[0-9]{17,20}$/.test(origin.channelId) || !/^[0-9]{17,20}$/.test(origin.messageRef)) { report('unsupported-discord-id'); return; }
      args = { channelId: origin.channelId, messageId: origin.messageRef,
        emoji: Object.hasOwn(DISCORD_REFUSAL_MARKERS, refusal.category) ? DISCORD_REFUSAL_MARKERS[refusal.category]! : DISCORD_REFUSAL_MARKERS.unknown! };
    } else {
      if (!zulipRef(origin.messageRef, driver)) { report('unsupported-zulip-id'); return; }
      args = { message_id: origin.messageRef,
        emoji_name: Object.hasOwn(driver.emojis, refusal.category) ? driver.emojis[refusal.category]! : driver.emojis.unknown };
    }
    if (!schemaAccepts(advertised(toolName), args)) { report('unsupported-reaction-schema-or-capability'); return; }
    if (pending >= 8) { report('effect-capacity-exhausted'); return; }
    pending++;
    try {
      if (driver.kind === 'discord') {
        const name = `${prefix}--filters_get`;
        if (!schemaAccepts(advertised(name), {})) { report('unsupported-suppression-preflight'); return; }
        const status = object(payload(await framework.executeToolCall({ id: randomUUID(), name, input: {}, callerAgentName: refusal.agentName }))?.reactionSuppression);
        // Source, not a count/digest: only the known injected baseline is proof.
        // Operator-owned overrides remain opaque and are honestly unsupported.
        if (status?.source !== 'baseline-default' || status.status !== 'active' || status.protectionActive !== true) { report('unsupported-discord-suppression-source'); return; }
      }
      if (!current() || framework.listMcplServers().find(s => s.id === origin.serverId)?.toolPrefix !== prefix
        || !schemaAccepts(advertised(toolName), args)) { report('binding-or-instance-changed'); return; }
      const result = await framework.executeToolCall({ id: randomUUID(), name: toolName, input: args, callerAgentName: refusal.agentName });
      report(result.success && !result.isError ? 'add-acknowledged: not proof of human receipt or cause' : 'add-failed-or-unknown: no retry');
    } catch { report('add-or-preflight-ack-unknown: no retry'); }
    finally { pending--; }
  });
  return () => { active = false; release(); };
}
