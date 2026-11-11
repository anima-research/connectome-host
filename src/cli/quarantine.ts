import { dataDirOf, openSocket } from './host-socket.js';
import { quarantineSocketPath } from '../quarantine-socket-path.js';
import type { CliContext } from './connectome.js';

export const QUARANTINE_USAGE = 'connectome quarantine inspect <agent> [<full-key>] | ' +
  'release <agent> <full-key> <generation> <selection> <operation-UUID> --confirm "waive L1 hold <agent> <full-key> <generation> <selection> <operation-UUID>" | result <operation-UUID>';

/** No daemon start, grant, provider call, chat command or retry on a lost answer. */
export async function quarantine(ctx: CliContext): Promise<number> {
  const [verb, ...words] = ctx.argv;
  const key = /^[a-f0-9]{64}$/;
  const id = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  let request: Record<string, unknown>;
  if (verb === 'inspect' && (words.length === 1 || words.length === 2) && words[0] && (words[1] === undefined || key.test(words[1]))) {
    request = { type: 'quarantine-inspect', agent: words[0], ...(words[1] === undefined ? {} : { key: words[1] }) };
  } else if (verb === 'release' && words.length === 7 && words[0] && key.test(words[1]!) && words[2] &&
    id.test(words[3]!) && id.test(words[4]!) && words[5] === '--confirm' &&
    words[6] === `waive L1 hold ${words.slice(0, 5).join(' ')}`) {
    request = { type: 'quarantine-release', agent: words[0], key: words[1], generation: words[2], selection: words[3],
      operation: words[4], confirmation: words[6] };
  } else if (verb === 'result' && words.length === 1 && id.test(words[0]!)) {
    request = { type: 'quarantine-result', operation: words[0] };
  } else {
    ctx.err(QUARANTINE_USAGE);
    return 2;
  }
  let host;
  try { host = await openSocket(quarantineSocketPath(dataDirOf(ctx.root!))); }
  catch { ctx.err('quarantine: install/socket unavailable; no host started and no mutation retried'); return 1; }
  if ('reason' in host) { ctx.err(`quarantine: ${host.reason}; no host started and no mutation retried`); return 1; }
  try {
    const answer = await host.request(request, 10_000);
    if (answer === null) {
      ctx.err(`quarantine: no acknowledgement; outcome UNKNOWN. Do not resend with a new operation ID. ` +
        'Use result with the SAME operation ID; an old host may not support these verbs.');
      return 1;
    }
    ctx.out(JSON.stringify(answer));
    const status = answer.status === 'recorded'
      ? (answer.observed as { status?: unknown } | undefined)?.status : answer.status;
    return answer.type === 'quarantine-response' && ['ok', 'released'].includes(String(status)) ? 0 : 1;
  } finally { host.close(); }
}
