// Offline stdio fixture only. No platform SDK, network, subscription, or bot.
import { createInterface } from 'node:readline';
const calls = [];
const tools = [
  { name: 'add_reaction', description: 'Fake ADD', inputSchema: { type: 'object', properties: {
    message_id: { type: ['string'] }, emoji_name: { type: 'string' },
    channelId: { type: 'string' }, messageId: { type: ['string', 'null'] }, emoji: { type: 'string' },
  } } },
  { name: 'filters_get', description: 'Fake suppression source', inputSchema: { type: 'object', properties: {} } },
  { name: 'read_calls', description: 'Read fake ADD calls', inputSchema: { type: 'object', properties: {} } },
];
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const rl = createInterface({ input: process.stdin });
rl.on('close', () => process.exit(0));
rl.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'notifications/initialized') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 900, method: 'channels/register', params: { channels: [{ id: 'discord:12345678901234567:23456789012345678', type: 'discord', label: 'offline', direction: 'bidirectional' }, { id: 'zulip:room', type: 'zulip', label: 'offline', direction: 'bidirectional' }] } }) + '\n');
    return;
  }
  if (message.id === undefined || !message.method) return;
  if (message.method === 'initialize') reply(message.id, { protocolVersion: '2024-11-05', capabilities: { tools: {}, experimental: { mcpl: { version: '0.5', channels: { register: true, incoming: true } } } }, serverInfo: { name: 'offline-refusal-fixture', version: '0.0.0' } });
  else if (message.method === 'tools/list') reply(message.id, { tools });
  else if (message.method === 'tools/call') {
    const { name, arguments: args } = message.params;
    if (name === 'add_reaction') calls.push(args);
    reply(message.id, { content: [{ type: 'text', text: JSON.stringify(name === 'read_calls' ? calls : name === 'filters_get'
      ? { reactionSuppression: { source: 'baseline-default', status: 'active', protectionActive: true } } : { added: true }) }] });
  } else reply(message.id, { accepted: true });
});
