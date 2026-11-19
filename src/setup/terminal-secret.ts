import type { Interface } from 'node:readline';
import type { Writable } from 'node:stream';

type Echoing = Interface & { _writeToOutput?: (text: string) => void; history?: string[] };

export function askHidden(rl: Interface, output: Writable, label: string): Promise<string | null> {
  const echoing = rl as Echoing;
  const write = echoing._writeToOutput;
  // readline echoes what's typed through its own _writeToOutput, which isn't part of its documented interface.
  if (typeof write !== 'function' || !Array.isArray(echoing.history)) {
    throw new Error('this terminal\'s readline offers no way to keep what\'s typed from showing');
  }
  const others = rl.rawListeners('line') as Array<(line: string) => void>;
  rl.removeAllListeners('line');
  output.write(`\n${label}: `);
  echoing._writeToOutput = () => {};
  return new Promise((resolve) => {
    const done = (line: string | null) => {
      rl.off('line', onLine);
      rl.off('close', onClose);
      echoing._writeToOutput = write;
      for (const listener of others) rl.on('line', listener);
      output.write('\n');
      resolve(line);
    };
    // readline puts a line in its history before it hands the line on.
    const onLine = (line: string) => {
      const history = echoing.history!;
      history.splice(0, history.length, ...history.filter((entry) => entry !== line));
      done(line);
    };
    const onClose = () => done(null);
    rl.on('line', onLine);
    rl.on('close', onClose);
  });
}
