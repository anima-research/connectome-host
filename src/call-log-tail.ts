// Reading a call log (`llm-calls.<iso>.jsonl`) from its end, a whole line at
// a time.
//
// The log's readers, the call ledger's restore and /bug's provider summary,
// want its newest records, and a line can be as long as the writers' bound,
// MAX_RECORD_BYTES with its newline (logging-record.ts). A fixed window of
// bytes that a few long lines fill would leave them nothing. So a reader reads
// back from the end within a budget taken from that bound: four lines of the
// bound's length are read whole, the byte before the oldest of them showing
// where it begins.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { MAX_RECORD_BYTES } from './logging-record.js';

/** The most a reader reads of a call log: four of the longest lines the
 *  writers write, and the byte before them. */
export const CALL_LOG_READ_BUDGET = 4 * MAX_RECORD_BYTES + 1;

/** How much is read at a time. */
const CHUNK_BYTES = 1024 * 1024;

export interface LinesRead {
  /** Bytes read from the file. */
  bytes: number;
  /** Lines before the ones handed on were left unread: the budget ran out
   *  before the file's start, or the line before them was longer than what
   *  was left of it. */
  truncated: boolean;
}

/**
 * Hands `onLine` each whole line of the file at `path`, newest first and
 * without its newline, reading back from the end until `budget` bytes are read
 * or the file's start. Empty lines are passed over. A last line with no newline
 * after it is being written now, or was cut off when its process stopped, so
 * it's handed on only if it parses as JSON. Throws if the file can't be read.
 */
export function readLinesFromEnd(path: string, budget: number, onLine: (line: string) => void): LinesRead {
  const fd = openSync(path, 'r');
  try {
    let position = fstatSync(fd).size;
    let bytes = 0;
    // The end of a line whose start hasn't been read yet, in file order.
    let parts: Buffer[] = [];
    // Whether that line runs to the file's end, with no newline after it.
    let unterminated = true;
    const hand = (line: Buffer, last: boolean): void => {
      if (line.length === 0) return;
      const text = line.toString('utf8');
      if (last && !parses(text)) return;
      onLine(text);
    };
    while (position > 0) {
      const size = Math.min(CHUNK_BYTES, position, budget - bytes);
      if (size <= 0) return { bytes, truncated: true };
      position -= size;
      const chunk = Buffer.allocUnsafe(size);
      readFully(fd, chunk, position);
      bytes += size;
      let end = size;
      for (let i = size - 1; i >= 0; i--) {
        if (chunk[i] !== 0x0a) continue;
        const piece = chunk.subarray(i + 1, end);
        hand(parts.length === 0 ? piece : Buffer.concat([piece, ...parts]), unterminated);
        parts = [];
        unterminated = false;
        end = i;
      }
      if (end > 0) parts.unshift(chunk.subarray(0, end));
    }
    hand(Buffer.concat(parts), unterminated);
    return { bytes, truncated: false };
  } finally {
    closeSync(fd);
  }
}

function readFully(fd: number, buffer: Buffer, position: number): void {
  let done = 0;
  while (done < buffer.length) {
    const read = readSync(fd, buffer, done, buffer.length - done, position + done);
    if (read === 0) throw new Error('the call log ended before the size it had when its read began');
    done += read;
  }
}

function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
