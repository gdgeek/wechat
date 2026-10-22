import { describe, expect, it } from 'vitest';
import type { Database } from '../src/core/database';
import { preserveRecordHistory } from '../scripts/record-preservation';

type Column = { columnType: string; isNullable: string };
type ForeignKey = { constraintName: string; columnName: string; tableSchema: string; referencedTableSchema: string; referencedTableName: string; referencedColumnName: string; deleteRule: string; updateRule: string };
const foreignKey = (values: Partial<ForeignKey> = {}): ForeignKey => ({ constraintName: 'fk-record-device_id', columnName: 'device_id', tableSchema: 'game', referencedTableSchema: 'game', referencedTableName: 'device', referencedColumnName: 'id', deleteRule: 'CASCADE', updateRule: 'RESTRICT', ...values });

function schemaDb(columns: Column[] = [{ columnType: 'int', isNullable: 'NO' }], keys: ForeignKey[] = [foreignKey()]) {
  const statements: string[] = [];
  const db = {
    async query(sql: string) { return sql.includes('information_schema.COLUMNS') ? columns : keys; },
    async execute(sql: string) {
      statements.push(sql);
      columns[0].isNullable = 'YES';
      for (const key of keys) if (key.columnName === 'device_id') key.deleteRule = 'SET NULL';
      return { affectedRows: 0, insertId: 0 };
    },
  } as unknown as Pick<Database, 'query' | 'execute'>;
  return { db, statements };
}

describe('record history schema migration', () => {
  it('changes the column and foreign key in one statement and is repeatable', async () => {
    const { db, statements } = schemaDb();
    await preserveRecordHistory(db);
    await preserveRecordHistory(db);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^ALTER TABLE `record`\s+DROP FOREIGN KEY `fk-record-device_id`,\s+MODIFY COLUMN `device_id` int NULL,\s+ADD CONSTRAINT `fk_record_device_history_7fccfb527aaf981932ad1471f302a4ae` FOREIGN KEY \(`device_id`\) REFERENCES `device` \(`id`\) ON DELETE SET NULL ON UPDATE RESTRICT$/);
  });

  it('leaves an already preserved schema unchanged', async () => {
    const { db, statements } = schemaDb([{ columnType: 'int', isNullable: 'YES' }], [foreignKey({ deleteRule: 'SET NULL' })]);
    await preserveRecordHistory(db);
    expect(statements).toEqual([]);
  });

  it('retains the integer type and update action while replacing a custom foreign key name', async () => {
    const { db, statements } = schemaDb([{ columnType: 'bigint unsigned', isNullable: 'NO' }], [foreignKey({ constraintName: 'custom`device_fk', updateRule: 'CASCADE' }), foreignKey({ constraintName: 'fk-player', columnName: 'player_id', referencedTableName: 'player' })]);
    await preserveRecordHistory(db);
    expect(statements[0]).toContain('DROP FOREIGN KEY `custom``device_fk`');
    expect(statements[0]).toContain('MODIFY COLUMN `device_id` bigint unsigned NULL');
    expect(statements[0]).toContain('ADD CONSTRAINT `fk_record_device_history_7fa1a6f5152763c0012aa3a74f6f9951`');
    expect(statements[0]).toMatch(/ON UPDATE CASCADE$/);
    expect(statements[0]).not.toContain('fk-player');
  });

  it('uses the same bounded replacement name as the current Yii migration', async () => {
    const { db, statements } = schemaDb(undefined, [foreignKey({ constraintName: 'fixture_record_device_cascade' })]);
    await preserveRecordHistory(db);
    const replacement = /ADD CONSTRAINT `([^`]+)`/.exec(statements[0])![1];
    expect(replacement).toBe('fk_record_device_history_d39de176dbbd998417d451a5fb6a37c7');
    expect(replacement.length).toBeLessThanOrEqual(64);
    expect(statements[0]).toContain('DROP FOREIGN KEY `fixture_record_device_cascade`');
  });

  it.each([
    ['missing column', [], [foreignKey()]],
    ['missing foreign key', [{ columnType: 'int', isNullable: 'NO' }], []],
    ['wrong referenced table', [{ columnType: 'int', isNullable: 'NO' }], [foreignKey({ referencedTableName: 'other_device' })]],
    ['wrong referenced column', [{ columnType: 'int', isNullable: 'NO' }], [foreignKey({ referencedColumnName: 'other_id' })]],
    ['external referenced schema', [{ columnType: 'int', isNullable: 'NO' }], [foreignKey({ referencedTableSchema: 'other_game' })]],
    ['ambiguous foreign keys', [{ columnType: 'int', isNullable: 'NO' }], [foreignKey(), foreignKey({ constraintName: 'other-fk' })]],
    ['composite foreign key', [{ columnType: 'int', isNullable: 'NO' }], [foreignKey(), foreignKey({ columnName: 'player_id' })]],
    ['unexpected column type', [{ columnType: 'varchar(255)', isNullable: 'NO' }], [foreignKey()]],
    ['unexpected update action', [{ columnType: 'int', isNullable: 'NO' }], [foreignKey({ updateRule: 'UNSUPPORTED' })]],
  ] satisfies [string, Column[], ForeignKey[]][])('rejects %s without changing the schema or business rows', async (_name, columns, keys) => {
    const { db, statements } = schemaDb(columns, keys);
    await expect(preserveRecordHistory(db)).rejects.toThrow(/record\.device_id/);
    expect(statements).toEqual([]);
  });
});
