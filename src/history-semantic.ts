import type { RecipeModules } from './recipe.js';

/** First agent-framework release whose HistoryModule offers `semantic_search`. */
export const SEMANTIC_SEARCH_MIN_AF = '0.20.0';

type HistoryRecipe = RecipeModules['history'];

export interface HistorySemanticOptions {
  semantic?: {
    url: string;
    token?: string;
    namespace: string;
    syncIntervalMs?: number;
    maxSyncPerTick?: number;
    maxSyncBeforeSearch?: number;
    includePrivateTools?: boolean;
  };
}

/**
 * CM message ids are sequential per store and the index keys items by id, so
 * two stores sharing a namespace overwrite each other. The session id is
 * therefore ALWAYS the last path segment; a recipe `namespace` is only a
 * prefix (default: the agent name).
 */
export function historyModuleOptions(history: HistoryRecipe, agentName: string, sessionId: string): HistorySemanticOptions {
  const sem = typeof history === 'object' && history ? history.semantic : undefined;
  if (!sem) return {};
  const out: NonNullable<HistorySemanticOptions['semantic']> = {
    url: sem.url,
    namespace: `${sem.namespace ?? agentName}/${sessionId}`,
  };
  if (sem.token !== undefined) out.token = sem.token;
  if (sem.syncIntervalMs !== undefined) out.syncIntervalMs = sem.syncIntervalMs;
  if (sem.maxSyncPerTick !== undefined) out.maxSyncPerTick = sem.maxSyncPerTick;
  if (sem.maxSyncBeforeSearch !== undefined) out.maxSyncBeforeSearch = sem.maxSyncBeforeSearch;
  if (sem.includePrivateTools !== undefined) out.includePrivateTools = sem.includePrivateTools;
  return { semantic: out };
}

/**
 * An older agent-framework silently drops the constructor argument and offers
 * no semantic_search. Fail startup instead, naming the version needed.
 */
export function assertSemanticSearchRegistered(
  module: { getTools(): Array<{ name: string }> },
  semanticConfigured: boolean,
): void {
  if (!semanticConfigured) return;
  if (module.getTools().some((t) => t.name === 'semantic_search')) return;
  throw new Error(
    'modules.history.semantic is configured, but the installed HistoryModule offers no semantic_search tool. ' +
    `It needs @animalabs/agent-framework >= ${SEMANTIC_SEARCH_MIN_AF}; reinstall dependencies (bun install / npm install).`,
  );
}

const TAILSCALE_IPV6_ULA = /^fd7a:115c:a1e0:/;

export function isLoopbackOrTailnetHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  if (h.endsWith('.ts.net')) return true;
  if (TAILSCALE_IPV6_ULA.test(h)) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || (a === 100 && b >= 64 && b <= 127);
}
