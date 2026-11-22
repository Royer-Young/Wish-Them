/**
 * 对比第 1 轮设计稿 db/schema.sql 与可执行迁移 database/migrations/*.sql。
 *
 *   node tools/scripts/diff-schema.ts
 *
 * 存在的意义：偏差清单会随迁移改动而失真（第 2 轮就把 relation_code、rewards 分类等改掉过）。
 * 文档里写「差异见本脚本输出」比手写一份容易腐烂的对照表可靠。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 逐行解析：本项目两边 DDL 都是「一列一行、注释单独成行」 */
function parseTables(sql: string, stripSchemaPrefix: boolean): Map<string, string[]> {
  const tables = new Map<string, string[]>();
  let table: string | null = null;
  for (const raw of sql.split('\n')) {
    const line = raw.trim();
    const create = /^CREATE TABLE (?:IF NOT EXISTS )?(?:app\.)?([a-z][a-z0-9_]+)/i.exec(line);
    if (create) {
      table = create[1];
      if (tables.has(table)) throw new Error(`${table} 被重复建表`);
      tables.set(table, []);
      continue;
    }
    if (table === null) continue;
    if (line === ');') { table = null; continue; }
    if (line.length === 0 || line.startsWith('--')) continue;
    const first = line.replace(/,$/, '').split(/\s+/)[0];
    if (/^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK)$/i.test(first)) continue;
    if (stripSchemaPrefix && first === 'LIKE') continue;
    if (/^[a-z][a-z0-9_]*$/.test(first)) tables.get(table)!.push(first);
  }
  return tables;
}

const design = parseTables(readFileSync(join(ROOT, 'db', 'schema.sql'), 'utf8'), false);
const migrationDir = join(ROOT, 'database', 'migrations');
const applied = new Map<string, string[]>();
for (const file of readdirSync(migrationDir).filter((name) => name.endsWith('.sql')).sort()) {
  for (const [table, columns] of parseTables(readFileSync(join(migrationDir, file), 'utf8'), false)) {
    applied.set(table, columns);
  }
}

const onlyDesign = [...design.keys()].filter((t) => !applied.has(t));
const onlyApplied = [...applied.keys()].filter((t) => !design.has(t));

console.log(`第 1 轮设计稿 ${design.size} 张表｜可执行迁移 ${applied.size} 张表`);
console.log(`只在设计稿（本轮不建）：${onlyDesign.join(', ') || '无'}`);
console.log(`迁移新增：${onlyApplied.join(', ') || '无'}`);

let changed = 0;
for (const table of [...applied.keys()].sort()) {
  if (!design.has(table)) continue;
  const before = new Set(design.get(table));
  const after = new Set(applied.get(table));
  const dropped = [...before].filter((c) => !after.has(c));
  const added = [...after].filter((c) => !before.has(c));
  if (dropped.length === 0 && added.length === 0) continue;
  changed += 1;
  console.log(`\n${table}`);
  if (dropped.length) console.log(`  设计稿有、迁移没有：${dropped.join(', ')}`);
  if (added.length) console.log(`  迁移新增：${added.join(', ')}`);
}
console.log(`\n共 ${changed} 张表存在列级差异（未变的表不列出）`);
