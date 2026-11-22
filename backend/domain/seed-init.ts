/**
 * 服务端启动播种：平台批量写工具不可用时，由 Function 自己的 DB 客户端幂等补齐三张模板表。
 *
 * 触发条件是显式环境变量 SEED_ON_START=1，默认关闭；只在实例首个请求执行一次。
 * 幂等靠 seed 行的稳定 id + insertIfAbsent(onConflict: 'id')：
 *   - 已有行直接跳过，重复执行/多实例并发都不会产生副本；
 *   - 表被部分写入时只补缺失行，不覆盖已有内容；
 *   - 表行数已等于期望值时不发起任何写请求。
 * 种子数据在 backend/data/seed-rows.ts（由 tools/scripts/build-seeds.ts 生成），
 * 因为 Function 发布包只带 backend/，运行期读不到 database/seed/*.json。
 */
import { SEED_TABLES, type SeedRow, type SeedTable } from '../data/seed-rows.ts';
import { count, write } from '../lib/db.ts';
import type { DbClient } from '../lib/types.ts';

const BATCH_SIZE = 40;

export type SeedStatus = 'disabled' | 'idle' | 'running' | 'ok' | 'skipped' | 'error';

export interface SeedTableState {
  expected: number;
  existing: number;
  inserted: number;
  final: number;
}

export interface SeedSnapshot {
  enabled: boolean;
  status: SeedStatus;
  startedAt?: string;
  finishedAt?: string;
  failedTable?: string;
  /** 只给机器码，不回显底层数据库报错；原始错误由 server.ts 写日志 */
  error?: 'seed_failed';
  tables: Record<string, SeedTableState>;
}

const EXPECTED: Record<SeedTable['table'], number> = {
  wish_templates: 72,
  task_templates: 120,
  rewards: 24,
};

let state: SeedSnapshot = { enabled: false, status: 'disabled', tables: {} };

/** createApp 在 SEED_ON_START=1 时调用，让健康探针能区分「未开启」与「等待首个请求」 */
export function markSeedEnabled(): void {
  state = { enabled: true, status: 'idle', tables: {} };
}

export function seedSnapshot(): SeedSnapshot {
  const tables: Record<string, SeedTableState> = {};
  for (const [name, value] of Object.entries(state.tables)) tables[name] = { ...value };
  return { ...state, tables };
}

/** 数据形状在发布前已由 build-seeds 断言；这里再挡住打包截断/字段集漂移，避免线上逐行失败 */
function validateCatalog(): void {
  const ids = new Set<string>();
  for (const table of SEED_TABLES) {
    if (table.expected !== EXPECTED[table.table] || table.rows.length !== table.expected) {
      throw new Error(`seed ${table.table} 行数不符：expected=${table.expected}, rows=${table.rows.length}`);
    }
    const keys = Object.keys(table.rows[0] ?? {}).sort().join(',');
    for (const row of table.rows) {
      if (Object.keys(row).sort().join(',') !== keys) {
        throw new Error(`seed ${table.table} 字段集不一致`);
      }
      const id = row.id;
      if (typeof id !== 'string' || id.length !== 36 || !/^[0-9a-f-]{36}$/.test(id)) {
        throw new Error(`seed ${table.table} 存在非法 id`);
      }
      if (ids.has(id)) throw new Error(`seed id 重复：${id}`);
      ids.add(id);
      if (row.is_active !== true) throw new Error(`seed ${table.table} 存在 is_active != true 的行`);
    }
  }
}

async function tableCount(db: DbClient, table: SeedTable['table'], expected: number): Promise<number> {
  // 多取 1 行即可判断「已达到或超过期望值」；不需要扫全表
  return count(db.from(table).select('id').limit(expected + 1), `count ${table}`);
}

async function insertRows(db: DbClient, table: SeedTable['table'], rows: SeedRow[]): Promise<number> {
  let inserted = 0;
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);
    const written = await write(
      db.from(table).insertIfAbsent(batch, { onConflict: 'id' }).select('id'),
      `seed ${table}`,
    );
    inserted += written.length;
  }
  return inserted;
}

/**
 * 幂等补齐三张模板表。只由 server.ts 在 SEED_ON_START=1 时调用；
 * 失败时抛错交给 server 记录，健康探针只暴露 seed_failed，不泄露 SQL/约束名。
 */
export async function ensureSeeded(db: DbClient): Promise<void> {
  state = { enabled: true, status: 'running', startedAt: new Date().toISOString(), tables: {} };
  let currentTable: SeedTable['table'] | undefined;
  try {
    validateCatalog();
    let insertedTotal = 0;
    for (const table of SEED_TABLES) {
      currentTable = table.table;
      const existing = await tableCount(db, table.table, table.expected);
      if (existing > table.expected) {
        throw new Error(`seed ${table.table} 已有 ${existing} 行，超过期望 ${table.expected}，拒绝继续写入`);
      }
      const inserted = existing === table.expected ? 0 : await insertRows(db, table.table, table.rows);
      const final = await tableCount(db, table.table, table.expected);
      state.tables[table.table] = { expected: table.expected, existing, inserted, final };
      if (final !== table.expected) {
        throw new Error(`seed ${table.table} 最终 ${final} 行，期望 ${table.expected}`);
      }
      insertedTotal += inserted;
    }
    state.status = insertedTotal === 0 ? 'skipped' : 'ok';
    state.finishedAt = new Date().toISOString();
    currentTable = undefined;
  } catch (error) {
    state.status = 'error';
    state.error = 'seed_failed';
    state.failedTable = currentTable;
    state.finishedAt = new Date().toISOString();
    throw error;
  }
}