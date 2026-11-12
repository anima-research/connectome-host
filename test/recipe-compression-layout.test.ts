import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Separate processes and physical packages: no module mocks/cache mutation.
// By default exercise a second copy of the installed CM (even two capable
// copies are conservatively rejected). An offline stock package can also be
// supplied to reproduce an old accept-but-ignore implementation, e.g.
// HOST_TEST_OLD_CM_PATH=/absolute/path/to/unpacked/context-manager-0.25.3.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modules = join(root, 'node_modules');
const nestedPackages = [
  ['duplicate installed CM', join(modules, '@animalabs/context-manager')],
  ...(process.env.HOST_TEST_OLD_CM_PATH ? [['old CM fixture', resolve(process.env.HOST_TEST_OLD_CM_PATH)]] : []),
];

for (const [label, nestedSource] of nestedPackages) {
  test(`compressionInstructions fails closed at construction: ${label}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'host-cm-layout-'));
    try {
      cpSync(join(root, 'src'), join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
      const localModules = join(dir, 'node_modules');
      mkdirSync(join(localModules, '@animalabs'), { recursive: true });
      for (const entry of readdirSync(modules)) {
        if (entry !== '@animalabs') symlinkSync(join(modules, entry), join(localModules, entry));
      }
      for (const entry of readdirSync(join(modules, '@animalabs'))) {
        if (entry !== 'agent-framework') {
          symlinkSync(realpathSync(join(modules, '@animalabs', entry)), join(localModules, '@animalabs', entry));
        }
      }
      const af = join(localModules, '@animalabs/agent-framework');
      cpSync(realpathSync(join(modules, '@animalabs/agent-framework')), af, {
        recursive: true, filter: path => !path.endsWith('/node_modules'),
      });
      writeFileSync(join(dir, 'probe.ts'), `
        import assert from 'node:assert/strict';
        import { dirname } from 'node:path';
        import { fileURLToPath } from 'node:url';
        import { AutobiographicalStrategy as AfStrategy, PassthroughStrategy } from '@animalabs/agent-framework';
        import { AutobiographicalStrategy as HostStrategy } from '@animalabs/context-manager';
        import { buildFrameworkStrategy, buildConversationsConfig, buildSubconsciousConfig } from './src/framework-strategy.ts';
        import { validateRecipe } from './src/recipe.ts';
        import { emptyExtensionRegistry } from './src/extensions.ts';
        const split = process.argv[2] === 'split';
        assert.equal(AfStrategy === HostStrategy, !split);
        const raw = strategy => ({ name: 'Synthetic layout', agent: { name: 'Synthetic', provider: 'mock', systemPrompt: 's', strategy },
          conversations: {}, subconscious: { enabled: true, reader: 'forks', model: 'mock-only', voice: 'Synthetic reader.' } });
        const build = input => buildFrameworkStrategy(input, 'mock-only', 'UTC');
        for (const type of [undefined, 'autobiographical']) {
          for (const compressionInstructions of [{ templates: { chunk: 'VALUE_SENTINEL {targetTokens}' } }, {}, { preset: 'default' }]) {
            const input = raw({ type, compressionInstructions });
            const validated = validateRecipe(input); // host validation alone succeeds in either layout
            const reader = buildSubconsciousConfig(validated, 'mock-only', 'UTC');
            assert.equal(reader.reader, 'forks');
            for (const run of [() => build(validated), () => build(input),
              () => buildConversationsConfig(validated, 'Synthetic', 'mock-only', 'UTC').strategyFactory(),
              () => reader.strategyFactory()]) {
              if (split) assert.throws(run, { name: 'TypeError', message:
                'Recipe compressionInstructions requires agent-framework and host to use the same @animalabs/context-manager; deduplicate @animalabs/context-manager.' });
              else assert.ok(run() instanceof AfStrategy);
            }
          }
        }
        assert.throws(() => build(raw({ compressionInstructions: { templates: { VALUE_SENTINEL: 'SECRET' } } })),
          { name: 'TypeError', message: 'Invalid compressionInstructions configuration: templates: unknown key' });
        // Legacy recipes do not acquire a deduplication requirement.
        for (const type of [undefined, 'autobiographical', 'frontdesk', 'passthrough']) assert.ok(build(validateRecipe(raw({ type }))));
        // Strategy-specific errors and the witnessed conflict win over the layout error.
        for (const type of ['frontdesk', 'passthrough']) assert.throws(() => build(raw({ type, compressionInstructions: {} })),
          /requires an autobiographical strategy/);
        assert.throws(() => build(raw({ witnessedInstruction: 'VALUE_SENTINEL', compressionInstructions: { templates: { witnessedChunk: 'SECRET' } } })),
          /Conflicting witnessed instruction configuration/);
        const registry = emptyExtensionRegistry();
        const custom = raw({ type: 'custom', compressionInstructions: 'extension-owned' });
        custom.extensions = { custom: { kind: 'strategy', path: './synthetic.ts' } };
        const validated = validateRecipe(custom);
        registry.strategies.set('custom', ({ config }) => { assert.equal(config, validated.agent.strategy); return new PassthroughStrategy(); });
        assert.ok(buildFrameworkStrategy(validated, 'mock-only', 'UTC', registry) instanceof PassthroughStrategy);
        console.log(JSON.stringify({ split, af: import.meta.resolve('@animalabs/agent-framework'), hostCM: import.meta.resolve('@animalabs/context-manager'),
          afCM: Bun.resolveSync('@animalabs/context-manager', dirname(fileURLToPath(import.meta.resolve('@animalabs/agent-framework')))) }));
      `);
      const run = (layout: string) => {
        const result = Bun.spawnSync([process.execPath, join(dir, 'probe.ts'), layout], { cwd: dir, timeout: 15_000 });
        expect(result.stderr.toString()).toBe('');
        expect(result.exitCode).toBe(0);
        console.log(result.stdout.toString().trim());
      };
      run('coherent');
      const nested = join(af, 'node_modules/@animalabs/context-manager');
      mkdirSync(dirname(nested), { recursive: true });
      cpSync(realpathSync(nestedSource!), nested, { recursive: true, filter: path => !path.endsWith('/node_modules') });
      const identity = JSON.parse(readFileSync(join(nested, 'package.json'), 'utf8'));
      console.log(JSON.stringify({ nestedSource: realpathSync(nestedSource!), name: identity.name, version: identity.version }));
      run('split');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 45_000);
}
