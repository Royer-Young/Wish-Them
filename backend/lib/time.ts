/**
 * 时间工具：全站固定 Asia/Shanghai（UTC+8，无夏令时），产品日以 04:00 为界。
 * 存储用 timestamptz（UTC 瞬时），日历语义用 text YYYY-MM-DD —— 平台迁移子集不支持 date。
 */

export const TZ_OFFSET_MINUTES = 480;
/** 04:00–次日 03:59 算同一天（PRD 3.4） */
export const DAY_BOUNDARY_HOUR = 4;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function toIso(date: Date): string {
  return date.toISOString();
}

/** 把任意瞬时转成"上海墙上日期"字符串 */
export function shanghaiDate(instant: Date): string {
  return new Date(instant.getTime() + TZ_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
}

export function isValidYmd(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (y < 2020 || y > 2035) return false;
  // 月份必须显式落在 1..12：Date.UTC(y, 13, 0) 会滚到下一年而不是 Invalid Date，
  // 放过 00/13 月会让后续 weekStartOf 的 Date.parse 得到 NaN 并抛 RangeError（500）。
  if (m < 1 || m > 12) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d >= 1 && d <= daysInMonth;
}

/** 产品日：回拨 4 小时后再取上海日历日期，凌晨 3 点算昨天 */
export function productDate(instant: Date): string {
  return shanghaiDate(new Date(instant.getTime() - DAY_BOUNDARY_HOUR * 3_600_000));
}

/** 某产品日的开始瞬时（上海 04:00），返回 UTC Date */
export function dayStartUtc(dateStr: string): Date {
  return new Date(Date.parse(`${dateStr}T${String(DAY_BOUNDARY_HOUR).padStart(2, '0')}:00:00+08:00`));
}

export function addDays(dateStr: string, count: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + count)).toISOString().slice(0, 10);
}

/** 周一为一周起点（账本按自然周分组） */
export function weekStartOf(dateStr: string): string {
  const day = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return addDays(dateStr, -((day + 6) % 7));
}

export function isWeekendDate(dateStr: string): boolean {
  const day = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

/** 契约截止日 = 开始日 + 天数 − 1 */
export function contractEndDate(startDateStr: string, days: number): string {
  return addDays(startDateStr, days - 1);
}

/** 契约内第几天，0 起（与 tasks.day_index 同口径，展示「第 N 天」时 +1）；开始日之前返回负数 */
export function dayIndexOf(startDateStr: string, dateStr: string): number {
  const start = Date.parse(`${startDateStr}T00:00:00Z`);
  const current = Date.parse(`${dateStr}T00:00:00Z`);
  return Math.floor((current - start) / 86_400_000);
}

/** 结算开放时刻：截止日次日 04:00（上海），返回 UTC ISO */
export function settleOpenAt(endDateStr: string): string {
  return new Date(Date.parse(`${addDays(endDateStr, 1)}T04:00:00+08:00`)).toISOString();
}

/** 补卡券过期时刻：该契约周结束后下周一 04:00（上海） */
export function makeupExpiresAt(weekStart: string): string {
  return new Date(Date.parse(`${addDays(weekStart, 7)}T04:00:00+08:00`)).toISOString();
}

export function windowStart(instant: Date, hours: number): string {
  return new Date(instant.getTime() - hours * 3_600_000).toISOString();
}

/** 当前瞬时是否落在上海 23:00–08:00 免打扰窗口（跨零点） */
export function inQuietWindow(instant: Date, start = '23:00', end = '08:00'): boolean {
  const shifted = new Date(instant.getTime() + TZ_OFFSET_MINUTES * 60_000);
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  const toMinutes = (text: string) => {
    const [h, m] = text.split(':').map(Number);
    return h * 60 + m;
  };
  const s = toMinutes(start);
  const e = toMinutes(end);
  return s <= e ? minutes >= s && minutes < e : minutes >= s || minutes < e;
}
