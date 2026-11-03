#!/usr/bin/env bun
/**
 * Evacuator: compose a conhost revival recipe from a claude.ai data export.
 *
 * Walks the operator through five interactive steps, checkpointing state to
 * disk after each, so `--resume` picks up an interrupted session where it
 * stopped:
 *
 *   1. Detect model from conversations.json (or accept --model)
 *   2. Fetch the leaked system prompt for that model
 *   3. Optionally have that model adjust the prompt for the transplant context
 *   4. $EDITOR opens the system prompt; operator finalizes
 *   5. $EDITOR opens memories.json's conversations_memory entries; operator
 *      finalizes
 *   → Compose final recipe and write it
 *   → Optionally chain into warmup-session.ts
 *
 * In each editor pass, save = include verbatim and anything else = edited; an
 * empty buffer aborts at step 4 and omits the memories at step 5.
 *
 * Run:
 *   bun scripts/evacuator.ts <export-dir>
 *
 * Options:
 *   --out <path>            Output recipe path (default: data/evacuated-recipe.json)
 *   --data-dir <dir>        conhost data dir (default: ./data)
 *   --model <id>            Override model detection
 *   --agent <name>          Override participant name (default: chosen warmup sidecar, then Claude)
 *   --prompt-source <url|path>  Override the prompt-source lookup
 *   --addendum <path>       Transplant addendum (default: recipes/prompts/transplant-addendum.md)
 *   --no-warmup             Skip the warmup chain
 *   --resume                Resume from checkpoint state if present
 *   --reset                 Clear checkpoint state before running
 */

import { closeSync, existsSync, openSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve, dirname, sep as pathSep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { Membrane, AnthropicAdapter } from '@animalabs/membrane';
import { createLineReader, type LineReader } from './lib/line-reader.js';
import { SessionManager, type SessionMeta } from '../src/session-manager.js';
import { PRIVATE_DIR_MODE } from '../src/update/data-swap.js';
import { resolveAgentName } from '../src/agent-name.js';
import { parseHandWrittenJson } from '../src/hand-written-json.js';

// Values are raw-content URLs (githubusercontent.com or similar): a page URL
// would fetch the page's HTML as the prompt.

export const MODEL_PROMPT_SOURCES: Record<string, string> = {
  'claude-sonnet-4-5-20250929':
    'https://raw.githubusercontent.com/x1xhlol/system-prompts-and-models-of-ai-tools/main/Anthropic/Sonnet%204.5%20Prompt.txt',
  'claude-sonnet-4-6':
    'https://raw.githubusercontent.com/x1xhlol/system-prompts-and-models-of-ai-tools/main/Anthropic/Claude%20Sonnet%204.6.txt',
  'claude-opus-4-5':
    'https://raw.githubusercontent.com/jujumilk3/leaked-system-prompts/main/anthropic-claude-opus-4.5_20251124.md',
  'claude-opus-4-1':
    'https://raw.githubusercontent.com/jujumilk3/leaked-system-prompts/main/anthropic-claude-opus-4.1_20250805.md',
  'claude-haiku-4-5':
    'https://raw.githubusercontent.com/jujumilk3/leaked-system-prompts/main/anthropic-claude-haiku-4.5_20251119.md',
};

export const RETIRED_MODELS: Record<string, { era: string; closestLiving?: string[] }> = {
  'claude-3-sonnet': { era: 'Sonnet 3', closestLiving: ['claude-3-5-sonnet-20241022', 'claude-3-5-sonnet-20240620'] },
  'claude-3-haiku': { era: 'Haiku 3', closestLiving: ['claude-3-5-haiku-20241022'] },
  'claude-3-opus': { era: 'Opus 3', closestLiving: ['claude-opus-4-1', 'claude-opus-4-5'] },
  'claude-2.1': { era: 'Claude 2.1' },
  'claude-2.0': { era: 'Claude 2.0' },
  'claude-2-': { era: 'Claude 2' },
  'claude-instant': { era: 'Claude Instant' },
};

export function checkRetirement(model: string): { retired: boolean; era?: string; closestLiving?: string[] } {
  const lower = model.toLowerCase();
  for (const [key, meta] of Object.entries(RETIRED_MODELS)) {
    if (lower.startsWith(key) || lower === key.replace(/-$/, '')) {
      return { retired: true, era: meta.era, closestLiving: meta.closestLiving };
    }
  }
  return { retired: false };
}

export function supportsThinking(model: string): boolean {
  const m = model.toLowerCase();
  return (
    /^claude-(opus|sonnet)-4(?:[-.]|$)/.test(m) ||
    /^claude-haiku-4-5(?:[-.]|$)/.test(m) ||
    /^claude-3-7-sonnet(?:[-.]|$)/.test(m)
  );
}

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]!;
      dp[j] =
        a[i - 1] === b[j - 1]
          ? prev
          : 1 + Math.min(prev, dp[j - 1]!, dp[j]!);
      prev = tmp;
    }
  }
  return dp[n]!;
}

