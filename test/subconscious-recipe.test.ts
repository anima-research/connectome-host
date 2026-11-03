/**
 * Recipe surface for tune-out's reader (agent-framework#77, #232, #546):
 * schema validation of the `subconscious` block and of the Dendrite options
 * (`speech`, `tuneOut`, `dendrite`), and the host-side mapping to
 * FrameworkConfig.subconscious. The persistent reader passes through
 * verbatim; reader forks get the one field a recipe cannot state, a fresh
 * strategy instance per fork. A typo'd key or a missing mode block must fail
 * at recipe load, not surface as a reader running on an empty system prompt.
 */
import { describe, test, expect } from 'bun:test';
import { validateRecipe, type Recipe } from '../src/recipe.js';
import { buildSubconsciousConfig, dendriteCreateOptions } from '../src/framework-strategy.js';

function baseRecipe(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Test',
    agent: { name: 'sherlock', systemPrompt: 'test' },
    ...extra,
  };
}

const MODE = 'You are the Subconscious. Watch tuned-out channels and report in second person.';

describe('validateRecipe — subconscious schema', () => {
  test('absent block is accepted', () => {
    expect(() => validateRecipe(baseRecipe())).not.toThrow();
    expect(validateRecipe(baseRecipe()).subconscious).toBeUndefined();
  });

  test('full valid block is accepted and passes through verbatim', () => {
    const block = {
      enabled: true,
      name: 'Subconscious',
      model: 'claude-sonnet-4-5',
      systemPrompt: MODE,
      allowChannelSpeech: false,
      reAnchorFraction: 0.5,
    };
    const recipe = validateRecipe(baseRecipe({ subconscious: block }));
    expect(recipe.subconscious).toEqual(block);
  });

  test('minimal block: enabled + systemPrompt', () => {
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: true, systemPrompt: MODE } }))).not.toThrow();
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: false, systemPrompt: MODE } }))).not.toThrow();
  });

  test('non-object block is refused', () => {
    expect(() => validateRecipe(baseRecipe({ subconscious: true }))).toThrow(/subconscious must be an object/);
    expect(() => validateRecipe(baseRecipe({ subconscious: [] }))).toThrow(/subconscious must be an object/);
  });

  test('enabled must be a boolean', () => {
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: 'yes', systemPrompt: MODE } })))
      .toThrow(/subconscious\.enabled must be a boolean/);
    expect(() => validateRecipe(baseRecipe({ subconscious: { systemPrompt: MODE } })))
      .toThrow(/subconscious\.enabled must be a boolean/);
  });

  test('systemPrompt is required and non-empty — the mode block is the whole character', () => {
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: true } })))
      .toThrow(/subconscious\.systemPrompt must be a non-empty string/);
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: true, systemPrompt: '   ' } })))
      .toThrow(/subconscious\.systemPrompt must be a non-empty string/);
  });

  test('unknown fields are refused by name', () => {
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: true, systemPrompt: MODE, cadence: 30 } })))
      .toThrow(/unknown field "cadence"/);
  });

  test('name and model must be non-empty strings when present', () => {
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: true, systemPrompt: MODE, name: '' } })))
      .toThrow(/subconscious\.name must be a non-empty string/);
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: true, systemPrompt: MODE, model: 7 } })))
      .toThrow(/subconscious\.model must be a non-empty string/);
  });

  test('allowChannelSpeech must be a boolean; reAnchorFraction must be in (0, 1]', () => {
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: true, systemPrompt: MODE, allowChannelSpeech: 'no' } })))
      .toThrow(/allowChannelSpeech must be a boolean/);
    for (const bad of [0, 1.5, -0.2, 'half']) {
      expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: true, systemPrompt: MODE, reAnchorFraction: bad } })))
        .toThrow(/reAnchorFraction must be a number in \(0, 1\]/);
    }
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: true, systemPrompt: MODE, reAnchorFraction: 1 } })))
      .not.toThrow();
  });

  test('reader "forks": model and voice are required; its keys are its own', () => {
    const forks = { enabled: true, reader: 'forks', model: 'claude-sonnet-4-5', voice: 'You are reading for sherlock.' };
    expect(validateRecipe(baseRecipe({ subconscious: forks })).subconscious).toEqual(forks);
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: true, reader: 'forks', voice: 'v' } })))
      .toThrow(/subconscious\.model is required for reader "forks"/);
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: true, reader: 'forks', model: 'm' } })))
      .toThrow(/subconscious\.voice must be a non-empty string/);
    expect(() => validateRecipe(baseRecipe({ subconscious: { ...forks, systemPrompt: MODE } })))
      .toThrow('Recipe subconscious.systemPrompt is for reader "persistent", and this recipe\'s reader is "forks". Remove systemPrompt, or set subconscious.reader to "persistent" and remove voice, which only reader "forks" takes.');
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: true, reader: 'elsewhere', systemPrompt: MODE } })))
      .toThrow(/reader must be "persistent" or "forks"/);
  });

  test('reader "forks": a blank model or voice is refused like a missing one', () => {
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: true, reader: 'forks', model: '  ', voice: 'v' } })))
      .toThrow(/subconscious\.model is required for reader "forks"/);
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: true, reader: 'forks', model: 7, voice: 'v' } })))
      .toThrow(/subconscious\.model is required for reader "forks"/);
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: true, reader: 'forks', model: 'm', voice: '\n' } })))
      .toThrow(/subconscious\.voice must be a non-empty string/);
  });

  test('reader "forks": forkIdleTimeoutMs is a positive finite number — JSON 1e309 is Infinity, which a saved recipe would not survive', () => {
    const forks = { enabled: true, reader: 'forks', model: 'm', voice: 'v' };
    for (const bad of [0, -1, '600000', Infinity, Number.NaN, JSON.parse('1e309')]) {
      expect(() => validateRecipe(baseRecipe({ subconscious: { ...forks, forkIdleTimeoutMs: bad } })))
        .toThrow(/forkIdleTimeoutMs must be a positive finite number/);
    }
    expect(validateRecipe(baseRecipe({ subconscious: { ...forks, forkIdleTimeoutMs: 600_000 } })).subconscious)
      .toEqual({ ...forks, forkIdleTimeoutMs: 600_000 });
  });

  test('reader "forks": the persistent reader\'s fields and the framework-only fields are refused by name', () => {
    const forks = { enabled: true, reader: 'forks', model: 'm', voice: 'v' };
    for (const [key, value] of [['name', 'Reader'], ['reAnchorFraction', 0.5]] as const) {
      expect(() => validateRecipe(baseRecipe({ subconscious: { ...forks, [key]: value } })))
        .toThrow(`Recipe subconscious.${key} is for reader "persistent", and this recipe's reader is "forks". Remove ${key}, or set subconscious.reader to "persistent" and remove voice, which only reader "forks" takes.`);
    }
    expect(() => validateRecipe(baseRecipe({ subconscious: { ...forks, forkIdleTimeoutMs: 1000, name: 'Reader' } })))
      .toThrow('Recipe subconscious.name is for reader "persistent", and this recipe\'s reader is "forks". Remove name, or set subconscious.reader to "persistent" and remove voice and forkIdleTimeoutMs, which only reader "forks" takes.');
    expect(() => validateRecipe(baseRecipe({ subconscious: { ...forks, name: 'Reader', systemPrompt: 'p' } })))
      .toThrow('Recipe subconscious.name and subconscious.systemPrompt are for reader "persistent", and this recipe\'s reader is "forks". Remove name and systemPrompt, or set subconscious.reader to "persistent" and remove voice, which only reader "forks" takes.');
    for (const [key, value] of [['strategyFactory', 'x'], ['framing', 'x']] as const) {
      expect(() => validateRecipe(baseRecipe({ subconscious: { ...forks, [key]: value } })))
        .toThrow(new RegExp(`unknown field "${key}".*for reader "forks"`));
    }
  });

  test('an omitted optional key stays absent, so the framework default applies', () => {
    const forks = { enabled: true, reader: 'forks', model: 'm', voice: 'v' };
    const out = validateRecipe(baseRecipe({ subconscious: forks })).subconscious as Record<string, unknown>;
    expect('forkIdleTimeoutMs' in out).toBe(false);
    expect('allowChannelSpeech' in out).toBe(false);
    const persistent = validateRecipe(baseRecipe({ subconscious: { enabled: true, systemPrompt: MODE } })).subconscious as Record<string, unknown>;
    expect('name' in persistent).toBe(false);
    expect('model' in persistent).toBe(false);
    expect('reAnchorFraction' in persistent).toBe(false);
  });

  test('null is refused as a block', () => {
    expect(() => validateRecipe(baseRecipe({ subconscious: null }))).toThrow(/subconscious must be an object/);
    expect(() => validateRecipe(baseRecipe({ speech: null }))).toThrow(/speech must be an object/);
    expect(() => validateRecipe(baseRecipe({ tuneOut: null }))).toThrow(/tuneOut must be an object/);
    expect(() => validateRecipe(baseRecipe({ dendrite: null }))).toThrow(/dendrite must be an object/);
    expect(() => validateRecipe(baseRecipe({ speech: [] }))).toThrow(/speech must be an object/);
    expect(() => validateRecipe(baseRecipe({ tuneOut: [] }))).toThrow(/tuneOut must be an object/);
  });

  test('reader "persistent" may be stated and keeps the persistent schema', () => {
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: true, reader: 'persistent', systemPrompt: MODE } }))).not.toThrow();
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: true, reader: 'persistent', voice: 'v', model: 'm' } })))
      .toThrow('Recipe subconscious.voice is for reader "forks", and this recipe\'s reader is "persistent". Remove voice, or set subconscious.reader to "forks".');
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: true, systemPrompt: MODE, forkIdleTimeoutMs: 1000 } })))
      .toThrow('Recipe subconscious.forkIdleTimeoutMs is for reader "forks", and this recipe\'s reader is "persistent". Remove forkIdleTimeoutMs, or set subconscious.reader to "forks" and remove systemPrompt, which only reader "persistent" takes.');
  });

  test('reader "persistent", stated: the value rules are the same as when it is implied', () => {
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: true, reader: 'persistent' } })))
      .toThrow(/subconscious\.systemPrompt must be a non-empty string/);
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: true, reader: 'persistent', systemPrompt: MODE, reAnchorFraction: 2 } })))
      .toThrow(/reAnchorFraction must be a number in \(0, 1\]/);
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: true, reader: 'persistent', systemPrompt: MODE, name: '' } })))
      .toThrow(/subconscious\.name must be a non-empty string/);
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: true, reader: 'persistent', systemPrompt: MODE, forkIdleTimeoutMs: 1 } })))
      .toThrow(/subconscious\.forkIdleTimeoutMs is for reader "forks"/);
  });
});

