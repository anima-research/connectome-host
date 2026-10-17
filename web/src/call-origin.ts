import type { CallLedgerRow } from '../../src/web/protocol.js';

/** Labels used by the compact Health call table. */
const labels: Record<CallLedgerRow['originEstimate'], string> = {
  'turn~': 'turn',
  'aux~': 'compr',
  keepalive: 'keepalive',
};

/** Each origin's text colour in that table, as its legend names them. */
const tones: Record<CallLedgerRow['originEstimate'], string> = {
  'turn~': 'text-cyan-400',
  'aux~': 'text-orange-400',
  keepalive: 'text-neutral-400',
};

export function callOriginLabel(origin: CallLedgerRow['originEstimate']): string {
  return labels[origin];
}

export function callOriginTone(origin: CallLedgerRow['originEstimate']): string {
  return tones[origin];
}
