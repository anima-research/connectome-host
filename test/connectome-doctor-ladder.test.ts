import { describe, test, expect, afterAll, afterEach } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

const LADDER = resolve(import.meta.dir, '..', 'scripts', 'connectome-doctor');
const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map((c) => c.exitCode !== null || c.signalCode !== null ? null
    : new Promise((done) => { c.once('exit', done); c.kill('SIGKILL'); })));
});
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function bin(dir: string, name: string, script: string): void {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
}

const lines = (path: string): number => existsSync(path) ? readFileSync(path, 'utf-8').split('\n').filter(Boolean).length : 0;

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

interface Host {
  process: ChildProcess;
  signals: string;
  ticks: string;
}

async function standInHost(dir: string, listens: boolean, dumpsTo?: string, dumpDelay?: number): Promise<Host> {
  const signals = join(dir, 'signals');
  const ticks = join(dir, 'ticks');
  const dump = join(dir, 'dump-line');
  writeFileSync(dump, '[diagnostics] {"activeStreams":[],"gate":{"inferring":false}}\n');
  const writesDump = dumpsTo ? `cat ${dump} >> ${dumpsTo}; `
    : `printf "%s.000000 host bun[1]: %s\\n" "$(date +%s)" "$(cat ${dump})" >> ${join(dir, 'journal.txt')}; `;
  const trap = listens ? `trap '${dumpDelay ? `sleep ${dumpDelay}; ` : ''}${writesDump}echo usr2 >> ${signals}' USR2; ` : '';
  const process = spawn('sh', ['-c', `${trap}while :; do echo t >> ${ticks}; sleep 0.05; done`], { stdio: 'ignore' });
  children.push(process);
  await waitFor(() => lines(ticks) > 0, 'the stand-in host to start');
  return { process, signals, ticks };
}

interface Install {
  work: string;
  bins: string;
  host: Host;
  started: number;
  now: number;
  mainPidNow?: string;
}

interface Unit {
  restarts?: string;
  neverStarted?: boolean;
  active?: string;
  text?: string;
  mainPidNow?: string;
}

function systemctl(at: Install, unit: Unit = {}): void {
  const startStamp = unit.neverStarted ? '' : new Date(at.started * 1000).toUTCString().replace('GMT', 'UTC');
  writeFileSync(join(at.work, 'unit.txt'), unit.text ?? '');
  bin(at.bins, 'systemctl', [
    'case "$*" in',
    `  *FragmentPath*) echo ${join(at.work, 'unit.txt')} ;;`,
    `  *--value*) echo ${unit.mainPidNow ?? at.mainPidNow ?? at.host.process.pid} ;;`,
    `  *) printf "ActiveState=${unit.active ?? 'active'}\\nSubState=running\\nNRestarts=${unit.restarts ?? '0'}\\nExecMainStartTimestamp=${startStamp}\\nMainPID=${at.host.process.pid}\\n" ;;`,
    'esac',
  ].join('\n'));
}

async function install(opts: {
  listens: boolean; journalFails?: string; dumpReadFails?: boolean; dumpReadHangs?: boolean; dumpsTo?: string;
  grepRefused?: string; dumpDelay?: number; mainPidNow?: string;
}): Promise<Install> {
  const work = mkdtempSync(join(tmpdir(), 'chost-ladder-'));
  dirs.push(work);
  mkdirSync(join(work, 'data'));
  mkdirSync(join(work, 'logs'));
  const bins = join(work, 'bin');
  mkdirSync(bins);
  const host = await standInHost(work, opts.listens, opts.dumpsTo && join(work, opts.dumpsTo), opts.dumpDelay);
  const now = Math.floor(Date.now() / 1000);
  const at = { work, bins, host, started: now - 60, now, mainPidNow: opts.mainPidNow };
  systemctl(at);
  const journal = join(work, 'journal.txt');
  bin(bins, 'journalctl', opts.journalFails !== undefined
    ? `echo "${opts.journalFails}" >&2; exit 1`
    : [
      'unit="--user -u connectome-test.service"',
      'case "$*" in',
      `  "$unit -q --no-pager -n 1 -o short-unix") tail -n 1 ${journal} ;;`,
      opts.grepRefused !== undefined
        ? `  "$unit -q --no-pager --since @"*" -g "*" -o short-unix") echo "${opts.grepRefused}" >&2; exit 1 ;;`
        : `  "$unit -q --no-pager --since @"*" -g "*" -o short-unix") awk -v since="\${7#@}" '$1 + 0 >= since' ${journal} | grep -P -- "$9" ;;`,
      opts.dumpReadFails
        ? '  "$unit -o cat --no-pager --since @"*) echo "Failed to open the journal: Permission denied" >&2; exit 1 ;;'
        : opts.dumpReadHangs ? '  "$unit -o cat --no-pager --since @"*) exec sleep 10 ;;'
        : `  "$unit -o cat --no-pager --since @"*) echo read >> ${join(work, 'dump-reads')}; awk -v since="\${8#@}" '$1 + 0 >= since { sub(/^[^ ]+ [^ ]+ [^ ]+ /, ""); print }' ${journal} ;;`,
      '  *) echo "journalctl stand-in: arguments it doesn\'t answer: $*" >&2; exit 2 ;;',
      'esac',
    ].join('\n'));
  writeFileSync(join(work, 'journal.txt'), [
    `${now - 30}.000000 host bun[1]: started`,
    `${now - 20}.000000 host bun[1]: [inference-failed] the model call failed: 400 prompt is too long`,
    `${now - 10}.000000 host bun[1]: [routeSpeech] discord:1/2: routed 12 chars -> discord:1/2 (server=discord, delivered=true)`,
    `${now - 5}.000000 host bun[1]: an ordinary line`,
    '',
  ].join('\n'));
  return at;
}

function ladder(at: Install, extra: string[] = [], env: Record<string, string> = {}, unit = 'connectome-test.service'): { out: string; status: number | null } {
  const ran = spawnSync('python3', [LADDER, ...extra, at.work, unit], {
    encoding: 'utf-8',
    env: { ...process.env, ...env, PATH: `${at.bins}:${process.env.PATH}` },
    timeout: 30_000,
  });
  return { out: `${ran.stdout}${ran.stderr}`, status: ran.status };
}

const signalled = (host: Host): boolean => lines(host.signals) > 0;
const alive = (host: Host): boolean => host.process.exitCode === null && host.process.signalCode === null;
const stamp = (ts: number): string => new Date(ts * 1000).toISOString().slice(5, 19).replace('T', ' ');

async function settled(host: Host): Promise<void> {
  const from = lines(host.ticks);
  await waitFor(() => !alive(host) || lines(host.ticks) >= from + 2, 'two more turns of the stand-in host');
}

