/**
 * Whether a process a test started, or one a process it started left
 * behind, has ended, as /proc shows it: shared by the tests that ask so. A
 * test whose code reads a process's end through kill(pid, 0), as the fleet
 * does, waits for that instead, since kill(pid, 0) counts a zombie as
 * running until it's reaped.
 */
import { readFileSync } from 'node:fs';

/**
 * Whether the process `pid` has ended: gone, a zombie (`Z`) its parent
 * hasn't reaped yet, or one being reaped (`X`, dead). On Linux an ended
 * process passes from Z through X to gone, and a read of its status can
 * fail with ESRCH while it goes. Where there's no status to read, as on a
 * system without `/proc`, `kill(pid, 0)` says whether it's gone, and counts
 * a zombie as running. `read` stands in for reading a file, for this
 * module's own test.
 */
export function processEnded(pid: number, read: (path: string) => string = (path) => readFileSync(path, 'utf8')): boolean {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`processEnded needs a process id, not ${pid}`);
  try {
    return /^State:\s+[ZX]/m.test(read(`/proc/${pid}/status`));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return true;
    if (code !== 'ENOENT') throw error;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    throw error;
  }
}

/** Wait up to `ms` for the process `pid` to end, reading every 50 ms, and
 *  answer with the last read, so two reads can't disagree. */
export async function waitForEnd(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  let ended = processEnded(pid);
  while (!ended && Date.now() < deadline) {
    await Bun.sleep(50);
    ended = processEnded(pid);
  }
  return ended;
}
