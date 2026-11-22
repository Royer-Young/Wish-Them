/**
 * 公开池与回信的基础内容规则（确定性，无 AI）。
 *
 * 两类用途要分开：
 * - 回信/摘要「拦截」：手机号、身份证、外链、邮箱、微信号、带门牌号的地址、引流黑词；
 * - 公开摘要「脱敏」：把上述内容替换成 ***，并压掉多余空白，避免公开页出现可追踪信息。
 * 地址只认「路/街/小区 + 数字」这种强特征，避免把「走夜路」当成住址。
 */

const CONTACT_SOURCES = [
  String.raw`1[3-9]\d{9}`,
  String.raw`\d{17}[\dXx]`,
  String.raw`(?:https?:\/\/|www\.)[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+`,
  String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`,
  String.raw`(?:微信|wechat|weixin|QQ|qq|vx|wx)\s*[:：]?\s*[A-Za-z0-9_-]{5,}`,
  String.raw`(?:路|街|道|巷|弄|小区|花园|公寓|号楼|单元)\s*\d+`,
];

const BLOCKED_WORDS = ['加微信', '加v', '代购', '博彩', '赌博', '贷款', '裸聊', '约炮', '私聊我'];

export function containsSensitive(text: string): boolean {
  const lowered = text.toLowerCase();
  if (BLOCKED_WORDS.some((word) => lowered.includes(word.toLowerCase()))) return true;
  return CONTACT_SOURCES.some((source) => new RegExp(source, 'i').test(text));
}

/** 公开摘要脱敏：联系方式替换为 ***，连续 6 位以上数字也抹掉，避免时间/门牌被复原 */
export function redactSensitive(text: string): string {
  let out = text;
  for (const source of CONTACT_SOURCES) out = out.replace(new RegExp(source, 'gi'), '***');
  out = out.replace(/\d{6,}/g, '***');
  return out.replace(/\s+/g, ' ').trim();
}

/** 公开摘要 ≤120 字由服务端裁剪（不是让客户端先切再抛校验错） */
export function toExcerpt(text: string, max = 120): string {
  const redacted = redactSensitive(text);
  return redacted.length <= max ? redacted : redacted.slice(0, max);
}