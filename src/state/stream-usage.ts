/**
 * `inference:usage` and `inference:completed` carry a stream's usage so far,
 * not one provider call's. Membrane's `TurnUsageAccumulator.addRound` adds
 * each call into the stream's totals, the stream emits the sum after each
 * call, and agent-framework forwards it unchanged ("Membrane usage events are
 * cumulative across the native/XML tool loop", in its `driveStream`). Each
 * stream begins with `inference:started`, a context-budget or physical-window
 * restart and the tool-result guard's retry included, and counts from zero
 * again.
 *
 * `input` is the calls' fresh input alone: membrane reports usage with cache
 * reads and writes outside it, so one call's prompt is its fresh input plus
 * its cache reads and writes. That holds for an adapter that declares its
 * cache convention. Membrane passes an `unknown` adapter's counts through
 * unchanged, and where that input already includes the cached span, the
 * prompt counts the span twice.
 */

/** Membrane can leave a cache count out of a sample; the fold reads a
 *  missing count and 0 alike, as no tokens. */
export interface UsageSample {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
}

export interface UsageCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface UsageStep {
  total: UsageCounts;
  added: UsageCounts;
  prompt?: number;
}

export function emptyUsage(): UsageCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
}

const count = (v: unknown): number => (typeof v === 'number' && v > 0 ? v : 0);

function counts(sample: UsageSample): UsageCounts {
  return {
    input: count(sample.input),
    output: count(sample.output),
    cacheRead: count(sample.cacheRead),
    cacheCreation: count(sample.cacheCreation),
  };
}

export function foldUsageSample(previous: UsageCounts | undefined, sample: UsageSample): UsageStep {
  const total = counts(sample);
  previous = previous && counts(previous);
  if (
    !previous
    || total.input < previous.input
    || total.output < previous.output
    || total.cacheRead < previous.cacheRead
    || total.cacheCreation < previous.cacheCreation
  ) {
    return { total, added: { ...total } };
  }
  const added: UsageCounts = {
    input: total.input - previous.input,
    output: total.output - previous.output,
    cacheRead: total.cacheRead - previous.cacheRead,
    cacheCreation: total.cacheCreation - previous.cacheCreation,
  };
  const prompt = added.input + added.cacheRead + added.cacheCreation;
  return prompt > 0 ? { total, added, prompt } : { total, added };
}
