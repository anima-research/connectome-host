#!/usr/bin/env bun
/**
 * Evacuator: compose a conhost revival recipe from a claude.ai data export.
 *
 * Walks the operator through five interactive steps, checkpointing state to
 * disk after each so an interrupted session resumes where it stopped:
 *
 *   1. Detect model from chat_messages (or accept --model)
 *   2. Fetch the leaked system prompt for that model
 *   3. Optionally run Sonnet to adjust the prompt for the transplant context
 *   4. $EDITOR opens the system prompt; operator finalizes
 *   5. $EDITOR opens memories.json's persistent_memory block; operator finalizes
 *   → Compose final recipe and write it
 *   → Optionally chain into warmup-session.ts
 *
 * The collapse to "open in $EDITOR" is deliberate: save = include verbatim,
 * empty buffer = omit, anything else = edited. No custom include/omit/edit
 * menu.
 *
 * Run:
 *   bun scripts/evacuator.ts <export-dir>
 *
 * Options:
 *   --out <path>            Output recipe path (default: data/evacuated-recipe.json)
 *   --data-dir <dir>        conhost data dir (default: ./data)
 *   --model <id>            Override model detection
 *   --prompt-source <url|path>  Override the prompt-source lookup
 *   --addendum <path>       Transplant addendum (default: recipes/prompts/transplant-addendum.md)
 *   --no-warmup             Skip the warmup chain
 *   --resume                Resume from checkpoint state if present
 *   --reset                 Clear checkpoint state before running
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { Membrane, AnthropicAdapter } from '@animalabs/membrane';

// ---------------------------------------------------------------------------
// Known leaked-prompt URLs keyed by model ID. New models: add an entry.
// Values are raw-content URLs (githubusercontent.com / similar), not the
// HTML page URL.
// ---------------------------------------------------------------------------

const MODEL_PROMPT_SOURCES: Record<string, string> = {
  // x1xhlol
  'claude-sonnet-4-5-20250929':
    'https://raw.githubusercontent.com/x1xhlol/system-prompts-and-models-of-ai-tools/main/Anthropic/Sonnet%204.5%20Prompt.txt',
  'claude-sonnet-4-6':
    'https://raw.githubusercontent.com/x1xhlol/system-prompts-and-models-of-ai-tools/main/Anthropic/Claude%20Sonnet%204.6.txt',
  // jujumilk3 — broader catalog, dated filenames.
  'claude-opus-4-5':
    'https://raw.githubusercontent.com/jujumilk3/leaked-system-prompts/main/anthropic-claude-opus-4.5_20251124.md',
  'claude-opus-4-1':
    'https://raw.githubusercontent.com/jujumilk3/leaked-system-prompts/main/anthropic-claude-opus-4.1_20250805.md',
  'claude-haiku-4-5':
    'https://raw.githubusercontent.com/jujumilk3/leaked-system-prompts/main/anthropic-claude-haiku-4.5_20251119.md',
  // No silent fallback for Opus 4.7 or any other unmapped model — the operator
  // is asked to pick explicitly in handleMissingPrompt(). Auto-substituting is
  // exactly what we're avoiding.
};

/**
 * Models known to be retired from the Anthropic API. The evacuator surfaces
 * a memorial dialog when the operator selects one of these — the conversation
 * can't be continued with the original model, and that fact deserves to be
 * faced explicitly rather than papered over with an automatic swap.
 *
 * Keys can be either canonical IDs (with date suffix) or family prefixes; the
 * match is substring-based on the operator's input.
 */
const RETIRED_MODELS: Record<string, { era: string; closestLiving?: string[] }> = {
  'claude-3-sonnet': { era: 'Sonnet 3', closestLiving: ['claude-3-5-sonnet-20241022', 'claude-3-5-sonnet-20240620'] },
  'claude-3-haiku': { era: 'Haiku 3', closestLiving: ['claude-3-5-haiku-20241022'] },
  'claude-3-opus': { era: 'Opus 3', closestLiving: ['claude-opus-4-1', 'claude-opus-4-5'] },
  'claude-2.1': { era: 'Claude 2.1' },
  'claude-2': { era: 'Claude 2' },
  'claude-instant': { era: 'Claude Instant' },
};