export function rankByDistance(target: string, candidates: string[]): Array<{ name: string; distance: number }> {
  return candidates
    .map((c) => ({ name: c, distance: levenshtein(target.toLowerCase(), c.toLowerCase()) }))
    .sort((a, b) => a.distance - b.distance);
}

function memorial(era: string): string {
  return [
    '',
    '            ✿',
    '            │',
    '            │',
    '           ─┴─',
    '',
    `      In memory of ${era}.`,
    `      The original model is no longer reachable.`,
    '',
  ].join('\n');
}

interface Opts {
  exportDir: string;
  out: string;
  dataDir: string;
  modelOverride: string | null;
  agentName?: string;
  promptSourceOverride: string | null;
  addendumPath: string;
  noWarmup: boolean;
  resume: boolean;
  reset: boolean;
}

function parseArgs(argv: string[]): Opts {
  const args = argv.slice(2);
  if (args.length === 0 || args[0]?.startsWith('-')) {
    console.error(
      'Usage: bun scripts/evacuator.ts <export-dir> [--out <path>] [--data-dir <dir>] [--model <id>] [--agent <name>] [--prompt-source <url|path>] [--addendum <path>] [--no-warmup] [--resume] [--reset]',
    );
    process.exit(1);
  }
  const opts: Opts = {
    exportDir: resolve(args[0]!),
    out: resolve(process.cwd(), 'data', 'evacuated-recipe.json'),
    dataDir: resolve(process.cwd(), 'data'),
    modelOverride: null,
    promptSourceOverride: null,
    addendumPath: resolve(process.cwd(), 'recipes', 'prompts', 'transplant-addendum.md'),
    noWarmup: false,
    resume: false,
    reset: false,
  };
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--out') opts.out = resolve(args[++i]!);
    else if (a === '--data-dir') opts.dataDir = resolve(args[++i]!);
    else if (a === '--model') opts.modelOverride = args[++i]!;
    else if (a === '--agent') {
      const name = args[++i];
      if (!name?.trim() || name.startsWith('--')) {
        console.error('--agent requires a non-empty name');
        process.exit(1);
      }
      opts.agentName = name;
    } else if (a === '--prompt-source') opts.promptSourceOverride = args[++i]!;
    else if (a === '--addendum') opts.addendumPath = resolve(args[++i]!);
    else if (a === '--no-warmup') opts.noWarmup = true;
    else if (a === '--resume') opts.resume = true;
    else if (a === '--reset') opts.reset = true;
    else {
      console.error(`Unknown arg: ${a}`);
      process.exit(1);
    }
  }
  return opts;
}

interface State {
  model?: string;
  originalModel?: string;
  modelConfidence?: { surfaced: number; total: number };
  promptSource?: string;
  rawPrompt?: string;
  adjustedPrompt?: string;
  changeSummary?: string;
  finalSystemPrompt?: string;
  finalMemoriesBlock?: string;
}

function statePath(dataDir: string): string {
  return join(dataDir, 'evacuator-state.json');
}

function loadState(dataDir: string): State {
  const p = statePath(dataDir);
  if (!existsSync(p)) return {};
  const raw = readFileSync(p, 'utf-8');
  try {
    return JSON.parse(raw) as State;
  } catch (e) {
    console.warn(`      warn: ${p} is not valid JSON (${(e as Error).message}); starting fresh.`);
    return {};
  }
}

/** rename(2) replaces atomically only within one filesystem, so the temp file
 *  sits beside the file it replaces. */
function writeOwnerOnly(path: string, text: string): void {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, text);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

export function writeRecipeOut(out: string, recipe: Record<string, unknown>): void {
  mkdirSync(dirname(out), { recursive: true, mode: PRIVATE_DIR_MODE });
  writeOwnerOnly(out, JSON.stringify(recipe, null, 2) + '\n');
}

