/**
 * A credential sent over ws:// to another machine can be read on the
 * network between: the framework puts a token, or the credential an access
 * grant attaches, in the url's query, and the WebSocket client sends a url's
 * user and password as a header. mcpl_deploy refuses such an entry; the
 * boot warns.
 */
import { describe, expect, test } from 'bun:test';
import { cleartextCarrierText, cleartextCredential, cleartextCredentialWarning, isLoopbackHost } from '../src/mcpl-config.js';

describe('cleartextCredential', () => {
  test('names each carrier it recognizes over ws:// to another machine, the grant first, then the token, then the url', () => {
    expect(cleartextCredential({ url: 'ws://tools.example:3101/mcpl', token: 't' })).toEqual({ carrier: 'token', host: 'tools.example:3101' });
    expect(cleartextCredential({ url: 'ws://10.0.0.7/mcpl', access: 'eidoverse' })).toEqual({ carrier: 'access', host: '10.0.0.7' });
    expect(cleartextCredential({ url: 'ws://tools.example', token: 't', access: 'eidoverse' })).toEqual({ carrier: 'access', host: 'tools.example' });
    expect(cleartextCredential({ url: 'ws://tools.example/mcpl?token=abc' })).toEqual({ carrier: 'url', host: 'tools.example' });
    expect(cleartextCredential({ url: 'ws://user:pass@tools.example/mcpl' })).toEqual({ carrier: 'url', host: 'tools.example' });
    expect(cleartextCredential({ url: 'ws://user@tools.example/mcpl' })).toEqual({ carrier: 'url', host: 'tools.example' });
    expect(cleartextCredential({ url: 'ws://:secret@tools.example/mcpl' })).toEqual({ carrier: 'url', host: 'tools.example' });
    expect(cleartextCredential({ url: 'ws://user:pass@tools.example/mcpl', access: 'eidoverse' })).toEqual({ carrier: 'access', host: 'tools.example' });
    // A grant named only spaces still resolves to whatever its issuer returns.
    expect(cleartextCredential({ url: 'ws://tools.example/mcpl', access: '  ' })).toEqual({ carrier: 'access', host: 'tools.example' });
    expect(cleartextCarrierText('access', '  ')).toBe('the credential of its access grant "  "');
    expect(cleartextCredential({ url: 'ws://tools.example?token=abc', token: 't' })).toEqual({ carrier: 'token', host: 'tools.example' });
  });

  test('recognizes no query parameter but token, and not a blank one', () => {
    expect(cleartextCredential({ url: 'ws://tools.example/mcpl?api_key=abc&access_token=def' })).toBeUndefined();
    expect(cleartextCredential({ url: 'ws://tools.example/mcpl?token=' })).toBeUndefined();
    expect(cleartextCredential({ url: 'ws://tools.example/mcpl?token=%20%20' })).toBeUndefined();
    expect(cleartextCredential({ url: 'ws://tools.example/mcpl?token=&token=abc' })).toEqual({ carrier: 'url', host: 'tools.example' });
  });

  test('counts a token the transport would send, but a blank one, and a grant whenever one is given', () => {
    expect(cleartextCredential({ url: 'ws://tools.example', token: 1234 })).toEqual({ carrier: 'token', host: 'tools.example' });
    expect(cleartextCredential({ url: 'ws://tools.example', token: '  ', access: '' })).toBeUndefined();
    expect(cleartextCredential({ url: 'ws://tools.example', token: false })).toBeUndefined();
  });

  test('passes wss://, this machine, and an entry with no credential', () => {
    expect(cleartextCredential({ url: 'wss://tools.example/mcpl', token: 't' })).toBeUndefined();
    expect(cleartextCredential({ url: 'wss://user:pass@tools.example/mcpl?token=abc' })).toBeUndefined();
    for (const url of ['ws://localhost:3101', 'ws://LOCALHOST', 'ws://127.0.0.1:8080', 'ws://127.4.5.6', 'ws://127.0.0.1.:8080', 'ws://[::1]:9', 'ws://[::ffff:127.0.0.1]', 'ws://0.0.0.0:9', 'ws://[::]:9', 'ws://[::ffff:0.0.0.0]:9']) {
      expect(cleartextCredential({ url, token: 't' })).toBeUndefined();
    }
    expect(cleartextCredential({ url: 'ws://tools.example' })).toBeUndefined();
  });

  test('counts only an entry the framework dials', () => {
    // A command with a url and no transport is spawned, not dialed.
    expect(cleartextCredential({ command: 'node', url: 'ws://tools.example', token: 't' })).toBeUndefined();
    expect(cleartextCredential({ command: 'node', url: 'ws://tools.example', token: 't', transport: 'stdio' })).toBeUndefined();
    expect(cleartextCredential({ url: 'ws://tools.example', token: 't', transport: 'stdio' })).toBeUndefined();
    expect(cleartextCredential({ command: 'node', url: 'ws://tools.example', token: 't', transport: 'websocket' }))
      .toEqual({ carrier: 'token', host: 'tools.example' });
  });

  test("leaves a url it can't parse, or of another scheme, to the framework, which refuses it at the dial", () => {
    expect(cleartextCredential({ url: 'not a url', token: 't' })).toBeUndefined();
    expect(cleartextCredential({ url: 'host:8080', token: 't' })).toBeUndefined();
    expect(cleartextCredential({ url: 'http://tools.example', token: 't' })).toBeUndefined();
  });

  test('reads a url that isn\'t a string, as an older overlay entry can hold, the way the transport coerces it', () => {
    expect(cleartextCredential({ url: ['ws://tools.example/mcpl'], token: 'dummy' })).toEqual({ carrier: 'token', host: 'tools.example' });
    expect(cleartextCredential({ url: ['wss://tools.example/mcpl'], token: 'dummy' })).toBeUndefined();
  });

  test('reads a url with spaces around it as the URL parser does', () => {
    expect(cleartextCredential({ url: '  ws://tools.example  ', token: 't' })).toEqual({ carrier: 'token', host: 'tools.example' });
  });
});

