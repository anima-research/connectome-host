import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Step = { frame: string; aborts: string[] };

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
      const { step, frame, aborts } = JSON.parse(json);
      steps.set(step, { frame, aborts });
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
  }, 40000);

  test('a backgrounded turn whose attempt fails stays in background, and returns with its earlier rounds and its retry but not the failed attempt', async () => {
    const steps = await play('background-retry');
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
