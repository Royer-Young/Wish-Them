/**
 * 内存版数据库：只为本地跑通路由与一致性分支，不代表线上语义。
 * 与 backend/lib/db.ts 的约定一一对应：
 * - 链式构建、await 时才执行（PromiseLike）；
 * - 写操作必须显式 .select(...) 才有返回体（对应线上 Prefer: return=representation），
 *   所以漏写 select 时 affected() 得到 0 行，本地立刻能发现；
 * - insert 命中唯一索引 → { error: { code: '23505' } }；insertIfAbsent 冲突 → 空数组。
 */

type Verb = 'select' | 'insert' | 'insertIfAbsent' | 'update' | 'delete';

interface Predicate {
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'isNull';
  column: string;
  value?: unknown;
}

import type { DbResult, DbRow } from '../../backend/lib/types.ts';

/** 与 backend/lib/types.ts 完全一致的结果形状，保证 FakeDb 可直接当 DbClient 用 */
type Result = DbResult;
type Row = DbRow;

/** 唯一索引声明与迁移脚本保持一致，本地才能复现 23505 分支 */
const UNIQUE_INDEXES: Record<string, string[][]> = {
  wish_templates: [['id']],
  task_templates: [['id']],
  rewards: [['id']],
  users: [['recovery_code_hash']],
  idempotency_keys: [['principal', 'operation', 'idempotency_key']],
  demo_sessions: [['user_id']],
  ai_suggestions: [['user_id', 'capability', 'input_hash']],
  checkins: [['task_id']],
  tasks: [['wish_id', 'template_id'], ['wish_id', 'text']],
  settlements: [['wish_id', 'version']],
  reports: [['target_type', 'target_id', 'reporter_id']],
  share_links: [['token'], ['wish_id']],
  files: [['object_key']],
  pool_posts: [['wish_id']],
  wish_answers: [['wish_id']],
  ledger_weeks: [['wish_id', 'week_start']],
  makeup_tickets: [['wish_id', 'week_start']],
};

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function project(row: Row, columns?: string): Row {
  if (!columns || columns.includes('*')) return clone(row);
  const picked: Row = {};
  for (const name of columns.split(',').map((column) => column.trim())) {
    if (name in row) picked[name] = clone(row[name]);
  }
  return picked;
}

function matches(row: Row, predicates: Predicate[]): boolean {
  for (const predicate of predicates) {
    const cell = row[predicate.column];
    switch (predicate.op) {
      case 'eq': if (cell !== predicate.value) return false; break;
      case 'neq': if (cell === predicate.value) return false; break;
      // ISO-8601 字符串与 YYYY-MM-DD 都能按字典序比较，和线上时间戳语义一致
      case 'gt': if (!(String(cell ?? '') > String(predicate.value))) return false; break;
      case 'gte': if (!(String(cell ?? '') >= String(predicate.value))) return false; break;
      case 'lt': if (!(String(cell ?? '') < String(predicate.value))) return false; break;
      case 'lte': if (!(String(cell ?? '') <= String(predicate.value))) return false; break;
      case 'in': if (!Array.isArray(predicate.value) || !predicate.value.includes(cell)) return false; break;
      case 'isNull': if (cell !== null && cell !== undefined) return false; break;
    }
  }
  return true;
}

class Chain implements PromiseLike<Result> {
  private verb: Verb = 'select';
  private columns: string | undefined;
  private values: Row | Row[] | undefined;
  private predicates: Predicate[] = [];
  private orderBy: { column: string; ascending: boolean } | undefined;
  private take: number | undefined;

  private readonly store: Map<string, Row>;
  private readonly tableName: string;

  constructor(store: Map<string, Row>, tableName: string) {
    this.store = store;
    this.tableName = tableName;
  }

  select(columns?: string) { this.columns = columns ?? '*'; return this; }
  insert(values: Row | Row[]) { this.verb = 'insert'; this.values = values; return this; }
  insertIfAbsent(values: Row | Row[] /* , options: { onConflict: string } */) {
    // onConflict 只在线上决定回哪些列，内存版按唯一索引判定即可
    this.verb = 'insertIfAbsent'; this.values = values; return this;
  }
  update(values: Row) { this.verb = 'update'; this.values = values; return this; }
  delete() { this.verb = 'delete'; return this; }
  eq(column: string, value: unknown) { this.predicates.push({ op: 'eq', column, value }); return this; }
  neq(column: string, value: unknown) { this.predicates.push({ op: 'neq', column, value }); return this; }
  gt(column: string, value: unknown) { this.predicates.push({ op: 'gt', column, value }); return this; }
  gte(column: string, value: unknown) { this.predicates.push({ op: 'gte', column, value }); return this; }
  lt(column: string, value: unknown) { this.predicates.push({ op: 'lt', column, value }); return this; }
  lte(column: string, value: unknown) { this.predicates.push({ op: 'lte', column, value }); return this; }
  in(column: string, values: unknown[]) { this.predicates.push({ op: 'in', column, value: values }); return this; }
  isNull(column: string) { this.predicates.push({ op: 'isNull', column }); return this; }
  order(column: string, options?: { ascending?: boolean }) { this.orderBy = { column, ascending: options?.ascending ?? true }; return this; }
  limit(count: number) { this.take = count; return this; }

