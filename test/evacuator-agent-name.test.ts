import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { SessionManager, type SessionMeta } from '../src/session-manager.js';
import { validateRecipe, type Recipe } from '../src/recipe.js';
import { FleetModule } from '../src/modules/fleet-module.js';

const script = new URL('../scripts/evacuator.ts', import.meta.url).pathname;
const root = resolve(dirname(script), '..');

async function runEvacuator(args: string[], options: {
  warmup?: boolean;
  importedName?: string | null;
  duplicateTitle?: string;
  existingOutput?: string;
  ref?: string | ((sessions: SessionMeta[]) => string);
} = {}) {
  const { warmup = false, importedName = 'Claude', duplicateTitle, ref = 'chosen-session' } = options;
  const dir = mkdtempSync(join(tmpdir(), 'evacuator-name-'));
  const out = join(dir, 'recipe.json');
  const capture = join(dir, 'warmup-args.json');
  const addendum = join(dir, 'addendum.txt');
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const sessions = new SessionManager(dir);
    const selected = sessions.createSession('chosen-session');
    const duplicate = duplicateTitle ? sessions.createSession(duplicateTitle) : undefined;
    if (duplicate) {
      writeFileSync(join(dir, 'sessions', duplicate.id + '.import-source.json'), JSON.stringify({ agentName: 'Other Import' }));
    }
    const choices = [selected, ...(duplicate ? [duplicate] : [])];
    const warmupRef = typeof ref === 'function' ? ref(choices) : ref;
    if (importedName !== null) {
      writeFileSync(join(dir, 'sessions', selected.id + '.import-source.json'), JSON.stringify({ agentName: importedName }));
    }
    if (options.existingOutput !== undefined) writeFileSync(out, options.existingOutput);
    writeFileSync(addendum, 'fixture addendum');
    writeFileSync(join(dir, 'evacuator-state.json'), JSON.stringify({
      model: 'claude-sonnet-4-6', promptSource: 'fixture',
      rawPrompt: 'fixture', adjustedPrompt: 'fixture', finalSystemPrompt: 'fixture',
      finalMemoriesBlock: '',
    }));
    // Capture the actual warmup launch without making compression calls.
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
      cwd: root, stdin: new Blob(warmup ? [`y\n${warmupRef}\n`] : []),
      stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, PATH: bin + ':' + process.env.PATH, CAPTURE_ARGS: capture },
    });
    proc = child;
    timer = setTimeout(() => child.kill(), 5000);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return {
      exitCode, stdout, stderr, dataDir: dir, sessionId: selected.id, duplicateId: duplicate?.id,
      recipe: existsSync(out) ? validateRecipe(JSON.parse(readFileSync(out, 'utf8'))) : undefined,
      warmupArgs: existsSync(capture) ? JSON.parse(readFileSync(capture, 'utf8')) as string[] : undefined,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    proc?.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function waitFor(check: () => boolean, label: string) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for ' + label);
    await Bun.sleep(20);
  }
}

