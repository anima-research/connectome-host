/**
 * agent-framework hands any `<module>--<name>` call to that module's
 * handleToolCall, with the bare name, whether or not the module declares it.
 */

import type { ToolDefinition, ToolResult } from '@animalabs/agent-framework';

export interface ToolOffering {
  readonly name: string;
  getTools(): ToolDefinition[];
  getUtilities?(): ToolDefinition[];
  /** As agent-framework's Module.toolPlacement: `'builtin'` puts a tool in the built-in toolset. */
  toolPlacement?(toolName: string): 'header' | 'builtin' | undefined;
}

const SETTINGS = 'the built-in "settings" toolset';

export function settingsRoute(tool: string): string {
  return `toolsets--open {"toolset": "settings"}, then toolsets--act {"tool": "${tool}", "args": {...}}; ` +
    'if your tool list lacks toolsets--open or toolsets--act, call it by its name instead';
}

export function unknownToolResult(module: ToolOffering, called: string, also?: string): ToolResult {
  const full = (name: string) => `${module.name}--${name}`;
  const own = module.getTools();
  const listed = own.filter((t) => module.toolPlacement?.(t.name) !== 'builtin').map((t) => full(t.name));
  const inSettings = [
    ...own.filter((t) => module.toolPlacement?.(t.name) === 'builtin').map((t) => full(t.name)),
    ...(module.getUtilities?.() ?? []).filter((u) => !own.some((t) => t.name === u.name)).map((u) => full(u.name)),
  ];
  const parts = [`There's no tool ${JSON.stringify(full(called))}, so nothing ran.`];
  if (listed.length === 1) {
    parts.push(`The ${module.name} module's one tool is ${listed[0]}.`);
  } else if (listed.length > 1) {
    parts.push(`The ${module.name} tools are ${listOf(listed)}.`);
  }
  if (inSettings.length > 0) {
    const which = inSettings.length === 1
      ? `The ${module.name} module's one tool placed in ${SETTINGS} is ${inSettings[0]}`
      : `The ${module.name} tools placed in ${SETTINGS} are ${listOf(inSettings)}`;
    parts.push(`${which}: reach one with ${settingsRoute(inSettings[0])}.`);
  }
  if (listed.length === 0 && inSettings.length === 0) {
    parts.push(`The ${module.name} module has no tools of its own; call one of the tools listed for you.`);
  }
  if (also) parts.push(also);
  return { success: false, isError: true, error: parts.join(' ') };
}

function listOf(names: string[]): string {
  return names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
