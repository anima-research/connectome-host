import { createServer, type Socket } from 'node:net';
import {
  readFileSync, writeFileSync, unlinkSync, appendFileSync, existsSync, truncateSync, renameSync, writeSync, chmodSync, fstatSync,
  closeSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { finished } from 'node:stream';
import { waitToBeListed } from '../src/fleet-begin.js';

const options = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as {
  ready?: boolean;
  idle?: boolean;
  crashBeforeSocket?: boolean;
  noSocket?: boolean;
  crashOnFile?: string;
  stderr?: string;
  truncateStartupLog?: boolean;
  replaceStartupLog?: string;
  fifoStartupLog?: boolean;
  lockStartupLog?: boolean;
  lockDataDir?: boolean;
  reportStderr?: string;
  connections?: string;
  helperPid?: string;
  atGate?: string;
  begun?: string;
  closeStdinAtGate?: boolean;
  stdinErrorAtGate?: boolean;
  chunks?: string;
  stdinDone?: string;
};
if (options.closeStdinAtGate) {
  closeSync(0);
  if (options.atGate !== undefined) writeFileSync(options.atGate, '');
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
}
if (options.atGate !== undefined) writeFileSync(options.atGate, '');
const listed = waitToBeListed();
if (options.chunks !== undefined) {
  const chunks = options.chunks;
  process.stdin.on('data', (chunk: Buffer) => setImmediate(() => appendFileSync(chunks, `${chunk.length}\n`)));
}
if (options.stdinErrorAtGate) process.stdin.emit('error', new Error('a pipe that failed'));
await listed;
if (options.begun !== undefined) writeFileSync(options.begun, '');
if (options.stdinDone !== undefined) {
  const stdinDone = options.stdinDone;
  process.stdin.resume();
  finished(process.stdin, () => setImmediate(() => writeFileSync(stdinDone, '')));
}
const dataDir = process.env.DATA_DIR!;
const socketPath = join(dataDir, 'ipc.sock');
const pidPath = join(dataDir, 'headless.pid');

const startupLog = join(dataDir, 'startup.log');
if (options.reportStderr !== undefined) writeFileSync(options.reportStderr, fstatSync(2).isFile() ? 'a file' : 'not a file');
if (options.truncateStartupLog) truncateSync(startupLog, 0);
if (options.replaceStartupLog !== undefined) {
  writeFileSync(`${startupLog}.new`, options.replaceStartupLog);
  renameSync(`${startupLog}.new`, startupLog);
}
if (options.fifoStartupLog) {
  unlinkSync(startupLog);
  if (spawnSync('mkfifo', [startupLog]).status !== 0) throw new Error('mkfifo failed');
}
if (options.stderr !== undefined) writeSync(2, options.stderr);
if (options.lockStartupLog) chmodSync(startupLog, 0o000);

appendFileSync(join(dataDir, 'launches.jsonl'), JSON.stringify({
  pid: process.pid, sentinel: process.env.FLEET_TEST_SENTINEL ?? null,
  installRoot: process.env.CONNECTOME_INSTALL_ROOT ?? null,
  begin: process.env.CONNECTOME_FLEET_BEGIN ?? null,
}) + '\n');

if (options.helperPid !== undefined) {
  const helper = spawn('sleep', ['60'], { stdio: 'ignore' });
  writeFileSync(options.helperPid, String(helper.pid));
  helper.unref();
}
if (options.lockDataDir) chmodSync(dataDir, 0o600);
if (options.crashBeforeSocket) process.exit(1);
if (options.noSocket) {
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
}

writeFileSync(pidPath, String(process.pid));
process.on('exit', () => {
  try { unlinkSync(socketPath); } catch { }
  try { unlinkSync(pidPath); } catch { }
});

let client: Socket | null = null;
const server = createServer((socket) => {
  client = socket;
  if (options.connections !== undefined) appendFileSync(options.connections, 'connected\n');
  socket.on('error', () => {});
  let buffer = '';
  socket.on('data', (data) => {
    buffer += data.toString();
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const command = JSON.parse(line);
      if (command.type === 'shutdown') process.exit(0);
      if (command.type === 'command' && command.command === '/crash') process.exit(1);
      if (command.type === 'command' && command.command === '/drop') socket.destroy();
    }
  });
  if (options.ready !== false) {
    socket.write(JSON.stringify({ type: 'lifecycle', phase: 'ready', pid: process.pid, ts: Date.now() }) + '\n');
    if (options.idle) socket.write(JSON.stringify({ type: 'lifecycle', phase: 'idle', ts: Date.now() }) + '\n');
  }
});
server.listen(socketPath);
if (options.crashOnFile) setInterval(() => {
  if (existsSync(options.crashOnFile!)) process.exit(1);
}, 5);
process.on('SIGTERM', () => {
  client?.destroy();
  process.exit(0);
});
