import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Database } from '../src/core/database';

export async function ensureFileDownloadPrice(db: Pick<Database, 'columns' | 'execute'>): Promise<void> {
  const hasPrice = (await db.columns('file')).some(column => column.name === 'price');
  const statements = (await readFile(resolve(__dirname, '../database/004-file-download-price.sql'), 'utf8')).replace(/^\s*--.*$/gm, '').split(';').map(sql => sql.trim()).filter(Boolean);
  for (const sql of statements) {
    if (hasPrice && sql.startsWith('ALTER TABLE `file`')) continue;
    await db.execute(sql);
  }
}
