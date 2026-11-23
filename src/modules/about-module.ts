import type {
  AgentFramework,
  EventResponse,
  McpServerInfo,
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '@animalabs/agent-framework';
import { hostVersionLine, packageVersionsLine, type HostVersions } from '../bug-report.js';
import { unknownToolResult } from './unknown-tool.js';

type ServerRow = ReturnType<AgentFramework['listMcplServers']>[number];

export function nameAndVersion(info: McpServerInfo): string {
  return `${info.name ?? '(no name)'} ${info.version ?? '(no version)'}`;
}

export function serverVersionLines(rows: readonly ServerRow[]): string[] {
  if (rows.length === 0) return ['No MCPL server is loaded.'];
  return rows.map((row) => {
    if (row.connected) return `${row.id}: ${row.serverInfo ? nameAndVersion(row.serverInfo) : 'connected, and it gave no name or version'}`;
    return row.serverInfo
      ? `${row.id}: ${nameAndVersion(row.serverInfo)} (not connected now)`
      : `${row.id}: not connected, so its name and version aren't known`;
  });
}

export class AboutModule implements Module {
  readonly name = 'about';
  private framework: AgentFramework | null = null;

  constructor(private readonly versions: HostVersions) {}

  setFramework(framework: AgentFramework): void {
    this.framework = framework;
  }

  async start(_ctx: ModuleContext): Promise<void> {}

  async stop(): Promise<void> {
    this.framework = null;
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  getTools(): ToolDefinition[] {
    return [];
  }

  getUtilities(): ToolDefinition[] {
    return [{
      name: 'versions',
      description:
        'The versions this host runs: its own and its Connectome packages\', as the host started with them, ' +
        'and each MCPL server\'s own name and version, as the server gave them when it connected.',
      inputSchema: { type: 'object', properties: {} },
    }];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    if (call.name !== 'versions') return unknownToolResult(this, call.name);
    const lines = [hostVersionLine(this.versions.host), packageVersionsLine(this.versions.packages)];
    lines.push(...(this.framework
      ? serverVersionLines(this.framework.listMcplServers())
      : ['The MCPL servers can\'t be listed right now.']));
    return { success: true, data: lines.join('\n') };
  }
}
