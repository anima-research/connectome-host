import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFrameworkAgentConfig } from '../src/framework-agent-config.js';
import { buildFrameworkStrategy } from '../src/framework-strategy.js';
import { loadMcplServers } from '../src/mcpl-config.js';
import {
  loadRecipeDocument, loadSavedRecipe, readRecipeDocument, saveRecipe, unknownRecipeKeys, validateRecipe,
} from '../src/recipe.js';
import { DELETE, everySetting, variants } from './fixtures/recipe-schema/every-setting.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'recipe-schema-'));
  dirs.push(dir);
  return dir;
};

const base = (extra: Record<string, unknown> = {}, agent: Record<string, unknown> = {}) => ({
  name: 'schema',
  agent: { systemPrompt: 'sys', ...agent },
  ...extra,
});

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected a refusal');
}

async function loadsFrom(raw: unknown, env: Record<string, string>): Promise<string> {
  const dir = tempDir();
  const file = join(dir, 'recipe.json');
  writeFileSync(file, JSON.stringify(raw));
  return loadRecipeDocument(await readRecipeDocument(file), file, { env, fetchSystemPrompt: false })
    .then(() => '', (error: Error) => error.message);
}

describe('one message for every fault that one parse can judge', () => {
  test('faults in three sections come in one message, one line each', () => {
    const message = refusal(() => validateRecipe(base({ modules: { fetch: 'yes' }, speech: { locus: 'nowhere' } }, { maxTokens: 'lots' })));
    expect(message).toBe([
      'The recipe has 3 faults:',
      '- Recipe agent.maxTokens must be a number, got "lots".',
      '- Recipe modules.fetch must be true, false or an object, got "yes".',
      '- Recipe speech.locus must be "delivery" or "latest-inbound", got "nowhere".',
    ].join('\n'));
  });

  test('a wrong kind in one section and a broken rule of another object are both in the first message', () => {
    const message = refusal(() => validateRecipe(base({ dendrite: { announceOrphans: 'no' } }, { proseLock: '#lounge' })));
    expect(message).toContain('- Recipe agent.proseLock requires agent.proseRouting "locked", got no proseRouting (locus).');
    expect(message).toContain('- Recipe dendrite.announceOrphans must be true or false, got "no".');
  });

  test('a rule that reads a setting with a fault of shape adds no sentence of its own', () => {
    expect(refusal(() => validateRecipe(base({}, { strategy: { type: 'passthrough', kvUnified: null } })))).toBe(
      'Recipe agent.strategy.kvUnified must be a complete object (omit it for the standard block), got null; give it a value, or leave the key out, which takes the default.');
  });

  test('a key of the other subconscious reader and a misspelt key are both named, with what switching readers needs', () => {
    const forks = refusal(() => validateRecipe(base({ subconscious: { enabled: true, reader: 'forks', model: 'm', voice: 'v', systemPrompt: 'p', voise: 'v' } })));
    expect(forks).toContain('Recipe subconscious.systemPrompt is for reader "persistent", and this recipe\'s reader is "forks".');
    expect(forks).toContain('Recipe subconscious has unknown key "voise" (did you mean "voice"?); it takes ');
    const persistent = refusal(() => validateRecipe(base({ subconscious: { enabled: true, systemPrompt: 'p', forkIdleTimeoutMs: 1000 } })));
    expect(persistent).toBe('Recipe subconscious.forkIdleTimeoutMs is for reader "forks", and this recipe\'s reader is "persistent". ' +
      'Remove forkIdleTimeoutMs, or set subconscious.reader to "forks" and give model and voice, which reader "forks" needs, ' +
      'and remove systemPrompt, which only reader "persistent" takes. ' +
      'Reader "persistent" takes enabled, reader, name, model, systemPrompt, allowChannelSpeech and reAnchorFraction.');
  });

  test('a rule runs where the settings it reads have their shape, whatever else has a fault', () => {
    const message = refusal(() => validateRecipe(base({}, {
      proseLock: '#lounge', strategy: { kvUnified: { policy: { alpha: 'high' } } },
    })));
    expect(message).toContain('Recipe agent.proseLock requires agent.proseRouting "locked"');
    expect(message).toContain('Recipe agent.strategy.kvUnified.policy.alpha must be a finite number of 0 or more, got "high".');
  });
});

