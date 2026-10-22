import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('file download price schema upgrade',()=>{
  it('adds one nullable integer column without updating historical prices and is repeatable',async()=>{
    const imported=await import('../scripts/file-download-price').catch(()=>({} as any));
    expect(imported.ensureFileDownloadPrice).toBeTypeOf('function');
    let present=false;const executed:string[]=[];
    const db={columns:async()=>present?[{name:'id'},{name:'price',nullable:true}]:[{name:'id'}],execute:async(sql:string)=>{executed.push(sql);present=true;return {affectedRows:0,insertId:0};}};
    await imported.ensureFileDownloadPrice(db);await imported.ensureFileDownloadPrice(db);
    expect(executed).toHaveLength(3);expect(executed[0]).toMatch(/ALTER TABLE `file`\s+ADD COLUMN `price` int NULL/);
    expect(executed[1]).toMatch(/CREATE TABLE IF NOT EXISTS `file_payment_order`/);
    expect(executed[2]).toBe(executed[1]);
    expect(executed.join('\n')).not.toMatch(/UPDATE|DEFAULT 0/i);
    expect(executed[1]).toContain('CHARACTER SET ascii COLLATE ascii_bin ENGINE=InnoDB');
    expect(executed[1]).not.toMatch(/FOREIGN KEY|REFERENCES/i);
    expect(readFileSync(resolve('scripts/migrate.ts'),'utf8')).toContain('ensureFileDownloadPrice(db)');
  });
  it('creates the payment ledger even when a previous upgrade already added file.price',async()=>{
    const {ensureFileDownloadPrice}=await import('../scripts/file-download-price');const executed:string[]=[];
    await ensureFileDownloadPrice({columns:async()=>[{name:'price',type:'int',nullable:true}],execute:async(sql:string)=>{executed.push(sql);return {affectedRows:0,insertId:0};}});
    expect(executed).toHaveLength(1);expect(executed[0]).toMatch(/CREATE TABLE IF NOT EXISTS `file_payment_order`/);
  });
});
