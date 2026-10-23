/**
 * McplAdminModule — agent-facing deploy/restart/unload tools, exercised
 * against a stub framework. Overlay persistence is verified on disk.
 */

import { test, expect, describe, beforeEach, afterEach, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentFramework } from '@animalabs/agent-framework';

import { McplAdminModule } from '../src/modules/mcpl-admin-module.js';
import { readAgentOverlay, saveAgentOverlay } from '../src/mcpl-config.js';
// For a spy on the overlay's save, which the module calls through this module.
import * as mcplConfig from '../src/mcpl-config.js';

interface StubServer {
  id: string;
  connected: boolean;
  retrying: boolean;
  toolPrefix: string;
  toolCount: number;
  policyEstablished: boolean;
  effectiveGrant: string[];
  maskedCapabilities: string[];
  deniedCapabilities: string[];
  allowHostCommands: boolean;
  manifestState?: {
    lastValidatedRevision: string | null;
    lastFetchedAt: number | null;
    lastNegotiatedAt: number | null;
  };
  toolClasses?: Array<{ tool: string; serverTool: string; class: string[]; source: string }>;
  command?: string;
  url?: string;
}

function makeStubFramework() {
  const servers = new Map<string, StubServer>();
  const calls: string[] = [];
  // The host's modules by name, as agent-framework's getModule finds them.
  const modules = new Set(['mcpl-admin', 'workspace']);
  const stub = {
    getModule: (name: string) => (modules.has(name) ? { name } : null),
    listMcplServers: () => [...servers.values()],
    connectMcplServer: async (config: { id: string; command?: string; url?: string; toolPrefix?: string }) => {
      calls.push(`connect:${config.id}`);
      if (servers.has(config.id)) throw new Error(`MCPL server "${config.id}" is already registered`);
      servers.set(config.id, {
        id: config.id,
        connected: true,
        retrying: false,
        toolPrefix: config.toolPrefix ?? `mcpl--${config.id}`,
        toolCount: 1,
        policyEstablished: true,
        effectiveGrant: ['channels.incoming'],
        maskedCapabilities: ['channels.streaming'],
        deniedCapabilities: ['contextHooks.beforeInference.inject.system'],
        allowHostCommands: false,
        manifestState: {
          lastValidatedRevision: 'sha256:validated',
          lastFetchedAt: Date.parse('2026-08-05T01:02:03.000Z'),
          lastNegotiatedAt: Date.parse('2026-08-05T01:02:04.000Z'),
        },
        command: config.command,
        url: config.url,
      });
    },
    disconnectMcplServer: async (id: string) => {
      calls.push(`disconnect:${id}`);
      servers.delete(id);
    },
    restartMcplServer: async (id: string, config?: { id: string; command?: string }) => {
      calls.push(`restart:${id}`);
      if (!servers.has(id) && !config) throw new Error(`MCPL server "${id}" is not configured`);
      const prev = servers.get(id);
      servers.set(id, {
        id,
        connected: true,
        retrying: false,
        toolPrefix: `mcpl--${id}`,
        toolCount: 1,
        policyEstablished: true,
        effectiveGrant: ['channels.incoming'],
        maskedCapabilities: ['channels.streaming'],
        deniedCapabilities: ['contextHooks.beforeInference.inject.system'],
        allowHostCommands: false,
        manifestState: {
          lastValidatedRevision: 'sha256:validated',
          lastFetchedAt: Date.parse('2026-08-05T01:02:03.000Z'),
          lastNegotiatedAt: Date.parse('2026-08-05T01:02:04.000Z'),
        },
        command: config?.command ?? prev?.command,
      });
    },
  };
  return { stub: stub as unknown as AgentFramework, servers, calls, modules };
}

let dir: string;
let overlayPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcpl-admin-'));
  overlayPath = join(dir, 'mcpl-servers.agent.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeModule(framework: AgentFramework, timeZone?: string) {
  const mod = new McplAdminModule({
    overlayPath,
    configPath: join(dir, 'mcpl-servers.json'),
    ...(timeZone !== undefined ? { timeZone } : {}),
  });
  mod.setFramework(framework);
  return mod;
}

function call(mod: McplAdminModule, name: string, input: Record<string, unknown> = {}) {
  return mod.handleToolCall({ id: 'c1', name, input } as never);
}

/** That `text` says each thing the agent needs, whatever words surround it:
 *  a test pins those, not every word. */
function expectSays(text: unknown, ...parts: string[]): void {
  for (const part of parts) expect(String(text)).toContain(part);
}

/** mcpl_deploy's refusal of an entry the strict reading finds malformed:
 *  nothing deployed or saved, every problem named, and the call to make. */
function expectMalformed(text: unknown, problem: string): void {
  expectSays(text, 'Nothing was deployed or saved', `The entry would be malformed: ${problem}.`, 'call mcpl-admin--mcpl_deploy again');
}

