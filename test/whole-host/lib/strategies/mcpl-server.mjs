#!/usr/bin/env node
import { connect } from 'node:net';
import { lineReader } from './control.mjs';
import { KINDS, toolResult } from './results.mjs';

const PROTOCOL_VERSION = '2024-11-05';
const FEATURE_SET = 'fixture';

const TOOL = {
  name: 'result',
  description: 'Returns a result of the asked kind and size, carrying the canary.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: KINDS },
      size: { type: 'integer', description: 'Characters, for prose, code and json; for mixed, the two texts\' together.' },
      canary: { type: 'string' },
      width: { type: 'integer', description: 'Pixels, for image and mixed.' },
      height: { type: 'integer', description: 'Pixels, for image and mixed.' },
      hold: { type: 'boolean', description: 'Answer only when the fixture releases this canary.' },
    },
    required: ['kind', 'canary'],
  },
};

function serve() {
  const log = (...parts) => console.error('[fixture-mcpl]', ...parts);
  const toHost = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  const channels = (process.env.FIXTURE_CHANNELS ?? '').split(',').map((c) => c.trim()).filter(Boolean);
  const boot = process.env.FIXTURE_BOOT ?? '0';
  let published = 0;
  const waitingOnHost = new Map();
  const held = new Map();
  let nextId = 1;
  let control = null;
  let registering = false;
  let markRegistered;
  const registered = new Promise((resolve) => { markRegistered = resolve; });

  const askHost = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    waitingOnHost.set(id, resolve);
    toHost({ id, method, params });
  });

  const register = async () => {
    registering = true;
    const descriptors = channels.map((id) => ({ id, type: 'chat', label: id, direction: 'bidirectional', initiallyOpen: true }));
    const answer = await askHost('channels/register', { channels: descriptors });
    const refused = answer.error
      ? [answer.error.message]
      : channels.filter((id) => !answer.result?.results?.find((r) => r.id === id)?.accepted)
        .map((id) => `${id}: ${answer.result?.results?.find((r) => r.id === id)?.reason ?? 'no result for it'}`);
    if (refused.length) log(`channels/register refused: ${refused.join('; ')}`);
    markRegistered(refused);
  };

  const mcpl = {
    version: '0.5',
    featureSets: [{ name: FEATURE_SET, description: 'The strategy fixture\'s sized tool results', uses: ['tools'], rollback: false }],
    ...(channels.length ? { channels: { register: true, incoming: true, publish: true } } : {}),
  };
  const answer = (msg) => {
    switch (msg.method) {
      case 'initialize':
        return {
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {}, experimental: { mcpl } },
            serverInfo: { name: 'connectome-smoke-fixture', version: '0.0.0' },
          },
        };
      case 'ping': return { result: {} };
      case 'featureSets/update': return { result: { accepted: true, mode: 'full', unavailableFeatures: [] } };
      case 'tools/list': return { result: { tools: [TOOL] } };
      case 'channels/publish':
        if (!channels.includes(msg.params?.channelId)) return { result: { delivered: false, reason: `no channel ${JSON.stringify(msg.params?.channelId)} here` } };
        return { result: { delivered: true, messageId: `pub-${boot}-${++published}`, ...('threadId' in (msg.params ?? {}) ? { threadId: msg.params.threadId } : {}) } };
      case 'tools/call':
        if (msg.params?.name !== TOOL.name) return { error: { code: -32602, message: `unknown tool ${JSON.stringify(msg.params?.name)}` } };
        return { result: toolResult(msg.params.arguments) };
      default: return { error: { code: -32601, message: `Method not found: ${msg.method}` } };
    }
  };

  lineReader(process.stdin, (msg) => {
    if (typeof msg.method === 'string') {
      if (msg.id === undefined || msg.id === null) return;
      const args = msg.params?.arguments;
      if (msg.method === 'tools/call' && msg.params?.name === TOOL.name && args?.hold === true && typeof args.canary === 'string') {
        held.set(args.canary, msg);
        control?.write(`${JSON.stringify({ type: 'notice', notice: 'held', canary: args.canary })}\n`);
        return;
      }
      toHost({ id: msg.id, ...answer(msg) });
      if (msg.method === 'featureSets/update' && channels.length && !registering) register();
      return;
    }
    const waiting = waitingOnHost.get(msg.id);
    if (!waiting) return;
    waitingOnHost.delete(msg.id);
    waiting(msg);
  });
  process.stdin.on('end', () => { control?.end(); process.exit(0); });

  const incoming = (m) => {
    if (!channels.includes(m.channelId)) return `channel ${JSON.stringify(m.channelId)} isn't one this server registers (FIXTURE_CHANNELS: ${channels.join(', ') || 'none'})`;
    if (typeof m.messageId !== 'string' || m.messageId === '') return 'messageId must be a non-empty string';
    if (typeof m.author?.id !== 'string' || typeof m.author?.name !== 'string') return 'author must be { id, name }, both strings';
    if (typeof m.text !== 'string' || m.text === '') return 'text must be a non-empty string';
    if (!Number.isFinite(m.at)) return 'at must be a time in milliseconds';
    if (m.topic !== undefined && typeof m.topic !== 'string') return 'topic must be a string when given';
    if (m.images !== undefined && !(Array.isArray(m.images) && m.images.every((i) => typeof i?.data === 'string' && typeof i?.mimeType === 'string'))) return 'images must be a list of { data, mimeType } when given';
    if (m.tags !== undefined && !(Array.isArray(m.tags) && m.tags.every((t) => typeof t === 'string'))) return 'tags must be a list of strings when given';
    return {
      channelId: m.channelId,
      messageId: m.messageId,
      author: { id: m.author.id, name: m.author.name },
      timestamp: new Date(m.at).toISOString(),
      content: [{ type: 'text', text: m.text }, ...(m.images ?? []).map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType }))],
      ...(m.topic !== undefined ? { metadata: { topic: m.topic } } : {}),
      ...(m.tags !== undefined ? { tags: m.tags } : {}),
    };
  };

  const path = process.env.FIXTURE_CONTROL;
  if (!path) return;
  const relay = (id, msg) => control?.write(`${JSON.stringify(msg.error ? { id, error: msg.error } : { id, result: msg.result })}\n`);
  control = connect(path, () => control.write(`${JSON.stringify({ type: 'hello', peer: 'server', pid: process.pid })}\n`));
  control.on('error', (e) => { log(`control socket ${path}: ${e.message}`); control = null; });
  lineReader(control, async (msg) => {
    if (msg.op === 'host') {
      relay(msg.id, await askHost('host/command', msg.params));
    } else if (msg.op === 'deliver') {
      const item = incoming(msg.message ?? {});
      if (typeof item === 'string') return relay(msg.id, { error: { code: -32602, message: item } });
      const refused = await registered;
      if (refused.length) return relay(msg.id, { error: { code: -32002, message: `the host refused this server's channels: ${refused.join('; ')}` } });
      relay(msg.id, await askHost('channels/incoming', { messages: [item] }));
    } else if (msg.op === 'release') {
      const call = held.get(msg.canary);
      if (!call) return relay(msg.id, { error: { code: -32602, message: `no call carrying ${JSON.stringify(msg.canary)} is held` } });
      held.delete(msg.canary);
      toHost({ id: call.id, result: toolResult(call.params.arguments) });
      relay(msg.id, { result: { released: msg.canary } });
    }
  });
}

serve();
