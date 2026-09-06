import fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import type { AppDatabase } from '../database.js';
import { AppError } from '../errors.js';

export interface StorageStatus {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPercent: number;
  dataBytes: number;
  workspaceBytes: number;
  artifactBytes: number;
  uploadBytes: number;
  temporaryBytes: number;
  trashBytes: number;
  databaseBytes: number;
  status: 'healthy' | 'warning' | 'cleanup' | 'critical' | 'hard_stop';
  cleanupEnabled: boolean;
  lastCleanupAt: string | null;
  lastCleanupFreedBytes: number;
}

export interface CleanupResult {
  beforeUsedBytes: number;
  afterUsedBytes: number;
  freedBytes: number;
  deletedArtifacts: number;
  deletedUploads: number;
  deletedWorkspaces: number;
  deletedTemporaryFiles: number;
  durationMs: number;
}

export interface StorageGuardianOptions {
  statfsProvider?: () => Promise<{ total: number; free: number }>;
}

const FORBIDDEN_SUBSTRINGS = [
  'antigravity-auth',
  '.gemini',
  'skill-catalog',
  'node_modules',
  path.join('src'),
  path.join('dist'),
  'Caddyfile',
  '.env',
  'docker-compose.yml',
  'Dockerfile',
  'package.json'
];

async function measureDirectory(dirPath: string): Promise<number> {
  let total = 0;
  const walk = async (current: string) => {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const stat = await fs.stat(full).catch(() => null);
        if (stat) total += stat.size;
      }
    }
  };
  await walk(dirPath);
  return total;
}

export class StorageGuardian {
  private timer: NodeJS.Timeout | null = null;
  private readonly activeLeases = new Map<string, number>();
  private lastCleanupAt: string | null = null;
  private lastCleanupFreedBytes = 0;
  private isCleaning = false;
  private isStopped = false;

  constructor(
    private readonly config: Config,
    private readonly db: AppDatabase,
    private readonly options: StorageGuardianOptions = {}
  ) {}

  acquireLease(workspaceId: string): void {
    const current = this.activeLeases.get(workspaceId) ?? 0;
    this.activeLeases.set(workspaceId, current + 1);
  }

  releaseLease(workspaceId: string): void {
    const current = this.activeLeases.get(workspaceId) ?? 0;
    if (current <= 1) {
      this.activeLeases.delete(workspaceId);
    } else {
      this.activeLeases.set(workspaceId, current - 1);
    }
  }

  isLeased(workspaceId: string): boolean {
    return (this.activeLeases.get(workspaceId) ?? 0) > 0;
  }

  isSacredPath(targetPath: string): boolean {
    const normalized = path.resolve(targetPath);
    for (const forbidden of FORBIDDEN_SUBSTRINGS) {
      if (normalized.includes(forbidden)) return true;
    }
    const dbPath = path.resolve(this.config.dataDir, 'numia.db');
    if (normalized === dbPath || normalized.startsWith(dbPath)) return true;
    return false;
  }

  async getDiskSpace(): Promise<{ total: number; free: number }> {
    if (this.options.statfsProvider) {
      return this.options.statfsProvider();
    }
    try {
      const stats = await fs.statfs(this.config.dataDir);
      const total = Number(stats.blocks) * Number(stats.bsize);
      const free = Number(stats.bavail) * Number(stats.bsize);
      return { total: Math.max(total, 1), free: Math.max(free, 0) };
    } catch {
      return { total: 50 * 1024 * 1024 * 1024, free: 25 * 1024 * 1024 * 1024 };
    }
  }

