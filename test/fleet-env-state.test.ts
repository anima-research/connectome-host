import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FleetModule, type AutoStartChild } from '../src/modules/fleet-module.js';

function legacyChild(overrides = {}) {
  return {
    name: 'leaf', recipePath: resolve('test/mock-recipe.json'), dataDir: resolve('data/leaf'),
    socketPath: resolve('data/leaf/ipc.sock'), pid: null, status: 'exited', startedAt: 1,
    exitedAt: 2, lastEventAt: null, exitCode: 0, exitReason: 'clean', subscription: ['*'],
    autoRestart: true, env: { TOKEN: 'legacy-secret' }, ...overrides,
  };
}

function context(initial: unknown = null) {
  let current = initial;
  const writes: unknown[] = [];
  return {
    writes,
    ctx: {
      getState: () => current,
      setState: (value: unknown) => {
        current = structuredClone(value);
        writes.push(current);
      },
    } as unknown as Parameters<FleetModule['start']>[0],
  };
}

async function restoredEnv(config: AutoStartChild[], persisted = legacyChild()) {
  const fleet = new FleetModule({ autoStart: config.map(child => ({ ...child, autoStart: false })) });
  const store = context({ children: { leaf: persisted } });
  try {
    await fleet.start(store.ctx);
    const child = fleet.getChildren().get('leaf')!;
    const env = child.env;
    expect(store.writes.length).toBeGreaterThan(0);
    for (const state of store.writes) {
      expect((state as any).children.leaf).not.toHaveProperty('env');
      expect(JSON.stringify(state)).not.toContain('legacy-secret');
      expect(JSON.stringify(state)).not.toContain('current-secret');
    }
    return env;
  } finally {
    await fleet.stop();
  }
}

describe('Fleet child environment stays outside Chronicle state', () => {
  test('historical children recover current env from matching recipe configuration', async () => {
    const env = { TOKEN: 'current-secret' };
    const restored = await restoredEnv([{ name: 'leaf', recipe: 'test/mock-recipe.json', env }]);
    expect(restored).toEqual(env);
    expect(restored).not.toBe(env);
  });

  test('legacy env is ignored when current config or its env is absent', async () => {
    expect(await restoredEnv([])).toBeUndefined();
    expect(await restoredEnv([{ name: 'leaf', recipe: 'test/mock-recipe.json' }])).toBeUndefined();
    expect(await restoredEnv([{ name: 'leaf', recipe: 'test/mock-recipe.json', env: {} }])).toEqual({});
  });

  test('same name alone cannot grant a different persisted child current env', async () => {
    const configured = { name: 'leaf', recipe: 'test/mock-recipe.json', env: { TOKEN: 'current-secret' } };
    expect(await restoredEnv([{ ...configured, name: 'other' }])).toBeUndefined();
    expect(await restoredEnv([{ ...configured, recipe: 'test/other-recipe.json' }])).toBeUndefined();
    expect(await restoredEnv([{ ...configured, dataDir: 'data/other' }])).toBeUndefined();
  });

  test('identity mismatch warns about withheld restart overrides without logging values', () => {
    const configured = {
      name: 'leaf', recipe: 'test/mock-recipe.json',
      env: { TOKEN: 'current-secret' }, autoStart: false,
    };
    const warnings: string[] = [];
    const log = spyOn(console, 'error').mockImplementation((line) => { warnings.push(String(line)); });
    try {
      for (const [changes, fields] of [
        [{ recipe: 'test/private-recipe.json' }, 'recipe'],
        [{ dataDir: 'data/private-dir' }, 'dataDir'],
        [{ recipe: 'test/private-recipe.json', dataDir: 'data/private-dir' }, 'recipe, dataDir'],
      ] as const) {
        const fleet = new FleetModule({ autoStart: [{ ...configured, ...changes }] });
        const restored = (fleet as any).reconstructOrphan(legacyChild());
        expect(restored.env).toBeUndefined();
        expect(warnings.pop()).toBe(
          `[fleet] child "leaf": configured identity mismatch (${fields}); environment overrides withheld for restarts. Check child configuration and host working directory.`,
        );
      }
      // Matching and absent declarations are not identity mismatches.
      for (const autoStart of [[configured], []]) {
        const fleet = new FleetModule({ autoStart });
        (fleet as any).reconstructOrphan(legacyChild());
      }
      expect(warnings).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });

  test('URL recipes compare unchanged and explicit relative data directories normalize', async () => {
    const recipe = 'https://example.invalid/child.json';
    const env = { TOKEN: 'current-secret' };
    expect(await restoredEnv([{ name: 'leaf', recipe, dataDir: 'data/leaf', env }], legacyChild({ recipePath: recipe }))).toEqual(env);
  });

  test('live adoption keeps the PID, refreshes runtime env, and persists no env values', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-env-state-'));
    const config = {
      name: 'leaf', recipe: resolve('test/mock-recipe.json'), dataDir: dir,
      env: { TOKEN: 'legacy-secret' }, autoRestart: true,
    };
    const options = {
      childIndexPath: new URL('./mock-headless-child.ts', import.meta.url).pathname,
      gracefulShutdownMs: 1_000, sigtermEscalationMs: 500,
    };
    const store = context();
    const first = new FleetModule({ ...options, autoStart: [config] });
    let second: FleetModule | undefined;
    try {
      await first.start(store.ctx);
      const deadline = Date.now() + 5_000;
      while (first.getChildren().get('leaf')?.status !== 'ready') {
        if (Date.now() >= deadline) throw new Error('first child did not become ready');
        await Bun.sleep(20);
      }
      const original = first.getChildren().get('leaf')!;
      expect(original.env).toEqual({ TOKEN: 'legacy-secret' });
      const pid = original.pid;
      first.setDetachMode(true);
      await first.stop();

      // Adoption uses current configuration even when autoStart is disabled.
      second = new FleetModule({ ...options, autoStart: [{ ...config, autoStart: false, env: { TOKEN: 'current-secret' } }] });
      await second.start(store.ctx);
      const adopted = second.getChildren().get('leaf')!;
      expect(adopted.status).toBe('ready');
      expect(adopted.pid).toBe(pid);
      expect(adopted.env).toEqual({ TOKEN: 'current-secret' });
      for (const state of store.writes) {
        expect((state as any).children.leaf).not.toHaveProperty('env');
        expect(JSON.stringify(state)).not.toContain('legacy-secret');
        expect(JSON.stringify(state)).not.toContain('current-secret');
      }
    } finally {
      await second?.stop();
      // first retains the spawned-process handle, including on failed adoption.
      first.setDetachMode(false);
      await first.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
