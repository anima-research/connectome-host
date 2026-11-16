/**
 * The fetch tool's one way onto the network: a GET that decides what it may
 * reach by the address it would connect to, not by the name it was given.
 *
 * What it refuses is ranges of addresses, private and local ones, and this
 * host's own addresses. It can't tell an internal service that sits on a
 * publicly routable address, or a NAT router's public one, from the internet.
 *
 * A name check can't hold: 127.0.0.1, 2130706433, the IPv6 literal ::ffff:7f00:1,
 * and any public name whose DNS answer is a private address all pass one. So every
 * hop is checked twice over, at the only two points an address is known: an IP
 * literal before dialing (a connection to one asks no lookup), and a name in
 * the connection's own `lookup`, so the address checked is the address dialed
 * and a second DNS answer can't swap it after the check.
 *
 * Each request gets its own connection (`agent: false`). A pooled socket is
 * reused without a lookup, which would skip the check entirely.
 *
 * Response bodies are asked for uncompressed, so the byte ceiling counts what
 * this process would actually hold and there is no decompression to bomb. A
 * server that compresses anyway is reported as such (see `compressed`).
 */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { networkInterfaces } from 'node:os';

const NOT_PUBLIC = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // shared address space, which Tailscale uses
  ['127.0.0.0', 8], // loopback
  ['168.63.129.16', 32], // Azure's platform address, public in form, which reaches the host's own platform services
  ['169.254.0.0', 16], // link-local, and cloud metadata services
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and broadcast
] as const) NOT_PUBLIC.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 96], // unspecified, loopback, and IPv4-compatible
  ['64:ff9b:1::', 48], // local-use NAT64, which is for a network's own use
  ['100::', 64], // discard
  ['2001::', 23], // protocol assignments, Teredo among them
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4, which can embed a private IPv4 address
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local
  ['ff00::', 8], // multicast
] as const) NOT_PUBLIC.addSubnet(address, prefix, 'ipv6');

/**
 * Prefixes whose addresses each stand for the IPv4 address in their last 32
 * bits, and reach it through a translator: NAT64's well-known prefix, and the
 * IPv4-translated one (`::ffff:0:10.0.0.1`).
 */
const EMBEDS_IPV4 = new BlockList();
EMBEDS_IPV4.addSubnet('64:ff9b::', 96, 'ipv6');
EMBEDS_IPV4.addSubnet('::ffff:0:0:0', 96, 'ipv6');

/** The IPv4 address an IPv6 address's last 32 bits spell. */
function embeddedIpv4(address: string): string {
  const dotted = address.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted !== undefined) return dotted;
  // All eight groups, the run that :: stands for written out, wherever it falls.
  const [head, tail] = address.split('::') as [string, string | undefined];
  const before = head === '' ? [] : head.split(':');
  const after = tail === undefined || tail === '' ? [] : tail.split(':');
  const groups = tail === undefined ? before : [...before, ...Array<string>(8 - before.length - after.length).fill('0'), ...after];
  const [high, low] = groups.slice(-2).map((group) => parseInt(group, 16)) as [number, number];
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/**
 * Whether an address is one this host's own interfaces carry. A public one
 * among them reaches the host itself, as loopback does, and a firewall in
 * front of the host doesn't stand between the two.
 */
