import { describe, expect, test } from 'bun:test';
import { hostMembraneRetry } from '../src/membrane-retry.js';

describe('the host Membrane retry config', () => {
  test('turns the overloaded schedule off when the recipe gives no retry', () => {
    expect(hostMembraneRetry(undefined)).toEqual({ overloaded: { maxRetries: 0 } });
  });
  test("keeps a recipe's base fields and adds the overloaded default", () => {
    expect(hostMembraneRetry({ maxRetries: 4, retryDelayMs: 500 }))
      .toEqual({ maxRetries: 4, retryDelayMs: 500, overloaded: { maxRetries: 0 } });
  });
  test("lets a recipe's overloaded schedule win, field by field", () => {
    expect(hostMembraneRetry({ overloaded: { maxRetries: 7, retryDelayMs: 10_000 } }))
      .toEqual({ overloaded: { maxRetries: 7, retryDelayMs: 10_000 } });
  });
});
