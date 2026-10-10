/**
 * Reading agent-framework's usage samples.
 *
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
 * reads and writes outside it, so one call's prompt is its fresh input plus its
 * cache reads and writes.
 */

/** A usage sample as the trace events carry it. Membrane leaves a cache count
 *  out until a call in the stream reports one. */
export interface UsageSample {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
}

/** A sample's four counts, each present. */
export interface UsageCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** One sample folded against the previous sample of its stream. */
export interface UsageStep {
  /** The sample's counts: the stream's `previous` for its next sample. */
  total: UsageCounts;
  /** What the provider calls since the previous sample added. */
  added: UsageCounts;
  /** The prompt of the call this sample reports (fresh input plus cache reads
   *  and writes), which is the agent's context size at that call. Absent when
   *  the sample doesn't isolate one call: it added nothing (a completion
   *  repeating the last sample), or no earlier sample of its stream was there
   *  to compare with (a reader that joined late, or a new stream's sample). */
  prompt?: number;
}

/** The baseline of a stream that has just started. */
export function emptyUsage(): UsageCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
}

const count = (v: unknown): number => (typeof v === 'number' && v > 0 ? v : 0);

/**
 * Fold one sample against `previous`, the stream's last sample: `emptyUsage()`
 * from its `inference:started`, or undefined when the reader joined the stream
 * after it began (a reducer seeded without one, say). Then the whole sample is
 * counted, since none of it was. The counts only grow within a stream, so a
 * sample below `previous` in any count is a new stream's, and counts whole.
 * agent-framework's `cumulativeDelta` treats a counter that went back the same
 * way, count by count.
 */
export function foldUsageSample(previous: UsageCounts | undefined, sample: UsageSample): UsageStep {
  const total: UsageCounts = {
    input: count(sample.input),
    output: count(sample.output),
    cacheRead: count(sample.cacheRead),
    cacheCreation: count(sample.cacheCreation),
  };
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
