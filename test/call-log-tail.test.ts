import { describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CALL_LOG_READ_BUDGET, readLinesFromEnd } from '../src/call-log-tail.js';
import { MAX_RECORD_BYTES } from '../src/logging-record.js';

// Assertions here compare booleans, lengths and small strings, so a failure
// never prints a line of megabytes.

function withFile(content: string | Buffer, run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'call-log-tail-'));
  try {
    const path = join(dir, 'llm-calls.test.jsonl');
    writeFileSync(path, content);
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function read(path: string, budget = CALL_LOG_READ_BUDGET): { lines: string[]; truncated: boolean; bytes: number } {
  const lines: string[] = [];
  const { truncated, bytes } = readLinesFromEnd(path, budget, (line) => { lines.push(line); });
  return { lines, truncated, bytes };
}

describe('readLinesFromEnd', () => {
  test('hands on whole lines, newest first, without their newlines, and passes over empty ones', () => {
    withFile('a\n\nb\nc\n', (path) => {
      expect(read(path)).toEqual({ lines: ['c', 'b', 'a'], truncated: false, bytes: 7 });
    });
  });

  test('a last line with no newline after it is handed on only if it parses', () => {
    withFile('{"a":1}\n{"b":2}', (path) => {
      expect(read(path).lines).toEqual(['{"b":2}', '{"a":1}']);
    });
    withFile('{"a":1}\n{"b":', (path) => {
      expect(read(path)).toEqual({ lines: ['{"a":1}'], truncated: false, bytes: 13 });
    });
    // A log with no newline at all: its one line is also its last.
    withFile('{"a":', (path) => {
      expect(read(path)).toEqual({ lines: [], truncated: false, bytes: 5 });
    });
    withFile('{"a":1}', (path) => {
      expect(read(path)).toEqual({ lines: ['{"a":1}'], truncated: false, bytes: 7 });
    });
  });

  test('a last line with no newline, over several chunks, is handed on only if it parses', () => {
    // 2.5 MiB, so its parse check runs on pieces joined from three chunks.
    const pad = 'x'.repeat(2_621_440);
    withFile(`{"a":1}\n{"pad":"${pad}"}`, (path) => {
      const { lines } = read(path);
      expect(lines.length).toBe(2);
      expect(lines[0] === `{"pad":"${pad}"}`).toBe(true);
    });
    withFile(`{"a":1}\n{"pad":"${pad}`, (path) => {
      expect(read(path).lines).toEqual(['{"a":1}']);
    });
  });

  test('a line read over several chunks comes back whole, its multibyte text included', () => {
    // 3 MiB of two-byte characters, so chunk boundaries fall inside lines and
    // can fall inside a character.
    const long = 'é'.repeat(1_572_864) + 'end';
    withFile(`first\n${long}\nlast\n`, (path) => {
      const { lines, truncated, bytes } = read(path);
      expect(truncated).toBe(false);
      expect(bytes).toBe(statSync(path).size);
      expect(lines.length).toBe(3);
      expect(lines[0]).toBe('last');
      expect(lines[1] === long).toBe(true);
      expect(lines[2]).toBe('first');
    });
  });

  test('four lines of a budget\'s quarter are read whole only with the byte before them', () => {
    // Each line is 99 characters and its newline: 100 bytes.
    const line = (c: string) => c.repeat(99) + '\n';
    withFile(line('a') + line('b') + line('c') + line('d') + line('e'), (path) => {
      const four = read(path, 401);
      expect(four.lines.map((l) => l[0])).toEqual(['e', 'd', 'c', 'b']);
      expect(four.truncated).toBe(true);
      const three = read(path, 400);
      expect(three.lines.map((l) => l[0])).toEqual(['e', 'd', 'c']);
      expect(three.truncated).toBe(true);
    });
  });

  test('the call logs\' budget is four lines of the writers\' bound and the byte before them', () => {
    expect(CALL_LOG_READ_BUDGET).toBe(4 * MAX_RECORD_BYTES + 1);
  });

  test('a budget that runs out inside a later chunk ends the read there', () => {
    // 32 lines of 100,000 bytes, newlines included, read with 1.5 MiB:
    // fifteen whole lines and the byte before them fit, and sixteen don't.
    const line = (i: number) => String(i).padStart(2, '0') + 'x'.repeat(99_997) + '\n';
    withFile(Array.from({ length: 32 }, (_, i) => line(i)).join(''), (path) => {
      const { lines, truncated, bytes } = read(path, 1_572_864);
      expect(truncated).toBe(true);
      expect(bytes).toBe(1_572_864);
      expect(lines.length).toBe(15);
      expect(lines[0].slice(0, 2)).toBe('31');
      expect(lines[14].slice(0, 2)).toBe('17');
    });
  });

  test('a line longer than what is left of the budget stops the read, and it says so', () => {
    withFile(`older\n${'x'.repeat(1000)}\nnewest\n`, (path) => {
      expect(read(path, 500)).toEqual({ lines: ['newest'], truncated: true, bytes: 500 });
    });
  });

  test('the file\'s first line is handed on when the read reaches its start', () => {
    withFile('first\nsecond\n', (path) => {
      expect(read(path, 13)).toEqual({ lines: ['second', 'first'], truncated: false, bytes: 13 });
    });
  });

  test('a log changed during its read: what was appended is left out, and a shrink stops the read with an error', () => {
    // 32 lines of 100,000 bytes. The callback first runs while the last 1 MiB
    // chunk is handed on, before the next chunk is read.
    const content = Array.from({ length: 32 }, () => 'y'.repeat(99_999) + '\n').join('');
    withFile(content, (path) => {
      let appended = false;
      const lines: string[] = [];
      readLinesFromEnd(path, CALL_LOG_READ_BUDGET, (line) => {
        if (!appended) { appendFileSync(path, '{"late":1}\n'); appended = true; }
        lines.push(line);
      });
      expect(lines.length).toBe(32);
      expect(lines.includes('{"late":1}')).toBe(false);
    });
    withFile(content, (path) => {
      // Cut to a length inside the next chunk, so its read comes back short
      // and the read after it finds nothing.
      let cut = false;
      expect(() => readLinesFromEnd(path, CALL_LOG_READ_BUDGET, () => {
        if (!cut) { truncateSync(path, 1_600_000); cut = true; }
      })).toThrow('the call log ended before the size it had when its read began');
    });
  });

  test('a file that cannot be read throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'call-log-tail-'));
    try {
      const path = join(dir, 'llm-calls.dir.jsonl');
      mkdirSync(path);
      expect(() => readLinesFromEnd(path, 100, () => {})).toThrow();
      expect(() => readLinesFromEnd(join(dir, 'missing.jsonl'), 100, () => {})).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
