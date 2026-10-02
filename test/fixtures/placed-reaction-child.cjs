const { createInterface } = require('node:readline');
const reply = (id, result) => console.log(JSON.stringify({ jsonrpc: '2.0', id, result }));
const rl = createInterface({ input: process.stdin });
rl.on('close', () => process.exit(0));
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.id == null || !msg.method) return;
  if (msg.method === 'initialize') reply(msg.id, {
    protocolVersion: '2024-11-05', capabilities: { tools: {} },
    serverInfo: { name: 'env-probe', version: '0.0.0' },
  });
  else if (msg.method === 'tools/list') reply(msg.id, { tools: [] });
  else if (msg.method === 'tools/call') reply(msg.id, { content: [{
    type: 'text', text: JSON.stringify({
      baseline: process.env.DISCORD_SUPPRESSED_REACTIONS_BASELINE,
      timeZone: process.env.AGENT_TIMEZONE,
      extra: process.env.EXTRA,
    }),
  }] });
  else reply(msg.id, {});
});
