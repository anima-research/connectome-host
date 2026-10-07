/** Native CLI evidence is distinct from Framework inference evidence. */
export interface NativeCLIBinding {
  ts: number;
  agentName: string;
  messageId: string;
  messageSha256: string;
  invocationId: string;
  cli: 'claude' | 'codex';
  cliVersion: string;
  requestedModel: string;
  requestedEffort: string;
  nativeModel: string | null;
  nativeEffort: string | null;
  sessionId: string | null;
  threadId: string | null;
  turnId: string | null;
  evidencePath: string;
}

export type NativeCLIEvent = NativeCLIBinding & (
  | { type: 'native-cli:started'; pid: number }
  | { type: 'native-cli:tool-link'; nativeCallId: string; nativeRequestId: string | null;
      toolName: string; frameworkToolUseId: string; resultSuccess: boolean;
      provenance: 'framework.puppetToolCall' }
  | { type: 'native-cli:failure'; reason: string;
      phase: 'admission' | 'protocol' | 'tool' | 'process' | 'cancelled' }
  | { type: 'native-cli:terminal'; outcome: 'completed' | 'failed' | 'cancelled';
      nativeStatus: string | null; finalText: string | null; finalTextSha256: string | null;
      pid: number | null; exitCode: number | null; signal: string | null;
      reaped: boolean; pidAbsent: boolean }
);

/** An ACK for the actual stored original user message, before subprocess dispatch. */
export interface NativeCLIInputReceipt {
  type: 'native-cli:input';
  agentName: string;
  messageId: string;
  messageSha256: string;
}

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, lstatSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { AgentFramework } from '@animalabs/agent-framework';
import type { ProviderAdapter, ProviderResponse, ToolDefinition } from '@animalabs/membrane';
import { validateRecipe, type Recipe } from './recipe.js';

export const nativeCLIEnabled = (recipe: Recipe): boolean => recipe.agent.execution === 'native-cli';
export const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

/** Any accidental Framework inference fails loudly; it never returns a pretend completion. */
export class PassiveNativeCLIAdapter implements ProviderAdapter {
  readonly name = 'passive-native-cli';
  supportsModel(): boolean { return true; }
  async complete(): Promise<ProviderResponse> { throw new Error('Native CLI mode prohibits Framework provider inference.'); }
  async stream(): Promise<ProviderResponse> { throw new Error('Native CLI mode prohibits Framework provider inference.'); }
}

type ObjectValue = Record<string, any>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected protocol object.');
  return value as ObjectValue;
}
function nonempty(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Expected nonempty protocol string.');
  return value;
}
function equal(a: unknown, b: unknown): boolean {
  const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
  return canonical(a) === canonical(b);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // Consumers attach at different native protocol phases; avoid an unhandled rejection in that gap.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

/** Exact overrides qualified against the 0.160.1 native source; no HTTP transport or caps. */
export const CODEX_NATIVE_CONFIG: Readonly<Record<string, unknown>> = Object.freeze({
  'features.shell_tool': false,
  'features.apps': false,
  web_search: 'disabled',
  'tools.update_plan.enabled': false,
  'tools.experimental_request_user_input.enabled': false,
  'features.view_image': false,
  'features.image_generation': false,
  'agents.enabled': false,
  'features.multi_agent_v2': false,
  'features.goals': false,
  'memories.use_memories': false,
  'features.agent_message_board': false,
  'features.token_budget': { enabled: false, use_history_notes_extension: false },
});

export function claudeNativeArgs(systemPrompt: string, model: string, effort: string, sessionId: string,
  endpoint: string, aliases: string[], persistNativeTranscript = false): string[] {
  return ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--restricted', '--setting-sources', '', '--settings', JSON.stringify({ disableAllHooks: true }),
    '--disable-slash-commands', '--tools', '', '--strict-mcp-config', '--mcp-config',
    JSON.stringify({ mcpServers: { connectome: { type: 'http', url: endpoint } } }),
    '--permission-mode', 'dontAsk', ...(aliases.length ? ['--allowed-tools', ...aliases.map(name => `mcp__connectome__${name}`)] : []),
    '--system-prompt', systemPrompt, '--model', model, '--effort', effort, '--session-id', sessionId,
    ...(persistNativeTranscript ? [] : ['--no-session-persistence'])];
}

export function codexNativeArgs(): string[] {
  const toml = (v: unknown): string => typeof v === 'object' && v !== null
    ? `{ ${Object.entries(v).map(([k, x]) => `${k} = ${toml(x)}`).join(', ')} }` : JSON.stringify(v);
  return ['app-server', ...Object.entries(CODEX_NATIVE_CONFIG).flatMap(([k, v]) => ['-c', `${k}=${toml(v)}`])];
}

/** Refuse inherited contributors; an empty table override does not prove it cleared inherited tables. */
export function assertCodexClosedConfig(config: unknown, helperProjectionAttested = false): void {
  const c = object(config);
  for (const [path, expected] of Object.entries(CODEX_NATIVE_CONFIG)) {
    const actual = c[path] ?? path.split('.').reduce((value, key) => value?.[key], c);
    // The pinned ConfigReadResponse ToolsV2 omits these supported ToolsToml controls.
    if (helperProjectionAttested && actual === undefined && ['tools.update_plan.enabled', 'tools.experimental_request_user_input.enabled'].includes(path)) continue;
    if (!equal(actual, expected)) throw new Error(`Native Codex effective control is not qualified: ${path}.`);
  }
  for (const key of helperProjectionAttested ? ['capability_roots'] : ['mcp_servers', 'plugins', 'capability_roots']) {
    const value = c[key];
    if (value != null && (Array.isArray(value) ? value.length : Object.keys(object(value)).length)) {
      throw new Error(`Native Codex inherited ${key} is not closed.`);
    }
  }
  if (c.apps != null) {
    const apps = object(c.apps);
    if (Object.values(apps).some(v => v != null && object(v).enabled !== false)) {
      throw new Error('Native Codex inherited apps are not closed.');
    }
  }
  for (const key of ['browser_use', 'computer_use']) {
    if (c[key] != null && Object.keys(object(c[key])).length) throw new Error(`Native Codex inherited ${key} is not closed.`);
  }
}

