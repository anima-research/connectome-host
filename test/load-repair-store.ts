import { AutobiographicalStrategy, ContextManager } from '@animalabs/context-manager';

const MODEL = { complete: async () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: 'x' }] }) } as never;

/** A store whose level-2 summary holds text and names an L1 that isn't
 *  there, so context-manager's load repair drops it (`names-missing`) and
 *  reports that it did. */
export async function makeRepairStore(path: string, namespace = 'agents/agent'): Promise<void> {
  const seed = new AutobiographicalStrategy({ adaptiveResolution: true, hierarchical: true, autoTickOnNewMessage: false, auditOnly: true });
  const manager = await ContextManager.open({ path, namespace, strategy: seed, membrane: MODEL });
  const ids: string[] = [];
  for (let i = 0; i < 40; i++) {
    ids.push(manager.addMessage(i % 2 ? 'agent' : 'user', [{ type: 'text', text: `message ${i} ` + 'w '.repeat(20) }]));
  }
  const internals = seed as unknown as { store: { setStateJson(id: string, value: unknown): void }; summariesStateId: string };
  internals.store.setStateJson(internals.summariesStateId, [
    { id: 'L1-a', level: 1, content: 's L1-a', tokens: 50, sourceLevel: 0, sourceIds: ids.slice(4, 14), sourceRange: { first: ids[4], last: ids[13] }, created: 1 },
    { id: 'L2-x', level: 2, content: 's L2-x', tokens: 50, sourceLevel: 1, sourceIds: ['L1-a', 'L1-gone'], sourceRange: { first: ids[4], last: ids[33] }, created: 1 },
  ]);
  manager.close();
}
