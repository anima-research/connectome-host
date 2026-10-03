import { describe, expect, test } from 'bun:test';
import { deprecatedModuleNotices } from '../src/recipe.ts';

describe('deprecatedModuleNotices', () => {
  test('no modules / all off → no notices', () => {
    expect(deprecatedModuleNotices(undefined)).toEqual([]);
    expect(deprecatedModuleNotices({})).toEqual([]);
    expect(deprecatedModuleNotices({ subagents: false, retrieval: false, instructions: false, lessons: true })).toEqual([]);
  });

  test('each enabled injecting module gets one notice citing #171', () => {
    const notices = deprecatedModuleNotices({
      subagents: true,
      retrieval: { model: 'some-model' },
      instructions: { path: 'instructions/AGENTS.md' },
    });
    expect(notices).toHaveLength(3);
    expect(notices[0]).toContain('modules.subagents');
    expect(notices[1]).toContain('modules.retrieval');
    expect(notices[2]).toContain('modules.instructions');
    for (const n of notices) expect(n).toContain('agent-framework#171');
  });

  test('object-form config counts as enabled', () => {
    expect(deprecatedModuleNotices({ subagents: { defaultModel: 'm' } })).toHaveLength(1);
  });
});
