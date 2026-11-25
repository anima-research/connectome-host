/**
 * MCPL tool lifecycle (RFC-007) and tool classes (RFC-008). agent-framework
 * denies a server's `toolLifecycle.observe` and `.inputs` paths by default;
 * stating a block is the grant.
 */

/** RFC-008 §4. Amended only by MCPL spec change, never per deployment. */
export const TOOL_CLASSES = [
  'comms', 'memory', 'notes', 'files', 'shell', 'web', 'computer', 'media', 'body', 'control',
] as const;
export type ToolClass = (typeof TOOL_CLASSES)[number];

const CLASS_SET: ReadonlySet<string> = new Set(TOOL_CLASSES);

/**
 * Patterns in the RFC-007 §6.2 grammar. A tool not matched here, not
 * overridden by the recipe and not declared by its server is unclassed,
 * which agent-framework handles as the most restrictive class (RFC-008 §5.2).
 */
export const HOST_TOOL_CLASSES: Readonly<Record<string, readonly ToolClass[]>> = {
  'activity--*': ['body'],
  'channel-mode--*': ['control'],
  'observers--*': ['control'],
  'time--*': ['control'],
  'mcpl-admin--*': ['control'],
  'subagent--*': ['control'],
  'identity--status': ['control'],
  'identity--accept_invite': ['control'],
  'fleet--send': ['comms'],
  'fleet--relay': ['comms'],
  'fleet--peek': ['comms'],
  'fleet--*': ['control'],
  'lessons--*': ['memory'],
};

export function isToolClass(value: unknown): value is ToolClass {
  return typeof value === 'string' && CLASS_SET.has(value);
}

export function toolClassConfig(recipe: { toolClassOverrides?: Record<string, string[]> }): {
  hostToolClasses: Record<string, string[]>;
  toolClassOverrides?: Record<string, string[]>;
} {
  const hostToolClasses: Record<string, string[]> = {};
  for (const [pattern, classes] of Object.entries(HOST_TOOL_CLASSES)) hostToolClasses[pattern] = [...classes];
  return {
    hostToolClasses,
    ...(recipe.toolClassOverrides ? { toolClassOverrides: recipe.toolClassOverrides } : {}),
  };
}

export type ToolClassSource = 'override' | 'host' | 'server' | 'none';

export interface ToolClassRow {
  tool: string;
  class: string[];
  source: ToolClassSource;
  serverId?: string;
}

export const TOOL_CLASS_SOURCE_LABELS: Readonly<Record<ToolClassSource, string>> = {
  override: 'operator override',
  host: 'host table',
  server: 'server _meta',
  none: 'unclassed',
};

export function readToolClasses(framework: unknown, agentName?: string): ToolClassRow[] | null {
  const fw = framework as { listToolClasses?: (agent?: string) => ToolClassRow[] } | null;
  if (typeof fw?.listToolClasses !== 'function') return null;
  const rows = agentName === undefined ? fw.listToolClasses() : fw.listToolClasses(agentName);
  return rows
    .map((r) => ({
      tool: r.tool,
      class: [...r.class],
      source: r.source,
      ...(r.serverId !== undefined ? { serverId: r.serverId } : {}),
    }))
    .sort((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));
}

export function countToolClassSources(rows: readonly ToolClassRow[]): Record<ToolClassSource, number> {
  const counts: Record<ToolClassSource, number> = { override: 0, host: 0, server: 0, none: 0 };
  for (const r of rows) counts[r.source] = (counts[r.source] ?? 0) + 1;
  return counts;
}

export function formatToolClassRows(rows: readonly ToolClassRow[]): string[] {
  const counts = countToolClassSources(rows);
  const summary = (Object.keys(TOOL_CLASS_SOURCE_LABELS) as ToolClassSource[])
    .filter((source) => counts[source] > 0)
    .map((source) => `${counts[source]} ${TOOL_CLASS_SOURCE_LABELS[source]}`)
    .join(' · ');
  const classText = (r: ToolClassRow): string => (r.class.length > 0 ? r.class.join(',') : '-');
  const toolWidth = Math.min(48, Math.max(0, ...rows.map((r) => r.tool.length)));
  const classWidth = Math.max(0, ...rows.map((r) => classText(r).length));
  const lines = [summary];
  for (const r of rows) {
    const source = TOOL_CLASS_SOURCE_LABELS[r.source] ?? r.source;
    const server = r.serverId !== undefined ? ` (${r.serverId})` : '';
    lines.push(`${r.tool.padEnd(toolWidth)}  ${classText(r).padEnd(classWidth)}  ${source}${server}`);
  }
  return lines;
}
