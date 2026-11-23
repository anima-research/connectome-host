import { stopFramework, type StoppableFramework } from './stop-framework.js';

/**
 * The notice home gets a bounded drain before connector teardown.
 * agent-framework's `stop()` rejects after its whole teardown
 * when an MCP server's child couldn't be confirmed exited, naming each such
 * child and its server.
 */
export async function stopForSessionSwitch(
  framework: StoppableFramework,
  targetSessionId: string,
  log: (line: string) => void = (line) => console.error(line),
): Promise<void> {
  try {
    await stopFramework(framework);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(
      `[framework] switching to session ${targetSessionId}: the current session's framework stopped, ` +
      `but its teardown failed: ${reason}. The switch goes on; a child named here may still be running.`,
    );
  }
}
