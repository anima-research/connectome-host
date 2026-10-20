import { connect, type Socket } from 'node:net';

/**
 * Connect to a headless process's IPC socket once it accepts connections.
 *
 * The socket's path can exist before its server accepts on it, and a connect
 * in that gap is refused, so a test that connects as soon as the path
 * appears fails on a loaded machine. This tries again 20 ms after any failed
 * connect until its deadline, then rejects with the last error. A refused
 * connect fails with ECONNREFUSED under Node and Bun 1.4, and with ENOENT
 * under Bun 1.3, as a path not there yet does; either is tried again. (The
 * fleet parent's connect to a starting child, connectStartingChild in
 * src/modules/fleet-module.ts, waits out the same gap by retrying a refused
 * connect or an absent path every 50 ms.)
 *
 * The deadline counts from the call and is checked after each failed
 * connect, so it bounds a socket that keeps refusing. Callers wait for the
 * path to appear first, so it only has to cover the gap before the server
 * accepts, and the default, 3 s, leaves a test that connects soon after the
 * path appears room to fail with the refusal within bun's 5 s per-test
 * timeout, rather than with the timeout.
 *
 * The socket it returns keeps a once('error') listener that ignores the
 * first later error, such as a reset when the process exits, as the
 * listeners of the connects it replaced did; a test that cares about one
 * attaches its own. onFailedConnect hears each failed connect's error, for a
 * test of the wait itself.
 */
export async function connectWhenAccepting(
  path: string,
  { timeoutMs = 3_000, allowHalfOpen = false, onFailedConnect }: {
    timeoutMs?: number;
    allowHalfOpen?: boolean;
    onFailedConnect?: (err: Error) => void;
  } = {},
): Promise<Socket> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const socket = connect({ path, allowHalfOpen });
    const error = await new Promise<Error | null>((resolve) => {
      const onConnect = () => {
        // The listener for a later error goes on here, before the promise
        // resolves and the caller's code runs.
        socket.off('error', onError);
        socket.once('error', () => { /* a later error is the test's, if it listens */ });
        resolve(null);
      };
      const onError = (err: Error) => { socket.off('connect', onConnect); resolve(err); };
      socket.once('connect', onConnect);
      socket.once('error', onError);
    });
    if (error === null) return socket;
    socket.destroy();
    onFailedConnect?.(error);
    if (Date.now() >= deadline) throw error;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