describe('the ladder, for a unit that logs to the journal', () => {
  test('its failures, its delivery and its gate dump come from the journal, and logs/failures.log is read too', async () => {
    const at = await install({ listens: true });
    writeFileSync(join(at.work, 'logs', 'failures.log'),
      `${JSON.stringify({ at: new Date().toISOString(), agent: 'resident', consecutive: 1, reason: 'Error: 529 overloaded' })}\n`);
    const { out } = ladder(at);
    await settled(at.host);
    expect(out).toContain('[inference-failed] the model call failed: 400 prompt is too long');
    expect(out).toContain('Error: 529 overloaded');
    expect(out).toMatch(/routeSpeech delivery .*routed 12ch -> discord:1\/2/);
    expect(out).toContain('live gate dump (SIGUSR2): {"activeStreams":[]');
    expect(signalled(at.host)).toBe(true);
    expect(alive(at.host)).toBe(true);
  });

  test('the delivery stage is the time of the journal\'s last delivery, not of its last entry', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    const { out } = ladder(at);
    expect(out).toMatch(new RegExp(`o routeSpeech delivery +${stamp(at.now - 10)}`));
  });

  test('a reply that wasn\'t delivered after the last one that was is shown as not delivered, and is a finding with the whole line', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    writeFileSync(join(at.work, 'journal.txt'), [
      `${at.now - 10}.000000 host bun[1]: [routeSpeech] discord:1/2: routed 12 chars -> discord:1/2 (server=discord, delivered=true)`,
      `${at.now - 3}.000000 host bun[1]: [routeSpeech] discord:1/2: the channel refused it: ${'r'.repeat(160)} — speech NOT routed (12 chars stay in chronicle)`,
      '',
    ].join('\n'));
    const { out, status } = ladder(at);
    expect(out).toMatch(new RegExp(`x routeSpeech delivery +${stamp(at.now - 10)}.*NOT delivered`));
    expect(out).toMatch(/=== findings ===[\s\S]*the last reply wasn't delivered: discord:1\/2: the channel refused it: r+ — speech NOT routed \(12 chars stay in chronicle\)/);
    expect(status).toBe(1);
  });

  test('a reply whose delivery wasn\'t confirmed is shown as that, beside the last delivery\'s time, and is a finding that it may have reached its channel', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    writeFileSync(join(at.work, 'journal.txt'), [
      `${at.now - 10}.000000 host bun[1]: [routeSpeech] discord:1/2: routed 12 chars -> discord:1/2 (server=discord, delivered=true)`,
      `${at.now - 3}.000000 host bun[1]: [routeSpeech] discord:1/2: the connector timed out — speech delivery NOT confirmed (12 chars stay in chronicle)`,
      '',
    ].join('\n'));
    const { out, status } = ladder(at);
    expect(out).toMatch(new RegExp(`\\? routeSpeech delivery +${stamp(at.now - 10)} +\\( *\\d+s ago\\) +delivery NOT confirmed`));
    expect(out).not.toContain('NOT delivered');
    expect(out).toMatch(/=== findings ===[\s\S]*the last reply's delivery wasn't confirmed, so it may or may not be in its channel: discord:1\/2: the connector timed out/);
    expect(status).toBe(1);
  });

  test('a reply that had no locus is shown as that', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    writeFileSync(join(at.work, 'journal.txt'), [
      `${at.now - 10}.000000 host bun[1]: [routeSpeech] discord:1/2: routed 12 chars -> discord:1/2 (server=discord, delivered=true)`,
      `${at.now - 3}.000000 host bun[1]: [routeSpeech] discord:1/2: turn has no locus (no home/trigger channel; nothing to deliver into) — speech NOT routed (12 chars stay in chronicle)`,
      '',
    ].join('\n'));
    const { out } = ladder(at);
    expect(out).toMatch(/x routeSpeech delivery .*NO LOCUS/);
    expect(out).toMatch(/=== findings ===[\s\S]*the last reply had no locus, so it wasn't delivered and stays in the chronicle: discord:1\/2: turn has no locus \(no home\/trigger channel; nothing to deliver into\) — speech NOT routed/);
  });

  test('a line about a locus that was closed, after a delivery, leaves the delivery stage at that delivery', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    writeFileSync(join(at.work, 'journal.txt'), [
      `${at.now - 10}.000000 host bun[1]: [routeSpeech] discord:1/2: routed 12 chars -> discord:1/2 (server=discord, delivered=true)`,
      `${at.now - 3}.000000 host bun[1]: [routeSpeech] discord:1/2: locus discord:1/2 was closed — opened by delivery (speech implies engagement)`,
      '',
    ].join('\n'));
    const { out } = ladder(at);
    expect(out).toMatch(new RegExp(`o routeSpeech delivery +${stamp(at.now - 10)} .*routed 12ch -> discord:1/2`));
  });

  test('a reply line cut short after its arrow isn\'t taken for a delivery, and doesn\'t stop the ladder', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    writeFileSync(join(at.work, 'journal.txt'), [
      `${at.now - 10}.000000 host bun[1]: [routeSpeech] discord:1/2: routed 12 chars -> discord:1/2 (server=discord, delivered=true)`,
      `${at.now - 3}.000000 host bun[1]: [routeSpeech] discord:1/2: routed 12 chars -> `,
      '',
    ].join('\n'));
    const { out } = ladder(at);
    expect(out).not.toContain('Traceback');
    expect(out).toMatch(new RegExp(`o routeSpeech delivery +${stamp(at.now - 10)} .*routed 12ch -> discord:1/2`));
  });

  test('a window with no reply line in it leaves the last delivery\'s time not known, naming the window', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    writeFileSync(join(at.work, 'journal.txt'), `${at.now - 3}.000000 host bun[1]: an ordinary line\n`);
    expect(ladder(at).out).toMatch(/· routeSpeech delivery +can't be seen here: none in the journal since the unit's latest start$/m);
    writeFileSync(join(at.work, 'logs', 'agent.log'), 'an ordinary line\n');
    expect(ladder(at).out).toMatch(/· routeSpeech delivery +can't be seen here: none in its last 2 MB$/m);
  });

  test('replies with no delivery among them leave the last delivery\'s time not known, not never', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    writeFileSync(join(at.work, 'journal.txt'),
      `${at.now - 3}.000000 host bun[1]: [routeSpeech] discord:1/2: the channel refused it — speech NOT routed (12 chars stay in chronicle)\n`);
    const { out } = ladder(at);
    expect(out).toMatch(/x routeSpeech delivery +--:--:-- +\(not known\) +NOT delivered/);
    expect(out).not.toMatch(/routeSpeech delivery .*never/);
  });

  test('a logs/agent.log left from before the unit started doesn\'t take the journal\'s place', async () => {
    const at = await install({ listens: true });
    const log = join(at.work, 'logs', 'agent.log');
    writeFileSync(log, '[inference-failed] an old failure from the file\n');
    utimesSync(log, at.started - 3600, at.started - 3600);
    const { out } = ladder(at);
    expect(out).toContain('[inference-failed] the model call failed: 400 prompt is too long');
    expect(out).not.toContain('an old failure from the file');
  });

  test('a journal that can\'t be read is named as that, not as a journal with no failures or a unit that logs to a file, and its delivery isn\'t known', async () => {
    const at = await install({ listens: true, journalFails: 'Failed to open the journal: Permission denied' });
    const { out } = ladder(at);
    expect(out).toContain('Permission denied');
    expect(out).not.toContain('none found');
    expect(out).not.toContain('to a file');
    expect(out).toMatch(/· routeSpeech delivery +can't be seen here: the journal can't be read$/m);
    expect(out).not.toMatch(/routeSpeech delivery .*never/);
  });

  test('the journal is read from the unit\'s latest start on, so an earlier run\'s failure isn\'t shown', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    writeFileSync(join(at.work, 'journal.txt'), [
      `${at.started - 10}.000000 host bun[1]: [inference-failed] a failure of the run before`,
      `${at.now - 20}.000000 host bun[1]: [inference-failed] a failure of this run`,
      '',
    ].join('\n'));
    const { out } = ladder(at);
    expect(out).toContain('a failure of this run');
    expect(out).not.toContain('a failure of the run before');
  });

  test('a journalctl that refuses its pattern leaves the run\'s failures and deliveries not known, in its own words, and still asks for the gate dump', async () => {
    const at = await install({ listens: true, grepRefused: 'Compiled without pattern matching support' });
    const { out } = ladder(at);
    await settled(at.host);
    expect(out).toMatch(/^journal    : last entry \S+ ago  its search by pattern failed: Compiled without pattern matching support$/m);
    expect(out).not.toContain('can\'t be read');
    expect(out).toMatch(/· routeSpeech delivery +can't be seen here: the journal couldn't be searched by pattern$/m);
    expect(out).toContain('connectome-test.service\'s journal couldn\'t be searched by pattern (Compiled without pattern matching ' +
      'support), so its failures and deliveries aren\'t shown');
    expect(out).toContain('recent failures in connectome-test.service\'s journal: not known: it couldn\'t be searched by pattern ' +
      '(Compiled without pattern matching support)');
    expect(out).not.toContain('none found');
    expect(out).toContain('live gate dump (SIGUSR2): {"activeStreams":[]');
  });

  test('a journal time keeps its fraction of a second, so a call earlier in a failure\'s second isn\'t taken as after it', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    writeFileSync(join(at.work, 'journal.txt'),
      `${at.now - 20}.900000 host bun[1]: [inference-failed] the model call failed: 529 overloaded\n`);
    writeFileSync(join(at.work, 'data', 'llm-calls.2026-10-30T00-00-00.jsonl'), `${JSON.stringify({
      timestamp: new Date((at.now - 20) * 1000 + 100).toISOString(), kind: 'stream', rawResponse: { stop_reason: 'end_turn' } })}\n`);
    const { out } = ladder(at);
    expect(out).toMatch(/\* inference failures, the last \S+ ago, with no successful turn found since/);
    expect(out).not.toContain('a later call');
  });
});

describe('where the ladder reads a unit\'s output', () => {
  const failing = (what: string): string => `[inference-failed] ${what}\n`;

  test('a unit whose unit file sends its output to a file is read from that file', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    const file = join(at.work, 'host.err');
    writeFileSync(file, failing('from the stderr file'));
    systemctl(at, { text: `[Service]\nStandardError=append:${file}\n` });
    const { out } = ladder(at);
    expect(out).toContain('from the stderr file');
    expect(out).not.toContain('400 prompt is too long');
    expect(out).toContain(`(stdout/err -> ${file})`);
  });

  test('a journalctl that refuses its pattern says nothing of it for a unit whose output goes to a file', async () => {
    const at = await install({ listens: true, grepRefused: 'Compiled without pattern matching support', mainPidNow: '0' });
    const file = join(at.work, 'host.err');
    writeFileSync(file, failing('from the stderr file'));
    systemctl(at, { text: `[Service]\nStandardError=append:${file}\n` });
    const { out } = ladder(at);
    expect(out).toContain(`(stdout/err -> ${file})`);
    expect(out).toContain('from the stderr file');
    expect(out).not.toContain('Compiled without pattern matching support');
    expect(out).not.toContain('searched by pattern');
  });

  test('the gate dump of a unit whose stderr goes to a file comes from that file', async () => {
    const at = await install({ listens: true, dumpsTo: 'host.err' });
    const file = join(at.work, 'host.err');
    writeFileSync(file, failing('from the stderr file'));
    systemctl(at, { text: `[Service]\nStandardError=append:${file}\n` });
    const { out } = ladder(at);
    await settled(at.host);
    expect(signalled(at.host)).toBe(true);
    expect(out).toContain('live gate dump (SIGUSR2): {"activeStreams":[]');
  });

  test('a reply line in logs/agent.log is read whole, even where it holds a Unicode line separator', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    writeFileSync(join(at.work, 'logs', 'agent.log'), [
      '[routeSpeech] discord:1/2: routed 12 chars -> discord:1/2 (server=discord, delivered=true)',
      '[routeSpeech] discord:1/2: the channel refused it\u2028twice — speech NOT routed (12 chars stay in chronicle)',
      '',
    ].join('\n'));
    const { out } = ladder(at);
    expect(out).toMatch(/x routeSpeech delivery .*NOT delivered/);
  });

  test('a logs/agent.log written since the unit started is read', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    writeFileSync(join(at.work, 'logs', 'agent.log'), failing('from agent.log'));
    const { out } = ladder(at);
    expect(out).toContain('from agent.log');
    expect(out).not.toContain('400 prompt is too long');
  });

  test('a file the unit sends its output to that can\'t be read is said, for its failures and for the gate dump', async () => {
    const at = await install({ listens: true });
    const file = join(at.work, 'gone.err');
    systemctl(at, { text: `[Service]\nStandardError=append:${file}\n` });
    const { out } = ladder(at);
    await settled(at.host);
    expect(out).toMatch(new RegExp(`recent failures in ${file}: not known: it can't be read`));
    expect(out).toMatch(new RegExp(`live gate dump: SIGUSR2 sent, but ${file} can't be read`));
    expect(out).not.toContain('no [diagnostics] line was seen');
  });

  test('a unit file that can\'t be read is said, as a line that doesn\'t count, and the rest of the ladder still runs', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    const unitFile = join(at.work, 'unit.txt');
    rmSync(unitFile);
    mkdirSync(unitFile);
    const { out } = ladder(at, ['--findings-json']);
    const line = out.split('\n').find((l) => l.startsWith('connectome-doctor findings: '))!;
    expect(JSON.parse(line.slice('connectome-doctor findings: '.length))).toContainEqual({
      text: `connectome-test.service's unit file, ${unitFile}, can't be read (Is a directory), so whether it sends the host's ` +
        'output to a file isn\'t known', counts: false });
    expect(out).toContain('400 prompt is too long');
  });
});

