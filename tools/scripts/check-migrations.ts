/**
 * 迁移子集校验：把平台只接受的那部分 DDL 变成机器检查，避免上线时被
 * sites_migration_rejected / unsupported_* 打回。
 *
 *   node tools/scripts/check-migrations.ts [目录]     # 默认 database/migrations
 *
 * 规则来源是 Qoder Sites 的数据库迁移子集（不是通用 PostgreSQL），已按 2026-11-21 真云实测校准：
 * - 语句只允许 CREATE TABLE app.x / ALTER TABLE app.x ADD COLUMN / 普通 CREATE INDEX；
 * - **CREATE UNIQUE INDEX 会被平台拒绝（unsupported_ddl）** ⇒ 唯一约束一律写成建表期表级 UNIQUE (cols)；
 * - 列类型只允许 boolean integer bigint text uuid timestamptz jsonb（不许 date/numeric/varchar(n)/数组）；
 * - 建表约束只允许 NOT NULL / PRIMARY KEY / UNIQUE；表级只允许 UNIQUE（其余仍用列级写法）；
 * - 默认值只允许字面量与 gen_random_uuid() / now()，CHECK 与生成列不支持；
 * - 加列必须可空且不带默认值；
 * - 索引只允许普通列名：不带 ASC/DESC、表达式、WHERE，索引名不带 schema 前缀。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectCreateTables } from './ddl.ts';

const TYPES = ['boolean', 'integer', 'bigint', 'text', 'uuid', 'timestamptz', 'jsonb'];
// 唯一索引沿用第 1 轮约定的 *_uidx 后缀，普通索引 *_idx
const INDEX_NAME_RE = /^[a-z][a-z0-9_]*_(idx|uidx)$/;
const TABLE_NAME_RE = /^[a-z][a-z0-9_]*$/;

/** 逐语句拆分：只按「行首分号」切，字符串里没有分号，注释里的也不会计入 */
function splitStatements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*\n/)
    .map((chunk) => chunk.replace(/\s+/g, ' ').trim())
    .filter((chunk) => chunk.length > 0);
}

interface Issue { file: string; statement: string; reason: string }

/** 跨文件累积：索引名在同一个 schema 下必须唯一 */
const indexNames = new Set<string>();

