import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { SessionManager } from '../src/session-manager.js';
import { resolveAgentName } from '../src/agent-name.js';
import { validateRecipe } from '../src/recipe.js';

const script = new URL('../scripts/evacuator.ts', import.meta.url).pathname;
const root = resolve(dirname(script), '..');

async function runEvacuator(args: string[], warmup = false) {
  const dir = mkdtempSync(join(tmpdir(), 'evacuator-name-'));
  const out = join(dir, 'recipe.json');
  const capture = join(dir, 'warmup-args.json');
  const addendum = join(dir, 'addendum.txt');
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    writeFileSync(addendum, 'fixture addendum');
    writeFileSync(join(dir, 'evacuator-state.json'), JSON.stringify({
      model: 'claude-sonnet-4-6', promptSource: 'fixture',
      rawPrompt: 'fixture', adjustedPrompt: 'fixture', finalSystemPrompt: 'fixture',
      finalMemoriesBlock: '',
    }));
    // Run the real CLI but capture its optional warmup subprocess instead of
    // making compression calls. The shebang pins real Bun, avoiding PATH recursion.
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'bun'),
      `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.CAPTURE_ARGS, JSON.stringify(process.argv.slice(2)));\n`,
      { mode: 0o755 },
    );
    const child = Bun.spawn([
      process.execPath, script, dir, '--data-dir', dir, '--out', out,
      '--addendum', addendum, '--resume', ...(warmup ? [] : ['--no-warmup']), ...args,
    ], {
      cwd: root, stdin: new Blob(warmup ? ['y\nchosen-session\n'] : []),
      stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, PATH: bin + ':' + process.env.PATH, CAPTURE_ARGS: capture },
    });
    proc = child;
    timer = setTimeout(() => child.kill(), 5000);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return {
      exitCode, stdout, stderr, dataDir: dir,
      recipe: existsSync(out) ? validateRecipe(JSON.parse(readFileSync(out, 'utf8'))) : undefined,
      warmupArgs: existsSync(capture) ? JSON.parse(readFileSync(capture, 'utf8')) as string[] : undefined,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    proc?.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('evacuator participant naming', () => {
  test('default CLI output leaves the imported session sidecar in control', async () => {
    const result = await runEvacuator([]);
    expect(result.exitCode).toBe(0);
    expect(result.recipe?.agent).not.toHaveProperty('name');
    const dir = mkdtempSync(join(tmpdir(), 'evacuator-sidecar-'));
    try {
      const manager = new SessionManager(dir);
      for (const name of ['Claude', 'Custom Import']) {
        const session = manager.createSession(name);
        writeFileSync(join(dir, 'sessions', session.id + '.import-source.json'), JSON.stringify({ agentName: name }));
        const sidecar = manager.getImportSource(session.id)?.agentName;
        const live = resolveAgentName({ explicit: result.recipe?.agent.name, sidecar, default: 'agent' });
        const warm = resolveAgentName({ sidecar, default: 'Claude' });
        expect(live.name).toBe(name);
        expect(live.name).toBe(warm.name);
        expect(live.mismatch).toBeUndefined();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an explicit name reaches both recipe and the actual warmup command', async () => {
    const result = await runEvacuator(['--agent', 'Custom Import'], true);
    expect(result.exitCode).toBe(0);
    expect(result.recipe?.agent.name).toBe('Custom Import');
    expect(result.warmupArgs).toEqual([
      join(root, 'scripts', 'warmup-session.ts'), 'chosen-session',
      '--data-dir', result.dataDir, '--model', 'claude-sonnet-4-6',
      '--agent', 'Custom Import',
    ]);
    // Legacy sessions lack a sidecar: an explicit name still aligns the two
    // consumers despite their intentionally different native fallback names.
    expect(resolveAgentName({ explicit: result.recipe?.agent.name, default: 'agent' }).name)
      .toBe(resolveAgentName({ explicit: 'Custom Import', default: 'Claude' }).name);
  });

  test('default warmup invocation leaves its own sidecar resolution intact', async () => {
    const result = await runEvacuator([], true);
    expect(result.exitCode).toBe(0);
    expect(result.recipe?.agent).not.toHaveProperty('name');
    expect(result.warmupArgs).toEqual([
      join(root, 'scripts', 'warmup-session.ts'), 'chosen-session',
      '--data-dir', result.dataDir, '--model', 'claude-sonnet-4-6',
    ]);
  });

  test('missing or empty explicit names fail clearly before composition', async () => {
    for (const args of [['--agent'], ['--agent', ''], ['--agent', '   '], ['--agent', '--no-warmup']]) {
      const result = await runEvacuator(args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('--agent requires a non-empty name');
      expect(result.recipe).toBeUndefined();
    }
  });
});
