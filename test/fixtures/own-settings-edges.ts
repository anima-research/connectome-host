// Run by test/own-settings.test.ts in a process of its own, with a time limit: a value that keeps the
// chunker's loop from moving would stop the test runner itself. For each entry of the JSON list in argv[2],
// it applies the entry as a resident's file does, builds the host's strategy from the recipe in force,
// stores a picture, a tool call with a long argument and its long result, and a long message, and
// compiles once. It prints a line for each entry as it starts it, and one as it ends it, so a run that
// the limit stops names the entry it was in.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextManager } from '@animalabs/context-manager';
import { buildFrameworkStrategy } from '../../src/framework-strategy.js';
import { checkOwnSettings } from '../../src/own-settings.js';
import { substituteEnvVars, validateRecipe } from '../../src/recipe.js';

const written = {
  name: 'Ember', ownSettings: 'all',
  agent: { name: 'ember', model: 'claude-opus-4-6', systemPrompt: 'hi' },
  subconscious: { enabled: true, reader: 'persistent', systemPrompt: 'read' },
  modules: { retrieval: true, lessons: true, subagents: true, wake: true },
};
const origin = { kind: 'authored' as const, document: structuredClone(written) };
const operator = { recipe: validateRecipe(substituteEnvVars(written, 'recipe.json', {}), origin), origin };
// Long enough that a chunk of a few tokens shards it, and short enough for one compile.
const long = Array.from({ length: 400 }, (_, i) => `Line ${i} of the long message, with a few words in it.`).join('\n');
// A PNG of one pixel.
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const entries = JSON.parse(process.argv[2]!) as Array<[string, unknown]>;
for (const [name, value] of entries) {
  const label = `${name}=${JSON.stringify(value)}`;
  console.log(`start ${label}`);
  const root = mkdtempSync(join(tmpdir(), 'chost-own-edges-'));
  try {
    mkdirSync(join(root, 'own-settings'));
    writeFileSync(join(root, 'own-settings', 'own.json'), JSON.stringify({ [name]: value }));
    const check = checkOwnSettings(operator, root);
    if (check.entries[0]?.notUsed !== null) {
      console.log(`not-used ${label}`);
      continue;
    }
    const cm = await ContextManager.open({
      path: join(root, 'store'),
      strategy: buildFrameworkStrategy(check.recipe, 'claude-opus-4-6', 'UTC') as never,
    });
    try {
      cm.addMessage('Antra', [
        { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: png } } as never,
        { type: 'text', text: 'A picture.' },
      ]);
      cm.addMessage('ember', [{ type: 'tool_use', id: 'tu_1', name: 'workspace--read', input: { path: long } }]);
      cm.addMessage('Antra', [{ type: 'tool_result', toolUseId: 'tu_1', content: long }]);
      cm.addMessage('Antra', [{ type: 'text', text: long }]);
      await cm.compile({ maxTokens: 150_000, reserveForResponse: 16_384 });
    } finally {
      cm.close();
    }
    console.log(`ok ${label}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
