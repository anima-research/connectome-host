import { spawn } from 'node:child_process';

export async function holdFileLock(file: string): Promise<() => Promise<void>> {
  const source = new URL('../../src/setup/file-lock.ts', import.meta.url).href;
  const script = 'const { takeFileLock } = await import(' + JSON.stringify(source) + '); ' +
    'const held = takeFileLock(' + JSON.stringify(file) + '); ' +
    'if (held === null) throw new Error("could not hold the lock"); ' +
    'console.log("held"); setInterval(() => held, 1000);';
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const closed = new Promise<void>((done) => child.on('close', () => done()));
  const release = async () => { child.kill('SIGKILL'); await closed; };
  try {
    await new Promise<void>((done, reject) => {
      let output = '';
      child.on('error', reject);
      child.on('close', () => reject(new Error('lock holder exited before readiness')));
      child.stdout!.on('data', (chunk) => {
        output += String(chunk);
        if (output.includes('held\n')) done();
      });
    });
    return release;
  } catch (error) {
    await release();
    throw error;
  }
}
