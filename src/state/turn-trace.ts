/**
 * Which of agent-framework's traces end an agent's turn, for the host
 * surfaces that show a turn or wait on one. Typing (ActivityModule), the
 * TUI's status line, the Web UI's streaming message, piped mode's wait and
 * the interrupt follower (TurnInterrupts) read these sets; the TTS relay
 * switches over the same five ends, giving completed and turn_ended
 * 'complete', aborted 'abort', and failed and exhausted 'error'. Pure, so
 * the Web UI imports it too (`@conhost/state/turn-trace`).
 *
 * As agent-framework 0.22.2 sends them: `inference:started` opens an agent's
 * stream, and a turn's tool rounds stay inside that one stream. A budget
 * restart or a guard retry starts the stream again with another
 * `inference:started` and no end before it. Then one of five traces ends it:
 *   - `inference:completed`: the turn's normal end.
 *   - `inference:turn_ended`: a tool ended the turn (skip_reply, sleep, a
 *     subagent's return).
 *   - `inference:aborted`: an operator's `abortInference`, a quiesce that
 *     abandons the turn, or a turn the framework dropped after its
 *     `inference:started` (its agent replaced or removed, or the framework
 *     stopping or stopped and started again).
 *   - `inference:failed`: the attempt failed. The framework then retries it
 *     (another `inference:started`), holds the turn for a provider's stated
 *     wait or cooldown and runs it again later, or gives up
 *     (`inference:exhausted`); a quiesce can abandon it instead
 *     (`inference:aborted`), or the framework drops it with no end (below).
 *   - `inference:exhausted`: the turn failed for good, or something other
 *     than the framework itself aborted its stream.
 *
 * A second end can follow the first: `abortInference` sends `aborted` and
 * then `exhausted`, and a failure the framework gives up on sends `failed`
 * and then `exhausted`. A surface that shows a turn's state (a status line,
 * a wait, a notice, the relay) reads an end that follows an end as nothing
 * new. A stream panel, which shows each of a stream's events as it comes,
 * shows both.
 *
 * An abort's `exhausted` comes from the aborted stream's `aborted` event,
 * before the turn's `finally` releases it, and the framework starts no next
 * turn of the agent while the turn stands (its turn-alive token): so it
 * follows the abort with no start between, an end after an end.
 *
 * Three cases send no end: a dropped turn when another turn of the agent's
 * name has already begun (abortDroppedTurn's token check,
 * anima-research/agent-framework#338); an ephemeral run that its idle
 * watchdog disposes; and a failed attempt whose retry the framework drops,
 * which it does with a held one when its agent is disposed or the coalesced
 * wake it answers is withdrawn, and with any once it stops.
 * agent-framework 0.22.1 sent no end for any dropped turn.
 */

/** Every trace that ends a stream: the turn has stopped running, for now or
 *  for good. A surface that shows a turn as running stops showing it here. */
export const STREAM_END_TRACES: ReadonlySet<string> = new Set([
  'inference:completed',
  'inference:turn_ended',
  'inference:aborted',
  'inference:failed',
  'inference:exhausted',
]);

/** The stream ends after which nothing more of the turn runs.
 *  `inference:failed` is the one left out, since a retry or a held turn can
 *  still answer after it. A surface that waits for the turn's answer waits
 *  for one of these. */
export const TURN_SETTLED_TRACES: ReadonlySet<string> = new Set([
  'inference:completed',
  'inference:turn_ended',
  'inference:aborted',
  'inference:exhausted',
]);

/** The traces besides `inference:started` that only a running turn sends,
 *  each setting the TUI's status line to a running turn's: a tool call
 *  yielded, and the stream resumed after tool results. A surface that
 *  missed a turn's start, as at startup or around a session switch, follows
 *  the turn from these. */
export const TURN_RUNNING_TRACES: ReadonlySet<string> = new Set([
  'inference:tool_calls_yielded',
  'inference:stream_resumed',
]);

/** A failed or exhausted trace's error, as every surface prints it.
 *  agent-framework 0.22.2 builds it from an Error's message, so it can be
 *  empty; anything but text with something in it reads as 'Unknown error'. */
export function traceError(event: object): string {
  const error = (event as { error?: unknown }).error;
  return typeof error === 'string' && error.trim() !== '' ? error : 'Unknown error';
}
