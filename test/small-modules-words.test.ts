/**
 * What the agent reads from the smaller modules' refusals: what was wrong,
 * with the value given and what to give instead, whether anything changed,
 * and, for a tool name a module doesn't have, the tools it does have. Each
 * case pins the parts the agent acts on, not every word.
 */
import { describe, test, expect } from 'bun:test';
import type { ModuleContext, ToolCall } from '@animalabs/agent-framework';
import { ActivityModule } from '../src/modules/activity-module.js';
import { ChannelModeModule } from '../src/modules/channel-mode-module.js';
import { LessonsModule } from '../src/modules/lessons-module.js';
import { SettingsModule } from '../src/modules/settings-module.js';
import { InstructionsModule } from '../src/modules/instructions-module.js';
import { TimeModule } from '../src/modules/time-module.js';
import { TuiModule } from '../src/modules/tui-module.js';
import { NoticesModule } from '../src/modules/notices-module.js';
import { TtsRelayModule } from '../src/modules/tts-relay-module.js';
import { RetrievalModule } from '../src/modules/retrieval-module.js';
import { WebUiModule } from '../src/modules/web-ui-module.js';

const call = (name: string, input: Record<string, unknown> = {}): ToolCall => ({ id: `t-${name}`, name, input });

describe('activity', () => {
  test('an unknown name is answered before the argument is checked, with both tools', async () => {
    const r = await new ActivityModule().handleToolCall(call('show', {}));
    expect(r.error).toContain('"activity--show"');
    expect(r.error).toContain('activity--show_in and activity--hide_in');
  });

  test('a missing channel says what to give, and a wrong one shows the value', async () => {
    const m = new ActivityModule();
    const missing = await m.handleToolCall(call('show_in', {}));
    expect(missing.error).toStartWith('Nothing changed: activity--show_in needs channel');
    expect(missing.error).toContain('"zulip:tracker-miner-f"');
    const wrong = await m.handleToolCall(call('hide_in', { channel: 42 }));
    expect(wrong.error).toContain('not 42');
  });
});

