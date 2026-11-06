import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** src/tui.ts's colour for a line an undo or a shed took out. */
const DIM_GRAY = '#555555';

type Step = { frame: string; aborts: string[]; mountRefreshes: string[]; colours: Record<string, string> };

async function play(scenario: string): Promise<Map<string, Step>> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tui-turns-')));
  const child = spawn(process.execPath, [join(import.meta.dir, 'mock-tui-turns-child.ts'), scenario], {
    cwd: dir, env: { ...process.env, DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout!.on('data', chunk => { stdout += chunk; });
  child.stderr!.resume();
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code));
  });
  let killed = false;
  const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, 30000);
  try {
    const code = await closed;
    if (killed) throw new Error(`${scenario}: killed after 30 s`);
    const failure = stdout.match(/TUI_ERROR ([^\n]*)/);
    if (failure) throw new Error(`${scenario}: ${failure[1]}`);
    expect(code).toBe(0);
    expect(stdout).toContain('TUI_DONE');
    const steps = new Map<string, Step>();
    for (const [, json] of stdout.matchAll(/TUI_STEP (\{[^\n]*\})/g)) {
      const { step, frame, aborts, mountRefreshes, colours } = JSON.parse(json);
      steps.set(step, { frame, aborts, mountRefreshes, colours });
    }
    return steps;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    rmSync(dir, { recursive: true, force: true });
  }
}

const times = (text: string, part: string) => text.split(part).length - 1;
const ABORTED = '(turn aborted: interrupted from the TUI)';
const INTERRUPTING = '(interrupting: the turn stops as soon as it can be aborted)';

describe("the TUI's Escape, through runTui", () => {
  test('in each state of the root turn: what it asks the framework, the line it shows, and the status bar', async () => {
    const steps = await play('escape');
    const at = (name: string): Step => {
      const step = steps.get(name);
      if (!step) throw new Error(`no step ${name}`);
      return step;
    };

    expect(at('idle').aborts).toEqual([]);
    expect(at('idle').frame).toContain('[✓ idle]');

    expect(at('sent, before its turn starts').frame).toContain('Ctrl+B:bg Esc:stop]');
    expect(at('sent, before its turn starts, Escape').aborts).toEqual(['first:agent']);
    expect(times(at('sent, before its turn starts, Escape').frame, '(no turn interrupted)')).toBe(1);
    expect(at('sent, before its turn starts, Escape').frame).toContain('[✓ idle]');

    expect(at('in flight').aborts).toHaveLength(2);
    expect(times(at('in flight').frame, ABORTED)).toBe(1);
    expect(at('in flight').frame).toContain('[✓ idle]');

    expect(at('compiling').aborts).toHaveLength(3);
    expect(times(at('compiling').frame, INTERRUPTING)).toBe(1);
    expect(at('compiling').frame).toContain('Ctrl+B:bg Esc:stop]');
    expect(at('compiled').aborts).toHaveLength(4);
    expect(times(at('compiled').frame, ABORTED)).toBe(2);
    expect(at('compiled').frame).toContain('[✓ idle]');

    expect(at('background').frame).toContain('[↓ background | search Esc:stop]');
    expect(at('background').frame).not.toContain('Ctrl+B:bg');
    expect(at('background, Escape').aborts).toHaveLength(5);
    expect(times(at('background, Escape').frame, ABORTED)).toBe(3);
    expect(at('background, Escape').frame).toContain('[✓ idle]');

    expect(times(at('retry wait').frame, 'overloaded')).toBe(1);
    expect(at('retry wait').frame).toContain('Error: overloaded');
    expect(at('retry wait').frame).toContain('[… attempt-failed');
    expect(at('retry wait').frame).toContain('Esc:stop]');
    expect(at('retry wait').frame).not.toContain('Ctrl+B:bg');
    expect(at('retry wait, Escape').aborts).toHaveLength(6);
    expect(times(at('retry wait, Escape').frame, INTERRUPTING)).toBe(2);
    expect(at('retried').aborts).toHaveLength(8);
    expect(times(at('retried').frame, ABORTED)).toBe(4);
    expect(at('retried').frame).toContain('[✓ idle]');

    expect(times(at('ended error').frame, 'gave up')).toBe(1);
    expect(at('ended error').frame).toContain('Error: gave up');
    expect(times(at('ended error').frame, 'Turn ended after 1 attempt.')).toBe(1);
    expect(at('ended error').frame).toContain('[✗ error]');
    expect(at('ended error, Escape').aborts).toHaveLength(8);
    expect(at('ended error, Escape').frame).toContain('[✗ error]');
    expect(times(at('ended error, Escape').frame, '(no turn interrupted)')).toBe(1);
  }, 40000);
});

