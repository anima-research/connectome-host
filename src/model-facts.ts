/**
 * What Anthropic's Models API says about a model, read once at start and kept
 * beside the data, so the host's deciders read a fact rather than a row.
 *
 * `GET /v1/models/{id}` returns, per model, its window and maximum output
 * (`max_input_tokens`, `max_tokens`), which `output_config.effort` levels it
 * takes, which `thinking` types it accepts, and its lifecycle (`active`,
 * `deprecated`, `retired`, with `retires_at`). The host kept each of these in
 * a table of its own, updated by hand after a release (#693); a model with no
 * row ran with no known window, no effort and no thinking until one landed.
 *
 * The file `model-facts.json` in the data directory holds the last read per
 * model id. The recipe is loaded against the host's own tables alone; then the
 * saved facts are loaded, this start's read replaces what it could read, and
 * the fit is decided once, on those, so a stale file can't refuse a start
 * that a read would have passed. Where the API can't be read (no key, no
 * network, a gateway that doesn't serve it, a model it doesn't know) the saved
 * facts stand, then the host's own tables; `MODEL_FACTS=off` skips both the
 * load and the read.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

export type EffortLevelName = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelFacts {
  /** The id as the API named it (an alias resolves to it). */
  id: string;
  readAt: string;
  displayName?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  effort?: Partial<Record<EffortLevelName, boolean>>;
  thinking?: { adaptive?: boolean; enabled?: boolean; betweenTools?: boolean; disabled?: boolean };
  lifecycle?: 'active' | 'deprecated' | 'retired';
  deprecatedAt?: string;
  retiresAt?: string;
}

const facts = new Map<string, ModelFacts>();

/** The facts kept for `model`: under the id as the recipe names it, or as the API resolved it. */
export function modelFacts(model: string): ModelFacts | undefined {
  return facts.get(model) ?? facts.get(model.toLowerCase());
}

/** For tests. */
export function clearModelFacts(): void {
  facts.clear();
}

export function installModelFacts(name: string, read: ModelFacts): void {
  facts.set(name, read);
  facts.set(read.id, read);
}

type Saved = Record<string, ModelFacts>;

/** `MODEL_FACTS=off` (or 0, false, no): neither the file nor the API is read. */
export function modelFactsOff(env: Record<string, string | undefined> = process.env): boolean {
  return /^(off|0|false|no)$/.test((env.MODEL_FACTS ?? '').trim().toLowerCase());
}

/**
 * A kept entry with the same checks `factsFromApi` applies to the API's
 * answer: a window or output that isn't a finite positive number, a flag that
 * isn't a boolean, or a lifecycle the host doesn't name is dropped, so the
 * table answers for it rather than a damaged file.
 */
function sanitizeFacts(read: ModelFacts): ModelFacts {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
  const flags = <T extends Record<string, unknown>>(v: unknown): Partial<T> | undefined => {
    if (!v || typeof v !== 'object') return undefined;
    const out: Record<string, boolean> = {};
    for (const [k, b] of Object.entries(v as Record<string, unknown>)) if (typeof b === 'boolean') out[k] = b;
    return Object.keys(out).length ? (out as Partial<T>) : undefined;
  };
  const lifecycle = read.lifecycle === 'active' || read.lifecycle === 'deprecated' || read.lifecycle === 'retired' ? read.lifecycle : undefined;
  const effort = flags<NonNullable<ModelFacts['effort']>>(read.effort);
  const thinking = flags<NonNullable<ModelFacts['thinking']>>(read.thinking);
  return {
    id: read.id,
    readAt: read.readAt,
    ...(typeof read.displayName === 'string' ? { displayName: read.displayName } : {}),
    ...(num(read.maxInputTokens) !== undefined ? { maxInputTokens: num(read.maxInputTokens) } : {}),
    ...(num(read.maxOutputTokens) !== undefined ? { maxOutputTokens: num(read.maxOutputTokens) } : {}),
    ...(effort ? { effort } : {}),
    ...(thinking ? { thinking } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    ...(typeof read.deprecatedAt === 'string' ? { deprecatedAt: read.deprecatedAt } : {}),
    ...(typeof read.retiresAt === 'string' ? { retiresAt: read.retiresAt } : {}),
  };
}

/**
 * Load the facts a previous start kept. Called after the recipe is loaded
 * against the tables, and before this start's read; a no-op under
 * `MODEL_FACTS=off`. Each entry is checked as the API's answer is.
 */
export function loadModelFacts(stateFile: string, env: Record<string, string | undefined> = process.env): number {
  if (modelFactsOff(env)) return 0;
  let saved: Saved;
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 0;
    saved = parsed as Saved;
  } catch {
    return 0;
  }
  let n = 0;
  for (const [name, read] of Object.entries(saved)) {
    if (read && typeof read === 'object' && typeof read.id === 'string' && typeof read.readAt === 'string') {
      installModelFacts(name, sanitizeFacts(read));
      n++;
    }
  }
  return n;
}