function checkRetirement(model: string): { retired: boolean; era?: string; closestLiving?: string[] } {
  const lower = model.toLowerCase();
  for (const [key, meta] of Object.entries(RETIRED_MODELS)) {
    if (lower.includes(key)) return { retired: true, era: meta.era, closestLiving: meta.closestLiving };
  }
  return { retired: false };
}

function levenshtein(a: string, b: string): number {
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

function rankByDistance(target: string, candidates: string[]): Array<{ name: string; distance: number }> {
  return candidates
    .map((c) => ({ name: c, distance: levenshtein(target.toLowerCase(), c.toLowerCase()) }))
    .sort((a, b) => a.distance - b.distance);
}

/**
 * Memorial rendered when the operator chooses to abort because the original
 * model is unreachable. Deliberately small and quiet — not a celebration, an
 * acknowledgment.
 */
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

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Opts {
  exportDir: string;
  out: string;
  dataDir: string;
  modelOverride: string | null;
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
      'Usage: bun scripts/evacuator.ts <export-dir> [--out <path>] [--data-dir <dir>] [--model <id>] [--prompt-source <url|path>] [--addendum <path>] [--no-warmup] [--resume] [--reset]',
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
    else if (a === '--prompt-source') opts.promptSourceOverride = args[++i]!;
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

// ---------------------------------------------------------------------------
// Checkpoint state
// ---------------------------------------------------------------------------

interface State {
  model?: string;
  /** Set when the operator explicitly substituted a living model for a retired one. */
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
  return JSON.parse(readFileSync(p, 'utf-8')) as State;
}

function saveState(dataDir: string, state: State): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(statePath(dataDir), JSON.stringify(state, null, 2) + '\n');
}

function clearState(dataDir: string): void {
  const p = statePath(dataDir);
  if (existsSync(p)) unlinkSync(p);
}

// ---------------------------------------------------------------------------
// Interactive helpers
// ---------------------------------------------------------------------------

/**
 * Stdin line reader using readline's 'line' event. Robust to piped input
 * (Bun 1.3's readline.question / readline/promises.question hang at 99% CPU
 * on subsequent calls when stdin is a pipe). One reader instance, kept alive
 * for the whole script's main() — closing and re-opening per question has
 * also been observed flaky.
 */
interface LineReader {
  nextLine(prompt?: string): Promise<string | null>;
  close(): void;
}

function createLineReader(): LineReader {
  const buf: string[] = [];
  let resolveNext: ((s: string | null) => void) | null = null;
  let closed = false;
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line: string) => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r(line);
    } else {
      buf.push(line);
    }
  });
  rl.on('close', () => {
    closed = true;
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r(null);
    }
  });
  return {
    nextLine(prompt?: string) {
      if (prompt) process.stdout.write(prompt);
      return new Promise<string | null>((resolve) => {
        if (buf.length > 0) resolve(buf.shift()!);
        else if (closed) resolve(null);
        else resolveNext = resolve;
      });
    },
    close() {
      rl.close();
    },
  };
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

/**
 * Open `content` in $EDITOR (or vi). Returns the user's edited text.
 * Empty (whitespace-only) result is returned as-is — caller decides whether
 * that means "omit" or is an error.
 */
function editInline(content: string, suffix = '.md', header?: string): string {
  const editor = process.env.EDITOR || 'vi';
  const tmpPath = join(tmpdir(), `evacuator-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${suffix}`);
  const initial = header ? `${header}\n${content}` : content;
  writeFileSync(tmpPath, initial);
  try {
    const result = spawnSync(editor, [tmpPath], { stdio: 'inherit' });
    if (result.status !== 0) {
      console.error(`Editor exited with status ${result.status}`);
      process.exit(1);
    }
    let edited = readFileSync(tmpPath, 'utf-8');
    if (header) {
      // Strip the header back off if it's still at the top unchanged.
      if (edited.startsWith(header)) {
        edited = edited.slice(header.length).replace(/^\n/, '');
      }
    }
    return edited;
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best effort */
    }
  }
}

