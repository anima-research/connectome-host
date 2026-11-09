/**
 * agent-framework's workspace answers a `read` with its page as text blocks in
 * `data` and these fields in `structured` (ToolResult.structured,
 * anima-research/agent-framework#262); a release without `structured` puts
 * the fields in `data`. So the fields are read from `structured` when it's
 * there, and from `data` otherwise.
 */
export interface WorkspaceReadFields {
  path?: string;
  totalLines?: number;
  fromLine?: number;
  toLine?: number;
  content?: string;
}

export interface WorkspaceReadResult {
  data?: unknown;
  structured?: unknown;
}

export function workspaceReadFields(result: WorkspaceReadResult): WorkspaceReadFields {
  return (result.structured ?? result.data ?? {}) as WorkspaceReadFields;
}