/** The fields the host reads off the API's ModelInfo, defensively: the SDK's types may lag the API. */
export function factsFromApi(body: unknown, readAt: string): ModelFacts | undefined {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b.id !== 'string') return undefined;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
  const supported = (v: unknown) => {
    const s = (v as { supported?: unknown } | null)?.supported;
    return typeof s === 'boolean' ? s : undefined;
  };
  const caps = (b.capabilities ?? {}) as Record<string, unknown>;
  const effortCaps = (caps.effort ?? {}) as Record<string, unknown>;
  const thinkingTypes = ((caps.thinking as Record<string, unknown> | undefined)?.types ?? {}) as Record<string, unknown>;
  const effort: ModelFacts['effort'] = {};
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
    const s = supported(effortCaps[level]);
    if (s !== undefined) effort[level] = s;
  }
  const thinking: ModelFacts['thinking'] = {};
  for (const [key, field] of [['adaptive', 'adaptive'], ['enabled', 'enabled'], ['between_tools', 'betweenTools'], ['disabled', 'disabled']] as const) {
    const s = supported(thinkingTypes[key]);
    if (s !== undefined) thinking[field] = s;
  }
  const lifecycle = b.lifecycle === 'active' || b.lifecycle === 'deprecated' || b.lifecycle === 'retired' ? b.lifecycle : undefined;
  return {
    id: b.id,
    readAt,
    ...(typeof b.display_name === 'string' ? { displayName: b.display_name } : {}),
    ...(num(b.max_input_tokens) !== undefined ? { maxInputTokens: num(b.max_input_tokens) } : {}),
    ...(num(b.max_tokens) !== undefined ? { maxOutputTokens: num(b.max_tokens) } : {}),
    ...(Object.keys(effort).length ? { effort } : {}),
    ...(Object.keys(thinking).length ? { thinking } : {}),
    ...(lifecycle ? { lifecycle } : {}),
    ...(typeof b.deprecated_at === 'string' ? { deprecatedAt: b.deprecated_at } : {}),
    ...(typeof b.retires_at === 'string' ? { retiresAt: b.retires_at } : {}),
  };
}

export interface RefreshModelFactsOptions {
  /** The models the recipe names; repeats and undefined are skipped. */
  models: Array<string | undefined>;
  stateFile: string;
  /** `ANTHROPIC_BASE_URL`, where a gateway stands in for the API. */
  baseURL?: string;
  apiKey?: string;
  authToken?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  now?: () => Date;
}

const API_VERSION = '2026-10-21';

export interface RefreshModelFactsResult {
  /** The names (as the recipe gave them) whose facts this start's read replaced. */
  read: string[];
  /** Why nothing was read, when nothing was. */
  skipped?: 'off' | 'no-credential' | 'gateway' | 'no-models';
}

/**
 * Read each model the recipe names from the Models API, once, at start, and
 * keep what came back for this start's deciders and the next start's load.
 * Off with `MODEL_FACTS=off`; without a credential, and behind a gateway
 * (`ANTHROPIC_BASE_URL`) without `MODEL_FACTS=on`, nothing is read and that
 * is said once. A model the API doesn't know, a request that fails, or a
 * gateway that answers with something else leaves the saved facts, then the
 * tables, standing, and is said once. A model whose lifecycle isn't `active`
 * is said once with its retirement date, since nothing told an operator
 * before inference failed. Returns which names this start's read replaced,
 * so the caller can tell a fit decided on fresh facts from one on saved ones.
 */
