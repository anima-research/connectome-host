/**
 * Tests for the report-only module opt-in audit (Sol's #32 closure gate,
 * step 3). The contract under test: explicit enables are surfaced for an
 * operator decision, omissions are explained as the defaults flip working,
 * resolved .recipe.json snapshots are pointers rather than findings, and
 * nothing is ever modified.
 */

import { describe, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  classifyModule,
  looksLikeRecipe,
  auditRecipe,
  auditPaths,
  renderReport,
  AUDITED_MODULES,
} from '../scripts/audit-module-optins.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'optin-audit-'));
}

const AGENT = { name: 'test-agent', systemPrompt: 'hi' };

describe('classifyModule', () => {
  test('true and config objects are explicit enables', () => {
    expect(classifyModule(true)).toBe('explicit-enable');
    expect(classifyModule({ model: 'x' })).toBe('explicit-enable');
  });
  test('false is an explicit disable; absent is omitted', () => {
    expect(classifyModule(false)).toBe('explicit-disable');
    expect(classifyModule(undefined)).toBe('omitted');
  });
});

describe('looksLikeRecipe', () => {
  test('recipe-shaped objects pass; package.json-shaped ones do not', () => {
    expect(looksLikeRecipe({ name: 'r', agent: AGENT })).toBe(true);
    expect(looksLikeRecipe({ name: 'pkg', version: '1.0.0' })).toBe(false);
    expect(looksLikeRecipe(['name'])).toBe(false);
    expect(looksLikeRecipe(null)).toBe(false);
  });
});

describe('auditRecipe', () => {
  test('classifies each audited module independently', () => {
    const a = auditRecipe(
      { name: 'r', agent: AGENT, modules: { lessons: true, retrieval: false, wake: true } },
      'r.json',
    );
    expect(a.states).toEqual({ subagents: 'omitted', lessons: 'explicit-enable', retrieval: 'explicit-disable' });
    expect(a.isSnapshot).toBe(false);
    expect(a.matchesOldDefaultBoilerplate).toBe(false);
  });

  test('flags retrieval-without-lessons as inert after upgrade', () => {
    const a = auditRecipe({ name: 'r', agent: AGENT, modules: { retrieval: true } }, 'r.json');
    expect(a.inertRetrieval).toBe(true);
    // With lessons enabled the combination is coherent, not inert.
    const ok = auditRecipe({ name: 'r', agent: AGENT, modules: { retrieval: true, lessons: true } }, 'r.json');
    expect(ok.inertRetrieval).toBe(false);
  });

  test('a .recipe.json with all three true is old-default boilerplate; a source recipe never is', () => {
    const modules = { subagents: true, lessons: true, retrieval: true };
    const snap = auditRecipe({ name: 'r', agent: AGENT, modules }, 'data/.recipe.json');
    expect(snap.isSnapshot).toBe(true);
    expect(snap.matchesOldDefaultBoilerplate).toBe(true);
    const src = auditRecipe({ name: 'r', agent: AGENT, modules }, 'data/recipe.json');
    expect(src.matchesOldDefaultBoilerplate).toBe(false);
  });

  test('collects local fleet children, resolves relative paths, skips URLs', () => {
    const parentPath = resolve('/deploy/recipes/parent.json');
    const a = auditRecipe(
      {
        name: 'parent',
        agent: AGENT,
        modules: { fleet: { children: [{ recipe: 'child.json' }, { recipe: 'https://x.example/c.json' }] } },
      },
      parentPath,
    );

    // The https child is skipped; the relative one resolves beside the parent.
    expect(a.childRecipePaths).toHaveLength(1);
    const [childPath] = a.childRecipePaths;
    expect(isAbsolute(childPath)).toBe(true);
    expect(dirname(childPath)).toBe(dirname(parentPath));
    expect(basename(childPath)).toBe('child.json');
  });
});