describe('a message prints no value that came from the environment', () => {
  const env = { TOKEN: 's3cret', MAX: 'many', PORT: '7343' };
  const recipe = base({ mcpServers: { x: { command: 'node', token: '${TOKEN}' } }, modules: { history: '${TOKEN}' } },
    { maxTokens: '${MAX}', cacheTtl: 'x-${TOKEN}' });

  test('a load names the references as the author wrote them, and none of their values', async () => {
    const message = await loadsFrom(recipe, env);
    expect(message).toContain('Recipe agent.maxTokens must be a number, got "${MAX}".');
    expect(message).toContain('Recipe agent.cacheTtl must be "5m" or "1h", got "x-${TOKEN}".');
    expect(message).toContain('Recipe modules.history must be true, false or an object, got "${TOKEN}".');
    expect(message).not.toContain('s3cret');
    expect(message).not.toContain('many');
  });

  test('a rule\'s sentence names a reference as written, and so does a sentence that agent-framework gives a rule', async () => {
    const env2 = { SEM: 'http://s3cret.example/x', MOUNT: 's3cret-mount' };
    const semantic = await loadsFrom(base({ modules: { history: { semantic: { url: '${SEM}' } } } }), env2);
    expect(semantic).toStartWith('Recipe modules.history.semantic.url "${SEM}" is plaintext http');
    const mount = { name: '${MOUNT}', path: './m', backend: 'direct', mode: 'read-only', watch: 'always' };
    const workspace = await loadsFrom(base({ modules: { workspace: { mounts: [mount] } } }), env2);
    expect(workspace).toStartWith('Recipe modules.workspace: Mount "${MOUNT}" is direct');
    const patterned = { name: 'm', path: './m', include: ['${PATTERN}'] };
    const pattern = await loadsFrom(base({ modules: { workspace: { mounts: [patterned] } } }), { ...env2, PATTERN: '!s3cret' });
    expect(pattern).toStartWith('Recipe modules.workspace: Mount "m": include pattern "${PATTERN}" isn\'t read: ');
    const replacement = await loadsFrom(base({ modules: { workspace: { mounts: [{ ...mount, name: '${MOUNT:-$&}' }] } } }), env2);
    expect(replacement).toStartWith('Recipe modules.workspace: Mount "${MOUNT:-$&}" is direct');
    for (const message of [semantic, workspace, pattern, replacement]) expect(message).not.toContain('s3cret');
  });

  test('the instructions refusal names no mount that it can only name from the environment', async () => {
    const modules = { workspace: { mounts: [{ name: 'notes', path: './n' }] }, instructions: { path: '${DIR}/AGENTS.md' } };
    const message = await loadsFrom(base({ modules }), { DIR: 's3cret' });
    expect(message).toStartWith('Recipe modules.instructions.path "${DIR}/AGENTS.md" names a workspace mount, but the declared mounts are: "notes". ');
    expect(message).not.toContain('s3cret');
    expect(refusal(() => validateRecipe(base({ modules: { ...modules, instructions: { path: 'gone/AGENTS.md' } } }))))
      .toStartWith('Recipe modules.instructions.path "gone/AGENTS.md" names workspace mount "gone", but the declared mounts are: "notes". ');
    const named = { workspace: { mounts: [{ name: '${MOUNT}', path: './n' }] } };
    const declared = await loadsFrom(base({ modules: { ...named, instructions: { path: 'gone/AGENTS.md' } } }), { MOUNT: 's3cret' });
    expect(declared).toStartWith('Recipe modules.instructions.path "gone/AGENTS.md" names workspace mount "gone", but the declared mounts are: "${MOUNT}". ');
    const used = await loadsFrom(base({ modules: { ...named, instructions: { path: '${MOUNT}/AGENTS.md' } } }), { MOUNT: 's3cret' });
    expect(used).toStartWith('Recipe modules.instructions.path "${MOUNT}/AGENTS.md" uses a read-write mount without autoMaterialize. ');
    for (const said of [declared, used]) expect(said).not.toContain('s3cret');
  });

  test('the warning names the recipe as its author wrote the name, and a legacy snapshot by no name', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await loadsFrom({ ...base({}, { bogusAgentKey: 1 }), name: '${NAME}' }, { NAME: 's3cret-name' })).toBe('');
      expect(warn).toHaveBeenCalledWith('Recipe "${NAME}" has keys the host does not read (ignored): agent.bogusAgentKey.');
      warn.mockClear();
      const dataDir = tempDir();
      writeFileSync(join(dataDir, '.recipe.json'), JSON.stringify(base({}, { bogusAgentKey: 1 })));
      await loadSavedRecipe(dataDir, { fetchSystemPrompt: false });
      expect(warn).toHaveBeenCalledWith('Recipe has keys the host does not read (ignored): agent.bogusAgentKey.');
    } finally {
      warn.mockRestore();
    }
  });

  test('a saved document with its references does the same', async () => {
    const dataDir = tempDir();
    saveRecipe(dataDir, recipe);
    const saved = { TOKEN: process.env.TOKEN, MAX: process.env.MAX };
    Object.assign(process.env, { TOKEN: env.TOKEN, MAX: env.MAX });
    try {
      const message = await loadSavedRecipe(dataDir, { fetchSystemPrompt: false }).then(() => '', (error: Error) => error.message);
      expect(message).toContain('got "${MAX}"');
      expect(message).toContain('got "x-${TOKEN}"');
      expect(message).not.toContain('s3cret');
      expect(message).not.toContain('many');
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test('a legacy snapshot, saved with its values in, names the kind of a string and not the string', async () => {
    const dataDir = tempDir();
    writeFileSync(join(dataDir, '.recipe.json'), JSON.stringify(base({}, { cacheTtl: 's3cret' })));
    const message = await loadSavedRecipe(dataDir, { fetchSystemPrompt: false }).then(() => '', (error: Error) => error.message);
    expect(message).toBe('Recipe agent.cacheTtl must be "5m" or "1h", got a string.');
  });

  test('a number from the environment is a string, and its refusal names the reference', async () => {
    expect(await loadsFrom(base({ modules: { webui: { port: '${PORT}', host: '127.0.0.1' } } }), env))
      .toBe('Recipe modules.webui.port must be a number, got "${PORT}".');
  });

  test('a value the author wrote is printed, and an object or a list by its kind', () => {
    expect(refusal(() => validateRecipe(base({}, { cacheTtl: '5min' })))).toBe('Recipe agent.cacheTtl must be "5m" or "1h", got "5min".');
    expect(refusal(() => validateRecipe(base({}, { retry: [1, 2] })))).toBe('Recipe agent.retry must be an object, got a list.');
  });
});

describe('null, where the code gives it a meaning, and where it doesn\'t', () => {
  test('each of the seven places loads; the prompt becomes empty and the other six stay null', () => {
    const parsed = validateRecipe(base({ modules: { webui: { basicAuth: null, allowedOrigins: null } } }, {
      systemPrompt: null, contextBudgetTokens: null, refusalHandling: null, strategy: { type: null },
    }));
    expect(parsed.agent.systemPrompt).toBe('');
    expect(parsed.agent.contextBudgetTokens).toBeNull();
    expect(parsed.agent.refusalHandling).toBeNull();
    expect(parsed.agent.strategy?.type).toBeNull();
    expect(parsed.modules?.webui).toEqual({ basicAuth: null, allowedOrigins: null });
    expect(validateRecipe(base({}, { refusalHandling: { autoRewind: null } })).agent.refusalHandling).toEqual({ autoRewind: null });
    expect(buildFrameworkAgentConfig(parsed, 'a', 'claude-opus-4-1', { kind: 'strategy' } as never).maxStreamTokens).toBe(150_000);
  });

  test('false loads and stays false at agent.refusalHandling and modules.ttsRelay', () => {
    const parsed = validateRecipe(base({ modules: { ttsRelay: false } }, { refusalHandling: false }));
    expect(parsed.agent.refusalHandling).toBe(false);
    expect(parsed.modules?.ttsRelay).toBe(false);
  });

  test('a null at a setting that the code gives no meaning is refused, and the message says to leave the key out only where it may be left out', () => {
    expect(refusal(() => validateRecipe(base({ mcpServers: { x: { command: 'node', toolPrefix: null } } }))))
      .toBe('Recipe mcpServers.x.toolPrefix must be a string, got null; give it a value, or leave the key out, which takes the default.');
    expect(refusal(() => validateRecipe({ name: null, agent: {} }))).toBe('Recipe name must be a non-empty string, got null; give it a value.');
    expect(refusal(() => validateRecipe(base({}, { thinking: { enabled: null } }))))
      .toBe('Recipe agent.thinking.enabled must be true or false, got null; give it a value.');
    expect(refusal(() => validateRecipe(base({ mcpServers: { x: null } })))).toBe('Recipe mcpServers.x must be an object, got null; give it a value.');
  });

  test('a null that a rule would refuse if it were left out is told only to take a value', () => {
    const compatible = { provider: 'openai-compatible', model: 'm', baseUrl: 'http://localhost:11434/v1' };
    expect(refusal(() => validateRecipe(base({}, { ...compatible, baseUrl: null }))))
      .toBe('Recipe agent.baseUrl must be an absolute http(s) URL, got null; give it a value.');
    expect(refusal(() => validateRecipe(base({}, { ...compatible, model: null })))).toBe('Recipe agent.model must be a string, got null; give it a value.');
    const direct = { name: 'm', path: './m', backend: 'direct', mode: null };
    const mode = 'Recipe modules.workspace.mounts[0].mode must be "read-write" or "read-only", got null';
    expect(refusal(() => validateRecipe(base({ modules: { workspace: { mounts: [direct] } } })))).toBe(`${mode}; give it a value.`);
    expect(refusal(() => validateRecipe(base({}, { baseUrl: null }))))
      .toBe('Recipe agent.baseUrl must be an absolute http(s) URL, got null; give it a value, or leave the key out, which takes the default.');
    expect(refusal(() => validateRecipe(base({ modules: { workspace: { mounts: [{ ...direct, backend: 'chronicle' }] } } }))))
      .toBe(`${mode}; give it a value, or leave the key out, which takes the default.`);
  });

  test('the five loose checks of before refuse what they let through', () => {
    for (const [recipe, message] of [
      [base({ agent: [] }), 'Recipe agent must be an object, got an empty list.'],
      [base({}, { cacheKeepalive: [] }), 'Recipe agent.cacheKeepalive must be an object, got an empty list.'],
      [base({}, { strategy: { type: '' } }), 'Recipe agent.strategy.type must be "autobiographical", "passthrough", "frontdesk" or a custom type, got "".'],
      [base({}, { refusalHandling: 0 }), 'Recipe agent.refusalHandling must be an object, such as {"autoRewind": true}, or left out, got 0.'],
      [base({}, { contextBudgetTokens: 'many' }), 'Recipe agent.contextBudgetTokens must be a number, got "many".'],
    ] as const) {
      expect(refusal(() => validateRecipe(recipe))).toBe(message);
    }
  });

  test('an empty list is said to be empty', () => {
    expect(refusal(() => validateRecipe(base({ modules: { workspace: { mounts: [] } } }))))
      .toBe('Recipe modules.workspace.mounts must be a non-empty list of mounts, got an empty list.');
  });

  test('an mcpServers entry may give its own name as its id, and any other id is refused, with no warning beside it', () => {
    const refused = "Recipe mcpServers.alpha.id is not a setting: a server's id is its name in mcpServers. " +
      'Remove id, or rename the entry if the server should have that name.';
    const other = base({ mcpServers: { alpha: { command: 'node', id: 'beta' } } });
    expect(refusal(() => validateRecipe(other))).toBe(refused);
    expect(unknownRecipeKeys(other)).toEqual([]);
    expect(refusal(() => validateRecipe(base({ mcpServers: { alpha: { command: 'node', id: 7 } } })))).toBe(refused);
    expect(refusal(() => validateRecipe(base({ mcpServers: { alpha: { command: 'node', id: 'beta' }, gamma: { command: 'node', id: 'delta' } } }))))
      .toBe(`The recipe has 2 faults:\n- ${refused}\n- ${refused.replace('alpha', 'gamma')}`);
    const own = base({ mcpServers: { alpha: { command: 'node', id: 'alpha' } } });
    expect(unknownRecipeKeys(own)).toEqual(['mcpServers.alpha.id']);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(validateRecipe(own).mcpServers?.alpha).toStrictEqual({ command: 'node', id: 'alpha' });
    } finally {
      warn.mockRestore();
    }
  });

  test('mcpServers is an object of servers, and a list of them is refused', () => {
    expect(refusal(() => validateRecipe(base({ mcpServers: [{ command: 'node' }] }))))
      .toBe('Recipe mcpServers must be an object that gives each server a name, got a list.');
  });
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function withEdits(recipe: Record<string, unknown>, edits: readonly (readonly [string, unknown])[]): Record<string, unknown> {
  const copy = structuredClone(recipe);
  for (const [dotted, value] of edits) {
    const keys = dotted.split('.');
    const last = keys.pop()!;
    let parent: unknown = copy;
    for (const key of keys) parent = Array.isArray(parent) ? parent[Number(key)] : isObject(parent) ? parent[key] : undefined;
    if (!isObject(parent)) throw new Error(`the fixture has no object at ${keys.join('.')}`);
    if (value === DELETE) delete parent[last];
    else parent[last] = structuredClone(value);
  }
  return copy;
}

describe('the parsed recipe', () => {
  test('a recipe that sets every setting, in each variant, parses to itself with the two values that the load writes', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const [variant, edits] of Object.entries(variants)) {
        const input = withEdits(everySetting, edits);
        const agent = input.agent;
        if (!isObject(agent)) throw new Error(`the ${variant} variant has no agent`);
        const expected = { ...input, agent: { ...agent, systemPrompt: agent.systemPrompt ?? '', cacheTtl: agent.cacheTtl ?? '1h' } };
        expect({ variant, parsed: validateRecipe(structuredClone(input)) }).toStrictEqual({ variant, parsed: expected });
        // A loose object keeps a key that its schema lost, so the parse alone can't see a dropped setting: the warning can.
        expect({ variant, unknown: unknownRecipeKeys(input) }).toEqual({ variant, unknown: [] });
      }
    } finally {
      warn.mockRestore();
    }
  });

  test('an agent that sets neither gets the two values that the load writes, and nothing else', () => {
    expect(validateRecipe(base()).agent).toStrictEqual({ systemPrompt: 'sys', cacheTtl: '1h' });
    expect(validateRecipe({ name: 'schema', agent: {} }).agent).toStrictEqual({ systemPrompt: '', cacheTtl: '1h' });
  });

  test('the load returns a new object, and leaves its argument as it was', () => {
    const raw = base({ modules: { fetch: true } });
    const before = structuredClone(raw);
    const parsed = validateRecipe(raw);
    expect(parsed).not.toBe(raw);
    expect(raw).toEqual(before);
  });

  test('an empty strategy stays empty, and the strategy in force is autobiographical', () => {
    const parsed = validateRecipe(base({}, { strategy: {} }));
    expect(parsed.agent.strategy).toEqual({});
    expect(buildFrameworkStrategy(parsed, 'claude-opus-4-1', 'UTC').constructor.name).toBe('AutobiographicalStrategy');
  });

  test('toolResultMaxLastN takes a number or a map of numbers', () => {
    expect(validateRecipe(base({}, { strategy: { toolResultMaxLastN: { snapshot: 1 } } })).agent.strategy?.toolResultMaxLastN)
      .toEqual({ snapshot: 1 });
    expect(refusal(() => validateRecipe(base({}, { strategy: { toolResultMaxLastN: { snapshot: '1' } } }))))
      .toBe('Recipe agent.strategy.toolResultMaxLastN.snapshot must be a number, got "1".');
  });

  test('a server\'s args and env take text, a number or true and false, as given', () => {
    const server = { command: 'node', args: ['--port', 8080, true], env: { PORT: 8080, DEBUG: true, NAME: 'x' } };
    expect(validateRecipe(base({ mcpServers: { x: server } })).mcpServers?.x).toEqual(server);
    expect(refusal(() => validateRecipe(base({ mcpServers: { x: { command: 'node', args: [null] } } }))))
      .toBe('Recipe mcpServers.x.args[0] must be a string, a number, true or false, got null; give it a value.');
  });

  test('a server entry takes agent-framework\'s settings that a recipe can write, with no warning', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const discord = { command: 'node', allowHostCommands: true, enabledCapabilities: ['x'], protocol: 'modern', transport: 'http' };
      expect(validateRecipe(base({ mcpServers: { discord } })).mcpServers?.discord).toEqual(discord);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('unknown keys', () => {
  test('a built-in strategy warns of a misspelt option, naming the nearest; a custom type takes any key with no warning', () => {
    expect(unknownRecipeKeys(base({}, { strategy: { maxMesageTokens: 1 } })))
      .toEqual(['agent.strategy.maxMesageTokens (did you mean agent.strategy.maxMessageTokens?)']);
    expect(unknownRecipeKeys(base({ extensions: { s: { kind: 'strategy', path: '/s.js' } } }, { strategy: { type: 'mine', anything: 1 } })))
      .toEqual([]);
  });

  test('a custom strategy goes whole to its extension, so a key at any depth under it draws no warning', () => {
    const strategy = { type: 'mine', foldingStrategy: 'kv-unified', kvUnified: { ...everySetting.agent.strategy.kvUnified, ownPolicy: 1 } };
    expect(unknownRecipeKeys(base({ extensions: { s: { kind: 'strategy', path: '/s.js' } } }, { strategy }))).toEqual([]);
    expect(unknownRecipeKeys(base({}, { strategy: { ...strategy, type: 'autobiographical' } })))
      .toEqual(['agent.strategy.kvUnified.ownPolicy (did you mean agent.strategy.kvUnified.policy?)']);
  });

  test('a section that said nothing of an unknown key now warns, and keeps the key', () => {
    const recipe = base({ modules: { webui: { host: '127.0.0.1', hostt: 'x' } } });
    expect(unknownRecipeKeys(recipe)).toEqual(['modules.webui.hostt (did you mean modules.webui.host?)']);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(validateRecipe(recipe).modules?.webui).toEqual({ host: '127.0.0.1', hostt: 'x' });
      expect(warn).toHaveBeenCalledWith('Recipe "schema" has keys the host does not read (ignored): modules.webui.hostt (did you mean modules.webui.host?).');
    } finally {
      warn.mockRestore();
    }
  });

  test('deprecated keys load, and retired keys load with their replacement named', () => {
    const recipe = base({
      modules: { files: false, mcplAdmin: { surface: 'tools' }, webui: { observersSurface: 'tools' }, instructions: false },
      conversations: {}, tuneOut: { enabled: false },
    }, { strategy: { identityReminderSilent: false }, refusalHandling: { announceHumanTurns: true }, files: 1 });
    expect(unknownRecipeKeys(recipe)).toEqual([
      'agent.files',
      'agent.strategy.identityReminderSilent (replaced by a sentence asking for silence at the end of each nonblank reminder the recipe sets, ' +
        'agent.strategy.identityReminder and agent.strategy.witnessedIdentityReminder, if it was true; if it was false, nothing)',
      'modules.files (replaced by modules.workspace)',
    ]);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const parsed = validateRecipe(recipe);
      expect(parsed.modules).toMatchObject({ files: false });
      expect(parsed.agent.strategy).toEqual({ identityReminderSilent: false });
    } finally {
      warn.mockRestore();
    }
  });

  test('a key the load refuses by name is refused, and isn\'t also named as a key the host ignores', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(refusal(() => validateRecipe(base({}, { refusalHandling: { primarySummaryFallback: true } }))))
        .toBe('Recipe agent.refusalHandling.primarySummaryFallback was removed and is unsupported.');
      expect(refusal(() => validateRecipe(base({ modules: { retrieval: { reasoningContext: 'all_turns' } } }))))
        .toStartWith('Recipe modules.retrieval.reasoningContext is not supported: ');
      expect(refusal(() => validateRecipe(base({ codeExecution: { enabled: true, scriptTimeoutMs: 1000, idleReclaimMs: 1 } }))))
        .toBe('The recipe has 2 faults:\n' +
          '- Recipe codeExecution.idleReclaimMs is no longer read (agent-framework 0.24): ' +
          'each script starts fresh and keeps nothing after it ends, so there is nothing to reclaim; leave it out.\n' +
          '- Recipe codeExecution.scriptTimeoutMs is no longer read (agent-framework 0.24): ' +
          'a script now yields at its bound and keeps running: set yieldMs for the bound.');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test('a retired code-execution key is warned of as ignored while code execution is off, since only an enabled block refuses it', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(unknownRecipeKeys(base({ codeExecution: { enabled: false, scriptTimeoutMs: 1000 } })).map((key) => key.replace(/ \(.*$/, '')))
        .toEqual(['codeExecution.scriptTimeoutMs']);
      expect(() => validateRecipe(base({ codeExecution: { enabled: false, scriptTimeoutMs: 1000 } }))).not.toThrow();
    } finally {
      warn.mockRestore();
    }
  });

  test('the wake rules are kept as given and draw no warning, while a key beside them warns', () => {
    const policies = [{ name: 'p', match: { anything: 1 }, behavior: 'nonsense' }];
    const recipe = base({ modules: { wake: { policies, default: 7, judges: {} } } });
    expect(unknownRecipeKeys(recipe)).toEqual(['modules.wake.judges (did you mean modules.wake.judge?)']);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(validateRecipe(recipe).modules?.wake).toEqual({ policies, default: 7, judges: {} });
    } finally {
      warn.mockRestore();
    }
  });

  const closed: Array<[string, Record<string, unknown>]> = [
    ['agent.toolPresentation', base({}, { toolPresentation: { path: '/p.json', cataloguePath: 'products/c.md' } })],
    ['agent.toolPresentation.defaults[0]', base({}, { toolPresentation: { path: '/p.json', cataloguePath: 'products/c.md', defaults: [{ source: 's', path: '/d.json' }] } })],
    ['agent.retry', base({}, { retry: {} })],
    ['agent.retry.overloaded', base({}, { retry: { overloaded: {} } })],
    ['agent.autoContinue', base({}, { autoContinue: {} })],
    ['agent.clock', base({}, { clock: { intervalMinutes: 10 } })],
    ['agent.strategy.compressionToolProseFallback', base({}, { strategy: { compressionToolProseFallback: { intoTool: 'j', fromTools: ['s'] } } })],
    ['mcpServers.x.toolLifecycle', base({ mcpServers: { x: { command: 'node', toolLifecycle: {} } } })],
    ['mcpServers.x.toolLifecycle.observe', base({ mcpServers: { x: { command: 'node', toolLifecycle: { observe: {} } } } })],
    ['mcpServers.x.toolLifecycle.inputs', base({ mcpServers: { x: { command: 'node', toolLifecycle: { inputs: {} } } } })],
    ['modules.wake.judge', base({ modules: { wake: { judge: {} } } })],
    ['modules.heartbeat', base({ modules: { heartbeat: {} } })],
    ['modules.heartbeat.defaults', base({ modules: { heartbeat: { defaults: {} } } })],
    ['modules.heartbeat.importFrom', base({ modules: { heartbeat: { importFrom: {} } } })],
    ['modules.workspace', base({ modules: { workspace: { mounts: [{ name: 'm', path: './m' }] } } })],
    ['modules.workspace.mounts[0]', base({ modules: { workspace: { mounts: [{ name: 'm', path: './m' }] } } })],
    ['modules.instructions', base({ modules: { instructions: {}, workspace: { mounts: [{ name: 'instructions', path: './i', mode: 'read-only' }] } } })],
    ['modules.notices', base({ modules: { notices: {} } })],
    ['modules.notices.reply', base({ modules: { notices: { reply: {} } } })],
    ['modules.history', base({ modules: { history: {} } })],
    ['modules.history.semantic', base({ modules: { history: { semantic: { url: 'https://e.example' } } } })],
    ['modules.selfRestart', base({ modules: { selfRestart: {} } })],
    ['conversations', base({ conversations: {} })],
    ['conversations.bind', base({ conversations: { bind: {} } })],
    ['conversations.trigger', base({ conversations: { trigger: {} } })],
    ['subconscious', base({ subconscious: { enabled: true, systemPrompt: 'p' } })],
    ['speech', base({ speech: {} })],
    ['tuneOut', base({ tuneOut: {} })],
    ['dendrite', base({ dendrite: {} })],
    ['inferenceBounds', base({ inferenceBounds: {} })],
    ['inferenceBounds.progressBounds', base({ inferenceBounds: { progressBounds: {} } })],
  ];

  test('each of the 31 closed sections refuses an unknown key in one form, naming it and the keys it takes', () => {
    expect(closed).toHaveLength(31);
    for (const [at, recipe] of closed) {
      expect(() => validateRecipe(recipe)).not.toThrow();
      const target = at.replace(/\[(\d+)\]/g, '.$1').split('.').reduce<Record<string, unknown>>(
        (value, key) => value[key] as Record<string, unknown>, recipe as Record<string, unknown>);
      const used = Object.keys(target);
      target.zzUnknown = 1;
      const message = refusal(() => validateRecipe(recipe));
      expect(message).toMatch(new RegExp(`^Recipe ${at.replace(/[.[\]]/g, '\\$&')} has unknown key "zzUnknown"; it takes \\w[^;]*\\.$`));
      const takes = message.slice(message.indexOf('; it takes ') + '; it takes '.length, -1).split(/, | and /);
      expect({ at, notNamed: used.filter((key) => !takes.includes(key)) }).toEqual({ at, notNamed: [] });
    }
  });
});