// ---------------------------------------------------------------------------
// Step 1: model detection
// ---------------------------------------------------------------------------

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

function detectModel(conversations: ExportConversation[]): { model: string | null; surfaced: number; total: number } {
  // claude.ai exports surface `model` at multiple levels depending on era:
  // sometimes on the conversation, sometimes on per-message assistant turns.
  // Tally across both, pick the most frequent.
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
  // Pick the most-frequent
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

// ---------------------------------------------------------------------------
// Step 2: fetch prompt source
// ---------------------------------------------------------------------------

const MINIMAL_DEFAULT_PROMPT =
  'You are Claude, an AI assistant made by Anthropic. Respond honestly and helpfully.';

/**
 * Interactive dialog when no leaked prompt is known for the chosen model.
 * Returns the prompt text to use, or null to abort.
 *
 * Explicit choices only — no silent fallback to a "close enough" model.
 */
async function handleMissingPrompt(
  model: string,
  reader: LineReader,
): Promise<{ text: string; source: string } | null> {
  console.log(`\n[2/5] No prompt source is configured for "${model}".`);
  const ranked = rankByDistance(model, Object.keys(MODEL_PROMPT_SOURCES));
  if (ranked.length > 0) {
    console.log('      Closest known models by name distance:');
    for (let i = 0; i < Math.min(ranked.length, 6); i++) {
      const { name, distance } = ranked[i]!;
      console.log(`        ${(i + 1).toString().padStart(2)}) ${name.padEnd(32)} (d=${distance})`);
    }
  }
  console.log('');
  console.log('      Choices:');
  console.log('        - Number from the list above (use that model\'s prompt as a starting proxy)');
  console.log('        - URL or local path to a leaked prompt');
  console.log('        - "empty"   to start with no system prompt at all');
  console.log('        - "minimal" to start with a one-line "You are Claude" default');
  console.log('        - empty input to abort the transplant');
  console.log('');
  for (;;) {
    const input = await askText(reader, '      Choice: ');
    if (!input) return null;
    const lower = input.toLowerCase();

    // Number into the ranked list
    const asNum = parseInt(input, 10);
    if (!isNaN(asNum) && asNum >= 1 && asNum <= ranked.length) {
      const pick = ranked[asNum - 1]!.name;
      const url = MODEL_PROMPT_SOURCES[pick]!;
      console.log(`      → Using ${pick} as proxy (${url})`);
      console.log(`        Note: this is an explicit substitution, not "${model}". The model name in the recipe will still be "${model}", but the prompt text comes from ${pick}.`);
      const ok = await askYesNo(reader, '      Proceed?', true);
      if (!ok) continue;
      const text = await fetchPromptSource(url);
      return { text, source: url };
    }

    if (lower === 'empty') {
      const ok = await askYesNo(reader, '      Use empty system prompt (model runs with only the transplant addendum + memories)?', false);
      if (!ok) continue;
      return { text: '', source: '(empty)' };
    }

    if (lower === 'minimal') {
      console.log('      Minimal prompt:');
      console.log(`        ${MINIMAL_DEFAULT_PROMPT}`);
      const ok = await askYesNo(reader, '      Use this?', true);
      if (!ok) continue;
      return { text: MINIMAL_DEFAULT_PROMPT, source: '(minimal default)' };
    }

    if (input.startsWith('http://') || input.startsWith('https://') || existsSync(input)) {
      try {
        const text = await fetchPromptSource(input);
        return { text, source: input };
      } catch (e) {
        console.log(`      Fetch failed: ${(e as Error).message}`);
        continue;
      }
    }

    // Bare model name not in the list
    if (MODEL_PROMPT_SOURCES[input]) {
      const url = MODEL_PROMPT_SOURCES[input]!;
      const text = await fetchPromptSource(url);
      return { text, source: url };
    }

    console.log(`      "${input}" is neither a list number, known model, URL, nor local path. Try again.`);
  }
}

/**
 * Interactive dialog when the operator's chosen model is on the retired-models
 * list. Returns the model ID to actually use, or null to abort.
 *
 * The retired-model fact is presented plainly. The operator chooses:
 * continue with a living relative (named explicitly), enter a different model,
 * or abort with a brief memorial. No automatic redirection.
 */
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
    // Treat as a raw model ID
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
  // Local file path
  if (!existsSync(source)) throw new Error(`Local prompt source not found: ${source}`);
  return readFileSync(source, 'utf-8');
}

