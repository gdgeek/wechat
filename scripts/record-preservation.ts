import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { Database } from '../src/core/database';

interface Column { columnType: string; isNullable: string; }
interface ForeignKey {
  constraintName: string;
  columnName: string;
  tableSchema: string;
  referencedTableSchema: string;
  referencedTableName: string;
  referencedColumnName: string;
  deleteRule: string;
  updateRule: string;
}

/** Preserve historical rows when either backend removes a device. */
export async function preserveRecordHistory(db: Pick<Database, 'query' | 'execute'>): Promise<void> {
  const [columns, keys] = await Promise.all([
    db.query<Column>("SELECT COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'record' AND COLUMN_NAME = 'device_id'"),
    db.query<ForeignKey>("SELECT k.CONSTRAINT_NAME AS constraintName, k.COLUMN_NAME AS columnName, k.TABLE_SCHEMA AS tableSchema, k.REFERENCED_TABLE_SCHEMA AS referencedTableSchema, k.REFERENCED_TABLE_NAME AS referencedTableName, k.REFERENCED_COLUMN_NAME AS referencedColumnName, r.DELETE_RULE AS deleteRule, r.UPDATE_RULE AS updateRule FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.TABLE_NAME = k.TABLE_NAME AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME = 'record' ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION"),
  ]);
  if (columns.length !== 1) throw new Error('The record.device_id column is required.');
  const deviceKeys = keys.filter(key => key.columnName === 'device_id');
  const key = deviceKeys[0];
  if (deviceKeys.length !== 1 || key.referencedTableName !== 'device' || key.referencedColumnName !== 'id' || key.referencedTableSchema !== key.tableSchema || keys.filter(candidate => candidate.constraintName === key.constraintName).length !== 1) {
    throw new Error('Expected one single-column record.device_id foreign key to device.id in the current database.');
  }
  if (columns[0].isNullable === 'YES' && key.deleteRule.toUpperCase() === 'SET NULL') return;
  const columnType = columns[0].columnType;
  const updateRule = key.updateRule.toUpperCase();
  if (!/^(?:tinyint|smallint|mediumint|int|integer|bigint)(?:\(\d+\))?(?: unsigned)?(?: zerofill)?$/i.test(columnType)) throw new Error('Unsupported record.device_id integer column type.');
  if (!['CASCADE', 'RESTRICT', 'NO ACTION', 'SET NULL', 'SET DEFAULT'].includes(updateRule)) throw new Error('Unsupported record.device_id ON UPDATE action.');
  // MySQL rejects dropping and adding the same FK name in a single ALTER.
  // Match Yii's bounded, deterministic replacement name for the record table.
  const replacementName = 'fk_record_device_history_' + createHash('sha256').update('record\0').update(key.constraintName).digest('hex').slice(0, 32);
  const replacements: Record<string, string> = { foreign_key: '`' + key.constraintName.replace(/`/g, '``') + '`', replacement_key: '`' + replacementName + '`', column_type: columnType, on_update: updateRule };
  const sql = (await readFile(resolve(__dirname, '../database/003-record-preservation.sql'), 'utf8')).replace(/^\s*--.*$/gm, '').trim().replace(/;$/, '').replace(/\{\{(foreign_key|replacement_key|column_type|on_update)\}\}/g, (_match, name: string) => replacements[name]);
  await db.execute(sql);
}
