import type { Socket } from 'node:net';

export const STOPPED_READING_MS = 5 * 60_000;

export interface StallClock {
  start(run: () => void, ms: number): unknown;
  stop(started: unknown): void;
}

const timers: StallClock = {
  start: (run, ms) => setTimeout(run, ms),
  stop: (started) => clearTimeout(started as ReturnType<typeof setTimeout>),
};

export function watchForStall(socket: Socket, deadlineMs: number, cut: (unsent: number) => void, clock: StallClock = timers): () => void {
  let deadline: unknown;
  let running = false;
  const clear = (): void => {
    if (!running) return;
    running = false;
    clock.stop(deadline);
  };
  socket.on('drain', clear);
  socket.on('finish', clear);
  socket.on('close', clear);
  return () => {
    if (running || socket.destroyed) return;
    running = true;
    deadline = clock.start(() => {
      running = false;
      cut(socket.writableLength);
    }, deadlineMs);
  };
}
