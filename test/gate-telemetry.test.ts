/**
 * The x-gate-* stamp must be impossible to send to a vendor: attachment is
 * double-gated on the operator's explicit GATE_TELEMETRY declaration AND a
 * configured base URL. Review finding on the first wiring: the stamp was
 * attached unconditionally, so with ANTHROPIC_BASE_URL unset the household
 * value went to the vendor's default endpoint.
 */
import { describe, expect, it } from 'bun:test';
import { gateTelemetryHeaders, originClass } from '../src/gate-telemetry.js';

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

  const env = { GATE_TELEMETRY: '1', ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic' };
  const wake = { reason: 'mcpl:channel-incoming', source: 'discord', channelId: 'discord:1:2', counterparty: 'discord:user:42' };

  it('origin trio rides the stream lane: why, where, by whom — ids only', () => {
    const fn = gateTelemetryHeaders(env, debt, () => wake);
    expect(fn!({ lane: 'stream' })).toEqual({
      'x-gate-debt-chunks': 7,
      'x-gate-origin': 'event',
      'x-gate-channel': 'discord:1:2',
      'x-gate-counterparty': 'discord:user:42',
    });
  });

  it('complete lane (compression, side-calls, keepalive) carries debt only — a background call is not the turn', () => {
    const fn = gateTelemetryHeaders(env, debt, () => wake);
    expect(fn!({ lane: 'complete' })).toEqual({ 'x-gate-debt-chunks': 7 });
  });

  it('no lane told (older membrane) or no trigger known: honest — debt only, or trio without guessing', () => {
    expect(gateTelemetryHeaders(env, debt, () => null)!({ lane: 'stream' })).toEqual({ 'x-gate-debt-chunks': 7 });
    expect(gateTelemetryHeaders(env, debt, () => wake)!()).toMatchObject({ 'x-gate-origin': 'event' });
    expect(gateTelemetryHeaders(env, debt)!({ lane: 'stream' })).toEqual({ 'x-gate-debt-chunks': 7 });
  });

  it('heartbeat wakes carry no channel or counterparty (null → dropped by membrane)', () => {
    const fn = gateTelemetryHeaders(env, debt, () => ({ reason: 'heartbeat:tick', source: 'heartbeat' }));
    expect(fn!({ lane: 'stream' })).toEqual({ 'x-gate-debt-chunks': 7, 'x-gate-origin': 'heartbeat', 'x-gate-channel': null, 'x-gate-counterparty': null });
  });

  it('originClass: heartbeat / mail / event / operator, raw reason otherwise (sanitized, clipped)', () => {
    expect(originClass({ reason: 'heartbeat', source: 'heartbeat' })).toBe('heartbeat');
    expect(originClass({ reason: 'mail:incoming', source: 'fenmail' })).toBe('mail');
    expect(originClass({ reason: 'mcpl:push-event', source: 'discord' })).toBe('event');
    expect(originClass({ reason: 'admin-nudge (someone)', source: 'framework' })).toBe('operator');
    expect(originClass({ reason: 'external-message', source: 'headless' })).toBe('operator');
    expect(originClass({ reason: 'external-message', source: 'tui' })).toBe('operator');
    expect(originClass({ reason: 'provider-acceleration-retry', source: 'framework' })).toBe('provider-acceleration-retry');
    expect(originClass({ reason: 'weird reason!!'.repeat(6), source: 'x' })).toHaveLength(40);
  });

  it('attributes are header-safe: a value with any non-ASCII or control character is withheld whole, never rewritten', () => {
    const fn = gateTelemetryHeaders(env, debt, () => ({ reason: 'mcpl:channel-incoming', source: 'discord', channelId: 'discord:\u{1F600}', counterparty: 'discord:user:4\r\n2' }));
    const h = fn!({ lane: 'stream' });
    expect(h['x-gate-channel']).toBeNull();
    expect(h['x-gate-counterparty']).toBeNull();
    // and what IS sent can always be put in real Headers (Fetch ByteString rule)
    const ok = gateTelemetryHeaders(env, debt, () => wake)!({ lane: 'stream' });
    const sendable = Object.fromEntries(Object.entries(ok).filter(([, v]) => v !== null).map(([k, v]) => [k, String(v)]));
    expect(() => new Headers(sendable)).not.toThrow();
    expect(new Headers(sendable).get('x-gate-counterparty')).toBe('discord:user:42');
  });

  it('attributes are clipped to 120 visible-ASCII characters', () => {
    const fn = gateTelemetryHeaders(env, debt, () => ({ reason: 'mcpl:channel-incoming', source: 'discord', counterparty: 'x'.repeat(200) }));
    expect((fn!({ lane: 'stream' })['x-gate-counterparty'] as string).length).toBe(120);
  });
});
