import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '@animalabs/agent-framework';
import type { StoredMessage } from '@animalabs/context-manager';
import { MembraneError } from '@animalabs/membrane';
import type { NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { createBranchState, handleCommand } from '../src/commands.js';
import { UNSTICK_FIX_11_16 } from '../src/sweep-unstick-fix-11-16.js';
import { SWEEPS } from '../src/sweeps.js';

const FAILURE_ADVICE = 'If this recurs with the same cause, change approach rather than retrying identically ' +
  '(e.g. drop an oversized attachment or an unsupported setting).';
const TIMEOUT_ADVICE = 'If a reply is still owed from that turn, you can give it now.';
const SET_ASIDE = (count: string) => `${count} were set aside because the requests that carried them couldn't be ` +
  'completed. Their content isn\'t shown here, and the originals remain in the raw record. You are clear to continue — ' +
  'if you were mid-task, take a different approach; otherwise carry on with whatever is now in front of you, or ' +
  'briefly acknowledge the gap and ask what\'s next.';
const CLEAR = 'You are clear to continue — if you were mid-task, take a different approach; otherwise carry on with ' +
  'whatever is now in front of you, or briefly acknowledge the gap and ask what\'s next.';
const PROVIDER = 'ZQ-PROVIDER says no. Reason: zq-inner. Another sentence.';

let made = 0;
function row(text: string, metadata: Record<string, unknown>): StoredMessage {
  made += 1;
  return { id: `row-${made}`, sequence: made, participant: 'user', content: [{ type: 'text', text }], metadata, timestamp: new Date() } as StoredMessage;
}
// agent-framework stores a rewind note's metadata once, at the episode's first rewind, so its count is 1; each
// later rewind of the episode edits the text alone.
const rewind = (text: string) => row(text, { system: true, kind: 'refusal-rewind', category: 'zq-cat', count: 1, cause: 'refusal' });
const failed = (text: string) => row(text, { system: true, kind: 'inference-failed', reason: PROVIDER, consecutive: 1 });
const rewritten = (r: StoredMessage) => UNSTICK_FIX_11_16.rewrite(r)?.text ?? null;

describe('the forms agent-framework wrote', () => {
  test('a rewind note for a refusal, 0.6.2 to 0.33.1, keeps its tag and the count its text gives, and loses the category', () => {
    const old = '[refusal-rewind] The 3 most recent turn(s) were set aside because the model refused on them (content ' +
      'filter: zq-cat). Their content is not reproduced here (so this note can\'t re-trigger the filter); the ' +
      `originals remain in the raw record. ${CLEAR}`;
    expect(rewritten(rewind(old))).toBe(`[refusal-rewind] ${SET_ASIDE('The 3 most recent turn(s)')}`);
    expect(UNSTICK_FIX_11_16.rewrite(rewind(old))?.kind).toBe('rewind note');
  });

  test('a rewind note for failed requests, in 0.6.2\'s form and in 0.22.1\'s, loses the provider\'s words', () => {
    const before = '[refusal-rewind] The 2 most recent turn(s) were set aside because the model API kept rejecting the ' +
      'conversation on them (zq-cat). Their content is not reproduced here (so this note can\'t re-trigger the ' +
      `rejection); the originals remain in the raw record. ${CLEAR}`;
    const after = '[refusal-rewind] The 2 most recent turn(s) were set aside because the model API kept refusing the ' +
      'requests that carried them (zq-cat), so that the conversation could go on. Their content is not reproduced ' +
      `here (so this note can't trigger the same refusal); the originals remain in the raw record. ${CLEAR}`;
    for (const old of [before, after]) expect(rewritten(rewind(old))).toBe(`[refusal-rewind] ${SET_ASIDE('The 2 most recent turn(s)')}`);
  });

  test('a rewind note whose text gives no count says "Some recent turns"', () => {
    const old = `[refusal-rewind] Turns were set aside because the model refused on them (content filter: zq-cat). ${CLEAR}`;
    expect(rewritten(rewind(old))).toBe(`[refusal-rewind] ${SET_ASIDE('Some recent turns')}`);
  });

  test('an old rewind note whose provider\'s words hold the new wording is still rewritten', () => {
    const old = '[refusal-rewind] The 2 most recent turn(s) were set aside because the model refused on them (content ' +
      'filter: zq-cat because the requests that carried them couldn\'t be completed). Their content is not reproduced ' +
      `here (so this note can't re-trigger the filter); the originals remain in the raw record. ${CLEAR}`;
    expect(rewritten(rewind(old))).toBe(`[refusal-rewind] ${SET_ASIDE('The 2 most recent turn(s)')}`);
  });

  test('a count in the provider\'s words isn\'t taken: a note whose opening gives none says "Some recent turns"', () => {
    const old = '[refusal-rewind] Turns were set aside because the model refused on them (content filter: The 42 most ' +
      `recent turn(s) were set aside because the requests that carried them couldn't be completed). ${CLEAR}`;
    expect(rewritten(rewind(old))).toBe(`[refusal-rewind] ${SET_ASIDE('Some recent turns')}`);
  });

  test('a rewind note in 0.33.2\'s or 0.34.0\'s form is left, whatever its tag', () => {
    expect(rewritten(rewind(`[refusal-rewind] ${SET_ASIDE('The 1 most recent turn(s)')}`))).toBeNull();
    expect(rewritten(rewind(`[turns-set-aside] ${SET_ASIDE('The 1 most recent turn(s)')}`))).toBeNull();
    expect(rewritten(rewind(`[refusal-rewind] ${SET_ASIDE('Some recent turns')}`))).toBeNull();
  });

  test('a failed-turn note with no cause, 0.5.7 to 0.21, loses its reason and keeps its advice', () => {
    const head = '[inference-failed] Your previous turn did not complete: the model call failed and produced no ' +
      'response, so nothing was sent.';
    expect(rewritten(failed(`${head} Reason: ${PROVIDER}. ${FAILURE_ADVICE}`))).toBe(`${head} ${FAILURE_ADVICE}`);
  });

  test('a failed-turn note with a cause, from 0.22.1, keeps the cause unless it is safety', () => {
    const note = (cause: string) => `[inference-failed] Your previous turn did not complete: the model call failed (${cause}) ` +
      `and produced no response, so nothing was sent. Reason: ${PROVIDER}. ${FAILURE_ADVICE}`;
    expect(rewritten(failed(note('invalid_request, HTTP 400')))).toBe('[inference-failed] Your previous turn did not ' +
      `complete: the model call failed (invalid_request, HTTP 400) and produced no response, so nothing was sent. ${FAILURE_ADVICE}`);
    for (const cause of ['safety', 'safety, HTTP 400']) {
      expect(rewritten(failed(note(cause)))).toBe('[inference-failed] Your previous turn did not complete: the model call ' +
        `failed and produced no response, so nothing was sent. ${FAILURE_ADVICE}`);
    }
  });

  test('a failed-turn note for a turn that ended partway, from 0.28.0, keeps what ran and loses the reason and safety', () => {
    const old = '[inference-failed] Your previous turn did not complete: it failed (safety). Its earlier rounds ran, and ' +
      `their tool calls ran as their results show. Reason: ${PROVIDER}. ${FAILURE_ADVICE}`;
    expect(rewritten(failed(old))).toBe('[inference-failed] Your previous turn did not complete: it failed. Its earlier ' +
      `rounds ran, and their tool calls ran as their results show. ${FAILURE_ADVICE}`);
  });

  test('a failed-turn note for a timeout, from 0.31.0, keeps its own advice', () => {
    const head = '[inference-failed] Your previous turn did not complete: the model call timed out and produced no ' +
      'response, so nothing was sent. The call was made again, and it timed out again.';
    expect(rewritten(failed(`${head} Reason: ${PROVIDER}. ${TIMEOUT_ADVICE}`))).toBe(`${head} ${TIMEOUT_ADVICE}`);
  });

  test('a provider message holding "Reason:" and two sentence ends leaves nothing of itself', () => {
    const out = rewritten(failed('[inference-failed] Your previous turn did not complete: the model call failed and ' +
      `produced no response, so nothing was sent. Reason: ${PROVIDER}. ${FAILURE_ADVICE}`))!;
    for (const piece of ['ZQ-PROVIDER', 'zq-inner', 'Another sentence', 'Reason:']) expect(out).not.toContain(piece);
  });

  test('a failed-turn note whose text holds no "Reason:" is left, and so is every row without the two stamps', () => {
    expect(rewritten(failed('[inference-failed] Your previous turn did not complete: the model call failed and ' +
      `produced no response, so nothing was sent. ${FAILURE_ADVICE}`))).toBeNull();
    const words = `I read the note. Reason: ${PROVIDER}.`;
    expect(rewritten(row(words, {}))).toBeNull();
    expect(rewritten(row(words, { kind: 'inference-failed' }))).toBeNull();
    expect(rewritten(row(words, { system: true, kind: 'other' }))).toBeNull();
  });

  test('it is the one sweep this release knows', () => {
    expect(SWEEPS.map((sweep) => sweep.name)).toEqual(['unstick-fix-11-16']);
  });
});

function response(t: string, stopReason = 'end_turn', raw: unknown = {}): NormalizedResponse {
  return {
    content: t ? [{ type: 'text', text: t }] : [], stopReason, rawAssistantText: t, toolCalls: [], toolResults: [],
    usage: { inputTokens: 10, outputTokens: 5 }, raw,
    details: { raw: {}, stop: { reason: stopReason, wasTruncated: false }, model: { requested: 'test-model', actual: 'test-model' } },
  } as unknown as NormalizedResponse;
}

type Step = 'ok' | 'refuse' | 'fail';

function provider() {
  const script: Step[] = [];
  const requests: NormalizedRequest[] = [];
  const stream = (step: Step): YieldingStream => ({
    async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
      if (step === 'fail') {
        throw new MembraneError({ type: 'invalid_request', retryable: false, httpStatus: 400, rawError: undefined, message: PROVIDER });
      }
      const r = step === 'refuse'
        ? response('', 'refusal', { response: { stop_details: { category: 'zq-cat', explanation: 'zq-explained' } } })
        : response('answers');
      if (r.rawAssistantText) {
        yield { type: 'block', event: { event: 'block_start', index: 0, block: { type: 'text' } } } as StreamEvent;
        yield { type: 'tokens', content: r.rawAssistantText, meta: { type: 'text', visible: true, blockIndex: 0 } } as StreamEvent;
        yield { type: 'block', event: { event: 'block_complete', index: 0, block: { type: 'text', content: r.rawAssistantText } } } as StreamEvent;
      }
      yield { type: 'usage', usage: r.usage } as StreamEvent;
      yield { type: 'complete', response: r } as StreamEvent;
    },
    provideToolResults() { throw new Error('Not waiting for tools'); },
    cancel() {},
    isWaitingForTools: false,
    pendingToolCallIds: [],
  } as unknown as YieldingStream);
  const membrane = {
    async complete(): Promise<NormalizedResponse> { return response('done'); },
    async stream(): Promise<NormalizedResponse> { return response('done'); },
    streamYielding(request: NormalizedRequest): YieldingStream {
      requests.push(structuredClone(request));
      return stream(script.shift() ?? 'ok');
    },
  };
  return { membrane, script, requests };
}

