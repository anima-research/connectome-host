import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import type {
  EventResponse,
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '@animalabs/agent-framework';
import {
  DISCORD_TOKEN, StoredSecrets, isSecretName, readEnvFile, redactWindow, secretNames, secretValues,
  unwritableValue, withoutSecrets, writeEnvValue, EnvFormError, EnvLinkError, envForm, envLink, type Secret,
} from '../setup/secrets.js';
import { checkDiscordToken, type TokenCheck } from '../setup/discord-token.js';
import { PROVIDER_KEYS, checkProviderKey, familyOf, listModels, type ProviderAnswer } from '../setup/provider-key.js';
import { unknownToolResult } from './unknown-tool.js';
import { writeJsonAtomic } from '../update/contract.js';
import { readSetupState } from '../setup/state.js';

export interface SecretAsker {
  /** The value the person typed, or null when they declined or the terminal closed. */
  ask(name: string, purpose: string): Promise<string | null>;
}

export interface SetupModuleConfig {
  /** The install's working directory: where commands run, where .env is, and where setup keeps .setup/. */
  dir: string;
  /** The environment commands start from, before the secrets are taken out. */
  env: Record<string, string | undefined>;
  /** The terminal to ask on, once readline mode has one. */
  asker: () => SecretAsker | null;
  /** Shows the person a line on the terminal the host runs in. */
  show: (line: string) => void;
  fetch?: typeof fetch;
}

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 30 * 60_000;
// Each stream's head and tail, so both streams' together, with what the answer adds, stay under agent-framework
// 0.27.0's 24,000-character cap for a tool result's inline text (DEFAULT_TOOL_RESULT_INLINE_MAX_CHARS), past which it
// cuts the answer, and stderr's tail with it, for ordinary output: one dense in what JSON escapes, or in short
// secrets under long names, can still pass it.
const KEPT_BYTES = 4 * 1024;
/** The longest a stream's output comes back whole: past it, setup--run gives its head and tail. */
export const WHOLE_OUTPUT_BYTES = 2 * KEPT_BYTES;
const KILL_GRACE_MS = 5_000;
const DRAIN_MS = 1_000;

interface Stream {
  bytes: number;
  text: string;
  cut: boolean;
}

function isContinuation(bytes: Buffer, at: number): boolean {
  return at < bytes.length && (bytes[at]! & 0xc0) === 0x80;
}

class Capture {
  private total = 0;
  private full: Buffer[] | null = [];
  private fullBytes = 0;
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private readonly window: number;

  constructor(overlap: number) {
    this.window = KEPT_BYTES + overlap;
  }

  add(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.full) {
      this.full.push(chunk);
      this.fullBytes += chunk.length;
      if (this.fullBytes > 2 * this.window) this.full = null;
    }
    if (this.head.length < this.window) {
      this.head = Buffer.concat([this.head, chunk.subarray(0, this.window - this.head.length)]);
    }
    this.tail = Buffer.concat([this.tail, chunk]);
    if (this.tail.length > this.window) this.tail = this.tail.subarray(this.tail.length - this.window);
  }

  /** The stream whole while it's 8 KiB or less, else its first and last 4 KiB, each secret replaced by its name. A
   *  secret the cut runs through is shown whole on its side, and where that takes the two to meet, the stream comes
   *  back whole. */
  result(secrets: Secret[], replaced: Set<string>): Stream {
    const all = this.full ? Buffer.concat(this.full) : null;
    const whole = (): Stream =>
      ({ bytes: this.total, text: redactWindow(all!, 0, all!.length, secrets, replaced).text, cut: false });
    if (all && all.length <= WHOLE_OUTPUT_BYTES) return whole();
    const head = all ?? this.head;
    const tail = all ?? this.tail;
    const longest = all ? 0 : Math.max(0, ...secrets.map(({ value }) => Buffer.byteLength(value)));
    let headTo = Math.max(0, Math.min(KEPT_BYTES, head.length - longest));
    while (headTo > 0 && isContinuation(head, headTo)) headTo--;
    let tailFrom = Math.min(tail.length, Math.max(longest, tail.length - KEPT_BYTES));
    while (isContinuation(tail, tailFrom)) tailFrom++;
    const named = new Set<string>();
    const shownHead = redactWindow(head, 0, headTo, secrets, named);
    const shownTail = redactWindow(tail, tailFrom, tail.length, secrets, named);
    const hidden = this.total - shownHead.end - (tail.length - shownTail.start);
    if (hidden <= 0 && all) return whole();
    for (const name of named) replaced.add(name);
    return {
      bytes: this.total,
      text: `${shownHead.text}\n[${hidden.toLocaleString('en-US')} bytes not shown]\n${shownTail.text}`,
      cut: true,
    };
  }
}

