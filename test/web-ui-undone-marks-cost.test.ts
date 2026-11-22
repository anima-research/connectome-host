/**
 * The undone-marks frame's read (src/modules/web-ui-module.ts undoneRowIds),
 * which the host runs on its event loop at each undo, redo or shed on the
 * transcript agent's window while a client that holds messages is
 * connected. A row in the agent's window has an ordinal (context-manager's
 * ordinalOf), and an undone one is out of the window, so only rows with no
 * ordinal are asked their status, and of those, not a row stamped for other
 * residents only, which never enters the window.
 */
import { describe, expect, test } from 'bun:test';
import { undoneRowIds } from '../src/modules/web-ui-module.js';

// nissa's second reading of the #485 wave-2 answer, point 1: with 50,000
// rows the frame took 0.4 to 0.7 s, most of it in a windowStatusOf of every
// row.
describe("the undone-marks frame's read", () => {
  test('asks the status of the rows out of the window only, not of every row', () => {
    const rows = Array.from({ length: 50_000 }, (_, i) => ({ id: `r${i}`, participant: 'user', content: [] }));
    // An undo took out the last two rows; r10 arrived and isn't presented yet.
    const undone = new Set(['r49998', 'r49999']);
    const out = new Set(['r10']);
    const inWindow = (id: string) => !undone.has(id) && !out.has(id);
    const asked: string[] = [];
    const cm = {
      getAllMessages: () => rows,
      ordinalOf: (id: string) => (inWindow(id) ? Number(id.slice(1)) : undefined),
      windowStatusOf: (id: string) => {
        asked.push(id);
        return undone.has(id) ? 'undone' : out.has(id) ? 'out' : 'in';
      },
    };
    expect(undoneRowIds(cm, 'clerk')).toEqual(['r49998', 'r49999']);
    expect(asked).toEqual(['r10', 'r49998', 'r49999']);
  });

  // In the store the residents share, the listing is the whole slot's
  // record, and another resident's own rows have no ordinal in this
  // agent's window (#485 bot review 4, finding 2).
  test("doesn't ask the status of the rows stamped for other residents only", () => {
    const rows = Array.from({ length: 50_000 }, (_, i) => (i % 2 === 0
      ? { id: `c${i}`, participant: 'clerk', content: [], metadata: { audience: ['clerk'], ownRowOf: 'clerk' } }
      : { id: `m${i}`, participant: 'mira', content: [], metadata: { audience: ['mira'], ownRowOf: 'mira' } }));
    rows.push({ id: 'both', participant: 'user', content: [], metadata: { audience: ['clerk', 'mira'] } } as typeof rows[number]);
    const undone = new Set(['c49998', 'both']);
    const asked: string[] = [];
    const cm = {
      getAllMessages: () => rows,
      ordinalOf: (id: string) => (id.startsWith('c') && !undone.has(id) ? Number(id.slice(1)) : undefined),
      windowStatusOf: (id: string) => {
        asked.push(id);
        return undone.has(id) ? 'undone' : 'out';
      },
    };
    expect(undoneRowIds(cm, 'clerk')).toEqual(['c49998', 'both']);
    expect(asked).toEqual(['c49998', 'both']);
  });
});