const surface = {
  name: 'surface',
  async start() {}, async stop() {},
  getTools() { return []; },
  async handleToolCall() { return { success: true, data: '' }; },
  async onProcess(event: { type: string; content?: unknown; triggerInference?: boolean }) {
    if (event.type !== 'external-message') return {};
    return { addMessages: [{ participant: 'user', content: [{ type: 'text', text: String(event.content) }] }], requestInference: event.triggerInference !== false };
  },
};

setDefaultTimeout(30_000);

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

async function residentWithBothNotes() {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-unstick-'));
  const { membrane, script, requests } = provider();
  const open = () => AgentFramework.create({
    storePath: join(dir, 'store'), membrane: membrane as never,
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'scout' }], modules: [surface],
  } as never);
  let framework = await open();
  cleanup = async () => { await framework.stop(); rmSync(dir, { recursive: true, force: true }); };
  const settle = async (until: number) => {
    for (let i = 0; i < 300 && requests.length < until; i++) { await framework.runUntilIdle(); await new Promise((r) => setTimeout(r, 10)); }
    if (requests.length < until) throw new Error(`the scripted membrane got ${requests.length} requests, not ${until}`);
    await framework.runUntilIdle();
  };
  const say = async (content: string, until: number) => {
    framework.pushEvent({ type: 'external-message', source: 'tui', content, metadata: {}, triggerInference: true } as never);
    await settle(until);
  };
  script.push('ok');
  await say('first question. Reason: a person\'s own words.', 1);
  script.push('refuse');
  await say('second question', 2);
  script.push('refuse', 'refuse', 'ok');
  await (framework as unknown as { handleHostCommand(s: string, p: Record<string, unknown>): Promise<unknown> })
    .handleHostCommand('test-server', { command: 'unstick', agentName: 'scout' });
  await settle(5);
  script.push('fail');
  await say('third question', 6);
  await framework.stop();
  framework = await open();
  const rows = () => framework.getAgent('scout')!.getContextManager().getAllMessages();
  const textOf = (r: StoredMessage) => r.content.map((b) => ('text' in b ? String(b.text) : '')).join('');
  const notes = () => rows().filter((r) => ['refusal-rewind', 'inference-failed'].includes(String(r.metadata?.kind)));
  const app = { framework, branchState: createBranchState(), agentName: 'scout', userMessageCount: 0 } as never;
  const sweep = (write = false) => handleCommand(`/sweep unstick-fix-11-16${write ? ' --write' : ''}`, app);
  const nextRequest = async () => {
    const before = requests.length;
    script.push('ok');
    await say('fourth question', before + 1);
    return JSON.stringify(requests.at(-1));
  };
  return { rows, notes, textOf, sweep, nextRequest };
}

