/**
 * 文件上传（第 7 轮）：两段式直传，数据库只存元数据。
 *
 * 流程：presign 建 pending 行并签发上传 URL → 浏览器 PUT 到对象存储 →
 *       complete 下载对象实测字节、验证格式与大小后标 ready → 业务接口只认 ready 文件。
 *
 * 安全口径：
 * - object_key 由服务端派生 `u/<userId>/<purpose>/<fileId>.<ext>`，客户端不可指定；
 * - 私有桶，读取一律走 600 秒签名 URL，且先过归属校验；签名 URL 不入库、不进日志；
 * - 声明的大小只用于早退，最终以 download 实测字节为准；同时校验文件头与 MIME 一致。
 */

import { affected, firstAs, write } from '../lib/db.ts';
import { badRequest, forbidden, notFound, unavailable } from '../lib/errors.ts';
import { sha256Hex } from '../lib/crypto.ts';
import { uuid } from '../lib/id.ts';
import { enforceWindow, hourlyWindow } from '../lib/quota.ts';
import { requireAuthor } from './wish.ts';
import type { AppConfig, DbClient, DbRow, Principal, StorageClient } from '../lib/types.ts';

export type UploadFileRow = DbRow & { id: string };

export const UPLOAD_MAX_BYTES = 200 * 1024;
export const UPLOAD_ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const UPLOAD_PURPOSES = ['checkin_proof', 'ledger_proof', 'share_image'] as const;
export type UploadPurpose = (typeof UPLOAD_PURPOSES)[number];

