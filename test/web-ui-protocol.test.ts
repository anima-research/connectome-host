/**
 * Unit tests for the WebUI wire-protocol type guard. Exercises every variant
 * with both valid and malformed payloads — important because `isClientMessage`
 * is the trust boundary between unauthenticated wire bytes and handlers that
 * write to disk (mcpl-add → mcpl-servers.json), spawn processes, or fan out
 * to fleet children.
 *
 * Specific anti-regression goals:
 *   - mcpl-add with non-string id/command/args/env is rejected.
 *   - mcpl-add ids containing path separators or control chars are rejected.
 *   - The discriminant string alone is no longer enough; payload shape matters.
 */
import { describe, test, expect } from 'bun:test';
import { isClientMessage } from '../src/web/protocol.js';

describe('isClientMessage', () => {
  test('rejects non-objects and missing/wrong type', () => {
    expect(isClientMessage(null)).toBe(false);
    expect(isClientMessage(undefined)).toBe(false);
    expect(isClientMessage('hello')).toBe(false);
    expect(isClientMessage(42)).toBe(false);
    expect(isClientMessage([])).toBe(false);
    expect(isClientMessage({})).toBe(false);
    expect(isClientMessage({ type: 42 })).toBe(false);
    expect(isClientMessage({ type: 'definitely-not-real' })).toBe(false);
  });

  test('accepts simple no-payload variants', () => {
    expect(isClientMessage({ type: 'ping' })).toBe(true);
    expect(isClientMessage({ type: 'interrupt' })).toBe(true);
    expect(isClientMessage({ type: 'request-mcpl' })).toBe(true);
    expect(isClientMessage({ type: 'request-branches' })).toBe(true);
  });

  test('fleet-scope fields: optional string on scoped panel requests', () => {
    // Every panel request accepts an optional scope ('local' or a fleet
    // child name); non-string scopes are rejected at the trust boundary.
    expect(isClientMessage({ type: 'request-mcpl', scope: 'clerk' })).toBe(true);
    expect(isClientMessage({ type: 'request-mcpl', scope: 42 })).toBe(false);
    expect(isClientMessage({ type: 'request-settings', scope: 'local' })).toBe(true);
    expect(isClientMessage({ type: 'request-settings', scope: {} })).toBe(false);
    expect(isClientMessage({ type: 'request-pins', scope: 'clerk' })).toBe(true);
    expect(isClientMessage({ type: 'request-pins', scope: 42 })).toBe(false);
    expect(isClientMessage({ type: 'pin-add', scope: 'clerk', firstMessageId: 'm1' })).toBe(true);
    expect(isClientMessage({ type: 'pin-add', scope: 9, firstMessageId: 'm1' })).toBe(false);
    expect(isClientMessage({ type: 'pin-remove', scope: 'clerk', pinId: 'p1' })).toBe(true);
    expect(isClientMessage({ type: 'pin-remove', scope: 9, pinId: 'p1' })).toBe(false);
    expect(isClientMessage({ type: 'settings-update', scope: 'clerk', contextBudgetTokens: 50_000 })).toBe(true);
    expect(isClientMessage({ type: 'settings-update', scope: 9, contextBudgetTokens: 50_000 })).toBe(false);
    expect(isClientMessage({ type: 'settings-reset', scope: 'clerk' })).toBe(true);
    expect(isClientMessage({ type: 'settings-reset', scope: 9 })).toBe(false);
    expect(isClientMessage({ type: 'settings-cancel-transition', scope: 'clerk' })).toBe(true);
    expect(isClientMessage({ type: 'settings-cancel-transition', scope: 9 })).toBe(false);
  });

  test('user-message requires string content', () => {
    expect(isClientMessage({ type: 'user-message', content: 'hi' })).toBe(true);
    expect(isClientMessage({ type: 'user-message', content: '' })).toBe(true);
    expect(isClientMessage({ type: 'user-message' })).toBe(false);
    expect(isClientMessage({ type: 'user-message', content: 42 })).toBe(false);
  });

  test('command requires string command, optional string corrId', () => {
    expect(isClientMessage({ type: 'command', command: '/help' })).toBe(true);
    expect(isClientMessage({ type: 'command', command: '/help', corrId: 'abc' })).toBe(true);
    expect(isClientMessage({ type: 'command' })).toBe(false);
    expect(isClientMessage({ type: 'command', command: 42 })).toBe(false);
    expect(isClientMessage({ type: 'command', command: '/help', corrId: 99 })).toBe(false);
  });

  test('route-to-child requires non-empty childName + string content', () => {
    expect(isClientMessage({ type: 'route-to-child', childName: 'miner', content: 'go' })).toBe(true);
    expect(isClientMessage({ type: 'route-to-child', childName: '', content: 'go' })).toBe(false);
    expect(isClientMessage({ type: 'route-to-child', childName: 'miner' })).toBe(false);
    expect(isClientMessage({ type: 'route-to-child', content: 'go' })).toBe(false);
  });

  test('cancel-subagent / fleet-stop / fleet-restart require non-empty name', () => {
    for (const type of ['cancel-subagent', 'fleet-stop', 'fleet-restart'] as const) {
      expect(isClientMessage({ type, name: 'x' })).toBe(true);
      expect(isClientMessage({ type, name: '' })).toBe(false);
      expect(isClientMessage({ type })).toBe(false);
      expect(isClientMessage({ type, name: 42 })).toBe(false);
    }
  });

  test('subscribe-peek requires string scope and boolean active', () => {
    expect(isClientMessage({ type: 'subscribe-peek', scope: 'a', active: true })).toBe(true);
    expect(isClientMessage({ type: 'subscribe-peek', scope: 'a', active: false })).toBe(true);
    expect(isClientMessage({ type: 'subscribe-peek', scope: 'a' })).toBe(false);
    expect(isClientMessage({ type: 'subscribe-peek', scope: 1, active: true })).toBe(false);
    expect(isClientMessage({ type: 'subscribe-peek', scope: 'a', active: 'yes' })).toBe(false);
  });

  test('quit-confirm restricts action to the three known values', () => {
    expect(isClientMessage({ type: 'quit-confirm', action: 'kill-children' })).toBe(true);
    expect(isClientMessage({ type: 'quit-confirm', action: 'detach' })).toBe(true);
    expect(isClientMessage({ type: 'quit-confirm', action: 'cancel' })).toBe(true);
    expect(isClientMessage({ type: 'quit-confirm', action: 'rm-rf' })).toBe(false);
    expect(isClientMessage({ type: 'quit-confirm' })).toBe(false);
  });

  test('request-lessons / request-workspace-mounts: scope is optional string', () => {
    for (const type of ['request-lessons', 'request-workspace-mounts'] as const) {
      expect(isClientMessage({ type })).toBe(true);
      expect(isClientMessage({ type, scope: 'miner' })).toBe(true);
      expect(isClientMessage({ type, scope: 42 })).toBe(false);
    }
  });

  test('request-workspace-tree: mount required, scope optional', () => {
    expect(isClientMessage({ type: 'request-workspace-tree', mount: 'tickets' })).toBe(true);
    expect(isClientMessage({ type: 'request-workspace-tree', mount: 'tickets', scope: 'm' })).toBe(true);
    expect(isClientMessage({ type: 'request-workspace-tree' })).toBe(false);
    expect(isClientMessage({ type: 'request-workspace-tree', mount: '' })).toBe(false);
    expect(isClientMessage({ type: 'request-workspace-tree', mount: 42 })).toBe(false);
  });

  test('request-workspace-file: path required, scope optional', () => {
    expect(isClientMessage({ type: 'request-workspace-file', path: 'a/b.md' })).toBe(true);
    expect(isClientMessage({ type: 'request-workspace-file' })).toBe(false);
    expect(isClientMessage({ type: 'request-workspace-file', path: '' })).toBe(false);
  });

  describe('mcpl-add — anti-regression for the CSRF + malformed-payload path', () => {
    test('happy path with full optional fields', () => {
      expect(isClientMessage({
        type: 'mcpl-add',
        id: 'gitlab',
        command: '/usr/bin/gitlab-mcp',
        args: ['--read-only'],
        env: { TOKEN: 'redacted' },
        toolPrefix: 'gl',
      })).toBe(true);
    });

    test('minimal valid payload', () => {
      expect(isClientMessage({
        type: 'mcpl-add', id: 'a', command: '/x',
      })).toBe(true);
    });

    test('rejects non-string id', () => {
      expect(isClientMessage({ type: 'mcpl-add', id: 42, command: '/x' })).toBe(false);
      expect(isClientMessage({ type: 'mcpl-add', id: null, command: '/x' })).toBe(false);
    });

    test('rejects empty / oversized id', () => {
      expect(isClientMessage({ type: 'mcpl-add', id: '', command: '/x' })).toBe(false);
      const big = 'x'.repeat(129);
      expect(isClientMessage({ type: 'mcpl-add', id: big, command: '/x' })).toBe(false);
    });

    test('rejects path-separator and control chars in id', () => {
      expect(isClientMessage({ type: 'mcpl-add', id: '../etc/passwd', command: '/x' })).toBe(false);
      expect(isClientMessage({ type: 'mcpl-add', id: 'a\\b', command: '/x' })).toBe(false);
      expect(isClientMessage({ type: 'mcpl-add', id: 'a b', command: '/x' })).toBe(false);
      expect(isClientMessage({ type: 'mcpl-add', id: 'a\nb', command: '/x' })).toBe(false);
    });

    test('rejects non-string / null / empty command', () => {
      expect(isClientMessage({ type: 'mcpl-add', id: 'a', command: null })).toBe(false);
      expect(isClientMessage({ type: 'mcpl-add', id: 'a', command: 42 })).toBe(false);
      expect(isClientMessage({ type: 'mcpl-add', id: 'a', command: '' })).toBe(false);
      expect(isClientMessage({ type: 'mcpl-add', id: 'a' })).toBe(false);
    });

    test('rejects non-array / mixed-type args', () => {
      expect(isClientMessage({ type: 'mcpl-add', id: 'a', command: '/x', args: 'one' })).toBe(false);
      expect(isClientMessage({ type: 'mcpl-add', id: 'a', command: '/x', args: [1, 2] })).toBe(false);
      expect(isClientMessage({ type: 'mcpl-add', id: 'a', command: '/x', args: ['ok', 1] })).toBe(false);
    });

    test('rejects non-object / mixed-value env', () => {
      expect(isClientMessage({ type: 'mcpl-add', id: 'a', command: '/x', env: 'hi' })).toBe(false);
      expect(isClientMessage({ type: 'mcpl-add', id: 'a', command: '/x', env: ['k', 'v'] })).toBe(false);
      expect(isClientMessage({ type: 'mcpl-add', id: 'a', command: '/x', env: { K: 1 } })).toBe(false);
    });

    test('rejects non-string toolPrefix', () => {
      expect(isClientMessage({ type: 'mcpl-add', id: 'a', command: '/x', toolPrefix: 42 })).toBe(false);
      expect(isClientMessage({ type: 'mcpl-add', id: 'a', command: '/x', toolPrefix: '' })).toBe(false);
    });
  });

  describe('surgery marks and the awareness journal', () => {
    const ref = { serverId: 'discord', channelId: 'discord:g1:c1', messageId: 'm1' };

    test('rollback/suppress take an optional marks choice: none, or a scope with previewed refs', () => {
      expect(isClientMessage({ type: 'rollback', messageId: 's1' })).toBe(true);
      expect(isClientMessage({ type: 'rollback', messageId: 's1', marks: 'none' })).toBe(true);
      expect(isClientMessage({ type: 'rollback', messageId: 's1', marks: { scope: 'addressed' } })).toBe(true);
      expect(isClientMessage({ type: 'suppress', messageIds: ['s1'], marks: { scope: 'all', refs: [ref] } })).toBe(true);
      // A publication choice is never guessed: anything else is malformed.
      expect(isClientMessage({ type: 'rollback', messageId: 's1', marks: 'all' })).toBe(false);
      expect(isClientMessage({ type: 'rollback', messageId: 's1', marks: { scope: 'everyone' } })).toBe(false);
      expect(isClientMessage({ type: 'rollback', messageId: 's1', marks: { scope: 'all', refs: [{ ...ref, messageId: '' }] } })).toBe(false);
      expect(isClientMessage({ type: 'rollback', messageId: 's1', marks: { scope: 'all', extra: 1 } })).toBe(false);
      // A preview-bound confirmation names the preview's branch.
      expect(isClientMessage({ type: 'rollback', messageId: 's1', expectedSessionId: 's', expectedBranchId: 'b1' })).toBe(true);
      expect(isClientMessage({ type: 'rollback', messageId: 's1', expectedSessionId: 7 })).toBe(false);
      expect(isClientMessage({ type: 'rollback', messageId: 's1', expectedContext: { storeId: 'a', branch: 'main' } })).toBe(true);
      expect(isClientMessage({ type: 'suppress', messageIds: ['s1'], expectedContext: { storeId: '' } })).toBe(false);
      // Both fields are required: an absent one would go unchecked.
      expect(isClientMessage({ type: 'rollback', messageId: 's1', expectedContext: {} })).toBe(false);
      expect(isClientMessage({ type: 'rollback', messageId: 's1', expectedContext: { storeId: 's' } })).toBe(false);
      expect(isClientMessage({ type: 'rollback', messageId: 's1', expectedContext: { branch: 'main' } })).toBe(false);
      expect(isClientMessage({ type: 'rollback', messageId: 's1', expectedContext: { storeId: 's', branch: '' } })).toBe(false);
      expect(isClientMessage({ type: 'rollback', messageId: 's1', expectedContext: { storeId: 'a', other: 1 } })).toBe(false);
      expect(isClientMessage({ type: 'suppress', messageIds: ['s1'], expectedBranchId: '' })).toBe(false);
      expect(isClientMessage({
        type: 'rollback', messageId: 's1',
        marks: { scope: 'all', refs: Array.from({ length: 20_001 }, () => ref) },
      })).toBe(false);
    });

    test('surgery-preview names exactly the target of its op', () => {
      expect(isClientMessage({ type: 'surgery-preview', op: 'rollback', messageId: 's1' })).toBe(true);
      expect(isClientMessage({ type: 'surgery-preview', op: 'suppress', messageIds: ['s1', 's2'], corrId: 'c' })).toBe(true);
      expect(isClientMessage({ type: 'surgery-preview', op: 'rollback', messageIds: ['s1'] })).toBe(false);
      expect(isClientMessage({ type: 'surgery-preview', op: 'suppress', messageId: 's1' })).toBe(false);
      expect(isClientMessage({ type: 'surgery-preview', op: 'suppress', messageIds: [] })).toBe(false);
      expect(isClientMessage({ type: 'surgery-preview', op: 'hide', messageId: 's1' })).toBe(false);
    });

    test('awareness-action: cancel/retract/release on a target, bound to the journal it was chosen from; only retract takes all', () => {
      const bound = { expectedFrameworkInstanceId: 'fw-1' };
      expect(isClientMessage({ type: 'request-awareness' })).toBe(true);
      expect(isClientMessage({ type: 'awareness-action', action: 'cancel', target: 'b1', ...bound })).toBe(true);
      expect(isClientMessage({ type: 'awareness-action', action: 'retract', target: 'all', ...bound })).toBe(true);
      expect(isClientMessage({ type: 'awareness-action', action: 'release', target: 'b1', ...bound })).toBe(true);
      expect(isClientMessage({ type: 'awareness-action', action: 'cancel', target: 'all', ...bound })).toBe(false);
      expect(isClientMessage({ type: 'awareness-action', action: 'release', target: 'all', ...bound })).toBe(false);
      expect(isClientMessage({ type: 'awareness-action', action: 'delete', target: 'b1', ...bound })).toBe(false);
      expect(isClientMessage({ type: 'awareness-action', action: 'cancel', target: '', ...bound })).toBe(false);
      // An action names the journal listing it was chosen from.
      expect(isClientMessage({ type: 'awareness-action', action: 'retract', target: 'all' })).toBe(false);
      expect(isClientMessage({ type: 'awareness-action', action: 'retract', target: 'all', expectedFrameworkInstanceId: '' })).toBe(false);
      expect(isClientMessage({ type: 'awareness-action', action: 'retract', target: 'all', expectedFrameworkInstanceId: 7 })).toBe(false);
    });

    test("host-quiesce may be bound to a retry's previewed session and store", () => {
      expect(isClientMessage({ type: 'host-quiesce' })).toBe(true);
      expect(isClientMessage({ type: 'host-quiesce', reason: 'r', expectedSessionId: 's', expectedStoreId: 'store-a' })).toBe(true);
      expect(isClientMessage({ type: 'host-quiesce', expectedSessionId: '' })).toBe(false);
      expect(isClientMessage({ type: 'host-quiesce', expectedStoreId: 3 })).toBe(false);
    });
  });

  test('mcpl-remove validates id', () => {
    expect(isClientMessage({ type: 'mcpl-remove', id: 'a' })).toBe(true);
    expect(isClientMessage({ type: 'mcpl-remove', id: '../oops' })).toBe(false);
    expect(isClientMessage({ type: 'mcpl-remove' })).toBe(false);
  });

  test('mcpl-set-env validates id and env shape', () => {
    expect(isClientMessage({ type: 'mcpl-set-env', id: 'a', env: { K: 'v' } })).toBe(true);
    expect(isClientMessage({ type: 'mcpl-set-env', id: 'a', env: {} })).toBe(true);
    expect(isClientMessage({ type: 'mcpl-set-env', id: 'a', env: { K: 1 } })).toBe(false);
    expect(isClientMessage({ type: 'mcpl-set-env', id: 'a' })).toBe(false);
    expect(isClientMessage({ type: 'mcpl-set-env', env: { K: 'v' } })).toBe(false);
  });
});
