import { useEffect, useState } from 'react';
import { LockKeyhole } from 'lucide-react';
import { settlement, totals } from '../domain';
import { go, Heading, Mascot, Paper, WishCard } from '../components';
import NoWish from './NoWish';
import type { Props } from './types';

export function Settle({ data, update, notify, isDemo }: Props) {
  const result = settlement(data),
    [act, setAct] = useState(1),
    [letter, setLetter] = useState(
      data.letter ||
        `亲爱的${data.wish?.name || 'TA'}：\n有些关心一直没好好说出口。最近我做了一些小事，也慢慢学着照顾自己。愿你知道，你一直被认真惦记着。`,
    ),
    [busy, setBusy] = useState(false);
  const t = totals(data.ledger);
  useEffect(() => {
    setAct(1);
  }, [data.wish?.id]);
  if (!data.wish)
    return (
      <div className="page">
        <NoWish />
      </div>
    );
  if (!result.due)
    return (
      <div className="page">
        <Paper className="empty">
          <LockKeyhole size={36} />
          <h1>这份心意，还在慢慢生长</h1>
          <p>约定到期后，邮局会为你打开结果。</p>
          <button className="primary" onClick={() => go('/today')}>
            去做今天的小事
          </button>
        </Paper>
      </div>
    );
  return (
    <div className="page">
      <Heading
        eyebrow={act === 1 ? 'A PROMISE, CAREFULLY KEPT' : 'FROM A WISH TO SOMETHING REAL'}
        title={
          act === 1
            ? result.complete
              ? '你把一句祝愿，做成了小事'
              : '未完成的小事，也会留在这里'
            : '原来，心意已经攒了这么多'
        }
        description={
          act === 1 ? '先看看这些日子里，你认真做过的事。' : '接下来的一步，可以走到现实里。'
        }
      />
      <div className="settle-layout">
        <WishCard wish={data.wish} />
        <Paper className="settle-paper">
          {act === 1 ? (
            <>
              <div className={`stamp ${result.complete ? '' : 'unfinished'}`}>
                {result.complete ? '已还愿' : '待续的心意'}
              </div>
              <h2>{result.complete ? '这份约定，你做到了。' : '不用急着给自己一个结论。'}</h2>
              <p>
                为TA与为自己的小事，记录了{' '}
                {
                  data.wish.tasks.filter(
                    (t) => t.kind !== 'money' && data.checkins.some((c) => c.taskId === t.id),
                  ).length
                }{' '}
                件。
              </p>
              {!result.complete && <p>还有未完成的必做任务。本次不会盖“已还愿”印章。</p>}
              <button className="primary" onClick={() => setAct(2)}>
                继续，打开问号抽屉
              </button>
            </>
          ) : (
            <>
              <span className="eyebrow">你的心意账本</span>
              <div className="settle-sum">
                <span>省下 ¥{t.saved}</span>
                <span>＋ 挣到 ¥{t.earned}</span>
                <strong>¥{t.total}</strong>
              </div>
              <h2>
                {result.outcome === 'full'
                  ? '一次体贴的小礼物，或许已经不远了'
                  : result.outcome === 'cyber'
                    ? '你的愿望已在这里实现，还有一封未拆的信'
                    : '把未完成的心意，慢慢接着做'}
              </h2>
              {result.outcome === 'full' && (
                <p>
                  可以了解一份120元起的健康关怀用品。金额仅为参考，先问问TA的需要，再决定是否购买。
                </p>
              )}
              <label>
                写给TA的信
                <textarea
                  rows={7}
                  maxLength={1000}
                  value={letter}
                  onChange={(e) => setLetter(e.target.value)}
                />
              </label>
              <button
                className="primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await update((d) => ({
                      ...d,
                      letter,
                      wish: d.wish ? { ...d.wish, status: 'settled' } : null,
                    }));
                    notify('信和这份心意，都已保存在本机。');
                  } catch {
                    notify('保存失败，请重试。');
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                保存心意
              </button>
              <button className="text-button" onClick={() => setAct(1)}>
                再看一次约定
              </button>
              {isDemo && <p className="muted">演示中的结果不会改变你的真实愿签。</p>}
            </>
          )}
        </Paper>
        <Mascot
          message={
            act === 1 ? '每一件认真做过的小事，我都记得。' : '这封信，终于可以交到你手上啦。'
          }
        />
      </div>
    </div>
  );
}