function checkColumn(file: string, statement: string, columnDef: string, issues: Issue[], addedColumn: boolean): void {
  const fail = (reason: string) => issues.push({ file, statement: columnDef.trim(), reason });
  const tokens = columnDef.trim().split(' ');
  const name = tokens[0];
  if (!/^[a-z][a-z0-9_]*$/.test(name)) fail('列名必须是小写下划线');

  const rawType = tokens[1] ?? '';
  const declaredType = rawType.toLowerCase();
  if (!TYPES.includes(declaredType)) {
    // 把 numeric(10,2)、varchar(64) 这类带修饰的类型也归到这里，一条错误说清楚
    fail(`类型 ${rawType || '(缺失)'} 不在支持列表（可用：${TYPES.join(' ')}）；日期用 text、金额用 integer(分)`);
    return;
  }
  if (rawType.includes('(')) fail(`${declaredType} 不允许长度或精度修饰`);
  const trailing = columnDef.trim().slice(name.length + 1 + rawType.length);
  if (addedColumn && declaredType === 'jsonb' && /\bDEFAULT\b/i.test(trailing)) {
    fail('jsonb 加列不支持 DEFAULT（默认值只允许标量字面量与 gen_random_uuid()/now()）');
  }

  const banned = [
    [/\bCHECK\b/i, 'CHECK 约束不支持，改到 Function 校验'],
    [/\bREFERENCES\b/i, 'FOREIGN KEY 不支持，完整性由 Function 保证'],
    [/\bGENERATED\b/i, '生成列不支持'],
    [/\bUNIQUE\s*\(/i, '表级 UNIQUE 写法不支持，用列级 UNIQUE 或单独 CREATE INDEX'],
    [/\bCOLLATE\b/i, '不支持 COLLATE'],
    [/::/, '不支持类型转换表达式'],
  ] as const;
  for (const [pattern, reason] of banned) if (pattern.test(trailing)) fail(reason);

  const defaultIndex = trailing.search(/\bDEFAULT\b/i);
  if (defaultIndex >= 0) {
    const after = trailing.slice(defaultIndex + 'DEFAULT'.length);
    const value = after.trim().split(' ')[0];
    const allowed = /^(NULL|TRUE|FALSE|-?\d+|'[^']*'|gen_random_uuid\(\)|now\(\))$/i.test(value);
    if (!allowed) fail(`默认值 ${value} 不在允许集合（null / 布尔 / 整数 / 字符串字面量 / gen_random_uuid() / now()）`);
    if (addedColumn) fail('ADD COLUMN 不允许带 DEFAULT');
    if (declaredType === 'text' && !value.startsWith("'") && value.toUpperCase() !== 'NULL') fail('text 列的默认值只能是字符串字面量');
    if ((declaredType === 'integer' || declaredType === 'bigint') && !/^-?\d+$/.test(value) && value.toUpperCase() !== 'NULL') fail('整数列的默认值只能是整数字面量');
    if (declaredType === 'boolean' && !/^(TRUE|FALSE)$/i.test(value) && value.toUpperCase() !== 'NULL') fail('布尔列的默认值只能是 TRUE/FALSE');
    if ((declaredType === 'uuid' || declaredType === 'timestamptz') && !/^(gen_random_uuid\(\)|now\(\))$/i.test(value) && value.toUpperCase() !== 'NULL') {
      fail(`${declaredType} 列的默认值只允许 gen_random_uuid() / now()`);
    }
  }
  if (addedColumn && /\bNOT NULL\b/i.test(trailing)) fail('ADD COLUMN 不允许 NOT NULL（表可能已有数据）');
}

function checkCreateTable(file: string, statement: string, issues: Issue[]): void {
  const body = statement.slice(statement.indexOf('(') + 1, statement.lastIndexOf(')'));
  const depthOf = (text: string) => { let d = 0; for (const ch of text) d += ch === '(' ? 1 : ch === ')' ? -1 : 0; return d; };
  const parts: string[] = [];
  let current = '';
  for (const chunk of body.split(',')) {
    current += (current ? ',' : '') + chunk;
    if (depthOf(current) === 0) { parts.push(current); current = ''; }
  }
  if (current.trim()) parts.push(current);

  let pkCount = 0;
  const declared = new Set<string>();
  const uniqueGroups: string[][] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    const unique = /^UNIQUE\s*\(([^)]*)\)$/i.exec(trimmed);
    if (unique) {
      uniqueGroups.push(unique[1].split(',').map((name) => name.trim()).filter((name) => name.length > 0));
      continue;
    }
    if (/^(CONSTRAINT|PRIMARY KEY|FOREIGN KEY|CHECK)\b/i.test(trimmed)) {
      issues.push({ file, statement: trimmed, reason: '表级约束只允许 UNIQUE (cols)；主键与其余约束用列级写法' });
      continue;
    }
    const beforeDefault = trimmed.replace(/\bDEFAULT\s+\S+/i, '');
    if (/\bPRIMARY KEY\b/i.test(beforeDefault)) pkCount += 1;
    declared.add(trimmed.split(/\s+/)[0]);
    checkColumn(file, statement, trimmed, issues, false);
  }
  for (const columns of uniqueGroups) {
    if (columns.length === 0) issues.push({ file, statement: statement.slice(0, 60), reason: 'UNIQUE () 不能是空列清单' });
    for (const column of columns) {
      if (!/^[a-z][a-z0-9_]*$/.test(column)) issues.push({ file, statement: column, reason: 'UNIQUE 列必须是普通小写列名' });
      else if (!declared.has(column)) issues.push({ file, statement: column, reason: `UNIQUE 引用了建表语句里不存在的列` });
    }
  }
  if (pkCount !== 1) issues.push({ file, statement: statement.slice(0, 60), reason: `主键列数应为 1，实际 ${pkCount}` });
}

function checkIndex(statement: string, file: string, issues: Issue[]): void {
  if (/^CREATE UNIQUE INDEX/i.test(statement)) {
    issues.push({ file, statement, reason: '平台拒绝 CREATE UNIQUE INDEX（unsupported_ddl）⇒ 唯一约束写进建表语句的 UNIQUE (cols)' });
    return;
  }
  const match = /^CREATE INDEX (IF NOT EXISTS )?([^\s]+) ON (?:app\.)?([a-z0-9_]+) \(([^)]+)\)(.*)$/i.exec(statement);
  if (!match) { issues.push({ file, statement, reason: '索引语句无法按「CREATE INDEX 名字 ON app.表 (列...)」解析' }); return; }
  const [, , indexName, table, columns, tail] = match;
  if (!INDEX_NAME_RE.test(indexName)) issues.push({ file, statement: indexName, reason: '索引名必须是小写 xxx_idx，且不带 app. 前缀' });
  if (!TABLE_NAME_RE.test(table)) issues.push({ file, statement: table, reason: '表名必须是小写下划线' });
  if (tail.trim().length > 0) issues.push({ file, statement, reason: `索引尾部不支持的选项：${tail.trim()}（不许 WHERE / ASC / DESC / NULLS / 表达式）` });
  for (const column of columns.split(',')) {
    const name = column.trim();
    if (!/^[a-z][a-z0-9_]*$/.test(name)) issues.push({ file, statement: name, reason: `索引列必须是普通列名，不能带 ${column} 这类修饰` });
  }
}