describe('buildSubconsciousConfig — recipe → FrameworkConfig.subconscious mapping', () => {
  const VOICE = 'You are reading for sherlock while they are tuned out.';

  test('returns undefined when the recipe has no subconscious block', () => {
    const bare = validateRecipe(baseRecipe()) as Recipe;
    expect(buildSubconsciousConfig(bare, 'model-x', 'UTC')).toBeUndefined();
  });

  test('the persistent reader passes through verbatim: no factory, nothing added', () => {
    const block = { enabled: true, name: 'Subconscious', systemPrompt: MODE, reAnchorFraction: 0.25 };
    const recipe = validateRecipe(baseRecipe({ subconscious: block })) as Recipe;
    const cfg = buildSubconsciousConfig(recipe, 'model-x', 'UTC')!;
    expect(cfg).toEqual(block);
    expect('strategyFactory' in cfg).toBe(false);
  });

  test('reader forks: every recipe field is forwarded and nothing else is set', () => {
    const block = { enabled: true, reader: 'forks' as const, model: 'claude-sonnet-4-5', voice: VOICE, allowChannelSpeech: true, forkIdleTimeoutMs: 120_000 };
    const recipe = validateRecipe(baseRecipe({ subconscious: block })) as Recipe;
    const cfg = buildSubconsciousConfig(recipe, 'model-x', 'UTC')!;
    const { strategyFactory, ...forwarded } = cfg as typeof cfg & { strategyFactory?: unknown };
    expect(forwarded).toEqual(block);
    expect(typeof strategyFactory).toBe('function');
    expect('framing' in cfg).toBe(false);
  });

  test('reader forks: strategyFactory builds a FRESH strategy of the recipe\'s own type on each call', () => {
    const recipe = validateRecipe(baseRecipe({
      agent: { name: 'sherlock', systemPrompt: 'test', strategy: { type: 'autobiographical' } },
      subconscious: { enabled: true, reader: 'forks', model: 'm', voice: VOICE },
    })) as Recipe;
    const cfg = buildSubconsciousConfig(recipe, 'model-x', 'UTC')!;
    if (cfg.reader !== 'forks') throw new Error('expected the fork reader config');
    const a = cfg.strategyFactory!();
    const b = cfg.strategyFactory!();
    expect(a.constructor.name).toBe('AutobiographicalStrategy');
    expect(b.constructor.name).toBe('AutobiographicalStrategy');
    expect(a).not.toBe(b);
  });

  test('reader forks: the factory honors a passthrough recipe strategy', () => {
    const recipe = validateRecipe(baseRecipe({
      agent: { name: 'p', systemPrompt: 'test', strategy: { type: 'passthrough' } },
      subconscious: { enabled: true, reader: 'forks', model: 'm', voice: VOICE },
    })) as Recipe;
    const cfg = buildSubconsciousConfig(recipe, 'model-x', 'UTC')!;
    if (cfg.reader !== 'forks') throw new Error('expected the fork reader config');
    expect(cfg.strategyFactory!().constructor.name).toBe('PassthroughStrategy');
  });
});

