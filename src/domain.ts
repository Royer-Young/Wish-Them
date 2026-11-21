export type TaskKind = 'ta' | 'self' | 'money';
export type Task = { id: string; date: string; kind: TaskKind; title: string };
export type Wish = {
  id: string;
  relation: string;
  name: string;
  pronoun: string;
  text: string;
  category: string;
  answers: string[];
  start: string;
  status: 'active' | 'settled';
  ai: boolean;
  tasks: Task[];
  signature?: string;
  extended?: boolean;
};
export type Checkin = { taskId: string; image: string; note: string; at: string };
export type LedgerEntry = {
  id: string;
  week: string;
  kind: 'budget' | 'expense' | 'income';
  amount: number;
  note: string;
  taskId?: string;
};
export type Draft = {
  step: number;
  question: number;
  relation: string;
  name: string;
  pronoun: string;
  text: string;
  answers: string[];
  ai: boolean;
};
export type AppData = {
  version: 1;
  wish: Wish | null;
  draft: Draft;
  checkins: Checkin[];
  ledger: LedgerEntry[];
  replies: Record<string, string[]>;
  letter: string;
  celebration: boolean;
};
export const relations = [
  '妈妈',
  '爸爸',
  '奶奶',
  '爷爷',
  '姥姥',
  '姥爷',
  '室友',
  '闺蜜',
  '兄弟',
  '恋人',
  '老师',
  '一个陌生人',
];
export const questions = [
  '最近，TA最让你挂念的是什么？',
  'TA平时会不会觉得孤单？',
  '上一次好好聊天，是什么时候？',
  '你每周可以自由安排的零花钱大约有多少？',
  '如果能为TA做一件小事，你想做什么？',
];
export const emptyDraft = (): Draft => ({
  step: 0,
  question: 0,
  relation: '妈妈',
  name: '妈妈',
  pronoun: '她',
  text: '',
  answers: ['', '', '', '', ''],
  ai: false,
});
export const emptyData = (): AppData => ({
  version: 1,
  wish: null,
  draft: emptyDraft(),
  checkins: [],
  ledger: [],
  replies: {},
  letter: '',
  celebration: false,
});
// UTC+8 minus the 04:00 boundary equals UTC+4. Avoid host timezone dependence.
export function productDay(now = new Date()) {
  return new Date(now.getTime() + 4 * 3600000).toISOString().slice(0, 10);
}
export function addDays(day: string, n: number) {
  return new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}
