import type { CallLedgerRow } from '../../src/web/protocol.js';

/** Labels used by the compact Health call table. */
const labels: Record<CallLedgerRow['originEstimate'], string> = {
  'turn~': 'turn',
  'aux~': 'compr',
  keepalive: 'keepalive',
};

export function callOriginLabel(origin: CallLedgerRow['originEstimate']): string {
  return labels[origin];
}