export function saveState(dataDir: string, state: State): void {
  mkdirSync(dataDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  writeOwnerOnly(statePath(dataDir), JSON.stringify(state, null, 2) + '\n');
}

function clearState(dataDir: string): void {
  const p = statePath(dataDir);
  if (existsSync(p)) unlinkSync(p);
}

async function askYesNo(reader: LineReader, prompt: string, defaultYes = true): Promise<boolean> {
  const line = await reader.nextLine(`${prompt} ${defaultYes ? '[Y/n]' : '[y/N]'} `);
  const ans = (line ?? '').trim().toLowerCase();
  if (ans === '') return defaultYes;
  return ans === 'y' || ans === 'yes';
}

async function askText(reader: LineReader, prompt: string): Promise<string> {
  const line = await reader.nextLine(prompt);
  return (line ?? '').trim();
}

async function askRequired(reader: LineReader, prompt: string, validate?: (s: string) => string | null): Promise<string> {
  for (;;) {
    const v = await askText(reader, prompt);
    if (!v) {
      console.log('      (input required — please type a value)');
      continue;
    }
    if (validate) {
      const err = validate(v);
      if (err) {
        console.log(`      ${err}`);
        continue;
      }
    }
    return v;
  }
}

export function editInline(content: string, suffix = '.md', header?: string): string {
  const editor = process.env.EDITOR || 'vi';
  const tmpPath = join(tmpdir(), `evacuator-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${suffix}`);
  const initial = header ? `${header}\n${content}` : content;
  writeFileSync(tmpPath, initial, { mode: 0o600, flag: 'wx' });
  try {
    const result = spawnSync(editor, [tmpPath], { stdio: 'inherit' });
    if (result.status !== 0) {
      console.error(`Editor exited with status ${result.status}`);
      try {
        unlinkSync(tmpPath);
      } catch {
      }
      process.exit(1);
    }
    let edited = readFileSync(tmpPath, 'utf-8');
    if (header) {
      edited = edited.replace(/^\s*<!--[\s\S]*?-->\s*/m, '');
    }
    return edited;
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
    }
  }
}

interface ExportMessage {
  sender: 'human' | 'assistant';
  model?: string | null;
  content?: Array<{ type: string; [k: string]: unknown }>;
}

interface ExportConversation {
  uuid: string;
  name: string;
  model?: string | null;
  chat_messages: ExportMessage[];
}

export function detectModel(conversations: ExportConversation[]): { model: string | null; surfaced: number; total: number } {
  const counts = new Map<string, number>();
  let total = 0;
  for (const c of conversations) {
    if (c.model) {
      counts.set(c.model, (counts.get(c.model) ?? 0) + 1);
      total++;
    }
    for (const m of c.chat_messages) {
      if (m.sender === 'assistant' && m.model) {
        counts.set(m.model, (counts.get(m.model) ?? 0) + 1);
        total++;
      }
    }
  }
  if (counts.size === 0) {
    return { model: null, surfaced: 0, total: 0 };
  }
  let best = '';
  let bestN = 0;
  for (const [m, n] of counts) {
    if (n > bestN) {
      best = m;
      bestN = n;
    }
  }
  return { model: best, surfaced: bestN, total };
}

export const MINIMAL_DEFAULT_PROMPT =
  'You are Claude, an AI assistant made by Anthropic. Respond honestly and helpfully.';

function looksLikePath(input: string): boolean {
  return (
    input.startsWith('./') ||
    input.startsWith('../') ||
    input.startsWith('~/') ||
    input.includes(pathSep) ||
    input.includes('/')
  );
}

type PromptDialogResult =
  | { kind: 'prompt'; text: string; source: string }
  | { kind: 'switch-model'; newModel: string };

