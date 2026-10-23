/**
 * What the Health view and the Context page say about an agent's context
 * composition and its last inference, and which of their parts each shows.
 * The composition is the render stats of the agent's last live compile, the
 * one a turn makes; a preview's dry compile leaves them as they were.
 * context-manager keeps them only for a strategy that keeps render stats,
 * and only from a live compile since the agent's context was loaded, at the
 * host's start or a session or branch switch. So where there are none, these
 * say which of the two it is.
 */
import { healthEntry } from '@conhost/web/health-lookup';
import type { ContextComposition, HealthSnapshot } from './Health';

/** What an agent with no composition shows, by whether its strategy keeps
 *  render stats at all. */
export function noComposition(statsKept: boolean): string {
  return statsKept ? 'No live compile since its context was loaded.' : "This agent's strategy keeps no composition.";
}

/** An agent's composition as either view shows it: its stats as a block,
 *  or, where there are none, the line saying why. */
export type CompositionView<S> = { stats: S } | { line: string };

/** The composition's stats where there are any, else the line for an agent
 *  whose strategy keeps them or one whose strategy keeps none. */
export function compositionView<S>(stats: S | null | undefined, statsKept: boolean): CompositionView<S> {
  return stats ? { stats } : { line: noComposition(statsKept) };
}

/** What the Health view shows for an agent's composition, from `/healthz`:
 *  nothing where the `contextComposition` section is absent from the
 *  snapshot; nothing either where the agent's own read of it failed, which
 *  the view's failure line names; else
 *  its entry's stats, or the line, by whether `contextCompositionNotKept`
 *  names the agent. Each map is read by own key (healthEntry). */
export function healthComposition(
  health: Pick<HealthSnapshot, 'contextComposition' | 'contextCompositionNotKept' | 'readFailures'> | null | undefined,
  name: string,
): CompositionView<ContextComposition> | null {
  if (health?.contextComposition == null) return null;
  if (healthEntry(healthEntry(health.readFailures, name), 'contextComposition') !== undefined) return null;
  return compositionView(healthEntry(health.contextComposition, name), !(health.contextCompositionNotKept ?? []).includes(name));
}

/** The fields of `/debug/context/makeup` the Context page chooses by. */
export interface MakeupFigures<S> {
  stats: S | null;
  statsKept?: boolean;
  exactTotalTokens: number | null;
  countModel: string;
  countSource: string;
}

/** What the Context page shows from a makeup response: the next request's
 *  exact count and the model it was counted for, or why it wasn't counted;
 *  and the composition, its stats or the line. A response without
 *  `statsKept` is taken as a strategy that keeps them. */
export function contextPageView<S>(makeup: MakeupFigures<S>): {
  count: { tokens: number; model: string } | { reason: string };
  composition: CompositionView<S>;
} {
  return {
    count: makeup.exactTotalTokens != null
      ? { tokens: makeup.exactTotalTokens, model: makeup.countModel }
      : { reason: notCounted(makeup.countSource) },
    composition: compositionView(makeup.stats, makeup.statsKept !== false),
  };
}

/** An agent's last inference as the framework reports it: when each
 *  inference started and ended, and when one failed. Each is kept until the
 *  next of its kind, so a failure stays after later inferences. */
export interface LastInference {
  startedAt?: number;
  endedAt?: number;
  failedAt?: number;
}

/** What the agent's latest inference did: failed, if a failure came at or
 *  after its start; else started, while it hasn't ended since; else ended.
 *  A failure in the latest start's millisecond can be that inference's or
 *  the one before's, and the record can't tell which. An inference that
 *  fails before any request can fail in its own start's millisecond (in a
 *  run that made a stream's start throw, 22 of 40 did); one could also start
 *  in the millisecond of the one before's failure, which no run has shown.
 *  Whichever way a tie is read, one of the two cases reads wrong until the
 *  next inference starts: read as the latest's, an inference that then
 *  succeeds shows "failed", with the earlier failure's error; read the other
 *  way, a fast failure doesn't show as failed. This reads it as the latest's,
 *  the case seen to happen. An end in the latest start's millisecond is read
 *  as that inference's too; read wrong, it shows "ended" only until the
 *  inference in flight ends or fails. Null when the framework reports none. */
export function lastInferenceState(last: LastInference | null | undefined): { word: 'failed' | 'started' | 'ended'; at: number } | null {
  const { startedAt, endedAt, failedAt } = last ?? {};
  if (failedAt !== undefined && (startedAt === undefined || failedAt >= startedAt)) return { word: 'failed', at: failedAt };
  if (startedAt === undefined) return null;
  if (endedAt === undefined || endedAt < startedAt) return { word: 'started', at: startedAt };
  return { word: 'ended', at: endedAt };
}

/** The Health view's last-inference line, with `ago` saying how long ago a
 *  time was, or null where the framework reports none. */
export function lastInferenceLine(last: LastInference | null | undefined, ago: (at: number) => string): string | null {
  const state = lastInferenceState(last);
  return state ? `last inference: ${state.word} ${ago(state.at)}` : null;
}

/** The error the Health view shows on its `last error:` line: the latest
 *  inference's, only while that inference is the one that failed (as
 *  lastInferenceState reads it). agent-framework sets `lastError` with
 *  `failedAt` and keeps both until the next failure, so after a later
 *  success it would be an old error. Undefined where there's none to show,
 *  including an observer's snapshot whose failure text came empty. */
export function latestInferenceError(last: (LastInference & { lastError?: string }) | null | undefined): string | undefined {
  return lastInferenceState(last)?.word === 'failed' && last?.lastError ? last.lastError : undefined;
}

/** Why the Context page has no exact count of the next request, from the
 *  makeup endpoint's `countSource`. */
export function notCounted(countSource: string): string {
  if (countSource === 'count_tokens_unsupported_model') return "not counted: count_tokens doesn't take this agent's model";
  const failed = /^count_tokens_failed_(\d+)$/.exec(countSource);
  if (failed) return `not counted: count_tokens answered ${failed[1]}`;
  if (countSource === 'count_tokens_error') return 'not counted: the count_tokens call failed';
  if (countSource === 'count_tokens') return 'not counted: count_tokens answered with no count';
  return `not counted (${countSource})`;
}
