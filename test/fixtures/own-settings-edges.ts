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
const long = Array.from({ length: 400 }, (_, i) => `Line ${i} of the long message, with a few words in it.`).join('\n');
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