describe('validateRecipe — speech and tuneOut (Dendrite admission options)', () => {
  test('speech.locus takes the two rules and nothing else', () => {
    expect(validateRecipe(baseRecipe({ speech: { locus: 'delivery' } })).speech).toEqual({ locus: 'delivery' });
    expect(validateRecipe(baseRecipe({ speech: { locus: 'latest-inbound' } })).speech).toEqual({ locus: 'latest-inbound' });
    expect(() => validateRecipe(baseRecipe({ speech: { locus: 'sticky' } }))).toThrow(/speech\.locus must be "delivery" or "latest-inbound"/);
    expect(() => validateRecipe(baseRecipe({ speech: { fallback: 'x' } }))).toThrow(/speech has unknown field "fallback"/);
    expect(() => validateRecipe(baseRecipe({ speech: 'delivery' }))).toThrow(/speech must be an object/);
  });

  test('tuneOut.enabled offers tune_out without a reader', () => {
    expect(validateRecipe(baseRecipe({ tuneOut: { enabled: true } })).tuneOut).toEqual({ enabled: true });
    expect(() => validateRecipe(baseRecipe({ tuneOut: { enabled: 'yes' } }))).toThrow(/tuneOut\.enabled must be a boolean/);
    expect(() => validateRecipe(baseRecipe({ tuneOut: { silent: true } }))).toThrow(/tuneOut has unknown field "silent"/);
  });

  test('dendrite.collapseDerivationNoticesAfter sets when a source hears counts instead of lines (agent-framework#270)', () => {
    expect(validateRecipe(baseRecipe({ dendrite: { collapseDerivationNoticesAfter: 25 } })).dendrite).toEqual({ collapseDerivationNoticesAfter: 25 });
    expect(validateRecipe(baseRecipe({ dendrite: { announceOrphans: false, collapseDerivationNoticesAfter: 0 } })).dendrite)
      .toEqual({ announceOrphans: false, collapseDerivationNoticesAfter: 0 });
    expect(() => validateRecipe(baseRecipe({ dendrite: { collapseDerivationNoticesAfter: -1 } }))).toThrow(/collapseDerivationNoticesAfter must be a non-negative integer/);
    expect(() => validateRecipe(baseRecipe({ dendrite: { collapseDerivationNoticesAfter: 2.5 } }))).toThrow(/non-negative integer/);
    expect(() => validateRecipe(baseRecipe({ dendrite: { announceOrphans: 'no' } }))).toThrow(/dendrite\.announceOrphans must be a boolean/);
    expect(() => validateRecipe(baseRecipe({ dendrite: { quiet: true } }))).toThrow(/dendrite has unknown field "quiet"/);
    expect(() => validateRecipe(baseRecipe({ dendrite: 10 }))).toThrow(/dendrite must be an object/);
  });

  test('tuneOut.announce turns the excepted-channel announcement off', () => {
    expect(validateRecipe(baseRecipe({ tuneOut: { enabled: true, announce: false } })).tuneOut).toEqual({ enabled: true, announce: false });
    expect(() => validateRecipe(baseRecipe({ tuneOut: { announce: 'no' } }))).toThrow(/tuneOut\.announce must be a boolean/);
  });
});

