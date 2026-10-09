import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.DATA_DIR!;
writeFileSync(join(dir, 'headless.pid'), String(process.pid));
// Deliberately ignore shutdown commands and SIGTERM. Fleet must retain its
// synchronous exit cleanup while its normal escalation is still pending.
process.on('SIGTERM', () => {});
createServer(socket => {
  socket.on('error', () => {});
  socket.on('data', () => {});
  socket.write(JSON.stringify({ type: 'lifecycle', phase: 'ready', pid: process.pid }) + '\n');
}).listen(join(dir, 'ipc.sock'));
