import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetModule } from '../src/modules/fleet-module.js';

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(10);
  }
}

// The fake child needs a socket that never reads. On CI this test must run,
// so a runner without python3 fails it; elsewhere it skips, and says so.
const noPython = !Bun.which('python3') && !process.env.CI;
if (noPython) console.warn('fleet-child-socket-reset: python3 not found, so this test is skipped');

// A child that dies with the parent's command unread resets the parent's
// socket. Where sockets behave as in Node (Bun 1.4.2), that socket then gets
// an error and 'close' but no 'end'. Bun 1.3.14 gives it an 'end', so there
// this test passes on main's source too.
test.skipIf(noPython)("a fleet parent lets go of a child's socket that resets", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-child-socket-reset-'));
  const socketPath = join(dir, 'ipc.sock');
  const fake = spawn('python3', ['-c', [
    'import select, socket, sys',
    's = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)',
    's.bind(sys.argv[1])',
    's.listen(1)',
    'print("listening", flush=True)',
    'c, _ = s.accept()',
    // Exit once the parent's command is waiting, unread.
    'select.select([c], [], [], 5)',
  ].join('\n'), socketPath], { stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = new Promise<void>((resolve) => fake.once('exit', () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      fake.stdout!.on('data', (chunk) => { if (String(chunk).includes('listening')) resolve(); });
      void exited.then(() => reject(new Error('the fake child exited before it listened')));
    });
    const fleet = new FleetModule() as unknown as {
      connectChildSocket(child: object): Promise<void>;
      sendToChild(child: object, cmd: object): void;
    };
    const child = { name: 'reset-child', socketPath, socket: null as unknown, buffer: '', events: [] };
    await fleet.connectChildSocket(child);
    expect(child.socket).not.toBeNull();
    fleet.sendToChild(child, { type: 'describe' });
    await exited;
    await until(() => child.socket === null, "the parent let go of the child's socket");
  } finally {
    fake.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