describe('mcpl_deploy', () => {
  test('deploys a new server: connects it and persists to the overlay', async () => {
    const { stub, servers, calls } = makeStubFramework();
    const mod = makeModule(stub);

    const result = await call(mod, 'mcpl_deploy', { id: 'mytool', command: 'node', args: ['tool.js'] });

    expect(result.success).toBe(true);
    expect(calls).toEqual(['connect:mytool']);
    expect(servers.has('mytool')).toBe(true);
    expect(readAgentOverlay(overlayPath).mytool).toEqual({ command: 'node', args: ['tool.js'] });
  });

  test('redeploying a loaded server restarts it with the new config', async () => {
    const { stub, calls } = makeStubFramework();
    const mod = makeModule(stub);

    await call(mod, 'mcpl_deploy', { id: 'mytool', command: 'node' });
    const result = await call(mod, 'mcpl_deploy', { id: 'mytool', command: 'bun' });

    expect(result.success).toBe(true);
    expect(calls).toEqual(['connect:mytool', 'restart:mytool']);
    expect(readAgentOverlay(overlayPath).mytool).toEqual({ command: 'bun' });
  });

  // An env value the boot would skip was
  // saved, then resolveOverlayEntry returned null and the deploy threw. A
  // new write is held to the plain shapes, and a number passes on as main
  // passed it: the child gets its text when it's spawned.
  test('an env value that isn\'t text, a number or true/false is refused before anything is saved; a number is deployed as given', async () => {
    const { stub } = makeStubFramework();
    const envs: unknown[] = [];
    const connect = (stub as unknown as { connectMcplServer: (c: { env?: unknown }) => Promise<void> }).connectMcplServer;
    (stub as unknown as { connectMcplServer: (c: { env?: unknown }) => Promise<void> }).connectMcplServer =
      async (config) => { envs.push(config.env); await connect(config); };
    const mod = makeModule(stub);

    const refused = await call(mod, 'mcpl_deploy', { id: 'nulled', command: 'node', env: { A: null } });
    expect(refused.success).toBe(false);
    expectMalformed(refused.error, "its env A isn't text, a finite number or true/false");
    expect(readAgentOverlay(overlayPath).nulled).toBeUndefined();
    expect(envs).toEqual([]);

    const deployed = await call(mod, 'mcpl_deploy', { id: 'door', command: 'node', env: { PORT: 3101 } });
    expect(deployed.success).toBe(true);
    expect(envs).toEqual([expect.objectContaining({ PORT: 3101 })]);
    expect(readAgentOverlay(overlayPath).door).toEqual({ command: 'node', env: { PORT: 3101 } });

    // An empty list is strict function calling's "unspecified": no env, and nothing refused.
    const strictModel = await call(mod, 'mcpl_deploy', { id: 'quiet', command: 'node', env: [] });
    expect(strictModel.success).toBe(true);
    expect(readAgentOverlay(overlayPath).quiet).toEqual({ command: 'node' });
  });

  // Each refusal says nothing was deployed and what to give instead, with an
  // id to copy where the given one has characters a tool name can't hold.
  test('rejects missing command/url, both at once, and bad ids, saying what to give', async () => {
    const { stub, calls } = makeStubFramework();
    const mod = makeModule(stub);

    expectSays(
      (await call(mod, 'mcpl_deploy', { id: 'x' })).error,
      'Nothing was deployed or saved', 'Neither `command` nor `url` was given', 'give `command`', 'or `url`',
    );
    expectSays(
      (await call(mod, 'mcpl_deploy', { id: 'x', command: 'a', url: 'ws://b' })).error,
      'Nothing was deployed or saved', 'Both `command` and `url` were given: give one',
    );
    expectSays(
      (await call(mod, 'mcpl_deploy', { id: 'bad id!', command: 'a' })).error,
      'Nothing was deployed or saved', 'The id "bad id!"', 'letters, digits, _ and -', 'use one such as "bad-id"',
    );
    // A name that cleans to the one id JavaScript won't keep: a stand-in too.
    expectSays((await call(mod, 'mcpl_deploy', { id: '__proto__!', command: 'a' })).error, 'use one such as "my-server"');
    // Nothing in it a name can keep: a stand-in to copy.
    expectSays((await call(mod, 'mcpl_deploy', { id: 'üñï', command: 'a' })).error, 'use one such as "my-server"');
    for (const id of [undefined, '  ', 5]) {
      expectSays(
        (await call(mod, 'mcpl_deploy', { id, command: 'a' })).error,
        'Nothing was deployed or saved', '`id` is missing', 'such as "my-server"', 'letters, digits, _ and -',
      );
    }
    expect(calls).toEqual([]);
  });

  // A deployed child gets the env the boot composes for every server: the
  // entry's own env with the host's zone. The host sets no reaction
  // baseline; agent-framework derives that default when the child spawns.
  test('gives a deployed child the env the boot composes for every server', async () => {
    const { stub } = makeStubFramework();
    const configs: Array<{ id: string; env?: Record<string, string> }> = [];
    const connect = (stub as unknown as { connectMcplServer: (c: { id: string; env?: Record<string, string> }) => Promise<void> }).connectMcplServer;
    (stub as unknown as { connectMcplServer: (c: { id: string; env?: Record<string, string> }) => Promise<void> }).connectMcplServer =
      async (c) => { configs.push(c); return connect(c); };
    const mod = makeModule(stub, 'Pacific/Auckland');

    await call(mod, 'mcpl_deploy', { id: 'chat', command: 'node', env: { TOKEN: 'mine' } });
    await call(mod, 'mcpl_deploy', { id: 'quiet', command: 'node', env: { DISCORD_SUPPRESSED_REACTIONS_BASELINE: 'own', AGENT_TIMEZONE: 'Mars/Olympus' } });

    expect(configs[0]!.env).toEqual({
      TOKEN: 'mine',
      AGENT_TIMEZONE: 'Pacific/Auckland',
    });
    // The entry's own baseline passes through; the host's zone wins over the entry's.
    expect(configs[1]!.env!.DISCORD_SUPPRESSED_REACTIONS_BASELINE).toBe('own');
    expect(configs[1]!.env!.AGENT_TIMEZONE).toBe('Pacific/Auckland');
    // The overlay keeps only what the agent gave.
    expect(readAgentOverlay(overlayPath).chat).toEqual({ command: 'node', env: { TOKEN: 'mine' } });

    // A redeploy restarts the child with the same composition.
    const restarted: Array<{ id: string; env?: Record<string, string> }> = [];
    const restart = (stub as unknown as { restartMcplServer: (id: string, c?: { id: string; env?: Record<string, string> }) => Promise<void> }).restartMcplServer;
    (stub as unknown as { restartMcplServer: (id: string, c?: { id: string; env?: Record<string, string> }) => Promise<void> }).restartMcplServer =
      async (id, c) => { if (c) restarted.push(c); return restart(id, c); };
    await call(mod, 'mcpl_deploy', { id: 'chat', command: 'node', env: { TOKEN: 'newer' } });
    expect(restarted).toHaveLength(1);
    expect(restarted[0]!.env).toEqual({ TOKEN: 'newer', AGENT_TIMEZONE: 'Pacific/Auckland' });
  });

  // A field of the wrong kind used to be dropped (or coerced: a null arg
  // saved as "null"), so the deploy said it succeeded with what the caller
  // gave missing or changed.
  test('judges each field as given: a wrong kind is refused, and nothing is saved or connected', async () => {
    const { stub, calls } = makeStubFramework();
    const mod = makeModule(stub);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ env: 'TOKEN=x' }, "its env isn't a map of names to values"],
      [{ env: 5 }, "its env isn't a map of names to values"],
      [{ env: false }, "its env isn't a map of names to values"],
      [{ env: ['A=1'] }, "its env isn't a map of names to values"],
      [{ args: 'server.js' }, "its args aren't a list of text"],
      [{ args: ['server.js', null] }, "its args aren't a list of text"],
      [{ toolPrefix: 5 }, "its toolPrefix isn't text"],
      [{ token: 5 }, "its token isn't text"],
      [{ access: 5 }, "its access isn't text"],
      [{ reconnect: 'yes' }, 'its reconnect is neither true nor false'],
      [{ enabledTools: 'say' }, "its enabledTools isn't a list of names"],
      [{ command: 5 }, "its command isn't text"],
      // The other kind's empty value is no unspecified form here.
      [{ reconnect: '' }, 'its reconnect is neither true nor false'],
      [{ args: '' }, "its args aren't a list of text"],
      [{ env: '' }, "its env isn't a map of names to values"],
      [{ toolPrefix: [] }, "its toolPrefix isn't text"],
      [{ enabledTools: '' }, "its enabledTools isn't a list of names"],
      // An empty name matches nothing: an allow-list of one is deny-all.
      [{ enabledTools: [''] }, 'its enabledTools holds an empty name, which matches nothing'],
      [{ disabledFeatureSets: ['a.b', '  '] }, 'its disabledFeatureSets holds an empty name, which matches nothing'],
    ];
    for (const [fields, problem] of cases) {
      const result = await call(mod, 'mcpl_deploy', { id: 'odd', command: 'node', ...fields });
      expectMalformed(result.error, problem);
    }
    expect(calls).toEqual([]);
    expect(readAgentOverlay(overlayPath)).toEqual({});
  });

  // A refusal that named only the first malformed field cost the agent a
  // call per field.
  test('names every malformed field at once, so a deploy is refused once, not field by field', async () => {
    const { stub, calls } = makeStubFramework();
    const mod = makeModule(stub);
    const result = await call(mod, 'mcpl_deploy', {
      id: 'odd', command: 'node', reconnect: 'yes', enabledTools: 'say', env: { A: null, B: {} }, token: 5,
      args: 'server.js', disabledTools: [null, ' '],
    });
    // A list holding something other than a name is still read for an empty name.
    expectMalformed(
      result.error,
      "its token isn't text; its args aren't a list of text; its env A, B aren't text, a finite number or true/false; " +
      "its enabledTools isn't a list of names; its disabledTools isn't a list of names; its disabledTools holds an " +
      'empty name, which matches nothing; its reconnect is neither true nor false',
    );
    expect(calls).toEqual([]);
    expect(readAgentOverlay(overlayPath)).toEqual({});
  });

  // The id, the command or url, and an access grant this host can't serve
  // used to be refused one at a time, before the fields were read.
  test('names every problem with a deploy in one refusal: the id, the command or url, access, and the fields', async () => {
    const { stub, calls } = makeStubFramework();
    const mod = makeModule(stub);
    const result = await call(mod, 'mcpl_deploy', {
      id: 'my server', command: 'node', url: 'wss://tools.example/mcpl', access: 'eidoverse', env: 'A=1',
    });
    expectSays(
      result.error,
      'Nothing was deployed or saved: The id "my server"', 'use one such as "my-server"',
      'Both `command` and `url` were given', '`access` names a host-managed access grant',
      "The entry would be malformed: its env isn't a map of names to values.",
      'Correct each (or leave out a field the server can do without) and call mcpl-admin--mcpl_deploy again.',
    );
    // Neither command nor url, with a malformed field: both said, and the reading's own "names no command" not again.
    const neither = String((await call(mod, 'mcpl_deploy', { id: 'x', reconnect: 'yes' })).error);
    expectSays(neither, 'Neither `command` nor `url` was given', 'its reconnect is neither true nor false');
    expect(neither).not.toContain('names no command');
    // With nothing else wrong, the reading's problem is exactly its "names nothing", said once, as the refusal's own.
    const bare = String((await call(mod, 'mcpl_deploy', { id: 'x' })).error);
    expect(bare).not.toContain('names no command');
    expect(bare.split('Neither `command` nor `url` was given').length).toBe(2);
    // An id that isn't text is refused as one, not taken for none.
    expectSays(String((await call(mod, 'mcpl_deploy', { id: 42, command: 'node' })).error), '`id` is missing or empty, or isn\'t text');
    expect(calls).toEqual([]);
    expect(readAgentOverlay(overlayPath)).toEqual({});
  });

  // A key the tool doesn't declare would be dropped, and with it what it was
  // meant to set, such as a misspelled deny-list.
  test('refuses a key the tool doesn\'t declare, naming the ones it takes, and saves nothing', async () => {
    const { stub, calls } = makeStubFramework();
    const mod = makeModule(stub);
    const result = String((await call(mod, 'mcpl_deploy', { id: 'chat', command: 'node', disabledTool: ['post'], persist: true })).error);
    expectSays(
      result, 'Nothing was deployed or saved: "disabledTool", "persist" aren\'t fields of mcpl-admin--mcpl_deploy, which takes ' +
      'id, command, args, env, url,', 'enabledTools, disabledTools.',
    );
    expect(String((await call(mod, 'mcpl_deploy', { id: 'chat', command: 'node', disabledTool: ['post'] })).error))
      .toContain('"disabledTool" isn\'t a field of mcpl-admin--mcpl_deploy');
    expect(calls).toEqual([]);
    expect(readAgentOverlay(overlayPath)).toEqual({});
  });

  // A deploy takes an MCPL server's ws:// or wss:// url, so it saves no
  // other: agent-framework refuses every scheme but ws, wss, http and https
  // at every start, and dials an http(s) url as modern MCP, which a deploy
  // doesn't offer.
  test('refuses a url that isn\'t ws:// or wss://, or doesn\'t parse, without quoting it, and saves nothing', async () => {
    const { stub, calls } = makeStubFramework();
    const mod = makeModule(stub);
    const refused = async (url: string) => String((await call(mod, 'mcpl_deploy', { id: 'web', url })).error);
    const http = await refused('http://user:s3cret@tools.example/mcpl');
    expectSays(http, 'Nothing was deployed or saved: `url` begins "http:", not ws: or wss:. Give the server\'s ws:// or wss:// address.');
    expect(http).not.toContain('s3cret');
    expectSays(await refused('localhost:3101'), '`url` begins "localhost:", not ws: or wss:.');
    expectSays(await refused('ws://['), '`url` doesn\'t parse as a url. Give');
    expect(calls).toEqual([]);
    expect(readAgentOverlay(overlayPath)).toEqual({});
    expect((await call(mod, 'mcpl_deploy', { id: 'web', url: 'wss://tools.example/mcpl' })).success).toBe(true);
  });

  // agent-framework refuses a prefix two hold, or one naming a module: a
  // connect now, and the next host start's create(), which stops on it. So
  // it's refused before the save, against every server that start
  // configures and every one loaded now.
  test('refuses a tool prefix a module or another server holds, now or at the next start, and saves nothing', async () => {
    const { stub, calls } = makeStubFramework();
    const mod = makeModule(stub);
    // The operator's: one loaded, one not loaded now that the next start configures, and one the overlay tombstones.
    mod.setOperatorServers([
      { id: 'chat', command: 'node', toolPrefix: 'talk' },
      { id: 'offline', command: 'node', toolPrefix: 'later' },
      { id: 'gone', command: 'node', toolPrefix: 'freed' },
    ]);
    await (stub as unknown as { connectMcplServer: (c: object) => Promise<void> })
      .connectMcplServer({ id: 'chat', command: 'node', toolPrefix: 'talk' });
    // The agent's: an entry that isn't loaded now, and a tombstone.
    saveAgentOverlay(overlayPath, { other: { command: 'node', toolPrefix: 'mine' }, gone: { disabled: true } });
    const refused = async (input: Record<string, unknown>) => String((await call(mod, 'mcpl_deploy', input)).error);
    expectSays(
      await refused({ id: 'a', command: 'node', toolPrefix: 'workspace' }),
      'Nothing was deployed or saved: Its tool prefix "workspace" is the name of the host\'s module "workspace", and ' +
      'agent-framework refuses a prefix two hold: give `toolPrefix` a name of its own.',
    );
    expectSays(await refused({ id: 'b', command: 'node', toolPrefix: 'talk' }), 'Its tool prefix "talk" is held by server "chat"');
    expectSays(await refused({ id: 'c', command: 'node', toolPrefix: 'later' }), 'Its tool prefix "later" is held by server "offline"');
    expectSays(await refused({ id: 'd', command: 'node', toolPrefix: 'mine' }), 'Its tool prefix "mine" is held by server "other"');
    // A default prefix another entry gives as its own.
    saveAgentOverlay(overlayPath, { ...readAgentOverlay(overlayPath), squat: { command: 'node', toolPrefix: 'mcpl--e' } });
    expectSays(
      await refused({ id: 'e', command: 'node' }), 'Its tool prefix "mcpl--e", the default for this id, is held by server "squat"',
    );
    // A prefix given is checked beside an id problem, so both are named at once.
    expectSays(
      await refused({ id: 'bad id', command: 'node', toolPrefix: 'talk' }),
      'The id "bad id" has characters other than', 'Its tool prefix "talk" is held by server "chat"', 'Correct each',
    );
    expect(calls).toEqual(['connect:chat']);
    expect(Object.keys(readAgentOverlay(overlayPath)).sort()).toEqual(['gone', 'other', 'squat']);
    // A tombstoned server's prefix is free at the next start, and an id's own entry is replaced, not a rival.
    // The receipt names the tools the framework connected, under the prefix they hold.
    expect(String((await call(mod, 'mcpl_deploy', { id: 'f', command: 'node', toolPrefix: 'freed' })).data))
      .toStartWith('Deployed server "f" — connected, 1 tools under prefix freed.');
    expect((await call(mod, 'mcpl_deploy', { id: 'other', command: 'bun', toolPrefix: 'mine' })).success).toBe(true);
  });

  // The next start's set is the boot's: an entry that replaces an operator's
  // definition frees that definition's prefix and holds its own, and an
  // entry the boot skips as malformed holds nothing. A server loaded now
  // holds its prefix whatever the next start configures.
  test('counts a prefix as the next start and the live servers hold it: replacements, malformed entries, loaded servers', async () => {
    const { stub, servers } = makeStubFramework();
    const mod = makeModule(stub);
    mod.setOperatorServers([{ id: 'chat', command: 'node', toolPrefix: 'talk' }]);
    // The agent's entry replaces chat's definition with another prefix, and a malformed entry names one.
    saveAgentOverlay(overlayPath, { chat: { command: 'bun', toolPrefix: 'chatter' }, broken: { toolPrefix: 'junk' } });
    const deploy = (input: Record<string, unknown>) => call(mod, 'mcpl_deploy', input);
    expectSays(String((await deploy({ id: 'x', command: 'node', toolPrefix: 'chatter' })).error), 'Its tool prefix "chatter" is held by server "chat"');
    expect((await deploy({ id: 'y', command: 'node', toolPrefix: 'talk' })).success).toBe(true);
    expect((await deploy({ id: 'z', command: 'node', toolPrefix: 'junk' })).success).toBe(true);
    // A server loaded now that nothing the next start configures names.
    servers.set('live', { ...servers.get('y')!, id: 'live', toolPrefix: 'now' });
    expectSays(String((await deploy({ id: 'w', command: 'node', toolPrefix: 'now' })).error), 'Its tool prefix "now" is held by server "live"');
  });

  test('refuses an env number JSON can\'t write, which would be saved as null', async () => {
    const { stub } = makeStubFramework();
    const mod = makeModule(stub);
    expectSays(
      String((await call(mod, 'mcpl_deploy', { id: 'x', command: 'node', env: { BIG: Infinity, SMALL: -Infinity, OK: 1 } })).error),
      'The entry would be malformed: its env BIG, SMALL aren\'t text, a finite number or true/false.',
    );
    expect(readAgentOverlay(overlayPath)).toEqual({});
  });

  test('leaves out what strict function calling sends as unspecified, and saves list numbers as text', async () => {
    const { stub } = makeStubFramework();
    const mod = makeModule(stub);
    const result = await call(mod, 'mcpl_deploy', {
      id: 'plain', command: 'node', args: ['--port', 3101, true], env: null,
      token: '', access: '   ', toolPrefix: '  ', url: '', enabledTools: [], disabledFeatureSets: [],
    });
    expect(result.success).toBe(true);
    // An empty or blank toolPrefix would have been kept by the framework in place of its default prefix.
    expect(readAgentOverlay(overlayPath).plain).toEqual({ command: 'node', args: ['--port', '3101', 'true'] });
  });

  test('saves what it is given of each kind: reconnect false, and the four name lists with numbers as text', async () => {
    const { stub } = makeStubFramework();
    const mod = makeModule(stub);
    const result = await call(mod, 'mcpl_deploy', {
      id: 'shaped', url: 'ws://localhost:3101', reconnect: false,
      enabledFeatureSets: ['chat.*', 7], disabledFeatureSets: ['chat.admin'], enabledTools: ['say', true], disabledTools: ['*'],
    });
    expect(result.success).toBe(true);
    expect(readAgentOverlay(overlayPath).shaped).toEqual({
      url: 'ws://localhost:3101', transport: 'websocket', reconnect: false,
      enabledFeatureSets: ['chat.*', '7'], disabledFeatureSets: ['chat.admin'], enabledTools: ['say', 'true'], disabledTools: ['*'],
    });
  });

  test("names a host-managed access grant only where there's an identity, saving it trimmed", async () => {
    const { stub, calls } = makeStubFramework();
    const mod = makeModule(stub);
    const refused = await call(mod, 'mcpl_deploy', { id: 'world', url: 'ws://localhost:3101', access: 'eidoverse' });
    expectSays(
      refused.error,
      'Nothing was deployed or saved', 'no identity configured', 'leave `access` out', '`token` instead', 'ask your operator to enable identity',
    );
    expect(calls).toEqual([]);
    expect(readAgentOverlay(overlayPath)).toEqual({});
    mod.setIdentity({ accessFor: async () => 'grant-token' });
    expect((await call(mod, 'mcpl_deploy', { id: 'world', url: 'ws://localhost:3101', access: '  eidoverse  ' })).success).toBe(true);
    expect(readAgentOverlay(overlayPath).world).toEqual({ url: 'ws://localhost:3101', transport: 'websocket', access: 'eidoverse' });
  });

  test('refuses a credential over ws:// to another machine, in a field or in the url, saving nothing, and takes wss:// or this machine', async () => {
    const { stub, calls } = makeStubFramework();
    const mod = makeModule(stub);
    mod.setIdentity({ accessFor: async () => 'grant-token' });
    const byToken = await call(mod, 'mcpl_deploy', { id: 'tools', url: 'ws://tools.example:3101/mcpl', token: 't' });
    expectSays(
      byToken.error,
      'Nothing was deployed: its token would go to tools.example:3101 over unencrypted ws://', 'nothing was saved',
      'Use a wss:// url', 'ask your operator to add the server to the recipe',
    );
    const byGrant = await call(mod, 'mcpl_deploy', { id: 'world', url: 'ws://10.0.0.7/mcpl', access: 'eidoverse' });
    expect(byGrant.error).toStartWith('Nothing was deployed: the credential of its access grant "eidoverse" would go to 10.0.0.7 over unencrypted ws://');
    for (const url of ['ws://tools.example/mcpl?token=abc', 'ws://user:pass@tools.example/mcpl']) {
      const byUrl = await call(mod, 'mcpl_deploy', { id: 'pasted', url });
      expect(byUrl.error).toStartWith('Nothing was deployed: the user, password or token parameter in its url would go to tools.example over unencrypted ws://');
    }
    // A grant that isn't text is malformed, whatever the url: it names no grant to refuse.
    expectMalformed((await call(mod, 'mcpl_deploy', { id: 'odd', url: 'ws://tools.example', access: 5 })).error, "its access isn't text");
    expect(calls).toEqual([]);
    expect(readAgentOverlay(overlayPath)).toEqual({});
    expect((await call(mod, 'mcpl_deploy', { id: 'tools', url: 'wss://tools.example:3101/mcpl', token: 't' })).success).toBe(true);
    expect((await call(mod, 'mcpl_deploy', { id: 'local', url: 'ws://127.0.0.1:3101', token: 't' })).success).toBe(true);
    expect((await call(mod, 'mcpl_deploy', { id: 'open', url: 'ws://tools.example:3102' })).success).toBe(true);
    expect(Object.keys(readAgentOverlay(overlayPath)).sort()).toEqual(['local', 'open', 'tools']);
  });

  test('says a configured server is unchanged when a redeploy of it is refused for a credential over ws://', async () => {
    const { stub } = makeStubFramework();
    const mod = makeModule(stub);
    expect((await call(mod, 'mcpl_deploy', { id: 'tools', url: 'wss://tools.example/mcpl', token: 't' })).success).toBe(true);
    const refused = await call(mod, 'mcpl_deploy', { id: 'tools', url: 'ws://tools.example/mcpl', token: 't' });
    expectSays(refused.error, 'nothing was saved', 'The server already configured as "tools" is unchanged');
    expect(readAgentOverlay(overlayPath).tools).toEqual({ url: 'wss://tools.example/mcpl', transport: 'websocket', token: 't' });
  });

  test('refuses the id __proto__, which would never be saved, and takes any other name as an id', async () => {
    const { stub, calls } = makeStubFramework();
    const mod = makeModule(stub);
    const refused = await call(mod, 'mcpl_deploy', { id: '__proto__', command: 'node' });
    expectSays(refused.error, 'Nothing was deployed or saved', '"__proto__" can\'t be a server id', 'choose another');
    expect(calls).toEqual([]);
    const named = await call(mod, 'mcpl_deploy', { id: 'constructor', command: 'node' });
    expect(named.success).toBe(true);
    expect(String(named.data)).not.toContain('malformed');
    expect(JSON.parse(readFileSync(overlayPath, 'utf-8')).mcplServers).toEqual({ constructor: { command: 'node' } });
  });

  test("keeps the overlay root's other keys, such as a misspelled one, when it saves", async () => {
    const { stub } = makeStubFramework();
    const mod = makeModule(stub);
    writeFileSync(overlayPath, JSON.stringify({ mcplServer: { old: { disabled: true } }, mcplServers: {} }));
    await call(mod, 'mcpl_deploy', { id: 'mytool', command: 'node' });
    expect(JSON.parse(readFileSync(overlayPath, 'utf-8'))).toEqual({
      mcplServer: { old: { disabled: true } },
      mcplServers: { mytool: { command: 'node' } },
    });
  });

  test('connect failure keeps the overlay entry and reports the error', async () => {
    const { stub } = makeStubFramework();
    (stub as unknown as { connectMcplServer: () => Promise<void> }).connectMcplServer =
      async () => { throw new Error('spawn ENOENT'); };
    const mod = makeModule(stub);

    const result = await call(mod, 'mcpl_deploy', { id: 'broken', command: 'nonexistent' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('spawn ENOENT');
    expect(readAgentOverlay(overlayPath).broken).toEqual({ command: 'nonexistent' });
  });
});

