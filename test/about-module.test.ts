import { describe, expect, test } from 'bun:test';
import type { AgentFramework, ToolResult } from '@animalabs/agent-framework';

import { AboutModule } from '../src/modules/about-module.js';
import type { HostVersions } from '../src/bug-report.js';

type ServerRow = ReturnType<AgentFramework['listMcplServers']>[number];

const VERSIONS: HostVersions = {
  host: { version: '0.27.1', commit: null },
  packages: [
    { name: '@animalabs/agent-framework', version: '0.35.2' },
    { name: '@animalabs/membrane', version: '0.10.4' },
    { name: '@animalabs/context-manager', version: '0.28.0' },
    { name: '@animalabs/chronicle', version: null },
  ],
};

function row(id: string, connected: boolean, serverInfo: ServerRow['serverInfo']): ServerRow {
  return { id, connected, serverInfo } as unknown as ServerRow;
}

function about(rows: ServerRow[] | null, versions: HostVersions = VERSIONS): AboutModule {
  const module = new AboutModule(versions);
  if (rows) module.setFramework({ listMcplServers: () => rows } as unknown as AgentFramework);
  return module;
}

const answer = async (module: AboutModule, name = 'versions'): Promise<ToolResult> =>
  module.handleToolCall({ id: 'call-1', name, input: {} });

describe('about--versions', () => {
  test("answers with the host's line, the packages' line, and one line for each loaded server", async () => {
    const result = await answer(about([
      row('discord', true, { name: 'discord-mcpl', version: '0.8.0' }),
      row('quiet', true, null),
      row('partial', true, { name: 'partial-mcpl', version: null }),
      row('retrying', false, { name: 'slack-mcpl', version: '0.6.1' }),
      row('closed', false, null),
    ]));
    expect(result.success).toBe(true);
    expect(String(result.data).split('\n')).toEqual([
      'connectome-host 0.27.1',
      'agent-framework 0.35.2 · membrane 0.10.4 · context-manager 0.28.0 · chronicle unknown',
      'discord: discord-mcpl 0.8.0',
      'quiet: connected, and it gave no name or version',
      'partial: partial-mcpl (no version)',
      'retrying: slack-mcpl 0.6.1 (not connected now)',
      "closed: not connected, so its name and version aren't known",
    ]);
  });

  test("a host that runs from a git checkout gives its commit and whether it's modified", async () => {
    const versions = { ...VERSIONS, host: { version: '0.27.1', commit: { sha: '8c181b8c6aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', modified: true } } };
    const [hostLine] = String((await answer(about([], versions))).data).split('\n');
    expect(hostLine).toBe('connectome-host 0.27.1 (commit 8c181b8c6aaa, modified: yes)');
  });

  test('with no server loaded, one line says so', async () => {
    expect(String((await answer(about([]))).data).split('\n').slice(2)).toEqual(['No MCPL server is loaded.']);
  });

  test("once the module has stopped, it still gives the versions, and says the servers can't be listed right now", async () => {
    const module = about([row('discord', true, { name: 'discord-mcpl', version: '0.8.0' })]);
    await module.stop();
    expect(String((await answer(module)).data).split('\n')).toEqual([
      'connectome-host 0.27.1',
      'agent-framework 0.35.2 · membrane 0.10.4 · context-manager 0.28.0 · chronicle unknown',
      "The MCPL servers can't be listed right now.",
    ]);
  });

  test("it's a utility of the built-in toolset, not a tool in the agent's tool list", () => {
    const module = about([]);
    expect(module.getTools()).toEqual([]);
    expect(module.getUtilities().map((u) => u.name)).toEqual(['versions']);
  });

  test('a call by another name runs nothing and names the utility', async () => {
    const result = await answer(about([]), 'version');
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('about--versions');
  });
});
