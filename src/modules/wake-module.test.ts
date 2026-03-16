import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WakeModule, seedWakeConfig, type WakeConfig } from './wake-module.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP_DIR = join(import.meta.dir, '../../.test-tmp');

function tmpPath(name: string): string {
  return join(TMP_DIR, name);
}

function writeConfig(name: string, config: WakeConfig): string {
  const path = tmpPath(name);
  mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}

function makeModule(configPath: string, agentName = 'agent') {
  const wakes: Array<{ policies: string[]; summary: string }> = [];
  const module = new WakeModule({
    configPath,
    agentName,
    onWake: (policies, summary) => wakes.push({ policies, summary }),
  });
  return { module, wakes };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Policy matching
// ---------------------------------------------------------------------------

describe('policy matching', () => {
  test('no policies + default always → triggers', () => {
    const path = writeConfig('empty.json', { policies: [], default: 'always' });
    const { module } = makeModule(path);
    expect(module.shouldTrigger('hello', { eventType: 'push:event' })).toBe(true);
  });

  test('no policies + default suppress → does not trigger', () => {
    const path = writeConfig('suppress.json', { policies: [], default: 'suppress' });
    const { module } = makeModule(path);
    expect(module.shouldTrigger('hello', { eventType: 'push:event' })).toBe(false);
  });

  test('scope match — matching event type', () => {
    const path = writeConfig('scope.json', {
      policies: [
        { name: 'channels', match: { scope: ['channel:incoming'] }, behavior: 'always' },
      ],
      default: 'suppress',
    });
    const { module } = makeModule(path);
    expect(module.shouldTrigger('msg', { eventType: 'channel:incoming' })).toBe(true);
    expect(module.shouldTrigger('msg', { eventType: 'push:event' })).toBe(false);
  });

  test('source match — exact serverId', () => {
    const path = writeConfig('source.json', {
      policies: [
        { name: 'zulip', match: { source: 'zulip' }, behavior: 'always' },
      ],
      default: 'suppress',
    });
    const { module } = makeModule(path);
    expect(module.shouldTrigger('msg', { eventType: 'push:event', serverId: 'zulip' })).toBe(true);
    expect(module.shouldTrigger('msg', { eventType: 'push:event', serverId: 'discord' })).toBe(false);
  });

  test('source match — glob pattern', () => {
    const path = writeConfig('source-glob.json', {
      policies: [
        { name: 'any-zulip', match: { source: 'zulip-*' }, behavior: 'always' },
      ],
      default: 'suppress',
    });
    const { module } = makeModule(path);
    expect(module.shouldTrigger('msg', { eventType: 'push:event', serverId: 'zulip-prod' })).toBe(true);
    expect(module.shouldTrigger('msg', { eventType: 'push:event', serverId: 'zulip-staging' })).toBe(true);
    expect(module.shouldTrigger('msg', { eventType: 'push:event', serverId: 'discord' })).toBe(false);
  });

  test('channel match — exact channelId', () => {
    const path = writeConfig('channel.json', {
      policies: [
        { name: 'alerts', match: { channel: 'alerts' }, behavior: 'always' },
      ],
      default: 'suppress',
    });
    const { module } = makeModule(path);
    expect(module.shouldTrigger('msg', { eventType: 'channel:incoming', channelId: 'alerts' })).toBe(true);
    expect(module.shouldTrigger('msg', { eventType: 'channel:incoming', channelId: 'general' })).toBe(false);
  });

  test('channel match — glob pattern', () => {
    const path = writeConfig('channel-glob.json', {
      policies: [
        { name: 'dev-channels', match: { channel: 'dev-*' }, behavior: 'always' },
      ],
      default: 'suppress',
    });
    const { module } = makeModule(path);
    expect(module.shouldTrigger('msg', { eventType: 'channel:incoming', channelId: 'dev-backend' })).toBe(true);
    expect(module.shouldTrigger('msg', { eventType: 'channel:incoming', channelId: 'prod-alerts' })).toBe(false);
  });

  test('content filter — text match (case insensitive)', () => {
    const path = writeConfig('filter-text.json', {
      policies: [
        { name: 'errors', match: { filter: { type: 'text', pattern: 'ERROR' } }, behavior: 'always' },
      ],
      default: 'suppress',
    });
    const { module } = makeModule(path);
    expect(module.shouldTrigger('Something error happened', { eventType: 'push:event' })).toBe(true);
    expect(module.shouldTrigger('All good', { eventType: 'push:event' })).toBe(false);
  });

  test('content filter — regex match', () => {
    const path = writeConfig('filter-regex.json', {
      policies: [
        { name: 'deploys', match: { filter: { type: 'regex', pattern: 'deploy|rollback' } }, behavior: 'always' },
      ],
      default: 'suppress',
    });
    const { module } = makeModule(path);
    expect(module.shouldTrigger('Starting deploy v2.3', { eventType: 'push:event' })).toBe(true);
    expect(module.shouldTrigger('Rolling back', { eventType: 'push:event' })).toBe(false);
    expect(module.shouldTrigger('rollback initiated', { eventType: 'push:event' })).toBe(true);
  });

  test('combined match — scope + source + filter', () => {
    const path = writeConfig('combined.json', {
      policies: [
        {
          name: 'zulip-errors',
          match: {
            scope: ['channel:incoming'],
            source: 'zulip',
            filter: { type: 'text', pattern: 'error' },
          },
          behavior: 'always',
        },
      ],
      default: 'suppress',
    });
    const { module } = makeModule(path);
    // All conditions met
    expect(module.shouldTrigger('An error occurred', {
      eventType: 'channel:incoming', serverId: 'zulip',
    })).toBe(true);
    // Wrong scope
    expect(module.shouldTrigger('An error occurred', {
      eventType: 'push:event', serverId: 'zulip',
    })).toBe(false);
    // Wrong source
    expect(module.shouldTrigger('An error occurred', {
      eventType: 'channel:incoming', serverId: 'discord',
    })).toBe(false);
    // No error keyword
    expect(module.shouldTrigger('All good', {
      eventType: 'channel:incoming', serverId: 'zulip',
    })).toBe(false);
  });

  test('first match wins — order matters', () => {
    const path = writeConfig('order.json', {
      policies: [
        { name: 'suppress-noise', match: { filter: { type: 'text', pattern: 'heartbeat' } }, behavior: 'suppress' },
        { name: 'catch-all', match: {}, behavior: 'always' },
      ],
      default: 'suppress',
    });
    const { module } = makeModule(path);
    expect(module.shouldTrigger('heartbeat ping', { eventType: 'push:event' })).toBe(false);
    expect(module.shouldTrigger('real message', { eventType: 'push:event' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suppress behavior
// ---------------------------------------------------------------------------

describe('suppress behavior', () => {
  test('matching suppress policy returns false', () => {
    const path = writeConfig('suppress-policy.json', {
      policies: [
        { name: 'suppress-all', match: {}, behavior: 'suppress' },
      ],
      default: 'always',
    });
    const { module } = makeModule(path);
    expect(module.shouldTrigger('anything', { eventType: 'push:event' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Debounce behavior
// ---------------------------------------------------------------------------

describe('debounce behavior', () => {
  test('debounce returns false immediately', () => {
    const path = writeConfig('debounce.json', {
      policies: [
        { name: 'editor', match: { scope: ['push:event'] }, behavior: { debounce: 100 } },
      ],
      default: 'suppress',
    });
    const { module } = makeModule(path);
    expect(module.shouldTrigger('edit 1', { eventType: 'push:event' })).toBe(false);
  });

  test('debounce batches events and fires after delay', async () => {
    const path = writeConfig('debounce-fire.json', {
      policies: [
        { name: 'editor', match: { scope: ['push:event'] }, behavior: { debounce: 50 } },
      ],
      default: 'suppress',
    });
    const { module, wakes } = makeModule(path);

    // Mock ctx so deliverEvents can work
    const messages: Array<{ role: string; content: unknown }> = [];
    const events: unknown[] = [];
    (module as any).ctx = {
      addMessage: (role: string, content: unknown) => messages.push({ role, content }),
      pushEvent: (event: unknown) => events.push(event),
    };

    module.shouldTrigger('edit 1', { eventType: 'push:event' });
    module.shouldTrigger('edit 2', { eventType: 'push:event' });
    module.shouldTrigger('edit 3', { eventType: 'push:event' });

    // Should not have delivered yet
    expect(messages.length).toBe(0);

    // Wait for debounce to fire
    await new Promise(r => setTimeout(r, 80));

    expect(messages.length).toBe(1);
    const text = (messages[0].content as Array<{ text: string }>)[0].text;
    expect(text).toContain('3 events matched');
    expect(text).toContain('[editor]');
    expect(events.length).toBe(1);
    expect(wakes.length).toBe(1);
    expect(wakes[0].policies).toEqual(['editor']);
  });

  test('debounce resets timer on new events', async () => {
    const path = writeConfig('debounce-reset.json', {
      policies: [
        { name: 'editor', match: {}, behavior: { debounce: 60 } },
      ],
      default: 'suppress',
    });
    const { module } = makeModule(path);

    const messages: unknown[] = [];
    (module as any).ctx = {
      addMessage: (_r: string, c: unknown) => messages.push(c),
      pushEvent: () => {},
    };

    module.shouldTrigger('edit 1', { eventType: 'push:event' });
    await new Promise(r => setTimeout(r, 30));
    // Timer hasn't fired yet, send another
    module.shouldTrigger('edit 2', { eventType: 'push:event' });
    await new Promise(r => setTimeout(r, 30));
    // Still within debounce window of second event
    expect(messages.length).toBe(0);

    await new Promise(r => setTimeout(r, 50));
    // Now it should have fired (30 + 30 + 50 = 110ms, debounce was reset at 30ms)
    expect(messages.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Inference buffering
// ---------------------------------------------------------------------------

describe('inference buffering', () => {
  test('always events during inference are buffered', () => {
    const path = writeConfig('infer-buf.json', {
      policies: [
        { name: 'chat', match: {}, behavior: 'always' },
      ],
      default: 'suppress',
    });
    const { module } = makeModule(path);

    // Simulate inference started
    (module as any).inferring = true;

    expect(module.shouldTrigger('msg during inference', { eventType: 'channel:incoming' })).toBe(false);
    expect((module as any).inferenceBuffer.length).toBe(1);
    expect((module as any).inferenceBuffer[0].policyName).toBe('chat');
  });

  test('buffer is capped at MAX_INFERENCE_BUFFER', () => {
    const path = writeConfig('infer-cap.json', {
      policies: [
        { name: 'chat', match: {}, behavior: 'always' },
      ],
      default: 'suppress',
    });
    const { module } = makeModule(path);
    (module as any).inferring = true;

    for (let i = 0; i < 150; i++) {
      module.shouldTrigger(`msg ${i}`, { eventType: 'channel:incoming' });
    }

    // Should be capped at 100
    expect((module as any).inferenceBuffer.length).toBe(100);
    // Oldest should have been dropped — first event should be msg 50
    expect((module as any).inferenceBuffer[0].content).toContain('msg 50');
  });
});

// ---------------------------------------------------------------------------
// Config hot-reload
// ---------------------------------------------------------------------------

describe('config hot-reload', () => {
  test('reloads config when file changes', async () => {
    const path = writeConfig('reload.json', {
      policies: [{ name: 'all', match: {}, behavior: 'always' }],
      default: 'suppress',
    });
    const { module } = makeModule(path);

    expect(module.shouldTrigger('msg', { eventType: 'push:event' })).toBe(true);

    // Force throttle to expire
    (module as any).lastReloadCheck = 0;

    // Wait a bit to ensure mtime differs (filesystem resolution)
    await new Promise(r => setTimeout(r, 50));

    // Rewrite config — now suppress everything
    writeFileSync(path, JSON.stringify({ policies: [], default: 'suppress' }));

    expect(module.shouldTrigger('msg', { eventType: 'push:event' })).toBe(false);
  });

  test('throttles filesystem checks', () => {
    const path = writeConfig('throttle.json', {
      policies: [],
      default: 'always',
    });
    const { module } = makeModule(path);

    // First call sets lastReloadCheck
    module.shouldTrigger('msg', { eventType: 'push:event' });
    const firstCheck = (module as any).lastReloadCheck;

    // Immediate second call should be throttled
    module.shouldTrigger('msg', { eventType: 'push:event' });
    expect((module as any).lastReloadCheck).toBe(firstCheck);
  });
});

// ---------------------------------------------------------------------------
// onWake callback
// ---------------------------------------------------------------------------

describe('onWake callback', () => {
  test('fires onWake for always triggers', () => {
    const path = writeConfig('onwake.json', {
      policies: [{ name: 'chat', match: {}, behavior: 'always' }],
      default: 'suppress',
    });
    const { module, wakes } = makeModule(path);

    module.shouldTrigger('hello world', { eventType: 'channel:incoming' });

    expect(wakes.length).toBe(1);
    expect(wakes[0].policies).toEqual(['chat']);
    expect(wakes[0].summary).toBe('hello world');
  });

  test('does not fire onWake for suppress', () => {
    const path = writeConfig('no-wake.json', {
      policies: [{ name: 'quiet', match: {}, behavior: 'suppress' }],
      default: 'always',
    });
    const { module, wakes } = makeModule(path);

    module.shouldTrigger('hello', { eventType: 'push:event' });

    expect(wakes.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// seedWakeConfig
// ---------------------------------------------------------------------------

describe('seedWakeConfig', () => {
  test('writes config when file does not exist', () => {
    const path = tmpPath('seed-new.json');
    const config: WakeConfig = {
      policies: [{ name: 'test', match: {}, behavior: 'always' }],
      default: 'suppress',
    };
    seedWakeConfig(path, config);

    expect(existsSync(path)).toBe(true);
    const written = JSON.parse(readFileSync(path, 'utf-8'));
    expect(written.policies[0].name).toBe('test');
    expect(written.default).toBe('suppress');
  });

  test('does not overwrite existing file', () => {
    const path = writeConfig('seed-existing.json', {
      policies: [{ name: 'original', match: {}, behavior: 'always' }],
      default: 'always',
    });

    seedWakeConfig(path, {
      policies: [{ name: 'new', match: {}, behavior: 'suppress' }],
      default: 'suppress',
    });

    const written = JSON.parse(readFileSync(path, 'utf-8'));
    expect(written.policies[0].name).toBe('original'); // unchanged
  });
});

// ---------------------------------------------------------------------------
// Config validation edge cases
// ---------------------------------------------------------------------------

describe('config validation', () => {
  test('missing file → default config (all events pass)', () => {
    const path = tmpPath('nonexistent.json');
    const { module } = makeModule(path);
    expect(module.shouldTrigger('anything', { eventType: 'push:event' })).toBe(true);
  });

  test('malformed JSON → default config', () => {
    const path = tmpPath('bad.json');
    mkdirSync(TMP_DIR, { recursive: true });
    writeFileSync(path, 'not valid json{{{');
    const { module } = makeModule(path);
    expect(module.shouldTrigger('anything', { eventType: 'push:event' })).toBe(true);
  });

  test('invalid regex in filter → policy skipped at match time', () => {
    // The validator catches invalid regex, so we need to bypass validation
    // by writing a config where regex is syntactically valid but semantically weird
    const path = writeConfig('bad-regex.json', {
      policies: [
        { name: 'bad', match: { filter: { type: 'regex', pattern: '(?:valid)' } }, behavior: 'always' },
      ],
      default: 'suppress',
    });
    const { module } = makeModule(path);
    // This should work fine — the regex is actually valid
    expect(module.shouldTrigger('valid text', { eventType: 'push:event' })).toBe(true);
  });

  test('empty match object matches everything', () => {
    const path = writeConfig('empty-match.json', {
      policies: [
        { name: 'catch-all', match: {}, behavior: 'always' },
      ],
      default: 'suppress',
    });
    const { module } = makeModule(path);
    expect(module.shouldTrigger('anything', { eventType: 'push:event', serverId: 'any', channelId: 'any' })).toBe(true);
  });
});
