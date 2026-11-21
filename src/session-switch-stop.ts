import { drainNoticeHome } from './modules/notices-module.js';

/**
 * The notice home drains first, while the connector it sends through is still
 * open. agent-framework's `stop()` rejects after its whole teardown
 * when an MCP server's child couldn't be confirmed exited, naming each such
 * child and its server.
 */
export async function stopForSessionSwitch(
  framework: { stop(): Promise<void>; getModule?(name: string): unknown },
  targetSessionId: string,
  log: (line: string) => void = (line) => console.error(line),
): Promise<void> {
  try {
    await drainNoticeHome(framework);
    await framework.stop();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(
      `[framework] switching to session ${targetSessionId}: the current session's framework stopped, ` +
      `but its teardown failed: ${reason}. The switch goes on; a child named here may still be running.`,
    );
  }
}