export function isOwnAddress(address: string, interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): boolean {
  const bare = address.split('%')[0]!;
  const family = isIP(bare);
  if (family === 0) return false;
  const own = new BlockList();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      const carried = entry.address.split('%')[0]!;
      if (isIP(carried) !== 0) own.addAddress(carried, isIP(carried) === 4 ? 'ipv4' : 'ipv6');
    }
  }
  return own.check(bare, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Whether an address is on the public internet. An IPv4-mapped IPv6 address
 * (`::ffff:127.0.0.1`) answers as the IPv4 address it maps, and so does a
 * NAT64 or IPv4-translated one (`64:ff9b::808:808`), which is how an IPv6-only
 * network reaches every IPv4 site, public ones included. One of this host's
 * own addresses isn't public, whatever its range, and what isn't an address at
 * all isn't either.
 */
export function isPublicAddress(address: string, interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): boolean {
  const bare = address.split('%')[0]!;
  const family = isIP(bare);
  if (family === 0) return false;
  if (family === 6 && EMBEDS_IPV4.check(bare, 'ipv6')) return !isOwnAddress(bare, interfaces) && isPublicAddress(embeddedIpv4(bare), interfaces);
  return !NOT_PUBLIC.check(bare, family === 4 ? 'ipv4' : 'ipv6') && !isOwnAddress(bare, interfaces);
}

/**
 * An address or a path as it's shown in a result, on one line: an address can
 * be as long as a redirect makes it, and a file's name can hold a line break,
 * which would start what reads as a line of the tool's own.
 */
export function shownAddress(address: string): string {
  const line = address.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ');
  return line.length <= 300 ? line : `${line.slice(0, 300)}…`;
}

/**
 * A refused or failed fetch. Its message completes "Nothing was fetched: ",
 * unless it is `whole`: then something was read on the way, an error page say,
 * and the message is all of what's said.
 */
export class FetchRefusal extends Error {
  override readonly name = 'FetchRefusal';
  constructor(message: string, readonly whole = false) {
    super(message);
  }
}

const PRIVATE_ADDRESS = 'ERR_FETCH_ADDRESS_NOT_ALLOWED';

/** The hint a refusal for a private address carries, for whoever runs the host. */
const PRIVATE_REMEDY = "This tool reaches only the public internet unless whoever runs this host sets modules.fetch.allowPrivateNetwork.";

export interface HttpGetOptions {
  /** The whole fetch's budget, redirects included, slow bodies included. */
  timeoutMs: number;
  /** Keep at most this many body bytes. Past it the connection is closed and `cut` says so. */
  maxBytes: number;
  /** How many redirects to follow. */
  maxRedirects: number;
  /** Sent as the User-Agent. */
  userAgent: string;
  /** Which addresses may be connected to. Defaults to public ones (isPublicAddress). */
  addressAllowed?: (address: string) => boolean;
  /** Read a body whose type is clearly binary too, an image say, where the default leaves it and reports `binary`. */
  readBinary?: boolean;
}

export interface HttpGetResult {
  /** Where the response came from, after any redirects, without a fragment. */
  url: string;
  status: number;
  /** The Content-Type header as sent, if any. */
  contentType: string | undefined;
  /** The body, or its first `maxBytes` when `cut`. Empty for a `binary` answer. */
  body: Buffer;
  /** The body went on past `maxBytes`, and the rest wasn't read. */
  cut: boolean;
  /** The Content-Type is one no text comes from, so the body wasn't read. */
  binary: boolean;
  /** The Content-Length header, when it's a number. */
  declaredBytes: number | undefined;
}

/**
 * Types whose bodies are never text, so they aren't worth downloading to find
 * that out. Anything else is read and judged by its bytes, which covers the many
 * vendor types, some of them text, such as application/vnd.github+json.
 */
function clearlyBinary(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  if (type === 'image/svg+xml') return false;
  return /^(image|audio|video|font)\//.test(type)
    || /^application\/(pdf|zip|gzip|x-tar|x-gzip|x-7z-compressed|x-rar-compressed|msword|wasm)$/.test(type);
}

function checkTarget(url: URL, allowed: (address: string) => boolean): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FetchRefusal(`${url.protocol} addresses aren't fetched, only http: and https:.`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new FetchRefusal("the address carries a user name or password, which this tool doesn't send.");
  }
  // A connection to an IP literal asks no lookup, so it's checked here. URL
  // has already normalized the other ways to write one (2130706433, 0x7f.1).
  const literal = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(literal) !== 0 && !allowed(literal)) {
    throw new FetchRefusal(`${url.hostname} is a private or local address, or one this host carries itself. ${PRIVATE_REMEDY}`);
  }
}