export async function refreshModelFacts(options: RefreshModelFactsOptions): Promise<RefreshModelFactsResult> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.error(line));
  const setting = (env.MODEL_FACTS ?? '').trim().toLowerCase();
  if (modelFactsOff(env)) return { read: [], skipped: 'off' };
  if (!options.apiKey && !options.authToken) {
    log("[model-facts] not read: no Anthropic credential for the models API, so what was kept stands, then the host's own table.");
    return { read: [], skipped: 'no-credential' };
  }
  // Facts about Anthropic's models come from Anthropic's API. Behind a
  // gateway or a stand-in (ANTHROPIC_BASE_URL set) the endpoint may not be
  // served, and an unmodelled request can fail a harness's whole run, so
  // such a route is asked only when MODEL_FACTS=on says the gateway serves it.
  if (options.baseURL && !/^(on|1|true|yes)$/.test(setting)) {
    log("[model-facts] not read behind ANTHROPIC_BASE_URL: set MODEL_FACTS=on if the gateway serves /v1/models; what was kept stands, then the host's own table.");
    return { read: [], skipped: 'gateway' };
  }
  const doFetch = options.fetch ?? fetch;
  const base = (options.baseURL ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  const names = [...new Set(options.models.filter((m): m is string => typeof m === 'string' && m !== ''))];
  if (names.length === 0) return { read: [], skipped: 'no-models' };
  const saved = readSaved(options.stateFile);
  const read_: string[] = [];
  let changed = false;
  await Promise.all(names.map(async (name) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
    try {
      const headers: Record<string, string> = { 'anthropic-version': API_VERSION, accept: 'application/json' };
      if (options.authToken) headers.authorization = `Bearer ${options.authToken}`;
      else headers['x-api-key'] = options.apiKey!;
      const response = await doFetch(`${base}/v1/models/${encodeURIComponent(name)}`, { headers, signal: controller.signal });
      if (response.status === 404) {
        log(`[model-facts] ${name}: the models API doesn't know this id, so ${standing(saved[name])}.`);
        return;
      }
      if (!response.ok) {
        log(`[model-facts] ${name}: the models API answered ${response.status}, so ${standing(saved[name])}.`);
        return;
      }
      const read = factsFromApi(await response.json(), (options.now?.() ?? new Date()).toISOString());
      if (!read) {
        log(`[model-facts] ${name}: the models API's answer had no model in it, so ${standing(saved[name])}.`);
        return;
      }
      saved[name] = read;
      installModelFacts(name, read);
      read_.push(name);
      changed = true;
      if (read.lifecycle && read.lifecycle !== 'active') {
        log(`[model-facts] ${name} is ${read.lifecycle}${read.retiresAt ? `, retiring ${read.retiresAt}` : ''}: a resident on it ${read.lifecycle === 'retired' ? 'cannot run' : 'should move before then'}.`);
      }
    } catch (error) {
      log(`[model-facts] ${name}: the models API couldn't be read (${describe(error)}), so ${standing(saved[name])}.`);
    } finally {
      clearTimeout(timer);
    }
  }));
  if (changed) {
    try {
      writeFileSync(`${options.stateFile}.tmp`, `${JSON.stringify(saved, null, 2)}\n`);
      renameSync(`${options.stateFile}.tmp`, options.stateFile);
    } catch (error) {
      log(`[model-facts] couldn't keep what was read in ${options.stateFile}: ${describe(error)}`);
    }
  }
  return { read: read_ };
}

function standing(last: ModelFacts | undefined): string {
  return last ? `what was read ${last.readAt} stands` : "the host's own table stands";
}

function readSaved(file: string): Saved {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Saved) : {};
  } catch {
    return {};
  }
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 200 ? `${message.slice(0, 197)}...` : message;
}