async function observeHostSwitch(recipe: Recipe, importedName: string) {
  const dir = mkdtempSync(join(tmpdir(), 'evacuator-switch-'));
  const dataDir = join(dir, 'data');
  const out = join(dir, 'identities.jsonl');
  const extension = join(dir, 'identity-probe.mjs');
  const recipePath = join(dir, 'recipe.json');
  const fleet = new FleetModule({
    childIndexPath: join(root, 'src', 'index.ts'),
    gracefulShutdownMs: 1000, sigtermEscalationMs: 500,
  });
  try {
    const sessions = new SessionManager(dataDir);
    const native = sessions.createSession('Native');
    const imported = sessions.createSession('Imported');
    writeFileSync(join(dataDir, 'sessions', imported.id + '.import-source.json'), JSON.stringify({ agentName: importedName }));
    sessions.setActiveSession(native.id); // the documented pre-import active session
    writeFileSync(extension, `
      import { appendFileSync } from 'node:fs';
      const membranes = new WeakMap();
      let nextId = 0;
      export function register(api) {
        api.registerModule(({ storePath, config }) => {
          return {
            name: 'identity-probe',
            getTools() { return []; },
            async start() {},
            async stop() {},
            async handleToolCall() { return { success: false, error: 'no tools' }; },
            async onProcess() { return {}; },
            setFramework(framework) {
              const membrane = framework.getMembrane();
              if (!membranes.has(membrane)) membranes.set(membrane, ++nextId);
              appendFileSync(config.out, JSON.stringify({
                storePath,
                agents: framework.getAllAgents().map(agent => agent.name),
                // Observe the actual constructed role anchor, without changing it.
                assistantParticipant: membrane.config.assistantParticipant,
                membraneId: membranes.get(membrane),
              }) + '\\n');
            },
          };
        });
      }
    `);
    writeFileSync(recipePath, JSON.stringify({
      ...recipe,
      agent: { ...recipe.agent, provider: 'mock' },
      modules: { wake: false, workspace: false, subagents: false, lessons: false, retrieval: false, subscriptionGc: false },
      extensions: { probe: { kind: 'module', path: extension, config: { out } } },
    }));
    const launched = await fleet.handleToolCall({
      id: 'launch', name: 'launch', input: { name: 'host', recipe: recipePath, dataDir },
    });
    if (!launched.success) {
      throw new Error(JSON.stringify(launched) + '\n' + readFileSync(join(dataDir, 'startup.log'), 'utf8'));
    }
    expect(launched.success).toBe(true);
    const observations = () => existsSync(out)
      ? readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    await waitFor(() => observations().length === 1, 'native-session identity');
    const sent = await fleet.handleToolCall({
      id: 'switch', name: 'command', input: { name: 'host', command: '/session switch ' + imported.id },
    });
    expect(sent.success).toBe(true);
    await waitFor(() => observations().length === 2, 'imported-session identity');
    const records = observations();
    expect(records.map(r => r.storePath)).toEqual([
      sessions.getStorePath(native.id), sessions.getStorePath(imported.id),
    ]);
    expect(records.map(r => r.agents)).toEqual([[importedName], [importedName]]);
    expect(records.map(r => r.assistantParticipant)).toEqual([importedName, importedName]);
    expect(records[1].membraneId).toBe(records[0].membraneId);
    expect(sessions.getActiveSession()?.id).toBe(imported.id);
  } finally {
    await fleet.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('evacuator participant naming', () => {
  test('without a selected session the CLI pins the importer default before host construction', async () => {
    const result = await runEvacuator([]);
    expect(result.exitCode).toBe(0);
    expect(result.recipe?.agent.name).toBe('Claude');
    expect(result.stdout).toContain('/session switch');
    expect(result.stdout).not.toContain('--session');
  });

  test('resume warns when no warmup selection would replace a custom output participant', async () => {
    const result = await runEvacuator([], { existingOutput: JSON.stringify({ agent: { name: 'Custom Import' } }) });
    expect(result.exitCode).toBe(0);
    expect(result.recipe?.agent.name).toBe('Claude');
    expect(result.stderr).toContain('Changing revival participant from "Custom Import" to "Claude"');
    expect(result.stderr).toContain('Existing warmup summaries remain in their original participant namespace');
    expect(result.stderr).toContain('--agent');
  });

  test('retaining the output participant is quiet; explicit changes still warn', async () => {
    const existingOutput = JSON.stringify({ agent: { name: 'Custom Import' } });
    const same = await runEvacuator(['--agent', 'Custom Import'], { existingOutput });
    expect(same.exitCode).toBe(0);
    expect(same.stderr).not.toContain('Changing revival participant');
    const changed = await runEvacuator(['--agent', 'Other'], { existingOutput });
    expect(changed.exitCode).toBe(0);
    expect(changed.stderr).toContain('Changing revival participant from "Custom Import" to "Other"');
  });

  test('an unreadable prior recipe is reported before replacement', async () => {
    const result = await runEvacuator([], { existingOutput: '{broken' });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('Could not read the existing output recipe participant');
  });

  test('explicit name reaches both recipe and canonical warmup command', async () => {
    const result = await runEvacuator(['--agent', 'Override'], { warmup: true, importedName: 'Imported Name' });
    expect(result.exitCode).toBe(0);
    expect(result.recipe?.agent.name).toBe('Override');
    expect(result.stderr).toContain('overrides the selected session');
    expect(result.warmupArgs).toEqual([
      join(root, 'scripts', 'warmup-session.ts'), result.sessionId,
      '--data-dir', result.dataDir, '--model', 'claude-sonnet-4-6', '--agent', 'Override',
    ]);
  });

  test('a chosen custom-name sidecar supplies the pinned recipe and warmup name', async () => {
    const result = await runEvacuator([], { warmup: true, importedName: 'Custom Import' });
    expect(result.exitCode).toBe(0);
    expect(result.recipe?.agent.name).toBe('Custom Import');
    expect(result.warmupArgs?.slice(-2)).toEqual(['--agent', 'Custom Import']);
  });

  test('legacy chosen sessions without a sidecar pin the same Claude fallback for both consumers', async () => {
    const result = await runEvacuator([], { warmup: true, importedName: null });
    expect(result.exitCode).toBe(0);
    expect(result.recipe?.agent.name).toBe('Claude');
    expect(result.warmupArgs?.slice(-2)).toEqual(['--agent', 'Claude']);
  });

  test('an unknown warmup session fails before writing a misleading recipe', async () => {
    const result = await runEvacuator([], { warmup: true, ref: 'missing-session' });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('No session matching "missing-session"');
    expect(result.recipe).toBeUndefined();
    expect(result.warmupArgs).toBeUndefined();
  });

  test('duplicate titles require a full ID before identity is pinned or warmup starts', async () => {
    const result = await runEvacuator([], { warmup: true, duplicateTitle: 'CHOSEN-SESSION' });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Ambiguous warmup session');
    expect(result.stderr).toContain(result.sessionId);
    expect(result.stderr).toContain(result.duplicateId!);
    expect(result.recipe).toBeUndefined();
    expect(result.warmupArgs).toBeUndefined();
  });

  test('a full ID selects the intended duplicate title and its own participant', async () => {
    const result = await runEvacuator([], {
      warmup: true, duplicateTitle: 'chosen-session', ref: choices => choices[1]!.id,
    });
    expect(result.exitCode).toBe(0);
    expect(result.recipe?.agent.name).toBe('Other Import');
    expect(result.warmupArgs?.[1]).toBe(result.duplicateId);
    expect(result.warmupArgs?.slice(-2)).toEqual(['--agent', 'Other Import']);
  });

  test('missing or empty explicit names fail clearly before composition', async () => {
    for (const args of [['--agent'], ['--agent', ''], ['--agent', '   '], ['--agent', '--no-warmup']]) {
      const result = await runEvacuator(args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('--agent requires a non-empty name');
      expect(result.recipe).toBeUndefined();
    }
  });

  for (const importedName of ['Claude', 'Custom Import']) {
    test(`native startup then imported-session switch keeps ${importedName} and its Membrane role anchor`, async () => {
      const result = await runEvacuator([], { warmup: importedName !== 'Claude', importedName });
      expect(result.exitCode).toBe(0);
      await observeHostSwitch(result.recipe!, importedName);
    }, 15000);
  }
});
