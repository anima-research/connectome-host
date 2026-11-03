import { readInboundSource } from '@animalabs/agent-framework';

const HOST_NOTE_KEY = 'hostNote';

export function hostNoteMetadata(kind: string): Record<string, string> {
  return { [HOST_NOTE_KEY]: kind };
}

export interface Speaker {
  kind: 'you' | 'host' | 'other';
  label: string;
}

export function speakerOf(participant: string, metadata: unknown): Speaker {
  const m = metadata !== null && typeof metadata === 'object' ? metadata as Record<string, unknown> : {};
  const source = readInboundSource(metadata);
  if (source?.kind === 'unscoped') {
    const author = authorOf(m, source.lane);
    return { kind: 'other', label: author === undefined ? `${source.serverId} (push)` : `${author} (push from ${source.serverId})` };
  }
  if (source?.kind === 'channel') {
    const channel = source.label ?? source.channelId;
    const author = authorOf(m, source.lane);
    if (author === undefined && source.lane === 'push/event') return { kind: 'other', label: `${source.serverId} (push) in ${channel}` };
    return { kind: 'other', label: `${author ?? 'someone'} in ${channel}` };
  }
  // agent-framework 0.27.0 stamps inboundSource after a server's own fields, so a channel or push
  // stamp is the framework's even where readInboundSource rejects a field the server sent.
  const stamped = (m.inboundSource as { kind?: unknown } | undefined)?.kind;
  const fromServer = stamped === 'channel' || stamped === 'unscoped';
  const kind = m.system === true ? m.kind : m[HOST_NOTE_KEY];
  if (!fromServer && (m.system === true || typeof kind === 'string')) {
    const named = typeof kind === 'string' ? kind.replace(/^host-/, '').replace(/-/g, ' ') : '';
    return { kind: 'host', label: named === '' ? 'host' : `host · ${named}` };
  }
  if (source?.kind === 'surface') return { kind: 'you', label: 'you' };
  return { kind: 'other', label: participant };
}

function authorOf(m: Record<string, unknown>, lane: string): string | undefined {
  const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
  const author = m.author as { id?: unknown; name?: unknown } | undefined;
  const id = text(author?.id);
  const name = text(author?.name);
  // agent-framework 0.27.0 gives a coalesced push that names no author `{ id: '', name: 'Someone' }`
  // (framework.ts, the coalesced channel event), and a push's own origin fields land flat in metadata.
  const placeholder = lane === 'push/event' && id === undefined && name === 'Someone';
  const flat = lane === 'push/event' ? text(m.authorName) ?? text(m.authorId) : undefined;
  return (placeholder ? undefined : name ?? id) ?? flat;
}