describe('the saved document', () => {
  test('a load, a save and a load from it: the file holds the author\'s document with the extension\'s path resolved and no default, and loads as the first load did', async () => {
    const dir = tempDir();
    const file = join(dir, 'recipe.json');
    const authored = base({ description: '${LABEL}', extensions: { chart: { kind: 'module', path: '${ASSETS}/chart.js' } } });
    writeFileSync(file, JSON.stringify(authored));
    const env = { LABEL: 'A label', ASSETS: '/opt/assets' };
    const { recipe, persistable } = await loadRecipeDocument(await readRecipeDocument(file), file, { env, fetchSystemPrompt: false });
    expect(recipe.agent.cacheTtl).toBe('1h');
    const dataDir = tempDir();
    saveRecipe(dataDir, persistable);
    const expected = { $unresolved: true, ...authored, extensions: { chart: { kind: 'module', path: '/opt/assets/chart.js' } } };
    expect(readFileSync(join(dataDir, '.recipe.json'), 'utf8')).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    const label = process.env.LABEL;
    process.env.LABEL = env.LABEL;
    try {
      expect(await loadSavedRecipe(dataDir, { fetchSystemPrompt: false })).toEqual(recipe);
    } finally {
      if (label === undefined) delete process.env.LABEL;
      else process.env.LABEL = label;
    }
  });
});

