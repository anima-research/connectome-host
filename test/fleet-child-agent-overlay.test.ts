/**
 * A fleet child keeps its own agent overlay (mcpl-servers.agent.child.json) in
 * its data directory, where every reader of the overlay finds it, and a host
 * outside a fleet keeps its own (mcpl-servers.agent.json) in its working
 * directory. A child starts from an empty overlay, or, where it was
 * launched into its data directory before (its startup.log is there), from
 * a copy of the working directory's, which every child read as its own
 * before children had their own.
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FleetModule, fleetChildEnv } from '../src/modules/fleet-module.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const CHILD = join(TEST_DIR, 'mock-overlay-env-child.ts');
const OVERLAY = 'mcpl-servers.agent.json';
const CHILD_OVERLAY = 'mcpl-servers.agent.child.json';

interface Recorded { env: string | null; overlay: string; admin: string; cwd: string }

/** A parent's working directory holding an overlay of the parent's own: a server it deployed, with a relative arg, and a tombstone. */
function parentHome(): { home: string; overlay: string; text: string } {
  const home = mkdtempSync(join(tmpdir(), 'fleet-child-overlay-'));
  const overlay = join(home, OVERLAY);
  const text = JSON.stringify({ mcplServers: { 'parent-notes': { command: 'node', args: ['./notes-server.js'] }, search: { disabled: true } } }, null, 2) + '\n';
  writeFileSync(overlay, text);
  return { home, overlay, text };
}

/** Launch `name` into `dataDir` from a parent running in `home`, run `then` while it's up, and stop it. */
async function withChild(home: string, name: string, dataDir: string, then: (recorded: Recorded) => void | Promise<void>): Promise<void> {
  const fleet = new FleetModule({
    childIndexPath: CHILD, socketWaitTimeoutMs: 15_000, readyTimeoutMs: 10_000, gracefulShutdownMs: 3_000, sigtermEscalationMs: 1_000,
  });
  await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);
  const cwd = process.cwd();
  process.chdir(home);
  try {
    const launched = await fleet.handleToolCall({ id: `launch-${name}`, name: 'launch', input: { name, recipe: 'mock-recipe', dataDir } });
    expect(launched.error).toBeUndefined();
    expect(launched.success).toBe(true);
    await then(JSON.parse(readFileSync(join(dataDir, 'child-env.json'), 'utf8')) as Recorded);
  } finally {
    process.chdir(cwd);
    await fleet.handleToolCall({ id: `kill-${name}`, name: 'kill', input: { name } });
    await fleet.stop();
  }
}

