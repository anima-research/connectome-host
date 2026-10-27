import { describe, test, expect } from 'bun:test';
import { anthropicCountModel } from '../src/web/panel-data.js';

describe('anthropicCountModel', () => {
  test('strips a membrane/OpenRouter provider prefix', () => {
    expect(anthropicCountModel('anthropic/claude-opus-4-6')).toBe('claude-opus-4-6');
  });

  test('passes a bare Anthropic id through', () => {
    expect(anthropicCountModel('claude-sonnet-5')).toBe('claude-sonnet-5');
  });

  test('normalizes a Bedrock id (region + vendor prefix + version suffix)', () => {
    expect(anthropicCountModel('us.anthropic.claude-3-sonnet-20240229-v1:0'))
      .toBe('claude-3-sonnet-20240229');
  });

  test('returns null for non-Anthropic models', () => {
    expect(anthropicCountModel('openai/gpt-5.6-sol')).toBeNull();
    expect(anthropicCountModel('gemini-2.5-pro')).toBeNull();
  });

  test('returns null for undefined', () => {
    expect(anthropicCountModel(undefined)).toBeNull();
  });
});
