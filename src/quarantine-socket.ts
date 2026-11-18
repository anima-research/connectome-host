/** Finite local control channel. Never a stream owner, subscription, or generic dispatcher. */
import { createServer, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { constants as F, closeSync, fstatSync, lstatSync, mkdirSync, openSync,
  symlinkSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { dirname } from 'node:path';
import { quarantineSocketPath } from './quarantine-socket-path.js';
import { STOPPED_READING_MS, watchForStall } from './client-stall.js';
import type { QuarantineCommand } from './quarantine-operator.js';

const same = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;
const statIfPresent = (path: string): Stats | undefined => {
  try { return lstatSync(path); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
};

/** Failure disables ONLY this optional channel; the interactive listener is untouched.
 * No stale reclamation: any existing endpoint or claim requires explicit admin
 * recovery. The immutable exclusive claim spans bind through final cleanup.
 */
export async function listenQuarantineSocket(dataDir: string, options: {
  ready: Record<string, unknown>;
  handle(command: QuarantineCommand): Promise<Record<string, unknown>>;
  log(message: string): void;
  signal?: AbortSignal;
}): Promise<{ close(): Promise<void> }> {
  options.signal?.throwIfAborted();
  if (process.platform !== 'linux') throw new Error('quarantine channel requires Linux');
  const path = quarantineSocketPath(dataDir);
  if (Buffer.byteLength(path) > 103) throw new Error('quarantine UNIX socket path too long');
  const parent = lstatSync(dataDir);
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o022)) {
    throw new Error('quarantine data directory ownership/write permissions refused');
  }
  try { mkdirSync(dirname(path), { mode: 0o700 }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  const fd = openSync(dirname(path), F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
  const dir = fstatSync(fd);
  if (dir.uid !== process.getuid?.() || (dir.mode & 0o777) !== 0o700) {
    closeSync(fd); throw new Error('quarantine socket directory must be owned and mode 0700');
  }
  const anchor = `/proc/self/fd/${fd}`;
  const endpoint = `${anchor}/s`, receipt = `${anchor}/owner.json`;
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    if (options.signal?.aborted) { socket.destroy(); return; }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', error => options.log(`quarantine socket error: ${String(error)}`));
    const stalled = watchForStall(socket, STOPPED_READING_MS, () => socket.destroy());
    const reply = (event: Record<string, unknown>) => {
      if (socket.destroyed || socket.writableEnded) return;
      try { if (!socket.write(JSON.stringify({ ...event, ts: Date.now() }) + '\n')) stalled(); }
      catch (error) { options.log(`quarantine reply dropped: ${String(error)}`); }
    };
    socket.setEncoding('utf8');
    let buffer = '', busy = false;
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (Buffer.byteLength(line) > 65_536) { socket.destroy(); return; }
        let cmd: QuarantineCommand;
        try { cmd = JSON.parse(line); } catch { socket.destroy(); return; }
        if (!cmd || typeof cmd !== 'object' || typeof cmd.corrId !== 'string' || !cmd.corrId || cmd.corrId.length > 200) {
          socket.destroy(); return;
        }
        const corrId = cmd.corrId;
        if (!['quarantine-inspect', 'quarantine-release', 'quarantine-result'].includes(cmd.type)) {
          reply({ type: 'quarantine-response', corrId, status: 'refused', reason: 'quarantine verbs only' });
          continue;
        }
        if (busy) {
          reply({ type: 'quarantine-response', corrId, status: 'busy' });
          continue;
        }
        busy = true;
        // Requester loss does not cancel/retry admitted native work or move its reply.
        void options.handle(cmd).then(result => reply({ ...result, type: 'quarantine-response', corrId }),
          () => reply({ type: 'quarantine-response', corrId, status: 'uncertain', reason: 'control handler failed; never retry' }))
          .finally(() => { busy = false; });
      }
      if (Buffer.byteLength(buffer) > 65_536) socket.destroy();
    });
    // This handshake is channel readiness only; no boot replay or foreground events.
    reply({ ...options.ready, type: 'lifecycle', phase: 'ready' });
  });
  let ownedSocket: Stats | undefined, ownedReceipt: Stats | undefined, ownedAlias: Stats | undefined;
  let owner: number | undefined;
  const alias = `${anchor}/.bind-${randomUUID()}`;
  const unlinkOwned = (path: string, owned: Stats | undefined) => {
    if (!owned) return;
    const current = statIfPresent(path);
    if (current && same(owned, current)) unlinkSync(path);
  };
  const removeAlias = () => unlinkOwned(alias, ownedAlias);
  const cleanup = () => {
    // The claim is held until the socket is gone; no legitimate new generation
    // can bind between these synchronous operations. Keep its fd open against
    // inode reuse, and never clean an endpoint after losing our claim.
    const claim = statIfPresent(receipt);
    if (ownedReceipt && claim && same(ownedReceipt, claim)) {
      unlinkOwned(endpoint, ownedSocket);
      unlinkOwned(receipt, ownedReceipt);
    }
  };
  let closing: Promise<void> | undefined;
  const close = (removeOwned: boolean): Promise<void> => closing ??= new Promise(resolve => {
    for (const socket of sockets) socket.destroy();
    server.close(() => {
      try { if (removeOwned) cleanup(); }
      catch (error) { options.log(`quarantine cleanup refused: ${String(error)}`); }
      finally { if (owner !== undefined) closeSync(owner); closeSync(fd); resolve(); }
    });
  });
  const cancelled = new Error('quarantine listener startup cancelled by shutdown');
  let cancelListen: (() => void) | undefined;
  try {
    if (statIfPresent(endpoint)) throw new Error('existing quarantine endpoint; left untouched; explicit admin recovery required');
    try {
      owner = openSync(receipt, F.O_WRONLY | F.O_CREAT | F.O_EXCL | F.O_NOFOLLOW, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('existing quarantine ownership claim; left untouched; explicit admin recovery required');
      }
      throw error;
    }
    ownedReceipt = fstatSync(owner);
    writeFileSync(owner, JSON.stringify({ v: 2, generation: randomUUID() }));
    // Also refuse legacy/unknown sockets appearing before reservation. Never
    // mutate them, or release a partial startup reservation automatically.
    if (statIfPresent(endpoint)) throw new Error('existing quarantine endpoint; left untouched; explicit admin recovery required');
    server.on('error', error => options.log(`quarantine server error: ${String(error)}`));
    // net.Server unlinks its *listen path* on close, without an inode check in
    // Bun. Bind through a one-use private directory alias and remove the alias
    // immediately: automatic cleanup can then reach nothing. Our own anchored
    // inode-checked cleanup below is the ONLY unlink of the actual endpoint.
    symlinkSync('.', alias);
    ownedAlias = lstatSync(alias);
    await new Promise<void>((resolve, reject) => {
      cancelListen = () => reject(cancelled);
      options.signal?.addEventListener('abort', cancelListen, { once: true });
      server.once('error', reject);
      server.listen(`${alias}/s`, () => { server.removeListener('error', reject); resolve(); });
      // UNIX bind has created the endpoint before listen() returns, even if
      // its callback has not run. Retain its inode so cancellation in that
      // window can clean ONLY this reservation, without awaiting the callback.
      ownedSocket = statIfPresent(endpoint);
    });
    removeAlias();
    if (options.signal?.aborted) throw cancelled;
  } catch (error) {
    removeAlias();
    await close(error === cancelled);
    // Failed startup deliberately leaves any claim/socket as conservative
    // partial state. Explicit cancellation removes only our own reservation.
    throw error;
  } finally {
    if (cancelListen) options.signal?.removeEventListener('abort', cancelListen);
  }
  return { close: () => close(true) };
}