describe('the ladder\'s recent failures', () => {
  test('an inference failure a later successful call followed is said with when it was, and that whose call isn\'t known, as a line that doesn\'t count', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    const call = (s: number, error?: string, kind = 'stream') => JSON.stringify({ timestamp: new Date(s * 1000).toISOString(),
      kind, rawResponse: { stop_reason: error ? null : 'end_turn', ...(error ? { error } : {}) } });
    const calls = join(at.work, 'data', 'llm-calls.2026-10-30T00-00-00.jsonl');
    writeFileSync(calls, `${call(at.now - 5)}\n`);
    const fixed = ladder(at).out;
    expect(fixed).toMatch(new RegExp(`last inference failure \\S+ ago: a later call, at ${stamp(at.now - 5)}, succeeded; the call ` +
      'log doesn\'t say whose, so whether the agent that failed has recovered isn\'t known'));
    const line = ladder(at, ['--findings-json']).out.split('\n').find((l) => l.startsWith('connectome-doctor findings: '))!;
    expect(JSON.parse(line.slice('connectome-doctor findings: '.length))).toContainEqual({
      text: expect.stringMatching(/^last inference failure \S+ ago: a later call/), counts: false });
    expect(fixed).not.toContain('hard-down');
    const finding = /\* inference failures, the last \S+ ago, with no successful turn found since — if the reason repeats/;
    writeFileSync(calls, `${call(at.now - 25)}\n`);
    expect(ladder(at).out).toMatch(finding);
    writeFileSync(calls, `${call(at.now - 5, '400 prompt is too long')}\n`);
    expect(ladder(at).out).toMatch(finding);
    writeFileSync(calls, `${call(at.now - 25)}\n${call(at.now - 5, undefined, 'complete')}\n`);
    const compressed = ladder(at).out;
    expect(compressed).toMatch(finding);
    expect(compressed).not.toContain('a later call');
    const later = (fields: Record<string, unknown>) => JSON.stringify({ timestamp: new Date((at.now - 5) * 1000).toISOString(),
      kind: 'stream', rawResponse: { stop_reason: 'end_turn' }, ...fields });
    for (const failed of [later({ type: 'error' }), later({ error: 'overloaded' })]) {
      writeFileSync(calls, `${failed}\n`);
      expect(ladder(at).out).toMatch(finding);
    }
  });

  test('a later successful call with newer rows of the call log that can\'t be read says that whether a call after it failed isn\'t known, whenever those rows were written', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    const call = (s: number) => JSON.stringify({ timestamp: new Date(s * 1000).toISOString(), kind: 'stream',
      rawResponse: { stop_reason: 'end_turn' } });
    const calls = join(at.work, 'data', 'llm-calls.2026-10-30T00-00-00.jsonl');
    const unsure = /a later call, at \S+ \S+, succeeded; the call log doesn't say whose, so whether the agent that failed has recovered isn't known; newer rows of the call log can't be read, so whether a call after it failed isn't known/;
    writeFileSync(calls, `${call(at.now - 5)}\n{"timestamp":"${new Date((at.now - 4) * 1000).toISOString()}","kind":"str`);
    expect(ladder(at).out).toMatch(unsure);
    writeFileSync(calls, `${call(at.now - 5)}\n{ not a row }\n`);
    expect(ladder(at).out).toMatch(unsure);
    writeFileSync(calls, `${call(at.now - 5)}\n`);
    const whole = ladder(at).out;
    expect(whole).toMatch(/a later call, at \S+ \S+, succeeded; the call log doesn't say whose/);
    expect(whole).not.toContain('newer rows of the call log');
    writeFileSync(join(at.work, 'journal.txt'), '');
    writeFileSync(join(at.work, 'logs', 'failures.log'), `${JSON.stringify({ at: new Date((at.now - 1000) * 1000).toISOString(),
      agent: 'resident', consecutive: 3, reason: '529 overloaded', kind: 'inference-exhausted' })}\n`);
    writeFileSync(calls, `${call(at.now - 900)}\n{"timestamp":"${new Date((at.now - 890) * 1000).toISOString()}","kind":"str`);
    utimesSync(calls, at.now - 890, at.now - 890);
    mkdirSync(join(at.work, 'data', 'sessions', 's-1'), { recursive: true });
    writeFileSync(join(at.work, 'data', 'sessions.json'), JSON.stringify({ activeSessionId: 's-1', sessions: {} }));
    const payload = [...Buffer.from(JSON.stringify({ triggered: false }))].join(',');
    writeFileSync(join(at.work, 'data', 'sessions', 's-1', 'records.log'),
      `{"record_id":1,"global_sequence":1,"state_id":"messages","data":[${payload}],"timestamp":${(at.now - 100) * 1_000_000}}\n`);
    expect(ladder(at).out).toMatch(unsure);
  });

  test('a later failed call with newer rows of the call log that can\'t be read says whether a turn has succeeded since isn\'t known, not that none has', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    const calls = join(at.work, 'data', 'llm-calls.2026-10-30T00-00-00.jsonl');
    const failed = JSON.stringify({ timestamp: new Date((at.now - 5) * 1000).toISOString(), kind: 'stream', error: '529 overloaded' });
    writeFileSync(calls, `${failed}\n{"timestamp":"${new Date((at.now - 4) * 1000).toISOString()}","kind":"str`);
    const { out } = ladder(at);
    expect(out).toMatch(/inference failures, the last \S+ ago; whether a turn has succeeded since isn't known, since newer rows of the call log can't be read/);
    expect(out).not.toContain('with no successful turn found since');
    writeFileSync(calls, `${failed}\n`);
    expect(ladder(at).out).toMatch(/\* inference failures, the last \S+ ago, with no successful turn found since/);
  });

  test('an exhausted inference that only failures.log still holds is a finding, with its time from the record', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    writeFileSync(join(at.work, 'journal.txt'), '');
    writeFileSync(join(at.work, 'logs', 'failures.log'), `${JSON.stringify({ at: new Date((at.now - 300) * 1000).toISOString(),
      agent: 'resident', consecutive: 3, reason: '529 overloaded', kind: 'inference-exhausted' })}\n`);
    writeFileSync(join(at.work, 'data', 'llm-calls.2026-10-30T00-00-00.jsonl'), `${JSON.stringify({
      timestamp: new Date((at.now - 400) * 1000).toISOString(), kind: 'stream', rawResponse: { stop_reason: 'end_turn' } })}\n`);
    expect(ladder(at).out).toMatch(
      /\* inference failures, the last \d+m ago, with no successful turn found since — if the reason repeats/);
    const line = ladder(at, ['--findings-json']).out.split('\n').find((l) => l.startsWith('connectome-doctor findings: '))!;
    expect(JSON.parse(line.slice('connectome-doctor findings: '.length))).toContainEqual({
      text: expect.stringMatching(/^inference failures, the last \d+m ago, with no successful turn found since/), counts: true });
  });

  test('a failures.log record of another kind makes no inference summary', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    writeFileSync(join(at.work, 'journal.txt'), '');
    writeFileSync(join(at.work, 'logs', 'failures.log'), `${JSON.stringify({ at: new Date((at.now - 300) * 1000).toISOString(),
      agent: 'resident', kind: 'refusal', category: 'policy', streak: 1 })}\n`);
    const { out } = ladder(at);
    expect(out).toContain('"kind":"refusal"');
    expect(out).not.toMatch(/inference failure/);
  });

  test('a failure whose time can\'t be read, beside one whose time can, leaves the finding to the newest failure whose time is known, and says so', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    const file = join(at.work, 'host.err');
    writeFileSync(file, '[inference-failed] agent=resident consecutive=1: 529 overloaded\n');
    systemctl(at, { text: `[Service]\nStandardError=append:${file}\n` });
    writeFileSync(join(at.work, 'logs', 'failures.log'), `${JSON.stringify({ at: new Date((at.now - 300) * 1000).toISOString(),
      agent: 'resident', consecutive: 1, reason: '529 overloaded', kind: 'inference-exhausted' })}\n`);
    const calls = join(at.work, 'data', 'llm-calls.2026-10-30T00-00-00.jsonl');
    const success = (s: number) => `${JSON.stringify({
      timestamp: new Date(s * 1000).toISOString(), kind: 'stream', rawResponse: { stop_reason: 'end_turn' } })}\n`;
    const findings = () => JSON.parse(ladder(at, ['--findings-json']).out.split('\n')
      .find((l) => l.startsWith('connectome-doctor findings: '))!.slice('connectome-doctor findings: '.length));
    writeFileSync(calls, success(at.now - 400));
    expect(findings()).toContainEqual({ text: expect.stringMatching(
      /^inference failures, the last whose time is known \d+m ago, with no successful turn found since/), counts: true });
    writeFileSync(calls, success(at.now - 5));
    expect(findings()).toContainEqual({ text: expect.stringMatching(
      new RegExp(`^last inference failure whose time is known \\d+m ago: a later call, at ${stamp(at.now - 5)}, succeeded`)), counts: false });
    writeFileSync(file, '');
    writeFileSync(join(at.work, 'logs', 'failures.log'), `${JSON.stringify({ at: new Date((at.now - 300) * 1000).toISOString(),
      agent: 'resident', consecutive: 1, reason: '529 overloaded', kind: 'inference-exhausted' })}\n${JSON.stringify({
      agent: 'resident', consecutive: 2, reason: '529 overloaded', kind: 'inference-exhausted' })}\n`);
    writeFileSync(calls, success(at.now - 400));
    expect(findings()).toContainEqual({ text: expect.stringMatching(
      /^inference failures, the last whose time is known \d+m ago, with no successful turn found since/), counts: true });
  });

  test('failures whose time the journal can\'t give are said, with that time not known, as a line that doesn\'t count', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    const file = join(at.work, 'host.err');
    writeFileSync(file, '[inference-failed] the model call failed: 400 prompt is too long\n');
    systemctl(at, { text: `[Service]\nStandardError=append:${file}\n` });
    const { out } = ladder(at, ['--findings-json']);
    const line = out.split('\n').find((l) => l.startsWith('connectome-doctor findings: '))!;
    expect(JSON.parse(line.slice('connectome-doctor findings: '.length))).toContainEqual({
      text: expect.stringMatching(/^inference failures present, and when the last was isn't known here/), counts: false });
  });


  test('every logs/failures.log record but a channel\'s auto-close is a failure, whatever its reason says', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    writeFileSync(join(at.work, 'logs', 'failures.log'), `${JSON.stringify({ reason: '529 overloaded' })}\n${JSON.stringify({
      kind: 'subscription-gc-close', channelId: '101', at: new Date().toISOString(), limitChars: 4000, restore: 'channel_open' })}\n`);
    const { out } = ladder(at);
    expect(out).toMatch(/recent failures in .*failures\.log:\n.*529 overloaded/);
    expect(out).not.toContain('subscription-gc-close');
  });

  test('a newest call log that can\'t be read leaves the inference stage not known, saying so, not never', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    mkdirSync(join(at.work, 'data', 'llm-calls.2026-10-30T00-00-00.jsonl'));
    const { out } = ladder(at);
    expect(out).toMatch(/· inference \(llm call\) +can't be seen here: the newest call log, llm-calls\.2026-10-30T00-00-00\.jsonl, can't be read \(Is a directory\)/);
    expect(out).not.toContain('no readable model call');
  });

  test('with a failure on record and a newest call log that can\'t be read, whether a turn has succeeded since is not known, and doesn\'t count', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    mkdirSync(join(at.work, 'data', 'llm-calls.2026-10-30T00-00-00.jsonl'));
    const line = ladder(at, ['--findings-json']).out.split('\n')
      .find((l) => l.startsWith('connectome-doctor findings: '))!;
    const found = JSON.parse(line.slice('connectome-doctor findings: '.length)) as { text: string; counts: boolean }[];
    expect(found).toContainEqual({ text: expect.stringMatching(/^inference failures, the last \S+ ago; whether a turn has succeeded since isn't known, since the call log can't be read here$/), counts: false });
    expect(found.some((f) => f.text.includes('no successful turn found since'))).toBe(false);
  });

  test('with no call log, the inference stage says so, and with failures on record, whether a turn has succeeded since is not known, and doesn\'t count', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    const data = join(at.work, 'data');
    const found = (): { text: string; counts: boolean }[] => JSON.parse(ladder(at, ['--findings-json']).out.split('\n')
      .find((l) => l.startsWith('connectome-doctor findings: '))!.slice('connectome-doctor findings: '.length));
    expect(ladder(at).out).toContain(`· inference (llm call)       can't be seen here: no call log in ${data}\n`);
    expect(found()).toContainEqual({ text: expect.stringMatching(new RegExp('^inference failures, the last \\S+ ago; whether a turn ' +
      `has succeeded since isn't known, since there's no call log in ${data}$`)), counts: false });
    expect(found().some((f) => f.text.includes('no successful turn found since'))).toBe(false);
    writeFileSync(join(at.work, 'journal.txt'), '');
    expect(ladder(at).out).toMatch(new RegExp(`x inference \\(llm call\\) +--:--:-- +\\( +never\\) +no call log in ${data}$`, 'm'));
  });

  test('a call log that can\'t be looked at leaves the inference stage not known, naming it, and the stages after it still print', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    const calls = join(at.work, 'data', 'llm-calls.2026-10-30T00-00-00.jsonl');
    symlinkSync(calls, calls);
    const { out } = ladder(at);
    expect(out).toMatch(/· inference \(llm call\) +can't be seen here: \S+\/llm-calls\.2026-10-30T00-00-00\.jsonl can't be read \(Too many levels of symbolic links\)$/m);
    expect(out).toMatch(/routeSpeech delivery .*routed 12ch -> discord:1\/2/);
    expect(out).toContain('recent failures in connectome-test.service\'s journal:');
  });

  test.skipIf(process.getuid?.() === 0)('a data directory that can\'t be listed leaves the inference stage not known, naming it, and the stages after it still print', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    const data = join(at.work, 'data');
    chmodSync(data, 0o000);
    try {
      const { out } = ladder(at);
      expect(out).toMatch(/· inference \(llm call\) +can't be seen here: \S+\/data can't be read \(Permission denied\)$/m);
      expect(out).toMatch(/routeSpeech delivery .*routed 12ch -> discord:1\/2/);
      expect(out).toContain('recent failures in connectome-test.service\'s journal:');
    } finally {
      chmodSync(data, 0o755);
    }
  });

  test('the journal\'s failures and failures.log\'s are each shown, under where they came from', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    const records = Array.from({ length: 6 }, (_, i) => JSON.stringify({ reason: `record ${i}` }));
    writeFileSync(join(at.work, 'logs', 'failures.log'), `${records.join('\n')}\n`);
    const { out } = ladder(at);
    expect(out).toMatch(/recent failures in connectome-test\.service's journal:\n.*400 prompt is too long/);
    expect(out).toMatch(/recent failures in .*failures\.log:\n(.*record [1-5].*\n){5}/);
    expect(out).not.toContain('record 0');
  });

  test('a failures.log that can\'t be read, or a link to nothing, is said, not taken as one with no failures or as none there', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    mkdirSync(join(at.work, 'logs', 'failures.log'));
    const { out } = ladder(at);
    expect(out).toMatch(/failures\.log: not known: it can't be read/);
    expect(out).not.toMatch(/failures\.log: none found/);
    rmSync(join(at.work, 'logs', 'failures.log'), { recursive: true });
    symlinkSync('moved-away.log', join(at.work, 'logs', 'failures.log'));
    const dangling = ladder(at).out;
    expect(dangling).toMatch(/failures\.log: not known: it can't be read \(No such file or directory\)/);
    expect(dangling).not.toMatch(/failures\.log: none found/);
  });
});

