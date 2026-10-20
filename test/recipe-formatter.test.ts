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

  // Which agents' tools go into the system block is the recipe's agent's
  // call, made here, so the host's own call passes only the model.
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
    // Bedrock's gate turns caching off for a Claude 3 model.
    expect(inSystem(xmlRecipe({ provider: 'bedrock' }), 'anthropic.claude-3-opus-20240229-v1:0')).toBe(false);
  });

  // The regression this pins: with an unconfigured AnthropicXmlFormatter, membrane >= 0.5.87
  // resolves tool mode to native and sends a native chat. Pinned, the request stays a prefill
  // transcript: the history folded into the assistant prefill, ending on the agent's own name.
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
    // The unpinned formatter, as host 0.10.0 built it, is what membrane turns native.
    const unpinned = new AnthropicXmlFormatter();
    expect(unpinned.configuredToolMode).toBeUndefined();
    void Membrane;
  });
});

// #287: membrane's default splices an XML agent's tool definitions into the
// transcript ten messages before its end, a point that moves with every
// appended message, so the tool block was written to the prompt cache again
// on every turn. The recipe's formatter puts them in the system block when
// the agent has a system prompt and prompt caching.
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
    // The earlier request's last message, and everything before it, is
    // unchanged; only the agent's turn prefix after it differs.
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
    // Bedrock's gate turns caching off for a Claude 3 model.
    expect(xmlToolsInSystem(recipe({ provider: 'bedrock' }), 'anthropic.claude-3-opus-20240229-v1:0')).toBe(false);
    expect(xmlToolsInSystem(recipe({ provider: 'bedrock' }), 'anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe(true);
  });

  test("stay in the transcript of an agent with no system prompt, which keeps membrane's CLI-simulation frame, whoever's turn opens it", () => {
    // In XML mode each message's text goes into the agent's own blocks, so membrane gives every request whose system
    // text is empty the frame, unless its first message carries an image or the recipe sets a prefill user message:
    // here a transcript that opens with the agent's turn, and one that opens with another's.
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
      // What the system block would have done to it, as it does to a subagent's request with an empty prompt under
      // a recipe whose agent has one: `[Start]`, and a system block of the tools alone, on purpose.
      const moved = built(xmlRecipe());
      expect(JSON.stringify(moved.systemContent)).not.toContain('CLI simulation mode');
      expect(JSON.stringify(moved.systemContent)).toContain('Read a file from the workspace');
      expect(JSON.stringify(moved.messages[0])).toContain('[Start]');
    }
  });

});
