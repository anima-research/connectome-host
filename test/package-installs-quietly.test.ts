import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const scripts = (JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf-8')) as {
  scripts?: Record<string, string>;
}).scripts ?? {};

test('the package declares no install script, which `bun add` would report blocked and npm would warn of', () => {
  const installScripts = ['preinstall', 'install', 'postinstall', 'preprepare', 'prepare', 'postprepare'];
  expect(Object.keys(scripts).filter((name) => installScripts.includes(name))).toEqual([]);
});
