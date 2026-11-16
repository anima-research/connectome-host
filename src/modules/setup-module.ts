import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult,
} from '@animalabs/agent-framework';
import { SHOWN_FILE, shown } from '../setup/commands-shown.js';
import { checkDiscordToken } from '../setup/discord-token.js';
import { PROVIDER_KEYS, checkProviderKey, type KeyAnswer } from '../setup/provider-key.js';
import {
  DISCORD_TOKEN, PROVIDER_SECRETS, SHORT_CHARACTERS, StoredSecrets, isSecretName, isShort, readEnvFile, shownByName,
  storedSecrets, unwritableValue, writeEnvValue, type Secret,
} from '../setup/secrets.js';
import { unknownToolResult } from './unknown-tool.js';

export const SETUP_MODULE = 'setup';

export interface SecretAsker {
  ask(name: string, purpose: string): Promise<string | null>;
}

export interface SetupModuleConfig {
  /** The install's directory, where commands run and .env is. */
  dir: string;
  env: Record<string, string | undefined>;
  asker: () => SecretAsker | null;
  /** A line for the person's terminal. */
  show: (line: string) => void;
  fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
// Each stream keeps at most 2 * KEPT_BYTES, so the two, as text, fit in one tool result with room for its JSON:
// agent-framework 0.33.0 caps a tool result at 24,000 characters by default (DEFAULT_TOOL_RESULT_INLINE_MAX_CHARS,
// in its src/tool-result-history.ts).
const KEPT_BYTES = 4 * 1024;
const KILL_GRACE_MS = 5_000;
const DRAIN_MS = 1_000;

const NOT_FOR_COMMANDS = (name: string) =>
  name === 'DATA_DIR' || name === 'CONNECTOME_UPDATE_CHECK' || name.startsWith('CONNECTOME_SETUP_');

export function openingMessage(held: boolean, after: 'start' | 'switch'): string {
  const who = 'From setup, not the person:';
  if (after === 'switch') {
    return held ? `${who} they've switched to this conversation, and it picks up where it stopped.`
      : `${who} they've started a new conversation with setup. What setup has done stays on disk, and this ` +
        'conversation doesn\'t hold it.';
  }
  return held ? `${who} they've started setup again, and this conversation picks up where it stopped.`
    : `${who} they've started setup, and this conversation holds nothing yet: what setup did before, if it ran here, ` +
      'stays on disk.';
}

export const REFUSED_TURN = 'The model refused that turn. This can come from anything in the conversation, not only ' +
  'what you just wrote. Try once more; if it refuses again, /session new starts a new conversation with setup\'s ' +
  'agent, and what setup has done stays on disk.';

export function showsItself(tool: string): boolean {
  return tool.startsWith(`${SETUP_MODULE}--`);
}

class Capture {
  private total = 0;
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);

  add(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.head.length < 2 * KEPT_BYTES) {
      this.head = Buffer.concat([this.head, chunk.subarray(0, 2 * KEPT_BYTES - this.head.length)]);
    }
    this.tail = Buffer.concat([this.tail, chunk]);
    if (this.tail.length > KEPT_BYTES) this.tail = this.tail.subarray(this.tail.length - KEPT_BYTES);
  }

  text(secrets: readonly Secret[]): string {
    if (this.total <= 2 * KEPT_BYTES) return shownByName(this.head.toString('utf-8'), secrets);
    const left = (this.total - 2 * KEPT_BYTES).toLocaleString('en-US');
    return `${shownByName(this.head.subarray(0, KEPT_BYTES).toString('utf-8'), secrets)}\n[${left} bytes not shown]\n` +
      shownByName(this.tail.toString('utf-8'), secrets);
  }
}

export class SetupModule implements Module {
  readonly name = SETUP_MODULE;
  finishRequested = false;
  private readonly stored: StoredSecrets;
  private readonly groups = new Set<number>();
  private queue: Promise<unknown> = Promise.resolve();
  private stopping = false;

  constructor(private readonly config: SetupModuleConfig) {
    this.stored = new StoredSecrets(join(config.dir, '.setup'));
  }