describe("the TUI's status line, through runTui", () => {
  test("a turn whose start the TUI didn't follow shows its own end, and its failure", async () => {
    const steps = await play('missed-start');
    const at = (name: string): Step => {
      const step = steps.get(name);
      if (!step) throw new Error(`no step ${name}`);
      return step;
    };
    expect(at('no start, then tools').frame).toContain('[… tools');
    expect(at('no start, Escape').aborts).toEqual(['first:agent']);
    expect(at('no start, Escape').frame).toContain(INTERRUPTING);
    expect(at('no start, Escape').frame).not.toContain('(no turn interrupted)');
    expect(at('no start, Escape').frame).toContain('[… tools');
    expect(at('no start, then completed').frame).toContain('[✓ idle]');
    expect(at('no start, then failed').frame).toContain('Error: a turn the TUI never saw start');
    expect(at('no start, then failed').frame).toContain('[… attempt-failed');
    expect(at('no start, failed, then exhausted').frame).toContain('[✗ error');
  }, 40000);

  test("a session switch while a backgrounded turn's attempt has failed lets none of its text into the new session's backgrounded answer", async () => {
    const answered = (await play('background-switch')).get('new session answered');
    if (!answered) throw new Error('missing background-switch frame');
    expect(answered.frame).toContain('new session words');
    expect(answered.frame).not.toContain('old session words');
    expect(answered.frame).toContain('[✓ idle]');
  }, 40000);

  test('a Ctrl+B pressed while a switch is under way leaves the new session in the foreground', async () => {
    const streaming = (await play('switch-ctrl-b')).get('new session streaming');
    if (!streaming) throw new Error('missing switch-ctrl-b frame');
    expect(streaming.frame).toContain('new session words');
    expect(streaming.frame).not.toContain('[↓ background');
  }, 40000);

  test("a session switch that fails keeps the backgrounded turn's earlier rounds, which return with its retry", async () => {
    const returned = (await play('background-switch-fails')).get('old turn returned');
    if (!returned) throw new Error('missing background-switch-fails frame');
    expect(returned.frame).toContain('returned from background');
    expect(returned.frame).toContain('old round words');
    expect(returned.frame).toContain('retry words');
  }, 40000);

  for (const scenario of ['background-retry', 'background-retry-restarted', 'background-retry-before-resume']) test(`${scenario}: a backgrounded turn whose attempt fails stays in background, and returns with its earlier rounds and its retry but not the failed attempt`, async () => {
    const steps = await play(scenario);
    const failed = steps.get('failed in background');
    const returned = steps.get('returned');
    if (!failed || !returned) throw new Error('missing background-retry frames');
    expect(failed.frame).toContain('[… attempt-failed');
    expect(failed.frame).toContain('Error: overloaded');
    expect(failed.frame).not.toContain('returned from background');
    expect(returned.frame).toContain('returned from background');
    expect(returned.frame).toContain('first round words');
    expect(returned.frame).toContain('retry words');
    expect(returned.frame).not.toContain('dead attempt words');
    expect(returned.frame).toContain('[✓ idle]');
  }, 40000);
});