  async getStorageStatus(): Promise<StorageStatus> {
    const disk = await this.getDiskSpace();
    const usedBytes = Math.max(0, disk.total - disk.free);
    const usedPercent = Math.min(100, Math.max(0, Number(((usedBytes / disk.total) * 100).toFixed(2))));

    const artifactsDir = path.join(this.config.dataDir, 'mcp-artifacts');
    const conversationsDir = path.join(this.config.dataDir, 'conversations');
    const openaiTempDir = path.join(this.config.dataDir, 'openai-temp');
    const trashDir = path.join(this.config.mcpWorkspacesDir, '.trash');
    const dbFile = path.join(this.config.dataDir, 'numia.db');

    const [
      dataBytes,
      workspaceBytes,
      artifactBytes,
      uploadBytes,
      temporaryBytes,
      trashBytes
    ] = await Promise.all([
      measureDirectory(this.config.dataDir),
      measureDirectory(this.config.mcpWorkspacesDir),
      measureDirectory(artifactsDir),
      measureDirectory(conversationsDir),
      measureDirectory(openaiTempDir),
      measureDirectory(trashDir)
    ]);

    let databaseBytes = 0;
    for (const ext of ['', '-wal', '-shm']) {
      try {
        if (existsSync(dbFile + ext)) databaseBytes += statSync(dbFile + ext).size;
      } catch {
        // ignore
      }
    }

    let status: StorageStatus['status'] = 'healthy';
    if (usedPercent >= this.config.STORAGE_HARD_STOP_PERCENT || disk.free < 500 * 1024 * 1024) {
      status = 'hard_stop';
    } else if (usedPercent >= this.config.STORAGE_CRITICAL_PERCENT) {
      status = 'critical';
    } else if (usedPercent >= this.config.STORAGE_AGGRESSIVE_PERCENT) {
      status = 'cleanup';
    } else if (usedPercent >= this.config.STORAGE_WARN_PERCENT) {
      status = 'warning';
    }

    return {
      totalBytes: disk.total,
      usedBytes,
      freeBytes: disk.free,
      usedPercent,
      dataBytes,
      workspaceBytes,
      artifactBytes,
      uploadBytes,
      temporaryBytes,
      trashBytes,
      databaseBytes,
      status,
      cleanupEnabled: this.config.STORAGE_GUARDIAN_ENABLED,
      lastCleanupAt: this.lastCleanupAt,
      lastCleanupFreedBytes: this.lastCleanupFreedBytes
    };
  }

  async checkWorkspaceSize(workspaceId: string): Promise<number> {
    const wsRoot = path.resolve(this.config.mcpWorkspacesDir, workspaceId);
    const bytes = await measureDirectory(wsRoot);
    if (bytes > this.config.MAX_WORKSPACE_BYTES) {
      throw new AppError(
        413,
        'WORKSPACE_STORAGE_LIMIT_EXCEEDED',
        `Workspace excedeu o limite máximo de armazenamento (${Math.round(this.config.MAX_WORKSPACE_BYTES / (1024 * 1024))} MB). Tamanho atual: ${Math.round(bytes / (1024 * 1024))} MB.`
      );
    }
    return bytes;
  }

  async ensureWritable(estimatedBytes = 10 * 1024 * 1024): Promise<void> {
    const current = await this.getStorageStatus();
    if (current.status === 'hard_stop' || (current.freeBytes - estimatedBytes) < this.config.STORAGE_MIN_FREE_BYTES) {
      await this.runCleanup({ aggressive: true });
      const updated = await this.getStorageStatus();
      if (updated.status === 'hard_stop' || (updated.freeBytes - estimatedBytes) < 500 * 1024 * 1024) {
        throw new AppError(
          507,
          'INSUFFICIENT_STORAGE',
          'Servidor com pouco espaço disponível. A limpeza automática foi executada, mas não conseguiu liberar espaço suficiente.'
        );
      }
    } else if (current.status === 'cleanup' || current.status === 'critical') {
      this.runCleanup({ aggressive: current.status === 'critical' }).catch(() => undefined);
    }
  }