describe('the ladder\'s gate dump', () => {
  test('a host that hasn\'t installed its SIGUSR2 listener yet isn\'t signalled, and says why and what to do, with a finding that doesn\'t count', async () => {
    const at = await install({ listens: false });
    const { out } = ladder(at);
    await settled(at.host);
    expect(alive(at.host)).toBe(true);
    expect(out).not.toContain('live gate dump (SIGUSR2): {');
    expect(out).toMatch(/gate dump: not asked: .*has no SIGUSR2 listener.*run this check again in a minute; one whose agent-framework predates the dump never does/);
    expect(out).toMatch(new RegExp(`=== findings ===[\\s\\S]*the gate dump wasn't asked for, since the host \\(pid ${at.host.process.pid}\\) has no SIGUSR2 listener, so the gate dump isn't known`));
    const line = ladder(at, ['--findings-json']).out.split('\n').find((l) => l.startsWith('connectome-doctor findings: '))!;
    expect(JSON.parse(line.slice('connectome-doctor findings: '.length))).toContainEqual({
      text: expect.stringMatching(/^the gate dump wasn't asked for, since the host \(pid \d+\) has no SIGUSR2 listener/), counts: false });
  });

  test('a host that listens, in a unit that isn\'t active, isn\'t signalled', async () => {
    const at = await install({ listens: true });
    systemctl(at, { active: 'deactivating' });
    const { out } = ladder(at);
    await settled(at.host);
    expect(signalled(at.host)).toBe(false);
    expect(out).not.toContain('live gate dump (SIGUSR2)');
    expect(out).toMatch(/=== findings ===[\s\S]*service is deactivating/);
  });

  test('the main process is read again before the signal, and a new one without a listener isn\'t signalled, and is a finding', async () => {
    const at = await install({ listens: true });
    const laterDir = mkdtempSync(join(tmpdir(), 'chost-ladder-later-'));
    dirs.push(laterDir);
    const later = await standInHost(laterDir, false);
    systemctl(at, { mainPidNow: String(later.process.pid) });
    const { out } = ladder(at);
    await settled(later);
    await settled(at.host);
    expect(alive(later)).toBe(true);
    expect(signalled(at.host)).toBe(false);
    expect(out).toContain(`the host (pid ${later.process.pid}) has no SIGUSR2 listener`);
    expect(out).toMatch(new RegExp(`=== findings ===[\\s\\S]*the gate dump wasn't asked for, since the host \\(pid ${later.process.pid}\\) has no SIGUSR2 listener`));
  });

  test('a main process whose status can\'t be read, or no main process, isn\'t signalled, and says why; only the first is a finding', async () => {
    const at = await install({ listens: true });
    systemctl(at, { mainPidNow: '999999999' });
    const unread = ladder(at).out;
    expect(unread).toMatch(/gate dump: not asked: \/proc\/999999999\/status can't be read/);
    expect(unread).toMatch(/=== findings ===[\s\S]*the gate dump wasn't asked for, since \/proc\/999999999\/status can't be read, so the gate dump isn't known/);
    systemctl(at, { mainPidNow: '0' });
    const none = ladder(at).out;
    expect(none).toMatch(/gate dump: not asked: the unit has no main process now/);
    expect(none).not.toContain('the gate dump wasn\'t asked for');
    expect(signalled(at.host)).toBe(false);
  });

  test('a SIGUSR2 that can\'t be sent is said, with why, and is a finding, and nothing waits for a dump', async () => {
    const at = await install({ listens: true });
    const pid = at.host.process.pid;
    systemctl(at, { mainPidNow: `${pid}/task/${pid}` });
    const { out } = ladder(at);
    await settled(at.host);
    expect(out).toMatch(/^live gate dump: SIGUSR2 couldn't be sent \(.+\)$/m);
    expect(out).toMatch(/=== findings ===[\s\S]*SIGUSR2 couldn't be sent \(.+\), so the gate dump isn't known/);
    expect(out).not.toContain('[diagnostics] line');
    expect(lines(join(at.work, 'dump-reads'))).toBe(0);
    expect(signalled(at.host)).toBe(false);
    expect(alive(at.host)).toBe(true);
  });

  test('the unit reaches journalctl and the read of its main process as its name, a systemd escape included', async () => {
    const at = await install({ listens: true });
    const asked = join(at.work, 'asked');
    const unit = 'connectome\\x2dtest.service';
    bin(at.bins, 'journalctl', `printf 'journalctl %s\\n' "$*" >> ${asked}\ncase "$*" in *"-o cat"*) echo '[diagnostics] {}' ;; esac`);
    const answers = readFileSync(join(at.bins, 'systemctl'), 'utf-8').replace('#!/bin/sh\n', '');
    bin(at.bins, 'systemctl', `printf 'systemctl %s\\n' "$*" >> ${asked}\n${answers}`);
    const { out } = ladder(at, [], {}, unit);
    await settled(at.host);
    expect(out).toContain('live gate dump (SIGUSR2): {}');
    const ours = readFileSync(asked, 'utf-8').split('\n').filter((l) => l.startsWith('journalctl') || l.includes('MainPID --value'));
    expect(ours.map((l) => l.split(' ')[0])).toEqual(['journalctl', 'journalctl', 'systemctl', 'journalctl']);
    for (const l of ours) expect(l).toContain(` ${unit} `);
  });

  test('a gate dump whose journal read fails says so, not that the host didn\'t answer, and is a finding', async () => {
    const at = await install({ listens: true, dumpReadFails: true });
    const { out, status } = ladder(at);
    await settled(at.host);
    expect(out).toMatch(/live gate dump: SIGUSR2 sent, but connectome-test\.service's journal can't be read \(Failed to open the journal: Permission denied\)/);
    expect(out).not.toContain('no [diagnostics] line was seen');
    expect(out).toMatch(/=== findings ===[\s\S]*the gate dump isn't known/);
    expect(status).toBe(1);
  });

  test('a gate dump whose journal reads don\'t finish within the wait says so, not that the host didn\'t answer', async () => {
    const at = await install({ listens: true, dumpReadHangs: true });
    const { out } = ladder(at);
    await settled(at.host);
    expect(out).toMatch(/live gate dump: SIGUSR2 sent, but no read of connectome-test\.service's journal finished within 5 s, so whether a \[diagnostics\] line came isn't known/);
    expect(out).not.toContain('no [diagnostics] line was seen');
    expect(out).toMatch(/=== findings ===[\s\S]*no read of connectome-test\.service's journal finished within 5 s, so the gate dump isn't known/);
  }, 20_000);

  test('a host that answers its SIGUSR2 a second late still has its dump read', async () => {
    const at = await install({ listens: true, dumpDelay: 1 });
    const { out } = ladder(at);
    await settled(at.host);
    expect(out).toContain('live gate dump (SIGUSR2): {"activeStreams":[]');
  });
});

describe('the start command', () => {
  test('a service that isn\'t active is told to start it with systemctl', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    systemctl(at, { active: 'inactive' });
    expect(ladder(at).out).toContain('* service is inactive — start it: systemctl --user start connectome-test.service');
  });
});

describe('the ladder\'s recent start', () => {
  const recent = /service started only .* recent restart\/crash\?/;

  test('a start in the last five minutes is called recent, and an older one isn\'t', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    expect(ladder(at).out).toMatch(recent);
    at.started = at.now - 600;
    systemctl(at);
    expect(ladder(at).out).not.toMatch(recent);
  });

  test('a unit with no start time still gets the whole ladder', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    systemctl(at, { neverStarted: true });
    const { out } = ladder(at);
    expect(out).not.toMatch(recent);
    expect(out).toMatch(/^=== (findings|no obvious problems)/m);
    expect(out).toMatch(/· routeSpeech delivery +can't be seen here: the unit has no start time, so no run's journal is read$/m);
  });

  test('a unit with no start time leaves its journal\'s failures not known, since no search ran, not none found', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    systemctl(at, { neverStarted: true });
    const { out } = ladder(at);
    expect(out).toContain('recent failures in connectome-test.service\'s journal: not known: it wasn\'t searched (the unit\'s ' +
      'start time isn\'t known)');
    expect(out).toContain('connectome-test.service\'s journal wasn\'t searched (the unit\'s start time isn\'t known), so its ' +
      'failures and deliveries aren\'t shown');
    expect(out).not.toContain('none found');
    expect(out).not.toContain('its search by pattern failed');
  });
});

describe('the ladder\'s inference stage', () => {
  const row = (s: number, kind: string, stop = 'end_turn') =>
    JSON.stringify({ timestamp: new Date(s * 1000).toISOString(), kind, rawResponse: { stop_reason: stop } });
  const STARTED = 'llm-calls.2026-11-12T11-02-38-066Z.jsonl';

  test('with only calls that aren\'t a turn\'s since the host last started, it says so, counting them', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    writeFileSync(join(at.work, 'data', STARTED),
      [row(at.now - 9, 'complete'), row(at.now - 8, 'complete', 'max_tokens'), row(at.now - 7, 'keepalive')].join('\n') + '\n');
    const { out } = ladder(at);
    expect(out).toMatch(/x inference \(llm call\) +--:--:-- +\( *never\) +no turn's model call since the host last started at 11-12 11:02:38: 2 other model call\(s\), 1 keepalive poke\(s\)$/m);
    expect(out).not.toContain('stop=');
  });

  test('a turn\'s call is the stage, though calls that aren\'t a turn\'s came after it', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    writeFileSync(join(at.work, 'data', STARTED),
      [row(at.now - 30, 'stream'), row(at.now - 5, 'complete', 'max_tokens')].join('\n') + '\n');
    const { out } = ladder(at);
    expect(out).toMatch(new RegExp(`o inference \\(llm call\\) +${stamp(at.now - 30)} .* stop=end_turn$`, 'm'));
    expect(out).not.toContain('stop=max_tokens');
  });

  test('with a call log over 30 MB whose last 30 MB hold no turn\'s call, it says so of the last 30 MB, not of the start', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    writeFileSync(join(at.work, 'data', STARTED), `${row(at.now - 60, 'stream')}\n${'x'.repeat(30_000_100)}\n${row(at.now - 5, 'complete')}\n`);
    const { out } = ladder(at);
    expect(out).toContain("no turn's model call in the last 30 MB of the call log since the host last started at 11-12 11:02:38: " +
      '1 other model call(s)');
  });

  test('with a row that can\'t be read and no turn\'s call, it says no readable turn\'s call, not that there was none', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    writeFileSync(join(at.work, 'data', STARTED), `${row(at.now - 9, 'complete')}\n{"timestamp": not json\n${row(at.now - 5, 'complete')}\n`);
    const { out } = ladder(at);
    expect(out).toContain("no readable turn's model call since the host last started at 11-12 11:02:38: 2 other model call(s)");
    expect(out).not.toContain("no turn's model call");
  });

  test('with an incomplete last row and no turn\'s call, it says no readable turn\'s call, since that row may be a turn\'s', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    writeFileSync(join(at.work, 'data', STARTED), `${row(at.now - 9, 'complete')}\n{"timestamp":"${new Date((at.now - 4) * 1000).toISOString()}","kind":"str`);
    const { out } = ladder(at);
    expect(out).toContain("no readable turn's model call since the host last started at 11-12 11:02:38: 1 other model call(s)");
    expect(out).not.toContain("no turn's model call");
  });
});

