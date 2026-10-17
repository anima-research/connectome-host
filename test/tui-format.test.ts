import { describe, expect, test } from 'bun:test';
import { ctxSeverity, fleetNoticeLine, fmtElapsed, pickTopAlert, sliceViewport } from '../src/tui.js';

describe('fmtElapsed', () => {
  test('seconds under a minute stay bare', () => {
    expect(fmtElapsed(0)).toBe('0s');
    expect(fmtElapsed(48)).toBe('48s');
    expect(fmtElapsed(59)).toBe('59s');
  });

  test('minutes pad seconds to two digits', () => {
    expect(fmtElapsed(60)).toBe('1m00s');
    expect(fmtElapsed(348)).toBe('5m48s');
    expect(fmtElapsed(305)).toBe('5m05s');
  });

  test('hours pad minutes and drop seconds', () => {
    expect(fmtElapsed(3600)).toBe('1h00m');
    expect(fmtElapsed(3720)).toBe('1h02m');
    expect(fmtElapsed(7500)).toBe('2h05m');
  });
});

describe('ctxSeverity', () => {
  test('no budget → always ok', () => {
    expect(ctxSeverity(150_000)).toBe('ok');
    expect(ctxSeverity(150_000, 0)).toBe('ok');
    expect(ctxSeverity(150_000, undefined)).toBe('ok');
  });

  test('escalates at 75% and 90% of budget', () => {
    expect(ctxSeverity(100_000, 200_000)).toBe('ok');
    expect(ctxSeverity(149_999, 200_000)).toBe('ok');
    expect(ctxSeverity(150_000, 200_000)).toBe('warn');
    expect(ctxSeverity(179_999, 200_000)).toBe('warn');
    expect(ctxSeverity(180_000, 200_000)).toBe('high');
    expect(ctxSeverity(250_000, 200_000)).toBe('high');
  });

  test('zero context is ok regardless of budget', () => {
    expect(ctxSeverity(0, 100)).toBe('ok');
  });
});

describe('pickTopAlert', () => {
  test('empty → null', () => {
    expect(pickTopAlert([])).toBeNull();
  });

  test('priority kinds beat recency', () => {
    expect(pickTopAlert(['refusal-streak', 'compression-quarantine'])).toBe('compression-quarantine');
    expect(pickTopAlert(['inference-exhausted', 'refusal-streak'])).toBe('inference-exhausted');
    // quarantine outranks hard-down
    expect(pickTopAlert(['inference-exhausted', 'compression-quarantine'])).toBe('compression-quarantine');
  });

  test('no priority kind → most recent (last) wins', () => {
    expect(pickTopAlert(['a-alert', 'b-alert'])).toBe('b-alert');
  });
});

describe('sliceViewport', () => {
  test('everything fits → whole range', () => {
    expect(sliceViewport(10, 3, 20)).toEqual({ start: 0, end: 10 });
    expect(sliceViewport(20, 0, 20)).toEqual({ start: 0, end: 20 });
  });

  test('cursor at top: no top marker row, one extra body line', () => {
    const { start, end } = sliceViewport(100, 0, 20);
    expect(start).toBe(0);
    expect(end).toBe(19); // 19 body rows + 1 bottom-marker row = 20
  });

  test('cursor at bottom: no bottom marker row', () => {
    const { start, end } = sliceViewport(100, 99, 20);
    expect(end).toBe(100);
    expect(start).toBe(81); // 1 top-marker row + 19 body rows = 20
    expect(99).toBeGreaterThanOrEqual(start);
  });

  test('cursor mid-list: centered window with both markers budgeted', () => {
    const { start, end } = sliceViewport(100, 50, 20);
    expect(end - start).toBe(18); // 18 body + 2 marker rows = 20
    expect(50).toBeGreaterThanOrEqual(start);
    expect(50).toBeLessThan(end);
  });

  test('cursor always lands inside the window', () => {
    for (let cursor = 0; cursor < 60; cursor++) {
      const { start, end } = sliceViewport(60, cursor, 12);
      expect(cursor).toBeGreaterThanOrEqual(start);
      expect(cursor).toBeLessThan(end);
      // rendered rows (body + markers actually shown) never exceed avail
      const rows = (end - start) + (start > 0 ? 1 : 0) + (end < 60 ? 1 : 0);
      expect(rows).toBeLessThanOrEqual(12);
    }
  });

  test('degenerate tiny viewport still contains the cursor', () => {
    for (const avail of [3, 4, 5]) {
      const { start, end } = sliceViewport(50, 25, avail);
      expect(25).toBeGreaterThanOrEqual(start);
      expect(25).toBeLessThan(end);
    }
  });
});

describe('fleetNoticeLine', () => {
  test('a one-line notice shows whole', () => {
    expect(fleetNoticeLine('stop leaf failed: unknown')).toBe('  ⚠ stop leaf failed: unknown');
  });

  // The fleet view budgets one row per header line, so a notice of several
  // lines, or one long enough to wrap, would push the tree's last rows below
  // the fold while it shows.
  test('a notice of several lines shows its whole first line, then " …"', () => {
    const notice = 'restart leaf failed: subscribe failed: closed\n' +
      "The child's output during this launch, from /data/leaf/startup.log:\n  Missing ANTHROPIC_API_KEY.";
    expect(fleetNoticeLine(notice)).toBe('  ⚠ restart leaf failed: subscribe failed: closed …');
  });

  test('a first line past 70 characters is cut to 67 and an ellipsis, as the alerts beside it are, with no second mark for the lines after it', () => {
    const notice = "restart leaf failed: Child 'leaf' didn't start (launch failed: the child exited with code 1 " +
      'before its socket appeared) and has exited.';
    expect(fleetNoticeLine(notice)).toBe(`  ⚠ ${notice.slice(0, 67)}…`);
    expect(fleetNoticeLine(`${notice}\nThe child's output during this launch, from /data/leaf/startup.log:`))
      .toBe(`  ⚠ ${notice.slice(0, 67)}…`);
    expect(fleetNoticeLine('x'.repeat(70))).toBe(`  ⚠ ${'x'.repeat(70)}`);
    expect(fleetNoticeLine('x'.repeat(71))).toBe(`  ⚠ ${'x'.repeat(67)}…`);
    // The mark counts toward the 70, so a first line of 68 is the longest
    // that a notice of several lines shows whole.
    expect(fleetNoticeLine(`${'x'.repeat(68)}\nmore`)).toBe(`  ⚠ ${'x'.repeat(68)} …`);
    expect(fleetNoticeLine(`${'x'.repeat(69)}\nmore`)).toBe(`  ⚠ ${'x'.repeat(67)}…`);
  });

  test('a cut through a character outside the BMP drops its stray half', () => {
    expect(fleetNoticeLine(`${'x'.repeat(66)}😀${'y'.repeat(10)}`)).toBe(`  ⚠ ${'x'.repeat(66)}…`);
  });
});
