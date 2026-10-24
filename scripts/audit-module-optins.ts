/**
 * Report-only audit of subagents/lessons/retrieval opt-ins across recipes.
 *
 * Background: published v0.7.2 and earlier treated these three modules as
 * opt-OUT (an omitted `modules` key meant enabled), and DEFAULT_RECIPE
 * enabled all three explicitly. Current main treats them as opt-IN
 * (a4bd9fd). That flip is the right default, but it leaves existing
 * deployments with two things only a human can settle:
 *
 *   1. A source recipe that explicitly says `lessons: true` stays enabled
 *      after upgrade — intentionally. Whether that `true` was a real choice
 *      or boilerplate copied from the old onboarding guide is not something
 *      a defaults change (or this script) can infer. It gets reported;
 *      the operator decides.
 *   2. A persisted `data/.recipe.json` is a resolved snapshot of whatever
 *      was in effect at launch — under the old defaults that includes
 *      `subagents/lessons/retrieval: true` the operator never wrote. It is
 *      not necessarily the authoritative source recipe, so it's reported
 *      separately, as a pointer back to the source, never as a finding in
 *      itself.
 *
 * This script reads and reports. It never modifies a file, and it has no
 * flag that would make it modify a file.
 *
 * Usage:
 *   bun scripts/audit-module-optins.ts <recipe.json | directory> [...more]
 *
 * Directories are scanned recursively for *.json (including .recipe.json
 * snapshots; node_modules/.git skipped). Fleet children referenced by
 * local path are followed automatically.
 *
 * Exit codes: 0 = nothing needs an operator decision; 2 = explicit enables
 * (or inert-retrieval combinations) found — review the report; 1 = a path
 * argument could not be read.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parseHandWrittenJson } from '../src/hand-written-json.js';

export const AUDITED_MODULES = ['subagents', 'lessons', 'retrieval'] as const;
export type AuditedModule = (typeof AUDITED_MODULES)[number];

export type ModuleState = 'explicit-enable' | 'explicit-disable' | 'omitted';

export interface RecipeAudit {
  /** Path as reported (relative to cwd where possible). */
  path: string;
  recipeName: string;
  /** basename === '.recipe.json': a resolved launch snapshot, not a source. */
  isSnapshot: boolean;
  states: Record<AuditedModule, ModuleState>;
  /** Snapshot has all three explicitly true — the old DEFAULT_RECIPE shape.
   *  Almost certainly captured pre-flip defaults, not an operator choice. */
  matchesOldDefaultBoilerplate: boolean;
  /** retrieval explicitly enabled while lessons is omitted: worked under the
   *  old defaults (omitted lessons = on), silently inert after upgrade. */
  inertRetrieval: boolean;
  /** Local fleet-children recipe paths referenced by this recipe. */
  childRecipePaths: string[];
}

interface RawRecipeShape {
  name?: unknown;
  agent?: unknown;
  modules?: Record<string, unknown>;
}

/** A JSON document we treat as a recipe: object with a name and an agent
 *  block. Anything else in a scanned directory is silently skipped. */
export function looksLikeRecipe(raw: unknown): raw is RawRecipeShape {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const o = raw as RawRecipeShape;
  return typeof o.name === 'string' && !!o.agent && typeof o.agent === 'object';
}

export function classifyModule(value: unknown): ModuleState {
  if (value === undefined || value === null) return 'omitted';
  if (value === false) return 'explicit-disable';
  // true or a config object both enable (matches createFramework wiring).
  return 'explicit-enable';
}

export function auditRecipe(raw: RawRecipeShape, path: string): RecipeAudit {
  const modules = (raw.modules && typeof raw.modules === 'object' ? raw.modules : {}) as Record<string, unknown>;
  const states = Object.fromEntries(
    AUDITED_MODULES.map((m) => [m, classifyModule(modules[m])]),
  ) as Record<AuditedModule, ModuleState>;

  const isSnapshot = basename(path) === '.recipe.json';

  const childRecipePaths: string[] = [];
  const fleet = modules.fleet;
  if (fleet && typeof fleet === 'object') {
    const children = (fleet as { children?: unknown }).children;
    if (Array.isArray(children)) {
      for (const child of children) {
        const ref = (child as { recipe?: unknown })?.recipe;
        if (typeof ref !== 'string' || !ref) continue;
        if (ref.startsWith('http://') || ref.startsWith('https://')) continue;
        childRecipePaths.push(isAbsolute(ref) ? ref : resolve(dirname(resolve(path)), ref));
      }
    }
  }

  return {
    path,
    recipeName: String(raw.name),
    isSnapshot,
    states,
    matchesOldDefaultBoilerplate:
      isSnapshot &&
      modules.subagents === true && modules.lessons === true && modules.retrieval === true,
    inertRetrieval: states.retrieval === 'explicit-enable' && states.lessons === 'omitted',
    childRecipePaths,
  };
}

// ---------------------------------------------------------------------------
// Filesystem walk (main-path only; the logic above is what the tests pin)
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '.git', 'web']);

function collectJsonFiles(root: string, out: string[]): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectJsonFiles(full, out);
    } else if (entry.name.endsWith('.json')) {
      out.push(full);
    }
  }
}

