/**
 * The pin picker's candidates for a scope whose messages the page doesn't
 * hold (a fleet child's), which the pins snapshot carries: rows of the
 * agent's record that a pin can hold. A row an undo took out of the agent's
 * window (agent-framework #291, windowStatusOf 'undone') isn't one, since the
 * fold plan a pin constrains is the window's (DQ-4). The local panel's
 * candidates leave out the transcript's undone rows the same way.
 */
import { describe, expect, test } from 'bun:test';
import { buildPinsSnapshot, type PanelAppRef } from '../src/web/panel-data.js';

describe("a pins snapshot's candidates", () => {
  test("leave out a row an undo took out of the agent's window", () => {
    const rows = [
      { id: 'm1', participant: 'user', content: [{ type: 'text', text: 'count the ledgers' }] },
      { id: 'm2', participant: 'clerk', content: [{ type: 'text', text: 'three' }] },
      { id: 'm3', participant: 'user', content: [{ type: 'text', text: 'thanks' }] },
    ];
    const cm = {
      getMessageCount: () => rows.length,
      getMessageWindow: (offset: number, limit: number) => ({ messages: rows.slice(offset, offset + limit), startIndex: offset }),
      windowStatusOf: (id: string) => (id === 'm2' ? 'undone' : 'in'),
      listPins: () => [],
      pinRange: () => 'pin-1',
    };
    const app = {
      framework: { getAgent: (name: string) => (name === 'clerk' ? { name, getContextManager: () => cm } : null) },
      recipe: { agent: {} },
    } as unknown as PanelAppRef;
    const snapshot = buildPinsSnapshot(app, 'clerk', { withCandidates: true });
    expect(snapshot.candidates?.map((c) => [c.id, c.index])).toEqual([['m1', 0], ['m3', 2]]);
  });
});
