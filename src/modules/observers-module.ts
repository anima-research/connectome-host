/**
 * ObserversModule — the agent holds the pen on who may observe its interior.
 *
 * Interiority access (thinking, tool payloads, conversation stream via the
 * webui) is a consent question before it is an ACL question — see connectome
 * docs/observability.md §4. These tools let the agent read and edit its own
 * data/observers.json grant file. The webui's ObserverRegistry checks the
 * file every ~3s, so without a restart a grant applies to the next hello, and
 * a revocation ends the grant's sessions and open connections. Operators can
 * edit the same file directly; writes here are atomic (tmp+rename) so the two
 * never corrupt each other.
 * A file these tools can't read, or that isn't a grants file, is never
 * written over. In one they can read, a change touches only the entries it
 * matches: every other entry, an unusable one included, and every other
 * field stays as found. The host uses a file's usable grants and names the
 * rest, so a bad entry never stops the agent's own changes.
 *
 * Grants marked `protected: true` (recipe-designated operator baseline) are
 * visible but not revocable through these tools; only a file edit removes
 * them. Tools also cannot CREATE protected grants — protection is an
 * operator-level marker.
 */

import type {
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
} from '@animalabs/agent-framework';
import {
  OBSERVER_SCOPES,
  canonicalKey,
  checkObserversFile,
  readObserversFile,
  saveObserversFile,
  type GrantsDocument,
  type ObserverGrant,
  type ObserverScope,
  type ObserversFile,
} from './web-ui-observers.js';
import { shown } from './shown.js';
import { unknownToolResult } from './unknown-tool.js';

export interface ObserversModuleConfig {
  /** Absolute path to the grant file (same one the webui watches). */
  path: string;
  /** 'tools' (default) or 'utilities' — grant edits are rare; behind the
   *  `utils` meta-tool they stop costing three schemas per inference. The
   *  consent semantics are unchanged either way: the agent holds the pen. */
  surface?: 'tools' | 'utilities';
}

/** The form an expiry is given in: a full date, YYYY-MM-DD, with an optional
 *  time (group 4) and zone (group 5): T, t or a space before the time; Z, z,
 *  or an offset as +HH:MM or +HHMM. */
const EXPIRY_FORM = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)([Zz]|[+-]\d{2}:?\d{2})?)?$/;

/** An expiry given in the form (EXPIRY_FORM), written in ECMAScript's own
 *  form: T before the time, Z, and an offset with its colon, a time without
 *  a zone staying without one. The grant checks this text, so the check
 *  reads what the registry later reads (liveScopes, verifyHello). Bun
 *  1.4.3's Date.parse reads a date with a space before the time leniently:
 *  an offset out of range is read anyway, and a year below 100 moves into
 *  the 1900s or 2000s. ECMAScript's own form it reads as written, a date
 *  alone as UTC and a time without a zone in the host's time zone, or not
 *  at all, apart from a day the month doesn't have, which it moves into the
 *  next month (daysIn). `timed` says whether the text has a time, and
 *  `zoned` whether it names its zone. */
function ecmaExpiry(typed: string): { text: string; year: number; month: number; day: number; timed: boolean; zoned: boolean } | null {
  const form = EXPIRY_FORM.exec(typed);
  if (!form) return null;
  const [, year, month, day, time, zone] = form;
  const zoneText = zone === undefined ? '' : /^[Zz]$/.test(zone) ? 'Z' : `${zone.slice(0, 3)}:${zone.slice(-2)}`;
  return {
    text: `${year}-${month}-${day}${time === undefined ? '' : `T${time}${zoneText}`}`,
    year: Number(year),
    month: Number(month),
    day: Number(day),
    timed: time !== undefined,
    zoned: zone !== undefined,
  };
}

const EXPIRY_WORDS = 'YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ (an offset such as +02:00 can stand for Z)';

