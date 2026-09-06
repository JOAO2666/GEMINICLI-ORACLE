import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/database.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe('AppDatabase', () => {
  it('persists conversations and messages', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'numia-test-'));
    dirs.push(dir);
    const db = new AppDatabase(dir);
    const conversation = db.createConversation('gemini-3.1-pro-high');
    db.addMessage(conversation.id, 'user', 'Olá');
    expect(db.getConversationDetail(conversation.id).messages).toHaveLength(1);
    db.close();
  });

  it('runs versioned migrations and supports artifacts and persistent jobs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'numia-migration-test-'));
    dirs.push(dir);
    const db = new AppDatabase(dir);

    // Test artifacts
    db.saveArtifact({
      id: 'art-1',
      workspace_id: 'ws-1',
      name: 'documento.pdf',
      stored_path: '/path/to/documento.pdf',
      mime_type: 'application/pdf',
      size: 1024,
      sha256: 'abc123sha',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 86400000).toISOString()
    });

    const art = db.getArtifact('ws-1', 'art-1');
    expect(art).toBeDefined();
    expect(art?.name).toBe('documento.pdf');
    expect(art?.mime_type).toBe('application/pdf');

    // Test jobs lifecycle
    const job = db.createJob('artifact_create', 'ws-1');
    expect(job.status).toBe('queued');

    db.updateJob(job.id, { status: 'running', progress: 0.5 });
    const running = db.getJob(job.id);
    expect(running?.status).toBe('running');
    expect(running?.progress).toBe(0.5);
    expect(running?.started_at).toBeDefined();

    db.close();

    // Reopen DB: previously running job should be marked 'interrupted'
    const db2 = new AppDatabase(dir);
    const restored = db2.getJob(job.id);
    expect(restored?.status).toBe('interrupted');
    db2.close();
  });
});
