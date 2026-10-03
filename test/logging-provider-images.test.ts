import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GeminiAdapter, Membrane, NativeFormatter, type NormalizedRequest } from '@animalabs/membrane';
import { LoggingProviderAdapter } from '../src/logging-provider-wrapper.js';

// CI with the locked package proves transparent wrapping. The companion-pin
// run sets this flag to additionally require the new media capability.
const requireCapability = process.env.EXPECT_TOOL_RESULT_IMAGE_CAPABILITY === '1';

function imageData(brand: string): string {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32BE(32, 0);
  bytes.write('ftyp' + brand, 4, 'ascii');
  bytes.write(brand, 16, 'ascii');
  return bytes.toString('base64');
}

for (const lane of ['complete', 'stream'] as const) {
  for (const [mediaType, brand] of [['image/heic', 'heic'], ['image/heif', 'mif1']]) {
    test(`real Gemini wrapper matches direct ${lane} history (${mediaType})`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'logging-tool-images-'));
      const log = join(dir, 'calls.jsonl');
      const bodies: string[] = [];
      const server = Bun.serve({
        hostname: '127.0.0.1', port: 0,
        async fetch(request) {
          bodies.push(await request.text());
          const frame = {
            candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
          };
          return request.url.includes('streamGenerateContent')
            ? new Response('data: ' + JSON.stringify(frame) + '\n\n', { headers: { 'content-type': 'text/event-stream' } })
            : Response.json(frame);
        },
      });
      try {
        const inner = new GeminiAdapter({ apiKey: 'fixture', baseURL: server.url.toString() });
        const wrapped = new LoggingProviderAdapter(inner, log);
        const capability = (inner as GeminiAdapter & { toolResultImageMediaTypes?: ReadonlySet<string> })
          .toolResultImageMediaTypes;
        expect(wrapped.toolResultImageMediaTypes).toBe(capability);
        if (requireCapability) expect(capability?.has(mediaType)).toBe(true);

        const data = imageData(brand);
        const request = {
          config: { model: 'gemini-3-flash', maxTokens: 64 }, toolMode: 'native',
          tools: [{ name: 'snapshot', description: 'snapshot', inputSchema: { type: 'object', properties: {} } }],
          messages: [
            { participant: 'User', content: [{ type: 'text', text: 'look' }] },
            { participant: 'Assistant', content: [{ type: 'tool_use', id: 'call-one', name: 'snapshot', input: {} }] },
            { participant: 'User', content: [{ type: 'tool_result', toolUseId: 'call-one', content: [
              { type: 'text', text: 'before image' },
              { type: 'image', source: { type: 'base64', mediaType, media_type: mediaType, data } },
              { type: 'text', text: 'after image' },
            ] }] },
          ],
        } as NormalizedRequest;
        const original = structuredClone(request);
        for (const adapter of [inner, wrapped]) {
          const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });
          const response = lane === 'complete'
            ? await membrane.complete(request)
            : await membrane.stream(request, { onChunk: () => {} });
          if (!('usage' in response)) throw new Error('fixture response was unexpectedly aborted');
          expect(response.usage.outputTokens).toBe(3);
        }
        expect(bodies).toHaveLength(2);
        expect(bodies[1]).toBe(bodies[0]);
        expect(request).toEqual(original);
        expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1);

        if (capability) {
          // Full history passes through Membrane -> NativeFormatter -> the real
          // logging wrapper -> Gemini wire conversion, not a mock adapter.
          const body = JSON.parse(bodies[1]);
          const parts = body.contents.flatMap((message: any) => message.parts);
          const response = parts.find((part: any) => part.functionResponse)?.functionResponse;
          expect(response.name).toBe('snapshot');
          expect(response.parts).toEqual([{ inlineData: { mimeType: mediaType, data } }]);
          expect(JSON.stringify(response.response)).toContain('before image');
          expect(JSON.stringify(response.response)).toContain('after image');
          expect(JSON.stringify(response.response)).not.toContain(data);
        }
      } finally {
        server.stop(true);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}