const SIGNED_URL_TTL_SECONDS = 600;
/** 预签名后 2 小时内必须 complete，否则 pending 行被惰性标记为 expired */
const UPLOAD_URL_TTL_MS = 2 * 60 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 15_000;

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const MAGIC_BYTES: Array<{ mime: string; test: (bytes: Uint8Array) => boolean }> = [
  { mime: 'image/png', test: (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { mime: 'image/jpeg', test: (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]) },
  {
    mime: 'image/webp',
    test: (bytes) => ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP',
  },
];

export interface PresignInput {
  purpose: UploadPurpose;
  mimeType: string;
  filename: string;
  sizeBytes: number | null;
  wishId: string | null;
}

export interface PresignResult {
  file: Record<string, unknown>;
  uploadUrl: string;
  expiresAt: string;
  maxBytes: number;
  allowedMimeTypes: readonly string[];
  requiredHeaders: Record<string, string>;
}

export async function presignUpload(
  db: DbClient,
  storage: StorageClient,
  config: AppConfig,
  principal: Principal,
  input: PresignInput,
  now: Date,
): Promise<PresignResult> {
  if (input.sizeBytes !== null && input.sizeBytes > UPLOAD_MAX_BYTES) {
    throw badRequest('file_too_large', `图片不能超过 ${UPLOAD_MAX_BYTES / 1024}KB。`, { max_bytes: UPLOAD_MAX_BYTES });
  }

  // 每次申请新凭证时顺手失效本人超时的 pending 行，避免放弃上传后永久占位
  await expirePendingUploads(db, principal.userId, now);

  const window = hourlyWindow(now, 1);
  await enforceWindow(db, 'files', {
    column: 'user_id',
    value: principal.userId,
    since: window.since,
    limit: config.uploadPerHour,
    errorCode: 'upload_rate_limited',
    message: '上传太频繁了，请稍后再试。',
    resetAt: window.resetAt,
    now,
  });

  if (input.wishId) await requireAuthor(db, input.wishId, principal.userId);

  const fileId = uuid();
  const objectKey = `u/${principal.userId}/${input.purpose}/${fileId}.${EXTENSIONS[input.mimeType]}`;
  const timestamp = now.toISOString();
  const expiresAt = new Date(now.getTime() + UPLOAD_URL_TTL_MS).toISOString();
  const values = {
    id: fileId,
    user_id: principal.userId,
    wish_id: input.wishId,
    purpose: input.purpose,
    object_key: objectKey,
    status: 'pending',
    mime_type: input.mimeType,
    size_bytes: 0,
    width: 0,
    height: 0,
    sha256: '',
    is_public: false,
    verified_at: null,
    expires_at: expiresAt,
    deleted_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  const inserted = await write(db.from('files').insert(values).select('*'), 'create upload file');
  if (inserted.length !== 1) throw unavailable('storage_unavailable', '上传凭证创建失败，请稍后重试。');

  let uploadUrl: string;
  try {
    uploadUrl = (await storage.createSignedUploadUrl(objectKey, { upsert: false })).signedUrl;
  } catch {
    throw unavailable('storage_unavailable', '对象存储暂时不可用，请稍后重试。');
  }
  return {
    file: toFileDto(inserted[0] as UploadFileRow),
    uploadUrl,
    expiresAt,
    maxBytes: UPLOAD_MAX_BYTES,
    allowedMimeTypes: UPLOAD_ALLOWED_MIME,
    requiredHeaders: { 'content-type': input.mimeType },
  };
}

export async function completeUpload(
  db: DbClient,
  storage: StorageClient,
  principal: Principal,
  fileId: string,
  now: Date,
): Promise<UploadFileRow> {
  const file = await firstAs<UploadFileRow>(db.from('files').select('*').eq('id', fileId), 'read upload file');
  if (!file) throw notFound('file_not_found', '找不到这个文件。');
  if (String(file.user_id ?? '') !== principal.userId) throw forbidden('file_forbidden', '只能操作自己上传的文件。');

  const status = String(file.status ?? '');
  if (status === 'ready') return file;
  if (status === 'deleted' || status === 'rejected' || status === 'expired') {
    throw badRequest('file_not_ready', '这个文件已失效，请重新上传。', { status });
  }
  if (String(file.expires_at ?? '') !== '' && Date.parse(String(file.expires_at)) <= now.getTime()) {
    await affected(
      db.from('files').update({ status: 'expired', updated_at: now.toISOString() })
        .eq('id', fileId).eq('status', 'pending'),
      'expire upload file',
    );
    throw badRequest('upload_expired', '上传凭证已过期，请重新申请。', { expires_at: file.expires_at });
  }

  let response: Response;
  try {
    response = await storage.download(String(file.object_key ?? ''));
  } catch {
    throw unavailable('storage_unavailable', '对象存储暂时不可用，请稍后重试。');
  }
  if (!response.ok) {
    throw badRequest('upload_pending', '还没有检测到上传的文件，请先完成上传。');
  }

  const bytes = await readBounded(response, UPLOAD_MAX_BYTES);
  if (bytes.byteLength === 0) throw badRequest('verification_failed', '上传的文件是空的。');
  const actualMime = detectImageType(bytes);
  const declaredMime = String(file.mime_type ?? '');
  if (!actualMime || actualMime !== declaredMime) {
    await affected(
      db.from('files').update({ status: 'rejected', updated_at: now.toISOString() })
        .eq('id', fileId).eq('status', 'pending'),
      'reject upload file',
    );
    throw badRequest('verification_failed', '图片格式与声明不一致，请重新上传。');
  }

  const timestamp = now.toISOString();
  const patch = {
    status: 'ready',
    size_bytes: bytes.byteLength,
    mime_type: actualMime,
    sha256: await sha256Hex(bytes),
    verified_at: timestamp,
    updated_at: timestamp,
  };
  const taken = await affected(
    db.from('files').update(patch).eq('id', fileId).eq('status', 'pending'),
    'verify upload file',
  );
  if (taken !== 1) {
    const fresh = await firstAs<UploadFileRow>(db.from('files').select('*').eq('id', fileId), 'reread upload file');
    if (fresh && String(fresh.status) === 'ready') return fresh;
    throw badRequest('upload_pending', '文件状态刚被更新，请刷新后重试。', { status: fresh?.status });
  }
  const fresh = await firstAs<UploadFileRow>(db.from('files').select('*').eq('id', fileId), 'read verified file');
  if (!fresh) throw notFound('file_not_found', '找不到这个文件。');
  return fresh;
}

export async function createFileUrl(
  db: DbClient,
  storage: StorageClient,
  principal: Principal,
  fileId: string,
): Promise<Record<string, unknown>> {
  const file = await firstAs<UploadFileRow>(db.from('files').select('*').eq('id', fileId), 'read file for url');
  if (!file) throw notFound('file_not_found', '找不到这个文件。');
  if (String(file.user_id ?? '') !== principal.userId) throw forbidden('file_forbidden', '只能访问自己上传的文件。');
  if (String(file.status ?? '') !== 'ready') {
    throw badRequest('file_not_ready', '文件还在校验中，暂时不能访问。', { status: file.status });
  }
  let url: string;
  try {
    url = (await storage.createSignedUrl(String(file.object_key ?? ''), SIGNED_URL_TTL_SECONDS)).signedUrl;
  } catch {
    throw unavailable('storage_unavailable', '对象存储暂时不可用，请稍后重试。');
  }
  return { file_id: String(file.id), url, expires_in: SIGNED_URL_TTL_SECONDS };
}

/** 惰性失效：只处理本人 pending 且已过期的行，返回本次标记数量供测试/日志观察 */
export async function expirePendingUploads(db: DbClient, userId: string, now: Date): Promise<number> {
  return affected(
    db.from('files').update({ status: 'expired', updated_at: now.toISOString() })
      .eq('user_id', userId).eq('status', 'pending').lte('expires_at', now.toISOString()),
    'expire pending uploads',
  );
}

export function toFileDto(file: UploadFileRow): Record<string, unknown> {
  return {
    id: file.id,
    purpose: file.purpose,
    status: file.status,
    mime_type: String(file.mime_type ?? ''),
    size_bytes: Number(file.size_bytes ?? 0),
    wish_id: file.wish_id ?? null,
    created_at: file.created_at,
    verified_at: file.verified_at ?? null,
  };
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  if (bytes.byteLength < prefix.length) return false;
  return prefix.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.byteLength < offset + length) return '';
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function detectImageType(bytes: Uint8Array): string | null {
  return MAGIC_BYTES.find((entry) => entry.test(bytes))?.mime ?? null;
}

/** 只读声明上限之内的字节；Content-Length 可谎报，因此边读边判真实大小 */
async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw badRequest('file_too_large', `图片不能超过 ${maxBytes / 1024}KB。`, { max_bytes: maxBytes });
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void reader.cancel().catch(() => {});
      reject(badRequest('verification_failed', '读取上传文件超时，请重试。'));
    }, DOWNLOAD_TIMEOUT_MS);
  });

  try {
    return await Promise.race([
      (async () => {
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          size += value.byteLength;
          if (size > maxBytes) {
            await reader.cancel().catch(() => {});
            throw badRequest('file_too_large', `图片不能超过 ${maxBytes / 1024}KB。`, { max_bytes: maxBytes });
          }
          chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        return bytes;
      })(),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    reader.releaseLock();
  }
}