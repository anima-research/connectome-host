#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ENTRY_POINT, readCurrent } from '../update/contract.js';
import { EXACT_VERSION } from '../update/install.js';
import { KEEP_DATA_FLAG, goBackFromShell, goBackOffer, machineOps, readInstallRecord, shellWord } from '../update/launcher.js';
import { CLI_WAYS, COMMAND_WAYS, statusLines, type UpdateStatus } from '../web/update-text.js';
import { STOPPED_READING_MS } from '../client-stall.js';
import { openHost, type HostClient, type HostEvent, type NoHost } from './host-socket.js';
import { INSTALL_COMMAND } from './install-command.js';

export interface CliContext {
  root: string | null;
  argv: string[];
  out(line: string): void;
  err(line: string): void;
}

export interface CliCommand {
  name: string;
  usage: string;
  summary: string;
  words?: string[];
  run(ctx: CliContext): Promise<number>;
}

export const ROOT_IN_WORKDIR = 'connectome-host';

const HEALTH_WAIT_MS = 10_000;

const UPDATE_USAGE = 'connectome update [check | install | restart [wait | now | resume | <version>] | ' +
  'back [(keep | restore) [<version>]]]';

export const COMMANDS: CliCommand[] = [
  {
    name: 'send',
    usage: 'connectome send <text>',
    summary: 'Waits until the running agent is between turns, sends it one line, and prints what it says until ' +
      'that turn\'s work ends. If a channel message, or the end of a script or subagent the agent started, arrives ' +
      'just before the line, the agent may answer it in the same turn, and that reply prints too. A subagent or ' +
      'script the turn starts can bring a later turn: if what brings it arrives within half a second of the turn\'s ' +
      'work ending, it joins that work and its reply prints too, and this doesn\'t wait for anything later.',
    run: (ctx) => send(ctx),
  },
  {
    name: 'update',
    usage: UPDATE_USAGE,
    summary: 'Asks the running host about its updates, or to make one. Words it doesn\'t take are a usage error, which ' +
      'exits 2 before any host is looked for. It exits 1 when the host answers no, such as an install with nothing ' +
      'newer offered or one that failed, a check that couldn\'t read the registry or a back that couldn\'t read the Go ' +
      'back offer: the host\'s words on stdout say why. When no host answers a word it takes, it asks nothing and ' +
      'exits 1, saying so on stderr. The exception is back when nothing listens on the host\'s socket: then back says ' +
      'whether a Go back is offered, and back keep or back restore asks the next start to go back.',
    words: [
      'check, or no word: reads the registry, and says whether a newer release is out and what it costs.',
      'install: installs the newest final release that isn\'t deprecated beside the running one, which runs on, ' +
        'when the host\'s Bun meets that release\'s floor.',
      'restart: switches to the newest release installed: quiesces the host, gives turns in progress 2 minutes to ' +
        'end and, once they have, stops it, so that its service starts that release on trial. With <version>, only ' +
        'if that is still the release it would switch to.',
      'restart wait: when turns didn\'t end in time, waits up to 10 minutes more.',
      'restart now: when turns didn\'t end in time, stops now and cuts them off.',
      'restart resume: calls the restart off.',
      'back: says whether a Go back is offered, to which release, and what its two ways do.',
      'back keep: goes back to that release, which runs on the data as it is now.',
      'back restore: goes back to that release, and restores the copy of its data; everything since the copy was ' +
        'taken is set aside, not deleted.',
    ],
    run: update,
  },
];

const io = {
  out: (line: string) => { process.stdout.write(`${line}\n`); },
  err: (line: string) => { process.stderr.write(`${line}\n`); },
};

// Installs' own `connectome` (install-command.ts) imports this module by its path in a release and calls
// main(root, argv): keep both, since every install's command reaches every later release through them.
export async function main(root: string | null, argv: string[]): Promise<number> {
  const [word, ...rest] = argv;
  if (root === null) return fromPackage(argv);
  if (isHelp(word)) {
    usage(io.out);
    return 0;
  }
  if (word === undefined) return bare({ root, argv: rest, ...io });
  const command = COMMANDS.find((each) => each.name === word);
  if (command === undefined) {
    io.err(`connectome: there's no command ${word}.`);
    usage(io.err);
    return 2;
  }
  return command.run({ root, argv: rest, ...io });
}