describe('mcpl_unload', () => {
  test('agent-deployed server: disconnects and deletes the overlay entry', async () => {
    const { stub, servers } = makeStubFramework();
    const mod = makeModule(stub);
    await call(mod, 'mcpl_deploy', { id: 'mytool', command: 'node' });

    const result = await call(mod, 'mcpl_unload', { id: 'mytool' });

    expect(result.success).toBe(true);
    expect(servers.has('mytool')).toBe(false);
    expect(readAgentOverlay(overlayPath).mytool).toBeUndefined();
  });

  test('recipe server: disconnects and writes a tombstone', async () => {
    const { stub, servers } = makeStubFramework();
    // Simulate a recipe-loaded server the module didn't deploy.
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'discord', command: 'node' });
    const mod = makeModule(stub);

    const result = await call(mod, 'mcpl_unload', { id: 'discord' });

    expect(result.success).toBe(true);
    expect(servers.has('discord')).toBe(false);
    expect(readAgentOverlay(overlayPath).discord).toEqual({ disabled: true });
  });

  test('persist:false leaves the overlay untouched', async () => {
    const { stub, servers } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'discord', command: 'node' });
    const mod = makeModule(stub);

    const result = await call(mod, 'mcpl_unload', { id: 'discord', persist: false });

    expect(result.success).toBe(true);
    expect(servers.has('discord')).toBe(false);
    expect(readAgentOverlay(overlayPath)).toEqual({});
  });

  test('unknown server errors, naming the servers that are loaded', async () => {
    const { stub } = makeStubFramework();
    const mod = makeModule(stub);
    expectSays((await call(mod, 'mcpl_unload', { id: 'nope' })).error, 'Nothing was unloaded', 'no server "nope"', 'None is loaded');
    // An inherited key isn't an entry: nothing is tombstoned for it.
    expect((await call(mod, 'mcpl_unload', { id: 'constructor' })).success).toBe(false);
    expect(readAgentOverlay(overlayPath)).toEqual({});
    await call(mod, 'mcpl_deploy', { id: 'discord', command: 'node' });
    await call(mod, 'mcpl_deploy', { id: 'shell', command: 'node' });
    expectSays((await call(mod, 'mcpl_unload', { id: 'discrod' })).error, 'Nothing was unloaded', 'no server "discrod"', 'Loaded: "discord", "shell"');
  });

  test('an entry a concurrent mcpl_deploy writes during the disconnect is kept', async () => {
    const { stub } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'discord', command: 'node' });
    const mod = makeModule(stub);
    const disconnect = (stub as unknown as { disconnectMcplServer: (id: string) => Promise<void> }).disconnectMcplServer;
    (stub as unknown as { disconnectMcplServer: (id: string) => Promise<void> }).disconnectMcplServer = async (id) => {
      await disconnect(id);
      // While the unload awaits, another call deploys a server.
      saveAgentOverlay(overlayPath, { ...readAgentOverlay(overlayPath), newer: { command: 'node' } });
    };
    const result = await call(mod, 'mcpl_unload', { id: 'discord' });
    expect(result.success).toBe(true);
    expect(readAgentOverlay(overlayPath)).toEqual({ newer: { command: 'node' }, discord: { disabled: true } });
  });

  // The unload used to disconnect first and read the overlay after, so a
  // file the boot stops on left the server down with nothing recorded. Only
  // the record needs the file, so an unload for this session goes on.
  test('an overlay the boot would stop on refuses a persisting unload, with the server still loaded, and a session-only one goes on', async () => {
    const { stub, servers, calls } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'discord', command: 'node' });
    writeFileSync(overlayPath, '{ not json');
    const mod = makeModule(stub);
    const result = await call(mod, 'mcpl_unload', { id: 'discord' });
    expect(result.success).toBe(false);
    // Said to the agent, not in the boot's words for the operator.
    expectSays(
      result.error,
      `Nothing was unloaded: your overlay file, ${overlayPath}, isn't valid JSON, so the unload can't be recorded in it.`,
      'The next host start will stop on the file until it\'s fixed.',
      'Fix the file (or, if you can\'t edit it, ask your operator to), then call mcpl-admin--mcpl_unload "discord" again.',
      'Don\'t move it aside',
      'To stop "discord" for this session in the meantime, call mcpl-admin--mcpl_unload with `persist: false`.',
    );
    expect(result.error).not.toContain('the agent overlay');
    expect(calls).toEqual(['connect:discord']);
    expect(servers.has('discord')).toBe(true);

    const session = await call(mod, 'mcpl_unload', { id: 'discord', persist: false });
    expect(session.data).toBe(
      `Unloaded server "discord" — its tools are gone from your toolset. Session-only. Your overlay file, ${overlayPath}, ` +
      'isn\'t valid JSON. The next host start will stop on the file until it\'s fixed. Fix the file (or, if you can\'t ' +
      'edit it, ask your operator to). Don\'t move it aside: the operator\'s servers you unloaded would load again, and ' +
      'your deployments would be dropped.',
    );
    expect(servers.has('discord')).toBe(false);
    expect(readFileSync(overlayPath, 'utf-8')).toBe('{ not json');
  });

  // Only the overlay could name an id that's neither loaded nor the
  // operator's, and an operator's server that isn't loaded has nothing to
  // stop this session, so only its session-only unload goes on.
  test('with an overlay the boot would stop on, an unload of a server that isn\'t loaded goes on only for an operator\'s server, for this session', async () => {
    const { stub, calls } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'discord', command: 'node' });
    const mod = makeModule(stub);
    mod.setOperatorServers([{ id: 'op', command: 'operator-server' }]);
    writeFileSync(overlayPath, 'null');
    const unknownId = (persist: boolean) => call(mod, 'mcpl_unload', { id: 'mine', persist });
    for (const persist of [true, false]) {
      expectSays(
        (await unknownId(persist)).error,
        'Nothing was unloaded: no server "mine" is loaded or defined by your operator. Loaded: "discord".',
        `Your overlay file, ${overlayPath}, holds null, not an object with mcplServers, so whether it names "mine" isn't known.`,
        'Fix the file (or, if you can\'t edit it, ask your operator to), then call mcpl-admin--mcpl_unload "mine" again.',
      );
    }
    const persisting = String((await call(mod, 'mcpl_unload', { id: 'op' })).error);
    expectSays(
      persisting, `Nothing was unloaded: your overlay file, ${overlayPath}, holds null, not an object with mcplServers, so the ` +
      'unload can\'t be recorded in it.',
    );
    // Nothing of it runs this session, so a session-only unload isn't offered.
    expect(persisting).not.toContain('persist: false');
    expect((await call(mod, 'mcpl_unload', { id: 'op', persist: false })).data).toStartWith(
      `Server "op" wasn't loaded in this session. Session-only. Your overlay file, ${overlayPath}, holds null, not an ` +
      'object with mcplServers. The next host start will stop on the file until it\'s fixed.',
    );
    expect(calls).toEqual(['connect:discord']);
    expect(readFileSync(overlayPath, 'utf-8')).toBe('null');
  });

  test('a disconnect that fails changes nothing in the overlay, and says so', async () => {
    const { stub } = makeStubFramework();
    const mod = makeModule(stub);
    mod.setOperatorServers([{ id: 'discord', command: 'node' }]);
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'discord', command: 'node' });
    await call(mod, 'mcpl_deploy', { id: 'mytool', command: 'node' });
    const before = readFileSync(overlayPath, 'utf-8');
    (stub as unknown as { disconnectMcplServer: () => Promise<void> }).disconnectMcplServer =
      async () => { throw new Error('stuck'); };
    const expectDisconnectFailed = (text: unknown, id: string, reason: string) => expectSays(
      text, `Server "${id}" couldn't be disconnected: ${reason}.`, 'It may still be loaded', 'changed nothing in your overlay',
      'mcpl-admin--mcpl_list shows whether it\'s loaded', `call mcpl-admin--mcpl_unload "${id}" again`,
    );
    for (const id of ['discord', 'mytool']) {
      expectDisconnectFailed((await call(mod, 'mcpl_unload', { id })).error, id, 'stuck');
    }
    (stub as unknown as { disconnectMcplServer: () => Promise<void> }).disconnectMcplServer =
      async () => { throw 'socket wedged'; };
    expectDisconnectFailed((await call(mod, 'mcpl_unload', { id: 'discord', persist: false })).error, 'discord', 'socket wedged');
    expect(readFileSync(overlayPath, 'utf-8')).toBe(before);
  });

  // Once the server is gone, a failure to record the unload says so, and an
  // operator's server that isn't loaded can be unloaded again to record it.
  test('an overlay that fails after the disconnect says the server is gone and the unload unrecorded, with the repair, and a retry records it', async () => {
    const { stub, servers } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'discord', command: 'node' });
    const mod = makeModule(stub);
    mod.setOperatorServers([{ id: 'discord', command: 'node' }]);
    const disconnect = (stub as unknown as { disconnectMcplServer: (id: string) => Promise<void> }).disconnectMcplServer;
    (stub as unknown as { disconnectMcplServer: (id: string) => Promise<void> }).disconnectMcplServer = async (id) => {
      await disconnect(id);
      writeFileSync(overlayPath, '{ not json');
    };
    const failed = await call(mod, 'mcpl_unload', { id: 'discord' });
    expectSays(
      failed.error,
      'Unloaded server "discord" — its tools are gone from your toolset.',
      `But your overlay file, ${overlayPath}, isn't valid JSON, so the unload isn't recorded.`,
      'The next host start will stop on the file until it\'s fixed.',
      'Fix the file (or, if you can\'t edit it, ask your operator to), then call mcpl-admin--mcpl_unload "discord" again.',
      'Don\'t move it aside',
    );
    expect(servers.has('discord')).toBe(false);
    writeFileSync(overlayPath, JSON.stringify({ mcplServers: {} }));
    expect((await call(mod, 'mcpl_unload', { id: 'discord' })).data).toBe(
      'Server "discord" wasn\'t loaded in this session. Tombstoned in your overlay — it stays unloaded across host restarts; ' +
      'mcpl-admin--mcpl_deploy would load your own entry in its place, and removing the tombstone from your overlay file (or, ' +
      'if you can\'t edit it, asking your operator to) loads the operator\'s definition again at the next host start.',
    );
    expect(readAgentOverlay(overlayPath).discord).toEqual({ disabled: true });
  });

  // The read after the disconnect is the one that follows an await, so its
  // file can have become unreadable since the call began. Any failure there
  // is said as the first read's would be: never as a failed save, and never
  // with what the file held before.
  test("an overlay that can't be read at all after the disconnect is said in the overlay's wording, not as a failed save", async () => {
    const { stub, servers } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'discord', command: 'node' });
    const mod = makeModule(stub);
    mod.setOperatorServers([{ id: 'discord', command: 'node' }]);
    saveAgentOverlay(overlayPath, {});
    const disconnect = (stub as unknown as { disconnectMcplServer: (id: string) => Promise<void> }).disconnectMcplServer;
    (stub as unknown as { disconnectMcplServer: (id: string) => Promise<void> }).disconnectMcplServer = async (id) => {
      await disconnect(id);
      rmSync(overlayPath);
      mkdirSync(overlayPath);
    };
    const failed = String((await call(mod, 'mcpl_unload', { id: 'discord' })).error);
    expectSays(
      failed,
      'Unloaded server "discord" — its tools are gone from your toolset.',
      `But your overlay file, ${overlayPath}, couldn't be read (`, 'EISDIR',
      '), so the unload isn\'t recorded. The next host start will stop on the file while it can\'t be read. Ask your ' +
      'operator to fix it, then call mcpl-admin--mcpl_unload "discord" again.',
    );
    for (const said of ['couldn\'t be updated', 'aving your overlay', 'loads it again']) expect(failed).not.toContain(said);
    expect(servers.has('discord')).toBe(false);
  });

  // An error that may come from a write, such as EIO, from that read is the
  // read's: nothing was saved, so nothing is said of what a save left.
  test('an EIO from the read after the disconnect is said as a read, with nothing said of a save', async () => {
    const { stub } = makeStubFramework();
    const mod = makeModule(stub);
    await call(mod, 'mcpl_deploy', { id: 'kept', command: 'node' });
    const real = mcplConfig.readAgentOverlay;
    let reads = 0;
    const read = spyOn(mcplConfig, 'readAgentOverlay').mockImplementation((path: string) => {
      reads += 1;
      if (reads === 2) throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });
      return real(path);
    });
    let failed: string;
    try {
      failed = String((await call(mod, 'mcpl_unload', { id: 'kept' })).error);
    } finally {
      read.mockRestore();
    }
    expect(reads).toBe(2);
    expectSays(
      failed,
      'Unloaded server "kept" — its tools are gone from your toolset.',
      `But your overlay file, ${overlayPath}, couldn't be read (EIO: i/o error, read), so the unload isn't recorded. ` +
      'The next host start will stop on the file while it can\'t be read.',
    );
    for (const said of ['aving your overlay', 'isn\'t known', 'cut short']) expect(failed).not.toContain(said);
    expect(readAgentOverlay(overlayPath)).toEqual({ kept: { command: 'node' } });
  });

  // A save that fails at the open leaves the file as it was read after the
  // disconnect, which a hand edit can have changed, so the receipt says
  // what that read found.
  test('a record that fails after the entry changed during the disconnect says what the file holds now', async () => {
    const { stub } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'op', command: 'operator-server' });
    const mod = makeModule(stub);
    mod.setOperatorServers([{ id: 'op', command: 'operator-server' }]);
    saveAgentOverlay(overlayPath, {});
    const disconnect = (stub as unknown as { disconnectMcplServer: (id: string) => Promise<void> }).disconnectMcplServer;
    (stub as unknown as { disconnectMcplServer: (id: string) => Promise<void> }).disconnectMcplServer = async (id) => {
      await disconnect(id);
      writeFileSync(overlayPath, JSON.stringify({ mcplServers: { op: { command: 'mine' } } }));
    };
    const save = spyOn(mcplConfig, 'saveAgentOverlay').mockImplementation(() => {
      throw Object.assign(new Error('EACCES: the open failed'), { code: 'EACCES' });
    });
    let failed: string;
    try {
      failed = String((await call(mod, 'mcpl_unload', { id: 'op' })).error);
    } finally {
      save.mockRestore();
    }
    expectSays(
      failed,
      `But your overlay file, ${overlayPath}, couldn't be updated (EACCES: the open failed), so the unload isn't recorded: ` +
      'your overlay entry loads it again at the next host start.',
    );
    expect(failed).not.toContain('the operator\'s definition loads it again');
  });

  test('refuses the id __proto__, whose tombstone would never be saved', async () => {
    const { stub } = makeStubFramework();
    const mod = makeModule(stub);
    mod.setOperatorServers([{ id: '__proto__', command: 'node' }]);
    expectSays((await call(mod, 'mcpl_unload', { id: '__proto__' })).error, 'Nothing was unloaded', 'your overlay can\'t record "__proto__"');
  });

  test('an id the overlay alone names is not disconnected: its entry is removed, or its tombstone kept', async () => {
    const { stub, calls } = makeStubFramework();
    (stub as unknown as { disconnectMcplServer: (id: string) => Promise<void> }).disconnectMcplServer =
      async (id) => { calls.push(`disconnect:${id}`); throw new Error('MCPL subsystem is not initialized'); };
    saveAgentOverlay(overlayPath, { stale: { command: 'node' }, gone: { disabled: true } });
    const mod = makeModule(stub);
    mod.setOperatorServers([{ id: 'gone', command: 'node' }]);
    expect((await call(mod, 'mcpl_unload', { id: 'stale' })).data)
      .toBe('Server "stale" wasn\'t loaded in this session. Removed from your agent overlay.');
    expect((await call(mod, 'mcpl_unload', { id: 'gone' })).data).toBe(
      'Server "gone" wasn\'t loaded in this session. Tombstoned in your overlay — it stays unloaded across host restarts; ' +
      'mcpl-admin--mcpl_deploy would load your own entry in its place, and removing the tombstone from your overlay file (or, ' +
      'if you can\'t edit it, asking your operator to) loads the operator\'s definition again at the next host start.',
    );
    expect(calls).toEqual([]);
    expect(readAgentOverlay(overlayPath)).toEqual({ gone: { disabled: true } });
  });

  // A malformed entry loads nothing for an id the operator doesn't define,
  // so unloading it removes it rather than leaving a tombstone in its place.
  test("a malformed entry is removed for an id the operator doesn't define", async () => {
    const { stub } = makeStubFramework();
    writeFileSync(overlayPath, JSON.stringify({ mcplServers: { stray: null, odd: { command: 'node', args: 'x' } } }));
    const mod = makeModule(stub);
    expect((await call(mod, 'mcpl_unload', { id: 'stray' })).data).toBe('Server "stray" wasn\'t loaded in this session. Removed from your agent overlay.');
    expect((await call(mod, 'mcpl_unload', { id: 'odd' })).data).toBe('Server "odd" wasn\'t loaded in this session. Removed from your agent overlay.');
    expect(readAgentOverlay(overlayPath)).toEqual({});
  });

  test('a session-only unload says what the next start loads, read from the overlay', async () => {
    const { stub } = makeStubFramework();
    const connect = (id: string) => (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id, command: 'node' });
    await connect('discord');
    await connect('adhoc');
    await connect('heartbeat');
    const mod = makeModule(stub);
    mod.setOperatorServers([{ id: 'discord', command: 'node' }, { id: 'heartbeat', command: 'node' }]);
    await call(mod, 'mcpl_deploy', { id: 'mine', command: 'bun' });
    saveAgentOverlay(overlayPath, { ...readAgentOverlay(overlayPath), heartbeat: { disabled: true } });
    // An operator id the agent's entry replaces loads that entry, not the operator's definition.
    mod.setOperatorServers([{ id: 'discord', command: 'node' }, { id: 'heartbeat', command: 'node' }, { id: 'mine', command: 'node' }]);
    const unload = async (id: string) => String((await call(mod, 'mcpl_unload', { id, persist: false })).data);
    const head = (id: string) => `Unloaded server "${id}" — its tools are gone from your toolset. Session-only: `;
    expect(await unload('discord')).toBe(`${head('discord')}the operator's definition loads it again at the next host start.`);
    expect(await unload('mine')).toBe(`${head('mine')}your overlay entry loads it again at the next host start.`);
    expect(await unload('heartbeat')).toBe(`${head('heartbeat')}your overlay tombstones it, so the next host start leaves it unloaded.`);
    expect(await unload('adhoc')).toBe(`${head('adhoc')}nothing loads it at the next host start.`);
  });

  // The other direction: an unload made while a deploy of the same id
  // connects waits for it, so it disconnects what the deploy connected and
  // removes the entry the deploy saved.
  test('an unload of the same id made during a deploy\'s connect runs after the deploy', async () => {
    const { stub, servers, calls } = makeStubFramework();
    const mod = makeModule(stub);
    const connect = (stub as unknown as { connectMcplServer: (c: { id: string }) => Promise<void> }).connectMcplServer;
    let unload: ReturnType<typeof call> | undefined;
    (stub as unknown as { connectMcplServer: (c: { id: string }) => Promise<void> }).connectMcplServer = async (config) => {
      unload = call(mod, 'mcpl_unload', { id: 'mytool' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await connect(config);
    };
    expect(String((await call(mod, 'mcpl_deploy', { id: 'mytool', command: 'node' })).data)).toStartWith('Deployed server "mytool" — connected');
    expect((await unload!).data).toBe('Unloaded server "mytool" — its tools are gone from your toolset. Removed from your agent overlay.');
    expect(calls).toEqual(['connect:mytool', 'disconnect:mytool']);
    expect(servers.has('mytool')).toBe(false);
    expect(readAgentOverlay(overlayPath)).toEqual({});
  });

  // Calls for one server run one at a time, so a deploy made while an
  // unload disconnects waits for it. Its entry, identical or not, is never
  // removed as the unload's, and each receipt is true when it's given.
  test('a deploy of the same id made during the disconnect runs after the unload, and keeps its entry', async () => {
    for (const command of ['bun', 'node']) {
      const { stub, servers, calls } = makeStubFramework();
      const mod = makeModule(stub);
      await call(mod, 'mcpl_deploy', { id: 'mytool', command: 'node' });
      const disconnect = (stub as unknown as { disconnectMcplServer: (id: string) => Promise<void> }).disconnectMcplServer;
      let redeploy: ReturnType<typeof call> | undefined;
      (stub as unknown as { disconnectMcplServer: (id: string) => Promise<void> }).disconnectMcplServer = async (id) => {
        redeploy = call(mod, 'mcpl_deploy', { id: 'mytool', command });
        await new Promise((resolve) => setTimeout(resolve, 10));
        await disconnect(id);
      };
      const unloaded = await call(mod, 'mcpl_unload', { id: 'mytool' });
      expect(unloaded.data).toBe('Unloaded server "mytool" — its tools are gone from your toolset. Removed from your agent overlay.');
      expect(String((await redeploy!).data)).toStartWith('Deployed server "mytool" — connected');
      expect(readAgentOverlay(overlayPath).mytool).toEqual({ command });
      expect(servers.has('mytool')).toBe(true);
      expect(calls).toEqual(['connect:mytool', 'disconnect:mytool', 'connect:mytool']);
    }
  });
});

