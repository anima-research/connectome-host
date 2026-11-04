import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CANARY, SUMMARY } from './standin.mjs';
import { namingCanaries } from './names.mjs';

export async function readStore({ installDir, storePath, namespace, isolate = false }) {
  const cmEntry = join(installDir, 'node_modules', '@animalabs', 'context-manager', 'dist', 'src', 'index.js');
  const { ContextManager, AutobiographicalStrategy } = await import(pathToFileURL(cmEntry).href);
  const strategy = new AutobiographicalStrategy({ adaptiveResolution: true, autoTickOnNewMessage: false, topologyPolicy: 'report', auditOnly: true });
  // context-manager 0.24.0's `ContextManager.open` locks the store and opens it with `openOrCreate`, so a caller passes a copy.
  const cm = await ContextManager.open({ path: storePath, namespace, strategy, ...(isolate ? { isolate: true } : {}) });
  try {
    const messages = cm.getAllMessages().map(storedEntry);
    const ids = cm.getSummariesInRange({}).map((s) => s.id);
    if (ids.length === 0) throw new Error(`no summaries in ${namespace} at ${storePath}, from a configuration that compresses; it holds ${messages.length} message(s)${messages.length ? `, first carrying ${messages.find((m) => m.canaries.length)?.canaries[0] ?? 'no canary'}` : ''}`);
    const entries = new Map();
    for (const id of ids) {
      const s = cm.getSummary(id);
      if (!s) throw new Error(`getSummary(${id}) is null, though getSummariesInRange lists it`);
      entries.set(id, s);
    }
    const byMessage = new Map(messages.map((m) => [m.id, m]));
    const leaves = (s, seen = new Set()) => {
      if (seen.has(s.id)) return [];
      seen.add(s.id);
      if (s.sourceLevel === 0) return s.sourceIds;
      return s.sourceIds.flatMap((id) => {
        const child = entries.get(id) ?? cm.getSummary(id);
        if (!child) throw new Error(`summary ${s.id}'s source ${id} can't be read`);
        return leaves(child, seen);
      });
    };
    const summaries = [...entries.values()].map((s) => ({
      id: s.id,
      level: s.level,
      sourceLevel: s.sourceLevel,
      sourceIds: s.sourceIds,
      number: (String(s.content ?? '').match(SUMMARY) ?? [null])[0],
      covers: leaves(s).flatMap((id) => byMessage.get(id)?.canaries ?? []),
    }));
    const violations = strategy.getTopologyViolations().map((v) => `L${v.level} ${v.id}: ${v.leafCount} leaves ${v.span.first}..${v.span.last}, ${v.holes} hole(s) e.g. ${v.holeSample.join(',')}${v.holeOwners.length ? ` owned by ${v.holeOwners.join(',')}` : ''}`);
    return { messages, summaries, violations };
  } finally {
    await cm.close();
  }
}

const textOf = (content) => (Array.isArray(content) ? content : [content]).map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? b.text : b?.type === 'tool_result' ? JSON.stringify(b.content) : '')).join('');

export function storedEntry(m) {
  return {
    id: m.id,
    participant: m.participant,
    canaries: textOf(m.content).match(CANARY) ?? [],
    nameCanary: namingCanaries(m.content)[0],
    ...(m.participant === 'Context Manager' && (Array.isArray(m.content) ? m.content : []).some((b) => b?.type === 'text' && b.text.startsWith('[Topic Transition]')) ? { topicTransition: true } : {}),
    ...(m.bodyGroupId ? { bodyGroupId: m.bodyGroupId, shardIndex: m.shardIndex } : {}),
  };
}
