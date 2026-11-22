/**
 * 数据访问收敛层：把后端返回的 { data, error } 统一成异常，业务代码只写 happy path。
 *
 * 一致性前提（平台无事务）：
 * - 跨多行的不变量禁止依赖事务，改用「单行 CAS + 幂等表 + 可重算派生列 + 惰性过期」。
 * - CAS 统一用 affected()：条件更新命中 0 行即代表冲突或已处理，由调用方决定重算/重放/报错。
 * - 写操作必须显式 select 主键才能拿到受影响行数，affected() 内部已补齐。
 */

import { fromDbError } from './errors.ts';
import type { DbClient, DbQueryChain, DbResult } from './types.ts';

export type Row = Record<string, unknown>;

function unwrap<T = Row>(result: DbResult, action: string): T[] {
  if (result.error) throw fromDbError(result.error, `${action} failed`);
  const data = result.data;
  if (data === null || data === undefined) return [];
  return (Array.isArray(data) ? data : [data]) as T[];
}

/** 查询多行（调用方已 select） */
export async function rows(chain: DbQueryChain, action = 'select'): Promise<Row[]> {
  return unwrap(await chain, action);
}

export async function rowsAs<T>(chain: DbQueryChain, action = 'select'): Promise<T[]> {
  return unwrap<T>(await chain, action);
}

/** 取首行或 null：内部统一加 limit(1)，避免误读全表 */
export async function first(chain: DbQueryChain, action = 'select'): Promise<Row | null> {
  return (await rows(chain.limit(1), action))[0] ?? null;
}

export async function firstAs<T>(chain: DbQueryChain, action = 'select'): Promise<T | null> {
  return (await rowsAs<T>(chain.limit(1), action))[0] ?? null;
}

/** 读取指定列的写入结果（insert/update 后 .select(cols) 才有返回体） */
export async function write(chain: DbQueryChain, action: string): Promise<Row[]> {
  return unwrap(await chain, action);
}

/**
 * CAS：条件更新/删除后返回真实命中行数，0 表示冲突或已处理。
 * 用法示例（结算）：update(settled_at).eq(id).eq(settled_at, null) —— 命中 1 行才继续派生列重算。
 */
export async function affected(chain: DbQueryChain, action: string): Promise<number> {
  return unwrap(await chain.select('id'), action).length;
}

/** 不关心命中行数的写入 */
export async function mutate(chain: DbQueryChain, action: string): Promise<void> {
  await affected(chain, action);
}

/** 计数：平台不支持 count 聚合，按主键取回后取长度；调用方必须带时间窗与 limit */
export async function count(chain: DbQueryChain, action = 'count'): Promise<number> {
  return unwrap(await chain, action).length;
}

export async function exists(chain: DbQueryChain): Promise<boolean> {
  return (await first(chain)) !== null;
}

export type { DbClient };