describe('the ladder\'s data directory', () => {
  test('--data-dir reads the data directory it names, not INSTALL_DIR/data', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    const data = mkdtempSync(join(tmpdir(), 'chost-ladder-data-'));
    dirs.push(data);
    rmSync(join(at.work, 'data'), { recursive: true });
    const row = { timestamp: new Date().toISOString(), kind: 'stream', rawResponse: { stop_reason: 'end_turn' } };
    writeFileSync(join(data, 'llm-calls.2026-10-27T00-00-00.jsonl'), `${JSON.stringify(row)}\n`);
    const { out } = ladder(at, ['--data-dir', data]);
    expect(out).toContain('stop=end_turn');
  });

  test('a model call that answered with no stop reason in its record says it answered, not stop=None, and one that failed says only its error', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    const answered = { timestamp: new Date().toISOString(), kind: 'stream', rawResponse: { status: 'completed' } };
    writeFileSync(join(at.work, 'data', 'llm-calls.2026-10-27T00-00-00.jsonl'), `${JSON.stringify(answered)}\n`);
    const ok = ladder(at).out;
    expect(ok).toMatch(/o inference \(llm call\) .* answered$/m);
    expect(ok).not.toContain('stop=None');
    const failed = { timestamp: new Date().toISOString(), kind: 'stream', type: 'error', error: 'overloaded' };
    writeFileSync(join(at.work, 'data', 'llm-calls.2026-10-27T00-00-00.jsonl'), `${JSON.stringify(failed)}\n`);
    const bad = ladder(at).out;
    expect(bad).toMatch(/inference \(llm call\) .* err=overloaded/);
    expect(bad).not.toContain('stop=None');
  });

  test('with no data directory, the ingest and inference stages can\'t be seen, naming it', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    rmSync(join(at.work, 'data'), { recursive: true });
    const { out } = ladder(at);
    const data = join(at.work, 'data');
    expect(out).toContain(`· chronicle ingest (+gate)   can't be seen here: there's no data directory at ${data}`);
    expect(out).toContain(`· inference (llm call)       can't be seen here: there's no data directory at ${data}`);
    expect(out).not.toMatch(/(chronicle ingest|inference \(llm call\)) .*never/);
    expect(out).toContain('run this script with --data-dir DIR');
    const json = ladder(at, ['--findings-json']).out;
    expect(json).toContain(`there's no data directory at ${data}`);
    expect(json).not.toContain('--data-dir');
  });

  test('a data directory that isn\'t there is a finding, not a crash', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    rmSync(join(at.work, 'data'), { recursive: true });
    const { out, status } = ladder(at);
    expect(out).not.toContain('Traceback');
    expect(out).toMatch(/=== findings ===[\s\S]*there's no data directory at .*--data-dir/);
    expect(status).toBe(1);
  });

  test.skipIf(process.getuid?.() === 0)('a data directory that can\'t be looked at, or that\'s a file, is said to be so, not to be missing', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    const locked = join(at.work, 'locked');
    const data = join(locked, 'data');
    mkdirSync(data, { recursive: true });
    chmodSync(locked, 0o000);
    try {
      const { out } = ladder(at, ['--data-dir', data]);
      expect(out).toContain(`· inference (llm call)       can't be seen here: the data directory at ${data} can't be looked at (Permission denied)`);
      expect(out).toContain(`· discord event seen         can't be seen here: the data directory at ${data} can't be looked at (Permission denied)`);
      expect(out).not.toContain('debug log isn\'t at');
      expect(out).toContain(`the data directory at ${data} can't be looked at (Permission denied), so the discord, mcpl, chronicle and inference stages read nothing`);
      expect(out).not.toContain('there\'s no data directory');
    } finally {
      chmodSync(locked, 0o755);
    }
    const file = join(at.work, 'data-file');
    writeFileSync(file, '');
    const { out } = ladder(at, ['--data-dir', file]);
    expect(out).toContain(`· chronicle ingest (+gate)   can't be seen here: ${file}, the data directory, isn't a directory`);
    expect(out).not.toContain('there\'s no data directory');
  });

  test('the ingest stage reads the active session\'s records, as sessions.json names it, not another session\'s', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    const record = (room: string, at_s: number) => {
      const payload = [...Buffer.from(JSON.stringify({ triggered: true, channelName: room, participant: 'ann' }))].join(',');
      return `{"record_id":1,"global_sequence":1,"state_id":"messages","data":[${payload}],"timestamp":${at_s * 1_000_000}}\n`;
    };
    const sessions = join(at.work, 'data', 'sessions');
    for (const id of ['s-a', 's-b', 's-c', 's-d', 's-e', 's-f', 's-g', 's-h', 's-active']) {
      mkdirSync(join(sessions, id), { recursive: true });
      const file = join(sessions, id, 'records.log');
      writeFileSync(file, record(id === 's-active' ? 'active-room' : 'other-room', at.now - 40));
      const when = id === 's-active' ? at.now - 3_600 : at.now - 30;
      utimesSync(file, when, when);
    }
    writeFileSync(join(at.work, 'data', 'sessions.json'), JSON.stringify({ activeSessionId: 's-active', sessions: {} }));
    const { out } = ladder(at);
    expect(out).toMatch(/chronicle ingest \(\+gate\) .*#active-room/);
    expect(out).not.toContain('#other-room');
  });

  test('an index naming no session leaves the active one not known, a session with no store is never, and one whose store has no records.log, or session data that can\'t be read, is not known; none takes another session\'s records', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    const payload = [...Buffer.from(JSON.stringify({ triggered: true, channelName: 'other-room', participant: 'ann' }))].join(',');
    mkdirSync(join(at.work, 'data', 'sessions', 's-other'), { recursive: true });
    writeFileSync(join(at.work, 'data', 'sessions', 's-other', 'records.log'),
      `{"record_id":1,"global_sequence":1,"state_id":"messages","data":[${payload}],"timestamp":${(at.now - 40) * 1_000_000}}\n`);
    const index = join(at.work, 'data', 'sessions.json');
    writeFileSync(index, JSON.stringify({ activeSessionId: 's-gone', sessions: {} }));
    const named = ladder(at).out;
    expect(named).toMatch(/chronicle ingest \(\+gate\) .*\(\s*never\).*the active session, s-gone, has no records\.log/);
    expect(named).not.toContain('#other-room');
    for (const activeSessionId of [null, '', 42]) {
      writeFileSync(index, JSON.stringify({ activeSessionId, sessions: {} }));
      const none = ladder(at).out;
      expect(none).toMatch(/· chronicle ingest \(\+gate\) +can't be seen here: .*sessions\.json names no active session, which no start of the host leaves, so which session is active isn't known/);
      expect(none).not.toContain('#other-room');
    }
    mkdirSync(join(at.work, 'data', 'sessions', 's-bare'));
    writeFileSync(index, JSON.stringify({ activeSessionId: 's-bare', sessions: {} }));
    const bare = ladder(at).out;
    expect(bare).toMatch(/· chronicle ingest \(\+gate\) +can't be seen here: .*the active session's store, \S*sessions\/s-bare, is there without a records\.log, which the host writes when it opens the store, so what was ingested isn't known/);
    expect(bare).not.toContain('#other-room');
    writeFileSync(index, '{ not json');
    const unread = ladder(at).out;
    expect(unread).toMatch(/· chronicle ingest \(\+gate\) +can't be seen here: .*sessions\.json can't be read as the host's session index \(Expecting property name/);
    expect(unread).not.toContain('#other-room');
    writeFileSync(index, '[]');
    const listed = ladder(at).out;
    expect(listed).toMatch(/· chronicle ingest \(\+gate\) +can't be seen here: .*sessions\.json can't be read as the host's session index \(it isn't a JSON object\)/);
    expect(listed).not.toContain('#other-room');
    mkdirSync(join(at.work, 'data', 'sessions', 's-dir', 'records.log'), { recursive: true });
    writeFileSync(index, JSON.stringify({ activeSessionId: 's-dir', sessions: {} }));
    const records = ladder(at).out;
    expect(records).toMatch(/· chronicle ingest \(\+gate\) +can't be seen here: .*s-dir\/records\.log can't be read \(Is a directory\)/);
    expect(records).not.toContain('#other-room');
    mkdirSync(join(at.work, 'data', 'sessions', 's-loop'));
    symlinkSync('records.log', join(at.work, 'data', 'sessions', 's-loop', 'records.log'));
    writeFileSync(index, JSON.stringify({ activeSessionId: 's-loop', sessions: {} }));
    const loop = ladder(at).out;
    expect(loop).toMatch(/· chronicle ingest \(\+gate\) +can't be seen here: .*s-loop\/records\.log can't be read \(Too many levels of symbolic links\)/);
    expect(loop).not.toContain('#other-room');
  });

  test('with no index, a sessions directory that can\'t be listed is said, not taken as one with no records', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    const fresh = ladder(at).out;
    expect(fresh).toMatch(/chronicle ingest \(\+gate\) .*\(\s*never\)/);
    expect(fresh).not.toMatch(/chronicle ingest \(\+gate\) +can't be seen here/);
    mkdirSync(join(at.work, 'data', 'sessions'));
    const empty = ladder(at).out;
    expect(empty).toMatch(/chronicle ingest \(\+gate\) .*\(\s*never\)/);
    expect(empty).not.toMatch(/chronicle ingest \(\+gate\) +can't be seen here/);
    rmSync(join(at.work, 'data', 'sessions'), { recursive: true });
    writeFileSync(join(at.work, 'data', 'sessions'), 'not a directory');
    const { out } = ladder(at);
    expect(out).toMatch(/· chronicle ingest \(\+gate\) +can't be seen here: .*sessions can't be listed \(Not a directory\)/);
  });

  test('a records.log with content and no message record the ladder reads leaves the ingest stage not known, naming what it read; only an empty one is never', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    const session = join(at.work, 'data', 'sessions', 's-active');
    mkdirSync(session, { recursive: true });
    writeFileSync(join(at.work, 'data', 'sessions.json'), JSON.stringify({ activeSessionId: 's-active', sessions: {} }));
    const log = join(session, 'records.log');
    const unknown = /· chronicle ingest \(\+gate\) +can't be seen here: the last 8 MB of \S+records\.log hold no message record in the JSON-lines form this ladder reads$/m;
    const record = (n: number, state: string, s = at.now - 900) => JSON.stringify({ record_id: n, global_sequence: n,
      state_id: state, data: [], timestamp: s * 1_000_000 });
    const filler = Array.from({ length: 90_000 }, (_, n) => record(n + 2, 'other-state')).join('\n');
    for (const content of [
      Buffer.concat([Buffer.from('REC\0\x01\0\x02'), Buffer.from([0xa8]), Buffer.from('state_id'), Buffer.from([0xa8]),
        Buffer.from('messages'), Buffer.from('{"participant":"user"}')]),
      Buffer.concat([Buffer.from('REC\0'), Buffer.from('{"record_id":1}'), Buffer.from([0xa8, 0x01])]),
      Buffer.alloc(8_100_000, 0xa8),
      Buffer.concat([Buffer.from([0xa8, 0x01, 0x0a]), Buffer.from('{"record_id":1,'), Buffer.from([0xa8, 0x0a])]),
      `${record(1, 'messages')}\n${filler}\n`,
      `${record(1, 'other')}\n`,
    ]) {
      writeFileSync(log, content);
      const { out } = ladder(at);
      expect(out).toMatch(unknown);
      expect(out).not.toMatch(/chronicle ingest \(\+gate\) .*never/);
    }
    writeFileSync(log, `${filler}\n${record(1, 'messages', at.now - 60)}\n`);
    expect(ladder(at).out).toMatch(/o chronicle ingest \(\+gate\) .*\( *\d+s ago\)/);
    writeFileSync(log, '');
    expect(ladder(at).out).toMatch(/x chronicle ingest \(\+gate\) .*never/);
  });

  test('with no session index, sessions on disk leave the active one not known, and no session\'s records are read', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    const payload = [...Buffer.from(JSON.stringify({ triggered: true, channelName: 'some-room', participant: 'ann' }))].join(',');
    mkdirSync(join(at.work, 'data', 'sessions', 's-a'), { recursive: true });
    writeFileSync(join(at.work, 'data', 'sessions', 's-a', 'records.log'),
      `{"record_id":1,"global_sequence":1,"state_id":"messages","data":[${payload}],"timestamp":${(at.now - 40) * 1_000_000}}\n`);
    const { out } = ladder(at);
    expect(out).toMatch(/· chronicle ingest \(\+gate\) +can't be seen here: .*no sessions\.json names the active session/);
    expect(out).not.toContain('#some-room');
  });

  test('the last Discord drop discord-mcpl logged in the last hour is shown with its reason, on the forward stage', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    const iso = (s: number) => new Date(s * 1000).toISOString();
    const log = join(at.work, 'data', 'discord-mcpl-debug.log');
    writeFileSync(log, [
      `${iso(at.now - 50)} handleDiscordMessage:enter {"channelName":"general","contentPreview":"hello"}`,
      `${iso(at.now - 48)} handleDiscordMessage:drop {"reason":"bot message"}`,
      `${iso(at.now - 45)} handleDiscordMessage:drop {"reason":"channel not in scope"}`,
      '',
    ].join('\n'));
    const { out } = ladder(at);
    expect(out).toMatch(/mcpl forward to host .*last drop .*: channel not in scope/);
    expect(out).not.toContain('bot message');
    writeFileSync(log, [
      `${iso(at.now - 50)} handleDiscordMessage:enter {"channelName":"general","contentPreview":"hello"}`,
      `${iso(at.now - 3_700)} handleDiscordMessage:drop {"reason":"channel not in scope"}`,
      '',
    ].join('\n'));
    expect(ladder(at).out).not.toContain('last drop');
  });

  test('with no discord-mcpl debug log where it reads one, both Discord stages are not known, with why, and not never', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    const { out } = ladder(at);
    const log = join(at.work, 'data', 'discord-mcpl-debug.log');
    expect(out).toMatch(/· discord event seen +can't be seen here: discord-mcpl's debug log isn't at (\S+), and it writes one only when DISCORD_MCPL_DEBUG_LOG names it$/m);
    expect(out.match(/debug log isn't at (\S+),/)?.[1]).toBe(log);
    expect(out).toMatch(/· mcpl forward to host +can't be seen here: it's read from the same debug log$/m);
    expect(out).not.toMatch(/(discord event seen|mcpl forward to host) .*never/);
    expect(out).not.toContain('In a channel the resident');
  });

  test('a debug log that can\'t be read leaves both Discord stages not known, with why, not never', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    mkdirSync(join(at.work, 'data', 'discord-mcpl-debug.log'));
    const { out } = ladder(at);
    expect(out).toMatch(/· discord event seen +can't be seen here: discord-mcpl's debug log at \S+ can't be read \(.+\)$/m);
    expect(out).toMatch(/· mcpl forward to host +can't be seen here: it's read from the same debug log$/m);
  });

  test('with nothing found, the summary names the stages the ladder couldn\'t see, not that the pipeline looks alive', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    writeFileSync(join(at.work, 'journal.txt'),
      `${at.now - 10}.000000 host bun[1]: [routeSpeech] discord:1/2: routed 12 chars -> discord:1/2 (server=discord, delivered=true)\n`);
    at.started = at.now - 600;
    systemctl(at);
    const { out } = ladder(at);
    expect(out).toMatch(/^=== no obvious problems in what it could see; not known: (.+, )?discord event seen, mcpl forward to host(, .+)? ===$/m);
    expect(out).not.toContain('pipeline looks alive');
  });

  test('a last drop for a channel that isn\'t open shows discord-mcpl\'s own reason on the forward stage', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    const iso = (s: number) => new Date(s * 1000).toISOString();
    writeFileSync(join(at.work, 'data', 'discord-mcpl-debug.log'), [
      `${iso(at.now - 50)} handleDiscordMessage:enter {"channelName":"bloop","contentPreview":"hi"}`,
      `${iso(at.now - 49)} handleDiscordMessage:drop {"reason":"ambient-not-subscribed","channelId":"2","channelName":"bloop","tracked":false}`,
      '',
    ].join('\n'));
    const { out } = ladder(at);
    expect(out).toMatch(/o discord event seen .*#bloop: hi/);
    expect(out).toMatch(/mcpl forward to host .*last drop .*: ambient-not-subscribed$/m);
    expect(out).not.toContain('isn\'t open to it');
  });

  test('the forward stage shows the last message passed on to the host', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    const iso = (s: number) => new Date(s * 1000).toISOString();
    writeFileSync(join(at.work, 'data', 'discord-mcpl-debug.log'), [
      `${iso(at.now - 50)} handleDiscordMessage:enter {"channelName":"bloop","contentPreview":"hi"}`,
      `${iso(at.now - 49)} handleDiscordMessage:forwarding {"via":"push/event"}`,
      '',
    ].join('\n'));
    const { out } = ladder(at);
    expect(out).toMatch(new RegExp(`o mcpl forward to host +${stamp(at.now - 49)} .*push/event`));
  });

  test('the last message discord-mcpl\'s filters refused within the hour is shown on the first stage, with its reason, leaving out the bot\'s own', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    const iso = (s: number) => new Date(s * 1000).toISOString();
    const log = join(at.work, 'data', 'discord-mcpl-debug.log');
    const drop = (s: number, reason: string) =>
      `${iso(s)} gateway:message-create-drop {"msgId":"9","guildId":"1","channelId":"7","authorId":"5","reason":"${reason}"}`;
    for (const reason of ['channel-not-allowed', 'guild-not-allowed', 'dm-user-not-allowed']) {
      writeFileSync(log, `${drop(at.now - 40, reason)}\n${drop(at.now - 30, 'self-authored')}\n`);
      expect(ladder(at).out).toMatch(new RegExp(`x discord event seen .*never.*last filter drop .*: ${reason}$`, 'm'));
    }
    writeFileSync(log, `${drop(at.now - 3_700, 'channel-not-allowed')}\n`);
    expect(ladder(at).out).not.toContain('last filter drop');
  });
});