function isHelp(word: string | undefined): boolean {
  return word === 'help' || word === '--help' || word === '-h';
}

function usage(print: (line: string) => void): void {
  print('connectome: an install\'s own command. Each runs the release its install runs. Its own refusals go to ' +
    'stderr, and what the host answers to update to stdout, a refusal or a failure it answers included; an error ' +
    'that stops the host\'s update command goes to stderr. send prints only what the agent says on stdout, and its ' +
    'own notes on stderr.');
  print('  connectome');
  print('      Which install this is, its release, whether its host is running, and its update state.');
  for (const command of COMMANDS) {
    print(`  ${command.usage}`);
    print(`      ${command.summary}`);
    for (const word of command.words ?? []) print(`        ${word}`);
  }
  print('  connectome help');
}

async function fromPackage(argv: string[]): Promise<number> {
  const root = resolve(ROOT_IN_WORKDIR);
  const command = join(root, INSTALL_COMMAND);
  if (existsSync(command)) {
    const ran = spawnSync(process.execPath, [command, ...argv], { stdio: 'inherit' });
    if (ran.error !== undefined) {
      io.err(`connectome: ${command} couldn't be run: ${ran.error.message}`);
      return 1;
    }
    if (ran.signal !== null) {
      io.err(`connectome: ${command} ended on ${ran.signal}, so whether what it asked of the host happened isn't ` +
        'known here. `connectome` says what runs now.');
      return 1;
    }
    return ran.status ?? 1;
  }
  const [word] = argv;
  if (isHelp(word)) {
    usage(io.out);
    return 0;
  }
  if (word !== undefined && !COMMANDS.some((each) => each.name === word)) {
    io.err(`connectome: there's no command ${word}.`);
    usage(io.err);
    return 2;
  }
  if (existsSync(join(root, 'install.json'))) {
    io.err(`connectome: ${root} is an install without its own connectome command, which setup writes beside its ` +
      `start.js. ${setupAgain(root)}`);
    return 1;
  }
  io.err(`connectome: there's no connectome-host install here (${process.cwd()}).`);
  return 1;
}

function setupAgain(root: string): string {
  const setup = `bun ${shellWord(join(import.meta.dir, '..', 'update', 'setup.ts'))}`;
  let dataDir: string;
  try {
    dataDir = readInstallRecord(root).dataDir;
  } catch {
    return `Run setup again from ${dirname(root)}, with the DATA_DIR the service gives the host: \`${setup}\`.`;
  }
  return `Run setup again from ${dirname(root)}: \`DATA_DIR=${shellWord(dataDir)} ${setup}\`.`;
}

export async function bare(ctx: CliContext, healthWaitMs = HEALTH_WAIT_MS): Promise<number> {
  const root = ctx.root!;
  ctx.out(`connectome-host install at ${root}`);
  let release: string | null;
  try {
    release = readCurrent(root);
  } catch (error) {
    ctx.err(`connectome: ${root}'s current release can't be read: ${errorText(error)}`);
    return 1;
  }
  ctx.out(`Release: ${release ?? `none is current: run setup again in ${dirname(root)}, which says how to put it right`}`);
  const status = release === null ? 1 : 0;
  const host = await reach(ctx);
  if (host === null) return 1;
  if ('reason' in host) {
    ctx.out(`Its host doesn't answer: ${host.reason}.`);
    if (host.down) ctx.out(startHost(root, 'ask again'));
    ctx.out('Its update state isn\'t known while no host answers.');
    return status;
  }
  ctx.out(`Its host is running: pid ${host.ready.pid}, recipe ${host.ready.recipe}.`);
  if (host.ready.turnWork === undefined) {
    ctx.out(`That host is an older release than this command, so connectome send and connectome update refuse it; ` +
      'its own /update, in the TUI or the Web UI, still works. ' +
      thisRelease(root));
  }
  host.subscribe([]);
  const health = await host.request({ type: 'panel-request', op: 'health' }, healthWaitMs);
  host.close();
  const update = health?.ok === true ? (health.data as { update?: UpdateStatus } | undefined)?.update : undefined;
  if (update === undefined) {
    ctx.out(`Its update state couldn't be read: ${health === null
      ? `no answer came within ${healthWaitMs / 1000} s, or the connection closed first`
      : String(health.error ?? 'the host gave none')}.`);
  } else {
    ctx.out(`Its update state, as the running host gives it` +
      `${update.check === null ? '' : `, from its last read of the registry at ${update.check.at}`}:`);
    const ways = host.ready.turnWork === undefined ? COMMAND_WAYS : CLI_WAYS;
    for (const line of statusLines(update, ways)) ctx.out(`  ${line}`);
  }
  return status;
}

