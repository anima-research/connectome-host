/**
 * Zulip Knowledge Extraction App
 *
 * TUI-driven social knowledge extraction from Zulip.
 *
 * Usage:
 *   npm start
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY   - Required
 *   ZULIP_MCP_CMD       - Path to Zulip MCP server (default: node ../zulip-mcp/build/index.js)
 *   ZULIPRC             - Path to .zuliprc file (for Zulip MCP)
 *   MODEL               - Model to use (default: claude-sonnet-4-5-20250929)
 *   STORE_PATH          - Chronicle store path (default: ./data/store)
 */

import 'dotenv/config';
import React from 'react';
import { render } from 'ink';
import { Membrane, AnthropicAdapter, NativeFormatter } from 'membrane';
import { AgentFramework, PassthroughStrategy } from '@connectome/agent-framework';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from './tui/app.js';
import { SYSTEM_PROMPT } from './prompts/system.js';
import { SubagentModule } from './modules/subagent-module.js';
import { LessonsModule } from './modules/lessons-module.js';
import { RetrievalModule } from './modules/retrieval-module.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const config = {
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: process.env.MODEL || 'claude-sonnet-4-5-20250929',
  storePath: process.env.STORE_PATH || './data/store',
  zulipMcpCmd: process.env.ZULIP_MCP_CMD || 'node',
  zulipMcpArgs: process.env.ZULIP_MCP_ARGS?.split(' ') || [resolve(__dirname, '../../zulip-mcp/build/index.js')],
  zuliprc: process.env.ZULIP_RC_PATH || resolve(process.cwd(), '.zuliprc'),
};

if (!config.apiKey) {
  console.error('Missing ANTHROPIC_API_KEY. Set it in .env or environment.');
  process.exit(1);
}

async function main() {
  const adapter = new AnthropicAdapter({ apiKey: config.apiKey! });
  const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });

  // Build env for Zulip MCP subprocess
  const zulipEnv: Record<string, string> = {
    ENABLE_ZULIP: 'true',
    ENABLE_DISCORD: 'false',
  };
  if (config.zuliprc) {
    zulipEnv.ZULIP_RC_PATH = config.zuliprc;
  }

  const subagentModule = new SubagentModule({
    parentAgentName: 'researcher',
    defaultModel: config.model,
  });
  const lessonsModule = new LessonsModule();
  const retrievalModule = new RetrievalModule({ membrane });

  const framework = await AgentFramework.create({
    storePath: config.storePath,
    membrane,
    agents: [
      {
        name: 'researcher',
        model: config.model,
        systemPrompt: SYSTEM_PROMPT,
        strategy: new PassthroughStrategy(),
      },
    ],
    modules: [subagentModule, lessonsModule, retrievalModule],
    mcplServers: [
      {
        id: 'zulip',
        command: config.zulipMcpCmd,
        args: config.zulipMcpArgs,
        env: zulipEnv,
      },
    ],
  });

  // Wire up the framework reference (chicken-and-egg: module needs framework, framework needs module)
  subagentModule.setFramework(framework);

  framework.start();

  const { waitUntilExit } = render(React.createElement(App, { framework }));

  try {
    await waitUntilExit();
  } finally {
    await framework.stop();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
