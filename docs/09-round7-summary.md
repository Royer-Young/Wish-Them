# 09 第 7 轮开发总结・文件上传、分享、公开池与回信

> 范围：两段式上传 3 条路由、分享 3 条路由、公开池 5 条路由、回信 3 条路由，以及领域层、隐私白名单、举报自动隐藏与配套测试/文档。
> 结论：代码、冒烟与静态校验全绿（**35 条路由 / 420 项断言**）；**云端第一阶段（真库迁移 / seed / 真实对象存储验证）仍未完成**，原因见 §6。

## 1. 实现范围

### 1.1 接口（14 条，累计 35 条）

| 接口 | 关键行为 |
| --- | --- |
| `POST /api/uploads/presign` | 登录；`purpose` 三选一（`checkin_proof/ledger_proof/share_image`）、MIME 三选一（jpeg/png/webp）、`size_bytes` 声明超 200KB 早退；按 `UPLOAD_PER_HOUR`（默认 30）限流；插 `pending` 行并签发 PUT URL，`object_key` 由服务端派生 |
| `POST /api/uploads/complete` | 登录；归属校验；`storage.download` 读回对象，边读边数真实字节（≤200KB）、15 秒超时、magic bytes 与声明 MIME 一致；`pending→ready` 单行 CAS，格式不符标 `rejected`；已 `ready` 重放直接返回同一行 |
| `POST /api/uploads/:id/url` | 登录；仅本人、仅 `ready`；签发 600s 签名 GET URL，不入库、不进日志 |
| `POST /api/wishes/:id/share` | 仅作者；`draft` 不可分享（400 `share_not_before_sign`）；`UNIQUE(wish_id)` 决定一契约一链接，**重复调用轮换 token**（旧链接立即失效），撤销后再生成会复位 `active` |
| `DELETE /api/wishes/:id/share` | 仅作者；写 `revoked`；重复撤销幂等返回当前行；从未生成 404 `share_not_found` |
| `GET /api/s/:token` | 匿名；token 形状校验（`[A-Za-z0-9_-]{16,32}`，实际 26 字符）；只返回白名单字段；`visits+1`；已撤销 404 `share_revoked` |
| `GET /api/pool` | 匿名；只含 `published` 且 `is_demo=false`；`category` 六类、`sort` 只接受 `latest`、游标分页（≤50）；`published_at` 倒序 |
| `POST /api/pool/publish` | 仅作者、愿签须 `settled`；`UNIQUE(wish_id)` 一愿签一帖，重复发布返回 200 + 原帖；摘要服务端脱敏 ≤120 字；`POOL_PUBLISH_PER_DAY`（默认 5）限流 |
| `GET /api/pool/:id` | 匿名；`hidden/deleted` 一律 404 `pool_hidden`；回信数读时实时统计 |
| `POST /api/pool/:id/report` | 登录；六种原因码；同人同帖只记一次（409 `report_duplicate`）；满 `POOL_REPORT_HIDE_THRESHOLD`（默认 3）自动 `hidden` 并把 open 报告标 `acted/auto_hidden`；`POOL_REPORT_PER_HOUR`（默认 20）限流 |
| `POST /api/pool/:id/unpublish` | 仅帖主（403 `not_post_author`）；`published→deleted`；重复下架幂等 |
| `POST /api/pool/:id/replies` | 登录；≤80 字；敏感词命中即拒；作者关闭回信则拒；`REPLY_PER_DAY`（默认 20）+ 同帖每天一条；即时发布 |
| `GET /api/pool/:id/replies` | 匿名；只含 `published`；`created_at` 倒序、游标分页（≤50） |
| `DELETE /api/replies/:id` | 回信作者或帖主；软删 `status='deleted'`；重复删除幂等；其余 403 `not_reply_owner` |

14 条路由均注册于 [backend/api/manifest.ts](../backend/api/manifest.ts)（累计 35 条），路径由文件位置派生并通过 `check-routes.ts`。

### 1.2 两段式直传

```
presign  ──► files(pending, object_key=u/<userId>/<purpose>/<fileId>.<ext>)
         ──► storage.createSignedUploadUrl(key, {upsert:false})
浏览器   ──► PUT upload_url，必须带 required_headers['content-type']
complete ──► storage.download(key) → 边读边数 ≤200KB / 15s 超时
         ──► magic bytes == 声明 MIME → sha256 落库 → CAS pending→ready
业务接口 ──► 只认 ready + 正确 purpose + 归属一致
```

- **声明大小只用于早退**：`complete` 以实测字节为准，`Content-Length` 可谎报，因此 `readBounded` 边读边判并在超限时 `cancel()`。
- **格式不符写 `rejected`**：同一次请求里 CAS 失败也不回头改状态，后续 `complete` 返回 400 `file_not_ready`。
- **幂等**：`complete` 为 `optional`，带 `Idempotency-Key` 字节级重放；不带键时靠「`ready` 直接返回」保证多次调用收敛。`presign` / `url` 为 `none`——响应含短时签名 URL，按红线不入库、不进幂等存档。
- **私有桶**：没有公开读路径；分享/公开池都不引用原始证明图。

