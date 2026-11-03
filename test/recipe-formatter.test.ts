import { describe, test, expect } from 'bun:test';
import { AnthropicXmlFormatter, Membrane, NativeFormatter, OpenAIResponsesFormatter } from '@animalabs/membrane';
import type { NormalizedMessage } from '@animalabs/membrane';
import { recipeFormatter, xmlToolsInSystem } from '../src/recipe-formatter.js';
import type { Recipe } from '../src/recipe.js';

const recipe = (agent: Record<string, unknown>) => ({ agent: { systemPrompt: 'You are Rhys.', ...agent } }) as unknown as Recipe;
const xmlRecipe = (agent: Record<string, unknown> = {}) => recipe({ formatter: 'anthropic-xml', ...agent });

describe('recipeFormatter', () => {
  test('anthropic-xml is pinned to XML tool mode, not left to membrane', () => {
    const f = recipeFormatter(xmlRecipe(), 'anthropic', 'claude-haiku-4-5');
    expect(f).toBeInstanceOf(AnthropicXmlFormatter);
    expect((f as AnthropicXmlFormatter).configuredToolMode).toBe('xml');
  });

  test('native and codex recipes keep their formatters', () => {
    expect(recipeFormatter(recipe({}), 'anthropic', 'claude-haiku-4-5')).toBeInstanceOf(NativeFormatter);
    expect(recipeFormatter(recipe({ formatter: 'native' }), 'bedrock', 'claude-haiku-4-5')).toBeInstanceOf(NativeFormatter);
    expect(recipeFormatter(xmlRecipe(), 'openai-codex', 'gpt-5.4')).toBeInstanceOf(OpenAIResponsesFormatter);
  });

  test("places an anthropic-xml agent's tools by its recipe and model", () => {
    const tools = [{ name: 'read_file', description: 'Read a file from the workspace', inputSchema: { type: 'object' as const, properties: {} } }];
    const inSystem = (r: Recipe, model = 'claude-haiku-4-5') => JSON.stringify(
      (recipeFormatter(r, 'anthropic', model) as AnthropicXmlFormatter).buildMessages(
        [{ participant: 'Lari', content: [{ type: 'text', text: 'hello' }] }],
        { participantMode: 'multiuser', assistantParticipant: 'Rhys', tools, toolMode: 'xml', systemPrompt: r.agent.systemPrompt },
      ).systemContent,
    ).includes('Read a file from the workspace');
    expect(inSystem(xmlRecipe())).toBe(true);
    expect(inSystem(xmlRecipe({ systemPrompt: '' }))).toBe(false);
    expect(inSystem(xmlRecipe({ promptCaching: false }))).toBe(false);
    expect(inSystem(xmlRecipe({ provider: 'bedrock' }), 'anthropic.claude-3-opus-20240229-v1:0')).toBe(false);
  });

  test('an anthropic-xml request is built as a prefill transcript', () => {
    const messages: NormalizedMessage[] = [
      { participant: 'Lari', content: [{ type: 'text', text: 'hello' }] },
      { participant: 'Rhys', content: [{ type: 'text', text: 'hi' }] },
      { participant: 'Lari', content: [{ type: 'text', text: 'how are you?' }] },
    ];
    const tools = [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }];
    const build = (formatter: AnthropicXmlFormatter) => formatter.buildMessages(messages, {
      participantMode: 'multiuser', assistantParticipant: 'Rhys', tools,
      toolMode: formatter.configuredToolMode ?? 'native',
      prefillUserMessage: '<cmd>cat untitled.log</cmd>',
    });
    const pinned = build(recipeFormatter(xmlRecipe(), 'anthropic', 'claude-haiku-4-5') as AnthropicXmlFormatter);
    const last = pinned.messages.at(-1) as { role: string; content: unknown };
    expect(last.role).toBe('assistant');
    expect(JSON.stringify(last.content)).toContain('Rhys:');
    expect(pinned.nativeTools ?? []).toHaveLength(0);
    const unpinned = new AnthropicXmlFormatter();
    expect(unpinned.configuredToolMode).toBeUndefined();
    void Membrane;
  });
});

