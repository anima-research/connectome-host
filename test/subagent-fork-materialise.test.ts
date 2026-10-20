/**
 * Tests for materialiseStructuralFork — the fork-context transformation that
 * addresses the fork-cascade bug surfaced in data-08.05.
 *
 * The cascade: when the parent issues several subagent--fork tool_uses in one
 * assistant turn, each child used to inherit the parent's full compiled
 * context — including sibling fork tool_use blocks, sibling tool_results,
 * and the parent's post-fork peek/wait turns. The overwhelming "fleet of
 * forks just got dispatched" signal convinced each child it was the parent,
 * and they cascaded by re-issuing the fork list.
 *
 * Fix (here): at fork-materialise time, locate the matching tool_use by id,
 * strip sibling fork tool_uses and their results, rewrite the matching
 * tool_result with intention-stream framing, and drop everything after.
 */
import { describe, test, expect } from 'bun:test';
import type { ContentBlock } from '@animalabs/membrane';
import { materialiseStructuralFork, buildIntentionFramedForkResult } from '../src/modules/subagent-module.js';

interface Msg { participant: string; content: ContentBlock[]; }

function userText(text: string): Msg {
  return { participant: 'user', content: [{ type: 'text', text }] };
}
function asstText(name: string, text: string): Msg {
  return { participant: name, content: [{ type: 'text', text }] };
}

