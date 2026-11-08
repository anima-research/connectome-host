/**
 * context-manager keeps render stats only for a strategy that keeps them, and
 * only from a live compile since the agent's context was loaded (the host's
 * start, a session or branch switch); a preview's dry compile leaves them as
 * they were. So where there are none, these say which of the two it is.
 */
import { healthEntry } from '@conhost/web/health-lookup';
import type { ContextComposition, HealthSnapshot } from './Health';

export function noComposition(statsKept: boolean): string {
  return statsKept ? 'No live compile since its context was loaded.' : "This agent's strategy keeps no composition.";
}

export type CompositionView<S> = { stats: S } | { line: string };

export function compositionView<S>(stats: S | null | undefined, statsKept: boolean): CompositionView<S> {
  return stats ? { stats } : { line: noComposition(statsKept) };
}

export function healthComposition(
  health: Pick<HealthSnapshot, 'contextComposition' | 'contextCompositionNotKept' | 'readFailures'> | null | undefined,
  name: string,
): CompositionView<ContextComposition> | null {
  if (health?.contextComposition == null) return null;
  if (healthEntry(healthEntry(health.readFailures, name), 'contextComposition') !== undefined) return null;
  return compositionView(healthEntry(health.contextComposition, name), !(health.contextCompositionNotKept ?? []).includes(name));
}

export interface MakeupFigures<S> {
  stats: S | null;
  statsKept?: boolean;
  exactTotalTokens: number | null;
  countModel: string;
  countSource: string;
}

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

/** As agent-framework reports them, each is kept until the next of its kind,
 *  so a failure stays after later inferences. */
export interface LastInference {
  startedAt?: number;
  endedAt?: number;
  failedAt?: number;
}

/** agent-framework stamps these in milliseconds, so a failure or an end in
 *  the latest start's millisecond can be that inference's or the one before's.
 *  An inference that fails before any request can fail in its own start's
 *  millisecond, so a tie is read as the latest inference's. */
export function lastInferenceState(last: LastInference | null | undefined): { word: 'failed' | 'started' | 'ended'; at: number } | null {
  const { startedAt, endedAt, failedAt } = last ?? {};
  if (failedAt !== undefined && (startedAt === undefined || failedAt >= startedAt)) return { word: 'failed', at: failedAt };
  if (startedAt === undefined) return null;
  if (endedAt === undefined || endedAt < startedAt) return { word: 'started', at: startedAt };
  return { word: 'ended', at: endedAt };
}

export function lastInferenceLine(last: LastInference | null | undefined, ago: (at: number) => string): string | null {
  const state = lastInferenceState(last);
  return state ? `last inference: ${state.word} ${ago(state.at)}` : null;
}

/** agent-framework sets `lastError` with `failedAt` and keeps both until the
 *  next failure, so after a later success it would be an old error. */
export function latestInferenceError(last: (LastInference & { lastError?: string }) | null | undefined): string | undefined {
  return lastInferenceState(last)?.word === 'failed' && last?.lastError ? last.lastError : undefined;
}

export function notCounted(countSource: string): string {
  if (countSource === 'count_tokens_unsupported_model') return "not counted: count_tokens doesn't take this agent's model";
  const failed = /^count_tokens_failed_(\d+)$/.exec(countSource);
  if (failed) return `not counted: count_tokens answered ${failed[1]}`;
  if (countSource === 'count_tokens_error') return 'not counted: the count_tokens call failed';
  if (countSource === 'count_tokens') return 'not counted: count_tokens answered with no count';
  return `not counted (${countSource})`;
}
