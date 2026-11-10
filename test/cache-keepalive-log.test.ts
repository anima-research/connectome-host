import { describe, test, expect } from 'bun:test';
import {
  logKeepaliveEvent,
  formatKeepaliveEvent,
  KEEPALIVE_LOG_PREFIX,
  keepalivePersistWarning,
  keepalivePersistHealth,
  KEEPALIVE_STATE_FILE,
  type KeepaliveRef,
} from '../src/cache-keepalive-log.js';
import { AnthropicAdapter, CacheKeepalive, type KeepaliveEvent } from '@animalabs/membrane';
import { LoggingAnthropicAdapter } from '../src/logging-adapter.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EVENTS: KeepaliveEvent[] = [
  { type: 'refreshed', key: 'k1', lane: 'stream', readTokens: 523102, idleMs: 2987020 },
  { type: 'expired', key: 'k1', idleMs: 21600000 },
  { type: 'ineffective', key: 'k1', reason: 'wrote-instead-of-read', readTokens: 0, writeTokens: 523102 },
  { type: 'skipped', key: 'k1', reason: 'no-1h-breakpoint' },
  { type: 'error', key: 'k1', error: '400 invalid_request_error', consecutive: 1 },
  { type: 'disabled', reason: '3 consecutive keepalive failures' },
];

describe('keepalive event logging', () => {
  test('every event type is written, none silently dropped', () => {
    for (const event of EVENTS) {
      const lines: string[] = [];
      logKeepaliveEvent(event, (l) => lines.push(l));
      expect(lines.length).toBe(1);
    }
  });

  test('routine refreshes are logged, not filtered as noise', () => {
    const lines: string[] = [];
    logKeepaliveEvent(EVENTS[0]!, (l) => lines.push(l));
    expect(lines[0]).toContain('refreshed');
    expect(lines[0]).toContain('523102');
  });

  test('lines carry the greppable prefix', () => {
    for (const event of EVENTS) {
      expect(formatKeepaliveEvent(event).startsWith(KEEPALIVE_LOG_PREFIX)).toBe(true);
    }
  });

  test('the payload is machine-readable JSON after the prefix', () => {
    const line = formatKeepaliveEvent(EVENTS[2]!);
    const json = line.slice(KEEPALIVE_LOG_PREFIX.length).trim();
    const parsed = JSON.parse(json) as { type: string; reason: string; writeTokens: number };
    expect(parsed.type).toBe('ineffective');
    expect(parsed.reason).toBe('wrote-instead-of-read');
    expect(parsed.writeTokens).toBe(523102);
  });

  test('DEFAULT SINK IS STDERR for every event type — not stdout', () => {
    const origLog = console.log;
    const origErr = console.error;
    const origWarn = console.warn;
    const toStdout: string[] = [];
    const toStderr: string[] = [];
    try {
      console.log = (...a: unknown[]) => { toStdout.push(String(a[0])); };
      console.error = (...a: unknown[]) => { toStderr.push(String(a[0])); };
      console.warn = (...a: unknown[]) => { toStderr.push(String(a[0])); };
      for (const event of EVENTS) logKeepaliveEvent(event);
    } finally {
      console.log = origLog;
      console.error = origErr;
      console.warn = origWarn;
    }
    expect(toStderr.length).toBe(EVENTS.length);
    expect(toStdout.length).toBe(0);
  });
});

describe('keepalivePersistWarning', () => {
  test('says nothing when persist is off, or the keepalive is saving', () => {
    expect(keepalivePersistWarning(undefined, undefined)).toBeNull();
    expect(keepalivePersistWarning(false, {})).toBeNull();
    expect(keepalivePersistWarning(true, { persistPath: '/data/cache-keepalive.json' })).toBeNull();
  });

  test('a 5-minute cache: no effect', () => {
    expect(keepalivePersistWarning(true, { persistPath: '/x' }, '5m')).toContain("no effect with agent.cacheTtl '5m'");
  });

  test('no keepalive (another provider, or keepalive off): no effect', () => {
    expect(keepalivePersistWarning(true, undefined)).toContain('keepalive is off for this provider or recipe');
  });

  test('a membrane without statePath', () => {
    expect(keepalivePersistWarning(true, {})).toContain("this membrane can't save keepalive state");
  });

  test('a keepalive that gave up its file', () => {
    expect(keepalivePersistWarning(true, { persistPath: undefined })).toContain('stopped saving');
  });

  test('matches the installed membrane, from a real adapter instance', () => {
    const adapter = new AnthropicAdapter({ apiKey: 'test-key', cacheKeepalive: { enabled: true } });
    try {
      const supported = 'persistPath' in CacheKeepalive.prototype;
      const warning = keepalivePersistWarning(true, adapter.cacheKeepalive);
      if (supported) expect(warning).toContain('stopped saving');
      else expect(warning).toContain("this membrane can't save keepalive state");
    } finally {
      adapter.cacheKeepalive?.stop();
    }
  });

  test('statePath reaches the adapter\'s keepalive (when membrane takes it)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ka-persist-'));
    const statePath = join(dir, KEEPALIVE_STATE_FILE);
    const adapter = new LoggingAnthropicAdapter(
      { apiKey: 'test-key', cacheKeepalive: { enabled: true, statePath } as never },
      join(dir, 'llm.jsonl'),
    );
    try {
      const ka = adapter.cacheKeepalive as KeepaliveRef;
      if ('persistPath' in CacheKeepalive.prototype) {
        expect(ka?.persistPath).toBe(statePath);
        expect(keepalivePersistHealth(true, ka)).toEqual({ saving: true, path: statePath });
      } else {
        expect(keepalivePersistHealth(true, ka)).toEqual({ saving: false, reason: 'membrane-unsupported' });
      }
    } finally {
      adapter.cacheKeepalive?.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('health: absent unless persist is on', () => {
    expect(keepalivePersistHealth(undefined, { persistPath: '/x' })).toBeNull();
    expect(keepalivePersistHealth(true, undefined)).toEqual({ saving: false, reason: 'no-keepalive' });
    expect(keepalivePersistHealth(true, { persistPath: undefined })).toEqual({ saving: false });
  });
});