export const SEND_QUIET_LIMIT_MS = 15 * 60_000;

const SENT = 'connectome: wrote the line to the host\'s socket; what the agent says in reply prints here.';

const UNREAD = ` The host also closes it when output for it backs up and stays backed up for ${STOPPED_READING_MS / 60_000} ` +
  'minutes, as when this command is suspended.';

export async function send(ctx: CliContext, quietLimitMs = SEND_QUIET_LIMIT_MS): Promise<number> {
  const text = ctx.argv.join(' ');
  if (text.trim() === '') {
    ctx.err('connectome: usage: connectome send <text>');
    return 2;
  }
  const host = await reach(ctx);
  if (host === null) return 1;
  if ('reason' in host) {
    ctx.err(`connectome: nothing was sent: ${host.reason}.${host.down ? ` ${startHost(ctx.root!, 'send again')}` : ''}`);
    return 1;
  }
  if (host.ready.turnWork === undefined) {
    host.close();
    ctx.err('connectome: nothing was sent: the running host is an older release than this command, and it ' +
      'doesn\'t say when its agent is in a turn, so a reply here couldn\'t be told from an earlier turn\'s. ' +
      `${thisRelease(ctx.root!)} Then connectome send works.`);
    return 1;
  }
  const between = host.ready.turnWork !== true;
  const resident = host.ready.agent;
  let sent = between;
  let started = false;
  let spoke = false;
  let ended = false;
  let finished = false;
  if (!sent) ctx.err('connectome: the agent is in a turn. This waits for it to end, then sends.');
  const quiet = new Promise<'idle' | 'closed' | 'unheard'>((resolve) => {
    let limit = setTimeout(() => done('unheard'), quietLimitMs);
    const done = (how: 'idle' | 'closed' | 'unheard') => {
      finished = true;
      clearTimeout(limit);
      resolve(how);
    };
    host.onEvent((event) => {
      if (finished) return;
      clearTimeout(limit);
      limit = setTimeout(() => done('unheard'), quietLimitMs);
      const turnsDone = event.type === 'lifecycle' && (event.phase === 'turn-work-done' || event.phase === 'idle');
      if (typeof event.agentName === 'string' && event.agentName !== resident) return;
      if (!sent) {
        if (turnsDone) {
          sent = true;
          if (host.send({ type: 'text', content: text, from: 'console' })) ctx.err(SENT);
        }
        return;
      }
      const agent = String(event.agentName || 'an agent');
      if (event.type === 'inference:started') {
        started = true;
      } else if (event.type === 'inference:speech' && typeof event.content === 'string' && event.content !== '') {
        spoke = true;
        ctx.out(event.content);
      } else if (event.type === 'inference:failed' || event.type === 'inference:exhausted') {
        if (event.type === 'inference:exhausted') ended = true;
        ctx.err(`connectome: ${agent}'s inference ${event.type === 'inference:exhausted' ? 'gave up' : 'failed'}: ` +
          `${String(event.error || 'no error given')}`);
      } else if (event.type === 'inference:aborted') {
        ended = true;
        ctx.err(`connectome: ${agent}'s turn was stopped: ${String(event.reason || 'no reason given')}`);
      } else if (turnsDone && typeof event.texts === 'number' && event.texts >= 1) {
        done('idle');
      }
    });
    void host.closed.then(() => done('closed'));
  });
  if (between && host.send({ type: 'text', content: text, from: 'console' })) ctx.err(SENT);
  const how = await quiet;
  host.close();
  if (!sent) {
    ctx.err(how === 'closed'
      ? 'connectome: the connection closed before the agent\'s turn ended, so nothing was sent. The host stopping ' +
        'closes it, and so does another connectome command connecting.' + UNREAD
      : `connectome: nothing came from the host for ${quietLimitMs / 60_000} minutes while the agent was in a turn, ` +
        'so this stopped waiting, and nothing was sent.');
    return 1;
  }
  if (how === 'closed') {
    ctx.err(spoke || started
      ? `connectome: the connection closed before the agent's turn ended, so ${spoke ? 'the rest of ' : ''}its reply ` +
        'wasn\'t seen here. The host stopping closes it, and so does another connectome command connecting.' + UNREAD
      : 'connectome: the connection closed before any reply. If the host hadn\'t read the message yet, it never ' +
        'reached the agent: the host stopping closes it, and so does another connectome command connecting, and ' +
        'the host drops what it hadn\'t read.' + UNREAD);
    return 1;
  }
  if (how === 'unheard') {
    ctx.err(`connectome: nothing came from the host for ${quietLimitMs / 60_000} minutes, and it hadn't said the ` +
      'agent\'s turn ended, so this stopped waiting. The message was sent, and the agent may still be working on it.');
    return 1;
  }
  if (!started && !spoke) {
    ctx.err('connectome: the host took the message, and the agent started no turn for it before its turn work ' +
      'ended. A wake gate may have declined it, or be holding it to batch it with others. If it\'s held, the agent ' +
      'can answer it later. Sending it again won\'t undo a decline, and could deliver it twice.');
    return 1;
  }
  if (ended && !spoke) {
    ctx.err('connectome: the agent\'s turn ended without a reply.');
    return 1;
  }
  if (!spoke) {
    ctx.err('connectome: the agent\'s turn ended without saying anything here. It may have answered somewhere ' +
      'else, such as a channel, or with a tool.');
  }
  return 0;
}