describe('channel-mode', () => {
  /** A module whose framework and tools stand in for the host's: the
   *  tools named in `failing` fail, the gate refuses a rule when `gateFails`,
   *  and removing a rule finds one when `ruleExists`. */
  function wired(opts: { failing?: string[]; gateFails?: boolean; ruleExists?: boolean; config?: ConstructorParameters<typeof ChannelModeModule>[0] } = {}) {
    const failing = opts.failing ?? ['channel_open'];
    const m = new ChannelModeModule(opts.config);
    const steps: string[] = [];
    const debounces: unknown[] = [];
    m.setFramework({
      addGatePolicy: (p: { behavior: { debounce: unknown } }) => {
        steps.push('addGatePolicy');
        if (opts.gateFails) throw new Error('debounce rule refused');
        debounces.push(p.behavior.debounce);
      },
      removeGatePolicy: () => { steps.push('removeGatePolicy'); return opts.ruleExists ?? true; },
    } as never);
    void m.start({
      callTool: async (c: { name: string }) => {
        steps.push(c.name);
        return failing.includes(c.name) ? { success: false, error: `${c.name} refused: Server not found: discord` } : { success: true };
      },
    } as unknown as ModuleContext);
    return { m, steps, debounces };
  }

  test('every input problem is named at once, and nothing is touched', async () => {
    const { m, steps } = wired();
    const r = await m.handleToolCall(call('set_channel_mode', { mode: 'loud' }));
    expect(r.error).toStartWith('Nothing changed: channelId is missing');
    expect(r.error).toContain('discord:<guildId>:<channelId>');
    expect(r.error).toContain('mode must be "debounced" (wake on every message, batched) or "mentions"');
    expect(r.error).toContain('not "loud"');
    expect(steps).toEqual([]);
  });

  test('a debounceMs the gate would refuse, or one that isn\'t a number, changes nothing', async () => {
    const { m, steps } = wired();
    for (const [debounceMs, shown] of [[400_000, '400000'], [50, '50'], ['60000', '"60000"'], [null, 'null'], [Infinity, 'Infinity']] as const) {
      const r = await m.handleToolCall(call('set_channel_mode', { channelId: 'discord:1:2', mode: 'debounced', debounceMs }));
      expect(r.error).toStartWith('Nothing changed: debounceMs must be a number of milliseconds from 100 to 300000');
      expect(r.error).toContain(`not ${shown}; leave it out for 180000`);
    }
    expect(steps).toEqual([]);
  });

  test('debounceMs is checked in either mode, and beside a mode that is wrong', async () => {
    const { m, steps } = wired();
    const both = await m.handleToolCall(call('set_channel_mode', { channelId: 'discord:1:2', mode: 'loud', debounceMs: 50 }));
    expect(both.error).toContain('not "loud"');
    expect(both.error).toContain('debounceMs must be a number of milliseconds from 100 to 300000, not 50');
    const mentions = await m.handleToolCall(call('set_channel_mode', { channelId: 'discord:1:2', mode: 'mentions', debounceMs: '60000' }));
    expect(mentions.error).toStartWith('Nothing changed: debounceMs must be');
    expect(steps).toEqual([]);
  });

  test('a debounceMs within the bounds, either bound included, is the rule the gate gets', async () => {
    const { m, debounces } = wired({ failing: [] });
    for (const debounceMs of [100, 300_000]) {
      const r = await m.handleToolCall(call('set_channel_mode', { channelId: 'discord:1:2', mode: 'debounced', debounceMs }));
      expect(r.success).toBe(true);
      expect((r.data as { message: string }).message).toBe(`Channel discord:1:2 set to debounced mode, with a ${debounceMs} ms quiet window.`);
    }
    expect(debounces).toEqual([100, 300_000]);
  });

  test('a host default above zero but outside the gate\'s bounds is clamped to the nearer one, and one at or below zero, or not a number, gives 180000, each with a line', async () => {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.join(' ')); };
    const built: Array<ReturnType<typeof wired>> = [];
    try {
      for (const defaultDebounceMs of [50, 400_000, Infinity, 0, -5, -Infinity, 'slow', 60_000]) {
        built.push(wired({ failing: [], config: { defaultDebounceMs: defaultDebounceMs as number } }));
      }
    } finally {
      console.error = orig;
    }
    expect(lines).toEqual([
      "[gate] channel-mode's defaultDebounceMs 50 is outside the gate's 100 to 300000 ms; using 100.",
      "[gate] channel-mode's defaultDebounceMs 400000 is outside the gate's 100 to 300000 ms; using 300000.",
      "[gate] channel-mode's defaultDebounceMs Infinity is outside the gate's 100 to 300000 ms; using 300000.",
      "[gate] channel-mode's defaultDebounceMs 0 isn't above zero; using 180000.",
      "[gate] channel-mode's defaultDebounceMs -5 isn't above zero; using 180000.",
      "[gate] channel-mode's defaultDebounceMs -Infinity isn't above zero; using 180000.",
      "[gate] channel-mode's defaultDebounceMs slow isn't a number of milliseconds; using 180000.",
    ]);
    for (const b of built) {
      const r = await b.m.handleToolCall(call('set_channel_mode', { channelId: 'discord:1:2', mode: 'debounced' }));
      expect(r.success).toBe(true);
    }
    expect(built.map((b) => b.debounces[0])).toEqual([100, 300_000, 300_000, 180_000, 180_000, 180_000, 180_000, 60_000]);
  });

  test('a partial result says what each step that worked did, what failed, and how to retry', async () => {
    const { m } = wired();
    const r = await m.handleToolCall(call('set_channel_mode', { channelId: 'discord:1:2', mode: 'debounced', debounceMs: 60_000 }));
    expect(r.isError).toBe(true);
    expect(r.error).toStartWith(
      'Channel discord:1:2 is only partly in debounced mode: its debounce rule is set and it is pinned open, ' +
      'and opening the channel failed (channel_open refused: Server not found: discord).',
    );
    expect(r.error).toContain('call channel-mode--set_channel_mode again with the same channelId and mode, and debounceMs 60000, to retry');
  });

  test('in mentions mode, a removed rule, or none, reads as what happened', async () => {
    const removed = await wired({ failing: ['channel_close'] }).m.handleToolCall(call('set_channel_mode', { channelId: 'discord:1:2', mode: 'mentions' }));
    expect(removed.error).toStartWith(
      'Channel discord:1:2 is only partly in mentions mode: its debounce rule was removed and it isn\'t pinned, ' +
      'and closing the channel failed (channel_close refused: Server not found: discord).',
    );
    expect(removed.error).toContain('with the same channelId and mode to retry');
    const none = await wired({ failing: ['channel_close'], ruleExists: false }).m.handleToolCall(call('set_channel_mode', { channelId: 'discord:1:2', mode: 'mentions' }));
    expect(none.error).toContain("it had no debounce rule to remove and it isn't pinned");
  });

  test('when no step works, it says nothing changed', async () => {
    const { m } = wired({ failing: ['channel_open', 'subscription-gc--pin_channel_idle_limit'], gateFails: true });
    const r = await m.handleToolCall(call('set_channel_mode', { channelId: 'discord:1:2', mode: 'debounced' }));
    expect(r.error).toStartWith('Nothing changed for channel discord:1:2: opening the channel failed');
    expect(r.error).toContain("the channel's debounce gate rule failed (debounce rule refused)");
    expect(r.error).toContain('Each step is safe to repeat');
    expect(r.error).not.toContain('only partly');
  });

  test('a step whose call threw may have taken effect, and the result says so', async () => {
    const m = new ChannelModeModule();
    m.setFramework({ addGatePolicy: () => { throw new Error('debounce rule refused'); }, removeGatePolicy: () => true } as never);
    await m.start({
      callTool: async (c: { name: string }) => {
        if (c.name === 'channel_open') throw new Error('timed out');
        return { success: false, error: `${c.name} refused` };
      },
    } as unknown as ModuleContext);
    const none = await m.handleToolCall(call('set_channel_mode', { channelId: 'discord:1:2', mode: 'debounced' }));
    expect(none.error).toStartWith(
      'Channel discord:1:2 may not have changed: opening the channel got no answer (timed out), so it may or may not have taken effect;',
    );
    expect(none.error).not.toContain('Nothing changed');

    const m2 = new ChannelModeModule();
    m2.setFramework({ addGatePolicy: () => {}, removeGatePolicy: () => true } as never);
    await m2.start({
      callTool: async (c: { name: string }) => {
        if (c.name === 'channel_open') throw new Error('timed out');
        return { success: true };
      },
    } as unknown as ModuleContext);
    const some = await m2.handleToolCall(call('set_channel_mode', { channelId: 'discord:1:2', mode: 'debounced' }));
    expect(some.error).toStartWith('Channel discord:1:2 may be only partly in debounced mode: its debounce rule is set and it is pinned open, and opening the channel got no answer (timed out)');
  });

  test('a module that stops between steps says so for the steps it didn\'t take', async () => {
    const m = new ChannelModeModule();
    const gate: string[] = [];
    m.setFramework({ addGatePolicy: () => { gate.push('add'); }, removeGatePolicy: () => true } as never);
    await m.start({
      callTool: async (c: { name: string }) => {
        if (c.name === 'channel_open') await m.stop();
        return { success: true };
      },
    } as unknown as ModuleContext);
    const r = await m.handleToolCall(call('set_channel_mode', { channelId: 'discord:1:2', mode: 'debounced' }));
    expect(r.error).toContain("the channel's debounce gate rule failed (the channel-mode module stopped before this step)");
    expect(r.error).toContain('pinning it open failed (the channel-mode module stopped before this step)');
    expect(gate).toEqual([]);
  });

  test('a module that isn\'t running says so, and that nothing changed', async () => {
    const m = new ChannelModeModule();
    m.setFramework({ addGatePolicy: () => {}, removeGatePolicy: () => true } as never);
    const r = await m.handleToolCall(call('set_channel_mode', { channelId: 'discord:1:2', mode: 'mentions' }));
    expect(r.error).toStartWith("Nothing changed: the channel-mode module isn't running right now");
    expect(r.error).toContain('whoever runs this host');
  });

  test('a module the host never wired says so, and whom to ask', async () => {
    const r = await new ChannelModeModule().handleToolCall(call('set_channel_mode', { channelId: 'discord:1:2', mode: 'mentions' }));
    expect(r.error).toContain("can't run here");
    expect(r.error).toContain('whoever runs this host');
  });

  test('an unknown name names its one tool', async () => {
    const r = await new ChannelModeModule().handleToolCall(call('set_mode'));
    expect(r.error).toContain("The channel-mode module's one tool is channel-mode--set_channel_mode.");
  });
});

