/**
 * 游标分页编解码（docs/02 §11）：cursor = base64url(json([排序键, id]))。
 * 次级排序固定 id 升序，因此「同一时间戳多行」也能稳定翻页，不依赖 offset。
 */

import { base64UrlDecode, base64UrlEncode, utf8 } from './crypto.ts';
import { badRequest } from './errors.ts';

export interface Cursor {
  sortKey: string;
  id: string;
}

export function encodeCursor(sortKey: string, id: string): string {
  return base64UrlEncode(utf8(JSON.stringify([sortKey, id])));
}

export function decodeCursor(raw: string): Cursor {
  const invalid = () => badRequest('invalid_cursor', '游标无效，请重新加载列表。');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(raw)));
  } catch {
    throw invalid();
  }
  if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') {
    throw invalid();
  }
  return { sortKey: parsed[0], id: parsed[1] };
}