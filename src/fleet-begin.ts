/**
 * A fleet child's start, on a host that keeps the children file
 * (src/modules/fleet-module.ts): the child begins only once that file lists
 * it. Kept apart from the fleet module, with no imports, so a test's stand-in
 * child waits as a host does.
 */

/** Set by a fleet that keeps the children file in the environment of each
 *  child it launches: the child begins only once a line comes on its stdin
 *  (waitToBeListed), which the fleet writes once the child is recorded and
 *  listed. So no child of such a host acts in its data directory where the
 *  file doesn't name it. */
export const FLEET_BEGIN_ENV = 'CONNECTOME_FLEET_BEGIN';

/**
 * In a child whose fleet set FLEET_BEGIN_ENV, wait for the line that says
 * it's listed, before it reads its recipe or does anything in its data
 * directory; only what its runtime and imports print before then reaches
 * startup.log, which the fleet opened for it. A stdin that ends or fails
 * first means the host that launched it ended before the line reached it,
 * whether or not it had listed it by then: the child exits, having done
 * nothing. Once the line has come, the child reads nothing more from stdin,
 * so the host's end later on leaves it running, for the next host to adopt.
 */
export async function waitToBeListed(): Promise<void> {
  if (process.env[FLEET_BEGIN_ENV] !== 'line') return;
  delete process.env[FLEET_BEGIN_ENV];
  await new Promise<void>((begin) => {
    const onData = (chunk: Buffer): void => {
      if (!chunk.includes(10)) return;
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.off('error', onEnd);
      process.stdin.destroy();
      begin();
    };
    // A pipe that fails says no more than one that ends.
    const onEnd = (): void => process.exit(1);
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onEnd);
    process.stdin.resume();
  });
}
