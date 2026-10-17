import { expect, test } from 'bun:test';
import { callOriginLabel, callOriginTone } from '../web/src/call-origin.js';

test("the Health call table's origin labels and tones tell keepalive from turn and compression", () => {
  expect(callOriginLabel('keepalive')).toBe('keepalive');
  expect(callOriginLabel('turn~')).toBe('turn');
  expect(callOriginLabel('aux~')).toBe('compr');
  // A poke is maintenance, not compression: it has a tone of its own.
  expect(callOriginTone('turn~')).toBe('text-cyan-400');
  expect(callOriginTone('aux~')).toBe('text-orange-400');
  expect(callOriginTone('keepalive')).toBe('text-neutral-400');
});
