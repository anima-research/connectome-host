/**
 * ActivityModule reads the head of a file the workspace reports created or
 * modified for an origin hint, which routes its typing notice. It reads
 * through WorkspaceModule.readFileFromDisk, the read that keeps the mount's
 * link policy and reads a file only if its canonical path lies inside the
 * mount. The stand-in read refuses one path, and every path also resolves by
 * its text to a real file holding a hint, which a read that went around
 * readFileFromDisk would find instead. agent-framework's own read runs too,
 * on a real mount whose one link leads to a file inside it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule, WorkspaceReadError, type ModuleContext, type TraceEvent } from '@animalabs/agent-framework';
import { ActivityModule } from '../src/modules/activity-module.js';

describe("the origin hint comes only from what the mount's own read gives", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  /** An activity module over a stand-in read, with what it asked for and the typing notices it sent. */
  async function moduleOverStandIn() {
    const dir = mkdtempSync(join(tmpdir(), 'activity-origin-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'resolved.md'), 'origin: zulip#ops#from-around-the-read\n');
    const asked: Array<{ path: string; maxBytes?: number }> = [];
    const workspace = {
      resolveAbsolutePath: () => join(dir, 'resolved.md'),
      readFileFromDisk: async (path: string, options?: { maxBytes?: number }) => {
        asked.push({ path, maxBytes: options?.maxBytes });
        if (path === 'files/refused.md') {
          throw new WorkspaceReadError('escape', 'Symlink escape detected: files/refused.md', 'realpath');
        }
        if (path === 'files/grown.md') {
          // As agent-framework 0.22.2 answers for a file that was within the
          // head when the read took its size and grew while it was read: all
          // of it, not truncated.
          const bytes = Buffer.from(`${'x'.repeat(2048)}\norigin: zulip#ops#past-the-head\n`);
          return { bytes, size: 10, truncated: false };
        }
        const bytes = Buffer.from('origin: zulip#ops#from-the-mount\n');
        return { bytes, size: bytes.byteLength, truncated: false };
      },
    };
    return { ...(await moduleOver(workspace)), asked };
  }

  /** An activity module reading through `workspace`, with the typing notices it sent. */
  async function moduleOver(workspace: unknown) {
    const typing: Array<{ channel: string; metadata: unknown }> = [];
    const listeners = new Set<(event: TraceEvent) => void>();
    const framework = {
      onTrace: (cb: (event: TraceEvent) => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
      channels: {
        startTyping: (channel: string, metadata?: unknown) => { typing.push({ channel, metadata }); },
        stopTyping: () => {},
      },
    };
    const trace = (type: string) => { for (const l of [...listeners]) l({ type, agentName: 'clerk' } as unknown as TraceEvent); };
    const module = new ActivityModule({ initialChannels: ['zulip:ops'] });
    await module.start({
      getState: () => null,
      setState: () => {},
      getModule: (name: string) => (name === 'workspace' ? workspace : undefined),
    } as unknown as ModuleContext);
    module.setFramework(framework as never);
    return { module, typing, trace };
  }

  test('a file the read gives sets the topic, one it refuses sets nothing, and only the head is asked for', async () => {
    const { module, asked, typing, trace } = await moduleOverStandIn();
    await module.onProcess({ type: 'workspace:created', paths: ['files/refused.md'] } as never, {} as never);
    trace('inference:started');
    expect(typing.at(-1)).toEqual({ channel: 'zulip:ops', metadata: undefined });
    trace('inference:completed');

    await module.onProcess({ type: 'workspace:modified', paths: ['files/given.md'] } as never, {} as never);
    trace('inference:started');
    expect(typing.at(-1)).toEqual({ channel: 'zulip:ops', metadata: { topic: 'from-the-mount' } });

    expect(asked).toEqual([
      { path: 'files/refused.md', maxBytes: 2048 },
      { path: 'files/given.md', maxBytes: 2048 },
    ]);
  });

  // Each path of an event is read on its own: a refused one doesn't stop the rest.
  test('an event naming a refused file and a given one still takes the topic from the given one', async () => {
    const { module, asked, typing, trace } = await moduleOverStandIn();
    await module.onProcess({ type: 'workspace:modified', paths: ['files/refused.md', 'files/given.md'] } as never, {} as never);
    trace('inference:started');
    expect(typing.at(-1)).toEqual({ channel: 'zulip:ops', metadata: { topic: 'from-the-mount' } });
    expect(asked.map((a) => a.path)).toEqual(['files/refused.md', 'files/given.md']);
  });

  test('a read that gives more than the head, as for a file that grew while it was read, is cut to the head', async () => {
    const { module, typing, trace } = await moduleOverStandIn();
    await module.onProcess({ type: 'workspace:modified', paths: ['files/grown.md'] } as never, {} as never);
    trace('inference:started');
    expect(typing.at(-1)).toEqual({ channel: 'zulip:ops', metadata: undefined });
  });

  test("agent-framework's read: a file that is itself a link gives no hint, and only a file's first 2048 bytes are read for one", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'activity-origin-real-'));
    dirs.push(dir);
    const files = join(dir, 'files');
    mkdirSync(files);
    writeFileSync(join(files, 'note.md'), 'origin: zulip#ops#through-a-link\n');
    symlinkSync('note.md', join(files, 'linked.md'));
    writeFileSync(join(files, 'late.md'), `${'x'.repeat(3000)}\norigin: zulip#ops#past-the-head\n`);
    writeFileSync(join(files, 'early.md'), `origin: zulip#ops#in-the-head\n${'x'.repeat(5000)}\n`);
    const store = JsStore.openOrCreate({ path: join(dir, 'store') });
    const real = new WorkspaceModule({ mounts: [{ name: 'files', path: files, mode: 'read-only', watch: 'never' }] });
    real.initStore(store);
    try {
      const { module, typing, trace } = await moduleOver(real);
      const topicAfter = async (path: string) => {
        await module.onProcess({ type: 'workspace:modified', paths: [path] } as never, {} as never);
        trace('inference:started');
        trace('inference:completed');
        return (typing.at(-1)!.metadata as { topic?: string } | undefined)?.topic;
      };
      // A recipe's mounts don't follow links, so the read refuses a file that
      // is itself a link, even one naming a file in the same mount.
      expect(await topicAfter('files/linked.md')).toBeUndefined();
      expect(await topicAfter('files/late.md')).toBeUndefined();
      expect(await topicAfter('files/early.md')).toBe('in-the-head');
      expect(await topicAfter('files/note.md')).toBe('through-a-link');
    } finally {
      (store as { close?: () => void }).close?.();
    }
  });
});