describe("the TUI's session switch, through runTui", () => {
  for (const scenario of ['switch', 'switch-fails']) {
    test(`${scenario === 'switch' ? 'a switch' : 'a failed switch'}: Escape does nothing while it's under way, and the status line follows the framework the host holds once it ends`, async () => {
      const steps = await play(scenario);
      const switching = steps.get('switching, Escape')!;
      expect(switching.aborts).toEqual([]);
      expect(switching.frame).toContain('switching');
      expect(switching.frame).not.toContain('Esc:stop');
      expect(switching.frame).not.toContain('(interrupted');

      const ended = steps.get('switch ended')!;
      const status = scenario === 'switch' ? '[✓ idle]' : '[✗ error]';
      expect(ended.frame).toContain(status);

      const late = steps.get('late end')!;
      expect(late.frame).not.toContain('from before the switch');
      expect(late.frame).toContain(status);
      const lateFailure = steps.get('late failure')!;
      expect(lateFailure.frame).toContain('Error: a late failure');
      expect(lateFailure.frame).toContain('[… attempt-failed');

      const after = steps.get('after the switch')!;
      if (scenario === 'switch-fails') expect(after.frame).toContain('Session switch failed');
      expect(after.frame).toContain('Error: from the framework the host holds');
      expect(after.frame).not.toContain('from the framework the TUI left');
    }, 40000);
  }
});

describe("the TUI's Escape with a subagent running, through runTui", () => {
  test("takes the subagent's turn to the follower before its run is stopped, and aborts it once its call goes out", async () => {
    const steps = await play('subagents');
    const at = (name: string): Step => {
      const step = steps.get(name);
      if (!step) throw new Error(`no step ${name}`);
      return step;
    };
    expect(at('subagents, Escape').aborts).toEqual(['first:spawn-1', 'cancelAll', 'first:agent']);
    expect(at('subagents, Escape').frame).toContain('1 subagent stopped');
    expect(at('subagent compiled').aborts).toEqual(['first:spawn-1', 'cancelAll', 'first:agent', 'first:spawn-1']);
  }, 40000);
});

describe("the TUI's repeated failures, through runTui", () => {
  test('a failure repeated with the same words is one line whose count goes up, and the turn giving up says how many attempts it made', async () => {
    const steps = await play('repeated-failures');
    const at = (name: string): Step => {
      const step = steps.get(name);
      if (!step) throw new Error(`no step ${name}`);
      return step;
    };
    expect(times(at('three failures').frame, 'zz connection refused')).toBe(1);
    expect(at('three failures').frame).toContain('Error (×3): zz connection refused');
    expect(times(at('other words').frame, 'zz connection refused')).toBe(1);
    expect(times(at('other words').frame, 'Error: zz credential rejected')).toBe(1);
    expect(times(at('gave up').frame, 'Turn ended after 4 attempts. Check the subscription credential')).toBe(1);
    expect(times(at('gave up').frame, 'zz credential rejected')).toBe(1);
    expect(times(at('subagent twice').frame, 'zz subagent failure')).toBe(1);
    expect(at('subagent twice').frame).toContain('[spawn-web-1700000000000] Error (×2): zz subagent failure');
    expect(times(at('subagent twice').frame, 'zz root again')).toBe(1);
    expect(at('subagent twice').frame).toContain('Error (×2): zz root again');
    expect(times(at('aborted retry').frame, 'zz stream aborted')).toBe(1);
    expect(times(at('aborted retry').frame, '3 attempts in all.')).toBe(1);
    expect(times(at('aborted retry').frame, 'Turn ended after')).toBe(1);
    expect(times(at('after the switch').frame, 'Error: zz before the switch')).toBe(1);
    expect(at('after the switch').frame).not.toContain('(×2): zz before the switch');
  }, 40000);
});