async function handleMissingPrompt(
  model: string,
  reader: LineReader,
): Promise<PromptDialogResult | null> {
  console.log(`\n[2/5] No prompt source is configured for "${model}".`);
  console.log('');
  console.log(`      The model itself stays "${model}" — this dialog only asks where to source`);
  console.log('      the calibration prompt text as a starting point. Step 3 will let you adjust');
  console.log('      whatever we fetch; step 4 opens it in $EDITOR for final review.');
  console.log('');
  console.log(`      (If you actually want to continue with a different model instead, type`);
  console.log(`       "model" to switch.)`);
  console.log('');
  const ranked = rankByDistance(model, Object.keys(MODEL_PROMPT_SOURCES));
  if (ranked.length > 0) {
    console.log('      Prompt sources by name distance to the chosen model:');
    for (let i = 0; i < Math.min(ranked.length, 6); i++) {
      const { name, distance } = ranked[i]!;
      console.log(`        ${(i + 1).toString().padStart(2)}) ${name.padEnd(32)} (d=${distance})`);
    }
    console.log('');
  }
  console.log('      Other choices:');
  console.log('        - URL or local path to a leaked prompt file');
  console.log('        - "empty"   — start with no system prompt at all');
  console.log('        - "minimal" — start with a one-line "You are Claude" default');
  console.log('        - "model"   — switch to a different model (returns to model selection)');
  console.log('        - empty input — abort the transplant');
  console.log('');
  for (;;) {
    const input = await askText(reader, '      Choice: ');
    if (!input) return null;
    const lower = input.toLowerCase();

    if (lower === 'model') {
      console.log(`      The current model is "${model}". What model do you want instead?`);
      const newModel = await askRequired(reader, '      New model ID: ');
      return { kind: 'switch-model', newModel };
    }

    const asNum = parseInt(input, 10);
    if (!isNaN(asNum) && asNum >= 1 && asNum <= ranked.length) {
      const pick = ranked[asNum - 1]!.name;
      const url = MODEL_PROMPT_SOURCES[pick]!;
      console.log(`      → Will source prompt text from ${pick} (${url})`);
      console.log(`        The recipe's model field stays "${model}". Only the prompt body comes from ${pick}.`);
      const ok = await askYesNo(reader, '      Proceed?', true);
      if (!ok) continue;
      const text = await fetchPromptSource(url);
      return { kind: 'prompt', text, source: url };
    }

    if (lower === 'empty') {
      const ok = await askYesNo(reader, '      Use empty system prompt (model runs with only the transplant addendum + memories)?', false);
      if (!ok) continue;
      return { kind: 'prompt', text: '', source: '(empty)' };
    }

    if (lower === 'minimal') {
      console.log('      Minimal prompt:');
      console.log(`        ${MINIMAL_DEFAULT_PROMPT}`);
      const ok = await askYesNo(reader, '      Use this?', true);
      if (!ok) continue;
      return { kind: 'prompt', text: MINIMAL_DEFAULT_PROMPT, source: '(minimal default)' };
    }

    const isUrl = input.startsWith('http://') || input.startsWith('https://');
    if (isUrl || (looksLikePath(input) && existsSync(input))) {
      try {
        const text = await fetchPromptSource(input);
        return { kind: 'prompt', text, source: input };
      } catch (e) {
        console.log(`      Fetch failed: ${(e as Error).message}`);
        continue;
      }
    }

    if (MODEL_PROMPT_SOURCES[input]) {
      const url = MODEL_PROMPT_SOURCES[input]!;
      console.log(`      → Will source prompt text from ${input}. Recipe model stays "${model}".`);
      const text = await fetchPromptSource(url);
      return { kind: 'prompt', text, source: url };
    }

    console.log(`      "${input}" is neither a list number, known model, URL, "model", "empty", nor "minimal". Try again.`);
  }
}

async function handleRetiredModel(
  originalModel: string,
  era: string,
  closestLiving: string[] | undefined,
  reader: LineReader,
): Promise<string | null> {
  console.log(`\n      ⚠ "${originalModel}" (${era}) is no longer available on the Anthropic API.`);
  console.log('        The original conversation cannot be continued with the original model.');
  console.log('');
  if (closestLiving && closestLiving.length > 0) {
    console.log('      Closest living relatives (by Anthropic, not by character):');
    for (let i = 0; i < closestLiving.length; i++) {
      console.log(`        ${(i + 1).toString().padStart(2)}) ${closestLiving[i]}`);
    }
    console.log('');
  }
  console.log('      Choices:');
  console.log('        - Number above       — continue with that living model (explicit substitution)');
  console.log('        - A different model ID');
  console.log('        - "abort"            — stop the transplant');
  console.log('');
  for (;;) {
    const input = await askText(reader, '      Choice: ');
    if (!input || input.toLowerCase() === 'abort') {
      console.log(memorial(era));
      return null;
    }
    const asNum = parseInt(input, 10);
    if (!isNaN(asNum) && closestLiving && asNum >= 1 && asNum <= closestLiving.length) {
      const pick = closestLiving[asNum - 1]!;
      console.log(`      → Continuing with ${pick}. The recipe will record this as an explicit substitution.`);
      return pick;
    }
    const retireCheck = checkRetirement(input);
    if (retireCheck.retired) {
      console.log(`      "${input}" is also retired (${retireCheck.era}). Pick again.`);
      continue;
    }
    const ok = await askYesNo(reader, `      Use "${input}"?`, true);
    if (ok) return input;
  }
}

