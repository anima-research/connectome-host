/**
 * Unit tests for the @childname direct-routing parser used by the TUI.
 */
import { describe, test, expect } from 'bun:test';
import { parseFleetRoute } from '../src/modules/fleet-types.js';

describe('parseFleetRoute', () => {
  test('routes plain @name content', () => {
    expect(parseFleetRoute('@miner hello there')).toEqual({ childName: 'miner', content: 'hello there' });
  });

  test('strips colon after name', () => {
    expect(parseFleetRoute('@miner: hello')).toEqual({ childName: 'miner', content: 'hello' });
  });

  test('accepts hyphens and dots in names', () => {
    expect(parseFleetRoute('@my-bot list channels')).toEqual({ childName: 'my-bot', content: 'list channels' });
    expect(parseFleetRoute('@bot.v2 ping')).toEqual({ childName: 'bot.v2', content: 'ping' });
  });

  test('preserves multi-line payloads', () => {
    const r = parseFleetRoute('@miner first line\nsecond line');
    expect(r?.childName).toBe('miner');
    expect(r?.content).toBe('first line\nsecond line');
  });

  test('returns null for non-@ inputs', () => {
    expect(parseFleetRoute('plain text')).toBeNull();
    expect(parseFleetRoute('  leading whitespace then text')).toBeNull();
  });

  test('returns null for @ with no payload', () => {
    expect(parseFleetRoute('@miner')).toBeNull();
    expect(parseFleetRoute('@miner ')).toBeNull();
  });

  test('returns null for @@ literal escape', () => {
    expect(parseFleetRoute('@@example.com email-like')).toBeNull();
  });

  test('tolerates leading whitespace before @', () => {
    expect(parseFleetRoute('  @miner go')).toEqual({ childName: 'miner', content: 'go' });
  });
});