describe("a fleet child's agent overlay", () => {
  test('a new child gets an empty overlay of its own in its data directory, its owner\'s alone whatever the working directory\'s mode, and every reader of the overlay takes its path', async () => {
    const { home, overlay, text } = parentHome();
    // The working directory's overlay as the host writes it under a common
    // umask, readable by others; and no umask now, so the mode the seed asks
    // for is the mode the file gets.
    const umask = process.umask(0);
    try {
      chmodSync(overlay, 0o644);
      const dataDir = join(home, 'data', 'child-1');
      const own = join(dataDir, CHILD_OVERLAY);
      await withChild(home, 'child-1', dataDir, (recorded) => {
        expect(recorded).toEqual({ env: own, overlay: own, admin: own, cwd: realpathSync(home) });
      });
      expect(JSON.parse(readFileSync(own, 'utf8'))).toEqual({ mcplServers: {} });
      expect(statSync(own).mode & 0o777).toBe(0o600);
      expect(readFileSync(overlay, 'utf8')).toBe(text);
    } finally {
      process.umask(umask);
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  test('a child gets its own overlay\'s path though the parent\'s environment or a recipe entry\'s env names another', async () => {
    const { home, overlay, text } = parentHome();
    const inherited = process.env.MCPL_AGENT_OVERLAY_FILE;
    // The parent's environment names the parent's own overlay, which the
    // child's launch would otherwise pass on with the rest of it.
    process.env.MCPL_AGENT_OVERLAY_FILE = overlay;
    try {
      const dataDir = join(home, 'data', 'child-1');
      const own = join(dataDir, CHILD_OVERLAY);
      await withChild(home, 'child-1', dataDir, (recorded) => {
        expect(recorded.env).toBe(own);
        expect(recorded.overlay).toBe(own);
        expect(recorded.admin).toBe(own);
      });
      // A recipe's entry for the child gives its launch an env of its own,
      // which an agent's launch can't (the fleet strips it).
      expect(fleetChildEnv({ MCPL_AGENT_OVERLAY_FILE: overlay }, { MCPL_AGENT_OVERLAY_FILE: overlay }, 'UTC', dataDir).MCPL_AGENT_OVERLAY_FILE).toBe(own);
      expect(readFileSync(overlay, 'utf8')).toBe(text);
    } finally {
      if (inherited === undefined) delete process.env.MCPL_AGENT_OVERLAY_FILE;
      else process.env.MCPL_AGENT_OVERLAY_FILE = inherited;
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  test('a child launched into its data directory before starts from a copy of the working directory\'s overlay, once, its owner\'s alone, and keeps it as its own', async () => {
    const { home, overlay, text } = parentHome();
    const umask = process.umask(0);
    try {
      chmodSync(overlay, 0o644);
      const dataDir = join(home, 'data', 'child-1');
      mkdirSync(dataDir, { recursive: true });
      // Every launch opens startup.log in the data directory before its spawn.
      writeFileSync(join(dataDir, 'startup.log'), '--- launch\n');
      const own = join(dataDir, CHILD_OVERLAY);
      await withChild(home, 'child-1', dataDir, (recorded) => {
        expect(recorded.overlay).toBe(own);
      });
      // As it was, its relative arg included, which resolves against the
      // working directory from either file (resolveOverlayEntry).
      expect(readFileSync(own, 'utf8')).toBe(text);
      expect(statSync(own).mode & 0o777).toBe(0o600);

      // What the child's file holds from then on is the child's: the parent's
      // later changes don't reach it, and a later launch leaves it as it is.
      const childsOwn = JSON.stringify({ mcplServers: { 'child-notes': { command: 'notes-server' } } }, null, 2) + '\n';
      writeFileSync(own, childsOwn);
      writeFileSync(overlay, JSON.stringify({ mcplServers: { 'parent-later': { command: 'later-server' } } }, null, 2) + '\n');
      await withChild(home, 'child-1', dataDir, (recorded) => {
        expect(recorded.overlay).toBe(own);
      });
      expect(readFileSync(own, 'utf8')).toBe(childsOwn);
    } finally {
      process.umask(umask);
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  test('a child launched into its data directory before, with no overlay in the working directory, starts from an empty one, which a later launch keeps', async () => {
    const { home, overlay } = parentHome();
    try {
      rmSync(overlay);
      const dataDir = join(home, 'data', 'child-1');
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, 'startup.log'), '--- launch\n');
      const own = join(dataDir, CHILD_OVERLAY);
      await withChild(home, 'child-1', dataDir, () => {});
      expect(JSON.parse(readFileSync(own, 'utf8'))).toEqual({ mcplServers: {} });
      const childsOwn = JSON.stringify({ mcplServers: { 'child-notes': { command: 'notes-server' } } }, null, 2) + '\n';
      writeFileSync(own, childsOwn);
      await withChild(home, 'child-1', dataDir, () => {});
      expect(readFileSync(own, 'utf8')).toBe(childsOwn);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  test('a child whose data directory is the working directory, by any spelling, keeps its own overlay there beside the host\'s, starting from a copy of it, and restarts in place', async () => {
    const { home, overlay, text } = parentHome();
    // A link to the working directory, which is that directory by its real path.
    const links = mkdtempSync(join(tmpdir(), 'fleet-child-overlay-link-'));
    symlinkSync(home, join(links, 'home'));
    try {
      const own = join(realpathSync(home), CHILD_OVERLAY);
      // As for a child an earlier version launched there, whose launch left
      // its startup.log there, the child starts from a copy.
      writeFileSync(join(home, 'startup.log'), '--- launch\n');
      await withChild(home, 'child-1', home, (recorded) => {
        expect(recorded.env).toBe(join(home, CHILD_OVERLAY));
        expect(realpathSync(recorded.overlay)).toBe(own);
        expect(recorded.admin).toBe(recorded.overlay);
      });
      expect(readFileSync(own, 'utf8')).toBe(text);

      // From then on it's the child's, apart from the host's, by any spelling.
      const childsOwn = JSON.stringify({ mcplServers: { 'child-notes': { command: 'notes-server' } } }, null, 2) + '\n';
      writeFileSync(own, childsOwn);
      for (const dataDir of ['.', join(links, 'home')]) {
        await withChild(home, 'child-1', dataDir, (recorded) => {
          expect(realpathSync(recorded.overlay)).toBe(own);
          expect(recorded.admin).toBe(recorded.overlay);
        });
      }
      expect(readFileSync(own, 'utf8')).toBe(childsOwn);
      expect(readFileSync(overlay, 'utf8')).toBe(text);

      // A restart there restarts it in place, keeping its own.
      const fleet = new FleetModule({
        childIndexPath: CHILD, socketWaitTimeoutMs: 15_000, readyTimeoutMs: 10_000, gracefulShutdownMs: 3_000, sigtermEscalationMs: 1_000,
      });
      await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);
      const cwd = process.cwd();
      process.chdir(home);
      try {
        expect((await fleet.handleToolCall({ id: 'launch', name: 'launch', input: { name: 'child-1', recipe: 'mock-recipe', dataDir: home } })).success).toBe(true);
        const restarted = await fleet.handleToolCall({ id: 'restart', name: 'restart', input: { name: 'child-1' } });
        expect(restarted.error).toBeUndefined();
        expect(restarted.success).toBe(true);
        expect(fleet.getChildren().get('child-1')!.status).toBe('ready');
      } finally {
        process.chdir(cwd);
        await fleet.handleToolCall({ id: 'kill', name: 'kill', input: { name: 'child-1' } });
        await fleet.stop();
      }
      expect(readFileSync(own, 'utf8')).toBe(childsOwn);
      expect(readFileSync(overlay, 'utf8')).toBe(text);
    } finally {
      rmSync(links, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);

  test('a new child given a directory made ahead of time, holding anything but a startup.log, starts from an empty overlay, not from a copy', async () => {
    const { home, overlay, text } = parentHome();
    try {
      const dataDir = join(home, 'data', 'child-1');
      // As a volume's root or an entrypoint's mkdir leaves it.
      mkdirSync(join(dataDir, 'lost+found'), { recursive: true });
      writeFileSync(join(dataDir, '.gitkeep'), '');
      const own = join(dataDir, CHILD_OVERLAY);
      await withChild(home, 'child-1', dataDir, (recorded) => {
        expect(recorded.overlay).toBe(own);
      });
      expect(JSON.parse(readFileSync(own, 'utf8'))).toEqual({ mcplServers: {} });
      expect(readFileSync(overlay, 'utf8')).toBe(text);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  // Root writes into a directory whatever its mode, so there the seed can't be made to fail.
  test.skipIf(process.getuid?.() === 0)('a new child whose overlay can\'t be written leaves no startup.log, so a later launch starts it empty, not from a copy',
    async () => {
      const { home } = parentHome();
      try {
        mkdirSync(join(home, 'data'));
        const dataDir = join(home, 'data', 'child-1');
        const fleet = new FleetModule({
          childIndexPath: CHILD, socketWaitTimeoutMs: 15_000, readyTimeoutMs: 10_000, gracefulShutdownMs: 3_000, sigtermEscalationMs: 1_000,
        });
        await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);
        const cwd = process.cwd();
        // The data directory is made unwritable, so the seed fails after its mkdir.
        const umask = process.umask(0o222);
        process.chdir(home);
        try {
          const refused = await fleet.handleToolCall({ id: 'launch-unwritable', name: 'launch', input: { name: 'child-1', recipe: 'mock-recipe', dataDir } });
          expect(refused.success).toBe(false);
          expect(refused.error).toContain(`couldn't write the agent overlay of child 'child-1', ${join(dataDir, CHILD_OVERLAY)} (EACCES)`);
        } finally {
          process.chdir(cwd);
          process.umask(umask);
          await fleet.stop();
        }
        expect(existsSync(join(dataDir, 'startup.log'))).toBe(false);
        // Once its directory can be written, a launch takes it for a new
        // child's, though the directory is there and the working directory
        // holds an overlay.
        chmodSync(dataDir, 0o755);
        await withChild(home, 'child-1', dataDir, (recorded) => {
          expect(recorded.overlay).toBe(join(dataDir, CHILD_OVERLAY));
        });
        expect(JSON.parse(readFileSync(join(dataDir, CHILD_OVERLAY), 'utf8'))).toEqual({ mcplServers: {} });
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }, 60_000);

  test.skipIf(process.getuid?.() === 0)('a child whose data directory was there, and whose copy can\'t be written, keeps that directory and is told both paths, so its next launch copies again',
    async () => {
      const { home, overlay, text } = parentHome();
      const dataDir = join(home, 'data', 'child-1');
      try {
        // A former child's, by its startup.log, and unwritable.
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(join(dataDir, 'startup.log'), '--- launch\n');
        chmodSync(dataDir, 0o555);
        const fleet = new FleetModule({
          childIndexPath: CHILD, socketWaitTimeoutMs: 15_000, readyTimeoutMs: 10_000, gracefulShutdownMs: 3_000, sigtermEscalationMs: 1_000,
        });
        await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);
        const cwd = process.cwd();
        process.chdir(home);
        try {
          const refused = await fleet.handleToolCall({ id: 'launch-unwritable', name: 'launch', input: { name: 'child-1', recipe: 'mock-recipe', dataDir } });
          expect(refused.success).toBe(false);
          expect(refused.error).toContain(`couldn't write the agent overlay of child 'child-1', ${join(dataDir, CHILD_OVERLAY)}, as a copy of ${join(realpathSync(home), OVERLAY)} (EACCES). Ask whoever runs this host to check those paths`);
        } finally {
          process.chdir(cwd);
          await fleet.stop();
        }
        expect(existsSync(dataDir)).toBe(true);
        chmodSync(dataDir, 0o755);
        await withChild(home, 'child-1', dataDir, () => {});
        expect(readFileSync(join(dataDir, CHILD_OVERLAY), 'utf8')).toBe(text);
        expect(readFileSync(overlay, 'utf8')).toBe(text);
      } finally {
        if (existsSync(dataDir)) chmodSync(dataDir, 0o755);
        rmSync(home, { recursive: true, force: true });
      }
    }, 60_000);

  // CI runs the suite on Linux, where a file-size limit was checked to fail a copy partway.
  test.skipIf(process.platform !== 'linux')('a seed whose copy or write fails after making the file, as on a full disk, leaves no file for the next launch to keep', () => {
    const home = mkdtempSync(join(tmpdir(), 'fleet-child-overlay-full-'));
    try {
      writeFileSync(join(home, OVERLAY), JSON.stringify({ mcplServers: { 'parent-notes': { command: 'node', args: ['./notes-server.js'] } } }));
      const script = `
        import { existsSync } from 'node:fs';
        import { seedChildAgentOverlay } from ${JSON.stringify(join(TEST_DIR, '..', 'src', 'mcpl-config.ts'))};
        const out = {};
        for (const [name, copy] of [['copied.json', true], ['empty.json', false]]) {
          try { seedChildAgentOverlay(name, ${JSON.stringify(OVERLAY)}, copy); out[name] = 'written'; } catch (e) { out[name] = e.code; }
          out[name + ' left'] = existsSync(name);
        }
        console.log('RESULT ' + JSON.stringify(out));
      `;
      // A file-size limit of 0 fails each write once its file is made, as a
      // full disk does, with SIGXFSZ ignored so the write returns EFBIG.
      const run = Bun.spawnSync(['bash', '-c', 'ulimit -f 0; trap "" XFSZ; exec "$0" -e "$1"', process.execPath, script], { cwd: home });
      const line = run.stdout.toString().split('\n').find((l) => l.startsWith('RESULT '));
      if (line === undefined) throw new Error(`the seed printed no result (exit ${run.exitCode}): ${run.stderr.toString().slice(-2000)}`);
      expect(JSON.parse(line.slice('RESULT '.length))).toEqual({
        'copied.json': 'EFBIG', 'copied.json left': false, 'empty.json': 'EFBIG', 'empty.json left': false,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a seed leaves whatever is already at the child\'s path as it is, its own overlay where the copy\'s source fails, and a link someone made', async () => {
    // Imported here, so the file's other tests still run against sources without it.
    const { seedChildAgentOverlay } = await import('../src/mcpl-config.js');
    const home = mkdtempSync(join(tmpdir(), 'fleet-child-overlay-kept-'));
    try {
      // A copy whose source is a directory would fail on it, while the
      // child's own file is there.
      mkdirSync(join(home, 'source-dir'));
      const childsOwn = JSON.stringify({ mcplServers: { 'child-notes': { command: 'notes-server' } } }, null, 2) + '\n';
      writeFileSync(join(home, 'own.json'), childsOwn);
      seedChildAgentOverlay(join(home, 'own.json'), join(home, 'source-dir'), true);
      expect(readFileSync(join(home, 'own.json'), 'utf8')).toBe(childsOwn);
      // A link, even one to nothing, is kept as made.
      symlinkSync(join(home, 'nowhere.json'), join(home, 'link.json'));
      seedChildAgentOverlay(join(home, 'link.json'), join(home, 'source-dir'), true);
      expect(lstatSync(join(home, 'link.json')).isSymbolicLink()).toBe(true);
      expect(existsSync(join(home, 'nowhere.json'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a seed\'s copy is never wider than the original, and a source it can\'t read, a directory or a file it may not read, makes no file', async () => {
    const { seedChildAgentOverlay } = await import('../src/mcpl-config.js');
    const home = mkdtempSync(join(tmpdir(), 'fleet-child-overlay-mode-'));
    const umask = process.umask(0);
    try {
      const text = '{ "mcplServers": {} }\n';
      writeFileSync(join(home, 'readonly.json'), text);
      chmodSync(join(home, 'readonly.json'), 0o400);
      seedChildAgentOverlay(join(home, 'copy.json'), join(home, 'readonly.json'), true);
      expect(readFileSync(join(home, 'copy.json'), 'utf8')).toBe(text);
      expect(statSync(join(home, 'copy.json')).mode & 0o777).toBe(0o400);
      mkdirSync(join(home, 'source-dir'));
      expect(() => seedChildAgentOverlay(join(home, 'none.json'), join(home, 'source-dir'), true)).toThrow();
      expect(existsSync(join(home, 'none.json'))).toBe(false);
      // Root reads a file whatever its mode.
      if (process.getuid?.() !== 0) {
        writeFileSync(join(home, 'shut.json'), text);
        chmodSync(join(home, 'shut.json'), 0o000);
        expect(() => seedChildAgentOverlay(join(home, 'none2.json'), join(home, 'shut.json'), true)).toThrow();
        expect(existsSync(join(home, 'none2.json'))).toBe(false);
      }
    } finally {
      process.umask(umask);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a launch keeps a link someone made at the child\'s overlay file, to the host\'s own overlay, as made', async () => {
    const { home, overlay, text } = parentHome();
    try {
      const dataDir = join(home, 'data', 'child-1');
      mkdirSync(dataDir, { recursive: true });
      symlinkSync(overlay, join(dataDir, CHILD_OVERLAY));
      await withChild(home, 'child-1', dataDir, (recorded) => {
        expect(recorded.overlay).toBe(join(dataDir, CHILD_OVERLAY));
      });
      expect(lstatSync(join(dataDir, CHILD_OVERLAY)).isSymbolicLink()).toBe(true);
      expect(readFileSync(overlay, 'utf8')).toBe(text);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  test('a host outside a fleet keeps its overlay in its working directory, and MCPL_AGENT_OVERLAY_FILE names another, from that directory', () => {
    const home = mkdtempSync(join(tmpdir(), 'fleet-child-overlay-alone-'));
    try {
      const read = (env: Record<string, string>): string => {
        const run = Bun.spawnSync([process.execPath, '-e', `import { DEFAULT_AGENT_OVERLAY_PATH } from ${JSON.stringify(join(TEST_DIR, '..', 'src', 'mcpl-config.ts'))}; console.log(DEFAULT_AGENT_OVERLAY_PATH);`], {
          cwd: home, env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'MCPL_AGENT_OVERLAY_FILE')), ...env },
        });
        expect(run.exitCode).toBe(0);
        return run.stdout.toString().trim();
      };
      const here = realpathSync(home);
      expect(read({})).toBe(join(here, OVERLAY));
      expect(read({ MCPL_AGENT_OVERLAY_FILE: '' })).toBe(join(here, OVERLAY));
      expect(read({ MCPL_AGENT_OVERLAY_FILE: join('data', 'own.json') })).toBe(join(here, 'data', 'own.json'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