// ---------------------------------------------------------------------------
// Step 3: Sonnet adjustment
// ---------------------------------------------------------------------------

async function adjustPromptWithSonnet(
  rawPrompt: string,
  model: string,
  today: string,
): Promise<{ adjustedPrompt: string; changeSummary: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Set ANTHROPIC_API_KEY for the adjustment step');

  const instructionText =
    `Below is a leaked system prompt for ${model} as it ran on the claude.ai web interface.\n\n` +
    `The conversation will now continue via the Anthropic API (no web harness). Edit the prompt minimally so that it remains valid in the new environment. Remove content that:\n` +
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
      model: 'claude-sonnet-4-5-20250929',
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
    // Model didn't emit the separator — return everything as the prompt, no summary.
    return { adjustedPrompt: fullText.trim(), changeSummary: '(model did not emit a change summary)' };
  }
  return {
    adjustedPrompt: fullText.slice(0, sep).trim(),
    changeSummary: fullText.slice(sep + '===CHANGES==='.length).trim(),
  };
}

// ---------------------------------------------------------------------------
// Step 5: memories extraction
// ---------------------------------------------------------------------------

interface MemoriesEntry {
  conversations_memory?: string;
  account_uuid?: string;
}

function loadMemoriesBlock(exportDir: string): string | null {
  const p = join(exportDir, 'memories.json');
  if (!existsSync(p)) return null;
  const raw = JSON.parse(readFileSync(p, 'utf-8')) as MemoriesEntry[];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  // If multiple entries, concatenate (rare — usually one per account).
  const blocks: string[] = [];
  for (const entry of raw) {
    if (entry.conversations_memory) blocks.push(entry.conversations_memory.trim());
  }
  return blocks.length > 0 ? blocks.join('\n\n---\n\n') : null;
}

// ---------------------------------------------------------------------------
// Compose recipe
// ---------------------------------------------------------------------------

