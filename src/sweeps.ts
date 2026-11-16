import type { StoredMessage } from '@animalabs/context-manager';
import { UNSTICK_FIX_11_16 } from './sweep-unstick-fix-11-16.js';

/**
 * A named rewrite of rows already stored, run by `connectome sweep NAME`
 * (`/sweep` in the host). `rewrite` is given only rows whose content is text
 * blocks alone. It gives a row's new text, which replaces the row's whole
 * content as one text block, and the kind of row it is; or null for a row
 * it leaves as it is, a row it has already rewritten included, so a second
 * run finds nothing.
 */
export interface Sweep {
  name: string;
  line: string;
  rewrite(row: StoredMessage): { kind: string; text: string } | null;
}

export const SWEEPS: readonly Sweep[] = [UNSTICK_FIX_11_16];

export function sweepNames(sweeps: readonly Sweep[]): string[] {
  if (sweeps.length === 0) return ['This release knows no sweep.'];
  return ['The sweeps this release knows:', ...sweeps.map((sweep) => `  ${sweep.name}: ${sweep.line}`)];
}