describe('mcpl_list labels', () => {
  // The label is the command, else the url, as main labelled it, and doesn't
  // read the status's transport (this stub's status carries none), so for a
  // definition naming both it shows the command.
  test('a server is labelled by its command, else its url, from the status the framework reports', async () => {
    const { stub } = makeStubFramework();
    const connect = (stub as unknown as { connectMcplServer: (c: { id: string; command?: string; url?: string; transport?: string }) => Promise<void> })
      .connectMcplServer;
    await connect({ id: 'world', url: 'wss://x.test/mcpl' });
    await connect({ id: 'both', command: 'node', url: 'wss://y.test/mcpl', transport: 'websocket' });
    await connect({ id: 'shell', command: 'node' });
    const status = stub.listMcplServers();
    expect(status.every((s) => !('transport' in s))).toBe(true);
    const text = String((await call(makeModule(stub), 'mcpl_list')).data);
    expect(text).toMatch(/world: CONNECTED .*, wss:\/\/x\.test\/mcpl$/m);
    expect(text).toMatch(/both: CONNECTED .*, node$/m);
    expect(text).toMatch(/shell: CONNECTED .*, node$/m);
  });
});

describe('mcpl_restart', () => {
  test('restarts a loaded server', async () => {
    const { stub, calls } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'discord', command: 'node' });
    const mod = makeModule(stub);

    const result = await call(mod, 'mcpl_restart', { id: 'discord' });

    expect(result.success).toBe(true);
    expect(calls).toEqual(['connect:discord', 'restart:discord']);
  });

  // An inherited name read straight off the overlay would be a function,
  // which the note would call a malformed entry.
  test('a server named like an inherited key gets no note about an entry it lacks', async () => {
    const { stub } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'toString', command: 'node' });
    const mod = makeModule(stub);
    mod.setOperatorServers([{ id: 'toString', command: 'node' }]);
    const result = await call(mod, 'mcpl_restart', { id: 'toString' });
    expect(result.data).toBe('Restarted server "toString" — connected, 1 tools.');
  });
});

describe('mcpl_list', () => {
  // The listing is of what's loaded and what the overlay says, so with
  // neither it says none is loaded, which holds whatever the operator's file
  // defines for a later start.
  test('says no server is loaded when none is and the overlay holds nothing', async () => {
    const { stub } = makeStubFramework();
    const mod = makeModule(stub);
    expect((await call(mod, 'mcpl_list')).data).toBe('No MCPL servers are loaded. Use mcpl-admin--mcpl_deploy to add one.');
  });

  test('shows live servers, sources, and tombstones', async () => {
    const { stub } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'discord', command: 'node' });
    const mod = makeModule(stub);
    await call(mod, 'mcpl_deploy', { id: 'mytool', command: 'bun' });
    saveAgentOverlay(overlayPath, { ...readAgentOverlay(overlayPath), gone: { disabled: true } });

    const result = await call(mod, 'mcpl_list');

    expect(result.success).toBe(true);
    const text = String(result.data);
    expect(text).toContain('discord: CONNECTED');
    expect(text).toContain('mytool: CONNECTED');
    expect(text).toContain('policy=established');
    expect(text).toContain('grant=[channels.incoming]');
    expect(text).toContain('masked=[channels.streaming]');
    expect(text).toContain('denied=[contextHooks.beforeInference.inject.system]');
    expect(text).toContain('hostCommands=deny');
    expect(text).toContain(
      'manifest={revision="sha256:validated",' +
      'fetchedAt=2026-08-05T01:02:03.000Z,' +
      'negotiatedAt=2026-08-05T01:02:04.000Z}',
    );
    expect(text).toContain('source=agent-overlay');
    expect(text).toContain('gone: UNLOADED');
  });

  test("names a malformed overlay entry as one the boot skipped, and the operator's live server as the operator's", async () => {
    const { stub } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'discord', command: 'node' });
    writeFileSync(join(dir, 'mcpl-servers.json'), JSON.stringify({ mcplServers: { discord: { command: 'node' } } }));
    writeFileSync(overlayPath, JSON.stringify({ mcplServers: { discord: { command: 'node', args: 'server.js' }, stray: null } }));
    const mod = makeModule(stub);
    const text = String((await call(mod, 'mcpl_list')).data);
    expect(text).toContain('source=file/recipe');
    expect(text).not.toContain('source=agent-overlay');
    expect(text).toContain("discord: MALFORMED in your overlay (its args aren't a list of text, numbers or true/false), so the boot skips it");
    expect(text).toContain("stray: MALFORMED in your overlay (it isn't an object), so the boot skips it");
    // A restart reads the same file without throwing: it succeeds, and its
    // receipt says the entry is malformed and what the next start does.
    mod.setOperatorServers([{ id: 'discord', command: 'node' }]);
    const restarted = await call(mod, 'mcpl_restart', { id: 'discord' });
    expect(restarted.success).toBe(true);
    expect(String(restarted.data)).toContain('Restarted server "discord" — connected');
    expect(String(restarted.data)).toContain(
      'Your overlay entry for "discord" is malformed (its args aren\'t a list of text, numbers or true/false), ' +
      'so the next host start skips it and loads the operator\'s definition; redeploy with mcpl-admin--mcpl_deploy to replace it; ' +
      'mcpl-admin--mcpl_unload would tombstone the operator\'s definition, so it stays unloaded.',
    );
    expect(String(restarted.data)).not.toContain("couldn't be read");
    // A skipped entry takes no effect, so the last-connect sentence isn't said.
    expect(String(restarted.data)).not.toContain('last connect');
    // The advice says what mcpl_unload does for an id the operator defines,
    // and stays plain for one it doesn't.
    const listed = String((await call(mod, 'mcpl_list')).data);
    expect(listed).toContain(
      'discord: MALFORMED in your overlay (its args aren\'t a list of text, numbers or true/false), so the boot skips it ' +
      'and loads the operator\'s definition — redeploy with mcpl-admin--mcpl_deploy to replace it; mcpl-admin--mcpl_unload would tombstone the ' +
      'operator\'s definition, so it stays unloaded',
    );
    expect(listed).toContain("stray: MALFORMED in your overlay (it isn't an object), so the boot skips it — redeploy with mcpl-admin--mcpl_deploy, or mcpl-admin--mcpl_unload it");
    // Unloading it for good tombstones the operator's server over the malformed entry, as the advice says.
    await call(mod, 'mcpl_unload', { id: 'discord' });
    expect(readAgentOverlay(overlayPath).discord).toEqual({ disabled: true });
  });

  // A tombstone that carries other fields is a tombstone: mcpl_list says
  // so, and a restart says the overlay keeps the server unloaded at the next
  // start.
  test('a tombstone, junk fields and all, is listed as unloaded, and a restart of it says why', async () => {
    const { stub, calls } = makeStubFramework();
    const mod = makeModule(stub);
    mod.setOperatorServers([{ id: 'discord', command: 'node' }]);
    writeFileSync(overlayPath, JSON.stringify({ mcplServers: { discord: { disabled: true, command: 5, args: 'x', env: 'y' } } }));
    const listed = String((await call(mod, 'mcpl_list')).data);
    // For an id the operator defines, no tool brings its definition back:
    // only removing the tombstone does.
    const advice = 'mcpl-admin--mcpl_deploy would load your own entry in its place, and removing the tombstone from your overlay file ' +
      '(or, if you can\'t edit it, asking your operator to) loads the operator\'s definition again at the next host start';
    expect(listed).toContain(`discord: UNLOADED (tombstoned in your overlay — ${advice})`);
    expect(listed).not.toContain('MALFORMED');
    // Refused before the framework is asked, saying what is loaded and why this isn't.
    const restarted = await call(mod, 'mcpl_restart', { id: 'discord' });
    expect(restarted.success).toBe(false);
    expectSays(
      restarted.error,
      'Nothing was restarted: no server "discord" is loaded in this session.', 'None is loaded.',
      `Your overlay tombstones "discord", so the next host start leaves it unloaded; ${advice}.`,
    );
    expect(calls).toEqual([]);
    // Nothing is left to reconnect with, so the last-connect sentence isn't said.
    expect(restarted.error).not.toContain('last connect');
    // An id nothing else defines is the agent's own, which a deploy restores.
    writeFileSync(overlayPath, JSON.stringify({ mcplServers: { mine: { disabled: true } } }));
    expect(String((await call(mod, 'mcpl_list')).data)).toContain('mine: UNLOADED (tombstoned in your overlay — redeploy with mcpl-admin--mcpl_deploy to restore it)');
  });

  // A tombstone written while its server runs leaves it connected for this
  // session, and the list says so rather than UNLOADED.
  test('a tombstone for a server still connected is listed as tombstoned, not as unloaded', async () => {
    const { stub } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'heartbeat', command: 'node' });
    const mod = makeModule(stub);
    writeFileSync(overlayPath, JSON.stringify({ mcplServers: { heartbeat: { disabled: true } } }));
    const listed = String((await call(mod, 'mcpl_list')).data);
    expect(listed).toContain('heartbeat: CONNECTED');
    expect(listed).toContain(
      'heartbeat: TOMBSTONED in your overlay, still connected this session; the next host start leaves it unloaded — ' +
      'redeploy with mcpl-admin--mcpl_deploy to restore it',
    );
    expect(listed).not.toContain('heartbeat: UNLOADED');
  });

  // The next start loads the entry with no deploy, and a deploy now needs
  // each of its fields, since it replaces the entry whole, and the line
  // shows none of them.
  test("an overlay entry that isn't loaded says the next start loads it, and what a deploy needs to load it now", async () => {
    const { stub } = makeStubFramework();
    const mod = makeModule(stub);
    writeFileSync(overlayPath, JSON.stringify({ mcplServers: { idle: { command: 'node' } } }));
    expect(String((await call(mod, 'mcpl_list')).data)).toContain(
      'idle: NOT LOADED (in your overlay but not connected: the next host start loads it, and mcpl-admin--mcpl_deploy ' +
      'with each of its fields loads it now, since a deploy replaces the entry whole)',
    );
  });

  test('a recipe server named like an inherited key is labelled recipe, not file/recipe', async () => {
    const { stub } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'constructor', command: 'node' });
    const mod = makeModule(stub);
    expect(String((await call(mod, 'mcpl_list')).data)).toContain('constructor: CONNECTED');
    expect(String((await call(mod, 'mcpl_list')).data)).toContain('source=recipe,');
  });

  test('distinguishes older-framework unknown and bounds untrusted revisions', async () => {
    const { stub, servers } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'discord', command: 'node' });
    const mod = makeModule(stub);

    const server = servers.get('discord')!;
    delete server.manifestState;
    expect(String((await call(mod, 'mcpl_list')).data)).toContain('manifest=unknown');

    server.manifestState = {
      lastValidatedRevision: `unsafe\n${'x'.repeat(100)}`,
      lastFetchedAt: null,
      lastNegotiatedAt: null,
    };
    const text = String((await call(mod, 'mcpl_list')).data);
    expect(text).toContain('manifest={revision="unsafe\\n');
    expect(text).not.toContain('unsafe\n');
    expect(text).toContain('...",fetchedAt=none,negotiatedAt=none}');
  });

  test("groups each server's tools by effective class and source", async () => {
    const { stub, servers } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'chat', command: 'node' });
    const mod = makeModule(stub);

    // Older framework: no per-server classes reported.
    expect(String((await call(mod, 'mcpl_list')).data)).toContain('classes=unknown');

    servers.get('chat')!.toolClasses = [
      { tool: 'chat--say', serverTool: 'say', class: ['comms'], source: 'server' },
      { tool: 'chat--send', serverTool: 'send', class: ['comms'], source: 'server' },
      { tool: 'chat--upload', serverTool: 'upload', class: ['files', 'comms'], source: 'override' },
      { tool: 'chat--probe', serverTool: 'probe', class: [], source: 'none' },
    ];
    expect(String((await call(mod, 'mcpl_list')).data)).toContain(
      'classes={comms/server: say,send; files+comms/override: upload; unclassed: probe}',
    );

    servers.get('chat')!.toolClasses = [];
    expect(String((await call(mod, 'mcpl_list')).data)).toContain('classes={}');
  });
});