interface Qualification {
  report: ObjectValue;
  files: Array<{ path: string; sha256: string }>;
  instructionSources: Array<{ path: string; sha256: string }>;
  recipeFile?: { path: string; sha256: string };
}

function readFrozen(path: unknown, hash: unknown): Buffer {
  const p = nonempty(path);
  if (!/^[a-f0-9]{64}$/.test(nonempty(hash)) || resolve(p) !== p || realpathSync(p) !== p ||
      !lstatSync(p).isFile()) throw new Error('Native CLI qualification requires canonical regular frozen files.');
  const bytes = readFileSync(p);
  if (sha256(bytes) !== hash) throw new Error('Native CLI qualification file hash drift.');
  return bytes;
}

export function readNativeCLIQualification(recipe: Recipe, agentName: string, recipeSource?: string): Qualification {
  const path = process.env.CONNECTOME_NATIVE_CLI_QUALIFICATION_PATH;
  const hash = process.env.CONNECTOME_NATIVE_CLI_QUALIFICATION_SHA256;
  if (!path || !hash) throw new Error('Native CLI qualification is missing: the trusted current qualifier must supply the frozen report path and hash.');
  const report = object(JSON.parse(readFrozen(path, hash).toString('utf8')));
  const rawRecipe = recipeSource ? object(JSON.parse(readFileSync(recipeSource, 'utf8'))) : recipe;
  const rawHash = sha256(JSON.stringify(rawRecipe, null, 2));
  const validated = validateRecipe(JSON.parse(JSON.stringify(rawRecipe)));
  const cli = recipe.agent.provider === 'anthropic' ? 'claude' : 'codex';
  const effort = cli === 'claude' ? recipe.agent.thinking?.effort : recipe.agent.responses?.reasoningEffort;
  if (!equal(validated, recipe) || report.qualified !== true || report.instance !== agentName ||
      report.recipeSha256 !== rawHash || report.cli !== cli || report.cliVersion !== (cli === 'claude' ? '2.1.291' : '0.160.1') ||
      report.interface !== (cli === 'claude' ? 'claude-print-stream-json' : 'codex-app-server-stdio') ||
      report.loginMode !== (cli === 'claude' ? 'claude.ai' : 'chatgpt') || report.model !== recipe.agent.model || report.effort !== effort ||
      !report.binding || !report.role || !report.runtime) throw new Error('Native CLI current qualification binding is missing or conflicting.');
  const files = [{ path: nonempty(path), sha256: nonempty(hash) }];
  for (const key of ['installedConfig', 'toolClosure', 'protocol', 'lifecycle']) {
    const ref = object(object(report.proofs)[key]);
    if (nonempty(ref.path) !== join(dirname(nonempty(path)), `native-cli-${key}.json`)) throw new Error('Native CLI qualification proof is outside current staged evidence.');
    readFrozen(ref.path, ref.sha256);
    files.push({ path: nonempty(ref.path), sha256: nonempty(ref.sha256) });
  }
  if (new Set(files.map(file => file.path)).size !== 5) throw new Error('Native CLI qualification proof paths conflict.');
  const installedRef = object(object(report.proofs).installedConfig);
  const installedConfig = object(JSON.parse(readFrozen(installedRef.path, installedRef.sha256).toString('utf8')));
  const sourceRefs = cli === 'codex' && installedConfig.nativeInstructionSources !== undefined ? installedConfig.nativeInstructionSources : [];
  if (!Array.isArray(sourceRefs)) throw new Error('Native Codex instruction sources qualification is malformed.');
  const instructionSources = sourceRefs.map(value => {
    const ref = object(value);
    readFrozen(ref.path, ref.sha256);
    return { path: nonempty(ref.path), sha256: nonempty(ref.sha256) };
  });
  if (new Set(instructionSources.map(file => file.path)).size !== instructionSources.length) throw new Error('Native Codex instruction sources qualification has duplicates.');
  let recipeFile: Qualification['recipeFile'];
  if (recipeSource) {
    const recipePath = resolve(recipeSource);
    const recipeHash = sha256(readFileSync(recipePath));
    readFrozen(recipePath, recipeHash);
    recipeFile = { path: recipePath, sha256: recipeHash };
  }
  return { report, files, instructionSources, recipeFile };
}

interface PublicClaudeAssistant {
  uuid: string;
  messageId: string;
  model: string;
  content: unknown[];
}

