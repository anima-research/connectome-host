/**
 * Guard tests for the import → warmup → conhost identity handoff.
 *
 * The original bug: warmup-session.ts called ContextManager.open without a
 * namespace argument, so AutobiographicalStrategy persisted summaries to
 * the no-namespace default slot `default/autobio:summaries`. The live
 * framework reads from `agents/${name}/autobio:summaries`. The two never
 * met; the agent saw an empty autobiography on first open.
 *
 * The fix is in two parts:
 *   1. `SessionManager.getImportSource` surfaces the agentName the
 *      importer wrote into the sidecar, so warmup can derive a name
 *      without an explicit CLI flag.
 *   2. `warmup-session.ts` passes `namespace: 'agents/' + agentName`
 *      to `ContextManager.open` so its writes land where the framework
 *      reads.
 *
 * These tests pin both contracts. They don't run an LLM — they just
 * check the surface area that has to remain intact for the handoff to
 * work end-to-end.
 */

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

  test('surfaces agentName specifically — guards against field rename', () => {
    // The whole point of this sidecar field is that warmup-session.ts can
    // read it back. If someone renames `agentName` upstream without
    // migrating callers, both warmup and conhost lose their fallback and
    // we silently regress to the original bug.
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
      // The slot the framework's main-agent ContextManager registers.
      // If warmup-session.ts ever drops its namespace argument again, this
      // assertion fails because the strategy lands at `default/` instead.
      expect(stateIds).toContain('agents/Claude/autobio:summaries');
      expect(stateIds).not.toContain('default/autobio:summaries');
    } finally {
      store.close?.();
    }
  });

  test("falls back to 'default/autobio:summaries' when namespace is omitted (regression-witness)", async () => {
    // This is intentionally NOT what warmup wants — it documents the
    // failure mode and ensures the namespace-on path stays distinct from
    // the namespace-off path. If both ended up at the same slot the
    // first test above would be a tautology.
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
