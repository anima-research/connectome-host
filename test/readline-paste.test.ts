import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { PASTE_OFF, PASTE_ON, bracketedPaste } from '../src/readline-paste.js';

const START = '\x1b[200~';
const END = '\x1b[201~';

function terminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = '';
  output.on('data', (chunk) => { shown += chunk.toString(); });
  Object.assign(input, { isTTY: true, setRawMode: () => {} });
  const rl = createInterface({ input, output, terminal: true, prompt: '> ' });
  const signals = Object.assign(new EventEmitter(), {
    pid: 4242,
    killed: [] as Array<[number, string]>,
    kill(pid: number, signal: string) { signals.killed.push([pid, signal]); return true; },
  });
  const held: number[] = [];
  const paste = bracketedPaste(rl, input as never, output as never, (count) => held.push(count), signals as never);
  const messages: string[] = [];
  rl.on('line', (line) => {
    const message = paste.take(line);
    if (message !== null) messages.push(message);
  });
  const settle = () => new Promise((done) => setImmediate(done));
  return { input, rl, paste, signals, held, messages, settle, shown: () => shown };
}

test('turns the terminal\'s bracketed paste on, and lines typed one by one go on as typed', async () => {
  const { input, rl, messages, held, settle, shown } = terminal();
  expect(shown()).toStartWith(PASTE_ON);
  input.write('first\r');
  input.write('/quit\r');
  await settle();
  expect(messages).toEqual(['first', '/quit']);
  expect(held).toEqual([]);
  rl.close();
});

test('lines ended inside a paste are held, and the next Enter sends them with its line as one message', async () => {
  const { input, rl, messages, held, settle } = terminal();
  input.write(`${START}first\r/quit\rthird${END}`);
  await settle();
  expect(messages).toEqual([]);
  expect(held).toEqual([3]);
  input.write(' and more\r');
  await settle();
  expect(messages).toEqual(['first\n/quit\nthird and more']);
  input.write('after\r');
  await settle();
  expect(messages).toEqual(['first\n/quit\nthird and more', 'after']);
  rl.close();
});

test('a paste that ends with its own line break sends nothing by itself: an Enter on the empty line sends it', async () => {
  const { input, rl, messages, held, settle } = terminal();
  input.write(`${START}one\rtwo\r${END}`);
  await settle();
  expect(messages).toEqual([]);
  expect(held).toEqual([2]);
  input.write('\r');
  await settle();
  expect(messages).toEqual(['one\ntwo\n']);
  rl.close();
});

test('a one-line paste with no line break of its own holds nothing and says nothing: it\'s on the prompt to send', async () => {
  const { input, rl, messages, held, settle } = terminal();
  input.write(`${START}/quit${END}`);
  await settle();
  expect(held).toEqual([]);
  input.write('\r');
  await settle();
  expect(messages).toEqual(['/quit']);
  rl.close();
});

test('end() turns bracketed paste off once, and a paste after it goes on line by line', async () => {
  const { input, paste, rl, messages, settle, shown } = terminal();
  paste.end();
  paste.end();
  await settle();
  expect(shown().split(PASTE_OFF)).toHaveLength(2);
  input.write(`${START}one\rtwo\r${END}`);
  await settle();
  expect(messages).toEqual(['one', 'two']);
  rl.close();
});

test('the process exiting turns bracketed paste off', async () => {
  const { signals, rl, settle, shown } = terminal();
  signals.emit('exit', 1);
  await settle();
  expect(shown().endsWith(PASTE_OFF)).toBe(true);
  rl.close();
});

test('a SIGTERM turns bracketed paste off, then dies of the signal when nothing else in the process handles it', async () => {
  const { signals, rl, settle, shown } = terminal();
  signals.emit('SIGTERM');
  await settle();
  expect(shown().endsWith(PASTE_OFF)).toBe(true);
  expect(signals.killed).toEqual([[4242, 'SIGTERM']]);
  expect(signals.listenerCount('SIGTERM')).toBe(0);
  rl.close();
});

test('a SIGTERM something else in the process handles turns bracketed paste off and leaves the signal to it', async () => {
  const { signals, rl, settle, shown } = terminal();
  const other: string[] = [];
  signals.on('SIGTERM', () => other.push('handled'));
  signals.emit('SIGTERM');
  await settle();
  expect(shown().endsWith(PASTE_OFF)).toBe(true);
  expect(signals.killed).toEqual([]);
  expect(other).toEqual(['handled']);
  rl.close();
});
