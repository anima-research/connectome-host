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
import { createInterface } from 'node:readline/promises';
import { Membrane, AnthropicAdapter } from '@animalabs/membrane';

// ---------------------------------------------------------------------------
// Known leaked-prompt URLs keyed by model ID. New models: add an entry.
// Values are raw-content URLs (githubusercontent.com / similar), not the
// HTML page URL.
// ---------------------------------------------------------------------------

const MODEL_PROMPT_SOURCES: Record<string, string> = {
  'claude-sonnet-4-5-20250929':
    'https://raw.githubusercontent.com/x1xhlol/system-prompts-and-models-of-ai-tools/main/Anthropic/Sonnet%204.5%20Prompt.txt',
};

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

async function ask(prompt: string, defaultYes = true): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = (await rl.question(`${prompt} ${defaultYes ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
    if (ans === '') return defaultYes;
    return ans === 'y' || ans === 'yes';
  } finally {
    rl.close();
  }
}

async function askText(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
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
      const ok = await ask('      Use this model?');
      if (!ok) {
        model = await askText('      Enter model ID: ');
      } else {
        model = detected.model;
      }
    } else {
      console.log('      No model surfaced in export (older format?).');
      model = await askText('      Enter model ID: ');
    }
    state.model = model;
    state.modelConfidence = { surfaced: detected.surfaced, total: detected.total };
    saveState(opts.dataDir, state);
  } else {
    console.log(`[1/5] Resumed: model = ${state.model}`);
  }
  const model = state.model!;

  // -- Step 2: fetch prompt source --
  if (!state.rawPrompt) {
    const source = opts.promptSourceOverride ?? MODEL_PROMPT_SOURCES[model];
    if (!source) {
      console.error(`\n[2/5] No prompt source configured for "${model}".`);
      console.error('      Add an entry to MODEL_PROMPT_SOURCES in scripts/evacuator.ts,');
      console.error('      or pass --prompt-source <url|path>.');
      console.error('      Known leak repos:');
      console.error('        - https://github.com/x1xhlol/system-prompts-and-models-of-ai-tools');
      console.error('        - https://github.com/jujumilk3/leaked-system-prompts');
      process.exit(1);
    }
    console.log(`\n[2/5] Fetching prompt from ${source}`);
    const raw = await fetchPromptSource(source);
    console.log(`      Fetched ${raw.length} bytes.`);
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
    const doAdjust = await ask('      Run adjustment?');
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
    const warmup = await ask('Start a warmup pass now?', false);
    if (warmup) {
      const sessionRef = await askText('  Session name or id to warm up (leave blank to skip): ');
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
