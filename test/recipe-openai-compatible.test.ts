/**
 * `agent.provider: 'openai-compatible'` — membrane has shipped a generic
 * OpenAI chat-completions adapter (Ollama, vLLM, Together, Groq, local
 * servers...) that no host wired. The recipe must name the endpoint and the
 * model, and both must be checked at load time: a missing baseUrl would
 * otherwise surface as a fetch to `undefined/chat/completions` at first
 * inference, and a missing model as whatever the endpoint's default happens
 * to be.
 */
import { describe, expect, test } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';

function recipe(agent: Record<string, unknown>) {
  return { name: 'compat-test', agent: { systemPrompt: 'sys', ...agent } };
}

describe('recipe agent.provider openai-compatible', () => {
  test('accepts an http local endpoint with a model', () => {
    const r = validateRecipe(recipe({ provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', model: 'qwen3:32b' }));
    expect(r.agent.provider).toBe('openai-compatible');
    expect(r.agent.baseUrl).toBe('http://localhost:11434/v1');
    expect(r.agent.model).toBe('qwen3:32b');
  });

  test('accepts an https gateway', () => {
    const r = validateRecipe(recipe({ provider: 'openai-compatible', baseUrl: 'https://nano-gpt.com/api/v1', model: 'xiaomi/mimo-v2.5-pro:thinking' }));
    expect(r.agent.baseUrl).toBe('https://nano-gpt.com/api/v1');
  });

  test('requires baseUrl', () => {
    expect(() => validateRecipe(recipe({ provider: 'openai-compatible', model: 'm' }))).toThrow(/agent\.baseUrl is required/);
    expect(() => validateRecipe(recipe({ provider: 'openai-compatible', baseUrl: '   ', model: 'm' }))).toThrow(/agent\.baseUrl is required/);
  });

  test('requires an absolute http(s) URL', () => {
    expect(() => validateRecipe(recipe({ provider: 'openai-compatible', baseUrl: 'localhost:11434/v1', model: 'm' }))).toThrow(/absolute http\(s\) URL|http or https/);
    expect(() => validateRecipe(recipe({ provider: 'openai-compatible', baseUrl: 'ftp://host/v1', model: 'm' }))).toThrow(/http or https/);
  });

  test('requires an explicit model (no default for an arbitrary endpoint)', () => {
    expect(() => validateRecipe(recipe({ provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' }))).toThrow(/agent\.model is required/);
  });

  test('rejects baseUrl with any other provider', () => {
    expect(() => validateRecipe(recipe({ provider: 'anthropic', baseUrl: 'http://x/v1' }))).toThrow(/only applies to agent\.provider 'openai-compatible'/);
    expect(() => validateRecipe(recipe({ baseUrl: 'http://x/v1' }))).toThrow(/got provider "anthropic"/);
    expect(() => validateRecipe(recipe({ provider: 'openai-codex', baseUrl: 'http://x/v1' }))).toThrow(/got provider "openai-codex"/);
  });

  test('other providers are untouched', () => {
    expect(validateRecipe(recipe({ provider: 'openai-codex', model: 'gpt-5.4' })).agent.baseUrl).toBeUndefined();
    expect(validateRecipe(recipe({})).agent.provider ?? 'anthropic').toBe('anthropic');
  });
});
