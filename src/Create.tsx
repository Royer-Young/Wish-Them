import { useState } from 'react';
import { Check, Feather, RefreshCw, ShieldCheck } from 'lucide-react';
import { createWish, emptyDraft, questions, relations, type AppData, type Draft } from './domain';
import type { Update } from './App';
import { go, Heading, Mascot, Paper, PrivateNote, WishCard } from './components';
export default function Create({
  data,
  update,
  notify,
}: {
  data: AppData;
  update: Update;
  notify: (s: string) => void;
}) {
  const [draft, setDraft] = useState(data.draft),
    [suggestions, setSuggestions] = useState(false),
    [batch, setBatch] = useState(0),
    [agreed, setAgreed] = useState(false),
    [signature, setSignature] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  function change(patch: Partial<Draft>) {
    const next = { ...draft, ...patch };
    setDraft(next);
    void update((d) => ({ ...d, draft: next })).catch(() => setError('草稿未保存，请重试。'));
  }
  const templates = [
    `希望${draft.name}每天都能睡个好觉。`,
    `希望${draft.name}的身体舒服一点，不再被小毛病打扰。`,
    `希望${draft.name}忙碌之余，也能留点时间给自己。`,
    `希望${draft.name}不觉得孤单，想说话的时候有人听。`,
    `希望${draft.name}最近的烦心事，都慢慢有了答案。`,
    `希望${draft.name}每天好好吃饭，平安快乐。`,
  ];
  async function sign() {
    if (!agreed || !signature.trim() || busy) return;
    setBusy(true);
    try {
      const wish = { ...createWish(draft), signature: signature.trim() };
      await update((d) => ({
        ...d,
        wish,
        draft: emptyDraft(),
        checkins: [],
        ledger: [],
        letter: '',
        celebration: false,
      }));
      notify('约定已签下，你的愿签已在本机保存。');
      go('/today');
    } catch {
      setError('约定没有保存，请重试。');
    } finally {
      setBusy(false);
    }
  }
  if (data.wish)
    return (
      <div className="page">
        <Paper className="empty">
          <h1>先照顾好手上的这份心意</h1>
          <p>你已经有一张愿签。可以在“我的”里查看。</p>
          <button className="primary" onClick={() => go('/today')}>
            回到今天的小事
          </button>
        </Paper>
      </div>
    );
  return (
    <div className="page">
      <Heading
        eyebrow="WRITE A LITTLE WISH"
        title="在这里，把牵挂写下来"
        description="不必说得很漂亮，真心就很好。"
      />
      <div className="create-layout">
        <aside className="steps">
          {['想替谁许愿', '写下心愿', '几个小问题', '签下约定'].map((s, i) => (
            <div key={s} className={draft.step === i ? 'current' : ''}>
              <span>{draft.step > i ? <Check size={16} /> : i + 1}</span>
              {s}
            </div>
          ))}
          <p>
            <ShieldCheck size={20} />
            问答仅保存在这台设备，不会出现在愿签池。
          </p>
        </aside>
        <Paper className="editor">
          <span className="eyebrow">
            {
              [
                '一个具体的人，一份具体的牵挂',
                '这句话，只要你自己喜欢',
                '更了解一点，才好靠近一点',
                '让愿望，从小事开始',
              ][draft.step]
            }
          </span>
          {draft.step === 0 && (
            <>
              <h2>你想替谁许个愿？</h2>
              <div className="relations" role="group" aria-label="选择关系">
                {relations.map((r) => (
                  <button
                    key={r}
                    className={draft.relation === r ? 'selected' : ''}
                    aria-pressed={draft.relation === r}
                    onClick={() => change({ relation: r, name: r })}
                  >
                    {r}
                  </button>
                ))}
              </div>
              <label>
                你平时怎么称呼TA？
                <input
                  maxLength={8}
                  value={draft.name}
                  onChange={(e) => change({ name: e.target.value })}
                />
              </label>
              <label>
                TA的代词
                <select value={draft.pronoun} onChange={(e) => change({ pronoun: e.target.value })}>
                  <option>她</option>
                  <option>他</option>
                  <option>TA</option>
                </select>
              </label>
            </>
          )}
          {draft.step === 1 && (
            <>
              <h2>替{draft.name}，许一个小小的愿</h2>
              <label>
                写下你的愿望
                <textarea
                  rows={5}
                  maxLength={120}
                  value={draft.text}
                  onChange={(e) => change({ text: e.target.value, ai: false })}
                  placeholder={`希望${draft.name}……`}
                />
              </label>
              <div className="field-meta">
                <span>具体一点，温柔一点。</span>
                <span>{draft.text.length}/120</span>
              </div>
              <div className="section-label">
                也可以从一句话开始
                <button className="text-button" onClick={() => setBatch(batch ? 0 : 1)}>
                  <RefreshCw size={14} />
                  换一批
                </button>
              </div>
              <div className="template-list">
                {templates.slice(batch * 3, batch * 3 + 3).map((t) => (
                  <button key={t} onClick={() => change({ text: t, ai: false })}>
                    {t}
                  </button>
                ))}
              </div>
              <button className="secondary polish" onClick={() => setSuggestions(!suggestions)}>
                <Feather size={16} />
                帮我找找表达
              </button>
              {suggestions && (
                <div className="suggestions">
                  <p className="muted">离线模板建议 · 当前未连接AI服务，选用后才替换。</p>
                  {[
                    `愿${draft.name}的日子轻松一点，身边总有温柔的陪伴。`,
                    `希望${draft.name}照顾好自己，也把一点时间留给开心。`,
                    `愿每一件小事，都让${draft.name}感到被惦记。`,
                  ].map((t) => (
                    <div key={t}>
                      <p>{t}</p>
                      <button
                        onClick={() => {
                          change({ text: t, ai: false });
                          setSuggestions(false);
                        }}
                      >
                        选用
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          {draft.step === 2 && (
            <>
              <span className="tag">问题 {draft.question + 1} / 5 · 可跳过</span>
              <h2>{questions[draft.question]}</h2>
              <label>
                写一点你愿意说的
                <textarea
                  rows={6}
                  maxLength={300}
                  value={draft.answers[draft.question]}
                  onChange={(e) => {
                    const answers = [...draft.answers];
                    answers[draft.question] = e.target.value;
                    change({ answers });
                  }}
                  placeholder="不想回答也没关系，我们可以跳过。"
                />
              </label>
              <p className="muted">这些话不会出现在公开愿签和分享内容中。</p>
            </>
          )}
          {draft.step === 3 && (
            <>
              <h2>一份小小的约定</h2>
              <p>接下来的七天，为{draft.name}做一点，也好好照顾自己。</p>
              <ul className="contract">
                <li>每天两件必做小事，每件不超过十分钟。</li>
                <li>拍一张照片或截图，把行动留作记录。</li>
                <li>周末有可选的小兼职，量力而行。</li>
                <li>到期后查看结果，完成全部必做才会盖章。</li>
              </ul>
              <label>
                签下你的称呼
                <input
                  value={signature}
                  maxLength={16}
                  onChange={(e) => setSignature(e.target.value)}
                  placeholder="键入名字，同样是一份认真"
                />
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={agreed}
                  onChange={(e) => setAgreed(e.target.checked)}
                />
                我愿意认真完成约定，了解数据只保存在本机。
              </label>
            </>
          )}
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <div className="editor-actions">
            <button
              className="secondary"
              disabled={draft.step === 0 && !draft.question}
              onClick={() =>
                draft.step === 2 && draft.question > 0
                  ? change({ question: draft.question - 1 })
                  : change({ step: draft.step - 1 })
              }
            >
              上一步
            </button>
            {draft.step === 2 && (
              <button
                className="text-button"
                onClick={() =>
                  draft.question < 4
                    ? change({ question: draft.question + 1 })
                    : change({ step: 3 })
                }
              >
                跳过这题
              </button>
            )}
            {draft.step < 3 ? (
              <button
                className="primary"
                disabled={
                  draft.step === 0
                    ? !draft.name.trim()
                    : draft.step === 1
                      ? !draft.text.trim()
                      : false
                }
                onClick={() =>
                  draft.step === 2 && draft.question < 4
                    ? change({ question: draft.question + 1 })
                    : change({ step: draft.step + 1 })
                }
              >
                下一步
              </button>
            ) : (
              <button
                className="primary"
                disabled={!agreed || !signature.trim() || busy}
                onClick={sign}
              >
                {busy ? '正在保存…' : '签下约定'}
              </button>
            )}
          </div>
          <PrivateNote />
        </Paper>
        <aside className="preview">
          <span className="eyebrow">你的愿签预览</span>
          <WishCard
            wish={{
              name: draft.name || 'TA',
              text: draft.text || '你的牵挂，会在这里变成一张愿签。',
              ai: draft.ai,
            }}
          />
          <Mascot small message="说不出口的话，可以慢慢写。" />
        </aside>
      </div>
    </div>
  );
}
