import { describe, expect, it } from 'vitest';
import mysql from 'mysql2/promise';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const run = promisify(execFile);
describe.skipIf(process.env.RUN_INTEGRATION !== '1')('populated Yii schema migration', () => {
  it('preserves business rows, adds legacy-zero version and is repeatable', async () => {
    if (!['127.0.0.1', 'localhost'].includes(process.env.MYSQL_HOST || '') || process.env.MYSQL_DATABASE !== 'wechat_test') throw new Error('Migration tests require the dedicated localhost test database');
    const database = `wechat_migration_test_${randomBytes(12).toString('hex')}`;
    const connection = await mysql.createConnection({ host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD });
    let created = false;
    try {
      await connection.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`);
      created = true; // CREATE fails on collision: never reuse or delete an existing database.
      await connection.changeUser({ database });
      const schema = (await readFile(resolve('database/legacy-schema.sql'), 'utf8')).replace(/^\s*--.*$/gm, '').split(';').map(sql => sql.trim()).filter(Boolean);
      for (const statement of schema) await connection.query(statement);
      await connection.query('ALTER TABLE device DROP COLUMN version');
      await connection.query('ALTER TABLE file DROP COLUMN price');
      await connection.query('DROP TABLE file_payment_order');
      const [foreignKeys] = await connection.query<mysql.RowDataPacket[]>("SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=? AND TABLE_NAME='record' AND COLUMN_NAME='device_id' AND REFERENCED_TABLE_NAME='device'", [database]);
      for (const key of foreignKeys) {
        if (!/^[a-zA-Z0-9_-]+$/.test(key.CONSTRAINT_NAME)) throw new Error('Unexpected fixture foreign key name');
        await connection.query(`ALTER TABLE record DROP FOREIGN KEY \`${key.CONSTRAINT_NAME}\``);
      }
      await connection.query('ALTER TABLE record MODIFY device_id int NOT NULL');
      await connection.query('ALTER TABLE record ADD CONSTRAINT fixture_record_device_cascade FOREIGN KEY (device_id) REFERENCES device(id) ON DELETE CASCADE');
      await connection.query("INSERT INTO device (id,uuid,tag) VALUES (7,'existing-device','preserve')");
      await connection.query("INSERT INTO player (id,tel,recharge,cost,created_at,updated_at) VALUES (8,'migration-player',123.5,17,NOW(),NOW())");
      await connection.query("INSERT INTO record (id,player_id,device_id,status,game,created_at,updated_at) VALUES (9,8,7,'finish','{\"history\":true}','2026-01-01 01:02:03','2026-01-02 01:02:03')");
      await connection.query("INSERT INTO file (id,`key`,unionid,unlocked) VALUES (10,'historical-file','legacy-union',0)");
      const env = { ...process.env, MYSQL_DATABASE: database };
      const migrate = () => run(process.execPath, ['--import', 'tsx', 'scripts/migrate.ts'], { cwd: resolve('.'), env });
      await migrate();
      await connection.query('DROP TABLE file_payment_order');
      await migrate();
      const [orderTable] = await connection.query<mysql.RowDataPacket[]>("SHOW FULL COLUMNS FROM file_payment_order WHERE Field='out_trade_no'");
      expect(orderTable[0].Collation).toBe('ascii_bin');
      expect(orderTable[0].Key).toBe('PRI');
      const [devices] = await connection.query('SELECT id,uuid,tag,version,shop_id FROM device');
      expect(devices).toEqual([{ id: 7, uuid: 'existing-device', tag: 'preserve', version: 0, shop_id: null }]);
      const [players] = await connection.query('SELECT id,tel,recharge,cost FROM player');
      expect(players).toEqual([{ id: 8, tel: 'migration-player', recharge: 123.5, cost: 17 }]);
      const [files] = await connection.query('SELECT id,`key`,unionid,unlocked,price FROM file');
      expect(files).toEqual([{ id: 10, key: 'historical-file', unionid: 'legacy-union', unlocked: 0, price: null }]);
      const [beforeDelete] = await connection.query<mysql.RowDataPacket[]>('SELECT * FROM record WHERE id=9');
      expect(beforeDelete[0].device_id).toBe(7);
      await connection.query('DELETE FROM device WHERE id=7');
      const [history] = await connection.query('SELECT * FROM record WHERE id=9');
      expect(history).toEqual([{ ...beforeDelete[0], device_id: null }]);
      await expect(run(process.execPath, ['--import', 'tsx', 'scripts/migrate.ts', '--bootstrap'], { cwd: resolve('.'), env })).rejects.toMatchObject({ stderr: expect.stringContaining('--bootstrap requires an empty target database') });
    } finally {
      if (created) await connection.query(`DROP DATABASE ${database}`);
      await connection.end();
    }
  }, 20000);
});
