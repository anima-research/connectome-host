import { TURN_SETTLED_TRACES, traceError } from './turn-trace.js';

export type FailureStep =
  | { show: 'line'; text: string }
  | { show: 'count'; text: string; count: number }
  | { show: 'ended'; attempts: number; alone: boolean; errorType?: string };

export interface TurnFailures {
  onTrace(event: { type: string; agentName?: unknown; error?: unknown; errorType?: unknown }): FailureStep | null;
}

export function createTurnFailures(): TurnFailures {
  const runs = new Map<string, { text: string; count: number; attempts: number; retrying: boolean }>();
  return {
    onTrace(event) {
      const agent = typeof event.agentName === 'string' ? event.agentName : undefined;
      if (agent === undefined) return null;
      const run = runs.get(agent);
      if (event.type === 'inference:started') {
        if (run) run.retrying = true;
        return null;
      }
      if (event.type === 'inference:failed') {
        const text = traceError(event);
        if (run && run.text === text) {
          run.count++;
          run.attempts++;
          run.retrying = false;
          return { show: 'count', text, count: run.count };
        }
        runs.set(agent, { text, count: 1, attempts: (run?.attempts ?? 0) + 1, retrying: false });
        return { show: 'line', text };
      }
      if (!TURN_SETTLED_TRACES.has(event.type)) return null;
      runs.delete(agent);
      if (event.type !== 'inference:exhausted') return null;
      return {
        show: 'ended',
        attempts: run ? run.attempts + (run.retrying ? 1 : 0) : 1,
        alone: !run || run.retrying,
        ...(typeof event.errorType === 'string' ? { errorType: event.errorType } : {}),
      };
    },
  };
}

export function failureCountLine(text: string, count: number): string {
  return count > 1 ? `Error (×${count}): ${text}` : `Error: ${text}`;
}

export function turnEndedLine(step: { attempts: number; alone: boolean }, hint: string | undefined): string | undefined {
  if (!step.alone) return `Turn ended after ${step.attempts} attempt${step.attempts === 1 ? '' : 's'}.${hint ? ` ${hint}` : ''}`;
  const said = [step.attempts > 1 ? `${step.attempts} attempts in all.` : undefined, hint].filter((part) => part !== undefined);
  return said.length > 0 ? said.join(' ') : undefined;
}

export interface ShownLine {
  setText(text: string): void;
  readonly isDestroyed: boolean;
}

export interface FailureLines {
  show(agent: string, lead: string, step: Exclude<FailureStep, { show: 'ended' }>, add: (text: string) => ShownLine | undefined): void;
  clear(): void;
}

export function createFailureLines(): FailureLines {
  const held = new Map<string, { line: ShownLine; lead: string }>();
  return {
    show(agent, lead, step, add) {
      const shown = held.get(agent);
      if (step.show === 'count' && shown && !shown.line.isDestroyed) {
        shown.line.setText(`${shown.lead}${failureCountLine(step.text, step.count)}`);
        return;
      }
      const line = add(`${lead}${failureCountLine(step.text, step.show === 'count' ? step.count : 1)}`);
      if (line) held.set(agent, { line, lead });
      else held.delete(agent);
    },
    clear() {
      held.clear();
    },
  };
}
