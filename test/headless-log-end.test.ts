import { test, expect } from 'bun:test';
import { endHeadlessLog } from '../src/headless.ts';

test('with no log open, endHeadlessLog resolves at once', async () => {
  // A timer set before the call fires before any timer the call sets, so a
  // timer wait inside endHeadlessLog would lose this race.
  const timer = new Promise((resolve) => setTimeout(() => resolve('timer'), 0));
  const first = await Promise.race([endHeadlessLog().then(() => 'resolved'), timer]);
  expect(first).toBe('resolved');
});
