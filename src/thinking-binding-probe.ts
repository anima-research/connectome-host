/**
 * What this process's account does with a signed thinking block whose earlier
 * conversation changed (anima-research/context-manager#155), found at start
 * with a few small requests rather than assumed from the model.
 *
 * A model whose thinking binds mints each block for the request it came in.
 * Once anything before the block differs (a fold, an edit, a changed tool list
 * or system text), an account either refuses the request, drops the block on
 * its own, or still shows it to the model. Which one depends on the account as
 * well as the model, and nothing says ahead of time. Left out ahead of time
 * (agent-framework's `thinkingBinding.binds`), such a block costs nothing on
 * the first two: the provider would refuse it or drop it, and its drop control
 * drops every later block with it. On the third it's reasoning the model would
 * have read.
 *
 * The probe mints one block under one system text, then replays it four ways:
 * under the same system text with and without the block, which shows how many
 * input tokens the block counts for when it's valid, and under a changed one
 * with and without it. A refusal there means the account refuses; the same
 * count as without the block means it dropped it; the block's count means it
 * showed it. Anything else (no signed block, the block counting for nothing
 * under its own head, an error, the timeout) decides nothing, and the agent
 * leaves such thinking out as before.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { ContentBlock, Membrane, NormalizedMessage, NormalizedResponse } from '@animalabs/membrane';
import {
  accountBinding, accountBindingKey, isBindingRefusal, modelAcceptsAdaptiveThinking, modelThinking, recordAccountBinding,
  type AccountBinding,
} from './logging-adapter.js';

const HEAD_MINTED = 'You answer arithmetic questions. Session A.';
const HEAD_CHANGED = 'You answer arithmetic questions. Session B.';
const QUESTION = 'What is 4817 × 263? Work it out, then reply with the product only.';
/** Under adaptive thinking the model may answer without thinking; a request that minted no signed block is tried again. */
const MINT_ATTEMPTS = 3;
const FOLLOW_UP = 'Thanks.';
const DEFAULT_TIMEOUT_MS = 60_000;
/** Fewer input tokens than this for a valid block, and the counts can't tell it apart from the system texts' difference. */
const MIN_BLOCK_TOKENS = 8;

export interface BindingProbeResult {
  model: string;
  /** Undefined when the probe couldn't tell. */
  binding?: AccountBinding;
  detail: string;
}

type Completer = Pick<Membrane, 'complete'>;

function inputTokens(response: NormalizedResponse): number {
  const usage = (response.details?.usage ?? response.usage) as { inputTokens: number; cacheCreationTokens?: number; cacheReadTokens?: number };
  return usage.inputTokens + (usage.cacheCreationTokens ?? 0) + (usage.cacheReadTokens ?? 0);
}

export { isBindingRefusal };

function describe(error: unknown): string {
  const message = String((error as { message?: unknown } | null)?.message ?? error);
  return message.length > 160 ? `${message.slice(0, 157)}...` : message;
}

/** One probe of `model` through `membrane`, whose assistant participant is `assistant`. */
export async function probeThinkingBinding(
  membrane: Completer,
  model: string,
  assistant: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<BindingProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const options = { signal: controller.signal };
  const adaptive = modelAcceptsAdaptiveThinking(model);
  const thinking = adaptive ? { enabled: true, type: 'adaptive' as const } : { enabled: true, budgetTokens: 1024 };
  // Membrane sends an explicit budget of at most maxTokens - 1024.
  const replyTokens = adaptive ? 256 : 2048;
  try {
    const isSigned = (block: ContentBlock) =>
      (block.type === 'thinking' && typeof block.signature === 'string' && block.signature !== '') || block.type === 'redacted_thinking';
    let minted: NormalizedResponse | undefined;
    for (let attempt = 0; attempt < MINT_ATTEMPTS && !minted?.content.some(isSigned); attempt++) {
      try {
        minted = await membrane.complete({
          system: HEAD_MINTED,
          messages: [{ participant: 'user', content: [{ type: 'text', text: QUESTION }] }],
          config: { model, maxTokens: 4096, thinking },
        }, options);
      } catch (error) {
        return { model, detail: `the first request failed: ${describe(error)}` };
      }
    }
    if (!minted?.content.some(isSigned)) return { model, detail: `no signed thinking came back to replay in ${MINT_ATTEMPTS} requests` };
    const text = minted.content.filter((block) => block.type === 'text');
    if (text.length === 0) return { model, detail: 'the first reply had no text to replay with the thinking' };
    const withBlock = minted.content.filter((block) => block.type === 'thinking' || block.type === 'redacted_thinking' || block.type === 'text');
    const conversation = (reply: ContentBlock[]): NormalizedMessage[] => [
      { participant: 'user', content: [{ type: 'text', text: QUESTION }] },
      { participant: assistant, content: reply },
      { participant: 'user', content: [{ type: 'text', text: FOLLOW_UP }] },
    ];
    const replay = (system: string, reply: ContentBlock[]) => membrane.complete({
      system,
      messages: conversation(reply),
      config: { model, maxTokens: replyTokens, thinking },
    }, options);
    const [sameWith, sameWithout, changedWith, changedWithout] = await Promise.allSettled([
      replay(HEAD_MINTED, withBlock),
      replay(HEAD_MINTED, text),
      replay(HEAD_CHANGED, withBlock),
      replay(HEAD_CHANGED, text),
    ]);
    if (changedWith.status === 'rejected' && isBindingRefusal(changedWith.reason)) {
      return { model, binding: 'refuses', detail: 'the replay under a changed system text was refused' };
    }
    const failed = [sameWith, sameWithout, changedWith, changedWithout].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    if (failed) return { model, detail: `a replay failed: ${describe(failed.reason)}` };
    const count = (r: PromiseSettledResult<NormalizedResponse>) => inputTokens((r as PromiseFulfilledResult<NormalizedResponse>).value);
    const valid = count(sameWith) - count(sameWithout);
    const changed = count(changedWith) - count(changedWithout);
    if (valid < MIN_BLOCK_TOKENS) {
      return { model, detail: `the block counted for ${valid} input tokens under its own system text, too few to measure` };
    }
    if (changed >= valid / 2) {
      return { model, binding: 'shows', detail: `the block counted for ${changed} input tokens under a changed system text and ${valid} under its own` };
    }
    if (changed <= valid / 10) {
      return { model, binding: 'drops', detail: `the block counted for ${changed} input tokens under a changed system text and ${valid} under its own` };
    }
    return { model, detail: `the block counted for ${changed} input tokens under a changed system text and ${valid} under its own, neither all nor none` };
  } finally {
    clearTimeout(timer);
  }
}

