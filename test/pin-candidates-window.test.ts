/**
 * The pin picker's candidates, which the pins snapshot carries for the
 * local scope and a fleet child's alike: rows of the agent's record that a
 * pin can hold. A row an undo took out of the agent's window
 * (agent-framework #291, windowStatusOf 'undone') isn't one, since the fold
 * plan a pin constrains is the window's (DQ-4), and neither is a row stamped
 * for other residents only (its audience leaves the agent out), which never
 * enters that window. A stored arrival not yet presented to the agent is
 * one: it enters the window at the agent's next turn.
 */
import { describe, expect, test } from 'bun:test';
import { bodyStart, type BodyShard } from '@animalabs/context-manager';
import { buildPinsSnapshot, type PanelAppRef } from '../src/web/panel-data.js';

function appOver(
  rows: Array<Record<string, unknown>>,
  statusOf: (agent: string, id: string) => string,
  agents: string[],
): PanelAppRef {
  const cmFor = (agent: string) => ({
    getMessageCount: () => rows.length,
    // context-manager's getMessageWindow: `alignToBodyGroups` walks the start
    // back to the first part of a message stored in parts.
    getMessageWindow: (offset: number, limit: number, opts?: { alignToBodyGroups?: boolean }) => {
      const start = opts?.alignToBodyGroups ? bodyStart((i) => rows[i] as BodyShard, offset) : offset;
      return { messages: rows.slice(start, offset + limit), startIndex: start };
    },
    windowStatusOf: (id: string) => statusOf(agent, id),
    listPins: () => [],
    pinRange: () => 'pin-1',
  });
  return {
    framework: { getAgent: (name: string) => (agents.includes(name) ? { name, getContextManager: () => cmFor(name) } : null) },
    recipe: { agent: {} },
  } as unknown as PanelAppRef;
}

const say = (id: string, participant: string, text: string, metadata?: Record<string, unknown>) =>
  ({ id, participant, content: [{ type: 'text', text }], ...(metadata ? { metadata } : {}) });

describe("a pins snapshot's candidates", () => {
  test("leave out a row an undo took out of the agent's window", () => {
    const rows = [
      say('m1', 'user', 'count the ledgers'),
      say('m2', 'clerk', 'three'),
      say('m3', 'user', 'thanks'),
    ];
    const app = appOver(rows, (_agent, id) => (id === 'm2' ? 'undone' : 'in'), ['clerk']);
    const snapshot = buildPinsSnapshot(app, 'clerk', { withCandidates: true });
    expect(snapshot.candidates?.map((c) => [c.id, c.index])).toEqual([['m1', 0], ['m3', 2]]);
  });

  // Host #485 bot review finding 21: with two residents on one store, the
  // other resident's own rows were offered, though a pin on one holds nothing
  // in this agent's window.
  test("leave out another resident's rows, and keep a row for both, an unstamped row and an arrival not yet presented", () => {
    const rows = [
      say('s1', 'user', 'count the ledgers', { audience: ['clerk', 'mira'] }),
      say('c1', 'clerk', 'three', { audience: ['clerk'], ownRowOf: 'clerk' }),
      say('r1', 'mira', 'four', { audience: ['mira'], ownRowOf: 'mira' }),
      say('r2', 'user', 'for mira alone', { audience: ['mira'] }),
      say('o1', 'user', 'a row stored before the stamp'),
      say('n1', 'user', 'a new arrival', { audience: ['clerk', 'mira'] }),
    ];
    const statusOf = (agent: string, id: string) => {
      if (id === 'n1') return 'out';
      const meta = rows.find((r) => r.id === id)?.metadata as { audience?: string[] } | undefined;
      return !meta?.audience || meta.audience.includes(agent) ? 'in' : 'out';
    };
    const app = appOver(rows, statusOf, ['clerk', 'mira']);
    const ids = (agent: string) => buildPinsSnapshot(app, agent, { withCandidates: true }).candidates?.map((c) => c.id);
    expect(ids('clerk')).toEqual(['s1', 'c1', 'o1', 'n1']);
    expect(ids('mira')).toEqual(['s1', 'r1', 'r2', 'o1', 'n1']);
  });

  // Host #485 bot review wave 2, finding 21: a message stored in parts (its
  // shards share a bodyGroupId) is one row in the transcript, and a pin on
  // any part of it covers the whole message, so it is one candidate.
  test('list a message stored in parts once, by its first part, with its whole text', () => {
    const part = (id: string, text: string, bodyGroupId: string, shardIndex: number) =>
      ({ ...say(id, 'user', text), bodyGroupId, shardIndex });
    const rows = [
      say('m1', 'user', 'read this'),
      part('p0', 'The ferry leaves ', 'g1', 0),
      part('p1', 'at noon, ', 'g1', 1),
      part('p2', 'and the bridge is closed.', 'g1', 2),
      // The same text ingested again is another message (context-manager's
      // continuesBody): its parts start again at 0.
      part('q0', 'The ferry leaves ', 'g1', 0),
      part('q1', 'at noon, ', 'g1', 1),
      part('q2', 'and the bridge is closed.', 'g1', 2),
      say('m2', 'clerk', 'noted'),
    ];
    const app = appOver(rows, () => 'in', ['clerk']);
    const snapshot = buildPinsSnapshot(app, 'clerk', { withCandidates: true });
    expect(snapshot.candidates?.map((c) => [c.id, c.index, c.text])).toEqual([
      ['m1', 0, 'read this'],
      ['p0', 1, 'The ferry leaves at noon, and the bridge is closed.'],
      ['q0', 4, 'The ferry leaves at noon, and the bridge is closed.'],
      ['m2', 7, 'noted'],
    ]);
  });

  // Host #485 bot review wave 3, finding 7: the record's last 200 rows began
  // at p1, so the picker listed p1 with only the rest of the text.
  test('list a message the last 200 rows start inside by its first part, with its whole text', () => {
    const part = (id: string, text: string, shardIndex: number) =>
      ({ ...say(id, 'user', text), bodyGroupId: 'g1', shardIndex });
    const filler = Array.from({ length: 199 }, (_, i) => say(`f${i}`, 'clerk', `row ${i}`));
    const rows = [
      say('m1', 'user', 'read this'),
      part('p0', 'The ferry leaves ', 0),
      part('p1', 'at noon, ', 1),
      ...filler,
    ];
    expect(rows.length - 200).toBe(2); // the 200 rows start at p1
    const app = appOver(rows, () => 'in', ['clerk']);
    const candidates = buildPinsSnapshot(app, 'clerk', { withCandidates: true }).candidates!;
    expect(candidates[0]).toEqual({ id: 'p0', index: 1, participant: 'user', text: 'The ferry leaves at noon, ' });
    expect(candidates.length).toBe(200);
  });

  // Host #485 bot review wave 3, finding 20: a read that failed came back as
  // an empty list, and the picker said the last 200 rows held no pinnable
  // message.
  test("are absent, with the reason, when the record can't be read", () => {
    const app = appOver([say('m1', 'user', 'count the ledgers')], () => {
      throw new Error('the window index is unreadable');
    }, ['clerk']);
    const snapshot = buildPinsSnapshot(app, 'clerk', { withCandidates: true });
    expect(snapshot.candidates).toBeUndefined();
    expect(snapshot.candidatesError).toBe('the window index is unreadable');
  });
});
