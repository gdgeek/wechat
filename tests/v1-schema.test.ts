import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
const root=resolve(__dirname,'..');
const baseline=process.env.YII2_MIGRATIONS;
test('legacy schema is generated from final up state without historical dropped columns', () => {
  expect(existsSync(resolve(root,'scripts/generate-legacy-schema.php')),'The offline migration schema compiler must exist').toBe(true);
  const generated=readFileSync(resolve(root,'database/legacy-schema.sql'),'utf8');
  if (baseline) {
    expect(existsSync(baseline), 'The explicitly selected frozen Yii migration directory must exist').toBe(true);
    const rebuilt=execFileSync('php',[resolve(root,'scripts/generate-legacy-schema.php'),baseline],{encoding:'utf8'});
    expect(rebuilt).toBe(generated);
  }
  expect(generated.match(/CREATE TABLE /g)).toHaveLength(18);
  const device=/CREATE TABLE[^;]*`device` \(([\s\S]*?)\n\)/.exec(generated)![1];
  expect(device).toContain('`version` int NOT NULL DEFAULT 0');
  expect(device).not.toContain('`shop_id`');expect(device).not.toContain('`setup`');expect(device).not.toContain('`status`');
  const setup=/CREATE TABLE[^;]*`setup` \(([\s\S]*?)\n\)/.exec(generated)![1];
  expect(setup).toContain('`shots` json');expect(setup).not.toContain('`shot`');
  const file=/CREATE TABLE[^;]*`file` \(([\s\S]*?)\n\)/.exec(generated)![1];
  expect(file).toContain('`price` int NULL');
  expect(file).not.toContain('`price` int NOT NULL');
  const orders=/CREATE TABLE IF NOT EXISTS `file_payment_order` \(([\s\S]*?)\n\) CHARACTER SET ascii COLLATE ascii_bin ENGINE=InnoDB;/.exec(generated)![1];
  expect(orders).toContain('`out_trade_no` varchar(32) NOT NULL');
  for (const column of ['user_id','file_id','amount']) expect(orders).toContain('`'+column+'` int NOT NULL');
  expect(orders).toContain('`created_at` datetime NOT NULL');
  expect(orders).toContain('PRIMARY KEY (`out_trade_no`)');
  expect(generated).not.toMatch(/ALTER TABLE `file_payment_order` ADD CONSTRAINT/);
  expect(generated).toContain('CONSTRAINT `fk-control-device_id` FOREIGN KEY (`device_id`) REFERENCES `device` (`id`) ON DELETE CASCADE');
  const record=/CREATE TABLE[^;]*`record` \(([\s\S]*?)\n\)/.exec(generated)![1];
  expect(record).toContain('`device_id` int NULL');
  expect(record).not.toContain('`device_id` int NOT NULL');
  expect(generated).toContain('CONSTRAINT `fk_record_device_history_7fccfb527aaf981932ad1471f302a4ae` FOREIGN KEY (`device_id`) REFERENCES `device` (`id`) ON DELETE SET NULL');
  expect(generated).not.toContain('CONSTRAINT `fk-record-device_id`');
  expect(generated).toContain('`status` ENUM(\'ready\', \'running\', \'finish\') NOT NULL DEFAULT \'ready\'');
  expect(generated).toContain('`type` ENUM(\'root\', \'admin\', \'director\', \'staff\') NOT NULL DEFAULT \'staff\'');
});