  async runCleanup(options: { aggressive?: boolean } = {}): Promise<CleanupResult> {
    if (this.isCleaning || this.isStopped) {
      return {
        beforeUsedBytes: 0,
        afterUsedBytes: 0,
        freedBytes: 0,
        deletedArtifacts: 0,
        deletedUploads: 0,
        deletedWorkspaces: 0,
        deletedTemporaryFiles: 0,
        durationMs: 0
      };
    }

    this.isCleaning = true;
    const start = Date.now();
    const beforeStatus = await this.getStorageStatus();

    let deletedArtifacts = 0;
    let deletedUploads = 0;
    let deletedWorkspaces = 0;
    let deletedTemporaryFiles = 0;

    try {
      const now = Date.now();
      const cutoffUploads = new Date(now - this.config.FILE_RETENTION_HOURS * 3_600_000).toISOString();
      const cutoffArtifacts = new Date(now - this.config.ARTIFACT_RETENTION_HOURS * 3_600_000).toISOString();
      const cutoffWorkspaces = now - this.config.TEMP_WORKSPACE_RETENTION_HOURS * 3_600_000;
      const cutoffTrash = now - this.config.TRASH_RETENTION_HOURS * 3_600_000;

      // 1. Limpar diretórios temporários abandonados (openai-temp / tmp requests > 1 hora)
      const openaiTempDir = path.join(this.config.dataDir, 'openai-temp');
      const tempEntries = await fs.readdir(openaiTempDir, { withFileTypes: true }).catch(() => []);
      for (const entry of tempEntries) {
        if (entry.isDirectory()) {
          const entryPath = path.join(openaiTempDir, entry.name);
          if (this.isSacredPath(entryPath)) continue;
          const stat = await fs.stat(entryPath).catch(() => null);
          if (stat && (options.aggressive || (now - stat.mtimeMs) > 3_600_000)) {
            await fs.rm(entryPath, { recursive: true, force: true }).catch(() => undefined);
            deletedTemporaryFiles += 1;
          }
        }
      }

      // 2. Limpar uploads e anexos expirados (>24h)
      try {
        const expiredAttachments = this.db.expiredAttachments(cutoffUploads);
        for (const attachment of expiredAttachments) {
          if (this.isSacredPath(attachment.stored_path)) continue;
          await fs.rm(attachment.stored_path, { force: true }).catch(() => undefined);
          this.db.deleteAttachment(attachment.id);
          deletedUploads += 1;
        }
      } catch {
        // database might be closed during shutdown
      }

      // 3. Limpar artefatos expirados (>24h fisicamente do disco e da tabela artifacts)
      try {
        const expiredArtifacts = this.db.listExpiredArtifacts(cutoffArtifacts);
        for (const artifact of expiredArtifacts) {
          if (this.isSacredPath(artifact.stored_path)) continue;
          await fs.rm(artifact.stored_path, { force: true }).catch(() => undefined);
          const parentDir = path.dirname(artifact.stored_path);
          await fs.rm(parentDir, { recursive: true, force: true }).catch(() => undefined);
          this.db.deleteArtifact(artifact.id);
          deletedArtifacts += 1;
        }
      } catch {
        // database might be closed during shutdown
      }

      // Limpar também artefatos órfãos no filesystem em data/mcp-artifacts
      const artifactsRoot = path.join(this.config.dataDir, 'mcp-artifacts');
      const wsArtifactDirs = await fs.readdir(artifactsRoot, { withFileTypes: true }).catch(() => []);
      for (const wsDir of wsArtifactDirs) {
        if (!wsDir.isDirectory()) continue;
        const wsPath = path.join(artifactsRoot, wsDir.name);
        if (this.isSacredPath(wsPath)) continue;
        const artDirs = await fs.readdir(wsPath, { withFileTypes: true }).catch(() => []);
        for (const artDir of artDirs) {
          const artPath = path.join(wsPath, artDir.name);
          const stat = await fs.stat(artPath).catch(() => null);
          if (stat && (now - stat.birthtimeMs) > this.config.ARTIFACT_RETENTION_HOURS * 3_600_000) {
            await fs.rm(artPath, { recursive: true, force: true }).catch(() => undefined);
            deletedArtifacts += 1;
          }
        }
      }

      // 4. Limpar workspaces temporários com mais de 24h e sem lease ativo
      const wsEntries = await fs.readdir(this.config.mcpWorkspacesDir, { withFileTypes: true }).catch(() => []);
      for (const entry of wsEntries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const wsId = entry.name;
        if (this.isLeased(wsId)) continue; // Ativo em execução, NUNCA apagar

        const wsRoot = path.join(this.config.mcpWorkspacesDir, wsId);
        if (this.isSacredPath(wsRoot)) continue;

        const metaFile = path.join(wsRoot, '.workspace.json');
        try {
          const raw = await fs.readFile(metaFile, 'utf8').catch(() => null);
          if (raw) {
            const meta = JSON.parse(raw);
            const isTemporary = Boolean(meta.temporary);
            const createdAtMs = new Date(meta.createdAt).getTime();

            if (isTemporary && (options.aggressive || createdAtMs <= cutoffWorkspaces)) {
              await fs.rm(wsRoot, { recursive: true, force: true }).catch(() => undefined);
              deletedWorkspaces += 1;
            }
          }
        } catch {
          // ignore parsing error
        }
      }

      // 5. Limpar pasta .trash com mais de 24h
      const trashRoot = path.join(this.config.mcpWorkspacesDir, '.trash');
      const trashEntries = await fs.readdir(trashRoot, { withFileTypes: true }).catch(() => []);
      for (const entry of trashEntries) {
        const itemPath = path.join(trashRoot, entry.name);
        if (this.isSacredPath(itemPath)) continue;
        const stat = await fs.stat(itemPath).catch(() => null);
        if (stat && (options.aggressive || stat.mtimeMs <= cutoffTrash)) {
          await fs.rm(itemPath, { recursive: true, force: true }).catch(() => undefined);
          deletedTemporaryFiles += 1;
        }
      }

      // 6. Aplicar limite total de artefatos (MAX_TOTAL_ARTIFACT_BYTES)
      await this.enforceMaxArtifactsLimit();
    } finally {
      this.isCleaning = false;
    }

    const afterStatus = await this.getStorageStatus();
    const freedBytes = Math.max(0, beforeStatus.usedBytes - afterStatus.usedBytes);
    this.lastCleanupAt = new Date().toISOString();
    this.lastCleanupFreedBytes = freedBytes;

    return {
      beforeUsedBytes: beforeStatus.usedBytes,
      afterUsedBytes: afterStatus.usedBytes,
      freedBytes,
      deletedArtifacts,
      deletedUploads,
      deletedWorkspaces,
      deletedTemporaryFiles,
      durationMs: Date.now() - start
    };
  }