describe('what the ladder withholds', () => {
  test('a value it\'s given to withhold is replaced where it reads it, before any line is cut short', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    const secret = 'Zq9-SECRET-77';
    const long = `[inference-failed] ${'x'.repeat(125)}${secret} and the rest`;
    writeFileSync(join(at.work, 'journal.txt'), `${at.now}.000000 host bun[1]: ${long}\n`);
    writeFileSync(join(at.work, 'logs', 'failures.log'), `${JSON.stringify({ reason: `Error: ${'y'.repeat(120)}${secret}` })}\n`);
    writeFileSync(join(at.work, 'data', 'discord-mcpl-debug.log'),
      `${new Date(at.now * 1000).toISOString()} handleDiscordMessage:enter {"channelName":"general","contentPreview":"${'p'.repeat(35)}${secret} more"}\n`);
    const { out } = ladder(at, [], { CONNECTOME_DOCTOR_WITHHOLD: JSON.stringify([['DISCORD_TOKEN', secret]]) });
    expect(out).toContain('<DISC');
    expect(out).toMatch(/discord event seen .*#general: p{35}<DISC…/);
    expect(out).not.toContain('Zq9');
  });

  test('a value is withheld in the forms doctor\'s redactor matches: in another ASCII case, and trimmed', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    const long = `[inference-failed] ${'x'.repeat(125)}zQ9-CASE-SECRET-55 and the rest`;
    writeFileSync(join(at.work, 'journal.txt'), `${at.now}.000000 host bun[1]: ${long}\n`);
    const { out } = ladder(at, [], { CONNECTOME_DOCTOR_WITHHOLD: JSON.stringify([['DISCORD_TOKEN', '  Zq9-case-secret-55 ']]) });
    expect(out).toContain('<DISC');
    expect(out.toLowerCase()).not.toContain('zq9');
  });

  test('two values that overlap where they\'re read leave no part of either', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    writeFileSync(join(at.work, 'journal.txt'), `${at.now}.000000 host bun[1]: [inference-failed] key aaQ1-bbQ2-ccQ3 refused\n`);
    const withhold = JSON.stringify([['FIRST', 'aaQ1-bbQ2'], ['SECOND', 'bbQ2-ccQ3']]);
    const { out } = ladder(at, [], { CONNECTOME_DOCTOR_WITHHOLD: withhold });
    expect(out).toContain('key <FIRST> refused');
    for (const part of ['aaQ1', 'bbQ2', 'ccQ3']) expect(out).not.toContain(part);
  });

  test('a value at the start of a file\'s tail, cut through, leaves no part of it', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    const secret = 'Zq9-STRADDLE-SECRET-41';
    const first = `${'x'.repeat(100)}${secret} tail\n`;
    const cut = Buffer.byteLength(first) - (100 + 10);
    writeFileSync(join(at.work, 'logs', 'failures.log'), `${first}${'y'.repeat(400_000 - cut - 1)}\n`);
    const { out } = ladder(at, [], { CONNECTOME_DOCTOR_WITHHOLD: JSON.stringify([['DISCORD_TOKEN', secret]]) });
    expect(out).toContain('yyyy');
    expect(out).not.toContain(secret.slice(10));
  });

  test('a value it withholds is still read as what it is: a call row with that value in it counts, and a channel\'s auto-close stays one', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    writeFileSync(join(at.work, 'data', 'llm-calls.2026-10-30T00-00-00.jsonl'), `${JSON.stringify({
      timestamp: new Date((at.now - 5) * 1000).toISOString(), kind: 'stream', cached: true, rawResponse: { stop_reason: 'end_turn' } })}\n`);
    writeFileSync(join(at.work, 'logs', 'failures.log'), `${JSON.stringify({
      kind: 'subscription-gc-close', channelId: '101', at: new Date().toISOString(), limitChars: 4000, restore: 'channel_open' })}\n`);
    const withhold = JSON.stringify([['FIRST', 'true'], ['SECOND', 'gc-close']]);
    const { out } = ladder(at, [], { CONNECTOME_DOCTOR_WITHHOLD: withhold });
    expect(out).toMatch(/o inference \(llm call\) .*stop=end_turn/);
    expect(out).not.toContain('unreadable');
    expect(out).toMatch(/recent failures in .*failures\.log: none found/);
  });

  test('a value it withholds that\'s a word of the lines it reads leaves them read as they were: a message\'s channel and preview, and a drop\'s reason', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    const iso = (s: number) => new Date(s * 1000).toISOString();
    writeFileSync(join(at.work, 'data', 'discord-mcpl-debug.log'), [
      `${iso(at.now - 50)} handleDiscordMessage:enter {"channelName":"general","contentPreview":"hello"}`,
      `${iso(at.now - 45)} handleDiscordMessage:drop {"reason":"channel not in scope"}`,
      '',
    ].join('\n'));
    const { out } = ladder(at, [], { CONNECTOME_DOCTOR_WITHHOLD: JSON.stringify([['FIRST', 'contentPreview'], ['SECOND', 'reason']]) });
    expect(out).toMatch(/discord event seen .*#general: hello…/);
    expect(out).toMatch(/mcpl forward to host .*last drop .*: channel not in scope/);
  });

  test('a CONNECTOME_DOCTOR_WITHHOLD it can\'t read stops the ladder before it reads anything', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    const { out, status } = ladder(at, [], { CONNECTOME_DOCTOR_WITHHOLD: '{"DISCORD_TOKEN":"x"}' });
    expect(status).toBe(2);
    expect(out).toContain("CONNECTOME_DOCTOR_WITHHOLD can't be read");
    expect(out).not.toContain('400 prompt is too long');
  });
});