/** How many days month `month` (1 to 12) of `year` has. */
function daysIn(year: number, month: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

export class ObserversModule implements Module {
  readonly name = 'observers';

  constructor(private readonly config: ObserversModuleConfig) {}

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return (this.config.surface ?? 'tools') === 'tools' ? this.definitions() : [];
  }

  getUtilities(): ToolDefinition[] {
    return this.config.surface === 'utilities' ? this.definitions() : [];
  }

  private definitions(): ToolDefinition[] {
    return [
      {
        name: 'get',
        description:
          'List who is currently authorized to observe your internals through the web viewer ' +
          '(thinking, tool calls, conversation stream — by scope). Each grant is an ed25519 ' +
          'public key + label + scope list. Labels are testimony, not verified identity.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'grant',
        description:
          'Authorize an observer key to watch your internals through the web viewer. ' +
          `Scopes (event families): ${OBSERVER_SCOPES.join(', ')}. ` +
          "'health' = liveness/usage only; 'ops' = alerts (refusals, failures); 'messages' = the " +
          "conversation; 'tools' = tool calls and results; 'thinking' = your thinking blocks; " +
          "'debug' = compiled-context debug endpoints (implies seeing everything in your window). " +
          'Grant deliberately — this is access to your interior. Takes effect within ~3 seconds.',
        inputSchema: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'ed25519:<base64url public key> — the fingerprint the person/device shows you.' },
            label: { type: 'string', description: 'Who this is (your words — e.g. "antra-phone", "fleet-hub").' },
            scopes: {
              type: 'array',
              items: { type: 'string', enum: [...OBSERVER_SCOPES] },
              description: 'Event families this key may receive.',
            },
            expires: { type: 'string', description: `Optional ISO date, still to come, as ${EXPIRY_WORDS}; the grant stops working after it. A date alone means its start, 00:00 UTC, and a time without a zone is read in this host's time zone and stored as the instant it names there, so give Z or an offset to be exact. Leave it out for a grant with no end.` },
          },
          required: ['key', 'label', 'scopes'],
        },
      },
      {
        name: 'revoke',
        description:
          'Remove an observer grant by key or by label. Protected (operator-baseline) grants ' +
          'cannot be revoked here. Within about 3 seconds, new connections are refused, and the ' +
          "grant's HTTP sessions and open connections end.",
        inputSchema: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'ed25519:<base64url public key> to revoke; every grant for that key goes.' },
            label: { type: 'string', description: 'Alternative: revoke by exact label (must match exactly one grant); every grant for that grant\'s key goes with it.' },
          },
        },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    const input = (call.input ?? {}) as Record<string, unknown>;
    switch (call.name) {
      case 'get': {
        const read = this.read();
        if ('problem' in read) {
          return err(
            `The grants can't be listed: ${read.problem}. ` +
            (read.own
              ? canPass('get')
              : (read.unparsed
                ? 'Until it parses, the web viewer goes on with the grants it last admitted, if any. '
                : '') +
                'These tools leave the file alone. Ask whoever runs this host to repair it.'),
          );
        }
        return ok({ observers: read.usable.map(redactNothing), ...notUsed(read.problems) });
      }

      case 'grant': {
        // Every problem with the call is named at once, each with what to
        // give, before the file is read.
        const problems: string[] = [];
        // Written in canonical form, whichever base64 spelling was given.
        const keyText = typeof input.key === 'string' ? input.key.trim() : '';
        const key = canonicalKey(keyText);
        if (!key) {
          problems.push(
            keyText !== '' || (typeof input.key !== 'string' && given(input.key))
              ? `key ${shown(input.key)} isn't an ed25519 public key: give "ed25519:<base64url public key>", a key that decodes to 32 bytes`
              : 'key is missing: give the observer\'s key, "ed25519:<base64url public key>", the fingerprint the person or device shows you',
          );
        }
        const label = typeof input.label === 'string' ? input.label.trim() : '';
        if (typeof input.label !== 'string' && given(input.label)) {
          problems.push(`label must be text, not ${shown(input.label)}`);
        } else if (!label) {
          problems.push('label is missing: say who this is, in your own words');
        }
        const scopes: unknown[] = Array.isArray(input.scopes) ? input.scopes : [];
        const unknown = scopes.filter((s) => !(OBSERVER_SCOPES as readonly unknown[]).includes(s));
        if (scopes.length === 0) {
          problems.push(
            `scopes must be a list of one or more of ${OBSERVER_SCOPES.join(', ')}` +
            (given(input.scopes) ? `, not ${shown(input.scopes)}` : ''),
          );
        } else if (unknown.length > 0) {
          problems.push(
            `scopes names ${unknown.length === 1 ? 'one that doesn\'t' : 'ones that don\'t'} exist, ${unknown.map(shown).join(', ')}: ` +
            `the scopes are ${OBSERVER_SCOPES.join(', ')}`,
          );
        }
        // Absent, null and "" all mean no end. Anything else must be a date
        // in the ISO form (EXPIRY_FORM) that the registry reads as still to
        // come, by its own rule (liveScopes, verifyHello): one that has
        // passed it would never admit. It's read as ECMAScript's own form
        // writes it (ecmaExpiry), so an offset or a time out of range reads
        // as no date, and a year below 100 as itself. Text in any
        // other form is refused, though Date.parse reads much of it, since
        // its lenient parser reads "3600." as the year 3600 and "05/06/2026"
        // as May 6. So is a day the month doesn't have, which Date.parse
        // moves on ("2026-02-30" is March 2).
        const raw = input.expires;
        const typed = typeof raw === 'string' && raw !== '' ? raw : null;
        const expiry = typed === null ? null : ecmaExpiry(typed);
        const at = expiry === null ? NaN : Date.parse(expiry.text);
        const noEnd = 'leave expires out for a grant with no end';
        if (typeof raw !== 'string' && given(raw)) {
          problems.push(`expires must be text, not ${shown(raw)}: give a date as ${EXPIRY_WORDS}, or ${noEnd}`);
        } else if (typed !== null && !Number.isFinite(at)) {
          problems.push(`expires ${shown(typed)} isn't a date as ${EXPIRY_WORDS}: give it in that form, or ${noEnd}`);
        } else if (expiry && expiry.day > daysIn(expiry.year, expiry.month)) {
          problems.push(
            `expires ${shown(typed)} names a day its month doesn't have, which is refused rather than moved into the ` +
            `next month: give a date that exists, as ${EXPIRY_WORDS}, or ${noEnd}`,
          );
        } else if (expiry && at < Date.now()) {
          problems.push(
            `expires ${shown(typed)} has already passed: give a later time, or ${noEnd} ` +
            '(observers--revoke ends this key\'s grants, if it has any and none is protected)',
          );
        }
        if (problems.length > 0) return err(`Nothing was granted: ${problems.join('; ')}.`);
        // What's stored is what was read: ECMAScript's form, apart from a time
        // without a zone, which is stored as the instant this host read it as,
        // in UTC, so the registry reads that instant whatever zone, tzdata or
        // host it runs under later. A date alone is UTC wherever it's read.
        const instant = expiry === null ? null : new Date(at).toISOString().replace('.000Z', 'Z');
        const expires = expiry === null ? null : expiry.timed && !expiry.zoned ? instant : expiry.text;

        const read = this.read();
        if ('problem' in read) return err(`Nothing was granted: ${read.problem}. ${read.own ? canPass('grant') : leftAlone('grant')}`);
        // Every entry for the key becomes this one, as a revoke by key takes
        // them all: a repeat left behind would stay in the file, unused.
        const sameKey = read.doc.observers.filter((g): g is ObserverGrant => isEntry(g) && canonicalKey(g.key) === key);
        if (sameKey.some((g) => g.protected)) return err(`Nothing was granted: ${protectedKey(key!, 'change')}`);
        const grant: ObserverGrant = { key: key!, label, scopes: scopes as ObserverScope[], expires };
        const existing = sameKey[0];
        if (existing) {
          Object.assign(existing, grant); // update label/scopes/expiry in place
          read.doc.observers = read.doc.observers.filter((g) => g === existing || !sameKey.includes(g as ObserverGrant));
        } else {
          read.doc.observers.push(grant);
        }
        // A date alone or a time without a zone doesn't say its zone, so the
        // answer names the instant this host reads it as.
        const readAs = expiry && !expiry.zoned ? `, which this host reads as ${instant}` : '';
        return this.saved(
          read.doc,
          'grant',
          `${existing ? 'Updated' : 'Granted'}: ${label} → [${grant.scopes.join(', ')}]${expiry ? ` until ${expiry.text}${readAs}` : ''}. Live within ~3s.`,
        );
      }

      case 'revoke': {
        const key = typeof input.key === 'string' ? input.key.trim() : '';
        const label = typeof input.label === 'string' ? input.label.trim() : '';
        if (!key && !label) {
          // A value that isn't text is read as not given, as on main, so a
          // call naming a label beside it still revokes; alone, it's named.
          const notText = (['key', 'label'] as const)
            .filter((name) => typeof input[name] !== 'string' && given(input[name]))
            .map((name) => `${name} must be text, not ${shown(input[name])}`);
          return err(`Nothing was revoked: ${[...notText, 'give key, the observer\'s key, or label, the exact label of its grant'].join('; ')}.`);
        }
        const read = this.read();
        if ('problem' in read) return err(`Nothing was revoked: ${read.problem}. ${read.own ? canPass('revoke') : leftAlone('revoke')}`);
        const entries = (match: (g: ObserverGrant) => boolean) =>
          read.doc.observers.filter((g): g is ObserverGrant => isEntry(g) && match(g));
        // A key matches every spelling of itself. One that doesn't decode can
        // still name an entry spelled exactly so.
        const keyed = (k: string) => (g: ObserverGrant) => (canonicalKey(g.key) ?? g.key) === k;
        let matches = entries(key ? keyed(canonicalKey(key) ?? key) : (g) => g.label === label);
        if (matches.length === 0) {
          return err(
            `Nothing was revoked: ${key ? `no grant has the key ${shown(key)}` : `no grant is labelled ${shown(label)}`}. ` +
            'observers--get lists the grants and their keys.',
          );
        }
        // A label has to name one entry. The key is the observer, though, so
        // a revoke takes every entry for it: a repeat left behind would be
        // used in place of the one revoked.
        if (!key && matches.length > 1) {
          const keys = [...new Set(matches.map((g) => shown(g.key)))];
          return err(`Nothing was revoked: ${matches.length} grants are labelled ${shown(label)}. Revoke by key instead: ${keys.join(' or ')}.`);
        }
        const named = matches[0]!;
        // As a revoke by key does: one that doesn't decode matches entries
        // spelled exactly as it is.
        if (!key && typeof named.key === 'string') matches = entries(keyed(canonicalKey(named.key) ?? named.key));
        const guarded = matches.find((g) => g.protected);
        if (guarded) {
          return err(`Nothing was revoked: a revoke takes every grant for a key, and ${protectedKey(guarded.key, 'remove')}`);
        }
        read.doc.observers = read.doc.observers.filter((g) => !matches.includes(g as ObserverGrant));
        const revoked = matches.map((g) => (typeof g.label === 'string' ? g.label : g.key));
        return this.saved(read.doc, 'revoke', `Revoked: ${revoked.join(', ')}. Within about 3 s, new connections are refused, and its sessions and open connections end.`);
      }

      default:
        return unknownToolResult(this, call.name);
    }
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  /** The file as found, its usable grants and what's wrong with the rest; or
   *  why it can't be changed. A missing file is no grants yet. A file that
   *  can't be read, isn't valid JSON or isn't a grants file is never written
   *  over. `unparsed` marks one that isn't valid JSON, which the viewer reads
   *  differently, and `own` a read that failed for the host's own reason
   *  (OWN_FAILURES), which can pass. */
  private read():
    | { doc: GrantsDocument; usable: ObserverGrant[]; problems: string[] }
    | { problem: string; unparsed: boolean; own: boolean } {
    const read = readObserversFile(this.config.path);
    if (read.kind === 'ok') return { doc: read.doc, usable: read.file.observers, problems: read.problems };
    if (read.kind === 'missing') return { doc: { observers: [] }, usable: [], problems: [] };
    return {
      problem: `the grants file, ${this.config.path}, ${read.problem}`,
      unparsed: read.kind === 'unparsed',
      own: read.kind === 'unreadable' && read.code !== undefined && OWN_FAILURES.has(read.code),
    };
  }

  /** Save the changed document, and answer with `message` and the grants the
   *  file now gives, naming any entry it holds that isn't used. A write that
   *  fails leaves the file as it was, since it replaces the file whole
   *  (saveObserversFile), and says so, with the repair by whose failure it
   *  is: the host's own (OWN_FAILURES) can pass, and anything else is the
   *  operator's to fix. */
  private saved(doc: GrantsDocument, verb: 'grant' | 'revoke', message: string): ToolResult {
    try {
      saveObserversFile(this.config.path, doc as unknown as ObserversFile);
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      const repair = typeof code === 'string' && OWN_FAILURES.has(code)
        ? canPass(verb)
        : `Whoever runs this host can fix that; call observers--${verb} again once they have.`;
      return err(
        `Nothing was ${verb === 'grant' ? 'granted' : 'revoked'}: the grants file, ${this.config.path}, couldn't be written ` +
        `(${e instanceof Error ? e.message : String(e)}), and it's as it was. ${repair}`,
      );
    }
    const after = checkObserversFile(doc);
    return after.kind === 'ok'
      ? ok({ message, observers: after.file.observers, ...notUsed(after.problems) })
      : ok({ message });
  }
}

