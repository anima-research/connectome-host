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
    const matchingResult = results[0] as { toolUseId: string; content: string };
    expect(matchingResult.toolUseId).toBe('toolu_B');
    expect(matchingResult.content).toContain('Two parallel streams of you');
    expect(matchingResult.content).toContain('the self reading this is the fork');
    expect(matchingResult.content).toContain('B');  // the task / intention
    expect(matchingResult.content).not.toContain('Running in background');
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
    const result = last.content[0] as { type: string; toolUseId: string; content: string };
    expect(result.type).toBe('tool_result');
    expect(result.toolUseId).toBe('toolu_B');
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

// ---------------------------------------------------------------------------
// Fragility audit Jul 2026, 2.2: when the matching tool_result had to be
// SYNTHESISED (parent's tool_results not yet in compiled context), non-fork
// sibling tool_uses (e.g. a subagent--peek issued alongside the forks) were
// preserved in the assistant turn WITHOUT any matching tool_result — a
// guaranteed API 400 on the fork's first inference.
// ---------------------------------------------------------------------------

/** Collect all tool_use ids and tool_result toolUseIds in a materialised history. */
function collectToolIds(msgs: Msg[]): { toolUseIds: string[]; resultIds: string[] } {
  const toolUseIds: string[] = [];
  const resultIds: string[] = [];
  for (const m of msgs) {
    for (const b of m.content) {
      if (b.type === 'tool_use') toolUseIds.push((b as { id: string }).id);
      if (b.type === 'tool_result') resultIds.push((b as { toolUseId: string }).toolUseId);
    }
  }
  return { toolUseIds, resultIds };
}

describe('materialiseStructuralFork — orphaned tool_use protection (audit 2.2)', () => {
  test('synthesised result turn: sibling non-fork tool_uses without results are stripped', () => {
    const compiled: Msg[] = [
      asstText('researcher', 'Dispatching.'),
      {
        participant: 'researcher',
        content: [
          { type: 'tool_use', id: 'toolu_peek', name: 'subagent--peek', input: {} },
          { type: 'tool_use', id: 'toolu_A', name: 'subagent--fork', input: { name: 'scout-a', task: 'A' } },
          { type: 'tool_use', id: 'toolu_B', name: 'subagent--fork', input: { name: 'scout-b', task: 'B' } },
        ],
      },
      // No user turn — the parent's tool_results haven't landed in compiled
      // context yet; the matching result must be synthesised.
    ];

    const out = materialiseStructuralFork(compiled, 'toolu_B', 'scout-b', 'B', 1, 3);
    expect(out).not.toBeNull();

    // Invariant: every tool_use in the materialised history has a matching
    // tool_result (this is what the API enforces with a 400 otherwise).
    const { toolUseIds, resultIds } = collectToolIds(out!);
    for (const id of toolUseIds) {
      expect(resultIds).toContain(id);
    }

    // The peek sibling had no result to pair with — it must be gone.
    expect(JSON.stringify(out)).not.toContain('toolu_peek');

    // The matching fork tool_use + intention-framed result survive.
    expect(toolUseIds).toContain('toolu_B');
    const last = out![out!.length - 1];
    const result = last.content[0] as { type: string; toolUseId: string; content: string };
    expect(result.type).toBe('tool_result');
    expect(result.toolUseId).toBe('toolu_B');
    expect(result.content).toContain('the self reading this is the fork');
  });

  test('found result turn missing a sibling non-fork result: that tool_use is stripped too', () => {
    // The result turn exists but only carries the fork results — the peek's
    // result is absent (e.g. dropped by compression). Preserving the peek
    // tool_use would orphan it.
    const compiled: Msg[] = [
      {
        participant: 'researcher',
        content: [
          { type: 'tool_use', id: 'toolu_peek', name: 'subagent--peek', input: {} },
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
    ];

    const out = materialiseStructuralFork(compiled, 'toolu_A', 'scout-a', 'A', 1, 3);
    expect(out).not.toBeNull();

    const { toolUseIds, resultIds } = collectToolIds(out!);
    for (const id of toolUseIds) {
      expect(resultIds).toContain(id);
    }
    expect(toolUseIds).toEqual(['toolu_A']);
    expect(JSON.stringify(out)).not.toContain('toolu_peek');
  });

  test('sibling non-fork tool_use WITH a result is still preserved (regression guard)', () => {
    // Mirror of the pre-existing "peek calls etc. are preserved" test, kept
    // here to pin that the orphan-stripping did not over-strip: a sibling
    // with a matching result must survive.
    const compiled: Msg[] = [
      {
        participant: 'researcher',
        content: [
          { type: 'tool_use', id: 'toolu_peek', name: 'subagent--peek', input: {} },
          { type: 'tool_use', id: 'toolu_A', name: 'subagent--fork', input: { name: 'scout-a', task: 'A' } },
        ],
      },
      {
        participant: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'toolu_peek', content: 'no fleet running' },
          { type: 'tool_result', toolUseId: 'toolu_A', content: "Subagent 'scout-a' forked. Running in background." },
        ],
      },
    ];

    const out = materialiseStructuralFork(compiled, 'toolu_A', 'scout-a', 'A', 1, 3);
    expect(out).not.toBeNull();
    const { toolUseIds, resultIds } = collectToolIds(out!);
    expect(toolUseIds.sort()).toEqual(['toolu_A', 'toolu_peek']);
    for (const id of toolUseIds) {
      expect(resultIds).toContain(id);
    }
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
