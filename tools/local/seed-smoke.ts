/**
 * 启动播种的本地验证（不连云端）：
 *   node tools/local/seed-smoke.ts
 *
 * 覆盖：空库首次播种 72/120/24、重复执行不写、部分缺失只补缺、状态快照。
 * 线上仍要查询真实行数；这里验证的是幂等分支与打包后的 seed 数据完整性。
 */
import { ensureSeeded, markSeedEnabled, seedSnapshot } from '../../backend/domain/seed-init.ts';
import { SEED_TABLES } from '../../backend/data/seed-rows.ts';
import { count } from '../../backend/lib/db.ts';
import { FakeDb } from './fake-db.ts';

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
    return;
  }
  failures.push(name);
  console.log(`  FAIL ${name}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
}

async function rowsOf(db: FakeDb, table: string): Promise<number> {
  return count(db.from(table).select('id').limit(500), `count ${table}`);
}

// 1. 空库：三张表一次补齐
{
  markSeedEnabled();
  const db = new FakeDb();
  await ensureSeeded(db);
  const snapshot = seedSnapshot();
  check('空库播种后状态 ok', snapshot.status === 'ok', snapshot);
  check('wish_templates = 72', await rowsOf(db, 'wish_templates') === 72);
  check('task_templates = 120', await rowsOf(db, 'task_templates') === 120);
  check('rewards = 24', await rowsOf(db, 'rewards') === 24);
  check(
    '快照记录三张表的 existing/inserted/final',
    snapshot.tables.wish_templates?.inserted === 72
      && snapshot.tables.task_templates?.inserted === 120
      && snapshot.tables.rewards?.inserted === 24
      && snapshot.tables.rewards?.final === 24,
    snapshot.tables,
  );
}

// 2. 重复执行：行数已齐，直接 skipped，不再发起写
{
  markSeedEnabled();
  const db = new FakeDb();
  await ensureSeeded(db);
  const first = seedSnapshot();
  await ensureSeeded(db);
  const second = seedSnapshot();
  check('首次 ok', first.status === 'ok');
  check('二次 skipped', second.status === 'skipped', second);
  check(
    '二次三张表 inserted 均为 0',
    second.tables.wish_templates?.inserted === 0
      && second.tables.task_templates?.inserted === 0
      && second.tables.rewards?.inserted === 0,
    second.tables,
  );
  check('二次行数不增长', await rowsOf(db, 'wish_templates') === 72 && await rowsOf(db, 'task_templates') === 120);
}

// 3. 部分缺失：只补缺，不覆盖已有行
{
  markSeedEnabled();
  const db = new FakeDb();
  const wishes = SEED_TABLES.find((table) => table.table === 'wish_templates');
  if (!wishes) throw new Error('seed 缺少 wish_templates');
  db.seed('wish_templates', wishes.rows.slice(0, 71));
  await ensureSeeded(db);
  const snapshot = seedSnapshot();
  check('部分缺失播种后仍为 ok', snapshot.status === 'ok', snapshot);
  check('已有 71 行时只补 1 行', snapshot.tables.wish_templates?.existing === 71 && snapshot.tables.wish_templates?.inserted === 1, snapshot.tables.wish_templates);
  check('补齐后 wish_templates = 72', await rowsOf(db, 'wish_templates') === 72);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
}