export function weekStart(day: string) {
  const d = new Date(day + 'T00:00:00Z');
  return addDays(day, -((d.getUTCDay() + 6) % 7));
}
export function category(text: string) {
  const groups = [
    ['身体', /疼|腿|腰|血压|体检|吃药/g],
    ['睡眠', /熬夜|失眠|睡|手机/g],
    ['孤单', /一个人|没人说话|冷清|孤单/g],
    ['学业', /考试|论文|考研|学习/g],
    ['情绪', /难过|焦虑|烦|崩溃/g],
  ] as const;
  let best = '生活',
    score = 0;
  for (const [name, re] of groups) {
    const n = (text.match(re) || []).length;
    if (n > score) {
      score = n;
      best = name;
    }
  }
  return best;
}
export function createWish(draft: Draft, now = new Date()): Wish {
  if (
    !draft.name.trim() ||
    draft.name.trim().length > 8 ||
    ['自己', '我', '本人'].includes(draft.name.trim())
  )
    throw new Error('请替一个具体的人许愿，称呼最多8字。');
  if (!draft.text.trim() || draft.text.length > 120) throw new Error('愿望需要1至120字。');
  const start = productDay(now),
    id = crypto.randomUUID();
  const forTA = [
    '给{TA}打个电话，问问今天过得怎么样',
    '把今天的一张照片发给{TA}，配上一句话',
    '认真听{TA}讲一件最近的小事',
    '给{TA}发一句具体的感谢',
    '和{TA}约一次有空的聊天',
    '问问{TA}最近有没有好好吃饭',
    '给{TA}写一段不催促的关心',
  ];
  const self = [
    '今晚早点放下手机，给自己留一点休息时间',
    '好好吃一顿饭，拍下今天的餐盘',
    '出门散步十分钟，看看路边的树',
    '收拾书桌的一角，留出一块空白',
    '喝一杯温水，给忙碌按下暂停',
    '睡前读两页喜欢的书',
    '写下今天一件值得开心的小事',
  ];
  const tasks: Task[] = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(start, i);
    tasks.push(
      { id: `${id}-${i}-ta`, date, kind: 'ta', title: forTA[i].replace('{TA}', draft.name.trim()) },
      { id: `${id}-${i}-self`, date, kind: 'self', title: self[i] },
    );
    const dow = new Date(date + 'T00:00:00Z').getUTCDay();
    if (dow === 0 || dow === 6)
      tasks.push({
        id: `${id}-${i}-money`,
        date,
        kind: 'money',
        title: '做一件力所能及的小兼职，记录一次真实收入',
      });
  }
  return {
    id,
    relation: draft.relation,
    name: draft.name.trim(),
    pronoun: draft.pronoun,
    text: draft.text.trim(),
    ai: draft.ai,
    category: category(draft.text),
    answers: [...draft.answers],
    start,
    status: 'active',
    tasks,
  };
}
export function totals(entries: LedgerEntry[]) {
  const weeks = [...new Set(entries.map((e) => e.week))];
  const saved = weeks.reduce((sum, week) => {
    const rows = entries.filter((e) => e.week === week);
    return (
      sum +
      Math.max(
        0,
        rows.filter((e) => e.kind === 'budget').reduce((s, e) => s + e.amount, 0) -
          rows.filter((e) => e.kind === 'expense').reduce((s, e) => s + e.amount, 0),
      )
    );
  }, 0);
  const earned = entries.filter((e) => e.kind === 'income').reduce((s, e) => s + e.amount, 0);
  return { saved, earned, total: saved + earned };
}
export function settlement(data: AppData, now = new Date()) {
  const w = data.wish;
  if (!w) return { due: false, complete: false, outcome: 'unfinished' as const };
  const due = productDay(now) > w.tasks[w.tasks.length - 1].date;
  const complete = w.tasks
    .filter((t) => t.kind !== 'money')
    .every((t) => data.checkins.some((c) => c.taskId === t.id));
  return {
    due,
    complete,
    outcome: !complete
      ? ('unfinished' as const)
      : totals(data.ledger).total >= 120
        ? ('full' as const)
        : ('cyber' as const),
  };
}
export function demoData(outcome: 'full' | 'cyber' | 'unfinished' = 'full'): AppData {
  const d = emptyData();
  const draft = { ...emptyDraft(), text: '希望妈妈的腿不再疼，每天都能轻轻松松地散步。' };
  d.wish = createWish(draft, new Date(Date.now() - 8 * 86400000));
  d.checkins = d.wish.tasks
    .filter((t) => outcome !== 'unfinished' || t.id !== d.wish!.tasks[0].id)
    .map((t) => ({
      taskId: t.id,
      image: '/assets/postoffice.png',
      note: '今天也把心意变成了一件小事。',
      at: t.date,
    }));
  if (outcome === 'full')
    d.ledger = [
      {
        id: 'demo-budget',
        week: weekStart(d.wish.start),
        kind: 'budget',
        amount: 80,
        note: '本周预算',
      },
      {
        id: 'demo-expense',
        week: weekStart(d.wish.start),
        kind: 'expense',
        amount: 32,
        note: '非必要支出',
      },
      {
        id: 'demo-income',
        week: weekStart(d.wish.start),
        kind: 'income',
        amount: 120,
        note: '周末线上答疑',
        taskId: d.wish.tasks.find((t) => t.kind === 'money')?.id,
      },
    ];
  return d;
}
