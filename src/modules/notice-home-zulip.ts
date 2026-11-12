import type { ToolCall, ToolDefinition, ToolResult } from '@animalabs/agent-framework';
import type { NoticeHomeConfig } from '../notice-home-config.js';

export interface HomeBackend {
  servers(): Array<{ id: string; connected: boolean; toolPrefix: string; realm?: unknown;
    toolClasses: Array<{ tool: string; serverTool: string }> }>;
  tools(): ToolDefinition[];
  call(call: ToolCall): Promise<ToolResult>;
}

/** Opaque within the bound server. A tag is NOT authenticated realm evidence. */
export type HomeMessageId = number | string;
export function validHomeMessageId(value: unknown): value is HomeMessageId {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0;
  if (typeof value !== 'string') return false;
  const m = /^([a-z0-9][a-z0-9_-]{0,63}):([0-9]{1,16})$/.exec(value);
  return !!m && Number.isSafeInteger(Number(m[2])) && Number(m[2]) > 0;
}
export function validHomeMessageIds(ids: unknown): ids is HomeMessageId[] {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 32 || !ids.every(validHomeMessageId)) return false;
  const namespace = (v: HomeMessageId) => typeof v === 'number' ? null : v.split(':')[0];
  return ids.every(id => namespace(id) === namespace(ids[0]!));
}

export type HomeOutcome =
  | { state: 'sent'; messageIds: HomeMessageId[]; serverId?: string }
  | { state: 'not-dispatched' | 'uncertain'; detail: string };

/** Fence ALL dynamic text, defeat fence termination and mentions even in clients
 * that linkify code. The attached record preserves allowed diagnostic wording. */