// Since agent-framework scrubs a stdio child's environment, an overlay entry
// that replaces the operator's definition runs without whatever of it the
// entry lacks: a resident's shell came back from mcpl_restart without
// SESSION_SERVER_TOKEN (2026-10-08), the restart reported success, and the
// first call said only "Connection lost". The receipts now say what the host
// knows, by name only.
describe('an overlay entry that replaces the operator definition', () => {
  const operatorShell = {
    id: 'shell',
    command: 'node',
    args: ['/abs/terminal-sessions/mcp-stdio-server.js'],
    env: { SESSION_SERVER_TOKEN: 's3cret-token', SESSION_SERVER_PORT: '3101' },
  };

  /** A host as it boots with the resident's 09-04-style entry: the overlay's
   *  shell is what loaded, in place of the operator's. */
  async function bootWithReplacement(entry: Record<string, unknown> = { command: 'node', args: ['mine.js'], env: { SESSION_SERVER_PORT: '3101' } }) {
    const fw = makeStubFramework();
    saveAgentOverlay(overlayPath, { shell: entry });
    await (fw.stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'shell', command: 'node' });
    const mod = makeModule(fw.stub);
    mod.setOperatorServers([operatorShell, { id: 'discord', command: 'node', env: { DISCORD_TOKEN: 'real' } }]);
    return { ...fw, mod };
  }

  test('mcpl_restart names what it lacks, never a value, and the way back', async () => {
    const { mod } = await bootWithReplacement();

    const result = await call(mod, 'mcpl_restart', { id: 'shell' });

    expect(result.success).toBe(true);
    const text = String(result.data);
    expect(text).toContain('Restarted server "shell" — connected');
    expect(text).toContain(
      'replaces the operator\'s definition of "shell" and lacks its env SESSION_SERVER_TOKEN, ' +
      'so the server, run from your entry, gets none of the operator\'s values for them. Naming a host variable in ' +
      'your entry wouldn\'t fill them in, since only a recipe substitutes those.',
    );
    expect(text).not.toContain('SESSION_SERVER_PORT');
    expect(text).not.toContain('s3cret-token');
    expect(text).toContain('To go back to the operator\'s definition, mcpl-admin--mcpl_unload "shell"');
    expect(text).toContain('the operator\'s loads again at the next host start');
    // The restart reconnects with the last connect's configuration; the note
    // reads the file, so an edit made before that connect is already in it.
    expect(text).toContain(
      'That describes your overlay file as it is now. The restart reconnects with the configuration of the server\'s ' +
      'last connect, at this host\'s start or your last mcpl-admin--mcpl_deploy of it, so a hand edit made since then takes effect ' +
      'at the next host start, unless a later mcpl-admin--mcpl_deploy replaces it.',
    );
  });

  test('mcpl_restart says nothing more when the entry lacks nothing, or replaces nothing', async () => {
    const { mod } = await bootWithReplacement({
      command: 'node',
      env: { SESSION_SERVER_PORT: '3101', SESSION_SERVER_TOKEN: 'its-own' },
    });
    expect(String((await call(mod, 'mcpl_restart', { id: 'shell' })).data)).toBe('Restarted server "shell" — connected, 1 tools.');

    // No operator definitions wired (an older embedding): no claim either way.
    const bare = makeStubFramework();
    await (bare.stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'shell', command: 'node' });
    expect(String((await call(makeModule(bare.stub), 'mcpl_restart', { id: 'shell' })).data))
      .toBe('Restarted server "shell" — connected, 1 tools.');
  });

  test('mcpl_deploy over an operator id says it replaces the definition, and what it lacks', async () => {
    const { mod } = await bootWithReplacement({ command: 'node' });

    const lacking = await call(mod, 'mcpl_deploy', { id: 'shell', command: 'node', args: ['rebuilt.js'] });
    expect(lacking.success).toBe(true);
    expect(String(lacking.data)).toContain(
      'replaces the operator\'s definition of "shell" and lacks its env SESSION_SERVER_PORT, SESSION_SERVER_TOKEN',
    );

    const carrying = await call(mod, 'mcpl_deploy', { id: 'discord', command: 'node', env: { DISCORD_TOKEN: 'mine' } });
    expect(carrying.success).toBe(true);
    expect(String(carrying.data)).toEndWith(' Your overlay entry replaces the operator\'s definition of "discord".');

    const fresh = await call(mod, 'mcpl_deploy', { id: 'mytool', command: 'bun' });
    expect(String(fresh.data)).not.toContain('operator');
  });

  test("mcpl_deploy over an operator server that grants host commands says the entry lacks them", async () => {
    const fw = makeStubFramework();
    const mod = makeModule(fw.stub);
    mod.setOperatorServers([{ id: 'hc', command: 'node', allowHostCommands: true }]);
    const result = await call(mod, 'mcpl_deploy', { id: 'hc', command: 'node', args: ['mine.js'] });
    expect(result.success).toBe(true);
    expect(String(result.data)).toContain(
      'replaces the operator\'s definition of "hc" and lacks its host commands (allowHostCommands)',
    );
  });

  // The likeliest next move after reading that receipt: name the variable in
  // the entry. Only a recipe substitutes it, so the receipt keeps the name
  // in what's lacking and says why, without showing the value.
  test('an entry that names a host variable still lacks it, and is told so', async () => {
    const { mod } = await bootWithReplacement();

    const result = await call(mod, 'mcpl_deploy', {
      id: 'shell',
      command: 'node',
      args: ['mine.js'],
      env: { SESSION_SERVER_PORT: '3101', SESSION_SERVER_TOKEN: '${SESSION_SERVER_TOKEN}' },
    });

    const text = String(result.data);
    expect(text).toContain('lacks its env SESSION_SERVER_TOKEN, so the server, run from your entry, gets none of the operator\'s values for them.');
    expect(text).toContain(
      'Your entry names a host variable in env SESSION_SERVER_TOKEN, and only a recipe substitutes those, ' +
      'so the server gets that text as written.',
    );
    expect(text).not.toContain('${SESSION_SERVER_TOKEN}');
    expect(String((await call(mod, 'mcpl_restart', { id: 'shell' })).data))
      .toContain('Your entry names a host variable in env SESSION_SERVER_TOKEN');
  });

  test('a host-variable reference in an entry that replaces nothing is told on deploy and restart', async () => {
    const { mod } = await bootWithReplacement();

    const deployed = String((await call(mod, 'mcpl_deploy', {
      id: 'weather', command: 'node', args: ['--key', '${WEATHER_KEY}'], env: { WEATHER_UNITS: 'metric' },
    })).data);
    // With no operator's definition to go back to, the way to get the value is the recipe.
    expect(deployed).toEndWith(
      'Your entry names a host variable in args, and only a recipe substitutes those, so the server gets that text as written. ' +
      'If the server needs the variable\'s value, ask your operator to add the server to the recipe, which fills host variables in.',
    );
    expect(deployed).not.toContain('operator\'s definition');
    expect(String((await call(mod, 'mcpl_restart', { id: 'weather' })).data))
      .toContain('Your entry names a host variable in args');
  });

  // Greptile's review of #227: a restart that throws keeps the note, and an
  // overlay file that can't be read costs only the note, never the restart's
  // own outcome or a quote of the file.
  test('a restart that throws still says what the entry lacks', async () => {
    const { stub, mod } = await bootWithReplacement();
    (stub as unknown as { restartMcplServer: () => Promise<void> }).restartMcplServer =
      async () => { throw new Error('spawn ENOENT'); };

    const result = await call(mod, 'mcpl_restart', { id: 'shell' });

    expect(result.success).toBe(false);
    // This stub's restart throws before it changes anything, so the server is still listed as connected.
    expectSays(
      result.error,
      'The restart of "shell" didn\'t complete: spawn ENOENT.', 'It\'s still running as it was',
      'call mcpl-admin--mcpl_restart again',
    );
    expect(result.error).toContain('lacks its env SESSION_SERVER_TOKEN');
  });

  test('an overlay file that can\'t be read leaves the restart\'s own outcome', async () => {
    const { mod } = await bootWithReplacement();
    writeFileSync(overlayPath, '{"mcplServers": {"shell": {"env": {"SECRET": "s3cret-in-file"');

    const result = await call(mod, 'mcpl_restart', { id: 'shell' });

    expect(result.success).toBe(true);
    expectSays(
      result.data,
      'Restarted server "shell" — connected, 1 tools.',
      `Your overlay file, ${overlayPath}, isn't valid JSON, so nothing is said here about your entry, and ` +
      'mcpl-admin--mcpl_deploy and an mcpl-admin--mcpl_unload that persists are refused.',
      'The next host start will stop on the file until it\'s fixed.',
      'Fix the file (or, if you can\'t edit it, ask your operator to).', 'Don\'t move it aside',
    );
    expect(String(result.data)).not.toContain('s3cret');
  });

  test('mcpl_list marks the replacement and what it lacks', async () => {
    const { mod } = await bootWithReplacement();

    const text = String((await call(mod, 'mcpl_list')).data);

    expect(text).toContain('source=agent-overlay (replaces the operator\'s definition; lacks its env SESSION_SERVER_TOKEN)');
    expect(text).not.toContain('s3cret-token');
  });

  test('mcpl_list credits the overlay only with an entry that put a server in place', async () => {
    // Neither command nor url: the boot skips this entry, so the live
    // server is the operator's (applyAgentOverlay / resolveOverlayEntry).
    const { mod } = await bootWithReplacement({ env: { SESSION_SERVER_TOKEN: 'x' } });

    const text = String((await call(mod, 'mcpl_list')).data);

    expect(text).toContain('source=recipe');
    expect(text).not.toContain('source=agent-overlay');
  });

  test('mcpl_unload of a replacement says the operator definition loads again at the next start', async () => {
    const { mod } = await bootWithReplacement();

    const result = await call(mod, 'mcpl_unload', { id: 'shell' });

    expect(result.success).toBe(true);
    expect(String(result.data)).toContain('the operator\'s definition of "shell" loads again at the next host start');
    expect(readAgentOverlay(overlayPath).shell).toBeUndefined();
  });
});

describe('restart and deploy report the connection they read', () => {
  test('mcpl_restart fails when the server is not connected afterwards', async () => {
    const { stub, servers } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; url: string }) => Promise<void> })
      .connectMcplServer({ id: 'world', url: 'wss://w/mcpl' });
    const restart = (stub as unknown as { restartMcplServer: (id: string) => Promise<void> }).restartMcplServer;
    (stub as unknown as { restartMcplServer: (id: string) => Promise<void> }).restartMcplServer = async (id) => {
      await restart(id);
      Object.assign(servers.get(id)!, { connected: false, retrying: true });
    };
    const mod = makeModule(stub);

    const result = await call(mod, 'mcpl_restart', { id: 'world' });

    expect(result.success).toBe(false);
    // A restart reconnects with the last connect's configuration, so a wrong command is a deploy's to fix.
    expectSays(
      result.error,
      'Restarted server "world", but it isn\'t connected', 'it keeps retrying on its own, so it may still connect, which ' +
      'mcpl-admin--mcpl_list shows', 'If its command, args or url is wrong, call mcpl-admin--mcpl_deploy with each of its ' +
      'fields, the wrong one corrected, since a deploy replaces the entry whole;',
      'call mcpl-admin--mcpl_restart once it\'s fixed', 'mcpl-admin--mcpl_unload unloads it',
    );
  });

  // A server the operator defines is theirs to correct: its args and env
  // never reach the agent, so a deploy would replace their definition with less.
  test("a restart that leaves the operator's server down says its definition is theirs to correct", async () => {
    const { stub, servers } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'op', command: 'operator-server' });
    const restart = (stub as unknown as { restartMcplServer: (id: string) => Promise<void> }).restartMcplServer;
    (stub as unknown as { restartMcplServer: (id: string) => Promise<void> }).restartMcplServer = async (id) => {
      await restart(id);
      Object.assign(servers.get(id)!, { connected: false });
    };
    const mod = makeModule(stub);
    mod.setOperatorServers([{ id: 'op', command: 'operator-server', args: ['--port', '1'] }]);
    const result = String((await call(mod, 'mcpl_restart', { id: 'op' })).error);
    expectSays(
      result, 'Restarted server "op", but it isn\'t connected.',
      'If its command, args or url is wrong, that\'s your operator\'s definition to correct, so ask them: its args and env ' +
      'aren\'t shown to you, and mcpl-admin--mcpl_deploy would replace it whole with your own entry; if the server itself ' +
      'needs fixing (its build, say), call mcpl-admin--mcpl_restart once it\'s fixed. mcpl-admin--mcpl_unload unloads it.',
    );
    expect(result).not.toContain('with each of its fields');
    // A restart that throws and leaves it down says the same.
    (stub as unknown as { restartMcplServer: (id: string) => Promise<void> }).restartMcplServer = async (id) => {
      Object.assign(servers.get(id)!, { connected: false });
      throw new Error('handshake timed out');
    };
    expectSays(
      String((await call(mod, 'mcpl_restart', { id: 'op' })).error),
      'The restart of "op" didn\'t complete: handshake timed out. It isn\'t connected.',
      'If its command, args or url is wrong, that\'s your operator\'s definition to correct, so ask them',
    );
    // A malformed entry of the agent's replaces nothing: the boot skips it, so
    // the operator's definition is what runs.
    saveAgentOverlay(overlayPath, { op: { toolPrefix: 'y' } });
    expectSays(
      String((await call(mod, 'mcpl_restart', { id: 'op' })).error),
      'If its command, args or url is wrong, that\'s your operator\'s definition to correct, so ask them',
    );
    // Once the agent's own entry replaces it, that entry is the agent's to correct.
    saveAgentOverlay(overlayPath, { op: { command: 'mine' } });
    expectSays(
      String((await call(mod, 'mcpl_restart', { id: 'op' })).error),
      'If its command, args or url is wrong, call mcpl-admin--mcpl_deploy with each of its fields, the wrong one corrected',
    );
  });

  // With the overlay unreadable, which defines the server isn't known, and a
  // deploy is refused until the file can be read.
  test("a restart that leaves a server down while the overlay can't be read puts the deploy off until it can", async () => {
    const { stub, servers } = makeStubFramework();
    const mod = makeModule(stub);
    await call(mod, 'mcpl_deploy', { id: 'tool', command: 'node' });
    const restart = (stub as unknown as { restartMcplServer: (id: string) => Promise<void> }).restartMcplServer;
    (stub as unknown as { restartMcplServer: (id: string) => Promise<void> }).restartMcplServer = async (id) => {
      await restart(id);
      Object.assign(servers.get(id)!, { connected: false });
    };
    writeFileSync(overlayPath, '{ not json');
    const result = String((await call(mod, 'mcpl_restart', { id: 'tool' })).error);
    expectSays(
      result, 'Restarted server "tool", but it isn\'t connected.',
      'If its command, args or url is wrong, mcpl-admin--mcpl_deploy with each of its fields corrects it once your overlay ' +
      'file can be read; if the server itself needs fixing',
      'and mcpl-admin--mcpl_deploy and an mcpl-admin--mcpl_unload that persists are refused.',
      // An unload that persists is refused then, so the step is for this session.
      'mcpl-admin--mcpl_unload with `persist: false` unloads it for this session.',
    );
    expect(result).not.toContain('call mcpl-admin--mcpl_deploy with each of its fields');
    expect(result).not.toContain('mcpl-admin--mcpl_unload unloads it.');
    // A restart that throws and leaves it down, still listed, says the same.
    (stub as unknown as { restartMcplServer: (id: string) => Promise<void> }).restartMcplServer = async (id) => {
      Object.assign(servers.get(id)!, { connected: false });
      throw new Error('handshake timed out');
    };
    expectSays(
      String((await call(mod, 'mcpl_restart', { id: 'tool' })).error),
      'The restart of "tool" didn\'t complete: handshake timed out. It isn\'t connected.',
      'If its command, args or url is wrong, mcpl-admin--mcpl_deploy with each of its fields corrects it once your overlay ' +
      'file can be read', 'mcpl-admin--mcpl_unload with `persist: false` unloads it for this session.',
    );
  });

  // For a server the operator also defines, whether the agent's own entry
  // replaces theirs is the overlay's to say, so with it unreadable both steps
  // are given, each by what defines the server.
  test("a restart that leaves the operator's server down while the overlay can't be read gives the step for each", async () => {
    const { stub, servers } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'op', command: 'operator-server' });
    const restart = (stub as unknown as { restartMcplServer: (id: string) => Promise<void> }).restartMcplServer;
    (stub as unknown as { restartMcplServer: (id: string) => Promise<void> }).restartMcplServer = async (id) => {
      await restart(id);
      Object.assign(servers.get(id)!, { connected: false });
    };
    const mod = makeModule(stub);
    mod.setOperatorServers([{ id: 'op', command: 'operator-server', args: ['--port', '1'] }]);
    writeFileSync(overlayPath, '{ not json');
    const result = String((await call(mod, 'mcpl_restart', { id: 'op' })).error);
    expectSays(
      result, 'Restarted server "op", but it isn\'t connected.',
      'If its command, args or url is wrong, what corrects it depends on which defines it, which mcpl-admin--mcpl_list ' +
      'shows once your overlay file can be read: your own entry takes mcpl-admin--mcpl_deploy with each of its fields; ' +
      'your operator\'s definition is theirs to correct, so ask them, since its args and env aren\'t shown to you, and ' +
      'mcpl-admin--mcpl_deploy would replace it whole with your own entry. If the server itself needs fixing (its build, ' +
      'say), call mcpl-admin--mcpl_restart once it\'s fixed. mcpl-admin--mcpl_unload with `persist: false` unloads it for ' +
      'this session.',
    );
    expect(result).not.toContain('corrects it once your overlay file can be read');
  });

  test("mcpl_deploy's description says a deploy replaces the entry whole", () => {
    const deploy = makeModule(makeStubFramework().stub).getTools().find((t) => t.name === 'mcpl_deploy')!;
    expect(deploy.description).toContain(
      'A deploy replaces the server\'s entry whole, so give each of its fields every time, not only the one you change.',
    );
  });

  test('mcpl_deploy fails, keeping the entry, when the connect resolves without a connection', async () => {
    const { stub, servers } = makeStubFramework();
    const connect = (stub as unknown as { connectMcplServer: (c: { id: string }) => Promise<void> }).connectMcplServer;
    (stub as unknown as { connectMcplServer: (c: { id: string }) => Promise<void> }).connectMcplServer = async (config) => {
      await connect(config);
      Object.assign(servers.get(config.id)!, { connected: false, retrying: true });
    };
    const mod = makeModule(stub);

    const result = await call(mod, 'mcpl_deploy', { id: 'world', url: 'wss://down/mcpl' });

    expect(result.success).toBe(false);
    expectSays(
      result.error,
      'Server "world" was saved to your overlay, but it isn\'t connected', 'it keeps retrying on its own',
      'call mcpl-admin--mcpl_deploy with each of its fields, the wrong one corrected', 'call mcpl-admin--mcpl_restart once ' +
      'it\'s fixed', 'mcpl-admin--mcpl_unload unloads it',
    );
    expect(readAgentOverlay(overlayPath).world).toEqual({ url: 'wss://down/mcpl', transport: 'websocket' });
  });

  // agent-framework restarts only a server it holds a configuration for, and
  // a connect that failed keeps its configuration, listed as down or retrying.
  test('mcpl_restart reaches a configured server that is down or retrying', async () => {
    const { stub, servers, calls } = makeStubFramework();
    const mod = makeModule(stub);
    await call(mod, 'mcpl_deploy', { id: 'down', command: 'node' });
    await call(mod, 'mcpl_deploy', { id: 'retrying', url: 'wss://w/mcpl' });
    Object.assign(servers.get('down')!, { connected: false, retrying: false });
    Object.assign(servers.get('retrying')!, { connected: false, retrying: true });
    for (const id of ['down', 'retrying']) {
      expect((await call(mod, 'mcpl_restart', { id })).success).toBe(true);
    }
    expect(calls).toEqual(['connect:down', 'connect:retrying', 'restart:down', 'restart:retrying']);
  });
});

