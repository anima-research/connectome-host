import { describe, it, expect } from 'bun:test';
import { isClientMessage } from '../src/web/protocol.js';

describe('settings messages — wire validation', () => {
  it('accepts a minimal budget update', () => {
    expect(isClientMessage({ type: 'settings-update', contextBudgetTokens: 120_000 })).toBe(true);
  });

  it('accepts tail-only and pace-only updates', () => {
    expect(isClientMessage({ type: 'settings-update', tailTokens: 30_000 })).toBe(true);
    expect(isClientMessage({ type: 'settings-update', transitionPaceTokens: 8_000 })).toBe(true);
  });

  it('accepts persist/notify flags and an agent name', () => {
    expect(isClientMessage({
      type: 'settings-update',
      contextBudgetTokens: 100_000,
      persist: false,
      notify: true,
      agent: 'mythos',
    })).toBe(true);
  });

  it('rejects an empty patch — it would throw downstream', () => {
    expect(isClientMessage({ type: 'settings-update' })).toBe(false);
    expect(isClientMessage({ type: 'settings-update', persist: true })).toBe(false);
  });

  it('rejects non-integer / non-positive / stringly token counts', () => {
    for (const bad of ['100000', 100.5, -1, 0, NaN, Infinity, null, {}]) {
      expect(isClientMessage({ type: 'settings-update', contextBudgetTokens: bad }))
        .toBe(false);
    }
  });

  it('rejects non-boolean flags and empty agent names', () => {
    expect(isClientMessage({ type: 'settings-update', contextBudgetTokens: 1, persist: 'yes' })).toBe(false);
    expect(isClientMessage({ type: 'settings-update', contextBudgetTokens: 1, notify: 1 })).toBe(false);
    expect(isClientMessage({ type: 'settings-update', contextBudgetTokens: 1, agent: '' })).toBe(false);
  });

  it('validates reset and cancel shapes', () => {
    expect(isClientMessage({ type: 'settings-reset' })).toBe(true);
    expect(isClientMessage({ type: 'settings-reset', keys: ['contextBudgetTokens'] })).toBe(true);
    expect(isClientMessage({ type: 'settings-reset', keys: 'contextBudgetTokens' })).toBe(false);
    expect(isClientMessage({ type: 'settings-cancel-transition' })).toBe(true);
    expect(isClientMessage({ type: 'settings-cancel-transition', persist: false })).toBe(true);
    expect(isClientMessage({ type: 'settings-cancel-transition', agent: 42 })).toBe(false);
  });

  it('validates request-settings', () => {
    expect(isClientMessage({ type: 'request-settings' })).toBe(true);
    expect(isClientMessage({ type: 'request-settings', agent: 'mythos' })).toBe(true);
    expect(isClientMessage({ type: 'request-settings', agent: 7 })).toBe(false);
  });
});

describe('pin messages — wire validation', () => {
  it('accepts a single-message raw pin', () => {
    expect(isClientMessage({ type: 'pin-add', firstMessageId: 'm-1' })).toBe(true);
  });

  it('accepts a range, a document, a label, and level modes', () => {
    expect(isClientMessage({ type: 'pin-add', firstMessageId: 'm-1', lastMessageId: 'm-9' })).toBe(true);
    expect(isClientMessage({ type: 'pin-add', kind: 'document', firstMessageId: 'm-1' })).toBe(true);
    expect(isClientMessage({ type: 'pin-add', firstMessageId: 'm-1', name: 'seed' })).toBe(true);
    expect(isClientMessage({ type: 'pin-add', firstMessageId: 'm-1', level: 0 })).toBe(true);
    expect(isClientMessage({ type: 'pin-add', firstMessageId: 'm-1', maxLevel: 2 })).toBe(true);
  });

  it('rejects level AND maxLevel together — different semantics, ambiguous intent', () => {
    expect(isClientMessage({ type: 'pin-add', firstMessageId: 'm-1', level: 1, maxLevel: 2 })).toBe(false);
  });

  it('rejects bad levels and bad ids', () => {
    for (const bad of ['1', 1.5, -1, 33, NaN, null, {}]) {
      expect(isClientMessage({ type: 'pin-add', firstMessageId: 'm-1', level: bad })).toBe(false);
    }
    expect(isClientMessage({ type: 'pin-add', firstMessageId: '' })).toBe(false);
    expect(isClientMessage({ type: 'pin-add' })).toBe(false);
    expect(isClientMessage({ type: 'pin-add', firstMessageId: 'm-1', kind: 'bogus' })).toBe(false);
    expect(isClientMessage({ type: 'pin-add', firstMessageId: 'm-1', lastMessageId: '' })).toBe(false);
  });

  it('validates pin-remove and request-pins', () => {
    expect(isClientMessage({ type: 'pin-remove', pinId: 'pin-3' })).toBe(true);
    expect(isClientMessage({ type: 'pin-remove' })).toBe(false);
    expect(isClientMessage({ type: 'pin-remove', pinId: '' })).toBe(false);
    expect(isClientMessage({ type: 'request-pins' })).toBe(true);
    expect(isClientMessage({ type: 'request-pins', agent: 'mythos' })).toBe(true);
    expect(isClientMessage({ type: 'request-pins', agent: 5 })).toBe(false);
  });
});