describe('materialiseStructuralFork', () => {
  test('returns null when the matching tool_use is absent (compressed away)', () => {
    const compiled: Msg[] = [
      userText('go investigate things'),
      asstText('researcher', 'On it.'),
    ];
    const out = materialiseStructuralFork(compiled, 'toolu_missing', 'scout-a', 'do a thing', 1, 3);
    expect(out).toBeNull();
  });

  test('strips sibling fork tool_use blocks and rewrites the matching tool_result', () => {
    const compiled: Msg[] = [
      userText('go investigate things'),
      {
        participant: 'researcher',
        content: [
          { type: 'text', text: 'Dispatching scouts.' },
          { type: 'tool_use', id: 'toolu_A', name: 'subagent--fork', input: { name: 'scout-a', task: 'A' } },
          { type: 'tool_use', id: 'toolu_B', name: 'subagent--fork', input: { name: 'scout-b', task: 'B' } },
          { type: 'tool_use', id: 'toolu_C', name: 'subagent--fork', input: { name: 'scout-c', task: 'C' } },
        ],
      },
      {
        participant: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'toolu_A', content: "Subagent 'scout-a' forked. Running in background." },
          { type: 'tool_result', toolUseId: 'toolu_B', content: "Subagent 'scout-b' forked. Running in background." },
          { type: 'tool_result', toolUseId: 'toolu_C', content: "Subagent 'scout-c' forked. Running in background." },
        ],
      },
    ];

    const out = materialiseStructuralFork(compiled, 'toolu_B', 'scout-b', 'B', 1, 3);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(3);

    // Pre-fork history preserved.
    expect(out![0]).toEqual(compiled[0]);

    // Fork assistant turn keeps text + only the matching tool_use.
    const asst = out![1];
    expect(asst.participant).toBe('researcher');
    const toolUses = asst.content.filter(b => b.type === 'tool_use');
    expect(toolUses.length).toBe(1);
    expect((toolUses[0] as { id: string }).id).toBe('toolu_B');
    // Text narrative preserved (it's not load-bearing for cascade and removing
    // it would be more invasive than necessary).
    expect(asst.content.some(b => b.type === 'text')).toBe(true);

    // tool_result turn: siblings stripped, matching one rewritten with intention framing.
    const resultTurn = out![2];
    const results = resultTurn.content.filter(b => b.type === 'tool_result');
    expect(results.length).toBe(1);
    const matchingResult = results[0] as { toolUseId: string; toolName?: string; content: string };
    expect(matchingResult.toolUseId).toBe('toolu_B');
    // Named, as agent-framework stores every result, for XML replay's <tool_name>.
    expect(matchingResult.toolName).toBe('subagent--fork');
    expect(matchingResult.content).toContain('Two parallel streams of you');
    expect(matchingResult.content).toContain('the self reading this is the fork');
    expect(matchingResult.content).toContain('B');  // the task / intention
    expect(matchingResult.content).not.toContain('Running in background');
  });

  test("an XML-mode turn's calls kept beside a removed sibling lose the round's raw text, which would replay the sibling", () => {
    const raw = '<function_calls><invoke name="subagent--fork">A</invoke><invoke name="subagent--fork">B</invoke>' +
      '<invoke name="read">r</invoke></function_calls>';
    const compiled: Msg[] = [
      userText('go'),
      {
        participant: 'researcher',
        content: [
          { type: 'tool_use', id: 'toolu_A', name: 'subagent--fork', input: { name: 'scout-a', task: 'A' }, rawXml: raw },
          { type: 'tool_use', id: 'toolu_B', name: 'subagent--fork', input: { name: 'scout-b', task: 'B' }, rawXml: raw },
          { type: 'tool_use', id: 'toolu_R', name: 'read', input: { path: 'r' }, rawXml: raw },
        ] as ContentBlock[],
      },
    ];
    const out = materialiseStructuralFork(compiled, 'toolu_B', 'scout-b', 'B', 1, 3)!;
    const kept = out[1].content as unknown as Array<{ id: string; rawXml?: string }>;
    expect(kept.map((b) => b.id)).toStrictEqual(['toolu_B', 'toolu_R']);
    for (const b of kept) expect('rawXml' in b).toBe(false);
    // The parent's own blocks are left as they were.
    expect((compiled[1].content[1] as unknown as { rawXml?: string }).rawXml).toBe(raw);
  });

  test('a turn with no sibling fork keeps its raw text, replayed as the model wrote it', () => {
    const raw = '<function_calls><invoke name="subagent--fork">B</invoke></function_calls>';
    const compiled: Msg[] = [
      userText('go'),
      {
        participant: 'researcher',
        content: [{ type: 'tool_use', id: 'toolu_B', name: 'subagent--fork', input: { name: 'scout-b', task: 'B' }, rawXml: raw }] as ContentBlock[],
      },
    ];
    const out = materialiseStructuralFork(compiled, 'toolu_B', 'scout-b', 'B', 1, 3)!;
    expect((out[1].content[0] as unknown as { rawXml?: string }).rawXml).toBe(raw);
  });

  test('drops post-fork tail (peek/wait/zombie messages)', () => {
    const compiled: Msg[] = [
      asstText('researcher', 'Dispatching.'),
      {
        participant: 'researcher',
        content: [
          { type: 'tool_use', id: 'toolu_A', name: 'subagent--fork', input: { name: 'scout-a', task: 'A' } },
          { type: 'tool_use', id: 'toolu_B', name: 'subagent--fork', input: { name: 'scout-b', task: 'B' } },
        ],
      },
      {
        participant: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'toolu_A', content: "Subagent 'scout-a' forked. Running in background." },
          { type: 'tool_result', toolUseId: 'toolu_B', content: "Subagent 'scout-b' forked. Running in background." },
        ],
      },
      // post-fork tail — parent peeking and waiting; child must NOT inherit any of this.
      {
        participant: 'researcher',
        content: [
          { type: 'text', text: 'Let me check on the scouts.' },
          { type: 'tool_use', id: 'toolu_peek', name: 'subagent--peek', input: {} },
        ],
      },
      {
        participant: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'toolu_peek', content: 'scout-a: running 5s, scout-b: running 5s' },
        ],
      },
      asstText('researcher', 'All 5 scouts are running. Standing by.'),
    ];

    const out = materialiseStructuralFork(compiled, 'toolu_B', 'scout-b', 'B', 1, 3);
    expect(out).not.toBeNull();
    // pre-fork (1) + matching assistant turn (1) + matching tool_result turn (1) = 3.
    expect(out!.length).toBe(3);

    // None of the post-fork tail should appear.
    const flatJson = JSON.stringify(out);
    expect(flatJson).not.toContain('toolu_peek');
    expect(flatJson).not.toContain('Let me check on the scouts');
    expect(flatJson).not.toContain('Standing by');
  });

  test('synthesises the matching tool_result when it is not yet in compiled context', () => {
    const compiled: Msg[] = [
      asstText('researcher', 'Dispatching scouts.'),
      {
        participant: 'researcher',
        content: [
          { type: 'tool_use', id: 'toolu_A', name: 'subagent--fork', input: { name: 'scout-a', task: 'A' } },
          { type: 'tool_use', id: 'toolu_B', name: 'subagent--fork', input: { name: 'scout-b', task: 'B' } },
        ],
      },
      // No user turn — parent's tool_results haven't been added to its
      // ContextManager yet (fork is being dispatched right now).
    ];

    const out = materialiseStructuralFork(compiled, 'toolu_B', 'scout-b', 'B', 1, 3);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(3);

    const last = out![out!.length - 1];
    expect(last.participant).toBe('user');
    const result = last.content[0] as { type: string; toolUseId: string; toolName?: string; content: string };
    expect(result.type).toBe('tool_result');
    expect(result.toolUseId).toBe('toolu_B');
    expect(result.toolName).toBe('subagent--fork');
    // The made message holds this call's result alone.
    expect(last.content.length).toBe(1);
    expect(result.content).toContain('the self reading this is the fork');
  });

  test('handles the single-fork case (no siblings) without breakage', () => {
    const compiled: Msg[] = [
      asstText('researcher', 'Dispatching one scout.'),
      {
        participant: 'researcher',
        content: [
          { type: 'text', text: 'Need a focused dive on the FTP server.' },
          { type: 'tool_use', id: 'toolu_only', name: 'subagent--fork', input: { name: 'scout-ftp', task: 'check ftp' } },
        ],
      },
      {
        participant: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'toolu_only', content: "Subagent 'scout-ftp' forked. Running in background." },
        ],
      },
    ];

    const out = materialiseStructuralFork(compiled, 'toolu_only', 'scout-ftp', 'check ftp', 1, 3);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(3);
    const result = out![2].content[0] as { content: string };
    expect(result.content).toContain('check ftp');
    expect(result.content).toContain('Two parallel streams of you');
  });

  test('non-fork tool_use blocks (peek calls etc.) in the fork assistant turn are preserved', () => {
    // Edge case: the parent's assistant turn might mix fork tool_uses with
    // other tool_uses (e.g. a status check). The non-fork tool_uses should
    // pass through unchanged so the matching tool_results stay valid.
    const compiled: Msg[] = [
      {
        participant: 'researcher',
        content: [
          { type: 'tool_use', id: 'toolu_peek_pre', name: 'subagent--peek', input: {} },
          { type: 'tool_use', id: 'toolu_A', name: 'subagent--fork', input: { name: 'scout-a', task: 'A' } },
          { type: 'tool_use', id: 'toolu_B', name: 'subagent--fork', input: { name: 'scout-b', task: 'B' } },
        ],
      },
      {
        participant: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'toolu_peek_pre', content: 'no fleet running' },
          { type: 'tool_result', toolUseId: 'toolu_A', content: "Subagent 'scout-a' forked. Running in background." },
          { type: 'tool_result', toolUseId: 'toolu_B', content: "Subagent 'scout-b' forked. Running in background." },
        ],
      },
    ];

    const out = materialiseStructuralFork(compiled, 'toolu_A', 'scout-a', 'A', 1, 3);
    expect(out).not.toBeNull();

    const asst = out![0];
    // peek + matching fork preserved; sibling fork stripped.
    const toolUseIds = asst.content.filter(b => b.type === 'tool_use').map(b => (b as { id: string }).id);
    expect(toolUseIds.sort()).toEqual(['toolu_A', 'toolu_peek_pre']);

    const resultTurn = out![1];
    const resultIds = resultTurn.content.filter(b => b.type === 'tool_result').map(b => (b as { toolUseId: string }).toolUseId);
    expect(resultIds.sort()).toEqual(['toolu_A', 'toolu_peek_pre']);
  });
});

describe('buildIntentionFramedForkResult', () => {
  test('includes the task verbatim and the dual-stream framing', () => {
    const text = buildIntentionFramedForkResult('scout-a', 'investigate the FTP server', 1, 3);
    expect(text).toContain('investigate the FTP server');
    expect(text).toContain('Two parallel streams');
    expect(text).toContain('the self reading this is the fork');
    expect(text).toContain('subagent--return');
  });

  test('flags max depth correctly', () => {
    const middle = buildIntentionFramedForkResult('x', 'y', 1, 3);
    expect(middle).toContain('2 sub-fork levels remaining');

    const atMax = buildIntentionFramedForkResult('x', 'y', 3, 3);
    expect(atMax).toContain('cannot sub-fork');
  });
});