  async start(_ctx: ModuleContext): Promise<void> {}

  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.groups].map(endGroup));
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'run',
        description: 'Run one command with bash -c in the install\'s directory, and get back its exit status and ' +
          `output: of an output longer than ${2 * KEPT_BYTES / 1024} KiB, its first and last ${KEPT_BYTES / 1024} KiB. ` +
          'Its environment is the host\'s, less setup\'s own variables, the secrets setup stored and the providers\' ' +
          `keys. Where one of their values appears in the output exactly as stored, it comes back as <NAME>, unless ` +
          `it's shorter than ${SHORT_CHARACTERS} characters. A command still running at its ` +
          'time limit, or when the host stops, is stopped with its process group. A process it leaves running when it ' +
          'ends keeps running, after the host ends too, but setup closes the command\'s output about a second after ' +
          'it ends, so give such a process output of its own, such as > file 2>&1.',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The command line, as bash -c reads it.' },
            timeoutMs: { type: 'number', description: `Its time limit in ms: ${DEFAULT_TIMEOUT_MS} unless given, at most ${MAX_TIMEOUT_MS}.` },
          },
          required: ['command'],
        },
      },
      {
        name: 'ask_secret',
        description: 'Ask the person for a secret in this terminal, with nothing shown as they type, and store it in ' +
          'the install\'s .env. You get back where it was stored, never the value. A DISCORD_TOKEN is checked once ' +
          `with Discord, and an ${Object.keys(PROVIDER_KEYS).join(', ')} with its provider, at the base URL .env names ` +
          'for it if it names one. One that is refused isn\'t stored.',
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
        description: 'Say that setup is finished, once the person has nothing more to set up. The conversation ends ' +
          'when this turn ends, so say whatever is left to say in this same turn.',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    const input = call.input as Record<string, unknown>;
    if (call.name === 'finished') {
      this.finishRequested = true;
      return { success: true, data: 'The conversation ends when this turn ends.' };
    }
    if (call.name !== 'run' && call.name !== 'ask_secret') return unknownToolResult(this, call.name);
    const turn = this.queue.then(() => (call.name === 'run' ? this.run(input) : this.askSecret(input)));
    this.queue = turn.catch(() => {});
    return turn;
  }

  private secrets(): Secret[] {
    return storedSecrets(this.config.dir, this.config.env);
  }

  private async run(input: Record<string, unknown>): Promise<ToolResult> {
    const { command, timeoutMs = DEFAULT_TIMEOUT_MS } = input;
    if (typeof command !== 'string' || command.trim() === '') return failed('run needs a command.');
    if (typeof timeoutMs !== 'number' || !(timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS)) {
      return failed(`run's timeoutMs is a number of ms above 0 and at most ${MAX_TIMEOUT_MS}.`);
    }
    if (this.stopping) return failed('The host is stopping, so run runs nothing.');
    const secrets = this.secrets();
    const hidden = new Set<string>([...PROVIDER_SECRETS, ...this.stored.names()]);
    this.config.show('Setup\'s agent runs:');
    for (const line of shownByName(command, secrets).split('\n')) this.config.show(`  ${shown(line)}`);
    const said = mkdtempSync(join(tmpdir(), 'connectome-setup-said-'));
    const file = join(said, 'said');
    writeFileSync(file, '', { mode: 0o600 });
    const env: Record<string, string> = { [SHOWN_FILE]: file };
    const values = new Set(secrets.map((secret) => secret.value));
    for (const [name, value] of Object.entries(this.config.env)) {
      if (value !== undefined && !hidden.has(name) && !NOT_FOR_COMMANDS(name) && !values.has(value)) env[name] = value;
    }
    try {
      const ran = await this.spawned(command, env, timeoutMs);
      const text = readFileSync(file, 'utf-8');
      if (text !== '') {
        this.config.show('It said:');
        for (const line of shownByName(text, secrets).replace(/\n$/, '').split('\n')) this.config.show(`  ${shown(line)}`);
      }
      return {
        success: true,
        data: { ...ran, stdout: ran.stdout.text(secrets), stderr: ran.stderr.text(secrets) },
      };
    } finally {
      rmSync(said, { recursive: true, force: true });
    }
  }

  private spawned(command: string, env: Record<string, string>, limit: number):
    Promise<{ exitCode: number | null; signal: string | null; stoppedAtLimit: boolean; stdout: Capture; stderr: Capture }> {
    return new Promise((done) => {
      const child = spawn('bash', ['-c', command], { cwd: this.config.dir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout = new Capture();
      const stderr = new Capture();
      child.stdout.on('data', (chunk: Buffer) => stdout.add(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.add(chunk));
      const group = child.pid;
      if (group !== undefined) this.groups.add(group);
      let stoppedAtLimit = false;
      const timer = setTimeout(() => {
        stoppedAtLimit = true;
        if (group !== undefined) void endGroup(group);
      }, limit);
      let finished = false;
      const finish = (exitCode: number | null, signalled: string | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (group !== undefined) this.groups.delete(group);
        child.stdout.destroy();
        child.stderr.destroy();
        done({ exitCode, signal: signalled, stoppedAtLimit, stdout, stderr });
      };
      child.once('error', (error) => {
        stderr.add(Buffer.from(`bash couldn't be started: ${error.message}\n`));
        finish(null, null);
      });
      // A process the command started can hold its output open after the command ends.
      child.once('exit', (code, signalled) => {
        const drained = setTimeout(() => finish(code, signalled), DRAIN_MS);
        child.once('close', () => {
          clearTimeout(drained);
          finish(code, signalled);
        });
      });
    });
  }

  private async askSecret(input: Record<string, unknown>): Promise<ToolResult> {
    const { name, purpose } = input;
    if (typeof name !== 'string' || !isSecretName(name)) {
      return failed('ask_secret needs a name an environment variable can have: letters, digits and _, not starting with a digit.');
    }
    if (typeof purpose !== 'string' || purpose.trim() === '') return failed('ask_secret needs a purpose.');
    const asker = this.config.asker();
    if (asker === null) return failed('There is no terminal here to ask the person on, so nothing was asked.');
    let value: string;
    try {
      value = (await asker.ask(name, shown(shownByName(purpose, this.secrets()))))?.trim() ?? '';
    } catch (error) {
      return failed(`Nothing was asked, so nothing was stored as ${name}: ${(error as Error).message}.`);
    }
    if (value === '') {
      return failed(`Nothing came back from the terminal, so nothing was stored as ${name}. If they declined, ask them ` +
        'in the conversation whether to try again.');
    }
    const unwritable = unwritableValue(value);
    if (unwritable !== null) {
      return failed(`What the person typed for ${name} can't be stored, since ${unwritable}. Nothing was stored.`);
    }
    const envFile = join(this.config.dir, '.env');
    const answer: KeyAnswer | null = name === DISCORD_TOKEN ? await checkDiscordToken(value, this.config.fetch)
      : Object.hasOwn(PROVIDER_KEYS, name) ? await checkProviderKey(name, value, readEnvFile(envFile), this.config.fetch)
        : null;
    if (answer?.kind === 'refused') {
      return failed(`Nothing was stored as ${name}: ${answer.why}. Tell the person, and ask them to copy it again.`);
    }
    this.stored.record(name);
    writeEnvValue(envFile, name, value);
    if (isShort(value)) {
      this.config.show(`What you typed for ${name} is shorter than ${SHORT_CHARACTERS} characters, so setup stores it, ` +
        'and doesn\'t hide it from its agent.');
    }
    const checked = answer === null ? '' : answer.kind === 'accepted' ? '. It was accepted.'
      : `, though whether it works isn't known: ${answer.why}.`;
    return { success: true, data: `Stored as ${name} in ${envFile}${checked}` };
  }
}

function failed(error: string): ToolResult {
  return { success: false, error, isError: true };
}

function signal(group: number, name: NodeJS.Signals): void {
  try {
    process.kill(-group, name);
  } catch {
  }
}

function groupLives(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch {
    return false;
  }
}

async function endGroup(group: number): Promise<void> {
  signal(group, 'SIGTERM');
  for (const until = performance.now() + KILL_GRACE_MS; groupLives(group) && performance.now() < until;) {
    await Bun.sleep(50);
  }
  if (groupLives(group)) signal(group, 'SIGKILL');
}
