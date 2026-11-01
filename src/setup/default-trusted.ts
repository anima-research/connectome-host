export type ManagerRun = (manager: string, args: string[], cwd: string) => Promise<{ status: number | null; output: string }>;

/**
 * Bun applies `bun pm default-trusted`'s list only to packages from npm's own registry, and a package.json's
 * `trustedDependencies` replaces it rather than adding to it (probed with Bun 1.4.4). Through a mirror or a company
 * registry, then, Bun runs none of those scripts, node-pty's build among them, unless the field names them; and a
 * field naming fewer stops some that an install from npm runs.
 */
export async function defaultTrusted(run: ManagerRun, cwd: string): Promise<string[] | { reason: string }> {
  let ran: { status: number | null; output: string };
  try {
    ran = await run('bun', ['pm', 'default-trusted'], cwd);
  } catch (error) {
    return { reason: `\`bun pm default-trusted\` couldn't run: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (ran.status !== 0) {
    return { reason: `\`bun pm default-trusted\` ${ran.status === null ? 'gave no exit status' : `exited ${ran.status}`}` };
  }
  const count = /^Default trusted dependencies \((\d+)\):$/m.exec(ran.output);
  const names = [...ran.output.matchAll(/^ - (\S+)$/gm)].map((match) => match[1]!);
  if (count === null || names.length === 0 || names.length !== Number(count[1])) {
    return {
      reason: `\`bun pm default-trusted\` printed ${names.length} names` +
        (count === null ? ' with no count of its own' : ` where it counted ${count[1]}`),
    };
  }
  return names;
}

export const HOST_TRUSTED = ['term-sessions-mcp'];
