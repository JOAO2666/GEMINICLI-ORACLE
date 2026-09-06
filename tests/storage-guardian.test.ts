import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/database.js';
import { StorageGuardian } from '../src/services/storage-guardian.js';
import { McpWorkspaceService } from '../src/mcp-workspaces.js';
import { buildApp } from '../src/app.js';
import type { AIProvider } from '../src/types.js';

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

const mockProvider: AIProvider = {
  supportsFiles: () => true,
  listModels: async () => ['gemini-3.7-flash-low'],
  checkAuthentication: async () => ({ available: true, authenticated: true }),
  sendMessage: async () => 'mock response',
  async *streamMessage() {
    yield { type: 'complete' as const, text: 'mock response', conversationId: 'test' };
  },
  cancel: () => false
};

describe('StorageGuardian: 24h Retention & Storage Cleanup', () => {
  it('identifies and protects sacred paths (antigravity-auth, .gemini, SQLite, .env, docker-compose)', () => {
    const dataDir = createTempDir('guardian-sacred-');
    const config = loadConfig({
      NODE_ENV: 'test',
      NUMIA_SERVER_TOKEN: 'x'.repeat(64),
      DATA_DIR: dataDir
    });
    const db = new AppDatabase(dataDir);
    const guardian = new StorageGuardian(config, db);

    expect(guardian.isSacredPath('/home/node/.gemini/antigravity-auth.json')).toBe(true);
    expect(guardian.isSacredPath('/home/node/.gemini/session.json')).toBe(true);
    expect(guardian.isSacredPath(path.join(dataDir, 'numia.db'))).toBe(true);
    expect(guardian.isSacredPath(path.join(dataDir, 'numia.db-wal'))).toBe(true);
    expect(guardian.isSacredPath(path.join(process.cwd(), '.env'))).toBe(true);
    expect(guardian.isSacredPath(path.join(process.cwd(), 'docker-compose.yml'))).toBe(true);
    expect(guardian.isSacredPath(path.join(process.cwd(), 'skill-catalog', 'SKILL.md'))).toBe(true);

    // Regular temporary paths must NOT be sacred
    expect(guardian.isSacredPath(path.join(dataDir, 'openai-temp', 'req-1'))).toBe(false);
    expect(guardian.isSacredPath(path.join(dataDir, 'mcp-artifacts', 'ws-1', 'doc.pdf'))).toBe(false);
  });

  it('purges uploads and attachments older than 24 hours', async () => {
    const dataDir = createTempDir('guardian-upload-');
    const config = loadConfig({
      NODE_ENV: 'test',
      NUMIA_SERVER_TOKEN: 'x'.repeat(64),
      DATA_DIR: dataDir,
      FILE_RETENTION_HOURS: '24'
    });
    const db = new AppDatabase(dataDir);
    const guardian = new StorageGuardian(config, db);

    // Create a conversation
    const conv = db.createConversation('gemini-3.7-flash-low');
    const uploadDir = path.join(dataDir, 'conversations', conv.id);
    fs.mkdirSync(uploadDir, { recursive: true });

    // File 1: Old attachment (>24 hours ago)
    const oldFile = path.join(uploadDir, 'old-doc.pdf');
    fs.writeFileSync(oldFile, 'old content');
    const oldAttachment = db.addAttachment({
      conversation_id: conv.id,
      original_name: 'old-doc.pdf',
      stored_path: oldFile,
      mime_type: 'application/pdf',
      size: 11
    });
    // Manually backdate created_at in SQLite to 25 hours ago
    const past25h = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    (db as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } })
      .db.prepare('UPDATE attachments SET created_at = ? WHERE id = ?').run(past25h, oldAttachment.id);

    // File 2: Recent attachment (<24 hours ago)
    const recentFile = path.join(uploadDir, 'recent-doc.pdf');
    fs.writeFileSync(recentFile, 'recent content');
    const recentAttachment = db.addAttachment({
      conversation_id: conv.id,
      original_name: 'recent-doc.pdf',
      stored_path: recentFile,
      mime_type: 'application/pdf',
      size: 14
    });

    expect(fs.existsSync(oldFile)).toBe(true);
    expect(fs.existsSync(recentFile)).toBe(true);

    const cleanup = await guardian.runCleanup();
    expect(cleanup.deletedUploads).toBe(1);

    // Old file physically deleted from disk and database
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(recentFile)).toBe(true);
    const remaining = db.listAttachments(conv.id);
    expect(remaining.map((a) => a.id)).toEqual([recentAttachment.id]);
  });

  it('physically deletes artifacts older than 24 hours and invalidates metadata', async () => {
    const dataDir = createTempDir('guardian-art-');
    const config = loadConfig({
      NODE_ENV: 'test',
      NUMIA_SERVER_TOKEN: 'x'.repeat(64),
      DATA_DIR: dataDir,
      ARTIFACT_RETENTION_HOURS: '24'
    });
    const db = new AppDatabase(dataDir);
    const guardian = new StorageGuardian(config, db);

    const wsId = '11111111-1111-4111-8111-111111111111';
    const artId = '22222222-2222-4222-8222-222222222222';
    const artDir = path.join(dataDir, 'mcp-artifacts', wsId, artId);
    fs.mkdirSync(artDir, { recursive: true });
    const artFile = path.join(artDir, 'report.pdf');
    fs.writeFileSync(artFile, '%PDF-1.4 test');

    const past26h = new Date(Date.now() - 26 * 3600 * 1000).toISOString();
    const past2h = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    db.saveArtifact({
      id: artId,
      workspace_id: wsId,
      name: 'report.pdf',
      stored_path: artFile,
      mime_type: 'application/pdf',
      size: 13,
      sha256: 'abc',
      created_at: past26h,
      expires_at: past2h
    });

    expect(fs.existsSync(artFile)).toBe(true);
    expect(db.getArtifact(wsId, artId)).toBeDefined();

    const cleanup = await guardian.runCleanup();
    expect(cleanup.deletedArtifacts).toBeGreaterThanOrEqual(1);

    // Physically deleted and metadata purged
    expect(fs.existsSync(artFile)).toBe(false);
    expect(fs.existsSync(artDir)).toBe(false);
    expect(db.getArtifact(wsId, artId)).toBeUndefined();
  });

  it('removes temporary workspaces older than 24h, but never removes active/leased or persistent workspaces', async () => {
    const dataDir = createTempDir('guardian-ws-');
    const wsDir = path.join(dataDir, 'workspaces');
    fs.mkdirSync(wsDir, { recursive: true });

    const config = loadConfig({
      NODE_ENV: 'test',
      NUMIA_SERVER_TOKEN: 'x'.repeat(64),
      DATA_DIR: dataDir,
      MCP_WORKSPACES_DIR: wsDir,
      TEMP_WORKSPACE_RETENTION_HOURS: '24'
    });
    const db = new AppDatabase(dataDir);
    const guardian = new StorageGuardian(config, db);

    const past26h = new Date(Date.now() - 26 * 3600 * 1000).toISOString();

    // 1. Temporary workspace, expired (>24h), no active lease -> MUST BE DELETED
    const expiredTempId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const expiredTempRoot = path.join(wsDir, expiredTempId);
    fs.mkdirSync(expiredTempRoot, { recursive: true });
    fs.writeFileSync(path.join(expiredTempRoot, '.workspace.json'), JSON.stringify({
      id: expiredTempId,
      name: 'Temp Expired',
      createdAt: past26h,
      temporary: true
    }));

    // 2. Persistent workspace, expired timestamp -> MUST NOT BE DELETED
    const persistentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const persistentRoot = path.join(wsDir, persistentId);
    fs.mkdirSync(persistentRoot, { recursive: true });
    fs.writeFileSync(path.join(persistentRoot, '.workspace.json'), JSON.stringify({
      id: persistentId,
      name: 'Persistent User Project',
      createdAt: past26h,
      temporary: false
    }));

    // 3. Temporary workspace, expired, but currently LEASED by active job -> MUST NOT BE DELETED
    const leasedId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const leasedRoot = path.join(wsDir, leasedId);
    fs.mkdirSync(leasedRoot, { recursive: true });
    fs.writeFileSync(path.join(leasedRoot, '.workspace.json'), JSON.stringify({
      id: leasedId,
      name: 'Active Leased Task',
      createdAt: past26h,
      temporary: true
    }));
    guardian.acquireLease(leasedId);

    const cleanup = await guardian.runCleanup();
    expect(cleanup.deletedWorkspaces).toBe(1);

    expect(fs.existsSync(expiredTempRoot)).toBe(false);
    expect(fs.existsSync(persistentRoot)).toBe(true);
    expect(fs.existsSync(leasedRoot)).toBe(true);

    guardian.releaseLease(leasedId);
  });

  it('removes old openai-temp directories (>1h) and .trash (>24h)', async () => {
    const dataDir = createTempDir('guardian-temp-');
    const wsDir = path.join(dataDir, 'workspaces');
    const openaiTemp = path.join(dataDir, 'openai-temp');
    const trashDir = path.join(wsDir, '.trash');
    fs.mkdirSync(openaiTemp, { recursive: true });
    fs.mkdirSync(trashDir, { recursive: true });

    const config = loadConfig({
      NODE_ENV: 'test',
      NUMIA_SERVER_TOKEN: 'x'.repeat(64),
      DATA_DIR: dataDir,
      MCP_WORKSPACES_DIR: wsDir,
      TRASH_RETENTION_HOURS: '24'
    });
    const db = new AppDatabase(dataDir);
    const guardian = new StorageGuardian(config, db);

    // Old openai-temp entry
    const oldTempReq = path.join(openaiTemp, 'req-abandoned');
    fs.mkdirSync(oldTempReq, { recursive: true });
    fs.writeFileSync(path.join(oldTempReq, 'temp.txt'), 'abandoned');
    // backdate mtime to 2 hours ago
    const past2h = new Date(Date.now() - 2 * 3600 * 1000);
    fs.utimesSync(oldTempReq, past2h, past2h);

    // Old trash entry
    const oldTrashItem = path.join(trashDir, 'deleted-ws-1');
    fs.mkdirSync(oldTrashItem, { recursive: true });
    fs.writeFileSync(path.join(oldTrashItem, 'data.bin'), 'garbage');
    const past25h = new Date(Date.now() - 25 * 3600 * 1000);
    fs.utimesSync(oldTrashItem, past25h, past25h);

    expect(fs.existsSync(oldTempReq)).toBe(true);
    expect(fs.existsSync(oldTrashItem)).toBe(true);

    const cleanup = await guardian.runCleanup();
    expect(cleanup.deletedTemporaryFiles).toBeGreaterThanOrEqual(2);

    expect(fs.existsSync(oldTempReq)).toBe(false);
    expect(fs.existsSync(oldTrashItem)).toBe(false);
  });

  it('enforces MAX_WORKSPACE_BYTES limit', async () => {
    const dataDir = createTempDir('guardian-limit-');
    const wsDir = path.join(dataDir, 'workspaces');
    fs.mkdirSync(wsDir, { recursive: true });

    const config = loadConfig({
      NODE_ENV: 'test',
      NUMIA_SERVER_TOKEN: 'x'.repeat(64),
      DATA_DIR: dataDir,
      MCP_WORKSPACES_DIR: wsDir,
      MAX_WORKSPACE_BYTES: '1000' // 1000 bytes max
    });
    const db = new AppDatabase(dataDir);
    const guardian = new StorageGuardian(config, db);

    const wsId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const wsRoot = path.join(wsDir, wsId);
    fs.mkdirSync(wsRoot, { recursive: true });
    fs.writeFileSync(path.join(wsRoot, 'large.bin'), Buffer.alloc(1500));

    try {
      await guardian.checkWorkspaceSize(wsId);
      expect.unreachable();
    } catch (err: unknown) {
      expect((err as { code?: string }).code).toBe('WORKSPACE_STORAGE_LIMIT_EXCEEDED');
      expect((err as { statusCode?: number }).statusCode).toBe(413);
    }
  });

  it('enforces MAX_TOTAL_ARTIFACT_BYTES by removing oldest artifacts when exceeding quota', async () => {
    const dataDir = createTempDir('guardian-art-quota-');
    const config = loadConfig({
      NODE_ENV: 'test',
      NUMIA_SERVER_TOKEN: 'x'.repeat(64),
      DATA_DIR: dataDir,
      MAX_TOTAL_ARTIFACT_BYTES: '2000' // 2000 bytes max
    });
    const db = new AppDatabase(dataDir);
    const guardian = new StorageGuardian(config, db);

    const wsId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const art1Dir = path.join(dataDir, 'mcp-artifacts', wsId, 'art-1');
    const art2Dir = path.join(dataDir, 'mcp-artifacts', wsId, 'art-2');
    fs.mkdirSync(art1Dir, { recursive: true });
    fs.mkdirSync(art2Dir, { recursive: true });

    const file1 = path.join(art1Dir, 'old.bin');
    const file2 = path.join(art2Dir, 'new.bin');
    fs.writeFileSync(file1, Buffer.alloc(1200));
    fs.writeFileSync(file2, Buffer.alloc(1200));

    const past2h = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    const past1h = new Date(Date.now() - 1 * 3600 * 1000).toISOString();
    const future = new Date(Date.now() + 20 * 3600 * 1000).toISOString();

    db.saveArtifact({
      id: 'art-1',
      workspace_id: wsId,
      name: 'old.bin',
      stored_path: file1,
      mime_type: 'application/octet-stream',
      size: 1200,
      sha256: '1',
      created_at: past2h,
      expires_at: future
    });
    db.saveArtifact({
      id: 'art-2',
      workspace_id: wsId,
      name: 'new.bin',
      stored_path: file2,
      mime_type: 'application/octet-stream',
      size: 1200,
      sha256: '2',
      created_at: past1h,
      expires_at: future
    });

    // Combined artifacts = 2400 bytes > 2000 bytes limit
    await guardian.runCleanup();

    // Oldest artifact (art-1) must be removed to bring total under watermark
    expect(fs.existsSync(file1)).toBe(false);
    expect(db.getArtifact(wsId, 'art-1')).toBeUndefined();
    expect(fs.existsSync(file2)).toBe(true);
    expect(db.getArtifact(wsId, 'art-2')).toBeDefined();
  });

  it('triggers aggressive cleanup on high pressure and hard stop at >= 98%', async () => {
    const dataDir = createTempDir('guardian-pressure-');
    const config = loadConfig({
      NODE_ENV: 'test',
      NUMIA_SERVER_TOKEN: 'x'.repeat(64),
      DATA_DIR: dataDir,
      STORAGE_WARN_PERCENT: '75',
      STORAGE_CLEANUP_PERCENT: '85',
      STORAGE_AGGRESSIVE_PERCENT: '90',
      STORAGE_CRITICAL_PERCENT: '95',
      STORAGE_HARD_STOP_PERCENT: '98'
    });
    const db = new AppDatabase(dataDir);

    // Mock statfsProvider to simulate 99% full disk
    let simulatedFree = 50 * 1024 * 1024; // 50MB free
    const simulatedTotal = 100 * 1024 * 1024 * 1024; // 100GB total
    const guardian = new StorageGuardian(config, db, {
      statfsProvider: async () => ({
        total: simulatedTotal,
        free: simulatedFree
      })
    });

    const status = await guardian.getStorageStatus();
    expect(status.status).toBe('hard_stop');
    expect(status.usedPercent).toBeGreaterThan(98);

    // At hard stop, ensureWritable must reject with INSUFFICIENT_STORAGE
    try {
      await guardian.ensureWritable(10 * 1024 * 1024);
      expect.unreachable();
    } catch (err: unknown) {
      expect((err as { code?: string }).code).toBe('INSUFFICIENT_STORAGE');
      expect((err as { statusCode?: number }).statusCode).toBe(507);
    }
  });

  it('maintains /health/ready operational in degraded state during hard-stop', async () => {
    const dataDir = createTempDir('guardian-health-');
    const token = 'y'.repeat(64);
    const config = loadConfig({
      NODE_ENV: 'test',
      NUMIA_SERVER_TOKEN: token,
      DATA_DIR: dataDir,
      PUBLIC_BASE_URL: 'https://example.test',
      MCP_ENABLED: 'true',
      MCP_WORKSPACES_DIR: path.join(dataDir, 'workspaces'),
      MCP_WORKER_TOKEN: 'z'.repeat(64),
      ALLOWED_MODELS: 'gemini-3.7-flash-low',
      DEFAULT_MODEL: 'gemini-3.7-flash-low'
    });

    // Provide mocked storage guardian in hard stop
    const db = new AppDatabase(dataDir);
    const hardStopGuardian = new StorageGuardian(config, db, {
      statfsProvider: async () => ({
        total: 100 * 1024 * 1024 * 1024,
        free: 100 * 1024 * 1024 // 100MB free (~99.9% used)
      })
    });

    const app = await buildApp(config, {
      provider: mockProvider,
      storageGuardian: hardStopGuardian
    });

    try {
      const ready = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(ready.statusCode).toBe(200);
      const json = ready.json();
      expect(json.status).toBe('degraded');
      expect(json.reason).toBe('insufficient_storage');
      expect(json.storage.status).toBe('hard_stop');
      expect(json.storage.usedPercent).toBeGreaterThan(98);
    } finally {
      await app.close();
    }
  });

  it('storage_status and storage_cleanup MCP tools return structured metrics', async () => {
    const dataDir = createTempDir('guardian-mcp-');
    const wsDir = path.join(dataDir, 'workspaces');
    fs.mkdirSync(wsDir, { recursive: true });

    const config = loadConfig({
      NODE_ENV: 'test',
      NUMIA_SERVER_TOKEN: 'x'.repeat(64),
      DATA_DIR: dataDir,
      MCP_WORKSPACES_DIR: wsDir
    });
    const db = new AppDatabase(dataDir);
    const guardian = new StorageGuardian(config, db);
    const workspaces = new McpWorkspaceService(config, mockProvider, db, guardian);
    await workspaces.initialize();

    const status = await workspaces.storageStatus();
    expect(status).toBeDefined();
    expect(status).toHaveProperty('totalBytes');
    expect(status).toHaveProperty('usedBytes');
    expect(status).toHaveProperty('freeBytes');
    expect(status).toHaveProperty('usedPercent');
    expect(status).toHaveProperty('workspaceBytes');
    expect(status).toHaveProperty('artifactBytes');
    expect(status).toHaveProperty('cleanupEnabled');

    const cleanupResult = await workspaces.storageCleanup(false);
    expect(cleanupResult).toBeDefined();
    expect(cleanupResult).toHaveProperty('beforeUsedBytes');
    expect(cleanupResult).toHaveProperty('afterUsedBytes');
    expect(cleanupResult).toHaveProperty('freedBytes');
    expect(cleanupResult).toHaveProperty('deletedArtifacts');
    expect(cleanupResult).toHaveProperty('deletedUploads');
    expect(cleanupResult).toHaveProperty('deletedWorkspaces');
    expect(cleanupResult).toHaveProperty('durationMs');
  });

  it('artifact expiration does not renew 24h when retrieved, and throws 410 when expired', async () => {
    const dataDir = createTempDir('guardian-art-get-');
    const config = loadConfig({
      NODE_ENV: 'test',
      NUMIA_SERVER_TOKEN: 'x'.repeat(64),
      DATA_DIR: dataDir,
      PUBLIC_BASE_URL: 'https://example.test',
      ARTIFACT_RETENTION_HOURS: '24'
    });
    const db = new AppDatabase(dataDir);
    const guardian = new StorageGuardian(config, db);
    const workspaces = new McpWorkspaceService(config, mockProvider, db, guardian);
    await workspaces.initialize();

    const ws = await workspaces.create('Test WS', { temporary: true });
    const wsId = String(ws.id);
    const artId = '33333333-3333-4333-8333-333333333333';
    const artDir = path.join(dataDir, 'mcp-artifacts', wsId, artId);
    fs.mkdirSync(artDir, { recursive: true });
    const artFile = path.join(artDir, 'summary.txt');
    fs.writeFileSync(artFile, 'Sample content');

    // Case 1: Active artifact (created 10h ago) -> remaining TTL must be ~14h, NOT reset to 24h
    const past10h = new Date(Date.now() - 10 * 3600 * 1000).toISOString();
    const originalExpires = new Date(Date.now() + 14 * 3600 * 1000).toISOString();
    db.saveArtifact({
      id: artId,
      workspace_id: wsId,
      name: 'summary.txt',
      stored_path: artFile,
      mime_type: 'text/plain',
      size: 14,
      sha256: 'xyz',
      created_at: past10h,
      expires_at: originalExpires
    });

    const activeInfo = await workspaces.artifactGet(wsId, artId);
    expect(activeInfo.expiresAt).toBe(originalExpires);

    // Case 2: Expired artifact (created 25h ago) -> must throw 410 ARTIFACT_EXPIRED
    const past25h = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    const expiredDeadline = new Date(Date.now() - 1 * 3600 * 1000).toISOString();
    db.saveArtifact({
      id: artId,
      workspace_id: wsId,
      name: 'summary.txt',
      stored_path: artFile,
      mime_type: 'text/plain',
      size: 14,
      sha256: 'xyz',
      created_at: past25h,
      expires_at: expiredDeadline
    });

    try {
      await workspaces.artifactGet(wsId, artId);
      expect.unreachable();
    } catch (err: unknown) {
      expect((err as { code?: string }).code).toBe('ARTIFACT_EXPIRED');
      expect((err as { statusCode?: number }).statusCode).toBe(410);
    }
    expect(fs.existsSync(artFile)).toBe(false);
  });
});
