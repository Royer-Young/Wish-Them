/**
 * DDL 解析：把迁移脚本读成「表名 → 列名集合」。
 * check-migrations.ts（语法子集校验）与 check-schema-usage.ts（代码引用校验）共用同一份解析，
 * 避免出现「两个校验器对同一份 DDL 理解不同」这种最坑的分歧。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export type Schema = Map<string, Set<string>>;

/**
 * 建表语句里的列名集合：直接扫描原始文件文本并按行解析
 * （本项目的 DDL 固定「一列一行、注释单独成行」，按行比按逗号切更不容易被注释里的标点带偏）。
 */
export function collectCreateTables(sql: string, into: Schema): void {
  let table: string | null = null;
  for (const rawLine of sql.split('\n')) {
    const line = rawLine.trim();
    const create = /^CREATE TABLE (?:IF NOT EXISTS )?app\.([a-z0-9_]+)/i.exec(line);
    if (create) { table = create[1]; into.set(table, new Set()); continue; }
    if (table === null) continue;
    if (line === ');') { table = null; continue; }
    if (line.startsWith('--') || line.length === 0) continue;
    const first = line.replace(/,$/, '').split(/\s+/)[0];
    if (/^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK)$/i.test(first)) continue;
    if (/^[a-z][a-z0-9_]*$/.test(first)) into.get(table)!.add(first);
  }
}

/** ALTER TABLE ... ADD COLUMN 也要并入列集合，否则后加的列会被引用校验误报 */
export function collectAddColumns(sql: string, into: Schema): void {
  for (const m of sql.matchAll(/ALTER TABLE (?:IF NOT EXISTS )?(?:app\.)?([a-z0-9_]+) ADD COLUMN (?:IF NOT EXISTS )?([a-z][a-z0-9_]*)/gi)) {
    const known = into.get(m[1]);
    if (known) known.add(m[2]);
  }
}

export function loadSchema(migrationsDir: string): Schema {
  const schema: Schema = new Map();
  for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    collectCreateTables(sql, schema);
    collectAddColumns(sql, schema);
  }
  return schema;
}