describe('isLoopbackHost', () => {
  test("is this machine for localhost, 127.0.0.0/8, ::1, IPv4-mapped 127.0.0.0/8 addresses, and 0.0.0.0, :: and ::ffff:0.0.0.0, as the parser gives them", () => {
    for (const host of ['localhost', '127.0.0.1', '127.255.0.1', '[::1]', '[::ffff:7f00:1]', '[::ffff:7fff:ffff]', '0.0.0.0', '[::]', '[::ffff:0:0]']) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  test('is another machine for any other name or address, including localhost. and names under .localhost, and ones that begin like a loopback address', () => {
    for (const host of ['localhost.', 'a.localhost', 'localhost.example', '127.0.0.1.attacker.example', '128.0.0.1', '10.0.0.1', '[::2]', '[::ffff:a00:1]', 'example.com']) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe('cleartextCredentialWarning', () => {
  test('names the server, what is sent, and where, and says to use wss://', () => {
    expect(cleartextCredentialWarning('tools', { url: 'ws://tools.example:3101', token: 't' })).toBe(
      '[mcpl] server "tools": its token goes to tools.example:3101 over unencrypted ws://, ' +
      'where anyone on the network between can read it; use wss:// unless that network is private',
    );
    expect(cleartextCredentialWarning('world', { url: 'ws://10.0.0.7', access: ' eidoverse ' })).toBe(
      '[mcpl] server "world": the credential of its access grant " eidoverse " goes to 10.0.0.7 over unencrypted ws://, ' +
      'where anyone on the network between can read it; use wss:// unless that network is private',
    );
    expect(cleartextCredentialWarning('pasted', { url: 'ws://user:pass@tools.example' })).toBe(
      '[mcpl] server "pasted": the user, password or token parameter in its url goes to tools.example over unencrypted ws://, ' +
      'where anyone on the network between can read it; use wss:// unless that network is private',
    );
    expect(cleartextCredentialWarning('safe', { url: 'wss://tools.example', token: 't' })).toBeUndefined();
  });
});
