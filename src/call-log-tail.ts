import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { MAX_RECORD_BYTES } from './logging-record.js';

const LINES_READ_WHOLE = 4;
const BYTE_BEFORE_OLDEST_LINE = 1;
export const CALL_LOG_READ_BUDGET = LINES_READ_WHOLE * MAX_RECORD_BYTES + BYTE_BEFORE_OLDEST_LINE;

export const CHUNK_BYTES = 1024 * 1024;

export interface LinesRead {
  bytes: number;
  truncated: boolean;
}

export function readLinesFromEnd(path: string, budget: number, onLine: (line: string) => void): LinesRead {
  const fd = openSync(path, 'r');
  try {
    let position = fstatSync(fd).size;
    let bytes = 0;
    let parts: Buffer[] = [];
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
