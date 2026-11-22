/**
 * DAO 列名 ↔ 迁移 DDL 一致性校验。
 *
 *   node tools/scripts/check-schema-usage.ts
 *
 * 为什么需要它：列名写错在线上不会静默——PostgREST 对未知列返回 400（PGRST204/205），
 * 但本地内存库是宽容实现，只有跑到那条分支才可能发现；seed/DDL/代码三套词汇漂移过一次，
 * 教训就是「引用关系必须机器校验」。本脚本静态解析 backend/ 里的链式查询，检查：
 *   1) .from('t') 的表在迁移里存在；
 *   2) select / eq / neq / gt / gte / lt / lte / in / isNull / order 的列在该表存在；
 *   3) insert / insertIfAbsent / update 的载荷键在该表存在（载荷写成 const 变量时会回文件里找）；
 *   4) 形如 { column: 'x', table: 't' } 的参数字面对象（quota 的分桶 spec）也校验配对；
 *   5) 表名/列名来自动态表达式时计入「静态跳过」并打印，剩下的盲区由冒烟与线上日志兜住。
 * 已知残余盲区：PATCH 白名单 COLUMNS 的取值（列名藏在字符串值里，无法关联到具体表），
 * 由 docs/03 §「人工核对项」列出，改动时同步核对。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSchema, type Schema } from './ddl.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BACKEND = join(ROOT, 'backend');
const MIGRATIONS = join(ROOT, 'database', 'migrations');
const READ_METHODS = ['select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'isNull', 'order'] as const;
const WRITE_METHODS = ['insert', 'insertIfAbsent', 'update'] as const;

const problems: string[] = [];
const skipped: string[] = [];

function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'migrations' || name === 'seed') continue;
      listTsFiles(full, out);
    } else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** 从 index 处的 `(` 开始扫描，返回与之配对的 `)` 之后的位置（跳过字符串与模板串） */
function matchParen(source: string, openIndex: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') { depth -= 1; if (depth === 0) return i + 1; }
  }
  return -1;
}

/** 语句结束位置：从 from 之后第一个「括号外」的分号 */
function statementEnd(source: string, from: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ';' && depth <= 0) return i;
  }
  return source.length;
}

/** 链式调用 `.method(` 的实参起始位置（`.insert(` 不会吃掉 `.insertIfAbsent(`，因为方法名后必须是括号） */
function findCalls(statement: string, method: string): number[] {
  const needle = `.${method}(`;
  const out: number[] = [];
  let index = statement.indexOf(needle);
  while (index >= 0) {
    out.push(index + needle.length);
    index = statement.indexOf(needle, index + needle.length);
  }
  return out;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (source[i] === '\n') line += 1;
  return line;
}

/** 顶层键：只取括号深度 0 上的 `identifier:`，嵌套对象与数组元素不算本表的列 */
function topLevelKeys(objectText: string): string[] | null {
  const keys: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let token = '';
  for (let i = 0; i < objectText.length; i += 1) {
    const ch = objectText[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      token += ch;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '{' || ch === '[') { depth += 1; continue; }
    if (ch === ')' || ch === '}' || ch === ']') { depth -= 1; continue; }
    if (depth === 0 && (ch === ':' || ch === ',')) {
      const name = token.trim();
      if (ch === ':' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) keys.push(name);
      token = '';
      continue;
    }
    if (depth === 0) token += ch;
  }
  // spread / 计算键无法静态判定：只要文本里出现过就要求人工确认
  return /\.\.\./.test(objectText) ? null : keys;
}

function checkColumn(schema: Schema, table: string, column: string, where: string): void {
  const known = schema.get(table);
  if (!known) return;
  // select 可以是 'a, b' 这种列表，也可能带 count 之类的修饰
  for (const raw of column.split(',')) {
    const name = raw.trim().split(/\s+/)[0].replace(/->>?/g, '');
    if (name === '' || name === '*' || name === 'count') continue;
    if (!known.has(name)) problems.push(`${where}: 表 ${table} 没有列 ${name}`);
  }
}

/**
 * 取调用括号内的第一个实参（引号感知，`select('id, status')` 里的逗号不能被当成参数分隔）。
 * 返回 null 表示第一个实参不是字符串字面量 ⇒ 静态无法判定，交调用方记为跳过。
 */
function firstArg(text: string): string | null {
  const start = text.search(/\S/);
  if (start < 0) return null;
  const quote = text[start];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  for (let i = start + 1; i < text.length; i += 1) {
    if (text[i] === '\\') { i += 1; continue; }
    if (text[i] === quote) return text.slice(start + 1, i);
  }
  return null;
}

/** `.from(...)` 的接收者白名单外一律忽略：Array.from / Object.from 会被同一个形状匹配到 */
const NON_DB_RECEIVERS = new Set(['Array', 'Object', 'String', 'Number', 'Buffer']);

/** 同文件里的 `const name = { ... }`：写入载荷常被提成变量（createUser 就是这种写法） */
function resolveLocalObject(source: string, name: string): string | null {
  const marker = new RegExp(`(?:const|let)\\s+${name}\\s*(?::[^=]*)?=\\s*\\{`).exec(source);
  if (!marker) return null;
  const open = marker.index + marker[0].length - 1;
  const close = matchBrace(source, open);
  return close < 0 ? null : source.slice(open + 1, close);
}

