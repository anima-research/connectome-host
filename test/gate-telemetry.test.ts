/**
 * The x-gate-* stamp must be impossible to send to a vendor: attachment is
 * double-gated on the operator's explicit GATE_TELEMETRY declaration AND a
 * configured base URL. Review finding on the first wiring: the stamp was
 * attached unconditionally, so with ANTHROPIC_BASE_URL unset the household
 * value went to the vendor's default endpoint.
 */
import { describe, expect, it } from 'bun:test';
import { gateTelemetryHeaders } from '../src/gate-telemetry.js';

const debt = () => 7;

describe('gateTelemetryHeaders', () => {
  it('default vendor endpoint (no base URL): never attaches, even when flagged', () => {
    expect(gateTelemetryHeaders({ GATE_TELEMETRY: '1' }, debt)).toBeUndefined();
  });

  it('base URL without the operator declaration: never attaches', () => {
    expect(gateTelemetryHeaders({ ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic' }, debt)).toBeUndefined();
    expect(gateTelemetryHeaders({ GATE_TELEMETRY: '0', ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic' }, debt)).toBeUndefined();
    expect(gateTelemetryHeaders({ GATE_TELEMETRY: 'false', ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic' }, debt)).toBeUndefined();
  });

  it('declared gateway: attaches a live stamp', () => {
    const fn = gateTelemetryHeaders({ GATE_TELEMETRY: '1', ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic' }, debt);
    expect(fn).toBeDefined();
    expect(fn!()).toEqual({ 'x-gate-debt-chunks': 7 });
  });

  it('unreadable debt stays null (membrane drops null values — unstamped, never guessed)', () => {
    const fn = gateTelemetryHeaders({ GATE_TELEMETRY: '1', ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic' }, () => null);
    expect(fn!()).toEqual({ 'x-gate-debt-chunks': null });
  });
});
