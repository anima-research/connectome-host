import { describe, test, expect } from 'bun:test';
import { resolveQuitConfirm } from '../src/tui.js';

describe('resolveQuitConfirm', () => {
  test('only explicit consent kills', () => {
    expect(resolveQuitConfirm('y')).toBe('kill');
    expect(resolveQuitConfirm('yes')).toBe('kill');
    expect(resolveQuitConfirm('YES')).toBe('kill');
  });

  test('re-typing the quit command confirms, not cancels', () => {
    expect(resolveQuitConfirm('/quit')).toBe('kill');
    expect(resolveQuitConfirm('/q')).toBe('kill');
    expect(resolveQuitConfirm('quit')).toBe('kill');
    expect(resolveQuitConfirm('q')).toBe('kill');
  });

  test('detach', () => {
    expect(resolveQuitConfirm('d')).toBe('detach');
    expect(resolveQuitConfirm('detach')).toBe('detach');
  });

  test('explicit and empty cancels (Enter takes the advertised [y/N/d] default)', () => {
    expect(resolveQuitConfirm('')).toBe('cancel');
    expect(resolveQuitConfirm('  ')).toBe('cancel');
    expect(resolveQuitConfirm('n')).toBe('cancel');
    expect(resolveQuitConfirm('no')).toBe('cancel');
    expect(resolveQuitConfirm('cancel')).toBe('cancel');
  });

  test('a real message cancels AND must be restored to the input', () => {
    expect(resolveQuitConfirm('actually, first summarize what miner found')).toBe('cancel-keep-input');
    expect(resolveQuitConfirm('[paste #1: "…" 40000ch, 900L]')).toBe('cancel-keep-input');
    expect(resolveQuitConfirm('/status')).toBe('cancel-keep-input');
    expect(resolveQuitConfirm('yeah')).toBe('cancel-keep-input');
  });
});