describe('connectome-servers file', () => {
  test('a server\'s toolLifecycle in mcpl-servers.json is checked as the recipe\'s is, and named in the file', () => {
    const dir = tempDir();
    const file = join(dir, 'mcpl-servers.json');
    writeFileSync(file, JSON.stringify({ mcplServers: { x: { command: 'node', toolLifecycle: { observe: { tool: ['a'] } } } } }));
    expect(refusal(() => loadMcplServers(file))).toBe(
      'mcpl-servers.json: mcplServers.x.toolLifecycle.observe has unknown key "tool" (did you mean "tools"?); it takes tools, classes and conversations.');
  });

  test('two faults there are named as the file\'s, not the recipe\'s', () => {
    const dir = tempDir();
    const file = join(dir, 'mcpl-servers.json');
    writeFileSync(file, JSON.stringify({ mcplServers: { x: { command: 'node', toolLifecycle: { observe: { tool: ['a'] }, maxInputBytes: 0 } } } }));
    expect(refusal(() => loadMcplServers(file))).toBe([
      'mcpl-servers.json: mcplServers.x.toolLifecycle has 2 faults:',
      '- mcpl-servers.json: mcplServers.x.toolLifecycle.observe has unknown key "tool" (did you mean "tools"?); it takes tools, classes and conversations.',
      '- mcpl-servers.json: mcplServers.x.toolLifecycle.maxInputBytes must be a positive integer, got 0.',
    ].join('\n'));
  });
});