interface Group {
  signal(signal: NodeJS.Signals): void;
  alive(): boolean;
}

// Bun runs 'exit' listeners after an uncaught error, and none after a SIGKILL or a crash of Bun itself. A listener
// for SIGHUP, SIGINT or SIGTERM takes the place of the signal's default action, which comes back once it's removed.
const running = new Set<Group>();
const ENDING_SIGNALS = ['SIGHUP', 'SIGINT', 'SIGTERM'] as const;
let watching = false;

function endRunning(): void {
  for (const group of running) group.signal('SIGKILL');
}

function onEndingSignal(signal: NodeJS.Signals): void {
  endRunning();
  for (const each of ENDING_SIGNALS) process.off(each, onEndingSignal);
  process.kill(process.pid, signal);
}

function watchHostEnd(): void {
  if (watching) return;
  watching = true;
  process.on('exit', endRunning);
  for (const signal of ENDING_SIGNALS) process.on(signal, onEndingSignal);
}

function groupOf(pid: number | undefined): Group {
  return {
    signal(signal) {
      try {
        if (pid !== undefined) process.kill(-pid, signal);
      } catch {
        // The group has gone.
      }
    },
    alive() {
      try {
        if (pid === undefined) return false;
        process.kill(-pid, 0);
        return true;
      } catch {
        return false;
      }
    },
  };
}

// What a terminal acts on, or draws as nothing or as a space, rather than showing what it is: Unicode's control and
// format characters (tab, CR, ESC, C1, the marks that reorder text, zero-width characters), its line and paragraph
// separators, each space but the ASCII one, since another looks like it while bash reads it as part of a word, the
// characters Unicode means to be drawn as nothing (Default_Ignorable_Code_Point: the variation selectors, the Hangul
// fillers, U+034F), and the blank braille cell, U+2800, which is drawn as a space.
const UNSHOWN = /(?! )[\p{Cc}\p{Cf}\p{Z}\p{Default_Ignorable_Code_Point}\u2800]/gu;

/** A line as the person is shown it: each character UNSHOWN takes as its \u escape, so nothing in it moves, hides or
 *  reorders what's shown. */
function shown(line: string): string {
  return line.replace(UNSHOWN, (character) => {
    const hex = character.codePointAt(0)!.toString(16);
    return hex.length <= 4 ? `\\u${hex.padStart(4, '0')}` : `\\u{${hex}}`;
  });
}

export const SETUP_MODULE = 'setup';

export function commandsShownNote(dir: string): string {
  return `Setup's agent runs each command in ${shown(dir)}, as you. You'll see each command whole before it runs, each ` +
    'of its lines on a line of its own, any character a terminal would hide or act on shown as a code, such as \\u001b ' +
    'for Escape, and each key or token setup knows of shown by its name in place of its value, such as ' +
    '<ANTHROPIC_API_KEY>.';
}

export function openingMessage(held: boolean, after: 'start' | 'switch', finishedAt: string | null = null): string {
  const finished = finishedAt === null ? '' : ` Setup had finished, at ${finishedAt}.`;
  if (after === 'switch') {
    return (held
      ? 'From setup, not the person: they\'ve switched to this conversation, and it picks up where it stopped.'
      : 'From setup, not the person: they\'ve started a new conversation with setup. What setup has done stays on disk, ' +
        'and this conversation doesn\'t hold it.') + finished;
  }
  if (finishedAt !== null) {
    return `From setup, not the person: they've started setup again after it finished, at ${finishedAt}` +
      (held ? ', and this conversation picks up where it stopped.' : '. What setup has done stays on disk, and this ' +
        'conversation doesn\'t hold it.');
  }
  return held
    ? 'From setup, not the person: they\'ve started setup again, and this conversation picks up where it stopped.'
    : 'From setup, not the person: they\'ve just started setup and are at this terminal.';
}

export const REFUSED_TURN = 'The model refused that turn. This can come from anything in the conversation, not only what ' +
  'you just wrote. Try once more; if it refuses again, /session new starts a new conversation with setup\'s agent, and ' +
  'what setup has done stays on disk.';

export const REFUSED_BEFORE = 'Setup\'s agent\'s last reply was refused by the model. This can come from anything in the ' +
  'conversation. If it\'s refused again, /session new starts a new conversation with setup\'s agent, and what setup has ' +
  'done stays on disk.';