describe("the TUI's subagent exhaustion, through runTui", () => {
  test("shows lone failures, deduplicates paired ends and tracks the failed phase", async () => {
    const steps = await play('subagent-exhausted');
    const at = (name: string): Step => {
      const step = steps.get(name);
      if (!step) throw new Error(`no step ${name}`);
      return step;
    };
    expect(at('before exhaustion').frame).toMatch(/web  \[sending /);
    expect(at('failed phase').frame).toMatch(/web  \[failed /);

    const web = '[spawn-web-1700000000000] Error: ';
    const cases = [
      ['lone first', [`${web}lone first stream`]],
      ['paired', [`${web}paired stream`]],
      ['lone later', [`${web}lone later stream`]],
      ['other agent', ['[spawn-2] Error: other agent stream']],
      ['retried', [`${web}first try`, `${web}retry exhausted`]],
      ['interleaved', ['[spawn-web-1700000000001] Error: failing stream', '[spawn-web-1700000000002] Error: lone stream']],
    ] as const;
    for (let i = 0; i < cases.length; i++) {
      const frame = at(cases[i]![0]).frame;
      for (let j = 0; j < cases.length; j++) {
        for (const line of cases[j]![1]) expect(times(frame, line)).toBe(j <= i ? 1 : 0);
      }
      // A subagent giving up isn't the operator's turn ending.
      expect(frame).not.toContain('Turn ended after');
      expect(frame).not.toContain('in all.');
    }

    expect(times(at('after switch').frame, `${web}after switch`)).toBe(1);
  }, 40000);
});

// The history is the record, which keeps an undone turn (agent-framework
// #291): it marks the rows an undo took out of the agent's window, and marks
// its lines again in place at each undo or redo on that window (DQ-4), so
// the scrollback's other lines stay.
describe("the TUI's history after an undo", () => {
  test("marks the rows an undo took out of the root agent's window, unmarks them at a redo, leaves the other lines, and leaves another agent's undo alone", async () => {
    const steps = await play('undone');
    const frameAt = (name: string): string => {
      const step = steps.get(name);
      if (!step) throw new Error(`no step ${name}`);
      return step.frame;
    };
    expect(frameAt('history')).toContain('three ledgers');
    expect(frameAt('history')).toContain('💭 tally them first');
    expect(frameAt('history')).not.toContain('(undone)');
    expect(frameAt('undone')).toContain('(undone) three ledgers');
    // The undone row's thinking is marked with its text.
    expect(frameAt('undone')).toContain('(undone) 💭 tally them first');
    expect(frameAt('undone')).not.toContain('(undone) You: count the ledgers');
    // Lines that aren't the history's stay: the start's, and the operator's
    // message. The history's lines are marked where they are, above the
    // operator's message, not drawn again below it.
    for (const at of ['undone', 'redone']) {
      expect(frameAt(at)).toContain('tui-turns-test. Type /help for commands.');
      expect(frameAt(at)).toContain('You: and the fifth?');
      expect(times(frameAt(at), '── session history')).toBe(1);
      expect(times(frameAt(at), '── end history ──')).toBe(1);
      expect(times(frameAt(at), 'three ledgers')).toBe(1);
      expect(frameAt(at).indexOf('three ledgers')).toBeLessThan(frameAt(at).indexOf('You: and the fifth?'));
    }
    // A turn streamed after the history was drawn: its reply and the
    // operator's message are marked where they were drawn, not drawn again.
    expect(times(frameAt('undone'), 'a fifth ledger')).toBe(1);
    expect(frameAt('undone')).toContain('(undone) a fifth ledger');
    expect(frameAt('undone').indexOf('(undone) a fifth ledger')).toBeGreaterThan(frameAt('undone').indexOf('You: and the fifth?'));
    expect(times(frameAt('undone'), 'You: and the fifth?')).toBe(1);
    expect(frameAt('undone')).toMatch(/\(undone\) \d\d:\d\d You: and the fifth\?/);
    // Both are marked above the line written after them, which is no row's
    // (#485 bot review 3, finding 31): marked in place, not drawn again at
    // the bottom.
    const failedTool = frameAt('undone').indexOf('the beads stuck');
    expect(failedTool).toBeGreaterThan(-1);
    expect(frameAt('undone').indexOf('(undone) a fifth ledger')).toBeLessThan(failedTool);
    expect(frameAt('undone').search(/\(undone\) \d\d:\d\d You: and the fifth\?/)).toBeLessThan(failedTool);
    // The marked lines are dimmed, and each takes its colour back at the
    // redo (finding 30): the history's reply and thinking, the streamed
    // reply and the operator's message.
    const colours = (name: string) => steps.get(name)!.colours;
    expect(Object.keys(colours('undone')).sort()).toEqual(['You: and the fifth?', 'a fifth ledger', 'tally them first', 'three ledgers']);
    for (const words of Object.keys(colours('undone'))) {
      expect(colours('undone')[words], words).toBe(DIM_GRAY);
      expect(colours('redone')[words], words).not.toBe(DIM_GRAY);
    }
    expect(colours('redone')['three ledgers']).toBe(colours('history')['three ledgers']);
    expect(colours('redone')['tally them first']).toBe(colours('history')['tally them first']);
    expect(colours('redone')['a fifth ledger']).toBe(colours('history')['three ledgers']);
    // A row stored after the history was drawn that the TUI drew no line
    // for is drawn below while undone, and taken down at the redo.
    expect(frameAt('undone').indexOf('(undone) a sixth ledger')).toBeGreaterThan(frameAt('undone').indexOf('(undone) a fifth ledger'));
    expect(times(frameAt('redone'), 'a fifth ledger')).toBe(1);
    expect(frameAt('redone')).not.toContain('a sixth ledger');
    expect(frameAt('redone')).toContain('three ledgers');
    expect(frameAt('redone')).toContain('💭 tally them first');
    expect(frameAt('redone')).not.toContain('(undone)');
    expect(frameAt('another agent')).not.toContain('(undone)');
    // A row whose lines /clear took down isn't drawn again by a later undo
    // or redo while it stays out of the window, marked by an undo before the
    // clear or never marked.
    for (const at of ['cleared, undone', 'cleared, redone']) {
      expect(frameAt(at)).not.toContain('a fifth ledger');
      expect(frameAt(at)).not.toContain('a sixth ledger');
      expect(frameAt(at)).not.toContain('an eighth ledger');
    }
    expect(frameAt('cleared, undone')).toContain('(undone) a seventh ledger');
    expect(frameAt('cleared, redone')).not.toContain('ledger');
  }, 40000);
});

// #485 bot review 2, findings 6, 9, 22 and 23.
describe("the TUI's undone marks on lines it streamed, through runTui", () => {
  const frameOf = async (scenario: string, name: string): Promise<string> => {
    const step = (await play(scenario)).get(name);
    if (!step) throw new Error(`no step ${name} in ${scenario}`);
    return step.frame;
  };

  test("a shed of the root agent's reply marks its line in place, as an undo does", async () => {
    const shed = await frameOf('undone-shed', 'shed');
    expect(times(shed, 'a fifth ledger')).toBe(1);
    expect(shed).toContain('(undone) a fifth ledger');
  }, 40000);

  test("a co-resident's row with the same words doesn't take the root agent's streamed line", async () => {
    const undone = await frameOf('undone-co-resident', 'undone');
    expect(times(undone, 'Done with the ledgers.')).toBe(1);
    expect(undone).toContain('(undone) Done with the ledgers.');
  }, 40000);

  test('two text blocks streamed into one line are matched as one, and the line is marked in place', async () => {
    const undone = await frameOf('undone-blocks', 'undone');
    expect(times(undone, 'the first half')).toBe(1);
    expect(times(undone, 'the second half')).toBe(1);
    expect(undone).toContain('(undone) the first half, the second half');
  }, 40000);

  // The stream draws text on both sides of a tool call as one line, so
  // the row's two texts are one run (#485 second reading, wave-2 finding 22).
  test('text on both sides of a tool call, streamed as one line, is matched as one, and the line is marked in place', async () => {
    const undone = await frameOf('undone-tools', 'text around a tool call');
    expect(times(undone, 'Checking the ledgers,')).toBe(1);
    expect(times(undone, 'then counting.')).toBe(1);
    expect(undone).toContain('(undone) Checking the ledgers, then counting.');
  }, 40000);

  // The session's `[tools]` line is its row's, as a history row's is
  // (#485 bot review 3, finding 5).
  test("a streamed round's [tools] line is marked in place with its row, a round that only calls a tool's too", async () => {
    const steps = await play('undone-tools');
    const withText = steps.get('text around a tool call')!.frame;
    expect(times(withText, '[tools] search')).toBe(1);
    expect(withText).toMatch(/\(undone\) \d\d:\d\d \[tools\] search/);
    const toolsOnly = steps.get('tools only')!.frame;
    expect(toolsOnly).not.toContain('(undone) Checking the ledgers');
    expect(toolsOnly).not.toMatch(/\(undone\) \d\d:\d\d \[tools\] search/);
    expect(times(toolsOnly, '[tools] tally')).toBe(1);
    expect(toolsOnly).toMatch(/\(undone\) \d\d:\d\d \[tools\] tally/);
  }, 40000);

  // A reply backgrounded with Ctrl+B comes back a line per round, the
  // first after the line streamed before the press, each its row's
  // (#485 bot review 3, finding 4).
  test('a reply backgrounded mid-stream comes back a line per round, without its thinking, and an undo marks its lines in place', async () => {
    const steps = await play('undone-background');
    const returned = steps.get('returned')!.frame;
    expect(returned).toMatch(/\nledgers now\. *\n/);
    expect(returned).toMatch(/\nThere are three\. *\n/);
    expect(returned).not.toContain('weigh the count');
    const undone = steps.get('undone')!.frame;
    for (const words of ['Counting the', 'ledgers now.', 'There are three.']) {
      expect(times(undone, words)).toBe(1);
      expect(undone).toContain(`(undone) ${words}`);
    }
    expect(undone).not.toContain('weigh the count');
    expect(undone).not.toContain('[tools] tally');
  }, 40000);

  test("past the scrollback cap: a streamed line it pushed out isn't drawn again below, after a /clear or without one, an undone row with no line is, and a reply keeps its line from an earlier one in the same words", async () => {
    const steps = await play('undone-evicted');
    const cleared = steps.get('cleared, then pushed out')!.frame;
    expect(cleared).toContain('(undone) a ninth ledger');
    expect(cleared).not.toContain('a lost ledger');
    const pushed = steps.get('pushed out')!.frame;
    expect(pushed).toContain('(undone) a tenth ledger');
    expect(pushed).not.toContain('a stray ledger');
    // Past the cap, an undone row the TUI drew no line for is still drawn
    // below, marked (#485 bot review 3, finding 14).
    const noLine = steps.get('no line, past the cap')!.frame;
    expect(times(noLine, 'an eleventh ledger')).toBe(1);
    expect(noLine).toContain('(undone) an eleventh ledger');
    // A reply's line is its own row's, though an earlier reply in the same
    // words lost its line to the cap first (finding 2).
    const same = steps.get('same words, pushed out')!.frame;
    expect(times(same, 'Done.')).toBe(1);
    expect(same).toContain('(undone) Done.');
  }, 90000);

  // A shed while the turn is backgrounded marks the operator's message in
  // place, and the turn's rounds once they are drawn, with no copy below
  // (#485 bot review 4, finding 1).
  test("a shed while the turn is backgrounded marks the operator's message in place, and the turn's lines as it returns, drawing no copy", async () => {
    const steps = await play('undone-background-shed');
    const shed = steps.get('shed while backgrounded')!;
    expect(times(shed.frame, 'and the fifth?')).toBe(1);
    expect(shed.frame).toMatch(/\(undone\) \d\d:\d\d You: and the fifth\?/);
    expect(shed.colours['You: and the fifth?']).toBe(DIM_GRAY);
    expect(times(shed.frame, 'Counting the')).toBe(1);
    expect(shed.frame).not.toContain('ledgers now.');
    expect(shed.frame).not.toContain('[tools] tally');
    const returned = steps.get('returned')!.frame;
    expect(times(returned, 'and the fifth?')).toBe(1);
    expect(returned).toMatch(/\(undone\) \d\d:\d\d You: and the fifth\?/);
    for (const words of ['Counting the', 'ledgers now.']) {
      expect(times(returned, words)).toBe(1);
      expect(returned).toContain(`(undone) ${words}`);
    }
    expect(times(returned, 'There are three.')).toBe(1);
    expect(returned).not.toContain('(undone) There are three.');
    expect(returned).not.toContain('[tools] tally');
  }, 40000);

  // Text on both sides of a thinking block streams as two lines, so a
  // backgrounded reply comes back as two (#485 bot review 4, finding 7).
  test('a backgrounded reply whose text goes on after a thinking block comes back a line for each side, and an undo marks both in place', async () => {
    const steps = await play('undone-background-thinking');
    const returned = steps.get('returned')!.frame;
    expect(returned).toMatch(/\nledgers now\. *\n/);
    expect(returned).toMatch(/\nThere are three\. *\n/);
    expect(returned).not.toContain('weigh the count');
    const undone = steps.get('undone')!.frame;
    for (const words of ['Counting the', 'ledgers now.', 'There are three.']) {
      expect(times(undone, words)).toBe(1);
      expect(undone).toContain(`(undone) ${words}`);
    }
  }, 40000);

  // Every message the operator sends is echoed, and stored, in order: the
  // first row takes the first echo though a turn ends between the two rows'
  // stores (#485 bot review 4, finding 4).
  test("the same message sent twice: an undo of the first one's turn marks the first echo", async () => {
    const undone = await frameOf('undone-queued', 'undone');
    const echoes = undone.split('\n').filter((line) => line.includes('You: once more'));
    expect(echoes).toHaveLength(2);
    expect(echoes[0]).toContain('(undone)');
    expect(echoes[1]).not.toContain('(undone)');
    expect(undone).toContain('(undone) the first answer');
    expect(undone).not.toContain('(undone) the second answer');
  }, 40000);

  // A send that is never stored, one the framework refused or one during a
  // session switch that failed, is no row's: a later message in the same
  // words takes its own echo (#485 bot review 5, finding 11).
  test("the same words sent twice unstored, then once stored: an undo of the stored one marks its own echo", async () => {
    const undone = await frameOf('undone-unsent', 'undone');
    const echoes = undone.split('\n').filter((line) => line.includes('You: once more'));
    expect(echoes).toHaveLength(3);
    expect(echoes[0]).not.toContain('(undone)');
    expect(echoes[1]).not.toContain('(undone)');
    expect(echoes[2]).toContain('(undone)');
  }, 40000);

  // A turn that keeps more lines than the scrollback holds before its end
  // links them: the first rounds' rows, whose lines the scrollback took
  // down, aren't drawn again (#485 bot review 4, finding 5).
  test("a turn of more rounds than the scrollback holds: an undo of its first round draws nothing again, and an undone row with no line is drawn", async () => {
    const undone = await frameOf('undone-long-turn', 'undone');
    expect(undone).toContain('(undone) a twelfth ledger');
    expect(undone).not.toContain('round 0');
    expect(undone).not.toContain('(undone) [tools]');
  }, 90000);
});

describe("the TUI's branch moves, through runTui", () => {
  // agent-framework holds every agent's turn until the move releases the
  // store, and the follow-up comes a few awaits later: a turn that started
  // in between streams on, and the branch is drawn once it ends
  // (#485 bot review 2, finding 24).
  test("a root turn that started before a move's follow-up came streams on, and the branch is drawn once it ends", async () => {
    const steps = await play('async-branch-turn');
    const streaming = steps.get('streaming at the follow-up')!.frame;
    expect(streaming).toContain('on the side branch now');
    expect(streaming).toContain('Switched to branch side.');
    expect(streaming).not.toContain('[✓ idle]');
    const ended = steps.get('turn ended')!.frame;
    expect(ended).toContain('the side branch reply');
    expect(ended).not.toContain('three ledgers');
    expect(times(ended, 'on the side branch now')).toBe(1);
    expect(ended.indexOf('on the side branch now')).toBeLessThan(ended.indexOf('Switched to branch side.'));
    expect(ended).toContain('[✓ idle]');
    expect(steps.get('turn ended')!.mountRefreshes).toEqual([]);
  }, 40000);

  // Another command's answer that came while the turn ran is drawn again
  // below the branch (#485 bot review 4, finding 9).
  test("a command's answer that came while the turn ran is drawn again below the branch with the move's", async () => {
    const ended = (await play('async-branch-turn-answers')).get('turn ended')!.frame;
    expect(ended).toContain('the side branch reply');
    expect(ended).toContain('Switched to branch side.');
    expect(ended).toContain('puppet agent: tally → ok (tu-1)');
    expect(ended).toContain('result: tally done');
    expect(ended.indexOf('the side branch reply')).toBeLessThan(ended.indexOf('puppet agent: tally'));
  }, 40000);

  // A /clear while the redraw waits leaves the scrollback clear: the turn's
  // end takes up the branch without drawing its history (#485 bot review 5,
  // finding 12).
  test("a /clear while a move's redraw waits for the turn's end leaves the scrollback clear, and the new branch's rows are read from its end", async () => {
    const steps = await play('async-branch-turn-clear');
    const ended = steps.get('turn ended')!.frame;
    expect(ended).not.toContain('── session history');
    expect(ended).not.toContain('the side branch reply');
    expect(ended).not.toContain('Switched to branch side.');
    // An answer drawn after the /clear stays where it is, drawn once.
    expect(times(ended, 'result: tally done')).toBe(1);
    expect(ended).toContain('[✓ idle]');
    // The cursors are the new branch's: the turn's row, its first words
    // cleared, isn't drawn again, and a row stored since is drawn, marked.
    const undone = steps.get('undone')!.frame;
    expect(undone).toContain('(undone) a side ledger');
    expect(undone).not.toContain('on the side branch now');
    expect(undone).not.toContain('── session history');
  }, 40000);

  // An async command leaves the status of a root turn alone, from its
  // start to its answer (#485 bot review 4, finding 8).
  test("an async command started during a backgrounded or held root turn leaves its status as it is", async () => {
    const steps = await play('async-turn-status');
    expect(steps.get('backgrounded')!.frame).toContain('[↓ background');
    expect(steps.get('held')!.frame).toContain('[… attempt-failed');
  }, 40000);

  // agent-framework's switchBranch and rollbackToMessage trace nothing: the
  // command's follow-up saying the branch changed is what tells the TUI.
  test("a command whose follow-up says the branch changed draws the history of the branch the store is on", async () => {
    const switched = (await play('async-branch')).get('switched');
    if (!switched) throw new Error('missing async-branch frame');
    expect(switched.frame).toContain('the side branch reply');
    expect(switched.frame).not.toContain('three ledgers');
    expect(times(switched.frame, '── session history')).toBe(1);
    expect(switched.frame.indexOf('the side branch reply')).toBeLessThan(switched.frame.indexOf('Switched to branch side.'));
    // agent-framework's switchBranch has written the `_config` mount inside
    // its reservation: the TUI's refresh starts no second write of it
    // (#485 bot review 2, finding 25).
    expect(switched.mountRefreshes).toEqual([]);
  }, 40000);
});

function parentRows(frame: string): Map<string, string> {
  const rows: Array<{ name: string; column: number }> = [];
  for (const line of frame.split('\n')) {
    const row = /([▼►─]) (\S+)  \[/.exec(line);
    if (row) rows.push({ name: row[2]!, column: row.index });
  }
  const parents = new Map<string, string>();
  rows.forEach((row, i) => {
    const parent = rows.slice(0, i).reverse().find(r => r.column < row.column);
    if (parent) parents.set(row.name, parent.name);
  });
  return parents;
}

describe("the TUI's fleet rows, through runTui", () => {
  test("a restored child hangs under its parent's row: a fork named web-retry1, or web saved by its retry name from before forks were named by depth", async () => {
    const fleet = (await play('fleet-parents')).get('fleet');
    if (!fleet) throw new Error('missing fleet frame');
    const parents = parentRows(fleet.frame);
    expect(parents.get('saved-child')).toBe('web');
    expect(parents.get('live-child')).toBe('web-retry1');
  }, 40000);

  for (const scenario of ['fork-figures', 'fork-figures-reversed']) {
    test(`${scenario}: each fork's row shows its own context figure, beside a fork whose name is its own plus a suffix`, async () => {
      const fleet = (await play(scenario)).get('fleet');
      if (!fleet) throw new Error('missing fleet frame');
      expect(fleet.frame).toMatch(/web-retry1  \[sending \d+s\] 50\.0kctx/);
      expect(fleet.frame).toMatch(/web  \[sending \d+s\] 20\.0kctx/);
    }, 40000);
  }
});

describe("the TUI's numbered fork phases, through runTui", () => {
  for (const [scenario, phase] of [
    ['numbered-fork-failed', 'attempt-failed'],
    ['numbered-fork-exhausted', 'failed'],
    ['numbered-fork-failed-then-exhausted', 'failed'],
    ['numbered-fork-failed-then-started', 'sending'],
  ] as const) {
    test(`${scenario}: the numbered row shows ${phase}, and the other row stays sending`, async () => {
      const steps = await play(scenario);
      const before = steps.get('before');
      const after = steps.get('after');
      if (!before || !after) throw new Error('missing numbered fork frames');

      expect(before.frame).toMatch(/web  \[sending /);
      expect(before.frame).toMatch(/web-1  \[sending /);
      expect(after.frame).toContain(`web-1  [${phase} `);
      expect(after.frame).toMatch(/web  \[sending /);
      expect(after.frame).not.toMatch(/web  \[(attempt-)?failed /);
    }, 40000);
  }
});