export function auditPaths(paths: string[]): { audits: RecipeAudit[]; unreadable: string[] } {
  const files: string[] = [];
  const unreadable: string[] = [];
  for (const p of paths) {
    if (!existsSync(p)) {
      unreadable.push(p);
      continue;
    }
    if (statSync(p).isDirectory()) collectJsonFiles(p, files);
    else files.push(p);
  }

  const audits: RecipeAudit[] = [];
  const seen = new Set<string>();
  const queue = [...files];
  while (queue.length > 0) {
    const file = queue.shift()!;
    const key = resolve(file);
    if (seen.has(key)) continue;
    seen.add(key);
    let raw: unknown;
    try {
      // A recipe an editor saved with a byte order mark is one the host
      // loads, so it's audited too.
      raw = parseHandWrittenJson(readFileSync(file, 'utf-8'));
    } catch {
      continue; // not JSON we can read — not our business to complain about
    }
    if (!looksLikeRecipe(raw)) continue;
    const audit = auditRecipe(raw, file);
    audits.push(audit);
    // Follow local fleet children so a parent path argument covers the tree.
    for (const child of audit.childRecipePaths) {
      if (existsSync(child)) queue.push(child);
    }
  }
  return { audits, unreadable };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const STATE_LINES: Record<AuditedModule, Record<ModuleState, string>> = {
  subagents: {
    'explicit-enable':
      'explicitly enabled — stays on after upgrade. Keep if this agent really forks workers.',
    'explicit-disable': 'explicitly disabled — no change on upgrade (belt-and-braces for old checkouts).',
    omitted:
      'omitted — ON under published ≤0.7.2, OFF after upgrade. Declare `true` only if this agent relied on forking.',
  },
  lessons: {
    'explicit-enable':
      'explicitly enabled — stays on after upgrade. Keep if this agent curates a lesson library.',
    'explicit-disable': 'explicitly disabled — no change on upgrade (belt-and-braces for old checkouts).',
    omitted:
      'omitted — ON under published ≤0.7.2, OFF after upgrade. Declare `true` only if this agent relied on lessons.',
  },
  retrieval: {
    'explicit-enable':
      'explicitly enabled — stays on after upgrade: per-compile injection plus two Haiku calls per turn. Keep only as a real choice.',
    'explicit-disable': 'explicitly disabled — no change on upgrade (belt-and-braces for old checkouts).',
    omitted: 'omitted — ON under published ≤0.7.2 (when lessons ran), OFF after upgrade.',
  },
};

export function renderReport(audits: RecipeAudit[]): { text: string; needsDecision: number } {
  const lines: string[] = [];
  let needsDecision = 0;

  const sources = audits.filter((a) => !a.isSnapshot);
  const snapshots = audits.filter((a) => a.isSnapshot);

  for (const a of sources) {
    lines.push(`${a.path}  (recipe "${a.recipeName}")`);
    for (const m of AUDITED_MODULES) {
      const state = a.states[m];
      if (state === 'explicit-enable') needsDecision++;
      lines.push(`  ${m}: ${STATE_LINES[m][state]}`);
    }
    if (a.inertRetrieval) {
      needsDecision++;
      lines.push(
        '  ⚠ retrieval is enabled but lessons is omitted. Under the old defaults omitted lessons still ran,',
        '    so retrieval worked; after upgrade lessons is off and retrieval is silently inert.',
        '    Either add `lessons: true` (if retrieval is a real choice) or drop `retrieval`.',
      );
    }
    lines.push('');
  }

  if (snapshots.length > 0) {
    lines.push('Resolved snapshots (data/.recipe.json) — informational only:');
    lines.push(
      '  These are launch-time captures, not authoritative sources. Under the old defaults they',
      '  include enables the operator never wrote. Audit the source recipe each run was launched',
      '  from; the snapshot refreshes on the next launch from source.',
    );
    for (const a of snapshots) {
      const enabled = AUDITED_MODULES.filter((m) => a.states[m] === 'explicit-enable');
      const note = a.matchesOldDefaultBoilerplate
        ? 'all three enabled — matches the old DEFAULT_RECIPE shape, almost certainly pre-flip defaults, not a choice'
        : enabled.length > 0
          ? `explicitly enabled here: ${enabled.join(', ')}`
          : 'no audited modules enabled';
      lines.push(`  ${a.path}  (recipe "${a.recipeName}"): ${note}`);
    }
    lines.push('');
  }

  return { text: lines.join('\n'), needsDecision };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (args.length === 0) {
    console.error('Usage: bun scripts/audit-module-optins.ts <recipe.json | directory> [...more]');
    console.error('Report-only: reads recipes, changes nothing.');
    process.exit(1);
  }

  const { audits, unreadable } = auditPaths(args);
  for (const p of unreadable) console.error(`cannot read: ${p}`);

  console.log('connectome-host module opt-in audit — report only, nothing is modified\n');
  console.log(
    'Published ≤0.7.2 treated subagents/lessons/retrieval as opt-OUT (omitted = enabled).\n' +
      'Current main treats them as opt-IN (omitted = disabled). Explicit enables survive the\n' +
      'upgrade by design — this report shows where each recipe stands so you can decide which\n' +
      'of those are real choices and which are old boilerplate.\n',
  );

  let needsDecision = 0;
  if (audits.length === 0) {
    console.log('No recipe-shaped JSON found under the given paths.');
  } else {
    const report = renderReport(audits);
    needsDecision = report.needsDecision;
    console.log(report.text);
    const sources = audits.filter((a) => !a.isSnapshot).length;
    console.log(
      `Summary: ${audits.length} recipe(s) audited (${sources} source, ${audits.length - sources} snapshot), ` +
        `${needsDecision} item(s) need an operator decision.`,
    );
  }

  // Unreadable path arguments outrank findings in the exit code.
  if (unreadable.length > 0) process.exit(1);
  if (needsDecision > 0) process.exit(2);
}

if (import.meta.main) main();
