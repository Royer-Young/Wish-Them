import { useState } from 'react';
import { Plus, BookOpen, X } from 'lucide-react';
import { productDay, totals, weekStart, type LedgerEntry } from '../domain';
import { Heading, Paper } from '../components';
import NoWish from './NoWish';
import type { Props } from './types';

export function Ledger({ data, update, notify }: Props) {
  const [kind, setKind] = useState<LedgerEntry['kind']>('expense'),
    [amount, setAmount] = useState(''),
    [note, setNote] = useState(''),
    [taskId, setTaskId] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const t = totals(data.ledger),
    week = weekStart(productDay());
  const moneyTasks =
    data.wish?.tasks.filter(
      (t) => t.kind === 'money' && data.checkins.some((c) => c.taskId === t.id),
    ) || [];
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = Number(amount);
    if (!amount || !Number.isFinite(n) || n < 0 || n > 100000 || (kind === 'income' && !taskId)) {
      setError('请填写0至100000之间的金额；收入需关联已记录的钱任务。');
      return;
    }
    setBusy(true);
    try {
      const row: LedgerEntry = {
        id: crypto.randomUUID(),
        week,
        kind,
        amount: Math.round(n),
        note:
          note.trim() ||
          (kind === 'budget' ? '本周预算' : kind === 'income' ? '兼职收入' : '非必要支出'),
        taskId: kind === 'income' ? taskId : undefined,
      };
      await update((d) => ({
        ...d,
        ledger: [
          ...d.ledger.filter((x) => !(kind === 'budget' && x.kind === 'budget' && x.week === week)),
          row,
        ],
      }));
      setAmount('');
      setNote('');
      setError('');
      notify('这一笔，已记到账本。');
    } catch {
      setError('账目没有保存，请重试。');
    } finally {
      setBusy(false);
    }
  }
  if (!data.wish)
    return (
      <div className="page">
        <NoWish />
      </div>
    );
  return (
    <div className="page">
      <Heading
        eyebrow="SMALL CHANGE, REAL CARE"
        title="把一点一滴，记成心意"
        description="真实的金额，不必很多。量力而行，已经足够。"
      />
      <div className="ledger-summary">
        <Paper>
          <span>累计省下</span>
          <strong>¥{t.saved}</strong>
        </Paper>
        <Paper>
          <span>累计挣到</span>
          <strong>¥{t.earned}</strong>
        </Paper>
        <Paper className="total">
          <span>累计心意</span>
          <strong>¥{t.total}</strong>
        </Paper>
      </div>
      <div className="two-column">
        <Paper>
          <div className="section-label">
            <h2>我的账页</h2>
            <span className="tag">按自然周记录</span>
          </div>
          <p className="muted">每周省下 = 预算 − 非必要支出，最低为0元。</p>
          {data.ledger.length ? (
            [...new Set(data.ledger.map((e) => e.week))]
              .sort()
              .reverse()
              .map((w) => (
                <div key={w} className="ledger-week">
                  <h3>{w} 起的一周</h3>
                  {data.ledger
                    .filter((e) => e.week === w)
                    .map((e) => (
                      <div className="ledger-row" key={e.id}>
                        <div>
                          <strong>{e.note}</strong>
                          <span>
                            {e.kind === 'budget'
                              ? '周预算'
                              : e.kind === 'expense'
                                ? '非必要支出'
                                : '兼职收入'}
                          </span>
                        </div>
                        <b>¥{e.amount}</b>
                        <button
                          className="icon-button"
                          aria-label={`删除${e.note}`}
                          onClick={() => {
                            if (window.confirm('删除这笔账目？'))
                              void update((d) => ({
                                ...d,
                                ledger: d.ledger.filter((x) => x.id !== e.id),
                              })).catch(() => notify('删除失败，请重试。'));
                          }}
                        >
                          <X size={16} />
                        </button>
                      </div>
                    ))}
                </div>
              ))
          ) : (
            <div className="empty">
              <BookOpen size={36} />
              <h3>账本的第一页，留给今天</h3>
              <p>先设一个周预算，再记录真实支出。</p>
            </div>
          )}
        </Paper>
        <Paper>
          <h2>记下一笔</h2>
          <form onSubmit={submit}>
            <label>
              记账类型
              <select value={kind} onChange={(e) => setKind(e.target.value as LedgerEntry['kind'])}>
                <option value="expense">非必要支出</option>
                <option value="budget">设置本周预算</option>
                <option value="income">兼职收入</option>
              </select>
            </label>
            <label>
              金额（元，取整）
              <input
                required
                type="number"
                min="0"
                max="100000"
                step="any"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
            <label>
              记一点说明
              <input
                maxLength={30}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="例如：本周少喝两杯奶茶"
              />
            </label>
            {kind === 'income' && (
              <label>
                关联已完成的钱任务
                <select required value={taskId} onChange={(e) => setTaskId(e.target.value)}>
                  <option value="">请选择</option>
                  {moneyTasks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.date} · {t.title}
                    </option>
                  ))}
                </select>
                <small>先在今日页完成周末钱任务并上传佐证。</small>
              </label>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <button className="primary full" disabled={busy}>
              <Plus size={17} />
              {busy ? '正在记账…' : '记到账本'}
            </button>
          </form>
          <div className="drawer inline">
            <span>?</span>
            <p>
              这份积累会去向哪里？
              <br />
              约定到期，再一起打开。
            </p>
          </div>
        </Paper>
      </div>
    </div>
  );
}
