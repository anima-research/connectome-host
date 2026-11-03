/**
 * A styled line of a command's output, as the TUI prints it and the Web UI
 * shows it.
 */
export type Line = { text: string; style?: 'user' | 'agent' | 'tool' | 'system' };
