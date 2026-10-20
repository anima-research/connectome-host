/**
 * A styled line of a command's output, as the TUI prints it and the Web UI
 * shows it. It has a module of its own, importing nothing, because the web
 * app's typecheck reaches it through src/web/protocol.ts: a line type kept in
 * src/commands.ts brought that module and the host modules it imports into
 * the web app's program.
 */
export type Line = { text: string; style?: 'user' | 'agent' | 'tool' | 'system' };
