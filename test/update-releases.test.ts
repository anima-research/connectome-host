/**
 * What the registry says of the package's releases (src/update/releases.ts):
 * each version's own fields from the full manifest, the release Update
 * offers, and the versions an update crosses.
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_REGISTRY, candidateOf, rangeOf, readReleases, registryOf, releasesOf, shownRegistry } from '../src/update/releases.js';

const manifest = {
  versions: {
    '0.10.0': { connectomeRelease: { breaking: false, cacheWrite: false } },
    '0.11.0': { connectomeRelease: 'not an object', engines: { bun: '>=1.4.3' } },
    '0.10.10': { deprecated: 'a store bug', connectomeRelease: { breaking: 'yes', cacheWrite: true } },
    '0.12.0-0': {},
    '0.12.0': { deprecated: '' },
    'latest': {},
    '0.13.0': null,
  },
};

describe('releasesOf', () => {
  test("reads each exact version's fields, oldest first, and leaves out what isn't a version", () => {
    expect(releasesOf(manifest)).toEqual([
      { version: '0.10.0', prerelease: false, deprecated: null, bunFloor: null, breaking: false, cacheWrite: false },
      { version: '0.10.10', prerelease: false, deprecated: 'a store bug', bunFloor: null, breaking: null, cacheWrite: true },
      { version: '0.11.0', prerelease: false, deprecated: null, bunFloor: '>=1.4.3', breaking: null, cacheWrite: null },
      { version: '0.12.0-0', prerelease: true, deprecated: null, bunFloor: null, breaking: null, cacheWrite: null },
      { version: '0.12.0', prerelease: false, deprecated: null, bunFloor: null, breaking: null, cacheWrite: null },
    ]);
    expect(() => releasesOf({ name: 'x' })).toThrow('lists no versions');
  });

  test('the candidate is the newest final release after the running one that is not deprecated', () => {
    const releases = releasesOf(manifest);
    expect(candidateOf(releases, '0.10.0')?.version).toBe('0.12.0');
    expect(candidateOf(releases, '0.12.0')).toBeNull();
    expect(candidateOf(releasesOf({ versions: { '0.12.0-0': {}, '0.11.0': { deprecated: 'no' } } }), '0.10.0')).toBeNull();
  });

  test('the range is every version after the running one up to the candidate, prereleases and deprecated ones included', () => {
    expect(rangeOf(releasesOf(manifest), '0.10.0', '0.12.0').map((r) => r.version)).toEqual(['0.10.10', '0.11.0', '0.12.0-0', '0.12.0']);
    expect(rangeOf(releasesOf(manifest), '0.11.0', '0.11.0')).toEqual([]);
  });
});

describe('reading the registry', () => {
  test("is npm's registry unless npm_config_registry names another", () => {
    expect(registryOf({})).toBe(DEFAULT_REGISTRY);
    expect(registryOf({ npm_config_registry: 'https://npm.example/repo' })).toBe('https://npm.example/repo/');
  });

  test("asks for the full manifest, and says why one can't be read", async () => {
    const asked: Array<[string, RequestInit | undefined]> = [];
    const answering = (response: () => Response) => (async (url: string, init?: RequestInit) => {
      asked.push([url, init]);
      return response();
    }) as unknown as typeof fetch;
    expect(await readReleases('https://r.example/', answering(() => Response.json(manifest)))).toHaveLength(5);
    expect(asked[0]![0]).toBe('https://r.example/@animalabs%2fconnectome-host');
    expect(new Headers(asked[0]![1]?.headers).get('accept')).toBe('application/json');
    await expect(readReleases('https://r.example/', answering(() => new Response('nope', { status: 404 }))))
      .rejects.toThrow('The registry at https://r.example/ answered 404 for @animalabs/connectome-host.');
    await expect(readReleases('https://r.example/', answering(() => new Response('<html>'))))
      .rejects.toThrow("sent a manifest of @animalabs/connectome-host that isn't JSON");
    await expect(readReleases('https://r.example/', (async () => { throw new Error('getaddrinfo ENOTFOUND'); }) as unknown as typeof fetch))
      .rejects.toThrow("The registry at https://r.example/ couldn't be read: getaddrinfo ENOTFOUND");
  });

  test("never names a registry's user or password, in its own words or in a failure's", async () => {
    const secret = 'https://me:s3cret@r.example/npm/';
    expect(shownRegistry(secret)).toBe('https://r.example/npm/');
    expect(shownRegistry('https://me@r.example/npm/')).toBe('https://r.example/npm/');
    expect(shownRegistry('https://r.example/npm/')).toBe('https://r.example/npm/');
    expect(shownRegistry('not a url')).toBe('not a url');
    // A failure that quotes the URL it was given is told without the secret too.
    const quoting = (async (url: string) => { throw new Error(`fetch ${url} refused`); }) as unknown as typeof fetch;
    const failed = await readReleases(secret, quoting).then(() => '', (error: Error) => error.message);
    expect(failed).toStartWith('The registry at https://r.example/npm/ couldn\'t be read: fetch https://r.example/npm/');
    expect(failed).not.toContain('s3cret');
    const status = (async () => new Response('', { status: 401 })) as unknown as typeof fetch;
    await expect(readReleases(secret, status)).rejects.toThrow('The registry at https://r.example/npm/ answered 401');
    const garbled = (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch;
    const notJson = await readReleases(secret, garbled).then(() => '', (error: Error) => error.message);
    expect(notJson).toStartWith('The registry at https://r.example/npm/ sent a manifest');
    expect(notJson).not.toContain('s3cret');
  });

  test('gives up on a registry that answers nothing within its time', async () => {
    // A registry that never answers: only the read's own signal ends it.
    let signal: AbortSignal | undefined;
    const silent = ((_url: string, init?: RequestInit) => new Promise<Response>((_done, fail) => {
      signal = init?.signal ?? undefined;
      signal?.addEventListener('abort', () => { fail(signal!.reason); });
    })) as unknown as typeof fetch;
    await expect(readReleases('https://r.example/', silent, 50)).rejects.toThrow("The registry at https://r.example/ couldn't be read: ");
    expect(signal?.aborted).toBe(true);
    expect((signal?.reason as Error).name).toBe('TimeoutError');
  });
});