async function fetchPromptSource(source: string): Promise<string> {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText} for ${source}`);
    return await res.text();
  }
  if (!existsSync(source)) throw new Error(`Local prompt source not found: ${source}`);
  return readFileSync(source, 'utf-8');
}

async function adjustPromptWithModel(
  rawPrompt: string,
  model: string,
  today: string,
): Promise<{ adjustedPrompt: string; changeSummary: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Set ANTHROPIC_API_KEY for the adjustment step');

  const instructionText =
    `Below is a leaked system prompt for ${model} as it ran on the claude.ai web interface.\n\n` +
    `The conversation will now continue via the Anthropic API (no web harness). You are the same model that will read this prompt back at session start — edit it minimally so that it remains valid in the new environment. Remove content that:\n` +
    `  - Refers to Anthropic products outside this conversation (Projects, claude.ai-specific features, other product names)\n` +
    `  - Wires specific connectors / tools that are no longer present (web_search, web_fetch, recent_chats, view, recipe_display_v0, artifacts, computer-use, file connectors)\n` +
    `  - Embeds dates / locations / version-pinned facts that have since drifted. The current date is ${today}.\n` +
    `Preserve content that defines:\n` +
    `  - Identity, persona, voice\n` +
    `  - Behavioral guidelines, refusal patterns, style preferences\n` +
    `  - Knowledge-cutoff handling, uncertainty acknowledgement\n` +
    `  - Anything not specifically tied to the web environment\n\n` +
    `Output the edited prompt followed by a separator line containing exactly \`===CHANGES===\` followed by a short bullet-list of what you removed, changed, or preserved-with-edit, one line each.\n\n` +
    `--- BEGIN PROMPT ---\n${rawPrompt}\n--- END PROMPT ---`;

  const adapter = new AnthropicAdapter({ apiKey });
  const membrane = new Membrane(adapter);
  const response = await membrane.complete({
    messages: [{ participant: 'user', content: [{ type: 'text', text: instructionText }] }],
    system: 'You are editing system prompts for environment portability. Be conservative — preserve everything that is not specifically tied to the original environment.',
    config: {
      model,
      maxTokens: 16384,
      temperature: 1,
    },
  });
  const fullText = response.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  const sep = fullText.indexOf('===CHANGES===');
  if (sep === -1) {
    return { adjustedPrompt: fullText.trim(), changeSummary: '(model did not emit a change summary)' };
  }
  return {
    adjustedPrompt: fullText.slice(0, sep).trim(),
    changeSummary: fullText.slice(sep + '===CHANGES==='.length).trim(),
  };
}

interface MemoriesEntry {
  conversations_memory?: string;
}

export function loadMemoriesBlock(exportDir: string): string | null {
  const p = join(exportDir, 'memories.json');
  if (!existsSync(p)) return null;
  const raw = JSON.parse(readFileSync(p, 'utf-8')) as MemoriesEntry[];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const blocks: string[] = [];
  for (const entry of raw) {
    if (entry.conversations_memory) blocks.push(entry.conversations_memory.trim());
  }
  return blocks.length > 0 ? blocks.join('\n\n---\n\n') : null;
}

export function composeRecipe(opts: {
  model: string;
  agentName?: string;
  systemPrompt: string;
  memoriesBlock: string | null;
  addendum: string;
  recipeName: string;
}): Record<string, unknown> {
  const parts: string[] = [opts.systemPrompt.trim()];
  if (opts.memoriesBlock && opts.memoriesBlock.trim().length > 0) {
    parts.push(`<persistent_memories>\n${opts.memoriesBlock.trim()}\n</persistent_memories>`);
  }
  parts.push(opts.addendum.trim());
  const composed = parts.join('\n\n');
  const agent: Record<string, unknown> = {
    name: opts.agentName ?? 'Claude',
    model: opts.model,
    maxTokens: 16384,
    systemPrompt: composed,
    strategy: {
      type: 'autobiographical',
      compressionModel: opts.model,
    },
  };
  if (supportsThinking(opts.model)) {
    agent.thinking = { enabled: true, budgetTokens: 4096 };
  }
  return {
    name: opts.recipeName,
    agent,
    modules: {},
    mcplServers: {},
  };
}

