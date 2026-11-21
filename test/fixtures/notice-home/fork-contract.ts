import type { ToolDefinition } from '@animalabs/agent-framework';

/** Data-only transcription of send_message inputSchema, descriptions omitted.
 * Source: theaspirational/zulip_mcp 61298a12396c27e7cebc004f31cf67c958e35930
 * src/tools.ts:155-205; reply_to is unused by this host. No connector imported.
 * AF types narrow enum to string[]; this runtime JSON schema includes null. */
export const forkSchema = (): ToolDefinition['inputSchema'] => ({ type: 'object', properties: {
  type: { type: ['string', 'null'], enum: ['stream', 'private', '', null] },
  to: { type: ['string', 'null'] }, topic: { type: ['string', 'null'] },
  reply_to: { type: ['integer', 'null'] }, content: { type: 'string' },
  attachments: { type: 'array', items: { type: 'object', properties: {
    file: { type: 'string' }, data: { type: 'string' }, name: { type: 'string' }, mime_type: { type: 'string' },
  } } },
} } as unknown as ToolDefinition['inputSchema']);