async function update(ctx: CliContext): Promise<number> {
  const words = ctx.argv;
  if (!updateWords(words)) {
    ctx.err(`connectome: usage: ${UPDATE_USAGE}`);
    return 2;
  }
  const host = await reach(ctx);
  if (host === null) return 1;
  if ('reason' in host) return words[0] === 'back' ? backWithNoHost(ctx, words, host) : noHost(ctx, host);
  if (host.ready.turnWork === undefined) {
    host.close();
    ctx.err('connectome: nothing was asked: the running host is an older release than this command, and it ' +
      'doesn\'t mark where a command\'s answer ends, so this couldn\'t tell when to stop reading. ' +
      `${thisRelease(ctx.root!)} Then connectome update works.`);
    return 1;
  }
  const answer = await command(host, ['/update', ...words].join(' '), (line) => ctx.out(inCliWords(line)));
  host.close();
  if (answer.how === 'closed') {
    ctx.err('connectome: the host closed the connection before its answer ended, so how it ended isn\'t known ' +
      'here. A restart or a Go back closes it as the host stops, and so does another connectome command ' +
      'connecting. `connectome` says what runs now.');
    return 1;
  }
  if (answer.error !== undefined) {
    ctx.err(`connectome: the host's update command failed: ${inCliWords(answer.error)}`);
    return 1;
  }
  return answer.refused ? 1 : 0;
}

function inCliWords(line: string): string {
  return line.replace(/(^|[^\w/])\/update(?![\w/-])/g, '$1connectome update');
}

