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
// the line, so a restored call has only what its line kept. Every step keeps
// an anomalous call's `anomaly` and the call's `messageId` and `requestId`,
// the handles a call is reported upstream by (the last step bounded).
//
// Serializing never throws; each writer still guards its own append.
// serializeRecordOutcome also says which step the line came from, so a
// writer can tell what its line kept (the Anthropic adapter's anomaly alert
// says whether the request was saved).

import { Buffer } from 'node:buffer';
import { boundText } from './logging-error-fields.js';

/** Most UTF-8 bytes one line may take, its newline included. */
export const MAX_RECORD_BYTES = 16 * 1024 * 1024;

/** The head and the error: the fields whose scalar values the last fallback
 *  keeps, with an error object's name and message. */
const HEAD_AND_ERROR = ['type', 'provider', 'kind', 'timestamp', 'durationMs', 'keepalive', 'error', 'errorType',
  'httpStatus', 'providerErrorCode', 'retryable', 'errorChars', 'summaryUnavailable', 'messageId', 'requestId',
  'anomaly'];

/** Most tool names the last fallback keeps of an anomaly. */
const MAX_LAST_RESORT_TOOL_NAMES = 32;

/** Which step a line came from: the whole record, the record without its raw
 *  request, without both raw bodies, or only its bounded head. */
export type RecordKept = 'whole' | 'without-raw-request' | 'without-raw-bodies' | 'head-only';

/** One record's line and the step it came from. `truncated` is the line's
 *  own marker, absent for a whole record. */
export interface SerializedRecord {
  line: string;
  kept: RecordKept;
  truncated?: string;
}

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
function lastResort(record: Record<string, unknown>, unserializable: boolean): { line: string; truncated: string } {
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
    } else if (key === 'anomaly' && typeof value === 'object' && value !== null) {
      // An anomalous call's classification: its kind and stop reasons, and
      // the names of the tool calls it carried, each text bounded.
      const anomaly: Record<string, unknown> = {};
      for (const [field, v] of Object.entries(pick(value as Record<string, unknown>, ['kind', 'stopReason', 'providerStopReason', 'toolNames']))) {
        if (typeof v === 'string') anomaly[field] = boundText(v, MAX_LAST_RESORT_CHARS);
        else if (v === null) anomaly[field] = null;
        else if (field === 'toolNames' && Array.isArray(v)) {
          anomaly[field] = v.slice(0, MAX_LAST_RESORT_TOOL_NAMES)
            .map((name) => (typeof name === 'string' ? boundText(name, MAX_LAST_RESORT_CHARS) : '?'));
        }
      }
      if (Object.keys(anomaly).length > 0) kept.anomaly = anomaly;
    }
  }
  const truncated = unserializable
    ? 'only bounded head and classification kept (the record could not be serialized)'
    : 'only bounded head and classification kept (record exceeded size guard)';
  kept.truncated = truncated;
  return { line: JSON.stringify(kept), truncated };
}

/**
 * The record's JSONL line, its newline included, within MAX_RECORD_BYTES of
 * UTF-8. Each fallback's `truncated` marker says what it dropped: the
 * generic writer's existing markers, and "raw request dropped" for a line
 * that keeps its raw response.
 */
export function serializeRecord(record: Record<string, unknown>): string {
  return serializeRecordOutcome(record).line;
}

/** serializeRecord's line, with the step it came from (see RecordKept). */
export function serializeRecordOutcome(record: Record<string, unknown>): SerializedRecord {
  const whole = stringify(record);
  if (whole !== undefined && fits(whole)) return { line: whole + '\n', kept: 'whole' };
  // A record with a raw response loses its raw request first, and the
  // response only when the line still doesn't fit: a request is the usual
  // oversized part, and the response holds the usage, cache writes and stop
  // reason that the call ledger's restore and the doctor read from the line.
  const response = pick(record, ['rawResponse']).rawResponse;
  if (response !== undefined && response !== null) {
    const truncated = whole === undefined
      ? 'raw request dropped (the record could not be serialized)'
      : 'raw request dropped (record exceeded size guard)';
    const withoutRequest = without(record, ['rawRequest'], truncated);
    if (withoutRequest !== undefined && fits(withoutRequest)) {
      return { line: withoutRequest + '\n', kept: 'without-raw-request', truncated };
    }
  }
  const truncated = whole === undefined
    ? 'raw bodies dropped (they could not be serialized)'
    : 'raw bodies dropped (record exceeded size guard)';
  const withoutRaw = without(record, ['rawRequest', 'rawResponse'], truncated);
  if (withoutRaw !== undefined && fits(withoutRaw)) return { line: withoutRaw + '\n', kept: 'without-raw-bodies', truncated };
  const last = lastResort(record, withoutRaw === undefined);
  return { line: last.line + '\n', kept: 'head-only', truncated: last.truncated };
}