describe('lessons', () => {
  test('an id that matches no lesson says nothing changed and where the ids are', async () => {
    const m = new LessonsModule();
    await m.start({ getState: () => null, setState: () => {} } as unknown as ModuleContext);
    const r = await m.handleToolCall(call('boost', { id: 'abc123' }));
    expect(r.error).toStartWith('Nothing was boosted: no lesson has the id "abc123".');
    expect(r.error).toContain('lessons--list shows lessons with their ids, the first 50 unless you give a larger limit');
    expect(r.error).toContain('includeDeprecated: true');
    const missing = await m.handleToolCall(call('deprecate', { reason: 'wrong' }));
    expect(missing.error).toStartWith("Nothing was deprecated: id is missing: give the lesson's id.");
  });

  test('a lesson without its content or tags is not stored, and every problem is named', async () => {
    const m = new LessonsModule();
    await m.start({ getState: () => null, setState: () => {} } as unknown as ModuleContext);
    const neither = await m.handleToolCall(call('create', {}));
    expect(neither.error).toStartWith('Nothing was created: content is missing: give the lesson as text; tags is missing:');
    const wrong = await m.handleToolCall(call('create', { content: 'Ask before merging.', tags: 'process' }));
    expect(wrong.error).toContain('tags must be a list of text, such as ["process"], not "process"');
    const mixed = await m.handleToolCall(call('create', { content: 'Ask before merging.', tags: ['process', 7] }));
    expect(mixed.error).toContain('not ["process",7]');
    const blank = await m.handleToolCall(call('create', { content: '  ', tags: ['process'], confidence: 'high', evidence: 'msg-1' }));
    expect(blank.error).toContain('content is blank');
    expect(blank.error).toContain('confidence must be a number from 0 to 1, such as 0.8, not "high"');
    expect(blank.error).toContain('evidence must be a list of text');
    const percent = await m.handleToolCall(call('create', { content: 'Ask before merging.', tags: ['process'], confidence: 85 }));
    expect(percent.error).toContain('confidence must be a number from 0 to 1, such as 0.8, not 85');
    const huge = await m.handleToolCall(call('create', { content: 'Ask before merging.', tags: ['process'], confidence: Infinity }));
    expect(huge.error).toContain('confidence must be a number from 0 to 1, such as 0.8, not Infinity');
    expect(m.getLessons()).toEqual([]);
    // Both ends of the range are a confidence.
    for (const confidence of [0, 1]) {
      expect((await m.handleToolCall(call('create', { content: `at ${confidence}`, tags: ['process'], confidence }))).success).toBe(true);
    }
    expect(m.getLessons().map((l) => l.confidence)).toEqual([0, 1]);
    expect((await m.handleToolCall(call('query', { text: 'merging', tags: ['process'] }))).success).toBe(true);
  });

  // HO-git's regression cases, from a pull request to this repository that
  // first reported and fixed this crash, adapted to refusing bad tags.
  test('a lesson created without tags, or with null or junk tags, is refused, and queries and lists by tag still work', async () => {
    const m = new LessonsModule();
    await m.start({ getState: () => null, setState: () => {} } as unknown as ModuleContext);
    const none = await m.handleToolCall(call('create', { content: 'no tags here' }));
    expect(none.error).toContain('tags is missing');
    expect((await m.handleToolCall(call('query', { text: 'tags', tags: ['x'] }))).success).toBe(true);
    expect((await m.handleToolCall(call('list', { tags: ['x'] }))).success).toBe(true);
    const nulled = await m.handleToolCall(call('create', { content: 'a', tags: null }));
    expect(nulled.error).toContain('tags must be a list of text');
    const id = ((await m.handleToolCall(call('create', { content: 'a', tags: ['ok'] }))).data as { id: string }).id;
    const junk = await m.handleToolCall(call('update', { id, tags: ['ok', 3, null, 'fine'] }));
    expect(junk.error).toContain('tags must be a list of text');
    expect(m.getLessons().map((l) => l.tags)).toEqual([['ok']]);
  });

  test('an update checks every field it is given before it changes any', async () => {
    const m = new LessonsModule();
    await m.start({ getState: () => null, setState: () => {} } as unknown as ModuleContext);
    const id = ((await m.handleToolCall(call('create', { content: 'c', tags: ['t'] }))).data as { id: string }).id;
    const bad = await m.handleToolCall(call('update', { id, content: 'new', tags: 'x', evidence: 7 }));
    expect(bad.error).toStartWith('Nothing was updated: tags must be a list of text');
    expect(bad.error).toContain('evidence must be a list of text');
    expect(m.getLessons()[0]).toMatchObject({ content: 'c', tags: ['t'] });
    const both = await m.handleToolCall(call('update', { id: 'nope', content: '' }));
    expect(both.error).toStartWith('Nothing was updated: no lesson has the id "nope"; content is blank');
    expect((await m.handleToolCall(call('update', { id, confidence: 0.9 }))).success).toBe(true);
    // null is no value: on update, a field left out keeps its own.
    const nulls = await m.handleToolCall(call('update', { id, content: null, confidence: null, evidence: null }));
    expect(nulls.error).toContain('content must be the lesson as text, or leave it out to keep the current text, not null');
    expect(nulls.error).toContain('confidence must be a number from 0 to 1, such as 0.8, not null');
    expect(nulls.error).toContain('evidence must be a list of text');
    const over = await m.handleToolCall(call('update', { id, confidence: 1.5 }));
    expect(over.error).toContain('not 1.5');
    expect(m.getLessons()[0]).toMatchObject({ content: 'c', tags: ['t'], confidence: 0.9 });
    for (const confidence of [1, 0]) {
      expect((await m.handleToolCall(call('update', { id, confidence }))).success).toBe(true);
      expect(m.getLessons()[0]!.confidence).toBe(confidence);
    }
  });

  test('a deprecation without its reason changes nothing, and names the id problem beside it', async () => {
    const m = new LessonsModule();
    await m.start({ getState: () => null, setState: () => {} } as unknown as ModuleContext);
    const id = ((await m.handleToolCall(call('create', { content: 'c', tags: ['t'] }))).data as { id: string }).id;
    const noReason = await m.handleToolCall(call('deprecate', { id }));
    expect(noReason.error).toBe('Nothing was deprecated: reason is missing: say why the lesson is no longer accurate.');
    const blank = await m.handleToolCall(call('deprecate', { id, reason: '  ' }));
    expect(blank.error).toBe('Nothing was deprecated: reason is blank: say why the lesson is no longer accurate.');
    expect(m.getLessons()[0]!.deprecated).toBe(false);
    const both = await m.handleToolCall(call('deprecate', { id: 'nope' }));
    expect(both.error).toStartWith('Nothing was deprecated: no lesson has the id "nope"; reason is missing:');
  });

  test('an unknown name lists the seven tools', async () => {
    const r = await new LessonsModule().handleToolCall(call('delete', { id: 'x' }));
    expect(r.error).toContain('lessons--create, lessons--update, lessons--deprecate, lessons--query, lessons--list, lessons--boost and lessons--demote');
  });
});

