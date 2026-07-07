/**
 * Tests for LessonsModule persistence fixes (fragility audit Jul 2026):
 *   3.1/3.2 — read-merge-write on save, atomic tmp+rename write, corrupt-file
 *             backup instead of silent clobber
 *   3.3     — full-UUID lesson IDs (no 8-char collision-prone prefix)
 *   3.4     — confidence clamped on create
 *   3.7     — debounced async global save + flush on stop()
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import type { ModuleContext, ToolCall, ToolResult } from '@animalabs/agent-framework';
import { LessonsModule } from '../src/modules/lessons-module.js';
import type { Lesson } from '../src/modules/lessons-module.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Minimal ModuleContext mock — LessonsModule only uses getState/setState. */
function makeCtx(): ModuleContext {
  let state: unknown = null;
  return {
    getState: <T,>() => state as T | null,
    setState: (s: unknown) => { state = s; },
  } as unknown as ModuleContext;
}

function makeToolCall(name: string, input: Record<string, unknown>): ToolCall {
  return {
    id: `test-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    input,
    callerAgentName: 'tester',
  };
}

async function makeModule(globalPath: string) {
  const module = new LessonsModule({ globalPath });
  await module.start(makeCtx());
  return module;
}

function createLesson(module: LessonsModule, content: string, extra?: Record<string, unknown>): Promise<ToolResult> {
  return module.handleToolCall(makeToolCall('create', { content, tags: ['test'], ...extra }));
}

function readGlobalFile(globalPath: string): { lessons: Lesson[] } {
  return JSON.parse(readFileSync(globalPath, 'utf-8'));
}

function withTmpDir(): { dir: string; globalPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'lessons-mod-'));
  return {
    dir,
    globalPath: join(dir, 'lessons.json'),
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ } },
  };
}

// ---------------------------------------------------------------------------
// 3.3 / 3.4 — create() basics
// ---------------------------------------------------------------------------

describe('LessonsModule create()', () => {
  test('new lesson IDs are full UUIDs, not 8-char prefixes', async () => {
    const { globalPath, cleanup } = withTmpDir();
    try {
      const module = await makeModule(globalPath);
      const res = await createLesson(module, 'full uuid check');
      expect(res.success).toBe(true);
      const id = (res.data as { id: string }).id;
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      await module.stop();
    } finally {
      cleanup();
    }
  });

  test('create clamps confidence into [0, 1]', async () => {
    const { globalPath, cleanup } = withTmpDir();
    try {
      const module = await makeModule(globalPath);
      const resHigh = await createLesson(module, 'overconfident', { confidence: 80 });
      const resLow = await createLesson(module, 'underconfident', { confidence: -3 });
      expect(resHigh.success).toBe(true);
      expect(resLow.success).toBe(true);

      const lessons = module.getLessons();
      const high = lessons.find(l => l.content === 'overconfident')!;
      const low = lessons.find(l => l.content === 'underconfident')!;
      expect(high.confidence).toBeLessThanOrEqual(1);
      expect(high.confidence).toBe(1);
      expect(low.confidence).toBeGreaterThanOrEqual(0);
      expect(low.confidence).toBe(0);
      await module.stop();
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 3.1 — read-merge-write across two module instances (two "processes")
// ---------------------------------------------------------------------------

describe('LessonsModule global file: read-merge-write', () => {
  test("another instance's lessons written after our start() survive our save", async () => {
    const { globalPath, cleanup } = withTmpDir();
    try {
      // A starts first — file doesn't exist yet.
      const a = await makeModule(globalPath);

      // B starts, creates lesson X, and flushes (stop() flushes pending writes).
      const b = await makeModule(globalPath);
      const resX = await createLesson(b, 'lesson X from process B');
      const idX = (resX.data as { id: string }).id;
      await b.stop();
      expect(readGlobalFile(globalPath).lessons.some(l => l.id === idX)).toBe(true);

      // A never saw X in memory. A now mutates (create Y) and flushes.
      // Pre-fix behaviour: A's whole-file overwrite clobbers X.
      const resY = await createLesson(a, 'lesson Y from process A');
      const idY = (resY.data as { id: string }).id;
      await a.stop();

      const onDisk = readGlobalFile(globalPath).lessons;
      expect(onDisk.some(l => l.id === idX)).toBe(true); // X survived
      expect(onDisk.some(l => l.id === idY)).toBe(true); // Y written
    } finally {
      cleanup();
    }
  });

  test('on ID conflict, newer `updated` wins during save-merge', async () => {
    const { globalPath, cleanup } = withTmpDir();
    try {
      const a = await makeModule(globalPath);
      const res = await createLesson(a, 'original content');
      const id = (res.data as { id: string }).id;
      await new Promise(r => setTimeout(r, 200)); // let the debounced flush land v1

      // Simulate another process bumping the same lesson later, while A is
      // still running with its stale in-memory copy.
      const state = readGlobalFile(globalPath);
      const target = state.lessons.find(l => l.id === id)!;
      target.content = 'newer content from other process';
      target.updated = Date.now() + 60_000; // strictly newer than anything A will produce
      writeFileSync(globalPath, JSON.stringify(state, null, 2));

      // A mutates something else and flushes — the save-merge must prefer the
      // newer on-disk copy over A's stale in-memory one.
      await createLesson(a, 'unrelated lesson');
      await a.stop();

      const final = readGlobalFile(globalPath).lessons.find(l => l.id === id)!;
      expect(final.content).toBe('newer content from other process');
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 3.1c / 3.2 — corrupt file handling: backup, loud error, no silent clobber
// ---------------------------------------------------------------------------

describe('LessonsModule global file: corruption handling', () => {
  test('corrupt JSON is backed up (content preserved) and loudly logged, not silently clobbered', async () => {
    const { dir, globalPath, cleanup } = withTmpDir();
    const corruptContent = '{"lessons": [ {"id": "trunc'; // truncated JSON
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      mkdirSync(dirname(globalPath), { recursive: true });
      writeFileSync(globalPath, corruptContent);

      const module = await makeModule(globalPath);

      // Backup must exist already (created at start()-time merge), with the
      // exact corrupt bytes preserved.
      const backups = readdirSync(dir).filter(f => f.startsWith(`${basename(globalPath)}.corrupt-`));
      expect(backups.length).toBe(1);
      expect(readFileSync(join(dir, backups[0]), 'utf-8')).toBe(corruptContent);

      // Loud error was logged.
      expect(errors.some(e => e.includes('CORRUPT') && e.includes(globalPath))).toBe(true);

      // Module still functions; a save overwrites the (backed-up) corrupt file
      // with valid JSON.
      const res = await createLesson(module, 'post-corruption lesson');
      await module.stop();
      const onDisk = readGlobalFile(globalPath); // parses => valid JSON again
      expect(onDisk.lessons.some(l => l.id === (res.data as { id: string }).id)).toBe(true);

      // Backup still intact after the overwrite.
      expect(readFileSync(join(dir, backups[0]), 'utf-8')).toBe(corruptContent);
    } finally {
      console.error = originalError;
      cleanup();
    }
  });

  test('a SECOND, independent corruption in the same process is also backed up + logged (not silently clobbered)', async () => {
    // corruptBackupDone used to be one-shot per process: once ANY corruption
    // was backed up, a later corruption returned null silently and got
    // overwritten with no backup, no log — the exact hole the fix claims to
    // close. The flag must mean "this ongoing incident is already backed up",
    // so it resets on a clean read.
    const { dir, globalPath, cleanup } = withTmpDir();
    const corrupt1 = '{"lessons": [ {"id": "trunc-one';
    const corrupt2 = '}}}garbage-two not json at all';
    const corruptLogs: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      const line = args.map(String).join(' ');
      if (line.includes('CORRUPT')) corruptLogs.push(line);
    };
    try {
      mkdirSync(dirname(globalPath), { recursive: true });
      writeFileSync(globalPath, corrupt1);

      // Same module instance for the whole process lifetime.
      const module = await makeModule(globalPath);

      // Incident 1 backed up at start()-time merge.
      let backups = readdirSync(dir).filter(f => f.startsWith(`${basename(globalPath)}.corrupt-`));
      expect(backups.length).toBe(1);

      // Two save cycles: the first rewrites the file valid (its readGlobal
      // still saw the corrupt bytes); the second reads the NOW-VALID file,
      // which is the clean read that resets the incident flag.
      await createLesson(module, 'recovery lesson 1');
      await new Promise(r => setTimeout(r, 160)); // past the 100ms debounce
      await createLesson(module, 'recovery lesson 2');
      await new Promise(r => setTimeout(r, 160));
      expect(() => readGlobalFile(globalPath)).not.toThrow(); // valid again

      // Second, independent corruption (older-version writer / manual edit /
      // disk hiccup) — different bytes so the backup is distinguishable.
      writeFileSync(globalPath, corrupt2);

      await createLesson(module, 'lesson after 2nd corruption');
      await new Promise(r => setTimeout(r, 160));

      // A SECOND backup now exists, capturing corrupt2 — not silently clobbered.
      backups = readdirSync(dir).filter(f => f.startsWith(`${basename(globalPath)}.corrupt-`));
      expect(backups.length).toBe(2);
      const backupContents = backups.map(b => readFileSync(join(dir, b), 'utf-8')).sort();
      expect(backupContents).toEqual([corrupt1, corrupt2].sort());

      // And it was loudly logged BOTH times.
      expect(corruptLogs.length).toBe(2);

      await module.stop();
    } finally {
      console.error = originalError;
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 3.7 — debounced save + flush on stop()
// ---------------------------------------------------------------------------

describe('LessonsModule global file: debounced save', () => {
  test('rapid mutations coalesce; file eventually contains all lessons', async () => {
    const { globalPath, cleanup } = withTmpDir();
    try {
      const module = await makeModule(globalPath);
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await createLesson(module, `burst lesson ${i}`);
        ids.push((res.data as { id: string }).id);
      }
      // Wait past the debounce window for the coalesced write to land.
      await new Promise(r => setTimeout(r, 300));
      const onDisk = readGlobalFile(globalPath).lessons;
      for (const id of ids) {
        expect(onDisk.some(l => l.id === id)).toBe(true);
      }
      await module.stop();
    } finally {
      cleanup();
    }
  });

  test('stop() flushes a pending write immediately (no debounce wait)', async () => {
    const { globalPath, cleanup } = withTmpDir();
    try {
      const module = await makeModule(globalPath);
      const res = await createLesson(module, 'created right before shutdown');
      expect(existsSync(globalPath)).toBe(false); // still within debounce window
      await module.stop();
      const onDisk = readGlobalFile(globalPath).lessons;
      expect(onDisk.some(l => l.id === (res.data as { id: string }).id)).toBe(true);
    } finally {
      cleanup();
    }
  });
});
