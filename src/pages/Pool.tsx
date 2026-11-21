import { useEffect, useRef, useState } from 'react';
import { Mail, X } from 'lucide-react';
import { Heading, Paper } from '../components';
import type { Props } from './types';

const poolPosts = [
  {
    id: 'one',
    name: '妈妈',
    category: '睡眠',
    text: '希望妈妈每天都能睡个好觉，不用再为小事操心。',
    author: '一位在外读书的人',
  },
  {
    id: 'two',
    name: '室友',
    category: '学业',
    text: '希望室友准备了那么久的考试，能有一个让他开心的结果。',
    author: '同一屋檐下的朋友',
  },
  {
    id: 'three',
    name: '姥姥',
    category: '孤单',
    text: '希望姥姥一个人在家的时候，也总有人陪她说说话。',
    author: '想家的小孩',
  },
  {
    id: 'four',
    name: '爸爸',
    category: '身体',
    text: '希望爸爸下班后别太累，也记得给自己一点休息。',
    author: '不太会表达的人',
  },
  {
    id: 'five',
    name: '闺蜜',
    category: '情绪',
    text: '希望她走过这一小段低落，重新找到自己喜欢的日常。',
    author: '一直在她身边的人',
  },
  {
    id: 'six',
    name: '一个陌生人',
    category: '生活',
    text: '希望每天清晨路过的早餐摊阿姨，今天也有好心情。',
    author: '路过的一份心意',
  },
];
export function Pool({ data, update, notify }: Props) {
  const [filter, setFilter] = useState('全部'),
    [selected, setSelected] = useState<string | null>(null),
    [reply, setReply] = useState('');
  const post = poolPosts.find((p) => p.id === selected);
  return (
    <div className="page">
      <Heading
        eyebrow="WISHES ON THE WATER"
        title="原来，大家都有放在心上的人"
        description="看看水面上的愿签，也给别人的牵挂留一点温柔。"
      />
      <div className="pool-banner">
        <Mail size={36} />
        <p>
          每一封漂来的信，
          <br />
          <strong>都藏着一个被认真惦记的人。</strong>
        </p>
        <span className="tag">示例愿签 · 本地预览</span>
      </div>
      <div className="filters" aria-label="愿望分类">
        {['全部', '身体', '睡眠', '孤单', '学业', '情绪', '生活'].map((c) => (
          <button
            className={filter === c ? 'selected' : ''}
            key={c}
            aria-pressed={filter === c}
            onClick={() => setFilter(c)}
          >
            {c}
          </button>
        ))}
      </div>
      <div className="pool-grid">
        {poolPosts
          .filter((p) => filter === '全部' || p.category === filter)
          .map((p) => (
            <Paper key={p.id}>
              <span className="tag">{p.category}</span>
              <h2>替{p.name}许愿</h2>
              <p>{p.text}</p>
              <div className="pool-author">
                <span>{p.author}</span>
                <Mail size={17} />
              </div>
              <button
                className="secondary full"
                onClick={() => {
                  setSelected(p.id);
                  setReply('');
                }}
              >
                读一读这份心意
              </button>
            </Paper>
          ))}
      </div>
      {post && (
        <PoolDialog title={`替${post.name}许愿`} close={() => setSelected(null)}>
          <p className="letter-text">{post.text}</p>
          <span className="tag">示例内容 · 回信仅保存在本机</span>
          {(data.replies[post.id] || []).map((r, i) => (
            <p className="reply" key={i}>
              {r}
            </p>
          ))}
          <label>
            留一句温柔的话
            <textarea
              maxLength={80}
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              rows={3}
            />
          </label>
          <div className="field-meta">
            <span>不会发送给真实用户</span>
            <span>{reply.length}/80</span>
          </div>
          <button
            className="primary"
            disabled={!reply.trim()}
            onClick={async () => {
              try {
                await update((d) => ({
                  ...d,
                  replies: {
                    ...d.replies,
                    [post.id]: [...(d.replies[post.id] || []), reply.trim()],
                  },
                }));
                setReply('');
                notify('回信已在本机收好。');
              } catch {
                notify('保存失败，请重试。');
              }
            }}
          >
            收好这句话
          </button>
        </PoolDialog>
      )}
    </div>
  );
}
function PoolDialog({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    const element = document.activeElement as HTMLElement;
    return () => element?.focus();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      aria-labelledby="dialog-title"
    >
      <div className="dialog-body">
        <button autoFocus className="icon-button close-dialog" aria-label="关闭" onClick={close}>
          <X />
        </button>
        <h2 id="dialog-title">{title}</h2>
        {children}
      </div>
    </dialog>
  );
}
