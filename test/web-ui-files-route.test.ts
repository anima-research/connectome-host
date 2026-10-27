/**
 * agent-framework's WorkspaceModule.readFileFromDisk refuses a file reached
 * through a link unless the mount follows links, and reads a file only if its
 * canonical path lies inside the mount.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule, WorkspaceReadError, type ModuleContext } from '@animalabs/agent-framework';
import {
  WebUiModule,
  __getSharedServerPortForTests,
  stopWebUiServer,
} from '../src/modules/web-ui-module.js';

// agent-framework's code for a link among a path's directories that stays
// inside the mount.
const PARENT_SYMLINK = 'parent_symlink' as WorkspaceReadError['code'];
// agent-framework's code for a path in another mount's directory nested in
// the one named.
const OTHER_MOUNT = 'other_mount' as WorkspaceReadError['code'];

describe("the web UI's /files/ route serves only what the mount's own read gives", () => {
  let webUiModule: WebUiModule | undefined;
  let root: string;
  let baseUrl: string;
  const asked: string[] = [];
  let workspace: unknown;
  let standIn: unknown;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'webui-files-'));
    const staticRoot = join(root, 'web');
    mkdirSync(staticRoot);
    writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><title>files</title>');
    writeFileSync(join(root, 'resolved.txt'), 'bytes the mount does not give');
    const refusals: Record<string, WorkspaceReadError> = {
      'files/link.txt': new WorkspaceReadError('symlink', 'Symlinks are not allowed: files/link.txt', 'lstat'),
      'files/out.txt': new WorkspaceReadError('escape', 'Symlink escape detected: files/out.txt', 'realpath'),
      'files/inner/x.txt': new WorkspaceReadError(
        OTHER_MOUNT,
        '"files/inner/x.txt" lies in mount "inner", nested in mount "files", which neither reads nor writes it: use "inner/x.txt".',
        'parse',
      ),
      'files/via/x.txt': new WorkspaceReadError(
        PARENT_SYMLINK,
        'files/via/x.txt: "files/via" is a symlink to "files/real", which this mount does not follow; the mount\'s host can set followSymlinks: true',
        'readlink',
      ),
      'nope/x.txt': new WorkspaceReadError('unknown_mount', 'Unknown mount: "nope". Available: files', 'parse'),
      // A ".." segment is resolved away before the request is sent, but one
      // spelt with an encoded slash reaches the route and decodes to "..".
      'files/../x.txt': new WorkspaceReadError('traversal', 'Path traversal detected: "files/../x.txt" resolves outside mount "files"', 'parse'),
      'files/gone.txt': new WorkspaceReadError('not_found', 'File not found: files/gone.txt', 'lstat', 'ENOENT'),
      'files/album': new WorkspaceReadError('directory', 'Path is a directory: files/album', 'lstat'),
      'files/moving.txt': new WorkspaceReadError('changed', 'File changed during read: files/moving.txt', 'stat'),
      'gone/x.txt': new WorkspaceReadError('mount_unavailable', 'Mount unavailable: gone', 'realpath_root', 'ENOENT'),
    };
    standIn = {
      resolveAbsolutePath: () => join(root, 'resolved.txt'),
      readFileFromDisk: async (path: string) => {
        asked.push(path);
        const refusal = refusals[path];
        if (refusal) throw refusal;
        const bytes = Buffer.from("the mount's own bytes");
        // As the real read answers: the canonical path of the file it opened,
        // a trailing slash in what was asked resolved away.
        return { bytes, size: bytes.byteLength, truncated: false, realPath: join('/mounts', path.replace(/\/+$/, '')) };
      },
    };
    workspace = standIn;
    webUiModule = new WebUiModule({ port: 0, host: '127.0.0.1', staticDir: staticRoot });
    await webUiModule.start({} as ModuleContext);
    const port = __getSharedServerPortForTests();
    if (!port) throw new Error('webui server not bound; did start() succeed?');
    baseUrl = `http://127.0.0.1:${port}`;
    webUiModule.setApp({
      framework: {
        getAllAgents: () => [],
        getAllModules: () => [],
        getModule: (name: string) => (name === 'workspace' ? workspace : undefined),
        getSessionUsage: () => { throw new Error('no usage in this harness'); },
        onTrace: () => {},
      },
    } as never);
  });

  afterAll(async () => {
    await webUiModule?.stop();
    await stopWebUiServer();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('a file the read gives is served with its bytes and the type of the file it opened', async () => {
    for (const path of ['files/notes.json', 'files/notes.json/']) {
      const res = await fetch(`${baseUrl}/files/${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(await res.text()).toBe("the mount's own bytes");
      expect(asked).toContain(path);
    }
  });

  test("a path no mount holds, leading out of it or into a nested mount's directory, a link the mount refuses, at the file or on its way, and one leading outside it are forbidden, and say why", async () => {
    const cases: Array<[string, string]> = [
      ['files/link.txt', 'Symlinks are not allowed: files/link.txt'],
      ['files/out.txt', 'Symlink escape detected: files/out.txt'],
      ['files/inner/x.txt', '"files/inner/x.txt" lies in mount "inner", nested in mount "files", which neither reads nor writes it: use "inner/x.txt".'],
      ['files/via/x.txt', 'files/via/x.txt: "files/via" is a symlink to "files/real", which this mount does not follow; the mount\'s host can set followSymlinks: true'],
      ['nope/x.txt', 'Unknown mount: "nope". Available: files'],
      ['files/..%2Fx.txt', 'Path traversal detected: "files/../x.txt" resolves outside mount "files"'],
    ];
    for (const [path, body] of cases) {
      const res = await fetch(`${baseUrl}/files/${path}`);
      expect(res.status).toBe(403);
      expect(await res.text()).toBe(body);
    }
  });

  test('a path the read gives no file for is not found, and says why', async () => {
    const cases: Array<[string, string]> = [
      ['files/gone.txt', 'File not found: files/gone.txt'],
      ['files/album', 'Path is a directory: files/album'],
      ['files/moving.txt', 'File changed during read: files/moving.txt'],
    ];
    for (const [path, body] of cases) {
      const res = await fetch(`${baseUrl}/files/${path}`);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(body);
    }
  });

  test("a mount the read can't resolve is unavailable, not a missing file, and says why", async () => {
    const res = await fetch(`${baseUrl}/files/gone/x.txt`);
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('Mount unavailable: gone');
  });

  test('a host with no workspace answers that none is mounted', async () => {
    workspace = undefined;
    try {
      const res = await fetch(`${baseUrl}/files/files/notes.json`);
      expect(res.status).toBe(503);
      expect(await res.text()).toBe('Workspace not mounted');
    } finally {
      workspace = standIn;
    }
  });

  test("agent-framework's read: a file by its own path, a file that is itself a link, and a file through a linked directory, answered as the read answers", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'webui-files-real-'));
    const plain = join(dir, 'plain');
    const follow = join(dir, 'follow');
    mkdirSync(join(plain, 'real'), { recursive: true });
    mkdirSync(follow);
    writeFileSync(join(plain, 'v2.png'), 'the second version');
    symlinkSync('v2.png', join(plain, 'latest.png'));
    writeFileSync(join(plain, 'real', 'note.json'), '{"through":"a linked directory"}');
    symlinkSync('real', join(plain, 'd'));
    writeFileSync(join(follow, 'v2.png'), 'the followed version');
    symlinkSync('v2.png', join(follow, 'latest.png'));
    mkdirSync(join(follow, 'real'));
    writeFileSync(join(follow, 'real', 'note.json'), '{"through":"a followed directory"}');
    symlinkSync('real', join(follow, 'd'));
    const store = JsStore.openOrCreate({ path: join(dir, 'store') });
    const real = new WorkspaceModule({
      mounts: [
        { name: 'plain', path: plain, mode: 'read-only', watch: 'never' },
        { name: 'follow', path: follow, mode: 'read-only', watch: 'never', followSymlinks: true },
      ],
    });
    real.initStore(store);
    workspace = real;
    try {
      const get = async (path: string) => {
        const res = await fetch(`${baseUrl}/files/${path}`);
        return { status: res.status, type: res.headers.get('content-type'), body: await res.text() };
      };
      expect(await get('plain/v2.png')).toEqual({ status: 200, type: 'image/png', body: 'the second version' });
      expect(await get('plain/v2.png/')).toEqual({ status: 200, type: 'image/png', body: 'the second version' });
      const link = await get('plain/latest.png');
      expect(link.status).toBe(403);
      expect(link.body).toBe('Symlinks are not allowed: plain/latest.png');
      const read = await real.readFileFromDisk('plain/d/note.json').then(
        (r) => ({ status: 200, body: r.bytes.toString(), code: null as string | null }),
        (err: WorkspaceReadError) => ({ status: 403, body: err.message, code: err.code as string | null }),
      );
      expect(await get('plain/d/note.json')).toMatchObject({ status: read.status, body: read.body });
      if (read.status === 200) expect(read.body).toBe('{"through":"a linked directory"}');
      else {
        expect(read.code).toBe(PARENT_SYMLINK);
        expect(read.body).toContain("the mount's host can set followSymlinks");
      }
      expect(await get('follow/latest.png')).toMatchObject({ status: 200, body: 'the followed version' });
      expect(await get('follow/d/note.json')).toMatchObject({ status: 200, body: '{"through":"a followed directory"}' });
    } finally {
      workspace = standIn;
      store.close?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("agent-framework's read: a file its mount's include leaves out is forbidden, and says so", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'webui-files-include-'));
    const conf = join(dir, 'conf');
    mkdirSync(conf);
    writeFileSync(join(conf, 'gate.json'), '{"policies":[]}');
    writeFileSync(join(conf, '#gate.json#'), 'an autosave');
    const store = JsStore.openOrCreate({ path: join(dir, 'store') });
    const real = new WorkspaceModule({
      mounts: [{ name: 'conf', path: conf, mode: 'read-write', watch: 'never', include: ['gate.json', 'gate.js'] }],
    });
    real.initStore(store);
    workspace = real;
    try {
      const covered = await fetch(`${baseUrl}/files/conf/gate.json`);
      expect({ status: covered.status, body: await covered.text() }).toEqual({ status: 200, body: '{"policies":[]}' });
      const read = await real.readFileFromDisk('conf/#gate.json#').then(() => null, (err: WorkspaceReadError) => err);
      expect(read?.code).toBe('outside_include');
      const left = await fetch(`${baseUrl}/files/conf/${encodeURIComponent('#gate.json#')}`);
      expect({ status: left.status, body: await left.text() }).toEqual({ status: 403, body: read!.message });
      expect(read!.message).toContain('"conf/#gate.json#" is outside the mount\'s include');
    } finally {
      workspace = standIn;
      store.close?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("agent-framework's read: a mount whose directory has gone answers as the read does", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'webui-files-gone-'));
    const gone = join(dir, 'gone');
    mkdirSync(gone);
    writeFileSync(join(gone, 'x.txt'), 'there once');
    const store = JsStore.openOrCreate({ path: join(dir, 'store') });
    const real = new WorkspaceModule({ mounts: [{ name: 'gone', path: gone, mode: 'read-only', watch: 'never' }] });
    real.initStore(store);
    workspace = real;
    try {
      rmSync(gone, { recursive: true, force: true });
      const read = await real.readFileFromDisk('gone/x.txt').then(
        () => null,
        (err: WorkspaceReadError) => err,
      );
      const res = await fetch(`${baseUrl}/files/gone/x.txt`);
      const got = { status: res.status, body: await res.text() };
      if (read?.code === 'mount_unavailable') {
        expect(got).toEqual({ status: 503, body: 'Mount unavailable: gone' });
      } else {
        expect(read?.code).toBe('not_found');
        expect(got).toEqual({ status: 404, body: 'File not found: gone/x.txt' });
      }
    } finally {
      workspace = standIn;
      store.close?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