  /** 与线上客户端一致：await chain 得到 { data, error } */
  then<F = Result, R = never>(onfulfilled?: ((value: Result) => F | Promise<F>) | null, onrejected?: ((reason: unknown) => R | Promise<R>) | null): Promise<F | R> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }

  /** 线上语义：0 行 → data null。业务代码统一用 .limit(1) + lib/db.ts，这里只做兜底实现 */
  async maybeSingle(): Promise<Result> {
    const result = this.execute();
    const data = Array.isArray(result.data) ? result.data[0] ?? null : result.data ?? null;
    return { ...result, data };
  }

  async single(): Promise<Result> {
    const result = await this.maybeSingle();
    if (result.data === null) return { data: null, error: { code: 'PGRST116', message: 'no rows returned' } };
    return result;
  }

  private execute(): Result {
    const rows = [...this.store.values()];
    if (this.verb === 'select') {
      let found = rows.filter((row) => matches(row, this.predicates));
      if (this.orderBy) {
        const { column, ascending } = this.orderBy;
        found = found.slice().sort((a, b) => {
          const left = String(a[column] ?? '');
          const right = String(b[column] ?? '');
          return (left < right ? -1 : left > right ? 1 : 0) * (ascending ? 1 : -1);
        });
      }
      if (this.take !== undefined) found = found.slice(0, this.take);
      return { data: found.map((row) => project(row, this.columns)), error: null };
    }

    const incoming = this.toArray(this.values);
    if (this.verb === 'insert' || this.verb === 'insertIfAbsent') {
      // insert 整条语句失败（Postgres 语义）；insertIfAbsent 逐行跳过冲突，
      // 这样「崩溃后补齐缺失任务」才能在本地复现，而不是整批被一条冲突挡掉
      const accepted: Row[] = [];
      for (const candidate of incoming) {
        const clash = this.conflictOf(candidate, accepted);
        if (clash) {
          if (this.verb === 'insert') {
            return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint "${this.tableName}_${clash.join('_')}_key"` } };
          }
          continue;
        }
        accepted.push(candidate);
      }
      const written = accepted.map((row) => {
        const record = { ...row };
        this.store.set(String(record.id), record);
        return record;
      });
      return { data: this.columns ? written.map((row) => project(row, this.columns)) : [], error: null };
    }

    if (this.verb === 'update') {
      const patch = incoming[0] ?? {};
      const written: Row[] = [];
      for (const row of rows) {
        if (!matches(row, this.predicates)) continue;
        Object.assign(row, clone(patch));
        written.push(row);
      }
      return { data: this.columns ? written.map((row) => project(row, this.columns)) : [], error: null };
    }

    const removed: Row[] = [];
    for (const row of rows) {
      if (matches(row, this.predicates)) {
        this.store.delete(String(row.id));
        removed.push(row);
      }
    }
    return { data: this.columns ? removed.map((row) => project(row, this.columns)) : [], error: null };
  }

  private toArray(values: Row | Row[] | undefined): Row[] {
    if (!values) return [];
    return Array.isArray(values) ? values : [values];
  }

  /**
   * PostgreSQL 的 UNIQUE 含 NULL 不冲突，这里保持一致（tasks.wish_id + NULL template_id 可重复）。
   * pending 是本批次已接受的行：同一批内部也要判重，否则批量插入能塞进两条相同唯一键。
   */
  private conflictOf(candidate: Row, pending: Row[] = []): string[] | null {
    for (const columns of UNIQUE_INDEXES[this.tableName] ?? []) {
      if (columns.some((column) => candidate[column] === null || candidate[column] === undefined)) continue;
      for (const row of [...this.store.values(), ...pending]) {
        if (columns.every((column) => row[column] === candidate[column])) return columns;
      }
    }
    return null;
  }
}

export class FakeDb {
  private readonly tables = new Map<string, Map<string, Row>>();

  from(table: string): Chain {
    const store = this.tables.get(table) ?? new Map<string, Row>();
    this.tables.set(table, store);
    return new Chain(store, table);
  }

  seed(table: string, rows: Row[]): void {
    const store = this.tables.get(table) ?? new Map<string, Row>();
    for (const row of rows) store.set(String(row.id), clone(row));
    this.tables.set(table, store);
  }

  rowsOf(table: string): Row[] {
    return [...(this.tables.get(table)?.values() ?? [])].map((row) => clone(row));
  }

  clear(): void {
    this.tables.clear();
  }
}
