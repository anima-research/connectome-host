// Serializes one llm-calls record to its JSONL line. Shared by the three
// writers: the generic decorator (logging-provider-wrapper.ts) and the
// Anthropic and Bedrock subclasses (logging-adapter.ts,
// logging-bedrock-adapter.ts), so the size guard has one owner.
//
// Every line, its newline included, stays within MAX_RECORD_BYTES of UTF-8.
// A record that fits is written exactly as JSON.stringify gives it. One over
// the cap, or one that can't be serialized (a cycle or a BigInt), loses parts
// in a fixed order, each step checked against the cap again: first the raw
// request, where there's a raw response to keep, then both raw bodies, and
// last everything but the head's and the classification's scalar values and
// the error's name and message, each text cut to a bound.
// `truncated` states which step the line came from. The record itself is
// never changed: observers read it, while the call ledger's restore reads
// the line, so a restored call has only what its line kept.
//
// Serializing never throws; each writer still guards its own append.

import { Buffer } from 'node:buffer';
import { boundText } from './logging-error-fields.js';

/** Most UTF-8 bytes one line may take, its newline included. */
export const MAX_RECORD_BYTES = 16 * 1024 * 1024;

/** The head and the error: the fields whose scalar values the last fallback
 *  keeps, with an error object's name and message. */
const HEAD_AND_ERROR = ['type', 'provider', 'kind', 'timestamp', 'durationMs', 'keepalive', 'error', 'errorType',
  'httpStatus', 'providerErrorCode', 'retryable', 'errorChars', 'summaryUnavailable'];

/** Longest text the last fallback keeps of any one field. */
const MAX_LAST_RESORT_CHARS = 1_024;

/** Whether `line` and its newline fit the cap, in UTF-8 bytes. */
function fits(line: string): boolean {
  return Buffer.byteLength(line, 'utf8') + 1 <= MAX_RECORD_BYTES;
}

/** JSON.stringify, giving undefined where it throws. */
function stringify(value: unknown): string | undefined {
  try { return JSON.stringify(value); } catch { return undefined; }
}

/** The record's `keys` that it has, each read on its own: a field that can't
 *  be read is left out and costs only itself. */
function pick(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const key of keys) {
    try {
      if (key in record) kept[key] = record[key];
    } catch { /* an unreadable field costs only itself */ }
  }
  return kept;
}

/** The record's line without `keys`, marked with why they went; undefined
 *  where that can't be serialized or a field can't be read. */
function without(record: Record<string, unknown>, keys: readonly string[], truncated: string): string | undefined {
  try {
    const rest: Record<string, unknown> = { ...record };
    for (const key of keys) delete rest[key];
    return stringify({ ...rest, truncated });
  } catch {
    return undefined;
  }
}

/** The head's and the classification's strings, numbers and booleans, and
 *  an error object's name and message, each text cut to
 *  MAX_LAST_RESORT_CHARS. At most a few dozen KB, so it always fits, and
 *  building it can't throw. Its marker says what sent the line here: the
 *  record without its raw bodies couldn't be serialized, or didn't fit. */
function lastResort(record: Record<string, unknown>, unserializable: boolean): string {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(pick(record, HEAD_AND_ERROR))) {
    if (typeof value === 'string') kept[key] = boundText(value, MAX_LAST_RESORT_CHARS);
    else if (typeof value === 'number' || typeof value === 'boolean') kept[key] = value;
    else if (key === 'error' && typeof value === 'object' && value !== null) {
      // The Anthropic and Bedrock writers keep a failure's error as an
      // object; its name and message are what the doctor reads. This line
      // keeps no request summary, so the call ledger's restore skips it.
      const error: Record<string, string> = {};
      for (const [field, text] of Object.entries(pick(value as Record<string, unknown>, ['name', 'message']))) {
        if (typeof text === 'string') error[field] = boundText(text, MAX_LAST_RESORT_CHARS);
      }
      if (Object.keys(error).length > 0) kept.error = error;
    }
  }
  kept.truncated = unserializable
    ? 'only bounded head and classification kept (the record could not be serialized)'
    : 'only bounded head and classification kept (record exceeded size guard)';
  return JSON.stringify(kept);
}

/**
 * The record's JSONL line, its newline included, within MAX_RECORD_BYTES of
 * UTF-8. Each fallback's `truncated` marker says what it dropped: the
 * generic writer's existing markers, and "raw request dropped" for a line
 * that keeps its raw response.
 */
export function serializeRecord(record: Record<string, unknown>): string {
  const whole = stringify(record);
  if (whole !== undefined && fits(whole)) return whole + '\n';
  // A record with a raw response loses its raw request first, and the
  // response only when the line still doesn't fit: a request is the usual
  // oversized part, and the response holds the usage, cache writes and stop
  // reason that the call ledger's restore and the doctor read from the line.
  const response = pick(record, ['rawResponse']).rawResponse;
  if (response !== undefined && response !== null) {
    const withoutRequest = without(record, ['rawRequest'], whole === undefined
      ? 'raw request dropped (the record could not be serialized)'
      : 'raw request dropped (record exceeded size guard)');
    if (withoutRequest !== undefined && fits(withoutRequest)) return withoutRequest + '\n';
  }
  const withoutRaw = without(record, ['rawRequest', 'rawResponse'], whole === undefined
    ? 'raw bodies dropped (they could not be serialized)'
    : 'raw bodies dropped (record exceeded size guard)');
  if (withoutRaw !== undefined && fits(withoutRaw)) return withoutRaw + '\n';
  return lastResort(record, withoutRaw === undefined) + '\n';
}
