import { describe, expect, test, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync, lstatSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCall } from '@animalabs/agent-framework';
import { ObserversModule } from '../src/modules/observers-module.js';
import { loadObserversFile, ObserverRegistry } from '../src/modules/web-ui-observers.js';

// A canonical key: 43 base64url characters whose last one carries no stray bits.
const key = (c: string) => `ed25519:${c.repeat(42)}A`;
/** The same 32 bytes in standard base64, padded. */
const stdSpelling = (k: string) => `ed25519:${Buffer.from(k.slice(8), 'base64url').toString('base64')}`;
const call = (name: string, input: Record<string, unknown>): ToolCall => ({ id: `t-${name}`, name, input });
const stored = (path: string) => JSON.parse(readFileSync(path, 'utf-8')) as { observers: Array<Record<string, unknown>> } & Record<string, unknown>;
const keys = (path: string) => stored(path).observers.map((g) => g.key);
const labels = (data: unknown) => (data as { observers: Array<{ label: string }> }).observers.map((g) => g.label);

const BASELINE = { key: key('A'), label: 'baseline', scopes: ['health'], protected: true };
const PHONE = { key: key('B'), label: 'antra-phone', scopes: ['messages', 'tool-calls'] };
// A file an operator set up and then broke by hand: a protected baseline
// grant, and a second grant with a scope that doesn't exist.
const BAD_SCOPE = JSON.stringify({ observers: [BASELINE, PHONE] }, null, 2);
const TRUNCATED = BAD_SCOPE.slice(0, BAD_SCOPE.length - 10);
const GOOD = JSON.stringify({ observers: [BASELINE, { ...PHONE, scopes: ['messages'] }] }, null, 2);
const SAYS = 'grant 2 ("antra-phone") names a scope that doesn\'t exist: "tool-calls"';
const SCOPES = 'health, ops, messages, tools, thinking, debug';
const NO_END = 'leave expires out for a grant with no end';
const FORM = 'YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ (an offset such as +02:00 can stand for Z)';
const PROTECTED_A = (verb: string) =>
  `the key "${key('A')}" holds a protected grant, part of this host's baseline, which only whoever runs the host can ${verb}. Calling again won't change that.`;