### 1.3 分享与隐私白名单

`readSharedWish` 只投影：

```
title / wish_text / summary / relation / relation_group / wish_type / status /
outcome / outcome_label / start_date / end_date / day_index / settled_at
share: { status:"active", visits }
```

**不存在** `answers` / `*_enc` / `q*_*` / `ledger*` / `proof*` / `files*` / `object_key` / `letter_text` / `nickname` / `user_id` / `author_id` / 礼物 / 金额。`outcome` 仅在 `settled` 后返回，其余状态为空串；`day_index` 按产品日现算并夹在 `1..days`。

### 1.4 公开池与回信

- **发布即公开，无人工审核**：`publish` 只要求愿签已结算；摘要是 `toExcerpt` 脱敏结果（手机号/证件号/外链/微信 QQ/广告引流词等），空结果兜底「一个没有说出口的愿望」。
- **举报阈值**：`UNIQUE(target_type,target_id,reporter_id)` 去重；计数达到阈值时用 `eq('status','published')` CAS 隐藏，并发举报最多让帖子进入 `hidden` 一次；同批把该目标的 open 报告改为 `acted`。
- **回信**：作者可用 `wishes.replies_enabled` 关闭；内容先过敏感词；两道日限（总日限 + 同帖每天一条）；即时发布、无先审后发。
- **派生列不参与判定**：`reply_count` / `report_count` 写后尽力刷新，详情读取时实时统计回信，隐藏判定只看本次计数与阈值。

## 2. 与需求书 / PRD 的对齐

| 需求 | 落地 |
| --- | --- |
| 图片仅限 jpeg/png/webp、≤200KB | `UPLOAD_MAX_BYTES = 200 * 1024`；presign 校验声明值，complete 以实测字节复核；文件头 magic bytes 再复核 MIME |
| 用途分离目录 | `u/<userId>/<purpose>/<fileId>.<ext>`，`purpose` 白名单，打卡校验 `checkin_proof`、账本校验 `ledger_proof` |
| 数据库只存文件元数据 | `files` 只存 key/status/mime/size/sha256/归属；签名 URL 不落库 |
| 分享只读、可轮换、可撤销 | 一愿签一链接，重复生成轮换 token，撤销即失效；固定 `link_only` |
| 公开/分享接口不得泄露隐私 | 三个匿名出口（`/api/s/:token`、`/api/pool*`、回信列表）全部白名单投影；无五问、账本、文件、身份 |
| 发布即公开、举报隐藏、无审核队列 | 无 `pending_review` 状态；`reports` 只用 `open/acted`，无人工工作台 |
| 限流阈值走环境变量 | 新增 5 个 env（上传 30/h、发布 5/日、举报 20/h、隐藏阈值 3、回信 20/日），均有范围校验 |
| 写操作归属错误 403 | 上传/分享/发布/下架/删回信均先取行再判权，越权 403、不存在 404 |
| 幂等全局统一 | 7 条写接口 `optional`（complete/share/publish/report/unpublish/reply.create），无写冲突语义的 presign/url/revoke/delete 为 `none` |

## 3. 代码落点

| 文件 | 职责 |
| --- | --- |
| [backend/domain/upload.ts](../backend/domain/upload.ts) | presign / complete / 签名 URL、大小与 magic bytes 校验、CAS、File DTO |
| [backend/domain/share.ts](../backend/domain/share.ts) | 链接生成/轮换/撤销、匿名白名单投影、访问计数 |
| [backend/domain/pool.ts](../backend/domain/pool.ts) | 发布/列表/详情/举报/自动隐藏/下架、摘要脱敏、回信数刷新 |
| [backend/domain/reply.ts](../backend/domain/reply.ts) | 回信发布/列表/删除、敏感词、两道日限 |
| [backend/lib/sensitive.ts](../backend/lib/sensitive.ts) | `containsSensitive` / `redactSensitive` / `toExcerpt` |
| [backend/api/uploads/presign.ts](../backend/api/uploads/presign.ts) · [complete.ts](../backend/api/uploads/complete.ts) · [_id/url.ts](../backend/api/uploads/_id/url.ts) | 3 条上传路由 |
| [backend/api/wishes/_id/share/create.ts](../backend/api/wishes/_id/share/create.ts) · [index.ts](../backend/api/wishes/_id/share/index.ts) · [backend/api/s/_token/get.ts](../backend/api/s/_token/get.ts) | 3 条分享路由 |
| [backend/api/pool/get.ts](../backend/api/pool/get.ts) · [publish.ts](../backend/api/pool/publish.ts) · [_id/get.ts](../backend/api/pool/_id/get.ts) · [_id/report.ts](../backend/api/pool/_id/report.ts) · [_id/unpublish.ts](../backend/api/pool/_id/unpublish.ts) | 5 条公开池路由 |
| [backend/api/pool/_id/replies/create.ts](../backend/api/pool/_id/replies/create.ts) · [get.ts](../backend/api/pool/_id/replies/get.ts) · [backend/api/replies/_id.ts](../backend/api/replies/_id.ts) | 3 条回信路由 |
| [tools/local/smoke.ts](../tools/local/smoke.ts) | 第 14 节：上传/分享/公开池/回信，99 项新断言（累计 420） |
| [docs/02-conventions.md](../docs/02-conventions.md) · [03](../docs/03-database.md) · [04](../docs/04-api-contract.md) · [05](../docs/05-environment.md) | 约定/库表/契约/环境同步 |