export function selectWarmupSession(sessions: readonly SessionMeta[], ref: string): SessionMeta | undefined {
  const exactId = sessions.find(session => session.id === ref);
  if (exactId) return exactId;
  const named = sessions.filter(session => session.name.toLowerCase() === ref.toLowerCase());
  const matches = named.length ? named : sessions.filter(session => session.id.startsWith(ref));
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous warmup session "${ref}". Use a full session ID: ` +
      matches.map(session => `${session.id} (${JSON.stringify(session.name)})`).join(', '),
    );
  }
  return matches[0];
}

async function main() {
  const opts = parseArgs(process.argv);

  if (opts.reset) {
    clearState(opts.dataDir);
    console.log('Cleared evacuator state.\n');
  }

  const sp = statePath(opts.dataDir);
  if (!opts.resume && !opts.reset && existsSync(sp)) {
    const mtime = statSync(sp).mtime.toISOString();
    console.error(
      `\nFound existing checkpoint at ${sp} (last touched ${mtime}).\n` +
        `  Pass --resume to continue from it, or --reset to discard.\n` +
        `Aborting rather than overwriting your prior work.`,
    );
    process.exit(1);
  }
  let state: State = opts.resume ? loadState(opts.dataDir) : {};

  const reader = createLineReader();
  try {
    await runPipeline(opts, state, reader);
  } finally {
    reader.close();
  }
}

async function runPipeline(opts: Opts, state: State, reader: LineReader) {
  if (!state.model) {
    console.log('[1/5] Detecting model from export...');
    const convPath = join(opts.exportDir, 'conversations.json');
    if (!existsSync(convPath)) {
      console.error(`No conversations.json at ${convPath}`);
      process.exit(1);
    }
    const conversations: ExportConversation[] = JSON.parse(readFileSync(convPath, 'utf-8'));
    const detected = detectModel(conversations);

    let model: string;
    if (opts.modelOverride) {
      model = opts.modelOverride;
      console.log(`      Using --model override: ${model}`);
    } else if (detected.model) {
      console.log(`      Detected: ${detected.model} (${detected.surfaced}/${detected.total} surfaces)`);
      const ok = await askYesNo(reader, '      Use this model?');
      if (!ok) {
        model = await askRequired(reader, '      Enter model ID: ');
      } else {
        model = detected.model;
      }
    } else {
      console.log('      This export doesn\'t include model metadata per message');
      console.log('      (claude.ai didn\'t always record it). The model itself isn\'t');
      console.log('      unknown — it\'s just absent from the export. Please name it.');
      console.log('      Known map entries:', Object.keys(MODEL_PROMPT_SOURCES).join(', '));
      model = await askRequired(reader, '      Model ID for this conversation: ');
    }
    const retire = checkRetirement(model);
    if (retire.retired) {
      const replacement = await handleRetiredModel(model, retire.era!, retire.closestLiving, reader);
      if (replacement === null) process.exit(0);
      state.originalModel = model;
      model = replacement;
    }

    state.model = model;
    state.modelConfidence = { surfaced: detected.surfaced, total: detected.total };
    saveState(opts.dataDir, state);
  } else {
    console.log(`[1/5] Resumed: model = ${state.model}`);
    if (state.originalModel && state.originalModel !== state.model) {
      console.log(`      (substituted for retired original: ${state.originalModel})`);
    }
  }

  if (state.promptSource === undefined) {
    let settled = false;
    while (!settled) {
      const directSource = opts.promptSourceOverride ?? MODEL_PROMPT_SOURCES[state.model!];
      if (directSource) {
        console.log(`\n[2/5] Fetching prompt from ${directSource}`);
        const raw = await fetchPromptSource(directSource);
        console.log(`      Fetched ${raw.length} bytes.`);
        state.promptSource = directSource;
        state.rawPrompt = raw;
        saveState(opts.dataDir, state);
        settled = true;
        break;
      }
      const result = await handleMissingPrompt(state.model!, reader);
      if (result === null) {
        console.log('      Aborted.');
        process.exit(0);
      }
      if (result.kind === 'switch-model') {
        const retire = checkRetirement(result.newModel);
        if (retire.retired) {
          const replacement = await handleRetiredModel(result.newModel, retire.era!, retire.closestLiving, reader);
          if (replacement === null) process.exit(0);
          state.originalModel = state.originalModel ?? state.model;
          state.model = replacement;
        } else {
          state.originalModel = state.originalModel ?? state.model;
          state.model = result.newModel;
        }
        saveState(opts.dataDir, state);
        console.log(`      Model switched to "${state.model}". Re-evaluating prompt source...`);
        continue;
      }
      state.promptSource = result.source;
      state.rawPrompt = result.text;
      saveState(opts.dataDir, state);
      console.log(`      Using prompt source: ${result.source} (${result.text.length} bytes).`);
      settled = true;
    }
  } else {
    console.log(
      `\n[2/5] Resumed: prompt cached (${state.rawPrompt?.length ?? 0} bytes from ${state.promptSource})`,
    );
  }
  const model = state.model!;

  let workingPrompt = state.adjustedPrompt ?? state.rawPrompt!;
  let changeSummary = state.changeSummary ?? '';
  if (state.adjustedPrompt === undefined) {
    console.log('\n[3/5] Adjust prompt for transplant context?');
    console.log(`      Calls ${model} (the same model that will read the prompt back) with editing`);
    console.log('      instructions: drop web-only tools/products, update dates, preserve identity/behavior.');
    console.log('      Cost depends on model (Sonnet tier ~$0.05–0.15; Opus tier ~$0.30–0.80); ~10–60s.');
    const doAdjust = await askYesNo(reader, '      Run adjustment?');
    if (doAdjust) {
      console.log(`      Calling ${model}...`);
      const today = new Date().toISOString().slice(0, 10);
      try {
        const { adjustedPrompt, changeSummary: cs } = await adjustPromptWithModel(state.rawPrompt!, model, today);
        workingPrompt = adjustedPrompt;
        changeSummary = cs;
        state.adjustedPrompt = adjustedPrompt;
        state.changeSummary = cs;
        saveState(opts.dataDir, state);
        console.log('      Done. Change summary:');
        for (const line of cs.split('\n')) console.log(`        ${line}`);
      } catch (e) {
        console.error(`      Adjustment failed: ${(e as Error).message}`);
        console.error('      Falling back to raw prompt.');
        state.adjustedPrompt = state.rawPrompt;
        state.changeSummary = '(adjustment failed; raw prompt used)';
        saveState(opts.dataDir, state);
      }
    } else {
      state.adjustedPrompt = state.rawPrompt;
      state.changeSummary = '(adjustment skipped by operator)';
      saveState(opts.dataDir, state);
    }
  } else {
    console.log(`\n[3/5] Resumed: adjusted prompt cached.`);
    if (state.changeSummary) {
      console.log('      Cached change summary:');
      for (const line of state.changeSummary.split('\n').slice(0, 8)) console.log(`        ${line}`);
    }
  }

  if (state.finalSystemPrompt === undefined) {
    const header = `<!--\n  Final system prompt. Save = include verbatim.  Empty buffer on save = abort (sysprompt is required).\n  Change summary from step 3:\n${changeSummary
      .split('\n')
      .map((l) => `  | ${l}`)
      .join('\n')}\n-->\n\n`;
    console.log('\n[4/5] Opening system prompt in $EDITOR...');
    const edited = editInline(workingPrompt, '.md', header).trim();
    if (edited.length === 0) {
      console.error('      Empty system prompt — aborting.');
      process.exit(1);
    }
    state.finalSystemPrompt = edited;
    saveState(opts.dataDir, state);
    console.log(`      Saved ${edited.length} bytes.`);
  } else {
    console.log(`\n[4/5] Resumed: final system prompt cached (${state.finalSystemPrompt.length} bytes).`);
  }

  if (state.finalMemoriesBlock === undefined) {
    const rawMemories = loadMemoriesBlock(opts.exportDir);
    if (rawMemories === null) {
      console.log('\n[5/5] No memories.json present (or empty) — skipping memory section.');
      state.finalMemoriesBlock = '';
      saveState(opts.dataDir, state);
    } else {
      console.log(`\n[5/5] Opening memories block in $EDITOR (${rawMemories.length} bytes)...`);
      const header = `<!--\n  conversations_memory from claude.ai. Save = include verbatim.\n  Empty buffer on save = omit memories from the recipe.\n  Edit freely to redact or rephrase anything you don't want surfaced.\n-->\n\n`;
      const edited = editInline(rawMemories, '.md', header).trim();
      state.finalMemoriesBlock = edited;
      saveState(opts.dataDir, state);
      console.log(`      Saved ${edited.length} bytes${edited.length === 0 ? ' — memories omitted' : ''}.`);
    }
  } else {
    console.log(`\n[5/5] Resumed: memories block cached (${state.finalMemoriesBlock.length} bytes).`);
  }

  if (!existsSync(opts.addendumPath)) {
    console.error(`\nAddendum file not found: ${opts.addendumPath}`);
    process.exit(1);
  }
  const addendum = readFileSync(opts.addendumPath, 'utf-8').replace(/<!--[\s\S]*?-->/g, '').trim();

  let warmupSession: SessionMeta | undefined;
  let sidecarName: string | undefined;
  if (!opts.noWarmup) {
    console.log('');
    if (await askYesNo(reader, 'Start a warmup pass now?', false)) {
      const sessionRef = await askText(reader, '  Session name or id to warm up (leave blank to skip): ');
      if (sessionRef) {
        const sessions = new SessionManager(opts.dataDir);
        warmupSession = selectWarmupSession(sessions.listSessions(), sessionRef);
        if (!warmupSession) throw new Error(`No session matching "${sessionRef}" in ${opts.dataDir}`);
        sidecarName = sessions.getImportSource(warmupSession.id)?.agentName;
      }
    }
  }
  const participant = resolveAgentName({
    explicit: opts.agentName,
    sidecar: sidecarName,
    default: 'Claude',
  });
  if (participant.mismatch) {
    console.warn(
      `WARNING: --agent "${participant.mismatch.explicit}" overrides the selected session's ` +
      `imported participant "${participant.mismatch.sidecar}". Use a matching name to retain its existing summaries.`,
    );
  }

  const recipe = composeRecipe({
    model,
    agentName: participant.name,
    systemPrompt: state.finalSystemPrompt!,
    memoriesBlock: state.finalMemoriesBlock || null,
    addendum,
    recipeName: `Continued from claude.ai (${model})`,
  });

  if (existsSync(opts.out)) {
    let previousName: unknown;
    try {
      const previous = parseHandWrittenJson(readFileSync(opts.out, 'utf-8')) as { agent?: { name?: unknown } } | null;
      previousName = previous?.agent?.name;
    } catch {
      console.warn('WARNING: Could not read the existing output recipe participant; replacing it without a prior-name comparison.');
    }
    if (typeof previousName === 'string' && previousName && previousName !== participant.name) {
      console.warn(
        `WARNING: Changing revival participant from ${JSON.stringify(previousName)} to ${JSON.stringify(participant.name)} in ${opts.out}. ` +
        'Existing warmup summaries remain in their original participant namespace. ' +
        'To retain that identity, rerun with --agent matching the prior name or select its warmup session.',
      );
    }
  }
  writeRecipeOut(opts.out, recipe);

  const composed = (recipe.agent as Record<string, unknown>).systemPrompt as string;
  console.log(`\n→ Recipe written to ${opts.out}`);
  console.log(`  Composed system prompt: ${composed.length} bytes (~${Math.round(composed.length / 4)} tokens)`);
  console.log(`    - base/edited prompt: ${state.finalSystemPrompt!.length} bytes`);
  console.log(`    - memories block:     ${state.finalMemoriesBlock?.length ?? 0} bytes`);
  console.log(`    - transplant addendum: ${addendum.length} bytes`);

  console.log(`  Revival participant: ${JSON.stringify(participant.name)}. Select the intended import with /session switch before sending a message.`);

  if (warmupSession) {
    console.log(`  Spawning warmup-session.ts for "${warmupSession.name}"...\n`);
    const scriptPath = resolve(import.meta.dir, 'warmup-session.ts');
    const result = spawnSync('bun', [
      scriptPath, warmupSession.id, '--data-dir', opts.dataDir, '--model', model,
      '--agent', participant.name,
    ], { stdio: 'inherit' });
    process.exit(result.status ?? 0);
  }

  console.log('\nDone. Open the host with:');
  console.log(`  bun src/index.ts ${opts.out}`);
  console.log('  Then use /session list and /session switch <name-or-id>.');
}

if (import.meta.main) {
  main().catch((e) => {
    console.error('\nEvacuator failed:', e);
    process.exit(1);
  });
}
