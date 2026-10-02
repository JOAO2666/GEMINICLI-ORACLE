import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';

export interface ConversationRow {
  id: string;
  created_at: string;
  updated_at: string;
  model: string;
  gemini_session_id: string | null;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

export interface AttachmentRow {
  id: string;
  conversation_id: string;
  message_id: string | null;
  original_name: string;
  stored_path: string;
  mime_type: string;
  size: number;
  created_at: string;
}

export interface ArtifactRecord {
  id: string;
  workspace_id: string;
  name: string;
  stored_path: string;
  mime_type: string;
  size: number;
  sha256: string;
  created_at: string;
  expires_at: string;
}

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface JobRecord {
  id: string;
  type: string;
  workspace_id: string | null;
  status: JobStatus;
  progress?: number;
  result?: string;
  error?: string;
  created_at: string;
  started_at?: string;
  updated_at: string;
  finished_at?: string;
}

export class AppDatabase {
  private readonly db: Database.Database;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new Database(path.join(dataDir, 'numia.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate() {
    const currentVersion = Number(this.db.pragma('user_version', { simple: true }) || 0);

    if (currentVersion < 1) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            model TEXT NOT NULL,
            gemini_session_id TEXT
          );
          CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK(role IN ('user','assistant')),
            content TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
          CREATE TABLE IF NOT EXISTS attachments (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
            original_name TEXT NOT NULL,
            stored_path TEXT NOT NULL UNIQUE,
            mime_type TEXT NOT NULL,
            size INTEGER NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_attachments_conversation ON attachments(conversation_id, created_at);
          CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            provider TEXT NOT NULL,
            provider_session_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
        `);
        this.db.pragma('user_version = 1');
      })();
    }

    if (currentVersion < 2) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS artifacts (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            name TEXT NOT NULL,
            stored_path TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            size INTEGER NOT NULL,
            sha256 TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_artifacts_workspace ON artifacts(workspace_id, created_at);
        `);
        this.db.pragma('user_version = 2');
      })();
    }

    if (currentVersion < 3) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            workspace_id TEXT,
            status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled','interrupted')),
            progress REAL DEFAULT 0,
            result TEXT,
            error TEXT,
            created_at TEXT NOT NULL,
            started_at TEXT,
            updated_at TEXT NOT NULL,
            finished_at TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_jobs_workspace ON jobs(workspace_id, status);
          CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);
        `);
        this.db.pragma('user_version = 3');
      })();
    }

    if (currentVersion < 4) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS approvals (
            id TEXT PRIMARY KEY,
            conversationId TEXT,
            action TEXT NOT NULL,
            details TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            context_data TEXT,
            result TEXT,
            updated_at DATETIME
          );
          CREATE INDEX IF NOT EXISTS idx_approvals_conversation ON approvals(conversationId);
          CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
        `);
        this.db.pragma('user_version = 4');
      })();
    }

    // Mark previously running jobs as interrupted upon server startup
    const now = new Date().toISOString();
    this.db.prepare("UPDATE jobs SET status = 'interrupted', updated_at = ?, finished_at = ? WHERE status = 'running'")
      .run(now, now);
  }

  createConversation(model: string): ConversationRow {
    const now = new Date().toISOString();
    const row: ConversationRow = { id: randomUUID(), created_at: now, updated_at: now, model, gemini_session_id: null };
    this.db.prepare(`INSERT INTO conversations (id,created_at,updated_at,model,gemini_session_id)
      VALUES (@id,@created_at,@updated_at,@model,@gemini_session_id)`).run(row);
    return row;
  }

  ensureConversation(id: string, model: string): ConversationRow {
    const existing = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined;
    if (existing) return existing;
    const now = new Date().toISOString();
    const row: ConversationRow = { id, created_at: now, updated_at: now, model, gemini_session_id: null };
    this.db.prepare(`INSERT INTO conversations (id,created_at,updated_at,model,gemini_session_id)
      VALUES (@id,@created_at,@updated_at,@model,@gemini_session_id)`).run(row);
    return row;
  }

  listConversations(): ConversationRow[] {
    return this.db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC').all() as ConversationRow[];
  }

  getConversation(id: string): ConversationRow {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined;
    if (!row) throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'Conversa não encontrada.');
    return row;
  }

  getConversationDetail(id: string) {
    const conversation = this.getConversation(id);
    return {
      ...conversation,
      messages: this.listMessages(id),
      attachments: this.listAttachments(id).map(({ stored_path: _path, ...safe }) => safe)
    };
  }

  deleteConversation(id: string): void {
    this.getConversation(id);
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  }

  updateConversation(id: string, changes: { model?: string; sessionId?: string }): void {
    const current = this.getConversation(id);
    this.db.prepare(`UPDATE conversations SET updated_at=?, model=?, gemini_session_id=? WHERE id=?`).run(
      new Date().toISOString(), changes.model ?? current.model, changes.sessionId ?? current.gemini_session_id, id
    );
  }

  addMessage(conversationId: string, role: 'user' | 'assistant', content: string): MessageRow {
    this.getConversation(conversationId);
    const row: MessageRow = { id: randomUUID(), conversation_id: conversationId, role, content, created_at: new Date().toISOString() };
    this.db.prepare('INSERT INTO messages VALUES (@id,@conversation_id,@role,@content,@created_at)').run(row);
    this.db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(row.created_at, conversationId);
    return row;
  }

  listMessages(conversationId: string): MessageRow[] {
    return this.db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at,id').all(conversationId) as MessageRow[];
  }

  addAttachment(row: Omit<AttachmentRow, 'id' | 'created_at' | 'message_id'>): AttachmentRow {
    this.getConversation(row.conversation_id);
    const full: AttachmentRow = { ...row, id: randomUUID(), message_id: null, created_at: new Date().toISOString() };
    this.db.prepare(`INSERT INTO attachments
      (id,conversation_id,message_id,original_name,stored_path,mime_type,size,created_at)
      VALUES (@id,@conversation_id,@message_id,@original_name,@stored_path,@mime_type,@size,@created_at)`).run(full);
    return full;
  }

  listAttachments(conversationId: string): AttachmentRow[] {
    return this.db.prepare('SELECT * FROM attachments WHERE conversation_id=? ORDER BY created_at,id').all(conversationId) as AttachmentRow[];
  }

  getAttachments(conversationId: string, ids: string[]): AttachmentRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT * FROM attachments WHERE conversation_id=? AND id IN (${placeholders})`).all(conversationId, ...ids) as AttachmentRow[];
    if (rows.length !== new Set(ids).size) throw new AppError(400, 'ATTACHMENT_INVALID', 'Um ou mais anexos não pertencem à conversa.');
    return rows;
  }

  attachToMessage(ids: string[], messageId: string): void {
    if (ids.length === 0) return;
    const update = this.db.prepare('UPDATE attachments SET message_id=? WHERE id=? AND message_id IS NULL');
    this.db.transaction(() => ids.forEach((id) => update.run(messageId, id)))();
  }

  expiredAttachments(cutoff: string): AttachmentRow[] {
    return this.db.prepare('SELECT * FROM attachments WHERE created_at < ?').all(cutoff) as AttachmentRow[];
  }

  deleteAttachment(id: string): void {
    this.db.prepare('DELETE FROM attachments WHERE id=?').run(id);
  }

  // Artifact methods
  saveArtifact(record: ArtifactRecord): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO artifacts
        (id, workspace_id, name, stored_path, mime_type, size, sha256, created_at, expires_at)
      VALUES
        (@id, @workspace_id, @name, @stored_path, @mime_type, @size, @sha256, @created_at, @expires_at)
    `).run(record);
  }

  getArtifact(workspaceId: string, artifactId: string): ArtifactRecord | undefined {
    return this.db.prepare(
      'SELECT * FROM artifacts WHERE workspace_id = ? AND id = ?'
    ).get(workspaceId, artifactId) as ArtifactRecord | undefined;
  }

  listWorkspaceArtifacts(workspaceId: string): ArtifactRecord[] {
    return this.db.prepare(
      'SELECT * FROM artifacts WHERE workspace_id = ? ORDER BY created_at DESC'
    ).all(workspaceId) as ArtifactRecord[];
  }

  deleteArtifact(id: string): void {
    this.db.prepare('DELETE FROM artifacts WHERE id = ?').run(id);
  }

  listExpiredArtifacts(cutoffIso: string): ArtifactRecord[] {
    return this.db.prepare(
      'SELECT * FROM artifacts WHERE expires_at <= ? OR created_at <= ? ORDER BY created_at ASC'
    ).all(cutoffIso, cutoffIso) as ArtifactRecord[];
  }

  listAllArtifacts(): ArtifactRecord[] {
    return this.db.prepare(
      'SELECT * FROM artifacts ORDER BY created_at ASC'
    ).all() as ArtifactRecord[];
  }

  // Jobs methods
  createJob(type: string, workspaceId?: string | null): JobRecord {
    const now = new Date().toISOString();
    const row: JobRecord = {
      id: randomUUID(),
      type,
      workspace_id: workspaceId ?? null,
      status: 'queued',
      progress: 0,
      created_at: now,
      updated_at: now
    };
    this.db.prepare(`
      INSERT INTO jobs (id, type, workspace_id, status, progress, created_at, updated_at)
      VALUES (@id, @type, @workspace_id, @status, @progress, @created_at, @updated_at)
    `).run(row);
    return row;
  }

  updateJob(id: string, update: Partial<JobRecord>): void {
    const fields: string[] = ['updated_at = ?'];
    const values: unknown[] = [new Date().toISOString()];

    if (update.status !== undefined) {
      fields.push('status = ?');
      values.push(update.status);
      if (update.status === 'running' && !update.started_at) {
        fields.push('started_at = ?');
        values.push(new Date().toISOString());
      } else if (['completed', 'failed', 'cancelled', 'interrupted'].includes(update.status) && !update.finished_at) {
        fields.push('finished_at = ?');
        values.push(new Date().toISOString());
      }
    }
    if (update.progress !== undefined) {
      fields.push('progress = ?');
      values.push(update.progress);
    }
    if (update.result !== undefined) {
      fields.push('result = ?');
      values.push(update.result);
    }
    if (update.error !== undefined) {
      fields.push('error = ?');
      values.push(update.error);
    }
    values.push(id);

    this.db.prepare(`UPDATE jobs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  getJob(id: string): JobRecord | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRecord | undefined;
  }

  listJobs(workspaceId?: string, limit = 50): JobRecord[] {
    if (workspaceId) {
      return this.db.prepare(
        'SELECT * FROM jobs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?'
      ).all(workspaceId, limit) as JobRecord[];
    }
    return this.db.prepare(
      'SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?'
    ).all(limit) as JobRecord[];
  }

  getRawDb(): Database.Database { return this.db; }

  close(): void { this.db.close(); }
}