describe('settings', () => {
  test('every bad reasoning field is named, and none of them is applied', async () => {
    const m = new SettingsModule();
    await m.start({ getState: () => null, setState: () => {} } as unknown as ModuleContext);
    const ext = m.getAgentSettingsExtension();
    let message = '';
    try { ext.update('a', { reasoning_enabled: 'yes', reasoning_display: 'full', reasoning_budget_tokens: 4096 }); } catch (e) { message = (e as Error).message; }
    expect(message).toStartWith("The reasoning settings weren't changed: ");
    expect(message).toContain('reasoning_enabled must be true or false, not "yes"');
    expect(message).toContain('reasoning_display must be "summarized" or "omitted", not "full"');
    expect(ext.get('a')).toMatchObject({ reasoning_enabled: false, reasoning_budget_tokens: 8192, reasoning_display: 'summarized' });
  });

  test('a budget that isn\'t a number, or an effort not on the list, is named and not applied', async () => {
    const m = new SettingsModule();
    await m.start({ getState: () => null, setState: () => {} } as unknown as ModuleContext);
    const ext = m.getAgentSettingsExtension();
    for (const [budget, shown] of [[null, 'null'], ['60000', '"60000"'], [true, 'true'], [Infinity, 'Infinity']] as const) {
      let message = '';
      try { ext.update('a', { reasoning_budget_tokens: budget, reasoning_effort: 'extreme' }); } catch (e) { message = (e as Error).message; }
      expect(message).toContain(`reasoning_budget_tokens must be a number of tokens, not ${shown} (the least it takes is 1024`);
      expect(message).toContain('reasoning_effort must be one of');
      expect(message).toContain('not "extreme"');
    }
    expect(ext.get('a')).toMatchObject({ reasoning_budget_tokens: 8192 });
    ext.update('a', { reasoning_budget_tokens: 500 });
    expect(ext.get('a')).toMatchObject({ reasoning_budget_tokens: 1024 });
  });

  test('an unknown name points to agent_settings and its four fields', async () => {
    const r = await new SettingsModule().handleToolCall(call('reasoning_enable'));
    expect(r.error).toContain('"settings--reasoning_enable"');
    expect(r.error).toContain('reasoning_enabled, reasoning_budget_tokens, reasoning_display and reasoning_effort');
  });
});

