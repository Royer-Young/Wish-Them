/** 跨模块共用的输入格式白名单正则（与 lib/validate.ts、db 注释保持一致） */

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 幂等键只接受 UUID，避免客户端塞任意字符串占满索引 */
export const IDEMPOTENCY_KEY_PATTERN = UUID_PATTERN;
export const YMD_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const ISO_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
/** HH:mm，用于免打扰窗口 */
export const CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
/** 头像只允许内置编号，杜绝外链 SSRF/追踪 */
export const AVATAR_PATTERN = /^default_\d{2}$/;
/** Crockford Base32（去掉了易混字符 I L O U） */
export const BASE32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