export function lastReplyRefused(
  framework: { queryInferenceLogs(query: { agentName: string; limit: number }): { entries: Array<{ summary?: { stopReason?: string } }> } },
  agentName: string,
): boolean {
  return framework.queryInferenceLogs({ agentName, limit: 1 }).entries[0]?.summary?.stopReason === 'refusal';
}

export function showsItself(tool: string): boolean {
  return tool.startsWith(`${SETUP_MODULE}--`);
}

/** A command's lines as the person is shown them: each secret's value as its name, as in the answer, and each line
 *  as shown() gives it. */
function shownCommand(command: string, secrets: Secret[]): string[] {
  const bytes = Buffer.from(command);
  return redactWindow(bytes, 0, bytes.length, secrets, new Set()).text.split('\n').map(shown);
}

function failed(error: string): ToolResult {
  return { success: false, error, isError: true };
}

function linked(nothing: string, link: EnvLinkError): ToolResult {
  return failed(`${nothing}: ${link.message}. Asking again won't help until the person replaces the link with the file ` +
    'it leads to, if that\'s there, or takes it away; tell them so.');
}

interface Seen {
  names: Set<string>;
  values: Secret[];
}

const seenByDir = new Map<string, Seen>();

function seenIn(dir: string): Seen {
  let seen = seenByDir.get(resolve(dir));
  if (!seen) seenByDir.set(resolve(dir), (seen = { names: new Set(), values: [] }));
  return seen;
}

function addSecret(secrets: Secret[], secret: Secret): void {
  if (!secrets.some((had) => had.name === secret.name && had.value === secret.value)) secrets.push(secret);
}

export class SetupModule implements Module {
  readonly name = SETUP_MODULE;
  readonly storedSecrets: StoredSecrets;
  private readonly groups = new Set<Group>();
  private stopping = false;
  private asking: Promise<unknown> = Promise.resolve();
  private readonly seen: Seen;
  finishRequested = false;

  constructor(private readonly config: SetupModuleConfig) {
    this.storedSecrets = new StoredSecrets(join(config.dir, '.setup'));
    this.seen = seenIn(config.dir);
  }

  async start(_ctx: ModuleContext): Promise<void> {}

