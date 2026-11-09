export function parseCommand(command: string): { name: string; rest: string } {
  const body = command.slice(1).trim();
  const match = /^(\S*)\s*([\s\S]*)$/.exec(body);
  return { name: match?.[1] ?? '', rest: match?.[2] ?? '' };
}
