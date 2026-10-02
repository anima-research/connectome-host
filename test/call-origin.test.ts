import { expect, test } from 'bun:test';
import { callOriginLabel } from '../web/src/call-origin.js';

test('Health distinguishes keepalive from turn and compression origins', () => {
  expect(callOriginLabel('keepalive')).toBe('keepalive');
  expect(callOriginLabel('turn~')).toBe('turn');
  expect(callOriginLabel('aux~')).toBe('compr');
});
