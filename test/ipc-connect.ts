import { connect, type Socket } from 'node:net';

export const RETRY_PAUSE_MS = 20;

/**
 * A socket's path can exist before its server accepts on it, and a connect in
 * that gap is refused. The default deadline, 3 s, leaves a test room to fail
 * with the refusal within bun:test's 5 s per-test timeout.
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
        socket.off('error', onError);
        socket.once('error', () => { });
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
    await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS));
  }
}