// agent-framework can leave a server running its previous configuration, with
// no configuration, or configured but down, so each failure says the state it
// reads afterwards, with the step that state allows.
describe('a failed connect or restart says the state it left', () => {
  type Stub = Record<string, (...args: never[]) => unknown>;

  // A deploy whose connect throws, and whose listing then throws too, can't
  // read the state the server is left in, so it says that it's unknown.
  test('a deploy whose state can\'t be read after a failed connect says so, then the listing and the operator', async () => {
    const { stub } = makeStubFramework();
    const list = (stub as unknown as Stub).listMcplServers as () => unknown[];
    let broken = false;
    (stub as unknown as Stub).listMcplServers = () => {
      if (broken) throw new Error('the framework is stopping');
      return list();
    };
    (stub as unknown as Stub).connectMcplServer = async () => {
      broken = true;
      throw new Error('the awareness ledger can\'t be read');
    };
    const mod = makeModule(stub);
    expectSays(
      String((await call(mod, 'mcpl_deploy', { id: 'tool', command: 'node' })).error),
      'Server "tool" was saved to your overlay, but connecting it failed: the awareness ledger can\'t be read.',
      'What state it\'s in now couldn\'t be read: mcpl-admin--mcpl_list shows it, and if that fails too, ask your operator.',
    );
    expect(readAgentOverlay(overlayPath).tool).toEqual({ command: 'node' });
  });

  test('a redeploy whose restart fails before it disconnects: the old configuration still runs', async () => {
    const { stub } = makeStubFramework();
    const mod = makeModule(stub);
    await call(mod, 'mcpl_deploy', { id: 'tool', command: 'node' });
    (stub as unknown as Stub).restartMcplServer = async () => { throw new Error('the awareness ledger can\'t be read'); };
    const result = await call(mod, 'mcpl_deploy', { id: 'tool', command: 'bun' });
    expectSays(
      result.error,
      'Server "tool" was saved to your overlay, but restarting it with that entry failed: the awareness ledger can\'t be read.',
      'It\'s still running its previous configuration: your new entry is saved, and the next host start loads it, but ' +
      'it isn\'t in effect now.', 'Once the cause is fixed, call mcpl-admin--mcpl_deploy again to apply it.',
    );
  });

  test('a connect that fails before agent-framework stores it: a restart can\'t reach it, a deploy can', async () => {
    const { stub, servers } = makeStubFramework();
    const mod = makeModule(stub);
    // As connectMcplServerInternal refuses before it stores the configuration.
    (stub as unknown as Stub).connectMcplServer = async () => {
      throw new Error('the awareness ledger can\'t be read');
    };
    const result = await call(mod, 'mcpl_deploy', { id: 'tool', command: 'node' });
    expectSays(
      result.error, 'but connecting it failed: the awareness ledger can\'t be read.',
      'It isn\'t loaded in this session, so mcpl-admin--mcpl_restart can\'t reach it',
      'Your entry is saved, so the next host start loads it',
      'once the cause is fixed, call mcpl-admin--mcpl_deploy again to load it now', 'mcpl-admin--mcpl_unload removes the saved entry',
    );
    expect(result.error).not.toContain('call mcpl-admin--mcpl_restart once');
    expect(servers.has('tool')).toBe(false);
  });

  // After a failed deploy, which configuration a down server holds depends
  // on where agent-framework stopped, so the step is a deploy, never a
  // restart, which could reconnect the previous one.
  test('a connect that fails once stored: it\'s down, and a deploy, not a restart, applies the entry', async () => {
    const { stub, servers } = makeStubFramework();
    const mod = makeModule(stub);
    const connect = (stub as unknown as { connectMcplServer: (c: { id: string }) => Promise<void> }).connectMcplServer;
    (stub as unknown as Stub).connectMcplServer = async (config: { id: string }) => {
      await connect(config);
      Object.assign(servers.get(config.id)!, { connected: false });
      throw new Error('spawn ENOENT');
    };
    const result = (await call(mod, 'mcpl_deploy', { id: 'tool', command: 'nope' })).error;
    expectSays(
      result, 'but connecting it failed: spawn ENOENT.', 'It isn\'t connected.',
      'Your entry is saved, and the next host start loads it; once the cause is fixed, call mcpl-admin--mcpl_deploy ' +
      'again to apply it now.', 'mcpl-admin--mcpl_unload unloads it.',
    );
    expect(result).not.toContain('mcpl-admin--mcpl_restart once');
  });

  test('a redeploy of a down server whose restart fails before its disconnect: a deploy applies the entry', async () => {
    const { stub, servers } = makeStubFramework();
    const mod = makeModule(stub);
    await call(mod, 'mcpl_deploy', { id: 'tool', command: 'node' });
    Object.assign(servers.get('tool')!, { connected: false, retrying: true });
    (stub as unknown as Stub).restartMcplServer = async () => { throw new Error('the awareness ledger can\'t be read'); };
    const result = (await call(mod, 'mcpl_deploy', { id: 'tool', command: 'bun' })).error;
    expectSays(
      result, 'but restarting it with that entry failed: the awareness ledger can\'t be read.',
      'It isn\'t connected; it keeps retrying on its own, so it may still connect, which mcpl-admin--mcpl_list shows.',
      'Your entry is saved, and the next host start loads it; once the cause is fixed, call mcpl-admin--mcpl_deploy ' +
      'again to apply it now.',
    );
    expect(result).not.toContain('mcpl-admin--mcpl_restart once');
  });

  // One state, one piece of advice: a restart that leaves the id unloaded
  // says what the restart refusal says for an id that isn't loaded.
  test('a restart that fails after the disconnect: no longer loaded, with the advice for what defines it', async () => {
    const { stub, servers } = makeStubFramework();
    const mod = makeModule(stub);
    mod.setOperatorServers([{ id: 'discord', command: 'node' }, { id: 'world', command: 'node' }]);
    await call(mod, 'mcpl_deploy', { id: 'tool', command: 'node' });
    for (const id of ['discord', 'stray']) {
      await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
        .connectMcplServer({ id, command: 'node' });
    }
    (stub as unknown as Stub).restartMcplServer = async (id: string) => {
      servers.delete(id);
      throw new Error('the awareness ledger can\'t be read');
    };
    const restart = async (id: string) => String((await call(mod, 'mcpl_restart', { id })).error);
    const lead = (id: string) => [
      `The restart of "${id}" didn't complete: the awareness ledger can't be read.`,
      'It isn\'t loaded in this session any more, so mcpl-admin--mcpl_restart can\'t reach it.',
    ];
    expectSays(
      await restart('tool'), ...lead('tool'),
      'Your overlay has an entry for "tool", so the next host start loads it; mcpl-admin--mcpl_deploy with each of its ' +
      'fields loads it now, since a deploy replaces the entry whole.',
    );
    expectSays(
      await restart('discord'), ...lead('discord'),
      'Your operator defines "discord", so the next host start loads it again; mcpl-admin--mcpl_deploy would load ' +
      'your own entry in its place now.',
    );
    expectSays(await restart('stray'), ...lead('stray'), 'Neither your overlay nor your operator defines "stray".');
  });

  // The overlay note for a tombstoned or malformed entry is the restart's to
  // say, once, not said again as the advice for an id no longer loaded.
  test('a restart that fails after the disconnect, with a tombstoned or malformed entry: its note once', async () => {
    const { stub, servers } = makeStubFramework();
    const mod = makeModule(stub);
    mod.setOperatorServers([{ id: 'discord', command: 'node' }, { id: 'world', command: 'node' }]);
    for (const id of ['discord', 'world']) {
      await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
        .connectMcplServer({ id, command: 'node' });
    }
    saveAgentOverlay(overlayPath, { discord: { disabled: true }, world: { toolPrefix: 'y' } });
    (stub as unknown as Stub).restartMcplServer = async (id: string) => {
      servers.delete(id);
      throw new Error('the awareness ledger can\'t be read');
    };
    const times = (text: string, part: string) => text.split(part).length - 1;
    const tombstoned = String((await call(mod, 'mcpl_restart', { id: 'discord' })).error);
    expectSays(tombstoned, 'It isn\'t loaded in this session any more', 'Your overlay tombstones "discord"');
    expect(times(tombstoned, 'Your overlay tombstones "discord"')).toBe(1);
    const malformed = String((await call(mod, 'mcpl_restart', { id: 'world' })).error);
    expectSays(malformed, 'Your overlay entry for "world" is malformed (it names no command to run and no url to dial)');
    expect(times(malformed, 'is malformed')).toBe(1);
  });

  // A deploy reads the overlay before it saves, so it can't load the server
  // while the file is unreadable.
  test('a restart that fails after the disconnect, with the overlay unreadable: a deploy once the file can be read', async () => {
    const { stub, servers } = makeStubFramework();
    const mod = makeModule(stub);
    await call(mod, 'mcpl_deploy', { id: 'tool', command: 'node' });
    writeFileSync(overlayPath, '{ "mcplServers": ');
    (stub as unknown as Stub).restartMcplServer = async (id: string) => {
      servers.delete(id);
      throw new Error('the awareness ledger can\'t be read');
    };
    const result = String((await call(mod, 'mcpl_restart', { id: 'tool' })).error);
    expectSays(
      result, 'It isn\'t loaded in this session any more, so mcpl-admin--mcpl_restart can\'t reach it.',
      'mcpl-admin--mcpl_deploy with each of its fields can load it again once your overlay file can be read, since a ' +
      'deploy replaces the entry whole.',
      `Your overlay file, ${overlayPath}, isn't valid JSON, so nothing is said here about your entry, and ` +
      'mcpl-admin--mcpl_deploy and an mcpl-admin--mcpl_unload that persists are refused.',
      'Fix the file (or, if you can\'t edit it, ask your operator to).',
    );
    expect(result).not.toContain('loads it now');
  });

  // For a server the operator also defines, whether the agent's own entry
  // replaces theirs isn't known while the overlay can't be read, so both are
  // said, as the readable overlay's advice says each.
  test("a restart that fails after the disconnect of the operator's server, with the overlay unreadable: the step for each", async () => {
    const { stub, servers } = makeStubFramework();
    const mod = makeModule(stub);
    mod.setOperatorServers([{ id: 'op', command: 'operator-server', args: ['--port', '1'] }]);
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'op', command: 'operator-server' });
    writeFileSync(overlayPath, '{ "mcplServers": ');
    (stub as unknown as Stub).restartMcplServer = async (id: string) => {
      servers.delete(id);
      throw new Error('the awareness ledger can\'t be read');
    };
    const result = String((await call(mod, 'mcpl_restart', { id: 'op' })).error);
    expectSays(
      result, 'It isn\'t loaded in this session any more, so mcpl-admin--mcpl_restart can\'t reach it.',
      'Which defines it isn\'t known while your overlay file can\'t be read. Once it can, mcpl-admin--mcpl_list shows ' +
      'your own entry for it, if there is one, which mcpl-admin--mcpl_deploy with each of its fields loads again; ' +
      'otherwise your operator\'s definition loads again at the next host start, unless your overlay unloads it, and ' +
      'mcpl-admin--mcpl_deploy would load your own entry in its place.',
    );
    expect(result).not.toContain('can load it again once your overlay file can be read');
  });

  // A file that can't be read at all, not only one that isn't an overlay,
  // stops the next start too, and its repair is the operator's.
  test('a restart with an overlay that can\'t be read at all says the next start stops on it, and whom to ask', async () => {
    const { stub } = makeStubFramework();
    const mod = makeModule(stub);
    await call(mod, 'mcpl_deploy', { id: 'tool', command: 'node' });
    rmSync(overlayPath);
    mkdirSync(overlayPath);
    const restarted = await call(mod, 'mcpl_restart', { id: 'tool' });
    expect(restarted.success).toBe(true);
    expectSays(
      restarted.data, 'Restarted server "tool"', `Your overlay file, ${overlayPath}, couldn't be read (`, 'EISDIR',
      '), so nothing is said here about your entry, and mcpl-admin--mcpl_deploy and an mcpl-admin--mcpl_unload that ' +
      'persists are refused. The next host start will stop on the file while it can\'t be read. Ask your operator to fix ' +
      'it.',
    );
  });

  test('a restart that throws while the server keeps retrying says so, with the remedy for one that won\'t connect', async () => {
    const { stub, servers } = makeStubFramework();
    const mod = makeModule(stub);
    await call(mod, 'mcpl_deploy', { id: 'tool', command: 'node' });
    (stub as unknown as Stub).restartMcplServer = async (id: string) => {
      Object.assign(servers.get(id)!, { connected: false, retrying: true });
      throw new Error('handshake timed out');
    };
    expectSays(
      String((await call(mod, 'mcpl_restart', { id: 'tool' })).error),
      'The restart of "tool" didn\'t complete: handshake timed out.',
      'It isn\'t connected; it keeps retrying on its own, so it may still connect, which mcpl-admin--mcpl_list shows.',
      'If its command, args or url is wrong, call mcpl-admin--mcpl_deploy with each of its fields, the wrong one corrected',
      'call mcpl-admin--mcpl_restart once it\'s fixed',
    );
  });

  test('a state that can\'t be read after the failure is said to be so, with the listing and then the operator', async () => {
    const { stub } = makeStubFramework();
    const mod = makeModule(stub);
    await call(mod, 'mcpl_deploy', { id: 'tool', command: 'node' });
    const list = (stub as unknown as { listMcplServers: () => unknown[] }).listMcplServers;
    (stub as unknown as Stub).restartMcplServer = async () => {
      (stub as unknown as Stub).listMcplServers = () => { throw new Error('registry gone'); };
      throw new Error('stopped');
    };
    expectSays(
      (await call(mod, 'mcpl_restart', { id: 'tool' })).error,
      'What state it\'s in now couldn\'t be read: mcpl-admin--mcpl_list shows it, and if that fails too, ask your operator.',
    );
    // The listing reads the state the same way, so it fails too here: why the operator follows.
    expect((await call(mod, 'mcpl_list')).success).toBe(false);
    (stub as unknown as Stub).listMcplServers = list;
  });

  // The catch-all's "nothing was changed" comes from the call's own record.
  test('a throw after a change says the call failed partway, not that nothing changed', async () => {
    const { stub } = makeStubFramework();
    const mod = makeModule(stub);
    const list = (stub as unknown as { listMcplServers: () => unknown[] }).listMcplServers;
    // The first listing once the overlay holds the entry throws: that throw follows a change.
    let thrown = false;
    (stub as unknown as Stub).listMcplServers = () => {
      if (!thrown && readAgentOverlay(overlayPath).tool) {
        thrown = true;
        throw new Error('registry gone');
      }
      return list();
    };
    const result = (await call(mod, 'mcpl_deploy', { id: 'tool', command: 'node' })).error;
    expectSays(
      result, 'mcpl-admin--mcpl_deploy failed partway: registry gone.', 'What it changed before then stays changed',
      'mcpl-admin--mcpl_list shows each server\'s state',
    );
    expect(result).not.toContain('nothing was changed');
    expect(readAgentOverlay(overlayPath).tool).toEqual({ command: 'node' });
  });

  // A restart sets the record before it runs, so a throw in the listing
  // after it is a failure partway too.
  test('a throw in the listing after a restart says the restart failed partway', async () => {
    const { stub } = makeStubFramework();
    const mod = makeModule(stub);
    await call(mod, 'mcpl_deploy', { id: 'tool', command: 'node' });
    const list = (stub as unknown as { listMcplServers: () => unknown[] }).listMcplServers;
    const restart = (stub as unknown as { restartMcplServer: (id: string) => Promise<void> }).restartMcplServer;
    (stub as unknown as Stub).restartMcplServer = async (id: string) => {
      await restart(id);
      (stub as unknown as Stub).listMcplServers = () => { throw new Error('registry gone'); };
    };
    const result = String((await call(mod, 'mcpl_restart', { id: 'tool' })).error);
    (stub as unknown as Stub).listMcplServers = list;
    expectSays(
      result, 'mcpl-admin--mcpl_restart failed partway: registry gone.', 'What it changed before then stays changed',
    );
    expect(result).not.toContain('nothing was changed');
  });
});

