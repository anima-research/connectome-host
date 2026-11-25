// Run by test/own-settings.test.ts in a process of its own: an open that waits on a pipe would stop the test runner itself.
import { substituteEnvVars, validateRecipe } from '../../src/recipe.js';
import { startOwnSettings } from '../../src/own-settings.js';

const written = { name: 'Ember', ownSettings: 'all', agent: { name: 'ember', model: 'claude-opus-4-6', systemPrompt: 'hi' } };
const origin = { kind: 'authored' as const, document: structuredClone(written) };
const recipe = validateRecipe(substituteEnvVars(written, 'recipe.json', {}), origin);
const { check } = startOwnSettings({ recipe, origin }, process.argv[2]!);
console.log(check.file.kind === 'unread' ? check.file.why : check.file.kind);