  /** Stops each command still running, and each one stopped at its limit less than 5 s before: SIGTERM to its
   *  process group, and SIGKILL to each group with any of it left 5 s on. Commands asked for afterwards are refused. */
  async stop(): Promise<void> {
    this.stopping = true;
    const groups = [...this.groups];
    for (const group of groups) group.signal('SIGTERM');
    for (const until = Date.now() + KILL_GRACE_MS; groups.some((group) => group.alive()) && Date.now() < until;) {
      await new Promise((done) => setTimeout(done, 50));
    }
    for (const group of groups) if (group.alive()) group.signal('SIGKILL');
    for (const group of groups) running.delete(group);
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'run',
        description:
          `Run one command with bash -c in the install's directory, and get its exit status and output back: of an ` +
          `output longer than 8 KiB, its first and last 4 KiB, each widened to take in whole a secret a cut falls ` +
          `in, or the whole output where the two then meet. Its environment is the host's, less the stored secrets, the provider credentials and the ` +
          `providers' base URLs, and no shell startup file is read. Nothing is kept between calls but what the command ` +
          `leaves behind: a process it leaves running when it ends, before the host shuts down, keeps running, after ` +
          `the host ends too, so a ` +
          `resident's host started from a command and one its service starts later would be two hosts on one data ` +
          `directory. A command still running at its time limit, or when the host shuts down (as at /quit), is stopped: its process group gets ` +
          `SIGTERM, and SIGKILL 5 s later if any of it is left. The value of a stored secret, a provider credential or ` +
          `a provider's base URL that appears in the output as it was stored comes back as <NAME>; an encoded or split ` +
          `one isn't recognized.`,
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The command line, as bash -c reads it.' },
            timeoutMs: {
              type: 'number',
              description: `Its time limit in ms: ${DEFAULT_TIMEOUT_MS} unless given, at most ${MAX_TIMEOUT_MS}.`,
            },
          },
          required: ['command'],
        },
      },
      {
        name: 'ask_secret',
        description:
          'Ask the person for a secret in this terminal, with nothing shown as they type, and store it in the ' +
          "install's .env. You get back only where it was stored, never the value. A DISCORD_TOKEN is checked with " +
          'Discord first, and an OPENAI_API_KEY, OPENROUTER_API_KEY or ANTHROPIC_API_KEY with its provider, at the ' +
          'OPENAI_BASE_URL or ANTHROPIC_BASE_URL .env names if it names one; one that is refused is not stored. ' +
          'Bedrock\'s keys aren\'t checked, since a request with them needs AWS\'s signing, nor Codex\'s login, which ' +
          'isn\'t a key, nor OPENAI_COMPATIBLE_API_KEY, whose endpoint is the recipe\'s.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The environment variable it is stored as, such as DISCORD_TOKEN.' },
            purpose: { type: 'string', description: 'What it is and where the person finds it, shown to them as they type it.' },
          },
          required: ['name', 'purpose'],
        },
      },
      {
        name: 'finished',
        description:
          'Say that setup is finished, once the person has nothing more to set up. It records when in the install\'s ' +
          '.setup/setup-state.json, and the conversation ends after this turn, once anything the person typed ' +
          'meanwhile has come to you as further turns, so say whatever is left to say in this same turn. If the ' +
          'person starts setup again later, it tells you setup had finished, and when.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'check_model',
        description:
          'Check with the provider whether it offers a model to the key stored in the install\'s .env as name: ' +
          'OPENAI_API_KEY (OpenAI, or the OPENAI_BASE_URL .env names), OPENROUTER_API_KEY, or ANTHROPIC_API_KEY ' +
          '(Anthropic, or the ANTHROPIC_BASE_URL .env names). You get back whether it lists the model, and if not, the ' +
          'models it lists of the same family, the part of the name before its first - or ., or how many it lists ' +
          'where none share it. The key\'s value is never shown. Bedrock, Codex and openai-compatible models aren\'t ' +
          'checked, for the reasons ask_secret gives.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The name the key is stored as, such as OPENAI_API_KEY.' },
            model: { type: 'string', description: 'The model, as the recipe would name it, such as gpt-6.1-terra.' },
          },
          required: ['name', 'model'],
        },
      },
    ];
  }

  finishedAt(): string | null {
    const read = readSetupState(join(this.config.dir, '.setup', 'setup-state.json'));
    return 'state' in read ? read.state.finished ?? null : null;
  }

  private finished(): ToolResult {
    const path = join(this.config.dir, '.setup', 'setup-state.json');
    const read = readSetupState(path);
    if (!('state' in read)) {
      return failed(`${path} doesn't hold setup's answers, so nothing was recorded and the conversation goes on. Tell ` +
        'the person: running setup again asks its questions again.');
    }
    const when = new Date().toISOString();
    writeJsonAtomic(path, { ...read.state, finished: when }, 0o600);
    this.finishRequested = true;
    return {
      success: true,
      data: `Recorded that setup finished at ${when}. The conversation ends after this turn, once anything the ` +
        'person typed meanwhile has come to you as further turns.',
    };
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    if (call.name === 'run') return this.run(call.input as { command?: unknown; timeoutMs?: unknown });
    if (call.name === 'ask_secret') {
      const turn = this.asking.then(() => this.askSecret(call.input as { name?: unknown; purpose?: unknown }));
      this.asking = turn.catch(() => {});
      return turn;
    }
    if (call.name === 'check_model') {
      // Once a secret being asked for is stored or refused, so it checks the key stored then.
      return this.asking.then(() => this.checkModel(call.input as { name?: unknown; model?: unknown }));
    }
    if (call.name === 'finished') return this.finished();
    return unknownToolResult(this, call.name);
  }

  private secrets(): { names: string[]; values: Secret[]; guessed: string[] } {
    const envFile = join(this.config.dir, '.env');
    const { names: current, guessed } = secretNames(join(this.config.dir, '.setup'), envFile);
    for (const name of current) this.seen.names.add(name);
    const names = [...this.seen.names];
    for (const read of secretValues(names, envFile, this.config.env)) addSecret(this.seen.values, read);
    return { names, values: [...this.seen.values], guessed };
  }

  private damaged(error: unknown, what: string): ToolResult {
    if (error instanceof EnvFormError) {
      return failed(`${what}: ${error.message}. While .env holds such a line, what Bun reads from it, and so what a ` +
        'command prints of a secret, isn\'t known, so ask the person to put that right; you can\'t, since setup--run ' +
        'runs nothing meanwhile.');
    }
    return failed(`${what}: ${(error as Error).message}. Which values are secret isn't known until it's put right, ` +
      'so ask the person to put it right; you can\'t, since setup--run runs nothing meanwhile.');
  }

  private async run(input: { command?: unknown; timeoutMs?: unknown }): Promise<ToolResult> {
    if (typeof input.command !== 'string' || input.command.trim() === '') {
      return failed('setup--run needs a command: the line to run, as bash -c reads it.');
    }
    const limit = input.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : input.timeoutMs;
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0 || limit > MAX_TIMEOUT_MS) {
      return failed(`setup--run's timeoutMs is a number of ms above 0 and at most ${MAX_TIMEOUT_MS}.`);
    }
    await this.asking;
    if (this.stopping) return failed('The host is stopping, so setup--run runs nothing, and calling it again won\'t change that.');
    let atLaunch: { names: string[]; values: Secret[] };
    try {
      atLaunch = this.secrets();
    } catch (error) {
      return this.damaged(error, 'setup--run ran nothing');
    }
    this.config.show('Setup\'s agent runs:');
    for (const line of shownCommand(input.command, atLaunch.values)) this.config.show(`  ${line}`);
    // 4 bytes more: the longest UTF-8 character, so a cut can be moved back to fall between characters.
    const overlap = Math.max(0, ...atLaunch.values.map((s) => Buffer.byteLength(s.value))) + 4;
    const out = new Capture(overlap);
    const err = new Capture(overlap);
    // Setup's own variables are for its host alone: a resident started from a command serves its own data directory
    // and checks for updates as its service would.
    const own = Object.keys(this.config.env).filter((name) => name.startsWith('CONNECTOME_SETUP_'));
    const env = withoutSecrets(this.config.env,
      [...atLaunch.names, 'BASH_ENV', 'DATA_DIR', 'CONNECTOME_UPDATE_CHECK', ...own]);
    const child = spawn('bash', ['--norc', '-c', input.command], {
      cwd: this.config.dir,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', (chunk: Buffer) => out.add(chunk));
    child.stderr!.on('data', (chunk: Buffer) => err.add(chunk));
    const group = groupOf(child.pid);
    this.groups.add(group);
    running.add(group);
    watchHostEnd();
    let stoppedAtLimit = false;
    const limitTimer = setTimeout(() => {
      stoppedAtLimit = true;
      group.signal('SIGTERM');
      setTimeout(() => {
        if (group.alive()) group.signal('SIGKILL');
        this.groups.delete(group);
        running.delete(group);
      }, KILL_GRACE_MS).unref();
    }, limit);
    let heldOpen = false;
    const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null } | { error: Error }>((done) => {
      child.once('error', (error) => {
        clearTimeout(limitTimer);
        this.groups.delete(group);
        running.delete(group);
        done({ error });
      });
      child.once('exit', (code, signal) => {
        clearTimeout(limitTimer);
        if (!stoppedAtLimit) {
          this.groups.delete(group);
          if (!this.stopping) running.delete(group);
        }
        const drained = setTimeout(() => {
          heldOpen = true;
          done({ code, signal });
        }, DRAIN_MS);
        child.once('close', () => {
          clearTimeout(drained);
          done({ code, signal });
        });
      });
    });
    child.stdout!.destroy();
    child.stderr!.destroy();
    if ('error' in ended) return failed(`setup--run couldn't start bash: ${ended.error.message}`);
    let secrets: Secret[];
    let guessed: string[];
    try {
      ({ values: secrets, guessed } = this.secrets());
    } catch (error) {
      return this.damaged(error, `setup--run's command ended (exit ${ended.code ?? ended.signal}), and its output isn't shown`);
    }
    const notes: string[] = [];
    if (stoppedAtLimit) {
      notes.push(`It was still running at its ${limit} ms limit, so its process group was sent SIGTERM, and is sent ` +
        'SIGKILL 5 s later if any of it is left. A process it started in a group of its own isn\'t stopped.');
    }
    if (heldOpen) {
      notes.push(`Its output was cut ${DRAIN_MS / 1000} s after it ended, since a process it started still holds the ` +
        'output open, and is still running.');
    }
    const replaced = new Set<string>();
    const stdout = out.result(secrets, replaced);
    const stderr = err.result(secrets, replaced);
    const hidden = guessed.filter((name) => replaced.has(name)).sort();
    if (hidden.length > 0) {
      notes.push(`${join(this.config.dir, '.setup', 'stored-secrets.json')}, the list of the secrets setup stored, is ` +
        `missing, so every name in .env that setup doesn't know counts as secret, and ${hidden.join(', ')} came back ` +
        'as its name. For values that aren\'t secret to show, the person writes that file as a JSON list of the name ' +
        'of every secret, those in .env and any the host is given through its environment, such as ' +
        '["MY_SERVER_TOKEN"], leaving out only names that aren\'t secret; it takes effect from the host\'s next start.');
    }
    const data = {
      exitCode: ended.code,
      ...(ended.signal ? { signal: ended.signal } : {}),
      stoppedAtLimit,
      ...(heldOpen ? { outputHeldOpen: true } : {}),
      ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
      stdout,
      stderr,
      replaced: [...replaced].sort(),
    };
    return { success: true, data };
  }

  private async askSecret(input: { name?: unknown; purpose?: unknown }): Promise<ToolResult> {
    const { name, purpose } = input;
    if (typeof name !== 'string' || !isSecretName(name)) {
      return failed('setup--ask_secret needs a name an environment variable can have: letters, digits and _, not starting with a digit.');
    }
    if (typeof purpose !== 'string' || purpose.trim() === '') {
      return failed('setup--ask_secret needs a purpose: what the secret is and where the person finds it.');
    }
    if (this.stopping) return failed('The host is stopping, so setup--ask_secret asks nothing, and calling it again won\'t change that.');
    const asker = this.config.asker();
    if (!asker) {
      return failed('There is no terminal here to ask the person on: setup--ask_secret asks only in the conversation ' +
        '`connectome setup discord` starts in a terminal, so calling it again here won\'t help. The person can run ' +
        'that command in a terminal.');
    }
    const envFile = join(this.config.dir, '.env');
    const provider = Object.hasOwn(PROVIDER_KEYS, name) ? PROVIDER_KEYS[name] : undefined;
    try {
      const link = envLink(envFile);
      if (link) return linked(`Nothing was asked, so nothing was stored as ${name}`, link);
      const outside = envForm(envFile);
      if (outside) {
        return failed(`Nothing was asked, so nothing was stored as ${name}: ${outside.message}. Ask the person to put ` +
          'that right, then call again.');
      }
      this.secrets();
    } catch (error) {
      return this.damaged(error, `Nothing was asked, so nothing was stored as ${name}`);
    }
    let value: string | null;
    try {
      value = await asker.ask(name, shown(purpose));
    } catch (error) {
      return failed(`Nothing was asked, so nothing was stored as ${name}: ${(error as Error).message}. Calling again ` +
        'won\'t change that, so tell the person why.');
    }
    if (value !== null && name === DISCORD_TOKEN) value = value.trim();
    if (value === null || value === '') {
      const spaces = name === DISCORD_TOKEN ? ', or only whitespace' : '';
      return failed(`Nothing came back from the terminal (Enter alone${spaces}, or the terminal closed), so nothing was stored as ${name}. ` +
        'If they declined, ask them in the conversation whether to try again.');
    }
    const why = unwritableValue(value);
    if (why) {
      return failed(`What the person typed for ${name} can't be stored, since ${why}, and ask_secret can't store such a ` +
        'value however it is asked. Nothing was stored. Tell them why, and ask them to check what they copied; if it\'s ' +
        'right as typed, tell them setup can\'t store it.');
    }
    let token: TokenCheck | null = null;
    if (name === DISCORD_TOKEN) {
      token = await this.checkToken(value);
      if (token.kind === 'refused') {
        return failed(`Discord refused this token (401), so nothing was stored as ${name}, and what was stored as it ` +
          'before stays as it was. Tell the person, and ask them to copy it again from their application\'s Bot page in ' +
          'the Discord Developer Portal (Reset Token there makes a new one), then call again.');
      }
      if (token.kind === 'unsendable') {
        return failed(`What the person typed for ${name} holds a character a request header can't carry, so it can't ` +
          'be a bot token, and nothing was stored. Ask them to check what they copied, then call again.');
      }
    }
    let key: ProviderAnswer<null> | null = null;
    if (provider !== undefined) {
      let env: Map<string, string>;
      try {
        env = readEnvFile(envFile);
      } catch (error) {
        return failed(`Nothing was stored as ${name}: ${(error as Error).message}, so where ` +
          `${provider.provider} is to be asked about the key isn't known. Ask the person to put that right, then ` +
          'call again.');
      }
      let hide: Secret[];
      try {
        hide = this.secrets().values;
      } catch (error) {
        return this.damaged(error, `Nothing was stored as ${name}`);
      }
      key = await this.checkKey(name, value, env, hide);
      if (key.kind === 'refused') {
        return failed(name === 'OPENROUTER_API_KEY'
          ? `${provider.provider} refused this key (${key.status}), so nothing was stored as ${name}, and what was ` +
            'stored as it before stays as it was. Tell the person, and ask them to copy it again, or make a new one, ' +
            'then call again.'
          : `${provider.provider} refused this key (${key.status}) when setup asked it for its list of models, so ` +
            `nothing was stored as ${name}, and what was stored as it before stays as it was. ${LISTING_REFUSED} ` +
            'Tell the person, and ask them to check what the key is allowed, or to copy it again, or to make a new ' +
            'one, then call again.');
      }
      if (key.kind === 'unsendable') {
        return failed(`What the person typed for ${name} holds a character a request header can't carry, so it can't ` +
          'be a key, and nothing was stored. Ask them to check what they copied, then call again.');
      }
    }
    const told = token !== null ? tokenNote(token) : key !== null ? keyNote(name, key) : '';
    this.seen.names.add(name);
    addSecret(this.seen.values, { name, value });
    let writing = false;
    try {
      const link = envLink(envFile);
      if (link) throw link;
      for (const replaced of secretValues([name], envFile, {})) addSecret(this.seen.values, replaced);
      this.storedSecrets.record(name, envFile);
      writing = true;
      writeEnvValue(envFile, name, value);
    } catch (error) {
      if (error instanceof EnvLinkError) return linked(`Nothing was stored as ${name}`, error);
      if (error instanceof EnvFormError) {
        return failed(`Nothing was stored as ${name}: ${error.message}. Ask the person to put that right, then call ` +
          'again.');
      }
      if (!writing) {
        return failed(`Nothing was stored as ${name}: ${(error as Error).message}. Ask the person to put that right, ` +
          'then call again.');
      }
      return failed(`It isn't known whether ${name} was stored: ${(error as Error).message}. Ask the person to put right ` +
        'what that names, then call again, which asks for the value again.');
    }
    return { success: true, data: `stored as ${name} in ${envFile}${told}` };
  }

  private async checkKey(name: string, value: string, env: Map<string, string>, hide: Secret[]): Promise<ProviderAnswer<null>> {
    const provider = PROVIDER_KEYS[name]!.provider;
    this.config.show(`Checking it with ${provider}.`);
    const key = await checkProviderKey(name, value, { fetch: this.config.fetch, env, hide })!;
    this.config.show(answerLine(provider, key, `${provider} accepted it.`, 'nothing was stored'));
    return key;
  }

  private async checkModel(input: { name?: unknown; model?: unknown }): Promise<ToolResult> {
    const { name, model } = input;
    if (typeof name !== 'string' || typeof model !== 'string' || model.trim() === '') {
      return failed('setup--check_model needs a name, the one the key is stored as, and a model.');
    }
    const provider = PROVIDER_KEYS[name]?.provider;
    if (provider === undefined) {
      return failed(`setup--check_model checks models for the keys stored as ${Object.keys(PROVIDER_KEYS).join(', ')}, ` +
        `not ${name}: Bedrock's requests need AWS's signing, Codex runs on a ChatGPT login, and an openai-compatible ` +
        'endpoint is the recipe\'s.');
    }
    const envFile = join(this.config.dir, '.env');
    let env: Map<string, string>;
    try {
      const link = envLink(envFile);
      if (link) return linked(`Nothing was checked`, link);
      const outside = envForm(envFile);
      if (outside) return failed(`Nothing was checked: ${outside.message}. Ask the person to put that right, then call again.`);
      env = readEnvFile(envFile);
    } catch (error) {
      return this.damaged(error, 'Nothing was checked');
    }
    const key = env.get(name);
    if (key === undefined || key === '') {
      return failed(`Nothing is stored as ${name} in ${envFile}, so there's no key to check ${model} with. Ask the ` +
        'person for it with setup--ask_secret first.');
    }
    this.config.show(`Checking ${shown(model)} with ${provider}.`);
    let hide: Secret[];
    try {
      hide = this.secrets().values;
    } catch (error) {
      return this.damaged(error, 'Nothing was checked');
    }
    const listed = await listModels(name, key, { fetch: this.config.fetch, env, hide })!;
    if (listed.kind === 'unsendable') {
      const words = `The key stored as ${name} holds a character a request header can't carry, so it can't be a key`;
      this.config.show(`${words}.`);
      return failed(`${words}: ask the person for it again with setup--ask_secret.`);
    }
    if (listed.kind !== 'accepted') {
      this.config.show(answerLine(provider, listed, '', 'whether it offers the model isn\'t known'));
      if (listed.kind === 'refused') {
        return failed(`${provider} refused the key stored as ${name} (${listed.status}) when setup asked it for its ` +
          `list of models, so whether it offers ${model} isn't known. ${LISTING_REFUSED} Ask the person to check what ` +
          'the key is allowed, or for a new key with setup--ask_secret.');
      }
      return failed(`Whether ${provider} offers ${model} to the key stored as ${name} isn't known: ` +
        `${keyNote(name, listed).replace(/^, but it isn't known to work: /, '').replace(/\.$/, '')}.`);
    }
    const ids = listed.value;
    if (ids.includes(model)) {
      this.config.show(`${provider} lists ${shown(model)} for this key.`);
      return { success: true, data: `${provider} lists ${model} among the ${ids.length} models it offers the key stored as ${name}.` };
    }
    this.config.show(`${provider} doesn't list ${shown(model)} for this key.`);
    const family = familyOf(model);
    const kin = ids.filter((id) => id === family || id.startsWith(`${family}-`) || id.startsWith(`${family}.`)).sort();
    return failed(`${provider} doesn't list ${model} among the ${ids.length} models it offers the key stored as ${name}` +
      (kin.length > 0 ? `. Of its family, ${family}, it lists: ${kin.join(', ')}.` : `, and none of its family, ${family}.`) +
      ' Ask the person which they meant before the recipe names it.');
  }

  private async checkToken(value: string): Promise<TokenCheck> {
    const token = await checkDiscordToken(value, {
      fetch: this.config.fetch, asking: () => this.config.show('Checking it with Discord.'),
    });
    this.config.show(tokenLine(token));
    return token;
  }
}