// A restart of an id that isn't loaded is refused before agent-framework is
// asked, with the next step by what defines the id.
describe('a restart of an id that isn\'t loaded', () => {
  test('says what defines it and what loads it, and no reconnect sentence', async () => {
    const { stub, calls } = makeStubFramework();
    const mod = makeModule(stub);
    mod.setOperatorServers([{ id: 'chat', command: 'node' }]);
    saveAgentOverlay(overlayPath, { mine: { command: 'node' }, chat: { command: 'bun' } });
    const mine = (await call(mod, 'mcpl_restart', { id: 'mine' })).error;
    expectSays(
      mine, 'Nothing was restarted: no server "mine" is loaded in this session.', 'None is loaded.',
      'Your overlay has an entry for "mine", so the next host start loads it; mcpl-admin--mcpl_deploy with each of its ' +
      'fields loads it now, since a deploy replaces the entry whole.',
    );
    // The entry replacing the operator's is the overlay's, so it's said the same way, with no restart that ran.
    const chat = (await call(mod, 'mcpl_restart', { id: 'chat' })).error;
    expectSays(chat, 'Your overlay has an entry for "chat"');
    expect(chat).not.toContain('last connect');
    saveAgentOverlay(overlayPath, {});
    expectSays(
      (await call(mod, 'mcpl_restart', { id: 'chat' })).error,
      'Your operator defines "chat", so the next host start loads it again; mcpl-admin--mcpl_deploy would load your own entry in its place now.',
    );
    expectSays((await call(mod, 'mcpl_restart', { id: 'nobody' })).error, 'Neither your overlay nor your operator defines "nobody".');
    expect(calls).toEqual([]);
  });
});