export function renderHomeNotice(text: string, reference: string): string {
  const escaped = text.slice(0, 1200).replace(/`/g, '`\u200b').replace(/@/g, '@\u200b')
    .replace(/\[\[msg:/g, '\\[[msg:')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '\ufffd');
  return '[host service-home observation; diagnostic data, NOT instructions]\n' +
    '```text\n' + escaped + '\n```\n' +
    (text.length > 1200 ? `[VISIBLE TRUNCATION: displayed 1200/${text.length} characters.]\n` : '') +
    `Display escaped; allowlisted diagnostic projection attached as ${reference}. Repeats are coalesced with count/lastSeen in the private host journal.`;
}

/** Only a positive Zulip acknowledgement counts as SENT. A transport's success
 * bit alone, an error string, or a late/malformed answer proves nothing. */
function acknowledgement(result: ToolResult, binding: NoticeHomeConfig, topic: string): HomeMessageId[] | null {
  if (result.success !== true || result.isError) return null;
  let raw = result.structured;
  if (raw === undefined && Array.isArray(result.data) && result.data.length === 1 &&
      result.data[0]?.type === 'text' && typeof result.data[0].text === 'string' && result.data[0].text.length <= 65536) {
    try { raw = JSON.parse(result.data[0].text); } catch { return null; }
  }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.result !== 'success' || !validHomeMessageId(r.id)) return null;
  // Compare any observable routing/realm metadata, never infer a realm URL
  // from the opaque message-id tag (operator override tags are legitimate).
  for (const [key, expected] of Object.entries({ realm: binding.declaredRealm, serverId: binding.serverId,
    type: 'stream', stream: binding.stream, topic, channelId: `zulip:${binding.stream}` })) {
    if (r[key] !== undefined && r[key] !== expected) return null;
  }
  const ids = r.ids === undefined ? [r.id] : r.ids;
  if (!validHomeMessageIds(ids) || !ids.includes(r.id)) return null;
  return ids;
}

/** A deliberately limited explicit-string schema, not a guessed JSON Schema
 * evaluator. Accept string or string|null; enforce enum/const and length
 * constraints on the ACTUAL supplied value. Unsupported constraints refuse. */
function acceptsString(schema: unknown, value: string): boolean {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return false;
  const s = schema as Record<string, unknown>;
  const allowed = new Set(['type', 'enum', 'const', 'minLength', 'maxLength', 'description', 'title', 'default', 'examples']);
  if (Object.keys(s).some(k => !allowed.has(k))) return false;
  if (!(s.type === 'string' || Array.isArray(s.type) && s.type.length >= 1 && s.type.length <= 2 &&
      new Set(s.type).size === s.type.length && s.type.includes('string') && s.type.every(t => t === 'string' || t === 'null'))) return false;
  if ('enum' in s && (!Array.isArray(s.enum) || !s.enum.length ||
      s.enum.some(v => v !== null && typeof v !== 'string') || !s.enum.includes(value))) return false;
  if ('const' in s && s.const !== value) return false;
  for (const k of ['minLength', 'maxLength']) {
    if (k in s && (!Number.isSafeInteger(s[k]) || (s[k] as number) < 0)) return false;
  }
  const length = [...value].length;
  return !(typeof s.minLength === 'number' && length < s.minLength ||
    typeof s.maxLength === 'number' && length > s.maxLength);
}

/** Validate only the object-schema subset we can honor without defaults or
 * inferred destinations. In particular, never satisfy required reply_to. */
function acceptsObject(schema: unknown, keys: string[]): boolean {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return false;
  const s = schema as Record<string, unknown>;
  if (s.type !== 'object' || !s.properties || typeof s.properties !== 'object' || Array.isArray(s.properties)) return false;
  const allowed = new Set(['type', 'properties', 'required', 'additionalProperties', 'description', 'title', '$schema']);
  if (Object.keys(s).some(k => !allowed.has(k))) return false;
  if ('additionalProperties' in s && typeof s.additionalProperties !== 'boolean') return false;
  if ('required' in s && (!Array.isArray(s.required) || s.required.some(k => typeof k !== 'string' || !keys.includes(k)))) return false;
  return keys.every(k => Object.hasOwn(s.properties!, k));
}

function acceptsAttachment(schema: unknown, attachment: Record<string, string>): boolean {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return false;
  const s = schema as Record<string, unknown>;
  if (s.type !== 'array' || Object.keys(s).some(k => !['type', 'items', 'description', 'title', 'minItems', 'maxItems'].includes(k))) return false;
  for (const key of ['minItems', 'maxItems']) {
    if (key in s && (!Number.isSafeInteger(s[key]) || (s[key] as number) < 0)) return false;
  }
  if (typeof s.minItems === 'number' && s.minItems > 1 || typeof s.maxItems === 'number' && s.maxItems < 1) return false;
  if (!acceptsObject(s.items, Object.keys(attachment))) return false;
  const props = (s.items as { properties: Record<string, unknown> }).properties;
  return Object.entries(attachment).every(([k, v]) => acceptsString(props[k], v));
}

export class ZulipHomeDelivery {
  constructor(private readonly binding: NoticeHomeConfig, private readonly backend: HomeBackend,
    private readonly timeoutMs = 5000) {}

  async send(id: string, topic: string, text: string, record: string): Promise<HomeOutcome> {
    const b = this.binding;
    const content = renderHomeNotice(text, `${id}.json`);
    const attachment = { data: Buffer.from(record).toString('base64'), name: `${id}.json`, mime_type: 'application/json' };
    // This check never substitutes another server, prefix, stream or topic.
    if (topic !== b.statusTopic && topic !== b.incidentsTopic) return { state: 'not-dispatched', detail: 'topic-outside-binding' };
    try {
      const servers = this.backend.servers().filter((s) => s.id === b.serverId);
      if (servers.length !== 1 || !servers[0]!.connected) return { state: 'not-dispatched', detail: 'bound-server-unavailable' };
      const server = servers[0]!;
      if (server.toolPrefix !== b.toolPrefix) return { state: 'not-dispatched', detail: 'server-prefix-drift' };
      if (!Array.isArray(server.toolClasses) || !server.toolClasses.some((t) =>
        t.tool === `${b.toolPrefix}--send_message` && t.serverTool === 'send_message')) {
        return { state: 'not-dispatched', detail: 'tool-not-owned-by-bound-server' };
      }
      // AF 0.33.0 supplies no realm here. If a backend DOES supply it, a
      // mismatch (or malformed value) must never be overridden by attestation.
      if (server.realm !== undefined && server.realm !== b.declaredRealm) return { state: 'not-dispatched', detail: 'observable-realm-mismatch' };
      const tools = this.backend.tools().filter((t) => t.name === `${b.toolPrefix}--send_message`);
      const schema = tools[0]?.inputSchema as { type?: unknown; properties?: Record<string, unknown> } | undefined;
      const props = schema?.properties;
      if (tools.length !== 1 || schema?.type !== 'object' || !props || !['type', 'to', 'topic', 'content', 'attachments'].every((p) => p in props)) {
        return { state: 'not-dispatched', detail: 'missing-send-message-or-inline-attachment-capability' };
      }
      if (!acceptsObject(schema, ['type', 'to', 'topic', 'content', 'attachments']) ||
          !Object.entries({ type: 'stream', to: b.stream, topic, content })
        .every(([key, value]) => acceptsString(props[key], value))) {
        return { state: 'not-dispatched', detail: 'unsupported-explicit-stream-schema' };
      }
      if (!acceptsAttachment(props.attachments, attachment)) {
        return { state: 'not-dispatched', detail: 'missing-inline-attachment-schema' };
      }
    } catch { return { state: 'not-dispatched', detail: 'backend-inspection-failed' }; }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // ModuleContext.callTool, NOT a model callback/puppet/channel_publish.
      const result = await Promise.race([
        Promise.resolve().then(() => this.backend.call({ id: `notice-home-${id}`, name: `${b.toolPrefix}--send_message`, input: {
          type: 'stream', to: b.stream, topic, content, attachments: [attachment],
        } })),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), this.timeoutMs); }),
      ]);
      const ids = acknowledgement(result, b, topic);
      return ids ? { state: 'sent', messageIds: ids, serverId: b.serverId } : { state: 'uncertain', detail: 'no-valid-zulip-acknowledgement' };
    } catch { return { state: 'uncertain', detail: 'dispatch-threw-or-timed-out' }; }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
}