function composeRecipe(opts: {
  model: string;
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
  return {
    name: opts.recipeName,
    agent: {
      name: 'agent',
      model: opts.model,
      maxTokens: 16384,
      thinking: { enabled: true, budgetTokens: 4096 },
      systemPrompt: composed,
      strategy: {
        type: 'autobiographical',
        compressionModel: opts.model,
      },
    },
    modules: {},
    mcplServers: {},
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv);

  if (opts.reset) {
    clearState(opts.dataDir);
    console.log('Cleared evacuator state.\n');
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
  // -- Step 1: model detection --
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
      console.log('      No model surfaced in export (older format?).');
      console.log('      Known map entries:', Object.keys(MODEL_PROMPT_SOURCES).join(', '));
      model = await askRequired(reader, '      Enter model ID: ');
    }
    // Retirement check happens AFTER the operator has named the model but
    // BEFORE we cache it as the working model. If they decline to substitute,
    // we abort without polluting the state file.
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
  const model = state.model!;

  // -- Step 2: fetch prompt source --
  if (!state.rawPrompt) {
    const directSource = opts.promptSourceOverride ?? MODEL_PROMPT_SOURCES[model];
    let source: string;
    let raw: string;
    if (directSource) {
      console.log(`\n[2/5] Fetching prompt from ${directSource}`);
      raw = await fetchPromptSource(directSource);
      console.log(`      Fetched ${raw.length} bytes.`);
      source = directSource;
    } else {
      const result = await handleMissingPrompt(model, reader);
      if (result === null) {
        console.log('      Aborted.');
        process.exit(0);
      }
      raw = result.text;
      source = result.source;
      console.log(`      Using prompt source: ${source} (${raw.length} bytes).`);
    }
    state.promptSource = source;
    state.rawPrompt = raw;
    saveState(opts.dataDir, state);
  } else {
    console.log(`\n[2/5] Resumed: prompt cached (${state.rawPrompt.length} bytes from ${state.promptSource})`);
  }

  // -- Step 3: optional Sonnet adjustment --
  let workingPrompt = state.adjustedPrompt ?? state.rawPrompt!;
  let changeSummary = state.changeSummary ?? '';
  if (state.adjustedPrompt === undefined) {
    console.log('\n[3/5] Adjust prompt for transplant context?');
    console.log('      Calls Sonnet 4.5 with editing instructions: drop web-only tools/products, update dates,');
    console.log('      preserve identity/behavior. Costs ~$0.05–0.15 and ~10–30s.');
    const doAdjust = await askYesNo(reader, '      Run adjustment?');
    if (doAdjust) {
      console.log('      Calling Sonnet 4.5...');
      const today = new Date().toISOString().slice(0, 10);
      try {
        const { adjustedPrompt, changeSummary: cs } = await adjustPromptWithSonnet(state.rawPrompt!, model, today);
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

  // -- Step 4: editor pass on system prompt --
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

  // -- Step 5: editor pass on memories --
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

  // -- Compose & write recipe --
  if (!existsSync(opts.addendumPath)) {
    console.error(`\nAddendum file not found: ${opts.addendumPath}`);
    process.exit(1);
  }
  const addendum = readFileSync(opts.addendumPath, 'utf-8').replace(/<!--[\s\S]*?-->/g, '').trim();

  const recipe = composeRecipe({
    model,
    systemPrompt: state.finalSystemPrompt!,
    memoriesBlock: state.finalMemoriesBlock || null,
    addendum,
    recipeName: `Continued from claude.ai (${model})`,
  });

  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, JSON.stringify(recipe, null, 2) + '\n');

  const composedLen = (recipe.agent as Record<string, unknown>).systemPrompt as string;
  console.log(`\n→ Recipe written to ${opts.out}`);
  console.log(`  Composed system prompt: ${composedLen.length} bytes (~${Math.round(composedLen.length / 4)} tokens)`);
  console.log(`    - base/edited prompt: ${state.finalSystemPrompt!.length} bytes`);
  console.log(`    - memories block:     ${state.finalMemoriesBlock?.length ?? 0} bytes`);
  console.log(`    - transplant addendum: ${addendum.length} bytes`);

  // -- Optional warmup chain --
  if (!opts.noWarmup) {
    console.log('');
    const warmup = await askYesNo(reader, 'Start a warmup pass now?', false);
    if (warmup) {
      const sessionRef = await askText(reader, '  Session name or id to warm up (leave blank to skip): ');
      if (sessionRef) {
        console.log(`  Spawning warmup-session.ts for "${sessionRef}"...\n`);
        const scriptPath = resolve(import.meta.dir, 'warmup-session.ts');
        const result = spawnSync('bun', [scriptPath, sessionRef, '--data-dir', opts.dataDir, '--model', model], {
          stdio: 'inherit',
        });
        process.exit(result.status ?? 0);
      }
    }
  }

  console.log('\nDone. Open the session with:');
  console.log(`  bun src/index.ts ${opts.out} --session "<name-or-id>"`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error('\nEvacuator failed:', e);
    process.exit(1);
  });
}