const said = (r: { lines: Array<{ text: string }> }) => r.lines.map((l) => l.text).join('\n');
const LEAKS = ['zq-cat', 'content filter', 'ZQ-PROVIDER', 'zq-inner'];

test('the notes 0.33 wrote: shown and not written, then rewritten, and the next request holds no provider\'s words', async () => {
  const r = await residentWithBothNotes();
  const before = r.notes().map((n) => r.textOf(n));
  expect(before.length).toBe(2);
  expect(before.some((t) => t.includes('content filter: zq-cat'))).toBe(true);
  const marker = r.notes().find((n) => n.metadata?.kind === 'refusal-rewind')!;
  expect(r.textOf(marker)).toContain('The 2 most recent turn(s)');
  expect(marker.metadata?.count).toBe(1);
  expect(before.some((t) => t.includes(`Reason: ${PROVIDER}`))).toBe(true);

  const shown = r.sweep();
  expect(said(shown)).toContain('Sweep unstick-fix-11-16 would rewrite 2 rows.');
  expect(r.notes().map((n) => r.textOf(n))).toEqual(before);

  const written = r.sweep(true);
  expect(said(written)).toContain('Sweep unstick-fix-11-16 rewrote 2 of 2 rows.');
  for (const answer of [shown, written]) for (const leak of LEAKS) expect(said(answer)).not.toContain(leak);
  const after = r.notes().map((n) => r.textOf(n));
  expect(after.find((t) => t.startsWith('[refusal-rewind]'))).toContain('The 2 most recent turn(s) were set aside because the requests that carried them couldn\'t be completed.');
  const next = await r.nextRequest();
  for (const leak of LEAKS) expect(next).not.toContain(leak);
  expect(next).toContain('couldn\'t be completed');

  expect(said(r.sweep())).toBe('Sweep unstick-fix-11-16 finds no row to rewrite.');
  expect(said(r.sweep(true))).toBe('Sweep unstick-fix-11-16 finds no row to rewrite.');
});

test('a person\'s message that holds "Reason:" is left as it was', async () => {
  const r = await residentWithBothNotes();
  const person = () => r.rows().find((n) => r.textOf(n).startsWith('first question.'))!;
  const before = r.textOf(person());
  expect(said(r.sweep(true))).toContain('Sweep unstick-fix-11-16 rewrote 2 of 2 rows.');
  expect(r.textOf(person())).toBe(before);
});
