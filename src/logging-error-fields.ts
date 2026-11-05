// The error text is bounded (MAX_ERROR_CHARS): a provider can echo the whole
// rejected request in its error body.
//
// `errorChars`, set when the text was cut, is the whole length of the one text
// that was cut: the generic record's `error` ("Name: message"), or the other
// records' `error.message`, or, for a thrown value that isn't an Error, their
// `error` text itself. A cut stack states its own length only in its omission
// marker. Lengths here, the omission marker's included, are JavaScript string
// lengths (UTF-16 code units).

const MAX_ERROR_CHARS = 4_000;
const MAX_CODE_CHARS = 128;

export function boundText(text: string, max: number): string {
  if (text.length <= max) return text;
  const isLow = (index: number): boolean => {
    const code = text.charCodeAt(index);
    return code >= 0xdc00 && code <= 0xdfff;
  };
  const marker = ` …[${text.length} of ${text.length} characters omitted]… `.length;
  const budget = Math.max(0, max - marker);
  const tail = Math.floor(budget / 4);
  let headEnd = budget - tail;
  if (headEnd > 0 && isLow(headEnd)) headEnd--;
  let tailStart = text.length - tail;
  if (tailStart < text.length && isLow(tailStart)) tailStart++;
  return `${text.slice(0, headEnd)} …[${tailStart - headEnd} of ${text.length} characters omitted]… ${text.slice(tailStart)}`;
}

function read<T>(get: () => T): T | undefined {
  try { return get(); } catch { return undefined; }
}

interface ReadError {
  isError: boolean;
  name: string;
  message?: string;
  stack?: string;
  text?: string;
  classification: Record<string, unknown>;
}

/** The runtime formats a stack on its first read, which repeats a huge
 *  message, and a custom getter may do anything. */
function readError(error: unknown, withStack: boolean): ReadError {
  // Even the type test is guarded: a revoked Proxy or a throwing
  // getPrototypeOf trap makes `instanceof` itself throw.
  if (read(() => error instanceof Error) !== true) {
    return { isError: false, name: '', text: read(() => String(error)) ?? '[error could not be read]', classification: {} };
  }
  const e = error as Error & { type?: unknown; httpStatus?: unknown; providerErrorCode?: unknown; retryable?: unknown };
  const classification: Record<string, unknown> = {};
  const type = read(() => e.type);
  if (typeof type === 'string') classification.errorType = boundText(type, MAX_CODE_CHARS);
  const httpStatus = read(() => e.httpStatus);
  if (typeof httpStatus === 'number') classification.httpStatus = httpStatus;
  const code = read(() => e.providerErrorCode);
  if (typeof code === 'string') classification.providerErrorCode = boundText(code, MAX_CODE_CHARS);
  const retryable = read(() => e.retryable);
  if (typeof retryable === 'boolean') classification.retryable = retryable;
  const stack = withStack ? read(() => e.stack) : undefined;
  return {
    isError: true,
    name: read(() => String(e.name)) ?? 'Error',
    message: read(() => String(e.message)),
    ...(typeof stack === 'string' ? { stack } : {}),
    classification,
  };
}

/**
 * The generic decorator's error fields: the bounded text as `error`, plus
 * the classification a membrane error carries, so a reader can tell a
 * request-shaped rejection from a transient failure without the text, and
 * `errorChars`, the whole text's length, when it was cut.
 */
export function describeError(error: unknown): Record<string, unknown> {
  const e = readError(error, false);
  const text = e.isError
    ? (e.message === undefined ? `${e.name}: [message could not be read]` : `${e.name}: ${e.message}`)
    : e.text!;
  const bounded = boundText(text, MAX_ERROR_CHARS);
  return { error: bounded, ...e.classification, ...(bounded !== text ? { errorChars: text.length } : {}) };
}

/**
 * The Anthropic and Bedrock writers' error fields: `error` is `{ name,
 * message }` for an Error (with `stack` where the writer keeps one), or the
 * text of anything else. The message and stack are bounded like the generic
 * decorator's text, and the name like a classification code. A stack whose
 * header is the error's own "Name: message" line, as the runtime formats
 * it, names the message above instead of repeating it, so the bound goes to
 * its frames; any other stack is kept as it is, within the same bound.
 * Beside `error` come the same classification fields, and `errorChars`, the
 * whole message's length, when it was cut.
 */
export function describeErrorObject(error: unknown, withStack: boolean): Record<string, unknown> {
  const e = readError(error, withStack);
  if (!e.isError) {
    const bounded = boundText(e.text!, MAX_ERROR_CHARS);
    return { error: bounded, ...(bounded !== e.text ? { errorChars: e.text!.length } : {}) };
  }
  const message = e.message === undefined ? '[message could not be read]' : e.message;
  const bounded = boundText(message, MAX_ERROR_CHARS);
  const name = boundText(e.name, MAX_CODE_CHARS);
  const fields: Record<string, unknown> = { name, message: bounded };
  if (e.stack !== undefined) {
    // The header must be the whole first line (or lines, for a multi-line
    // message): a stack formatted from a longer message would otherwise be
    // spliced mid-line.
    const header = `${e.name}: ${message}`;
    const opens = e.message !== undefined && e.stack.startsWith(header)
      && (e.stack.length === header.length || e.stack[header.length] === '\n');
    const stack = opens ? `${name}: [the message above]${e.stack.slice(header.length)}` : e.stack;
    fields.stack = boundText(stack, MAX_ERROR_CHARS);
  }
  return { error: fields, ...e.classification, ...(bounded !== message ? { errorChars: message.length } : {}) };
}
