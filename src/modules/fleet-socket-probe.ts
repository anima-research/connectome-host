// Imports only Node built-ins: fleet-smoke's "resource exhaustion cannot turn
// a live Unix listener into stale evidence" loads this module in a child of
// its own, which must not pay for the host's graph.
import { execFile } from 'node:child_process';

/** Bun 1.3 reports ENOENT for Unix refusals; 1.4 also maps EMFILE to
 *  ECONNREFUSED. So the connect runs in Node, which the host already
 *  requires and which preserves the actual error. A probe that can't run
 *  (no node on PATH, no descriptors to spawn it, its deadline) answers
 *  false: not refused. `deadlineMs`, 3 s unless given, is how long the
 *  probe may run before it's killed. */
export function socketRefusesConnection(socketPath: string, deadlineMs = 3_000): Promise<boolean> {
  const probe = `const {connect}=require('node:net');
    const socket=connect(process.argv[1]);
    socket.once('connect',()=>{socket.destroy();process.exitCode=1;});
    socket.once('error',error=>{socket.destroy();process.exitCode=error.code==='ECONNREFUSED'?0:1;});`;
  return new Promise((resolve) => {
    execFile('node', ['--input-type=commonjs', '-e', probe, socketPath], {
      env: { PATH: process.env.PATH ?? '' }, timeout: deadlineMs,
      killSignal: 'SIGKILL', maxBuffer: 1_024,
    }, error => resolve(error === null));
  });
}
