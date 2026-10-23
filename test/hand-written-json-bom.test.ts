/**
 * A JSON file a person writes or edits by hand, saved by an editor with a
 * leading UTF-8 byte order mark (U+FEFF), reads as the same file without
 * it, through each loader that reads one: the recipe, the MCPL servers
 * file and the agent overlay, with their saves, the Anthropic credentials
 * file, with its write-back, and the observer grants. Without the skip,
 * `JSON.parse` refuses the mark on Bun and Node alike.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseHandWrittenJson } from '../src/hand-written-json.js';
import { loadRecipe, loadRecipeDetailed } from '../src/recipe.js';
import { loadMcplServers, readAgentOverlayFile, readMcplServersFile, saveAgentOverlay, saveMcplServers } from '../src/mcpl-config.js';
import { AnthropicOAuthCredentials } from '../src/anthropic-credentials.js';
import { ObserverRegistry, readObserversFile } from '../src/modules/web-ui-observers.js';
import { ObserversModule } from '../src/modules/observers-module.js';

const BOM = '\uFEFF';

const dirs: string[] = [];
afterEach(() => { while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true }); });

/** A path in a fresh directory, with `value`'s JSON written there after a byte order mark. */
function marked(name: string, value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'hand-written-json-'));
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, BOM + JSON.stringify(value, null, 2) + '\n', 'utf-8');
  return path;
}

describe('parseHandWrittenJson', () => {
  test('skips exactly one leading byte order mark, and reads text without one as JSON.parse does', () => {
    expect(parseHandWrittenJson(`${BOM}{"a":1}`)).toEqual({ a: 1 });
    expect(parseHandWrittenJson('{"a":1}')).toEqual({ a: 1 });
    expect(() => parseHandWrittenJson(`${BOM}${BOM}{"a":1}`)).toThrow(SyntaxError);
    // A mark anywhere but first is the text's own, as JSON.parse reads it.
    expect(parseHandWrittenJson(`{"a":"${BOM}"}`)).toEqual({ a: BOM });
    expect(() => parseHandWrittenJson(` ${BOM}{"a":1}`)).toThrow(SyntaxError);
  });
});

describe('a loader reads its file saved with a byte order mark', () => {
  test('the recipe', async () => {
    const path = marked('recipe.json', { name: 'Marked', agent: { systemPrompt: 'Saved by an editor that writes a mark.' } });
    const recipe = await loadRecipe(path);
    expect([recipe.name, recipe.agent.systemPrompt]).toEqual(['Marked', 'Saved by an editor that writes a mark.']);
  });

  test('the MCPL servers file, and a save into it keeps its other keys and writes it back without the mark', () => {
    const path = marked('mcpl-servers.json', { $comment: 'shared', mcplServers: { chat: { command: 'node', args: ['server.js'] } } });
    expect(loadMcplServers(path).map((s) => [s.id, s.command])).toEqual([['chat', 'node']]);
    expect(Object.keys(readMcplServersFile(path))).toEqual(['chat']);
    saveMcplServers(path, { chat: { command: 'bun' } });
    const written = readFileSync(path, 'utf-8');
    expect(written.charCodeAt(0)).not.toBe(0xfeff);
    expect(JSON.parse(written)).toEqual({ $comment: 'shared', mcplServers: { chat: { command: 'bun' } } });
  });

  test('the agent overlay, and a save into it', () => {
    const path = marked('mcpl-servers.agent.json', { $comment: 'the agent\'s', mcplServers: { mine: { command: 'bun' } } });
    expect(Object.keys(readAgentOverlayFile(path).servers)).toEqual(['mine']);
    saveAgentOverlay(path, { mine: { command: 'node' } });
    const written = readFileSync(path, 'utf-8');
    expect(written.charCodeAt(0)).not.toBe(0xfeff);
    expect(JSON.parse(written)).toEqual({ $comment: 'the agent\'s', mcplServers: { mine: { command: 'node' } } });
  });

  test('the Anthropic credentials file', () => {
    const path = marked('creds.json', { claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 5, scopes: ['user:inference'] } });
    const creds = new AnthropicOAuthCredentials({ credentialsFile: path });
    expect(creds.canRefresh()).toBe(true);
  });

  test('the credentials write-back keeps the file\'s other keys when the file has gained a mark since it was read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hand-written-json-'));
    dirs.push(dir);
    const path = join(dir, 'creds.json');
    writeFileSync(path, JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 5 } }));
    const creds = new AnthropicOAuthCredentials({ credentialsFile: path });
    // The operator re-saves the file in an editor that writes a mark, adding a key.
    writeFileSync(path, BOM + JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 5, scopes: ['user:inference'] }, note: 'kept' }));
    creds.setToken('pasted');
    const written = readFileSync(path, 'utf-8');
    expect(written.charCodeAt(0)).not.toBe(0xfeff);
    expect(JSON.parse(written)).toEqual({ claudeAiOauth: { accessToken: 'pasted', scopes: ['user:inference'] }, note: 'kept' });
  });

  test('the observer grants', () => {
    const key = `ed25519:${'A'.repeat(42)}A`;
    const path = marked('observers.json', { observers: [{ key, label: 'phone', scopes: ['health'] }] });
    const read = readObserversFile(path) as { kind: string; file?: { observers: Array<{ label?: string }> }; problems?: string[] };
    expect([read.kind, read.file?.observers.map((o) => o.label), read.problems]).toEqual(['ok', ['phone'], []]);
  });
});

