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
});