describe('auditPaths', () => {
  test('scans directories, follows fleet children, skips non-recipes, modifies nothing', () => {
    const dir = tmp();
    const recipesDir = join(dir, 'recipes');
    mkdirSync(recipesDir);
    writeFileSync(
      join(recipesDir, 'parent.json'),
      JSON.stringify({
        name: 'parent',
        agent: AGENT,
        modules: { lessons: true, fleet: { children: [{ recipe: '../elsewhere/child.json' }] } },
      }),
    );
    // Child lives OUTSIDE the scanned dir — reachable only by following the reference.
    mkdirSync(join(dir, 'elsewhere'));
    const childPath = join(dir, 'elsewhere', 'child.json');
    writeFileSync(childPath, JSON.stringify({ name: 'child', agent: AGENT, modules: { retrieval: true } }));
    writeFileSync(join(recipesDir, 'package.json'), JSON.stringify({ name: 'pkg', version: '1.0.0' }));
    writeFileSync(join(recipesDir, 'broken.json'), '{nope');

    const before = statSync(join(recipesDir, 'parent.json')).mtimeMs;
    const { audits, unreadable } = auditPaths([recipesDir]);
    expect(unreadable).toEqual([]);
    expect(audits.map((a) => a.recipeName).sort()).toEqual(['child', 'parent']);
    // Report-only, literally: nothing was rewritten.
    expect(statSync(join(recipesDir, 'parent.json')).mtimeMs).toBe(before);
    expect(readFileSync(childPath, 'utf-8')).toContain('"retrieval":true');
  });

  test('audits a recipe an editor saved with a byte order mark, as the host loads it', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'marked.json'), '\uFEFF' + JSON.stringify({ name: 'marked', agent: AGENT, modules: { retrieval: true } }));
    const { audits, unreadable } = auditPaths([dir]);
    expect([audits.map((a) => a.recipeName), unreadable]).toEqual([['marked'], []]);
  });

  test("follows a parent's fleet child that an editor saved with a byte order mark", () => {
    const dir = tmp();
    const parentPath = join(dir, 'parent.json');
    writeFileSync(parentPath, JSON.stringify({ name: 'parent', agent: AGENT, modules: { fleet: { children: [{ recipe: 'child.json' }] } } }));
    writeFileSync(join(dir, 'child.json'), '\uFEFF' + JSON.stringify({ name: 'child', agent: AGENT, modules: { lessons: true } }));
    const { audits, unreadable } = auditPaths([parentPath]);
    expect([audits.map((a) => a.recipeName).sort(), unreadable]).toEqual([['child', 'parent'], []]);
  });

  test('finds dot-prefixed .recipe.json snapshots in scanned directories', () => {
    const dir = tmp();
    writeFileSync(
      join(dir, '.recipe.json'),
      JSON.stringify({ name: 'snap', agent: AGENT, modules: { subagents: true, lessons: true, retrieval: true } }),
    );
    const { audits } = auditPaths([dir]);
    expect(audits.length).toBe(1);
    expect(audits[0].isSnapshot).toBe(true);
    expect(audits[0].matchesOldDefaultBoilerplate).toBe(true);
  });

  test('reports unreadable path arguments', () => {
    const { audits, unreadable } = auditPaths([join(tmp(), 'nope.json')]);
    expect(audits).toEqual([]);
    expect(unreadable.length).toBe(1);
  });
});

describe('renderReport', () => {
  test('explicit enables and inert retrieval need decisions; omissions and disables do not', () => {
    const clean = auditRecipe({ name: 'clean', agent: AGENT, modules: { lessons: false } }, 'clean.json');
    expect(renderReport([clean]).needsDecision).toBe(0);

    const enabled = auditRecipe({ name: 'e', agent: AGENT, modules: { lessons: true, retrieval: true } }, 'e.json');
    // two explicit enables, no inert-retrieval (lessons present)
    expect(renderReport([enabled]).needsDecision).toBe(2);

    const inert = auditRecipe({ name: 'i', agent: AGENT, modules: { retrieval: true } }, 'i.json');
    // one explicit enable + one inert-retrieval warning
    expect(renderReport([inert]).needsDecision).toBe(2);
  });

  test('snapshot enables are informational, never decision items', () => {
    const snap = auditRecipe(
      { name: 's', agent: AGENT, modules: { subagents: true, lessons: true, retrieval: true } },
      'data/.recipe.json',
    );
    const { text, needsDecision } = renderReport([snap]);
    expect(needsDecision).toBe(0);
    expect(text).toContain('not authoritative');
    expect(text).toContain('old DEFAULT_RECIPE shape');
  });

  test('every audited module appears in a source-recipe report', () => {
    const a = auditRecipe({ name: 'r', agent: AGENT }, 'r.json');
    const { text } = renderReport([a]);
    for (const m of AUDITED_MODULES) expect(text).toContain(`${m}:`);
  });
});
