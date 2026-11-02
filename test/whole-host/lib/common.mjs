import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { connect as netConnect } from 'node:net';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function sh(cmd, cmdArgs, { cwd, env = {}, timeout = 600_000, allowFail = false } = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd, env: { ...process.env, ...env }, encoding: 'utf-8', timeout, maxBuffer: 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) {
    throw new Error(`${cmd} ${cmdArgs.join(' ')} (cwd ${cwd}) exited ${r.status}${r.signal ? ' signal ' + r.signal : ''}\n${(r.stdout + '\n' + r.stderr).trim().slice(-3000)}`);
  }
  return r;
}

export function ipcConnect(path, timeoutMs = 5000) {
  return new Promise((res, rej) => {
    const s = netConnect(path);
    const t = setTimeout(() => { s.destroy(); rej(new Error(`ipc connect timeout ${path}`)); }, timeoutMs);
    s.once('connect', () => { clearTimeout(t); res(s); });
    s.once('error', (e) => { clearTimeout(t); rej(e); });
  });
}
export const send = (sock, obj) => sock.write(JSON.stringify(obj) + '\n');

const hostGroups = new Set();

export function stopHost(child) {
  if (!hostGroups.delete(child.pid)) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group is already empty */ }
}

function stopAllHosts() {
  for (const pid of hostGroups) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* the group is already empty */ }
  }
  hostGroups.clear();
}

let hostCleanupInstalled = false;
function installHostCleanup() {
  if (hostCleanupInstalled) return;
  hostCleanupInstalled = true;
  process.prependListener('exit', stopAllHosts);
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGQUIT', 'SIGHUP']) {
    process.on(signal, function onSignal() {
      stopAllHosts();
      process.removeListener(signal, onSignal);
      process.kill(process.pid, signal);
    });
  }
}

export function spawnHost({ hostDir, recipePath, dataDir, cwd, sockPath, env = {}, preload = null }) {
  const out = [];
  const child = spawn('bun', [...(preload ? ['--preload', preload] : []), join(hostDir, 'src', 'index.ts'), recipePath, '--headless', '--socket-path', sockPath], {
    cwd,
    env: { ...process.env, DATA_DIR: dataDir, ANTHROPIC_API_KEY: '', NO_COLOR: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  if (typeof child.pid === 'number') {
    installHostCleanup();
    hostGroups.add(child.pid);
  }
  child.stdout.on('data', (d) => out.push(d.toString()));
  child.stderr.on('data', (d) => out.push(d.toString()));
  return { child, out };
}

export function parseArgs(argv) {
  const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
  const opts = (name) => argv.flatMap((a, i) => (a === `--${name}` && i + 1 < argv.length ? [argv[i + 1]] : []));
  const flag = (name) => argv.includes(`--${name}`);
  return { opt, opts, flag };
}
