/**
 * The TUI's Escape and its session switch, run through runTui itself
 * (test/mock-tui-turns-child.ts): when Escape acts, the lines it shows and
 * the aborts it asks for in each state of the root's turn and with a
 * subagent running, where the status bar offers it, and which framework the
 * status line follows once a switch ends.
 */
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
  // Only a hang reaches this: the child's own watchdog fires first.
  let killed = false;
  const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, 30000);
  try {
    const code = await closed;
    if (killed) throw new Error(`${scenario}: killed after 30 s`);
    const failure = stdout.match(/TUI_ERROR ([^\n]*)/);
    if (failure) throw new Error(`${scenario}: ${failure[1]}`);
    expect(code).toBe(0);
    expect(stdout).toContain('TUI_DONE');
    // A step's line can follow other output on the same line of stdout, so
    // it's found wherever it is.
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

    // Idle: Escape does nothing, and the bar doesn't offer it.
    expect(at('idle').aborts).toEqual([]);
    expect(at('idle').frame).toContain('[✓ idle]');

    // A message sent, before its turn starts: the bar offers Escape, which
    // finds nothing to abort or keep, says so, and shows the status idle.
    expect(at('sent').frame).toContain('Ctrl+B:bg Esc:stop]');
    expect(at('sent, Escape').aborts).toEqual(['first:agent']);
    expect(times(at('sent, Escape').frame, '(no turn interrupted)')).toBe(1);
    expect(at('sent, Escape').frame).toContain('[✓ idle]');

    // A model call in flight is aborted at once, and its abort ends the turn.
    expect(at('in flight').aborts).toHaveLength(2);
    expect(times(at('in flight').frame, ABORTED)).toBe(1);
    expect(at('in flight').frame).toContain('[✓ idle]');

    // A turn still compiling is kept: Escape says so, and the bar still
    // offers Escape and Ctrl+B ...
    expect(at('compiling').aborts).toHaveLength(3);
    expect(times(at('compiling').frame, INTERRUPTING)).toBe(1);
    expect(at('compiling').frame).toContain('Ctrl+B:bg Esc:stop]');
    // ... until its first trace once it can be aborted.
    expect(at('compiled').aborts).toHaveLength(4);
    expect(times(at('compiled').frame, ABORTED)).toBe(2);
    expect(at('compiled').frame).toContain('[✓ idle]');

    // A turn in the background: the bar offers Escape alone, and Escape
    // aborts the turn.
    expect(at('background').frame).toContain('[↓ background | search Esc:stop]');
    expect(at('background').frame).not.toContain('Ctrl+B:bg');
    expect(at('background, Escape').aborts).toHaveLength(5);
    expect(times(at('background, Escape').frame, ABORTED)).toBe(3);
    expect(at('background, Escape').frame).toContain('[✓ idle]');

    // A failed attempt waiting to be tried again: the error shows, once, and
    // Escape is offered, since the turn is still running.
    expect(times(at('retry wait').frame, 'overloaded')).toBe(1);
    expect(at('retry wait').frame).toContain('Error: overloaded');
    expect(at('retry wait').frame).toContain('[✗ error Esc:stop]');
    expect(at('retry wait, Escape').aborts).toHaveLength(6);
    expect(times(at('retry wait, Escape').frame, INTERRUPTING)).toBe(2);
    // The retry's start can't be aborted yet; its first trace once it can be is.
    expect(at('retried').aborts).toHaveLength(8);
    expect(times(at('retried').frame, ABORTED)).toBe(4);
    expect(at('retried').frame).toContain('[✓ idle]');

    // A turn the framework gave up on: its failure's error stands for it,
    // once, with no line for the end after it; Escape isn't offered, and it
    // does nothing.
    expect(times(at('ended error').frame, 'gave up')).toBe(1);
    expect(at('ended error').frame).toContain('Error: gave up');
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
    // Running tools, its start missed: Escape keeps the interrupt rather
    // than taking the turn for none.
    expect(at('no start, Escape').aborts).toEqual(['first:agent']);
    expect(at('no start, Escape').frame).toContain(INTERRUPTING);
    expect(at('no start, Escape').frame).not.toContain('(no turn interrupted)');
    expect(at('no start, Escape').frame).toContain('[… tools');
    expect(at('no start, then completed').frame).toContain('[✓ idle]');
    expect(at('no start, then failed').frame).toContain('Error: a turn the TUI never saw start');
    expect(at('no start, then failed').frame).toContain('[✗ error');
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

      // The turn that ran when the switch started is gone with its framework:
      // a failed switch's error stands, and Escape isn't offered for it.
      const ended = steps.get('switch ended')!;
      const status = scenario === 'switch' ? '[✓ idle]' : '[✗ error]';
      expect(ended.frame).toContain(status);

      // A late end, with no start since the switch, shows nothing and leaves
      // the status line as the switch's end set it.
      const late = steps.get('late end')!;
      expect(late.frame).not.toContain('from before the switch');
      expect(late.frame).toContain(status);
      // A late failure shows, as every failure does.
      const lateFailure = steps.get('late failure')!;
      expect(lateFailure.frame).toContain('Error: a late failure');
      expect(lateFailure.frame).toContain('[✗ error');

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
    // spawn-1 is compiling, so its interrupt is kept; then its run is stopped,
    // then the root's call, in flight, is aborted.
    expect(at('subagents, Escape').aborts).toEqual(['first:spawn-1', 'cancelAll', 'first:agent']);
    expect(at('subagents, Escape').frame).toContain('1 subagent stopped');
    expect(at('subagent compiled').aborts).toEqual(['first:spawn-1', 'cancelAll', 'first:agent', 'first:spawn-1']);
  }, 40000);
});
