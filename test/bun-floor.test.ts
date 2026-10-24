import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bunBelowFloor, bunFloorWarning } from '../src/bun-floor.js';
import { HOST_PACKAGE_JSON, checkBunFloor } from '../src/bun-floor-check.js';

const engines = { node: '>=22.12.0', bun: '>=1.4.3' };
const warned = (bun: string) => bunFloorWarning(engines, bun, '0.10.2') !== null;

describe("whether a Bun is below a release's floor, as Update reads it", () => {
  test('is true below it, false at or above it, and null for a floor or a Bun it can\'t read', () => {
    expect(bunBelowFloor('>=1.4.3', '1.4.2')).toBe(true);
    expect(bunBelowFloor('>=1.4.3', '1.4.3-canary.1')).toBe(true);
    expect(bunBelowFloor('>=1.4.3', '1.4.3')).toBe(false);
    expect(bunBelowFloor('>=1.4.3', '1.5.0-canary.1')).toBe(false);
    expect(bunBelowFloor('^1.4.3', '1.0.0')).toBeNull();
    expect(bunBelowFloor(null, '1.0.0')).toBeNull();
    expect(bunBelowFloor('>=1.4.3', undefined)).toBeNull();
  });
});

describe('the start-up warning for a Bun below the floor', () => {
  test('a Bun below the floor is named, with the floor and who acts', () => {
    expect(bunFloorWarning(engines, '1.3.14', '0.10.2')).toBe(
      '[host] connectome-host 0.10.2 needs Bun >=1.4.3 (engines.bun in its package.json), and this is Bun 1.3.14. '
        + "Below that it can fail in ways that don't name Bun. Whoever runs this host can upgrade Bun, "
        + 'with `bun upgrade` or the package manager that installed it, and start the host again.',
    );
    expect(bunFloorWarning(engines, '1.4.2', undefined)).toContain('[host] connectome-host needs Bun >=1.4.3');
  });

  test('versions compare by their release numbers, a prerelease coming before its own release', () => {
    for (const bun of ['1.3.14', '1.4.2', '0.9.9', '1.4.3-canary.1', '1.4.3-canary.1+abc123', '1.4.2+abc']) {
      expect({ bun, warned: warned(bun) }).toEqual({ bun, warned: true });
    }
    for (const bun of ['1.4.3', '1.4.4', '1.5.0', '2.0.0', '1.4.3+abc', '1.5.0-canary.1+abc123', '1.4.4-canary.2']) {
      expect({ bun, warned: warned(bun) }).toEqual({ bun, warned: false });
    }
  });

  test('the floor is read only as a string >=X.Y.Z, with or without spaces', () => {
    expect(bunFloorWarning({ bun: ' >= 1.4.3 ' }, '1.3.14', '0.10.2')).toContain('needs Bun >= 1.4.3 (engines.bun');
    // The last two aren't strings: String() would read the array as a floor,
    // and throw on the object.
    for (const bun of ['^1.4.3', '1.4.3', '>=1.4', '>=1.4.3 <2', '>1.4.3', '', 7, null, ['>=1.4.3'], JSON.parse('{"toString":null}')]) {
      expect({ bun, warning: bunFloorWarning({ bun }, '1.3.14', '0.10.2') }).toEqual({ bun, warning: null });
    }
  });

  test('no engines, or no running Bun, gives none', () => {
    for (const e of [undefined, null, 'x', { node: '>=22' }]) {
      expect({ e, warning: bunFloorWarning(e, '1.3.14', '0.10.2') }).toEqual({ e, warning: null });
    }
    expect(bunFloorWarning(engines, undefined, '0.10.2')).toBeNull();
    expect(bunFloorWarning(engines, 'not a version', '0.10.2')).toBeNull();
  });

  test("the host's own package.json declares a floor the check reads", () => {
    const pkg = JSON.parse(readFileSync(HOST_PACKAGE_JSON, 'utf-8'));
    expect(pkg.name).toBe('@animalabs/connectome-host');
    expect(pkg.engines.bun).toMatch(/^>=\d+\.\d+\.\d+$/);
    expect(bunFloorWarning(pkg.engines, '0.0.1', pkg.version)).not.toBeNull();
  });

  test('the host imports the check before anything else runs', () => {
    const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf-8');
    expect(afterLeadingComments(index)).toStartWith("import './bun-floor-check.js';");
  });
});

/** What follows the whitespace and whole comments `src` starts with. A `//`
 *  comment runs to its line's end, and a block comment to the first `*\/`
 *  after it opens, so a comment can't take in the code after it. */