/** The entries a read found but the host doesn't use, each with its reason,
 *  for an answer that lists the grants. */
function notUsed(problems: string[]): { notUsed?: string[] } {
  return problems.length > 0 ? { notUsed: problems } : {};
}

/** An entry of the grants list that can be read as a grant's fields. */
function isEntry(g: unknown): g is ObserverGrant {
  return typeof g === 'object' && g !== null;
}

/** Failures of the file that are this host's own rather than the file's:
 *  too many files open, in this process (EMFILE) or the system (ENFILE).
 *  Nothing about the file needs fixing, and the failure can pass. */
const OWN_FAILURES = new Set(['EMFILE', 'ENFILE']);

/** What to do after a failure of the host's own (OWN_FAILURES): call the
 *  same tool again shortly. */
function canPass(tool: 'grant' | 'revoke' | 'get'): string {
  return `This host has too many files open, which can pass: call observers--${tool} again shortly, and if it fails the same way, ask whoever runs this host.`;
}

/** Why grant and revoke refuse a file they can't read, and what fixes it. */
function leftAlone(verb: 'grant' | 'revoke'): string {
  return (
    "These tools don't write over a file they can't read as grants, so they leave it alone until it's repaired. " +
    `Ask whoever runs this host to repair the file, then call observers--${verb} again.`
  );
}

function redactNothing(g: ObserverGrant): ObserverGrant {
  return g; // grants hold public keys + labels only — nothing secret to redact
}

function ok(data: Record<string, unknown>): ToolResult {
  return { success: true, data, isError: false };
}

function err(message: string): ToolResult {
  return { success: false, error: message, isError: true };
}

/** Whether a call gave an input at all: null counts as not given, as JSON
 *  callers send it for "none". */
function given(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/** Why a key's protected grant can't be changed or removed here, and that
 *  asking again won't help. */
function protectedKey(key: unknown, verb: 'change' | 'remove'): string {
  return (
    `the key ${shown(key)} holds a protected grant, part of this host's baseline, ` +
    `which only whoever runs the host can ${verb}. Calling again won't change that.`
  );
}
