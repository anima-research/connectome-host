import { describe, expect, test } from 'bun:test';
import { isClientMessage } from '../src/web/protocol.js';

describe('credential wire messages', () => {
  test('request-credential takes an optional scope', () => {
    expect(isClientMessage({ type: 'request-credential' })).toBe(true);
    expect(isClientMessage({ type: 'request-credential', scope: 'child-a' })).toBe(true);
    expect(isClientMessage({ type: 'request-credential', scope: 7 })).toBe(false);
  });

  test('credential-action accepts the four actions; a token only with set-token, where it is required', () => {
    for (const action of ['refresh', 'login', 'recheck']) {
      expect(isClientMessage({ type: 'credential-action', action })).toBe(true);
      expect(isClientMessage({ type: 'credential-action', action, token: 'x' })).toBe(false);
    }
    expect(isClientMessage({ type: 'credential-action', action: 'set-token', token: 'sk-ant-1' })).toBe(true);
    expect(isClientMessage({ type: 'credential-action', action: 'set-token' })).toBe(false);
    expect(isClientMessage({ type: 'credential-action', action: 'set-token', token: '   ' })).toBe(false);
    expect(isClientMessage({ type: 'credential-action', action: 'set-token', token: 'x'.repeat(8193) })).toBe(false);
    expect(isClientMessage({ type: 'credential-action', action: 'rotate' })).toBe(false);
  });
});
