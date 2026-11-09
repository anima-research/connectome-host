import { describe, test, expect } from 'bun:test';
import { resolveAgentName } from '../src/agent-name.js';

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