const OUTCOME: Record<AccountBinding, string> = {
  refuses: 'refuses a signed thinking block whose earlier conversation changed, so such thinking is left out',
  drops: 'drops a signed thinking block whose earlier conversation changed, so such thinking is left out',
  shows: 'still shows the model a signed thinking block whose earlier conversation changed, so thinking is sent as stored, without the drop control',
};

export interface AccountBindingProbeOptions {
  provider?: string;
  formatter?: string;
  /** Membrane's assistant participant, the agent's name. */
  assistant: string;
  /** The agent's model and its subagents' default model; repeats (by the model record's row) and undefined are skipped. */
  models: Array<string | undefined>;
  /** Where the last outcome the probe could decide is kept, per route and model row, for a start at which it can't. */
  stateFile?: string;
  /** What names the route the probe goes over, such as the provider and its base URL. */
  route?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
}

/**
 * Probe each model whose thinking binds, at start, before any agent config is
 * built, and record what was found for agent configs, the request adapter and
 * `/budget` to read. Off for the mock provider, under the anthropic-xml
 * formatter (whose transcript renders no thinking), and with
 * `THINKING_BINDING_PROBE=off`, as for a provider-free rehearsal.
 */
export async function probeAccountBinding(membrane: Completer, options: AccountBindingProbeOptions): Promise<BindingProbeResult[]> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.error(line));
  const switchedOff = /^(off|0|false|no)$/i.test((env.THINKING_BINDING_PROBE ?? '').trim());
  if (switchedOff || options.provider === 'mock' || options.formatter === 'anthropic-xml') return [];
  const byRow = new Map<string, string>();
  for (const model of options.models) {
    if (typeof model !== 'string' || model === '' || !modelThinking(model).binds || accountBinding(model) !== undefined) continue;
    if (!byRow.has(accountBindingKey(model))) byRow.set(accountBindingKey(model), model);
  }
  const results = await Promise.all([...byRow.values()].map((model) => probeThinkingBinding(membrane, model, options.assistant, options.timeoutMs)));
  const saved = readSaved(options.stateFile);
  const entry = (model: string) => `${options.route ?? options.provider ?? ''}|${accountBindingKey(model)}`;
  let changed = false;
  const fallsBack = (model: string) => options.provider === 'anthropic' && modelThinking(model).dropBlock;
  for (const result of results) {
    const last = result.binding ? undefined : saved[entry(result.model)];
    const binding = result.binding ?? last?.binding;
    if (binding === 'shows' && !fallsBack(result.model)) {
      // Kept only where the drop control can stand in if a gateway moves the
      // agent to an account that refuses such a block (logging-adapter's stream()).
      log(`[thinking-binding] ${result.model}: this account still shows the model a signed thinking block whose earlier conversation changed (${last ? `as found ${last.at}` : result.detail}), but this route has no drop control to fall back on, so such thinking is left out.`);
      continue;
    }
    if (result.binding) {
      saved[entry(result.model)] = { binding: result.binding, at: new Date().toISOString() };
      changed = true;
      log(`[thinking-binding] ${result.model}: this account ${OUTCOME[result.binding]} (${result.detail}).`);
    } else {
      log(`[thinking-binding] ${result.model}: the probe couldn't tell what this account does with a signed thinking block whose earlier conversation changed (${result.detail}), ` +
        (last ? `so what it found ${last.at} stands: it ${OUTCOME[last.binding]}.` : 'so such thinking is left out.'));
    }
    if (binding) recordAccountBinding(result.model, binding);
  }
  if (changed && options.stateFile) {
    try {
      writeFileSync(`${options.stateFile}.tmp`, `${JSON.stringify(saved, null, 2)}\n`);
      renameSync(`${options.stateFile}.tmp`, options.stateFile);
    } catch (error) {
      log(`[thinking-binding] couldn't keep the outcome in ${options.stateFile}: ${describe(error)}`);
    }
  }
  return results;
}

type SavedBindings = Record<string, { binding: AccountBinding; at: string }>;

function readSaved(file: string | undefined): SavedBindings {
  if (!file) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: SavedBindings = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const v = value as { binding?: unknown; at?: unknown } | null;
      if (v && (v.binding === 'refuses' || v.binding === 'drops' || v.binding === 'shows') && typeof v.at === 'string') {
        out[key] = { binding: v.binding, at: v.at };
      }
    }
    return out;
  } catch {
    return {};
  }
}
