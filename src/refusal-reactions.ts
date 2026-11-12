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
  /** Config OBJECT + connection OBJECT identity, not transportEpoch/child PID.
   * Automatic in-place reconnect preserves it; not executable/realm attestation. */
  serverEpoch(id: string): string | undefined;
}
export const DISCORD_REFUSAL_MARKERS: Readonly<Record<string, string>> = Object.freeze({
  bio: '☣️', chem: '🧪', nuclear: '☢️', cyber: '💻', reasoning_extraction: '🧠', unknown: '🛑',
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
type Surface = Pick<AgentFramework, 'executeToolCall' | 'getAllTools' | 'listMcplServers'>;
const object = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;

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
  if (config === undefined) return servers;
  if (config.ownership !== 'whole-framework' || !Array.isArray(config.servers)) throw new Error('Explicit whole-framework refusal ownership is required');
  const ids = new Set<string>();
  const prepared = servers.map(s => ({ ...s, env: { ...s.env } }));
  for (const driver of config.servers) {
    if (ids.has(driver.serverId)) throw new Error('Duplicate refusal reaction server');
    ids.add(driver.serverId);
    const matches = prepared.filter(s => s.id === driver.serverId);
    const server = matches[0];
    if (matches.length !== 1 || !server?.command || server.url || server.inheritEnv === true) throw new Error('Refusal drivers require one known stdio server with explicit child environment');
    if (driver.kind === 'discord' && driver.sourceRevision === DISCORD_SOURCE) {
      // A matching EXPLICIT seed is required: never assume the host's inherited
      // baseline has these markers. No hidden operator list is read or changed.
      const seed = server.env.DISCORD_SUPPRESSED_REACTIONS_BASELINE;
      if (seed === undefined || Object.values(DISCORD_REFUSAL_MARKERS).some(e => !tokens(seed).includes(e))) throw new Error('Discord refusal suppression seed is incomplete');
    } else if (driver.kind === 'zulip' && driver.sourceRevision === ZULIP_SOURCE) {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(driver.realmTag) || !['strict', 'compat', 'legacy'].includes(driver.idMode)) throw new Error('Invalid Zulip ID contract');
      if (!driver.emojis?.unknown || Object.values(driver.emojis).some(e => !emojiName(e) || !driver.availableEmojiNames?.includes(e))) throw new Error('Zulip emoji names require explicit realm preflight');
      if (server.env.ZULIP_ID_MODE !== driver.idMode || server.env.ZULIP_REALM_TAG !== driver.realmTag) throw new Error('Zulip driver does not match the configured child ID contract');
      // The reviewed fork ALWAYS unions this NAME baseline with operator filters.
      server.env.ZULIP_SUPPRESSED_REACTIONS_BASELINE = [...new Set([
        ...tokens(server.env.ZULIP_SUPPRESSED_REACTIONS_BASELINE), ...Object.values(driver.emojis),
      ])].join(',');
    } else throw new Error('Unsupported refusal connector source contract');
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
 * V1 snapshots config/connection OBJECT identity, not transport reconnects.
 * Object replacement fails closed with ownership retained (no legacy fallback).
 * Host startup discards this disposer and offers no runtime reinstall/rearm API:
 * selected connector replacement/restart/deploy requires a fresh full Host
 * process restart with normal config prepare/install. An issued ADD cannot be
 * undone. This lifetime limitation is not a liveness fix. */
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
  const seen = new Set<string>();
  let pending = 0;
  let active = true;
  const release = bridge.takeOwnership(async refusal => {
    if (!active) return;
    const key = JSON.stringify([refusal.agentInstanceId, refusal.turnId]);
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 1024) seen.delete(seen.values().next().value!);
    if (refusal.rewind === 'handled') return;
    if (!refusal.origin) { diagnostic('unknown-origin: local diagnostic only; no first-refusal home fallback'); return; }
    const origin = refusal.origin;
    const driver = drivers.servers.find(d => d.serverId === origin.serverId);
    if (!driver) { diagnostic('unsupported-driver: local diagnostic only'); return; }
    const current = () => active && bridge.isCurrent(refusal) && bindings.get(origin.serverId) !== undefined
      && bindings.get(origin.serverId) === origin.binding && bridge.serverBinding(origin.serverId) === origin.binding
      && epochs.get(origin.serverId) !== undefined && epochs.get(origin.serverId) === bridge.serverEpoch(origin.serverId);
    const servers = framework.listMcplServers().filter(s => s.id === origin.serverId);
    const server = servers.length === 1 ? servers[0] : undefined;
    if (!current() || !server?.connected || server.transport !== 'stdio' || server.refused !== null) { diagnostic('stale-or-unsupported-server'); return; }
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
      if (!/^discord:(?:dm|[0-9]{17,20}):[0-9]{17,20}$/.test(origin.channelId) || !/^[0-9]{17,20}$/.test(origin.messageRef)) { diagnostic('unsupported-discord-id'); return; }
      args = { channelId: origin.channelId, messageId: origin.messageRef,
        emoji: Object.hasOwn(DISCORD_REFUSAL_MARKERS, refusal.category) ? DISCORD_REFUSAL_MARKERS[refusal.category]! : DISCORD_REFUSAL_MARKERS.unknown! };
    } else {
      if (!zulipRef(origin.messageRef, driver)) { diagnostic('unsupported-zulip-id'); return; }
      args = { message_id: origin.messageRef,
        emoji_name: Object.hasOwn(driver.emojis, refusal.category) ? driver.emojis[refusal.category]! : driver.emojis.unknown };
    }
    if (!schemaAccepts(advertised(toolName), args)) { diagnostic('unsupported-reaction-schema-or-capability'); return; }
    if (pending >= 8) { diagnostic('effect-capacity-exhausted'); return; }
    pending++;
    try {
      if (driver.kind === 'discord') {
        const name = `${prefix}--filters_get`;
        if (!schemaAccepts(advertised(name), {})) { diagnostic('unsupported-suppression-preflight'); return; }
        const status = object(payload(await framework.executeToolCall({ id: randomUUID(), name, input: {}, callerAgentName: refusal.agentName }))?.reactionSuppression);
        // Source, not a count/digest: only the known injected baseline is proof.
        // Operator-owned overrides remain opaque and are honestly unsupported.
        if (status?.source !== 'baseline-default' || status.status !== 'active' || status.protectionActive !== true) { diagnostic('unsupported-discord-suppression-source'); return; }
      }
      if (!current() || framework.listMcplServers().find(s => s.id === origin.serverId)?.toolPrefix !== prefix
        || !schemaAccepts(advertised(toolName), args)) { diagnostic('binding-or-instance-changed'); return; }
      const result = await framework.executeToolCall({ id: randomUUID(), name: toolName, input: args, callerAgentName: refusal.agentName });
      diagnostic(result.success && !result.isError ? 'add-acknowledged: not proof of human receipt or cause' : 'add-failed-or-unknown: no retry');
    } catch { diagnostic('add-or-preflight-ack-unknown: no retry'); }
    finally { pending--; }
  });
  return () => { active = false; release(); };
}