function tokenLine(token: TokenCheck): string {
  switch (token.kind) {
    case 'accepted': return `Discord accepted it: the bot is ${shown(token.name)}.`;
    case 'refused': return 'Discord refused it (401): nothing was stored.';
    case 'unsendable': return 'It holds a character a request header can\'t carry, so it can\'t be a token: nothing was stored.';
    case 'answered':
      return `Discord didn't say whether it works: it answered ${token.status}` +
        `${token.said === null ? '' : ` (${shown(token.said)})`}.`;
    case 'unanswered': return `Discord couldn't be asked whether it works (${shown(token.why)}).`;
  }
}

const LISTING_REFUSED = 'The key may be wrong or revoked, or it may not be allowed to list models, or to be used ' +
  'from where this machine is.';

function answerLine(provider: string, answer: ProviderAnswer<unknown>, accepted: string, refusedThen: string): string {
  switch (answer.kind) {
    case 'accepted': return accepted;
    case 'refused': return `${provider} refused it (${answer.status}): ${refusedThen}.`;
    case 'unsendable': return 'It holds a character a request header can\'t carry, so it can\'t be a key: nothing was stored.';
    case 'answered':
      return `${provider} didn't say whether it works: it answered ${answer.status}` +
        `${answer.said === null ? '' : ` (${shown(answer.said)})`}.`;
    case 'unanswered': return `${provider} couldn't be asked whether it works (${shown(answer.why)}).`;
  }
}

function keyNote(name: string, answer: ProviderAnswer<unknown>): string {
  const provider = PROVIDER_KEYS[name]!.provider;
  switch (answer.kind) {
    case 'accepted':
      return name === 'OPENROUTER_API_KEY' ? `. ${provider} accepted it: it answered for the key.`
        : `. ${provider} accepted it: it listed the models the key can use, which shows the key is accepted, not ` +
          'that a call to one of them succeeds.';
    case 'answered':
      return `, but it isn't known to work: ${provider} answered ${answer.status}${answer.said === null ? '' : `: ${answer.said}`}.`;
    case 'unanswered': return `, but it isn't known to work: ${provider} couldn't be asked (${answer.why}).`;
    case 'unsendable': return ', but it can\'t be a key: it holds a character a request header can\'t carry.';
    default: return '';
  }
}

function tokenNote(token: TokenCheck): string {
  switch (token.kind) {
    case 'accepted': return `. Discord accepted it: the bot is ${token.name} (${token.id}).`;
    case 'answered':
      return `, but it isn't known to work: Discord answered ${token.status}${token.said === null ? '' : `: ${token.said}`}.`;
    case 'unanswered': return `, but it isn't known to work: Discord couldn't be asked (${token.why}).`;
    default: return '';
  }
}
