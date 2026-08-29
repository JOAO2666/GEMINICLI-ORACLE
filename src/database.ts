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
  }

  createConversation(model: string): ConversationRow {
    const now = new Date().toISOString();
    const row: ConversationRow = { id: randomUUID(), created_at: now, updated_at: now, model, gemini_session_id: null };
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

  close(): void { this.db.close(); }
}