describe('dendriteCreateOptions — what the host hands AgentFramework.create()', () => {
  test('a recipe with none of the blocks adds nothing, so the framework defaults apply', () => {
    const recipe = validateRecipe(baseRecipe()) as Recipe;
    expect(dendriteCreateOptions(recipe, 'model-x', 'UTC')).toEqual({});
  });

  test('each stated block is passed through as validated; the reader carries its factory', () => {
    const recipe = validateRecipe(baseRecipe({
      agent: { name: 'sherlock', systemPrompt: 'test', strategy: { type: 'passthrough' } },
      subconscious: { enabled: true, reader: 'forks', model: 'm', voice: 'v', forkIdleTimeoutMs: 1000 },
      speech: { locus: 'latest-inbound' },
      tuneOut: { enabled: true, announce: false },
      dendrite: { announceOrphans: false, collapseDerivationNoticesAfter: 3 },
    })) as Recipe;
    const options = dendriteCreateOptions(recipe, 'model-x', 'UTC');
    expect(Object.keys(options).sort()).toEqual(['dendrite', 'speech', 'subconscious', 'tuneOut']);
    expect(options.speech).toEqual({ locus: 'latest-inbound' });
    expect(options.tuneOut).toEqual({ enabled: true, announce: false });
    expect(options.dendrite).toEqual({ announceOrphans: false, collapseDerivationNoticesAfter: 3 });
    const sub = options.subconscious!;
    if (sub.reader !== 'forks') throw new Error('expected the fork reader config');
    expect(sub.model).toBe('m');
    expect(sub.voice).toBe('v');
    expect(sub.forkIdleTimeoutMs).toBe(1000);
    expect(sub.strategyFactory!().constructor.name).toBe('PassthroughStrategy');
  });

  test('a persistent reader alone: only that key, verbatim', () => {
    const recipe = validateRecipe(baseRecipe({ subconscious: { enabled: true, systemPrompt: MODE } })) as Recipe;
    expect(dendriteCreateOptions(recipe, 'model-x', 'UTC')).toEqual({ subconscious: { enabled: true, systemPrompt: MODE } });
  });
});