/** The part of dns.lookup this uses, so a test can answer as a hostile name server would. */
type Resolver = (
  hostname: string,
  options: { all: true; family?: number },
  callback: (error: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void,
) => void;

export function guardedLookup(allowed: (address: string) => boolean, resolve: Resolver = dns.lookup): LookupFunction {
  return (hostname, options, callback) => {
    const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : options.family;
    resolve(hostname, { all: true, ...(family ? { family } : {}) }, (error, addresses) => {
      if (error) {
        callback(error, '', 0);
        return;
      }
      // Any private answer refuses the name: a host that answers with both a
      // public and a private address could connect to either.
      const refused = addresses.find((entry) => !allowed(entry.address));
      if (refused) {
        // Not naming the address, or this would map out internal names for whoever asks.
        const blocked = new Error(`${hostname} resolves to a private or local address, or one this host carries itself. ${PRIVATE_REMEDY}`) as NodeJS.ErrnoException;
        blocked.code = PRIVATE_ADDRESS;
        callback(blocked, '', 0);
        return;
      }
      if (options.all) (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, addresses);
      else if (addresses[0] === undefined) {
        // A resolver that answers with no error and no address: the name isn't found.
        const missing = new Error(`getaddrinfo ENOTFOUND ${hostname}`) as NodeJS.ErrnoException;
        missing.code = 'ENOTFOUND';
        callback(missing, '', 0);
      } else callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

function headerText(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

type Hop = Omit<HttpGetResult, 'url'> & { location: string | undefined };

/** One request and its response, over a connection of its own. `deadline` is on performance.now()'s clock, which a change to the wall clock doesn't move. */
function requestOnce(url: URL, options: HttpGetOptions, allowed: (address: string) => boolean, deadline: number): Promise<Hop> {
  return new Promise<Hop>((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const remaining = Math.max(deadline - performance.now(), 1);
    const request = client.request(url, {
      method: 'GET',
      agent: false,
      lookup: guardedLookup(allowed),
      headers: {
        Accept: 'text/markdown, text/html, */*',
        'Accept-Encoding': 'identity',
        'User-Agent': options.userAgent,
      },
    });
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle();
    };
    // Bounds connecting, a server that never answers and one that answers a
    // byte at a time alike: what a socket timeout, which only sees silence,
    // would miss.
    const timer = setTimeout(() => {
      finish(() => reject(new FetchRefusal(`it took longer than ${Math.round(options.timeoutMs / 1000)} seconds.`)));
      request.destroy();
    }, remaining);

    request.on('error', (error: NodeJS.ErrnoException) => {
      finish(() => reject(error.code === PRIVATE_ADDRESS
        ? new FetchRefusal(error.message)
        // The runtime's words, on one line and cut: a certificate's names, which its server chose, can be among them.
        : new FetchRefusal(`the request failed: ${shownAddress(error.message)}`)));
    });

    request.on('response', (response) => {
      const status = response.statusCode ?? 0;
      const contentType = headerText(response.headers['content-type']);
      const length = Number(headerText(response.headers['content-length']));
      const declaredBytes = Number.isSafeInteger(length) && length >= 0 ? length : undefined;
      const location = headerText(response.headers.location);
      const answer = { status, location, contentType, declaredBytes };

      if (status >= 300 && status < 400 && location !== undefined) {
        finish(() => resolve({ ...answer, body: Buffer.alloc(0), cut: false, binary: false }));
        request.destroy();
        return;
      }
      if (clearlyBinary(contentType) && !options.readBinary) {
        finish(() => resolve({ ...answer, body: Buffer.alloc(0), cut: false, binary: true }));
        request.destroy();
        return;
      }
      const encoding = headerText(response.headers['content-encoding'])?.trim().toLowerCase();
      if (encoding !== undefined && encoding !== '' && encoding !== 'identity') {
        // The header is the server's to write, so only what reads as an encoding's name is repeated.
        const named = /^[a-z0-9_.-]{1,20}$/.test(encoding) ? ` (${encoding})` : '';
        finish(() => reject(new FetchRefusal(`the server sent it compressed${named}, though it was asked not to, so it can't be read.`)));
        request.destroy();
        return;
      }

      const chunks: Buffer[] = [];
      let total = 0;
      response.on('data', (chunk: Buffer) => {
        if (settled) return;
        const room = options.maxBytes - total;
        if (chunk.length > room) {
          if (room > 0) chunks.push(chunk.subarray(0, room));
          finish(() => resolve({ ...answer, body: Buffer.concat(chunks), cut: true, binary: false }));
          request.destroy();
          return;
        }
        chunks.push(chunk);
        total += chunk.length;
      });
      response.on('end', () => {
        finish(() => resolve({ ...answer, body: Buffer.concat(chunks), cut: false, binary: false }));
      });
      response.on('error', (error) => {
        finish(() => reject(new FetchRefusal(`the connection failed partway through: ${shownAddress(error.message)}`)));
      });
      response.on('close', () => {
        // Closed without its end, as a server that drops the connection does.
        finish(() => reject(new FetchRefusal('the server closed the connection before sending everything.')));
      });
    });

    request.end();
  });
}

/**
 * GET a URL, following redirects, each hop held to the same checks as the
 * first, so a public page can't redirect a fetch onto a private address. Any
 * failure, refusal or not, is thrown as a FetchRefusal.
 */
export async function httpGet(start: URL, options: HttpGetOptions): Promise<HttpGetResult> {
  const allowed = options.addressAllowed ?? ((address: string) => isPublicAddress(address));
  const deadline = performance.now() + options.timeoutMs;
  let url = new URL(start);
  for (let hop = 0; ; hop++) {
    url.hash = '';
    checkTarget(url, allowed);
    const answer = await requestOnce(url, options, allowed, deadline);
    if (answer.location === undefined || answer.status < 300 || answer.status >= 400) {
      const { location: _location, ...result } = answer;
      return { url: url.href, ...result };
    }
    if (hop >= options.maxRedirects) {
      throw new FetchRefusal(`it redirected more than ${options.maxRedirects} times. The last address was ${shownAddress(url.href)}.`);
    }
    try {
      url = new URL(answer.location, url);
    } catch {
      throw new FetchRefusal(`${shownAddress(url.href)} redirected to an address that doesn't parse.`);
    }
  }
}