describe('the ladder run by doctor, with --findings-json', () => {
  const findings = (out: string): { text: string; counts: boolean }[] => {
    const lines = out.split('\n').filter((line) => line.startsWith('connectome-doctor findings: '));
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0].slice('connectome-doctor findings: '.length));
  };

  test('its findings are its last line, each with whether it counts, with no block or closing line, and it exits 0', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    writeFileSync(join(at.work, 'journal.txt'), [
      `${at.now - 3}.000000 host bun[1]: [routeSpeech] discord:1/2: the channel refused it — speech NOT routed (12 chars stay in chronicle)`,
      '',
    ].join('\n'));
    rmSync(join(at.work, 'data'), { recursive: true });
    const { out, status } = ladder(at, ['--findings-json']);
    expect(out.trimEnd().split('\n').at(-1)).toMatch(/^connectome-doctor findings: /);
    expect(findings(out)).toEqual([
      { text: expect.stringMatching(/^there's no data directory at /), counts: false },
      { text: expect.stringMatching(/^the last reply wasn't delivered: discord:1\/2: the channel refused it/), counts: true },
    ]);
    expect(out).not.toContain('=== ');
    expect(status).toBe(0);
  });

  test('nothing found is an empty list, and still no closing line', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    writeFileSync(join(at.work, 'journal.txt'),
      `${at.now - 10}.000000 host bun[1]: [routeSpeech] discord:1/2: routed 12 chars -> discord:1/2 (server=discord, delivered=true)\n`);
    const { out, status } = ladder(at, ['--findings-json']);
    expect(findings(out)).toEqual([]);
    expect(out).not.toContain('=== ');
    expect(status).toBe(0);
  });

  test('the service\'s state is left to doctor: one that isn\'t active, or started a minute ago, makes no finding and no row', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    systemctl(at, { active: 'inactive' });
    const { out } = ladder(at, ['--findings-json']);
    expect(out).not.toMatch(/^service +:/m);
    expect(findings(out).map((f) => f.text).join('\n')).not.toMatch(/service is inactive|service started only/);
  });

  test('what the ladder can\'t see is a line that doesn\'t count', async () => {
    const at = await install({ listens: true, journalFails: 'Failed to open the journal: Permission denied', mainPidNow: '0' });
    const { out } = ladder(at, ['--findings-json']);
    expect(findings(out)).toContainEqual({ text: expect.stringMatching(/journal can't be read/), counts: false });
    expect(findings(out).filter((f) => f.counts)).toEqual([]);
  });

  const findingsOf = (out: string): { text: string; counts: boolean }[] =>
    JSON.parse(out.split('\n').find((l) => l.startsWith('connectome-doctor findings: '))!.slice('connectome-doctor findings: '.length));

  test('an unconfirmed delivery is a line that doesn\'t count', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    writeFileSync(join(at.work, 'journal.txt'),
      `${at.now - 3}.000000 host bun[1]: [routeSpeech] discord:1/2: the connector timed out — speech delivery NOT confirmed (12 chars stay in chronicle)\n`);
    expect(findingsOf(ladder(at, ['--findings-json']).out)).toContainEqual(
      { text: expect.stringMatching(/^the last reply's delivery wasn't confirmed/), counts: false });
  });

  test('the resident\'s own sleep is a line that doesn\'t count, and a turn in flight withdraws the no-turn finding', async () => {
    const at = await install({ listens: true, dumpsTo: 'host.err' });
    const file = join(at.work, 'host.err');
    writeFileSync(file, '');
    systemctl(at, { text: `[Service]\nStandardError=append:${file}\n` });
    const session = join(at.work, 'data', 'sessions', 's-active');
    mkdirSync(session, { recursive: true });
    writeFileSync(join(at.work, 'data', 'sessions.json'), JSON.stringify({ activeSessionId: 's-active', sessions: {} }));
    const payload = [...Buffer.from(JSON.stringify({ triggered: true, channelName: 'room', participant: 'ann' }))].join(',');
    writeFileSync(join(session, 'records.log'),
      `{"record_id":1,"global_sequence":1,"state_id":"messages","data":[${payload}],"timestamp":${(at.now - 600) * 1_000_000}}\n`);
    const quiet = findingsOf(ladder(at, ['--findings-json']).out);
    await settled(at.host);
    expect(quiet).toContainEqual({ text: expect.stringMatching(/^a gate-TRIGGERED event was ingested but NO turn was recorded after it/), counts: true });
    writeFileSync(join(at.work, 'dump-line'),
      `[diagnostics] {"activeStreams":["resident"],"gate":{"inferring":false,"sleepUntil":${(at.now + 3_600) * 1000}}}\n`);
    const { out } = ladder(at, ['--findings-json']);
    await settled(at.host);
    const found = findingsOf(out);
    expect(out).toContain('turn in-flight for: resident');
    expect(found.map((f) => f.text).join('\n')).not.toContain('NO turn was recorded after it');
    expect(found).toContainEqual({ text: expect.stringMatching(/^agent is ASLEEP until /), counts: false });
  });
});

describe('the ladder, its round on the review of 3c6be0fd0', () => {
  const exhausted = (at: Install, s: number) => writeFileSync(join(at.work, 'logs', 'failures.log'), `${JSON.stringify({
    at: new Date(s * 1000).toISOString(), agent: 'resident', consecutive: 3, reason: '529 overloaded', kind: 'inference-exhausted' })}\n`);
  const row = (s: number, kind: string, rawResponse: unknown = { stop_reason: 'end_turn' }) =>
    JSON.stringify({ timestamp: new Date(s * 1000).toISOString(), kind, rawResponse });
  const findings = (at: Install): Array<{ text: string; counts: boolean }> => {
    const line = ladder(at, ['--findings-json']).out.split('\n').find((l) => l.startsWith('connectome-doctor findings: '));
    if (line === undefined) throw new Error('the ladder gave no findings line');
    return JSON.parse(line.slice('connectome-doctor findings: '.length));
  };
  const hardDown = { text: expect.stringMatching(/^inference failures, the last \d+m ago, with no successful turn found since/), counts: true };
  const startsAfter = { text: expect.stringMatching(new RegExp('^inference failures, the last \\d+m ago; whether a turn has succeeded ' +
    'since isn\'t known, since the call log read here starts at \\S+ \\S+, after it$')), counts: false };

  test('a failure from before the call log the ladder reads isn\'t called hard-down: whether a turn has succeeded since isn\'t known', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    writeFileSync(join(at.work, 'journal.txt'), '');
    exhausted(at, at.now - 300);
    const before = join(at.work, 'data', 'llm-calls.2026-10-30T00-00-00.jsonl');
    writeFileSync(before, `${row(at.now - 200, 'stream')}\n`);
    utimesSync(before, at.now - 200, at.now - 200);
    const newest = join(at.work, 'data', 'llm-calls.2026-10-31T00-00-00.jsonl');
    writeFileSync(newest, `${row(at.now - 50, 'complete')}\n`);
    expect(findings(at)).toContainEqual(startsAfter);
    expect(findings(at)).not.toContainEqual(hardDown);
    writeFileSync(newest, `${row(at.now - 400, 'complete')}\n${row(at.now - 50, 'complete')}\n`);
    expect(findings(at)).toContainEqual(hardDown);
  });

  test('a failure from before the last 30 MB of the call log isn\'t called hard-down either', async () => {
    const at = await install({ listens: true, mainPidNow: '0' });
    writeFileSync(join(at.work, 'journal.txt'), '');
    exhausted(at, at.now - 300);
    const poke = JSON.stringify({ timestamp: new Date((at.now - 100) * 1000).toISOString(), kind: 'keepalive', pad: 'x'.repeat(900) });
    writeFileSync(join(at.work, 'data', 'llm-calls.2026-10-30T00-00-00.jsonl'),
      `${row(at.now - 200, 'stream')}\n${`${poke}\n`.repeat(Math.ceil(31_000_000 / (poke.length + 1)))}`);
    expect(findings(at)).toContainEqual(startsAfter);
    expect(findings(at)).not.toContainEqual(hardDown);
  }, 60_000);
});
