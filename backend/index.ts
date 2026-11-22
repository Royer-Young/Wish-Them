/**
 * Qoder Sites Function 生产入口（ZIP 根目录 index.ts，runtime = edge）。
 *
 * 这是唯一 import 平台注入模块 `_qoder/backend.mjs` 的文件：
 * 该模块由平台在部署时注入，源码包里不能出现 _qoder 目录（打包器会拒绝），
 * 所以本地开发/测试走 tools/local/serve.ts，用假数据库驱动同一个 createApp()。
 */
import { createDatabaseClient } from './_qoder/backend.mjs';
import { createStorageClient } from './_qoder/storage.mjs';
import { ConfigError, loadConfig } from './lib/config.ts';
import { serviceUnavailable } from './lib/errors.ts';
import { newRequestId } from './lib/id.ts';
import { log } from './lib/log.ts';
import { fail, ok } from './lib/respond.ts';
import { createApp, type Fetch } from './server.ts';
import type { DbClient, StorageClient } from './lib/types.ts';

// 冷启动时创建一次，客户端内部自带连接复用
const db = createDatabaseClient() as DbClient;
const storage = createStorageClient() as StorageClient;

let app: Fetch | null = null;
try {
  app = createApp({ db, storage, config: loadConfig() });
} catch (error) {
  // 缺密钥不能让 Function 起不来：保留存活探针，其余接口统一 503，方便部署面板定位
  const missing = error instanceof ConfigError ? error.missing.join(',') : 'unknown';
  log('error', 'config_missing', { missing });
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (app) return app(request);
  const path = new URL(request.url).pathname;
  if (path === '/api/health' || path.endsWith('/api/health')) {
    return ok({ status: 'degraded', reason: 'service_not_configured' }, newRequestId());
  }
  return fail(serviceUnavailable(), newRequestId());
});
