import { Stream } from '@anthropic-ai/sdk/streaming';
import { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream';

export type KeyCheck = { ok: true } | { ok: false; cause: string; anotherKeyMayHelp: boolean };

export interface KeyCheckOptions {
  key: string;
  model: string;
  /** ANTHROPIC_BASE_URL where it's set, or undefined for Anthropic's own API. */
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export const ANTHROPIC_API = 'https://api.anthropic.com';

/** Where a base URL leads, without any user, password, path or query it carries. */
export function originOf(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

function apiMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    return typeof parsed.error?.message === 'string' ? parsed.error.message : null;
  } catch {
    return null;
  }
}

function sentence(text: string): string {
  return text.replace(/[\s.]+$/, '');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The agent's client is @anthropic-ai/sdk's MessageStream, which @animalabs/membrane iterates for every turn and leaves
// at the message_delta it requires. So a 2xx is read with the SDK's own SSE decoding and MessageStream, and judged at
// that same event.
async function readAsTheAgent(response: Response, controller: AbortController): Promise<{ failure: unknown } | null> {
  const stream = MessageStream.fromReadableStream(Stream.fromSSEResponse(response, controller).toReadableStream());
  let failure: unknown = null;
  stream.on('error', (error) => {
    failure ??= error;
  });
  let ended = false;
  try {
    for await (const event of stream) {
      if (event.type === 'message_delta') {
        ended = true;
        break;
      }
    }
  } catch (error) {
    failure ??= error;
  }
  controller.abort();
  if (ended) return null;
  return { failure: failure ?? new Error('the stream ended before its message did') };
}

const STREAMS = 'Setup\'s agent streams every turn';

export async function checkKey(options: KeyCheckOptions): Promise<KeyCheck> {
  const { key, model } = options;
  const failed = (cause: string, anotherKeyMayHelp: boolean): KeyCheck => ({ ok: false, cause, anotherKeyMayHelp });
  const set = options.baseUrl !== undefined;
  const base = options.baseUrl ?? ANTHROPIC_API;
  const origin = originOf(base);
  if (origin === null) {
    return failed('ANTHROPIC_BASE_URL isn\'t an http:// or https:// URL, so nothing was called. Set it to one, ' +
      `such as ${ANTHROPIC_API}, or unset it for Anthropic's own API, and run setup again.`, false);
  }
  // As @anthropic-ai/sdk 0.52.0's buildURL joins the base URL and the path, so the check calls where the agent will.
  const url = base + (base.endsWith('/') ? 'v1/messages' : '/v1/messages');
  const host = new URL(url).host;
  const urls = [...new Set([url, new URL(url).href, base, new URL(base).href])].sort((a, b) => b.length - a.length);
  // fetch sends a header's value trimmed, so a server can quote the key that way, and one that puts it in a URL's
  // host gets it back lowercased, so the key is matched in any letter case.
  const keys = [...new Set([key, key.trim()])].filter((each) => each.trim() !== '').sort((a, b) => b.length - a.length)
    .map((each) => new RegExp(each.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'));
  const quote = (words: string) => {
    for (const each of urls) words = words.split(each).join(origin);
    for (const each of keys) words = words.replace(each, '<ANTHROPIC_API_KEY>');
    return sentence(words);
  };
  const where = set
    ? `and ANTHROPIC_BASE_URL, which leads to ${origin} now`
    : `ANTHROPIC_BASE_URL is empty or absent in .env, so the call went to Anthropic's own ${origin}`;
  const check = set
    ? `Check this machine's network and any proxy it goes through (HTTPS_PROXY), ${where}.`
    : `Check this machine's network and any proxy it goes through (HTTPS_PROXY). ${where}.`;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const unreached = (error: unknown): string => {
    const { name, code, message } = error as { name?: string; code?: string; message?: string };
    const words = quote(message ?? String(error));
    const said = [code && !words.startsWith(`${code}:`) ? code : '', words].filter((part) => part !== '').join(': ');
    const why = said === '' ? '' : ` (${said})`;
    if (name === 'TimeoutError') return `${host} didn't answer within ${timeoutMs / 1000} s. ${check}`;
    if (code === 'ECONNREFUSED') return `The connection to ${host} was refused before anything reached it. ${check}`;
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `${host} couldn't be found by name (${code}). ${check}`;
    if (code && /CERT|SSL|TLS|SIGNATURE|^EPROTO$/i.test(code)) {
      const at = new URL(base);
      const plain = set && code === 'EPROTO' && at.protocol === 'https:'
        ? ` If the server at ${origin} speaks plain HTTP, change ANTHROPIC_BASE_URL in .env to begin http:// in place ` +
          'of https://, adding :443 after its host if it names no port, though the key and everything the agent ' +
          'sends and receives then cross the network unencrypted.' : '';
      return `The TLS connection to ${host} failed${why}. ${check}${plain}`;
    }
    return `The call to ${host} failed${why}. ${check}`;
  };
  // Bun 1.4.4's Headers refuses a value holding U+2028, U+200B or U+0100 and carries U+0093, U+00A0 and U+00E9, and
  // its fetch refuses a header holding U+2028 with Headers' own words before it calls (probed).
  try {
    new Headers({ 'x-api-key': key });
  } catch {
    return failed('The key holds a character a request header can\'t carry, so it can\'t be sent, and no call was ' +
      'made. Check what was copied.', true);
  }
  const controller = new AbortController();
  const limit = AbortSignal.timeout(timeoutMs);
  limit.addEventListener('abort', () => controller.abort(limit.reason), { once: true });
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1, stream: true, messages: [{ role: 'user', content: 'ok' }] }),
      signal: controller.signal,
      // A redirect followed would send the key to wherever it points (probed: Bun 1.4.3 and 1.4.4 send x-api-key
      // to another origin), so it's answered as the 3xx it is.
      redirect: 'manual',
    });
  } catch (error) {
    return failed(unreached(error), false);
  }
  if (response.ok) {
    const read = await readAsTheAgent(response, controller);
    if (read === null) return { ok: true };
    const { failure } = read;
    if (limit.aborted) return failed(unreached(limit.reason), false);
    for (const each of [failure, (failure as { cause?: unknown }).cause]) {
      if (typeof (each as { code?: unknown } | undefined)?.code === 'string') return failed(unreached(each), false);
    }
    const type = response.headers.get('content-type');
    const kind = quote(type ?? 'no content type');
    const said = (failure as { error?: unknown }).error;
    const streamed = isObject(said) && isObject(said.error) ? said.error : null;
    if (streamed !== null) {
      const words = typeof streamed.message === 'string' ? ` It said: "${quote(streamed.message)}".` : '';
      return failed(`${host} answered, but its stream ended in an error.${words} So the key isn't known to work. ` +
        (streamed.type === 'overloaded_error' ? 'Try again in a few minutes.' : 'Try again shortly.'), false);
    }
    if (/^application\/json\b/i.test(type ?? '')) {
      return failed(`${host} answered ${response.status} with ${kind} where the check asked for an event stream, so the ` +
        `key isn't known to work. ${STREAMS}, so a ${set ? 'gateway' : 'server'} that answers only unstreamed calls ` +
        `can't serve it.${set ? ' Point ANTHROPIC_BASE_URL in .env at one that streams (a URL put right there is read ' +
          'at the next try), or take it out for Anthropic\'s own API.' : ` Something on the way to Anthropic's API, ` +
          `such as a proxy, may have answered in its place. ${check}`}`, false);
    }
    const why = quote(failure instanceof Error ? failure.message : String(failure));
    return failed(`${host} answered ${response.status} (${kind}), but not with a message from Anthropic's Messages ` +
      `API as the agent's client reads one: ${why}. So the key isn't known to work.` +
      `${set ? ' Check that ANTHROPIC_BASE_URL leads to that API.' : ` Something on the way to it, such as a proxy or ` +
        `a captive portal, may have answered in its place. ${check}`}`, false);
  }
  let body = '';
  try {
    body = await response.text();
  } catch {
    body = '';
  }
  // A 3xx's words are never the Messages API's, which sends none, so they're the server's alone, as its Location is.
  const apiSaid = response.status >= 300 && response.status < 400 ? null : apiMessage(body);
  const quoted = apiSaid ? ` It said: "${quote(apiSaid)}".` : '';
  switch (response.status) {
    case 401:
      return failed(`${host} refused the key (401).${quoted} Check that it was copied whole` +
        `${set ? `, and that it's a key ${origin} accepts` : ', from console.anthropic.com\'s API keys'}.`, true);
    case 403:
      return failed(`${host} refused this call (403).${quoted}`, true);
    case 404:
      return failed(set
        ? `${host} found nothing for ${model} (404).${quoted} Either this key can't use ` +
          `${model}, or ANTHROPIC_BASE_URL doesn't lead to Anthropic's Messages API. If it's the URL, put it right in ` +
          '.env and type the key again: each try reads it there.'
        : `${host} has no model ${model} for this key (404).${quoted}`, true);
    case 429: {
      const after = quote(response.headers.get('retry-after') ?? '') || null;
      const wait = after === null ? 'Try again shortly.'
        : /^\d+$/.test(after) ? `It asks for a wait of ${after} s before the next call.`
          : `It asks for no call before ${after}.`;
      return failed(`${host} is limiting this key's requests (429).${quoted} ${wait}`, false);
    }
    case 529:
      return failed(`${host} is overloaded (529).${quoted} Try again in a few minutes.`, false);
    default: {
      const refused = response.status >= 400 && response.status < 500 && response.status !== 408;
      const next = response.status >= 500 ? ' Its side had a problem: try again shortly.'
        : response.status === 408 ? ' It stopped waiting for the call: try again shortly.'
          : response.status < 400 ? ' Anthropic\'s Messages API answers with no 3xx, and setup follows no redirect, so ' +
            `the key went no further. ${set ? 'ANTHROPIC_BASE_URL in .env may not lead to that API (a URL put right ' +
              'there is read at the next try), or something '
              : 'Something '}on the way to it, such as a proxy or a captive portal, may have answered in its place. ` +
            check
            : set ? ' It may be about this key or its account there, or ANTHROPIC_BASE_URL may not lead to ' +
              'Anthropic\'s Messages API: a URL put right in .env is read at the next try.'
              : ' It may be about this key or its account: another key, or the account put right at ' +
                'console.anthropic.com, can help.';
      const streamed = set && refused ? ` ${STREAMS}, as this check did, so a gateway that answers only unstreamed calls ` +
        'can\'t serve it.' : '';
      return failed(`${host} answered ${response.status}.${quoted} So the key isn't known to work.${next}${streamed}`, refused);
    }
  }
}
