import { describe, test, expect } from 'bun:test';
import { resolveAgentName } from '../src/agent-name.js';

// The whole point of this helper is to prevent the priority chain from
// silently drifting (e.g. someone refactors "sidecar wins over CLI"
// because the sidecar is "the source of truth"). Spell every case out so
// any reversal lights up here, not in a six-month-later autobiography hole.

describe('resolveAgentName', () => {
  test('explicit wins over sidecar and default', () => {
    const r = resolveAgentName({ explicit: 'CLI', sidecar: 'Sidecar', default: 'D' });
    expect(r.name).toBe('CLI');
    expect(r.source).toBe('explicit');
  });

  test('sidecar wins over default when no explicit', () => {
    const r = resolveAgentName({ sidecar: 'Sidecar', default: 'D' });
    expect(r.name).toBe('Sidecar');
    expect(r.source).toBe('sidecar');
  });

  test('falls back to default when neither explicit nor sidecar', () => {
    const r = resolveAgentName({ default: 'D' });
    expect(r.name).toBe('D');
    expect(r.source).toBe('default');
  });

  test('empty-string explicit falls through to sidecar', () => {
    const r = resolveAgentName({ explicit: '', sidecar: 'S', default: 'D' });
    expect(r.name).toBe('S');
    expect(r.source).toBe('sidecar');
  });

  test('empty-string sidecar falls through to default', () => {
    const r = resolveAgentName({ sidecar: '', default: 'D' });
    expect(r.name).toBe('D');
    expect(r.source).toBe('default');
  });

  test('mismatch reported when explicit and sidecar disagree', () => {
    // Operator override still wins — but the mismatch is surfaced so the
    // caller can log a warning. A previous warmup writing summaries under
    // the sidecar name leaves them orphaned when the live agent runs
    // under the explicit override; the user should know.
    const r = resolveAgentName({ explicit: 'CLI', sidecar: 'OldImport', default: 'D' });
    expect(r.name).toBe('CLI');
    expect(r.source).toBe('explicit');
    expect(r.mismatch).toEqual({ explicit: 'CLI', sidecar: 'OldImport' });
  });

  test('no mismatch reported when explicit equals sidecar', () => {
    const r = resolveAgentName({ explicit: 'Claude', sidecar: 'Claude', default: 'D' });
    expect(r.name).toBe('Claude');
    expect(r.source).toBe('explicit');
    expect(r.mismatch).toBeUndefined();
  });

  test('no mismatch when only one of explicit/sidecar is set', () => {
    expect(resolveAgentName({ explicit: 'X', default: 'D' }).mismatch).toBeUndefined();
    expect(resolveAgentName({ sidecar: 'X', default: 'D' }).mismatch).toBeUndefined();
  });
});
