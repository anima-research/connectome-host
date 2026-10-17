import type { AwarenessEntryWire, AwarenessMessage } from '../../src/web/protocol.js';

/** What the branch panel shows of the framework's awareness journal. */
export interface AwarenessView {
  entries: AwarenessEntryWire[];
  /** The framework instance the entries were listed from: every action chosen
   *  from them is bound to it. Null until a listing succeeds, and after one
   *  fails. */
  instance: string | null;
  /** The last action's outcome, or the last listing's failure. */
  result: { action?: string; target?: string; receipt?: Record<string, unknown>; error?: string } | null;
}

export const emptyAwarenessView: AwarenessView = { entries: [], instance: null, result: null };

/**
 * The view after an `awareness` frame: a listing (asked for, or broadcast
 * after a surgery or an action) or an action's answer, which lists the live
 * journal too. A listing that succeeds clears an earlier listing's failure,
 * and keeps an action's outcome on screen.
 */
export function applyAwarenessMessage(prev: AwarenessView, msg: AwarenessMessage): AwarenessView {
  const entries = msg.batches;
  const instance = msg.frameworkInstanceId ?? null;
  if (msg.action) {
    return { entries, instance, result: { action: msg.action, target: msg.target, receipt: msg.receipt, error: msg.error } };
  }
  if (msg.error) return { entries, instance, result: { error: msg.error } };
  return { entries, instance, result: prev.result?.action ? prev.result : null };
}
