import { describe, expect, test } from 'bun:test';
import { formatNow } from '../src/modules/time-module.js';

describe('TimeModule presentation timezone', () => {
  test('formats current time independently of the host timezone', () => {
    expect(formatNow(new Date('2026-07-15T12:34:56.789Z'), 'America/Los_Angeles')).toEqual({
      iso: '2026-07-15T05:34:56.789-07:00',
      local: '2026-07-15T05:34:56.789-07:00 [America/Los_Angeles]',
      timezone: 'America/Los_Angeles',
      unixMs: 1_784_118_896_789,
    });
  });
});
