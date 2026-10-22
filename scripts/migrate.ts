import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { Database } from '../src/core/database';
import { resolve } from 'node:path';

async function statements(path: string): Promise<string[]> {
  return (await readFile(resolve(process.cwd(), path), 'utf8')).replace(/^\s*--.*$/gm, '').split(';').map(sql => sql.trim()).filter(Boolean);
}
async function main(): Promise<void> {
  const db = new Database();
  try {
    const tables = await db.query('SHOW TABLES');
    if (process.argv.includes('--bootstrap')) {
      if (tables.length) throw new Error('--bootstrap requires an empty target database; use migrate without this flag for an existing Yii database.');
      for (const sql of await statements('database/legacy-schema.sql')) await db.execute(sql);
    } else if (!tables.length) throw new Error('Target database is empty. Use npm run migrate -- --bootstrap to initialize it.');
    for (const sql of await statements('database/node-state.sql')) await db.execute(sql);
    const legacy = await statements('database/legacy-schema.sql');
    const scan = legacy.find(sql => sql.startsWith('CREATE TABLE IF NOT EXISTS `admin_scan_login_ticket`'))!;
    await db.execute(scan);
    const columns = await db.columns('device');
    if (!columns.some(col => col.name === 'version')) await db.execute('ALTER TABLE device ADD COLUMN version int NOT NULL DEFAULT 0');
    if (!columns.some(col => col.name === 'shop_id')) for (const sql of await statements('database/002-v1-compatibility.sql')) await db.execute(sql);
    console.log('Backend schema is ready. Existing business rows were preserved.');
  } finally { await db.close(); }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'Migration failed'); process.exitCode = 1; });
