/**
 * How a slash command is read: its first character (normally `/`) dropped,
 * then its name is the first word and the rest is everything after that
 * word's whitespace. handleCommand (commands.ts) reads every command this
 * way, and anything that decides about a command before it runs (the fleet
 * tool's refusal of /bug) reads it the same way, so what it refuses is what
 * would run.
 */
export function parseCommand(command: string): { name: string; rest: string } {
  const body = command.slice(1).trim();
  const match = /^(\S*)\s*([\s\S]*)$/.exec(body);
  return { name: match?.[1] ?? '', rest: match?.[2] ?? '' };
}
