/**
 * Session manager — isolated Chronicle stores with a JSON index.
 *
 * Each session is an independent Chronicle store directory under
 * `{dataDir}/sessions/{id}/`. The index file `{dataDir}/sessions.json`
 * tracks metadata (name, timestamps, manual naming flag).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

/**
 * Provenance recorded by the claude.ai importer alongside each session.
 * Fields are optional because older sessions imported before a given field
 * existed will simply omit it. Callers reading this should treat every
 * property as "may be missing" and provide their own fallbacks.
 *
 * Lives in `{dataDir}/sessions/{id}.import-source.json`, NOT inside the
 * Chronicle store directory. Written once by the importer, never updated.
 */
export interface ImportSource {
  conversationUuid?: string;
  name?: string;
  summary?: string | null;
  /** Original `conv.created_at` from the export. */
  createdAt?: string;
  /** Original `conv.updated_at` from the export. */
  updatedAt?: string;
  /**
   * Participant name assigned to assistant turns at import time. Warmup and
   * conhost both read this so they don't disagree about the agent's identity
   * — disagreement leaves strategy state in the wrong Chronicle namespace
   * and the live agent silently amnesiac.
   */
  agentName?: string;
  originalMessageCount?: number;
  importedMessageCount?: number;
  branched?: boolean;
  importedAt?: string;
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export class SessionManager {
  private readonly dataDir: string;
  private readonly indexPath: string;
  private readonly sessionsDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.indexPath = join(dataDir, 'sessions.json');
    this.sessionsDir = join(dataDir, 'sessions');
  }

  /** Load the session index from disk. Returns empty index if file doesn't exist. */
  load(): SessionIndex {
    if (!existsSync(this.indexPath)) {
      return { version: 1, activeSessionId: '', sessions: {} };
    }
    const raw = readFileSync(this.indexPath, 'utf-8');
    return JSON.parse(raw) as SessionIndex;
  }

  /** Persist the session index to disk. */
  save(index: SessionIndex): void {
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(this.indexPath, JSON.stringify(index, null, 2) + '\n');
  }

  /** Generate a short random hex ID. */
  private generateId(): string {
    return randomBytes(4).toString('hex'); // 8 hex chars
  }

  /** Create a new session and persist the index. Returns the new session metadata. */
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

    // Ensure the sessions parent directory exists.
    // Don't create the store directory itself — JsStore.openOrCreate needs it
    // absent to know it should create (not open) the store.
    mkdirSync(this.sessionsDir, { recursive: true });

    index.sessions[id] = session;
    index.activeSessionId = id;
    this.save(index);

    return session;
  }

  /** Delete a session (removes store directory and index entry). Cannot delete the active session. */
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

  /** Rename a session and mark it as manually named. */
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

  /** Get the Chronicle store directory path for a session. */
  getStorePath(id: string): string {
    return join(this.sessionsDir, id);
  }

  /**
   * Read the import-source sidecar for a session, if one exists.
   *
   * Returns null when the session wasn't created by the importer (no sidecar),
   * when the file can't be read, or when its contents don't parse as JSON.
   * The caller gets a partial record — every field is optional, because
   * sidecars written by older importer versions may be missing newer fields.
   */
  getImportSource(id: string): ImportSource | null {
    const path = join(this.sessionsDir, `${id}.import-source.json`);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as ImportSource;
    } catch {
      return null;
    }
  }

  /** Get the currently active session, or null if none. */
  getActiveSession(): SessionMeta | null {
    const index = this.load();
    if (!index.activeSessionId) return null;
    return index.sessions[index.activeSessionId] ?? null;
  }

  /** Set the active session and update its lastAccessedAt. */
  setActiveSession(id: string): void {
    const index = this.load();
    if (!index.sessions[id]) {
      throw new Error(`Session "${id}" not found`);
    }
    index.activeSessionId = id;
    index.sessions[id]!.lastAccessedAt = new Date().toISOString();
    this.save(index);
  }

  /** Find a session by name or ID. */
  findSession(nameOrId: string): SessionMeta | null {
    const index = this.load();
    // Exact ID match
    if (index.sessions[nameOrId]) return index.sessions[nameOrId]!;
    // Name match (case-insensitive)
    for (const session of Object.values(index.sessions)) {
      if (session.name.toLowerCase() === nameOrId.toLowerCase()) return session;
    }
    // Prefix match on ID
    for (const session of Object.values(index.sessions)) {
      if (session.id.startsWith(nameOrId)) return session;
    }
    return null;
  }

  /** List all sessions, sorted by lastAccessedAt descending. */
  listSessions(): SessionMeta[] {
    const index = this.load();
    return Object.values(index.sessions)
      .sort((a, b) => b.lastAccessedAt.localeCompare(a.lastAccessedAt));
  }

  /**
   * Migrate legacy single-store layout to session-based layout.
   *
   * If `{dataDir}/store/` exists but `{dataDir}/sessions.json` doesn't,
   * moves the store into `{dataDir}/sessions/{id}/` and creates the index.
   */
  migrateIfNeeded(): void {
    if (existsSync(this.indexPath)) return;

    const legacyStorePath = join(this.dataDir, 'store');
    if (!existsSync(legacyStorePath)) return;

    const id = this.generateId();
    const now = new Date().toISOString();

    // Move legacy store into sessions directory
    mkdirSync(this.sessionsDir, { recursive: true });
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

  /** Update the message count snapshot for a session. */
  updateMessageCount(id: string, count: number): void {
    const index = this.load();
    const session = index.sessions[id];
    if (session) {
      session.messageCount = count;
      this.save(index);
    }
  }
}