describe('modules that offer no tools of their own', () => {
  test('instructions names its workspace file and heading, says what a missing heading means, and names the tools that read and edit it', async () => {
    const r = await new InstructionsModule({ path: 'shared/AGENTS.md', agentName: 'resident' }).handleToolCall(call('edit'));
    expect(r.error).toContain('"instructions--edit"');
    expect(r.error).toContain(
      'Your instructions are read from the workspace file shared/AGENTS.md each turn and put in your context ' +
      'under the heading "# Shared operating instructions (live document)", so the text there is the current one.',
    );
    // The module fails open, so the hint can't promise the text is there.
    expect(r.error).toContain(
      "If that heading is missing from your context, the file couldn't be read, and whoever runs this host can see why in its log.",
    );
    // workspace--read serves the workspace's stored copy, which a read-only
    // mount doesn't update from disk (README, "Who edits, and how it propagates").
    expect(r.error).toContain("workspace--read shows the workspace's stored copy, which on a read-only mount can be older than the file; on a mount running direct it reads the file itself.");
    expect(r.error).toContain('workspace--edit');

    const bare = await new InstructionsModule({ path: 'shared/AGENTS.md', header: '  ', agentName: 'resident' }).handleToolCall(call('edit'));
    expect(bare.error).toContain('put in your context, so the text there is the current one. If they are missing from your context,');
    expect(bare.error).not.toContain('heading');
  });

  test('the others say they have none and point to the tools listed', async () => {
    const others = [
      new TuiModule(),
      new NoticesModule({}),
      new TtsRelayModule({ url: 'ws://localhost:1/bot', token: 't' }),
      new RetrievalModule({ membrane: {} as never }),
      new WebUiModule(),
    ];
    for (const m of others) {
      const r = await m.handleToolCall(call('send'));
      expect(r.error).toContain(`"${m.name}--send"`);
      expect(r.error).toContain('has no tools of its own; call one of the tools listed for you');
    }
    const time = await new TimeModule('UTC').handleToolCall(call('today'));
    expect(time.error).toContain("The time module's one tool is time--now.");
  });
});
