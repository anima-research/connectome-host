import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager } from '@animalabs/context-manager';
import { AutobiographicalStrategy } from '@animalabs/agent-framework';
import { SessionManager } from '../src/session-manager.js';

describe('SessionManager.getImportSource', () => {
  let tmpDir: string;
  let sm: SessionManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'warmup-handoff-'));
    mkdirSync(join(tmpDir, 'sessions'), { recursive: true });
    sm = new SessionManager(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns null when no sidecar exists', () => {
    expect(sm.getImportSource('nonexistent')).toBeNull();
  });

  test('returns parsed JSON when sidecar exists', () => {
    const sidecarPath = join(tmpDir, 'sessions', 'abc123.import-source.json');
    writeFileSync(sidecarPath, JSON.stringify({ agentName: 'Claude', name: 'Truvari' }));
    const result = sm.getImportSource('abc123');
    expect(result).toEqual({ agentName: 'Claude', name: 'Truvari' });
  });

  test('returns null when sidecar contents are not valid JSON', () => {
    const sidecarPath = join(tmpDir, 'sessions', 'broken.import-source.json');
    writeFileSync(sidecarPath, '{not valid json');
    expect(sm.getImportSource('broken')).toBeNull();
  });

  test('returns null when sidecar JSON parses to a non-object root', () => {
    const cases: Array<[string, string]> = [
      ['null-root', 'null'],
      ['array-root', '[1,2,3]'],
      ['string-root', '"just a string"'],
      ['number-root', '42'],
    ];
    for (const [id, body] of cases) {
      writeFileSync(join(tmpDir, 'sessions', `${id}.import-source.json`), body);
      expect(sm.getImportSource(id)).toBeNull();
    }
  });

  test('surfaces agentName specifically — guards against field rename', () => {
    const sidecarPath = join(tmpDir, 'sessions', 'guard.import-source.json');
    writeFileSync(sidecarPath, JSON.stringify({ agentName: 'TestAgent' }));
    const result = sm.getImportSource('guard');
    expect(result?.agentName).toBe('TestAgent');
  });
});

describe('AutobiographicalStrategy state slot under explicit namespace', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'warmup-namespace-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("registers 'agents/${name}/autobio:summaries' when namespace is passed", async () => {
    const storePath = join(tmpDir, 'store');
    const store = JsStore.openOrCreate({ path: storePath });
    try {
      const strategy = new AutobiographicalStrategy({
        compressionModel: 'claude-sonnet-4-5-20250929',
        autoTickOnNewMessage: false,
      });
      await ContextManager.open({
        store,
        strategy,
        namespace: 'agents/Claude',
      });

      const stateIds = store.listStates().map((s: { id: string }) => s.id);
      // agent-framework opens an agent's ContextManager in namespace agents/<name>;
      // context-manager without a namespace uses `default`.
      expect(stateIds).toContain('agents/Claude/autobio:summaries');
      expect(stateIds).not.toContain('default/autobio:summaries');
    } finally {
      store.close?.();
    }
  });

  test("falls back to 'default/autobio:summaries' when namespace is omitted (regression-witness)", async () => {
    const storePath = join(tmpDir, 'store');
    const store = JsStore.openOrCreate({ path: storePath });
    try {
      const strategy = new AutobiographicalStrategy({
        compressionModel: 'claude-sonnet-4-5-20250929',
        autoTickOnNewMessage: false,
      });
      await ContextManager.open({ store, strategy });

      const stateIds = store.listStates().map((s: { id: string }) => s.id);
      expect(stateIds).toContain('default/autobio:summaries');
      expect(stateIds).not.toContain('agents/Claude/autobio:summaries');
    } finally {
      store.close?.();
    }
  });
});
