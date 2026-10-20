/**
 * The fields of a workspace `read` result that the file viewers show: the
 * web UI's (`WebUiModule.sendWorkspaceFileRead`) and a fleet child's
 * (`request-workspace-file` in headless.ts). Both call the workspace module's
 * `read` directly and draw a page from these fields.
 *
 * Today's workspace answers with them in `data`. A result can also carry an
 * object in `structured` beside its content: anima-research/agent-framework#262
 * adds that field to `ToolResult`, and agent-framework 0.22.x doesn't have it.
 * A `read` that gave the model its page as text would put that text in
 * `data`, as a list of text blocks, and these fields in `structured`. So the
 * fields are read from `structured` when it's there, and from `data`
 * otherwise. `structured` comes first because in that shape `data` is the
 * list of text blocks.
 */
export interface WorkspaceReadFields {
  path?: string;
  totalLines?: number;
  fromLine?: number;
  toLine?: number;
  content?: string;
}

/** A `read` result as the viewers receive it from `handleToolCall`. */
export interface WorkspaceReadResult {
  data?: unknown;
  structured?: unknown;
}

export function workspaceReadFields(result: WorkspaceReadResult): WorkspaceReadFields {
  return (result.structured ?? result.data ?? {}) as WorkspaceReadFields;
}
