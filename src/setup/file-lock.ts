import { Database } from 'bun:sqlite';

export function takeFileLock(file: string, waitMs = 0): { release(): void } | null {
  let db: Database | undefined;
  try {
    db = new Database(file, { create: true });
    db.exec(`PRAGMA busy_timeout = ${waitMs}`);
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    db?.close();
    if ((error as { code?: string }).code === 'SQLITE_BUSY') return null;
    throw error;
  }
  const held = db;
  return { release: () => held.close() };
}
