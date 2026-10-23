/**
 * Which of agent-framework's traces end an agent's turn, for the host
 * surfaces that show a turn or wait on one. Typing (ActivityModule), the
 * TUI's status line, the Web UI's streaming message, piped mode's wait and
 * the interrupt follower (TurnInterrupts) read these sets; the TTS relay
 * switches over the same five ends, giving completed and turn_ended
 * 'complete', aborted 'abort', and failed and exhausted 'error'. Pure, so
 * the Web UI imports it too (`@conhost/state/turn-trace`).
 *
 * As agent-framework 0.22.3 and later send them, with what a later release
 * added named where it's described: `inference:started` opens an agent's
 * stream, and a turn's tool rounds stay inside that one stream. A budget
 * restart or a guard retry starts the stream again with another
 * `inference:started` and no end before it. Then one of five traces ends it:
 *   - `inference:completed`: the turn's normal end, which a turn a tool
 *     ended sends too.
 *   - `inference:turn_ended`: a tool ended the turn (skip_reply, sleep, a
 *     subagent's return), sent right after its `inference:completed`.
 *   - `inference:aborted`: a stop, such as an operator's `abortInference` or
 *     a cancel of the stream, a quiesce that abandons the turn, the framework
 *     stopping while the turn streams, or a turn the framework dropped after
 *     its `inference:started` (its agent replaced or removed, or the
 *     framework stopping or stopped and started again). Since agent-framework
 *     0.26.1 it also ends a turn whose continuation (a budget restart's, or a
 *     tool-result guard's retry) is dropped before it starts, by an abandon,
 *     a stop, the inference policy, the agent's removal or a conversation
 *     agent's disposal: then it comes with no `inference:started` since the
 *     turn's last stream ended.
 *   - `inference:failed`: the attempt failed. The framework then retries it
 *     (another `inference:started`), holds the turn for a provider's stated
 *     wait or cooldown and runs it again later, or gives up
 *     (`inference:exhausted`). A quiesce can abandon it instead, and the
 *     framework's stop cancels a retry it waits to send, each ending it with
 *     `inference:aborted`, or the framework drops it with no end (below).
 *   - `inference:exhausted`: the turn failed for good, after its
 *     `inference:failed`, or its stream was aborted for a reason other than a
 *     stop, with no `inference:failed` before it.
 *
 * A second end can follow the first: a turn a tool ended sends `completed`
 * and then `turn_ended`, and a failed attempt sends `failed` and then
 * `exhausted`, or `aborted` when a quiesce abandons it or a stop cancels its
 * retry. A surface that shows a turn's state (a status line, a wait, a
 * notice, the relay) reads an end that follows an end as nothing new. A
 * stream panel, which shows each of a stream's events as it comes, shows
 * both.
 *
 * The second end comes before the turn releases its agent, and the
 * framework starts no next turn of the agent while the turn stands (its
 * turn-alive token, or, since agent-framework 0.26.1, its continuation on
 * its way to its start): so it follows the first with no start between, an
 * end after an end.
 *
 * Three cases send no end: a dropped turn when another turn of the agent's
 * name has already begun (abortDroppedTurn's token check,
 * anima-research/agent-framework#338); an ephemeral run that its idle
 * watchdog disposes; and a failed attempt whose held retry the framework
 * drops when its agent is disposed or the coalesced wake it answers is
 * withdrawn. agent-framework 0.22.1 sent no end for any dropped turn, and
 * 0.22.2 none for a retry its stop cancelled.
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
 *  agent-framework 0.22.3 builds it from an Error's message, so it can be
 *  empty; anything but text with something in it reads as 'Unknown error'. */
export function traceError(event: object): string {
  const error = (event as { error?: unknown }).error;
  return typeof error === 'string' && error.trim() !== '' ? error : 'Unknown error';
}