function afterLeadingComments(src: string): string {
  let rest = src;
  for (;;) {
    rest = rest.trimStart();
    if (rest.startsWith('//')) {
      const end = rest.indexOf('\n');
      rest = end < 0 ? '' : rest.slice(end + 1);
    } else if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/', 2);
      rest = end < 0 ? '' : rest.slice(end + 2);
    } else {
      return rest;
    }
  }
}

describe('the check at start', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bun-floor-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const pkgAt = (name: string, text: string) => {
    writeFileSync(join(dir, name), text);
    return pathToFileURL(join(dir, name));
  };

  test("prints the warning for a package.json whose floor this Bun is below, naming this Bun", () => {
    const lines: string[] = [];
    const pkg = pkgAt('above.json', JSON.stringify({ version: '9.9.9', engines: { bun: '>=99.0.0' } }));
    const notice = checkBunFloor(pkg, (line) => lines.push(line));
    expect(lines).toEqual([notice!]);
    expect(notice).toStartWith(`[host] connectome-host 9.9.9 needs Bun >=99.0.0 (engines.bun in its package.json), and this is Bun ${process.versions.bun}.`);
    // A version that isn't a string isn't named.
    const odd = checkBunFloor(pkgAt('odd.json', JSON.stringify({ version: 5, engines: { bun: '>=99.0.0' } })), () => {});
    expect(odd).toStartWith('[host] connectome-host needs Bun >=99.0.0');
  });

  test('prints nothing when this Bun meets the floor, or the package.json is missing or not JSON', () => {
    const lines: string[] = [];
    const warn = (line: string) => lines.push(line);
    expect(checkBunFloor(pkgAt('met.json', JSON.stringify({ engines: { bun: '>=0.0.1' } })), warn)).toBeNull();
    expect(checkBunFloor(pathToFileURL(join(dir, 'missing.json')), warn)).toBeNull();
    expect(checkBunFloor(pkgAt('torn.json', '{ "engines": '), warn)).toBeNull();
    expect(checkBunFloor(pkgAt('null.json', 'null'), warn)).toBeNull();
    expect(lines).toEqual([]);
  });
});

describe('a TUI start', () => {
  // test/mock-tui-bun-floor-child.ts gives the check the Bun version it's
  // given before it loads, and starts runTui with a saved session longer than
  // its view. Its own watchdog ends a hang at 20 s; this kills it at 25.
  async function startTui(bun: string) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bun-floor-tui-')));
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'mock-tui-bun-floor-child.ts'), bun], {
      cwd: dir, env: { ...process.env, DATA_DIR: dir }, stdout: 'pipe', stderr: 'pipe',
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 25000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(stdout).not.toContain('TUI_ERROR');
      expect(code).toBe(0);
      const frame: string = JSON.parse(stdout.match(/TUI_FRAME ([^\n]*)/)![1]!);
      return { warnings: stderr.split('\n').filter((line) => line.startsWith('[host] ')), lines: frame.split('\n') };
    } finally {
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const hostPackage = () => JSON.parse(readFileSync(HOST_PACKAGE_JSON, 'utf-8'));
  const END = '── end history ──';

  test("under a Bun below the floor: the warning once as the check loads, and in the TUI's view below the history", async () => {
    const pkg = hostPackage();
    const expected = bunFloorWarning(pkg.engines, '1.3.14', pkg.version);
    // What this test needs: Bun 1.3.14 below the host's floor.
    expect(expected).not.toBeNull();
    const { warnings, lines } = await startTui('1.3.14');
    // The check's own call at load, with its defaults: the host's
    // package.json, and console.warn to stderr.
    expect(warnings).toEqual([expected!]);
    // The view keeps to its bottom: the history's start is out of sight,
    // its last message and its end are in it, and the warning, wrapped,
    // comes right after.
    expect(lines.join('\n')).not.toContain('history 01');
    expect(lines.some((line) => line.startsWith('history 50'))).toBe(true);
    const end = lines.findIndex((line) => line.startsWith(END));
    expect(end).toBeGreaterThanOrEqual(0);
    expect(lines[end + 1]).toStartWith(`[host] connectome-host ${pkg.version} needs Bun ${pkg.engines.bun} (engines.bun`);
    expect(lines.slice(end + 1).join(' ')).toContain('start the host again.');
  }, 30000);

  test('under a Bun at the floor: no warning, and nothing added after the history', async () => {
    const floor = /^>=(\d+\.\d+\.\d+)$/.exec(hostPackage().engines.bun)![1]!;
    const { warnings, lines } = await startTui(floor);
    expect(warnings).toEqual([]);
    // The history's end is the view's last line, right above the status bar.
    const end = lines.findIndex((line) => line.startsWith(END));
    expect(end).toBeGreaterThanOrEqual(0);
    expect(lines[end + 1]).toContain('idle]');
  }, 30000);
});
