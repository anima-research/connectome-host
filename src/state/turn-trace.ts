/**
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
 *     `inference:aborted`. Since agent-framework 0.27.0 a held turn whose
 *     retry is dropped, by an abandon, a stop, `abortInference`, the
 *     inference policy or a conversation agent's disposal, ends with
 *     `inference:aborted` too, and a later occurrence of a coalesced wake's
 *     subject leaves its retry held.
 *   - `inference:exhausted`: the turn failed for good, after its
 *     `inference:failed`, or its stream was aborted for a reason other than a
 *     stop, with no `inference:failed` before it.
 *
 * A second end can follow the first: a turn a tool ended sends `completed`
 * and then `turn_ended`, and a failed attempt sends `failed` and then
 * `exhausted`, or `aborted` when a quiesce abandons it, a stop cancels its
 * retry or its held retry is dropped. A surface that shows a turn's state (a status line, a wait, a
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
 * Two cases send no end, and each needs a later turn under the agent's name
 * to follow it, which the host never makes: a dropped turn when another
 * turn of the agent's name has already begun (abortDroppedTurn's token
 * check, anima-research/agent-framework#338), which takes a stop and start
 * of the same framework or a replacement agent object, where the host
 * starts each framework once and replaces no agent; and an ephemeral run
 * that its idle watchdog disposes, where each subagent's run has a name of
 * its own.
 */

export const STREAM_END_TRACES: ReadonlySet<string> = new Set([
  'inference:completed',
  'inference:turn_ended',
  'inference:aborted',
  'inference:failed',
  'inference:exhausted',
]);

/** `inference:failed` is the one left out, since a retry or a held turn
 *  can still answer after it. */
export const TURN_SETTLED_TRACES: ReadonlySet<string> = new Set([
  'inference:completed',
  'inference:turn_ended',
  'inference:aborted',
  'inference:exhausted',
]);

export const TURN_RUNNING_TRACES: ReadonlySet<string> = new Set([
  'inference:tool_calls_yielded',
  'inference:stream_resumed',
]);

/** agent-framework builds a failed or exhausted trace's error from an
 *  Error's message, so it can be empty. */
export function traceError(event: object): string {
  const error = (event as { error?: unknown }).error;
  return typeof error === 'string' && error.trim() !== '' ? error : 'Unknown error';
}
