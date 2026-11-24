import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { PRIVATE_DIR_MODE } from './update/data-swap.js';

export interface SessionMeta {
  id: string;
  name: string;
  manuallyNamed: boolean;
  createdAt: string;
  lastAccessedAt: string;
  messageCount?: number;
}

export interface SessionIndex {
  version: 1;
  activeSessionId: string;
  sessions: Record<string, SessionMeta>;
}

export interface ImportSource {
  conversationUuid?: string;
  name?: string;
  summary?: string | null;
  createdAt?: string;
  updatedAt?: string;
  agentName?: string;
  originalMessageCount?: number;
  importedMessageCount?: number;
  branched?: boolean;
  importedAt?: string;
}

export class SessionManager {
  private readonly dataDir: string;
  private readonly indexPath: string;
  private readonly sessionsDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.indexPath = join(dataDir, 'sessions.json');
    this.sessionsDir = join(dataDir, 'sessions');
  }

  load(): SessionIndex {
    if (!existsSync(this.indexPath)) {
      return { version: 1, activeSessionId: '', sessions: {} };
    }
    const raw = readFileSync(this.indexPath, 'utf-8');
    return JSON.parse(raw) as SessionIndex;
  }

  save(index: SessionIndex): void {
    mkdirSync(this.dataDir, { recursive: true, mode: PRIVATE_DIR_MODE });
    writeFileSync(this.indexPath, JSON.stringify(index, null, 2) + '\n');
  }

  private generateId(): string {
    return randomBytes(4).toString('hex');
  }

  createSession(name?: string): SessionMeta {
    const index = this.load();
    const id = this.generateId();
    const now = new Date().toISOString();

    const session: SessionMeta = {
      id,
      name: name ?? `Session ${Object.keys(index.sessions).length + 1}`,
      manuallyNamed: !!name,
      createdAt: now,
      lastAccessedAt: now,
    };

    // Not the store directory itself: JsStore.openOrCreate needs it absent to
    // know it should create (not open) the store.
    mkdirSync(this.sessionsDir, { recursive: true, mode: PRIVATE_DIR_MODE });

    index.sessions[id] = session;
    index.activeSessionId = id;
    this.save(index);

    return session;
  }

  deleteSession(id: string): void {
    const index = this.load();
    if (!index.sessions[id]) {
      throw new Error(`Session "${id}" not found`);
    }
    if (index.activeSessionId === id) {
      throw new Error('Cannot delete the active session');
    }

    const storePath = this.getStorePath(id);
    if (existsSync(storePath)) {
      rmSync(storePath, { recursive: true, force: true });
    }

    delete index.sessions[id];
    this.save(index);
  }

  renameSession(id: string, name: string, manual = true): void {
    const index = this.load();
    const session = index.sessions[id];
    if (!session) {
      throw new Error(`Session "${id}" not found`);
    }

    session.name = name;
    if (manual) session.manuallyNamed = true;
    this.save(index);
  }

  getStorePath(id: string): string {
    return join(this.sessionsDir, id);
  }

  getImportSource(id: string): ImportSource | null {
    const path = join(this.sessionsDir, `${id}.import-source.json`);
    if (!existsSync(path)) return null;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return null;
      }
      return parsed as ImportSource;
    } catch {
      return null;
    }
  }

  getActiveSession(): SessionMeta | null {
    const index = this.load();
    if (!index.activeSessionId) return null;
    return index.sessions[index.activeSessionId] ?? null;
  }

  setActiveSession(id: string): void {
    const index = this.load();
    if (!index.sessions[id]) {
      throw new Error(`Session "${id}" not found`);
    }
    index.activeSessionId = id;
    index.sessions[id]!.lastAccessedAt = new Date().toISOString();
    this.save(index);
  }

  findSession(nameOrId: string): SessionMeta | null {
    const index = this.load();
    if (index.sessions[nameOrId]) return index.sessions[nameOrId]!;
    for (const session of Object.values(index.sessions)) {
      if (session.name.toLowerCase() === nameOrId.toLowerCase()) return session;
    }
    for (const session of Object.values(index.sessions)) {
      if (session.id.startsWith(nameOrId)) return session;
    }
    return null;
  }

  listSessions(): SessionMeta[] {
    const index = this.load();
    return Object.values(index.sessions)
      .sort((a, b) => b.lastAccessedAt.localeCompare(a.lastAccessedAt));
  }

  migrateIfNeeded(): void {
    if (existsSync(this.indexPath)) return;

    const legacyStorePath = join(this.dataDir, 'store');
    if (!existsSync(legacyStorePath)) return;

    const id = this.generateId();
    const now = new Date().toISOString();

    mkdirSync(this.sessionsDir, { recursive: true, mode: PRIVATE_DIR_MODE });
    const newPath = join(this.sessionsDir, id);
    renameSync(legacyStorePath, newPath);

    const index: SessionIndex = {
      version: 1,
      activeSessionId: id,
      sessions: {
        [id]: {
          id,
          name: 'Initial Session',
          manuallyNamed: false,
          createdAt: now,
          lastAccessedAt: now,
        },
      },
    };

    this.save(index);
    console.log(`Migrated legacy store to session "${id}" (Initial Session)`);
  }

  updateMessageCount(id: string, count: number): void {
    const index = this.load();
    const session = index.sessions[id];
    if (session) {
      session.messageCount = count;
      this.save(index);
    }
  }
}
