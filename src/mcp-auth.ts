import crypto from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import { AppError } from './errors.js';

export interface OAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
}

interface AuthorizationCodeInput {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
}

const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const randomToken = (prefix: string) => `${prefix}${crypto.randomBytes(32).toString('base64url')}`;

export class McpAuthStore {
  private readonly db: Database.Database;

  constructor(dataDir: string) {
    this.db = new Database(path.join(dataDir, 'mcp-auth.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        client_name TEXT NOT NULL,
        redirect_uris TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_codes (
        code_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        resource TEXT NOT NULL,
        scope TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        FOREIGN KEY(client_id) REFERENCES oauth_clients(client_id)
      );
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        id TEXT PRIMARY KEY,
        access_hash TEXT UNIQUE NOT NULL,
        refresh_hash TEXT UNIQUE NOT NULL,
        client_id TEXT NOT NULL,
        resource TEXT NOT NULL,
        scope TEXT NOT NULL,
        access_expires_at INTEGER NOT NULL,
        refresh_expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        FOREIGN KEY(client_id) REFERENCES oauth_clients(client_id)
      );
      CREATE INDEX IF NOT EXISTS idx_oauth_access ON oauth_tokens(access_hash);
      CREATE INDEX IF NOT EXISTS idx_oauth_refresh ON oauth_tokens(refresh_hash);
    `);
  }

  close(): void { this.db.close(); }

  registerClient(clientName: string, redirectUris: string[]): OAuthClient {
    const clientId = randomToken('mcp_client_');
    this.db.prepare('INSERT INTO oauth_clients(client_id,client_name,redirect_uris,created_at) VALUES(?,?,?,?)')
      .run(clientId, clientName, JSON.stringify(redirectUris), Date.now());
    return { clientId, clientName, redirectUris };
  }

  getClient(clientId: string): OAuthClient | null {
    const row = this.db.prepare('SELECT client_id,client_name,redirect_uris FROM oauth_clients WHERE client_id=?')
      .get(clientId) as { client_id: string; client_name: string; redirect_uris: string } | undefined;
    if (!row) return null;
    return { clientId: row.client_id, clientName: row.client_name, redirectUris: JSON.parse(row.redirect_uris) as string[] };
  }

  createAuthorizationCode(input: AuthorizationCodeInput): string {
    const code = randomToken('mcp_code_');
    this.db.prepare(`INSERT INTO oauth_codes
      (code_hash,client_id,redirect_uri,code_challenge,resource,scope,expires_at)
      VALUES(?,?,?,?,?,?,?)`).run(
      digest(code), input.clientId, input.redirectUri, input.codeChallenge,
      input.resource, input.scope, Date.now() + 5 * 60_000
    );
    return code;
  }

  exchangeCode(code: string, clientId: string, redirectUri: string, verifier: string, resource: string) {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM oauth_codes WHERE code_hash=?').get(digest(code)) as Record<string, unknown> | undefined;
      if (!row || row.used_at || Number(row.expires_at) < Date.now()) throw new AppError(400, 'invalid_grant', 'Código inválido ou expirado.');
      if (row.client_id !== clientId || row.redirect_uri !== redirectUri || row.resource !== resource) {
        throw new AppError(400, 'invalid_grant', 'Código não pertence a esta solicitação.');
      }
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      if (challenge !== row.code_challenge) throw new AppError(400, 'invalid_grant', 'Verificador PKCE inválido.');
      this.db.prepare('UPDATE oauth_codes SET used_at=? WHERE code_hash=?').run(Date.now(), digest(code));
      return this.issueTokens(clientId, String(row.resource), String(row.scope));
    });
    return transaction();
  }

  refresh(refreshToken: string, clientId: string, resource: string) {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM oauth_tokens WHERE refresh_hash=?').get(digest(refreshToken)) as Record<string, unknown> | undefined;
      if (!row || row.revoked_at || Number(row.refresh_expires_at) < Date.now()) throw new AppError(400, 'invalid_grant', 'Refresh token inválido ou expirado.');
      if (row.client_id !== clientId || row.resource !== resource) throw new AppError(400, 'invalid_grant', 'Refresh token incompatível.');
      this.db.prepare('UPDATE oauth_tokens SET revoked_at=? WHERE id=?').run(Date.now(), row.id);
      return this.issueTokens(clientId, resource, String(row.scope));
    });
    return transaction();
  }

  private issueTokens(clientId: string, resource: string, scope: string) {
    const accessToken = randomToken('mcp_at_');
    const refreshToken = randomToken('mcp_rt_');
    const accessLifetimeSeconds = 24 * 60 * 60;
    this.db.prepare(`INSERT INTO oauth_tokens
      (id,access_hash,refresh_hash,client_id,resource,scope,access_expires_at,refresh_expires_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(
      crypto.randomUUID(), digest(accessToken), digest(refreshToken), clientId, resource, scope,
      Date.now() + accessLifetimeSeconds * 1000, Date.now() + 90 * 24 * 60 * 60_000
    );
    return { access_token: accessToken, token_type: 'Bearer', expires_in: accessLifetimeSeconds, refresh_token: refreshToken, scope };
  }

  validateAccessToken(token: string, resource: string): { clientId: string; scope: string } | null {
    const row = this.db.prepare(`SELECT client_id,scope,resource,access_expires_at,revoked_at
      FROM oauth_tokens WHERE access_hash=?`).get(digest(token)) as Record<string, unknown> | undefined;
    if (!row || row.revoked_at || Number(row.access_expires_at) < Date.now() || row.resource !== resource) return null;
    return { clientId: String(row.client_id), scope: String(row.scope) };
  }
}