function updateWords([sub, choice, release, ...more]: string[]): boolean {
  if (more.length > 0) return false;
  const version = (word: string | undefined) => word === undefined || EXACT_VERSION.test(word);
  if (sub === undefined) return true;
  if (sub === 'check' || sub === 'install') return choice === undefined;
  if (sub === 'restart') {
    return release === undefined && (choice === undefined || ['wait', 'now', 'resume'].includes(choice) || version(choice));
  }
  if (sub === 'back') return choice === undefined ? true : (choice === 'keep' || choice === 'restore') && version(release);
  return false;
}

function backWithNoHost(ctx: CliContext, [, choice, release]: string[], host: NoHost): number {
  if (!host.down) return noHost(ctx, host);
  const root = ctx.root!;
  let offer: { to: string; since: string } | null;
  try {
    const current = readCurrent(root);
    if (current === null) {
      ctx.err(`connectome: no host answers (${host.reason}), and no release is current, so there's nothing to go ` +
        `back from: run setup again in ${dirname(root)}, which says how to put it right.`);
      return 1;
    }
    offer = goBackOffer(root, current);
  } catch (error) {
    ctx.err(`connectome: no host answers (${host.reason}), and whether a Go back is offered can't be told: ` +
      `${errorText(error)}`);
    return 1;
  }
  if (offer === null) {
    ctx.err(`connectome: no host answers (${host.reason}), and no Go back is offered: the copy doesn't hold ` +
      'another installed release\'s data.');
    return 1;
  }
  if (release !== undefined && release !== offer.to) {
    ctx.err(`connectome: nothing was asked for: the Go back offered is to ${offer.to}, not ${release}.`);
    return 1;
  }
  if (choice === undefined) {
    ctx.out(`No host answers (${host.reason}). Going back to ${offer.to} is offered, with the copy of its data ` +
      `taken ${offer.since}. Either of these asks the next start to go back:`);
    ctx.out(`- ${CLI_WAYS.keep} ${offer.to}: ${offer.to} runs on the data as it is now.`);
    ctx.out(`- ${CLI_WAYS.restore} ${offer.to}: the copy is restored, and everything since ${offer.since} is set aside, not ` +
      'deleted.');
    return 0;
  }
  return goBackFromShell(root, choice === 'keep' ? [KEEP_DATA_FLAG] : [], machineOps(), release);
}

function noHost(ctx: CliContext, host: NoHost): number {
  ctx.err(`connectome: no host answers (${host.reason}).${host.down ? ` ${startHost(ctx.root!, 'ask again')}` : ''}`);
  return 1;
}

function startHost(root: string, then: string): string {
  return `If no host is running, have its service start it with \`${startCommand(root)}\`, ` +
    `followed by the arguments it gives the host now, then ${then}.`;
}

function startCommand(root: string): string {
  return `${shellWord(process.execPath)} ${shellWord(join(root, ENTRY_POINT))}`;
}

function thisRelease(root: string): string {
  return `A host started with \`${startCommand(root)}\` runs this release: have its service start ` +
    'it that way, followed by the arguments it gives the host now, and restart it.';
}

async function reach(ctx: CliContext): Promise<HostClient | NoHost | null> {
  try {
    return await openHost(ctx.root!);
  } catch (error) {
    ctx.err(`connectome: ${errorText(error)}`);
    return null;
  }
}

type Answer = { how: 'done'; error?: string; refused?: true } | { how: 'closed' };

async function command(host: HostClient, text: string, print: (line: string) => void): Promise<Answer> {
  host.subscribe([]);
  const corrId = `connectome-command-${process.pid}`;
  const ended = new Promise<Answer>((done) => {
    host.onEvent((event: HostEvent) => {
      if (event.corrId !== corrId) return;
      if (event.type === 'command-output') print(String(event.text ?? ''));
      else if (event.type === 'command-done') {
        done({
          how: 'done',
          ...(typeof event.error === 'string' ? { error: event.error } : {}),
          ...(event.refused === true ? { refused: true } : {}),
        });
      }
    });
    void host.closed.then(() => done({ how: 'closed' }));
  });
  host.send({ type: 'command', command: text, corrId });
  return ended;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) process.exit(await main(null, process.argv.slice(2)));
