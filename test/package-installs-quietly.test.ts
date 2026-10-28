import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const scripts = (JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf-8')) as {
  scripts?: Record<string, string>;
}).scripts ?? {};

test("the package declares no script that npm warns of, or `bun add` blocks, when a consumer installs it from npm", () => {
  const installScripts = ['preinstall', 'install', 'postinstall', 'prepare'];
  expect(Object.keys(scripts).filter((name) => installScripts.includes(name))).toEqual([]);
});
