import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import {
  appendFileSync, chmodSync, closeSync, constants, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, readSync,
  realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
const realOpenSync = fs.openSync;
import { execFileSync, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetModule, type FleetModuleConfig } from '../src/modules/fleet-module.js';

type Child = ReturnType<FleetModule['getChildren']> extends ReadonlyMap<string, infer C> ? C : never;
type Internal = {
  connectChildSocket: (child: Child) => Promise<void>;
  sendToChild: (child: Child, command: { type: string }) => void;
  waitForExit: (proc: ChildProcess, timeoutMs: number) => Promise<boolean>;
  failLaunch: (child: Child, reason: string, startupLog?: object) => Promise<{ success: boolean; error?: string }>;
};
const internal = (fleet: FleetModule): Internal => fleet as unknown as Internal;

const waitFor = async (what: string, ready: () => boolean): Promise<void> => {
  for (const until = Date.now() + 4_000; !ready(); await Bun.sleep(1)) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
  }
};

const dirs: string[] = [];
const fleets: FleetModule[] = [];
afterEach(async () => {
  await Promise.all(fleets.splice(0).map((fleet) => fleet.stop()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(config: FleetModuleConfig = {}, childIndexPath = join(import.meta.dir, 'mock-fleet-lifecycle-child.ts')) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-launch-output-'));
  dirs.push(dir);
  const fleet = new FleetModule({
    childIndexPath,
    socketWaitTimeoutMs: 10_000, readyTimeoutMs: 10_000, gracefulShutdownMs: 100, sigtermEscalationMs: 100,
    ...config,
  });
  fleets.push(fleet);
  const dataDir = join(dir, 'leaf');
  let launches = 0;
  const launch = async (recipe: object) => {
    const path = join(dir, `recipe-${++launches}.json`);
    writeFileSync(path, JSON.stringify(recipe));
    return fleet.handleToolCall({ id: `launch-${launches}`, name: 'launch', input: { name: 'leaf', recipe: path, dataDir } });
  };
  return { fleet, dataDir, launch, log: join(dataDir, 'startup.log') };
}

const quoted = (lines: string[]): string => lines.map((line) => `  ${line}`).join('\n');

const openPaths = (): string[] => readdirSync('/proc/self/fd').flatMap((fd) => {
  try { return [readlinkSync(join('/proc/self/fd', fd))]; } catch { return []; }
});

describe('a failed launch quotes the child\'s own output', () => {
  test('a child that exits before its socket has its error quoted', async () => {
    const { fleet, launch, log } = setup();
    const error = 'Failed to load recipe from /recipes/miner.json: Recipe "/recipes/miner.json" references ' +
      'environment variable ${GITLAB_TOKEN} which is not set.';
    const result = await launch({ stderr: `${error}\n`, crashBeforeSocket: true });
    expect(result.success).toBe(false);
    expect(result.error).toEndWith(`\nThe child's output during this launch, from ${log}:\n${quoted([error])}`);
    expect(fleet.getChildren().get('leaf')!.exitReason).not.toContain('\n');
  });

  test('a launch quotes only its own output, and says when there was none', async () => {
    const { launch, log } = setup();
    const first = await launch({ stderr: 'the first launch failed this way\n', crashBeforeSocket: true });
    expect(first.error).toEndWith(quoted(['the first launch failed this way']));
    const second = await launch({ crashBeforeSocket: true });
    expect(second.error).toEndWith(`\nThe child wrote nothing to ${log} during this launch.`);
    expect(second.error).not.toContain('the first launch failed this way');
    const file = readFileSync(log, 'utf8');
    const headers = [...file.matchAll(/^--- launch .* ---$/gm)].map((header) => header.index);
    expect(headers).toHaveLength(2);
    expect(file.indexOf('the first launch failed this way')).toBeGreaterThan(headers[0]!);
    expect(file.indexOf('the first launch failed this way')).toBeLessThan(headers[1]!);
  });

  test('a launch quotes only what its child wrote before it exited', async () => {
    const { fleet, launch, log } = setup();
    const api = internal(fleet);
    const first = launch({ stderr: 'FIRST_MARKER\n', crashBeforeSocket: true });
    await waitFor('the first launch\'s child', () => fleet.getChildren().get('leaf')?.process != null);
    const proc = fleet.getChildren().get('leaf')!.process!;
    const failLaunch = api.failLaunch.bind(fleet);
    api.failLaunch = async (child, reason, startupLog) => {
      if (child.process === proc) await waitFor('the second child\'s output', () => readFileSync(log, 'utf8').includes('SECOND_MARKER'));
      return failLaunch(child, reason, startupLog);
    };
    let second: ReturnType<typeof launch> | undefined;
    const relaunch = (): void => { second = launch({ stderr: 'SECOND_MARKER\n', crashBeforeSocket: true }); };
    if (proc.exitCode !== null || proc.signalCode !== null) relaunch();
    else proc.once('exit', relaunch);
    expect((await first).error).toEndWith(`\nThe child's output during this launch, from ${log}:\n${quoted(['FIRST_MARKER'])}`);
    expect((await second!).error).toEndWith(`\nThe child's output during this launch, from ${log}:\n${quoted(['SECOND_MARKER'])}`);
  });

  test.skipIf(process.getuid?.() === 0)('a startup.log the parent can\'t read as the child exits isn\'t read later', async () => {
    const { fleet, launch, dataDir, log } = setup();
    try {
      const first = launch({ stderr: 'FIRST_MARKER\n', crashBeforeSocket: true, lockDataDir: true });
      await waitFor('the first launch\'s child', () => fleet.getChildren().get('leaf')?.process != null);
      const proc = fleet.getChildren().get('leaf')!.process!;
      let second: ReturnType<typeof launch> | undefined;
      const relaunch = (): void => {
        chmodSync(dataDir, 0o755);
        second = launch({ stderr: 'SECOND_MARKER\n', crashBeforeSocket: true });
      };
      if (proc.exitCode !== null || proc.signalCode !== null) relaunch();
      else proc.once('exit', relaunch);
      expect((await first).error).toEndWith(`\n${log} couldn't be read (EACCES), so the child's output isn't quoted.`);
      expect((await second!).error).toEndWith(`\nThe child's output during this launch, from ${log}:\n${quoted(['SECOND_MARKER'])}`);
    } finally {
      chmodSync(dataDir, 0o755);
    }
  });

  test('a launch that fails after its child was ready quotes only what its child wrote before it exited', async () => {
    const { fleet, launch, log } = setup();
    const api = internal(fleet);
    const connect = api.connectChildSocket.bind(fleet);
    const send = api.sendToChild.bind(fleet);
    api.connectChildSocket = async (child) => {
      await connect(child);
      child.process!.once('exit', () => appendFileSync(log, '\n--- launch later ---\nLATER_MARKER\n'));
      await waitFor('the child to be ready', () => child.status === 'ready');
    };
    api.sendToChild = (child, command) => {
      if (command.type === 'subscribe') throw new Error('injected subscription failure');
      send(child, command);
    };
    const result = await launch({ stderr: 'FIRST_MARKER\n' });
    expect(result.error).toStartWith(
      "Child 'leaf' didn't start (subscribe failed: injected subscription failure) and has exited. " +
      'Nothing is running, so call fleet--launch again once the cause is fixed.\n',
    );
    expect(result.error).toEndWith(`\nThe child's output during this launch, from ${log}:\n${quoted(['FIRST_MARKER'])}`);
    expect(readFileSync(log, 'utf8')).toEndWith('LATER_MARKER\n');
  });

  test('an exit after a launch that succeeded reads nothing', async () => {
    const { fleet, launch, dataDir, log } = setup();
    const crash = join(dataDir, '..', 'crash-now');
    expect((await launch({ crashOnFile: crash })).success).toBe(true);
    const opened: string[] = [];
    const spy = spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
      opened.push(String(path));
      return realOpenSync(path, flags, mode);
    });
    try {
      writeFileSync(crash, '');
      await waitFor('the child\'s exit', () => fleet.getChildren().get('leaf')?.status === 'crashed');
    } finally {
      spy.mockRestore();
    }
    expect(opened).not.toContain(log);
  });

  test('blank output is quoted as one blank line, and output past the last 64 KiB read is said to be the end', async () => {
    const { launch, log } = setup();
    const result = await launch({ stderr: '\n \n\n', crashBeforeSocket: true });
    expect(result.error).toEndWith(`\nThe child's output during this launch, from ${log}:\n  `);
    const tail = await launch({ stderr: `an error\n${'\n'.repeat(70_000)}`, crashBeforeSocket: true });
    expect(tail.error).toEndWith(`\nThe end of the child's output during this launch (the rest is in ${log}):\n  `);
  });

  test('a long output is quoted by its last 20 lines', async () => {
    const { launch, log } = setup();
    const lines = Array.from({ length: 100 }, (_, i) => `output line ${i + 1}`);
    const result = await launch({ stderr: `${lines.join('\n')}\n\n`, crashBeforeSocket: true });
    expect(result.error).toEndWith(
      `\nThe end of the child's output during this launch (the rest is in ${log}):\n${quoted(lines.slice(-20))}`,
    );
  });

  test('a long output is quoted within 2,000 characters as printed, by whole lines or the end of one', async () => {
    const { launch, log } = setup();
    const lines = Array.from({ length: 3 }, (_, i) => `${i + 1}${'.'.repeat(663)}`);
    expect(quoted(lines).length).toBe(2_000);
    const exact = await launch({ stderr: `x\n${lines.join('\n')}\n`, crashBeforeSocket: true });
    expect(exact.error).toEndWith(
      `\nThe end of the child's output during this launch (the rest is in ${log}):\n${quoted(lines)}`,
    );
    const long = await launch({ stderr: `${'x'.repeat(4_000)}the end\n`, crashBeforeSocket: true });
    expect(long.error).toEndWith(
      `\nThe end of the child's output during this launch (the rest is in ${log}):\n  ${'x'.repeat(1_991)}the end`,
    );
    // An emoji is two UTF-16 code units, so the cut lands inside one, which goes.
    const astral = await launch({ stderr: `${'\u{1F600}'.repeat(1_500)}z\n`, crashBeforeSocket: true });
    expect(astral.error).toEndWith(
      `\nThe end of the child's output during this launch (the rest is in ${log}):\n  ${'\u{1F600}'.repeat(998)}z`,
    );
  });

  test('escape sequences in the output are left out of the quote', async () => {
    const { launch, log } = setup();
    const result = await launch({
      stderr: '\x1b[0m\x1b[31merror\x1b[0m\x1b[2m:\x1b[0m \x1b[1mno API key\x1b[0m\n\x1b]0;a title\x07\x1bcdone\n' +
        // A DCS and an APC string, a character-set switch, and the C1 CSI.
        '\x1bPq#0\x1b\\\x1b_app\x1b\\\x1b(Bplain \u009b31mtext\n',
      crashBeforeSocket: true,
    });
    expect(result.error).toEndWith(
      `\nThe child's output during this launch, from ${log}:\n${quoted(['error: no API key', 'done', 'plain text'])}`,
    );
  });

  test('control characters other than tab and newline are left out of the quote', async () => {
    const { launch, log } = setup();
    const result = await launch({
      stderr: 'a bell\x07 and a backspace\x08\r\n\tindented\x00\x7f\u0085\nprogress 10%\rprogress 20%\r\n' +
        'from\x0b\x0c\x1f\u0080 the edges\n',
      crashBeforeSocket: true,
    });
    expect(result.error).toEndWith(
      `\nThe child's output during this launch, from ${log}:\n` +
      quoted(['a bell and a backspace', '\tindented', 'progress 10%progress 20%', 'from the edges']),
    );
    const only = await launch({ stderr: '\x07\x1b[0m\n', crashBeforeSocket: true });
    expect(only.error).toEndWith(`\nThe child's output during this launch, from ${log}:\n  `);
  });

  test('a sequence with no end hides at most the rest of its own line', async () => {
    const { launch, log } = setup();
    const result = await launch({
      stderr: 'a title\x1b]0;never ended\nError: the first line after it\nhalf \u009dand a lone C1 OSC\nthe last line\n',
      crashBeforeSocket: true,
    });
    expect(result.error).toEndWith(
      `\nThe child's output during this launch, from ${log}:\n` +
      quoted(['a title', 'Error: the first line after it', 'half ', 'the last line']),
    );
  });

  // A spawn that fails, such as for a runtime that isn't there, starts no
  // process: its pid stays undefined and no exit comes for it.
  test('a launch whose spawn started no process says so, without a stop, and leaves no starting record', async () => {
    const { fleet, log } = setup();
    const api = internal(fleet);
    api.waitForExit = async () => { throw new Error('waited for an exit'); };
    let killed = false;
    const child = {
      name: 'leaf', status: 'starting', exitedAt: null, exitCode: null, exitReason: null, pid: null, socket: null, autoRestart: true,
      process: { pid: undefined, exitCode: null, signalCode: null, kill: () => { killed = true; return false; } },
    } as unknown as Child;
    const result = await api.failLaunch(child, 'launch failed: socket did not appear', { path: log, offset: 0, dev: 0n, ino: 0n });
    expect(result.error).toBe(
      "Child 'leaf' didn't start (launch failed: socket did not appear): no process started for it, as when the " +
      "child's runtime can't be found, so there's nothing to stop and no output to quote. Nothing is running; if " +
      'fleet--restart fails the same way, ask whoever runs this host.',
    );
    expect(killed).toBe(false);
    expect(child.status).toBe('crashed');
    expect(child.exitReason).toBe('launch failed: socket did not appear; no process started for this launch');
    expect(child.autoRestartStopped).toBe(
      'no process started for its launch, which is not retried; fleet--restart tries again, and if that fails the ' +
      'same way, ask whoever runs this host',
    );
  });

  test('a startup.log truncated below where the launch began is quoted from its end, and said to be that', async () => {
    const { launch, log } = setup();
    const rewritten = await launch({ truncateStartupLog: true, stderr: 'written after the truncation\n', crashBeforeSocket: true });
    expect(rewritten.error).toEndWith(
      `\n${log} was truncated during this launch, so this is what it holds now, ` +
      `which may not be this launch's output:\n${quoted(['written after the truncation'])}`,
    );
    const emptied = await launch({ truncateStartupLog: true, crashBeforeSocket: true });
    expect(emptied.error).toEndWith(`\n${log} was truncated during this launch, and is empty now.`);
  });

  test('a startup.log replaced during the launch isn\'t read, since it isn\'t the file the child was given', async () => {
    const { launch, log } = setup();
    const result = await launch({ replaceStartupLog: 'a line the child never wrote\n', stderr: 'unseen\n', crashBeforeSocket: true });
    expect(result.error).toEndWith(`\n${log} was replaced during this launch, so it isn't the file the child was given, and isn't read.`);
    expect(result.error).not.toContain('a line the child never wrote');
  });

  test('a link at startup.log when the launch starts is followed, and its target quoted', async () => {
    const { dataDir, launch, log } = setup();
    mkdirSync(dataDir, { recursive: true });
    const target = join(dataDir, '..', 'linked.log');
    writeFileSync(target, '');
    symlinkSync(target, log);
    const result = await launch({ stderr: 'LINKED_MARKER\n', crashBeforeSocket: true });
    expect(result.error).toEndWith(`\nThe child's output during this launch, from ${log}:\n${quoted(['LINKED_MARKER'])}`);
    expect(readFileSync(target, 'utf8')).toContain('--- launch ');
    expect(lstatSync(log).isSymbolicLink()).toBe(true);
  });

  test('a child stopped for a ready timeout has what it wrote quoted', async () => {
    const { fleet, launch, log } = setup({ readyTimeoutMs: 500 });
    const result = await launch({ stderr: 'Open https://example.test/device and enter code: ABCD-1234\n', ready: false });
    expect(result.error).toStartWith(
      "Child 'leaf' didn't start (child did not become ready: the child didn't report ready within 500 ms) and has exited.",
    );
    expect(result.error).toEndWith(
      `\nThe child's output during this launch, from ${log}:\n${quoted(['Open https://example.test/device and enter code: ABCD-1234'])}`,
    );
    expect(fleet.getChildren().get('leaf')!.exitReason).not.toContain('\n');
  });

  test('a startup.log the parent can\'t open says the output wasn\'t kept', async () => {
    const { launch, log } = setup();
    mkdirSync(log, { recursive: true });
    const result = await launch({ stderr: 'lost\n', crashBeforeSocket: true });
    expect(result.error).toEndWith(
      `\n${log} couldn't be opened when the child started (EISDIR), so the child's console output wasn't kept.`,
    );
  });

  test('a FIFO at startup.log as the launch starts doesn\'t block it, with or without a reader', async () => {
    const { launch, dataDir, log } = setup();
    mkdirSync(dataDir, { recursive: true });
    execFileSync('mkfifo', [log]);
    const unread = await launch({ stderr: 'lost\n', crashBeforeSocket: true });
    expect(unread.error).toEndWith(
      `\n${log} couldn't be opened when the child started (ENXIO), so the child's console output wasn't kept.`,
    );
    const reader = openSync(log, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const read = await launch({ stderr: 'lost\n', crashBeforeSocket: true });
      expect(read.error).toEndWith(`\n${log} isn't a regular file, so the child's console output wasn't kept.`);
      let received = 0;
      try { received = readSync(reader, Buffer.alloc(256)); } catch { /* EAGAIN: nothing written */ }
      expect(received).toBe(0);
      if (process.platform === 'linux') expect(openPaths().filter((path) => path === realpathSync(log))).toHaveLength(1);
    } finally {
      closeSync(reader);
    }
  });

  // A file-size limit stands in for a full disk: with SIGXFSZ ignored, a write
  // past it fails with EFBIG.
  test('a launch whose header can\'t be written gives the child no file, and says why', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-launch-output-'));
    dirs.push(dir);
    const dataDir = join(dir, 'leaf');
    const log = join(dataDir, 'startup.log');
    mkdirSync(dataDir);
    writeFileSync(log, 'y'.repeat(4_096 - 10));
    const recipe = join(dir, 'recipe.json');
    const stderrKind = join(dir, 'stderr-kind');
    writeFileSync(recipe, JSON.stringify({ stderr: 'lost\n', crashBeforeSocket: true, reportStderr: stderrKind }));
    const script = join(dir, 'launch.ts');
    writeFileSync(script, [
      'import { readdirSync, readlinkSync, realpathSync } from "node:fs";',
      `import { FleetModule } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'modules', 'fleet-module.ts'))};`,
      `const fleet = new FleetModule({ childIndexPath: ${JSON.stringify(join(import.meta.dir, 'mock-fleet-lifecycle-child.ts'))},`,
      '  socketWaitTimeoutMs: 10_000, readyTimeoutMs: 10_000, gracefulShutdownMs: 100, sigtermEscalationMs: 100 });',
      `const input = { name: 'leaf', recipe: ${JSON.stringify(recipe)}, dataDir: ${JSON.stringify(dataDir)} };`,
      'const result = await fleet.handleToolCall({ id: "launch", name: "launch", input });',
      'await fleet.stop();',
      `const log = realpathSync(${JSON.stringify(log)});`,
      'const open = process.platform !== "linux" ? [] : readdirSync("/proc/self/fd").filter((fd) => {',
      '  try { return readlinkSync(`/proc/self/fd/${fd}`) === log; } catch { return false; }',
      '});',
      'console.log(JSON.stringify({ result, open }));',
    ].join('\n'));
    const run = Bun.spawnSync({
      cmd: ['bash', '-c', 'trap "" XFSZ; ulimit -f 4; exec "$0" "$1"', process.execPath, script],
      env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
      timeout: 15_000,
    });
    const { result, open } = JSON.parse(run.stdout.toString().trim().split('\n').at(-1) ?? 'null');
    expect(result.error).toEndWith(
      `\n${log} couldn't be written to when the child started (EFBIG), so the child's console output wasn't kept.`,
    );
    expect(readFileSync(stderrKind, 'utf8')).toBe('not a file');
    expect(open).toEqual([]);
  }, 20_000);

  // Bun's spawn throws for a NUL byte in an argument.
  test.skipIf(process.platform !== 'linux')('a spawn that throws leaves no descriptor open on startup.log', async () => {
    const { fleet, launch, log } = setup({}, `${join(import.meta.dir, 'mock-fleet-lifecycle-child.ts')}\0`);
    const result = await launch({});
    expect(result.success).toBe(false);
    expect(readFileSync(log, 'utf8')).toContain('--- launch ');
    expect(openPaths()).not.toContain(realpathSync(log));
    expect(fleet.getChildren().get('leaf')!.status).toBe('crashed');
    expect(result.error).toStartWith('Child \'leaf\' didn\'t start (launch failed: its spawn refused a value from this ' +
      'host\'s configuration: The argument \'args[0]\' must be a string without null bytes. (ERR_INVALID_ARG_VALUE)): ');
  });

  test('a launch that runs without the file says so in the host\'s log', async () => {
    const { launch, log } = setup();
    mkdirSync(log, { recursive: true });
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await launch({});
      expect(result.success).toBe(true);
      expect(errors).toHaveBeenCalledWith(`[fleet] launch of "leaf": ${log} couldn't be opened when the child ` +
        'started (EISDIR), so the child\'s console output wasn\'t kept.');
    } finally {
      errors.mockRestore();
    }
  });

  test.skipIf(process.getuid?.() === 0)('a startup.log the parent can\'t read by the child\'s exit gives the error code', async () => {
    const { launch, log } = setup();
    const result = await launch({ stderr: 'unread\n', lockStartupLog: true, crashBeforeSocket: true });
    expect(result.error).toEndWith(`\n${log} couldn't be read (EACCES), so the child's output isn't quoted.`);
  });

  test('a startup.log that is a FIFO by the child\'s exit isn\'t read, and doesn\'t block', async () => {
    const { launch, log } = setup();
    const result = await launch({ fifoStartupLog: true, crashBeforeSocket: true });
    expect(result.error).toEndWith(`\n${log} isn't a regular file now, so it isn't read.`);
  });

  test('an unconfirmed termination quotes the output too', async () => {
    const { fleet, launch, log } = setup({ readyTimeoutMs: 100 });
    const api = internal(fleet);
    const connect = api.connectChildSocket.bind(fleet);
    const wait = api.waitForExit.bind(fleet);
    let child: Child | undefined;
    let kill: ChildProcess['kill'] | undefined;
    api.connectChildSocket = async (starting) => {
      await connect(starting);
      child = starting;
      kill = starting.process!.kill.bind(starting.process!);
      starting.process!.kill = () => false;
    };
    api.waitForExit = async () => false;
    try {
      const result = await launch({ stderr: 'started, and never ready\n', ready: false });
      expect(result.error).toContain("this host couldn't confirm that its process stopped");
      expect(result.error).toEndWith(`\nThe child's output during this launch, from ${log}:\n${quoted(['started, and never ready'])}`);
      expect(child!.exitReason).not.toContain('\n');
    } finally {
      api.waitForExit = wait;
      if (child?.process && kill) {
        child.process.kill = kill;
        child.process.kill('SIGKILL');
        await wait(child.process, 5_000);
      }
    }
  });

  test('a real child whose recipe names an unset variable has that error quoted', async () => {
    delete process.env.FLEET_LAUNCH_OUTPUT_TEST_UNSET;
    const { launch } = setup({}, join(import.meta.dir, '..', 'src', 'index.ts'));
    const result = await launch({
      name: 'Unset variable',
      agent: { name: 'leaf', systemPrompt: '${FLEET_LAUNCH_OUTPUT_TEST_UNSET}' },
      modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('\nThe child\'s output during this launch, from ');
    expect(result.error).toContain('references environment variable ${FLEET_LAUNCH_OUTPUT_TEST_UNSET} which is not set.');
  }, 20_000);
});

describe('a launch whose spawn starts no process', () => {
  async function started(config: FleetModuleConfig) {
    const made = setup(config);
    let saved: { children: Record<string, { status: string; exitReason: string | null }> } | undefined;
    await made.fleet.start({ getState: () => null, setState: (value: typeof saved) => { saved = value; } } as unknown as
      Parameters<FleetModule['start']>[0]);
    made.fleet.launchAutoStart();
    return { ...made, saved: () => saved };
  }

  for (const [kind, runtime, code] of [
    ['isn\'t there', () => '/nonexistent/fleet-runtime', 'ENOENT'],
    ['may not be run', () => {
      const dir = mkdtempSync(join(tmpdir(), 'fleet-runtime-'));
      dirs.push(dir);
      const path = join(dir, 'runtime');
      writeFileSync(path, '#!/bin/sh\n');
      chmodSync(path, 0o644);
      return path;
    }, 'EACCES'],
  ] as const) {
    test(`a runtime that ${kind} fails the launch at once with its code, for whoever runs the host to fix`, async () => {
      const { fleet, launch, saved } = await started({ childRuntimePath: runtime() });
      const result = await launch({});
      // The socket wait's 10 s is past bun:test's default 5 s timeout, so a pass
      // shows the wait ended on the spawn's error.
      expect(result.error).toStartWith(`Child 'leaf' didn't start (launch failed: its runtime couldn't be started: `);
      expect(result.error).toContain(code);
      expect(result.error).toEndWith('): no process started for it, so there\'s nothing to stop and no output to ' +
        'quote. Nothing is running, and calling fleet--launch again fails the same way until whoever runs this host ' +
        'fixes its child runtime, so ask them.');
      const record = fleet.getChildren().get('leaf')!;
      expect(record.status).toBe('crashed');
      expect(record.exitReason).toStartWith('launch failed: its runtime couldn\'t be started: ');
      expect(record.exitReason).toEndWith('; no process started for this launch');
      expect(saved()!.children.leaf.status).toBe('crashed');
      expect((await launch({})).error).toStartWith(`Child 'leaf' didn't start (launch failed: its runtime couldn't`);
    });
  }

  test.skipIf(process.platform !== 'linux')('a runtime the system can\'t execute fails the launch with its code, for whoever runs the host to fix', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-runtime-'));
    dirs.push(dir);
    const file = join(dir, 'file');
    writeFileSync(file, 'not a program\n');
    chmodSync(file, 0o755);
    symlinkSync(join(dir, 'loop-b'), join(dir, 'loop-a'));
    symlinkSync(join(dir, 'loop-a'), join(dir, 'loop-b'));
    for (const [runtime, code] of [[join(dir, 'loop-a'), 'ELOOP'], [join(file, 'bun'), 'ENOTDIR'], [file, 'ENOEXEC']] as const) {
      const { launch } = setup({ childRuntimePath: runtime });
      const result = await launch({});
      expect(result.error).toContain(`(launch failed: its runtime couldn't be started: ${code}: `);
      expect(result.error).toEndWith('Nothing is running, and calling fleet--launch again fails the same way until ' +
        'whoever runs this host fixes its child runtime, so ask them.');
    }
  });

  test('a runtime that isn\'t there ends automatic restarts, saying whose it is to fix, and fleet--restart starts it once it is', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-runtime-'));
    dirs.push(dir);
    const runtime = join(dir, 'runtime');
    const { fleet } = await started({ childRuntimePath: runtime });
    const recipe = join(dir, 'recipe.json');
    writeFileSync(recipe, '{}');
    const result = await fleet.handleToolCall({ id: 'auto', name: 'launch',
      input: { name: 'auto', recipe, dataDir: join(dir, 'auto'), autoRestart: true } });
    expect(result.success).toBe(false);
    expect(fleet.getChildren().get('auto')!.autoRestartStopped).toBe(
      'its runtime couldn\'t be started, which is not retried; once whoever runs this host fixes it, ' +
      'fleet--restart starts it again');
    symlinkSync(process.execPath, runtime);
    const restarted = await fleet.handleToolCall({ id: 'restart', name: 'restart', input: { name: 'auto' } });
    expect(restarted.success).toBe(true);
    expect(fleet.getChildren().get('auto')!.status).toBe('ready');
  });

  test('an env value the spawn refuses fails an autoStart launch, without the value reaching its log line, the record or startup.log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-env-'));
    dirs.push(dir);
    const recipe = join(dir, 'recipe.json');
    writeFileSync(recipe, '{}');
    const dataDir = join(dir, 'leaf');
    const secret = 'top-secret-env-value';
    const written: string[] = [];
    const errors = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { written.push(args.map(String).join(' ')); });
    const stderr = spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const failed = '[fleet] autoStart "leaf" failed: ';
    let made: Awaited<ReturnType<typeof started>>;
    try {
      made = await started({
        autoStart: [{ name: 'leaf', recipe, dataDir, autoRestart: true, env: { FLEET_TEST_SECRET: `${secret}\0` } }],
      });
      await waitFor('the autoStart failure to be logged', () => written.some((line) => line.startsWith(failed)));
    } finally {
      errors.mockRestore();
      stderr.mockRestore();
    }
    const line = written.find((logged) => logged.startsWith(failed))!;
    expect(line).toStartWith(`${failed}Child 'leaf' didn't start (launch failed: its spawn refused a value from this ` +
      'host\'s configuration: ');
    expect(line).toContain('FLEET_TEST_SECRET');
    expect(line).toEndWith('(ERR_INVALID_ARG_VALUE)): no process started for it, so there\'s nothing to stop and no ' +
      'output to quote. Nothing is running, and only whoever runs this host can change that value and restart the ' +
      'host, so ask them.');
    expect(written.join('')).not.toContain(secret);
    const record = made.fleet.getChildren().get('leaf')!;
    expect(record.status).toBe('crashed');
    expect(record.autoRestartStopped).toBe('its spawn refused a value from this host\'s configuration, which is not ' +
      'retried; it can start again once whoever runs this host changes that value and restarts the host');
    expect(JSON.stringify(made.saved())).not.toContain(secret);
    expect(JSON.stringify(made.saved())).toContain('ERR_INVALID_ARG_VALUE');
    expect(readFileSync(join(dataDir, 'startup.log'), 'utf8')).not.toContain(secret);
  });

  test('a refused argument\'s message is cut before its value, or given as its code alone', () => {
    const { fleet } = setup();
    const failure = (message: string, code: string) => (fleet as unknown as {
      spawnFailure(child: object): string;
    }).spawnFailure({ spawnError: Object.assign(new TypeError(message), { code }) });
    expect(failure('The argument \'args[0]\' must be a string without null bytes. Received \'x\\x00\'', 'ERR_INVALID_ARG_VALUE'))
      .toBe('its spawn refused a value from this host\'s configuration: The argument \'args[0]\' must be a string ' +
        'without null bytes. (ERR_INVALID_ARG_VALUE)');
    expect(failure('The "options.env" property must be of type object, holding secret-env-value', 'ERR_INVALID_ARG_TYPE'))
      .toBe('its spawn refused a value from this host\'s configuration: ERR_INVALID_ARG_TYPE');
    expect(failure('bad file descriptor', 'EBADF')).toBe('its spawn failed: bad file descriptor (EBADF)');
    expect(failure('EBADF: bad file descriptor, posix_spawn \'/usr/bin/bun\'', 'EBADF'))
      .toBe('its spawn failed: EBADF: bad file descriptor, posix_spawn \'/usr/bin/bun\'');
    expect(failure('ENOENT: no such file or directory, posix_spawn \'/nonexistent/bun\'', 'ENOENT'))
      .toBe('its runtime couldn\'t be started: ENOENT: no such file or directory, posix_spawn \'/nonexistent/bun\'');
  });

  test('a name, recipe or data directory holding a NUL byte is refused before anything starts, naming the agent\'s field', async () => {
    const { fleet, dataDir } = setup();
    const recipe = join(dataDir, '..', 'recipe.json');
    writeFileSync(recipe, '{}');
    const refused = async (input: object) => {
      const result = await fleet.handleToolCall({ id: 'nul', name: 'launch', input });
      expect(fleet.getChildren().size).toBe(0);
      expect(fs.existsSync(dataDir)).toBe(false);
      return result.error;
    };
    const refusal = 'Nothing was launched: fleet--launch\'s "recipe" is the recipe\'s path or URL, which can\'t hold a ' +
      'NUL byte; it got the string "/recipes/leaf\\u0000.json".';
    expect(await refused({ name: 'leaf', recipe: '/recipes/leaf\0.json', dataDir })).toBe(refusal);
    expect(await refused({ name: 'leaf', recipe, dataDir: `${dataDir}\0` })).toBe(
      'Nothing was launched: fleet--launch\'s "dataDir" is the child\'s data directory, which can\'t hold a NUL byte; ' +
      `it got the string ${JSON.stringify(`${dataDir}\0`)}.`);
    expect(await refused({ name: 'le\0af', recipe, dataDir })).toBe(
      'Nothing was launched: fleet--launch\'s "name" is the child\'s short name, which can\'t hold a NUL byte; it got ' +
      'the string "le\\u0000af".');
    const withEnv = await fleet.handleToolCall({ id: 'nul-env', name: 'launch',
      input: { name: 'leaf', recipe, dataDir, env: { FLEET_TEST_AGENT_ENV: 'agent\0value' } } });
    expect(withEnv.success).toBe(true);
    const logged: string[] = [];
    const errors = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    try {
      const auto = setup({ autoStart: [{ name: 'leaf', recipe: '/recipes/leaf\0.json', dataDir }] });
      await auto.fleet.start({ getState: () => null, setState: () => {} } as unknown as Parameters<FleetModule['start']>[0]);
      auto.fleet.launchAutoStart();
      const autoStart = () => logged.filter((line) => line.startsWith('[fleet] autoStart "leaf"'));
      await waitFor('the autoStart refusal to be logged', () => autoStart().length > 0);
      expect(autoStart()).toEqual([`[fleet] autoStart "leaf" failed: ${refusal}`]);
      expect(auto.fleet.getChildren().has('leaf')).toBe(false);
    } finally {
      errors.mockRestore();
    }
  });

  test('an error reported for a running child is logged and leaves it running', async () => {
    const { fleet, launch } = setup();
    expect((await launch({})).success).toBe(true);
    const child = fleet.getChildren().get('leaf')!;
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      child.process!.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' }));
      expect(errors).toHaveBeenCalledWith(`[fleet] child "leaf" (pid ${child.pid}): kill EPERM`);
    } finally {
      errors.mockRestore();
    }
    expect(child.status).toBe('ready');
    expect(child.spawnError).toBeUndefined();
  });
});
