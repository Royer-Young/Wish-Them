/**
 * 声明式入参校验：所有写操作入口都过这里，错误聚合成 400 invalid_parameter，
 * details.fields 给出 { 字段: 原因 }，原因用稳定英文码便于前端映射。
 */
import { badRequest } from './errors.ts';
import { IDEMPOTENCY_KEY_PATTERN, ISO_DATE_TIME_PATTERN, UUID_PATTERN } from './patterns.ts';
import { isValidYmd } from './time.ts';

export { UUID_PATTERN, IDEMPOTENCY_KEY_PATTERN };

export type FieldType =
  | 'string' | 'text' | 'enum' | 'int' | 'money' | 'date' | 'datetime' | 'uuid' | 'bool'
  | 'string[]' | 'idempotency_key';

export interface FieldSpec {
  type: FieldType;
  required?: boolean;
  min?: number;
  max?: number;
  values?: readonly string[];
  /** money 上限（单位：分） */
  maxCents?: number;
}

const IDEMPOTENCY_PATTERN = IDEMPOTENCY_KEY_PATTERN;
const ISO_PATTERN = ISO_DATE_TIME_PATTERN;
/** 去掉 C0/C1 控制字符（保留 \t \n \r），避免 NUL/终端控制序列进入日志与下游 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

function cleanText(value: string): string {
  return value.replace(CONTROL_CHARS, '').trim();
}

/** 各类型的默认长度/取值区间，可被 FieldSpec 覆盖 */
const DEFAULTS: Record<FieldType, Partial<FieldSpec>> = {
  string: { min: 1, max: 64 },
  text: { min: 1, max: 200 },
  enum: {},
  int: { min: -2_147_483_648, max: 2_147_483_647 },
  money: { min: 0, maxCents: 2_000_000 },
  date: {},
  datetime: {},
  uuid: {},
  bool: {},
  'string[]': { min: 0, max: 20 },
  idempotency_key: {},
};

export interface Validated<T extends Record<string, unknown>> {
  value: T;
  present: string[];
}

/**
 * 校验并归一化。未声明的字段一律忽略（不入库），避免客户端塞入额外列。
 * @throws AppError(400 invalid_parameter)
 */
export function validate<T extends Record<string, unknown>>(
  payload: unknown,
  schema: Record<string, FieldSpec>,
): Validated<T> {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
  if (!source) throw badRequest('invalid_body', '请求体必须是 JSON 对象。');

  const value: Record<string, unknown> = {};
  const present: string[] = [];
  const errors: Record<string, string> = {};

  for (const [name, spec] of Object.entries(schema)) {
    const raw = source[name];
    const merged = { ...DEFAULTS[spec.type], ...spec };
    if (raw === undefined || raw === null) {
      if (merged.required) errors[name] = 'required';
      continue;
    }
    const outcome = check(raw, merged, name);
    if (outcome !== null) errors[name] = outcome;
    else {
      value[name] = normalize(raw, merged.type);
      present.push(name);
    }
  }

  if (Object.keys(errors).length > 0) {
    throw badRequest('invalid_parameter', '请求参数校验未通过。', { fields: errors });
  }
  return { value: value as T, present };
}

function check(raw: unknown, spec: FieldSpec, name: string): string | null {
  const isIdField = name === 'id' || name.endsWith('_id') || name.endsWith('_ids');
  switch (spec.type) {
    case 'uuid':
    case 'idempotency_key': {
      if (typeof raw !== 'string') return 'must be a string';
      const pattern = spec.type === 'idempotency_key' ? IDEMPOTENCY_PATTERN : UUID_PATTERN;
      return pattern.test(raw) ? null : 'must be a UUID';
    }
    case 'string':
    case 'text': {
      if (typeof raw !== 'string') return 'must be a string';
      const length = cleanText(raw).length;
      if (length < (spec.min ?? 1)) return 'must not be empty';
      if (length > (spec.max ?? 64)) return `max length is ${spec.max}`;
      return null;
    }
    case 'enum': {
      if (typeof raw !== 'string') return 'must be a string';
      return spec.values?.includes(raw) ? null : `must be one of ${spec.values?.join('|')}`;
    }
    case 'int': {
      if (typeof raw !== 'number' || !Number.isInteger(raw)) return 'must be an integer';
      if (spec.min !== undefined && raw < spec.min) return `min is ${spec.min}`;
      if (spec.max !== undefined && raw > spec.max) return `max is ${spec.max}`;
      return null;
    }
    case 'money': {
      if (typeof raw !== 'number' || !Number.isInteger(raw)) return 'must be integer cents';
      if (raw < (spec.min ?? 0)) return 'must not be negative';
      if (spec.maxCents !== undefined && raw > spec.maxCents) return `max is ${spec.maxCents}`;
      return null;
    }
    case 'date':
      return typeof raw === 'string' && isValidYmd(raw) ? null : 'must be YYYY-MM-DD';
    case 'datetime':
      return typeof raw === 'string' && ISO_PATTERN.test(raw) && !Number.isNaN(Date.parse(raw))
        ? null : 'must be an ISO 8601 datetime';
    case 'bool':
      return typeof raw === 'boolean' ? null : 'must be a boolean';
    case 'string[]': {
      if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) return 'must be a string array';
      if (raw.length > (spec.max ?? 20)) return `max items is ${spec.max ?? 20}`;
      if (raw.some((item) => cleanText(item).length === 0)) return 'items must not be empty';
      if (isIdField && raw.some((item) => !UUID_PATTERN.test(item))) return 'items must be UUIDs';
      return null;
    }
    default:
      return 'unknown field type';
  }
}

function normalize(raw: unknown, type: FieldType): unknown {
  if (type === 'string' || type === 'text') return cleanText(raw as string);
  if (type === 'string[]') return (raw as string[]).map((item) => cleanText(item));
  return raw;
}

/** 路径参数：UUID 白名单，防注入与全表扫描 */
export function parseUuidParam(raw: string | undefined, name = 'id'): string {
  if (!raw || !UUID_PATTERN.test(raw)) throw badRequest('invalid_parameter', `${name} 必须是 UUID。`);
  return raw.toLowerCase();
}

/** 幂等键：只接受 UUID v4，与 auth_tokens 的 token_hash 前缀规则无关 */
export function parseIdempotencyKey(request: Request): string | null {
  const raw = request.headers.get('idempotency-key');
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  if (!IDEMPOTENCY_PATTERN.test(key)) throw badRequest('invalid_idempotency_key', 'Idempotency-Key 必须是 UUID。');
  return key;
}

/** 分页：limit 上限 100，游标是不透明字符串 */
export function parsePage(url: URL): { limit: number; cursor: string | null } {
  const rawLimit = Number(url.searchParams.get('limit') ?? '20');
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
    throw badRequest('invalid_parameter', 'limit 必须是 1~100 的整数。');
  }
  const cursor = url.searchParams.get('cursor');
  if (cursor !== null && (cursor.length === 0 || cursor.length > 128)) {
    throw badRequest('invalid_cursor', '游标无效，请重新加载列表。');
  }
  return { limit: rawLimit, cursor };
}
