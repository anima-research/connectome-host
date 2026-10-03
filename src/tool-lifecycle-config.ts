/**
 * MCPL tool lifecycle (RFC-007) and tool classes (RFC-008): recipe and
 * mcpl-servers.json policy, validated here and handed to the framework.
 *
 * - `toolLifecycle` on a server entry is the operator's grant and narrowing
 *   for that server's `toolLifecycle.observe` / `.inputs` paths (both are
 *   denied by default in the framework; stating a block is the grant).
 * - `toolClassOverrides` (recipe top level) re-classes tools by name — the
 *   way to class third-party MCP servers that will never declare
 *   `_meta["mcpl/class"]` themselves (RFC-008 §5.1 source 1).
 * - HOST_TOOL_CLASSES is this host's own knowledge of the tools its modules
 *   expose (RFC-008 §5.1 source 2). agent-framework classes its own built-in
 *   tools; this table covers connectome-host's modules on top.
 *
 * The vocabulary is mirrored rather than imported so recipe validation does
 * not depend on the framework version installed (older ones lack it).
 */

/** RFC-008 §4. Amended only by MCPL spec change, never per deployment. */
export const TOOL_CLASSES = [
  'comms', 'memory', 'notes', 'files', 'shell', 'web', 'computer', 'media', 'body', 'control',
] as const;
export type ToolClass = (typeof TOOL_CLASSES)[number];

const CLASS_SET: ReadonlySet<string> = new Set(TOOL_CLASSES);

/**
 * Classes of connectome-host's module tools (`<module>--<tool>`, patterns in
 * the RFC-007 §6.2 grammar). A tool not matched here, not overridden by the
 * recipe and not declared by its server is UNCLASSED — the restrictive
 * answer (observers may see that it ran, never its arguments). So when in
 * doubt, a tool is left out rather than guessed.
 *
 * Not listed, on purpose:
 * - `identity--request` calls an arbitrary private service API (it can post
 *   as well as read), so no single class describes it.
 * - modules with no agent tools (webui, retrieval, instructions, tts-relay,
 *   tui, settings, subscription-gc).
 */
export const HOST_TOOL_CLASSES: Readonly<Record<string, readonly ToolClass[]>> = {
  // Presence: the typing/composition indicator policy.
  'activity--*': ['body'],
  // Routing and settings.
  'channel-mode--*': ['control'],
  'observers--*': ['control'],
  'time--*': ['control'],
  'mcpl-admin--*': ['control'],
  'subagent--*': ['control'],
  'identity--status': ['control'],
  'identity--accept_invite': ['control'],
  // Fleet: messages to and from other agents are other parties' words;
  // the rest is process control.
  'fleet--send': ['comms'],
  'fleet--relay': ['comms'],
  'fleet--peek': ['comms'],
  'fleet--*': ['control'],
  // The agent's own learned notes, recalled into context.
  'lessons--*': ['memory'],
};

export function isToolClass(value: unknown): value is ToolClass {
  return typeof value === 'string' && CLASS_SET.has(value);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isNonEmptyStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === 'string' && s.length > 0);

const NARROWING_KEYS = new Set(['tools', 'classes', 'conversations']);
const LIFECYCLE_KEYS = new Set(['observe', 'inputs', 'maxInputBytes']);

/**
 * Validate a server's `toolLifecycle` block. Throws with a message naming
 * `where` on anything malformed: these are grants, and the framework treats a
 * malformed narrowing as admitting nothing, so a typo would silently turn an
 * intended grant off — better to fail at load.
 */
export function validateToolLifecycle(value: unknown, where: string): void {
  if (!isPlainObject(value)) throw new Error(`${where} must be an object`);
  for (const key of Object.keys(value)) {
    if (!LIFECYCLE_KEYS.has(key)) {
      throw new Error(`${where} has unknown field ${JSON.stringify(key)} (expected observe, inputs, maxInputBytes)`);
    }
  }
  for (const leaf of ['observe', 'inputs'] as const) {
    const n = value[leaf];
    if (n === undefined) continue;
    const at = `${where}.${leaf}`;
    if (!isPlainObject(n)) {
      throw new Error(
        `${at} must be a narrowing object ({} for no narrowing); omit it to leave the path denied`,
      );
    }
    for (const key of Object.keys(n)) {
      if (!NARROWING_KEYS.has(key)) {
        throw new Error(`${at} has unknown field ${JSON.stringify(key)} (expected tools, classes, conversations)`);
      }
    }
    if (n.tools !== undefined && !isNonEmptyStringArray(n.tools)) {
      throw new Error(`${at}.tools must be an array of non-empty patterns`);
    }
    if (n.conversations !== undefined && !isNonEmptyStringArray(n.conversations)) {
      throw new Error(`${at}.conversations must be an array of non-empty patterns`);
    }
    if (n.classes !== undefined && n.classes !== 'default') {
      if (!Array.isArray(n.classes) || n.classes.length === 0 || !n.classes.every(isToolClass)) {
        throw new Error(`${at}.classes must be "default" or a non-empty array of: ${TOOL_CLASSES.join(', ')}`);
      }
    }
  }
  const max = value.maxInputBytes;
  if (max !== undefined && !(typeof max === 'number' && Number.isInteger(max) && max > 0)) {
    throw new Error(`${where}.maxInputBytes must be a positive integer`);
  }
}

/** Validate a pattern → classes table (recipe `toolClassOverrides`). */
export function validateToolClassTable(value: unknown, where: string): void {
  if (!isPlainObject(value)) throw new Error(`${where} must be an object of pattern → classes`);
  for (const [pattern, classes] of Object.entries(value)) {
    if (!pattern) throw new Error(`${where} has an empty pattern`);
    if (!Array.isArray(classes) || classes.length === 0 || !classes.every(isToolClass)) {
      throw new Error(
        `${where}[${JSON.stringify(pattern)}] must be a non-empty array of: ${TOOL_CLASSES.join(', ')}`,
      );
    }
  }
}

/**
 * The FrameworkConfig fields for tool classes: this host's module table
 * (as `hostToolClasses`, consulted before the framework's built-ins) and the
 * recipe's `toolClassOverrides`. Returned as a plain object for spreading.
 */
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
