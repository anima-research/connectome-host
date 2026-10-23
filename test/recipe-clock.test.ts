import { describe, expect, test } from 'bun:test';
import { buildFrameworkAgentConfig } from '../src/framework-agent-config.js';
import { validateRecipe } from '../src/recipe.js';

const base = (value?: unknown) => ({
  name: 'clock',
  agent: {
    systemPrompt: 'sys',
    ...(value === undefined ? {} : { clock: value }),
  },
});

describe('clock recipe wiring', () => {
  test('is every ten minutes by omission, off with false, and passes a clock through to AgentConfig unchanged', () => {
    const absent = validateRecipe(base());
    expect(absent.agent.clock).toBeUndefined();
    expect(buildFrameworkAgentConfig(absent, 'a', 'm', { kind: 's' } as never).clock).toEqual({ intervalMinutes: 10 });

    const off = validateRecipe(base(false));
    expect(off.agent.clock).toBe(false);
    expect(buildFrameworkAgentConfig(off, 'a', 'm', { kind: 's' } as never).clock).toBeUndefined();
    expect('clock' in buildFrameworkAgentConfig(off, 'a', 'm', { kind: 's' } as never)).toBe(false);

    const minutes = validateRecipe(base({ intervalMinutes: 10 }));
    expect(buildFrameworkAgentConfig(minutes, 'a', 'm', { kind: 's' } as never).clock).toEqual({ intervalMinutes: 10 });

    const seconds = validateRecipe(base({ intervalSeconds: 15, precision: 'seconds' }));
    expect(buildFrameworkAgentConfig(seconds, 'a', 'm', { kind: 's' } as never).clock)
      .toEqual({ intervalSeconds: 15, precision: 'seconds' });

    const reloaded = validateRecipe(JSON.parse(JSON.stringify(minutes)));
    expect(buildFrameworkAgentConfig(reloaded, 'c', 'm', { kind: 's' } as never).clock).toEqual({ intervalMinutes: 10 });

    // The other readings the framework accepts: minutes asked for at a whole-minute
    // interval, and a whole-minute interval given in seconds.
    for (const clock of [
      { intervalMinutes: 10, precision: 'minutes' }, { intervalSeconds: 120 },
      // Seconds asked for at a whole-minute interval, the one precision that
      // isn't its interval's default.
      { intervalMinutes: 10, precision: 'seconds' },
      // A day, the longest interval, given either way.
      { intervalMinutes: 1440 }, { intervalSeconds: 86_400 },
    ]) {
      expect(buildFrameworkAgentConfig(validateRecipe(base(clock)), 'a', 'm', { kind: 's' } as never).clock).toEqual(clock);
    }
  });

  test('refuses a clock the framework would refuse at boot, at recipe validation, naming the recipe key', () => {
    const cases: Array<[unknown, string]> = [
      // true is no clock: a recipe names an interval, or false for none.
      [true, 'Recipe agent.clock must be false (no clock rows) or an object such as { "intervalMinutes": 10 }, got true.'],
      [10, 'Recipe agent.clock must be false (no clock rows) or an object such as { "intervalMinutes": 10 }, got 10.'],
      [null, 'Recipe agent.clock must be false (no clock rows) or an object such as { "intervalMinutes": 10 }, got null.'],
      // A string or an array would otherwise reach the key check, which would name "0" as a key.
      ['10', 'Recipe agent.clock must be false (no clock rows) or an object such as { "intervalMinutes": 10 }, got "10".'],
      [[10], 'Recipe agent.clock must be false (no clock rows) or an object such as { "intervalMinutes": 10 }, got [10].'],
      [{ interval: 10 }, 'Recipe agent.clock has unknown key "interval"; it takes intervalMinutes, intervalSeconds and precision.'],
      [{ intervalMinutes: 10, every: 5, presicion: 'minutes' }, 'Recipe agent.clock has unknown keys "every", "presicion"; it takes intervalMinutes, intervalSeconds and precision.'],
      [{}, 'Recipe agent.clock takes exactly one of intervalMinutes and intervalSeconds'],
      [{ intervalMinutes: 10, intervalSeconds: 30 }, 'Recipe agent.clock takes exactly one of intervalMinutes and intervalSeconds'],
      [{ intervalMinutes: 0 }, 'Recipe agent.clock.intervalMinutes must be a positive whole number'],
      [{ intervalMinutes: 1.5 }, 'Recipe agent.clock.intervalMinutes must be a positive whole number'],
      [{ intervalSeconds: '15' }, 'Recipe agent.clock.intervalSeconds must be a positive whole number'],
      [{ intervalMinutes: 2000 }, 'Recipe agent.clock interval is at most a day (1440 minutes); boundaries count from local midnight'],
      [{ intervalSeconds: 86_401 }, 'Recipe agent.clock interval is at most a day (1440 minutes); boundaries count from local midnight'],
      [{ intervalMinutes: 10, precision: 'hours' }, "Recipe agent.clock.precision must be 'minutes' or 'seconds'"],
      [{ intervalSeconds: 90, precision: 'minutes' }, "Recipe agent.clock: an interval of 90 seconds isn't whole minutes, so its clocks need precision 'seconds'"],
    ];
    for (const [clock, message] of cases) {
      // The whole message: toThrow(string) passes on any message that holds it.
      let thrown: unknown;
      try { validateRecipe(base(clock)); } catch (err) { thrown = err; }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe(message);
    }
  });
});