describe('observers tools and the grants file', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'observers-'));
    path = join(dir, 'observers.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('truncated JSON: grant, revoke and get refuse, and the file is left as it was', async () => {
    writeFileSync(path, TRUNCATED);
    const m = new ObserversModule({ path });
    const grant = await m.handleToolCall(call('grant', { key: key('C'), label: 'new', scopes: ['health'] }));
    expect(grant.error).toStartWith('Nothing was granted:');
    expect(grant.error).toContain(`${path}, isn't valid JSON`);
    expect(grant.error).toContain('These tools don\'t write over a file they can\'t read as grants');
    expect(grant.error).toContain('whoever runs this host');
    expect(grant.error).toContain('then call observers--grant again');
    const revoke = await m.handleToolCall(call('revoke', { label: 'baseline' }));
    expect(revoke.error).toStartWith('Nothing was revoked:');
    expect(revoke.error).toContain(path);
    expect(revoke.error).toContain('then call observers--revoke again');
    const get = await m.handleToolCall(call('get', {}));
    expect(get.error).toStartWith('The grants can\'t be listed:');
    expect(get.error).toContain('Until it parses');
    expect(get.error).toContain('whoever runs this host');
    expect(readFileSync(path, 'utf-8')).toBe(TRUNCATED);
  });

  test('a bad grant: get lists the usable ones and names it, and a grant keeps it as found', async () => {
    writeFileSync(path, BAD_SCOPE);
    const m = new ObserversModule({ path });
    const get = await m.handleToolCall(call('get', {}));
    expect(labels(get.data)).toEqual(['baseline']);
    expect((get.data as { notUsed: string[] }).notUsed).toEqual([`${SAYS} (the scopes are health, ops, messages, tools, thinking, debug)`]);

    const grant = await m.handleToolCall(call('grant', { key: key('C'), label: 'new', scopes: ['health'] }));
    expect(grant.success).toBe(true);
    expect(labels(grant.data)).toEqual(['baseline', 'new']);
    expect((grant.data as { notUsed: string[] }).notUsed[0]).toStartWith(SAYS);
    expect(stored(path).observers).toEqual([BASELINE, PHONE, { key: key('C'), label: 'new', scopes: ['health'], expires: null }]);
  });

  test('a bad protected baseline doesn\'t stop the agent withdrawing its own grant', async () => {
    const baseline = { ...BASELINE, expires: 'next week' };
    writeFileSync(path, JSON.stringify({ observers: [baseline, { ...PHONE, scopes: ['messages'] }] }));
    const m = new ObserversModule({ path });
    const revoke = await m.handleToolCall(call('revoke', { label: 'antra-phone' }));
    expect(revoke.success).toBe(true);
    expect(stored(path).observers).toEqual([baseline]);
    const get = await m.handleToolCall(call('get', {}));
    expect(labels(get.data)).toEqual([]);
    expect((get.data as { notUsed: string[] }).notUsed).toEqual(['grant 1 ("baseline") has an expiry that isn\'t a date: "next week"']);
  });

  for (const [what, change, after] of [
    ['revoking the grant that\'s wrong', call('revoke', { label: 'antra-phone' }), [key('A')]],
    ['granting its key again with good values', call('grant', { key: key('B'), label: 'antra-phone', scopes: ['messages'] }), [key('A'), key('B')]],
  ] as const) {
    test(`${what} leaves a file whose every grant is used, and the protected grant stays`, async () => {
      writeFileSync(path, BAD_SCOPE);
      const res = await new ObserversModule({ path }).handleToolCall(change);
      expect(res.success).toBe(true);
      expect((res.data as { notUsed?: string[] }).notUsed).toBeUndefined();
      expect(keys(path)).toEqual([...after]);
      expect(stored(path).observers[0]).toEqual(BASELINE);
    });
  }

  test('a repeated key: a grant replaces every entry for it, and a revoke by key or label takes them all', async () => {
    const narrow = { key: key('B'), label: 'phone (narrow)', scopes: ['health'] };
    writeFileSync(path, JSON.stringify({ observers: [BASELINE, { ...PHONE, scopes: ['messages'] }, narrow] }));
    const m = new ObserversModule({ path });
    const get = await m.handleToolCall(call('get', {}));
    expect((get.data as { notUsed: string[] }).notUsed).toEqual(['grant 3 ("phone (narrow)") repeats the key of grant 2, so it isn\'t used']);
    expect((await m.handleToolCall(call('grant', { key: key('B'), label: 'phone', scopes: ['health'] }))).success).toBe(true);
    expect(stored(path).observers.map((g) => g.label)).toEqual(['baseline', 'phone']);

    writeFileSync(path, JSON.stringify({ observers: [BASELINE, { ...PHONE, scopes: ['messages'] }, narrow] }));
    expect((await m.handleToolCall(call('revoke', { key: key('B') }))).success).toBe(true);
    expect(keys(path)).toEqual([key('A')]);

    // By label too: revoking the entry in use takes the repeat with it, so
    // the repeat isn't used in its place.
    writeFileSync(path, JSON.stringify({ observers: [BASELINE, { ...PHONE, scopes: ['messages'] }, narrow] }));
    const byLabel = await m.handleToolCall(call('revoke', { label: 'antra-phone' }));
    expect(byLabel.success).toBe(true);
    expect((byLabel.data as { message: string }).message).toStartWith('Revoked: antra-phone, phone (narrow).');
    expect(keys(path)).toEqual([key('A')]);

    // A label whose key also holds a protected grant is refused.
    const shadow = { key: key('A'), label: 'baseline copy', scopes: ['health'] };
    writeFileSync(path, JSON.stringify({ observers: [BASELINE, shadow] }));
    const overBaseline = await m.handleToolCall(call('revoke', { label: 'baseline copy' }));
    expect(overBaseline.error).toBe(`Nothing was revoked: a revoke takes every grant for a key, and ${PROTECTED_A('remove')}`);
    expect(stored(path).observers).toEqual([BASELINE, shadow]);

    // So is one by key, or a grant, when the protected entry comes second.
    writeFileSync(path, JSON.stringify({ observers: [shadow, BASELINE] }));
    expect((await m.handleToolCall(call('revoke', { key: key('A') }))).error).toBe(`Nothing was revoked: a revoke takes every grant for a key, and ${PROTECTED_A('remove')}`);
    expect((await m.handleToolCall(call('grant', { key: key('A'), label: 'mine', scopes: ['health'] }))).error).toBe(`Nothing was granted: ${PROTECTED_A('change')}`);
    expect(stored(path).observers).toEqual([shadow, BASELINE]);

    // A label that names two entries is refused.
    const twin = { key: key('D'), label: 'antra-phone', scopes: ['health'] };
    writeFileSync(path, JSON.stringify({ observers: [BASELINE, { ...PHONE, scopes: ['messages'] }, twin] }));
    expect((await m.handleToolCall(call('revoke', { label: 'antra-phone' }))).error).toBe(
      `Nothing was revoked: 2 grants are labelled "antra-phone". Revoke by key instead: "${key('B')}" or "${key('D')}".`,
    );
    expect(keys(path)).toEqual([key('A'), key('B'), key('D')]);
    const overProtected = await m.handleToolCall(call('grant', { key: key('A'), label: 'mine now', scopes: ['debug'] }));
    expect(overProtected.isError).toBe(true);
  });

  test('a document that isn\'t a grants file is refused, and an object with no list takes one', async () => {
    for (const body of ['null', '[]', '42', '{"observers": {}}']) {
      writeFileSync(path, body);
      const grant = await new ObserversModule({ path }).handleToolCall(call('grant', { key: key('C'), label: 'new', scopes: ['health'] }));
      expect(grant.error).toStartWith('Nothing was granted:');
      expect(readFileSync(path, 'utf-8')).toBe(body);
    }
    writeFileSync(path, '{"note": "kept"}');
    expect((await new ObserversModule({ path }).handleToolCall(call('grant', { key: key('C'), label: 'new', scopes: ['health'] }))).success).toBe(true);
    expect(stored(path)).toEqual({ note: 'kept', observers: [{ key: key('C'), label: 'new', scopes: ['health'], expires: null }] });
  });

  test('a directory at the path is refused by all three tools, and left as it is', async () => {
    mkdirSync(path);
    const m = new ObserversModule({ path });
    const answers = [
      ['Nothing was granted:', await m.handleToolCall(call('grant', { key: key('C'), label: 'new', scopes: ['health'] }))],
      ['Nothing was revoked:', await m.handleToolCall(call('revoke', { label: 'baseline' }))],
      ['The grants can\'t be listed:', await m.handleToolCall(call('get', {}))],
    ] as const;
    for (const [opening, answer] of answers) {
      expect(answer.isError).toBe(true);
      expect(answer.error).toStartWith(opening);
      expect(answer.error).toContain(`${path}, can't be read`);
    }
    expect(lstatSync(path).isDirectory()).toBe(true);
    expect(readdirSync(path)).toEqual([]);
  });

  test('through a link to a readable file, a grant writes that file and the link stays a link', async () => {
    mkdirSync(join(dir, 'real'));
    const real = join(dir, 'real', 'observers.json');
    writeFileSync(real, GOOD);
    symlinkSync(real, path);
    expect((await new ObserversModule({ path }).handleToolCall(call('grant', { key: key('C'), label: 'new', scopes: ['health'] }))).success).toBe(true);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(keys(real)).toEqual([key('A'), key('B'), key('C')]);
  });

  test('a link whose file is gone is refused, and the link is left in place', async () => {
    symlinkSync(join(dir, 'gone', 'observers.json'), path);
    const m = new ObserversModule({ path });
    const grant = await m.handleToolCall(call('grant', { key: key('C'), label: 'new', scopes: ['health'] }));
    expect(grant.error).toStartWith('Nothing was granted:');
    expect(grant.error).toContain('is a link to a file that can\'t be read');
    expect((await m.handleToolCall(call('get', {}))).isError).toBe(true);
    expect((await m.handleToolCall(call('revoke', { key: key('B') }))).isError).toBe(true);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
  });

  test('every bad entry is named, and the good ones still listed', async () => {
    writeFileSync(path, JSON.stringify({ observers: [
      { key: 'rsa:x', label: 'one', scopes: ['health'] },
      { key: key('B'), label: 'two', scopes: 'health', expires: 'soon' },
      7,
      { key: key('D'), label: 'four', scopes: ['health'], expires: 'next week' },
      { key: key('E'), label: 'five', scopes: ['health', 'tool-calls', 'logs'] },
      { key: key('F'), label: 'six', scopes: ['health'] },
      null,
      { key: key('G'), label: 'eight', scopes: [] },
      { key: key('H'), label: 'nine', scopes: ['health'], expires: { toString: 1, valueOf: 1 } },
      { key: 'ed25519:' + key('I').slice(9), label: 'ten', scopes: ['health'] },
    ] }));
    const m = new ObserversModule({ path });
    const get = await m.handleToolCall(call('get', {}));
    expect(labels(get.data)).toEqual(['six']);
    const notUsed = (get.data as { notUsed: string[] }).notUsed;
    expect(notUsed).toContain('grant 1 ("one") has no "ed25519:" key');
    expect(notUsed).toContain('grant 2 ("two") has an expiry that isn\'t a date: "soon"');
    expect(notUsed).toContain('grant 2 ("two") has no list of scopes');
    expect(notUsed).toContain('grant 3 isn\'t an object');
    expect(notUsed).toContain('grant 4 ("four") has an expiry that isn\'t a date: "next week"');
    expect(notUsed).toContain('grant 5 ("five") names scopes that don\'t exist: "tool-calls", "logs" (the scopes are health, ops, messages, tools, thinking, debug)');
    expect(notUsed).toContain('grant 7 isn\'t an object');
    expect(notUsed).toContain('grant 8 ("eight") has no scopes');
    expect(notUsed).toContain('grant 9 ("nine") has an expiry that isn\'t a date: {"toString":1,"valueOf":1}');
    expect(notUsed).toContain('grant 10 ("ten") has a key that doesn\'t decode to 32 bytes');
    // A grant and a revoke read past the null entry and keep it as found.
    expect((await m.handleToolCall(call('grant', { key: key('J'), label: 'eleven', scopes: ['health'] }))).success).toBe(true);
    expect((await m.handleToolCall(call('revoke', { label: 'eleven' }))).success).toBe(true);
    expect(stored(path).observers[6]).toBeNull();
    expect(stored(path).observers).toHaveLength(10);
  });

  test('one key spelled two ways is one key: the second is a repeat, and a revoke of either takes both', async () => {
    const phone = { key: key('B'), label: 'phone', scopes: ['health'] };
    const phoneStd = { key: stdSpelling(key('B')), label: 'phone-std', scopes: ['health', 'messages'] };
    writeFileSync(path, JSON.stringify({ observers: [BASELINE, phone, phoneStd] }));
    const m = new ObserversModule({ path });
    const get = await m.handleToolCall(call('get', {}));
    expect(labels(get.data)).toEqual(['baseline', 'phone']);
    expect((get.data as { notUsed: string[] }).notUsed).toEqual(['grant 3 ("phone-std") repeats the key of grant 2, so it isn\'t used']);
    expect((await m.handleToolCall(call('revoke', { label: 'phone' }))).success).toBe(true);
    expect(keys(path)).toEqual([key('A')]);

    writeFileSync(path, JSON.stringify({ observers: [BASELINE, phone, phoneStd] }));
    expect((await m.handleToolCall(call('revoke', { key: stdSpelling(key('B')) }))).success).toBe(true);
    expect(keys(path)).toEqual([key('A')]);

    // A grant in the other spelling is written in canonical form, in place of both.
    writeFileSync(path, JSON.stringify({ observers: [BASELINE, phone, phoneStd] }));
    expect((await m.handleToolCall(call('grant', { key: stdSpelling(key('B')), label: 'phone', scopes: ['tools'] }))).success).toBe(true);
    expect(stored(path).observers).toEqual([BASELINE, { key: key('B'), label: 'phone', scopes: ['tools'], expires: null }]);
  });

  test('a number too large for JSON is written back as text, so the grant it broke stays unused', async () => {
    // 1e309 parses as Infinity, which JSON.stringify would write as null: no expiry at all.
    writeFileSync(path, `{"observers": [${JSON.stringify(BASELINE)}, {"key": "${key('B')}", "label": "forever?", "scopes": ["health"], "expires": 1e309}]}`);
    const m = new ObserversModule({ path });
    expect((await m.handleToolCall(call('get', {}))).data).toMatchObject({ notUsed: ['grant 2 ("forever?") has an expiry that isn\'t a date: Infinity'] });
    expect((await m.handleToolCall(call('grant', { key: key('C'), label: 'new', scopes: ['health'] }))).success).toBe(true);
    expect(stored(path).observers[1]!.expires).toBe('Infinity');
    expect(loadObserversFile(path)?.observers.map((g) => g.label)).toEqual(['baseline', 'new']);
  });

  test('a revoke by label takes every entry spelled with its key, when the key doesn\'t decode', async () => {
    const short = 'ed25519:short';
    writeFileSync(path, JSON.stringify({ observers: [BASELINE, { key: short, label: 'a', scopes: ['health'] }, { key: short, label: 'b', scopes: ['health'] }] }));
    const res = await new ObserversModule({ path }).handleToolCall(call('revoke', { label: 'a' }));
    expect((res.data as { message: string }).message).toStartWith('Revoked: a, b.');
    expect(keys(path)).toEqual([key('A')]);
  });

  test('a grant refuses a key that doesn\'t decode to 32 bytes', async () => {
    writeFileSync(path, GOOD);
    const dropped = key('C').slice(0, -1); // one character short
    const grant = await new ObserversModule({ path }).handleToolCall(call('grant', { key: dropped, label: 'short', scopes: ['health'] }));
    expect(grant.error).toContain('decodes to 32 bytes');
    expect(readFileSync(path, 'utf-8')).toBe(GOOD);
  });

  test('with a readable file, grant and revoke keep every other grant, and leave the protected one alone', async () => {
    writeFileSync(path, GOOD);
    const m = new ObserversModule({ path });
    expect((await m.handleToolCall(call('grant', { key: key('C'), label: 'new', scopes: ['health'] }))).success).toBe(true);
    expect(keys(path)).toEqual([key('A'), key('B'), key('C')]);
    const overProtected = await m.handleToolCall(call('grant', { key: key('A'), label: 'mine now', scopes: ['debug'] }));
    expect(overProtected.isError).toBe(true);
    const revokeProtected = await m.handleToolCall(call('revoke', { label: 'baseline' }));
    expect(revokeProtected.isError).toBe(true);
    expect(stored(path).observers[0]).toEqual(BASELINE);
    expect((await m.handleToolCall(call('revoke', { key: key('B') }))).success).toBe(true);
    expect(keys(path)).toEqual([key('A'), key('C')]);
  });

  test('control: with no file yet, a grant creates it, and get lists it', async () => {
    const m = new ObserversModule({ path });
    const grant = await m.handleToolCall(call('grant', { key: key('C'), label: 'new', scopes: ['health'] }));
    expect(grant.success).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(labels((await m.handleToolCall(call('get', {}))).data)).toEqual(['new']);
  });

  test('the registry\'s reading: a good file loads whole, a bad grant is left out, and a missing file is null', () => {
    expect(loadObserversFile(path)).toBeNull();
    writeFileSync(path, BAD_SCOPE);
    expect(loadObserversFile(path)).toEqual({ observers: [BASELINE] } as never);
    writeFileSync(path, JSON.stringify({ observers: [{ key: key('A'), label: 'ok', scopes: ['health'], extra: 1 }] }));
    expect(loadObserversFile(path)).toEqual({ observers: [{ key: key('A'), label: 'ok', scopes: ['health'], extra: 1 }] } as never);
  });
});

