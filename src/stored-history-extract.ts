import type { ProviderRequest, ProviderRequestOptions } from '@animalabs/membrane';

const EXTRACT = 'history--extract';
const ACT = 'toolsets--act';
const WITHHELD = '[history--extract result withheld: malformed JSON contains a private thinking block.]';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type ExtractCall = 'direct' | 'wrapped';

// AF #1041: only a local host-toolset act can name the history tool.
function extractCall(block: Record<string, unknown>): ExtractCall | undefined {
  if (block.name === EXTRACT) return 'direct';
  if (block.name === ACT && isRecord(block.input) &&
      typeof block.input.tool === 'string' && block.input.tool.trim() === EXTRACT &&
      !(typeof block.input.server === 'string' && block.input.server.trim())) return 'wrapped';
}

function isPrivateBlock(block: unknown): boolean {
  return isRecord(block) && (
    (block.type === 'thinking' && typeof block.thinking === 'string') ||
    (block.type === 'redacted_thinking' && typeof block.data === 'string')
  );
}

/** For detection only, close the readable prefix of a cut-off JSON result.
 *  Treat strings as tokens, never as structure. Keep the readable bytes of
 *  unfinished content/text values so a recognized nested extract can be checked
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
    // AF and context-manager append notices to compact JSON, which has no
    // literal line breaks. Don't let the notice's '[' enter prefix parsing.
    const notice = text.search(/\r?\n\r?\n\[truncated — /);
    const prefix = notice < 0 ? text : text.slice(0, notice);
    return filterExtract(parseJsonPrefix(prefix)) ? WITHHELD : text;
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
    const { rawItem: _, ...rest } = part;
    return { ...rest, text };
  });
  return changed ? next : content;
}

/** Native wire results don't carry toolName; require a preceding wire call. */
function filterWireResult(
  block: unknown,
  calls: Set<string>,
  role: 'assistant' | 'user',
  mayRewrite: boolean,
): unknown {
  if (!isRecord(block)) return block;
  if (role === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string' && block.id !== '') {
    if (extractCall(block)) calls.add(block.id);
    else calls.delete(block.id);
  }
  const id = block.tool_use_id;
  if (role === 'assistant' || block.type !== 'tool_result' || typeof id !== 'string' || !calls.delete(id)) return block;
  if (!mayRewrite) return block;
  const content = filterResultContent(block.content);
  return content === block.content ? block : { ...block, content };
}

type ArchivedRow = Record<string, unknown> & { content: unknown[] };

function isArchivedRow(row: unknown): row is ArchivedRow {
  return isRecord(row) && typeof row.id === 'string' && typeof row.timestamp === 'string' &&
    typeof row.participant === 'string' && Array.isArray(row.content);
}

function archivedExtractCalls(rows: ArchivedRow[]): Map<string, ExtractCall> {
  const calls = new Map<string, ExtractCall>();
  for (const { content } of rows) {
    for (const block of content) {
      if (!isRecord(block) || block.type !== 'tool_use' || typeof block.id !== 'string') continue;
      const kind = extractCall(block);
      // Prefer a wrapped match if archived calls reuse an ID, as in AF #1041.
      if (kind === 'wrapped' || (kind === 'direct' && !calls.has(block.id))) calls.set(block.id, kind);
    }
  }
  return calls;
}

/** Only the history--extract projection: result.data is serialized by AF
 *  as { returned, messages: [{ id, timestamp, participant, ..., content }] }.
 *  This object came from JSON.parse and is detached from the archive. Don't
 *  descend into metadata, tool inputs, or other tools' results. */
function filterExtract(payload: unknown): boolean {
  if (!isRecord(payload) || typeof payload.returned !== 'number' || !Array.isArray(payload.messages)) return false;
  const rows = payload.messages.filter(isArchivedRow);
  let calls: Map<string, ExtractCall> | undefined;
  const replacedXml = new Set<string>();
  let changed = false;
  for (const row of rows) {
    row.content = row.content.flatMap((block) => {
      if (isPrivateBlock(block)) {
        changed = true;
        return [];
      }
      if (!isRecord(block) || block.type !== 'tool_result' ||
          typeof block.toolUseId !== 'string' || !block.toolUseId) return [block];
      // AF stores toolName before the body. Trust a named direct result
      // even if paging split the pair. An ACT name alone is ambiguous.
      if (block.toolName !== EXTRACT) {
        if (block.toolName !== undefined && block.toolName !== ACT) return [block];
        const kind = (calls ??= archivedExtractCalls(rows)).get(block.toolUseId);
        if (!kind || (block.toolName === ACT && kind !== 'wrapped')) return [block];
      }
      const content = filterResultContent(block.content);
      if (content === block.content) return [block];
      changed = true;
      if (typeof block.rawXml === 'string') replacedXml.add(block.rawXml);
      const { rawItem: _, ...result } = block;
      return [{ ...result, content }];
    });
  }
  // XML replay may copy a whole results batch onto each result. Remove it
  // from all siblings on this page, including ones whose body didn't change.
  if (replacedXml.size) {
    for (const row of rows) {
      row.content = row.content.map((block) => {
        if (!isRecord(block) || block.type !== 'tool_result' ||
            typeof block.rawXml !== 'string' || !replacedXml.has(block.rawXml)) return block;
        const { rawXml: _, rawXmlImagesAt: _images, ...result } = block;
        return result;
      });
    }
  }
  return changed;
}

/** Rewrite only the provider-bound copies; native thinking and the source
 *  request (including future replays or reads of the archive) stay intact. */
export function filterStoredHistoryExtracts(
  request: ProviderRequest,
  onContentAltered?: ProviderRequestOptions['onContentAltered'],
  bindsThinking = false,
): ProviderRequest {
  // On binding models, only rewrite results after the last native signed
  // thinking block. Still track calls and results in the protected prefix.
  let protectedThrough = -1;
  if (bindsThinking) {
    for (let i = request.messages.length - 1; i >= 0; i--) {
      const message = request.messages[i];
      if (isRecord(message) && message.role === 'assistant' && Array.isArray(message.content) &&
          message.content.some((block: unknown) => isRecord(block) && (
            (block.type === 'thinking' && typeof block.signature === 'string' && block.signature !== '') ||
            (block.type === 'redacted_thinking' && typeof block.data === 'string' && block.data !== '')
          ))) {
        protectedThrough = i;
        break;
      }
    }
  }
  const calls = new Set<string>();
  let changed = false;
  const messages = request.messages.map((message, index) => {
    if (!isRecord(message) || (message.role !== 'user' && message.role !== 'assistant') ||
        !Array.isArray(message.content)) return message;
    const role = message.role;
    let changedMessage = false;
    const content = message.content.map((block: unknown) => {
      const next = filterWireResult(block, calls, role, index > protectedThrough);
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
