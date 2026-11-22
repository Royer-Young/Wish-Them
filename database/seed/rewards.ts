/**
 * 礼物目录内容表（PRD 5.4）：24 件，四类 health / company / life / heart。
 *
 * 价格给区间不给单值，单位是分；区间在结算前对用户不可见（读出接口按状态过滤）。
 * forTypes 展开成 rewards.recommend_flags，供第 5 轮结算匹配时前置推荐。
 * 本轮只做展示与计数，不扣库存（stock_left 恒为 null = 不限）。
 */
import type { GiftCategory, WishType } from '../../domain/rules.ts';

export interface RewardSeed {
  category: GiftCategory;
  title: string;
  minCents: number;
  maxCents: number;
  note: string;
  /** 匹配时优先推荐（结算页前置展示） */
  forTypes?: WishType[];
}

export const REWARDS: RewardSeed[] = [
  // 健康（7 件，对应身体/睡眠类愿望）
  { category: 'health', title: '护膝热敷仪', minCents: 12000, maxCents: 18000, note: '「妈妈的腿疼」这类愿望的默认兑现', forTypes: ['body'] },
  { category: 'health', title: '助眠枕', minCents: 8000, maxCents: 20000, note: '睡眠类愿望优先', forTypes: ['sleep'] },
  { category: 'health', title: '艾草贴 / 泡脚包', minCents: 6000, maxCents: 12000, note: '差额不够时加的一件', forTypes: ['body', 'sleep'] },
  { category: 'health', title: '电子血压计', minCents: 15000, maxCents: 26000, note: '需要 TA 自己会操作', forTypes: ['body'] },
  { category: 'health', title: '按摩披肩', minCents: 15000, maxCents: 30000, note: '久坐、腰肩不适', forTypes: ['body'] },
  { category: 'health', title: '体检加项券', minCents: 20000, maxCents: 40000, note: '「陪 TA 体检」任务完成后才推荐', forTypes: ['body'] },
  { category: 'health', title: '防滑拖鞋', minCents: 5000, maxCents: 9000, note: '独居长辈的低成本高安全', forTypes: ['body', 'life'] },

  // 陪伴（6 件，对应孤单类愿望）
  { category: 'company', title: '往返学校与家的车票', minCents: 8000, maxCents: 50000, note: '孤单类首选，价格随距离浮动大', forTypes: ['lonely'] },
  { category: 'company', title: '一次周末回家的饭钱', minCents: 10000, maxCents: 20000, note: '「这个周末，回去一趟」的由头', forTypes: ['lonely', 'emotion'] },
  { category: 'company', title: '两个人一起看的电影票', minCents: 6000, maxCents: 12000, note: '同城可用', forTypes: ['lonely', 'emotion'] },
  { category: 'company', title: '一通长途话费充值', minCents: 5000, maxCents: 10000, note: '异地最便宜的一件', forTypes: ['lonely'] },
  { category: 'company', title: '陪诊半天的打车费', minCents: 5000, maxCents: 15000, note: '陪 TA 就医时匹配', forTypes: ['body', 'lonely'] },
  { category: 'company', title: '一次短途同行的车票', minCents: 15000, maxCents: 40000, note: '超出目标价时的「加一档」', forTypes: ['lonely'] },

  // 生活（6 件，对应生活/睡眠类愿望）
  { category: 'life', title: '一双软底鞋', minCents: 15000, maxCents: 30000, note: '每天要走很多路的人', forTypes: ['body', 'life'] },
  { category: 'life', title: '护眼灯 / 老花镜', minCents: 8000, maxCents: 20000, note: '熬夜学习或看不清小字', forTypes: ['sleep', 'study', 'life'] },
  { category: 'life', title: '带滤网的保温杯', minCents: 6000, maxCents: 12000, note: '小额，适合补齐差额', forTypes: ['life'] },
  { category: 'life', title: '一次家电维修或更换', minCents: 8000, maxCents: 20000, note: '对应「TA 家那个坏掉的东西」', forTypes: ['life'] },
  { category: 'life', title: '一周买菜基金', minCents: 10000, maxCents: 20000, note: '独居长辈或自己做饭的室友', forTypes: ['life', 'lonely'] },
  { category: 'life', title: '暖光小夜灯', minCents: 5000, maxCents: 10000, note: '夜里醒的人不用摸黑', forTypes: ['sleep', 'lonely'] },

  // 心意（5 件，对应情绪/学业类愿望）
  { category: 'heart', title: '手写信 + 相册冲印', minCents: 4000, maxCents: 9000, note: '「再加一封信」的默认项', forTypes: ['emotion', 'lonely'] },
  { category: 'heart', title: '一顿火锅', minCents: 10000, maxCents: 20000, note: '情绪类愿望常见兑现', forTypes: ['emotion', 'study'] },
  { category: 'heart', title: '一次线下的感谢（茶点）', minCents: 6000, maxCents: 15000, note: '给老师或帮过自己的人', forTypes: ['study', 'emotion'] },
  { category: 'heart', title: '一本 TA 提过的书', minCents: 4000, maxCents: 9000, note: '小额心意，容易凑够', forTypes: ['study', 'emotion'] },
  { category: 'heart', title: '一张合影的放大打印', minCents: 4000, maxCents: 8000, note: '账本截图之外的第一份实物', forTypes: ['emotion', 'lonely'] },
];