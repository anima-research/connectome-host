/**
 * Stops the current session's framework before a session switch.
 *
 * From agent-framework 0.23.0, `stop()` rejects after its whole teardown
 * when an MCP server's child couldn't be confirmed exited, naming each such
 * child and its server. The framework is stopped either way, so the switch
 * goes on and the rejection is logged. Letting it end the switch would leave
 * the old framework stopped and no new one started, with the agent gone
 * until the host restarts.
 */
export async function stopForSessionSwitch(
  framework: { stop(): Promise<void> },
  targetSessionId: string,
  log: (line: string) => void = (line) => console.error(line),
): Promise<void> {
  try {
    await framework.stop();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(
      `[framework] switching to session ${targetSessionId}: the current session's framework stopped, ` +
      `but its teardown failed: ${reason}. The switch goes on; a child named here may still be running.`,
    );
  }
}
