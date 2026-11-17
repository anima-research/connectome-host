import { afterEach, beforeEach, describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearModelFacts, factsFromApi, loadModelFacts, modelFacts, refreshModelFacts } from '../src/model-facts.js';
import { getDefaultModelLimits } from '../src/model-limits.js';

const sample = (id: string, extra: Record<string, unknown> = {}) => ({
  id, type: 'model', display_name: `Claude ${id}`, created_at: '2026-09-21T00:00:00Z', lifecycle: 'active',
  max_input_tokens: 1_000_000, max_tokens: 128_000,
  capabilities: {
    effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: false } },
    thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false }, between_tools: { supported: true }, disabled: { supported: true } } },
  },
  ...extra,
});

const fetchOf = (answer: (url: string) => { status: number; body?: unknown } | Error) => {
  const urls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    headers.push(Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)));
    const a = answer(url);
    if (a instanceof Error) throw a;
    return new Response(a.body === undefined ? '' : JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: f, urls, headers };
};

describe('model facts from the Models API', () => {
  let dir: string;
  let said: string[];
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'model-facts-')); said = []; clearModelFacts(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); clearModelFacts(); });
  const file = () => join(dir, 'model-facts.json');
  const log = (line: string) => { said.push(line); };

  test('factsFromApi reads the fields the host wants and leaves out what the API left null', () => {
    const read = factsFromApi(sample('claude-opus-5-5', { max_tokens: null, retires_at: null, deprecated_at: null }), '2026-11-17T00:00:00.000Z');
    expect(read).toEqual({
      id: 'claude-opus-5-5', readAt: '2026-11-17T00:00:00.000Z', displayName: 'Claude claude-opus-5-5', maxInputTokens: 1_000_000,
      effort: { low: true, medium: true, high: true, xhigh: true, max: false },
      thinking: { adaptive: true, enabled: false, betweenTools: true, disabled: true },
      lifecycle: 'active',
    });
    expect(factsFromApi({ type: 'error' }, 'x')).toBeUndefined();
    expect(factsFromApi(null, 'x')).toBeUndefined();
  });

  test('a model with no row in the table gets its window from the API, and the next start loads it from the file', async () => {
    const model = 'claude-haiku-6';
    expect(getDefaultModelLimits(model)).toBeUndefined();
    const { fetch, urls, headers } = fetchOf((url) => ({ status: 200, body: sample(url.split('/').pop()!) }));
    await refreshModelFacts({ models: [model, 'claude-opus-4-6', model, undefined], stateFile: file(), apiKey: 'sk-test', fetch, log, now: () => new Date('2026-11-17T12:00:00Z') });
    expect(urls.sort()).toEqual(['https://api.anthropic.com/v1/models/claude-haiku-6', 'https://api.anthropic.com/v1/models/claude-opus-4-6']);
    expect(headers[0]).toMatchObject({ 'x-api-key': 'sk-test', 'anthropic-version': '2026-10-21' });
    expect(getDefaultModelLimits(model)).toEqual({ maxContextTokens: 1_000_000, maxOutputTokens: 128_000 });
    expect(modelFacts(model)?.effort?.max).toBe(false);
    expect(said).toEqual([]);
    // The file holds both, and a fresh process reads them back before any request.
    const saved = JSON.parse(readFileSync(file(), 'utf8'));
    expect(Object.keys(saved).sort()).toEqual(['claude-haiku-6', 'claude-opus-4-6']);
    expect(saved[model].readAt).toBe('2026-11-17T12:00:00.000Z');
    clearModelFacts();
    expect(getDefaultModelLimits(model)).toBeUndefined();
    expect(loadModelFacts(file())).toBe(2);
    expect(getDefaultModelLimits(model)).toEqual({ maxContextTokens: 1_000_000, maxOutputTokens: 128_000 });
  });

  test('an alias resolves: the facts are kept under the name the recipe used and the id the API answered with', async () => {
    const { fetch } = fetchOf(() => ({ status: 200, body: sample('claude-sonnet-5-5-20260601') }));
    await refreshModelFacts({ models: ['claude-sonnet-5-5'], stateFile: file(), apiKey: 'k', fetch, log });
    expect(modelFacts('claude-sonnet-5-5')?.id).toBe('claude-sonnet-5-5-20260601');
    expect(modelFacts('claude-sonnet-5-5-20260601')?.id).toBe('claude-sonnet-5-5-20260601');
  });

  test('a 404, another status, a network error or an answer with no model leave the saved facts, then the table, standing, said once each', async () => {
    writeFileSync(file(), JSON.stringify({ 'claude-x': { id: 'claude-x', readAt: '2026-11-01T00:00:00.000Z', maxInputTokens: 500_000, maxOutputTokens: 64_000 } }));
    loadModelFacts(file());
    const { fetch } = fetchOf((url) => {
      if (url.endsWith('claude-unknown')) return { status: 404, body: { type: 'error' } };
      if (url.endsWith('claude-x')) return { status: 503, body: {} };
      if (url.endsWith('claude-y')) return new Error('ECONNREFUSED');
      return { status: 200, body: { type: 'not-a-model' } };
    });
    await refreshModelFacts({ models: ['claude-unknown', 'claude-x', 'claude-y', 'claude-z'], stateFile: file(), apiKey: 'k', fetch, log });
    expect(said.sort()).toEqual([
      "[model-facts] claude-unknown: the models API doesn't know this id, so the host's own table stands for it.",
      '[model-facts] claude-x: the models API answered 503, so what was read 2026-11-01T00:00:00.000Z stands.',
      "[model-facts] claude-y: the models API couldn't be read (ECONNREFUSED), so the host's own table stands.",
      "[model-facts] claude-z: the models API's answer had no model in it, so the host's own table stands.",
    ].sort());
    // The saved facts still apply, and the known table still answers for its rows.
    expect(getDefaultModelLimits('claude-x')).toEqual({ maxContextTokens: 500_000, maxOutputTokens: 64_000 });
    expect(getDefaultModelLimits('claude-opus-4-6')).toEqual({ maxContextTokens: 1_000_000, maxOutputTokens: 128_000 });
    expect(getDefaultModelLimits('claude-haiku-4-5-20251001')).toEqual({ maxContextTokens: 200_000, maxOutputTokens: 64_000 });
    // Nothing new was read, so the file is as it was.
    expect(Object.keys(JSON.parse(readFileSync(file(), 'utf8')))).toEqual(['claude-x']);
  });

  test('a model past active is said once with its retirement date', async () => {
    const { fetch } = fetchOf(() => ({ status: 200, body: sample('claude-sonnet-4-5', { lifecycle: 'deprecated', deprecated_at: '2026-10-01T00:00:00Z', retires_at: '2027-01-15T00:00:00Z' }) }));
    await refreshModelFacts({ models: ['claude-sonnet-4-5'], stateFile: file(), apiKey: 'k', fetch, log });
    expect(said).toEqual(['[model-facts] claude-sonnet-4-5 is deprecated, retiring 2027-01-15T00:00:00Z: a resident on it should move before then.']);
    expect(modelFacts('claude-sonnet-4-5')?.retiresAt).toBe('2027-01-15T00:00:00Z');
  });

  test('a bearer token, a gateway base URL, the off switch, and no key', async () => {
    const { fetch, urls, headers } = fetchOf(() => ({ status: 200, body: sample('claude-opus-5-5') }));
    await refreshModelFacts({ models: ['claude-opus-5-5'], stateFile: file(), authToken: 'tok', baseURL: 'https://gw.example.com/anthropic/', fetch, log });
    expect(urls).toEqual(['https://gw.example.com/anthropic/v1/models/claude-opus-5-5']);
    expect(headers[0]).toMatchObject({ authorization: 'Bearer tok' });
    expect(headers[0]['x-api-key']).toBeUndefined();
    const off = fetchOf(() => ({ status: 200, body: sample('claude-opus-5-5') }));
    await refreshModelFacts({ models: ['claude-opus-5-5'], stateFile: join(dir, 'other.json'), apiKey: 'k', fetch: off.fetch, log, env: { MODEL_FACTS: 'off' } });
    await refreshModelFacts({ models: ['claude-opus-5-5'], stateFile: join(dir, 'other.json'), fetch: off.fetch, log });
    expect(off.urls).toEqual([]);
    expect(existsSync(join(dir, 'other.json'))).toBe(false);
  });
});