describe("an anthropic-xml agent's tool definitions", () => {
  const tools = [
    { name: 'read_file', description: 'Read a file from the workspace', inputSchema: { type: 'object' as const, properties: { path: { type: 'string' } } } },
    { name: 'search', description: 'Search the records', inputSchema: { type: 'object' as const, properties: { query: { type: 'string' } } } },
  ];
  const transcript = (n: number): NormalizedMessage[] => Array.from({ length: n }, (_, i) => ({
    participant: i % 2 === 1 ? 'Rhys' : 'Lari',
    content: [{ type: 'text', text: `message ${i}` }],
  }));
  const build = (n: number, opts: { promptCaching?: boolean } = {}) => (recipeFormatter(xmlRecipe(), 'anthropic', 'claude-haiku-4-5') as AnthropicXmlFormatter).buildMessages(transcript(n), {
    participantMode: 'multiuser', assistantParticipant: 'Rhys', tools, toolMode: 'xml', systemPrompt: 'You are Rhys.', ...opts,
  });
  test('are in its system block, not its transcript', () => {
    const built = build(30);
    const system = JSON.stringify(built.systemContent);
    const transcriptText = JSON.stringify(built.messages);
    for (const t of tools) {
      expect(system).toContain(t.name);
      expect(system).toContain(t.description);
      expect(transcriptText).not.toContain(t.description);
    }
  });

  test("leave each request's text the same as the last one's through the earlier request's last message", () => {
    const text = (b: ReturnType<typeof build>) => JSON.stringify([b.systemContent, b.messages]);
    const earlier = text(build(30));
    const later = text(build(31));
    let same = 0;
    while (same < earlier.length && earlier[same] === later[same]) same++;
    const last = earlier.indexOf('message 29');
    expect(last).toBeGreaterThan(0);
    expect(same).toBeGreaterThanOrEqual(last + 'message 29'.length);
  });

  test('sit in the system block that carries the cache marker, with prompt caching on', () => {
    const system = build(30, { promptCaching: true }).systemContent as Array<{ text: string; cache_control?: unknown }>;
    const marked = system.filter((b) => b.cache_control);
    expect(marked).toHaveLength(1);
    expect(marked[0]!.text).toContain('Read a file from the workspace');
  });

  test('go to the system block only for an agent with a system prompt and prompt caching', () => {
    expect(xmlToolsInSystem(recipe({}), 'claude-haiku-4-5')).toBe(true);
    expect(xmlToolsInSystem(recipe({ systemPrompt: '' }), 'claude-haiku-4-5')).toBe(false);
    expect(xmlToolsInSystem(recipe({ promptCaching: false }), 'claude-haiku-4-5')).toBe(false);
    expect(xmlToolsInSystem(recipe({ provider: 'bedrock' }), 'anthropic.claude-3-opus-20240229-v1:0')).toBe(false);
    expect(xmlToolsInSystem(recipe({ provider: 'bedrock' }), 'anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe(true);
  });

  test("stay in the transcript of an agent with no system prompt, which keeps membrane's CLI-simulation frame, whoever's turn opens it", () => {
    for (const opening of [
      [
        { participant: 'Rhys', content: [{ type: 'text', text: 'the file reads' }] },
        { participant: 'Lari', content: [{ type: 'text', text: 'go on' }] },
      ],
      [
        { participant: 'Lari', content: [{ type: 'text', text: 'read the file' }] },
        { participant: 'Rhys', content: [{ type: 'text', text: 'the file reads' }] },
        { participant: 'Lari', content: [{ type: 'text', text: 'go on' }] },
      ],
    ] as NormalizedMessage[][]) {
      const built = (r: Recipe) => (recipeFormatter(r, 'anthropic', 'claude-haiku-4-5') as AnthropicXmlFormatter)
        .buildMessages(opening, { participantMode: 'multiuser', assistantParticipant: 'Rhys', tools, toolMode: 'xml', systemPrompt: '' });
      const asMain = new AnthropicXmlFormatter({ toolMode: 'xml' }).buildMessages(opening, {
        participantMode: 'multiuser', assistantParticipant: 'Rhys', tools, toolMode: 'xml', systemPrompt: '',
      });
      const kept = built(xmlRecipe({ systemPrompt: '' }));
      expect(JSON.stringify(kept)).toBe(JSON.stringify(asMain));
      expect(JSON.stringify(kept.systemContent)).toContain('CLI simulation mode');
      expect(JSON.stringify(kept.messages[0])).toContain('cat untitled.txt');
      const moved = built(xmlRecipe());
      expect(JSON.stringify(moved.systemContent)).not.toContain('CLI simulation mode');
      expect(JSON.stringify(moved.systemContent)).toContain('Read a file from the workspace');
      expect(JSON.stringify(moved.messages[0])).toContain('[Start]');
    }
  });

});
