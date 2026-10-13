/**
 * Offline child for FleetModule lifecycle regressions. The recipe file contains
 * only fixture options; no framework or provider is started.
 */
import { createServer, type Socket } from 'node:net';
import { readFileSync, writeFileSync, unlinkSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const options = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as {
  ready?: boolean;
  crashBeforeSocket?: boolean;
  noSocket?: boolean;
  crashOnFile?: string;
};
const dataDir = process.env.DATA_DIR!;
const socketPath = join(dataDir, 'ipc.sock');
const pidPath = join(dataDir, 'headless.pid');

appendFileSync(join(dataDir, 'launches.jsonl'), JSON.stringify({
  pid: process.pid, sentinel: process.env.FLEET_TEST_SENTINEL ?? null,
}) + '\n');

if (options.crashBeforeSocket) process.exit(1);
if (options.noSocket) {
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
}

writeFileSync(pidPath, String(process.pid));
process.on('exit', () => {
  try { unlinkSync(socketPath); } catch { /* already removed */ }
  try { unlinkSync(pidPath); } catch { /* already removed */ }
});

let client: Socket | null = null;
const server = createServer((socket) => {
  client = socket;
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
    }
  });
  if (options.ready !== false) {
    socket.write(JSON.stringify({ type: 'lifecycle', phase: 'ready', pid: process.pid, ts: Date.now() }) + '\n');
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
