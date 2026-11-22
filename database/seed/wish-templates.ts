/**
 * 愿望模板内容表（PRD 5.1 / B-03）：12 关系 × 6 条 = 72 条。
 *
 * 这里是「数据」不是「逻辑」：由 tools/scripts/build-seeds.ts 展开成 wish_templates.json。
 * 直接改 JSON 会被下次生成覆盖，要改就改这个文件。
 *
 * 数量口径（与需求书的偏差已记录在 database/seed/README.md）：
 * 需求写「共 40 条，每关系 4~6 条」，但 12 × 4~6 最少也有 48 条，40 条无法同时满足；
 * PRD 5.1 另要求「同关系至少 6 条」，因此取 12 × 6 = 72，覆盖六类愿望各一条。
 *
 * 词表不在这里重复定义：关系统一来自 domain/rules.ts，避免代码与 seed 两套枚举漂移。
 */
import type { Relation, WishType } from '../../domain/rules.ts';

export interface WishTemplateSeed {
  relation: Relation;
  wishType: WishType;
  /** 第一人称「我想…」，15~60 字 */
  text: string;
}

export const WISH_TEMPLATES: WishTemplateSeed[] = [
  // 亲子：语气亲近、克制、具体（PRD 5.1），倾向身体/睡眠/陪伴
  { relation: '妈妈', wishType: 'body', text: '妈妈的腰疼能轻一点，晚上睡得沉一些。' },
  { relation: '妈妈', wishType: 'sleep', text: '妈妈别再熬到一点刷手机，十一点前熄灯。' },
  { relation: '妈妈', wishType: 'lonely', text: '妈妈白天一个人说话太少，我想让她每天都有人聊几句。' },
  { relation: '妈妈', wishType: 'study', text: '妈妈想考那个上岗证，一直没时间看书。' },
  { relation: '妈妈', wishType: 'emotion', text: '妈妈最近总叹气，我希望她能笑一次是因为自己。' },
  { relation: '妈妈', wishType: 'life', text: '妈妈做饭总在剩菜里对付，我想让她好好吃一顿。' },

  { relation: '爸爸', wishType: 'body', text: '爸爸的血压能稳一点，别再疼着还去跑工地。' },
  { relation: '爸爸', wishType: 'sleep', text: '爸爸值完夜班能睡足八小时。' },
  { relation: '爸爸', wishType: 'lonely', text: '爸爸的朋友越来越少，我想让他有人一起下棋。' },
  { relation: '爸爸', wishType: 'emotion', text: '爸爸从不说自己累，我希望他偶尔能软一次。' },
  { relation: '爸爸', wishType: 'life', text: '爸爸那辆骑了八年的电动车，刹车该换了。' },
  { relation: '爸爸', wishType: 'study', text: '爸爸想学会用导航软件，别再嘴上说“看路牌就行”。' },

  { relation: '奶奶', wishType: 'body', text: '奶奶的膝盖暖和一点，上下楼不用扶着墙。' },
  { relation: '奶奶', wishType: 'lonely', text: '奶奶每天就在阳台坐一天，我想让她有人陪说话。' },
  { relation: '奶奶', wishType: 'sleep', text: '奶奶夜里醒四五次，能睡个整觉。' },
  { relation: '奶奶', wishType: 'emotion', text: '奶奶总怕自己成了负担，我想让她知道她不是。' },
  { relation: '奶奶', wishType: 'life', text: '奶奶的放大镜旧了，她想自己看药盒上的小字。' },
  { relation: '奶奶', wishType: 'study', text: '奶奶想学会视频通话，看清外地的孙子。' },

  { relation: '爷爷', wishType: 'body', text: '爷爷的耳朵没那么背，听清我们说话。' },
  { relation: '爷爷', wishType: 'lonely', text: '爷爷下棋没有对手，我想给他找个能聊天的老伙计。' },
  { relation: '爷爷', wishType: 'emotion', text: '爷爷把想念都藏在沉默里，我希望他愿意讲出来。' },
  { relation: '爷爷', wishType: 'life', text: '爷爷的茶杯该换个带滤网的，他总把茶叶喝进嘴里。' },
  { relation: '爷爷', wishType: 'sleep', text: '爷爷午睡总在半下午，晚上反而睡不着。' },
  { relation: '爷爷', wishType: 'study', text: '爷爷想学会用手机听戏，别再抱着那台收音机。' },

  { relation: '姥姥', wishType: 'body', text: '姥姥的腿疼能轻一些，别再一个人在家扛着。' },
  { relation: '姥姥', wishType: 'lonely', text: '姥姥一个人住在老房子，我想让她一周至少热闹一天。' },
  { relation: '姥姥', wishType: 'emotion', text: '姥姥总说“我没事”，我希望她真的有没事的一天。' },
  { relation: '姥姥', wishType: 'life', text: '姥姥买菜要爬四楼，我想让她少爬几次。' },
  { relation: '姥姥', wishType: 'sleep', text: '姥姥夜里一个人，睡不踏实。' },
  { relation: '姥姥', wishType: 'study', text: '姥姥想学会看天气，别再每天问我三遍。' },

  { relation: '姥爷', wishType: 'body', text: '姥爷的腰能撑住他每天去河边坐着钓鱼。' },
  { relation: '姥爷', wishType: 'lonely', text: '姥爷的话都对着鱼说，我想给他找点人说话的事。' },
  { relation: '姥爷', wishType: 'emotion', text: '姥爷逞强一辈子，我希望他接受一次照顾。' },
  { relation: '姥爷', wishType: 'life', text: '姥爷的老花镜裂了还戴着，我想让他看清报纸。' },
  { relation: '姥爷', wishType: 'sleep', text: '姥爷凌晨四点就起床，晚上根本睡不着。' },
  { relation: '姥爷', wishType: 'study', text: '姥爷想学会给自己拍照，别再只拍别人。' },

  // 平辈：直接、可开玩笑，倾向学业/情绪/生活
  { relation: '室友', wishType: 'study', text: '室友考研压力大，希望能顺利上岸。' },
  { relation: '室友', wishType: 'emotion', text: '室友最近天天失眠，白天还得强撑着上课。' },
  { relation: '室友', wishType: 'life', text: '室友的桌面永远乱成一团，我想看他收拾干净一次。' },
  { relation: '室友', wishType: 'sleep', text: '室友熬夜打游戏到三点，希望他能睡个早觉。' },
  { relation: '室友', wishType: 'body', text: '室友久坐腰疼，还说不就是坐着嘛。' },
  { relation: '室友', wishType: 'lonely', text: '室友说自己“习惯了没人”，其实是不敢说。' },

  { relation: '闺蜜', wishType: 'emotion', text: '闺蜜分手后一直在笑，我想让她有一次能哭出来。' },
  { relation: '闺蜜', wishType: 'study', text: '闺蜜投了四十份简历，希望下一个面试就是她。' },
  { relation: '闺蜜', wishType: 'body', text: '闺蜜痛经到吃止疼片，希望她能舒服一点。' },
  { relation: '闺蜜', wishType: 'life', text: '闺蜜总是照顾别人，我想让她被照顾一次。' },
  { relation: '闺蜜', wishType: 'sleep', text: '闺蜜焦虑到凌晨还在刷手机。' },
  { relation: '闺蜜', wishType: 'lonely', text: '闺蜜换了城市，一个新朋友都没有。' },

  { relation: '兄弟', wishType: 'emotion', text: '兄弟失恋了嘴上说没事，我知道他有事。' },
  { relation: '兄弟', wishType: 'body', text: '兄弟健身把肩练伤了，还不肯去看。' },
  { relation: '兄弟', wishType: 'study', text: '兄弟要考公，一个人复习太枯燥。' },
  { relation: '兄弟', wishType: 'life', text: '兄弟天天吃泡面，我想看他正经吃顿饭。' },
  { relation: '兄弟', wishType: 'lonely', text: '兄弟说“兄弟不需要人陪”，这句话最让人担心。' },
  { relation: '兄弟', wishType: 'sleep', text: '兄弟通宵赶作业，白天睡不醒。' },

  // 亲密：情绪、陪伴
  { relation: '恋人', wishType: 'emotion', text: '她最近情绪很低，我想让她知道我在。' },
  { relation: '恋人', wishType: 'lonely', text: '异地恋，我希望 ta 一个人吃饭的时候别觉得孤单。' },
  { relation: '恋人', wishType: 'sleep', text: '他加班到十二点，希望他每天能睡够七小时。' },
  { relation: '恋人', wishType: 'body', text: '她总说胃不疼，其实是每天都疼。' },
  { relation: '恋人', wishType: 'study', text: 'ta 想申请交换生，一直不敢投那份材料。' },
  { relation: '恋人', wishType: 'life', text: '我们总点外卖，我想和 ta 一起做一顿饭。' },

  // 师长：礼貌、有分寸，倾向学业/感谢
  { relation: '老师', wishType: 'body', text: '老师一直站着讲课，希望他的嗓子能好一点。' },
  { relation: '老师', wishType: 'emotion', text: '老师说带完这届就休整一年，我希望他别硬撑。' },
  { relation: '老师', wishType: 'study', text: '老师想带的课题缺人手，希望顺利批下来。' },
  { relation: '老师', wishType: 'life', text: '老师办公桌的抽屉坏了两年，一直没换。' },
  { relation: '老师', wishType: 'lonely', text: '老师帮了那么多人，好像没人帮他。' },
  { relation: '老师', wishType: 'sleep', text: '老师批改作业到凌晨，希望他十一点能回家。' },

  // 陌生：克制、不冒犯，倾向善意/生活
  { relation: '一个陌生人', wishType: 'life', text: '宿舍楼下修车的师傅，冬天手一直是裂的。' },
  { relation: '一个陌生人', wishType: 'body', text: '食堂打饭的阿姨手腕总贴着膏药。' },
  { relation: '一个陌生人', wishType: 'lonely', text: '每天一起等公交的那位老人，从没听他说过话。' },
  { relation: '一个陌生人', wishType: 'emotion', text: '图书馆对面那个总咬着指甲自习的人，希望他别那么焦虑。' },
  { relation: '一个陌生人', wishType: 'sleep', text: '夜班便利店店员，永远在最困的点上站着。' },
  { relation: '一个陌生人', wishType: 'study', text: '地铁上那个背单词的女孩，希望能考上。' },
];