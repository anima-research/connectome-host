import type { ProviderRequest, ProviderRequestOptions } from '@animalabs/membrane';

const EXTRACT = 'history--extract';
const WITHHELD = '[history--extract result withheld: malformed JSON contains a private thinking block.]';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPrivateBlock(block: unknown): boolean {
  return isRecord(block) && (
    (block.type === 'thinking' && typeof block.thinking === 'string') ||
    (block.type === 'redacted_thinking' && typeof block.data === 'string')
  );
}

/** For detection only, close the readable prefix of a cut-off JSON result.
 *  Treat strings as tokens, never as structure. Keep the readable bytes of
 *  unfinished content/text values so a paired nested extract can be checked
 *  separately, without treating arbitrary quoted text as a block.
 *  Parse the prefix normally to validate its structure before trusting it. */
function parseJsonPrefix(text: string): unknown {
  const token = /[\t\n\r ]+|"[^"\\\x00-\x1f]*(?:\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})[^"\\\x00-\x1f]*)*(")?|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;
  const closers: string[] = [];
  let end = 0;
  let previous = '';
  let key = '';
  let tail = '';
  while (token.lastIndex < text.length) {
    const start = token.lastIndex;
    const match = token.exec(text);
    if (!match) break;
    const value = match[0];
    if (value[0] === '"' && !match[1]) {
      if (previous === ':' && key[0] === '"') {
        const field = JSON.parse(key);
        end = start;
        // Retain the string-field marker for private block fields without
        // interpreting unfinished identifiers or block types.
        tail = field === 'content' || field === 'text' ? value + '"' : '""';
      }
      break;
    }
    if (!value.trim()) continue;
    const top = closers[closers.length - 1];
    if (value === '{' || value === '[') {
      closers.push(value === '{' ? '}' : ']');
    } else if (value === '}' || value === ']') {
      if (top !== value) break;
      closers.pop();
    }
    // Neither a separator nor an object key can end a valid prefix.
    if (value !== ':' && value !== ',' &&
        !(value[0] === '"' && top === '}' && (previous === '{' || previous === ','))) {
      end = token.lastIndex;
    }
    if (value === ':') key = previous;
    previous = value;
  }
  try {
    return JSON.parse(text.slice(0, end) + tail + closers.reverse().join(''));
  } catch {
    return undefined;
  }
}

function filterText(text: string): string {
  if (!text.trimStart().startsWith('{')) return text;
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return filterExtract(parseJsonPrefix(text)) ? WITHHELD : text;
  }
  return filterExtract(payload) ? JSON.stringify(payload) : text;
}

function filterResultContent(content: unknown): unknown {
  if (typeof content === 'string') return filterText(content);
  if (!Array.isArray(content)) return content;
  let changed = false;
  const next = content.map((part: unknown) => {
    if (!isRecord(part) || part.type !== 'text' || typeof part.text !== 'string') return part;
    const text = filterText(part.text);
    if (text === part.text) return part;
    changed = true;
    return { ...part, text };
  });
  return changed ? next : content;
}

/** Only consider a result with its own preceding, exact-name call. Use the
 *  archive's camelCase ID for nested extracts and the wire ID for requests. */
function filterPairedResult(
  block: unknown,
  calls: Set<string>,
  idKey: 'toolUseId' | 'tool_use_id',
  role?: 'assistant' | 'user',
): unknown {
  if (!isRecord(block)) return block;
  if (role !== 'user' && block.type === 'tool_use' && typeof block.id === 'string' && block.id !== '') {
    if (block.name === EXTRACT) calls.add(block.id);
    else calls.delete(block.id);
  }
  const id = block[idKey];
  if (role === 'assistant' || block.type !== 'tool_result' || typeof id !== 'string' || !calls.delete(id)) return block;
  const content = filterResultContent(block.content);
  return content === block.content ? block : { ...block, content };
}

/** Only the history--extract projection: result.data is serialized by AF
 *  as { returned, messages: [{ id, timestamp, participant, ..., content }] }.
 *  This object came from JSON.parse and is detached from the archive. Don't
 *  descend into metadata, tool inputs, or other tools' results. */
function filterExtract(payload: unknown): boolean {
  if (!isRecord(payload) || typeof payload.returned !== 'number' || !Array.isArray(payload.messages)) return false;
  const calls = new Set<string>();
  let changed = false;
  for (const row of payload.messages as unknown[]) {
    if (!isRecord(row) || typeof row.id !== 'string' || typeof row.timestamp !== 'string' ||
        typeof row.participant !== 'string' || !Array.isArray(row.content)) continue;
    const content: unknown[] = [];
    for (const block of row.content as unknown[]) {
      if (isPrivateBlock(block)) {
        changed = true;
        continue;
      }
      const next = filterPairedResult(block, calls, 'toolUseId');
      if (next !== block) changed = true;
      content.push(next);
    }
    row.content = content;
  }
  return changed;
}

/** Rewrite only the provider-bound copies; native thinking and the source
 *  request (including future replays or reads of the archive) stay intact. */
export function filterStoredHistoryExtracts(
  request: ProviderRequest,
  onContentAltered?: ProviderRequestOptions['onContentAltered'],
): ProviderRequest {
  const calls = new Set<string>();
  let changed = false;
  const messages = request.messages.map((message) => {
    if (!isRecord(message) || (message.role !== 'user' && message.role !== 'assistant') ||
        !Array.isArray(message.content)) return message;
    const role = message.role;
    let changedMessage = false;
    const content = message.content.map((block: unknown) => {
      const next = filterPairedResult(block, calls, 'tool_use_id', role);
      if (next !== block) {
        changedMessage = true;
        onContentAltered?.(block);
      }
      return next;
    });
    if (!changedMessage) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? { ...request, messages } : request;
}
