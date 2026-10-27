/**
 * agent-framework hands any `<module>--<name>` call to that module's
 * handleToolCall, with the bare name, whether or not the module declares it.
 */

import type { ToolDefinition, ToolResult } from '@animalabs/agent-framework';

export interface ToolOffering {
  readonly name: string;
  getTools(): ToolDefinition[];
  getUtilities?(): ToolDefinition[];
}

export function unknownToolResult(module: ToolOffering, called: string, also?: string): ToolResult {
  const full = (name: string) => `${module.name}--${name}`;
  const tools = module.getTools().map((t) => full(t.name));
  const utilities = (module.getUtilities?.() ?? []).map((u) => full(u.name));
  const parts = [`There's no tool ${JSON.stringify(full(called))}, so nothing ran.`];
  if (tools.length === 1) {
    parts.push(`The ${module.name} module's one tool is ${tools[0]}.`);
  } else if (tools.length > 1) {
    parts.push(`The ${module.name} tools are ${listOf(tools)}.`);
  }
  if (utilities.length > 0) {
    const which = utilities.length === 1
      ? `The ${module.name} module's one utility is ${utilities[0]}`
      : `The ${module.name} utilities are ${listOf(utilities)}`;
    parts.push(
      `${which}, run through the utils tool with action "run" and the utility's name, ` +
      `such as {"action": "run", "name": "${utilities[0]}"}.`,
    );
  }
  if (tools.length === 0 && utilities.length === 0) {
    parts.push(`The ${module.name} module has no tools of its own; call one of the tools listed for you.`);
  }
  if (also) parts.push(also);
  return { success: false, isError: true, error: parts.join(' ') };
}

function listOf(names: string[]): string {
  return names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
