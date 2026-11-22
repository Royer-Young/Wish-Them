/**
 * 本地开发服务器：用 node:http 把请求喂给 backend/server.ts 的 createApp()。
 *
 *   node tools/local/serve.ts            # 默认 http://127.0.0.1:8787
 *   curl -s http://127.0.0.1:8787/api/health
 *   curl -s http://127.0.0.1:8787/functions/v1/app/api/health   # 线上物理路径也可用
 *
 * 只用于本地：密钥来自 .env（tools/local/deps.ts 的默认值），数据在内存里，重启即清空。
 * 线上入口是 backend/index.ts（Deno + 平台注入的 _qoder 客户端），不要在这里加业务逻辑。
 */
import http from 'node:http';
import { createApp } from '../../backend/server.ts';
import { createLocalDeps } from './deps.ts';

const PHYSICAL_PREFIX = '/functions/v1/app';
const PORT = Number(process.env.PORT ?? 8787);
const deps = createLocalDeps();
const app = createApp(deps);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  // 允许省略物理前缀，方便 curl；带前缀时与线上完全一致
  const pathname = url.pathname.startsWith(PHYSICAL_PREFIX) ? url.pathname : PHYSICAL_PREFIX + url.pathname;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name, value);
    else if (Array.isArray(value) && value.length > 0) headers.set(name, value[0] as string);
  }

  const method = req.method ?? 'GET';
  const request = new Request(`${url.origin}${pathname}${url.search}`, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' || chunks.length === 0 ? undefined : Buffer.concat(chunks),
  });

  try {
    const response = await app(request);
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error('[local] handler crashed', error);
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ code: 500, data: null, message: 'internal_error' }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[local] yuan-ta api on http://127.0.0.1:${PORT}${PHYSICAL_PREFIX}/api/health`);
});
