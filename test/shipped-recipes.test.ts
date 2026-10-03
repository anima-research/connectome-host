import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework, EventGate, type ModuleContext } from '@animalabs/agent-framework';
import { validateRecipe } from '../src/recipe.js';
import { WebUiModule, __getSharedServerPortForTests, __resetSharedServerForTests } from '../src/modules/web-ui-module.js';

const readRecipe = (name: string) => JSON.parse(readFileSync(new URL(`../recipes/${name}`, import.meta.url), 'utf8'));

afterEach(async () => { await __resetSharedServerForTests(); });

for (const file of ['webui-test.json', 'webui-fleet-test.json']) {
  test(`${file} starts an unauthenticated loopback WebUI`, async () => {
    const recipe = validateRecipe(readRecipe(file));
    const config = recipe.modules?.webui;
    // Use the shipped host/auth settings unchanged. Port 0 avoids test races.
    const mod = new WebUiModule({ ...(typeof config === 'object' ? config : {}), port: 0 });
    try {
      await mod.start({} as ModuleContext);
      expect(config).toMatchObject({ host: '127.0.0.1' });
      expect(__getSharedServerPortForTests()).toBeGreaterThan(0);
    } finally {
      await mod.stop();
    }
  });
}

test('fleet parent and its shipped child have distinct fixed WebUI ports', () => {
  const parent = readRecipe('webui-fleet-test.json');
  const child = readRecipe(parent.modules.fleet.children[0].recipe);
  const parentPort = parent.modules.webui.port;
  const childPort = child.modules.webui.port;
  expect(Number.isInteger(parentPort) && parentPort > 0).toBe(true);
  expect(Number.isInteger(childPort) && childPort > 0).toBe(true);
  expect(parentPort).not.toBe(childPort);
});

test('clerk channel instructions use live wake tools and a valid persistent rule', () => {
  const clerk = readRecipe('clerk.json');
  const prompt = validateRecipe(clerk).agent.systemPrompt;
  // The host assembles wake tools only when modules.wake enables its gate.
  // A standalone EventGate probe must not hide a disabled shipped module.
  expect(clerk.modules.wake).toHaveProperty('policies');
  const channelInstructions = prompt.slice(prompt.indexOf('## Channel Management'), prompt.indexOf('## Subagents'));
  expect(channelInstructions).toContain('wake_add_rule');
  expect(channelInstructions).toContain('wake_remove_rule');
  expect(channelInstructions).toContain('zulip--listen');
  expect(channelInstructions).toContain('zulip--unlisten');
  expect(channelInstructions).not.toContain('workspace--edit');
  expect(channelInstructions).not.toContain('~1 second');
  expect(channelInstructions).toContain('explicit user confirmation');
  expect(channelInstructions).toContain('user-input');
  expect(channelInstructions).toContain('subagent-completions');
  expect(channelInstructions).toContain('Recipe-shipped rules');
  expect(channelInstructions).toContain('restored at the next startup');
  expect(channelInstructions).toContain('Runtime-only rules');

  const tools = (AgentFramework as unknown as { WAKE_RULE_TOOLS: Array<{ name: string }> }).WAKE_RULE_TOOLS;
  expect(tools.map(tool => tool.name)).toContain('wake_add_rule');
  expect(tools.map(tool => tool.name)).toContain('wake_remove_rule');
  const example = channelInstructions.match(/```json\n([\s\S]*?)\n```/);
  expect(example).not.toBeNull();
  const rule = JSON.parse(example![1]!);
  expect(rule.name).toBe('watch-foo');
  expect(channelInstructions).toContain('wake_remove_rule {"name":"watch-foo"}');

  const dir = mkdtempSync(join(tmpdir(), 'clerk-wake-rule-'));
  try {
    const configPath = join(dir, 'gate.json');
    writeFileSync(configPath, JSON.stringify(clerk.modules.wake));
    const createGate = () => new EventGate({
      configPath, initialConfig: clerk.modules.wake,
      emitTrace: () => {}, addMessage: () => '', requestInference: () => {}, getAgentNames: () => ['clerk'],
    });
    const gate = createGate();
    const event = { content: 'offline example', eventType: 'mcpl:channel-incoming', serverId: 'zulip', channelId: 'zulip:foo' };
    expect(gate.evaluate(event).trigger).toBe(false);
    // This is the validator/mutator used by the installed wake_add_rule tool.
    gate.addPolicy(rule);
    expect(gate.evaluate(event).trigger).toBe(true);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).policies).toContainEqual(rule);
    expect(gate.removePolicy(rule.name)).toBe(true);
    expect(gate.evaluate(event).trigger).toBe(false);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual(clerk.modules.wake);

    // Boot reconciliation restores shipped names, but not runtime-only rules.
    expect(gate.removePolicy('tracker-channel')).toBe(true);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).policies.some((p: { name: string }) => p.name === 'tracker-channel')).toBe(false);
    const restarted = createGate();
    expect(restarted.listPolicyNames()).toContain('tracker-channel');
    expect(restarted.listPolicyNames()).not.toContain(rule.name);
    expect(restarted.evaluate(event).trigger).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
