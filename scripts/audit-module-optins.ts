/**
 * Report-only audit of subagents/lessons/retrieval opt-ins across recipes.
 *
 * Releases after 0.7.2 treat these three modules as opt-in (omitted =
 * disabled), where 0.7.2 and earlier treated them as opt-out. A source
 * recipe's explicit enable stays enabled after the upgrade, so each is
 * reported for the operator to decide whether it was a real choice. A
 * persisted `data/.recipe.json` is a launch snapshot, not the source recipe,
 * so it's listed separately and never counted as a finding.
 *
 * This script reads and reports. It never modifies a file, and it has no
 * flag that would make it modify a file.
 *
 * Usage:
 *   bun scripts/audit-module-optins.ts <recipe.json | directory> [...more]
 *
 * Directories are scanned recursively for *.json (including .recipe.json
 * snapshots; node_modules, .git and web skipped). Fleet children referenced
 * by local path are followed automatically.
 *
 * Exit codes: 0 = nothing needs an operator decision; 2 = explicit enables
 * (or inert-retrieval combinations) found in a source recipe — review the
 * report; 1 = a path argument could not be read.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parseHandWrittenJson } from '../src/hand-written-json.js';

export const AUDITED_MODULES = ['subagents', 'lessons', 'retrieval'] as const;
export type AuditedModule = (typeof AUDITED_MODULES)[number];

export type ModuleState = 'explicit-enable' | 'explicit-disable' | 'omitted';

export interface RecipeAudit {
  path: string;
  recipeName: string;
  isSnapshot: boolean;
  states: Record<AuditedModule, ModuleState>;
  matchesOldDefaultBoilerplate: boolean;
  inertRetrieval: boolean;
  childRecipePaths: string[];
}

interface RawRecipeShape {
  name?: unknown;
  agent?: unknown;
  modules?: Record<string, unknown>;
}

export function looksLikeRecipe(raw: unknown): raw is RawRecipeShape {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const o = raw as RawRecipeShape;
  return typeof o.name === 'string' && !!o.agent && typeof o.agent === 'object';
}

export function classifyModule(value: unknown): ModuleState {
  if (value === undefined || value === null) return 'omitted';
  if (value === false) return 'explicit-disable';
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
      raw = parseHandWrittenJson(readFileSync(file, 'utf-8'));
    } catch {
      continue;
    }
    if (!looksLikeRecipe(raw)) continue;
    const audit = auditRecipe(raw, file);
    audits.push(audit);
    for (const child of audit.childRecipePaths) {
      if (existsSync(child)) queue.push(child);
    }
  }
  return { audits, unreadable };
}

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

  if (unreadable.length > 0) process.exit(1);
  if (needsDecision > 0) process.exit(2);
}

if (import.meta.main) main();
