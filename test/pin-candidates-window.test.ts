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
import { buildPinsSnapshot, type PanelAppRef } from '../src/web/panel-data.js';

function appOver(
  rows: Array<Record<string, unknown>>,
  statusOf: (agent: string, id: string) => string,
  agents: string[],
): PanelAppRef {
  const cmFor = (agent: string) => ({
    getMessageCount: () => rows.length,
    getMessageWindow: (offset: number, limit: number) => ({ messages: rows.slice(offset, offset + limit), startIndex: offset }),
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
});
