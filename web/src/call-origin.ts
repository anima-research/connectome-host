import type { CallLedgerRow } from '../../src/web/protocol.js';

const labels: Record<CallLedgerRow['originEstimate'], string> = {
  'turn~': 'turn',
  'aux~': 'compr',
  keepalive: 'keepalive',
};

const tones: Record<CallLedgerRow['originEstimate'], string> = {
  'turn~': 'text-cyan-400',
  'aux~': 'text-orange-400',
  keepalive: 'text-neutral-400',
};

export function callFailed(row: Pick<CallLedgerRow, 'error'>): boolean {
  return row.error !== undefined;
}

export function callOriginLabel(origin: CallLedgerRow['originEstimate']): string {
  return labels[origin];
}

export function callOriginTone(origin: CallLedgerRow['originEstimate']): string {
  return tones[origin];
}
