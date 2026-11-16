import type { StoredMessage } from '@animalabs/context-manager';
import type { Sweep } from './sweeps.js';

const SET_ASIDE = 'because the requests that carried them couldn\'t be completed';
const REWIND_REST = `were set aside ${SET_ASIDE}. Their content isn't shown here, and the originals remain in the raw ` +
  'record. You are clear to continue — if you were mid-task, take a different approach; otherwise carry on with ' +
  'whatever is now in front of you, or briefly acknowledge the gap and ask what\'s next.';
const FAILURE_ADVICE = 'If this recurs with the same cause, change approach rather than retrying identically ' +
  '(e.g. drop an oversized attachment or an unsupported setting).';
const TIMEOUT_ADVICE = 'If a reply is still owed from that turn, you can give it now.';
const REWIND_OPENING = /^\[[^\]]+\] (?:The (\d+) most recent turn\(s\)|Some recent turns) were set aside /;
const REASON = ' Reason: ';
const SAFETY_CAUSE = / \(safety(?:, HTTP \d+)?\)/;

function textOf(row: StoredMessage): string {
  return row.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
}

export const UNSTICK_FIX_11_16: Sweep = {
  name: 'unstick-fix-11-16',
  line: 'Takes the provider\'s words out of the rewind and failed-turn notes that agent-framework 0.33.1 and earlier ' +
    'wrote, as 0.33.2 writes them.',
  rewrite(row) {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    if (metadata.system !== true) return null;
    const text = textOf(row);
    if (metadata.kind === 'refusal-rewind') {
      const opening = REWIND_OPENING.exec(text);
      if (opening !== null && text.startsWith(SET_ASIDE, opening[0].length)) return null;
      const told = opening?.[1];
      const count = told === undefined ? 'Some recent turns' : `The ${told} most recent turn(s)`;
      return { kind: 'rewind note', text: `[refusal-rewind] ${count} ${REWIND_REST}` };
    }
    if (metadata.kind === 'inference-failed') {
      const at = text.indexOf(REASON);
      if (at < 0) return null;
      const head = text.slice(0, at).replace(SAFETY_CAUSE, '');
      const advice = [FAILURE_ADVICE, TIMEOUT_ADVICE].find((each) => text.endsWith(each));
      return { kind: 'failed-turn note', text: advice === undefined ? head : `${head} ${advice}` };
    }
    return null;
  },
};