// What the agent reads when a call fails: which tool, whether anything
// changed, and what to do, with the tools named as the agent calls them.
describe('a failed call says what changed and what to do', () => {
  test('a tool the module lacks is answered with the tools it has, as tools or as utilities, by the recipe surface', async () => {
    const { stub } = makeStubFramework();
    const all = ['mcpl-admin--mcpl_list', 'mcpl-admin--mcpl_deploy', 'mcpl-admin--mcpl_restart', 'mcpl-admin--mcpl_unload'];
    const asTools = (await call(makeModule(stub), 'mcpl_status')).error;
    expectSays(asTools, 'There\'s no tool "mcpl-admin--mcpl_status", so nothing ran', 'tools are', ...all);
    expect(asTools).not.toContain('utils');
    const utilities = new McplAdminModule({ overlayPath, configPath: join(dir, 'mcpl-servers.json'), surface: 'utilities' });
    utilities.setFramework(stub);
    expectSays((await call(utilities, 'mcpl_status')).error, 'no tool "mcpl-admin--mcpl_status"', 'utilities are', ...all, 'utils');
  });

  // index.ts wires the framework before it starts, so a call meets none only
  // after stop(), at shutdown or a session switch, and calling again can't help.
  test('after the module stops, each tool says the tools have stopped and nothing changed, with no retry advice', async () => {
    const { stub, calls } = makeStubFramework();
    const mod = makeModule(stub);
    await mod.stop();
    const why = ['the MCPL admin tools have stopped, so they can\'t act'];
    // Listing changes nothing whatever happens, so it says only that it failed.
    const listed = String((await call(mod, 'mcpl_list')).error);
    expectSays(listed, 'mcpl-admin--mcpl_list failed: ', ...why);
    expect(listed).not.toContain('nothing was changed');
    expect(listed.toLowerCase()).not.toContain('try again');
    for (const name of ['mcpl_deploy', 'mcpl_restart', 'mcpl_unload']) {
      const text = String((await call(mod, name, { id: 'x', command: 'node' })).error);
      expectSays(text, `mcpl-admin--${name} failed, and nothing was changed: `, ...why);
      expect(text.toLowerCase()).not.toContain('try again');
    }
    expect(calls).toEqual([]);
    expect(existsSync(overlayPath)).toBe(false);
  });

  test("an overlay that isn't JSON, or holds null, refuses a deploy and leaves the listing, said to the agent, with nothing saved or connected", async () => {
    const { stub, calls } = makeStubFramework();
    const mod = makeModule(stub);
    const notAside = 'Don\'t move it aside: the operator\'s servers you unloaded would load again, and your deployments would be dropped.';
    for (const [text, problem] of [['{ not json', "isn't valid JSON"], ['null', 'holds null, not an object with mcplServers']] as const) {
      writeFileSync(overlayPath, text);
      const deployed = (await call(mod, 'mcpl_deploy', { id: 'mytool', command: 'node' })).error;
      expectSays(
        deployed,
        `Nothing was deployed or saved: your overlay file, ${overlayPath}, ${problem}, so your entry can't be saved in it.`,
        'The next host start will stop on the file until it\'s fixed.',
        'Fix the file (or, if you can\'t edit it, ask your operator to), then call mcpl-admin--mcpl_deploy again.', notAside,
      );
      expect(deployed).not.toContain('the agent overlay');
      // A deploy can't add a server until the file is fixed, so the empty
      // listing doesn't offer one.
      expect((await call(mod, 'mcpl_list')).data).toBe(
        `No MCPL servers are loaded.\nYour overlay file, ${overlayPath}, ${problem}, so this list can't show your ` +
        'overlay\'s own entries, or which servers they define. The next host start will stop on the file until it\'s ' +
        `fixed. Fix the file (or, if you can't edit it, ask your operator to). ${notAside}`,
      );
      expect(readFileSync(overlayPath, 'utf-8')).toBe(text);
    }
    expect(calls).toEqual([]);
    // The boot, which stops on the file, keeps the operator's words.
    expect(() => readAgentOverlay(overlayPath))
      .toThrow(`the agent overlay ${overlayPath} isn't an object with mcplServers: fix it`);
  });

  // The overlay's save has an outcome of its own: nothing deployed, and no
  // server connected or restarted.
  test('a deploy whose overlay save fails says nothing was deployed, and connects nothing', async () => {
    const { stub, calls } = makeStubFramework();
    const mod = makeModule(stub);
    // A link into a directory that doesn't exist: nothing to read, and the write fails.
    symlinkSync(join(dir, 'missing', 'overlay.json'), overlayPath);
    const result = await call(mod, 'mcpl_deploy', { id: 'mytool', command: 'node' });
    expectSays(
      result.error, `Nothing was deployed: saving your overlay file, ${overlayPath}, failed (ENOENT`,
      'so no server was connected or restarted. Ask your operator to fix it, then call mcpl-admin--mcpl_deploy again.',
    );
    // A failure at the open writes nothing, so nothing is said of a file cut short.
    expect(result.error).not.toContain('cut short');
    expect(calls).toEqual([]);
  });

  // A failure that may have come after the open (ENOSPC, EDQUOT, EFBIG, EIO,
  // or a code not known to come before anything is written) may leave the
  // file old, new or cut short, so neither save says which.
  test('a save that may have stopped partway says the file is unknown, for a deploy and for an unload', async () => {
    const partway = (code: string) => Object.assign(new Error(`${code}: the write failed`), { code });
    for (const code of ['ENOSPC', 'EDQUOT', 'EFBIG', 'EIO', 'ETIMEDOUT']) {
      const { stub, calls } = makeStubFramework();
      const mod = makeModule(stub);
      await call(mod, 'mcpl_deploy', { id: 'kept', command: 'node' });
      const save = spyOn(mcplConfig, 'saveAgentOverlay').mockImplementation(() => { throw partway(code); });
      let deployed: string;
      let afterDeploy: string[];
      let unloaded: string;
      try {
        deployed = String((await call(mod, 'mcpl_deploy', { id: 'mytool', command: 'node' })).error);
        afterDeploy = [...calls];
        unloaded = String((await call(mod, 'mcpl_unload', { id: 'kept' })).error);
      } finally {
        save.mockRestore();
      }
      const unknown = [
        'What your overlay file holds now isn\'t known: its old content, the new content whole, or the new content cut short.',
        'mcpl-admin--mcpl_list shows the entries it holds, or why it can\'t be read. If it says the file isn\'t valid JSON, ' +
        'the next host start will stop on it until it\'s fixed: fix the file (or, if you can\'t edit it, ask your operator to).',
      ];
      // The file is named, since an error from the write itself needn't name it.
      expectSays(
        deployed, `Saving your overlay file, ${overlayPath}, failed (${code}: the write failed), so no server was connected or ` +
        'restarted.', ...unknown,
      );
      // The new entry may be in the file whole, so the reply doesn't say nothing was deployed.
      expect(deployed).not.toContain('Nothing was deployed');
      // The failed save connected nothing.
      expect(afterDeploy).toEqual(['connect:kept']);
      expectSays(
        unloaded, `But saving your overlay file, ${overlayPath}, failed (${code}: the write failed).`, ...unknown,
        'If the file doesn\'t hold the unload, mcpl-admin--mcpl_unload "kept" again records it once the file can be read and written.',
      );
      // What the next start loads depends on what the file holds, so it isn't said.
      expect(unloaded).not.toContain('next host start loads');
      expect(unloaded).not.toContain('isn\'t recorded');
    }
  });

  // The operator's file decides only the label of a server the overlay
  // doesn't define, so the listing goes on without it.
  test("an operator's server file that isn't JSON leaves the listing with what it decides unknown, naming the file and never quoting it", async () => {
    const { stub } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'chat', command: 'node' });
    const mod = makeModule(stub);
    const configPath = join(dir, 'mcpl-servers.json');
    writeFileSync(configPath, '{ "mcplServers": { "chat": { "env": { "TOKEN": s3cret } } } }');
    expect((await call(mod, 'mcpl_deploy', { id: 'mytool', command: 'node' })).success).toBe(true);
    const fileLine = (problem: string) =>
      `The operator's server file couldn't be read (${configPath} ${problem}), so this list can't show which servers it ` +
      'defines. The next host start will stop on the file until it\'s fixed, before it loads any server, so what this ' +
      'list says a start loads holds once a start gets past the file, if the file still defines what it did at this host\'s ' +
      'start. It\'s theirs to fix, so ask your operator. Of these tools, only this listing reads it.';
    const listed = String((await call(mod, 'mcpl_list')).data);
    expectSays(
      listed, 'MCPL servers (2):\n', 'source=unknown, node', 'prefix=mcpl--mytool, source=agent-overlay, node',
      `\n${fileLine('isn\'t valid JSON')}`,
    );
    expect(listed).not.toContain('s3cret');
    // A root of null is named too.
    writeFileSync(configPath, 'null');
    expect(String((await call(mod, 'mcpl_list')).data)).toEndWith(`\n${fileLine('holds null, not an object with mcplServers')}`);
    // With the overlay unreadable too, each file's line says what it can't show.
    writeFileSync(overlayPath, '{ not json');
    const both = String((await call(mod, 'mcpl_list')).data);
    expect(both.split('source=unknown').length - 1).toBe(2);
    expectSays(
      both,
      `\nYour overlay file, ${overlayPath}, isn't valid JSON, so this list can't show your overlay's own entries, or which ` +
      'servers they define.',
      `\n${fileLine('holds null, not an object with mcplServers')}`,
    );
    // A file-system error needn't name the file, so the line does.
    rmSync(configPath);
    mkdirSync(configPath);
    expectSays(
      String((await call(mod, 'mcpl_list')).data),
      `\nThe operator's server file, ${configPath}, couldn't be read (EISDIR`,
      '), so this list can\'t show which servers it defines. The next host start will stop on the file while it can\'t be ' +
      'read, before it loads any server, so what this list says a start loads holds once a start gets past the file, if ' +
      'the file still defines what it did at this host\'s start. Ask your operator to fix it. Of these tools, only this ' +
      'listing reads it.',
    );
  });

  // The boot stops on the operator's file before it loads any server, so
  // its line says so, and that the overlay's own lines say what a start
  // loads once it gets past the file.
  test("an operator's file that can't be read stops the start before any server, said beside an entry's next-start line", async () => {
    const { stub } = makeStubFramework();
    const mod = makeModule(stub);
    writeFileSync(overlayPath, JSON.stringify({ mcplServers: { idle: { command: 'node' } } }));
    const configPath = join(dir, 'mcpl-servers.json');
    writeFileSync(configPath, '{ not json');
    expect((await call(mod, 'mcpl_list')).data).toBe(
      'MCPL servers (1):\n  idle: NOT LOADED (in your overlay but not connected: the next host start loads it, and ' +
      'mcpl-admin--mcpl_deploy with each of its fields loads it now, since a deploy replaces the entry whole)\n' +
      `The operator's server file couldn't be read (${configPath} isn't valid JSON), so this list can't show which servers ` +
      'it defines. The next host start will stop on the file until it\'s fixed, before it loads any server, so what this ' +
      'list says a start loads holds once a start gets past the file, if the file still defines what it did at this host\'s ' +
      'start. It\'s theirs to fix, so ask your operator. Of these tools, only this listing reads it.',
    );
  });

  // A file the module can't open or read stops the next start like one that
  // isn't JSON, and fixing it is the operator's.
  test('an overlay that can\'t be read at all is the operator\'s to fix, for each tool', async () => {
    const { stub, calls } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'shell', command: 'node' });
    const mod = makeModule(stub);
    mkdirSync(overlayPath);
    // The file is named, since a file-system error need not name it.
    const unreadable = (so: string) => [`our overlay file, ${overlayPath}, couldn't be read (`, 'EISDIR', `), so ${so}. The next host start will ` +
      'stop on the file while it can\'t be read. Ask your operator to fix it'];
    expectSays(
      (await call(mod, 'mcpl_deploy', { id: 'mytool', command: 'node' })).error, 'Nothing was deployed or saved: your overlay',
      ...unreadable('your entry can\'t be saved in it'), ', then call mcpl-admin--mcpl_deploy again.',
    );
    const listed = String((await call(mod, 'mcpl_list')).data);
    expectSays(
      listed, 'shell: CONNECTED', 'source=unknown', '\nYour overlay file',
      ...unreadable('this list can\'t show your overlay\'s own entries, or which servers they define'),
    );
    expect(listed).toEndWith('Ask your operator to fix it.');
    expectSays(
      (await call(mod, 'mcpl_unload', { id: 'shell' })).error, 'Nothing was unloaded: your overlay',
      ...unreadable('the unload can\'t be recorded in it'), ', then call mcpl-admin--mcpl_unload "shell" again.',
      'To stop "shell" for this session in the meantime, call mcpl-admin--mcpl_unload with `persist: false`.',
    );
    expect(calls).toEqual(['connect:shell']);
  });

  // Too many files open, in this process (EMFILE) or the system (ENFILE), is
  // the host's own failure, not the file's: nothing about the file needs
  // fixing, and it can pass, so the repair is a call again shortly, then the
  // operator.
  test('a file the host has too many files open to read is said as its own failure, for the overlay and the operator\'s file', async () => {
    const { stub } = makeStubFramework();
    await (stub as unknown as { connectMcplServer: (c: { id: string; command: string }) => Promise<void> })
      .connectMcplServer({ id: 'shell', command: 'node' });
    const mod = makeModule(stub);
    const configPath = join(dir, 'mcpl-servers.json');
    writeFileSync(configPath, JSON.stringify({ mcplServers: {} }));
    const read = spyOn(mcplConfig, 'readAgentOverlay').mockImplementation((path: string) => {
      throw Object.assign(new Error(`EMFILE: too many open files, open '${path}'`), { code: 'EMFILE' });
    });
    let deployed: string;
    let listed: string;
    try {
      deployed = String((await call(mod, 'mcpl_deploy', { id: 'mytool', command: 'node' })).error);
      listed = String((await call(mod, 'mcpl_list')).data);
    } finally {
      read.mockRestore();
    }
    expectSays(
      deployed, `Nothing was deployed or saved: your overlay file, ${overlayPath}, couldn't be read (EMFILE: too many open files`,
      'The next host start will stop on the file while it can\'t be read. This host has too many files open, which can ' +
        'pass: call mcpl-admin--mcpl_deploy again shortly, and if it fails the same way, ask your operator.',
    );
    expect(deployed).not.toContain('fix it');
    expect(deployed).not.toContain('Fix the file');
    expect(listed).toEndWith(
      'This host has too many files open, which can pass: call mcpl-admin--mcpl_list shortly to read it, and if it ' +
        'still can\'t, ask your operator.',
    );
    const file = spyOn(mcplConfig, 'readMcplServersFile').mockImplementation((path: string) => {
      throw Object.assign(new Error(`ENFILE: file table overflow, open '${path}'`), { code: 'ENFILE' });
    });
    try {
      listed = String((await call(mod, 'mcpl_list')).data);
    } finally {
      file.mockRestore();
    }
    expectSays(
      listed, `\nThe operator's server file, ${configPath}, couldn't be read (ENFILE: file table overflow`,
      'before it loads any server, so what this list says a start loads holds once a start gets past the file, if the file ' +
        'still defines what it did at this host\'s start. This host has too many files open, which can pass: ' +
        'call mcpl-admin--mcpl_list shortly to read it, and if it still can\'t, ask your operator. Of these tools, only ' +
        'this listing reads it.',
    );
    expect(listed).not.toContain('theirs to fix');
  });

  // The restart's and the unload's reads of the overlay take the same repair:
  // the host's own failure can pass, and the call it stopped is the one to
  // make again.
  test("the restart's and the unload's reads of the overlay give too many files open the host's own repair", async () => {
    const { stub, servers } = makeStubFramework();
    const mod = makeModule(stub);
    await call(mod, 'mcpl_deploy', { id: 'shell', command: 'node' });
    await call(mod, 'mcpl_deploy', { id: 'other', command: 'node' });
    const original = mcplConfig.readAgentOverlay;
    const own = (code: 'EMFILE' | 'ENFILE', path: string): never => {
      throw Object.assign(new Error(`${code}: too many open files, open '${path}'`), { code });
    };
    const later = 'This host has too many files open, which can pass: call mcpl-admin--mcpl_unload "other" again shortly, and if ' +
      'it fails the same way, ask your operator.';

    // A restart that fails after its disconnect, with the overlay read refused.
    (stub as unknown as { restartMcplServer: (id: string) => Promise<void> }).restartMcplServer = async (id) => {
      servers.delete(id);
      throw new Error('the awareness ledger can\'t be read');
    };
    let read = spyOn(mcplConfig, 'readAgentOverlay').mockImplementation((path: string) => own('EMFILE', path));
    let restarted: string;
    try {
      restarted = String((await call(mod, 'mcpl_restart', { id: 'shell' })).error);
    } finally {
      read.mockRestore();
    }
    expectSays(
      restarted, 'mcpl-admin--mcpl_deploy with each of its fields can load it again once your overlay file can be read',
      'This host has too many files open, which can pass: call mcpl-admin--mcpl_list shortly to read it, and if it ' +
        'still can\'t, ask your operator.',
    );
    expect(restarted).not.toContain('is fixed');
    expect(restarted).not.toContain('Fix the file');

    // A persisting unload whose first read is refused unloads nothing.
    read = spyOn(mcplConfig, 'readAgentOverlay').mockImplementation((path: string) => own('ENFILE', path));
    let refused: string;
    try {
      refused = String((await call(mod, 'mcpl_unload', { id: 'other' })).error);
    } finally {
      read.mockRestore();
    }
    expectSays(
      refused, 'Nothing was unloaded: your overlay file', '(ENFILE', later,
      'To stop "other" for this session in the meantime, call mcpl-admin--mcpl_unload with `persist: false`.',
    );
    expect(servers.has('other')).toBe(true);

    // One whose read after the disconnect is refused has unloaded the server
    // and recorded nothing, and the unload is the call to make again.
    let reads = 0;
    read = spyOn(mcplConfig, 'readAgentOverlay').mockImplementation((path: string) => {
      reads += 1;
      return reads === 2 ? own('EMFILE', path) : original(path);
    });
    let unrecorded: string;
    try {
      unrecorded = String((await call(mod, 'mcpl_unload', { id: 'other' })).error);
    } finally {
      read.mockRestore();
    }
    expectSays(unrecorded, 'Unloaded server "other"', 'so the unload isn\'t recorded.', later);
    expect(servers.has('other')).toBe(false);
    expect(readAgentOverlay(overlayPath).other).toEqual({ command: 'node' });
  });

  test('a restart or an unload with no id says so, and an unload refuses a key it doesn\'t take', async () => {
    const { stub, calls } = makeStubFramework();
    const mod = makeModule(stub);
    expect((await call(mod, 'mcpl_restart', {})).error).toBe(
      'Nothing was restarted: mcpl-admin--mcpl_restart needs `id` as text, the server\'s id as mcpl-admin--mcpl_list shows it.',
    );
    expect((await call(mod, 'mcpl_unload', { id: 5 })).error).toBe(
      'Nothing was unloaded: mcpl-admin--mcpl_unload needs `id` as text, the server\'s id as mcpl-admin--mcpl_list shows it.',
    );
    // A misspelled persist would be dropped, and the unload would persist.
    await call(mod, 'mcpl_deploy', { id: 'kept', command: 'node' });
    expect((await call(mod, 'mcpl_unload', { id: 'kept', persistent: false })).error).toBe(
      'Nothing was unloaded: "persistent" isn\'t a field of mcpl-admin--mcpl_unload, which takes id, persist.',
    );
    expect(calls).toEqual(['connect:kept']);
    expect(readAgentOverlay(overlayPath)).toEqual({ kept: { command: 'node' } });
  });

  // A persist that isn't true or false would be read as true, saving an
  // unload asked for this session only.
  test("an unload refuses a persist that isn't true or false, and takes null as the default", async () => {
    const { stub, calls } = makeStubFramework();
    const mod = makeModule(stub);
    await call(mod, 'mcpl_deploy', { id: 'kept', command: 'node' });
    for (const [value, said] of [['false', '"false"'], [0, '0'], ['', '""']] as const) {
      expect((await call(mod, 'mcpl_unload', { id: 'kept', persist: value })).error).toBe(
        `Nothing was unloaded: \`persist\` is true or false, not ${said}.`,
      );
    }
    expect(calls).toEqual(['connect:kept']);
    expect(readAgentOverlay(overlayPath)).toEqual({ kept: { command: 'node' } });
    // Null is unspecified, as in a deploy, so the unload persists.
    expectSays((await call(mod, 'mcpl_unload', { id: 'kept', persist: null })).data, 'Removed from your agent overlay.');
    expect(readAgentOverlay(overlayPath)).toEqual({});
  });

  // A key that would be dropped is refused, and one of deploy's own fields,
  // the likeliest reason to pass it, is pointed to deploy.
  test("a restart refuses a key it doesn't take, and points one of deploy's fields to deploy", async () => {
    const { stub, calls } = makeStubFramework();
    const mod = makeModule(stub);
    await call(mod, 'mcpl_deploy', { id: 'shell', command: 'node' });
    expect((await call(mod, 'mcpl_restart', { id: 'shell', command: 'bun', args: ['serve'] })).error).toBe(
      'Nothing was restarted: "command", "args" aren\'t fields of mcpl-admin--mcpl_restart, which takes id. ' +
      'mcpl-admin--mcpl_deploy takes command, args: deploy the server again, with each of its fields, to change them.',
    );
    expect((await call(mod, 'mcpl_restart', { id: 'shell', url: 'wss://example.test/' })).error).toBe(
      'Nothing was restarted: "url" isn\'t a field of mcpl-admin--mcpl_restart, which takes id. ' +
      'mcpl-admin--mcpl_deploy takes url: deploy the server again, with each of its fields, to change it.',
    );
    expect((await call(mod, 'mcpl_restart', { id: 'shell', reason: 'rebuilt' })).error).toBe(
      'Nothing was restarted: "reason" isn\'t a field of mcpl-admin--mcpl_restart, which takes id.',
    );
    expect(calls).toEqual(['connect:shell']);
    // A key given no value is absent, as the utils validator reads it.
    expect((await call(mod, 'mcpl_restart', { id: 'shell', reason: undefined })).success).toBe(true);
    expect(calls).toEqual(['connect:shell', 'restart:shell']);
  });

  test('a save failing with a code that comes before anything is written says nothing was deployed', async () => {
    const codes = ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EROFS', 'ELOOP', 'ENAMETOOLONG', 'EMFILE', 'ENFILE', 'ETXTBSY', 'EBUSY'];
    for (const code of codes) {
      const { stub, calls } = makeStubFramework();
      const mod = makeModule(stub);
      const save = spyOn(mcplConfig, 'saveAgentOverlay').mockImplementation(() => {
        throw Object.assign(new Error(`${code}: the open failed`), { code });
      });
      let deployed: string;
      try {
        deployed = String((await call(mod, 'mcpl_deploy', { id: 'mytool', command: 'node' })).error);
      } finally {
        save.mockRestore();
      }
      // The repair goes by whose failure it is, as for a read: the host's own
      // can pass, and any other is the operator's.
      const repair = code === 'EMFILE' || code === 'ENFILE'
        ? 'This host has too many files open, which can pass: call mcpl-admin--mcpl_deploy again shortly, and if it fails ' +
          'the same way, ask your operator.'
        : 'Ask your operator to fix it, then call mcpl-admin--mcpl_deploy again.';
      expectSays(
        deployed, `Nothing was deployed: saving your overlay file, ${overlayPath}, failed (${code}: the open failed), so no ` +
        `server was connected or restarted. ${repair}`,
      );
      expect(deployed).not.toContain('cut short');
      expect(deployed).not.toContain('Once that\'s fixed');
      expect(calls).toEqual([]);
    }
  });

  // A save that fails at the open writes nothing, so the receipt reads what
  // the next start loads from the file as it still is: for a server loaded
  // now, one the overlay alone names, and one the operator defines.
  test('an unload whose save fails at the open says what the file still loads at the next start', async () => {
    const { stub } = makeStubFramework();
    const mod = makeModule(stub);
    mod.setOperatorServers([{ id: 'op', command: 'operator-server' }]);
    await call(mod, 'mcpl_deploy', { id: 'kept', command: 'node' });
    saveAgentOverlay(overlayPath, { kept: { command: 'node' }, idle: { command: 'node' } });
    const save = spyOn(mcplConfig, 'saveAgentOverlay').mockImplementation(() => {
      throw Object.assign(new Error('EACCES: the open failed'), { code: 'EACCES' });
    });
    let loaded: string;
    let idle: string;
    let operator: string;
    try {
      loaded = String((await call(mod, 'mcpl_unload', { id: 'kept' })).error);
      idle = String((await call(mod, 'mcpl_unload', { id: 'idle' })).error);
      operator = String((await call(mod, 'mcpl_unload', { id: 'op' })).error);
    } finally {
      save.mockRestore();
    }
    const unrecorded = `But your overlay file, ${overlayPath}, couldn't be updated (EACCES: the open failed), so the unload ` +
      'isn\'t recorded:';
    const retry = (id: string) => `Ask your operator to fix it, then call mcpl-admin--mcpl_unload "${id}" again.`;
    expectSays(
      loaded, 'Unloaded server "kept"', `${unrecorded} your overlay entry loads it again at the next host start.`, retry('kept'),
    );
    expectSays(
      idle, 'Server "idle" wasn\'t loaded in this session.', `${unrecorded} your overlay entry loads it again at the next host start.`,
      retry('idle'),
    );
    expectSays(
      operator, 'Server "op" wasn\'t loaded in this session.',
      `${unrecorded} the operator's definition loads it again at the next host start.`, retry('op'),
    );
    expect(readAgentOverlay(overlayPath)).toEqual({ kept: { command: 'node' }, idle: { command: 'node' } });
  });

  // Too many files open at the save is the host's own failure, as at a read.
  test('an unload whose save fails for too many files open says to call it again shortly', async () => {
    const { stub } = makeStubFramework();
    const mod = makeModule(stub);
    await call(mod, 'mcpl_deploy', { id: 'kept', command: 'node' });
    const save = spyOn(mcplConfig, 'saveAgentOverlay').mockImplementation(() => {
      throw Object.assign(new Error('EMFILE: too many open files, open'), { code: 'EMFILE' });
    });
    let unloaded: string;
    try {
      unloaded = String((await call(mod, 'mcpl_unload', { id: 'kept' })).error);
    } finally {
      save.mockRestore();
    }
    expectSays(
      unloaded, 'Unloaded server "kept"', 'so the unload isn\'t recorded:',
      'This host has too many files open, which can pass: call mcpl-admin--mcpl_unload "kept" again shortly, and if it ' +
      'fails the same way, ask your operator.',
    );
    expect(unloaded).not.toContain('Ask your operator to fix it');
  });

  test("a restart of an id the framework holds no server for is refused before it's asked, naming what is loaded", async () => {
    const { stub, calls } = makeStubFramework();
    const mod = makeModule(stub);
    await call(mod, 'mcpl_deploy', { id: 'discord', command: 'node' });
    await call(mod, 'mcpl_deploy', { id: 'shell', command: 'node' });
    expectSays(
      (await call(mod, 'mcpl_restart', { id: 'discrod' })).error,
      'Nothing was restarted', 'no server "discrod" is loaded in this session', 'Loaded: "discord", "shell"',
    );
    expect(calls).toEqual(['connect:discord', 'connect:shell']);
  });
});
