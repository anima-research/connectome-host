import { readFileSync } from 'node:fs';

/**
 * On Linux an ended process passes from Z (a zombie its parent hasn't reaped)
 * through X to gone, and a read of its status can fail with ESRCH while it
 * goes. kill(pid, 0) counts a zombie as running.
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

export async function waitForEnd(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  let ended = processEnded(pid);
  while (!ended && Date.now() < deadline) {
    await Bun.sleep(50);
    ended = processEnded(pid);
  }
  return ended;
}