function assertUnambiguousPath(path: string): void {
  if (resolve(path) !== path) throw new Error('Native transcript path is not absolute and canonical.');
  for (let cursor = path; ; cursor = dirname(cursor)) {
    try { if (lstatSync(cursor).isSymbolicLink()) throw new Error('Native transcript path has a symlink.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (dirname(cursor) === cursor) break;
  }
}

export function nativeClaudeTranscriptPath(installedConfig: unknown, cwd: string, binary: string,
  binaryHash: string, invocationId: string): string {
  const descriptor = object(object(installedConfig).nativeTranscript);
  if (descriptor.cwd !== cwd || realpathSync(cwd) !== cwd || descriptor.cliBinaryPath !== binary ||
      descriptor.cliBinarySha256 !== binaryHash || descriptor.cliVersion !== '2.1.291') {
    throw new Error('Native Claude transcript provenance is unqualified or conflicting.');
  }
  const projectDir = nonempty(descriptor.projectDir);
  assertUnambiguousPath(projectDir);
  const path = join(projectDir, `${invocationId}.jsonl`);
  try { lstatSync(path); throw new Error('Native Claude transcript invocation path is not fresh.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return path;
}

/** Verify full owned single-block correspondence, actual effort and persisted native final. */
export function nativeClaudeEffort(bytes: string, sessionId: string, frames: PublicClaudeAssistant[], finalText: string): string {
  const rows = bytes.trimEnd().split('\n').map(line => object(JSON.parse(line)));
  const assistants = rows.filter(row => row.type === 'assistant');
  if (!frames.length || assistants.length !== frames.length || new Set(assistants.map(row => row.uuid)).size !== assistants.length) {
    throw new Error('Native Claude effort evidence has missing, duplicate or unqualified grouped assistant entries.');
  }
  const efforts = new Set<string>();
  for (const [index, frame] of frames.entries()) {
    const row = assistants[index];
    const message = row ? object(row.message) : null;
    if (!row || row.uuid !== frame.uuid || row.sessionId !== sessionId || !message || message.id !== frame.messageId || message.role !== 'assistant' ||
        message.model !== frame.model || !Array.isArray(message.content) || message.content.length !== 1 ||
        frame.content.length !== 1 || !equal(message.content, frame.content) || row.isSidechain !== false) {
      throw new Error('Native Claude effort evidence does not exactly match the owned public assistant frame.');
    }
    const effort = nonempty(row.effort);
    if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error('Native Claude actual effort is unqualified.');
    efforts.add(effort);
  }
  if (efforts.size !== 1) throw new Error('Native Claude actual efforts conflict across assistant frames.');
  const final = object(assistants.at(-1)!.message);
  const block = object(final.content[0]);
  if (final.stop_reason !== 'end_turn' || block.type !== 'text' || nonempty(block.text) !== nonempty(finalText)) {
    throw new Error('Native Claude persisted final is missing, partial or contradictory.');
  }
  return [...efforts][0];
}

interface FrozenInput {
  messageId: string;
  messageSha256: string;
  message: ObjectValue;
  text: string[];
  systemPrompt: string;
  tools: ToolDefinition[];
  model: string;
  effort: string;
}

/** One owned CLI invocation consumes one admitted original message; no automatic retry or replay. */
export class NativeCLIHost {
  private readonly listeners = new Set<(event: NativeCLIEvent) => void>();
  private readonly seen = new Set<string>();
  private active: { child: ChildProcessWithoutNullStreams | null; cancel: () => void; done: Promise<void> } | null = null;
  private stopped = false;
  private readonly unsubscribe: () => void;
  private readonly qualification: Qualification;
  constructor(private readonly framework: AgentFramework, private readonly recipe: Recipe,
    private readonly agentName: string, private readonly dataDir: string, recipeSource?: string) {
    if (!nativeCLIEnabled(recipe)) throw new Error('Native CLI host requires explicit execution selection.');
    this.qualification = readNativeCLIQualification(recipe, agentName, recipeSource);
    if (this.boundAgent().systemPrompt !== recipe.agent.systemPrompt) throw new Error('Native CLI bound system prompt differs from qualified recipe.');
    this.unsubscribe = framework.onTrace(event => {
      if (event.type !== 'message:added' || !['mcpl:channel-incoming', 'mcpl:push-event'].includes(event.source)) return;
      const agent = framework.getAgent(agentName);
      const message = agent?.getContextManager().getMessage(event.messageId);
      if (!message || message.participant !== 'user' || message.metadata?.triggered !== true ||
          !Array.isArray(message.metadata?.tags) || !message.metadata.tags.includes('chat:addressed')) return;
      try { this.submit(event.messageId); } catch (error) { console.error(`Native CLI input refused: ${String(error)}`); }
    });
  }
  get isBusy(): boolean { return this.active !== null; }
  onEvent(listener: (event: NativeCLIEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  publishInput(content: string): NativeCLIInputReceipt {
    if (typeof content !== 'string' || !content.length) throw new Error('Native CLI original input must be nonempty text.');
    this.assertIdle();
    const agent = this.boundAgent();
    const id = agent.getContextManager().addMessage('user', [{ type: 'text', text: content }], {
      source: 'headless', triggered: true, tags: ['chat:addressed'],
    });
    return this.submit(id);
  }
  private boundAgent() {
    const agent = this.framework.getAgent(this.agentName);
    if (!agent || this.framework.getAllAgents().length !== 1) throw new Error('Native CLI requires the bound single resident.');
    return agent;
  }
  private assertIdle(): void {
    if (this.stopped || this.active) throw new Error('Native CLI input refused while stopped or busy.');
    if (this.boundAgent().state.status !== 'idle') throw new Error('Native CLI bound resident is not idle.');
  }
  private submit(messageId: string): NativeCLIInputReceipt {
    this.assertIdle();
    if (this.seen.has(messageId)) throw new Error('Native CLI refuses duplicate original input.');
    const agent = this.boundAgent();
    const original = agent.getContextManager().getMessage(messageId);
    if (!original || original.participant !== 'user') throw new Error('Native CLI original stored user message is absent.');
    const message = JSON.parse(JSON.stringify(original)) as ObjectValue;
    if (!Array.isArray(message.content) || !message.content.length ||
        message.content.some((b: unknown) => object(b).type !== 'text' || typeof object(b).text !== 'string')) {
      throw new Error('Native CLI only supports complete original text input.');
    }
    const model = nonempty(this.recipe.agent.model);
    const effort = nonempty(this.recipe.agent.provider === 'anthropic'
      ? this.recipe.agent.thinking?.effort : this.recipe.agent.responses?.reasoningEffort);
    const frozen: FrozenInput = { messageId, message, messageSha256: sha256(JSON.stringify(message)),
      text: message.content.map((b: ObjectValue) => b.text), systemPrompt: agent.systemPrompt,
      tools: this.framework.getAllTools().filter(tool => agent.canUseTool(tool.name)), model, effort };
    this.seen.add(messageId);
    const cancel = deferred<void>();
    const owned = { child: null as ChildProcessWithoutNullStreams | null, cancel: () => cancel.resolve(), done: Promise.resolve() };
    this.active = owned;
    owned.done = this.run(frozen, owned, cancel.promise).finally(() => { if (this.active === owned) this.active = null; });
    void owned.done.catch(error => console.error(`Native CLI failed: ${String(error)}`));
    return { type: 'native-cli:input', agentName: this.agentName, messageId, messageSha256: frozen.messageSha256 };
  }
  async waitForIdle(): Promise<void> { await this.active?.done; }
  async cancelActive(): Promise<void> {
    const active = this.active;
    if (active) { active.cancel(); await active.done; }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe();
    await this.cancelActive();
  }
  private recheck(input: FrozenInput): void {
    for (const file of [...this.qualification.files, ...this.qualification.instructionSources]) readFrozen(file.path, file.sha256);
    if (this.qualification.recipeFile) readFrozen(this.qualification.recipeFile.path, this.qualification.recipeFile.sha256);
    const agent = this.boundAgent();
    const message = agent.getContextManager().getMessage(input.messageId);
    if (!message || sha256(JSON.stringify(message)) !== input.messageSha256 || agent.systemPrompt !== input.systemPrompt ||
        this.recipe.agent.model !== input.model ||
        (this.recipe.agent.provider === 'anthropic' ? this.recipe.agent.thinking?.effort : this.recipe.agent.responses?.reasoningEffort) !== input.effort) {
      throw new Error('Native CLI original input, bound role, model or effort drifted.');
    }
    if (!equal(this.framework.getAllTools().filter(tool => agent.canUseTool(tool.name)), input.tools)) {
      throw new Error('Native CLI admitted tool surface drifted.');
    }
  }
  private async run(input: FrozenInput, owned: NonNullable<NativeCLIHost['active']>, cancellation: Promise<void>): Promise<void> {
    const cli = this.recipe.agent.provider === 'anthropic' ? 'claude' : 'codex';
    const invocationId = randomUUID();
    const evidencePath = `native-cli.${invocationId}.jsonl`;
    mkdirSync(resolve(this.dataDir), { recursive: true });
    const evidence = join(resolve(this.dataDir), evidencePath);
    const binding: NativeCLIBinding = { ts: Date.now(), agentName: this.agentName, messageId: input.messageId,
      messageSha256: input.messageSha256, invocationId, cli, cliVersion: '', requestedModel: input.model,
      requestedEffort: input.effort, nativeModel: null, nativeEffort: null, sessionId: null, threadId: null, turnId: null, evidencePath };
    const record = (row: ObjectValue) => appendFileSync(evidence, `${JSON.stringify({ ts: Date.now(), ...row })}\n`);
    const emit = (event: NativeCLIEvent) => { record({ direction: 'event', event }); for (const listener of this.listeners) listener(event); };
    record({ direction: 'qualification-binding', report: this.qualification.report, files: this.qualification.files, instructionSources: this.qualification.instructionSources });
    record({ direction: 'binding', input: input.message, systemPrompt: input.systemPrompt, tools: input.tools });
    let nativeStatus: string | null = null;
    let bridge: ReturnType<typeof Bun.serve> | null = null;
    const declarations = new Map<string, { alias: string; input: unknown }>();
    const declarationChanged = new Set<() => void>();
    const requestIds = new Set<string>();
    let finalText: string | null = null;
    let nativeTranscriptPath: string | null = null;
    const publicClaudeAssistants: PublicClaudeAssistant[] = [];
    const state = { failure: null as Error | null, exit: null as { code: number | null; signal: string | null } | null };
    const pending = new Map<number, ReturnType<typeof deferred<ObjectValue>>>();
    let cancelled = false;
    let queryProcess: ReturnType<typeof Bun.spawn> | null = null;
    let child: ChildProcessWithoutNullStreams | null = null;
    const terminal = deferred<void>();
    let processing = Promise.resolve();
    let turnStarted = false;
    const calls = new Set<string>();
    const completedCalls = new Set<string>();
    const bridgeTools = new Set<Promise<unknown>>();
    const aliases = new Map(input.tools.map((tool, i) => [`tool_${i}`, tool]));
    const fail = (error: unknown) => {
      if (state.failure) return;
      state.failure = error instanceof Error ? error : new Error(String(error));
      terminal.reject(state.failure);
      for (const wake of declarationChanged) wake();
      for (const wait of pending.values()) wait.reject(state.failure);
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    void cancellation.then(() => {
      cancelled = true; queryProcess?.kill('SIGKILL'); fail(new Error('Native CLI invocation cancelled.'));
    });
    const dispatch = async (nativeCallId: string, nativeRequestId: string | null, alias: string, value: unknown) => {
      if (state.failure || cancelled || finalText !== null || calls.has(nativeCallId)) throw new Error('Native tool call is duplicate, late or cancelled.');
      const tool = aliases.get(alias);
      if (!tool) throw new Error('Native CLI requested an unauthorized tool.');
      const args = object(value);
      calls.add(nativeCallId);
      this.recheck(input);
      const result = await this.framework.puppetToolCall(this.agentName, tool.name, args);
      record({ direction: 'framework', nativeCallId, nativeRequestId, toolName: tool.name, input: args, ...result });
      this.recheck(input);
      if (state.failure || cancelled) throw new Error('Native tool settled after cancellation or protocol failure.');
      emit({ ...binding, ts: Date.now(), type: 'native-cli:tool-link', nativeCallId, nativeRequestId,
        toolName: tool.name, frameworkToolUseId: result.toolUseId, resultSuccess: result.result.success,
        provenance: 'framework.puppetToolCall' });
      completedCalls.add(nativeCallId);
      return result.result;
    };
    try {
      for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL']) {
        if (process.env[key]) throw new Error(`Native CLI refuses an alternate provider/authentication route: ${key}.`);
      }
      const installedRef = this.qualification.report.proofs.installedConfig;
      const installedConfig = object(JSON.parse(readFrozen(installedRef.path, installedRef.sha256).toString('utf8')));
      const nativeBinary = object(installedConfig.nativeBinary);
      const binary = nonempty(nativeBinary.path);
      const binaryHash = nonempty(nativeBinary.sha256);
      readFrozen(binary, binaryHash);
      const configured = process.env[cli === 'claude' ? 'CLAUDE_BINARY' : 'CODEX_BINARY'];
      if (configured && realpathSync(configured) !== binary) throw new Error('Native executable conflicts with qualified binary identity.');
      const version = Bun.spawn([binary, '--version'], { stdout: 'pipe', stderr: 'pipe' });
      queryProcess = version;
      const [versionText, versionCode] = await Promise.all([new Response(version.stdout).text(), version.exited]);
      queryProcess = null;
      if (cancelled) throw new Error('Native CLI invocation cancelled.');
      binding.cliVersion = cli === 'claude' ? '2.1.291' : '0.160.1';
      if (versionCode !== 0 || !versionText.includes(binding.cliVersion)) throw new Error('Native CLI version is not qualified.');
      this.recheck(input);
      readFrozen(binary, binaryHash);
      record({ direction: 'qualification', binary, binaryHash, version: versionText });
      let args: string[];
      if (cli === 'claude') {
        nativeTranscriptPath = nativeClaudeTranscriptPath(installedConfig,
          process.cwd(), binary, binaryHash, invocationId);
        const auth = Bun.spawn([binary, 'auth', 'status', '--json'], { stdout: 'pipe', stderr: 'pipe' });
        queryProcess = auth;
        const [statusText, statusCode] = await Promise.all([new Response(auth.stdout).text(), auth.exited]);
        queryProcess = null;
        if (cancelled) throw new Error('Native CLI invocation cancelled.');
        const status = object(JSON.parse(statusText));
        if (statusCode !== 0 || status.loggedIn !== true || status.authMethod !== 'claude.ai') {
          throw new Error('Native Claude requires its existing subscription login, not API billing.');
        }
        record({ direction: 'auth-mode', loggedIn: true, authMethod: 'claude.ai', subscriptionType: status.subscriptionType });
        this.recheck(input);
        const endpoint = `/${randomUUID()}`;
        const session = randomUUID();
        let initialized = false;
        bridge = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
          try {
            const url = new URL(request.url);
            if (url.hostname !== '127.0.0.1' || url.pathname !== endpoint ||
                (request.headers.get('origin') && request.headers.get('origin') !== url.origin)) {
              throw new Error('Foreign or unsupported native MCP request.');
            }
            if (initialized && request.headers.get('mcp-session-id') !== session) throw new Error('Foreign native MCP session.');
            if (request.method === 'GET' && initialized) return new Response(null, { status: 405 });
            if (request.method !== 'POST') throw new Error('Foreign or unsupported native MCP request.');
            const raw = await request.text();
            record({ direction: 'mcp-in', raw });
            const msg = object(JSON.parse(raw));
            if (msg.jsonrpc !== '2.0') throw new Error('Malformed native MCP envelope.');
            const method = nonempty(msg.method);
            if (!initialized && method === 'server/discover') {
              if (request.headers.has('mcp-session-id')) throw new Error('Foreign native MCP discovery session.');
              const id = msg.id;
              if ((typeof id !== 'string' && typeof id !== 'number') || requestIds.has(String(id))) throw new Error('Duplicate or missing native MCP request ID.');
              requestIds.add(String(id));
              const response = { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
              record({ direction: 'mcp-out', response });
              return Response.json(response);
            }
            if (!initialized && method !== 'initialize') throw new Error('Reordered native MCP initialization.');
            if (method === 'notifications/initialized') return new Response(null, { status: 202 });
            const id = msg.id;
            if ((typeof id !== 'string' && typeof id !== 'number') || requestIds.has(String(id))) throw new Error('Duplicate or missing native MCP request ID.');
            requestIds.add(String(id));
            let result: unknown;
            if (method === 'initialize') {
              if (initialized) throw new Error('Duplicate native MCP initialization.');
              const protocolVersion = nonempty(object(msg.params).protocolVersion);
              if (!['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(protocolVersion)) throw new Error('Unqualified native MCP protocol version.');
              initialized = true;
              result = { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'connectome', version: '1' } };
            } else if (method === 'tools/list') {
              result = { tools: [...aliases].map(([name, tool]) => ({ name, description: tool.description, inputSchema: tool.inputSchema })) };
            } else if (method === 'tools/call') {
              if (!initialized) throw new Error('Native MCP tool before initialization.');
              const params = object(msg.params);
              const waitForDeclaration = async () => {
                while (!state.failure && !nativeStatus && ![...declarations].some(([id]) => !calls.has(id))) {
                  await new Promise<void>(wake => { declarationChanged.add(wake); });
                }
                if (state.failure || nativeStatus) throw new Error('Native tool has no owned declaration.');
              };
              await waitForDeclaration();
              const declaration = [...declarations].find(([id]) => !calls.has(id));
              if (!declaration || declaration[1].alias !== params.name || !equal(declaration[1].input, params.arguments)) {
                throw new Error('Native MCP tool request is reordered or differs from genuine assistant declaration.');
              }
              const work = dispatch(declaration[0], String(id), nonempty(params.name), params.arguments);
              bridgeTools.add(work);
              const toolResult = await work.finally(() => bridgeTools.delete(work));
              result = { content: [{ type: 'text', text: JSON.stringify(toolResult) }], isError: !toolResult.success };
            } else throw new Error(`Unadmitted native MCP method: ${method}.`);
            record({ direction: 'mcp-out', response: { jsonrpc: '2.0', id, result } });
            return Response.json({ jsonrpc: '2.0', id, result }, { headers: { 'mcp-session-id': session } });
          } catch (error) { fail(error); return Response.json({ error: 'Native MCP request refused.' }, { status: 403 }); }
        } });
        binding.sessionId = invocationId;
        args = claudeNativeArgs(input.systemPrompt, input.model, input.effort, invocationId,
          `http://127.0.0.1:${bridge.port}${endpoint}`, [...aliases.keys()], true);
      } else { args = codexNativeArgs(); }
      this.recheck(input);
      readFrozen(binary, binaryHash);
      child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: process.cwd(), env: process.env });
      owned.child = child;
      child.stdin.on('error', fail);
      if (!child.pid) throw new Error('Native CLI process did not spawn.');
      emit({ ...binding, ts: Date.now(), type: 'native-cli:started', pid: child.pid });
      const exited = new Promise<void>(resolveExit => {
        child!.on('error', fail);
        child!.on('close', (code, signal) => { state.exit = { code, signal }; resolveExit(); if (!nativeStatus) fail(new Error('Native CLI exited without a terminal event.')); });
      });
      child.stderr.on('data', bytes => record({ direction: 'stderr', raw: bytes.toString('utf8'), rawBase64: bytes.toString('base64') }));
      let nextId = 0;
      const send = (value: unknown) => {
        const raw = `${JSON.stringify(value)}\n`;
        record({ direction: 'stdin', raw });
        child!.stdin.write(raw, error => { if (error) fail(error); });
      };
      const requestMethods = new Map<number, string>();
      const request = (method: string, params: unknown) => {
        const id = ++nextId; const wait = deferred<ObjectValue>(); pending.set(id, wait); requestMethods.set(id, method);
        send({ id, method, params }); return wait.promise;
      };
      let buffer = '';
      const decoder = new StringDecoder('utf8');
      let claudeFinal: string | null = null;
      let claudePublicEndTurn = false;
      let nativePluginIds: string[] | null = null;
      const handle = async (value: unknown) => {
        const msg = object(value);
        if (cli === 'claude') {
          if (msg.session_id !== binding.sessionId) throw new Error('Foreign native Claude session.');
          if (msg.type === 'system' && msg.subtype === 'init') {
            binding.nativeModel = nonempty(msg.model);
            if (binding.nativeModel !== input.model) throw new Error('Native Claude model drift.');
          } else if (msg.type === 'system' && msg.subtype === 'thinking_tokens') {
            nonempty(msg.uuid);
            if (!Number.isInteger(msg.estimated_tokens) || !Number.isInteger(msg.estimated_tokens_delta) ||
                (msg.user_message_uuid !== undefined && typeof msg.user_message_uuid !== 'string')) {
              throw new Error('Malformed native Claude thinking token metadata.');
            }
          } else if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
            const metadata = object(msg.compact_metadata);
            nonempty(msg.uuid);
            if (binding.nativeModel === null || nativeStatus || !['manual', 'auto'].includes(metadata.trigger) ||
                !Number.isInteger(metadata.pre_tokens) || metadata.pre_tokens < 0) throw new Error('Malformed native Claude compact boundary.');
          } else if (msg.type === 'rate_limit_event') {
            nonempty(msg.uuid);
            const info = object(msg.rate_limit_info);
            if (!['allowed', 'allowed_warning', 'rejected'].includes(info.status)) throw new Error('Malformed native Claude rate-limit status.');
          } else if (msg.type === 'assistant') {
            const message = object(msg.message);
            if (nativeStatus || claudePublicEndTurn || binding.nativeModel === null || message.model !== binding.nativeModel || message.role !== 'assistant' || !Array.isArray(message.content)) {
              throw new Error('Native Claude assistant binding is malformed.');
            }
            publicClaudeAssistants.push({ uuid: nonempty(msg.uuid), messageId: nonempty(message.id), model: nonempty(message.model), content: message.content });
            for (const value of message.content) {
              const block = object(value);
              if (block.type === 'tool_use') {
                const id = nonempty(block.id);
                const name = nonempty(block.name);
                if (declarations.has(id) || !name.startsWith('mcp__connectome__') || !aliases.has(name.slice('mcp__connectome__'.length))) {
                  throw new Error('Native Claude duplicate or unauthorized tool declaration.');
                }
                declarations.set(id, { alias: name.slice('mcp__connectome__'.length), input: object(block.input) });
                for (const wake of declarationChanged) wake(); declarationChanged.clear();
              } else if (!['text', 'thinking'].includes(block.type)) throw new Error('Unqualified native Claude assistant block.');
            }
            claudePublicEndTurn = message.stop_reason === 'end_turn';
            claudeFinal = (message.stop_reason === null || claudePublicEndTurn) && message.content.length === 1 &&
              message.content[0].type === 'text' ? nonempty(message.content[0].text) : null;
          } else if (msg.type === 'result') {
            if (nativeStatus || msg.subtype !== 'success' || msg.is_error !== false || claudeFinal === null ||
                msg.result !== claudeFinal || [...declarations.keys()].some(id => !completedCalls.has(id))) {
              throw new Error('Native Claude result is partial, contradictory or has unlinked tools.');
            }
            nativeStatus = msg.subtype; finalText = nonempty(msg.result); terminal.resolve();
            for (const wake of declarationChanged) wake();
          } else if (!['user', 'stream_event'].includes(msg.type)) throw new Error('Unqualified native Claude event.');
          return;
        }
        if (msg.method === undefined) {
          const wait = pending.get(msg.id);
          if (!wait) throw new Error('Unowned or duplicate native response.');
          pending.delete(msg.id);
          if (msg.error !== undefined) wait.reject(new Error(JSON.stringify(msg.error)));
          else wait.resolve(object(msg.result));
          return;
        }
        const method = nonempty(msg.method);
        const p = object(msg.params);
        if (msg.id !== undefined) {
          if (method !== 'item/tool/call') throw new Error(`Native external request refused: ${method}.`);
          if (p.threadId !== binding.threadId || p.turnId !== binding.turnId || p.namespace !== null) {
            throw new Error('Native dynamic tool request has foreign thread, turn or namespace.');
          }
          const result = await dispatch(nonempty(p.callId), String(msg.id), nonempty(p.tool), p.arguments);
          send({ id: msg.id, result: { success: result.success,
            contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] } });
          return;
        }
        if (method === 'remoteControl/status/changed') {
          if (p.status !== 'disabled') throw new Error('Native remote control is not disabled.');
        } else if (method === 'account/updated') {
          if (p.authMode !== 'chatgpt') throw new Error('Native account authentication mode drift.');
        } else if (method === 'thread/settings/updated') {
          const settings = object(p.threadSettings);
          const sandbox = object(settings.sandboxPolicy);
          if (binding.threadId === null || p.threadId !== binding.threadId || settings.model !== input.model ||
              settings.modelProvider !== 'openai' || settings.effort !== input.effort || settings.approvalPolicy !== 'never' ||
              sandbox.type !== 'readOnly' || sandbox.networkAccess !== false || nativePluginIds === null ||
              !Array.isArray(settings.disabledPluginIds) || !equal(settings.disabledPluginIds, nativePluginIds)) {
            throw new Error('Native thread settings are foreign or drifted from the qualified controls.');
          }
        } else if (method === 'thread/tokenUsage/updated') {
          if (binding.threadId === null || binding.turnId === null || p.threadId !== binding.threadId || p.turnId !== binding.turnId) {
            throw new Error('Native token usage has foreign thread or turn.');
          }
          object(p.tokenUsage);
        } else if (method === 'turn/started') {
          if (turnStarted) throw new Error('Duplicate native turn start.');
          turnStarted = true;
          if (p.threadId !== binding.threadId) throw new Error('Native turn started on a foreign thread.');
          const id = nonempty(object(p.turn).id);
          if (binding.turnId && binding.turnId !== id) throw new Error('Native turn identity drift.');
          binding.turnId = id;
        } else if (method === 'item/started' || method === 'item/completed') {
          if (p.threadId !== binding.threadId || p.turnId !== binding.turnId) throw new Error('Native item has foreign thread or turn.');
          const item = object(p.item);
          if (!['userMessage', 'agentMessage', 'reasoning', 'dynamicToolCall'].includes(item.type)) {
            throw new Error(`Native external capability item refused: ${item.type}.`);
          }
          if (method === 'item/completed' && item.type === 'agentMessage' && item.phase === 'final_answer') {
            if (finalText !== null) throw new Error('Duplicate native final answer.');
            finalText = nonempty(item.text);
          }
        } else if (method === 'turn/completed') {
          if (nativeStatus || p.threadId !== binding.threadId || object(p.turn).id !== binding.turnId) {
            throw new Error('Native terminal is duplicate or foreign.');
          }
          nativeStatus = nonempty(object(p.turn).status);
          if (nativeStatus !== 'completed' || object(p.turn).error != null || finalText === null) {
            throw new Error('Native turn is partial, failed, or lacks a genuine final answer.');
          }
          terminal.resolve();
        } else if (method === 'error') throw new Error('Native protocol reported an error.');
        else if (!['thread/started', 'thread/status/changed', 'item/agentMessage/delta', 'item/reasoning/textDelta',
          'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded', 'account/rateLimits/updated'].includes(method)) {
          throw new Error(`Unqualified native notification refused: ${method}.`);
        }
      };
      child.stdout.on('data', bytes => {
        buffer += decoder.write(bytes);
        let newline: number;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          let value: unknown;
          try { value = JSON.parse(line); } catch (error) { record({ direction: 'stdout', raw: `${line}\n` }); fail(error); continue; }
          try {
          const parsed = object(value);
          if (parsed.method === undefined && requestMethods.get(parsed.id) === 'config/read') {
            const config = object(object(parsed.result).config);
            record({ direction: 'configuration', rawSha256: sha256(`${line}\n`), controls:
              Object.fromEntries(Object.keys(CODEX_NATIVE_CONFIG).map(path => [path, config[path] ?? path.split('.').reduce((v, k) => v?.[k], config)])) });
          } else record({ direction: 'stdout', raw: `${line}\n` });
          // Responses unblock the sequential native notification/request handler.
          if (object(value).method === undefined) { void handle(value).catch(fail); }
          else processing = processing.then(() => { if (!state.failure) return handle(value); }).catch(fail);
          } catch (error) { fail(error); }
        }
      });
      if (cli === 'claude') {
        send({ type: 'user', session_id: binding.sessionId, message: { role: 'user', content: input.text.map(text => ({ type: 'text', text })) } });
        child.stdin.end();
        await terminal.promise;
        await processing;
      } else {
      const initialization = await Promise.race([request('initialize', { clientInfo: { name: 'connectome-host', version: '0.9.0' },
        capabilities: { experimentalApi: true, requestAttestation: false } }), terminal.promise.then(() => { throw new Error('Premature terminal.'); })]);
      record({ direction: 'initialization', result: initialization });
      send({ method: 'initialized' });
      const account = await request('account/read', { refreshToken: false });
      // Native owns authentication. This public response contains no provider token.
      if (object(account.account).type !== 'chatgpt') throw new Error('Native Codex requires its existing ChatGPT login, not API billing.');
      record({ direction: 'auth-mode', type: 'chatgpt' });
      const config = await request('config/read', { includeLayers: false });
      // The current trusted source/protocol qualification attests the two omitted ToolsV2 fields;
      // both false overrides remain in the exact recorded native requests.
      assertCodexClosedConfig(config.config, true);
      const inherited = object(config.config);
      const serverNames = Object.keys(inherited.mcp_servers == null ? {} : object(inherited.mcp_servers));
      const pluginIds = Object.keys(inherited.plugins == null ? {} : object(inherited.plugins));
      nativePluginIds = pluginIds;
      const suppression = {
        mcp_servers: Object.fromEntries(serverNames.map(name => [name, { enabled: false }])),
        plugins: Object.fromEntries(pluginIds.map(id => [id, { enabled: false }])),
      };
      record({ direction: 'contributor-suppression', serverNames, pluginIds, suppression });
      const started = await request('thread/start', { model: input.model, modelProvider: 'openai', allowProviderModelFallback: false,
        baseInstructions: input.systemPrompt, ephemeral: true, environments: [], selectedCapabilityRoots: [],
        approvalPolicy: 'never', sandbox: 'read-only', config: { ...CODEX_NATIVE_CONFIG, ...suppression, model_reasoning_effort: input.effort },
        dynamicTools: [...aliases].map(([name, tool]) => ({ type: 'function', name, description: tool.description, inputSchema: tool.inputSchema })) });
      binding.threadId = nonempty(object(started.thread).id);
      binding.nativeModel = nonempty(started.model);
      binding.nativeEffort = typeof started.reasoningEffort === 'string' ? started.reasoningEffort : null;
      if (binding.nativeModel !== input.model || started.modelProvider !== 'openai' ||
          binding.nativeEffort !== input.effort) throw new Error('Native Codex model drift.');
      if (!Array.isArray(started.instructionSources) || !equal(started.instructionSources, this.qualification.instructionSources.map(file => file.path))) {
        throw new Error('Native Codex instruction sources differ from current qualification.');
      }
      record({ direction: 'native-instruction-sources', threadId: binding.threadId, instructionSources: started.instructionSources });
      this.recheck(input);
      let cursor: string | null = null;
      const cursors = new Set<string>();
      const statuses = new Set<string>();
      do {
        const page = await request('mcpServerStatus/list', { threadId: binding.threadId, cursor, detail: 'full' });
        if (!Array.isArray(page.data)) throw new Error('Malformed native MCP status proof.');
        for (const value of page.data) {
          const status = object(value); const name = nonempty(status.name);
          if (statuses.has(name) || !serverNames.includes(name) || status.runtimeStatus !== 'disabled') throw new Error('Native inherited MCP contributor is not disabled.');
          statuses.add(name);
        }
        cursor = page.nextCursor === null ? null : nonempty(page.nextCursor);
        if (cursor && cursors.has(cursor)) throw new Error('Duplicate native MCP status cursor.');
        if (cursor) cursors.add(cursor);
      } while (cursor !== null);
      this.recheck(input);
      const turn = await request('turn/start', { threadId: binding.threadId,
        input: input.text.map(text => ({ type: 'text', text, text_elements: [] })),
        environments: [], disabledPluginIds: pluginIds, model: input.model, effort: input.effort,
        approvalPolicy: 'never' });
      const turnId = nonempty(object(turn.turn).id);
      if (binding.turnId && binding.turnId !== turnId) throw new Error('Native turn response identity drift.');
      binding.turnId = turnId;
      await terminal.promise;
      await processing;
      if (state.failure) throw state.failure;
      child.stdin.end();
      }
      await exited;
      await processing;
      if (state.failure) throw state.failure;
      buffer += decoder.end();
      if (buffer.trim()) throw new Error('Native CLI left a partial protocol record.');
      if (state.exit?.code !== 0 || state.exit.signal !== null) throw new Error('Native CLI did not exit cleanly.');
      this.recheck(input);
      readFrozen(binary, binaryHash);
      if (child.pid) {
        try { process.kill(child.pid, 0); throw new Error('Native exited PID is still present.'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      if (cli === 'claude') {
        const path = nonempty(nativeTranscriptPath);
        assertUnambiguousPath(path);
        const bytes = readFileSync(path);
        const hash = sha256(bytes);
        readFrozen(path, hash);
        const copiedPath = `native-cli.${invocationId}.native-session.jsonl`;
        writeFileSync(join(resolve(this.dataDir), copiedPath), bytes, { flag: 'wx' });
        record({ direction: 'native-session', sourcePath: path, evidencePath: copiedPath, sha256: hash });
        readFrozen(path, hash);
        binding.nativeEffort = nativeClaudeEffort(bytes.toString('utf8'), nonempty(binding.sessionId), publicClaudeAssistants, nonempty(finalText));
        if (binding.nativeEffort !== input.effort) throw new Error('Native Claude observed effort differs from the qualified route.');
      }
      this.boundAgent().addAssistantResponse([{ type: 'text', text: nonempty(finalText) }]);
    } catch (error) {
      fail(error);
      emit({ ...binding, ts: Date.now(), type: 'native-cli:failure', reason: state.failure?.message ?? String(error),
        phase: cancelled ? 'cancelled' : child ? 'protocol' : 'admission' });
    } finally {
      await bridge?.stop(true);
      await Promise.allSettled(bridgeTools);
      await processing;
      if (child && state.exit === null) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await new Promise<void>(done => { child!.once('close', (code, signal) => { state.exit = { code, signal }; done(); }); });
      }
      let pidAbsent = child === null;
      if (child?.pid) { try { process.kill(child.pid, 0); } catch (error) { pidAbsent = (error as NodeJS.ErrnoException).code === 'ESRCH'; } }
      emit({ ...binding, ts: Date.now(), type: 'native-cli:terminal', outcome: cancelled ? 'cancelled' : state.failure ? 'failed' : 'completed',
        nativeStatus, finalText: state.failure ? null : finalText, finalTextSha256: !state.failure && finalText !== null ? sha256(finalText) : null,
        pid: child?.pid ?? null, exitCode: state.exit?.code ?? null, signal: state.exit?.signal ?? null, reaped: child !== null && state.exit !== null, pidAbsent });
    }
  }
}
