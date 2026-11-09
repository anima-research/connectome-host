const pending: string[] = [];
const MAX_PENDING = 50;

export function noteRecipeWarning(warning: string): void {
  pending.push(warning);
  if (pending.length > MAX_PENDING) pending.shift();
}

export function takeRecipeWarnings(): string[] {
  return pending.splice(0);
}