  private async enforceMaxArtifactsLimit(): Promise<number> {
    const artifactsDir = path.join(this.config.dataDir, 'mcp-artifacts');
    let total = await measureDirectory(artifactsDir);
    if (total <= this.config.MAX_TOTAL_ARTIFACT_BYTES) return 0;

    const targetWatermark = this.config.MAX_TOTAL_ARTIFACT_BYTES * 0.8;
    let all: ReturnType<AppDatabase['listAllArtifacts']> = [];
    try {
      all = this.db.listAllArtifacts();
    } catch {
      return 0;
    }
    let removed = 0;

    for (const art of all) {
      if (total <= targetWatermark) break;
      if (this.isSacredPath(art.stored_path)) continue;

      const stat = await fs.stat(art.stored_path).catch(() => null);
      await fs.rm(art.stored_path, { force: true }).catch(() => undefined);
      await fs.rm(path.dirname(art.stored_path), { recursive: true, force: true }).catch(() => undefined);
      try {
        this.db.deleteArtifact(art.id);
      } catch {
        // ignore
      }
      if (stat) total -= stat.size;
      removed += 1;
    }

    return removed;
  }

  start(): void {
    if (!this.config.STORAGE_GUARDIAN_ENABLED || this.timer) return;
    this.isStopped = false;
    const intervalMs = Math.max(1, this.config.STORAGE_CHECK_INTERVAL_MINUTES) * 60_000;
    this.timer = setInterval(() => {
      this.getStorageStatus()
        .then((status) => {
          if (status.status !== 'healthy') {
            return this.runCleanup({ aggressive: status.status === 'critical' || status.status === 'hard_stop' });
          }
          return this.runCleanup({ aggressive: false });
        })
        .catch(() => undefined);
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    this.isStopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