/** 实参列表里depth-0 逗号之前的第一个实参 */
function firstTopLevelArg(text: string): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) return text.slice(0, i);
  }
  return text;
}

/** 从 `{` 开始找配对的 `}`（引号感知） */
function matchBrace(source: string, openIndex: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

function checkFile(schema: Schema, path: string): void {
  const source = readFileSync(path, 'utf8');
  const relative = path.slice(ROOT.length + 1).replace(/\\/g, '/');
  for (const m of source.matchAll(/([A-Za-z_$][\w$.]*)\.from\(([^)]*)\)/g)) {
    const receiver = m[1].split('.').pop() ?? m[1];
    if (NON_DB_RECEIVERS.has(receiver)) continue;
    const at = `${relative}:${lineOf(source, m.index!)}`;
    const table = /^'([a-z0-9_]+)'$/.exec(m[2].trim())?.[1];
    if (table === undefined) { skipped.push(`${at} 表名是表达式 ${m[2].trim()}`); continue; }
    if (!schema.has(table)) { problems.push(`${at}: 表 ${table} 不在迁移脚本里`); continue; }

    // 语句范围：from 之后到第一个「括号外」分号，链上的方法调用都在这段里
    const after = m.index! + m[0].length;
    const statement = source.slice(after, statementEnd(source, after));
    for (const method of READ_METHODS) {
      for (const open of findCalls(statement, method)) {
        const arg = firstArg(statement.slice(open));
        if (arg === null) { skipped.push(`${at} ${method} 的首个实参不是字符串字面量`); continue; }
        checkColumn(schema, table, arg, `${at} ${table}.${method}`);
      }
    }
    for (const method of WRITE_METHODS) {
      for (const open of findCalls(statement, method)) {
        const close = matchParen(statement, open - 1);
        if (close < 0) { problems.push(`${at} ${method} 的括号未闭合，脚本读不下去了`); continue; }
        // 只取第一个实参：insertIfAbsent(values, { onConflict: ... }) 的第二参不是列
        const args = firstTopLevelArg(statement.slice(open, close - 1)).trim();
        // 载荷常被提成变量（`const values = {...}` 再 insert(values)），这里回同一文件把它找出来
        const objectText = args.startsWith('{')
          ? args
          : (/^[A-Za-z_$][\w$]*$/.test(args) ? resolveLocalObject(source, args) : null);
        if (objectText === null) { skipped.push(`${at} ${method} 的入参解析不到对象字面量：${args.slice(0, 40)}`); continue; }
        const keys = topLevelKeys(objectText);
        if (keys === null) { skipped.push(`${at} ${method} 含展开写法，需人工核对列名`); continue; }
        for (const key of keys) {
          if (key === 'onConflict') continue;
          if (!schema.get(table)!.has(key)) problems.push(`${at}: ${table}.${method} 写入的键 ${key} 不是该表的列`);
        }
      }
    }
  }
  checkSpecObjects(schema, relative, source);
}

/**
 * 非链式的「按表+列参数化」写法：quota.ts 的 enforceWindow 只收到 `spec.table` / `spec.column`，
 * 真正的字面量在调用方拼的那个对象里。用「同一个对象字面量内同时出现 table 与 column」这条形状来配对，
 * 宁可窄（只认这两个键名）也不要误报。
 */
function checkSpecObjects(schema: Schema, relative: string, source: string): void {
  for (const open of findBraces(source)) {
    const close = matchBrace(source, open);
    if (close < 0) continue;
    const body = source.slice(open + 1, close);
    // 只认最内层对象：外层函数体里可能同时出现两个 spec 的 table/column，配对会配错
    if (body.includes('{')) continue;
    const table = /(?:^|[,{\s])table:\s*'([a-z0-9_]+)'/.exec(body)?.[1];
    const column = /(?:^|[,{\s])column:\s*'([a-z0-9_]+)'/.exec(body)?.[1];
    if (table === undefined || column === undefined) continue;
    const at = `${relative}:${lineOf(source, open)}`;
    if (!schema.has(table)) { problems.push(`${at}: spec 里的表 ${table} 不在迁移脚本里`); continue; }
    if (!schema.get(table)!.has(column)) problems.push(`${at}: spec 里的 ${table}.${column} 不是该表的列`);
  }
}

/** 所有 `{` 的位置：spec 对象嵌在函数实参里，只能全文扫 */
function findBraces(source: string): number[] {
  const out: number[] = [];
  let quote: string | null = null;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') out.push(i);
  }
  return out;
}

const schema = loadSchema(MIGRATIONS);
const files = listTsFiles(BACKEND);
for (const file of files) checkFile(schema, file);

const columnCount = [...schema.values()].reduce((sum, set) => sum + set.size, 0);
console.log(`迁移脚本：${schema.size} 张表、${columnCount} 列；扫描 ${files.length} 个 Function 源码文件`);
console.log(`静态跳过（表达式表名/列名，需人工或冒烟覆盖）：${skipped.length} 处`);
for (const line of skipped) console.log(`  ~ ${line}`);
if (problems.length === 0) {
  console.log('✓ DAO 引用的表与列都在迁移脚本里');
} else {
  console.log(`✗ ${problems.length} 处不一致：`);
  for (const line of problems) console.log(`  - ${line}`);
  process.exitCode = 1;
}