## 4. 数据库

**没有新增迁移**：第 7 轮全部复用 `0002`（`files`）与 `0006`（`pool_posts` / `replies` / `reports` / `share_links`）已建好的列与索引。

| 表 | 本轮写入 |
| --- | --- |
| `files` | presign 插 `pending`；complete 实测后 CAS `ready` 或写 `rejected`；`object_key` 服务端派生 |
| `share_links` | `UNIQUE(wish_id)` 一契约一行；生成/轮换更新 `token/status`，撤销写 `revoked` |
| `pool_posts` | 发布/重发/隐藏/下架；`excerpt` 脱敏；`reply_count`/`report_count` 派生 |
| `reports` | 只写 `target_type='pool_post'`；唯一约束去重；满阈值批量 `acted` |
| `replies` | 发布 `published`、删除 `deleted`；同帖日限为窗口查询（无唯一约束） |

各表列级用途与索引对照见 [docs/03-database.md](../docs/03-database.md) §3.15–§3.19、§7。

## 5. 测试与校验

```bash
node tools/local/smoke.ts                 # 420 passed, 0 failed
node tools/scripts/check-routes.ts        # 35 routes ok
node tools/scripts/check-migrations.ts    # 6 files / 94 statements / 21 tables
node tools/scripts/check-schema-usage.ts  # 21 tables / 337 columns / 70 function files
node tools/scripts/build-seeds.ts --check # 72 / 120 / 24
npx --yes --package typescript@5.6.3 tsc -p .tscheck/tsconfig.json
```

第 7 轮冒烟覆盖：

- **上传**：声明超限早退；直传后 complete 实测字节、`sha256` 落库；已 ready 重放幂等；MIME 与文件头不符 → `rejected` + 400；越权 403；过期 `upload_expired`；取 URL 600 秒且只对 ready/本人。
- **分享**：仅作者；draft 拒绝；重复生成 token 轮换、旧 token 404；撤销后 `share_revoked`；匿名页只含白名单、`visits` 自增。
- **公开池**：未结算拒绝；发布 201、重复发布 200 同帖；匿名列表过滤演示/隐藏；分类过滤；详情实时回信数；三人举报自动隐藏；隐藏后详情/回信 404；重复举报 409；作者下架幂等、非作者 403。
- **回信**：80 字上限；敏感内容拒绝；关闭回信拒绝；同帖日限 409；总日限 429；匿名列表倒序分页；回信作者/帖主可删、第三人 403；隐藏帖不能回信。

## 6. 云端阻塞与下一步

- **迁移/seed/真库验证仍未执行**：沿用第 3–6 轮状态，需要平台侧授权与部署；本轮没有新迁移，风险集中在「真实对象存储行为」而非 DDL。
- **需要实测的存储假设**：私有桶、`createSignedUploadUrl(...,{upsert:false})` 的 PUT 是否强制 content-type、`download` 15 秒内可读、600s GET URL 到期后失效。本地只能证明代码路径与 FakeStorage 语义一致。
- **已知残余风险**：
  1. 回信「同帖每天一条」无唯一约束，同一用户并发双请求可能多一条；全站日限兜底。
  2. `reply_count` / `report_count` 统计带 `limit 50`，超过 50 条回信的展示值封顶（阈值 3 不受影响）。
  3. 放弃 PUT 的 `pending` 文件与残留对象无后台清扫，仅靠 `expires_at` 惰性拒绝（第 9 轮已补：2 小时失效，`complete` 拒绝并标 `expired`，下一次 presign 惰性清扫；残留对象仍需离线清理）。
  4. `reports` 只支持帖子举报；回信举报、fork、我的发布/回信列表未实现。
- **未做**（范围外）：`DELETE /api/uploads/:id`、服务端图片内容审核、AI 验收、分享图生成、访问口令、公开池 fork/热帖排序、通知、后台管理。

## 7. 与第 7 轮需求的偏离（均已写入 README 与 docs/04 §0.2）

1. 发布路径定为 `POST /api/pool/publish`（body 带 `wish_id`），而不是 `/api/wishes/:id/publish`；下架为 `POST /api/pool/:id/unpublish`。
2. 分享固定 `link_only`，不接受 `visibility/include_flags`。
3. `presign` / `url` / `revoke` / `delete reply` 不做幂等存档；`DELETE /api/uploads/:id` 未实现。
4. 公开池排序只接受 `latest`，热帖排序未开放。
5. 回信同帖日限是查询 + 插入，无唯一约束。
6. 举报原因码固定 `privacy/harassment/illegal/spam/sexual/other`（不采用 `ad/health_advice`）。