/** 每张被建的表都要有 id 主键 + created_at + updated_at（第 1 轮设计里的硬约定） */
function checkTableDiscipline(file: string, statement: string, issues: Issue[]): void {
  if (!/^CREATE TABLE/i.test(statement)) return;
  const requireColumns = ['created_at', 'updated_at'];
  for (const column of requireColumns) {
    if (!new RegExp(`\\n?\\s+${column}\\s+timestamptz`, 'i').test(statement.replace(/\s+/g, ' ').replace(/, /g, ',\n '))) {
      issues.push({ file, statement: statement.slice(0, 60), reason: `缺少 ${column} timestamptz 列（所有表统一带创建/更新时间）` });
    }
  }
}

/**
 * 建表语句里的列名集合：直接扫描原始文件文本并按行解析
 * （本项目的 DDL 固定「一列一行、注释单独成行」，按行比按逗号切更不容易被注释里的标点带偏）。
 */
function collectColumnNames(sql: string, into: Map<string, Set<string>>): void {
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

/** 索引引用了不存在的列，平台会在应用时报错；改列名时最容易漏的就是这里 */
function checkIndexColumns(statement: string, file: string, columnsByTable: Map<string, Set<string>>, issues: Issue[]): void {
  const match = /^CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?([^\s]+) ON (?:app\.)?([a-z0-9_]+) \(([^)]+)\)/i.exec(statement);
  if (!match) return;
  const [, indexName, table, columnList] = match;
  const known = columnsByTable.get(table);
  if (!known) { issues.push({ file, statement: indexName, reason: `索引指向未建的表 ${table}` }); return; }
  for (const raw of columnList.split(',')) {
    const column = raw.trim();
    if (!known.has(column)) issues.push({ file, statement: `${table}.${column}`, reason: `索引 ${indexName} 引用了不存在的列` });
  }
  if (indexNames.has(indexName)) issues.push({ file, statement: indexName, reason: '索引名重复' });
  indexNames.add(indexName);
}

function main(): void {
  const dir = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'database', 'migrations'));
  const files = readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
  const issues: Issue[] = [];
  const seenTables = new Set<string>();
  /** 表名 → 列名集合，用于校验索引引用的列真实存在（改列名时最容易漏） */
  const columnsByTable = new Map<string, Set<string>>();
  let statementCount = 0;

  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf8');
    if (/\r\n/.test(sql)) issues.push({ file, statement: '(文件)', reason: '请统一 LF 换行' });
    collectColumnNames(sql, columnsByTable);
    for (const statement of splitStatements(sql)) {
      statementCount += 1;
      const create = /^CREATE TABLE (?:IF NOT EXISTS )?(?:app\.)?([a-z0-9_]+)/i.exec(statement);
      if (create) {
        if (seenTables.has(create[1])) issues.push({ file, statement: create[1], reason: '同一张表被重复建表' });
        seenTables.add(create[1]);
        checkCreateTable(file, statement, issues);
        checkTableDiscipline(file, statement, issues);
        continue;
      }
      if (/^ALTER TABLE/i.test(statement)) {
        if (!/^ALTER TABLE (?:IF NOT EXISTS )?(?:app\.)?[a-z0-9_]+ ADD COLUMN (?:IF NOT EXISTS )?[a-z][a-z0-9_]* /i.test(statement)) {
          issues.push({ file, statement, reason: 'ALTER TABLE 只允许 ADD COLUMN' });
          continue;
        }
        const table = /ALTER TABLE (?:IF NOT EXISTS )?(?:app\.)?([a-z0-9_]+)/i.exec(statement)![1];
        const columnDef = statement.replace(/^ALTER TABLE (?:IF NOT EXISTS )?(?:app\.)?[a-z0-9_]+ ADD COLUMN (?:IF NOT EXISTS )?/i, '');
        checkColumn(file, statement, columnDef, issues, true);
        const added = columnDef.trim().split(' ')[0];
        const known = columnsByTable.get(table);
        if (known && known.has(added)) issues.push({ file, statement: `${table}.${added}`, reason: 'ADD COLUMN 的列名与建表时的列重复' });
        if (known) known.add(added);
        continue;
      }
      if (/^CREATE (UNIQUE )?INDEX/i.test(statement)) {
        checkIndex(statement, file, issues);
        checkIndexColumns(statement, file, columnsByTable, issues);
        continue;
      }
      issues.push({ file, statement: statement.slice(0, 80), reason: '语句类型不在迁移子集内（只允许 CREATE TABLE / ADD COLUMN / CREATE INDEX）' });
    }
  }

  console.log(`扫描 ${files.length} 个文件、${statementCount} 条语句，表 ${seenTables.size} 张`);
  console.log(`表清单：${[...seenTables].sort().join(', ')}`);
  if (issues.length === 0) {
    console.log('✓ 全部语句都在平台迁移子集内');
    return;
  }
  console.log(`✗ 发现 ${issues.length} 处问题：`);
  for (const issue of issues) console.log(`  [${issue.file}] ${issue.reason}\n      ${issue.statement}`);
  process.exitCode = 1;
}

main();
