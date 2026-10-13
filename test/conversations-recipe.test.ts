/**
 * Recipe surface for per-channel conversation routing:
 * schema validation of the `conversations` block, and the host-side mapping
 * to the framework's ConversationRouterConfig (templateAgent auto-filled
 * from the recipe agent, strategyFactory building fresh per-fork strategy
 * instances from the recipe's own strategy config).
 */
import { describe, test, expect } from 'bun:test';
import { validateRecipe, deprecatedConversationsNotices, type Recipe } from '../src/recipe.js';
import { buildConversationsConfig } from '../src/framework-strategy.js';

function baseRecipe(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Test',
    agent: { name: 'sherlock', systemPrompt: 'test' },
    ...extra,
  };
}

describe('validateRecipe — conversations schema', () => {
  test('absent block is accepted', () => {
    expect(() => validateRecipe(baseRecipe())).not.toThrow();
  });

  test('full valid block is accepted', () => {
    expect(() => validateRecipe(baseRecipe({
      conversations: {
        bind: { dm: 'always', groupDm: 'always', channel: 'mention' },
        trigger: { dm: 'always', groupDm: 'mention', channel: 'mention' },
        idleTtlMs: 12 * 60 * 60 * 1000,
        closurePrompt: 'Finalize the case report and post the answer.',
        agentPrefix: 'case',
      },
    }))).not.toThrow();
  });

  test('empty object is accepted (all defaults come from the framework)', () => {
    expect(() => validateRecipe(baseRecipe({ conversations: {} }))).not.toThrow();
  });

  test('non-object block is rejected', () => {
    expect(() => validateRecipe(baseRecipe({ conversations: true }))).toThrow(/must be an object/);
    expect(() => validateRecipe(baseRecipe({ conversations: [] }))).toThrow(/must be an object/);
  });

  test('unknown top-level conversation field is rejected rather than silently ignored', () => {
    expect(() => validateRecipe(baseRecipe({
      conversations: { idleTTLms: 1000 },
    }))).toThrow(/unknown field \"idleTTLms\"/);
  });

  test('unknown channel kind is rejected', () => {
    expect(() => validateRecipe(baseRecipe({
      conversations: { bind: { thread: 'always' } },
    }))).toThrow(/unknown channel kind "thread"/);
  });

  test('invalid bind rule is rejected', () => {
    expect(() => validateRecipe(baseRecipe({
      conversations: { bind: { channel: 'sometimes' } },
    }))).toThrow(/conversations\.bind\.channel/);
  });

  test("trigger rule 'never' is rejected (bind-only rule)", () => {
    expect(() => validateRecipe(baseRecipe({
      conversations: { trigger: { channel: 'never' } },
    }))).toThrow(/conversations\.trigger\.channel/);
  });

  test('non-positive idleTtlMs is rejected', () => {
    expect(() => validateRecipe(baseRecipe({ conversations: { idleTtlMs: 0 } })))
      .toThrow(/idleTtlMs/);
    expect(() => validateRecipe(baseRecipe({ conversations: { idleTtlMs: -5 } })))
      .toThrow(/idleTtlMs/);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(() => validateRecipe(baseRecipe({ conversations: { idleTtlMs: bad } })))
        .toThrow(/idleTtlMs/);
    }
  });

  test('blank closurePrompt is rejected', () => {
    expect(() => validateRecipe(baseRecipe({ conversations: { closurePrompt: '  ' } })))
      .toThrow(/closurePrompt/);
  });

  test('agentPrefix with unsafe characters is rejected', () => {
    for (const bad of ['with space', 'slash/py', 'dot.seg', '']) {
      expect(() => validateRecipe(baseRecipe({ conversations: { agentPrefix: bad } })))
        .toThrow(/agentPrefix/);
    }
    expect(() => validateRecipe(baseRecipe({ conversations: { agentPrefix: 'case-fork_2' } })))
      .not.toThrow();
  });
});

describe('buildConversationsConfig — recipe → FrameworkConfig mapping', () => {
  const recipe = validateRecipe(baseRecipe({
    conversations: {
      bind: { channel: 'mention' },
      idleTtlMs: 3600_000,
      agentPrefix: 'case',
    },
  })) as Recipe;

  test('returns undefined when the recipe has no conversations block', () => {
    const bare = validateRecipe(baseRecipe()) as Recipe;
    expect(buildConversationsConfig(bare, 'sherlock', 'model-x', 'UTC')).toBeUndefined();
  });

  test('templateAgent is auto-filled with the host agent name', () => {
    const cfg = buildConversationsConfig(recipe, 'sherlock', 'model-x', 'UTC');
    expect(cfg?.templateAgent).toBe('sherlock');
  });

  test('recipe fields pass through; omitted fields stay absent for framework defaults', () => {
    const cfg = buildConversationsConfig(recipe, 'sherlock', 'model-x', 'UTC')!;
    expect(cfg.bind).toEqual({ channel: 'mention' });
    expect(cfg.idleTtlMs).toBe(3600_000);
    expect(cfg.agentPrefix).toBe('case');
    expect('trigger' in cfg).toBe(false);
    expect('closurePrompt' in cfg).toBe(false);
  });

  test('strategyFactory builds a FRESH strategy instance per call', () => {
    const cfg = buildConversationsConfig(recipe, 'sherlock', 'model-x', 'UTC')!;
    expect(cfg.strategyFactory).toBeDefined();
    const a = cfg.strategyFactory!();
    const b = cfg.strategyFactory!();
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
  });

  test('strategyFactory honors the recipe strategy type', () => {
    const passthrough = validateRecipe(baseRecipe({
      agent: { name: 'p', systemPrompt: 't', strategy: { type: 'passthrough' } },
      conversations: {},
    })) as Recipe;
    const cfg = buildConversationsConfig(passthrough, 'p', 'model-x', 'UTC')!;
    expect(cfg.strategyFactory!().constructor.name).toBe('PassthroughStrategy');
  });
});

describe('deprecatedConversationsNotices', () => {
  test('absent block → no notices', () => {
    expect(deprecatedConversationsNotices(undefined)).toEqual([]);
  });

  test('any conversations block (even empty) → one notice citing #235', () => {
    for (const conv of [{}, { bind: { channel: 'mention' as const }, idleTtlMs: 60_000 }]) {
      const notices = deprecatedConversationsNotices(conv);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('conversations');
      expect(notices[0]).toContain('agent-framework#235');
    }
  });
});