describe('a file that has the mark but still isn\'t JSON', () => {
  test('is refused in each reader\'s own words, which never quote the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hand-written-json-'));
    dirs.push(dir);
    const servers = join(dir, 'mcpl-servers.json');
    const broken = `${BOM}{ "mcplServers": { "chat": { "env": { "TOKEN": s3cret } } } }`;
    writeFileSync(servers, broken);
    expect(() => loadMcplServers(servers)).toThrow(`${servers} isn't valid JSON`);
    expect(() => saveMcplServers(servers, {})).toThrow(`${servers} isn't valid JSON, so it wasn't overwritten`);
    expect(readFileSync(servers, 'utf-8')).toBe(broken);
    let thrown = '';
    try { loadMcplServers(servers); } catch (err) { thrown = String(err); }
    expect(thrown).not.toContain('s3cret');
    const overlay = join(dir, 'mcpl-servers.agent.json');
    writeFileSync(overlay, broken);
    expect(() => readAgentOverlayFile(overlay)).toThrow(`the agent overlay ${overlay} isn't valid JSON`);
  });
});

test('a grant into a grants file saved with the mark keeps its grants and other keys, and writes it back without the mark', async () => {
  const baseline = { key: `ed25519:${'A'.repeat(42)}A`, label: 'baseline', scopes: ['health'], protected: true };
  const path = marked('observers.json', { note: 'kept', observers: [baseline] });
  const module = new ObserversModule({ path });
  const granted = await module.handleToolCall({ id: 't', name: 'grant', input: { key: `ed25519:${'C'.repeat(42)}A`, label: 'phone', scopes: ['health'] } } as never);
  expect(granted.error).toBeUndefined();
  const written = readFileSync(path, 'utf-8');
  expect(written.charCodeAt(0)).not.toBe(0xfeff);
  const doc = JSON.parse(written) as { note: string; observers: Array<{ label: string }> };
  expect([doc.note, doc.observers.map((g) => g.label)]).toEqual(['kept', ['baseline', 'phone']]);
});

describe('a running Web UI and a grants file saved with the mark', () => {
  const grant = (c: string, label: string) => ({ key: `ed25519:${c.repeat(42)}A`, label, scopes: ['health'] });
  const later = (path: string, seconds: number) => { const t = new Date(Date.now() + seconds * 1000); utimesSync(path, t, t); };

  test('admits the grants it lists at the start', () => {
    const path = marked('observers.json', { observers: [grant('X', 'x'), grant('Z', 'z')] });
    const registry = new ObserverRegistry(path, 60_000);
    registry.start();
    try {
      expect(registry.grants().map((g) => g.label)).toEqual(['x', 'z']);
    } finally {
      registry.stop();
    }
  });

  test('applies an edit re-saved with the mark at the next check, so a revoked grant stops admitting its observer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hand-written-json-'));
    dirs.push(dir);
    const path = join(dir, 'observers.json');
    writeFileSync(path, JSON.stringify({ observers: [grant('X', 'x'), grant('Z', 'z')] }));
    const registry = new ObserverRegistry(path, 60_000);
    registry.start();
    try {
      expect(registry.grants().map((g) => g.label)).toEqual(['x', 'z']);
      // The operator removes x and their editor saves the file with a mark.
      writeFileSync(path, BOM + JSON.stringify({ observers: [grant('Z', 'z')] }, null, 2));
      later(path, 5);
      (registry as unknown as { check(): void }).check();
      expect(registry.grants().map((g) => g.label)).toEqual(['z']);
    } finally {
      registry.stop();
    }
  });
});

describe("a recipe or credentials file that isn't JSON", () => {
  // A value left unquoted, which the parser's message would quote.
  const SECRET = 's3cretTokenValue';
  const unquoted = (dir: string, name: string, text: string): string => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };
  const refusal = async (load: () => unknown): Promise<string> => {
    try {
      await load();
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    throw new Error('it loaded');
  };

  test('a recipe file is refused in words that name it and never repeat the parser\'s message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hand-written-json-'));
    dirs.push(dir);
    const recipe = unquoted(dir, 'recipe.json', `{ "name": "r", "agent": { "name": "a", "apiKey": ${SECRET} } }`);
    const text = await refusal(() => loadRecipeDetailed(recipe));
    expect(text).not.toContain(SECRET);
    expect(text).toBe(`${recipe} isn't valid JSON`);
  });

  test('a credentials file is refused in words that name it and never repeat the parser\'s message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hand-written-json-'));
    dirs.push(dir);
    const credentials = unquoted(dir, 'credentials.json', `{ "claudeAiOauth": { "accessToken": ${SECRET} } }`);
    const text = await refusal(() => new AnthropicOAuthCredentials({ credentialsFile: credentials, autoRefresh: false }));
    expect(text).not.toContain(SECRET);
    expect(text).toBe(`cannot read Anthropic credentials file ${credentials}: it isn't valid JSON`);
  });

  test('fetched by URL, is refused in words that name the URL and never repeat the parser\'s message', async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response(`{ "name": "r", "agent": { "apiKey": ${SECRET} } }`) });
    try {
      const url = `http://127.0.0.1:${server.port}/recipe.json`;
      const text = await refusal(() => loadRecipeDetailed(url));
      expect(text).not.toContain(SECRET);
      expect(text).toBe(`the recipe at ${url} isn't valid JSON`);
    } finally {
      server.stop(true);
    }
  });

  test('that can\'t be read keeps the read error\'s own words', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hand-written-json-'));
    dirs.push(dir);
    const text = await refusal(() => new AnthropicOAuthCredentials({ credentialsFile: dir, autoRefresh: false }));
    expect(text).toStartWith(`cannot read Anthropic credentials file ${dir}: EISDIR`);
  });
});