describe('what grant and revoke say', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'observers-say-'));
    path = join(dir, 'observers.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('a grant names every wrong input at once, each with what to give, and writes nothing', async () => {
    writeFileSync(path, GOOD);
    const m = new ObserversModule({ path });
    const wrong = await m.handleToolCall(call('grant', { key: 'nope', label: 5, scopes: ['health', 'nope'], expires: 1000 }));
    expect(wrong.error).toBe(
      'Nothing was granted: key "nope" isn\'t an ed25519 public key: give "ed25519:<base64url public key>", a key that decodes to 32 bytes; ' +
      'label must be text, not 5; ' +
      `scopes names one that doesn't exist, "nope": the scopes are ${SCOPES}; ` +
      `expires must be text, not 1000: give a date as ${FORM}, or ${NO_END}.`,
    );
    const missing = await m.handleToolCall(call('grant', { label: '  ', scopes: 'health' }));
    expect(missing.error).toBe(
      'Nothing was granted: key is missing: give the observer\'s key, "ed25519:<base64url public key>", the fingerprint the person or device shows you; ' +
      'label is missing: say who this is, in your own words; ' +
      `scopes must be a list of one or more of ${SCOPES}, not "health".`,
    );
    const none = await m.handleToolCall({ id: 't-grant', name: 'grant', input: undefined as unknown as Record<string, unknown> });
    expect(none.error).toBe(
      'Nothing was granted: key is missing: give the observer\'s key, "ed25519:<base64url public key>", the fingerprint the person or device shows you; ' +
      'label is missing: say who this is, in your own words; ' +
      `scopes must be a list of one or more of ${SCOPES}.`,
    );
    const notTextKey = await m.handleToolCall(call('grant', { key: 5, label: 'x', scopes: ['health', 'nope', 'nada'] }));
    expect(notTextKey.error).toBe(
      'Nothing was granted: key 5 isn\'t an ed25519 public key: give "ed25519:<base64url public key>", a key that decodes to 32 bytes; ' +
      `scopes names ones that don't exist, "nope", "nada": the scopes are ${SCOPES}.`,
    );
    expect(readFileSync(path, 'utf-8')).toBe(GOOD);
  });

  test('a grant names wrong inputs before the file, even one that doesn\'t parse', async () => {
    writeFileSync(path, TRUNCATED);
    const r = await new ObserversModule({ path }).handleToolCall(call('grant', { label: 'x', scopes: ['health'] }));
    expect(r.error).toBe(
      'Nothing was granted: key is missing: give the observer\'s key, "ed25519:<base64url public key>", the fingerprint the person or device shows you.',
    );
    expect(readFileSync(path, 'utf-8')).toBe(TRUNCATED);
  });

  test('an expiry that isn\'t text, isn\'t a date in the ISO form or has passed is refused, and absent, null or empty means no end', async () => {
    const m = new ObserversModule({ path });
    for (const expires of [1000, true, { at: 1 }, ['2030-01-01T00:00:00Z']]) {
      const r = await m.handleToolCall(call('grant', { key: key('C'), label: 'phone', scopes: ['health'], expires }));
      expect(r.error).toBe(`Nothing was granted: expires must be text, not ${JSON.stringify(expires)}: give a date as ${FORM}, or ${NO_END}.`);
    }
    // Date.parse reads most of these, its lenient parser "3600." as the year
    // 3600 and "05/06/2026" as May 6; only the ISO form is taken.
    for (const expires of [
      'tomorrow', '3600', ' 86400 ', '+003600', '3600.5', '3600.', '3600,5', '86400.', '3600;', '3600 .',
      '2027', '2027-01', 'Oct 18 2999', '10/18/2999', '05/06/2999', '2999.01.01', ' 2999-01-01', '2999-01-01T12', '2999-13-01', '2999-01-01T25:00:00Z',
      // In the form, but out of range, which Date.parse reads anyway in the
      // form with a space: it read -9999 as an offset of 100 hours and 39
      // minutes.
      '2999-01-01 12:00:00-9999', '2999-01-01 12:00:00+2400', '2999-01-01t12:00:00-99:99', '2999-01-01 24:00:01Z', '2999-01-01 12:60Z',
    ]) {
      const r = await m.handleToolCall(call('grant', { key: key('C'), label: 'phone', scopes: ['health'], expires }));
      expect(r.error).toBe(`Nothing was granted: expires ${JSON.stringify(expires)} isn't a date as ${FORM}: give it in that form, or ${NO_END}.`);
    }
    // A day the month doesn't have is refused, where Date.parse moves it on.
    for (const expires of ['2999-02-29', '2999-04-31', '2999-02-30T00:00:00Z', '2100-02-29']) {
      const r = await m.handleToolCall(call('grant', { key: key('C'), label: 'phone', scopes: ['health'], expires }));
      expect(r.error).toBe(
        `Nothing was granted: expires ${JSON.stringify(expires)} names a day its month doesn't have, which is refused rather than ` +
        `moved into the next month: give a date that exists, as ${FORM}, or ${NO_END}.`,
      );
    }
    // A year below 100 is that year, so it has passed, where Date.parse reads
    // the form with a space as 2049 and 1999.
    for (const expires of ['0049-01-01 12:00:00Z', '0099-12-31 23:59Z', '0049-01-01']) {
      const r = await m.handleToolCall(call('grant', { key: key('C'), label: 'phone', scopes: ['health'], expires }));
      expect(r.error).toBe(
        `Nothing was granted: expires ${JSON.stringify(expires)} has already passed: give a later time, or ${NO_END} ` +
        '(observers--revoke ends this key\'s grants, if it has any and none is protected).',
      );
    }
    expect(existsSync(path)).toBe(false);
    for (const expires of [undefined, null, '']) {
      const r = await m.handleToolCall(call('grant', { key: key('C'), label: 'phone', scopes: ['health'], expires }));
      expect(r.success).toBe(true);
      expect((r.data as { message: string }).message).toBe('Granted: phone → [health]. Live within ~3s.'.replace('Granted', expires === undefined ? 'Granted' : 'Updated'));
      expect(stored(path).observers[0]!.expires).toBeNull();
    }
    const later = await m.handleToolCall(call('grant', { key: key('C'), label: 'phone', scopes: ['health'], expires: '2999-01-01T00:00:00Z' }));
    expect((later.data as { message: string }).message).toBe('Updated: phone → [health] until 2999-01-01T00:00:00Z. Live within ~3s.');
    expect(stored(path).observers).toEqual([{ key: key('C'), label: 'phone', scopes: ['health'], expires: '2999-01-01T00:00:00Z' }]);
    // Each form taken is written in ECMAScript's own form, with T, Z and an
    // offset's colon, and the answer names that text. The grant stores it,
    // apart from a time without a zone, which it stores as the instant it
    // read, in UTC. The registry's Date.parse reads what's stored as meant:
    // a date alone as its start in UTC, a time without a zone in the host's
    // time zone (UTC under bun test, unless TZ is set as the run starts; the
    // next test takes another), and a zone as given. The answer names the
    // instant for a date alone or a time without a zone, which don't say
    // their zone.
    const local = (y: number, mo: number, d: number, h: number) => new Date(y, mo - 1, d, h).toISOString().replace('.000Z', 'Z');
    for (const [typed, written, expires, meant, zoned] of [
      ['2999-01-01', '2999-01-01', '2999-01-01', '2999-01-01T00:00:00Z', false],
      ['2996-02-29', '2996-02-29', '2996-02-29', '2996-02-29T00:00:00Z', false], ['2400-02-29', '2400-02-29', '2400-02-29', '2400-02-29T00:00:00Z', false],
      ['2999-01-01T12:00', '2999-01-01T12:00', local(2999, 1, 1, 12), local(2999, 1, 1, 12), false],
      ['2999-01-01 12:00:00', '2999-01-01T12:00:00', local(2999, 1, 1, 12), local(2999, 1, 1, 12), false],
      ['2999-01-01T12:00:00.123456Z', '2999-01-01T12:00:00.123456Z', '2999-01-01T12:00:00.123456Z', '2999-01-01T12:00:00.123Z', true],
      ['2999-01-01T12:00:00+05:30', '2999-01-01T12:00:00+05:30', '2999-01-01T12:00:00+05:30', '2999-01-01T06:30:00Z', true],
      ['2999-01-01T12:00:00-0800', '2999-01-01T12:00:00-08:00', '2999-01-01T12:00:00-08:00', '2999-01-01T20:00:00Z', true],
      ['2999-01-01t12:00z', '2999-01-01T12:00Z', '2999-01-01T12:00Z', '2999-01-01T12:00:00Z', true],
      ['2999-01-01t12:00:00+0530', '2999-01-01T12:00:00+05:30', '2999-01-01T12:00:00+05:30', '2999-01-01T06:30:00Z', true],
      ['2999-01-01 12:00:00+2359', '2999-01-01T12:00:00+23:59', '2999-01-01T12:00:00+23:59', '2998-12-31T12:01:00Z', true],
      ['2999-01-01 24:00Z', '2999-01-01T24:00Z', '2999-01-01T24:00Z', '2999-01-02T00:00:00Z', true],
    ] as const) {
      const r = await m.handleToolCall(call('grant', { key: key('C'), label: 'phone', scopes: ['health'], expires: typed }));
      expect(r.error).toBeUndefined();
      expect((r.data as { message: string }).message).toBe(
        `Updated: phone → [health] until ${written}${zoned ? '' : `, which this host reads as ${meant}`}. Live within ~3s.`,
      );
      expect(stored(path).observers).toEqual([{ key: key('C'), label: 'phone', scopes: ['health'], expires }]);
      expect(new Date(Date.parse(expires)).toISOString().replace('.000Z', 'Z')).toBe(meant);
    }
    // The registry reads the stored text as the grant checked it: it admits
    // the key until the expiry, and not after.
    for (const [typed, end] of [['2999-01-01 12:00:00-0800', '2999-01-01T20:00:00Z'], ['2999-01-01 24:00Z', '2999-01-02T00:00:00Z']] as const) {
      await m.handleToolCall(call('grant', { key: key('C'), label: 'phone', scopes: ['health'], expires: typed }));
      const registry = new ObserverRegistry(path);
      registry.start();
      try {
        expect(registry.liveScopes(key('C'), Date.parse(end) - 1)).toEqual(new Set(['health']));
        expect(registry.liveScopes(key('C'), Date.parse(end) + 1)).toBeNull();
      } finally { registry.stop(); }
    }
  });

  test('a time without a zone is read in the host\'s zone and stored as that instant, which reads the same in any zone', async () => {
    // This grants in Europe/Berlin, then reads the stored expiry back in the
    // zone the run started in: bun test's UTC, unless TZ was set as it
    // started. The finally restores that zone, or UTC when none was set:
    // deleting TZ would put the process in the machine's own zone, not bun
    // test's UTC.
    const zone = process.env.TZ;
    const noonHere = new Date(2999, 0, 1, 12).getTime();
    const m = new ObserversModule({ path });
    try {
      process.env.TZ = 'Europe/Berlin';
      const r = await m.handleToolCall(call('grant', { key: key('C'), label: 'phone', scopes: ['health'], expires: '2999-01-01 12:00' }));
      expect((r.data as { message: string }).message).toBe(
        'Granted: phone → [health] until 2999-01-01T12:00, which this host reads as 2999-01-01T11:00:00Z. Live within ~3s.',
      );
    } finally {
      process.env.TZ = zone ?? 'Etc/UTC';
    }
    expect(new Date(2999, 0, 1, 12).getTime()).toBe(noonHere); // back in the zone the run started in
    expect(stored(path).observers).toEqual([{ key: key('C'), label: 'phone', scopes: ['health'], expires: '2999-01-01T11:00:00Z' }]);
    const registry = new ObserverRegistry(path);
    registry.start();
    try {
      expect(registry.liveScopes(key('C'), Date.parse('2999-01-01T11:00:00Z') - 1)).toEqual(new Set(['health']));
      expect(registry.liveScopes(key('C'), Date.parse('2999-01-01T11:00:00Z') + 1)).toBeNull();
    } finally { registry.stop(); }
  });

  test('an expiry that has passed is refused and names revoke, and the key\'s grant stays as it was', async () => {
    writeFileSync(path, GOOD);
    const m = new ObserversModule({ path });
    const passed = await m.handleToolCall(call('grant', { key: key('B'), label: 'antra-phone', scopes: ['messages'], expires: '1970-01-01T00:00:01Z' }));
    const refusal = `Nothing was granted: expires "1970-01-01T00:00:01Z" has already passed: give a later time, or ${NO_END} ` +
      '(observers--revoke ends this key\'s grants, if it has any and none is protected).';
    expect(passed.error).toBe(refusal);
    // For a key with a protected grant, the hint holds, and the protection
    // is named once the inputs are right, when the file is read.
    const overBaseline = await m.handleToolCall(call('grant', { key: key('A'), label: 'mine', scopes: ['health'], expires: '1970-01-01T00:00:01Z' }));
    expect(overBaseline.error).toBe(refusal);
    expect((await m.handleToolCall(call('grant', { key: key('A'), label: 'mine', scopes: ['health'] }))).error).toBe(`Nothing was granted: ${PROTECTED_A('change')}`);
    expect(readFileSync(path, 'utf-8')).toBe(GOOD);
    expect(loadObserversFile(path)!.observers.map((g) => g.label)).toEqual(['baseline', 'antra-phone']);
  });

  test('a revoke names what matched nothing, and that get lists the grants', async () => {
    writeFileSync(path, GOOD);
    const m = new ObserversModule({ path });
    const give = 'give key, the observer\'s key, or label, the exact label of its grant';
    expect((await m.handleToolCall(call('revoke', {}))).error).toBe(`Nothing was revoked: ${give}.`);
    expect((await m.handleToolCall(call('revoke', { key: 5 }))).error).toBe(`Nothing was revoked: key must be text, not 5; ${give}.`);
    expect((await m.handleToolCall(call('revoke', { key: [1], label: 7 }))).error).toBe(`Nothing was revoked: key must be text, not [1]; label must be text, not 7; ${give}.`);
    expect((await m.handleToolCall(call('revoke', { key: key('E') }))).error).toBe(`Nothing was revoked: no grant has the key "${key('E')}". observers--get lists the grants and their keys.`);
    expect((await m.handleToolCall(call('revoke', { label: 'nobody' }))).error).toBe('Nothing was revoked: no grant is labelled "nobody". observers--get lists the grants and their keys.');
    expect(readFileSync(path, 'utf-8')).toBe(GOOD);
    // Two entries of one key under one label name that key once.
    const twin = { key: key('C'), label: 'twin', scopes: ['health'] };
    writeFileSync(path, JSON.stringify({ observers: [twin, { ...twin, scopes: ['ops'] }] }));
    expect((await m.handleToolCall(call('revoke', { label: 'twin' }))).error).toBe(`Nothing was revoked: 2 grants are labelled "twin". Revoke by key instead: "${key('C')}".`);
  });

  test('a write that fails says nothing changed, and that the file is as it was', async () => {
    writeFileSync(path, GOOD);
    const m = new ObserversModule({ path });
    const spy = spyOn(fs, 'renameSync').mockImplementation(((a: fs.PathLike) => {
      throw Object.assign(new Error(`ENOSPC: no space left on device, rename '${a}'`), { code: 'ENOSPC' });
    }) as typeof fs.renameSync);
    try {
      const grant = await m.handleToolCall(call('grant', { key: key('C'), label: 'new', scopes: ['health'] }));
      expect(grant.error).toBe(
        `Nothing was granted: the grants file, ${path}, couldn't be written (ENOSPC: no space left on device, rename '${path}.tmp'), and it's as it was. ` +
        'Whoever runs this host can fix that; call observers--grant again once they have.',
      );
      const revoke = await m.handleToolCall(call('revoke', { label: 'antra-phone' }));
      expect(revoke.error).toBe(
        `Nothing was revoked: the grants file, ${path}, couldn't be written (ENOSPC: no space left on device, rename '${path}.tmp'), and it's as it was. ` +
        'Whoever runs this host can fix that; call observers--revoke again once they have.',
      );
    } finally { spy.mockRestore(); }
    expect(readFileSync(path, 'utf-8')).toBe(GOOD);
  });

  test('a read that fails on too many files open says it can pass', async () => {
    writeFileSync(path, GOOD);
    const m = new ObserversModule({ path });
    const readFile = fs.readFileSync;
    for (const [code, words] of [['EMFILE', 'too many open files'], ['ENFILE', 'file table overflow']] as const) {
      const spy = spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
        if (p === path) throw Object.assign(new Error(`${code}: ${words}, open '${p}'`), { code });
        return (readFile as (...a: unknown[]) => unknown)(p, ...rest);
      }) as typeof fs.readFileSync);
      try {
        const failed = `the grants file, ${path}, can't be read (${code}: ${words}, open '${path}')`;
        const again = (tool: string) => `This host has too many files open, which can pass: call observers--${tool} again shortly, and if it fails the same way, ask whoever runs this host.`;
        expect((await m.handleToolCall(call('grant', { key: key('C'), label: 'new', scopes: ['health'] }))).error).toBe(`Nothing was granted: ${failed}. ${again('grant')}`);
        expect((await m.handleToolCall(call('revoke', { label: 'antra-phone' }))).error).toBe(`Nothing was revoked: ${failed}. ${again('revoke')}`);
        expect((await m.handleToolCall(call('get', {}))).error).toBe(`The grants can't be listed: ${failed}. ${again('get')}`);
      } finally { spy.mockRestore(); }
    }
    expect(readFileSync(path, 'utf-8')).toBe(GOOD);
  });

  test('a write that fails on too many files open says it can pass', async () => {
    writeFileSync(path, GOOD);
    const m = new ObserversModule({ path });
    for (const [code, words] of [['EMFILE', 'too many open files'], ['ENFILE', 'file table overflow']] as const) {
      const spy = spyOn(fs, 'renameSync').mockImplementation(((a: fs.PathLike) => {
        throw Object.assign(new Error(`${code}: ${words}, rename '${a}'`), { code });
      }) as typeof fs.renameSync);
      try {
        const grant = await m.handleToolCall(call('grant', { key: key('C'), label: 'new', scopes: ['health'] }));
        expect(grant.error).toBe(
          `Nothing was granted: the grants file, ${path}, couldn't be written (${code}: ${words}, rename '${path}.tmp'), and it's as it was. ` +
          'This host has too many files open, which can pass: call observers--grant again shortly, and if it fails the same way, ask whoever runs this host.',
        );
        const revoke = await m.handleToolCall(call('revoke', { label: 'antra-phone' }));
        expect(revoke.error).toBe(
          `Nothing was revoked: the grants file, ${path}, couldn't be written (${code}: ${words}, rename '${path}.tmp'), and it's as it was. ` +
          'This host has too many files open, which can pass: call observers--revoke again shortly, and if it fails the same way, ask whoever runs this host.',
        );
      } finally { spy.mockRestore(); }
    }
    expect(readFileSync(path, 'utf-8')).toBe(GOOD);
  });

  test('a call naming a tool the module doesn\'t have lists the ones it has, on either surface', async () => {
    const asTools = await new ObserversModule({ path }).handleToolCall(call('kill', {}));
    expect(asTools.error).toBe('There\'s no tool "observers--kill", so nothing ran. The observers tools are observers--get, observers--grant and observers--revoke.');
    const asUtils = await new ObserversModule({ path, surface: 'utilities' }).handleToolCall(call('kill', {}));
    expect(asUtils.error).toStartWith('There\'s no tool "observers--kill", so nothing ran. The observers utilities are observers--get, observers--grant and observers--revoke,');
  });
});
